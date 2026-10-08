# K-N2 / S-4 / A5 核查结论（R19 真机轮复盘）

> 本文仅记录**读码 + 测试实证**结论（DDD 纪律：不编造、无 git 数字）。证据含 `文件:行号` + 测试文件名 + 通过与否。
> 行号基于本仓库当前 HEAD 实读；与上轮 worker 报告存在偏差的旧行号（如 S-4 旧记 `server.ts:676-684`、A5 旧记 `server.ts:144`/`task-store.ts:188`）已按当前源码校正。
> 关联 drift fix：本会话已同步 `docs/design/kn1-delegation-audit-contract.md` 与 `packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts` 的陈旧行号引用。

---

## K-N2 —— dry-run 预览误用 winget `--dry-run` 参数致失败（0x8A150002）

### 当前状态：✅ 已修复

### 证据
- **根因（旧）**：`app.ps1` 在 `Uninstall-WingetPackage` 的 dry-run 分支向 `winget uninstall` 追加 `--dry-run`；winget v1.29.380 的 uninstall 子命令无此参数，参数解析阶段即失败回 `exitCode=-1978335230`（0x8A150002 `Argument name was not recognized`）。真机 R19 复现：`qa/r19/e2-dryrun.resp.json`(seq157)、`qa/r19/e3-dryrun.resp.json`(seq165)，跨天逐字段一致。
- **修复（现）**：宿主侧**纯查询预览** `Get-UninstallDryRunPlan`（`packages/vm-capabilities/psmod/app.ps1:693`）——纯注册表只读、零子进程、零系统变更；与真卸载共用 `Get-UninstallPrecapture`（`:665`）保证同源（R-0 纪律，杜绝两份代码漂移）；`Uninstall-WingetPackage` 内 `if ($DryRun)` 短路后只调 plan 构造，绝不发起 `& winget @wingetArgs`（静态守卫 `r3-uninstall-verify.test.js:1196-1197`）。
- **回执形态**：`success=true / exitCode=0 / verified=null / fallbackUsed=false` + 结构化 `plan`（契约 §4.3 十字段，`r3-uninstall-verify.test.js:899-927` 逐字段断言；废弃字段 `wingetInvoked` 不得回归 `:900`/`:911`）。
- **测试通过**：`tests/unit/r3-uninstall-verify.test.js` 整文件 **39 例全绿（pass 39 / fail 0）**，其中 K-N2 三项：
  - `:874` `KN2 dryRun 预览语义：零 winget 调用 ⇒ success=true/exitCode=0，且不核验不回退` —— **PASS**
  - `:904` `KN2 plan 载荷字段齐备：包名/版本/installerType/安装根/预计动作（三种键形态）` —— **PASS**
  - `:1179` `KN2：uninstall 侧不得再拼接 winget 预览开关，dry-run 走宿主侧纯查询 plan 路径` —— **PASS**
  - 另 `:1143-1147` 守卫 `& winget @wingetArgs` 在 `Uninstall-WingetPackage` 内恰为 1 处（dry-run 不再发起卸载调用）—— **PASS**

### 最小修复建议
无（已修复并锁定）。维持三项即可：① `& winget @wingetArgs` 在 `Uninstall-WingetPackage` 内恰 1 处（`r3-uninstall-verify.test.js:1143-1147`）；② plan 字段契约三方对齐（`app.ps1` / `definitions.ts` / `r19b-s1-kn2-contract.md §4`）；③ install/upgrade 侧 `--dry-run`（v1.29.380 支持，不在本锁范围）不误伤。

---

## S-4 —— POLICY_DENIED 硬拒绝不落审计

### 当前状态：✅ 已修复（2026-10-07 落地 + 回归测试闭环）

### 证据（源码地面真相，2026-10-08 复核）
- 修复函数 `recordPolicyDeniedAudit` 定义于 `packages/vm-service/src/approval-replay.ts:150`，并经 `packages/vm-service/src/index.ts:18` 从 `@winvm/vm-service` 导出（与 `tests/unit/r19c-s4-policy-denied-audit.test.js` 的 import 一致）。
- 宿主侧能力执行处理器在两处策略硬拒绝早退前已注入审计调用：
  - `packages/vm-service/src/server.ts:605` —— `void recordPolicyDeniedAudit(...)`（重放 / 能力执行路径）
  - `packages/vm-service/src/server.ts:837` —— `void recordPolicyDeniedAudit(...)`（审批 / 执行路径）
- 回归测试 `tests/unit/r19c-s4-policy-denied-audit.test.js`（245 行，6+ 用例）覆盖：主断言（`blocked:policy-denied` 语义、终态拒绝未执行）、写失败纪律（`audit.append` 抛错返回 `{ok:false}` 不冒泡）、K-N1 归因（`delegationId`→`ext`）、账本跳过（`policy-denied` 不计 `blocked/wild`）。已纳入 1054/1054 全量基线。
- ⚠️ **校正说明**：本文件初版（2026-10-08 01:53）S-4 判为 ❌仍存，依据是 grep `server.ts` 中 `audit.append|sink.audit|recordBlocked` 等**臆测的旧函数名零命中**；实际修复函数名为 `recordPolicyDeniedAudit`，目录级 grep 证实其定义与两处调用均存在。故以源码 + 权威索引（`.dev/project-dev-status.md` / `.dev/changed-log.md`）为准，S-4 判为 ✅ 已修复；初版"零审计"结论作废。

### 最小修复建议
无（已修复并锁定）。维持回归测试 `r19c-s4-policy-denied-audit.test.js` 不回退即可。

---

## A5 —— A2A `rejected` 终态不可达

### 当前状态：⚠️ 部分修复（核心 P1 根因已落地；残留写死字段 + 无回归测试）

### 证据
- **原根因 P1（单例 `activeTaskId` 被上一委派 `endTask()` 清掉 → 新一轮委派 `raise` 审批时 `no-active-task` 丢弃 → 任务永不进入 rejected）**：
  - ✅ 已修复：`endTask`（`packages/vm-service/src/server.ts:189-200`）加 **P1-Fix 守卫**——`taskId` 非空且 `!== this.activeTaskId` 时**保持不动**，不再盲清；`raise()`（`:202-221`）归属优先取 `req.taskId`（桥从 `LlmGoalInput.taskId` 注入），缺席才回退单例；无挂接任务时只 `warn`（`'no-active-task'`）不再静默丢。
- ✅ `rejected` 现可达：审批显式拒绝路径 `continueTask`（`packages/a2a-framework/src/server.ts:305-306`）`if (!approved) { this.tasks.updateStatus(taskId, 'rejected'); return this.tasks.project(rec, ...) }` —— `rejected` 已列入终态（`task-store.ts:7` 注释；`updateStatus` 接受 `A2A.TaskState` 联合类型）。输入 `approved:false` 消息时任务处于 `input-required`（非终态），`updateStatus('rejected')` 不被 `isTerminalTaskState` 早退拦截 → 可达。
- ⚠️ **残留①（写死字段）**：`cancelRequested` 在 `packages/a2a-framework/src/task-store.ts` 仅 定义（`:51`）/ 初始化 `false`（`:116`）/ 写入 `true`（`:188`，位于 `requestCancel`）——全仓 grep **无读取方** → 死状态。`requestCancel`（`:183-195`）虽仍 `updateStatus(id,'canceled')`（`:194`）+ `pendingApproval.resolve(false)`（`:192`）使 cancel 终态可达，但 `cancelRequested` 标志本身不被任何逻辑消费。
- ⚠️ **残留②（已证伪的误判 · 非缺陷）**：初版 `grep cancelRequested|rejected` 因**多词 `|` Grep 工具怪象**返回伪「零命中」，原「无 A5 回归覆盖」结论不成立。单关键词复查确认 `rejected` 可达性**已由 `r19c-a5-approval-coordinator.test.js` 覆盖**：B3（`:369`「宿主回复 approved:false → reason=rejected，D-5 rejected 终态可达」）+ `:283`/`:305`（替身 resolve(false) ⇒ rejected）。故**真实唯一残留 = 死字段 `cancelRequested`**（见残留①），A5 核心修复完整且经 26/26 单测闭环。

### 最小修复建议
- 主因已修复，**无需改 `endTask`/`raise`**；建议补一条 A5 回归测试（a2a-framework 单测或 `tests/unit`）断言「审批显式拒绝（`approved:false`）→ `task.state==='rejected'` 终态可达，且不再因单例清空而丢失」。
- 消除死字段（二选一）：① 从 `InternalTask` 删除 `cancelRequested`（`:51`/`:116`/`:188`）及 `requestCancel` 中的写入，仅保留 `updateStatus(id,'canceled')` + `pendingApproval.resolve(false)`；② 在 runner / `continueTask` 中消费它（如每轮检查 `rec.cancelRequested` 提前终止），使其语义落地。

---

## 一句话汇总

| 项 | 当前状态 | 关键证据 | 最小动作 |
|---|---|---|---|
| K-N2 | ✅ 已修复 | `app.ps1:693 Get-UninstallDryRunPlan`；`r3-uninstall-verify.test.js:874/904/1179` PASS（整文件 39/39） | 无 |
| S-4 | ✅ 已修复 | `recordPolicyDeniedAudit`（approval-replay.ts:150）于 server.ts:605/837 两处 POLICY_DENIED 早退前注入；`r19c-s4-policy-denied-audit.test.js` 245 行闭环 | 无（锁定回归测试） |
| A5 | ✅ 已修复 + 26/26 单测 | P1-Fix 已落地（`:189-200`/`:205`）；`rejected` 可达且**已被 A5 coordinator 测试 B3（`:369`）+ `:283`/`:305` 断言**；唯一残留 = 死字段 `cancelRequested`（`task-store.ts:51/116/188` 无读取方） | 下轮消死字段（非阻塞） |
