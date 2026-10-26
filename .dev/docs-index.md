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
- `cl026-approval-presentation.md` —— CL-026 审批呈现契约
- `tunnel-crash-fix-progress.md` —— 隧道崩溃修复进度
- `gui-health-fix-2026-09-14.md` —— GUI 健康检查修复设计稿（2026-10-26 自 docs/ 根归位迁入）
- 图件：`r17-class-diagram.mermaid` / `r17-sequence-diagram.mermaid`、`kn1-class-diagram.mermaid` / `kn1-sequence-diagram.mermaid`、`class-diagram.mermaid` / `sequence-diagram.mermaid`（CL-018 对应图，2026-10-26 自 docs/ 根归位迁入）

## 研究期文档（docs/01-investigation/）
> 2026-10-26 结构重定位：原 docs/ 根级 `oh-*` 五篇归位迁入（研究/适配期口径）。
- `CONTEXT-ANALYSIS.md` —— 调研基线（阅读顺序第 1 条）
- `oh-adaptation-plan.md` —— 鸿蒙宿主适配需求 + 变更方案（P0/P1 项与 T 任务分解）
- `oh-host-selfcheck.md` —— 真机 OH 宿主 6 维可行性自检清单
- `oh-tunnel-design.md` —— 进程内 ssh2 隧道模块设计
- `oh-host-install-run-test.md` —— OH 宿主安装/运行/测试实操记录
- `oh-host-adaptation-delivery.md` —— OH 宿主适配交付记录

## 归档区（docs/archive/）
> 历史交付件统一归档地（2026-10-26 结构重定位，全程 `git mv` 保历史）。**总导航见 `docs/archive/INDEX.md`**。
- `docs/archive/changes/` —— 原 `docs/changes`：CL-015~022 + CL-K3R 变更集、phase0~6 施工 notes（子导航 `docs/archive/changes/INDEX.md`）
- `docs/archive/audit/` —— 原 `docs/audit`：全维度体检/再审计/全景综述台账（子导航 `docs/archive/audit/INDEX.md`）
- `docs/archive/test/` —— 原 `docs/test`：real-test 测试方案 + reports/ 逐轮真机与 QA 报告（子导航 `docs/archive/test/INDEX.md`）
- 归档内部不做重命名（保护 git 历史与内部互链）。
- `qa/` **保留原位不迁移**（脚本活路径：`delivery/setup.mjs` 读 `qa/probes/`、`delivery/pack-release.mjs` 写 `qa/release/`）；新增导航 `qa/INDEX.md`；测试基线权威 = `qa/` 最新 gate/sweep 件（README §8 口径）。
- 发布问题台账：`docs/release/issues.md` 已更名 `docs/release/ISSUES.md`（2026-10-26）。

## 运维总览手册
- `docs/部署与运行机制及配置总览.md` —— 部署/运行机制系统性综述 + 全部配置逐键穷举 + 坑索引速查（总览手册）

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
- 新增 `docs/archive/test/reports/real-test-2026-09-28-k4-approval.md`：K4 审批结构化回传真机核验报告（input-required + approval-request DataPart；暴露 K5 假成功根因）。
- 待补：`docs/archive/test/reports/k5-fix-qa-2026-09-29.md`（QA 独立深审，进行中）。

## 真机验证报告（2026-09-30 起新增 · 本轮补录）
- `docs/archive/test/reports/real-test-2026-09-30-r18.md` —— R18 真机轮
- `docs/archive/test/reports/real-test-2026-09-30-r19.md` —— **R19-B 真机轮权威报告**（E1 NSIS 真卸载 PASS / E2 MSI 对照 PASS 附缺陷 K-N2 / E3 dryRun 异常稳定复现 / E4 BLOCKED + 新缺陷 / E5 超时链 PASS）；新登记 **K-N1（High）**、**K-N2**、**S-4**
- `docs/archive/test/reports/r2-m4-diagnosis.md` —— R2 / M4 诊断
- `docs/archive/test/reports/a2a-coverage-2026-10-03.md` —— A2A「真机未覆盖 5 项」补齐验证（A1~A4 **PASS**；**A5 FAIL**：`rejected` 路径真机不可达）
- `docs/archive/test/reports/k3r-t05-runbook-2026-10-05.md` —— CL-K3R T05 执行序列（A~F 阶段与门禁 G0~G4）
- `docs/archive/test/reports/k3r-t05-phase-d-blocker-2026-10-05.md` —— Phase D 阻塞根因（`reconcileApprovalTruth` 门0 `if (!base.ok) return base` 短路）+ 修复
- `docs/archive/test/reports/k3r-t05-real-machine-2026-10-06.md` —— **CL-K3R T05 真机 A~F 全阶段完成报告**（`on`×3 全 `input-required`，K3 假成功根治）

## 变更文档（docs/archive/changes/）
- `CL-015` ~ `CL-020`：既有。
- **`CL-021`（R17）与 `CL-K3R`：本轮补建**（各含 REQUIREMENT / TECHNICAL-SOLUTION / QA-REPORT），补齐此前「已实现未入册」的缺口。
- **`phase0-docs-notes.md`（Phase 0 · P0-5 文档止血，2026-10-08）** —— PM 侧逐文件改动记录（7 幽灵能力摘除/标 V2、12 条名实不符如实化、4 条"已实现待挂载"标注、C2 layout 脚本移除连带、C6 测试基线新口径；含双侧 Skill 同步与全处可回溯原句）。
- **`phase0-qa-notes.md`（Phase 0 · QA 域，2026-10-08）** —— R1/R2 守卫测试（psmod 契约 + S-4/A5 装配点，`tests/unit` 净增 → 62 `.js`/1092 例）与 R3 package.json 三脚本修复记录（R3 commit `c10a400`，含删除 `layout` 死入口；C2/C6 文档口径连带由 PM 承接）。
- **`phase0-engine-notes.md`（Phase 0 · 引擎域，2026-10-08）** —— U-P0-1 normalizePath win32 段消解 + U-P0-3 dry-run A1 服务端声明制全过程（U1-U8 结论、首轮 7 红修复裁定表[6 断言错/1 实现遗漏 extractPathTokens]、变异验证 X1-X4+行为级 A/B/C、偏差登记、遗留 R-1 注册表域消解待裁/R-3 buildPreview 文案分叉）。commit `ba02fbb`。
- **`phase0-delivery-summary.md`（Phase 0 · 交付总结，2026-10-08）** —— 止血批全子项状态×提交对照表、质量关卡记录（看门狗/主理人核验/变异三域）、Phase 1 五项输入登记、下一步建议（含部署生效顺序）。

## 最近变更（第十八轮起 · 2026-09-30 ~ 2026-10-06）
- **CL-021（R17，2026-09-30）**：审批卡原生渲染（`approval-card.ts` 806 行，`show_widget` + `AskUserQuestion` 两段式，`L0_L1_NO_CARD` 独立降级码）、会话工具面诊断（`delivery/tools/diagnose-connectors.mjs` 只读诊断 + install-host 自检）、K6 能力层卸载核验（NSIS `/S` 回退 + R-0 entry 预捕获）、T02b 超时链 `capTimeoutMs ?? req.timeoutMs ?? 30_000`。QA 条件 PASS / 路由 NoOne（`tsc` EXIT=0，51 文件 736 pass / 0 fail / 2 skipped），真机 5 例 BLOCKED 遗留。
- **R19 真机轮（2026-09-30 轮次 / 执行跨 10-02）**：新登记 **K-N1（High）**——委派回合从未发起 `tools/call` 时，K5 回执反查按 `bridge.ts:914` 早退（`raisedApprovals` 为空即 `return base`）⇒ 服务端零执行记录仍报 `completed`；**K-N2**——dryRun 通道内层 `success=false` / `exitCode=-1978335230`；**S-4**——`POLICY_DENIED` 硬拒绝审计落痕（2026-10-07 已修复：`server.ts:605/837` 两处注入 `recordPolicyDeniedAudit`，回归测试 `r19c-s4-policy-denied-audit.test.js` 闭环）。K-N1 已由 `r19c-kn1-*` 共 7 个单测文件覆盖。
- **A2A 覆盖补齐（2026-10-03）**：A1 `message/stream` / A2 `tasks/list` / A3 agent card / A4 `tasks/cancel` 均 PASS；**A5 FAIL**——L2 审批闸已触发并产生 `approvalId`，但任务未挂起 `input-required`、17s 直收 `failed`，D-5 的 `rejected` 置位路径真机不可达；根因 **P1（占优）**：服务级单例 `activeTaskId`（`vm-service/src/server.ts:144`）被「已 cancel 但 runGoal 仍在飞」的上一委派 `endTask()` 清掉（`rec.cancelRequested` 全仓只写不读）。已新增 `r19c-a5-*` 单测。
- **CL-K3R（K3 静默假成功根治，2026-10-05~10-06）**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts` 的 `runPersistent` `!turn.ok` 分支补 **shadow 门控 `reconcileApprovalWait`**（shadow 仅 warn 不改判；非 shadow 命中则经 `maybeResume` 改判 `APPROVAL_REQUIRED`）；灰度开关 `approvalTruth = on | shadow | off`。T05 真机：shadow×3 观察不改（`[shadow]` warn 2/3）、**`on`×3 全 `input-required`**（`approvalId=apr_1bdd3e1e4b9e4e318b7e`、`capabilityId=app.winget.uninstall`、`risk=L2`）；宿主单测 `cl-k3r-runpersistent-approval-routing.test.js` 4/4。
- **k3r harness 收紧（2026-10-06 收尾）**：`qa/r19/a2a-extra.mjs` 默认 goal 强制「直接调 `app.winget.uninstall`、禁止 `appops.workflow.run` 间接方式」；新增 `capabilityIdsOf` 助手与 `sidestepDetected` 断言分支，消除 T2 歧义导致的探针空转。复验 PASS（`apr_7e7b60b61a0c4075b510`，`capabilityIds=["app.winget.uninstall"]`、`sidestepDetected=false`）。

## 全维度体检报告（docs/archive/audit/ · 2026-10-08）
- `2026-10-08-comprehensive-assessment.md` —— **综合评估与完善路径（总报告，先读这份）**：合并 P0 台账（U-P0-1…5）、六维评分、Phase 0~5 完善路径、owner 待决项。
- `2026-10-08-product-audit.md` —— 产品功能域（PM-01…22：幽灵能力×7、快照零实现、HTTP 口径、剪贴板名实不符）。
- `2026-10-08-architecture-audit.md` —— 架构域（ARCH-01…33 + 债务 D-1…12：dry-run 旁路、链基线重置、tasks/cancel 外观性、死字段群）。
- `2026-10-08-implementation-ops-audit.md` —— 实现+运维域（50 条：`..` 穿越已复现、有界化缺失、告警出口缺失、鸿蒙约束三面表）。
- `2026-10-08-test-docs-audit.md` —— 测试+文档域（基线口径修正 **60 个 .test.js**、S-4/A5 装配点守卫缺失、六索引一致性、ROI 路径 R1~R15）。

## 索引同步记录（2026-10-08 · 文档同步轮 · 场景 F）
- 以源码地面真相裁定 S-4 冲突：初版 `.dev/kn2-s4-a5-verify.md` 称 S-4 ❌仍存（grep 臆测旧函数名零命中），但目录级 grep 证实 `recordPolicyDeniedAudit`（approval-replay.ts:150）已注入 `server.ts:605/837` 两处 POLICY_DENIED 早退前，且回归测试 `r19c-s4-policy-denied-audit.test.js` 已纳入 1054/1054 基线 ⇒ **S-4 ✅ 已修复**，索引正确、证据文件初版作废（已校正）。
- 同步滞后概览文档：README §8 测试基线 636/634 → **1054/1054**（⚠ 2026-10-08 体检修正口径：测试文件实为 **60 个 `.test.js`** 非 59，且 `.mjs` 70 例 / delivery 8 例 / e2e 17 例不在 1054 内，见 `docs/archive/audit/2026-10-08-test-docs-audit.md`）；README §9.5「真机未验证 6 项」→ 已闭环（R18/R19/A2A 覆盖/CL-K3R T05）；`docs/06-OVERVIEW.md` 194/194 → **1054/1054**；Skill 计数统一为 7 目录（1 总控 + 5 领域 + 1 MCP 参考）。⚠ 同轮体检裁定：`changing-log.md:4-9` 与 README"已闭环"表述互斥，changed-log 漏记 S-4 代码修复（d5cb71a）——列入体检报告 Phase 0 止血批（R4）统一修复。
- 新增「逐缺陷设计稿索引（docs/design/）」导航节，纳入稳定阅读顺序。
- 以上为纯文档同步（场景 F：历史变更已发生但未完全入索引），无代码改动。

## 索引同步记录（Phase 0 · P0-5 文档止血轮 · 2026-10-08）
- **幽灵能力止血**：`CAPABILITY-MODEL.md` 升 **v1.4**（7 条未注册能力摘除/标「V2 规划·当前不可用」、12 条名实不符如实化、新增 §3.1.2「已实现待挂载」表）；`INTERFACES.md` §2.3 工具集按 definitions.ts 54 条对账；`SCENARIOS.md` 场景 C/E 主能力改写为已注册组合路径；`USER-MANUAL.md` 假 CLI `--audit tail/verify` 摘除；README §2.2/§9.4 口径修正；7 个仓库 Skill 与 connector 侧 6 个 SKILL.md 双侧同步（diff 校验一致）。全程记录见 `docs/archive/changes/phase0-docs-notes.md`。
- **C2 连带（QA R3 `c10a400`）**：根 `package.json` `layout` 脚本键已删除（指向不存在的 `scripts/dep-lint.mjs`；`dep-lint` 属 **Phase 2 规划**）。全仓文档 `npm run layout` 引用已逐处标注失效并给出"人工方向核对 / `git diff --stat` 守门"替代——处置面：`docs/design/a5-approval-drop-fix-contract.md`（SK-5 行删线注记 + E-3 勘误节闭环注记）、`a5-approval-drop-fix-impl-progress.md` §6.5、`cl-k3r-silent-false-success-design.md`（SK-K5 行 + §10.3 门禁表）、`cl-k3r-impl-progress.md` E-4、`docs/archive/changes/CL-K3R/REQUIREMENT.md` SK-K5 行。历史叙事（`.workbuddy/memory/`、docs/audit）按"历史记录不改"原则保留。
- **C6 连带（测试基线新口径）**：**70 文件 / 1162 例（1159 pass / 0 fail / 3 skip）** = 62 `.test.js`（1092）+ 8 `.test.mjs`（70），2026-10-08 QA 全量实跑。已同步：`README.md` §8（含逐文件跑命令补 `.mjs` 通配）、`docs/06-OVERVIEW.md` 两处、`.dev/project-dev-status.md`（新口径置顶 + 1054 降为历史快照保留）、`.workbuddy/memory/MEMORY.md` 关键口径行。旧口径 1054/1054（59 文件）与体检中间口径（60 文件）均留档于历史记录处。
- 本轮仍为纯文档同步，无代码改动、无 git 写操作。

## 索引同步记录（Phase 0 · 止血收官轮 · 2026-10-08 晚）
- **代码批合入**：`ba02fbb`（U-P0-1 normalizePath win32 段消解 + extractPathTokens 正斜杠盘符采集修复[第二处独立绕过面] + U-P0-3 dry-run A1 服务端声明制[supportsDryRun 6 条声明 + 双条件 fail-closed + `ext.bypass` 链上取证 + SECURITY §3.4.1] + p0-path-traversal 84 例）。至此总报告 §4 Phase 0 五子项（P0-1/P0-3/P0-4/P0-5/R3）全部闭环。
- **基线口径再迁移（收官实测）**：1162/70 → **1247 / 71 文件（1245 pass / 0 fail / 2 skip）** = 63 `.test.js`(1177) + 8 `.test.mjs`(70)；skip 3→2 系 assembly-guard dry-run 软探针随 `ba02fbb` 转硬断言通过。已同步 README §8、`docs/06-OVERVIEW.md` 两处、`.dev/project-dev-status.md` 权威口径行；1162 口径降级为同日历史快照（上行 C6 记录保留原值，其时确为 70/1162）。
- **Phase 1 输入登记**（changed-log「遗留登记」+ engine-notes R-1/R-3）：注册表域段消解（U-P0-1b 候选）、buildPreview 文案分叉、VM shared-skills 重发布、skill version bump；连同 owner 已批的 ARCH-06 A2 / ARCH-22 真取消 / ARCH-05 三态落链 / ARCH-07 bearer / ARCH-17-18 白名单批与 A5 真机复验窗。

## 索引同步记录（Tier3+4 结构重定位 · 2026-10-26）
- **归档迁移（git mv 全程保历史）**：`docs/changes` → `docs/archive/changes/`、`docs/audit` → `docs/archive/audit/`、`docs/test` → `docs/archive/test/`；live 文档/代码注释中对三目录的引用路径已统一改为 `docs/archive/...`（只改路径字符串，不改正文；`.workbuddy/memory/` 历史日志按"记录不改"原则保留旧路径）。归档内新建 `INDEX.md` ×4（archive 总导航 + changes/audit/test 子导航）。
- **归位移动**：docs/ 根级 `oh-*` 五篇 → `docs/01-investigation/`；`gui-health-fix-2026-09-14.md`、`class-diagram.mermaid`、`sequence-diagram.mermaid` → `docs/design/`；相关引用路径已同步（tunnel-runbook、INSTALL-GUIDE、reference、V1.0.0-release-notes、bootstrap.mjs、部署总览等）。
- **qa/ 与 docs/design/ 保留原位**：qa/ 存在脚本活路径依赖（`delivery/setup.mjs` 读 `qa/probes/`、`delivery/pack-release.mjs` evidenceDir=`qa/release`），仅新建 `qa/INDEX.md` 导航，不动任何现有文件；docs/design/ 现行设计引用保留，仅归入上述三件。
- **更名**：`docs/release/issues.md` → `docs/release/ISSUES.md`（git mv）；`docs/release/` 目录内与 live 引用已同步。**例外**：`docs/RELEASE-NOTES.md` 内对 `issues.md` 的引用（:14/:27/:28/:30 等行）本批按分工跳过未改，待并行线合并处理。
- **`.dev/kn2-s4-a5-verify.md`** 顶部加一次性核验记录注，不移动。
- **layout 旧注修正**：上文（Phase 0 止血轮记录）「`layout` 脚本键已删除（指向不存在的 `scripts/dep-lint.mjs`）」系 2026-10-08 时点实况，**现已过时**：Phase 2 后 `npm run layout` 已恢复为 `node scripts/dep-lint.mjs`（见根 `package.json` scripts，`scripts/dep-lint.mjs` 实际存在）。历史记录按"当时为真"原则保留原文，本条为现状订正。
- **补挂索引**：`docs/部署与运行机制及配置总览.md`（运维总览手册，此前未挂）已入「运维总览手册」节；`cl026-approval-presentation.md` 与 design/ 全部图件已补入逐缺陷设计稿索引。
- 本批为纯结构 + 引用路径同步，无正文内容编辑。
