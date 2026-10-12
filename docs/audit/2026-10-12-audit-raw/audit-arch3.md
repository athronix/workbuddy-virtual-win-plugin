# WinVM Bridge 架构审计 · 接力棒 3（维②–⑤）

- 审计人：Bob（software-architect-3，架构维接力棒 3）
- 开工：2026-10-12 21:11:38（真实 `date`），全程只读（零 git 写操作、零仓库文件修改）
- 仓库：/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin
- 证据口径：每条结论附 `文件:行号`；`git grep` 在仓库目录内执行；node/git 走全路径。

## 0. 与棒 1（维①）的对账差异

棒 1 报告 `/storage/Users/currentUser/wbtmp/audit-arch.md` 已完成**维①（分层与依赖方向）**，本文**不重写维①**，仅承接其结论：

| 棒 1 维① 结论 | 本次（维②–⑤）是否受影响 | 差异/补充 |
|---|---|---|
| dep-lint GREEN（hard0/warn0/info11），三方机检自洽 | 不影响 | 维②–④发现的问题**全部落在 lint 判据覆盖不到的语义面**（可达性、审计缺口、生命周期），说明"GREEN ≠ 语义正确" |
| D-α：ARCHITECTURE.md §2.2 缺 2 包 / host-a2a-bridge 层位口径不一 | 不影响 | 本次在维⑤补充：文档滞后不止层位表——`INTERFACES.md:212` 的**续跑指令**本身与现实不符（见 B-1） |
| 真幽灵声明 1 条（hermes←core） | **升级相关性** | 棒 1 判为 P2 命名卫生；本次在维⑤发现 hermes 的**能力面声明**（`declareCapabilities`）与真实审批能力之间的缺口，属同源问题的语义面（P1） |
| approvalTruth 同形复刻有 E5/E6 钉 | 不影响 | — |

棒 1 侦查笔记（`audit-arch-timeline.log:3`，20:30:44 行）六条，**逐条亲验结果**见文末 §6 对账表，其中两条判为"需修正表述"（K3 兜底措辞面、dead-config 闭环口径）。

---

## 维② 核心链路实现质量（审批 / 重放 / 取消 / 进度）

### 结论先行

四条链路里**取消链最扎实**（三通道都有 AbortController 单源判据）、**重放链设计正确**（执行权收归服务端，参数不可伪造）、**审批链存在一条 P0 级"设计意图与实际可达性断裂"**：`hostApproved` 这个被三处文档描述为"MCP 人工显式续跑路径仍可用"的信任位，在**缺省配置下的纯 MCP 直调通道没有任何生产可达路径能把它置真**——续跑协议字段 `__approvalId` 已成事实死字段，而宿主侧 Skill/接口文档仍在指导用户与 Agent 使用它。审批链的第二问题是 **replay 早退分支零审计**（4 处），与 S-4 已经修好的 POLICY_DENIED 同类缺口，修法现成却未套用。

### 头条复核：hostApproved 可达性（A-1，P0）

**主理人给的锚点，独立复核成立**，并补齐完整链条：

1. **唯一置位点**：`packages/vm-service/src/server.ts:424`
   ```ts
   // 宿主批准：token 置为「已批准」——保留 K4 语义，`/mcp` 人工显式续跑路径仍可用
   if (token) token.hostApproved = true;
   ```
   全仓 `hostApproved` 写入点仅此一处（`git grep -n "hostApproved" -- 'packages/**/*.ts'` 命中：声明 server.ts:128、注册恒 false server.ts:1250、放行闸 1227、注释 175/1226、本行 424、清扫器保护 pending-approvals.ts:195、事实采集跳过 approval-replay.ts:358）。`git grep -n "\.hostApproved = "` 全仓 packages/ 只回 server.ts:424 一行。**确认。**

2. **唯一生产调用入口**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts:1232`
   `const outcome = await this.coordinator.raise(req);`
   全仓 `raise(` 命中仅三处：契约声明 `contracts/src/bridge.ts:588`、实现 `vm-service/src/server.ts:345`、调用 `bridge.ts:1232`。**确认：生产调用链唯一入口 = workbuddy-llm 桥的 `maybeResume`。**

3. **可达性推导（这是新增深度，非照抄）**：
   - `this.coordinator` 只由 `adapter-agent-workbuddy-llm/src/index.ts:275` 注入（`this.bridge.setApprovalCoordinator?.(ctx.approvalCoordinator)`），而 `ctx.approvalCoordinator` 由 vm-service 装配层在 provider init 时下传 ⇒ 仅 **provider 运行期**存在。
   - `bridge.ts:1202` `if (!blocked || !this.coordinator) return base;` ⇒ **coordinator 只在委派（runGoal）路径参与**。
   - `raise` 内部 `server.ts:348` `const taskId = req.taskId ?? this.activeTaskId;`，`server.ts:351` 无 taskId ⇒ 直接 `{approved:false, reason:'no-active-task'}` 早退，永不触及 424 行。
   - ⇒ **置 `hostApproved=true` 的必要条件集**：`workbuddy-llm` provider 已加载 ∧ 存在活动 A2A 委派任务 ∧ 宿主对该 approvalId 经 `/a2a` 的 `a2a.approval.reply{approved:true}` 应答（`a2a-framework/src/server.ts:301` → `task-store.ts:550` resolveApproval）。**纯 MCP 直调通道（宿主直接 POST `/mcp`）不具备其中任何一条**。

4. **后果：`__approvalId` 续跑通道在缺省配置下是死字段。**
   - `replay` 缺省开启：`core/src/constants.ts:216` `APPROVAL_REPLAY_DEFAULT = true`，装配点 `server.ts:1556` `setReplayEnabled(resolveApprovalReplay())`。
   - `raise` 批准分支重放完成后 **无条件删除 token**：`server.ts:449–464`（`this.pendingApprovals?.delete(req.approvalId)`，注释自述"无论成功失败都删除 token，杜绝同一 approvalId 二次重放/**二次续跑**"）。
   - 于是**即使**有人找到了把 `hostApproved` 置真的办法，token 也已被删；`server.ts:1227` 的 `pendingApprovals.get(approvalId)?.hostApproved === true` 恒 false。
   - 唯一"token 存活且 hostApproved=true"的组合是 `WINVM_APPROVAL_REPLAY=off`（`server.ts:445` 提前 return `{approved:true}`，注释明言"token 保留（K4 /mcp 续跑路径需它放行）"）——但那是**灰度回滚态**，且仍需先有 A2A 委派回合让 raise 存在。

**影响**：
- **可用性 P0**：宿主 Agent 按 `skills/winvm-mcp-reference/SKILL.md:213` 表格（"MCP 直调 → 以同一参数并附 `__approvalId` 重新调用原工具"）、`skills/winvm-orchestrator/SKILL.md` 与 `docs/02-design/INTERFACES.md:212` 的指引操作，**永远得不到执行**，只会重复拿到 `APPROVAL_REQUIRED`（且第二次是**新 approvalId**，因为 `server.ts:1240` 每次拦截 `newId('apr')`）。用户视角 = "批了也不执行"，与 K3 假成功是镜像病灶（一个是没执行说执行了，一个是执行路径根本不存在却对外宣称存在）。
- **文档面失真**：`server.ts:1213` 把 `__approvalId` 注入**每个** MCP 工具的 `inputSchema.properties` 并附描述"审批通过后用于续跑执行"；`server.ts:1361` 服务 instructions 写"风险等级 L2/L3 需先取 approvalId 再续跑"——两处对外承诺均无对应可达实现。
- **回归风险**：`server.ts:423` 注释"保留 K4 语义，`/mcp` 人工显式续跑路径仍可用"是**当前不成立的断言**。K5 设计文档 `docs/02-design/K5-server-replay-approval.md:67` 亦写"保留：/mcp 直调续跑仍可用（人工显式路径）"、`:91` "token 一次性：执行成功/失败均删除；`/mcp` 直调路径的 `hostApproved===true` 严格闸保留（K4 不动）"——两条并读即自相矛盾（删了还怎么留闸），`:103` 后来划掉"不碰 MCP 直调通道行为"但只放宽了**真值反查覆盖面**，未澄清**执行通道本身已不可达**。

**建议**（按成本递增三选一，须产品裁决，不要私自选）：
1. **诚实化（最小、建议先做）**：从 `mcpTools` 的 `inputSchema` 摘掉 `__approvalId`（或保留但描述改为"仅 A2A 委派回合批准后可用"），同步改 `server.ts:1361` instructions、`INTERFACES.md:212`、`winvm-mcp-reference/SKILL.md` ②表；并在 ARCHITECTURE/CAPABILITY-MODEL 显式登记"MCP 直调 = 无审批续跑能力，L2/L3 一律拒绝并提示改用委派通道"。**同时**让 `policy.evaluate` 在无 token 场景回一句可执行指引（目前只回"需审批"）。
2. **补一条宿主可达批准路径**：给 `/mcp` 通道加**宿主侧批准端点**（如 `POST /approvals/reply`，走同一 http-guard enforceBearer、必须落 `approval-decision` 审计且 `actor:'host'`），由桥/宿主显式调用——这是把 K4 语义真正落地的做法，但要重做一次性消费与 TTL 语义（批准即重放 vs 批准即置位让调用方续跑，二者只能留一个）。
3. **明确降级为 A2A-only 审批**：契约层给 `ApprovalCoordinator` 加 `supportsMcpResume: false` 事实位，`/health` 透出，Skill 里把 MCP 直调的 L2/L3 直接判为"必须委派"。

> 判级说明：定 P0 不是因为它造成越权（**安全面恰恰是好的**——fail-closed，永不放行），而是因为它使**对外承诺的能力面不存在**，且误导宿主 Agent 与运维文档，属"能力宣称与实现断裂"，与 CL-K3R 立项的"静默假成功"同量级。

### A-2｜approval-replay 早退分支审计缺口（P1，4 处）

**对照基准（已修好的同类）**：S-4 把策略硬拒绝的取证盲区闭合了——`server.ts:1313` / `server.ts:1075` 两处 `recordPolicyDeniedAudit(...)`，条目模板 `approval-replay.ts:151`（`blocked:policy-denied`，`approvalId:'policy-denied'` 哨兵）。设计意图清楚：**凡"到过服务端但未执行"都必须可在链上证明**。

**缺口**：`replay` 函数与 `raise` 的早退分支一条都没接。逐条：

| # | 位置 | 条件 | 链上痕迹 |
|---|---|---|---|
| 1 | `server.ts:1161-1168` | `!exposedIds.has(p.capabilityId)` ⇒ `{ok:false, error:'CAPABILITY_NOT_EXPOSED'}`（重放时能力已撤出暴露面） | **零条目**。批准已经发生、重放已经发起，链上既无 executed 也无拒绝记录；唯一痕迹是 `raise` 侧不落链的 `approved`（`server.ts:251` 判 `'approved'` 直接 return）+ 桥侧 `executed.ok=false` |
| 2 | `server.ts:1169-1177` | `capabilityDefs.get()` 缺席 ⇒ `'UNKNOWN_CAPABILITY'` | **零条目**，同上 |
| 3 | `server.ts:1103-1112` | `!provider` ⇒ `PROVIDER_UNAVAILABLE`（replay 与 MCP 原路径**共用** executeCapability，故两路都缺） | **零条目**。注意同函数上游 `!verdict.allowed` 分支**有**审计（:1075），紧邻的 provider 缺席分支**没有**——同一函数内部纪律不一致，最可能是遗漏而非取舍 |
| 4 | `server.ts:351-363` | `raise` 无挂接任务 ⇒ `reason:'no-active-task'`（审批请求被丢弃） | 只有 `logger.warn`，**零链上条目**。这是宿主"批了但任务已消失"的取证黑洞 |
| 5 | `server.ts:441` | 决议 true 但 token 已消失（被 TTL 清扫抢先）⇒ `{approved:false, reason:'rejected'}` | 零条目，且**归因错误**：把"自家令牌过期"报成宿主拒绝语义；`O-6` 去重集合此刻已含该 approvalId（`onApprovalTimeout`/sweep 已 recordDecision），不会再补一条 ⇒ 链上留下的是一条 `timeout`，而返回值是 `rejected`，**两侧口径不一致**（P2 面，见 C-3） |

**为何没接上（根因，非猜测）**：`approval-replay.ts` 里现成的三个落痕函数签名都以 `audit: AuditAppender` 为第一参，而 `replay` 是 `server.ts` 闭包内函数、`audit` 就在同一作用域（`:1075` 已证明可直接取用）⇒ **不是依赖不可达，是没人写**。`raise` 在类 `VmApprovalCoordinator` 内，它只有 `decisionSink`（注入式），而 sink 在 `:1579` 装配时把 `input.decision === 'approved'` **早退丢弃** ⇒ "批准"这一族事实按设计 §5 第 2 条裁断**整体不落链**，其失败子型（早退 1/2/3）因此连带消失。也就是说：**批准不落链的裁断本身是合理的（重放天然出一条 executed），但它隐含前提是"重放一定产出条目"，早退分支恰好打破这个前提，而打破时无人补记账。**

**影响**：真机排障时"批了但没动静"没有任何链上可查证据（运维只能翻 logger，而 logger 级别与轮转不保证留存）；审计自证面出现"批准后静默蒸发"窗口，K3R 的 `zeroInnerCalls`/`blockedCount` 账本也不会因此增加任何计数。

**建议**：给 `replay` 的三个早退 + provider 缺席补 `recordApprovalDecisionAudit(...)`，`decision:'rejected'`、`actor:'replay-guard'`（新枚举值，与既有四 actor 并列可 grep）、`errorCode` 用真实码；或者更省：新增 `recordReplayRejectedAudit()` 复用 `recordPolicyDeniedAudit` 的条目模板（`matchedRule:'replay-guard:<reason>'`）。第 4/5 条走 `decisionSink`，但需**先把 `'approved'` 早退改成"approved 成功不落、approved-but-failed 落"**（与 §5 第 2 条裁断不冲突，因为此时**没有** executed 条目可双写）。落点务必用**原始 `audit`**（O-7 纪律，`:1564` 注释已申）。

### 取消链（复核：扎实，两处小口子）

- **A2A 侧**：`a2a-framework/src/task-store.ts:352 requestCancel()` → 同同步体内 abort + 置终态（`:672` 注释自证 O-1），判据单源 `isCancelled()`（`:375`），provider 侧经 `sink.isCancelled`（`:855`）消费；桥 `bridge.ts:1396/1417/1459/1469/1610/1767` 多点检查，且 `:1729/:1775` 把"abort 造成的 error 事件"**先**归成 `TASK_CANCELED` 防被 `shouldDegrade` 拉回降级重跑——这条链路设计上是完备的。
- **MCP 侧**：`server.ts:101` `watchClientDisconnect` + `buildMcpRequestContext`（P2-T4 才接通的 ARCH-29），SECURITY-GOVERNANCE.md:109 已登记形态 `canceled:true + inFlightMayContinue:true`。
- **P2 口子 1**：`server.ts:401` 取消判定用 `this.tasks.isCancelled?.(taskId)`，**taskId 取自 `req.taskId ?? this.activeTaskId`**；`endTask` 归属语义（`:332-343`）已处理并发交叠，但 `activeTaskId` 是服务级**单例**——两个委派交叠且请求不带 taskId（旧桥/其他 provider）时，取消归因可能指向另一条任务。既有文档已登记（K5 根因文档 §6.4），Fix-1B（`bridge.ts:1228`）已把 taskId 显式化 ⇒ 残留风险仅在"未带 taskId 的调用方"。**登记为已知边界即可，勿再扩面。**
- **P2 口子 2**：取消链上条目 `errorCode:'TASK_CANCELED'` 的前置在 `recordApprovalDecisionAudit` 是 `APPROVAL_CANCELED`（`:510` 模板串），两套码族（审批决策码 vs 任务终态码）名字接近、语义不同，链上 grep 易混。建议文档口径表补一行（P2，非缺陷）。

### 进度链（复核：单通道能力，另一通道结构性缺失）

- A2A：`onStatus` → `task-store.ts:778` P2-T12 整形为合规 `A2A.Message`（wire 形状唯一裁决点）→ SSE `subscribe`（`a2a-framework/src/server.ts:502/553`，`unsubscribe` 在 `:541/:585` 收尾）。
- MCP：`mcp-framework/src/server.ts:177-178` 只识别 `notifications/initialized`/`notifications/cancelled`，**无 `notifications/progress`、无 logging message**。⇒ MCP 直调是纯请求-响应，长能力（如 `appops.cli.invoke` 转码）零中间进度。**这是通道性质而非缺陷**，但 `ARCHITECTURE.md:139` 的"简单任务走 MCP 直调"选型表没有把"需要进度反馈"列为切 A2A 的判据 ⇒ 文档补一行即可（P2）。

### 维② 问题清单

| 编号 | 级别 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| A-1 | **P0** | server.ts:424/1227/464 + bridge.ts:1232 + constants.ts:216 | 纯 MCP 直调无宿主可达路径置批准位；`__approvalId` 缺省态为死字段；对外三处文档仍承诺可用 | 三选一（诚实化 / 补批准端点 / 明确 A2A-only），先做诚实化 + 文档同步 |
| A-2 | **P1** | server.ts:1161,1169,1103,351；approval-replay.ts 现成三落痕函数未复用 | 批准后重放被早退 / provider 缺席 / 审批请求丢弃 = 链上零证据 | 复用 `recordApprovalDecisionAudit` 或新增 `recordReplayRejectedAudit`；写原始 sink（O-7） |
| A-3 | P2 | server.ts:348,332-343 | `activeTaskId` 服务级单例，不带 taskId 的调用方取消归因可串台 | Fix-1B 已覆盖主路径；把"taskId 必带"写进契约注释即可 |
| A-4 | P2 | server.ts:510 vs 任务终态码 | `APPROVAL_CANCELED` 与 `TASK_CANCELED` 双码族易混 | 文档口径表补一行 |
| A-5 | P2 | mcp-framework/src/server.ts:177 + ARCHITECTURE.md:139 | MCP 直调零进度（通道性质），但选型表未披露 | 选型表补"需进度反馈 ⇒ 切 A2A"判据 |

---

## 维③ 错误语义一致性与审计链完整性

### 结论先行

1. **传输层成功 ≠ 业务生效**这条 R4/B3 血泪教训，在 **A2A 侧已经成纪律并有注释自证**（`host-a2a-bridge/src/tools.ts:693` "分层口径：`ok:true`/`isError:false` 仅表示取消请求被服务端处理成功（传输层）"），在 **MCP 侧靠三处各自实现的判据**维持（`approval-replay.ts:211` `isError!==true && structuredContent.ok===true`、`mcp-framework/src/server.ts:229/240/254`、provider `fail()`），**没有单一裁决点**。
2. **未知态（E-2）只建了生产面，没建消费面**：`probeError`/`probeErrorCode` 三处"被迫填假值"制造点都在，但契约层为此准备的三个判据函数（`guiAllowed`/`nonGuiAllowed`/`describeSessionState`）**导出后零 src 调用点**；真正的 GUI 门禁内联在 provider 里，把"探测未能得出结论"**直接归为"确不可用"**。
3. **`probeError` 同名异义确证**，且其中一个（`InnerReconnectView.probeError`）是**死判据**（零生产喂入点）——这不是命名瑕疵而是两条独立探针链的观测面被拼到了相似类型上，读者会误以为可对照。
4. **错误码粒度在契约边界上被抹平**：`ExecutedResult.error?: string` 是裸字符串，服务端两处直接塞字面量码（`server.ts:1109`/`1299`）不经 `makeError`，`retryable` 信息在跨通道第一跳就丢失。
5. **审计链完整性问题集中在"审批规模不可观测"**：注册表两个 `size` getter（`pending-approvals.ts:135`、`server.ts:280`）**零运行时消费者**，`/health` 无 `approvals` 块（对照同函数里 `tasks`/`audit`/`security`/`cache`/`logging` 五块齐全）——ENG-01 有界化修完后，"快到顶了"这个运维信号只在 TaskStore 面上补齐了（`tasks.live`/`maxTasks`/`evictedCount`），审批面漏了。

### C-1（P1）未知态生产面完备、消费面缺位：`guiAllowed` 三判据函数零调用

**证据**：

| 项 | 位置 | 事实 |
|---|---|---|
| 判据定义 | `core/src/session/health.ts:64/68/72` | `guiAllowed`/`nonGuiAllowed`/`describeSessionState` 三个导出函数 |
| 再导出 | `core/src/index.ts:66-68` | 对外导出 |
| 全仓 `src` 消费点 | `git grep "guiAllowed\|nonGuiAllowed\|describeSessionState" -- 'packages/**/src/*.ts'` | **仅命中定义/再导出 + 3 处注释**（`contracts/src/bridge.ts:54`、`vm-capabilities/src/index.ts:53`、`vm-service/src/health-probe.ts:16`、`vm-service/src/server.ts:1851`）⇒ **零真实调用点** |
| 实际门禁 | `adapter-agent-workbuddy/src/index.ts:325-336` | 内联判据：`session.state === 'unavailable' \|\| session.state === 'black-screen'` ⇒ `fail(SESSION_UNAVAILABLE / SESSION_BLACK_SCREEN)` |

**关键推论（这是可观测性缺口，不是行为缺陷）**：`health.ts:35-39` 的 `unavailableFallback()` 明确注释"不是『会话不可用』，而是『本次未能得出结论』的 fail-closed 填充"，并为此在 P2-T9 追加 `probeErrorCode:'PROBE_NOT_WIRED'`。但 provider 的内联门禁只看 `state`，**不看 `probeError` 是否在场**。于是：

- VM 会话其实健康、只是 `sessionProbe` 超时（`health-probe.ts:63-67` 填 `state:'unavailable'` + `probeErrorCode:'PROBE_TIMEOUT'`）⇒ GUI 能力返回 `SESSION_UNAVAILABLE`，文案 "GUI 能力需要交互式会话。当前：unavailable"——**把一个探测故障说成会话配置故障**，宿主/运维会被引向错误排查方向（去查会话而不是查 ps-bridge 往返）。
- 同一形状在 `probe()` 未接线时（`health.ts:35-39`，`PROBE_NOT_WIRED`）也会发生。

**为什么是 P1 不是 P2**：PR8 红线明令"GUI 门禁判据一字未改"，所以**收紧行为不是选项**；但**误归因是纯文案/错误码问题**，可以在不改判据的前提下修——`contracts/src/bridge.ts:54` 已经预告"本字段**不得脱离** `probeError` 单飞（两键成对出现）"，说明设计者已备好机读区分，只是没人消费。修法（不违反 PR8）：门禁分支保持拒绝，但当 `session.probeError` 在场时改判错误码为 `SESSION_PROBE_UNKNOWN`（新增契约码）或至少在 `detail` 前缀里落 `probeErrorCode`，让链上条目和宿主文案可区分"探测未知 vs 确不可用"。

**注意判据函数零调用本身还有第二层风险**：`guiAllowed` 的注释（`health.ts:54-62`）用"三重冗余"论证它在 `probeError` 在场时恒 false，这段论证是**给未来消费者看的护栏**。既然无人消费，护栏也就无从生效——若后续有人按字面把 `guiAllowed` 接上，行为等价性靠的是注释里的三重冗余论证而非测试。建议：要么把内联门禁改为调用 `guiAllowed`（收敛到单点，注释护栏才生效），要么删除这三个导出以杜绝"看起来是官方判据"的误导。**当前状态（导出但不用）是最坏的一档。**

### C-2（P1）`probeError` 同名异义 + `InnerReconnectView.probeError` 是死判据

**双定义确证**（逐字比对）：

| 定义 | 语义 | 落点 |
|---|---|---|
| `contracts/src/bridge.ts:56` `SessionHealth.probeError?: string` | 会话子探针**未能得出结论**的原因；纯可观测，门禁不读（:54 自述） | 经 `/health.session` 透出（`server.ts:1978`） |
| `vm-service/src/http-guard.ts:236` `InnerReconnectView.probeError?: string` | 回连探针**输入面**："提供 ⇒ 强制 `unverified`（绝不误判 broken）" | 仅作为 `resolveInnerReconnect` 的入参形状 |

二者语义域完全不同（"未取得结论" vs "已取得结论但不得据此判 broken"），同名会造成跨模块阅读时的语义漂移。这是前棒侦查笔记的预测，现已确证。

**更严重的是死判据面**（新增发现，前棒只怀疑未验）：

- `resolveInnerReconnect(` 全仓**唯一生产调用点** = `server.ts:785-788`，实参只有 `{ authMode, providerOptions }` 两键 ⇒ `probeError`/`probeStatus` 在启动路径**根本没喂**。
- 运行期探针走的是**另一条路**：`server.ts:2066` `const probed = await probeInnerReconnect({...})` ⇒ 返回值类型是 `InnerReconnectHealth`（`http-guard.ts:219`），直接赋给观测面变量 `innerReconnectObserved`（`:790`），**不回灌 `resolveInnerReconnect`**。
- ⇒ `InnerReconnectView.probeError`/`probeStatus` 这条"实证优先覆盖观测面"的判序（`server.ts:773-775` 注释判序③）**在 `resolveInnerReconnect` 内永远不命中**；它的功能是由调用方赋值覆盖实现的，不由这个入参实现。
- 现网唯一喂入者：测试手工构造（前棒记：`phase2-inner-credential:332`）。

**影响**：类型面留了一个"看起来可以喂探针结论"的入参，注释（`http-guard.ts:232-233`："由调用方（server.ts 启动期 fire-and-forget / 探针脚本）回填"）还**承诺了一个从未发生的回填**。后续维护者若按注释去实现"运行期重算 `resolveInnerReconnect`"，会得到与现有覆盖逻辑冲突的第二个真值源（一个靠入参、一个靠变量覆盖）。**建议**：删除 `InnerReconnectView` 的这两个可选键（连带判序 2/3 的死分支），或改为 `resolveInnerReconnect` 接受 `InnerReconnectHealth | undefined` 并让 `:2066` 覆盖走同一函数——收敛到单点。同时在文档里说明"实证优先"目前**只由 `innerReconnectObserved` 赋值实现**。

### C-3（P1）`ExecutedResult.error` 裸字符串抹平错误码粒度 + 两处旁路 `makeError`

**证据**：
- `contracts/src/bridge.ts:358-364`：`ExecutedResult { ok, capabilityId, summary?, data?, error?: string }` —— 与 `SessionHealth`、`HealthStatus` 等相比，**唯一用裸 string 承载错误的契约结构**。无 `code`、无 `retryable`、无 `details`。
- `core/src/errors.ts`：封闭 11 契约码 + `DEFAULT_RETRYABLE` 表（`APPROVAL_REQUIRED: true`），`makeError` 产出带码结构化错误；这是仓库内的"正规"错误通道。
- 旁路：`server.ts:1109`（`PROVIDER_UNAVAILABLE`）与 `server.ts:1299` 直接把**码名当字符串**写进 `error`，不经 `makeError` ⇒ 该值既不是结构化对象、也不是自由文案，而是**混用两种约定的第三种形态**。
- 跨通道传播：`approval-replay.ts:211-216` `toExecutedResult` 从 `structuredContent.error` 里取 `message`（即 `errorField?.['message']`），也就是说服务端 structured 侧**是**有 `{code,message}` 形状的，但 `ExecutedResult` 这一跳把 `code` 丢了（只留 `errorMsg`）。

**影响**：宿主/桥拿到 `ok:false` 后**无法机读判断可否重试**——`APPROVAL_REQUIRED`（可重试，等批准后续跑）与 `SESSION_UNAVAILABLE`（探测未知，重试无意义直至会话确认）与 `PARAM_INVALID`（不可重试）三者都塌成一个字符串。R4/B3 的教训正是"传输层 ok 被当业务成功"；这里是它的镜像——**业务失败被塌成不可归因的文本**。同时 `server.ts:1109/1299` 的混用形态使 grep 码名和读 structured 对象两条排障路径都对不齐。

**建议**（P1，属契约演进，需版本注记）：`ExecutedResult` 追加可选 `errorCode?: string` + `retryable?: boolean`（纯附加，旧读者忽略即可），`toExecutedResult` 从 `errorField['code']` 透传；`server.ts:1109/1299` 两处改走 `makeError` 统一形态。**若不想动契约**，退一步：至少把两处旁路改成自由文案 + 在 structured 里给码，消除"第三种形态"。

### C-4（P2）审批决策两侧口径不一致（维② A-2 第 5 条的可观测面后果）

`server.ts:441` 决议为 true 但 token 已被 TTL 清扫抢先删除 ⇒ 返回值 `{approved:false, reason:'rejected'}`（**宿主拒绝语义**），而链上条目此刻已由 `onApprovalTimeout`/sweep 写成 `decision:'timeout', actor:'mcp-ttl-sweep'`（`server.ts:1611-1624`），且 `O-6` 去重集合已含该 approvalId ⇒ 不会再补第二条。**同一事实在 API 返回面和审计链面上是两个不同的归因**。链面是诚实的（timeout 是真），返回面是失真的（说成 rejected）。K3R 真值层 `ApprovalTruthAttribution.decidedBy` 四值里有 `approval-ttl`/`mcp-ttl-sweep`，说明真值侧能区分——**只有同步返回值不能区分**。建议 `reason` 增 `'expired'`（或复用 `rejected` 但附 `expired:true`），并把这条差异写进 `docs` 口径表。（P2：仅影响调用方文案，不影响安全边界——拒绝是默认方向。）

### C-5（P2）审批规模零观测：`/health` 缺 `approvals` 块，两个 `size` getter 是死代码

| 观测点 | 状态 |
|---|---|
| `PendingApprovalRegistry.size`（`pending-approvals.ts:135`） | 全仓**零运行时消费**（`git grep "decidedSize\|pendingSize"` 仅命中 `server.ts:280` 定义本身） |
| `VmApprovalCoordinator.decidedSize`（`server.ts:280`） | 注释自称"可观测面；不入链"，**零消费者** |
| `/health` 审批块 | `buildHealth` 返回体（`server.ts:1971-2034`）含 `tasks{live,maxTasks,terminalTtlMs,evictedCount}`、`audit{...}`、`security`、`cache`、`logging`、`capabilities`、`session`、`psBridge`、`llmSession` —— **独缺 approvals** |
| 对照已修的同类 | ENG-08/P2-T7 把 TaskStore 有界化事实全部透出（含"已经回收了多少"`evictedCount`，注释明言与链上 `task-evicted` 的 `ext.evict.evictedTotal` **同源互相对账**）；`pendingApprovals.startTimer` 回调（`server.ts:1611`）拿到 `swept` 后**只落链不计数** |

**影响**：`WINVM_APPROVAL_TTL_MS` 缺省 30min，长静默委派会攒令牌；`maxPending` 上限触发时的行为（挤兑/拒绝）此前无信号。ENG-01 有界化把"无界增长"修掉了，但把"快满了"的运维信号也一并留在暗处——这正是 QA §4-B4 给 TaskStore 挑过的同一病灶（驱逐无计数无日志无回调），审批面**同病未同治**。此外 K3R 的 `decidedApprovals`（去重集合）规模完全不可见，而它靠 `pruneDecided(pendingApprovals.keys())` 间接有界——这个有界性若失效（prune 逻辑漏一类 key）在现网**没有任何信号能发现**。

**建议**：`buildHealth` 补 `approvals: { pending: pendingApprovals.size, maxPending, decided: approvalCoordinator.decidedSize, sweptCount, ttlMs }`（纯附加，与 `tasks` 块同一范式）。一行成本，把两个死 getter 变成活判据。

### C-6（P2）host 侧审批留痕为模块级无界内存 Map，不落盘（与旧账 ARCH-09 同族）

`host-a2a-bridge/src/approval-audit.ts`：`hashApprovalPreview` 生成 `previewHash` 并写入宿主侧审计条目，条目存**模块级 `Map`**——无上限、无 TTL、不落盘。进程重启即全部丢失；宿主侧与 VM 侧（审计链有 `verifyChain`/分片归档）**不对称**：一旦宿主审计只在内存，`previewHash` 的跨侧比对能力形同虚设。且服务端侧 `previewHash` 恒为 `''`（无跨侧比对实现）⇒ **旧账 ARCH-09"预览指纹不闭环"仍未清**（详见 §对账表）。建议：宿主 Map 加界（复用 `LedgerRegistry` 的 `maxLive` 范式）或写原始 sink；明确"host 留痕仅供本进程调试、不作证据"并停止在文档里暗示跨侧比对。

### C-7（P2）文档承诺与实现状态的口径漂移（错误语义面）

- `SECURITY-GOVERNANCE.md:109` 登记取消形态 `canceled:true + inFlightMayContinue:true`，而 `tools.ts:664` 的 `replyApproval` 成功返回 `isError:false, ok:true` 且文案 "已批准，VM 侧继续"——在维② A-1 的结论（纯 MCP 直调路径批准位不可达）之下，**A2A 路径的这句文案是唯一真话**，但同一文件里 MCP 路径的对应承诺（`INTERFACES.md:212`）是假的 ⇒ 文档需按通道分别表述，不要并排写。
- `host-a2a-bridge.test.js:180` 钉住"挂起审批不是错误"⇒ `isError:false` 且 `ok:true`（`tools.ts:603`），此时 `state` 为 `input-required` 类、`approval.result:'pending'`。这是**正确的**分层，但对只读 `ok` 的宿主意味着"成功"。仓库里没有任何一处把"ok:true 但业务未生效（挂起）"写成显式警告口径（`tools.ts:693` 只覆盖了 cancel）。建议补 `approval` 态的口径注释，与 cancel 同源。

### 维③ 问题清单

| 编号 | 级别 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| C-1 | **P1** | core/session/health.ts:64/68/72（零调用）+ adapter-agent-workbuddy/src/index.ts:325-336（内联门禁不读 probeError） | 探测未知被误归为"确不可用"，排查方向被带偏；官方判据函数无人消费使注释护栏失效 | 门禁不改判（PR8），但当 `probeError` 在场时改错误码/detail；判据函数要么接上要么删 |
| C-2 | **P1** | contracts/bridge.ts:56 vs http-guard.ts:236；http-guard.ts:232-233 注释承诺的回填从未发生（server.ts:785 唯一调用点两键入参，2066 走覆盖不回灌） | 同名异义跨模块误导；`InnerReconnectView.probeError/probeStatus` 为零喂入死判据，未来按注释实现会造出第二个真值源 | 删两键+死判序，或让覆盖路径复用同一函数；文档说明"实证优先"当前如何实现 |
| C-3 | **P1** | contracts/bridge.ts:358-364 `error?: string`；server.ts:1109/1299 旁路 makeError；approval-replay.ts:211-216 丢 code | 错误码与 retryable 在契约边界被抹平，宿主无法机读区分可重试/不可重试 | 追加 `errorCode`/`retryable` 纯附加；两处旁路改走 makeError |
| C-4 | P2 | server.ts:441 vs 1611-1624 | 同一事实 API 面 `rejected` / 链面 `timeout`，归因不一致 | `reason` 增 `expired`；口径表登记 |
| C-5 | P2 | pending-approvals.ts:135、server.ts:280 零消费；buildHealth 缺 approvals 块 | 审批规模与去重集合规模不可观测，有界性失效时无信号（QA §4-B4 同病未同治） | `/health` 补 `approvals` 块，与 `tasks` 块同范式 |
| C-6 | P2 | host-a2a-bridge/src/approval-audit.ts（模块级 Map）+ 服务端 previewHash 恒 '' | 宿主留痕无界且不落盘，跨侧比对形同虚设；ARCH-09 旧账未清 | Map 加界（仿 LedgerRegistry）或写明"非证据" |
| C-7 | P2 | SECURITY-GOVERNANCE.md:109、tools.ts:603/664/693、INTERFACES.md:212 | "ok:true 但业务挂起"无显式口径；MCP 通道假承诺与 A2A 真文案并排 | 文档按通道分述；补 approval 态口径注释 |

---

## 维④ 长跑健壮性（内存/TTL/隧道/ps-bridge 生命周期）

### 结论先行

1. **内存侧的有界化纪律是真做了**：进程内五个增长容器（审批令牌表、TaskStore、账本注册表、回执缓存、stderr 尾巴）全部有 TTL 或容量上限，且定时器**一律 `unref()`**、关闭路径**幂等**——这一族是仓库的强项，盘点见下表，不重复表扬。
2. **但磁盘侧完全没有治理**：审计链分片按日落文件、`appendFile` 只增不减，全仓（`core/src/audit/` + `delivery/`）**零处保留期/清理/压缩实现**，`verifyArchive(maxShards)` 只是**限数校验**（超上限的分片只计数不校验），不是回收。长跑唯一的确定性增长面就是它。
3. **隧道"永不放弃"是有意选择，但观测面是孤岛**：`maxAttempts` 缺省 `Infinity` ⇒ `giveup` 有序退出路径在生产缺省配置下**不可达**；守护进程写 `tunnel.state.json` 四态状态机，而 `delivery/` 之外**零消费者**（宿主侧 `install-host.mjs`、`packages/**/src` 都不读）——长跑故障最常见的现场（隧道反复 reconnecting）只能靠人肉 cat 文件发现。
4. **ps-bridge 的自愈窗口会放大可用性抖动并归因失真**：握手最长 60s（`WINVM_PSBRIDGE_READY_TIMEOUT_MS`），期间 `running=false` ⇒ 每次能力调用**立即抛 `PROVIDER_UNAVAILABLE`「自愈失败」**，而事实是"自愈正在进行"。
5. **psmod 与子进程生命周期是硬耦合，且无热加载手段**：6 个能力模块在 ps-bridge 启动时 dot-source，`__meta` 只有 `ping`/`listModules` 两个动词，**没有 reload** ⇒ 改任何 `.ps1` 必须重启子进程（进而要么重启服务、要么 `schtasks /Run`）；这是运维路径上的隐式前提，文档未登记。
6. **SSE 订阅没有随客户端断开收尾，优雅关闭不摘连接**：`writeSse` 不监听 `close`，`subscribeStream` 在无事件时进入 **500ms 空转轮询且无停止位**，`close()` 只有 `server.close()`（Node 语义：等活动连接结束）⇒ 一条挂着的 SSE 足以让 SIGTERM 路径上的 `runtime.close()` 无限等待。

### 治理面盘点（亲验，作为改进建议的基准线）

| 容器/资源 | 界 | 回收机制 | 证据 |
|---|---|---|---|
| `PendingApprovalRegistry` | TTL（缺省 30min，`WINVM_APPROVAL_TTL_MS`） | 自续链清扫，间隔 `max(60_000, ttl/4)`，`unref()`，`close()` 幂等判据⑥ | `pending-approvals.ts:205/226-227/251`、`server.ts:1611` |
| ↳ `hostApproved===true` 豁免 | **无上限**（O-10 在途保护） | 靠重放结束 `delete`；重放卡死则永存 | `pending-approvals.ts:32-36`、`server.ts:464` |
| `decidedApprovals` 去重集 | 间接界 | `pruneDecided(pendingApprovals.keys())` 随清扫调用 | `server.ts:268-276/1626` |
| TaskStore | `maxTasks=200`、`terminalTtlMs=1h` | 驱逐 + 链上 `task-evicted` + `evictedCount` 透出 | `task-store.ts:30-32/93-99/699`、`server.ts:2026-2031` |
| ↳ 订阅者集合 | 随任务删除 `subscribers.clear()` | 注释明说防闭包吊住任务对象 | `task-store.ts:635/699` |
| `LedgerRegistry` | `maxLive=64`、`retentionMs=6h` | 按 `startedAtMs` 淘汰最老 + 终态即删 | `delegation-audit.ts:331/342-343/520-522` |
| `ReceiptCache` | `MAX_RECEIPT_ENTRIES=200` | 插入序环形淘汰，不落哈希链（零链体积） | `delegation-audit.ts:66/696-722` |
| ps-bridge stderr 尾巴 | 8KB | `slice(-8192)` | `ps-bridge.ts:171` |
| ps-bridge stdout `buffer` | 行协议自然收缩（按 `\n` 切走） | — | `ps-bridge.ts:321-326` |
| 隧道重连 | 1s×2 指数退避，cap 30s，jitter 0–30%，`_attempt` ready 归零 | 连续 forward 错误达阈值触发重连 | `oh-tunnel.mjs:47-48/554-556/481-482/603-610` |
| 隧道单实例 | pidfile 原子写（tmp→rename）+ `isAlive` 幂等 + 陈旧 pidfile 清理 + state 随 pidfile 派生（D6-A） | SIGINT/SIGTERM shutdown 清 pidfile/state | `tunnel-daemon.mjs:74-79/118-137/181-188` |
| 计划任务实例策略 | `MultipleInstancesPolicy=StopExisting` | `/run` 先停旧再起新，保证重启真生效 | `install-vm.mjs:312-317` |
| ps-bridge 看门狗定时器 | 单实例（`if (!this.heartbeatTimer)`）+ `unref()` | `stop()` 里 `clearInterval` 并置 undefined | `ps-bridge.ts:187-191/489-490` |
| **审计链分片文件** | **无** | **无** | 见 D-1 |

### D-1（P1）审计链分片零保留期治理——长跑唯一确定性无界增长面

**证据**：
- 写入路径：`core/src/audit/chain.ts:337-339` `appendFile(shard, line)`，`shardName()`（`:236`）按日分片（`:178` 取名字中段作 `day`）。
- 全仓搜索**没有任何**保留期实现：`git grep -n "unlinkSync|rmSync|retentionDays|cleanup" -- 'packages/core/src/audit/*.ts' 'delivery/*.mjs'` ⇒ `delivery/install-host.mjs`/`install-vm.mjs` 的 `rmSync` 全是配置/连接文件清理，**与审计目录无关**；`core/src/audit/` **零命中**。
- `verifyArchive(maxShards = ARCHIVE_VERIFY_MAX_SHARDS)`（`:443-452`）是**限数校验**——注释直说"超出上限的分片只计数不校验"，产出 `shardsArchived = shardsTotal − shardsVerified`（`:421-423`）。也就是说：**系统能告诉你有多少分片没验，但不能告诉你有多少分片、占多少磁盘、该留多久**。
- `/health.audit`（`server.ts:1992-2001`）透出 `entries/chainValid/brokenAt/scope/shardsVerified/shardsTotal/shardsArchived`——**全是校验语义，零体积/留存语义**。
- 文档侧：`git grep "留存|retention|保留期" -- 'docs/04-ops/*.md'` **零命中** ⇒ 没有任何一处声明"审计保留 N 天"。

**影响**：这是 VM 内长跑最常见的**磁盘写满**故障源，且后果是**自我加重的**：审计写失败会连带影响取证落链（`recordApprovalDecisionAudit` 的 catch 只 `logger.warn`，`server.ts:255-261`），而磁盘满的典型诱因恰恰是链本身。加上 `ReceiptCache` 被刻意设计成"不落哈希链 → 零体积增长"（`delegation-audit.ts:694-695`），说明设计者**清楚链的体积敏感性**，却没给链自己任何回收手段——这是一个明显的半成品面。

**建议**（不属本次审计范围，只给方向）：①最小成本——`/health.audit` 增 `bytesTotal`/`oldestDay`/`shardCount` 三个纯事实字段 + 运维文档写死一条"保留 N 天，超出自清理"的**约定或告警阈值**；②正式修法——按保留期归档/删除分片，但**必须与 ARCH-06 的 `chain-archive-verify` 跨轮证据口径一起设计**（删片等于删历史证据，需要显式裁定"哈希链是否需要永久留存"，这是产品级决定，不该由实现默默做出）。

### D-2（P1）ps-bridge 自愈窗口内的"快速失败 + 归因失真"

**证据链**：
- 握手成本是真实的大数：`ps-bridge.ts:292-296` 注释以真机取证钉死——"powershell 进程创建 ~10s + psmod dot-source ~6s → 握手 ~16.4s，恒定越过 15s 默认值，看门狗每次 15s kill 重试形成『永远差一点』的自锁循环（**restarts=17 实证**）"。`install-vm.mjs:261/548` 因此把 env 设成 60000。
- 自愈退避窗口只有 3s：`HEAL_BACKOFF_MS = 3_000`（`ps-bridge.ts:115`），看门狗间隔 5s（`:187-190`），而一次 `selfHeal` 内部 `await this.spawnAndReady()` 可阻塞**最长 60s**（`:238-263` → `:154-193`）。
- 期间的对外形态：`call()` 入口 `if (!this.running)` → `selfHeal(...)` → **`restarting` 为真时立即 `return false`**（`:239`）→ 落进 `if (!healed && !this.running) throw new PsBridgeError('PROVIDER_UNAVAILABLE', 'ps-bridge 未就绪且自愈失败' + (lastError ? '：'+lastError : ''))`（`:471-477`）。

**两个问题**：
1. **可用性抖动被放大**：一次子进程崩溃的真实恢复窗口最长 ~60s，而**窗口内每一个能力调用都在几百毫秒内失败**，宿主看到的效果是"服务活着但全能力报 `PROVIDER_UNAVAILABLE`"，而不是"稍等，正在自愈"。这是协作式恢复策略与请求侧等待策略没对齐（没有 `waitForReady` 类语义、没有 `retryAfter` 提示）。
2. **归因失真**：文案是**"自愈失败"**，但此刻自愈**正在进行**（`restarting===true`），`lastError` 是**上一次失败的残值**（成功时置 `undefined`，`:252/278`），甚至可能 `undefined` ⇒ 同一条 `PROVIDER_UNAVAILABLE` 可能表达"从没试过"、"正在试"、"试过且失败"三种完全不同的现场。这与维③ C-1 是同一类病灶：**把未知/在途态塌成确定的失败语义**。
3. 附带：`restarts` 计数器**单调、永不清零**（`:108/251/256/278/283`，`restart()`/`selfHeal()` 两条路径都 `++`），经 `/health.psBridge.restarts`（`server.ts:1932`）透出。设计意图"失败必须计数并暴露，禁止静默"是对的，但**没有窗口化**（无"最近 N 分钟重启次数"），长跑后运维看到一个 47 无法判断是"早就稳了"还是"正在恶化"。对照 `persistent-session.ts:220` 注释——那里对同类计数器专门写明了"度量的是服务生命周期内的首调，运维复位不等于清零"，说明团队有此意识，只是 ps-bridge 面没跟上。

**建议**：①`selfHeal` 在 `restarting` 为真时返回**三态**（成功/失败/**在途**），在途时对外给 `PSBRIDGE_RECOVERING` + `retryAfterMs`，而不是"自愈失败"；②`lastError` 随自愈开始即失效标记（或带时间戳），杜绝残值冒充现因；③`/health.psBridge` 增 `lastRestartAt`（或 `restartsInLast10m`）使单调计数可解释。

### D-3（P1）psmod 与子进程生命周期硬耦合，且无热加载动词

**证据**：
- dot-source 时机：`ps-bridge.ps1:232-243` **启动期**遍历 `$PSScriptRoot/*.ps1`（除自身）并 `. $mod.FullName`，成功记 `$script:LoadedModules[$mod.BaseName]=$true`，失败只 `Write-Diagnostic`（不阻断启动）。注释（`:228-230`）专门解释"必须在脚本作用域 dot-source，函数内 dot-source 的函数函数返回即消失"——这条纪律本身扎实。
- 运行期**不重新加载**：分发路径每次都 `Import-CapabilityModule -Name $module`（`:167`），但该函数首行即 `if ($script:LoadedModules.ContainsKey($Name)) { return $true }`（`:100`）⇒ 命中缓存直接早退，**永不重读磁盘**。
- 无 reload 手段：`Invoke-MetaCapability`（`:111-135`）只有 `ping`、`listModules` 两个分支，其余 `UNKNOWN_META_FUNCTION` ⇒ **既没有 reload、也没有"模块加载失败"的对外可查形态**（`ping` 只回 `loaded = @($script:LoadedModules.Keys)`——**成功集合**，缺席者不点名）。
- 因此改动生效路径只有"重启子进程"，而重启子进程的现实手段是重启服务或 `schtasks /Run`（`StopExisting` 保证真停真起，`install-vm.mjs:312-317`）。

**影响**：①**部署隐性前提未登记**：改 `psmod/*.ps1` 后不重启 = 旧行为继续跑，且**不会有任何报错**（这正是团队最反感的"静默"族）。对一个以"能力即代码"的桥来说，这是可观测性 + 变更生效语义的缺口。②**启动期点源失败被永久化**：某个模块因瞬时原因（文件锁、AV 扫描、更新中拷贝）加载失败，会记为"未加载"直到下次重启——`Get-Command -CommandType Function`（`:172`）找不到函数时的报错形态是"模块已加载但找不到函数"那一族的反面。③`ping` 的 `loaded` 是**白名单语义**，宿主无法区分"没这个模块"和"模块加载失败"。

**建议**：①`__meta` 增 `moduleStatus`（点名缺失/失败模块 + 原因）与 `reload`（清 `LoadedModules` 后重新 dot-source，失败即恢复旧集合，保持 fail-closed）；②在 `INTERFACES.md`/运维文档显式登记"psmod 变更需重启 vm-service（或 schtasks /Run）生效"，并把这条挂到 `install-vm` 的输出提示里。

### D-4（P2）隧道"永不放弃"与状态文件孤岛

**证据与判读**：
- `oh-tunnel.mjs:170` `maxAttempts = raw.maxAttempts != null ? Number(raw.maxAttempts) : Infinity` ⇒ 缺省永不放弃；`giveup` 有序退出（`:537-546`：写 `attempts`/`lastError`/`reason` 后置 STOPPED）在缺省配置下**代码可达但条件永假**。
- 这不是遗漏而是**待裁定的设计选择**：`docs/design/tunnel-crash-fix-progress.md:153` 原文"原 `maxAttempts` 默认 Infinity（永不放弃，符合『默认持续』语义）。修复保留该默认，仅当显式给上限时才会触发 giveup……**若主理人希望默认也设上限（如 30 次），请裁定**" ⇒ **旧账未清的开放项**（本次审计确认：仍未裁定，缺省仍是 Infinity）。
- 退避本身没问题：`delay=min(30_000, 1_000×2^(n-1))` + `jitter=random()*delay*0.3`（`:554-556`）⇒ 稳态每 ~30–39s 一次尝试，不会风暴；`ready` 时 `_attempt` 归零（`:481`）⇒ 长连接不会被历史失败拖高退避。**这一段是正确实现。**
- **真正的缺口是观测面**：`tunnel-daemon.mjs:235-247` 把 `ready/close/reconnecting/reconnected/error` 全部落成 `tunnel.state.json` 四态（STARTING/RUNNING/DEGRADED/STOPPING/STOPPED），但 `git grep -rn "tunnel\.state|\.state\.json" -- 'delivery/install-host.mjs' 'packages' 'docs/04-ops'` ⇒ **packages 与宿主安装器零消费者**（只有 `delivery/__tests__/probe-daemon-error.mjs` 读）。VM 侧 `/health` 的 `security.innerReconnect` 是**服务自连自检**，不反映宿主↔VM 的 18443 隧道健康 ⇒ **隧道是长跑中最容易坏、又最没有健康面的一环**。宿主侧工具只能报 `TUNNEL_UNAVAILABLE`（`tools.ts:659/711/765`）而不说"隧道进程活着但在重连第 N 次"。

**建议**：①`host-a2a-bridge` 的 `clientProvider.get()` 失败路径读取并透传 `tunnel.state.json` 的 `lastEvent/attempts/lastError`（纯诊断增量），把"TUNNEL_UNAVAILABLE"升级为"隧道在 DEGRADED，第 N 次重连，原因 X"；②`maxAttempts` 的裁定结果写进配置注释（现 `delivery/vm-service.config.json` 无该键 ⇒ 无人知道默认是什么）。

### D-5（P2）O-10 在途豁免叠加"令牌表无容量上限"⇒ 卡死重放永久驻留

**证据**：`pending-approvals.ts:32-36` 明写"`sweepExpired` **跳过** `hostApproved === true` 的条目——重放是有界的 `await`，误删会打断真实执行"；而该注册表**只有 TTL 界、没有容量界**（构造入参仅 `{ttlMs, logger}`，`server.ts:946-949`；文件内 `git grep "evict|prune|cap|limit"` 零命中容量语义）。

**推论**：整个有界性证明依赖一个前提——**"重放是有界的 await"**。但重放体就是 `executeCapability`（`server.ts:1157+`，同一条走 provider/ps-bridge 的路径），而 ps-bridge 侧一次 `call` 在自愈窗口里最长可阻塞 60s（D-2），provider 侧无统一外层超时。若某个重放**永不 settle**（PS 侧僵死 + `heartbeatTimer` 恰好因 `restarting` 早退不介入，`ps-bridge.ts:210/239/267`），则该 token：
- **永不被 TTL 清扫**（O-10 豁免），
- **永不 `delete`**（`server.ts:464` 在 `await` 之后），
- 连带 `decidedApprovals` 中对应项**永不被 prune**（`pruneDecided` 以 `pendingApprovals.keys()` 为活集，`:268-276`）。

⇒ **一张卡死审批 = 一处永久内存驻留 + 一处永久去重项**，且现网**没有任何信号**（`/health` 无 approvals 块，C-5）。多个卡死即慢性泄漏，且 `size` 不可见所以完全静默。这是"有界化看似完备、实则依赖一个未证明的前提"的典型。

**建议**（保持 O-10 语义不破坏）：①豁免加**二次上限**——`hostApproved===true` 的 token 记录 `approvedAtMs`，超过 `max(ttl, REPLAY_HARD_LIMIT)`（如 2×ttl）仍豁免即强制逐出并落 `timeout`/`expired-inflight` 决策（这比永久驻留更诚实：它至少说明"重放未在界内 settle"）；②`raise` 的 `await this.replay(token)` 包一层超时（`Promise.race`，超时→ `executed.ok=false` + `error:'REPLAY_TIMEOUT'`，同时保留"VM 内可能仍在执行"口径，与 `ps-bridge.ts:371-372`/`canceledError` 的 `inFlightMayContinue` 同族）；③C-5 的 `/health.approvals` 增 `oldestPendingAgeMs`、`inFlightCount`。

### D-6（P2）SSE 生成器无停止位 + 优雅关闭不摘连接

**证据**：
- `subscribeStream`（`a2a-framework/src/server.ts:546-585`）事件队列为空时 `await new Promise(r => { notify = r; setTimeout(r, 500).unref?.() })` ⇒ **固定 500ms 空转轮询**，循环外**没有取消标志**（`closed` 只由收到 `final` 状态事件置真）；`finally { unsubscribe() }` 只在 `return`/`throw` 时跑。
- `writeSse`（`vm-service/src/server.ts:1823-1840`）`for await` 直写 `res`，**不监听 `req`/`res` 的 `close` 事件** ⇒ 客户端（宿主经隧道）断开后，Node 不会自动让生成器 `return`，生成器继续空转；直到任务出现 `final` 事件才 break。若订阅的是一个**已经不会再有 final 的任务**（例如任务已被驱逐/清理，`task-store.ts:699` `subscribers.clear()`），则该循环**永久 500ms 空转**。
- `close()`（`server.ts:2111-2125`）顺序为 `serviceClosed=true → sessionMonitor.stop() → pendingApprovals.close() → provider.shutdown() → bridge.stop() → server.close(cb)`。`http.Server.close()` 的 Node 语义是**停止监听并等待现有连接结束**；全仓 `git grep "closeAllConnections|closeIdleConnections"` 在 `vm-service/src/server.ts` **零命中**（唯一 `destroy()` 是 `:498` 请求体超限） ⇒ 挂着 SSE 时 `close()` 永不 settle ⇒ `cli.ts:238-244` 的 `shutdown()` 停在 `await runtime.close()`，`process.exit(0)` 到不了，logger 缓冲不刷盘。
- 现实缓解：`install-vm.mjs:317` 的 `StopExisting` + `schtasks /End`（`:218`）会由调度器强杀，`tunnel-daemon` 的 SIGTERM 路径（`tunnel-daemon.mjs:181-188`）自己写了 state 清理——**所以现场表现为"关闭慢/被强杀"而不是"永久挂死"**，但服务侧 `logger.close()` 刷盘与 pidfile 清理这类收尾动作是否发生，取决于谁先赢。

**影响**：①长跑面：每个"订阅后掉线且任务无 final"的 SSE 留下一个 500ms 空转闭包（CPU 底噪 + 队列数组滞留 `queue` 内未消费事件，直到任务删除才随 `subscribers.clear()` 断链，但**生成器自己仍持有 `queue` 引用**，故该任务的 `A2AStreamEvent` 数组不会随任务删除而释放）。②退出面：优雅关闭不可靠，日志末段可能丢失（与 `cli.ts` 的"优雅关闭"文案不符）。

**建议**：①`writeSse` 里 `req.on('close', () => { it.return?.() })`（或 `AbortController` + 生成器内 `if (signal.aborted) break`）；②给 `subscribeStream` 加空闲上限（连续 N 轮空转且任务已终态则 break）；③`close()` 用 `server.close()` + `server.closeAllConnections?.()`（Node 18.2+）双保险，避免收尾依赖外部强杀。

### 维④ 问题清单

| 编号 | 级别 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| D-1 | **P1** | core/audit/chain.ts:337-339（只增）/443-452（限数≠回收）；`/health.audit` 无体积字段；docs/04-ops 零 retention | 磁盘无界增长→写满后连带取证落链失败；无留存口径可依 | 先补 `bytesTotal/oldestDay` 事实字段 + 运维留存约定；删片须与 ARCH-06 跨轮证据一并裁定 |
| D-2 | **P1** | ps-bridge.ts:115/239-240/471-477/292-296 | 自愈窗口内所有调用快速失败且文案"自愈失败"（实为在途，lastError 残值冒充现因）；restarts 单调不可解释 | selfHeal 三态返回 + `PSBRIDGE_RECOVERING`/`retryAfterMs`；restarts 窗口化 |
| D-3 | **P1** | ps-bridge.ps1:100/232-243/111-135 | psmod 变更不重启即静默不生效；启动期加载失败被永久化；ping 只报成功集合不点名失败 | `__meta` 增 moduleStatus/reload；文档登记"改 psmod 须重启服务" |
| D-4 | P2 | oh-tunnel.mjs:170/537-546；tunnel-daemon.mjs:235-247；packages 零消费 | 缺省 giveup 不可达（**待裁定旧账未清**：tunnel-crash-fix-progress.md:153）；隧道健康面为孤岛 | host 侧失败路径透传 tunnel.state；maxAttempts 缺省结果写进配置注释 |
| D-5 | P2 | pending-approvals.ts:32-36 + server.ts:946/464 + pruneDecided | 重放不 settle ⇒ token+去重项永久驻留，且无任何信号（依赖"重放有界"这一未证明前提） | 豁免二次上限 + replay 外层超时 + `/health.approvals.inFlightCount/oldestPendingAgeMs` |
| D-6 | P2 | a2a-framework/server.ts:546-585；vm-service/server.ts:1823-1840/2111-2125 | SSE 客户端断开后 500ms 空转永不停止 + 事件数组滞留；优雅关闭不摘连接，`process.exit(0)`/`logger.close()` 可能到不了 | `req.on('close')→it.return()`；空闲上限；`closeAllConnections()` |

---

## 维⑤ 双通道对等性与 provider 抽象

### 结论先行

1. **"同一能力经 MCP 或 A2A 调用，风险分级、白名单、审批、审计完全一致"（`ARCHITECTURE.md:165`）这句话在实现上站不住**：两通道**都**以 `/mcp` 为唯一执行入口（委派内层回连也是 `/mcp?dtid=`，`server.ts:1213+`），差别只在"谁替宿主行使批准权"。而**替宿主批准的能力只有 A2A 通道有**（`approval.reply` 只挂在 `/a2a`），于是"完全一致"在审批维度上其实是"MCP 通道缺整个批准面"（维② A-1）。
2. **本次审计最重的新发现是一个"最小权限宣称链断裂"（E-1，P0）**：宿主在 `a2a.delegate` 上能填 `allowedCapabilities`/`maxRisk`、文档把它们写成安全机制（`SECURITY-GOVERNANCE.md:53`、`SPEC-SKILLS.md:124-125`、`DEPLOYMENT.md:279`"需审批 + 宿主显式 `maxRisk` 授权"），但**这两个字段没有任何一条执行路径消费**——三处 `policy.evaluate` 生产调用点（`server.ts:1060`、`server.ts:1229`、`adapter-agent-workbuddy/src/index.ts:295`）都不传 `maxRisk`/`allowedCapabilities`，`a2a-framework` 里 `maxRisk` 只做透传与记账，provider 的 `GoalRequest.allowedCapabilities` 只用于模板选择。2026-10-08 旧审计 §3.2-1 讨论的是"maxRisk 只有 A2A 侧传入、MCP 直调不受约束"——**该前提今天已不成立（A2A 侧也不传了）**，属旧账失效 + 新 P0。
3. **provider SPI 只声明"能做什么"（`declareCapabilities`），不声明"怎么做安全"**：批准位、审批续跑协议、真值反查、审批灰度指纹都是 provider 的**自愿实现细节**，SPI 无一约束 ⇒ 换 provider = 换安全等级，而**对外零信号**。
4. **hermes 的"静默安全掉档"根因是 SPI 缺 capability-negotiation，不是 `--yolo` 本身**：`--yolo` 只是关掉了 VM 内 CLI 自己的审批提示；真正的掉档在于 `HermesAgentProvider` 从不 `setApprovalCoordinator`（全文件 0 处 `approval`）、不传 `probe`/`allowedCapabilities`/`maxRisk`/`taskId` ⇒ 走 hermes 时**既不会挂起 input-required、也没有真值反查**，而宿主看到的工具面与走 workbuddy-llm 时**完全一样**（三 provider `declareCapabilities()` 返回值**逐字相同**：`['meta.*','system.*','app.*','storage.*','gui.*','appops.*']`）。
5. **进度三要素里"进度"在 MCP 侧结构性缺失**（维②已记 A-5）；**取消**在两侧对齐得较好（同一 `req.signal` 消费面，`adapter-agent-workbuddy/src/index.ts:503-508` 注释自证）；**审批**是唯一的严重不对等面。

### E-1（P0）`allowedCapabilities` / `maxRisk` 最小权限宣称在整条执行链上没有消费者

**宣称面（宿主与文档都以为它在生效）**：

| 宣称 | 位置 |
|---|---|
| 工具入参 `allowedCapabilities`（"本次委派允许的能力范围"）、`maxRisk`（"本次委派允许的最高风险，默认 L1"） | `host-a2a-bridge/src/tools.ts:368/373`，且 `:400-404/:428-430` 真实读取并放入请求 metadata |
| "委派携带 allowedCapabilities + maxRisk" | `docs/02-design/SECURITY-GOVERNANCE.md:53` |
| "最小权限：委派时通过 allowedCapabilities 限定本次可用能力" / "风险上限：委派时通过 maxRisk 限定（默认 L1）" | `docs/02-design/SPEC-SKILLS.md:124-125` |
| "L3 … 需审批 + **宿主显式 `maxRisk` 授权**" | `docs/05-peripherals/DEPLOYMENT.md:279` |
| 示例请求体带 `"allowedCapabilities": ["app.*","system.process.*"], "maxRisk": "L1"` | `docs/02-design/INTERFACES.md:195-196`、`docs/05-peripherals/SCENARIOS.md:144-145/210-211` |
| 契约字段存在且注释为"最小权限" | `contracts/src/bridge.ts:434-437`（GoalRequest）、`:673-676`（PolicyEvaluateInput） |

**实现面（亲验，逐跳）**：

1. **框架收下但不执行**：`a2a-framework/src/server.ts:265-270`（`tasks/send`）与 `:511-513`（流式入口）把 metadata 里的 `allowedCapabilities`/`maxRisk` 抄进 `GoalRequest`；`git grep -rn "maxRisk" packages/a2a-framework/src/task-store.ts` ⇒ **零命中**；`defaultMaxRisk`（`server.ts:92/126/134`）**只被用来填 `GoalRequest.maxRisk` 这一个默认值**，框架自身不做任何风险判定；`handler:runGoal`（`vm-service/src/server.ts:1533-1544`）原样转发。
2. **策略引擎的两个闸从未被生产喂入**：`engine.ts:758-771`（`req.maxRisk !== undefined && risk ≥ L2 && maxRisk < risk` ⇒ `POLICY_DENIED`）与 `:602-615`（`allowedCapabilities` 非空且不含该能力 ⇒ `POLICY_DENIED`）——**生产代码里唯一的三个 `policy.evaluate` 调用点**：
   - `server.ts:1060-1067`（重放段 `executeCapability`）实参 `capabilityId/params/risk/approved/approvalId/capabilityPolicy`，**无 maxRisk/allowedCapabilities**；
   - `server.ts:1229-1236`（MCP handler 审批闸）同上，**无**；
   - `adapter-agent-workbuddy/src/index.ts:295-301`（provider 内联策略）同上，**无**。
   ⇒ 两个分支的**唯一喂入者是单元测试**（`tests/unit/policy.test.js:239-248/273-282` 手工传 `maxRisk:'L1'`）。测试全绿、引擎正确、**但链路上没人调用**——这是典型的"单元完备、集成断链"。
3. **provider 侧同样只用于模板门**：确定性 provider 的 `this.allowed(goal, capId)`（`index.ts:754-759`）只用来决定**是否尝试某模板**（不匹配就落到下一个模板/`UNSUPPORTED_GOAL`），不是能力级门禁；LLM provider 的 `goal.maxRisk` 一路透传后，**唯一真实消费者是审计展示**——`bridge.ts:1526`/`:1825` 把它当 `GoalStep.risk` 的缺省值写进 steps（即"上报的风险等级"），以及 `server.ts:1387/1450` 写进 delegation 审计条目。`allowedCapabilities` 在 LLM 路径上更是**只进审计**（同两处），执行面无人消费。
4. **委派内层回连（`/mcp?dtid=`）也不带最小权限**：`server.ts:1229` 那次评估没有 maxRisk 输入，而 CLI 在 VM 内能调到**任意暴露能力**（`exposedIds` 全量），不受"本次委派允许范围"约束 ⇒ 委派的最小权限与内层能力面之间**没有任何交集约束**（除 provider 自己传不传 `allowed`，而那只有模板门作用）。

**为什么定 P0**：这不是"少一个便利特性"，而是**对外安全契约的假承诺**。三处文档 + 一个工具入参 schema + 一个示例体共同告诉宿主"你可以把这次授权收窄到 L1/某些域"，宿主照做后**行为不变**：`storage.file.delete`(L2) 在 `maxRisk:'L1'` 的委派里依旧只被审批闸拦（可被批准），而不是被硬拒；若宿主以为"我给了 L1 所以删除类不可能发生"而放宽人工审批习惯，就是**用假安全换真风险**。按本团队的分级口径——"对外宣称的闸实际不存在"= P0（与维② A-1 同一族：能力宣称断裂）。

**与前棒的衔接（非重复）**：前棒（棒 1）维① 的 §3.2-1 记录的是**旧代码事实**"maxRisk 只有 A2A 侧传入，MCP 直调不受约束"，并判定"符合 ADR 精神、只是文档未披露"。**今天的实际是两侧都不传**——旧结论的**前提已失效**（我核对了 `engine.ts` 行号迁移：旧文 `:578/:412-611` → 现 `:752-772`，语义未变但消费点归零）。因此本报告不把它当旧账重复，而是登记为**旧账失效 + 升级后的新 P0**。

**建议（三选一，按成本排序）**：
① 最小诚实化：`tools.ts:368/373` 描述、`SECURITY-GOVERNANCE.md:53`、`SPEC-SKILLS.md:124-125`、`DEPLOYMENT.md:279`、`INTERFACES.md:195` 全部改口径为"仅审计记账，不作强制"；契约注释加"当前无执行消费者"警示。**不建议**长期停在此档（等于把已宣称的闸永久降级为记账）。
② 补最小接线（推荐）：委派进入时把 `(maxRisk, allowedCapabilities)` 随 delegation 上下文登记（`server.ts` 已有 `pendingApprovals` 的 `delegationId` 归因范式与 `ledgerReg.begin(...)`，扩展同构；`GoalRequest.traceId` 即键），三处 `policy.evaluate` 按 `dtid`/`delegationId` 查表回填这两参——与现有 K-N1 通道 2 精确归因**同一条链路**，不需要新契约字段。
③ 结构性修法：把最小权限并入 `McpRequestContext`（`buildMcpRequestContext(dtid, signal)`，`server.ts:1213` 调用点），使 `ToolContext` 天然携带本次 scope，handler 传给 evaluate。**注意**：`ExecutionSegment.verdict?: PolicyVerdict`（`server.ts:1038`，注释"由调用方传入，避免二次评估漂移"）只有 `:1347` 一个生产者、`:1190` 段不带 ⇒ 一旦接线，重放段与 handler 段必须同口径回填，否则把"漂移"从"都不查"变成"一段查一段不查"（后者更难诊断）。
**风险提醒**：补接线后 L2/L3 能力在 `maxRisk:'L1'`（宿主工具缺省值，`host-a2a-bridge/cli.ts:64`）的委派里会被硬拒 ⇒ 现有委派类目标的行为会收紧，需要灰度开关 + 文档同步；这是**必要的收紧**，但要按团队的变更纪律来。

### E-2（P0→P1 判读，最终记 **P1**）确定性 provider 的 A2A 审批半区不可达（且 MCP 半区正常）

**现场**：`runGoal` 的 `step()` 咽喉点恒传 `approved: false`（`adapter-agent-workbuddy/src/index.ts:498`），provider 内联策略随后（`:295`）。对 L0/L1 能力放行；对 L2/L3 命中 `engine.ts:795` 的审批闸 ⇒ `verdict.error = APPROVAL_REQUIRED` ⇒ `fail()` ⇒ 模板把它当失败收口（如模板 1 `goalFail(...)` `:559`；`allowed()` 只门模板选择，不产生审批语义）。

**关键差异（这是判读核心）**：同一段 L2 能力**走 MCP 直调是能挂起审批的**——`server.ts:1238-1239` 命中 `verdict.requiresApproval` 后 `pendingApprovals.set(...)`（`:1242`，含 `hostApproved:false`/`preview`/`impact`/`underlying`/`delegationId`）+ `recordBlockedApprovalAudit`（`:1267`）+ 返回 `structuredContent.approval.{approvalId, resumeHint}`（`:1296-1303`）。也就是说：
- 确定性 provider **经 MCP 暴露面**（宿主直调 / VM 内 CLI 回连 `/mcp?dtid=`）时，审批链**完整可用**（拦截、留痕、回执、（灰度 off 时）`__approvalId` 续跑）；
- 确定性 provider **经 `provider.runGoal` 直接执行**时，跳过服务端审批闸，L2/L3 **既不执行也不挂起，只报失败**。

**影响分级**：因为方向是 fail-closed（绝不放行高危），且**缺省 provider 正是 `workbuddy-deterministic`**（`core/src/config/index.ts:167`），后果是：用缺省配置做 A2A 委派时，凡触及 L2/L3 的目标都注定失败且不提示"需审批"这一真实原因（`GoalStep.error` 里有 APPROVAL_REQUIRED 码，`templateError` 保留，但宿主文案是"搜索失败：…"/"安装失败：…"式的模板措辞）。**这是可用性/文案面问题而非安全破口** ⇒ 记 **P1**（我明确不同意把它写成 P0；它和 A-1/E-1 的"假承诺"性质不同）。

**建议**：`step()` 收口时对 `error.code === 'APPROVAL_REQUIRED'` 走专门分支——不 `goalFail`，而是 `sink.onStatus('input-required'?...)`/返回带 `APPROVAL_REQUIRED` 的 `GoalResult`（`bridge.ts:1201` 同款判据：`base.error?.code === 'APPROVAL_REQUIRED'`），让框架层（或宿主文案层）知道"这是等待审批而不是失败"；确定性 provider 若确认不支持委派内审批，就在 `runGoal` 入口直接对"目标可能触发 L2+"给出前置说明，别让它跑到一半静默失败。

### 三 provider 能力/行为差集（亲验；`declareCapabilities()` 三家逐字相同，差集全在行为面）

| 行为面 | workbuddy-deterministic | workbuddy-llm（`adapter-agent-workbuddy-llm`） | hermes-agent | 证据 |
|---|---|---|---|---|
| 审批协调器接线 | 不需要（不走 raise） | `if (ctx.approvalCoordinator) this.bridge.setApprovalCoordinator?.(...)` | **全文件零 `approval` 命中 ⇒ 从不接线** | `adapter-agent-workbuddy-llm/src/index.ts:274-276`；`git grep -in "approval" packages/adapter-agent-hermes/src/index.ts` ⇒ 空 |
| 委派内审批挂起 | 不可达（E-2） | 可达（`maybeResume`→`raise`→input-required，`bridge.ts:1232`） | **不可达**（coordinator undefined ⇒ `bridge.ts:1202` `if (!blocked \|\| !this.coordinator) return base`） | 同左 |
| K5 服务端重放 | 不适用 | 支持（`reconcileExecutionTruth` `:1275`） | **无调用点**（`runGoalInner` 在 llm 文件里；hermes 只调 `this.bridge.runGoal` ⇒ 其实会走同一 `CliLlmBridge`，但 **taskId/probe 不传** ⇒ 见下两行） | `adapter-agent-hermes/src/index.ts:185-196` |
| `GoalRequest.taskId` 透传 | — | 透传（`index.ts:460`） | **不传** ⇒ `beginTask('')`、审批挂接退化共享 `activeTaskId`（维② A-3 同源） | `adapter-agent-hermes/src/index.ts:185-196` vs llm `:458-465` |
| `probe`（委派账本/未决审批反查）透传 | — | 透传（`index.ts:466`） | **不传** ⇒ `reconcileDelegationTruth` 门 3 退场（`delegation-truth.ts:322`：`typeof approvalWait !== 'function'` → 回退文本兜底），**K3R 结构化真值层对 hermes 整条不生效** | `bridge.ts:1040-1045`（依赖 `input.probe`）；hermes 未提供 |
| `maxRisk`/`allowedCapabilities` 透传 | 用于模板门 | 透传给桥（仅记账/展示） | **不传** | 同 E-1 |
| CLI 审批提示 | 不适用 | codebuddy 常驻会话（受 prompt 纪律约束，`bridge.ts:491-496`） | `--yolo`（跳过 hermes 自身危险命令审批） | `adapter-agent-hermes/src/index.ts:38/46` |
| `approvalTruth` 健康指纹 | 无 | `health()` 透出（`/health.providerApprovalTruth`，`server.ts:1979`） | `health()` 只覆写 `provider.state`，**不透出** ⇒ 该 provider 在用时，`/health` 的真值三态字段静默缺席 | `adapter-agent-hermes/src/index.ts:153-167` |
| 目标理解能力 | 5 个正则模板，未匹配即 `UNSUPPORTED_GOAL`（`:665-678`） | LLM 自主规划 | LLM（hermes CLI）自主规划 | `index.ts:553-678` |

**E-3（P1）"静默安全掉档"的根因是 SPI 缺 capability-negotiation，不是 `--yolo`**：
- `BridgeContext.approvalCoordinator?: ApprovalCoordinator`（`contracts/src/bridge.ts:751-753`）是**可选注入**，provider 用不用**无任何对外表达面**；`AgentServiceProvider` 的必填成员只有 `declareCapabilities/init/execute/runGoal/health/shutdown`（`:770-780`），SPI **没有任何"我是否支持委派内审批 / 是否实现真值反查 / CLI 是否自带审批"的声明位**。
- 三 provider 的 `declareCapabilities()` 返回值**逐字相同** ⇒ 宿主无法从能力面区分；`/health.provider.approvalTruth` 只在 llm provider 存在（hermes 的 `health()` 不透出）⇒ 连健康面也不提示。
- `provider.kind` 只用于一处优化：`server.ts:672` `if (provider.kind === 'llm-agent') void provider.warmup?.()`。`ProviderKind` 枚举（`contracts/src/bridge.ts:766`）被当成"是否 LLM"用，**没被当成安全能力协商面用**。
- 结论：把 `--yolo` 单独当问题修（比如禁掉这个参数）既不能修好（hermes 非交互遇审批会永久挂起，`:38` 注释自陈这是**非交互必须**），也不能防止下一个 provider 以同样方式掉档。**要修的是 SPI**：给 `AgentServiceProvider` 增可选 `securityProfile?`（例如 `{ inDelegationApproval: boolean; truthReconciliation: boolean; cliSelfApproval: 'none'|'host-delegated'|'bypassed' }`），`loadProvider` 后与服务端策略求校：`bypassed` 或 `inDelegationApproval:false` 时**在服务端 fail-closed**（对 L2+ 一律要求 MCP 通道审批或直接拒），并把结论透出到 `/health.provider`。这样"换 provider 换安全等级"至少变成**可见、可判定、可拒启**的事实，而不是运维事后发现。

### E-4（P2）双通道审批续跑协议不统一 + `verdict` 复用面不完整

- **两套续跑协议**：MCP 用工具入参 `__approvalId`（`server.ts:1213` 解构、`:1361` instructions 说明），A2A 用 `a2a.approval.reply`（`a2a-framework/src/server.ts:301` → `task-store.ts:550`）。二者语义、幂等性、失败返回形状都不同；`skills/winvm-mcp-reference/SKILL.md:213` 给的续跑指引跨通道混用。叠加维② A-1（缺省 replay=on 时 `__approvalId` 为死字段），**当前 MCP 侧续跑协议事实上不可用而文档仍教它**。建议：A2A 为唯一审批续跑通道，MCP 侧要么补 `/approvals/reply`，要么删除 `__approvalId` 宣称（与 A-1 同一裁定）。
- **`ExecutionSegment.verdict` 只有一个生产者**（`:1347`；`:1190` 的重放段不带）⇒ 同一次调用可能被评估两次（handler 一次 + executeCapability 一次）或一次，取决于走哪条路；两处输入完全相同所以当前等价，但**这个"复用避免漂移"的设计只覆盖了一半路径**。E-1 修法②落地时必须两处同时补 scope，否则漂移面扩大。

### E-5（P2）K3R 能力面过滤形同虚设：`q.capabilities` 喂的是全平台目录

`ApprovalWaitQuery.capabilities` 注释（`contracts/src/bridge.ts:858-862`）明确"非空 ⇒ 只认落在能力面的未决审批（R3 收窄串台）"；`collectApprovalFacts` 确实在 R3 分支 `caps.has(entry.capabilityId)` 过滤（`approval-replay.ts:367`）。但喂入值是 `input.capabilities`（`delegation-truth.ts:331-334`），而 provider 构造 `catalog = this.ctx.capabilities.list()` 后装入 input（`adapter-agent-workbuddy-llm/src/index.ts:441` → `:453`；hermes 同形 `:177` → `:188`）——`ctx.capabilities` 注入的是**整个注册表**（`server.ts:599 capabilities: registry`），`registry.list()` 返回**全部已注册能力**（`core/src/registry/capability-registry.ts:56-58`），**不是**本次委派的能力面。⇒ R3 的能力过滤恒等于"全部通过"，**串台收窄实际未生效**（好在 R1/R2 的 `delegationId` 精确排除仍有效，常驻路径 dtid 不生效时才落到 R3）。注释与契约意图（`allowedCapabilities`）不一致；一旦 E-1 修法落地，应把 `q.capabilities` 改喂 `goal.allowedCapabilities`。

### 维⑤ 问题清单

| 编号 | 级别 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| **E-1** | **P0** | tools.ts:368-430 → a2a-framework/server.ts:265-270/511-513（仅透传）→ server.ts:1060/1229 + provider:295（三处 evaluate **均不传**）；engine.ts:602-615/752-772 唯一喂入者为测试；文档 SECURITY-GOVERNANCE:53 / SPEC-SKILLS:124-125 / DEPLOYMENT:279 / INTERFACES:195 | 宿主可填、被记账、但**不生效**的最小权限——对外安全契约假承诺；旧审计 §3.2-1 前提已失效（两侧都不传） | 推荐修法②：委派上下文登记 scope，三处 evaluate 按 dtid 回填（复用 K-N1 归因链）；两处评估必须同补（E-4）；灰度+文档同步 |
| E-2 | P1 | adapter-agent-workbuddy/src/index.ts:498（恒 false）vs server.ts:1238-1266（MCP 半区完好）；缺省 provider=config/index.ts:167 | 缺省配置下 A2A 委派遇 L2/L3 注定失败，且文案归因到"执行失败"而非"需审批" | step() 对 APPROVAL_REQUIRED 专分支；或入口声明"本 provider 不支持委派内审批" |
| E-3 | P1 | contracts/bridge.ts:751-753（coordinator 可选）+ :770-780（SPI 无安全声明位）+ 三 provider declareCapabilities 逐字相同 + hermes 全文件 approval 零命中 + hermes health() 不透出 approvalTruth | 换 provider=换安全等级且**无任何对外信号**；hermes `--yolo` 只是表象，SPI 缺 capability-negotiation 是根因 | SPI 增 `securityProfile?`；loadProvider 后与服务端策略求校（bypassed ⇒ L2+ fail-closed）+ 透出 /health |
| E-4 | P2 | server.ts:1213/1361 vs a2a-framework/server.ts:301→task-store.ts:550；ExecutionSegment.verdict 仅 :1347 一个生产者 | 双通道两套续跑协议，MCP 侧当前不可用而 skills 文档仍教；漂移防护只覆盖一半路径 | 裁定 A2A 为唯一审批续跑通道；verdict 两处同补 |
| E-5 | P2 | delegation-truth.ts:331-334 ← llm/index.ts:442 ← server.ts:599（registry）← registry/capability-registry.ts:56 | K3R R3 能力面过滤恒全通过，串台收窄未生效（R1/R2 仍有效） | `q.capabilities` 改喂 `goal.allowedCapabilities`（与 E-1 修法一并做） |

---

## 6. 前棒侦查笔记逐条对账（`audit-arch-timeline.log` 20:30:44 行六条，全部 git grep 亲验）

| # | 棒 1 笔记原文（要点） | 亲验结论 | 消化去向 / 是否照抄 |
|---|---|---|---|
| 1 | "K3 兜底（G-a/b/c 已由 P2-T8 闭环，残余=措辞面诚实登记）" | **部分采纳，表述需修正**。G-a（归属键扩为 `taskId ?? traceId`）与 G-b（归因事实写 `ctx.approvalTruth`）确已在 `bridge.ts:955-958/1040-1045`、`delegation-truth.ts:300-345` 落地，闭环成立。但"残余只在措辞面"不准确：**存在活性残余**——`q.capabilities` 喂的是全平台注册表面（`llm/index.ts:441→:453`，`ctx.capabilities`=整 registry，`server.ts:599`），使 R3 的能力收窄恒真通过。这是实现缺口不是文案缺口 | 维⑤ **E-5**（P2）。**未照抄**，且对该条结论做了修正 |
| 2 | "approval-replay 早退 4 处零审计（PROVIDER_UNAVAILABLE×2 / CAPABILITY_NOT_EXPOSED / UNKNOWN_CAPABILITY），replay 拒绝对照 S-4 同类缺口" | **采纳并扩容为 5 处**。四处逐一复核成立（`server.ts:1161-1168`、`:1169-1177`、`:1103-1112` 重放段、`:1534` 区 provider 缺席）。新增第 5 处笔记未含：`raise` 的 `no-active-task` 早退（`server.ts:351-363`）仅 `logger.warn`，链上零条目；另发现"`server.ts:441` token 已被 TTL 抢先 ⇒ 返回 `rejected` 而链上已记 `timeout`"的**两侧口径错位**（笔记未涉） | 维② **A-2**（表列 5 条）+ 维③ **C-4**。**未照抄**，扩容 + 新增 |
| 3 | "probeError 同名异义实锤（语义对偶非冲突）" | **确证同名异义；"语义对偶非冲突"需修正**。两处定义复核无误（`contracts/bridge.ts:56` vs `http-guard.ts:236`）。但"非冲突"只覆盖了命名面，**没覆盖活性面**：`InnerReconnectView.probeError/probeStatus` **零生产喂入点**（`resolveInnerReconnect(` 全仓唯一调用 `server.ts:785` 只传两键；运行期探针 `:2066` 返回 `InnerReconnectHealth` 直接赋观测变量，不回灌），且注释（`http-guard.ts:232-233`）承诺"由调用方回填"**从未发生** ⇒ 死判据 + 虚假注释承诺 | 维③ **C-2**（P1）。**修正前棒表述**（与棒 2 的 ⓪-b 分歧登记一致：活性面按本条升 P1，改名面可保留"不改"） |
| 4 | "dead-config 核心面已闭环" | **不完全成立**。TTL 死旋钮（120s）确已删（`pending-approvals.ts:16-19` 自陈 P2-T2 删除）。但本棒新查出**两处"写了没接"的活性缺口**属同族：①审批规模零观测——两个 `size` getter 零消费者 + `/health` 无 `approvals` 块（同函数 `tasks/audit/security/cache/logging` 齐全）；②**`maxRisk`/`allowedCapabilities` 全链路无执行消费者**（三处 evaluate 均不传，唯一喂入者是测试），而五处文档/工具 schema 把它们写成安全机制。后者按团队分级是 P0 | 维③ **C-5** + 维⑤ **E-1（P0）**。**修正前棒"已闭环"结论** |
| 5 | "E-1 度量落地零数据，restartFresh 不清 firstCall 口径已文档化" | **采纳，并发现同源新面**。`persistent-session.ts:220` 确实把"restartFresh 不清零 firstCall"写成明文口径（已登记，不算债）。但 **ps-bridge 侧同类计数器无此口径说明**：`restarts` 单调永不清零（`ps-bridge.ts:108/251/256/278/283`）且经 `/health.psBridge.restarts` 透出，无窗口化、无"重启后计数含义"注释 ⇒ 长跑后可读性比 LLM 会话面更差 | 维④ **D-2**（第 3 点）。**未照抄**，做同族延伸 |
| 6 | "restartFresh（管理端点 → llmSessionReset → restartFresh）" | **采纳并复核链路**：`/admin/llm-session/reset`（`server.ts:1789`）→ `bridge.ts:1077-1081` → `persistent-session.ts:988`，链路存在且唯一。补充：该端点是**全服务唯一的运维复位入口**，ps-bridge 无对应端点（改 psmod 只能重启服务，见维⑤/维④ D-3） | 维④ **D-3** 建议段引用。**未照抄**，作对称性延伸 |

### 6-b. 与棒 2（`audit-arch2.md`，其维②–⑦与本棒②–⑤重叠）的去重登记

棒 2 在其 ⓪-b 节（22:45 补）登记了与本棒的交叉。本棒侧确认如下，供主理人合并：

| 主题 | 关系 | 处置 |
|---|---|---|
| 早退零审计（本棒 A-2 / 棒 2 的 2.b） | **同一缺陷**，棒 2 亦含 `raise` no-active-task 一条 | 合并为一条；本棒多出的 `server.ts:441` 口径错位（本棒 C-4）棒 2 未覆盖，保留为独立 P2 |
| `probeError`（本棒 C-2 / 棒 2 的 2.e） | **实质分歧已由棒 2 自我让位**（其建议"按棒 3 的活性结论升 P1，命名结论保留不改名"） | 采纳棒 2 的处置：活性面 P1（本棒 C-2），改名不做 |
| 取消链（本棒维②"扎实+两小口子" / 棒 2 的 4.8 R-5 并发取消放大重建风暴） | **不矛盾、必须并列**（棒 2 原话）——本棒审单笔取消语义正确性，棒 2 审并发资源放大 | 合并时并列，勿互相覆盖 |
| 隧道 giveup/`maxAttempts`（本棒 D-4 / 棒 2 的 4.7 真机归因） | 互补：本棒给"缺省 Infinity + state 文件零消费者"的代码面结论，棒 2 给现网死因归因 | 合并为一条，取两者证据 |
| psmod 版本漂移（棒 2 的 4.5+）与本棒 D-3（psmod 生命周期硬耦合/无 reload） | **不同侧面**：棒 2 审"无内容指纹"，本棒审"改动必须重启 + 加载失败被永久化 + `__meta` 无 reload/moduleStatus" | 两条并列，不合并 |
| **本棒独占**（棒 1/棒 2 均未覆盖） | **E-1（P0，maxRisk/allowedCapabilities 全链无消费者）**、A-1（P0，hostApproved 可达性 + `__approvalId` 缺省死字段）、C-1（guiAllowed 三判据零调用）、C-3（ExecutedResult.error 裸串抹码）、D-1（审计链零保留期治理）、D-2（自愈窗口快速失败+归因失真）、D-5（O-10 豁免叠加无容量界）、D-6（SSE 无停止位/关闭不摘连接）、E-2（确定性 provider 审批半区）、E-3（SPI 无 capability-negotiation）、E-5（K3R R3 能力过滤虚设） | 其中 **E-1 是本报告唯一由"旧审计前提失效"升级出的新 P0**，建议主理人优先裁定 |

---

## 7. 架构维 Top 问题汇总（四维合并，按裁定优先级排序）

| 序 | 编号 | 级别 | 一句话 | 证据锚点 | 建议处置（裁定项） |
|---|---|---|---|---|---|
| 1 | **A-1** | **P0** | `hostApproved` 在纯 MCP 直调下无任何宿主可达路径置真；缺省 `replay=on` 时 `__approvalId` 续跑为死字段，而三处文档/SKILL 仍承诺可用 | `server.ts:424/464/1227/348`、`bridge.ts:1232`、`index.ts:275`、`a2a-framework/server.ts:301`、`INTERFACES.md:212`、`skills/winvm-mcp-reference:213` | **三选一裁定**：①诚实化（文档改口径）②补 `/approvals/reply` 端点③明确 A2A-only。先做①+文档同步，②③由主理人裁定 |
| 2 | **E-1** | **P0** | `allowedCapabilities`/`maxRisk` 是宿主可填、链上记账、但**执行面零消费者**的最小权限假承诺（旧审计"仅 MCP 不传"前提已失效） | 三处 evaluate 实参（`server.ts:1060/1229`、`provider:295`）均无两参；`engine.ts:602-615/752-772` 唯一喂入者 `tests/unit/policy.test.js:239/273`；宣称面 5 处（SECURITY:53/SPEC-SKILLS:124-125/DEPLOYMENT:279/INTERFACES:195/tools.ts:368-373） | 推荐"委派上下文登记 scope + 按 dtid 回填三处 evaluate"（复用 K-N1 归因链，无新契约字段）；须带灰度（缺省 maxRisk=L1 会收紧现网） |
| 3 | A-2 | P1 | replay 三早退 + provider 缺席 + `raise` no-active-task 共 5 处"批了但没动静"零链上证据；修法现成（S-4 同类已修） | `server.ts:1161/1169/1103/351/441`；对照 `:1075/1313` + `approval-replay.ts:151` | 复用 `recordApprovalDecisionAudit`（`actor:'replay-guard'`）或新增 `recordReplayRejectedAudit`；写原始 sink（O-7） |
| 4 | C-1 | P1 | 探测未知被误归为"确不可用"；契约层三个官方判据函数导出后**零调用**，注释护栏无从生效 | `core/session/health.ts:64/68/72`（零 src 消费）vs `adapter-agent-workbuddy/src/index.ts:325-336`（内联只看 `state`）；`health-probe.ts:63-67`（PROBE_TIMEOUT） | 门禁不改判（PR8 红线）；`probeError` 在场时改错误码/detail；三函数**要么接上要么删**（导出不用是最坏档） |
| 5 | C-2 | P1 | `probeError` 同名异义 + `InnerReconnectView.probeError/probeStatus` 为零喂入死判据，注释还承诺从未发生的回填 | `contracts/bridge.ts:56` vs `http-guard.ts:236`；`server.ts:785`（两键实参）/`:2066`（覆盖不回灌） | 删两键+死判序，或让覆盖路径复用同一函数；文档说明"实证优先"当前如何实现 |
| 6 | C-3 | P1 | `ExecutedResult.error` 裸字符串抹掉错误码/可重试性；两处旁路 `makeError` 造出"第三种形态" | `contracts/bridge.ts:358-364`；`server.ts:1109/1299`；`approval-replay.ts:211-216`（丢 code） | 追加 `errorCode`/`retryable` 纯附加 + 旁路改走 `makeError` |
| 7 | E-2 | P1 | 缺省 provider 的 A2A 审批半区不可达（L2/L3 既不执行也不挂起，文案归因"执行失败"）；MCP 半区完好 | `adapter-agent-workbuddy/src/index.ts:498`（恒 false）vs `server.ts:1238-1303`（完整挂起+留痕）；缺省 provider `config/index.ts:167` | `step()` 对 `APPROVAL_REQUIRED` 专分支（判据同 `bridge.ts:1201`）；或入口声明不支持委派内审批 |
| 8 | E-3 | P1 | SPI 无 capability-negotiation ⇒ 换 provider=换安全等级且对外零信号（hermes `--yolo` 只是表象：不接 coordinator、不传 probe/taskId/maxRisk、health 不透 approvalTruth，而三家 `declareCapabilities` 逐字相同） | `contracts/bridge.ts:751-753/770-780`；三家 `declareCapabilities`（hermes:124 / llm:249 / det:236）；`hermes/index.ts:185-196`（input 缺四项）；`bridge.ts:1202`（无 coordinator 即透传） | SPI 增 `securityProfile?`；`loadProvider` 后与服务端策略求校（bypassed ⇒ L2+ fail-closed）+ 透出 `/health.provider` |
| 9 | D-1 | P1 | 审计链分片只增不减，全仓零保留期实现；`/health.audit` 无体积字段、docs 无留存口径；磁盘写满会反向打断取证落链（自我加重） | `core/audit/chain.ts:337-339/443-452`；`git grep retentionDays/cleanup/unlink` 在 audit 目录零命中；对照 `delegation-audit.ts:694-695`（设计者明知链体积敏感） | 先补事实字段（`bytesTotal/oldestDay/shardCount`）+ 留存约定；删片须与 ARCH-06 跨轮证据一并裁定（产品级决定） |
| 10 | D-2 | P1 | 自愈窗口（最长 60s）内每个调用快速失败且文案"自愈失败"（实为在途），`lastError` 残值冒充现因；`restarts` 单调无窗口 | `ps-bridge.ts:115/239-240/471-477/292-296`（真机 restarts=17 自锁史）；`server.ts:1932` | `selfHeal` 三态返回 + `PSBRIDGE_RECOVERING`/`retryAfterMs`；`restarts` 窗口化 |
| 11 | D-3 | P1 | psmod 与子进程硬耦合且**无 reload 动词**：改 `.ps1` 不重启即静默不生效；启动期加载失败被永久化；`ping.loaded` 只报成功集不点名失败 | `ps-bridge.ps1:100`（命中即早退）/`:232-243`（启动期 dot-source）/`:111-135`（`__meta` 仅 ping+listModules） | `__meta` 增 `moduleStatus`/`reload`；文档登记"改 psmod 须重启服务/schtasks /Run" |
| 12 | D-6 | P2 | SSE 客户端断开后生成器 500ms 空转无停止位；`close()` 不摘连接 ⇒ 优雅关闭可被一条挂着的 SSE 永久卡住（现场表现"被强杀"，`logger.close()` 未必执行） | `a2a-framework/server.ts:546-585`；`server.ts:1823-1840`（不监听 close）/`:2111-2125`（无 `closeAllConnections`）；`cli.ts:238-244` | `req.on('close')→it.return()`；空闲上限；`server.closeAllConnections?.()` |
| 13 | D-5 | P2 | O-10 在途豁免 + 令牌表无容量界 ⇒ 重放不 settle 即永久驻留（token + 去重项），且零信号；有界性依赖"重放是有界 await"这一未证明前提 | `pending-approvals.ts:32-36`；`server.ts:946-949`（无容量参）/`:464`/`:268-276` | 豁免二次上限 + `replay` 外层超时 + `/health.approvals.inFlightCount/oldestPendingAgeMs` |
| 14 | C-4/C-5/C-6 | P2 | 审批三处可观测/一致性小面：API 面 `rejected` vs 链面 `timeout`；`/health` 缺 `approvals` 块（两个 size getter 死代码）；host 审批留痕无界 Map 不落盘 + `previewHash` 恒 `''`（**ARCH-09 旧账未清**） | `server.ts:441` vs `:1611-1624`；`pending-approvals.ts:135`、`server.ts:280`、`buildHealth:1971-2034`；`host-a2a-bridge/approval-audit.ts`；旧审计 ARCH-09 | 补 `expired` 归因；补 `approvals` 块；ARCH-09 按旧建议落地（登记时算、执行时重算比对） |
| 15 | E-4/E-5 | P2 | 双通道两套审批续跑协议（MCP 侧当前不可用而 SKILL 仍教）；K3R R3 能力过滤喂全平台目录 ⇒ 收窄虚设 | `server.ts:1213/1361` vs `a2a-framework/server.ts:301→task-store.ts:550`；`delegation-truth.ts:331-334` ← `llm/index.ts:441→:453` ← `server.ts:599` ← `capability-registry.ts:56` | 裁定 A2A 为唯一审批续跑通道；`q.capabilities` 改喂 `goal.allowedCapabilities`（与 E-1 同批） |

**分级合计（维②–⑤，共 23 条）**：P0 **2**（A-1、E-1）｜P1 **9**（A-2、C-1、C-2、C-3、D-1、D-2、D-3、E-2、E-3）｜P2 **12**（A-3、A-4、A-5、C-4、C-5、C-6、C-7、D-4、D-5、D-6、E-4、E-5）。
**按维计数（P0/P1/P2）**：维② 1/1/3 ＝ 5｜维③ 0/3/4 ＝ 7｜维④ 0/3/3 ＝ 6｜维⑤ 1/2/2 ＝ 5。
上表按"裁定优先级"取前 15 项展示，未列入 Top 表的 8 条 P2（A-3/A-4/A-5/C-4/C-7/D-4 及 C-5/C-6 的合并行余下部分）详见各维问题清单原表。

**两条 P0 的共同性质**（供裁定参考）：都不是"实现写坏了"，而是**"对外宣称的闸在实现里不存在"**——A-1 是批准位不可达但文档教续跑，E-1 是最小权限可填但不生效。这类问题的危害不在故障率，而在**使用者据以做安全假设**。两者修法都涉及"诚实化 vs 补齐"的路线选择，属主理人裁定项，不宜由实现默默选边。
