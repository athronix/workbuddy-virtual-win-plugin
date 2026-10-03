# A5 审批丢弃缺陷 —— 修复实施进度（Engineer 独占落盘）

> 用途：增量落盘进度，进程异常中断时可按本文件恢复，不必重做。
> 权威依据：`docs/design/a5-approval-drop-fix-contract.md`（STATUS: FINAL，794 行）
> 实施人：寇豆码（software-engineer）。**独占 `packages/**`；不碰 `tests/**`、`docs/test/**`、`qa/**`**。
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

## 3. T02 —— Fix-1A + Fix-1B + `no-active-task` 告警（已完成，commit `f66cd0a`）

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

## 4. T03 —— Fix-2：per-delegation 三态搬离单例（待做）

## 5. T04 —— Fix-4a / 4b：风险展示真实化（待做）

## 6. T05 —— 类型门禁与回归收口（待做）
