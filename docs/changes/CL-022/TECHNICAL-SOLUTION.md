# CL-022 · 技术方案（TECHNICAL-SOLUTION）

> 对应 `REQUIREMENT.md`。按 **A 取消贯通链 / B 信任边界与鉴权 / C 策略收紧与命令面清理 / D 审计范围与凭据通路 / E 执行体消费与宿主呈现** 五组，给出设计要点、关键代码锚点、数据流、风险与回滚、可复跑验证命令。
> 行号锚点为**本批工作区实测值**（`git diff --numstat` 口径），后续变更集若产生漂移以锚文本而非行号为准。
> 实施过程与偏差登记的权威载体是 `docs/changes/phase1-t1-notes.md` … `phase1-t5-notes.md`（偏差号 D-1 … D-38 连续）；本文只沉淀**终局结论**。

---

## 0. 总览：五组改动在架构中的位置

```
宿主（WorkBuddy）
  │  MCP 工具面：a2a.delegate / a2a.task.cancel / --token-env
  ▼
[E] host-a2a-bridge   ← 两态文案 + executedBeforeCancel + cancelObserved
  │  A2A client（经 SSH 隧道，凭据通路 applyBearerHeader 单实现）
  ▼
[B/D] vm-service      ← createBearerGuard（双条件挂载）/ 审批三态入链 / authMode 三态 / archive-verify
  │  框架回调注入（DelegationObserver / bypassTagSink / noteTimeout）
  ▼
[A] a2a-framework     ← cancelController（O-1 abort 先于 updateStatus）+ addArtifact 终态守卫 + O-2 收口三不 + 有界驱逐
  │  ProgressSink.isCancelled?() / cancellationSignal?
  ▼
[E] adapter-agent-workbuddy（确定性 step() 咽喉）/ adapter-agent-workbuddy-llm（turn 边界 + abortActiveTurn + 子进程 kill）
  │  CapabilityRequest
  ▼
[C] core/policy       ← %ENV% 模式侧展开 + 六条白名单 + 删除命令白名单读取
    core/audit        ← scope/shards* + verifyArchive()
    core/transport    ← applyBearerHeader 三态（两条远程分支唯一实现）
```

**横切纪律（五组共用，写进代码注释与守卫）**：纯附加可选铁律（缺席=逐字旧行为）、取证面与执行面分离（O-5）、锚点不可动（`engine.ts:769-778` 切片、`freshChainOnStart:true`）、依赖方向不可逆（框架不得 import `vm-service`）。

---

## A 项 · 协作式真取消贯通（T1 契约 / T3 框架 / T4 证据 / T5 消费）

### A.1 三层职责切分（谁都不能越层）

| 层 | 事实源 | 只做什么 | 绝不做 |
|---|---|---|---|
| 契约（`contracts/src/bridge.ts:401/410`） | — | 定义 `isCancelled?(): boolean` + `cancellationSignal?: AbortSignal`（纯附加） | 不定义"取消如何执行" |
| 框架（`a2a-framework/src/task-store.ts:80/242/276/311`） | `InternalTask.cancelController`（**唯一主干**） | `requestCancel`：置标志 → `updateStatus('canceled')` → **`abort('canceled')`**；`addArtifact` 终态返 `false` 不 emit；`createProgressSink` 透出两成员（同源） | 不 import 服务端、不写审计 |
| 框架（`a2a-framework/src/server.ts:380-382/412-414`） | `tasks.isCancelled(id)` | O-2 取消收口：**不落 artifacts（含 steps 载体）、不 updateStatus、不写 `goalSummary/stepCount`**，只 `observe({state:'canceled', result})`；catch 分支已取消**不改判 failed** | 不替 provider 补记产物 |
| 服务端（`vm-service/src/delegation-audit.ts`） | observer 三分支（O-3） | 取消终态入链 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'`（可与 failed/rejected 区分） | 不为取证引入可挂死 IO |
| 执行体（T5，见 E 项） | `sink.isCancelled?.() === true` | 在**每一次能力调用边界**消费；打断常驻 CLI 子进程 | 不自行判定"是否该取消" |

### A.2 顺序纪律 O-1 / O-4 的实现理由（不是风格问题）

- **O-1（abort 先于 updateStatus）**：若先置 `canceled` 再 abort，provider 在 `updateStatus` 与 `abort` 之间读到的是「已 canceled 但 signal 未 aborted」⇒ 轮询面（`isCancelled`）与事件面（`signal`）短暂不一致；订阅 `cancellationSignal` 的执行体会漏掉这次取消。二者同处一个同步体，真被读到说明存在绕过 `requestCancel` 的写路径（防御性冗余判据已写入 `task-store.ts:592-597` 注释）。
- **O-4（`canceled > timeout > rejected`）**：超时与取消可并发发生（宿主点取消的同时 deadline 到）。若判成 timeout，链上就留下"超时"这条**不实**结论；`canceled` 是更强的用户意志事实，优先级必须在最前。

### A.3 有界化（ENG-08）与取消的耦合点

`TaskStore` 的 `maxTasks` / `terminalTtlMs` 驱逐**只删终态最旧者**，活动任务与 `input-required` 挂起审批任务必留；`maxTasks:0/undefined` ⇒ 完全不驱逐（既有测试逐字绿）。这条纪律对取消的意义：被取消的任务进入终态后**才可**被驱逐 ⇒ 若在 `requestCancel` 里顺手清 artifacts，就会与"取消前既有内容保留"冲突。故取消收口分支刻意**不清**任何东西（T3 移交第 7 条）。

### A.4 `TASK_CANCELED` 的语义位（为什么必须新造一个码而不是复用 `EXECUTION_FAILED`）

```ts
// adapter-agent-workbuddy-llm/src/index.ts:437-442（shouldDegrade，本批只消费不改写）
PROVIDER_UNAVAILABLE  → 降级到确定性执行器
EXECUTION_FAILED && artifacts.length === 0 → 降级到确定性执行器
```

用 `EXECUTION_FAILED` 收口取消 ⇒ 恰好命中第二条 ⇒ **把用户已经叫停的任务再执行一遍**。这不是错误分类偏好，而是安全性要求。守卫用两条用例把它钉成**非恒真**断言：桥回 `TASK_CANCELED` ⇒ 确定性执行器零调用；同形状但回 `EXECUTION_FAILED` ⇒ 确实重跑（对照组）。

---

## B 项 · 信任边界与鉴权（T1 配置 / T4 挂载 / 文档 ARCH-07）

### B.1 三态 `authMode` 与守卫生效判据**同源**

| `authMode` | 触发条件 | 守卫 |
|---|---|---|
| `loopback-only` | `enforceBearer` 缺席或 `false` | 不挂载（默认部署的真实形态） |
| `bearer-enforced` | `enforceBearer===true` **且** `tokenEnv` 有值（**O-9 双条件**） | 挂载，非豁免端点要求正确 token |
| `bearer-configured-missing` | `enforceBearer===true` 且 `tokenEnv` **有名无值** | 不挂载 + 显式显形 |

同源实现 = 两处都走同一 `resolveBearerToken()`，杜绝"health 说已强制、守卫其实停用"的自相矛盾。刻意不新增 `AUTH_REQUIRED` 到 `BridgeErrorCode` 枚举（鉴权发生在 HTTP 守卫层，不进能力调用契约的错误面）。

### B.2 `createBearerGuard`（`vm-service/src/http-guard.ts`，新纯模块）

设计约束逐条：① **可脱 ps-bridge 单测**（纯函数 + 注入）；② 常时比较用 `node:crypto.timingSafeEqual`，**长度不等先拒**（否则 `timingSafeEqual` 抛，`http-guard.ts:100-109`）；③ 豁免端点：`/health`、agent-card；④ 非豁免：`/mcp`、`/a2a`、`/admin/llm-session/reset`。

### B.3 回环约束不可关（**B-3 破坏性**）

`validateServiceConfig`：`bind` 非回环 ⇒ **恒 error**（启动被拒）；`security.requireLoopbackBind=false` ⇒ 只额外产生一条 warning，**不再降级该 error**。理由与风险权衡写在 `SECURITY-GOVERNANCE.md §2.1` 第 2 条（配置可漂移成"对外裸 HTTP"会使第 0 层网络隔离整体消失，其风险远大于少一层 bearer 的收益）。

### B.4 VM 内回连凭据通路 = 本批**刻意不做**（**R4 中危残留**）

`buildMcpConfig()`（`adapter-agent-workbuddy-llm/src/bridge.ts:159-175`）下发给 VM 内 agent CLI 的 `mcpServers` 条目回连本服务 `/mcp?dtid=…`，**不含凭据**。故误开 `enforceBearer` ⇒ VM 内回连全 401。⚠ 失败形态已由 B3 真机演练（2026-10-10）实测订正：不是"委派主链路当场 401"，而是 401 打在**工具面** ⇒ LLM 无工具可用仍"口头收尾"⇒ 委派退化为**零副作用的虚假完成**（终态 `completed` + 链上 `zeroInnerCalls:true`「完成声称不予采信」，CL-K3R 真值层兜住）；宿主不带凭据发起则 HTTP 层当场 401（该段 fail-loud 成立）。本批动作**只有两项**：源码处注释登记启用前置条件；SECURITY §2.1/§6.1、ARCHITECTURE §7/§10、DEPLOYMENT §8.1 三处文档写黑。宿主侧 `--token-env` 只覆盖"宿主→服务"这一段，覆盖不到"VM 内→服务"这一段 —— 这是两条通路，别混。

---

## C 项 · 策略收紧与命令面清理（T2，**B-1 / B-2 破坏性**）

### C.1 `%ENV%` 模式侧运行时展开（ARCH-17 的实现要点）

展开落在**策略引擎侧**（`core/policy/engine.ts` 的 `expandPolicyPathPattern`），不在默认值里拼用户名：用户名是部署期事实，硬编码必然漂移。判定链 = 先展开 → 再归一（`normalizePath`）→ 再 `globToRegex`，与 config 层的 `audit` / `log` / `outputDir` 共用同一份 `expandEnvPath`（下沉到 `core/src/constants.ts`，config 改为再导出）。

**fail-closed 方向**：env 缺席 ⇒ 占位符保持字面原样 ⇒ 该条目永不匹配 ⇒ 绝对路径一律 DENY。⇒ 非 Windows / 离线测试环境只会更严，不会误放（这也是为什么单测要用 `HOME` 注入或直测纯函数来构造 ALLOW）。

四处比对点都要包（`:536`/`:537`/`:594-595`/`:638-639`）——漏一处就会出现"写路径按展开判定、读路径按字面判定"的分裂。附带缺陷修复：`appops.cli.invoke` 的 `outputDir: %USERPROFILE%\...` 此前因模式未展开而**恒不匹配**。

### C.2 收紧后 16 处夹具红的归因（判因纪律范例）

设计 §1.5-3 预告"凡以 `C:\Users\` 断言 ALLOW 的用例需复核"。落地首跑出现 **2 文件 / 16 处**红，逐条归因结论：红的是**夹具前提**（旧用例隐含假设"Users 树内 ⇒ 白名单内"），**不是**策略行为错。适配口径两份文件统一，未放宽任何判定断言（新基线同时补 3 条跨账户 DENY + 3 条 `%USERPROFILE%` ALLOW 判据）。

### C.3 `commandAllowlist` 四处同批删除（ARCH-18）

| 位置 | 动作 |
|---|---|
| `contracts/src/capability.ts` | 删 `CapabilityPolicy.commandAllowlist`（不留 `@deprecated`） |
| `contracts/schemas/capability.schema.json` | 删属性；`policy.additionalProperties === false` ⇒ 旧配置写该键被**直接拒绝**（非静默忽略） |
| `core/src/policy/defaults.ts` | 删 `PolicyConfig` 字段 + `DEFAULT_POLICY.commandAllowlist: []` + `mergePolicy` union 行 |
| `core/src/policy/engine.ts` | 删 `cmdAllowRe` 声明与编译点（引擎**从未读取**该字段，grep 实证见 `phase1-t1-notes.md` §34-44） |

三条删除理由（写进注释）：① 引擎从未读取（死配置）；② 全仓唯一写入点（`appops.workflow.run` 的 9 个解释器正则）已同批移除；③ 命令面真实边界 = `commandDenylist` + 风险/审批闸。解释器准入改建为 `appops.cli.invoke` 的 `input.app` 枚举 + 登记期 `validateParams`（**早于执行**）。

⚠ **R9 风险面如实记录**：该 schema 当前**无任何运行期校验器消费**（全仓仅 `setup-env.test.js` 断言"随行资产存在"）⇒ `additionalProperties:false` 的拒止能力尚未在运行路径兑现。已登记为 Phase 2 死配置/漂移清扫项（`phase1-t1-notes.md` D-3）。

---

## D 项 · 审计范围机器可读 + 客户端凭据通路（T2 / T4，ARCH-06 / ENG-23）

### D.1 `verifyChain()` 加范围、**不改判定**

`ChainVerification` 纯附加 `scope` / `shardsVerified` / `shardsTotal` / `shardsArchived` 四字段；`valid` 与断裂位置的判定与旧版**逐字一致**（判据：加字段前后同一批断言不动仍绿）。freshChain ⇒ `scope:'session'`，否则 `'full'`。

序列化纪律踩坑记录：`canonicalJson` 会把显式 `undefined` 序列化成 `null`，而 `JSON.stringify` 会丢键 ⇒ 曾经造成**假断链**。因此新字段一律条件展开 `...(x ? { … } : {})`。

### D.2 `verifyArchive()`（跨轮证据的唯一通路）

| 约束 | 实现口径 |
|---|---|
| 只校**片内** | `verifyShardIntraChain(shard)`：片内基线取**本片首条**（`expectedPrev = first.hash`、`lastSeq = first.seq`），**不比对跨片首条 prevHash**（历史片彼此无链关系，与本轮新片也无关系 ⇒ 比对必然全红） |
| 首条自洽性**单独查一次** | 否则"只改首条内容"要拖到第二条才显形 |
| 有界 | `ARCHIVE_VERIFY_MAX_SHARDS = 30`，超出只计入 `shardsTotal` 不逐片重算（O-5：不得为取证引入可挂死 IO） |
| 绝不抛 | 读不到分片 ⇒ 该片 `valid:false, reason:'UNREADABLE:<code>'`（事实而非异常）；全程 `try/catch` |
| 证据落链 | 服务启动 fire-and-forget 一条 `ext.kind:'chain-archive-verify'`（含 `shardsTotal/shardsVerified/brokenAt`），运维据此告警：`brokenAt` 非空即须取证 |

真机已抓到一条历史断裂片（`audit-20260918`，`390c5da` 归档）⇒ 该通路不是"写了没验证"的死代码。

### D.3 `applyBearerHeader` 三态（两条远程分支唯一实现）

```ts
applyBearerHeader(headers, tokenEnv, env = process.env): Headers
// ① 无 tokenEnv ⇒ 原样返回（不加头，逐字旧行为）
// ② 有值       ⇒ authorization: Bearer <value>
// ③ 有名无值   ⇒ 抛 TransportError（fail-loud，绝不静默降级成无凭据请求）
```
**时序修正（T2 D-11）**：ssh-tunnel 分支的凭据校验**前置到建隧道之前** —— 否则先起隧道再报"缺 token"，会留下一个无人认领的隧道进程 + 错误归因（运维看到的是隧道异常而非配置错误）。两条分支共用同一实现以避免漂移。

---

## E 项 · 执行体消费 + 宿主呈现 + 客户端 CLI（T5，判据①②③④）

### E.1 确定性执行体：`step()` 咽喉 + 双闸分叉

`packages/adapter-agent-workbuddy/src/index.ts` `runGoal()` 内：

```ts
const step = async (capabilityId, params, summary) => {
  if (sink.isCancelled?.() === true) return { ok:false, canceled:true, error:'任务已取消，未发起该能力调用' };   // 入口闸（唯一咽喉）
  const res = await this.execute({ … });
  steps.push({ … });                                          // 已真实发生 ⇒ 一律记账
  if (sink.isCancelled?.() === true) {                        // 出口闸（执行期间被取消）
    for (const a of res.artifacts ?? []) artifacts.push(a);   // ★ 本地如实收纳（不得抹痕）
    return { ok: res.ok, canceled: true, data: res.data, … }; // ★ 不外推
  }
  for (const a of res.artifacts ?? []) { artifacts.push(a); sink.onArtifact(a); }
  return { ok: res.ok, data: res.data, … };
};
```

| 设计决策 | 理由 |
|---|---|
| 取消判定插在 `this.execute` **之前** | 五个目标模板全部经此函数 ⇒「取消后零新能力调用」这一安全性质在**一处**成立，模板无需重复判定（只需把哨兵转成收口形状） |
| **入口 + 出口**双次判定（**D-31**，设计只写入口） | 长能力调用（如 winget 安装）跑到一半被宿主叫停时，若不在出口收口，模板会继续判断并走 `goalFail` ⇒ 返回 `EXECUTION_FAILED` ⇒ 触发 A.4 的降级重跑 |
| 返回值新增**纯附加可选** `canceled` 哨兵 | 不改既有 `{ok,data,error}` 形状；模板 `if (r.canceled) return canceledReturn();` |
| 收口走新私有 `goalCanceled()`（`TASK_CANCELED`）而非 `goalFail()`（`EXECUTION_FAILED`） | A.4 安全红线；`goalFail()` 语义**刻意不改**（既有失败路径原码保持，避免与 T2/T3 既有断言冲突） |
| 双闸**分叉**：本地 `artifacts` 收纳、`sink.onArtifact` 关死（**D-37**，主理人裁定修正） | 框架 O-2 决定 canceled 不落链 ⇒ 流出面为 0 正确；但 `task.artifacts` 不会替 provider 补记，而宿主文案计数与 QA 反查**唯一可读的事实源**是 `GoalResult.artifacts`（T3 移交第 7 条亦注明 observer 快照里 `result` **在场**）⇒ 收口时清空本地集＝把"确实产出了这份产物"从账上删除。两个数**不等**是设计意图 |

### E.2 LLM 常驻路径：turn 边界轮询 + 事件驱动打断

`bridge.ts` `runPersistent()`：入口前置闸（不碰会话：不新建、不复活、不注入新一轮）→ `turnSink.onStatus` 轮询取消（命中即 `session.abortActiveTurn(...)` + 置 `turnAborted`，**且打断后的状态上报一律不转发宿主** —— canceled 终态下继续流出 `working` 进度属观测面失真）→ `cancellationSignal` 订阅（与轮询**互补**：真机 CLI 思考期可长时间不上报状态，单靠轮询会拖延到下一个事件；监听在 `finally` 摘除 —— 常驻会话跨委派复用，残留监听会把后续任务的取消误打到已结束轮次）。

`canceledResult()` 三条纪律：① 码必 `TASK_CANCELED`；② **绝不返回 `{ unavailable }`** 形状（会被 `runGoalCore` 当"常驻不可用"回退单次 `-p` ⇒ 等于取消后再跑一遍）；③ `artifacts/steps` 返回空数组 —— 取消收口**不做新的磁盘扫描**（O-5 边界）。

### E.3 `abortActiveTurn`（`persistent-session.ts`）：三步顺序 + 一条重建红线

```
① turnAbortedByCancel = true   // 新私有标志，每轮开始处清零
② activeAbort?.(reason)        // 复用既有钩子（execTurn / warmup 各挂一次），零新状态语义
③ killChild()                  // ★ 取消的实质：只 resolve promise 而留 CLI 活着 ⇒ VM 内 agent 继续自行发起工具调用
```
- `killChild` 先清 `child` 引用 ⇒ 后续 exit 事件被 `wasAlive=false` 门卫拦截 ⇒ 取消**不会**被记成 `lastError`（取消不是故障，不污染 `/health` 历史信号面）。
- 无在飞轮次 ⇒ 返回 `false` 且**不动子进程**（空闲期杀进程属无谓抖动，且会误伤预热）。
- **重建红线**：既有「不可用 ⇒ 至多重建 1 次并重投本轮」对**崩溃**正确、对**取消**致命 ⇒ 在 `first.unavailable` 之后、重建之前插 `if (this.turnAbortedByCancel) return first;`（**D-35**）。

### E.4 单次 `-p` 路径：signal 透传 + 取消归因（**D-34**）

`launchCliProcess(cli, args, env, signal?)` 第 4 参可选，**两条 spawn 分支**（win32 cmd 包装 / 直启）都条件展开 `...(signal ? { signal } : {})`，缺席即逐字节旧行为。

实测事件顺序：Node 在 `spawn` 内部**先**登记 abort 监听 ⇒ abort 以 `AbortError` 走 `child.on('error')`，**先于**本文件的 `onAbort`。因此 `child.on('error')` 里**必须同样先判取消**再归因，否则被归成 `PROVIDER_UNAVAILABLE` ⇒ 恰命中 `shouldDegrade` ⇒ 重跑（安全红线）。

### E.5 宿主两态事实化（`host-a2a-bridge/src/tools.ts`）

```ts
deriveExecutedBeforeCancel(artifacts, progress)  // steps 优先取 execution-steps 载体 data.steps 长度，
                                                 // 否则退回进度文本里的确定性 step 标记 ^执行 <id>：
                                                 // artifacts = 总数 − steps 载体；两者皆 0 ⇒ null
canceledSummaryText(executed)                     // null ⇒ 「…取消点之前的操作未执行…」
                                                  // 非 null ⇒ 「…取消前已有 N 个操作执行、M 个产物，请逐项核对 artifacts。」
...(executedBeforeCancel ? { executedBeforeCancel } : {})   // 判据③的**机械**信号 = 该键有/无
```
- **D-33**：框架侧 `stepsArtifact` 仅正常路径落 ⇒ 取消场景常缺席 ⇒ 纯 LLM 委派会出现「M>0、N=0」；仍走事实化分支（M 是硬事实），文案**不做**"至少执行了 N 步"推断。
- **D-32**：旧句「审批通道已关闭」在无审批的普通委派上失真（从未开过审批通道，何来关闭），已移除；取消是否成立改由 `a2a.task.cancel` 的 `cancelObserved` 承载。
- `cancelObserved = task.status.state === 'canceled'`：对已终态任务发 cancel 会回原终态 ⇒ 旧返回体只有 state 需宿主自比字符串，显式布尔位把"取消是否成立"变一等公民。

### E.6 客户端 CLI `--token-env`（`host-a2a-bridge/src/cli.ts`）

原文案「默认 **WINVM_BEARER_TOKEN**」与实现 `tokenEnv: ''` **直接矛盾** ⇒ 以实现为准改文案：默认**不启用**；仅 VM 侧开 `enforceBearer` 才需显式给出；给出后每个隧道请求带 `authorization: Bearer <值>`；有名无值 ⇒ **报错退出**（不静默降级）；回环场景无需本选项（`requireLoopbackBind` 不可关）。生效路径 `case '--token-env'` → `buildTransport` 条件展开 → `establishTransport` → `applyBearerHeader`（B/D 项同一实现），**无需改码**。

---

## 风险与回滚

| 风险 | 等级 | 缓解 | 回滚代价 |
|---|---|---|---|
| 取消折叠成 `EXECUTION_FAILED` 触发降级重跑 | **高**（安全性） | `TASK_CANCELED` 收口 + `canceledResult()` 不走 `{unavailable}` + 两条对照守卫（含"降级通路是活的"证伪用例） | 不可回滚（回滚即恢复安全缺陷） |
| `abortActiveTurn` 未杀子进程 ⇒ 取消成假动作 | **高** | 三步顺序 + 重建红线，`phase1-t5-llm-cancel` 断 `abortActiveTurn` 恰一次 | 不可回滚 |
| 误开 `enforceBearer` ⇒ VM 内回连全 401、委派退化为零副作用虚假完成（R4；B3 真机实测形态，非"当场失败"） | **中** | 默认 false；双条件挂载；`authMode` 三态显形；四处文档写黑 + 源码注释登记前置条件；CL-K3R `zeroInnerCalls` 不采信兜住虚假完成 | 可回滚（关掉即回旧行为）——这正是"默认关"的设计意图 |
| 白名单收紧打断既有跨账户工作流（B-1） | **中** | `mergePolicy` 并集 ⇒ 运维可显式追加；DENY 带 `matchedRule:'pathAllowlist:miss'` 可定位 | 半可回滚：可加条目，**不可**把默认值改回去 |
| 旧配置写 `commandAllowlist` 被 schema 拒（B-2） | **低→中** | schema 当前未接运行期校验（D-3 已登记）；升级前删键即可；报错信息可定位 | 可回滚（删键） |
| 非回环部署起不来（B-3） | **中** | 唯一受支持形态 = `ssh -L` 隧道；error 文案含原因 | **刻意不可回滚**（可关即等于第 0 层可消失） |
| 跨轮篡改不在 `chainValid` 判定面内（权衡一） | **中** | 范围机器可读 + `verifyArchive()` 片内校验 + ACL；**登记为权衡，不称已根治** | 不适用（本批只透出，不改 `freshChainOnStart`） |
| 审计无保留期（权衡二） | **低** | 按天/64MB 轮转；`shardsTotal` 可观测；运维外部留存 | 不适用 |

**锚点纪律（回滚/重构时的硬约束）**：`core/src/policy/engine.ts:769-778` 字面量切片（`assembly-guard` 锚点）、`vm-service` 的 `freshChainOnStart:true`、`server.ts` dry-run 三函数区、`approval-card.ts` 的 `MCP_RESUME_MARKER` 拼接字面（CL-021 B3-5）——**本批全部未动**。

---

## 验证方法

### 1. 构建（TS 改动必须经 build 验证；改 src 必重建 dist —— `cl020-f2-*` 直接 import dist）

```bash
node ./node_modules/typescript/bin/tsc -b tsconfig.build.json --force   # 期望 EXIT=0
```

### 2. 本批新增行为守卫（**逐文件**跑，禁整批 glob）

```bash
node --test tests/unit/phase1-t5-provider-cancel.test.js    # 判据① 咽喉 + 双闸分叉 + 契约形状 + 安全红线
node --test tests/unit/phase1-t5-cancel-consume.test.js     # 判据①②③④
node --test tests/unit/phase1-t5-llm-cancel.test.js         # 判据②（LLM 取消独立文件，队友交付）
node --test tests/unit/phase1-t5-token-env.test.js          # 判据④（`--token-env`，队友交付）
node --test tests/unit/host-a2a-bridge.test.js              # 判据③ + 旧文案断言同步（R3）
node --test tests/unit/phase1-t3-cancel-bounded.test.js     # 框架侧 29 例回归
```

### 3. 受影响既有静态/行为守卫抽验（本批改动面所在文件的钉）

```bash
for f in r19c-kn1-a-pure r19c-kn1-b-bridge r19c-kn1-c-session r19c-kn1-d-provider \
         r19c-kn1-e-shape r19c-kn1-e-mutation r19c-a5-approval-coordinator r19c-a5-fix4-risk \
         r3-uninstall-verify cl019-health-ageMs cl020-f2-a2a-netcfg-capture \
         cl018-persistent-session cl017-error-reason cl018-a2a-timeout; do
  node --test tests/unit/$f.test.js
done   # 期望全部 fail=0；任何一条红都按「守卫冲突协议」先报备再动刀，不得自行放宽
```

### 4. 三条**刻意破坏性**（B-1/B-2/B-3）的负向证据

| 项 | 离线可证判据 | 证据落点 |
|---|---|---|
| B-1 白名单收紧 | `C:\Users\other\x.txt` ⇒ `allowed=false` + `matchedRule:'pathAllowlist:miss'`；`%USERPROFILE%`（离线以 `HOME` 注入模拟）⇒ ALLOW；`appops.cli.invoke` 的 `outputDir` 能匹配 | `p0-path-traversal.test.js`（87 例）/ `policy.test.js`，T2 落地 |
| B-2 `commandAllowlist` 移除 | 全仓 `packages/*/src` + schema grep 命中 **0**（引擎不再读取）；schema 的 `policy.additionalProperties===false` 静态核对 | `phase1-t1-notes.md` §34-44 清点表 + T2 §61-62 |
| B-3 回环不可关 | `{security:{requireLoopbackBind:false}, bind.host:'0.0.0.0'}` ⇒ `validateServiceConfig` 返回 **error**（旧为 warning）；`bind.host:'127.0.0.1'` ⇒ 无 error | T1 手工判据 + `cl018-config.test.js`；真机 `/health` 已实形 `bearer-configured-missing`（`390c5da`） |

### 5. 全量离线回归（逐文件串行，同一次只跑一个进程）

```bash
npm run test:unit    # 内置逐文件 runner（目录式/整批在本仓会 MODULE_NOT_FOUND，既有口径非回归）
```

T5 代码面终局实跑（工程侧，留档 `$HOME/wbtmp/t5-full-run.txt`）：**79 文件 / 1456 tests / 1454 pass / 0 fail / 2 skipped**。权威数字以 `QA-REPORT.md` 独立复跑为准。

### 6. 真机项（离线沙箱**不可证**，清单见 `QA-REPORT.md` §真机）

```
# 取消真语义：委派长任务中 a2a.task.cancel → VM 内 CLI 子进程消失（Get-Process 反查）→ 链上 canceled + TASK_CANCELED
# 常驻打断：LLM 委派思考期取消 → abortActiveTurn 生效 → 同一 CLI 不再发起后续工具调用
# 误开 enforceBearer：真机复现（B3，2026-10-10 已完成）——实测形态=VM 内回连全 401 ⇒ 委派零副作用虚假完成（completed+zeroInnerCalls:true），宿主无凭据段当场 401；证据 $HOME/wbtmp/b3/
# 跨账户 DENY：%USERPROFILE% 实际值下 ALLOW / 其他账户 DENY 的端到端各一例（T2/T4 部署验收已跑通 ①②）
```
