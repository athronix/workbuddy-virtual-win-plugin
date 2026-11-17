# MCP 上游代理：在 VM 内挂载第三方 MCP 工具面

**状态**：已落地并在真机验证（2026-11-17）
**代码**：`packages/vm-service/src/mcp-upstream.ts`、`packages/vm-service/src/server.ts`（路由段）

## 一、要解决的问题

VM 上有两个很好用、但**宿主够不到**的 MCP 服务：

| 服务 | 形态 | 工具数 | 用途 |
|---|---|---|---|
| `agent-browser` (Vercel Labs, 0.43.0) | stdio MCP | 33 | 浏览器自动化：打开页面、无障碍快照、点击/填表、截图 |
| `agent-desktop` (Vercel Labs, 1.3.1) | stdio MCP | 75 | 桌面应用自动化：无障碍树 + `@ref` 定位驱动任意应用 |

两个障碍：

1. **stdio 不可远程**。宿主只能连 HTTP，VM 上的 stdio server 无法直连。
2. **agent-desktop 必须跑在交互式会话**。SSH 登录落在 **Session 0**，读到的桌面是空的
   （实测 `desktop_list_apps` 返回 `apps: []`），而用户桌面在 **Session 1**。

## 二、方案

把两个 stdio 上游**挂到 vm-service 的 HTTP 工具面上**，宿主侧只多两个 connector 条目。

```
宿主 WorkBuddy
 ├─ connector:winvm           → http://127.0.0.1:18443/mcp            54 个结构性能力
 ├─ connector:winvm-a2a       → 本地 stdio 桥 → /a2a                  A2A 委派
 ├─ connector:winvm-browser   → http://127.0.0.1:18443/mcp/browser    33 个浏览器工具
 └─ connector:winvm-desktop   → http://127.0.0.1:18443/mcp/desktop    10 个桌面工具（白名单）
                    ↑ 同一条 SSH 隧道，仅用路径区分工具面
VM  vm-service（Session 1，127.0.0.1:18443）
 ├─ POST /mcp/browser → McpServer → McpClient(StdioJsonRpcChannel(`cmd /c agent-browser.cmd mcp`))
 └─ POST /mcp/desktop → McpServer → McpClient(StdioJsonRpcChannel(`cmd /c agent-desktop.cmd mcp`))
```

三个设计收益：

1. **会话继承**。`vm-service` 自己就跑在 Session 1（`InteractiveToken` 计划任务），
   由它 spawn 的上游**继承父会话** ⇒ `agent-desktop` 直接拿到真实桌面。
   这是选择「由 vm-service 代理」而不是「VM 内独立起一个桥进程」的决定性理由。
2. **零新协议代码**。`@winvm/core` 的 `StdioJsonRpcChannel` + `@winvm/mcp-framework` 的
   `McpClient` / `McpServer` 三件套组合即可，代理层只负责生命周期。
3. **安全默认正确**。`/mcp/browser`、`/mcp/desktop` **不在** `http-guard` 的硬编码豁免表里
   ⇒ 默认 fail-closed，与 `/mcp` 受同一套 Bearer 守卫保护，未改一行守卫代码。

## 三、关键实现约束

| 约束 | 说明 |
|---|---|
| Windows 批处理包裹 | `agent-*.cmd` 是批处理，`StdioJsonRpcChannel` 用无 shell 的 `spawn()` ⇒ 必须 `cmd.exe /c <name>.cmd mcp`（教训 A8） |
| 懒启动 | 首次请求才 spawn；上游 CLI 未装**不影响服务启动**，只让该路由返回 502 |
| 工具白名单 | `agent-desktop` 默认只暴露 10 个（见 `DEFAULT_DESKTOP_TOOL_ALLOWLIST`），其余按需追加 |
| 白名单外拒绝 | 明确报 `未知工具：<name>`，不静默代理 |
| 崩溃自愈 | `tools/call` 失败即标记上游待重建，下次请求重新 spawn；`/health.upstreams[].restarts` 累计暴露 |
| 退出清理 | 服务 `close()` 时 `disposeAll()`，避免孤儿进程 |

## 四、运维口径

**启用/禁用**：默认两个上游都启用。要整体关掉某条：

```powershell
# 在 start-hidden.ps1 或服务环境里
$env:WINVM_UPSTREAM_OFF = 'browser,desktop'
```

**调整桌面工具面**：改 `packages/vm-service/src/mcp-upstream.ts` 的
`DEFAULT_DESKTOP_TOOL_ALLOWLIST`，重新构建并重装 VM 端。

**观测**：

```bash
curl -s http://127.0.0.1:18443/health | jq '.upstreams'
# [{"id":"browser","label":"agent-browser","state":"ready","tools":33,"exposed":33},
#  {"id":"desktop","label":"agent-desktop","state":"ready","tools":75,"exposed":10}]
```

`state:'idle'` = 还没人调用过（懒启动，不是故障）。`state:'error'` + `lastError` = 上游起不来。

## 五、失败模式

| 现象 | 含义 | 处置 |
|---|---|---|
| `/mcp/desktop` 返回 502 `upstream desktop unavailable` | 上游 CLI 未装或起不来 | 看 `lastError`；VM 内 `agent-desktop --version` |
| `tools/list` 少工具 | 白名单生效（默认 75→10） | 按需追加 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` |
| `tools/call` 报 `未知工具：X` | X 不在白名单内 | 同上，或说明该工具被刻意排除 |
| `desktop_list_apps` 返回 `apps: []` | **进程不在 Session 1** | 确认 vm-service 是 `InteractiveToken` 计划任务起的；不要用 SSH 直连上游调试 |
| 宿主侧 `mcp.json` 缺条目 | install-host 未跑到全局段 | 重跑 `node delivery/install-host.mjs` |

## 六、部署链改动

| 位置 | 改动 |
|---|---|
| `delivery/install-vm.mjs` | 新增 `[4b/6]` 步骤：`npm i -g agent-browser agent-desktop`；**失败不阻断**（可选依赖），`--skip-upstreams` 可跳过 |
| `delivery/install-host.mjs` | `plugin.extraConnectors` 填两条；全局 `mcp.json` 与账户级 `mcp.json` 都写入；卸载清理名单加 `winvm-browser` / `winvm-desktop` |
| `packages/contracts/src/host.ts` | `ConnectorDecl.mcpPath?`（默认 `/mcp`）+ `NeutralPlugin.extraConnectors?` |
| `packages/host-sdk/src/index.ts` | `extraConnectors` 校验：id 唯一、禁 stdio、`mcpPath` 必须 `/` 开头 |
| `packages/adapter-host-workbuddy/src/index.ts` | 渲染时消费 `mcpPath`；卸载改为按 `connector:<id>` / `connector:<id>-*` 精确匹配清理 |

## 七、验证记录（2026-11-17 真机）

**POC（`schtasks /it` 在 Session 1 跑独立探针）**

- `desktop_snapshot app=chrome` → `ok:true`，117 节点 / 76 refs / `snapshot_id: s2dqzpiefbzmp0`，节点名"最小化/最大化/返回/前进"
- `desktop_list_apps` → 3 个应用（WindowsTerminal / chrome / powershell）
- `agent_browser_open example.com` → `ok:true`，标题 `Example Domain`（11.7s）

**VM 内路由（127.0.0.1:18443 直连）**

- `/health.upstreams` 初始两条 `idle`
- `/mcp/desktop` initialize → `serverInfo: winvm-desktop/0.1.0`
- `tools/list` → **10**（75 经白名单收敛）
- `tools/call desktop_list_apps` → 3 个真实应用
- 白名单外 `desktop_clipboard_get` → `未知工具：desktop_clipboard_get`
- `/mcp/browser` `tools/list` → **33**
- `/health.upstreams` 后置：`browser ready 33/33`、`desktop ready 75/10`

**宿主端到端（经 SSH 隧道 127.0.0.1:18443）**

- initialize / tools-list(10) / `desktop_list_apps`(3 apps) / `/mcp/browser`(33) 全部通过

**单测**：`tests/unit/mcp-upstream-connectors.test.js` 13 项全绿；宿主侧回归
（`host-adapter` 37、`phase3-b2-install-host` 6、`install-vm-task` 8、`r3-uninstall-verify` 47）全绿。
