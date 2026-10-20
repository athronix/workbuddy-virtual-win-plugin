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
| `a2a.task.cancel` | 取消任务（**协作式**，见 §4.5）；返回 `cancelObserved` 布尔位表明取消是否真的成立 |
| `a2a.health` | 拉 Agent Card，确认隧道与 A2A 服务可达，列出 VM Agent 技能 |

关键参数（**声明性**最小权限）：`allowedCapabilities`（能力范围）、`maxRisk`（最高风险声明值，默认 L1）。⚠ **2026-10-14 批1 订正**：两键接线已落地（宿主桥如实携带来源标 maxRiskSource；服务端三调用点喂入**仅宿主声明值**），但缺省灰度 `WINVM_POLICY_GATE_WIRING=shadow`＝评估观测不执法 ⇒ 缺省仍不得读作已生效封顶/过滤闸（执法需显式 on）；实况与判源见 `SECURITY-GOVERNANCE.md` §2.3。

### 4.3 事件翻译

| A2A 事件 | MCP 侧表现 |
|---------|-----------|
| `status-update`（working） | 累积进 `progress[]` |
| `artifact-update` | 累积进 `artifacts[]`；图片 → `content: image`，其余 → 文本摘要 |
| `status-update`（input-required） | 提取 `approval{approvalId, risk, capabilityId, message}`，**不视为错误** |
| `status-update`（failed/rejected/canceled） | `isError: true` + `error` |

超时保护：外层 deadline，超时返回 `timedOut: true` + `taskId`，可用 `a2a.task.get` 续取。

#### 4.3.1 progress 回显口径（wire 形状契约，P2-T12）

`progress[]` 的可达性依赖一条**跨包 wire 形状契约**：VM 侧写入 `status.message` 的值必须是合规
`A2A.Message`（`parts[]` 至少一个 `text` part）——宿主 `extractText` 只认该形状（首行判据
`if (!message?.parts) return ''`，该判据是对的，宿主侧不改）。框架侧 `createProgressSink.onStatus`
对契约形参 `message?: string` 做**类型整形**（唯一裁决点在 sink 层，`TaskStore.updateStatus` 本体
签名与行为不动），三分支：

| 入参形态 | 整形结果 |
|---|---|
| 非空 string | 构造 `{kind:'message', role:'agent', messageId: 新 UUID, taskId, parts:[{kind:'text', text: 原文案}]}`（对照 `approvalMessage`/`resultMessage` 等既有正确样板） |
| 空串 / 仅空白 | 与缺席等价 ⇒ `status.message` 键整体不写（宿主端不可分：修复前后 `extractText` 均返 `''`，均不入 `progress[]`） |
| 对象形态（第三方直传 Message） | **verbatim 透传**，零重复包装（幂等，引用不变） |

- **确定性路径实时进度自 P2-T12 起恢复可见**。~~此前 sink 层把 string as-cast 成 `A2A.Message` 直存，
  wire 上是裸字符串 ⇒ 宿主 `extractText` 恒空 ⇒ 有态进度文案对两种 provider 的生产呈现面均不可达
  （含 delegate 实时回显与 §4.5 有态取消文案的派生输入）~~ —— P2-T12 订正注记（2026-10-11）：缺陷已修复，
  原文不删、划线留痕。判据 = `tests/unit/phase2-progress-message.test.js`（A 组 wire 逐键 + 缺席语义 +
  透传幂等 + 病灶对照组；B 组经 `createProgressSink` 真实装配与 `message/stream` 完整通路喂宿主
  `a2a.delegate`，断言 `progress[]` 非空与 `executedBeforeCancel` 有态可达）。修复前 wire 实况与
  真机实证见 `qa/r19/t5-l2d-deterministic-evidence.md`。
- 审批链路不经本整形（`waitApproval` 直传 store，本就产合规 Message），零影响。
- completed/failed 终态收口由 server 侧 `resultMessage`/`errorMessage` 直传 store，不经 sink ⇒ 其
  `text + data` 双 part 形态逐字节不变（宿主既有消费面零回归）。

### 4.4 审批闸

任务挂起 → 宿主**必须先向用户展示影响清单** → 取得确认后才调 `a2a.approval.reply`。桥只做搬运，不代为决策；VM 侧超时按拒绝处理（fail-closed）。

#### 4.4.1 呈现要求内嵌（CL-026，2026-10-20）

「展示影响清单」此前是**软描述**——是否出审批卡全凭宿主 agent 自由发挥（真机实证：卡片由主理人
现场按 R17 规范手工渲染，非系统保证）。CL-026 把指挥信号下移到**工具返回面**：桥在审批挂起时
内嵌一段「呈现要求」指令，宿主 agent 必然读到、必然执行。

| 携带面 | 位置 | 形态 |
|---|---|---|
| L1 | `a2a.delegate` 早退文案（`summary` / `content[0].text`） | 既有「任务挂起等待审批：…」文本**尾部换行追加**（前缀逐字不变） |
| L2 | `a2a.delegate` 的 `approval` 载荷 | 纯附加可选字段 `presentationDirective`（权威串单源，幂等补挂） |
| L3 | `a2a.task.get` 观测到挂起审批 | 同 L2 + 文案面（挂起审批不因观测工具不同而降级为纯文本） |
| L4/L5 | `a2a.delegate` / `a2a.approval.reply` 工具 description | 说明书面：出卡先于收口、收口只来自 `AskUserQuestion` |

指令内容四条（权威正文单源 = `packages/host-a2a-bridge/src/tools.ts` 的 `APPROVAL_PRESENTATION_DIRECTIVE`，
规范文案入档见 `docs/design/cl026-approval-presentation.md` §1）：
① `show_widget` 出七槽位卡（取本 approval 载荷）；② `AskUserQuestion` 权威收口（批准 / 拒绝 /
暂不决定·超时观察，选项带 `approvalId` 摘要）；③ 禁止纯文本转呈代替出卡、禁止代用户批准，
渲染面不可用则逐字降级 `references/approval-card.md` 文本模板；④ 批准后 reply + `a2a.task.get` 轮询至终态。

**MCP 直调路径不落地（口径明确，非遗漏）**：`DELEGATION_REQUIRED`（批1(c) 纯直调收口）**不发审批载荷**
⇒ 无槽位可填，`approval-card.md` §4/§7「无 `approvalId` ⇒ 不得出卡片」是权威；正确闭环 = 转委派后由 L1/L2 携带指令。
`APPROVAL_REQUIRED` 令牌态面向 VM 内 Agent / 回滚位，其续跑标记与 A2A 卡片红线互斥（通道隔离），故同样不加。
两通道口径 = **A2A 委派通道的 delegate 早退面 + task.get 观测面**两处内嵌。

### 4.5 取消的呈现口径（Phase 1 T5，ARCH-22 / §10 R10）

`tasks/cancel` 是**协作式**取消：执行体在"能力调用边界"消费取消信号，**正在执行的那一次调用会跑完**。因此宿主呈现面必须事实化，不得宣称"未执行任何变更"（那是 R10 点名的预期管理红线）。两态判据：

| 态 | 机械信号 | `summary` 文案 |
|---|---|---|
| **零执行痕迹** | `structuredContent` 里**没有** `executedBeforeCancel` 键 | 「任务已取消（canceled），取消点之前的操作未执行。如需继续，请重新发起并重新确认审批。」 |
| **有执行痕迹** | `structuredContent.executedBeforeCancel = { steps:N, artifacts:M }` | 「任务已取消（canceled）；**取消前已有 N 个操作执行、M 个产物**，请逐项核对 artifacts。」 |

- `steps` 的事实源两级派生：优先 `execution-steps` artifact 内 `data.steps` 长度（框架侧权威载体，仅正常路径落，故取消场景常缺席）；取不到则退回 `progress[]` 里确定性执行体的 step 标记（`执行 <capabilityId>：<摘要>`）。
- `artifacts` = 宿主可见产物总数**扣除** steps 载体本身；两者皆 0 ⇒ 不附该键（即"无痕迹态"，不做任何推断性表述）。
- `a2a.task.cancel` 的 `cancelObserved`：`task.status.state === 'canceled'` 才为真。对**已终态**任务发 cancel 会回原终态 ⇒ 此时 `false` 且文本如实说明"取消未生效（任务已结束）"，不得让宿主自比字符串。
- 重新发起 = 重新过审批：取消不会让已批准的 `approvalId` 复用，文案里明确提示。

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
- **P2-T9（E-2/E-1）健康面判据登记**：`/health.session` 未知态由纯附加 `probeError`/`probeErrorCode`
  显形（三码 `PROBE_TIMEOUT`/`PROBE_EXCEPTION`/`PROBE_NOT_WIRED`；两键缺席=结论真实，形状逐字节旧版），
  宿主侧读者可据此区分「探测失败」与「会话确不可交互」；`guiAllowed` 判据一字未改（PR8，两种 false 都拒）。
  `/health.llmSession` 追加纯附加 `firstCallLatencyMs` 冷启动度量位（只度量不优化）。
  判据钉死于 `tests/unit/phase2-session-unknown.test.js`（A 形态/B 恒 false 矩阵/C 契约纯附加/D 度量形状/E 文档在位）。
  本文档无 `/health.session` 专节，故诚实登记在验证面（口径详见 SECURITY-GOVERNANCE §5.3 与 INTERFACES IF-6）。

## 9. 风险与未验证项

| 项 | 状态 | 说明 |
|----|------|------|
| `codebuddy` CLI 参数契约 | ❗未验证 | 见 §6，可经 `cliArgTemplate` 覆盖 |
| 真机 Windows VM 全链路 | ❗未验证 | 需真机跑 `setup.mjs --apply` 并委派一次 |
| GUI 类任务（Photoshop 大山→海洋） | ❗未验证 | 需交互式会话；当前环境锁屏/会话降级 |
| 宿主双连接器支持度 | ⚠ 待确认 | WorkBuddy 是否同时启用两个 connector 条目需实测 |
