# CL-020 迭代交付总结 · 2026-09-23

> 交付人：软件开发团队（主理人 齐活林 / 架构 高见远 / 工程 寇豆码 / QA 严过关）
> 范围：`DEPLOY-VERIFICATION.md` §七 迭代项（I1–I6，「接受全部建议」）+ 用户追加 6 条诉求
> 验证形态：**真机**（宿主 HarmonyOS NEXT + VM Win11 `172.16.100.2`），三轮迭代测试（Run1/Run2/Run3）

---

## TL;DR

一键部署（双端）从**不可重复执行（EXIT 1）**修为**可重复执行（EXIT 0，三级隧道决策全覆盖）**；
真实环境测试方案落地为 `docs/test/real-test.md`（54 能力 + 25 用例矩阵）；
三轮（Run1–Run3）+ 中断恢复轮（Run4）共立案并处置 **12 项缺陷（D5–D16）**，**已修并复证 11 项 / 已结案 1 项**；D16 机制层已闭环，**端到端重启验证 BLOCKED**（Run4 §二 2.3，禁止杀主进程）。

---

## 一、用户 6 项诉求逐条收口

| # | 诉求 | 交付 | 证据 | 状态 |
|---|---|---|---|---|
| **1** | tunnel-daemon 注册为 WorkBuddy 启动服务 | 宿主持久化拉起 + pidfile/state；插件 `tunnel {ensure,status,stop}` 子命令 | `delivery/winvm-plugin.mjs`（`efdafd2d…`）· `skills/winvm-orchestrator/SKILL.md` | ✅ |
| **2** | skills 注明「操作 VM 前须确认 tunnel-daemon 在线健康」 | 命令表 + 权威判据措辞（`tunnel status` 为准，`state.json` 仅作诊断、**不得据其判健康**） | `skills/winvm-orchestrator/SKILL.md`（`a4aa543b…`）· `skills/winvm-mcp-reference/*` | ✅ |
| **3** | VM 端除启动外，注册为**开机自启** | 任务双触发器 **`BootTrigger` + `LogonTrigger`** | `qa/evidence/run2/task-trigger.out`（`BootTrigger=1 LogonTrigger=1`） | ✅ |
| **4** | 双端**一键部署**脚本（总脚本调两端子脚本 + 联合验证） | `delivery/setup.mjs`（8 相位，`--only-host`/`--only-vm`/`--phase`）调 `install-host.mjs`（宿主）+ `install-vm.mjs`（VM，经 scp→ssh 执行） | `qa/evidence/run2/d14b-full-deploy.log`（EXIT 0）· `d14b-full-deploy-2nd.log`（幂等 EXIT 0）· `run3-full-deploy.log`（RUN3_EXIT=0） | ✅ |
| **5** | 真环境测试方案覆盖 ①部署完整性 ②组件健康性 ③各类型任务用例（MCP + A2A） | `docs/test/real-test.md`：**54 能力**（meta3/system14/app8/storage13/gui11/appops5）= 25 用例矩阵（MCP 22 + A2A 3），含部署完整性 3 项 + 健康性 3 项 | `docs/test/real-test.md`（69 KB） | ✅ |
| **6** | 迭代「测试–修复」并**每轮文档化**测试报告 + 修复建议 | Run1/Run2/Run3 三轮，独立权威报告 | `docs/test/reports/real-test-2026-09-23{,-run2,-run3}.md` | ✅ |

### 诉求 4 的关键补强：隧道决策三级全覆盖

```
① 复用      run#1 pid41823 / run#2 pid43477 / run3 pid48202（0.6–0.7s）
② daemon 拉起  隔离实测：tunnel stop → --phase TUNNEL --apply → ensure 1.5s / 相位 2.2s / 新 pid 43477
③ 回落自建   负向注入实测：stub 顶替 CLI 使 ensure 必败 → 告警 + 进程内 ssh2 建隧道 + /health 打通（3.2s）
```
> **⚠ 重要机制事实**：`install-host.mjs:965-975` 在 **HOST 相位自己会 `tunnel ensure`** ⇒ **整条总脚本里 TUNNEL 相位永远走①复用、永远看不到"无隧道"**。
> 要验证 ②/③ 必须用 `--phase TUNNEL` 隔离跑。这是"为什么从零拉起测不到"的根因。

---

## 二、缺陷台账 D5–D15（11 项）

| ID | 现象 | 根因 | 证据 | 状态 |
|---|---|---|---|---|
| **D5** | `install-host` 缺默认私钥探测链 / vm-conn 覆盖写 | 解析顺序与提示不当 | `delivery/install-host.mjs` + 运行期 `使用私钥：~/.ssh/id_ed25519（来源：默认 ~/.ssh 探测）` | ✅ 已修 |
| **D6** | `tunnel.state.json` 声称死 pid；statePath 硬编码 | `statePath` 硬编码 + 缺属主校验 | `qa/evidence/run2/d6-r2.out` | ✅ 已修·复证 |
| **D7** | 适配器残留「手工建 ssh 隧道」文案 | 未随 daemon 机制更新 | `packages/adapter-host-workbuddy/src/index.ts` | ✅ 已修 |
| **D8** | `winvm-mcp-reference` 3 处 ssh 手建隧道文案 | 文档未随机制更新 | `skills/winvm-mcp-reference/SKILL.md` | ✅ 已修 |
| **D9** | skill 命令非仓库根 cwd 可用性 / 部署树漂移 | 部署树与仓库 `skills/` 可能不一致 | `qa/evidence/run2/skills-check.out`（双树 IDENTICAL=true） | ✅ 已修·复证 |
| **D10** | VM 计划任务缺 `BootTrigger` | VM 侧 `install-vm.mjs` 旧副本未覆盖（40,780 B→41,754 B） | `qa/evidence/run2/task-trigger.out` | ✅ 已修·复证 |
| **D11** | `health.llmSession` 幻象降级（sticky degraded） | 失败态未归一/未带 `lastErrorAt` | `qa/evidence/run2/d11-check.out` | ✅ 已修·复证 |
| **D12** | 宿主 `server` 子命令被 MSYS 路径转换破坏（假报"未注册"） | `cmdServer` 裸投 `schtasks /Query|/run|/end` 给 VM 默认 Git-Bash ⇒ `/Query`→`C:/Program Files/Git/Query` | `qa/evidence/run2/selfheal-r2.out` | ✅ 已修·复证 |
| **D13** | 空载 3min 疑似降级 | **实为设计态**（`llmSession` 空闲回收 `stopped`） | `qa/evidence/run2/d13.out`（空载 ≥3min 全绿） | ✅ 已结案（非缺陷） |
| **D14** | `setup.mjs` TUNNEL 相位裸自建、非幂等 → **EADDRINUSE / EXIT 1** | 未复用常驻 daemon | `run3-full-deploy.log` · `d14c-fallback-inject.log` | ✅ 已修·复证（正/负两端） |
| **D15** | HEALTH 门禁把 `state='unavailable'`（**探针超时/未知**）当终态，强断言「非交互式会话 → GUI 不可用」+ 打印误导性人工补救块 | 旧判据 `session.interactive === false`（超时被服务端默认成 `false`）；缺三态与退避复探 | `run3-d15-unit.out`（8/8）· `run3-full-deploy.log` | ✅ 已修·复证（本轮核心） |
| **D16** | WorkBuddy 重启后隧道未自动拉起：`plugin.json` 用平台不认的自制字段 `workbuddy.startup`（应=顶层 `hooks` → `./hooks/hooks.json` 的 `SessionStart`）；且 `settings.json.enabledPlugins` 缺 `winvm-bridge@winvm` | 未按平台权威插件契约声明启动钩子（自造字段） | 部署态 `plugin.json` 含顶层 `hooks`（无 `startup`）；`settings.json` 含 `winvm-bridge@winvm:true`；隔离冷启动 ~2.05s 单实例（qa-d2-4.out） | ✅ 已修·复证（机制）/ 端到端 BLOCKED |

**口径**：已修并复证 **11 项**（D5–D15、D16）· 已结案（非缺陷）**1 项**（D13）· **未结 0 项**；D16 端到端重启验证 = BLOCKED（见 Run4 §二 2.3）。

### D15 · before / after（同一冷启载荷，最有价值的对照）

| | 同一载荷（`session.state='unavailable'`、子探针 5000ms 超时） |
|---|---|
| **修复前** | 硬断言「服务运行在【非交互式/降级会话】→ GUI 能力不可用」+ 打印「💡 启用 GUI」人工命令块（**误报**；实测 1 分钟后 `interactive:true`、GUI 4/4 PASS） |
| **修复后** | `⏳ /health 结论未知（…不判非交互）→ 10s 后复探（1/6）` → 复探得 `sessionId:1 / WinSta0 / interactive:true / state:healthy` → `✅ GUI 能力可用`；误报关键词计数 **0 / 0** |

---

## 三、真实环境测试结果（三轮）

| 轮次 | 范围 | 结果 | 报告 |
|---|---|---|---|
| **Run1** | 全量 25 用例（MCP 22 + A2A 3） | 24 PASS / 1 BLOCKED / 0 FAIL | `real-test-2026-09-23.md` |
| **Run2** | D6–D13 回归 + §3.3 双子例 + GUI 补跑 + A2A 复跑 | 部署完整性 6/6 · 健康性 3/3 · GUI 4/4 · A2A 1/1；**新增 FAIL=0 / BLOCKED=0**；D6–D12 **7/7 PASS** | `real-test-2026-09-23-run2.md` |
| **Run3** | D15 修复验证 + 重启后 GUI 复验 + ③ 负向注入 + 台账 | 单测 **8/8** · 端到端 **EXIT 0 且误报消除** · GUI 复验 **4/4** · ③ **三件齐** | `real-test-2026-09-23-run3.md` |
| **Run4** | D16 启动机制验证 + 中断后运行态恢复复检 | D16 ①–⑤ **5/5 PASS**（机制对齐 / 隔离冷启动 ~2.05s 单实例 / 负向不阻塞）；运行态恢复 5/5 PASS；**新增 BLOCKED 1**（端到端重启） | `real-test-2026-09-23-run4.md` |

**口径修正（Run2 关键补强）**：`§3.3` 原把两个不同的量混为一个数 —— 已拆为
① 「VM 服务重启 → 工具可用」黑洞 **44,419 ms < 60s**；② 「隧道 daemon 层自愈」（kill → `ensure` → 新 pid 单实例）。

**另有既有 P1·已知（非 D 系列）**：A2A 冷启动停滞（冷态首调有界失败 ≈110s，热态 ≈21s 成功），随已知项维护，测试中不计 FAIL。

---

## 四、交付物清单

### 代码
| 文件 | 终态 |
|---|---|
| `delivery/setup.mjs` | **60,345 B / md5 `cef0dcf3471809bc41f88843f1b23942`**（D14 三级隧道 + D15 三态门禁与退避复探） |
| `delivery/winvm-plugin.mjs` | 51,412 B / md5 `efdafd2d1e3185647b852d7be5778eb2`（D12 PowerShell cmdlet） |
| `delivery/tunnel-daemon.mjs` | md5 `4ed08c1fd63052de761423b41dc87e0b`（D6 statePath） |
| `delivery/install-host.mjs` | D5 连接解析 + 合并写入；`install-vm.mjs` 41,754 B / md5 `24A3DB6E435B8592E2536130E00FE6C2`（D10 双触发器） |
| `packages/contracts/src/bridge.ts` · `packages/adapter-agent-workbuddy-llm/src/persistent-session.ts` | D11（两信号分离 + `lastErrorAt`） |
| `tests/unit/setup-health-verdict.test.js` | **5,509 B / md5 `c9770f9bf8863d33e3764adec3ca654e`**（8/8 PASS） |
| `skills/winvm-orchestrator/SKILL.md`（`a4aa543b…`）· `skills/winvm-mcp-reference/*` | D8/D9 文案与命令锚点 |

### 文档
- `docs/test/real-test.md`（测试方案，69 KB / 54 能力 / 25 用例）
- `docs/test/reports/real-test-2026-09-23.md`（Run1）
- `docs/test/reports/real-test-2026-09-23-run2.md`（Run2）
- `docs/test/reports/real-test-2026-09-23-run3.md`（Run3）
- `docs/test/reports/real-test-2026-09-23-run4.md`（Run4 · D16 验证 + 运行态恢复）
- `docs/changes/CL-020/DELIVERY-SUMMARY-2026-09-23.md`（本文）

### 证据（`qa/evidence/run2/`）
`d14b-full-deploy.log` · `d14b-full-deploy-2nd.log` · `d14b-from-zero-tunnel.log` · `d14b-tunnel-stop.log` · `d14c-fallback-inject.log` · `run3-full-deploy.log` · `run3-d15-unit.out` · `d6-r2.out` · `task-trigger.out` · `skills-check.out` · `selfheal-r2.out` · `d11-check.out` · `d13.out` · `gui-check.out` · `gui-check.postdeploy.out` · `a2a03.out`

---

## 五、收尾规范性验证（终态）

| 项 | 实测 |
|---|---|
| 常驻隧道 daemon | **单实例**（精确 `cmdline` 判据：`delivery/tunnel-daemon.mjs`）pid `48202`，`RUNNING / healthy:true / ownerMatch:true / stateStale:false` |
| `/health` | `ok:true` · `capabilities 54/54` · `exposed 54` · `provider:ready` · `psBridge:ready pending:0` · `session:healthy interactive:true` |
| VM 计划任务 | `server status` → **已注册**、`:18443 监听中`；双触发器在位 |
| 仓库 vs 宿主缓存根 | 4/4 SAME（`efdafd2d1e31` / `4ed08c1fd630` / `8c397ae7eb24` / `35f1678d9614`） |
| 注入残留 | 无（`BAK_STILL_EXISTS=no`，还原 md5 = 原值） |

> **Run4 刷新（2026-09-23 中断恢复轮）**：原 pid 48202 daemon 中断后变僵尸；E1 用缓存根 `winvm-plugin tunnel ensure` 恢复 → pid **10826**（跑**缓存根路径** `.../0.1.0/tunnel-daemon.mjs`，印证「缓存根 = 运行态真相源」），`/health` 200、54/54、单实例、三文件一致。**部署态 `hooks/hooks.json` 曾被 QA 探针污染并回滚至基线 `ff46c7c6…`**（见 Run4 §六）。

---

## 六、遗留项与下一步建议

### 建议动作
1. **版本发布**：建议打 **V1.0.1**（沙箱内无 `git`，tag 为 Windows 侧动作）。
2. **契约文档级补强（P2，零风险、建议先做）**：`packages/contracts/src/bridge.ts:36-47` 注明「`interactive/locked/blackScreen/windowStation/sessionId` **仅当 `state==='healthy'` 时才有意义**，否则视为未知」——消除"只读 `interactive` 不先查 `state`"这类复发土壤。
3. **回归基线固定**：把 Run3 的 md5 基线写入 CI/部署校验，防"改了源码没重发 VM 侧"类漂移（本会话 D10 即此类）。
4. **A2A 冷启动停滞（P1 既有）**：建议单列一轮专门治理（冷态首调 110s 有界失败）。
5. **契约强约束（P3，需版本化）**：`SessionState` 增 `'unknown'` 或相关字段改可选 —— 属 JSON 契约变更，须审计全部消费者（skill 文档 / host CLI / QA 探针）。

### 已采纳的流程改进
1. **证据文件「写完再读」** —— 读取可能落在写入窗口内得到未 flush 的 0 B 假空文件（本轮 QA 据此误报过一次"证据缺失"）。
2. **证据目录不得静默删除** —— 任何删除须留一行（删了什么 / 为什么 / 可否重建）。
3. **共享 VM 资源前宣告独占窗** —— QA 与 Engineer 并发同一 VM 曾产生降级窗（OB-3 现象），由主理人串行编排。
4. **报告须列「给值 vs 实测」** —— 派单给的哈希可能与磁盘不符（本轮 D15 首版 `0a765b19…` → 终态 `cef0dcf3…`，差因 = ③ 分支新增 `probeTunnelHttp()` 自验调用，L812）。
5. **每轮只留一份权威报告** `docs/test/reports/real-test-<date>-run<N>.md`（Run1 曾出现两份冲突件，后者判定权威、前者改名 `.superseded.md`）。
6. **探针不得改写部署态清单** —— QA 探针曾把临时 `UserPromptSubmit/Stop/SubagentStop` 注入**部署态** `hooks/hooks.json`（log 空=从未触发），本轮回滚至基线；后续动态验证 hook 被消费须在**新会话**内对**副本**注入并强制回滚。

---

## 七、验收三关（本会话实测）

| 关卡 | 结果 |
|---|---|
| 构建 / 语法 | `node --check delivery/setup.mjs` **OK**（全部 `delivery/*.mjs` 均通过） |
| 单元测试 | `node --test tests/unit/setup-health-verdict.test.js` → **8/8 PASS**（主理人独立重跑） |
| 真机烟测 | 整条 `setup.mjs --apply --yes` **EXIT 0**；收尾健康全绿；隧道单实例；GUI 可用 |
