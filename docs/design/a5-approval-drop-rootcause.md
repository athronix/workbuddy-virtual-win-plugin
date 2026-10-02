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
