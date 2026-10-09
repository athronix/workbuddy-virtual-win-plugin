# CL-022 · Phase 1 安全边界兑现批（真取消 / 信任边界 / 策略收紧 / 链范围 / 凭据通路 / 文档兑现）

> 变更标识：`CL-022` ｜ 代号：**Phase 1 安全兑现批** ｜ 性质：**安全语义兑现 + 契约破坏性清理 + 文档口径对齐**
> 范围：5 个任务 —— **T1** 契约与配置基座（`4983a58`）／**T2** core 执行内核（`6e9b951`）／**T3** a2a-framework 真取消与有界化（`1283846`）／**T4** vm-service 装配层（`90db1ad` + 真机取证 `390c5da`）／**T5** 执行体消费 + 宿主呈现 + 客户端 CLI + 文档兑现（本批，待提交）。
> 上游依据：`docs/changes/phase1-arch-design.md`（ARCH-22 / ARCH-05 / ARCH-06 / ARCH-07 / ARCH-17 / ARCH-18 / ARCH-21 / ENG-08 / ENG-23）；需求源 `docs/audit/2026-10-08-comprehensive-assessment.md` §4 Phase 1 清单。
> 实施记录：`phase1-t1-notes.md` … `phase1-t5-notes.md`（含偏差登记 D-1 … D-38）。
> 最终验证结论：见同目录 `QA-REPORT.md`。

---

## 1. 变更概述

**一句话**：Phase 0 把"止血"做完之后，本批把**六条早已写在文档里、但运行期不成立的安全承诺**逐条兑现成代码事实，并把文档口径**逐字对齐实现**——取消从"假动作"变成"能力调用边界上的真停"，信任边界从"含糊的 bearer 兜底"变成"回环不可关 + 服务端不鉴权 + 误开必 401 的显式声明"，策略默认值从"覆盖全体账户的白名单"收紧为"只覆盖当前服务用户"，审计从"`chainValid:true` 被当成全链完好"变成"校验范围机器可读"。

### 1.1 六条承诺的"名"与"实"（本批要闭合的落差）

| # | 文档/用户以为的语义 | 本批改动前的运行期事实 | 本批兑现后 |
|---|---|---|---|
| **P1** 任务取消 | `tasks/cancel` 能叫停 VM 内的操作 | 只把 TaskStore 的 `cancelRequested` 置真、把 task 改成 `canceled`；**执行体从不读它** ⇒ provider 继续发起能力调用、LLM CLI 继续自行操作，取消是纯记账动作 | 三层协作式取消贯通（契约 `isCancelled()/cancellationSignal` → 框架终态守卫 → 执行体在**每一次能力调用边界**消费）；常驻 LLM 会话被打断时**终结其 CLI 子进程** |
| **P2** 白名单拦截 | 服务端有 bearer 鉴权兜底 | `enforceBearer` 在配置里存在但**从未有消费点**；回环约束可用 `requireLoopbackBind:false` 关掉 | 信任边界**显式声明为"回环 + SSH 隧道 + 审批闸，服务端不鉴权"**；回环约束**不可关**；`enforceBearer` 双条件才挂载守卫，生效与否由 `/health.security.authMode` **三态**透出 |
| **P3** 路径白名单 | 只放行 VM 使用者自己的目录（`C:\Users\<vmuser>\**`） | 默认值实为 `C:\Users\**` ⇒ **覆盖全体账户**，而 `storage.file.read` 是 L0 免审批 ⇒ 跨账户桌面/文档/下载被策略层直接放行 | 收紧为 `%USERPROFILE%\**`（模式侧运行时展开）⇒ 跨账户恒 `pathAllowlist:miss` **DENY** |
| **P4** 命令面管控 | 策略引擎按"命令白名单"只允许清单内命令 | `commandAllowlist` 是**死配置**（引擎从未读取），全仓唯一写入点还在给 `appops.workflow.run` 声明 9 个解释器正则 ⇒ 运维以为配了就有约束 | **字段删除**（契约 / 配置 / schema / 默认值四处同批），口径改为"命令面只有黑名单"；解释器准入由 `appops.cli.invoke` 的 `input.app` 枚举 + 登记期 `validateParams` 把守 |
| **P5** 审计防篡改 | `chainValid:true` ⇒ 全部历史审计未被篡改 | `freshChainOnStart:true` ⇒ 每次启动以 GENESIS 重开新分片，`verifyChain()` **只覆盖本轮**，跨轮历史（含"整片删除"）不在判定面内 | 校验范围**机器可读**（`scope` / `shardsVerified` / `shardsTotal` / `shardsArchived`）+ 启动 `verifyArchive()` 落 `chain-archive-verify` 链上条目提供跨轮证据；残留风险**显式登记为权衡**而非"已根治" |
| **P6** 审批结论留痕 | 批准/拒绝/超时/取消都入链 | 只有批准入链，拒绝/超时/取消被折叠或不写 ⇒ 无法反查"谁在什么时候说了不" | 三态各产出一条链上条目（`ext.kind:'approval-decision'`、`matchedRule='approval-decision:<d>'`），超时去重（一次超时只一条）；取消终态带 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'` |

### 1.2 三条**刻意破坏性**变更（必须写黑，不允许"顺手兼容"）

> 本批刻意引入三处**对既有配置/既有期望不兼容**的变更。每一条都是"名实不符"的代价转嫁给配置方，理由与迁移动作如下。三条**都不提供过渡期兼容读取**（裁决依据：`phase1-arch-design.md` §6 第 7 条 —— 留过渡期等于把死字段延续一个版本，与 Phase 2 门禁冲突）。

| # | 破坏性变更 | 谁会破 | 症状（升级后若不处理） | 迁移动作 |
|---|---|---|---|---|
| **B-1** | **默认路径白名单收紧**：`DEFAULT_POLICY.pathAllowlist` 去掉 `C:\Users\**`，改为 `%USERPROFILE%\**`（ARCH-17） | 依赖"跨账户读写"的既有工作流（多账户 VM、或曾被误放行的 `C:\Users\<他人>\...` 路径） | 相关请求返回 `POLICY_DENIED`，`matchedRule:'pathAllowlist:miss'`；`storage.file.read`（L0 免审批）不再能读别的账户桌面 | 确有需要时由运维在部署配置里**显式追加**目标账户路径（`mergePolicy` 对数组做并集 ⇒ 只能加不能减）；⚠ 反向不成立：**收紧后的默认值无法靠"少配一条"删掉** |
| **B-2** | **删除 `commandAllowlist`**（ARCH-18）：从 `contracts/src/capability.ts`（`CapabilityPolicy`）、`core/src/policy/defaults.ts`（`PolicyConfig` + 默认值 + `mergePolicy` 行）、`contracts/schemas/capability.schema.json` **四处同批删除** | 任何仍在能力定义或部署配置里写 `policy.commandAllowlist` 的用户 | ⚠ **不是静默忽略**：`capability.schema.json` 的 `policy.additionalProperties === false` ⇒ 携带该键的能力定义被 schema **直接拒绝**（该 schema 当前未接入运行期校验，风险面见 `phase1-t1-notes.md` D-3，但交付/CI 侧一旦接入即当场报错） | 升级前**删掉该键**；需要约束解释器/命令的，改用 `appops.cli.invoke` 的 `input.app` 枚举或能力级 `commandDenylist` |
| **B-3** | **回环约束不可关**（ARCH-07）：`bind` 非回环（如 `0.0.0.0`）⇒ 校验**恒 error 且启动被拒**；`security.requireLoopbackBind=false` 不再能放宽，只额外产生一条 warning | 曾靠 `requireLoopbackBind:false` 让服务直接对外监听（把 `18443` 裸暴露给内网）的部署 | `vm-service` **起不来**（启动阶段 fail-closed） | 唯一受支持的跨机形态 = 宿主侧 `ssh -L … 127.0.0.1:18443` 隧道（见 `DEPLOYMENT.md §8`）；若确需 bearer 加固，另配 `security.enforceBearer`（**注意**：VM 内回连凭据通路本批未实现，误开 ⇒ 委派主链路 401，见 §2.4） |

### 1.3 本批刻意**不做**的事（同样属于需求边界）

| 项 | 为什么不做到本批 |
|---|---|
| **VM 内回连凭据通路**（`buildMcpConfig()` 下发给 agent CLI 的 `mcpServers` 条目带凭据） | 设计 §5 第 3 条明写为 `enforceBearer` 的**启用前置条件**、而非本批交付项。本批只做两件事：① 在 `bridge.ts` 源码处**注释登记**该前置条件；② 在 SECURITY/ARCHITECTURE/DEPLOYMENT 三处文档把它写黑为**中危残留风险 R4**。真去实现需要 env 分发机制 + 部署脚本发 token + 两侧回归，与"兑现已承诺语义"的目标正交 |
| **审批记录 TTL 回收 / 过期作废** | §3.4 的"审批超时默认拒绝"在 V1 由"未获批准一律不执行"成立（MCP 侧未带有效 `approvalId` 恒 `APPROVAL_REQUIRED`；A2A 侧任务在 VM 侧持续挂起）。显式 TTL 属独立变更；本批 T4 只把 `PendingApprovalRegistry` **有界化**（`sweepExpired` 不扫 `hostApproved:true` 在途条目、`close()` 后无定时器残留） |
| **审计持久链头**（跨启动续链） | 与既有分片文件、`activeShards` memoize 及全部以"本轮链"为前提的断言同时冲突，属独立 P0 立项（`SECURITY-GOVERNANCE.md` §6.4 权衡一） |
| **审计保留期 / 自动归档** | 保留期是合规口径而非工程默认值（§6.4 权衡二）；工程侧擅自清理会造出"审计被抹"的可疑窗口 |
| **取消改为抢占式**（真杀进程/回滚） | 协作式是 ARCH-22 的明确粒度（一次能力调用）；抢占式需要 psmod 侧每个能力实现可中断 + 回滚语义，本批只做边界消费与**CLI 子进程终止**（常驻会话这一例是"边界外唯一必须硬停"的情形，因为 CLI 会自行继续发起工具调用） |

---

## 2. 需求池（按任务分组）

### 2.1 T1 · 契约与配置基座（P0）

| ID | 需求 | 优先级 |
|---|---|---|
| R1-1 | `ProgressSink` 纯附加 `isCancelled?(): boolean` 与 `cancellationSignal?: AbortSignal`（缺席 = 逐字旧行为） | **P0** |
| R1-2 | `BridgeErrorCode` 约定串含 `TASK_CANCELED`（`retryable:false`）；`AUTH_REQUIRED` **刻意不入枚举** | **P0** |
| R1-3 | `AuditSink.verifyChain()` 返回体可承载**校验范围**（`scope` / `shards*`）；`AuditExt.kind` 扩展 `approval-decision` / `chain-archive-verify` | **P0** |
| R1-4 | `HealthStatus.audit` 透出范围字段 | P1 |
| R1-5 | `SecurityConfig` 纯附加 `enforceBearer?: boolean`；`validateServiceConfig` 非回环恒 **error**、`requireLoopbackBind:false` 转 warning、`tokenEnv` 有名无值 ⇒ warning | **P0**（B-3） |
| R1-6 | 删除 `CapabilityPolicy.commandAllowlist` 与 schema 属性（不留 `@deprecated`） | **P0**（B-2） |
| R1-7 | `SshTunnelTransport` +`tokenEnv?`（客户端凭据通路契约就位） | P1 |

### 2.2 T2 · core 执行内核（P0）

| ID | 需求 | 优先级 |
|---|---|---|
| R2-1 | 策略路径白名单支持 `%ENV%\**` **模式侧运行时展开**（`expandPolicyPathPattern`，先展开后归一，与 config 层共用同一 `expandEnvPath`）；env 缺席 ⇒ 保持字面 ⇒ 永不匹配 ⇒ **fail-closed** | **P0** |
| R2-2 | 默认 `pathAllowlist` 收紧为六条（B-1） | **P0** |
| R2-3 | 引擎删除 `cmdAllowRe` 编译与读取点（P4） | **P0** |
| R2-4 | `verifyChain()` 返回 `scope`/`shardsVerified`/`shardsTotal`/`shardsArchived`，且 `valid` 判定与旧版**逐字一致**（不得因加字段改判定） | **P0** |
| R2-5 | 新增 `verifyArchive()`：非本轮分片**逐片独立**「片内 seq 单调 + 片内 prevHash 链式」；`maxShards` 有界（超出只计数不校验）；全程不抛，读不到 ⇒ 该片 `valid:false, reason:'UNREADABLE:<code>'` | **P0** |
| R2-6 | 抽 `applyBearerHeader(headers, tokenEnv, env)` 为**两条远程传输分支唯一实现**；三态：无 tokenEnv 不加头／有值加 `authorization: Bearer <token>`／有名无值**抛 `TransportError`**（ssh-tunnel 分支校验**前置到建隧道之前**） | **P0**（ENG-23） |

### 2.3 T3 · a2a-framework 真取消 + 有界化（P0）

| ID | 需求 | 优先级 |
|---|---|---|
| R3-1 | `requestCancel` 顺序纪律 **O-1**：abort **先于** `updateStatus` | **P0** |
| R3-2 | `TaskStore.isCancelled()` / `cancellationSignal()`（与 `cancelController` **同源**）；`createProgressSink` 透出两成员 | **P0** |
| R3-3 | `addArtifact()` 对终态任务返回 `false` 且**不 emit**（canceled/failed/completed 三态一致） | **P0** |
| R3-4 | `runGoalWithLifecycle` 取消收口 **O-2** 严格三不：不落 artifacts（含 steps 载体）、不调 `updateStatus`、不写 `goalSummary/stepCount` metadata；只 `observe` | **P0** |
| R3-5 | catch 分支：已取消**不改判** failed（**O-4** 优先级 `canceled > timeout > rejected`） | **P0** |
| R3-6 | `DelegationTerminalSnapshot.state` +`'canceled'`，且 `result` **在场**（宿主事实化的证据源） | **P0** |
| R3-7 | `TaskStore` 有界化：`maxTasks` / `terminalTtlMs`；驱逐**只删终态最旧者**，活动与挂起审批任务必留；`maxTasks:0/undefined` ⇒ 完全不驱逐（旧测试逐字绿） | **P0**（ENG-08） |

### 2.4 T4 · vm-service 装配层（P0）

| ID | 需求 | 优先级 |
|---|---|---|
| R4-1 | `createBearerGuard`（新纯模块，可脱 ps-bridge 单测）：双条件才挂载；非豁免端点错 token ⇒ 401；`/health` 与 agent-card 豁免；`timingSafeEqual` 比对 | **P0** |
| R4-2 | `PendingApprovalRegistry`（新纯模块）：有界 + `sweepExpired` + `startTimer/close`；不扫 `hostApproved:true` 在途条目 | **P0** |
| R4-3 | 审批决策入链：拒绝/超时/取消各一条（去重），复用既有 `try/catch` + `BlockedAuditOptions` 纪律（**O-5**：不得为取证引入可挂死 IO） | **P0**（P6） |
| R4-4 | 取消终态入链 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'`；observer **O-3 三分支** | **P0** |
| R4-5 | `/health.security.authMode` 三态 + `/health.audit.scope` 等范围字段；启动 fire-and-forget 落一条 `chain-archive-verify` | **P0** |
| R4-6 | 回归关键：`enforceBearer=false`（现网 `delivery/vm-service.config.json` 无该键）⇒ 路由**逐字旧行为** | **P0** |
| R4-7 | `server.ts` 是本批**唯一写者**约束（其余任务不得并发改它） | 纪律 |

### 2.5 T5 · 执行体消费 + 宿主呈现 + 客户端 CLI + 文档兑现（P1）

| ID | 需求 | 优先级 |
|---|---|---|
| R5-1 | 确定性 provider `step()` **咽喉点**取消闸：取消后模板**不再发起下一次能力调用**；返回 `TASK_CANCELED` 失败形状 | **P0**（判据①） |
| R5-2 | 取消收口**绝不得**折叠成 `EXECUTION_FAILED` —— LLM provider 的 `shouldDegrade` 会把「`EXECUTION_FAILED` 且零 artifact」回落成确定性执行器**重跑**（= 把用户已叫停的任务再执行一遍） | **P0**（安全红线） |
| R5-3 | 双闸产物纪律：外推面 `sink.onArtifact` 取消后为 0；**本地 `GoalResult.artifacts` 仍如实承载取消点前已完成的产物**（不得抹痕；宿主文案计数与 QA 反查的唯一可读事实源） | **P0**（主理人裁定，`phase1-t5-notes.md` D-37） |
| R5-4 | LLM 常驻路径：turn 边界轮询 + `cancellationSignal` 事件驱动 ⇒ `session.abortActiveTurn()` 被调；单次 `-p` 路径 `launchCliProcess` 透传 `signal` ⇒ 子进程被 kill 并以 `TASK_CANCELED` 落终态 | **P0**（判据②） |
| R5-5 | `abortActiveTurn` **必须**终结 CLI 子进程，且取消**不得**触发同轮"重建 + 重投本轮" | **P0**（D-35） |
| R5-6 | 宿主 `canceled` 文案**两态可分**：`structuredContent.executedBeforeCancel` 有/无；事实化表述，禁止"未执行任何变更"式承诺（R10 预期管理） | **P0**（判据③） |
| R5-7 | `a2a.task.cancel` 返回 `cancelObserved`（对已终态任务的 cancel 回原终态 ⇒ 旧返回体只有 state，需宿主自比字符串） | P1 |
| R5-8 | `host-a2a-bridge` CLI `--token-env` 生效路径与 usage 文案对齐实现（原文案"默认 WINVM_BEARER_TOKEN"与实现 `tokenEnv:''` **直接矛盾**） | **P0**（判据④） |
| R5-9 | 文档兑现：SECURITY §2 信任边界声明 + 两项权衡登记；§3.2 与 `defaults.ts` **逐字一致**；§4.3 校验范围限定语；§7 "回环不可关"；ARCHITECTURE 限定语与风险表改述；CAPABILITY-MODEL 命令面白名单口径移除；CL-022 三件套；DEPLOYMENT/README/HOST-A2A-BRIDGE 的 `--token-env` + bearer 样例核对；SKILL D-13 白名单文案对齐 | **P0**（判据⑤） |
| R5-10 | 旧文案断言同步：改文案**前先 grep 全部断言点**并逐条适配（不得靠"改测试迁就实现"） | **P0**（判据⑥，§10 R3） |

### 2.6 用户故事（验收视角）

- 作为宿主用户，我在委派执行中点「取消」，**取消点之后的操作绝不发起**；回执会诚实告诉我"取消前已有 N 个操作执行、M 个产物"，而不是虚假的"未做任何变更"。
- 作为 VM 使用者，我的账户之外的文件（其他账户桌面/文档）**读不到**，且这不是运行时才发现的意外，而是策略层的确定性 DENY。
- 作为运维，我在旧配置里写 `commandAllowlist` 会在**交付/CI 面被 schema 拒绝**而不是"配了没生效"（现状：schema 未接入运行期校验，见 B-2 备注与 D-3）；我想让服务对外监听会**起不来**而不是"少了一层鉴权地裸奔"。
- 作为审计员，我读 `chainValid:true` 时能同时看到 `scope:'session'` 与 `shardsArchived`，从而**不会**把"本轮完好"误读成"全部历史完好"。

---

## 3. 影响范围（消费者清单）

| 面 | 影响 | 备注 |
|---|---|---|
| 契约（`contracts`） | 纯附加 4 处 + 删除 2 处（`commandAllowlist`） | 纯附加 ⇒ 下游未消费也编译通过 |
| 配置（`core/config`、`delivery/vm-service.config.json`） | 非回环判定升为 error；`enforceBearer` 新键（现网配置无该键 ⇒ 逐字旧行为） | 交付配置**本批不改值**，仅注释性核对 |
| 策略引擎（`core/policy`） | 白名单收紧 + 模式侧展开 + 删除命令白名单读取 | 16 处既有测试夹具适配（`phase1-t2-notes.md` §4），红的是**夹具前提**不是策略行为 |
| A2A 框架 | `addArtifact` 返回值语义 + 取消收口 + 有界驱逐 | 依赖注入范式不变（框架**不得** import `vm-service`） |
| vm-service | 新增 3 个纯模块 + `server.ts` 十区域散点 | `freshChainOnStart:true` **保持真值**（锚点不可动） |
| 执行体（两个 adapter） | 取消消费、`TASK_CANCELED` 收口、`abortActiveTurn` 公开、子进程 signal 透传 | `goalFail()` 语义**未改**（既有失败路径原码保持） |
| 宿主呈现（`host-a2a-bridge`） | 两态文案 + `executedBeforeCancel` + `cancelObserved` + usage 文案 | 旧文案断言已同步（判据⑥） |
| Skill / 文档 | 6 个 SKILL + 6 篇设计/部署文档口径对齐 | 无测试读取 `docs/**` |
