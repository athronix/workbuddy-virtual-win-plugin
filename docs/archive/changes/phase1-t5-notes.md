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
- 文档面行数基线：SECURITY-GOVERNANCE 281 / ARCHITECTURE 341 / CAPABILITY-MODEL 289 / DEPLOYMENT 546 / README 338 / overview 232 / skills/winvm-storage-manager/SKILL.md 143。~~无任何测试读取 `docs/**`~~ ⇒ **已推翻**：实测 4 个守卫读文档/Skill 文本（详见 **D-39** 与 §8.1），改文档属守卫输入面。
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
| **D-39** | 侦察结论修正 | §0.3 曾记「无任何测试读取 `docs/**`」——**不成立**。实测有 4 个守卫直接读文档/Skill 文本：`r19b-s1-registry-forms`（切 `CAPABILITY-MODEL.md`）、`r19b-s5-write-allowlist-pairing`（切 `skills/winvm-system-admin/SKILL.md` + `docs/design/s5-*.md`）、`r1-approval-card`（切 `skills/winvm-orchestrator/SKILL.md`）、`host-adapter`/`deploy-shared-skills`（Skill 渲染产物）。 | 文档面因此**不是零风险区**：改 `CAPABILITY-MODEL.md` 属守卫输入面。已按守卫冲突协议在改后逐文件复跑（§8.1 五文件全绿）。教训：grep 结论要按「读文件的 API 调用点」（`src(` / `readFileSync` / `read(`）二次核验，只 grep 路径字符串会漏。 |
| **D-40** | 文档补齐 | `SECURITY-GOVERNANCE.md` §2.2 原文把取消呈现口径指向 `HOST-A2A-BRIDGE.md`，但**该文档当时没有对应章节**（只有工具表里一行「取消任务」）⇒ 悬空引用。 | 本批在 `HOST-A2A-BRIDGE.md` 新增 **§4.5 取消的呈现口径**（两态判据表 + steps 两级派生 + `cancelObserved` + 重新发起须重新审批），使 §2.2 的指向落地；文案与 `tools.ts` 的 `canceledSummaryText` 逐字核对一致。属"补齐既有承诺"而非新增口径。 |
| **D-41** | 文档未改动项（刻意） | 仓库根 `overview.md` 经 grep 核对**无** bearer/`--token-env` 配置样例、无与本批冲突口径 ⇒ 不编辑；`README.md:275` 与 `docs/06-OVERVIEW.md:4/60`、`phase0-delivery-summary.md` 的测试基线数字（71/1247 与 1245 pass）**保持原样**。 | 基线对外数字属 **QA 收官批**统一口径（任务书明写"不得动"），工程侧只留 `$HOME/wbtmp/t5-full-run*.txt` 实测证据。不做无谓编辑以压小 diff 面。 |
| **D-42** | 文档现状说明（避免按旧登记改错地方） | 本笔记的 §8/§9/§10 存在**两个版本**（checkpoint-2 首版 + 队友后写终版，编号撞车）。经核：**首版（`## §8 文档面（判据⑤，逐项核对表）` 起）才是与当前工作区实况对应的那一版**；后一版（`## §8 文档面（checkpoint 2）` 起）的 `8.3 DOC-1/DOC-2` 描述已被后续重写**推翻**（实测 `SECURITY-GOVERNANCE.md:306` 仍有 `#### 6.1.1 两项已登记的权衡`，`:328` 另有 `### 6.4` 四件套权威表；`DEPLOYMENT.md` 已无 `§6.1.1` 引用）。 | 处置：把后一版降级为 **附录 A**（保留作并发双写的过程记录）并逐条标注失效项；终判（`IS_PASS`）**唯一份**，移到文件末尾（原首版 §10 末尾那份已删，避免两份互相矛盾）。教训：**同节号并写**会让读者按失效记录去"修正"实况 ⇒ 并发批次必须按 §7.5/纪律建议先锁章节归属。 |
| **D-43** | 真机实况订正（R4 失败形态） | B3 真机复现（2026-10-10）证明：误开 `enforceBearer`（双条件齐）后，委派主链路**不是**"当场 failed/401 上抛"，而是**`completed` + `artifacts=1`（仅 `execution-steps` 载体）+ 链上 `zeroInnerCalls:true / underlying:[] / blockedCount:0` + summary「零工具调用；完成声称不予采信」**。VM 内 CLI 的回连（`POST /mcp`、`GET /.well-known/oauth-protected-resource/mcp`）确实全被 401 拒（演练窗口 4 条 warn），但拒绝发生在**工具面**，LLM 会话因此"无工具可用仍口头收尾"。 | 影响面（措辞，不改行为）：SECURITY §2.1 警告块、§6.1 第 3 条、`bridge.ts:163` R4 注释、`CL-022/TECHNICAL-SOLUTION.md:91` 的"当场 401/当场失败/必 401"**四处**超前于实况 ⇒ 应改为「VM 内回连全 401 ⇒ 委派退化为**零副作用的虚假完成**，由 CL-K3R 真值层不予采信兜住；宿主若不带凭据发起则直接 401」。⚠ 该订正由**主理人执笔**（本轮明确指派，我不动那两个文件），证据见 §10-3 与我发回的 `b3-probes.json`/`b3-delegate.json`。同时**推翻我 §10-3 里"链上终态会是 failed"的预判**——真值层判据 `zeroInnerCalls` 才是这次事故的可靠指纹。 |

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
| T | 测试四件（provider-cancel 11 例 / token-env 13 / cancel-consume 17 / llm-cancel 12）+ `host-a2a-bridge.test.js` 同步 | ✅ | 见 §7.2（主理人终审订正：provider-cancel 实测 11 例，非 12） |
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

---

## §8 文档面（判据⑤，逐项核对表）

> 事实源纪律：所有口径**以实现为准**回写文档；文档与实现冲突时改文档并在本节登记。测试基线对外数字（`1247 → 1400 → 1456` 的表述）属 QA 收官批统一口径，**工程侧不动**（`README.md:275` / `docs/06-OVERVIEW.md:4,60` / `phase0-delivery-summary.md` 三处保持原样）。

| 目标 | 位点 | 内容 | 状态 |
|---|---|---|---|
| `SECURITY-GOVERNANCE.md` | **§2.1 新增**「信任边界声明（ARCH-07 裁决结果）」 | 边界=回环+SSH 隧道+审批闸、服务端不鉴权；三点含义（谁能连回环=谁能裸调 / **回环约束不可关** / bearer 可选加固 + `authMode` **三态表**）；⚠ 警告块「开 `enforceBearer` 前须先补齐 VM 内回连凭据通路（尚未实现）⇒ 委派主链路必 401」 | ✅ |
| | **§2.2 新增**「取消的真实语义（ARCH-22）」 | 协作式非抢占；取消成立 ⇒ 取消点后不发起，**不**意味着 VM 未变更；常驻会话被打断会**终结 CLI 子进程**；证据面 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'` | ✅ |
| | **§3.2** 与 `defaults.ts` 逐字 | 表头加「事实源是 `packages/core/src/policy/defaults.ts` 的 `DEFAULT_POLICY`」；路径白名单**六条逐字**（`%USERPROFILE%\**`、`C:\Users\Public\**`、`C:\Temp\**`、`C:\tmp\**`、`D:\Data\**`、`C:\WinVMWorkspace\**`，与 `defaults.ts:71-78` 同序同串）；黑名单/命令黑名单正则/进程黑名单/注册表双表按代码写法照抄；补「四条必须知道的口径」（无 `C:\Users\**`、模式侧展开 fail-closed、命令面只有黑名单 + schema 拒未知键、注册表写读双表成对） | ✅ |
| | **§4.3.1 新增** 校验范围限定语 | `freshChainOnStart:true` ⇒ `verifyChain()` 只校本轮分片；范围**机器可读**（`scope`/`shardsVerified`/`shardsTotal`/`shardsArchived`）；跨轮证据=启动 `verifyArchive()` 落 `chain-archive-verify`；为何只能片内校验；运维读法（别把 `chainValid:true` 读成全链完好）；表下另留 ARCH-06 连读块 | ✅ |
| | **§6.1 / §6.1.1 新增** | 双层认证模型 + 「读 §6.1 必须同时知道的三件事」（免校验是边界声明的一部分 / 双条件 O-9 + 客户端通路 `--token-env`→`buildTransport`→`applyBearerHeader` 三态 / ⚠ VM 内回连未实现）；**两项权衡登记 W-1（`freshChainOnStart`）+ W-2（审计保留期不设上限）**，各含「得到 / 付出 / 当前裁定与理由」 | ✅ |
| | **§6.4 新增** 两项已知安全权衡 | 每条四件套「风险 / 为什么不根治 / 现有缓解 / 运维动作 / 根治归属」；权衡一点名「整片删除不留断裂痕迹」这一最弱环 | ✅ |
| | **§7** 安全默认值汇总 | 新增 **「回环绑定：不可关」** 一行（非回环⇒启动 `error`，`requireLoopbackBind=false` 不再能放宽）；「服务端身份鉴权」改为默认 false + 双条件 + 三态 + 开启前置条件；「任务取消」改协作式真取消 + 入链 + 禁不实承诺；「审计」加校验范围=本轮；§1.1 威胁表 T/D/EoP 三行缓解改述 | ✅ |
| `ARCHITECTURE.md` | §7 机制表 `:290`/`:292`/`:294` 行 | 白名单行补「命令面只有黑名单」；哈希链行加**校验范围限定语**（`scope`/`shards*` + 指向 SECURITY §4.3.1/§6.4）；**新增**「信任边界」「任务取消（真取消）」两行（全链五层） | ✅ |
| | §10 风险表 `:338`/`:340`/`:342` | 「VM 服务等于开放 RCE」缓解改述为信任边界三点 + VM 内任意本地进程都在信任域内；「审计被篡改」改为**本轮期内**+⚠ 残留登记（非"已根治"）；「委派黑盒」加取消终态入链 + `executedBeforeCancel` | ✅ |
| `CAPABILITY-MODEL.md` | `policy` 示例块 `:234-240` | **删除** `"commandAllowlist": []` 一行 ⇒ 命令面白名单口径移除；补 4 行注释（从未被引擎读取 / 唯一写入点已同批移除 / 解释器准入改建为 `input.app` 枚举 + 登记期 `validateParams` / schema `additionalProperties:false` 会**直接拒绝**旧键）；`pathAllowlist` 注释补 `%ENV%\**` 模式侧展开（ARCH-17） | ✅ |
| `docs/changes/CL-022/` | 三件套 | **REQUIREMENT.md**（六条名实落差表 + **三条刻意破坏性 B-1/B-2/B-3** 各含"谁会破/症状/迁移动作" + 刻意不做的事 5 项 + 需求池 R1-1…R5-10 + 影响范围）／**TECHNICAL-SOLUTION.md**（A 取消贯通链 / B 信任边界与鉴权 / C 策略收紧与命令面清理 / D 审计范围与凭据通路 / E 执行体消费与宿主呈现 + 风险与回滚表 + 验证方法含三条破坏性的负向证据）／**QA-REPORT.md**（队友落盘，工程侧自证 + QA 待复核栏） | ✅ |
| `DEPLOYMENT.md` | §8.1（`:450` 原句） | 原「非回环直连会被 `requireLoopbackBind` 拒绝，且会触发 `tokenEnv` bearer 校验」**两处失真**（非回环根本起不来；bearer 默认不校验）⇒ 改为三点块：回环不可关 / bearer 双条件 + 三态 / ⚠ VM 内回连未实现⇒401 | ✅ |
| | §8.5（`:518` 原句） | 原「只有非回环直连才需要 `WINVM_BEARER_TOKEN` + `tokenEnv`」暗示存在受支持的非回环形态 ⇒ 改为本系统不存在该形态、绝大多数部署只需 SSH 密钥、真要开得先看 §8.1 警告块 | ✅ |
| `README.md` | §2.4 强监管内核 5 行 | 「命令白/黑名单」→ **命令面只有黑名单**；哈希链承诺加「本轮运行期内」限定语 + 指向 §4.3.1；网络安全行加「回环不可关」+ bearer 可选（`--token-env`）+ 信任边界一句 | ✅ |
| `overview.md`（仓库根） | 全文核对 | grep `token-env` / `bearer` / `WINVM_BEARER_TOKEN` ⇒ **无 bearer 配置样例**、无与本批冲突口径（只有 `a2a.task.cancel` 的工具名列举）⇒ **无需改动**（不做无谓编辑） | ✅ 核对 |
| `HOST-A2A-BRIDGE.md` | §4.2 / **§4.5 新增** | 工具面 `a2a.task.cancel` 行标注协作式 + `cancelObserved`；新增 §4.5「取消的呈现口径」两态表（机械信号= `executedBeforeCancel` 有/无）+ steps 两级派生 + 重新发起须重新审批。依据：SECURITY §2.2 原文「见 `HOST-A2A-BRIDGE.md`」是**指向本文的悬空引用**，本批补齐（见 D-40） | ✅ |
| `skills/winvm-storage-manager/SKILL.md` | `:35`（D-13） | 「默认路径白名单（与 `defaults.ts` 的 `DEFAULT_POLICY.pathAllowlist` 逐字一致，六条）」同串 + ⚠ 块说明「没有 `C:\Users\**`」与跨账户恒 DENY | ✅ |

### 8.1 文档面的守卫复核（有守卫**读文档文本**，非零风险区）

grep 实测「读 `docs/**` / `skills/**` 文本」的守卫共 4 个文件（**推翻了任务书里"无任何测试读取 docs"的侦察结论**，见 D-39）：`r19b-s1-registry-forms`（`CAPABILITY-MODEL.md` 切片）、`r19b-s5-write-allowlist-pairing`（`skills/winvm-system-admin/SKILL.md` + `docs/design/s5-*.md`）、`r1-approval-card`（`skills/winvm-orchestrator/SKILL.md`）、`host-adapter` / `deploy-shared-skills`（Skill 渲染产物）。文档改完后逐文件复跑：

| 文件 | tests | fail |
|---|---|---|
| `r19b-s1-registry-forms` | 35 | 0 |
| `r19b-s5-write-allowlist-pairing` | 39 | 0 |
| `r1-approval-card` | 69 | 0 |
| `host-adapter` | 35 | 0 |
| `deploy-shared-skills` | 8 | 0 |
| `r3-uninstall-verify`（D-42 补：该文件亦静态切 `CAPABILITY-MODEL.md` §3.2.1 回执语义，属文档守卫输入面） | 39 | 0 |

六个读文档的守卫合计 **225 例 / 0 fail**，终版留档 `$HOME/wbtmp/se2-t5-docguard-final.txt`（逐文件串行，禁 glob、禁与其它 sweep 并发）。同文件另附**机械探针** `$HOME/wbtmp/t5-doc-verify.mjs` 输出：**20 项全 OK**（`$HOME/wbtmp/t5-doc-verify.txt`）。探针价值实证：首轮抓到 `SECURITY §6.1.1 MISS` —— 当时该节确实在并发重写中丢失，我据 §6.4/§4.3.1 实况重建并同时修正 §6 凭据表行与 §6.1 表中残留的「仅非回环直连才需要 bearer」旧口径（与 §2.1 冲突三处）；随后队友写入 §6.4 四件套权威表，形成 W-1/W-2 摘要表（§6.1.1）+ 四件套（§6.4）并存结构，二者以「§6.1.1 指向 §6.4 为权威」的引用关系收敛，不构成双份漂移（见 D-42）。探针另两项首轮 DIFF 经核为**探针自身缺陷**：SKILL 六条写在标记行的下一行（扫描逻辑修后 OK）；`tools.ts`「审批通道已关闭」仅存在于注释中的病灶描述（改为注释感知后 OK）—— 教训：探针报红先判"工具缺陷 vs 真实回归"，与五红判因同一纪律。

---

## §9 一致性审查（全局，跨文件）

| 维度 | 检查 | 结论 |
|---|---|---|
| 契约→框架→服务端→执行体→宿主 取消链路 | `isCancelled`/`cancellationSignal` 是否**同源**（`TaskStore.cancelController` 单主干）；执行体是否两侧都判（轮询 + 事件）；宿主是否只呈现事实 | ✅ 五层贯通，无第二信号源 |
| 码路由 | 取消一律 `TASK_CANCELED`（`retryable:false`）；`goalFail()` 仍 `EXECUTION_FAILED`（未改语义）；`canceledResult()` 不走 `{unavailable}` | ✅ 三条降级红线（`EXECUTION_FAILED+零 artifact`／`PROVIDER_UNAVAILABLE`／常驻不可用回退单次 -p）全部避开，且有对照实验证非空断言 |
| 产物记账口径 | provider 本地集**收纳**、`sink` 外推**关死**、框架 `addArtifact` 终态二次闸、O-2 不落链 | ✅ 三处口径一致（"本地 ≥ 流出"为设计意图，D-37） |
| 文案口径 | provider `goalCanceled`（计数事实）／宿主 `canceledSummaryText`（两态）／SECURITY §2.2 ／ARCHITECTURE §10 ／HOST-A2A-BRIDGE §4.5 | ✅ 同一事实模型，无"未执行任何变更"式承诺（grep 全仓：仅 CL-016 历史归档与审计病灶描述保留，属应当） |
| 白名单口径 | `defaults.ts:71-78` ↔ SECURITY §3.2 ↔ ARCHITECTURE 机制表 ↔ SKILL `:35` ↔ `r3-uninstall-verify`/`p0` 断言 | ✅ 逐字同串（六条，含 `%USERPROFILE%\**`） |
| 凭据通路 | `applyBearerHeader`（**唯一实现**，两条远程分支共用）↔ cli `--token-env` usage ↔ SECURITY §6.1-2 ↔ DEPLOYMENT §8.1 | ✅ 三态语义一致，文档不再谎称默认值 |
| 交叉引用可达性 | SECURITY §2.2→`HOST-A2A-BRIDGE.md`（原悬空，已补 §4.5）；ARCHITECTURE→SECURITY §2.1/§4.3.1/§6.4；SECURITY §6.1.1→`CL-022/TECHNICAL-SOLUTION.md`；DEPLOYMENT §8.1→SECURITY §2.1 | ✅ 全部可达且编号真实存在 |
| 重复实现 | 曾有并发写出的两份 `abortActiveTurn`（薄封装版不杀子进程） | ✅ 已删除薄封装版，保留含 `killChild()` + `turnAbortedByCancel` 唯一版本 |
| 静态守卫输入面 | `channel:` 计数、inner-call ext 计数、C6 两行门、`resolveA2aTimeoutMs`/`case '--timeout'`/`ENV_A2A_TIMEOUT_MS`、tools.ts 剥注释后禁词 | ✅ 未新增/未删除任何被钉出现点（§7.5 抽验全绿） |

---

## §10 移交（给 QA 收官批 / Phase 2）

1. **QA 对外基线口径**：工程侧实测 **79 文件 / 1456 tests / 1454 pass / 0 fail / 2 skipped**（`$HOME/wbtmp/t5-full-run.txt`，文档面后终局复跑 `$HOME/wbtmp/t5-full-run-final.txt`）。`README.md:275`、`docs/06-OVERVIEW.md:4/60`、`phase0-delivery-summary.md` 三处仍是 71/1247 旧口径 ⇒ **由 QA 收官批统一改写**（工程侧不动，避免与 QA 独立复跑数字打架）。
2. **`CL-022/QA-REPORT.md` 需 QA 独立复跑填栏**：§4-B5「QA 独立复跑与智能路由判定」与 §6 判定当前是工程侧自证 + 建议值，权威判定权在 QA。
3. **真机 BLOCKED 三项**（离线不可证，判据原文见 `CL-022/TECHNICAL-SOLUTION.md` 验证方法 §6）：① 委派途中 `tasks/cancel` → VM 内 CLI 子进程消失（`Get-Process` 反查）+ 链上 `canceled`；② win32 `cmd.exe` 包装路径的 signal 透传实跑（本仓是 POSIX，只用形态计数钉 + 变异自证覆盖）；③ 误开 `enforceBearer` ⇒ 委派 401 的正向复现（R4 证据）。
   - **B1 前置事实（真机 provider 实况 ≠ 仓库模板）**：`delivery/vm-service.config.json:12` 写 `workbuddy-deterministic`，但 `install-vm.mjs:703-725` 的优先级是 `--provider > WINVM_VM_PROVIDER > 配置文件`，而 `.env:36 WINVM_VM_PROVIDER=workbuddy` ⇒ **现网实际跑 LLM provider（`kind=llm-agent`）**，实证见 `vm-service-2026-10-06.log` / `qa/r19/e1-vm-service.log` 的 `provider 已就绪 provider:"workbuddy"`。本机 `delivery/.generated/vm-service.runtime.json`（09-30 产物，仍写 deterministic）是**陈旧快照**，不可当现网证据。⇒ B1 无需切 provider：LLM 常驻打断链（`abortActiveTurn`→`killChild`→`taskkill /T /F`）正是真机唯一不可替代的那段；且**必须跑两趟**（早取消 ⇒ 宿主无 `executedBeforeCancel` / 晚取消 ⇒ 有），单次冷启动 ~22.7s 决定 `--settle-ms=8000` 与 `=45000` 各落一态。
   - **B2 定性一条命令**：VM 内 `cmd /c where codebuddy` ⇒ 命中 `.cmd` 即 `isScript=true` ⇒ 每次委派天然走 cmd 包装（B1 样本即覆盖）；命中 `.exe` 才需人为把 `cliPath` 写成 shim 全路径构造。⚠ 正常路径**不打印** `probed` 候选（只在解析失败文案里，`bridge.ts:1442`）⇒ 服务日志证明不了命中态，必须实测。
   - **B3 已真机复现（2026-10-10，主理人授权后由我执行）——实况订正**：双条件齐（runtime 加 `enforceBearer:true` + `start-hidden.ps1` 注入 `WINVM_BEARER_TOKEN`，kill-restart）⇒ `/health.security.authMode='bearer-enforced'`；无凭据 `POST /a2a` ⇒ **`401 {"error":"unauthorized","code":"AUTH_REQUIRED"}`**（错 token 同 401；带对 token 200；`GET /health` 仍 200 ⇒ 豁免面成立）。
     ⚠ **失败形态与文档警告不同，须订正措辞**：委派任务**不会**"当场 failed"——宿主带凭据发起后，A2A 终态是 **`completed`**、`artifacts` 数 = **1**（载体 `execution-steps`，非能力产物），因为 VM 内 CLI 在会话启动阶段回连 `/mcp` 与 `/.well-known/oauth-protected-resource/mcp` 被拒（演练窗口内 **4 条** `bearer 守卫拒绝请求 reason:missing-authorization-header`），**没有可用工具**于是"口头完成"。真正兜住这次事故的是 CL-K3R 真值层：链上 `delegation-complete` 记 `ext.zeroInnerCalls:true`、`underlying:[]`、`blockedCount:0`，summary 写黑「**零工具调用；完成声称不予采信**」；拒绝**只进 logger.warn 不入链**（本批纪律，链上无新增拒绝条目即符合预期）。⇒ R4 的准确表述应是「误开 ⇒ VM 内回连全 401 ⇒ 委派退化为**零副作用的虚假完成**（靠真值层不采信）」，而非「委派当场失败/401 上抛」。我此前 §10 预判的「链上终态会是 failed」**已被实测推翻**（实测 completed），在此留痕。
     **复原已复验**：两文件与演练前备份逐字节相同（`RUNTIME_IDENTICAL` / `PS1_IDENTICAL`）、`authMode` 回 `bearer-configured-missing`（判序③，非 `loopback-only`）、无凭据 `POST /a2a` 回 200、`provider=workbuddy/ready`（重启后首轮 `/health` 探针 5s 超时呈 `degraded` 属预期，约 20s 后自愈）。证据：`$HOME/wbtmp/b3/b3-probes.json`、`b3-delegate.json`、`b3-delegate.timeline.log`（VM 侧原件 `C:/WinVMBridge/dev-and-qa/scratch/`，辅助脚本 `b3-patch-ps1.mjs`/`b3-probes.mjs`/`b3-delegate.mjs` 同目录）。
     **操作纪律（QA 复用）**：① 双条件缺一不可 —— 只加 `enforceBearer:true` 而不给 env 值 ⇒ 落判序②，守卫不挂、401 不出现（`start-hidden.ps1` 由 `install-vm.mjs buildTaskXml:237-241` 生成，默认不注入 `WINVM_BEARER_TOKEN`，全 `delivery/` 里该串只作为 `tokenEnv` 名出现）；② 配置只在启动时读 ⇒ 改完必须 kill-restart，并以 `/health.audit.shardsTotal` 递增 + 日志新启动行确认进程真的换过；③ `deploy-vm --apply` 会重写 runtime 与 `start-hidden.ps1` 并 `/Delete`+`/Create` 重建任务（`:742-750`）⇒ **演练必须放在部署收尾之后**，且改前先 `cp -p` 备份到 `dev-and-qa/scratch/`；④ 本轮走的是"动现网实例 + 复原"路线（做法 B）而非另端口手启（做法 A）—— 若只要差分探针，做法 A 零污染，优先 A。
   - **取证面两个已知陷阱**（写报告前先看，免得拿错证据）：① 常驻路径 `dtid` 不生效（`mcp.json` 会话级共享，`delegation-audit.ts:420-421`）⇒ 能力 executed 条目归因是 `attribution:'window'`，**按 `delegationId` 精确匹配会一无所获**，要按 traceId/时间窗找（链上 `complete` 条目的 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'` 才是判据）；② 既有 `qa/r19/t4-acc3-cancel.out.json` **缺 `evidence` 键** ⇒ 不是当前 `a2a-extra.mjs` 落的盘，本轮须确认 out.json 含 `evidence:{file,bytes,mtime}`；另该脚本头注释的运行路径写作 `/storage/Users/currentUser/wbtmp/a2a-extra.mjs` 而仓库副本在 `qa/r19/`，两份须先对齐再取数。B3 的 401 拒绝**只进 `logger.warn` 不入审计链**（`server.ts:1430-1438` 取证纪律）⇒ 别在链上找 401，链上"无新增条目"本身就是判据。
4. **观察项（建议 Phase 2 处理，本批刻意不动）**：
   - **O-1**：确定性模板路径把 `execute` 的契约码折叠成 `EXECUTION_FAILED`（`step()` 只上抛 `res.error.message` 字符串）⇒ 策略拒绝码 `POLICY_DENIED` 在模板结果里不可见。已用断言钉住**既有形态**，是否让 `step()` 保留契约码待裁。
   - **O-3**：`launchCliProcess` 是 `bridge.ts` 内部导出、未从包公共面透出 ⇒ 测试只能直连 `dist/bridge.js`。不为测试擅自扩公共面。
   - **ARCH-18 schema 未接运行期校验**（`phase1-t1-notes.md` D-3）：`additionalProperties:false` 的拒止能力尚未在运行路径兑现 ⇒ B-2 破坏性目前主要靠交付/CI 侧暴露。
   - 权衡一根治（持久链头 + 跨片衔接 + 分片外部锚定）与权衡二（保留期 + 签名导出归档）→ Phase 2 独立立项。
5. **纪律建议（本批踩到，值得入团队规约）**：
   - 改 `src` 后**立即** `tsc -b --force` 再跑测（本批 2 个红纯属 dist 陈旧，见 §7.2 #3/#4）。
   - 全量 sweep 的留档路径**按成员隔离**（两个 sweep 共用 `t5-full-run.txt` 造成过一次交错假红，见 `CL-022/QA-REPORT.md` §5-2）。
   - "文档不是零风险区"：4 个守卫读文档/Skill 文本（D-39）⇒ 改文档也要走守卫复跑。

---

# 附录 A · checkpoint-2 首版记录（**并发双写留痕，部分结论已被推翻**）

> ⚠ 阅读须知（D-42）：本附录与上方 §8/§9/§10 编号撞车（历史原因：队友后写终版，我先前落的 checkpoint-2 首版未改号）。
> **实况以正文 §8/§9/§10 为准**；本附录仅保留"过程证据"，其中 A.3 的 DOC-1/DOC-2 两条**处置已被后续重写推翻**（见 A.4 勘误）。终判 `IS_PASS` 只有一处，在文件末尾。

> 判据⑤ 全覆盖；文档改动**零测试依赖**（无任何 `tests/**` 读 `docs/**`），故不触发守卫，仅需口径核验。
> 本区为「面与文」的**文**半边；八文件实际由 software-engineer-1（§2/§4.3.1/§6.4/§7 主体、README、HOST-A2A-BRIDGE、ARCHITECTURE 主体）与我（CAPABILITY-MODEL、OVERVIEW、DEPLOYMENT 引用修正、SKILL.md 白名单、CL-022 三件套）分工完成。

### A.1 八文件 numstat（git 只读实测，**当时快照**）

```
 3 3  README.md                       （队友：bearer 段；我未动）
 7 5  docs/02-design/ARCHITECTURE.md  （队友：§安全机制表 + §10 风险表缓解改述 + 信任边界/真取消行）
 6 2  docs/02-design/CAPABILITY-MODEL.md（我：policy 示例去 commandAllowlist + pathAllowlist %ENV% 注）
15 1  docs/02-design/HOST-A2A-BRIDGE.md（队友：a2a.task.cancel/executedBeforeCancel/cancelObserved 呈现口径）
103 14 docs/02-design/SECURITY-GOVERNANCE.md（队友主写 §1.1/§2.1/§2.2/§3.2/§4.3.1/§6.1/§6.4/§7；我删重复 §6.1.1）
 7 2  docs/05-peripherals/DEPLOYMENT.md（队友：§8.1 bearer 块 + §8.5 边界；我：§6.1.1→§2.1/§6.4 失效引用修正）
 5 3  docs/06-OVERVIEW.md             （我：三道闸口径 + 网络信任边界段）
 9 1  skills/winvm-storage-manager/SKILL.md（我：§35 白名单六条逐字对齐 + 跨账户 DENY 说明）
```

> **终版 numstat 对照**（同区快照之后又动了 SECURITY 与 notes 本身，git 只读实测）：`SECURITY-GOVERNANCE.md 117/17`（§6.1.1 重建 + §6/§6.1 三处旧口径修正，见 A.4-2）、`README.md 3/3`（§2.4 五行口径）、`DEPLOYMENT.md 7/2`、`HOST-A2A-BRIDGE.md 15/1`（新增 §4.5）、`phase1-t5-notes.md 152/1 → 本区增量`。其余四文件未再变。

### A.2 判据⑤逐项核验

| 子判据 | 要求 | 落点 | 结论 |
|---|---|---|---|
| §2 信任边界 | SECURITY 含信任边界声明 | §2.1（回环不可关 + authMode 三态 + enforceBearer 前置条件 R4） | ✅ 队友写，口径核对无误 |
| §6 两项权衡 | `freshChainOnStart` / 审计保留期 | §6.4 权衡一（W-1）/ 权衡二（W-2） | ✅ 队友写（⚠ 本行结论已被 A.4 勘误修正：§6.1.1 摘要表与 §6.4 四件套**并存**，以 §6.4 为权威） |
| §3.2 逐字对齐 | 与 `defaults.ts` 六条逐字 | §3.2 表 + 四条口径；实测三处（代码/SECURITY/SKILL.md）同串 | ✅ 逐字核对通过（见 §9 一致性） |
| §4.3 校验范围限定语 | 本轮 scope + 跨轮 archive-verify 证据 | §4.3.1（含"别把 chainValid 读成全链完好"） | ✅ 队友写，限定语完整 |
| §7 回环不可关一行 | 安全默认值表 | §7 表「回环绑定：不可关」行 | ✅ 队友写 |
| ARCHITECTURE 限定语 | :292/:340 校验范围 + :336 风险表缓解 | 机制表「哈希链审计」行 + 风险表「VM 服务等于开放 RCE」「委派黑盒」「审计被篡改」三行改述 | ✅ 队友写 |
| CAPABILITY-MODEL 白名单口径移除 | :201 命令面白名单 | policy 示例块（实际行号 :234-239，:201 为 appops 表格，已按 numstat 定位修正）| ✅ 我写 |
| CL-022 三件套 | REQUIREMENT/TECHNICAL-SOLUTION/QA-REPORT，含 3 条刻意破坏性 | 三文件齐；B-1 白名单收紧 / B-2 commandAllowlist 移除 / B-3 回环不可关 逐条写黑 | ✅ 队友主写 REQUIREMENT/TECHNICAL-SOLUTION；我补 QA-REPORT + CL-022 引用核验 |
| DEPLOYMENT/README/OVERVIEW | `--token-env` 与 bearer 样例核对 | DEPLOYMENT §8.1/§8.5、README :65、OVERVIEW 三道闸 | ✅ 队友 + 我；**测试基线数字（1247→1400→1456）未动**（属 QA 收官批） |
| SKILL.md D-13 | 白名单六条逐字 | winvm-storage-manager/SKILL.md §35 | ✅ 我写 |

### A.3 文档面缺陷修复（本区，**当时处置**）

| # | 现象 | 判因 | 处置 |
|---|---|---|---|
| DOC-1 | SECURITY 出现两处权衡表：队友 §6.4（权威）+ 我 §6.1.1（W-1/W-2） | **并发双写**：分工前我已落 §6.1.1，队友随后写了更完整的 §6.4 四件套版 | ~~删我的 §6.1.1（保留队友 §6.4）~~ ⇒ 已推翻，见 A.4 |
| DOC-2 | DEPLOYMENT:455 引用 `SECURITY §6.1.1`（被我删的节） | 引用未随 DOC-1 更新 | 改指 `§2.1（启用前置）/§6.4（权衡）`；全仓 `grep §6.1.1` 已无残留（**DEPLOYMENT 侧结论仍成立**） |

### A.4 勘误（D-42 · 终版核验，以工作区实况为准）

1. **DOC-1 的处置已失效**：`SECURITY-GOVERNANCE.md:306` 现仍存在 `#### 6.1.1 两项已登记的权衡（W-1/W-2 摘要表）`，与 `:328 ### 6.4 两项已知安全权衡（四件套权威表）**并存**。这不是"忘了删"：§6.1.1 开头显式声明「详细四件套…在 §6.4，权威表在 `CL-022/TECHNICAL-SOLUTION.md` 风险与回滚」，即**摘要 + 权威**的引用关系，单一事实源未被破坏（判定依据：两处裁语文案同源、无冲突口径）。探针项 `OK SECURITY §6.1.1 两项权衡` 即钉这一现状。
2. **§6.1.1 的真实历史是"丢失—重建"，不是"删除"**：队友一次重写曾把该节整体抹去，同时残留 §6 凭据表行「`Bearer token`（非回环直连）」与 §6.1 表/blockquote 的「仅当 `bind ≠ 127.0.0.1` 才强制 `tokenEnv`」三处旧口径 —— 与 §2.1（回环不可关 + 双条件 O-9）直接冲突。机械探针抓出后我做了三处修复：**重建 §6.1.1**、改 §6 表行为「名称由宿主 `--token-env` / `tokenEnv` 指定…仅在 VM 侧开 `enforceBearer` 时参与校验」、改 §6.1「何时需要」为双条件 + ⚠「非回环直连不是可用形态」。
3. **结论修正**：文档面**并非**"零测试依赖"（同区开头那句话是 D-39 推翻前的旧口径，保留以显示判因过程）；实况是 6 个守卫读文档/Skill 文本，合计 225 例已复跑全绿（正文 §8.1 表）。

---

## 附录 A · §9 一致性审查（全局，跨文件）

| 维度 | 核查 | 结论 |
|---|---|---|
| 契约码一致 | `TASK_CANCELED` 在 provider（`goalCanceled`）/ LLM 桥（`canceledResult`）/ 服务端 observer（三分支）/ 宿主文案（判据③）四处同源 | ✅ 均经 `makeError('TASK_CANCELED',…)`，无一折叠为 `EXECUTION_FAILED`（守卫 §3a 对照实验证） |
| 取消不落降级 | `canceledResult` 返回 `{result}` 非 `{unavailable}`；`runOneShot` abort 先于 error 归因 | ✅ 三条路径均绕开 `shouldDegrade`（§3b/§3c） |
| 白名单三处逐字 | `defaults.ts:71-78` ↔ SECURITY §3.2 ↔ SKILL.md §35 | ✅ 六条同串（`%USERPROFILE%\**` 起首，无 `C:\Users\**`） |
| 权衡登记面 | ~~freshChain / 保留期仅 §6.4 一处~~ ⇒ **终版实况**：§6.1.1 摘要表（W-1/W-2）+ §6.4 四件套（权威）并存，§6.1.1 显式指向 §6.4 | ✅ 无冲突口径；单一权威源在 §6.4/`CL-022` 风险表，摘要不引入第二套裁语（详见 A.4） |
| 引用完整性 | CL-022 内 `§` 引用锚点 | ✅ 抽查 §2.1/§2.2/§3.2/§4.3.1/§6.4/§7 均存在；DEPLOYMENT 侧 `§6.1.1` 死链已修（DOC-2），SECURITY 内部 §6.1.1↔§6.4 互指可达（A.4 核验）|
| 守卫输入面未被放宽 | 本批未改任一静态判据；`grep 审批通道已关闭` 代码/测试无残留 | ✅ 无放宽（冲突时均按"改实现/改测试断言"而非"改守卫"处置）|
| 无占位符/无 TODO | 五源文件 + 三件套全文 | ✅ 无 `pass/TODO/...`；无未实现分支 |

---

## 附录 A · §10 移交（首版，与正文 §10 互补，正文为准）

1. **真机判据 B1–B3**（`CL-022/QA-REPORT.md` §4）：①②③端到端取消、win32 cmd 包装 signal 实跑、误开 enforceBearer 的 401 复现 —— 均需主理人部署 T5 码后执行。
2. **测试基线数字对外口径**：T5 后 **79 文件 / 1456 tests / 1454 pass / 0 fail / 2 skip**（+4 文件 +56 例 vs T4）。`docs/06-OVERVIEW.md` 与 `README.md` 的"1247 例"基线属 Phase 0 收官口径，**本批未改**（任务书明列属 QA 收官批）。QA 收官批统一更新时注意 `phase1-t5-token-env` 对 `applyBearerHeader` 三态的固化（O-2）勿重复计为新功能。
3. **观察项 O-1**（模板路径 execute 的 `POLICY_DENIED` 被折叠成 `EXECUTION_FAILED`）与 **O-3**（`launchCliProcess` 未从包 index 再导出，测试直连 dist）：均非本批范围，建议后续单独评估是否扩 step() 契约码保真 / 扩公共导出面（属契约动作，须评审）。
4. **并发双写教训**（供团队纪律）：本批 T5 源码面与 software-engineer-1 撞车两次（`abortActiveTurn` 重复实现致 TS2393；全量 sweep 共用 `$HOME/wbtmp/t5-full-run.txt` 致档期污染假红）。建议后续批次**开工前先锁文件归属**、**每成员独立留档路径**。

---

## 终判（全文唯一份 · checkpoint 1 + 2 合并）

- **代码面（checkpoint 1）**：5 源文件（provider `index.ts` / `bridge.ts` / `persistent-session.ts` / 宿主 `tools.ts` / 客户端 `cli.ts`）+ 1 既有测试同步 + 4 新守卫文件（17+12+11 + `phase1-t5-token-env`）；`tsc -b tsconfig.build.json --force` **exit 0**；全量逐文件对账 **79 文件 / 1456 tests / 1454 pass / 0 fail / 2 skipped**（`$HOME/wbtmp/t5-full-run.txt`、终局复跑 `$HOME/wbtmp/t5-full-run-final.txt` 两次一致），15 个受影响既有守卫抽验全绿（正文 §7.5）。
- **抹痕缺陷闭合**：`step()` 出口取消分支改为「本地集收纳、流出面关死」（D-37 主理人裁定），两处测试期望同步为 `===1` / sink `===0`，并加「本地账 > 流出面」分叉钉防口径再漂；未反向放宽任一断言。
- **文档面（checkpoint 2）**：8 文件 + `CL-022/` 三件套（REQUIREMENT 132 行含 B-1/B-2/B-3 三条刻意破坏性、TECHNICAL-SOLUTION 297 行 A–E 五组含负向证据、QA-REPORT 110 行由 software-engineer-1 落盘、工程侧自证栏待 QA 独立复跑）齐；判据⑤ 逐项通过（正文 §8 表）。
- **文档面机械核验**：探针 `$HOME/wbtmp/t5-doc-verify.mjs` **20 项全 OK**（含 `defaults.ts:71-78` 六条与 SECURITY §3.2 / SKILL `:35` 顺序敏感逐字比对）；6 个读文档守卫 **225 例 / 0 fail**（`$HOME/wbtmp/se2-t5-docguard-final.txt`）。探针抓出并修复一处**真实回归**：SECURITY §6.1.1 曾在并发重写中丢失 + §6/§6.1 三处「仅非回环直连」旧口径残留（与 §2.1 冲突），已重建/修正（取证见 A.4）。
- **notes 自身**：§7 执行进度表（六文件区完成态 + 五红逐条判因 2 替身 / 2 dist 陈旧 / 1 实现缺口 + 计数与全量对账）、§8 文档面逐项 + §8.1 守卫复核、§9 一致性审查九维度、§10 移交；偏差登记 **D-31…D-42**；checkpoint-2 首版与终版编号撞车已降级为**附录 A** 并逐条勘误（D-42）。
- **纪律**：全程零 git 写操作（仅 `status` / `diff` / `numstat` 只读子命令，统一由主理人提交，代码面已入库为 `c2e902a`）；零守卫放宽（冲突一律按"改实现 / 改测试断言"处置）；仓库根调试残留 `.t5dbg.mjs` 已删除。

**IS_PASS: YES**
