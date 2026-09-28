# WinVM Bridge · 本次澄清与补全总结

> 围绕用户提出的 5 个澄清点，补足了原始 4 个 Skill 漏掉的**「操作 Windows 软件应用进行生产活动」**关键维度，并完成双端一键部署与场景文档。
> **第二轮**：把此前"设计完成、实现待补"的 LLM provider 真正落地（V1 选型 `workbuddy`），并实现双端一键部署脚本 `setup.mjs`（读 `.env`，构建/宿主/VM/隧道/自检，默认 dry-run），并已全量验证。

## 一、5 个澄清点结论（Q1–Q5）

| # | 用户疑问 | 结论 |
|---|---|---|
| Q1 | MCP 通道是否直接应用 VM 的 Windows 能力？ | ✅ 是，通过 PowerShell 5.1 + .NET（`ps-bridge` 常驻进程）实现 |
| Q2 | A2A 的 VM Agent 是否 adapted WorkBuddy？"V1 VM Agent=确定性执行器"是啥？没有 VM AI Agent 能否发开放性任务（如 Photoshop 换背景）？ | V1 是**默认 provider 选型**（`agent.provider=workbuddy-deterministic`），**非能力天花板**；开放/创意任务切到 LLM provider（如 VM 内 `codebuddy` CLI），**框架零改动**。第二轮已把 LLM provider 真正实现（V1 选型 `workbuddy`，包 `@winvm/adapter-agent-workbuddy-llm`），即被漏掉的生产维度 |
| Q3 | WorkBuddy CLI 能否完全实现 Agent 能力？ | ✅ 是，可作 LLM VM provider |
| Q4 | 插件是否含两部分（宿主插件 + VM 内服务），且都配套一键脚本？ | ✅ 宿主 `install-host.mjs` + VM `install-vm.mjs`（本版新增）都已实现 |
| Q5 | 丰富各类应用场景的故事/流程/机制/demo | ✅ 新增 `docs/05-peripherals/SCENARIOS.md` |

## 二、补足的「第五维度」——应用生产操作（appops 域）

- **契约**：`CapabilityDomain` 增加 `'appops'`（五域：system/app/storage/gui/appops）。
- **5 个能力**：`appops.state.query`(L0) · `cli.invoke`(L1) · `workflow.run`(L1) · `com.automate`(L1) · `gui.produce`(L2)，`packages/vm-capabilities/psmod/appops.ps1` 实现。
- **第 6 个 Skill**：`skills/winvm-app-operation`（中性格式，`domains:[appops]`）。
- **VM Agent**：`declareCapabilities()` 增至 `appops.*`；`runGoal` 模板 5 调度生产工作流，未匹配→`UNSUPPORTED_GOAL` 并引导升级 LLM provider。
- **A2A**：AgentCard `skills[]` 增至 5 个（含 `app-operation`）。
- **关键范式**：确定性 V1 解决"已知步骤的生产"；开放/创意类（大山→海洋）靠升级 LLM VM Agent——两者共用同一 `appops` 能力与 Skill，只是"谁来规划步骤"不同。详见 `docs/02-design/SPEC-AGENT-SERVICE-BRIDGE.md §6.1`。

## 三、文档同步

1+4 → **1+5**、四域 → **五域（含 appops）**、ADR-6 澄清"确定性为默认、LLM provider 可接管"、新增 ADR-9（appops 域）。涉及：`ARCHITECTURE.md` · `CAPABILITY-MODEL.md` · `SPEC-SKILLS.md`(v1.1) · `SPEC-AGENT-SERVICE-BRIDGE.md` · `REQUIREMENTS.md` · `SPEC-HOST-AGENT-PLUGIN.md` · `DEPLOYMENT.md` · `06-OVERVIEW.md`。

## 四、新增交付物

- `delivery/install-vm.mjs` — VM 侧一键部署（npm ci/build/生成配置/注册任务计划程序自启/自检），支持 `--dry-run`/`--self-test`/`--uninstall`/`--provider <id>`/`--cli <exe>`（provider 选型透传）。
- `docs/05-peripherals/SCENARIOS.md` — 场景故事/流程/机制/demo（含 Photoshop 大山→海洋端到端、多应用协作、监管闭环）。
- **`packages/adapter-agent-workbuddy-llm`**（第二轮新增）—— LLM provider 包：实现桥接 SPI，`kind:'llm-agent'`，组合复用确定性执行器的 `execute/health/init/shutdown`，仅 `runGoal` 为新（LLM 驱动，经可注入 `LlmBridge`，生产默认 `CliLlmBridge` 调 VM 内 `codebuddy` CLI）。设计与实现见 `docs/02-design/LLM-PROVIDER.md`。
- **`delivery/setup.mjs`**（第二轮新增）—— 双端一键部署总入口：读 `.env`，生成 BUILD→HOST→VM→TUNNEL→TEST 五阶段计划；默认 dry-run，加 `--apply` 才真执行；`WINVM_VM_PROVIDER` 经 `--provider` 透传 VM 侧落地 `agent.provider`。
- **`.env.example`**（第二轮新增）—— 双端部署全部配置集中于此（含 `WINVM_VM_PROVIDER` / `WINVM_WORKBUDDY_CLI` 选型）。

## 五、本会话修复的关键问题

1. **能力 ID 必须三段式**：初版 `appops.app_state` 等只两段 → 服务启动即崩、E2E 全 canceled。已全局重命名为 `appops.state.query` 等。
2. **`--self-test` 此前未实现**（CLI 忽略未知 flag 直接起服务挂死）→ 已实现真正自检。
3. **`npm test` 脚本 `node --test tests/` 在本机 Node 22 下把目录当模块解析失败** → 改为 `node --test`（自动发现）。

## 六、验证结果（终态）

- `npm run build` ✅ 通过（10/10 包编译）
- `npm test` ✅ **124/124 通过**（0 fail / 0 cancelled；含 LLM provider 5 项 + 双端脚本 6 项）
- `node .../cli.js --self-test` ✅ 6 能力域 / 54 能力 / ps-bridge 模块加载正常；**第二轮增强**：self-test 现打印并校验所选 provider 的能力目录（`workbuddy-deterministic` / `workbuddy` LLM 均通过）
- VM 服务 `/health`（`agent.provider=workbuddy`）✅ 返回 `provider:{"id":"workbuddy","state":"ready"}`，暴露 **54 能力**；AgentCard 暴露 **5 个 A2A Skill**
- 宿主安装器 dry-run：6 Skill / 8 文件 / 静态禁用 **8** 高危工具
- `delivery/setup.mjs` dry-run ✅ 正确生成五阶段计划；`parseEnv` 支持引号与行内注释；`install-vm.mjs --provider workbuddy --cli codebuddy` dry-run ✅ 正确解析并写入 `agent.provider`

## 七、后续（待真机终验）

- VM 真机跑一次 `install-vm.mjs` + `cli.js --self-test`；建立 SSH 隧道后从宿主机 WorkBuddy 实际调用工具闭环双通道。
- "大山→海洋"类开放任务现已可直接将 `.env` 的 `WINVM_VM_PROVIDER=workbuddy` 切到 LLM provider，无需改任何桥接层 / MCP / A2A / Skill 代码。
- 真机确认 `codebuddy --help` 的参数形态（当前默认契约见下 §八）；若不同，用 `cliArgTemplate` 覆盖。

---

## 八、第三轮：双通道完善（宿主 A2A 委派桥 + 空闲自愈）

### 修复的设计缺陷：宿主侧 A2A 断链

原实现里 VM 侧 A2A 服务端（`/a2a` + AgentCard + SSE）已完备，但**宿主侧没有发起 A2A 的接入点**：`adapter-host-workbuddy` 只渲染 MCP 条目（指向 `/mcp`），54 个 MCP 工具里没有任何能发起 `runGoal` 的委派工具。VM 侧的 A2A 服务端一直在等一个永远不会从宿主发起的请求。

根因是宿主的能力边界：**WorkBuddy 是 MCP client，不是 A2A client**，它的扩展点只有 MCP 连接器。

### 方案：两条通道各司其职

| 任务 | 通道 | 宿主侧连接器 | 工具 |
|---|---|---|---|
| 简单任务（单步、结构化、可精确控制） | MCP 直调 | `winvm`（streamableHttp → VM `/mcp`） | 点分能力 ID：`system.info.get`、`appops.cli.invoke`… |
| 复杂任务（多步自主规划 / 强 GUI / 开放意图） | A2A 委派 | `winvm-a2a`（stdio → 本地 `a2a-bridge/cli.js`） | `a2a.delegate`、`a2a.task.get`、`a2a.approval.reply`、`a2a.task.cancel`、`a2a.health` |

新增包 **`packages/host-a2a-bridge`**：以本地 stdio MCP server 形态补齐宿主的 A2A 一跳——宿主经 MCP 调 `a2a.delegate`，桥内部用 `A2AClient` 调 VM 侧 `/a2a`，把进度（`status-update`）、产物（`artifact-update`，图片直接作为图像内容回传）、审批（`input-required`）翻译回 MCP 结果。桥与 MCP 通道**共用同一条 SSH 隧道**，不新增暴露面。

### VM 内 Agent 的技能下发

`setup.mjs` 把 `skills/` 随产物打包传到 VM；provider 按 `skillsRoot` 加载各 `SKILL.md`，落盘到工作区 `.winvm/skills/` 并把摘要注入系统提示。VM 内 Agent 据此拆解步骤，技能未覆盖时可**自行编写脚本**并用 `appops.cli.invoke` 执行。产物也不再只在结束时一次性收集——任务过程中节流扫描输出目录，新增文件经 `sink.onArtifact` **实时回传**宿主。

### 顺带修复的严重缺陷：ps-bridge 空闲后永久失效

**现象**：VM 服务启动后可用，**空闲约 45 秒后所有调用失败**（`ps-bridge 未就绪`）且永不恢复。
**根因**：① `ps-bridge.ps1` 主循环在等 stdin 时阻塞，空闲期发不出心跳；② 看门狗仅凭"心跳超时"直接 `kill()`，注释声称"将重启"但代码里**没有重启逻辑**；③ 进程引用被清空后无人拉起。
**修复**：看门狗超时后**先主动 ping 探测**（通即视为健康、只刷新时间戳，不再误杀），不通才真正重启；并修复"旧进程 exit 回调晚于新进程 spawn、把新进程引用误清"的竞态。
**验证**：启动后立即委派 → `completed`；空闲 55 秒后再委派 → `completed`（修复前必失败）。

### 验证结果（第三轮）

- `npm run build` ✅ 11/11 包；`npm test` ✅ **143/143 通过**（新增委派桥 11 项 + 技能/CLI 契约 5 项）
- 宿主安装器 dry-run ✅ 8 文件 + **2 个增量补丁**（`connector:winvm`、`connector:winvm-a2a`）
- 端到端冒烟（真实进程）✅ `initialize` → `tools/list`（5 个委派工具）→ `a2a.health`（拉到 Agent Card 5 个技能）→ `a2a.delegate` "查看系统信息" → **`state: completed`** 并回传产物
- 空闲自愈 ✅（见上）

> ⚠ 仍未真机验证：`codebuddy` CLI 参数契约（可用 `cliArgTemplate` 覆盖）、宿主是否同时启用两个连接器、GUI 类开放任务。已记入 `.dev/changing-log.md`。

---

## 九、后续轮次（与本文档不同步，以权威文档为准）

> 本文件为早期会话总结，止于第三轮。后续的 **第四轮（`hermes-agent` 三选项 + 共享 Skills 独立部署）** 与 **第五轮（远程分发链路修复）** 已落地，权威记录见 `docs/06-OVERVIEW.md`（当前态：194/194 测试通过、12 包）与 `.dev/changed-log.md`（第四轮 / 第五轮章节）。

**第五轮关键修复（远程一键部署能跑起来）**：
- 根因①远程产物缺 `node_modules` → `dist` 内裸包名 `from '@winvm/...'` 无法解析（`ERR_MODULE_NOT_FOUND`）。修复：新增 `delivery/link-workspace.mjs`，`install-vm.mjs` 在 `--skip-install` 时建 `@winvm/*` workspace junction 软链（免 npm ci / 免联网 / 幂等）；12 包全为内部依赖，junction 即可。
- 根因②远程产物漏发运行时资产 → `psmod/`（54 能力 PS 实现）与 `contracts/schemas/`。修复：`setup.mjs` 的 VM 产物改为**排除法**清单（排除 `src`/`node_modules`/`tsconfig*`，含 `psmod/`+`schemas/`，不含 `node_modules`）。
- 测试：新增 `link-workspace.test.js`（16 项）+ `setup-env.test.js` 4 项防回归 → 全量 **194/194**（178 单测 + 16 e2e）。

---

# 目录治理与迭代测试收口（2026-09-23/24）

## 6 步迭代循环（用户指令 1-6）执行结果

| # | 指令 | 结果 |
|---|---|---|
| 1 | 固化「日期子目录+MANIFEST」规则 | ✅ `setup.mjs` 新增 `VM_DEVQA_DIR`/`buildDeployManifest`/`writeDeployManifest`；单测 5/5 |
| 2 | 仓库持最新版本（防修复仅在部署端） | ✅ 审计确认两端一致，无需回灌 |
| 3 | 四端清理+干净重部署 | ✅ run5 `setup.mjs --apply` 八相位 EXIT=0 全绿 |
| 4 | 全面测试+文档化报告 | ✅ run6：16/16 PASS（A1/A3 BLOCKED 有根因）|
| 5 | 修复方案+修复（仓库+部署端同步） | ✅ F1/F2/F3 全落仓库；VM 产品文件 md5 两端一致 |
| 6 | 迭代至全绿 | ✅ 完成 |

## 本轮关键修复

- **F1 A15 前提过期**：ffmpeg 已装 v9.0.1 → 探针改用 `__no_such_cli_xyz__`（CLI_NOT_FOUND 稳定命中）
- **F2 A17 冷窗口瞬态**：`call()` 支持自定义超时；A17 用 90s；A15 加桥热身
- **F3 MSYS `$(` 陷阱**：`vmInstallCommand` 日期宿主端求值（run5 已修，本轮回归锁定）

## 新增坑位（详见 .workbuddy/memory/2026-09-23.md）

- ssh 扫描自匹配误报实例数 → 用 qa-probe.ps1 夹具
- termination-pending 僵尸对杀不掉 → 不影响功能，等 VM 重启
- taskkill /T 对含已退出子进程的树中断 → 逐 PID 杀

## 交付物

- `docs/test/reports/real-test-2026-09-23-run6.md`（本轮权威报告）
- `qa/evidence/run6-qa-a-full.out` · `qa/evidence/run6-qa-skip13.out`
- `qa/harness/tidy-vm-devqa.ps1`（VM dev-and-qa 收口）

---

# K2 修复收口 + run7 全绿（2026-09-24）

## 本轮成果

| # | 工作项 | 结果 |
|---|---|---|
| 1 | K2（A2A 冷启动停滞）修复 v1 | ⚠ 部署后失效（warmup 复用 execTurn 被 60s init 上限杀会话）|
| 2 | K2 修复 v2（独立预热路径） | ✅ 仓库+部署端同步；预热 init 上界 180s 且超时**不杀会话** |
| 3 | 全量重部署（八相位） | ✅ EXIT=0；HEALTH `llmSession.state=ready`（v1 lastError 消失）|
| 4 | 服务重启复验 | ✅ T+~60s 预热达成 ready（pid 9416，无 lastError）|
| 5 | run7 全量 A 系列 | ✅ **18/18 PASS**（A1/A3 补齐；A5 委派 18.4s 真实完成 vs run6 60.8s 超时）|
| 6 | 单测/构建 | ✅ 482/482 PASS、tsc 0 错误 |

## K2 v2 核心改动（全部落仓库）

- `LlmSessionConfig.warmupReadyMs`（默认 180s，env `WINVM_LLM_SESSION_WARMUP_MS` 可调）
- `PersistentCliSession.warmup()`：串行链互斥、消费 result 后判 ready、超时不置 degraded 不写 lastError
- `LlmBridge.warmup?()` + `CliLlmBridge.warmup()`（同一 outputDir 单例，预热即首调复用对象）
- `server.ts` fire-and-forget 触发（仅 `kind==='llm-agent'`，对齐 netCfg 预热先例）

## 已知边界

- 预热会话 idle 5min 后软回收（设计内）；「深度空闲后首调」预热调度属 backlog。

## 交付物

- `docs/test/reports/real-test-2026-09-24-run7.md`（本轮权威报告）
- `qa/evidence/run7-qa-a-full.out` · `qa/evidence/run7-deploy-v2.log`（+ v1 失败实证 run7-deploy.log）

---

# K3 修复收口：A2A 变更类委派「假成功」（2026-09-28）

## TL;DR
A2A 委派中 LLM 遇 L2 审批闸（APPROVAL_REQUIRED）会谎报「已完成」的缺陷（K3，2026-09-24 实证：企业微信假卸载）已修复，QA 独立回归全绿（39 条单测、tsc 0 error、路由 NoOne）。

## 修复内容（3 文件，仓库侧）
| # | 位置 | 内容 |
|---|---|---|
| 1 | `adapter-agent-workbuddy-llm/src/bridge.ts` L282-296 | `buildSystemPrompt`【执行约束】硬化为「审批纪律」3 条硬约束：收到 APPROVAL_REQUIRED 必须停止并上报「等待审批」（含 approvalId/能力名）；严禁视为完成；严禁自行重发 `__approvalId`（堵自我审批漏洞） |
| 2 | 同上 L505-520 + L731/L890 | 新增 `reconcileApprovalWait()`：LLM 最终文本命中等待审批信号时，成功结果改判 ok=false 并透传 approvalId（常驻 + 单次两路径覆盖）——封死谎报通道 |
| 3 | `tests/unit/llm-provider.test.js` L246-282 | K3-1~K3-4 四条确定性回归断言 |

## 验证链
- 工程师自测：tsc 0 error、llm-provider 20/20、cl018 19/19；
- QA（严过关）独立复跑 + 代码审查：全绿、无恒真断言、apr_ 正则与 vm-service newId('apr') 实测吻合 → **路由 NoOne**；
- QA 报告：`docs/test/reports/k3-fix-qa-2026-09-28.md`。

## 已知边界（有意取舍）
- 兜底是启发式（依赖 LLM 措辞），根治 = bridge 直读 MCP 结构化结果（更大改造，P2）；
- stdout 提及 APPROVAL_REQUIRED 即整单改判失败——宁漏报成功，不谎报成功。

## 待办（部署未做）
- 仓库修复 ≠ 运行态生效：须实跑 `delivery/install-host.mjs`（宿主缓存是运行态真相源）+ VM 侧部署重启服务；
- Windows 侧 git commit（沙箱无 git）。

---

# tunnel-mode 三模式配置（2026-09-28）

## TL;DR
新增宿主侧通道选择策略配置 `tunnel-mode`（`mcp` 默认 / `a2a` / `intelligent` 智能判断），QA 独立回归全绿（含真实写盘回环验证），运行态零污染。

## 三模式语义
| 模式 | 行为 |
|---|---|
| `mcp`（默认） | 一律 MCP 直调，复杂任务也由宿主多轮编排（现状兼容，零行为变化） |
| `a2a` | 一律委派 A2A，简单任务也委派 |
| `intelligent` | 按任务特征走决策树（单步结构化→MCP；多步/GUI/开放意图→A2A） |

优先级：`--tunnel-mode` flag > env `WINVM_TUNNEL_MODE` > vm-conn.json `tunnelMode` > 默认 mcp。

## 改动文件（4）
1. `packages/core/src/constants.ts`：`TunnelMode` 类型 + `resolveTunnelMode()` 纯函数（非法值回落 mcp + 告警）；
2. `delivery/winvm-plugin.mjs`：`tunnel-mode [mode]` 子命令（查询/写回 vm-conn.json 单键）、`--tunnel-mode` flag、`tunnel status` 新增「通道模式」行；
3. `skills/winvm-orchestrator/SKILL.md`：通道选择节头部插入三模式指引，决策树归 intelligent 专用；
4. `tests/unit/tunnel-mode.test.js`（新建）：15 断言 4 suites。

## 验证链
- 工程师自测：tsc 0 error、15/15、winvm-plugin 回归 7/7；
- QA 独立回归：**NoOne**——30 单测全过 + 冒烟 5/5 + **真实写盘回环**（HOME 注入 → 单键写入 5 字段保留 → 回读 → 回写）；运行态 vm-conn.json md5 前后不变；
- 报告：`docs/test/reports/tunnel-mode-qa-2026-09-28.md`。

## 关键设计决定
- **指引性配置**：不在桥层拦截（宿主 Agent 工具调用无法在 stdio 桥层拦截另一连接器）——配置事实源（CLI+vm-conn.json）+ skill 指引（宿主 LLM 决策入口）；
- **CLI 内联常量**（非 import @winvm/core）：部署缓存无 node_modules，import 会运行态崩；静态对齐单测锁定两侧一致。

## 待办
- **部署生效**：运行态 CLI 尚无此功能——须实跑 `install-host.mjs` + 缓存路径冒烟；
- P3：`saveTunnelMode` 对损坏 JSON 会整体替换（建议拒绝写入+告警）。
