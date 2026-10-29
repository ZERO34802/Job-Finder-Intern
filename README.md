# Intern Finder

Polls public Greenhouse, Lever, and Workday career boards, sorts titles with a local Qwen model, and keeps a single row when the same role shows up twice. A Next.js dashboard manages boards and tracks applications. Discord gets a webhook for new early-career matches.

The starter list is 18 live boards, not thousands. Add the rest from the dashboard or a CSV. The poller is built to walk a long list: one board at a time, a jittered pause between boards, and a systemd timer that adds a random delay on the Pi.

## Run it on this Mac

```bash
cd ~/impdocuments/Projects/Personal/Intern-Finder
npm install
npm test
npm run seed
npm run dev
```

Open http://127.0.0.1:3000. Load is not required if you already ran `npm run seed`. Poll one board from the Boards page before polling everything. Stripe alone is several hundred jobs.

```bash
npm run poll -- --target lever:spotify --force
npm run poll -- --loop
```

`--loop` is the Mac stand-in for the Pi timer. It sleeps a jittered interval (default 6 hours, ±20%) between cycles.

Titles are classified with rules until Ollama is up. Pull a small Qwen and the next poll upgrades cached rule hits, `CLASSIFY_BUDGET` titles at a time:

```bash
ollama pull qwen2.5:1.5b
```

Copy `.env.example` to `.env` for Discord, Supabase, the model name, or a dashboard password.

## What talks to the network

- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{token}/jobs`
- Lever: `https://api.lever.co/v0/postings/{token}?mode=json`
- Workday: the public `wday/cxs` jobs endpoint on `*.myworkdayjobs.com`, queried for intern, internship, co-op, and new grad
- Ollama on localhost for Qwen
- Discord only if `DISCORD_WEBHOOK_URL` is an `https://discord.com/api/webhooks/...` URL

There is no login bypass and no authenticated scrape. A 403 or 429 is stored on the board and the cycle moves on. One retry follows a 429 or 503.

## Dedupe and the classifier

A role's id is a hash of normalized company + title + location, so Greenhouse and Lever copies of the same posting collapse. Each source URL is kept. Tracking parameters and locale prefixes are stripped from the canonical link.

The classification cache key is the normalized title. SQLite stores it locally. With `STORE=supabase`, the same cache is the `classifications` table from `schema.sql`, which a Pi and the Vercel dashboard can share. Paste that file into the Supabase SQL editor and set `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY` on the server only.

Set `APP_PASSWORD` before putting the dashboard on the internet. Empty means the local app is open.

## Raspberry Pi

```bash
sudo mkdir -p /opt/intern-finder
sudo rsync -a --exclude node_modules --exclude .next --exclude data ./ /opt/intern-finder/
cd /opt/intern-finder && npm install && npm run seed
sudo cp systemd/intern-finder.service systemd/intern-finder.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now intern-finder.timer
```

The timer runs the poll 6 hours after the previous run, then waits a random extra 0–45 minutes (`RandomizedDelaySec`). Point the dashboard at Supabase if it should show the Pi's data from Vercel.

## CSV

`examples/targets.csv` shows the columns: `company,ats,board_token,workday_host,workday_tenant,workday_site`.
