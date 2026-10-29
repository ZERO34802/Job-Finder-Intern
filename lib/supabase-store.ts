import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canonicalJobUrl, dedupeKey, titleCacheKey } from "./canonicalize";
import { normalizeTarget } from "./targets";
import type {
  Application,
  ApplicationInput,
  ApplicationStatus,
  Ats,
  Classification,
  Job,
  JobDraft,
  JobFilter,
  PollRun,
  SourceUrl,
  Stats,
  Store,
  Target,
  TargetInput,
} from "./types";
import { APPLICATION_STATUSES } from "./types";

type JobRow = {
  id: string;
  canonical_url: string;
  title: string;
  company: string;
  location: string | null;
  ats: Ats;
  target_id: string | null;
  external_id: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  source_urls: SourceUrl[] | string;
  title_key: string;
  is_intern: number | null;
  role_family: string | null;
  seniority: string | null;
  score: number | null;
  classify_reason: string | null;
  classify_model: string | null;
  alerted_at: string | null;
};

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function readSources(value: SourceUrl[] | string | null): SourceUrl[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as SourceUrl[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    company: row.company,
    location: row.location,
    ats: row.ats,
    targetId: row.target_id,
    externalId: row.external_id,
    postedAt: row.posted_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sourceUrls: readSources(row.source_urls),
    titleKey: row.title_key,
    isIntern: row.is_intern === null ? null : row.is_intern === 1,
    roleFamily: row.role_family,
    seniority: row.seniority,
    score: row.score,
    classifyReason: row.classify_reason,
    classifyModel: row.classify_model,
    alertedAt: row.alerted_at,
  };
}

function mapTarget(row: Record<string, unknown>): Target {
  return {
    id: row.id as string,
    company: row.company as string,
    ats: row.ats as Ats,
    boardToken: (row.board_token as string | null) ?? null,
    workdayHost: (row.workday_host as string | null) ?? null,
    workdayTenant: (row.workday_tenant as string | null) ?? null,
    workdaySite: (row.workday_site as string | null) ?? null,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes as number,
    lastPolledAt: (row.last_polled_at as string | null) ?? null,
    lastStatus: (row.last_status as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    lastOkAt: (row.last_ok_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function mergeSources(prev: SourceUrl[], next: SourceUrl): SourceUrl[] {
  if (prev.some((item) => item.url === next.url)) return prev;
  return [...prev, next];
}

function safeQuery(q: string): string {
  return q.replace(/[^a-zA-Z0-9 .+#&-]/g, " ").trim();
}

export function createSupabaseStore(): Store {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORE=supabase");
  const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

  async function jobById(id: string): Promise<JobRow | null> {
    const { data, error } = await db.from("jobs").select("*").eq("id", id).maybeSingle();
    fail(error);
    return data as JobRow | null;
  }

  return {
    async listTargets() {
      const { data, error } = await db.from("targets").select("*").order("company");
      fail(error);
      return (data ?? []).map(mapTarget);
    },
    async getTarget(id) {
      const { data, error } = await db.from("targets").select("*").eq("id", id).maybeSingle();
      fail(error);
      return data ? mapTarget(data) : null;
    },
    async upsertTarget(input: TargetInput) {
      const id = input.ats === "workday" ? `workday:${(input.workdayTenant ?? "").toLowerCase()}` : `${input.ats}:${(input.boardToken ?? "").toLowerCase()}`;
      const existing = await this.getTarget(id);
      const target = normalizeTarget(input, existing);
      const { error } = await db.from("targets").upsert({
        id: target.id,
        company: target.company,
        ats: target.ats,
        board_token: target.boardToken,
        workday_host: target.workdayHost,
        workday_tenant: target.workdayTenant,
        workday_site: target.workdaySite,
        enabled: target.enabled ? 1 : 0,
        interval_minutes: target.intervalMinutes,
        last_polled_at: target.lastPolledAt,
        last_status: target.lastStatus,
        last_error: target.lastError,
        created_at: target.createdAt,
      });
      fail(error);
      const saved = await this.getTarget(target.id);
      if (!saved) throw new Error("target was not saved");
      return saved;
    },
    async setTargetEnabled(id, enabled) {
      const { error, count } = await db.from("targets").update({ enabled: enabled ? 1 : 0 }, { count: "exact" }).eq("id", id);
      fail(error);
      if (!count) throw new Error("unknown target");
    },
    async deleteTarget(id) {
      const { error } = await db.from("targets").delete().eq("id", id);
      fail(error);
    },
    async touchTarget(id, status, errorMessage) {
      const now = new Date().toISOString();
      const { error } = await db
        .from("targets")
        .update({
          last_polled_at: now,
          last_status: status,
          last_error: errorMessage,
          ...(status === "ok" ? { last_ok_at: now } : {}),
        })
        .eq("id", id);
      fail(error);
    },
    async upsertJobs(jobs: JobDraft[]) {
      const now = new Date().toISOString();
      type Entry = { id: string; canonical: string; draft: JobDraft; sources: SourceUrl[] };
      const entries = new Map<string, Entry>();
      const entryByUrl = new Map<string, Entry>();
      for (const draft of jobs) {
        if (!draft.title.trim()) continue;
        let canonical: string;
        try {
          canonical = canonicalJobUrl(draft.url);
        } catch {
          continue;
        }
        const source: SourceUrl = { ats: draft.ats, url: canonical, targetId: draft.targetId };
        const id = dedupeKey(draft.company, draft.title, draft.location);
        const same = entries.get(id) ?? entryByUrl.get(canonical);
        if (same) {
          same.sources = mergeSources(same.sources, source);
          continue;
        }
        const entry = { id, canonical, draft, sources: [source] };
        entries.set(id, entry);
        entryByUrl.set(canonical, entry);
      }
      if (entries.size === 0) return { insertedIds: [] };

      const byId = new Map<string, JobRow>();
      const byUrl = new Map<string, JobRow>();
      for (const chunk of chunks([...entries.keys()], 200)) {
        const { data, error } = await db.from("jobs").select("*").in("id", chunk);
        fail(error);
        for (const row of (data ?? []) as JobRow[]) byId.set(row.id, row);
      }
      for (const chunk of chunks([...entryByUrl.keys()], 50)) {
        const { data, error } = await db.from("jobs").select("*").in("canonical_url", chunk);
        fail(error);
        for (const row of (data ?? []) as JobRow[]) byUrl.set(row.canonical_url, row);
      }

      const inserts: Record<string, unknown>[] = [];
      const updates = new Map<string, JobRow>();
      for (const { id, canonical, draft, sources } of entries.values()) {
        const prev = updates.get(id) ?? byId.get(id) ?? byUrl.get(canonical);
        if (!prev) {
          inserts.push({
            id,
            canonical_url: canonical,
            title: draft.title.trim(),
            company: draft.company.trim(),
            location: draft.location,
            ats: draft.ats,
            target_id: draft.targetId,
            external_id: draft.externalId,
            posted_at: draft.postedAt,
            first_seen_at: now,
            last_seen_at: now,
            source_urls: sources,
            title_key: titleCacheKey(draft.title),
            alerted_at: draft.quiet ? now : null,
          });
          continue;
        }
        const base = updates.get(prev.id) ?? prev;
        updates.set(prev.id, {
          ...base,
          last_seen_at: now,
          title: draft.title.trim(),
          location: draft.location ?? base.location,
          source_urls: sources.reduce(mergeSources, readSources(base.source_urls)),
        });
      }

      for (const chunk of chunks(inserts, 500)) {
        const { error } = await db.from("jobs").insert(chunk);
        fail(error);
      }
      for (const chunk of chunks([...updates.values()], 500)) {
        const { error } = await db.from("jobs").upsert(chunk, { onConflict: "id" });
        fail(error);
      }
      return { insertedIds: inserts.map((row) => row.id as string) };
    },
    async listJobs(filter: JobFilter) {
      let query = db.from("jobs").select("*");
      if (filter.earlyOnly) query = query.or("is_intern.eq.1,seniority.eq.new_grad");
      if (filter.family) query = query.eq("role_family", filter.family);
      const q = safeQuery(filter.q ?? "");
      if (q) query = query.or(`title.ilike.%${q}%,company.ilike.%${q}%`);
      const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
      const { data, error } = await query.order("score", { ascending: false, nullsFirst: false }).limit(limit);
      fail(error);
      return ((data ?? []) as JobRow[]).map(mapJob);
    },
    async titlesForIds(ids) {
      if (ids.length === 0) return [];
      const titles: string[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { data, error } = await db.from("jobs").select("title").in("id", chunk);
        fail(error);
        titles.push(...((data ?? []) as Array<{ title: string }>).map((row) => row.title));
      }
      return titles;
    },
    async titlesNeedingClassification(limit) {
      const { data, error } = await db
        .from("jobs")
        .select("title, title_key")
        .or("classify_model.is.null,classify_model.eq.rules")
        .limit(limit);
      fail(error);
      const seen = new Set<string>();
      const titles: string[] = [];
      for (const row of (data ?? []) as Array<{ title: string; title_key: string }>) {
        if (seen.has(row.title_key)) continue;
        seen.add(row.title_key);
        titles.push(row.title);
      }
      return titles;
    },
    async getClassifications(cacheKeys) {
      const found = new Map<string, Classification>();
      for (const chunk of chunks(cacheKeys, 200)) {
        const { data, error } = await db.from("classifications").select("*").in("cache_key", chunk);
        fail(error);
        for (const row of data ?? []) {
          found.set(row.cache_key as string, {
            cacheKey: row.cache_key as string,
            title: row.title as string,
            isIntern: row.is_intern === 1,
            roleFamily: row.role_family as Classification["roleFamily"],
            seniority: row.seniority as Classification["seniority"],
            score: row.score as number,
            reason: row.reason as string,
            model: row.model as string,
          });
        }
      }
      return found;
    },
    async putClassification(row) {
      const { error } = await db.from("classifications").upsert({
        cache_key: row.cacheKey,
        title: row.title,
        is_intern: row.isIntern ? 1 : 0,
        role_family: row.roleFamily,
        seniority: row.seniority,
        score: row.score,
        reason: row.reason,
        model: row.model,
        created_at: new Date().toISOString(),
      });
      fail(error);
    },
    // One update per title: every job sharing a title gets that title's classification.
    // Covers titles classified this run plus jobs whose title was already cached.
    async applyClassifications(cacheKeys = []) {
      const { data, error } = await db.from("jobs").select("title_key").is("classify_model", null).limit(1000);
      fail(error);
      const keys = [...new Set([...cacheKeys, ...((data ?? []) as Array<{ title_key: string }>).map((row) => row.title_key)])];
      for (const chunk of chunks(keys, 200)) {
        const loaded = await db.from("classifications").select("*").in("cache_key", chunk);
        fail(loaded.error);
        for (const row of loaded.data ?? []) {
          let query = db
            .from("jobs")
            .update({
              is_intern: row.is_intern,
              role_family: row.role_family,
              seniority: row.seniority,
              score: row.score,
              classify_reason: row.reason,
              classify_model: row.model,
            })
            .eq("title_key", row.cache_key);
          if (row.model === "rules") query = query.is("classify_model", null);
          const { error: updateError } = await query;
          fail(updateError);
        }
      }
    },
    async listUnalertedMatches({ sinceHours, limit, minScore }) {
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
      const { data, error } = await db
        .from("jobs")
        .select("*")
        .is("alerted_at", null)
        .gte("first_seen_at", since)
        .gte("score", minScore)
        .or("is_intern.eq.1,seniority.eq.new_grad")
        .order("score", { ascending: false })
        .limit(limit);
      fail(error);
      return ((data ?? []) as JobRow[]).map(mapJob);
    },
    async markAlerted(ids) {
      if (ids.length === 0) return;
      const { error } = await db.from("jobs").update({ alerted_at: new Date().toISOString() }).in("id", ids);
      fail(error);
    },
    async listApplications() {
      const { data, error } = await db
        .from("applications")
        .select("job_id, status, notes, updated_at, jobs(title, company, canonical_url)")
        .order("updated_at", { ascending: false });
      fail(error);
      return ((data ?? []) as unknown as Array<{
        job_id: string;
        status: ApplicationStatus;
        notes: string;
        updated_at: string;
        jobs: { title: string; company: string; canonical_url: string } | { title: string; company: string; canonical_url: string }[] | null;
      }>).flatMap((row) => {
        const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
        if (!job) return [];
        return [{
          jobId: row.job_id,
          status: row.status,
          notes: row.notes,
          updatedAt: row.updated_at,
          title: job.title,
          company: job.company,
          canonicalUrl: job.canonical_url,
        }];
      });
    },
    async upsertApplication(input: ApplicationInput) {
      const job = await jobById(input.jobId);
      if (!job) throw new Error("unknown job");
      const status = input.status ?? "saved";
      if (!APPLICATION_STATUSES.includes(status)) throw new Error("invalid application status");
      const existing = (await this.listApplications()).find((item) => item.jobId === input.jobId);
      const { error } = await db.from("applications").upsert({
        job_id: input.jobId,
        status: input.status ?? existing?.status ?? status,
        notes: input.notes === undefined ? existing?.notes ?? "" : input.notes.slice(0, 2000),
        updated_at: new Date().toISOString(),
      });
      fail(error);
      const saved = (await this.listApplications()).find((item) => item.jobId === input.jobId);
      if (!saved) throw new Error("application was not saved");
      return saved;
    },
    async deleteApplication(jobId) {
      const { error } = await db.from("applications").delete().eq("job_id", jobId);
      fail(error);
    },
    async recordRun(run: PollRun) {
      const { error } = await db.from("poll_runs").insert({
        target_id: run.targetId,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        jobs_seen: run.jobsSeen,
        jobs_new: run.jobsNew,
        error: run.error,
      });
      fail(error);
    },
    async pruneRuns(olderThanDays) {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await db.from("poll_runs").delete().lt("started_at", cutoff);
      fail(error);
    },
    async stats(): Promise<Stats> {
      const targets = await db.from("targets").select("*", { count: "exact", head: true });
      const enabled = await db.from("targets").select("*", { count: "exact", head: true }).eq("enabled", 1);
      const jobs = await db.from("jobs").select("*", { count: "exact", head: true });
      const early = await db.from("jobs").select("*", { count: "exact", head: true }).or("is_intern.eq.1,seniority.eq.new_grad");
      const apps = await db.from("applications").select("*", { count: "exact", head: true });
      const runs = await db.from("poll_runs").select("*").order("started_at", { ascending: false }).limit(8);
      fail(targets.error);
      fail(enabled.error);
      fail(jobs.error);
      fail(early.error);
      fail(apps.error);
      fail(runs.error);
      return {
        targets: targets.count ?? 0,
        targetsEnabled: enabled.count ?? 0,
        jobs: jobs.count ?? 0,
        earlyCareer: early.count ?? 0,
        applications: apps.count ?? 0,
        recentRuns: ((runs.data ?? []) as Array<Record<string, string | number | null>>).map((row) => ({
          targetId: String(row.target_id),
          startedAt: String(row.started_at),
          finishedAt: String(row.finished_at),
          jobsSeen: Number(row.jobs_seen),
          jobsNew: Number(row.jobs_new),
          error: (row.error as string | null) ?? null,
        })),
      };
    },
  };
}

let singleton: Store | null = null;

export function getSupabaseStore(): Store {
  if (!singleton) singleton = createSupabaseStore();
  return singleton;
}
