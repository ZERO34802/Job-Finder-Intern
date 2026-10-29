import { evaluateJobs, isCandidateTitle } from "./classify";
import { notifyDiscord } from "./discord";
import { envInt, jitteredMs, sleep } from "./jitter";
import { fetchTargetJobs, toDrafts } from "./sources";
import { llmProviders } from "./llm";
import { getStore } from "./store";
import { isDue } from "./targets";
import type { Store, Target } from "./types";

export type PollSummary = {
  targets: number;
  jobsSeen: number;
  candidates: number;
  jobsNew: number;
  classified: number;
  alerted: number;
  errors: { targetId: string; error: string }[];
};

let inFlight: Promise<PollSummary> | null = null;

export function pollTargets(opts: { targetId?: string; force?: boolean } = {}): Promise<PollSummary> {
  if (inFlight) return Promise.reject(new Error("A poll is already running"));
  inFlight = runPoll(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const RECENT_POST_MS = 48 * 60 * 60 * 1000;

function postedRecently(postedAt: string | null): boolean {
  if (!postedAt) return false;
  const at = Date.parse(postedAt);
  return Number.isFinite(at) && Date.now() - at < RECENT_POST_MS;
}

// Boards on a shared API host (all Greenhouse boards hit one host) are split
// into a few sequential lanes; each Workday tenant is its own host and lane.
function hostKey(target: Target): string {
  return target.ats === "workday" ? `workday:${target.workdayHost}` : target.ats;
}

export function buildLanes(targets: Target[], lanesPerSharedHost: number): Target[][] {
  const groups = new Map<string, Target[]>();
  for (const target of targets) {
    const key = hostKey(target);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const lanes: Target[][] = [];
  for (const [key, group] of groups) {
    const count = key.startsWith("workday:") ? 1 : Math.max(1, Math.min(lanesPerSharedHost, group.length));
    const split: Target[][] = Array.from({ length: count }, () => []);
    group.forEach((target, i) => split[i % count].push(target));
    lanes.push(...split);
  }
  return lanes;
}

async function runPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(workers);
}

async function pollOne(store: Store, target: Target, summary: PollSummary): Promise<void> {
  summary.targets++;
  const startedAt = new Date().toISOString();
  try {
    const remote = await fetchTargetJobs(target);
    const { drafts } = toDrafts(target, remote);
    // First successful poll of a board: existing openings are not news.
    const baseline = !target.lastOkAt;
    const candidates = drafts
      .filter((draft) => isCandidateTitle(draft.title))
      .map((draft) => ({ ...draft, quiet: baseline && !postedRecently(draft.postedAt) }));
    const result = await store.upsertJobs(candidates);
    summary.jobsSeen += drafts.length;
    summary.candidates += candidates.length;
    summary.jobsNew += result.insertedIds.length;
    await store.touchTarget(target.id, "ok", null);
    await store.recordRun({
      targetId: target.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      jobsSeen: drafts.length,
      jobsNew: result.insertedIds.length,
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push({ targetId: target.id, error: message });
    await store.touchTarget(target.id, "error", message.slice(0, 500));
    await store.recordRun({
      targetId: target.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      jobsSeen: 0,
      jobsNew: 0,
      error: message.slice(0, 500),
    });
  }
}

async function runPoll(opts: { targetId?: string; force?: boolean }): Promise<PollSummary> {
  const store = getStore();
  const summary: PollSummary = { targets: 0, jobsSeen: 0, candidates: 0, jobsNew: 0, classified: 0, alerted: 0, errors: [] };
  const selected = opts.targetId ? [await store.getTarget(opts.targetId)] : await store.listTargets();
  const targets = selected.filter((target) => target !== null);
  if (opts.targetId && targets.length === 0) throw new Error(`Unknown target ${opts.targetId}`);

  const due = targets.filter((target) => {
    if (opts.targetId) return true;
    return target.enabled && (opts.force || isDue(target));
  });
  const gapMs = envInt("POLL_GAP_MS", 1200);
  await runPool(buildLanes(due, envInt("POLL_HOST_LANES", 2)), envInt("POLL_CONCURRENCY", 8), async (lane) => {
    for (let i = 0; i < lane.length; i++) {
      if (i > 0) await sleep(jitteredMs(gapMs, 0.5));
      await pollOne(store, lane[i], summary);
    }
  });

  const providers = await llmProviders();
  summary.classified = await evaluateJobs(store, envInt("EVALUATE_LIMIT", 1000), providers);

  if (process.env.DISCORD_WEBHOOK_URL?.trim()) {
    try {
      // A match judged by rules alone waits up to 2 hours for a model to confirm it.
      const holdMs = 2 * 60 * 60 * 1000;
      const matches = (await store.listUnalertedMatches({ sinceHours: 48, limit: 50 })).filter(
        (job) => providers.length === 0 || job.classifyModel !== "rules" || Date.now() - Date.parse(job.firstSeenAt) > holdMs,
      );
      if (matches.length > 0) {
        summary.alerted = await notifyDiscord(matches);
        await store.markAlerted(matches.map((job) => job.id));
      }
    } catch (err) {
      summary.errors.push({ targetId: "discord", error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    await store.pruneRuns(envInt("POLL_RUN_RETENTION_DAYS", 7));
  } catch (err) {
    summary.errors.push({ targetId: "prune", error: err instanceof Error ? err.message : String(err) });
  }

  return summary;
}
