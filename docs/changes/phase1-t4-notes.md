# Phase 1 · T4 装配层实施笔记（vm-service：ARCH-05/06/07/22 + ENG-01/05）

- 基线 HEAD：`3932014`（T1 `4983a58` / T2 `6e9b951` / T3 `1283846`）
- 工程师：寇豆码（software-engineer-1）
- 主理人：team-lead（只做核验与提交）
- 环境：node=`/data/storage/el1/bundle/libs/arm64/node/bin/node`；git=`/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`（只读）；构建=`node node_modules/typescript/bin/tsc -b tsconfig.build.json`

## §0 开工计划

### 0-1 文件清单（任务卡指派）

| # | 文件 | 动作 | 关联判据 |
|---|------|------|----------|
| A | `packages/vm-service/src/http-guard.ts` | 新增（createBearerGuard 纯函数） | ⑤ |
| B | `packages/vm-service/src/pending-approvals.ts` | 新增（PendingApprovalRegistry） | ⑥ |
| C | `packages/vm-service/src/approval-replay.ts` | +`recordApprovalDecisionAudit`（ARCH-05） | ①②④(O-7) |
| D | `packages/vm-service/src/delegation-audit.ts` | terminalState 口径核对 / TASK_CANCELED 文案归属 | ⑦ |
| E | `packages/vm-service/src/server.ts` | 只动 §7.2 十区 | ①-⑦ |
| F | `packages/vm-service/src/index.ts` | 两个新纯模块再导出 | — |
| T | `tests/unit/phase1-t4-http-guard.test.js` | 新增 | ⑤ |
| T | `tests/unit/phase1-t4-pending-approvals.test.js` | 新增 | ⑥ |
| T | `tests/unit/phase1-t4-assembly.test.js` | 新增（决策审计/证据面/health） | ①②③④⑦ |

### 0-4 server.ts 十区域实测行号表（HEAD=3932014，改动前基线）

| §7.2 区域 | 设计基线读数 | **T4 实测** | 锚文本 | 本批动作 |
|---|---|---|---|---|
| VmApprovalCoordinator | `:141-284` | **`:141-284`**（类）；`raise` `:204-283` | `export class VmApprovalCoordinator implements ApprovalCoordinator {` | 区1 |
| HashChainAuditSink 创建 | `:378-383` | **`:378-383`** | `const audit = new HashChainAuditSink({` | 不动值 |
| bypassTagSink 装配 | `:399-401` | **`:399-401`** | `const auditSink = bypassTagSink(` | 只读参照 |
| provider warmup | `:489-491` | **`:489-491`** | `if (provider && provider.kind === 'llm-agent') {` | 区2（其后 +verifyArchive） |
| pendingApprovals Map | `:535` | **`:535`** | `const pendingApprovals = new Map<string, PendingApproval>();` | 区3 → Registry |
| TaskStore 构造 | `:544-558` | **`:544-558`** | `const taskStore = new TaskStore({` | 区4 |
| （不动）executeCapability 策略段 | `:589-690` | `:589-690` | — | **禁碰** |
| 重放段 replay | `:696-730` | **`:696-730`** | `const replay: ReplayFn = async (p: PendingApproval)` | 区5（仅 +注释） |
| MCP 审批块 | `:752-882` | **`:752-882`** | `handler: async (params, ctx) => {` | 区6（Registry 同签名，文本零改） |
| delegationObserver | `:908-980` | **`:908-980`**（terminalState 三分支现二分支 `:934-935`） | `const delegationObserver: DelegationObserver = {` | 区7 |
| HTTP 路由 | `:1065-1218` | **`:1065-1218`** | `const server = createServer((req, res) => {` | 区8（挂守卫） |
| buildHealth | `:1261-1359` | **`:1261-1359`**（audit 块 `:1343-1348`） | `async function buildHealth(` | 区9 |
| close() | `:1386-1394` | **`:1386-1394`** | `async close() {` | 区10 |
| （不动）dry-run 三函数 | `:1400-1481` | `:1400-1481` | `function buildPreview(` | **禁碰** |

⇒ **§7.2 基线读数与当前工作区完全一致**（`3932014` 未动 server.ts，行号零漂移）。

### 0-5 守卫输入面预检清单（动笔前全量 grep，命中即逐字保住）

**读 `packages/vm-service/src/server.ts` 源码文本作静态断言的守卫文件（共 10 个）**：
`assembly-guard` / `r19c-a5-approval-coordinator`（+A0 读 **dist**）/ `r19c-a5-fix4-risk`（读 dist）/ `r19c-kn1-e-shape` / `r19c-kn1-e-mutation` / `k5-replay`（E 组）/ `cl019-health-ageMs` / `cl020-f2-a2a-netcfg-capture` / `cl018-psmod-c456` / `install-vm-admin-endpoint`（读 ps1，不涉本文件）。

钉字面清单（server.ts）：
1. `if (!taskId || !this.tasks)`、`const taskId = req.taskId ?? this.activeTaskId;`、`this.tasks.waitApproval(taskId, enriched)`（**A0 读 dist** ⇒ 改 src 后必须重建 dist）
2. `export class VmApprovalCoordinator implements ApprovalCoordinator {`（assembly-guard S4-m5 变异锚）
3. `void recordPolicyDeniedAudit(` **恰 2 处**、两处 `if (!verdict.allowed) {` 块、块内调用在 return 前、`channel:`、import 自 `'./approval-replay.js'`、server.ts 内不得出现 `function recordPolicyDeniedAudit(`（计数判据 ⇒ **新决策函数不得同名**）
4. `endTask(taskId?: string): void {`、`if (taskId !== this.activeTaskId) return;`、`if (!taskId) {`=无条件清空形态
5. `reason: 'no-active-task'` + `this.logger?.warn(` 400 字节内
6. `approvalCoordinator.setLogger(logger);`、`approvalCoordinator.bind(a2a.tasks, pendingApprovals);`（**逐字符 = 两空格缩进 + 原文** ⇒ Registry 替换只改声明行文本，bind 行零改）
7. `const storedState = taskStore.tryGet(taskId)?.task.status.state;`
8. `snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state`（kn1-e-shape:428 + **kn1-e-mutation E-6 变异锚** = 含换行的两行字面 `const terminalState =\n        snap.state === …` ⇒ **O-3 三分支只能前插 `canceled` 分支、后两分支文本与换行缩进逐字不动**）
9. `result?.error?.reason ??`（errorCode 兜底链首环在场；**canceled 前置分支合法**——已核 `r19c-kn1-a-pure.test.js:227` 钉的是产出条目 `result.summary` 而非源码，无 `EXECUTION_FAILED` 计数钉）
10. `\n            terminalState,\n`（12 空格实参透传）+ doesNotMatch `terminalState:\s*'failed',`
11. `const delegationObserver: DelegationObserver = {`、`onGoalAccepted(goal: GoalRequest): void {`、`onGoalTerminal(taskId: string, goal: GoalRequest, snap: DelegationTerminalSnapshot): void {`、`\n  delegationObserver,\n`、`from './delegation-audit.js';`
12. `process.env['WINVM_ADMIN_ENDPOINT']` **全文件恰 1 处读取** + 路由门控块逐字（e4_gate_first 变异锚三行字面）+ ADMIN_ROUTE 内 `\baudit.append(` 零出现 + `url.searchParams.get('faultInjection') === '1'`
13. 路由切片锚（sliceRoute 起点/终点必须**相邻成立**）：`if (path === '/mcp' && req.method === 'POST')`→`if (path === '/audit/receipt'`；`if (path === '/audit/receipt' && req.method === 'GET')`→`if (path === '/a2a' && req.method === 'POST')`；ADMIN 起点→兜底 404 `\n        sendJson(res, 404, { error: 'not found', path });`（8 空格）⇒ **守卫挂载点不得把任一锚推进切片内**（决策：挂在 `url/path` 解析后、405 前，位于所有路由 if 之前）
14. `const receiptCache = new ReceiptCache(`、`const auditSink = bypassTagSink(`（E-1 变异锚区）
15. `approvalCoordinator.setReplay(replay)`、`approvalCoordinator.setReplayEnabled(resolveApprovalReplay())`、`approvalCoordinator.noteTimeout(approvalId)`（k5-replay 接线钉 ⇒ **onApprovalTimeout 体内 noteTimeout 行逐字保位**）
16. `hostApproved: false`、`hostApproved === true`、`if (token) token.hostApproved = true;`、`this.pendingApprovals?.delete(req.approvalId)`（K4 安全点逐字）
17. `if (!exposedIds.has(p.capabilityId))`、`executeCapability(cap, p.params`、`${p.traceId ?? newTraceId()}-replay`
18. cl019/cl020：`Date.parse(netCfgCache.collectedAt)`、`Number.isFinite(parsedAt)`、`parsedAt` 声明行、`netCfgCache:{…collectedAt?: string}`、`const prewarmRes = await runtime.bridge.call`、`prewarmCollectedAt`、`reportNetCfg` 注入与签名、禁止 `res.ok && cap.id === 'system.network.config'` 复现
19. C3（`r19c-a5`）：全仓 `packages/*/src` 的 `cancelRequested` 恰 4 处且形态钉死 ⇒ **T4 任何注释/代码不得出现该字面量**（用"标志位"指称）
20. kn1-e-mutation 其它 server.ts 变异锚：`{ delegationId: dtid }` 行、`dtid ? { delegationId: dtid } : undefined`（E-1）

**读 `delegation-audit.ts`**：kn1-e-shape:348-357 + kn1-e-mutation:224-226 ⇒ 不得把 `buildReceiptResponse`/`buildDelegationAuditEntry`/`clipReceipt` 搬入 server.ts；`DELEGATION_CAPABILITY_ID` 等纯逻辑件签名面不动。
**读 `approval-replay.ts`**：assembly-guard 仅断言 server.ts 的 import 来源 ⇒ 该文件加新函数安全；但新函数**不得叫 `recordPolicyDeniedAudit`**。
**读 a2a-framework/src/server.ts**：`updateStatus(\n taskId, 'rejected' )` 恰 1 处（T3 已交付，本批不触）。
**测试替身面（行为兼容约束）**：`r19c-a5` 的 `spyStore()` 只有 `waitApproval/updateStatus/tryGet` 三成员、无 `isCancelled` ⇒ `raise` 内取消判据必须 `this.tasks.isCancelled?.(taskId) === true`（可选调用 + 严格等值），且必须在 `this.tasks` 真值分支内（D 组 bridge 用例经真实 TaskStore 全路径）。`tryGet()` 恒 undefined 的 spy 走可选链 ⇒ 安全。
**零钉面确认（本次改动不触碰）**：`const pendingApprovals = new Map…`、`new TaskStore({`、`freshChainOnStart`、`audit: {`（health）在全部测试中无源码文本断言（`audit.test.js` 的 `freshChainOnStart: true` 是自己的夹具）。

**预判：无需改任何守卫**——所有设计强制改动均可在钉字面不动的前提下完成（三分支前插、guard 挂路由前、bind 行零改）。若实施中发现反例 ⇒ 已按协议报备主理人（见 §10，唯一一处：D-23）。

---

## §1 文件 A：`packages/vm-service/src/http-guard.ts`（新增，ARCH-07 / ENG-05）

**导出面**：`GuardVerdict` / `GuardDenyReason` / `GuardableRequest` / `GuardWarnSink` / `BearerGuardOptions` / `DEFAULT_EXEMPT_PATHS` / `BEARER_UNAUTHORIZED_BODY` / `createBearerGuard` / `resolveBearerToken` / `HealthAuthMode` / `resolveAuthMode` / `isLoopbackHost`。零跨包依赖（只 import `node:crypto`）⇒ 可脱 ps-bridge 直测。

| 设计口径 | 实现落点 | 判据 |
|---|---|---|
| O-9 双条件（`enforceBearer===true` **且** env[tokenEnv] 非空） | `resolveBearerToken()` 单一判据源；`createBearerGuard` 与 `resolveAuthMode` **共用**它 ⇒ 事实面/执行面同源 | ⑤ |
| `enforceBearer=false` ⇒ 路由逐字旧行为 | 构造期 `expected===undefined` ⇒ 返回 `() => ({verdict:'pass'})` 常量函数；装配层另有 `guardActive` 早退（双保险：连 `bearerGuard(req)` 都不调用） | ⑤ |
| `timingSafeEqual` 长度不等先拒 | `tokenEquals()`：`presented.length !== expected.length ⇒ false`，随后**唯一一次**常时比较 | ⑤ |
| 豁免表硬编码（`/health` + agent-card，GET-only） | `DEFAULT_EXEMPT_PATHS = Object.freeze(['/health','/.well-known/agent-card.json'])`；判据含 `req.method === 'GET'` ⇒ `POST /health` 不豁免 | ⑤ |
| `/admin/llm-session/reset` **不**豁免 | 不在豁免表内 ⇒ 走完整校验（该端点有能力效果：杀常驻会话子进程） | ⑤ |
| 401 体 `{error:'unauthorized', code:'AUTH_REQUIRED'}` | `BEARER_UNAUTHORIZED_BODY`（`Object.freeze`，`as const`）；**不进** `BridgeErrorCode` 枚举（T1 在 `contracts/src/errors.ts` 已注释此边界） | ⑤ |
| 拒绝不入审计链 | `deny()` 只 `logger.warn`（reason/method/path/remoteAddress/presentedDigest）⇒ 未授权探测不占写链配额 | ⑤ |
| 非法 URL | `extractPath` 保守返回全串 ⇒ 不命中豁免（fail-closed） | ⑤ |
| 空 `Bearer `（只有前缀） | 判 `malformed-authorization-header`（与"没发 token"可区分） | ⑤ |
| 数组型 header（Node 罕见但类型允许） | 取首元素；非 string ⇒ malformed | ⑤ |

**中途回改（纪律修正）**：首稿曾用「两侧各取 SHA-256 摘要后常时比较」以消除长度早退信道 ⇒ 与设计文档 §1.4-2 字面「`timingSafeEqual`，**长度不等先拒**」不符 ⇒ 已回改为 `tokenEquals()`。`createHash` 仅保留给日志 `digestPrefix()`（不可还原指纹，使"发了错 token"与"没发 token"在日志里可分辨）。

**追加 `isLoopbackHost()`**（区 9 需要 `boundLoopback`）：判据与 `core/src/config/index.ts:127` 的私有 `isLoopback` **逐字同枚举**（`127.0.0.1`/`localhost`/`::1`/`[::1]`，**不做** `127.` 前缀宽容 —— 首稿写了 `startsWith('127.')` 已撤回，两处判据若漂移就会出现"配置校验拒绝启动、health 却自称回环"的矛盾事实）。刻意不 import core 私函数（导出会扩公开面；本模块保持零依赖纯函数）。

## §2 文件 B：`packages/vm-service/src/pending-approvals.ts`（新增，ENG-01）

- `SweeperEntry`（`createdAtMs` + `hostApproved?`）⇒ 不反向依赖 `server.ts` 的 `PendingApproval`；`PendingApproval` 结构上已满足。
- `ApprovalTokenMap<V>` 窄接口面：`get/set/delete/has/size/values/entries/keys/forEach/[Symbol.iterator]`。`PendingApprovalRegistry<V extends SweeperEntry> implements ApprovalTokenMap<V>` ⇒ `server.ts` 三类调用点与 `collectApprovalFacts(ReadonlyMap)` 形参**签名不变**。
- `ttlMs` 归一：非有限 / ≤0 ⇒ `POSITIVE_INFINITY`（= 未启用过期语义，逐字旧行为），与 `TaskStore.approvalTtlMs` / `resolveApprovalTtlMs` 的"坏配置不打挂服务、也不悄悄改语义"同构。
- `sweepExpired(now?)` / `sweepExpiredEntries(now?)`：**O-10 跳过 `hostApproved===true`**（在途重放保护）；判据 `createdAtMs + ttlMs < now`（严格小于 ⇒ 边界同刻不逐，杜绝与 `waitApproval` setTimeout 双写）。
- `startTimer(intervalMs?, onSwept?)`：默认周期 `max(60_000, ttlMs/4)`；句柄 `unref?.()`；`closed` 后不再复活（幂等）；回调内 try/catch + warn（取证面纪律）。
- `close()`：`closed=true` + `clearTimer` + 句柄置空 ⇒ 判据⑥。`get ttl` / `timerHandle` / `isClosed` 供测试与 health 读取。
- 零审计 import（被逐条目**回传调用方**，由 `server.ts` 落 `timeout` 决策）⇒ 依赖方向不破。

## §3 文件 C：`approval-replay.ts` +ARCH-05 决策取证 +ARCH-06 归档条目

### §3-1 `recordApprovalDecisionAudit(audit, logger, input, newAuditId, opts)`
- 复用既有 `BlockedAuditOptions`（`channel` 默认 `'mcp'` ⇒ 本批装配传 `'a2a' | 'internal'`）与 `:111-114` 的 try/catch 纪律。
- 条目形态 = 设计文档 §1.2-1 **唯一权威字段表**逐字实现：`policyDecision={allowed:false, matchedRule:'approval-decision:<decision>'}`；`approval={approvalId, approvedBy:actor, approvedAt:<ISO now>, previewHash:''}`；`result={ok:false, errorCode:'APPROVAL_'+DECISION, summary:'approval-decision:<decision>（未执行）'}`；`ext={kind:'approval-decision', decision, taskId?, delegationId?, channel}`（**条件展开**，禁显式 undefined）。
- **O-5**：链写异常 ⇒ `{ok:false,error}` + warn，决策结果不回改；`opts.onRecorded` 的异常单独 catch + warn（账本登记失败不得连坐取证条目）。
- **不叫 `recordPolicyDeniedAudit`**（assembly-guard 有计数钉 `void recordPolicyDeniedAudit(` 恰 2 处 ⇒ 新函数同名即红）。
- **`ApprovalDecisionSink` 的 `taskId` 声明为 `?:`**：MCP 直调（无 active task）与令牌表 TTL 两条路径本就无 taskId ⇒ 与 `ApprovalDecisionAuditInput.taskId?` 同源同形。

### §3-2 `buildChainArchiveVerifyAuditEntry(input, newAuditId)`
只**造条目**不写链（⇒ 写链点留在 `server.ts`，O-7 的"用哪个 sink"是装配层纪律，不该被纯函数替读者决定）。字段（设计 §1.3-3）：`capabilityId:'meta.audit.chain'`、`risk:'L0'`、`principal.channel:'internal'`、`policyDecision={allowed:true, matchedRule:'internal:chain-archive-verify'}`、`result.ok = broken.length===0`（断裂时 `errorCode:'ARCHIVE_CHAIN_BROKEN'`）、summary「已校验 N/M 片无断裂（K 片超出上界未校验）」、`ext={kind:'chain-archive-verify', archive:{shardsTotal, shardsVerified, broken}}`、`params={shardsTotal, shardsVerified, notVerified}`。
**分源纪律**：`shardsTotal` 取 `verifyChain().shardsTotal` 而不是有界结果集长度（`ARCHIVE_VERIFY_MAX_SHARDS=30` 截断若冒充总数 ⇒ 假证据形态，§1.3-2 明令防）。

## §4 文件 D：`delegation-audit.ts` —— **零改动**（口径核对结论）

核对方法：`grep -n "terminalState" delegation-audit.ts` ⇒ 三处引用（`:552` 类型声明 `readonly terminalState?: TaskState`、`:605` 条件展开进 `ext`、`:622` summary `delegation.complete:${input.terminalState ?? …}`）。
- `TaskState` 来自 `@winvm/contracts`，T1 已含 `'canceled'` ⇒ 类型面天然可表达，**无需扩**;
- `:605` 是 `input.terminalState ? {…} : {}` 条件展开 ⇒ 纯附加纪律已满足；
- `:622` summary 直接插值终态字符串 ⇒ `'canceled'` 自动写成 `delegation.complete:canceled`，无硬编码枚举白名单；
- `TASK_CANCELED` 文案**不属本文件**（本文件的 `errorCode` 是透传 `input.errorCode`，判定值由 `server.ts` 区 7 产出）。
⇒ 任务卡 D 项「若需 `TASK_CANCELED` 文案则改此」的**条件不成立**，本文件零 diff。判据⑦的链上断言由既有 `r19c-kn1-a-pure` 夹具面（钉产出条目 `result.summary`，不钉源码枚举）放行。

## §5 文件 E：`server.ts` 十区逐区落地（行号为上一回合落盘读数；**当前工作区读数以 §9 为准**，二者差异仅为后续修补造成的 ±2~64 行漂移）

| 区 | 实测行号 | 动作摘要 |
|---|---|---|
| 1 协调器 | `:157-260` 类头/字段/新方法；`raise` `:330-442` | +`decidedApprovals:Set`、+`decisionSink`/`setDecisionSink()`、+`recordDecision()`（O-6 判存即返回 → `approved` 早退不落链 → sink 缺席 no-op → try/catch+warn O-5）、+`pruneDecided()`/`decidedSize`；字段类型 `Pick<TaskStore,'waitApproval'\|'tryGet'\|'isCancelled'>` + `ApprovalTokenMap<PendingApproval>`（**bind 调用行文本逐字未动**，改为多行形参声明）；`raise` 否定分支插 `isCancelled?.(taskId) === true` ⇒ O-4 顺序 `canceled > timeout > rejected`；批准分支 `if (token) token.hostApproved = true;` 之后追加登记 |
| 2 sink/启动 | `:537`（`freshChainOnStart:true` **值未动**）；`:669-693` 新增 | warmup 块后 fire-and-forget：`verifyArchive()`（有界不抛，O-8）+ `verifyChain()` 取 `shardsTotal` ⇒ `buildChainArchiveVerifyAuditEntry` ⇒ **`await audit.append(entry)`（原始 sink = O-7）**，全程 try/catch + warn |
| 3 Registry | 现 `:762` | `new PendingApprovalRegistry<PendingApproval>({ ttlMs: resolveApprovalTtlMs(), logger })` |
| 4 TaskStore | `:786-…` | 显式 `maxTasks: TASK_STORE_MAX_TASKS` / `terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS`（模块级常量，与框架缺省逐字同值，**不新造 env 旋钮**）；`onApprovalTimeout` 内 `approvalCoordinator.noteTimeout(approvalId)` **逐字保位**，其后接 `recordDecision('timeout', actor:'approval-ttl')`（O-6 去重）+ Registry 删除 |
| 5 重放段 | `:980` 前插注释 | **仅注释**，零行为改动（设计文档 §5 第 2 条：approved 不落链，枚举预留 ARCH-09） |
| 6 MCP 审批块 | — | 语义零改；令牌 `set` 走 Registry（同签名 ⇒ 文本零改） |
| 7 observer | `:1209-1229` | **O-3 三分支** + `canceledTerminal` 前置 ⇒ `errorCode:'TASK_CANCELED'`（判据⑦）；三条钉字面（`storedState` 行 / `failed&&rejected?…` 同行连续 / 12 空格 `terminalState,`）全部保住 |
| 8 HTTP 路由 | 现 `:1443`（`const path`（`:1423`）后、405 前） | `if (guardActive) { const verdict = bearerGuard(req); if (deny) sendJson(res,401,BEARER_UNAUTHORIZED_BODY) }` ⇒ 位于**所有路由 if 之前**（含 `/admin/llm-session/reset`），且不侵入任何 sliceRoute 锚区间 |
| 9 buildHealth | 现 `:1655` 定义 `buildSecurityHealth()`；audit 块 `:1757`、security `:1778`、tasks `:1781` | +audit 四字段（`scope/shardsVerified/shardsTotal/shardsArchived`，皆条件展开；`chainValid` 语义逐字不变）+ `security: buildSecurityHealth()`（三态 authMode 与守卫同源；`boundLoopback` 读实测 `server.address()`）+ `tasks: {live, maxTasks, terminalTtlMs}` |
| 10 close() | 现 `:1827`（`pendingApprovals.close()`） | `pendingApprovals.close()`（置于 `sessionMonitor.stop()` 之后、provider shutdown 之前） |
| 装配线 | 现 `:1368-1416`（`setDecisionSink` `:1368` / `startTimer` `:1400` / `pruneDecided` `:1415`） | `setDecisionSink(…)` ⇒ 写**原始 `audit`**、`channel = delegationId ? 'a2a' : 'internal'`、`.then(r => !r.ok && warn)`；`startTimer(undefined, onSwept)` ⇒ 每条落 `timeout`/`'mcp-ttl-sweep'` + `pruneDecided(pendingApprovals.keys())` |

**`buildSecurityHealth` 的 TDZ 核对**：`server`（`:1342`）在 `buildHealth` 定义之前创建，而 `bridgeCtx.healthSnapshot` 只在请求期回调 ⇒ 无 TDZ；listen 前 `address()` 返回 `undefined` ⇒ 回落 `cfg.server.host`（保守，不谎报）。

## §6 文件 F：`index.ts` 再导出

`approval-replay` 组 +`buildChainArchiveVerifyAuditEntry` / `recordApprovalDecisionAudit` + 类型（`ApprovalDecision` / `ApprovalDecisionAuditInput` / `ApprovalDecisionSink` / `BlockedAuditOptions` / `ChainArchiveVerifyAuditInput`）；新模块 `http-guard` 全纯函数面 + 全类型面；`pending-approvals` 类 + 全类型面。目的单一：**判据可脱 ps-bridge 直测**。


---

## §7 缺口对账（主理人 22:0x 巡检 → 实测态）

主理人列的缺口与工作区实测（`ls` + `git status --porcelain` + `tsc -b`）：

| 主理人巡检项 | 实测 | 处置 |
|---|---|---|
| `tsc -b` exit 1，恰 1 error：`server.ts(230,25)` taskId 形状不兼容 | ✅ 复现 | **已修**（见 §8 / D-22 裁断）|
| M `server.ts` / `approval-replay.ts`；?? `http-guard.ts` / `pending-approvals.ts` | ✅ 一致 | 继续，不重做 |
| 未动 `delegation-audit.ts` / `vm-service/src/index.ts` | **部分失真**：`index.ts` 已在上一回合再导出两新模块（含 `buildSecurityHealth` 补齐）；`delegation-audit.ts` 确实零改动（判据⑦文案属 server.ts，见 §4） | 复核后按需 |
| `tests/unit/` 零 T4 新测试 | **失真**：已有 `phase1-t4-http-guard.test.js`(40) / `phase1-t4-pending-approvals.test.js`(28) 两文件且全绿；缺 `phase1-t4-assembly.test.js` | 已补第三文件（§11） |
| `$HOME/wbtmp/` 无 t4 留档 | ✅ 一致 | 本轮生成 `t4-full-run.txt` + `t4-run-all.mjs` |
| notes 停在 §0 | ✅ 一致 | 本节起补 |
| 区 5/7/8/9/10 未动 | **失真**：上一回合已落 区5（注释）/区7（三分支+TASK_CANCELED）/区8（守卫挂载）/区9（audit 四字段+security+tasks）/区10（close 停表） | 逐区复核（§8-§10） |

⇒ 以工作区实际为准：本轮做的是「修编译 + 复核十区 + 补第三测试文件 + 全量跑测 + notes」。

## §8 编译修复与一处契约裁断（D-22）

**症状**：`server.ts(230,25)` — `ApprovalDecisionSink` 形参把 `taskId` 声明为**必填 `string`**，而 `ApprovalDecisionAuditInput.taskId?: string`（T1 契约 `AuditExt.decision?` 的 ext 成员同为可选）。协调器 `recordDecision(input: ApprovalDecisionAuditInput)` 直接把 input 转交 sink ⇒ 类型收窄失败。

**两个候选解**：
1. 调用点判空/收窄（`taskId: input.taskId ?? ''`）——**否决**：落链 `ext.taskId` 会变成空串事实，MCP 直调（无 active task）与令牌表清扫两条本就无 taskId 的路径会写出「有 taskId 但是空的」假证据；也违反 `recordApprovalDecisionAudit` 内的条件展开语义（`input.taskId ? {...} : {}` 对 `''` 落空 ⇒ 键缺席，但中间态多造了一个谎言字段）。
2. **把 sink 形参与 input 对齐为可选**（`taskId?: string`）——**采纳**。

**裁断依据（须与 T1 契约字段形状一致）**：
- 契约 `contracts/src/audit.ts` 的 `AuditExt.decision?: 'approved'|'rejected'|'timeout'|'canceled'` 与 `taskId?: string` 皆为**可选附加成员**；落链条目对无 taskId 的决策**必须整键缺席**（条件展开），不是写空值。
- canonicalJson 假断链坑（T3 notes §8 共享知识）：显式 `undefined` 会被序列化成 `null` 参与哈希，而 `JSON.stringify` 落盘丢键 ⇒ 重算哈希不一致 ⇒ 假断链。所以「判空后补 `''`」与「传 `undefined`」两条都不许碰，**唯一正确形态 = 键缺席**，由 `recordApprovalDecisionAudit` 内 `...(input.taskId ? { taskId: input.taskId } : {})` 保证。
- 设计文档 §1.2-1 表里 `ext` 一列明写 `{ kind, decision, taskId?, delegationId?, channel }`（**条件展开**）⇒ sink 的 `taskId?` 与设计同源，不是放宽。

**改动**：`approval-replay.ts` 的 `ApprovalDecisionSink` 内联形参 `taskId: string` → `taskId?: string`，并补齐 sink 与 `ApprovalDecisionAuditInput` 的字段差集（`actor` **必选**——ARCH-05 的病灶正是「谁拒的」，缺它取证无意义；同时补 `delegationId?` / `hostApproved?`，使 sink 入参与 input 同形，装配层不必再手工拼装）。既有测试无对 `ApprovalDecisionSink` 的源码文本钉（grep 全 `tests/unit` 零命中）⇒ 无守卫冲突。

**顺带修的 3 处编译/实现缺陷**（自查，非主理人点名）：
1. `server.ts` 缺 `type ApprovalTokenMap` import（上一回合遗留，必红）。
2. `http-guard.ts` 里 `isLoopbackHost` 被重复声明两次（我上一回合插入锚点选错，造成 duplicate identifier）。删除后保留**带 trim 的版本**（`boundLoopback` 读 `server.address().address` 可能带 zone id/空白）。
3. `pending-approvals.ts` 的 `arm()` 自续链引用了未声明字段 `intervalMs` / `onSwept` ⇒ 补两个 private 字段（`startTimer` 归一后写入，`arm()` 复用同一值，保证自续每轮间隔一致）。

**同时落定**：`buildSecurityHealth` 纯函数从 server.ts 移入 `http-guard.ts`（`authMode` 与守卫判据同源、可脱服务单测），server.ts 侧保留同名薄封装 `buildSecurityHealth()` 只负责喂「实测监听地址」；import 用 `buildSecurityHealth as buildSecurityHealthSnapshot` 避免与本地封装重名。

## §9 十区完成度复核（设计 §7.2 唯一可动面）

逐区实测（行号为**当前工作区**读数；基线读数与锚文本见 §0-4）：

| 区 | 本批动作 | 实测状态 | 锚点（当前行号） |
|---|---|---|---|
| 1 协调器 | `decidedApprovals` + `recordDecision()`（O-6 判存即返回、approved 登记不落链）+ O-4 顺序（`isCancelled?.()` 可选调用）+ `bind` 形参放宽 `Pick<…,'waitApproval'｜'tryGet'｜'isCancelled'>`；绑定仍 `tasks.tryGet` | ✅ | `:167-302`（`raise` `:321-430`）|
| 2 链与启动 | `freshChainOnStart: true` **值未动**（全文件 `freshChainOnStart: true,` 恰 1 处）；warmup 区后 `verifyArchive()` fire-and-forget ⇒ 落 `chain-archive-verify` **用原始 sink** | ✅ | `:533-541`、`:652-693` |
| 3 令牌表 | 裸 `new Map()` ⇒ `new PendingApprovalRegistry<PendingApproval>({ ttlMs: resolveApprovalTtlMs(), logger })` | ✅ | `:755-766` |
| 4 TaskStore | `maxTasks/terminalTtlMs` 显式声明为装配层常量（200/1h）；`onApprovalTimeout` 内 `noteTimeout(approvalId)` 逐字保位 + `recordDecision('timeout')` 去重 | ✅ | `:786-810` |
| 5 重放段 | **仅注释**：`approved` 不落链的枚举预留说明（设计文档 §5 第 2 条） | ✅ | `:980-985` |
| 6 MCP 审批块 | 语义零改（Registry 同签名 ⇒ `set/get/delete` 三调用点文本未动、`collectApprovalFacts(pendingApprovals, …)` 未动） | ✅ | `:1023-1153` |
| 7 observer | O-3 三分支（`canceledTerminal` = 快照或存储任一 canceled）+ `errorCode` canceled 前置 ⇒ `'TASK_CANCELED'` | ✅ | `:1199-1229` |
| 8 HTTP | 路由入口前挂 `createBearerGuard`（`path` 解析后、405 前）；`guardActive===false` ⇒ 整块跳过（逐字旧行为）；deny ⇒ `sendJson(res,401,BEARER_UNAUTHORIZED_BODY)` | ✅ | `:1423-1450` |
| 9 buildHealth | `audit` 四字段条件展开 + `security: buildSecurityHealth()` + `tasks:{live,maxTasks,terminalTtlMs}` | ✅ | `:1748-1789` |
| 10 close | `pendingApprovals.close()` 先于 `server.close()`（防边关边扫写链） | ✅ | `:1819-1833` |

**禁碰区核对**：`core/src/policy/engine.ts` 零改动（`git status` 不含该文件）；server.ts 的 `buildPreview/hasDryRunParam/collectImpact`、`executeCapability` 策略段、dry-run 装配、`freshChainOnStart` 值 —— 全部未触（区 9/区 1 的新增都在各自锚区间外）。

## §10 判据⑦ 的守卫冲突处置（D-23，按主理人已下发裁断执行）

裁断口径：**三分支实现体逐字定稿 + 变异锚点从源码复制字节串同 diff 更新 + 补 canceled 摘除变异（塞/摘双向必红）**。

1. **实现体定稿**（`server.ts:1209-1229`）：
```ts
const canceledTerminal = snap.state === 'canceled' || storedState === 'canceled';
const terminalState = canceledTerminal
  ? 'canceled'
  : snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state;
const errorCode =
  ok || snap.state === 'input-required'
    ? undefined
    : canceledTerminal
      ? 'TASK_CANCELED'
      : (result?.error?.reason ?? …);
```
2. **踩到的新坑（上一回合未预见）**：E-6 变异「摘掉 failed→rejected 回改」在三分支上**打空**之外，还有一条更隐蔽的红 —— `d5_observer_rewrite` 的正则判据 `snap\.state === 'failed' && storedState === 'rejected' \? 'rejected' : snap\.state` **会命中我写在代码注释里的表达式复述**（注释排版纪律块原样引用了该串）⇒ 代码被摘除后注释仍在 ⇒ 守卫恒真 ⇒ 「每个变异都真实改动了快照」当场红。
   **处置 = 改注释，不改判据**：注释不再复述判据原文（改为「后两分支必须同一行连续」的间接描述），实现体保持原形态。这条正是变异检验的自证价值：**恒真断言被自己写的注释喂出来的**，与 `assembly-guard` M9/M10 等价改写假阳性同族。
3. **守卫更新 diff（单列，主理人提交用）** — 仅 `tests/unit/r19c-kn1-e-mutation.test.js`：
   - 新增判据 `d5_observer_canceled`（三条件合取：`canceledTerminal` 判据源 + 三分支终态式（含 8 空格换行缩进）+ `canceledTerminal ⇒ 'TASK_CANCELED'` 前置分支）；
   - `d5_observer_rewrite` 变异源串换为三分支逐字形态（从源码复制字节串），**替换体不变**（仍整体摘成 `const terminalState = snap.state;`）；
   - 新增 4 个变异：`canceled 直取被摘`（只摘 canceled 分支，保留后两分支）/ `取消判据源被挪出`（`|| storedState === 'canceled'` 摘掉）/ `TASK_CANCELED 前置分支被摘` / `三分支换成 rejected 优先`（**塞**方向：O-4 顺序倒置）；
   - 判据**零放宽**（只加不减；`d5_observer_rewrite` 的语义未被替代）。
   实测：`r19c-kn1-e-mutation` **54/54**（基线 50 ⇒ +4），`r19c-kn1-e-shape` 33/33 未改。
4. **delegation-audit.ts 零改动的理由**：`terminalState?: TaskState`（:552）与 `TASK_CANCELED` 文案归属 server.ts observer；`buildDelegationAuditEntry` 只做条件展开与 `delegation.complete:<terminalState>` summary 拼接，`TaskState` 已含 `'canceled'`（T1）⇒ 口径无需修正（判据⑦行为探针 `buildDelegationAuditEntry('complete',{terminalState:'canceled',errorCode:'TASK_CANCELED'})` 直测通过）。

## §11 T4 新增测试（逐文件）与守卫更新

三个新测试文件全部**脱 ps-bridge 直测**（只 import `packages/vm-service/dist|src` 的纯函数面 + `node:crypto`/`node:fs`，零网络、零 VM、零隧道），且**每个判据都可证伪**（要么有行为反例，要么有源码/内存变异）。

| 文件 | 行数 | 例数 | 覆盖判据 | 关键反例/变异探针 |
|---|---|---|---|---|
| `tests/unit/phase1-t4-http-guard.test.js` | 391 | **40** | ⑤ | `enforceBearer=false` ⇒ 守卫恒 pass 的**关键回归**（逐字旧行为）；O-9 半开反例（有名无值 / 有值未开 ⇒ 一律不拦截）；豁免表只对 `GET`（`POST /health` 仍校验）；`/admin/llm-session/reset` **不**豁免；`DEFAULT_EXEMPT_PATHS` 冻结（写即抛）；`tokenEquals` 长度前置源码钉；拒绝**只 warn 不入链**；`AUTH_REQUIRED` **不进** `BridgeErrorCode`；`authMode ⇔ resolveBearerToken` 同源穷举 8 组合；`isLoopbackHost` 与 `core/src/config` 同枚举；挂载位置「先于每个路由 if」 |
| `tests/unit/phase1-t4-pending-approvals.test.js` | 321 | **28** | ⑥ | O-10 **在途保护**（`hostApproved:true` 不被扫出）；边界同刻不逐（严格 `<`，杜绝与 `waitApproval` 双写）；坏 TTL ⇒ `Infinity` 逐字旧行为；`unref`；`startTimer` 幂等 + 缺省间隔公式 `max(60s, ttl/4)`；`close()` clear 恰一次且 close 后不复活；自续链断链探针；回调异常被吞；窄 Map 替身面（可作 `ReadonlyMap` 实参）；`ttl` 不回吐配置来源 |
| `tests/unit/phase1-t4-assembly.test.js` | 1131 | **45** | ①②③④⑥⑦ + 装配纪律⑤⑧⑨⑩ | 三条腿（真实协作对象行为 / 纯函数条目形态 / 源码文本钉 + 内存变异自证 + 末尾 SHA 零磁盘写自证）。详见下表 |

**`phase1-t4-assembly.test.js` 的四类"必须变红"探针**（本轮最有价值的部分，此前只能靠源码阅读相信）：

1. **O-4 顺序反例**：`noteTimeout` 与 `requestCancel` 同时在场 ⇒ 决策审计记 `canceled`（不是 `timeout`）；spy `tryGet` 故意回 `state:'canceled'` 但 `isCancelled()` 回 `false` ⇒ 记 `rejected`（证明 `isCancelled` 是**唯一权威判据入口**，快照态不许单独作数）。
2. **O-6 去重**：超时路径在 `onApprovalTimeout` 复刻主落点 + `raise` 兜底 ⇒ `assert.equal(calls.length, 1, '超时只许一条，实测 N 条 ⇒ O-6 去重失效')`。
3. **O-7 审计自证反例**（行为级，不是注释级）：同一条 `chain-archive-verify` 经 `wrapAuditSink` 写入 ⇒ `ledger.activityCount().total === 1`（自证成立，反证探针有效）；写**原始 sink** ⇒ `=== 0`。源码钉另用正则抓 `setDecisionSink((input) => {…})` 整块，断言 `recordApprovalDecisionAudit(\n audit,` 且该块内 `auditSink` **零出现**。
4. **位置倒置变异**：把守卫块摘出并插到 `sendJson(res, 200, await buildHealth());` 之后 ⇒ 共用判据 `guardPrecedesAll()` 必红（首版我把位置判据手写在用例里、`||` 逻辑写反导致"变异恒真"误报，已抽成函数供基线与变异副本共用）。
5. **判据⑦摘/塞双向**：摘 `canceled` 分支、摘 `TASK_CANCELED` 前置分支后，对应源码文本钉必须变红（与 §10 的守卫更新形成双向闭环）。

**守卫更新（单列，见 §10-3）**：本轮唯一被改的既有守卫 = `tests/unit/r19c-kn1-e-mutation.test.js`（+63/-1，50 ⇒ **54 例**，判据只加不减）。其余守卫文件（`assembly-guard` 24、`r19c-kn1-e-shape` 33、`r19c-a5-approval-coordinator` 22、`k5-replay` 41、`r19c-kn1-a-pure` 76）**零改动且全绿** ⇒ 证明 T4 的实现没有以"放宽守卫"换取编译/测试通过。

## §12 七判据逐条证据（实测计数取自 `$HOME/wbtmp/t4-full-run.txt`）

| # | 判据 | 证据（文件 · 用例） | 实测 |
|---|---|---|---|
| ① | 拒绝/取消/超时**三态各一条**决策审计，超时去重只一条 | `phase1-t4-assembly` 判据①组：真实 `VmApprovalCoordinator` + 注入 sink，三态分别记 `actor='host'/'cancel-request'/'approval-ttl'`；`approved` 登记但**不落链**并挡住后续假 timeout；`pruneDecided` 返回 2 且幂等 | 45 例全绿 |
| ② | sink 抛错 ⇒ 决策结论不变、仅 warn（O-5 取证面不上抛） | `phase1-t4-assembly` 判据②组：sink 首调即抛 ⇒ `outcome` 仍 `{approved:false, reason:'rejected'}` + 恰 1 条 warn；`recordApprovalDecisionAudit` 链写抛 ⇒ `{ok:false}` 不上抛；`onRecorded` 抛 ⇒ 仍 `{ok:true}` | 45 例全绿 |
| ③ | `/health.audit.scope` 可读且 `chainValid` 语义不变 | `phase1-t4-assembly` 判据③组：真实 `HashChainAuditSink` `freshChainOnStart:true` ⇒ `scope==='session'`、`shardsArchived===max(total-verified,0)`；不带 ⇒ `scope==='full'`；`buildAuditBlock(chain)` 复刻区 9 映射，**旧形态入参 ⇒ `Object.keys()` 恰 `['entries','chainValid']`**（纯附加可证伪） | 45 例全绿 |
| ④ | 启动落 `chain-archive-verify`（用**原始 sink**，O-7） | 判据④组四例（无断裂/有断裂/零归档片/`total<verified` 误传防负数）+ 条目真实入链后 `verifyChain().valid===true`（证明条件展开无假断链）+ 启动块源码钉（`void (async () => {` / `verifyArchive()` / `const chain = await audit.verifyChain();` / `shardsTotal: chain.shardsTotal ?? results.length` / `logger.warn('启动归档校验失败`）+ O-7 行为反例（§11-3） | 45 例全绿 |
| ⑤ | 守卫双条件（O-9）+ 豁免表 + `timingSafeEqual` + `enforceBearer=false` **逐字旧行为关键回归** | `phase1-t4-http-guard` 40 例（判据⑤-1..⑤-8）+ 装配面钉（`guardActive` 双条件源、`bearerGuard(req as GuardableRequest)`、`sendJson(res, 401, BEARER_UNAUTHORIZED_BODY)`、**装配层不得另写** `if (cfg.security.enforceBearer) {`、位置倒置变异） | 40 + 装配组，全绿 |
| ⑥ | `sweepExpired` 不扫在途（O-10）+ `close()` 后无定时器 | `phase1-t4-pending-approvals` 28 例 + 装配线（清扫回调 ⇒ 恰 1 条 `mcp-ttl-sweep` 决策、`inflight` 保留、`pruned===1`、第二轮不回调；`pendingApprovals.close()` 早于 `server.close(`） | 28 + 装配组，全绿 |
| ⑦ | 链上 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'` | `phase1-t4-assembly` 判据⑦组（`buildDelegationAuditEntry` 行为 + 三分支源码钉 + 摘分支必红）+ §10 守卫更新（`r19c-kn1-e-mutation` 新增 4 变异含"塞"方向 O-4 顺序倒置）；`delegation-audit.ts` 零改动（§10-4） | mutation 54/54 · shape 33/33 |

**全量对账（逐文件跑测，禁 glob）**：

```
TOTAL  files=75 tests=1400 pass=1398 fail=0 skipped=2 nonzeroExit=0   SCRIPT_EXIT=0
```

- `1400 = 1283（T3 基线）+ 40 + 28 + 45（T4 三个新文件）+ 4（mutation 净增变异用例）` ⇒ **逐项可加，无凭空增量**；
- `skipped=2` 与基线一致（全部落在 `ssh2-resolve.test.mjs`，环境依赖跳过，非 T4 相关）；
- 75 文件 = T3 的 72 + T4 的 3；**逐文件 `fail=0` 且 `exit=0` 无一例外**，`COLLECT_ERROR` 标记 0 次（脚本对"零计数 + 非零 exit"显式打标，绝不静默计 0 ⇒ 排除"提取失败造成的假绿"）；
- 留档：`$HOME/wbtmp/t4-full-run.txt`（79 行 = 3 行口径注释头 + 75 行逐文件 + TOTAL）、`$HOME/wbtmp/t4-run-all.mjs`、`$HOME/wbtmp/t4-full-run.stdout.txt`（同轮 stdout 双份，互证）。

## §13 偏差登记（自 D-22 起；D-1..D-21 见 T1-T3 notes）

| # | 偏差 | 性质 | 裁断/理由 |
|---|---|---|---|
| **D-22** | `ApprovalDecisionSink` 形参 `taskId: string` ⇒ **`taskId?: string`**（并补 `actor` 必选、`delegationId?`、`hostApproved?`，使 sink 与 `ApprovalDecisionAuditInput` 同形） | **契约形状对齐**，非放宽 | 详见 §8。否决"调用点 `?? ''`"：无 taskId 的两条真实路径（MCP 直调 / 令牌表清扫）不该写出"有键但空串"的假证据；唯一正确形态 = **键缺席**（条件展开），与 T1 `AuditExt.decision?/taskId?` 同源。grep 全 `tests/unit` 对该类型零文本钉 ⇒ 无守卫冲突 |
| **D-23** | `r19c-kn1-e-mutation` 判据⑦相关锚点更新（新增 `d5_observer_canceled` + 变异源串换为三分支逐字形态 + 新增 4 变异）；**并修复一处真实恒真守卫**（注释原样复述判据表达式 ⇒ 摘码后仍命中注释） | 守卫**净收紧**（只加不减） | 按主理人已下发裁断执行（§10）。处置=改注释不复述判据原文，判据零放宽。这条是变异检验的自证价值：恒真断言被自己的注释喂出来，与 `assembly-guard` M9/M10 等价改写假阳性同族 |
| **D-24** | `buildSecurityHealth` 纯函数从 `server.ts` **下沉**到 `http-guard.ts`；`server.ts` 侧保留同名薄封装只喂"实测 `server.address()`" | 可测性重构，行为等价 | `authMode` 三态判据与守卫判据**同源**（共用 `resolveBearerToken`），杜绝"health 说有鉴权、守卫实际不拦截"的事实漂移；同时可脱服务单测。import 用 `as buildSecurityHealthSnapshot` 避开本地同名 |
| **D-25** | `ApprovalTokenMap<V>` 采**窄接口 + `implements`**，而非"让 Registry `extends ReadonlyMap`" | 实现选型偏差（公开面更小） | `extends ReadonlyMap` 会逼出 `Symbol.iterator`/`entries` 全套语义并扩公开面；窄面已覆盖 `server.ts` 三类调用点与 `collectApprovalFacts(ReadonlyMap)` 形参 ⇒ `bind` 调用行**文本逐字未动**（守卫钉保住） |
| **D-26** | `pending-approvals.ts` 补两个 **private** 字段 `intervalMs` / `onSwept`（`startTimer` 归一后写入，`arm()` 自续复用） | 缺陷修复（首版 `arm()` 引用未声明字段 ⇒ 5 处 TS2339） | 保证自续每轮间隔与首次一致（不归一就直接用入参会让 `ttlMs/4` 缺省在第二轮漂移） |
| **D-27** | `http-guard.ts` 中 `isLoopbackHost` **重复声明**（上一回合锚点选错）⇒ 删除第二份，保留带 `trim()` 版本 | 缺陷修复 | `server.address().address` 可能带 zone id/空白；两处判据（core 配置校验 / health 事实面）必须同枚举，否则"配置拒启动、health 自称回环"矛盾 |
| **D-28** | 改 `src` 后必须 `tsc -b tsconfig.build.json --force` 重建 `dist`，否则 `r19c-a5` 的 **A0 可信度守卫**红（`dist mtime < src mtime ⇒ dist 陈旧，A/B/C 行为断言不可信） | 构建/验证纪律（非代码偏差） | 本轮实际命中一次 ⇒ 重建后 22/22 绿。**非实现缺陷**，但会让"只跑 `tsc -b` 增量"的同事踩到 ⇒ 登记以便 QA 复现时照做 |
| **D-29** | 跑测留档脚本改为**末尾一次性 `writeFileSync`**（原逐行 `appendFileSync` 在本文件系统上丢写 ⇒ 留档只剩 9 行） | 工具/取证纪律 | 残缺留档 = 假绿证据（"没记到"与"没跑到"无法区分）。同时保留 stdout 双份 `t4-full-run.stdout.txt` 互证；`COLLECT_ERROR` 显式标记逻辑不变 |

| **D-30** | 环境异常（**非代码缺陷**）：文件系统**读数漂移**（无编辑时同一文件两次读到不同行数/字节）+ 逐行 `appendFileSync` **丢写** ⇒ 跑测留档脚本加固为 `fsync` + 读回逐字节比对、不合则重写 ≤5 次并打 `# ARCHIVE_VERIFIED` | 取证工具加固（`$HOME/wbtmp/t4-run-all.mjs`，非仓库文件） | 详见 §17 末段。残缺留档会被读成「没记到 = 没问题」，属假绿证据 ⇒ 必须在脚本层自证，不靠人工核对 |

**未登记即未做**：`delegation-audit.ts` 零 diff；`core/src/policy/engine.ts` 零 diff；`freshChainOnStart` 值未动；`buildPreview/hasDryRunParam/collectImpact` 与 `executeCapability` 策略段未触；**未新造任何 env 旋钮**（`WINVM_[A-Z_]*(PENDING|SWEEP|TOKEN_TTL|BEARER_TOKEN_TTL)[A-Z_]*` 在 T4 全部改动面上零命中，TTL 复用既有 `WINVM_APPROVAL_TTL_MS`，`TaskStore` 上界用模块级常量而非 env）。

## §14 移交 T5 / QA

| # | 事项 | 需要的动作 |
|---|---|---|
| 1 | `enforceBearer` 目前默认关闭（配置面 `security.enforceBearer`），开启后 VM 内回连需凭据通路 | 开启前置条件 = 设计文档 §5 第 3 条 / R4 风险；QA 在真机验证前先确认回连不 401 |
| 2 | `/health.security.authMode` 三态真机核验 | 期望值：默认配置 ⇒ `'loopback-only'`（契约 `AuthMode` 三态枚举无 `'none'` 取值，`packages/contracts/src/bridge.ts:126`；主理人终审修正——原稿误写 `'none'`，且 `phase1-t4-http-guard.test.js:296` 已断言默认 ⇒ `loopback-only`）；`tokenEnv` 有名无值 ⇒ `'bearer-configured-missing'`（**注意这是告警态，不是拦截态**） |
| 3 | `endpointAllowlist` 负空间（`?: never`） | T1 契约已钉；T5 若扩配置面需同步放开，勿在 vm-service 侧偷偷加字段 |
| 4 | `approved` 不落链（ARCH-09 枚举已预留） | 若产品要求"批准也要证据"，改点在区 1 `recordDecision` 的 `approved` 早退 + §3-1 条目形态，**勿改 sink 选择**（O-7） |
| 5 | `pruneDecided` 长跑观测 | 现由清扫回调驱动（`pruneDecided(pendingApprovals.keys())`）；长跑若见 `decidedSize` 单调增 ⇒ 说明有绕过 Registry 的决策路径，属缺陷 |
| 6 | `TASK_STORE_MAX_TASKS=200` / `TERMINAL_TTL_MS=1h` | 与框架私有缺省**同值显式化**；若 T5 要调，须同时改框架侧或改为透传配置，别只改装配层造成"以为调大了、框架仍截断" |
| 7 | QA 复现口径 | `tsc -b tsconfig.build.json --force`（见 D-28）；逐文件跑测（禁 glob）；基线对账式 `1283 + 40 + 28 + 45 + 4 = 1400` |

## §15 全局一致性审查（跨文件，单次）

1. **依赖方向**：`http-guard.ts` 只 import `node:crypto`（零跨包）；`pending-approvals.ts` 零 import 审计面（被逐条目回传调用方）；`approval-replay.ts` 不反向 import `server.ts`；装配层新增依赖全部单向落在 vm-service(L3)。框架 `a2a-framework` 零审计依赖 ⇒ 补取证一律走回调注入（`onApprovalTimeout` / `setDecisionSink` / `onSwept`），**未破框架纯净性**。
2. **纯附加可选铁律**：本轮新增字段一律 `?:`；写链一律条件展开；显式 `undefined` 零出现（`grep -n ": undefined" ` 在新落链条目构造段零命中）。可证伪性由 §12-③ 的"旧形态入参 ⇒ keys 恰两项"与 §12-④ 的"入链后 `valid===true`"双向钉住。
3. **取证面/执行面分离**：`recordDecision`、`recordApprovalDecisionAudit`、启动归档块、`arm()` 回调、`deny()` —— 全部 `try { … } catch { logger.warn }`，无一处上抛、无一处回改拦截/拒绝/取消结论。
4. **同源判据**：O-9 双条件只有一处实现（`resolveBearerToken`），守卫/`authMode`/`buildSecurityHealth` 三者共用；`isCancelled` 是取消的唯一权威判据入口（§11-1 反例证明快照态不许单独作数）；`isLoopbackHost` 与 core 同枚举。判据多写点在装配层被**显式禁止**并测试钉住（区 8 不得另写 `if (cfg.security.enforceBearer) {`）。
5. **跨文件接口契约**：`bind(tasks: Pick<TaskStore,'waitApproval'|'tryGet'|'isCancelled'>, pendingApprovals: ApprovalTokenMap<PendingApproval>)` 的 `bind` **调用行文本逐字未动**；`collectApprovalFacts(reg, {delegationTraceId, startedAtMs}, now)` 实参形状按 `ApprovalWaitQuery` 校正（首版误写 `{capabilityIds:[…]}` 已修）；`ApprovalDecisionSink` 与 `ApprovalDecisionAuditInput` 同形（D-22）；`index.ts` 再导出与两个新模块的**实际导出面逐项核对一致**（无漏导、无导不存在的名字）。
6. **守卫面**：唯一改动守卫 = `r19c-kn1-e-mutation`（判据只加不减）；`assembly-guard` 的 `void recordPolicyDeniedAudit(` 计数钉恰 2 处未变（新函数刻意**不同名**）；`r19c-a5` C3 全仓 `cancelRequested` 恰 4 处未变；sliceRoute 三锚仍相邻；admin env 恰 1 处；`freshChainOnStart: true,` 恰 1 处。
7. **无重复实现**：`isLoopbackHost`/`resolveAuthMode`/`buildSecurityHealth` 各一份（D-27 已清重复）；`recordApprovalDecisionAudit` 与 `recordPolicyDeniedAudit` 职责不重叠（前者"决策已作出的取证"、后者"策略拒绝的取证"）。

**遗留项（不阻断交付）**：建议 QA 收官时给 `d5_terminal_state_passthrough` 补"摘 canceled 分支"双向变异（本轮已在 `d5_observer_canceled` 内实现等价力，故仅记为增强项）。

## §16 交付面（diffstat / 工作区清单，供主理人统一提交）

**tracked（`git diff --numstat`，只读子命令）**：

| 文件 | + | - |
|---|---|---|
| `packages/vm-service/src/server.ts` | 454 | 15 |
| `packages/vm-service/src/approval-replay.ts` | 245 | 1 |
| `packages/vm-service/src/index.ts` | 45 | 0 |
| `tests/unit/r19c-kn1-e-mutation.test.js` | 63 | 1 |
| **合计** | **807** | **17** |

**untracked 新文件（无 diff ⇒ 以行数/字节数留档）**：

| 文件 | 行数 | 字节 |
|---|---|---|
| `packages/vm-service/src/http-guard.ts` | 294 | 15136 |
| `packages/vm-service/src/pending-approvals.ts` | 277 | 13256 |
| `tests/unit/phase1-t4-http-guard.test.js` | 391 | 19779 |
| `tests/unit/phase1-t4-pending-approvals.test.js` | 321 | 15010 |
| `tests/unit/phase1-t4-assembly.test.js` | 1131 | 51253 |
| `docs/changes/phase1-t4-notes.md` | 353 | 48703 |

> **取证口径说明**：上表与 tracked 表均为**连续多次读数一致**的稳定值（`wc -lc` ×3、`git diff --numstat` ×3）。本会话中该文件系统出现过读数漂移（同一 `http-guard.ts` 先后读到 316/16323 与 294/15136，期间**无任何编辑**），以及 `appendFileSync` 丢写（见 §13 D-29）⇒ 故本批所有计数均以"多次读数取稳态 + 与 `git diff --numstat` 交叉印证"给出，不采信单次读数。我先前回报里写的 `server.ts 455/15` 是漂移读数，**准确值 = 454 / 15**（`--numstat` ×3 一致；`git status` 亦确认工作区未再变更）。

**零 diff（本批刻意不动）**：`packages/vm-service/src/delegation-audit.ts`（889 行，§10-4）、`packages/core/src/policy/engine.ts`、`packages/contracts/src/*`、`packages/a2a-framework/src/*`。

**git 纪律**：本批我未执行任何 `git add` / `git commit` / `git checkout`；工作区改动面即上表。

## §17 提交后复验（主理人已提交 T4）

主理人在本笔记落盘后完成提交：`HEAD = 90db1ad`（`feat(phase1-T4): vm-service 装配层…`），13 文件 `+3595 / -17`，含上表全部改动（`server.ts +469`、`approval-replay.ts +246`、`http-guard.ts +294`、`pending-approvals.ts +277`、`index.ts +45`、`r19c-kn1-e-mutation +64/-1`、三个 `phase1-t4-*.test.js` 1131/391/321 行、本笔记 355 行）⇒ §16 的"untracked"分类自该刻起失效，实数以 `git show --stat 90db1ad` 为准。

**提交后 `git status --porcelain` 对本批文件 = 空**（仅剩 `.workbuddy/**`、`v3-kn2.*`、`winvm-dist.tgz` 等非本批产物）。

**提交态复跑（逐文件，9 个 T4 关键文件）**：

```
phase1-t4-http-guard        40/40 fail=0 exit=0
phase1-t4-pending-approvals 28/28 fail=0 exit=0
phase1-t4-assembly          45/45 fail=0 exit=0
r19c-kn1-e-mutation         54/54 fail=0 exit=0
r19c-kn1-e-shape            33/33 fail=0 exit=0
assembly-guard              24/24 fail=0 exit=0
r19c-a5-approval-coordinator 22/22 fail=0 exit=0
k5-replay                   41/41 fail=0 exit=0
r19c-kn1-a-pure             76/76 fail=0 exit=0
```

`tsc -b tsconfig.build.json` 于提交后复跑 **exit 0**。⇒ T4 在 HEAD `90db1ad` 上编译与测试双绿，§12 的全量口径（75 文件 / 1400 例）对应工作区 = 该提交（其前）态，差值仅本节的文档追加。

**本文件系统异常（QA 复现须知，登记为 D-30）**：本轮观测到同一文件的**读数漂移**（`http-guard.ts` 在无编辑情况下先后读到 316 行/16323B 与 294 行/15136B）与 `appendFileSync` **丢写**（留档只剩 9 行）。两者都不是代码缺陷，但都会制造"残缺留档 = 假绿"。已在 `$HOME/wbtmp/t4-run-all.mjs` 内加**读回自证**（`fsync` + `readFileSync` 逐字节比对，不合则重写 ≤5 次，末行打 `# ARCHIVE_VERIFIED attempt=N bytes=N`），本轮最终留档 = 79 行 / 5170B、`ARCHIVE_VERIFIED attempt=1`。若 QA 在别处复现出计数不一致，先查留档是否被截，不要先怀疑测试。

IS_PASS: YES
