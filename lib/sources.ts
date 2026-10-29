import type { Ats, JobDraft, Target, TargetInput } from "./types";
import { fetchJson } from "./http";

export type RemoteJob = {
  externalId: string;
  title: string;
  url: string;
  location: string | null;
  postedAt: string | null;
  company?: string;
};

type GreenhouseJob = {
  id?: number;
  title?: string;
  absolute_url?: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  location?: { name?: string };
};

export async function fetchGreenhouse(token: string): Promise<RemoteJob[]> {
  const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
  );
  return (data.jobs ?? []).flatMap((job) => {
    if (!job.absolute_url || !job.title) return [];
    return [
      {
        externalId: String(job.id ?? job.absolute_url),
        title: job.title,
        url: job.absolute_url,
        location: job.location?.name ?? null,
        postedAt: job.first_published ?? job.updated_at ?? null,
        company: job.company_name,
      },
    ];
  });
}

type LeverJob = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  categories?: { location?: string };
};

export async function fetchLever(token: string): Promise<RemoteJob[]> {
  const data = await fetchJson<LeverJob[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
  );
  if (!Array.isArray(data)) return [];
  return data.flatMap((job) => {
    if (!job.hostedUrl || !job.text) return [];
    return [
      {
        externalId: job.id ?? job.hostedUrl,
        title: job.text,
        url: job.hostedUrl,
        location: job.categories?.location ?? null,
        postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      },
    ];
  });
}

type WorkdayPosting = {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
};

export async function fetchWorkday(host: string, tenant: string, site: string): Promise<RemoteJob[]> {
  // Workday search is the slow source, so it asks only for intern terms, 3 pages each.
  const queries = ["intern", "internship", "co-op"];
  const seen = new Map<string, RemoteJob>();
  for (const searchText of queries) {
    for (let offset = 0; offset < 60; offset += 20) {
      const data = await fetchJson<{ jobPostings?: WorkdayPosting[] }>(
        `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }),
        },
      );
      const postings = data.jobPostings ?? [];
      for (const job of postings) {
        if (!job.title || !job.externalPath) continue;
        const path = job.externalPath.startsWith("/") ? job.externalPath : `/${job.externalPath}`;
        const url = `https://${host}/${site}${path}`;
        if (!seen.has(job.externalPath)) {
          seen.set(job.externalPath, {
            externalId: job.bulletFields?.[0] ?? job.externalPath,
            title: job.title,
            url,
            location: job.locationsText ?? null,
            postedAt: job.postedOn ?? null,
          });
        }
      }
      if (postings.length < 20) break;
    }
  }
  return [...seen.values()];
}

type AshbyJob = {
  id?: string;
  title?: string;
  jobUrl?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isListed?: boolean;
};

export async function fetchAshby(name: string): Promise<RemoteJob[]> {
  const data = await fetchJson<{ jobs?: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}`,
  );
  return (data.jobs ?? []).flatMap((job) => {
    if (!job.jobUrl || !job.title || job.isListed === false) return [];
    const places = [job.location, ...(job.secondaryLocations ?? []).map((item) => item.location)].filter(Boolean);
    return [
      {
        externalId: job.id ?? job.jobUrl,
        title: job.title,
        url: job.jobUrl,
        location: places.length ? places.join("; ") : null,
        postedAt: job.publishedAt ?? null,
      },
    ];
  });
}

type SmartRecruitersPosting = {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; country?: string };
};

export async function fetchSmartRecruiters(company: string): Promise<RemoteJob[]> {
  // Full boards run to thousands of postings, so only intern searches are read.
  const jobs: RemoteJob[] = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const data = await fetchJson<{ content?: SmartRecruitersPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?q=intern&limit=100&offset=${offset}`,
    );
    const page = data.content ?? [];
    for (const job of page) {
      if (!job.id || !job.name) continue;
      const loc = job.location;
      jobs.push({
        externalId: job.id,
        title: job.name,
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${job.id}`,
        location: loc?.fullLocation?.replace(/,\s*,/g, ",") || [loc?.city, loc?.country].filter(Boolean).join(", ") || null,
        postedAt: job.releasedDate ?? null,
      });
    }
    if (page.length < 100) break;
  }
  return jobs;
}

type Listing = {
  id?: string;
  title?: string;
  company_name?: string;
  url?: string;
  locations?: string[];
  date_posted?: number;
  active?: boolean;
  is_visible?: boolean;
  terms?: string[];
  season?: string;
};

// Community lists of open internships; both repos publish the same listings.json shape.
export const LIST_FEEDS: Record<string, { company: string; url: string; keep: (item: Listing) => boolean }> = {
  simplify: {
    company: "SimplifyJobs list",
    url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    keep: (item) => {
      const terms = item.terms ?? [];
      return terms.length === 0 || terms.some((term) => term === "Summer 2027" || term === "N/A");
    },
  },
  vansh: {
    company: "vanshb03 list",
    url: "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
    keep: (item) => !item.season || item.season === "Summer",
  },
};

export type ListResult = { jobs: RemoteJob[]; boards: TargetInput[] };

// Board links inside a list become targets, which is how new companies are found.
export function boardFromUrl(company: string, raw: string): TargetInput | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const first = decodeURIComponent(url.pathname.split("/")[1] ?? "");
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const token = first === "embed" ? url.searchParams.get("for") : first;
    return token ? { company, ats: "greenhouse", boardToken: token } : null;
  }
  if (host === "jobs.lever.co" && first) return { company, ats: "lever", boardToken: first };
  if (host === "jobs.ashbyhq.com" && first) return { company, ats: "ashby", boardToken: first };
  if ((host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") && first) {
    return { company, ats: "smartrecruiters", boardToken: first };
  }
  const wd = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (wd) {
    const parts = url.pathname.split("/").filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts[1] : parts[0];
    return site ? { company, ats: "workday", workdayHost: host, workdayTenant: wd[1], workdaySite: site } : null;
  }
  return null;
}

export async function fetchList(feed: string): Promise<ListResult> {
  const config = LIST_FEEDS[feed];
  if (!config) throw new Error(`unknown list feed ${feed}`);
  const items = await fetchJson<Listing[]>(config.url);
  if (!Array.isArray(items)) throw new Error(`${feed} list is not an array`);
  const jobs: RemoteJob[] = [];
  const boards = new Map<string, TargetInput>();
  for (const item of items) {
    if (!item.url || !item.title || !item.company_name) continue;
    const board = boardFromUrl(item.company_name, item.url);
    if (board) boards.set(`${board.ats}:${board.boardToken ?? board.workdayHost}`.toLowerCase(), board);
    if (!item.active || item.is_visible === false || !config.keep(item)) continue;
    jobs.push({
      externalId: item.id ?? item.url,
      title: item.title,
      url: item.url,
      location: item.locations?.length ? item.locations.join("; ") : null,
      postedAt: item.date_posted ? new Date(item.date_posted * 1000).toISOString() : null,
      company: item.company_name,
    });
  }
  return { jobs, boards: [...boards.values()] };
}

export async function fetchTargetJobs(target: Target): Promise<RemoteJob[]> {
  if (target.ats === "greenhouse") {
    if (!target.boardToken) throw new Error("greenhouse target is missing a board token");
    return fetchGreenhouse(target.boardToken);
  }
  if (target.ats === "lever") {
    if (!target.boardToken) throw new Error("lever target is missing a board token");
    return fetchLever(target.boardToken);
  }
  if (target.ats === "ashby") {
    if (!target.boardToken) throw new Error("ashby target is missing a board token");
    return fetchAshby(target.boardToken);
  }
  if (target.ats === "smartrecruiters") {
    if (!target.boardToken) throw new Error("smartrecruiters target is missing a company id");
    return fetchSmartRecruiters(target.boardToken);
  }
  if (target.ats === "list") {
    if (!target.boardToken) throw new Error("list target is missing a feed name");
    return (await fetchList(target.boardToken)).jobs;
  }
  if (!target.workdayHost || !target.workdayTenant || !target.workdaySite) {
    throw new Error("workday target is missing host, tenant, or site");
  }
  return fetchWorkday(target.workdayHost, target.workdayTenant, target.workdaySite);
}

export function toDrafts(target: Target, jobs: RemoteJob[]): { drafts: JobDraft[]; skipped: number } {
  const drafts: JobDraft[] = [];
  let skipped = 0;
  for (const job of jobs) {
    try {
      const url = new URL(job.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        skipped++;
        continue;
      }
      drafts.push({
        company: job.company?.trim() || target.company,
        title: job.title.trim(),
        location: job.location?.trim() || null,
        url: job.url,
        ats: target.ats as Ats,
        targetId: target.id,
        externalId: job.externalId,
        postedAt: job.postedAt,
      });
    } catch {
      skipped++;
    }
  }
  return { drafts, skipped };
}
