import { createHash } from "node:crypto";

const TRACKING = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gh_src",
  "lever-source",
  "lever-origin",
  "ref",
  "source",
]);

export function canonicalJobUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...u.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING.has(lower) || lower.startsWith("utm_")) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/[a-z]{2}-[a-z]{2}(?=\/)/gi, "");
  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function titleCacheKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(incorporated|inc|llc|ltd|corp|corporation|co|company)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function dedupeKey(company: string, title: string, location: string | null): string {
  const material = [companyKey(company), titleCacheKey(title), titleCacheKey(location ?? "")].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}
