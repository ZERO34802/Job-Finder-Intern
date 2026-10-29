import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJobUrl, companyKey, dedupeKey, postingKey, titleCacheKey } from "../lib/canonicalize";
import { evaluate, evaluateJobs, isCandidateTitle, ruleClassify, ruleDegree, ruleSeason, ruleUs } from "../lib/classify";
import { parseCsv } from "../lib/csv";
import { jitteredMs } from "../lib/jitter";
import { buildLanes } from "../lib/poll";
import { boardFromUrl } from "../lib/sources";
import { importTargets, seedStarter } from "../lib/seed";
import { createSqliteStore } from "../lib/sqlite-store";
import type { Target } from "../lib/types";

// Keep tests off the network: no Groq key, and an Ollama URL nothing listens on.
delete process.env.GROQ_API_KEY;
process.env.OLLAMA_URL = "http://127.0.0.1:9";

test("canonical urls drop tracking params, locale, and www", () => {
  const url = canonicalJobUrl(
    "http://www.NVIDIA.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Santa-Clara/Software-Intern_JR1/?utm_source=x&gh_jid=12",
  );
  assert.equal(
    url,
    "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Santa-Clara/Software-Intern_JR1?gh_jid=12",
  );
});

test("company and title keys collapse punctuation", () => {
  assert.equal(companyKey("Stripe, Inc."), "stripe");
  assert.equal(titleCacheKey("Software  Engineering Intern!"), "software engineering intern");
  assert.equal(
    dedupeKey("Stripe, Inc.", "Software Engineering Intern", "Remote"),
    dedupeKey("stripe", "software engineering intern", "remote"),
  );
});

test("jitter stays inside the requested band", () => {
  for (let i = 0; i < 50; i++) {
    const value = jitteredMs(1000, 0.2);
    assert.ok(value >= 800 && value <= 1200, String(value));
  }
  assert.equal(jitteredMs(1000, 0), 1000);
});

test("rules sort internship titles and leave senior roles alone", () => {
  const intern = ruleClassify("Software Engineering Intern");
  assert.equal(intern.isIntern, true);
  assert.equal(intern.roleFamily, "swe");
  assert.ok(intern.score >= 0.85);
  const ml = ruleClassify("Data Science Intern");
  assert.equal(ml.roleFamily, "ml");
  const grad = ruleClassify("New Grad, Machine Learning Engineer");
  assert.equal(ruleClassify("Hardware Engineering Intern").roleFamily, "hardware");
  assert.equal(ruleClassify("Research Intern, World Models and Synthetic Data").roleFamily, "ml");
  assert.equal(ruleClassify("User Research Intern").roleFamily, "research");
  assert.equal(ruleClassify("Information Security Engineer, Internship").roleFamily, "swe");
  assert.equal(grad.seniority, "new_grad");
  assert.equal(grad.isIntern, false);
  const senior = ruleClassify("Senior Staff Engineer");
  assert.equal(senior.isIntern, false);
  assert.equal(senior.seniority, "other");
  assert.ok(senior.score < 0.2);
  assert.equal(ruleClassify("Internal Communications Manager").isIntern, false);
});

test("csv parser keeps quoted commas", () => {
  const rows = parseCsv('company,ats\n"Stripe, Inc.",greenhouse\n');
  assert.deepEqual(rows, [
    ["company", "ats"],
    ["Stripe, Inc.", "greenhouse"],
  ]);
});

test("sqlite dedupes the same role across urls and caches a classification", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intern-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  const added = await seedStarter(store);
  assert.ok(added >= 18);
  assert.equal(await seedStarter(store), 0);

  const target = await store.getTarget("greenhouse:stripe");
  assert.ok(target);
  const first = await store.upsertJobs([
    {
      company: "Stripe, Inc.",
      title: "Software Engineering Intern",
      location: "Remote",
      url: "https://stripe.com/jobs/search?gh_jid=1&utm_source=board",
      ats: "greenhouse",
      targetId: target.id,
      externalId: "1",
      postedAt: null,
    },
  ]);
  const second = await store.upsertJobs([
    {
      company: "stripe",
      title: "Software Engineering Intern",
      location: "Remote",
      url: "https://jobs.lever.co/stripe/abc",
      ats: "lever",
      targetId: "lever:stripe",
      externalId: "abc",
      postedAt: null,
    },
  ]);
  assert.equal(first.insertedIds.length, 1);
  assert.equal(second.insertedIds.length, 0);
  const jobs = await store.listJobs({ q: "Software Engineering" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceUrls.length, 2);
  assert.match(jobs[0].canonicalUrl, /gh_jid=1$/);

  assert.equal(await evaluateJobs(store, 100, []), 1);
  const classified = await store.listJobs({ matchOnly: true, limit: 10 });
  assert.equal(classified.length, 1);
  assert.equal(classified[0].isIntern, true);
  assert.equal(classified[0].us, null);
  assert.equal(classified[0].classifyModel, "rules");
  assert.equal(await evaluateJobs(store, 100, []), 0);

  const app = await store.upsertApplication({ jobId: classified[0].id, status: "applied", notes: "referral" });
  assert.equal(app.status, "applied");
  assert.equal((await store.listApplications()).length, 1);

  const imported = await importTargets(store, "company,ats,board_token\nNot A Board,greenhouse,bad token\nLinear,greenhouse,linear\n");
  assert.equal(imported.added, 1);
  assert.equal(imported.errors.length, 1);
  assert.ok(await store.getTarget("greenhouse:linear"));
});

test("only intern titles are kept as candidates", () => {
  assert.equal(isCandidateTitle("Software Engineer Intern, Summer 2027"), true);
  assert.equal(isCandidateTitle("Machine Learning Co-op"), true);
  assert.equal(isCandidateTitle("Internal Tools Engineer"), false);
  assert.equal(isCandidateTitle("Senior Software Engineer"), false);
});

test("lanes split shared hosts and keep each workday tenant alone", () => {
  const make = (id: string, ats: Target["ats"], workdayHost: string | null = null): Target => ({
    id,
    company: id,
    ats,
    boardToken: ats === "workday" ? null : id,
    workdayHost,
    workdayTenant: null,
    workdaySite: null,
    enabled: true,
    intervalMinutes: 360,
    lastPolledAt: null,
    lastStatus: null,
    lastError: null,
    lastOkAt: null,
    createdAt: "",
  });
  const lanes = buildLanes(
    [
      make("a", "greenhouse"),
      make("b", "greenhouse"),
      make("c", "greenhouse"),
      make("d", "lever"),
      make("e", "workday", "e.wd5.myworkdayjobs.com"),
      make("f", "workday", "f.wd1.myworkdayjobs.com"),
    ],
    2,
  );
  assert.equal(lanes.length, 5);
  assert.deepEqual(lanes.map((lane) => lane.map((t) => t.id).join("")).sort(), ["ac", "b", "d", "e", "f"]);
});

test("quiet drafts are stored as already alerted and a good poll sets last_ok_at", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intern-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  await seedStarter(store);
  const draft = {
    company: "Figma",
    title: "Software Engineer Intern",
    location: "San Francisco, CA",
    url: "https://boards.greenhouse.io/figma/jobs/1",
    ats: "greenhouse" as const,
    targetId: "greenhouse:figma",
    externalId: "1",
    postedAt: null,
  };
  await store.upsertJobs([{ ...draft, quiet: true }, { ...draft, title: "ML Intern", url: "https://boards.greenhouse.io/figma/jobs/2" }]);
  await evaluateJobs(store, 100, []);
  const matches = await store.listUnalertedMatches({ sinceHours: 1, limit: 10 });
  assert.deepEqual(matches.map((job) => job.title), ["ML Intern"]);

  const cached = await store.getClassifications(["ml intern", "missing"]);
  assert.equal(cached.size, 1);
  assert.equal(cached.get("ml intern")?.roleFamily, "ml");

  assert.equal((await store.getTarget("greenhouse:figma"))?.lastOkAt, null);
  await store.touchTarget("greenhouse:figma", "error", "boom");
  assert.equal((await store.getTarget("greenhouse:figma"))?.lastOkAt, null);
  await store.touchTarget("greenhouse:figma", "ok", null);
  assert.ok((await store.getTarget("greenhouse:figma"))?.lastOkAt);
});

test("season and degree come from the title", () => {
  assert.equal(ruleSeason("Software Engineer Intern (2027)"), "summer_2027");
  assert.equal(ruleSeason("Data Science Intern (2027 Start)"), "summer_2027");
  assert.equal(ruleSeason("SWE Intern - Summer 2027 / Fall 2027"), "summer_2027");
  assert.equal(ruleSeason("Software Engineering Co-op, Fall 2026"), "other");
  assert.equal(ruleSeason("Software Engineer Intern, Summer 2026"), "other");
  assert.equal(ruleSeason("Software Engineer, Intern"), "unspecified");
  assert.equal(ruleSeason("Software Engineer, Intern (Summer or Winter)"), "unspecified");
  assert.equal(ruleSeason("Software Engineering Intern, Compiler Verification - Spring 2027"), "other");
  assert.equal(ruleDegree("PhD GenAI Research Scientist Intern"), "phd_only");
  assert.equal(ruleDegree("Research Intern (MS/PhD)"), "any");
  assert.equal(ruleDegree("Software Engineer Intern"), "any");
  assert.equal(ruleDegree("Strategic Finance & Analytics Intern (MBA)"), "mba_only");
});

test("locations sort into US, abroad, and unclear", () => {
  assert.equal(ruleUs("Hybrid - San Francisco, CA"), true);
  assert.equal(ruleUs("New York, NY"), true);
  assert.equal(ruleUs("Washington, D.C."), true);
  assert.equal(ruleUs("Remote-US"), true);
  assert.equal(ruleUs("Mountain View, California; San Francisco, California"), true);
  assert.equal(ruleUs("NYC / Toronto"), true);
  assert.equal(ruleUs("Bengaluru"), false);
  assert.equal(ruleUs("London, United Kingdom"), false);
  assert.equal(ruleUs("Seoul, South Korea"), false);
  assert.equal(ruleUs("Toronto, ON"), false);
  assert.equal(ruleUs("Remote - Americas"), null);
  assert.equal(ruleUs("2 Locations"), null);
  assert.equal(ruleUs(null), null);
  assert.equal(ruleUs("Product Manager Intern (2027) - Lisbon, PT"), false);
  assert.equal(ruleUs("Product Manager Intern (2027) - London, UK"), false);
  assert.equal(ruleUs("Software Engineer Intern (2027) - Austin, TX"), true);
  assert.equal(ruleUs("Software Engineer, Intern"), null);
});

test("a match needs intern, target family, right season, degree, and the US", () => {
  const swe = ruleClassify("Software Engineer Intern");
  assert.equal(evaluate("a", swe, true).match, true);
  assert.equal(evaluate("a", swe, null).match, true);
  const abroad = evaluate("a", swe, false);
  assert.equal(abroad.match, false);
  assert.equal(abroad.reason, "outside the US");
  assert.ok(abroad.score <= 0.2);
  assert.equal(evaluate("a", ruleClassify("PhD GenAI Research Scientist Intern"), true).match, false);
  assert.equal(evaluate("a", ruleClassify("Software Engineering Co-op, Fall 2026"), true).match, false);
  assert.equal(evaluate("a", ruleClassify("Hardware Engineering Intern"), true).match, false);
  assert.equal(evaluate("a", ruleClassify("Senior Software Engineer"), true).match, false);
  assert.equal(evaluate("a", ruleClassify("High School Internship, Software Engineering (Summer 2027)"), true).match, false);
});

test("posting keys line up a list link with its board posting", () => {
  assert.equal(postingKey("https://job-boards.greenhouse.io/scaleai/jobs/4567?utm_source=Simplify"), "gh:4567");
  assert.equal(postingKey("https://scale.com/careers?gh_jid=4567"), "gh:4567");
  assert.equal(
    postingKey("https://jobs.lever.co/palantir/1b2c3d4e-0000-4000-8000-123456789abc/apply"),
    "lever:1b2c3d4e-0000-4000-8000-123456789abc",
  );
  assert.equal(
    postingKey("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Intern_JR2001234"),
    "wd:nvidia:jr2001234",
  );
  assert.equal(postingKey("https://jobs.smartrecruiters.com/BoschGroup/744000158594769"), "sr:744000158594769");
  assert.equal(postingKey("https://explore.jobs.netflix.net/careers/job/790318904468"), "ef:790318904468");
  assert.equal(postingKey("https://go.vansh.nyc/Zo"), null);
});

test("board links in a list become targets", () => {
  assert.deepEqual(boardFromUrl("Scale AI", "https://job-boards.greenhouse.io/scaleai/jobs/4567"), {
    company: "Scale AI",
    ats: "greenhouse",
    boardToken: "scaleai",
  });
  assert.equal(boardFromUrl("X", "https://boards.greenhouse.io/embed/job_app?for=figma&token=1")?.boardToken, "figma");
  assert.equal(boardFromUrl("Ramp", "https://jobs.ashbyhq.com/ramp/abc")?.ats, "ashby");
  assert.deepEqual(boardFromUrl("NVIDIA", "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x_JR1"), {
    company: "NVIDIA",
    ats: "workday",
    workdayHost: "nvidia.wd5.myworkdayjobs.com",
    workdayTenant: "nvidia",
    workdaySite: "NVIDIAExternalCareerSite",
  });
  assert.equal(boardFromUrl("Acme", "https://acme.com/careers/123"), null);
  assert.deepEqual(boardFromUrl("Netflix", "https://explore.jobs.netflix.net/careers/job/790318904468"), {
    company: "Netflix",
    ats: "eightfold",
    boardToken: "explore.jobs.netflix.net",
  });
  assert.equal(boardFromUrl("Qualcomm", "https://qualcomm.eightfold.ai/careers?pid=446721064018")?.boardToken, "qualcomm.eightfold.ai");
});

test("a list job and its board posting become one row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intern-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  assert.equal(await store.addTargets([{ company: "SimplifyJobs list", ats: "list", boardToken: "simplify" }]), 1);
  assert.equal(await store.addTargets([{ company: "SimplifyJobs list", ats: "list", boardToken: "simplify" }]), 0);
  const fromList = await store.upsertJobs([
    {
      company: "Scale AI",
      title: "Software Engineering Intern (Summer 2027)",
      location: "SF",
      url: "https://job-boards.greenhouse.io/scaleai/jobs/4567?utm_source=Simplify&ref=Simplify",
      ats: "list",
      targetId: "list:simplify",
      externalId: "x",
      postedAt: null,
      looseMatch: true,
    },
  ]);
  const fromBoard = await store.upsertJobs([
    {
      company: "Scale AI",
      title: "Software Engineering Intern (Summer 2027)",
      location: "San Francisco, CA",
      url: "https://scale.com/careers/4567?gh_jid=4567",
      ats: "greenhouse",
      targetId: "greenhouse:scaleai",
      externalId: "4567",
      postedAt: null,
    },
  ]);
  const fromOtherList = await store.upsertJobs([
    {
      company: "Scale AI, Inc.",
      title: "Software Engineering Intern (Summer 2027)",
      location: "San Francisco",
      url: "https://go.vansh.nyc/abc",
      ats: "list",
      targetId: "list:vansh",
      externalId: "y",
      postedAt: null,
      looseMatch: true,
    },
  ]);
  assert.equal(fromList.insertedIds.length, 1);
  assert.equal(fromBoard.insertedIds.length, 0);
  assert.equal(fromOtherList.insertedIds.length, 0);
  const jobs = await store.listJobs({ q: "Scale" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceUrls.length, 3);
});

test("old jobs are pruned unless they are tracked", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intern-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  const draft = (n: number) => ({
    company: "Acme",
    title: `Software Engineer Intern ${n}`,
    location: "Austin, TX",
    url: `https://boards.greenhouse.io/acme/jobs/${n}`,
    ats: "greenhouse" as const,
    targetId: "greenhouse:acme",
    externalId: String(n),
    postedAt: null,
  });
  const { insertedIds } = await store.upsertJobs([draft(1), draft(2), draft(3)]);
  await store.upsertApplication({ jobId: insertedIds[0], status: "applied" });
  assert.equal(await store.pruneJobs(1), 0);
  assert.equal(await store.pruneJobs(-1), 2);
  const left = await store.listJobs({ limit: 10 });
  assert.deepEqual(left.map((job) => job.id), [insertedIds[0]]);
});
