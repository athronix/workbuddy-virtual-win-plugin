# WinVM Bridge 真环境测试执行记录 · Run4（D16 启动机制验证 + 运行态恢复轮）

| 项 | 值 |
|---|---|
| 文档 | REAL-TEST-winvm-bridge-run4 |
| 日期时间 | 2026-09-23（宿主本地 `+08:00`；会话异常中断，WorkBuddy 于 **14:21** 重启） |
| 执行人 | QA（Edward / 严过关，software-qa-engineer）取证 + 主理人（齐活林 / Qi）汇编定稿 |
| 团队 | `software-winvm-cl020b` |
| 上游依据 | Run1/Run2/Run3 权威报告 + 本轮主理人现场取证 + 工程师 **E1/E2/E3** 交付 |
| 通道 | 宿主 CLI（`winvm-plugin`）· MCP（`command <tool>`）· 部署器（`setup.mjs`）· 宿主插件清单/hooks（本地） |
| 文档状态 | **已定稿**（2026-09-23 15:21 主理人汇编）：`§1.2` / `§三` 已回填；`§二` D16 ①–⑤ 实证回填；`§四`/`§五`/`§六`/`§附` 定稿。证据：`qa/evidence/run4/e2-hooks-assets.out`、`qa-d2-1-3-5.out`、`qa-d2-4.out`。**重大修正**：部署态 `hooks/hooks.json` 曾被 QA 探针临时污染（注入 UserPromptSubmit/Stop/SubagentStop），本轮回滚至基线 `ff46c7c68c943316694f5a63949edd1f`（仅 `SessionStart`），详见 §附 / §六。 |

> **一句话结论**：本轮核心 = **D16（自启动机制用平台不认的自制字段）修复验证** + **中断后运行态恢复复核**。D16 机制层（①–⑤）**全 PASS**（manifest 对齐 + 隔离冷启动实证 + 负向不阻塞）；但**端到端「真·WorkBuddy 重启后隧道自动拉起」仍 BLOCKED**（禁止杀主进程，§二 2.3）。部署态 `hooks.json` 污染已回滚为干净基线。

---

## 一 环境与基线

### 1.1 中断现场（主理人取证，可采信）
- **运行态已断**：`/health` HTTP = `000`；无 `tunnel-daemon` 进程；`~/.workbuddy/winvm/tunnel.state.json` 里 `pid 48202` 为**僵尸记录**。
- **VM 本体可达**：`ping 172.16.100.2` = 1 ms；SSH `SSH_OK`。

### 1.2 恢复后终态（E1 恢复 · 主理人独立复核）
> 证据：`qa/evidence/run4/e1-restore.out`（2,696 B @ `2026-09-23T06:27:22Z`，本地 14:27）。

- **恢复动作**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure` → 输出 `隧道已启动：127.0.0.1:18443 → User@172.16.100.2:22 → 127.0.0.1:18443`，`EXIT=0`。
- **恢复后四件（全部 PASS）**：
  - `tunnel status`：「运行中（可连）」· 监听 `127.0.0.1:18443` · **pid 10826**（独立进程组）· 「tunnel.state.json 与 pidfile 属主一致（pid 10826）」。
  - `/health`：`http=200` · `ok:true` · `capabilities 54/54` · `provider.state=ready` · `psBridge.state=ready pending=0 restarts=0` · `session.state=healthy interactive=true locked=false` · `chainValid:true`。
  - **18443 监听**：监听中（`tunnel status` + `/health` 双证）。
  - **daemon 实例数**：**1**（pid 10826）。
- **僵尸已清**：`state.json(pid 10826) ↔ tunnel.pid(pid 10826) ↔ /proc/10826` **三者一致**；僵尸 `pid 48202` 已清除（恢复前 `state.json` 仍为 `pid 48202`、`/proc/48202` 不存在、`daemon_count=0`）。
- **⭐ daemon 运行路径的变化（关键物证）**：本次 pid **10826** 跑的是**缓存根路径** `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs`；而中断前的僵尸 daemon(**48202**) 跑的是**仓库路径** `delivery/tunnel-daemon.mjs`。⇒ 印证「**缓存根 = 运行态真相源**」，也是历史上「改了仓库源码未重部署所以不生效」那类问题的**物证**。
- **中断前 pid 链（口径）**：`300 → 37199 → 41823 → 43056 → 43477 → 48202（死）→ [中断，14:21 重启] → 10826（本次新建）`。
- **QA 本地旁证（14:30，只读）**：精确扫 `/proc`（判据 = cmdline 第 2 段以 `tunnel-daemon.mjs` 结尾）观测存活实例 **pid 10826**，与 E1 命令级证据**独立互证**运行态已恢复。
- **数据 caveat（据实登记）**：E1 日志「[恢复前] curl /health」记为 `http=200`，与同段「[恢复前] daemon_count=0」并存、看似矛盾；疑为脚本取数顺序（pid 10826 启动于 `06:26:55`，早于 `06:27:22` 的采集），**不作为「恢复前仍可达」的证据**。

### 1.3 相关文件 md5 与字节（磁盘实测为权威）
| 文件 | 字节 | md5 |
|---|---|---|
| `delivery/setup.mjs` | 60,345 | `cef0dcf3471809bc41f88843f1b23942` |
| `delivery/winvm-plugin.mjs` | 51,412 | `efdafd2d1e3185647b852d7be5778eb2` |
| `delivery/tunnel-daemon.mjs` | 8,837 | `4ed08c1fd63052de761423b41dc87e0b` |
| `delivery/install-host.mjs` | 51,564 | `bdebcb173cb01f05d466cae77960602f` |
| `delivery/install-vm.mjs` | 41,754 | `24a3db6e435b8592e2536130e00fe6c2` |
| `tests/unit/setup-health-verdict.test.js` | 5,509 | `c9770f9bf8863d33e3764adec3ca654e` |
| `delivery/hooks/hooks.json`（基线） | 638 | `ff46c7c68c943316694f5a63949edd1f` |
| `delivery/hooks/session-start.sh` | 2,631 | `16f3799654de9423b4da651f9cca08af` |
| `tests/unit/enabled-plugins.test.js` | 4,823 | `3edff04054dc9562d17f8c0672c81fe5` |

> 口径：与派单给值不一致时**以磁盘实测为权威**并写明差异（沿用 Run3 §八③ 新规）。

---

## 二 D16 验证（核心）

**缺陷回顾（D16）**：自启动机制用了平台**不认**的自制字段 `workbuddy.startup`（应为**顶层 `hooks` → `./hooks/hooks.json` 的 `SessionStart` 事件**），且 `~/.workbuddy/settings.json.enabledPlugins` 里**没有 `winvm-bridge@winvm`** → WorkBuddy 重启后隧道**不会自动拉起**。

### 2.1 现状证据（QA 本地取证，14:30 + 主理人 15:21 复核）
- **修复后 manifest（部署态真实产物）**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/.codebuddy-plugin/plugin.json`
  - 顶层含 `"hooks": "./hooks/hooks.json"`（line 18）；
  - **已删除** `workbuddy.startup`（grep `startup` → 无命中）；
  - 保留 `workbuddy.{kind,bundleSegments,loadsCapabilities}`。
- **平台已注册**：`~/.workbuddy/settings.json` 的 `enabledPlugins` 含 `"winvm-bridge@winvm": true`（line 44，count=28）。
- **权威样例（逐项对照基准）**：内置 `~/.workbuddy/plugins/cache/workbuddy-builtin/tencent-docx/0.4.1/`
  - `plugin.json`：顶层 `"hooks": "./hooks/hooks.json"`（另含 `skills` / `agents` 数组）。
  - `hooks/hooks.json`：`{"hooks": {"SessionStart": [{"hooks": [{"type":"command","command":"bash \"${CODEBUDDY_PLUGIN_ROOT}/scripts/...\" </dev/null >/dev/null 2>&1 &","description":"...","timeout":5}]}]}}`。

### 2.2 验证项（✅ 已回填 · 实测结论）

> 证据：`qa/evidence/run4/qa-d2-1-3-5.out`（①–③+⑤）、`qa-d2-4.out`（④）、`e2-hooks-assets.out`（E2/E3 交付 + §5/§7 隔离冷启动）。主理人 15:21 复核：部署态 `plugin.json` 含顶层 `"hooks": "./hooks/hooks.json"`（无 `workbuddy.startup`）；`~/.workbuddy/settings.json` 含 `"winvm-bridge@winvm": true`（line 44）；基线 `hooks/hooks.json` md5 = `ff46c7c6…`。

| # | 验证项 | 判据 | 结果 |
|---|---|---|---|
| ① | **机制对齐**：manifest 字段 vs 内置 `tencent-docx/0.4.1` 样例逐项对照 | 顶层 `hooks` = `./hooks/hooks.json`（与样例同键位）；无 `workbuddy.startup`；`hooks.json` 含 `SessionStart`；元素结构 `type·command·description·timeout` 与样例一致 | ✅ **PASS**（qa-d2-1-3-5.out §①；plugin.json 实测 line 18） |
| ② | **`enabledPlugins` 落位** | `settings.json.enabledPlugins` 出现 `winvm-bridge@winvm: true` | ✅ **PASS**（qa-d2-1-3-5.out §②：`winvm-bridge@winvm=true`，count=28；主理人复核 line 44） |
| ③ | **缓存根 `hooks/hooks.json` 存在且 JSON 可解析、命令引用 `${CODEBUDDY_PLUGIN_ROOT}`** | `JSON.parse` 成功；命令串含 `${CODEBUDDY_PLUGIN_ROOT}` | ✅ **PASS**（qa-d2-1-3-5.out §③：`exists=yes`、`JSON.parse OK`、`references CODEBUDDY_PLUGIN_ROOT=true`；**回滚后仅 `SessionStart` 一个事件**，见 §附） |
| ④ | **手动执行 hook 命令的幂等性 / 冷启动拉起**（已在线秒回、**不产生第二实例**） | 命令返回 0；`/proc` 扫 `tunnel-daemon.mjs` 实例数 `=== 1`；冷启动可恢复 | ✅ **PASS**（qa-d2-4.out：基线 pid 13903 → `tunnel stop --force`（/health 000、实例 0）→ 执行 hook 命令 → **2.05 s 恢复 /health=200** → 终态 pid 16001、单实例；e2-hooks-assets.out §7 独立复证 ~4 s 拉起、单实例 pid 13903） |
| ⑤ | **失败不阻塞会话**（负向注入） | 命令返回不受影响；hook 在 `timeout`（5 s）内返回；运行态不崩 | ✅ **PASS**（qa-d2-1-3-5.out §⑤：5a `ROOT=/nonexistent-root`→exit 0/133 ms；5b 必失败路径后台 `&`→shell_return 0/29 ms；5c 硬失败 `exit 7` 后台不阻塞；5d 负向后隧道仍 `运行中` pid 16001；e2-hooks-assets.out §6 `ROOT=/nonexistent-root`→静默 exit 0/53 ms） |

### 2.3 必答 —— 端到端「真·WorkBuddy 重启后隧道自动拉起」本轮能否就地验证？

**结论：不能。= BLOCKED。**

- **原因**：就地验证需要**终止 WorkBuddy 主进程**（当前 Agent 会话的宿主），而终止它会**同时杀死本会话**（self-kill）→ **无法在一次会话内完成「重启 → 复检」闭环**。
- **纪律声明**：**「未复现 ≠ 已修」**。§二 §①–③ 的**机制对齐只是间接证据**（证明 manifest 已按平台契约声明 hook），§④–⑤ 的**隔离冷启动是「手工执行 hook 命令」的实证**（非「平台在 SessionStart 时自动调用」）；**均不等价于**「WorkBuddy 重启后平台真的自动拉起了隧道」。**不得将机制对齐包装成端到端已验**。
- **可执行的验证步骤与判据（交主理人/用户在会话外执行）**：
  1. **基线留痕**：记录 `tunnel.pid` / `tunnel.state.json` / `tunnel status --json`（pid + healthy）；
     `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel status --json`。
  2. **重启 WorkBuddy**（**由用户在应用/终端层关闭并重开 WorkBuddy**，非在会话内 `kill` 主进程）。
  3. **重启后不执行任何手工命令**，直接复检：
     - `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel status --json` → 期望 `state=RUNNING, healthy=true, ownerMatch=true, stateStale=false`；
     - **精确**扫 `/proc`（判据 = cmdline 末段以 `tunnel-daemon.mjs` 结尾，**避免扫描命令自匹配伪影**）：实例数 `=== 1`（**无第二实例**）；
     - `127.0.0.1:18443` 处于 `LISTENING`；
     - `curl -s --noproxy 127.0.0.1 --max-time 30 http://127.0.0.1:18443/health` → `ok:true`、`capabilities 54/54`、`session.state=healthy`。
  4. **判据**：以上 4 项**全绿** = **端到端 PASS**；任一失败 = **FAIL**，按四元组（现象 / 根因 / 证据 / 路由）登记。
  5. **负向（机制鲁棒性）**：临时把 hook 命令指向**必失败路径** → 重启后会话仍可正常启动、hook 不阻塞（在 `timeout` 内返回）→ 证明「自启动失败不致命」。

---

## 三 运行态恢复结果（E1 已完成 · 主理人独立复核）

**证据**：`qa/evidence/run4/e1-restore.out`（2,696 B @ `2026-09-23T06:27:22Z`）· 恢复动作 `winvm-plugin tunnel ensure`（缓存根 shim，`EXIT=0`）。

| 复检项 | 恢复前 | 恢复后 | 判定 |
|---|---|---|---|
| `/health` | 见 §1.2 caveat | `http=200` · `ok:true` · caps **54/54** · provider `ready` · psBridge `ready pending=0 restarts=0` · session `healthy interactive=true locked=false` · `chainValid:true` | **PASS** |
| `tunnel status` | — | 「运行中（可连）」· 监听 `127.0.0.1:18443` · pid **10826** · 属主一致 | **PASS** |
| daemon 实例数（`/proc` 精确判据） | `0` | **1**（pid 10826） | **PASS** |
| `state.json ↔ pidfile ↔ /proc` | state.json 僵尸 `pid 48202`（`/proc/48202` 不存在） | **三者一致 pid 10826**，僵尸已清 | **PASS** |
| `vm-conn.json.identityFile` | — | 存在（`/storage/Users/currentUser/.ssh/id_ed25519`） | **PASS** |

- **QA 独立旁证**：14:30 本地只读精确扫 `/proc` 观测 pid 10826 存活（与 E1 一致），**非依赖 E1 单一来源**。
- **运行路径物证**：恢复后 daemon 跑**缓存根路径**（见 §1.2「daemon 运行路径的变化」）。
- **结论**：中断后运行态**已恢复并自洽**（`/health` 全绿 + 单实例 + 三文件一致 + 僵尸清除）= **PASS**。

---

## 四 通过率与计数（✅ 已定稿）

| 层 | 统计 |
|---|---|
| 本轮范围 | D16 机制验证（5 项）+ 运行态恢复复检（5 项） |
| 验证项（D16 ①–⑤） | **5/5 PASS**（机制对齐 / enabledPlugins / hooks 解析 / 冷启动幂等 / 失败不阻塞） |
| 复跑项 | 2（④ 冷启动隔离复现 `qa-d2-4.out`；⑤ 负向注入 `qa-d2-1-3-5.out §⑤`） |
| 新增 FAIL | **0** |
| 新增 BLOCKED | **1**（端到端「真·WorkBuddy 主进程重启后隧道自动拉起」§二 2.3，因禁止杀主进程无法就地闭环） |
| 运行态恢复复检 | 5/5 PASS（§三，主理人独立复核：/health 200、单实例 pid 10826、三文件一致、僵尸清除） |

---

## 五 D1–D16 台账交叉引用

**须与 `docs/changes/CL-020/DEPLOY-VERIFICATION.md` §7.7 保持逐项一致（不一致即缺陷）。**

| ID | §7.7 状态 | Run4 结论 |
|---|---|---|
| D1–D12 / D14 / D15 | 已修·已复证 | 沿用（本轮不重开） |
| D13 | 已结案（非缺陷） | 沿用 |
| **D16** | **已修·已复证** | 机制对齐（①–③）+ 隔离冷启动实证（④）+ 失败不阻塞（⑤）全 PASS；**端到端重启仍 BLOCKED**（§二 2.3，禁止杀主进程） |

---

## 六 遗留项与建议（✅ 已定稿）

- **D16 收敛**：§二 §①–⑤ 已回填（全 PASS）；§7.7 D16 行已同步为「已修·已复证」，**一致性已闭合**（2026-09-23 15:21 主理人复核）。
- **⚠️ 部署态 hooks.json 污染修正（本轮重大发现）**：QA 探针曾把临时 `UserPromptSubmit/Stop/SubagentStop` 注入**部署态** `hooks/hooks.json`（md5 `ee644c66…`、log 空 = 从未触发），本回合滚至基线 `ff46c7c68c943316694f5a63949edd1f`（仅 `SessionStart`）。**教训**：探针不得改写部署态清单；应改副本或内存注入，且须在回合结束前回滚。后续若需动态验证 hook 是否被平台消费，须在**新会话**（配置快照生效）内、对**副本**注入，且强制回滚。
- **端到端 BLOCKED 固化**：§二 2.3 四步验证脚本已沉淀为 `real-test.md`「重启自启」专用用例（含负向注入），交由用户在会话外执行。
- **既有未决（沿用）**：A2A 冷启动停滞（P1 已知）· OB-2 A2A 输出基目录（P2 契约澄清）· 原 OB-3「独占时间窗」（P3 流程项）· I5 `loadVmConn` key-probe 单测（P3 遗留）。

---

## 附：本轮原始输出留存（✅ 已补全）

| 文件 | 内容 |
|---|---|
| `qa/evidence/run4/e1-restore.out` | E1 恢复证据（恢复前/后 `tunnel status` + `/health` + `/proc` 单实例 + 僵尸清除） |
| `qa/evidence/run4/e2-hooks-assets.out` | E2/E3 D16 修复证据：官方文档结论 · manifest 渲染（删 `workbuddy.startup`、加顶层 `hooks`）· 部署态 manifest/hooks 资产 md5 · 已在线幂等 §5 · 失败安全 §6 · **隔离冷启动拉起 §7（~4 s、单实例 pid 13903）** · enabledPlugins 启用/停用 + 单测 9/9 |
| `qa/evidence/run4/qa-d2-1-3-5.out` | QA §① 机制对齐（manifest vs tencent-docx 样例）· §② `winvm-bridge@winvm=true`（count 28）· §③ hooks.json 解析 + `CODEBUDDY_PLUGIN_ROOT` 引用 · §⑤ 负向注入（5a/5b/5c/5d） |
| `qa/evidence/run4/qa-d2-4.out` | QA §④ 独立复现：基线 pid 13903 → `tunnel stop --force` → 执行 hook 命令 → **2.05 s** 恢复 /health=200 → 终态 pid 16001、单实例 |
| `qa/evidence/run4/hook-probe.sh` + `hook-fire-probe.log` | **探针痕迹（已弃用）**：本轮回滚部署态清单后不再引用；log 为空 = 探针从未触发，留档备查 |
| `docs/changes/CL-020/DEPLOY-VERIFICATION.md` §七/§八 | 本节台账交叉引用唯一来源（D16 已同步为「已修·已复证」） |
