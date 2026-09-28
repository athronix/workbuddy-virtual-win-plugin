# CL-016 · 增量需求（PRD）

> **变更标识**：`CL-016` ｜ **类型**：新增产品能力（**审批闸 UX / 可理解性**，增量开发）｜ **作者**：产品经理 许清楚
> **日期**：2026-09-15 ｜ **读者**：主理人、架构师、工程师、QA
> **基线**：`docs/02-design/SECURITY-GOVERNANCE.md`（§3.3 审批闸 / §3.4 关键红线 / §4.2 审计）+ `docs/02-design/INTERFACES.md`（§2.5 MCP 形态 / §3.5 任务状态与审批）+ `docs/02-design/SPEC-SKILLS.md` + `skills/winvm-orchestrator/SKILL.md`（§审批闸协议 / §高危清单）
> **性质**：**仅定义变更部分**——不改协议方法名、不新增能力、不改风险分级；未列出的需求一律维持基线不变。
> **上游**：`docs/changes/CL-015/REQUIREMENT.md`（已交付；本轮不重叠、不重开）

---

## 1. 一句话背景

WinVM Bridge 让宿主 AI Agent 完整操作一台 Windows VM（54 能力 / 5 域），走**两条通道**：**MCP 直调**（单步、结构化）与 **A2A 委派**（多步自主规划、强 GUI）。L2/L3 强制过**人工审批闸**，fail-closed。

**CL-016 要解决的问题不是「没有审批闸」，而是「同一件事，走两条通道时用户看到的信息严重不对称」**：走 MCP 时宿主 AI 能拿到 dry-run 预览 + 结构化影响清单；走 A2A 委派时，**同样的审批请求到宿主只剩一句人话摘要**——影响清单与预览在桥接层被丢弃。结果是：用户对「AI 到底要动什么」的知情权，取决于 AI 恰好选了哪条通道。

**本轮就是把这条不对称抹平**：让两条通道上，宿主 AI 都能拿到等价的审批上下文，从而真正做到「**先拟指令 → 展示影响 → 用户确认 → 再执行**」。

---

## 2. 产品目标

| # | 目标 | 可判定的成功口径 |
|---|---|---|
| G1 | **两通道审批上下文等价**：MCP 与 A2A 呈现所需的 7 个槽位（操作 / 目标 / 风险 / 影响清单 / 可逆性 / dry-run 预览 / 审批 ID + 续跑方式）在两条通道上均非空、且不劣化 | 同一 L2 意图分走两通道，槽位齐备率 **7/7 = 7/7** |
| G2 | **审批呈现统一、可照填**：一套「审批卡片」模板覆盖全部 6 份 Skill（总控 + 5 域），宿主 Agent 无需自行设计呈现 | 模板**唯一一份**，6/6 Skill 引用；槽位↔字段对照表齐备 |
| G3 | **风险分层不失真**：L2 与 L3 的呈现差异明确，L3 的「二次确认 + dry-run 前置」从一句话要求落成可执行流程；同时**不得用「一律标不可逆」掩盖真实可逆性** | L2/L3 两版模板可区分；L3 缺 dry-run 时卡片阻断；可逆性判定与参数一致 |

> **不作目标（本轮明确不追求）**：不追求「更少的审批」（审批次数不降反可能因 L3 二次确认略有增加，这是刻意的）；不追求界面化 UI（宿主界面不在本插件控制内，只交付**文本/Markdown 模板**）。

---

## 3. 本轮范围

### 3.1 需求清单总表

| ID | 需求 | 优先级 | 用户价值（一句话） |
|---|---|---|---|
| CL016-P0-01 | A2A 审批载荷补齐（`impact` / `preview` / 通道正确的续跑提示），与 MCP 通道信息等价 | **P0** | 走委派时也能看见「到底要动哪些文件/注册表」，不再只有一句人话 |
| CL016-P0-02 | 统一「审批卡片」呈现规格（纯文本/Markdown 模板，宿主可机械照填） | **P0** | 每次审批长一个样、槽位齐全，用户不用猜 AI 漏说了什么 |
| CL016-P0-03 | 分层展示规则（L2 vs L3；L3 二次确认 + dry-run 前置） | **P0** | 高危操作不会被一句「已确认」草率放过 |
| CL016-P1-01 | 总控 + 5 域 Skill 统一引用该模板；补齐 `gui-automation` / `mcp-reference` 的审批指引 | **P1** | 不管问题落在哪个域，审批提示都在，不会「换个域就没规矩」 |
| CL016-P1-02 | 拒绝 / 超时 / 取消 三种终止路径的用户可见文案 | **P1** | 被拒了、超时了、取消了，用户知道「什么都没执行」以及下一步怎么走 |
| CL016-P2-01 | 审批上下文的审计留痕（`approvalId` ↔ `traceId` 可互查 + 预览哈希） | **P2** | 事后可复核「当时给用户看的就是现在执行的」，防抵赖 |

> 计数：**P0 × 3、P1 × 2、P2 × 1**。
> **现状备注**：`tests/unit/` 现有测试文件 **23** 个（CL-015 文档记为 20）——属既有文档债，**本轮不做索引收口**，仅要求新增测试不改动既有计数口径（见 §7 NFR-5）。

### 3.2 范围边界（本轮明确不做）

| 不做项 | 原因 |
|---|---|
| VM 侧（Windows）任何源码改造 | 硬约束（§7 NFR-3）。**且经核实本轮不需要**：VM 侧 A2A 审批消息**已经**下发了 `preview` 与 `impact`（见 §5 CL016-P0-01 现状事实），缺口在宿主桥 |
| MCP / A2A 协议方法名、端点、既有字段语义变更 | 硬约束（§7 NFR-1）；纯增量 |
| 新增能力 / 调整任何能力的风险等级 | 硬约束；会牵动策略基线（`policy.default.json`）与审计语义 |
| MCP 侧 `pendingApprovals` 的显式超时回收实现 | 属**服务行为/协议语义**变更，非本轮 UX 范围；且当前 fail-closed 已由「默认不批准即不执行」成立。见 §9 Q2 |
| 真实 dry-run「预演执行」能力 | 现有 `preview` 是**静态预览**（对参数与影响的说明），不是一次不落盘的预演执行。本轮**不虚构**该能力，卡片如实标注（见 §9 Q3） |
| 宿主界面渲染、图形化审批弹窗 | 呈现层不在插件控制内；本轮只交付文本模板 |
| 索引/文档债收口（`.dev/`、测试文件计数订正） | CL-015 已有归属；本轮仅做单行订正，不重开范围 |

---

## 4. 用户故事

> 格式统一为：**场景 → 期望 → 判据**（判据均可被 QA 逐条核对）。

| # | 用户故事 | 期望（As a … I want … so that …） | 判据 |
|---|---|---|---|
| US-1 | **MCP 直调 L2** ｜用户说「把 `C:\Users\vmuser\Documents\old` 里那些旧日志删掉」 | 作为用户，我希望宿主 AI 先告诉我**删哪些、多少个、共多大、会不会进回收站**，再让我决定，免得一句「已删除」之后才发现删错目录 | 宿主收到 `APPROVAL_REQUIRED` 后呈现卡片：操作 `storage.file.delete`、影响清单非空、可逆性=可逆（默认回收站）；未确认前 VM 侧零变更 |
| US-2 | **A2A 委派 L2** ｜用户说「帮我清理 C 盘，腾出 20GB」 | 作为用户，我希望**委派出去的任务**在需要审批时，同样给我完整影响清单，而不是只回一句「该步骤需宿主确认后继续」 | `a2a.delegate` 返回的 `approval` 含 `impact` 数组（逐项与 VM 下发一致）与 `preview` 对象；卡片 7 槽非空 |
| US-3 | **L3 高危** ｜用户说「重启虚拟机」 | 作为用户，我希望高危操作**多一道关**：先看 preview，再明确二次确认，而不是随手「好的」就执行 | 卡片为 L3 版：含「不可逆」+ dry-run 预览槽 + 二次确认短句要求；缺 dry-run 时卡片阻断；未收到指定确认短句不得进入执行 |
| US-4 | **用户拒绝** | 作为用户，我说「不删了」时，我希望系统**立即停手且什么都不执行**，并告诉我可以怎么重新发起 | 拒绝后任务终止；文案明确「未执行任何变更」；不自动重试、不静默转成批准 |
| US-5 | **审批超时（fail-closed）** | 作为用户，我离开电脑一段时间回来，希望**没被批准的事一件都没做**；也希望 AI 别把「我没回」当成「我同意」 | 超时路径文案明确：审批**未获批准**、L2/L3 操作**未执行**；全文无「超时默认批准/继续」表述 |
| US-6 | **GUI 域 L2** ｜用户说「用这个软件把照片处理好导出，覆盖原图」 | 作为用户，我希望即使是「看着屏幕一步步操作」的委派任务，**写到磁盘的那一下**也要先报备影响 | GUI 多步委派任务中命中跨域 L2（如 `appops.gui.produce` 覆盖写盘）时，宿主收到含 `impact` 的审批并要求确认；`winvm-gui-automation` Skill 有明确指引与示例卡片 |
| US-7 | **审批信息完整性自检（排查向）** | 作为排障者/接手人，我希望有个明确判据判断「我拿到的审批信息是不是残缺的」，从而快速区分「桥版本旧」与「VM 没下发」 | `winvm-mcp-reference` 提供速查：缺 `impact` 的判定与两通道续跑方式差异表 |

---

## 5. 需求详情

### CL016-P0-01 · A2A 审批载荷补齐（与 MCP 通道等价）

**现状事实（已核对源码，直接采信）**

| # | 事实 | 落点 |
|---|---|---|
| F1 | **MCP 通道载荷完整**：L2/L3 未审批时返回 `error.code = APPROVAL_REQUIRED` + `approval = { approvalId, risk, capabilityId, preview, impact, resumeHint }`；`buildPreview()` 生成含 L2/L3 中文 `note` 的预览对象；`collectImpact()` 递归扫参，把盘符路径 / UNC / `HK*` 注册表项收集为 `key=value` 字符串数组 | `packages/vm-service/src/server.ts:230-237`（载荷）、`:535-553`（preview）、`:555-568`（impact） |
| F2 | **MCP 续跑机制**：`__approvalId` 被注入每个 L2/L3 工具的 `inputSchema.properties`；宿主确认后**用同一参数 + `__approvalId` 重发**，命中 `pendingApprovals` 即视为已批准 | `packages/vm-service/src/server.ts:187-191`、`:200-202` |
| F3 | **A2A 桥只提取 4 个字段**：`ExtractedApproval = { approvalId, message, risk?, capabilityId? }`；`extractApproval()` 只读 `approvalId` / `risk` / `capabilityId` / `message`，**`preview` 与 `impact` 被丢弃** | `packages/host-a2a-bridge/src/tools.ts:32-37`、`:40-60` |
| F4 | **但 VM 侧其实已经下发 preview / impact**：A2A 置 `input-required` 时的 `status.message` 含两个 part —— text（人话说明 + 续跑指引）与 data（`{ type: 'approval-request', approvalId, capabilityId, risk, preview, impact }`） | `packages/a2a-framework/src/task-store.ts:165-194`（尤其 `:181-191`） |
| F5 | **A2A data part 缺 `summary` 与 `resumeHint`**：`summary` 只出现在同消息 text part（`说明：${req.summary}`）；`resumeHint` 完全没有。A2A 的续跑语义与 MCP**不同**：`message/send` 带同 `taskId` + DataPart `{ approvalId, approved }` | `packages/a2a-framework/src/task-store.ts:172-180`；`packages/a2a-framework/src/server.ts:261-267` |
| F6 | **契约与设计文档本就要求 A2A 携带影响清单**：`ApprovalRequest` 含 `preview` / `impact`；`INTERFACES.md §3.5` 明写「任务置 `input-required` 并在 `status.message` 中给出 dry-run 预览与 `data` part（结构化影响清单）」 | `packages/contracts/src/bridge.ts:70-78`；`docs/02-design/INTERFACES.md:198-205` |
| F7 | **A2A data part 的 `type: 'approval-request'` 标记未被识别**：抽取逻辑仅凭「data part 里存在 `approvalId`」判定为审批请求 | `packages/host-a2a-bridge/src/tools.ts:42-47` |
| F8 | **Skill 层指令与数据脱节**：总控 Skill 要求 A2A 路径「先向用户展示 `approval.message` **与影响清单**」，但该通道拿不到影响清单 → 指令在此路径上不可执行 | `skills/winvm-orchestrator/SKILL.md:146-150` |

> **结论（对上游侦察的一处修正，以文件实际内容为准）**：这**不是 VM→宿主的数据缺失，而是宿主 A2A 桥在读取时的丢弃**。因此 P0 修复可全部落在**宿主侧**，`docs/changes/CL-015` 级别的「VM 侧零改动」硬约束在本轮**更容易满足**。
> **附带修正**：「与 MCP 字段对齐」不能字面照抄 `resumeHint`——两条通道的续跑协议不同，A2A 的续跑提示必须是「用 `a2a.approval.reply` + taskId/approvalId」，**不得把 MCP 的 `__approvalId` 语义混进 A2A**。

**用户价值**
用户不需要知道「AI 这次是直调还是委派」——不管哪条路，审批信息一样完整；「我批准的是这件事」这件事本身不再取决于通道。

**验收标准（可观测、可判定）**

| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | A2A 审批返回**结构化影响清单** | 构造 `input-required` 事件（data part 带 `impact: ["C:\\Users\\...\\a.log", ...]`）→ `a2a.delegate` 结果的 `approval.impact` 为数组，**逐项与 VM 下发一致**（顺序与字符串全等）→ PASS |
| A2 | A2A 审批返回 **dry-run 预览** | 同上，`approval.preview` 与 VM 下发的 `preview` **深等**；当 VM 未下发时降级为空对象或省略，**不得抛错、不得输出 `undefined` 字面量** → PASS |
| A3 | 续跑提示**按通道给对语义** | MCP 通道：提示「以同一参数 + `__approvalId` 重发」；A2A 通道：提示「用 `a2a.approval.reply` 带 `taskId` + `approvalId` 放行」。**A2A 结果中不得出现 `__approvalId`**（串用即 FAIL）→ PASS |
| A4 | 可读摘要与影响清单**并存** | 结果同时给出人话摘要（VM 的 `summary`/同消息文本）与影响清单；`summary` 缺失时回落到文本 part 首段，不出现空串/占位符 → PASS |
| A5 | **信息量不劣于 MCP** | 对同一次 L2 意图分别走两通道，比对呈现所需的 7 个槽位（操作 / 目标 / 风险 / 影响清单 / 可逆性 / dry-run 预览 / 审批 ID + 续跑方式），A2A 侧**均非空**，且可展示信息量不少于 MCP 侧 → PASS |
| A6 | **字段缺失时宽容降级**（不破既有断言） | 审批 data part 仅含 `approvalId`（即现有 `tests/unit/host-a2a-bridge.test.js:42-68` 的 fixture 形状）时：仍返回 `approvalId` 与可读摘要，`impact`/`preview` 缺省而非报错；既有审批相关断言**全部保持通过** → PASS |
| A7 | **凭据不入载荷** | 源参数含 `password` / `privateKey` / `passphrase` / token 类字段时，`approval` 的结构化结果与任何呈现文本中**均不得出现原值**（脱敏或省略）→ PASS |
| A8 | 审批闸不可绕过语义不变 | 未携带有效审批凭据的 L2/L3 调用**永远**返回待审批态；本变更不引入任何「已批准」旁路（如桥侧自行判定 `approved = true`）→ PASS |

**依赖与约束**：A1–A8 均落在**宿主侧情报透传**，无 VM 侧依赖；**不得新增/修改契约字段语义**（`packages/contracts` 既有类型不改；若需扩展只允许追加**可选**字段且不得影响既有断言）。

---

### CL016-P0-02 · 统一「审批卡片」呈现规格

**现状事实**
- **无统一模板**：总控 Skill 只说「展示影响清单」（MCP 路径 `:144`、A2A 路径 `:149`），未规定卡片**长什么样**、有哪些槽位、缺数据时怎么写。
- **各域自说自话**：`winvm-storage-manager` 要求「展示路径+大小+条目数」（`:86`）、`winvm-system-admin` 要求「展示现状 / 进程清单 / 旧值」（`:88-90`）、`winvm-app-manager` 要求「展示应用名+版本+影响范围」（`:86`）——**同一件事三种形状，用户每次要重新理解**。
- **审批覆盖不均**（关键词命中数）：`winvm-orchestrator` 19、`winvm-system-admin` 8、`winvm-storage-manager` 7、`winvm-app-manager` 4、`winvm-app-operation` 4、**`winvm-gui-automation` 0**、**`winvm-mcp-reference` 0**。
- `SPEC-SKILLS.md:79` 已把「L2/L3 操作清单 + 强制动作」列为 Skill 必备章节，但**未定义呈现格式**。

**用户价值**
用户看到的审批信息形状稳定、槽位齐整：翻到哪一步都知道「操作是什么、会动什么、能不能撤回、我该怎么回」。

**验收标准**

| # | 验收项 | 判定方式 |
|---|---|---|
| B1 | **模板唯一且被引用** | 模板正文（逐字）在仓库中**只存在一份**（落于 `skills/winvm-orchestrator/SKILL.md` 的「审批闸协议」章节或该章节直接引用的同目录文件）；5 个域 Skill **引用**而非各抄一份 → PASS |
| B2 | **7 槽完备** | 卡片固定包含：① 操作（能力 ID + 中文说明）② 目标（具体对象）③ 风险等级 ④ 影响清单 ⑤ 可逆性 ⑥ dry-run 预览 ⑦ 审批 ID + 续跑方式。缺任一槽位即 FAIL |
| B3 | **纯文本可读** | 在不渲染 Markdown 的宿主界面下逐行可读：关键信息不依赖表格对齐/加粗表达（表格可作增强，但不得承载唯一信息）→ PASS |
| B4 | **宿主可机械照填** | 提供「槽位 ↔ 数据来源字段」对照表（MCP 与 A2A 两列）；对**无数据的槽位**给出固定降级文案（如「影响清单：VM 未提供（按参数推断：…）」），**不得留空、不得写 `N/A` 了事** → PASS |
| B5 | **展示先于执行** | 模板固定位置写明「未经展示与用户确认不得执行」；卡片必含审批 ID；卡片全文不含任何「可跳过/可自动批准」表述 → PASS |
| B6 | **审批 ID 可被用户复核** | 卡片同时给出 MCP 与 A2A 的续跑指令各一行（按当前通道只保留对应一行），宿主与用户都能核对「答的是这张卡」→ PASS |

---

### CL016-P0-03 · 分层展示规则（L2 / L3）

**现状事实**
- 总控 Skill 已有一句要求：「L3 → 审批 + 二次确认 + **先 dry-run**」（`skills/winvm-orchestrator/SKILL.md:169`），但**没有可执行形状**：什么算 dry-run、二次确认要用户说什么、缺 dry-run 时怎么办，均未定义。
- VM 侧 `preview.note` 已按风险给中文提示：L3 =「L3 高危操作：将造成不可恢复的影响，请逐项确认 impact 清单」；L2 =「L2 破坏性操作：将改变系统状态，请确认影响范围」（`packages/vm-service/src/server.ts:548-551`）——**协议层已有风险分层语义，Skill 层未落成呈现规则**。
- 各域已有「可逆性」事实但表述不齐：删除默认进回收站（可逆）、`permanent: true` 不可逆、注册表 `HKLM` 需审批、分区/格式化**未注册为可用能力**。
- `winvm-gui-automation` 的能力清单**最高 L1**（会话/截图/键鼠/窗口/UIA/剪贴板，全为 L0/L1）——该域自身不产生 L2/L3 审批，但**经 A2A 委派的多步任务会命中跨域 L2 步骤**（如 `appops.gui.produce` 覆盖写盘）。

**用户价值**
L2 不被过度恐吓（如实告知「能从回收站还原」），L3 不被草率放过（必须二次确认 + 先看预览）；用户对「这个动作我到底能不能后悔」有真实预期。

**验收标准**

| # | 验收项 | 判定方式 |
|---|---|---|
| C1 | **L2 / L3 两版可区分** | 两版模板均存在；差异至少体现在：风险标注与语气、L3 独有槽位（「不可逆」+「二次确认」）→ PASS |
| C2 | **L3 强制 dry-run 前置** | L3 卡片必含 dry-run 预览槽；**未取得预览时卡片阻断**，呈现「预览未就绪 → 不可进入确认」的明确文案（而非留空继续）→ PASS |
| C3 | **L3 二次确认可执行** | L3 明确要求用户回复**指定确认短句**（完整短句，不接受「好的 / 嗯 / 可以 / 继续 / 你看着办」等泛化应答）；该规则写入模板并被域 Skill 引用 → PASS |
| C4 | **L3 不可逆标注** | `risk = L3` 时卡片必现「不可逆 / 无法自动回滚」字样 → PASS |
| C5 | **L2 可逆性如实（不得一律标不可逆）** | 删除类默认标「可逆（可进回收站还原）」；仅当参数为 `permanent: true` 且已获批时标「不可逆」。**出现「不区分参数、一律标不可逆」即 FAIL**（防止用户对真实性脱敏）→ PASS |
| C6 | **未注册能力无卡片** | 分区/格式化/卷删除（`storage.volume.destructive`，V1 未注册）**不产生审批卡片**，而是给出「本系统不提供该能力，需人工在 VM 内执行」的明确说明 → PASS |
| C7 | **L1 不弹卡片** | L0/L1 直接执行路径**不出现**审批卡片与二次确认（避免审批疲劳）；若出现即 FAIL → PASS |

---

### CL016-P1-01 · 六份 Skill 统一引用 + 补齐空白域

**现状事实**：见 CL016-P0-02 现状事实第 2、3 条（覆盖不均、`gui-automation` / `mcp-reference` 为 0）。
- `SPEC-SKILLS.md:29-34` 定义 Skill 清单为 **6 份**（orchestrator + 5 域）；`skills/` 目录实际有 **7 份**（多一个 `winvm-mcp-reference`，`domains: [meta]`，是**参考型** Skill，不在 6 份编号清单内）。

**用户价值**
换个域问问题，规矩不变：无论落到系统、应用、存储、GUI 还是软件生产，审批提示的形状与颗粒度一致。

**验收标准**

| # | 验收项 | 判定方式 |
|---|---|---|
| D1 | **引用齐全 6/6** | `winvm-orchestrator` + `winvm-system-admin` + `winvm-app-manager` + `winvm-storage-manager` + `winvm-gui-automation` + `winvm-app-operation` 各含对模板的引用（指向同一份，不复制正文）→ PASS |
| D2 | **`gui-automation` 补齐** | 明确说明：本域能力最高 L1，**但经 A2A 委派的多步 GUI 任务可能命中跨域 L2 步骤**，此时按 §审批闸协议 出卡片；并给出一个 GUI 场景示例卡片（如「导出并覆盖源文件」）→ PASS |
| D3 | **`mcp-reference` 补齐** | 新增「审批载荷排查」小节：如何判断自身拿到的审批信息是否残缺（缺 `impact` = 未透传/桥版本过旧）、两通道续跑方式差异速查表 → PASS |
| D4 | **不改语义、不新增能力** | 6 份 Skill 的 `id` / `domains` / `triggers` / 能力清单**不得增删能力 ID 或改动风险等级**；diff 只落在审批呈现相关章节 → PASS |
| D5 | **无绕过表述** | 全文检索：不存在「跳过审批 / 免审批 / 自动批准 / 直接执行不确认」类建议（对应 `SPEC-SKILLS.md:148` 红线）→ PASS |

---

### CL016-P1-02 · 拒绝 / 超时 / 取消 三种终止路径的用户可见文案

**现状事实**
- **拒绝**：A2A `a2a.approval.reply { approved: false }` → 任务转入 `rejected`；宿主侧摘要回落到「最后一条进度消息」（`packages/host-a2a-bridge/src/tools.ts:238-244`）——**没有专门的「已拒绝、未执行」文案**。
- **超时**：`a2a.delegate` 到 `timeoutMs` 后返回 `timedOut: true`，文案为「委派超时（>Ns），任务仍在 VM 侧运行，可用 `a2a.task.get` 查询结果」（`:240-241`）——**未说明审批是否被批准**，用户容易误读为「时间一到就往下走了」。
- **取消**：`a2a.task.cancel` 存在（工具清单已注册），但无「终止后已产出 artifact 仍可读」的说明。
- **MCP 侧无超时实现**：`pendingApprovals` 是内存 `Map`，无 TTL / 无过期清理，仅在执行成功后删除（`packages/vm-service/src/server.ts:177`、`:252`）。→ **fail-closed 当前的成立方式是「默认不批准 = 永不执行」，不是「超时主动作废」**。此事实必须如实反映在文案与文档中，不得宣称已有超时回收机制。
- A2A 的 `timedOut` 是**宿主侧等待超时**：任务仍挂在 VM 侧、审批仍未批准；`a2a.task.get` 可以继续取状态。**这不等于审批通过**。

**用户价值**
三种「没做成」的结局各有清楚的说法，用户知道「什么都没发生」以及下一步怎么走，不会误以为超时=默认同意。

**验收标准**

| # | 验收项 | 判定方式 |
|---|---|---|
| E1 | **三种路径文案互不混淆** | 拒绝 / 超时 / 取消 各有独立、可区分的表述；三者均明确「未执行任何变更」（确未执行时）→ PASS |
| E2 | **超时 ≠ 批准（红线）** | 出现 `timedOut` 时，文案必须同时说明：① 任务仍在 VM 侧挂起 ② **审批未获批准** ③ L2/L3 操作**不会被执行**。全文（含 Skill）不得出现「超时默认批准/继续/放行」表述 → PASS |
| E3 | **拒绝后可重试路径清楚** | 拒绝文案说明「本次未执行；如需继续请重新发起并再次确认」；**不自动重试、不把拒绝静默记为批准** → PASS |
| E4 | **取消语义清楚** | 取消文案说明任务已终止、已产出的 artifact 仍可读取、可重新发起 → PASS |
| E5 | **MCP 侧不批准永不执行** | 未携带有效 `__approvalId` 的 L2/L3 调用**永远**返回 `APPROVAL_REQUIRED`；文案不含「稍后自动执行 / 已排队」类暗示 → PASS |
| E6 | **文案与真实机制一致** | 文案中任何时间承诺（如「有效期」）必须与实际实现一致；**无实现依据的时间承诺不得出现在卡片里** → PASS |

---

### CL016-P2-01 · 审批上下文的审计留痕（`approvalId` ↔ `traceId`）

**现状事实**
- 契约 `AuditApproval = { approvalId, approvedBy, approvedAt, previewHash }`，`AuditRecord.approval?` 可承载；`previewHash` 的注释已写明用途「防止审批与实际执行不一致」（`packages/contracts/src/audit.ts:28-34`、`:47`）。
- `SECURITY-GOVERNANCE.md §3.3` 定义「审批记录包含：审批者、时间、预览内容哈希、审批结果（批准/拒绝/超时）」；§4.2 的审计记录结构含 `traceId` 与 `principal.channel`（区分 `mcp` / a2a 通道）。
- 现状：**审批呈现内容（用户看到的卡片）与审计记录之间没有显式关联**——事后难以回答「当时给用户看的，就是现在执行的这件事吗」。

**用户价值**
可复核、可追责：出事之后能拉出「谁在什么时间、哪个通道、看到什么预览、批准了什么、结果如何」的完整链条。

**验收标准**

| # | 验收项 | 判定方式 |
|---|---|---|
| F1 | **双向可查** | 给定 `approvalId` 可检出其 `traceId` 与通道（`mcp` / a2a）；给定 `traceId` 可检出其审批事件（若有）→ PASS |
| F2 | **预览哈希与一致性告警** | 记录含审批预览内容哈希；**预览与执行内容不一致时可被发现**（哈希比对失败即标记，不静默通过）→ PASS |
| F3 | **结果四态可辨** | 批准 / 拒绝 / 超时 / 取消 四种结果在留痕中可区分（不得全部折叠为「未批准」）→ PASS |
| F4 | **不为此破坏 VM 零改动** | 若某实现路径必须改 VM 侧源码才成立，则**降级为宿主侧记录**形态，不得据此破坏 §7 NFR-3 → PASS |
| F5 | **凭据不入审计** | 哨兵值断言：审计行内不含 `password` / `privateKey` / `passphrase` 原值（沿用现有脱敏专项）→ PASS |

---

## 6. 呈现规格稿（本轮的「UI 稿」）

> 形式：**纯文本 / Markdown 模板**，宿主 Agent 照填即可。下面两例是**规格的规范样例**，字段填充规则见 §6.3。

### 6.1 L2 版（破坏性可回滚类）

```text
🔐 需要你确认（L2 破坏性操作）

[操作] storage.file.delete（删除文件）
[目标] C:\Users\vmuser\Documents\old（3 个文件）
[通道] A2A 委派 · task_01J8QX  ←（MCP 直调时写：MCP 直调）
[风险] L2 — 破坏性：会改变系统状态
[影响清单] 3 项
  1. C:\Users\vmuser\Documents\old\a.log（12.4 MB）
  2. C:\Users\vmuser\Documents\old\b.log（8.1 MB）
  3. C:\Users\vmuser\Documents\old\c.log（2.3 MB）
[可逆性] 可逆 —— 默认进回收站，可从回收站还原
[预览] 将删除 3 个文件，预计释放 22.8 MB；不触碰该目录以外的路径
[审批ID] apr_8f3c

请回复「批准」以继续，或回复「拒绝」以终止。
未经确认不会执行任何变更。

（MCP 通道续跑指令）以同一参数并附 __approvalId="apr_8f3c" 重新调用本工具
（A2A 通道续跑指令）a2a.approval.reply { taskId: "task_01J8QX", approvalId: "apr_8f3c", approved: true }
```

### 6.2 L3 版（关键高危、不可逆类）

```text
⛔ 高危操作，需要二次确认（L3）

[操作] system.power.control（关机 / 重启 / 休眠）
[目标] 虚拟机 172.16.100.2
[通道] MCP 直调
[风险] L3 — 关键高危
[影响清单] 1 项
  1. 目标机 172.16.100.2 将失去响应，当前所有前台会话与未保存内容受影响
[可逆性] ⚠️ 不可逆 —— 无法自动回滚
[预览·dry-run] 已展示将执行的动作与影响范围；本次预览未执行任何变更
[审批ID] apr_9d21

⚠️ 二次确认（必填）：
请回复完整短句「确认执行关机」以继续。仅回复「好的 / 可以 / 继续」不会被接受。
在完成上述二次确认前，本操作不会被执行。

（MCP 通道续跑指令）以同一参数并附 __approvalId="apr_9d21" 重新调用本工具
```

> **L3 缺预览时（阻断态）**：
> ```text
> ⛔ 高危操作已阻断：dry-run 预览未就绪，无法进入确认流程。
> 请先取得预览（重新发起该操作以获取 preview），再考虑确认。
> ```

### 6.3 槽位 ↔ 数据来源对照表（宿主照填用）

| 槽位 | MCP 直调来源 | A2A 委派来源 | 无数据时的降级文案 |
|---|---|---|---|
| 操作 | `approval.capabilityId`（+ 工具 `title`） | `approval.capabilityId` | 「操作：<未提供>（请勿确认）」——**不得猜测** |
| 目标 | `approval.preview.params` 中的路径/对象字段 | 同左（`preview` 透传后字段一致） | 「目标：见影响清单」 |
| 通道 | 固定「MCP 直调」 | 固定「A2A 委派 · <taskId>」 | 不适用 |
| 风险 | `approval.risk` | `approval.risk` | 无 => 不出卡片，明确报错 |
| 影响清单 | `approval.impact[]` | `approval.impact[]`（透传后） | 「影响清单：VM 未提供（按参数推断：…）」——须标注为**推断** |
| 可逆性 | 由 `preview.params` + 能力语义判定（如 `permanent`） | 同左 | 「可逆性：未知 —— 按不可逆处理」 |
| dry-run 预览 | `approval.preview.note` + `preview` 关键字段 | 同左（`preview` 透传后） | L2：「预览：未提供」；**L3：阻断** |
| 审批 ID + 续跑 | `approval.approvalId` + `resumeHint` | `approval.approvalId` + A2A 续跑指令 | 无 => **不得出卡片**（无从应答） |

> **填充红线**：① 任一槽位不得留空或写 `N/A`；② 无数据时必须显式标注「未提供 / 推断」，**不得编造**；③ 凭据类字段（`password`/`privateKey`/`passphrase`/token）**永不进入卡片**；④ 两张卡片中的可逆性判定必须与参数一致（C5）。

---

## 7. 非功能需求（硬约束 · 本轮不可协商）

| ID | 约束 | 可判定性 |
|---|---|---|
| NFR-1 | **纯增量、不动协议**：不改 MCP / A2A 的**方法名、端点、既有字段语义**；`packages/contracts` 既有类型不删除/不改名/不改语义（如需扩展只允许追加**可选**字段，且不得改变既有断言结果） | 契约文件 diff 无破坏性变更；既有 `protocols.test.js` / `policy.test.js` 断言不变 |
| NFR-2 | **审批闸不可绕过，fail-closed 不放宽**：不新增任何「跳过/自动批准/免确认」配置或代码路径；超时/未应答一律不执行 | CL016-P0-01 A8、CL016-P1-02 E2/E5、CL016-P0-02 B5 全通过 |
| NFR-3 | **VM 侧（Windows）零改动**：不改 ps-bridge / vm-service / `.cmd` 启动器 / VM 侧 Skills 落盘内容；本轮的 VM 侧产物校验值不变 | 改动清单不含 VM 侧文件；**本轮不需要 VM 改动即已满足**（依赖 CL016-P0-01 现状事实 F4） |
| NFR-4 | **Windows / macOS 宿主零行为变化**：本变更只影响**宿主 Agent 可见的审批输出文本**与 **Skill 文档**，不含平台分支逻辑改动；win32/darwin 宿主的连接器渲染、隧道、启动器行为与本轮前一致 | 平台行为比对与本轮前一致；无新增常驻进程/端口 |
| NFR-5 | **不破既有测试基线**：既有 214 项单测基线**断言不得减少或放宽**；新增测试须可**逐文件** `node --test <file>` 离线执行（仓库硬约束：禁止整批跑，规避 `link-workspace` junction 崩溃） | 逐文件执行全绿；既有 `host-a2a-bridge.test.js` / `policy.test.js` / `protocols.test.js` 结果与本轮前一致 |
| NFR-6 | **凭据红线**：`password` / `privateKey` / `passphrase` / token 类字段**永不进入**审批卡片、结构化审批输出、审计行 | 哨兵值断言全绿（CL016-P0-01 A7、P2-01 F5） |
| NFR-7 | **文档与代码同源（DDD）**：实现后 `skills/` 的审批卡片模板、`INTERFACES.md §3.5`、`SECURITY-GOVERNANCE.md §3.3` 三处对「审批呈现含影响清单」的描述必须一致；**不得再出现「文档要求展示、代码拿不到」的状态** | 三处描述逐条对齐；本 PRD 的现状事实（F3/F4）在实现后应不再成立 |

---

## 8. 增量验收门禁

> 本门禁与基线门禁、CL-015 门禁**互补不替换**：基线管「能力与安全整体就绪」，CL-015 管「鸿蒙装完可用」，本门禁管「**审批闸的呈现是否真的两条通道都说得清**」。

```
[CL-016 增量门禁]
  D1  A2A 审批载荷含 impact/preview，逐项与 VM 下发一致        : PASS / FAIL  (P0-01 A1/A2)
  D2  两通道续跑提示各自正确、不串用（A2A 无 __approvalId）     : PASS / FAIL  (P0-01 A3)
  D3  缺字段宽容降级，既有 fixture 与断言不破                   : PASS / FAIL  (P0-01 A6 / NFR-5)
  D4  可读摘要与影响清单并存；七槽非空且 A2A 不劣于 MCP         : PASS / FAIL  (P0-01 A4/A5)
  D5  审批承载物无凭据（结构化 + 呈现文本 + 审计）              : PASS / FAIL  (P0-01 A7 / P2-01 F5 / NFR-6)
  D6  审批卡片模板唯一、7 槽完备、纯文本可读                    : PASS / FAIL  (P0-02 B1/B2/B3)
  D7  槽位↔字段对照表齐备，含降级文案，「展示先于执行」在位      : PASS / FAIL  (P0-02 B4/B5/B6)
  D8  L2/L3 分层规则成立；L3 二次确认 + dry-run 前置（缺则阻断） : PASS / FAIL  (P0-03 C1–C4)
  D9  可逆性如实（不一律标不可逆）；未注册能力无卡片；L1 不弹卡  : PASS / FAIL  (P0-03 C5/C6/C7)
  D10 6 份 Skill 引用齐全 + gui/mcp-reference 补齐 + 无绕过表述  : PASS / FAIL  (P1-01 D1–D5)
  D11 拒绝/超时/取消三路径文案互不混淆；「超时 ≠ 批准」         : PASS / FAIL  (P1-02 E1–E6)
  D12 审计可还原 approvalId ↔ traceId，含预览哈希与四态结果      : PASS / FAIL  (P2-01 F1–F4)
  D13 Windows/macOS 宿主与 VM 侧零改动；214 基线不破            : PASS / FAIL  (NFR-1/3/4/5)

判定：D1–D13 全 PASS → CL-016 完成；任一 FAIL → 升级为 blocker，回流对应角色修复后重跑该项。
```

---

## 9. 开放问题（需主理人 / 用户确认）

| # | 问题 | 影响 | 建议默认 |
|---|---|---|---|
| Q1 | **A2A 通道的「目标」槽**：A2A data part 无独立「目标」字段，只有 `capabilityId` + `preview`/参数 | 卡片第 ② 槽怎么填 | 优先取 `preview` 内的路径/对象字段；缺失则写「目标：见影响清单」，**不得从 capabilityId 反推编造** |
| Q2 | **MCP 侧审批超时是否本轮补实现**：`pendingApprovals` 现为无 TTL 的内存 Map | 决定是否触碰服务行为语义 | **本轮不补**。fail-closed 由「默认不批准即不执行」成立，文案与文档如实声明；显式超时回收另立变更 |
| Q3 | **L3「先 dry-run」的强度**：现有 `preview` 是静态预览，非一次不落盘的预演执行 | 决定卡片写「预览」还是「已预演」 | 只要求「必须先展示预览 + 二次确认」；**卡片如实标「预览（未执行任何变更）」**，不虚构预演能力 |
| Q4 | **`winvm-mcp-reference` 是否纳入必改**（它不在 `SPEC-SKILLS.md` 的 6 份编号清单内，属 `meta` 参考型 Skill） | 决定改动清单数量 | **纳入**（它是排查入口），但定位为「参考 Skill」，**不改变 6 份清单的定义** |
| Q5 | **测试文件计数订正**（实际 23 vs CL-015 记录 20）是否本轮一并处理 | 是否与 CL-015 范围重叠 | 本轮仅在交付说明中**订正一行**，不做索引收口（CL-015 §CL015-P1-02 已有归属） |
| Q6 | **卡片语言**：是否需英文/双语版本 | 影响模板数量 | 先只做简体中文（与项目文档语言一致），双语列为后续 |

---

## 10. 追溯：与基线需求的对应关系

| 本轮需求 | 来源（基线 / 上轮） | 关系 |
|---|---|---|
| CL016-P0-01 | `packages/contracts/src/bridge.ts:70-78`（`ApprovalRequest.preview/impact`）｜`INTERFACES.md §3.5`｜`SECURITY-GOVERNANCE.md §3.3` | **补齐实现缺口**——契约与设计文档早要求 A2A 带影响清单，唯宿主桥未透传（文档与代码不同源） |
| CL016-P0-02 | `SPEC-SKILLS.md:79`（Skill 必备「高危清单」章节）｜`winvm-orchestrator/SKILL.md §审批闸协议` | **新增呈现规格**——此前只有「要展示」的要求，没有「长什么样」的形状 |
| CL016-P0-03 | `winvm-orchestrator/SKILL.md:164-173 §高危清单`｜`SECURITY-GOVERNANCE.md §7` | **落成可执行模板**——把「L3 = 审批 + 二次确认 + 先 dry-run」从一句话变成卡片规则 |
| CL016-P1-01 | `SPEC-SKILLS.md §4 路由 / §manifest`｜本轮覆盖命中数实测 | **统一引用 + 补齐空白域**（`gui-automation` / `mcp-reference` 原为 0 覆盖） |
| CL016-P1-02 | `SECURITY-GOVERNANCE.md §3.4`（审批超时默认拒绝）｜`host-a2a-bridge/src/tools.ts:238-244` | **文案缺口补齐**——机制存在，用户可见表述缺失 |
| CL016-P2-01 | `SECURITY-GOVERNANCE.md §4.2`（`AuditApproval.previewHash`）｜NFR-507 哈希链审计 | **激活既有契约字段**——补「审批呈现 ↔ 执行」的可复核关联 |

---

> **给下游（架构师/工程师）的一句话**：本轮**不新增能力、不动协议**，只做一件事——把「审批闸对用户说得清」这件事在**两条通道上拉平**：宿主 A2A 桥不再丢弃 VM 已经下发的 `preview` / `impact`（VM 侧因此可以零改动），并给 6 份 Skill 一套唯一的文本审批卡片模板（L2/L3 分层、L3 必须二次确认 + dry-run 前置）；任何改动都不许削弱审批闸、不许让凭据出现在呈现里、不许碰 Windows VM 与 Windows/macOS 宿主。
