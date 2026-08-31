---
id: winvm-orchestrator
name: WinVM 总控编排
description: >
  Windows 虚拟机操作的总控入口。负责：意图识别 → 领域路由 → 通道选择
  （MCP 直调 vs A2A 委派）→ 风险分级 → 审批闸 → 隧道就绪检查 → 结果汇总与回溯。
  当用户要"在虚拟机里做事""操作 Windows""管理虚拟机"时，优先加载本 Skill。
version: 0.1.0
domains: [system, app, storage, gui, appops]
entry: true
triggers:
  - 在虚拟机里操作
  - 管理 Windows 虚拟机
  - 虚拟机里安装/删除/查询
  - 看看虚拟机屏幕
  - 用虚拟机里的软件干活/生产
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

## 适用与不适用

**适用**：任何需要在 Windows 虚拟机内完成的系统管理、应用管理、存储管理、图形化操作、
以及**用桌面软件进行生产活动**（图像处理、文档报表、网页生产、音视频批处理、IDE 研发生产）。

**不适用 / 必须停止并说明**：
- 要求关闭、绕过、忽略审批闸 —— 一律拒绝，审批闸不可绕过
- 要求把 VM 服务暴露到公网（改 `server.host` 为 `0.0.0.0`）—— 拒绝并提供安全替代
- 请求分区、格式化、删除系统目录 —— L3，本系统不提供该能力，需人工在 VM 内执行

## 前置检查（每次任务开始，必做）

在调用任何工具前，按序确认：

1. **隧道就绪**：SSH 隧道是否存活，本地回环端口是否可连。
   建立命令（示例）：
   ```
   ssh -f -N -L 18443:127.0.0.1:18443 -o ExitOnForwardFailure=yes \
       -o ServerAliveInterval=30 -o ServerAliveCountMax=3 <user>@<vmhost>
   ```
2. **服务健康**：调用 `meta.health.check`。
3. **会话状态**（仅当涉及 GUI）：确认 `session.state == healthy`。
   若为 `unavailable` / `black-screen`，**不要重试**，直接告知用户并给修复建议
   （见 `winvm-gui-automation`）。

> 不满足时**明确报错并给修复指引**，不要靠重试硬扛 —— 这类超时故障最难排查。

## 通道选择（核心决策）

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
   - **L2/L3 → 必须先走审批闸**，向用户展示 dry-run 预览与影响清单，取得确认
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

### MCP 通道
首次调用 L2/L3 工具 → 返回 `APPROVAL_REQUIRED` + `approvalId` + `approval.preview`
（含 `impact` 影响清单与 dry-run 预览）。
**向用户展示影响清单**，取得确认后，用同一参数并附 `__approvalId` 重新调用。

### A2A 通道（经 winvm-a2a 连接器）
`a2a.delegate` 返回 `state: "input-required"`，并带
`approval { approvalId, message, risk, capabilityId }`。
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
| L3 | 关机/重启/休眠、改启动配置、批量删除 | 审批 + 二次确认 + **先 dry-run** |

额外约定：
- **删除默认进回收站**；仅当用户明确要求"永久删除"且已审批，才用 `permanent: true`
- 委派时通过 `allowedCapabilities`（最小权限）与 `maxRisk`（默认 L1）收紧范围

## 已知陷阱

- **隧道没建就调工具** → 表现为"工具超时"，而非"连接失败"，极难定位。务必先做前置检查
- **把 MCP 工具名写驼峰** → 工具名是点分能力 ID（如 `system.service.control`），不是驼峰
- **绕过审批重复调用** → 不会成功，且会被审计记录
- **A2A 用旧方法名** → v1.0 是 `message/send`，不是 `tasks/send`（后者返回 MethodNotFound）
- **委派后不看 artifact** → 等于黑盒。必须读取 `execution-steps` 与截图

## 参考

- 领域细节：见各领域 Skill
- 接口契约：`docs/02-design/INTERFACES.md`
- 安全设计：`docs/02-design/SECURITY-GOVERNANCE.md`
- 能力清单：`docs/02-design/CAPABILITY-MODEL.md`
