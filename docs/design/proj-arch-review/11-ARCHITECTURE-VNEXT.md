# V-NEXT 架构定稿（我的判断，不是建议的复述）

> **本文取代 `10-VNEXT-SCOPE-DECISION.md` 的架构部分。**
> 10 号文记录的是「按 owner 建议逐条落点」，本文是**我基于代码事实做出的架构裁决**——
> 采纳 owner 建议的骨架，但修正了其中 3 处、并新增了 2 处 owner 未提及但必须做的。
>
> 判据：**简单 + 有效 + 健壮 + 强大**。四者冲突时的取舍顺序：
> **健壮 > 简单 > 有效 > 强大**（不安全的功能不值得留在发布版里，复杂则是长期的最大风险源）。

---

## 0. 先说结论：五组件、十个包、一条闸

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① WorkBuddy Plugin（宿主）                                            │
│    4 个 MCP 连接器 / 10 个 skill / 审批卡模板                          │
│    职责：渲染连接器条目、注入 skill，不碰部署、不碰 runtime            │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ streamableHttp 127.0.0.1:<port>
┌───────────────────────────▼──────────────────────────────────────────┐
│ ② Tunnel（oh-tunnel + tunnel-daemon，已在 delivery/）                 │
│    唯一隧道实现。SSH 本地端口转发 → VM 127.0.0.1:18443                 │
│    职责：只搬字节，不知道协议内容                                       │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│ ③ VM Service（vm-service :18443）                                    │
│    ┌────────────────┬────────────────┬──────────────────┐            │
│    │ ④a MCP Service │ ④b A2A Service │ ④c 假想中的上游   │            │
│    │  /mcp          │  /a2a          │  /mcp/browser     │            │
│    │  54 能力       │  任务+审批往返  │  /mcp/desktop     │            │
│    └────────────────┴────────────────┴──────────────────┘            │
│                          ↓ 全部汇入                                  │
│    ★ 唯一闸门 gateAndExecute()：policy → approval → exec → audit      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 确定性执行（ps-bridge NDJSON over stdio）
┌───────────────────────────▼──────────────────────────────────────────┐
│ ⑤ VM 内 Executor + 可选 Planner                                      │
│    Executor：54 个能力 → PowerShell（ps-bridge，3522 行）             │
│    Planner ：⑤b 可选，codebuddy CLI 仅用于 runGoal（开放任务规划）    │
└──────────────────────────────────────────────────────────────────────┘
```

**一句话**：把「3 个执行入口」收成「1 个闸门」，把「3 个 provider 3 选 1」收成「1 个执行器 + 1 个可选 planner」，把「2 套域模型」收成「1 张派生表」。

---

## 1. 架构裁决（6 条，每条含反证）

### 决策 A · 执行路径唯一化（**最高优先级，健壮性核心**）

**现状病灶**（实证）：

```
/mcp          → 54 能力 → evaluateScoped() → provider.execute() → audit ✅
/mcp/browser  → 33 工具 → handleRequest() 直接执行              ❌ 零策略零审批零审计
/mcp/desktop  → 25 工具 → handleRequest() 直接执行              ❌ 同上
```

证据：`server.ts:2245` 分支内**没有** `evaluateScoped` 调用；`mcp-upstream.ts`（318 行）搜索
`policy|audit|approval|capability` **命中数 = 0**。

这 58 个工具包含：`desktop_click`（点任意窗口）、`agent_browser_eval`（页内跑任意 JS）、
`desktop_type`（向任意输入框打字）。**这是全项目最大的安全缺口，且不是「policy 没配」而是「执行绕过了闸」**。

**裁决**：三个端点全部汇入同一个 `gateAndExecute()`。

```ts
// vm-service/src/gateway.ts（新增，这是本版本的核心件）
export async function gateAndExecute(
  entry: CapabilityEntry,      // 112 项统一表里的一项
  params: unknown,
  ctx: ExecCtx,
): Promise<ExecResult> {
  // ① 策略（黑名单 + 默认放行）
  const verdict = evaluateScoped(entry, params, ...);
  if (!verdict.allowed) return denied(verdict);

  // ② 审批（L2/L3 且直调 ⇒ 收口 DELEGATION_REQUIRED，与现状语义一致）
  if (verdict.requiresApproval && !ctx.innerDelegation) {
    return delegationRequired(entry);
  }

  // ③ 执行：按 surface 分发，但**已过同一道闸**
  const res = entry.surface === 'vm'
    ? await provider.execute({ ... })
    : await upstreamCall(entry.surface, entry.tool, params);

  // ④ 审计：两条路径都必须写链（上游当前完全不写）
  await recordAudit(entry, params, res, ctx);
  return res;
}
```

**为什么不合并成一个端点**（我否掉了自己的第一直觉）：

合并到单一 `/mcp` 能让宿主只连 2 个连接器，更简单。但 112 个工具的完整 JSON Schema
会撑爆宿主 LLM 的上下文预算。**现有「按端点分surface」正好是天然的按需加载机制**——
宿主做浏览器任务时只连 browser 端点。

所以：**保留 4 个连接器，但 3 个执行入口共用 1 道闸**。这正是 owner 说的
「通过清晰能力分类明确对哪个 mcp-tools 的加载和调用」的准确形态。

---

### 决策 B · Provider 抽象降级为「执行器 + 可选 Planner」（**简单性核心**）

**事实发现**（这条是我读代码才发现的关键）：

```ts
// adapter-agent-workbuddy-llm/src/index.ts:331-333
async execute(req: CapabilityRequest): Promise<CapabilityResult> {
  return this.executor.execute(req);     // ← 委托给 DeterministicAgentProvider
}
```

```ts
// adapter-agent-workbuddy-llm/src/index.ts:228
opts.executor ?? new DeterministicAgentProvider({ psBridge, maxConcurrency })
```

**即：三个 provider 的 `execute()` 最终都落到同一个 `DeterministicAgentProvider`。**
provider 之间唯一的真实差异是 `runGoal()` 的实现（模板 vs LLM 规划）。

| provider | 行数 | execute | runGoal | 被使用？ |
|---|---|---|---|---|
| `workbuddy-deterministic` | 1371 | 自己实现（psBridge） | 5 个模板 | ✅ 出厂默认 |
| `workbuddy` | 4338 | **委托上面那个** | codebuddy CLI 规划 | ✅ 可切 |
| `hermes-agent` | 488 | **委托上面那个** | hermes CLI 规划 | ❌ **零使用**（只在 config 里出现） |

**裁决**：抽象层次错了。不是「选哪个 provider」，而是「用哪个 planner」。

```ts
// 目标形态
class WinVmProvider implements AgentServiceProvider {
  execute(req)  { return this.executor.execute(req); }        // 恒确定性，不可切换
  runGoal(g, s) { return (this.planner ?? template).plan(g, s); }  // 可切换
}
```

配置从三选一变成一行：

```json
// 前
{ "agent": { "provider": "workbuddy", "providers": { "workbuddy-deterministic": {...}, "workbuddy": {...}, "hermes-agent": {...} } } }
// 后
{ "agent": { "planner": "llm" } }        // "template" | "llm"
```

**收益**：删 `core/bridge/loader.ts`（111 行动态加载器）、删 `adapter-agent-hermes`（488 行）、
配置面从 3 段变 1 个枚举值。

**反证（为什么不能直接删 LLM）**：
`runGoal` 不是多余的——A2A 委派的核心价值就是「开放任务」。
如果只有模板，A2A 就退化成一个「必须走两跳的 execute」，那 A2A 整层都失去意义。
**LLM 必须留，但它属于 `runGoal` 的实现细节，不该污染 `execute` 的安全语义。**

**风险**：`adapter-agent-workbuddy-llm/src/index.ts`（702 行）要从「provider 类」改造成「planner 类」。
bridge.ts（1892 行）+ persistent-session.ts（1144 行）不动。这是中等规模改造，需独立时间窗。

---

### 决策 C · 能力表统一为 112 项（**强大性基础**）

**事实**：`CapabilityDefinition.domain` **不是存储字段，是派生值**：

```ts
// vm-capabilities/src/registry/definitions.ts:75
const domain = spec.id.split('.')[0] as CapabilityDefinition['domain'];
```

这句话决定了整个分类方案：**分类不需要额外声明，ID 的第一段就是分类**。
owner 说「领域先不要了」之所以正确，就是因为 `SkillDomain` 是**同一事实的第二份拷贝**，
而这份拷贝已经漂移成 4 值 vs 6 值。

**裁决**：112 项进一张表，新增且只新增一个维度 `surface`：

```ts
interface CapabilityEntry {
  readonly id: string;        // 'system.service.control' | 'browser.act.click' | 'desktop.input.type'
  readonly surface: Surface;   // 新增且唯一新增的维度：'vm' | 'browser' | 'desktop'
  readonly risk: RiskLevel;
  readonly title: string;
  readonly tool?: string;      // 上游真实工具名；仅当 ≠ id 时出现（vm 面 54 条恒等于 id）
}
```

> ⚠ **`domain` 不是字段。** 早前本文件把它写成 `readonly domain: Domain; // 派生`，自相矛盾：
> 标注「派生」却又声明为属性。实际源码（`contracts/src/unified.ts:72`）里**没有**该字段，
> 只有 `deriveDomain(id)` 函数。区别重要：若存字段，就存在「id 改了、domain 没改」的静默错标；
> 每次现算则物理上不可能不一致。
>
> 容易混淆的是 **`CapabilityDefinition`（vm 面执行体）确实有 `readonly domain`** —— 它需要按域索引
> （`registry.listByDomain()`）。**两个接口不是一回事**：一个是「能执行什么」（54 条，有 domain），
> 一个是「对外承诺什么」（112 条，按 `deriveDomain` 现算）。

**112 项的分布**（全部实测）：

| domain | vm | browser | desktop | 合计 |
|---|---|---|---|---|
| `meta` | 3 | — | — | 3 |
| `system` | 14 | — | — | 14 |
| `app` | 8 | — | — | 8 |
| `storage` | 13 | — | — | 13 |
| `gui` | 11 | — | — | 11 |
| `appops` | 5 | — | — | 5 |
| **`browser`** | — | **33** | — | 33 |
| **`desktop`** | — | — | **25** | 25 |
| **合计** | **54** | **33** | **25** | **112** |

**关键设计：browser / desktop 是平级一级分类，不是 `gui` 的子域。**

理由（这条必须写清，否则后面会有人想「合并进 gui」）：
1. `gui` 的 11 项是**操作系统级**（UIA 树、窗口、剪贴板、键鼠注入）
2. browser/desktop 是**应用级**（页面元素、应用控件）
3. 混合会让「截图」有 3 个实现（`gui.screen.capture` / `agent_browser_screenshot` / `desktop_screenshot`），
   LLM 无法判断该调哪个 —— 这正是 owner 说的「分类不清导致不知道调哪个」的病根

**必须补的静态清单**（这是硬要求，不是可选）：

```ts
// vm-capabilities/src/registry/upstream-tools.ts（新增）
export const BROWSER_TOOLS: readonly UpstreamToolSpec[] = Object.freeze([
  { id: 'browser.nav.open',      tool: 'agent_browser_open',      risk: 'L1', title: '打开网址' },
  { id: 'browser.meta.eval',     tool: 'agent_browser_eval',      risk: 'L2', title: '页面内执行 JS' },
  // …33 项
]);
export const DESKTOP_TOOLS: readonly UpstreamToolSpec[] = Object.freeze([
  { id: 'desktop.observe.snapshot', tool: 'desktop_snapshot', risk: 'L0', title: '无障碍快照' },
  { id: 'desktop.pointer.click',    tool: 'desktop_click',    risk: 'L1', title: '点击' },
  // …25 项
]);
```

**为什么必须静态、不能运行时从上游 `tools/list` 拿**：
策略判定需要 `risk`，`risk` 必须在**启动时就已知**（否则第一次调用前无法判闸）。
运行时探测意味着「第一刀砍在空气上」。

**当前 browser 的 33 项完全没有 risk 分级** —— 这是必须补的（`agent_browser_eval` 至少 L2）。

---

### 决策 D · 审批位置不动，只补覆盖面（**这条 owner 判断正确**）

**位置实测确认**：审批点在 `server.ts:1537` 的 `evaluateScoped(...)`，位于 `provider.execute()`
（`:1290`）**之前**，且 MCP 与 A2A 两通道共用（`server.ts:685` 注释明确：「MCP 与 A2A
两条路径共用同一 execute → 全覆盖」）。

**所以 owner 说「先保证位置是对的」——位置已经对了，这一项不用改。**
这是本版本唯一一个「已验证不用动」的大项。

**要补的只有覆盖面**：让 112 项都进这道闸（决策 A）。

**策略形态按 owner 指定：黑名单 + 默认放行。**

```ts
// core/src/policy/engine.ts 已是这个口径（ARCH-18 已裁）
// 「命令面只有黑名单（commandDenylist，优先级最高、命中即拒）」
```

**但「默认全放开」必须配一个最小黑名单**，否则等于无防护。我的建议（需 owner 拍板）：

| 黑名单项 | 理由 |
|---|---|
| `browser.meta.eval` 默认不可用 | 页内 JS 能绕过所有其他工具的限制，能力面最大 |
| `desktop_launch` 拒绝直启 `cmd`/`powershell`/`regedit` | 否则绕过 `appops.cli.invoke` 的注册表准入枚举 |
| `system.power.control` 的 `shutdown`/`restart` | 即使 L3 走审批，黑名单也要兜底 |
| `pathDenylist` 初始值（系统目录） | 机制已存在但**内容为空**，等于没配 |

> **诚实登记**：`CapabilityPolicy` 的全部字段都是可选的，54 条定义里几乎都没填。
> 也就是说「有黑名单机制，但黑名单是空的」。这是「默认放开」的真实含义，必须让 owner 知道。

---

### 决策 E · 删 3 类「零消费」资产

| 删 | 规模 | 删除依据（三重独立反证） |
|---|---|---|
| `core/transport/ssh-tunnel*.ts` | 690 行 | ① `establishTransport` 实际调用点仅 `client.ts:62` ② `cli.ts:buildTransport()` 恒返回 `streamable-http` ⇒ `case 'ssh-tunnel'` 永不命中 ③ `tunnel-daemon.mjs` 不 import `@winvm/core` |
| `SkillDomain` + `domains` 字段 | 4 值类型 + 10 个 SKILL.md | `domains` **全仓零读取方**（已机检钉死）；且它导致 4 个 skill 静默丢值 |
| `adapter-agent-hermes` | 488 行 | 仅出现在 `vm-service.config.json`，**无任何代码 import** |

**连带删除面**（不删会留「半条通道」的误导）：

```
core/src/index.ts:25                          export type TunnelHandle
core/src/transport/index.ts:9,16,82           import / re-export / case
contracts/src/transport.ts:12,75              kind:'ssh-tunnel' + baseUrl case
host-sdk（并入 host-plugin 后同步删）          3 处 validate 分支
adapter-host-workbuddy:133,343,371            renderConnectorEntry + 2 处判断
install-host.mjs:953,1211                     transports 声明的 kind 字面量
4 个测试文件                                   涉及 ssh-tunnel 字面量的用例
```

> ⚠ **最容易搞错的一处**：`install-host.mjs:953` 声明 `kind:'ssh-tunnel'`，
> 但 `renderConnectorEntry` 渲染成 `type:'streamableHttp'`。
> **声明说隧道，产物是 HTTP** —— 这是全仓最容易被误读的地方，也是当初「以为有隧道」的根源。
> 删除时**必须同时改声明和类型**，只改一处会让 `validate()` 报「未知 kind」。

---

### 决策 F · 部署层与 runtime 层解耦（**分两步，第二步推迟**）

**当前黏合点**（实测）：

| 黏合 | 位置 |
|---|---|
| runtime 代码直接写部署文件 | `adapter-host-workbuddy/src/index.ts:469-491, 536`（`mkdir`/`writeFile`） |
| 部署脚本手写 runtime 配置 | `install-host.mjs:1288`（绕过 Renderer 写 `~/.workbuddy/mcp.json`） |
| 部署脚本逐个列举 runtime 依赖 | `install-host.mjs:1362`（`extraFiles:[9 个文件]`） |
| `host-sdk` 独立成包但只有一个消费者 | `delivery/install-host.mjs:43` |

**裁决：本版本只做 Step 1 + Step 2，Step 3 推迟。**

```js
// Step 1（0.5d）：清单单一事实源
// delivery/host-runtime-files.mjs
export const HOST_RUNTIME_FILES = Object.freeze([...9 个文件]);
// install-host.mjs:1362 与 :1364 两处都 import 它
```

```ts
// Step 2（2d）：Renderer 契约补齐
plan(): {
  plannedFiles: PlannedFile[];           // 原样
  plannedRuntimeFiles: string[];         // 替代 extraFiles
  plannedGlobalMcpEntries: ConnectorDecl[];  // 替代手写 mcp.json
}
```

**为什么 Step 3 推迟**：把 `mkdir`/`writeFile` 从 `adapter-host-workbuddy` 移出需要重写
该包的 `install()`（约 100 行），收益是「纯函数化」，但当前已被 gate 覆盖、无并发问题。
**在「稳定发布」优先的版本里，这是收益最低的一项。**

**同时把 `host-sdk` 并入 `adapter-host-workbuddy`**（545 行进 1376 行 → 1921 行）：
`host-sdk` 只有一个消费者，且职责是「校验 NeutralPlugin + 加载 skill」——
这正是 adapter-host 该做的事。合并不增职责，只减一跳依赖和一个包。

---

## 2. 包级分解：12 → 10

| 包 | 层 | 现在 | 目标 | 变化 |
|---|---|---|---|---|
| `contracts` | L0 | 2365 | 2365 | 删 transport ssh-tunnel / SkillDomain |
| `core` | L1 | 5277 | **5166** | 删 `bridge/loader.ts`（111） |
| `mcp-framework` | L2 | 531 | 531 | 不变 |
| `a2a-framework` | L2 | 1964 | 1964 | 不变（TaskStore 是审批挂接点，不能动） |
| `vm-capabilities` | L3 | 1294 | **~1650** | **+58 项上游工具表** |
| `vm-service` | L4 | 7012 | **~7300** | **+ gateway.ts 统一闸** |
| `adapter-host-workbuddy` | L5 | 1376 | **1921** | **+ 并入 host-sdk 545** |
| `host-a2a-bridge` | L5 | 1570 | 1570 | 不变 |
| `adapter-agent-workbuddy` | L6 | 1371 | 1371 | 不变（执行器本体） |
| `adapter-agent-workbuddy-llm` | L6 | 4338 | 4338 | **改为 planner，不再实现 provider** |
| ~~`host-sdk`~~ | — | ~~545~~ | **0** | **并入 adapter-host-workbuddy** |
| ~~`adapter-agent-hermes`~~ | — | ~~488~~ | **0** | **删除** |

**总行数：28131 → 约 28166**（几乎不变）。**包数：12 → 10。**

> **这就是「简单」的真实含义**：不是行数变少，是**概念变少**。
> 执行路径 3→1，provider 3→1，传输 3→2，域模型 2→1，包 12→10。

---

## 3. 我对 owner 建议的采纳与修正

| owner 建议 | 我的处理 | 理由 |
|---|---|---|
| 五组件：plugin + tunnel + service(mcp+a2a) + mcp/a2a service + cli | **采纳** | 与代码事实完全吻合，无需改动骨架 |
| 扔掉没用的通道 | **采纳，但要澄清** | `core/transport/ssh-tunnel` 是死代码，删；但 `delivery/oh-tunnel.mjs` 是**唯一真实隧道**，必须保留（owner 说的 "tunnel" 组件就是它） |
| 领域先不要了 | **采纳，且理由比原判更强** | `domain` 是 `id.split('.')[0]` 的**派生值**，不是字段。`SkillDomain` 是同一事实的第二份拷贝，已漂移成 4 vs 6 |
| 能力分类维度清晰统一 | **采纳，落成 112 项一张表 + surface 维度** | 并提出 browser/desktop 应与 gui **平级**，不能做成 gui 子域 |
| 审批 cover 所有通道，位置先对 | **采纳** | 实测位置已对（`server.ts:1537` 在 execute 之前，双通道共用），**唯一要补的是上游 58 项的覆盖面** |
| 黑名单策略，默认放开 | **采纳，但要求配最小黑名单** | 当前 `CapabilityPolicy` 全字段可选且内容为空 ⇒「默认放开」实际是「无防护」。至少 4 条必须配 |
| 部署不要和 runtime 黏合 | **部分采纳，分两步** | Step 1/2 本版本做（清单单一源 + Renderer 契约），Step 3（`install()` 纯函数化）推迟 |
| 不要顾及扩展（host/VM agent 类型都选 workbuddy） | **采纳，但方向修正** | 不是「删掉 LLM」，而是「**LLM 从 provider 降级为 runGoal 的 planner**」。因为 `execute()` 本来就不走 LLM，把它当成 provider 是抽象层级错误 |

**我新增的 2 件事**（owner 未提及）：

1. **上游 33 个 browser 工具零 risk 分级** —— 必须补静态清单，否则无法进闸（决策 C）
2. **`host-sdk` 并入 `adapter-host-workbuddy`** —— 单消费者包不该独立存在（决策 F）

---

## 4. 执行顺序（依赖是硬的，不能并行）

```
阶段 0  基线（0.5d）
  └─ 跑 verify-claims.mjs + gate --quick，存档当前值

阶段 1  删除（3d，纯减法，行为零变化）
  ├─ 删 ssh-tunnel（8 处 + 4 测试文件）
  ├─ 删 SkillDomain/domains（10 个 SKILL.md + 2 处类型）
  ├─ 删 adapter-agent-hermes（488 行 + config 段）
  └─ 验收：gate --quick 全绿 + 真机 VERIFY=PASS

阶段 2  统一（5d，核心）
  ├─ 112 项能力表 + surface 维度 + 58 项静态清单（含 risk）
  ├─ meta.capability.list 返回 112 项（让宿主运行时拿到路由表）
  └─ 验收：node -e 读注册表 count === 112

阶段 3  闸门（4d，安全核心）
  ├─ gateway.ts 抽出 gateAndExecute
  ├─ 三个入口全部改调它
  ├─ 上游执行补审计（当前零审计）
  └─ 验收：sed -n '2240,2280p' server.ts | grep -c audit  ≥ 1

阶段 4  降级 provider（4d）
  ├─ llm 包从 provider 改造成 planner
  ├─ 删 core/bridge/loader.ts + 配置改 planner 枚举
  └─ 验收：配置只剩一个 planner 字段；runGoal 两条路径都可跑

阶段 5  解耦 + 发布（3d）
  ├─ HOST_RUNTIME_FILES 单一源
  ├─ Renderer 契约补齐
  ├─ 并入 host-sdk
  └─ 验收：gate 全绿 + selfcheck ALL_GREEN + 真机 DEPLOY/VERIFY PASS + 探针 34→112
```

**总工期约 19-20 天。**

**硬依赖链**（不能违反）：

```
阶段1 → 阶段2    删除后才能建 112 项表（留着 SkillDomain 4 值会无处安放）
阶段2 → 阶段3    闸门要查表拿 risk，表没建好无从查
阶段3 → 阶段4    先把闸统一，再改 provider（否则改完 provider 闸又要改一遍）
阶段4 → 阶段5    最后做纯结构解耦
```

---

## 5. 「简单 + 有效 + 健壮 + 强大」如何被满足

| 目标 | 具体兑现 | 可验证判据 |
|---|---|---|
| **简单** | 执行路径 3→1、provider 3→1、传输 3→2、域模型 2→1、包 12→10 | `grep -rn "ssh-tunnel" packages/*/src/` = 0；配置 provider 段只剩 `planner` 一枚举 |
| **有效** | 112 项一张表，WorkBuddy 拿到任务即可按 `surface`+`domain` 定位端点 | `meta.capability.list` 返回 count=112 且带 surface |
| **健壮** | **58 个原本裸奔的工具全部进闸**；两条执行路径都写审计链 | 上游分支内 `grep -c audit` ≥ 1；黑名单 4 条有值 |
| **强大** | 保留 LLM `runGoal`（开放任务）+ A2A（长任务/审批往返）+ 三面 112 项 | 真机探针 34→112 全通 |

> **取舍声明**：如果工期必须压缩到 10 天以内，**砍阶段 4 和 5**，只做 1/2/3。
> 因为阶段 1-3 交付的是「安全 + 分类」，阶段 4-5 交付的是「抽象更干净」——
> 前者影响能否发布，后者只影响后续维护成本。

---

## 6. 本架构明确不做的事

| 不做 | 理由 |
|---|---|
| 把 4 个连接器合并成 1 个 | 112 个工具 schema 会撑爆宿主 LLM 上下文；按端点分 surface 正是天然的按需加载 |
| 把 A2A 的 5 个工具挂到 `/mcp` 上 | 需要把 A2A 的进度流映射成 MCP SSE，风险 > 收益。`host-a2a-bridge` 职责清晰，保留 |
| 删掉 LLM planner | `runGoal` 需要它；删了 A2A 就退化成「走两跳的 execute」 |
| 做完整的域路由引擎 | `domain` 是派生值，路由按 ID 前缀即可，不需要引擎 |
| 引入 Pester / yaml 包 / 把 delivery 改 TS | 见 `05-OPTIMIZATION-PLAN.md` §5，成本收益比都不成立 |
| `install()` 纯函数化（Step 3） | 收益最低，推迟到 V+1 |

---

## 7. 与既有文档的关系

| 文档 | 状态 |
|---|---|
| `04-FINDINGS.md` | **仍有效**。执行本架构后，F-01/F-02/F-05/F-07 应标记「已通过删除/统一解决」 |
| `05-OPTIMIZATION-PLAN.md` | **部分被取代**。B-1（域模型改 6 值）被决策 E 否决（直接删）；其余仍可参考 |
| `10-VNEXT-SCOPE-DECISION.md` | **被本文取代架构部分**。其 §0 的 owner 原话映射表仍有史料价值 |
| `02-design/ARCHITECTURE.md` | **必须回灌**。D-1/D-2/D-3 完成后，「三种传输 + 4 值域 + 54 能力」全部过期 |
| `02-design/CAPABILITY-MODEL.md` | **必须大改**：54 → 112 |

> **纪律**：架构定稿后，`04-FINDINGS.md` 的对应条目要改成「已解决（方式：删除/统一）」，
> 不要留三份互相矛盾的文档给下一个人。