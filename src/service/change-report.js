export class ChangeReportService {
  constructor({ feeds, captures, articles }) {
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
  }

  report(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const [current, previous] = this.captures.effectivePair(feedId);
    if (!current || !previous) {
      return {
        feedId,
        ready: false,
        reason: "two accepted captures are required",
        latestCapture: current ?? null,
        previousCapture: previous ?? null,
        added: [],
        omitted: [],
        counts: { added: 0, omitted: 0, current: current?.normalizedCount ?? 0, previous: 0 }
      };
    }
    const before = this.articles.forCapture(previous.captureId);
    const after = this.articles.forCapture(current.captureId);
    const previousUrls = new Set(before.map((article) => article.canonicalUrl));
    const currentUrls = new Set(after.map((article) => article.canonicalUrl));
    const added = after.filter((article) => !previousUrls.has(article.canonicalUrl));
    const omitted = before.filter((article) => !currentUrls.has(article.canonicalUrl));
    return {
      feedId,
      ready: true,
      latestCapture: summarizeCapture(current),
      previousCapture: summarizeCapture(previous),
      added: added.map((article) => compactArticle(article, current.capturedAt)),
      omitted: omitted.map((article) => compactArticle(article, current.capturedAt)),
      counts: { added: added.length, omitted: omitted.length, current: after.length, previous: before.length },
      note: "Omission means absent from this listing capture, not that the publisher deleted the article."
    };
  }
}

function summarizeCapture(capture) {
  return {
    captureId: capture.captureId,
    capturedAt: capture.capturedAt,
    itemCount: capture.normalizedCount
  };
}

function compactArticle(article, observedAt) {
  return {
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    publishedAt: article.publishedAt,
    sourceIndex: article.sourceIndex,
    observedAt,
    currentVisibility: article.visibility
  };
}
