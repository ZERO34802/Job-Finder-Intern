import { PollButton } from "@/components/PollButton";
import { isApplied, postedTime, timeAgo } from "@/lib/posted";
import { getStore } from "@/lib/store";
import type { ApplicationStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

function when(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function HomePage() {
  const store = getStore();
  const [stats, found, applications] = await Promise.all([
    store.stats(),
    store.listJobs({ matchOnly: true, order: "newest", limit: 500 }),
    store.listApplications(),
  ]);
  // Matches not yet applied to, newest posting first, as on the Jobs page.
  const appliedIds = new Set(applications.filter((item) => isApplied(item.status)).map((item) => item.jobId));
  const open = found
    .filter((job) => !appliedIds.has(job.id))
    .map((job) => ({ job, posted: postedTime(job) }))
    .sort((a, b) => b.posted - a.posted);
  const jobs = open.slice(0, 8);
  const byStatus = (status: ApplicationStatus) => applications.filter((item) => item.status === status).length;
  const sent = applications.filter((item) => isApplied(item.status)).length;
  const funnel = (["applied", "interviewing", "offer", "rejected", "withdrawn"] as const).map((status) => ({ status, count: byStatus(status) }));
  return (
    <main>
      <p className="lede">
        Polls public Greenhouse, Lever, and Workday boards for internships. A match is a Summer 2027 software, ML, or data internship in the US that is open to undergrad or master&apos;s students.
      </p>
      <section className="stats">
        <a className="stat" href="/jobs"><b>{open.length}</b><span>matches not applied to yet</span></a>
        <a className="stat" href="/applied"><b>{sent}</b><span>applications sent</span></a>
        <a className="stat" href="/applied?status=interviewing"><b>{byStatus("interviewing")}</b><span>interviewing</span></a>
        <a className="stat" href="/applied?status=offer"><b>{byStatus("offer")}</b><span>offers</span></a>
      </section>
      {sent > 0 ? (
        <section className="panel">
          <div className="funnel" aria-label="Applications by status">
            {funnel.filter((item) => item.count > 0).map((item) => (
              <span key={item.status} data-status={item.status} style={{ flexGrow: item.count }} title={`${item.count} ${item.status}`} />
            ))}
          </div>
          <div className="legend">
            {funnel.map((item) => (
              <a key={item.status} href={`/applied?status=${item.status}`} data-status={item.status}>
                <i />{item.status} <b>{item.count}</b>
              </a>
            ))}
          </div>
        </section>
      ) : null}
      <div className="toolbar plain">
        <PollButton label="Poll all boards" primary />
        <span className="sub">{stats.targetsEnabled} of {stats.targets} boards enabled · {stats.jobs} roles stored · {stats.matches} matches</span>
      </div>
      <div className="split">
        <section className="table-wrap">
          {jobs.length === 0 ? (
            <div className="empty">No open matches right now. New ones are alerted on Discord.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Newest matches</th>
                  <th>Posted</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(({ job, posted }) => (
                  <tr key={job.id}>
                    <td>
                      <a className="title-link" href={job.canonicalUrl} target="_blank" rel="noreferrer">{job.title}</a>
                      <span className="sub">{job.company}{job.location ? ` · ${job.location}` : ""} · {job.roleFamily}</span>
                    </td>
                    <td className="when" title={new Date(posted).toLocaleString()}>{timeAgo(posted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="panel stack">
          <strong>Recent polls</strong>
          {stats.recentRuns.length === 0 ? <span className="sub">No polls yet.</span> : null}
          {stats.recentRuns.map((run) => (
            <span key={`${run.targetId}-${run.startedAt}`} className="sub">
              {when(run.finishedAt)} · {run.targetId} · {run.error ? run.error : `${run.jobsNew} new / ${run.jobsSeen} seen`}
            </span>
          ))}
        </section>
      </div>
    </main>
  );
}
