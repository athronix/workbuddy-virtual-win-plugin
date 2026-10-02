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
