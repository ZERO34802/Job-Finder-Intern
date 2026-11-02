"use client";

import { useState } from "react";
import type { Application, ApplicationStatus, Referral } from "@/lib/types";
import { APPLICATION_STATUSES, REFERRALS } from "@/lib/types";

export function ApplicationTable({ applications }: { applications: Application[] }) {
  const [error, setError] = useState("");

  async function save(jobId: string, status: ApplicationStatus, referral: Referral, notes: string) {
    setError("");
    const res = await fetch(`/api/applications/${jobId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, referral, notes }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(data.error || "Could not save");
      return;
    }
    window.location.reload();
  }

  async function remove(jobId: string) {
    const res = await fetch(`/api/applications/${jobId}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not remove");
      return;
    }
    window.location.reload();
  }

  if (applications.length === 0) {
    return <div className="empty">Nothing tracked yet. Open Jobs and track a role.</div>;
  }

  return (
    <div className="table-wrap">
      {error ? <p className="note">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Status</th>
            <th>Referral</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => (
            <ApplicationRow key={application.jobId} application={application} onSave={save} onRemove={remove} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApplicationRow({
  application,
  onSave,
  onRemove,
}: {
  application: Application;
  onSave: (jobId: string, status: ApplicationStatus, referral: Referral, notes: string) => void;
  onRemove: (jobId: string) => void;
}) {
  const [status, setStatus] = useState(application.status);
  const [referral, setReferral] = useState(application.referral);
  const [notes, setNotes] = useState(application.notes);
  return (
    <tr>
      <td>
        <a className="title-link" href={application.canonicalUrl} target="_blank" rel="noreferrer">
          {application.title}
        </a>
        <span className="sub">{application.company}</span>
      </td>
      <td>
        <select value={status} onChange={(event) => setStatus(event.target.value as ApplicationStatus)}>
          {APPLICATION_STATUSES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select value={referral} onChange={(event) => setReferral(event.target.value as Referral)}>
          {REFERRALS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </td>
      <td>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
      </td>
      <td>
        <div className="row-actions">
          <button className="btn primary" type="button" onClick={() => onSave(application.jobId, status, referral, notes)}>
            Save
          </button>
          <button className="btn danger" type="button" onClick={() => onRemove(application.jobId)}>
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}
