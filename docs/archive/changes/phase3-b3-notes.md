# Phase 3 批3 · 速赢交互包 施工记录（主理人亲自实现）

> 专家团模式已取消，本批起由主理人直接实现（批0/批2 团队模式验证后转入连续作业）。
> 范围=audit 终版 §6 批3 行：M1 取消接通 + M4 receipt 桥接 + M8 TTL 槽 + M5 健康门降级（批0 SKILL 面已闭环，本批补运行面确认）+ A2-12 GUI 判据接线。

## M1 · notifications/cancelled 主动取消通路
- 病灶实读：`mcp-framework/server.ts` 旧 :177-180 三 case 合并 `return null`（协议唯一主动取消通路被吞；直调 600s 长任务只能等被动断连）。
- 设计取舍：**不触碰 signal/raceAbort 路径**（既有测试④"监听器摘除恰一"严格钉=无界增长红线，signal 并集方案 composeSignals 试过、破坏监听计数保证，作废回退）。改用 inflightCancels 登记表（id→cancelGate reject 句柄）+ `Promise.race([handlerP, cancelGate])`；gate 抢先时 handlerP 孤儿 rejection 显式吞（防 unhandledRejection 崩进程）。
- 取消语义复用 ARCH-29 出口：isError+CANCELED_TEXT+`canceled:true,inFlightMayContinue:true`（协作式中止红线：不谎称已强杀 VM 内进程）；`clientCancelled` 标记仅用于日志归因分流，载荷形状与断连取消一致（宿主侧零新契约）。
- `/mcp` 路由既有 `result===null ⇒ 202` 处理在位（通知走 202 不炸）。
- 测试：`tests/unit/phase3-b3-cancel-notify.test.js` 5 例（在途取消/幽灵 id 静默/缺 requestId/settle 后表归零/initialized 行为不变）。

## M4 · audit.receipt 桥工具（README"可审计"卖点兑现）
- VM 端点 :1715 已建成（S-3）零消费者 ⇒ 宿主桥新增第 6 件工具 `audit.receipt`（只读标注）。
- bearer 三态**复用权威函数 `applyBearerHeader`**（与 establishTransport 逐字同纪律：未配=无凭据可通、给了未设值=fail-loud 先于出网转 AUTH_REQUIRED、绝不静默降级）；cli `--token-env` 同源接线。
- 呈现面兜底 scrubText（端点级脱敏之外的宿主侧双保险；测试钉 password 值不外泄）。
- 401/非 200/解析失败/隧道断四类归因码各自诚实（AUTH_REQUIRED/RECEIPT_FETCH_FAILED/RECEIPT_PARSE_FAILED/TUNNEL_UNAVAILABLE 复用）。
- 未命中=ok:true+计数 0+人话"链上为空才是硬未发生"（保持端点 200 非 4xx 设计 §9-F-3）。
- 测试：`phase3-b3-receipt-ttl.test.js` 10 例。

## M8 · 直调审批载荷 TTL 槽
- A2A 卡片侧 expiresAtMs 早已在位（task-store P3-3）；缺口=**MCP 直调 APPROVAL_REQUIRED 载荷**。
- 纯附加：`Number.isFinite(pendingApprovals.ttl)` 才写 `expiresAtMs/ttlMs`（Infinity ⇒ 键缺席=旧形状，零回归）；static 钉在 receipt-ttl 测试件内。

## A2-12 · GUI 三判据真实接线（core 导出后零消费=死判据面）
- `adapter-agent-workbuddy/index.ts` 会话守卫段改消费 `guiAllowed/nonGuiAllowed/describeSessionState`（import @winvm/core 既有边，dep-lint 零新边）。
- **拒绝集与旧逐字等价**（unavailable/black-screen 拒；degraded 只读探测带通过面不变=PR8 零放宽）。实现细节教训：初版 `!guiAllowed && !nonGuiAllowed` 会让 black-screen 误入带通过面（nonGuiAllowed 只排 unavailable）——修正为显式 black-screen 保留条件。
- **probeError 归因分流（病灶本体）**：探测未得结论旧实现误归"确不可用"（SESSION_UNAVAILABLE⇒Agent 学会别重试）；现契约层不扩码（封闭 10 码面），走 CL-017 D23 领域层 `reason='SESSION_PROBE_FAILED'` + retryable:true + runbook 指向文案。
- guiAllowed=false 带通过记 warn 显形（不再静默）。

## M5 · 健康门降级（运行面确认）
- SKILL 面批0 已闭环（ok:true 即放行+degraded 降级叙述）；运行面 server.ts degraded 合成本就正确（provider===undefined⇒exposed=meta.*），`a2a.health`/`/health` 归因字段在册（D30/CL-K3R E-3）——无代码缺口，登记确认。

## 验证记录
- `tsc -b` RC=0（两轮）；
- 新测：cancel-notify 5/5、receipt-ttl 10/10；
- 回归亲跑全绿：phase2-mcp-signal 54（含既有 cancelled-通知-null 钉不改判）、k5-replay 41、r19c-s4-policy-denied-audit 7、cl017-error-reason 10、host-adapter 35、phase2-session-unknown 48（B 组 guiAllowed 恒 false 矩阵未破）、r3-uninstall-verify 39、phase2-contract-code-fidelity 22、phase2-contract-schema 23。
