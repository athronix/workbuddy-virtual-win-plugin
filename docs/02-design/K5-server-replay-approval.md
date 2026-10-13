# K5 设计：审批放行后的服务端确定性重放（根治 A2A 假成功）

> 状态：**已实现并真机验收**（Phase 1 · 2026-09-29 落地：`tests/unit/k5-replay.test.js` 41 例在册、`docs/test/reports/k5-fix-qa-2026-09-29.md`、`docs/test/reports/real-test-2026-09-29-k5-e2e.md`；§7 现状对齐 2026-10-12）。
> 状态行订正注记（2026-10-13 · Phase 3 批0，J-5）：原写"设计定稿，待实现"已停更 13 天，与正文实况不符，今改回。
> 作者：主理人（基于 2026-09-28 真机取证 + 代码勘察）。
> 前置：K3（假成功正则兜底）、K4（结构化审批回传）均真机验证通过。

## 1. 问题（真机实证，2026-09-28 18:52–19:30）

A2A 委派「卸载VM企业微信」完整闭环：宿主批准后任务转 `completed`、LLM 文本声称完成，但——
- 审计链 11:05–11:18Z 窗口**零条能力执行记录**；
- `WXWork.exe` 完好无损。

**根因**：K4 续跑机制 = 批准后 bridge 用 `resumeSuffix` **提示 codebuddy LLM「带 __approvalId 再调一次工具」**。LLM 在续跑 turn 里没有真的重发调用，直接文本自宣完成。正则启发式（reconcileApprovalWait）抓不到「自称完成」。

次生现象（同根）：
- 续跑 turn LLM 回显旧 apr_ token → 同一 approvalId 二次 raise（第二轮审批复用了同一 token）；
- 被拦调用不入审计（blocked 无记录，取证盲区）；
- approval-request 的 `preview:{}` / `impact:[]` 空 → 宿主审批卡片信息量不足；
- **用户两次质疑"没弹审批卡片"**：本次验证走的是测试脚本直连 A2A 端点，绕过了宿主 MCP 工具路径；正常宿主路径（`winvm__a2a.delegate` 工具 → tools.ts:331 extractApproval → L164 buildA2aResumeHint → 宿主 Agent 展示审批卡片）本应渲染。K5 验收必须走宿主 MCP 路径端到端演示卡片。

## 2. 方案：执行权收归服务端（确定性重放）

**核心不变式**：能力是否真实执行，以**服务端结构化回执**为准，LLM 文本永远不是完成证据。

```
宿主 approval.reply(true)
  → resolveApproval → done=true
  → VmApprovalCoordinator：从 pendingApprovals 取留存的原参数
  → 调注入的 replay(capabilityId, params, {approvalId, traceId+'-replay', principal.channel='a2a-replay'})
     （= 服务端直接走 handler 执行段：policy approved=true → provider.execute → 审计 → 结构化结果）
  → 删除 token（一次性）
  → raise() resolve { approved:true, executed:{ ok, summary, error? } }
  → bridge 消费 outcome：
      approved:false（拒绝/超时/无任务）→ 保持 K3 行为（ok=false，等待审批）
      approved:true + executed → 把**真实执行结果**注入续跑 turn（提示词改为
        「系统已按宿主批准执行 <capabilityId>，结果：<summary>。请如实向用户汇报并继续未完成步骤；
         严禁重复调用该能力；严禁声称未经执行的操作」）
      LLM 声称目标完成 → reconcileApprovalWait 升级版做**回执反查**：
        任务存在审批记录但无 ok=true 回执 → 改判 failed（执行回执缺失，不予采信）
```

被拦时（第一次 raise）：审计补记 `blocked:approval-required`（capabilityId/params/approvalId）；重放执行天然再出一条 executed 审计 → 取证盲区闭合。

## 3. 改动清单（4 包）

### 3.1 contracts（`packages/contracts/src/bridge.ts`）
- `ApprovalRequest` 增可选 `underlying?: { capabilityId: CapabilityId; paramsSummary?: string; goalText?: string }`——供宿主卡片展示真实目标（workflow.run 被拦时内层意图=goal）。
- `ApprovalCoordinator.raise` 返回 `Promise<ApprovalOutcome>`：
  ```ts
  export type ApprovalOutcome =
    | { approved: false; reason: 'rejected' | 'timeout' | 'no-active-task' }
    | { approved: true; executed: ExecutedResult };
  export interface ExecutedResult { ok: boolean; capabilityId: string; summary: string; error?: string }
  ```
  消费者仅 bridge（1 处调用 L759）+ 实现仅 VmApprovalCoordinator（1 处）→ 契约变更安全，K4 测试同步改。

### 3.2 vm-service（`packages/vm-service/src/server.ts`）
- 把 handler 闭包 L395-450 的执行段（provider.execute + 结果映射 + 审计）**抽成命名函数** `executeCapability(cap, params, ctx): Promise<ToolResultLike>`，原 handler 调用它。
- `createService` 内构造 `replay = async (p: PendingApproval) => executeCapability(capOf(p.capabilityId), p.params, { traceId: p.traceId + '-replay', approvalId: p.approvalId, synthetic: 'a2a-replay' })`，注入 `VmApprovalCoordinator.setReplay(replay)`。
- `VmApprovalCoordinator.raise` 改为：
  ```ts
  async raise(req) {
    if (!this.activeTaskId || !this.tasks) return { approved:false, reason:'no-active-task' };
    const approved = await this.tasks.waitApproval(this.activeTaskId, req);
    if (!approved) return { approved:false, reason:'rejected' }; // 拒绝或 TTL 超时
    const p = this.pendingApprovals?.get(req.approvalId);
    if (!p) return { approved:false, reason:'rejected' }; // token 已消失（异常）
    p.hostApproved = true;               // 置位后立即被下方一次性删除吞并——直调续跑实际不可达（订正见 §4-2 与文档头注；批1 在建）
    try {
      const exec = await this.replay(p);
      this.pendingApprovals?.delete(req.approvalId); // 一次性消费
      return { approved:true, executed: toExecutedResult(exec) };
    } catch (e) { this.pendingApprovals?.delete(req.approvalId); return { approved:true, executed:{ ok:false, capabilityId:p.capabilityId, summary:'replay threw', error:String(e) } }; }
  }
  ```
- 拦截路径（L354-382）加审计 `blocked:approval-required` 记录（channel='a2a', ok:false, matchedRule='approval-required'）+ pendingApprovals 里留存 `traceId`。
- approvalMessage data part 补 `underlying`（workflow 场景带 goal 文本、真实参数摘要）→ 宿主卡片可读。

### 3.3 adapter-agent-workbuddy-llm（`packages/adapter-agent-workbuddy-llm/src/bridge.ts`）
- `maybeResume`：消费 `ApprovalOutcome`；维护 `taskReceipts: Map<approvalId, ExecutedResult>`（beginTask/endTask 清）。
  - `!approved` → return base（现状不变）。
  - `approved + executed` → 续跑 prompt 从 `resumeSuffix`（"请重发"）改为 `executionSuffix`：「系统已按宿主批准真实执行 <capabilityId>，结果：<summary/error>。你的任务是如实转告用户并处理剩余步骤；严禁再次调用该能力；对未经执行的操作严禁声称完成」。
  - 同一 approvalId 已 raise 过 → 不再二次挂起，直接用已登记回执（修旧 token 复用）。
- `reconcileApprovalWait` 升级为 `reconcileExecutionTruth`：若本任务存在审批记录（raisedAt 集非空），最终文本含完成声称（目标关键词/「已完成/已卸载/已删除」）但回执集无 `ok:true` → 改判 failed，error=「执行回执缺失：审批后服务端未产生成功执行记录，完成声明不予采信」。**回执存在且 ok:true → 采信（放行 completed）**。
- 无 coordinator / 无审批任务路径零改动（纯 K3 语义保留）。

### 3.4 宿主侧（`packages/host-a2a-bridge/src/tools.ts`，小改）
- `extractApproval` 透传 `underlying` → `buildA2aResumeHint` 文案带真实目标摘要（卡片信息量）。宿主 Agent 依 SKILL.md 纪律展示审批卡片（CL-016 既有路径，无需新代码）。

## 4. 安全纪律（不可妥协）
1. 重放**仅在** `resolveApproval(true)` 后由协调器触发，参数取服务端留存原值——VM 内任何角色无法伪造执行。
2. token 一次性：执行成功/失败均删除；`/mcp` 直调路径的 `hostApproved===true` 严格闸保留（K4 不动）。
   **口径统一订正（2026-10-13 批0）**：本条与"批准即删 token"并读时曾自相矛盾（删 token ⇒ 严格闸无对象可校验）。终版口径 = **缺省灰度（replay on）下批准即删 token，MCP 直调 `__approvalId` 续跑路径实际不可达**；"严格闸保留"仅指闸语义未被放宽（绝不因重放机制而自批），不承诺续跑可达。直调续跑可达性 = **Phase 3 批1 审批闭环在建**（出路 (c) 策略化）。`WINVM_APPROVAL_REPLAY=off` 灰度回退态下 token 保留、K4 直调续跑仍可用——这是回滚位而非主路径。
3. 桥对 LLM 完成声明做回执反查——**服务端没记到执行成功，A2A 永远不许谎报成功**。
4. 拒绝/TTL 超时/异常一律 `approved:false` → K3 旧行为（等待审批，绝不自批）。

## 5. 验收
- 单测：replay 注入后 raise→executed 结构化结果；token 一次性消费；拒绝/超时 reason 正确；回执反查（声称完成+无回执→failed；有 ok 回执→completed）；同 approvalId 去重二次 raise；blocked 审计落条目。k4-approval 既有 6 例适配新契约。
- 回归：636 全量逐文件 0 fail（原基线 610，K5 净增 26：k5-replay 41 新建 + k4-p3 +1 − 适配改写）；tsc 0 error。
- **真机闭环（走宿主 MCP 路径，演示审批卡片）**：① `winvm__a2a.delegate` 委派"卸载VM企业微信"→ 宿主工具返回 input-required → **向用户渲染审批卡片（含真实目标摘要）**；② 用户批准 → `approval.reply` → 服务端重放**真实执行 winget 卸载** → 审计出现 executed 记录 + WXWork.exe 磁盘消失；③ 任务 completed 且 LLM 汇总与回执一致。
- 回滚保险：`WINVM_APPROVAL_REPLAY=off` 时协调器跳过重放直接 resolve（退回 K4 提示词行为，灰度开关）。

## 6. 不做什么
- 不改 A2A 协议线格式、不动 waitApproval TTL（P3 已做）。
- ~~不碰 MCP 直调通道行为~~ → **P2-T8 口径更新（2026-10-12，见 §7）**：真值层（CL-K3R `reconcileApprovalTruth`）的**判定覆盖面**已扩展到 MCP 直调 / 委派 CLI 回连形态（无 `taskId` 有 `traceId` 的回合）。此处"不碰"当时指的是 K5 重放机制自身不改 MCP 直调通道行为——该部分依然成立（重放闸、`hostApproved` 严格闸、协议线格式一字未动）；变的是**审批真值反查不再只服务有 `taskId` 的 A2A 委派回合**。划线留痕，不改写历史结论。
- 不引入桥对 /mcp 的直连 client（执行权在服务进程内，无需跨 HTTP 自调）。

## 7. P2-T8 现状对齐：真值层覆盖面 + 兜底归因可观测（2026-10-12）

CL-K3R 真值层（§2 末段「回执反查」的结构化实现，落点
`packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts` 的 `reconcileApprovalTruth`）
本批三项增量，均为**纯附加**，判定方向仍是单向 fail-closed（只 `ok:true → ok:false`）：

- **G-a（覆盖面扩展）**：门 1 归属键由「必须有 `taskId`」放宽为 **`taskId ?? traceId`**
  （两者均须非空串）。此前「无 `taskId`、有 `traceId`」的回合——纯 MCP 直调、委派 CLI 回连——
  一律在门 1 退场回文本兜底，而服务端 `collectApprovalFacts` / `LedgerRegistry.blockedFor`
  早已能按 traceId 归因（R1 精确 / **R2 他人精确排除** / R3 时间窗 + 能力面过滤）：缺的不是
  新数据源，是新调用点。串台安全由 R2 精确排除 + R3 窗口收窄兜住（钉在
  `tests/unit/phase2-truth-mcp-direct.test.js` A4/A5）。SK-1「无归属不介入」逐字保留：
  归属键**双缺**仍回退兜底，且探针零调用（取证发生在门之后）。灰度三态
  `approvalTruth=on|shadow|off`（env `WINVM_APPROVAL_TRUTH`，缺省 `on`）对新形态同样成立，
  G-a 只扩归属面、不扩判定面（同件 C 组）。`/mcp` 桥接层与 dtid 钉（`bridge.ts` 的
  `?dtid=` 注入）一字未动。
- **G-b（兜底归因可观测）**：新增 `deps.onTruthDecision` **出参回调**（刻意不是返回值字段——
  门 0 的引用相等钉、门 3 的「绝不 warn」钉、SK-9 文案钉都不允许被触碰），每次判定
  **恰好一次**透出 `{ decidedBy, gate, taskIdPresent, traceIdPresent, approvalId? }`：
  `decidedBy ∈ 'server' | 'text-fallback' | 'shadow' | 'pass-through'`。链路
  `RunContext.approvalTruth → LlmGoalResult → GoalResult → delegation.complete` 的
  `ext.approvalTruth`（服务端 observer 只搬运事实、不做二次判定）。回调缺席 ⇒ 零行为变化；
  归因缺席 ⇒ 链上条目逐字节旧形状（同件 E2「零 undefined 键」钉）。可计数价值在于：
  运维能区分「结构化救回来的」与「兜底救回来的」，兜底命中率从此可监控、可退役论证。
- **G-c（兜底边界补强，诚实红线）**：文本启发式 `reconcileApprovalWait` **函数体一字未动**
  （SK-9）。新增反例集钉住「同义改写确实漏判」——六条新构造措辞（人工核验流程 / 门禁拦下 /
  pending authorization / 管理员点头等）逐条断言**仍然漏**，作为已知边界登记，而不是把它
  当缺陷"修好"；关键词集合钉 `[APPROVAL_REQUIRED, 等待审批]`（新增关键词必须同批改测试）。
  漏判风险由 G-a 扩展后的结构化反查承担——这正是真值层推到 MCP 直调的意义（同件 D 组）。

验收：`node --test tests/unit/phase2-truth-mcp-direct.test.js` 全绿（A~F 组）；既有
24 例 `phase2-approval-wait-fallback`、11 例 `r19c-k3r-approval-truth` 等 26 件守卫清单
逐文件复跑零回归；`tsc -b` 0 error。
