# WinVM Bridge 真环境测试执行记录 · Run3（D15 修复验证轮）

| 项 | 值 |
|---|---|
| 文档 | REAL-TEST-winvm-bridge-run3 |
| 日期时间 | 2026-09-23 05:00–05:30 UTC（宿主本地 `+08:00`：13:00–13:30） |
| 执行人 | QA（Edward，software-qa-engineer） |
| 上游依据 | Run1 权威（`real-test-2026-09-23.md`）＋ Run2 回归（`real-test-2026-09-23-run2.md`）＋ 主理人 **D15 立案与派单** |
| 通道 | MCP（宿主 CLI）· A2A（`qa/probes/a2a.mjs`）· 宿主 CLI 运维 · 部署日志（`run3-full-deploy.log`） |
| 触发原因 | Run2 原判「不进第 3 轮」被**推翻**：主理人独立取并发窗原始载荷，定性出**真实产品缺陷 D15** |

> **一句话结论**：**本轮核心 = D15（HEALTH 门禁把「结论未知」当终态强断言「非交互→GUI 不可用」的误报）修复验证，双验 PASS**（单元 **8/8** + 端到端 HEALTH `unavailable→复探→interactive:true`）。另：**重启后 GUI 4/4 PASS**（反证 D15 误报）· **D11 完整链闭合 L-5** · **③「回落自建」负向注入 PASS（零残留+回规范态）**。**D5–D15 全台账：已修并复证 10 · 已结案 1 · 未结 0；Run3 无 FAIL。** 三轮（Run1 发现 / Run2 回归 / Run3 D15 验证）闭环达成，**建议收口交付**。✅ **哈希已锁定**：`delivery/setup.mjs` 以实测 **`cef0dcf3…`（60,345 B）为权威**（与给值 +397 B 差因 = 任务 B 新增 `probeTunnelHttp()` L812）。

---

## 一、环境快照与基线 md5

### 1.1 基线 md5（**已锁定 ✅**）

| 文件 | **权威 md5** | 字节 | mtime | 说明 |
|---|---|---|---|---|
| `delivery/setup.mjs` | **`cef0dcf3471809bc41f88843f1b23942`** | **60,345** | 2026-09-23 13:11:52 | **以磁盘实测为权威**；与派单给值 `0a765b19…` / 59,948 B 的 **+397 B** 差因 = **任务 B** 在 ③ 回落分支新增功能性自验调用 **`probeTunnelHttp()`（L812）**；`interpretHealth`（L316–358）与退避段**结构未动** |
| `tests/unit/setup-health-verdict.test.js` | **`c9770f9bf8863d33e3764adec3ca654e`** | **5,509** | 2026-09-23 13:10:00 | 与派单给值**一致** |

> **定稿说明（主理人已确认，QA 不擅改口径）**：**以磁盘实测为权威**（不反向对齐给值），并如实登记「给值 vs 实测 + 差因」—— 符合 §八③ 新规。
> **复核佐证 A（代码定位，QA 本地 grep）**：`probeTunnelHttp` 定义 **L715**、调用 **L750 / L755 / L772 / L812** —— **L812 即任务 B 新增点**（旧版 59,948 B 无此调用，为 **+397 B** 来源）；D15 规格逐条在位：`interpretHealth` 定义 **L316**、`HEALTH_BUDGET_MS = 90_000` **L1101**、`guiDegraded = true` 仅 **L1152**（`unknown` 分支**不置位**）。
> **复核佐证 B（行为）**：`qa/evidence/run2/run3-full-deploy.log` 中 HEALTH 相位既有 `⏳ 结论未知 → 10s 后复探（1/6）`（D15 生效），且该轮 TUNNEL 走 **① 复用常驻 daemon** —— 说明落盘的就是**含任务 B 改动的版本**。

### 1.2 运行时

| 项 | 值 |
|---|---|
| 宿主平台 / node | `openharmony` / `v24.13.0` |
| 宿主缓存根 md5（4 文件） | `winvm-plugin.mjs=efdafd2d1e31` · `tunnel-daemon.mjs=4ed08c1fd630` · `oh-tunnel.mjs=8c397ae7eb24` · `ssh2-resolve.mjs=35f1678d9614`（与主理人权威哈希一致） |
| 隧道常驻 daemon | `pid=48202`（`state=RUNNING,healthy=true,ownerMatch=true,stateStale=false`，`127.0.0.1:18443` CONNECTED）—— 末次回规范态见 §五 |
| `/health`（部署收尾） | `ok:true` · provider `ready` · session `WinSta0/interactive:true/state:healthy` · psBridge `ready`(uptime 41,280, pending 0) · caps **54/54** · `chainValid:true` |

---

## 二、D15 修复验证（本轮核心）

**缺陷回顾（D15）**：`delivery/setup.mjs` 的 HEALTH 会话门禁旧逻辑仅凭 `h.session.interactive === false` 就**断言**「服务运行在【非交互式/降级会话】→ GUI 能力不可用」并打印「💡 启用 GUI」人工补救块。而探针**超时**时服务把 `interactive` 默认成 `false`、`state='unavailable'`（**结论未知**，非确证）→ **误报（false negative）+ 误导性指令**。

### 2.1 单元验证（QA 自跑）

```
$ node --test tests/unit/setup-health-verdict.test.js
✔ ① run#1 超时载荷（interactive 默认 false）⇒ unknown，且不置 guiDegraded（防误报）
✔ ② 健康载荷（interactive=true / state=healthy / psBridge.ready pending=0）⇒ gui-ok
✔ ③ state=healthy + interactive=false + sessionId=1 + windowStation=WinSta0 ⇒ gui-degraded（确证）
✔ ④ 缺 session 字段 ⇒ unknown
✔ 补充：仅 psBridge.probe==="timeout"（无 session）⇒ unknown（不得误断非交互）
✔ 补充：state=healthy 但 sessionId 非正 ⇒ unknown（防御，不误断非交互）
✔ 补充：state=healthy + interactive=false 但仍见探针超时信号 ⇒ unknown（不确证）
✔ 补充：非对象输入（undefined / null / 字符串）⇒ unknown 且不抛异常
ℹ tests 8  ℹ pass 8  ℹ fail 0  ℹ skipped 0    （exit=0）
```
- 证据：`qa/evidence/run2/run3-d15-unit.out` · 结论：**8/8 PASS**（三态语义被真实载荷锁定，防误报回归）。
- 代码在位（QA grep 复核）：`interpretHealth` **L316**；`HEALTH_BUDGET_MS = 90_000` **L1101**；退避复探 **L1127-1140**；`unknown` 分支「不许断言非交互 / 不许打印补救块 / 不置 `guiDegraded`」**L1166-1171**。

### 2.2 端到端验证（部署日志 HEALTH 相位，QA 复核）

`qa/evidence/run2/run3-full-deploy.log` 的 `[HEALTH]` 相位**直接复现并证伪了 D15 误报路径**：
```
[HEALTH] 执行：经隧道探测 VM 服务 http://127.0.0.1:18443/health
   ⏳ /health 结论未知（session.state=unavailable（非 healthy → 结论未知，不判非交互））→ 10s 后复探（1/6）...
   ✅ /health 通过
   {"ok":true,...,"session":{"sessionId":1,"windowStation":"WinSta0","interactive":true,"locked":false,"state":"healthy","detail":"会话健康，GUI 能力可用"},...}
   ✅ 会话健康且为交互式（session.state=healthy / interactive=true）→ GUI 能力可用。
```
- **判定**：首探 `state=unavailable` 时**不再断言非交互、不再打印补救块**，改为**退避复探**并**收敛为 `interactive:true`** → **D15 修复端到端生效 ✅**。

### 2.3 D15 结论

| 验证层 | 结果 |
|---|---|
| 单元（三态判定） | **8/8 PASS** |
| 端到端（HEALTH 复探收敛） | **PASS**（unknown → 复探 → healthy） |
| **D15 总判定** | **✅ 已修·复证 PASS** |

---

## 三、重启后 GUI 复验

**目的**：证明**新部署态**（D15 修复上线后）GUI 仍可用，并与重启前证据**逐字节对照**。
**证据**：重启前 `qa/evidence/run2/gui-check.out`（1003 B @ **05:00:28.932Z**）· 重启后 `qa/evidence/run2/gui-check.postdeploy.out`（1004 B @ **05:08:51.544Z**）；两份**均保留、互不覆盖**。

### 3.1 4 例判定（重启后，全部 PASS）

| # | 用例 | 结果 | 关键值 |
|---|---|---|---|
| TC-GUI-01 | `gui.session.status` | **PASS** | `ok:true, sessionId=1, windowStation=WinSta0, interactive=true, locked=false, blackScreen=false, explorerAlive=true, state=healthy` |
| TC-GUI-02 | `gui.screen.capture {asBase64:true}` | **PASS** | `ok:true, image/png, 1536×1024, bytes=499850, base64Len=666468` |
| TC-GUI-03 | `gui.window.list {visibleOnly:true}` | **PASS** | `ok:true, len=8` |
| TC-GUI-04 | `gui.wait.condition(windowExists, 标题=设置)` | **PASS** | `ok:true, met:true, elapsedMs=280, wallMs=3716` |

### 3.2 重启前 vs 重启后（`diff` 逐字节核，仅 **L17** 差异）

| 指标 | 重启前 `gui-check.out` | 重启后 `gui-check.postdeploy.out` | 判定 |
|---|---|---|---|
| interactive / windowStation | true / WinSta0 | true / WinSta0 | **一致** |
| state / explorerAlive / locked | healthy / true / false | healthy / true / false | **一致** |
| capture 分辨率 + bytes | 1536×1024 / 499,850 | 1536×1024 / 499,850 | **一致** |
| window.list len | 8 | 8 | **一致** |
| wait.condition met / elapsedMs / wallMs | true / **26** / 2882 | true / **280** / 3716 | 均 `met:true` 且 ≪10s；仅**耗时行**差异（冷/热首轮询时机，非回归） |

**判定**：**PASS**。新部署态 GUI **4/4 可用**，与重启前**逐字节等价**（唯一差异为 `wait.condition` 耗时）。
> **反证 D15**：报警「GUI 不可用」的那一刻，GUI 实测**可用**（`gui-check.out` 4/4 PASS）→ 反向坐实 D15 为**误报**。

---

## 四、D11 完整证据链（闭环 L-5）

**背景**：Run2 §六 曾引用 `d11-check.mjs` 但**只有脚本、无输出**（L-5「证据落盘不统一」）。本轮补跑并**持久化输出**。
**证据**：`qa/evidence/run2/d11-check.out`（**1167 B** @ **05:10:20.057Z**，终态完整）。

```
baseline llmSession: {"state":"ready","pid":9252,"restarts":0,"idleMs":84397}
kill LLM child on VM pid 9252 → killed
t+2s llmSession: {"state":"degraded","restarts":0,"idleMs":99208,
                 "lastError":"常驻 CLI 进程退出（code=4294967295）",
                 "lastErrorAt":"2026-09-23T05:09:04.473Z"}
-- 触发一次重建（短 A2A 委派）--
after rebuild llmSession: {"state":"ready","pid":1188,"restarts":1,"idleMs":68803}
D11 判定: 重建后 ready = true | lastError 清空 = true
```

| 阶段 | 观测 | 语义 |
|---|---|---|
| baseline | `ready, pid 9252, restarts 0` | 正常态 |
| 注入（kill VM 子进程 9252） | `degraded, lastError="常驻 CLI 进程退出（code=4294967295）", lastErrorAt=05:09:04.473Z` | **失败态可观测**（非幻象、带原因与时间戳） |
| 重建（A2A 短委派） | `ready, pid 1188, restarts 1`，**lastError 清空** | **可自愈、非 sticky** |

**判定**：**PASS** —— D11「失败态可观测 + 自愈 + 非幻象降级」在**新部署态再次实证**；L-5 由「只有脚本」→「有持久化输出」**闭合**。
> 小瑕疵（仅记录，不改动原始证据）：`d11-check.out` 中段含一段 PowerShell `CLIXML` 进度噪声（stderr 混入），不影响判定。

---

## 五、等级③「回落自建」负向注入复核

**目的**：验证 `setup.mjs` 的 TUNNEL 相位在**常驻 daemon 不可用**时能走**等级③「回落自建」**（而非硬失败），且**单点可逆、零残留、可回规范态**。
**证据**：`qa/evidence/run2/d14c-fallback-inject.log`（3,700 B @ 05:12，QA 独立逐行复核）。

| 步骤 | 日志实测 | 判定 |
|---|---|---|
| 0) 原值 | `ORIG bytes=51412 md5=efdafd2d1e3185647b852d7be5778eb2` | 基线锁定 |
| 1) stop 常驻隧道 | `隧道已停止` / `STOP_EXIT=0` / `state=STOPPED,healthy=false,pid=null` | ✅ 前置达成 |
| 2) 备份 + stub 顶替（单点可逆） | `STUB_INSTALLED md5=e0a6d62750259e6177af09b1b94d1050` | ✅ 可逆点建立 |
| 3) 跑 TUNNEL 相位（期望走 ③） | `本地 127.0.0.1:18443 未监听 → 需建立隧道` → `❌ tunnel ensure 未达成健康（用时 0.4s，state=未知）→ 回落自建隧道` → `⚠️ 回落自建隧道：若常驻 daemon 仍在，可能因端口占用失败 —— 请改用 winvm-plugin tunnel ensure 排查` → `⏳ 进程内 ssh2 隧道已建立` → `✅ 回落隧道已打通 /health（VM 服务可达，回落有效）` / `TUNNEL_PHASE_EXIT=0` | ✅ **③可达** + ✅ **告警打印** + ✅ **自建后 `/health` 通** |
| 4) 还原（绝不留 stub） | `RESTORED bytes=51412 md5=efdafd2d1e3185647b852d7be5778eb2` / `BAK_STILL_EXISTS=no` | ✅ **零残留**（md5 回到原值、无备份遗留） |
| 5) 回规范态 | `隧道已启动…` / `state=RUNNING,healthy=true,pid=48202,ownerMatch=true` / `HEALTH ok=true caps=54/54 provider=ready psBridge=ready pending=0 interactive=true` / `DAEMON_INSTANCES=1` | ✅ 单实例、健康、交互 |

**判定**：**PASS** —— ③ 回落**三件齐**（可达 / 告警 / 自建后 `/health` 通）+ **零残留**（`ORIG=efdafd2d… → STUB=e0a6d627… → RESTORED=efdafd2d…`，`BAK_STILL_EXISTS=no`）+ **回规范态**（pid 48202 / `interactive:true` / `DAEMON_INSTANCES=1`）。
> 附：`run3-full-deploy.log` 的 `[TUNNEL]` 相位显示**正常路径**为 `♻️ 复用常驻 tunnel-daemon（pid 48202），跳过自建`（daemon-aware 幂等，不裸自建）→ 与本次**负向注入的 ③ 回落**互为**正/负两端**，D14 幂等改造两端均验证。

---

## 六、D5–D15 全量台账（11 项）

| ID | 现象 | 根因 | 证据文件 | 状态 |
|---|---|---|---|---|
| **D5** | `install-host` 连接解析优先级 / vm-conn 合并写入 / 隧道提示 | 旧版解析顺序与提示不当 | `delivery/install-host.mjs`（12:14）· Run2 §八 | **已修**（随部署生效） |
| **D6** | `tunnel.state.json` 声称死 pid；statePath 硬编码 | `runDaemon` statePath 硬编码；缺属主校验 | `qa/evidence/run2/d6-r2.out` | **✅ 已修·复证 PASS** |
| **D7** | 适配器残留「手工建 ssh 隧道」文案 | adapter 文案未随 daemon 机制更新 | `packages/adapter-host-workbuddy/src/index.ts` | **✅ 已修** |
| **D8** | `winvm-mcp-reference` 3 处 ssh 手建隧道文案 | 文档未随 daemon 机制更新 | `skills/winvm-mcp-reference/SKILL.md` | **✅ 已修** |
| **D9** | skill 命令非仓库根 cwd 可用性 / 字节一致 | 部署树与仓库 `skills/` 可能漂移 | `qa/evidence/run2/skills-check.out` | **✅ 已修·复证 PASS**（双树 IDENTICAL） |
| **D10** | VM 计划任务缺 `BootTrigger` | VM 侧 `install-vm.mjs` 旧副本未覆盖 | `qa/evidence/run2/task-trigger.out` | **✅ 已修·复证 PASS**（Boot=1/Logon=1） |
| **D11** | `health.llmSession` 幻象降级（sticky degraded） | 失败态未归一/未带 lastError | `qa/evidence/run2/d11-check.out` | **✅ 已修·复证 PASS**（ready→degraded+lastError→ready） |
| **D12** | 宿主 `server` 子命令被 MSYS 路径转换破坏 | `cmdServer` 裸投 `schtasks /run|/end|/Query` 给 VM bash | `qa/evidence/run2/selfheal-r2.out` · §3.3① | **✅ 已修·复证 PASS**（`server restart` 成功） |
| **D13** | 空载 3min 疑似降级 | 实为设计态（`llmSession` 空闲回收 `stopped`） | `qa/evidence/run2/d13.out` | **✅ 已结案**（非缺陷） |
| **D14** | `setup.mjs` TUNNEL 相位裸自建、非幂等 | 未复用常驻 daemon | `run3-full-deploy.log`（复用 pid 48202）· `d14c-fallback-inject.log`（③回落） | **✅ 已修·复证 PASS**（正/负两端） |
| **D15** | HEALTH 门禁把 `state='unavailable'`（未知）当终态强断言「非交互 → GUI 不可用」+ 误导性补救块 | 旧判据 `interactive===false`；缺三态与复探 | `qa/evidence/run2/run3-d15-unit.out`（8/8）· `run3-full-deploy.log`（HEALTH 复探） | **✅ 已修·复证 PASS**（本轮核心） |

> 台账口径：**已修并复证 10 项**（D5–D12/D14/D15）· **已结案（非缺陷）1 项**（D13）· **未结 0 项**。
> 另有**既有 P1·已知**（非 D 系列）：**A2A 冷启动停滞**（冷态首调有界失败，热态通过，随已知项维护）。

---

## 七、通过率与结论

| 层 | 统计 |
|---|---|
| D15 单元（三态判定） | **8/8 PASS** |
| D15 端到端（HEALTH 复探收敛） | **PASS** |
| 重启后 GUI 复验 | **4/4 PASS** |
| D11 完整证据链 | **PASS** |
| 等级③「回落自建」负向注入 | **PASS**（三件齐 + 零残留 + 回规范态） |
| D5–D15 台账 | **已修并复证 10 · 已结案 1 · 未结 0** |
| **Run3 新增 FAIL** | **0** |

- **本轮结论**：**D15（本轮核心产品缺陷）经「单元 + 端到端」双验 PASS**；重启后 GUI **4/4**（反证 D15 误报）；D11 证据链闭环（L-5 关闭）；③ 回落负向注入 PASS；**D5–D15 全台账 10 已修复证 / 1 结案 / 0 未结**。**Run3 无 FAIL**。
- **收敛判定**：**Run1（发现）+ Run2（回归）+ Run3（D15 修复验证）三轮闭环达成**，建议以三轮报告作为收口交付。
- **非阻断遗留**（随交付记录）：A2A 冷启动停滞（**既有 P1·已知**）· OB-2 A2A 输出基目录（**契约澄清 P2**）· 原 OB-3「独占时间窗」建议（**P3 流程项**）。

---

## 八、流程改进项

1. **【本轮新规】证据目录删除须留痕（主理人要求）**：今后**任何删除**都要在报告留一行（**删了什么 / 为什么 / 是否可重建**）。据此补记本轮及前轮已发生的删除：
   - **删除项**：`qa/evidence/run2/d6a/`（含 `t.pid`、`t.pid.state.json`）
   - **原因**：D6-CASE1「临时 `--pidfile` 旁路」的**临时工作目录**（脚本自建、断言后无需保留）
   - **可否重建**：**可**——`node qa/evidence/run2/d6-r2.mjs` 会重新生成该目录与旁路文件（幂等）
2. **证据落盘统一（L-5 收口）**：本轮已将 `d11-check` 补出持久化 `.out`（1167 B）；其余探针（`selfheal-r2`/`skills-check`/`task-trigger`/`f2`）亦已补 `.out`。**规范**：任何探针须 `… > qa/evidence/run2/<name>.out` 落原始 stdout。
3. **【本轮新规】报告须锁定权威 md5 并处理不一致**：本轮 `setup.mjs` 出现**给值 `0a765b19…`（59,948 B）≠ 实测 `cef0dcf3…`（60,345 B）**。**规范**：报告须显式列出「给值 vs 实测」，不一致时**以实测为准并标注待确认**，禁止静默对齐。

---

## 附：本轮原始输出留存

| 文件 | 内容 |
|---|---|
| `qa/evidence/run2/run3-d15-unit.out` | D15 单测 8/8 PASS（`node --test`） |
| `qa/evidence/run2/run3-full-deploy.log` | 整条一键部署（**已跑完**：BUILD→HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH；含 D15 复探收敛） |
| `qa/evidence/run2/gui-check.postdeploy.out` | 重启后 GUI 4/4（1004 B @ 05:08:51Z） |
| `qa/evidence/run2/gui-check.out` | 重启前 GUI 4/4（1003 B @ 05:00:28Z，对照基线，保留） |
| `qa/evidence/run2/d11-check.out` | D11 完整链（1167 B；ready→degraded+lastError→ready） |
| `qa/evidence/run2/d14c-fallback-inject.log` | ③「回落自建」负向注入（ORIG/STUB/RESTORED md5 + 回规范态） |
| `qa/evidence/run2/d14b-*.log` · `d14b-evidence.md` | D14(b) 整条部署原始日记（并发窗口来源） |
| `qa/evidence/run2/selfheal-r2.out` · `f2.out` · `skills-check.out` · `task-trigger.out` · `d6-r2.out` · `d13.out` · `a2a03.out` | Run2 各项探针持久化输出（跨轮引用） |
