import type { Ats, JobDraft, Target } from "./types";
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

export async function fetchTargetJobs(target: Target): Promise<RemoteJob[]> {
  if (target.ats === "greenhouse") {
    if (!target.boardToken) throw new Error("greenhouse target is missing a board token");
    return fetchGreenhouse(target.boardToken);
  }
  if (target.ats === "lever") {
    if (!target.boardToken) throw new Error("lever target is missing a board token");
    return fetchLever(target.boardToken);
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
