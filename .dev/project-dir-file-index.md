# 目录与文件地图 · project-dir-file-index

## 顶层
```
workbuddy-virtual-win-plugin/
├── package.json              # workspace 根（npm workspaces，12 包）
├── tsconfig.base.json        # 共享 TS 配置（strict, ESM）
├── tsconfig.build.json       # 构建引用图
├── docs/                     # 调研 / 设计 / 交付文档
├── packages/                 # 12 个可独立编译/发布的 npm 包
├── skills/                   # 6 个 WorkBuddy Skill（1 总控 + 5 领域）+ 各 Skill 内的 mcps-reference 参考
├── tests/                    # unit/ + e2e/
├── delivery/                 # 安装器 + 部署配置
└── .dev/                     # DDD 六大索引
```

## packages/（L0→L3 分层）
| 包 | 层 | 职责 |
|----|----|------|
| `contracts` | L0 规范 | 全系统唯一契约源：风险/能力/传输/审计/桥接/宿主/A2A TS 类型 + JSON Schema |
| `core` | L1 核心 | transport（HTTP/SSH/stdio 抽象）、registry、policy（策略引擎）、audit（哈希链）、session（保活）、bridge（加载器）、config |
| `mcp-framework` | L2 协议 | MCP server/client（Streamable HTTP + stdio） |
| `a2a-framework` | L2 协议 | A2A v1.0 server/client（AgentCard/message/send/stream/tasks/*/artifacts/input-required） |
| `host-sdk` | L3 宿主规范 | 中性插件模型 SDK（patch/skill-loader/渲染抽象） |
| `adapter-host-workbuddy` | L3 适配 | 把中性模型渲染为 WorkBuddy 原生 plugin.json/marketplace.json/connector mcp.json（两个连接器：MCP 直调 + A2A 委派桥） |
| `host-a2a-bridge` | L3 宿主 A2A 桥 | stdio MCP server，暴露 `a2a.delegate`/`task.get`/`approval.reply`/`task.cancel`/`health`，内部用 A2A client 调 VM `/a2a` |
| `vm-capabilities` | L3 VM 能力 | ps-bridge 常驻进程 + system/app/storage/gui/appops 五大 PowerShell 模块 + 能力注册表 |
| `adapter-agent-workbuddy` | L3 VM 适配 | VM 内确定性执行器（agent.provider=workbuddy-deterministic），实现桥接 SPI（可替换） |
| `adapter-agent-workbuddy-llm` | L3 VM 适配 | **LLM Agent 执行器**（agent.provider=workbuddy，V1 实现），组合复用确定性执行器、仅 runGoal 为 LLM 驱动 |
| `adapter-agent-hermes` | L3 VM 适配 | **Hermes Agent 执行器**（agent.provider=hermes-agent，Nous Research 的 Hermes Agent），复用确定性执行器/CLI 桥/SKILL 加载；MCP 经 `config.yaml` 的 `mcp_servers` 预注册（无 `--mcp` 参数） |
| `vm-service` | 装配 | 同端口双协议服务端 + CLI 入口（agent.provider 总开关，3 选项：workbuddy-deterministic / workbuddy / hermes-agent） |

## skills/
- `winvm-orchestrator` 总控 · `winvm-system-admin` · `winvm-app-manager` · `winvm-storage-manager` · `winvm-gui-automation` · `winvm-app-operation`（应用生产操作 appops）
- 每个 Skill 内含 `mcps-reference.md`：各 MCP server 部署/管理参考（供 VM AI Agent 参考调用）
- **单一真源 + symlink 部署**：各候选 VM Agent 仅通过 junction 引用 `C:/WinVMBridge/shared-skills` 下的 Skill，避免多份副本

## delivery/
- `setup.mjs` 双端一键部署总入口（读 `.env`：构建/宿主/VM/隧道/自检，默认 dry-run、`--apply` 真执行）
  - VM 侧产物 = `delivery` + `skills` + 各包**运行时资产**（排除 `src`/`node_modules`/`tsconfig*`，见 `packagePayloadPaths()`）+ 根 `package.json`
  - 含 `psmod/`（54 能力的 PS 实现）与 `contracts/schemas/`；**不含 node_modules**（远端改由软链解析）
- `install-host.mjs` 宿主机安装器（幂等/增量/dry-run/uninstall）
- `install-vm.mjs` VM 侧安装器（依赖解析/build/自启任务/自检，支持 `--provider <id>`/`--cli <exe>`/`--skills-root <dir>`/`--skip-install`/`--skip-links`）
- `link-workspace.mjs` **@winvm workspace 软链器**：为「仅含 dist 的分发产物」建 `node_modules/@winvm/<pkg>` → `packages/<pkg>` 的 junction（免管理员/免联网/幂等），解决 dist 中裸包名 import 无法解析的问题
- `deploy-shared-skills.mjs` 共享 Skills 部署器（① publish 仓库 `skills/` → 共享根 `C:/WinVMBridge/shared-skills`；② 各候选 VM Agent 经 junction 引用，幂等/dry-run）
- `vm-service.config.json` VM 侧服务配置（策略/审计/监听，含三 provider 定义：workbuddy-deterministic / workbuddy / hermes-agent）
- `.env.example` 双端部署配置模板（含 `WINVM_VM_PROVIDER` / `WINVM_HERMES_CLI` / `WINVM_SKILLS_ROOT`）

## 关键文件速查
- 风险模型：`packages/contracts/src/risk.ts`
- 策略引擎：`packages/core/src/policy/engine.ts`
- 哈希链审计：`packages/core/src/audit/chain.ts`
- A2A server：`packages/a2a-framework/src/server.ts`
- ps-bridge：`packages/vm-capabilities/src/ps-bridge.ts` + `psmod/ps-bridge.ps1`
- 总控 Skill：`skills/winvm-orchestrator/SKILL.md`
