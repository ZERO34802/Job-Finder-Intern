"use client";

import { useState, type ReactNode } from "react";

// A jobs-list row with an "Applied" checkbox. Ticking it marks the job applied and the row
// leaves the list at once; it then lives on the Applied page.
export function AppliedRow({ jobId, children }: { jobId: string; children: ReactNode }) {
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function apply() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, status: "applied" }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not save");
      return;
    }
    setMoved(true);
  }

  return (
    <tr hidden={moved}>
      {children}
      <td className="check">
        <input type="checkbox" checked={false} disabled={busy} aria-label="Mark applied" onChange={() => void apply()} />
        {error ? <span className="sub">{error}</span> : null}
      </td>
    </tr>
  );
}
