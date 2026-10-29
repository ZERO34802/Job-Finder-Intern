import { TrackButton } from "@/components/TrackButton";
import { ROLE_FAMILIES } from "@/lib/types";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

function last(value: string | string[] | undefined, fallback = ""): string {
  if (Array.isArray(value)) return value[value.length - 1] ?? fallback;
  return value ?? fallback;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; family?: string | string[]; early?: string | string[] }>;
}) {
  const params = await searchParams;
  const q = last(params.q);
  const family = last(params.family);
  const early = last(params.early, "1") === "1";
  const jobs = await getStore().listJobs({
    q,
    family: family || undefined,
    earlyOnly: early,
    limit: 150,
  });
  return (
    <main>
      <p className="lede">Early-career rows are internships and new-grad titles. Score is 0–100 from the classifier. The same company, title, and location collapse to one row, with each source URL kept.</p>
      <form className="toolbar" action="/jobs">
        <input name="q" defaultValue={q} placeholder="Title or company" />
        <select name="family" defaultValue={family}>
          <option value="">All families</option>
          {ROLE_FAMILIES.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <input type="hidden" name="early" value="0" />
        <label className="row-actions">
          <input type="checkbox" name="early" value="1" defaultChecked={early} />
          Early career only
        </label>
        <button className="btn" type="submit">Filter</button>
      </form>
      <div className="table-wrap">
        {jobs.length === 0 ? (
          <div className="empty">No roles match. Poll a board or clear the filter.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Family</th>
                <th>Score</th>
                <th>Sources</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <a className="title-link" href={job.canonicalUrl} target="_blank" rel="noreferrer">{job.title}</a>
                    <span className="sub">{job.company}{job.location ? ` · ${job.location}` : ""}</span>
                  </td>
                  <td><span className="pill neutral">{job.roleFamily ?? "unsorted"}</span></td>
                  <td>{job.score === null ? "—" : Math.round(job.score * 100)}</td>
                  <td>{job.sourceUrls.length}</td>
                  <td><TrackButton jobId={job.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
