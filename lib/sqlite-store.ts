import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJobUrl, dedupeKey, titleCacheKey } from "./canonicalize";
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
  RoleFamily,
  Seniority,
  SourceUrl,
  Stats,
  Store,
  Target,
  TargetInput,
} from "./types";
import { APPLICATION_STATUSES } from "./types";
import { normalizeTarget } from "./targets";

type TargetRow = {
  id: string;
  company: string;
  ats: Ats;
  board_token: string | null;
  workday_host: string | null;
  workday_tenant: string | null;
  workday_site: string | null;
  enabled: number;
  interval_minutes: number;
  last_polled_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_ok_at: string | null;
  created_at: string;
};

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
  source_urls: string;
  title_key: string;
  is_intern: number | null;
  role_family: string | null;
  seniority: string | null;
  score: number | null;
  classify_reason: string | null;
  classify_model: string | null;
  alerted_at: string | null;
};

function readSources(value: string | null): SourceUrl[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as SourceUrl[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTarget(row: TargetRow): Target {
  return {
    id: row.id,
    company: row.company,
    ats: row.ats,
    boardToken: row.board_token,
    workdayHost: row.workday_host,
    workdayTenant: row.workday_tenant,
    workdaySite: row.workday_site,
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    lastPolledAt: row.last_polled_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastOkAt: row.last_ok_at,
    createdAt: row.created_at,
  };
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

function mergeSources(prev: SourceUrl[], next: SourceUrl): SourceUrl[] {
  if (prev.some((item) => item.url === next.url)) return prev;
  return [...prev, next];
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function createSqliteStore(file = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "intern-finder.db")): Store {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      ats TEXT NOT NULL,
      board_token TEXT,
      workday_host TEXT,
      workday_tenant TEXT,
      workday_site TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 360,
      last_polled_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      canonical_url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      ats TEXT NOT NULL,
      target_id TEXT,
      external_id TEXT,
      posted_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_urls TEXT NOT NULL,
      title_key TEXT NOT NULL,
      is_intern INTEGER,
      role_family TEXT,
      seniority TEXT,
      score REAL,
      classify_reason TEXT,
      classify_model TEXT,
      alerted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_title_key_idx ON jobs (title_key);
    CREATE INDEX IF NOT EXISTS jobs_first_seen_idx ON jobs (first_seen_at);
    CREATE TABLE IF NOT EXISTS classifications (
      cache_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      is_intern INTEGER NOT NULL,
      role_family TEXT NOT NULL,
      seniority TEXT NOT NULL,
      score REAL NOT NULL,
      reason TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      job_id TEXT PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS poll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      jobs_seen INTEGER NOT NULL,
      jobs_new INTEGER NOT NULL,
      error TEXT
    );
  `);
  const targetColumns = db.prepare("PRAGMA table_info(targets)").all() as Array<{ name: string }>;
  if (!targetColumns.some((column) => column.name === "last_ok_at")) {
    db.exec("ALTER TABLE targets ADD COLUMN last_ok_at TEXT");
  }

  const getTargetStmt = db.prepare("SELECT * FROM targets WHERE id = ?");
  const getJobStmt = db.prepare("SELECT * FROM jobs WHERE id = ?");
  const getJobByUrl = db.prepare("SELECT * FROM jobs WHERE canonical_url = ?");

  return {
    async listTargets() {
      const rows = db.prepare("SELECT * FROM targets ORDER BY company COLLATE NOCASE").all() as TargetRow[];
      return rows.map(mapTarget);
    },
    async getTarget(id) {
      const row = getTargetStmt.get(id) as TargetRow | undefined;
      return row ? mapTarget(row) : null;
    },
    async upsertTarget(input: TargetInput) {
      const idGuess = input.ats === "workday" ? `workday:${(input.workdayTenant ?? "").toLowerCase()}` : `${input.ats}:${(input.boardToken ?? "").toLowerCase()}`;
      const existing = (getTargetStmt.get(idGuess) as TargetRow | undefined) ?? null;
      const target = normalizeTarget(input, existing ? mapTarget(existing) : null);
      db.prepare(
        `INSERT INTO targets (
          id, company, ats, board_token, workday_host, workday_tenant, workday_site,
          enabled, interval_minutes, last_polled_at, last_status, last_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          company = excluded.company,
          ats = excluded.ats,
          board_token = excluded.board_token,
          workday_host = excluded.workday_host,
          workday_tenant = excluded.workday_tenant,
          workday_site = excluded.workday_site,
          enabled = excluded.enabled,
          interval_minutes = excluded.interval_minutes`,
      ).run(
        target.id,
        target.company,
        target.ats,
        target.boardToken,
        target.workdayHost,
        target.workdayTenant,
        target.workdaySite,
        target.enabled ? 1 : 0,
        target.intervalMinutes,
        target.lastPolledAt,
        target.lastStatus,
        target.lastError,
        target.createdAt,
      );
      return mapTarget(getTargetStmt.get(target.id) as TargetRow);
    },
    async setTargetEnabled(id, enabled) {
      const result = db.prepare("UPDATE targets SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      if (result.changes === 0) throw new Error("unknown target");
    },
    async deleteTarget(id) {
      db.prepare("DELETE FROM targets WHERE id = ?").run(id);
    },
    async touchTarget(id, status, error) {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE targets SET last_polled_at = ?, last_status = ?, last_error = ?,
         last_ok_at = CASE WHEN ? = 'ok' THEN ? ELSE last_ok_at END WHERE id = ?`,
      ).run(now, status, error, status, now, id);
    },
    async upsertJobs(jobs: JobDraft[]) {
      const insertedIds: string[] = [];
      const now = new Date().toISOString();
      const insert = db.prepare(
        `INSERT INTO jobs (
          id, canonical_url, title, company, location, ats, target_id, external_id, posted_at,
          first_seen_at, last_seen_at, source_urls, title_key, alerted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = db.prepare(
        `UPDATE jobs SET last_seen_at = ?, title = ?, location = COALESCE(?, location), source_urls = ?, company = ? WHERE id = ?`,
      );
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
        const prev =
          (getJobStmt.get(id) as JobRow | undefined) ??
          (getJobByUrl.get(canonical) as JobRow | undefined);
        if (!prev) {
          insert.run(
            id,
            canonical,
            draft.title.trim(),
            draft.company.trim(),
            draft.location,
            draft.ats,
            draft.targetId,
            draft.externalId,
            draft.postedAt,
            now,
            now,
            JSON.stringify([source]),
            titleCacheKey(draft.title),
            draft.quiet ? now : null,
          );
          insertedIds.push(id);
        } else {
          const sources = mergeSources(readSources(prev.source_urls), source);
          update.run(now, draft.title.trim(), draft.location, JSON.stringify(sources), prev.company, prev.id);
        }
      }
      return { insertedIds };
    },
    async listJobs(filter: JobFilter) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filter.earlyOnly) where.push("(is_intern = 1 OR seniority = 'new_grad')");
      if (filter.family) {
        where.push("role_family = ?");
        params.push(filter.family);
      }
      if (filter.q?.trim()) {
        where.push("(title LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')");
        const pattern = likePattern(filter.q.trim());
        params.push(pattern, pattern);
      }
      const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
      params.push(limit);
      const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(score, 0) DESC, first_seen_at DESC LIMIT ?`;
      const rows = db.prepare(sql).all(...params) as JobRow[];
      return rows.map(mapJob);
    },
    async titlesForIds(ids) {
      if (ids.length === 0) return [];
      const titles: string[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const marks = chunk.map(() => "?").join(", ");
        const rows = db.prepare(`SELECT title FROM jobs WHERE id IN (${marks})`).all(...chunk) as Array<{ title: string }>;
        titles.push(...rows.map((row) => row.title));
      }
      return titles;
    },
    async titlesNeedingClassification(limit) {
      const rows = db
        .prepare(
          `SELECT MIN(title) AS title FROM jobs
           WHERE classify_model IS NULL OR classify_model = 'rules'
           GROUP BY title_key
           LIMIT ?`,
        )
        .all(limit) as Array<{ title: string }>;
      return rows.map((row) => row.title);
    },
    async getClassifications(cacheKeys) {
      const found = new Map<string, Classification>();
      for (let i = 0; i < cacheKeys.length; i += 200) {
        const chunk = cacheKeys.slice(i, i + 200);
        const marks = chunk.map(() => "?").join(", ");
        const rows = db.prepare(`SELECT * FROM classifications WHERE cache_key IN (${marks})`).all(...chunk) as Array<{
          cache_key: string;
          title: string;
          is_intern: number;
          role_family: RoleFamily;
          seniority: Seniority;
          score: number;
          reason: string;
          model: string;
        }>;
        for (const row of rows) {
          found.set(row.cache_key, {
            cacheKey: row.cache_key,
            title: row.title,
            isIntern: row.is_intern === 1,
            roleFamily: row.role_family,
            seniority: row.seniority,
            score: row.score,
            reason: row.reason,
            model: row.model,
          });
        }
      }
      return found;
    },
    async putClassification(row: Classification) {
      db.prepare(
        `INSERT INTO classifications (
          cache_key, title, is_intern, role_family, seniority, score, reason, model, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          title = excluded.title,
          is_intern = excluded.is_intern,
          role_family = excluded.role_family,
          seniority = excluded.seniority,
          score = excluded.score,
          reason = excluded.reason,
          model = excluded.model`,
      ).run(
        row.cacheKey,
        row.title,
        row.isIntern ? 1 : 0,
        row.roleFamily,
        row.seniority,
        row.score,
        row.reason,
        row.model,
        new Date().toISOString(),
      );
    },
    async applyClassifications() {
      db.exec(`
        UPDATE jobs
        SET
          is_intern = c.is_intern,
          role_family = c.role_family,
          seniority = c.seniority,
          score = c.score,
          classify_reason = c.reason,
          classify_model = c.model
        FROM classifications AS c
        WHERE jobs.title_key = c.cache_key
          AND (
            jobs.classify_model IS NULL
            OR (jobs.classify_model = 'rules' AND c.model != 'rules')
          )
      `);
    },
    async listUnalertedMatches({ sinceHours, limit, minScore }) {
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
      const rows = db
        .prepare(
          `SELECT * FROM jobs
           WHERE alerted_at IS NULL
             AND first_seen_at >= ?
             AND score >= ?
             AND (is_intern = 1 OR seniority = 'new_grad')
           ORDER BY score DESC, first_seen_at DESC
           LIMIT ?`,
        )
        .all(since, minScore, limit) as JobRow[];
      return rows.map(mapJob);
    },
    async markAlerted(ids) {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      const stmt = db.prepare("UPDATE jobs SET alerted_at = ? WHERE id = ?");
      for (const id of ids) stmt.run(now, id);
    },
    async listApplications() {
      const rows = db
        .prepare(
          `SELECT a.job_id, a.status, a.notes, a.updated_at, j.title, j.company, j.canonical_url
           FROM applications a
           JOIN jobs j ON j.id = a.job_id
           ORDER BY a.updated_at DESC`,
        )
        .all() as Array<{
        job_id: string;
        status: ApplicationStatus;
        notes: string;
        updated_at: string;
        title: string;
        company: string;
        canonical_url: string;
      }>;
      return rows.map((row) => ({
        jobId: row.job_id,
        status: row.status,
        notes: row.notes,
        updatedAt: row.updated_at,
        title: row.title,
        company: row.company,
        canonicalUrl: row.canonical_url,
      }));
    },
    async upsertApplication(input: ApplicationInput) {
      const job = getJobStmt.get(input.jobId) as JobRow | undefined;
      if (!job) throw new Error("unknown job");
      const status = input.status ?? "saved";
      if (!APPLICATION_STATUSES.includes(status)) throw new Error("invalid application status");
      const notes = (input.notes ?? "").slice(0, 2000);
      const existing = db.prepare("SELECT notes, status FROM applications WHERE job_id = ?").get(input.jobId) as
        | { notes: string; status: ApplicationStatus }
        | undefined;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO applications (job_id, status, notes, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      ).run(input.jobId, input.status ?? existing?.status ?? status, input.notes === undefined ? existing?.notes ?? "" : notes, now);
      const saved = (await this.listApplications()).find((item) => item.jobId === input.jobId);
      if (!saved) throw new Error("application was not saved");
      return saved;
    },
    async deleteApplication(jobId) {
      db.prepare("DELETE FROM applications WHERE job_id = ?").run(jobId);
    },
    async recordRun(run: PollRun) {
      db.prepare(
        `INSERT INTO poll_runs (target_id, started_at, finished_at, jobs_seen, jobs_new, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(run.targetId, run.startedAt, run.finishedAt, run.jobsSeen, run.jobsNew, run.error);
    },
    async pruneRuns(olderThanDays) {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM poll_runs WHERE started_at < ?").run(cutoff);
    },
    async stats(): Promise<Stats> {
      const targets = db.prepare("SELECT COUNT(*) AS n, SUM(enabled) AS enabled FROM targets").get() as { n: number; enabled: number | null };
      const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
      const early = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE is_intern = 1 OR seniority = 'new_grad'").get() as { n: number };
      const apps = db.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number };
      const recentRuns = db
        .prepare(
          `SELECT target_id, started_at, finished_at, jobs_seen, jobs_new, error
           FROM poll_runs ORDER BY id DESC LIMIT 8`,
        )
        .all() as Array<{
        target_id: string;
        started_at: string;
        finished_at: string;
        jobs_seen: number;
        jobs_new: number;
        error: string | null;
      }>;
      return {
        targets: targets.n,
        targetsEnabled: targets.enabled ?? 0,
        jobs: jobs.n,
        earlyCareer: early.n,
        applications: apps.n,
        recentRuns: recentRuns.map((row) => ({
          targetId: row.target_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          jobsSeen: row.jobs_seen,
          jobsNew: row.jobs_new,
          error: row.error,
        })),
      };
    },
  };
}

let singleton: Store | null = null;

export function getSqliteStore(): Store {
  if (!singleton) singleton = createSqliteStore();
  return singleton;
}
