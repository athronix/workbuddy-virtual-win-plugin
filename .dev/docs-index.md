# 文档清单 · docs-index

## 阅读顺序建议
1. `docs/01-investigation/CONTEXT-ANALYSIS.md` —— 调研基线（WorkBuddy 宿主插件体系 + MCP/A2A 标准 + 评估建议摘要）
2. `docs/02-design/REQUIREMENTS.md` —— 功能/非功能需求
3. `docs/02-design/ARCHITECTURE.md` —— 分层解耦总体架构（1+5 双通道）
4. `docs/02-design/CAPABILITY-MODEL.md` —— 统一能力模型（L0–L3、风险分级）
5. `docs/02-design/SPEC-HOST-AGENT-PLUGIN.md` —— 宿主机 Agent 插件规范（解耦）
6. `docs/02-design/SPEC-AGENT-SERVICE-BRIDGE.md` —— 标准 Agent 服务桥接转换层规范（SPI）
6.5 `docs/02-design/LLM-PROVIDER.md` —— LLM provider（VM Agent 3 选 1：`workbuddy-deterministic` / `workbuddy` / `hermes-agent`）实现设计
6.6 `docs/02-design/HERMES-AGENT-PROVIDER.md` —— `hermes-agent` 选项设计（Nous Research 的 Hermes Agent，MCP 经 `config.yaml` 预注册，ADR-13/14，含 shared-skills 部署模型）
6.7 `docs/02-design/HOST-A2A-BRIDGE.md` —— 宿主侧 A2A 委派桥与双通道完善（简单任务 MCP 直调 / 复杂任务 A2A 委派 + ps-bridge 空闲自愈）
7. `docs/02-design/SPEC-SKILLS.md` —— Skills 框架规范
8. `docs/02-design/INTERFACES.md` —— MCP tools / A2A skills / 内部 API 契约
9. `docs/02-design/SECURITY-GOVERNANCE.md` —— 风险分级/策略引擎/审批闸/防篡改审计/会话保活
10. `docs/05-peripherals/DEPLOYMENT.md` —— 部署指南（双端一键 `setup.mjs` + `agent.provider` 选型 + §7 插件管理命令 `winvm-plugin`（host/VM 统一查验与管理）+ §8 远程 Windows 部署与 SSH 密钥认证）
11. `docs/05-peripherals/SCENARIOS.md` —— 应用场景故事/流程/机制/demo（含 Photoshop 大山→海洋 LLM 端到端）
12. `docs/05-peripherals/USER-MANUAL.md` —— 用户手册
13. `docs/06-OVERVIEW.md` —— 交付概览

## 外部输入
- `docs/design/winvm_connector_plan.html` —— 用户之前提供的评估建议（只读参考）

## 索引文件（.dev/）
- `README.md` / `project-dir-file-index.md` / `docs-index.md` / `project-dev-status.md` / `changed-log.md` / `changing-log.md`

## 最近变更
- `DEPLOYMENT.md`（§1.3 / §4.1）：VM-START 轮询端口 ≤60s 才认定启动完成；任务隐藏 node 控制台窗口（⚠️ 第十一轮修正：`InteractiveToken` 下 Windows **忽略** `Hidden=true`，实由生成的 `start-hidden.ps1` 经 `Start-Process -WindowStyle Hidden` 实现）；`session.interactive=false` 时给出「在 VM 交互式 PowerShell restart 启用 GUI」命令块；登录触发器随 VM 登录启动。
- `DEPLOYMENT.md` 新增 §7 插件管理命令 `winvm-plugin`：宿主机与 VM 部署后均落盘同一管理 CLI（自动识别上下文），覆盖 help/check/health/list/server/command/uninstall/update/reinstall；原「远程 Windows」顺延为 §8。
- **第八轮修复（`delivery/deploy-winvm-plugin.mjs` + 三安装器 + `setup.mjs` 输出重构）**：① 新增统一启动器部署器，修复 `install-vm` 步骤7 自拷贝 `winvm-plugin.mjs` 导致部署误报失败；② `winvm-plugin` 命令改为三件套（`.mjs`+`.cmd`+无扩展名 bash 启动器 +x），宿主额外部署到仓库 `delivery/`，命令真正可达；③ 新增 `killServiceProcess`，卸载/重注册/VM-START 前杀残留进程，消除可见 node 窗口；④ `setup.mjs` 计划预览与执行分离、每步显式 `✅/❌`；⑤ VM 卸载高亮可恢复目录（非系统回收站）、宿主说明 `*.winvm-bak.*` 备份保留；`DEPLOYMENT.md` §6 新增「为什么回收站里看不到某些被删的东西」FAQ。
- **第九轮（补持久化单测 + 输出一致性收尾）**：新增 `tests/unit/deploy-winvm-plugin.test.js`（4 case：异目录复制 / 自拷贝跳过 / writeContext:false / dry-run 不写盘）；修 `setup-env.test.js` 六阶段→七阶段（含 `VM-START`），并新增「各阶段仅出现一次」回归用例固化 Q2；`setup.mjs` VM-START 预览命令对齐真实重启；`deploy-winvm-plugin.mjs` 上下文跳过/写入均留痕。⚠️ 单测须**逐文件**运行（整批 `*.test.js` 因 `link-workspace` junction 在本沙箱打崩 runner 假全红）。
- **第十轮（修 install 实跑两处崩溃）**：① `install-host.mjs` 补 `node:fs` 的 `cpSync` 导入，修 HOST 步骤 `cpSync is not defined` 运行时崩溃；② `setup.mjs` `reachable()`/`waitForRemotePort()` 去掉 `-o BatchMode=yes`（与真实可用 ssh 行为对齐）+ `reachable` 加 1 次重试，修 `VM-START`/`VM-UNINSTALL` 被误判「VM 不可达」而跳过（连带致 HEALTH 失败、VM 卸载未执行）；③ VM-UNINSTALL 完成消息改述为 `.uninstall-trash/<时间戳>/`（非 Windows 回收站）。验证：`node --check` 两脚本通过、全量单测逐文件 187/187。
- **第十一轮（隐藏 VM 控制台窗口 + 补 buildTaskXml 单测）**：① 修正关键认知并修 Q3/Q4a —— `InteractiveToken` 任务下 Windows **忽略** `<Hidden>true</Hidden>`，原任务动作直接跑 `node.exe` 必弹常驻控制台窗口；改为 `buildTaskXml` 额外生成 `delivery/.generated/start-hidden.ps1`，任务动作换成 `powershell.exe -WindowStyle Hidden -File` 该脚本，内部 `Start-Process -WindowStyle Hidden … -Wait` 拉起 node（保留 `InteractiveToken` 以维持 GUI 交互式会话；`-Wait` 保持任务 Running / 可终止 / 崩溃自动重启的原语义）；② `buildTaskXml` 新增可选 `outDir` 供单测隔离，`main()` 加入口守卫使其可被 import（已核对全仓仅以子进程 / ssh 调用，无 import，行为不变）；③ 新增 `tests/unit/install-vm-task.test.js`（8 项）锁住「任务动作不得直接是 node.exe」与多层引号转义；④ 文档更正 `DEPLOYMENT.md` 两处「`Hidden=true` 不弹窗口」的错误说法，并补充「交互式会话 ≠ GUI 一定可用（锁屏 / Explorer 未跑 → `degraded`）」的 Q4b 说明。验证：`node --check` 通过、全量单测逐文件 **195/195**。

## 最近变更（第十五轮追加 · 2026-09-29）
- 新增 `docs/02-design/K5-server-replay-approval.md`：K5 服务端确定性重放设计（问题取证 / 方案时序 / 4 包改动清单 / 安全纪律 / 灰度开关 `WINVM_APPROVAL_REPLAY`）。
- 新增 `docs/test/reports/real-test-2026-09-28-k4-approval.md`：K4 审批结构化回传真机核验报告（input-required + approval-request DataPart；暴露 K5 假成功根因）。
- 待补：`docs/test/reports/k5-fix-qa-2026-09-29.md`（QA 独立深审，进行中）。
