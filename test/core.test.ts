import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJobUrl, companyKey, dedupeKey, titleCacheKey } from "../lib/canonicalize";
import { isCandidateTitle, ruleClassify } from "../lib/classify";
import { parseCsv } from "../lib/csv";
import { jitteredMs } from "../lib/jitter";
import { buildLanes } from "../lib/poll";
import { importTargets, seedStarter } from "../lib/seed";
import { createSqliteStore } from "../lib/sqlite-store";
import type { Target } from "../lib/types";

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
  assert.ok(intern.score >= 0.9);
  const ml = ruleClassify("Data Science Intern");
  assert.equal(ml.roleFamily, "ml");
  const grad = ruleClassify("New Grad, Machine Learning Engineer");
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

  await store.putClassification({
    cacheKey: jobs[0].titleKey,
    title: jobs[0].title,
    isIntern: true,
    roleFamily: "swe",
    seniority: "intern",
    score: 0.92,
    reason: "test",
    model: "rules",
  });
  await store.applyClassifications();
  const classified = await store.listJobs({ earlyOnly: true, limit: 10 });
  assert.equal(classified.length, 1);
  assert.equal(classified[0].score, 0.92);
  assert.equal(classified[0].isIntern, true);

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
  await store.putClassification({
    cacheKey: "software engineer intern",
    title: "Software Engineer Intern",
    isIntern: true,
    roleFamily: "swe",
    seniority: "intern",
    score: 0.92,
    reason: "test",
    model: "rules",
  });
  await store.putClassification({
    cacheKey: "ml intern",
    title: "ML Intern",
    isIntern: true,
    roleFamily: "ml",
    seniority: "intern",
    score: 0.92,
    reason: "test",
    model: "rules",
  });
  await store.applyClassifications();
  const matches = await store.listUnalertedMatches({ sinceHours: 1, limit: 10, minScore: 0.5 });
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
