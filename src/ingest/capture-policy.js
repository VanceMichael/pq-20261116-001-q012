export function assessCapture({ candidateCount, normalizedCount, rejectedCount, previousCount, feed, capturedAt, checkTimestamp = true }) {
  if (!Number.isInteger(candidateCount) || candidateCount < 0) return { accepted: false, reason: "invalid_candidate_count" };
  if (normalizedCount < feed.minimumItems) {
    return { accepted: false, reason: `too_few_usable_items:${normalizedCount}<${feed.minimumItems}` };
  }
  if (checkTimestamp && feed.lastAcceptedAt && capturedAt <= feed.lastAcceptedAt) {
    return { accepted: false, reason: "stale_capture_timestamp" };
  }
  const requiredFraction = previousCount > 0 ? Math.max(feed.minimumItems, Math.ceil(previousCount * 0.25)) : 0;
  if (previousCount > 0 && normalizedCount < requiredFraction) {
    return { accepted: false, reason: `unexpected_count_drop:${normalizedCount}<${requiredFraction}` };
  }
  const invalidBudget = Math.max(3, Math.floor(candidateCount * 0.5));
  if (rejectedCount > invalidBudget) {
    return { accepted: false, reason: `too_many_invalid_links:${rejectedCount}>${invalidBudget}` };
  }
  return { accepted: true, reason: null };
}

export function validateCapturedAt(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return now.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("capturedAt must be a valid date-time");
  if (parsed.getTime() > now.getTime() + 5 * 60 * 1000) throw new RangeError("capturedAt cannot be more than five minutes in the future");
  return parsed.toISOString();
}
