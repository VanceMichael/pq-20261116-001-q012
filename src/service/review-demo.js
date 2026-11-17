import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NewsArchive } from "../service/archive.js";

const BASE = "https://news.example.test/scroll-news/news1.html";
const HOSTS = ["news.example.test"];

function page(items) {
  const entries = items.map((item, index) => {
    const url = item.url ?? `/2026/11-16/article-${item.id}.shtml`;
    const title = item.title ?? `标题${item.id}`;
    const time = item.time ?? `2026-11-16T10:${String(index).padStart(2, "0")}:00+08:00`;
    return `<article><time datetime="${time}">${index}</time><a href="${url}">${title}</a></article>`;
  }).join("\n");
  return `<!doctype html><html><body><main id="news-list">${entries}</main></body></html>`;
}

const range = (count, start) => Array.from({ length: count }, (_, offset) => ({ id: start + offset }));
const at = (second) => `2026-11-16T02:00:${String(second).padStart(2, "0")}.000Z`;
const articleUrl = (id) => `https://news.example.test/2026/11-16/article-${id}.shtml`;

function heading(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

export async function runReviewDemo() {
  const directory = await mkdtemp(join(tmpdir(), "rolling-review-demo-"));
  const archive = new NewsArchive(join(directory, "archive.sqlite"));
  try {
    archive.registerFeed({ feedId: "topic-feed", baseUrl: BASE, allowedHosts: HOSTS, minimumItems: 3, missingThreshold: 3 });
    archive.registerFeed({ feedId: "license-feed", baseUrl: BASE, allowedHosts: HOSTS, minimumItems: 3, missingThreshold: 3 });

    heading("1. 真实列表收缩被数量保护拒绝，隔离页与解析证据被保留");
    archive.importSnapshot("topic-feed", page(range(16, 1)), at(1));
    const rejected = archive.importSnapshot("topic-feed", page(range(3, 14)), at(2));
    process.stdout.write(`拒绝原因: ${rejected.reason}\n`);
    const evidence = archive.captureEvidence("topic-feed", rejected.captureId);
    process.stdout.write(`证据保留: attempt=${evidence.latest.attempt} 解析条目=${evidence.latest.normalizedCount} 策略指纹=${evidence.latest.policyFingerprint.slice(0, 12)}…\n`);

    heading("2. 复核期间线上采到更新页面（自动接纳），旧隔离页仍在队列中");
    const mid = archive.importSnapshot("topic-feed", page(range(12, 30)), at(3));
    process.stdout.write(`新页面接纳: accepted=${mid.accepted} 条目=${mid.normalizedCount}\n`);
    process.stdout.write(`待复核队列: ${archive.reviewQueue("topic-feed").pending.length} 条\n`);

    heading("3. 运营确认真实收缩后放行：按原采集时间归位，不追加到当前列表末尾");
    const release = archive.releaseCapture("topic-feed", rejected.captureId, { operator: "op-li", note: "专题结束，列表真实收缩" });
    process.stdout.write(`放行: status=${release.status} 归位时间=${release.observedAt} 条目=${release.itemCount}\n`);
    const timeline = archive.articleTimeline("topic-feed", archive.articles.get("topic-feed", articleUrl(14)).articleId);
    process.stdout.write(`文章14出现位置(新→旧): ${timeline.observations.map((entry) => `capture${entry.captureId}@${entry.capturedAt.slice(17, 19)}s`).join(" , ")}\n`);

    heading("4. 对缺失计数与列表变化的影响");
    const omitted = archive.articles.get("topic-feed", articleUrl(1));
    process.stdout.write(`被收缩掉的文章1: missingStreak=${omitted.missingStreak} visibility=${omitted.visibility} seenCount=${omitted.seenCount}\n`);
    const retained = archive.articles.get("topic-feed", articleUrl(14));
    process.stdout.write(`保留的文章14: missingStreak=${retained.missingStreak} visibility=${retained.visibility} seenCount=${retained.seenCount}\n`);
    const changes = archive.feedChanges("topic-feed");
    process.stdout.write(`列表变化: 新增=${changes.counts.added} 缺失=${changes.counts.omitted} 当前=${changes.counts.current} 之前=${changes.counts.previous}\n`);

    heading("5. 重复确认幂等，不再计一次出现");
    const again = archive.releaseCapture("topic-feed", rejected.captureId, { operator: "op-li" });
    process.stdout.write(`重复放行: idempotent=${again.idempotent} 文章14 seenCount 仍为=${archive.articles.get("topic-feed", articleUrl(14)).seenCount}\n`);

    heading("6. 主机许可变化后旧证据过期：可解释、先拦截、重试重解析");
    archive.importSnapshot("license-feed", page(range(8, 1)), at(1));
    const mixed = page([
      { id: 30 }, { id: 31 },
      { id: 999, url: "https://bad.test/2026/x.shtml", title: "外站链接" }
    ]);
    const licenseReject = archive.importSnapshot("license-feed", mixed, at(2));
    process.stdout.write(`许可变更前拒绝: ${licenseReject.reason}\n`);
    archive.upholdCapture("license-feed", licenseReject.captureId, { operator: "op-wang", note: "疑似残缺页，先维持拒绝" });
    archive.registerFeed({ feedId: "license-feed", baseUrl: BASE, allowedHosts: ["news.example.test", "bad.test"], minimumItems: 3, missingThreshold: 3 });
    const blocked = archive.releaseCapture("license-feed", licenseReject.captureId, { operator: "op-wang" });
    process.stdout.write(`旧证据放行被拦: ${blocked.error}; 变化字段=${blocked.policyChange.changed.map((change) => change.field).join(",")}\n`);
    const retried = archive.retryCapture("license-feed", licenseReject.captureId, { operator: "op-wang", note: "许可更新后重解析" });
    process.stdout.write(`重试: status=${retried.status} 新证据attempt=${retried.evidence.attempt} 重解析条目=${retried.evidence.normalizedCount} 归位时间=${retried.observedAt}\n`);

    heading("7. 规则收紧后重试仍失败；全程可追踪，原拒绝记录不改写");
    const ruleReject = archive.importSnapshot("topic-feed", page(range(2, 60)), at(4));
    process.stdout.write(`第二次收缩拒绝: ${ruleReject.reason}\n`);
    archive.registerFeed({ feedId: "topic-feed", baseUrl: BASE, allowedHosts: HOSTS, minimumItems: 5, missingThreshold: 3 });
    const staleRule = archive.releaseCapture("topic-feed", ruleReject.captureId, { operator: "op-zhao" });
    process.stdout.write(`规则变更后旧证据: ${staleRule.error} (${staleRule.policyChange.changed.map((change) => `${change.field}:${change.storedValue}→${change.currentValue}`).join(",")})\n`);
    const failedRetry = archive.retryCapture("topic-feed", ruleReject.captureId, { operator: "op-zhao" });
    process.stdout.write(`收紧规则下重试: ${failedRetry.status} 闸门原因=${failedRetry.reason}\n`);
    const manual = archive.releaseCapture("topic-feed", ruleReject.captureId, { operator: "op-zhao", note: "人工确认真实收缩，未调低任何全局阈值" });
    process.stdout.write(`新证据上人工放行: status=${manual.status} applied=${manual.applied}\n`);
    process.stdout.write(`原拒绝行保留: accepted=${archive.captures.getById("topic-feed", ruleReject.captureId).accepted} reason=${archive.captures.getById("topic-feed", ruleReject.captureId).reason}\n`);
    process.stdout.write(`决定日志: ${archive.captureReviewHistory("topic-feed", ruleReject.captureId).decisions.map((decision) => decision.decision).join(" → ")}\n`);

    heading("8. 完整性审计");
    const audit = archive.auditIntegrity();
    process.stdout.write(`审计状态: ${audit.status}（${audit.checks.map((check) => `${check.name}=${check.passed ? "pass" : "fail"}`).join(", ")}）\n`);
  } finally {
    archive.close();
    await rm(directory, { recursive: true, force: true });
  }
  return 0;
}
