# CL-K3R —— K3「静默假成功」根治：增量架构设计与任务分解

STATUS: DRAFT（架构师产出，待 owner 拍板 §9 后方可进入实施）

> 本文**只做设计**：未修改 `packages/**`、`tests/**`、`qa/**`、`delivery/` 任何文件，未跑部署脚本，未连 VM。
> 基线 HEAD：`6dca16e`（R19F 全部 CL 已合入，真机 R3 三项终验 PASS）。
> 引用口径：**段标签为主、行号为辅**（并行改动会让行号漂移；本文行号仅对 HEAD `6dca16e` 成立）。
> 本文**不改写**上游三份 A5 文档与测试报告；发现的不一致一律登记在 §0.3 并回报主理人。

---

## 0. 前置：口径、纪律与边界

### 0.1 任务定位

R19F（A5 修复）把 `APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` 列入**不改清单**（contract §4 SK-9、§5-Q8），
本迭代未动它 —— 就是为了留给 CL-K3R 整体根治，避免半吊子改动。
本文即为该根治项的**增量设计**：把「审批未决」的判据从 **LLM 文本启发式**升格为 **MCP 结构化工具结果（服务端事实）**。

### 0.2 继承的硬约束（逐条：本文是否触及）

| 编号 | 约束（来源） | 本文处理 |
| --- | --- | --- |
| **D-1** | `bridge.ts` `reconcileExecutionTruth` 内两道门（`replayEnabled \|\| replayActive` / `raised.size === 0`）语义·顺序·短路条件一字不改 | **不触及**。新判据放在收口链**更上游**（`maybeResume` 之前），两道门本身零改动（R19F/T03 已把取值来源换成 `ctx.`，本文不再动） |
| **D-4** | `packages/a2a-framework/src/**` 零改动 | **遵守**：本文方案对该目录**零改动**（不需要） |
| **D-5** | `rejected` 唯一置位点 = `a2a-framework/src/server.ts:306`，不得新增别处置位点 | **不破坏**。新判据只让任务**有机会**走到 `input-required`；`rejected` 仍只由宿主显式拒绝产生。**净效果：让 `:306` 更常可达，而非多出一个置位点** |
| **C-1** | `endTask(taskId?)`：零参/空串 = 无条件清空（保既有零参调用方行为逐字不变） | **不触及**（签名与实现均不动） |
| **A2b** | 生产 A2A 主链路必带非空 `taskId`（`a2a-framework/src/server.ts:334` `const goalWithTask = { ...goal, taskId: id }` 无条件注入） | **依赖**此事实：`dtid` 注入与探针门控均以 `taskId` 非空为前提 |
| **SK-4** | 契约增补一律「纯附加可选」 | **遵守**：新探针成员为**可选方法**、新类型为新增导出、新字段为 `readonly x?: T` |
| **SK-9** | `APPROVAL_WAIT_PATTERN`（`bridge.ts:575`）、`parseApprovalBlock`（`:588`）不改；`reconcileApprovalWait` 的**文案与 steps 改写**（`:615`–`:638`）一字不改 | **遵守**：三者函数体/常量/文案**一字不改**。本文只把它们从「**唯一**判据」降级为「**兜底**判据」（§5.3 专项论证；列为决策点 D-2 供 owner 确认口径） |
| **SK-6** | `raise` 的三条 reason 语义一字不变；`no-active-task` 仍「绝不自批」 | **不触及** |
| **SK-5** | `dist` 必须先重建（`npx tsc -b tsconfig.build.json`，E-2 已订正根级路径）再跑测 | **写入验收判据** |

### 0.3 与上游文档/源码的偏差登记（**不自行改上游文档**，此处记录并回报主理人）

| # | 偏差 | 性质 | 处置 |
| --- | --- | --- | --- |
| **V-1** | `impl-progress.md` §4 记 D-1 红线两门 AFTER 落在 `bridge.ts:1017` / `:1018`；实测 HEAD `6dca16e` 为 **`:1024` / `:1025`** | 纯行号漂移（QA 的 C6 护栏 commit `6a0c950` 之后仓库又前进） | 段标签（`reconcileExecutionTruth` 内两个相邻 `if (…) return base;`）不变，**不影响任何结论**。本文统一用段标签 |
| **V-2** | 根因文档附录 A 记 `contracts/src/bridge.ts` `beginTask=313 / endTask=315 / raise=322`；实测 HEAD `6dca16e` 为 `beginTask=:329`、`endTask=:342`、`raise=:349`（T01 的 C-1/C-2 注释块使之下移） | 行号漂移 | 同上。本文引用一律给段标签 |
| **V-3** | **`vm-service/src/server.ts:770` 的 `ledger?.recordBlocked(...)` 以 `ctx.delegationId` 为唯一前提** ⇒ 常驻会话路径（生产 A2A 主路径）**恒为空操作** | **源码事实，非文档错误**；但上游文档未点名此后果 | 本文 §3.3 给出完整论证，并据此选型（**这是本文最关键的技术发现**）。建议在 K-N1 设计文档补记，但**不由我改** |
| **V-4** | `recordBlockedApprovalAudit` 的 `channel` 取 `ctx.delegationId ? 'a2a' : 'mcp'`（`server.ts:767`）⇒ 常驻路径的**委派内层拦截**被记为 `mcp` 通道 | 与 K-N1「修掉 181/181 恒 mcp」的口径目标同类的**残留观测缺陷** | 本文**不修**（不在 CL-K3R 范围），登记为待办 §9-Q6 |
| **V-5** | `LedgerRegistry.ledgerForInnerTrace()`（`delegation-audit.ts:361`）定义了「按内层 traceId 回挂账本」能力，但全仓**无调用点** | 死代码 / 未完成件 | 本文**不复用**（其匹配面不含被拦调用自身的 traceId），登记 §9-Q7 |

---

## 1. 问题重述与危害定级

### 1.1 K3 的一句话重述

> VM 内 LLM Agent 调用了一个**被策略引擎拦截、需要宿主人工审批**的高风险能力（服务端已返回结构化
> `APPROVAL_REQUIRED` + `approvalId`，并已登记续跑令牌）。但**桥判定「是否真的在等审批」的依据是
> LLM 的最终文本措辞**；一旦 LLM 不用 `APPROVAL_REQUIRED` /「等待审批」这两个词，桥就判定「没在等审批」
> ⇒ 不 raise、不挂起、不改判 ⇒ 任务以 `ok:true` 收口 `completed`。
> **操作从未执行，宿主收到「已完成」，全程零告警。**

### 1.2 触发条件（逐条可核，六条件同时成立）

设 D 为一次 A2A 委派（`taskId` 非空，A2b 已证生产恒成立），其 LLM 回合内确有 ≥1 次能力调用
被 `CorePolicyEngine` 判 `requiresApproval` 并在 MCP 层拦截（`vm-service/src/server.ts:726`–`:791`，
返回 `structuredContent = { ok:false, error:{code:'APPROVAL_REQUIRED'}, approval:{approvalId,…} }`，
同时 `pendingApprovals.set(id, …)`）。

| # | 条件 | 落点 | 证据 |
| --- | --- | --- | --- |
| **K3-a** | LLM 最终文本未命中 `/APPROVAL_REQUIRED\|等待审批/` | `bridge.ts:575` `APPROVAL_WAIT_PATTERN` | 常量原文 |
| **K3-b** | `reconcileApprovalWait` 因此 `return base`，保留 `ok:true`、`error` 为 undefined | `bridge.ts:616` `if (!APPROVAL_WAIT_PATTERN.test(finalText)) return base;` | 根因 §2.2 第 1 条 |
| **K3-c** | `maybeResume` 的 `blocked` 读 `base.error` ⇒ 为 false ⇒ `return base`（不 raise、不挂起） | `bridge.ts:945`–`:946` | 根因 §2.2 第 2 条 |
| **K3-d** | `reconcileDelegationTruth` 退场（门 3 无完成声称 / 门 4 无 probe / `total>0` 采信） | `delegation-truth.ts:81` / `:95` | 见 §1.4 |
| **K3-e** | `reconcileExecutionTruth` 退场（`ctx.replayActive === false`，因从未 raise） | `bridge.ts:1024`（D-1 门 1） | 见 §1.4 |
| **K3-f** | `runGoalWithLifecycle` 按 `result.ok` 收口 `completed` | `a2a-framework/src/server.ts:365` `const finalState = result.ok ? 'completed' : 'failed';` | 框架原文 |

### 1.3 K3-a 为什么**必然会发生**（不是理论风险）

拦截事实在服务端是**结构化**的（§1.2 的 `structuredContent`），但**桥判定它是否发生用的是文本**。二者的桥接点只有一处：

> `bridge.ts:363`–`:372` 的**自然语言纪律**（系统提示词里写着「当工具返回 APPROVAL_REQUIRED…必须立即停止执行，如实上报『等待审批』」）。

即：**「安全纪律」靠提示词约束 LLM，「判据」靠正则匹配 LLM 的回话** —— 同一条链的两端都建在不可靠的措辞上。
已知的具体 evade 形态（按出现的现实性排序）：

1. **同义改写**：LLM 回「该操作需要人工确认」「此操作已被安全策略挂起，等你批准」⇒ 语义完整、正则零命中。
2. **只回显 approvalId 不带错误码**：根因 §2.4 已点名（`apr_…` 出现但 `APPROVAL_REQUIRED` 不出现）⇒ `extractApprovalId` 拿到 id，但 `APPROVAL_WAIT_PATTERN` 不命中 ⇒ 整段 `return base`。
3. **自宣完成**：K5 根因实证 —— 宿主批准后 LLM 未重发工具调用却文本自宣「已卸载」；同源行为在拦截侧就是「我处理完了」的假成功。
4. **常驻会话续跑轮文本覆盖**：`ctx.lastFinalText` 取**最后一轮**（`bridge.ts:1162` / `:1359`），前一轮里说过的「等待审批」会被后续轮覆盖掉。
5. **CLI 输出截断**：`turn.text` / `stdoutText` 的尾部被截 ⇒ 关键词落在截断区。

> **反证式提醒**：A5 之所以**没有**表现为 K3，是因为那一轮 LLM **恰好**说了 `APPROVAL_REQUIRED`
> （根因 §2.3 的三段指纹逐字命中）。也就是说：**A5 是「运气好」，K3 才是默认脆弱面。**

### 1.4 为什么既有三道防线在 K3 场景下**全部退场**（这是必须新建判据的论证）

| 防线 | 退场原因（K3 场景下） |
| --- | --- |
| **K3 文本启发式**（`reconcileApprovalWait`） | 见 §1.2 K3-a —— 它**正是**被绕过的那一道 |
| **K5 回执反查**（`reconcileExecutionTruth`） | D-1 门 1 `if (!this.replayEnabled \|\| !ctx.replayActive) return base;` —— `ctx.replayActive` 只在「raise 回包携 `executed`」时置 true（`bridge.ts:996`）。K3 场景**从未 raise** ⇒ 恒 false ⇒ 整段退场 |
| **K-N1 账本反查**（`reconcileDelegationTruth`） | 三重退场：① 门 3 要求 `finalText` 命中 `COMPLETION_CLAIM_PATTERN`（无完成声称则透传）；② 即便反查，`total` 可能因**其它**成功/失败调用（wild/executed）非零 ⇒ 判「有活动」⇒ 采信（判"有活动"取宽松是 K-N1 的既定纪律）；③ **常驻路径的 `blocked` 根本不进账本**（§3.3）⇒ 连 `blocked` 这一路证据都没有 |

⇒ **结论**：现有三道判据在 K3 场景下**结构性失效**，且失效方向**一致**（都偏向"放过"）。
必须在 `maybeResume` **之前**新增一道**结构化**判据，且该判据的失效方向必须是**保守**的（§5.4）。

### 1.5 危害定级：K3 > A5（为什么更危险）

| 维度 | **A5（已修）** | **K3（本项）** |
| --- | --- | --- |
| 终态 | `failed` | **`completed`** |
| 可观测性 | **显式失败**：宿主立刻知道、可重试 | **静默**：宿主收到成功，零告警、零 failed 样本 |
| 触发条件 | **并发委派交叠**（`endTask()` 误清单例）—— 相对罕见 | **单次委派 + LLM 措辞漂移** —— 常见、且随模型/版本/提示词变化而漂移 |
| 失效方向 | **fail-closed**（安全闸咬死，任务失败） | **fail-open**（安全闸被绕过，且无人知晓） |
| 下游后果 | 任务失败，人工可重试 | 宿主/用户**据此认定高风险操作已完成**（如"已卸载/已删除"）⇒ 形成错误事实认知，**不会重试**，且后续决策建立在错误前提上 |
| 定位成本 | 有 failed 终态 + 三段文案指纹可反查 | **无失败态** ⇒ 只能靠事后 grep「零调用但 completed」形态（K-N1 `ext.zeroInnerCalls` 恒落才勉强可查） |
| 现状 | R19F 已修，真机 R3 三项终验 PASS（报告 §A8.2） | **未修**（R19F 明确列入不改清单，留给本项） |

> **定级理由（一句话）**：A5 是「安全闸咬死」（显式噪声），K3 是「安全闸被绕过且无人知晓」（静默失效）。
> 安全工程的基本排序是 **静默失败 ≫ 显式失败**。故 owner 的判级（K3 比 A5 更危险）成立，本文采纳。

---

## 2. 现状机制剖析（文本启发式链路 + 假成功的确切产生点）

### 2.1 全链时序图（现状，HEAD `6dca16e`）

```mermaid
sequenceDiagram
    autonumber
    participant Host as 宿主 (host-a2a-bridge)
    participant A2A as a2a-framework<br/>runGoalWithLifecycle
    participant Prov as adapter index.ts<br/>LlmProvider
    participant Bridge as adapter bridge.ts<br/>CliLlmBridge
    participant CLI as VM 内 codebuddy CLI
    participant MCP as vm-service /mcp<br/>McpServer.callTool
    participant Pol as CorePolicyEngine
    participant PA as pendingApprovals<br/>(服务端 Map)

    Host->>A2A: tasks/send (goal, maxRisk)
    Note over A2A: :334 无条件注入 taskId<br/>const goalWithTask = {...goal, taskId:id}
    A2A->>Prov: runGoal(goalWithTask)
    Prov->>Bridge: runGoal(input{goal,taskId,traceId,probe})
    Note over Bridge: :737 beginTask(input.taskId ?? '')
    Bridge->>Bridge: buildMcpConfig / appendDtid
    Note over Bridge: 单次 -p 路径：URL 拼 ?dtid=<traceId><br/>常驻路径：mcp.json 会话级共享 ⇒ **不拼 dtid**
    Bridge->>CLI: spawn / runTurn(系统提示 + MCP 配置)

    CLI->>MCP: tools/call app.winget.uninstall
    MCP->>Pol: evaluate({capabilityId, risk, approved:false})
    Pol-->>MCP: !allowed && requiresApproval
    MCP->>PA: pendingApprovals.set(apr_x, {risk,params,...,hostApproved:false})
    Note over MCP,PA: ★结构化事实#1：拦截已发生<br/>（server.ts:730）
    MCP->>MCP: recordBlockedApprovalAudit(...)
    Note over MCP: ★结构化事实#2：入哈希链<br/>:770 ledger?.recordBlocked —— **常驻路径恒空操作**
    MCP-->>CLI: structuredContent {ok:false,<br/>error.code:'APPROVAL_REQUIRED', approval:{approvalId}}
    Note over MCP,CLI: ★结构化事实#3：工具结果本身携带拦截信息

    CLI-->>Bridge: turn.text / stdoutText
    Note over CLI,Bridge: ⚠ 唯一的判定输入 = **LLM 措辞**<br/>（结构化结果到此为止，不再上行）

    Bridge->>Bridge: reconcileApprovalWait(base, finalText)
    Note over Bridge: :616 门：APPROVAL_WAIT_PATTERN.test(finalText)

    alt 命中（A5 的情形）
        Bridge->>Bridge: ok=false + APPROVAL_REQUIRED + approvalId
        Bridge->>Bridge: maybeResume → blocked=true → raise
    else 未命中 ★★ K3 假成功的确切产生点 ★★
        Bridge->>Bridge: :616 `return base`（ok:true 原样保留）
        Note over Bridge: ❶ 假成功诞生于此：<br/>操作从未执行，结果却是 ok:true
        Bridge->>Bridge: maybeResume :945 blocked=false ⇒ :946 `return base`
        Note over Bridge: ❷ 不 raise、不挂起
        Bridge->>Bridge: reconcileDelegationTruth（门3/门4/total>0 退场）
        Bridge->>Bridge: reconcileExecutionTruth（D-1 门1 退场）
        Note over Bridge: ❸ 两道兜底防线均退场
    end

    Bridge-->>Prov: LlmGoalResult{ok:true}
    Prov-->>A2A: GoalResult{ok:true}
    Note over A2A: :352 K4 安全网：状态不是 input-required ⇒ 不 return
    Note over A2A: :365 finalState = result.ok ? 'completed' : 'failed'
    A2A-->>Host: 终态 **completed**
    Note over Host,A2A: ❗静默假成功：宿主以为高风险操作已完成<br/>pendingApprovals 里 apr_x 仍是未决状态，无人处理
```

**图中三个「★结构化事实」与「❶/❷/❸」的位置关系，就是本缺陷的全部**：
结构化事实**在服务端已经存在**（三处，且互相独立），但它们**从未上行到桥**；桥只看得到 LLM 的话。

### 2.2 假成功的确切产生点（一句话定位）

> **`packages/adapter-agent-workbuddy-llm/src/bridge.ts:616`**
> `if (!APPROVAL_WAIT_PATTERN.test(finalText)) return base;` —— **这一行的 `return base`**。
>
> 它把 `base`（`ok:true`、`error:undefined`、summary「LLM 运行时（常驻会话）完成目标：…」）**原样放行**，
> 从而使下游 `maybeResume`(:945) 的 `blocked` 为 false ⇒ `:946 return base` ⇒ 不 raise ⇒ 不挂起 ⇒ `completed`。

与 A5 的对照：A5 的失败点是 **`vm-service/src/server.ts` `raise()` 首行守卫**（`no-active-task`，R19F 已修，
现为 `const taskId = req.taskId ?? this.activeTaskId;` + `:213` 早退）。**两者是同一条收口链上不同位置的两个洞**：
R19F 补的是「raise 之后挂到哪里」，CL-K3R 补的是「根本没走到 raise」。

### 2.3 现状判据的失效方向（关键，决定新判据该怎么设计）

`reconcileApprovalWait` 是**单向**判据：命中 ⇒ 改判为「等待审批」（保守）；未命中 ⇒ **透传**（放行）。
它的**默认输出是放行**。因此「LLM 没说」与「LLM 说没被拦」在桥侧**不可区分** —— 这就是 fail-open 的结构性根源。

<!-- APPEND-MARKER -->
