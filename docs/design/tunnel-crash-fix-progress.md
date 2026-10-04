# WinVM 隧道守护进程崩溃缺陷 —— 修复进度

> 责任人：software-engineer（寇豆码） · 独占范围 `delivery/**`（含新建 `delivery/__tests__/`）
> 禁区：`packages/**`、`tests/**`、`docs/test/**`、`qa/**` —— 全程零触碰。
> 纪律：ockets-peer DM 一律经主理人中转；每完成一个逻辑单元单独 commit。

## 0. 缺陷画像（主理人取证）

- 现象：隧道守护进程运行一段时间后**直接退出**，pidfile 消失、本地 18443 停监听。
- 两次复现：10-04 01:22（14 分钟后消失）、10-04 04:07（`O3zMyl`，pid 55660，存活 2h39m 后崩）。
- 崩溃栈关键点：`Emitted 'error' event on OhSshTunnel instance at: delivery/oh-tunnel.mjs:414:16`。

## 1. 根因复核结论（本人独立复核，非转述）

**主理人的定位准确，且可被逐字校验。** 三条证据：

1. **行数对齐**：修复前 `delivery/oh-tunnel.mjs` 第 414 行正是 `this.emit('error', err);`
   （位于 `_onLocalConnection()` 的 `forwardOut` 回调 × `if (err)` 分支）。
2. **无人注册 `'error'` 监听**：`delivery/tunnel-daemon.mjs:193-196` 只注册了
   `ready / close / reconnecting / reconnected` 四者，**唯独没有 `error`**。
   Node EventEmitter 规则：无 `'error'` 监听时 `emit('error')` 会 **throw**，
   而该调用处于 ssh2 的异步回调栈里无人 catch ⇒ uncaughtException ⇒ 进程退出。
3. **本地硬复现**：见 §3 before 组，崩溃栈与主理人取证栈逐字一致（同文件同行列 `:414:16`）。

补充发现（主理人未提及的**第二处静默缺陷**）：
`_connectOnce()` 里的 `fail()` 有 `if (settled) return;` 短路，导致 **ready 之后**
到达的连接层错误（如 keepalive 超时 `No response from server`）被**静默吞掉**：
`alive` 仍为 `true`、不触发重连 ⇒ 隧道「假活」（端口在监听、实际不可用，且不报警）。
before 探针已取证该场景 `reconnectingCount: 0` 且 `aliveAtEnd: true`。

## 2. 修复策略（最小变更，复用既有退避机制）

| # | 改动 | 落点 |
|---|---|---|
| F1 | 新增 `_safeEmit/_safeEmitError`：无 `'error'` 监听时**绝不 throw**；监听内部抛错也兜住 | `oh-tunnel.mjs` |
| F2 | 全文 3 处 `this.emit('error', …)` 全改为 `_safeEmitError` | `oh-tunnel.mjs` |
| F3 | `forwardOut` 失败：丢弃该连接 + 错误分级（连接层 vs 单通道）+ 连续失败阈值 ⇒ 触发既有退避重连 | `oh-tunnel.mjs` |
| F4 | ready 后连接层 `client 'error'`：标记失活并触发重连（消除「假活」） | `oh-tunnel.mjs` |
| F5 | `_teardownClient()`：拆连接时 `removeAllListeners` 后补 noop error 兜底（防 ssh2 Client 二次 unhandled） | `oh-tunnel.mjs` |
| F6 | `_scheduleReconnect` 加 timer 去重；达上限时发 `'giveup'` 终态事件（携带原因） | `oh-tunnel.mjs` |
| F7 | daemon 注册 `error` 监听把原因写进 state 文件；`giveup` ⇒ 有序退出 | `tunnel-daemon.mjs` |
| F8 | daemon 增加 `uncaughtException/unhandledRejection` 兜底：写 state 后继续保活，杜绝静默死 | `tunnel-daemon.mjs` |

安全边界：**监听绑定仍为 `127.0.0.1` 回环**（`LOOPBACK_HOSTS` 白名单未动）；CLI 参数契约零变更。

## 3. before / after 对照

探针（自建，独立子进程取证，避免进程内 try/catch 假象）：

- `delivery/__tests__/probe-tunnel-error.mjs` —— 隧道类层，三场景
- `delivery/__tests__/probe-daemon-error.mjs` —— 守护进程层（走 `runDaemon()`）
- `delivery/__tests__/oh-tunnel-error-handling.test.mjs` —— node:test 断言，spawn 上述探针

### before（修复前，已取证）

| 场景 | 结果 |
|---|---|
| `forward-out-error-no-listener` | **进程崩溃**：exit 1，`Unhandled 'error' event`，`oh-tunnel.mjs:414:16` |
| `client-error-no-listener` | 不崩但**假活**：`reconnectingCount=0`、`aliveAtEnd=true` |
| `forward-out-error-with-listener` | 不崩，`tunnelErrorEvents` 收到错误，但 `reconnectingCount=0`（无自愈） |

崩溃栈原文（节选）：

```
node:events:486
      throw er; // Unhandled 'error' event
Error: No response from server
Emitted 'error' event on OhSshTunnel instance at:
    at file:///…/delivery/oh-tunnel.mjs:414:16
```

### after（修复后，已取证，2026-10-04 09:5? 本地子进程注入）

三场景均**不再崩溃**，且走退避重连 / 恢复可用；守护进程层 state 文件记录原因。

| 场景 | 结果 |
|---|---|
| `forward-out-error-no-listener` | `survived:true`、`reconnectingCount:1`、`reconnectedCount:1`、`connectCount:2`、无 `Unhandled 'error' event`、stop 干净 |
| `client-error-no-listener` | `survived:true`、`reconnectingCount:1`、`reconnectedCount:1` —— **假活已消除**（修复前该值为 0 且 aliveAtEnd=true） |
| `forward-out-error-with-listener` | `survived:true`、`tunnelErrorEvents:["No response from server"]`、`reconnectingCount:1` |

守护进程层（`runDaemon` 注入 `deps`）：

- `forward-out-error` 注入后：日志出现 `WARN 隧道错误（已内部消化，走退避重连）：No response from server`；
  `stateAfterInject.state=RUNNING`、`lastEvent=reconnected`、`pidfile/state` 仍存在（进程存活）；
- `client-error` 注入后：同上，`stateAfterInject.state=RUNNING`、`reconnected`。

关键对照（同一注入，前后差异）：

```
BEFORE  forward-out-error-no-listener → exit 1 / Unhandled 'error' event / oh-tunnel.mjs:414:16
AFTER   forward-out-error-no-listener → exit 0 / 退避重连 / 恢复 RUNNING / 无 Unhandled
```

## 4. commit 清单

| hash | 范围 | 内容 |
|---|---|---|
| `d68d430` | delivery/__tests__/* + docs | 故障注入探针（before 证据）+ 进度文档（**未改产品代码**） |
| `4d53bd9` | delivery/oh-tunnel.mjs | 核心修复：_safeEmit/_safeEmitError、错误分级重连、消除假活、teardown 兜底、giveup 终态 |
| `ccab0b3` | delivery/tunnel-daemon.mjs | 守护进程注册 error/giveup 监听 + uncaughtException 兜底 + writeStateAtom(extra) |
| `（末单元）` | delivery/__tests__/oh-tunnel-error-handling.test.mjs + docs | 单测 + 进度收口 |

全部 commit 均**零触碰** `packages/**`、`tests/**`、`docs/test/**`、`qa/**`。

## 5. 验证记录

### 5.1 本地可跑（已执行，子进程取证）

- 既有单测无回归（单文件跑）：
  - `node --test tests/unit/oh-tunnel.test.mjs` → **19/19 pass**
  - `node --test tests/unit/tunnel-daemon.test.mjs` → **10/10 pass**（QA 独占区，仅运行未改）
- 新建崩溃修复单测（单文件跑，符合「单测绝不整批跑」）：
  - `node --test delivery/__tests__/oh-tunnel-error-handling.test.mjs` → **8/8 pass**
    - 分类器连接层判定（No response from server / keepalive / econnreset …）
    - 隧道类层 forwardOut / client-error 注入：子进程不崩 + 退避重连 + 恢复
    - 守护进程层注入：存活 + state 记录原因 + 18443 仍可用
    - 进程内：未注册 error 监听时 forwardOut 失败只触发重连、不抛未捕获异常

### 5.2 真机验证（由主理人在主会话执行，见下节口令）

## 6. 真机验证口令清单（交主理人执行）

> 环境事实：隧道只能跑在主理人的网络命名空间；子 agent 到 172.16.100.2 是 EHOSTUNREACH、本地 18443 是 ECONNREFUSED。故以下步骤由主理人执行并把原始输出回传。

### 6.1 拉起（与现有命令一致，CLI 契约未变）

```bash
node delivery/tunnel-daemon.mjs \
  --vm-host 172.16.100.2 --vm-user User \
  --key /storage/Users/currentUser/.ssh/id_ed25519
# pidfile 默认 ~/.workbuddy/winvm/tunnel.pid，state 默认 ~/.workbuddy/winvm/tunnel.state.json
```

### 6.2 注入故障 + 判定通过

- **判定通过（修复生效）**：
  - `tunnel.state.json` 在 VM 侧 sshd 抖动/断链时呈 `DEGRADED` 并带 `lastError`/`errorCount`，随后自动回到 `RUNNING`（不再整进程退出，pidfile 不消失、18443 仍监听）；
  - 即便未捕获的单次错误也不出现进程退出；日志出现 `WARN 隧道错误（已内部消化，走退避重连）：<原因>`。
- **注入方式（任选其一，纯真机侧）**：
  1. 临时 kill 掉 VM 内 sshd / 断 VM 网络数秒再恢复 → 触发 keepalive 超时 `No response from server` / 通道打开失败；
  2. 在 VM 上 `systemctl restart ssh` 或拔网卡 → 触发 `close` / 连接层 `error`；
  3. 观察：`tail -f ~/.workbuddy/winvm/tunnel.log`，看 `WARN 隧道错误…` 与 `隧道已就绪…` 交替（自愈）。
- **有序退出判定**：把 `maxAttempts` 压到极低（临时改 `--vm-host` 指向不可达地址 + 该实例 `maxAttempts` 注入）后，state 应落 `STOPPED` 并带 `reason`/`attempts`，pidfile 被清理，进程退出码非崩溃（不静默死）。

### 6.3 回环绑定自检（安全约束未被破坏）

- 确认监听仅 `127.0.0.1`：`ss -ltnp | grep 18443` 应显示 `127.0.0.1:18443`，**不得**出现 `0.0.0.0` / `:::18443`。
- 代码中 `LOOPBACK_HOSTS` 白名单未动；`normalizeOpts` 仍拒绝非回环 `localBindHost`。

## 7. 偏离与未决项

- **偏离**：原 `maxAttempts` 默认 `Infinity`（永不放弃，符合「默认持续」语义）。修复保留该默认，仅当显式给上限时才会触发 `giveup` 有序退出；「连续重连失败达上限」机制已实现并通过 `giveup` 事件 + state 可诊断。若主理人希望默认也设上限（如 30 次），请裁定。
- **未动**：启动期 VM 不可达的有序退出（2s、日志清晰、不 crash）保持原样，未触碰。
- **进程级 uncaughtException 兜底**（daemon 内）是有意取舍：单次异常不再致命，但会写 state 保持可诊断；若主理人认为应更激进（如 N 次后退出）可再加计数门限。

