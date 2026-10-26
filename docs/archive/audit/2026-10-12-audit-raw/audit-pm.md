# WinVM Bridge 产品功能完备性全面审计（PM 视角）

- 审计人：许清楚（Product Manager / software-product-manager）
- 日期：2026-10-12
- 基线：HEAD `13b8705`（Phase 2 收官批，测试基线 92 files / 1889 用例）
- 仓库：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`（下称 REPO）
- 方法：**全程只读**，逐条结论附文件路径+行摘录；无证据处显式写「未找到证据」。
- 锚点纪律：文档引用以段标签为主、行号为辅（并行改动行号可能漂移）。

---

## ① 能力矩阵兑现度

### 1.1 事实源与规模核对

| 项 | 结论 | 证据 |
|---|---|---|
| 能力注册表唯一事实源 | `packages/vm-capabilities/src/registry/definitions.ts`，**实测恰 54 条**：meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5 | definitions.ts `META/SYSTEM/APP/STORAGE/GUI/APPOPS` 六数组（:92-477）与汇总 `WINDOWS_CAPABILITIES`（:480）；README.md:326 口径「54 个能力…以 definitions.ts 为准」，与代码清点一致 ✅ |
| 对外宣称数 | README/overview 均称 54，`node delivery/winvm-plugin.mjs health` 也校验 54 | README.md:36/:235/:326；overview.md:47-48 |
| SKILL.md 数 | 任务书称「9 个 SKILL.md」，**实测 7 个**（skills/ 与已安装 connector 各 7，同批）；未找到第 8/9 个（搜过 `find . -name SKILL.md` 全仓 + connectors 目录） | `skills/*/SKILL.md`×7；`/storage/Users/currentUser/.workbuddy/connectors/skills/connector-winvm/`×7 |

### 1.2 五域 × 实现 × 测试 × 文档 × skill 声明 兑现度表

判定口径：**实现**=psmod 函数存在**且被注册 `fn` 绑定**（派发严格按注册 fn，见 CAPABILITY-MODEL.md §3.1.2「名实口径」）；**测试**=`tests/`+`qa/` 有该 ID 命中；**文档**=`docs/`+`skills/`+README 命中；**skill 声明**=7 个 SKILL.md 中至少一处出现该 ID。🔴=对外承诺有实伤。

| 能力 ID | 实现 | 测试 | 文档 | skill | 备注（名实差） |
|---|---|---|---|---|---|
| meta.health.check | ✅ | ✅ | ✅ | ✅ | Node 侧内置投影（module=`__meta`），设计如此 |
| **meta.capability.list** | ✅（fn=listModules→ps-bridge.ps1:126） | ✅ | ✅ | 🔴**7 个 SKILL.md 均未声明** | 用户/Agent 经 skill 引导时**发现不了「列出可用能力」这条自省通道**；orchestrator 路由表也未指向它 |
| meta.session.status | ✅（复用 gui.Get-SessionHealth） | ✅ | ✅ | ✅ | 与 gui.session.status 同 fn 双 ID，属别名，可接受 |
| system.info.get | ✅ | ✅ | ✅ | ✅ | |
| system.service.list | ✅ | ✅ | ✅ | ✅ | |
| system.service.control | ✅ | ✅ | ✅ | ✅ | |
| system.service.configure | ✅ | ✅ | ✅ | ✅ | |
| system.process.list | ✅ | ✅ | ✅ | ✅ | |
| system.process.terminate | ✅ | ✅ | ✅ | ✅ | |
| system.task.scheduled | ✅ 仅查询 | ✅ | ✅ | ✅ | 写侧（注册/修改/删除）= V2；SKILL 已如实告知 |
| system.registry.read | ✅ | ✅ | ✅ | ✅ | S-1 路径归一在策略层，测试充分 |
| system.registry.write | ✅ | ✅ | ✅ | ✅ | L2+allowlist 配对（r19b-s5） |
| system.network.config | ✅ 仅查询 | ✅ | ✅ | ✅ | 改 IP/DNS= V2；已如实告知 |
| system.user.manage | ✅ 仅查询 | ✅ | ✅ | ✅ | 改密/组= V2；已如实告知 |
| **system.env.manage** | 🔴 **实际只读**（fn=Get-EnvironmentVariableInfo） | ✅ | ✅ | ⚠️ SKILL:63 已标只读 | `Set-EnvironmentVariableInfo` 已实现未挂载（system.ps1:398，CAPABILITY-MODEL §3.1.2 表）；schema 保留写参数位→传值无写入回执仍 success，**静默无效面** |
| system.eventlog.query | ✅ | ✅ | ✅ | ✅ | |
| system.power.control | ✅ L3+dryRun | ✅ | ✅ | ✅ | 全仓最重护栏样板 |
| app.inventory.list | ✅ | ✅ | ✅ | ✅ | |
| app.winget.search | ✅ | ✅ | ✅ | ✅ | |
| app.winget.install | ✅ | ✅ | ✅ | ✅ | |
| app.winget.uninstall | ✅（R17 K6 核验+NSIS 回退+K-N2 dryRun 预览） | ✅（51 refs） | ✅ | ✅ | 全仓打磨最深的一条，可作质量标尺 |
| app.winget.upgrade | ✅ | ✅ | ✅ | ✅ | |
| app.process.launch | ✅ | ✅ | ✅ | ✅ | |
| **app.shortcut.manage** | ⚠️ **注册 fn=Get-ShortcutInfo 已含创建分支**（app.ps1:1026-1048 D8 修复：传 targetPath 即创建） | ✅ | 🔴 | 🔴 **SKILL 仍称「只读/创建不可用」**（app-manager SKILL:57/:97） | **文档落后实现**：代码已支持创建（D8），CAPABILITY-MODEL §3.1.2 与 SKILL 仍按旧口径写「New-ShortcutItem 待挂载」→ 对外**低报能力**，Agent 会拒绝本可完成的请求 |
| app.appx.manage | ✅ 仅查询 | ✅ | ✅ | ✅ | 安装/移除 UWP=未注册；已如实告知 |
| storage.disk.list | ✅ | ✅ | ✅ | ✅ | |
| storage.space.analyze | ✅ | ✅ | ✅ | ✅ | |
| storage.file.read | ✅ | ✅ | ✅ | ✅ | |
| storage.file.write | ✅ | ✅ | ✅ | ✅ | |
| storage.file.delete | ✅（默认回收站；permanent L2；dryRun） | ✅ | ✅ | ✅ | |
| storage.file.move | ✅ | ✅ | ✅ | ✅ | |
| storage.file.copy | ✅ | ✅ | ✅ | ✅ | |
| storage.dir.manage | ✅ | ✅ | ✅ | ✅ | |
| storage.search.query | ✅ | ✅ | ✅ | ✅ | |
| **storage.archive.manage** | 🔴 **仅压缩**（fn=New-ZipArchiveItem；`Expand-ZipArchiveItem` 已实现未挂载，storage.ps1:263） | ✅ | ✅ CAPABILITY-MODEL 已如实 | ✅ SKILL:77/:141 已如实 | 用户传 destination 想解压→实为**压缩**语义；schema 无 action/mode 参数位区分。解压函数现成，**挂载=零新代码收益** |
| storage.link.manage | ✅ | ✅ | ✅ | ✅ | |
| **storage.recycle.manage** | 🔴 **仅查看**（fn=Get-RecycleBinInfo；清空未实现亦未挂载） | ✅ | ✅ | ✅ SKILL:79/:138 已如实 | 清空= V2 规划（无函数体）——与「已实现待挂载」族不同，属真空缺 |
| storage.cleanup.analyze | ✅ 仅分析 | ✅ | ✅ | ✅ | 设计上就是「只建议不执行」，符合声明 |
| gui.session.status | ✅（含 degraded/unavailable 语义） | ✅ | ✅ | ✅ | |
| gui.screen.capture | ✅ | ✅ | ✅ | ✅ | |
| gui.screen.analyze | ✅ | ✅ | ✅ | ✅ | |
| gui.window.list | ✅ | ✅ | ✅ | ✅ | |
| gui.window.control | ✅ | ✅ | ✅ | ✅ | |
| gui.input.keyboard | ✅ | ✅ | ✅ | ✅ | |
| gui.input.mouse | ✅ | ✅ | ✅ | ✅ | |
| gui.uia.tree | ✅ | ✅ | ✅ | ✅ | |
| gui.uia.invoke | ✅ | ✅ | ✅ | ✅ | |
| **gui.clipboard.manage** | 🔴 **实际只读**（fn=Get-ClipboardText；`Set-ClipboardTextValue` 已实现未挂载，gui.ps1:483） | ✅ | ✅ | ✅ SKILL:71 已标只读 | schema 保留 `text` 写参数位；描述却写「读取**或写入**剪贴板文本」（definitions.ts:337）→ **注册表描述与行为不符**，是本族最直接的"话术越权" |
| gui.wait.condition | ✅ | ✅ | ✅ | ✅ | |
| appops.state.query | ✅ | ✅ | ✅ | ✅ | |
| appops.cli.invoke | ✅ | ✅ | ✅ | ✅ | enum 白名单 7 种 CLI；pathAllowlist 输出目录 |
| appops.workflow.run | ✅（WORKFLOW_NOT_FOUND 语义诚实） | ✅ | ✅ | ✅ | 「预置工作流」模式——**VM 内无预置库**时该能力对外近乎空壳（见 §1.4） |
| appops.com.automate | ✅ | ✅ | ✅ | ✅ | 需 Office 类 COM 装在 VM 内 |
| appops.gui.produce | ✅ 步骤驱动器 | ✅ | ✅ | ✅ | 步骤序列由 Skill/LLM 供给，设计相符 |

**统计**：54/54 全部有注册+有实现绑定+有测试引用；**名实缺口集中在 4+2 条**：
- 「已实现待挂载」族（补挂载=零新代码）：`system.env.manage` 写侧、`storage.archive.manage` 解压、`gui.clipboard.manage` 写侧、`app.shortcut.manage` 创建（**此条实现已在注册 fn 内，属文档欠账而非功能欠账**）。
- 真空缺（无实现，V2 规划）：`storage.recycle.manage` 清空、`system.update.manage`（未注册）、`gui.browser.control` CDP 直驱（未注册）、`app.default.manage`（未注册）。

### 1.3 V2/降级项对外承诺核对（好的一面）

7 个 SKILL.md 与 CAPABILITY-MODEL v1.4 对 V2 项做了**统一的「当前不可用」显式标注**（grep 证据 30+ 处，如 gui SKILL:7/:112、app-operation SKILL:120、system-admin SKILL:7/:30-33、app-manager SKILL:7/:32）。未发现任何 skill 把 V2 项写成「可做」。**这是文档诚实化的显著成绩**——上一轮 Phase0「7 条幽灵能力摘除」已收口（CAPABILITY-MODEL 版本行:6）。

### 1.4 产品视角的三个真实缺口

1. **「生产活动」承诺的最后一公里靠 VM 内环境，不靠能力表**。核心承诺是"完整操作 Windows VM 进行生产活动（图像处理/Office 文档/浏览器网页）"。能力层给了驱动器（appops.*），但**成品路径依赖**：Photoshop/Office/ffmpeg 等必须**预装**在 VM；`appops.workflow.run` 依赖**预置脚本库**；浏览器生产走 UIA+键鼠（脆弱路径）。仓内**未见任何"生产环境预装清单/工作流模板库"交付物**（搜过 delivery/、docs/05-peripherals/、qa/）——新用户装完插件，appops 域大概率"有路没车"。**建议 P0**：随插件提供「生产应用预检+一键装机清单」（用 app.winget.search/install 实现，能力已具备，缺的是产品化编排）。
2. **「已实现待挂载」四件是产品库存货积压**。每条都只差注册表一行 fn 绑定+文档口径，但对外承诺面上直接损失 4 个可感知功能（写环境变量/解压/写剪贴板/建快捷方式）。**建议 P1**：一个 CL 批量挂载+按「写侧需审批」原则接入策略。
3. **`meta.capability.list` 没进任何 skill** = 自我描述通道对用户不可发现。用户问"你能在虚拟机里干什么"时，Agent 按 orchestrator 静态路由表回答，而非实时能力清单——**注册表一旦增减（如挂载四件后），skill 文案即过期**。建议 P1：orchestrator SKILL 加「先 meta.capability.list 再答能力面」纪律。

### 1.5 心跳落盘

- §1 结论落盘：见 timeline。

---

## ② 双通道功能对等性（MCP 直调 vs A2A 委派）

### 2.1 四件事对等性矩阵

| 维度 | MCP 直调（连接器 `winvm`） | A2A 委派（连接器 `winvm-a2a`） | 对等判定 |
|---|---|---|---|
| **审批：判定** | 同一策略引擎 `core/policy`（L2/L3→`APPROVAL_REQUIRED`），server.ts:1229 `policy.evaluate` | 委派内层能力调用回连**同一** handler（dtid 注入归因），同一判定 | ✅ 同源单点（FR-103 兑现） |
| **审批：载荷** | `approval{approvalId,risk,capabilityId,preview,impact,resumeHint}`（server.ts:1296-1310） | 同结构 + `underlying` + taskId；CL-016 已做 7 槽位等价（REQUIREMENT G1/A5） | ✅ 口径一致（CL-016 收口） |
| **审批：批准落地** | ❗ **断裂**：续跑要求以同参数附 `__approvalId` 重发（orchestrator SKILL:259-261、mcp-reference:212），但服务端放行判据是 `token.hostApproved===true`（server.ts:1227），**全仓唯一置 true 点**在 `VmApprovalCoordinator.raise`（server.ts:424），而 `raise` 仅被 LLM 桥调用（bridge.ts:1232）——**没有任何宿主可达路径能为纯 MCP 直调令牌置 hostApproved**。重发只会拿到**新 approvalId 的再次 APPROVAL_REQUIRED**（真机反证：`qa/r19/r1-forged-resume.resp.json`） | `a2a.approval.reply`→`resolveApproval(true)`→置位→K5 服务端重放 | 🔴 **不对等（P0）**：文档在册的两段式 MCP 审批流程实际走不通；`.workbuddy/memory/MEMORY.md:35`「A5 …真机不可达」在册未修。纯 MCP 形态下 L2/L3 事实上只剩三条活路：dry-run 免批预览（`supportsDryRun` 恰 5 条，definitions.ts:146/179/205/301/314 由 p0-path-traversal 集合钉）、V2 未注册项不触闸、或改走 A2A。用户承诺「两条通道都能做 L2 操作（经审批）」未兑现 |
| **取消** | ARCH-29（P2-T4）：宿主断连→`ToolContext.signal`→ps-bridge per-call abort→`TASK_CANCELED`（协作式，边界粒度） | `tasks/cancel`→`isCancelled`+`cancellationSignal`→同一 `req.signal` 消费面；两态事实化（HOST-A2A §4.5） | ⚠️ **三层拆开判（20:55 复核修正，原记「✅ 语义对齐」偏乐观）**：① **中止语义=真对等**——同一 `req.signal` 消费面、同一 `TASK_CANCELED` 码位、三条纪律（协作式/绝不谎报强杀/码不折叠）逐条覆盖两通道（SECURITY-GOVERNANCE §2.2.1 表 :102-119，判据 `tests/unit/phase2-mcp-signal.test.js` 含「响应已写完不得 abort」假取消反证）；② **触发面不等**——MCP 只有传输层断连一档（server.ts:1681-1694 `watchClientDisconnect`），54 能力与 mcp-framework 全仓 `cancel` **零命中**（definitions.ts `grep -i cancel`=0），用户说「停」时直调无可调用的停止动作；③ **呈现面不等**——委派有显式终态文案（`canceledSummaryText` + `executedBeforeCancel{steps,artifacts}`，tools.ts:467/540-543），直调的 canceled 事实由「已经走开的调用方」自己收，**用户永远收不到「取消前已执行 N 操作/M 产物」的交代**（这是 §2.2-2 产品缺口的真身）|
| **进度回流** | ❗ 无进度通道——MCP 单工具调用请求-响应，全仓 `grep notifications/progress` **0 命中**（搜过 mcp-framework/vm-service 全部 src）；长能力（uninstall 600s、workflow 600s）期间用户端零反馈，宿主侧只剩连接器 `timeoutMs`（adapter-host-workbuddy/index.ts:110） | `progress[]` 累积 + SSE `message/stream`；P2-T12 修复后确定性模板进度恢复可达（HOST-A2A §4.3.1） | ⚠️ **结构性不对等**：简单长任务（直调一条 10 分钟 workflow）体验天然劣于委派。属协议形态差异，可用 MCP progress notification 或「拆步直调」话术缓解——后者已写进 orchestrator 路由判据，**产品面可接受但需在 SKILL 明确告知「直调无中间进度」** |
| **审计** | 同一条哈希链；`channel:'mcp'`；S-4 已修 POLICY_DENIED 硬拒入链；blocked 令牌清扫也落链（ARCH-05） | `channel:'a2a'` + `delegationId` 精确归因（K-N1）；blocked/executed/decision 三类入链；G-a 真值反查覆盖 traceId 归属 | ✅ 覆盖面一致（P2-T8 明文把真值层推到 MCP 直调形态）；归因颗粒略不等（委派有回合账本、直调仅 traceId），对取证无实质影响 |

### 2.2 「一条路能做、另一条不能」清单

1. 🔴 **MCP 直调无法独立走完审批**（见上表批准落地）——文档却给了完整续跑指令（approval-card.md:33/142 模板、mcp-reference §速查表），Agent 照做会原地打转 → 用户看到「批准了但每次都还要批准」。这是**双通道对等性最大的单点破口**。修复选项：(a) 桥/宿主增加 `approval.reply` 等价 REST/A2A 可达入口为 MCP 令牌置位；(b) 或诚实降级：把 SKILL/mcp-reference 中 MCP 续跑指令改为「转 A2A 审批」话术。**当前文档与实现互相指认对方为真，属承诺级矛盾**。
   - **20:55 复核加固（静态证据链已闭合，可判定）**：`hostApproved = true` 全仓唯二写点均在 `VmApprovalCoordinator.raise` 批准分支（server.ts:424 置位 + :435 决策记账），而 `raise` 的**生产调用点全仓仅 1 处**（bridge.ts:1232，`workbuddy` LLM 桥 `maybeResume`）；纯直调无挂接任务 → `raise` 走 `no-active-task` 早退（server.ts:351-363，该 warn 日志即 P1-Fix 补的可观测点，其注释 :352 明文承认「根因文档 §6.4 点名零日志是本次只能靠反证定位的原因」）。另查 `resolveApproval` 消费面（a2a-framework/server.ts:301 ← task-store.ts:550）仅挂在 `approval/reply` JSON-RPC 上，`/mcp` 与 `/admin/*` 路由内**无任何批准入口**；`approval-replay.ts:358 listPending` 只**读**未决项（`hostApproved === true` 即 `continue`），全仓 `listPending` **零调用点**（grep 仅命中定义与其自身注释）⇒ **不存在第三条放行路径**，此结论已由静态升为可判定。
   - **现实爆炸半径（比首记要窄，须如实收缩）**：触发条件 = 走 MCP 直调 **且** 命中 L2/L3（注册表实测 L2 仅 7 条 + L3 仅 1 条 / 共 54，另 L0 27、L1 19）且**不在** `supportsDryRun` 免批 5 条内。默认 provider `workbuddy-deterministic` 的 5 模板 6 能力**全为 L0/L1，永不触闸**（见 §3 补充复核）⇒ 默认开箱形态不会撞上此破口；撞上的是「用户显式改用 L2 能力（registry.write / service.configure / process.terminate 等）经直调」与「切 LLM provider 后由宿主直调」两型。P0 定级不变（文档承诺失实 + 用户按文档操作必死循环），但**排期叙述应带上此限定**，避免夸大首日流失。
   - **对修复选项 (a) 的硬约束（新增证据）**：`a2a.approval.reply` 的 inputSchema `required: ['taskId','approvalId','approved']`（tools.ts:630 起）——**纯直调场景没有 taskId**（无委派回合）。故 (a) 不是「复用现成 reply 工具」，必须新建「无任务态令牌批准」入口，并同步处理 K5 §4 安全纪律 2（置位点放宽=审批卡体系被绕过风险）与 `tests/unit/k5-replay.test.js:890-892` 三条**源码字符串守卫**（钉 `hostApproved: false` 注册、`hostApproved === true` 严格闸、`if (token) token.hostApproved = true;` 逐字形态）——任何实现改动都须同时改这三条守卫，属**受契约保护的变更**（已在 20:44 移交 team-lead，此处补证据出处）。
   - **选项 (c) 策略化（成本最低、语义最干净，建议优先讨论）**：把纯直调会命中的 L2/L3 在 MCP 面直接判「须走委派」（服务端事实而非调用方自报参数，顺带解掉 §2.2-5 的信任错位）。产品口径由「两通道都能审批」改述为「L2/L3 一律经委派审批」，是**收窄承诺**而非**扩实现**，可当轮闭环。
2. ⚠️ **直调无面向用户的取消动作与取消回执**（对首记「仅剩触发形态差异」的修正，详见上表取消行三层拆分）：语义层已对齐，缺的是 MCP 侧 `cancel` 可调面 + 「取消前已执行 N 操作/M 产物」的用户呈现（委派侧 `executedBeforeCancel` 有、直调无对应物）。定级 **P1**（用户主动叫停后无从确证「停到哪一步」，与「最可靠可审计」卖点冲突；但协作式纪律与码位保真已到位，不属承诺失实）。
   - **21:20 反证搜索结论 + 关键新证据（比首记更硬）**：全仓 `grep -i cancel packages --include=*.ts` 的命中**全部落在 A2A 框架侧**（`a2a-framework/client.ts:184 cancelTask`、`server.ts:210/467 tasks/cancel`、`task-store.ts:113/355-357 cancelRequested/TaskNotCancelableError`）与 mcp-framework 的**收口文案侧**（`CANCELED_TEXT`），**MCP 面无任何取消发起面**。且——`packages/mcp-framework/src/server.ts:177-180`：
     ```
     case 'notifications/initialized':
     case 'notifications/cancelled':
     case 'initialized':
       return null;
     ```
     即 **MCP 协议标准的客户端取消通知被显式并入「空实现」分支**（收到即吞，既不 abort 在途 `AbortController`、也不记账）。⇒ P1 修复成本进一步下降且路径明确：把 `notifications/cancelled`（`params.requestId`）接进 server 侧在途请求登记表并 abort，即可复用 ARCH-29 已建好的 `req.signal` → `ToolContext.signal` → ps-bridge 消费链与 `CANCELED_TEXT`/`TASK_CANCELED` 码位，**零新契约、零新错误码**。这条也解释了为何 §2.2.1「两通道取消口径」文档不算失实——它写的是「中止语义与收口口径一致」（真），而不是「两通道都有取消触发面」。
3. ⚠️ `a2a.delegate` 的 `maxRisk` 默认 L1（HOST-A2A §4.2/tools.ts:373）⇒ 委派默认做不了 L2/L3，需显式抬升；MCP 直调无 maxRisk 封顶、靠审批闸。同一意图默认口径不同（一个静默 POLICY_DENIED `maxRisk:L1`、一个 APPROVAL_REQUIRED），Agent 依 SKILL 分流时容易把「默认值差异」误读为「被拒绝」。建议 delegate 文案/SKILL 注明「需 L2 请显式 maxRisk:L2 + 走审批」。
4. ✅ 其余面（能力集、策略、审计、错误码封闭 10 码、脱敏纪律）两通道共享同一注册表与同一 handler，无发现「某能力仅单通道可用」的证据。
5. 📌 **审计查询面（与续棒 audit-pm2.md §2.1 审计行独立同结论，交叉验证成立）**：两通道落链口径一致，但**对外零查询面**——54 能力与 5 个 `a2a.*` 工具里没有任何「查审计」工具（`definitions.ts` 内 `audit` 仅 `snapshot` 元数据命中；宿主侧 `approval-audit.ts` 只写本地留痕）。合规/用户回溯「谁批准了什么」须进 VM 翻链文件。定级 **P2**（`winvm-plugin` CLI 加 `audit tail/verify` 即可兑现，复用 `chain.ts` 校验，成本极低、话术收益直接）。

---

## ③ 三大 VM Agent Provider 成熟度分级

| provider | 事实源 | 完成度评级 | 证据要点 |
|---|---|---|---|
| `workbuddy-deterministic`（默认） | adapter-agent-workbuddy/index.ts（1159 行） | **A-（可生产，但覆盖面窄；默认镜像下「生产」这一路必空转）** | 仅 **5 个正则目标模板**（index.ts:550 起：安装应用/磁盘分析/系统信息/截图/生产操作 appops；无匹配→`UNSUPPORTED_GOAL`:675）；取消哨兵单点咽喉（step() :483-535）、O-1 契约码保真（P2-T10）、`r19c-kn1-*` 等重测试族覆盖。**开放任务一律不支持**——委派价值 = 「会做五件事的机器人」。**20:55 两条补充复核**：① 好消息（安全面）——模板所用 6 个能力全为 **L0/L1**（definitions.ts:133/178/179/322 + gui.screen.capture L0 + appops.workflow.run L1），默认 provider 路径**永不触审批闸**（`maxRisk` 默认 L1 也不构成拒止）。根因不是巧合而是结构：默认 provider 无 `approvalCoordinator`，`step()` 只透传错误码、模板无 `approvalId` 回环（对照 LLM 桥 `maybeResume`→`raise`，bridge.ts:1194/1232）⇒「no-active-task 早退」的 P0 断裂面被 provider 选型**天然规避**——即：**P0-1 的现实爆炸半径 = 纯 MCP 直调 + `workbuddy` LLM provider 经宿主直调**，而非默认全家桶。② 坏消息（价值面）——模板 5「生产操作」硬编码 `workflow: 'generic_production'`（index.ts:636），而全仓**零个工作流实体**（`find -iname '*workflow*'` 空命中；2026-10-08 产品审计 :122 亦记 `git ls-files | grep workflow` 空）⇒ **默认 provider + 默认 VM 镜像下，用户最期待的「生产活动」必返 `WORKFLOW_NOT_FOUND`**（文案 :653-661 虽诚实给出两条解法，但要求用户自己「在 VM 里预置脚本」）。此条为 §1.4/§6「生产就绪包 P0」的最硬实证 |
| `workbuddy`（codebuddy LLM） | adapter-agent-workbuddy-llm（bridge 1854+persistent 1087+index 622+truth 455 行） | **B+（功能最全，运维敏感）** | K4/K5 审批重放真接线（:274-275 注入 coordinator，bridge:1232 raise）；常驻会话+降级不破功能（index.ts:460 起 disabled 显式拒绝 LLM_SESSION_DISABLED，零静默）；预热 K2；真值反查 CL-K3R。**坑**：依赖 VM 内 codebuddy 已装**且已登录**（INSTALL-GUIDE §1.4、app-operation SKILL:177）；T7 红线「禁批量 tasks/cancel」（MEMORY:16：198×cancel 打挂服务+~90 孤儿 node）；冷启动付费（backlog 预热 idle 后深度空闲仍冷） |
| `hermes-agent` | adapter-agent-hermes（217+267 行）+HERMES-AGENT-PROVIDER.md | **B-/C+（真功能薄壳，安全面掉档）** | CLI 契约实测过（--help 核对，:31-38）；MCP 预注册幂等（init registrar，注册失败仅 warn 降级——降级=「hermes 仍能跑但无 VM 能力」，用户侧表现为委派空转）。**关键落差**：`runGoal` 直接 `new CliLlmBridge({...})`（index.ts:103-108）**不传 sessionConfig/不接 approvalCoordinator**，全文件 `grep -i approval` **0 命中** ⇒ 审批挂起/重放/真值反查对 hermes **不可得**；`--yolo` 跳过其自身审批（设计 §2.2 明言否则永久挂起）——L2/L3 在 hermes 委派下的完整生命周期**未见任何验证记录**（搜过 qa/r18、r19、docs/test/reports：真机闭环均为 workbuddy；hermes-provider.test.js 存在但为离线单测）。**该 provider 是三者中唯一「安全特性静默缺失」的一档，配置切换无任何告警** |

**默认选择合理性**：✅ 默认 deterministic（交付 config:12、core config:167、DEPLOYMENT §1.2）——零外部依赖、可审计，正确。
**切换体验坑**（切换=改 `.env` WINVM_VM_PROVIDER 重跑 setup.mjs，INSTALL-GUIDE:261）：
1. 切到 `workbuddy` 后**无预检**「VM 内 codebuddy 是否已装/已登录」（preflight.mjs 未覆盖该面；失败在首个委派才显形）；
2. 切到 `hermes-agent` **无审批/真值能力降级提示**（用户以为安全特性跟通道走，实际跟 provider 走）；
3. 现网实况与模板可以背离（phase1-t5-notes:337：模板 deterministic、`.env` workbuddy——以 .env 为准），新人按 README 理解会拿错口径。

**建议**：`/health.provider` 增 `capabilitiesProfile`（approvalResume: true/false、truthLayer: on/off、persistentSession: …）+ 切换时 install-vm 打印能力差集；SKILL（orchestrator「provider 与功能子集对照表」）补一行「安全特性随 provider 变化」的事实源。

---


## ④ 一键部署双端体验 · 部署断点清单

**名义路径**：`cp .env.example .env` → `node delivery/setup.mjs`（dry-run）→ `--apply`（BUILD→HOST→VM→VM-START→TUNNEL→TEST→HEALTH 七相位，DEPLOYMENT §1）+ `delivery/bootstrap.mjs check|trust|env|all` 前置（README §5.2）。
**实际从零到「能操作 VM」的完整步数**（按 INSTALL-GUIDE §1-§6 + 本次代码核对汇总）：**手工步骤 ≈ 10~13 步**，其中真正自动化的只有 setup 七相位。逐条断点：

| # | 断点 | 现状 | 手工动作 | 建议自动化路径 |
|---|---|---|---|---|
| DB-1 | VM OpenSSH Server | 纯手工（INSTALL-GUIDE §1.1：设置→可选功能） | 装+`Set-Service sshd -StartupType Automatic` | 若 VM 有管理员凭据，`install-vm`/bootstrap 可加 `--ensure-sshd`（`Add-WindowsCapability OpenSSH.Server`），失败再退回指引 |
| DB-2 | VM 防火墙 22/18443 | 纯手工两条 `New-NetFirewallRule`（§1.2） | 复制执行 | 同脚本化（与 DB-1 一个 preflight 批） |
| DB-3 | VM Node ≥18 | 纯手工下载安装、且强调「务必系统级 PATH」（§1.3） | 下载+勾选 PATH | bootstrap `check` 已探测缺失（preflight `checkLocalVmDeps` blocking），但无「远程静默装 node」通道；建议给 winget 路径（VM 内 `winget install OpenJS.NodeJS.LTS` 一条命令即可，能力自洽——用本插件自己的 app 域装机能力喂自己，dogfooding 且零新依赖） |
| DB-4 | codebuddy CLI 装+**登录** | §1.4 手工 npm 全局装；登录必须交互（微信/GitHub） | 交互式登录**无法脚本化** | 结构性保留手工，但应把「provider=workbuddy 且未登录」做成 **setup 尾 PHASE 的显式判据**（现在只在首个委派时才暴露为 LLM_SESSION/ENOENT），bootstrap.check 可远程 `codebuddy --version`+登录态探测，红字提示「你现在是 deterministic，切 LLM 需登录」 |
| DB-5 | 关 VM 睡眠/屏保 | 纯手工「设置→电源→从不」（§1.5）；MEMORY PM-10 同案 | 复制执行 | `powercfg /change standby-timeout-ac 0` 等三条命令即可挂进 install-vm（低风险、可回滚）；**ARCHITECTURE §6.3 的 session-guard 六机制（自动登录/tscon/禁休眠）在代码里不存在**（全仓 grep `tscon` 仅 tsconfig 误命中、无 Autologon 生成代码）——NFR-502「会话挂起自动检测**并恢复**」承诺与 ARCHITECTURE 架构图行仍是**未划线的过度声明**（对比：快照口径 P2-T3 已做划线诚实化，此处应同批处理） |
| DB-6 | Defender 排除 | 有现成脚本 `delivery/tools/add-defender-exclusions.ps1`，但要**人工 scp + VM 内管理员执行**（§1.6） | 两步手工 | setup.mjs VM 相位可经 ssh 以管理员令牌直推（脚本本身幂等）；至少做成 `setup.mjs --defender-exclusions` 旗标 |
| DB-7 | 宿主隧道守护 | 已高度自动化：install-host 尾自动拉起（§7.1①）+ SessionStart hook 幂等 ensure（hooks.json）+ daemon 断线退避重连；**残余风险**：daemon 整体死亡需手工复活配方（MEMORY:26；本机靠用户侧 HOURLY 自动化 `aaa87da4` 兜底——**该自动化不在交付物里**，别的用户没有） | 死隧道时人工 `winvm-plugin tunnel start` | 把「watchdog」做成交付品：install-host 注册宿主侧定时任务/或在连接器加载路径内做被动 ensure（现 hook 只在 SessionStart 触发，会话长跑期间 daemon 死=到下次会话才自愈） |
| DB-8 | 插件缓存需实跑 install-host | 已知痛点（MEMORY:9「宿主插件缓存=运行态真相源」）：改了 dist 不重跑 `install-host.mjs` 就不生效；无自动同步 | 手工重跑 | 开发期可加 `npm run dev:sync` 薄脚本；面向最终用户无影响 |
| DB-9 | 连接器注入≠已连接 | §8.1：页面「已连接」读全局 mcp.json、会话工具面读**账户级** mcp.json，两者独立；旧会话永不热注入（平台行为） | 新开会话+连接器页信任/启用+必要时重跑 install-host；有 `diagnose-connectors.mjs` 兜底诊断 | 属平台缺陷，插件侧已尽力（诊断器+文档）。产品面建议：install-host **收尾自动跑 diagnose** 并在输出里打印「请新开会话验证」检查项（现收尾不校验账户级条目齐备=已知根因 H1） |
| DB-10 | VM 服务计划任务 GUI 会话落点 | schtasks /run 经 SSH **不保证落交互会话**；锁屏=degraded（DEPLOYMENT §1.3 两大警告块）；setup 检测到 interactive=false 会打印手工重启配方但**不能替用户做** | RDP 登录 VM 桌面/解锁+交互式会话内重启服务 | 与 DB-5 同根（会话治理缺失）。中期方案：install-vm 生成 LogonTrigger 已在任务 XML 内置（推荐路径✅），再加「VM 内一次性 `tscon` 归还 console」配方脚本；文档把「锁屏→GUI 全灭」写进 USER-MANUAL 首屏 |
| DB-11 | psmod 改动需重启服务 | 已文档化（§8 排查表），`kill-restart.ps1` 现成 | 手工跑 | 可接受；建议 deploy-vm.mjs --apply 尾部自动 kill-restart（若已如此则忽略——未找到自动接线证据） |
| DB-12 | 卸载对称性 | `uninstall.mjs`（936 行）与安装一一对应，含 `--vm` | 一条命令 ✅ | 无需改进（正例） |

**净评**：七相位一键部署骨架成熟（dry-run 唯一入口、幂等、自检带 /health 打印——这是加分项）。但**前置环境 6 项全手工**（DB-1/2/3/4/5/6），把「一键」实际变成了「一晚上」；对目标用户（想拿 VM 干活的 WorkBuddy 用户而非运维工程师）是首旅程最大流失点。**最可执行的收口**：一个 `bootstrap.mjs prepare-vm --apply`（ssh 通道内批量做 DB-1/2/5/6+可选 DB-3），把纯手工从 6 项压到 1 项（codebuddy 登录）。

---


## ⑤ 用户可见 UX 缺口清单

| # | 缺口 | 现状（已做/未做） | 用户实际感知 | 证据 |
|---|---|---|---|---|
| UX-1 | 审批卡体验 | ✅ CL-016 载荷七槽位等价 + CL-021 `show_widget`+`AskUserQuestion` 两段式原生渲染（orchestrator SKILL:272-310，approval-card.ts 821 行模板） | 良好，但**仅覆盖 A2A 通道**；MCP 直调审批走不通（§2.2-1），用户在直调场景只会反复收到「需审批」 | docs/changes/CL-021、approval-card.md |
| UX-2 | 审批**有效期不可见** | ❌ 七槽位无 TTL/截止时间；超时按 `failed` 收口并带 `approvalTimeoutMessage`（task-store.ts:515-527 文案含 ttlMs），但卡片与降级模板都不预告窗口 | 用户离席回来只见「失败/超时」，不知窗口多大，重试再挂起（旧 PM-11 未收口） | approval-card.md §4 槽位表无有效期行；REQUIREMENT CL-016 §7 拒绝路径「无专门已拒绝文案」同类 |
| UX-3 | fail-closed/UNKNOWN 态呈现 | ⚠️ 半做：P2-T9 给 /health 加 `probeError`/`probeErrorCode`（PROBE_TIMEOUT/PROBE_EXCEPTION/PROBE_NOT_WIRED，HOST-A2A §8），服务端 `guiAllowed` 两 false 都拒（PR8 纪律✅）；**但 skills/USER-MANUAL 全文无一处教用户/Agent 读 probeError**（grep `probeError` 在 skills 0 命中） | 「未知态」与「确不可用」在用户面仍是同一种失败；Agent 拿到的错误文案=会话不可用，不会提示「探测超时、可重试」 | grep 证据：skills/ 与 USER-MANUAL.md `probeError|未知态|UNKNOWN` 0 命中；mcp-reference:83 十码表含 SESSION_UNAVAILABLE 无「未知」语义 |
| UX-4 | 锁屏/GUI 不可用闭环 | 检测✅（Get-SessionHealth 四态+中文 detail，gui.ps1:65-85）；错误码可重试✅；**恢复❌**：无 tscon/禁休眠/自动登录任何实现（ARCHITECTURE §6.3 六机制纯文档，代码 grep 0 命中），恢复全靠人 RDP 解锁 | 「明明昨天还能截图，今天全黑」→ 只能靠用户自己发现是锁屏；`locked` 布尔在位但 SKILL:33 只有一句「先解锁」，无引导动作（如何远程解锁/谁去解锁） | MEMORY GUI 可用性成因行、DEPLOYMENT §1.3 两大警告块（诚实）、DB-5/DB-10 |
| UX-5 | 长直调无进度 | ❌（见 §2.1 进度行）：600s 能力（winget install/uninstall、workflow.run）期间宿主零反馈；delegate 侧 `timeoutMs` 有默认+`timedOut` 分级文案（tools.ts:440-493 ✅），直调侧无任何对应物 | 「插件卡死了」是首周用户最高频误判；与「最可靠」卖点直接冲突 | grep notifications/progress 0 命中 |
| UX-6 | 错误呈现基座 | ✅ 强项：封闭 10 码 + retryable 表 + `error.details{missing,unknown,allowed}` 参数纠错三件套（mcp-reference:120/:83；D24/D25/D26 纵深）；SKILL 教「看 details」 | 良好——这是全仓 UX 文档化最好的一块，保持 | cl017 系列测试、SKILL 各「看 error.details」行 |
| UX-7 | 用户入口文档过时 | ❌ USER-MANUAL（91 行，末次实质更新=Phase0 止血 9dd13bd）仍写：「5 个 Skill」（实 7）、`tasks/send`/`tasks/resubscribe`（服务端显式拒绝旧名，a2a-framework/server.ts:195）、手工 `ssh -f -N -L`（与 orchestrator「不得手工」冲突）、`requiresApproval:true`（非实现字段形态）；PM-22 的整改未发生 | 唯一「说人话」的文档全是过期地图；README/INSTALL-GUIDE 虽准但面向工程师 | 上列逐行 |
| UX-8 | 拒绝路径呈现 | ⚠️ K5 后拒绝/超时零重放 fail-closed ✅（approval-card.md:169），ARCH-05 决策三态入链 ✅；宿主面「已拒绝、未执行」专门文案仍依赖 delegate 分级终止文案的 rejected 分支（tools.ts:482 起，已做）——但 **MCP 直调拒绝无任何呈现面**（令牌被清扫=静默过期，链上有 timeout 决策、用户无回执） | 与 §2.2-1 同根：直调审批体验整体不可用 | pending-approvals.ts:195 清扫、server.ts:1613 recordDecision |
| UX-9 | 直调「叫停」无回执（21:20 新增） | ❌ MCP 面无取消发起面：标准 `notifications/cancelled` 被并入空实现分支（mcp-framework/server.ts:177-180 `return null`），全仓 cancel 命中面**全部在 A2A 侧**（client.ts:184 / a2a server.ts:210,467 / task-store.ts:113,355）；直调只有「宿主断连」这一条隐式路径 | 用户对长直调说「停」时没有可执行的停止动作；即便断连生效，也收不到委派侧那种「取消前已发起 N 次调用、产出 M 个产物」的交代（`executedBeforeCancel` 无直调对应物） | §2.1 取消行 + §2.2-2；修复路径已明：接 `notifications/cancelled` → abort 在途 signal，复用 ARCH-29 消费链与 `CANCELED_TEXT`/`TASK_CANCELED`，零新契约码 |

---

## ⑥ 需求池差距分级（在册未修项 × 产品视角）

> 口径：**P0=直接损害对用户的成品承诺兑现**；**P1=承诺仍可兑现但体验/信任受损**；**P2=工程内债/验证面**。既有裁决（Q1=(b)、Q2 快照）按「已裁断」单列，不再翻案。
> **终版台账（21:43，本表定级经五处复核后的最终形态）**：**P0×4**＝直调审批闭环（§2.2-1，出路建议 (c) 策略化）／`bootstrap prepare-vm`（§4 DB-1·2·5·6）／生产就绪包-3a 最小修（§3+§1.4）／**文档诚实化两处**（本表 session-guard 行 + SKILL 直调续跑指令标注，零代码）。**P1×6**＝挂载 4 条已实现写侧／**接 `notifications/cancelled`（本表末段新增，全案最高性价比）**／provider 能力差集显形（hermes 静默降级）／USER-MANUAL 重写／审批卡 TTL 第八槽＋直调拒绝回执（UX-2/UX-8）／生产生态包-3b。**P2**＝预热 idle／SessionHealth 未知态话术一行／真机 GUI 解锁回归批／T13 断片／直调无进度中期透传／maxRisk 注记／CLI `audit tail|verify`。**已裁断待销账 3 项**＝D-3（Q1=b）／R4（T5·T6 已交付）／K3 主体（仅剩 text-fallback 命中率监控）。

| 项 | 在册位置 | 核实状态（本次代码复核） | 分级 | 产品判断与建议 |
|---|---|---|---|---|
| **MCP 直调审批续跑断裂（A5）** | MEMORY:35「rejected 置位路径真机不可达」；qa/r19/r1-forged-resume.resp.json | **仍在，且已由静态证据链闭合为可判定**（§2.2-1 复核加固：`raise` 生产调用点全仓仅 bridge.ts:1232；无任何 MCP/admin 批准入口；`listPending` 零调用点）。**爆炸半径已收缩**：仅影响「直调 × L2/L3(7+1 条) × 非 dryRun 免批(5 条)」组合；默认 provider 5 模板全 L0/L1 **不触闸**，故开箱形态不撞 | **P0**（定级不变：文档承诺失实 + 按文档操作必死循环；排期叙述须带上述限定，勿夸大首日流失） | 立项收口，三选一（**建议 (c) 优先**）：(a) 新建「无任务态令牌批准」入口（注意 `approval.reply` 现形 `required:['taskId',…]`，直调无 taskId ⇒ 不是复用而是新建，且须同步改 `k5-replay.test.js:890-892` 三条源码守卫）；(b) 话术诚实化——SKILL/mcp-reference 删直调续跑指令、改「转委派审批」；(c) 策略化——纯直调命中的 L2/L3 在服务端判「须走委派」（同时解掉 `maxRisk` 自报=安全边界的信任错位）。**本轮必须定一个**——文档教做、实现做不了，是当前全仓最高危承诺矛盾 |
| **「生产活动」缺预装/模板生态**（21:25 定级判据已自查，见下行） | 无在册（本次新增，PM 审计 §1.4） | 能力驱动器全在（appops 5 条非空壳：`state.query`/`cli.invoke`/`workflow.run`/`com.automate`/`gui.produce`，definitions.ts:352-451），但无生产应用预检清单、无 workflow 模板库、素材无输入通道（PM-09 复核：`Write-TextFileContent` 无 base64 入参，storage.ps1:136-158，未修） | **P0**（拆两阶见下行） | 交付「生产就绪包」：bootstrap 加 `prepare-apps`（用自家 winget 能力装 ffmpeg/magick/soffice+pandoc 并验 CLI）；file.write 补 asBase64（与读对称，零契约风险）；随包发 3~5 个示范 workflow 脚本进 WinVMWorkspace/workflows，让 workflow.run 从空壳变实指 |
| └ **定级判据核实**（对外到底有没有承诺「生产」开箱可用？这是 pm2 该不该把我 P0 打回 P1 的关键，我已自查） | README:3「安全、可控、可审计地**完全操作**一台 Windows 虚拟机——覆盖系统管理、应用管理、存储管理、GUI 自动化与**图形化生产操作**」；README:16「**完全可操作**：几乎覆盖所有 Windows 事务——系统／应用／存储／GUI／图形化生产」；README:44「`appops`｜用 Photoshop/Office/ffmpeg/IDE 等软件**把活干出来**」；ADR-9（README:168）专列 appops 为第五能力域 | **承诺确凿写在对外头条**（README 首段+能力总表两处），不是「路线图未承诺」⇒ **不可整体降 P1**。但同时核实到：`appops.cli.invoke`（L1，app enum=ffmpeg/magick/soffice/pandoc/node/python/custom，:373-394）在应用预装后**经直调可真实出活**；断链只发生在「默认 provider 委派 → 模板 5 → 硬编码 `generic_production`」这条**默认唯一通向承诺的路径**上。失败文案（index.ts:653-661）诚实给出两条解法 ⇒ **不是不实陈述，是「默认配置不可兑现承诺」**（性质不同于 session-guard 那条失实，定级理由在此） | **P0-最小修（成本极低，二选一即闭环）**：① 模板 5 改「先 `appops.state.query` 预检 → 命中已装 CLI 应用即走 `appops.cli.invoke`」（能力现成，纯 provider 编排改动，不动契约）；② 或诚实收缩——默认模板面明确「生产活动需切 LLM provider 或走直调编排」，并在 README:3/:16 给「图形化生产」标注可达条件（照 Q2 快照划线打法）。**P1-生态包（增值，不阻塞承诺兑现）**：`prepare-apps` 预检装机、示例 workflow×3-5、`file.write asBase64` |
| **session-guard 恢复机制 = 文档幻影** | ARCHITECTURE §6.3 六机制表、NFR-502「检测并恢复」、README 高危排查表 | 探针/降级门✅（health.ts 141 行、guiAllowed）；tscon/自动登录/禁休眠❌（grep 0 代码命中）；INSTALL §1.5/§1.6 仍让用户手工 | **文档整改 = P0（零代码、当轮必做）**；**功能实现 = P1**。此非自相矛盾，判据是「失实承诺是否诱使用户做出错误决策」：NFR-502「自动检测并**恢复**」+ §6.3 六机制表被读成「锁屏/睡眠会自愈」⇒ 用户会不设自动登录、不做解锁预案，次日 GUI 全灭时手足无措（DEPLOYMENT §1.3 的诚实警告块与 README/NFR-502 互相打架，同一文档集内两种口径）。改口径零成本，故列 P0；真正落 tscon/powercfg 需 VM 侧改动，故列 P1 | 两阶：①立即把 NFR-502/ARCHITECTURE 该行改「检测+恢复指引」（同 Q2 快照的划线诚实化打法，snapshot-truth 有样板）——**与 §7-6 并为用户面最高性价比的一处**；②install-vm 落 `powercfg` 三件套（成本低、收益立现，DB-5） |
| **USER-MANUAL 系统性过时（PM-22）** | 2026-10-08 产品审计 PM-22 P1 | **仍在**（UX-7） | **P1** | 一轮重写（以 README §7 + mcp-reference 为底本）；这是所有「首日转化断点」的最便宜修复 |
| **已实现待挂载 4 条**（env 写/解压/剪贴板写/＋shortcut 文档反向滞后） | CAPABILITY-MODEL §3.1.2 表（口径诚实✅）；PM-04 | **仍在**（fn 绑定未变）；注意 app.shortcut.manage 实际已可创建（D8），文档低报 | **P1** | 一个 CL 批量挂载：写侧各加 policy（registry/env 白名单沿用）+ 同步 SKILL/MODEL 四处口径 + schema 写参数位与行为对齐；shortcut 仅需文档改口径。**零新 PS 代码，纯交付面收益** |
| **hermes-agent 安全特性静默缺失** | 无在册（本次新增，§3） | 无审批续跑/无真值反查/无常驻会话，切换零告警；`--yolo` | **P1（安全相邻，建议按 P0 排期讨论）** | provider 能力差集显形：/health.provider.capabilitiesProfile + install-vm 切换横幅 + orchestrator SKILL 对照表加「审批/真值随 provider」行 |
| **D-3 schema 运行期校验** | MEMORY backlog:47 | 已按 Q1=(b) **裁断为「不接运行期」**且落地为交付面资产+漂移钉（schema-check.ts 头注、phase2-contract-schema 23 例、CAPABILITY-MODEL §4 口径）——backlog 条目**已过期未销** | **P2（已裁决）** | 销账：MEMORY backlog 该行改「已处置（Q1=b，交付面校验+漂移钉），运行期接入经裁断不做」 |
| **K3 启发式兜底根治** | MEMORY:48 | 主体已根治：结构化 `reconcileApprovalTruth` 默认 on（G-a 已扩到 MCP 直调形态）；文本启发式**降为兜底且漏判边界已诚实钉死**（K5 §7 G-c，六反例） | **P2** | 剩余动作=监控 `decidedBy:'text-fallback'` 命中率（G-b 已可计数）→ 命中率归零后退役兜底。无需新代码立项 |
| **预热 idle 冷启动** | MEMORY:49 | 预热 K2✅、disabled 拒绝不静默✅、T9 `firstCallLatencyMs` 度量✅（只度量不优化）；深度空闲首调仍付费 | **P2** | 用度量数据决策（是否 idle 续签）；先别优化 |
| **SessionHealth 未知态** | MEMORY:50 | T9 已交付协议层（probeError 三码，两键缺席=真实）；**用户/Agent 读取路径未接**（UX-3） | **P2→P1 尾巴** | 补 SKILL 错误码表一行「probeError 在场=未知非不可用，可重试」，即闭环 |
| **真实 GUI 回归受锁屏限制** | MEMORY:51；phase2 §3.4 E-3 | lock-probe 门禁✅（UNKNOWN 绝不 GO），验证面仍欠 full GUI E2E（HOST-A2A §9 未验证项在位，诚实） | **P2** | 排一次「解锁桌面窗口」真机批（与 UX-4 恢复配方同批做，一举两得） |
| **R4 bearer 自检** | MEMORY:52 | **已交付**（T5 五码自检+fail-closed 拒启、T6 回连凭据通路+探针、真机四段实证） | ✅销账 | 改 MEMORY 措辞为「已修（T5/T6）」，防误读 |
| **T13 审计断片** | MEMORY:31 候选未定夺 | audit-20260918 断片在册（非篡改，entry#512 prevHash 指错）；verifyArchive 框架可承载 | **P2** | 一次处置批（归档标注+报告）；对用户无当下伤害，但对「最可监管」叙事的样本卫生重要 |
| 直调无进度（PM-20 同族） | §2.1/UX-5 | MCP progress 全仓 0 实现；SSE 服务端在、宿主桥未接（PM-20 在册未修） | **P2** | 短期话术（SKILL「直调长任务先告知用户预计时长」）；中期桥补 task.subscribe 透传或 MCP progress |
| 直调无面向用户的取消面（21:20 本次新增在册） | §2.2-2/UX-9；无既有在册条目（MEMORY backlog 未列） | `notifications/cancelled` 被吞（mcp-framework/server.ts:177-180）；全仓 cancel 发起面仅 A2A 侧；直调仅隐式断连路径、且无 `executedBeforeCancel` 类回执 | **P1** | 接 `notifications/cancelled` → 在途请求登记 + abort 复用 ARCH-29 链（§7-9a）。成本低（单文件、零契约码变更），属可当轮闭环的速赢；同时给直调取消补「已发起 N 次调用」文案，与委派侧口径拉平 |
| maxRisk 默认口径差异 | §2.2-3 | 在位 | **P2** | SKILL 一句话 + delegate 描述改「默认 L1，需 L2 请显式抬升」 |
| 审计可查面（PM-06） | 2026-10-08 审计 | `meta.audit.query` 已标 V2、USER-MANUAL §5 已诚实化（含「CLI 无 --audit」警示✅）；tail/verify 用户命令仍无 | **P2** | winvm-plugin 加 `audit tail/verify`（复用 chain.ts 校验，半小时工作量）即可兑现「事后可查」卖点话术 |

---

## ⑦ Top10 产品完善建议（按用户价值排序）

1. **收口 MCP 直调审批闭环（P0）**——三选一，**建议 (c) 策略化优先**（服务端事实取代调用方自报 `maxRisk`/`allowedCapabilities`，顺带解掉「最小权限」表述与实现语义之差；成本低于新建批准入口，且不动 `k5-replay.test.js:890-892` 三条源码守卫）；若做 (a) 新建入口须同步改守卫并处理 K5 §4 纪律 2 的放宽风险。同时给 approval-card.md/mcp-reference 的直调续跑指令加「当前可达性」标注。*用户价值：修掉「照文档做却永远批不下来」的信任核弹。限定（21:08 复核）：爆炸半径=「直调×L2/L3（7+1 条）×非 dryRun 免批」，默认 provider 不触闸 ⇒ 属深水区高危、非首日必撞。*
2. **`bootstrap prepare-vm` 一键前置（P0）**——ssh 通道内批量做 OpenSSH/防火墙/powercfg/Defender 排除（DB-1/2/5/6），手工项 6→1。*首日转化最大流失点，纯编排零新能力。*
3. **生产就绪包（P0，实证加强；21:25 补「最小修」分阶）**——
   3a **P0-最小修（当轮可闭，成本≈ provider 编排改一处）**：模板 5 由「硬编码 `generic_production`」改为**先 `appops.state.query` 预检、命中已装 CLI 应用即走 `appops.cli.invoke`**（两能力现成、L1 不触闸、零契约变更）；或反向诚实收缩——`UNSUPPORTED_GOAL`/README:3/:16 明确「图形化生产」的可达条件。判据已核实：README 首段与能力总表两处对外承诺「完全操作…图形化生产操作」，故**不能整体降 P1**；但失败文案本身诚实，性质是「默认配置不可兑现」而非「不实陈述」。
   3b **P1-生态包（增值）**：预检+装机清单 `prepare-apps`（ffmpeg/magick/soffice/pandoc）、示范 workflow×3-5、`file.write asBase64` 素材通道。*把「完整操作 VM 进行生产活动」从能力表兑现到成品路径。*
4. **挂载 4 条已实现写侧 + 反向修 shortcut 文档（P1 速赢）**——一个 CL、零新 PS 代码、对外净增 4 个可感知功能。*清库存即增长。*
5. **provider 能力差集显形（P1）**——/health.provider.capabilitiesProfile + 切换横幅 + SKILL 对照表（重点：hermes 无审批重放/无真值层）。*防「以为安全特性跟通道走」的静默降级。*
6. **USER-MANUAL 重写 + NFR-502/快照两处过度声明划线诚实化（P1）**——复制 P2-T3 snapshot-truth 的成功打法到 session-guard。*文档是产品，失实承诺比缺功能更伤。*
7. **审批卡第八槽「有效期」+ 直调拒绝回执（P1）**——TTL 数据源现成（metadata.approvalTimeoutTtlMs）；拒绝态两通道文案对齐。*离席回来的归因体验。*
8. **会话治理最小实现（P1）**——powercfg 三件套 + 「锁屏→GUI 全灭」首屏告知 + 远程解锁配方脚本。*把最高频环境故障从玄学变流程。*
9. **长直调体验包（P2 高配 → 建议拆出一项 P1 速赢）**——
   9a **（新增·P1 速赢）接通 MCP `notifications/cancelled`**：现被并入空实现分支（mcp-framework/server.ts:177-180 `return null`），改为登记在途请求并按 `requestId` abort 其 `signal`，即可复用 ARCH-29 已建好的 `req.signal → ToolContext.signal → ps-bridge` 消费链与 `CANCELED_TEXT`/`TASK_CANCELED` 码位——**零新契约、零新错误码、零 PS 代码**，直接把「用户说了停却停不下来」这条 P1 关闭。*这是本轮审计里性价比最高的一处（缺陷位置确定、消费链现成）。*
   9b （P2）SKILL 加「600s 级能力先行告知+建议拆步/改委派」话术；中期桥补订阅透传 / MCP progress notification。*消灭「卡死」误判周报。*
10. **能力自描述通道上线（P2 速赢）**——orchestrator SKILL 加「能力面问询先调 `meta.capability.list`」纪律 + 挂载四件后同步刷 SKILL 清单段。*让 Agent 的答案跟注册表同源，杜绝文案过期。*

---

## 附：审计方法与局限

- 全部结论基于 HEAD `13b8705` 工作区实读；「未找到证据」处均已列搜索面（如 notifications/progress、tscon、probeError-in-skills）。
- 行号可能随并行改动漂移，复核请用段标签/函数名（如 `VmApprovalCoordinator.raise`、CAPABILITY-MODEL §3.1.2）。
- 局限：① 未做真机动态验证（只读纪律），两通道对等性结论=静态可达性论证 + 仓内真机反证工件（r1-forged-resume）；② provider 真机对比样本仅 workbuddy（hermes/deterministic 委派真机报告未检索到，已如实标注）；③ qa/ 工件 400+ 文件仅抽查，未全量复核。

---

## 修订记录（2026-10-12 21:08–21:25，续棒冲突处置 + 五处复核精修）

**冲突处置**：续棒 `software-product-manager-2` 于 20:41 检出 `audit-pm.md` mtime 位移并按纪律停写、上报待裁（其 `audit-pm2.md` 现仅 §2 草稿）。因 §2–§7 已由我于 20:30–20:44 完整落盘，处置为：**`audit-pm.md` 单一所有权归我，`audit-pm2.md` 转为 PM 视角交叉验证稿**。全程未发生内容覆盖或互相回滚。

**交叉验证成立（两份独立审计同结论，可信度升级）**：
- 直调审批断裂——pm2 从「审批放行入口」切入、我从「hostApproved 唯一写点可达性」切入，同一 P0 判定与三条出路（其 ①(a)诚实化/(b)产品化/(c)策略化 ≡ 我 §6 (b)/(a)/(c)）。
- 审计查询面两通道共缺——pm2 §2.1 审计行与我 §2.2-5 独立同结论（已合并入正文）。
- 委派 `allowedCapabilities`/`maxRisk` 由调用方**自报**（HOST-A2A §4.2「最小权限」表述与实现语义有差）——与我 §2.2-3 同源，已并入 (c) 策略化出路。

**五处复核精修（第 1–3 项收窄/加固，第 4 项为新发现的高性价比 P1，第 5 项为两处定级判据自查闭环）**：
1. **§2.1 取消行：✅ → ⚠️ 三层拆分**。中止语义真对等（同一 `req.signal`、同一 `TASK_CANCELED`、§2.2.1 三纪律 + `phase2-mcp-signal.test.js` 假取消反证），但**触发面**（MCP 仅断连级，54 能力与 mcp-framework `cancel` 零命中）与**回执面**（委派有 `executedBeforeCancel{steps,artifacts}`，直调无对应物）不等 ⇒ 新列 §2.2-2 **P1**。
2. **§2.2-1 升为可判定并收缩爆炸半径**。`raise` 生产调用点全仓仅 1 处（bridge.ts:1232）；MCP/admin 无批准入口；`listPending` 零调用点；`approval.reply` 现形 `required:['taskId',…]` ⇒ 选项 (a) 属**新建**而非复用，且受 `k5-replay.test.js:890-892` 三条源码守卫约束。同时记：**风险分布 L0=27/L1=19/L2=7/L3=1（共 54），dryRun 免批恰 5 条**；默认 provider 5 模板 6 能力**全 L0/L1 永不触闸** ⇒ 开箱形态不撞此破口，撞上是「直调 L2/L3」与「切 LLM provider 后宿主直调」两型。**P0 定级不变，排期叙述须带此限定。**
3. **§3 默认 provider 补两条事实**：好消息=审批断裂面被 provider 选型天然规避（结构性：无 coordinator ⇒ 无回环）；坏消息=模板 5「生产操作」硬编码 `generic_production`，而**全仓零工作流实体**（`find -iname '*workflow*'` 空；2026-10-08 审计 :122 同记 `git ls-files` 空）⇒ **默认 provider + 默认镜像下「生产活动」必返 `WORKFLOW_NOT_FOUND`**。这是 §6/§7「生产就绪包 P0」的最硬实证。附带复核：`storage.file.write`（definitions.ts:313）无 `asBase64` 入参而 `file.read`/`screen.capture` 有 ⇒ 素材写入通道不对称（PM-09 仍在）；`storage.archive.manage` 描述「创建或展开 zip」而 `fn: 'New-ZipArchiveItem'` 仅压缩 ⇒ 名实差在册（§1 已记）。
   - **21:16 反证搜索已自行补做（三条兜底路径全部排除 ⇒ 结论加固，非撤销）**：① `appops.ps1:366-367` 只是「扫两个候选目录找工作流」，`:384` 未命中即抛 `WORKFLOW_NOT_FOUND`，**无内置/示例工作流分支**；② `delivery/*.mjs` 全量 grep `workflows` **仅** `uninstall.mjs` 命中且语义是「保留/清除 `C:/WinVMWorkspace`」（:93/:194/:571/:821-823），**install-vm / deploy-vm / setup.mjs 不种任何工作流文件**；③ `git ls-files | grep -i workflow` 空命中（exit=1，追踪面确认为零）。⇒「默认形态必空转」由单源 find 升为**三源交叉证实**。
4. **§2.2-2/UX-9/§6/§7-9a 新增一处「比预想更好修」的 P1（21:20）**：MCP 协议标准客户端取消通知 `notifications/cancelled` **被显式并入空实现分支**（`packages/mcp-framework/src/server.ts:177-180`，与 `notifications/initialized` 同 case 直接 `return null`）；全仓 `grep -i cancel` 的发起面**全部在 A2A 侧**（`a2a-framework/client.ts:184`、`server.ts:210/467`、`task-store.ts:113/355-357`），mcp-framework 只有收口文案 `CANCELED_TEXT`（:228/252/281）。⇒ 把「用户对长直调说停却停不下来」这条 P1 的修复压缩为「登记在途请求 + 按 requestId abort 其 signal」，**复用 ARCH-29 现成消费链，零新契约码/零新错误码/零 PS 代码**——本轮性价比最高的速赢，已列入 §7-9a。附带澄清：这**不**使 SECURITY-GOVERNANCE §2.2.1 成为失实承诺——它承诺的是「中止语义与收口口径一致」（真），而非「两通道都有取消触发面」；但 §2.2.1 表头「两条会触发『停止在途能力调用』的通道」容易被读成后者，建议加一句限定（话术面，非缺陷）。
5. **§6 两处定级判据自查闭环（21:25）**——把我先前标注「我给不出定论」而转给 pm2 的两个问题自己答掉，两处结论已改写进 §6/§7：
   - **「生产就绪包」该不该 P0？→ 该，但拆 3a/3b**。判据核实：README:3 首段「安全、可控、可审计地**完全操作**一台 Windows 虚拟机——覆盖…与**图形化生产操作**」+ README:16「**完全可操作**：…／图形化生产」+ README:44「`appops`｜…**把活干出来**」+ ADR-9（README:168）⇒ 承诺确凿写在对外头条，**不属「路线图未承诺」，不可整体降 P1**。但同时查明：`appops.cli.invoke`（L1，app enum 含 ffmpeg/magick/soffice/pandoc，definitions.ts:373-394）在应用预装后**经直调本可出活**，断链只在「默认 provider 委派 → 模板 5 → 硬编码 `generic_production`」这条默认唯一通向承诺的路径上，且失败文案（index.ts:653-661）诚实给出两条解法 ⇒ 性质是**「默认配置不可兑现」而非「不实陈述」**（与 session-guard 那条划开）。据此拆 **3a = P0 最小修**（模板 5 改「先 `appops.state.query` 预检 → 命中即走 `cli.invoke`」，纯 provider 编排、零契约变更）、**3b = P1 生态包**（prepare-apps 装机、示例 workflow×3-5、`file.write asBase64`）。
   - **「文档 P0 级失实 / 整改 P1」是否自相矛盾？→ 不矛盾，且已把文档整改提为 P0**。判据=「失实是否诱使用户做出错误决策」：NFR-502「自动检测并**恢复**」被读成「锁屏/睡眠会自愈」⇒ 用户不设自动登录、不做解锁预案，次日 GUI 全灭手足无措；同一文档集内 DEPLOYMENT §1.3 的诚实警告与 README/NFR-502 互相打架，本身即口径缺陷。改口径零成本 ⇒ **文档整改 P0 / 功能实现（tscon·powercfg）P1**（§6 session-guard 行已按此重写）。
   - **P0 台账净变化**：① 直调审批闭环（建议出路 (c) 策略化）② `bootstrap prepare-vm` 一键前置 ③ 生产就绪包-3a ＋ **文档诚实化两处**（NFR-502/ARCHITECTURE §6.3 划线；SKILL/mcp-reference 直调续跑指令加可达性标注）。**P1**：挂载 4 条已实现写侧／**接 `notifications/cancelled`（本轮新发现）**／provider 能力差集显形／USER-MANUAL 重写／审批卡 TTL 第八槽＋直调拒绝回执／生产生态包-3b。

---

## ⑧ Phase 3 批次候选表（产品维交付给主理人的排期原料 · 21:35）

> **口径**：本表把 §6 全部在册条目（P0/P1/P2 + 已裁断销账）重组为**可独立验收的批次**，每批给「收录条目 / 建议顺序 / 依赖关系 / 预估改动面（文件数级）/ 验收判据」。**最终排序与取舍裁断归主理人**——我给的是产品价值序与依赖约束下的建议，不是结论。
> **条目编号**：沿用 §6/§7，格式 `#<§7 序号>-<§6 关键词>`；无 §7 对应的在册 P2 用 `BL-<§6 行关键词>`。
> **通用验收前置（每批皆适用，不逐行重复）**：`npm run gate`（FULL：ST1 tsc + ST2 dep-lint + ST2b config-key-lint + ST3 守卫件 + ST4 sweep）绿；提交前跑 `npm run gate:quick`；sweep 汇总行落 `qa/r20-<批次>-sweep-result.txt` 并同步 MEMORY 基线口径行（当前 **92 文件 / 1889 例，1857 pass / 0 fail / 2 skip=ssh2-resolve OFFLINE_SKIP**）；`scripts/GATE-POLICY.md:11`「**跳过门禁即未验收**」= 本表所有批的硬门槛；涉及分层改动者 `npm run layout`（dep-lint）须维持 hard 0 / warn 0。

### 8.1 批次表

| 批次 | 收录条目（§6/§7 编号） | 建议顺序 | 依赖关系 | 预估改动面 | 验收判据（门禁 + 测试口径） |
|---|---|---|---|---|---|
| **批 0 · 文档诚实化止血** | `#6-USER-MANUAL 重写`；`BL-session-guard 文档`（ARCHITECTURE §6.3 六机制 + NFR-502「自动检测并恢复」）；`BL-MEMORY 销账`（D-3=Q1(b) 已处置、R4=已修 T5/T6）；`BL-SessionHealth SKILL 行`；`BL-maxRisk 话术` | **第 1 批（零代码、零风险、当轮必做）** | **不依赖任何件，可并入任意批**；但 `#1-审批闭环` 若选 (b) 话术诚实化或 (c) 策略化，其「删直调续跑指令」段**必须与本批同窗口**，否则文档改两遍 | ≈ 7 文件（纯 docs/skills：README、REQUIREMENTS、ARCHITECTURE、USER-MANUAL、MEMORY、mcp-reference SKILL、orchestrator SKILL） | ① `grep -rn "tscon\|自动恢复" docs/02-design/ARCHITECTURE.md docs/01-*` 无残留「已实现」口径（改「检测+恢复指引」，照 `phase2-snapshot-truth.test.js` 承载的 Q2 划线打法）；② **建议新增 1 条静态守卫件**入 `GATE_GUARD_FILES`（防「划线诚实化」被后续 PR 悄悄改回宣称实现——快照口径已有同型先例可抄）；③ USER-MANUAL 中 `tasks/send`/`tasks/resubscribe`/手工 `ssh -f -N -L`/`requiresApproval:true`/「5 个 Skill」五处 0 命中（以 `agent/card` + 实际工具面重写，7 份 SKILL 计数对齐）；④ SKILL 增 `probeError` 一行「在场=未知非不可用，可重试」+ delegate 描述增「默认 L1，需 L2 显式抬升」 |
| **批 1 · MCP 直调审批闭环收口（P0）** | `#1-审批闭环`（出路三选一，**产品建议 (c) 策略化**）；`#7-审批卡第八槽 TTL`（与拒绝回执同域）；`BL-直调拒绝回执` | **第 2 批**（P0 台账首位，深水区高危非首日必撞，勿按「首日转化」叙事插队到批 2 之前） | (i) 与批 0 的续跑话术段**互斥共改**（见批 0）；(ii) `#7` TTL 槽数据源现成（`task.metadata.approvalTimeoutTtlMs`，server.ts:414-416 已入链），**不依赖本批**可拆给任意批；(iii) 若选 (a) 新建批准入口 ⇒ **硬依赖**：`approval.reply` 现形 `required:['taskId',…]` 而纯直调无 taskId（须新建形态），且**必须同批改** `tests/unit/k5-replay.test.js:890-892` 三条源码字符串守卫 + 处理 K5 §4 安全纪律 2 放宽风险 ⇒ (a) 成本最高、(c) 最低 | (c)：≈ 6 文件（`vm-service/src/server.ts` 闸 + 策略/契约注释 + `host-a2a-bridge/src/tools.ts` 文案 + SKILL×2 + docs×1 + 测试×1）；(a)：≈ 10 文件（另加 `contracts/src/bridge.ts` 接口 + `k5-replay.test.js` + `assembly-guard.test.js`） | ① **可达性判据（可证伪）**：新增用例断言「纯 MCP 直调命中 L2/L3（非 `supportsDryRun`）返回的终态码 + `resumeHint` 在本批后**指向一条真实可达路径**」——(c) 形态=返 `POLICY_DENIED`+「须走委派」并落 `blocked` 入链；(b) 形态=返 `APPROVAL_REQUIRED`+`resumeHint` 文案改为委派指引且 SKILL 无直调续跑指令；② **反证复跑**：`qa/r19/r1-forged-resume.req.json/resp.json` 同型场景在新口径下结果与文案一致（不得再出现「重发 `__approvalId` 又拿新 approvalId」的误导组合）；③ **集合钉不得漂移**：`tests/unit/p0-path-traversal.test.js` 的 `supportsDryRun` 恰 5 条集合断言保持绿（若 (c) 需要改集合，改动须在 PR 描述里显式声明理由）；④ 契约码保真 `phase2-contract-code-fidelity.test.js` 绿（拒绝/未决不得被压平成 `EXECUTION_FAILED`，否则 `shouldDegrade` 重跑红线）；⑤ 若改 `hostApproved` 相关源码形态 ⇒ `k5-replay.test.js` + `assembly-guard.test.js` 同步更新并全绿（守卫红=门禁红，不许「先跳过后补」） |
| **批 2 · 默认可达路径（部署 + 生产）** | `#2-bootstrap prepare-vm`（DB-1/2/3/5/6）；`#3a-生产路径最小修`（模板 5 先 `appops.state.query` 预检 → 命中走 `appops.cli.invoke`）；`#8-会话治理最小实现`（install-vm 落 `powercfg` 三件套 + 锁屏→GUI 全灭首屏告知） | **第 3 批**（**用户旅程第一位**：这三条决定「装好当晚能不能干活」；若主理人按首周体验重排，本批可提到批 1 之前，代价是 P0 文档矛盾多留一窗） | (i) `#8` 与 `#2` **同文件域**（`delivery/install-vm.mjs`）⇒ **强烈建议同批**，省一次真机回归窗口；(ii) `#3a` 与 `#2` **弱依赖**：预检逻辑若复用 prepare-vm 的 bootstrap 骨架更省（否则各写一份探测）；(iii) `#3a` 不依赖批 1（默认 provider 全 L0/L1 不触闸，见 §3 补充复核）；(iv) 批 5 的「真机 GUI 回归批」**依赖本批 `#8` 先落地**（否则回归期间又锁屏白跑） | ≈ 11 文件（`bootstrap.mjs`、`install-vm.mjs`、`preflight.mjs`、`setup.mjs` 相位表、`adapter-agent-workbuddy/src/index.ts` 模板 5、docs×3：INSTALL-GUIDE/DEPLOYMENT/SCENARIOS、测试×2-3） | ① **手工项计数判据**：INSTALL-GUIDE §1 手工前置从 6 项（sshd/防火墙/node/睡眠/Defender/登录）降为 **1 项（codebuddy 登录，结构性不可脚本化，DB-4）**，且文档逐处标注「已由 `prepare-vm --apply` 接管」；② `setup.mjs` dry-run 输出含新相位（`prepare-vm` 幂等：连跑两次第二次全 `[SKIP]`）；`delivery/setup.mjs` 现「dry-run 默认 + `--apply` 唯一执行入口」纪律不得破坏（DEPLOYMENT §1）；③ **生产路径可达判据（可证伪）**：离线单测断言「默认 provider + 无 workflows 目录 + 已装 ffmpeg」场景下模板 5 走 `appops.cli.invoke` 而非直接 `WORKFLOW_NOT_FOUND`（`find -iname '*workflow*'` 全仓仍空命中不构成失败）；④ `powercfg` 三件套落地后 `Get-SessionHealth` 在真机返回 `state:'healthy'` 且 `locked:false` 的**留痕**（qa 工件，DB-5/DB-10）；⑤ dep-lint hard 0 / warn 0（delivery 不进包依赖图，注意 `layout` 无新增违规） |
| **批 3 · 速赢拼装（高性价比 P1 集中营）** | `#9a-接 notifications/cancelled`；`#4-挂载 4 条已实现写侧`（env 写/解压/剪贴板写 + shortcut 文档反向修正）；`#5-provider 能力差集显形`（hermes 静默降级） | **第 4 批**，但**内部三项彼此独立、可整项前插任意批**（文件域互不重叠：mcp-framework / vm-capabilities 注册表+SKILL / vm-service health+install-vm 横幅）。**产品特别提示：`#9a` 是本轮性价比之最**（缺陷位置确定 `mcp-framework/src/server.ts:177-180`、消费链现成、单文件 + 零新契约码/零新错误码/零 PS 代码） | (i) `#4` 与 `#11-能力自描述`（SKILL 清单段刷新）**建议同批**（同一份 SKILL 文件改两遍不划算）；(ii) `#4` 挂载写侧依赖「写侧 policy 设计」（env/registry 白名单沿用既有），**不改 `supportsDryRun` 集合**（若某新挂载项要声明 dry-run ⇒ 触发 `p0-path-traversal.test.js` 集合钉，须显式申报）；(iii) `#5` 与批 0 的 `probeError` SKILL 行**同文件域**（错误码/健康表）⇒ 可合并省一次改动 | ≈ 15 文件（`mcp-framework/src/server.ts` + 新/扩取消测试；`definitions.ts` fn 绑定×4 + `CAPABILITY-MODEL §3.1.2` + SKILL×3 + schema 写参数位；`/health.provider.capabilitiesProfile` + install-vm 切换横幅 + orchestrator SKILL 对照表） | ① **取消面判据（可证伪）**：`notifications/cancelled{requestId}` 到达 ⇒ 在途 `tools/call` 的 signal 被 abort、返 `CANCELED_TEXT` + `structuredContent.canceled:true, inFlightMayContinue:true`（与 server.ts:252-253 既有形态逐字一致）；**假取消反证不得回归**（`tests/unit/phase2-mcp-signal.test.js` 既有的「响应已写完 `writableEnded===true` 绝不 abort」必须仍绿）；stdio/未接断连调用方「缺席即旧行为」保持（`ToolContext` 键集不因本批扩张，§2.2.1 末段纪律）；② **挂载判据**：注册表 `fn` 与 psmod `^function` 交叉核对**零未挂载**（我 §1 的同一 grep 面：`Set-EnvironmentVariableInfo`/`Expand-ZipArchiveItem`/`Set-ClipboardTextValue` 由「已实现待挂载」转为已绑定；`Get-ShortcutInfo` 文档口径改为「支持创建」）；对外能力数口径 54→（若新增 id）或保持 54（若只换 fn 绑定），SKILL/README/CAPABILITY-MODEL 三处计数**同源一致**；③ **provider 差集判据**：`/health.provider.capabilitiesProfile` 输出含 `approvalResume/truthLayer/persistentSession` 三键，切到 `hermes-agent` 时 install-vm 打印**降级横幅**，且 orchestrator SKILL 对照表有「审批/真值随 provider 变化」一行（消除 §3「用户以为安全特性跟通道走」的静默降级）；④ `phase2-contract-schema.test.js` 绿（schema↔TS 漂移守卫，Q1=(b) 裁决的交付面强制力面）；⑤ 基线只增不减：新增例后 sweep 汇总行 ≥ 1889 且 0 fail |
| **批 4 · 增值生态与长任务体验** | `#3b-生产就绪生态包`（`bootstrap prepare-apps` + 示例 workflow×3-5 + `file.write asBase64`）；`#9b-长直调话术/进度`（SKILL 先行告知 + 中期 `task.subscribe` 透传 / MCP progress）；`#12-审计查询面`（`winvm-plugin audit tail/verify`，复用 `chain.ts`）；`#11-能力自描述通道`（若未随批 3） | **第 5 批**（P1 增值 + P2，不阻塞任何既有对外承诺；但 `#12` 半小时级工作量可随手塞进任意批） | (i) `#3b` **依赖批 2 的 `#3a` 先落地**（先把默认路径接通再谈生态，否则「示例工作流」是给一条本来就不通的路加装饰）；(ii) `#3b` 的 `prepare-apps` 与批 2 `#2` **同一 bootstrap 骨架**（同域复用）；(iii) `#9b` 进度透传**依赖架构维裁决**（MCP progress vs A2A `tasks/subscribe` 桥接，属主理人/架构选择，产品不设偏好）；(iv) `file.write asBase64` 与 `file.read` 对称（零契约风险，PM-09 收口） | ≈ 12 文件（`bootstrap.mjs` prepare-apps、`WinVMWorkspace/workflows` 示例×3-5（新落盘实体）、`definitions.ts` file.write 参数位 + `storage.ps1:136-158` base64 分支、SKILL×2、`winvm-plugin.mjs` audit 子命令、docs×2） | ① **「默认形态必空转」彻底销证判据**：本批后 `git ls-files | grep -i workflow` **不再空命中**（当前 exit=1，§修订记录 5 三源证实），且 `install-vm`/`deploy-vm` 有把示例工作流**种进 VM** 的实际接线（当前仅 `uninstall.mjs` 命中 `workflows`，语义为 keep/purge，`:93/:194/:571/:821-823`）；② `appops.workflow.run` 直调示例工作流成功产出 artifact 的**离线用例 + 真机留痕各 1**（不再 100% `WORKFLOW_NOT_FOUND`）；③ `file.write asBase64` 与 `file.read asBase64` 往返一致用例（同图字节级回环），且读侧既有行为零回归；④ **审计查询判据**：`winvm-plugin audit tail`/`audit verify` 可用，`verify` 复用 `chain.ts`（含 T13 断片处置后对 `audit-20260918` 的标注一致），USER-MANUAL §5「CLI 无 --audit」警示**随之改写**（否则新造假实）；⑤ prepare-apps 幂等 + 失败不静默（缺 ffmpeg/magick/soffice/pandoc 时显式列表 + retryable 语义，对照 K-N1「disabled 拒绝不静默」既有纪律） |
| **批 5 · 验证面、卫生与观察项（P2 / 已裁断）** | `BL-T13 审计断片处置`；`BL-真机 GUI 回归批`（E-3 解锁窗口，HOST-A2A §9 未验证项）；`BL-K3 兜底命中率监控`（`decidedBy:'text-fallback'`，G-b 已可计数）；`BL-预热 idle 冷启动`（先度量后优化，T9 `firstCallLatencyMs`）；`BL-D-3 销账`（已随批 0） | **第 6 批（最后）**，但 `BL-真机 GUI 回归批` 的执行时点**依赖批 2 `#8`**，需提前排人/排窗口（代码可后合，验证窗口先占） | (i) GUI 回归依赖批 2 的 powercfg/解锁配方（见批 2 依赖 iv）；(ii) K3 兜底退役**依赖命中率归零**（观察期，非开发任务）⇒ 本批只做「登记观察口径」，**不建议现在立项退役**；(iii) T13 处置独立（`verifyArchive` 框架已可承载，MEMORY:31 候选未定夺）；(iv) 预热「先别优化」是我给的产品裁决：无度量数据前优化=赌博 | ≈ 8 文件（qa 归档标注 + 处置报告 + `lock-probe`/真机脚本配方 ×2-3 + MEMORY 口径行；**预计零生产代码改动**） | ① `npm run lock-probe` 与真机 full GUI E2E 各出留痕（`qa/r20-gui-e2e-*.txt`），HOST-A2A §9「未验证项」清单**逐条转已验证或如实保留**（不许悄悄划掉）；② T13：归档内断片标注 + 处置报告落盘，`verifyArchive` 用例覆盖该断片（entry#512 prevHash 指错被判为「断片非篡改」的口径写进报告）；③ K3 兜底命中率有可读出口（G-b 计数进 delegation.complete 真值层，抽样 N 条委派给出 `text-fallback` 占比），MEMORY backlog 行改「观察中（判据=占比归零后退役）」；④ 预热项 MEMORY 行改「已度量未优化（`firstCallLatencyMs`），优化待数据」，防被读成已修；⑤ 全仓 E-3 门禁保持「UNKNOWN 绝不 GO」（`scripts/lock-probe.mjs` 非零退出=不可 GO，须在回归批里被真实执行一次而非只跑单测） |

### 8.2 跨批依赖一览（供主理人排窗口）

```
批0 文档诚实化 ──(同窗口共改续跑话术)── 批1 审批闭环 [#1(b)/(c)]
                                        │
                                        └─ 若走 (a)：硬约束 = k5-replay.test.js:890-892 三守卫 + assembly-guard.test.js 同步改
批2 prepare-vm [#2] ──同文件域── install-vm powercfg [#8] ──真机窗口前置── 批5 GUI 回归批
      │                                              │
      └─(bootstrap 骨架复用)─ 批4 prepare-apps [#3b]  └─(必须先于)─ 批4 示例工作流
                                    ▲
批3 [#9a 取消面 / #4 挂载 / #5 provider差集] = 三项互不依赖，可整项前插任意批（性价比之最：#9a）
批1 [#7 审批卡 TTL 槽] = 无依赖，可拆给任意批（数据源现成）
```

**三句给排期的话（产品判断，非结论）**：
1. **若只能做两批**：批 0 + 批 3。理由：批 0 是唯一「零代码止血失实承诺」，批 3 三项合计 ≈15 文件却净增 4 个对外功能 + 关闭最高频「叫停停不下来」+ 消除安全特性静默降级，是价值/成本比峰值。
2. **若按首周用户旅程重排**（我此前 §7 偏工程可行性，主理人可对照采纳）：**批 2 应前置到批 1 之前**——批 2 决定「当晚能不能干活」（6 项手工 + 生产路径 100% 空转），批 1 决定「深水区别信任翻车」（默认 provider 不触闸，爆炸半径已收缩，见修订记录 2）。这是我与自己的 §7 排序**有意留下的分歧**，留给主理人裁。
3. **两处「别踩」的成本陷阱**：① 批 1 出路 (a)（新建批准入口）看起来最"完整"，但要同时动 `contracts` 接口 + 三条源码守卫 + K5 §4 纪律 2 风险评估，**是 (c) 的 1.6 倍改动面且带安全放宽讨论**；② 批 4 `#9b` 进度透传若无架构裁决先行，容易做成「第 3 条进度通道」而非复用现有 `ProgressSink` 线形契约（P2-T12 已定契约形态），建议列为需架构维输入的后置项。

> 本表全部判据以「可证伪」为口径（grep 命中数 / 集合断言 / 用例断言 / 工件留痕），未使用「改善」「优化」类不可验收措辞。`qa/r20-*` 命名沿用既有 `qa/r19/t<批次>-sweep-result.txt` 惯例。基线数字权威源=`qa/` 最新 `*-sweep-result.txt` 汇总行（MEMORY:38 口径，README/06-OVERVIEW 已废静态数字）。
