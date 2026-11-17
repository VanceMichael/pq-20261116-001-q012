export const EFFECTIVE_DECISIONS = new Set(["release", "auto_retry"]);

export class CaptureReviewRepository {
  constructor(database) {
    this.database = database;
    this.insertDecision = database.prepare(`INSERT INTO capture_review_decisions
      (capture_id, feed_id, evidence_id, decision, decided_by, note,
       prior_policy_fingerprint, current_policy_fingerprint, gate_reason, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.listForCapture = database.prepare(`SELECT * FROM capture_review_decisions
      WHERE capture_id=? ORDER BY decision_id DESC LIMIT ?`);
    this.effectiveForCapture = database.prepare(`SELECT * FROM capture_review_decisions
      WHERE capture_id=? AND decision IN ('release', 'auto_retry') ORDER BY decision_id ASC`);
    this.pendingFeed = database.prepare(`SELECT c.* FROM captures c
      WHERE c.feed_id=? AND c.accepted=0
        AND NOT EXISTS (
          SELECT 1 FROM capture_review_decisions d
          WHERE d.capture_id=c.capture_id AND d.decision IN ('release', 'auto_retry')
        )
      ORDER BY c.capture_id DESC LIMIT ?`);
    this.decisionByCaptureType = database.prepare(`SELECT * FROM capture_review_decisions
      WHERE capture_id=? AND decision=? ORDER BY decision_id DESC LIMIT 1`);
  }

  record({ captureId, feedId, evidenceId, decision, decidedBy, note = null,
    priorPolicyFingerprint = null, currentPolicyFingerprint = null,
    gateReason = null, decidedAt }) {
    const result = this.insertDecision.run(captureId, feedId, evidenceId, decision, decidedBy,
      note, priorPolicyFingerprint, currentPolicyFingerprint, gateReason, decidedAt);
    return Number(result.lastInsertRowid);
  }

  decisions(captureId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.listForCapture.all(captureId, safeLimit).map(mapDecision);
  }

  effectiveDecision(captureId) {
    const row = this.effectiveForCapture.all(captureId)[0] ?? null;
    return row ? mapDecision(row) : null;
  }

  latestOfType(captureId, decision) {
    const row = this.decisionByCaptureType.get(captureId, decision);
    return row ? mapDecision(row) : null;
  }

  pending(feedId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.pendingFeed.all(feedId, safeLimit).map(mapCaptureRow);
  }
}

function mapDecision(row) {
  return {
    decisionId: row.decision_id,
    captureId: row.capture_id,
    feedId: row.feed_id,
    evidenceId: row.evidence_id,
    decision: row.decision,
    decidedBy: row.decided_by,
    note: row.note,
    priorPolicyFingerprint: row.prior_policy_fingerprint,
    currentPolicyFingerprint: row.current_policy_fingerprint,
    gateReason: row.gate_reason,
    decidedAt: row.decided_at
  };
}

function mapCaptureRow(row) {
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
