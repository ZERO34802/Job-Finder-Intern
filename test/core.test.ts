import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJobUrl, companyKey, dedupeKey, postingKey, titleCacheKey } from "../lib/canonicalize";
import { evaluate, evaluateJobs, withRules, isCandidateTitle, ruleClassify, ruleDegree, ruleSeason, ruleUs } from "../lib/classify";
import { parseCsv } from "../lib/csv";
import { jitteredMs } from "../lib/jitter";
import { buildLanes } from "../lib/poll";
import { boardFromUrl, parseCsvListings, parseMarkdownListings, parseYcJobsPage, ycPostedAt } from "../lib/sources";
import { boardFromCrawlLine, boardsFromDirectory, boardsFromHnComment, boardsFromYc } from "../lib/discover";
import { importTargets, seedStarter } from "../lib/seed";
import { normalizeTarget } from "../lib/targets";
import { createSqliteStore } from "../lib/sqlite-store";
import { isApplied, postedTime, timeAgo } from "../lib/posted";
import { applyImport, companyFromUrl, mapSheetStatus, parseSheetRows, planImport } from "../lib/importApplications";
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
  // Each source keeps when it first listed the job, so the earlier finder can be told apart.
  const [board, lever] = jobs[0].sourceUrls;
  assert.ok(board.seenAt && lever.seenAt && board.seenAt <= lever.seenAt);
  const again = await store.upsertJobs([
    { company: "stripe", title: "Software Engineering Intern", location: "Remote", url: "https://jobs.lever.co/stripe/abc", ats: "lever", targetId: "lever:stripe", externalId: "abc", postedAt: null },
  ]);
  assert.equal(again.insertedIds.length, 0);
  assert.equal((await store.listJobs({ q: "Software Engineering" }))[0].sourceUrls[1].seenAt, lever.seenAt);

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
  assert.equal(ruleSeason("Co-op, Embedded Software Engineering: January-June 2027 (Onsite)"), "other");
  assert.equal(ruleSeason("Software Development Co-op (Jan '27 Start)"), "other");
  assert.equal(ruleSeason("AI Software Engineering Co-op - 6 months - 8 months"), "other");
  assert.equal(ruleSeason("Software Developer - Java Intern - June 2027"), "summer_2027");
  assert.equal(ruleSeason("Accenture Internship Program - May to Aug 2027"), "summer_2027");
  assert.equal(ruleSeason("Summer 2027 IT Intern (May 2028 Graduates)"), "summer_2027");
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

test("rules override stored labels for engineering outside software and fellowships", () => {
  const label = (title: string) => withRules(title, { ...ruleClassify("Software Engineer Intern"), roleFamily: "swe" });
  assert.equal(label("Civil Engineer Intern (Summer 2027)").roleFamily, "other");
  assert.equal(label("GIS Intern").roleFamily, "other");
  assert.equal(label("Project Engineer Intern - Mission Critical").roleFamily, "other");
  assert.equal(label("GIS Software Developer Intern").roleFamily, "swe");
  assert.equal(label("Embedded Firmware and Controls Engineer Intern").roleFamily, "swe");
  assert.equal(label("Summer Intern - IT Manufacturing Systems").roleFamily, "swe");
  assert.equal(label("Research Fellow in Surgical AI").isIntern, false);
  assert.equal(label("Data Science & Machine Learning Fellow Intern").isIntern, true);
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
  assert.equal(postingKey("https://hcwp.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2010917"), "or:hcwp:2010917");
  assert.equal(postingKey("https://www.amazon.jobs/jobs/10587999/apply"), "amzn:10587999");
  assert.equal(postingKey("https://amazon.jobs/en/jobs/10587999/sde-intern"), "amzn:10587999");
  assert.equal(postingKey("https://lifeattiktok.com/search/7610545287514392837"), "tt:7610545287514392837");
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
  assert.deepEqual(boardFromUrl("Waymo", "https://careers.withwaymo.com/jobs?gh_jid=8234553"), {
    company: "Waymo",
    ats: "greenhouse",
    boardToken: "waymo",
  });
  assert.deepEqual(boardFromUrl("Texas Instruments", "https://edbz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123"), {
    company: "Texas Instruments",
    ats: "oracle",
    workdayHost: "edbz.fa.us2.oraclecloud.com",
    workdaySite: "CX",
  });
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

test("speedyapply markdown tables parse by header name", () => {
  const md = [
    "### FAANG+",
    "",
    "| Company | Position | Location | Salary | Posting | Age |",
    "|---|---|---|---|---|---|",
    '| <a href="https://www.amazon.com"><strong>Amazon</strong></a> | SDE Intern - Summer 2027 | Redmond, WA | $53/hr | <a href="https://www.amazon.jobs/jobs/10587999/apply"><img alt="Apply"/></a> | 6d |',
    "",
    "### Other",
    "",
    "| Company | Position | Location | Posting | Age |",
    "|---|---|---|---|---|",
    '| <a href="https://x.com"><strong>Rivian</strong></a> | Software Engineering Intern | Irvine, CA +1 | <a href="https://jobs.ashbyhq.com/rivianvw.tech/f5aa59d9-4fdc-42d5-931d-efd9e6d96f2f"><img alt="Apply"/></a> | 51d |',
  ].join("\n");
  const now = Date.UTC(2026, 9, 29);
  const items = parseMarkdownListings(md, now);
  assert.equal(items.length, 2);
  assert.equal(items[0].company_name, "Amazon");
  assert.equal(items[0].title, "SDE Intern - Summer 2027");
  assert.equal(items[0].url, "https://www.amazon.jobs/jobs/10587999/apply");
  assert.deepEqual(items[0].locations, ["Redmond, WA"]);
  assert.equal(items[0].date_posted, Math.floor((now - 6 * 86_400_000) / 1000));
  assert.equal(items[1].company_name, "Rivian");
  assert.equal(items[1].locations?.[0], "Irvine, CA +1");
});

test("discovered Oracle boards normalize to one id per host and site", () => {
  const target = normalizeTarget({ company: "TI", ats: "oracle", workdayHost: "edbz.fa.us2.oraclecloud.com", workdaySite: "CX" });
  assert.equal(target.id, "oracle:edbz-cx");
  assert.equal(target.workdayTenant, "edbz-cx");
  assert.throws(() => normalizeTarget({ company: "X", ats: "oracle", workdayHost: "evil.example.com", workdaySite: "CX" }));
});

test("HN hiring posts and crawl lines yield startup boards", () => {
  const comment =
    "Acme Robotics | Software Engineer Intern | SF<p>Apply: <a href=\"https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme-robotics&#x2F;123\">https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme-robotics&#x2F;123</a>" +
    " or https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;embed&#x2F;job_app?for=acmeco";
  const boards = boardsFromHnComment(comment);
  assert.deepEqual(boards[0], { company: "Acme Robotics", ats: "ashby", boardToken: "acme-robotics" });
  assert.deepEqual(boards.find((b) => b.ats === "greenhouse"), { company: "Acme Robotics", ats: "greenhouse", boardToken: "acmeco" });
  assert.deepEqual(boardFromCrawlLine('{"url": "https://jobs.lever.co/zipline/abc-123"}'), {
    company: "zipline",
    ats: "lever",
    boardToken: "zipline",
  });
  assert.equal(boardFromCrawlLine('{"url": "https://boards.greenhouse.io/embed/job_board"}'), null);
  assert.equal(boardFromCrawlLine("not json"), null);
});

test("posted time reads dates, Workday's relative text, and falls back to first seen", () => {
  const firstSeenAt = "2026-10-31T12:00:00.000Z";
  const seen = Date.parse(firstSeenAt);
  assert.equal(postedTime({ postedAt: "2026-10-29T08:00:00Z", firstSeenAt }), Date.parse("2026-10-29T08:00:00Z"));
  assert.equal(postedTime({ postedAt: "Posted Today", firstSeenAt }), seen);
  assert.equal(postedTime({ postedAt: "Posted Yesterday", firstSeenAt }), seen - 86_400_000);
  assert.equal(postedTime({ postedAt: "Posted 3 Days Ago", firstSeenAt }), seen - 3 * 86_400_000);
  assert.equal(postedTime({ postedAt: "Posted 30+ Days Ago", firstSeenAt }), seen - 30 * 86_400_000);
  assert.equal(postedTime({ postedAt: null, firstSeenAt }), seen);
  assert.equal(postedTime({ postedAt: "2099-01-01", firstSeenAt }), seen);
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.equal(timeAgo(now - 30_000, now), "just now");
  assert.equal(timeAgo(now - 45 * 60_000, now), "45m ago");
  assert.equal(timeAgo(now - 5 * 3_600_000, now), "5h ago");
  assert.equal(timeAgo(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(isApplied("saved"), false);
  assert.equal(isApplied("applied"), true);
  assert.equal(isApplied("interviewing"), true);
});

test("applications carry posting details, keep notes when moved back, and jobs list newest first", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intern-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  const draft = (n: number) => ({
    company: "Figma",
    title: `Software Engineer Intern ${n}`,
    location: "San Francisco, CA",
    url: `https://boards.greenhouse.io/figma/jobs/${n}`,
    ats: "greenhouse" as const,
    targetId: "greenhouse:figma",
    externalId: String(n),
    postedAt: "2026-10-30T00:00:00Z",
  });
  const first = await store.upsertJobs([draft(1)]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertJobs([draft(2)]);
  const newest = await store.listJobs({ order: "newest", limit: 10 });
  assert.deepEqual(newest.map((job) => job.title), ["Software Engineer Intern 2", "Software Engineer Intern 1"]);
  const id = first.insertedIds[0];
  const saved = await store.upsertApplication({ jobId: id, status: "applied", notes: "referral from Sam" });
  assert.equal(saved.status, "applied");
  assert.equal(saved.location, "San Francisco, CA");
  assert.equal(saved.postedAt, "2026-10-30T00:00:00Z");
  assert.ok(saved.firstSeenAt);
  // Unticking Applied sets the job back to saved; its notes stay.
  const back = await store.upsertApplication({ jobId: id, status: "saved" });
  assert.equal(back.status, "saved");
  assert.equal(back.notes, "referral from Sam");
});

test("sheet statuses map to a status and a referral", () => {
  assert.deepEqual(mapSheetStatus("Applied(no referral)"), { status: "applied", referral: "none", note: null });
  assert.deepEqual(mapSheetStatus("Appplied(referral)"), { status: "applied", referral: "referred", note: null });
  assert.deepEqual(mapSheetStatus("Referral requested"), { status: "applied", referral: "requested", note: null });
  assert.equal(mapSheetStatus("Rejected").status, "rejected");
  assert.equal(mapSheetStatus("").status, "saved");
  assert.deepEqual(mapSheetStatus("Ghosted"), { status: "saved", referral: "none", note: "Sheet status: Ghosted" });
  assert.equal(postingKey("https://job-boards.greenhouse.io/embed/job_app?for=figma&token=6131089004"), "gh:6131089004");
  assert.equal(postingKey("https://commure.com/careers?ashby_jid=62841aa1-3ee5-4547-8380-637b737b2cb3"), "ashby:62841aa1-3ee5-4547-8380-637b737b2cb3");
  assert.equal(postingKey("https://careers.qualcomm.com/careers/job?pid=446720740529"), "ef:446720740529");
  assert.equal(companyFromUrl("https://job-boards.greenhouse.io/enova/jobs/8239619"), "Enova");
  assert.equal(companyFromUrl("https://radiancetech.wd12.myworkdayjobs.com/Radiance_External/job/x_HR102443"), "Radiancetech");
});

test("pasted sheet rows import once, match stored jobs, and re-import without duplicates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "intern-finder-"));
  const store = createSqliteStore(path.join(dir, "test.db"));
  await store.upsertJobs([
    {
      company: "Figma",
      title: "Software Engineer Intern",
      location: "San Francisco, CA",
      url: "https://job-boards.greenhouse.io/figma/jobs/6143238004",
      ats: "greenhouse",
      targetId: "greenhouse:figma",
      externalId: "6143238004",
      postedAt: null,
    },
  ]);
  const text = [
    "Company\tRole\tJob Link\tApplication Status\tDate\tJD\tResult",
    "Figma\tSWE Intern\thttps://job-boards.greenhouse.io/figma/jobs/6143238004?gh_jid=6143238004\tAppplied(referral)\t\t\t",
    'Whatnot\tSWE Intern\thttps://jobs.ashbyhq.com/whatnot/928ffdca-b316-40ce-b82b-94b570919bcd/application\tApplied(no referral)\t16/08/2026\t"line one\nline two"\tBad Company',
    "Harvey\t\thttps://jobs.ashbyhq.com/harvey/06d64648-b84b-48ae-94a2-d9c06dfdcb5d\tApplied(no referral)\t\t\t",
    "Harvey\tSWE Intern (NYC)\thttps://jobs.ashbyhq.com/harvey/06d64648-b84b-48ae-94a2-d9c06dfdcb5d/application\tRejected\t\t\t",
    "Ambrook\t\tnot a link\t\t\t\t",
    "Stripe\tSWE Intern\thttps://stripe.com/careers/apply/software-engineer-intern-summer-or-winter/8128745\tApplied(no referral)\t\t\t",
    "\t\thttps://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8128745\tApplied(no referral)\t\t\t",
  ].join("\n");
  const plan = await planImport(store, parseSheetRows(text));
  assert.equal(plan.rows.length, 4);
  assert.equal(plan.skipped.length, 1);
  assert.deepEqual(plan.rows.map((row) => row.action).sort(), ["matched job", "new job", "new job", "new job"]);
  // A company page and its Greenhouse form with the same job number are one application.
  assert.equal(plan.rows.filter((row) => row.company === "Stripe").length, 1);
  const harvey = plan.rows.find((row) => row.company === "Harvey")!;
  assert.equal(harvey.title, "SWE Intern (NYC)");
  assert.equal(harvey.status, "rejected");
  assert.deepEqual(await applyImport(store, plan), { saved: 4, newJobs: 3, unchanged: 0 });

  const apps = await store.listApplications();
  assert.equal(apps.length, 4);
  const figma = apps.find((app) => app.company === "Figma")!;
  assert.equal(figma.referral, "referred");
  assert.equal(figma.title, "Software Engineer Intern");
  const whatnot = apps.find((app) => app.company === "Whatnot")!;
  assert.equal(whatnot.notes, "Date: 16/08/2026\nBad Company");

  // The same paste again changes nothing.
  const again = await planImport(store, parseSheetRows(text));
  assert.deepEqual(await applyImport(store, again), { saved: 0, newJobs: 0, unchanged: 4 });
  assert.equal((await store.listApplications()).length, 4);

  // A board listing the hand-added posting later lands on the same job, not a new one.
  const later = await store.upsertJobs([
    {
      company: "Whatnot",
      title: "Software Engineer Intern - Summer 2027",
      location: "Seattle, WA",
      url: "https://jobs.ashbyhq.com/whatnot/928ffdca-b316-40ce-b82b-94b570919bcd",
      ats: "ashby",
      targetId: "ashby:whatnot",
      externalId: "928ffdca-b316-40ce-b82b-94b570919bcd",
      postedAt: null,
    },
  ]);
  assert.equal(later.insertedIds.length, 0);
  assert.equal((await store.listApplications()).find((app) => app.company === "Whatnot")?.title, "Software Engineer Intern - Summer 2027");
});

test("jobbie tables, the zshah101 csv and its board directory are read", () => {
  const md = [
    "| Company | Role | Location | Posted | Link | Apply with Jobbie |",
    "|---|---|---|---|---|:---:|",
    '| Together AI | Systems Research Engineer Intern (Summer 2027) · $58/hr | San Francisco, California | 2026-11-03 | [Job listing](https://job-boards.greenhouse.io/togetherai/jobs/5238460007) | <a href="https://jobbie.bot/register?job=1">Apply</a> |',
  ].join("\n");
  const [jobbie] = parseMarkdownListings(md);
  assert.equal(jobbie.title, "Systems Research Engineer Intern (Summer 2027)");
  assert.equal(jobbie.url, "https://job-boards.greenhouse.io/togetherai/jobs/5238460007");
  assert.equal(jobbie.date_posted, Date.parse("2026-11-03") / 1000);

  const csv = [
    "id,company,title,season,url,location,posted_at",
    'wd:1,Zebra,"Software Engineer Intern, Summer",Summer 2027,https://zebra.wd1.myworkdayjobs.com/x/job/y_R1,"Lincolnshire, IL",2026-11-03',
    "wd:2,Zebra,Data Intern,Fall 2026,https://zebra.wd1.myworkdayjobs.com/x/job/y_R2,,",
  ].join("\n");
  const rows = parseCsvListings(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Software Engineer Intern, Summer");
  assert.deepEqual(rows[0].locations, ["Lincolnshire, IL"]);
  assert.equal(rows[1].season, "Fall 2026");
  assert.equal(rows[1].date_posted, undefined);

  const boards = boardsFromDirectory([
    { name: "23andMe", slug: "23andme", ats: "workday", wd: "wd5", site: "23" },
    { name: "Acosta", slug: "eczy.fa.us2.oraclecloud.com", ats: "oracle", host: "eczy.fa.us2.oraclecloud.com", site: "CX_1" },
    { name: "10a Labs", slug: "10alabs", ats: "greenhouse" },
    { name: "4AG Robotics", slug: "4ag", ats: "rippling" },
  ]);
  assert.deepEqual(boards.map((b) => normalizeTarget(b).id), ["workday:23andme", "oracle:eczy-cx_1", "greenhouse:10alabs"]);
});

test("yc jobs pages are read and internships keep an intern title", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const page = {
    component: "WaasShowJobsPage",
    props: {
      jobPostings: [
        { id: 1, title: "Software Engineer", type: "Internship", url: "/companies/acme/jobs/a1-software-engineer", location: "San Francisco, CA, US", createdAt: "3 days" },
        { id: 2, title: "ML Intern & Researcher", type: "Internship", url: "/companies/acme/jobs/b2", location: null, createdAt: "about 1 hour" },
        { id: 3, title: "Founding Engineer", type: "Full-time", url: "/companies/acme/jobs/c3", location: "Remote (US)", createdAt: "7 months" },
      ],
    },
  };
  const attr = JSON.stringify(page).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const jobs = parseYcJobsPage(`<div data-page="${attr}"></div>`, now);
  assert.deepEqual(jobs.map((job) => job.title), ["Software Engineer Intern", "ML Intern & Researcher", "Founding Engineer"]);
  assert.equal(jobs[0].url, "https://www.ycombinator.com/companies/acme/jobs/a1-software-engineer");
  assert.equal(jobs[0].postedAt, "2026-10-31T12:00:00.000Z");
  assert.equal(jobs[1].postedAt, "2026-11-03T11:00:00.000Z");
  assert.equal(ycPostedAt("a month", now), new Date(now - 30 * 86_400_000).toISOString());
  assert.equal(ycPostedAt(undefined, now), null);
  assert.throws(() => parseYcJobsPage("<html></html>"));

  const boards = boardsFromYc([
    { name: "Acme", slug: "acme", status: "Active", isHiring: true },
    { name: "Old", slug: "old", status: "Inactive", isHiring: true },
    { name: "Quiet", slug: "quiet", status: "Active", isHiring: false },
  ]);
  assert.deepEqual(boards.map((b) => normalizeTarget(b).id), ["yc:acme"]);
});
