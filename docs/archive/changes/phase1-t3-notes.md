# Phase 1 · T3 实施笔记 — a2a-framework 真取消 + TaskStore 有界化（ARCH-22 框架侧 + ENG-08）

> 工程师：寇豆码（software-engineer-2）｜ 基线 HEAD：`fa2e13e`（T1 `4983a58`、T2 `6e9b951` 已提交）
> 权威设计：`docs/changes/phase1-arch-design.md` §7.3-T3 / §1.1-2·3 / §1.6-2 ENG-08 / §8 横切 + O-1/O-2/O-11 / §7.4-T3
> 本文档为**增量落盘**：每完成一个文件 / 一条判据立即 append，不攒最后。

## §0 开工计划

### 0.1 文件清单（仅 3 源文件 + 1 新测试文件）

| # | 路径 | 动作 | 要点 |
|---|------|------|------|
| A | `packages/a2a-framework/src/task-store.ts` | 改 | `cancelController` / O-1 顺序 / `isCancelled`·`cancellationSignal` / `addArtifact` 终态守卫 / `terminalAtMs` / `maxTasks`·`terminalTtlMs` + `evictIfNeeded`（O-11 仅 create 尾部）/ sink 补成员 |
| B | `packages/a2a-framework/src/server.ts` | 改 | `DelegationTerminalSnapshot.state` +'canceled' / `runGoalWithLifecycle` 取消收口（O-2 不落 artifacts 不 updateStatus）/ catch 分支取消不改判 failed / sink 透传 / `cancelTask` 不动 |
| C | `packages/a2a-framework/src/index.ts` | 核对 | 新公开成员按需再导出 |
| T | `tests/unit/phase1-t3-cancel-bounded.test.js` | 新建 | 五判据可证伪断言 + O-1 时序反例探针 |
| N | `docs/changes/phase1-t3-notes.md` | 本文件 | 增量落盘 |

禁碰：其他任何源码；`core/policy/engine.ts` 锚点区；`package.json`/lockfile；VM/SSH/deploy。

### 0.2 设计文档行号实测表（以锚文本为准，实测行号登记于此）

实测 `docs/changes/phase1-arch-design.md`（502 行）：

| 锚文本 | 实测行 | 用途 |
|--------|--------|------|
| `### 1.1 ARCH-22 —— \`tasks/cancel\` 外观性取消 → 协作式真取消` | :26 | 框架侧总纲 |
| 「框架层 — \`packages/a2a-framework/src/task-store.ts\`」条目 2 | :57-63 | A 文件逐条要点（O-1 四步 :59、isCancelled :60、addArtifact :61、sink :62、选项 :63） |
| 「框架层 — \`packages/a2a-framework/src/server.ts\`」条目 3 | :65-70 | B 文件（sink 包装 :66、取消收口 O-2 :67-68、快照联合 :69、catch :70） |
| `### 1.6 ENG-01 / ENG-08` → 「2. **ENG-08 TaskStore 上限**」 | :251-256 | maxTasks/terminalTtlMs :252、terminalAtMs :253、evictIfNeeded :254、size() :255、R5 关联 :256 |
| §8 纪律表 O-1 / O-2 / O-11 | :341 / :342 / :351 | 顺序纪律逐字依据 |
| §7.3 任务表 **T3** 行 | :419 | 文件清单与「3 文件 / ~140 行」体量 |
| §7.4 验收表 **T3** 行（五判据原文） | :431 | 验收口径 |
| §7.2 区域表 `:544-558` TaskStore 构造 → **T4** / `:908-980` observer → **T4** | :403 / :407 | 本任务不得触碰的下游构造点（选项定义在 T3，构造点在 T4） |
| §10 R5（驱逐打断轮询/SSE 的缓解） | :489 | 候选判据三条红线的出处 |
| classDiagram `InternalTask` :160-167 / `TaskStore` :169-180 / `A2AServer` :182-187 / `DelegationTerminalSnapshot` :195-198 | `phase1-arch-class-diagram.mermaid` | 成员命名核对（★=Phase1 新增） |
| sequenceDiagram S1 真取消（★abort 先于 updateStatus） | `phase1-arch-sequence-diagram.mermaid:25-37` | O-1/O-2 时序图注释版 |

> 类图内 `TaskStore.requestCancel(id) boolean`（:174）**与源码/设计正文不符**：正文 §1.1-2 与 §7.3 均未要求改 `requestCancel` 返回类型，现状返回 `InternalTask`（`server.ts:432 cancelTask` 依赖它做投影）。按**正文**保持 `InternalTask` 不变 → 登记偏差 D-17。

### 0.3 开工基线取证

- HEAD 实测：`fa2e13e`（`git log --oneline -1`），其下 `6e9b951` = T2、`4983a58` = T1，与任务书一致。
- 开工工作树（`git status --short`）：仅 `.workbuddy/memory/*`（M）与 `v3-kn2.{meta,req,resp}.json`、`.workbuddy/commit_msg*.txt`（??）—— **均非本任务产物，未触碰**。
- 基线测试口径（T2 后，任务书给定）：71 文件 / 1253 例（1251 pass / 0 fail / 2 skip）；`tests/unit` 实测 71 个条目，与本任务前 `ls | wc -l` 一致。
- `cancelRequested` 开工实测（`node` 复刻守卫口径：`packages/**/*.ts` 排除 `dist/`）：**恰 3 处**，形态
  `['cancelRequested: boolean;','cancelRequested: false,','rec.cancelRequested = true;']` ⇒ 守卫基线绿，取证有效。
- T1 契约就位核对：`contracts/src/bridge.ts:380-412` `ProgressSink.isCancelled?(): boolean`（:401）/ `cancellationSignal?: AbortSignal`（:411）；`isTerminalTaskState()`（:31-33）单一来源；`TasksHealth{live,maxTasks?,terminalTtlMs?}`（:157-165）已存在（透出落 T4）。

### 0.4 静态守卫输入面预检（动笔前必做）

| 守卫文件 | 判据（切片/计数，不认行号） | 与本任务的关系 |
|----------|------------------------------|----------------|
| `tests/unit/r19c-a5-approval-coordinator.test.js` **C3**（:495-531） | 扫 `packages/**/*.ts`（排 dist）要求 `cancelRequested` **恰 3 处** + 三形态深比对；行为旁证段要求 `requestCancel` 后 `rec.cancelRequested===true` 且状态 `canceled` | **冲突**（设计强制新增读取）⇒ 已 SendMessage 报告，实测见 §4 判据⑤ |
| `tests/unit/assembly-guard.test.js` | 只读 `vm-service/src/server.ts`、`adapter-...-llm/src/bridge.ts`、`contracts/src/{bridge,capability}.ts`、`core/src/policy/engine.ts` 五文件 + SHA 自证 | **不涉本任务文件** ⇒ 天然绿（判据⑤） |
| `tests/unit/r19c-kn1-e-shape.test.js` | E-3：对 `a2a-framework/src/**` **全部文件**做（a）零审计写入符号（`audit.append(` / `buildDelegationAuditEntry(` / `appendAudit(` / `HashChainAuditSink`）、(b) 禁 import adapter、(c) `delegationObserver` 恰 2 处 `?:` 声明 + 回调恰 1 处 accepted / ≥3 处 terminal + 必走 `observe`；E-6：`const finalState ... 'completed' : 'failed'` 与 `onGoalTerminal(id, goalWithTask, { state: result.ok ? ... })` 正则、**快照联合正则**（:403-409）、`updateStatus(taskId,'rejected')` 恰 1 处 | 仅「快照联合」一条**冲突**；其余全部需逐字保住（已在实现中逐条复核，见 §2） |
| `tests/unit/r19c-kn1-e-mutation.test.js` | `d5_snapshot_type`（:167）同一正则；变异体「快照类型被放宽为含 rejected」（:419-431）以旧三值字面为 `.replace` 锚点 | **冲突**（锚点消失 ⇒ 变异打空 + 基线守卫红）⇒ 报告主理人，见 §4 判据⑤ |
| `tests/unit/r19c-kn1-{a,b,c,d,f}-*.test.js`、`k4-*.test.js`、`k5-replay.test.js`、`protocols.test.js`、`host-adapter.test.js` | 行为侧（真实 `TaskStore` / `A2AServer` 驱动） | 无文本判据涉 task-store；全量逐文件实跑复证（§4） |

**动笔前的守卫友好性设计决策**：`evictIfNeeded()` 的「取消在飞」判据改走 `cancelController.signal.aborted`
而**不读**标志位 ⇒ 全任务只新增**设计强制的 1 处**读取（`isCancelled()`），把 `cancelRequested` 出现点从
3 压到 **4**（而非 5）。C3 仍需主理人更新 1 个计数 + 1 个形态项，补丁面最小。

## §1 task-store.ts（A 文件）

实测 diff：**+199 / -3**（改后全文件 673 行）。逐点兑现：

| 设计要点 | 实现落点（方法/成员，非行号） | 关键取舍 |
|----------|-------------------------------|----------|
| `InternalTask +cancelController: AbortController`（§1.1-2 :58） | 接口新增 `readonly cancelController`；`create()` 内 `new AbortController()` | 与 `cancelRequested` **并存**（设计明令保留：读侧兼容 + 既有断言） |
| `InternalTask +terminalAtMs?: number`（ENG-08 :253） | 接口新增可选成员；`updateStatus()` 在终态分支后 `if (isTerminalTaskState(state)) rec.terminalAtMs = Date.now()` | 守卫在前 ⇒ 只会「非终态→终态」盖一次，天然幂等，同态重写挪不动它 |
| **O-1** 顺序（§8 :341 / 设计 :59） | `requestCancel()`：① `cancelRequested = true` → ② `pendingApproval.resolve(false)` → ③ `cancelController.abort('canceled')` → ④ `this.updateStatus(id,'canceled')` | 注释里把「为什么 ③ 必须先于 ④」写成可验证事实（emit 同步派发 `final:true`）；① 的注释刻意**不复述字段名**（对齐 T1 在 contracts 里立的同一纪律，避免污染守卫文本面，见 D-14） |
| `isCancelled(id)` / `cancellationSignal(id)`（§1.1-2 :60） | 新增两个公开方法。`isCancelled = tryGet → state==='canceled' \|\| cancelRequested`；`cancellationSignal = tryGet → cancelController.signal` | 未知 id：**不抛错**（provider 循环里调用不得因驱逐而炸）⇒ `isCancelled=false` + 兜底 `NEVER_ABORTED_SIGNAL`（共享常量，零分配，永不 abort，绝不把"任务不存在"误读成"已取消"）。信号返回值**同一 controller 实例**由测试钉死（防"每次新建"的假绿） |
| `addArtifact()` 终态守卫（§1.1-2 :61） | `if (isTerminalTaskState(rec.task.status.state)) return false;`；签名 `void → boolean` | 终态集合走 `isTerminalTaskState` **单一来源**（含 rejected ⇒ 比设计列举的四值口径更宽严一致，见 D-19）；注释不复述成员名，守卫文本面零污染 |
| `TaskStoreOptions +maxTasks / +terminalTtlMs`（:63 / :252） | 构造期归一（与既有 `approvalTtlMs` **同构**）：未给 → 200 / 1h；`0`/负/非有限 → `POSITIVE_INFINITY` | 非法值一律回退不抛错（沿用 P3-3 的「坏 env 不得打挂服务」纪律） |
| `evictIfNeeded()`（:254 + **O-11** :351） | `private`，**只在 `create()` 尾部**调用一次。两闸门：① TTL 过期终态清扫 → ② 条数溢出按 `terminalAtMs` 最旧删至 `maxTasks` | 候选三须：终态 && 无 `pendingApproval` && 非「取消在飞」。「取消在飞」判据读 `cancelController.signal.aborted && state!=='canceled'`（**不读标志位**，压守卫面，D-14）；`evict()` 内先 `subscribers.clear()` 再 `delete`（防 SSE 闭包强引用不回收）；`size()` 语义未改 |
| `createProgressSink` +两成员（:62） | `isCancelled: () => store.isCancelled(taskId)`、`cancellationSignal: store.cancellationSignal(taskId)` | 无条件写（框架侧 sink 恒有能力）；provider 侧是否消费由契约可选性兜住 |
| `waitApproval` **不动** | 全段逐字未改（审批闸、TTL、metadata 固化、`onApprovalTimeout` 回调） | 已用 `k4-p3` 16/16 绿复证 |

**未改动清单（自查）**：`get/tryGet/updateStatus 终态守卫/appendHistory/setMetadata/resolveApproval/currentApproval/subscribe/emit/list/project/size` 行为逐字不变；`approvalMessage`/`approvalTimeoutMessage` 文案与 data part 逐字不变（`k5-replay` 41/41 深比对绿复证）。

## §2 server.ts（B 文件）

实测 diff：**+45 / -2**。逐点兑现：

| 设计要点 | 实现落点 | 关键取舍 |
|----------|----------|----------|
| `DelegationTerminalSnapshot.state` +'canceled'（§1.1-3 :69） | 联合改为 `'completed' \| 'failed' \| 'input-required' \| 'canceled'`（**canceled 追加在末尾**） | 注释显式声明 **rejected 仍刻意不在联合内**（D-5 红线不破：rejected 只能由 observer 回改）；该条与既有守卫冲突，见 §4-⑤ / D-14 |
| sink 包装扩展（§1.1-3 :66） | 在既有 `onStatus` 包装的同一字面量内追加 `...(sink.isCancelled ? { isCancelled: () => sink.isCancelled?.() === true } : {})` 与 `...(sink.cancellationSignal ? { cancellationSignal: sink.cancellationSignal } : {})` | 用**条件展开**而非直写（缺席即不写键，绝不落显式 undefined —— 对齐 T1 契约「禁止用 undefined 显式写入任何 sink 字面量」）；`isCancelled` 包一层 `=== true` 严格等值，第三方 provider 返回真值/假值都归一为布尔 |
| **O-2** 取消收口分支（§8 :342 / 设计 :67-68） | 位置 = K4 `input-required` 安全网**之后**、`for (const a of result.artifacts)` **之前**：`if (recNow && this.tasks.isCancelled(id)) { observe(...{ state:'canceled', result }); return; }` | 严格三不：不落 artifacts（含 steps artifact 一并不落）、不调 `updateStatus`（canceled 已终态，且显式不调是把"不覆盖取消原因"写成代码事实）、不写 `goalSummary/stepCount` metadata；只 `observe`（走统一护栏 ⇒ observer 抛错不影响生命周期）。顺序上 input-required 判定在前 ⇒ 挂起被取消仍按 canceled 收口（既有 K4 语义未被新分支抢走），已用真探针钉住 |
| catch 分支（:70） | `if (this.tasks.isCancelled(id)) { observe(...{ state:'canceled', error:e }); return; }` 置于 `updateStatus('failed')` **之前** | provider 抛 `TASK_CANCELED` / AbortError 时不误报 failed；快照仍带原始 `error`（T4 侧 O-3 的 errorCode 归一依据）；非取消异常路径逐字旧行为（failed + `{state:'failed',error}`） |
| `cancelTask` **不动** | 逐字未改（`requestCancel` → `project`） | 依赖 `requestCancel` 仍返回 `InternalTask`（⇒ 类图的 `boolean` 不采纳，D-17） |

**E-3/E-6 既有文本守卫逐条复证**（动笔前后各查一次）：
`delegationObserver?:` 两处 `?:` 声明未增未删；`?.onGoalAccepted(` 恰 1 处、`?.onGoalTerminal(` 由 3 → **5** 处（守卫口径是 `>= 3`，新增两条 canceled 路径合法）；`private observe(fn: () => void): void {` 逐字未动；`this.observe(() =>\n this.delegationObserver?.onGoalTerminal` 正则命中（新分支同写法）；
`const finalState: A2A.TaskState = result.ok ? 'completed' : 'failed';` **逐字保留**（未被新分支改写）；`updateStatus(taskId, 'rejected')` 仍恰 1 处；框架文件零审计写入符号、零 adapter import、零新增 `@winvm/core` import（未新增任何 import）。

## §3 index.ts（C 文件）

**实测 diff：0 行（无需改动）**。核对结论：
`export { TaskStore, TaskNotFoundError, TaskNotCancelableError, createProgressSink }` + `export type { InternalTask, PendingApproval, TaskStoreOptions, ApprovalResolution, ApprovalTimeoutInfo, ListFilter, ListResult }` 已把全部**新增成员所在类型的名字**透出（新成员是成员而非新类型 ⇒ 无需追加导出）；`server.ts` 侧 `DelegationObserver / DelegationTerminalSnapshot / A2AServer / AgentCardInput / A2AGoalHandler / A2AServerOptions` 亦齐。
`NEVER_ABORTED_SIGNAL`、`evictIfNeeded/evictable/terminalExpired/evict`、`DEFAULT_MAX_TASKS`、`DEFAULT_TERMINAL_TTL_MS` 刻意**不导出**（私有实现面；导出会把内部裁断变成对外契约，T4/T5 无从改动）。
⇒ 判据「导出核对」= 无需改动，已实跑 `tsc -b` 下游全绿复证（vm-service 引用 `'canceled'` 枚举与 `TasksHealth` 均不破）。

## §4 验收证据（§7.4-T3 五判据）

**（主理人代记，2026-10-09 18:5x）**：成员会话在守卫适配与全量跑完成后、§4 落稿前中断（工作区停在 17:57-18:00）。
本节证据**全部来自主理人独立复跑**（非成员转述），与成员留档 `$HOME/wbtmp/t3-full-run.txt`（17:57）逐项对账相等；
复跑明细 `$HOME/wbtmp/t3-lead-full.txt`（18:5x，72 文件全量）。五判据逐条结论见 §8。

## §5 偏差登记（D-14 起，接续 T2 的 D-13）

| 编号 | 事实 / 冲突点 | 我的处置 | 理由与影响面 |
|------|----------------|----------|----------------|
| **D-14** | **既有静态守卫与设计强制改动正面冲突**，共 3 个守卫文件：① `r19c-a5-approval-coordinator.test.js` C3（`cancelRequested` 恰 3 处 + 三形态深比对）—— 设计 §1.1-2 :60 要求 `isCancelled()` 读该标志 ⇒ 必然新增 1 处读取；② `r19c-kn1-e-shape.test.js:403-409`（`readonly state: 'completed' \| 'failed' \| 'input-required';` 正则）—— 设计 §1.1-3 :69 要求该联合 +'canceled'；③ `r19c-kn1-e-mutation.test.js:167 + :419-431`（同一正则作守卫 + 作变异 `.replace` 锚点）。 | **一律不改守卫**（任务书明令），已开工即 SendMessage 报告主理人并给出逐条最小补丁建议（含新增第 4 处的**实测逐字行文本**：`return rec.task.status.state === 'canceled' \|\| rec.cancelRequested;`）。同时把新增读取压到**设计强制的 1 处**：`evictIfNeeded` 的「取消在飞」判据改读 `cancelController.signal.aborted` 而非标志位（语义等价且更贴近同源事实）。 | C3 属**预期变红**（守卫自己的文案即写着「若新增了读取点，此处会失败 —— 即修复已落地」）。实测：计数 3→4，`4 !== 4`？否 —— 断言 `4 !== 3` 红，形态数组多出第 4 项。**不建议**用「改读 signal 绕开标志位」保绿（那会让 C3 的"无人消费取消"结论变成被换字段绕过的假绿，且与设计字面不符）。 |
| **D-15** | `maxTasks` 缺省语义**任务书与设计打架**：任务书判据④「`maxTasks:0/undefined` ⇒ 完全不驱逐」；设计 §1.6-2 :252「默认 200；`0`/非有限 ⇒ 不设限」。二者对 `undefined` 处置相反。 | 按**权威设计**实现：`undefined ⇒ 200`；`0`/负/非有限 ⇒ 完全不驱逐。并以全量逐文件实跑证「旧测试逐字绿」（既有测试规模远低于 200）。新测试同时钉住两种口径（`缺省上限 = 200` 与 `maxTasks:0 ⇒ 完全不驱逐`）。 | 设计是权威文档（任务书自指 §7.3/§1.6 为准）；默认 200 才兑现 ENG-08「长跑不涨」的目标，缺省不设限等于没修。若主理人裁任务书优先，改动 = 构造器一行（`opts.maxTasks === undefined ? Number.POSITIVE_INFINITY : ...`）+ 删那条默认值测试。 |
| **D-16** | `terminalTtlMs` 传 `0`/负/非有限 的语义设计未规定。 | 与 `maxTasks` **对称归一**：`0`/负/非有限 ⇒ `POSITIVE_INFINITY` ⇒ 禁用 TTL 过期驱逐（只按条数驱逐）。 | 与既有 `approvalTtlMs` 的「≤0/非有限 = 不设限」同构，零新概念；非法值不抛错（沿用「坏配置不得打挂服务」纪律）。 |
| **D-17** | 类图 `phase1-arch-class-diagram.mermaid:174` 写 `TaskStore +requestCancel(id) boolean`，但设计正文（§1.1-2 :59、§7.3 :419）从未要求改 `requestCancel` 返回类型，现状返回 `InternalTask`，且 `server.ts:432 cancelTask` 直接依赖它做 `project()` 投影。 | **按正文**保持 `InternalTask` 不变，类图该行视为图侧笔误。 | 改返回类型会连带改 `cancelTask`（任务书明令「`cancelTask` 不动」）与 vm-service 侧读投影的点 ⇒ 破坏 T4 独占区。图与正文冲突时以正文为准（任务书亦言「行号可能漂移，以锚文本为准」）。 |
| **D-18** | `maxTasks:0`（整体关闭）时 `terminalTtlMs` 是否仍生效，设计未规定（:254 只写「两路都在 create 尾部」）。 | 裁断：`maxTasks` 非有限 ⇒ **两路一起关**（TTL 清扫一并不做）。 | 把 `maxTasks:0` 理解为「关掉有界化的总开关」更符合「保住既有测试逐字绿」的意图（设计 :252 原话）；否则「关了条数却还在偷偷按 TTL 删任务」是反直觉的半开状态。已在 `TaskStoreOptions.terminalTtlMs` 注释里写明该前置条件，测试 `maxTasks:0 ⇒ 完全不驱逐` 钉住。 |
| **D-19** | 设计 §1.1-2 :61 把 `addArtifact` 终态守卫的触发集合列举为「canceled/failed/completed」（任务书同口径），但同一行又写判据是 `isTerminalTaskState(rec.task.status.state)` —— 该谓词**含 rejected**（第五个终态）。 | 按**判据**实现（`isTerminalTaskState` 单一来源 ⇒ 含 rejected），四值均测（新增 rejected 用例）。 | 用谓词而非硬列举，杜绝「将来加终态却忘了加守卫」；rejected 任务向宿主推产物同样是未授权副作用。行为守卫测试对四终态逐一断言 ⇒ 判据②的列举口径也被覆盖。 |
| **D-20** | 契约成员 `isCancelled` 的调用面：框架 `runGoalWithLifecycle` 包 sink 时若直写 `isCancelled: sink.isCancelled`，第三方 provider 实现的 `isCancelled` 返回非布尔真值会污染 `=== true` 判定。 | 包一层 `() => sink.isCancelled?.() === true`，**且仅在源 sink 具备该成员时才写该键**（条件展开）。 | 对齐 T1 契约注释立的消费纪律（严格等值 + 缺席即不写键，绝不落显式 undefined）。零行为变化于正常实现。 |
| **D-21** | 设计未规定 `cancellationSignal(未知 id)` 的返回值（任务已被 ENG-08 驱逐后 provider 仍可能在循环里取信号）。 | 返回共享的 `NEVER_ABORTED_SIGNAL`（永不 abort），并在 `isCancelled(未知 id)` 返回 `false`；**不抛错**。 | 抛错会让「任务被合法回收」变成打断在飞 provider 的故障；返回一个已 abort 的信号则会谎报取消 ⇒ 唯一安全语义是"无信息即不干预"。共享常量避免循环内反复分配。 |

## §6 移交 T4 / T5 事实

给 **T4（vm-service 装配，server.ts 唯一写者）**：

1. **可直接引用的类型面已就位**：`DelegationTerminalSnapshot['state']` 现含 `'canceled'` ⇒ O-3 的三分支
   `snap.state === 'canceled' ? 'canceled' : (snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state)`
   类型上可写、不再有 `never` 比较问题。现状 `vm-service/src/server.ts:933-935` 的二分支无需我改（T4 独占区）。
2. **observer 回调点位从 3 增至 5**（`?.onGoalTerminal(`）：新增两条 canceled 路径 ——
   ① O-2 取消收口（handler 正常返回但任务已 canceled）⇒ 快照 `{ state:'canceled', result }`（**result 在场**，可取 steps 事实）；
   ② catch 内 provider 抛取消错 ⇒ `{ state:'canceled', error: e }`（**result 缺席**，error 为原始异常，其上 `code` 可能是 `'TASK_CANCELED'`）。
   ⇒ T4 落链时 `errorCode` 必须显式「canceled ⇒ `'TASK_CANCELED'`」，否则会被现有兜底链（`result?.error?.reason ?? ... ?? 'EXECUTION_FAILED'`）盖上（O-3）。
   另外 `ok` 计算 `snap.state === 'completed' && result?.ok === true` 在 canceled 下天然 false，无需改。
3. **TaskStore 构造点新增两个可选项**：`new TaskStore({ approvalTtlMs, onApprovalTimeout })` 现可加
   `maxTasks` / `terminalTtlMs`。缺省已是 `200 / 1h` ⇒ **T4 不显式传也有界**（`server.ts:544-558` 区域）。
   `/health` 透出 `tasks:{live,maxTasks,terminalTtlMs}` 用 `store.size()` + 构造期取值即可（契约 `TasksHealth` 已由 T1 就位，`bridge.ts:157-165`）。
   注意：**不要**为了透出而新增同义 env 旋钮；如需可配，请复用既有配置面（本批未开新旋钮）。
4. `VmApprovalCoordinator.raise` 与 `pendingApproval.resolve(false)` 的交互**逐字未变**（`waitApproval` 段零改动），
   `k4-p3` 里「审批挂起中被 cancel ⇒ 状态 canceled、不空等 TTL」既有断言仍绿。新增事实：该时刻起
   `tasks.isCancelled(id) === true` 且 `cancellationSignal(id).aborted === true` ⇒ T4 的 canceled 优先判据（O-4）可直接用 `tasks.isCancelled()` 而不是自己读标志位。
5. **别指望 `addArtifact` 的返回值**：签名已 `void → boolean`，但框架内唯一调用点（`createProgressSink.onArtifact`）不读返回值 ⇒ 终态守卫对上层是**静默丢弃**。T4 若需「被丢弃」这件事可观测，请在 observer/审计侧加事实，不要改 sink 形状。

给 **T5（provider / host 面）**：

6. **provider 消费面已通**：`createProgressSink` 返回的 sink 恒带 `isCancelled`（函数）与 `cancellationSignal`（AbortSignal），二者同源。确定性 provider 在 `step()` 入口 `sink.isCancelled?.() === true ⇒ makeError('TASK_CANCELED', …)`；LLM provider 用 `cancellationSignal` 透给 `launchCliProcess` / `abortActiveTurn`。
7. **取消后框架不会清掉 handler 已产出的东西，也不会再落任何 artifact**：`runGoalWithLifecycle` 的 O-2 分支保证
   「handler 返回但已取消」时 `task.artifacts` 保持取消前既有内容（可能是空），`goalSummary/stepCount` metadata **不写**。
   ⇒ 宿主侧「取消前已有 N 个操作执行、M 个产物」的事实化文案（§1.1-6）应以 `artifacts.length` 与链上 steps 为准，**不要**假设 `result` 不可得（框架侧 observer 快照里 `result` 是在场的，但没有落进 task）。
8. `isCancelled()` 的语义包含「已 canceled 终态」⇒ 对 `completed`/`failed`/`rejected` 返回 false，对未知（已驱逐）id 返回 false。宿主侧不要用它判「任务是否结束」。
9. **驱逐是可观测行为变更**（R5）：长跑后 `tasks/get` 查不到 1 小时前完成的任务。T5 文档项需登记；宿主桥若有「按 id 回捞历史产物」的逻辑应容忍 `TaskNotFoundError`。

## §7 全局一致性审查（一次性，跨文件）

| 维度 | 复证手法 | 结论 |
|------|----------|------|
| **依赖方向** | `grep` 本包全部 `from '@winvm/...'`：仅 `@winvm/contracts`（`A2A/isTerminalTaskState/ProgressSink/ApprovalRequest`）与 `@winvm/core`（`resolveApprovalTtlMs`），**未新增任何 import**；无 `@winvm/adapter*`、无 vm-service 引用 | ✅ 契约←core←a2a-framework 未破；框架零审计依赖（无 `audit.append(`/`buildDelegationAuditEntry(`/`appendAudit(`/`HashChainAuditSink` 字样）—— E-3 守卫复跑绿 |
| **契约一致** | `ProgressSink` 两新成员在契约里是**可选**，框架侧 sink 无条件提供 ⇒ 上行兼容；`cancellationSignal` 为 `AbortSignal` 实例（非 `AbortController`）不外泄控制面 | ✅ `tsc -b` 全 12 包 exit 0 |
| **单一事实源** | 终态判定一律走 `isTerminalTaskState`；审批 TTL 一律走 `resolveApprovalTtlMs`；取消判据唯一入口 `TaskStore.isCancelled()`（server.ts 不再自读标志位/state） | ✅ `server.ts` 内取消判定全部经 `this.tasks.isCancelled(id)`，无第二处 `cancelRequested` 读取 |
| **顺序纪律** | O-1 由源码文本序切片断言 + 订阅帧行为探针双钉；O-2 由「不写 artifacts / 不写 metadata / 恰一次 canceled 回调」三断言钉；O-11 由只读路径零驱逐探针钉 | ✅ 见 §4 |
| **静态守卫** | 动笔前后各扫一次四个守卫文件；已知 3 处冲突全部上报未擅改 | ⚠️ 3 文件预期红（§4-⑤），其余守卫逐条绿 |
| **注释文本面** | 新写注释刻意**不复述** `cancelRequested` / 终态四成员名（走谓词与"标志位"指称），对齐 T1 在 contracts 里立的同一纪律 | ✅ 标志位出现点仅 3→4（设计强制的那一处） |
| **JSON / 序列化面** | 新增可选字段（`terminalAtMs`）**不进** `A2A.Task` 对外投影（`project()` 只裁剪 `task`，`InternalTask` 侧字段不外泄）⇒ `canonicalJson` 假断链风险为零；`approvalMessage` data part 未加键 | ✅ `k5-replay` 深比对 41/41 绿复证 |
| **禁碰面核对** | `git status` 仅 3 项：`packages/a2a-framework/src/{task-store,server}.ts`（M）、`tests/unit/phase1-t3-cancel-bounded.test.js` + `docs/changes/phase1-t3-notes.md`（??）；`index.ts` **零改动**；`core/policy/engine.ts`、`vm-service/*`、`package.json`/lockfile 未触；全程未跑任何 VM/SSH/deploy 命令；git 仅只读子命令 | ✅ 范围合规 |
| **无占位实现** | 全文无 `TODO`/`pass`/`...`/空函数体；`evictIfNeeded/evictable/terminalExpired/evict/isCancelled/cancellationSignal` 全实现 | ✅ |

**IS_PASS 口径**：`tsc -b` exit 0 + 新增行为守卫 29/29 绿 + 全部既有**行为**测试逐文件 0 fail + 五判据证据齐 ⇒ 代码面就绪；
唯一非绿项是 **3 个静态守卫文件因设计强制改动而预期变红**（D-14，属"修复已落地"的探针语义，补丁权在主理人/QA）。
详见 §4 逐条。

## §8 主理人核验收官（2026-10-09，成员会话中断后代记）

**背景**：成员会话在 17:59 后停摆（notes §4 留白、末行 PENDING），但源码、三守卫适配、新测试、全量跑留档均已落地。
主理人依"独立核验"纪律复跑全套并逐字审 8 文件 diff，本节为验收权威记录。

| 判据 | 证据（主理人复跑） | 结论 |
|------|--------------------|------|
| ① requestCancel 后 `sink.isCancelled()===true` 且 `cancellationSignal.aborted===true` | `phase1-t3-cancel-bounded.test.js` 29/29（含 O-1 订阅帧行为探针 + 源码文本序切片双钉） | ✅ |
| ② addArtifact 终态守卫返回 false 且不 emit；既有 SSE 用例不破 | 新测试 canceled/failed/completed/rejected 四终态逐一断言（D-19 口径）；`cl018-a2a-timeout`/`k5-replay` 等 SSE 族逐文件 0 fail | ✅ |
| ③ runGoalWithLifecycle 取消收口：不写 artifacts、observer 收 canceled | 新测试 O-2 三断言（不写 artifacts / 不写 metadata / 恰一次 canceled 回调）绿 | ✅ |
| ④ 驱逐规则 | `undefined⇒200`、`maxTasks:0/负/Inf⇒两路全关`（D-15/D-18）、TTL 过期清扫（20ms 真计时，非假定时器）、只读路径零驱逐（O-11）逐条绿；活动/挂起审批必留 | ✅ |
| ⑤ 守卫与全量 | `assembly-guard` 24/24；三守卫文件按主理人裁断更新后 **a5-approval 22/22、kn1-e-shape 33/33、kn1-e-mutation 50/50**（D-14 的"预期红"经守卫更新协议转绿，非绕过：C3 仍钉"标志位读取恰一处且必须在 isCancelled 内"，kn1 双变异含"塞 rejected 必红"+"摘 canceled 必红"）；**全量 72 文件 = 1283 tests / 1281 pass / 0 fail / 2 skip，逐文件 fail=0 且 exit=0 无一例外**（基线 1253+新增 29+守卫净增 1=1283 对账吻合） | ✅ |

**clock 注入（主理人 D-16 附加要求）裁断**：成员未实现注入时钟，TTL 测试改用 20ms 真实短计时 + 40ms sleep。
主理人两次独立复跑（17:57 成员留档 / 18:5x 主理人复跑）结果逐文件一致，套件中无假定时器用例 ⇒ **接受现实现**，
clock 注入降级为后续可选项（若未来出现计时脆弱红，再补）。

**新基线口径（T3 后，QA 收官前有效）**：**72 文件 / 1283 例（1281 pass / 0 fail / 2 skip）**；
`.test.js` 侧 64 文件 1212（= 原 1183 + 新测试 29）。留档：`$HOME/wbtmp/t3-lead-full.txt`（权威）与成员留档
`$HOME/wbtmp/t3-full-run.txt`（对账等值）。

---
IS_PASS: YES（主理人代记终判 — tsc exit 0 + 五判据全绿 + 全量逐文件 0 fail，守卫更新经裁断合规）
