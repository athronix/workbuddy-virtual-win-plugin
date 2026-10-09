# Phase 1 安全兑现批 · T5 实施笔记（执行体消费 + 宿主呈现 + 客户端 CLI + 文档兑现）

> 状态：**进行中**。本文件为增量落盘载体——每完成一区立即 fsync，防止会话中断导致结论丢失。
> 权威依据：`docs/changes/phase1-arch-design.md`（§1.1-4 执行体消费口径 / §1.1-6 呈现面 / §7.3 T5 任务卡 / §7.4-T5 验收判据 / §10 R3-R4）。
> 移交输入：`phase1-t3-notes.md` §6（第 6-9 条）、`phase1-t4-notes.md` §14（七条）。
> 纪律：严禁 git 写操作；主理人独立核验后统一提交。偏差登记自 **D-31** 起。

---

## §0 开工计划与侦察成果（fsync 已落盘）

### 0.1 目标（本批四个交付面）

| 面 | 内容 | 判据 |
|---|---|---|
| 代码 A 确定性执行体 | `adapter-agent-workbuddy/src/index.ts` `step()` 消费取消，取消后零新能力调用，返回 `TASK_CANCELED` 失败形状 | §7.4-T5 ① |
| 代码 B LLM 执行体 | `adapter-agent-workbuddy-llm/src/bridge.ts` turn 边界轮询 + `abortActiveTurn` + `launchCliProcess` signal 透传；`persistent-session.ts` `activeAbort` 接内部钩子 | §7.4-T5 ②③ |
| 代码 C 宿主呈现 | `host-a2a-bridge/src/tools.ts` canceled 文案事实化 + `executedBeforeCancel` + `a2a.task.cancel` + `cancelObserved` | §7.4-T5 ⑥（旧断言同步） |
| 代码 D 客户端 CLI | `host-a2a-bridge/src/cli.ts` `--token-env` 生效路径与 usage 文案 | §7.4-T5 ④ |
| 文档面 | SECURITY-GOVERNANCE / ARCHITECTURE / CAPABILITY-MODEL / CL-022 三件套 / DEPLOYMENT+README+overview / SKILL.md D-13 | §7.4-T5 ⑤ |

### 0.2 已完成的只读侦察（结论）

**契约与框架既有能力（T1/T3/T4 已交付，本批只消费不重造）**
- `contracts/src/bridge.ts:401/411`：`ProgressSink.isCancelled?()` 与 `cancellationSignal?: AbortSignal`，纯附加可选。
- `contracts/src/errors.ts:36`：`BridgeErrorCode` 已含 `'TASK_CANCELED'`，`retryable:false`（:70）。`'AUTH_REQUIRED'` 刻意不入枚举。
- `a2a-framework/src/task-store.ts:242-255`：`addArtifact()` 终态守卫——canceled 后**静默丢弃、不 emit**；`createProgressSink` 透出 isCancelled/cancellationSignal（同源）。
- `a2a-framework/src/server.ts:379-383`：O-2 取消收口不落 artifacts、不 updateStatus，只 observe；:385-390 正常路径才 `sink.onArtifact(stepsArtifact(result))`。`stepsArtifact`（:667-690）形态 `{kind:'steps', name:'execution-steps', data:{steps:[...]}}`。
- ⇒ **推论（宿主事实化口径）**：取消场景下宿主可见 `artifacts` 只可能是 handler 运行期间已流出的中间产物。故 `executedBeforeCancel.artifacts = artifacts.length`；`steps` 优先从含 `data.steps` 数组的 artifact 派生，取不到时以 artifacts 数量事实化。T3 移交第 7 条同时要求：`goalSummary/stepCount` 在取消路径**不写**，文案不得宣称「已执行 N 步」除非 N 来自 artifacts 事实源。

**代码 A 位点（`adapter-agent-workbuddy/src/index.ts`，964 行）**
- `step()` :395-426 —— 咽喉点：`sink.onStatus('working', …)` 后无条件 `await this.execute(...)`。取消哨兵须插在 `this.execute` **之前**，且 `onArtifact` 推送前二次判取消（框架 `addArtifact` 已二次闸门，provider 侧不重复推）。
- 五模板（安装 :431-453 / 磁盘 :456-467 / 系统信息 :470-479 / 截图 :482-491 / appops :498-531）+ 无匹配收口 :534-544 全部经 `step()`。
- `goalFail()` :943-956 现写死 `makeError('EXECUTION_FAILED', summary)` —— **不改其语义**（既有失败路径保持原码），另加取消收口形状。
- 关键安全红线：`adapter-agent-workbuddy-llm/src/index.ts:437-442` `shouldDegrade` = `PROVIDER_UNAVAILABLE` 或（`EXECUTION_FAILED` 且 `artifacts.length===0`）⇒ 回落确定性执行器**重跑**。故取消收口必须用 `TASK_CANCELED`，否则被打断的任务会被重新执行。

**代码 B 位点（`bridge.ts` 1499 行 / `persistent-session.ts` 996 行）**
- `buildMcpConfig` :159-166：待加注释登记「开 enforceBearer 前必须补齐 VM 内回连凭据通路，否则委派执行必 401」（§10 R4；本批**只注释+文档，不实现通路**，§5 第 3 条明写前置条件）。
- `launchCliProcess` :463-483：两处 `spawn(...)`（cmd 包装路径 + 直启路径），需加可选 `signal?: AbortSignal` 并**两条路径都透传**。
- `runPersistent` :1198-1301：`turnSink` 现仅包 `onStatus` ⇒ 轮询点插在此包装内；委派入口前置检查。
- `runOneShot` :1311-1498：`new Promise` + `finish()` + `setTimeout` + `child.kill('SIGTERM')` ⇒ signal 命中须走 `finish(...)` 落终态，避免 Promise 悬挂。
- `persistent-session.ts`：`private activeAbort` :225；定义于 warmup :652 / execTurn :757；挂接 :679/:837（`this.activeAbort = abort`）；清理 :649/:702/:747；`onExit/onError` :500/:509 亦调 `this.activeAbort?.(msg)`；`faultExit` :949；`killChild` :512-544。⇒ 新增**公开薄方法** `abortActiveTurn(reason)`（内部 `this.activeAbort?.(reason)`），零新状态语义，不复述守卫字面。

**代码 C/D 位点（`host-a2a-bridge/src/tools.ts` 705 行 / `cli.ts` 151 行）**
- tools.ts :415 `const ok = state!=='failed'&&state!=='rejected'&&state!=='canceled'&&!timedOut;`；:432-433 旧 canceled 句「任务已取消（canceled），审批通道已关闭，未执行任何变更。已产出的 artifact 仍可读取；如需继续，请重新发起。」（**不实**：可能已执行变更）；:466-482 `structuredContent`；`a2a.task.cancel` :618-653 现仅返回 `{ok:true,traceId,taskId,state}`。
- cli.ts :43 usage 写「默认 WINVM_BEARER_TOKEN」与 :61 `tokenEnv:''` **矛盾**（实现是默认不带凭据，回环场景）⇒ 改文案；:96-104 `buildTransport` 已条件展开 `tokenEnv`，真给值时由 T2 交付的 `core/src/transport/index.ts:54-69` `applyBearerHeader(headers, tokenEnv, env)` 注入 `authorization: Bearer <token>`（三态：无 tokenEnv 不加头／有值加头／有名无值 fail-loud 抛 `TransportError`；ssh-tunnel 分支前置到建隧道之前，T2 D-11）。

### 0.3 守卫输入面预检（动源码前 grep 结论）

| 守卫 | 钉位 | 本批约束 |
|---|---|---|
| `r19c-kn1-e-shape` :72/:150-181 | `adapter-agent-workbuddy/src/index.ts` | 编辑本文件**不得新增** `channel: req.channel ?? 'mcp'` / `channel: 'mcp'` 出现点 |
| `r19c-kn1-e-mutation` :126-131 | 同上 | `e2_two_write_points===2`、`e2_no_hardcode===0`、`ext:{kind:'inner-call' as const, delegationId: req.delegationId,` `===2` —— 计数不得变动 |
| `r3-uninstall-verify` :1326-1363 | 同上 | 钉 `bridge.call(impl.module, impl.fn, req.params, capTimeoutMs ?? req.timeoutMs ?? 30_000)` / `const capTimeoutMs = impl.timeoutMs;` / `impl.module === '__meta' && impl.fn === 'healthCheck'` |
| `cl019-health-ageMs` :118-126 | 同上 | 钉 `capabilityId === 'system.network.config'` 与 `reportNetCfg` cast 形态 |
| `assembly-guard` :150-185 auditA5 | `bridge.ts` | 须保 `this.coordinator?.endTask(input.taskId ?? '')` / `beginTask(...)` 在场 |
| `r19c-a5-approval-coordinator` :626-669 C6 | `bridge.ts` | 两行门 `if (!this.replayEnabled \|\| !ctx.replayActive) return base;` 与 `if (ctx.raised.size === 0) return base;` **相邻且顺序不变**；`receipts: new Map()` / `raised: new Set()` / `replayActive: false` 在场 |
| `cl018-a2a-timeout` :33-38/:70-77 | `cli.ts` / `tools.ts` | cli.ts 须含 `resolveA2aTimeoutMs(process.env)` / `case '--timeout'` / `ENV_A2A_TIMEOUT_MS` |
| `cl020-f2` | dist 产物 | 直接 import `adapter-agent-workbuddy/dist/index.js` ⇒ **改 src 必须重建 dist**（T4 D-28） |
| `host-a2a-bridge.test.js` :399/:414-423 | 旧断言 | :419/:420 断旧 canceled 句（含「审批通道已关闭」）；:399 超时用例负向 `!includes('任务已取消')` —— R3 要求同步适配（判据⑥） |

**预判**：以上均可在**不放宽任何既有判据**的前提下满足。若实施中撞红，按守卫冲突协议先 SendMessage 报备，不自行放宽。

### 0.4 执行顺序

1. 代码 A（index.ts）→ 2. 代码 B（persistent-session.ts + bridge.ts）→ 3. 代码 C（tools.ts）+ 旧断言同步 → 4. 代码 D（cli.ts）→ 5. 新建 `tests/unit/phase1-t5-*.test.js`（①②③④离线行为守卫）→ 6. `tsc -b tsconfig.build.json --force` 重建 dist → 7. 逐文件跑测对账 → 8. Checkpoint 1 → 9. 文档面 → 10. notes 终判 + Checkpoint 2。

### 0.5 环境口径

- node：`/data/storage/el1/bundle/libs/arm64/node/bin/node`；git（只读）：`/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`。
- 基线（T4 后）：**75 测试文件 / 1400 tests / 1398 pass / 0 fail / 2 skip**；对账口径 `1283+40+28+45+4=1400`。
- 跑测**逐文件**，禁整批 glob（junction 用例并发触发 0xC0000005 假红）；同一时刻全仓只许一个全量跑进程。
- 计数只用 `line.trimStart().startsWith("\u2139 tests ")`；禁 node -e 内联正则；大文件计数用 `git diff --numstat`（勿信单次 wc，先例 D-30）。
- `tests/unit` 现有 phase1 新文件 4 个（t3×1 / t4×3）。
- 文档面行数基线：SECURITY-GOVERNANCE 281 / ARCHITECTURE 341 / CAPABILITY-MODEL 289 / DEPLOYMENT 546 / README 338 / overview 232 / skills/winvm-storage-manager/SKILL.md 143。无任何测试读取 `docs/**`。
- getcwd 偶发异常：所有命令前缀 `cd <repo root>`。
- ⚠ 更正：`/tmp` 在本环境**只读**（`bash: /tmp/t5dbg.mjs: Read-only file system`）；临时脚本一律落 `$HOME/wbtmp/`。`@winvm/*` 是 workspace 包，脚本必须放在仓库内才能解析导入。

---

## §1 代码 A：确定性执行体消费取消（`adapter-agent-workbuddy/src/index.ts`，numstat +71/−2）

### 1.1 改动内容

| 位点 | 改动 | 设计依据 |
|---|---|---|
| `step()` 入口 | `if (sink.isCancelled?.() === true) return { ok:false, canceled:true, error:'任务已取消，未发起该能力调用' }` —— 插在 `this.execute` **之前** | §1.1-4「模板 1/2/3 都经此咽喉，取消后零新能力调用在此一次成立」 |
| `step()` 出口 | 调用返回后二次判取消：命中则 steps 照常记账、**产物入本地结果集但不外推**（分叉口径，见 D-37），返回带 `canceled` 哨兵 | §1.1-4 粒度=一次能力调用；T3 移交第 7 条（流出面不增长）；主理人裁定「不得抹痕」 |
| 五个模板 | 每处 `await step(...)` 之后 `if (r.canceled) return canceledReturn();`（安装模板 2 处 + 磁盘/系统信息/截图/appops 各 1 处 = 6 处） | 模板只需把哨兵转成收口形状 |
| 新增 `goalCanceled()` | `ok:false` + `makeError('TASK_CANCELED', …)`；summary=「取消判定生效前共发起 N 次能力调用、产出 M 个 artifact；此后未再发起任何能力调用」 | §1.1-4 要求 TASK_CANCELED 失败形状；文案只陈述可证事实 |

**刻意不改 `goalFail()`**（仍 `EXECUTION_FAILED`）：既有失败路径语义逐字保留，避免与 T2/T3 既有断言冲突。

### 1.2 为什么必须用 `TASK_CANCELED`（安全红线）

`adapter-agent-workbuddy-llm/src/index.ts:437-442` `shouldDegrade` = `PROVIDER_UNAVAILABLE` 或（`EXECUTION_FAILED` 且 `artifacts.length===0`）⇒ 回落确定性执行器**重跑**。取消若用 `EXECUTION_FAILED` 收口，一个已被用户叫停的任务会被自动重新执行 —— 属安全性错误，不是风格问题。已在守卫里用「TASK_CANCELED 不降级」+「EXECUTION_FAILED 对照组确实降级」两条用例把它钉成**非恒真**断言。

### 1.3 守卫复核（实跑，详见 §7）

`r19c-kn1-e-shape` 33/0、`r19c-kn1-e-mutation` 54/0、`r3-uninstall-verify` 39/0、`cl019-health-ageMs` 14/0、`cl020-f2-a2a-netcfg-capture` 5/0 —— 全绿，未放宽任何判据；新增代码未引入 `channel: req.channel ?? 'mcp'` / `ext: { kind:'inner-call' … }` 任何新出现点（三处计数不变）。

---

## §2 代码 B：LLM 执行体消费取消（`bridge.ts` +72/−1、`persistent-session.ts` +70/0）

### 2.1 `persistent-session.ts`：公开 `abortActiveTurn(reason)`

复用既有 `activeAbort` 钩子（execTurn / warmup 各挂一次），**零新状态语义**。三步顺序：
1. `turnAbortedByCancel = true`（新增私有标志，供 `runTurn` 跳过「同轮重建重试」）；
2. `activeAbort(reason)` → 当前轮 promise 以既有形状落终态（`settled` 闸保证与超时/result/退出互斥）；
3. `killChild()` → **这一步才是取消的实质**：只 resolve promise 而留 CLI 活着，VM 内 agent 会继续自行发起工具调用（真实写入/删除照旧发生），取消成假动作。
   - 先 abort 后 kill（与 O-1 一致）；`killChild` 先清 `child` 引用 ⇒ 后续 exit 事件被 `wasAlive=false` 门卫拦截，取消**不会**被记成 `lastError`（取消不是故障，不污染 `/health` 历史信号面，D11 两信号分离）。
   - 无在飞轮次 ⇒ 返回 false 且**不动子进程**（空闲期杀进程属无谓抖动、且会误伤预热）。

### 2.2 `runTurn` 的重建红线（新插入判定，非可选）

既有「不可用 ⇒ 至多重建 1 次并重试本轮」对**崩溃**是正确的，对**取消**是致命的：等于把用户已叫停的目标重新投喂给新 CLI 进程再跑一遍。故在 `first.unavailable` 之后、重建之前插入 `if (this.turnAbortedByCancel) return first;`；标志在每轮开始处清零（串行链保证一次只有一轮在飞 ⇒ 生命周期与「本轮」严格对齐）。

### 2.3 `bridge.ts` 消费点

| 位点 | 改动 |
|---|---|
| `runPersistent` 入口 | `sink.isCancelled?.() === true` ⇒ 直接 `canceledResult()`（不碰会话：不新建、不复活、不注入新一轮） |
| `turnSink.onStatus` | 轮询取消：命中即 `session.abortActiveTurn(...)` + 置 `turnAborted`，且**打断后的状态上报一律不转发给宿主**（canceled 终态下继续流出 `working` 进度属观测面失真） |
| `cancellationSignal` 订阅 | 与轮询互补：真机 CLI 思考期可长时间不上报状态，单靠轮询会拖延到下一个事件。信号一到即打断；监听在 `finally` 摘除（常驻会话跨委派复用，残留监听会把后续任务的取消误打到已结束轮次 ⇒ 泄漏+错杀双风险） |
| `runPersistent` 收口 | `catch` 分支与正常返回后都判 `turnAborted \|\| isCancelled()` ⇒ `canceledResult()`；**关键**：绝不返回 `{ unavailable }`（会被 `runGoalCore` 当「常驻不可用」回退单次 `-p`，等于取消后又跑第二遍） |
| `runOneShot` 入口 | 同型前置闸（否则常驻关闭/CLI 未解析场景只能等超时，宿主表现为挂死） |
| `launchCliProcess` | 第 4 参可选 `signal?: AbortSignal`，**两条 spawn 分支都透传**（win32 cmd 包装路径 + 直启路径），缺席即逐字节旧行为 |
| `runOneShot` 取消归因 | 显式 `addEventListener('abort')` 以 TASK_CANCELED 调 `finish`；`child.on('error')` **同样先判取消**（原因见 D-34） |
| `buildMcpConfig` | 注释登记 R4 前置条件：开 `enforceBearer` 前必须补齐 VM 内**回连凭据通路**，否则委派执行必 401（本批只注释+文档，**不实现通路**，§5 第 3 条） |

### 2.4 `canceledResult()` 三条纪律

① 码必 `TASK_CANCELED`（`reconcileDelegationTruth` 门 1 与 `reconcileExecutionTruth` 门 0 都按 `!base.ok` 透传 ⇒ 本结果即最终回包）；② 不能返回 `{ unavailable }` 形状（绕开降级通道）；③ `artifacts/steps` 返回空数组 —— 取消收口**不做新的磁盘扫描**（O-5 边界：不得为取证再引入一次可挂死的 IO）；宿主看到的取消前产物来自此前 `sink.onArtifact` 已流出的部分。

---

## §3 代码 C：宿主呈现（`host-a2a-bridge/src/tools.ts`，numstat +96/−4）

| 位点 | 改动 | 判据 |
|---|---|---|
| `deriveExecutedBeforeCancel()` | 新增纯函数：steps 优先取 `execution-steps` artifact 内 `data.steps` 长度，取不到退回进度文本里的确定性 step 标记（`^执行 <capabilityId>：`）；artifacts = 总数**扣除** steps 载体本身；两者皆 0 ⇒ 返回 `null` | §1.1-6 |
| `canceledSummaryText()` | 两态文案：`null` ⇒ 「任务已取消（canceled），取消点之前的操作未执行。如需继续，请重新发起并重新确认审批。」；非 null ⇒ 「任务已取消（canceled）；**取消前已有 N 个操作执行、M 个产物**，请逐项核对 artifacts。」 | 判据③两态可分 |
| `structuredContent.executedBeforeCancel` | **条件展开**（仅非 null 时出现）⇒ 有/无该键即两态可分的机械判据 | 判据③ |
| `a2a.task.cancel` | 新增 `cancelObserved = task.status.state === 'canceled'`（对已终态任务的 cancel 会回原终态 ⇒ 旧返回体只有 state，宿主需自比字符串；显式布尔位把「取消是否成立」变一等公民）；description/文本同步声明「协作式取消、已发起操作可能已改动 VM，不得据此宣称未执行任何变更」 | §1.1-6 |

### 3.1 旧断言同步（§10 R3 / 判据⑥）

`grep` 预检命中 4 处，逐条处置：

| 位置 | 原断言 | 处置 |
|---|---|---|
| `host-a2a-bridge.test.js:414-423` | 断旧句「任务已取消（canceled）」+「**审批通道已关闭**」 | 改为零痕迹态断言：保留 `任务已取消（canceled）` 状态词、改断 `取消点之前的操作未执行`、**新增负向** `!includes('未执行任何变更')`、新增 `'executedBeforeCancel' in sc === false`；原两条负向（默认批准／超时文案）逐条保留 |
| `:399`（超时用例） | `!includes('任务已取消')` | 未改：新文案仍以 `任务已取消（canceled）` 起首，超时分支不含该词 ⇒ 负向守卫仍成立（实跑绿） |
| `:90 / :247-249`（cancelTask mock） | mock 回 `state:'canceled'` | 原断言保留；**追加** `cancelObserved===true` + 文本含「VM 侧已确认取消」；并新增「回包非 canceled ⇒ false 且文本如实说明未生效」用例 |
| — | — | 另新增 2 条正向（有痕迹态事实化、steps 权威源优先）⇒ 该文件 37 例（原 34）全绿 |

---

## §4 代码 D：客户端 CLI（`host-a2a-bridge/src/cli.ts`，numstat +5/−1）

- `usage()` 原文案「bearer token 环境变量名（**默认 WINVM_BEARER_TOKEN**）」与实现 `tokenEnv: ''`（默认不启用）**直接矛盾** ⇒ 改为「默认**不启用**，即不带凭据」，并补 4 行：仅 VM 侧开 `enforceBearer` 时才需显式给出；给出后每个隧道请求带 `authorization: Bearer <值>`；有名无值 ⇒ fail-loud 报错退出（不静默降级为无凭据请求）；回环场景默认无需本选项（`requireLoopbackBind` 不可关）。
- `parseArgs` / `buildTransport` 生效路径经核对**无需改码**：`case '--token-env'` → `buildTransport` 条件展开 `tokenEnv` → `establishTransport(streamable-http)` → `applyBearerHeader`（T2 交付的唯一实现）。`cl018-a2a-timeout` 三条静态钉未触碰（实跑 7/0）。
- 判据④的离线断言落 `phase1-t5-cancel-consume.test.js`，**未**与 `oh-tunnel.test.mjs`/`tunnel-mode.test.js` 同文件：那两处依赖隧道/真机环境，本批要求逐文件跑测且新增用例必须零环境依赖。

---

## §5 测试新增（`tests/unit/phase1-t5-cancel-consume.test.js`，17 tests / 0 fail）

| 组 | 用例数 | 覆盖判据 |
|---|---|---|
| 判据① 确定性咽喉 | 4 | 入口取消零调用；两次调用模板「搜索已执行、安装绝不发起」（**核心安全断言**）；调用期间取消不外推 artifact；未取消零回归 |
| 判据② LLM 常驻 | 5 | 入口前置闸；onStatus 轮询命中 ⇒ `abortActiveTurn` 恰一次 + 打断后状态不外传；纯 signal（无状态上报）也能打断；TASK_CANCELED 不触发降级重跑；EXECUTION_FAILED 对照组**确实**降级（防恒真） |
| 判据③ 单次 -p | 3 | 运行中取消 ⇒ 真子进程被 kill 且以 TASK_CANCELED 落终态；入口取消 ⇒ 零 spawn；未取消 ⇒ 正常跑完 |
| 判据④ 凭据通路 | 5 | `buildTransport` 键有/无；`applyBearerHeader` 三态；ssh-tunnel 抛错**前置**（错误串不含隧道字样）；离线回环 e2e 实收 `Bearer` 头；未配置 ⇒ 实收无 authorization |

夹具纪律：`@winvm/*` 是 workspace 包，脚本必须落在仓库内才可解析导入；判据③用 `process.execPath` 自 spawn 一个可 kill 的 node 子进程做真实终止验证（唯一一处真起进程，零网络/零 VM/零隧道）。

---

---

## §6 偏差登记（自 D-31 起）

| ID | 类型 | 内容 | 依据/影响 |
|---|---|---|---|
| **D-31** | 实现细节 | 确定性 `step()` 除入口闸外，**出口再加一次**取消判定（调用返回后命中 ⇒ 结果不落地、产物不外推，但仍记 steps）。设计 §1.1-4 只写「入口哨兵」。 | 长能力调用（如 winget 安装）跑到一半被取消时，若不在出口收口，模板会继续走下一步判断并返回 `EXECUTION_FAILED`（⇒ 触发降级重跑）。steps 仍记账以满足呈现面事实化（取消前确已发生）。 |
| **D-32** | 文案 | 设计 §1.1-6 的 canceled 两态文案里**去掉**了旧句「审批通道已关闭」。 | 该句在无审批的普通委派上失真（从未开过审批通道，何来"关闭"）；取消是否成立已由 `a2a.task.cancel.cancelObserved` 承载。旧断言 `:420` 相应删除并在同用例补 `!includes('未执行任何变更')` 负向守卫。 |
| **D-33** | 事实源 | `executedBeforeCancel.steps` 采用「`execution-steps` artifact 内 `data.steps` 长度 → 否则退回进度文本里的确定性 step 标记」两级派生；`artifacts` **扣除** steps 载体本身。 | O-2 取消收口不落 `execution-steps`（框架侧正常路径才落），故纯 LLM 委派常出现「M>0、N=0」；仍走事实化分支（M 是硬事实），文案不做「至少执行了 N 步」推断。宿主判据③的机械信号是该键**有/无**。 |
| **D-34** | 归因顺序 | 单次 `-p` 路径除注册 `abort` 监听外，**同时**在 `child.on('error')` 里先判 `cancellationSignal.aborted` 再归因。 | 实测事件顺序：`spawn({signal})` 的 Node 内部监听**先于**我们的 `onAbort` 触发，abort 会以 `AbortError` 走 `child.on('error')` ⇒ 若不先判取消，会被归成 `PROVIDER_UNAVAILABLE`，而 `shouldDegrade` 恰匹配该码 ⇒ 被打断的任务回落确定性执行器重跑（安全红线）。测试判据③用例最初即因此红，修后绿。 |
| **D-35** | 新增守卫 | `persistent-session.ts` 在 `abortActiveTurn` 内执行 `killChild()`，并新增 `turnAbortedByCancel` 标志跳过 `runTurn` 的**同轮重建重试**。 | 设计只写「接内部钩子让 abortActiveTurn 能真正打断当前轮」。只 resolve promise 而 CLI 仍活着 ⇒ VM 内 agent 继续发起工具调用，取消成假动作；而既有「不可用即重建并重试本轮」对崩溃正确、对取消等于重跑用户已叫停的目标。两处均为兑现「真取消」所必需，登记为增量实现细节。 |
| **D-36** | 测试落点 | 判据④离线守卫**新建独立文件**（`phase1-t5-cancel-consume.test.js`），未并入 `oh-tunnel.test.mjs`/`tunnel-mode.test.js`。 | 设计 §7.4-T5 ④ 允许「同层断言」；那两个文件依赖隧道/真机环境，与「新增用例零环境依赖 + 逐文件跑测」纪律冲突。断言层级不变（cli→buildTransport→applyBearerHeader→establishTransport→真实 HTTP 头）。 |
| **D-37** | 口径修正（主理人裁定） | `step()` 出口取消分支**改为仍把已完成产物 push 进本地 `artifacts`**，只关闭 `sink.onArtifact` 外推（原实现两侧一起收敛 ⇒ 本地集为 0）。 | 原判据「双闸同口径」推导有误：框架 O-2 决定 canceled 不落链，`task.artifacts` 只保持取消前既有内容、**不替 provider 补记**；而宿主文案计数与 QA 反查唯一可读事实源是 `GoalResult.artifacts`（T3 移交第 7 条亦注明 observer 快照里 `result` **在场**）。收口清空本地集＝抹掉「确实产出了这份产物」的可证事实 ⇒ 属实现缺陷，不得反向放宽测试。已同步：`phase1-t5-provider-cancel.test.js`（断 `===1` + 新增「本地账 ≥ 流出面」分叉钉）、`phase1-t5-cancel-consume.test.js`（断 `===1`／sink `===0`／summary「产出 1 个 artifact」）。 |
| **D-38** | 测试替身 | 截图用例目标文本 `帮我截屏看看` 曾不命中确定性模板正则（`/(截图|截屏|看看屏幕|当前屏幕)/` 之外的措辞在另一文件里写成 `截个屏幕`）⇒ 走「无匹配模板」分支，表现为「artifact 数为 0」假象。 | 判因结论：**替身缺陷**（非实现缺口）。两个文件现分别用 `帮我截屏看看` / `截一张当前屏幕看看`，均命中 `gui.screen.capture`；已确认 `extractArtifacts` 仅在 `capabilityId==='gui.screen.capture'` 且 `data.data` 为 string 时产出，故夹具必须回 `{data:'...'}` 形状，否则 artifact 断言空转。 |

---

## §7 执行进度表（五红 → 全绿的判因过程）

### 7.1 六文件区完成态

| 区 | 文件 | 状态 | 备注 |
|---|---|---|---|
| A | `adapter-agent-workbuddy/src/index.ts` | ✅（含 D-37 修正） | `step()` 入口/出口双闸、五模板 `canceled` 哨兵、`goalCanceled()` |
| B1 | `adapter-agent-workbuddy-llm/src/persistent-session.ts` | ✅ | 公开 `abortActiveTurn`（置标志 → abort → killChild）+ `runTurn` 重建红线 |
| B2 | `adapter-agent-workbuddy-llm/src/bridge.ts` | ✅ | 常驻/单次两路前置闸、turn 轮询 + signal 事件驱动、`launchCliProcess` signal 透传、R4 注释 |
| C | `host-a2a-bridge/src/tools.ts` | ✅ | 两态文案 + `executedBeforeCancel` + `a2a.task.cancel` / `cancelObserved` |
| D | `host-a2a-bridge/src/cli.ts` | ✅ | `--token-env` usage 与实现对齐（生效路径无改动） |
| T | 测试三件（provider-cancel 12 例组 / cancel-consume / llm-cancel）+ `host-a2a-bridge.test.js` 同步 | ✅ | 见 §7.2 |
| DOC | 文档面 6 处 + CL-022 三件套 | ⏳ | Checkpoint 1 之后执行 |

### 7.2 五红判因（team-lead 唤醒清单 → 消解路径）

| # | 红点 | 判因 | 处置 | 复跑 |
|---|---|---|---|---|
| 1 | `cancel-consume:176` `calls[0].fn === undefined` | **替身缺陷**：夹具键名写成契约的 `function` 之外形态，`implementation.function` 未正确注入 ⇒ `bridge.call` 收到 undefined fn | 夹具改用 `CAP_IMPL` + `implementation: {module, function}`，并加注释钉住键名 | 绿 |
| 2 | `cancel-consume:192` `0 !== 1` | **替身缺陷**（D-38）：目标文本不命中截图正则 ⇒ 走无匹配模板分支，artifact 恒 0 | 目标文本改 `帮我截屏看看` | 绿 |
| 3 | `cancel-consume:304` 打断后仍向宿主转发 1 条状态 | 源码已含「命中取消即 return、不再转发」；红因 **dist 陈旧**（改 src 未重建，违 D-28 纪律的后果） | `tsc -b --force` 重建后复跑 | 绿 |
| 4 | `cancel-consume:443` 实得 `PROVIDER_UNAVAILABLE/LLM_RUNTIME_ERROR` | 同上 **dist 陈旧**；src 的 `child.on('error')` 取消归因分支（D-34）在场 | 重建后复跑 | 绿 |
| 5 | `provider-cancel:174` `result.artifacts.length` 期望 1 实得 0 | **实现缺口**（非替身）：取消收口把取消点前已完成的产物从 `GoalResult.artifacts` 整体丢弃＝抹痕 | 按主理人裁定**修实现面**（出口分支仍入本地集、只关外推），未反向放宽断言；登记 D-37 | 绿（重建 dist 后 11/11） |

**判因纪律实证**：本批五红中，2 类都有（替身 2 + dist 陈旧 2 + 实现缺口 1），与 T4「两类皆有」结论一致。
**关键教训**：`#3/#4` 两红是纯粹的陈旧产物假象 —— 若先改测试或先改 src 就会造成双重错误。凡改 src 必立即 `tsc -b --force`，再看红。

### 7.3 T5 阶段守卫计数（逐文件，留档 `$HOME/wbtmp/t5-run-*.txt`）

| 文件 | tests | pass | fail |
|---|---|---|---|
| `phase1-t5-provider-cancel.test.js` | 11 | 11 | 0 |
| `phase1-t5-cancel-consume.test.js` | 17 | 17 | 0 |
| `phase1-t5-llm-cancel.test.js` | 12 | 12 | 0 |
| `host-a2a-bridge.test.js`（同步后） | 38 | 38 | 0 |

> 注：`phase1-t5-llm-cancel.test.js` 为并发队友（software-engineer-1）新增的 LLM 取消守卫文件，与我的 `cancel-consume` 判据②组有重叠覆盖；全量对账时按 78 文件口径计入。

### 7.4 全量逐文件对账（T5 代码面终态）

口径：`tests/unit` 下 `*.test.js` + `*.test.mjs`，**逐文件串行 spawn**（禁 glob、禁并发），计数只取 `ℹ tests/pass/fail/skipped`。留档 `$HOME/wbtmp/t5-full-run.txt`（+ 控制台 `$HOME/wbtmp/t5-full-run-console.txt`）。

| 指标 | T4 基线 | T5 代码面 | 增量 |
|---|---|---|---|
| 测试文件 | 75 | **79** | +4（我 2：`phase1-t5-provider-cancel` / `phase1-t5-cancel-consume`；队友 2：`phase1-t5-llm-cancel` / `phase1-t5-token-env`） |
| tests | 1400 | **1456** | +56 |
| pass | 1398 | **1454** | +56 |
| fail | 0 | **0** | — |
| skipped | 2 | **2** | — |
| 失败文件数 | 0 | **0** | `failFiles=0` |

`tsc -b tsconfig.build.json --force` exit **0**（留档 `$HOME/wbtmp/t5-tsc-3.txt` / `t5-tsc-4.txt`；重建均在 src 修改之后立即执行）。

### 7.5 受影响既有守卫抽验（逐文件，全绿）

| 守卫文件 | tests | fail | 钉位与本批关系 |
|---|---|---|---|
| `phase1-t3-cancel-bounded` | 29 | 0 | T3 取消框架：sink 透出 / O-1 / O-2 三断言 ⇒ 本批消费面不得反噬 |
| `r19c-kn1-e-shape` | 33 | 0 | 钉 `index.ts` 的 `channel:` 两处计数 + inner-call ext 两处 ⇒ 未新增出现点 |
| `r19c-kn1-e-mutation` | 54 | 0 | 同上变异版 |
| `r19c-a5-approval-coordinator` | 22 | 0 | 钉 `bridge.ts` 两行门相邻顺序 + C6 三个 Map/Set 在场 |
| `r19c-a5-fix4-risk` | 4 | 0 | `bridge.ts` 风险闸 |
| `r19c-kn1-a-pure` / `-b-bridge` / `-c-session` / `-d-provider` | 76 / 23 / 17 / 28 | 0 | K-N1 系全链（本次改动跨 provider+bridge+session 三文件） |
| `r3-uninstall-verify` | 39 | 0 | 钉 `step()` 内 `bridge.call(...)` 参数形态与 `__meta/healthCheck` 判定 |
| `cl019-health-ageMs` | 14 | 0 | 钉 `system.network.config` + `reportNetCfg` cast |
| `cl020-f2-a2a-netcfg-capture` | 5 | 0 | 直接 import `dist/index.js` ⇒ 验证 dist 已重建且行为未漂 |
| `cl018-persistent-session` | 19 | 0 | `activeAbort` / `killChild` 既有语义（本批新增 `abortActiveTurn` 未改写） |
| `cl017-error-reason` | 10 | 0 | `TASK_CANCELED` 契约码与 reason 折叠 |
| `cl018-a2a-timeout` | 7 | 0 | `cli.ts` 三条静态钉 + `tools.ts` 剥注释后无「已修复/已解决」 |
