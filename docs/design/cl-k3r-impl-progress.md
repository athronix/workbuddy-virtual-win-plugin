# CL-K3R「K3 静默假成功」根治 —— 实施进度（Engineer 独占）

> 权威设计：`docs/design/cl-k3r-silent-false-success-design.md`（STATUS=APPROVED，§9.4 三项决策 D-1/D-2/D-3）。
> 基线 HEAD：`6dca16e`。本文只记**实施事实与验收自证**，不改写设计文档。
> 环境（鸿蒙沙箱）：`git` = `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`；
> `node` = `/data/storage/el1/bundle/libs/arm64/node/bin/node`；命令一律绝对路径；临时目录 `$HOME/wbtmp`。

---

## 0. 前一轮失败复盘（**零落盘**是明令禁止的失败模式）

前一轮工程师被中断且**未落盘任何文件**（无 commit、无进度文档），导致全部分析丢失、主理人无法接手。
本轮纪律：**每任务即 commit；先用本文补齐根因与修复清单再开工**。

## 1. 红档基线（主理人实测，本轮开工前复现口径）

| 红档测试 | 实测失败 | 根因 | 归属 |
|---|---|---|---|
| `tests/unit/r19c-k3r-approval-truth.test.js` | 整文件 SyntaxError | `@winvm/adapter-agent-workbuddy-llm` **未导出** `reconcileApprovalTruth`（dist 无该具名导出） | T03 |
| `tests/unit/r19c-k3r-approval-wait.test.js` | 整文件 SyntaxError | `@winvm/vm-service` **未导出** `collectApprovalFacts`（`LedgerRegistry.blockedFor` 亦未落地） | T02（依赖 T01 的 `blockedFor`） |
| `tests/unit/r19c-k3r-bridge-integ.test.js` | 断言 `actual:true / expected:false` | 服务端确有拦截、LLM 文本不含关键词时桥仍产出 `ok:true`（K3 假成功本体）⇒ `reconcileApprovalTruth` 未接入两处收口点 | T03 接线 |
| `tests/unit/k5-replay.test.js` | **41/41 绿** | 回归基线，必须保持绿（D-1 两道门未动） | 护栏 |
| `npx tsc -b tsconfig.build.json` | 0 error | 构建基线 | 护栏 |

## 2. 根因（一句话）

**判据面缺失**：服务端三处「结构化拦截事实」（`pendingApprovals` 令牌表 / 哈希链 `recordBlockedApprovalAudit` /
MCP 结构化 `APPROVAL_REQUIRED` 回包）**从未上行到桥**；桥唯一的判据是 LLM 措辞正则
（`bridge.ts:575` `APPROVAL_WAIT_PATTERN`）。LLM 不说关键词 ⇒ `reconcileApprovalWait` 透传 `ok:true`
⇒ `maybeResume` 的 `blocked=false` ⇒ 不 raise、不挂起 ⇒ `completed`（静默假成功）。

## 3. 修复清单（按任务，逐条可核）

### T01 契约与取证底座
1. `packages/contracts/src/bridge.ts`：`ApprovalWaitQuery` / `PendingApprovalFact` 新增导出类型；
   `DelegationTruthProbe` 追加**可选**成员 `approvalWait?`（C-K1/C-K2/C-K3，纯附加，非破坏）。
2. `packages/core/src/constants.ts`：`ENV_APPROVAL_TRUTH='WINVM_APPROVAL_TRUTH'` 三态常量 +
   `resolveApprovalTruth(env)`（非法/缺席一律回退 `'on'`，与 `resolveApprovalReplay` 同纪律）。
3. `packages/vm-service/src/delegation-audit.ts`：`LedgerRegistry.blockedFor(q)`（R1/R2/R3 三规则严格有序）、
   `LedgerRegistry.recordBlocked(...)`（窗口归因入口）、`DelegationLedger.blockedFacts()`；
   窗口边界与既有 `DelegationLedger.inWindow`/`isExposed` **同源**，不另写阈值。

### T02 服务端探针
4. `packages/vm-service/src/approval-replay.ts`：新增**纯函数** `collectApprovalFacts(pending, q, nowMs)`
   （S1 主通道；只返未决项；R1 精确 / R2 精确排除 / R3 窗口兜底 + 能力面过滤；按 `createdAtMs` 升序）。
5. `packages/vm-service/src/server.ts`：`delegationProbe` 字面量内补 `approvalWait`
   （`collectApprovalFacts(pendingApprovals, q, Date.now())` + `ledgerReg.blockedFor(q)`）；
   拦截记账处补窗口归因（`ctx.delegationId` 缺失时经 `ledgerReg.recordBlocked` 窗口分发，补 V-3）。
6. `packages/vm-service/src/index.ts`：导出 `collectApprovalFacts` / `PendingApprovalFact`。

### T03 桥侧判据与接线
7. `packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts`：新增 `reconcileApprovalTruth(base, finalText, deps)`
   （§5.3 判定表 7 门；单向 fail-closed；零副作用）。
8. `packages/adapter-agent-workbuddy-llm/src/bridge.ts`：新增 `private readonly approvalTruthEnabled`
   （构造自 `resolveApprovalTruth(process.env)`）；两处 `reconcileApprovalWait({…}, text)` 收口点改为
   `await this.reconcileApprovalTruth({…}, text, { input, ctx, enabled })`（`runPersistent` / `runOneShot`）。
9. `packages/adapter-agent-workbuddy-llm/src/index.ts`：`import { resolveApprovalTruth } from '@winvm/core'` +
   构造注入 + 包出口导出 `reconcileApprovalTruth`。

## 4. 硬约束（每次 commit 后自检）

- **D-4**：`git diff --stat -- packages/a2a-framework/src/` 必须为空。
- **D-5**：不新增任何 `rejected` 写入点。
- **SK-9**：`bridge.ts` 的 `APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` / `reconcileApprovalWait`
  **函数体与文案一字不改**，只降调用层级为兜底。
- **D-1**：`reconcileExecutionTruth` 两道门短路顺序与语义零改动。
- **SK-5**：改完 `src` 必先 `npx tsc -b tsconfig.build.json --force` 重建 dist，**先重建再跑测**。
- **不得代改 `tests/`**（QA 独占）。

## 5. 逐任务验收记录

| 任务 | commit | tsc -b | 单文件单测 | a2a-framework 守门 |
|---|---|---|---|---|
| T01 | `748ca8d` | 0 error | （无红档可跑；`blockedFor`/`resolveApprovalTruth` 手工探针断言 3/3 通过） | 空（0 行） |
| T02 | `fa8038e` | 0 error | `r19c-k3r-approval-wait` **10/10 绿**（原整文件 SyntaxError） | 空（0 行） |
| T03 | `be90be2` | 0 error | `r19c-k3r-approval-truth` **11/11 绿**、`r19c-k3r-bridge-integ` **2/2 绿** | 空（0 行） |

### 5.1 四条验收的自证输出（摘要）

```
# 1 三个红档单文件
node --test tests/unit/r19c-k3r-approval-truth.test.js   → tests 11 / pass 11 / fail 0
node --test tests/unit/r19c-k3r-approval-wait.test.js    → tests 10 / pass 10 / fail 0
node --test tests/unit/r19c-k3r-bridge-integ.test.js     → tests  2 / pass  2 / fail 0

# 2 回归护栏
node --test tests/unit/k5-replay.test.js                 → tests 41 / pass 41 / fail 0
逐文件巡检 tests/unit/*.test.js|*.test.mjs（全量，仅输出异常）→ SWEEP DONE（零异常）

# 3 构建
npx tsc -b tsconfig.build.json --force                   → 0 error

# 4 D-4 守门
git diff --stat 6dca16e..HEAD -- packages/a2a-framework/src/  → 0 行（空）
```

### 5.2 补充回归（逐文件，均 fail 0）

`r19c-a5-approval-coordinator` 22、`r19c-a5-fix4-risk` 4、`r19c-kn1-a-pure` 76、
`r19c-kn1-b-bridge` 23、`r19c-kn1-c-session` 17、`r19c-kn1-d-provider` 28、
`r19c-kn1-e-mutation` 49、`r19c-kn1-e-shape` 33、`r19c-kn1-f-chain` 16、
`llm-provider` 20、`host-a2a-bridge` 35、`k4-approval` 6、`k4-p3` 16。

## 6. 红线自检（源码可核，逐条已验）

| 红线 | 证据 |
|---|---|
| **D-4** `packages/a2a-framework/src/**` 零改动 | `git diff --stat 6dca16e..HEAD -- packages/a2a-framework/src/` = 0 行 |
| **D-5** `rejected` 唯一置位点 | `grep -n rejected packages/a2a-framework/src/server.ts` 仅 `:306` 一行；本次零新增写入点 |
| **SK-9** 不改清单 | `bridge.ts` diff：`APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` **零 diff**；`reconcileApprovalWait` 仅 `function` → `export function`（函数体与文案一字未改），调用层级降为兜底 |
| **D-1** 两道门 | `reconcileExecutionTruth` 区域**零 diff**（`:1024`/`:1025` 短路顺序与语义不变） |
| **SK-5** dist 先重建 | 每次改 `src` 后均执行 `tsc -b tsconfig.build.json --force`，再跑测 |

## 7. 实施中发现的设计偏差与环境事实（登记，不自行改设计文档）

| # | 偏差 | 处置 |
|---|---|---|
| **E-1** | 红档 C 组（integ）要求「raise 后 `result.ok === false`」；而 §5.3 门 6「全部 fact 已在 `ctx.raised` ⇒ 回退文本兜底」在续跑轮会让 `maybeResume` 因 `blocked=false` 直接返回 `ok:true`，`applyReceipt` 永不触达 ⇒ 回执为失败时反而产出 `completed`（新的假成功） | 落地时把门 6 的适用前提收窄为「已 raise **且尚无服务端回执**」：已有回执 ⇒ 不跳过，交 `maybeResume.applyReceipt` 以**真实回执**收口（fail-closed，与 §5.4 同源）。纯逻辑单测（`r19c-k3r-approval-truth` 门 6，无 receipts）行为不变 |
| **E-2** | `reconcileApprovalWait` 是 `bridge.ts` 模块内**非导出**函数，而 `reconcileApprovalTruth` 需在同一收口链内复用它做文本兜底 | 只对 `reconcileApprovalWait` 增加 `export` 关键字（**函数体/文案一字不改**），由 `delegation-truth.ts` 静态 import；`bridge.ts` → `delegation-truth.ts` 的既有运行时依赖与新增反向 import 在同一包内，函数声明提升保证求值顺序安全 |
| **E-3** | `BlockedEntry` 原不含 `createdAtMs` / `risk`，`blockedFor` 构造 `PendingApprovalFact` 需要二者 | 以**可选**字段追加（`createdAtMs?` / `risk?` / `delegationId?` / `attribution?`），`recordBlocked` 登记时写入；缺席回退 `ledger.startedAtMs` / `'L1'`；既有构造点与消费者零改动 |
| **E-4** | `npm run layout`（`scripts/dep-lint.mjs`，SK-K5 依赖方向守卫）在本仓库**不存在**（`MODULE_NOT_FOUND`） | 无法执行该守卫；改为人工核对依赖方向：新增导出全部落在 `contracts` / `core`，`vm-service` / `adapter-*` **反向依赖**它们（方向未破坏）。回报主理人决定是否补脚本 |
| **E-5** | 桥侧 `shadow` 态需要「计算但不改判」，而 §7.3 只列了 `enabled` | `deps` 追加**可选** `shadow?: boolean`（缺省 false）；桥构造两个只读字段 `approvalTruthEnabled` / `approvalTruthShadow`（SK-K2）。`on` 态行为与只传 `enabled` 完全一致 |
