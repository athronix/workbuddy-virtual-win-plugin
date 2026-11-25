# VM 端逻辑架构（Win11 @ 172.16.100.2）

> 对应代码：`packages/vm-service`（7012 行）、`packages/vm-capabilities`（1294 TS + 3522 PS）、`packages/adapter-agent-*`（6197 行）
> 证据等级：§1~§6 为【实证】，§7 为【推断】

---

## 1. 一句话模型

VM 端是一个**单进程 HTTP 服务**，在 `127.0.0.1:18443` 上同时提供 MCP 与 A2A 两条通道，二者**共用同一内核**：

```
能力注册表 → 策略引擎 → 审批闸 → 审计链 → 桥接层(PS) → 能力执行
   ↑                                              ↓
registry                                     ps-bridge.ps1
 (54 能力)                                    (常驻 PS 进程)
```

设计意图在 `vm-service/src/index.ts:4-6` 的头部注释里写得很清楚：

> 统一暴露 MCP（主干）与 A2A v1.0（委派）双通道，二者共享同一内核：
> 能力注册表 → 策略引擎 → 审批闸 → 审计链 → 桥接层 → 能力执行

**【实证】这句设计与实现一致**：两条通道最终都进同一个 `provider.execute()`，审批闸、策略、审计都在 provider 外层统一织入，不存在"两条路各写一遍"。

---

## 2. `createService()` 的装配顺序（顺序即依赖）

**【实证】** `vm-service/src/server.ts:571` 起，单函数跨到 2755 行。装配严格按依赖顺序：

```
①  config       validateServiceConfig → resolveServiceConfig
②  logger       createFileLogger（目录不可写时内部降级，绝不抛错）
③  registry     CapabilityRegistry.registerAll(WINDOWS_CAPABILITIES) → validate()
④  runtime      createWindowsRuntime() + SessionMonitor
⑤  audit        HashChainAuditSink({ freshChainOnStart: true, retention })
⑥  policy       CorePolicyEngine({ registry, config })
⑦  ledgers      LedgerRegistry + ReceiptCache + DelegationScopeRegistry
⑧  auditSink    bypassTagSink(wrapAuditSink(audit, ledgerReg.onAuditRecord))
⑨  approval     VmApprovalCoordinator（须早于 bridgeCtx）
⑩  bridgeCtx    { audit: auditSink, policy, capabilities, bridge, ... }
⑪  provider     loadProvider(cfg.agent, bridgeCtx)  ← 动态 import
⑫  exposed      registry.intersectDeclared(provider.declareCapabilities())
⑬  warmup       provider.kind === 'llm-agent' → void provider.warmup?.()
⑭  mcp          McpServer({ tools: mcpTools })
⑮  a2a          A2AServer + TaskStore + delegationObserver
⑯  upstream     UpstreamRegistry（/mcp/browser、/mcp/desktop）
⑰  server       createServer(路由)
⑱  listen       + 回连探针（必须在 listen 之后）
```

### 2.1 三处顺序是硬约束（错则功能坏）

**【实证】** 代码注释显式标注了理由：

**(a) ⑨ 审批协调器必须早于 ⑩**

```ts
// K4：审批协调器（须先于 bridgeCtx 创建，以便注入 provider；tasks / pendingApprovals
// 在其就绪后通过 bind() 注入，见下方 A2A 构建之后）。
```

**(b) ⑧ 审计 sink 的包装顺序：`bypassTagSink(wrapAuditSink(audit))`**

外层先补 `ext.bypass='dry-run'` 取证位，再进账本与哈希链。反向套会丢掉 bypass 标记。

**(c) ⑱ 回连探针必须 `listen` 之后**

```ts
// 为什么必须放在 listen **之后**：这是自环探针（打自己的 /mcp），放在 listen 之前
```

### 2.2 ⑪ provider 加载失败是「degraded」而非「崩」

**【实证】**（`server.ts:729-737`）：

```ts
try {
  await runtime.bridge.start().catch(() => undefined);
  provider = await loadProvider(cfg.agent, bridgeCtx);
  sessionMonitor.start();
} catch (e) {
  providerError = (e as Error).message;
  logger.error('provider 加载失败，服务进入 degraded（仅 meta.* 可用）', ...);
}
```

配合 ⑫：

```ts
const exposedCapabilities = provider
  ? registry.intersectDeclared(provider.declareCapabilities())
  : registry.intersectDeclared(['meta.*']);
```

**这个降级是安全的**：provider 挂了 ⇒ 只暴露 3 个 `meta.*` 能力（只读健康查询）⇒ 不会出现"限制全没了照常执行"的最坏形态。这是 `SECURITY §3.4` 的落地。

### 2.3 ⑬ 冷启动预热的设计动机

**【实证】** 注释记了完整根因：

> 常驻 codebuddy 会话是 lazy 单例，仅首个委派（或服务重启后 / idle TTL 回收后的首调）才 spawn 并付全额进程级冷启动（auth probe + agent 端点 ≈75–107s）。此时若宿主 A2A 委派以有界超时（A5 默认 60s）等待，会返回「冷启动窗口」引导文案而非结果 —— 即 K2。

解法：`void provider.warmup?.()` fire-and-forget，在启动期（用户不等待）完成冷启动。首个真实委派只需 ~21s 热态处理。

---

## 3. 七个 HTTP 端点

**【实证】** 路由分发在 `server.ts:2169-2340`，全部端点：

| 端点 | 方法 | 是否守 bearer | 用途 |
|---|---|---|---|
| `/health` | GET | **豁免** | 健康快照（见 §5） |
| `/.well-known/agent-card.json` | GET | **豁免** | A2A Agent Card |
| `/mcp` | POST | 守 | MCP 主通道，54 能力 |
| `/audit/receipt` | GET | 守 | 回执查询（`?traceId=`） |
| `/mcp/<id>` | POST | 守 | stdio 上游代理（browser/desktop） |
| `/a2a` | POST | 守 | A2A v1.0 JSON-RPC |
| `/admin/llm-session/reset` | POST | 守 | LLM 常驻会话重置 |

### 3.1 豁免表是硬编码不可配的

**【实证】** `vm-service/src/http-guard.ts:78`：

```ts
export const DEFAULT_EXEMPT_PATHS: readonly string[] = Object.freeze([
  '/health',
  '/.well-known/agent-card.json',
] as const);
```

注释强调「**唯一权威、硬编码**」，且 `exemptPaths` 选项「生产装配点**禁止**传入」。这是刻意的不可配设计：让"哪个端点能免鉴权"不能被配置文件改掉。

### 3.2 守卫插入位置有明确纪律

**【实证】**（`server.ts:2139-2150` 注释）：

> 位置纪律：必须挂在**所有路由分发之前**（`path` 解析后、方法白名单前），否则 `/admin/llm-session/reset` 这类"写在 405 判断之后"的端点会被绕过。

且是**双条件生效**（`O-9`）：

```ts
if (guardActive) {          // guardActive = enforceBearer && token 存在
  const verdict = bearerGuard(req);
  if (verdict.verdict === 'deny') { sendJson(res, 401, ...); return; }
}
```

缺任一件 ⇒ `guardActive=false` ⇒ 整块跳过 ⇒ 路由逐字旧行为（零回归）。这是"半开状态不静默放行，而是根本不进入守卫语义"的处理。

### 3.3 拒绝不进审计链

**【实证】**：守卫拒绝只写 `logger.warn`，**不写链**。理由注释写明：

> 未授权的探测请求不该获得写链配额（否则 DoS 面直接映射成账本膨胀面）。

---

## 4. 双通道如何共用内核

### 4.1 MCP 通道

**【实证】** `server.ts:2179` 的 `/mcp` handler：

```
readBody → JSON.parse
  → 解析 ?dtid=<delegationTraceId>
  → buildMcpRequestContext(dtid, disconnect.signal)
  → mcp.handleRequest(parsed, reqCtx)
```

`mcp-tools` 在装配时（`server.ts:1749`）包了一层 handler：

```ts
audit: async (record) => { ... auditSink.append({ traceId, approved, verdict, delegationId, scope }) }
```

即：**每条 MCP 工具调用都自动落审计链**，`dtid` 在场时归因到委派（`channel:'a2a'` + `ext.delegationId`），不在场时为纯宿主直调（`ToolContext` 逐字节旧形态，零回归）。

### 4.2 A2A 通道

**【实证】** `A2AServer` + `TaskStore` + `DelegationObserver`（`server.ts:1767`）：

```ts
const delegationObserver: DelegationObserver = {
  onGoalAccepted(goal) {
    const ledger = ledgerReg.begin(goal.traceId, goal.taskId ?? '', exposedIds);
    if (goal.taskId) { scopeRegistry.register({...}); }   // 留存宿主声明的 scope
    void audit.append(buildDelegationAuditEntry('start', {...}));  // 落**原始** sink
  },
  ...
};
```

### 4.3 两条通道的汇合点

```
                    ┌─────────────────────────────┐
   POST /mcp ──────▶│                             │
                    │   provider.execute(cap, p)  │──▶ ps-bridge.call()
   POST /a2a ──────▶│  （确定性 or LLM 驱动）      │
                    └─────────────────────────────┘
                              ▲
                              │ 外层统一织入
                    ┌─────────┴──────────┐
                    │ policy.evaluate()  │
                    │ approval gate      │
                    │ auditSink.append() │
                    └────────────────────┘
```

**汇合在 `provider.execute()`**。这是"共享内核"的实现含义：不是两条路各走一遍策略/审计，而是都在 provider 外层被同一套织入。

### 4.4 委派真实性探针（K-N1）

**【实证】** `server.ts:693-712` 给 bridgeCtx 注入了 `delegationProbe`：

```ts
delegationProbe: {
  delegationActivity: async (traceId) => ledgerReg.activityFor(traceId),
  approvalWait: async (q) => [
    ...collectApprovalFacts(pendingApprovals, q, Date.now()),  // S1 令牌表
    ...ledgerReg.blockedFor(q),                                 // S2 账本 blocked
  ],
}
```

用途：桥在收口处反查"本委派回合服务端是否真有过活动"。零活动 ⇒ 把"成功"改判为 `NO_EXECUTION_RECEIPT`。这是防"LLM 声称做完了但什么都没干"的结构性手段。

---

## 5. `/health` 的构成（它不是简单探针）

**【实证】** `buildHealth()`（`server.ts:2379` 起）聚合了 9 个区块：

| 区块 | 内容 |
|---|---|
| `.ok` | 复合判据 |
| `.session` | Windows 交互式会话（GUI 能力前提） |
| `.provider` | provider id/kind/approvalTruth |
| `.capabilities` | 暴露能力数 |
| `.tasks` | TaskStore 计数 + 驱逐数 + 本次运行生效上限 |
| `.audit` | `chainValid` + **`scope:'session'`** |
| `.security` | `authMode` / `innerReconnect` / `failClosed` |
| `.cache.netCfg` | 网络配置缓存 `cached/ageMs/ttlMs` |
| `.logging.degraded` | 文件日志是否降级 |
| `.upstreams[]` | browser/desktop 上游运行态 |

### 5.1 `.audit.scope = 'session'` 是一条纠偏

**【实证】** 注释记了完整推理：

> `freshChainOnStart:true` 使 `verifyChain()` 在每轮只读本轮活跃分片 ⇒ 历史分片永久退出判定面。`/health.audit` 若只报 `chainValid`，读者会把「本轮完好」误读成「全部历史证据完好」。

对冲手段是**启动期异步校验历史归档分片**，落一条 `ext.kind:'chain-archive-verify'` 链上条目，把"跨轮事实"变成有证据的东西。

**这个设计值得记**：`chainValid:true` 单看是误导的，加上 `scope:'session'` 才诚实。这类"字段语义过宽导致误读"的问题在设计评审时极难发现。

### 5.2 健康探测自身有超时防护

**【实证】** `health-probe.ts`（204 行）专门做竞速：

```ts
raceHealthSubProbes / raceSessionProbe / raceWithTimeout
```

理由（注释）：`/health` 未就绪时会先走 lazy 自愈（spawn powershell + ready 握手），单个请求实测阻塞 ~27s。竞速保证 `/health` 仍在超时内返回，`ok` 按既有公式算。

---

## 6. 策略 / 审批 / 审计三链

### 6.1 策略引擎

**【实证】** `core/src/policy/engine.ts:543` `CorePolicyEngine`：

- 三条正则族：`pathDenyRe` / `pathAllowRe` / `cmdDenyRe`
- **"先归一后匹配"**：模式侧与入参侧走同一条归一通路（`U-P0-1`），否则 `C:\Users\a\.\x` vs `C:\Users\a\x` 会漏
- **模式侧 env 展开**（`ARCH-17`）：默认白名单 `%USERPROFILE%\**`，不展开等于恒不匹配

### 6.2 审批闸的两个入口

**【实证】**：

| 通道 | 命中 L2/L3 的行为 |
|---|---|
| A2A（`a2a.delegate`） | 任务转 `input-required`，返回 **`approvalId`**，等 `a2a.approval.reply` |
| MCP 直调 | 收口 `DELEGATION_REQUIRED` 错误，**不发放续跑令牌** |

`server.ts:1755` 的 MCP server `instructions` 原文：

> 风险等级 L2/L3 一律经 a2a.delegate 委派审批（批1(c)：直调命中审批闸即收口 `DELEGATION_REQUIRED`，不再发放续跑令牌）

**注意这里有历史演进**：`server.ts:218` 还留着旧路径的注释：

```ts
// K4 安全点：token 在 `/mcp` 能力层注册时 `hostApproved=false`；
// 宿主经 A2A `approval.reply` 批准：token 置为「已批准」——保留 K4 语义，
// `/mcp` 人工显式续跑路径仍可用。
```

即：**续跑令牌机制仍在代码里（`pendingApprovals` / `PendingApprovalRegistry`），但直调命中审批闸已不再发令牌**。这是一条"保留但基本不触达"的支路 ⇒ F-06。

### 6.3 审计链

**【实证】** `core/src/audit/chain.ts`（738 行）哈希链：

- 文件分片，`maxFileBytes` 可配
- `freshChainOnStart: true` ⇒ 启动即起新分片 + 全新 genesis
- `retention`: `maxAgeDays`(90) ∧ `maxTotalBytes`(<2GB) 双标准，超限删最老
- 包装装饰器：`wrapAuditSink`（喂账本）+ `bypassTagSink`（补 dry-run 取证位）

**一个刻意的纪律【实证】**（`server.ts:759-766`）：

> 写原始 `audit`（顺序纪律 **O-7**）：不经 `auditSink` —— 壳/内部条目若经账本装饰器会把自己登记成「本回合有活动」= **审计自证**

即委派的 `start` / `complete` 壳条目绕开账本，否则"委派发生了"这件事会自己证明"委派真的执行了"。这是很细的正确性考虑。

---

## 7. ps-bridge：Node ↔ PowerShell 的帧协议

**【实证】** `vm-capabilities/psmod/ps-bridge.ps1` 头部定义：

```
请求：{"id":"r1","module":"system","function":"Get-ServiceInfo","params":{...},"timeoutMs":30000}
响应：{"id":"r1","ok":true,"data":{...},"warnings":[],"durationMs":123}
失败：{"id":"r1","ok":false,"error":{"code":"...","message":"...","details":{}},"durationMs":12}
心跳：{"type":"heartbeat"}        （每 15s 一行）
```

三条硬约束：

1. **stdout 只能出现协议 JSON**，诊断一律走 stderr
2. **必须运行在交互式用户会话内**（WinSta0\Default，Session >= 1），否则 GUI 截图黑屏、SendInput 拒绝访问
3. **`Set-StrictMode -Version 1`**，不是 Latest——Latest 会因注册表卸载键缺 `InstallDate` 等可选属性而整类能力抛错

第 3 条是很实际的工程判断，值得保留。

### 7.1 Node 侧的守护

**【实证】** `vm-capabilities/src/ps-bridge.ts`（708 行）的 `PsBridge`：

```
start() → spawnAndReady() → watchdog() → selfHeal() / restart()
```

- 常驻进程避免每次 ~500ms~1s 的 `powershell.exe` 冷启动（NFR-503）
- `watchdog` 心跳监控，`selfHeal` 自愈
- `ready()` 做 spawn + 握手

### 7.2 六个 PS 模块

**【实证】** `psmod/`：

```
ps-bridge.ps1   338   宿主进程（帧协议 + 模块加载 + 心跳）
app.ps1        1209   app 域（最大，含 winget/appx/快捷方式/进程）
gui.ps1         562   gui 域
appops.ps1      548   appops 域
system.ps1      504   system 域
storage.ps1     361   storage 域
```

---

## 8. stdio 上游代理（`/mcp/browser`、`/mcp/desktop`）

**【实证】** `vm-service/src/mcp-upstream.ts`（318 行）。设计动机写得极清楚（`mcp-upstream.ts:4-15`）：

> `agent-browser`（33 工具）与 `agent-desktop`（75 工具）都是 **stdio** MCP server，宿主无法直连；而 vm-service 已经在 SSH 隧道后面提供 `POST /mcp`。本模块把前者的工具面「挂」到后者上。
>
> 为什么由 vm-service 代理，而不是在 VM 里单独起进程：
> 1. **会话继承**：vm-service 跑在 Session 1（InteractiveToken 计划任务），它 spawn 的上游子进程**继承交互式会话** ⇒ agent-desktop 能读到真实桌面。SSH 直启只能拿到 Session 0 的空桌面（`desktop_list_apps` 返回 `apps: []`），这是本设计的决定性动机。
> 2. **安全面复用**：`/mcp/browser`、`/mcp/desktop` 不在 `http-guard` 的硬编码豁免表里，默认 fail-closed 受同一套鉴权保护，无需新增守卫。

### 8.1 分工的三层边界

**【实证】** 注释明确：

- `@winvm/core` 的 `StdioJsonRpcChannel`：只管 NDJSON 收发与子进程生命周期
- `@winvm/mcp-framework` 的 `McpClient`：只管 `tools/list`、`tools/call` 协议
- `mcp-upstream.ts`：只管**懒启动 + 工具缓存 + 白名单过滤 + 崩溃重建 + 优雅关闭**

### 8.2 白名单

**【实证】** `DEFAULT_DESKTOP_TOOL_ALLOWLIST` 实测 **25 条**（`Object.freeze` 数组实际元素数）。

⚠️ **文档漂移**：`delivery/install-host.mjs:1205` 仍写「agent-desktop（VM 侧白名单 10 工具）」，而 `mcp-upstream.ts:62` 已改成「25 个」并注明「v2.2.0 按场景调宽（原 10 项…）」。**注释未同步**。

---

## 9. provider SPI：换 VM 内 Agent 的机制

**【实证】** `core/src/bridge/loader.ts`（111 行）：

```
loadProvider(cfg, ctx):
  1. 查进程内工厂注册表 factories.get(id)     ← 优先（单测/打包场景）
  2. 否则 await import(entry.package)          ← 动态 import
  3. extractFactory(mod)：createProvider | default
  4. await provider.init(ctx)
```

失败语义（注释）：

> 抛出 `ProviderLoadError` —— 调用方必须据此将服务置为 degraded 并仅暴露 `meta.*` 能力，**绝不静默降级为无限制执行**。

### 9.1 三个 provider 实现

| provider id | 包 | 特点 |
|---|---|---|
| `workbuddy-deterministic` | `adapter-agent-workbuddy`（1371 行） | 确定性执行器，**不依赖 LLM** |
| `workbuddy` | `adapter-agent-workbuddy-llm`（4338 行） | 复用确定性执行器，仅 `runGoal` 为 LLM 驱动（常驻 codebuddy 会话） |
| `hermes-agent` | `adapter-agent-hermes`（488 行） | Nous Research Hermes，MCP 经 `config.yaml` 预注册 |

**这是架构里做得最漂亮的一处**：`vm-service` 对 provider 只依赖 `AgentServiceProvider` 契约（来自 `contracts`），三个实现包同层可换，`vm-service`、`mcp-framework`、`a2a-framework`、所有 skill **零改动**。

代价：`vm-service/package.json` 为了能 `import` 到三个 adapter，**声明了 2 个 adapter 依赖**（`adapter-agent-workbuddy`、`adapter-agent-workbuddy-llm`），但 dist 里没有对应 import 语句（dep-lint 报 `DECLARED_UNUSED`）。这是"运行期动态加载"与"编译期依赖声明"的固有张力，**不是错误**——但意味着 `dep-lint` 的 `DECLARED_UNUSED` 判据在这里无法区分"真的没用"与"动态加载"。见 F-12。

---

## 10. VM 端结构总图

```
┌──────────────────────── vm-service (单进程, 127.0.0.1:18443) ────────────────────────┐
│                                                                                      │
│  HTTP 入口 ──▶ bearerGuard（双条件，豁免表硬编码）                                      │
│      │                                                                               │
│      ├─ GET  /health ─────────────────▶ buildHealth()（9 区块 + 3 处竞速超时）          │
│      ├─ GET  /.well-known/agent-card.json ─▶ a2a.getAgentCard()                       │
│      ├─ POST /mcp ──────────┬─▶ McpServer.handleRequest                               │
│      ├─ POST /mcp/<id> ─────┘    └─ UpstreamRegistry（stdio 上游代理）                 │
│      ├─ GET  /audit/receipt ──▶ 链上投影 + 有界脱敏环形缓存                            │
│      ├─ POST /a2a ────────────▶ A2AServer + TaskStore + DelegationObserver            │
│      └─ POST /admin/llm-session/reset ─▶ provider 会话重置                             │
│                                                                                      │
│  ┌──────────── 共用内核 ────────────┐                                                 │
│  │ policy.evaluate()                │  ← CorePolicyEngine（3 正则族，先归一后匹配）    │
│  │ approval gate                    │  ← VmApprovalCoordinator + pendingApprovals      │
│  │ auditSink.append()               │  ← bypassTagSink(wrapAuditSink(HashChain))      │
│  │        ↓                         │                                                 │
│  │ provider.execute(cap, params)    │  ← 3 个实现可换（deterministic / llm / hermes）  │
│  └────────────────┬─────────────────┘                                                 │
│                   │                                                                  │
│                   ▼                                                                  │
│         PsBridge.call(module, fn, params)                                            │
│                   │ NDJSON over stdio（心跳 15s）                                     │
│                   ▼                                                                  │
│         ps-bridge.ps1（常驻，Session 1，StrictMode v1）                                │
│           ├─ system.ps1   504                                                         │
│           ├─ app.ps1     1209                                                         │
│           ├─ storage.ps1  361                                                         │
│           ├─ gui.ps1      562                                                         │
│           └─ appops.ps1   548                                                         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```