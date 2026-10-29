import type { Classification, RoleFamily, Seniority } from "./types";
import { ROLE_FAMILIES, SENIORITIES } from "./types";
import { titleCacheKey } from "./canonicalize";
import { envInt } from "./jitter";

const INTERN_RE = /\b(intern|internship|interns|co-op|coop|co op)\b/i;
const NEW_GRAD_RE = /\b(new grad|new graduate|university graduate|early career)\b/i;

const FAMILIES: Array<[RegExp, RoleFamily]> = [
  [/\b(machine learning|\bml\b|ml engineer|deep learning|\bllm\b|applied scientist|data scientist|data science|\bnlp\b|ai research)\b/i, "ml"],
  [/\b(data engineer|data analyst|analytics|business intelligence|\betl\b)\b/i, "data"],
  [/\b(product manager|product management|\bapm\b)\b/i, "product"],
  [/\b(designer|design|\bux\b|\bui\b)\b/i, "design"],
  [/\bresearch\b/i, "research"],
  [/\b(software|\bswe\b|backend|front[\s-]?end|full[\s-]?stack|android|\bios\b|platform|infrastructure|developer|devops|\bsre\b|security engineer)\b/i, "swe"],
];

// Only intern-looking titles are stored; everything else on a board is skipped.
export function isCandidateTitle(title: string): boolean {
  return INTERN_RE.test(title);
}

export function ruleClassify(title: string): Omit<Classification, "cacheKey" | "title"> {
  const isIntern = INTERN_RE.test(title);
  const newGrad = NEW_GRAD_RE.test(title);
  const family = FAMILIES.find(([re]) => re.test(title))?.[1] ?? "other";
  const seniority: Seniority = isIntern ? "intern" : newGrad ? "new_grad" : "other";
  const technical = family === "swe" || family === "ml" || family === "data" || family === "research";
  let score = 0.08;
  if (isIntern && technical) score = 0.92;
  else if (isIntern && (family === "product" || family === "design")) score = 0.7;
  else if (isIntern) score = 0.5;
  else if (newGrad && technical) score = 0.74;
  else if (newGrad) score = 0.4;
  const reason = isIntern
    ? `title matches intern and ${family}`
    : newGrad
      ? `title matches new grad and ${family}`
      : `no early-career marker, family ${family}`;
  return { isIntern, roleFamily: family, seniority, score, reason, model: "rules" };
}

type OllamaState = { ok: true; model: string; url: string } | { ok: false; model: string; reason: string };

let ollamaCache: { at: number; state: OllamaState } | null = null;

export async function ollamaStatus(): Promise<OllamaState> {
  const now = Date.now();
  if (ollamaCache && now - ollamaCache.at < 30_000) return ollamaCache.state;
  const url = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL || "qwen2.5:1.5b";
  let state: OllamaState;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) state = { ok: false, model, reason: `ollama returned ${res.status}` };
    else {
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map((item) => item.name ?? "");
      const present = names.some((name) => name === model || name.startsWith(`${model}:`) || model.startsWith(name));
      state = present
        ? { ok: true, model, url }
        : { ok: false, model, reason: `${model} is not pulled` };
    }
  } catch {
    state = { ok: false, model, reason: "ollama is not running" };
  }
  ollamaCache = { at: now, state };
  return state;
}

export function clearOllamaCache(): void {
  ollamaCache = null;
}

function asFamily(value: unknown): RoleFamily {
  return ROLE_FAMILIES.includes(value as RoleFamily) ? (value as RoleFamily) : "other";
}

function asSeniority(value: unknown): Seniority {
  return SENIORITIES.includes(value as Seniority) ? (value as Seniority) : "other";
}

async function qwenClassify(title: string, endpoint: string, model: string): Promise<Omit<Classification, "cacheKey" | "title">> {
  const res = await fetch(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content:
            "You sort job titles for an internship search. Reply with JSON only, no markdown. Fields: is_intern (boolean), role_family (swe|ml|data|research|product|design|other), seniority (intern|new_grad|other), score (number from 0 to 1, higher means a software, ML, or data internship or new-grad role), reason (short string).",
        },
        { role: "user", content: `Title: ${title}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const raw = (body.message?.content ?? "").trim().replace(/^```json\s*|```$/g, "");
  const parsed = JSON.parse(raw) as {
    is_intern?: unknown;
    role_family?: unknown;
    seniority?: unknown;
    score?: unknown;
    reason?: unknown;
  };
  const score = typeof parsed.score === "number" ? Math.min(1, Math.max(0, parsed.score)) : 0;
  return {
    isIntern: parsed.is_intern === true,
    roleFamily: asFamily(parsed.role_family),
    seniority: asSeniority(parsed.seniority),
    score,
    reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 240) : "qwen classification",
    model,
  };
}

// Returns the cache keys that were written this call.
export async function classifyTitles(
  titles: string[],
  loadMany: (keys: string[]) => Promise<Map<string, Classification>>,
  save: (row: Classification) => Promise<void>,
): Promise<string[]> {
  const display = new Map<string, string>();
  for (const title of titles) {
    const key = titleCacheKey(title);
    if (key && !display.has(key)) display.set(key, title.trim());
  }
  const ollama = await ollamaStatus();
  const cached = await loadMany([...display.keys()]);
  const pending: string[] = [];
  for (const key of display.keys()) {
    const hit = cached.get(key);
    if (!hit) pending.push(key);
    else if (hit.model === "rules" && ollama.ok) pending.push(key);
  }
  if (pending.length === 0) return [];

  const wrote: string[] = [];
  if (!ollama.ok) {
    for (const key of pending) {
      const title = display.get(key)!;
      const row = ruleClassify(title);
      await save({ ...row, cacheKey: key, title, model: "rules" });
      wrote.push(key);
    }
    return wrote;
  }

  const budget = Math.max(1, envInt("CLASSIFY_BUDGET", 25));
  for (const key of pending.slice(0, budget)) {
    const title = display.get(key)!;
    let row: Omit<Classification, "cacheKey" | "title">;
    try {
      row = await qwenClassify(title, ollama.url, ollama.model);
    } catch {
      row = ruleClassify(title);
    }
    await save({ ...row, cacheKey: key, title });
    wrote.push(key);
  }
  return wrote;
}
