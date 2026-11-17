import test from "node:test";
import assert from "node:assert/strict";
import { policyContext, policyFingerprint, explainPolicyChange } from "../../src/ingest/policy-context.js";

const feed = {
  feedId: "daily-main",
  baseUrl: "https://news.example.test/scroll-news/news1.html",
  allowedHosts: ["news.example.test"],
  minimumItems: 3,
  missingThreshold: 3,
  lastAcceptedAt: null
};

test("builds a stable policy context without carrying runtime feed state", () => {
  assert.deepEqual(policyContext(feed), {
    baseUrl: "https://news.example.test/scroll-news/news1.html",
    allowedHosts: ["news.example.test"],
    minimumItems: 3,
    missingThreshold: 3
  });
});

test("produces identical fingerprints for equivalent rules and distinct ones for changes", () => {
  const first = policyFingerprint(feed);
  const second = policyFingerprint(policyContext(feed));
  assert.equal(first, second);
  assert.notEqual(first, policyFingerprint({ ...feed, minimumItems: 5 }));
  assert.notEqual(first, policyFingerprint({ ...feed, allowedHosts: ["news.example.test", "cdn.example.test"] }));
  // host ordering alone must not change the fingerprint
  const reordered = policyFingerprint({ ...feed, allowedHosts: ["news.example.test"] });
  assert.equal(reordered, first);
});

test("explains exactly which rule or host fields changed for stale evidence", () => {
  const stored = policyContext(feed);
  const tightened = explainPolicyChange(stored, { ...feed, minimumItems: 5 });
  assert.equal(tightened.stale, true);
  assert.deepEqual(tightened.changed, [{ field: "minimumItems", storedValue: 3, currentValue: 5 }]);
  const hostChange = explainPolicyChange(stored, { ...feed, allowedHosts: ["news.example.test", "cdn.example.test"] });
  assert.deepEqual(hostChange.changed.map((change) => change.field), ["allowedHosts"]);
  const unchanged = explainPolicyChange(stored, { ...feed });
  assert.equal(unchanged.stale, false);
  assert.deepEqual(unchanged.changed, []);
});
