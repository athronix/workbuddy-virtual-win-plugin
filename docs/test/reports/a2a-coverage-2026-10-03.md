# A2A 通道「真机未覆盖 5 项」补齐验证（A-X）

- 执行窗口：**2026-10-02 23:58 → 2026-10-03 00:08 CST**（UTC 2026-10-02T15:58Z–16:08Z），其后 VM 中断
- 环境前置：隧道 `RUNNING`（pid 42332，`/proc/<pid>/cmdline` 第 2 段以 `tunnel-daemon.mjs` 结尾）→ `ping 172.16.100.2` 0% 丢包 → `GET /health` HTTP 200 `ok:true`（`llmSession.state=stopped`，`restarts=0`）
- 驱动脚本：`$HOME/wbtmp/a2a-extra.mjs`（已同步为 `qa/r19/a2a-extra.mjs`，16459B；绝对路径 `--prefix`、`--k=v` 等号参数、SSE 增量分帧读取、写完再读二次确认 mtime+bytes）
- 纪律：本轮**未改任何 `packages/**` 源码**；未整批跑单测（A-X 为真机轮，无单测改动）

## 逐项结论（判据 / 实测值 / 结论 / 证据）

| 项 | 判据 | 实测值 | 结论 | 证据文件 |
|---|---|---|---|---|
| **A1** `message/stream`（SSE） | HTTP 200 + `Content-Type: text/event-stream` + 持续读到 **≥2 个 `data:` 帧** + 终态事件 | `http=200`；`ct=text/event-stream; charset=utf-8`；`eventCount=8`；`eventKindSeq=[status-update×6, artifact-update, status-update]`；`terminalEvent={kind:"status-update", final:true, state:"completed"}`；`firstFrameMs=281`；`totalMs=37242`；`taskId=b470dc18-7df6-4ff4-bacc-9086a1edf47f` | **PASS** | `a2a-x1-stream.out.json`（8354B） |
| **A2** `tasks/list` | 200 + `tasks` 数组含本轮 taskId | `taskCount=1`，`totalSize=1`，`states=[{b470dc18-…-7df6-4ff4-bacc-9086a1edf47f, completed}]`，`expectTaskId=b470dc18-…`，`expectFound=true`；前置基线（空库）`taskCount=0/totalSize=0` 且仍 200 → 方法本身可用、不因空库报错 | **PASS** | `a2a-x2-list.out.json`（4779B）+ `a2a-x2-list-baseline.out.json`（402B） |
| **A3** agent card 发现 | `GET /.well-known/agent-card.json` → 200 + `capabilities` / `skills` | `http=200`，`contentType=application/json; charset=utf-8`，`bytes=1203`，`name="WinVM Bridge Agent"`，`version=0.1.0`，顶层键含 `protocolVersion/name/description/version/url/provider/capabilities/defaultInputModes/defaultOutputModes/supportedInterfaces/skills`，`hasCapabilities=true`，`hasSkills=true`，`skillsCount=5`，`capabilities={streaming:true,pushNotifications:false}`；附加实测 `POST agent/getAuthenticatedExtendedCard` → `{"code":-32603,"message":"AuthenticatedExtendedCardNotConfiguredError"}`（不在判据内，**如实记录、不计为失败**） | **PASS** | `a2a-x3-card.out.json`（3359B） |
| **A4** `tasks/cancel` | 长耗时**只读**委派 → 首个 `working` 后 `tasks/cancel` → 终态 `canceled` | `taskId=48a90a2f-82a3-427f-bbdd-bf6a3a8aceee`（目标：递归统计 `C:\Windows\System32` 下 `.dll` 总数，只读）；`stateBeforeCancel=working`；cancel RPC 回 `state=canceled`；`pollSeen=[{atMs:2978,state:canceled}]`；`finalState=canceled`。**首次尝试失败属用例设计问题**：`settle-ms=15000` 而「列出 Temp 文件名」约 15s 就完成 → cancel 命中终态，回 `-32602 TaskNotCancelableError`「任务处于 completed，不可取消」（框架**正确**行为，构成负向对照，`a2a-x4-cancel.timeline.log:1-9`）；已改 `settle-ms=2500` + 更长只读目标重试成功（同文件 `:10-18`） | **PASS** | `a2a-x4-cancel.out.json`（2958B） |
| **A5** 审批拒绝 → `rejected` | 按契约 D-5：L2 高危委派 → 挂起 `input-required` 取 `approvalId` → 回复 `approved:false` → 终态 `rejected`（唯一置位点 `packages/a2a-framework/src/server.ts:306`） | `taskId=51229514-2438-44f3-b44d-53ad9070b327`，创建 `16:03:20.834Z` → **终态 `failed` `16:03:37.915Z`**（17.08s，capability `durationMs=12454`）。审批闸**确实触发**：`status.message` 文本含 `APPROVAL_REQUIRED` 且带 `approvalId=apr_a9aabfcffb5f4246b918`，artifact `execution-steps` 步骤 `ok:false` / summary「等待审批（未执行完成）」。但**从未进入 `input-required`**：`reachedInputRequired=false`、`history` 仅 1 条 user 消息、`metadata` **无** `approvalTimedOut`（排除 TTL 收口）、`approvalData=null`、脚本报「未拿到 approvalId，无法回复拒绝」 | **FAIL**（目标态 `rejected` 未达成，实测落到 `failed`） | `a2a-x5-reject-v1.out.json`（5018B） |

## A5 四元组（v2 定位）

- **现象**：L2 高危委派（`app.winget.uninstall` + 不存在的包 `QA.R19B.Nonexistent.99997`）的审批闸已触发并产生了 `approvalId`，但任务**未挂起 `input-required`**，17s 直接收口 `failed`；宿主因此**无从**按协议回复 `approved:false`，D-5 的 `rejected` 置位路径在真机上**不可达**。

- **根因（P1 假设显著占优；P2 待一次静默窗口实验证伪）**

  **P1 —— 服务级单例 `activeTaskId` 被「上一次委派」的收尾清掉（并发/时序缺陷）**
  1. `packages/vm-service/src/server.ts:144` `VmApprovalCoordinator.activeTaskId` 是**服务级单例**字段，`beginTask`/`endTask`（`:167`–`:173`）全局唯一一份；
  2. `packages/adapter-agent-workbuddy-llm/src/bridge.ts:737`（`beginTask`）/`:741`（`finally → endTask`）成对包住**每一次** `runGoal` ⇒ 任一委派收尾都会把 `activeTaskId` 置 `undefined`；
  3. `packages/a2a-framework/src/task-store.ts:188` `rec.cancelRequested = true` **全仓只写不读**（grep 仅 3 处：`:51` 声明 /`:116` 初始化 /`:188` 赋值）⇒ 被 cancel 的委派其 LLM turn **继续跑**，`runGoal` 不即时返回；
  4. 实测时序：A4 `48a90a2f…` 于 `16:03:09.765Z` 被 cancel（`a2a-x4-cancel.timeline.log:15,18`），但其 `runGoal` 仍在飞；A5 于 `16:03:20.870Z` 发起并 `beginTask(51229514…)`；A5 的 turn ~12.45s 后结束进入 `maybeResume → raise`。若此刻 A4 的 `runGoal` 收尾执行 `endTask()`，则 `raise` 命中 `vm-service/src/server.ts:177` 的 `!this.activeTaskId → {approved:false, reason:'no-active-task'}`，**直接返回 base、从不调用 `waitApproval`** ⇒ 不挂 `input-required` ⇒ 框架按 `result.ok=false` 收口 `failed`（`a2a-framework/src/server.ts:365`）。
  5. 与 E1r2 的差分吻合：E1r2（`tr_r19_munzlt2f`，2026-09-30）走 **oneshot** 路径（终态步骤 `params` 无 `session` 键，`qa/r19/e1r2-final-task.json:142-145`），当次无并发委派 ⇒ `activeTaskId` 未被清 ⇒ 挂起成功（`e1r2-delegate.out.json:61 state=input-required`，`:76-79` 结构化 `approval-request`）；A5 走 **persistent** 路径（步骤 `params.session="persistent"`），且紧随一个「已 cancel 但仍在跑」的委派之后 ⇒ 交叠。

  **P2 —— `this.coordinator` 未注入**（`bridge.ts:934` `if (!blocked || !this.coordinator) return base;`）
  注入链 `vm-service bridgeCtx(:351)` → `core/src/bridge/loader.ts:106 provider.init(ctx)` → `index.ts:198-200 setApprovalCoordinator` → `bridge.ts:872` 在 **src 与 dist 双侧均完整**（`dist/index.js:149`、`dist/bridge.js` 含 `maybeResume`×3），`bind(a2a.tasks, pendingApprovals)` 在 `server.ts:938`（`dist/server.js:750`）无条件执行 ⇒ 概率低；在 P1 被证伪前不能完全排除。

- **已排除的分支**（逐条）：`!approvalId`（终态文本带 `approvalId=` ⇒ `parseApprovalBlock` 解析成功、`details.approvalId` 为字符串）／`!blocked`（`error.code='APPROVAL_REQUIRED'`）／`raisedApprovals` 去重（`bridge.ts:730` 入口 `clear()`，首轮）／TTL 收口（metadata 无 `approvalTimedOut`）／宿主应答或 cancel 收口（A5 无人回复、未对 A5 发 cancel）／`runGoal` 抛异常（终态 message 是桥的「等待审批」文案，非 `errorMessage()` 的异常文案）／**dist 陈旧**（dist 构建 10-02 20:40，晚于全部相关 src；`dist` 内 `beginTask`/`bind`/`maybeResume`/`raise` 与 src 同位）。

- **风险判级澄清**（lead 提的「`steps[0].risk` A5=L1 / E1r2=L2」差异）：**该差异不存在，且判级不是挂起开关**。
  - `steps[0].risk` 是桥在 `runPersistent`（`bridge.ts:1175`）里**硬编码的字面量 `'L1'`**（`runOneShot` 同），与 policy engine / definitions 无关；E1r2 终态步骤同样是 `risk:"L1"`（`e1r2-final-task.json:146`，2 处）。
  - E1r2 里的 `"risk":"L2"` 出现在**审批卡 data part**（`{"type":"approval-request",…,"risk":"L2"}`，`e1r2-delegate.out.json:76-79`），来源是 `maybeResume` 的 `details.risk ?? 'L2'` **兜底默认值**（`bridge.ts:940`），不是策略判级结果。
  - 全链路 `maybeResume(925-960)` → `coordinator.raise(vm-service:175)` → `taskStore.waitApproval(task-store:211-259)` **无任何 risk 分支** ⇒ risk 只进入审批卡文案与审计字段，**不参与「能否挂起」**。

- **决定性判别实验**（待 VM 恢复）：在**无任何其它委派在飞**的静默窗口单独跑一次 A5 —— `node qa/r19/a2a-extra.mjs reject --prefix=$HOME/wbtmp/a2a-x5-reject --poll-ms=1000` → 若挂起 `input-required` 则 P1 证实；若仍不挂起则转 P2。建议 Engineer 同时在 `raise` 入口加一行只读日志（`approvalId` + `activeTaskId` + `hasTasks`）作为定位点。

- **证据**：`qa/r19/a2a-x5-reject-v1.out.json`（5018B）+ `a2a-x4-cancel.timeline.log`（A4 cancel 时序；`.log` 按 `.gitignore:20` 不入库，原件在 `$HOME/wbtmp/`）+ `qa/r19/e1r2-delegate.out.json:61/76-79` + `qa/r19/e1r2-final-task.json:142-146`。

- **路由建议**：**Engineer**（单例 `activeTaskId` 的并发/时序缺陷 + `cancelRequested` 只写不读；均属源码行为缺陷，非用例设计问题）。

## 环境中断（A5 v2 复核 BLOCKED）

- `2026-10-03 00:08:14Z` 起隧道 `state=DEGRADED, alive=false, lastEvent=reconnecting`（pid 42332）。
- 复测（本轮再次确认）：`ping 172.16.100.2` → **100% 丢包**；`arp -an` → `172.16.100.2 at <incomplete> on WVMBr14571594`；`ssh User@172.16.100.2` → `connect to host 172.16.100.2 port 22: Host is unreachable`；`curl http://127.0.0.1:18443/health` → `http=000`。
- 隧道守护进程 `/proc/42332` 已消失，无 `ssh -N` 残留进程，`127.0.0.1:18443` 无监听。
- 判定：VM **整机不可达**（不是「服务未启动」），本机无开机手段 ⇒ **A5 v2 复核 + 审计（`GET /audit/receipt?traceId=`）对照 BLOCKED**，待 VM 恢复后续跑。

## A5 v2 复核脚本（已就绪，待续跑）

`qa/r19/a2a-extra.mjs`（同 `$HOME/wbtmp/a2a-extra.mjs`）的 `reject` 分支已改造完毕（尚未运行）：

1. 轮询间隔由固定 10s 改为 `--poll-ms`（默认 **1000ms** 密采），杜绝 v1「10s 采样漏掉短时 `input-required`」的口径质疑；
2. 若仍未拿到挂起态 `approvalId`，则**从终态文本回捞 `apr_` token 并按协议真发一次 `approved:false` 回复** —— 用服务端应答把「该任务上根本没有待处理审批」从推断升级为**协议级证据**（预期：`continueTask` 报「任务上没有待处理的审批 <id>」）。

复跑命令：`node $HOME/wbtmp/a2a-extra.mjs reject --prefix=$HOME/wbtmp/a2a-x5-reject --poll-ms=1000`

## 路由判定

- **A1 / A2 / A3 / A4：全绿 → NoOne**（无需 Engineer，无需续跑）。
- **A5：FAIL → 路由 Engineer**（携带上述四元组：P1 单例 `activeTaskId` 交叠 + `cancelRequested` 只写不读；判别实验待 VM 恢复）。
- **A5 v2 复核 + 审计对照：BLOCKED → 需 team-lead 决策 VM 恢复后的续跑窗口**。

## A6 —— A5 离线确定性测试（P1 单例 `activeTaskId` 交叠）：机制级复现已锁定

> 产出：`tests/unit/r19c-a5-approval-coordinator.test.js`（465 行 / 21593B，commit `9c54d95`）
> 目的：真机 BLOCKED 期间，把 P1 怀疑链从「源码推演」升级为**可离线反复运行的断言**。
> 本轮只做测试与实测，**不产出根因结论**（根因判定见并行的 `docs/design/a5-approval-drop-rootcause.md`）。

### A6.1 被测对象与可信度边界（如实标注）

- **真实实现，非替身**：`VmApprovalCoordinator` 取自 `@winvm/vm-service`（→ `packages/vm-service/dist/server.js`），`TaskStore` 取自 `@winvm/a2a-framework`（→ `packages/a2a-framework/dist/task-store.js`）。二者均为纯逻辑类；已实测 `import` 只拿到导出符号，**不启动 HTTP 服务 / 不监听端口 / 不 spawn ps-bridge / 不连 VM**。
- **唯一的替身**：注入 `bind()` 的 **TaskStore spy**（`waitApproval` 直接 `resolve(false)`）。这是被测对象的**依赖**，不是被测对象本身；用途是断言「有没有调用 `waitApproval`」。
- **dist 新鲜度守卫**（用例 `A0`）：断言 `dist/server.js` 仍含 `if (!this.activeTaskId || !this.tasks)` 与 `this.tasks.waitApproval(this.activeTaskId, enriched)`，且 `dist.mtime ≥ src.mtime`（实测 src `2026-10-02T08:44:24Z` < dist `2026-10-02T12:40:48Z`）。改了 src 未重新 build 时该用例立即 FAIL，杜绝「在陈旧产物上得出假结论」。
- **读取 TS-private 字段**：`activeTaskId` / `tasks` / `pendingApprovals` 在编译产物中是普通 JS 属性（编译期 `private` 已擦除），测试直接读取以钉死**实际值**。
- **未改动 `packages/**` 任何文件**（`git status` 已核：`packages/` 无改动项）。

### A6.2 用例清单与实测结果

运行：`node --test tests/unit/r19c-a5-approval-coordinator.test.js`（node v24.13.0；**只跑单文件**）
实测：**tests 14 / pass 11 / fail 3 / exit=1**；连续两次运行结果完全一致（确定性成立）。

| 用例 | 断言意图 | 实测 | 含义 |
|---|---|---|---|
| A0 dist/src 一致性守卫 | dist 由当前 src 编译而来、守卫形态未漂移 | PASS | 行为断言可信的前提（防陈旧产物假象） |
| A1 单例字段读写 | `beginTask('A')`→`'A'`；`endTask()`→`undefined`（如实记录实际值） | PASS | 单例字段确认（`server.ts:167`–`:173`） |
| A2 交叠场景 raise 实际返回 | `begin(A)→begin(B)→endTask()` 后 `raise()` 返回 `{approved:false, reason:'no-active-task'}`，且 B 任务状态仍为 `submitted` | PASS | **核心表征**：审批闸被绕过，B 从未挂起 —— 与 A5 真机症状一致 |
| A3a waitApproval 被调用 | 有 activeTaskId 时 `waitApproval` 被调用 1 次，入参 `id==='B'`（取自单例） | PASS | 挂起目标来自**服务级单例**，而非请求自带 taskId |
| A3b waitApproval 未被调用 | `endTask()` 后 `waitApproval` / `updateStatus` 调用次数均为 **0**，且 <100ms 立即返回 | PASS | `server.ts:177` 早退 ⇒ **从不调用** `waitApproval`、不挂起、不等待宿主 |
| B1 交叠不应降级 no-active-task | 修复后：B 仍在飞时 `raise` 不应回 `no-active-task`，且 `waitApproval` 应被调用 1 次（挂起目标为 B） | **FAIL** | `actual: 'no-active-task'`；`waitApproval` 0 次 |
| B2 应挂起且结构化 approval-request | 修复后：B 应达 `input-required`，且 `status.message` 含 `type:'approval-request'` data part 并携带 `approvalId` | **FAIL** | `actual: 'submitted'`（无 data part）⇒ 正是 A5「approvalId 只在文本里、不在结构化 data part」的成因 |
| B3 宿主拒绝可达 rejected | 修复后：宿主按协议回复 `approved:false` 应回 `reason:'rejected'` | **FAIL** | `actual: 'no-active-task'` ⇒ 契约 D-5 的 `rejected` 终态（**唯一置位点** `a2a-framework/src/server.ts:306`）为何真机不可达 |
| C1 endTask 幂等 | 连调 3 次不抛错；不解绑 `tasks`、不清空 `pendingApprovals`、不消费 token | PASS | 修复时的副作用边界 |
| C2 空 taskId 早退 | `beginTask('')` / `beginTask(undefined)` ⇒ falsy ⇒ `no-active-task`，`waitApproval` 0 次 | PASS | `bridge.ts:737` `input.taskId ?? ''` 的真实风险点：taskId 缺失 ⇒ 审批闸**静默失效** |
| C3 cancelRequested 无人消费 | 扫 `packages/*/src/**/*.ts`（排除 dist）：`cancelRequested` 全仓仅 **3** 处，且形态恰为声明 / 初始化 / 赋值；行为旁证：`requestCancel` 靠 `updateStatus('canceled')` + `pendingApproval.resolve(false)` 收口，**不读标志** | PASS | P1 第 3 环（交叠窗口来源）成立；将来新增读取点时本用例会 FAIL（即修复已落地） |
| C4 串行场景回归锚点 | 无交叠时正常挂起 `input-required` + 结构化 approval-request；批准后 `approved:true` 且 `token.hostApproved===true` | PASS | **对照组**：证明「单例被清空」是唯一变量；修复 P1 不得破坏 K4/K5 语义 |
| C5 归属形态预留 | 断言当前 `endTask.length === 0`（无参 ⇒ 无法表达「哪个任务收尾」） | PASS | `@todo-P1-fix`：归属改造后改为按 taskId 归属断言 |
| Z-汇总 | 打印全部用例 PASS/FAIL 明细表 | PASS | 让分布肉眼可辨 |

### A6.3 运行命令与输出原文摘录

```
$ node --test tests/unit/r19c-a5-approval-coordinator.test.js
▶ A5 / A 表征：VmApprovalCoordinator.activeTaskId 单例语义
  ✔ A0 被测对象可信度守卫：dist 由当前 src 编译而来（含守卫与 endTask 置空） (4.1625ms)
  ✔ A1 beginTask/endTask 对单例字段的实际读写值 (0.496094ms)
  ✔ A2 交叠场景（A 收尾清空后，B 的 raise 返回什么）—— 本轮核心用例 (1.296562ms)
  ✔ A3a 有 activeTaskId 时：raise 确实调用 taskStore.waitApproval（单例值即挂起目标） (0.56625ms)
  ✔ A3b endTask 清空后：raise 从不调用 waitApproval，且立即返回（不挂起、不等待） (0.470469ms)
▶ A5 / B 红档：交叠场景下 B 的审批仍应可挂起（当前必然 FAIL）
  ✖ B1 交叠场景：B 的审批请求仍应被挂起（不应因 A 的收尾降级为 no-active-task） (1.332657ms)
  ✖ B2 交叠场景：B 任务应到达 input-required 且 approvalId 出现在结构化 data part (13.652813ms)
  ✖ B3 交叠场景：宿主回复 approved:false 后应得 reason=rejected（D-5 rejected 终态可达） (1.255625ms)
▶ A5 / C 边界与回归锚点
  ✔ C1 endTask() 幂等性…  ✔ C2 beginTask('') / undefined…  ✔ C3 task-store.cancelRequested 全仓只写不读…
  ✔ C4 回归锚点：串行（无交叠）场景必须照常挂起并批准…  ✔ C5 @todo-P1-fix 预留…
ℹ tests 14
ℹ pass 11
ℹ fail 3
ℹ duration_ms 405.524375
```

B 组三条失败原文（`✖ failing tests` 块）：

```
✖ B1  AssertionError [ERR_ASSERTION]: 修复后：B 仍在飞，A 的收尾不得让 B 的审批闸早退为 no-active-task
      actual: 'no-active-task'   expected: 'no-active-task'   operator: 'notStrictEqual'

✖ B2  AssertionError [ERR_ASSERTION]: 修复后：B 应挂起为 input-required
      + actual - expected
      + 'submitted'
      - 'input-required'

✖ B3  AssertionError [ERR_ASSERTION]: 修复后：宿主拒绝应回 rejected（当前回 no-active-task ⇒ 宿主无从回复 ⇒ rejected 终态不可达）
      + actual - expected
      + 'no-active-task'
      - 'rejected'
```

### A6.4 结论

**P1 在离线环境：已复现**（机制级；二选一结论，不含糊）。

- **已锁死**：交叠场景下（`beginTask(A) → beginTask(B) → endTask()` 模拟 A 的 runGoal 收尾）`raise()` 立即返回 `{approved:false, reason:'no-active-task'}`，**从不调用 `waitApproval`** ⇒ B 任务从未进入 `input-required` ⇒ status 里没有结构化 `approval-request` data part ⇒ 宿主无从按协议回复 `approved:false` ⇒ `a2a-framework/src/server.ts:306` 的 `rejected` 置位点不可达 ⇒ 框架按 `result.ok=false` 收口 `failed`（`a2a-framework/src/server.ts:365`）。与 A5 真机样本（终态文本带 `approvalId=apr_a9aabfcffb5f4246b918`、`steps[0].summary`=「等待审批（未执行完成）」、**从未挂起**、17.08s 直接 failed）逐项吻合。
- **未推翻 P1**：B 组 3 条**全部 FAIL**，无一条意外 PASS。
- **口径边界（不含糊的部分）**：本轮复现的是**机制**，不是 A5 那一次真机时序的端到端回放。即「若 A5 当时处于交叠窗口，则必然不挂起」已被证明；「A5 当时**确实**处于交叠窗口」仍待 VM 恢复后用 `raise` 入口只读日志（`approvalId` + `activeTaskId` + `hasTasks`）或 §A5 已就绪的静默窗口判别实验确认。
- **修复验收口径**：P1 修复落地后 —— 本文件 **B 组 3 条应转绿**；**A 组 A2 / A3b 会转 FAIL 且属预期**（它们钉的是「当前缺陷行为」，修复后需按新行为同步改写）；**C 组 5 条必须保持 PASS**（回归护栏）。

### A6.5 路由

- **Engineer**（单例 `activeTaskId` 的并发/时序缺陷）：测试文件 commit `9c54d95`；B 组 3 条 FAIL 是**缺陷证据**，非用例设计问题。修复需同时给出「端到端可达 `rejected` 终态」的验证路径。
- 与并行静态根因判定不冲突：本轮只在 `tests/unit/` 与本报告作业，未触碰 `docs/design/a5-approval-drop-rootcause.md`。
