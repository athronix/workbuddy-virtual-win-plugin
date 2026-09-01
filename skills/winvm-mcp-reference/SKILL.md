---
id: winvm-mcp-reference
name: WinVM MCP 服务部署与接入参考
description: >
  查阅与排查 WinVM Bridge 的 MCP 服务：vm-service 的 /mcp 与 /a2a 端点、
  鉴权方式、各候选 VM AI Agent（workbuddy / hermes-agent）接入 MCP 的差异与配置方法、
  注册/验证/注销步骤与常见故障。当需要确认"能力工具从哪来、怎么连上、连不上怎么办"时使用。
version: 0.1.0
domains: [meta]
triggers:
  - MCP 服务连不上 / 工具列表为空
  - 需要为某个 AI Agent 注册或注销 WinVM MCP
  - 确认 /mcp 端点地址或 Bearer token 配置
  - 切换 VM AI Agent 后能力不可用
relatedSkills:
  - winvm-orchestrator
---

# WinVM MCP 服务部署与接入参考

## 何时用

- 能力工具调用失败、工具列表为空、或报 401/超时 → 先按本文核对 MCP 通道。
- 新增/切换 VM AI Agent 选型后，需要把 WinVM 的 54 个能力接入该 Agent。
- 需要注销或变更 MCP 端点/凭据。

## 核心事实（速查）

| 项 | 值 |
|---|---|
| MCP 端点 | `http://127.0.0.1:18443/mcp`（**仅监听 127.0.0.1，严禁暴露公网**） |
| A2A 端点 | `http://127.0.0.1:18443/a2a` |
| 传输 | MCP Streamable HTTP |
| 鉴权 | Bearer token，取自环境变量 `WINVM_BEARER_TOKEN` |
| 能力数量 | 54（五域：`meta.*` `system.*` `app.*` `storage.*` `gui.*` `appops.*`） |

> 宿主机访问需先建 SSH 本地端口转发：
> `ssh -f -N -L 18443:127.0.0.1:18443 <user>@<vm-host>`

## 各候选 Agent 的接入方式（关键差异）

| Agent | 接入方式 | 配置位置 | 是否每次调用传 endpoint |
|---|---|---|---|
| `workbuddy`（codebuddy CLI） | CLI 参数 `--mcp <endpoint>` | provider options `endpoint` | 是（由 `cliArgTemplate` 渲染） |
| `hermes-agent`（hermes CLI） | **预注册进配置**（CLI 无 `--mcp` 参数） | `%HERMES_HOME%\config.yaml` 的 `mcp_servers.winvm` | 否（启动时自动发现连接） |
| `workbuddy-deterministic` | 不经 MCP（进程内直调能力） | — | — |

### hermes-agent 注册示例
```yaml
# %HERMES_HOME%\config.yaml
mcp_servers:
  winvm:
    enabled: true
    url: http://127.0.0.1:18443/mcp
    headers:
      Authorization: Bearer ${MCP_WINVM_API_KEY}
```
token 以环境变量持久化于 `%HERMES_HOME%\.env`：`MCP_WINVM_API_KEY=<token>`。
等价命令：`hermes mcp add winvm --url http://127.0.0.1:18443/mcp --auth header`
（`adapter-agent-hermes` 的 `HermesMcpRegistrar` 会在 provider `init()` 时**幂等**完成上述注册。）

## 完整参考

部署拓扑、逐步骤注册/验证/注销、各 Agent 差异细节与故障排查矩阵，见同目录：
**`mcps-reference.md`**

## 最小排查路径

1. `curl -H "Authorization: Bearer $WINVM_BEARER_TOKEN" http://127.0.0.1:18443/mcp` 是否有响应 → 判断服务与隧道。
2. 401 → token 未注入或与服务端不一致。
3. 工具列表为空 → 检查 `enabled: true`（hermes）/ `endpoint` 配置（workbuddy）。
4. 仍然失败 → 查服务端日志与审计目录（`%LOCALAPPDATA%/WinVMBridge/audit`）。
