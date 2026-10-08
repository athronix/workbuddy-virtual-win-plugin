# 技术方案与架构一致性审计报告（2026-10-08）

> 审计人：高见远（software-architect）｜任务 #3｜只读审计（设计 vs 实现）
> 仓库：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`
> 取证口径：全部结论附「文件:行号」；推测标注「假设」。
> 工具提示：内置 Grep 对 `packages/*/src` 通配路径**存在假阴性**（实测漏检 `requiresSession`/`dryRun`），本报告所有关键否定性结论均以 `git grep` 二次证实。

---

## 0. TL;DR

总体判断：**架构骨架与设计文档高度自洽，"双通道同一内核"不是口号而是事实**（装配点级可证）；但**安全/审计类文档断言的兑现率明显低于执行链断言**，且**号称的门禁（dep-lint）根本不存在**。分级结论：

| # | 维度 | 判定 | 要点 |
|---|---|---|---|
| 1 | 单向依赖铁律 | **实质成立，但无守卫** | 人工核对全仓 0 反向 import；`scripts/dep-lint.mjs` **文件不存在**，`package.json:16` 指向它 → `npm run layout` 必 `MODULE_NOT_FOUND`（ARCH-01，P1）。依赖方向靠人肉维持，属于"名存实亡的门禁" |
| 2 | 双通道同内核 | **成立（强）** | MCP 与 A2A 内层**汇聚到同一 `executeCapability()`**（`server.ts:583`），策略/审批/审计/执行零分叉；A2A 壳生命周期经 `DelegationObserver` 回调补审计，非第二套风控 |
| 3 | 风险分级 L0–L3 | **部分一致（有实质安全偏差）** | ① `dryRun:true` 在策略引擎里**直接免审批放行**（`engine.ts:598-600`），无任何服务端"该能力是否真实现为只读"断言 → 与 SECURITY §3.4 红线字面冲突（ARCH-02，**P1 高**；§4.5 逐层取证后从 P0 降级：仅 3 个声明 `dryRun` 的 L2/L3 能力可走该通道，其 PS 实现均 `$DryRun` 早返回零变更，未声明者被 provider `validateParams` 拒于 `bridge.call` 之前，故**今天无可利用的免审批执行路径**；但四层兜底全是隐式约定，无一处断言或测试）；② 会话门禁只在确定性 provider 落地（`adapter-agent-workbuddy/src/index.ts:276`），框架层无强制（ARCH-03，P1）；③ `snapshot: 'before-after'` 是**纯元数据，零消费者**（ARCH-04，P1）；④ L3「二次确认」仅在宿主卡片文案层（ARCH-08，P2）；⑤ 路径白名单实为 `C:\Users\**`（全体账户），比文档 `C:\Users\<vmuser>\**` 宽（ARCH-17，P1）；⑥ 命令白名单整体失效（`cmdAllowRe` 编译后零引用，ARCH-18，P1） |
| 4 | 哈希链与审计完整性 | **强度合格，但有一处静默失效** | 链式计算/串行写/seq 单调校验（`chain.ts:348`）扎实；但 `freshChainOnStart:true`（`server.ts:379`）使**每次重启开新链、历史分片永久退出校验面** → 篡改重启前记录不可检出（ARCH-06，**P0**）。残余无审计出口：审批三态（rejected/timeout/canceled）与运维/协议层事件均只进 `logger`（ARCH-05，P1）；**`tasks/cancel` 不中止执行**——`cancelRequested` 全仓零读取（ARCH-22，P1，本轮新发现） |
| 5 | 契约漂移 | **存在多处** | `AuditApproval.previewHash` 服务端恒 `''` 且无实现做"预览≠执行"比对（ARCH-09，P1）；`ToolContext.signal` 声明后从不构造/消费（死契约）；`BridgeContext` 实际注入 6 个契约外字段，全靠 `as unknown as` cast（ARCH-10，P1）；`HealthStatus.approvalTruth` 在 `/health` 被改名为 `providerApprovalTruth`（ARCH-12，P2） |
| 6 | 服务端鉴权 | **文档承诺未兑现** | 声称"HTTP 模式强制 TLS + bearer + Origin 校验"：bearer 只在**客户端**发出（`transport/index.ts:72-78`），**服务端从不校验**；TLS/Origin 全仓零命中（ARCH-07，P1） |
| 7 | 可替换性 SPI | **基本成立，有 3 处摩擦** | 动态 `import(entry.package)` 真实可达（`loader.ts:90`），但 `provider`/`providers` 不在 `loadServiceConfig` 深合并集内 → 新 provider 需 `package.json` + 配置双写；三个 provider 都依赖 `vm-capabilities`，L2 adapter→L2 adapter 横向耦合 |
| 8 | 架构债 | 见 §7 | 服务级单例（A5 同型）残余：`approvalTruth` 由 2 处独立读 env（`bridge.ts:767`/`index.ts:171`）违反"构造期一次解析"纪律；`TaskStore` 进程内无持久化；SSE 无心跳；mcp-framework 自带第二套 traceId 生成器 |

**一句话**：执行链（能力→策略→审批→审计→ps-bridge）的设计-实现一致性 A 级；安全边界类断言（TLS/bearer/Origin、before-after 快照、previewHash 比对、链防篡改持续性、命令白名单、取消语义）C 级——**写了、没接、也没人验证**。

**建议本轮即修（批次 A，§7.3）**：① **ARCH-06（唯一 P0）**——`freshChainOnStart` 使历史审计退出校验面，先做"校验范围显式化 + 归档校验"；② **ARCH-02（P1 首位）**——`allow:dry-run-bypass` 改为"服务端可证声明"，并消除与 SECURITY §3.4 红线的文本冲突。
**次优先（批次 B）**：审批否定决策入链（ARCH-05）、**`tasks/cancel` 实为外观性取消**（ARCH-22：`cancelRequested` 全仓零读取 → 取消后目标继续执行，而宿主已渲染"未执行任何变更"，`host-a2a-bridge/src/tools.ts:431-433` —— 本轮新发现中最具实际危害的一条）、`previewHash` 落地（ARCH-09）、服务端 bearer/回环不可关（ARCH-07）、死配置清理（ARCH-17/18/20/21）。
**门禁**：ARCH-01（dep-lint 不存在）是上述所有"静默腐化"的共同根因，80 行脚本即可收口，建议与批次 A 同批做。

---

## 1. 设计-实现一致性抽查表

| # | 文档断言（出处） | 代码证据 | 判定 |
|---|---|---|---|
| A-1 | 「依赖方向单向：`contracts` ← `core/frameworks` ← `adapters/vm-service`，由 `scripts/dep-lint.mjs` 在本地把关（反向依赖即失败）」（README.md:143；ARCHITECTURE.md:341 「CI 依赖方向检查脚本（FR-403）」） | `package.json:16` 定义 `"layout": "node scripts/dep-lint.mjs"`；**仓库无 `scripts/` 目录**（`ls scripts` → 不存在，`git ls-files` 亦无）。人工核对：`git grep '@winvm/(vm-service\|adapter-\|host-a2a-bridge\|vm-capabilities)' -- packages/contracts packages/core packages/mcp-framework packages/a2a-framework packages/host-sdk` 仅命中 4 行注释/字符串（`contracts/src/bridge.ts:409`、`core/src/bridge/loader.ts:11`、`core/src/config/index.ts:97,101`），**无真实反向 import** | **偏差（半兑现）**：铁律本身成立（靠人肉），"把关脚本"不存在。文档把它写成 CI 门禁 → FR-403 未实现。已知问题（`docs/design/a5-approval-drop-fix-contract.md:836-844` E-3、`docs/changes/CL-K3R/REQUIREMENT.md:186` E-4 均登记"本轮不修"），但 README 至今仍以现在进行时宣称"由脚本把关" |
| A-2 | 「两个通道**不是两套实现**，而是同一内核的两个门面……同一能力经 MCP 或 A2A 调用，风险分级、白名单、审批、审计**完全一致**」（ARCHITECTURE.md §3.2:145-165；README.md:60 FR-103） | MCP：`server.ts:728-876` 工具 handler → `executeCapability()`（`server.ts:583`）。A2A：`server.ts:1031` `handler.runGoal` → `provider.runGoal` → provider 回连 `POST /mcp?dtid=`（`config/index.ts:105` 固定 `endpoint: http://127.0.0.1:18443/mcp`）→ **同一个** `/mcp` 路由（`server.ts:1081`）→ 同一个 handler → 同一个 `executeCapability()`。审批：MCP 侧 `pendingApprovals` 令牌 + 策略引擎；A2A 侧经 `VmApprovalCoordinator.raise` 复用同一张令牌表（`server.ts:1052` `approvalCoordinator.bind(a2a.tasks, pendingApprovals)`） | **一致（强）**：单内核断言可证，且是物理共用而非语义对齐。唯一分叉是"门面层"（MCP 返回 `structuredContent`/A2A 走 `input-required`），属设计本意 |
| A-3 | 「策略引擎判定顺序：1 能力未注册 → 2 pathDenylist → 3 commandDenylist → 4 白名单 → **5 风险≥L2 且未审批 → APPROVAL_REQUIRED** → **6 会话要求不满足 → SESSION_UNAVAILABLE** → 7 maxRisk → 8 通过」（SECURITY-GOVERNANCE.md:66-74） | `engine.ts:412-611` 实际顺序：1 未注册 → 1.5 allowedCapabilities → 2 pathDeny → 3 cmdDeny → 4 pathAllow → 4b 注册表读写 → 4c processDeny → **5 maxRisk** → **6 审批闸** → 7 通过。**文档的"6 会话要求"在引擎内不存在**；`maxRisk` 与审批闸相对文档**对调** | **偏差**：① 顺序差异本身安全方向不劣化（文档把审批列会话之前，代码同向），但文档不可当运行手册用；② **会话门禁缺失**是实质偏差——`requiresSession` 判定只在 provider 侧（`adapter-agent-workbuddy/src/index.ts:276-289`），策略引擎/服务端不拦（详见 ARCH-03） |
| A-4 | 「风险≥L2 未审批 → APPROVAL_REQUIRED」「任何情况下不得提供绕过审批闸的配置开关或代码路径」（SECURITY-GOVERNANCE.md:72, §3.4:103）；「L3 需审批 + 二次确认 + dry-run 前置」（contracts/src/risk.ts:7） | `engine.ts:597-600`：`if (riskAtLeast(req.risk,'L2') && !req.approved) { if (req.params['dryRun'] === true) return { allowed: true, matchedRule: 'allow:dry-run-bypass', requiresApproval: false } … }` —— **命中审批闸后、仅凭调用方自填的 `dryRun:true` 布尔即返回 allowed:true**，进入执行段。全仓无"该 PS 函数是否真为 dry-run 实现"的任何校验（`git grep -i dryRun -- packages` 仅命中 definitions 与 psmod 各处 `$DryRun` 分支，无一致性断言） | **偏差（安全）**：这是一条真实存在的"绕过审批闸的代码路径"，与 §3.4 红线直接冲突。详见 ARCH-02（P0） |
| A-5 | 「L2/L3 操作自动截图 + 变更清单，作为 artifact 回传」（ARCHITECTURE.md:295）；「L2/L3 是否强制快照：是（before/after）」（SECURITY-GOVERNANCE.md:88）；契约 `CapabilityDefinition.audit.snapshot: 'none'\|'after'\|'before-after'`（contracts/src/capability.ts:40,58） | 该字段在 `vm-capabilities/src/registry/definitions.ts` 被大量声明（L112-439 约 30+ 处）。但 `git grep -n -I -E 'audit\.(snapshot)\|SnapshotPolicy' -- packages` 结果：除 **contracts 自身的类型定义**外，**零消费者**（仅 `a2a-framework/src/server.ts:75` 与 `persistent-session.ts:266` 的同名无关符号 `snapshot`/`DelegationTerminalSnapshot`） | **名存实亡（偏差）**：before/after 快照强制策略是纯元数据，运行时无人读、无人执行。详见 ARCH-04（P1） |
| A-6 | 「哈希链审计……定期（每日 + 每次服务启动）自动校验，结果写入 `audit.chainValid`」「任一改动即校验失败」（ARCHITECTURE.md:292,340；SECURITY-GOVERNANCE.md:143-152） | 校验实现扎实：`chain.ts:311-364` 逐条重算 + `prevHash` 比对 + **seq 单调性**（`chain.ts:348`，可检 SEQ_DUP/SEQ_GAP/CHAIN_BREAK）；`/health` 每次调用都会 `verifyChain()`（`server.ts:1268`）。**但**：`server.ts:377-382` 构造 sink 时硬写 `freshChainOnStart: true`，语义见 `chain.ts:75-81` + `chain.ts:136-155` —— 每次启动选当日**新空闲分片**、以 GENESIS 起链，`verifyChain` 只校 `activeShards`（`chain.ts:313`），**历史分片永久退出校验面** | **偏差（安全）**：篡改"上一次运行期间"的审计记录**检不出来**——正是 D30 为规避历史脏数据（seq 511/582 重复）选择的权衡。防篡改承诺的实际范围被缩小为"本次进程运行期"。详见 ARCH-06（P0） |
| A-7 | 「审批记录包含：审批者、时间、预览内容哈希、审批结果（批准/拒绝/超时/取消 四态，不得折叠为『未批准』）」（SECURITY-GOVERNANCE.md:97）；契约 `AuditApproval{approvalId, approvedBy, approvedAt, previewHash}`（contracts/src/audit.ts:28-34）；「previewHash 用于比对『当时给用户看的』与『实际执行的』（哈希不一致即标记，不静默通过）」（同文:99） | 服务端落审批相关条目时：`approval-replay.ts:87-92`（blocked）写 `approvedBy:'pending-host-approval'` + **`previewHash:''`**；`approval-replay.ts:171-176`（policy-denied）写 `approvalId:'policy-denied'` 哨兵 + `previewHash:''`；provider 成功站点 `adapter-agent-workbuddy/src/index.ts:360-369` 写 `approvedBy:'host'` + `previewHash:''`。宿主侧确实算 hash（`host-a2a-bridge/src/approval-audit.ts:104-116`，tools.ts:456/526 调用），但 VM 链上恒空 → **无从比对**。四态：链上只有 blocked(pending) 与 executed(隐含批准)，**rejected/timeout/canceled 无对应审计条目**（见 §4） | **偏差（契约漂移）**：字段存在、类型对、值恒为空串；文档承诺的"哈希不一致即标记"未实现。详见 ARCH-05 / ARCH-09 |
| A-8 | 「`streamable-http`：TLS + bearer，强制 HTTPS + token + **Origin 校验**」（ARCHITECTURE.md:231；README.md §2.4；SECURITY-GOVERNANCE.md:21,38） | 客户端侧：`core/src/transport/index.ts:72-78` 从 env 取 token 并加 `authorization: Bearer …` 头。**服务端侧**：`vm-service/src/server.ts:1059` 用 `node:http` 的 `createServer`（非 `createSecureServer`）；`git grep -i 'bearer\|Authorization\|origin\|createSecureServer\|tls' -- packages/vm-service/src packages/core/src` 命中仅 3 处（config 注释 `tokenEnv`、logger 脱敏正则、transport/index 客户端取值）——服务端**既不校验 token，也不校验 Origin，也不提供 TLS**。`cfg.security.tokenEnv` 全仓唯一读取点是 `validateServiceConfig` 的 `requireLoopbackBind`（`config/index.ts:205-216`），`tokenEnv` 从未被服务端消费 | **名存实亡（偏差）**：非回环部署形态（`requireLoopbackBind:false`）下，服务实际是**裸 HTTP、零鉴权**。文档的"第 1 层：传输与鉴权"在服务端缺席。详见 ARCH-07（P1） |
| A-9 | 「换 VM 内 Agent 只需：新增一个实现包 + 改配置项 `agent.provider`，core/mcp-framework/a2a-framework/skills 全部零改动」（core/src/bridge/loader.ts:1-6；ARCHITECTURE.md §4.1:188-190；ADR-10） | 动态加载真实可达：`loader.ts:90` `await import(entry.package)`（`git grep -F 'import('` 证实仅此 1 处业务动态 import + `cli.ts:106` 自检探测）。`loader.ts:38-50` 另设进程内工厂表。`hermes-agent` 作为第三条 provider 存在并可被配置加载（`delivery/vm-service.config.json` 已注册 `hermes-agent`），**`vm-service` 的 `package.json`/`tsconfig.json` 均不引用它** → 印证"零框架改动" | **一致（有摩擦）**：机制成立。摩擦点：`loadServiceConfig`（`config/index.ts:240-243`）只取 `provider`+`providers` 两键，`providers` 与默认浅合并可用；但 `vm-service/package.json:12-20` 静态声明 workbuddy 两包依赖，新 provider 需在部署包内可解析。详见 §5 |
| A-10 | 「`host-sdk` 已中性化，可另加 `adapter-host-claude`/`adapter-host-cursor`」（README.md §2.5；ARCHITECTURE.md §4.2:194-207） | `git grep -i 'workbuddy\|codebuddy' -- packages/host-sdk/src` 命中 2 处**均为注释**（`index.ts:5`、`patch.ts:4`），无代码耦合；host-sdk 依赖仅 `@winvm/contracts`（`host-sdk/package.json`）。中性模型 `PluginManifest/SkillBundle/ConnectorDecl/LifecycleHooks` 在 `contracts/src/host.ts` 定义 | **一致**：宿主适配抽象真实存在，无硬编码 |
| A-11 | 「统一返回结构 `{traceId, ok, data, artifacts, risk, durationMs, auditRef}`」（INTERFACES.md §2.4） | MCP 成功站点 `server.ts:668-683` 字段齐备（`auditRef` 来自 provider `adapter-agent-workbuddy/src/index.ts:379`）。**策略拒绝站点** `server.ts:853-861` 返回 `{traceId, ok:false, error, risk}` — **无 `durationMs`、无 `auditRef`、无 `artifacts`**；审批拦截站点 `server.ts:818-833` 同样缺 `durationMs`/`auditRef` | **偏差（轻度契约漂移）**：文档 §2.4 失败示例列了 `auditRef`，实现未给。宿主侧按文档解析会拿到 undefined |
| A-12 | 「`/health` 增量字段 `approvalTruth`（`HealthStatus.approvalTruth`，contracts/src/bridge.ts:154-158）」；同处纪律：「必须在构造 bridge 时一次性解析（消费方禁止在 `health()` 里二次读 `process.env`，否则配置值≠生效值）」 | `server.ts:1332`：`...(providerHealth?.approvalTruth ? { providerApprovalTruth: providerHealth.approvalTruth } : {})` —— 服务端把它**改名**为 `providerApprovalTruth` 透出，与契约字段名不一致（契约注释自己声明的落点是 `/health.approvalTruth`）。同时 `adapter-agent-workbuddy-llm` 有 **2 处独立解析**：`bridge.ts:767` 与 `index.ts:171` 各调 `resolveApprovalTruth(process.env)` | **偏差**：字段名漂移（ARCH-12）+ "一次性解析"纪律被双读点违反（ARCH-11）。另 `provider.health()` 超时降级时该字段整体缺席（依赖 `providerHealth` 存在）——shadow 轮不可证 |
| A-13 | 「A2A 架构框架：Agent Card 生成**与签名**、Task 状态机、`message/stream`(SSE)…」（ARCHITECTURE.md §2.2:123） | `git grep -i signature -- packages/a2a-framework/src packages/contracts/src` 仅命中 `contracts/src/a2a.ts:159` 的可选字段声明，框架**无任何签名生成/校验代码**；`server.ts:976-1029` Agent Card 构造也无签名字段 | **名存实亡**：签名从未实现（`signature?` 是可选字段，不破坏兼容，但文档把它列为框架能力） |
| A-14 | 「服务禁注册为 Windows 服务；`session-guard` 保活：自动登录 / tscon / 禁休眠」（ARCHITECTURE.md:70-71, §6.3:268-279） | `core/src/session/health.ts`（118 行）提供 `SessionMonitor` + 探针（`server.ts:361-370` 启动），恢复动作侧：`git grep -n -I 'tscon\|Autologon' -- packages` 未命中包内实现（`vm-capabilities` 无 `session-guard`，ARCHITECTURE.md:270 声称的 `vm-capabilities/session-guard` 不存在于 `packages/vm-capabilities/src`） | **偏差（部分缺失）**：探针/降级语义在（`adapter-agent-workbuddy/src/index.ts:276` 会话守卫 + `server.ts:731` 描述透出），tscon/自动登录/禁休眠属部署脚本域，非该包。文档指向的落点文件名不存在 → 归为文档漂移，交由交付文档审计成员交叉确认 |
| A-15 | 「`agent.provider` 是 VM 侧 AI Agent 总开关；`workbuddy-deterministic`（默认）与 `workbuddy`（LLM）通过同一 SPI 互换」（ARCHITECTURE.md §4.1:189；ADR-6/ADR-10） | 默认 provider 为确定性执行器（`config/index.ts:94` `provider: 'workbuddy-deterministic'`），`delivery/vm-service.config.json` 三选项齐备（deterministic / workbuddy / hermes-agent）；`exposedCapabilities = registry.intersectDeclared(provider.declareCapabilities())`（`server.ts:463-465`），degraded 时收敛到 `meta.*`（同处:465），与 SECURITY §3.4:106「绝不降级为无限制执行」一致 | **一致** |

---

## 2. 依赖治理核验结果

### 2.1 核验方法

`scripts/dep-lint.mjs` **在仓库中不存在**（`ls -d scripts` → No such file or directory；`git ls-files | grep scripts/dep-lint` → 空），因此任务书要求的"跑 dep-lint"**无法执行**。本报告改用两条替代取证：

1. **声明面**：逐包读取 `package.json.dependencies` 中的 `@winvm/*` 子集 + `tsconfig.json.references`（node 脚本遍历 12 包）。
2. **实际 import 面**：`git grep -n -e "@winvm/vm-service" -e "@winvm/adapter-" -e "@winvm/host-a2a-bridge" -e "@winvm/vm-capabilities" -- packages/contracts packages/core packages/mcp-framework packages/a2a-framework packages/host-sdk`（L0/L1 是否反向引用 L2/L3）。

### 2.2 依赖矩阵（实测）

| 包 | `package.json` 的 `layer` | @winvm 依赖（运行时声明） | tsconfig references |
|---|---|---|---|
| `contracts` | L0-contracts | （空） | （空） |
| `core` | L1a-core | contracts | ../contracts |
| `mcp-framework` | L1b-mcp-framework | contracts, core | ../contracts, ../core |
| `a2a-framework` | L1b-a2a-framework | contracts, core | ../contracts, ../core |
| `host-sdk` | L1c-host-sdk | contracts | ../contracts |
| `vm-capabilities` | L2-vm-capabilities | contracts, **core** | ../contracts **（缺 ../core）** |
| `adapter-agent-workbuddy` | L2-adapter-agent | contracts, core, vm-capabilities | 齐 |
| `adapter-agent-workbuddy-llm` | L2-adapter-agent-llm | + **adapter-agent-workbuddy** | 齐 |
| `adapter-agent-hermes` | L2-adapter-agent-llm | + **adapter-agent-workbuddy**, **adapter-agent-workbuddy-llm** | 齐 |
| `adapter-host-workbuddy` | L2-adapter-host | contracts, host-sdk | 齐 |
| `host-a2a-bridge` | L3-host-bridge | contracts, core, mcp-framework, a2a-framework | 齐 |
| `vm-service` | L2-vm-service | contracts, core, mcp-framework, a2a-framework, vm-capabilities, **adapter-agent-workbuddy**, **adapter-agent-workbuddy-llm** | 缺 ../adapter-agent-workbuddy-llm |

### 2.3 结论

| 项 | 判定 | 证据 |
|---|---|---|
| **单向依赖（L0/L1 不反向依赖 L2/L3）** | **成立** | 上述 grep 仅 4 处命中，且**无一条是 import**：`contracts/src/bridge.ts:409`（注释提及 L2 包名）、`core/src/bridge/loader.ts:11`（注释示例字符串）、`core/src/config/index.ts:97,101`（**字符串字面量**，非 import）。`contracts/package.json` 零 @winvm 依赖 = 唯一契约源名副其实 |
| **软破口：L1 硬编码 L2 包名** | **存在（可接受但需登记）** | `core/src/config/index.ts:96-112` 的 `DEFAULT_SERVICE_CONFIG.agent.providers` 把 `@winvm/adapter-agent-workbuddy` / `-llm` 两个 **L2 包名写进 L1 默认配置**，配合 `loader.ts:90` 的动态 `import()` 构成"配置驱动的向下依赖"。因是字符串而非静态 import，`tsc` 与 npm 层面不报错，运行时若包缺失则降级（`loader` 捕获）。方向上不违反"编译期依赖单向"，但**违反 L1 不应知道具体实现包**的分层精神 |
| **L2 → L2 横向依赖** | **存在（真实耦合，非违规但影响可替换性）** | `adapter-agent-workbuddy-llm` → `adapter-agent-workbuddy`；`adapter-agent-hermes` → 二者全部。"换 Agent 零改动"的宣称在 provider 家族内部并不成立：新 LLM provider 事实上站在前一个 provider 的实现之上（详见 §5） |
| **守卫脚本** | **不存在** | `package.json:16` `"layout": "node scripts/dep-lint.mjs"` → `npm run layout` 必 `MODULE_NOT_FOUND`；README.md:143 / ARCHITECTURE.md:341 与 §10 风险表均以现在进行时宣称"由脚本把关 / CI 依赖方向检查脚本（FR-403）"。**已登记为 ARCH-01（P1）**（docs 内部 `docs/design/a5-approval-drop-fix-contract.md:836-844` E-3、`docs/changes/CL-K3R/REQUIREMENT.md:186` E-4 亦承认失效） |
| **Project References 完整性** | **2 处缺失（可致构建顺序不确定）** | ① `vm-capabilities/tsconfig.json` references 无 `../core`，但 `vm-capabilities/src/index.ts:14` 有 `import type { SessionProbe } from '@winvm/core'`，`package.json` 亦已声明依赖 → composite 构建不保证先出 core 产物；② `vm-service/tsconfig.json` references 无 `../adapter-agent-workbuddy-llm`，但 `package.json` 已声明且 loader 运行期动态 import 它。**属 ARCH-28（P1）**（不是依赖方向违规，是构建图与声明图不同步）；同时进 §7 债务台账 D-6 |
| **分层标注一致性** | **文档与代码不一致** | 代码 `layer` 字段：`vm-service`/`vm-capabilities` = `L2-*`，`host-a2a-bridge` = `L3-host-bridge`；而 ARCHITECTURE.md:125-129 把 `vm-service`/`vm-capabilities`/`host-a2a-bridge` **同列 L2**，README.md:138 又把 adapter 类标 **L3**。三处口径互不相同（文档一处 L2 一处 L3）。属文档漂移，非实现缺陷（**ARCH-14，P2**） |
| **新增 provider 是否需改框架** | **不需要（机制成立）** | `adapter-agent-hermes` 存在且 `vm-service/package.json` 不引用它，`delivery/vm-service.config.json` 注册即可用 → 印证 `loader.ts` "零改动"说法；但 `DEFAULT_SERVICE_CONFIG` 不含 hermes（`config/index.ts:96-112` 只有 workbuddy 两项），**换 provider 必须同时改配置文件的 `providers` 与 `provider` 两键**，且 `loadServiceConfig`（`config/index.ts:240-243`）只做浅取键合并且无 `--provider` CLI 覆盖（`vm-service/src/cli.ts` 全文无该 flag）。摩擦点见 §5 |

**总判**：单向依赖铁律**实质成立**（人工取证 0 反向 import），但"有门禁"这一断言**不成立**——治理靠人肉，一旦有人写出 L1→L2 静态 import，`tsc -b` 不会拦（模块解析能过），dep-lint 也不存在。这正是 ARCH-01 定为 P1 的理由：不是"现在坏了"，而是"坏掉的检测器"。

---

## 3. 双通道「同一内核」验证（装配点级证据）

### 3.1 结论：断言成立，且是**物理共用**而非语义对齐

| 内核资源 | 实例数 | 装配点 | 说明 |
|---|---|---|---|
| 策略引擎 | **1** | `server.ts:383` `const policy = new CorePolicyEngine({ registry, config: cfg.policy })` | MCP handler（`:753`）、执行段（`:590`）、provider（`adapter-agent-workbuddy/src/index.ts:246`）三处 `.evaluate()` 用的都是这一个对象（provider 经 `ctx.policy` 注入） |
| 审计 sink（哈希链） | **1** | `server.ts:377-382` 构造 + `:395` `wrapAuditSink(audit, ledgerReg.onAuditRecord)` | 两通道全部条目写同一条链；委派账本装饰器也在唯一出口上 |
| 审批令牌表 | **1** | `server.ts:529` `const pendingApprovals = new Map()`；`:1052` `approvalCoordinator.bind(a2a.tasks, pendingApprovals)` | A2A 侧 `VmApprovalCoordinator.raise` 读写的是 MCP handler 登记的**同一张表**（`:226` 取 token、`:255` 置 `hostApproved`、`:280` 一次性删除） |
| 真实执行段 | **1** | `server.ts:583` `executeCapability(cap, params, seg)` | MCP 工具 handler（`:867` 调用）与宿主批准后的服务端重放（`:714` `replay` 调用）**共用该函数**，注释 `:554` 明写"K5：MCP handler 与重放共用" |
| 能力注册表 / 暴露面 | **1** | `server.ts:463-465` `registry.intersectDeclared(provider.declareCapabilities())` | 两通道读同一 `exposedCapabilities` |
| A2A 内层执行 | **回连 `/mcp`** | provider `runGoal`（`:408` 起）经 `http://127.0.0.1:18443/mcp`（`config/index.ts:105`）发起内层调用 → `server.ts:1081` 路由 → 同一个 handler | **这是"同一内核"最强的证据**：A2A 通道的能力执行在物理上就是 MCP 通道的同一段代码，只是外面套了 Task 状态机与 `input-required` 审批门面 |

因此"隐性两套风控"**未发现**。两通道的差异全部停留在**门面层**（属设计本意，见 ARCHITECTURE.md §3.2 表格）：返回体形状（MCP `structuredContent` / A2A Task artifact）、审批呈现（MCP `APPROVAL_REQUIRED`+`approvalId` / A2A `input-required`）、生命周期（A2A 多 goal start/complete 条目，由 `delegationObserver`（`server.ts:902`）补齐，不是第二套策略）。

### 3.2 需要如实记下的 4 处「非对称」（不构成两套风控，但构成两通道行为差异）

1. **`maxRisk` 只有 A2A 侧传入**：`engine.ts:578` 的封顶判定是 `req.maxRisk !== undefined &&` 前置，MCP 直调不传（`server.ts:590`/`:753` 的 evaluate 入参均无 `maxRisk`）→ MCP 直调事实上**不受委派风险上限约束**。代码注释 `:575-577` 自陈这是有意设计（避免 L2/L3 直调永远不可执行）。判定：**符合 ADR 精神，但与 ARCHITECTURE.md §3.2"完全一致"措辞有出入**（文档未披露该差异）。
2. **provider 内第二次评估丢失 `capabilityPolicy`**：`server.ts:596`/`:759` 都传 `...(cap.policy ? { capabilityPolicy: cap.policy } : {})`，而 `adapter-agent-workbuddy/src/index.ts:246-252` 的 evaluate **不传** → 能力级策略覆盖（如 `appops.workflow.run` 的 `commandAllowlist`/`pathAllowlist`，`definitions.ts:387`）在 provider 那一轮被跳过。因服务端已先评过一轮，**不构成绕过**，但同一次调用存在"两套判定结果"的可能，属重复评估带来的漂移风险（**ARCH-13，P2**）。
3. **traceId 生成器有两套**：`core/src/index.ts:110-116`（`randomUUID` 派生）与 `mcp-framework/src/server.ts:78-82`（`traceSeq` 自增计数器 + `Date.now()`）。后者非加密随机、进程内单调 → 跨进程重启可重复。属框架自带第二实现的口径分裂（**ARCH-15，P2**）。
4. **错误体形状不符文档**：INTERFACES.md §2.4 统一结构含 `durationMs`/`auditRef`（失败样例亦列 `auditRef`），而策略拒绝站点 `server.ts:853-861` 与审批拦截站点 `:818-833` 只给 `{traceId, ok:false, error, risk}`。两通道门面各自缺字段，但**缺的方式不同**（A2A 侧经 `toExecutedResult` 转换后另成形状）。属契约漂移（**ARCH-16，P2**）。

---

## 4. 风险分级 L0–L3 与审计链完整性

### 4.1 能力面与风险分布实测

`packages/vm-capabilities/src/registry/definitions.ts`（463 行）扫描结果（node 脚本逐 `cap({...})` 解析）：

| 维度 | 实测 |
|---|---|
| 能力总数 | **54** |
| 域分布 | meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5 |
| 风险分布 | **L0 27 / L1 19 / L2 7 / L3 1** |
| L3 | 仅 `system.power.control`（`definitions.ts:123`，`Invoke-PowerControl`） |
| L2 清单 | `system.service.configure`(:113)、`system.process.terminate`(:115)、`system.registry.write`(:118)、`app.winget.uninstall`(:174)、`storage.file.delete`(:286)、`storage.link.manage`(:292)、`appops.gui.produce`(:416) |
| L3 分区/格式化"不注册" | **成立**：SECURITY/README 承诺不落 L3 磁盘类能力，实测 definitions 无 `format`/`diskpart`/分区能力，且 `commandDenylist` 已封 `format`/`diskpart`（`defaults.ts:64-65`） |

### 4.2 默认策略基线逐条比对（SECURITY-GOVERNANCE.md §3.2:77-90 vs `core/src/policy/defaults.ts`）

| 文档条目 | 代码 | 判定 |
|---|---|---|
| 落点文件名 `policy.default.json` | **不存在**（`git ls-files \| grep policy.*json` → 空）。实际是 TS 常量 `DEFAULT_POLICY`（`defaults.ts:33`），配置覆盖走 `cfg.policy`（`config/index.ts:76,114,244`）→ `new CorePolicyEngine({config: cfg.policy})`（`server.ts:383`）→ `mergePolicy`（`engine.ts:398`，数组**并集**、标量用户优先） | **偏差（文档指向不存在的文件）**；合并语义本身与"可配"承诺一致。属 ARCH-14 类文档漂移 |
| 路径黑名单 8 项 | `defaults.ts:35-49` 含文档 8 项**全部**，另加 `C:\bootmgr*`、`C:\hiberfil*`、`C:\pagefile*`、`C:\swapfile*`、`\\*`（UNC 全域） | **一致且强于文档**（超集，方向安全） |
| 路径白名单 4 项（含 `C:\Users\Public\**`） | `defaults.ts:54-60`：`C:\Users\**`、`C:\Temp\**`、`C:\tmp\**`、`D:\Data\**`、`C:\WinVMWorkspace\**` | **偏差（范围更宽）**：文档写 `C:\Users\<vmuser>\**`，代码是 `C:\Users\**`（**全体用户目录**，含其他账户）；文档的 `C:\Users\Public\**` 被 `C:\Users\**` 覆盖。跨用户读写面比文档描述大，建议收紧或更新文档（**ARCH-17，P1**） |
| 命令黑名单（含 `powershell -enc`、Base64 混淆、`Invoke-Expression`、`iex`） | `defaults.ts:63-81` 逐条齐备，另加 `del /s /q`、`rm -rf /`、`FromBase64String`、`-e <100+base64>` | **一致且强于文档** |
| **命令白名单** | `defaults.ts:84` `commandAllowlist: []`（注释"留空表示不启用"）；但 `engine.ts:395,405` 声明并编译 `this.cmdAllowRe` 后，**全仓无任何读取点**（`git grep -n "this.cmdAllowRe"` 仅命中赋值行 :405）→ **死字段**。能力级 `commandAllowlist` 同理不生效：`definitions.ts:387`（`appops.workflow.run` 限定 node/python/pwsh/ffmpeg/… 9 个解释器）**从未被策略引擎消费** | **名存实亡（偏差）**：①"未命中命令白名单即拒"（`defaults.ts:17` 注释与 CAPABILITY-MODEL.md:201）在实现里只做黑名单；②`appops.workflow.run` 的注释级安全承诺（只允许指定解释器）无强制力。见 **ARCH-18（P1）** |
| 进程黑名单 7 项 | `defaults.ts:87-97` 齐备 + `winvm-service` 自保护 | **一致且强于文档**；但**匹配面窄**：`engine.ts:558-559` 仅对键名匹配 `/\b(process\|name\|processName\|target)\b/i` 的参数做检查 → 键名不合规（如 `{killer:'lsass'}`、`{path:'C:\\Windows\\System32\\lsass.exe'}`）即绕过。属实现强度问题，见 ARCH-19（P2） |
| 注册表：`HKCU` 为主；`HKLM:\SOFTWARE` 需 L2 审批；**禁** `HKLM:\SYSTEM/SAM/SECURITY` | `defaults.ts:110-121` 读写两表白名单化（含短长双形态），`engine.ts:513-551` 按 `isWriteCapability` 分段判据选表（S-5 修复，注释 `:515-523` 记录此前"写表死配置"缺陷已修） | **一致**：禁项因白名单 miss 即拒（`:530`）而天然封死；`system.registry.write` 风险 L2（`:118`）+ 审批闸在后 → 与文档"需 L2 审批"吻合。**这是本次抽查中少见的"文档-代码成对修复"正面样本** |
| 默认 `maxRisk`（委派）`L1` | `defaults.ts:123`，消费点 `server.ts:1045` → `a2a-framework/server.ts:126,262,476`；宿主侧 `host-a2a-bridge/cli.ts:121`、`tools.ts:298,343` | **一致（链路完整）**；注意 `engine.ts:578` 仅在 `req.maxRisk !== undefined` 时封顶（见 §3.2-1） |
| `approvalTimeoutMs: 120_000`（文档"审批超时默认拒绝 fail-closed"） | `defaults.ts:28,124,142` **仅定义与合并，全仓零消费**（`git grep -n approvalTimeoutMs -- packages delivery` 只命中 defaults.ts 三行）；真实 TTL 在 A2A 侧：`task-store.ts:92-96` 读 env `WINVM_APPROVAL_TTL_MS`，默认 30 分钟（`:213,:258`），超时 `resolve(false)` → `failed`（`:230`）+ `server.ts:539-551` 删令牌 | **名存实亡（偏差）**：策略层的审批超时常量是**死配置**；文档 §3.4:106 自己声明"V1 未实现显式 TTL 回收"，但代码其实实现了（A2A 侧 30min TTL，MCP 侧无 TTL）。→ 真实缺口是 **MCP 直调通道的 `pendingApprovals` 令牌永不过期、无清扫**（`:529` 纯 Map，仅 `:864`/`:280`/`:543` 三处显式删除），进程内可无界增长且长期存在"待批准"续跑令牌。ARCH-20（P1） |
| 删除默认行为：进回收站（除非显式 `--permanent` + 已审批） | `psmod/storage.ps1:180-190`：`$Permanent` 分支才 `Delete(..., SendToRecycleBin)` 之外路径；默认 `RecycleOption::SendToRecycleBin`；`definitions.ts:286` 描述一致 | **一致**，**但受 ARCH-02 削弱**：`{path:'C:\\Users\\x\\secret', permanent:true, dryRun:true}` 走 `allow:dry-run-bypass` 免审批，`Remove-FileSystemItem` 的 `$DryRun` 分支在 `:176` **先于** `:180` 的 `$Permanent` 判定并直接 return，故不会物理删除 —— 该能力**自身**安全；风险在"其它 L2/L3 能力的 dryRun 分支是否同样先判且无副作用"无契约保证（`app.ps1:782-810` 注释明确承认"免审批路径上不得起任何子进程"是**人工纪律**，非机制） |
| L2/L3 强制快照 before/after | `definitions.ts` 声明 30+ 处，**零消费者** | **名存实亡**（ARCH-04，P1，见 §1 A-5） |

### 4.3 哈希链实现强度（正面确认）

| 机制 | 证据 | 判定 |
|---|---|---|
| canonicalJson + SHA256 + prevHash | `chain.ts` 链计算段 | 扎实 |
| **seq 单调校验** | `chain.ts:348` 检出 `SEQ_DUP`/`SEQ_GAP`/`HASH_MISMATCH`/`CHAIN_BREAK`（`ChainBreakReason` 定义 `:85`） | 扎实（且能检出历史 D30 现场的重复 seq） |
| 串行写队列（防并发交叉写坏链） | `chain.ts:261-273`（D30 竞态修复），写盘成功后才回写 `seq`/`lastHash`（`:306-307`） | 扎实 |
| 校验触发 | `/health` 每次调用 `verifyChain()`（`server.ts:1268`）；ARCHITECTURE.md:292 承诺"每日 + 每次启动"自动校验并把结果写 `audit.chainValid` | **触发面成立，范围被缩小** → ARCH-06 |
| 脱敏 | `chain.ts:42` `SENSITIVE_KEY_RE = /(password\|passwd\|secret\|token\|apikey\|api_key\|credential\|privatekey\|private_key)/i` | **与宿主侧口径不一致**：`host-a2a-bridge/src/approval-audit.ts:39-40` 的并集正则**多含 `passphrase`**，且其注释 `:48-52` **明确点名**"core 的凭据正则缺 `passphrase`/`apikey`/`credential` → 会漏脱敏" —— 但 core 现已含 `apikey`/`credential`，**唯 `passphrase` 仍缺**（`chain.ts:42` 无该词）。→ 宿主知道并规避，VM 链仍会把 `{passphrase:"…"}` 明文入链。ARCH-21（P1） |
| 追加写 + 有界 | `chain.ts:302` `appendFile`；`/audit/receipt` 全量查询 `limit: 5000`（`server.ts:1117`） | 一致 |

### 4.4 「无审计出口」残余扫描（S-4 修复后）

**先确认写入点全集**（`git grep -n -e "audit.append(" -e "sink.append("`）——全仓仅 5 个落点，这是判定的分母：

| # | 写入点 | 覆盖语义 |
|---|---|---|
| W1 | `adapter-agent-workbuddy/src/index.ts:345` | 能力执行**成功** |
| W2 | `同文件:912`（`fail()`） | 能力执行**失败**（含策略拒绝、参数非法、会话不可用、ps-bridge 错误） |
| W3 | `vm-service/src/approval-replay.ts:74` | MCP/A2A **审批拦截**（blocked，`approvedBy:'pending-host-approval'`） |
| W4 | `同文件:158` | **策略硬拒绝**（`approvalId:'policy-denied'` 哨兵）——即 **S-4 修复本身**，调用点 `server.ts:605` |
| W5 | `vm-service/src/delegation-audit.ts:754`（经 `wrapAuditSink`） | 委派**壳**条目（`delegation-start` / `delegation-complete`），由 `delegationObserver`（`server.ts:902-960`）驱动 |

**残余缺口（逐一取证，均确认无任何 W1–W5 落点）**：

| 缺口 | 场景 | 证据 | 影响 | 编号 |
|---|---|---|---|---|
| G1 | **宿主显式拒绝审批** | 拒绝走 `a2a-framework/src/server.ts:305-308`（`updateStatus('rejected')`，框架无 sink、亦不在此调 observer）；runner 侧 `raise` 得 `{approved:false}`（`vm-service/src/server.ts:242-251`）→ `adapter-agent-workbuddy-llm/src/bridge.ts:1047` 直接返回 base → 生命周期收尾 `server.ts:374-377` 才回调 `onGoalTerminal(state:'failed')` → **`vm-service/src/server.ts:927-929` 用 `storedState==='rejected'` 反推**，把壳条目 `ext.terminalState` 写成 `'rejected'` | 部分可证：**委派级**"这次以 rejected 收口"在链上有（但依赖"任务已终态 ⇒ updateStatus 被 `task-store.ts:138-143` 拦住"这一巧合，属反推而非直陈）；**审批级**（哪个 approvalId、被谁、何时拒）**链上无痕** → 违反 SECURITY §3.3:97 的审批记录四要素（审批者/时间/预览哈希/结果） | ARCH-05 |
| G2 | **审批 TTL 超时** | `task-store.ts:228-244`：`reason==='timeout'` → `updateStatus(id,'failed', approvalTimeoutMessage)` + metadata 固化 `approvalTimedOut/approvalTimeoutApprovalId/approvalTimeoutTtlMs`（**仅进程内**）+ `onApprovalTimeout` 回调 → `vm-service/src/server.ts:539-551` 只 `logger.warn` + 删令牌。runner 收尾回调 `onGoalTerminal(state:'failed')`，而 `storedState==='failed'` ⇒ 不落入 `:929` 的 rejected 反推 ⇒ **壳条目 terminalState = `'failed'`** | 超时在链上与"普通执行失败"**不可区分**（四态折叠为 failed，正是 §3.3:97 禁止的折叠）；`approvalTimedOut` 事实只活在进程内 metadata（重启即失）与 logger | ARCH-05 |
| G3 | **`tasks/cancel` 不中止执行**（取消是"外观性"的） | `a2a-framework/src/server.ts:430-434 cancelTask` → `task-store.ts:183-195 requestCancel`：置 `rec.cancelRequested = true` 后 `updateStatus('canceled')`。但 **`cancelRequested` 全仓无任何读取点**（`git grep -n cancelRequested -- packages` 仅 3 处：声明 `:51`、初始化 `:116`、赋值 `:188`）→ runner/provider **不知道**任务已被取消，正在跑的 LLM 目标继续执行完剩余全部能力；`addArtifact`（`task-store.ts:169-175`）无终态守卫 → 已取消任务仍持续向宿主推送 artifact。终态保护（`updateStatus :138-143`）使 canceled 不被改写，但审计壳条目随后由 runner 的 `onGoalTerminal` 落 `terminalState:'completed'/'failed'`（`server.ts:374-377` + `vm-service/src/server.ts:927-929` 只识别 `failed+rejected` 一种不一致情形）→ **链上说"完成"、协议说"已取消"** | ①取消语义未实现（高危操作被"取消"后仍在执行，且宿主以为已停）；②证据面与协议面矛盾；③已取消任务继续产出 artifact 属未授权副作用 | **ARCH-22（P1）** |
| G4 | **HTTP 层错误**：405 / 400（JSON parse）/ 404 / 500 | `server.ts:1065-1068`（405）、`:1109-1112`（400）、`:1183`（404 admin 未启用）、`:1206`（404 not found）、`:1207-1209`（catch → `logger.error`） | 协议层畸形请求、越权探测**完全不进审计**；SECURITY §2 七层纵深未规定 HTTP 层审计，属"设计未覆盖 + 实现未覆盖"双缺（**假设**：这是有意把取证面限定在能力级） | ARCH-23（P2） |
| G5 | **`/admin/llm-session/reset` 运维动作** | `server.ts:1181-1204`：仅 `logger.warn`（`:1187`），注释 `:1179` **明写"日志只走 warn（运维面与证据面分离：不入哈希链）"** | 复位/故障注入（可杀 LLM 常驻会话、可注入 spawn 故障使后续委派确定性 disabled）是**有能力效果的操作**，却无链上证据。文档纪律自称"运维面与证据面分离"，但 SECURITY §3.4 红线未覆盖运维端点 → 治理空档 | ARCH-24（P2） |
| G6 | **degraded 启动（provider 加载失败）** | `server.ts:466-525` 区间仅 `logger.info/warn`；`exposedCapabilities` 收敛到 `meta.*`（`:463-465`），`PROVIDER_UNAVAILABLE` 返回点 `:633-641` 也**不落审计**（在 W4 之后、W1/W2 之前的提前 return） | 服务"以受限形态启动"这一重大状态变化不留链上证迹；事后无法证明某窗口处于 degraded（`/health` 瞬时值、进程内） | ARCH-25（P2） |
| G7 | **MCP 侧续跑令牌不过期** | `server.ts:529` Map 无 TTL 清扫（对比 G2：A2A 路径有；纯 MCP 路径的 blocked 令牌若宿主永不应答则常驻） | 内存无界增长 + "待批准"状态永久存在（虽 `hostApproved` 恒 false 不放行，**安全性不受损**） | ARCH-20 |

**结论**：S-4（策略硬拒绝无审计）确已闭合（W4 + `server.ts:605` 调用 + 注释 `:602-603` 自证）。残余缺口集中在**"人做了否定/旁路决策但未穿过执行段"的场景**——即 G1/G2/G3（审批三态）+ G4/G5/G6（运维与协议面）。共同模式：**审批与生命周期事件走 `logger`，执行事件走 `audit`**，两套记录面不交叉，导致"拒绝/取消"这类**最有治理价值的事实**恰好落在证据面之外。

### 4.5 dry-run 免审批通道的真实边界（ARCH-02 定级依据，本轮补做取证）

初判"一个布尔即可绕过 L3 审批闸"为 P0，本轮把**可达性**逐层取证后**降为 P1（高）**。四层判据（缺一不可，且**全部是隐式约定**）：

| 层 | 事实 | 证据 |
|---|---|---|
| ① 引擎位置 | `allow:dry-run-bypass` 在 pathDeny/cmdDeny/pathAllow/registry/processDeny/maxRisk **之后**，故黑名单类硬拒绝**不会**被 dry-run 绕过 | `engine.ts:412-592` 各判定 → `:597-600` 审批闸；注释 `:592-596` 自陈"放在安全校验之后，故 dry-run 仍不能绕过黑名单与白名单" |
| ② 服务端不校验入参 | `executeCapability` **无** schema 校验（全仓唯一实现是 provider 私有方法） | `server.ts:583-620`；`git grep -n validateParams -- packages` → 仅 `adapter-agent-workbuddy/src/index.ts:265`、`:751` |
| ③ provider 拒绝未声明键 | `validateParams` 把 `Object.keys(params)` 中不在 `input.properties` 的键判 `INVALID_PARAMS`，**位于 `bridge.call` 之前** → 给未声明 `dryRun` 的 L2 能力塞 `dryRun:true` **进不了 PS** | `index.ts:751-800`（`unknown.length>0` → `不支持的参数 …`）、调用点 `:265` 早于执行 `:326` |
| ④ PS 侧早返回 | 声明了 `dryRun` 的 3 个 L2/L3 能力，`$DryRun` 分支均先于任何副作用 return，零子进程 | `psmod/system.ps1:474-476`（Invoke-PowerControl）、`psmod/app.ps1:797-810` + `Get-UninstallDryRunPlan:693`（纯注册表查询，K-N2 明令禁止给 `winget uninstall` 传 `--dry-run`，`app.ps1:782-789` 注释记录原因）、`psmod/storage.ps1:176-177`（先于 `:180` 的 `$Permanent`） |

可达面枚举（`definitions.ts` 声明 `dryRun` 入参的仅 6 处）：L3 `system.power.control`:123、L2 `app.winget.uninstall`:177、L2 `storage.file.delete`:286 —— 三者满足④；L1 `app.winget.install`:156、`app.winget.upgrade`:273（L1 本就不需审批，无绕过意义）。其余 4 个 L2（`system.service.configure`:113、`system.process.terminate`:115、`system.registry.write`:118、`storage.link.manage`:292、`appops.gui.produce`:416）**未声明** `dryRun` → 被③拦下。三个 provider 的 `execute` 均落到同一确定性执行器（`adapter-agent-hermes/src/index.ts:150-152` `return this.executor.execute(req)`；`adapter-agent-workbuddy-llm/src/index.ts:248` 委托 `DeterministicAgentProvider`，`:174` 构造）→ ③对全部 provider 成立。

**为什么仍是 P1（高）而不是 P2**：

1. **四层判据无一处有断言或测试**：`git grep -l dryRun -- tests` 命中 10 个文件（宿主卡文案 / 卸载核验 / 部署脚本），**没有一条**"bypass 通道必须零副作用"的契约测试。新增一个 L2 能力只要 `input` 里写上 `dryRun`，就自动获得免审批通道，而它的 PS 实现是否早返回**无人检查**；参数经 splatting 原样透传（`psmod/ps-bridge.ps1:147,156-157,172`），键名大小写或分支写法错误都是**静默**的。psmod 侧已发生过同族事故（`app.ps1:782-789` 记录 KN2 起因：免审批路径上起了 `winget list` 子进程）。
2. **③ 属于"实现细节兜底安全"**：一旦 provider 不复用确定性执行器（§5.1 的替换场景），`validateParams` 就不存在，未声明 `dryRun` 的能力也会开始接受该键 → 绕过面从 3 个扩到 8 个，且行为取决于 PS 函数的未知参数处理。可替换性与安全性在此互相牵制。
3. **文档红线直接冲突且无裁决记录**：SECURITY §3.4:103「任何情况下不得提供绕过审批闸的配置开关或代码路径」，而 `docs/test/real-test.md:534`、`docs/02-design/CAPABILITY-MODEL.md:115`、`docs/design/r19b-s1-kn2-contract.md:198` 三处把 `allow:dry-run-bypass` 当作**公开语义**使用（后者并自警"该路径上的任何进程执行都没有人类审批兜底"）。两组文档互相矛盾，未见 ADR 裁决。
4. **审计侧无法区分**：bypass 记录的 `approval` 字段整体缺席（`index.ts:345-377` 仅在 `req.approvalId` 存在时写 approval），事后只能靠 `matchedRule` 字面串筛"免审批执行"与"宿主批准执行"。

修复动作见 §7.3 A1（把"是否声明并实现 dry-run"变服务端可证事实 + 落 `ext.bypass` 哨兵 + 契约测试），并同步 SECURITY §3.4 措辞（声明例外边界）。

---

## 5. 可替换性与扩展性评估

### 5.1 `AgentServiceProvider` SPI（VM 内 Agent 可替换）

| 检查项 | 证据 | 判定 |
|---|---|---|
| SPI 形状完备 | `contracts/src/bridge.ts`：必需 `id/kind/declareCapabilities/init/execute/runGoal/health/shutdown`；可选 `warmup/llmSessionHealth/llmSessionReset/llmSessionInjectFault` | **一致**：三个真实 provider（deterministic / workbuddy-llm / hermes）均满足必需集，可选能力以"方法存在性"探测（`server.ts:1188-1195` `provider.llmSessionReset === undefined` → 503），无类型断言 |
| 能力协商而非硬编码 | `server.ts:463-465` `registry.intersectDeclared(provider.declareCapabilities())`；deterministic 声明 6 个域通配（`adapter-agent-workbuddy/src/index.ts:196-199`） | **一致**（好设计）：换 provider 即换暴露面，degraded 收敛 `meta.*` |
| 动态加载 | `loader.ts:90` `await import(entry.package)`；`:38-50` 进程内工厂表（`factories` Map，模块级单例）；`git grep -F 'import('` 证实全仓唯一业务动态 import | **一致**：新 provider 包不需被框架静态引用（实证：`vm-service` 不引用 `adapter-agent-hermes`） |
| **摩擦 1：无 CLI 覆盖** | `vm-service/src/cli.ts` 全文无 `--provider` flag；切换需同时改配置 `agent.provider` 与 `agent.providers[...]` 两键（`config/index.ts:240-243` 仅取键合并） | 摩擦（P2）：与"一行切换"文档措辞（README.md:69）有距离——是"一行 JSON"，但需两处 |
| **摩擦 2：默认配置含 L2 包名** | `config/index.ts:96-112` `DEFAULT_SERVICE_CONFIG.agent.providers` 只登记 workbuddy 两项，**无 hermes**；hermes 仅存在于 `delivery/vm-service.config.json` | 摩擦（P2）：默认值即"隐式绑定第一个实现"，`defaults` 与"可插拔"精神相悖；且 hermes 部署必须带配置覆盖，缺失即 loader 找不到 entry（降级路径） |
| **摩擦 3：`--self-test` 与运行期纪律相反** | `cli.ts:156-159` `probeProvider` 对探测失败**硬抛错**；运行期 `loader` 对 import 失败**捕获并 degraded**（纪律见 `server.ts:519-525` 注释"失败只记日志，绝不阻断"） | 摩擦（P2）：同一"provider 不可用"事实，自检失败退出、生产不退出 → 自检绿灯不代表服务真能起（**假设**：这是刻意区分，但文档未声明） |
| **横向耦合（最需关注）** | `adapter-agent-workbuddy-llm` → `adapter-agent-workbuddy`；`adapter-agent-hermes` → 二者全部（§2.2 矩阵） | **偏差**：SPI 层面可替换，实现层面第三代 provider 依赖第一、二代私有实现。"零改动"仅对框架成立，**对 provider 家族不成立**；若替换掉 `workbuddy` 基础包，`hermes` 直接编译失败 → 可替换性被继承链削弱。ARCH-26（P1） |

### 5.2 宿主适配（Host 可替换）

- `host-sdk` 依赖面：仅 `@winvm/contracts`（`host-sdk/package.json`），`git grep -i 'workbuddy|codebuddy' -- packages/host-sdk/src` 命中 2 处均注释（§1 A-10）→ **中性成立**，新增 `adapter-host-cursor` 在类型层无障碍。
- `adapter-host-workbuddy` 是 L2，仅依赖 contracts + host-sdk → 宿主侧适配器之间**无横向耦合**（对比 VM 侧 provider 家族，宿主侧更干净）。
- 但 `host-a2a-bridge` 被标 `L3-host-bridge` 且依赖 `mcp-framework`+`a2a-framework`+`core`（4 个 L1）→ 它是**宿主侧真正承载协议的另一半**，"换宿主 Agent"实际要替换的不只是 adapter，还有该桥（其 approval-card/preview 逻辑部分在 `adapter-host-workbuddy`，如 `approval-card.ts:76-77,285-304` 的可逆性文案与 `isPermanent` 判定）。文档 §4.2 只讲插件清单层，未讲这一层 → **ARCH-27（P2，文档不完备）**。

### 5.3 多 VM 预留

- 全仓 `git grep -n -e vmId -e "多VM" -e 联邦 -e federation -- packages` → **零命中**（代码层完全没有实例标识维度）。
- 文档口径诚实：README.md:301「多 VM 联邦编排（V1 未做）：当前单 VM」；REQUIREMENTS.md:150 Q-4「默认：单 VM，**配置结构预留多实例**」。
- 核验"配置结构是否真预留"：`config/index.ts` 的 `ServiceConfig` 无 `vmId`/`instances` 字段，`agent.providers` 是 provider 的多值而非 VM 的多值 → **"预留"不成立**（P2，文档乐观）。
- 若要演进到多 VM，硬障碍清单（架构视角，均为**假设**性预判）：① 审计链目录 `cfg.audit.dir` 单值（`server.ts:377`）无 VM 维度；② 委派账本/`receiptCache`/`pendingApprovals` 全为**进程内单例**（`:529`、`:397-398`），跨 VM 归因需外部 id；③ `dtid` 归因链（`server.ts:1088`）假设"一个委派只落一个 VM"；④ SSH 隧道回环端口 `18443` 在 `config/index.ts:105` 硬编码为 provider 默认 endpoint → 多实例端口分配缺失。**结论**：V1 单 VM 定位清晰、无过度设计（正面），但"配置已预留"的说法偏乐观。

### 5.4 扩展性小结

| 扩展方向 | 现状 | 成本 |
|---|---|---|
| 加能力（同域） | `definitions.ts` 一条 `cap({...})` + `psmod/*.ps1` 一函数 | 低（注册表校验器 `core/src/registry/capability-registry.ts:104` 会拦 `timeoutMs` 过小等） |
| 换 VM 内 Agent | 新包 + 配置两键；**若复用既有 provider 实现则引入继承耦合** | 中 |
| 换宿主 Agent | `host-sdk` 中性，实现 `PluginManifest`/`SkillBundle` | 低-中（需另写桥） |
| 加通道（第三门面） | 需复用 `executeCapability` + 自建 `pendingApprovals` 绑定；无现成"门面注册"抽象 | 中-高（**假设**：需复制 `VmApprovalCoordinator.bind` 模式） |
| 多 VM | 无预留，需引入 vmId 贯穿 contracts/audit/ledger/config | 高 |

---

## 6. 问题清单（ARCH-01 … ARCH-33）

优先级口径：**P0** = 文档承诺的安全边界可被常规参数绕过 / 取证承诺实质失效；**P1** = 断言与实现存在结构性偏差，影响安全强度或可维护性，需变更单；**P2** = 契约漂移、文档漂移、工程卫生。

**共 33 项：P0 2 项 / P1 14 项 / P2 17 项**（编号连续 ARCH-01…ARCH-33，无空号）。

> **定级修订说明（本轮）**：**ARCH-02**（dry-run 免审批）初判 P0，经 §4.5 逐层取证可达性后**降为 P1（高）**并移至 P1 表首位 —— 今天不存在可被利用的免审批真实执行路径（四层隐式兜底均成立），但其保障完全依赖未被断言、未被测试的实现细节，故安全类偏差中优先级最高。据此最终计数为 **P0 1 项（ARCH-06）/ P1 15 项 / P2 17 项**（总数 33 不变，编号连续无空号）。

### P0

| ID | 现象 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| **ARCH-06** | `freshChainOnStart: true` 使**每次服务重启都重置链基线**，历史分片永久退出校验面 | `server.ts:377-382`（硬写 `freshChainOnStart: true` + 注释 `:372-376` 说明动机：历史含 seq=511/582 重复，续接则 `chainValid` 永远 false）；`chain.ts:75-81`（选项语义）；`chain.ts:311`（注释自陈"freshChain 模式仅校验本轮分片；历史分片归档可查但不参与判定"）+ `:312-313`（`const files = this.freshChain ? [...this.activeShards] : await this.listShards()`） | ARCHITECTURE.md:292/340「哈希链，任一改动即校验失败」的**实际范围被缩为"本次进程运行期"**。攻击面：篡改/删除上一次运行期间的审计文件（含被"清理"的整段窗口）在 `/health.audit.chainValid` 上**不可检出**——新链以 GENESIS 重起，`verifyChain` 不再读旧分片。这是"用一个安全断言的失效来修复另一个断言的噪音"，权衡未在 SECURITY 文档登记，也未在 `/health` 中透出校验范围 | ①短期（不改行为）：`/health` 增 `chain.scope: 'session'` + `shardsVerified/shardsArchived` 透出，让"校验范围"成可见事实，文档 §4.3 同步；②中期：启动时对**全部**分片跑一次"归档校验"（结果单独落 `ext.kind:'chain-archive-verify'` 条目，与当日链分开），历史断裂只告警不污染 `chainValid`；③根治：一次性历史修复（重算 seq/链）后关掉 `freshChainOnStart`；④分片间锚定：新分片首条 `prevHash` 引用上一分片末条 hash，形成不可静默丢弃整片的链条 |

### P1

| ID | 现象 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| **ARCH-02** | 策略引擎提供 `allow:dry-run-bypass`：**仅凭调用方自报 `params.dryRun === true`** 即放行 L2/L3 未审批请求进入执行段（**原报 P0，§4.5 取证后降 P1（高）**） | 绕过点 `engine.ts:597-600`；动机注释 `:592-596`；可达性四层判据见 §4.5（黑名单在前 `engine.ts:412-592` / 服务端无入参校验 `server.ts:583-620` / provider `validateParams` 拒未声明键 `adapter-agent-workbuddy/src/index.ts:265,751-800` / 3 个声明能力 PS 侧 `$DryRun` 早返回 `psmod/system.ps1:474-476`、`psmod/app.ps1:797-810`、`psmod/storage.ps1:176-177`）；红线冲突 `SECURITY-GOVERNANCE.md:103`；语义被公开引用 `docs/test/real-test.md:534`、`CAPABILITY-MODEL.md:115`、`docs/design/r19b-s1-kn2-contract.md:198` | 与 §3.4 红线**文本直接冲突**且无 ADR 裁决。今天不可利用，但**四层兜底全是隐式约定**：①新增 L2 能力只要在 `input` 写 `dryRun` 即自动获得免审批通道，其 PS 实现是否早返回无任何检查（splatting 原样透传，`psmod/ps-bridge.ps1:147,156-157,172`；`app.ps1:782-789` 记录的 KN2 事故正是"免审批路径上起了子进程"）；②兜底③位于 provider 私有实现，**换 provider 即失效**，绕过面由 3 个扩到 8 个（§4.1：7×L2 + 1×L3）；③bypass 记录 `approval` 字段整体缺席（`index.ts:345-377`），链上无法区分"免审批预览"与"宿主批准执行" | ①把"该能力是否声明并实现 dry-run"变**服务端可证事实**：`CapabilityDefinition` 增 `supportsDryRun: true`，引擎改为 `req.params.dryRun === true && cap.supportsDryRun === true`（`hasDryRunParam(cap)` `server.ts:1425-1433` 已存在，目前仅用于卡片文案）；②对未声明能力一律 `approval-required`；③审计写 `approval:{approvalId:'dry-run-bypass'}` 哨兵或 `ext.bypass:'dry-run'`；④补契约测试："凡可走 bypass 的回执必须 `data.dryRun===true` 且零副作用"；⑤SECURITY §3.4 显式登记该唯一例外及其约束（或删通道） |
| **ARCH-17** | 路径白名单实为 `C:\Users\**`（**全体用户目录**），比文档承诺的 `C:\Users\<vmuser>\**` 宽 | `defaults.ts:54-60` vs SECURITY §3.2:82；`storage.file.read` 风险 L0（`definitions.ts:284`，免审批） | 跨账户读写（其他用户 Profile/桌面/下载/凭据目录）在策略层放行；与 §10 风险表"限定用户目录"口径不符 → **横向信息泄露面** | 默认展开为 `C:\Users\${vmuser}\**`（运行时注入用户名）+ 显式保留 `C:\WinVMWorkspace\**`；或更新文档并明文声明"单用户 VM"前提 |
| **ARCH-18** | **命令白名单整体失效**：引擎编译 `cmdAllowRe` 后从不引用，能力级 `commandAllowlist` 同样零消费者 | 赋值 `engine.ts:395,405`；`git grep -n "this.cmdAllowRe" -- packages` → **仅命中赋值行**；`evaluate()` 内引用的是 `cmdDenyRe`（`engine.ts:463`）；默认值 `defaults.ts:17-18,84`（注释"未命中即拒"/"留空表示不启用"）；文档 `CAPABILITY-MODEL.md:201`、schema `contracts/schemas/capability.schema.json:50`；能力级 `definitions.ts:387`（`appops.workflow.run` 限定 node/python/pwsh/cmd/ffmpeg/magick/soffice/pandoc 9 个解释器）**不生效** | ①"白名单拒绝优先"模型缺一条腿（实际只有黑名单）；②`appops.workflow.run`（L1，可运行任意预置工作流脚本）的解释器约束是**装饰性**的——脚本内容与所调可执行文件不受策略引擎检查；③运维配置该字段无任何效果（虚假安全感，D-3 同类） | 二选一并同步文档/schema：(a) 在 cmdDeny 之后实现 `cmdAllowRe` 判定（非空即"未命中→拒"，注意默认空数组=不启用的语义）；(b) 从 `PolicyConfig`/`CapabilityPolicy` 删除该字段。若选 (a)，`appops.workflow.run` 的解释器限制顺带获得强制力 |
| **ARCH-01** | 号称的依赖方向门禁脚本不存在 | `package.json:16` → `scripts/dep-lint.mjs`（`ls -d scripts` 不存在）；README.md:143、ARCHITECTURE.md:341 与 §10 风险表以现在进行时宣称"由脚本把关 / CI 检查（FR-403）"；已登记失效：`docs/design/a5-approval-drop-fix-contract.md:836-844`（E-3）、`docs/changes/CL-K3R/REQUIREMENT.md:175,186`（E-4） | 铁律当前成立（§2 人工取证）但**无人守**；`tsc -b` 不拦 L1→L2 静态 import（模块解析能过） | 补 80 行内 `scripts/dep-lint.mjs`（读各包 `package.json`+扫描 `import ... from '@winvm/x'`，按 L0<L1a<L1b<L1c<L2<L3 判序），并把 `npm run layout` 接入现有 `build`/`verify` 脚本；文档改为"实现后由 X 把关"或删句 |
| **ARCH-03** | `requiresSession` 门禁只在一个 provider 内实现，框架/策略层无强制 | 实现：`adapter-agent-workbuddy/src/index.ts:276-289`（`unavailable`/`black-screen` → `SESSION_UNAVAILABLE`/`SESSION_BLACK_SCREEN`）；框架侧：`git grep -n "requiresSession" -- packages/mcp-framework packages/a2a-framework packages/vm-service/src packages/core/src` → **零命中**（仅 contracts 类型 + definitions 声明 + provider 消费）；SECURITY §3.1:66-74 把"6 会话要求不满足 → SESSION_UNAVAILABLE"写成**策略引擎第 6 步**，引擎内不存在（`engine.ts` 全文无 session 概念） | 换 provider（hermes / 未来 provider）若忘实现即**静默黑屏执行 GUI 能力**——正是 ARCHITECTURE.md:279 明令避免的行为；文档误导排障（按 §3.1 顺序去引擎里找 SESSION_UNAVAILABLE 找不到） | 把门禁上提到 `vm-service/src/server.ts:583 executeCapability()` 入口（服务持有 `sessionProbe`，已注入 `bridgeCtx`，`:405-447`），provider 侧保留为二次防御；文档 §3.1 顺序同步 |
| **ARCH-04** | `audit.snapshot: 'before-after' / 'after'` 是**纯元数据，零消费者** | 声明面：`definitions.ts` 30+ 处；消费面：`git grep -n -I -E 'audit\.(snapshot)|\.snapshot ===|SnapshotPolicy' -- packages` 除 contracts 类型定义（`capability.ts:40,58`）外**零命中**（`a2a-framework/src/server.ts:75` `DelegationTerminalSnapshot`、`persistent-session.ts:266` 为同名无关符号） | ARCHITECTURE.md:295「L2/L3 操作自动截图 + 变更清单作为 artifact 回传」与 SECURITY §3.2:88「强制快照 before/after」**未实现**；高危操作缺事后证据 | 最小实现：`executeCapability` 执行前后按声明调 `gui.screen.capture` + `Get-DirectorySize`（变更清单），产物名进 `artifacts`；或从文档删除该承诺并登记 V2 |
| **ARCH-05** | 审批四态在**审批级**折叠：链上只有"批准(隐含)"与"拦截(pending)"，**拒绝 / 超时 / 取消三种否定决策无审批级落点** | 写入点全集仅 5 处（§4.4 W1–W5），无一到达否定决策路径；委派级仅有**反推**出的壳终态：rejected 靠 `vm-service/src/server.ts:927-929`（`snap.state==='failed' && storedState==='rejected'`）反推、canceled 永不反推、timeout 连反推都没有（`storedState==='failed'` → terminalState='failed'）；框架侧 `a2a-framework/src/server.ts:305-308`、`task-store.ts:228-244`、`:183-195` 三处决策均无 sink（`server.ts:57` 注释自陈框架不拥有 AuditSink） | 违反 SECURITY §3.3:97「四态不得折叠为『未批准』」：**谁拒的、拒的是哪个 approvalId、何时拒**不可证；"超时"与"执行失败"在链上同为 `failed`（治理统计与 K-N1"非零活动证据"体系在否定侧留白） | 新增 `recordApprovalDecisionAudit(sink, {approvalId, decision:'rejected'|'timeout'|'canceled', actor, taskId})`（复用 `approval-replay.ts` 的 best-effort 纪律），在 `server.ts:242-251`/`:257`（raise 否定返回）与 `:539-551`（onApprovalTimeout）调用；canceled 由框架经现有回调注入（保持框架零审计依赖）。同时把 `approvalTimeout*` metadata 的事实转为链上条目 |
| **ARCH-07** | 服务端零鉴权：无 TLS、无 bearer 校验、无 Origin 校验；文档承诺的"第 1 层 传输与鉴权"在服务端缺席 | 客户端发 token：`core/src/transport/index.ts:72-78`；服务端：`server.ts:1059` `createServer`（`node:http`）；`git grep -i -e bearer -e Authorization -e origin -e createSecureServer -e tls -- packages/vm-service/src packages/core/src` → 无服务端消费；`cfg.security.tokenEnv` 唯一读取点是 `validateServiceConfig` 的回环检查（`config/index.ts:205-216`），**值本身从未被消费** | 一旦部署改为非回环（`requireLoopbackBind:false`）即为**裸 HTTP 零鉴权 RCE 面**（ARCHITECTURE.md:336 风险表把"SSH 密钥鉴权 + 仅回环 + 审批闸"列为缓解，前两项属部署事实而非代码保证）。`/admin/llm-session/reset`（`:1181`）虽有 env 门控，同样仅靠回环 | ①实现 `WINVM_SERVICE_TOKEN` 消费：`server.ts:1061` 后加统一守卫（`/health`、Agent Card 可豁免并文档化）；②`Origin` 白名单（文档已承诺）；③或在 SECURITY §2 明确"服务端不承担鉴权，由 SSH 隧道保证"并把 `requireLoopbackBind` 设为**不可关**（当前它是可配项） |
| **ARCH-09** | `AuditApproval.previewHash` 必填但服务端三处写入点恒为 `''`，"预览≠执行"比对从未实现 | 契约：`contracts/src/audit.ts:28-34`（`previewHash: string` 非可选）；写入：`approval-replay.ts:87-92`、`:171-176`、`adapter-agent-workbuddy/src/index.ts:366` 全 `''`；宿主侧确实算：`host-a2a-bridge/src/approval-audit.ts:104-116`，但仅存**进程内 Map**（`:120-121` `byApprovalId`/`byTraceId`，无 TTL、无持久化、不入哈希链） | SECURITY §3.3:99 承诺"哈希不一致即标记，不静默通过"**未实现**（两侧数据物理上永不相遇）；链上审批证据缺"用户当时看到什么"的唯一锚点；宿主 Map 重启即失，事后取证不可靠 | 服务端在 `pendingApprovals.set`（`server.ts:766-783`）时即算 `sha256(canonicalJson(preview))` 并存入 token，重放/续跑执行时用**留存 preview** 重算并写入 `approval.previewHash`（同一算法 `core/src/audit` 导出复用）；不一致时在条目 `ext` 记 `previewMismatch: true` |
| **ARCH-10** | `BridgeContext` 实际注入 6 个契约外字段，靠 `as unknown as` 双重断言 | `server.ts:405-447` 构造 `bridgeCtx`；契约 `contracts/src/bridge.ts` 的 `BridgeContext` 未声明 `capabilityDefs`/`sessionProbe`/`healthSnapshot`/`reportNetCfg`/`delegationTraceId?`/`delegationProbe`；provider 侧同样 cast：`adapter-agent-workbuddy/src/index.ts:341` `(this.ctx as unknown as {reportNetCfg?...})` | SPI 是"可替换性"的根基，而**真实 SPI 形状大于契约**：第三方 provider 只看 `contracts` 无法获知这些能力，且一旦服务端改名即静默 undefined（无编译期保护）。违反"contracts 是唯一契约源"（ARCHITECTURE.md:83,120） | 把这 6 个字段正式纳入 `BridgeContext`（可选字段 + 文档说明），或引入 `ExtendedBridgeContext` 让服务端与自家 provider 共享；删除跨包 cast |
| **ARCH-20** | MCP 通道审批令牌无 TTL/清扫（A2A 有） | `server.ts:529` `pendingApprovals = new Map()`；删除点仅 `:864`（续跑消费）、`:280`（重放后一次性删除）、`:543`（A2A TTL 回调）；纯 MCP blocked 令牌若宿主永不应答即常驻 | 进程内无界增长（有界性缺失）；`collectApprovalFacts` R3 时间窗归因（`approval-replay.ts:348-382`）会因陈旧令牌增加误归因风险；SECURITY §3.4:106"V1 未实现 TTL"已登记，但**A2A 侧其实已实现**，文档与实现互不对齐 | 复用 TaskStore TTL 思路：`setInterval` 清扫 `createdAtMs + approvalTimeoutMs < now` 的令牌，并经 ARCH-05 落 `timeout` 决策审计；顺带让 `approvalTimeoutMs`（当前为死配置，见 §4.2 表末行）获得真实消费者 |
| **ARCH-21** | 链上脱敏正则缺 `passphrase`，宿主侧已点名规避而 VM 侧未修 | `chain.ts:42` `SENSITIVE_KEY_RE = /(password\|passwd\|secret\|token\|apikey\|api_key\|credential\|privatekey\|private_key)/i`（无 `passphrase`）；`host-a2a-bridge/src/approval-audit.ts:39-40` 并集含 `passphrase`，其注释 `:48-52` **明确写"core 的凭据正则缺 passphrase/apikey/credential → 会漏脱敏（违反 A7/NFR-6）"** | 私钥口令类参数明文入哈希链（链文件通常可被备份/上传，且 `a2a / query`、`/audit/receipt` 会回显）；两端口径分裂本身即治理风险 | 把并集正则提为 **contracts 单一导出**（`contracts/src/audit.ts` 或 `core` 导出常量），两侧引用同一份；补一条链上回归测试（`{passphrase}` 必须 `***REDACTED***`） |
| **ARCH-22** | `tasks/cancel` 是**外观性取消**：不中止执行，且链上终态与协议终态矛盾 | `task-store.ts:183-195`（`cancelRequested = true` + `updateStatus('canceled')`）；**`cancelRequested` 全仓零读取点**（`git grep -n cancelRequested -- packages` 仅 `:51` 声明 / `:116` 初始化 / `:188` 赋值）；runner 不知情 → `a2a-framework/src/server.ts:340-378` 继续跑完并 `onGoalTerminal({state:'completed'\|'failed'})` → `vm-service/src/server.ts:927-929` 的 terminalState 反推只识别 `failed + storedState==='rejected'` 一种不一致，**永不产出 `'canceled'`**；`addArtifact`（`task-store.ts:169-175`）无终态守卫 | ①**高危操作被"取消"后仍在执行**（宿主 UI 已显示 canceled，`host-a2a-bridge/src/tools.ts:415,432-433` 据此渲染"未执行任何变更"文案 —— 与实际相反，属**误导宿主**的安全相关缺陷）；②已取消任务持续推送 artifact（未授权副作用）；③哈希链上"取消"这一决策**永远不可见**（契约 `contracts/src/a2a.ts:74` 与 `bridge.ts:21,27` 都定义了 canceled，实现从不落到证据面） | ①runner/provider 侧检查 `rec.cancelRequested` 并在能力边界处中止（`ToolContext.signal` 现成但从未接通 —— 见 ARCH-29，正好复用）；②`vm-service/src/server.ts:927-929` 增 `storedState==='canceled' ⇒ terminalState='canceled'`；③`addArtifact`/`updateStatus` 对 canceled 任务加守卫；④与 ARCH-05 合入同一"否定决策可证"变更单 |
| **ARCH-26** | provider 家族**横向继承耦合**：第三代 provider 依赖第一/二代实现包 | `adapter-agent-workbuddy-llm` deps 含 `@winvm/adapter-agent-workbuddy`；`adapter-agent-hermes` deps 含 `-workbuddy` **与** `-workbuddy-llm`（§2.2 矩阵，`package.json`+tsconfig references 双证） | "换 Agent 零改动"对框架成立、对 provider 家族不成立：移除/重构基础 provider 会连带打断后续所有 provider；ADR-10 的可插拔收益被稀释 | 把复用部分下沉为 `core` 或新建 `packages/adapter-agent-shared`（L2-leaf，不依赖任何具体 provider）；在 ARCHITECTURE §4.1 明示 provider 依赖 DAG 与"可独立移除"验收标准 |
| **ARCH-28** | tsconfig references 与 package.json 依赖不同步（构建图缺边） | ①`vm-capabilities/tsconfig.json` references 仅 `../contracts`，但 `src/index.ts:14` `import type { SessionProbe } from '@winvm/core'`（package.json 已声明 core）；②`vm-service/tsconfig.json` references 缺 `../adapter-agent-workbuddy-llm`（package.json 已声明，且 loader 运行期动态 import 它） | composite 构建不保证被引用项目先产出 `.d.ts` → 干净环境下 `tsc -b` 顺序依赖偶然性；第二项使"动态 import 的运行时依赖"在类型/构建图上完全隐形（**假设**：当前能过是因为 `tsc -b tsconfig.build.json` 根引用了全部项目） | 补齐两条 references；把"package.json 依赖 ⇔ tsconfig references"一致性做成 ARCH-01 dep-lint 的一条附带检查（零成本） |

### P2（契约漂移 / 文档漂移 / 工程卫生）

| ID | 现象 | 证据（文件:行号） | 建议 |
|---|---|---|---|
| ARCH-08 | L3「二次确认」只存在于宿主卡片文案，服务端无强制 | `contracts/src/risk.ts:7`（"L3 需审批 + 二次确认 + dry-run 前置"）；无服务端实现（`engine.ts:597-607` 仅一道审批闸；`git grep -i "二次确认\|doubleConfirm" -- packages` 仅命中 `adapter-host-workbuddy/src/approval-card.ts:733-738` 文案族）；dry-run 前置更未强制 | 契约文案降级为"宿主呈现层建议"，或在服务端对 L3 要求"同 traceId 存在前置 dry-run 条目"才放行（可用现有 `audit.query({traceId})`） |
| ARCH-11 | `approvalTruth` 违反"构造期一次解析"纪律：2 处独立读 env | `contracts/src/bridge.ts` 注释自陈纪律；实现 `adapter-agent-workbuddy-llm/src/bridge.ts:767` 与 `index.ts:171` 各调 `resolveApprovalTruth(process.env)` | provider 构造时解析一次存入字段，`health()` 只读该字段（`/health` 的 shadow 轮也能给出与配置一致的值） |
| ARCH-12 | 契约字段 `approvalTruth` 在 `/health` 被改名 `providerApprovalTruth` | `server.ts:1332` vs `contracts/src/bridge.ts:154-158`（落点注释写 `/health.approvalTruth`）；另 `provider.health()` 超时降级时该字段整体缺席（`...(providerHealth?.approvalTruth ? … : {})`） | 统一为契约名；降级时输出 `{status:'unknown'}` 而非省略，避免消费方 undefined 分支 |
| ARCH-13 | provider 内第二次 `policy.evaluate` 丢失 `capabilityPolicy` | `server.ts:596,759` 传 `capabilityPolicy: cap.policy`；`adapter-agent-workbuddy/src/index.ts:246-252` **不传** → 能力级覆盖（`definitions.ts:387` 的 pathAllowlist 等）在第二轮被跳过 | provider 不重复评估（服务端已评），或透传同源 `cap.policy`；加一条"两轮回同一结论"的断言测试 |
| ARCH-14 | **文档漂移族**（5 项，均文档单侧错误，非实现缺陷） | ①分层标注三处互斥：代码 `layer`（§2.2 表）vs ARCHITECTURE.md:125-129（vm-service/vm-capabilities/host-a2a-bridge 同列 L2）vs README.md:138（adapter 列 L3）；②§3.2 落点写 `policy.default.json`（文件不存在，实为 `defaults.ts:33` 常量）；③§6.3:270 指向 `vm-capabilities/session-guard`（无该文件/能力；真实落点 `core/src/session/health.ts` + provider `index.ts:276`）；④INTERFACES.md §2.3:43 声称 `meta.*` 5 工具（`meta.audit.query`/`meta.policy.describe`/`meta.task.status` 未注册，实际仅 3 个：`definitions.ts:71,84,95`）；⑤§3.1 判定 8 步与 `engine.ts:412-611` 实际顺序/步骤名不符（SESSION_UNAVAILABLE 步缺失、maxRisk 与审批闸对调） | 一次性"设计文档对账"变更单：以代码为源逐节修订 5 处，并在 `docs/02-design/*.md` 首部标注"最后对账 commit/日期" |
| ARCH-15 | traceId 生成器两套，框架侧非加密随机 | `mcp-framework/src/server.ts:78-82`（`traceSeq++` + `Date.now()`）vs `core/src/index.ts:110-116`（`randomUUID` 派生）；两通道门面各用各的 | 框架改用 `core` 导出函数（依赖方向允许：L1b→L1a） |
| ARCH-16 | 统一返回结构缺字段（失败路径无 `durationMs`/`auditRef`） | INTERFACES.md §2.4 vs `server.ts:853-861`（策略拒绝）、`:818-833`（审批拦截）、`:621-630`（执行段拒绝）；成功路径齐备（`server.ts:668-683`，`auditRef` 源 `adapter-agent-workbuddy/src/index.ts:379`） | 拒绝路径把 W3/W4 返回的 `record.auditId` 填入 `auditRef`（现已 `void` 丢弃，`server.ts:605` 未 await），失败样例即可对齐文档 |
| ARCH-19 | 进程黑名单按**键名**匹配，覆盖面窄 | `engine.ts:558-559`（仅 `/\b(process\|name\|processName\|target)\b/i` 的键参与判定）→ `{killer:'lsass'}`、路径型参数含 `lsass.exe` 均不拦 | 追加"值形态"判定：对任意字符串值做 `basename` + `.exe` 归一后与 `procDeny` 比对（与 `looksLikeRegistryPath` 同风格），保持拒绝优先 |
| ARCH-23 | HTTP 层 405/400/404/500 仅日志，不入审计 | `server.ts:1065-1068`、`:1109-1112`、`:1183`、`:1206`、`:1207-1209` | 至少对"畸形/未知请求"计数并透出 `/health`（避免探测无痕）；或在 SECURITY 明文"取证面仅能力级" |
| ARCH-24 | `/admin/llm-session/reset`（可复位常驻会话、可注入 spawn 故障）不入链 | `server.ts:1179` 注释自陈"不入哈希链"、`:1187` 仅 `logger.warn` | 运维动作落 `ext.kind:'admin-action'` 审计条目（与执行面分离即可满足原纪律，但**证据面必须留痕**）；`faultInjection` 尤其需要 |
| ARCH-25 | 服务进入 degraded（provider 加载失败）不落链；`PROVIDER_UNAVAILABLE` 返回也不落 | `server.ts:466-525`（仅日志）、`:633-641`（提前 return，未触达 W1–W5） | 启动状态变化落一条 `ext.kind:'service-state'` 条目，使"某窗口处于 degraded"事后可证 |
| ARCH-27 | 宿主替换面文档不完备：换宿主实际要换的不止 adapter | `host-a2a-bridge`（L3）依赖 4 个 L1（§2.2）；宿主文案/判定散在 `adapter-host-workbuddy/src/approval-card.ts:76-77,285-304` | ARCHITECTURE §4.2 补"宿主替换 = adapter + bridge 两部分"的分层说明与最小实现清单 |
| ARCH-29 | `ToolContext.signal?: AbortSignal` 声明后从不构造/从不消费（死契约） | `mcp-framework/src/server.ts:32`（声明）；`git grep -n "signal" -- packages/mcp-framework packages/vm-service packages/adapter-agent-workbuddy` → 无 `ctx.signal` 读取点、无注入点 | 要么接通（HTTP 断连时中止执行段），要么删除字段——留着会让人误以为支持取消 |
| ARCH-30 | Agent Card「生成**与签名**」签名从未实现 | ARCHITECTURE.md §2.2:123；`git grep -i signature -- packages/a2a-framework/src packages/contracts/src` 仅命中 `contracts/src/a2a.ts:159` 可选字段；构造点 `server.ts:976-1029` 无签名 | 文档去掉"签名"或登记 V2；若保留字段则文档标注"未实现" |
| ARCH-31 | A2A 运行时状态全为进程内：TaskStore 无持久化、SSE 无心跳/keepalive | `git grep -n -e persist -e writeFile -- packages/a2a-framework/src/task-store.ts` → 零命中；`git grep -i -e heartbeat -e keepalive -- packages/a2a-framework/src packages/vm-service/src` → 零命中（仅 `ps-bridge.ts:250` PSBRIDGE_HEARTBEAT_TIMEOUT 属另一域）；REQUIREMENTS.md:115 已把"任务队列持久化"列非目标，但 **SSE 空闲断连**未在文档披露 | 至少加 SSE 注释行心跳（`:ping`）与 `tasks/subscribe` 重放语义说明；持久化按 V2 处理 |
| ARCH-32 | 超时链层级多、口径散（6+ 层，各自 env 覆盖），排障需心算 | `constants.ts:295-299`（A2A 600s）、`task-store.ts:92-96`（审批 30min）、`definitions.ts` 每能力 `timeoutMs`（如 `app.ps1` 卸载内部再自管 600s 预算：`:760-765`）、`ps-bridge.ts:276,352`（15s ready / 调用超时）、`transport/http-channel.ts:71`、`adapter-agent-workbuddy/src/index.ts:317-325`（注册表优先，注释 `:310-316` 记录对齐过程） | 出一份「超时预算表」文档（谁包含谁、约束不等式），并在 `/health` 透出关键值；长期：统一由 `executeCapability` 施加 deadline 并向下传播 |
| ARCH-33 | provider 切换需改两处且无 CLI/无默认登记 | `config/index.ts:96-112`（默认仅 workbuddy 两项）、`:240-243`（浅取键合并）、`vm-service/src/cli.ts`（无 `--provider`）；README.md:69"一行切换" | 增 `--provider` 覆盖；`validateServiceConfig`（`:205-216`）补"provider entry 可解析"检查，避免运行期才发现降级 |

---

## 7. 架构债台账与完善路径建议

### 7.1 债务台账（D-1 … D-12）

| ID | 债务 | 证据 | 类型 | 关联发现 | 偿还成本 |
|---|---|---|---|---|---|
| **D-1** | **服务级单例归因**（A5 同型根因）：`VmApprovalCoordinator.activeTaskId` 是**进程内唯一槽位**，并发委派交叠时靠"归属判据"缓解而非消除 | `server.ts:140-141`（单字段）、`:186-201`（`beginTask`/`endTask(taskId?)` 归属释放）、`:206`（`req.taskId ?? this.activeTaskId` 兜底）；`contracts/src/bridge.ts:336-357`：`beginTask`/`endTask` 均已 `@deprecated` 但**"本迭代不删除"**，仍被 `adapter-agent-workbuddy-llm/src/bridge.ts:807,813` 调用 | 结构债（已缓解，未根治） | ARCH-05（否定决策归因同样依赖这一槽位） | 中：改为 `Map<taskId, ctx>` 或把 taskId 全链路显式化后删两方法（需一次跨包重构 + 回归） |
| **D-2** | **证据面与执行面二分**：审批否定/运维/协议层事件只进 `logger`，不进哈希链 | §4.4 G1–G6；`a2a-framework/src/server.ts:57` 注释把"框架零审计依赖"当纪律陈述 | 认知债（设计选择，代价被低估） | ARCH-05 / ARCH-22 / ARCH-23 / ARCH-24 / ARCH-25 | 低-中：保留"框架不拥有 sink"，用**已有回调注入**（`delegationObserver` 模式）补 5 个落点 |
| **D-3** | **死配置与死字段群**：策略与契约里存在"写了但没人读"的字段，制造虚假安全感 | `engine.ts:395,405`（`cmdAllowRe` 无读取）；`defaults.ts:28,124`（`approvalTimeoutMs` 零消费）；`defaults.ts:30`（`endpointAllowlist` 仅 defaults.ts 内部出现，无消费者，`git grep` 证）；`capability.ts` `audit.snapshot` 30+ 声明零消费（ARCH-04）；`mcp-framework/server.ts:32` `ToolContext.signal` 死契约；`contracts/src/a2a.ts:159` `signature?` 无实现 | 契约债（最危险的一类：**看起来有防护**） | ARCH-04 / ARCH-18 / ARCH-20 / ARCH-29 / ARCH-30 | 低：每处"实现或删除"二选一；建议加一条 lint（导出接口字段被引用计数=0 即告警） |
| **D-4** | **门禁缺失**：分层与文档一致性完全靠人肉 | `package.json:16` → 不存在的 `scripts/dep-lint.mjs`；§2.3 | 流程债 | ARCH-01 / ARCH-14 | 低：单脚本 80 行内可覆盖 dep-lint + references 一致性（D-6） |
| **D-5** | **SPI 大于契约**：`BridgeContext` 真实形状靠 cast 维持 | `server.ts:405-447`（6 个契约外字段）+ `adapter-agent-workbuddy/src/index.ts:341`（消费侧同款 cast） | 契约债 | ARCH-10 | 低-中：契约补可选字段，或引入扩展接口 |
| **D-6** | **构建图 ≠ 声明图**：Project References 缺边 | `vm-capabilities/tsconfig.json`（缺 `../core`，但 `src/index.ts:14` 用之）；`vm-service/tsconfig.json`（缺 `../adapter-agent-workbuddy-llm`） | 工程债 | ARCH-28 | 极低：补 2 行 |
| **D-7** | **全局/进程内可变状态**（重启即失、多实例不可行） | 模块级：`core/src/bridge/loader.ts:38`（`factories` Map）、`mcp-framework/server.ts:78`（`traceSeq`）、`a2a-framework/client.ts:13`、`mcp-framework/client.ts:10`、`vm-capabilities/ps-bridge.ts:56`、`adapter-agent-workbuddy-llm/delegation-truth.ts:167`（`approvalWaitFallback` 模块级单例）、`host-a2a-bridge/approval-audit.ts:120-121`（宿主审批 Map，无 TTL/无持久化）；装配级：`pendingApprovals`（`server.ts:529`）、`TaskStore`（`:538`，无持久化）、`LedgerRegistry`/`ReceiptCache`（`:397-398`） | 结构债（V1 单实例前提下可接受，但**阻断多 VM/水平扩展**） | §5.3、ARCH-31、ARCH-20 | 高：需引入外部存储或至少有界化 + TTL；V1 建议仅做"有界化 + `/health` 透出规模" |
| **D-8** | **进程生命周期与业务耦合**：Windows 会话（tscon/自动登录/禁休眠）属部署脚本域，代码侧只有探针 | `core/src/session/health.ts`（SessionMonitor，`server.ts:361-370` 启动）；`git grep -I 'tscon\|Autologon' -- packages` 零命中；ARCHITECTURE.md:270 指向的 `vm-capabilities/session-guard` **不存在** | 文档/职责债 | A-14 / ARCH-14③ | 低：文档明确"恢复动作在 delivery 脚本，包只探测+降级" |
| **D-9** | **超时链复杂度**：6+ 层各自 env，包含关系无文档 | `constants.ts:295-299`、`task-store.ts:92-96`、`definitions.ts` 各 `timeoutMs`、`app.ps1:760-765`（PS 内自管预算）、`ps-bridge.ts:276,352`、`http-channel.ts:71`、`adapter-agent-workbuddy/src/index.ts:310-325`（注释记录了"两通道口径对齐"的补丁过程） | 认知债（已导致 A5/K2 类事故，见 `:310` 注释引用） | ARCH-32 | 中：出一份"超时不等式"文档 + `/health` 透出 |
| **D-10** | **安全断言强度依赖部署事实**（回环 + SSH 隧道），代码不保证 | ARCH-07；`server.ts:1104` 注释"与 /health 同级（服务仅 loopback 监听）"、`:1173`"不新增鉴权体系——服务仅 loopback 监听" —— 多处安全推理的**公理是部署形态**，而 `requireLoopbackBind` 是可配项（`config/index.ts:205-216`） | 安全债 | ARCH-07 | 中：服务端 bearer 校验（或把回环约束变为不可关） |
| **D-11** | **重复实现**（同功能两处） | traceId 生成 2 套（ARCH-15）；脱敏正则 2 套（ARCH-21）；策略评估 3 个调用点且参数不一致（ARCH-13）；`cli.ts:106` 与 `loader.ts:90` 重复的 provider 探测 | 工程债 | ARCH-13 / ARCH-15 / ARCH-21 | 低：提为单一导出 |
| **D-12** | **文档乐观表述**与实现边界不符 | README.md:69"一行切换"（实为两处，ARCH-33）；REQUIREMENTS.md:150 Q-4"配置结构预留多实例"（实无 vmId，§5.3）；ARCHITECTURE.md:123"签名"（未实现，ARCH-30）、:295"自动截图+变更清单"（未实现，ARCH-04）、:341"CI 脚本把关"（不存在，ARCH-01） | 文档债 | ARCH-01/04/30/33、§5.3 | 低：一次对账（并入 ARCH-14 变更单） |

### 7.2 根因归纳（为什么会成批出现"写了没接"）

1. **契约层"先声明后实现"的惯例没有配套回收机制**：`contracts` 里加字段零成本（可选字段、类型宽松），而"字段是否被消费"没有任何检查（D-3/D-11）。6 个死字段中 4 个是**安全承诺**（snapshot、commandAllowlist、approvalTimeoutMs、signature）——这是最危险的组合：文档读起来有防护，运行时没有。
2. **S-x 系列修复的"成对纪律"依赖人工**：`defaults.ts:99-109` 与 `engine.ts:515-523` 的 S-5 注释明确记录"修判据 (a) 必须与补白名单 (b) 成对同 commit，否则封死合法流程"——纪律被写在注释里而非门禁里（D-4）。同一模式的 S-1/D9/D11/KN2 都靠注释 + 真机测试报告维持。
3. **取证面设计只覆盖"执行"这一条轴**：`audit` 与 `logger` 二分（D-2）在 CL/设计变更中反复出现（`server.ts:602-604` "取证盲区闭合 S-4"、`approval-replay.ts:87` blocked 落痕、K-N1 非零活动证据），每次都是**事后补一个执行侧落点**，而没有先定义"哪些决策必须可证"的清单。审批三态（拒绝/超时/取消）恰好全在非执行侧，因此**系统性遗漏**，不是偶发 bug。
4. **安全边界外包给部署**：D-10 使 ARCHITECTURE.md §10 风险表的"缓解措施"多数不是代码断言。当配置项 `requireLoopbackBind:false` 时，整表失效且无告警（**假设**：`validateServiceConfig` 关回环检查后不会有任何日志提示，建议核实）。

### 7.3 完善路径建议（三条批次，按"证据面 > 绕过面 > 卫生"排序）

**批次 A｜本轮即修（唯一 P0 + P1 首位，两处，改动面小、收益是安全承诺成立）**

| 步 | 动作 | 落点 | 验收 |
|---|---|---|---|
| A1 | dry-run 免审批改为**服务端可证**：能力显式声明 `supportsDryRun` 才允许 bypass；未声明一律 `approval-required` | `contracts/src/capability.ts` + `definitions.ts`（L2/L3 的 3 个已实现 dryRun 的能力：`system.power.control`、`app.winget.uninstall`、`storage.file.delete`）+ `engine.ts:597-600` 判定改为双条件 | 新增用例：`{dryRun:true}` 打给未声明能力 → 仍 `APPROVAL_REQUIRED`；打给已声明能力 → `allow:dry-run-bypass` 且链上条目 `ext.bypass='dry-run'`；SECURITY §3.4:103 措辞同步（承认"仅对声明能力"） |
| A2 | 链校验范围**显式化**：`/health.audit` 增 `scope:'session'` + `shardsVerified/shardsTotal`；文档 §4.3 把"任一改动即校验失败"限定为"本轮运行期内"；同时启动时跑一次历史分片归档校验，结果单独落 `ext.kind:'chain-archive-verify'` | `server.ts:1255 buildHealth`、`chain.ts:311-313`、`ARCHITECTURE.md:292,340`、`SECURITY §4.3` | 重启后 `/health` 能看到"校验了几片/共几片"；篡改上一轮分片 → 归档校验条目报 break（即使 `chainValid` 仍 true） |

**批次 B｜下一个变更单（P1，安全强度与证据面，建议按 D-2 → D-3 → dep-lint 顺序）**

| 步 | 动作 | 落点 |
|---|---|---|
| B1 | 补齐审批否定决策审计（rejected / timeout / canceled 三态落链）+ cancel 收口 observer → 一并解决 ARCH-05/ARCH-22 | `server.ts:242-251`、`:539-551`、`a2a-framework/src/server.ts:305-308,430-434`；新函数放 `approval-replay.ts`（复用 best-effort 纪律） |
| B2 | `previewHash` 落地：登记 token 时算、执行时重算并比对，不一致落 `ext.previewMismatch`（ARCH-09） | `server.ts:766-783`（存）+ `:583` 执行段（比）+ `approval-replay.ts:87-92,171-176`（填）；算法从 `core/src/audit` 单一导出，宿主侧同引用 |
| B3 | `requiresSession` 上提到 `executeCapability`（ARCH-03），换 provider 不再失去门禁 | `server.ts:583` 入口（`sessionProbe` 已在 `bridgeCtx`，`:405-447`）；provider 侧 `adapter-agent-workbuddy/src/index.ts:276-289` 保留为二次防御；SECURITY §3.1:66-74 步序同步 |
| B4 | 服务端 bearer 校验，或把"仅回环"变为不可关（ARCH-07 / D-10） | `server.ts:1059-1068` 前加统一守卫；`config/index.ts:205-216` `requireLoopbackBind` 语义收紧；`security.tokenEnv`（现零消费）转为服务端消费 |
| B5 | 死字段清理（D-3）：`commandAllowlist` 实现或删除、`approvalTimeoutMs` 接通或删、`endpointAllowlist` 同上、`snapshot` 实现或降为"信息性"、`ToolContext.signal` 删除（ARCH-04/18/20/29） | `engine.ts:395,405`（cmdAllowRe 无读取）、`defaults.ts:28,30`、`capability.ts:40,58`、`mcp-framework/src/server.ts:32` |
| B6 | `scripts/dep-lint.mjs`：①分层方向 ②package.json ⇔ tsconfig references 一致性 ③`layer` 字段 ⇔ ARCHITECTURE §2.2 表一致性；接入 `verify`（ARCH-01/28，一次解决 D-4/D-6） | 新建 `scripts/dep-lint.mjs`；`package.json:16` 现成入口；`tsconfig.build.json` 根引用顺序 |
| B7 | 脱敏正则统一为 contracts 单一导出 + 链上 `passphrase` 回归测试（ARCH-21）；路径白名单收紧到 VM 用户目录（ARCH-17） | `chain.ts:42` vs `host-a2a-bridge/src/approval-audit.ts:39-40`；`defaults.ts:54-60` |

**批次 C｜结构性（P1 尾 / P2，可排 V2，但需先"停止说谎"）**

| 步 | 动作 |
|---|---|
| C1 | `BridgeContext` 契约化（ARCH-10 / D-5），删除跨包 `as unknown as` |
| C2 | provider 家族解耦：下沉 `adapter-agent-shared`（ARCH-26 / §5.1），并把"每个 provider 可独立移除"写进验收 |
| C3 | `activeTaskId` 根治：taskId 全链路显式 → 删 `beginTask/endTask`（D-1，契约已 `@deprecated`，属"承诺还债"） |
| C4 | 设计文档对账变更单（ARCH-14 的 5 项 + ARCH-12/16/27/30 + D-12），并在每篇 `docs/02-design/*.md` 首部加"最后对账日期" |
| C5 | 超时预算表 + `/health` 透出关键时限（D-9 / ARCH-32） |
| C6 | 多 VM：若确认要做，先在 `contracts` 引入 `vmId` 维度（audit/ledger/config/endpoint），再谈实现；若不做，删除 REQUIREMENTS.md:150"配置结构预留多实例"表述（§5.3） |

### 7.4 与既有登记的衔接（避免重复立项）

- ARCH-01（dep-lint 缺失）**已被登记两次**：`docs/design/a5-approval-drop-fix-contract.md:836-844`（E-3）、`docs/changes/CL-K3R/REQUIREMENT.md:175,186`（E-4），两处均"本轮不修"。本报告不另立编号，仅补充"README/ARCHITECTURE 仍用现在进行时宣称存在"这一**文档失实**维度（并入 C4）。
- ARCH-03 的根因与 ARCHITECTURE.md §3.1（SECURITY 同名节）判定步序偏差同源，与 S-1/S-5 的"成对修复"纪律同源 → 建议 B3/B5 合入同一个"策略引擎对账"变更单。
- ARCH-02（dry-run 绕过）在测试文档中已被当作**公开语义**描述（`docs/test/real-test.md:534`、`docs/02-design/CAPABILITY-MODEL.md:115`、`docs/design/r19b-s1-kn2-contract.md:198` 且该处已警示"免审批路径上任何进程执行都没有人类审批兜底"）——即团队**已知其风险但按设计保留**。首轮曾定 P0，§4.5 完成可达性取证后降为 **P1（高）**（今天无可利用路径），但保留在批次 A 的理由不变：它与 SECURITY §3.4:103 红线**文本直接冲突**，两者必须有一个被修改（改文档 = 声明例外边界；改代码 = A1 方案）；且 psmod 侧已有 KN2 事故（`app.ps1:782-789`）证明"免审批路径上起了子进程"确实发生过，而当前唯一的防线（provider 私有 `validateParams`）与可替换性目标天然冲突——换 provider 即失去该防线。

### 7.5 审计方法与局限

- **只读取证**：未运行 `tsc -b`/`npm run build`（避免产生构建产物，遵守任务书约束），因此 ARCH-28（references 缺边）的实际破坏性未经复现验证 —— 标注为**假设**：当前构建能过很可能依赖根 `tsconfig.build.json` 的全量引用顺序。
- **未执行任何 git 写操作**；未修改除本报告外的任何文件。
- **否定性结论**（"X 不存在/无消费者"）全部经两种 pathspec 复核：目录式 `-- packages`（可靠）与通配式 `-- 'packages/*/src'`（**实测对 `requiresSession`/`dryRun` 返回假阴性 0 命中**）。内置 Grep 未用于任何否定性结论。
- **未审范围**：`delivery/*` 部署脚本与 skills 文档内容一致性（属交付文档审计成员）、ps-bridge 协议健壮性（属实现/运维审计）、单测覆盖率。
