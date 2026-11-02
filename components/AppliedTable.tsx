"use client";

import { Fragment, useState } from "react";
import { isApplied, postedTime, timeAgo } from "@/lib/posted";
import { APPLICATION_STATUSES, REFERRALS, type Application, type ApplicationStatus, type Referral } from "@/lib/types";

type Filter = "all" | ApplicationStatus;

const REFERRAL_LABEL: Record<Referral, string> = { none: "no referral", requested: "requested", referred: "referred" };

// Every tracked application. Status, referral and notes save as soon as they change; rows stay
// put until the page is reloaded so a changed row doesn't jump away mid-edit.
export function AppliedTable({ applications, initialFilter }: { applications: Application[]; initialFilter: Filter }) {
  const [rows, setRows] = useState(applications);
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, string>>({});

  async function save(jobId: string, change: Partial<Pick<Application, "status" | "referral" | "notes">>) {
    setRows((list) => list.map((row) => (row.jobId === jobId ? { ...row, ...change } : row)));
    setState((s) => ({ ...s, [jobId]: "Saving…" }));
    const res = await fetch(`/api/applications/${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setState((s) => ({ ...s, [jobId]: res.ok ? "Saved" : data.error || "Could not save" }));
  }

  async function remove(jobId: string) {
    if (!window.confirm("Stop tracking this application? Its status and notes are deleted.")) return;
    const res = await fetch(`/api/applications/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    if (!res.ok) {
      setState((s) => ({ ...s, [jobId]: "Could not remove" }));
      return;
    }
    setRows((list) => list.filter((row) => row.jobId !== jobId));
  }

  const count = (f: Filter) => rows.filter((row) => (f === "all" ? isApplied(row.status) : row.status === f)).length;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (filter === "all" ? isApplied(row.status) : row.status === filter) &&
      (!needle || `${row.title} ${row.company} ${row.location ?? ""} ${row.notes}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <div className="toolbar plain">
        <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search company, role or notes" />
        <div className="chips">
          {(["all", ...APPLICATION_STATUSES.filter((s) => s !== "saved"), "saved"] as Filter[]).map((f) => (
            <button key={f} type="button" className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All applied" : f} <b>{count(f)}</b>
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        {shown.length === 0 ? (
          <div className="empty">{rows.length === 0 ? "Nothing here yet. Tick Applied on the Jobs page after you apply." : "No applications match."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Posted</th>
                <th>Updated</th>
                <th>Status</th>
                <th>Referral</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const posted = postedTime(row);
                const updated = Date.parse(row.updatedAt);
                const expanded = open === row.jobId;
                return (
                  <Fragment key={row.jobId}>
                    <tr className={expanded ? "open" : undefined}>
                      <td>
                        <a className="title-link" href={row.canonicalUrl} target="_blank" rel="noreferrer">{row.title}</a>
                        <span className="sub">{row.company}{row.location ? ` · ${row.location}` : ""}</span>
                      </td>
                      <td className="when" title={new Date(posted).toLocaleString()}>{timeAgo(posted)}</td>
                      <td className="when" title={new Date(updated).toLocaleString()}>{timeAgo(updated)}</td>
                      <td>
                        <select
                          className="pill-select"
                          data-status={row.status}
                          value={row.status}
                          aria-label="Status"
                          onChange={(event) => void save(row.jobId, { status: event.target.value as ApplicationStatus })}
                        >
                          {APPLICATION_STATUSES.map((item) => (
                            <option key={item} value={item}>{item}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className="pill-select"
                          data-referral={row.referral}
                          value={row.referral}
                          aria-label="Referral"
                          onChange={(event) => void save(row.jobId, { referral: event.target.value as Referral })}
                        >
                          {REFERRALS.map((item) => (
                            <option key={item} value={item}>{REFERRAL_LABEL[item]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="when">
                        <button type="button" className="btn small" onClick={() => setOpen(expanded ? null : row.jobId)}>
                          {expanded ? "Close" : row.notes ? "Notes •" : "Notes"}
                        </button>
                        {state[row.jobId] ? <span className="sub">{state[row.jobId]}</span> : null}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="detail">
                        <td colSpan={6}>
                          <textarea
                            defaultValue={row.notes}
                            placeholder="Notes save when you click away"
                            onBlur={(event) => {
                              if (event.target.value !== row.notes) void save(row.jobId, { notes: event.target.value });
                            }}
                          />
                          <div className="row-actions">
                            <button type="button" className="btn small danger" onClick={() => void remove(row.jobId)}>
                              Stop tracking
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
