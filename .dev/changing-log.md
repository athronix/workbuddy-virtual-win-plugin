# 进行中 / 待定 · changing-log

> ⚠ **2026-10-08 口径对齐**（体检 R4，消除与 README §9.5「已闭环」的互斥表述）：下方「待在真实环境终验」6 项中，**VM `--self-test`、SSH 隧道端到端、codebuddy CLI 参数契约、真机 A2A 委派+共享 Skills 下发** 已在 R18/R19/CL-K3R T05 真机轮闭环（证据 `docs/test/reports/real-test-2026-09-30-r19.md`、`k3r-t05-real-machine-2026-10-06.md`）；**双连接器同生效** 部分闭环（MCP 直调+委派桥均真机跑过，"同时拉起"矩阵 M4 受会话 ToolSearch 波动 BLOCKED，见 `r2-m4-diagnosis.md`）；**hermes 真机 CLI** 仍未做（provider 已实现、离线单测覆盖）。逐项状态以 `docs/audit/2026-10-08-comprehensive-assessment.md` Phase 1-R15 为准。

## 🟡 待在真实环境终验
- [ ] **VM 侧真机 `--self-test`**：当前 e2e 已在本地用 `vm-service` 同进程完成双通道验证；需在真实 Windows VM 上跑 `node packages/vm-service/dist/cli.js --self-test` 确认 ps-bridge 常驻进程在 VM 网络/权限上下文下稳定。
- [ ] **`hermes` 真机 CLI 调用**：`adapter-agent-hermes` 当前仅完成 provider/registrar/shared-skills 单元验证与 `--self-test` 目录校验；需在真实环境安装 Hermes Agent 后，验证 `hermes chat -q -Q --yolo --source` 真实拉起、MCP（`config.yaml.mcp_servers` 预注册 + `.env` 的 `MCP_WINVM_API_KEY`）自动加载、并对外提供 A2A 服务。`HERMES_HOME`/`HERMES_CONFIG_PATH` 解析、junction 引用共享 Skills 均待真机确认。
- [ ] **SSH 隧道端到端**：dry-run 已验证安装器产物；需真机建立 `ssh -f -N -L 18443:127.0.0.1:18443` 后，从宿主机 WorkBuddy 实际调用一次工具，闭环验证。
- [ ] **双连接器在宿主侧同时生效**：宿主安装后会在 `mcp.json` 写入 `connector:winvm`（MCP 直调）与 `connector:winvm-a2a`（A2A 委派桥）。需实测 WorkBuddy 是否同时拉起并启用两个连接器条目；若只认一个，需改为单连接器合并工具面。
- [ ] **`codebuddy` CLI 参数契约**：`CliLlmBridge` 默认假设 `codebuddy --goal "…" --system-prompt "…" --mcp <endpoint> --output <dir>`，真机未验证。若实际参数不同，经 provider options `cliArgTemplate` 覆盖即可（无需改代码）。真机上请确认：`codebuddy --help` 是否支持这些参数；不支持则改为实际参数模板或 `-p` 管道输入。
- [ ] **真机 A2A 委派 + 共享 Skills 下发**：需验证 共享根 `C:/WinVMBridge/shared-skills` 经 junction 被 VM 内 Agent 引用后，能按 `skillsRoot` 读到 SKILL.md 并据此执行（当前 `skillsRoot` 默认 `C:/WinVMBridge/shared-skills`；各候选 Agent 仅 junction 引用，单一真源）。

## 🟡 可增强（非阻塞）
- [ ] **能力广度**：5 大模块目前为代表性能力集（每域 5–8 个工具），可按需扩充；注册表驱动，新增只需改 `definitions.ts` + 对应 `.ps1`。
- [ ] **审批闸 UI**：当前 L2/L3 以 `input-required` / `requiresApproval` 协议层表达；宿主侧 WorkBuddy 的确认 UX 取决于其原生支持，必要时在 Skill 层补充"先拟指令、后请确认"的提示模板。
- [ ] **更多宿主适配**：`host-sdk` 已中性化，除 WorkBuddy 外可加 `adapter-host-claude`/`adapter-host-cursor` 等（实现 `RenderPlan` 渲染为对应原生格式）。
- [ ] **更多 VM Agent 适配**：V1 LLM provider `adapter-agent-workbuddy-llm`（`workbuddy` 选型）已实现，基于 VM 内 `codebuddy` CLI；**`adapter-agent-hermes`（`hermes-agent` 选型，Nous Research 的 Hermes Agent）本轮已实现**（MCP 经 `config.yaml` 预注册）；后续可加 `adapter-agent-langgraph` 等，实现同一桥接 SPI。

## ⬜ 未做（按用户范围，V1 不实现）
- 真实 GUI 自动化在 VM 内的 UI 测试（需显示器/会话）；当前 GUI 模块提供截图+UIA 定位+键鼠 API，未跑真实点击回归。
- 多 VM 联邦编排（当前单 VM）。

## 🟡 进行中（第十五轮追加 · 2026-09-29）
- [ ] **QA 独立深审 K5**（重派中）：安全语义（拒绝/超时零重放路径、seg.approved 透传全调用点、deriveUnderlying 脱敏覆盖、approvalId 伪造绕过面）+ 断言恒真抽查 → 报告 `docs/test/reports/k5-fix-qa-2026-09-29.md`。
- [ ] **宿主 MCP 路径 K5 真机端到端演示**（最终验收）：委派"卸载VM企业微信" → 审批卡片（含真实目标行）→ 用户批准 → 服务端确定性重放真实执行 → 审计 `-replay` executed 条目 + WXWork.exe 磁盘消失双重证据 → 任务 completed。
- [ ] **灰度 off 态 token 保留**（P2）：K4 语义下 REPLAY=off 时 token 待短 TTL 清理。
- [ ] **COMPLETION_CLAIM_PATTERN 词表有限**（P2）：LLM 措辞绕过面，根治 = bridge 直读 MCP 结构化工具结果（更大改造）。
- [ ] **workflow 场景 goalText 常缺席**（P3）：input schema 无 goal 字段，deriveUnderlying 尽力而为。

## ✅ 已闭环（第十五轮收尾 · 2026-09-29 晚）
- [x] QA 独立深审 K5 → 报告 `docs/test/reports/k5-fix-qa-2026-09-29.md`，路由 **NoOne**（191/191 复跑 + a/b/c 安全语义全成立 + 12 例断言抽查无恒真）。
- [x] 宿主 MCP 路径 K5 真机端到端演示 → **PASS**，报告 `docs/test/reports/real-test-2026-09-29-k5-e2e.md`：审批卡片含 underlying 真实目标 → 批准 → 服务端重放（审计 seq7 `-replay` approvedBy:host ok:true）→ 任务 completed。
- [ ] **🆕 K6（能力层）**：`winget uninstall` 对企业微信报假成功（exit 0 但磁盘无变化，NSIS 包无 QuietUninstallString）→ 需卸载后核验 + NSIS `/S` 回退。实测 `Uninstall.exe /S` 真实卸载成功（EXE_GONE/DIR_GONE/WINGET_REMOVED）。

## 🟡 进行中（第十六轮追加 · 2026-09-29）
- [x] **宿主审批卡原生渲染**：R17-T03 已落地（`approval-card.ts` 填充/净化 + SKILL 两段式门禁 + 模板 v1.1 §10）；QA 离线回归全绿（r1 68/68 + 21 边界探针零抛穿），**真机端到端闭环 BLOCKED** → 遗留至真机轮（见下 R17 段）。
- [x] **会话工具面注入保障**：R17-T04 已落地（`diagnose-connectors.mjs` 只读诊断 + install-host 末尾自检 + orchestrator 工具缺失指引）；QA 本机抽测全过（exit 0/1 语义、零写入实证），**矩阵 M4 连续≥3 新会话 ToolSearch 命中 BLOCKED** → 遗留至真机轮。
- [x] **K6 能力层修复**（承前）：R17-T01/T02/T02b 已落地（verified/fallbackUsed 契约 + app.ps1 R-1…R-8 状态机 + NSIS /S 回退 + A2A 超时注册表权威）；QA r3 35/35 + 消费者四处对齐 + PS 静态配平过，**企业微信 NSIS/MSI 对照、dryRun/exit≠0/600s/长卸载不掐断实测 BLOCKED** → 遗留至真机轮。

## ✅ 已闭环（第十七轮 P4 · 2026-09-30）
- [x] **R17 P4 集成回归（T05 离线可证部分）** → 报告 `docs/test/reports/r17-qa-2026-09-30.md`，结论 **条件 PASS / 路由 NoOne**：tsc EXIT=0；全量 51 文件 **736 pass / 0 fail / 2 skipped**（修复前唯一 fail 为 `sandbox-allowwrite` 测试桩缺 `renderConnectorEntry` 导出——`d183a76` 基线即坏，**非 R17 回归**，QA 自修一行桩后 9/9 pass）；`__approvalId` 全仓逐处语境核查合规（A2A 卡片产物源码+dist 零标记，双向净化实证）；SKILL 严格禁止恰 5 条 + 工具缺失指引零自动批准路径；host-a2a-bridge/src、contracts/、host-sdk/ 零改动复核成立；K6 四处消费者口径对齐；诊断工具 exit 0/1 语义 + md5 零写入 + 只读性源码核验 + install-host --dry-run 自检块零落盘；T02b 超时链 `capTimeoutMs ?? req.timeoutMs ?? 30_000` 源码逐字核对。
- [ ] **遗留（非阻塞）**：F-2 skills 域未显式承载「success=false 如实转呈」文案（旧口径零残留、注册表描述已承载，建议下轮 app-manager「已知陷阱」补一行）；F-3 `fillApprovalCard([])` reason 码归 `MISSING_APPROVAL_ID` 而非 `NO_INPUT`（拒卡结果正确，P3 码表美学差）。
- [ ] **R17 真机 BLOCKED 五例**（均因需 Windows VM 真机环境，清单见报告 §7）：①R1 审批卡端到端闭环 + 审计 -replay ②R2 矩阵 M4 连续≥3 新会话 ToolSearch 命中 ③R3 企业微信 NSIS/MSI 对照 / dryRun / exit≠0 / 600s 实测 ④T02b A2A 长卸载（>300s）不被掐断 ⑤R-4 预捕获时序真机复证。

## 🟡 进行中（第十八轮起 · 2026-09-30 ~ 2026-10-07）

- [x] **K-N1（High）核查闭环**：r19c-kn1-* 7 文件 242/242 全绿，零 tools/call 早退已根治（`runGoalInner:854` 先 `reconcileDelegationTruth` + `NO_EXECUTION_RECEIPT`）；设计文档行号漂移已校正（`kn1-delegation-audit-contract.md` / `delegation-truth.ts`）。
- [x] **K-N2 修复**：`app.ps1:693 Get-UninstallDryRunPlan` 纯查询预览，零 winget 调用；`r19b-s1-registry-forms` 35/35 + `r3-uninstall-verify` 39/39 全绿；工件 `v3-kn2.*` 留作参考（有意不提交）。
- [x] **S-4 修复**：`POLICY_DENIED` 硬拒绝现经 `recordPolicyDeniedAudit` 落 `blocked:policy-denied` 审计（`server.ts:605` & `:837` 双早退前注入）；账本跳过规则改用哨兵 `approval.approvalId==='policy-denied'` 判别（`delegation-audit.ts:383`），修正「真实规则名（`maxRisk:…`/`pathDenylist:…`）漏判污染 K-N1 账本」的二次缺口；`r19c-s4-policy-denied-audit.test.js` 7/7 + 回归 82/82（详见 `.dev/kn2-s4-a5-verify.md`）。
- [x] **A5 `rejected` 路径修复**：`server.ts:189-200` 单例 `activeTaskId` 护栏 + `raise` 归属优先取 `taskId`，`rejected` 终态可达且已由 `r19c-a5-approval-coordinator.test.js` B3（`:369`）+ `:283`/`:305` 断言；`r19c-a5-*` 26/26 全绿。残留（非阻塞）：`cancelRequested` 死字段（无读取方）。
- [ ] **k3r harness 收紧后的稳定命中复核**：单次复验已 PASS（`sidestepDetected=false`），建议再跑 ≥3 次坐实 100% 命中。
- [x] **git 提交（已解阻塞）**：本环境 git 可用（`/storage/Users/currentUser/.harmonybrew/opt/git/bin/git` v2.55.0）。CL-K3R 已提交（d3bb0b3 / 0aad7a7 / e720c53）；本轮 K-N1 行号漂移校正 + K-N2/S-4/A5 核查（`.dev/kn2-s4-a5-verify.md`）+ 索引同步合并提交。

## ✅ 迁移说明

- 第十七轮及之前的「已闭环」条目（第十五轮 K5、第十六轮、第十七轮 P4）已按 DDD 规范迁移至 `.dev/changed-log.md`，本文件不再重复承载已完成项。
- 本文件仅承载**进行中 / 待定 / 阻塞**项；新闭环项请迁移至 `changed-log.md`。
