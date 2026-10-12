# P2-T8 设计定稿（真值层扩展到 MCP 直调 + 兜底归因可观测）

HEAD=7429090。侦查实证（2026-10-12）：

## 0. 现状事实（全部实读确认）

- `reconcileApprovalTruth`（delegation-truth.ts:225）门序：
  门0 `!base.ok`⇒**恒等透传**（`return base`）；门1 `!input || !taskId`⇒`runFallback('门1')`；
  门2 `enabled===false`⇒`runFallback('门2')`；门3 探针/`approvalWait` 缺席⇒`runFallback('门3')`；
  门4 探针抛错⇒warn 恰一条 + `fallbackOrIdentity4`；门5 facts 空⇒`runFallback('门5')`；
  门6 全 raised 且无回执⇒`runFallback('门6')`；命中⇒改判（shadow 态只 warn 返 base 本体）。
- `runFallback` 的 warn 只在 **fallback 缺席**时 emit（E-2b），带 `gate` 与 `hasTaskId:!!taskId`；
  `taskId` 是 `const` 在 `runFallback` 定义之后声明 ⇒ TDZ，**E-2b warn 在场时门1 不可能被走到**。
- 桥两处收口点：runPersistent :1484、runOneShot :1765，均 `ok:true` 才进 `reconcileApprovalTruth`；
  `!turn.ok` 分支（:1468）直接调文本启发式（门0 纪律使然，不调结构化判据）。
- `reconcileApprovalWait`（bridge.ts:793，SK-9 一字不动）产出 `error.details={approvalId,(capabilityId?),risk}`，
  **无 source 键**。
- 归属键现实：`LlmGoalInput.traceId` 必填；`taskId` 仅 A2A 委派存在
  （`goalWithTask = {...goal, taskId:id}` 在 a2a 框架构造期注入；hermes provider 不读 taskId，无破坏）。
- dtid（通道2 精确归因）现状被**双重收窄**：
  ① 桥 `const dtid = input.taskId ? input.traceId : undefined`（bridge.ts:1601，仅单次-p 路径，
     runPersistent 按注释刻意不传——会话级 mcp.json 共享，写逐次委派 dtid 会归因时点错位）；
  ② 服务端 reqCtx 仅当**本回合存在活跃委派账本**（`delegationTraceId==='__mcp__'` 时 `currentDelegation=undefined`
     ⇒ 纯宿主直调连 `delegationId` 键都不注入）才下发 dtid。
- `collectApprovalFacts`（approval-replay.ts:348）**已能按 traceId 归因**：
  R1 `delegationId===q.delegationTraceId`⇒exact；R2 他人⇒排除；R3 delegationId 缺席⇒
  `startedAtMs<=createdAtMs<=nowMs` 窗口 + 能力面过滤⇒window。⇒ G-a 确证「不需要新数据源，需要新调用点」。
- `/mcp` 桥接层（vm-service mcp-transport.ts）**只做协议转发，不调 runGoal** ⇒
  LLM 桥（runPersistent/runOneShot 收口点）在**两条通道**都执行；「纯 MCP 直调通道」
  在桥内的形态 = **无 taskId、有 traceId** 的回合。
- `phase2-approval-wait-fallback` D3b（:253-261）钉「门3 回退兜底且 **warns.length===0**」；
  D1（:193）钉门0 `out===base` **引用相等**。⇒ decidedBy/gate 只能透出到 `deps` 出参对象，
  **不得**写进返回值、**不得**在门3 加 warn。
- `ext.approvalTruth` 键全仓零命中（自由键，无静态断言消费）；`AuditExt` 尾键=`evict`（T7）。

## 1. G-a 方案（门1 形态扩展）

`reconcileApprovalTruthPure` 门1 判据改为**归属键 = taskId ?? traceId**：
```
const traceId = input.traceId 非空串 ? input.traceId : undefined;
if (!input || (!taskId && !traceId)) return runFallback('门1', ...);
```
- 无 taskId 有 traceId（纯 MCP 直调）⇒ 进入结构化反查，`query.delegationTraceId = traceId`
  （既有取值序 `ctx.delegationId ?? input.traceId` 不变，语义不变）。
- **SK-1 归属不放宽**：taskId/traceId 双缺 ⇒ 仍回退兜底（零介入）。
- R2 精确排除保证串台安全（他人 dtid 的未决审批绝不落到本回合）。
- warn/日志 meta 里的 `hasTaskId` 保留；新增 `attribution` 语义由 facts.attribution 自带。

**诚实边界（写入文档）**：宿主**经 MCP 桥接层做单能力直调**（`tools/call`，非 LLM 回合）仍无判据——
桥接层不调 runGoal，无收口点可言；该面由服务端策略闸（raise→approvalId）+ `collectApprovalFacts`
的归因面覆盖。本批扩展的是 **LLM 桥在无 taskId 回合（委派 CLI 回连 / 纯 MCP 直调委派形态）** 的判据。

### dtid 归因面（裁断：不动，诚实登记）
`bridge.ts:1601` 的 dtid 钉（taskId 存在才拼）**不改**，理由三条：
① 它是 **K-N1 双参钉**，任务书红线明列「不破」；
② 常驻会话 mcp.json 为会话级共享，逐次委派 dtid 写文件必然归因时点错位（注释实证，设计 K-N1 §4）；
③ `collectApprovalFacts` 的 R3 窗口归因本就是常驻/无 dtid 通路的**既有设计兜底**——
G-a 的门1 扩展后，无 dtid 也能经 R3（startedAtMs 下界 + 能力面过滤）命中结构化反查。
⇒ 服务端 `approvalWait` 无需改动，delegation-audit.ts 无需改动（dtid 缺席路径归因本已闭环）。

## 2. G-b 方案（decidedBy / gate 可计数归因）

`ApprovalTruthDeps` 新增**纯附加可选**出参：
```
readonly onTruthDecision?: (d: {
  decidedBy: 'server' | 'text-fallback' | 'pass-through';
  gate: string;              // '门0'|'门1'..|'命中'|'shadow-hit'
  taskIdPresent?: boolean;
  traceIdPresent?: boolean;
  approvalId?: string;
}) => void;
```
全部决策出口各调用恰一次（**纯附加，缺席即零行为变化**）：
门0=`pass-through/门0`；门1/门2/门3/门5/门6=`text-fallback/<gate>`；门4=`text-fallback/门4`（异常路径，
不破坏「恰一条 warn」计数——emit 不是 warn）；命中=`server/命中`；shadow 命中=`shadow/shadow-hit`。
⇒ 区分「兜底救了」（decidedBy=text-fallback 且结果被改判）与「兜底没机会救」（decidedBy=server）；
off/shadow 态对拍数据由 emit 产出。

桥侧（两处收口点共用）：`reconcileApprovalTruth` 私有方法内构造 emit，
写 `RunContext.approvalTruth`（新增可变字段，类型 = 契约 `ApprovalTruthAttribution`）；
两个 `ok:true` 收口返回点条件展开 `...(ctx.approvalTruth ? { approvalTruth: ctx.approvalTruth } : {})`
入 `LlmGoalResult`。⇒ `maybeResume` 的 spread 天然透传；`canceledResult`/failedBase 不落（无判定）。

provider（index.ts）成功/失败 return 条件展开透传 → 契约 `GoalResult.approvalTruth`（纯附加可选）。
服务端 `delegationObserver.onGoalTerminal`：
`...(result?.approvalTruth ? { approvalTruth: result.approvalTruth } : {})` →
`buildDelegationAuditEntry('complete', {...})` → `ext.approvalTruth`（delegation-audit.ts 纯附加）。
`AuditExt` 新增 `approvalTruth?: { decidedBy:'server'|'text-fallback'|'shadow'|'pass-through'; gate:string;
taskIdPresent?:boolean; traceIdPresent?:boolean; approvalId?:string }`（末位可选键）。

## 3. G-c 方案（补强，不重建）

新测试文件内 `describe('G-c')`：同义改写反例集（构造「会漏」措辞并**钉其确实漏**=诚实红线在位）+
关键词集合钉（读 src 文本断言 `APPROVAL_WAIT_KEYWORDS` = ['APPROVAL_REQUIRED','等待审批']）。
既有的 24 例（phase2-approval-wait-fallback）不动；SK-9 函数体一字不动。

## 4. mcp-framework/server.ts 与 contracts/bridge.ts

- mcp-framework：**零改动**（侦查实证：delegationId 已入 ToolContext，无需新传递面）。回报中说明理由。
- contracts/bridge.ts：只动 `GoalResult` 末尾（追加可选键）+ 新导出 interface；
  **不触碰** `SecurityHealth`（T5）/`TasksHealth`（T7）区。

## 5. 测试计划（phase2-truth-mcp-direct.test.js）

A 组 G-a：无 taskId + traceId 归因命中（R1 exact）/ 未命中（facts 空→门5 回退兜底）/
  双缺归属→门1 回退 / R2 他人 dtid 排除（串台红线）。
B 组 G-b：decidedBy/gate 形态钉（门1/门2/门3/门5/门6/命中/shadow 各恰一次 emit，
  计数=1 断言），含「门3 绝不 warn」旧纪律复核（emit≠warn）。
C 组 灰度三态对 MCP 直调同样成立：off 不判（emit 门2）/shadow 记不判（emit shadow-hit, ok 保持）/
  on 判（emit server）。
D 组 G-c：同义改写反例集 + 关键词集合钉 + SK-9 文案钉。
E 组 入链：buildDelegationAuditEntry('complete',{approvalTruth}) ⇒ ext.approvalTruth 形状；
  缺席 ⇒ 键不落（逐字节旧形状，深比对）。
