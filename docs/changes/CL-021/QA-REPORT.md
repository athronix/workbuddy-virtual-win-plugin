# CL-021（R17）第十七轮 P4 集成回归 QA-REPORT

> **权威数据源**：`docs/test/reports/r17-qa-2026-09-30.md`（QA 独立复跑报告；2026-09-30；执行人 严过关 / software-qa-engineer）
> **范围**：R17 全量 **10 个 commit**（等价 post facto 计入 QA 自修后为 11 个落盘点）—— `T01 8cd5da0` / `T02 96bb472` / `§A5 回写 0d7f58c` / `T03-a 0adcc97` / `T03-b dd1d779` / `T02b-a 586c003` / `T02b-b 4976146` / `T04-a df56f24` / `T04-b e712bc3` / `T04-c a0d8db3`（QA 报告自身与桩自修在 `a3308ae`）
> **最终结论**：**条件 PASS**（离线可证部分全绿；真机项 BLOCKED 见 §5）—— 智能路由判定 **NoOne**（无需回炉 software-engineer）
> **说明**：本文是该 QA 报告的**变更集归档版**，判定、数字、证据编号一律逐字取自源报告；源报告未记录的一律写「未记录」，不作推测。

---

## 1. 构建与测试统计

| 项 | 结果 |
|---|---|
| `npx tsc -b tsconfig.build.json` | **EXIT=0** ✅ |
| R17 新测试 `tests/unit/r1-approval-card.test.js` | **68/68 pass**（与预期 68 一致）✅ |
| R17 新测试 `tests/unit/r3-uninstall-verify.test.js` | **35/35 pass**（与预期 35 一致；超时守卫为第 35 条）✅ |
| 全量离线回归（`tests/unit/` 逐文件，**51 个文件**） | 修复前 **730 tests / 727 pass / 1 fail / 2 skipped**；修复后 **739 tests / 736 pass / 0 fail / 2 skipped** ✅ |

**口径备忘**：
- 单文件跑法（目录式 / 整批在本仓会 `MODULE_NOT_FOUND`，**既有口径、非回归**）。
- 先 build dist 再跑 r1（R1-8 读 `dist/approval-card.js`，仓库既有口径）。
- `2 skipped` = `ssh2-resolve.test.mjs` 两条离线专用用例因本机可解析 ssh2 而 skip（`OFFLINE_SKIP` 设计行为，非回归）。

---

## 2. 安全语义独立核查（不只信守卫）

### 2a. `__approvalId` 全仓分布核查 ✅

grep 范围：`packages/*/src`、`skills/`、`delivery/`。逐处语境判定：

| 位置 | 语境 | 判定 |
|---|---|---|
| `packages/vm-service/src/server.ts:597/607/608/671` | MCP 通道工具注册（inputSchema 续跑字段、handler 剥离、MCP resumeHint） | MCP 语境，**允许** |
| `packages/adapter-agent-workbuddy/src/index.ts:71/75` | 「既有实现」白名单：入参契约校验允许集恒含该字段（防御未剥离的直连调用方），注释明确 MCP 续跑语义 | MCP 语境，**允许** |
| `packages/adapter-host-workbuddy/src/approval-card.ts:62` | `MCP_RESUME_MARKER = '__' + 'approval' + 'Id'` **拆分构造** —— 字面量在源码不完整出现（A2A 卡片产物净化所必需的守卫本体） | **守卫本体**，允许（R1-9~10 已锁） |
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts:312-313/605/642/784-785/793/868/911/1032/1107` | K4 灰度 off 续跑提示（VM 内 Agent 通道，**非**宿主 A2A 卡片产物）；312-313 为「严禁携带」反例文案 | VM 侧 Agent 通道语境，**允许** |
| `packages/host-a2a-bridge/src/tools.ts:82/201`、`packages/core/src/constants.ts:195` | **仅注释/文档**声明「绝不含 `__approvalId`」（剥离注释后零出现） | **允许** |
| `skills/winvm-mcp-reference/SKILL.md:212-215`、`skills/winvm-orchestrator/SKILL.md:261` | MCP 通道续跑说明 + 通道隔离红线 | **允许**（且必须保留） |
| `skills/winvm-orchestrator/references/approval-card.md:33/60/142/145/187` | §9 MCP 通道续跑指引（**必须保留**，R1-10 已锁） | **允许** |
| `delivery/` | **零出现** | ✅ |

- **A2A 卡片产物源码/dist 零标记**：`grep -r "__approvalId" packages/adapter-host-workbuddy/`（含 dist）**零命中** ✅（R1-8 同时锁了编译产物）。
- **双向有效性实证**：QA 自行构造反例 —— `resumeHint='确认后以 __approvalId 重发同一请求'` 喂 `fillApprovalCard` ⇒ 仍出卡但 `resumeHintSanitized=true`、产物 HTML **零** `__approvalId`、续跑指令替换为本地标准 `a2a.approval.reply` 文本；反向 `approval-card.md` §9 串仍在（守卫 R1-10 pass）。**两方向均有效** ✅。

### 2b. `SKILL.md` 门禁核查 ✅

- 「严格禁止」恰 **5 条**（`^- ❌` 计数，与 r1 守卫同口径）：裸 ssh / 裸 powershell·psexec·winrm / 自构 HTTP 打 `/mcp` `/a2a` / 跳过审批闸 / 现场手写脚本绕行。
- 标准执行路径**四步完整**：① 调连接器工具 → ② 审批挂起两段式转呈 → ③ `a2a.approval.reply` + 轮询终态 → ④ 工具不可用即停止。
- 「工具缺失指引」（L51-56）三步**全为停止/转呈用户/等待启用路径**：跑只读诊断 → 指引用户到连接器页信任启用 + 重开会话 → 「严禁手写脚本绕行不变 —— 停下等待用户启用连接器，是本 Skill 唯一允许的等待态」。
- **零自动批准 / 零跳过确认引入** ✅。

### 2c. `git diff d183a76..HEAD` 零改动复核 ✅（**QA 报告原始复核办法，本归档未复核**）

- `packages/host-a2a-bridge/src/`、`packages/contracts/`、`packages/host-sdk/` 三处改动面**为空（零改动）** —— 该结论引自 QA 报告原判（其一贯复核办法为上述 diff；本归档环境无法复核，故按原文保留结论、不重跑）。
- R17 改动面与任务书清单一致（**19 个文件，无越界改动**）。

---

## 3. K6 消费者一致性（四处对齐抽查）✅

| 处 | 载体 | 关键口径 | 对齐 |
|---|---|---|---|
| 契约 | `definitions.ts:172-222` | 回执 required 含 `verified/fallbackUsed`；`verified.required=[exeGone,dirGone,registryGone,installerType]`、`dirGone` **三态** `boolean\|null`、`installerType` enum `nsis/msi/other/unknown`；dryRun ⇒ `verified=null` + `fallbackUsed=false`；`success` 以最终核验为准；600s 预算 | **基准** |
| PS 实现 | `app.ps1:505-853` | `Test-UninstallState` 四必填子字段恒在（注释明示与 definitions 对齐，`installLocation` 仅派生成功时出现 = 契约可选）；dryRun 分支逐字段一致；成功回执仅 6 必填（`residualEvidence` 仅失败时出现 = 契约 optional ✅）；**R-0 预捕获先于 winget** | ✅ |
| 设计文档 | `CAPABILITY-MODEL.md §3.2.1`（v1.1） | 字段清单、派生规则、NSIS-only 回退 / MSI 永不回退、dryRun 语义、非零退出不回退 | ✅ |
| skills 文案 | 全 grep `skills/` | 零消费 `exitCode` / `success` 旧语义（唯一 `exitCode` 命中在 mcps-reference 的 codebuddy CLI 登录坑，无关）；app-manager「执行→验证」与新语义不冲突；能力描述经注册表透传（definitions 内已写明「宿主必须如实转呈，不得改写为成功」） | ✅（文档缺口见 §4 F-2） |

**`app.ps1` 静态结构检查**（沙箱**无 PowerShell**，行为验证归真机）：剥离字符串与注释后 —— **大括号配平 0（最低点 0）、圆括号配平 0、25 个函数零重名**，`Uninstall-WingetPackage` 存在，`R-1…R-8` 函数族 **13 个齐备**（与 r3 守卫「函数头标注 R 编号」互证）✅。

---

## 4. 发现清单（F-1 ~ F-4）

| ID | 定性 | 内容 | 处置 |
|---|---|---|---|
| **F-1** | **测试 Bug · 已自修**（非 R17 回归） | `tests/unit/sandbox-allowwrite.test.mjs` 报 `SyntaxError: '@winvm/adapter-host-workbuddy' does not provide an export named 'renderConnectorEntry'`。该测试在临时沙箱内用最小桩替换该包，**桩未导出** `renderConnectorEntry`；而 `delivery/install-host.mjs:41` 自 **`d183a76`（R17 基线之前）** 起静态导入该符号（`d183a76`；同 commit 的测试桩即缺导出 —— 该判断为 QA 报告原始复核结论，本归档未重跑。**可在本环境直接复核的部分**：`delivery/install-host.mjs:41` 现在确实导入 `renderConnectorEntry`）。R17 的 T04 改动 install-host 时**未触及**该测试 ⇒ 任何人此间跑该文件都会失败 | QA 自修（Round 1 内）：桩补 `export function renderConnectorEntry(){return {};}` 一行；重跑 **9/9 pass**。**install-host.mjs 真实代码未经改动**，测试语义（测 sandbox 注入/移除）不受影响 |
| **F-2** | **文档缺口 · 非阻塞 P2** | `skills/winvm-app-manager` 无「`success=false` 须如实转呈残留证据、不得改写为成功」的**显式**文案。经核**不构成回归**：旧 skills 从未出现 `exitCode=0 即成功` 类可漂移旧口径（grep 零命中），且该口径已由注册表能力描述 + `CAPABILITY-MODEL §3.2.1` 承载 | 建议下轮在 app-manager「已知陷阱」补一行引用。**不判源码 Bug** |
| **F-3** | **行为观察 · 非 Bug（P3 码表美学差）** | `fillApprovalCard([])` 返回 `MISSING_APPROVAL_ID` 而非 `NO_INPUT`（数组过 `typeof==='object'` 闸）。但两者均 `ok:false` ⇒ 拒卡出 `null` ⇒ SKILL 门禁强制走逐字降级文本模板 —— **降级结果正确、无放行面**；仅 reason 码归类与文档枚举存在美学差。可选：`skipReasonFor` 增加 `Array.isArray` 归 `NO_INPUT` | 随遗留项移交，不构成本轮修复指令 |
| **F-4** | **grep 口径澄清** | 任务书 2c「字面量只允许在 MCP 语境」若按字面执行，`adapter-agent-workbuddy/src`（允许集恒含）与 `adapter-agent-workbuddy-llm/src/bridge.ts`（K4 续跑 + 禁令文案）必然命中 —— 前者即任务书白名单「tools.ts 既有实现」的同族 MCP 续跑防御（实际符号位于 `adapter-agent-workbuddy/index.ts:75`，R17 零改动），后者为 VM 侧 Agent 通道、非宿主 A2A 卡片产物 | **逐处语境核查全部合规；A2A 卡片产物源码零出现成立**（见 §2a 表） |

> **F-3 补记（非 CL-021 范围，供后续追溯）**：该项在**后续**变更集中被修复 —— **可直接读文件复核的现状**：`packages/adapter-host-workbuddy/src/approval-card.ts:464` 现已有 `if (Array.isArray(input)) return 'NO_INPUT';`（`:463` 注释标明 `R18-F3`）。仓库文档侧痕迹：`.workbuddy/memory/2026-09-30.md:54` 记「`4495156` fix(R18-F3)——`skipReasonFor` … 补 `Array.isArray→NO_INPUT` … r1 测试新增数组形态用例（68→69）」。**若不接受该 hash 归因，仅看源码现状亦成立**。
> 附带发现（同一份 memory 记录）：CL-021 的 **F-2** 亦在后续变更集中由 `1ca91f2`（docs(R18-F2)）补齐 —— app-manager SKILL 高危清单 uninstall 行追加「`success=false` 如实转呈 `residualEvidence`/`verified`」文案并引用 `CAPABILITY-MODEL §3.2.1`。两条 68/69 口径差异由此而来，引用本报告 §1 的「68/68」时须注明这是 CL-021 交付当时的数字。
> **CL-021 交付当时这两个缺口确实存在**，故本报告正文仍按源报告如实登记为遗留。

---

## 5. 边界主动攻击（21 项 QA 自构探针，`$HOME/wbtmp/edge-probe.mjs`）

**结果：20/21 通过，1 项为 reason 码归类观察项（非安全问题）；全部畸形输入零抛穿。**

| 组 | 探针 | 结果 |
|---|---|---|
| approvalId | 空串 / 纯空白 / 非字符串(123) → `MISSING_APPROVAL_ID`，`fillApprovalCard=null` 拒卡 | ✅ ×3 |
| risk 非法值 | `"L9"` / `2`(number) / `"l2"` 小写 → 均 `INVALID_RISK`（明确区分「缺失 ≠ 非法」，绝不猜测归一）；`L0/L1` → `L0_L1_NO_CARD`（直接执行语义） | ✅ ×4 |
| resumeHint 串台 | 纯 `__approvalId` 串 / **同时含标记与 a2a.reply**（一票否决）/ 非 A2A 乱串 → 全部弃用回本地标准文本，产物零标记；无 hint 无 taskId → `NO_RESUME_PATH` | ✅ ×4 |
| impact 畸形 | 2 万字符 + `<script>` 注入项 → 出卡不抛、HTML 转义、`auditApprovalCardHtml` 自检零违规；混合类型数组只透传字符串项；`[]` → 降级推断串 + `degradedSlots` 标注；对象（非数组）→ 推断降级 | ✅ ×4 |
| 结构攻击 | approvalId 含 HTML 注入 → 转义；preview 凭据键 `token`/`password` → `[已脱敏]`；10 层深嵌套 preview 不爆栈；嵌套 `approval` 形态（flat 缺失）同样净化且 L3 双确认位正确 | ✅ ×5 |
| 顶层非对象 | `[]` → `MISSING_APPROVAL_ID`（探针预期 `NO_INPUT`）；`'str'/42/true/null/undefined` → `NO_INPUT` | ⚠ 见 §4 F-3 |

---

## 6. T02b 超时链核查 ✅

| 检查 | 结果 |
|---|---|
| 源码口径 | `packages/adapter-agent-workbuddy/src/index.ts:325` = `bridge.call(impl.module, impl.fn, req.params, capTimeoutMs ?? req.timeoutMs ?? 30_000)`，与任务书口径**逐字一致** |
| `implementationOf`（L626-655） | 同源带出注册表 `timeoutMs`，且带**正的有限数守卫**（0 / 负 / NaN → `undefined` 回落 `req`）；兜底路径不带 `timeoutMs` |
| 传参位正确性 | `ps-bridge.call` 第 4 参即 `timeoutMs`（签名核对）✅ |
| 静态守卫 | `r3` 第 35 条「不得残留裸 `req.timeoutMs` 写法」pass；`4976146` 将守卫改为**剥离注释后**比对代码形态，避免注释中旧写法误报 —— 方向正确 |
| 600s 不被 300s 掐断 | K6 `timeoutMs=600_000`（`definitions.ts`）经注册表注入 ⇒ **代码路径成立**；真机不掐断实测 BLOCKED（§7-4） |
| diff 复核 | 该改动仅触 `index.ts`，未越界 |

---

## 7. T04 诊断工具抽测 ✅

| 用例 | 预期 | 实测 |
|---|---|---|
| 本机 `node delivery/tools/diagnose-connectors.mjs` | exit 0 + WARN 如实 | **EXIT=0**；WARN 两条：①账户 `8dd0df6a…` 无 winvm 条目（活跃账户不受影响）②`connector-states.v3.json` 不存在 → `state=missing` + trust/启用指引文案 |
| `--home` 指空目录 | exit 1 | **EMPTY_EXIT=1**，FAIL 两条如实（全局 `mcp.json` 缺失、stdio command 不可得）；**空目录内零文件生成** |
| 零写入 | `mcp.json` md5 不变 | 跑前后 md5 **`49055ffb…` 一致**；`install-host --dry-run` 后再验仍一致 |
| 只读性源码核验 | — | import 仅 `existsSync/readFileSync/readdirSync/statSync` + `os.homedir` + `path.join`；剥离注释后**零写 API / 零 spawn / 零网络**（唯一命中为 banner 文案字符串） |
| `install-host.mjs --dry-run` | 走到自检块 + 零落盘 | EXIT=0；末行输出 `连接器自检 : [dry-run 将执行] …（纯只读…）` —— 自检块在 dry-run 路径**正确短路、只预告不执行**；宿主面 `find -newermt` **命中 0** |

---

## 8. 真机 BLOCKED 项清单（离线沙箱不可证，需 Windows VM 真机环境）

| # | 项 | BLOCKED 原因 |
|---|---|---|
| ① | **R1 端到端**：审批卡原生渲染闭环（`approval-request` → `show_widget` 出卡 → `AskUserQuestion` 收口 → `reply` → 轮询终态）+ 审计 `-replay` 条目 | 需宿主 WorkBuddy 会话内真实工具面（`show_widget` / `AskUserQuestion` 支持深度 = 设计 U2）+ VM 真机服务 |
| ② | **R2 矩阵 M4**：连续 ≥3 个新会话 ToolSearch 命中 winvm 连接器工具 | 需 WB 平台会话注入行为；离线仅能证**注册面就位**（diagnose 已证） |
| ③ | **R3 企业微信**：NSIS/MSI 对照、dryRun 实跑、winget `exit≠0` 处置、600s 实测、`fallbackUsed` 真回退再核验 | `app.ps1` 状态机行为验证需 PowerShell + 真实包；**沙箱无 PowerShell**（本报告的静态配平/函数族仅为结构佐证） |
| ④ | **T02b**：A2A 长卸载（>300s）不被 metadata 掐断实测 | 需 VM 真机长任务 + A2A 通道计时 |
| ⑤ | **R-4 预捕获时序真机复证**（卸载成功后 entry 消失场景下 `verified` 仍强结论） | 同 ③ |

---

## 9. 智能路由判定与总判定

- **路由 = NoOne**（无需回炉 software-engineer）：
  - 唯一测试失败 **F-1** 为**基线既有**测试桩缺陷（`d183a76` 即坏），QA 已按自修口径处理（Round 1 内）；
  - R17 十个 commit 触达的所有源码面，在 **736 项离线断言 + 21 项边界探针 + 安全语义核查**下**无缺陷实证**；
  - **F-2 / F-3** 为非阻塞文档 / 码表观察，随遗留项移交，不构成本轮修复指令。
- **总体 = 条件 PASS**：离线可证部分（本报告 §1–§7）**全绿**；**最终验收以 §8 真机五项补齐为准**。

---

## 10. 环境口径备忘（本轮复现）

- （**源报告观察，本归档未复现**）`git -- <path>` 触发的 `fatal: loose object d678a174… is corrupt` 为**仓库对象库既有噪音**（全 ref 日志扫描时出现）；对本轮全部相关文件的 `git diff/log/show` 均正常，**不影响结论**。建议仓库维护者择机 `git fsck` 清理。
- 已知沙箱限制均已遵循：rm shim 坏 / `getcwd` 偶发失效 / node 绝对路径 / 单文件跑法 / dist 前置。
