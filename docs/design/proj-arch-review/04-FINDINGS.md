# 架构问题清单与优化建议（F-01 ~ F-14）

> 每条含：**现象** / **证据**（可复现）/ **影响** / **建议** / **优先级**
> 优先级定义：
> - **P0** = 会导致误判或功能失效，应尽快处理
> - **P1** = 显著增加维护成本或认知负担，本季度内处理
> - **P2** = 改善性，有空再做

---

## 索引

| # | 标题 | 类型 | 优先级 |
|---|---|---|---|
| F-01 | `core/transport/ssh-tunnel*.ts` 690 行在交付链上是死代码 | 死代码 / 双实现 | **P0** |
| F-02 | `SkillDomain`(4) vs `CapabilityDomain`(6) 双轨，`domains` 全仓零消费 | 契约缺陷 | **P0** |
| F-03 | `createService` 单函数 2185 行，压了五类职责 | 结构 | **P1** |
| F-04 | `HostRenderer` 四方法契约被两处绕过 | 契约缺陷 | **P1** |
| F-05 | `fillApprovalCard()` 生产零调用点，审批卡靠提示词 | 安全 / 接线 | **P0** |
| F-06 | 直调命中 L2/L3 不产生 approvalId，续跑令牌成遗留支路 | 双通道语义不对称 | **P1** |
| F-07 | `delivery/` 16059 行几乎在门禁外（仅 3 个测试文件），且与 packages 同职责双实现 | 门禁盲区 | **P1** |
| F-08 | 七个文件超过 1000 行（最大 2839） | 结构 | **P1** |
| F-09 | 文档数字漂移（**5 处**：skills 6/8→10、desktop 白名单 10→25） | 文档 | **P1** |
| F-10 | PowerShell 3522 行零单测，正确性只靠真机 | 测试盲区 | **P1** |
| F-11 | `adapter-agent-hermes` 同层依赖 `workbuddy`，无法独立部署 | 依赖 | **P2** |
| F-12 | `dep-lint` 的 `DECLARED_UNUSED` 无法区分 type-only / 动态加载 | 门禁精度 | **P2** |
| F-13 | A2A 协议类型与内部状态机各有一套 `TaskState`/`Artifact` | 模型双轨 | **P2** |
| F-14 | `frontmatter` 手写解析器表达能力受限且静默忽略 | 健壮性 | **P2** |

---

## F-01 · `core/transport/ssh-tunnel*.ts` 690 行在交付链上是死代码

**优先级 P0** ｜ 类型：死代码 + 双实现

### 现象

仓库里有两套 SSH 隧道实现：

| 实现 | 语言 | 行数 | 位置 | 交付链上是否被调用 |
|---|---|---|---|---|
| `core/src/transport/ssh-tunnel.ts` + `ssh-tunnel-ssh2.ts` | TS | 690 | `packages/core` | **否** |
| `delivery/oh-tunnel.mjs` + `tunnel-daemon.mjs` | .mjs | 1209 | `delivery/` | **是**（常驻 daemon） |

### 证据

**(a) `establishTransport` 全仓调用点【实证】**

```bash
grep -rn "establishTransport" --include=*.ts --include=*.mjs packages/ delivery/ | grep -v node_modules | grep -v /dist/
```

输出：

```
packages/core/src/index.ts:10                          （导出）
packages/core/src/transport/index.ts:77                （定义）
packages/host-a2a-bridge/src/client.ts:62              ★ 唯一生产调用点
packages/tests 侧若干 .test.js                          （单测）
```

**(b) 那个唯一调用点传入的 `kind` 永远是 `streamable-http`【实证】**

`packages/host-a2a-bridge/src/cli.ts:105-112`：

```ts
export function buildTransport(args: CliArgs): TransportDecl {
  // 回环（SSH 隧道映射到本机）无需 bearer token；仅显式 --token-env 时才带凭据
  return {
    kind: 'streamable-http',
    url: args.endpoint,
    ...
  };
}
```

⇒ `establishTransport` 的 `switch (decl.kind)` 里 `case 'ssh-tunnel'` 分支**永不命中**，因此 `establishSshTunnel` → `establishSsh2Tunnel` 这两级实现（690 行）在交付链上是死代码。

**(c) 真实隧道承载者【实证】**

`delivery/tunnel-daemon.mjs:5-11` 头注释：

> 由 `install-host.mjs`（安装尾，仅 OH/ssh2 后端）或 `winvm-plugin tunnel start` 以 `spawn(...)` 拉起…
> 经 **OhSshTunnel**（进程内 ssh2 隧道）监听 127.0.0.1:<localPort>（仅回环），转发到 VM 127.0.0.1:<remotePort>

`tunnel-daemon.mjs:27` `import { OhSshTunnel } from './oh-tunnel.mjs';` — 与 `core` 无任何 import 关系。

### 影响

1. **改一处不生效**：修 `core/src/transport/ssh-tunnel-ssh2.ts` 的隧道问题，生产环境毫无变化。运维/开发者会白花时间。
2. **新读者必然误判**：`ARCHITECTURE.md` §2.2 明确把 `transport 传输抽象（ssh-tunnel / streamable-http / stdio）` 列为 `core` 的职责，`02-design/MCP-UPSTREAM.md` 也这么写。读文档 → 读这个文件 → 以为懂了 → 实际机制在 `delivery/`。
3. **SSH 后端差异**：`core` 侧有 `ssh-tunnel.ts`（spawn 外部 `ssh` 命令）+ `ssh-tunnel-ssh2.ts`（进程内 ssh2）两个后端；`delivery` 侧有 `ssh2-backend.mjs` + `oh-tunnel.mjs`。**四份实现意图重叠**。

### 建议

**不要立刻删**（它有单测、有 `dep-lint` 绿色背书，删了可能触发连锁）。分三步：

**Step 1（P0，立刻做）**：在两处加"现状声明"注释，拒绝下一个人踩坑。

- `packages/core/src/transport/ssh-tunnel.ts` 顶部：

```ts
/**
 * ⚠ 现状（2026-11-23 arch review）：
 * 本文件及其 ssh2 后端**在当前交付链上无生产调用点**。
 * 唯一生产调用 `establishTransport` 位于 host-a2a-bridge/src/client.ts:62，
 * 其 TransportDecl 恒为 kind:'streamable-http'（见 cli.ts:buildTransport）。
 *
 * 真实 SSH 隧道承载者 = delivery/oh-tunnel.mjs（OhSshTunnel）+ delivery/tunnel-daemon.mjs，
 * 由插件 hooks 的 session-start.sh 或 winvm-plugin tunnel ensure 拉起。
 *
 * 保留原因：单元测试直接验证此实现；未来若有非隧道场景需要进程内建隧道可直接复用。
 * 改动此处**不会影响运行时**。
 */
```

- `ARCHITECTURE.md §2.2` 的 `core` 行加一句同样口径的脚注。

**Step 2（P1）**：决策二选一，写入 ADR：

- **方案 A（收口）**：把 `delivery/oh-tunnel.mjs` 的逻辑迁进 `core/src/transport/`，让 host 插件也走 `establishTransport`。收益：单一实现、有类型、进门禁。代价：`delivery` 的 daemon 需要 `spawn` 常驻进程语义，`core` 目前只有"调用即建即关"语义，需要扩接口。
- **方案 B（明示分离）**：承认"常驻 daemon 隧道"和"临时进程内隧道"是两种不同东西，删掉 `core` 侧 690 行，`dep-lint` 加一条"禁止从 `delivery` 之外 import 隧道实现"。收益：立即减 690 行、消除歧义。代价：失去单测覆盖的隧道实现（但它本来就没在生产用）。

**推荐 B**。理由：`core` 侧的隧道从来没有在生产用过，`delivery` 侧的 daemon 有 pidfile、心跳状态机、指数退避重连、双实例竞态防护（`tunnel-daemon.mjs` 头部列了 6 条职责），功能完全不对等。保留一个功能弱十倍的实现没有意义。

**Step 3**：`dep-lint` 加判据 `TUNNEL_SINGLE_IMPL`（见 F-07 建议）。

---

## F-02 · `SkillDomain`(4) vs `CapabilityDomain`(6) 双轨，`domains` 全仓零消费

**优先级 P0** ｜ 类型：契约缺陷

### 现象

同一个"域"概念，在两处定义不一致；且 skill 侧的 `domains` 字段从声明到消费全程无效。

### 证据

**(a) 两处定义【实证】**

```ts
// packages/contracts/src/host.ts:20
export type SkillDomain = 'system' | 'app' | 'storage' | 'gui';

// packages/contracts/src/capability.ts:11
export type CapabilityDomain = 'system' | 'app' | 'storage' | 'gui' | 'appops' | 'meta';
```

两个文件同属 `contracts` 包，紧邻，未对齐。

**(b) 加载时静默过滤【实证】**

```ts
// packages/host-sdk/src/skill-loader.ts:29
const VALID_DOMAINS: readonly SkillDomain[] = ['system', 'app', 'storage', 'gui'];

// :125-130
const domains = (() => {
  const d = arr(fm['domains']);
  if (!d) return undefined;
  const filtered = d.filter((x): x is SkillDomain => (VALID_DOMAINS as readonly string[]).includes(x));
  return filtered.length > 0 ? filtered : undefined;
})();
```

**无 warning、无日志**。

**(c) 实际后果【实证】** 用等价于 `skill-loader.ts:125-130` 的逻辑对 10 个 skill 逐个预演：

| skill | 声明 | 加载后 | 形态 |
|---|---|---|---|
| `winvm-app-operation` | `[appops]` | **`undefined`** | 全被过滤 |
| `winvm-mcp-reference` | `[meta]` | **`undefined`** | 全被过滤 |
| `hos-win-skill` | `[meta]` | **`undefined`** | 全被过滤 |
| `winvm-orchestrator` | `[system, app, storage, gui, appops]` | `[system, app, storage, gui]` | **少一项，但非空** |
| 其余 6 个 | 单值且合法，或未声明 | 正常 | — |

**最隐蔽的是第 4 行**：`winvm-orchestrator` 的 `domains` 有值、看起来正常，实际静默丢掉了 `appops`。如果只检查"`domains` 是否为 undefined"，会**漏掉它**。

⇒ **共 4 个 skill 受影响，其中 3 个完全丢失、1 个静默残缺**。

**(d) `domains` 全仓无消费点【实证】**

```bash
grep -rn "\.domains" --include=*.ts --include=*.mjs packages/ delivery/ scripts/ | grep -v node_modules | grep -v /dist/
```

输出**只有一行**：

```
packages/host-sdk/src/skill-loader.ts:202    ...(frontmatter.domains ? { domains: frontmatter.domains } : {}),
```

这是赋值语句本身。**没有任何读取方**。

**(e) `validateNeutralPlugin` 也不检查它【实证】**

`packages/host-sdk/src/index.ts:15-60` 校验了 `name`/`version`/`description`/`author`/`skills[].id`/`entry` 唯一性/connector——**没有一条涉及 `domains`**。

### 影响

1. **写了等于没写**：7 个 skill 的 frontmatter 里 `domains` 字段是纯装饰。开发者以为它在做路由，实际什么都没发生。
2. **静默过滤是最坏的失败形态**：不报错、不告警，`appops` 就这么消失了。如果未来有人实现"按域选 skill"的路由，会莫名其妙地漏掉两个 skill。
3. **域模型双轨会持续扩大**：`CapabilityDomain` 有 6 值是因为能力侧真的需要 `appops`（5 个能力）和 `meta`（3 个能力）。skill 侧迟早也需要。

### 建议

**方案（推荐）：统一为 6 值 + 加消费点 + 改静默为 warn**

**Step 1**：`host.ts:20` 改为复用 `CapabilityDomain`：

```ts
// packages/contracts/src/host.ts
import type { CapabilityDomain } from './capability.js';

/**
 * Skill 的领域归属 —— 与 CapabilityDomain 同一集合（原为 4 值子集，
 * 导致 appops/meta 型 skill 的 domains 被 skill-loader 静默丢弃）。
 */
export type SkillDomain = CapabilityDomain;
```

**Step 2**：`skill-loader.ts` 删除 `VALID_DOMAINS` 本地常量，改用 `CAPABILITY_DOMAINS`；过滤时**未知值产生 warning 而非静默丢弃**：

```ts
const KNOWN = new Set<string>(CAPABILITY_DOMAINS);
const domains = (() => {
  const d = arr(fm['domains']);
  if (!d) return undefined;
  const unknown = d.filter((x) => !KNOWN.has(x));
  if (unknown.length > 0) {
    // 静默丢弃是最坏形态：字段写了、没人报错、也没人用上。
    console.warn(`[winvm][skill] ${dir} 的 domains 含未知域 ${unknown.join(',')}（已忽略；合法值：${[...KNOWN].join('/')}）`);
  }
  const filtered = d.filter((x): x is SkillDomain => KNOWN.has(x));
  return filtered.length > 0 ? filtered : undefined;
})();
```

**Step 3（关键）**：**给 `domains` 一个真实消费点**，否则改完还是装饰品。两个候选：

- **候选 A（推荐，成本最低）**：`validateNeutralPlugin` 增加一致性校验——每个 skill 声明的 `domains` 必须被某个已注册能力的 `CapabilityDomain` 覆盖；`entry` skill 的 `domains` 必须覆盖全部 6 域。这样字段至少是"可证伪的声明"，门禁能抓漂移。
- **候选 B（成本高）**：渲染时按 `domains` 给 SKILL.md 生成"本 skill 覆盖的能力 ID 清单"附录，让 LLM 有确定的工具列表可查。这实际解决了"skill 说'用 app 域工具'但 LLM 不知道具体有哪些"的问题。

**如果两者都不做**，那就应该**删掉 `domains` 字段**——一个没有消费点、还被静默截断的字段，留着只会误导。

**Step 4**：`selfcheck` 加断言：`grep -c "domains:" skills/*/SKILL.md` 的每个值都必须在 `CAPABILITY_DOMAINS` 内。

---

## F-03 · `createService` 单函数 2185 行，压了五类职责

**优先级 P1** ｜ 类型：结构

### 现象

`packages/vm-service/src/server.ts` 总计 2839 行，其中 `export async function createService(config)` 从 **571 行跨到 2755 行 = 2185 行**。

同文件内还有：
- `VmApprovalCoordinator` 类定义（200-537，337 行，为"导出方便"留在此处）
- `buildPreview` / `collectImpact` / `hasDryRunParam`（2756-2839，展示逻辑）

### 证据

```bash
grep -n "^export function\|^export async function\|^function \|^async function \|^const .* = " packages/vm-service/src/server.ts
```

```
200:  const TASK_STORE_MAX_TASKS = 200;
201:  const TASK_STORE_TERMINAL_TTL_MS = 3_600_000;
538:  function isRecord(...)
542:  async function readBody(...)
560:  function sendJson(...)
571:  ★ export async function createService(config: ServiceConfig): Promise<ServiceRuntime> {
2756:  function buildPreview(...)
2806:  function hasDryRunParam(...)
2815:  function collectImpact(...)
```

即：**整个文件只有 4 个顶层函数，其中一个占 2185 行（77%）**。

`createService` 内部职责分区（按区段扫描）：

| 区段 | 行范围 | 职责 | 可抽出？ |
|---|---|---|---|
| 能力注册 + provider 加载 | 572-760 | 装配 | 不易（有顺序依赖） |
| 归档校验 + bearer 自检 | 745-980 | **逻辑** | ✅ |
| netCfg 缓存 | 970-1000 | **状态管理** | ✅ |
| 审批超时回调 | 1020-1060 | **逻辑** | ✅ |
| TaskStore + 驱逐 | 1030-1120 | 装配 + 逻辑 | 部分 |
| MCP tools 组装 | 1650-1765 | **逻辑 ~115 行** | ✅ |
| A2A 构造 + observer | 1767-1960 | 装配 + **逻辑** | 部分 |
| 上游 registry | 2060-2125 | 装配 | 不易 |
| 路由分发 | 2131-2340 | **逻辑 210 行** | ✅ |
| buildHealth | 2379-2660 | **逻辑 280 行** | ✅ |
| 回连探针 + listen | 2660-2755 | 装配 | 不易 |

**至少 900 行是可抽出的纯逻辑**。

### 影响

1. **无法单测**：`index.ts:48-52` 的注释已经承认了——"本沙箱内 `createService` 会 spawn PowerShell 桥并触发 V8 fatal ⇒ 装配层入口不是可用测试面"。于是团队用了正确但昂贵的手段：**把能测的都拆出去**（3740 行辅助文件）。但拆得不彻底，剩下的 900 行逻辑仍不可测。
2. **review 成本极高**：任何改动都要在 2185 行里定位上下文。GitHub/Gitee 的 diff 视图对这么大的函数基本失效。
3. **合并冲突高发**：多人同时改不同区段会冲突。

### 建议

**分批抽出，每批独立可验证**。优先级按"可测收益 / 抽出成本"排序：

| 批次 | 抽出内容 | 目标文件 | 预估行数 | 收益 |
|---|---|---|---|---|
| B1 | `VmApprovalCoordinator` 类 | `approval-coordinator.ts` | 337 | 立减 12%，零风险（纯搬运） |
| B2 | `buildHealth()` | `health-snapshot.ts` | 280 | 可单测健康快照全分支 |
| B3 | 路由分发 | `router.ts`（返回 `(req,res)=>void`） | 210 | 可单测路由匹配/405/守卫插入位置 |
| B4 | MCP tools 组装 | `mcp-tools.ts` | 115 | 可单测工具包装 |
| B5 | `buildPreview`/`collectImpact`/`hasDryRunParam` | `preview.ts` | 84 | 可单测 dry-run 语义 |
| B6 | netCfg 缓存 + 审批超时 | `net-cache.ts` / 内联到 coordinator | ~80 | 一般 |

B1-B5 合计约 **1026 行**，做完 `server.ts` 降到 ~1800 行（`createService` 降到 ~1180 行）。

**关键纪律**：每批抽完立刻跑 `node scripts/gate.mjs --quick` + 对应单测。**不要一次抽完**——2185 行里有很多注释记录的隐性约束（顺序、fail-closed、零回归），一次性搬容易丢。

**先例可循**：`http-guard.ts`（651）/ `health-probe.ts`（204）/ `delegation-audit.ts`（899）就是这个模式的成功案例——它们被拆出来时也面对同样的"不可测"问题。

---

## F-04 · `HostRenderer` 四方法契约被两处绕过

**优先级 P1** ｜ 类型：契约缺陷

### 现象

`HostRenderer` 的设计意图是"所有宿主产物都经 `plan()` 生成，因此渲染即可复现"。实际有两类产物**完全绕过** `plan()`。

### 证据

**(a) 全局 `~/.workbuddy/mcp.json`【实证】**

`delivery/install-host.mjs:1283-1320` 手写，不经 Renderer：

```js
/* WorkBuddy「连接器 / 自定义 MCP」页面读取全局 ~/.workbuddy/mcp.json；
 * 仅写 connectors/<account>/mcp.json 时该页面看不到 winvm / winvm-a2a */
const globalMcpPath = join(args.home, '.workbuddy', 'mcp.json');
...
console.log(`全局 mcp.json : 已增量合并 ${ourNames} → ${globalMcpPath}${bak ? `（备份 ${bak}）` : ''}`);
```

**(b) `hooks/*` + 9 个运行时 .mjs【实证】**

`install-host.mjs:1362`：

```js
deployWinvmPlugin({
  targetDir: paths.pluginRoot, side: 'host', dryRun: false,
  extraFiles: ['oh-tunnel.mjs', 'ssh2-resolve.mjs', 'ssh2-client.mjs',
               'ssh2-backend.mjs', 'tunnel-daemon.mjs',
               'hooks/hooks.json', 'hooks/session-start.sh', 'account-resolve.mjs']
});
```

这些文件直接用 `cpSync` 复制，不在 `RenderPlan.files` 里。

### 影响

1. **"plan() 即真相"不成立**：想回答"这个插件装了哪些文件"，必须同时读 `plan()` 结果 + `install-host.mjs` 的手写段 + `deployWinvmPlugin` 的 extraFiles 白名单。三处。
2. **dry-run 不完整**：`renderer.install(plan, {dryRun:true})` 会列出 `plan.files`，但**不会列出**全局 mcp.json 与 hooks——用户以为 dry-run 覆盖全部，实际漏两块。
3. **uninstall 对称性风险**：`Renderer.uninstall()` 只清 `connectors/<acct>/mcp.json`；全局 mcp.json 的清理在 `install-host.mjs:860-875` 另一处手写。两处必须同步改，否则卸不干净。
4. **同名双源漂移**：`install-host.mjs:217` 与 `:1362` 各有一份 extraFiles 名单，注释说"同名同源"——但**是两份字符串数组**，改一处忘另一处就会 freshness 检查误报。

### 建议

**Step 1（低成本，立即可做）**：把 extraFiles 名单提成一个导出常量，消除双源：

```js
// delivery/host-runtime-files.mjs
/** 插件运行时依赖文件（必须在 pluginRoot 下就位；绕过 Renderer 的清单**唯一事实源**）。 */
export const HOST_RUNTIME_FILES = Object.freeze([
  'winvm-plugin.mjs', 'oh-tunnel.mjs', 'ssh2-resolve.mjs', 'ssh2-client.mjs',
  'ssh2-backend.mjs', 'tunnel-daemon.mjs',
  'hooks/hooks.json', 'hooks/session-start.sh', 'account-resolve.mjs',
]);
```

`:217` 与 `:1362` 都 import 它。

**Step 2（中成本，结构性）**：把两类绕过纳入 `plan()` 的产物面。

`NeutralPlugin` 已有 `skills` / `connector` / `a2aBridge` / `extraConnectors`。新增两个可选字段：

```ts
/** 插件运行时依赖文件（原样复制进 pluginRoot，不解释内容）。 */
readonly runtimeFiles?: readonly { readonly src: string; readonly destRel: string }[];

/** 需要额外合并的宿主全局配置（如 WorkBuddy 的 ~/.workbuddy/mcp.json）。
 *  与 connector 的账户级 mcp.json 分开：前者只影响 UI 面，后者影响运行时工具面。 */
readonly globalMcpEntries?: readonly ConnectorDecl[];
```

`WorkBuddyRenderer.plan()` 把它们转成 `PlannedFile[]` + 额外的 `JsonPatch`（path 指向 `~/.workbuddy/mcp.json`）。这样 dry-run 自动覆盖全部产物。

**Step 3**：`validate()` 加一条断言——`install-host.mjs` 里**不允许出现裸 `cpSync` 到 pluginRoot**（机检：`grep -c "cpSync.*pluginRoot"` 应为 0，除 Renderer 内部）。这条能防止未来再绕过。

**如果 Step 2 成本太高**，至少要做 Step 1 + 在 `04-ops/` 写明"产物由三处生成"的清单，让读者知道去查哪里。

---

## F-05 · `fillApprovalCard()` 生产零调用点，审批卡靠提示词

**优先级 P0** ｜ 类型：安全 / 接线缺失

### 现象

`adapter-host-workbuddy/src/approval-card.ts` 821 行，核心导出是 `fillApprovalCard()`（747 行起）。**生产代码无一处调用它**，只有单测。

### 证据

```bash
grep -rn "fillApprovalCard" --include=*.ts --include=*.mjs packages/ delivery/ scripts/
```

排除 `/dist/` 与 `docs/` 后，命中：

```
packages/adapter-host-workbuddy/src/approval-card.ts:747   （定义）
packages/adapter-host-workbuddy/src/approval-card.ts:568/609/632/786 （注释提及）
```

**零调用点**。

### 实际填充方式

`plan()` 只做**模板注入**（`index.ts:263-269`）：

```ts
if (skill.id === APPROVAL_CARD_SKILL_ID) {
  files.push({
    path: join(paths.connectorSkillsRoot, skill.id, 'references', APPROVAL_CARD_REFERENCE_PATH),
    mode: 'overwrite',
    content: APPROVAL_CARD_WIDGET_HTML,      // ← 含 {{placeholder}} 的模板
  });
}
```

运行时填充由**宿主 LLM 按 SKILL.md 的指令手动做**。`validate()` 只做静态检查（`auditApprovalCardTemplate()` + 产物零 `MCP_RESUME_MARKER`）。

### 影响

1. **安全面依赖 LLM 顺从性**：如果 LLM 不照 SKILL.md 做，审批卡会：
   - 完全不渲染（退化为纯文本提示）→ 用户仍能看到信息，但**卡片里的"只展示不放行"设计失效**
   - 或渲染了但残留 `{{approvalId}}` 占位符 → 用户看不到关键信息
2. **`validate()` 的"零残留占位符"断言其实只在测常量**：因为 `plan()` 注入的是未填充的模板，`validate()` 检查时占位符**必然存在**——所以它只能检查"模板本身合法"，不能检查"运行时产物合法"。
3. **821 行里 700+ 行是 HTML 常量**，核心函数不接线，性价比极低。

### 建议

这里有个**结构性矛盾**必须承认：**插件的 `plan()`/`install()` 发生在安装时，而审批卡需要运行时填充**。Renderer 不可能在安装时知道运行时的 `approvalId`。

所以"接线"不可能在 Renderer 里做。三个可行方向：

**方向 A（推荐）：把填充做成 VM 侧的返回值，而不是宿主侧的渲染**

VM 的 `a2a.delegate` 返回 `approvalId` 时，**直接返回一段已填充好的卡片数据**（结构化的，不是 HTML）。宿主 LLM 只需把数据塞进模板。

- 改动：`a2a-framework` 的 `input-required` 响应增加 `approvalCard: { approvalId, capabilityId, risk, preview, impact, expiresAt }` 结构化字段
- 宿主侧：skill 指令从"你自己组织卡片"变成"把 `approvalCard` 字段填进模板的第 1/2/3 槽"
- 收益：**填充所需的数据由服务端保证，LLM 只做搬运**；`fillApprovalCard()` 变成"数据 → HTML"的纯函数，可以被测试、被验证

**方向 B（低成本）：接受提示词契约，但把风险显式化**

在 `SKILL.md` 和 `approval-card.md` 里明确写："若无法正确填充，**必须**降级为逐字文本模板，不得自行编造卡片"。并在 `SEQUENCE` 里加一条 QA 项（真机验证 LLM 是否照做）。

**方向 C（防御性）：`fillApprovalCard` 返回 `null` 时必须有代码兜底**

当前 `fillApprovalCard` 返回 `null` 表示降级，但**没有代码消费这个 null**。若走方向 A，这个兜底就有落点了。

**最少要做的**：在 `approval-card.ts` 顶部加现状声明，说明"本函数当前无生产调用点，填充靠 SKILL 门禁"，避免下一个人以为它是活的。

---

## F-06 · 直调命中 L2/L3 不产生 approvalId，续跑令牌成遗留支路

**优先级 P1** ｜ 类型：双通道语义不对称

### 现象

MCP 直调通道与 A2A 通道遇到高危能力时的行为完全不同：

| 通道 | 命中 L2/L3 | 是否返回 approvalId |
|---|---|---|
| A2A `a2a.delegate` | 任务转 `input-required` | ✅ 返回 |
| MCP 直调 | 收口 `DELEGATION_REQUIRED` | ❌ 不返回 |

### 证据

**(a) MCP server instructions【实证】** `server.ts:1753-1756`：

```
'风险等级 L2/L3 一律经 a2a.delegate 委派审批（批1(c)：直调命中审批闸即收口
 DELEGATION_REQUIRED，不再发放续跑令牌）。'
```

**(b) 旧路径仍在代码里【实证】** `server.ts:218-220`：

```ts
// K4 安全点：token 在 `/mcp` 能力层注册时 `hostApproved=false`；
// 宿主经 A2A `approval.reply` 批准：token 置为「已批准」——保留 K4 语义，
// `/mcp` 人工显式续跑路径仍可用。
```

**(c) 令牌基础设施完整存在【实证】**：
- `pending-approvals.ts`（277 行）：`PendingApprovalRegistry`，TTL + 容量双保险
- `server.ts:1495-1515`：续跑时的 `previewHash` 绑定校验（`ARCH-09`）
- `approval-replay.ts`（626 行）：审批决策取证

### 影响

1. **单通道用户的体验断层**：一个只用 MCP 的客户端（比如某些自动化脚本）遇到 L2 能力时，只能得到一个错误码，必须理解"要用另一个通道"才能继续。这个设计对小模型或不看文档的调用方不友好。
2. **代码维护负担**：续跑令牌机制（277 + 626 行的一部分 + `server.ts` 的 ~120 行）仍然被维护、被测试、有 `previewHash` 绑定校验，但**几乎不触达**。这是"为了历史兼容保留的死路"。
3. **审批卡通道隔离的另一面**：F-05 提到审批卡不准出现 MCP 续跑标记——因为续跑路径已废弃。但**代码里它还在**，这是文档说"不要提"但代码说"还能用"的矛盾。

### 建议

**Step 1（决策，必须先做）**：明确"直调续跑"是**废弃**还是**保留**。

- 若**保留**（比如为了无 LLM 的脚本化场景）：那它需要一条正式的产品化路径——`409 DELEGATION_REQUIRED` 响应里应附带指引（"用 connector:winvm-a2a 的 a2a.delegate"），而不是一个裸错误码。
- 若**废弃**：删掉 `pending-approvals.ts` + 续跑分支 + 相关测试，`DELEGATION_REQUIRED` 改为明确文案。

**Step 2**：`DELEGATION_REQUIRED` 的错误体加结构化字段：

```json
{
  "ok": false,
  "error": {
    "code": "DELEGATION_REQUIRED",
    "message": "该能力风险等级 L2，需经 A2A 委派审批",
    "details": {
      "capabilityId": "system.service.control",
      "risk": "L2",
      "delegateTool": "a2a.delegate",
      "connector": "connector:winvm-a2a",
      "rationale": "直调通道不发放审批令牌（批1(c) 裁决）"
    }
  }
}
```

这样调用方（包括 LLM）能自己发现该走哪条路，不需要读文档。

**Step 3**：`04-ops` 或 `02-design` 记录这条不对称的**理由**，避免下一个人以为它是 bug 而"修复"回去。

---

## F-07 · `delivery/` 16059 行几乎在门禁外，且与 packages 同职责双实现

**优先级 P1** ｜ 类型：门禁盲区

### 现象

`delivery/` 有 22 个 `.mjs` 文件、16059 行，是**整个仓库门禁面最薄的大块代码**：

| 门禁 | 覆盖范围 | 覆盖 delivery？ |
|---|---|---|
| `tsc -b`（ST1） | `tsconfig.build.json` 的 packages | ❌ 纯 .mjs 无类型检查 |
| `dep-lint`（ST2） | packages 的 import 图 | ❌ 不扫 delivery |
| `config-key-lint`（ST2b） | TS 配置键 | ❌ 不适用 |
| `node --test`（ST4） | `tests/unit/**` + **`delivery/__tests__/**`** | ⚠️ **已纳入，但只有 3 个文件** |

> **修正记录**：本文初稿写"delivery 测试未纳入 sweep"是**错的**。`gate.mjs:329-340`（Q3 / Phase 3 批5）已把 `delivery/__tests__` 纳入枚举，注释还记了病灶："`delivery/__tests__/oh-tunnel-error-handling.test.mjs`（8 例）自 CL-016 起即孤儿——sweep 只枚举 tests/unit"。**这个坑已经被人发现并修了**。
> 真实缺口是另一件事：**该目录只有 3 个文件**（1 个 `.test.mjs` 8 例 + 2 个 `probe-*.mjs` 手工探针），对应 16059 行代码 ⇒ 覆盖率仍近乎为零。

### 证据

```bash
ls -S delivery/*.mjs | head -6 | xargs wc -l
```
```
1794 delivery/setup.mjs
1655 delivery/install-host.mjs
1470 delivery/winvm-plugin.mjs
1274 delivery/uninstall.mjs
1112 delivery/bootstrap.mjs
1104 delivery/install-vm.mjs
```

`scripts/gate.mjs` 的 5 段流水线（ST1-ST4）中，ST2 明确只读 `packages/`：

```js
// dep-lint.mjs
扫描：packages=12 js文件=76  import语句=48  包级边=24
```

**没有扫 `delivery/`**。

### 双实现清单

| 职责 | packages 侧 | delivery 侧 | 关系 |
|---|---|---|---|
| SSH 隧道 | `core/src/transport/ssh-tunnel*.ts`（690） | `oh-tunnel.mjs` + `tunnel-daemon.mjs`（1209） | **交付用 delivery，core 侧死代码**（F-01） |
| 安装编排 | `adapter-host-workbuddy`（1376） | `install-host.mjs`（1655）+ `install-vm.mjs`（1104）+ `setup.mjs`（1794） | Renderer 只管产物格式，编排全在 delivery |
| 发布打包 | — | `pack-release.mjs`（969）+ `publish-release.mjs`（556）+ `verify-release.mjs` | 无对应 |
| 卸载 | `Renderer.uninstall()`（40 行） | `uninstall.mjs`（1274） | **约 32 倍体量差** |

最后一行值得注意：**Renderer 的 uninstall 40 行，delivery 的 uninstall 1274 行**。这说明真正的卸载逻辑（注册表清理、回收站、双侧协调、校验）全在 delivery，Renderer 那 40 行只清一个 mcp.json。

### 影响

1. **漂移无人拦**：`delivery` 里的 bug 只能靠真机发现。而它恰好是**最容易漂移的面**——依赖宿主路径、操作系统版本、文件系统特性、进程管理。
2. **改错不报错**：一个拼错的路径字符串，`tsc` 不会抓，`dep-lint` 不会抓，单测覆盖不到，只有真机跑到那一行才炸。
3. **正例存在但覆盖极薄**：`delivery/__tests__/` 已纳入 `gate.mjs` 的 ST4 sweep（`gate.mjs:329-340`，Q3 修复），但**只有 3 个文件**：

```
delivery/__tests__/oh-tunnel-error-handling.test.mjs   唯一真正的测试（8 例）
delivery/__tests__/probe-daemon-error.mjs              手工探针
delivery/__tests__/probe-tunnel-error.mjs              手工探针
```

**1 个测试文件对 16059 行代码**。且它测的只是 `oh-tunnel` 的错误处理一条路径。

### 建议

**Step 1（已完成，记录在案）**：`delivery/__tests__` 已纳入 ST4 sweep。**不需要再做**。

**Step 2（中成本）**：`dep-lint` 增加 `SCRIPT_LINT` 判据，扫 `delivery/*.mjs`：

- 检查 `import` 路径是否存在（防止 `./nonexistent.mjs`）
- 检查硬编码路径（`/tmp/`、`C:\\`、`/Users/`）——鸿蒙 `/tmp` 只读是已知坑
- 检查 `rm -rf` / `rmSync(..., {recursive:true})` 无条件调用（要求有 guard）

这三条都是**曾经真实踩过的坑**（`/tmp` 只读、`rm` shim 缺 bash）。机检化能防止回归。

**Step 3（结构性，长期）**：把 delivery 的纯逻辑段抽成可测函数并加 `.test.js`：

优先顺序（按"最容易炸 × 最容易测"）：
1. `path-util.mjs` —— 路径解析，纯函数
2. `account-resolve.mjs` —— 账户目录判定，纯函数
3. `ssh2-resolve.mjs` —— 模块定位，纯函数
4. `pack-release.mjs` 的文件清单构造
5. `install-host.mjs` 的 `plan` 段（把它拆成"算计划"与"执行计划"两部分）

**Step 4**：`delivery` 的关键 .mjs 加 JSDoc 类型标注 + `tsc --checkJs`（可以只对 delivery 单独开一个 `tsconfig.delivery.json`）。这能白嫖类型检查，不需要改成 TS。

---

## F-08 · 七个文件超过 1000 行（最大 2839）

**优先级 P1** ｜ 类型：结构

### 证据【实证】

| 文件 | 行数 | 说明 |
|---|---|---|
| `vm-service/src/server.ts` | **2839** | 见 F-03 |
| `adapter-agent-workbuddy-llm/src/bridge.ts` | **1892** | LLM 会话桥 |
| `delivery/setup.mjs` | **1794** | 双端一键部署 |
| `delivery/install-host.mjs` | **1655** | 宿主安装 |
| `delivery/winvm-plugin.mjs` | **1470** | 管理 CLI |
| `adapter-agent-workbuddy/src/index.ts` | **1371** | 确定性执行器（单文件成包） |
| `delivery/uninstall.mjs` | **1274** | 卸载 |
| `vm-capabilities/psmod/app.ps1` | **1209** | app 域 |
| `adapter-agent-workbuddy-llm/src/persistent-session.ts` | **1144** | 常驻会话 |
| `delivery/bootstrap.mjs` | **1112** | 引导 |
| `delivery/install-vm.mjs` | **1104** | VM 安装 |
| `host-a2a-bridge/src/tools.ts` | **1031** | 5 个工具 |
| `delivery/pack-release.mjs` | 969 | 打包 |
| `adapter-agent-workbuddy-llm/src/index.ts` | 702 | provider |
| `vm-capabilities/src/ps-bridge.ts` | 708 | PS 桥客户端 |
| `a2a-framework/src/task-store.ts` | 877 | Task 状态机 |
| `vm-service/src/delegation-audit.ts` | 899 | 委派审计 |
| `core/src/policy/engine.ts` | 828 | 策略引擎 |
| `adapter-host-workbuddy/src/approval-card.ts` | 821 | 审批卡 |

**超过 1000 行的有 12 个**（上表加粗部分）。

### 影响

`adapter-agent-workbuddy/src/index.ts` 1371 行**单文件成一个包**最能说明问题：完全没有文件级拆分。而它同层的 `adapter-agent-workbuddy-llm` 拆了 5 个文件——说明团队知道该拆，只是有些包没来得及。

### 建议

**不要追求"每个文件 300 行"这种数字目标**。用更有意义的两条判据：

1. **一个文件是否只承载一个变化理由**（SRP 的可操作版本）
2. **能否在不 mock 的情况下测到核心分支**

按这两条，优先拆这些：

| 文件 | 拆法 |
|---|---|
| `server.ts` | 见 F-03 的 B1-B5 |
| `adapter-agent-workbuddy/src/index.ts` | 按能力域拆：`system.ts` / `app.ts` / `storage.ts` / `gui.ts` / `appops.ts` + `index.ts` 只留 provider 接口实现 |
| `host-a2a-bridge/src/tools.ts` | 一工具一文件：`tools/delegate.ts` / `tools/task-get.ts` / `tools/approval-reply.ts` / `tools/task-cancel.ts` / `tools/health.ts` + `tools/index.ts` |
| `adapter-agent-workbuddy-llm/src/bridge.ts` | 按职能拆：`bridge/session.ts`（会话）/ `bridge/tools.ts`（工具注入）/ `bridge/approval.ts`（审批翻译）/ `bridge/verdict.ts`（K6 折叠） |
| `delivery/setup.mjs` | 按步骤拆：`setup/build.mjs` / `setup/host.mjs` / `setup/vm.mjs` / `setup/tunnel.mjs` / `setup/verify.mjs` + `setup/index.mjs` 只做编排 |

`delivery/*.mjs` 的拆分特别值得做——它们是**无类型、无门禁**的代码，拆小后 review 成本显著下降。

---

## F-09 · 文档数字漂移

**优先级 P1** ｜ 类型：文档

### 证据（五处）

| 位置 | 写的 | 实际 | 状态 |
|---|---|---|---|
| `ARCHITECTURE.md:132` | `connectors/skills/connector-winvm/<6 skills>` | **10 个** | ❌ 漂移 |
| `docs/05-peripherals/DEPLOYMENT.md:12` | 「插件 winvm-bridge（connector + **6 skills**）」 | **10 个** | ❌ 漂移 |
| `delivery/install-host.mjs:1205` | 「agent-desktop（VM 侧白名单 **10 工具**）」 | **25 条**（`mcp-upstream.ts:84` 实测） | ❌ 漂移 |
| `delivery/uninstall.mjs:36` | 「**8** connector skills：1 总控 + 5 领域 + 1 MCP 参考 + 1 宿主分派」 | 8+2 上游工具面 = **10 个** | ❌ 漂移（漏算 2 个上游） |
| `delivery/pack-release.mjs:779` | 「`skills/`：**8 个**连接器 Skills」 | **10 个** | ❌ 漂移 |
| `delivery/install-host.mjs:8` | 「10 个 Skills：1 总控 + 5 领域 + 1 MCP 参考 + 1 宿主分派 + 2 上游工具面」 | 10 个，**分类正确** | ✅ 已更新 |

**注意 `uninstall.mjs:36` 的漂移形态**：它列了 4 类共 8 个（1+5+1+1），**分类逻辑正确但漏了 2 个上游工具面 skill**。这说明不是"忘了改数字"，而是**当时上游 skill 还没加进来**，后来加进了 `skills/` 目录但没回头改这两处注释。

### 影响

数字漂移的危害不在"数字错了"，而在**它让人怀疑整份文档**。读到"6 skills"发现是 10，读者会想"那包清单准吗？依赖方向准吗？"——即使那些是对的。

且 `install-host.mjs` 的头部注释**已经正确写 10 个**，而 `uninstall.mjs` / `pack-release.mjs` 还写 8 个 —— 说明是**逐文件更新时的遗漏**，不是知识缺失。

### 建议

**Step 1**：立即修正 4 处（6→10、10→25、8→10、8→10）。

**Step 2（结构性，防再犯）**：把可数事实**从文档搬进代码常量**，文档引用常量名而非数字：

```ts
// packages/contracts/src/host.ts 或一个专门的 facts 模块
/** 本插件交付的 skill 清单（数字与分类的唯一事实源；文档写"见 SKILL_CATALOG"）。 */
export const SKILL_CATALOG = Object.freeze({
  total: 10,
  breakdown: { orchestrator: 1, domain: 5, reference: 1, hostDispatch: 1, upstreamToolface: 2 },
});
```

然后 `selfcheck` 加断言：文档里的"N 个 skill"必须等于 `SKILL_CATALOG.total`。这是**唯一能防住数字漂移的机制**——靠人肉检查迟早再漂。

**Step 3**：`docs/02-design/` 的每份文档加一个"最后与代码对齐的 commit"字段，让人知道它有多旧。

---

## F-10 · PowerShell 3522 行零单测，正确性只靠真机

**优先级 P1** ｜ 类型：测试盲区

### 证据

- `packages/vm-capabilities/psmod/*.ps1`：3522 行 / 6 文件
- `tests/` 下 140 个 `.test.js`/`.test.mjs`：全部是 Node 侧
- 无 `.Tests.ps1` 文件（`Pester` 未使用）

### 影响

PS 侧承载了**全部真实能力执行**（54 个能力的实现）。它的 bug 表现是"某能力返回错误结果"，而 Node 侧的 140 个测试**只能测到 mock 层**，测不到 PS 实现。

已知的真机验证路径：`qa/real-test-2026-11-20-v1437.md`（探针 34/34、health=200）。但这是**端到端冒烟**，不是逐函数验证。

### 建议

**不推荐引入 Pester**（成本高、VM 侧环境复杂）。推荐三条低成本措施：

**Step 1：契约测试（Node 侧）**

对 54 个能力，每个至少有一条"参数校验"测试：传入非法 params，断言 **PS 侧返回结构化错误**（而不是崩溃/静默）。这不需要真的执行系统变更。

**Step 2：纯函数段抽到 Node 侧**

某些 PS 逻辑本质是纯计算（路径归一、命令拼装、过滤条件构造）。把这些抽成 Node 的纯函数，PS 侧只做调用。`core/src/policy/engine.ts` 已经是这个模式的成功案例（归一/匹配全在 Node，PS 只执行）。

**Step 3：`ps-bridge.ps1` 加自检子命令**

```powershell
# 用法：powershell -File ps-bridge.ps1 -SelfTest
# 校验：6 个模块可加载、每个模块导出的函数签名齐备、UTF-8 编码正确、StrictMode 生效
```

在 `install-vm.mjs` 的部署尾部调用一次，失败则告警。这把"PS 模块缺失/函数改名"从真机运行时问题提前到部署时。

**Step 4**：`app.ps1`（1209 行）按能力拆成 `app-winget.ps1` / `app-appx.ps1` / `app-shortcut.ps1` / `app-process.ps1`。降低单文件理解成本。

---

## F-11 · `adapter-agent-hermes` 同层依赖 `workbuddy`，无法独立部署

**优先级 P2** ｜ 类型：依赖

### 证据【实证】

```ts
// packages/adapter-agent-hermes/src/index.ts:25-26
import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';
import { CliLlmBridge, loadSkillDocs, type LlmBridge } from '@winvm/adapter-agent-workbuddy-llm';
```

`package.json` 的 `layer` 都是 `L2-adapter-agent-llm`（同 rank 40），`dep-lint` 的 `LAYER_DIRECTION` 判据只比较 rank 大小（相等不算反向），因此**不报违规**。

### 影响

- 语义上，"换 VM 内 Agent"这个卖点在 hermes 这里打折：想只部署 hermes，必须同时装 workbuddy + workbuddy-llm（共 5709 行）。
- `adapter-agent-workbuddy-llm` 是 4338 行的大包，为了一处 `CliLlmBridge` 复用而全量依赖，代价偏高。

### 建议

**Step 1**：评估 `CliLlmBridge` / `loadSkillDocs` / `DeterministicAgentProvider` 是否真的是复用还是"复制粘贴后忘了抽公共件"。

- 若真是复用 ⇒ 把这些件下沉到一个 L1.5 层（比如 `packages/agent-runtime`，rank 35），两个 adapter 都依赖它。`dep-lint` 的 `LAYER_RANK` 加一项。
- 若是复制 ⇒ 各留一份，断开横向依赖。

**Step 2**：`dep-lint` 增加 `SIBLING_ADAPTER_DEP` info 级判据——同层 adapter 之间的依赖显形（不算违规，但让人知道）。这样未来新增 adapter 时能看到"哦，hermes 也依赖 workbuddy 了，这是有意的吗"。

---

## F-12 · `dep-lint` 的 `DECLARED_UNUSED` 无法区分 type-only / 动态加载

**优先级 P2** ｜ 类型：门禁精度

### 证据【实证】

`node scripts/dep-lint.mjs` 输出 9 条 `DECLARED_UNUSED`：

```
adapter-agent-hermes       → @winvm/contracts        （type-only 擦除）
adapter-agent-hermes       → @winvm/vm-capabilities  （type-only 擦除）
adapter-host-workbuddy     → @winvm/contracts        （type-only 擦除）
host-sdk                   → @winvm/contracts        （type-only 擦除）
mcp-framework              → @winvm/contracts        （type-only 擦除）
vm-capabilities            → @winvm/contracts        （type-only 擦除）
vm-capabilities            → @winvm/core             （type-only 擦除）
vm-service                 → @winvm/adapter-agent-workbuddy      （动态 import）
vm-service                 → @winvm/adapter-agent-workbuddy-llm  （动态 import）
```

**9 条全是误报或设计选择，没有一条是真问题。**

### 影响

- 9 条 info 里 9 条是噪音 ⇒ 读者会学会"忽略这一节" ⇒ 未来真有一条真的 `DECLARED_UNUSED` 时也会被忽略。
- 这是**告警疲劳**的典型形成路径。

### 建议

**Step 1**：`dep-lint` 读 dist 时同时扫 `.d.ts` 文件。若某依赖在 `.d.ts` 里有引用 ⇒ 判为 `TYPE_ONLY`（单独计数，不算 info 噪音）。

**Step 2**：识别动态 import——扫 dist 里的 `import(` / `require(` 字符串字面量（`vm-service` 动态加载 adapter 时 `entry.package` 是配置来的，但 `core/bridge/loader.ts` 有 `await import(entry.package)`，实际包名字符串在 config 里）。

更实际的做法：`package.json` 加一个约定字段：

```json
{ "winvm": { "dynamicDeps": ["@winvm/adapter-agent-workbuddy", "@winvm/adapter-agent-workbuddy-llm"] } }
```

`dep-lint` 读到这个字段就跳过 `DECLARED_UNUSED` 判定。**显式声明优于推断**。

**Step 3**：把 `DECLARED_UNUSED` 的输出从 9 行压到 0 行（全部归入 `TYPE_ONLY` / `DYNAMIC` 两个新类别且默认静默）。**零告警才有意义**。

---

## F-13 · A2A 协议类型与内部状态机各有一套 `TaskState`/`Artifact`

**优先级 P2** ｜ 类型：模型双轨

### 证据【实证】

`contracts/src/index.ts:17` 的注释：

> A2A v1.0 类型以命名空间导出，避免与 bridge 层的 `TaskState` / `Artifact` 同名冲突。
> 使用：`import { A2A } from '@winvm/contracts'` → `A2A.Task`, `A2A.AgentCard`

即：
- `bridge.ts`（928 行）有一套 `TaskState` / `Artifact` —— 本项目内部模型
- `a2a.ts`（262 行）有 `A2A.TaskState` / `A2A.Artifact` —— 协议规范

### 影响

两套模型并存意味着**任何状态变化都要写两次映射**。当前用命名空间隔离是合理的止血，但没解决"两个真相"问题。

具体风险：A2A 协议升级（v1.0 → v1.1）时，映射层要改；内部模型演进时，映射层也要改。映射层在哪？在 `a2a-framework/src/server.ts`（747 行）里。

### 建议

**Step 1**：找出映射层，明确标注为"协议适配层"，并加一组双向映射的单测（每个内部状态 ↔ 每个协议状态，全集覆盖）。当前是否有这样的测试？需确认。

**Step 2**：如果内部模型的 `TaskState` 实际上**就是**协议状态的子集，考虑直接复用 `A2A.TaskState`，删掉内部那套。这样映射层消失。

**Step 3**：如果内部模型确实需要协议外的状态（比如 `NO_EXECUTION_RECEIPT` 这类审计裁决），那就在文档里写清"协议态 ⊂ 内部态"的包含关系，并把差异枚举出来。

**这条优先级 P2 是因为**：当前用命名空间隔离已经止血，没有实际故障。但它是"未来会咬人"的债。

---

## F-14 · `frontmatter` 手写解析器表达能力受限且静默忽略

**优先级 P2** ｜ 类型：健壮性

### 证据【实证】

`host-sdk/src/skill-loader.ts` 的 `parseFrontmatter`（约 60 行）只支持：

- `key: value`（标量）
- `key: [a, b]`（内联数组）
- 缩进块（收集为数组）

**不支持**：嵌套对象、多行字符串（`|`/`>`）、引号内转义、注释。

### 影响

当前 10 个 skill 都在能力范围内。但：

1. **新增复杂 frontmatter 会静默失败**：比如写

```yaml
metadata:
  author: x
  tags: [a, b]
```

解析器会把 `metadata:` 当空值，`author`/`tags` 当顶层键。**不报错**。

2. **与 `domains` 的静默过滤叠加**：两个静默失败点在同一函数里。

### 建议

**Step 1（低成本）**：加严格模式校验。遇到"看起来像 YAML 但解析不了"的形态（比如缩进块出现在非数组上下文、值以 `|` 开头）时产生 warning 并列出该行。

**Step 2（中成本）**：换用 `yaml` 包（~40KB，只在构建时用，不影响运行时体积）。

**Step 3（如果坚持零依赖）**：把支持的语法子集写进 `SPEC-SKILLS.md`，并在 `validateNeutralPlugin` 里机检"frontmatter 只用了白名单语法"。

---

## 汇总：按优先级排序的处理建议

### P0（3 条，建议 2 周内）

| # | 动作 | 成本 |
|---|---|---|
| F-01 | 在 `core/transport/ssh-tunnel*.ts` 加现状声明注释 | 0.5h |
| F-02 | `SkillDomain` 对齐为 6 值 + 静默过滤改 warning + **给出消费点或删字段** | 2h |
| F-05 | `approval-card.ts` 加现状声明；决策方向 A/B/C 并落一条 | 1h（声明）/ 1d（方向 A） |

### P1（7 条，建议本季度）

| # | 动作 | 成本 |
|---|---|---|
| F-03 | `server.ts` 分批抽出 B1-B5（约 1026 行） | 2-3d |
| F-04 | extraFiles 双源收口（Step 1）→ 纳入 plan()（Step 2） | 0.5d / 2d |
| F-06 | 决策"直调续跑"存废 + `DELEGATION_REQUIRED` 加结构化字段 | 0.5d |
| F-07 | delivery 仅 3 个测试文件对 16059 行 + `SCRIPT_LINT` 三条判据 | 1d |
| F-08 | 优先拆 `host-a2a-bridge/tools.ts` 与 `adapter-agent-workbuddy/index.ts` | 1d |
| F-09 | 修正 4 处数字 + `SKILL_CATALOG` 常量 + 文档断言 | 2h |
| F-10 | `ps-bridge.ps1 -SelfTest` + 参数校验契约测试 | 1-2d |

### P2（4 条，有空再做）

| # | 动作 |
|---|---|
| F-11 | 评估 hermes 横向依赖是否真复用，决定下沉还是断开 |
| F-12 | `dep-lint` 加 `TYPE_ONLY` / `DYNAMIC` 类别，把 info 噪音压到 0 |
| F-13 | 明确 A2A 协议态与内部态的包含关系 + 双向映射单测 |
| F-14 | frontmatter 严格模式 warning |