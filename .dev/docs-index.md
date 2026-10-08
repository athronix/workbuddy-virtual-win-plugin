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

## 逐缺陷设计稿索引（docs/design/）
> 非规范阅读顺序，按缺陷 / 轮次组织的设计稿与进度记录（与 `docs/02-design/` 的规范基线互补）。
- `cl-k3r-silent-false-success-design.md` —— K3 静默假成功根治设计（APPROVED）
- `cl-k3r-impl-progress.md` / `cl-k3r-e2b-e3-taskbook.md` —— K3 实现进度 / 任务册
- `kn1-delegation-audit-contract.md` —— K-N1 委派审计契约
- `r17-design.md` / `r17-connector-injection-diagnosis.md` —— CL-021（R17）设计 + 连接器注入诊断
- `r19b-s1-kn2-contract.md` —— K-N2 契约
- `a5-approval-drop-*.md`（3 篇）—— A5 审批丢弃根治
- `s5-registry-write-allowlist-pairing.md` —— S5 注册表写白名单配对
- `tunnel-crash-fix-progress.md` —— 隧道崩溃修复进度

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

## 真机验证报告（2026-09-30 起新增 · 本轮补录）
- `docs/test/reports/real-test-2026-09-30-r18.md` —— R18 真机轮
- `docs/test/reports/real-test-2026-09-30-r19.md` —— **R19-B 真机轮权威报告**（E1 NSIS 真卸载 PASS / E2 MSI 对照 PASS 附缺陷 K-N2 / E3 dryRun 异常稳定复现 / E4 BLOCKED + 新缺陷 / E5 超时链 PASS）；新登记 **K-N1（High）**、**K-N2**、**S-4**
- `docs/test/reports/r2-m4-diagnosis.md` —— R2 / M4 诊断
- `docs/test/reports/a2a-coverage-2026-10-03.md` —— A2A「真机未覆盖 5 项」补齐验证（A1~A4 **PASS**；**A5 FAIL**：`rejected` 路径真机不可达）
- `docs/test/reports/k3r-t05-runbook-2026-10-05.md` —— CL-K3R T05 执行序列（A~F 阶段与门禁 G0~G4）
- `docs/test/reports/k3r-t05-phase-d-blocker-2026-10-05.md` —— Phase D 阻塞根因（`reconcileApprovalTruth` 门0 `if (!base.ok) return base` 短路）+ 修复
- `docs/test/reports/k3r-t05-real-machine-2026-10-06.md` —— **CL-K3R T05 真机 A~F 全阶段完成报告**（`on`×3 全 `input-required`，K3 假成功根治）

## 变更文档（docs/changes/）
- `CL-015` ~ `CL-020`：既有。
- **`CL-021`（R17）与 `CL-K3R`：本轮补建**（各含 REQUIREMENT / TECHNICAL-SOLUTION / QA-REPORT），补齐此前「已实现未入册」的缺口。

## 最近变更（第十八轮起 · 2026-09-30 ~ 2026-10-06）
- **CL-021（R17，2026-09-30）**：审批卡原生渲染（`approval-card.ts` 806 行，`show_widget` + `AskUserQuestion` 两段式，`L0_L1_NO_CARD` 独立降级码）、会话工具面诊断（`delivery/tools/diagnose-connectors.mjs` 只读诊断 + install-host 自检）、K6 能力层卸载核验（NSIS `/S` 回退 + R-0 entry 预捕获）、T02b 超时链 `capTimeoutMs ?? req.timeoutMs ?? 30_000`。QA 条件 PASS / 路由 NoOne（`tsc` EXIT=0，51 文件 736 pass / 0 fail / 2 skipped），真机 5 例 BLOCKED 遗留。
- **R19 真机轮（2026-09-30 轮次 / 执行跨 10-02）**：新登记 **K-N1（High）**——委派回合从未发起 `tools/call` 时，K5 回执反查按 `bridge.ts:914` 早退（`raisedApprovals` 为空即 `return base`）⇒ 服务端零执行记录仍报 `completed`；**K-N2**——dryRun 通道内层 `success=false` / `exitCode=-1978335230`；**S-4**——`POLICY_DENIED` 硬拒绝审计落痕（2026-10-07 已修复：`server.ts:605/837` 两处注入 `recordPolicyDeniedAudit`，回归测试 `r19c-s4-policy-denied-audit.test.js` 闭环）。K-N1 已由 `r19c-kn1-*` 共 7 个单测文件覆盖。
- **A2A 覆盖补齐（2026-10-03）**：A1 `message/stream` / A2 `tasks/list` / A3 agent card / A4 `tasks/cancel` 均 PASS；**A5 FAIL**——L2 审批闸已触发并产生 `approvalId`，但任务未挂起 `input-required`、17s 直收 `failed`，D-5 的 `rejected` 置位路径真机不可达；根因 **P1（占优）**：服务级单例 `activeTaskId`（`vm-service/src/server.ts:144`）被「已 cancel 但 runGoal 仍在飞」的上一委派 `endTask()` 清掉（`rec.cancelRequested` 全仓只写不读）。已新增 `r19c-a5-*` 单测。
- **CL-K3R（K3 静默假成功根治，2026-10-05~10-06）**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts` 的 `runPersistent` `!turn.ok` 分支补 **shadow 门控 `reconcileApprovalWait`**（shadow 仅 warn 不改判；非 shadow 命中则经 `maybeResume` 改判 `APPROVAL_REQUIRED`）；灰度开关 `approvalTruth = on | shadow | off`。T05 真机：shadow×3 观察不改（`[shadow]` warn 2/3）、**`on`×3 全 `input-required`**（`approvalId=apr_1bdd3e1e4b9e4e318b7e`、`capabilityId=app.winget.uninstall`、`risk=L2`）；宿主单测 `cl-k3r-runpersistent-approval-routing.test.js` 4/4。
- **k3r harness 收紧（2026-10-06 收尾）**：`qa/r19/a2a-extra.mjs` 默认 goal 强制「直接调 `app.winget.uninstall`、禁止 `appops.workflow.run` 间接方式」；新增 `capabilityIdsOf` 助手与 `sidestepDetected` 断言分支，消除 T2 歧义导致的探针空转。复验 PASS（`apr_7e7b60b61a0c4075b510`，`capabilityIds=["app.winget.uninstall"]`、`sidestepDetected=false`）。

## 全维度体检报告（docs/audit/ · 2026-10-08）
- `2026-10-08-comprehensive-assessment.md` —— **综合评估与完善路径（总报告，先读这份）**：合并 P0 台账（U-P0-1…5）、六维评分、Phase 0~5 完善路径、owner 待决项。
- `2026-10-08-product-audit.md` —— 产品功能域（PM-01…22：幽灵能力×7、快照零实现、HTTP 口径、剪贴板名实不符）。
- `2026-10-08-architecture-audit.md` —— 架构域（ARCH-01…33 + 债务 D-1…12：dry-run 旁路、链基线重置、tasks/cancel 外观性、死字段群）。
- `2026-10-08-implementation-ops-audit.md` —— 实现+运维域（50 条：`..` 穿越已复现、有界化缺失、告警出口缺失、鸿蒙约束三面表）。
- `2026-10-08-test-docs-audit.md` —— 测试+文档域（基线口径修正 **60 个 .test.js**、S-4/A5 装配点守卫缺失、六索引一致性、ROI 路径 R1~R15）。

## 索引同步记录（2026-10-08 · 文档同步轮 · 场景 F）
- 以源码地面真相裁定 S-4 冲突：初版 `.dev/kn2-s4-a5-verify.md` 称 S-4 ❌仍存（grep 臆测旧函数名零命中），但目录级 grep 证实 `recordPolicyDeniedAudit`（approval-replay.ts:150）已注入 `server.ts:605/837` 两处 POLICY_DENIED 早退前，且回归测试 `r19c-s4-policy-denied-audit.test.js` 已纳入 1054/1054 基线 ⇒ **S-4 ✅ 已修复**，索引正确、证据文件初版作废（已校正）。
- 同步滞后概览文档：README §8 测试基线 636/634 → **1054/1054**（⚠ 2026-10-08 体检修正口径：测试文件实为 **60 个 `.test.js`** 非 59，且 `.mjs` 70 例 / delivery 8 例 / e2e 17 例不在 1054 内，见 `docs/audit/2026-10-08-test-docs-audit.md`）；README §9.5「真机未验证 6 项」→ 已闭环（R18/R19/A2A 覆盖/CL-K3R T05）；`docs/06-OVERVIEW.md` 194/194 → **1054/1054**；Skill 计数统一为 7 目录（1 总控 + 5 领域 + 1 MCP 参考）。⚠ 同轮体检裁定：`changing-log.md:4-9` 与 README"已闭环"表述互斥，changed-log 漏记 S-4 代码修复（d5cb71a）——列入体检报告 Phase 0 止血批（R4）统一修复。
- 新增「逐缺陷设计稿索引（docs/design/）」导航节，纳入稳定阅读顺序。
- 以上为纯文档同步（场景 F：历史变更已发生但未完全入索引），无代码改动。
