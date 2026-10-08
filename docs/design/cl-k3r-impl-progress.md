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

## 5.3 owner 裁定后的两笔追加 commit（E-1 勘误 / E-2 去环）

| # | commit | 内容 | 重跑结果 |
|---|---|---|---|
| E-1 | `574f9c9` | `docs(k3r): §9.5 设计勘误` —— 在 `cl-k3r-silent-false-success-design.md` §9.4 之后新增 §9.5，登记「门 6 前提收窄为『已 raise 且尚无服务端回执』」及 fail-closed 依据（§0–§8 不动） | 文档 only，无需重跑 |
| E-2 | `95052d5` | `refactor(k3r): 依赖注入去除 bridge↔delegation-truth 静态环` | 见 §5.4 |

### 5.4 E-2 去环后的四条门禁重跑（全部保持绿）

```
node --test tests/unit/r19c-k3r-approval-truth.test.js  → tests 11 / pass 11 / fail 0
node --test tests/unit/r19c-k3r-approval-wait.test.js   → tests 10 / pass 10 / fail 0
node --test tests/unit/r19c-k3r-bridge-integ.test.js    → tests  2 / pass  2 / fail 0
node --test tests/unit/k5-replay.test.js                → tests 41 / pass 41 / fail 0
npx tsc -b tsconfig.build.json --force                  → 0 error
git diff --stat 6dca16e..HEAD -- packages/a2a-framework/src/ → 0 行（空）
逐文件巡检 tests/unit/*.test.js|*.test.mjs（全量）           → SWEEP DONE（零异常）
```

### 5.5 E-2 加载序显式验证（命令 + 输出）

```
# 序 A：包入口先（index → bridge → delegation-truth）
node -e "import('@winvm/adapter-agent-workbuddy-llm').then(async m => { ...reconcileApprovalTruth(base, '工具返回 APPROVAL_REQUIRED，等待宿主审批\n', {...}) })"
  → 文本兜底生效: true | error.code= APPROVAL_REQUIRED

# 序 B：delegation-truth 先加载，再加载 bridge
node -e "const dt = await import('./packages/adapter-agent-workbuddy-llm/dist/delegation-truth.js'); await import('./packages/adapter-agent-workbuddy-llm/dist/bridge.js'); ..."
  → 文本兜底生效: true | error.code= APPROVAL_REQUIRED

# 序 C：仅加载 delegation-truth（无注册 → 恒等透传，fail-open 且不抛）
node -e "const dt = await import('.../dist/delegation-truth.js'); ..."
  → 降级透传（不抛、不改 ok）: true | 返回同一 base: true
```

去环核验：`grep -n "bridge.js" src/delegation-truth.ts dist/delegation-truth.js`
→ `src` 仅剩 `import type { LlmGoalResult } from './bridge.js'`（**类型导入，编译期擦除**）；
→ `dist/delegation-truth.js` **零** `bridge.js` 引用 ⇒ 运行时**无**反向边。

## 6. 红线自检（源码可核，逐条已验）

| 红线 | 证据 |
|---|---|
| **D-4** `packages/a2a-framework/src/**` 零改动 | `git diff --stat 6dca16e..HEAD -- packages/a2a-framework/src/` = 0 行 |
| **D-5** `rejected` 唯一置位点 | `grep -n rejected packages/a2a-framework/src/server.ts` 仅 `:306` 一行；本次零新增写入点 |
| **SK-9** 不改清单 | `bridge.ts` diff：`APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` **零 diff**；`reconcileApprovalWait` 仅 `function` → `export function`（函数体与文案一字未改），调用层级降为兜底 |
| **D-1** 两道门 | `reconcileExecutionTruth` 区域**零 diff**（`:1024`/`:1025` 短路顺序与语义不变） |
| **SK-5** dist 先重建 | 每次改 `src` 后均执行 `tsc -b tsconfig.build.json --force`，再跑测 |

## 8. 本次要做的事（E-2b / E-3，2026-10-05 开工即落盘，防中断零产出）

权威规格：`docs/design/cl-k3r-e2b-e3-taskbook.md`。基线 HEAD：`c396b98`（任务书落盘 commit）。

### 8.1 E-2b｜第三级兜底不得静默 fail-open

- 落点：`packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts` 第 232-234 行
  `deps.reconcileApprovalWait ?? approvalWaitFallback ?? ((b) => b)`。
- 改法（只加观测，判定结果逐字不变）：
  1. 第三级「恒等透传」命中时，若 `deps.warn` 存在则 emit 恰一条可检索 warn：
     文案 `'[k3r] 文本兜底缺席（未注入且未注册）→ 恒等透传，等同无兜底旧行为'`，
     meta 带 `{ gate, hasTaskId: !!taskId }`，`gate` 取实际触发的门编号（门1/门2/门3/门5/门6）；
  2. 返回值仍为 `base`，不改 `ok`、不改 error；
  3. 重跑四道闸 + tsc 0 error。

### 8.2 E-3｜灰度开关运行时指纹（`/health.provider.approvalTruth` 三态可观测）

三处，均纯附加：
1. `packages/contracts/src/bridge.ts` `HealthStatus` 加可选字段
   `approvalTruth?: { mode: 'on'|'shadow'|'off'; enabled: boolean; shadow: boolean }`
   （字面量联合类型，**不得** import `@winvm/core`；既有字段零改动）。
2. `packages/adapter-agent-workbuddy-llm/src/index.ts` `health()` 返回对象补该字段；
   三个值在**构造 bridge 那一行**一次性解析并存为 readonly 字段
   （`approvalTruthShadow === true ⇒ 'shadow'`，否则 `approvalTruthEnabled ? 'on' : 'off'`），
   `health()` 内**不得**二次读 `process.env`。
3. 三态自证脚本 `/storage/Users/currentUser/wbtmp/e3-fingerprint.mjs`（不入库），
   对 on/shadow/off 三档构造并断言字段逐字对应，必须有可复现三档 stdout
   （允许降级两段：① `new CliLlmBridge({ approvalTruth: X })` 三档字段成立；
   ② provider 实例字段透传，不经过 executor）。

### 8.3 第三级可达性分析（E-2b 要求登记）

第三级「恒等透传」仅对「**深层直接 import `delegation-truth.js` 且未加载 `bridge.js`**」的调用方可达
（此时模块级注册 `approvalWaitFallback` 为空、`deps.reconcileApprovalWait` 未传）。
两类生产路径均**不可达**：
- **生产路径**：`bridge.ts` 在两处收口点（`runPersistent` / `runOneShot`）显式注入
  `reconcileApprovalWait`（`deps.reconcileApprovalWait` 命中第一级）；
- **包出口路径**：`index.ts:35` 值 import `bridge.js` ⇒ 加载期触发
  `registerApprovalWaitFallback` 注册（第二级兜底命中）。

结论：这是**已知且刻意保留**的降级面（纯逻辑件可独立单测），**非 K3 回归面**——
E-2b 只为其补可检索 warn，不改变任何判定路径。

### 8.4 红线与验收（同任务书）

- D-4：`packages/a2a-framework/src/**` 零改动（`git diff 95052d5..HEAD` 自证为空）；
- SK-9：`bridge.ts` 的 `APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` / `reconcileApprovalWait` 函数体与文案一字不改；
- `HealthStatus` 只加可选字段；严禁改 `tests/`；
- 验收：四道闸（11/10/2/41）+ K-N1 七文件（合计 242）fail 全 0 + `tsc -b tsconfig.build.json --force` 0 error + E-3 三态指纹 stdout。

commit 计划：① `docs(k3r): E-2b/E-3 实施计划落盘（防中断零产出）`（本节）；
② `refactor(k3r): E-2b 第三级兜底可观测（无兜底时 warn，判定逐字不变）`；
③ `feat(k3r): E-3 灰度开关运行时指纹（/health.provider.approvalTruth 三态可观测）`。

### 8.5 E-2b/E-3 实施结果（自证留档）

| # | commit | 内容 |
|---|---|---|
| E-2b | `c3899d4` | `refactor(k3r): E-2b 第三级兜底可观测（无兜底时 warn，判定逐字不变）` —— `delegation-truth.ts` 兜底解析拆为 `fallback`（可缺席）+ `runFallback(gate,…)`；命中第三级时按实际门（门1/门2/门3/门5/门6）emit 恰一条 warn（文案/meta 见任务书），返回值恒为 base。门4（探针异常）已有自己的 warn，按「恰一条」纪律**不叠加** E-2b warn（gate 枚举刻意不含门4）。shadow 对拍路径用 `fallbackOrIdentity`（与 E-2 语义逐字一致，恒等透传不 warn——该路径已有 `[shadow]` 指纹） |
| E-3 | `614c6ad` | `feat(k3r): E-3 灰度开关运行时指纹（/health.provider.approvalTruth 三态可观测）` —— ① `contracts/bridge.ts` `HealthStatus` 顶层加可选字段 `approvalTruth?: { mode: 'on'\|'shadow'\|'off'; enabled: boolean; shadow: boolean }`（字面量联合，零 `@winvm/core` import，既有字段零改动）；② adapter `index.ts` 构造期一次性解析 `approvalTruthMode`（与注入 bridge 的同一解析值同源），`health()` 只读该 readonly 字段（零 `process.env` 重读） |

**验收重跑（E-2b + E-3 合并后）**：

```
四道闸：r19c-k3r-approval-truth 11/11、r19c-k3r-approval-wait 10/10、
        r19c-k3r-bridge-integ 2/2、k5-replay 41/41 —— fail 全 0
K-N1 七文件：a-pure 76、b-bridge 23、c-session 17、d-provider 28、
        e-shape 33、e-mutation 49、f-chain 16 —— 合计 242，fail 全 0
tsc -b tsconfig.build.json --force → 0 error
D-4：git diff --stat 95052d5..HEAD -- packages/a2a-framework/src/ → 0 行（空）
SK-9：git diff 95052d5..HEAD -- bridge.ts 中 APPROVAL_WAIT_PATTERN|parseApprovalBlock|
      function reconcileApprovalWait|return base 的 +/- 行 → 零命中（grep 退出码 1）
E-3 三态指纹（/storage/Users/currentUser/wbtmp/e3-fingerprint.mjs，env 置 off 噪声下仍如实透出）：
  mode=on     → approvalTruth={"mode":"on","enabled":true,"shadow":false}
  mode=shadow → approvalTruth={"mode":"shadow","enabled":true,"shadow":true}
  mode=off    → approvalTruth={"mode":"off","enabled":false,"shadow":false}
  PASS: 3/3 档逐字对应（mode/enabled/shadow），三态互异，构造期解析同源。
```

---

## 7. 实施中发现的设计偏差与环境事实（登记，不自行改设计文档）

| # | 偏差 | 处置 |
|---|---|---|
| **E-1** | 红档 C 组（integ）要求「raise 后 `result.ok === false`」；而 §5.3 门 6「全部 fact 已在 `ctx.raised` ⇒ 回退文本兜底」在续跑轮会让 `maybeResume` 因 `blocked=false` 直接返回 `ok:true`，`applyReceipt` 永不触达 ⇒ 回执为失败时反而产出 `completed`（新的假成功） | 落地时把门 6 的适用前提收窄为「已 raise **且尚无服务端回执**」：已有回执 ⇒ 不跳过，交 `maybeResume.applyReceipt` 以**真实回执**收口（fail-closed，与 §5.4 同源）。纯逻辑单测（`r19c-k3r-approval-truth` 门 6，无 receipts）行为不变 |
| **E-2** | `reconcileApprovalWait` 是 `bridge.ts` 模块内**非导出**函数，而 `reconcileApprovalTruth` 需在同一收口链内复用它做文本兜底 | **owner 裁定：不许搬函数**（搬走即破坏 SK-9 落点与 A5 指纹比对基准），改用**依赖注入**去环：`deps.reconcileApprovalWait` 由 `bridge.ts` 在两处调用点显式传入；另提供 `registerApprovalWaitFallback()` 供 `bridge.ts` 在模块加载时注册**默认兜底**（使单测等直接调用方仍能拿到与生产同一份实现）；`delegation-truth.ts` 因此**不再 import bridge.ts**（`commit 95052d5`）。`bridge.ts` 的 `reconcileApprovalWait` 已**还原为原状**（`export` 关键字撤回，函数体与注释块零改动） |
| **E-3** | `BlockedEntry` 原不含 `createdAtMs` / `risk`，`blockedFor` 构造 `PendingApprovalFact` 需要二者 | 以**可选**字段追加（`createdAtMs?` / `risk?` / `delegationId?` / `attribution?`），`recordBlocked` 登记时写入；缺席回退 `ledger.startedAtMs` / `'L1'`；既有构造点与消费者零改动 |
| **E-4** | `npm run layout`（`scripts/dep-lint.mjs`，SK-K5 依赖方向守卫）在本仓库**不存在**（`MODULE_NOT_FOUND`） | **owner 裁定：已知既存问题（R19F spec 勘误 E-3），本轮不修**，避免扩大改动面。设计文档 §10.3 把它列为门禁项属于引用了失效脚本。**本轮以人工方向核对替代**：新增导出全部落在 `contracts` / `core`，`vm-service` / `adapter-*` **反向依赖**它们（方向未破坏）；E-2 后包内依赖亦恢复单向 `bridge → delegation-truth`。是否补脚本 / 删除该门禁项由 owner 决定（主理人已报备）。**【2026-10-08 闭环】** QA Phase 0 R3（`c10a400`）已取"删除"分支——`layout` 脚本键已从根 `package.json` 移除；`dep-lint` 守卫属 **Phase 2 规划**，完成前 D-4/SK-K5 类改动一律人工方向核对 |
| **E-5** | 桥侧 `shadow` 态需要「计算但不改判」，而 §7.3 只列了 `enabled` | `deps` 追加**可选** `shadow?: boolean`（缺省 false）；桥构造两个只读字段 `approvalTruthEnabled` / `approvalTruthShadow`（SK-K2）。`on` 态行为与只传 `enabled` 完全一致 |
