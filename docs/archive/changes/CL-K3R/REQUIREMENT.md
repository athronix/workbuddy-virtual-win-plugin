# CL-K3R · K3「静默假成功」根治（审批真值判据结构化）

> 变更标识：`CL-K3R` ｜ 性质：**安全语义根治**（把「是否在等审批」的判据从 **LLM 文本启发式**升格为 **服务端结构化事实**）
> 基线 HEAD：`6dca16e`（R19F 全部 CL 已合入，真机 R3 三项终验 PASS）
> 时间跨度：2026-10-04（owner 拍板）→ 2026-10-05（E-2b / E-3 / T05 Runbook）→ 2026-10-06（T05 真机 A~F 全通 + harness 收紧）
> 上游依据：`docs/design/cl-k3r-silent-false-success-design.md`（STATUS=**APPROVED**，§9.4 owner 已拍板 D-1/D-2/D-3）
> 实施记录：`docs/design/cl-k3r-impl-progress.md` · `docs/design/cl-k3r-e2b-e3-taskbook.md`
> 真机报告：`docs/test/reports/k3r-t05-runbook-2026-10-05.md` · `k3r-t05-phase-d-blocker-2026-10-05.md` · `k3r-t05-real-machine-2026-10-06.md`
> 最终结论：**PASS** —— `on` 模式 **3/3** 真机委派终态 `input-required`，K3 静默假成功被根治。

---

## 1. 变更概述

### 1.1 K3 的一句话

> VM 内 LLM Agent 调用了一个**被策略引擎拦截、需要宿主人工审批**的高风险能力（服务端已返回结构化 `APPROVAL_REQUIRED` + `approvalId`，并已登记续跑令牌）。但**桥判定「是否真的在等审批」的依据是 LLM 的最终文本措辞**；一旦 LLM 不用 `APPROVAL_REQUIRED` /「等待审批」这两个词，桥就判定「没在等审批」 ⇒ 不 raise、不挂起、不改判 ⇒ 任务以 `ok:true` 收口 **`completed`**。
> **操作从未执行，宿主收到「已完成」，全程零告警。**

### 1.2 为什么这不是理论风险（K3-a 必然会发生）

拦截事实在服务端是**结构化**的，但桥判定它是否发生用的是**文本**，二者的桥接点只有一处：`bridge.ts` 中写在系统提示词里的**自然语言纪律**（「当工具返回 APPROVAL_REQUIRED…必须如实上报『等待审批』」）。即**同一条链的两端都建在不可靠的措辞上**。已知 evade 形态（按现实性排序）：

| # | 形态 | 后果 |
|---|---|---|
| 1 | **同义改写**：「该操作需要人工确认」「此操作已被安全策略挂起，等你批准」 | 语义完整、正则零命中 |
| 2 | **只回显 `approvalId` 不带错误码** | `extractApprovalId` 拿到 id，但 `APPROVAL_WAIT_PATTERN` 不命中 ⇒ 整段 `return base` |
| 3 | **自宣完成**（K5 根因同源逆向行为） | 未执行却文本自宣「已处理完了」 |
| 4 | **常驻会话续跑轮文本覆盖** | `ctx.lastFinalText` 取**最后一轮**，前一轮说过的「等待审批」被后续轮覆盖 |
| 5 | **CLI 输出截断** | `turn.text` / `stdoutText` 尾部被截，关键词落在截断区 |

> **反证式提醒**：A5 之所以**没有**表现为 K3，是因为那一轮 LLM **恰好**说了 `APPROVAL_REQUIRED`（根因 §2.3 的三段指纹逐字命中）。**A5 是「运气好」，K3 才是默认脆弱面。**

### 1.3 触发条件（六条件同时成立，逐条可核）

设 D 为一次 A2A 委派（`taskId` 非空，A2b 已证生产恒成立），其 LLM 回合内确有 ≥1 次能力调用被 `CorePolicyEngine` 判 `requiresApproval` 并在 MCP 层拦截 —— **当前 HEAD 实测落点 `vm-service/src/server.ts:803`**：`error: { code: 'APPROVAL_REQUIRED', message: verdict.error?.message ?? '需审批' }`；令牌表 `pendingApprovals` 在**同文件 `:528`** 创建（`const pendingApprovals = new Map<string, PendingApproval>();`，注释段「审批闸登记（MCP 侧）」起始 `:527`）。注：设计文档记为 `:726`–`:791` / `:512`，与当前源码存在**行号漂移**，本文以读文件实测为准。

| # | 条件 | 落点 |
|---|---|---|
| **K3-a** | LLM 最终文本未命中 `/APPROVAL_REQUIRED\|等待审批/` | `bridge.ts` `APPROVAL_WAIT_PATTERN`（SK-9 不改清单内） |
| **K3-b** | `reconcileApprovalWait` 因此 `return base`，保留 `ok:true`、`error` 为 undefined | `if (!APPROVAL_WAIT_PATTERN.test(finalText)) return base;` |
| **K3-c** | `maybeResume` 的 `blocked` 读 `base.error` ⇒ 为 false ⇒ `return base`（不 raise、不挂起） | `maybeResume` 首两行 |
| **K3-d** | `reconcileDelegationTruth` 退场（门 3 无完成声称 / 门 4 无 probe / `total>0` 采信） | `delegation-truth.ts` |
| **K3-e** | `reconcileExecutionTruth` 退场（`ctx.replayActive === false`，因从未 raise） | D-1 门 1 |
| **K3-f** | `runGoalWithLifecycle` 按 `result.ok` 收口 `completed` | `a2a-framework/src/server.ts:365` `const finalState = result.ok ? 'completed' : 'failed';` |

### 1.4 危害定级：K3 > A5

| 维度 | A5（已修） | **K3（本项）** |
|---|---|---|
| 终态 | `failed` | **`completed`** |
| 可观测性 | **显式失败**：宿主立刻知道、可重试 | **静默**：宿主收到成功，零告警、零 failed 样本 |
| 触发条件 | 并发委派交叠（`endTask()` 误清单例）—— 相对罕见 | **单次委派 + LLM 措辞漂移** —— 常见，且随模型/版本/提示词漂移 |
| 失效方向 | **fail-closed**（安全闸咬死，任务失败） | **fail-open**（安全闸被绕过，且无人知晓） |
| 下游后果 | 任务失败，人工可重试 | 宿主/用户**据此认定高风险操作已完成**（如「已卸载/已删除」）⇒ 形成错误事实认知，**不会重试** |
| 定位成本 | 有 failed 终态 + 三段文案指纹可反查 | **无失败态** ⇒ 只能靠事后 grep「零调用但 completed」形态 |

> **定级理由**：A5 是「安全闸咬死」（显式噪声），K3 是「安全闸被绕过且无人知晓」（静默失效）。安全工程的基本排序是 **静默失败 ≫ 显式失败**。

---

## 2. 需求池

### P0-1 · 结构化判据 `reconcileApprovalTruth`（优先级 **P0**）

**现状**：三道既有防线在 K3 场景下**结构性失效且失效方向一致（都偏向放过）**：

| 防线 | 退场原因（K3 场景下） |
|---|---|
| K3 文本启发式（`reconcileApprovalWait`） | K3-a —— 它**正是**被绕过的那一道 |
| K5 回执反查（`reconcileExecutionTruth`） | D-1 门 1 `if (!this.replayEnabled \|\| !ctx.replayActive) return base;` —— K3 场景**从未 raise** ⇒ `ctx.replayActive` 恒 false ⇒ 整段退场 |
| K-N1 账本反查（`reconcileDelegationTruth`） | 三重退场：① 门 3 要求 `finalText` 命中完成声称（无声称则透传）；② 即便反查，`total` 可能因其它成功/失败调用非零 ⇒ 判「有活动」⇒ 采信；③ **常驻路径的 `blocked` 根本不进账本**（见 P0-2 的根因）⇒ 连 `blocked` 这一路证据都没有 |

**用户故事**：As a 宿主/安全审计者，I want 「本委派回合内是否有未决审批」由**服务端事实**判定而非 LLM 措辞，so that 即便 LLM 完全漂移，被拦的任务也必须以 `input-required` 挂起而不是 `completed`。

**验收标准（可机器判定）**：
- AC-1.1 **插入点**：新判据位于 `maybeResume` **之前**（`reconcileApprovalTruth` 把服务端事实翻译成 `base.error`，使既有 raise/挂起/重放链路原样工作）。
- AC-1.2 **7 门判定表**（自上而下短路）：门 0 `!base.ok` 透传 / 门 1 无 `taskId` 回退文本 / 门 2 开关 `off` 回退 / 门 3 无 probe 或缺 `approvalWait` 回退 / 门 4 probe 抛错 ⇒ 回退 **+ warn 恰一条** / 门 5 `facts.length===0` 回退 / 门 6 全部 fact 已 raise **且尚无服务端回执** ⇒ 回退；命中 ⇒ 改判。
- AC-1.3 **命中产出**：`ok:false` + `error.code='APPROVAL_REQUIRED'`，`details` 携带服务端权威 `approvalId` / `capabilityId` / `risk` / `attribution`(`'exact'|'window'`) / `source:'server-ledger'`，多未决项时其余进 `others` 并 warn。
- AC-1.4 **选取规则**：`facts` 按 `createdAtMs` 升序，取**第一个**不在 `ctx.raised` 中的（FIFO）。
- AC-1.5 **单向性**：只做 `ok:true → ok:false`，**绝不**做反向 ⇒ 任何路径都不可能制造**新的**假成功。

### P0-2 · 服务端探针与归因（优先级 **P0**）

**关键可行性事实（实地读码核实）**：
1. **桥与服务端同进程** —— `CliLlmBridge` 由 `vm-service` 的 `loadProvider(cfg.agent, bridgeCtx)` 加载，并与服务端 `VmApprovalCoordinator` 共享**同一对象实例** ⇒ **不需要任何跨进程/跨网络/改 MCP 协议的新通道**。
2. **服务端确实握有权威结构化事实** —— `pendingApprovals`（`vm-service/src/server.ts:528`，实测）字段最完备：`approvalId` / `capabilityId` / `risk` / `params` / `preview` / `impact` / `underlying` / `createdAtMs` / `hostApproved` / `traceId`（`/delegationId?`）。
3. **结构性缺口（V-3）**：常驻会话路径（**生产 A2A 主路径**）**不带 `dtid`** ⇒ `ctx.delegationId` 为 undefined ⇒ ① `PendingApproval.delegationId` 缺席；② `server.ts:767` `channel` 误标 `mcp`；③ `server.ts:770` `ledger` 为 undefined ⇒ `recordBlocked` **空操作** ⇒ `blockedEntries` 恒空（对 K-N1 `activityCount()` 的三个计数贡献**全部为 0**）。
   ⇒ **要补的不是「通道」而是「归因」**。

**归因规则（三条严格有序）**：

| 规则 | 条件 | 判定 |
|---|---|---|
| **R1 精确归因** | `entry.delegationId === D.traceId` | 属于 D（单次 `-p` 路径，`?dtid=` 生效） |
| **R2 精确排除** | `entry.delegationId` 非空且 `!== D.traceId` | **不属于 D**（跳过）—— 防串台的关键，且**必须先于 R3 判定** |
| **R3 窗口兜底** | `entry.delegationId` 缺席 **且** `entry.createdAtMs >= D.startedAtMs` **且** `!entry.hostApproved` **且** `capabilityId` ∈ D 的能力面 | 属于 D（窗口上界 = 判据执行时刻，`Date.now()`） |

**能力面取值优先级**：① 委派的 `LlmGoalInput.capabilities`（= `GoalRequest.allowedCapabilities`，最窄最准）；② 缺席/空 ⇒ 退服务端 `exposedIds`。

**验收标准**：`collectApprovalFacts` 三规则单测 —— given 三条 `pendingApprovals`（R1 命中 / R2 排除 / R3 命中）⇒ 返回第一条与第三条，排除中间那条；常驻路径 stub ⇒ `blockedFor` 返回 ≥1（证 `blocked` 通道在常驻路径**不再恒 0**）。

### P0-3 · 契约纯附加可选（优先级 **P0**，非破坏）

按 SK-4（契约增补一律「纯附加可选」）：新增 `DelegationTruthProbe.approvalWait?`（可选方法）、`ApprovalWaitQuery`、`PendingApprovalFact` 三个导出。既有实现方不实现仍合法，既有消费方不调仍合法。

### P0-4 · Phase D 阻塞修复：`runPersistent` 的 `!turn.ok` 分支（优先级 **P0**，T05 实施期发现）

**发现**：Phase D「shadow 轮」返回 **INCONCLUSIVE** 的根因 —— codebuddy 在 **stream-json（常驻会话）**模式下，把「高风险能力被审批闸拦截」这一**暂停态**回吐 `result` 事件并置 **`is_error=true`** ⇒ `turn.ok=false` ⇒ `CliLlmBridge.runPersistent` 的 `!turn.ok` 分支**直接返回 `EXECUTION_FAILED`**，**先于** `reconcileApprovalTruth` 执行 ⇒ K3R 判据被整体绕过，Phase D 永远 INCONCLUSIVE。

**需求**：在 `!turn.ok` 分支补**审批暂停甄别**，且必须满足：
- 优先方案 `reconcileApprovalTruth` **在本分支不可用**（门 0 `if (!base.ok) return base;` 拒绝 `ok:false`）⇒ 改复用既有文本启发式 `reconcileApprovalWait`（不拒绝 `ok:false`，且正是 `reconcileApprovalTruth` 在兜底路径的实现）；
- **shadow 门控**：shadow 态**仅 warn 不改判**（保持 `EXECUTION_FAILED` 以观察修复前假失败），与结构化探针的 shadow 纪律**逐字一致**（G4 纪律：shadow 必须能区分「未命中」与「根本没启用」）；
- `on`/`off` 态命中 `APPROVAL_REQUIRED` 时才经 `maybeResume` 改判路由到 `input-required`。

### P1-1 · 灰度开关运行时指纹 `/health`（优先级 **P1**，E-3 / E-3b）

**动机**：owner 拍板 D-3 要求发布前强制走一轮 `shadow` 真机测量。唯一行为学指纹 `[shadow] 未决审批结构化命中` **只在命中时出现**；shadow 轮未命中时无法区分「shadow 且未命中」与「根本没启用」⇒ 整轮测量不可证，违反「未复现 ≠ 已修、必须确定性注入」。

**需求**：`/health` 给出与命中**无关**的三态运行时指纹 `{ mode:'on'|'shadow'|'off', enabled, shadow }`，且**必须在构造 bridge 那一行一次性解析**（不得在 `health()` 里二次读 `process.env`，否则配置值 ≠ 生效值，产生假指纹）。

### P1-2 · 第三级兜底不得静默 fail-open（优先级 **P1**，E-2b）

文本兜底解析链 `deps.reconcileApprovalWait ?? approvalWaitFallback ?? ((b) => b)` 的第三级「恒等透传」在**没有任何兜底实现**时静默返回 `base`（表现：文本里有关键词也不 raise ⇒ `completed` + `ok:true`，与 K3 本体同一种静默假成功）。

**需求**：命中第三级时 emit 一条**可检索** warn（`'[k3r] 文本兜底缺席（未注入且未注册）→ 恒等透传，等同无兜底旧行为'`，meta 带 `{ gate, hasTaskId }`），**返回值仍为 `base`，判定逐字不变**。

### P2-1 · T05 真机门禁（优先级 **P2** 但为**发布前置**）

按 D-3：默认 `on`（根治态），但**发布前强制走一轮 `shadow` 真机测量**（量化 K3 命中率 + 串台率），再切 `on` 复跑证明根治。

**量化指标定义**：命中率 = 命中次数 / 总次数；串台率 = 串台次数 / 命中次数。切 `on` 的前置条件：**K3 命中率 > 0 且串台率 = 0**。

### P2-2 · 明确不实现（登记为待办，非本项范围）

| # | 事项 | 处置 |
|---|---|---|
| **Q4** | 让常驻路径也带 `?dtid=`（S4，精确归因） | **否决**：常驻会话的 `mcp.json` 会话级共享，逐次改写对已运行进程无效；唯一可行解是「按委派重建会话」⇒ 每条委派付一次 ≈75–107s 冷启动，**直接回退 K2 成果** |
| **Q5** | `pendingApprovals` 长会话累积 / 容量上限 / 超时回收 | **本轮不实现**（避免扩大改动面），列为观测项 |
| **Q6** | V-4：`recordBlockedApprovalAudit` 的 `channel` 误标 `mcp` | 不在 CL-K3R 范围（R3 归因用 `createdAtMs` 窗口而非 `channel`，故**不受影响**），归 K-N1 后续收口 |
| **Q7** | V-5：`LedgerRegistry.ledgerForInnerTrace()` 死代码（全仓无调用点） | 不复用（其匹配面不含被拦调用自身的 traceId），清理候选 |

---

## 3. 裁定（已裁定决策，不得自行再权衡）

### 3.1 owner 拍板记录（§9.4，2026-10-04）

| # | 决策点 | 裁定 |
|---|---|---|
| **D-1** | 「直读 MCP 结构化工具结果」的口径 | **认可**「直读服务端落地的 `pendingApprovals` / 哈希链」≈「读 MCP 结构化工具结果」，按 S1 进入实施；否决议题 C-5（拦截点直发事件队列） |
| **D-2** | `reconcileApprovalWait` 降为兜底是否违反 SK-9 | **接受**：函数体零改动、仅调用层级后移不违反 SK-9；指纹仍可逐字节比对 |
| **D-3** | 默认开关 | **默认 `on`**（根治态）；**发布前强制走一轮 `shadow` 真机测量**量化命中率与串台率，再切 `on` 复跑 |

### 3.2 上游来源说明

CL-K3R 是 **A5（CL-R19F）的增量续作**，无独立 PRD 上游（`.dev/changing-log.md` 追记项 + owner 直接拍板）。因此本节不重复 PRD 结论：所有权衡以上文 §3.1（owner 拍板 D-1/D-2/D-3）与 §3.4（实施期偏差 E-1~E-5）为准。A5 合同 `§4` 的 `SK-1`～`SK-9` **全部继续有效**，本设计只在 §3.3 标明「哪些被 K3R 直接继承、哪些被 K3R 局部收紧」。

### 3.3 硬约束与红线（每次 commit 后自检）

| 编号 | 约束 | 本轮状态 |
|---|---|---|
| **D-1** | `reconcileExecutionTruth` 内两道门（`replayEnabled \|\| replayActive` / `raised.size === 0`）语义·顺序·短路条件**一字不改** | **不触及** |
| **D-4** | `packages/a2a-framework/src/**` **零改动** | **遵守**（依据 `docs/design/cl-k3r-impl-progress.md` §6 红线自检表记录的该验证结论；本环境无版本控制系统，未独立复核） |
| **D-5** | `rejected` 唯一置位点 = `a2a-framework/src/server.ts:306` | **不破坏**（净效果：让 `:306` 更常可达，而非多出置位点） |
| **C-1** | `endTask(taskId?)` 零参/空串语义不变 | **不触及** |
| **A2b** | 生产 A2A 主链路必带非空 `taskId` | **依赖**此事实（门 1 以 `taskId` 非空为前提） |
| **SK-4** | 契约增补纯附加可选 | **遵守** |
| **SK-5** | `dist` 必须先重建再跑测（`npx tsc -b tsconfig.build.json`，根级路径） | **写入验收判据** |
| **SK-9** | `APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` / `reconcileApprovalWait` 函数体与文案**一字不改** | **遵守**：三者源码零改动，仅调用层级降为兜底 |
| **SK-K1** | 探针注入纪律：可选 + fail-open（绝不阻断主链路） | 新增 |
| **SK-K2** | `WINVM_APPROVAL_TRUTH` 三态语义 | 新增 |
| **SK-K3** | `pendingApprovals` 内存态 caveat（重启即空 / 只含未决 / 长期累积风险） | 新增（须集体知悉） |
| **SK-K4** | R1/R2/R3 归因严格有序；R2 必须先于 R3；窗口阈值与 `DelegationLedger.inWindow`/`isExposed` **同源** | 新增 |
| **SK-K5** | dist 重建 + 依赖方向守卫 | 新增（注：`npm run layout`/`scripts/dep-lint.mjs` **在本仓库不存在**，见 E-4，改以人工方向核对替代。**2026-10-08 闭环**：QA R3 `c10a400` 已删除 `layout` 脚本键，`dep-lint` 属 Phase 2 规划） |
| **SK-K6** | 新判据**单向 fail-closed**；命中改判的 `error.code` 复用 `APPROVAL_REQUIRED` 前缀（保 A5 样本可比） | 新增 |
| **SK-K7** | D-1 / D-4 / D-5 三道红线**一字不动** | 新增 |

### 3.4 实施期偏差登记（E-1 ~ E-5，`cl-k3r-impl-progress.md` §6/§7）

| # | 偏差 | 处置 |
|---|---|---|
| **E-1** | 门 6 原条文「全部 fact 已在 `ctx.raised` ⇒ 回退」在续跑轮会让 `maybeResume` 因 `blocked=false` 返回 `ok:true`，`applyReceipt` 永不触达 ⇒ 回执失败时反而产出 `completed`（**新的假成功**） | 门 6 前提收窄为「已 raise **且尚无服务端回执**」；已有回执 ⇒ 不跳过，交 `applyReceipt` 以真实回执收口。**并升为设计勘误 §9.5**（commit `574f9c9`） |
| **E-2** | `reconcileApprovalWait` 原非导出，纯逻辑件需复用 ⇒ 静态环 | **owner 裁定：不许搬函数**（搬走即破坏 SK-9 落点），改用**依赖注入**去环：`deps.reconcileApprovalWait` 由 bridge 在两处收口点显式传入 + `registerApprovalWaitFallback()` 模块级注册（commit `95052d5`）。去环后 `bridge.ts` 的 `reconcileApprovalWait` 已**还原为原状**（`export` 关键字撤回，函数体与注释块零改动） |
| **E-3** | `BlockedEntry` 原不含 `createdAtMs` / `risk` | 以**可选**字段追加（`createdAtMs?`/`risk?`/`delegationId?`/`attribution?`），缺席回退 `ledger.startedAtMs` / `'L1'` |
| **E-4** | `npm run layout`（依赖方向守卫脚本）**在本仓库不存在**（`MODULE_NOT_FOUND`） | 已知既存问题，**本轮不修**；以**人工方向核对**替代（新增导出全落 `contracts`/`core`，`vm-service`/`adapter-*` 反向依赖，方向未破坏） |
| **E-5** | shadow 态需要「计算但不改判」，原设计只有 `enabled` | `deps` 追加可选 `shadow?: boolean`；桥构造两个只读字段 `approvalTruthEnabled` / `approvalTruthShadow` |

### 3.5 设计勘误（§9.5，2026-10-05）

**E-1 升格为勘误**：只修订 §5.3 门 6 的**适用前提**，§0–§8 结论一律不动。理由见上表 E-1 的代码级反证（属 §5.4「绝不制造新的假成功」的必然要求）。

---

## 4. 影响范围

### 4.1 源码 / 契约（`packages/**`）

| 文件 | 任务 | 改动 |
|---|---|---|
| `packages/contracts/src/bridge.ts` | T01 | `DelegationTruthProbe` 追加**可选** `approvalWait?`（C-K1）；新增导出 `ApprovalWaitQuery`（C-K2）/ `PendingApprovalFact`（C-K3）；E-3 再追加 `HealthStatus.approvalTruth?` |
| `packages/core/src/constants.ts` | T01 | `ENV_APPROVAL_TRUTH='WINVM_APPROVAL_TRUTH'` + `resolveApprovalTruth(env)`（非法/缺席一律回退 `'on'`） |
| `packages/vm-service/src/delegation-audit.ts` | T01 | `LedgerRegistry.blockedFor(q)`（R1/R2/R3）、`recordBlocked(...)` 窗口归因入口、`DelegationLedger.blockedFacts()` |
| `packages/vm-service/src/approval-replay.ts` | T02 | 新增**纯函数** `collectApprovalFacts(pending, q, nowMs)` |
| `packages/vm-service/src/server.ts` | T02 | `delegationProbe` 字面量内补 `approvalWait`；拦截记账处补窗口归因（补 V-3） |
| `packages/vm-service/src/index.ts` | T02 | re-export `collectApprovalFacts` / `PendingApprovalFact` |
| `packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts` | T03 / E-2b | 新增导出 `reconcileApprovalTruth`（7 门）；E-2b 把兜底解析拆为 `fallback` + `runFallback(gate,…)` |
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts` | T03 / E-2 / Phase D | 新增 `approvalTruthEnabled` / `approvalTruthShadow` 只读字段；`reconcileApprovalTruth` 接线；两处收口点改造；**Phase D**：`runPersistent` 的 `!turn.ok` 分支补审批暂停甄别 |
| `packages/adapter-agent-workbuddy-llm/src/index.ts` | T03 / E-3 | `resolveApprovalTruth` 注入 + 包出口导出 `reconcileApprovalTruth`；E-3 `health()` 补 `approvalTruth` 字段（值在构造期解析） |
| `packages/a2a-framework/src/**` | — | **零改动**（D-4；守门结论出处同上） |

### 4.2 测试 / QA 资产

| 文件 | 性质 | 说明 |
|---|---|---|
| `tests/unit/r19c-k3r-approval-truth.test.js` | QA 红档（T04） | `reconcileApprovalTruth` 判定表 7 门 + 归因选择与 `others`（**11/11**） |
| `tests/unit/r19c-k3r-approval-wait.test.js` | QA 红档（T04） | `collectApprovalFacts` / `blockedFor` R1/R2/R3 + **串台排除**（**10/10**） |
| `tests/unit/r19c-k3r-bridge-integ.test.js` | QA 红档（T04） | 端到端：stub 探针有未决事实 + CLI 文本**不含**关键词 ⇒ 终态 `input-required`（**2/2**） |
| `tests/unit/cl-k3r-runpersistent-approval-routing.test.js` | 新增（Phase D） | 4/4 PASS：A `!ok`+审批文本→`APPROVAL_REQUIRED`；B `!ok`+真错→`EXECUTION_FAILED`；C `ok:true` 回归护栏；D shadow+审批文本→仅 warn |
| `qa/r19/a2a-extra.mjs` | T05 驱动 | `k3r` 子命令；2026-10-06 **harness 收紧**（默认 goal 强制直调 `app.winget.uninstall`、新增 `capabilityIdsOf`、新增 `sidestepDetected` 分支） |
| `tests/unit/k5-replay.test.js` | 回归护栏 | **41/41 绿**（D-1 未削弱；这些用例无 `approvalWait` ⇒ 门 3 逐字节旧行为） |
| K-N1 七文件 | 回归护栏 | `r19c-kn1-{a-pure,b-bridge,c-session,d-provider,e-shape,e-mutation,f-chain}` 合计 **242** 绿 |

### 4.3 提交序列（**哈希出处见本节下注脚；未经版本控制系统复核**）

| 组 | Commit | 说明 |
|---|---|---|
| 设计 §0–§2 | `2d2b8a1` `497bdec` | 口径与硬约束（V-1~V-5 偏差登记）、K3>A5 定级、现状时序图与假成功产生点 |
| 设计 §3–§4 | `4b054a3` `8432b4e` | 五通道 C-1~C-5、V-3 常驻缺口实证、R1/R2/R3 归因；四候选 S1~S4 |
| 设计 §5–§6 | `d842122` `d1e504f` | 判据函数 / 7 门 / fail-closed / 三态开关 / 类图；契约改动 C-K1~K3 |
| 设计 §7–§10 | `c5ec792` `2e4947b` `72bc728` `3d6fed6` | 任务分解 T01~T05、SK-K1~K7、D-1~D-3 与 Q4~Q7、风险与回滚 |
| QA 红档 | `c1f1288` `6b36cdf` `b4e0fb7` | 三个红档测试（先红后绿） |
| 拍板 / 驱动 | `24aad62`（owner 拍板记录 STATUS→APPROVED）；另两笔（`k3r` 子命令真机驱动、红档失败根因与修复清单）**hash 未在仓库文档中检索到，待核实** | 同左 |
| T01/T02/T03 | `748ca8d` `fa8038e` `be90be2` | 契约底座 / 服务端探针 / 桥侧判据与接线 |
| 验收与裁定 | `574f9c9` `95052d5` `7669e1f` | 偏差登记 E-1~E-5；§9.5 勘误；E-2 去环；裁定落盘（另有一笔「T01-T03 验收记录与红线自检」，**hash 未在仓库文档中检索到，待核实**） |
| T05 准备 | `ccdbd61` `c396b98` `c7387e5` | Runbook；E-2b/E-3 任务书；实施计划落盘 |
| E-2b / E-3 | `c3899d4` `614c6ad` `cd40ac3` | 第三级兜底可观测；`/health` 三态指纹；自证落盘 |
| **E-3b** | （**hash 未在仓库文档中检索到，待核实**） | `/health` 上 `provider.approvalTruth` 看不到 ⇒ 实际出口为**顶层** `providerApprovalTruth`（T05 真机 Phase B 实测命中）；**成因未在报告中记录** |

> **说明**：区间内另有若干 commit 属**穿插的另一个变更集**（tunnel 运行时崩溃治理，见 `docs/design/tunnel-crash-fix-progress.md`），**不属于 CL-K3R**，此处仅作去重登记。
>
> **注（哈希出处）**：本节 hash 的检索来源是 `docs/design/cl-k3r-impl-progress.md`、`docs/design/cl-k3r-silent-false-success-design.md`、`.workbuddy/memory/2026-10-0{4,5}.md`。凡未在以上文档中命中的 hash，均在行内标注「**未在仓库文档中检索到，待核实**」。**未经版本控制系统复核。**

### 4.4 尚未落版本控制的工作项（**重要**，截至本文归档时）

**依据**：`docs/test/reports/k3r-t05-real-machine-2026-10-06.md` §10.1 明文 ——「**git 提交**（沙箱无 git，须在真实开发机）」，并列出了待 add 的文件清单。本文据此登记，**未使用任何版本控制命令复核**（本环境无法执行）。

| 文件 | 报告登记状态 | 内容 | 本文可核验处 |
|---|---|---|---|
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts` | 待 commit | Phase D 的 `runPersistent` `!turn.ok` 分支修复 | 源码现状可复核：`bridge.ts:1236-1268` 已含该分支（`if (!turn.ok)` 起于 `:1236`，闭合于 `:1268`） |
| `qa/r19/a2a-extra.mjs` | 待 commit | 2026-10-06 harness 收紧 | 源码现状可复核：`capabilityIdsOf` `:134`、`sidestepDetected` `:671`、`INCONCLUSIVE_SIDESTEP` 字符串 `:679` |
| `tests/unit/cl-k3r-runpersistent-approval-routing.test.js` | 待入库（报告列为新增） | Phase D 宿主单测 4/4 PASS | 文件现状可复核：当前实测 **149 行** |
| `docs/test/reports/k3r-t05-phase-d-blocker-2026-10-05.md` | 待入库 | Phase D 阻塞根因诊断报告 | 已存在于 `docs/test/reports/` |
| `docs/test/reports/k3r-t05-real-machine-2026-10-06.md` | 待入库 | T05 真机验证完成报告 | 已存在于 `docs/test/reports/` |

> 报告建议的 commit message：`fix(k3r): runPersistent !turn.ok 分支补审批暂停甄别 + T05 真机验证通过`（harness 收紧追加 `+ k3r harness 收紧`）。
