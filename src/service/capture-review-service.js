import { extractLinks } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { assessCapture } from "../ingest/capture-policy.js";
import { policyContext, policyFingerprint, explainPolicyChange } from "../ingest/policy-context.js";

export const PARSER_VERSION = "html-parser:1";

const NOTE_PATTERN = /[\u0000-\u001f\u007f]/g;

export class CaptureReviewService {
  constructor({ feeds, captures, evidence, decisions, historical, clock = () => new Date() }) {
    this.feeds = feeds;
    this.captures = captures;
    this.evidence = evidence;
    this.decisions = decisions;
    this.historical = historical;
    this.clock = clock;
  }

  queue(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    const pending = this.decisions.pending(feedId, limit);
    return {
      feedId,
      pending: pending.map((capture) => this.enrichPending(capture))
    };
  }

  captureEvidence(feedId, captureId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    const capture = this.captures.getById(feedId, captureId);
    if (!capture) return { status: 404, error: "capture_not_found" };
    const rows = this.evidence.listForCapture(captureId);
    const latest = rows[0] ?? null;
    return {
      status: 200,
      capture: this.captures.enrichWithReview(capture),
      latest: latest ? this.summarizeEvidence(feed, latest) : null,
      attempts: rows.map((row) => this.summarizeEvidence(feed, row))
    };
  }

  history(feedId, captureId, limit) {
    const feed = this.feeds.get(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    const capture = this.captures.getById(feedId, captureId);
    if (!capture) return { status: 404, error: "capture_not_found" };
    return {
      status: 200,
      capture: this.captures.enrichWithReview(capture),
      decisions: this.decisions.decisions(captureId, limit)
    };
  }

  release(feedId, captureId, input = {}) {
    const decidedBy = normalizeOperator(input.operator);
    const note = normalizeNote(input.note);
    const feed = this.feeds.get(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    const capture = this.captures.getById(feedId, captureId);
    if (!capture) return { status: 404, error: "capture_not_found" };
    if (capture.accepted) return { status: 409, error: "capture_was_accepted_automatically", capture };

    const effective = this.decisions.effectiveDecision(captureId);
    if (effective) {
      return { status: 200, idempotent: true, decision: effective, capture: this.captures.enrichWithReview(capture) };
    }
    const latest = this.evidence.latestForCapture(captureId);
    if (!latest) return { status: 409, error: "evidence_missing", message: "rejected capture has no preserved parse evidence" };
    const staleness = explainPolicyChange(latest.policyContext, feed);
    if (staleness.stale) {
      const decisionId = this.decisions.record({
        captureId, feedId, evidenceId: latest.evidenceId, decision: "blocked_stale",
        decidedBy, note, priorPolicyFingerprint: latest.policyFingerprint,
        currentPolicyFingerprint: policyFingerprint(feed), gateReason: "policy_changed_since_evidence",
        decidedAt: this.clock().toISOString()
      });
      return {
        status: 409, error: "evidence_stale", decisionId,
        message: "feed rules or host allowlist changed after the evidence was parsed; retry to re-parse first",
        policyChange: staleness
      };
    }
    const result = this.historical.apply({
      feedId,
      captureId,
      evidence: latest,
      records: latest.records,
      recordDecision: ({ evidenceId, decidedAt }) => this.decisions.record({
        captureId, feedId, evidenceId, decision: "release",
        decidedBy, note, priorPolicyFingerprint: latest.policyFingerprint,
        currentPolicyFingerprint: latest.policyFingerprint, gateReason: null,
        decidedAt
      })
    });
    return { status: 200, ...result, capture: this.captures.enrichWithReview(this.captures.getById(feedId, captureId)) };
  }

  uphold(feedId, captureId, input = {}) {
    const decidedBy = normalizeOperator(input.operator);
    const note = normalizeNote(input.note);
    const feed = this.feeds.get(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    const capture = this.captures.getById(feedId, captureId);
    if (!capture) return { status: 404, error: "capture_not_found" };
    if (this.decisions.effectiveDecision(captureId)) {
      return { status: 409, error: "capture_already_released", capture: this.captures.enrichWithReview(capture) };
    }
    const latest = this.evidence.latestForCapture(captureId);
    const decisionId = this.decisions.record({
      captureId, feedId, evidenceId: latest?.evidenceId ?? null, decision: "uphold",
      decidedBy, note, priorPolicyFingerprint: latest?.policyFingerprint ?? null,
      currentPolicyFingerprint: policyFingerprint(feed), gateReason: capture.reason,
      decidedAt: this.clock().toISOString()
    });
    return { status: 200, decisionId, upheld: true, capture: this.captures.enrichWithReview(capture) };
  }

  retry(feedId, captureId, input = {}) {
    const decidedBy = normalizeOperator(input.operator);
    const note = normalizeNote(input.note);
    const feed = this.feeds.get(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    const capture = this.captures.getById(feedId, captureId);
    if (!capture) return { status: 404, error: "capture_not_found" };
    if (capture.accepted) return { status: 409, error: "capture_was_accepted_automatically", capture };
    const effective = this.decisions.effectiveDecision(captureId);
    if (effective) {
      return { status: 200, idempotent: true, decision: effective, capture: this.captures.enrichWithReview(capture) };
    }
    const predecessor = this.captures.effectivePair(feedId)
      .filter((item) => item.captureId !== captureId && item.capturedAt < capture.capturedAt)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
    const previousCount = predecessor ? predecessor.normalizedCount : 0;

    const current = policyContext(feed);
    const currentFingerprint = policyFingerprint(current);
    const rawHtml = this.rawHtmlFor(captureId);
    const candidates = extractLinks(rawHtml, feed.baseUrl);
    const normalized = normalizeCandidates(candidates, { baseUrl: feed.baseUrl, allowedHosts: feed.allowedHosts });
    const previousEvidence = this.evidence.latestForCapture(captureId);
    const reevaluation = assessCapture({
      candidateCount: candidates.length,
      normalizedCount: normalized.records.length,
      rejectedCount: normalized.rejected.length,
      previousCount,
      feed,
      capturedAt: capture.capturedAt,
      checkTimestamp: false
    });
    const evidenceRow = this.evidence.create({
      captureId,
      rawHtml: this.rawHtmlFor(captureId),
      records: normalized.records,
      rejected: normalized.rejected,
      policyContext: current,
      policyFingerprint: currentFingerprint,
      parserVersion: PARSER_VERSION,
      createdAt: this.clock().toISOString()
    });
    const staleness = previousEvidence
      ? explainPolicyChange(previousEvidence.policyContext, feed)
      : { stale: false, changed: [], storedContext: null, currentContext: current };

    if (!reevaluation.accepted) {
      const decisionId = this.decisions.record({
        captureId, feedId, evidenceId: evidenceRow.evidenceId, decision: "retry_failed",
        decidedBy, note, priorPolicyFingerprint: previousEvidence?.policyFingerprint ?? null,
        currentPolicyFingerprint: currentFingerprint, gateReason: reevaluation.reason,
        decidedAt: this.clock().toISOString()
      });
      return {
        status: 422, error: "quality_gate_still_failing", decisionId,
        reason: reevaluation.reason, policyChange: staleness,
        evidence: this.summarizeEvidence(feed, evidenceRow),
        capture: this.captures.enrichWithReview(capture)
      };
    }
    const applied = this.historical.apply({
      feedId,
      captureId,
      evidence: evidenceRow,
      records: normalized.records,
      recordDecision: ({ evidenceId, decidedAt }) => this.decisions.record({
        captureId, feedId, evidenceId, decision: "auto_retry",
        decidedBy, note, priorPolicyFingerprint: previousEvidence?.policyFingerprint ?? null,
        currentPolicyFingerprint: currentFingerprint, gateReason: null,
        decidedAt
      })
    });
    return {
      status: 200,
      ...applied,
      policyChange: staleness,
      evidence: this.summarizeEvidence(feed, evidenceRow),
      capture: this.captures.enrichWithReview(this.captures.getById(feedId, captureId))
    };
  }

  enrichPending(capture) {
    const latest = this.evidence.latestForCapture(capture.captureId);
    const feed = this.feeds.get(capture.feedId);
    return {
      ...capture,
      evidence: latest ? this.summarizeEvidence(feed, latest) : null,
      staleness: latest ? explainPolicyChange(latest.policyContext, feed) : { stale: true, changed: [], storedContext: null, currentContext: policyContext(feed) },
      review: this.captures.reviewSummary(capture.captureId)
    };
  }

  summarizeEvidence(feed, row) {
    return {
      evidenceId: row.evidenceId,
      captureId: row.captureId,
      attempt: row.attempt,
      parserVersion: row.parserVersion,
      createdAt: row.createdAt,
      policyFingerprint: row.policyFingerprint,
      policyContext: row.policyContext,
      stale: explainPolicyChange(row.policyContext, feed).stale,
      candidateCount: row.records.length + row.rejected.length,
      normalizedCount: row.records.length,
      rejectedCount: row.rejected.length,
      records: row.records,
      rejected: row.rejected
    };
  }

  rawHtmlFor(captureId) {
    const latest = this.evidence.latestForCapture(captureId);
    if (!latest) throw new Error(`no preserved HTML for capture ${captureId}`);
    return latest.rawHtml;
  }
}

function normalizeOperator(value) {
  if (value === undefined || value === null || value === "") throw new TypeError("operator is required");
  if (typeof value !== "string") throw new TypeError("operator must be text");
  const normalized = value.normalize("NFC").replace(NOTE_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 200) throw new RangeError("operator must contain 1 to 200 characters");
  return normalized;
}

function normalizeNote(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("note must be text");
  const normalized = value.normalize("NFC").replace(NOTE_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1000) throw new RangeError("note must contain 1 to 1000 characters");
  return normalized;
}
