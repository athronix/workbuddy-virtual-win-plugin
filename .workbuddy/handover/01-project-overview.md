# 01 · 项目概览（迁移交接用）

> 快速了解「这是什么、怎么搭的、有哪些硬约束」。
> 权威细节仍在仓库 `.dev/`（DDD 六索引）与 `docs/`；本文是**导航与提炼**，不是替代。

## 一句话定位

为**宿主机 WorkBuddy（AI Agent）**构建的插件，使其能**完整操作一台 Windows 虚拟机**——系统管理、应用管理、存储管理、GUI 自动化、应用生产操作，共 **54 项能力**。

## 架构：1 + 5 双通道

```
宿主机 WorkBuddy
   ├── connector:winvm      → MCP 直调（工具级精确执行，简单任务）
   └── connector:winvm-a2a  → A2A v1.0 委派（任务级，复杂/开放任务）
                                    ↓ 同一条 SSH 隧道
Windows VM 127.0.0.1:18443（同端口双协议）
   ├── /mcp   MCP Streamable HTTP
   ├── /a2a   A2A v1.0（SSE + tasks/* + input-required 审批）
   └── /.well-known/agent-card.json
                                    ↓
                        VM 内 Agent（三选一）→ ps-bridge（常驻 PowerShell 5.1）→ 真实 Windows
```

- **1**：一套统一能力模型 + 一套可替换 Agent 服务桥接层（标准 SPI）
- **5**：5 个领域 Skill（system / app / storage / gui / appops）+ 1 个总控编排 Skill
- **双通道**：MCP（工具级）+ A2A（任务级），VM 侧同端口双协议暴露

## 能力域（5 域 / 54 能力）

| 域 | 说明 | Skill |
|---|---|---|
| `system` | 系统信息、进程、服务、网络、注册表等 | `winvm-system-admin` |
| `app` | 应用安装/卸载/清单/启动 | `winvm-app-manager` |
| `storage` | 文件与目录、磁盘、搜索 | `winvm-storage-manager` |
| `gui` | 截图、UIA 定位、键鼠、窗口、剪贴板 | `winvm-gui-automation` |
| `appops` | **应用生产操作**（用 Photoshop 改图这类开放任务） | `winvm-app-operation` |
| — | 总控编排（跨域组合） | `winvm-orchestrator` |

风险分级 L0–L3：L2/L3 需审批闸（`requiresApproval` / A2A `input-required`）；安装时**静态禁用 8 个高危工具**。

## 分层与 12 个包（L0 → L3）

| 包 | 层 | 职责 |
|---|---|---|
| `contracts` | L0 | 全系统唯一契约源（TS 类型 + JSON Schema） |
| `core` | L1 | transport / registry / policy / audit（哈希链）/ session / bridge |
| `mcp-framework` | L2 | MCP server + client |
| `a2a-framework` | L2 | A2A v1.0 server + client |
| `host-sdk` | L3 | 中性插件模型 SDK（与宿主无关） |
| `adapter-host-workbuddy` | L3 | 渲染为 WorkBuddy 原生格式（两个连接器） |
| `host-a2a-bridge` | L3 | stdio MCP server，暴露 `a2a.delegate` 等 |
| `vm-capabilities` | L3 | ps-bridge + 五大 PowerShell 模块 + 能力注册表 |
| `adapter-agent-workbuddy` | L3 | 确定性执行器（默认 provider） |
| `adapter-agent-workbuddy-llm` | L3 | LLM 执行器（VM 内 `codebuddy` CLI） |
| `adapter-agent-hermes` | L3 | Hermes Agent 执行器 |
| `vm-service` | 装配 | 同端口双协议服务端 + CLI |

## VM 内 Agent：三选一（经 `WINVM_VM_PROVIDER` 切换）

| provider | 说明 | 状态 |
|---|---|---|
| `workbuddy-deterministic` | 确定性执行器（可替换的基准实现） | ✅ 默认 |
| `workbuddy` | LLM 执行器，VM 内 spawn `codebuddy` CLI | ✅ 实现，**CLI 参数契约真机未验证** |
| `hermes-agent` | Nous Research Hermes Agent | ✅ 实现，**真机未验证** |

⚠️ **Hermes CLI 没有 `--mcp` 参数**——MCP 必须预注册进 `config.yaml.mcp_servers`（url 类型 + `.env` 的 `MCP_WINVM_API_KEY` Bearer），靠 `mcp_startup.py` 自启加载。registrar 失败仅 warn 降级。

## 共享 Skills 部署范式

- **单一真源**：仓库 `skills/`（7 个 Skill，每个含 `mcps-reference.md`）
- **共享根**：`C:/WinVMBridge/shared-skills`（故意与仓库 `skills/` 分离，避免 VM 部署目录 == 仓库目录时 `cp` 自拷贝 `EINVAL`）
- 各候选 VM Agent 仅经 **junction**（Windows 免管理员）引用共享根
- 部署器：`delivery/deploy-shared-skills.mjs`（两阶段 publish → link，幂等/可 dry-run）

## 关键约束（来自用户，不可违背）

1. **VM 服务强制仅监听 `127.0.0.1`**（`requireLoopbackBind`）——安全红线，`install-vm.mjs` 会校验并中止
2. **宿主 `mcp.json` 零覆盖**：以 JSON patch 增量写入，绝不整体覆盖用户已有连接器
3. **VM 内 Agent 选型与全局框架解耦**（SPI 可替换）
4. **宿主插件规范与具体宿主解耦**（`host-sdk` 已中性化）
5. **架构高度模块化、分层解耦**
6. 方法论：**DDD（文档驱动，原则 7：改码前先改文档）+ plan-first（先规划任务树）**

## 目录地图（顶层）

```
workbuddy-virtual-win-plugin/
├── packages/       12 个 npm workspace 包（TS strict ESM）
├── skills/         7 个 Skill（1 总控 + 5 领域 + mcp-reference）
├── docs/           调研 / 设计 / 交付文档（01-investigation … 06-OVERVIEW）
├── delivery/       安装器与部署配置（setup / install-host / install-vm / winvm-plugin …）
├── tests/          unit/ + e2e/
├── .dev/           DDD 六大索引（项目自维护，权威细节）
└── .workbuddy/     ← 本次迁移交接归档所在（你正在读）
```

## 关键文件速查

| 关注点 | 位置 |
|---|---|
| 能力注册表 | `packages/vm-capabilities/src/registry/definitions.ts` |
| 风险模型 | `packages/contracts/src/risk.ts` |
| 策略引擎 | `packages/core/src/policy/engine.ts` |
| 哈希链审计 | `packages/core/src/audit/chain.ts` |
| A2A server | `packages/a2a-framework/src/server.ts` |
| ps-bridge | `packages/vm-capabilities/src/ps-bridge.ts` + `psmod/ps-bridge.ps1` |
| GUI 会话判定 | `packages/vm-capabilities/psmod/gui.ps1` → `Get-SessionHealth` |
| 部署总入口 | `delivery/setup.mjs` |
| 管理 CLI | `delivery/winvm-plugin.mjs` |
