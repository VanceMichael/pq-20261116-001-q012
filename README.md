# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
npm run review-demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。`review-demo` 使用本地合成页面走通运营复核全流程：真实列表收缩被拒、复核期间新采集、按原采集时间放行、规则/主机许可变化后的过期处理与重试。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录（含复核状态）。
- `GET /v1/feeds/:feedId/review-queue`：列出待复核的拒绝快照及其最新证据与过期状态。
- `GET /v1/feeds/:feedId/captures/evidence?captureId=...`：读取隔离页保留的原始 HTML、解析记录、被拒链接与当时策略快照。
- `POST /v1/feeds/:feedId/captures/:captureId/review`：提交复核动作，`action` 为 `release`、`uphold` 或 `retry`，需带 `operator`，可选 `note`；`GET` 读取该快照的追加式复核决定日志。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

## 运营复核通道

专题结束后目录会正常缩短，数量下降保护不应逼操作员调低来源质量阈值。被拒页面进入复核队列而不是被丢弃：

- **证据保留**：拒绝时在同一事务内保存原始 HTML、规范化记录、被拒链接（含原始 href）、拒绝原因，以及解析时的策略上下文与指纹（`capture_evidence` 表，按重试次数保留多个版本）。
- **放行（release）**：运营确认真实收缩后，隔离页按其**原采集时间**归入有效快照序列，不会被塞到当前列表末尾。文章的首次/末次出现、出现次数、缺失连续计数和可见性会基于全部有效快照重新计算；重复确认是幂等的，不会再计一次出现。
- **维持拒绝（uphold）**：保留人工判断，不改动任何归档数据。
- **过期与重试（retry）**：来源的 `minimumItems`、`missingThreshold`、`baseUrl` 或 `allowedHosts` 变化后，旧证据的策略指纹与当前策略不一致，放行先被拒绝并返回逐字段的可解释差异。重试使用保留的 HTML 在当前规则下重新解析：闸门仍失败则记录 `retry_failed` 且不写入任何文章数据；闸门通过则以 `auto_retry` 在历史位置自动应用。人工仍可在新证据上放行，无需调整全局阈值。
- **可追踪性**：`captures` 表的原始拒绝行（`accepted=0` 与原因）永不改写；所有人工与系统决定追加在 `capture_review_decisions` 中（`release`、`uphold`、`auto_retry`、`retry_failed`、`blocked_stale`），含操作人、备注、前后策略指纹和闸门原因。有效快照通过 `effective_captures` 视图定义为“自动接纳或经放行/自动重试”，变更报告、文章时间线和完整性审计均以此为准。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
