import test from "node:test";
import assert from "node:assert/strict";
import { assessCapture, validateCapturedAt } from "../../src/ingest/capture-policy.js";

const feed = { minimumItems: 3, lastItemCount: 0, lastAcceptedAt: null };

test("accepts a first well-formed capture at the configured minimum", () => {
  assert.deepEqual(assessCapture({ candidateCount: 3, normalizedCount: 3, rejectedCount: 0,
    previousCount: 0, capturedAt: "2026-11-16T02:00:00.000Z", feed }), { accepted: true, reason: null });
});

test("rejects an empty capture even when the extractor itself returned no errors", () => {
  assert.deepEqual(assessCapture({ candidateCount: 0, normalizedCount: 0, rejectedCount: 0,
    previousCount: 0, capturedAt: "2026-11-16T02:00:00.000Z", feed }),
  { accepted: false, reason: "too_few_usable_items:0<3" });
});

test("rejects partial pages whose usable item count falls below the established floor", () => {
  const result = assessCapture({ candidateCount: 40, normalizedCount: 6, rejectedCount: 0,
    previousCount: 40, capturedAt: "2026-11-16T02:00:00.000Z", feed });
  assert.deepEqual(result, { accepted: false, reason: "unexpected_count_drop:6<10" });
});

test("uses the feed's minimum when a small count floor is larger than its proportional threshold", () => {
  const result = assessCapture({ candidateCount: 4, normalizedCount: 2, rejectedCount: 0,
    previousCount: 4, capturedAt: "2026-11-16T02:00:00.000Z", feed });
  assert.equal(result.reason, "too_few_usable_items:2<3");
});

test("accepts a normal rolling-window change when the latest list retains enough records", () => {
  const result = assessCapture({ candidateCount: 13, normalizedCount: 13, rejectedCount: 0,
    previousCount: 40, capturedAt: "2026-11-16T02:00:00.000Z", feed });
  assert.equal(result.accepted, true);
});

test("limits invalid links while allowing a small number of page navigation anchors", () => {
  const accepted = assessCapture({ candidateCount: 10, normalizedCount: 5, rejectedCount: 3,
    previousCount: 0, capturedAt: "2026-11-16T02:00:00.000Z", feed });
  const rejected = assessCapture({ candidateCount: 10, normalizedCount: 5, rejectedCount: 6,
    previousCount: 0, capturedAt: "2026-11-16T02:00:00.000Z", feed });
  assert.equal(accepted.accepted, true);
  assert.equal(rejected.reason, "too_many_invalid_links:6>5");
});

test("refuses to move feed state backwards for delayed captures", () => {
  const delayedFeed = { ...feed, lastAcceptedAt: "2026-11-16T02:01:00.000Z" };
  const result = assessCapture({ candidateCount: 8, normalizedCount: 8, rejectedCount: 0,
    previousCount: 8, capturedAt: "2026-11-16T02:00:59.000Z", feed: delayedFeed });
  assert.deepEqual(result, { accepted: false, reason: "stale_capture_timestamp" });
});

test("treats an equal capture timestamp as a replay-order violation", () => {
  const timestamp = "2026-11-16T02:01:00.000Z";
  assert.equal(assessCapture({ candidateCount: 8, normalizedCount: 8, rejectedCount: 0,
    previousCount: 8, capturedAt: timestamp, feed: { ...feed, lastAcceptedAt: timestamp } }).accepted, false);
});

test("allows historical evidence retry to bypass the timestamp gate while keeping count gates", () => {
  const delayedFeed = { ...feed, lastAcceptedAt: "2026-11-16T02:05:00.000Z", lastItemCount: 8 };
  const bypassed = assessCapture({ candidateCount: 6, normalizedCount: 6, rejectedCount: 0,
    previousCount: 8, capturedAt: "2026-11-16T02:01:00.000Z", feed: delayedFeed, checkTimestamp: false });
  assert.equal(bypassed.accepted, true);
  const stillRejected = assessCapture({ candidateCount: 6, normalizedCount: 1, rejectedCount: 0,
    previousCount: 8, capturedAt: "2026-11-16T02:01:00.000Z", feed: delayedFeed, checkTimestamp: false });
  assert.equal(stillRejected.accepted, false);
  assert.match(stillRejected.reason, /too_few_usable_items/);
});

test("defaults missing capture time and canonicalizes a supplied valid timestamp", () => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  assert.equal(validateCapturedAt(undefined, now), "2026-11-16T02:00:00.000Z");
  assert.equal(validateCapturedAt("2026-11-16T10:00:00+08:00", now), "2026-11-16T02:00:00.000Z");
});

test("rejects malformed and implausibly future capture timestamps", () => {
  const now = new Date("2026-11-16T02:00:00.000Z");
  assert.throws(() => validateCapturedAt("not-a-date", now), /valid date-time/);
  assert.throws(() => validateCapturedAt("2026-11-16T02:06:00.000Z", now), /future/);
  assert.equal(validateCapturedAt("2026-11-16T02:05:00.000Z", now), "2026-11-16T02:05:00.000Z");
});
