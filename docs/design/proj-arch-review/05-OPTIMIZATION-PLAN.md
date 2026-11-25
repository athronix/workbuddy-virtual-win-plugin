# 优化路线（三批：止血 → 收口 → 重构）

> 本文把 `04-FINDINGS.md` 的 14 条转成**可执行批次**。
> 排序原则：**先让真相可见（止血）→ 再消除双实现（收口）→ 最后拆结构（重构）**。
> 每条都附**验收判据**——不接受"改完了"这种说法，必须有可跑的判据。

---

## 0. 为什么不按优先级直接排

直觉做法是"P0 先做、P1 后做"。但 P0 里三条性质完全不同：

- F-01（隧道死代码）：**只是看不见，不危险**。加注释即止血。
- F-02（域模型双轨）：**静默丢数据**，但当前无消费点 ⇒ 无实际故障。
- F-05（审批卡零接线）：**安全面靠提示词**，是真实风险。

如果按 P0 顺序做，会先花时间在"加注释"和"改类型"上，而真正有安全意义的 F-05 排在第三。所以本路线按**性质**分三批，每批内部再按优先级：

```
第一批 · 止血    —— 让现状可见、让静默失败变响。零功能改动，只加声明/告警/断言。
第二批 · 收口    —— 消除双实现、补齐接线、把数字搬进常量。有功能改动，但不动主结构。
第三批 · 重构    —— 拆大文件、下沉公共件。纯结构，行为零变化。
```

**每批的硬要求**：批内完成后必须 `node scripts/gate.mjs --quick` 全绿 + 真机 `VERIFY=PASS`，否则不进下一批。

---

## 第一批 · 止血（预计 1-2 天）

**目标**：不改变任何运行时行为，只让"看不见的真相"和"静默的失败"显形。

### A-1 · 给死代码加现状声明（F-01 Step 1）

**改动**：3 处注释 + 1 处文档脚注。

| 文件 | 加什么 |
|---|---|
| `packages/core/src/transport/ssh-tunnel.ts` | 顶部声明"当前交付链无生产调用点；真实隧道在 delivery/oh-tunnel.mjs" |
| `packages/core/src/transport/ssh-tunnel-ssh2.ts` | 同上（或指向 `ssh-tunnel.ts` 的声明） |
| `delivery/oh-tunnel.mjs` | 顶部声明"本文件是隧道**唯一**生产实现" |
| `docs/02-design/ARCHITECTURE.md §2.2` | `core` 行的 transport 描述加脚注 |

**为什么这是止血而不是收口**：下一个人读代码时，30 秒内就能知道该改哪个文件。**这 30 秒的成本，比后面任何重构都便宜**。

**验收判据**：

```bash
grep -c "当前交付链\|唯一生产实现" packages/core/src/transport/ssh-tunnel.ts \
  packages/core/src/transport/ssh-tunnel-ssh2.ts delivery/oh-tunnel.mjs
# 三个文件各 ≥1
```

### A-2 · 静默失败改响（F-02 Step 2 + F-14 Step 1）

**改动**：`host-sdk/src/skill-loader.ts` 两处。

**(a) `domains` 未知值 → warning**

```ts
const KNOWN = new Set<string>(CAPABILITY_DOMAINS);
const unknown = d.filter((x) => !KNOWN.has(x));
if (unknown.length > 0) {
  console.warn(`[winvm][skill] ${dir} 的 domains 含未知域 ${unknown.join(',')}（合法值：${[...KNOWN].join('/')}）`);
}
```

> 注意：**先只加 warning，不改 `VALID_DOMAINS` 的 4 值范围**。这样第一批跑完会立刻看到 4 个 skill 报警——这本身就是"现状可见"。改 6 值是第二批的事。

**(b) frontmatter 可疑形态 → warning**

遇到缩进块出现在非数组上下文、值以 `|`/`>` 开头等"像 YAML 但解析不了"的形态，warning 并列出该行号。

**验收判据**：

```bash
node -e "
const {loadSkillBundles}=require('./packages/host-sdk/dist/skill-loader.js');
loadSkillBundles('skills').then(bs=>console.log('loaded', bs.length));
" 2>&1 | grep -c "未知域"
# 期望 = 4
```

**实测会命中 4 个 skill**（本次已用等价脚本预验）：

```
hos-win-skill          -> meta
winvm-mcp-reference    -> meta
winvm-app-operation    -> appops
winvm-orchestrator     -> appops
```

> 注意第 4 个：`winvm-orchestrator` 声明 `[system, app, storage, gui, appops]`，前 4 个合法、`appops` 非法。所以它的 `domains` **不为 undefined，但会静默少一项**——这是最隐蔽的形态：看起来"有值"，实际丢了域。

**这条判据的价值**：它把 F-02 从"文档里的分析"变成"运行时能看到的事实"。第一批跑完，任何人跑一次就能看见 4 条报警。

### A-3 · 审批卡零接线加声明（F-05 Step 1）

**改动**：`adapter-host-workbuddy/src/approval-card.ts` 顶部：

```ts
/**
 * ⚠ 现状（2026-11-23 arch review / F-05）：
 * `fillApprovalCard()` 当前**无生产调用点**（仅单测）。审批卡的运行时填充
 * 由宿主 LLM 按 SKILL.md 门禁执行 —— 这是**提示词契约**，不是代码保证。
 *
 * 安装期（plan()）只做两件事：
 *   1. 把 APPROVAL_CARD_WIDGET_HTML 模板注入唯一 entry skill 的 references/；
 *   2. validate() 静态校验模板本身合法（无 MCP 续跑标记）。
 *
 * 因此 `validate()` 的"零残留占位符"断言实际只覆盖模板常量，**不覆盖运行时产物**。
 * 若 LLM 不照 SKILL 执行，最坏退化为纯文本审批提示（无放行面，但卡片交互失效）。
 *
 * 改进方向见 docs/design/proj-arch-review/04-FINDINGS.md F-05（方向 A：服务端返回结构化
 * approvalCard 数据，宿主只做搬运）。
 */
```

**验收判据**：`grep -c "无生产调用点" packages/adapter-host-workbuddy/src/approval-card.ts` ≥ 1。

### A-4 · 数字漂移修正（F-09 Step 1）

**改动**：5 处字面量。

| 文件:行 | 现值 | 改为 |
|---|---|---|
| `docs/02-design/ARCHITECTURE.md:132` | `<6 skills>` | `<10 skills>` |
| `docs/05-peripherals/DEPLOYMENT.md:12` | `connector + 6 skills` | `connector + 10 skills` |
| `delivery/install-host.mjs:1205` | 白名单 10 工具 | 白名单 25 工具 |
| `delivery/uninstall.mjs:36` | 8 connector skills | 10（+ 2 上游工具面） |
| `delivery/pack-release.mjs:779` | 8 个连接器 Skills | 10 个 |

**验收判据**：

```bash
grep -rn "6 skills\|8 connector skills\|8 个连接器\|白名单 10 工具" docs/ delivery/ packages/
# 期望：无输出
```

### A-5 · `dep-lint` 噪音压零（F-12 Step 2）

**改动**：`package.json` 加约定字段 + `dep-lint` 读它。

`packages/vm-service/package.json`：

```json
{
  "winvm": {
    "dynamicDeps": ["@winvm/adapter-agent-workbuddy", "@winvm/adapter-agent-workbuddy-llm"]
  }
}
```

`dep-lint` 命中 `dynamicDeps` ⇒ 跳过 `DECLARED_UNUSED` 判定。

同时扫 `.d.ts`：某依赖在 `dist/*.d.ts` 里有引用 ⇒ 归 `TYPE_ONLY`（新类别，默认静默计数）。

**验收判据**：

```bash
node scripts/dep-lint.mjs 2>&1 | grep "违规："
# 期望：违规：0 条（hard=0 warn=0 info=0）
```

**为什么放在第一批**：**零告警才有意义**。9 条噪音会训练人忽略这一节，那这条判据就废了。修它只需 1 小时，收益是让未来真正的 `DECLARED_UNUSED` 能被看见。

---

## 第二批 · 收口（预计 5-8 天）

**目标**：消除双实现、补齐关键接线、把可数事实搬进常量。**允许动结构，但不动主装配**。

### B-1 · 域模型统一为 6 值并给消费点（F-02 Step 1/3/4）

这是第一批 A-2 的延续——A-2 只让问题可见，B-1 才修。

**Step 1**：`contracts/src/host.ts`

```ts
import type { CapabilityDomain } from './capability.js';
/** Skill 的领域归属 —— 与 CapabilityDomain 同一集合（原为 4 值子集，导致 appops/meta 被静默丢弃）。 */
export type SkillDomain = CapabilityDomain;
```

**Step 2**：`skill-loader.ts` 删本地 `VALID_DOMAINS`，改用 `CAPABILITY_DOMAINS`。A-2 加的 warning 保留（防未来再出现未知值）。

**Step 3（关键）**：**给出消费点**。三选一，必须选一个：

- **选项 ①（推荐，成本最低）**：`validateNeutralPlugin` 增加一致性校验

```ts
// 每个 skill 声明的 domains 必须被已注册能力的域覆盖
// entry skill 必须覆盖全部 6 域
if (s.domains && s.domains.length > 0) {
  const bad = s.domains.filter((d) => !CAPABILITY_DOMAINS.includes(d));
  if (bad.length > 0) push('error', `Skill ${s.id} 的 domains 含未知域：${bad.join(',')}`, `skills.${s.id}.domains`);
}
```

- **选项 ②（成本中等）**：渲染时按 `domains` 给 SKILL.md 追加"本 skill 覆盖的能力 ID 清单"

- **选项 ③**：删掉 `domains` 字段（如果两个都不做，留着就是误导）

**验收判据**：

```bash
# ① 若选选项 1/2
node -e "
const {loadSkillBundles}=require('./packages/host-sdk/dist/skill-loader.js');
loadSkillBundles('skills').then(bs=>{
  const bad=bs.filter(b=>!b.domains||b.domains.length===0);
  console.log('无 domains 的 skill:', bad.map(b=>b.id).join(',')||'(无)');
});
"
# 期望：agent-browser-skill / agent-desktop-skill（这两个本来就没声明）+ 若选了选项1则其余全有

# ② 门禁
node scripts/gate.mjs --quick   # 全绿
```

### B-2 · `DELEGATION_REQUIRED` 加结构化字段（F-06 Step 2）

**改动**：`vm-service/src/server.ts` 的收口点 + `contracts` 的错误 details 类型。

```json
{
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
```

**价值**：调用方（含 LLM）能自己发现该走哪条路，不需要读文档。这是"错误信息即文档"的做法。

**同时必须做的**：F-06 Step 1 的决策——写进 `02-design` 一条 ADR，明确"直调续跑"是废弃还是保留。**不写这条，B-2 改完仍然语义不明**。

**验收判据**：

```bash
# 真机或本地：直调一个 L2 能力
winvm-plugin command system.service.control --args '{"name":"x","action":"start"}'
# 期望：错误体含 details.delegateTool == "a2a.delegate"
```

### B-3 · HostRenderer 产物面收口（F-04）

**Step 1（先做，低成本）**：extraFiles 双源合一

新建 `delivery/host-runtime-files.mjs`：

```js
/** 插件运行时依赖（必须在 pluginRoot 下就位；绕过 Renderer 的清单唯一事实源）。 */
export const HOST_RUNTIME_FILES = Object.freeze([
  'winvm-plugin.mjs', 'oh-tunnel.mjs', 'ssh2-resolve.mjs', 'ssh2-client.mjs',
  'ssh2-backend.mjs', 'tunnel-daemon.mjs',
  'hooks/hooks.json', 'hooks/session-start.sh', 'account-resolve.mjs',
]);
```

`install-host.mjs:217` 与 `:1362` 都 import 它。

**Step 2（结构性）**：把两类绕过纳入 `plan()`。

`NeutralPlugin` 新增：

```ts
readonly runtimeFiles?: readonly { readonly src: string; readonly destRel: string }[];
readonly globalMcpEntries?: readonly ConnectorDecl[];
```

`WorkBuddyRenderer.plan()` 转成 `PlannedFile[]` + 指向 `~/.workbuddy/mcp.json` 的额外 `JsonPatch`。

**Step 3**：`validate()` 加断言——`install-host.mjs` 里不允许裸 `cpSync` 到 pluginRoot。

**验收判据**：

```bash
# Step 1
grep -c "HOST_RUNTIME_FILES" delivery/install-host.mjs   # ≥2（import + 使用）

# Step 2
node delivery/install-host.mjs --dry-run 2>&1 | grep -c "全局 mcp.json"
# 期望：dry-run 输出里出现"全局 mcp.json"（说明 plan 覆盖了它）

# Step 3
grep -n "cpSync" delivery/install-host.mjs
# 期望：无裸 cpSync 到 pluginRoot（除 deployWinvmPlugin 内部）
```

### B-4 · `delivery` 加静态检查（F-07 Step 2）

**改动**：`scripts/script-lint.mjs`（新），三条判据：

1. `import` 路径存在性——`from './x.mjs'` 的文件必须存在
2. 硬编码危险路径——`/tmp/`、`C:\\Users\\`、`/Users/` 出现在非注释行 ⇒ 报错
3. 无 guard 的递归删除——`rmSync(p, {recursive:true})` 前后 3 行内必须有 `if`/`?`/`try` 或 `dryRun` 判定

接入 `gate.mjs` 的 ST2c。

**为什么这三条**：都是**真实踩过的坑**（鸿蒙 `/tmp` 只读、`rm` shim 缺 bash、宿主机路径 ≠ VM 路径）。机检化能防回归。

**验收判据**：

```bash
node scripts/script-lint.mjs
# 期望：PASS（或列出真实问题，逐条修）
```

### B-5 · 可数事实搬进常量（F-09 Step 2）

**改动**：新建 `packages/contracts/src/facts.ts`：

```ts
/** 交付事实的唯一来源。文档与门禁都引用此常量，禁止写裸数字。 */
export const SKILL_CATALOG = Object.freeze({
  total: 10,
  breakdown: {
    orchestrator: 1,      // winvm-orchestrator
    domain: 5,            // system/app/storage/gui/appops
    reference: 1,         // winvm-mcp-reference
    hostDispatch: 1,      // hos-win-skill
    upstreamToolface: 2,  // agent-browser / agent-desktop
  },
});

export const CAPABILITY_COUNT = Object.freeze({
  total: 54,
  byDomain: { meta: 3, system: 14, app: 8, storage: 13, gui: 11, appops: 5 },
  byRisk: { L0: 27, L1: 19, L2: 7, L3: 1 },
});

export const DESKTOP_TOOL_ALLOWLIST_SIZE = 25;
```

`selfcheck.sh` 加断言：

```python
# 文档里的"N 个 skill"必须等于 SKILL_CATALOG.total
for doc in ['docs/02-design/ARCHITECTURE.md', 'delivery/install-host.mjs', ...]:
    for m in re.finditer(r'(\d+)\s*(?:个\s*)?(?:connector\s*)?skills', read(doc)):
        if int(m.group(1)) != SKILL_TOTAL: bad.append(...)
```

**这条的价值**：这是**唯一能防住数字漂移的机制**。靠人肉检查迟早再漂——本仓已经漂了 4 处。

**验收判据**：

```bash
bash scripts/selfcheck.sh 2>&1 | tail -3
# 期望：ALL_GREEN checks=N fails=0（N 增加）
```

---

## 第三批 · 重构（预计 8-12 天）

**目标**：纯结构，行为零变化。每步单独可验证。

### C-1 · `server.ts` 分批抽出（F-03）

严格按 B1→B5 顺序，**每批一次 commit + 一次 gate --quick**。

| 批次 | 抽出 | 目标文件 | 行数 | 风险 |
|---|---|---|---|---|
| B1 | `VmApprovalCoordinator` | `approval-coordinator.ts` | 337 | **零**（纯搬运，已导出） |
| B2 | `buildHealth()` | `health-snapshot.ts` | 280 | 低（依赖注入现成） |
| B3 | 路由分发 | `router.ts` | 210 | 中（守卫插入位置纪律） |
| B4 | MCP tools 组装 | `mcp-tools.ts` | 115 | 中（audit 包装） |
| B5 | `buildPreview`/`collectImpact`/`hasDryRunParam` | `preview.ts` | 84 | 低（纯函数） |

**合计 1026 行**，`server.ts` 降到 ~1800，`createService` 降到 ~1180。

**关键纪律**：

- **B1 先做**，因为零风险，能把"纯搬运"的流程走通一遍
- **B3 要特别小心**：`server.ts:2139-2150` 那段注释（守卫必须在所有路由分发之前）是**血泪教训**，抽出时必须把注释一起搬，且加单测断言"`/admin/llm-session/reset` 不可绕过守卫"
- **不要一次抽完**：2185 行里有很多注释记录的隐性约束（顺序、fail-closed、零回归），一次性搬容易丢

**验收判据**（每批）：

```bash
wc -l packages/vm-service/src/server.ts         # 应逐步下降
node scripts/gate.mjs --quick                    # 全绿
bash scripts/selfcheck.sh | tail -1              # ALL_GREEN
# 真机（批次收官时）：
# winvm-plugin health → 200，探针 34/34
```

### C-2 · 拆 `host-a2a-bridge/src/tools.ts`（F-08）

一工具一文件：

```
tools/delegate.ts        491 行起（最大，包含进度轮询 + 审批翻译 + 收尾反查）
tools/task-get.ts        697 行起
tools/approval-reply.ts  769 行起
tools/task-cancel.ts     827 行起
tools/health.ts          896 行起
tools/index.ts           汇总导出
```

**价值**：`a2a.delegate` 是**唯一**需要深度理解的工具（其他 4 个都简单）。单独一个文件后，review `delegate` 的逻辑不用在 1031 行里翻。

**验收判据**：`wc -l packages/host-a2a-bridge/src/tools/*.ts` 每个 ≤ 500；gate 全绿。

### C-3 · 拆 `adapter-agent-workbuddy/src/index.ts`（F-08）

按能力域拆：

```
system-ops.ts     system 域 14 个能力
app-ops.ts        app 域 8 个
storage-ops.ts    storage 域 13 个
gui-ops.ts        gui 域 11 个
appops-ops.ts     appops 域 5 个
index.ts          只留 provider 接口实现（init/execute/runGoal/declareCapabilities）
```

**注意**：这个包是**确定性执行器**，逻辑相对直白（capability id → ps-bridge 调用），拆分风险低。

**验收判据**：`index.ts` ≤ 400 行；gate 全绿；真机 `VERIFY=PASS`。

### C-4 · 拆 `delivery/setup.mjs`（F-08）

按步骤拆：

```
setup/index.mjs      只做编排与参数解析
setup/build.mjs      BUILD 段
setup/host.mjs       HOST 段
setup/vm.mjs         VM + VM-START 段
setup/tunnel.mjs     TUNNEL 段
setup/verify.mjs     TEST + HEALTH 段
```

**特别值得做**：`delivery/*.mjs` 无类型、无门禁，拆小后 review 成本显著下降。

**验收判据**：`node delivery/setup.mjs --uninstall`（dry-run）输出与拆前逐字一致。

### C-5 · `ps-bridge.ps1` 加自检 + `app.ps1` 拆分（F-10）

**(a) 自检子命令**

```powershell
# powershell -File ps-bridge.ps1 -SelfTest
# 校验：6 模块可加载 / 函数签名齐备 / UTF-8 编码 / StrictMode 生效
```

在 `install-vm.mjs` 部署尾部调用，失败告警。

**(b) `app.ps1` 1209 行拆成 4 个**

```
app-winget.ps1      winget 相关
app-appx.ps1        appx 相关
app-shortcut.ps1    快捷方式
app-process.ps1     进程
```

**验收判据**：真机 `DEPLOY=PASS` + 54 能力探针全通。

---

## 4. 建议的排期与依赖关系

```
第一批（1-2d）   A-1 ─┬─ A-2 ──┐
                     ├─ A-3   │
                     ├─ A-4   │
                     └─ A-5 ──┤
                              ▼
第二批（5-8d）   B-1 ◀────────┘（A-2 才能让 B-1 的修复可验证）
                 B-2（独立）
                 B-3（独立，Step1 可先做）
                 B-4（独立）
                 B-5 ◀── A-4（先修正数字，再搬进常量）

第三批（8-12d）  C-1 ─┬─ 严格串行 B1→B5
                     │
                 C-2 ◀─ 无依赖，可并行
                 C-3 ◀─ 无依赖，可并行
                 C-4 ◀─ 无依赖，可并行
                 C-5 ◀─ 无依赖，但需真机
```

**关键依赖只有两条**：

1. **A-2 → B-1**：不加 warning 就看不到 4 个 skill 报警，B-1 改完无法验证是否真的修好。
2. **A-4 → B-5**：先把错数字改对，再把"对数字"搬进常量。否则会把错数字固化成常量。

其余全部可并行。

---

## 5. 明确"不建议做"的事

避免下一个人或下一轮 agent 走弯路：

| 想法 | 为什么不建议 |
|---|---|
| **删掉 `core/transport/ssh-tunnel*.ts`** | 有单测覆盖、`dep-lint` 绿色。删了可能触发连锁（`core/index.ts` 导出、`contracts/transport.ts` 类型引用）。**先加注释（A-1）**，决策留到后续单独一轮。 |
| **把 `delivery/*.mjs` 全改写成 TS** | 16059 行改写，收益（类型检查）可以用 `tsc --checkJs` + JSDoc 白嫖。成本收益比极差。 |
| **引入 Pester 测 PowerShell** | VM 侧环境复杂、CI 无 Windows 容器。**用 `-SelfTest` + Node 侧契约测试**（C-5）替代 90% 的收益。 |
| **引入 `yaml` 包替换手写 frontmatter 解析** | 只在构建期用、10 个 skill 都没超出现有能力。**先加 warning（A-2）**，等真的有人写出复杂 frontmatter 再说。 |
| **给 `domains` 做完整的域路由引擎** | 当前无消费需求。B-1 的第一步只是"让字段不再静默丢失"，不是"实现域路由"。 |
| **把 `approval-card.ts` 的 700 行 HTML 常量拆成独立 `.html` 文件** | 需要构建期资源内联，`tsc` 不直接支持。**先接线（B-2 方向）**，接线后如果 HTML 还要改再考虑。 |
| **删掉 MCP 续跑令牌机制** | 必须先做 F-06 的存废决策（写 ADR）。**决策前不动代码**。 |

---

## 6. 本路线不解决的问题（诚实登记）

以下问题超出"架构优化"范畴，本路线不碰，需要单独立项：

1. **真机端到端验证的自动化**。当前靠 `qa/real-test-*.md` 人工记录。本路线每批都要求真机 `VERIFY=PASS`，但**没有自动化闭环**。
2. **`adapter-agent-workbuddy-llm/src/bridge.ts`（1892 行）的逐分支复审**。本次只做结构级阅读。这是全部包里风险最高的一块（LLM 驱动 + 行为不确定 + 代码量最大），建议单独做一次专项复审。
3. **`app.ps1`（1209 行）的能力实现逐函数核验**。同上。
4. **跨版本兼容策略**。`/health` 有 9 个区块、`/mcp` 有 54 个工具、A2A 有 5 个工具——这些对外契约的版本化策略没有文档。
5. **`delivery/publish-release.mjs` 的双源发布流程**。本次未审。

---

## 7. 一句话执行建议

**先做第一批，一天就够**。做完之后团队会立刻有两个变化：

1. 读 `core/transport/ssh-tunnel.ts` 的人 30 秒内知道该改 `delivery/oh-tunnel.mjs`（不用再白花半天）
2. 跑一次 skill 加载就能看见 4 个 skill 的 `domains` 丢了（问题从"文档里的分析"变成"屏幕上的事实"）

**这两个变化的成本是 1 天，收益是此后每次接触这块代码的时间**。第二批第三批的收益更大，但成本高一个量级，应该排到有明确时间窗的迭代里。