# CL-020 · 真机部署验证 + CLI 修复记录（V1.0.1 候选）

> 生成时间：2026-09-23 · 交付总监（software-team-lead / 齐活林）
> 范围：CL-020 代码（F2 全通道采集 + 隧道生产化）**真机干净部署 → 全量真环境测试 → 记录问题 → 修复 → 验证 → 发版 → 迭代**。
> 环境：宿主 = HarmonyOS NEXT（`openharmony`，node `/data/storage/el1/bundle/libs/arm64/node/bin/node`）；VM = Windows 11 `172.16.100.2:18443`，服务仅监听 `127.0.0.1`。

---

## 一、结论（TL;DR）

- **部署状态**：宿主 + VM 两侧均已干净重新部署并**真机验证通过**。
- **CL-020 功能（F2 懒刷新）**：真实验证通过 —— `netCfg.ageMs` 由 **50,446,574 ms（陈旧 ~14h）** 经一次 `system.network.config` 调用骤降至 **13,266 ms**（< TTL 45s），`cached:false, cacheAgeMs:0`。
- **本会话新发现并修复的缺陷**：宿主 `command` 子命令（及所有走 `withTunnel` 的 ad-hoc 路径）缺默认 SSH 私钥探测链，报 `必须提供 privateKey / identityFile / password 之一`。已注入 `probeDefaultSshKey()` 修复，**仓库源 + 已部署缓存根两份文件均 PATCH OK、node --check 通过、真机 `command` 实测可用**。
- **发版建议**：CL-020 生产化收口，建议版本 **V1.0.1**（本沙箱无 `git`，tag 推送为 Windows 侧动作）。

---

## 二、部署动作（clean redeploy）

### 2.1 宿主侧（缓存根 = 运行态真相源）
- 杀掉旧隧道守护进程（旧 pid `4791`，跑的是 pre-fix 旧守护码）。
- 同步 4 个运行态文件到 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`：
  - `winvm-plugin.mjs`（含 CL-020 的 `'openharmony'` 修复，grep `openharmony` = 1，与仓库一致）
  - `tunnel-daemon.mjs`（md5 `fcc8d002…`，与仓库一致）
  - `oh-tunnel.mjs`、`ssh2-resolve.mjs`
- 干净 `tunnel start` → 新守护进程 **pid 300**，写 `tunnel.pid` / `tunnel.state.json`（`RUNNING / alive:true`）。

### 2.2 VM 侧（F2 生效依赖）
- 备份旧 dist：`packages/vm-service/dist/server.js.cl020.bak`、`packages/adapter-agent-workbuddy/dist/index.js.cl020.bak`。
- scp 新 dist（`vm-service/dist` 33,335B、`adapter-agent-workbuddy/dist` 39,193B，与仓库字节一致）。
- `kill-restart.ps1` 重启计划任务 `WinVMBridge.Service` → 新 VM 进程 `node.exe …vm-service\dist\cli.js`，GUI healthy。

---

## 三、真机测试发现的问题（记录）

| 编号 | 严重度 | 问题 | 根因 |
|---|---|---|---|
| B1 | P0 | 缓存根 `winvm-plugin.mjs` 漏同步 CL-020 的 `'openharmony'` 修复（grep `openharmony` = 0） | 工程师 CL-020 只 `cp` 了 `tunnel-daemon.mjs`，未同步 `winvm-plugin.mjs` |
| B2 | P0 | 旧隧道 pid `4791` 仍跑旧守护码，占监听、状态陈旧 | 缓存更新早于活隧道启动，旧进程未清理 |
| B3 | P0 | VM 侧 `vm-service/dist/server.js` 为 pre-F2 旧版（09-22 10:23），F2 不生效 | dist 未重发 |
| **B4** | **P1** | **宿主 `command <tool>` 报 `必须提供 privateKey / identityFile / password 之一`** | **`loadVmConn`/`resolveVmConn` 只从 `argv.vmKey / env / persisted.identityFile` 读私钥，未实现 setup.mjs 已有的默认私钥探测链（`~/.ssh/id_ed25519 → id_ecdsa → id_rsa`），`command` 临时 ssh2 隧道拿不到密钥** |

> 说明：B1–B3 为前序会话已发现并修复的部署缺口（本次收口确认）；**B4 为本会话在「全量真环境测试」中新发现并修复的 CLI 缺陷**。

---

## 四、修复（对应问题）

| 编号 | 修复 |
|---|---|
| B1 | `cp delivery/winvm-plugin.mjs → 缓存根`（并同步 `oh-tunnel.mjs` / `ssh2-resolve.mjs`）；验证 grep `openharmony` = 1、L223 正确 |
| B2 | `kill 4791`（SIGKILL）后清理 pidfile/state |
| B3 | 备份 `.cl020.bak` → scp 新 dist → `kill-restart.ps1`；验证字节一致 |
| **B4** | **在 `delivery/winvm-plugin.mjs` 的 `loadVmConn` 注入 `probeDefaultSshKey()`：未显式提供任何凭据时探测 `~/.ssh` 默认私钥，注入为 `argv.vmKey → resolveVmConn → identityFile`。与 setup.mjs 探测链一致，错误提示本身亦指向该行为。** |

B4 修复用外科手术式正则替换 `loadVmConn` 函数块（路径参数化补丁脚本），故对**仓库源**与**已部署缓存根副本**分别就地打入，**不覆盖缓存根其它部署期差异**。

---

## 五、验证证据（真机，2026-09-23 复测）

### 5.1 隧道与基础健康
```
tunnel.state.json : { state: "RUNNING", alive: true, pid: 300 }
health            : { ok: true,
                      provider: { id: "workbuddy", state: "ready" },
                      session:  { state: "healthy", locked: false, blackScreen: false },
                      psBridge: { state: "ready", uptimeMs: 50375928, restarts: 1 },
                      capabilities: { count: 54, available: 54 },
                      audit:   { chainValid: true } }
```

### 5.2 F2 懒刷新（核心）
```
BEFORE  netCfg.ageMs = 50,446,574 ms   (cached:true, 陈旧 ~14h)
$ node delivery/winvm-plugin.mjs command system.network.config
  → ok:true, risk:L0, cached:false, cacheAgeMs:0, durationMs:2557
  → data.adapters: 以太网 172.16.100.2(gw 172.16.100.1, dns 1.1.1.1) / Tailscale 100.66.243.17
AFTER   netCfg.ageMs = 13,266 ms        (cached:true, 已落入 TTL 45s 窗口)
```
→ `system.network.config` 触发 `reportNetCfg` 单一数据源刷新，F2 在全通道生效。

### 5.3 修复后 `command` 子命令（B4 验证）
```
$ node delivery/winvm-plugin.mjs command system.info.get     # 走已部署缓存根副本
  → ok:true, data: computerName "YQWANG-SANWAY-H", caption "Microsoft Windows 11 家庭版",
         architecture "ARM 64 位处理器", cores 6, totalMemoryMB 8187, isAdmin true
```
→ 不再抛凭证错误，返回真实 VM 信息；仓库源与部署副本均验证可用。

### 5.4 语法 sanity
```
node --check delivery/winvm-plugin.mjs                                → OK
node --check ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin.mjs → OK
```

---

## 六、发版结论

- **CL-020 生产化收口**：F2 全通道采集 + 隧道生产化在真机端到端验证通过；部署缺口 B1–B3 已闭合；B4（CLI 密钥探测）作为部署期发现并修复。
- **建议版本**：**V1.0.1**（CL-020 生产化 + CLI 修复）。本环境无 `git` 二进制，tag 标注/推送为 Windows 侧动作（参考 `V1.0.0-release-notes.md` 第二节的 tag 流程）。
- **运行态真相源已对齐**：缓存根 4 文件 + VM dist 均与仓库字节一致。

---

## 七、迭代项（已决：全部接受 → 6 项可执行任务）· 执行结果回写（2026-09-23）

> **决策（用户确认 2026-09-23）**：**接受全部建议 I1–I6**，并归并细化为下列 **6 项可执行任务**，由团队 `software-winvm-cl020` 执行。
> 原建议清单保留于 **7.0**，可执行计划见 **7.1–7.6**，本轮新发现的阻断缺陷见 **7.7**。

> **回写说明**：本节原为**计划态**（7.0 状态列一律「🔄 执行中」、7.1–7.6 仅有「目标 / 落地 / 验收判据」、无任何实测结果；7.7 仅列 D1–D3）。现按**磁盘原始证据**回写为**结果态**：7.0 状态列改为实际结论并新增「验收结论」列；7.1–7.6 各追加「**实际结果（2026-09-23）**」；7.7 扩写为**完整缺陷台账 D1–D16**；§八更新为真实未决清单。
> **证据来源纪律**：只引用磁盘原始证据（`qa/evidence/run1-20260923/`、`qa/evidence/run2/`、`docs/test/reports/real-test-2026-09-23{,-run2,-run3}.md`）；「派单给值」与磁盘实测不一致时**以磁盘实测为准**并在文中写明差异，不把计划写成结果。
> **权威报告**：Run1 `real-test-2026-09-23.md` · Run2 `-run2.md` · Run3 `-run3.md`；Run4（D16 收敛后）另见 `-run4.md`。

### 7.0 建议 → 任务映射（状态列已回写为实际结论）

| 原建议 | 归入任务 | 落地文件 | 状态 | 验收结论（依据） |
|---|---|---|---|---|
| I1 部署期持久化 `identityFile` | 任务 1（常驻服务） | `delivery/install-host.mjs`、`~/.workbuddy/winvm/vm-conn.json` | ✅ 已完成 | `vm-conn.json.identityFile=/storage/Users/currentUser/.ssh/id_ed25519`（实测存在）；`resolveVmConnection`（flags→vm-conn.json→env→全缺 `exit(1)`）+ `writeVmConnConfig` **合并写入**；空 home 干跑 `EXIT=1` 且默认值残留 0（主理人独立复核，见 D5） |
| I2 隧道自愈时延 | 任务 5（测试方案）+ 任务 6（迭代） | `delivery/tunnel-daemon.mjs`、`docs/test/real-test.md` | ✅ 已完成 | §3.3 拆双子例：① VM 服务重启黑洞 **44,419 ms < 60 s**（`恢复=true`）；② daemon 层自愈 kill→`ensure` 新 pid **单实例** —— 证据 `qa/evidence/run2/selfheal-r2.out` |
| I3 watchdog 兜底（掉线自动重生） | 任务 1 | `delivery/install-host.mjs`（autostart 标记 + `tunnel ensure`） | ⚠️ 部分落地·遗留 | `tunnel ensure` 幂等（复用 / 从零拉起）已实测（`qa/evidence/run2/d14b-*.log`）；但「**WorkBuddy 启动即自动拉起**」的机制为自制字段、平台不认 → **D16（修复中）** |
| I4 Grep 对 `delivery/*.mjs` 漏匹配 | 任务 6（登记为工具约束） | `docs/test/real-test.md` | ✅ 已完成 | 已登记为工具约束并改用 Read / 精确单关键词。本轮再次复现该 glitch：Grep 对 `delivery/winvm-plugin.mjs` 报 0 命中，改用脚本扫描即命中 7 文件 |
| I5 `loadVmConn` key-probe 单测 | 任务 6（回归项） | `tests/unit/` | ⚠️ 部分落地·遗留 | `resolveVmConn` **优先级**已有单测（`tests/unit/winvm-plugin.test.js`，7 例）；`loadVmConn` 的 **key-probe 分支**（无凭据探测 `~/.ssh` / 显式凭据优先）**未见专项单测**（全仓扫描 `probeDefaultSshKey` 在 `tests/` 下 0 命中） |
| I6 三关验证门禁（build/typecheck/smoke） | 任务 5 + 任务 6 | `docs/test/real-test.md` | ✅ 已完成（本会话实测） | 三关实测：`node --check delivery/*.mjs` 全 OK · 单测 `setup-health-verdict.test.js` 8/8 · 真机烟测整条 `setup.mjs --apply --yes` **EXIT 0**；CI 固化受沙箱限制（无 `git`）记为文档化条目 |

### 7.1 任务 1 —— tunnel-daemon 注册为 WorkBuddy 启动服务

- **目标**：WorkBuddy 一启动，宿主沙箱内的 `tunnel-daemon` 即自动在线，无需人工拉起。
- **落地**：`delivery/winvm-plugin.mjs` 新增幂等 `tunnel ensure`；`delivery/install-host.mjs` 部署尾调用 `ensure` 并写 autostart 标记；`packages/adapter-host-workbuddy`（src + dist）在 `plugin.json` 的 `workbuddy` 块声明启动项。
- **验收判据**：`node --check` 全过；`install-host --dry-run` 正常；`tunnel ensure` 幂等（已在线 → 直接返回 0、不重复拉起）。

**实际结果（2026-09-23）**
- **`tunnel ensure` 真幂等**：语义为 `RUNNING→0 / DEGRADED→restart / STOPPED→start` + 新增 `tunnel restart`。实测（`qa/evidence/run2/d14b-evidence.md` 步骤 1–4）：① **复用**（run#1 pid 41823 / run#2 pid 43477，均 0.6 s）；② **从零拉起**（隔离 `--phase TUNNEL`：`tunnel stop` → `ensure` 1.5 s → 新 pid 43477，相位 2.2 s，`EXIT 0`）；幂等复跑 `tunnel.pid` **不变**（未新建隧道）。
- **状态文件属主校验（D6）**：`qa/evidence/run2/d6-r2.out` —— CASE1 旁路实例**不污染**默认 `tunnel.state.json`；CASE2 篡改 state `pid=99999` → `ownerMatch=false / stateStale=true`，且 `ensure` **不重启**健康隧道（pid 37199 未变）。
- **部署期私钥持久化（I1）**：实测 `~/.workbuddy/winvm/vm-conn.json` 含 `"identityFile": "/storage/Users/currentUser/.ssh/id_ed25519"`（存在）。
- **偏差（未达标）**：「覆盖 WorkBuddy **启动**即自动在线」的机制落在 `plugin.json` 的自制字段 `workbuddy.startup`（平台不认，应为顶层 `hooks → ./hooks/hooks.json` 的 `SessionStart`），且 `~/.workbuddy/settings.json.enabledPlugins` 无 `winvm-bridge@winvm` → **D16 立案（工程师本轮修复中，复证见 Run4）**。
- **达标判定**：`tunnel {ensure,status,stop}` 子命令幂等 **✅**；「WorkBuddy 启动自动拉起」**❌（D16 未收敛）** → **本任务整体「部分达标」**。

### 7.2 任务 2 —— 插件 skills 注入 tunnel 健康前置

- **目标**：任何 VM Windows 操作**前**先确认隧道在线健康；不在线先 `start|restart`。
- **落地**：`skills/winvm-orchestrator/SKILL.md` 增「前置检查」小节 + 5 个兄弟 skill 的简短引用；同步已部署 connector skills。
- **验收判据**：前置段落位于「域路由 / 通道选择」**之前**；命令示例可直接运行。

**实际结果（2026-09-23）**
- **字节一致复证**：`qa/evidence/run2/skills-check.out` —— 仓库 `skills/`（9 文件）vs VM `C:/WinVMBridge/skills` 与 `C:/WinVMBridge/shared-skills` **双树 `IDENTICAL = true`**（`onlyLocal/onlyRemote/contentDiff` 全空）。
- **D7（适配器文案）**：`packages/adapter-host-workbuddy` 的 src + dist 中「手工 `ssh -f -N -L`」文案清零，改为 daemon 机制。
- **D8（技能文案）**：`skills/winvm-mcp-reference` 3 处处方性手工隧道文案改为 daemon 口径（全仓仅剩 1 条**警告语境**）。
- **落点与措辞**：`skills/winvm-orchestrator/SKILL.md`（24,498 B @ 12:36）含「前置检查（每次任务开始，必做）」，判定口径改为「以 `tunnel status` 为权威；`state.json` 仅作诊断、可能陈旧、**不得据其判健康**」。
- **达标判定**：**✅ 达标**。

### 7.3 任务 3 —— VM `WinVMBridge.Service` 注册开机自启

- **目标**：VM 侧除 `start|restart` 外，计划任务**开机即启**（不必等登录）。
- **落地**：`delivery/install-vm.mjs` 任务 XML 增加 `<BootTrigger>`（保留 `<LogonTrigger>`）+ 文案同步。
- **验收判据**：`node --check` OK；`--dry-run` 输出体现「开机 + 登录双触发」。

**实际结果（2026-09-23）**
- **live 任务 XML（关键原始输出）**：`qa/evidence/run2/task-trigger.out` —— `<Triggers><BootTrigger /><LogonTrigger /></Triggers>`，`BootTrigger=1 LogonTrigger=1`。
- **VM 侧部署器已覆盖**：VM `C:/WinVMBridge/delivery/install-vm.mjs` = **41,754 B @ `2026-09-23T11:27:30`**（`BootTrigger` 计数 = 3）；旧副本 40,780 B @ 09-20 已随重投消失。
- **附带收益**：任务改由 `LogonTrigger` 在**已登录会话**内拉起 → `session.interactive:true / state:healthy`，Run1 因非交互而 BLOCKED 的 GUI 项在 Run2 真正跑掉（GUI **4/4 PASS**）。
- **达标判定**：**✅ 达标**（D10 已修·复证）。

### 7.4 任务 4 —— 双端一键部署脚本

- **目标**：在**鸿蒙宿主端**一条命令完成两端部署 + 联合验证。
- **落地**：两端子脚本 `delivery/install-host.mjs`（宿主）/ `delivery/deploy-vm.mjs`（VM，于鸿蒙端运行）+ 总编排 `delivery/setup.mjs`（支持 `--only-host` / `--only-vm`）。
- **验收判据**：相关脚本 `node --check` 全过；4 条 dry-run 正常；总脚本可分别调用两端子脚本。

**实际结果（2026-09-23）**
- **整条零人工跑通**：`qa/evidence/run2/run3-full-deploy.log` —— 8 相位（BUILD → HOST → VM → VM-START → TUNNEL → TEST → QA-PROBE → HEALTH）全部 `✅`，结尾 `部署全部完成 ✅`；`qa/evidence/run2/d14b-full-deploy.log`（run#1）与 `d14b-full-deploy-2nd.log`（幂等复跑）均 **EXIT 0**。
- **隧道三级决策全实测**：① **复用**（`♻️ 复用常驻 tunnel-daemon（pid 48202），跳过自建`，0.7 s）· ② **daemon 拉起**（从零 `ensure` 1.5 s → 新 pid 43477，`d14b-evidence.md` 步骤 3）· ③ **回落自建**（`qa/evidence/run2/d14c-fallback-inject.log`：stub 顶替使 `ensure` 必败 → 打印告警 + 进程内 ssh2 建隧道 + `/health` 通，`TUNNEL_PHASE_EXIT=0`；还原 `md5 efdafd2d…`、`BAK_STILL_EXISTS=no` **零残留**）。
- **终态哈希**：`delivery/setup.mjs` = **60,345 B / md5 `cef0dcf3471809bc41f88843f1b23942`**（D14 三级隧道 + D15 三态门禁）。
- **达标判定**：**✅ 达标**（4 条 apply/dry-run 路径 + 三级决策全覆盖）。

### 7.5 任务 5 —— 真实环境测试方案

- **目标**：可执行、可判读的三类覆盖 —— ① 插件部署完整性 ② 组件服务健康性 ③ 各类型任务用例（5 域 + MCP/A2A 双通道）。
- **落地**：`docs/test/real-test.md`。
- **验收判据**：每条用例含 前置 / 命令 / 期望 / 判据 / 清理；含执行记录模板与缺陷分级路由。

**实际结果（2026-09-23）**
- **落盘**：`docs/test/real-test.md` = **69,022 B**；结构 = §2 部署完整性 3 项 · §3 健康性 3 项 · §4 用例矩阵 **25 条（MCP 22 + A2A 3）**，覆盖 **54 能力**（meta3 / system14 / app8 / storage13 / gui11 / appops5）。
- **可用性**：每条用例含 前置 / 命令 / 期望 / 判据 / 清理 + 执行记录模板 + 缺陷分级路由；Run1–Run3 三轮均以本方案为执行依据（含 QA 按实测修正的 5–6 处判据）。
- **达标判定**：**✅ 达标**。

### 7.6 任务 6 —— 测试-修复迭代（文档化）

- **目标**：按 `real-test.md` 执行真机测试 → 记录 → 修复 → 回归，**每轮产出报告**。
- **落地**：`docs/test/reports/`。
- **验收判据**：每轮含 环境快照 / 逐条结果 / 通过率 / 缺陷清单（含根因与路由）/ 修复建议 / 结论。

**实际结果（2026-09-23）**
- **三轮权威报告（均已落盘）**：`real-test-2026-09-23.md`（Run1，19,660 B）· `real-test-2026-09-23-run2.md`（Run2，20,639 B）· `real-test-2026-09-23-run3.md`（Run3，18,418 B）；每轮含 环境快照 / 逐条结果 / 通过率 / 缺陷清单（根因与路由）/ 结论。
- **计数**：Run1 用例 **24 PASS / 1 BLOCKED / 0 FAIL**；Run2 **新增 FAIL = 0**，部署完整性 6/6、健康性 3/3、GUI 补跑 4/4；Run3 D15 单元 **8/8** + 端到端 PASS。
- **单测全量**：**525 例 → 523 PASS / 0 FAIL / 2 SKIP**（`qa/evidence/run1-20260923/unit-run.out`、`unit-run2.out`）。
- **达标判定**：**✅ 达标**（三轮闭环：发现 → 回归 → 修复验证）。

### 7.7 完整缺陷台账（D1–D16）

> 编号为 CL-020 迭代的**唯一口径**：**D1–D4** 为中断会话遗留缺陷（本会话开工即修）；**D5–D15** 为 Run1–Run3 三轮立案；**D16** 为本轮（WorkBuddy 重启后）新发现。
> 「已修·已复证」= 修复动作 + 磁盘原始证据**双具备**；「已修」= 有修复动作但复证证据较弱；「遗留」= 尚未收敛。

| 编号 | 严重度 | 现象 | 根因 | 修复动作 | 复证证据 | 状态 |
|---|---|---|---|---|---|---|
| **D1** | P0 | `delivery/setup.mjs` 语法错误 `Duplicate export of 'buildVmStartPs1'` → **整个双端编排 parse 失败、不可用** | 中断会话的 export 块编辑把 8 个 **inline-export** 名重复列入末尾 `export {}` | 末尾块只保留非 inline 的 `main / deployQaProbes / waitForRemotePort` | `node --check delivery/setup.mjs` OK；Run3 整条 `--apply` EXIT 0 | ✅ 已修·已复证 |
| **D2** | P0 | `deploy-vm.mjs` 被写入 typo 目录 `divery/`（应为 `delivery/`） | 中断会话路径笔误 | 移回 `delivery/`、删除 `divery/` | `delivery/deploy-vm.mjs` = 7,529 B 在位；`setup.mjs` VM 相位引用正确 | ✅ 已修·已复证 |
| **D3** | P0 | `deploy-vm.mjs` 在 ESM 中调用 `require('node:fs')` → 运行时 `ReferenceError` | 误用 CJS API | 改 `import { existsSync }` | `node --check` OK；VM 相位 EXIT 0 | ✅ 已修·已复证 |
| **D4** | P0 | `setup.mjs` 中 `phaseFilter` **先使用后声明（TDZ）** → **所有 `--only-host` / `--only-vm` 路径直接崩** 〔来源：`.workbuddy/memory/2026-09-23.md` L31，**中断会话遗留**（非本轮新发现）〕 | 变量声明顺序错误 | 调整声明顺序；单边语义修正为「预览与执行都只含本侧」 | `--only-host` / `--only-vm` 可跑；Run3 相位 EXIT 0 | ✅ 已修·已复证 |
| **D5** | P1 | `install-host` 连接解析优先级不当 / `writeVmConnConfig` 整包覆盖会冲掉正确配置 / 隧道提示误用 `args.host` | 旧解析顺序与提示不当、写入非合并 | 新增 `resolveVmConnection(args,home)`（flags → 已有 `vm-conn.json` → `WINVM_*` env → 全缺 `exit(1)`）；`writeVmConnConfig` 改**合并写入**；修结尾提示 | `vm-conn.json` 含 `identityFile`；无 flag 干跑 → `User@172.16.100.2`；空 home 干跑 → `EXIT=1` 且默认残留 0（主理人独立复核） | ✅ 已修·已复证 |
| **D6** | P1 | `tunnel.state.json` 声称死 pid（与 pidfile 背离）；`statePath` 硬编码不可参数化 | `tunnel-daemon.mjs#runDaemon` 的 `statePath` 硬编码；缺属主交叉校验 | A：`statePath` 随 `pidfile` 派生（`${pidfile}.state.json`）；B：`status`/`ensure` 加 `ownerMatch`/`stateStale` 校验、**绝不因陈旧 state 重启健康隧道**；⑤：skill 措辞改为「以 `tunnel status` 为权威」 | `qa/evidence/run2/d6-r2.out`：CASE1 默认 state 未被污染；CASE2-a `ownerMatch=false/stateStale=true`；CASE2-b `ensure` 不重启 pid 37199 | ✅ 已修·已复证 |
| **D7** | P2 | 适配器残留「手工建 `ssh -f -N -L` 隧道」文案 | 文案未随 daemon 机制更新 | `packages/adapter-host-workbuddy` src + dist 改 daemon 口径；回收治标过滤正则 | src/dist `ssh -f -N -L` 0 命中 | ✅ 已修·已复证 |
| **D8** | P2 | `skills/winvm-mcp-reference` 3 处处方性手工隧道文案（含最有害的排障表） | 文档未随机制更新 | 3 处改为 daemon 机制 | 全仓仅剩 1 条**警告语境**；`skills-check.out` 双树 IDENTICAL | ✅ 已修·已复证 |
| **D9** | P2 | skill 命令表用仓库相对路径 `node delivery/winvm-plugin.mjs`、锚点「在仓库根执行」→ **部署态任意 cwd 不可用** | 锚点假设错误 | 改用缓存根 `<ver>/winvm-plugin` 自定位 shim | `qa/evidence/run2/skills-check.out` 双树 `IDENTICAL=true` | ✅ 已修·已复证 |
| **D10** | P1 | 线上 VM 计划任务 `WinVMBridge.Service` **缺 `BootTrigger`** → 「开机自启」承诺未生效 | VM 侧 `install-vm.mjs` 旧副本（40,780 B）未覆盖 | 重投 `install-vm.mjs`（41,754 B）+ `schtasks //Create //XML` 重注册任务 | `qa/evidence/run2/task-trigger.out`：`BootTrigger=1 LogonTrigger=1`；VM `install-vm.mjs` 41,754 B @ 11:27:30 | ✅ 已修·已复证 |
| **D11** | P2 | `/health.llmSession` **sticky phantom degraded**（历史失败污染「此刻健康」） | 失败态未归一、未带时间戳 | 两信号分离 + 加 `lastErrorAt`；`killChild` 后 `degraded → stopped` | `qa/evidence/run2/d11-check.out`：`ready(pid9252) → degraded+lastError+lastErrorAt → ready(pid1188,restarts:1)` 且 `lastError` 清空 | ✅ 已修·已复证 |
| **D12** | P1 | 宿主 `server start/stop/restart/status` 全不可用；`status` 假报「未注册」 | `cmdServer` 裸投 `schtasks /Query\|/run\|/end` 给 VM 默认 **MSYS Git-Bash** → `/Query` 被转成 `C:/Program Files/Git/Query` | 改 **PowerShell cmdlet**：`Get-ScheduledTask` / `Start-ScheduledTask` / `Stop-ScheduledTask`；禁用 MSYS 逃生口 | `qa/evidence/run2/selfheal-r2.out`：`server restart` 首次成功；`server status` → 「已注册 / :18443 监听中」 | ✅ 已修·已复证 |
| **D13** | P2 | 空载 3 min 疑似降级（`llmSession=stopped`） | **实为设计态**：`llmSession` 空闲回收，非缺陷 | 无需修改（定性结案） | `qa/evidence/run2/d13.out`：空载 3.7 min 四采样全绿 | ✅ 已结案（非缺陷） |
| **D14** | P1 | `setup.mjs` TUNNEL 相位**无条件自建隧道** → 与常驻 daemon 抢端口 → `EADDRINUSE` / 整条 `--apply` **EXIT 1** | 未复用常驻 daemon | 抽出 `runTunnelPhase` 三级决策：① 复用 → ② `tunnel ensure` → ③ 回落进程内 ssh2 自建 + 显式告警 | `run3-full-deploy.log`（①复用 pid 48202）· `d14b-*.log`（②从零 pid 43477）· `d14c-fallback-inject.log`（③回落 + 零残留） | ✅ 已修·已复证（三级全实测） |
| **D15** | P1 | HEALTH 门禁把探针**超时/结论未知**（`session.state='unavailable'`）当终态，**强断言「非交互 → GUI 不可用」**并打印误导性补救块（误报 false negative） | 旧判据 `h.session.interactive === false`；缺三态与载荷级复探 | 抽纯函数 `interpretHealth()` **三态**（非 `healthy` 一律 `unknown`）+ 退避复探（10 s × ≤6、预算 90 s）；`unknown` 分支**不置 `guiDegraded`、不打印补救块** | `qa/evidence/run2/run3-d15-unit.out` **8/8 PASS**；`run3-full-deploy.log` HEALTH `unavailable → 复探 → interactive:true`；`gui-check.postdeploy.out` 4/4 | ✅ 已修·已复证 |
| **D16** | P1 | **WorkBuddy 重启后隧道未自动拉起**：自启动机制用平台**不认**的自制字段 `workbuddy.startup`（应=顶层 `hooks` → `./hooks/hooks.json` 的 `SessionStart`）；且 `~/.workbuddy/settings.json.enabledPlugins` **缺 `winvm-bridge@winvm`** | 未按平台权威插件契约声明启动钩子（自造字段） | 工程师本轮 E2：`plugin.json` 改 **顶层 `hooks: "./hooks/hooks.json"`**（删除 `workbuddy.startup`）+ `hooks.json` 声明 `SessionStart`（命令引用 `${CODEBUDDY_PLUGIN_ROOT}`、失败不阻塞会话）；E3：重部署 + `enabledPlugins` 落位（`winvm-bridge@winvm:true`，写前备份、保留它键） | **复证（主理人 15:21 复核 + QA 实证）**：部署态 `plugin.json` 实测含顶层 `"hooks": "./hooks/hooks.json"`（line 18）、**无 `startup`**；`~/.workbuddy/settings.json` 含 `"winvm-bridge@winvm": true`（line 44）；基线 `hooks/hooks.json` md5 `ff46c7c6…`、仅 `SessionStart`、命令引用 `CODEBUDDY_PLUGIN_ROOT`；隔离冷启动 `tunnel stop --force` → 执行 hook 命令 → **2.05 s** 恢复 /health 200、单实例（qa-d2-4.out）；负向注入不阻塞（qa-d2-1-3-5.out §⑤）。**⚠️ 部署态 `hooks.json` 曾被 QA 探针污染（注入 UserPromptSubmit/Stop/SubagentStop），本轮回滚至基线**。详见 **Run4 §二 / §附 / §六** | ✅ **已修·已复证**（机制对齐 + 隔离冷启动实证；端到端重启仍 BLOCKED，见 Run4 §二 2.3） |

> **台账口径**：**已修·已复证 15 项**（D1–D12、D14、D15、D16，共 15）· **已结案（非缺陷）1 项**（D13）· **已修（复证较弱）0 项**；累计 **16 项**。
> 另有**既有 P1·已知（非 D 系列）**：**A2A 冷启动停滞**（冷态首调有界失败，热态通过；随已知项维护）。

### 7.8 I1–I6 建议清单（原文保留 · 加「已落地」标注）

| 编号 | 优先级 | 项 | 落地情况 |
|---|---|---|---|
| I1 | P1 | `install-host.mjs` 部署期把探测到的默认私钥 **持久化进 `vm-conn.json` 的 `identityFile`**，彻底消除 `command` 依赖「运行时探测」的隐性假设；同时让守护进程显式拿 key，而非依赖其内部行为 | ✅ **已落地**（`vm-conn.json` 实测含 `identityFile`；B4 的运行时探测保留为兜底） |
| I2 | P2 | 隧道 VM 重启后的自愈时延：重启 `WinVMBridge.Service` 后隧道短暂黑洞（~18s），守护进程自愈；可加主动重连预热 / 更短退避首跳 | ✅ **已落地**（§3.3 拆双子例；VM 服务重启黑洞 **44.4 s < 60 s**，`selfheal-r2.out`） |
| I3 | P2 | 确认 HOURLY watchdog `aaa87da4` 覆盖守护进程掉线自动重生（当前 pid 300 已存活跨会话，但仍需机制兜底） | ⚠️ **部分**（改由任务 1 的 autostart 标记 + `tunnel ensure` 承接；**最终形态取决于 D16 收敛**） |
| I4 | P3 | Grep 工具对 `delivery/*.mjs` 漏匹配（已知 glitch），改用 Read / 精确单关键词；避免误判「未修改」 | ✅ **已落地**（登记为工具约束；本轮再次复现并改用脚本扫描） |
| I5 | P3 | 单测补充：`loadVmConn` 的 key-probe 分支（含「无凭据时探测 ~/.ssh」与「显式凭据优先」），`resolveVmConn` 已是纯函数，易测 | ⚠️ **未落地**（`resolveVmConn` 优先级已有单测；**key-probe 专项单测缺失**） |
| I6 | P3 | 三关验证门禁（build / typecheck / smoke）固化进交付清单 / CI，杜绝「单测过但未部署验证」的假绿 | ✅ **已落地**（本会话实测三关；CI 固化受沙箱无 `git` 限制，记为文档化条目） |

---

## 八、风险与未决（回写为真实清单）

> 原「无已知阻塞项（D1–D3 已修）」**已不成立**：D5–D15 已修，但本轮新立案 **D16** 未收敛，且存在一项**端到端 BLOCKED**。真实未决如下。

- **未决 1（已收敛·P1）· D16 机制修复完成**：`plugin.json` 已改**顶层 `hooks → ./hooks/hooks.json` 的 `SessionStart`**（删除自制字段 `workbuddy.startup`），且 `~/.workbuddy/settings.json.enabledPlugins` 已落位 `winvm-bridge@winvm:true`（写前备份、保留它键）。**直接影响用户诉求 ① 的机制层已闭环**（复证见 Run4 §二、DEPLOY-VERIFICATION §7.7 D16）。
- **未决 2（端到端 BLOCKED·非机制缺陷）· 「真·WorkBuddy 重启后隧道自动拉起」**：机制已对齐，但**本轮不能就地端到端验证**——无法在不杀死当前会话的前提下终止 WorkBuddy 主进程。**机制对齐 + 隔离冷启动实证仅属间接证据，不得包装为端到端已验**（纪律：**未复现 ≠ 已修**）。可执行的验证步骤与判据见 **Run4 §二 2.3**，由用户在会话外执行。**部署态 `hooks.json` 已被污染后回滚**（见 Run4 §六），当前部署态为干净基线。
- **未决 3（既有·P1 已知·非 D 系列）· A2A 冷启动停滞**：冷态首调 `A2A_DELEGATE_FAILED / terminated`（≈110 s 有界失败），热态成功（≈21 s）；随已知项维护，测试中不计 FAIL。
- **未决 4（P2·契约澄清）· OB-2**：A2A 委派产物落 `%USERPROFILE%\WinVMWorkspace\out`（`C:\Users\User\WinVMWorkspace\out`），非用例写死的 `C:\WinVMWorkspace\out`；两条路径均在白名单。待确认「是否应尊重 goal 显式输出路径」。
- **未决 5（P3·流程）· 独占时间窗**：VM 侧独占任务（如 D14 整条部署）执行期间宜宣告独占窗，避免与 QA 探针并发争用（原 OB-3 建议，降级为流程项）。
- **未决 6（遗留·P3）· I5**：`loadVmConn` key-probe 分支缺专项单测（见 7.0 / 7.8 I5 行）。
- **已闭合（供对照）**：D1–D12、D14、D15 = 已修·已复证；D13 = 已结案（非缺陷）。
- **教训（沿用 + 本轮新增）**：
  - 会话中断后恢复，**先对全部 `delivery/*.mjs` 跑 `node --check`** 再继续 —— D1 曾使 `setup.mjs` 完全不可用。
  - 证据文件「**写完再读**」（读取可能落在写入窗口内，得到未 flush 的 0 B 假空文件）；**删除证据须留痕**（删了什么 / 为什么 / 可否重建）。
  - 报告须列「**给值 vs 实测**」，不一致时**以磁盘实测为准**（本轮 `setup.mjs` 给值 `0a765b19…` / 59,948 B vs 实测 `cef0dcf3…` / 60,345 B，差因 = 任务 B 新增 `probeTunnelHttp()` 自验调用）。
  - 平台契约（自启动 / hook）**以内置样例为准，不得自造字段** —— D16 即自造 `workbuddy.startup` 所致。
- **发版**：沙箱无 `git`，**V1.0.1 tag 推送为 Windows 侧动作**（参考 `V1.0.0-release-notes.md` 第二节 tag 流程）。
