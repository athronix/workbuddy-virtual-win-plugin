# 进行中 / 待定 · changing-log

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
