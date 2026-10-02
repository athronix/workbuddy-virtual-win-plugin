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
