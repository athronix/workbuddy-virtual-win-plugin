# A5 审批丢弃缺陷 —— 修复实施进度（Engineer 独占落盘）

> 用途：增量落盘进度，进程异常中断时可按本文件恢复，不必重做。
> 权威依据：`docs/design/a5-approval-drop-fix-contract.md`（STATUS: FINAL，794 行）
> 实施人：寇豆码（software-engineer）。**独占 `packages/**`；不碰 `tests/**`、`docs/archive/test/**`、`qa/**`**。
> 基线 HEAD：`6ad6410`（spec 引用的 `eb72788` 为文档撰写时 HEAD，仓库已前进）

---

## 0. 环境事实（本次实测）

| 项 | 实测 |
| --- | --- |
| `git` | **不在 PATH**；真实位置 `/storage/Users/currentUser/.harmonybrew/bin/git`（v2.55.0）。所有 git 调用前须 `export PATH="/storage/Users/currentUser/.harmonybrew/bin:$PATH"` |
| `node` | `/data/storage/el1/bundle/libs/arm64/node/bin/node`（v24.13.0）；`node` 亦在 PATH 内 |
| `ls` | 无 `--time-style`；用默认 `ls -l`（分钟精度）+ dist 内容 grep 双重取证 |
| 构建命令 | `npx tsc -b tsconfig.build.json`（**根级**，不是 `packages/tsconfig.build.json` —— 后者不存在，spec SK-5 的 `packages/` 前缀为笔误） |

---

## 1. 基线（改动前，dist 已与 src 同步）

| 单测 | tests | pass | fail |
| --- | --- | --- | --- |
| `r19c-a5-approval-coordinator` | 18 | 13 | **5** |
| `k5-replay` | 41 | 41 | 0 |
| `k4-approval` | 6 | 6 | 0 |
| `k4-p3` | 16 | 16 | 0 |
| `r19c-kn1-a-pure` | 76 | 76 | 0 |
| `r19c-kn1-b-bridge` | 23 | 23 | 0 |
| `host-a2a-bridge` | 35 | 35 | 0 |
| `llm-provider` | 20 | 20 | 0 |

r19c-a5 的 5 条红档（A5 表征基线）：B1 / B2 / B3 / D2 / D3。

---

## 2. T01 —— 契约与告警底座（已完成）

**改动**
1. `packages/contracts/src/bridge.ts`
   - `:334`（原 `:315`）`endTask(): void;` → `endTask(taskId?: string): void;` + 归属语义文档注释（C-1）
   - `:185` 之后追加 `readonly taskId?: string;` + 注释（C-2）
2. `packages/vm-service/src/server.ts`
   - 类内 `noteTimeout` 之后、`beginTask` 之前新增 `private logger: ApprovalWarnSink | undefined;` + `setLogger()`（C-6）
   - 文件内 `ReplayFn` 之前新增 `export interface ApprovalWarnSink`（C-6）
   - `createService` 内 `new VmApprovalCoordinator();` 之后加 `approvalCoordinator.setLogger(logger);`（C-6 注入点）

**验收**
- `npx tsc -b tsconfig.build.json` ⇒ **0 error** ✅
- `grep -rn "endTask(" packages --include=*.ts`（src）⇒ **3 处**：契约 `:334` / 实现 `vm-service/src/server.ts:182` / 消费点 `adapter bridge.ts:741` ✅
- dist 已重建：`vm-service/dist/server.d.ts:106 setLogger`、`:118 ApprovalWarnSink` 可核 ✅
- `r19c-a5` ⇒ **18 / 13 / 5，与改前完全一致** ✅

**⚠ 与 spec 的一处措辞出入（实测，非偏离）**
spec §1 C-1 第 4 点称「C-1 一落地 `endTask.length` 立即变 1 ⇒ C5 当场翻红」。
**实测不成立**：`Function.prototype.length` 取决于**实现体**的 JS 形参个数，而实现体（`vm-service/src/server.ts`）属 **T02** 改动范围；T01 只改契约（`.d.ts` 与接口），运行时 `endTask.length` 仍为 `0`，C5 **仍 PASS**。
⇒ C5 翻红实际发生在 **T02**（实现体签名带 `taskId?` 之后）。这与 team-lead 简报「T01 落地后 C5 翻红」的预期时点相差一个 T，但**归属不变**：仍是已登记的预期红档，由 QA 同批次消除，我不改 `tests/**`。

---

## 3. T02 —— Fix-1A + Fix-1B + `no-active-task` 告警（已完成，commit `10967c2`）

**改动**
1. `packages/vm-service/src/server.ts`
   - `endTask(): void` → `endTask(taskId?: string): void`，按 §2.1 原文实现三分支归属语义（Fix-1A）
   - `raise`：`const taskId = req.taskId ?? this.activeTaskId;`；守卫改用 `taskId`；
     `no-active-task` 分支加 `this.logger?.warn(...)`（格式逐字按 SK-3，含 reason/approvalId/
     capabilityId/reqTaskId/activeTaskId/hasTasks，缺席一律 `''`）；`waitApproval(taskId, enriched)`；
     `tryGet(taskId)`（Fix-1B）
2. `packages/adapter-agent-workbuddy-llm/src/bridge.ts`
   - `:741` → `this.coordinator?.endTask(input.taskId ?? '');`
   - `maybeResume` 的 `const req: ApprovalRequest` 补 `...(input.taskId ? { taskId: input.taskId } : {}),`
3. `packages/contracts/src/bridge.ts`：给 `beginTask` / `endTask` 加 `@deprecated` 注释（T02 可选建议项，不删除）

**验收**
- `tsc -b` **0 error** ✅；dist 已重建（`vm-service/dist/server.js:83 endTask(taskId)`）✅
- `k4-approval` 6/6、`k4-p3` 16/16、`k5-replay` **41/41**、`r19c-kn1-a-pure` 76/76、
  `r19c-kn1-b-bridge` 23/23、`host-a2a-bridge` 35/35、`llm-provider` 20/20 ⇒ **零回归** ✅
- **D-4 守门**：`git diff --stat -- packages/a2a-framework/src/` ⇒ **空** ✅
- `r19c-a5` ⇒ 18 / **pass 12 / fail 6**（基线 13/5）

**r19c-a5 逐例变化（相对基线 13/5）**
| 用例 | 基线 | T02 后 | 判读 |
| --- | --- | --- | --- |
| D2「tB 的审批应真的被挂起」 | ✖ | **✔** | ✅ 红转绿（Fix-1B 生效） |
| D3「宿主批准应被采纳」 | ✖ | **✔** | ✅ 红转绿（D-5 `rejected` 路径首次可达） |
| D1「表征：A 收尾清空 ⇒ B 从未挂起 tB」 | ✔ | ✖ | ⚠ **旧缺陷表征被修复推翻**，QA 须重写（非回归） |
| A0「dist 可信度守卫」 | ✔ | ✖ | ⚠ 该守卫 grep dist 里的 `activeTaskId` 守卫**字面量**；实现改名为局部 `taskId` ⇒ 指纹失效。**dist 确已重建**（非陈旧），属测试侧指纹，QA 须重写 |
| C5「`endTask.length === 0`」 | ✔ | ✖ | ✅ **已登记的预期红档**（实现体签名带 `taskId?` ⇒ length=1） |
| B1 / B2 / B3 | ✖ | ✖ | ⚠ **见下方「B 组未转绿的原因」** |

**⚠ B 组（B1/B2/B3）未转绿的原因 —— 需主理人裁定 / QA 改写（不是实现缺陷）**

B 组用例的编排是：`beginTask('A') → beginTask('B') → endTask()`（**零参**，注释自述「模拟 A 收尾」）
⇒ `raise(makeReq('apr_B'))`，而 `makeReq` **不带 `taskId`**。

按 SK-2 / C-1 的**硬约束**：`endTask()` 零参 **必须**「无条件清空」（这是保住 `k4-approval`/
`k5-replay` 等既有零参调用方行为逐字不变的前提）；而 `req.taskId` 缺席时 `raise` 只能回退已被
清空的单例 ⇒ **必然** `no-active-task`。⇒ 在已定稿设计下，B 组当前编排**不可达**「挂起」，
除非用例给 `makeReq` 补 `taskId`（即 Fix-1B 的载体）。

已用离线探针（`~/wbtmp/a5-t02-probe.mjs`，不改 tests/packages）逐场景取证：

| 场景 | 编排 | 实测 outcome | waitApproval |
| --- | --- | --- | --- |
| 1 | `endTask()` 零参 + req **无** taskId（= B 组现状） | `no-active-task` | 0 次 |
| 2 | `endTask()` 零参 + req **带** `taskId:'B'` | `rejected` | **1 次，id='B'** ✅ |
| 3 | `endTask('A')` 归属 + req 带 `taskId:'B'` | `rejected` | **1 次，id='B'** ✅ |
| 4 | 兼容回归：`beginTask('A') → endTask()` 零参 | `no-active-task` | 0 次 ✅（旧行为逐字不变） |
| 5 | `endTask('A')`（当前活动是 B）⇒ 交叠保护 | `rejected` | **1 次，id='B'** ✅（Fix-1A 生效） |
| 6 | `beginTask('')` 后 raise（无 taskId） | `no-active-task` + **产出 1 条 warn** | 0 次 ✅（SK-3 字段齐全、无 undefined） |

⇒ 结论：实现**逐字符合 spec**（场景 2/3/5/6 即 spec §2.2 验收判据 2/3 与 §2.1 判据）。
B 组须由 QA 把 `makeReq` 补 `taskId`（或把 `endTask()` 改为 `endTask('A')`）后才会转绿。
**我未为此削弱签名、未改 tests。**

---

## 4. T03 —— Fix-2：per-delegation 三态搬离单例（已完成）

**改动（单文件 `packages/adapter-agent-workbuddy-llm/src/bridge.ts`，13 落点，严格按 spec 六步序）**
1. `RunContext` 追加 `receipts: Map<string, ExecutedResult>` / `raised: Set<string>` / `replayActive: boolean`
2. `runGoalInner` 的 ctx 构造补 `receipts: new Map(), raised: new Set(), replayActive: false,`
3. 删三个实例字段（`taskReceipts` / `raisedApprovals` / `k5ReplayActive`）⇒ 换成一段说明注释；
   删 `runGoal` 入口的三行清零 ⇒ 换成说明注释
4. `maybeResume`：`ctx.raised.has(...)` / `applyReceipt(approvalId, base, ctx)` / `ctx.raised.add(...)` /
   `ctx.receipts.set(...)` / `ctx.replayActive = true`
5. `reconcileExecutionTruth` 加 `ctx` 形参；**红线两行**只换取值来源；`[...ctx.receipts.values()]`；
   `[...ctx.raised]`；`applyReceipt` 加 `ctx` 形参 + `ctx.receipts.get(...)`
6. 调用点 `:786` → `this.reconcileExecutionTruth(truthed, ctx.lastFinalText, ctx)`

**验收**
- `tsc -b` **0 error** ✅；dist 已重建 ✅
- `grep -n "this\.taskReceipts\|this\.raisedApprovals\|this\.k5ReplayActive"` ⇒ **空**（仅注释提及）✅
- `k5-replay` **41/41** ✅、`k4-approval` 6/6、`k4-p3` 16/16、`r19c-kn1-a-pure` 76/76、
  `r19c-kn1-b-bridge` 23/23、`host-a2a-bridge` 35/35、`llm-provider` 20/20 ⇒ **零回归** ✅

**D-1 红线 before / after 原文（diff 只换取值来源，语义·顺序·短路条件·注释一字未改）**

BEFORE（T03 前，`:1013` / `:1014`）：
```ts
    if (!this.replayEnabled || !this.k5ReplayActive) return base;
    if (this.raisedApprovals.size === 0) return base; // 本任务未发生审批 → K3 行为逐字不变
```
AFTER（T03 后，`:1017` / `:1018`）：
```ts
    if (!this.replayEnabled || !ctx.replayActive) return base;
    if (ctx.raised.size === 0) return base; // 本任务未发生审批 → K3 行为逐字不变
```
⇒ 仍是两个相邻独立的 `if (…) return base;`，顺序不变、文案不变、短路条件不变；
只有 `this.k5ReplayActive`→`ctx.replayActive`、`this.raisedApprovals`→`ctx.raised`。
`this.replayEnabled`（桥级灰度开关，非 per-delegation 态）**按 spec 保留为实例字段**，未搬。

**⚠ 与 QA 并发的观察**：本轮跑测时 QA 已在改 `tests/unit/r19c-a5-approval-coordinator.test.js`
（mtime 01:29 晚于我的 T02 跑测）。C5 已被改写为「length === 1 + 归属行为断言」并**转绿**，
其注释中的判读口径（「翻红时刻 = 实现落码 + dist 重建，不是契约落地那一刻」）与我上报主理人的
实测结论一致。⇒ 后续 before/after 计数以 T05 收口时的快照为准。

---

## 5. T04 —— Fix-4a / 4b：风险展示真实化（已完成）

**改动（按 spec「4a → LlmGoalInput → index.ts 透传 → 两处 step risk」顺序）**
1. **Fix-4a**：`packages/vm-service/src/server.ts` `enriched` 补 `risk: token.risk ?? req.risk,`
   （服务端 `PendingApproval.risk` 权威值优先；值语义收窄已按 SK-8 写入注释）
2. **C-5**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts` `LlmGoalInput` 末尾追加
   `readonly maxRisk?: RiskLevel;`
3. `packages/adapter-agent-workbuddy-llm/src/index.ts` `runGoal` 入参补
   `...(goal.maxRisk ? { maxRisk: goal.maxRisk } : {}),`
4. **Fix-4b**：`bridge.ts` 常驻路径（`session: 'persistent'`）与单次路径（`params: { goal, runtime }`）
   两处 `risk: 'L1',` ⇒ `risk: input.maxRisk ?? 'L2',`（Q4 裁定：缺省取 `'L2'`）

**验收**
- `tsc -b` **0 error** ✅；dist 已重建 ✅
- `k5-replay` **41/41**、`k4-approval` 6/6、`k4-p3` 16/16、`r19c-kn1-a-pure` **76/76**、
  `r19c-kn1-b-bridge` 23/23、`host-a2a-bridge` **35/35**（含 `:137 assert.equal(a.risk,'L2')`）、
  `llm-provider` 20/20 ⇒ **零回归** ✅（与 spec §6 评估一致：无既有断言依赖桥 step risk）

**Q5 / Q6 红线守门**
- `packages/vm-service/src/delegation-audit.ts:499` 的 `risk: 'L1'` **一字未动** ✅
  （`r19c-kn1-a-pure.test.js:134` 仍是绿的回归锚点 —— 76/76 全绿可证）
- Fix-4c（审批卡文案标注风险来源）本迭代不做 ✅
- `APPROVAL_WAIT_PATTERN`（bridge.ts:568）/ `parseApprovalBlock`（:581）**未动**（Q8 独立议题）✅

---

## 6. T05 —— 类型门禁与回归收口（已完成）

### 6.1 `tsc -b` 与 dist

- `npx tsc -b tsconfig.build.json --force`（**全量强制重建**）⇒ **exit 0，0 error** ✅
- dist 新于 src（epoch 秒，逐对核实）：

| src | dist | 判读 |
| --- | --- | --- |
| `vm-service/src/server.ts` (1791048748) | `vm-service/dist/server.js` (1791048893) | ✅ dist 新于 src |
| `adapter…llm/src/bridge.ts` (1791048774) | `adapter…llm/dist/bridge.js` (1791048892) | ✅ |
| `adapter…llm/src/index.ts` (1791048782) | `adapter…llm/dist/index.js` (1791048892) | ✅ |
| `contracts/src/bridge.ts` (1791048294) | `contracts/dist/bridge.js` (1791048890) | ✅ |

补充内容取证（不只看 mtime）：`vm-service/dist/server.js:83 endTask(taskId)`、
`vm-service/dist/server.d.ts:106 setLogger` / `:118 ApprovalWarnSink` 均可 grep 到 ✅

### 6.2 全量受影响单测 before / after（T05 收口快照 2026-10-04 01:36）

| 单测 | before（基线） | after | 判读 |
| --- | --- | --- | --- |
| `k4-approval` | 6 / 6 / 0 | **6 / 6 / 0** | ✅ 零回归 |
| `k4-p3` | 16 / 16 / 0 | **16 / 16 / 0** | ✅ 零回归 |
| `k5-replay` | 41 / 41 / 0 | **41 / 41 / 0** | ✅ **D-1 红线未被削弱** |
| `r19c-a5-approval-coordinator` | 18 / 13 / **5** | **21 / 21 / 0** | ✅ **红档全清**（QA 同批改写：C5 归属断言、B 组补 taskId、D1 指纹翻转、Fix-4 新增断言；用例数 18→21） |
| `r19c-kn1-a-pure` | 76 / 76 / 0 | **76 / 76 / 0** | ✅ Q6 回归锚点 `:134` 仍绿 |
| `r19c-kn1-b-bridge` | 23 / 23 / 0 | **23 / 23 / 0** | ✅ 零回归 |
| `host-a2a-bridge` | 35 / 35 / 0 | **35 / 35 / 0** | ✅ 含 `:137 assert.equal(a.risk,'L2')` |
| `llm-provider` | 20 / 20 / 0 | **20 / 20 / 0** | ✅ 零回归 |

> 一律 `node --test tests/unit/<单文件>` 逐个跑，**未整批跑**。

### 6.3 守门结论

| 守门项 | 结论 |
| --- | --- |
| **D-4** `packages/a2a-framework/src/**` 零改动 | ✅ `git diff --stat 6ad6410 HEAD -- packages/a2a-framework/src/` **为空** |
| **D-5** `rejected` 唯一置位点 | ✅ 全仓 `packages/a2a-framework/src/` 内 `'rejected'` 仅 `server.ts:306` 一处，本轮未新增任何置位点 |
| **D-1** 红线两行 | ✅ 见 §4 的 before/after 原文与 git diff |
| **Q5 / Q6** `delegation-audit.ts:499` `risk:'L1'` | ✅ 一字未动 |
| **Q8** `APPROVAL_WAIT_PATTERN`(:568) / `parseApprovalBlock`(:581) | ✅ 未动 |
| **SK-7** `no-active-task` 仍「绝不自批」 | ✅ reason 取值与 `ApprovalOutcome` 判别联合一字未改，只是守卫不再被误命中 |

### 6.4 本迭代整体验收（spec T05 定义）

- ✅ `r19c-a5-approval-coordinator.test.js` **fail 5 → 0**（含 C5 改写后仍绿）
- ✅ `k5-replay.test.js` **41/41 绿**
- ✅ `tsc -b` 0 error；`git diff --stat` 中 `packages/a2a-framework/src/**` 为空
- ✅ `a2a-framework/src/server.ts:306` 仍是 `rejected` 唯一置位点
- ⏳ 真机 R3 回归（VM 恢复后，非本迭代门禁，责任人 QA）

### 6.5 遗留 / 需上报

1. **`npm run layout` 不可用**：`package.json:16` 指向 `node scripts/dep-lint.mjs`，但仓库**无 `scripts/` 目录**
   ⇒ 该脚本在本 HEAD 上属**既存失效**，与本次改动无关。D-4 改用 `git diff --stat` 守门（结论：零改动）。
   【2026-10-08 更新】QA R3（`c10a400`）已把 `layout` 键从 `package.json` **删除**——本条当时引述的 :16 定义现已不存在；`dep-lint` 属 **Phase 2 规划**，现阶段 D-4 类改动仍以人工方向核对 / `git diff --stat` 守门。
2. QA 在本轮实施中**并发提交**了两个测试 CL：`fafa59c`（Fix-4 新增断言）与
   `3681525`（C5 归属断言改写 + 翻转协议执行）。我的 before/after 计数以 T05 收口快照为准。
