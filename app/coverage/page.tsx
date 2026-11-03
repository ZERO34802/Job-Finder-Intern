import { timeAgo } from "@/lib/posted";
import { LIST_FEEDS } from "@/lib/sources";
import { getStore } from "@/lib/store";
import type { SourceUrl } from "@/lib/types";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

// Lists by name; every company board is grouped by its board system.
function sourceName(source: SourceUrl): string {
  if (source.ats !== "list") return `${source.ats} boards`;
  const feed = source.targetId.replace(/^list:/, "");
  return LIST_FEEDS[feed]?.company ?? source.targetId;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default async function CoveragePage() {
  const store = getStore();
  const now = Date.now();
  const [targets, matches] = await Promise.all([
    store.listTargets(),
    store.listMatchSources(new Date(now - WEEK_DAYS * DAY_MS).toISOString()),
  ]);

  const systems = new Map<string, { total: number; enabled: number; ok: number; failing: number; frequent: number; waiting: number }>();
  for (const target of targets) {
    const row = systems.get(target.ats) ?? { total: 0, enabled: 0, ok: 0, failing: 0, frequent: 0, waiting: 0 };
    row.total++;
    if (target.enabled) {
      row.enabled++;
      if (target.lastOkAt && now - Date.parse(target.lastOkAt) < DAY_MS) row.ok++;
      if (target.lastStatus === "error") row.failing++;
      if (target.intervalMinutes < 60) row.frequent++;
      if (!target.lastPolledAt) row.waiting++;
    }
    systems.set(target.ats, row);
  }
  const failing = targets
    .filter((target) => target.enabled && target.lastStatus === "error")
    .sort((a, b) => Date.parse(a.lastOkAt ?? "1970") - Date.parse(b.lastOkAt ?? "1970"))
    .slice(0, 50);

  // Per source: matches it listed, matches nobody else listed, and matches it saw first.
  // "First" needs every source of a match to carry seenAt, which began in November 2026.
  const bySource = new Map<string, { listed: number; only: number; first: number }>();
  const boardLead: number[] = [];
  let compared = 0;
  for (const match of matches) {
    const names = [...new Set(match.sources.map(sourceName))];
    for (const name of names) {
      const row = bySource.get(name) ?? { listed: 0, only: 0, first: 0 };
      row.listed++;
      if (names.length === 1) row.only++;
      bySource.set(name, row);
    }
    if (names.length < 2 || !match.sources.every((source) => source.seenAt)) continue;
    const earliest = match.sources.reduce((a, b) => (a.seenAt! <= b.seenAt! ? a : b));
    bySource.get(sourceName(earliest))!.first++;
    const board = match.sources.filter((source) => source.ats !== "list").map((source) => Date.parse(source.seenAt!));
    const list = match.sources.filter((source) => source.ats === "list").map((source) => Date.parse(source.seenAt!));
    if (board.length && list.length) {
      compared++;
      boardLead.push((Math.min(...list) - Math.min(...board)) / 3_600_000);
    }
  }
  const lead = median(boardLead);
  const boardsFirst = boardLead.filter((hours) => hours > 0).length;

  return (
    <main>
      <p className="lede">
        What Intern Finder checks and how well it is doing. Boards that have had internships are checked about every 25
        minutes, the rest every 2 hours. A new board&apos;s first check only records what is already open.
      </p>

      <h2 className="section">Board systems</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Boards on</th>
              <th>Checked in 24h</th>
              <th>Every 25 min</th>
              <th>Not checked yet</th>
              <th>Failing</th>
            </tr>
          </thead>
          <tbody>
            {[...systems.entries()]
              .sort((a, b) => b[1].enabled - a[1].enabled)
              .map(([ats, row]) => (
                <tr key={ats}>
                  <td><b>{ats}</b></td>
                  <td>{row.enabled}<span className="sub">of {row.total}</span></td>
                  <td>{row.ok}</td>
                  <td>{row.frequent}</td>
                  <td>{row.waiting || "—"}</td>
                  <td>{row.failing ? <span className="pill bad">{row.failing}</span> : "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <h2 className="section">Where the last {WEEK_DAYS} days of matches came from</h2>
      <p className="sub">
        {matches.length} matches first seen in the last {WEEK_DAYS} days.{" "}
        {compared > 0 && lead !== null
          ? `On ${compared} postings both a company board and a list had, the board was first ${boardsFirst} times; median lead ${lead >= 0 ? `${lead.toFixed(1)}h for the board` : `${(-lead).toFixed(1)}h for the list`}.`
          : "Which source finds a posting first is recorded from November 3, 2026; numbers appear as postings are seen by more than one source."}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Matches listed</th>
              <th>Only this source</th>
              <th>Found first</th>
            </tr>
          </thead>
          <tbody>
            {[...bySource.entries()]
              .sort((a, b) => b[1].listed - a[1].listed)
              .map(([name, row]) => (
                <tr key={name}>
                  <td><b>{name}</b></td>
                  <td>{row.listed}</td>
                  <td>{row.only}</td>
                  <td>{row.first || "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <h2 className="section">Failing boards{failing.length === 50 ? " (50 longest failing)" : ""}</h2>
      <div className="table-wrap">
        {failing.length === 0 ? (
          <div className="empty">No board is failing.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Board</th>
                <th>Error</th>
                <th>Last worked</th>
              </tr>
            </thead>
            <tbody>
              {failing.map((target) => (
                <tr key={target.id}>
                  <td>{target.company}<span className="sub">{target.id}</span></td>
                  <td><span className="sub">{(target.lastError ?? "").slice(0, 160)}</span></td>
                  <td className="when">{target.lastOkAt ? timeAgo(Date.parse(target.lastOkAt), now) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
