# WinVM 隧道运维速查（tunnel-runbook）

> Phase 3 批2 · Q1 成文（源自 audit-qa.md ⑥ 三次"死"复盘 + 项目 memory 实操沉淀）。
> 本页只讲**宿主侧常驻隧道 daemon**（`delivery/tunnel-daemon.mjs` / `oh-tunnel.mjs`）。
> 隧道设计见 `docs/oh-tunnel-design.md`；崩溃修复进度见 `docs/design/tunnel-crash-fix-progress.md`。
> 命名说明：审计原文建议落 `docs/05-peripherals/RUNBOOK-TUNNEL.md`，批2 任务书裁定落本路径（`docs/04-ops/`），以任务书为准。

---

## ① 判活三值（唯一事实源）

隧道"活着没有"**不能只看一个信号**。三值中前两者为终判，state.json 仅是快照：

| 判据 | 命令 | 含义 | 可信度 |
|---|---|---|---|
| **进程存活** | `kill -0 <pid>`（pid 取 `~/.workbuddy/winvm/tunnel.pid` 的 `.pid`） | daemon 进程在不在 | **终判之一**（ESRCH=真死） |
| **转发可用** | `curl -s -m5 http://127.0.0.1:18443/health` → `ok:true` | 端口听 + ssh 通道活 | **终判之一**（黑洞态此处即露） |
| 状态快照 | `winvm-plugin tunnel status`（读 `tunnel.state.json`） | 最近一次自报态 | **参考**：僵尸快照可挂数小时不变 |

> 铁律（memory:3/8 原话）：**`state.json ≠ 实况`，判活终靠 `kill -0` + `curl`**。
> `tunnel.state.json` 的 `RUNNING` 可能是退出前的僵尸快照；`STOPPED`（批2 起带 `reason`）是死因终态证据。

### tunnel 子命令（正规入口，四态收敛）
```
winvm-plugin tunnel status     # 读三值，打印 state/pid/ownerMatch/stateStale
winvm-plugin tunnel ensure     # 幂等三态收敛：RUNNING→跳过 / DEGRADED→重启一次 / STOPPED→拉起（唯一推荐复活动作）
winvm-plugin tunnel restart    # 先 stop 再起
winvm-plugin tunnel stop [--force]
```

---

## ② 三型死法速查（各给日志特征串）

`~/.workbuddy/winvm/tunnel.log` 每行含 `pid=<进程号>`（批2 起），可据此归因并发实例。

| 型 | 表现 | 日志特征串 | 根因 | 恢复 |
|---|---|---|---|---|
| **A 僵尸转发态** | 进程活着、端口听、但连接秒断（curl 黑洞/rc=7） | `Keepalive timeout` + 多行 `No response from server`（WARN 内部消化）；`state=DEGRADED` | ssh 断线后 `_onLocalConnection` 对每个新连接 `localSocket.destroy()`（`oh-tunnel.mjs`）；`_alive` 假在 | `tunnel ensure`（DEGRADED→重启一次） |
| **B 缺参/参数即退** | 重启即退，双行 ERROR | `ERROR 隧道启动失败（参数/构造期，不可重试）：缺少必填项 vmHost`（或 username/port）；`state=STOPPED reason=start-config-error` | 裸跑 daemon 漏 `--vm-*`（构造期 `normalizeOpts()` throw）。批2 起：**不再静默 rmSync，留 STOPPED+reason** | 用 `tunnel ensure`（全参来自 `vm-conn.json`，见④）；**禁止裸跑 daemon** |
| **C pid 回收 + state 撒谎** | `kill -0`=ESRCH，但 `state.json` 仍 `RUNNING` | 无 ERROR（进程被外部/OS 回收，来不及写终态）；旁证：`tunnel status` 报 `stateStale:true` | 外部 kill/OS 回收；僵尸快照未更新 | `tunnel ensure`（pid 不在→STOPPED 路径拉起新实例） |

### 启动期失败（旧"即退"型，批2 已并入退避）
2026-09-30 `EHOSTUNREACH` 十条型：VM 晚醒一分钟，daemon 首连失败。
- **旧行为**：`catch → shutdown() → exit 1`，零重试，需外部再 ensure。
- **新行为（批2 Q1）**：启动阶段失败进入与稳态同款的**指数退避重试**（默认无限，`--start-retry N` 可设上限），daemon 存活后台自愈；放弃时保留 `state=STOPPED reason=start-giveup`。
- 判读：`tunnel status` 见 `DEGRADED` + `startAttempt`/`nextRetryInMs` = **自愈中**（勿误当死）；见 `STOPPED` + `reason` = 已放弃，`tunnel ensure` 复活。

---

## ③ 恢复动作（唯一推荐）

```bash
# 一条命令收敛到"在线健康"，可安全重复调用：
winvm-plugin tunnel ensure
```

- **明令禁止裸跑 daemon**：`nohup node delivery/tunnel-daemon.mjs --vm-host ...` 极易漏参触发 B 型（audit-qa ⑥ 死2 实证）。全参列表由 `tunnel ensure` 从 `vm-conn.json` 自动注入。
- 需手工兜底时（仅调试）：全参来源 = `~/.workbuddy/winvm/vm-conn.json` 的 `host/user/sshPort/servicePort/identityFile` 五键；缺任一即构造期 throw。
- **凭据纪律**：`password` 仅经环境变量 `WINVM_VM_PASSWORD`，`privateKey` 仅经 `--key <文件>`；值绝不进命令行明文/日志（daemon 侧已守）。

---

## ④ 并发实例排查（同毫秒双写竞态）

旁证：同文件相邻重复行（"隧道已就绪"/"已有隧道进程"同毫秒 ×2）= 两进程各 append 同一行（audit-qa ⑥）。三源 ensure：install-host 尾 spawnSync + SessionStart hook + HOURLY watchdog。

```bash
# 1) 数 daemon 实例（>1 即并发）：
ps -ef | grep tunnel-daemon | grep -v grep

# 2) 核对 pidfile cmd 第 2 段（缓存根 vs 仓库路径）与 state.pid 属主是否一致：
cat ~/.workbuddy/winvm/tunnel.pid            # .pid / .localPort
cat ~/.workbuddy/winvm/tunnel.state.json     # .pid 应与 pidfile 一致，否则 stateStale

# 3) 日志按 pid 归因（批2 起每行有 pid=）：
grep 'pid=' ~/.workbuddy/winvm/tunnel.log | awk '{print $4}' | sort | uniq -c
```

**批2 防护**：daemon 现以 `open(pidfile,'wx')` 独占创建抢锁，同毫秒第二实例会命中 EEXIST → 主动退出（日志：`pidfile 已被并发实例独占持有`），杜绝双 bind。

---

## ⑤ HOURLY watchdog 说明（交付品外，本机兜底）

- 本机靠用户侧自动化 `aaa87da4`（HOURLY）定期 `tunnel ensure` 兜底复活（audit-qa ⑥/⑦、DB-7）。
- **该自动化不在交付物里**（别的用户没有）——属残余风险：会话长跑期间 daemon 死 = 到下次 ensure 才自愈。交付品内的被动 ensure 仅有 SessionStart hook（会话开始时触发一次）。
- watchdog 与 hook / install-host 三源并存时靠④的 pidfile 独占锁去重（批2 起）。
- 判活自动化最小配方：`winvm-plugin tunnel ensure` 幂等，重复调用安全；建议定时任务每小时一次即可覆盖 B/C 型死法（A 型 ensure 内含重启一次，C 型拉起新实例）。

---

## ⑥ 相关文件

- 隧道运行时：`delivery/tunnel-daemon.mjs`、`delivery/oh-tunnel.mjs`、`delivery/ssh2-resolve.mjs`
- 宿主 CLI：`delivery/winvm-plugin.mjs`（tunnel 子命令）
- 连接信息：`~/.workbuddy/winvm/vm-conn.json`（0660；键 host/user/sshPort/servicePort/identityFile，凭据走 identityFile）
- 运行态文件：`~/.workbuddy/winvm/{tunnel.pid, tunnel.state.json, tunnel.log}`
- 单测：`tests/unit/tunnel-daemon.test.mjs`、`tests/unit/phase3-b2-tunnel-start.test.js`
