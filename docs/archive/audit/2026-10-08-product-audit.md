# 产品功能域审计报告（2026-10-08）

| 项 | 值 |
|---|---|
| 审计人 | 许清楚（产品经理 / software-product-manager） |
| 审计类型 | 只读产品功能域评估（需求完整性 · 能力覆盖 · 用户旅程 · 需求池） |
| 基线 | HEAD `f3f74c8`（docs: ddd 索引与概览同步），测试基线 1054/1054 |
| 证据口径 | 全部结论带 `文件:行号`；无直接证据的推测显式标注「**假设**」 |
| 能力真源 | `packages/vm-capabilities/src/registry/definitions.ts`（54 条 cap，逐条读毕）+ `packages/vm-capabilities/psmod/*.ps1` 函数清单 |

---

## 0. TL;DR（最重要发现）

1. **文档承诺的 7 个能力在代码里根本不存在**（`PM-03`，P0）：`CAPABILITY-MODEL.md`/`INTERFACES.md` 把 `system.update.manage`、`app.process.activate`、`app.default.manage`、`gui.browser.control`、`meta.audit.query`、`meta.policy.describe`、`meta.task.status` 列为已注册能力，全仓 `git grep` 证实这 7 个 ID **只出现在文档与 Skill 文案里**，`definitions.ts` 与 `psmod/*.ps1` 均无定义/实现。其中 `gui.browser.control` 是场景文档 C（网页端生产）/ E（周报流水线）的**主执行能力**（`SCENARIOS.md:15,118,224,315`），意味着这两条门面场景当前**整条不可执行**。
2. **"最可监管"的核心差异化卖点之一——before/after 快照——只有声明没有实现**（`PM-01`，P0）：26 处能力标注 `snapshot:'after'/'before-after'`（after 20 + before-after 6，经 `definitions.ts:61` 写入 `audit.snapshot`），`SECURITY-GOVERNANCE.md:88,245` 承诺"L2/L3 强制 before/after 快照"，但全仓 grep 无任何运行期消费点（`contracts/src/capability.ts:40,58` 为唯一类型定义）。审批卡"preview/artifact 可对比确认无意外覆盖"（`README.md:259`、`SCENARIOS.md:264-265`）因此落空。
3. **HTTP 直连模式的安全声明与实现不符**（`PM-02`，P0）：`REQUIREMENTS.md:79`（NFR-510）要求"Streamable HTTP 模式强制 TLS + bearer token + Origin 校验"，实测 VM 侧只有 `node:http` 明文服务（`packages/vm-service/src/server.ts:13,1059`，全仓无 `https.createServer`/无 Origin 校验），bearer **仅在客户端注入**（`core/src/transport/index.ts:76-80`、`adapter-host-workbuddy/src/index.ts:129`），服务端零校验。回环 + SSH 隧道部署下风险可控，但配置一旦 `requireLoopbackBind=false`（`core/src/config/index.ts:212-216` 仅告警）即得到"文档说有防护、实际裸奔"的服务。
4. **能力数量≠能力广度：成片"名义可写、实际只读"与"死代码写函数"**（`PM-04`，P0）：派发严格按注册 `fn` 发送（`ps-bridge.ts:347`），`system.env.manage` 描述"读取或设置"（`definitions.ts:121`）却只绑 `Get-EnvironmentVariableInfo`，已实现的 `Set-EnvironmentVariableInfo`（`system.ps1:398`）**无人调用**；同族死代码：`Expand-ZipArchiveItem`（宣称"压缩解压"实际不可解压）、`New-ShortcutItem`、`Set-ClipboardTextValue`（"剪贴板读写"入参给了 `text` 却只会返回读结果——比不给参数更误导）。文档标 L2 可写、实现 L0 只读又一族：`system.task.scheduled`/`network.config`/`user.manage`/`app.appx.manage`/`storage.recycle.manage`/`storage.dir.manage`。**用户按文档发起"设环境变量/写剪贴板/解压/清空回收站/建计划任务"类需求会被静默缩水成只读动作——做了近似动作而非诚实失败。**
5. **需求文档与治理索引互相矛盾，用户入口文档系统性过时**（`PM-22`/`PM-13`/`PM-21`，P1+P2）：`USER-MANUAL.md` 仍写"5 个 Skill"（实际 7）、`tasks/send`/`tasks/resubscribe`（实现是 `message/send` + `approval.reply`，见 `a2a-framework/src/server.ts:196-206`）、`cli.js --audit tail|verify`（`vm-service/src/cli.ts` 无该参数）、手工 `ssh -f -N -L`（与 `skills/winvm-orchestrator/SKILL.md:92` 明确禁止直接冲突）；`.dev/changing-log.md:4-9` 的 6 项"待在真实环境终验"与 `README.md:305`"已闭环"直接矛盾。首次上手的非工程用户按用户手册操作会在第一步就撞墙。

**严重度计数：P0 = 4，P1 = 9，P2 = 9（共 22 条）**

---

## 1. 需求完整性矩阵（FR/NFR → 落地证据 → 状态）

状态图例：✅ 已落地（有实现证据，多数另有真机报告）｜🟡 部分（实现存在但覆盖/语义有缺口）｜❌ 缺失（无实现落点）

### 1.1 功能需求 FR

| ID | 需求 | 落地证据（文件:行） | 状态 | 缺口说明 |
|---|---|---|---|---|
| FR-101 | MCP 主干通道 | `/mcp` 路由 `vm-service/src/server.ts:1081`；`McpServer` 装配 `server.ts:57,349`；真机 K5 端到端 `docs/test/reports/real-test-2026-09-29-k5-e2e.md` | ✅ | — |
| FR-102 | A2A 委派通道 | `/a2a` + agent-card 路由 `server.ts:1076,1133`；方法集 `a2a-framework/src/server.ts:196-206`（`message/send`/`tasks/get`/`tasks/list`/`tasks/cancel`/`message/stream`）；宿主桥 `host-a2a-bridge` | ✅ | 宿主侧以轮询为主，流式未见消费（见 PM-20） |
| FR-103 | 两通道共享同一注册表与策略引擎 | `server.ts:349`（`registry.registerAll(WINDOWS_CAPABILITIES)`）、`server.ts:464`（`intersectDeclared`）；`CAPABILITY-MODEL.md:16` | ✅ | — |
| FR-104 | 传输可插拔（SSH/HTTP/stdio） | `core/src/transport/{ssh-tunnel,ssh-tunnel-ssh2,http-channel,stdio-channel}.ts`；契约 `contracts/src/transport.ts:36` | ✅ | HTTP 模式安全强度不达 NFR-510 声明（PM-02） |
| FR-105 | A2A 流式（SSE）进度回传 | `a2a-framework/src/server.ts:206`（`message/stream`）；`http-channel.ts` 含 `text/event-stream` | 🟡 | 宿主旅程实际走 `task.get` 轮询（`skills/winvm-orchestrator/SKILL.md:283`；`README.md:259` 步骤 3），SSE 无宿主侧消费证据 |
| FR-201 | 系统管理域覆盖 | `definitions.ts:109-124`（14 条） | 🟡 | **缺** Windows 更新管理（文档列 `system.update.manage` 无实现，`CAPABILITY-MODEL.md:56`）；计划任务只读、网络只读、用户只读（PM-04）；无防火墙/服务依赖/多显示器 |
| FR-202 | 应用管理域覆盖 | `definitions.ts:128-277`（8 条） | 🟡 | **缺** `app.process.activate`、`app.default.manage`（文档 `CAPABILITY-MODEL.md:91,93` 列出但无注册）；UWP 仅查询（`app.appx.manage` L0，无安装/移除，尽管 CAPABILITY-MODEL:94 称 L2）；无应用进程守护 |
| FR-203 | 存储管理域覆盖 | `definitions.ts:281-295`（13 条） | 🟡 | **缺** 配额（`README.md:42`/`REQUIREMENTS.md:37` 明确列"配额"）；解压函数未注册；回收站清空未注册；L3 分区/格式化按红线不注册（`CAPABILITY-MODEL.md:144`）与文档一致 ✅ |
| FR-204 | GUI 与桌面自动化 | `definitions.ts:299-311`（11 条） | 🟡 | **缺** 浏览器自动化（`gui.browser.control` 全仓无实现；Skill 文案 `winvm-gui-automation/SKILL.md:111-114`、`winvm-app-operation/SKILL.md:120` 仍在教用户调用）；剪贴板仅文本、截图仅主屏（PM-10）；窗口"移动/改尺寸/置顶"文档声明无对应枚举（`CAPABILITY-MODEL.md:154` vs `definitions.ts:304`） |
| FR-205 | 审计与回溯 | 哈希链 `core/src/audit/chain.ts:311`（`verifyChain`）、健康透出 `server.ts:1268,1336-1341`、策略硬拒落链（S-4，`changing-log.md:47`） | 🟡 | "关键 GUI 操作前后截图入档"未实现（快照零消费，PM-01）；用户可用的审计查询入口缺失（PM-06） |
| FR-206 | 能力可扩展（注册即出现） | `definitions.ts:1-6` 注释 + `server.ts:349` 自动注册；`install-vm --self-test` 报 54 项能力（`project-dev-status.md:60`） | ✅ | 反向缺口：**已有 ps1 函数未注册**（PM-04），说明"实现→注册"这一步缺少一致性门禁 |
| FR-301 | `winvm-orchestrator` 总控 | `skills/winvm-orchestrator/SKILL.md`（477 行；强制门禁 31-46、前置检查 84-120、审批闸协议 256-335） | ✅ | 域外扩展策略过宽（PM-12） |
| FR-302~305 | system/app/storage/gui 四领域 Skill | `skills/winvm-{system-admin,app-manager,storage-manager,gui-automation}/SKILL.md` | 🟡 | 内容存在，但多处教用户调用不存在能力（PM-03/PM-04 的下游污染） |
| FR-306 | `winvm-app-operation` | `skills/winvm-app-operation/SKILL.md`（225 行） | 🟡 | 同上；§"浏览器（网页端生产）"（120-122）整节依赖不存在的 `gui.browser.control` |
| FR-301+（超范围） | 第 7 个 Skill `winvm-mcp-reference` | `skills/winvm-mcp-reference/SKILL.md`（215 行） | ✅ | 需求文档（`REQUIREMENTS.md:42,108`）未登记，属**需求文档落后于实现**（PM-13） |
| FR-401 | VM 内 Agent 可替换 | 三 adapter 包 + `agent.provider` 总开关（`README.md:69-73`）+ 动态加载 `core/src/bridge/loader.ts`；hermes 经 `adapter-agent-hermes/src/mcp-registrar.ts:67` 预注册 | ✅ | 三选项均实现；真机覆盖见 `docs/test/reports/a2a-coverage-2026-10-03.md` |
| FR-402 | 宿主可适配 | `packages/host-sdk/src/{index,patch,skill-loader}.ts` 中性模型 + `adapter-host-workbuddy/src/index.ts:233-257` 渲染 | ✅ | 无第二宿主实证（合理，V1 范围外 `REQUIREMENTS.md:113`） |
| FR-403 | 分层边界强制（依赖检查脚本可检出反向依赖并失败） | `package.json:16` `"layout": "node scripts/dep-lint.mjs"` | ❌ | **`scripts/dep-lint.mjs` 不存在**（`find . -name "*dep-lint*"` 空；`git ls-files` 无 `scripts/`）——验收标准"检查脚本可检出并失败"不成立，`README.md:143` 却宣称"由 `scripts/dep-lint.mjs` 在本地把关" |
| FR-404 | Skills 与宿主解耦 | `host-sdk/skill-loader.ts` 读源 + `adapter-host-workbuddy` 渲染为 WB 原生格式 | ✅ | — |

### 1.2 非功能需求 NFR

| ID | 需求 | 落地证据 | 状态 | 缺口 |
|---|---|---|---|---|
| NFR-501 | 标准化最高（MCP + A2A v1.0、agent-card、禁旧方法名） | `server.ts:1076`（`/.well-known/agent-card.json`）、`a2a-framework/src/server.ts:187`（`tasks/send` 明确拒绝并提示迁移） | ✅ | — |
| NFR-502 | 会话保活/断线重连/超时可控/黑屏检出 | `definitions.ts:300`（`Get-SessionHealth`）、`psmod/gui.ps1`（`Test-ScreenBlack`）、`transport/ssh-tunnel-ssh2.ts:151,382-393`（持续重连）、`PsBridgeSessionProbe`（`server.ts:58`） | 🟡 | **检出 ≠ 恢复**：锁屏/会话挂起无自动恢复路径，Skill 只能"告知用户"（`winvm-orchestrator/SKILL.md:97-99`）；真机 GUI 点击回归仍受限（`README.md:307`、`changing-log.md:49`） |
| NFR-503 | ps-bridge 常驻，热路径 P95 < 300ms | `vm-capabilities/src/ps-bridge.ts`、`README.md:153` | 🟡 | 实现 ✅；**P95 < 300ms 无可复核的量化证据**（无基准脚本/报告，属文档自述）——标注「假设：量级成立，缺测证」 |
| NFR-504 | L0–L3 风险分级 + 未声明按 L3 | `definitions.ts:7-124` 每条 cap 均带 `risk`；`contracts/src/risk.ts` 类型封闭 | ✅ | — |
| NFR-505 | 策略引擎（命令白/黑、路径白/黑、**进程白名单、网络端点限制**） | `policy/engine.ts:402-502`（命令/路径/注册表/进程 deny）；默认表 `policy/defaults.ts:36-59` | 🟡 | **网络端点限制未生效**：`defaults.ts:30,143-146` 有 `endpointAllowlist` 配置位，但 `engine.ts` 全篇无 `endpoint` 判定（grep 0 命中）⇒ 死配置 |
| NFR-506 | L2/L3 人工审批 + 按能力免审 | `contracts/src/capability.ts:52,109`（`requiresApproval` 覆盖 risk 默认）+ K3/K4/K5/A5/K3R 链路与真机（`README.md:275`） | ✅ | — |
| NFR-507 | 防篡改哈希链，篡改即校验失败 | `audit/chain.ts:311`；`server.ts:1268` 健康校验；S-4 补 `POLICY_DENIED` 落链（`changing-log.md:47`） | ✅ | 用户侧"事后自查"无入口（PM-06） |
| NFR-508 | 宿主侧 `disabledTools` 静态禁用建议 | `delivery/install-host.mjs:752`（`disabledTools: highRiskTools()`）；A2A 桥连接器为 `[]`（`:965`） | ✅ | — |
| NFR-509 | traceId 全链路 + **关键操作 before/after 快照 artifact** | traceId 贯通（`server.ts`/`a2a-framework/src/{client,server}.ts`/`contracts/src/audit.ts`）✅ | 🟡 | 快照部分零实现（PM-01）——本条 NFR 只兑现一半 |
| NFR-510 | 仅监听 127.0.0.1；**HTTP 模式强制 TLS + bearer + Origin** | 回环强制 `config/index.ts:205-211` ✅ | ❌ 部分 | TLS/Origin/服务端 bearer 校验全部缺失（PM-02） |
| NFR-511 | SSH 密钥默认鉴权；HTTP bearer + 可选 mTLS；`A2A-Version` 协商 | 版本协商 `server.ts:1137-1146` ✅；`A2A_VERSION_HEADER` `contracts/src/a2a.ts:13` | 🟡 | mTLS/TLS 无实现（同 PM-02） |
| NFR-512 | **全部契约以 JSON Schema 集中存放 + 契约校验纳入 CI** | `packages/contracts/schemas/` 仅 `capability.schema.json` 一个文件；TS 类型（`contracts/src/*.ts` 8 文件）承担其余契约 | ❌ | 无 CI（`git ls-files` 无 workflows/CI 配置）；"全部契约 JSON Schema 化"仅覆盖 capability 一类（PM-08） |
| NFR-513 | 核心模块单测，见 `TEST-PLAN.md` | 59 文件 1054/1054（`README.md:275`、`project-dev-status.md:38`） | 🟡 | **`TEST-PLAN.md` 全仓不存在**（`git grep -l TEST-PLAN` 仅命中 `REQUIREMENTS.md:82`）⇒ 追溯引用悬空（PM-16） |

**矩阵小结**：20 条 FR → ✅ 11 / 🟡 8 / ❌ 1；13 条 NFR → ✅ 6 / 🟡 4 / ❌ 3。缺口高度集中在两类：① **能力域广度与"文档→实现"一致性**（FR-201~205、FR-206 反向）；② **监管可观测面的最后一公里**（快照、审计查询、非回环安全、CI/门禁脚本）。

---

## 2. 能力覆盖评估（五域逐项）

**总盘**：注册表实测 **54 条能力**（`git grep -c "id: '" definitions.ts = 54`），分布 meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5。风险分布：L0 27 / L1 19 / L2 7 / L3 1。

**结论前置**：五域是**"以只读查询为代表的代表性能力集"，不是完整集**。L0 只读能力占一半（27/54），真实写操作面只有 8 条（L2 7 + L3 1）。这与 `README.md:300` 的自我表述（"当前为代表性能力集（每域 5–8 个工具）"）一致——**但 README 同一句里的"每域 5–8 个工具"与各域实际（3/14/8/13/11/5）也对不上**（见 PM-14）。核心产品问题不是"广度不够"，而是**文档/Skill 向用户承诺的写操作显著多于实际可执行的写操作**（§1 已量化，本节落到场景）。

### 2.1 `system`（14 条）—— 系统管理

| 评估项 | 结论 |
|---|---|
| 覆盖良好的 | 只读体检面（info/service.list/process.list/task.scheduled/registry.read/network.config/user.manage/eventlog.query 共 8 条 L0）；服务生命周期（L1 control + L2 configure）；电源（L3 + dryRun 前置 `definitions.ts:123`） |
| 名义/实际背离 | `system.env.manage` 描述"读取**或设置**"（`definitions.ts:121`），实现绑 `Get-EnvironmentVariableInfo`（`system.ps1:374`），写函数 `Set-EnvironmentVariableInfo`（`system.ps1:398`）**零调用**；`system.network.config`/`system.user.manage` 在文档标 L2 可配置（`CAPABILITY-MODEL.md:51-52`），注册表实为 L0 只读查询（`definitions.ts:119-120`）；`system.task.scheduled` 文档"L2 增删改查"（`CAPABILITY-MODEL.md:48`），实现只有 `Get-ScheduledTaskInfo`（`definitions.ts:116`），`system.ps1` 无 `Register/Set/Unregister-ScheduledTask`（grep 0 命中） |
| 明确缺失的高频场景 | ① **Windows 更新管理**（FR-201 明列"更新"、`CAPABILITY-MODEL.md:56` 有 `system.update.manage` L2 条目，全仓无实现）——VM 运维最高频动作之一；② **计划任务写侧**（注册/修改/删除，含"定时任务"这一 Windows 特有刚需）；③ **防火墙规则**（`git grep -i firewall -- packages delivery` 仅命中文档/安装提示，无能力；`docs/INSTALL-GUIDE.md:70` §1.2 反而让用户手工改防火墙）；④ **本地用户/组的写侧**（改密、启停账户、组成员管理，`system.ps1` 无 `LocalGroup` 引用）；⑤ **服务依赖编排**（`DependentServices` 全仓 0 命中：停 A 服务前无法评估依赖 B/C 的连带影响，审批卡拿不到真实影响面）；⑥ **网络写侧**（改 IP/DNS/路由、网卡启停）；⑦ **注册表键/项级删除与导入导出**（现仅 value 读写） |
| 产品判断 | 只读体检面已足够支撑"巡检/排障"类诉求；**变更面偏薄**。优先级按场景频次：更新管理 > 计划任务写 > 防火墙 > 服务依赖影响分析 > 用户/组写 |

### 2.2 `app`（8 条）—— 应用管理

| 评估项 | 结论 |
|---|---|
| 覆盖良好 | winget 全生命周期（search/install/uninstall/upgrade）+ 卸载**事后核验状态机**（R17/K6：`verified/fallbackUsed/residualEvidence/plan`，`definitions.ts:181-268`）+ NSIS `/S` 回退 + dryRun 宿主侧纯查询预览（K-N2）。这是五域中打磨最细、有真机铁证的一条链（`docs/test/reports/real-test-2026-09-30-r19.md`、`r19b-s1-kn2` 系列测试） |
| 名义/实际背离 | ① `app.appx.manage` 文档标 L2 "UWP 包安装/移除"（`CAPABILITY-MODEL.md:94`），实现是 L0 `Get-AppxPackageInfo`（`definitions.ts:276`）；② `app.shortcut.manage` 描述"读取或创建"、`fn` 只绑 `Get-ShortcutInfo`（`definitions.ts:275`），已实现的 `New-ShortcutItem`（`app.ps1` 函数清单）未注册——**又是一处"实现已完成、注册漏一步"**；③ FR-202 明列"启动与**激活**"“**默认程序**”"应用进程守护"，对应 `app.process.activate`/`app.default.manage`/守护能力全部无实现（`CAPABILITY-MODEL.md:91,93` 列条目、全仓 0 命中） |
| 明确缺失的高频场景 | 应用窗口激活（与 `gui.window.control activate` 部分可替代，但文档把它列为 app 域能力，用户在 app-manager Skill 里找不到）；默认程序/文件关联（生产场景"用 X 打开 .psd"的前提）；MSI/EXE 直装（现仅 winget 一条路）；Store 应用；**winget source 管理**（升级全部前先要 source 可用，失败时无诊断入口）；卸载残留清理（FR-303 声称 Skill 覆盖"卸载残留清理"，能力层无对应动作，只有 `residualEvidence` 证据） |
| 产品判断 | 卸载链是本项目最成熟的"深做"样板（核验 + 回退 + 预览 + 契约三方一致），应作为**其余域的写侧质量标杆**；但 app 域"管理"面里"激活/默认程序/守护"三项是承诺未兑现，需要么补实现要么从文档降级为 roadmap |

### 2.3 `storage`（13 条）—— 存储管理

| 评估项 | 结论 |
|---|---|
| 覆盖良好 | 文件 CRUD 全套 + 搜索（名/内容）+ 目录体积 Top-N + 磁盘卷 + 清理建议（只分析不执行，安全默认正确）；删除"进回收站优先"（`storage.ps1:188-190`），与文档红线一致 |
| 名义/实际背离 | ① **解压**：`Expand-ZipArchiveItem` 已实现（`storage.ps1:263`）但 `storage.archive.manage` 只绑 `New-ZipArchiveItem`（`definitions.ts:291`）——文档承诺"压缩**解压**"（`REQUIREMENTS.md:37`）实际只可压缩；② **回收站清空**：文档 L2"查看与清空"（`CAPABILITY-MODEL.md:141`），实现 L0 只列（`definitions.ts:293`，`storage.ps1:281-317` 无 Clear）；③ **目录删除**：文档 `storage.dir.manage` "L2（删）/L1（建）"（`CAPABILITY-MODEL.md:137`），实现只有 `New-DirectoryItem`（L1 建）（`definitions.ts:289`）；④ **配额**：FR-203/README:42/USER-MANUAL:16 三处宣称，`CAPABILITY-MODEL.md:128-142` 清单里**根本没有配额条目**，无实现——文档间自相矛盾 |
| 明确缺失的高频场景 | 二进制/大文件写入（`Write-TextFileContent` 仅 UTF-8 文本，`storage.ps1:152-155`；读支持 base64 写不支持 ⇒ 无法把宿主素材送进 VM）；符号链接/硬链接的删除与查询；文件哈希/去重（USER-MANUAL:16 宣称"去重"）；ACL/权限（`storage.ps1` 无 AccessControl 引用）；卷标/挂载点管理；磁盘健康（SMART） |
| 产品判断 | 文本工作流够用；**"把图片/视频素材送进 VM 开工"这条生产前置路径缺失**（见 PM-11），直接削弱 appops 域的可用性；写侧语义应优先补齐（解压、回收站清空、目录删除——三者的实现或近似实现已在 ps1 里，成本极低） |

### 2.4 `gui`（11 条）—— GUI 自动化

| 评估项 | 结论 |
|---|---|
| 覆盖良好 | 截图（全屏/窗口/区域）+ 黑屏检测（熵判定，"检出即告警"语义）+ 窗口枚举/五态控制 + 键鼠（SendInput）+ UIA 树/元素四操作 + 剪贴板 + **等待条件**（`windowExists/windowGone/processExited/screenStable`，`definitions.ts:310`）——作为"看屏-定位-动作-验证"闭环的原语集是齐的 |
| 名义/实际背离 | ① **`gui.browser.control` 整条不存在**（`CAPABILITY-MODEL.md:161` 声称 CDP over WebSocket，`git grep -i "devtools|CDP|browser" -- packages` 只命中无关注释；`psmod/gui.ps1` 无任何浏览器代码）——这是 FR-204 明列、场景 C/E 的主力；② `CAPABILITY-MODEL.md:153-154` 声称窗口能力含"置顶/移动/改尺寸"，注册表 `state` 枚举只有 `minimize/maximize/restore/close/activate`（`definitions.ts:304`），输入 schema 无坐标/尺寸参数；③ `CAPABILITY-MODEL.md:160` 声称等待条件含"元素存在"，`definitions.ts:310` 枚举无该条件 |
| 明确缺失的高频场景 | 多显示器/DPI 感知（截图三次取 `Screen.PrimaryScreen.Bounds`，`gui.ps1:100,169,520`，无 `AllScreens`/DPI 缩放处理 ⇒ 多屏 VM 上"窗口/区域截图"只能拍到主屏）；剪贴板**图片/文件**格式（`gui.ps1:478-486`——且**文本写入本身也不可达**：注册 `fn` 绑 `Get-ClipboardText`（`definitions.ts:309`），`Set-ClipboardTextValue` 无调用点，见 PM-04）；剪贴板历史；锁屏解锁与会话恢复动作（只有 `Get-SessionHealth` 检出，无"恢复"操作面，与 NFR-502"自动检测**并恢复**"差半句）；图像匹配等待（找图）；滚动/拖拽之外的组合手势 |
| 产品判断 | 原语层完整、可用；**浏览器自动化是全项目最大单点缺口**（连带 appops 网页生产、场景 C/E）；会话"检出→恢复"的自动化是可靠性叙事的关键补口 |

### 2.5 `appops`（5 条）—— 应用生产操作

| 评估项 | 结论 |
|---|---|
| 覆盖良好 | 状态查询（含非生产窗口过滤审计透出 `filteredCount/policy`，`definitions.ts:335-342`）/ CLI 调度 / 工作流 / COM 自动化 / GUI 多步生产，五条与设计一致；`steps` 原语集（click/type/menu/waitWindow/waitStable/hotkey/screenshot，`definitions.ts:428`）自洽；产物目录白名单约束 + 源产分离 |
| 前提缺口（本域最特殊的问题类型） | 本域大量依赖**外部预置**且缺引导：① `appops.workflow.run` 只查 `%USERPROFILE%\WinVMWorkspace\workflows` 与 `C:\WinVMWorkspace\workflows`（`appops.ps1:365-377`），**全仓一个示例工作流都没有**（`git ls-files | grep workflow` 空），确定性 provider 默认路由到此（`adapter-agent-workbuddy/src/index.ts:508`）⇒ 默认 provider + 默认 VM 镜像 = 必返 `WORKFLOW_NOT_FOUND`（`:384`）；`SCENARIOS.md:85` 的 `word_batch_pdf`、`:211` 的 `generic_production` 均无落盘实体；② CLI 调度假定 `ffmpeg/magick/soffice/pandoc` 已在 VM 内（`definitions.ts:353` 枚举），**无预检、无自动安装引导**（app 域 winget 可作补救路径但 Skill 未串起来）；③ 开放生产意图需切 LLM provider，"怎么切"只有 `agent.provider` 一行配置事实，缺用户侧操作路径文档（`REQUIREMENTS.md:147` Q-1 默认值与 README:70"默认确定性"共同决定了：D 类场景默认不可用） |
| 依赖缺口 | `appops.gui.produce` 依赖浏览器能力做"网页端生产"（`winvm-app-operation/SKILL.md:120` 明确让用户"优先 `gui.browser.control`"）——上游缺失导致本节指引失效 |
| 产品判断 | 本域是**项目差异化价值最高的域**（"用 Windows 软件生产"），但它的可用性瓶颈不在能力条数，而在**交付配套**：预置工作流包、CLI 预检、LLM provider 切换指引、素材传输通道。这四项都是低成本高价值的 P1 需求 |

### 2.6 跨域横向问题

- **"每域 5–8 个工具"口径失真**（`README.md:300`、`changing-log.md:12`）：实际 system 14 / storage 13 / gui 11。口径用于决策"要不要扩能力"，失真会误导优先级判断（PM-14）。
- **能力数量增长 ≠ 场景覆盖增长**：本次审计发现的最大缺口是"文档承诺写操作 vs 实现只读"，属**双向不同步**问题：正向（文档写了没实现，7 条）+ 反向（实现了没注册，至少 5 条：`Set-EnvironmentVariableInfo`、`Expand-ZipArchiveItem`、`New-ShortcutItem` 已证实；`Get-AppxPackageInfo` 写侧、`New-LinkItem` 删侧部分推断）。**需求池里应有"文档/注册表/ps1 三方一致性门禁"这类工程需求，而不只是加能力**（PM-04 的根治方向）。
- **无 `meta.audit.query` / `meta.policy.describe` 使监管叙事对最终用户不可达**：策略判定结果、审计链完整性只能经 `/health` 的 `chainValid` 侧漏（`server.ts:1336-1341`），是"监管能力存在但用户用不上"的典型（PM-06）。

**每域"代表性 vs 完整"定性结论**：

| 域 | 能力数（实测） | 定性 | 一句话判断 |
|---|---|---|---|
| system | 14 | 代表性（只读侧厚、写侧薄） | 巡检诊断够用；"装更新/改任务/开防火墙"全做不了——恰是运维日常前 3 高频 |
| app | 8 | 卸载链深、管理面窄 | 卸载核验状态机是全项目质量标杆；"激活窗口/默认程序/守护"三个承诺 0 实现 |
| storage | 13 | 文本文件够用、素材通道缺失 | 解压/清回收站/删目录都有文档无落点；无法向 VM 送二进制素材 |
| gui | 11 | 原语齐、编排缺 | 截图/UIA/等待闭环原语全；浏览器整条不存在、多屏/DPI 未考虑、会话"检出≠恢复" |
| appops | 5 | 设计最完整、配套最不落地 | 5 条能力定义全部存在，但预置工作流=0、CLI 预检=0、素材输入通道=0 ⇒ 默认配置下开箱即 `WORKFLOW_NOT_FOUND` |

---

## 3. 用户旅程断点

以"鸿蒙宿主 WorkBuddy + 一台 Windows VM"真实使用路径为轴（首次上手 → 日常使用 → 审批交互 → 异常恢复）。文档分工：安装=`docs/INSTALL-GUIDE.md`/`DEPLOYMENT.md`，日常=`USER-MANUAL.md`+7 Skills，审批=`winvm-orchestrator/SKILL.md:253-336`+`approval-card.md`，异常=各 Skill 错误码表。

### 3.1 首次上手（部署 → 第一次成功调用）

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| J1 | **用户手册整体停留在早期版本**：仍称"5 个 Skill"（实际 7，`USER-MANUAL.md:9` vs `README.md:6`）、A2A 方法名是旧的 `tasks/send`/`tasks/resubscribe`（`USER-MANUAL.md:42,56`；实现端 `tasks/send` 已被显式拒绝，`a2a-framework/src/server.ts:187`；全仓无 `resubscribe`——git grep 0 命中，实际续跑是 `a2a.approval.reply`，`host-a2a-bridge/src/tools.ts:212,563`）、审计命令 `cli.js --audit tail|verify` 不存在（`USER-MANUAL.md:68,71` vs `vm-service/src/cli.ts:39-73` 仅 `--config/--port/--host/--self-test/--help`）、故障自愈首选手工 `ssh -f -N -L`（`USER-MANUAL.md:81`）与总控 Skill"隧道由常驻 tunnel-daemon 承载、**无需/不得**手工建立"（`winvm-orchestrator/SKILL.md:92-93`）直接矛盾 | USER-MANUAL 是**非工程用户唯一入口文档**，四条硬伤全在第一条旅程上；用户照做会：找不到 2 个 skill → 审批续跑失败 → 审计自查失败 → 手工建隧道撞端口失败 |
| J2 | 首次"高危操作"必撞静态禁用墙，且**无解锁路径**：安装器把所有 L2/L3 写入 `disabledTools`（`install-host.mjs:191-192,752`），用户手册 Q2 说"需在安装器配置里显式解除，详见 DEPLOYMENT.md §4.1"（`USER-MANUAL.md:84`），但 DEPLOYMENT §4.1（`:200-229`）只有安装命令罗列，**通篇没有解禁操作步骤**（grep"解除"仅命中 `:228` 的半句话；`install-host.mjs` 也无 `--enable` 类参数） | 首次试用"删个文件/卸个应用"直接报"已禁用"，文档承诺的流程无处可寻 → 首日流失点 |
| J3 | **默认通道模式与文档宣称的行为不一致**：安装不写 `tunnelMode`（`writeVmConnConfig` 无该字段，`install-host.mjs:1332-1346`；`grep tunnelMode install-host.mjs` 0 命中），默认恒为 `mcp`（`core/src/constants.ts:269`）；但 README 示例宣称"批量转 webp → A2A 委派长任务流式回传"（`README.md:257-258`）、USER-MANUAL 宣称"总控会根据任务**自动选通道**"（`USER-MANUAL.md:28`）。实际 `mcp` 模式下"即使任务复杂也一律 MCP 直调，不委派 A2A"（`winvm-orchestrator/SKILL.md:151`） | 用户按 README 下达委派类任务，得到的是宿主多轮直调而非 A2A 任务流，与预期体验不符；且"如何切到 intelligent/a2a"只存在于 Skill 内文（`:156-158`），任何用户侧文档都没提 |
| J4 | appops 开箱即败：默认 provider=deterministic + `workflow.run` 要求预置脚本（`appops.ps1:365-384`），仓库不含任何示例工作流、安装器也不初始化 `workflows/` 目录 | "在 VM 里跑个生产任务"首次尝试返回 `WORKFLOW_NOT_FOUND`（错误消息有引导，`:384` 算部分缓解，但仍需用户手工造脚本） |

### 3.2 日常使用

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| J5 | **Skill 教用户调用不存在的能力**（最伤信任）：`winvm-gui-automation/SKILL.md:111-114` 整节"浏览器自动化"、`winvm-app-operation/SKILL.md:120-122`"优先 gui.browser.control"指向的能力在注册表不存在（PM-03）。宿主 Agent 按 Skill 指引找不到工具 → 触发"工具缺失"分支 → 甚至可能手写脚本绕行（正是 `winvm-orchestrator/SKILL.md:41-45` 严令禁止的） | Skill 是 agent 的行为契约；契约里 1/6 的 GUI 场景不可执行 |
| J6 | 文档标 L2 可写、实现 L0 只读的"静默缩水"（见 §2 各表）：用户说"把回收站清空"得到的是回收站**列表**；说"设个环境变量"得到的是**读取**结果。无错误、无提示、无"该写操作未注册"的拒绝码——**做了个近似动作而不是诚实失败** | 比报错更糟：用户以为完成。产品信任损耗最大的模式 |
| J7 | 多屏/高 DPI VM：截图恒取 `PrimaryScreen.Bounds`（`gui.ps1:100,169,520`），无 `AllScreens` 枚举 → 副屏内容永远拍不到、坐标点击跨屏失效（「假设：VM 实际多屏配置存在；至少单屏 VM 无影响」） | GUI 域在生产 VM 形态（常多屏/远程控制台）下的正确性风险 |

### 3.3 审批交互

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| J8 | 审批卡依赖宿主 `show_widget`+`AskUserQuestion` 双原语，缺一降级为纯文本（`winvm-orchestrator/SKILL.md:316-317`、`r17-design.md` 选型表）——降级设计是对的；但**审批中无任何倒计时/时效提示**：TTL 超时会按拒绝收口并写日志（`server.ts:533-548`，`WINVM_APPROVAL_TTL_MS`），用户回到会话只看到"任务失败/拒绝"，不知道"曾有 N 分钟窗口已过"。审批卡七槽位（`approval-card.md:37`）不含"有效期"字段 | 用户"睡一觉起来任务被拒"却无从归因；重试又再次挂起 → 审批死循环体验 |
| J9 | **审批时的可逆性承诺与实现脱节**：卡片含"可逆性"槽位 + 高危清单要求 L2/L3"审批 + before/after 快照"（`winvm-orchestrator/SKILL.md:347-352`），但快照零消费（PM-01）→ 卡片上"有前后快照可回看"是空头承诺；仅 `app.winget.uninstall` 有真实的 before 预捕获（`app.ps1:665 Get-UninstallPrecapture`，`r17-design` T02b"预捕获时序"） | "最可监管"卖点在审批环节的用户感知被架空 |
| J10 | 批准后到结果回传的链路已扎实（K5 重放 + `-replay` 审计，真机 `real-test-2026-09-29-k5-e2e.md`），但**拒绝路径的用户话术缺失**：拒绝后任务终止（`winvm-orchestrator/SKILL.md:300-303`），无"哪些前置步骤已执行、是否需回滚"的汇总输出——L2 任务多为多步，前 N-1 步 L1 变更已落 VM，用户拒绝最后一步后 VM 处于**半改状态**而不自知 | 审批语义"全任务"与执行语义"分步"错位 |

### 3.4 异常恢复

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| J11 | 会话异常的"最后一公里"靠人：`ARCHITECTURE.md:270-282` 宣称 session-guard 六机制（tscon 归还控制台/自动登录/禁休眠/降级模式），实测 `packages/core/src/session/health.ts`（全文 118 行）只有探针与 `guiAllowed/nonGuiAllowed` 门（`:41-45`）；**全仓无 `tscon` 实现**（git grep 仅命中 docs）；自动登录/禁休眠只在安装文档 §1.5"关闭 VM 睡眠"（`INSTALL-GUIDE.md:100`）让用户手工做。降级模式（无会话时仅 L0/L1）有代码钩子 ✅（`adapter-agent-workbuddy/src/index.ts:276`） | RDP 断连/锁屏后 GUI 域不可用，恢复全靠用户远程操作 VM 控制台——对"鸿蒙宿主+远程 VM"形态是高频事件（`SCENARIOS.md` 场景 C/D 都会踩） |
| J12 | 错误指引总体优秀（错误码分层 `winvm-orchestrator/SKILL.md:343-346`、有界重试规则 `:100-112`、隧道三级复用/守护/回落 `README.md:222-223`），但**审计日志自查无入口**（PM-06）：出问题后监管方/用户想"回看这台 VM 最近被做了什么"，只有两条路——SSH 进 VM 看 `%LOCALAPPDATA%\WinVMBridge\audit\*.jsonl`（README:249 给路径），或读 `/health.chain`（只给 valid/brokenAt 不给内容）。`meta.audit.query` 文档有（`CAPABILITY-MODEL.md:223`）实现无 | "可审计"价值主张缺一个用户可用的查询面；QA/合规复核成本高 |
| J13 | 桥崩溃自愈良好（`PROVIDER_UNAVAILABLE` 有界重试，`winvm-orchestrator/SKILL.md:101-108`）；隧道 UID 生命周期约束（鸿蒙杀 WorkBuddy 连带杀隧道，`README.md:247`）文档已诚实披露 ✅，但**隧道死后的第一故障表象是"工具调用超时"**，用户手册把该场景引向手工 ssh 命令（J1 复叠），正确动作应是 `winvm-plugin tunnel ensure`——这条自救路径在 USER-MANUAL 全文 0 命中 | 最常见异常（隧道断）的第一响应指引是错的 |

**旅程小结**：首次上手 4 断点（J1-J4，其中 J1/J2 为高危流失点）；日常使用 3（J5-J7）；审批 3（J8-J10）；异常恢复 3（J11-J13）。异常恢复面的"有界重试/错误码分层/诚实披露"是同类插件里做得最好的部分；最大的体验洼地是**入口文档失真（J1）+ 解禁无路径（J2）+ 静默缩水（J6）**。

---

## 4. 问题清单

严重度定义（产品口径）：**P0** = 承诺能力实际不可用/安全叙事落空/首日流失，直接损害核心卖点；**P1** = 显著功能缺口或体验断裂，需变通才能用；**P2** = 口径失真/工程债/低风险改进。

| 编号 | 严重度 | 现象 | 证据（文件:行） | 影响 | 建议 |
|---|---|---|---|---|---|
| PM-01 | **P0** | before/after 快照全链路**只声明、零执行**：26 条能力声明 `snapshot:'after'/'before-after'`（after 20 条 + before-after 6 条），但全仓无任何运行期消费点 | `definitions.ts:61`（写入 `audit.snapshot`）；`contracts/src/capability.ts:40,58`（类型）；`grep -rn "audit.snapshot" packages/*/src` 除契约/注册表外 **0 消费命中**；承诺见 `REQUIREMENTS.md:78`（NFR-509）、`SECURITY-GOVERNANCE.md:88,245`、`README.md:259`、`SCENARIOS.md:264-265` | "最可监管"三支柱之一落空；审批卡"可逆性/快照回看"是空头话术（J9）；高危事故无法向用户/合规方举证 | 立项最小实现：MCP/A2A 执行器在 L2/L3 调用前后按 `audit.snapshot` 自动触发 `gui.screen.capture`+关键状态采集，产物入审计 `artifacts`（`SECURITY-GOVERNANCE.md:136` 已设计 `artifacts:[sha256…]`）；卸载域已有 `Get-UninstallPrecapture`（`app.ps1:665`）可作样板推广 |
| PM-02 | **P0** | HTTP 直连模式安全声明与实现不符：NFR-510 称"Streamable HTTP 模式**强制 TLS + bearer token + Origin 校验**"，实测服务端为明文 `node:http`、无 Origin 校验、bearer 仅**客户端**注入、服务端零校验 | `server.ts:13`（`node:http`）`:1059`（`createServer`）；全仓无 `https.createServer`（git grep 0 命中）；客户端侧 `transport/index.ts:76-80`、`adapter-host-workbuddy/src/index.ts:129`；非回环仅**告警**（`config/index.ts:212-216`）；Origin 承诺另见 `SECURITY-GOVERNANCE.md:21,38`（该文档 `:222-224` 已诚实限定"bearer 仅非回环强制、回环免校验"——与 REQUIREMENTS:79 的"强制"口径互相矛盾） | 回环+隧道部署无实际暴露（默认安全✅），但文档口径会让运维在"改 bind 走 HTTP"时误信有防护；审计口径也需澄清 | 短期：REQUIREMENTS NFR-510 改为与 SECURITY-GOVERNANCE §鉴权分层一致的**条件化表述**（默认 SSH 隧道免 bearer；非回环必须 bearer+TLS 且当前实现不支持非回环部署=写进红线）；中期：非回环场景实现服务端 bearer 校验+Origin 白名单（~几十行），否则删除 HTTP 直连文档承诺 |
| PM-03 | **P0** | **7 个"文档在册能力"代码不存在**：`system.update.manage`、`app.process.activate`、`app.default.manage`、`gui.browser.control`、`meta.audit.query`、`meta.policy.describe`、`meta.task.status` | 文档：`CAPABILITY-MODEL.md:56,91,93,161,223-225`、`INTERFACES.md:43`；Skill：`winvm-gui-automation/SKILL.md:111-114`、`winvm-app-operation/SKILL.md:120`；全仓 `git grep -F <id>` 命中仅文档/Skill，`definitions.ts`（54 条全读）与 `psmod/*.ps1` 函数清单均无 | 场景 C（网页端生产）/E（周报流水线）两条门面场景主执行能力失效（`SCENARIOS.md:15,118,224,315`）；agent 按 Skill 指引调用 → 找不到工具 → 可能诱发禁用的脚本绕行（`winvm-orchestrator/SKILL.md:41-45`）；用户预期严重错配 | 三选一处置并**同轮执行**：① 补实现（优先 `gui.browser.control`——CDP over WebSocket 已有 Node 生态；`meta.audit.query`/`meta.policy.describe` 成本低、直接兑现监管卖点）；② 未落地前把 CAPABILITY-MODEL/INTERFACES 表格标注"规划中（未注册）"；③ Skill 文案同步删除/加"未上线"提示，杜绝教用户调不存在工具 |
| PM-04 | **P0** | **反向漏注册 + 名义/实际背离成片**：派发严格按注册 `fn` 发送（`ps-bridge.ts:347` `function: fn`），无双分支机制 ⇒ ps1 已实现却**无调用点**的四条：① `system.env.manage` 描述"读取或**设置**"、fn 只绑 Get（`definitions.ts:121`），`Set-EnvironmentVariableInfo`（`system.ps1:398`）成死代码；② `storage.archive.manage` "压缩/**解压**"只绑 New-Zip（`definitions.ts:291`），`Expand-ZipArchiveItem`（`storage.ps1:263`）死代码；③ `app.shortcut.manage` 只绑 Get（`definitions.ts:275`），`New-ShortcutItem` 死代码；④ `gui.clipboard.manage` 描述"读**写**"且入参含 `text`（`definitions.ts:309`），`Set-ClipboardTextValue`（`gui.ps1:483`）死代码——**入参 schema 给了写参数却只会返回读结果，比无参数更误导**。另一族：文档标 L2 可写、实现 L0 只读（`system.task.scheduled`/`network.config`/`user.manage`/`app.appx.manage`/`storage.recycle.manage`/`storage.dir.manage`，`CAPABILITY-MODEL.md:48,51,52,94,137,141` vs `definitions.ts:116,119,120,276,293,289`）；`REQUIREMENTS.md:37` 的"配额"在三份能力清单中均无条目 | 见左（各文件:行） | 用户指令被"近似动作"静默缩水（J6），比报错更伤信任；"54 能力"宣传口径与真实可执行面系统性偏离 | ① 四个死代码写函数补挂注册（新增 `.write` 变体或改绑双分支 + policy，零新 PS 代码）；② 只读化条目的文档统一改标"L0 查询（写侧 V2）"；③ 一致性门禁（PM-08/NP-02）规则须含"**死代码函数反向报告**"（ps1 导出函数 − 注册 fn 差集） |
| PM-05 | **P1** | FR-403"分层边界强制"验收不成立：`package.json:16` 声明 `npm run layout = node scripts/dep-lint.mjs`，README 称"由 `scripts/dep-lint.mjs` 在本地把关" | `package.json:16`；`README.md:143`；**`scripts/dep-lint.mjs` 文件不存在**（`find . -name "*dep-lint*"` 空、`git ls-files` 无 `scripts/`） | 分层架构（项目核心工程承诺）当前**无机械护栏**，随能力/包增长反向依赖风险敞口扩大 | 补写 `dep-lint.mjs`（读各包 tsconfig/package.json 的 `@winvm/*` 引用比对分层表即可，~100 行）并接入 `npm test`；若刻意删除则同步改 README/package.json |
| PM-06 | **P1** | 审计"可查"面缺失：哈希链与校验实现优秀，但用户/监管方无简单途径**读取内容**（谁在何时改了什么）；`meta.audit.query` 仅存文档；`--audit tail/verify` CLI 不存在；VM 侧 `--self-test` 只打印审计**目录**（`cli.ts:233`） | `USER-MANUAL.md:66-72`（引用不存在命令）、`CAPABILITY-MODEL.md:223`、`README.md:249`（只有文件路径） | NFR-507"支持事后校验"成立，但"事后**复盘**"对非 SSH 用户不可达（J12）；与"强监管"定位不匹配 | 最小方案：`winvm-plugin audit tail N / verify`（读 jsonl + 调 `verifyChain`，复用 `chain.ts:311`）；完整方案 = 注册 `meta.audit.query`（L0 只读，天然走现有审批豁免） |
| PM-07 | **P1** | Windows 更新管理缺失（FR-201 明列"电源与更新"；`CAPABILITY-MODEL.md:56` 在册）：VM 运维最高频诉求之一，无能力、无 backlog 登记 | 证据同 PM-03 之 `system.update.manage` 组；`REQUIREMENTS.md:35` | "把虚拟机打补丁"类请求全部失败或需人工；对企业 VM 桌面是刚需 | 与 PM-03 合并处置；补实现建议分两阶：L0 `update.list`（检查可装清单）先行、L2 `update.install`（含重启联动 `system.power.control`）后随 |
| PM-08 | **P1** | NFR-512 两条腿缺失：契约 JSON Schema 仅 `capability.schema.json` **1 份**（其余以 TS 类型表达）；"契约校验纳入 CI"——全仓无任何 CI 配置（`.github/.gitlab/jenkins` 均 0） | `ls packages/contracts/schemas`；`git ls-files | grep -i workflow` 空；`REQUIREMENTS.md:81` | "契约变更→校验失败即阻断"的纪律目前**靠人肉**（测试多但无阻断器），文档-代码漂移（PM-03/04）正是该缺口症状 | 优先做**零平台成本门禁**：`tests/unit/contract-consistency.test.js`（CAPABILITY-MODEL 表格 ID 集 ⊆ definitions.ts ID 集；ps1 导出函数 vs 注册 fn 差集告警），本地 `npm test` 即拦；CI 可后置 |
| PM-09 | **P1** | 生产素材无输入通道：`storage.file.write` 仅 UTF-8 文本（`storage.ps1:152-155`，无 base64 入参），读支持 base64（`storage.ps1:124-127`）但写不支持；无 scp/sftp/upload 工具（git grep 0 命中）；A2A 的 `imageRef: "artifact://host/upload/mountain.jpg"`（`SCENARIOS.md:203`）无对应宿主上传实现 | 场景 D（Photoshop 大山→海洋）——README/SKILL 的头牌演示——**素材如何进 VM 这一步没有产品答案** | appops 域"用 VM 软件做生产"价值主张的首步断链 | 低成本方案：`storage.file.write` 加 `asBase64` 入参（与读对称，L1 语义不变）；文档场景注明当前需预先放置素材的变通路径 |
| PM-10 | **P1** | 会话"检出即恢复"未兑现：NFR-502 称"会话挂起自动检测**并恢复**"（`REQUIREMENTS.md:71`）；`ARCHITECTURE.md:270-282` 承诺 session-guard 六机制（tscon 归还/自动登录/禁休眠）；实测 `core/session/health.ts` 仅 118 行纯探针（`:13-66`），全仓无 `tscon` 执行代码、无自动登录/禁休眠配置代码（`install-vm.mjs` 相关 grep 0 命中；安装文档 §1.5 让用户手工关睡眠 `INSTALL-GUIDE.md:100`） | RDP 断连/锁屏是远程 VM 常态事件，GUI/appops 随之全灭；降级门（`adapter-agent-workbuddy/src/index.ts:276`）✅ 存在，但恢复靠人（J11） | 「假设：tscon 需管理员权限，可能正是未实现原因」。建议至少在 `install-vm.mjs` 落地"禁休眠/屏保"两项（已验证低风险），并在 ARCHITECTURE 把"自动恢复"改标"检测+人工恢复指引" |
| PM-11 | **P1** | 审批时效对用户不可见：TTL 超时会按拒绝收口（`server.ts:533-548`），但审批卡七槽位无"有效期/截止时间"（`references/approval-card.md:37`），Skill 文案只说"超时按拒绝处理"未要求向用户播报窗口时长（`winvm-orchestrator/SKILL.md:303-306`） | 用户离席回来只见"被拒/失败"，归因困难、重试再挂起（J8） | 卡片新增第八槽位「审批有效期」（数据源=TTL 现算），降级文本模板同步一行；成本极低 |
| PM-12 | **P1** | 任务级"部分已执行"状态不可见：多步任务在最后一步审批拒绝/失败后，前序 L1 变更已落 VM；`a2a.task.get` 有 progress/artifacts（`host-a2a-bridge/src/tools.ts:487`），但无结构化的"已执行步骤 + 回滚建议"汇总；K-N1 已建立委派账本（`delegation-audit.ts:383`、`changing-log.md:47`）**数据已在、用户面没接** | 半改状态用户不自知（J10），违背"可回滚写（L1 记录回滚提示）"承诺（`REQUIREMENTS.md:91`） | 在 task 终态消息里聚合账本为 `completedSteps[] + rollbackHints[]`（L1 能力已含回滚语义素材，如 `registry.write` 的 before 值在审计链可取） |
| PM-13 | **P2** | 治理文档相互矛盾：`.dev/changing-log.md:4-9` 六项"待在真实环境终验"仍列 open，而 `README.md:305`、`06-OVERVIEW.md:92` 称同一清单"已于 R18/R19 基本闭环"；`06-OVERVIEW.md:92` 甚至称"GUI 自动化均已落地"（与 README:307"真实 GUI 点击回归仍 P2 待补"矛盾）；`.dev/changed-log.md` 未见迁移收口（`changing-log.md:54-55` 自述迁移规则但未执行） | 评估/新人以索引为准判断完成度会得出错误结论；交付状态口径分裂 | 一轮文档收口：把已验证项打 `[x]` 并链接真机报告，未验证项（GUI 回归、`k3r harness ≥3 次坐实` `changing-log.md:49`）留 open 且 README/06-OVERVIEW 用同一措辞 |
| PM-14 | **P2** | 能力/规模口径失真：`README.md:300`/`changing-log.md:12`"每域 5–8 个工具"（实际 3/14/8/13/11/5）；`06-OVERVIEW.md:62`"6 Skill"（实际 7）；`project-dev-status.md:50-51`"Skills（6）6/6"（实际 7）；`SCENARIOS.md:286`"渲染 6 个 Skill" | 上列各行 | 决策依赖的统计口径失真（roadmap 优先级、验收汇报） | 数字一律从 `git grep -c` 类可复核锚点生成；建议加一个 `meta` 能力计数断言测试（现有 self-test 已数 54 项，`project-dev-status.md:60`——把它当唯一口径源） |
| PM-15 | **P2** | Skill 间引用断链：`winvm-app-manager/SKILL.md:106`、`winvm-app-operation/SKILL.md:182`、`winvm-gui-automation/SKILL.md:119` 均引用 `../winvm-orchestrator/approval-card.md`（仓库源路径不存在，实际在 `references/` 子目录）；渲染器会注入 `references/approval-card.md`（`adapter-host-workbuddy/src/index.ts:254-257`），**安装后路径恰好修复**——但仓库内预览/直接按源路径排障时是死链；`winvm-app-operation/SKILL.md:11` 引用 `SPEC-AGENT-SERVICE-BRIDGE.md §6.1`（该文档存在但无 `6.1` 标题，锚点粒度存疑，「假设」未逐一核） | 见左 | 低（安装态自愈）；但贡献者按仓库文档跳转会迷路 | 源内统一改 `references/approval-card.md`（与 orchestrator 自身 `:51,316` 写法对齐） |
| PM-16 | **P2** | 需求引用悬空：NFR-513 验收"见 `TEST-PLAN.md`"（`REQUIREMENTS.md:82`）——**全仓无此文档**（git grep 仅命中 REQUIREMENTS 自身）；另 `REQUIREMENTS.md:149`（Q-3 默认"MCP 走工具返回'待确认'+dry-run 预览"）与实现的 token 重放模型（K4/K5 `server.ts:83-136`）已不同形，属演进未回填 | 见左 | 文档可信度；新成员找不到测试策略总览 | 要么补 `TEST-PLAN.md`（可用 project-dev-status 测试节改写），要么删引用；Q-3 更新为 K5 现状 |
| PM-17 | **P2** | 域外任务策略过宽且未对齐监管叙事：`winvm-orchestrator/SKILL.md:75-83` 授权 agent"可自主搜索、下载并部署相关的 Skill 与 MCP Server……注册为本项目扩展能力后再执行"；`SKILL.md:68` 又自称"覆盖 VM 内的**全部**操作与管理"（与 `REQUIREMENTS.md:109` V1 不含域控/驱动/BitLocker 的红线表述并存）。自主下载-部署-注册路径**未见审批闸挂钩说明**（对比 §强制门禁只约束 VM 执行面，未约束"扩展安装面"） | 「假设：部署扩展发生在宿主机，不在 VM 策略引擎管辖内——恰是问题：绕开了"所有变更可审计"的闭环」 | 供应链/失控风险 + 用户预期管理（"全部操作"措辞与 L3 拒绝面自相矛盾：`:65` 说分区格式化"本系统不提供"，`:68` 说覆盖全部） | 域外扩展加两行约束：扩展部署前需用户确认（等同 L2 审批语义）+ 登记审计；"全部操作"改为"五域+受控扩展" |
| PM-18 | **P2** | 无性能量化证据：NFR-503 "P95 < 300ms"（`REQUIREMENTS.md:72`）无基准脚本、无带数字的验收报告（`git ls-files | grep -iE "bench|perf"` 空；真机报告以功能正确性为主） | 「假设：ps-bridge 常驻 + 实测 dur 数据散见 qa/r19 工件，量级大概率成立」 | 营销口径"最高效"不可复核 | 加 `delivery/tools/bench-hotpath.mjs`（10 个 L0 能力 ×N 次取 P95），一次跑批写进报告即可闭合 |
| PM-19 | **P2** | GUI 细节覆盖缺口：多显示器（截图三次只用 `Screen.PrimaryScreen.Bounds`，`gui.ps1:100,169,520`，无 `AllScreens`/DPI 感知）；剪贴板仅文本（`gui.ps1:478-486`）——生产场景"宿主的图进 PS/PS 的图回宿主"断；`CAPABILITY-MODEL.md:153-154` 宣称窗口可"移动/改尺寸/置顶"但注册表 `state` 枚举无之（`definitions.ts:304`） | 见左 | VM 多屏/高分屏形态下 GUI 正确性风险（J7）；文档口径再列一处背离 | 截图加 `screenIndex` 参数；窗口控制补 `move/resize/topmost` 枚举（`SetWindowPos` 已列入文档依托，`CAPABILITY-MODEL.md:154`，改动小）；剪贴板支持 image/file 双格式列 P1 需求池 |
| PM-20 | **P2** | 双协议面不对称：`message/stream`（SSE）服务端已实现（`a2a-framework/src/server.ts:206`），但宿主桥只有 `a2a.delegate/task.get/approval.reply/task.cancel/health` 五工具（`host-a2a-bridge/src/tools.ts:323,487,563,619,656`），**无订阅/流转发**，标准执行路径明确写"轮询至终态"（`winvm-orchestrator/SKILL.md:28`，README:32"tasks/get 轮询"）。`06-OVERVIEW.md:28` 宣称"stream"能力，实际宿主不可用 | FR-105 验收"SSE 持续收到进度"仅在协议层成立（J 场景 C 的"实时逐页截图回传"体验依赖它） | 文档标注"宿主侧当前经轮询消费，流式接口面向非 WB 宿主预留"；或桥补 `a2a.task.subscribe` 透传 | 
| PM-21 | **P2** | 需求基线未回写：`REQUIREMENTS.md:9` 状态仍"待确认（R1/R2）"、§5.1 `:108` Skills"5 个（1+4）"、`:147-149` 四个 Q 默认值均未记录用户实际拍板结果（Q-1 的"轻量执行器"决策实际已演进为三 provider）；`docs/02-design/REQUIREMENTS.md` 作为 FR/NFR 基线自 2026-08-28 未版本化演进 | 见左 | 后续审计/验收的追溯锚点弱化；新人以过期基线理解产品 | 升 v1.1：状态改"已确认（含 R 轮演进记录）"，§5.1 改 7 Skill/三 provider，加"变更记录"小节指向 `.dev/changed-log.md` |
| PM-22 | **P1** | **用户入口文档系统性过时 + 首日转化断点**（§3 J1/J2/J3 的问题化归账）：`USER-MANUAL.md:9` 称 5 个 Skill（实 7，README:6）；`:42,56` 用已废弃的 `tasks/send`/`tasks/resubscribe`（服务端显式拒绝旧名，`a2a-framework/src/server.ts:187`；全仓无 resubscribe）；`:68,71` 引不存在的 `cli.js --audit`（`vm-service/src/cli.ts:39-73`）；`:81` 手工 ssh 建隧道与 `winvm-orchestrator/SKILL.md:92`"无需/不得手工"直接冲突；`:84` 指 DEPLOYMENT §4.1 找解禁指引但该节无解禁步骤（J2）；`:28`"自动选通道"与 `tunnel-mode` 默认 mcp、安装不写该字段（`install-host.mjs:1332-1346`、`constants.ts:269`）不符（J3） | 上列各行 | 新用户第一旅程的四条硬伤全在唯一入口文档上；agent 按手册行事会用错方法名/找不到工具 | 一轮重写 USER-MANUAL（对齐 NP-12）；建议以 README §7 + winvm-mcp-reference 为底本；解禁与 tunnel-mode 两节必须给出可执行命令（`winvm-plugin tunnel-mode intelligent` 等） |

**计数**：P0 = PM-01~04 共 **4**；P1 = PM-05~12 + PM-22 共 **9**；P2 = PM-13~21 共 **9**；合计 22 条。

---

## 5. 需求池建议（P0/P1/P2，与现有 Roadmap 对齐说明）

现有 Roadmap 锚点：`README.md §9`（9.1 K6 已闭环、9.2 体验边界、9.3 监管韧性、9.4 扩展性、9.5 真机终验遗留）、`.dev/changing-log.md`（可增强：能力广度 `:12`、审批闸 UI `:13`、更多宿主/VM Agent 适配 `:14-15`；未做：GUI 真实回归 `:18`、多 VM `:19`）。

### P0（损害核心卖点，建议下一轮立项）

| 需求 | 内容 | 理由与影响面 | 与 Roadmap 关系 |
|---|---|---|---|
| **NP-01 快照执行器落地**（对应 PM-01） | L2/L3 按 `audit.snapshot` 声明自动采集 before/after（截图 + 目标状态摘要），产物挂 traceId 入审计 `artifacts` | 兑现 NFR-509/FR-205/`SECURITY-GOVERNANCE.md:88` 的差异化卖点；卸载域 `Get-UninstallPrecapture` 样板已在（`app.ps1:665`），边际成本低 | **全新**——README §9.3"监管韧性"仅登记词表/审计 warn 类小项，无快照项；建议新增 §9.6 |
| **NP-02 文档-注册表-ps1 三方一致性门禁 + 口径修正**（对应 PM-03/04） | ① `contract-consistency` 单测：CAPABILITY-MODEL/INTERFACES 表格 ID ⊆ `definitions.ts`；ps1 导出函数与注册 fn 差集报告（**死代码反向清单**）；② 把 7 个未实现 ID 标注"规划中"；③ 补注册 4 个已实现死代码函数（`Set-EnvironmentVariableInfo`/`Expand-ZipArchiveItem`/`New-ShortcutItem`/`Set-ClipboardTextValue`） | 止住"静默缩水"（J6）与"Skill 教空调用"（J5）持续产生；纯工程护栏，不依赖新 VM 功能 | **全新**——§9.4"能力广度"只谈加、没谈对齐；changing-log:12 同。此需求是"能力广度"扩张的前置质量闸门 |
| **NP-03 HTTP 直连安全口径整改**（对应 PM-02） | 短期改文档（与 `SECURITY-GOVERNANCE.md:222-224` 条件化口径统一），中期非回环场景服务端 bearer + Origin 校验 | 不改会让"最可监管"存在与安全文档打架的审计发现；整改面小但敏感 | **全新**——REQUIREMENTS §5.3 红线只覆盖"公网暴露配置模板"，未覆盖"HTTP 模式承诺强度" |

### P1（显著缺口，建议排入近 2~3 轮）

| 需求 | 内容 | 理由与影响面 | 与 Roadmap 关系 |
|---|---|---|---|
| NP-04 `gui.browser.control` 实现 | CDP over WebSocket 最小集：navigate/click/fill/screenshot/getDOM（`CAPABILITY-MODEL.md:161` 已定义依托） | 场景 C/E 门面可用性的唯一硬阻塞；生产用户"网页端后台操作"高频 | §9.4"能力广度"的**具体化**（原文无优先级）——建议从泛化条目升为显式项 |
| NP-05 Windows 更新管理两阶 | `system.update.list`（L0）先行、`system.update.install`（L2，联动 power.control）后随 | FR-201 明列；企业 VM 运维第一高频动作 | §9.4 具体化；无冲突 |
| NP-06 `meta.audit.query` + `winvm-plugin audit tail/verify` | 只读审计查询能力 + 宿主侧 CLI | 兑现"事后复盘"（J12）；与监管方诉求直接挂钩 | **全新** |
| NP-07 高危解禁操作路径文档化（J2） | `disabledTools` 的查看/逐项解禁/复核三步指引 + 安装器 `--enable` 类开关评估 | 首日转化断点；纯文档+小工具 | changing-log:13"审批闸 UI"的相邻面，未覆盖此项 |
| NP-08 素材输入通道 | `storage.file.write` 支持 `asBase64`；文档场景 D 注明素材预置步骤 | appops 头牌演示的首步断链（PM-09） | **全新** |
| NP-09 会话恢复最小三件：禁休眠+屏保禁用写入 install-vm、锁屏状态告警话术、tscon 指引文档化 | 按 `ARCHITECTURE.md:274-277` 承诺逐条兑现或改口径 | NFR-502 的"并恢复"半句；远程 VM 高频异常 | §9.2"体验与可靠性边界"相邻，该节现仅登记冷启动/token 保留 |
| NP-10 dep-lint 补件（PM-05） | 实现 `scripts/dep-lint.mjs` 并挂 `npm run layout` | 已有声明无实体，属"承诺-实现"债务中最易清偿的一档 | **全新** |
| NP-11 审批卡增"有效期"槽位 + 拒绝后"已执行步骤/回滚建议"聚合（PM-11/12） | 卡片第八槽位 + task 终态 `completedSteps[]/rollbackHints[]` | 审批体验闭环；账本数据（K-N1）现成，属"接出去" | 与 changing-log:13"审批闸 UI"部分重合——建议并入该项细化，避免重复立项 |

### P2（口径与工程债，择机批量清偿）

| 需求 | 内容 | 对应问题 | 与 Roadmap 关系 |
|---|---|---|---|
| NP-12 | USER-MANUAL 全面重写对齐（7 Skill/两连接器/approval.reply/audit 正确命令/tunnel ensure） | **PM-22**（J1/J2/J3） | 文档治理，与 QA 的文档合规评估（任务 #2）协同，避免重复登记 |
| NP-13 | 数字口径以可复核锚点生成（54 能力唯一源=self-test；Skill=7；删"每域 5-8"） | PM-14 | 全新 |
| NP-14 | REQUIREMENTS 升 v1.1 回写演进（Q1-Q4 裁定、Skills 1+5+1、快照/更新条目标注实际态） | PM-21/16 | 全新 |
| NP-15 | `.dev` changing-log 六项终验状态与 README/06-OVERVIEW 统一口径 | PM-13 | changing-log:54-55 自定迁移规则的执行，属既有规则未落地 |
| NP-16 | 热路径 P95 基准脚本 + 一次性报告 | PM-18 | 全新 |
| NP-17 | 窗口 move/resize/topmost 枚举 + 截图 `screenIndex`/DPI + 剪贴板 image 格式 | PM-19/9 | §9.4 具体化 |
| NP-18 | 桥 `a2a.task.subscribe` 透传或在文档标注"宿主侧轮询消费" | PM-20 | 全新 |
| NP-19 | Skill 源内引用路径统一 `references/approval-card.md` | PM-15 | 全新（R17 遗留，`changing-log.md:40-41` F-2/F-3 相邻） |

**冲突提示**：NP-02（先立一致性门禁）与 §9.4"能力广度按需扩充"存在**次序张力**——在文档-实现漂移系统性存在（本次实测正向 7 条+反向 4~5 条）的现状下继续加能力会放大漂移，建议门禁先行一轮。除此之外需求池与既有 Roadmap 无实质冲突，均为"泛化条目具体化"或"全新缺口补登"。

---

## 6. 结论与完善路径建议（产品视角）

**总评**：WinVM Bridge 的**双通道骨架、监管内核（策略/审批/哈希链）、卸载链深做**三件事是真材实料的——K5/K-N1/S-4 修复史和 1054 用例证明团队有把最难的安全语义啃到底的工程纪律，这在同类"AI 操作虚拟机"方案里构成有效壁垒。但产品当前处于**"承诺超前于兑现"的净负债状态**：4 条 P0 全部属于"文档/Skill 对用户许了、代码没还"（快照、7 个幽灵能力、名义可写实际只读、HTTP 安全口径），且没有任何机制防止继续欠账（无 CI、无一致性门禁、dep-lint 缺件）。

**建议路径（三步，各约一轮）**：

1. **止血（先还债不加新）**：NP-02 + NP-03 + NP-10 组合——建一致性门禁、修正七处幽灵承诺的文档口径、补注册 4 个"已实现未挂载"的现成函数。零新 VM 功能、纯本地可验证，却直接消除 J5/J6 两类最伤信任的体验。同步清偿 PM-13/14/15/16/19/21 六条口径债（NP-12~15/19 可并为一轮"文档对齐"批处理，建议与 QA 成员的任务 #2 结论合并执行避免返工）。
2. **兑现卖点（P0 功能补课）**：NP-01 快照执行器 + NP-06 审计查询——把"最可监管"从"内核里有"变成"用户看得见"；NP-07 解禁路径让用户能安全地干"真活"（当前默认配置下连一次 L2 试用都走不通）。
3. **打开生产场景（P1 广度补课，按频次排序）**：NP-04 浏览器 → NP-08 素材通道 → NP-05 更新管理 → NP-09 会话恢复——前两项决定场景 C/D/E 三条门面故事线是否名副其实；后两项决定"日常运维"复购留存。执行每轮前重复用 NP-02 门禁做准入检查，让"新增能力=文档同步"成为默认。

**产品判断**：不建议在门禁建立前扩大 54 的数字。当前"54 能力"的市场宣发口径与实际可执行面（写操作面仅 8 条 L2/L3，且其中 6 条伴随名义/实际背离）之间的差距，比能力数量本身更需要管理。把"完全操作一台 Windows VM"的宣称阶段性收敛为"**巡检/卸载/生产三类场景完全可操作，其余高频运维场景逐步开放**"，与"强监管"人设反而更自洽。

