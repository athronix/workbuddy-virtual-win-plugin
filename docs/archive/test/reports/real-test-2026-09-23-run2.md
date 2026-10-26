# WinVM Bridge 真环境测试执行记录 · Run2（回归轮）

| 项 | 值 |
|---|---|
| 文档 | REAL-TEST-winvm-bridge-run2 |
| 日期时间 | 2026-09-23 04:49–05:13 UTC（宿主本地 `+08:00`：12:49–13:13） |
| 执行人 | QA（Edward，software-qa-engineer） |
| 依据方案 | `docs/test/real-test.md`（v1.0，含 Run1 实测修正） |
| 上游依据 | `docs/test/reports/real-test-2026-09-23.md`（Run1 权威）＋主理人 Round2 补丁（D6–D13 回归范围） |
| 通道 | MCP（宿主 CLI `command <tool>`）· A2A（`qa/probes/a2a.mjs` → 宿主 A2A 桥）· 宿主 CLI 运维子命令（`tunnel`/`server`） |
| 部署基线 | 重投部署完成于本地 **12:37**（缓存根 4 文件 mtime＝12:37） |

> **一句话结论**：Run1 登记的全部**待修缺陷（D6 / D9 / D10 / D11 / D12）本轮回归全部 PASS**；**GUI 域 4/4 实测复现 PASS**、**§3.3 双子例双双 PASS**、**D11 常驻会话故障注入实证 PASS**、**D13 空载 3.7min 全绿 PASS**、**OB-1 未复现（44.4s<60s）**、**残留清理完成**。**Round2 发现项：0 FAIL**；
>
> **【主理人裁定后更正 · OB-3 定性改正】** 原记「1 条环境级观察（OB-3：并发 VM 独占任务导致的瞬时降级）·流程协调项·非产品缺陷」**不成立**。经独立复核并发窗**原始载荷**（`session.state='unavailable'` / `provider.state='degraded'` / `psBridge.probe='timeout'`），该窗口**暴露了真实产品缺陷 D15**：`delivery/setup.mjs` 的 HEALTH 门禁曾把 `state='unavailable'`（超时／**结论未知**）当终态并下**强断言「【非交互式/降级会话】→ GUI 能力不可用」**（并打印误导性「💡 启用 GUI」补救块）→ **误报（false negative）**。**D15 已立案、已由 Engineer 修复**（`interpretHealth()` 三态判定：非 `healthy` 一律 `unknown`；退避复探 10s×≤6、预算 90s；`unknown` 分支不置 `guiDegraded`、不打印补救块），并已端到端复证（`run3-full-deploy.log` HEALTH 相位：首探 `unavailable → 结论未知 → 10s 复探(1/6) → ✅ interactive:true`）。**据此，本文「建议关闭 2 轮收敛、不进第 3 轮」的判断被推翻 → 已进入第 3 轮**（`docs/test/reports/real-test-2026-09-23-run3.md`）。

---

## 一、环境快照（时间戳：2026-09-23T05:13:10Z ＝ 本地 13:13）

| 项 | 值 |
|---|---|
| 宿主平台 / node | `openharmony` / `v24.13.0` |
| 仓库 == 缓存根 md5 | **4/4 MATCH** —— `winvm-plugin.mjs=efdafd2d1e31` · `tunnel-daemon.mjs=4ed08c1fd630` · `oh-tunnel.mjs=8c397ae7eb24` · `ssh2-resolve.mjs=35f1678d9614`（与主理人**权威哈希**逐字节一致） |
| 缓存根 `.winvm-context.json` | `{"side":"host"}`（16 B，mtime `12:37`）✅ |
| 缓存根文件 mtime | 4 文件均 `2026-09-23 12:37`（＝重投部署落点） |
| VM 地址 / 端口 | `172.16.100.2:22`（SSH，直连探测 `SSH_OK`）· vm-service `127.0.0.1:18443`（仅本机监听，经常驻隧道） |
| 隧道（pidfile / state / 监听） | pidfile `pid=48202`（`startedAt 2026-09-23T05:12:33Z`）· `tunnel status` `state=RUNNING,healthy=true,ownerMatch=true,stateStale=false` · `127.0.0.1:18443` **CONNECTED** |
| `/health` 摘要 | `ok:true` · provider `ready` · psBridge `ready`(uptime 108.5s,pending 0,restarts 0) · session `WinSta0/interactive:true/locked:false/state:healthy` · capabilities **54/54** · audit `chainValid:true` · exposed 54 |
| 快照时效声明 | 本轮存在**并发进程改写 VM 状态**（工程师 D14(b) 整条部署）：隧道 daemon pid 于本轮内多次变化（`37199→41823→43056→43477→48202`），均为**并发部署的合法结果**，非隧道缺陷。上述为**报告时点**稳定快照。（注：同一窗口的一次 `provider=degraded` 已**更正定性为产品缺陷 D15**，见 §六 / §八 8.3） |

---

## 二、第一类 · 部署完整性（6/6 PASS）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 宿主缓存根 4 文件与仓库一致 | **PASS** | 4/4 md5 `MATCH`（见快照，逐字节＝权威哈希） |
| 2 | `.winvm-context.json == host` | **PASS** | 缓存根 `{"side":"host"}`（Run1 曾误查仓库 cwd；本轮已更正至**缓存根**，符合方案 §2.1） |
| 3 | VM 关键 dist 字节一致 | **PASS** | 3/3 `SAME`：`vm-service/dist/server.js=f39fa15c6d0c` · `adapter-agent-workbuddy/dist/index.js=d65fe46c0637` · `vm-service/dist/cli.js=20ba1a4265f0` |
| 4 | 计划任务 `WinVMBridge.Service` 存在 | **PASS** | `server status` → 「已注册」；`schtasks //Query //TN //XML` 命中 |
| 5 | **双触发 `BootTrigger` + `LogonTrigger`** | **PASS（D10 已修）** | live task XML `<Triggers><BootTrigger /><LogonTrigger /></Triggers>`（`BootTrigger=1 / LogonTrigger=1`）；VM `install-vm.mjs` **41,754 B @ 2026-09-23T11:27:30**（`BootTrigger×3`）——VM 侧旧副本已随重投覆盖 |
| 6 | 隧道 三一致（pidfile + cmdline + 监听） | **PASS** | pidfile `pid=48202` 存活 · `/proc/48202/cmdline` 含 `tunnel-daemon.mjs` · `127.0.0.1:18443` CONNECTED · `ownerMatch=true` |

---

## 三、第二类 · 健康性（3/3 PASS，含 §3.3 拆双子例）

| # | 检查项 | 结果 | 证据（数值） |
|---|---|---|---|
| 1 | `/health` 全绿（ok / 54 / chainValid / ready） | **PASS** | `ok:true` · 54/54 · `chainValid:true` · provider/session/psBridge `ready` |
| 2 | F2 懒刷新（TTL 45s 窗口） | **PASS** | `BEFORE cached=true ageMs=79,848 (>45,000)` → `command system.network.config` `ok=true durationMs=3,115` → `AFTER cached=true ageMs=3,660 (<45,000)` → **F2 PASS=true**（`WINVM_NETCFG_TTL_MS=45000` 生效） |
| 3 | 隧道自愈（拆为两子例，**D12 修复后可完整触发**） | **PASS（双子例）** | 见 §3.3 详表 |

### 3.3 隧道自愈 · 双子例（Round2 关键补强）

> Run1 该项记 **BLOCKED**（触发路径被 D12 污染，实测 79s 语义偏离）。本轮 D12 修复后，两条路径**均可确定性触发**，拆例复测如下：

| 子例 | 步骤 | 阈值/期望 | 实测 | 判定 |
|---|---|---|---|---|
| **① VM 服务重启 → 工具可用恢复时长** | `server restart`（Stop-ScheduledTask → kill 残留 → Start-ScheduledTask）→ 1s 间隔轮询 `meta.health.check` | 黑窗口 < 60s；恢复=true | `firstFailMs=4,372` → `firstRecoverMs=48,791` → **黑洞 44,419ms（≈44.4s）**，`恢复=true`，`DEGRADED 未见`（VM 服务侧重启语义） | **PASS**（44.4s<60s） |
| **② 隧道 daemon 层自愈（不产生第二实例）** | 终止 daemon（SIGTERM pid 41823）→ `tunnel ensure` → 扫 `/proc` 计实例 | 恢复 RUNNING；`procs.length===1`；新 pid≠旧 pid | kill 后 `state=STOPPED / procs=[]` → `ensure`：「隧道已启动」→ `pid=43056`、`procs=[43056]`、`state=RUNNING/healthy=true/ownerMatch=true` | **PASS**（单实例、pid 变化、健康） |

> **旁证（D12）**：子例①的 `server restart` 本轮**首次成功执行**并回显「已重启（Stop-ScheduledTask → kill 残留 → Start-ScheduledTask -TaskName WinVMBridge.Service）」——Run1 同一命令曾抛 `无效参数/选项 - 'C:/Program Files/Git/end'`。D12 修复由此**端到端可用性**得到验证（另见 §六 D12 行）。

---

## 四、第三类 · 用例逐条结果（Round2 补跑与回归）

### 4.1 Run1 矩阵沿用（25 条）
- Run1 已达成 **24 PASS / 1 BLOCKED / 0 FAIL**（`system`4 · `app`4 · `storage`4 · `gui`4 · `appops`3+1BLOCKED · `meta`2 · `A2A`3）。本轮**不重跑全量**，仅补跑 Run1 受环境限制的 GUI / A2A 相关项并做回归。

### 4.2 GUI 域补跑（本轮实测复现，4/4 PASS）
| ID | 通道 | 结果 | 关键证据 |
|---|---|---|---|
| TC-GUI-01 | MCP | **PASS** | `gui.session.status`：`sessionId=1, windowStation=WinSta0, interactive=true, locked=false, blackScreen=false, explorerAlive=true, state=healthy`（**实时健康**，非依赖 Run1 快照） |
| TC-GUI-02 | MCP | **PASS** | `gui.screen.capture {asBase64:true}`：`encoding=base64, mimeType=image/png, width=1536, height=1024, bytes=499,850, base64Len=666,468 (>1000), prefix=iVBORw0KGgo` |
| TC-GUI-03 | MCP | **PASS** | `gui.window.list {visibleOnly:true}`：`isArray=true, len=8`；实取标题含 `设置` / `Windows PowerShell` / `WorkBuddy` / `Notepad` 等；元素键 `handle/title/processName/processId` |
| TC-GUI-04 | MCP | **PASS** | `gui.wait.condition {windowExists, windowTitle:"设置"(实取), timeoutMs:10000}`：`met=true, elapsedMs=26`，墙钟 2,882ms < 10,000ms |

### 4.3 A2A 通道补充
| ID | 通道 | 结果 | 关键证据 |
|---|---|---|---|
| TC-A2A-03 | A2A | **PASS（严格）** | `a2a.delegate` 截屏并描述 → **76,468ms**；产出 `content[type=image]`（`iVBORw0KGgo…` base64，PNG） |

> **A2A 冷启动复核**：本轮温热尝试首调出现 `A2A_DELEGATE_FAILED`（835ms / 57,673ms 两次有界失败），第 3 次成功建会话——与 Run1 登记的 **A2A 冷启动停滞（P1·已知）**一致，**非新缺陷**。

### 4.4 未变项
| ID | 结果 | 说明 |
|---|---|---|
| TC-AOP-03 | **仍 BLOCKED** | 只读探测 VM **无任何工作流登记文件** → 无可用登记工作流（前置不满足，不判 FAIL，Run1 已裁定） |

---

## 五、通过率

| 层 | 统计 |
|---|---|
| 部署完整性 | **6/6 PASS** |
| 健康性（含 §3.3 双子例） | **3/3 PASS** |
| GUI 补跑 | **4/4 PASS** |
| A2A 补充 | **1/1 PASS（严格）** |
| 缺陷回归（D6/D9/D10/D11/D12 修复项） | **全部 PASS** |
| §4 任务用例（累积口径） | 25 条 → **24 PASS · 1 BLOCKED · 0 FAIL**（BLOCKED 为前置不满足，非缺陷） |
| **Round2 新增 FAIL** | **0** |

---

## 六、缺陷清单（状态流转 / 根因 / 路由）

| 编号 | 级别 | Run2 状态 | 复证证据 | 路由/处置 |
|---|---|---|---|---|
| **D6** 隧道 statePath 硬编码 | P1 | **✅ 已修·复证 PASS** | 确定性注入：（CASE1）`--pidfile <tmp> --local-port 18990` 起实例 9s → 默认 `tunnel.state.json` sha1 前后一致、mtime 未变，旁路 `<pidfile>.state.json` 生成（pid 41354）→ **默认未被污染**；（CASE2-a）篡改默认 state `pid=99999` → `state=RUNNING,pid=37199,stateOwner=99999,ownerMatch=false,stateStale=true`；（CASE2-b）`ensure` 输出「隧道已在线健康（pid 37199），无需拉起」，pid 未重启 | **关闭** |
| **D7** skills 隧道前置 | P1 | **✅ 已修** | `skills/*/SKILL.md` 注入「前置（隧道在线健康）… `winvm-plugin tunnel ensure`」；`winvm-mcp-reference` 声明常驻 daemon、无需手建 ssh 转发 | **关闭** |
| **D8** 部署脚本 ssh 文案 | P1 | **✅ 已修** | `winvm-mcp-reference` 3 处「手建隧道」文案 → daemon 机制；`install-host.mjs`(12:14) / `install-vm.mjs`(11:27) / `setup.mjs`(12:47) 均为新版 | **关闭** |
| **D9** skills 字节一致 | P1 | **✅ 已修·复证 PASS** | 仓库 `skills/`（9 文件）逐文件 md5 vs VM：`C:/WinVMBridge/skills` 与 `C:/WinVMBridge/shared-skills` **均 `IDENTICAL=true`**（onlyLocal/onlyRemote/contentDiff 全空） | **关闭** |
| **D10** 任务缺 BootTrigger | P1 | **✅ 已修·复证 PASS** | live task `BootTrigger=1 & LogonTrigger=1`；VM `install-vm.mjs` 41754 B @ 11:27:30（BootTrigger×3） | **关闭** |
| **D11** health 幻象降级 | P1 | **✅ 已修·复证 PASS** | 故障注入：baseline `{state:ready,pid:9252,restarts:0,idleMs:84397}` → kill VM 子进程 9252 → `t+2s {state:degraded,restarts:0,lastError:"常驻 CLI 进程退出（code=4294967295）",lastErrorAt:"2026-09-23T05:09:04.473Z"}` → 重建 → `{state:ready,pid:1188,restarts:1}`，**lastError 已清空**。另：会话未创建时 `llmSession` **字段缺省（absent）**，为 `server.ts:658` 设计语义 | **关闭** |
| **D12** 宿主 server 子命令（MSYS） | P1 | **✅ 已修·复证 PASS** | `server status` → 「计划任务 WinVMBridge.Service : 已注册 / 服务端口 :18443 : 监听中 ✅」；`server start` → 「已触发启动（Start-ScheduledTask …）」（幂等）；`server restart`（§3.3①）成功。**无** `C:/Program Files/Git/…` 路径转换错误 | **关闭** |
| **D13** 空载降级 | P2 | **✅ PASS（结案）** | 空载 3.7min（04:52:58→04:56:43Z）4 次采样 `provider=ready / psBridge=ready / session=healthy / llmSession=ready` 全绿 → **空载≥3min 无自发降级**；此前 `llmSession=stopped`（idleMs 走 TTL 后）属**设计态**、非缺陷 | **关闭** |
| **A2A 冷启动停滞** | P1·已知 | **已知**（未结） | 冷态首调有界失败（835ms/57,673ms），第 3 次成功；热态 76.5s 完整产出 PNG | 保持已知；本轮不计 FAIL |
| **OB-1** 隧道路径黑洞 ≈79s | P2 | **未复现** | Run2 §3.3① 实测黑洞 **44.4s**（<60s）；Run1 的 79s 系**异常触发路径（D12 未修）**下的观测 | 降级为历史观察 |
| **OB-2** A2A 产物基目录 | P2 | **已定因（采纳）** | 产物落 `C:\Users\User\WinVMWorkspace\out\`（adapter 约定 `%USERPROFILE%\WinVMWorkspace\out`）≠ 用例写死的 `C:\WinVMWorkspace\out`；两条均在白名单 | 用例约定（QA 已修）+ 契约澄清项（P2） |
| **OB-3 → D15**（**本轮新；定性已更正**） | ~~P2·观察·环境/流程~~ → **P1·产品缺陷（D15）** | **✅ 已修·端到端复证** | **① 现象（照实保留）**：报告窗口 05:01–05:08Z 观测 `/health` `provider=degraded`（`provider.health() 在 5000ms 内未返回`）、`session.sessionId=0 / windowStation=""`、宿主 `health` 抛 `SSH 执行失败（exit 7）`；**15s 后自愈**为 `provider=ready / session=1 / WinSta0`；时序与并发窗见 §八 8.3。**② 定性更正（真相）**：并发的**真实危害不是「伪异常」**，而是**暴露了脚本把 `state='unavailable'`（超时/未知）当终态并下强断言**这个真缺陷——`delivery/setup.mjs:1032` 旧判据 `h.session.interactive === false` → 断言「服务运行在【非交互式/降级会话】→ GUI 能力不可用」+ 打印「💡 启用 GUI」人工补救块 + 收尾再告警 = **误报（false negative）+ 误导性人工指令**，直接削弱用户诉求 #4「一键部署」。**③ 修复**：Engineer 改造 HEALTH 门禁为 `interpretHealth()` **三态判定**（`gui-ok` / `gui-degraded` / `unknown`；**非 `healthy` 一律 `unknown`**）+ **退避复探 10s×≤6、预算 90s**；`unknown` 分支**不置 `guiDegraded`、不打印补救块**（`setup.mjs` L316 / L1101 / L1127-1171）。**④ 复证**：单测 `tests/unit/setup-health-verdict.test.js` **8/8 PASS**（QA 自跑，`qa/evidence/run2/run3-d15-unit.out`）；端到端 `run3-full-deploy.log` HEALTH 相位首探 `unavailable → ⏳结论未知（不判非交互）→ 10s 复探(1/6) → ✅通过 interactive:true`。**原 OB-3 的「宣告独占时间窗」建议已采纳，但降为 P3 流程项**（见 §七） | **D15 关闭**；原 OB-3「独占窗」建议 → **P3 流程项** |

---

## 七、结论与下一轮动作

- **结论**：Run1 的全部**待修缺陷均在 Round2 回归通过**——D6（隧道 statePath/属主校验）、D9（skills 字节一致）、D10（双触发）、D11（常驻会话降级+lastError）、D12（宿主 server 子命令）**逐项复证 PASS**；**GUI 域 4/4 实时 PASS**、**§3.3 双子例 PASS**、**D13 空载 3.7min 全绿**、**OB-1 未复现**、**残留清理完成**。**Round2 无 FAIL**。
- **是否收敛（已更正）**：本文原判「达到『2 轮内收敛』全部正向条件 → **建议关闭收敛流程、不进第 3 轮**」——**该判断建立在未知 D15 的前提下，现被推翻** → **进入第 3 轮**（范围见 `docs/test/reports/real-test-2026-09-23-run3.md`）。A2A 冷启动停滞为**既有 P1·已知**，随已知项维护；OB-2 为契约澄清项（P2）；**OB-3 定性更正为产品缺陷 D15（已修复并复证）**，其「独占窗」建议降为 **P3 流程项**。
- **送工程师（Alex）**：
  1. **D15（原 OB-3 → 升级 P1 产品缺陷，已修）**：HEALTH 门禁**不得**把 `state='unavailable'`／探针超时（**结论未知**）当终态下强断言；须用 `interpretHealth()` 三态（非 `healthy` 一律 `unknown`）+ 退避复探（已落地，QA 8/8 单测 + 端到端复证通过）；
  2. **P3 流程协同**（原 OB-3 建议，**降级**）：D14 等「VM 侧独占」任务执行期间，宜在共享通道宣告**独占时间窗**（或由主理人串行编排 QA 的 VM 侧检查），避免并发争用叠加探针超时；
  2. **契约澄清（OB-2）**：确认「A2A 委派是否应尊重 goal 中显式给出的输出路径」；若期望尊重，则为功能增强项（非阻塞）。
- **QA 自修（本轮已完成，记入方案）**：`.winvm-context.json` 校验点更正至**插件缓存根**（§2.1，Run1 曾误查仓库 cwd）；§3.3 拆「VM 服务重启 / daemon 层自愈」双子例并固化脚本。
- **单项修复**：单测全量 **525 例 → 523 PASS / 0 FAIL / 2 SKIP**（Run1 收尾修复 6 条陈旧断言；主理人已受理）。
- **是否需要第 2 轮**：**不需要**（Round2 已完成且全绿）。

---

## 八、Run2 收尾补记

### 8.1 逐项回归汇总（一眼表）
| 项 | 结果 | 证据文件 |
|---|---|---|
| §2.1 缓存根/仓库 md5 4/4 | PASS | 见 §一 快照 |
| §2.2.1 VM dist 3/3 | PASS | 快照 |
| §2.2.2 D10 双触发 | PASS | `qa/evidence/run2/task-trigger.out` |
| §2.3 隧道三一致 | PASS | 快照 |
| §3.1 health 全绿 | PASS | 快照 |
| §3.2 F2 懒刷新 | PASS | `qa/evidence/run2/f2.out` |
| §3.3① 黑洞 44.4s<60s | PASS | `qa/evidence/run2/selfheal-r2.out` |
| §3.3② daemon 自愈单实例 | PASS | `qa/evidence/run2/selfheal-r2.out` |
| D6 CASE1/2-a/2-b | PASS | `qa/evidence/run2/d6-r2.out` |
| D9 skills 字节一致（双树） | PASS | `qa/evidence/run2/skills-check.out` |
| D11 故障注入 | PASS | `qa/evidence/run2/d11-check.out` |
| D12 server 子命令 | PASS | §3.3①/`server status` 回显 |
| D13 空载 3.7min | PASS | `qa/evidence/run2/d13.out` |
| GUI 4/4 | PASS | `qa/evidence/run2/gui-check.out` |
| TC-A2A-03 严格 | PASS | `qa/evidence/run2/a2a03.out` |
| OB-1 复测 | 未复现 | `selfheal-r2.out` |
| 残留清理 | 完成 | 见 8.2 |

### 8.2 残留清理（完成）
- **本地**：Round2 临时目录 `qa/evidence/run2/d6a/` 已清除（`fs.rmdirSync`，规避 `rm` shim）。
- **VM**：`C:\Users\User\WinVMWorkspace\out\` 中 **Run1/OB-2 相关产物已不存在**——`report.txt` / `report.zip` / `screen_20260923*.png` 计数均 **0**（已在重投/前序清理中移除）。目录内剩余 `screen_20260917/18*.png` 等 **3 个历史 PNG 及若干 09-17/09-18 json** 为**更早期既有产物**，非本轮生成，**不属本轮清理范围，保持原样**。

### 8.3 环境时序说明（重要）
- 本轮（04:49–05:13Z）与**工程师 D14(b) 整条部署**（13:00–13:12 本地）**时间窗重叠**，致隧道 daemon pid 多次变化与一次瞬时 `provider=degraded`（OB-3）。所有 Round2 结论均以**争用平息后的稳定采样**为准（D11 实证于 05:09Z、报告快照于 05:13Z 采集）。
- **【更正】该瞬时 `provider=degraded` 窗口已由主理人独立取原始载荷复核，定性为产品缺陷 D15（非纯环境）**：并发只是**暴露**了 `setup.mjs` 把「结论未知」当终态的**强断言误报**（`state='unavailable'` → 断言非交互 → 打印补救块）；**D15 已修并端到端复证**（详见 §六「OB-3 → D15」行、`qa/evidence/run2/run3-full-deploy.log`、`tests/unit/setup-health-verdict.test.js` 8/8）。原「环境/流程·非产品缺陷」定性**作废**。

---

## 附：本轮原始输出留存（`qa/evidence/run2/`）

| 文件 | 内容 |
|---|---|
| `d6-r2.mjs` · `d6-r2.out` | D6 两条确定性注入回归（CASE1 旁路 / CASE2-a 陈旧 ownerMatch / CASE2-b ensure 不重启） |
| `task-trigger-check.mjs` · `task-trigger.out` | D10 live task XML 触发器 + VM `install-vm.mjs` 计数 |
| `skills-check.mjs` · `skills-check.out` | D9 仓库 skills vs VM 双树逐文件 md5 |
| `selfheal-r2.mjs` · `selfheal-r2.out` | §3.3 双子例（黑洞时长 / daemon 自愈单实例） |
| `d11-check.mjs` · `d11-check.out` | D11 常驻会话故障注入（ready→degraded+lastError→ready） |
| `d13.out` | D13 空载 3.7min 四采样 |
| `gui-check.mjs` · `gui-check.out` | GUI 4 条（session/capture/window.list/wait.condition） |
| `a2a03.out` | TC-A2A-03 委派原始输出（PNG 图像） |
| `f2.out` | F2 懒刷新 TTL 窗口回落 |
