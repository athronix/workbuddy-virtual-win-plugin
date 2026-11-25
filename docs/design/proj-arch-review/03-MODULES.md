# 12 个模块的技术架构

> 逐包：职责、导出面、依赖方向、关键实现选择、值得注意的坑。
> 依赖矩阵与 `layer` 字段为【实证】；"关键实现选择"部分引自源码注释，属作者自述，本文标注为【自述】。

---

## 0. 依赖方向总表（机检事实源 = 各包 `package.json` 的 `layer` 字段）

```
rank  层标记               包                        内在依赖
  0   L0-contracts         contracts                 （零）
 10   L1a-core             core                      contracts
 20   L1b-mcp-framework    mcp-framework             contracts, core
 20   L1b-a2a-framework    a2a-framework             contracts, core
 30   L1c-host-sdk         host-sdk                  contracts
 40   L2-vm-capabilities   vm-capabilities           contracts, core
 40   L2-vm-service        vm-service                contracts, core, mcp-fw, a2a-fw,
                                                     vm-capabilities, adapter-agent-wb(+llm)
 40   L2-adapter-host      adapter-host-workbuddy    contracts, host-sdk
 40   L2-adapter-agent     adapter-agent-workbuddy   contracts, core, vm-capabilities
 40   L2-adapter-agent-llm adapter-agent-workbuddy-llm  contracts, core, vm-capabilities,
                                                       adapter-agent-workbuddy
 40   L2-adapter-agent-llm adapter-agent-hermes     contracts, core, vm-capabilities,
                                                     adapter-agent-workbuddy(+llm)
 50   L3-host-bridge       host-a2a-bridge           contracts, core, mcp-fw, a2a-fw
```

### 0.1 机检结果

**【实证】** `node scripts/dep-lint.mjs` 输出：

```
扫描：packages=12  js文件=76  import语句=48  包级边=24  审计符号=8
违规：9 条（hard=0 warn=0 info=9）
VERDICT: GREEN
```

**hard=0** = 无反向依赖、无框架越界。这证明 `ARCHITECTURE.md §2.1` 的依赖铁律**确实成立且被机检守住**，不是文档承诺。

9 条 info 全是 `DECLARED_UNUSED`，分两类：

| 类型 | 涉及包 | 性质 |
|---|---|---|
| `type-only import` 编译期擦除 | contracts 侧 6 条 + core 侧 1 条 | **误报**。TS 的 `import type` 编译后消失，dist 里当然没有语句边 |
| 动态 `import()` 加载 | `vm-service` → 2 个 adapter | **设计选择**。provider SPI 就是靠动态加载实现可换 |

⇒ F-12：`DECLARED_UNUSED` 判据无法区分"真的没用"与"type-only / 动态加载"。它作为 info 级是恰当的，但**不能因此认为这条判据没价值**——若某包真的删了 import 却留着依赖声明，仍会被它抓到。改进方向见 `04-FINDINGS.md`。

---

## 1. `contracts`（L0，2365 行，10 文件）

**职责**：唯一契约源。能力模型、风险分级、传输声明、A2A/MCP 消息扩展、插件清单的 TS 类型 + 校验器。

**导出面**（`src/index.ts` 全文 20 行）：

```ts
export * from './risk.js';        // 52   RiskLevel / RISK_LEVELS
export * from './errors.js';      // 114  BridgeError 族
export * from './capability.js';  // 184  CapabilityDefinition / CapabilityDomain(6)
export * from './schema-check.js';// 296  手写校验器（无第三方 schema 库）
export * from './transport.js';   // 86   TransportDecl 三态
export * from './audit.js';       // 254  审计条目形状
export * from './bridge.js';      // 928  AgentServiceProvider / BridgeContext（最大）
export * from './host.js';        // 169  NeutralPlugin / HostRenderer / SkillDomain(4)
export * as A2A from './a2a.js';  // 262  命名空间导出，避同名冲突
```

### 1.1 零依赖是真做到了

**【实证】** `package.json` 无任何 `dependencies`；`index.ts` 头注释原文：

> 依赖铁律：本包零依赖，不得依赖任何其它包；所有其它包都可以依赖本包。

**注意 `schema-check.ts` 296 行是手写的校验器**——没有引 `ajv` / `zod`。这是刻意维持零依赖的代价，但也意味着校验能力受限于手写逻辑。

### 1.2 `A2A` 命名空间导出的原因

**【实证】** 注释：

> A2A v1.0 类型以命名空间导出，避免与 bridge 层的 `TaskState` / `Artifact` 同名冲突。

即 `bridge.ts` 与 `a2a.ts` 各有一套 `TaskState` / `Artifact`，一个是本项目内部状态机，一个是 A2A 协议规范。用命名空间隔离是合理选择，但也说明**两套模型确实并存**（见 F-13）。

### 1.3 `SkillDomain`(4) vs `CapabilityDomain`(6)

**[实证]** `host.ts:20` vs `capability.ts:11`。这是 F-02 的根源。二者在同一包里，紧邻两个文件，却没有对齐。

---

## 2. `core`（L1a，5277 行，20 文件）

**职责**：宿主无关的核心件——传输抽象、能力注册表、策略引擎、哈希链审计、会话保活、provider SPI 加载器、配置、日志。

| 文件 | 行数 | 内容 |
|---|---|---|
| `policy/engine.ts` | 828 | `CorePolicyEngine`，3 正则族，归一/展开/匹配 |
| `audit/chain.ts` | 738 | 哈希链，分片，保留策略，sink 装饰器 |
| `transport/ssh-tunnel-ssh2.ts` | 520 | ssh2 隧道实现（**交付链上未使用**，见 F-01） |
| `constants.ts` | 446 | 跨端共享常量（含 psmod 侧） |
| `config/index.ts` | 418 | 配置加载/校验/resolve |
| `file-logger.ts` | 319 | 双写日志，降级不抛错 |
| `logger.ts` | 222 | 凭据脱敏 |
| `transport/stdio-channel.ts` | 215 | NDJSON 子进程通道 |
| `transport/http-channel.ts` | 182 | HTTP JSON-RPC + SSE 解析 |
| `transport/ssh-tunnel.ts` | 170 | 隧道门面（**同上，未使用**） |
| `index.ts` | 162 | 导出面 |
| `policy/defaults.ts` | 159 | 默认策略表 |
| `policy-gate.ts` | 159 | 纯判据垫片 |
| `transport/index.ts` | 144 | `establishTransport` 工厂 + `applyBearerHeader` |
| `session/health.ts` | 141 | 会话探针 |
| `registry/capability-registry.ts` | 116 | 注册表 + `domains()` |
| `bridge/loader.ts` | 111 | provider 动态加载 |
| `approval-hash.ts` | 101 | previewHash（宿主/VM 共用） |
| `k6-verdict.ts` | 93 | 自报失败折叠纯函数 |
| `transport/types.ts` | 33 | `JsonRpcChannel` / `TransportHandle` |

### 2.1 值得注意的三处设计

**(a) `applyBearerHeader` 抽取的病灶记录【自述】**

`transport/index.ts:38-42` 注释：

> 病灶：`authorization` 头的拼装此前只写在 `streamable-http` 分支里，`ssh-tunnel` 分支**完全不消费** `tokenEnv`。服务端一旦启用 `enforceBearer`，走隧道的宿主委派会**当场 401**。

抽出共函数后三态语义单点定义：未配 ⇒ 不发头；配有值 ⇒ 发；配无值 ⇒ 抛 `TransportError`（fail-loud）。

**(b) 隧道校验前置到建隧道之前【自述】**

> 校验**前置**到建隧道之前：`tokenEnv` 有名无值是要抛的（态 3），若放在 `establishSshTunnel` 之后才抛，隧道子进程已经起来却被调用方拿到异常，`close()` 永远不会执行 ⇒ **泄漏一条 SSH 隧道**。

**(c) `freshChainOnStart` 的取舍【自述】**

`server.ts:607-613` 注释：历史分片已含断链（seq=511/582 重复 seq），若续接旧链，`chainValid` 对历史数据永远报 false。改为"新链只写新分片、历史分片仅归档"，部署后 `/health` 立即回 true。

**这是一个诚实的权衡**，但它把"历史断裂"从判定面移出去了——所以必须配 `/health.audit.scope='session'` + 启动期归档校验（见 `02-VM-SERVICE.md §5.1`）才算完整。

---

## 3. `mcp-framework`（L1b，531 行，3 文件）

**职责**：MCP 协议框架。Server（工具注册/校验/执行/audit 织入）+ Client（连接/重试/超时）。

```
server.ts  376   McpServer：handleRequest / tools 注册 / 校验 / 执行
client.ts  130   McpClient：tools/list、tools/call
index.ts    25
```

**依赖铁律的例外说明**【实证】：`dep-lint` 有专门的 `FRAMEWORK_TO_BUSINESS` 判据——框架层（L1b）**禁止** import 业务/能力/适配侧包（`BUSINESS_PKG_RE = /^(adapter-|vm-service$|vm-capabilities$)/`）。当前 hard=0 ⇒ 未违反。

**设计观察**：`mcp-framework` 只有 531 行，是 12 个包里最小的之一。这说明 MCP 协议本身的实现量不大，**复杂度都在协议之外**（能力定义、策略、审计）。

---

## 4. `a2a-framework`（L1b，1964 行，5 文件）

**职责**：A2A v1.0 协议框架。

```
task-store.ts   877   Task 状态机 + 生命周期 + 驱逐
server.ts       747   message/send、message/stream(SSE)、tasks/get|list|cancel|subscribe
client.ts       221   A2A 客户端
rate-limiter.ts  72
index.ts         47
```

### 4.1 框架不依赖 core 是刻意的

**【实证】** `vm-service/src/server.ts:1769-1772` 注释：

> 为什么写在 vm-service 而不是框架：`a2a-framework` 不依赖 `@winvm/core`（依赖方向铁律），框架只留两点回调、零审计语义；语义（双态条目、账本窗口）由本层实现。

**这是一个干净的边界**：框架只管协议状态机，审计语义（什么算"有活动"、什么算"blocked"）留给业务层。代价是 `DelegationObserver` 回调的设计必须足够表达力，否则业务层要侵入框架。

### 4.2 TaskStore 的有界化

**【实证】** `TASK_STORE_MAX_TASKS = 200`、`TASK_STORE_TERMINAL_TTL_MS = 3_600_000`（`server.ts:200-201`），驱逐事实落链（`ext.kind:'task-evicted'`）。

驱逐取证是**突发合并 + fire-and-forget**（`task-evict-audit.ts` 215 行），零定时器 ⇒ 离线可测。

---

## 5. `host-sdk`（L1c，545 行，3 文件）

**职责**：宿主插件规范 SDK。中性插件模型 + 渲染抽象 + skill 加载。

```
index.ts        164   validateNeutralPlugin / assertValidPlugin
patch.ts        145   JSON Pointer + deepMerge/setAtPointer/getAtPointer
skill-loader.ts 236   frontmatter 解析 + 目录加载
```

### 5.1 frontmatter 是手写解析器

**【实证】** `skill-loader.ts` 只支持极简 YAML 子集：`key: value`、`key: [a, b]`、缩进块。没有引 yaml 库。

后果：skill 的 frontmatter 表达能力受限（不能嵌套对象、不能多行字符串语法）。当前 10 个 skill 都够用，但**新增复杂 frontmatter 会静默失败**。

### 5.2 `domains` 的静默丢弃点

`skill-loader.ts:125-130` 就是 F-02 的那段代码：

```ts
const filtered = d.filter((x): x is SkillDomain => (VALID_DOMAINS as readonly string[]).includes(x));
return filtered.length > 0 ? filtered : undefined;
```

**没有 warning、没有日志**。这是"契约过窄 + 静默过滤"的组合，最难发现——不报错、不告警，字段就是没了。

---

## 6. `vm-capabilities`（L2，1294 TS + 3522 PS）

**职责**：Windows 能力实现。54 个能力定义 + ps-bridge 常驻进程客户端 + 6 个 PS 模块。

```
ps-bridge.ts              708   PsBridge 类：spawn/ready/watchdog/selfHeal/restart/call
registry/definitions.ts   504   54 个能力定义（6 域，风险分级）
index.ts                   82   导出面
psmod/ps-bridge.ps1       338   PowerShell 宿主（帧协议 + 模块加载 + 心跳）
psmod/app.ps1            1209   app 域
psmod/gui.ps1             562   gui 域
psmod/appops.ps1          548   appops 域
psmod/system.ps1          504   system 域
psmod/storage.ps1         361   storage 域
```

### 6.1 能力定义是数据不是逻辑

**【实证】** `definitions.ts` 504 行几乎全是对象字面量：`id`、`name`、`risk`、`params` schema、`preview` 构造提示等。执行逻辑全在 PS 侧。

**这个分工是对的**：定义（可静态校验、可给 LLM 当工具描述）与实现（PS 函数）分离。

### 6.2 `app.ps1` 1209 行是最大的单点

**【实证】** 覆盖 winget / appx / 快捷方式 / 进程 / 卸载 / 库存盘点。是全部 PS 代码的 34%。

**问题**：PS 没有单元测试框架接入（`tests/` 里 140 个 `.test.js`/`.test.mjs` 全是 Node 侧）。PS 侧的正确性只能靠真机验证。见 F-10。

---

## 7. `vm-service`（L2，7012 行，15 文件）

**职责**：VM 端标准 Agent 服务——双通道 HTTP 服务 + 装配 + 全部治理链。

| 文件 | 行数 | 内容 |
|---|---|---|
| `server.ts` | **2839** | 装配（`createService` 2185 行）+ 路由 + 审批 + 健康 + 上游 |
| `delegation-audit.ts` | 899 | 委派账本 / 壳条目 / 回执缓存 / sink 装饰器 |
| `http-guard.ts` | 651 | bearer 守卫纯函数族 + 自检 |
| `approval-replay.ts` | 626 | 审批决策取证 + 重放 |
| `mcp-upstream.ts` | 318 | stdio 上游代理 |
| `pending-approvals.ts` | 277 | 续跑令牌表（有界 + TTL） |
| `cli.ts` | 253 | `info` / `serve` 命令行 |
| `task-evict-audit.ts` | 215 | 驱逐取证 |
| `health-probe.ts` | 204 | 健康竞速 |
| `delegation-scope.ts` | 199 | 委派 scope 留存表 |
| `inner-reconnect-probe.ts` | 183 | 回连运行期探针 |
| `index.ts` | 178 | 导出面 |
| `mcp-transport.ts` | 89 | 断连侦测 + 请求上下文 |
| `capabilities-profile.ts` | 56 | 能力面 profile |
| `policy-gate.ts` | 25 | 纯判据垫片 |

### 7.1 一个模式：装配层 + 纯函数件分离

**【实证】** 观察这 15 个文件，可以看出一条一致的纪律：

> **凡是能脱离 HTTP 服务与 ps-bridge 直测的判据，一律抽成纯函数模块单独成文件。**

`index.ts` 的注释把理由写透了（`vm-service/src/index.ts:48-52`）：

> 再导出的唯一目的是让判据可脱 ps-bridge 直测：本沙箱内 `createService` 会 spawn PowerShell 桥并触发 V8 fatal ⇒ 装配层入口不是可用测试面。

**这是本项目最值得学习的一处工程决策**。13 个辅助文件（899+651+626+318+277+215+204+199+183+89+56+25 ≈ 3740 行）全都是为了"能测"而从 `server.ts` 里拆出来的。

**但也暴露了问题**：拆出来的有 3740 行，留在 `server.ts` 的还有 2839 行——说明**拆得不彻底**，或者 `createService` 里还有大量本可抽出的逻辑。见 F-03。

### 7.2 `server.ts` 里还剩什么

**【实证】** 按区段扫描，`createService`（571-2755）内部包含：

| 区段 | 大致行范围 | 职责 |
|---|---|---|
| 配置校验 + logger + registry | 572-600 | 装配 |
| audit + policy + ledgers + sink | 601-660 | 装配 |
| approvalCoordinator + bridgeCtx | 661-715 | 装配 |
| provider 加载 + degraded | 716-760 | 装配 |
| 归档校验 + bearer 自检 | 745-980 | **逻辑** |
| 审批协调器类 `VmApprovalCoordinator` | 200-537 | **类定义**（在 createService 之外，同文件） |
| netCfg 缓存 | 970-1000 | **状态管理** |
| 审批超时回调 | 1020-1060 | **逻辑** |
| TaskStore 构造 + 驱逐 | 1030-1120 | 装配 + 逻辑 |
| MCP tools 组装 | 1650-1765 | **逻辑（约 115 行）** |
| A2A 构造 + observer | 1767-1960 | 装配 + **逻辑** |
| 上游 registry | 2060-2125 | 装配 |
| 路由分发 | 2131-2340 | **逻辑（210 行）** |
| buildHealth | 2379-2660 | **逻辑（280 行）** |
| 回连探针 + listen | 2660-2755 | 装配 |

⇒ **至少 900 行是可抽出的逻辑**（审批协调器类、MCP tools 组装、路由分发、buildHealth）。

### 7.3 `VmApprovalCoordinator` 定义在同文件 200-537 行

**【实证】** `index.ts:11` 导出了它：

```ts
/** K4：导出审批协调器（供单测验证安全闸；生产由 createService 内部实例化并注入） */
export { VmApprovalCoordinator } from './server.js';
```

即：**一个 337 行的类为了"导出方便"留在 `server.ts` 里**。抽到 `approval-coordinator.ts` 零成本，能立刻缩小 `server.ts` 12%。

---

## 8. `adapter-host-workbuddy`（L2，1376 行，2 文件）

**职责**：宿主 WorkBuddy 适配器。唯一实现 `HostRenderer` 的包。

```
index.ts        555   WorkBuddyRenderer（plan/validate/install/uninstall）+ 路径规划 + 连接器渲染
approval-card.ts 821  审批卡 HTML 模板常量 + fillApprovalCard + 降级判定 + 哨兵自检
```

### 8.1 `approval-card.ts` 821 行里有 700+ 行是 HTML 常量

**【实证】** `APPROVAL_CARD_WIDGET_HTML` 是一个内联的完整 HTML 卡片（含 CSS + JS 交互）。它作为 `.ts` 里的字符串常量存在。

**这带来两个问题**：

1. **语法高亮/编辑体验差**：700 行 HTML 在 TS 字符串里
2. **`fillApprovalCard()` 零生产调用点**（F-05）：821 行文件的核心导出，生产代码不调

**改进方向不是"删掉"，而是"接线"**——见 `05-OPTIMIZATION-PLAN.md` B-2。

---

## 9. `host-a2a-bridge`（L3，1570 行，6 文件）

**职责**：宿主侧 A2A 委派桥。以本地 stdio MCP server 形态补齐宿主的 A2A 一跳。

```
tools.ts          1031   5 个工具：a2a.delegate / task.get / approval.reply / task.cancel / health
cli.ts             157   CLI 入口（buildTransport + createLazyClientProvider）
approval-audit.ts  137   宿主侧审批审计
client.ts          115   createA2aClient + 懒连接 provider
stdio.ts            80   stdio MCP 传输
index.ts            50
```

### 9.1 `tools.ts` 1031 行 = 5 个工具

**【实证】** 平均一个工具 206 行。`a2a.delegate`（491 行起）是最大的一块，包含：目标构造、风险上限、超时、进度轮询、审批事件翻译、产物收集、K6 折叠裁决、收尾反查（`delegationProbe`）。

**这是"宿主只懂 MCP，VM 只说 A2A"这一语义鸿沟的代价**：所有翻译逻辑必须挤在一个文件里。

### 9.2 它是唯一用 `establishTransport` 的生产代码

**【实证】** 见 F-01。`client.ts:62`：

```ts
const transport = await establishTransport(opts.transport, { path: opts.a2aPath ?? '/a2a', ... });
```

而 `cli.ts:107` 构造的 `TransportDecl` 是：

```ts
export function buildTransport(args: CliArgs): TransportDecl {
  return { kind: 'streamable-http', url: args.endpoint, ... };
}
```

⇒ **`kind` 永远是 `streamable-http`**，因此 `establishTransport` 的 `ssh-tunnel` 分支（那 690 行隧道实现）**在这条唯一生产路径上永不执行**。

---

## 10. `adapter-agent-workbuddy`（L2，1371 行，1 文件）

**职责**：VM 内确定性 Agent 适配器。实现 `AgentServiceProvider` SPI，不依赖 LLM。

**特点**：单文件 1371 行，是"确定性执行器"——把 capability id + params 直接转成 ps-bridge 调用。

**一个易混点【实证】**：`buildPreview` / `collectImpact`（dry-run 预览与影响收集）**不在本包，而在 `vm-service/src/server.ts:2756/2815`**（模块级函数，被 `createService` 内层调用 3 次）。这本身是 F-03 的一个证据：**渲染"这一步会做什么"属于展示逻辑，却和装配函数放在同一文件里**。

---

## 11. `adapter-agent-workbuddy-llm`（L2，4338 行，5 文件）

**职责**：LLM Agent 适配器。复用确定性执行器，仅 `runGoal` 换成 LLM 驱动（常驻 codebuddy 会话）。

```
bridge.ts               1892   CliLlmBridge：LLM 会话 + 工具注入 + 审批处理 + K6 折叠
persistent-session.ts   1144   常驻会话：spawn / auth probe / idle TTL / 重置
index.ts                 702   provider 实现（init/execute/runGoal/declareCapabilities/warmup）
delegation-truth.ts      455   委派真实性判据（纯函数）
working-set-probe.ts     145   工作集探针
```

### 11.1 这是全部 12 个包里最大的一块

**【实证】** 4338 行，占 `packages/` 总行数的 **15%**。`bridge.ts` 单文件 1892 行。

**复杂度来源**【自述·引注释】：
- 常驻会话冷启动 75-107s，需要 auth probe + 端点检测 + 预热
- 审批事件要翻译成 LLM 可理解的 `input-required` 并接收回复续跑
- K6 自报失败折叠（LLM 说"成功了"但事实是失败）
- `delegationProbe` 收尾反查（零活动 ⇒ 改判 `NO_EXECUTION_RECEIPT`）

### 11.2 本次复审对这块的覆盖最浅

**如实登记**：`bridge.ts` 1892 行只做了结构级阅读，未逐分支核验。理由与风险见 `00-OVERVIEW.md §5`。

这块的风险是：**它是 LLM 驱动的，行为不确定性最高，但代码量最大、测试面最难覆盖**。建议后续单独做一次专项复审。

---

## 12. `adapter-agent-hermes`（L2，488 行，2 文件）

**职责**：Hermes Agent 适配器（`agent.provider=hermes-agent`）。

```
index.ts          217   provider 实现
mcp-registrar.ts  271   HermesMcpRegistrar：写 config.yaml 预注册 MCP
```

**最小的 provider 实现**（488 行 vs llm 的 4338 行）。因为 Hermes 自己是 MCP 客户端，本适配器只需"注册 MCP + 转交目标"，大部分编排由 Hermes 自己做。

---

## 13. 模块间关系总图

```
                  ┌──────────────┐
                  │  contracts   │  L0 · 零依赖 · 2365 行
                  └──────┬───────┘
        ┌────────────────┼────────────────┬─────────────┐
        ▼                ▼                ▼             ▼
  ┌───────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────┐
  │   core    │  │ mcp-framework│  │a2a-framework│ │ host-sdk │
  │  L1a 5277 │  │  L1b 531     │  │  L1b 1964  │ │ L1c 545  │
  └─────┬─────┘  └──────┬───────┘  └─────┬──────┘ └────┬─────┘
        │               │                │              │
        └───────┬───────┴────────┬───────┘              │
                ▼                ▼                       ▼
        ┌───────────────┐  ┌─────────────┐      ┌────────────────────┐
        │vm-capabilities│  │ vm-service  │      │adapter-host-workbuddy│
        │  L2 1294+3522 │  │  L2 7012    │      │     L2 1376         │
        └───────┬───────┘  └──────┬──────┘      └────────────────────┘
                │                 │ 动态加载
                │      ┌──────────┴───────────┐
                │      ▼          ▼           ▼
                │  ┌────────┐ ┌─────────┐ ┌────────┐
                └─▶│adapter-│ │adapter- │ │adapter-│
                   │  wb    │ │  wb-llm │ │ hermes │
                   │ 1371   │ │  4338   │ │  488   │
                   └────────┘ └─────────┘ └────────┘
                                    L2（同层可换）

                          ┌──────────────────┐
                          │ host-a2a-bridge  │  L3 · 1570
                          └──────────────────┘
                            （唯一用 establishTransport 的生产代码）
```

**读图要点**：
- 箭头 = 依赖方向，全部向下（rank 递增），**无机检违规**
- `vm-service` → 三个 adapter 的虚线是**动态 `import()`**，不是静态依赖 ⇒ dep-lint 报 `DECLARED_UNUSED`
- `adapter-agent-hermes` → `adapter-agent-workbuddy(-llm)` 是真实的静态 import（`index.ts:25-26`），同层横向依赖 —— 这是唯一一处"同层依赖"，dep-lint 的 `LAYER_DIRECTION` 判据只看 rank 大小（相等不算反向），因此不报。**但语义上它使 hermes 无法脱离 workbuddy 单独部署**，见 F-11。