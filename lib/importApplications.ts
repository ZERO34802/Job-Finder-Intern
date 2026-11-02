import { parseCsv } from "./csv";
import { canonicalJobUrl, companyKey, postingKey } from "./canonicalize";
import type { Application, ApplicationStatus, Referral, Store } from "./types";

// One application as written in the tracking sheet. Rows copied from the sheet come in its
// column order: Company, Role, Job Link, Application Status, Date, JD, Result.
export type SheetRow = {
  company: string;
  role: string;
  link: string;
  status: string;
  date?: string;
  result?: string;
  // Set by the add form; sheet rows carry the referral inside the status text.
  referral?: Referral;
  notes?: string;
};

export type ImportAction = "new job" | "matched job" | "already tracked";

export type PlannedRow = {
  company: string;
  title: string;
  url: string;
  status: ApplicationStatus;
  referral: Referral;
  notes: string;
  jobId: string | null;
  action: ImportAction;
  // What the import changes on an application that is already tracked.
  changes: string[];
};

export type ImportPlan = {
  rows: PlannedRow[];
  skipped: Array<{ line: string; reason: string }>;
};

export function parseSheetRows(text: string): SheetRow[] {
  return parseCsv(text, "\t")
    .filter((cells) => cells[0]?.toLowerCase() !== "company")
    .map(([company = "", role = "", link = "", status = "", date = "", , result = ""]) => ({ company, role, link, status, date, result }));
}

// Sheet statuses such as "Applied(no referral)", "Appplied(referral)", "Referral requested".
export function mapSheetStatus(raw: string): { status: ApplicationStatus; referral: Referral; note: string | null } {
  const text = raw.trim().toLowerCase();
  const referral: Referral = /referral requested|requested referral/.test(text)
    ? "requested"
    : /\bno referral\b/.test(text)
      ? "none"
      : /referr?al|referred/.test(text)
        ? "referred"
        : "none";
  if (!text) return { status: "saved", referral, note: null };
  if (/reject/.test(text)) return { status: "rejected", referral, note: null };
  if (/interview/.test(text)) return { status: "interviewing", referral, note: null };
  if (/offer/.test(text)) return { status: "offer", referral, note: null };
  if (/withdr/.test(text)) return { status: "withdrawn", referral, note: null };
  if (/^saved\b/.test(text)) return { status: "saved", referral, note: null };
  // A referral was only asked for once the application was in.
  if (/a+p+lied|referral requested/.test(text)) return { status: "applied", referral, note: null };
  return { status: "saved", referral, note: `Sheet status: ${raw.trim()}` };
}

// Later stages win: an import never moves an application back (applied does not undo interviewing).
const STAGE: Record<ApplicationStatus, number> = { saved: 0, applied: 1, interviewing: 2, offer: 3, rejected: 4, withdrawn: 4 };
const REFERRAL_RANK: Record<Referral, number> = { none: 0, requested: 1, referred: 2 };

function laterStatus(a: ApplicationStatus, b: ApplicationStatus): ApplicationStatus {
  return STAGE[b] > STAGE[a] ? b : a;
}

function strongerReferral(a: Referral, b: Referral): Referral {
  return REFERRAL_RANK[b] > REFERRAL_RANK[a] ? b : a;
}

function mergeNotes(existing: string, added: string[]): string {
  const parts = existing ? [existing] : [];
  for (const note of added) if (note && !parts.some((part) => part.includes(note))) parts.push(note);
  return parts.join("\n").slice(0, 2000);
}

// A company name for rows that left it blank, read from the link.
export function companyFromUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  const board = /greenhouse\.io|lever\.co|ashbyhq\.com/.test(host)
    ? u.searchParams.get("for") ?? u.pathname.split("/").filter(Boolean).find((part) => part !== "embed")
    : null;
  const label = board ?? host.split(".").at(host.includes("myworkdayjobs") ? 0 : -2) ?? host;
  return decodeURIComponent(label).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type Draft = Omit<PlannedRow, "jobId" | "action" | "changes"> & { links: string[] };

// Ways the same posting shows up under different links: the board's id, the link itself, and
// the long job number a company site shares with its board ("stripe.com/.../8128745" and
// Greenhouse's token=8128745).
function postingKeys(url: string, company: string): string[] {
  const digits = (url.match(/\d{7,}/g) ?? []).sort((a, b) => b.length - a.length)[0];
  return [postingKey(url), url, digits ? `${companyKey(company)}#${digits}` : null].filter((key): key is string => !!key);
}

function absorb(into: Draft, from: Pick<Draft, "status" | "referral"> & { notes: string[] }) {
  into.status = laterStatus(into.status, from.status);
  into.referral = strongerReferral(into.referral, from.referral);
  into.notes = mergeNotes(into.notes, from.notes);
}

// Works out what an import would do without changing anything.
export async function planImport(store: Store, sheetRows: SheetRow[]): Promise<ImportPlan> {
  const skipped: ImportPlan["skipped"] = [];
  // Rows for the same posting collapse into one.
  const list: Draft[] = [];
  const byKey = new Map<string, Draft>();
  const untitled = new Set<Draft>();
  for (const row of sheetRows) {
    const line = [row.company, row.role, row.link].filter(Boolean).join(" · ").slice(0, 160);
    let url: string;
    try {
      url = canonicalJobUrl(row.link);
    } catch {
      skipped.push({ line: line || "(empty row)", reason: "no job link" });
      continue;
    }
    const mapped = mapSheetStatus(row.status);
    if (row.referral) mapped.referral = row.referral;
    const notes = [row.notes?.trim() || null, mapped.note, row.date?.trim() ? `Date: ${row.date.trim()}` : null, row.result?.trim() || null].filter(
      (note): note is string => !!note,
    );
    const company = row.company.trim() || companyFromUrl(url);
    const keys = postingKeys(url, company);
    const prev = keys.map((key) => byKey.get(key)).find((draft) => !!draft);
    if (prev) {
      absorb(prev, { status: mapped.status, referral: mapped.referral, notes });
      if (!prev.links.includes(url)) prev.links.push(url);
      if (untitled.has(prev) && row.role.trim()) {
        prev.title = row.role.trim();
        untitled.delete(prev);
      }
      for (const key of keys) byKey.set(key, prev);
      continue;
    }
    const draft: Draft = {
      company,
      title: row.role.trim() || `${company} internship`,
      url,
      links: [url],
      status: mapped.status,
      referral: mapped.referral,
      notes: mergeNotes("", notes),
    };
    if (!row.role.trim()) untitled.add(draft);
    for (const key of keys) byKey.set(key, draft);
    list.push(draft);
  }

  const [ids, applications] = await Promise.all([store.findJobIds(list.flatMap((draft) => draft.links)), store.listApplications()]);
  const tracked = new Map<string, Application>(applications.map((item) => [item.jobId, item]));
  const jobOf = (draft: Draft) => draft.links.map((link) => ids.get(link)).find((id) => !!id) ?? null;
  // Different links can still lead to one stored job (a company page and its board page).
  const byJob = new Map<string, Draft>();
  const merged: Draft[] = [];
  for (const draft of list) {
    const jobId = jobOf(draft);
    const prev = jobId ? byJob.get(jobId) : undefined;
    if (prev) {
      absorb(prev, { status: draft.status, referral: draft.referral, notes: draft.notes ? draft.notes.split("\n") : [] });
      continue;
    }
    if (jobId) byJob.set(jobId, draft);
    merged.push(draft);
  }
  const rows = merged.map((full): PlannedRow => {
    const jobId = jobOf(full);
    const draft = { company: full.company, title: full.title, url: full.url, status: full.status, referral: full.referral, notes: full.notes };
    const current = jobId ? tracked.get(jobId) : undefined;
    if (!current) return { ...draft, jobId, action: jobId ? "matched job" : "new job", changes: [] };
    const status = laterStatus(current.status, draft.status);
    const referral = strongerReferral(current.referral, draft.referral);
    const notes = mergeNotes(current.notes, draft.notes ? draft.notes.split("\n") : []);
    const changes = [
      status !== current.status ? `status ${current.status} → ${status}` : null,
      referral !== current.referral ? `referral ${current.referral} → ${referral}` : null,
      notes !== current.notes ? "notes added" : null,
    ].filter((change): change is string => !!change);
    return { ...draft, status, referral, notes, jobId, action: "already tracked", changes };
  });
  return { rows, skipped };
}

// Carries out a plan: creates jobs no board has listed, then saves each application.
// Rows already tracked with nothing to change are left alone.
export async function applyImport(store: Store, plan: ImportPlan): Promise<{ saved: number; newJobs: number; unchanged: number }> {
  const todo = plan.rows.filter((row) => row.action !== "already tracked" || row.changes.length > 0);
  const fresh = todo.filter((row) => !row.jobId);
  const ids = await store.addManualJobs(fresh.map((row) => ({ company: row.company, title: row.title, url: row.url })));
  const rows = todo.flatMap((row) => {
    const jobId = row.jobId ?? ids.get(row.url);
    return jobId ? [{ jobId, status: row.status, referral: row.referral, notes: row.notes }] : [];
  });
  await store.putApplications(rows);
  return { saved: rows.length, newJobs: fresh.length, unchanged: plan.rows.length - todo.length };
}
