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
