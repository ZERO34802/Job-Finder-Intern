import type { Ats, Target, TargetInput } from "./types";
import { ATS } from "./types";

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*\.myworkdayjobs\.com$/i;

export function targetIdFor(input: Pick<TargetInput, "ats" | "boardToken" | "workdayTenant">): string {
  const slug = input.ats === "workday" ? input.workdayTenant : input.boardToken;
  if (!slug) throw new Error("missing board token");
  return `${input.ats}:${slug.toLowerCase()}`;
}

export function normalizeTarget(input: TargetInput, existing?: Target | null): Target {
  const company = input.company.trim();
  if (!company || company.length > 120) throw new Error("company name is required");
  if (!ATS.includes(input.ats)) throw new Error("ats must be greenhouse, lever, or workday");
  const interval = input.intervalMinutes ?? existing?.intervalMinutes ?? 360;
  if (!Number.isInteger(interval) || interval < 30 || interval > 10080) {
    throw new Error("interval must be between 30 and 10080 minutes");
  }

  const base = {
    id: targetIdFor(input),
    company,
    ats: input.ats as Ats,
    enabled: input.enabled ?? existing?.enabled ?? true,
    intervalMinutes: interval,
    lastPolledAt: existing?.lastPolledAt ?? null,
    lastStatus: existing?.lastStatus ?? null,
    lastError: existing?.lastError ?? null,
    lastOkAt: existing?.lastOkAt ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  if (input.ats === "workday") {
    const host = (input.workdayHost ?? "").trim().toLowerCase();
    const tenant = (input.workdayTenant ?? "").trim().toLowerCase();
    const site = (input.workdaySite ?? "").trim();
    if (!HOST_RE.test(host)) throw new Error("workday host must look like company.wd5.myworkdayjobs.com");
    if (!TOKEN_RE.test(tenant)) throw new Error("workday tenant is invalid");
    if (!TOKEN_RE.test(site)) throw new Error("workday site is invalid");
    return { ...base, boardToken: null, workdayHost: host, workdayTenant: tenant, workdaySite: site };
  }

  const token = (input.boardToken ?? "").trim();
  if (!TOKEN_RE.test(token)) throw new Error("board token is invalid");
  return {
    ...base,
    id: `${input.ats}:${token.toLowerCase()}`,
    boardToken: token,
    workdayHost: null,
    workdayTenant: null,
    workdaySite: null,
  };
}

export function isDue(target: Target, now = Date.now()): boolean {
  if (!target.lastPolledAt) return true;
  const elapsed = now - Date.parse(target.lastPolledAt);
  return elapsed >= target.intervalMinutes * 60_000;
}
