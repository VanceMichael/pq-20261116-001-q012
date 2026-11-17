export class EvidenceRepository {
  constructor(database) {
    this.database = database;
    this.insertEvidence = database.prepare(`INSERT INTO capture_evidence
      (capture_id, attempt, raw_html, records_json, rejected_json, policy_context_json,
       policy_fingerprint, parser_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.byCapture = database.prepare(`SELECT * FROM capture_evidence
      WHERE capture_id=? ORDER BY evidence_id DESC`);
    this.byId = database.prepare("SELECT * FROM capture_evidence WHERE evidence_id=?");
    this.nextAttempt = database.prepare("SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM capture_evidence WHERE capture_id=?");
  }

  create({ captureId, rawHtml, records, rejected, policyContext, policyFingerprint, parserVersion, createdAt }) {
    const attempt = Number(this.nextAttempt.get(captureId).attempt);
    const result = this.insertEvidence.run(
      captureId, attempt, rawHtml,
      JSON.stringify(records),
      JSON.stringify(rejected),
      JSON.stringify(policyContext),
      policyFingerprint,
      parserVersion,
      createdAt
    );
    return this.mapRow(this.byId.get(Number(result.lastInsertRowid)));
  }

  listForCapture(captureId) {
    return this.byCapture.all(captureId).map((row) => this.mapRow(row));
  }

  get(evidenceId) {
    const row = this.byId.get(evidenceId);
    return row ? this.mapRow(row) : null;
  }

  latestForCapture(captureId) {
    return this.listForCapture(captureId)[0] ?? null;
  }

  mapRow(row) {
    return {
      evidenceId: row.evidence_id,
      captureId: row.capture_id,
      attempt: row.attempt,
      rawHtml: row.raw_html,
      records: JSON.parse(row.records_json),
      rejected: JSON.parse(row.rejected_json),
      policyContext: JSON.parse(row.policy_context_json),
      policyFingerprint: row.policy_fingerprint,
      parserVersion: row.parser_version,
      createdAt: row.created_at
    };
  }
}
