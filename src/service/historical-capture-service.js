export class HistoricalCaptureService {
  constructor({ database, feeds, captures, articles, clock = () => new Date() }) {
    this.database = database;
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
    this.clock = clock;
  }

  apply({ feedId, captureId, evidence, records, recordDecision }) {
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const capture = this.captures.getById(feedId, captureId);
    if (!capture) throw new Error(`unknown capture: ${captureId}`);
    if (capture.accepted) throw new Error(`capture ${captureId} was accepted automatically and cannot be re-applied`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const locked = this.captures.getById(feedId, captureId);
      if (this.captures.reviewSummary(captureId).effectiveDecision) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "already_effective", capture: locked };
      }
      const decisionId = recordDecision({ evidenceId: evidence?.evidenceId ?? null, decidedAt: this.clock().toISOString() });
      records.forEach((record, index) => {
        this.articles.applyHistoricalObservation(
          feedId, captureId, record, index, locked.capturedAt
        );
      });
      const sequence = this.articles.recomputeFeed(feedId, feed.missingThreshold);
      const newest = sequence[sequence.length - 1] ?? null;
      if (newest && Number(newest.capture_id) === captureId) {
        this.feeds.markAccepted(feedId, locked.capturedAt, locked.normalizedCount);
      }
      const stats = this.articles.stats(feedId);
      this.database.exec("COMMIT");
      return {
        applied: true,
        decisionId,
        captureId,
        feedId,
        observedAt: locked.capturedAt,
        itemCount: records.length,
        evidenceId: evidence?.evidenceId ?? null,
        stats
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
