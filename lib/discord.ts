import type { Job } from "./types";

export async function notifyDiscord(jobs: Job[]): Promise<number> {
  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhook || jobs.length === 0) return 0;
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    throw new Error("DISCORD_WEBHOOK_URL is not a URL");
  }
  const hostOk = url.hostname === "discord.com" || url.hostname === "discordapp.com";
  if (url.protocol !== "https:" || !hostOk || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("DISCORD_WEBHOOK_URL must be an https://discord.com/api/webhooks/ URL");
  }
  const shown = jobs.slice(0, 8);
  const extra = jobs.length - shown.length;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      username: "Intern Finder",
      content:
        extra > 0
          ? `${jobs.length} new early-career roles. ${extra} more are in the dashboard.`
          : `${shown.length} new early-career role${shown.length === 1 ? "" : "s"}.`,
      embeds: shown.map((job) => ({
        title: job.title.slice(0, 250),
        url: job.canonicalUrl,
        description: [job.company, job.location, job.roleFamily, job.score === null ? null : `${Math.round(job.score * 100)}`]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 300),
        color: 0x0e6b52,
      })),
    }),
  });
  if (!res.ok) throw new Error(`discord webhook returned ${res.status}`);
  return shown.length;
}
