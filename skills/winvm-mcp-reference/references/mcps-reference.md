# WinVM Bridge — MCP 服务部署与管理参考

> 本文是 `winvm-mcp-reference` 技能的正文参考，面向 VM 内 AI Agent 与运维人员，
> 说明"54 个 Windows 操作能力"如何通过 MCP 暴露、各候选 Agent 如何接入、以及故障如何排查。

---

## 1. 服务拓扑

```
┌─────────────── Windows 虚拟机（仅监听 127.0.0.1）───────────────┐
│                                                                  │
│   vm-service  (port 18443)                                       │
│     ├── /mcp   MCP Streamable HTTP  → 54 个能力工具（五域）      │
│     └── /a2a   A2A 服务端           → 委派/进度/审批/产物        │
│                    ▲                                              │
│                    │ 回连（loopback）                             │
│   VM AI Agent（workbuddy / hermes-agent …）                      │
│     └── 经 MCP 调用能力完成用户目标                              │
└──────────────────────────────────────────────────────────────────┘
                     ▲ SSH 隧道（宿主机侧，由常驻 tunnel-daemon 进程内承载）
                     │ winvm-plugin tunnel status | ensure
              ┌──────┴───────┐
              │  宿主机 Agent │  ← MCP 直调（简单任务）/ A2A 委派（复杂任务）
              └──────────────┘
```

**五域能力**：`meta.*`（健康检查/能力清单/会话状态）、`system.*`、`app.*`、`storage.*`、`gui.*`、`appops.*`（生产工作流/CLI 执行）。

---

## 2. 服务端部署（vm-service）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `server.host` | `127.0.0.1` | **强制回环**，公网暴露属高危违规 |
| `server.port` | `18443` | SSH 隧道转发的目标端口 |
| `security.requireLoopbackBind` | `true` | 启动即校验，非回环直接拒绝启动 |
| `security.tokenEnv` | `WINVM_BEARER_TOKEN` | Bearer token 来源环境变量 |
| `audit.dir` | `%LOCALAPPDATA%/WinVMBridge/audit` | 审计落盘（`redactParams: true`） |
| `session.probeIntervalMs` | `15000` | 会话探活间隔 |

部署：`node delivery/install-vm.mjs --apply`（支持 `--provider <id>`、`--self-test`、`--uninstall`）。

---

## 3. 鉴权

- 所有 `/mcp` 与 `/a2a` 请求须带 `Authorization: Bearer <token>`。
- token 由服务端环境变量 `WINVM_BEARER_TOKEN` 提供；客户端侧按 Agent 不同落位不同（见 §4）。
- 401 的三大成因：token 未注入、token 与服务端不一致、header 被写成 `Bearer Bearer <t>`（重复前缀）。

---

## 4. 候选 Agent 接入矩阵（核心差异）

| Agent | Provider ID | MCP 接入机制 | 配置落点 | 每次调用传 endpoint |
|---|---|---|---|---|
| WorkBuddy CLI | `workbuddy` | CLI 参数 `--mcp-config <fileOrString>`（真机契约，见 §5） | `agent.providers.workbuddy.options.endpoint` | **是** |
| Hermes Agent | `hermes-agent` | **预注册进配置**（CLI 无 `--mcp`） | `%HERMES_HOME%\config.yaml` → `mcp_servers.winvm` | **否**（启动自动发现） |
| 确定性执行器 | `workbuddy-deterministic` | 不经 MCP，进程内直调 | — | — |

切换方式：`agent.provider = '<id>'`，或部署时 `WINVM_VM_PROVIDER=<id>`。**框架零改动**。

---

## 5. workbuddy（codebuddy CLI）接入

经 `cliArgTemplate` 渲染，默认模板（**真机 `codebuddy` v2.149.0 实测契约**）：

```
-p {prompt} --output-format text --permission-mode bypassPermissions --add-dir {output} --mcp-config {mcpConfig}
```

- `{prompt}` = 系统提示 + 目标 + 产物目录 + 能力清单合并文本（运行时做换行适配）。
- `{mcpConfig}` = MCP 配置；**默认渲染为配置文件路径**（写入工作区 `.winvm/mcp.json`），
  内容为 `{"mcpServers":{"winvm":{"type":"streamableHttp","url":"http://127.0.0.1:18443/mcp"}}}`，
  落盘失败时回退为内联 JSON 串。`--mcp-config` 两种形态（文件或 JSON 串）**均被真机接受**。
- 若真机 CLI 参数不同，用 `options.cliArgTemplate` 覆盖即可，无需改代码。

> **真机注意（Windows）**：
> - CLI 由 npm 装入，实际文件是 **`codebuddy.cmd`**；Node `spawn` 不解析 `.cmd`/PATHEXT，
>   故按 `PATHEXT` 探测真实文件后经 **`cmd.exe /d /s /c`** 启动。
> - 解析失败会给**可操作**错误（列出搜索过的路径 + 建议的 `cliPath` 绝对路径写法）。
> - LLM 运行时**未登录**时 `codebuddy` 会**退出码 0 但 stderr 报 `Authentication required`**；
>   该情形按 `PROVIDER_UNAVAILABLE` 上报并**降级为确定性执行**（summary 标注「已降级为确定性执行」）。

---

## 6. hermes-agent 接入

### 6.1 为什么必须预注册
`hermes chat` 子命令**没有** `--mcp` 参数。MCP 服务器写入配置后，CLI 启动时由
`hermes_cli/mcp_startup.py` 后台发现线程自动连接（源码已确认）。

### 6.2 配置形态
```yaml
# %HERMES_HOME%\config.yaml
mcp_servers:
  winvm:
    enabled: true
    url: http://127.0.0.1:18443/mcp
    headers:
      Authorization: Bearer ${MCP_WINVM_API_KEY}
```

### 6.3 凭据落位
token 以环境变量持久化到 `%HERMES_HOME%\.env`：
```
MCP_WINVM_API_KEY=<token>
```
命名规则（源码 `hermes_cli/mcp_config.py`）：`MCP_{SERVER_NAME大写_非字母数字转下划线}_API_KEY`。
若该变量已存在，`hermes mcp add` **不再交互式提示** → 可完全自动化。

### 6.4 等价命令
```bash
hermes mcp add winvm --url http://127.0.0.1:18443/mcp --auth header
hermes mcp list          # 验证
hermes mcp test winvm    # 连通性与工具发现
hermes mcp remove winvm  # 注销
```

### 6.5 自动化
`adapter-agent-hermes` 的 `HermesMcpRegistrar` 在 provider `init()` 时**幂等**完成 §6.2/§6.3，
写前自动备份 `config.yaml.bak.<timestamp>`；`options.registerMcp: false` 可关闭自动注册改为手工管理。

### 6.6 hermes 调用形态
```
hermes chat -q "<系统提示+目标>" -Q --yolo --source winvm-bridge
```
- `-Q`：程序化输出（抑制 banner/spinner/工具预览），便于解析；
- `--yolo`：**非交互必需**，否则遇危险命令审批会永久挂起；
- `--source winvm-bridge`：会话打标，不污染用户会话列表；
- 无 `--output` 参数 → 产物靠提示词约束写入 `outputDir`，再由既有扫描机制回传。

---

## 7. 注册 / 验证 / 注销

**注册**：优先走 provider 自动注册；手工则按 §6.4。
**验证**：
1. `hermes mcp list` 应显示 `winvm`；
2. `hermes mcp test winvm` 应列出约 54 个工具；
3. 服务端审计目录应有对应条目。
**注销**：`hermes mcp remove winvm`，并清理 `.env` 中的 `MCP_WINVM_API_KEY`。

---

## 8. 故障排查矩阵

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 连接超时 | SSH 隧道未在线 / 服务未启动 | 先 `winvm-plugin tunnel status`，离线则 `winvm-plugin tunnel ensure`（常驻 tunnel-daemon，**勿手工**建 ssh 转发）；再查 vm-service 进程 |
| 401 Unauthorized | token 未注入或不一致 | 核对 `WINVM_BEARER_TOKEN` 与 `.env` 中 `MCP_WINVM_API_KEY` |
| 401 且 header 重复 | token 带了 `Bearer ` 前缀 | 落盘时剥离前缀（Registrar 已处理） |
| 工具列表为空 | `enabled` 缺失/为 false | 配置补 `enabled: true` |
| 工具数为 0 且报连接失败 | 服务未监听回环 | 查 `server.host` 必须为 `127.0.0.1` |
| 命令执行挂起不返回 | 缺 `--yolo`（hermes） | 在 `cliArgTemplate` 中补 `--yolo` |
| 产物未回传 | 无 `--output`（hermes） | 靠提示词约束写入 `outputDir`；检查扫描目录 |

---

## 9. 安全约束

- **VM 服务严禁暴露公网**：仅 `127.0.0.1`，宿主机一律经 SSH 隧道访问。
- L2/L3 高危操作须经宿主审批闸，VM 内 Agent 不得自行放行。
- token 属敏感信息：审计 `redactParams: true`；`.env` 权限沿用 hermes 既有机制。
- 不得直连宿主机、不得访问与任务无关目录。

---

## 10. 未验证项（V1）

- hermes-agent 端到端 `runGoal` 真机联通（需 VM 内 hermes + MCP 实际联通）。
- `--yolo` 在各类高危操作下的实际放行边界。
- 54 个工具在 hermes 工具集下的完整发现率（受 `--max-turns` 与工具集配置影响）。
