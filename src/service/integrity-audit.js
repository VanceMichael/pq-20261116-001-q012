export class IntegrityAuditService {
  constructor(database) {
    this.database = database;
    this.integrityCheck = database.prepare("PRAGMA integrity_check");
    this.foreignKeyCheck = database.prepare("PRAGMA foreign_key_check");
    this.captureLinkMismatches = database.prepare(`SELECT c.capture_id,
      COALESCE((SELECT json_array_length(e.records_json) FROM capture_evidence e
        WHERE e.capture_id=c.capture_id
          AND e.evidence_id=(SELECT MAX(d.evidence_id) FROM capture_review_decisions d
                             WHERE d.capture_id=c.capture_id AND d.decision IN ('release','auto_retry'))),
               c.normalized_count) AS expected_count,
      COUNT(ci.article_id) AS linked_count FROM effective_captures c
      LEFT JOIN capture_items ci ON ci.capture_id=c.capture_id
      GROUP BY c.capture_id
      HAVING expected_count != linked_count`);
    this.articleCountMismatches = database.prepare(`SELECT a.article_id, a.seen_count,
      (SELECT COUNT(*) FROM capture_items ci2
        JOIN effective_captures ec2 ON ec2.capture_id=ci2.capture_id
       WHERE ci2.article_id=a.article_id) AS observed_count
      FROM articles a
      WHERE a.seen_count != (
        SELECT COUNT(*) FROM capture_items ci2
        JOIN effective_captures ec2 ON ec2.capture_id=ci2.capture_id
        WHERE ci2.article_id=a.article_id
      )`);
    this.feedWatermarkMismatches = database.prepare(`SELECT f.feed_id, f.last_accepted_at, f.last_item_count,
      c.captured_at AS expected_at, c.normalized_count AS expected_count
      FROM feeds f LEFT JOIN effective_captures c ON c.capture_id=(
        SELECT capture_id FROM effective_captures WHERE feed_id=f.feed_id ORDER BY capture_id DESC LIMIT 1
      ) WHERE (f.last_accepted_at IS NOT c.captured_at) OR (f.last_item_count != COALESCE(c.normalized_count, 0))`);
  }

  run() {
    const checks = [
      { name: "sqlite_integrity", rows: this.integrityCheck.all().filter((row) => row.integrity_check !== "ok") },
      { name: "foreign_keys", rows: this.foreignKeyCheck.all() },
      { name: "capture_item_counts", rows: this.captureLinkMismatches.all() },
      { name: "article_observation_counts", rows: this.articleCountMismatches.all() },
      { name: "feed_watermarks", rows: this.feedWatermarkMismatches.all() }
    ].map((check) => ({
      name: check.name,
      passed: check.rows.length === 0,
      issueCount: check.rows.length,
      examples: check.rows.slice(0, 10)
    }));
    return {
      status: checks.every((check) => check.passed) ? "consistent" : "inconsistent",
      checkedAt: new Date().toISOString(),
      checks
    };
  }
}
