# 项目长期记忆 · winvm-virtual-win-plugin

> 跨会话复用事实；临时排查勿入。交接见 `.workbuddy/README.md` + `handover/07-migration-checklist.md`。

## 架构
宿主 WorkBuddy 插件，操作 Win11 VM（system/app/storage/gui/appops 五域 54 能力）。DDD+plan-first；npm workspaces 12 包，TS strict ESM，`tsc -b`，`node --test`。
- **双通道**：MCP 直调 VM `/mcp`（简单）/ A2A 经隧道调 `/a2a`（复杂，streaming 审批）；同一隧道承载两者。工具名 `system.info.get`→`winvm__system_info.get`。
- **VM 内 AI Agent（`WINVM_VM_PROVIDER`）**：`workbuddy-deterministic`（基准）/ `workbuddy`（LLM，常驻 `codebuddy` CLI 会话）/ `hermes-agent`（须预注册 config.yaml.mcp_servers）。

## 拓扑与环境
- 宿主 = 鸿蒙 HarmonyOS NEXT，`process.platform` 实报 **`openharmony`**；VM = Win11 `172.16.100.2`（`ssh User@…` 免密；`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区）；VM 服务只监听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（**改 `psmod/*.ps1` 必须重启服务**）。
- **宿主插件缓存 = 运行态真相源**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`（真实副本非 symlink）→ **改 dist 必须实跑 `delivery/install-host.mjs` 才生效**。
- 宿主持久化：`~/.workbuddy/winvm/{vm-conn.json,tunnel.pid,tunnel.state.json,tunnel-autostart.json,tunnel.log}`；VM 侧 `~/.workbuddy/winvm/side.json`。
- **鸿蒙沙箱**（细见用户级记忆）：WB App uid 20020171，每 App 独立挂载命名空间 + HMMAC，无 root；`$HOME=/storage/Users/currentUser`（hmdfs）是唯一跨 App 通道。跨 App 判活 `kill -0`：EACCES≠死、ESRCH=死。

## 关键坑（改码/联调前必扫）
- **远端 shell = Git Bash(MSYS)**：`/` 开头参数被路径转换、`$_`/`$env:` 被吞 → 远端逻辑写 `.ps1` → scp（**远端路径须 `C:/…`**）→ `powershell -NoProfile -ExecutionPolicy Bypass -File`；载荷用 ASCII 防中文乱码。杀隧道勿 `pkill -f 'ssh -N -L'`（自杀）→ 直 kill PID。
- **PS 5.1**：`Sort-Object <裸键>` 对 `[ordered]@{}` 静默失效 → `-Property { $_.key }`；`Set-StrictMode` 下顶层变量无条件赋值。
- **沙箱**：`/tmp` 只读（用 `$HOME/wbtmp`）；无 `git`；`rm` shim **坏**（`safe-bin/rm` shebang `#!/bin/bash`，本机只有 `/bin/sh` → bad interpreter / exit 126）→ 用 `fs.unlinkSync`/`renameSync`；`ls` 无 `--time-style`；`getcwd` 偶发异常（用绝对路径）；node 必须 `/data/storage/el1/bundle/libs/arm64/node/bin/node`。
- **单测绝不整批跑** → `node --test <单文件>`。
- **Grep 工具对 `delivery/*.mjs` 漏匹配**（`|` 多选正则假阴性）→ 用 Read 或逐词单搜。
- **隧道**：VM 掉线时旧隧道仍占监听 → TCP 通但 HTTP 黑洞（判据：ping 100% 丢）。用 `delivery/tunnel-daemon.mjs`（进程内 ssh2 + 指数退避 + 仅绑回环 + pidfile/state；**无 `--daemon`，直接跑即常驻**）。兜底 HOURLY watchdog `aaa87da4`。
- **VM 侧 live 部署**：`.env.deploy-vm`；dist tar → scp → VM 内**从文件**解包覆盖（`tar -x` 不可走 stdin，MSYS 会截断）→ `kill-restart.ps1`。
- **codebuddy CLI 自动升级**中途夭折会删坏 nvm 垫片 → 固定版本。

## 里程碑
- CL-015 鸿蒙宿主适配｜CL-016 审批闸 UX｜CL-017「5 域×2 通道」E2E 18/18｜CL-018 常驻会话 6 项｜CL-019 缓存新鲜度 / `routeMetric`。
- **CL-020**：F2 全通道采集（`server.ts` 注入 `reportNetCfg` 单一数据源 + `adapter-agent-workbuddy.execute` 仅对 `system.network.config` 上抛）；隧道生产化（`'openharmony'` 判定）。生产化收口：真机干净部署 + 全量真环境测试通过；F2 懒刷新 `netCfg.ageMs` 50,446,574→13,266ms；修 B4（`probeDefaultSshKey()` 默认私钥探测链）。
- **CL-020 迭代收口 D5–D15（2026-09-23）**：`D14` 修 `setup.mjs` TUNNEL 相位无条件自建隧道（EADDRINUSE/EXIT 1）→ `runTunnelPhase()` 三级（①复用 / ②daemon `ensure` / ③回落自建+告警），**三级均实测**（③ 用 stub 顶替 CLI 负向注入 + md5 自证零残留）；`D15` 修 HEALTH 把探针超时误判成「非交互 → GUI 不可用」→ **纯函数 `interpretHealth(h)` 三态**（非 `state==='healthy'` 一律 `unknown`）+ 退避重探（10s×≤6、预算 90s），新增 `tests/unit/setup-health-verdict.test.js` **8/8 PASS**。真机 Run1–Run3，报告 `docs/test/reports/real-test-2026-09-23{,-run2,-run3}.md`。
- **⭐ K2 修复（2026-09-24，run7 全绿 18/18）**：A2A 冷启动停滞 = lazy 单例常驻会话在服务重启/空闲回收后首调必付 codebuddy 冷启动 75–107s > 宿主 60s 有界探测。修复 = **启动期 fire-and-forget 预热**（`server.ts` 对 `kind==='llm-agent'` 调 `provider.warmup()`）：v1 复用 `runGoal` **被 `execTurn` 60s init 上限杀会话**（部署 HEALTH 实证 `lastError="…60000ms 内未收到 system/init"`）；v2 独立路径 `PersistentCliSession.warmup()`——init 上界 `warmupReadyMs`（默认 180s，env `WINVM_LLM_SESSION_WARMUP_MS`）、**超时不杀会话/不置 degraded/不写 lastError**、enqueue 串行互斥、消费 result 后判 ready、`warmupInFlight` 单飞、`CliLlmBridge.warmup()` 必须用**同一 outputDir** 构造单例。验证链：单测 482/482 → 部署 HEALTH `state=ready` → 重启后 T+~60s ready → A5 首调 **18.4s ok=true**（修复前 60.8s 超时）。报告 `docs/test/reports/real-test-2026-09-24-run7.md`。
- **⭐ 测试夹具竞态坑**：`cl018-persistent-session.test.js` 的 `makeSession` 在 spawn 后 `queueMicrotask` 发 init → `initSeen=true` 先于被测方法写消息。测「spawn→写消息→等 init」全链路（如 warmup）须 `noInit: true` 让测试行为驱动 init。
- **⭐ 部署关键事实**：`install-host.mjs:965-975` HOST 相位**自己会 `tunnel ensure`** → 整条总脚本里 TUNNEL 相位**永远走①复用**、看不到"无隧道"；验②③必须 `--phase TUNNEL` 隔离跑。
- **⭐ GUI 可用性成因**：VM 任务经 **BootTrigger（无用户会话）** 启动 → 非交互 → GUI 不可用；经 **LogonTrigger（已登录会话）** 拉起 → 交互式 → GUI 可用。故 `install-vm.mjs` 须**双触发器**。
- **Run3 终态权威 md5**：`setup.mjs`=60,345B/`cef0dcf3471809bc41f88843f1b23942`；`winvm-plugin.mjs`=`efdafd2d1e3185647b852d7be5778eb2`；`tunnel-daemon.mjs`=`4ed08c1fd63052de761423b41dc87e0b`；`oh-tunnel.mjs`=`8c397ae7eb2491626b8e398fe3b5684c`；`ssh2-resolve.mjs`=`35f1678d96144765ad50f9f439ecdcc8`；单测 `c9770f9bf8863d33e3764adec3ca654e`。

## 关键口径
- C5 三档：热态(命中)<3s｜冷启预热 ≤3s｜真采集 ≤5s。AC 时延取 `wallMs`（宿主往返），`durationMs` 留档（差 ≈330–390ms）。
- codebuddy 单次 `-p` 启动 64–107s → 根治常驻会话（stream-json + 固定 `--session-id`）。
- **测试证据口径**：每轮**只留一份权威报告** `docs/test/reports/real-test-<date>-run<N>.md`；**「未复现≠已修」**→ 必须**确定性注入**回归；FAIL 给四元组（现象/根因/证据/路由）；BLOCKED 逐例给原因；证据目录**删除必留痕**。
- **`/proc` 扫进程须精确判据**（cmdline 第 2 段以 `tunnel-daemon.mjs` 结尾）——否则会自匹配扫描命令自身、数出假实例（曾误报 3 个 daemon）。
- **证据文件「写完再读」**：读取落在写入窗口内会得到**未 flush 的 0B 假空文件**；任何"为空/缺失"结论须二次确认（mtime + 字节 + 进程存活）。

## backlog（未修）
- **K3 遗留（2026-09-28 已修主链，余 P2）**：A2A 假成功主链已修（buildSystemPrompt 审批纪律 3 条硬约束 + `reconcileApprovalWait()` 结果如实性改判，QA 全绿路由 NoOne，报告 `docs/test/reports/k3-fix-qa-2026-09-28.md`）。遗留：① 兜底是启发式（依赖 LLM 措辞），根治 = bridge 直读 MCP 结构化工具结果（更大改造）；② 建议补 reconcileApprovalWait 直接单测 2-3 条；③ `tsc -b` 须带 `tsconfig.build.json`（根目录无 tsconfig.json）；④ **仓库修复未部署**（install-host.mjs + VM 侧待跑）。
- **预热会话 idle 回收后的「深度空闲首调」**（P2·K2 边界）：预热达成的会话 5min（`idleTtlMs`）后软回收 → 深度空闲后首调仍付冷启动（设计内，K2 只覆盖「服务重启后紧随的委派」）。若需覆盖，须评估预热调度（如 idle 回收时延迟再预热）。
- **`SessionHealth` 无法表达「未知」**（P2）：`interactive/locked/blackScreen/sessionId/windowStation` 均**必填**，超时被迫填 `false/0/''`（过度断言）→ 任何只读 `interactive` 而不先查 `state` 的消费者都会重踩。建议**先做文档级**（`packages/contracts/src/bridge.ts:36-47` 注明"仅当 `state==='healthy'` 时才有意义"）；强约束（改可选 / 增 `SessionState='unknown'`）属 JSON 契约变更，须审计全部消费者。
- ~~**A2A 冷启动停滞**~~（P1 → **已修·run7 复验闭环**，见里程碑 K2 条目）。
- `winvm-plugin.mjs` 残留 3 处**打印文案** `schtasks /…`（P3，非执行路径 L527/579/584）——执行路径已改 PowerShell cmdlet（D12）。
- 非阻塞：A2A 不转发 per-call `timeoutMs`；首 spawn node 退出后残存 ~15s 自退。
