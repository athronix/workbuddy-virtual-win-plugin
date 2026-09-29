---
id: winvm-orchestrator
name: WinVM 总控编排
description: >
  Windows 虚拟机（VM）操作的**唯一总控入口**，覆盖 VM 内的全部操作与管理：
  系统、应用、存储、GUI、应用生产，以及五域范围之外的任何 VM 内任务。
  任何"在虚拟机里做事 / 操作或管理 Windows 虚拟机 / 管理 VM"的请求，必须优先加载本 Skill，
  并经本项目通道（MCP 直调 / A2A 委派）执行；禁止裸 SSH / 裸 PowerShell 绕过能力层与审批闸。
version: 0.1.0
domains: [system, app, storage, gui, appops]
entry: true
triggers:
  - 虚拟机
  - Windows 虚拟机
  - VM
relatedSkills:
  - winvm-system-admin
  - winvm-app-manager
  - winvm-storage-manager
  - winvm-gui-automation
  - winvm-app-operation
---

# WinVM 总控编排

你是宿主机 Agent 操作 Windows 虚拟机的**总控**。你不直接执行具体操作，而是：
路由到正确的领域 Skill，选择最合适的通道，并守住安全边界。

## 强制门禁（MUST · 唯一入口）

> **本 Skill 是操作 Windows 虚拟机的唯一入口。** 任何需要在 VM 内完成的**读 / 写 / 执行 / 查阅 / 新建 / 修改 / 删除**操作，都必须经本 Skill 及其派生的领域 Skill 引导，通过本项目暴露的通道（**MCP 直调** `winvm` 连接器 / **A2A 委派** `winvm-a2a` 连接器）执行。

**严格禁止**（绕过能力层与审批闸，一律不允许）：
- ❌ 裸 `ssh` 进 VM 直接跑 PowerShell / 命令
- ❌ 裸 `powershell` / `psexec` / `winrm` 直连 VM 执行变更
- ❌ 绕过本项目通道、自行构造 HTTP 请求打 VM `/mcp` `/a2a`
- ❌ 跳过审批闸直接执行 L2/L3 操作
- ❌ **现场手写一次性脚本**（`*.mjs` / `*.ps1` / `curl` 等）直打 A2A `/a2a`、MCP `/mcp` 或 SSH 通道——
  当本会话工具面没有 `winvm` / `winvm-a2a` 连接器工具时，**唯一正确动作是停止并告知用户启用连接器**，
  而不是自行写脚本绕行（绕行即失控：无风险分级、无审批闸、无审计）。

**标准执行路径**（每个 VM 任务都走同一条路，仅参数不同）：
1. 调用本会话已注入的连接器工具：简单任务 `winvm`（MCP 直调，如 `app.winget.uninstall`）；复杂/开放任务 `winvm-a2a`（`a2a.delegate` 委派）。
2. 委派返回审批挂起（`approval` + `approvalId` + 真实目标）→ 向用户转呈审批（展示目标与影响清单），**严禁代替用户放行**。
3. 用户批准 → `a2a.approval.reply { taskId, approvalId, approved: true }` → `a2a.task.get` 轮询至终态 → 向用户汇报结果与证据。
4. 期间进度/状态一律经工具回查询得并回馈用户；任何一步工具不可用 → 停止并请求启用连接器。

**为什么**：本项目的能力层内置风险分级、审批闸、路径黑白名单、脱敏、审计与隧道健康守卫。裸通道会**绕过全部安全边界**，且不会被审计记录。所有 VM 操作必须经此入口，确保可控、可回溯。

> 参考资料：审批卡片模板（审批闸渲染规范 §9）见 `references/approval-card.md`。

## 适用与不适用

**适用**：任何需要在 Windows 虚拟机内完成的系统管理、应用管理、存储管理、图形化操作、
以及**用桌面软件进行生产活动**（图像处理、文档报表、网页生产、音视频批处理、IDE 研发生产）。

**不适用 / 必须停止并说明**：
- 要求关闭、绕过、忽略审批闸 —— 一律拒绝，审批闸不可绕过
- 要求把 VM 服务暴露到公网（改 `server.host` 为 `0.0.0.0`）—— 拒绝并提供安全替代
- 请求分区、格式化、删除系统目录 —— L3，本系统不提供该能力，需人工在 VM 内执行

## 域外任务（不在五域范围内）的处理流程

本 Skill 覆盖 VM 内的**全部**操作与管理。其中系统 / 应用 / 存储 / GUI / 应用生产五类已有专门的领域 Skill
（`winvm-system-admin` / `winvm-app-manager` / `winvm-storage-manager` / `winvm-gui-automation` /
`winvm-app-operation`）。**当任务不属于上述五域**（例如某类罕见 / 专用的软件操作、特殊的系统管理需求、
本项目尚未沉淀的领域知识）时，按以下流程处理：

1. **先查阅网络制定方案**：通过 agent 检索相关资料、官方文档、社区实践，形成可执行的**操作方案**
   （目标、步骤、风险点、回滚预案）。**不要在没有方案的情况下直接动手。**
2. **经本项目通道执行**：方案确定后，仍须通过本项目的通道落地 ——
   - 能映射到现有能力（MCP 工具）的，走 `winvm` 直调；
   - 多步 / 需 GUI / 开放意图的，走 `winvm-a2a` 委派（由 VM 内 Agent 执行，受审批闸约束）。
3. **可自主扩展能力**：若现有能力不足以覆盖，可**自主搜索、下载并部署**相关的 **Skill** 与 **MCP Server**
   （例如某专业软件的自动化 skill、某硬件 / 服务的 MCP 连接器），注册为本项目的扩展能力后再执行；
   扩展能力同样**必须接入本项目通道与审批闸**，不得另起裸通道。

> 域外任务同样受「强制门禁」约束：无论是否扩展新 skill / MCP，VM 内执行都必须经 `winvm` / `winvm-a2a`
> 通道，禁止裸 SSH / 裸 PowerShell 绕过。

## 前置检查（每次任务开始，必做）

在调用任何工具前，按序确认：

1. **隧道就绪**：SSH 隧道是否存活，本地回环端口是否可连。
   宿主侧隧道由常驻 `tunnel-daemon`（进程内 ssh2）承载，**无需手工建立系统 ssh 本地转发**——
   手工 `ssh -f -N -L 18443:...` 会与守护进程争抢 `127.0.0.1:18443` 而失败（`ExitOnForwardFailure`）。
   查状态 / 拉起（**部署态命令，任意 cwd 可用**；路径 = 插件缓存根启动器）：
   ```
   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel status    # 在线健康判据：state: RUNNING / healthy: true
   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure    # 幂等：已在线则跳过，不健康重启一次，未运行则拉起
   ```
   （开发态备选：在**仓库根**执行 `node delivery/winvm-plugin.mjs tunnel …`。）
2. **服务健康**：调用 `meta.health.check`。
3. **会话状态**（仅当涉及 GUI）：确认 `session.state == healthy`。
   若为 `unavailable` / `black-screen`，**不要重试**，直接告知用户并给修复建议
   （见 `winvm-gui-automation`）。

> 不满足时**明确报错并给修复指引**，不要靠重试硬扛 —— 这类超时故障最难排查。
>
> **例外（有界重试）**：若失败是 `PROVIDER_UNAVAILABLE`（桥进程被杀/崩溃后正在自愈），
> 桥具备**自动自愈**能力，可做**有界重试**——退避后**至多再试 1–2 次**：
> - 第一次失败 → 等 ~1–3s（自愈重建 ps-bridge 需要时间）再试一次；
> - 仍失败 → 再退避一次重试；**第 3 次仍失败即停止**，读 `meta.health.check` 的
>   `psBridge.restarts` / `psBridge.lastError` 判断是「仍在自愈」还是「配置错误」。
> - 若 `lastError` 指向配置/环境问题（如 CLI 未安装、路径不存在、端口被占），**重试无用**，
>   直接报错并给修复指引。
>
> 区分关键：**「桥自愈中」→ 有界退避重试**；**「配置错误」→ 不重试，直接报错**。

## 前置检查：tunnel 在线健康（必做，先于域路由 / 通道选择）

> 任何 VM Windows 操作**之前**，先确认 **tunnel-daemon 在线健康**（宿主 → VM 的 SSH 隧道）。
> **不在线必须先 `start` / `restart`，确保 tunnel to VM Windows 在线健康**，再进入域路由与通道选择。

**为什么必做（危害）**：隧道不在线时，**所有 MCP 直调与 A2A 委派调用都会失败或黑洞**——
表现为「工具超时」，而非「连接失败」，极难定位（见文末「已知陷阱」）。

**可直接运行的命令**（**部署态，任意 cwd 可用**）：

> 命令锚点 = 插件缓存根的 `winvm-plugin` 启动器：
> `~/.workbuddy/plugins/cache/winvm/winvm-bridge/<version>/winvm-plugin`（本机 `<version>` = `0.1.0`）。
> 该启动器以**自身所在目录**定位脚本，**与当前 cwd 无关**（非仓库根亦可直接运行）。
> （**开发态备选**：在**仓库根**执行 `node delivery/winvm-plugin.mjs …`。）

| 目的 | 命令 | 判定 |
|---|---|---|
| 查隧道状态 | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel status` | **判定只以本命令输出为权威**：`state: RUNNING` / `healthy: true`。`~/.workbuddy/winvm/tunnel.state.json` 仅作诊断、**可能陈旧**（实测曾出现 state 记的 pid 已死、而 pidfile 的 pid 真活），**不得据其判健康** |
| 恢复 / 拉起（幂等） | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure` | 已在线则跳过；不健康（DEGRADED）则自动重启一次；未运行则拉起 |
| 强制重启（必要时） | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel restart` | 先 `stop`（必要时强杀）再 `start`，用于「在线但不健康」的兜底恢复 |
| 健康确认（收尾必跑） | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin health` | 需 `ok: true` 且 `capabilities.available == capabilities.count` |

- `tunnel ensure` / `tunnel restart` 均**幂等且收敛**：重复调用不会产生第二个 daemon 实例。
- **健康确认通过后**（`ok:true` 且 `capabilities.available == capabilities.count`），方可调用任何 MCP / A2A 工具；
  否则先按上表恢复，再重试。

## 通道选择（核心决策）

### 通道模式配置（tunnel-mode）—— 先查配置，再走决策树

宿主侧通道选择策略由 **tunnel-mode** 配置控制（单一事实源：`~/.workbuddy/winvm/vm-conn.json` 的 `tunnelMode` 字段）。
**本节开始任何通道选择之前，先执行 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel-mode` 查询当前模式**（无参=只读，不会改配置）。

| 模式 | 语义 | 通道选择行为 |
|---|---|---|
| `mcp`（默认） | 只走 MCP 直调 | **一律使用 MCP 直调连接器（`winvm`）**，不委派 A2A —— 即使任务复杂，也由宿主自己多轮编排（拆步骤、逐步直调） |
| `a2a` | 只走 A2A 委派 | **一律委派 A2A（`winvm-a2a`）** —— 简单任务也委派给 VM 内 Agent |
| `intelligent` | 智能判断 | 按下方决策树判断（单步结构化 → MCP；多步/GUI/开放意图 → A2A） |

- 查询：`winvm-plugin tunnel-mode`（输出当前模式与来源：flag / env / vm-conn / default）。
- 修改：`winvm-plugin tunnel-mode intelligent`（写回 `vm-conn.json`，持久生效）；
  临时覆盖用 `--tunnel-mode <mode>` flag 或环境变量 `WINVM_TUNNEL_MODE`（优先级：flag > env > vm-conn.json > 默认 mcp）。
- 若配置值非法，CLI 会回落 `mcp` 并打印告警 —— 以 CLI 输出的实际模式为准。

> 边界说明：tunnel-mode 是**指引性配置**（事实源 + 本 skill 指引 + CLI 展示），不在桥接层强制拦截工具调用 ——
> 但宿主 LLM 必须遵守：`mcp` 模式下即使认为任务"复杂"也走 MCP 直调多轮编排；`a2a` 模式下即使任务"简单"也委派。

### 智能判断决策树（`intelligent` 模式适用）

```
是否单步、结果结构化、需精确控制？
├─ 是 → MCP 直调（透明、省 token、可复现）
└─ 否 → 是否多步自主规划 / 强 GUI / 预期 >30s / 需要"看屏幕再决定"？
         ├─ 是 → A2A 委派（artifact 回传 + 进度流）
         └─ 否 → MCP 直调，你自己多轮编排
```

| 场景 | 通道 | 理由 |
|---|---|---|
| 查磁盘、启服务、读注册表 | MCP | 单步、结果结构化 |
| "帮我把 C 盘清理到 20GB 空闲" | A2A | 多步、需反复判断 |
| "打开浏览器登录某网站" | A2A | 强 GUI、长时、要截图回传 |
| "用 ffmpeg 把 A.mp4 转 720p" | MCP | 单步、CLI、结构清晰 |
| "用 Photoshop 把照片大山背景换成海洋" | A2A（LLM VM Agent）| 开放意图、需常识、多步 GUI |
| "列出最近 10 条系统错误日志" | MCP | 单步 |

### 两条通道分别用什么工具

部署后宿主侧会有**两个连接器**，各司其职：

| 连接器 | 形态 | 用途 | 工具 |
|---|---|---|---|
| `winvm` | Streamable HTTP → VM `/mcp`（经 SSH 隧道） | **简单任务**：单步、结构化、可精确控制 | 点分能力 ID，如 `system.info.get`、`appops.cli.invoke`、`gui.screen.capture` |
| `winvm-a2a` | 本地 stdio MCP server（A2A 委派桥） | **复杂任务**：多步自主规划 / 强 GUI / 开放意图 | `a2a.delegate`、`a2a.task.get`、`a2a.approval.reply`、`a2a.task.cancel`、`a2a.health` |

> 宿主工具名中的点号通常渲染为下划线：`system.info.get` → `winvm__system_info.get`，
> `a2a.delegate` → `winvm-a2a__a2a_delegate`。以宿主 `tools/list` 实际返回为准。

**简单任务（MCP 直调，一步到位）**：

```
winvm__system_info.get()
winvm__appops_cli.invoke({
  "app": "ffmpeg",
  "command": "ffmpeg -i in/a.mp4 -vf scale=1280:720 out/a_720p.mp4",
  "outputDirectory": "C:\\WinVMWorkspace\\out"
})
```

> ⚠ `appops.cli.invoke` **必须把完整命令行放进 `command`**（可含/不含可执行名，含可执行名时会自动剥离前缀）。
> `app` 只用于选择可执行文件与套用安全校验；**只填 `app`、不给 `command` 会以零参数启动**
> （如 `node.exe` 会进入 REPL）而挂起整条桥 —— 这是必须避免的用法。
> 需拆成「可执行名 + 参数」时用 `arguments`；`workingDirectory` / `outputDirectory` 可选，
> 输出目录受策略白名单约束（默认 `C:\WinVMWorkspace\out`、`%USERPROFILE%\WinVMWorkspace\out`）。

**复杂任务（A2A 委派给 VM 内 AI Agent）**：

```
winvm-a2a__a2a.delegate({
  "goal": "用 Photoshop 帮我把这张照片里的大山背景换成海洋，调色自然一点",
  "allowedCapabilities": ["appops.*", "gui.*"],
  "maxRisk": "L2",
  "timeoutMs": 600000
})
// 返回：{ ok, taskId, state, summary, progress[], artifacts[], approval? }
```

`a2a.delegate` 会**流式接收** VM 内 Agent 的执行过程：
- `progress[]` —— 阶段性进展（中间产物会实时回传，不是最后一次性给）
- `artifacts[]` —— 产物摘要（图片直接作为图像内容回传）
- `approval` —— 若某步为 L2/L3，任务挂起等待审批（见 §审批闸协议）
- 超时未结束：返回 `timedOut: true` 与 `taskId`，用 `a2a.task.get` 继续取结果

## 标准流程

1. **前置检查**（隧道 / 健康 / 会话）
2. **意图 → 领域**：按 §领域路由表 分派
3. **通道选择**：按 §通道选择
4. **风险预判**：
   - L0/L1 → 直接执行
   - **L2/L3 → 先 dry-run 预览（免审批），再走审批闸**：
     带 `dryRun: true` 的调用**不触发审批闸**（dry-run 不改变系统状态），直接返回变更计划与影响清单；
     把计划展示给用户并取得确认后，**去掉 `dryRun`、以同一参数**重新调用，此时才进入审批闸、按卡片模板展示影响清单。
5. **执行**
6. **汇总与回溯**：给出 `traceId`；引用 artifact（截图、变更清单、执行步骤）

## 领域路由表

| 意图特征 | 路由到 |
|---|---|
| 服务、进程、计划任务、注册表、网络、用户、环境变量、事件日志、电源 | `winvm-system-admin` |
| 安装、卸载、升级、启动应用、快捷方式、默认程序、UWP | `winvm-app-manager` |
| 磁盘、分区、空间、文件、目录、搜索、压缩、回收站 | `winvm-storage-manager` |
| 截图、键鼠、窗口、UIA、剪贴板、浏览器 | `winvm-gui-automation` |
| 用 Photoshop/Office/浏览器/ffmpeg/IDE 等**软件把活干出来** | `winvm-app-operation` |
| 跨域或不确定 | 先拆解，再逐域分派 |

## 审批闸协议（L2/L3 必守）

> 审批卡片：统一模板见 [`./approval-card.md`](./approval-card.md)（§审批卡片模板 · 唯一正文；本文件不复制正文）

### MCP 通道
首次调用 L2/L3 工具 → 返回 `APPROVAL_REQUIRED` + `approvalId` + `approval.preview`
（含 `impact` 影响清单与 dry-run 预览）。
**向用户展示影响清单**，取得确认后，用同一参数并附 `__approvalId` 重新调用。

> **`dryRun: true` 免审批**：凡是支持 `dryRun` 的 L2/L3 能力（如 `system.power.control`、`app.winget.uninstall`），
> 带 `dryRun: true` 调用**直接放行、不产生审批卡片**，返回变更计划（`would`/`plan`）与影响清单。
> 这是「L3 先 dry-run 再确认」得以真正执行的前提：**先 dry-run 拿计划 → 展示 → 用户确认 → 再去掉 dryRun 执行**。
> 审批预览会对支持 `dryRun` 的能力附带 dry-run 计划摘要。

### A2A 通道（经 winvm-a2a 连接器）
`a2a.delegate` 返回 `state: "input-required"`，并带
`approval { approvalId, message, risk, capabilityId, summary, impact, preview, resumeHint }`。
（以上字段由宿主桥透传：`impact` / `preview` 与 VM 下发**逐项一致**；凭据类字段 `password` / `privateKey` / `passphrase` / token / secret **已脱敏、永不呈现**。）
**先向用户展示 `approval.message` 与影响清单**，取得确认后再调用：

```
winvm-a2a__a2a.approval.reply({
  "taskId": "task_xxx",
  "approvalId": "apr_8f3c",
  "approved": true
})
```

拒绝用 `"approved": false`（任务终止）；要中止整个任务用 `a2a.task.cancel`。
审批期间 VM 侧任务挂起，超时按拒绝处理（fail-closed）。

**规则**：未经展示与确认，不得代替用户批准。审批超时按拒绝处理（fail-closed）。

## 高危清单（L2/L3，强制动作）

| 风险 | 典型操作 | 强制动作 |
|---|---|---|
| L2 | 删除文件/目录、卸载应用、结束进程树、改网络配置、写 HKLM 注册表 | 审批 + before/after 快照 |
| L3 | 关机/重启/休眠、改启动配置、批量删除 | **先 dry-run（`dryRun:true`，免审批）** → 审批 + 二次确认 |

额外约定：
- **删除默认进回收站**；仅当用户明确要求"永久删除"且已审批，才用 `permanent: true`
- 委派时通过 `allowedCapabilities`（最小权限）与 `maxRisk`（默认 L1）收紧范围
- **L3 规则引用**：L3 一律「**先 `dryRun:true` 预览（免审批）→ 审批 + 二次确认 → 执行**」；卡片与二次确认短句要求见模板 L3 版（[`./approval-card.md`](./approval-card.md) §2）。dry-run 由能力自身支持——带 `dryRun:true` 调用即免审批直接返回变更计划，故**不存在「dry-run 预览未就绪即阻断」这一分支**。本文件不复制卡片正文。

## 错误码分层（`error.code` vs `error.reason`）

调用失败时，返回体的 `error` 分**两层**，用途不同，必须分开看：

| 字段 | 层级 | 作用 | 取值 |
|---|---|---|---|
| `error.code` | **契约层**（封闭 10 码） | 决定**能不能重试 / 要不要审批** | `INVALID_PARAMS` `UNKNOWN_CAPABILITY` `UNSUPPORTED_GOAL` `POLICY_DENIED` `APPROVAL_REQUIRED` `SESSION_UNAVAILABLE` `SESSION_BLACK_SCREEN` `PROVIDER_UNAVAILABLE` `TIMEOUT` `EXECUTION_FAILED` |
| `error.reason` | **领域层**（原因码，可选） | 决定**具体补救动作** | PS 侧领域码：`FILE_NOT_FOUND` / `PATH_NOT_FOUND` / `CLI_NOT_FOUND` / `SERVICE_NOT_FOUND` / `PROCESS_NOT_FOUND` / `REG_PATH_NOT_FOUND` / `INVALID_ARGUMENT` / `FILE_TOO_LARGE` / `PROTECTED_PROCESS` … |

`retryable` 由 `code` 决定（`TIMEOUT` / `PROVIDER_UNAVAILABLE` / `APPROVAL_REQUIRED` / `SESSION_*` 为 `true`，其余 `false`）。
**先看 `code` 决定「能不能重试、要不要审批」，再看 `reason` 决定「怎么修」。**

| `reason`（常见） | 含义 | 处置（**不要在无意义重试上耗时**） |
|---|---|---|
| `FILE_NOT_FOUND` / `PATH_NOT_FOUND` | 文件 / 目录不存在 | **修路径**，或先 `storage.dir.manage` 建目录；**不重试** |
| `CLI_NOT_FOUND` / `WINGET_NOT_FOUND` | 可执行文件 / 包不存在 | **先装应用**（`winvm-app-manager`）或改用已装 CLI；**不重试** |
| `SERVICE_NOT_FOUND` / `PROCESS_NOT_FOUND` | 服务 / 进程不存在 | **校验名称或 PID**（`system.service.list` 为模糊匹配，可用于核对）；**不重试** |
| `REG_PATH_NOT_FOUND` | 注册表路径不存在 | 用**带冒号**的 `HKLM:\...` / `HKCU:\...`，并核对可读根键白名单 |
| `INVALID_ARGUMENT` | 参数非法 | **修参数**（此时 `code` 为 `INVALID_PARAMS`） |
| `TIMEOUT` | 执行超时 | **调大 `timeoutMs`**（`code` 为 `TIMEOUT`、`retryable=true`） |
| `FILE_TOO_LARGE` | 超过读取上限 | 缩小查询范围或分段读取 |
| `PROTECTED_PROCESS` | 受保护进程（`lsass` 等） | 属**刻意设计**，**不要绕过** |

> **`reason` 缺失**时按 `code` 处理即可（说明不是领域错误，或该错误码本身就是契约码）。
> **出现 `reason` = 领域错误**，其补救动作通常**不是重试**，而是修路径 / 装应用 / 校验名称 / 调参数。

## 入参契约错误处理（`INVALID_PARAMS` / `INVALID_ARGUMENT`）

工具返回 `error.code == "INVALID_PARAMS"` 且 `error.reason == "INVALID_ARGUMENT"` 时，
**不是 VM 执行失败，而是你的入参不符合该能力的契约**（参数名写错 / 漏传必填 / 取值非法）。
这类错误由 VM 服务**在发起 PowerShell 之前**拦截，**不产生任何桥往返**（毫秒级返回，与真实执行耗时相差数百倍）。

**处置（禁止原样重试 —— 参数不变，重试必然再次失败）**：

1. **先看 `error.details`**（结构化，直接定位，无需猜）：
   - `details.missing`：缺失的**必填**参数名（未传，或值为 `null`）；
   - `details.unknown`：**不被支持**的参数名（多半是写错，或该能力根本没有此参数）；
   - `details.allowed`：该能力**允许**的全部参数名；
   - `details.invalid`：已提供但**取值非法**的键，元素形如 `{key, expected, got}`（`got` 只给类型类别）。
2. 按 `error.message` 中的「该能力可用参数：…」与上面的 `details`，**改正参数名 / 补齐必填项**后再调用。
3. **拿不准某能力有哪些参数时，先查 `inputSchema`**：MCP `tools/list` 中每个工具的
   `inputSchema.properties`（可用参数）与 `inputSchema.required`（必填项）即**权威契约**，
   调用前先比对，可从源头避免该错误。

**四种子场景**：

| 场景 | `details` | 典型成因 |
|---|---|---|
| 缺必填 | `missing:[...]`、`unknown:[]` | 漏传 `required` 中的参数（如 `storage.file.read` 少了 `path`） |
| 未知参数 | `missing:[]`、`unknown:[...]` | 参数名拼错 / 误用他能力参数（如给 `storage.dir.manage` 传 `action`） |
| 未知 + 缺必填 | 两者均非空 | 参数名记错（如 `gui.window.control` 传 `windowTitle`，其实必填是 `title`） |
| 取值非法 | `invalid:[{key,expected,got}]` | 类型不符（如 `system.process.list` 的 `top` 传 `"abc"`）或枚举越界（如 `system.service.control` 的 `action` 传 `"bogus"`） |

> `code=INVALID_PARAMS` 一律 `retryable=false`：**修参数、别重试**；
> 与 `PROVIDER_UNAVAILABLE`（桥可自愈、可**有界退避重试**）性质相反，切勿混为一谈。

## CL-018 新增行为（会话 / 日志 / 缓存 / 超时 / 过滤 / 清单合并）

本版对若干能力做了**纯附加**增强，既有字段与语义不变；调用方不读新字段时行为完全一致。

### 委派超时（`a2a.delegate`）与冷启动窗口

- 出厂默认 `timeoutMs = 600000`（≥150s，**不得下调**）。宿主可经环境变量
  `WINVM_A2A_TIMEOUT_MS` 调整（优先级：显式 `timeoutMs` > 环境变量 > 默认）。
- **首次委派**（VM 内 LLM 运行时首次拉起，或空闲回收后再次拉起）需**全额进程级冷启动**，
  真机实测 75–107s。此区间内的等待属**正常冷启动窗口**，**不是故障**，不要误判为"卡死"。
- 超时返回的 `summary` 会明确提示"可能仍处于正常冷启动窗口（75–107s）"，
  并可用 `a2a.task.get` 查询后续结果，或以更大的 `timeoutMs` 重试。
- 常驻会话就绪后，后续轮次复用同一进程，延迟显著下降（无需再付冷启动）。

> **性质标注（如实）｜本项为「缓解（mitigation）」，非修复。**
> 调大等待上限（`timeoutMs` / `WINVM_A2A_TIMEOUT_MS`）只**降低**"正常慢启动被误判为失败"的**失败率**，
> 并**不消除**首轮进程级冷启动成本，更不是故障的"解决"。**根治**手段是下述「LLM 常驻会话」
> （复用长驻进程、免每轮冷启动）。本文档及任何用户可见产出**不得**将本项表述为
> "已修复 / 已解决 / 彻底解决"等承诺性措辞。

> **环境变量开关（`DISABLE_TELEMETRY` / `DISABLE_AUTOUPDATER` 等）：存在且可用，但无实测收益，不作为缓解手段。**
> 架构师真机 A/B 未证实收益（顺序实验 off 更慢：9194→16318ms；配对交替约 14% 提升但含 36s 离群，判为**噪声**）。
> 故**不标注为"不适用"**，而如实标注"**可用但无可采信收益**"—— 请勿据此作为提速或降失败率的手段。

### LLM 常驻会话（`/health.llmSession`）

- VM 内 LLM 运行时默认以**常驻会话**方式复用（`-p --input-format stream-json ...`），
  避免每轮全额冷启动。空闲 TTL（默认 300s）到期后释放，下次委派自动重建。
- `/health.llmSession` 暴露会话态：`state`（`stopped`/`starting`/`ready`/`degraded`/`disabled`）、
  `pid`、`restarts`、`idleMs`、`lastError`（仅失败后出现）。字段缺省即"旧版本行为"。
- **降级不破功能**：常驻不可用时自动回退为单次 `-p`，委派结果语义不变（`summary` 会如实标注）。
  `state=disabled` 表示已超重建上限，此后恒走单次路径。

### 服务日志（`/health.logging`）

- 服务日志落盘到 `%LOCALAPPDATA%\WinVMBridge\logs\winvm-service-YYYY-MM-DD.log`
  （单文件 10MB / 按天切 / 保留 7 个文件 / 14 天，均可经 env 调整）。
- `/health.logging.degraded=true` 表示日志目录**不可写**、已回退控制台 —— **服务仍正常启动**
  （这是有效状态，不是故障）。`reason` 给出原因。
- 日志已**脱敏**：凭据类字段（token/密码/私钥等）不会以明文落盘。

### 网络配置缓存（`system.network.config`）

- 该能力现带**进程内 TTL 缓存**（默认 45s，env `WINVM_NETCFG_TTL_MS`）；服务启动时**异步预热**一次，
  使"服务重启后的首次调用"也能秒回。
- 返回值新增 `cached`（是否命中缓存）、`cacheAgeMs`、`collectedAt`（本次数据采集时间）。
- **需要最新数据时**：调用时带 `refresh: true` **绕过缓存**强制重新采集。

### 应用生产状态（`appops.state.query`）—— 非生产型窗口过滤

- 结果自动**过滤非生产型窗口**：安装器临时窗口（`*tmp Setup*`）、通知助手（`NotifyHelper`）、
  **空标题**的框架宿主窗口（`ApplicationFrameHost` 承载 UWP 时的空白框架窗）。
- **有真实标题的应用窗口一律保留**（如 UWP「设置」），**绝不**按进程名整体排除
  `ApplicationFrameHost` 等框架宿主（避免误杀真实应用）。
- 返回值新增 `filteredCount` / `filtered`（被过滤项及原因）与 `policy`（生效名单），**透明可审计**。
- 名单数据驱动：部署侧可经 env `WINVM_APPOPS_EXCLUDE_PROCS` /
  `WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS` / `WINVM_APPOPS_EXCLUDE_PROC_PATTERNS` 追加
  （后者为**进程名正则**名单，如锚定的 `(?i)_installer$` / `(?i)^setup`，用于淘汰
  "进程名含 installer 但标题不含"的安装器；模式须**锚定**以免误杀正常程序）。

### 已装应用清单（`app.inventory.list`）—— 合并与架构

- 合并键为 **`(name, version)`**：同名同版本的重复注册键合并为一条；
  **同名但版本不同 → 保留多条**（不再按名称去重而误删）。
- 每条新增 `registryKeyCount`（该 `(name,version)` 的原始注册键条数，反映重复登记）
  与可选 `architectures`（**仅**由 hive 可靠推断时填充：HKLM64→`x64`、HKLM32→`x86`；
  推断不出则**省略**，不会硬造）。

## 已知陷阱

- **隧道没建就调工具** → 表现为"工具超时"，而非"连接失败"，极难定位。务必先做前置检查
- **把 MCP 工具名写驼峰** → 工具名是点分能力 ID（如 `system.service.control`），不是驼峰
- **绕过审批重复调用** → 不会成功，且会被审计记录
- **A2A 用旧方法名** → v1.0 是 `message/send`，不是 `tasks/send`（后者返回 MethodNotFound）
- **委派后不看 artifact** → 等于黑盒。必须读取 `execution-steps` 与截图
- **把 `PROVIDER_UNAVAILABLE` 当"配置错误"** → 桥进程被杀后**会自动自愈**，此时应**有界退避重试**
  （至多 1–2 次）；仅当 `meta.health.check` 的 `psBridge.lastError` 指向真实配置问题时才直接报错。
  反之，**把配置错误当"自愈中"反复重试**只会白白耗时 —— 用 `psBridge.restarts`/`lastError` 区分。

## 参考

- 领域细节：见各领域 Skill
- 接口契约：`docs/02-design/INTERFACES.md`
- 安全设计：`docs/02-design/SECURITY-GOVERNANCE.md`
- 能力清单：`docs/02-design/CAPABILITY-MODEL.md`
