import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, standardItems, baseFeed, captureTime } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

const FEED = { ...baseFeed, minimumItems: 3, missingThreshold: 3 };
const articleUrl = (id) => `https://news.example.test/2026/11-16/article-${id}.shtml`;

async function seededRejection(t, { baseline = 16, shrink = 3, shrinkStart = 14 } = {}) {
  const { archive } = await makeArchive(t);
  archive.registerFeed(FEED);
  archive.importSnapshot("daily-main", page(standardItems(baseline)), captureTime(1));
  const rejected = archive.importSnapshot("daily-main", page(standardItems(shrink, shrinkStart)), captureTime(2));
  assert.equal(rejected.accepted, false);
  return { archive, rejected };
}

test("preserves the isolated page and full parse evidence when a shrink is rejected", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  assert.match(rejected.reason, /unexpected_count_drop/);
  const bundle = archive.captureEvidence("daily-main", rejected.captureId);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.latest.normalizedCount, 3);
  assert.equal(bundle.latest.records.length, 3);
  assert.equal(bundle.latest.policyContext.minimumItems, 3);
  assert.ok(bundle.latest.policyFingerprint);
  assert.ok(bundle.latest.records[0].canonicalUrl.endsWith("article-14.shtml"));
  // the original HTML is retained so a reviewer can re-parse without refetching
  assert.ok(bundle.attempts[0].policyContext.allowedHosts.includes("news.example.test"));
  const queue = archive.reviewQueue("daily-main");
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].captureId, rejected.captureId);
  assert.equal(queue.pending[0].staleness.stale, false);
});

test("release applies the isolated capture at its original capture time instead of the list end", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  // a newer page is captured while the rejected page is still under review
  const mid = archive.importSnapshot("daily-main", page(standardItems(12, 30)), captureTime(3));
  assert.equal(mid.accepted, true);
  const result = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li", note: "topic ended" });
  assert.equal(result.status, 200);
  assert.equal(result.applied, true);
  assert.equal(result.observedAt, captureTime(2));
  // the released capture sits between t1 and t3, never appended after the current list
  const article = archive.articles.get("daily-main", articleUrl(14));
  const timeline = archive.articleTimeline("daily-main", article.articleId);
  assert.deepEqual(timeline.observations.map((entry) => entry.captureId), [rejected.captureId, 1]);
  assert.deepEqual(timeline.observations.map((entry) => entry.capturedAt), [captureTime(2), captureTime(1)]);
  // items from the released page were observed exactly twice (baseline + released page)
  assert.equal(article.seenCount, 2);
  assert.equal(article.firstSeenAt, captureTime(1));
  assert.equal(article.lastSeenAt, captureTime(2));
});

test("release recomputes missing streaks against the full effective capture history", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  archive.importSnapshot("daily-main", page(standardItems(12, 30)), captureTime(3));
  archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  // articles 1..13 are absent from both the released t2 page and the t3 page -> streak 2, still visible
  const omitted = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(omitted.missingStreak, 2);
  assert.equal(omitted.visibility, "visible");
  assert.equal(omitted.seenCount, 1);
  // once enough later omissions accumulate, the same article turns quiet through the normal rule
  archive.importSnapshot("daily-main", `${page(standardItems(12, 30))}<!-- again -->`, captureTime(4));
  const quieted = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(quieted.missingStreak, 3);
  assert.equal(quieted.visibility, "quiet");
});

test("repeated release confirmation is idempotent and never counts a second occurrence", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  const first = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  const second = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.idempotent, true);
  const article = archive.articles.get("daily-main", articleUrl(14));
  assert.equal(article.seenCount, 2);
  const links = archive.database.prepare("SELECT COUNT(*) AS n FROM capture_items WHERE capture_id=?").get(rejected.captureId);
  assert.equal(links.n, 3);
  // only one effective decision row exists even though release was requested twice
  const history = archive.captureReviewHistory("daily-main", rejected.captureId);
  assert.equal(history.decisions.filter((d) => d.decision === "release").length, 1);
});

test("keeps the original rejection row and appends human decisions instead of rewriting history", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  archive.upholdCapture("daily-main", rejected.captureId, { operator: "op-wang", note: "looks broken" });
  const before = archive.captures.getById("daily-main", rejected.captureId);
  assert.equal(before.accepted, false);
  assert.match(before.reason, /unexpected_count_drop/);
  archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li", note: "rechecked, real shrink" });
  const after = archive.captures.getById("daily-main", rejected.captureId);
  // the capture row itself is never converted into an automatic acceptance
  assert.equal(after.accepted, false);
  assert.equal(after.reason, before.reason);
  const history = archive.captureReviewHistory("daily-main", rejected.captureId);
  assert.deepEqual(history.decisions.map((d) => d.decision), ["release", "uphold"]);
  assert.equal(history.decisions[1].decidedBy, "op-wang");
  assert.equal(history.decisions[0].note, "rechecked, real shrink");
  const runs = archive.listCaptures("daily-main");
  const run = runs.find((capture) => capture.captureId === rejected.captureId);
  assert.equal(run.review.reviewState, "released");
  assert.equal(run.effective, true);
});

test("blocks release when feed rules changed after evidence was parsed and explains the change", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  archive.registerFeed({ ...FEED, minimumItems: 5 });
  const blocked = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, "evidence_stale");
  assert.equal(blocked.policyChange.stale, true);
  assert.deepEqual(blocked.policyChange.changed.map((change) => change.field), ["minimumItems"]);
  assert.deepEqual(blocked.policyChange.changed[0].storedValue, 3);
  assert.deepEqual(blocked.policyChange.changed[0].currentValue, 5);
  // the blocked attempt is itself traceable
  const history = archive.captureReviewHistory("daily-main", rejected.captureId);
  assert.equal(history.decisions[0].decision, "blocked_stale");
  // nothing was applied while blocked
  assert.equal(archive.articles.stats("daily-main").total, 16);
});

test("detects host allowlist changes as stale evidence and re-parses on retry", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(FEED);
  archive.importSnapshot("daily-main", page(standardItems(8)), captureTime(1));
  const mixed = page([
    { id: 30 }, { id: 31 },
    { id: 999, url: "https://bad.test/2026/x.shtml", title: "外站链接" }
  ]);
  const rejected = archive.importSnapshot("daily-main", mixed, captureTime(2));
  assert.match(rejected.reason, /too_few_usable_items/);
  const initial = archive.captureEvidence("daily-main", rejected.captureId);
  assert.equal(initial.latest.rejected[0].href, "https://bad.test/2026/x.shtml");
  archive.registerFeed({ ...FEED, allowedHosts: ["news.example.test", "bad.test"] });
  const blocked = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-wang" });
  assert.equal(blocked.error, "evidence_stale");
  assert.deepEqual(blocked.policyChange.changed.map((change) => change.field), ["allowedHosts"]);
  const retried = archive.retryCapture("daily-main", rejected.captureId, { operator: "op-wang" });
  assert.equal(retried.status, 200);
  assert.equal(retried.evidence.normalizedCount, 3);
  assert.equal(retried.evidence.attempt, 2);
  assert.equal(retried.policyChange.stale, true);
  const evidence = archive.captureEvidence("daily-main", rejected.captureId);
  assert.equal(evidence.attempts.length, 2);
  assert.notEqual(evidence.attempts[0].policyFingerprint, evidence.attempts[1].policyFingerprint);
  // the historical rejection reason is preserved even after auto-retry
  assert.equal(archive.captures.getById("daily-main", rejected.captureId).accepted, false);
});

test("retry re-runs quality gates under current rules and records failures without applying anything", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  archive.registerFeed({ ...FEED, minimumItems: 5 });
  const failed = archive.retryCapture("daily-main", rejected.captureId, { operator: "op-zhao" });
  assert.equal(failed.status, 422);
  assert.equal(failed.error, "quality_gate_still_failing");
  assert.match(failed.reason, /too_few_usable_items:3<5/);
  // new evidence was captured for the attempt, but no articles or links were applied
  assert.equal(failed.evidence.attempt, 2);
  assert.equal(archive.articles.stats("daily-main").total, 16);
  const history = archive.captureReviewHistory("daily-main", rejected.captureId);
  assert.equal(history.decisions[0].decision, "retry_failed");
  assert.match(history.decisions[0].gateReason, /too_few_usable_items/);
  // once evidence is fresh, a human can still release manually without lowering global thresholds
  const manual = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-zhao", note: "confirmed shrink" });
  assert.equal(manual.status, 200);
  // the shrink page only re-lists articles already known from the baseline, so no new rows appear
  assert.equal(archive.articles.stats("daily-main").total, 16);
  const releasedArticle = archive.articles.get("daily-main", articleUrl(14));
  assert.equal(releasedArticle.seenCount, 2);
});

test("retry auto-applies at the historical position when current gates pass", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(FEED);
  archive.importSnapshot("daily-main", page(standardItems(8)), captureTime(1));
  const mixed = page([
    { id: 30 }, { id: 31 },
    { id: 999, url: "https://bad.test/2026/x.shtml", title: "外站链接" }
  ]);
  const rejected = archive.importSnapshot("daily-main", mixed, captureTime(2));
  archive.importSnapshot("daily-main", page(standardItems(6, 50)), captureTime(3));
  archive.registerFeed({ ...FEED, allowedHosts: ["news.example.test", "bad.test"] });
  const retried = archive.retryCapture("daily-main", rejected.captureId, { operator: "op-wang" });
  assert.equal(retried.status, 200);
  assert.equal(retried.observedAt, captureTime(2));
  const history = archive.captureReviewHistory("daily-main", rejected.captureId);
  assert.equal(history.decisions[0].decision, "auto_retry");
  assert.equal(history.decisions[0].decidedBy, "op-wang");
  // the watermark still points at the newest capture, not the back-filled one
  assert.equal(archive.feedStatus("daily-main").lastAcceptedAt, captureTime(3));
});

test("change report and integrity audit treat released captures as effective", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  const changes = archive.feedChanges("daily-main");
  assert.equal(changes.ready, true);
  assert.deepEqual(changes.counts, { added: 0, omitted: 13, current: 3, previous: 16 });
  const audit = archive.auditIntegrity();
  assert.equal(audit.status, "consistent");
  assert.ok(audit.checks.every((check) => check.passed));
});

test("exposes the review queue, evidence and decisions through the HTTP contract", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main`;
  const queue = await fetch(`${root}/review-queue`);
  assert.equal(queue.status, 200);
  assert.equal((await queue.json()).pending.length, 1);
  const evidence = await fetch(`${root}/captures/evidence?captureId=${rejected.captureId}`);
  assert.equal(evidence.status, 200);
  assert.equal((await evidence.json()).latest.normalizedCount, 3);
  const release = await fetch(`${root}/captures/${rejected.captureId}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "release", operator: "op-li", note: "real shrink" })
  });
  assert.equal(release.status, 200);
  const body = await release.json();
  assert.equal(body.applied, true);
  const history = await fetch(`${root}/captures/${rejected.captureId}/review`);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).decisions[0].decision, "release");
  const badAction = await fetch(`${root}/captures/${rejected.captureId}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "freeze", operator: "op-li" })
  });
  assert.equal(badAction.status, 400);
  const missing = await fetch(`${root}/captures/999/review`);
  assert.equal(missing.status, 404);
});

test("validates review operator and note before writing any decision", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  for (const input of [
    { action: "release" },
    { action: "release", operator: "" },
    { action: "release", operator: 42 },
    { action: "uphold", operator: "op-li", note: "x".repeat(1001) }
  ]) {
    assert.throws(() => archive.releaseCapture("daily-main", rejected.captureId, input));
  }
  assert.equal(archive.captureReviewHistory("daily-main", rejected.captureId).decisions.length, 0);
});

test("serializes concurrent releases into one applied decision without duplicate observations", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    archive.releaseCapture("daily-main", rejected.captureId, { operator: `op-${index}` })));
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(results.filter((result) => result.idempotent).length, 5);
  assert.equal(
    archive.database.prepare("SELECT COUNT(*) AS n FROM capture_review_decisions WHERE decision='release'").get().n,
    1
  );
  const links = archive.database.prepare("SELECT COUNT(*) AS n FROM capture_items WHERE capture_id=?").get(rejected.captureId);
  assert.equal(links.n, 3);
  assert.equal(archive.articles.get("daily-main", articleUrl(14)).seenCount, 2);
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("serves retry and uphold through HTTP and keeps rejected captures out of the review queue once effective", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(FEED);
  archive.importSnapshot("daily-main", page(standardItems(8)), captureTime(1));
  const mixed = page([
    { id: 30 }, { id: 31 },
    { id: 999, url: "https://bad.test/2026/x.shtml", title: "外站链接" }
  ]);
  const rejected = archive.importSnapshot("daily-main", mixed, captureTime(2));
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main/captures/${rejected.captureId}/review`;
  const uphold = await fetch(root, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "uphold", operator: "op-wang" })
  });
  assert.equal(uphold.status, 200);
  assert.equal((await uphold.json()).upheld, true);
  archive.registerFeed({ ...FEED, allowedHosts: ["news.example.test", "bad.test"] });
  const retry = await fetch(root, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "retry", operator: "op-wang", note: "license updated" })
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).decisionId > 0, true);
  // once effective, the capture leaves the pending review queue
  const queue = await fetch(`http://127.0.0.1:${address.port}/v1/feeds/daily-main/review-queue`);
  assert.deepEqual((await queue.json()).pending, []);
});

test("resubmitting identical isolated HTML after release replays without a new observation", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  const html = page(standardItems(3, 14));
  archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  const replay = archive.importSnapshot("daily-main", html, captureTime(9));
  assert.equal(replay.replay, true);
  assert.equal(replay.captureId, rejected.captureId);
  assert.equal(archive.articles.get("daily-main", articleUrl(14)).seenCount, 2);
  assert.equal(archive.listCaptures("daily-main").length, 2);
});

test("supports uphold followed by release and refuses uphold once a capture is effective", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  const uphold = archive.upholdCapture("daily-main", rejected.captureId, { operator: "op-wang" });
  assert.equal(uphold.status, 200);
  // still pending because uphold does not make the capture effective
  assert.equal(archive.reviewQueue("daily-main").pending.length, 1);
  const conflicting = archive.upholdCapture("daily-main", rejected.captureId, { operator: "op-wang" });
  assert.equal(conflicting.status, 200);
  const release = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  assert.equal(release.status, 200);
  const after = archive.upholdCapture("daily-main", rejected.captureId, { operator: "op-wang" });
  assert.equal(after.status, 409);
  assert.equal(after.error, "capture_already_released");
  assert.equal(archive.reviewQueue("daily-main").pending.length, 0);
});

test("returns structured not-found outcomes for unknown feeds and captures", async (t) => {
  const { archive } = await makeArchive(t);
  assert.equal(archive.reviewQueue("absent"), null);
  assert.equal(archive.captureEvidence("absent", 1).status, 404);
  archive.registerFeed(FEED);
  assert.equal(archive.captureEvidence("daily-main", 999).status, 404);
  assert.equal(archive.releaseCapture("daily-main", 999, { operator: "op" }).status, 404);
  assert.equal(archive.retryCapture("daily-main", 999, { operator: "op" }).status, 404);
});

test("rolls back decision, links and article state together when release writing fails", async (t) => {
  const { archive, rejected } = await seededRejection(t);
  archive.database.exec(`CREATE TRIGGER fail_review BEFORE INSERT ON capture_items
    BEGIN SELECT RAISE(ABORT, 'simulated review fault'); END;`);
  assert.throws(() => archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" }), /simulated review fault/);
  archive.database.exec("DROP TRIGGER fail_review");
  assert.equal(archive.captureReviewHistory("daily-main", rejected.captureId).decisions.length, 0);
  assert.equal(
    archive.database.prepare("SELECT COUNT(*) AS n FROM capture_items WHERE capture_id=?").get(rejected.captureId).n,
    0
  );
  assert.equal(archive.articles.stats("daily-main").total, 16);
  assert.equal(archive.captures.getById("daily-main", rejected.captureId).accepted, false);
  const recovered = archive.releaseCapture("daily-main", rejected.captureId, { operator: "op-li" });
  assert.equal(recovered.status, 200);
  assert.equal(archive.auditIntegrity().status, "consistent");
});
