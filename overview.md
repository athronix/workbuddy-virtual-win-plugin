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
