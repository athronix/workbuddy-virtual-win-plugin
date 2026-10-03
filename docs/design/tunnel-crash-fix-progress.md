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

### after（修复后）

> 待补 —— 见 §5 验证记录。

## 4. commit 清单

> 逐单元追加。

## 5. 验证记录

> 逐单元追加。
