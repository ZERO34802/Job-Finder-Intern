import type {
  Classification,
  Degree,
  Job,
  JobEvaluation,
  LocationVerdict,
  RoleFamily,
  Season,
  Seniority,
  Store,
} from "./types";
import { ROLE_FAMILIES, TARGET_FAMILIES } from "./types";
import { titleCacheKey } from "./canonicalize";
import { envInt } from "./jitter";
import { askJson, llmProviders, type LlmProvider } from "./llm";

type TitleVerdict = Omit<Classification, "cacheKey" | "title">;

const INTERN_RE = /\b(intern|internship|interns|co-op|coop|co op)\b/i;
const NEW_GRAD_RE = /\b(new grad|new graduate|university graduate|early career)\b/i;

const FAMILIES: Array<[RegExp, RoleFamily]> = [
  [/\b(machine learning|\bml\b|ml engineer|deep learning|\bllm\b|\bai\b|genai|applied scientist|data scientist|data science|\bnlp\b|computer vision|ai research)\b/i, "ml"],
  [/\b(data engineer|data analyst|analytics|business intelligence|\betl\b)\b/i, "data"],
  [/\b(hardware|asic|fpga|silicon|electrical|mechanical|chip design|verification engineer)\b/i, "hardware"],
  [/\b(quant|quantitative|trading|trader)\b/i, "quant"],
  [/\b(product manager|product management|\bapm\b)\b/i, "product"],
  [/\b(designer|design|\bux\b|\bui\b)\b/i, "design"],
  [/\bresearch\b/i, "research"],
  [/\b(software|\bswe\b|backend|front[\s-]?end|full[\s-]?stack|android|\bios\b|platform|infrastructure|developer|devops|\bsre\b|security engineer|engineer)\b/i, "swe"],
];

const HIGH_SCHOOL_RE = /\bhigh school\b/i;
const AI_RESEARCH_RE =
  /\b(ai|machine learning|learning|neural|vision|robot\w*|world models?|spatial intelligence|differentiable|simulation|autonomous|generative|genai|llm|nlp|perception|multi-?modal)\b/i;

// Titles that name the job outright; the model is not consistent on some of these.
const NAMED_ROLES: Array<[RegExp, RoleFamily]> = [
  [/\b(machine learning|data scien\w*)\b/i, "ml"],
  [/\bdata engineer/i, "data"],
  [/\b(software (engineer|developer)\w*|security engineer\w*)\b/i, "swe"],
];

// Hard rules that override any model label: high school programs are out,
// research titles with AI terms are ML research, and named roles keep their family.
function refine(title: string, family: RoleFamily, isIntern: boolean): { family: RoleFamily; isIntern: boolean } {
  const named = NAMED_ROLES.find(([re]) => re.test(title))?.[1];
  let refined = family;
  if (named && !TARGET_FAMILIES.includes(family)) refined = named;
  else if (family === "research" && AI_RESEARCH_RE.test(title)) refined = "ml";
  return { family: refined, isIntern: isIntern && !HIGH_SCHOOL_RE.test(title) };
}

// Only intern-looking titles are stored; everything else on a board is skipped.
export function isCandidateTitle(title: string): boolean {
  return INTERN_RE.test(title);
}

export function ruleSeason(title: string): Season {
  const t = title.toLowerCase();
  if (/summer\W*(20)?27\b|\b2027\W*summer/.test(t)) return "summer_2027";
  if (/\b2026\b|summer\W*(20)?26\b/.test(t)) return "other";
  // "Summer or Winter" still includes summer.
  if (/\b(fall|autumn|spring|winter)\b/.test(t) && !/\bsummer\b/.test(t)) return "other";
  if (/\b2027\b/.test(t)) return "summer_2027";
  return "unspecified";
}

export function ruleDegree(title: string): Degree {
  const lower = /\b(master'?s?|ms|m\.s\.|bs|b\.s\.|bachelor'?s?|undergrad\w*)\b/i.test(title);
  if (lower) return "any";
  if (/\b(ph\.?\s?d|doctoral)\b/i.test(title)) return "phd_only";
  if (/\bMBA\b/.test(title)) return "mba_only";
  return "any";
}

export function ruleClassify(title: string): TitleVerdict {
  const { family, isIntern } = refine(title, FAMILIES.find(([re]) => re.test(title))?.[1] ?? "other", INTERN_RE.test(title));
  const newGrad = NEW_GRAD_RE.test(title);
  const seniority: Seniority = isIntern ? "intern" : newGrad ? "new_grad" : "other";
  const technical = TARGET_FAMILIES.includes(family);
  let score = 0.08;
  if (isIntern && technical) score = 0.9;
  else if (isIntern) score = 0.4;
  else if (newGrad && technical) score = 0.3;
  const reason = isIntern ? `title matches intern and ${family}` : `no intern marker, family ${family}`;
  return { isIntern, roleFamily: family, seniority, season: ruleSeason(title), degree: ruleDegree(title), score, reason, model: "rules" };
}

const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const US_CODE_RE = new RegExp(`(,|^|\\s|-)\\s*(${US_STATE_CODES})(\\b|$)`);
const US_UPPER_RE = /\b(US|USA|U\.S\.A?\.?)\b/;
const US_WORD_RE =
  /\b(united states|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|nyc|san francisco|seattle|austin|boston|chicago|los angeles|san jose|palo alto|mountain view|menlo park|sunnyvale|santa clara|redmond|bellevue|denver|atlanta|miami|dallas|houston|pittsburgh|philadelphia|arlington|raleigh|san diego|irvine|minneapolis|detroit|salt lake city|honolulu)\b/i;
const NON_US_RE =
  /\b(canada|toronto|vancouver|montreal|ottawa|waterloo|calgary|mexico|brazil|s[aã]o paulo|london|united kingdom|uk|england|scotland|ireland|dublin|france|paris|germany|berlin|munich|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|switzerland|zurich|sweden|stockholm|poland|warsaw|krakow|india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|singapore|japan|tokyo|korea|seoul|china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|australia|sydney|melbourne|israel|tel aviv|uae|dubai|emea|apac|europe|latam|philippines|manila|vietnam|argentina|buenos aires|colombia|bogot[aá]|chile|costa rica|romania|bucharest|portugal|lisbon|denmark|copenhagen|norway|oslo|finland|helsinki|belgium|brussels|austria|vienna|czech|prague|hungary|budapest|greece|athens|turkey|istanbul|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|new zealand|auckland)\b/i;

// True if any listed place is in the US, false if every place is outside it, null if unclear.
export function ruleUs(location: string | null): boolean | null {
  if (!location?.trim()) return null;
  const parts = location.split(/;|\||\/|\n| or /).map((part) => part.trim()).filter(Boolean);
  let allForeign = parts.length > 0;
  for (const part of parts) {
    const foreign = NON_US_RE.test(part);
    if (!foreign && (US_CODE_RE.test(part) || US_UPPER_RE.test(part) || US_WORD_RE.test(part))) return true;
    if (!foreign) allForeign = false;
  }
  return allForeign ? false : null;
}

export function evaluate(id: string, title: TitleVerdict, us: boolean | null): JobEvaluation {
  const misses: string[] = [];
  if (!title.isIntern) misses.push("not an internship");
  if (!TARGET_FAMILIES.includes(title.roleFamily)) misses.push(`family ${title.roleFamily}`);
  if (title.degree === "phd_only") misses.push("PhD only");
  if (title.degree === "mba_only") misses.push("MBA only");
  if (title.season === "other") misses.push("not Summer 2027");
  if (us === false) misses.push("outside the US");
  const match = misses.length === 0;
  return {
    id,
    isIntern: title.isIntern,
    roleFamily: title.roleFamily,
    seniority: title.seniority,
    season: title.season,
    degree: title.degree,
    us,
    match,
    score: match ? title.score : Math.min(title.score, 0.2),
    reason: (match ? title.reason : misses.join(", ")).slice(0, 240),
    model: title.model,
  };
}

// Season and degree are written in the title, so rules read them; the model only
// judges what the role is.
const TITLE_SYSTEM = `You label job titles for a student who wants software, machine learning, or data internships.
For each numbered title return {"i": number, "intern": boolean, "family": string, "fit": number}:
- intern: true for an internship or co-op for university students; false for full-time roles, high school programs, and words like "internal"
- family, judged by the main daily work:
  swe: building software (backend, frontend, mobile, infrastructure, security engineering, compilers, GPU or math libraries, developer tools, forward deployed or solutions engineering that writes code)
  ml: machine learning, AI, deep learning, data science, and AI research (computer vision, robotics learning, world models, simulation for AI, autonomous driving perception or planning)
  data: data engineering, analytics engineering, data analyst roles whose main work is data
  research: research outside AI (user research, physics, biology)
  hardware: chips, ASIC, physical design, electrical, computer architecture, systems hardware
  quant: quant research, trading, investment
  product: product management, program management
  design: product, UX, or visual design, illustration
  other: finance, risk, fraud, operations, people or HR analytics, audit, tax, sales, strategy, policy, and anything else
- fit: 0 to 1, how well it fits a software, ML, or data internship
Reply with JSON only: {"results": [...]}`;

const LOCATION_SYSTEM = `For each numbered job location, decide whether the job can be done in the United States.
us: true if any listed place is in the US (including "Remote - US" or "Remote - Americas"), false if every place is outside the US, null if it cannot be told.
Reply with JSON only: {"results": [{"i": 1, "us": true}]}`;

function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
}

function resultsOf(data: unknown): Array<Record<string, unknown>> {
  const results = (data as { results?: unknown })?.results;
  return Array.isArray(results) ? (results.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>) : [];
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

async function llmTitles(titles: string[], providers: LlmProvider[]): Promise<Array<TitleVerdict | null>> {
  const out: Array<TitleVerdict | null> = titles.map(() => null);
  for (let start = 0; start < titles.length; start += 20) {
    const batch = titles.slice(start, start + 20);
    const answer = await askJson(providers, TITLE_SYSTEM, numbered(batch));
    if (!answer) break;
    for (const row of resultsOf(answer.data)) {
      const i = Number(row.i) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= batch.length || typeof row.intern !== "boolean") continue;
      const fit = typeof row.fit === "number" ? Math.min(1, Math.max(0, row.fit)) : 0.5;
      const { family, isIntern } = refine(batch[i], pick(ROLE_FAMILIES, row.family, "other"), row.intern);
      out[start + i] = {
        isIntern,
        roleFamily: family,
        seniority: isIntern ? "intern" : "other",
        season: ruleSeason(batch[i]),
        degree: ruleDegree(batch[i]),
        score: fit,
        reason: `${family} internship`,
        model: answer.model,
      };
    }
  }
  return out;
}

async function llmLocations(locations: string[], providers: LlmProvider[]): Promise<Array<LocationVerdict | null>> {
  const out: Array<LocationVerdict | null> = locations.map(() => null);
  for (let start = 0; start < locations.length; start += 40) {
    const batch = locations.slice(start, start + 40);
    const answer = await askJson(providers, LOCATION_SYSTEM, numbered(batch));
    if (!answer) break;
    for (const row of resultsOf(answer.data)) {
      const i = Number(row.i) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= batch.length) continue;
      const us = row.us === true ? true : row.us === false ? false : null;
      out[start + i] = { cacheKey: titleCacheKey(batch[i]), location: batch[i], us, model: answer.model };
    }
  }
  return out;
}

// Labels jobs that have not been judged yet (and re-judges rule-only ones once a model is
// available), then stores a match verdict per job. Returns how many jobs were evaluated.
export async function evaluateJobs(store: Store, limit: number, providersIn?: LlmProvider[]): Promise<number> {
  const providers = providersIn ?? (await llmProviders());
  const jobs: Job[] = await store.jobsNeedingEvaluation({ limit, upgradeRules: providers.length > 0 });
  if (jobs.length === 0) return 0;

  const titleByKey = new Map<string, string>();
  for (const job of jobs) if (job.titleKey && !titleByKey.has(job.titleKey)) titleByKey.set(job.titleKey, job.title);
  const titles = await store.getClassifications([...titleByKey.keys()]);
  const stale = [...titleByKey.keys()].filter((key) => {
    const hit = titles.get(key);
    return !hit || (hit.model === "rules" && providers.length > 0);
  });
  const budget = Math.max(0, envInt("CLASSIFY_BUDGET", 300));
  const asked = providers.length > 0 ? await llmTitles(stale.slice(0, budget).map((key) => titleByKey.get(key)!), providers) : [];
  const fresh: Classification[] = [];
  stale.forEach((key, i) => {
    const title = titleByKey.get(key)!;
    const verdict = asked[i] ?? (titles.has(key) ? null : ruleClassify(title));
    if (!verdict) return;
    const row = { ...verdict, cacheKey: key, title };
    titles.set(key, row);
    fresh.push(row);
  });
  await store.putClassifications(fresh);

  // Some boards put the city in the title ("... Intern (2027) - Lisbon, PT") and only
  // "In-Office" in the location, so the title is checked when the location is unclear.
  const usByRules = (job: Job) => ruleUs(job.location) ?? ruleUs(job.title);
  const unclear = new Map<string, string>();
  for (const job of jobs) {
    if (job.location && usByRules(job) === null) unclear.set(titleCacheKey(job.location), job.location);
  }
  const places = await store.getLocations([...unclear.keys()]);
  const unknown = [...unclear.keys()].filter((key) => !places.has(key));
  if (providers.length > 0 && unknown.length > 0) {
    const answers = (await llmLocations(unknown.map((key) => unclear.get(key)!), providers)).filter(
      (row): row is LocationVerdict => row !== null,
    );
    await store.putLocations(answers);
    for (const row of answers) places.set(row.cacheKey, row);
  }

  const rows: JobEvaluation[] = [];
  for (const job of jobs) {
    const title = titles.get(job.titleKey);
    if (!title) continue;
    const ruled = usByRules(job);
    const us = ruled ?? (job.location ? places.get(titleCacheKey(job.location))?.us ?? null : null);
    rows.push(evaluate(job.id, title, us));
  }
  await store.saveEvaluations(rows);
  return rows.length;
}
