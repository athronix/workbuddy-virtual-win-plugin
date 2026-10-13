# Phase 3 批5 · 验证面恢复 施工记录（主理人亲自实现，分批推进中）

> 范围=audit 终版 §6 批5 行：A2-14 审计链保留期（**用户终裁参数 90 天 ∧ <2GB 超限删最老**）+ R-5 取消风暴门禁化（用户 B）+ T13 防再发（用户 A+要求）+ Q2/Q3/长跑四债/真机 E2E。
> 本文件先记 A2-14，其余项随进度 append。

## A2-14 · 审计链保留期（已落地）

### 设计（纯附加，缺席即逐字旧行为）
- `RetentionPolicy { maxAgeDays, maxTotalBytes, minKeepShards?=2 }`，两标准**各自独立**判定（超龄 OR 超体积命中任一即入可删集）。
- `planShardPrune(shards, {policy, protectedNames, nowMs})` **纯函数判定面**（不触盘），单测可直接断言，无需真建真删。
- `HashChainAuditSink.pruneShards()` 执行面 + `startRetentionSweep(intervalMs, onPrune)` 低频定时器（unref，不阻退出）。

### 五条安全红线（写进 planShardPrune 守卫）
1. **活动片保护**：`protectedNames = activeShards ∪ 最新一片`，永不删（现部署 freshChainOnStart=true ⇒ 活动链与新链分离，删归档片不伤 verifyChain 判定，这是安全前提）；
2. **年龄取文件名日期**（`prefix-YYYYMMDD[-idx].jsonl`，UTC）而非 mtime——规避 QA 在基线查法发现的"mtime 被 checkout 复制重置⇒判据失准"同族坑；文件日期解析失败⇒视为"最新"绝不删（对删除保守）；
3. **minKeepShards 下限**（默认 2）：无论判多超龄，存活片数绝不跌破下限——防"配置写错/时钟漂移一次性清空整目录"；
4. **两阶段**：先标记"过期事实"（体积累计 + 年龄），再从最老落地且守 minKeep——removable 严格按从老到新序，杜绝混序裁错；
5. **fail-safe 全程不抛**：stat 读不到的片不纳入判据（不删看不见的东西）；unlink 单片失败跳过下轮再试；清理异常绝不冒泡到主写入路径。

### 删除留痕（审计自证纪律）
prune 删片这件事本身**必须入链**，否则保留期=静默抹除通道。`onPrune` 回调落一条 `__meta.retention.prune`（channel:'internal'，风险 L0），清理事实放 `params`（分片名非敏感键，redact 原样保留）——**不新增 ext 枚举成员**（扩 union 类型需跨契约一致性，成本高于收益，登记为设计选择）。

### 配置装配（用户"默认即安全"哲学）
- `AuditConfig` 平铺 `retentionMaxAgeDays/retentionMaxTotalBytes/retentionMinKeepShards`（不走嵌套对象，config-key-lint 白名单派生面最稳）；
- **出厂 DEFAULT_SERVICE_CONFIG 即启用 90 天 ∧ 2GB**（与 fail-closed 显式默认同族："磁盘无上界增长"是默认事实而非需用户想起来配置）；两标准全 ≤0 ⇒ 禁用逐字旧行为；
- server.ts 装配点：listen 后 `startRetentionSweep`（6h 低频 + 启动先跑一次），close() 首步 `stopRetention`（退出竞态里不"边关边删"，同 pendingApprovals.close 纪律）。

### 验证
- `planShardPrune` 纯函数 8 例 + `pruneShards` 端到端（真实 tmpdir）5 例 = **13/13 绿**（`tests/unit/phase3-b5-audit-retention.test.js`）；
- 回归亲跑全绿：audit 既有链 / cl018-config 7 / host-adapter 35 / k5-replay 41 / assembly-guard 24 / phase2-dead-config 14（retention 缺席=禁用故既有测试零影响）；
- `tsc -b` RC=0；`gate --quick` VERDICT GREEN（config-keys 未知键=0=新三键被类型派生白名单放行；guards files=8 166 例含新 skill-claims）。

## T13 防再发（已落地：写路径串行修复本就到位，本批补"回归锁死 + 跨片接链"）

### 亲验结论：分叉根因修复**早已在位**（不是待修，是待钉）
chain.ts:481-494 `append()` 的 D30 竞态修复注释白纸黑字——旧实现"进串行区之前同步取号（seq/prevHash），状态回写延后到写盘完成 ⇒ 并发取到同 seq/同 prevHash ⇒ 链分叉（真机实证三天分片 672 条恰两处重复 seq：511 与 582）"，**现全部状态读写移入 `writeQueue` 串行闭包**。用户要的"确保以后不再出现存档指向错乱"= 把这条修复**锁死成回归**（否则某次重构悄悄把取号挪回串行外，1889 单测无感——正是 psmod-contract 那类"跨函数隐式契约编译器看不见"的同款失效）。

### 新增 `tests/unit/phase3-b5-chain-fork-guard.test.js`（3 例）
1. **50 条并发齐射**（单 tick Promise.all，非串行 await）⇒ 断言落盘 seq 恰为 1..50 无重无漏 + verifyChain valid（重复 seq=D30 分叉复活当场红）；
2. **并发 + 强制轮转**（maxFileBytes=200 逼出多片）⇒ "存档指向错乱"就发生在片边界接链；独立复核（不依赖 verifyChain 内部）逐条验 prevHash==前驱 hash + 自哈希重算，跨片全链 valid；
3. **两轮重启续链** ⇒ 第二轮接第一轮尾 hash、seq 延续不重置（跨轮接链正确性）。

### 为何不新增"跨片 prevHash 连续性判据进 verifyArchive"
verifyArchive 的**片内基线取自本片首条**（O-8 设计：轮转片首条 prevHash 指向上一片尾条，若硬用 GENESIS 起步则每片正常历史全报 CHAIN_BREAK=噪音，正是设计点名要防的形态）。跨片首条接链关系在片内**无从**校验，其可信性由写它那天的 verifyChain 全链判定负责——而 verifyChain 现已并发安全（本批锁死）。**扩 verifyArchive 做跨片比对 = 与 O-8 设计冲突**，采"锁死写路径串行"这一更根本的处方（分叉在生产侧被杜绝 ⇒ 归档侧自然无分叉可检）。登记为设计判断，交后续 review。

## Q2 守卫三修 / Q3 孤儿接线 / A2-3/5/6/7 长跑四债 / R-5 取消风暴门禁化 / 真机 E2E（待做，部分依赖真机窗口）

## R-5 · 取消风暴门禁化（已落地 2026-10-13）

### 病灶与处方
真机实证 198 任务 × 并发 8 的 `tasks/cancel` 打挂 vm-service + ~90 孤儿 node。根因链：每次 `requestCancel` → `cancelController.abort` + `updateStatus('canceled')`，对 provider=workbuddy 的 LLM **常驻会话**而言 abort 打断当前轮 ⇒ 触发会话重建；批量并发 cancel ⇒ 重建风暴 ⇒ 崩溃。MEMORY 红线"单条 cancel 端到端 ~3.4s 已属重操作"。**用户终裁 B=主动排期**（不等触发器 T-2 再赌运气）。

### 落点（纯附加，缺省禁用逐字旧行为）
- `packages/a2a-framework/src/rate-limiter.ts`：`CancelRateLimiter` 滑动窗口限流器（纯函数式计数，可注入 now 供离线单测零等待；无定时器、无状态泄漏——旧桶随窗口滑出丢弃；被拒不入窗口=不消耗预算也不污染）。
- `A2AServer` 装配 `cancelRateLimit?: CancelRateLimit`（opts 纯附加）；tasks/cancel 分支**前置消费闸**：超限直接 `fail` 拒回（不进 requestCancel ⇒ 不打断常驻会话、不触发重建）。**拒绝发生在 task 查找之前**（测试用 ghost id 证明：首个到 requestCancel 报 TaskNotFound，第二个必 rateLimited 而非 TaskNotFound ⇒ 坐实挡在风暴源头之前）。
- `resolveCancelRateLimit(env)`（constants.ts，照 resolveApprovalTtlMs 先例）：**缺省 10/1000ms**——判据=人工/单 Agent 串行取消（198 串行需 198×3.4s）远低于此，只有批量并发风暴触顶；env 显式 `WINVM_CANCEL_RATE_MAX=0` ⇒ 禁用（保留旧行为），非 0 非法值回退默认。
- vm-service 装配 `cancelRateLimit: resolveCancelRateLimit(process.env)`。
- 测试 `phase3-b5-cancel-storm-gate.test.js` 12 例（限流器 5 + env 4 + A2AServer 端到端 3，含 200 齐射仅 10 过）。

## A2-3 · idle 回收不再吃故障重启预算（已落地 2026-10-13）

### 病灶（主理人逐行亲验坐实）
`spawnOnce()` 无条件 `spawnAttempts += 1` → `restarts = spawnAttempts - 1` 单调爬升；而 idle TTL 回收（`tick()→dispose()` 软释放回 stopped）与 ws 超限回收**都走同一条 dispose 路径**，其后的重建照样占计数 ⇒ 长跑挂机（每 idleTtl 周期自然回收一次）把"计划内正常回收"与"真故障重建"混记同一本账，累计到 `maxRestarts` 即 `disabled` 永久停用（仅 restartFresh 手工可解，正常路径无自动复位）。

### 修复（最小侵入，保留观测价值）
- 新增两私有字段 `plannedRecycles`（计划内回收计数）+ `recyclePending`（一次回收待其重建消费的标志）；
- `tick()` 两处软释放（idle TTL / ws 超限）各置 `recyclePending=true`；`spawnOnce()` 消费（`recyclePending` 在场 ⇒ `plannedRecycles++` 并清标志，**一次回收只抵消一次重建，绝不虚增**；回收后若不重建则标志保留，不虚增 plannedRecycles）；
- `ensureReady()` 熔断判据改 `faultRestarts = max(0, restarts − plannedRecycles)`；**`restarts` getter 不动**（/health 仍如实反映总重建数=观测价值保留，只是不再是熔断判据的唯一来源）；
- `restartFresh()` 复位时 `plannedRecycles/recyclePending` 一并清零（与 spawnAttempts 归零同义"状态机从头开始"）；
- **无计划内回收时 plannedRecycles=0 ⇒ 判据逐字等于旧行为** ⇒ 既有故障路径测试（spawnFault/r19c/cl018 走的是不经 tick 的路径）恒不受影响（已亲验 restartF=0，既有 4 件全绿）。

### 判别性测试 `phase3-b5-idle-recycle-budget.test.js` 5 例
① 6 轮 idle 回收在 maxRestarts=2 下永不 disabled（**修复前此处必红**=判别力证明）；② 纯故障重建（spawnFault 不经 tick）仍正常熔断 ⇒ 修复未削弱真故障保护；③ 混合（先回收后故障）故障预算足额可用（回收未预支）；④ ws 超限回收 5 轮同不占预算；⑤ restartFresh 清零两新计数。复刻 r19c FakeChild 夹具 + 可控时钟，零真实 CLI 依赖。

## 仍待做（依赖真机窗口或后续批次）
Q2 守卫三修（snapshot-truth 解构绕过/config-key-lint 静默绿/s5 恒真）、Q3 孤儿测试接线（e2e/smoke + delivery/__tests__）、A2-5/6/7 长跑债（ps-bridge 自愈文案/重放不 settle/SSE 空转）、真机 E2E 回归批（P0-4：5域×2通道 18 例重跑 + V1-V13 psmod 生效窗口）。
