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
- `setup.mjs` 双端一键部署总入口（读 `.env`：构建/宿主/VM/隧道/自检，默认 dry-run、`--apply` 真执行；VM-START 阶段轮询 VM 本机 18443 端口 ≤60s 才认定启动完成、HEALTH 阶段解析 `/health` 的 `session.interactive` 并在非交互式会话时打印 GUI 启用命令块；**第十轮修复 `reachable()`/`waitForRemotePort()` 误带 `-o BatchMode=yes` 致 `VM-START`/`VM-UNINSTALL` 偶发误判「VM 不可达」而跳过，已去除并加 1 次重试与真实 ssh 行为对齐**）
  - VM 侧产物 = `delivery` + `skills` + 各包**运行时资产**（排除 `src`/`node_modules`/`tsconfig*`，见 `packagePayloadPaths()`）+ 根 `package.json`
  - 含 `psmod/`（54 能力的 PS 实现）与 `contracts/schemas/`；**不含 node_modules**（远端改由软链解析）
- `install-host.mjs` 宿主机安装器（幂等/增量/dry-run/uninstall；**第十轮修复 `node:fs` 漏导 `cpSync` 致 HOST 安装运行时崩溃 `cpSync is not defined`**）
- `install-vm.mjs` VM 侧安装器（依赖解析/build/自启任务/自检，支持 `--provider <id>`/`--cli <exe>`/`--skills-root <dir>`/`--skip-install`/`--skip-links`；注册的计划任务为 登录即启（LogonTrigger）+ 崩溃重启 + **隐藏 node 控制台窗口**。⚠️ 第十一轮修正：`InteractiveToken` 下 Windows **忽略** `<Hidden>true</Hidden>`，故 `buildTaskXml` 额外生成 `delivery/.generated/start-hidden.ps1`，任务动作改为 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<启动器>"`，内部 `Start-Process -WindowStyle Hidden … -Wait` 拉起 node（保留 InteractiveToken 以维持 GUI 交互式会话；`-Wait` 保持任务 Running 语义）；`buildTaskXml` 新增可选 `outDir` 供单测隔离，模块末 `main()` 加入口守卫以便 import）
- `winvm-plugin.mjs` 插件管理 CLI（host/VM 同一份，自动识别上下文）：`help`/`check`/`health`/`list[skills,mcp-servers,mcp-tools,dirs]`/`server[start,status,stop,restart]`/`command`/`uninstall[--vm]`/`update`/`reinstall`；零外部依赖（仅 Node 内置 http/net/child_process）。启动器三件套（`.mjs`+`.cmd`+无扩展名 bash 启动器）由 `deploy-winvm-plugin.mjs` 统一生成：`install-host.mjs` 部署到插件缓存根 + 仓库 `delivery/`（`writeContext:false` 避免 host 上下文随 tar 发到 VM）、`install-vm.mjs` 落盘于 `delivery/`（写 `side:vm`）
- `deploy-winvm-plugin.mjs` **winvm-plugin 启动器部署器**：复制 `winvm-plugin.mjs` 到目标目录（跳过 `binSrc===binDst` 的自拷贝，修复 tar 已含该文件时 `cpSync` 误报失败），写 `.winvm-context.json` 标记 + `.cmd` + 无扩展名 bash 启动器（`#!/usr/bin/env bash` + 经 `bash -c chmod +x` 置可执行位）；`writeContext` 可关（仓库 delivery 部署不写上下文，防误发 VM）；上下文跳过/写入均留痕（含 dry-run 标记）
- `tests/unit/deploy-winvm-plugin.test.js` **`deployWinvmPlugin` 持久化单测**（4 case）：异目录复制+三件套落地 / `binSrc===binDst` 自拷贝跳过 / `writeContext:false` 不写上下文 / dry-run 不写盘；临时目录隔离，不触碰真实仓库 `delivery/`
- `tests/unit/setup-env.test.js` **`setup.mjs` 配置与 `buildPlan` 单测**（含「七阶段 + 各阶段仅出现一次」回归用例，固化 Q2 不再重复执行）
- `tests/unit/install-vm-task.test.js` **`buildTaskXml` 单测**（8 case，第十一轮新增）：任务动作**不得**直接是 node.exe（窗口重现的回归点）/ `powershell -File` + `-WindowStyle Hidden` 启动 / ps1 内 `Start-Process -WindowStyle Hidden … -Wait` / `cliArgs` 原样落地（含内层双引号）/ 单引号按 PowerShell 规则双写转义 / task.xml 为 UTF-16LE + BOM / 保留 `InteractiveToken`；临时目录隔离，不触碰真实仓库
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
- GUI 会话健康判定：`packages/vm-capabilities/psmod/gui.ps1` → `Get-SessionHealth`（`interactive` = SessionId>=1 且窗口站 WinSta0 且 explorer 在跑；`locked`（LogonUI 存在＝锁屏）→ `degraded`；Session 0 → `unavailable`）
- 总控 Skill：`skills/winvm-orchestrator/SKILL.md`
