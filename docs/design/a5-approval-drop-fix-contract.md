# A5 审批丢弃缺陷 —— 契约增补与实施任务分解

STATUS: DRAFT（§0–§1 已落盘）

> 本文档是**修复设计**（contract delta + 任务分解），不是根因判定。
> **权威根因文档 = `docs/design/a5-approval-drop-rootcause.md`（STATUS: FINAL，commit `eb72788`，376 行）** —— 本文引用它、不改写它。
> 本文未修改 `packages/**` 任何文件、未跑 `delivery/*.mjs`、未连 VM（VM 整机不可达，真机实验 BLOCKED）。
> 证据引用 `文件:行`，**行号会漂移**，一律同时给出附近的唯一锚点符号。

---

## 0. 前置：口径、纪律与行号校正

### 0.1 本文遵守的硬约束（逐条可核）

| 编号 | 约束 | 本文的处理 |
| --- | --- | --- |
| **D-1** | 两道门 `replayEnabled \|\| k5ReplayActive` / `raisedApprovals.size === 0` 是受保护契约，禁止移除或弱化；`tests/unit/k5-replay.test.js` 41 例须全绿 | Fix-2 只换三态的**取值来源**（实例字段 → `RunContext` 字段），**门的语义、顺序、短路条件一字不改**（§2.3 / T03） |
| **D-4** | `a2a-framework` 零审计写入侧符号、禁依赖 adapter | 本次改动**不碰** `a2a-framework/src/**`（唯一相邻面是 `task-store.ts` 的 `ApprovalRequest` 只读消费，且本轮不改它） |
| **D-5** | A2A 终态统一 `failed`；`rejected` 仅宿主显式拒绝审批，唯一置位点 `a2a-framework/src/server.ts:306` | 本轮**不改任何终态置位逻辑**；修复目标是让 `:306` 那条路径**可达**（任务先挂起 `input-required`，宿主才有对象可回复） |
| 裁决层级 | 仓库文档 > 任务板描述 > 聊天 | 所有与任务书行号/归属不一致处，均在 §0.3 显式列出并给出实测行号 |

### 0.2 必须落档的两条拍板（team-lead）

1. **`raise` 的 `no-active-task` 分支必须加 `logger.warn`**（输出 taskId / approvalId / 当前 activeTaskId）。→ 落到 C-6（新增 `setLogger`）+ T02，格式见 §4 SK-3。
2. **Fix-2 必须与 Fix-1 同批完成**，不得只修 `activeTaskId` 就宣布结案。→ 本文裁定：**同批、同一迭代、拆成 T02/T03 两个可独立验证的 CL**（§2.3 给出若排期真的不够时的降级缓解方案 Fix-2′，由 team-lead 拍板）。

### 0.3 行号校正（与任务书不一致处，实测为准）

| 任务书写法 | 实测（HEAD `eb72788`） | 说明 |
| --- | --- | --- |
| D-1 两道门在 `packages/a2a-framework/src/server.ts:1008` / `:1009` | 该文件**只有 652 行**，无 `:1008`/`:1009` | 两道门的真实落点是 **`packages/adapter-agent-workbuddy-llm/src/bridge.ts:1008`**（`if (!this.replayEnabled \|\| !this.k5ReplayActive) return base;`）与 **`:1009`**（`if (this.raisedApprovals.size === 0) return base;`），位于 `reconcileExecutionTruth` 内。K4 安全网在 `a2a-framework/src/server.ts:352`，`failed` 收口在 `:365`，`rejected` 唯一置位在 `:306` |
| `vm-service/src/server.ts` 单例字段 `:144` / `endTask` `:173` | 字段 `private activeTaskId: string \| undefined;` = **`:133`**；`endTask(): void {` = **`:171`**；根因守卫 = **`:177`** | 与根因文档附录 A 一致 |
| `contracts/src/bridge.ts` `beginTask`/`endTask` = `:313`/`:322` | `beginTask` = **`:313`**、**`endTask` = `:315`**、`raise` = **`:322`** | 需同步变更的是 `:315` |
| `ApprovalRequest` 加 `taskId?` 位置「`:173` 附近」 | `:173` 是 `export interface ApprovalRequest {` 的**接口起始行** | 字段插入点裁定为 **`:186` 之后**（即 `underlying?: ApprovalUnderlying;` 之后、`}` 之前），见 C-2 |

### 0.4 一句话根因（引自根因文档 §1.1，便于本文自洽）

`packages/vm-service/src/server.ts:177` 的 `if (!this.activeTaskId || !this.tasks) return { approved: false, reason: 'no-active-task' };`
在 A5 上命中 `!this.activeTaskId`（服务级单例被上一次委派 A4 的 `finally → endTask()` 清空）⇒ **从不调用同函数 `:191` 的 `this.tasks.waitApproval(...)`** ⇒ 任务从不进入 `input-required` ⇒ `bridge.ts:961` 的 `if (!outcome.approved) return base;` ⇒ `a2a-framework/src/server.ts:365` 按 `result.ok=false` 收口 `failed`。

---

## 1. 契约增补（逐字段 Before / After）

> 通用判定：**全部为「纯附加可选」类增补，无一项是破坏性变更（breaking change）**。
> 本章每项给出：① Before 原文 ② After 原文 ③ 破坏性判定 ④ 向后兼容论证 ⑤ 全仓实现/调用点清单（`git grep` 全仓核实，含 dist 与 packages 外的说明）。

### C-1 `ApprovalCoordinator.endTask` —— 加可选归属参数 `taskId?`（**必改**）

**落点**：`packages/contracts/src/bridge.ts:315`（锚点：接口 `ApprovalCoordinator`，`beginTask` 在其上一行）

**Before（原文）**
```ts
  /** 离开一个委派任务（清空当前 taskId） */
  endTask(): void;
```

**After**
```ts
  /**
   * 离开一个委派任务（清空当前 taskId）。
   *
   * P1-Fix（**纯附加可选**）：`taskId` 非空时按**归属**释放 —— 仅当它等于协调器当前记录的
   * 活动任务 id 才清空；不相等 ⇒ 本次收尾**不属于**当前活动任务（并发委派交叠），
   * 保持不动，绝不误清他人（根因见 a5-approval-drop-rootcause.md §3.1）。
   *
   * `taskId` 缺席（`undefined`）或空串 `''` ⇒ **旧行为逐字不变**：无条件清空
   * （调用方没有归属信息，协调器无从判断，只能按 K4 原语义释放）。
   */
  endTask(taskId?: string): void;
```

**破坏性判定**：**非破坏**（源码级兼容）。

**向后兼容论证**
1. **对既有调用方**：TS 可选参数 ⇒ 现有 `endTask()` 零参调用**仍合法**，且运行时 `taskId === undefined` ⇒ 走「无条件清空」分支 ⇒ **行为逐字不变**（这一条是保住既有测试的关键）。
2. **对既有实现方**：TS 结构化类型中「参数更少的函数」可赋值给「参数更多的函数签名」⇒ `endTask(): void` 的实现**不改也能通过 `implements ApprovalCoordinator`**。唯一实现 `VmApprovalCoordinator`（`vm-service/src/server.ts:171`）本轮要改，但**不改也能编译**。
3. **对测试桩**：`tests/**` 为 `.js`，无类型约束；`endTask() {}`（0 参字面量）在 JS 中可被任意参数调用 ⇒ 零影响。
4. **唯一不兼容点（必须显式登记）**：`Function.prototype.length` 由 `0` 变 `1` ⇒ `tests/unit/r19c-a5-approval-coordinator.test.js:446` 的 C5 断言 `assert.equal(newCoordinator().endTask.length, 0)` **会翻红**。
   - 该用例标题即 `C5 @todo-P1-fix 预留：按 taskId 归属形态的断言（修复后启用）`，注释自述「归属改造后此断言应失效并改为归属断言」⇒ 这是**设计上预期失效的占位断言**，不是回归。
   - 处置：由 QA 在**同一 PR**内改写（§5-Q1 给出建议新断言原文）。**顺序：先改测试，后改代码**（否则红/绿判读会被污染）。
   - 备选（若 QA 无法同步改）：改用 `endTask(...args: [] | [string]): void` 保住 `length === 0` —— **不推荐**（可读性差、类型推断退化、与本仓既有风格不符），仅作兜底登记。

**全仓调用点清单（`git grep -n "endTask" -- .`，HEAD `eb72788`）**

| 类别 | 位置 | 本轮动作 |
| --- | --- | --- |
| 契约声明 | `packages/contracts/src/bridge.ts:315` | **改**（C-1） |
| 唯一实现 | `packages/vm-service/src/server.ts:171`（`VmApprovalCoordinator`，根因守卫在 `:177`） | **改**（T02） |
| 唯一源码消费点 | `packages/adapter-agent-workbuddy-llm/src/bridge.ts:741`（`runGoal` 的 `finally`） | **改**（T02，传 `input.taskId ?? ''`） |
| 测试 · 真实协调器调用 | `tests/unit/k4-approval.test.js:89,129`；`tests/unit/k4-p3.test.js:197,227`；`tests/unit/k5-replay.test.js:172,187,201,216,228,233,253,268` | **不改**（零参 ⇒ 行为不变） |
| 测试 · 桩实现 | `tests/unit/k4-approval.test.js:187`（`endTask() {}`）；`tests/unit/k5-replay.test.js:711`（`endTask() {}`） | **不改**（0 参合法） |
| 测试 · 形态断言 | `tests/unit/r19c-a5-approval-coordinator.test.js:446`（`endTask.length === 0`） | **由 QA 改写**（§5-Q1） |
| `dist` | `**/dist/` 被 `.gitignore` 排除 ⇒ `git grep` 看不到，但**磁盘上存在**（`packages/vm-service/dist/server.js` 等） | 单测 `import { VmApprovalCoordinator } from '@winvm/vm-service'` 解析到 **dist** ⇒ **改完 src 必须 `tsc -b` 重建 dist 才测得出来**（§4 SK-5） |
| packages 外 | `git grep endTask` 在 `packages/` 之外**零命中**（仅 `docs/**`、`.workbuddy/memory/**` 有文字提及） | 无外部消费者 |

---

### C-2 `ApprovalRequest` —— 加可选 `taskId?`（**必改**，Fix-1B 的载体）

**落点**：`packages/contracts/src/bridge.ts:186` 之后（锚点：`readonly underlying?: ApprovalUnderlying;` 字段之后、`export interface ApprovalRequest {` 的闭合 `}` 之前）

> 位置裁定理由：本文件既有「纯附加可选」字段**一律追加在接口末尾**（`underlying?` `:185`、`channel?` `:230`、`delegationId?` `:235`、`degraded?` `:288`）。追加在末尾 = 最小 diff、不打断既有文档注释块。

**Before（接口现状，`:173`–`:186`）**
```ts
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly capabilityId: CapabilityId;
  readonly risk: RiskLevel;
  readonly summary: string;
  /** dry-run 预览：将影响什么 */
  readonly preview: Record<string, unknown>;
  readonly impact: readonly string[];
  /**
   * K5（纯附加）：被拦截调用的真实意图（外层能力是壳时尤其重要）。
   * 缺席即旧行为（卡片只显示 capabilityId/summary）。
   */
  readonly underlying?: ApprovalUnderlying;
}
```

**After（仅追加一段）**
```ts
  /**
   * P1-Fix（**纯附加可选**）：本次审批**归属**的 A2A 委派任务 id。
   *
   * 由桥从 `LlmGoalInput.taskId` 注入（见 adapter `bridge.ts` `maybeResume` 构造 `req` 处）。
   * 缺席 ⇒ 协调器回退到 `beginTask` 记录的服务级单例（**旧行为逐字不变**）。
   *
   * 存在时协调器**优先用它**挂 `input-required`，不再依赖共享单例 `activeTaskId`
   * —— 这是根治 P1 的关键：并发委派不再互相清场（根因 §3.1 / §5.2）。
   */
  readonly taskId?: string;
```

**破坏性判定**：**非破坏**（可选字段追加）。

**向后兼容论证**
1. 所有既有**构造点**不写该字段 ⇒ 仍合法（`makeReq` 等 fixture 零改动）。
2. 所有既有**消费点**只读既有字段 ⇒ 不受影响。特别地：`packages/a2a-framework/src/task-store.ts:264 approvalMessage` 的 data part 是**逐字段显式构造**（`:298`–`:310`，**无 `...req` 展开**）⇒ 新字段**不会**漏进宿主 `approval-request` data part ⇒ `packages/host-a2a-bridge/src/tools.ts:118 extractApproval` 与 `tests/unit/host-a2a-bridge.test.js` 的深比对**零影响**。
3. `PendingApprovalState.request`（`task-store.ts:41`）持有 `ApprovalRequest` 引用 ⇒ 只读，无影响。

**全仓调用点清单（`git grep -n "ApprovalRequest" -- packages tests`）**

| 类别 | 位置 | 本轮动作 |
| --- | --- | --- |
| 契约声明 | `packages/contracts/src/bridge.ts:173`（接口）/ `:295`（`ProgressSink.onApprovalRequired` 参数）/ `:322`（`raise` 参数） | 接口**改**；`:295`/`:322` **不改** |
| 唯一构造点 | `packages/adapter-agent-workbuddy-llm/src/bridge.ts:950`（`maybeResume` 内 `const req: ApprovalRequest`） | **改**（T02，补 `taskId`） |
| 消费 · 协调器 | `packages/vm-service/src/server.ts:175`（`async raise(req: ApprovalRequest)`）、`:182`（`const enriched: ApprovalRequest`） | **改**（T02，取 `req.taskId`） |
| 消费 · 框架（只读） | `packages/a2a-framework/src/task-store.ts:41` / `:211` / `:264` / `:322` | **不改** |
| 测试 · fixture | `tests/unit/r19c-a5-approval-coordinator.test.js:70`（`makeReq`）；`tests/unit/k4-approval.test.js`、`k5-replay.test.js` 内 req fixture | **不改**（可选字段） |

---

### C-3 `ApprovalCoordinator.beginTask` —— **裁定：不改**

**落点**：`packages/contracts/src/bridge.ts:313`

**Before = After**
```ts
  /** 进入一个委派任务（记录当前 taskId，供 raise 挂接） */
  beginTask(taskId: string): void;
```

**裁定理由**
1. `beginTask` 语义是「进入」——**无条件覆写是正确语义**（后进入者即为当前活动者），不存在归属歧义，无需 taskId 之外的信息。
2. 根因的归属缺口在**释放侧**（`endTask` 不知道清谁）与**使用侧**（`raise` 不知道挂谁），已分别由 C-1、C-2 补齐；再动 `beginTask` 属无收益改动。
3. 若把签名放宽为 `taskId?: string | undefined`，反而会**鼓励**更多空串/空值写入（现有 `bridge.ts:737` 的 `beginTask(input.taskId ?? '')` 已是一个空串源），与 §4 SK-1「空 taskId = 无归属」的收敛方向相悖。

**唯一调用点**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts:737`（`runGoal` 内）。**本轮不改**。

---

### C-4 `ApprovalCoordinator.raise` —— **裁定：签名不改**

**落点**：`packages/contracts/src/bridge.ts:322`

**Before = After**
```ts
  raise(req: ApprovalRequest): Promise<ApprovalOutcome>;
```

**裁定理由**：归属信息经 `req.taskId`（C-2）传入即可，无需第二个参数。保持单参数 ⇒ `Function.prototype.length` 不变 ⇒ `tests/unit/k5-replay.test.js:711` 的桩 `raise()`（0 参）与所有 fixture 零影响；`ApprovalOutcome`（`:211`）判别联合**一字不动**（`no-active-task` 仍是其合法 reason，见 §4 SK-7）。

**唯一实现**：`packages/vm-service/src/server.ts:175`。**唯一调用点**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts:960`。

---

### C-5 `LlmGoalInput.maxRisk?` —— adapter 内部类型增补（**非 contracts 层**）

**落点**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts:47`（`export interface LlmGoalInput`），追加在 `readonly warn?: ...`（`:75`）之后

> **注意**：`LlmGoalInput` **不属于** `packages/contracts`，它是 adapter 的自有类型（`bridge.ts:47`）。故本项**不是契约变更**，只是「把契约里已存在的 `GoalRequest.maxRisk`（`contracts/src/bridge.ts:256`）下传到桥内部」。

**Before（`:63`–`:75` 尾部）**
```ts
  /** K4：A2A 委派任务 id（由 provider 从 GoalRequest.taskId 透传，供审批协调器挂接 input-required） */
  readonly taskId?: string;
```

**After（追加）**
```ts
  /**
   * P1-Fix（**纯附加可选**）：本次委派允许的最高风险（由 provider 从 `GoalRequest.maxRisk`
   * 透传）。用于 `execution-steps` 步骤 `risk` 的如实化 —— 现状两处步骤硬编码 `risk:'L1'`，
   * 导致被拦的 L2/L3 高危在宿主侧展示成 L1（审计/取证缺陷，根因 §4.2）。
   * 缺席 ⇒ 回退 `'L2'`（与审批卡既有的桥侧兜底口径一致）。
   */
  readonly maxRisk?: RiskLevel;
```

**破坏性判定**：**非破坏**（可选字段；`RiskLevel` 已在本文件导入 —— `:942` 处有 `as RiskLevel` 用法，可核）。

**配套（同一 CL，见 T04）**
- `packages/adapter-agent-workbuddy-llm/src/index.ts:337`–`:352`（`this.bridge.runGoal({...})` 入参构造，锚点 `// K4：把 A2A 任务 id 透传给桥接层…`）→ 增加 `...(goal.maxRisk ? { maxRisk: goal.maxRisk } : {}),`。
- `packages/adapter-agent-workbuddy-llm/src/bridge.ts:1176`（常驻路径，锚点 `capabilityId: 'appops.workflow.run'` + `session: 'persistent'`）、`:1360`（单次路径，锚点 `params: { goal: input.goal, runtime: this.cliPath }`）→ `risk: 'L1'` 改为 `risk: input.maxRisk ?? 'L2'`。

---

### C-6 `VmApprovalCoordinator.setLogger` —— 实现侧新增（**不进契约接口**）

**落点**：`packages/vm-service/src/server.ts:132`（`export class VmApprovalCoordinator implements ApprovalCoordinator`，锚点：`noteTimeout` 方法之后、`beginTask` 之前）

**Before**：类内无任何日志出口，`raise` 的 `:177` 早退分支**零日志**（根因文档 §6.4「仍缺的证据」明确点名这是本次只能靠反证定位的原因）。

**After（新增字段 + 方法）**
```ts
  /**
   * P1-Fix：告警出口（可选）。由 `createService` 注入服务 logger；未注入时降级为 no-op，
   * 保证单测/纯逻辑场景零副作用。
   */
  private logger: ApprovalWarnSink | undefined;

  /** P1-Fix：注入告警出口（`createService` 内 `new VmApprovalCoordinator()` 之后调用一次）。 */
  setLogger(logger: ApprovalWarnSink): void {
    this.logger = logger;
  }
```
并在 `ReplayFn`（`:241`）附近补一个最小结构类型：
```ts
/** P1-Fix：协调器告警出口的最小形状（只依赖 warn，便于单测注入 spy）。 */
export interface ApprovalWarnSink {
  warn(msg: string, meta?: Record<string, unknown>): void;
}
```

**为什么不进 `ApprovalCoordinator` 契约**
- 该接口的既有扩展方法（`bind` / `setReplay` / `setReplayEnabled` / `noteTimeout`，`vm-service/src/server.ts:147`–`:165`）**本来就不在接口里** —— 它们是 vm-service 侧的注入式扩展。保持一致。
- 往接口加成员对**外部实现方**是破坏性变更（虽然当前只有 1 个实现 + 2 个测试桩，但代价为零收益）。

**注入点**：`packages/vm-service/src/server.ts:341`（`const approvalCoordinator = new VmApprovalCoordinator();`，锚点注释「K4：审批协调器（须先于 bridgeCtx 创建…）」）之后立即加一行 `approvalCoordinator.setLogger(logger);`。
可行性：`logger` 在 `:286`（`const logger: FileLogger = createFileLogger(...)`）已创建 ⇒ 顺序成立，无需前移。

**warn 调用点**：`packages/vm-service/src/server.ts:177` 的 `no-active-task` 分支内（格式见 §4 SK-3）。

---

### C-7 未采纳的候选改动（明确登记，避免后续重复讨论）

| 候选 | 裁定 | 理由 |
| --- | --- | --- |
| 把 `activeTaskId` 改成 `Map<taskId, ...>` 多任务表 | **不做** | C-1+C-2 已使协调器对并发**无状态**；引入 Map 要解决生命周期与清理（谁来删、何时删），复杂度远超收益，且会让 `endTask()` 零参兼容分支语义含混 |
| 给 `ApprovalOutcome` 增 reason（如 `'no-active-task-with-id'`） | **不做** | 会牵动 `ApprovalOutcome` 判别联合 + `bridge.ts:961` + 全部 fixture；`logger.warn` 已提供可观测性，`reason` 语义保持不变（§4 SK-7） |
| 把 `raise` 改成必传 taskId（移除单例兜底） | **不做** | 破坏性；且会让 `k5-replay.test.js` 的桩构造全部失效。单例兜底保留为兼容路径，只是**优先级降低** |

---

<!-- §2 起待续 -->
