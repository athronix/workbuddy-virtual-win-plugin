# A5 审批未挂起根因判定

STATUS: PARTIAL

> 只读根因判定。未修改 `packages/**` 任何文件，未跑部署脚本，未连 VM。
> 证据引用 `文件:行`（段落标签为主、行号为辅）。

## 0. 证据基与判定方法

### 0.1 证据

| 用途 | 文件 | 关键事实 |
| --- | --- | --- |
| 失败样本 | `qa/r19/a2a-x5-reject-v1.out.json` | task `51229514-2438-44f3-b44d-53ad9070b327`；`reachedInputRequired=false`；终态 `failed` @ `16:03:37.915Z`；status.message.parts[0].text = 「等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED），目标「LLM 运行时（常驻会话）完成目标：…」未执行完成，须经宿主人工审批后经 MCP 直调通道续跑；approvalId=apr_a9aabfcffb5f4246b918」；parts[1].data.steps[0] = `{capabilityId:'appops.workflow.run', risk:'L1', ok:false, durationMs:12454, summary:'等待审批（未执行完成）'}`；metadata 无 `approvalTimedOut` |
| 时序 | `qa/r19/a2a-x5-reject-v1.timeline.log` | send `16:03:20.870Z` → poll working `16:03:31.095Z`（bytes 559，与 20.975Z 同尺寸 = 状态未变）→ failed `16:03:41.229Z`（终态时刻 `16:03:37.915Z`）。全程 17.045s |
| 交叠方 | `qa/r19/a2a-x4-cancel.timeline.log` / `a2a-x4-cancel.out.json` | task `48a90a2f-82a3-427f-bbdd-bf6a3a8aceee`（A4，goal=递归遍历 System32 全部 .dll，maxRisk=L1 只读）send `16:03:07.089Z` → `tasks/cancel` `16:03:09.765Z` state=canceled；此后**再无任何状态更新** |
| 同期其它委派 | `qa/r19/a2a-x1-stream.timeline.log` | X1 completed `16:02:19.128Z`；X4 首个对照任务 `0867d060…` completed `16:02:53.930Z`。**均在 A5 之前收尾** |
| 成功对照 | `qa/r19/e1r2-delegate.out.json` | task `9a0fedfe-c228-4778-ad83-5ced12dd2730`：结构化 `approval-request`（risk=L2）→ input-required → 批准后 139ms → completed |

### 0.2 判定方法（两条，互相独立）

**方法 A｜终态文案指纹法**：把 A5 的终态 `status.message.parts[0].text` 与 `steps[*].summary` 逐字回查源码中的模板串，定位**它究竟由哪个函数产出**，从而反推执行走到了哪一步、在哪一步返回。

**方法 B｜反证排空（K4 安全网）**：`packages/a2a-framework/src/server.ts` "K4 安全网" 段（`runGoalWithLifecycle`，`recNow.task.status.state === 'input-required' || recNow.pendingApproval` 判断处）规定：**只要任务曾被置为 `input-required`，终态回调就提前 return，绝不写 `failed`**。据此可证伪一切「挂起过、后来被收口」的假设。

---

## 1. 结论

### 1.1 根因（一句话）

`packages/vm-service/src/server.ts` `VmApprovalCoordinator.raise()` 首行守卫
`if (!this.activeTaskId || !this.tasks) return { approved: false, reason: 'no-active-task' };`
在 A5 上命中了 **`!this.activeTaskId`** ⇒ **从未调用同函数内的 `this.tasks.waitApproval(this.activeTaskId, enriched)`**（`waitApproval` 调用点，即「置 input-required 并挂起等待宿主应答」段之前的一行）⇒ A5 的任务**从不进入 `input-required`** ⇒ 桥侧 `maybeResume` 走到 `if (!outcome.approved) return base;`，把 `reconcileApprovalWait` 的产物原样返回（ok=false）⇒ `packages/a2a-framework/src/server.ts` `runGoalWithLifecycle` 内 `const finalState: A2A.TaskState = result.ok ? 'completed' : 'failed';` 收口为 **failed**。

**条件表达式原文**：`!this.activeTaskId || !this.tasks`（`vm-service/src/server.ts`，`raise()` 首行）。
**A5 命中的子条件**：`!this.activeTaskId`（`this.tasks` 已排除，见 §3.2）。

### 1.2 为什么一定是这一行 —— 排空表

`maybeResume`（`packages/adapter-agent-workbuddy-llm/src/bridge.ts`，「K5 审批续跑中枢」段）到 `waitApproval` 之间，共有 5 个可能「不挂起就返回」的出口。逐一判定：

| # | 出口 | 条件原文 | 判定 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | `maybeResume` 首门 | `const blocked = base.error?.code === 'APPROVAL_REQUIRED' \|\| !!base.error?.details?.approvalId;` → `if (!blocked \|\| !this.coordinator) return base;` | **未命中**（blocked=true、coordinator 存在） | 见 §3.1、§3.2 |
| 2 | `maybeResume` 无 token | `if (!approvalId) return base;` | **未命中** | 终态文本含 `approvalId=apr_a9aabfcffb5f4246b918`，该串**只有** `reconcileApprovalWait` 在 `parsed.approvalId` 为真时才拼出（`bridge.ts` `summary` 模板的 `parsed.approvalId ? … ;approvalId=… : ''`），故 `error.details.approvalId` 必然已写入 |
| 3 | `maybeResume` 二次 raise | `if (this.raisedApprovals.has(approvalId)) return this.applyReceipt(approvalId, base);`（无回执时 `applyReceipt` 原样 `return base`） | **未命中** | `raisedApprovals` 在每次 `runGoal` 入口 `.clear()`（`bridge.ts` `runGoal` 开头三行清理之一）；A5 全程只 raise 一次；`apr_a9aabfcffb5f4246b918` 是本次拦截随机生成，不可能被其它委派先行登记 |
| 4 | `raise` 首行守卫 | `if (!this.activeTaskId \|\| !this.tasks) return { approved:false, reason:'no-active-task' };` | **✅ 命中** | 这是唯一在 `waitApproval` **之前**的出口，且 `activeTaskId` 可被并发委派清空（§3.1） |
| 5 | `raise` 后置出口 | `timedOut ? 'timeout' : 'rejected'`；`if (!token) return { approved:false, reason:'rejected' }` | **未命中** | 全部位于 `await done`（即 `waitApproval`）**之后**；若走到这里，任务必先被置 `input-required`，与方法 B 矛盾（§1.3） |

### 1.3 反证：A5 的 `waitApproval` 一定没被调用（方法 B）

假设 `waitApproval(51229514…, req)` 被调用过，则 `task-store.ts` `waitApproval` 段会执行 `this.updateStatus(id, 'input-required', this.approvalMessage(id, req))`。此后不论如何收口：

- **宿主应答 / 被 cancel 触发 `resolve(false)`**（`requestCancel` 段 `rec.pendingApproval.resolve(false)`）→ `finish(false,'host-reply')` 只清 `pendingApproval`、**不改状态**，状态仍是 `input-required` → `runGoalWithLifecycle` 的 K4 安全网命中 → **return，终态恒为 `input-required`**；若为 cancel 路径，状态已是 `canceled`（`canceled` ∈ `TERMINAL_TASK_STATES`，`packages/contracts/src/bridge.ts` `TERMINAL_TASK_STATES`），`updateStatus` 因 `isTerminalTaskState` 早退 → **终态恒为 `canceled`**。
- **TTL 超时** → `finish(false,'timeout')` 写 `updateStatus(id,'failed', approvalTimeoutMessage(…))` 并落 metadata `approvalTimedOut:true`。

实测终态是 **`failed` + `reconcileApprovalWait` 文案 + metadata 无 `approvalTimedOut`**，三条路径全部不符 ⇒ **`waitApproval` 从未对 task `51229514…` 调用**。⇒ 出口只能落在 §1.2 的 #1~#4 中；#1~#3 已被独立排除 ⇒ **#4**。

---

## 2. `reconcileApprovalWait` 假设：推翻（作为 A5 根因）／证实（作为潜在缺陷）

### 2.1 判定

**推翻**：`bridge.ts` `reconcileApprovalWait` 的「LLM 措辞启发式」**不是 A5 未挂起的原因**。
**同时证实**：它仍是一个**独立的、会复现同类症状的潜在缺陷**（K3 遗留条目依然成立），建议与 §5 一并治理，但不属本次 A5 的因果链。

### 2.2 blocked 判定的确切条件（原文）

`reconcileApprovalWait` **不是** blocked 的判定位，它只是 blocked 的**制造者**。两处判据必须区分：

1. **文本匹配门（是否改写为「等待审批」）** —— `packages/adapter-agent-workbuddy-llm/src/bridge.ts` 常量：
   ```ts
   const APPROVAL_WAIT_PATTERN = /APPROVAL_REQUIRED|等待审批/;
   ```
   函数首行：`if (!APPROVAL_WAIT_PATTERN.test(finalText)) return base;`
   - 命中 → 产出 `ok:false`、summary 模板「等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED），目标「${base.summary}」未执行完成，须经宿主人工审批后经 MCP 直调通道续跑」+ `;approvalId=${parsed.approvalId}`，steps 全量改写为 `'等待审批（未执行完成）'`，并 `makeError('APPROVAL_REQUIRED', 'LLM 上报等待宿主人工审批，操作未执行', { details:{ approvalId, capabilityId?, risk } })`。
   - **不命中 → 直接 `return base`（兜底输出）**：保留 `base.ok=true`（常驻路径即「LLM 运行时（常驻会话）完成目标：…」），`error` 为 undefined。此时 `maybeResume` 的 `blocked = base.error?.code === 'APPROVAL_REQUIRED' || !!base.error?.details?.approvalId` 为 **false** ⇒ 直接 `return base` ⇒ **不 raise、不挂起**，任务以 `completed` 收口（这就是「结构性假成功」，K3 描述的兜底缺陷）。

2. **结构化门（是否 raise）** —— `maybeResume` 首行 `const blocked = base.error?.code === 'APPROVAL_REQUIRED' || !!base.error?.details?.approvalId;`。**它读的是 `base.error` 的结构化字段，不读文本**。所以只要 `reconcileApprovalWait` 命中过，`blocked` 必为真。

### 2.3 A5 的 finalText 是否满足

**满足，且是被满足后的产物本身。** 三段逐字指纹：

| 指纹 | 源码位置 | A5 实测值 |
| --- | --- | --- |
| summary 前缀 | `reconcileApprovalWait` summary 模板 | `等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED），目标「LLM 运行时（常驻会话）完成目标：卸载 VM 上的软件包 QA.R19B.Nonexistent.99997（该包 id 故意不存在，勿改动其它任何软件）」未执行完成，须经宿主人工审批后经 MCP 直调通道续跑` ✔ 逐字一致 |
| `;approvalId=${parsed.approvalId}` | 同上（三元拼接） | `；approvalId=apr_a9aabfcffb5f4246b918` ✔ |
| step summary | `steps: base.steps.map((s) => ({ ...s, ok:false, summary:'等待审批（未执行完成）' }))` | `summary:"等待审批（未执行完成）"`、`ok:false` ✔ |
| step 结构 | `runPersistent` 构造的 step（`index:0, capabilityId:'appops.workflow.run', risk:'L1', params:{goal,runtime,session:'persistent'}`） | A5 artifact `execution-steps` 的 step 逐字一致（含 `session:"persistent"`）✔ |

即：A5 的 LLM 最终文本 `turn.text` **确实命中了** `/APPROVAL_REQUIRED|等待审批/`，`reconcileApprovalWait` 完整执行，`base.error.code='APPROVAL_REQUIRED'`、且 `details.approvalId='apr_a9aabfcffb5f4246b918'` 已写入 ⇒ `maybeResume` 的 `blocked` **为真**，程序**确实走到了 `this.coordinator.raise(req)`**。

**结论**：「两次委派 LLM 措辞不同 ⇒ 一次判 blocked、一次判成失败结果不 raise」的假设**不成立**。A5 与 E1r2 在这一步上**没有差别**（都 blocked），差别发生在下一步 `raise()` 内部。

### 2.4 遗留风险（须写入 spec，但不属本次因果）

`APPROVAL_WAIT_PATTERN` 是**纯文本启发式**：只要 LLM 最终文本里既不出现 `APPROVAL_REQUIRED` 也不出现「等待审批」（例如 LLM 把拦截信息改写、或只回显 `approvalId` 而不带错误码），`reconcileApprovalWait` 就返回 `base`（ok=true）⇒ `blocked=false` ⇒ **不挂起、不 raise，任务直接 `completed`**。这是比 A5 更危险的一条静默失效路径（挂起丢失 + 假成功）。根治方向（K3 遗留条目原意）：桥改为直读 MCP 结构化工具结果（拦截时服务端已落的 `APPROVAL_REQUIRED` 记录 / `pendingApprovals` token），而非匹配 LLM 措辞。

---

## 3. P1 / P2 / P3 判定

### 3.1 P1 —— 服务级单例 `activeTaskId` 被上一次委派的收尾清掉：**成立（根因）**

**机制链（逐行已复核）**

1. `packages/vm-service/src/server.ts` `VmApprovalCoordinator` 字段声明段：`private activeTaskId: string | undefined;` —— **服务级单例**，全进程唯一。
2. 同文件 `beginTask(taskId)` / `endTask()` 段：`beginTask` 无条件 `this.activeTaskId = taskId;`，`endTask` 无条件 `this.activeTaskId = undefined;` —— **后者不接受 taskId**，无法归属。
3. 同文件 `raise()` 首行：`if (!this.activeTaskId || !this.tasks) return { approved:false, reason:'no-active-task' };` —— 命中即**跳过** `this.tasks.waitApproval(...)`。
4. `packages/adapter-agent-workbuddy-llm/src/bridge.ts` `runGoal`：`this.coordinator?.beginTask(input.taskId ?? '');` … `try { return await this.runGoalInner(...) } finally { this.coordinator?.endTask(); }` —— **每一次**委派收尾都无条件清空单例。
5. 单例来源：`vm-service/src/server.ts` 只 `new VmApprovalCoordinator()` 一次（`createService`「桥接上下文」段注释「须先于 bridgeCtx 创建」处），经 `bridgeCtx.approvalCoordinator` 注入唯一 provider；`packages/core/src/bridge/loader.ts` `loadProvider` 内 `await provider.init(ctx)` 一次；`packages/adapter-agent-workbuddy-llm/src/index.ts` `init()` 内 `if (ctx.approvalCoordinator) this.bridge.setApprovalCoordinator?.(ctx.approvalCoordinator);`；`bridge.ts` `setApprovalCoordinator` 存到 `this.coordinator`。**全链单实例**。

**为什么 A4 的收尾一定落在 A5 的窗口内（本次事件的关键，QA 此前未闭合）**

`packages/adapter-agent-workbuddy-llm/src/persistent-session.ts` 「轮次（串行）」段：`private enqueue<T>(fn)` 用 `this.chain.then(fn, fn)` 把**所有轮次串成一条链**，`runTurn` 整体包在 `this.enqueue(async () => …)` 内。
又：`bridge.ts` `ensureSession(outputDir, …)` 以 `this.persistent && this.persistentDir === outputDir` 复用 —— 所有委派 `outputDir` 同源 ⇒ **共用一个串行会话**。

于是（时间均为 2026-10-02，取自 §0.1）：

```
07.089  A4 send        → A4 beginTask(48a90a2f…) ，A4 turn 入链并开始
09.765  A4 cancel      → state=canceled；turn 不受影响（见 P3-c）
20.870  A5 send        → A5 beginTask(51229514…)；A5 turn 入链（排在 A4 turn 之后）
T       A4 turn 结束   → A4 的 runGoal 继续：pump.flush → collectArtifacts → maybeResume
                         （A4 只读 L1，!blocked 立即 return base）→ reconcileDelegationTruth
                         → finally  endTask()   ◀── 清空单例
T+δ     A4 endTask 生效（δ = A4 收尾耗时，量级 0.05~2s）
20.872+Δ A5 turn 开始（Δ = A5 排队等 A4 turn 的时间 ≥ 0）
        A5 turn 跑 12.454s（实测 durationMs=12454）
        A5 raise()  ◀── 此刻读 activeTaskId，已被 A4 清成 undefined
37.915  A5 终态 failed
```

由 `37.915 − 20.872 = 17.043 = Δ + 12.454 + (A5 收尾开销)` 得 **Δ ≤ 4.589s**；又 `A4turnEnd = A5turnStart = 20.872 + Δ` ⇒

> **可证伪的定量预测**：A4 那一轮 LLM turn 的结束时刻落在 **≈ 16:03:20.87 ~ 16:03:25.46**（即 turn 耗时 ≈ 13.8 ~ 18.4s）。
> 验证方式（最小）：VM 服务日志 `[llm-session]` 的「轮次耗时」行（CL-018 C1 已把轮次生命周期事件提到 info 级）中 task `48a90a2f…` 对应轮次的 durationMs；若落在上述区间，P1 时序完全闭合；若明显 <13.8s（A4 turn 在 A5 beginTask 前就已结束并收尾），则需回到 §1.2 复查出口 #1/#3。
> 注：即便该预测不成立，§1.2 的排空表 + §1.3 的反证已独立锁定 #4；本条只用于把「哪一次交叠」坐实到 A4。

另注：X1（`16:02:19.128` completed）与 X4 对照任务 `0867d060…`（`16:02:53.930` completed）均在 A5 之前收尾，**唯一可能的交叠方就是 A4（`48a90a2f…`）**。

### 3.2 P2 —— `this.coordinator` 未注入：**排除**

- 注入链无条件：`vm-service/src/server.ts` `createService`「桥接上下文」段 `const approvalCoordinator = new VmApprovalCoordinator();` → 同段 `bridgeCtx` 对象字面量含 `approvalCoordinator`（注释「K4：审批协调器（须先于 bridgeCtx 创建，以便注入 provider）」）→ `await loadProvider(cfg.agent, bridgeCtx)`（`packages/core/src/bridge/loader.ts`）→ `await provider.init(ctx)` → `packages/adapter-agent-workbuddy-llm/src/index.ts` `init()` `if (ctx.approvalCoordinator) this.bridge.setApprovalCoordinator?.(ctx.approvalCoordinator);` → `bridge.ts` `setApprovalCoordinator`。**没有任何分支可使其缺席**（除非 provider 加载失败进入 degraded，但那样 A5 根本跑不出 LLM 结果）。
- 反证更强：若 `coordinator` 为 undefined，`maybeResume` 在首门就 `return base`，`base` 仍是 `reconcileApprovalWait` 产物 —— **与 P1 的终态完全同形**，故单看终态无法区分；但契约上 `packages/contracts/src/bridge.ts` `BridgeContext` 段 `readonly approvalCoordinator?: ApprovalCoordinator;` 的可选性只影响「非 vm-service 宿主/单测」，vm-service 恒注入。
- 结论：**P2 不成立**。判级为「结构性排除」，不需要真机实验。

### 3.3 P3 —— 新发现的第三条（类）路径：**存在，且必须一并修**

**P3-a｜`endTask()` 无参数 ⇒ 归属信息在契约层就丢掉了**（本次未触发，是 P1 的放大器）
`packages/contracts/src/bridge.ts` `ApprovalCoordinator` 接口：`beginTask(taskId: string): void;`（`:313`）与 **`endTask(): void;`（`:315`，`raise` 在 `:322`）** —— `endTask` 不接收 taskId，实现方**无从判断**该清谁的。同时 `bridge.ts` `runGoal` 用 `this.coordinator?.beginTask(input.taskId ?? '')`，`taskId` 缺席时会写入空串（falsy）⇒ `raise` 同样静默 `no-active-task`。
> 修正团队 lead 给的行号：`contracts/src/bridge.ts` 中 beginTask=**313**、endTask=**315**、raise=**322**（不是 313/322 两个 begin/end）。

**P3-b｜桥上另有 3 处「per-delegation 状态」挂在共享单例上，交叠时同样静默错判（真正的第二路径）**
`packages/adapter-agent-workbuddy-llm/src/bridge.ts` 字段段：`private readonly taskReceipts = new Map<string, ExecutedResult>();`、`private readonly raisedApprovals = new Set<string>();`、`private k5ReplayActive = false;` —— 三者都在 `runGoal` 入口被 `.clear()` / `= false`。两个委派交叠时：
- B 的入口清空 A 已登记的回执 ⇒ A 后续 `applyReceipt(approvalId, base)` 取不到回执 ⇒ `return base`（保持「等待审批」/失败态）⇒ **A 被静默改判**；
- B 的入口清空 A 的 `raisedApprovals` ⇒ A 续跑轮再次 raise 同一 approvalId 时去重失效 ⇒ **二次挂起**（K4 旧 token 复用缺陷复发）；
- `k5ReplayActive` 跨任务残留/被清 ⇒ 回执反查错误介入或错误退场。
症状与 P1 同类（静默、只在并发下出现、无日志）。**只修 `activeTaskId` 而不修这三项，等于把同一个缺陷留下三条支路。**

**P3-c｜`cancelRequested` 只写不读 ⇒ cancel 不中断 turn（P1 的使能条件，非独立根因）**
`packages/a2a-framework/src/task-store.ts`：字段声明 `cancelRequested: boolean;`（`InternalTask`）、初始化 `cancelRequested: false;`（`create`）、赋值 `rec.cancelRequested = true;`（`requestCancel`）——**全仓无读取点**。故 `tasks/cancel` 只改了任务状态，**LLM turn 继续跑完**，`runGoal` 的 `finally → endTask()` 仍在数秒后触发，制造交叠窗口。
判级：**使能条件**。修它可显著收窄窗口（且 `tasks/cancel` 语义才真正成立），但不修它、只修 P1 也能消除「不挂起」症状。

### 3.4 与 E1r2 的差分（解释为何成功样本看不出来）

E1r2 成功样本满足两个条件：① 委派路径为 **oneshot**（终态 step `params` 无 `session` 键）；② 当时**无并发委派**。A5 为 **persistent**（`params.session="persistent"`，与 `bridge.ts` `runPersistent` 构造的 step 逐字一致）且紧随「已 cancel 但仍跑」的 A4。
**注意**：oneshot/persistent 本身**不是**判据（两条路径都在 `maybeResume` 处汇合，且都调用 `reconcileApprovalWait`）；真正的差分是 **②（无并发）**。这也解释了为什么「A5 走 persistent」这个观察容易被误当成根因 —— 它只是相关量。

---

## 4. 风险判级是否影响挂起：**不影响**（已独立核实），但有两处真实的判级缺陷

### 4.1 结论

**风险判级与「是否挂起」完全无关。** 从 `maybeResume` → `raise` → `waitApproval` 全链**没有任何以 `risk` 为条件的分支**：

- `bridge.ts` `maybeResume`：`const blocked = base.error?.code === 'APPROVAL_REQUIRED' || !!base.error?.details?.approvalId;` —— 只看 error 结构，不看 risk；`risk` 只用于构造 `req`（`const risk = (typeof details['risk'] === 'string' ? details['risk'] : 'L2') as RiskLevel;`）。
- `vm-service/src/server.ts` `raise()`：唯一前置门是 `!this.activeTaskId || !this.tasks`；`req.risk` 只进 `enriched` → 审批卡文案与审计字段。
- `task-store.ts` `waitApproval` / `approvalMessage`：无条件置 `input-required`；`req.risk` 只出现在 `需要人工审批（风险 ${req.risk}）` 文案与 `data.risk`。
- 宿主侧 `maxRisk`（A5 metadata `"maxRisk":"L2"`）只在**内层 MCP 能力调用的策略引擎**里起作用（决定是否返回 `APPROVAL_REQUIRED`），不影响外层挂起。

⇒ QA 记录的「成功样本 risk=L2 挂起、失败样本 risk=L1 不挂起」是**相关而非因果**（真实差分见 §3.4）。

### 4.2 缺陷 1：`execution-steps` 步骤风险硬编码 `L1`（审计/取证缺陷）

`bridge.ts` 两条路径构造 step 时**逐字硬编码**：
- 常驻路径（「K5：记录本轮最终文本」之后的 `return { result: await this.maybeResume(reconcileApprovalWait({…steps:[{ index:0, capabilityId:'appops.workflow.run', …, risk:'L1', … }]})) }`）
- 单次路径（`child.on('close')` 分支内 `finish(await this.maybeResume(reconcileApprovalWait({… risk:'L1' …})))`）

后果：A5 实际被拦的是 **L2** 高危能力，但宿主拿到的 `execution-steps` artifact 里 `steps[0].risk="L1"`，且 `GoalRequest.maxRisk`（`contracts/src/bridge.ts` `GoalRequest` 段 `readonly maxRisk?: RiskLevel;`）**从未下传到 `LlmGoalInput`**（`LlmGoalInput` 无 `maxRisk` 字段，`index.ts` `runGoal` 构造入参时也未透传）⇒ 步骤风险无法反映真实风险。影响：事后审计/宿主侧风险展示、账本统计失真（不是挂起失效）。
修法：给 `LlmGoalInput` 加 `maxRisk`，`index.ts` 透传 `goal.maxRisk`，两处 `risk:'L1'` 改为 `input.maxRisk ?? 'L2'`（与审批卡兜底一致），并把「LLM workflow 步骤的真实风险无法从壳能力 `appops.workflow.run` 推导」登记为已知偏差（根治要等 `underlying` 上抛真实 capabilityId）。

### 4.3 缺陷 2：审批卡 risk 是文本正则 + 兜底 `L2`（**安全相关**）

链路：`bridge.ts` `parseApprovalBlock` 用 `/risk["']?\s*[:=]\s*["']?(L[0-3])/i` 从 **LLM 回显文本**里抠 risk，抠不到就 `'L2'`（`risk: (riskM ? (riskM[1] as RiskLevel) : 'L2') ?? 'L2'`）；该值经 `reconcileApprovalWait` 写入 `error.details.risk`，再由 `maybeResume` 的 `details['risk'] ?? 'L2'` 二次兜底后进入审批卡。
⇒ **真实 L3 操作可能被展示为 L2（甚至被文本里的无关 `risk":"L1` 带偏成 L1）**，人工据此批准。E1r2 卡片显示 L2 正是"没抠到"走兜底的结果，不是真实判级。

**权威来源其实就在手边**：`vm-service/src/server.ts` `PendingApproval`（token）段有 `readonly risk: RiskLevel;` —— 这是策略引擎拦截时留存的**真实风险**；而 `raise()` 已经用 token 补全了 `preview`/`impact`/`underlying`，**唯独没补 `risk`**。
修法（1 行）：`raise()` 的 `enriched` 增加 `risk: token?.risk ?? req.risk`；桥侧兜底 `'L2'` 仅作「无 token」时的降级。同时建议审批卡文案标注「风险来源：服务端判定 / 桥侧推断」，避免人工误判。

---

## 5. 最小修复方案

### 5.1 Fix-1A（止血，3 处，推荐立即合入）：让 `endTask` 可归属

| 文件 | 位置 | 改法 |
| --- | --- | --- |
| `packages/contracts/src/bridge.ts` | `ApprovalCoordinator` 接口 `endTask()`（`:315`） | 改为 `endTask(taskId?: string): void;` —— **可选参数，对既有实现/调用方零破坏** |
| `packages/vm-service/src/server.ts` | `endTask()`（当前 `this.activeTaskId = undefined;`） | `endTask(taskId?: string): void { if (taskId !== undefined && taskId !== this.activeTaskId) return; this.activeTaskId = undefined; }` |
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts` | `runGoal` 的 `finally` | `this.coordinator?.endTask(input.taskId ?? '');` |

效果：A4 收尾时 `endTask('48a90a2f…')` 与当前 `activeTaskId='51229514…'` 不匹配 ⇒ 不清空 ⇒ A5 的 `raise` 正常挂起。
回归风险：**低**。唯一实现方是 `VmApprovalCoordinator`；单测里若直接 `endTask()` 无参则行为不变（`taskId === undefined` → 仍无条件清空）。`beginTask`（`:313`）与 `raise`（`:322`）签名**不动**。

### 5.2 Fix-1B（根治，推荐同 PR）：`raise` 自带 taskId，协调器不再依赖单例状态

| 文件 | 位置 | 改法 |
| --- | --- | --- |
| `packages/contracts/src/bridge.ts` | `ApprovalRequest`（`:173`） | 增加可选 `readonly taskId?: string;`（注释：归属的 A2A 任务 id，由桥从 `LlmGoalInput.taskId` 注入；缺席回退协调器单例，兼容旧调用方） |
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts` | `maybeResume` 构造 `req` 处 | `const req: ApprovalRequest = { approvalId, capabilityId, risk, summary: input.goal, preview: {}, impact: [], ...(input.taskId ? { taskId: input.taskId } : {}) };` |
| `packages/vm-service/src/server.ts` | `raise()` | 首行改为 `const taskId = req.taskId ?? this.activeTaskId;`；守卫改 `if (!taskId || !this.tasks) return { approved:false, reason:'no-active-task' };`；后续 `waitApproval(taskId, enriched)` 与 `this.tasks.tryGet(taskId)` 全部改用 `taskId` |

效果：协调器对并发委派**无状态**，单例仅作旧调用方兜底。`beginTask/endTask` 退化为可保留的兼容接口（建议同时加 `@deprecated` 注释，不在本 PR 删除）。
回归风险：**低**。所有现有调用方（仅 `bridge.ts:737/741/960`）不改也照旧工作；`ApprovalRequest` 加可选字段对 `task-store.ts` `approvalMessage`（只读取既有字段）无影响。

### 5.3 Fix-2（P3-b，同一里程碑必做）：per-delegation 状态搬离单例

`bridge.ts` 的 `taskReceipts` / `raisedApprovals` / `k5ReplayActive` 当前是实例字段并在 `runGoal` 入口无条件清空。最小改法：把三者搬进 `RunContext`（`runGoalInner` 已构造 `ctx` 并向下传递），相应地把 `applyReceipt(approvalId, base)`、`reconcileExecutionTruth(base, finalText)` 增加 `ctx` 参数（`maybeResume` 已收 `ctx`，无需改签名）。
回归风险：**中**（纯内部重构、无契约变更，但触及 K5 反查全部判定面）。建议：**先由 §6 的 R1/R2 单测把当前行为钉死为红档，再做本项**。若本迭代排期紧张，可作为独立 CL，但**不得遗漏**——否则同一个缺陷仍有三条并发支路。

### 5.4 Fix-3（P3-c，独立项）：让 `tasks/cancel` 真正中断 LLM turn

`task-store.ts` 的 `cancelRequested`（`InternalTask` 声明 / `create` 初始化 / `requestCancel` 赋值）全仓只写不读。最小做法：`TaskStore` 暴露 `isCancelRequested(taskId)`，桥在 turn 进度回调（`sink.onStatus` 包装）里轮询并在置位时提前收口（常驻路径还需 `session.abortTurn()` 一类能力，涉及子进程生命周期）。
影响面：**大**（涉及持久会话子进程与 `runGoal` 语义），建议单独立项，不阻塞 Fix-1。

### 5.5 Fix-4（§4，小改，建议随 Fix-1 同 PR）

- `vm-service/src/server.ts` `raise()` 的 `enriched` 增加 `risk: token?.risk ?? req.risk`（token 有权威 risk）。
- `bridge.ts` 两处 `risk:'L1'` 改为 `input.maxRisk ?? 'L2'`；配套给 `LlmGoalInput` 加 `maxRisk?: RiskLevel` 并在 `index.ts` `runGoal` 透传 `goal.maxRisk`。

### 5.6 契约同步变更结论（回答 team-lead 的提问）

- `packages/contracts/src/bridge.ts` **`:315` `endTask()` 需要同步变更**（加可选 `taskId?`）—— 非破坏。
- `:313` `beginTask(taskId)` **不需要改**。
- `:322` `raise(req)` **签名不需要改**；但根治版需要给 `:173` `ApprovalRequest` 加可选 `taskId?`（同样是纯附加、非破坏）。
- 三者**都不需要** breaking change，也不影响 `packages/adapter-agent-hermes`（未实现 `ApprovalCoordinator`）。

### 5.7 验收口径（修完如何算通过）

1. §6 的 R1 红档断言由「waitApproval 未被调用」翻绿为「waitApproval 被以 `task-A5` 调用」；
2. §6 的 R2 交叠用例断言「`calls` 含 `id==='tB'`」；
3. 真机（VM 恢复后）：**静默窗口**单跑 A5 → 必挂起（回归 E1r2 行为）；**A4+A5 交叠**跑 → 也必挂起（本次缺陷的正面回归）；
4. 宿主回复 `approved:false` → 终态 `rejected`（`a2a-framework/src/server.ts` `continueTask` 内 `this.tasks.updateStatus(taskId, 'rejected')` 处）—— D-5 契约首次真机可达。

---

## 6. 确定性复现注入点（不依赖 LLM 措辞、不依赖真机）

> 三个注入点，由纯到端到端。**建议 R1 作为主红档**（零进程、零时序、<10ms）。

### 6.1 R1｜协调器级（最纯，推荐）—— 直接把 §1.2 出口 #4 钉成红档

构造（`node --test` 单测，导入 `VmApprovalCoordinator`；`packages/vm-service` 有 `dist` 时引 dist，否则用 `tsx` 引 `src`）：

```js
const calls = [];
const fakeTasks = {
  // 记录「是否真的挂起过」——这是整个判定的红档断言
  waitApproval: (id, req) => { calls.push({ id, req }); return Promise.resolve(false); },
  tryGet: () => undefined,          // 让 raise 的 !approved 分支取不到 metadata → reason:'rejected'
};
const coord = new VmApprovalCoordinator();
coord.bind(fakeTasks, new Map());   // bind 后 this.tasks 就绪（排除 §1.2 的 !this.tasks）

coord.beginTask('task-A4');   // A4 先到（模拟 48a90a2f…）
coord.beginTask('task-A5');   // A5 后到（模拟 51229514…），覆盖单例
coord.endTask();              // ★ A4 收尾（现状实现无参）→ 清空的是 A5 的 id

const out = await coord.raise({
  approvalId: 'apr_a9aabfcffb5f4246b918',
  capabilityId: 'appops.workflow.run', risk: 'L2',
  summary: '卸载 QA.R19B.Nonexistent.99997', preview: {}, impact: [],
});

// —— 红档（当前代码必须 FAIL 在这两条）——
assert.deepEqual(out, { approved: false, reason: 'no-active-task' });
assert.equal(calls.length, 0);      // ★ 从未调用 waitApproval ⇒ 从未挂 input-required

// —— 修复后（Fix-1A：endTask('task-A4')；或 Fix-1B：req.taskId='task-A5'）——
// assert.equal(calls.length, 1);
// assert.equal(calls[0].id, 'task-A5');
// assert.deepEqual(out, { approved: false, reason: 'rejected' });
```

变体（覆盖 P3-a 的第二个陷阱）：不调 `beginTask` 直接 `raise` ⇒ 同样 `no-active-task`；`beginTask('')` 后 `raise` ⇒ 同样 `no-active-task`（空串 falsy）。

### 6.2 R2｜桥级交叠（零真机、零真 LLM，只用 stub CLI）—— 表征完整 A5 时序

- **stub CLI**：写一个脚本（放 `/storage/Users/currentUser/wbtmp/fake-codebuddy`，`chmod +x`），行为 = `sleep ${FAKE_SLEEP}` 后 `echo` 一行固定文本并 `exit 0`。文本必须含拦截回显，例如：
  `tool result: {"code":"APPROVAL_REQUIRED","approvalId":"apr_deadbeefcafe1234","capabilityId":"app.winget.uninstall","risk":"L2"}`
  （含 `APPROVAL_REQUIRED` 即命中 `APPROVAL_WAIT_PATTERN`，含 `apr_` 即 `extractApprovalId` 成功 ⇒ 复现 A5 全链，且与措辞细节无关。）
- **构造要点**：
  - `new CliLlmBridge({ runtime: <stub 路径>, persistent: false, outputDir: <临时目录>, endpoint: 'http://127.0.0.1:1/mcp' })` —— **`persistent:false` 强制走 `runOneShot`**，两条委派各自 spawn 独立进程，**不共享 `enqueue` 串行链**，时序完全由 `FAKE_SLEEP` 决定 ⇒ **无 flake**。
  - 用**两个独立 bridge 实例 + 同一个 coordinator**（分别 `setApprovalCoordinator(coord)`）⇒ 隔离 P3-b 的 `taskReceipts/raisedApprovals` 互清，本用例**只测 P1**。
  - coordinator 用 6.1 的 `fakeTasks`（记录 `waitApproval`）。
- **决定性时序**（`FAKE_SLEEP` 用环境变量注入）：
  - t=0：`pA = bridgeA.runGoal({ taskId:'tA', goal:'A', traceId:'trA', timeoutMs:30000, … })`，`FAKE_SLEEP=0.2`
  - t=0.05s：`pB = bridgeB.runGoal({ taskId:'tB', goal:'B', traceId:'trB', timeoutMs:30000, … })`，`FAKE_SLEEP=1.0`
  - t≈0.25s：A 收尾 → `endTask()` 清空单例（此刻 `activeTaskId='tB'`）
  - t≈1.1s：B 走到 `raise` → `no-active-task` → `return base`
  - **红档断言**：`calls.filter(c => c.id === 'tB').length === 0`（B 从未挂起）**且** `resB.ok === false` **且** `resB.summary` 含 `等待审批` **且** `resB.error.code === 'APPROVAL_REQUIRED'` —— 与 A5 终态四要素逐字对齐。
  - 修复后翻绿：`calls.some(c => c.id === 'tB' && c.req.approvalId === 'apr_deadbeefcafe1234')`。
- **R2b（顺带固化 §2.4 遗留风险）**：把 stub 文本里的 `APPROVAL_REQUIRED` 与「等待审批」都去掉（只留 `approvalId=apr_…`），单跑一条委派 ⇒ 断言 `res.ok === true`、summary 含「完成目标」、`calls.length === 0` —— 即「拦截了却不挂起、还报成功」的静默假成功。修复方向（K3 根治）落地后该断言翻红→翻绿。

### 6.3 R3｜真机端到端（VM 恢复后，QA 已有脚本）

1. **静默窗口单跑 A5**（复现 E1r2 行为、证伪一切并发假设）：跑前先 `tasks/list` 取快照确认无在飞委派（HEAD `2d49e35` 已把该快照写进证据），再 `qa/r19/a2a-extra.mjs reject --prefix=... --poll-ms=1000`。
2. **A4+A5 交叠跑**（P1 的正面回归）：先发一个长只读目标并在其 turn 未结束时发 A5，断言 A5 **仍**挂起 `input-required`。
3. **补一条证据**（闭合 §3.1 的定量预测）：从 VM 服务日志取 A4（task `48a90a2f…`）那一轮的 `[llm-session]` 轮次耗时，核验是否落在 ≈13.8~18.4s。

### 6.4 仍缺的证据（诚实标注）

| 缺口 | 影响 | 获取该证据的最小实验 |
| --- | --- | --- |
| A4（task `48a90a2f…`）那一轮 LLM turn 的真实耗时/结束时刻 | 只影响「把交叠坐实到 A4」；不影响根因判定（§1.2/§1.3 已独立锁定出口 #4） | 6.3 第 3 条：读 VM 服务日志该轮次 `[llm-session]` 耗时行 |
| A5 的 `raise` 是否曾被调用（无服务端 raise 级日志） | 若将来发现 raise 未被调用，则需复查 §1.2 出口 #1（coordinator） | 在 Fix-1 PR 中给 `raise` 的 `no-active-task` 分支加一条 `logger.warn`（含 taskId/approvalId/当前 activeTaskId）——**这一条建议直接写进实现 spec**，否则同类问题下次仍无日志可查 |
| A5 那一轮 LLM 原始文本 `turn.text` | 只影响确认 `parseApprovalBlock` 抠到的 `capabilityId/risk`；不影响 blocked 判定 | 常驻会话日志/产物目录留存；或在 stub 复现（R2）里直接指定 |
