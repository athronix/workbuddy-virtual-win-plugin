# CL-WBNATIVE · 需求与实证（WORKBUDDY-NATIVE ACP provider）

> 状态：**DEFERRED（搁置）**　创建：2026-10-26　搁置裁定：2026-10-26（项目 owner）
>
> **裁定内容**：维持 `WINVM_VM_PROVIDER=workbuddy` + `WINVM_WORKBUDDY_CLI=codebuddy`，
> **不新增** `workbuddy-native` provider，也不引入 `WINVM_WORKBUDDY_CLI=workbuddy`。
> 部署侧改为在 Step 3.0 前置补齐 VM 运行时（node≥18 / npm / `codebuddy` CLI），见
> `docs/deploy/deploy-strategy.md` v2.2。
>
> **保留原因**：本文的 ACP 实测证据（WorkBuddy 桌面版 `127.0.0.1:24622` 的 ACP 服务端、
> `/api/v1/acp/connect` 连接管理、`initialize`/`session/new` 回应结构、动态端口发现机制）
> 均为一次性取证成本，未来若要重启该方向可直接复用，故归档而非删除。
> 目标版本（原拟 V1.5.0）**撤销**。

---

## 1. 背景与问题

### 1.1 原设想（owner 表述）

> VM 端部署 **workbuddy**，它本身提供 **ACP 服务**；A2A service 只需把这个 ACP 服务**包装**成对外的 A2A 服务即可。因此 VM 侧真正依赖的是 **workbuddy**，而不是另装一个 CLI。

### 1.2 当前实现（事实：**不是**上述设想）

| 项 | 现状 | 证据 |
|---|---|---|
| provider `workbuddy` 的传输 | `-p --input-format stream-json --output-format stream-json --session-id …`（stdio 文本协议），**非 ACP** | `packages/adapter-agent-workbuddy-llm/src/persistent-session.ts:112` `PERSISTENT_CLI_ARG_TEMPLATE` |
| 能力回连方式 | 向 CLI 注入 `--mcp-config {mcpServers:{winvm:{type:'streamableHttp',url:'http://127.0.0.1:18443/mcp?dtid=<id>'}}}`，让 CLI **反向回连**本服务 | `packages/adapter-agent-workbuddy-llm/src/bridge.ts:259` `buildMcpConfig()` |
| 仓内 ACP 实现 | **零**（`agent-client-protocol` / `AgentSideConnection` 全仓 0 命中） | `grep -rniI 'agent-client-protocol' packages/ delivery/` |
| A2A 服务形态 | **不是一个独立服务** —— `/mcp` 与 `/a2a` 是**同一个 vm-service Node 进程**的两条 HTTP 路由 | `packages/vm-service/src/server.ts:2168` `if (path === '/a2a' && req.method === 'POST')` |
| provider 装配 | 按 `agent.providers[id].package` 动态加载 | `packages/core/src/bridge/loader.ts:73` `loadProvider()` |
| CL-018 历史决策 | 曾实测 `--acp`/`--serve` 存在，但**选型 stream-json**（"改动面最小"），ACP 列为"后续备选，另开变更" | `docs/archive/changes/CL-018/TECHNICAL-SOLUTION.md:71,596` |

**结论**：本变更正是 CL-018 预留的"另开变更评估 ACP"。

---

## 2. 实测取证（2026-10-26，VM 172.16.100.2，真机）

### 2.1 环境事实

| 项 | 实测值 | 取证方式 |
|---|---|---|
| `workbuddy` 命令 | **不存在**（`Get-Command workbuddy` → not found） | `provider-probe.ps1` |
| `codebuddy` 命令 | `…\nvm\installs\v24.21.0\codebuddy.ps1`（shim）→ 真实入口 `node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`，**v2.167.0** | `codebuddy --version` |
| WorkBuddy 桌面版 | `C:\Program Files\WorkBuddy\WorkBuddy.exe`（204,590,360 B），**8 个进程常驻**，配置根 `~/.workbuddy`（80 项） | `Win32_Process` |
| WorkBuddy 角色 | **ACP 客户端**：内置 `@genie/agent-harness@0.2.0-beta.15`，`lib/server/rpc-module.js` 导入 `@agentclientprotocol/sdk` 的 `methods`；bin `agent-harness.js` 直跑报 `AgentHarnessBinaryResolutionError`（缺 `@tencent-ai/agent-harness-win32-x64`）→ **不能独立当 server 被 spawn** | `ah-probe.ps1` |
| **WorkBuddy ACP 服务端** | **存在且可用**：进程 pid 15344 监听 `127.0.0.1:24622`，暴露 `/api/v1/acp/*` | 见 §2.3 |
| `@genie/agent-harness` 服务端侧标记 | `lib/integration/agent-integration.js`、`source-compiler.js` 命中 `AcpServer` | `wb-acp-server.js` A 段 |

### 2.2 `codebuddy` 的 ACP 形态矩阵（4 种组合实测）

| 调用 | 结果 | 判定 |
|---|---|---|
| `--acp`（stdio ndJsonStream） | 静默退出（exit 0，stdout/stderr 全空，≈7.2s） | ❌ 不可用 |
| `--acp --acp-transport streamable-http --port 18447` | 静默退出，无监听 | ❌ 不可用 |
| `--serve --acp --port 18446` | **成功**：`CodeBuddy Code HTTP Server` / `Endpoint http://127.0.0.1:18446` / 默认 `--auth password` 随机密码 + Web UI URL | ✅ 可用 |
| `--serve --acp --auth none` | 成功，打印 `Authentication is DISABLED` 警告 | ✅ 可用（测试用） |

> 路由为 Spring 风格：**所有路径必须带 `x-codebuddy-request` 头**，否则 `403 {"error":"Missing required header: x-codebuddy-request"}`。

### 2.3 ACP 全链路 POC（已跑通，两处服务端均验证）

**A) WorkBuddy 桌面版自带的 ACP 服务（端口 24622）** ← 直接印证 owner 的设想

```
POST http://127.0.0.1:24622/api/v1/acp/connect      (header: x-codebuddy-request)
  → 200 {"connectionId":"01a17771-…","sessionToken":"…"}

POST http://127.0.0.1:24622/api/v1/acp              (header: acp-connection-id: <上一步的 connectionId>)
  body: {"jsonrpc":"2.0","id":1,"method":"initialize",
         "params":{"protocolVersion":1,"clientCapabilities":{"fs":{...},"terminal":true}}}
  → 200 text/event-stream
    event: message
    data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
      "agentCapabilities":{"promptCapabilities":{"image":true,"embeddedContext":true},
        "mcpCapabilities":{"http":true,"sse":true},"loadSession":true,
        "delegateToolsSupport":true,"mainAgentSupport":false,
        "multitaskSupport":true,"metaPromptSupport":true},
      "authMethods":[{"id":"iOA",…},{"id":"external",…},{"id":"internal",…},{"id":"selfhosted",…}]}}

同连接 session/new → 200 SSE，先推 session/update(config_option_update) 再返 sessionId
  configOptions[mode].currentValue = "bypassPermissions"（WorkBuddy 侧）
```

**B) `codebuddy --serve --acp`（端口 18453）**：同上三步逐字节同构；差异仅 `configOptions[mode].currentValue = "default"`。

### 2.4 关键协议约束（踩过的坑，实施必读）

1. **`connectionId` 必须用服务端签发值**：自造 UUID 会 `409 {"code":"ACP_CONNECTION_NOT_FOUND","message":"Connection not found. Please establish a connection first via POST /acp/connect"}`。
2. **`sessionToken` 不要塞进 JSON-RPC 的 Authorization 头**：会命中 `-32600 "Invalid Request: Server already initialized"`。该 token 用途待定（疑似仅供 Web UI/REST 侧）。
3. **响应是 SSE 不是纯 JSON**：`content-type: text/event-stream`，载荷在 `data: ` 行；须按 NDJSON-over-SSE 解析。
4. **`initialize` 幂等失败**：同连接二次 initialize → `-32600 Server already initialized`。
5. **`GET /api/v1/acp` 是通知通道**（SSE 订阅），未建连接时 `409 ACP_CONNECTION_NOT_FOUND`。
6. **`/acp/bootstrap` 是客户端侧拼出来的路径**（把 `/acp` 替换为 `/acp/bootstrap`），服务端 `404 No mapping found` —— 不要直连。

### 2.5 端口发现事实（阻塞项）

- WorkBuddy 的 ACP 端口 **24622 是动态的**：在 `~/.workbuddy` 下递归扫 4 层（排除 cache/CodeCache/Crashpad/node_modules/binaries/plugins）**0 个文件记录该端口**。
- 其它 WorkBuddy 监听端口（18488 / 19543 / 19544 / 31916）**均无** ACP 路由（404）；仅 24622 可用。
- ⇒ provider 必须**运行时发现**端点，不能写死端口。

---

## 3. 需求

### 3.1 目标（P0）

新增 provider **`workbuddy-native`**，以 **ACP 协议**驱动 VM 侧 agent，把 ACP 包装为既有 A2A 面；**不改变**现有 `workbuddy`（stream-json）provider 的任何行为。

| ID | 需求 | 验收判据 |
|---|---|---|
| R1 | `WINVM_VM_PROVIDER=workbuddy-native` 可被配置加载并出现在 `/health.provider.id` | `/health` → `provider.id="workbuddy-native"`, `state="ready"` |
| R2 | 端点发现：自动定位 VM 内 ACP 服务端（WorkBuddy 桌面版 或 `codebuddy --serve --acp`） | 无需人工配置端口即可连通；端口变更后能自愈重探 |
| R3 | 握手链：`connect` → `initialize` → `session/new`（注入 winvm MCP server） | 三步均 200，且能读到 `agentCapabilities` |
| R4 | 委派：`session/prompt` 驱动一轮任务，`session/update` 流式映射为 A2A 进度/步骤 | `a2a.delegate` 返回 `completed` 且有真实产物 |
| R5 | 权限：ACP `session/request_permission` 映射到现有审批双闸（`DELEGATION_REQUIRED` / 审批卡） | 高危工具仍被拦截并出卡，不越权 |
| R6 | 降级：ACP 不可用（WorkBuddy 未运行 且 codebuddy 起不来）时 `/health` 明确报错，MCP 直调通道不受影响 | MCP 20 项仍全绿；`/health` 给出可操作诊断 |
| R7 | 零回归：`workbuddy`（stream-json）与 `workbuddy-deterministic` 行为逐字节不变 | 现有 2280 用例 GREEN |

### 3.2 非目标

- 不替换现有 `workbuddy` provider；不做 ACP/stream-json 双写。
- 不改造 WorkBuddy 桌面版（外部产品）。
- 不在本变更内解决 `a2a` 独立进程化（`/a2a` 仍是 vm-service 的路由）。

### 3.3 服务托管（owner 已裁定）

**vm-service 懒启动并托管**：首次委派时确保 ACP 端点可用（必要时 spawn `codebuddy --serve --acp`），健康纳入 `/health`（含 connectionId 重建）；随 vm-service 启停。

### 3.4 待定（需架构设计回答）

| # | 问题 | 候选 |
|---|---|---|
| Q1 | 端点发现优先级 | ① 优先复用运行中的 WorkBuddy 桌面版 ACP（pid 匹配 `WorkBuddy.exe` + LISTEN 端口逐个认领）；② 回落自起 `codebuddy --serve --acp`（固定端口，如 18460）；③ 二者都无 → fail-loud |
| Q2 | 端口认领探测成本 | 每次委派都探 vs 缓存 + 失效重探（建议：缓存 + 连续 N 次失败后重探） |
| Q3 | ACP session 复用粒度 | 每委派一个 session（干净）vs 长驻 session（省冷启动，需处理上下文污染） |
| Q4 | `mcpServers` 注入 | `session/new` 的 `mcpServers[]` 直接注入 `winvm`（streamableHttp + `?dtid=`），替代现有 `--mcp-config` |
| Q5 | 审批映射 | ACP `request_permission` 的 option 集如何投影到现有 4 档风险（L0–L3） |
| Q6 | `WINVM_WORKBUDDY_CLI` 语义 | 保持变量名；`workbuddy-native` 下解析为"ACP 服务端命令"（默认 `codebuddy`，可配 `workbuddy`） |

---

## 4. 影响面（初判）

- 新增包：`packages/adapter-agent-workbuddy-native/`（ACP 客户端 + 端点发现 + session 管理）
- `packages/core/src/config/index.ts`：`agent.providers['workbuddy-native']` 条目
- `delivery/install-vm.mjs`：provider 白名单 + `WINVM_WORKBUDDY_CLI` 映射扩展
- `delivery/preflight.mjs`：ACP 端点可达性检查
- `docs/`：`02-design/`、`INSTALL-GUIDE.md`、`deploy/`
- 守卫：新增包需过静态守卫（能力计数/工具名点分/claims guard）

---

## 5. 证据文件

| 文件 | 位置 | 说明 |
|---|---|---|
| ACP 形态矩阵 + 端口探测 | `~/wbtmp/acp-variants.ps1`、`wb-acp-server.js`、`wb-acp-verify.js` | 真机探针（**未入库**，含临时调试逻辑） |
| 握手 POC | `~/wbtmp/acp-node-probe{8,9,10,11}.js` | 逐步逼近 connectionId/sessionToken 协议 |
| WorkBuddy 角色判定 | `~/wbtmp/acp-role.ps1`、`ah-probe.ps1` | agent-harness 为 client 侧 + native 缺失 |
| 记忆归档 | `.workbuddy/memory/2026-10-26.md` §「ACP 原生通道实证」 | 事实摘要 |
