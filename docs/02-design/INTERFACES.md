# 接口定义（INTERFACES）

| 项 | 值 |
|---|---|
| 文档 ID | INTERFACES-winvm-bridge-v1 |
| 版本 | v1.0 |
| 日期 | 2026-08-28 |

---

## 1. 接口总览

| 编号 | 接口 | 协议 | 方向 |
|---|---|---|---|
| IF-1 | MCP 工具接口 | MCP（Streamable HTTP / stdio） | 宿主 → VM |
| IF-2 | A2A 委派接口 | A2A v1.0（JSON-RPC 2.0 over HTTPS） | 宿主 → VM |
| IF-3 | Agent Card | HTTP GET | 宿主 → VM（发现） |
| IF-4 | 能力执行接口 | 内部（TS） | 桥接层 → VM Agent 适配器 |
| IF-5 | ps-bridge 协议 | NDJSON over stdio | vm-service → PowerShell 常驻进程 |
| IF-6 | 健康检查 | HTTP GET | 宿主 → VM |

---

## 2. IF-1 MCP 工具接口

### 2.1 端点

| 传输 | 端点 |
|---|---|
| Streamable HTTP（默认，经 SSH 隧道） | `http://127.0.0.1:18443/mcp` |
| stdio | 进程 stdin/stdout |

### 2.2 工具命名

**保留能力 ID 的点分形式**，不做驼峰化：`system.service.control`、`storage.file.delete`、`gui.screen.capture`。

理由：便于能力 ID 反查、策略匹配、审计归档，避免命名转换导致的能力追溯丢失。

### 2.3 标准工具集（由能力注册表自动生成）

> 数量与清单以 `packages/vm-capabilities/src/registry/definitions.ts`（**54 条**）为唯一事实源
> （2026-10-08 对账：原列 `meta.audit.query` / `meta.policy.describe` / `meta.task.status`
> 未注册，已摘除，「V2 规划·当前不可用」见 `CAPABILITY-MODEL.md` §5）。

| 类别 | 工具 |
|---|---|
| `meta.*` | `meta.health.check`、`meta.capability.list`、`meta.session.status`（3 项） |
| `system.*` | 见 `CAPABILITY-MODEL.md` §3.1（14 项） |
| `app.*` | 见 §3.2（8 项） |
| `storage.*` | 见 §3.3（13 项，**不含** L3 分区/格式化） |
| `gui.*` | 见 §3.4（11 项） |
| `appops.*` | 见 §3.5（5 项） |

### 2.4 统一返回结构

```jsonc
{
  "traceId": "tr_01J...",
  "ok": true,
  "data": { /* 符合该能力 output schema */ },
  "artifacts": [
    { "kind": "screenshot", "mime": "image/png", "encoding": "base64",
      "data": "iVBORw0...", "name": "after-20260828T121500Z.png" }
  ],
  "risk": "L1",
  "durationMs": 142,
  "auditRef": "aud_01J..."
}
```

失败：

```jsonc
{
  "traceId": "tr_01J...",
  "ok": false,
  "error": {
    "code": "POLICY_DENIED",          // 见 §2.6
    "message": "路径不在白名单内",
    "details": { "path": "C:\\Windows\\System32" },
    "retryable": false
  },
  "risk": "L2",
  "auditRef": "aud_01J..."
}
```

### 2.5 审批闸的 MCP 形态

L2/L3 操作首次调用返回**待确认**（而非直接执行）：

```jsonc
{
  "traceId": "tr_01J...",
  "ok": false,
  "error": { "code": "APPROVAL_REQUIRED", "retryable": true },
  "approval": {
    "approvalId": "apr_01J...",
    "risk": "L2",
    "capabilityId": "storage.file.delete",
    "preview": { /* dry-run 预览：将影响 N 个对象，共 X MB */ },
    "impact": ["C:\\temp\\old\\a.log", "C:\\temp\\old\\b.log"],
    "resumeHint": "确认后以 approvalId 重新调用本工具"
  }
}
```

宿主确认后重发同一请求并附 `approvalId` 即执行。

### 2.6 错误码

| 码 | 语义 | 可重试 |
|---|---|---|
| `INVALID_PARAMS` | 参数不符合 input schema | 否 |
| `UNKNOWN_CAPABILITY` | 能力未注册 | 否 |
| `POLICY_DENIED` | 策略引擎拒绝（白名单/路径/命令） | 否 |
| `APPROVAL_REQUIRED` | 需审批（附 approval 结构） | 是（带 approvalId） |
| `SESSION_UNAVAILABLE` | **无交互式会话**，GUI 能力不可用 | 是（恢复后） |
| `SESSION_BLACK_SCREEN` | 检出黑屏（**明确告警，不静默返回**） | 是（恢复后） |
| `PROVIDER_UNAVAILABLE` | VM Agent provider 未就绪 | 是 |
| `TIMEOUT` | 执行超时 | 视能力 |
| `EXECUTION_FAILED` | 底层执行失败（附 PowerShell 错误） | 视能力 |

---

## 3. IF-2 A2A 委派接口（**严格 A2A v1.0**）

### 3.1 端点与发现

| 项 | 值 |
|---|---|
| Agent Card | `GET /.well-known/agent-card.json` |
| JSON-RPC 端点 | `POST /a2a`（经 SSH 隧道：`http://127.0.0.1:18443/a2a`） |
| 协议版本 | `A2A-Version: 1.0` |

### 3.2 支持的方法（**v1.0 名称**）

| 方法 | 用途 |
|---|---|
| `message/send` | 提交目标，返回 Task 或 Message |
| `message/stream` | 同 send，但开 SSE 流 |
| `tasks/get` | 查询任务状态与 artifacts |
| `tasks/list` | 列出任务（游标分页） |
| `tasks/cancel` | 取消任务 |
| `tasks/subscribe` | 订阅既有任务的 SSE 更新 |
| `agent/getAuthenticatedExtendedCard` | 获取需鉴权的扩展 Agent Card |

> ⚠️ v1.0 已废弃旧名 `tasks/send` / `tasks/sendSubscribe`，本实现**仅接受 v1.0 名称**，收到旧名返回 `MethodNotFound`。

### 3.3 Agent Card 示例

```jsonc
{
  "protocolVersion": "1.0",
  "name": "WinVM Bridge Agent",
  "description": "在 Windows 虚拟机内自主执行系统/应用/存储/GUI 任务，并回传截图与变更清单",
  "version": "0.1.0",
  "url": "http://127.0.0.1:18443/a2a",
  "provider": { "organization": "WinVM Bridge" },
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text", "data"],
  "defaultOutputModes": ["text", "data", "image/png"],
  "supportedInterfaces": [
    { "url": "http://127.0.0.1:18443/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "skills": [
    { "id": "system-admin",  "name": "Windows 系统管理",
      "description": "服务/进程/注册表/网络/用户/事件日志", "tags": ["system"] },
    { "id": "app-manager",   "name": "Windows 应用管理",
      "description": "winget 安装卸载升级、启动应用、快捷方式（读取）、UWP（查询）", "tags": ["app"] },
    { "id": "storage-manager","name": "Windows 存储管理",
      "description": "空间分析、文件目录操作、压缩、回收站", "tags": ["storage"] },
    { "id": "gui-automation","name": "GUI 与桌面自动化",
      "description": "截图、键鼠、窗口、UIA、剪贴板（只读）、等待条件", "tags": ["gui"] }
  ],
  "securitySchemes": { "bearerToken": { "type": "http", "scheme": "bearer" } },
  "security": [{ "bearerToken": [] }]
}
```

### 3.4 委派请求示例（含最小权限与风险上限）

```jsonc
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "messageId": "msg-1",
      "parts": [{ "kind": "text", "text": "用 winget 安装 VSCode 并验证安装成功" }]
    },
    "metadata": {
      "allowedCapabilities": ["app.*", "system.process.*"],
      "maxRisk": "L1",
      "traceId": "tr_01J..."
    }
  }
}
```

> **两键兑现现状（2026-10-14 批1 订正，原 E-1 批0 定性留痕于 git，详见 `SECURITY-GOVERNANCE.md` §2.3）**：批1 已把 `allowedCapabilities`/`maxRisk` 接入三处生产 `policy.evaluate` 调用点（仅喂**宿主声明值**，服务端回退默认绝不喂 ⇒ 零断崖），但缺省灰度 `WINVM_POLICY_GATE_WIRING=shadow`＝评估观测、**不执法**；本示例展示契约字段形状与接线形态，缺省仍**不得读作**已生效的安全闸（执法需显式 on）。端到端拦截用例见 `tests/unit/p3-b1-policy-gate.test.js`。

### 3.5 任务状态与审批

```
submitted → working → input-required → working → completed
                   ↘ failed / canceled / rejected
```

**审批闸映射到 `input-required`**：需要人工确认时，任务置 `input-required` 并在 `status.message` 中给出 dry-run 预览与 `data` part（结构化影响清单）。宿主确认后发 `message/send` 带同一 `taskId` 继续。

> **宿主桥义务**：宿主侧 A2A 桥（`packages/host-a2a-bridge`）必须**原样透传** VM 下发的 `preview` 与 `impact`（不得丢弃），并**按通道**给出正确的续跑提示 —— A2A 用 `a2a.approval.reply { taskId, approvalId, approved }`，**不得使用 MCP 通道的 `__approvalId`**。
>
> **`__approvalId` 续跑现状订正（2026-10-14 批1 已落地 · 出路(c) 策略化）**：MCP 直调的"批准即附 `__approvalId` 重发"路径**已从协议上移除**——批1(c) 落地后，纯宿主直调命中 L2/L3 审批闸时服务端**按通道事实**（协调器活动委派槽，非调用方自报）直接收口 **`DELEGATION_REQUIRED`**（新契约码，retryable=false），**不再**发放续跑令牌。审批唯一可达路径 = 经 `a2a.delegate` 委派 → 宿主 `approval.reply` → 服务端重放（放行闭环，验收绿）。`__approvalId` 仅在 `WINVM_APPROVAL_REPLAY=off` 回滚态的委派内层令牌上有效。历史（批0 记录，保留不删）：批1 前该路径"批准即删令牌 → 恒返 APPROVAL_REQUIRED 死循环"，即 P0-1 信任核弹，现已根治。灰度位：`WINVM_DELEGATION_REQUIRED_POLICY`（缺省 on，off 退回旧死令牌行为）。

### 3.6 Artifact 约定（破除"委派黑盒"，NFR-509）

`runGoal` 必须产出 artifact：

| artifact | 内容 |
|---|---|
| `steps` | DataPart：逐步执行记录（能力 ID、参数摘要、结果、耗时、traceId） |
| `screenshot-before` / `screenshot-after` | FilePart（base64 PNG），L2/L3 与 GUI 任务必带 |
| `change-list` | DataPart：受影响对象清单（文件/服务/注册表项） |
| `console-log` | DataPart：PowerShell 输出与警告 |

---

## 4. IF-4 能力执行接口（桥接 SPI）

见 `SPEC-AGENT-SERVICE-BRIDGE.md` §3。

---

## 5. IF-5 ps-bridge 协议（NDJSON over stdio）

### 5.1 请求

```jsonc
{ "id": "r17", "module": "system", "function": "Control-Service",
  "params": { "name": "Spooler", "action": "restart" },
  "timeoutMs": 30000 }
```

### 5.2 响应

成功：

```jsonc
{ "id": "r17", "ok": true, "data": { "name": "Spooler", "status": "Running" },
  "warnings": [], "durationMs": 812 }
```

失败：

```jsonc
{ "id": "r17", "ok": false,
  "error": { "code": "SERVICE_NOT_FOUND", "message": "服务不存在", "details": {} },
  "durationMs": 45 }
```

### 5.3 契约

| 项 | 约定 |
|---|---|
| 帧格式 | 单行 JSON（`\n` 结尾），UTF-8 |
| 并发 | 请求带 `id`，响应乱序返回；`vm-service` 侧做 id 匹配 |
| 心跳 | 每 15s 一行 `{"type":"heartbeat"}`，超时 45s 判定僵死并重启 |
| 启动参数 | `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ps-bridge.ps1` |
| 输出纪律 | **仅** NDJSON 到 stdout；诊断信息到 stderr（不污染协议流） |
| 大负载 | base64（截图等）放在 `data` 字段，单行传输（避免 JSON 转义换行问题） |

---

## 6. IF-6 健康检查

`GET /health` →

```jsonc
{
  "ok": true,
  "provider": { "id": "workbuddy-deterministic", "state": "ready" },
  "psBridge": { "state": "ready", "uptimeMs": 91234, "pending": 0 },
  "session": {
    "sessionId": 2, "windowStation": "WinSta0", "desktop": "Default",
    "interactive": true, "locked": false, "blackScreen": false,
    "state": "healthy"          // healthy | degraded | unavailable
  },
  "capabilities": { "count": 54, "available": 54 },
  "audit": { "entries": 128, "chainValid": true }
}
```

> `session.state` 为 `unavailable`/`blackScreen` 时，GUI 能力全部返回 `SESSION_UNAVAILABLE` / `SESSION_BLACK_SCREEN`，**绝不静默返回黑图**。

> **P2-T9（E-2）`session.probeError` / `session.probeErrorCode` 字段注**：`session` 块可能额外携带这两个
> **纯附加可选**键。它们在场表示**本次探测未能得出结论**（探针未接入 `PROBE_NOT_WIRED` / 子探针超时
> `PROBE_TIMEOUT` / 探针调用异常 `PROBE_EXCEPTION`），此时块内 `interactive`/`locked`/`blackScreen`
> 为 fail-closed 保守填充值；两键缺席即结论真实，且整个块的形状与旧版本逐字节一致（旧读者零影响）。
> GUI 门禁判据**不消费**这两个键 —— 无论探测失败还是确非交互，GUI 一律拒绝，字段只用于运维定位。
> 另：`llmSession` 块（同端点，本样例未展开）P2-T9 起可携带纯附加 `firstCallLatencyMs`（服务生命周期内
> 首个真实委派轮的入口→settle 毫秒数，一次性采样；缺席=尚未发生首调），用于对账预热是否兑现。
