# V-NEXT 架构决策：收缩为「清晰、健壮、可发布」的稳定版

> **本文是下一版本的架构基线，不是建议。**
> 定位：`04-FINDINGS.md` 记录的是「现状有什么问题」，`05-OPTIMIZATION-PLAN.md` 给的是「怎么渐进改善」，
> **本文给的是「下一版本砍掉什么、保留什么、必须做对什么」**——三者的关系是**目的不同，不互相替代**。
>
> 决策来源：owner 2026-11-23 明确指令（原文见 §0）。
> 约束：不做大而全。凡是「当前没用」的维度，下一版本**删除**而不是保留待用。

---

## 0. Owner 原始指令与本文的对应关系

| # | 原话 | 本文落点 |
|---|---|---|
| 1 | 下一版本要**架构清晰、简单健壮、可在线发布的稳定版**，不要大而全 | §1 收缩总纲（含删减清单） |
| 2 | **既然有通道没用，就在下一版本扔掉**；在用通道确保健壮可靠 | §2 通道收敛（D-1） |
| 3 | **既然领域当前没用，下一版本先不要领域** | §3 领域移除（D-2） |
| 4 | 但要确保**能力分类维度清晰统一** | §4 统一分类（D-3） |
| 5 | **agent-browser / agent-desktop 要与之前 54 个能力统一分类**，让 WorkBuddy 拿到任务时能明确加载调用哪个 mcp-tools | §5 三面合一（D-4） |
| 6 | **审批要 cover 所有通道和能力**；先保证位置对；**当前无 policy 就全放开**，但必须都经过审批点；**当前版本黑名单策略，默认放开** | §6 审批全通道（D-5） |
| 7 | 先确保 host plugin 与 vm service 正常工作；**安装部署是另一层面，不要和 runtime 层及 runtime 配置层黏合** | §7 层间解耦（D-6） |

---

## 1. 收缩总纲

### 1.1 一句话定义「下一版本」

> **一条通道、一张能力表、一个审批点、两层分离。**
> 54 个 VM 能力 + 33 个浏览器工具 + 25 个桌面工具 = **一张 112 项的统一能力表**，全部经同一个审批点，全部按同一套域分类。

### 1.2 删减清单（这是「不做什么」的清单）

| 删 | 当前实测规模 | 理由 |
|---|---|---|
| `core/src/transport/ssh-tunnel.ts` + `ssh-tunnel-ssh2.ts` | 690 行 | **交付链零调用**（唯一调用点 `client.ts:62` 走的分支恒不命中） |
| `SkillDomain` 类型 + `domains` 字段 | 4 值类型 + 10 skill frontmatter | 全仓**零读取方**，且是 4-value/6-value 双轨的病灶 |
| `TransportKind` 的 `ssh-tunnel` 分支 | contracts 1 类型 + 3 处 switch | 与上面同源，声明面残留会导致「读代码以为有隧道」 |
| `WINVM_DELEGATION_REQUIRED_POLICY` 灰度开关 | 1 个 env + 双分支 | 灰度期已过，双分支是永久的认知税 |

**保留但要修的**：`delivery/oh-tunnel.mjs`（唯一真实隧道，**不动**）、`adapter-host-workbuddy`（只做渲染，不碰部署）、`VmApprovalCoordinator`（位置正确，只需扩覆盖面）。

### 1.3 三条验收红线（版本级，不是批次级）

```
1. 单通道：grep -rn "ssh-tunnel" packages/*/src/ ⇒ 0 命中
2. 零领域：grep -rn "SkillDomain\|domains" packages/*/src/ ⇒ 仅统一能力表内部使用
3. 审批全覆盖：3 个 MCP 入口 × 每条工具 ⇒ 100% 经过同一个 evaluate 点
```

---

## 2. D-1 · 通道收敛：删掉没用的，锁死在用的

### 2.1 事实（实证，非推断）

| 通道 | 声明处 | 实际是否执行 | 判定 |
|---|---|---|---|
| `core/transport/ssh-tunnel.ts` | `contracts/transport.ts:12` | **否** | **删除** |
| `delivery/oh-tunnel.mjs` + `tunnel-daemon.mjs` | 部署脚本内联 | **是**（常驻 daemon） | 保留并加固 |
| `streamable-http` | `cli.ts:buildTransport()` 恒返回 | **是**（当前唯一活路） | 保留 |
| `stdio` | a2a-bridge connector | **是** | 保留 |

**死代码判定依据**（三重独立证据）：

```
① establishTransport 全仓实际调用点 = 1 处（host-a2a-bridge/src/client.ts:62）
② cli.ts:buildTransport() 恒返回 kind:'streamable-http' ⇒ switch 的 case 'ssh-tunnel' 永不命中
③ delivery/tunnel-daemon.mjs 完全不 import @winvm/core（已 grep 确认）
```

**必须一起删的连带面**（不删会留下「半条通道」的误导）：

```
packages/core/src/index.ts:25              export type { TunnelHandle, EstablishTunnelOptions }
packages/core/src/transport/index.ts:9,16,82   import / re-export / case 分支
packages/core/src/transport/types.ts:4     "三种传输" 注释
packages/contracts/src/transport.ts:12,75  kind:'ssh-tunnel' + transportBaseUrl case
packages/host-sdk/src/index.ts:60,95,126   三处 validate 分支（host/user 必填校验）
packages/adapter-host-workbuddy/src/index.ts:133,343,371  renderConnectorEntry + 两处判断
delivery/install-host.mjs:953,1211         transports 声明的 kind 字面量
```

> ⚠ **关键陷阱**：`install-host.mjs:953` 把 `kind:'ssh-tunnel'` 写在**声明里**，而 `renderConnectorEntry` 渲染成 `type:'streamableHttp'`。这是全仓最容易误读的一处——**声明说的是隧道，产物是 HTTP**。
> 删除时的正确做法：把声明的 kind 一并改成 `streamable-http`，**不要只删类型不删声明**，否则 `validate()` 会报「未知 kind」。

### 2.2 删除后的正确形态

```ts
// contracts/src/transport.ts —— 删干净后的形状
export interface HttpTransportDecl {
  readonly kind: 'streamable-http';
  readonly url: string;
  readonly tokenEnv?: string;
}
export interface StdioTransportDecl {
  readonly kind: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
}
export type TransportDecl = HttpTransportDecl | StdioTransportDecl;
```

**为什么可以安全删**（反证已做）：

- 有单测覆盖 ≠ 有生产调用 —— 单测测的是**死代码自身的行为**，删的时候要连单测一起删（`phase1-t5-token-env.test.js`、`phase1-t5-cancel-consume.test.js:512`、`host-adapter.test.js:61`、`mcp-upstream-connectors.test.js:23` 四处涉及 ssh-tunnel 字面量）
- `dep-lint` 绿 ≠ 被使用 —— `dep-lint` 只校验**包级**依赖边，包内死代码它看不见（644 个导出符号里它管不到任何一个）

### 2.3 在用通道的健壮性要求（不是「能用就行」）

| 通道 | 必须固化的健壮性 |
|---|---|
| `oh-tunnel` | ① 断线重连退避上限（当前 2s→30s）② daemon 崩溃后由谁拉起 ③ 端口占用时的明确报错（不能静默换端口） |
| `streamable-http` | ① 客户端断连 → `AbortSignal` 传播（已有 `watchClientDisconnect`）② 单请求超时与上游 `timeoutMs` 分层 |
| `stdio`（a2a-bridge） | ① 子进程崩溃 → 退出码透传 ② stdout 污染防护（只能出 JSON） |

---

## 3. D-2 · 领域移除：不是「改成 6 值」，是「不要这个维度」

### 3.1 为什么 owen 的判断是对的

`05-OPTIMIZATION-PLAN.md` 的 `B-1` 建议「统一为 6 值 + 给消费点」。但 owner 说「当前没用就别要了」——**这更彻底也更有依据**：

```
实证：domains 全仓零读取方（verify-claims.mjs F-02c 已钉死）
```

一个**零消费 + 双轨定义 + 静默丢值**的字段，加消费点是**给负资产投资**。正确做法是删。

**且删掉能顺带消灭 4 个 skill 的静默失败**——问题不是「值被判非法」，而是「这个字段根本不该存在」：

| skill | 当前 domains | 故障形态 |
|---|---|---|
| `hos-win-skill` | `[meta]` | 变为 `undefined`（整段被过滤） |
| `winvm-mcp-reference` | `[meta]` | 变为 `undefined` |
| `winvm-app-operation` | `[appops]` | 变为 `undefined` |
| `winvm-orchestrator` | `[system,app,storage,gui,appops]` | **非空但静默少一项**（最隐蔽） |

> **删字段后这 4 条全部消失**——因为不再有「合法值集合」这个判据。这是删比改更强的证据。

### 3.2 改动清单

```
packages/contracts/src/host.ts:20       删除 type SkillDomain
packages/contracts/src/host.ts:34       删除 domains?: readonly SkillDomain[]
packages/host-sdk/src/skill-loader.ts   删除 VALID_DOMAINS + 过滤逻辑（约 128 行处的 if）
skills/*/SKILL.md                       删除 10 个文件的 domains: 行
```

### 3.3 领域没了，靠什么保证「能力分类清晰统一」

**靠能力 ID 的命名层级**，这是唯一事实源，且**已存在**：

```ts
// packages/vm-capabilities/src/registry/definitions.ts:75
const domain = spec.id.split('.')[0];   // ← domain 本来就是从 id 派生，不是独立字段
```

这句话是本次决策的**最关键发现**：`CapabilityDefinition.domain` **不是存储字段，是派生值**。
所以「能力分类」从来不需要额外声明——`system.service.control` 的第一个点之前就是分类。

> 推论：**skill 的 domains 是能力的域集合的冗余投影**。删掉它，让 skill 只描述「怎么做」（工作流），能力表描述「有什么」（分类）。职责就此分离。

---

## 4. D-3 · 统一分类：一张表覆盖 112 项

### 4.1 目标形状

```ts
// 唯一能力分类事实源（★ 已实施后的真实形状；本节的 domain/summary 两处为初稿笔误，见下注）
interface CapabilityEntry {
  readonly id: string;          // 全局唯一，形如 'system.service.control'
  readonly surface: Surface;    // 'vm' | 'browser' | 'desktop'  ← 新增：来自哪个工具面
  readonly risk: RiskLevel;
  readonly title: string;
  readonly tool?: string;       // 上游真实工具名；仅当 ≠ id 时出现
}
```

> **初稿两处笔误，实施时已修正**（详见 `11-ARCHITECTURE-VNEXT.md` 同节注与 `14-EXECUTION-PLAN.md` Step 2.2）：
> ① `readonly domain` **不存在** —— 派生值不该有字段，改用 `deriveDomain(id)` 现算，物理上不可能漂移；
> ② `summary` **不存在** —— 与 `title` 语义重叠，112 条里维护两份短描述只会互相漂移。

**`surface` 是本次唯一新增的维度**，它解决 owner 提的核心问题：

> 「确保 workbuddy 拿到一个任务时，能通过清晰能力分类明确对哪个 mcp-tools 的加载和调用」

### 4.2 三面合一的分类映射（这就是 WorkBuddy 的路由表）

| domain | vm 能力（54） | browser（33） | desktop（25） | 合计 |
|---|---|---|---|---|
| `meta` | 3 | — | — | 3 |
| `system` | 14 | — | — | 14 |
| `app` | 8 | — | — | 8 |
| `storage` | 13 | — | — | 13 |
| `gui` | 11 | — | — | 11 |
| `appops` | 5 | — | — | 5 |
| **`browser`** | — | 33 | — | **33** |
| **`desktop`** | — | — | 25 | **25** |
| **合计** | **54** | **33** | **25** | **112** |

**分类设计原则（关键决策）**：browser / desktop **不作为 `gui` 的子域**，而是**平级的一级分类**。

理由：
1. `gui` 的 11 个能力是**操作系统级**（UIA 树、窗口、剪贴板、键鼠），browser/desktop 是**应用级**（页面元素、应用控件）
2. 混在 `gui` 下会让「截图」有 3 个实现（`gui.screen.capture` / `agent_browser_screenshot` / `desktop_screenshot`），WorkBuddy 无法判断该调哪个
3. 平级后选择规则清晰：**要看整个屏幕选 `gui`，要在网页里选 `browser`，要在 Windows 应用里选 `desktop`**

### 4.3 browser 33 个工具的分类（按场景闭环）

```
browser.nav      (8)  open / close / reload / back / forward / tab_new / tab_switch / tab_close
browser.observe  (7)  read / snapshot / get_text / get_title / get_url / tab_list / screenshot
browser.act      (6)  click / fill / select / check / uncheck / type
browser.wait     (4)  wait_for_load / wait_for_selector / wait_for_text / wait_ms
browser.scroll   (2)  scroll / press
browser.flow     (4)  flow_list / flow_run / flow_save / flow_steps
browser.meta     (2)  eval / tools_profiles
```

> 注意：`browser.meta` 里的 `eval`（页面内跑 JS）是**能力面最大**的一个——它能绕过所有其他 tool 的限制。风险必须标 `L2`，不能因为「它在 browser 面」就默认放开。

### 4.4 desktop 25 个工具的分类

```
desktop.observe  (5)  snapshot / find / screenshot / list_apps / list_windows
desktop.window   (4)  launch / focus_window / maximize / resize_window
desktop.pointer  (6)  click / double_click / right_click / hover / scroll / scroll_to
desktop.input    (7)  type / set_value / press / check / uncheck / select / toggle
desktop.verify   (3)  get / is / wait
```

### 4.5 WorkBuddy 的路由判据（可执行）

```
任务描述 → 按此顺序判定 ↓

1. 涉及「网页 / URL / 页面元素 / 登录网站」        → surface=browser
2. 涉及「某个 Windows 应用的界面 / 窗口 / 控件」    → surface=desktop
3. 涉及「文件 / 目录 / 磁盘 / 压缩」                → domain=storage, surface=vm
4. 涉及「服务 / 进程 / 注册表 / 计划任务 / 电源」   → domain=system, surface=vm
5. 涉及「安装 / 卸载 / 快捷方式 / winget」          → domain=app, surface=vm
6. 涉及「整屏截图 / 剪贴板 / 键鼠注入 / UIA」       → domain=gui, surface=vm
7. 涉及「多步应用生产流程 / CLI / COM」             → domain=appops, surface=vm
8. 涉及「本服务自身健康 / 能力清单」                → domain=meta, surface=vm
```

**这张表的价值**：它不是文档，是**可以做成 `meta.capability.list` 的返回值**——让 WorkBuddy 在运行时拿到，而不是靠读 SKILL.md 记住。

### 4.6 必须改的实现点

| 位置 | 改什么 |
|---|---|
| `mcp-upstream.ts:62` | `DEFAULT_DESKTOP_TOOL_ALLOWLIST` 保持 25，但**每项补 `risk` 与 `domain`** |
| `mcp-upstream.ts` | 新增 `BROWSER_TOOL_MANIFEST`（33 项，含 risk；当前 browser **全量暴露无风险分级**） |
| `server.ts:2097` | `tools.map()` 透传时**注入 `annotations`**，把 domain/risk 带给宿主 |
| `meta.capability.list` | 返回 `{capabilities, count, domains}` 扩为三面合计 112 |

---

## 5. D-4 · 审批全覆盖：位置对，覆盖面要补齐

### 5.1 好消息：位置本来就对

**实测确认**：审批点位于 `server.ts:1537`（`evaluateScoped(cap, rest, approved, approvalId, segScope, traceId)`），在 **`provider.execute` 之前**，且 **MCP 与 A2A 两条通道共用**：

```
server.ts:1290   const res = await provider.execute({...})
                 ↑ 唯一执行点
server.ts:685    "MCP 与 A2A 两条路径共用同一 execute → 全覆盖"
```

所以 owner 说的「先保证位置是对的」—— **位置已经对了，不用动**。这是本版本唯一一个「不用改」的大项。

### 5.2 坏消息：覆盖面有 1 个大洞

**实测证据**：`server.ts:2245` 的上游代理分支

```ts
// ---- MCP 上游代理（纯附加）：POST /mcp/browser、POST /mcp/desktop ----
const upstreamId = path.startsWith('/mcp/') ? path.slice('/mcp/'.length) : '';
if (upstreamId && req.method === 'POST') {
  const upstreamServer = await upstreamMcp(upstreamId);
  const result = await upstreamServer.handleRequest(...)   // ← 直接执行
```

在 `packages/vm-service/src/mcp-upstream.ts`（318 行）里搜索 `policy|audit|approval|capability`：

```
命中数 = 0
```

**结论**：`/mcp/browser` 的 33 个工具 + `/mcp/desktop` 的 25 个工具，**完全绕过策略、审批、审计三链**。
这 58 个工具里包含 `desktop_click`（能点任何窗口）、`agent_browser_eval`（能跑任意 JS）、`desktop_type`（能向任何输入框打字）。

**这不是「policy 缺失」，是「执行路径绕过了闸门」**——`policy` 缺失可以让默认放开，绕过闸门没有任何兜底。

### 5.3 修法：把上游工具纳入同一张能力表 + 同一个审批点

```
当前：  /mcp         → 54 能力 → evaluateScoped → provider.execute → audit
        /mcp/browser → 33 工具 → ✗ 直接 handleRequest → ✗ 零审计
        /mcp/desktop → 25 工具 → ✗ 直接 handleRequest → ✗ 零审计

目标：  三个入口全部 → 合成 112 项统一能力表 → 同一 evaluateScoped → 同一 audit
```

**实现要点**（按 owner「先保证位置对」的原则，只做结构性统一，不引入新策略）：

```ts
// 1. 上游工具在 tools/list 时已存在，只需在建表时也注册成 CapabilityDefinition
//    id 取 `browser.act.click` / `desktop.input.type` 这样，天然被 domain 派生覆盖

// 2. 路由分支改成：先查统一能力表 → 过闸 → 再分发
if (upstreamId && req.method === 'POST') {
  // 在 handleRequest 之前插入与 /mcp 完全相同的闸
  const call = parseToolCall(req);              // 取出 tool name + args
  const cap = unifiedRegistry.get(`browser.${...}.${call.name}`);
  const verdict = evaluateScoped(cap, call.args, ...);   // ← 与 54 能力同一个函数
  if (!verdict.allowed) return sendDenied(res, verdict);
  // 审计在 provider 外层，此处需补一条（上游无 provider）
}
```

### 5.4 策略形态：黑名单 + 默认放开（owner 明确指定）

**当前版本采取「黑名单策略，默认都放开」**——这正是 `02-design` 里 ARCH-18 已定的口径，且已在 `capability.ts:41-43` 写明：

> 「命令面**只有黑名单**（`commandDenylist`，优先级最高、命中即拒）；解释器/脚本准入由**注册表枚举 + 登记期静态校验**把守」

所以**策略引擎不需要改**，需要改的是「让 112 项都进这个引擎」。

**黑名单的最小初始内容**（本版本必须有，否则默认放开=全开）：

| 黑名单项 | 理由 |
|---|---|
| `desktop_launch` 的系统级 exe（`regedit`/`cmd`/`powershell` 直启） | 绕过 appops.cli.invoke 的准入枚举 |
| `agent_browser_eval` 在非当前页面执行 | 页面内 JS 是最大能力面，默认放开会失去审批意义 |
| `system.power.control` 的 `shutdown`/`restart` 动作 | 已是 L3，本就走审批，但黑名单要在 L0/L1 也拦 |
| 路径黑名单（`C:\Windows\System32\config`、`/etc/shadow` 类比） | 已有 `pathDenylist` 机制，需填入初始值 |

> **诚实登记**：以上 4 条是「建议初始值」，需 owner 拍板。当前仓库里 `pathDenylist` 等字段**有机制无内容**（`CapabilityPolicy` 全可选，54 条定义里几乎都未填）。

### 5.5 审批覆盖面验收判据

```bash
# ① 三个入口必须都过闸（结构性断言）
grep -c "evaluateScoped" packages/vm-service/src/server.ts
# 期望：>= 2（/mcp 一处 + 上游一处）

# ② 上游分支内必须出现审计调用
sed -n '2240,2280p' packages/vm-service/src/server.ts | grep -c "audit"
# 期望：>= 1

# ③ 统一能力表规模
node -e "const{meta}=..." # meta.capability.list 返回 count === 112
```

---

## 6. D-5 · 层间解耦：部署层 / runtime 层 / runtime 配置层

### 6.1 当前黏合点（实测）

| 黏合 | 位置 | 症状 |
|---|---|---|
| **runtime 代码直接写部署文件** | `adapter-host-workbuddy/src/index.ts:469-491, 536` | `plan()`/`install()` 里 `mkdir`/`writeFile` |
| **部署脚本手写 runtime 配置** | `delivery/install-host.mjs:1288` | 绕过 Renderer 直接写 `~/.workbuddy/mcp.json` |
| **部署脚本拷 runtime 依赖** | `install-host.mjs:1362` `extraFiles:[...]` | 9 个运行时 .mjs 由部署脚本逐个列举 |
| **Renderer 契约被两处绕过** | 上面两条合计 | `plan()` 不是「唯一产物事实源」 |

### 6.2 目标分层（三层的边界）

```
┌─────────────────────────────────────────────────────────┐
│ L3  部署层（delivery/*.mjs）                             │
│     职责：把包搬到机器上、起进程、配连接                   │
│     禁止：知道任何 runtime 内部结构（能力表/策略/审批）    │
│     输入：包 + 目标路径 + 连接参数                        │
│     输出：文件落位 + 进程 + 连接器条目                    │
├─────────────────────────────────────────────────────────┤
│ L2  runtime 配置层（vm-service.config.json / 环境变量）   │
│     职责：告诉 runtime「怎么跑」（端口/上游开闭/策略开关）  │
│     禁止：包含部署知识（路径、SSH 凭据、安装顺序）         │
├─────────────────────────────────────────────────────────┤
│ L1  runtime 层（vm-service / adapter-* / skills）        │
│     职责：能力执行、策略、审批、审计                      │
│     禁止：做任何文件系统安装动作                           │
└─────────────────────────────────────────────────────────┘
```

### 6.3 具体改动（按成本从低到高）

**Step 1（低成本，可先做）**：runtime 文件清单单一事实源

```js
// delivery/host-runtime-files.mjs（新建）
export const HOST_RUNTIME_FILES = Object.freeze([
  'winvm-plugin.mjs', 'oh-tunnel.mjs', 'ssh2-resolve.mjs', 'ssh2-client.mjs',
  'ssh2-backend.mjs', 'tunnel-daemon.mjs',
  'hooks/hooks.json', 'hooks/session-start.sh', 'account-resolve.mjs',
]);
```

`install-host.mjs:1362` 与 `:1364` 两处 `extraFiles` 都 import 它。**消灭「两处列举不同步」的经典 bug**。

**Step 2（中成本）**：Renderer 契约收口

`adapter-host-workbuddy` 的 `plan()` 返回值扩展为「声称的产物全集」，包含：
- `plannedFiles[]`（原样保留）
- `plannedRuntimeFiles[]`（新：替代 `extraFiles`）
- `plannedGlobalMcpEntries[]`（新：替代 `install-host:1288` 手写）

**Step 3（高成本，可推迟到 V+1）**：把 `mkdir`/`writeFile` 从 `adapter-host-workbuddy` 移出

当前 `adapter-host-workbuddy/src/index.ts` 的 `install()` 直接写文件。正确形态是 `plan()` 只**返回**产物，由部署层（`install-host.mjs`）执行写入。

> **本版本可接受 Step 1 + Step 2，Step 3 推迟**。理由：Step 3 需要重写 555 行的 `index.ts`，收益是「纯函数化」，但当前 `install()` 已被 `gate` 覆盖、且无并发问题。**先把清单统一、契约补齐，纯函数化留到有独立时间窗时做。**

### 6.4 解耦验收判据

```bash
# Step 1
grep -c "HOST_RUNTIME_FILES" delivery/install-host.mjs   # >= 2（import + 使用）

# Step 2
node delivery/install-host.mjs --dry-run 2>&1 | grep -c "全局 mcp.json"
# 期望 >= 1（dry-run 声称会写它）

# 层间隔离（期望 0 命中）
grep -rn "capability\|policy\|approval" delivery/*.mjs | grep -v "config.json" | grep -v "^\s*\*"
```

---

## 7. 版本级执行顺序

```
阶段 0（0.5d）  基线固化
  └─ 跑 verify-claims.mjs + gate.mjs --quick，记录当前值作为对照

阶段 1（3-4d）  删除（纯减法，行为不变）
  ├─ D-1 删 ssh-tunnel（连带 8 处 + 4 个测试文件）
  ├─ D-2 删 SkillDomain/domains（连带 10 个 SKILL.md）
  └─ 删 WINVM_DELEGATION_REQUIRED_POLICY 灰度开关
  └─ 判据：gate --quick 全绿 + 真机 VERIFY=PASS

阶段 2（4-5d）  统一（核心工作）
  ├─ D-3 三面合一：112 项统一能力表 + surface 维度
  ├─ 补 browser 33 项的 risk 分级（当前零分级）
  └─ meta.capability.list 返回 112 项

阶段 3（3-4d）  审批覆盖
  ├─ D-4 上游分支插入统一闸（复刻 /mcp 的 evaluateScoped）
  ├─ 上游工具执行补审计记录
  └─ 黑名单初始 4 条（需 owner 拍板）

阶段 4（2d）    解耦
  ├─ D-5 Step1 清单单一源
  └─ D-5 Step2 Renderer 契约补齐

阶段 5（2d）    发布验证
  ├─ gate 全绿 + selfcheck ALL_GREEN
  ├─ 真机 DEPLOY/VERIFY 全 PASS
  └─ 探针从 34 → 112（三面全量）
```

**总工期约 14-17 天**。比 `05-OPTIMIZATION-PLAN.md` 的三批（14-22d）短，且**交付物更清晰**——因为删掉了「修 F-01/F-02」这类会留下半成品的渐进工作。

### 关键排序理由

| 顺序 | 为什么必须是这个顺序 |
|---|---|
| **删除先于统一** | 统一 112 项时若还留着 `SkillDomain` 的 4 值，会出现「112 项怎么映射到 4 域」的死路 |
| **统一先于审批** | 审批闸需要「查能力表拿到 risk」，112 项没建表就无从查 |
| **审批先于解耦** | 解耦要改 `plan()` 返回结构，若审批改动同时进行会冲突 |
| **解耦最后** | 它是唯一「不影响 runtime 行为」的改动，最安全，可以最后做 |

---

## 8. 与既有文档的关系（避免读者困惑）

| 文档 | 关系 |
|---|---|
| `04-FINDINGS.md` | **问题清单，仍然有效**。但其中 F-02（域模型双轨）、F-12（dep-lint 噪音）在本文方案下**不再是「要修的问题」，而是「要删的东西」** |
| `05-OPTIMIZATION-PLAN.md` | **渐进路线，与本方案部分冲突**。冲突时以本文为准，因为本文是 owner 的版本级决策；`A-1/A-3/A-4` 三条止血仍然值得做（成本极低） |
| `02-design/ARCHITECTURE.md` | **设计意图，需回灌**。D-1/D-2/D-3 完成后必须更新它，否则它记录的「三种传输 + 4 值域」会继续误导 |
| `02-design/CAPABILITY-MODEL.md` | **需大改**。从「54 个能力」改为「112 项统一能力表」 |

> **纪律**：本方案执行完毕后，`04-FINDINGS.md` 里 F-01/F-02 应标记为「已通过删除解决」，`05-OPTIMIZATION-PLAN.md` 的 B-1/B-5 应标记为「已被 V-NEXT 取代」。**不要留三份互相矛盾的文档。**

---

## 9. 本方案明确不做的（再次收缩）

| 不做 | 理由 |
|---|---|
| 域路由引擎（按 domains 自动加载 skill） | 领域都要删了，不存在「按域路由」 |
| skill 与能力的自动关联 | 统一能力表 + surface 已经足够让 LLM 判断，再挂一层是过度设计 |
| policy 规则的版本化 / 热更新 | 黑名单 4 条硬编码即可，本版本不需要动态策略 |
| 上游工具的独立审批流 | 复用同一个闸，不建第二套 |
| 部署的幂等性重构 | D-5 Step 3 已推迟，本版本只做清单统一 |
| `/health` 9 区块精简 | 不在本次范围，但它确实偏大（可列为 V+1 候选） |