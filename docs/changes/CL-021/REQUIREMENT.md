# CL-021 · R17 三项需求（宿主审批卡原生渲染 / 会话工具面注入保障 / K6 卸载核验）

> 变更标识：`CL-021` ｜ 代号：**R17** ｜ 性质：**功能增量 + 语义修正**
> 范围：3 项 —— **R1** 宿主审批卡原生渲染（T03）／**R2** 会话工具面注入保障（T04）／**R3（K6）** `app.winget.uninstall` 卸载核验与 NSIS 静默回退（T01/T02），另含实施期派生项 **T02b**（能力级超时以注册表为权威）。
> 提交区间：`8cd5da0` → `a3308ae`，共 **11 个 commit**，全部为 2026-09-30。
> 上游依据：`docs/prd/r17-prd.md`（PRD-R17-v1）· `docs/design/r17-design.md`（DESIGN-R17-v1，含 §A5 勘误回写）。
> 验证结论：`docs/test/reports/r17-qa-2026-09-30.md` —— **条件 PASS**，路由判定 **NoOne**。

---

## 1. 变更概述

**一句话**：① A2A 协议层早已返回结构化审批数据（`data.type='approval-request'`，含 `approval` / `approvalId` / `resumeHint` / `underlying`），但宿主只能纯文本转呈 —— 本变更把它升级为 **「`show_widget` HTML 审批卡（视觉）+ `AskUserQuestion`（权威收口）」两段式原生渲染**；② 新会话经常不注入 `winvm` / `winvm-a2a` 连接器工具 —— 本变更交付**只读诊断工具 + 安装末尾自检 + troubleshooting 文档 + 门禁兜底**四件套；③ `app.winget.uninstall` 对 NSIS 安装包（如企业微信）**假成功**（winget exit 0 但磁盘无变化、无 `QuietUninstallString`） —— 本变更把它改写为 **卸载→预捕获→核验→NSIS `/S` 回退→再核验→回执** 状态机，`success` 以最终核验为准。

### 1.1 三项来源与性质

| 项 | 来源 | 性质 | 处置状态 |
|---|---|---|---|
| **R1**（审批卡） | `.dev/changing-log.md` 第十六轮追加三项；K5 已真机端到端 PASS（审批卡 + 服务端重放），但**宿主只能文本转呈** | 宿主侧新增能力（L2 Renderer 新增渲染模块） | 本变更实现（T03） |
| **R2**（工具面注入） | 安装器已把 `winvm`（streamableHttp）与 `winvm-a2a`（stdio）注册进 `~/.workbuddy/mcp.json` 且连接器页可信任启用，但**新会话经常不自动注入工具** | 根因部分属 WB 平台行为，本项目按裁定 Q3 交付「诊断 + 规避 + 兜底」 | 本变更交付四件套（T04） |
| **R3 / K6**（卸载假成功） | `Uninstall-WingetPackage` 仅看 exit code；NSIS 包 winget 报假成功（exit 0 但磁盘无变化） | **语义破坏性修正**：`success` 由「exit code」改为「最终核验」；回执新增 `verified` / `fallbackUsed` / `residualEvidence` | 本变更实现（T01 契约 + T02 能力层） |
| **T02b**（派生） | 实施期发现：能力级 `timeoutMs=600_000`（K6 回退后最坏 540s）会被 A2A metadata 的 300s 掐断 | **修复项**：超时取值改为注册表优先 | 本变更实现（`586c003` + `4976146`） |

### 1.2 R3 的缺陷性格：为什么它是「假成功」而不是「偶发失败」

> winget uninstall 对 NSIS 包报 **`exit 0`**（成功）但**磁盘无任何变化**，且卸载注册表键无 `QuietUninstallString`（即 winget 无法执行静默卸载，实际什么都没做）。
> 旧回执 `success = (exitCode === 0)` ⇒ 产出 `success=true` ⇒ 上层与用户据此认为「软件已卸载」。**这是一个与 K3（审批假成功）同类的 fail-open 缺陷**：不可观测、宿主不会重试。

---

## 2. 需求池

### 2.1 R1 · 宿主审批卡原生渲染（P0）

**来源**：PRD §3.1 R1-1 ~ R1-6 ｜ 设计落点：`docs/design/r17-design.md` §A1.1 / §A3.3 / §A4 ｜ 任务：T03（`0adcc97` + `dd1d779`）

| ID | 需求 | 优先级 |
|---|---|---|
| R1-1 | 宿主插件识别 `data.type='approval-request'` 结构化数据，触发**原生卡片渲染**而非纯文本转呈 | **P0** |
| R1-2 | 卡片遵循 `skills/winvm-orchestrator/references/approval-card.md` v1 模板**七槽位**（操作/目标/通道/风险/影响清单/可逆性/预览）+ 审批 ID + 续跑方式；数据缺失按模板 §5 **逐字**降级填充，**不得留空、不得写 N/A**；`underlying` 必须展示真实目标行 | **P0** |
| R1-3 | 用户点「批准」/「拒绝」→ 宿主 Agent 经工具面转 `a2a.approval.reply { taskId?, approvalId, approved }`；拒绝/超时保持 `ok=false`（K3 纪律）；批准后走 **K5 服务端确定性重放** | **P0** |
| R1-4 | **先调研** WorkBuddy 插件可用渲染/交互机制，产出选型结论写入设计文档后再实现 | **P0**（`docs/design/r17-design.md` §A1.1 已交付） |
| R1-5 | 兜底：宿主不支持原生卡时按 `approval-card.md` 文本模板转呈（当前行为），保留 `resumeHint` 续跑指令 | P1（裁定 Q1 升为**强制兜底路径**） |
| R1-6 | MCP 直调通道的 `__approvalId` 续跑标记与 A2A 通道 `resumeHint` **不得混用**（沿用既有红线） | **P0** |

**用户故事**：作为宿主用户，当 VM 侧 Agent 请求执行 L2/L3 危险操作时，我想在 WorkBuddy 会话里看到一张原生审批卡（操作 / 真实目标 / 通道 / 风险 / 影响清单 / 可逆性 / 预览 / 审批 ID），点「批准」或「拒绝」即可 —— 不用看懂协议字段就能做安全决策。

**验收标准（PRD 原文）**：走宿主 MCP 工具路径端到端演示 —— 委派含 L2/L3 步骤的任务 → 宿主出现原生卡（含 `underlying` 真实目标）→ 点批准 → 服务端重放执行 → 任务 `completed`，审计含 `-replay executed` 条目。

> **本轮实际验收状态**：该端到端闭环需宿主 WorkBuddy 会话内真实工具面（`show_widget` / `AskUserQuestion` 支持深度 = 设计 U2）+ VM 真机服务，**离线沙箱不可证** ⇒ 列为真机 BLOCKED（见 `QA-REPORT.md` §8-①）。

### 2.2 R2 · 会话工具面注入保障（P0/P1）

**来源**：PRD §3.1 R2-1 ~ R2-5 ｜ 设计落点：设计 §A1.2 ｜ 任务：T04（`df56f24` + `e712bc3` + `a0d8db3`）

| ID | 需求 | 优先级 |
|---|---|---|
| R2-1 | **根因诊断**：定位新会话不注入工具的原因。三条方向：① `~/.workbuddy/mcp.json` 与各 account `connectors/<account>/mcp.json` 的加载时机与优先级；② `connector-states.v3.json`（trust/enabled 加密态）在新会话是否生效；③ streamableHttp 与 stdio 两类连接器在注入管线中的差异（stdio 的 `winvm-a2a` 是否需宿主拉起子进程且失败静默） | **P0** |
| R2-2 | **长期方案**：按裁定 Q3 边界落地 —— 只读探测 + 双处注册一致性 + 文档化自助路径 + 门禁兜底；目标＝新会话 ToolSearch 稳定命中 `winvm__*` 与 `a2a.*` | **P0** |
| R2-3 | 文档化临时解决路径：「新会话工具缺失 → 到连接器页信任并启用 → 重开会话验证」写入 `docs/INSTALL-GUIDE.md`，并在 `skills/winvm-orchestrator/SKILL.md` 门禁中链接 | P1 |
| R2-4 | 门禁兜底保持：工具不可用 → **停止并请求用户启用连接器**；**严禁**宿主 agent 手写一次性脚本直打 A2A/MCP/SSH 绕过工具面 | **P0** |
| R2-5 | 只读诊断脚本纳入仓库与交付管道，供 QA 真机复跑 | P2 |

**验收标准（PRD 原文）**：连续新建 ≥3 个会话，每个会话 ToolSearch 均能命中 `winvm__` / `a2a.` 前缀工具并成功调用 `a2a.health`；模拟「未启用」场景时给出 R2-3 的指引文案。

> **本轮实际验收状态**：「连续 ≥3 新会话 ToolSearch 命中」依赖 WB 平台会话注入行为 ⇒ 真机 BLOCKED（`QA-REPORT.md` §8-②）；离线仅能证明**注册面就位**（诊断工具已证）。

### 2.3 R3 / K6 · `app.winget.uninstall` 卸载核验与 NSIS 静默回退（P0）

**来源**：PRD §3.1 R3-1 ~ R3-6 ｜ 设计落点：设计 §A1.3 / §A3.2 / §A5 ｜ 任务：T01（`8cd5da0`）+ T02（`96bb472`）+ §A5 回写（`0d7f58c`）

| ID | 需求 | 优先级 |
|---|---|---|
| R3-1 | **卸载后核验**：`Uninstall-WingetPackage`（`packages/vm-capabilities/psmod/app.ps1`）在 winget exit 0 后做**磁盘 + 注册表双重核验**（安装目录可执行文件消失 / 卸载注册表键消失） | **P0** |
| R3-2 | **NSIS 静默回退**：核验失败且卸载键为 NSIS 型（`UninstallString` 指向 `Uninstall.exe`、**无** `QuietUninstallString`）时，追加 `Uninstall.exe /S` 静默重试并**再次核验** | **P0** |
| R3-3 | **回执结构扩展**：`success` 以最终核验为准；新增 `verified`（`exeGone` / `dirGone` / `registryGone` / `installLocation` / `installerType`）、`fallbackUsed`；核验失败时 `success=false` 并附**残留证据** `residualEvidence` | **P0**（破坏性语义变更，消费者清单见设计 §A3.2） |
| R3-4 | 更新 `definitions.ts` 中 `app.winget.uninstall` 的 input/output schema 与描述（核验语义、600s 预算） | P1 |
| R3-5 | **通用性约束**：非 NSIS 包维持现有 winget 路径；回退仅在注册表键明确为 NSIS 时触发（**MSI 永不回退**，避免误伤）；dry-run 路径不变（免审批语义保持） | **P0** |
| R3-6 | QA 真机回归：企业微信（NSIS）+ 一个 MSI 包对照，覆盖「winget 假成功→回退成功」「winget 真成功（不触发回退）」「卸载失败 `success=false`」三案例 | P1 |

**用户故事**：作为 VM 使用者，我执行 `app.winget.uninstall` 后，回执中的 `success=true` 意味着软件**确实**从磁盘/注册表消失；若 NSIS 静默卸载失败，系统会自动用 `Uninstall.exe /S` 回退重试并把真实结果告诉我。

**验收标准（PRD 原文）**：真机卸载企业微信，回执 `success=true` 且 `verified` 证据齐全、`WXWork.exe` 磁盘消失；对照 MSI 包不触发回退且结果真实。

> **本轮实际验收状态**：`app.ps1` 行为验证需 PowerShell + 真实包，沙箱**无 PowerShell** ⇒ 全部列入真机 BLOCKED（`QA-REPORT.md` §8-③⑤）。离线仅完成静态结构佐证（大括号/圆括号配平、25 函数零重名、`R-1…R-8` 函数族 13 个齐备）与 TS 侧等价逻辑单测。

### 2.4 派生需求 T02b · 能力级超时应以注册表为权威（P0）

**背景（实施期发现，非 PRD 原文）**：K6 引入 NSIS 回退后，`app.winget.uninstall` 的最坏耗时 = **winget 阶段 300s + 回退阶段 240s = 540s**，能力注册表的 `timeoutMs` 为 **600_000**（10 min）。但 A2A 通道的 metadata 只给 **300s**，旧取值写法会把 540s 的最坏情形**掐断**。

| ID | 需求 | 优先级 |
|---|---|---|
| R3-7（派生） | 能力调用的超时统一取 **注册表 `CapabilityDefinition.timeoutMs`**（契约必填）优先，回落 `req.timeoutMs`，最后 30s 兜底；两条通道（MCP / A2A）口径对齐 | **P0** |

**定稿口径**（`packages/adapter-agent-workbuddy/src/index.ts` `implementationOf` 注释）：
```
capTimeoutMs ?? req.timeoutMs ?? 30_000
```
其中 `capTimeoutMs` 由 `implementationOf()` 从注册表带出，且带「**正的有限数**」守卫（0 / 负数 / NaN ⇒ `undefined`，回落 `req`）。

---

## 3. 裁定（已裁定决策）

> 本节记录**实现期不可自行再权衡**的口径。未列事项按设计 §B3 共享知识执行。

| # | 裁定 | 内容 |
|---|---|---|
| **Q1** | 渲染机制由架构师选型；**文本模板降级为强制兜底路径** | 不得因选型阻塞实现（设计 §A1.1） |
| **Q2** | 卡片点击**不直调** `a2a.approval.reply` | 卡片交互产出**结构化审批指令注入会话**，由宿主 agent 经工具面 `a2a.approval.reply` 执行；`approvalId` 仍只来自 A2A 事件透传（不可伪造） |
| **Q3** | 若注入根因属 WB 平台缺陷，交付**根因诊断报告 + 规避方案 + 门禁兜底**即可 | 推动 WB 修复，**不阻塞**本迭代 / 不阻塞 R1、R3 |
| **A1.1** | 渲染选型定稿：**`show_widget`（HTML 审批卡，视觉）+ `AskUserQuestion`（批准/拒绝，权威收口）两段式** | 否决「widget 按钮直调 MCP 工具」（WB 未提供运行时权限）、否决「插件自定义面板」（本插件无常驻 UI 进程）、「MCP App artifact 面板」仅作备选不做 |
| **A1.3-1** | 核验目标派生：优先注册表 `InstallLocation`；缺失/为空时按 `UninstallString` 去引号去参数后**取目录反推**安装根；再缺失则 `dirGone=null`（只做注册表核验）。**不在 PS 里全盘扫描** | PRD OQ4 定稿 |
| **A1.3-2** | NSIS 判定：卸载键存在 且 `UninstallString` 指向 `Uninstall.exe`（不区分大小写） 且 **无** `QuietUninstallString` ⇒ NSIS 型，才允许 `/S` 回退。MSI（`UninstallString` 含 `msiexec`）及其它类型**永不回退** | PRD OQ5 / R3-5 |
| **A1.3-3** | 超时预算：**不新增**分段超时参数，维持能力级 **600s 总预算**；内部软分配 winget ≤300s / 回退 ≤240s / 核验 ≤30s，**总时长严禁突破 600s** | PRD OQ5 定稿 |
| **§A5 勘误（R-0）** | **entry 预捕获先于 winget**：原时序把 `Get-PackageUninstallEntry` 画在 exitCode=0 **之后** —— 真卸载成功后注册表 `Uninstall` 键随即消失，届时再查取不到 `InstallLocation / UninstallString / QuietUninstallString`，`installerType` 会被误降级为 `unknown`、`dirGone` 退化为 `null`，**把一次真成功核验成「无法判定」**（假失败与假成功同样是假）。实现改为**跑 winget 之前预捕获 entry**，`registryGone` 由卸载后的**独立重查**决定 | 由 `0d7f58c` 回写；本报告 §2.3 与技术方案均以勘误后顺序为准 |
| **B3-5** | 通道隔离红线：卡片 HTML 及其产出的结构化审批指令中**绝不允许出现 `__approvalId`**；只允许 `a2a.approval.reply { taskId, approvalId, approved }` 一条 A2A 续跑指令 | 写入模板与测试；`approval-card.ts:62` 以**字符串拼接**构造该标记（`'__' + 'approval' + 'Id'`），使源码与 dist 中该字面量不完整出现（守卫本体，**刻意保留、不可改**） |

---

## 4. 非功能需求（硬约束）

| # | 约束 | 落地表现 |
|---|---|---|
| N1 | **单向流纪律**：一切修改先落本仓库，经 `delivery/install-host.mjs`（宿主）与 `.env.deploy-vm` 部署管道（VM）分发；**禁止双侧直改** | 全部改动经 git commit（11 个） |
| N2 | **执行规范**：宿主 agent 严禁手写一次性脚本直打 A2A/MCP/SSH；必须走标准四步（委派 → 审批转呈 → 放行 → 轮询） | `SKILL.md` 门禁文案已复核（QA §2b） |
| N3 | **安全不变式**：审批闸不可绕过；`approvalId` 不可伪造；呈现文本严禁「超时默认批准 / 已修复」类措辞 | 沿用 CL-016 / CL-018 红线 |
| N4 | **中立渲染分层**：卡片实现落在 `adapter-host-workbuddy`（L2 Renderer）；`host-sdk` 中性模型与 skills 源最小改动 | `contracts/` 零改动（`QA-REPORT.md` §2c 已核） |
| N5 | **「严格禁止」恰 5 条**（裸 ssh / 裸 powershell·psexec·winrm / 自构 HTTP 打 /mcp /a2a / 跳过审批闸 / 现场手写脚本绕行） | QA 按 `^- ❌` 计数复核通过 |
| N6 | **构建与测试口径**：TypeScript strict ESM；构建 `tsc -b tsconfig.build.json`（不是裸 `tsc`）；单测 `node --test tests/unit/<file>.test.js` **单文件跑**（整批在本仓会 MODULE_NOT_FOUND，既有口径非回归） | QA §1 采用同口径 |

---

## 5. 影响范围

按 commit 顺序排列（哈希出处见表下注脚；日期均为 2026-09-30）：

| Commit | 文件 | 类型 | 影响 |
|---|---|---|---|
| `8cd5da0`（T01） | `packages/vm-capabilities/src/registry/definitions.ts` | 源码（TS） | `app.winget.uninstall` output schema 与描述增 `verified` / `fallbackUsed` |
| `8cd5da0` | `docs/02-design/CAPABILITY-MODEL.md` | 文档 | §3.2.1 回执语义更新（v1.1） |
| `8cd5da0` | `tests/unit/r3-uninstall-verify.test.js` | 测试（新增） | K6 断言基线：NSIS 判定 / `InstallLocation` 反推 / 回执字段 / dryRun 语义 |
| `8cd5da0` | `docs/design/r17-design.md` · `r17-class-diagram.mermaid` · `r17-sequence-diagram.mermaid` · `docs/prd/r17-prd.md` | 文档（新增） | 本变更的 PRD 与设计本体 |
| `96bb472`（T02） | `packages/vm-capabilities/psmod/app.ps1` | 源码（PS） | 核验状态机 + NSIS `/S` 回退 |
| `96bb472` | `tests/unit/r3-uninstall-verify.test.js` | 测试 | 状态机等价断言 |
| `0d7f58c`（§A5 回写） | `docs/design/r17-design.md` | 文档 | §A5 时序按 R-0 勘误回写 |
| `0adcc97`（T03-a） | `packages/adapter-host-workbuddy/src/approval-card.ts` | 源码（TS，**新增**；当前 HEAD 实测 821 行） | 卡片模板常量 + `fillApprovalCard()` + 降级判定 + 哨兵自检 |
| `0adcc97` | `packages/adapter-host-workbuddy/src/index.ts` | 源码（TS） | 导出 `approval-card`；`plan()` 把卡片注入 skill 产物 |
| `0adcc97` | `tests/unit/r1-approval-card.test.js` | 测试（新增） | 槽位填充 / 降级文案 / 通道隔离（卡内不得出现 `__approvalId`） |
| `dd1d779`（T03-b） | `skills/winvm-orchestrator/SKILL.md` | Skill 门禁 | 审批门禁流程升级为「结构化数据 → show_widget → AskUserQuestion → a2a.approval.reply」 |
| `dd1d779` | `skills/winvm-orchestrator/references/approval-card.md` | Skill 参考 | v1 → **v1.1**：新增 §10 原生渲染段（§1–§9 正文不动） |
| `dd1d779` | `tests/unit/r1-approval-card.test.js` | 测试 | 门禁与模板条款守卫 |
| `586c003`（T02b-a） | `packages/adapter-agent-workbuddy/src/index.ts` | 源码（TS） | 能力超时取注册表 + `implementationOf` 带出 `timeoutMs` |
| `586c003` / `4976146`（T02b-b） | `tests/unit/r3-uninstall-verify.test.js` | 测试 | 超时链静态守卫（第 35 条）；`4976146` 改为**剥离注释后**比对代码形态，避免注释中旧写法误报 |
| `df56f24`（T04-a） | `delivery/tools/diagnose-connectors.mjs` | 交付脚本（**新增**；当前 HEAD 实测 515 行） | 只读诊断：全局/账户 `mcp.json`、trust 状态、stdio command 可执行性 |
| `e712bc3`（T04-b） | `delivery/install-host.mjs` | 交付脚本 | 安装末尾 `runConnectorSelfCheck(home, dryRun)` 自检 + 自助指引 |
| `a0d8db3`（T04-c） | `docs/INSTALL-GUIDE.md` | 文档 | §8 故障排查下新增 **§8.1「连接器已注册但会话未注入工具（R2 · R17-T04）」** |
| `a0d8db3` | `docs/design/r17-connector-injection-diagnosis.md` | 文档（新增） | R2 根因诊断报告（真机探测后填充） |
| `a0d8db3` | `skills/winvm-orchestrator/SKILL.md` | Skill 门禁 | 工具缺失指引链接 |
| `a3308ae`（QA） | `docs/test/reports/r17-qa-2026-09-30.md` | 报告（新增） | 本报告的数据源 |
| `a3308ae` | `tests/unit/sandbox-allowwrite.test.mjs` | 测试 | QA 自修基线既有测试桩缺陷（桩补一行导出，见 `QA-REPORT.md` §4 F-1） |
| `a3308ae` | `.dev/changing-log.md` | 索引 | 第十七轮闭环记录 |

> **零改动 / 未触及面**（源报告 §2c 结论）：`packages/host-a2a-bridge/src/`、`packages/contracts/`、`packages/host-sdk/` 三处改动面**为空**（数据面已完备，本轮消费不改）。
>
> **注（哈希出处）**：上表 11 个 commit 哈希的检索来源是 `docs/test/reports/r17-qa-2026-09-30.md`（开头「范围」段按 T01/T02/§A5/T03×2/T02b×2/T04×3 逐条列出）与 `.dev/changing-log.md:522`（原文：「CL-021（代号 R17）11 个 commit（`8cd5da0` → `a3308ae`），覆盖 T01/T02/§A5 回写/T03×2/T02b×2/T04×3/QA」）。**未经版本控制系统复核。**
