# PRD：第十七轮三项需求（R17）

| 项 | 值 |
|---|---|
| 文档 ID | PRD-R17-v1 |
| 作者 | 许清楚（产品经理） |
| 状态 | 待评审 |
| 日期 | 2026-09-30 |
| 上游依据 | `.dev/changing-log.md` 第十六轮追加三项；K5 已真机端到端 PASS（审批卡 + 服务端重放） |

---

## 1. 项目信息

- **Language**：简体中文
- **Project Name**：`workbuddy-virtual-win-plugin`（WinVM Bridge）· R17 迭代
- **原始需求复述**：本轮聚焦三件事——
  1. 宿主审批卡**原生渲染**：A2A 协议层已返回结构化审批数据（`data.type='approval-request'`，含 `approval` / `approvalId` / `resumeHint` / `underlying`），但宿主目前只能以纯文本转呈用户，需在 WorkBuddy 会话中渲染原生审批卡，用户点批准/拒绝后由插件转 `a2a.approval.reply`。
  2. **会话工具面注入保障**：安装器已把 `winvm`（streamableHttp）与 `winvm-a2a`（stdio）注册进 `~/.workbuddy/mcp.json`，连接器页面可信任启用；但**新会话经常不自动注入这两个连接器的工具**，需诊断并长期解决。
  3. **K6 能力层修复**：`app.winget.uninstall` 对 NSIS 安装包（如企业微信）**假成功**——winget/卸载进程 exit 0 但磁盘无变化。需卸载后核验 + NSIS 静默回退重试。

---

## 2. 产品定义

### 2.1 Product Goals（3 个正交目标）

1. **审批交互零误读**：宿主侧审批请求以结构化卡片原生呈现（含真实目标 `underlying`、影响清单、审批 ID、续跑方式），用户一键批准/拒绝即触发 `a2a.approval.reply`，杜绝"纯文本转呈被 LLM 措辞稀释 / 用户看不清要批什么"。
2. **工具面注入确定性**：任何新会话中 `winvm` / `winvm-a2a` 连接器工具可被稳定发现与调用（ToolSearch 可命中 `winvm__*` / `a2a.*`），无法注入时有明确的用户自助路径与技能门禁兜底，不再依赖"旧会话碰巧可用"。
3. **卸载结果真实性**：`app.winget.uninstall` 返回的 `success` 必须以磁盘/注册表**事后核验**为准，NSIS 等静默卸载失败的包有确定性回退路径——能力层回执即事实，消灭"exit 0 但软件还在"。

### 2.2 User Stories

1. 作为**宿主用户**，当 VM 侧 Agent 请求执行 L2/L3 危险操作时，我想在 WorkBuddy 会话里看到一张原生审批卡（操作/目标/风险/影响清单/审批 ID），点「批准」或「拒绝」即可，以便不用看懂协议字段就能做安全决策。
2. 作为**宿主用户**，我在一个全新会话里说"卸载 VM 里的企业微信"，系统就能找到 `a2a.delegate` / `winvm__*` 工具并走完委派→审批→放行→轮询四步，以便不需要先开一个"旧会话"或手动折腾连接器设置。
3. 作为**宿主用户**，当工具面因故未注入时，我希望收到一句明确的指引（去连接器页启用 `winvm` / `winvm-a2a`），而不是任务静默失败或 Agent 凭空编造结果。
4. 作为 **VM 使用者**，我执行 `app.winget.uninstall` 后，回执中的 `success=true` 意味着软件确实从磁盘/注册表消失；若 NSIS 静默卸载失败，系统会自动用 `Uninstall.exe /S` 回退重试并把真实结果告诉我。
5. 作为**运维/审计者**，我能在审计记录中看到"卸载被拦截 → 用户批准 → 服务端重放真实执行 → 事后核验通过"的完整链路，以便取证时无盲区。

---

## 3. 技术规范

### 3.1 Requirements Pool

#### R1 宿主审批卡原生渲染

| ID | 需求 | 优先级 |
|---|---|---|
| R1-1 | 宿主插件识别 `data.type='approval-request'` 结构化数据（bridge `tools.ts` 的 `extractApproval` / `withA2aResumeHint` 已产出 `approval` / `approvalId` / `resumeHint` / `underlying`），触发原生卡片渲染，而非纯文本转呈 | **P0** |
| R1-2 | 卡片内容遵循 `skills/winvm-orchestrator/references/approval-card.md` v1 模板七槽位（操作/目标/通道/风险/影响清单/可逆性/预览）+ 审批 ID + 续跑方式；数据缺失时按模板 §5 降级文案填充，不得留空；`underlying` 必须展示真实目标行 | **P0** |
| R1-3 | 用户在卡片上点「批准」/「拒绝」→ 插件（或宿主 Agent 经工具面）转 `a2a.approval.reply { taskId?, approvalId, approved }`；拒绝/超时保持 K3 行为（ok=false），批准后走 K5 服务端确定性重放 | **P0** |
| R1-4 | 先调研 WorkBuddy 插件可用的渲染/交互机制（插件面板、artifact 卡片、interactive widget、AskUserQuestion 增强等），产出选型结论写入设计文档后再实现 | **P0** |
| R1-5 | 兜底：宿主不支持原生卡片时，按现有 approval-card.md 文本模板转呈（当前行为），并保留 `resumeHint` 续跑指令 | **P1** |
| R1-6 | MCP 直调通道的 `__approvalId` 续跑标记与 A2A 通道 `resumeHint` 不得混用（沿用既有红线） | **P0** |

**验收标准**：走宿主 MCP 工具路径端到端演示：委派含 L2/L3 步骤的任务 → 宿主出现原生卡（含 underlying 真实目标）→ 点批准 → 服务端重放执行 → 任务 completed，审计含 `-replay` executed 条目。

#### R2 会话工具面注入保障

| ID | 需求 | 优先级 |
|---|---|---|
| R2-1 | **根因诊断**：定位新会话不注入 `winvm` / `winvm-a2a` 工具的原因。方向：① `~/.workbuddy/mcp.json` 与各 account `connectors/<account>/mcp.json` 的加载时机与优先级；② 连接器 trust 状态加密文件 `connector-states.v3.json` 的启用态在新会话是否生效；③ 会话工具注入管线对 streamableHttp / stdio 两类连接器的处理差异（stdio 的 `winvm-a2a` 是否需宿主拉起子进程而失败静默） | **P0** |
| R2-2 | **长期方案**：基于诊断结论落地修复（可能涉及：安装器写入时机/双处注册一致性、trust 状态预置、或推动 WB 侧连接器自动启用）。目标：新会话 ToolSearch 稳定命中 `winvm__*` 与 `a2a.*` 全部工具 | **P0** |
| R2-3 | **文档化临时解决路径**：把"新会话工具缺失 → 用户到连接器页信任并启用 → 重开会话验证"的操作步骤写入 `docs/INSTALL-GUIDE.md`（或新建 troubleshooting 章节），并在 `skills/winvm-orchestrator/SKILL.md` 门禁中链接 | **P1** |
| R2-4 | 门禁兜底保持：工具不可用 → 停止并请求用户启用连接器，**严禁**宿主 agent 手写一次性脚本直打 A2A/MCP/SSH 绕过工具面 | **P0** |
| R2-5 | 诊断与回归脚本（只读探测 mcp.json / connector-states 加载状态）纳入仓库与交付管道，供 QA 真机复跑 | **P2** |

**验收标准**：连续新建 ≥3 个会话，每个会话 ToolSearch 均能命中 `winvm__` / `a2a.` 前缀工具并成功调用 `a2a.health`；模拟"未启用"场景时给出 R2-3 的指引文案。

#### R3 K6 能力层修复（app.winget.uninstall 假成功）

| ID | 需求 | 优先级 |
|---|---|---|
| R3-1 | **卸载后核验**：`Uninstall-WingetPackage`（`packages/vm-capabilities/psmod/app.ps1`）在 winget exit 0 后，对目标包做磁盘 + 注册表双重核验（安装目录可执行文件消失 / 卸载注册表键消失；核验目标可从包安装记录或 `winget list` 派生） | **P0** |
| R3-2 | **NSIS 静默回退**：核验失败且卸载注册表键为 NSIS 型（`UninstallString` 指向 `Uninstall.exe`、无 `QuietUninstallString`）时，追加 `Uninstall.exe /S` 静默重试（已实测有效：EXE_GONE/DIR_GONE/WINGET_REMOVED），等待完成后再次核验 | **P0** |
| R3-3 | 回执结构扩展：`success` 以最终核验结果为准；新增 `verified`（核验方式与证据：exeGone/dirGone/registryGone）、`fallbackUsed`（是否触发 NSIS 回退）字段；核验失败时 `success=false` 并附残留证据 | **P0** |
| R3-4 | 更新能力 `definitions.ts` 中 `app.winget.uninstall` 的 input/output schema 与描述（新增核验语义、超时预算，含回退总时长控制在既有 600s timeout 内） | **P1** |
| R3-5 | 通用性约束：非 NSIS 包维持现有 winget 路径；回退仅在注册表键明确为 NSIS 时触发，避免对 MSI 等安装器误伤；dry-run 路径不变（免审批语义保持） | **P0** |
| R3-6 | QA 真机回归：以企业微信（NSIS）+ 一个 MSI 包做对照卸载测试，覆盖"winget 假成功→回退成功""winget 真成功（不触发回退）""卸载失败 success=false"三案例 | **P1** |

**验收标准**：真机卸载企业微信，回执 `success=true` 且 `verified` 证据齐全、`WXWork.exe` 磁盘消失；对照 MSI 包不触发回退且结果真实。

### 3.2 非功能需求（硬约束）

1. **单向流纪律**：一切修改先落 git 仓库（本仓库 `/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`），经 `delivery/install-host.mjs`（宿主）与 `.env.deploy-vm` 部署管道（VM）分发；**禁止宿主/VM 双侧各自直改**。
2. **执行规范**：宿主 agent 严禁手写一次性脚本直打 A2A/MCP/SSH；任务必须经插件工具面标准四步：**委派（a2a.delegate / winvm 工具）→ 审批转呈 → 放行（a2a.approval.reply / __approvalId）→ 轮询（a2a.task.get）**。
3. **安全不变式**：审批闸不可绕过；`approvalId` 不可伪造（沿用 K5 安全语义：拒绝/超时零重放、`seg.approved` 透传全调用点、deriveUnderlying 脱敏）。
4. **中立渲染分层**：审批卡实现落在 `adapter-host-workbuddy`（L2 Renderer）层，`host-sdk` 中性模型与 skills/ 源零改动或最小改动，为未来 `adapter-host-claude` 等留出同构扩展。

### 3.3 UI Design Draft（审批卡，R1）

宿主 WorkBuddy 会话内，审批请求到达时渲染交互卡片：

- 标题区：🔐（L2）/ ⛔（L3）+「需要你确认」+ 能力名（如 `app.winget.uninstall`）。
- 信息区：目标、通道、风险等级、影响清单（可展开）、可逆性、dry-run 预览（如有）。
- 底部：审批 ID（`apr_xxx`）+ 两个按钮「批准」「拒绝」；按钮点击后卡片置为已处置态（防止重复提交），并转 `a2a.approval.reply`。
- 无原生交互能力时降级为 approval-card.md v1 文本模板（用户回复"批准/拒绝"）。

### 3.4 Open Questions（待确认）

1. **WB 渲染机制选型**（R1-4）：WorkBuddy 插件当前可用的原生交互面有哪些？（MCP App artifact 面板？插件自定义卡片？interactive widget？）需架构师/主理人确认可行清单，PRD 默认假设"存在一种可承载两按钮的卡片机制，否则降级文本模板"。
2. **批准动作的执行者**：卡片按钮点击后由插件代码直接调 `a2a.approval.reply`，还是仅向宿主 Agent 注入续跑指令（当前 resumeHint 语义）？前者需确认插件有无独立调用工具的运行时权限。
3. **连接器注入根因归属**（R2-1）：若诊断结论为 WB 平台侧缺陷（加载时机/trust 加密文件），本项目只能缓解不能根治——届时 R2-2 降级为"规避 + 推动 WB 修复"，请主理人预先确认可接受边界。
4. **核验目标派生**（R3-1）：NSIS 包的安装目录如何可靠定位？（注册表 `InstallLocation` 缺失/为空的兜底策略——按 `UninstallString` 路径反推 or 扫描常见安装根？）实现时需定稿。
5. **回退超时预算**：`Uninstall.exe /S` 对大包（如企业微信）可能耗时数分钟，600s 能力级 timeout 是否需要按"winget 阶段 + 回退阶段 + 核验阶段"分段预算？

---

## 4. 里程碑建议（供架构师排期参考）

1. M1：R1-4 渲染机制调研结论 + R2-1 诊断报告（并行）。
2. M2：R1 原生卡实现 + R2-2 长期方案落地 + R3 能力层修复。
3. M3：真机端到端验收（R1 验收 + R2 验收 + R3 QA 对照回归），更新 `.dev/changing-log.md` 闭环。
