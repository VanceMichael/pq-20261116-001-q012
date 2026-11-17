import { extractLinks, pageFingerprint } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { validateFeedId } from "../store/feed-repository.js";
import { assessCapture, validateCapturedAt } from "./capture-policy.js";
import { policyContext, policyFingerprint } from "./policy-context.js";
import { PARSER_VERSION } from "../service/capture-review-service.js";

export class ImportService {
  constructor({ database, feeds, captures, articles, evidence, clock = () => new Date() }) {
    this.database = database;
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
    this.evidence = evidence;
    this.clock = clock;
  }

  importHtml(feedId, html, capturedAtValue) {
    validateFeedId(feedId);
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const capturedAt = validateCapturedAt(capturedAtValue, this.clock());
    const fingerprint = pageFingerprint(html);
    const previous = this.captures.findByFingerprint(feedId, fingerprint);
    if (previous) return { ...previous, replay: true, stats: this.articles.stats(feedId) };

    const candidates = extractLinks(html, feed.baseUrl);
    const normalized = normalizeCandidates(candidates, { baseUrl: feed.baseUrl, allowedHosts: feed.allowedHosts });
    const policy = assessCapture({
      candidateCount: candidates.length,
      normalizedCount: normalized.records.length,
      rejectedCount: normalized.rejected.length,
      previousCount: feed.lastItemCount,
      capturedAt,
      feed
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const captureId = this.captures.create({
        feedId,
        fingerprint,
        capturedAt,
        accepted: policy.accepted,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason: policy.reason
      });
      if (policy.accepted) {
        this.articles.recordCapture(captureId, feed, normalized.records, capturedAt);
        this.feeds.markAccepted(feedId, capturedAt, normalized.records.length);
      } else if (this.evidence) {
        this.evidence.create({
          captureId,
          rawHtml: html,
          records: normalized.records,
          rejected: withRejectedHrefs(normalized.rejected, candidates),
          policyContext: policyContext(feed),
          policyFingerprint: policyFingerprint(feed),
          parserVersion: PARSER_VERSION,
          createdAt: capturedAt
        });
      }
      this.database.exec("COMMIT");
      return {
        captureId,
        feedId,
        fingerprint,
        capturedAt,
        accepted: policy.accepted,
        replay: false,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason: policy.reason,
        rejected: normalized.rejected,
        stats: this.articles.stats(feedId)
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function withRejectedHrefs(rejected, candidates) {
  return rejected.map((entry) => ({ ...entry, href: candidates[entry.index]?.href ?? null }));
}
