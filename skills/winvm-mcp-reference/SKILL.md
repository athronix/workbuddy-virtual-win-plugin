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

> 参考资料：MCP 服务端点 / 鉴权 / 各 Agent 接入配置的完整速查表见 `references/mcps-reference.md`。

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

> 宿主机访问：SSH 隧道由**常驻 `tunnel-daemon`**（进程内 ssh2）承载，**无需手工**建系统 ssh 转发
> （手工 `ssh -f -N -L 18443:...` 会与守护进程争抢 `127.0.0.1:18443` 而失败）。
> 确认隧道在线：`winvm-plugin tunnel status`；离线则 `winvm-plugin tunnel ensure` 拉起。

## 各候选 Agent 的接入方式（关键差异）

| Agent | 接入方式 | 配置位置 | 是否每次调用传 endpoint |
|---|---|---|---|
| `workbuddy`（codebuddy CLI） | CLI 参数 `--mcp-config <fileOrString>`（默认写配置文件传**路径**）+ `--strict-mcp-config` | provider options `endpoint` | 是（由 `cliArgTemplate` 渲染 `{mcpConfig}`） |
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

## 错误码分层（排查必读）

工具返回的 `error` 分**两层**，用途不同、不可混用：

| 字段 | 取值 | 用途 |
|---|---|---|
| `error.code`（**契约层**封闭码集，单源 `errors.ts`，登记 §2.6） | `INVALID_PARAMS` `UNKNOWN_CAPABILITY` `UNSUPPORTED_GOAL` `POLICY_DENIED` `APPROVAL_REQUIRED` `SESSION_UNAVAILABLE` `SESSION_BLACK_SCREEN` `PROVIDER_UNAVAILABLE` `TIMEOUT` `EXECUTION_FAILED` `TASK_CANCELED` `DELEGATION_REQUIRED` | 决定**是否 `retryable` / 是否需审批** |
| `error.reason`（**领域层**原因码，可选） | `FILE_NOT_FOUND` / `PATH_NOT_FOUND` / `CLI_NOT_FOUND` / `SERVICE_NOT_FOUND` / `PROCESS_NOT_FOUND` / `REG_PATH_NOT_FOUND` / `INVALID_ARGUMENT` / `FILE_TOO_LARGE` / `PROTECTED_PROCESS` … | 决定**具体补救动作** |

**排查规则（先 `code` 后 `reason`）**：

- `code=PROVIDER_UNAVAILABLE` → **桥不可用**：按下方「桥自愈与有界重试」判断是**自愈中**（有界退避重试）还是**配置错误**（不重试）；
- `reason=CLI_NOT_FOUND` / `WINGET_NOT_FOUND` → **不是桥的问题**，是目标应用/包未安装 → 先装应用，**别重试**；
- `reason=PATH_NOT_FOUND` / `FILE_NOT_FOUND` → 路径问题 → 改用白名单目录（`C:\WinVMWorkspace\**` 等），**别重试**；
- `reason=SERVICE_NOT_FOUND` / `PROCESS_NOT_FOUND` → 名称/PID 不存在 → 用 `system.service.list`（模糊匹配）核对；
- `reason=INVALID_ARGUMENT` → 参数非法（`code=INVALID_PARAMS`）→ **修参数、别重试**（见下「入参契约错误处理」）；
- `code=TIMEOUT` → 执行超时 → **调大 `timeoutMs`**；
- `code=TASK_CANCELED` → 任务被取消、执行体协作式退出 → **不要重发同一请求续跑**，重跑必须**重新委派、重过审批闸**（批1(c) 后直调通道无审批入口）；
- `code=DELEGATION_REQUIRED` → L2/L3 纯 MCP 直调不予审批（批1(c)）→ **改走 `a2a.delegate` 委派**（宿主批准 → 服务端重放），重试同一请求无益。

## 入参契约错误处理（`INVALID_PARAMS` / `INVALID_ARGUMENT`）

当调用因**参数名写错 / 漏传必填 / 取值非法**而不符能力契约时，VM 服务会在**发起 PowerShell 之前**
前置拦截，返回 `code=INVALID_PARAMS` + `reason=INVALID_ARGUMENT`，且**不产生桥往返**（毫秒级返回）。

> 注（两条互补路径，对外**完全同形**）：
> - **参数名 / 必填 / 取值**：由 VM 服务在**发起 PowerShell 之前**前置拦截 ——
>   参数名（D24）、取值 `type`/`enum`（D26），附带结构化的
>   `details.missing` / `details.unknown` / `details.allowed` / `details.invalid`；
> - **schema 未声明的类型/枚举**等纯 PS 侧绑定失败：由 PowerShell 侧归一为**同一形状** ——
>   `code=INVALID_PARAMS` + `reason=INVALID_ARGUMENT`（`details.exceptionType` 给出异常类型）。
>
> **旧版本**这两类都表现为 `code=EXECUTION_FAILED`、无 `reason`，无法路由 —— 现已全部可路由。

`error.details` 结构化给出定位信息：

| 键 | 含义 |
|---|---|
| `details.missing` | 缺失的**必填**参数名（未传，或值为 `null`） |
| `details.unknown` | **不被支持**的参数名（多半是写错 / 误用他能力参数） |
| `details.allowed` | 该能力**允许**的全部参数名 |
| `details.invalid` | 已提供但**取值非法**的键，元素 `{key, expected, got}`（`got` 只给类型类别，不回显原值） |
| `details.exceptionType` | 仅 PS 侧绑定失败时出现：PowerShell 异常类型（如 `ParameterBindingException`） |

处置：**改参数、别重试**（`retryable=false`；参数不变重试必然再失败）。
拿不准某能力有哪些参数时，先查 `tools/list` 中该工具的 `inputSchema.required`（必填）
与 `inputSchema.properties`（可用参数）—— 这是**权威契约**。

### `app.winget.search` 返回空？先排除 `WINGET_PARSE_FAILED`

`app.winget.search` 解析 winget 的**定宽表格**输出。若它返回 `ok=true` 但 `data=[]`，
**不要**直接断定「winget 没有这个包」—— 先确认不是因为解析器与 winget 输出格式不符。

- `reason=WINGET_PARSE_FAILED`（`code=EXECUTION_FAILED`）：winget 输出有数据行却解析出 0 条 →
  **fail-loud**（不再静默给空）。此时**不要重试**，应上报并排查 winget 版本 / 本地化差异。
- 解析按**表头行**定列边界，并做**显示宽度补偿**（CJK/全角字符占 2 显示列）—— 故字段含中文
  （如 `7zip解压缩软件`）也能正确解析，`id` 不会错位成垃圾值。
- 字段：`{name, id, version}`；**`id`** 才是 `app.winget.install` / `app.winget.uninstall` 的入参。

## 桥自愈与有界重试 / 日志 / 部署漂移

### 桥自愈与有界重试

- ps-bridge 是**常驻进程**；被 `Stop-Process` / 崩溃后由心跳看门狗**自动重建**（**无需重启服务**）。
- `GET /health` 的 `psBridge` 暴露增量字段：`restarts`（累计自愈次数）、`lastError`（最近一次自愈失败原因）。
- 调用报 `PROVIDER_UNAVAILABLE` 时区分两种情况：
  - `restarts` 在增长 / `lastError` 为空 → **桥正在自愈**：退避 1–3s 后再试，**至多 1–2 次**（有界，见 orchestrator §前置检查）；
  - `lastError` 指向配置/环境问题（CLI 缺失、端口占用、目录不存在）→ **重试无用**，直接修复配置后重试一次即可。
- 判据口诀：**自愈中 → 有界重试；配置错 → 不重试**。

### 服务日志位置（CL-018 C3：已落盘）

- 服务日志现已**落盘**：`%LOCALAPPDATA%\WinVMBridge\logs\winvm-service-YYYY-MM-DD.log`
  （单文件 10MB / 按天切 / 保留 7 个文件 / 14 天；级别默认 `info`；均可用 env 调整：
  `WINVM_LOG_DIR` / `WINVM_LOG_LEVEL` / `WINVM_LOG_MAX_BYTES` / `WINVM_LOG_MAX_FILES` / `WINVM_LOG_MAX_DAYS`）。
- 日志已**脱敏**（凭据类字段不明文落盘）。`GET /health` 的 `logging` 字段给出
  `degraded` / `dir` / `level` / `reason`。
- **`logging.degraded=true` 不是服务故障**：表示日志目录不可写、已回退控制台，**服务仍正常运行**
  （这是设计允许的降级态）。需要落盘日志时修复目录权限后重启服务即可。
- 诊断优先级不变：**首选 `/health` 与审计链**，日志作为补充。

### CL-018 附加可观测性字段（`/health`）

`GET /health` 为**纯附加**扩展，旧字段语义不变：

| 字段 | 含义 |
|---|---|
| `llmSession` | LLM 常驻会话态：`state`(`stopped`/`starting`/`ready`/`degraded`/`disabled`)、`pid`、`restarts`、`idleMs`、`lastError`（仅失败后出现）。`disabled` 表示已超重建上限、此后恒走单次 `-p`。非 LLM provider 时字段**缺席** |
| `logging` | 日志落盘态：`degraded` / `dir` / `level` / `reason`（`degraded=true` 即目录不可写但服务仍在跑） |
| `cache.netCfg` | 网络配置进程内缓存态：`cached` / `ageMs` / `ttlMs`。**`ageMs` = 自最近一次采集（PS 回传的 `collectedAt`）起算的真实缓存新鲜度（毫秒）**（CL-019 项①修正，此前误为"距启动预热时长 ≈ 进程 uptime"）；无成功采集时 `ageMs=-1`。预热或任一正常 `system.network.config` 调用成功均刷新该值，故用户 `refresh:true` 后 `ageMs` 立即回落 |

### 能力入参/出参的 CL-018 增量

- `system.network.config`：入参新增 `refresh:true`（**绕过 45s 进程内缓存**强制重采）；
  出参新增 `cached` / `cacheAgeMs` / `collectedAt`。TTL 可经 env `WINVM_NETCFG_TTL_MS` 调整。
- `app.inventory.list`：按 **`(name, version)`** 合并重复登记；每条新增 `registryKeyCount`
  与可选 `architectures`（仅 hive 可推断时填充：HKLM64→`x64`、HKLM32→`x86`）；
  **同名不同版本保留多条**。
- `appops.state.query`：自动过滤非生产型窗口；出参新增 `filteredCount` / `filtered` / `policy`；
  名单可经 env `WINVM_APPOPS_EXCLUDE_PROCS` / `WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS` /
  `WINVM_APPOPS_EXCLUDE_PROC_PATTERNS`（进程名正则，锚定匹配）追加。

### 委派超时（`a2a.delegate`）· 性质为「缓解（mitigation）」非修复

- `timeoutMs` / `WINVM_A2A_TIMEOUT_MS`（默认 600000）只**降低**"正常慢启动（75–107s）被误判为失败"的**失败率**，
  **不消除**首轮进程级冷启动成本；**根治**是 LLM 常驻会话（复用长驻进程）。**不得**表述为"已修复/已解决"。
- 环境变量开关（`DISABLE_TELEMETRY` / `DISABLE_AUTOUPDATER` 等）**存在且可用，但无实测收益，不作为缓解手段**
  （真机 A/B 未证实收益；**不标"不适用"**，如实标"**可用但无可采信收益**"）。

### 部署漂移自检（md5 比对）

「本地已修、真机依旧失败」的经典原因是 **VM `C:\WinVMBridge` 与仓库已漂移**（stale dist / 旧 psmod）。自检步骤：

1. `npm run build`（含 `tsc -b`）；
2. 重新分发 `packages/vm-capabilities/psmod/*.ps1` 与全部 `packages/*/dist/**` 到 `C:\WinVMBridge`；
3. **逐文件 md5 比对**本地与 VM（重点：`psmod/*.ps1`、`packages/*/dist/**`）——不一致即未生效；
4. **重启 `WinVMBridge.Service`**（ps-bridge 启动时 dot-source 全部模块，**不可热更**；不重启则旧模块仍在内存）。

## 审批载荷排查（L2/L3）

当 `a2a.delegate` / `a2a.task.get` 返回 `approval` 时，若怀疑审批信息不全，按下表排查。

### ① 判定审批信息是否残缺

| 观察 | 判定 | 处置 |
|---|---|---|
| `approval` 有 `approvalId`/`message`，但**无 `impact`** | 宿主桥**未透传**（桥版本过旧：旧版 `extractApproval()` 丢弃了 VM 已下发的 `preview`/`impact`） | 升级 `@winvm/host-a2a-bridge` 到含审批载荷透传的版本；升级前**不得**凭残缺信息让用户确认 |
| `approval.impact` 为 `[]` | VM 确实下发空清单（合法透传） | 按空清单展示，**不得编造** |
| `approval` 有 `impact` 但无 `preview` | VM 未下发 `preview` | L2 用「预览：未提供」；L3 先以 `dryRun:true` 免审批取得 preview（见 `winvm-orchestrator/references/approval-card.md` §3） |
| `approval.summary` 缺失 | 摘要未派生 | 回落 `approval.message` 展示 |

> 说明：`impact` 缺失 **必然** 指向宿主桥未透传或桥版本过旧；VM 若下发则为合法透传（含空数组）。

### ② 两通道续跑方式差异速查表

| 通道 | 续跑方式 | 关键标记 |
|---|---|---|
| **MCP 直调**（连接器 `winvm`） | **L2/L3 不予审批**（批1(c) 策略化已落地）：直调命中 L2/L3 审批闸 ⇒ 服务端按通道事实直接收口 `DELEGATION_REQUIRED`（**不再**发放续跑令牌、不再死循环重发）；须改用 **A2A 委派**通道审批（见下行）。仅 `WINVM_APPROVAL_REPLAY=off` 回滚态下直调令牌续跑才适用 | `DELEGATION_REQUIRED`（→ 转委派） |
| **A2A 委派**（连接器 `winvm-a2a`） | 调 `a2a.approval.reply { taskId, approvalId, approved: true }` | **不得**使用 `__approvalId` |

> 两通道的续跑标记**不可混用**：A2A 通道的输出中不会、也不应出现 `__approvalId`（卡片规范见 `winvm-orchestrator` 的审批卡片模板 §9）。
