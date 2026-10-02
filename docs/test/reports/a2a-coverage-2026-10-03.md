# A2A 通道「真机未覆盖 5 项」补齐验证（A-X）

- 执行窗口：**2026-10-02 23:58 → 2026-10-03 00:08 CST**（UTC 2026-10-02T15:58Z–16:08Z），其后 VM 中断
- 环境前置：隧道 `RUNNING`（pid 42332，`/proc/<pid>/cmdline` 第 2 段以 `tunnel-daemon.mjs` 结尾）→ `ping 172.16.100.2` 0% 丢包 → `GET /health` HTTP 200 `ok:true`（`llmSession.state=stopped`，`restarts=0`）
- 驱动脚本：`$HOME/wbtmp/a2a-extra.mjs`（绝对路径 `--prefix`、`--k=v` 等号参数、SSE 增量分帧读取、写完再读二次确认 mtime+bytes）
- 纪律：本轮**未改任何 `packages/**` 源码**；未整批跑单测（A-X 为真机轮，无单测改动）

## 逐项结论（判据 / 实测值 / 结论 / 证据）

| 项 | 判据 | 实测值 | 结论 | 证据文件 |
|---|---|---|---|---|
| **A1** `message/stream`（SSE） | HTTP 200 + `Content-Type: text/event-stream` + 持续读到 **≥2 个 `data:` 帧** + 终态事件 | `http=200`；`ct=text/event-stream; charset=utf-8`；`eventCount=8`；`eventKindSeq=[status-update×6, artifact-update, status-update]`；`terminalEvent={kind:"status-update", final:true, state:"completed"}`；`firstFrameMs=281`；`totalMs=37242`；`taskId=b470dc18-7df6-4ff4-bacc-9086a1edf47f` | **PASS** | `a2a-x1-stream.out.json`（8354B） |
| **A2** `tasks/list` | 200 + `tasks` 数组含本轮 taskId | `taskCount=1`，`totalSize=1`，`states=[{b470dc18-…-7df6-4ff4-bacc-9086a1edf47f, completed}]`，`expectTaskId=b470dc18-…`，`expectFound=true`；前置基线（空库）`taskCount=0/totalSize=0` 且仍 200 → 方法本身可用、不因空库报错 | **PASS** | `a2a-x2-list.out.json`（4779B）+ `a2a-x2-list-baseline.out.json`（402B） |
| **A3** agent card 发现 | `GET /.well-known/agent-card.json` → 200 + `capabilities` / `skills` | `http=200`，`contentType=application/json; charset=utf-8`，`bytes=1203`，`name="WinVM Bridge Agent"`，`version=0.1.0`，顶层键含 `protocolVersion/name/description/version/url/provider/capabilities/defaultInputModes/defaultOutputModes/supportedInterfaces/skills`，`hasCapabilities=true`，`hasSkills=true`，`skillsCount=5`，`capabilities={streaming:true,pushNotifications:false}`；附加实测 `POST agent/getAuthenticatedExtendedCard` → `{"code":-32603,"message":"AuthenticatedExtendedCardNotConfiguredError"}`（不在判据内，**如实记录、不计为失败**） | **PASS** | `a2a-x3-card.out.json`（3359B） |
| **A4** `tasks/cancel` | 长耗时**只读**委派 → 首个 `working` 后 `tasks/cancel` → 终态 `canceled` | `taskId=48a90a2f-82a3-427f-bbdd-bf6a3a8aceee`（目标：递归统计 `C:\Windows\System32` 下 `.dll` 总数，只读）；`stateBeforeCancel=working`；cancel RPC 回 `state=canceled`；`pollSeen=[{atMs:2978,state:canceled}]`；`finalState=canceled`。**首次尝试失败属用例设计问题**：`settle-ms=15000` 而「列出 Temp 文件名」约 15s 就完成 → cancel 命中终态，回 `-32602 TaskNotCancelableError`「任务处于 completed，不可取消」（框架**正确**行为）；已改 `settle-ms=2500` + 更长只读目标重试成功 | **PASS** | `a2a-x4-cancel.out.json`（2958B） |
| **A5** 审批拒绝 → `rejected` | 按契约 D-5：L2 高危委派 → 挂起 `input-required` 取 `approvalId` → 回复 `approved:false` → 终态 `rejected`（唯一置位点 `packages/a2a-framework/src/server.ts:306`） | `taskId=51229514-2438-44f3-b44d-53ad9070b327`，创建 `16:03:20.834Z` → **终态 `failed` `16:03:37.915Z`**（17.08s，capability `durationMs=12454`）。审批闸**确实触发**：`status.message` 文本含 `APPROVAL_REQUIRED` 且带 `approvalId=apr_a9aabfcffb5f4246b918`，artifact `execution-steps` 步骤 `ok:false` / summary「等待审批（未执行完成）」。但**从未进入 `input-required`**：`reachedInputRequired=false`、`history` 仅 1 条 user 消息、`metadata` **无** `approvalTimedOut`（排除 TTL 收口）、`approvalData=null`、脚本报「未拿到 approvalId，无法回复拒绝」 | **FAIL**（目标态 `rejected` 未达成，实测落到 `failed`） | `a2a-x5-reject-v1.out.json`（5018B） |

### A5 缺陷四元组

- **现象**：L2 高危委派（`app.winget.uninstall` + 不存在的包 `QA.R19B.Nonexistent.99997`）的审批闸已触发并产生了 `approvalId`，但任务**未挂起 `input-required`**，17s 直接收口 `failed`；宿主因此**无从**按协议回复 `approved:false`，D-5 的 `rejected` 置位路径在真机上**不可达**。
- **根因（未定，两个候选均被逐段静态核对削弱）**：
  1. `bridge.maybeResume` 早退（`!blocked || !this.coordinator`，`bridge.ts:665`）：`blocked` 必然成立（`error.code='APPROVAL_REQUIRED'`，且终态文本带 `approvalId=` 即证明 `parseApprovalBlock` 解析成功、`details.approvalId` 为字符串）；coordinator 注入链 `vm-service bridgeCtx(:351)` → `core/bridge/loader.loadProvider` 直传 `ctx` → `provider.init(:198)` → `bridge.setApprovalCoordinator(:872)` 全链路在位。
  2. `VmApprovalCoordinator.raise` 早退（`!this.activeTaskId || !this.tasks`，`vm-service/src/server.ts:175`）：`beginTask` 由 `bridge.runGoal(:737)` 无条件调用，且 `input.taskId` 由 provider(`:347`) + 框架(`:334 goalWithTask={...goal, taskId:id}`) 双重保证；`bind(a2a.tasks, pendingApprovals)` 在 `server.ts:938` 无条件调用。
  - 另已排除「dist 陈旧」：`dist/*` 构建于 2026-10-02 20:40，**晚于**所有相关 src（最晚 19:15），且 dist 内 `beginTask(:490)` / `bind(:750)` / `maybeResume(:663,665)` / `raise` 均在与 src 相同位置。
  - 两候选都被静态核对削弱 → 存在**第三条未识别路径**（如 persistent 分支的 `maybeResume` 实际未被调用 / `raisedApprovals` 去重命中 / `waitApproval` 被瞬时收口后状态被终态覆盖），**需服务端一行 `raise` 入口日志（`approvalId` + `activeTaskId` + `hasTasks`）复跑定位**。
- **证据文件**：`qa/r19/a2a-x5-reject-v1.out.json`（同名 `.timeline.log` 在 `$HOME/wbtmp/`，repo `.gitignore:20 *.log` 不入库）。
- **路由建议**：**Engineer**（源码/行为缺陷复核，优先在 `raise` 入口加一行日志定位点）。

## 环境中断（A5 v2 复核 BLOCKED）

- `2026-10-03 00:08:14Z` 起隧道 `state=DEGRADED, alive=false, lastEvent=reconnecting`（pid 42332）。
- 复测：`ping 172.16.100.2` → **100% 丢包**；`arp -an` → `172.16.100.2 at <incomplete> on WVMBr14571594`；`ssh User@172.16.100.2` → `connect to host 172.16.100.2 port 22: Host is unreachable`。
- 隧道守护进程 `/proc/42332` 已消失，无 `ssh -N` 残留进程，`127.0.0.1:18443` 无监听。
- 判定：VM **整机不可达**（不是「服务未启动」），本轮无开机手段 → **A5 v2 复核 BLOCKED**，待 VM 恢复后续跑。

## A5 v2 复核脚本（已就绪，待续跑）

`$HOME/wbtmp/a2a-extra.mjs` 的 `reject` 分支已改造完毕（尚未运行）：

1. 轮询间隔由固定 10s 改为 `--poll-ms`（默认 **1000ms** 密采），杜绝 v1「10s 采样漏掉短时 `input-required`」的口径质疑；
2. 若仍未拿到挂起态 `approvalId`，则**从终态文本回捞 `apr_` token 并按协议真发一次 `approved:false` 回复** —— 用服务端应答把「该任务上根本没有待处理审批」从推断升级为**协议级证据**（预期：`continueTask` 报「任务上没有待处理的审批 <id>」）。

复跑命令：`node $HOME/wbtmp/a2a-extra.mjs reject --prefix=$HOME/wbtmp/a2a-x5-reject --poll-ms=1000`

## 路由判定

- **A1 / A2 / A3 / A4：全绿 → NoOne**（无需 Engineer，无需续跑）。
- **A5：FAIL + v2 复核 BLOCKED → 路由 Engineer**（携带上述四元组）；同时需 team-lead 决策 VM 恢复后的续跑窗口，以补上「1s 密采 + 协议级拒绝回复取证」这一步。
