import { EFFECTIVE_DECISIONS } from "./capture-review-repository.js";

export class CaptureRepository {
  constructor(database) {
    this.database = database;
    this.findFingerprint = database.prepare("SELECT * FROM captures WHERE feed_id=? AND fingerprint=?");
    this.insertCapture = database.prepare(`INSERT INTO captures
      (feed_id, fingerprint, captured_at, accepted, candidate_count, normalized_count,
       rejected_count, duplicate_count, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.listCaptures = database.prepare(`SELECT * FROM captures WHERE feed_id=?
      ORDER BY capture_id DESC LIMIT ?`);
    this.byId = database.prepare("SELECT * FROM captures WHERE capture_id=? AND feed_id=?");
    this.latestEffective = database.prepare(`SELECT capture_id, captured_at, normalized_count FROM effective_captures
      WHERE feed_id=? ORDER BY capture_id DESC LIMIT 2`);
    this.reviewStatus = database.prepare(`SELECT decision, decided_by, decided_at, note, evidence_id
      FROM capture_review_decisions WHERE capture_id=? ORDER BY decision_id DESC LIMIT 1`);
    this.effectiveStatus = database.prepare(`SELECT decision FROM capture_review_decisions
      WHERE capture_id=? AND decision IN ('release', 'auto_retry') ORDER BY decision_id ASC LIMIT 1`);
  }

  findByFingerprint(feedId, fingerprint) {
    const row = this.findFingerprint.get(feedId, fingerprint);
    return row ? mapCapture(row) : null;
  }

  create({ feedId, fingerprint, capturedAt, accepted, candidateCount, normalizedCount,
    rejectedCount, duplicateCount, reason = null }) {
    const result = this.insertCapture.run(feedId, fingerprint, capturedAt, Number(accepted),
      candidateCount, normalizedCount, rejectedCount, duplicateCount, reason);
    return Number(result.lastInsertRowid);
  }

  recent(feedId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.listCaptures.all(feedId, safeLimit).map(mapCapture);
  }

  getById(feedId, captureId) {
    if (!Number.isSafeInteger(captureId) || captureId < 1) return null;
    const row = this.byId.get(captureId, feedId);
    return row ? mapCapture(row) : null;
  }

  effectivePair(feedId) {
    return this.latestEffective.all(feedId).map(mapCapture);
  }

  reviewSummary(captureId) {
    const effectiveRow = this.effectiveStatus.get(captureId);
    const effective = effectiveRow ? effectiveRow.decision : null;
    const latest = this.reviewStatus.get(captureId);
    return {
      reviewState: effective ? "released" : latest ? "reviewed" : "none",
      effectiveDecision: effective,
      latestDecision: latest ? latest.decision : null,
      latestDecidedBy: latest ? latest.decided_by : null,
      latestDecidedAt: latest ? latest.decided_at : null,
      latestNote: latest ? latest.note : null,
      evidenceId: latest ? latest.evidence_id : null
    };
  }

  enrichWithReview(capture) {
    if (!capture) return capture;
    const review = this.reviewSummary(capture.captureId);
    return { ...capture, review, effective: capture.accepted || EFFECTIVE_DECISIONS.has(review.effectiveDecision) };
  }
}

function mapCapture(row) {
  return {
    captureId: row.capture_id,
    feedId: row.feed_id,
    fingerprint: row.fingerprint,
    capturedAt: row.captured_at,
    accepted: Boolean(row.accepted),
    candidateCount: row.candidate_count,
    normalizedCount: row.normalized_count,
    rejectedCount: row.rejected_count,
    duplicateCount: row.duplicate_count,
    reason: row.reason
  };
}
