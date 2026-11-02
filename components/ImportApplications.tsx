"use client";

import { useState } from "react";
import type { ImportPlan } from "@/lib/importApplications";
import { APPLICATION_STATUSES, REFERRALS, type ApplicationStatus, type Referral } from "@/lib/types";

type Result = { saved: number; newJobs: number; unchanged: number };

async function send(body: unknown): Promise<{ plan: ImportPlan; result?: Result }> {
  const res = await fetch("/api/applications/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { plan?: ImportPlan; result?: Result; error?: string };
  if (!res.ok || !data.plan) throw new Error(data.error || "Could not import");
  return { plan: data.plan, result: data.result };
}

// Paste rows copied from the tracking sheet, preview what happens, then import.
// Pasting the same rows again updates them instead of adding duplicates.
export function ImportApplications() {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function preview() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setPlan((await send({ text })).plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the rows");
    }
    setBusy(false);
  }

  async function commit() {
    setBusy(true);
    setError("");
    try {
      const { result } = await send({ text, commit: true });
      setMessage(`Saved ${result?.saved ?? 0} applications (${result?.newJobs ?? 0} new jobs added, ${result?.unchanged ?? 0} already up to date).`);
      setPlan(null);
      setText("");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import");
    }
    setBusy(false);
  }

  const count = (action: string) => plan?.rows.filter((row) => row.action === action).length ?? 0;
  const changed = plan?.rows.filter((row) => row.action !== "already tracked" || row.changes.length > 0).length ?? 0;

  return (
    <details className="panel">
      <summary>Import from your sheet</summary>
      <p className="sub">
        In Google Sheets, select the rows (columns Company, Role, Job Link, Application Status, Date, JD, Result), copy them, and
        paste them here. Rows already imported are matched by their link and updated, never duplicated.
      </p>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste rows here" rows={6} />
      <div className="row-actions">
        <button className="btn" type="button" disabled={busy || !text.trim()} onClick={() => void preview()}>
          Preview
        </button>
        {plan ? (
          <button className="btn primary" type="button" disabled={busy || changed === 0} onClick={() => void commit()}>
            Import {changed}
          </button>
        ) : null}
      </div>
      {error ? <p className="note">{error}</p> : null}
      {message ? <p className="ok">{message}</p> : null}
      {plan ? (
        <>
          <p className="sub">
            {count("matched job")} jobs Intern Finder already knows · {count("new job")} new jobs to add ·{" "}
            {count("already tracked")} already tracked ({changed - count("matched job") - count("new job")} with changes) ·{" "}
            {plan.skipped.length} skipped
          </p>
          <div className="table-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Referral</th>
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => (
                  <tr key={row.url}>
                    <td>
                      {row.title}
                      <span className="sub">{row.company}{row.notes ? ` · ${row.notes.replace(/\n/g, " · ")}` : ""}</span>
                    </td>
                    <td>{row.status}</td>
                    <td>{row.referral === "none" ? "" : row.referral}</td>
                    <td>{row.action === "already tracked" ? row.changes.join(", ") || "no change" : row.action}</td>
                  </tr>
                ))}
                {plan.skipped.map((row, i) => (
                  <tr key={`skip-${i}`}>
                    <td>{row.line}</td>
                    <td colSpan={3}>skipped: {row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </details>
  );
}

// One application typed in by hand, for a job Intern Finder never found.
export function AddApplication() {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<ApplicationStatus>("applied");
  const [referral, setReferral] = useState<Referral>("none");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setBusy(true);
    setError("");
    try {
      await send({ rows: [{ company, role, link, status, referral, notes }], commit: true });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    }
    setBusy(false);
  }

  return (
    <details className="panel">
      <summary>Add an application</summary>
      <div className="form-grid" style={{ flexWrap: "wrap" }}>
        <label>
          Company
          <input value={company} onChange={(event) => setCompany(event.target.value)} />
        </label>
        <label>
          Role
          <input value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <label>
          Job link
          <input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as ApplicationStatus)}>
            {APPLICATION_STATUSES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Referral
          <select value={referral} onChange={(event) => setReferral(event.target.value as Referral)}>
            {REFERRALS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <input value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <button className="btn primary" type="button" disabled={busy || !company.trim() || !link.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      {error ? <p className="note">{error}</p> : null}
    </details>
  );
}
