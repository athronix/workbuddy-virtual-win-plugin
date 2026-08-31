# 宿主侧 A2A 委派桥与双通道完善 · 设计

> 补齐"宿主机 AI Agent → VM 内 AI Agent"链路中缺失的一跳，并把简单/复杂任务分流到两条各司其职的通道。

---

## 1. 背景与问题

原实现存在一个**断链**：VM 侧 A2A 服务端（`/a2a` + AgentCard + SSE）已完备，但**宿主侧没有发起 A2A 的接入点**。

具体事实：

- `adapter-host-workbuddy` 的 `renderConnectorEntry()` 只渲染 **MCP** 条目（`type: streamableHttp`，url 指向 `/mcp`）。
- vm-service 暴露的 MCP 工具 = 54 个能力，`meta` 域仅 `health.check` / `capability.list` / `session.status`，**没有任何能发起 `runGoal` 的委派工具**。

后果：宿主 WorkBuddy 只能自行做 MCP 多轮编排，**无法把开放性任务整体委派给 VM 内 LLM Agent 并接收流式进度**。VM 侧的 A2A 服务端一直在等一个永远不会从宿主发起的请求。

根因在于宿主 Agent 的能力边界：**WorkBuddy 是 MCP client，不是 A2A client**。

---

## 2. 目标与非目标

### 目标

| ID | 目标 |
|----|------|
| FR-BR-1 | 简单任务（单步、结构化、可精确控制）经 **MCP client 直调** VM 侧 MCP server 的能力工具 |
| FR-BR-2 | 复杂任务（多步自主规划 / 强 GUI / 开放意图）经 **A2A client** 委派给 VM 内 AI Agent |
| FR-BR-3 | 宿主侧以宿主能理解的方式（MCP 工具）暴露 A2A 委派能力，宿主零改造 |
| FR-BR-4 | VM 内 Agent 执行过程与产物按 A2A 规范回传宿主（进度流 + artifact） |
| FR-BR-5 | 审批闸（L2/L3）在 A2A 通道可挂起、可由宿主应答，且禁止代替用户批准 |
| FR-BR-6 | VM 内 Agent 有技能规范可依（下发的 SKILL.md），可编写脚本或直接调用本地工具 |
| NFR-BR-1 | 同一条 SSH 隧道同时承载 `/mcp` 与 `/a2a`，不新增暴露面 |
| NFR-BR-2 | 桥内部实现可单测（注入 mock A2A client，不依赖网络） |
| NFR-BR-3 | VM 服务常驻后不得因空闲而失效（自愈） |

### 非目标

- 不在宿主侧实现通用 A2A 协议栈 UI（宿主无此扩展点）
- 不改动 VM 侧能力内核（策略/审批/审计/ps-bridge 完全复用）

---

## 3. 总体方案：两条通道各司其职

```
                        宿主机                     │            Windows 虚拟机
                                                   │
  简单任务 ──► winvm 连接器（MCP）──────────────────►  vm-service /mcp
             工具 = 点分能力 ID                     │        │
             system.info.get / appops.cli.invoke   │        ▼
                                                   │   能力注册表→策略→审批→审计→ps-bridge
  复杂任务 ──► winvm-a2a 连接器（stdio MCP 桥）      │
             工具 = a2a.delegate 等                 │
                       │                           │
                       └─ A2A client ──────────────►  vm-service /a2a
                          （同一条隧道）             │        │
                                                   │        ▼
                                                   │   VM 内 AI Agent（workbuddy / LLM）
                                                   │    依据下发的 SKILL.md 拆解步骤
                                                   │    编写脚本 或 回连 /mcp 调能力
                                                   │        │
                       ◄── 进度流/产物/审批 ─────────┼────────┘
                          （A2A status-update / artifact-update）
```

**判据**：任务能否预先分解为确定步骤？
- 能 → MCP 直调（透明、省 token、可复现）
- 不能 → A2A 委派；产物与进度按 A2A 规范回流

---

## 4. 宿主侧 A2A 委派桥（`packages/host-a2a-bridge`）

### 4.1 形态

宿主只能说 MCP，因此桥以**本地 stdio MCP server** 形态落地：

- 宿主经 MCP 连接器拉起 `node <pluginRoot>/a2a-bridge/cli.js --endpoint http://127.0.0.1:18443`
- 桥内部用 `A2AClient` + `establishTransport(path='/a2a')` 调 VM 侧 A2A 服务
- 把 A2A 事件翻译回 MCP 结果

> 选 stdio 而非再开一个 HTTP 端口：零端口占用、随宿主连接器生命周期启停、不新增暴露面。

`mcp-framework` 只有协议处理（无 stdio server transport），故 `src/stdio.ts` 自行实现 NDJSON 循环：stdin 逐行读 JSON-RPC → `McpServer.handleRequest()` → 写回 stdout。**stdout 只承载协议消息，日志一律走 stderr。**

### 4.2 工具面

| 工具 | 作用 |
|------|------|
| `a2a.delegate` | 提交目标，流式收集进度与产物；返回 `taskId / state / progress[] / artifacts[] / approval?` |
| `a2a.task.get` | 按 taskId 查状态与产物（超时后取结果、轮询长任务） |
| `a2a.approval.reply` | 对 `input-required` 任务回复批准/拒绝 |
| `a2a.task.cancel` | 取消任务 |
| `a2a.health` | 拉 Agent Card，确认隧道与 A2A 服务可达，列出 VM Agent 技能 |

关键参数（最小权限）：`allowedCapabilities`（能力范围）、`maxRisk`（最高风险，默认 L1）。

### 4.3 事件翻译

| A2A 事件 | MCP 侧表现 |
|---------|-----------|
| `status-update`（working） | 累积进 `progress[]` |
| `artifact-update` | 累积进 `artifacts[]`；图片 → `content: image`，其余 → 文本摘要 |
| `status-update`（input-required） | 提取 `approval{approvalId, risk, capabilityId, message}`，**不视为错误** |
| `status-update`（failed/rejected/canceled） | `isError: true` + `error` |

超时保护：外层 deadline，超时返回 `timedOut: true` + `taskId`，可用 `a2a.task.get` 续取。

### 4.4 审批闸

任务挂起 → 宿主**必须先向用户展示影响清单** → 取得确认后才调 `a2a.approval.reply`。桥只做搬运，不代为决策；VM 侧超时按拒绝处理（fail-closed）。

---

## 5. VM 内 Agent 的技能下发

任务委派时，VM 内 Agent 需要"依据什么规范干活"。机制：

1. **随部署下发**：`setup.mjs` 把 `skills/` 一并打包传到 VM（与 `delivery`、各包 `dist` 同包分发）。
2. **运行时加载**：provider 按 `skillsRoot`（配置，支持 `%ENV%`）读取各 `SKILL.md`，得到 `LlmSkillDoc[]`。
3. **落盘 + 注入**：`writeSkillPack()` 把规范写到工作区 `.winvm/skills/`；`buildSystemPrompt()` 把技能摘要、能力目录、产物目录与工作方式注入系统提示。

系统提示明确要求 VM 内 Agent：优先按技能规范拆解步骤；技能未覆盖时可**自行编写脚本**并用 `appops.cli.invoke` 执行；每完成一个可见阶段把中间产物写入产物目录。

---

## 6. CLI 契约配置化（重要未验证项）

`CliLlmBridge` 默认契约：

```
codebuddy --goal "{goal}" --system-prompt "{prompt}" --mcp "{endpoint}" --output "{output}"
```

⚠ **该契约尚未在真机 `codebuddy` 上验证**。因此做成模板可配置：

- 默认 `DEFAULT_CLI_ARG_TEMPLATE`，占位符 `{goal} {prompt} {endpoint} {output} {skillsDir}`
- 真机参数不同时，经 provider options 的 `cliArgTemplate` 覆盖，**无需改代码**

---

## 7. 附：常驻链路自愈（ps-bridge 空闲失效修复）

**现象**：VM 服务启动后可用，空闲约 45 秒后所有调用失败（`ps-bridge 未就绪`），且**永不恢复**，必须重启服务。

**根因**：

1. `ps-bridge.ps1` 的主循环在等待 stdin 时是**阻塞**的，空闲期间发不出心跳（`type:'heartbeat'`）。
2. TS 侧看门狗仅凭"超过 `heartbeatTimeoutMs` 未收到心跳"就直接 `kill()`——注释写着"将重启"，但**代码里没有重启逻辑**。
3. 结果：常驻服务空闲约 45s 后被误杀，且进程引用被清空后无人拉起，永久降级。

**修复**（`packages/vm-capabilities/src/ps-bridge.ts`）：

1. 看门狗超时后**先主动 `ping` 探测**：ping 得通 → 判定健康，仅刷新心跳时间戳（不再误杀）；ping 不通 → 判定僵死。
2. 真正实现自动重启：抽出 `spawnAndReady()`，`restart()` 执行 `failAll → kill → spawnAndReady`，并用 `restarting` 标志防重入、`stopped` 标志避免 `stop()` 后再被拉起。
3. 修复重启竞态：exit 事件异步派发，旧进程的 exit 回调可能在**新进程 spawn 之后**才触发并把 `this.child` 置空。改为捕获本次子进程引用，仅当 `this.child === spawned` 时才清理。

**验证**：启动后立即委派 → `completed`；空闲 55 秒后再委派 → `completed`（修复前必失败）。

---

## 8. 测试与验证

- 单元测试 143 项全绿（新增：委派桥 11 项、技能下发与 CLI 契约 5 项、双端脚本 6 项）
- 端到端冒烟（真实进程）：宿主桥（stdio MCP）→ A2A → VM provider → ps-bridge → PowerShell，目标"查看系统信息"返回 `completed` 并带回产物
- 断链修复后的双连接器：宿主安装器 dry-run 输出 **2 个增量补丁**（`connector:winvm`、`connector:winvm-a2a`）

## 9. 风险与未验证项

| 项 | 状态 | 说明 |
|----|------|------|
| `codebuddy` CLI 参数契约 | ❗未验证 | 见 §6，可经 `cliArgTemplate` 覆盖 |
| 真机 Windows VM 全链路 | ❗未验证 | 需真机跑 `setup.mjs --apply` 并委派一次 |
| GUI 类任务（Photoshop 大山→海洋） | ❗未验证 | 需交互式会话；当前环境锁屏/会话降级 |
| 宿主双连接器支持度 | ⚠ 待确认 | WorkBuddy 是否同时启用两个 connector 条目需实测 |
