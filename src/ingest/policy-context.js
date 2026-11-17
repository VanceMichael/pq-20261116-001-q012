import { createHash } from "node:crypto";

export const POLICY_FIELDS = ["baseUrl", "allowedHosts", "minimumItems", "missingThreshold"];

export function policyContext(feed) {
  return {
    baseUrl: feed.baseUrl,
    allowedHosts: [...feed.allowedHosts],
    minimumItems: feed.minimumItems,
    missingThreshold: feed.missingThreshold
  };
}

export function policyFingerprint(feedOrContext) {
  const context = POLICY_FIELDS.every((field) => field in feedOrContext)
    ? feedOrContext
    : policyContext(feedOrContext);
  const canonical = JSON.stringify({
    baseUrl: context.baseUrl,
    allowedHosts: [...context.allowedHosts],
    minimumItems: context.minimumItems,
    missingThreshold: context.missingThreshold
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function explainPolicyChange(storedContext, currentFeed) {
  const stored = storedContext ?? {};
  const current = policyContext(currentFeed);
  const changed = [];
  for (const field of POLICY_FIELDS) {
    if (JSON.stringify(stored[field] ?? null) !== JSON.stringify(current[field] ?? null)) {
      changed.push({
        field,
        storedValue: stored[field] ?? null,
        currentValue: current[field] ?? null
      });
    }
  }
  return {
    stale: changed.length > 0,
    changed,
    storedContext: stored,
    currentContext: current
  };
}
