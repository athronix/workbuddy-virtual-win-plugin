# CL-K3R · 技术方案（TECHNICAL-SOLUTION）

> 对应 `REQUIREMENT.md`。含推荐组合（S1 主 + S2 副 + R3 归因）的落地形态、逐任务改动、`Phase D` 阻塞修复的代码与分析、灰度开关链路（Route A 逐跳）、运行时指纹（E-3/E-3b）、风险与回滚、以及可复跑的验证序列。
> 引用口径：**段标签为主、行号为辅**（并行改动会让行号漂移）。本文行号以 CL-K3R 收尾状态为准，并标注关键落点的段标签。

---

## 0. 推荐组合与决策依据（一句话）

> **S1（直读服务端 `pendingApprovals`）主通道 + S2（账本 `blockedEntries`）副证据 + R3 窗口归因兜底**，以**同进程注入探针**交付；**不动 MCP 协议、不动 CLI 契约、不动 `a2a-framework`（D-4）、不改 `APPROVAL_WAIT_PATTERN`（只把它降级为兜底）**。

### 0.1 为什么不选「让 MCP 工具结果本体上行」（C-5）

| # | 理由 |
|---|---|
| 1 | **物理上绕远**：工具结果在 `codebuddy` **子进程**里，桥只见 stdout；要拿到必须让 CLI 以机器可读格式输出调用记录，而 `--output-format json\|stream-json` 是 **codebuddy 自有格式**（受外部版本约束）⇒ 重蹈「依赖外部措辞」的覆辙，只是换了依赖对象 |
| 2 | **仍是「转述」**：那是 CLI 运行时的转述，不是**拦截发生地**的账本；`risk` 权威值仍在服务端 |
| 3 | **成本 / 收益**：C-5 要改 CLI 参数模板 + 输出解析 + 兼容层；S1+S2 只加「同进程注入探针 + 一套归因规则」，且**完全复用** K-N1 已落地的 `DelegationTruthProbe` 注入范式 |

### 0.2 五通道盘点摘要

| # | 通道 | 桥侧可见性 | 判定 |
|---|---|---|---|
| **C-1** | LLM 最终文本 | ✅ 唯一在用 | ❌ **缺陷根源**（纯文本，靠正则抠 `approvalId`/`capabilityId`/`risk`，抠不到兜底 `'L2'`） |
| **C-2** | `pendingApprovals` Map（`server.ts:528`（实测；设计文档记为 `:512`，已漂移），同进程） | ❌→可补 | ⭐ **主通道**（字段最完备、含 `risk` 权威值） |
| **C-3** | `DelegationLedger.blockedEntries` | ⚠ 经 probe 只暴露**计数** | ⭐ **副通道**（已入哈希链，取证最强；但 fire-and-forget 写链，可能晚一拍 ⇒ **只能作副） |
| **C-4** | 哈希链审计条目 | ❌ 桥不可见 | 取证用，不宜作判定输入（IO + 脱敏开销） |
| **C-5** | MCP 工具结果本体 `structuredContent` | ❌ 桥根本看不到 | ❌ 不可行（见 §0.1） |

---

## 1. 收口链上新判据的插入点

```
runGoalInner
  └─ runGoalCore → runPersistent / runOneShot
        ├─ 【★ if (!turn.ok)】CL-K3R Phase D 修复：先甄别「审批暂停态」vs「真执行失败」
        │      （见 §4；shadow 仅 warn，on/off 命中才经 maybeResume 改判）
        └─ reconcileApprovalTruth(base, finalText, deps)   ← ★ T03 插入点（maybeResume 之前）
              ├─ 结构化优先：probe.approvalWait(...) 有未决事实 ⇒ 改判 ok:false + APPROVAL_REQUIRED
              └─ 结构化无事实/退场 ⇒ 回退 reconcileApprovalWait(base, finalText)（**原文不动**）
        └─ maybeResume(...)                                 ← 读 base.error，未动
  └─ reconcileDelegationTruth(...)                          ← K-N1，未动
  └─ reconcileExecutionTruth(...)                           ← K5 + **D-1 两道门，未动**
```

**为什么必须放在 `maybeResume` 之前**：`maybeResume` 的 `blocked` 只读 `base.error` 的结构化字段。只有让 `base.error.code === 'APPROVAL_REQUIRED'` 且 `details.approvalId` 有值，`blocked` 才为真 ⇒ 才会 raise ⇒ 才会挂起。
⇒ **新判据的唯一职责就是「把服务端事实翻译成 `base.error`」**，从而让**既有**的 raise/挂起/重放链路原样工作。

---

## 2. 逐任务改动

### T01（`748ca8d`）· 契约与取证底座

| 文件 | 落点 | 动作 |
|---|---|---|
| `packages/contracts/src/bridge.ts` | `DelegationTruthProbe` 段 | **C-K1**：追加**可选**成员 `approvalWait?(q: ApprovalWaitQuery): Promise<readonly PendingApprovalFact[]>` |
| 同上 | 其后 | **C-K2** `ApprovalWaitQuery { delegationTraceId, startedAtMs, capabilities? }`；**C-K3** `PendingApprovalFact { approvalId, capabilityId, risk, createdAtMs, attribution:'exact'\|'window', hostApproved, summary? }` |
| `packages/core/src/constants.ts` | `ENV_APPROVAL_REPLAY` / `resolveApprovalReplay` 旁 | `ENV_APPROVAL_TRUTH = 'WINVM_APPROVAL_TRUTH'` + `resolveApprovalTruth(env)`（只认三态，**非法/缺席一律回退 `'on'`**） |
| `packages/vm-service/src/delegation-audit.ts` | `LedgerRegistry` / `DelegationLedger` | `blockedFor(q)`（R1/R2/R3 严格有序）、`recordBlocked(...)` 窗口归因入口、`blockedFacts()`；窗口边界与既有 `inWindow`/`isExposed` **同源**，不另写阈值 |

**非破坏性论证**：TS 结构化类型下，既有实现方不实现可选 `approvalWait` 仍通过；既有单测桩合法；桥侧以 `'approvalWait' in probe && probe.approvalWait` 守卫（门 3）。

### T02（`fa8038e`）· 服务端探针与注入

```ts
// packages/vm-service/src/server.ts —— delegationProbe 字面量内
approvalWait: async (q) => [
  ...collectApprovalFacts(this.pendingApprovals, q, Date.now()),  // S1 主通道
  ...ledgerReg.blockedFor(q),                                      // S2 副通道（已入哈希链）
],
```

- `collectApprovalFacts`（`packages/vm-service/src/approval-replay.ts`）为**纯函数**：只返**未决项**（`hostApproved !== true`；已批准/超时已被服务端 delete）、R1 精确 / R2 精确排除 / R3 窗口兜底 + 能力面过滤、按 `createdAtMs` 升序。
- 拦截记账处补窗口归因（`ctx.delegationId` 缺失时经 `ledgerReg.recordBlocked` 窗口分发）⇒ **常驻路径 `blockedEntries` 不再恒空**（补 V-3）。
- `packages/vm-service/src/index.ts` re-export `collectApprovalFacts` / `PendingApprovalFact`。

### T03（`be90be2`）· 桥侧判据与接线

**判定表（`packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts`，自上而下短路）**

| 门 | 条件 | 动作 | 理由 |
|---|---|---|---|
| **门 0** | `!base.ok` | **透传** | 已是失败态，不重复改判（让 D-1 结论优先） |
| **门 1** | 无 `taskId` | 回退文本启发式 | SK-1：无归属 ⇒ 不介入（纯 MCP 直调/单测） |
| **门 2** | 灰度开关 `= off` | 回退文本启发式 | 一键回滚面 |
| **门 3** | 无 `probe` 或 `probe.approvalWait` 缺席 | 回退文本启发式（**绝不 warn**，避免单测刷屏） | 兼容旧服务端 / 单测 / degraded |
| **门 4** | `probe.approvalWait(...)` 抛错 | 回退 + **warn 恰一条** | 对齐既有 fail-open 纪律 |
| **门 5** | `facts.length === 0` | 回退文本启发式 | 结构化说「无未决审批」时绝不强行改判 |
| **门 6** | 所有 fact 已在 `ctx.raised` **且尚无服务端回执** | 回退（跳过该 fact） | 已有回执 ⇒ **不跳过**，令 `maybeResume` 走 `applyReceipt` 以真实回执收口（E-1 勘误） |
| **命中** | 存在未 raise 的未决 fact | **改判** | ★ K3 根治 |

> **⚠ 门 0 是本项最容易被忽略的约束**：`packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts` **`reconcileApprovalTruth` 起始 `:225`，门 0 在 `:230`** ——
> ```
> 225: export async function reconcileApprovalTruth(
> 226:   base: LlmGoalResult,
> 227:   finalText: string,
> 228:   deps: ApprovalTruthDeps = {},
> 229: ): Promise<LlmGoalResult> {
> 230:   if (!base.ok) return base; // 门 0：已是失败态（含 D-1 两道门的结论）→ 绝不重复改判
> ```
> （行号为当前 HEAD 直接读文件实测。注：同文件 `:84` 另有一个 `if (!base.ok) return base; // 门 1`，属于**另一个函数** `reconcileDelegationTruth`（起始 `:79`）—— 两处 `return base` 语义相近但分属 K-N1 与 K3R 两条判据，引用时勿混。）
> —— 这正是 **§4 的 `!turn.ok` 分支不能调用 `reconcileApprovalTruth`** 的根本原因（对 `ok:false` 的 `failedBase` 会直接透传、绝不改判）。

**改判产出（字段全为服务端权威值）**

```ts
{
  ...base,
  ok: false,
  // 与 reconcileApprovalWait 共用**同一前缀**（保 A5 终态指纹可比对，SK-9），
  // 仅以可区分后缀标记来源，便于取证归因
  summary:
    `等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED），目标「${base.summary}」未执行完成，` +
    `须经宿主人工审批后经 MCP 直调通道续跑；approvalId=${fact.approvalId}` +
    `（来源=服务端结构化判定·${fact.attribution}）`,
  steps: base.steps.map((s) => ({ ...s, ok: false, summary: '等待审批（未执行完成·服务端结构化判定）' })),
  error: makeError('APPROVAL_REQUIRED', '服务端结构化记录显示存在未决审批，操作未执行', {
    details: {
      approvalId: fact.approvalId,
      capabilityId: fact.capabilityId,
      risk: fact.risk,                 // ★ 服务端策略引擎权威值（顺带根治文本正则扣 risk）
      attribution: fact.attribution,   // 'exact' | 'window'
      source: 'server-ledger',
      ...(rest.length ? { others: rest.map((f) => f.approvalId) } : {}),
    },
  }),
}
```

**桥侧接线**（`bridge.ts` `~:779-795`，`runPersistent` / `runOneShot` 两处共用）：

```ts
private async reconcileApprovalTruth(base, finalText, input, ctx): Promise<LlmGoalResult> {
  return reconcileApprovalTruthPure(base, finalText, {
    input, ctx,
    enabled: this.approvalTruthEnabled,
    reconcileApprovalWait,                                  // E-2：同一函数引用显式注入（SK-9 落点不变）
    ...(this.approvalTruthShadow ? { shadow: true } : {}),   // E-5
    warn: input.warn ?? this.onSessionLog ?? undefined,
  });
}
```

### E-2（`95052d5`）· 依赖注入去静态环

`reconcileApprovalWait` 原是 `bridge.ts` 模块内**非导出**函数，纯逻辑件复用它会形成循环。**owner 裁定：不许搬函数**（搬走即破坏 SK-9 落点与 A5 指纹比对基准）。改法：
- `deps.reconcileApprovalWait` 由 `bridge.ts` 在两处收口点**显式传入**（第一级）；
- `registerApprovalWaitFallback(reconcileApprovalWait)` 在 `bridge.ts` 模块加载时注册**默认兜底**（第二级），使单测等直接调用方仍能拿到与生产同一份实现；
- `delegation-truth.ts` 因此**不再 import `bridge.ts`**（编译后 dist 零反向边；`src` 仅剩 `import type`，编译期擦除）。

**加载序显式验证**（三种加载序，`cl-k3r-impl-progress.md` §5.5）：序 A 包入口先 → 文本兜底生效；序 B truth 先再 bridge → 文本兜底生效；序 C 仅加载 truth → **降级透传、不抛、不改 `ok`、返回同一 base**。

### E-2b（`c3899d4`）· 第三级兜底可观测

```ts
const fallback = deps.reconcileApprovalWait ?? approvalWaitFallback;   // 第三级：恒等透传
const runFallback = (gate, b, text) => {
  if (!fallback) {
    deps.warn?.('[k3r] 文本兜底缺席（未注入且未注册）→ 恒等透传，等同无兜底旧行为', {
      gate, hasTaskId: !!taskId,                                        // gate ∈ 门1/门2/门3/门5/门6
    });
    return b;                                                           // 判定逐字不变
  }
  return fallback(b, text);
};
```
- **gate 枚举刻意不含门 4**（探针异常已有自己的 warn，按「恰一条」纪律不叠加）。
- shadow 对拍路径用 `fallbackOrIdentity`（恒等透传**不 warn** —— 该路径已有 `[shadow]` 指纹）。
- **可达性分析**：第三级仅对「深层直接 import `delegation-truth.js` 且未加载 `bridge.js`」的调用方可达；**生产路径**（两处收口点显式注入）与**包出口路径**（`index.ts:35` 值 import `bridge.js` ⇒ 加载期触发注册）均**不可达** ⇒ 这是**已知且刻意保留**的降级面（纯逻辑件可独立单测），**非 K3 回归面**。

### E-3（`614c6ad`）· `/health` 三态运行时指纹

```ts
// packages/contracts/src/bridge.ts —— HealthStatus 顶层追加（纯附加；字面量联合，不得 import @winvm/core）
readonly approvalTruth?: {
  readonly mode: 'on' | 'shadow' | 'off';
  readonly enabled: boolean;
  readonly shadow: boolean;
};
```

```ts
// packages/adapter-agent-workbuddy-llm/src/index.ts —— 构造期一次性解析（health() 零 process.env 重读）
const approvalTruthMode = opts.approvalTruth ?? resolveApprovalTruth(process.env);
this.approvalTruthEnabled = approvalTruthMode !== 'off';
this.approvalTruthShadow  = approvalTruthMode === 'shadow';
// 取值：shadow === true ⇒ 'shadow'；否则 enabled ? 'on' : 'off'
```

三态自证（`wbtmp/e3-fingerprint.mjs`，不入库）：

```
mode=on     → approvalTruth={"mode":"on","enabled":true,"shadow":false}
mode=shadow → approvalTruth={"mode":"shadow","enabled":true,"shadow":true}
mode=off    → approvalTruth={"mode":"off","enabled":false,"shadow":false}
PASS: 3/3 档逐字对应（mode/enabled/shadow），三态互异，构造期解析同源。
```

### E-3b · 指纹实际出口是**顶层** `providerApprovalTruth`

> **T05 真机 Phase B 实测发现**：`/health` 上看不到 `provider.approvalTruth`，实际出口是**顶层** `providerApprovalTruth`（旧构建无此字段）。
> **修复机制的成因未在报告中记录，待核实**；可确证的只有「出口在顶层」这一实测事实。
> **Runbook §2 G4 的假设路径（`provider.approvalTruth`）需修正为顶层 `providerApprovalTruth`** —— 这是本项最容易被后续复跑者踩中的路径坑。

---

## 3. 灰度开关切换链路（Route A，逐跳已核）

不走机器级环境变量，改**运行时配置文件**的 provider options：

| 跳 | 落点 | 事实 |
|---|---|---|
| 1 | `delivery/.generated/vm-service.runtime.json` → `agent.providers.workbuddy.options.approvalTruth` | 手改点 |
| 2 | `packages/core/src/config/index.ts:242` `providers: { ...defaults, ...parsed.agent.providers }` | provider 级**浅合并** ⇒ `workbuddy` 条目整体来自配置文件，**未知键原样保留** |
| 3 | `packages/core/src/config/index.ts:201 validateServiceConfig` | 只校验 host/回环、provider 存在性、port、`probeIntervalMs`，**不拒绝 options 未知键** |
| 4 | `packages/vm-service/src/cli.ts:119` `await factory(entry.options ?? {})` | options 原样交给 `createProvider` |
| 5 | **`packages/adapter-agent-workbuddy-llm/src/index.ts:171`**（实测；设计文档记为 `:176`，已漂移）/ `src/bridge.ts:767` | `const approvalTruthMode = opts.approvalTruth ?? resolveApprovalTruth(process.env);` —— **显式配置优先**。同文件实测补充：readonly 字段 `:162`、注入 bridge 的 `approvalTruth: approvalTruthMode` `:187`、E-3 的 `/health` 三态取值 `:258-261` |

**重启用 `C:/WinVMBridge/kill-restart.ps1`**（实测内容：kill 18443 端口属主 + ps-bridge → `schtasks /End` → `schtasks /Run`）：
**它不重跑 `install-vm` ⇒ 不会重新生成 `.generated/` ⇒ 手改的配置不会被覆盖。**
> 对照：若改用 `deploy-vm.mjs --apply`，`install-vm` 会**重新生成**运行时配置，手改即失效。⇒ **顺序必须是「先部署 → 后打补丁 → 再用 kill-restart 重启」**。

---

## 4. Phase D 阻塞修复（`runPersistent` 的 `!turn.ok` 分支）

### 4.1 两条路径的关键差异（这是 bug 只在 persistent 路径的原因）

| 路径 | codebuddy 调用形态 | 审批挂起的表现 | `turn.ok` |
|---|---|---|---|
| `runPersistent` | **stream-json**（常驻会话） | 回吐 `result` 事件并置 **`is_error=true`** | **false** |
| `runOneShot` | `-p text`（单次） | 正常 stdout 文本（exit 0、`is_error=false`） | **true** |

⇒ **Phase D 的 bug 只在常驻（生产主路径）命中。**

### 4.2 已确认事实（`k3r-t05-phase-d-blocker-2026-10-05.md` §2）

| # | 事实 |
|---|---|
| **F1** | **鉴权不是阻塞原因（已排除）**：持久会话生成的 `mcp.json` 由 `buildMcpConfig` 产出，**不含任何鉴权头**；winvm `/mcp` POST 处理器（`server.ts:1043-1058`）**不校验 `security.tokenEnv`** ⇒ 服务端不强制 bearer，codebuddy 可达工具 |
| **F2** | **单次 `-p`（文本）路径下目标会被正确处理**：`codebuddy` v2.x 以 `-p text` + `--permission-mode bypassPermissions` + `--mcp-config` 调用 `app.winget.uninstall` ⇒ 服务端回吐 `APPROVAL_REQUIRED`（服务端审批 id **`apr_8379ba256c2c4379921f`**）、操作**未实际执行**；codebuddy 以**正常 stdout 文本**回吐（含 `APPROVAL_REQUIRED` 字样）⇒ `runOneShot` 路径下文本启发式**能命中**并正确转 `input-required` |
| **F3** | **常驻会话路径下同一回合返回 `is_error=true`**：真机日志 `winvm-service-2026-10-05.log` 记 `[llm-session] LLM 常驻会话就绪` → `[llm-session] LLM 常驻会话轮次完成 durationMs=1723 ok=false`（= `result.is_error=true`，见 `persistent-session.ts:772-781`） |
| **F4** | **桥侧确认**：修复前 `bridge.ts:1236-1246` 为 `if (!turn.ok) { return { result: { ok:false, ..., error: makeError('EXECUTION_FAILED','LLM_PERSISTENT_TURN_FAILED') } }; }` —— `reconcileApprovalTruth` / `reconcileApprovalWait` **只在 `turn.ok` 分支执行**（原 `:1248-1277`）⇒ `!turn.ok` 一律判 `EXECUTION_FAILED`，**漏掉「审批暂停态被误标 is_error」** |

### 4.3 修复后的代码（`bridge.ts:1236` 起，实测锚点）

```ts
if (!turn.ok) {
  // CL-K3R Phase-D 修复：常驻会话 turn 失败时，先甄别「审批暂停态」vs「真执行失败」。
  // codebuddy 安全策略会在调用 winvm 工具**之前**拦截高危操作，并以 is_error=true 的
  // result 事件上报（含 APPROVAL_REQUIRED 文案 + apr_ token），从而 turn.ok=false。
  // 此时若文本命中审批等待模式，应改判为 ok:false + APPROVAL_REQUIRED 并经 maybeResume
  // 路由到 input-required；否则才视为真正的执行失败。文本启发式是既有 K3 机制（非新建
  // 结构化探针），语义与 ok:true 路径的兜底**逐字一致**——
  //   · on/off：结构化探针退场/缺席时本就回退文本启发式 ⇒ 此处直接套用（与 one-shot 一致）；
  //   · shadow：结构化探针仅 warn 不改判，文本启发式也须同步**仅 warn 不改判**（G4 纪律），
  //     故 shadow 态下保持 EXECUTION_FAILED 以「观察」修复前假失败，待切 on 才真正改判。
  // 注：本分支不调 reconcileApprovalTruth（其「门 0：!base.ok 透传」纪律会拒绝 ok:false），
  // 故直接复用既有的 reconcileApprovalWait 文本启发式。
  const failedBase: LlmGoalResult = {
    ok: false,
    summary: `LLM 运行时（常驻会话）未完成目标：${turn.error ?? '未知原因'}`,
    artifacts,
    steps: [],
    error: makeError('EXECUTION_FAILED', 'LLM_PERSISTENT_TURN_FAILED'),
  };
  const reconciled = reconcileApprovalWait(failedBase, turn.text);
  const isApprovalWait = reconciled.error?.code === 'APPROVAL_REQUIRED';
  if (this.approvalTruthShadow) {
    this.onSessionLog?.('[shadow] 常驻会话失败态命中审批等待文本模式（不改判，供对拍）', {
      taskId: input.taskId,
      textHeuristicVerdict: isApprovalWait ? 'waiting-approval' : 'not-waiting',
    });
    return { result: failedBase };
  }
  if (isApprovalWait) {
    return { result: await this.maybeResume(reconciled, input, sink, ctx, 'persistent') };
  }
  return { result: failedBase };
}
```

### 4.4 与原「建议修复」的关键偏差（必须记录）

原 §5 建议「在 `!turn.ok` 分支调 `reconcileApprovalTruth` 兜底」。**该方案是 no-op**：
`reconcileApprovalTruth`（`delegation-truth.ts` `:230`）有 **门 0：`if (!base.ok) return base;`** —— 对 `ok:false` 的 `failedBase` **直接透传、绝不改判**（D-1 两道门结论优先）。
⇒ 正确做法是**直接复用 `reconcileApprovalWait` 文本启发式**（它不拒绝 `ok:false`，且正是 `reconcileApprovalTruth` 在 `on`/`off` 态下的兜底实现）。

### 4.5 为什么不依赖结构化探针（K3R）在这个分支命中

审批闸拦截有两类：
- **A 类**：winvm 工具**被调用**、服务端回吐 `APPROVAL_REQUIRED`（**有结构化事实**）；
- **B 类**：codebuddy 安全策略在**调用前**拦截、合成 `APPROVAL_REQUIRED`（**服务端无事实**）。

Phase D 的 k3r 目标属 B 类概率更高（F2 文本称「在发起前被策略拦截」「未对 VM 造成任何更改」）。**结构化探针对 B 类永远无事实可查** ⇒ `!turn.ok` 分支只能、也必须靠**文本启发式**兜底。这与设计 §5.3「结构化退场时回退文本启发式」完全一致。

### 4.6 宿主单测（不需 VM）

`tests/unit/cl-k3r-runpersistent-approval-routing.test.js`（**4/4 PASS**，149 行）：

| 例 | 场景 | 期望 | 结果 |
|---|---|---|---|
| A | `!turn.ok` + 审批文本 | 改判 `APPROVAL_REQUIRED`（`input-required` 前置） | PASS |
| B | `!turn.ok` + 无审批文本（真错） | 维持 `EXECUTION_FAILED` | PASS |
| C | `turn.ok=true` | `ok:true`（**回归护栏**） | PASS |
| D | `shadow` + 审批文本 | 仅 `[shadow]` warn、**不改判**（保持 `EXECUTION_FAILED`） | PASS |

---

## 5. 数据流（改造后）

```
CLI(codebuddy) → MCP /mcp callTool(高风险能力)
      │
      ├─ pendingApprovals.set(apr_x, { risk, capabilityId, params, …, hostApproved:false })   ← ★事实#1（S1）
      ├─ recordBlockedApprovalAudit → 哈希链                                                   ← ★事实#2（S2，fire-and-forget，可能晚一拍）
      └─ structuredContent { ok:false, error.code:'APPROVAL_REQUIRED', approval:{approvalId} } ← 事实#3（CLI 内，不上行）

CLI → 桥：turn.text（可能不含关键词）

桥收口（`maybeResume` 之前）：
  probe.approvalWait({ delegationTraceId, startedAtMs, capabilities })
      │ R1 精确 / R2 精确排除 / R3 窗口兜底（能力面过滤）
      ▼ PendingApprovalFact[]（可能为空：探针缺席/抛错/开关 off/无未决）
  ├─ 有未决事实（且不在 ctx.raised 或无回执）
  │     ⇒ 改判 ok:false + APPROVAL_REQUIRED + 服务端权威 approvalId/risk/attribution
  │     ⇒ maybeResume：blocked=true ⇒ raise → coordinator.waitApproval ⇒ 终态 input-required
  └─ 无事实 ⇒ 回退 reconcileApprovalWait(base, finalText)（现状行为逐字不变，fail-open）

【shadow 态】结构化命中与文本命中都只打 `[shadow]` warn，不改 base.ok ⇒ 终态仍可为 completed（**这是 G4 纪律刻意的观察态**）
【Phase D 补充】若走的是 `!turn.ok` 分支：命中文本 ⇒ shadow 仅 warn；on 才经 maybeResume 改判
```

---

## 6. fail-open / fail-closed 取舍（本项最关键的安全论证）

| 情形 | 改造前 | 改造后 | 方向 |
|---|---|---|---|
| 拦截发生 + LLM **说了**关键词 | 挂起（正确） | 挂起（正确；走文本兜底，结构化可能也命中，幂等） | 不变 |
| 拦截发生 + LLM **没说**关键词（**K3**） | **`completed`（假成功）** | **挂起 `input-required`** | ✅ **fail-open → fail-closed** |
| 拦截未发生 + LLM 没说 | `completed`（正确） | `completed`（正确；门 5 回退） | 不变 |
| 拦截未发生 + 宿主并发直调在窗口内被拦（**串台**） | `completed`（正确） | **挂起（误报）** | ⚠ **新增 fail-closed 噪声** |
| 探针缺席 / 抛错 / 开关 `off` | —— | **完全退回现状** | 不劣化 |

**论证要点三条**：
1. **新判据只做单向变换**（`ok:true → ok:false`，且**仅在有结构化证据时**触发）⇒ **它在任何路径上都不可能制造新的假成功**。
2. **误报的代价可观测、可恢复**（卡 `input-required` ⇒ 宿主看得见审批卡，可批准触发服务端重放，或拒绝 ⇒ `rejected`）；**假成功的代价不可观测、不可恢复**（宿主以为做完了，不会重试）⇒ **宁可多挂一次，不可漏挂一次**。
3. **串台概率被三重收窄**：R2 精确排除 + 能力面过滤（allowlist 最窄）+ 常驻会话 `enqueue` 串行（`this.chain.then(fn, fn)`，同一时刻只有一轮 turn）。残余窗口主要是「宿主并发 MCP 直调」这一低频场景。

**R3 的残余噪声方向（必须显式登记）**：R3 只会**多报**（fail-closed），不会漏报；「拦截已发生但 entry 不在 Map 里」**不可能发生**（拦截的唯一代码路径必然 `set`，批准/超时才 `delete`）。

---

## 7. 风险与回滚

### 7.1 回滚总纲（单点 + 零源码）

| 层级 | 回退手段 | 是否需改源码 | 是否需重建 |
|---|---|---|---|
| **运行期（首选）** | 设 `WINVM_APPROVAL_TRUTH=off` ⇒ 门 2 短路 `return base`（今行为） | 否 | 否 |
| **单测/集成** | 桩 `delegationProbe.approvalWait` 不实现 ⇒ 门 3 回退文本启发式 | 否 | 否 |
| **故障运行期** | 探针抛异常 ⇒ 门 4 `try/catch` 回退 + warn | 否 | 否 |
| **顽固 / 全撤** | revert T01+T02+T03 ⇒ 契约与探针整体消失，桥回到「无 `approvalWait`」旧态 | 是（git revert） | 是（重建 dist） |

> **关键不变量**：`off` / 探针缺失 / 探针异常三种情形，终态**逐字节等价于今行为** —— 「新代码对老链路零破坏」是**可证明**的，不是口头的。
> **不可回退项**：无（`a2a-framework/src/**` 零改动，回滚不影响 A5 修复）。

### 7.2 专项风险与缓解

| # | 风险 | 触发 | 缓解 | 兜底 |
|---|---|---|---|---|
| **R-K1** | **串台误报**：host 并发直调另一 capability 被误挂到本委派 | 常驻路径无 `delegationId`，R3 窗口归因可能跨委派 | R2 精确排除（他人 `delegationId` 一律排除）+ T04 反例夹具断言「不误挂」 + 窗口边界与 `inWindow` 同源 | shadow 一轮量化串台率，**>0 即不切 `on`** |
| **R-K2** | 探针缺失 / 异常 | 老版 vm-service 未注入 / 未实现 / 抛错 | SK-K1 门 3/4 fail-open 回退 + warn | 终态 = 今行为，无新假成功 |
| **R-K3** | R3 窗口过宽（把「本委派开始前已拦截」算命中） | `createdAtMs < ctx.started` 的陈旧拦截 | 窗口**下界**用 `ctx.started`（进入时刻） | R2 排除他人；shadow 观测 |
| **R-K4** | `pendingApprovals` 长会话累积 | VM 长运行未清理 | SK-K3 点名「只含未决 + 重启即空」；清理策略列 Q5（本轮不实现） | 观测项，不阻塞 |
| **R-K5** | dist 未重建导致「改了没生效」假象 | 改 src 未 `tsc -b` | T05 门禁强制 `--force` 重建（SK-5） | 回归复跑必失败，早暴露 |
| **R-K6** | 真机 K3 专项构造不出「LLM 不说关键词」 | 提示词引导 LLM 仍说关键词 | `a2a-extra.mjs k3r` 用 stub 拦截 + 提示词**显式禁止**说「等待审批」 | 若构造不出，退化为单测 `r19c-k3r-bridge-integ` 端点断言 |
| **R-K7**（本轮新发现） | **常驻路径把「审批暂停」误标 `is_error`** ⇒ K3R 判据整体被绕过 | stream-json 模式差异 | Phase D 修复（§4）：`!turn.ok` 分支先做文本甄别 + shadow 门控 | 宿主单测 4/4 证明逻辑正确性；`on` 轮 3/3 真机证明端到端 |
| **R-K8**（本轮新发现） | harness 目标下 codebuddy **绕路**走 `appops.workflow.run` ⇒ 服务端无事实可查 | LLM 自主规划选择了间接路径 | 2026-10-06 harness 收紧：默认 goal 强制直调 `app.winget.uninstall` + `sidestepDetected` 诊断分支 | 判为 `INCONCLUSIVE_SIDESTEP`（**明确区分「真失败」与「harness 构造问题」**），非修复缺陷 |
| **R-K9**（本轮新发现） | `/health` 指纹在最后一跳被丢弃 ⇒ 无法证明跑在哪个模式 | `providerHealth` 顶层字段未透传 | E-3b：`providerApprovalTruth` 纯附加透传顶层 | Phase B 已实测命中，指纹纪律恢复 |

### 7.3 一键回滚操作手册

```bash
# 1) 立刻止血（无需改码、无需重建）
export WINVM_APPROVAL_TRUTH=off        # 门 2 短路 ⇒ 退化为今行为
# 重启 vm-service 进程使 env 生效（pendingApprovals 随之清空，无副作用）

# 2) 若需彻底撤除（顽固场景）
git revert <T01> <T02> <T03>           # 三个 CL 整体消失
npx tsc -b tsconfig.build.json --force # 重建 dist
# 重启进程 ⇒ 回到 K3R 合入前状态，全量回归应恢复原基线
```

---

## 8. 验证方法

### 8.1 构建与护栏（改完 `packages/**` 必跑）

```bash
/data/storage/el1/bundle/libs/arm64/node/bin/node node_modules/.bin/tsc -b tsconfig.build.json --force   # 期望 0 error
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
$NODE --test tests/unit/r19c-k3r-approval-truth.test.js   # 11/11
$NODE --test tests/unit/r19c-k3r-approval-wait.test.js    # 10/10
$NODE --test tests/unit/r19c-k3r-bridge-integ.test.js     #  2/2
$NODE --test tests/unit/k5-replay.test.js                 # 41/41（D-1 红线护栏）
$NODE --test tests/unit/cl-k3r-runpersistent-approval-routing.test.js   # 4/4（Phase D）
# K-N1 七文件合计 242
```

### 8.2 红线 diff 守门

```bash
grep -n "rejected" packages/a2a-framework/src/server.ts     # 期望仅 :306 一行（D-5）
grep -n "APPROVAL_WAIT_PATTERN\|parseApprovalBlock\|function reconcileApprovalWait" \
     packages/adapter-agent-workbuddy-llm/src/bridge.ts    # SK-9 三处落点须仍在且函数体未被改动
# D-4「packages/a2a-framework/src/** 零改动」须在有版本控制系统的环境复核，本环境无法自证。
```

### 8.3 依赖方向（本轮改用人工核对，见 E-4）

`contracts` / `core` 新增导出 ⇒ `vm-service` / `adapter-*` 反向依赖，方向未破坏；E-2 后包内依赖恢复单向 `bridge → delegation-truth`（`dist/delegation-truth.js` **零** `bridge.js` 引用）。

### 8.4 真机 T05 序列（六阶段，主理人专属；子 agent 无 VM 路由）

```
阶段 A：node delivery/deploy-vm.mjs --env=.env.deploy-vm            # 先 dry-run
        node delivery/deploy-vm.mjs --env=.env.deploy-vm --apply    # 再真执行
阶段 B：GET /health → psBridge.uptimeMs 大幅回落 + providerApprovalTruth.mode
阶段 C：vm-service.runtime.json → workbuddy.options 加 "approvalTruth":"shadow"
        → powershell -File C:/WinVMBridge/kill-restart.ps1 → 断言 mode==="shadow"
阶段 D：node qa/r19/a2a-extra.mjs k3r --prefix=<abs>/k3r-shadow-<N> --truth=shadow   （≥3 次）
        —— 注意：**k3r 子命令没有 dry-run，任何参数组合都会真的下发一次委派**
阶段 E：改回 "on" → kill-restart → 断言 mode==="on" → 再跑 k3r ≥3 次
阶段 F：清理 .bak-on / 临时脚本；汇总写入 docs/test/reports/（每轮只留一份权威报告）
```

**坑位清单（踩过一次就不会忘）**：远端 shell = Git Bash(MSYS) ⇒ `/` 开头参数被路径转换，远端逻辑一律写 `.ps1` → scp（远端路径须 `C:/…`）→ `powershell -NoProfile -ExecutionPolicy Bypass -File` 执行；只有 `install-vm` 会重新生成 `.generated/`；证据文件须「写完再读」；隧道假活时 `alive=true` 才可信（TCP 通但 HTTP 黑洞 ⇒ ping 100% 丢包）。
