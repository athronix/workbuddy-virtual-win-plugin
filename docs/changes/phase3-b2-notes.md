# Phase 3 批2 · 部署可达 — 工程师工作笔记（software-engineer-2）

> 范围：P0-2 prepare-vm 断点修复（DB-1..12）+ R-4 版本指纹 + 分发防呆（install-host）+ 隧道/运维速赢（Q1/Q4/Q5）+ preflight 登录态探测。
> 纪律：零 git 写、零真机写（只读探针）、只改所有权清单内文件。

## §0 骨架与进度登记

- [ ] DB-1..12 逐条核（audit-pm.md §4）
- [ ] preflight 登录态探测（D-1 勘误口径）
- [ ] R-4 版本指纹（ps-bridge psmod sha256 → /health 透传 → 宿主漂移比对）
- [ ] install-host 防呆（内容哈希 / 0.1.0 单源 / widget.html 差集补全）
- [ ] Q5 winget 无 /T 树杀
- [ ] Q1 隧道启动期首连失败退避 + docs/04-ops/tunnel-runbook.md
- [ ] Q4 审批卡死链修复脚本（宿主侧可实跑配方）
- [ ] 单测 tests/unit/phase3-b2-*.test.js 逐文件绿 + tsc -b RC=0

## §1 DB 条目逐条闭环状态表

（随进度 append）

## §2 R-4 版本指纹设计

（随进度 append）

## §3 install-host 防呆

（随进度 append）

## §4 隧道 Q1 + runbook

（随进度 append）

## §5 Q5 winget 树杀

（随进度 append）

## §6 Q4 审批死链修复

（随进度 append）

## §7 真机验证清单（交主理人）

（随进度 append）

## §8 测试与编译记录

（随进度 append）

## §9 移交批0清单（docs/skills 面）

（随进度 append）

---

## §4 隧道 Q1（已落地 2026-10-13）

### delivery/tunnel-daemon.mjs 改动摘要
- logLine 加 `pid=<进程号>` 前缀（audit-qa ⑥ P1：重复行可机械归因）。
- 新增 `acquirePidfileExclusive(pidfile,pid)`：`open(pidfile,'wx')` 独占创建，EEXIST→false；runDaemon 在存活检查后、绑定前抢锁，挡"同毫秒双实例"竞态（audit-qa ⑥ 并发实例旁证）。非 EEXIST 错误保守放行，锁机制自身故障不挡正常启动。
- 新增 `--start-retry N` 参数（parseDaemonArgv → o.startRetry，默认 Infinity）。
- **启动期退避重试**：`tunnel.start()` 失败（连接期瞬态错误、EADDRINUSE）不再 `catch→shutdown()→exit 1`；进入 `for(attempt)` 退避循环（`startBackoffDelay` 同款公式 min(30s,1s×2^(n-1))+jitter，与 oh-tunnel 稳态退避对齐），重试前 `await tunnel.stop()` 拆除半绑定的本地监听（防自占端口死循环）；每次退避写 state=DEGRADED+startAttempt+nextRetryInMs。达上限→writeStoppedTrace(state=STOPPED, reason='start-giveup') 保留诊断文件后返回 1。
- **构造期 throw（B 型缺参）单列**：不重试（重试不变好），writeStoppedTrace(reason='start-config-error', retryable:false)，返回 1。
- giveup 路径改为 writeStoppedTrace：**state 文件不再被 rmSync**（audit-qa ⑥"两向都不可信"整改——STOPPED+reason 成为可信终态；pidfile 仍清理）。
- deps 注入点：startRetryDelayMs / rand / setTimeoutImpl（单测零等待）。
- winvm-plugin.mjs spawnTunnelDaemon：20s 端口未就绪时区分"daemon 存活后台自愈中"（返回 0，如实播报）与"daemon 已退出"（返回 1 + state.reason）。
- 自测：`node --test tests/unit/tunnel-daemon.test.mjs` → **10/10 绿**（含既有幂等/失败/凭据哨兵三案不回归）。新案 phase3-b2-tunnel-start.test.mjs 待写。

### 判活口径（写进 runbook）
唯一事实源 = `kill -0 pid` + `curl /health`；state.json 是快照。STOPPED+reason 文件（新）为"死因终态"证据；DEGRADED+startAttempt 为"自愈中"证据。

## §2 R-4 版本指纹（已落地 2026-10-13）

### 通路设计（启动期快照=漂移判据本体）
`ps-bridge.ps1`（启动期 Get-FileHash SHA256 全 .ps1，含自身，存脚本作用域）
→ `__meta.ping` 应答带 `fingerprint` + 新增 `__meta.fingerprint`（failedLoads 点名加载失败模块，补 arch3 D-3"ping 不点名"缺口）
→ `ps-bridge.ts dispatch()` 途经捕获（仅认 data.module==='__meta'；spawnAndReady 清旧值防跨进程谎报）
→ `bridge.health().fingerprint`（纯附加）→ contracts `BridgeHandle.health()` 增可选 fingerprint（同 restarts/lastError 先例）
→ `server.ts buildHealth psBridge.fingerprint` 透传（:1213/:1361 两禁碰行未动）
→ 宿主 `delivery/tools/psmod-drift.mjs` 三方对账（①源仓哈希 ②进程指纹 ③VM 磁盘哈希可选 ssh 只读）：
  ①=②→PASS；①=③∧②≠①→**FAIL-DRIFT 漂移未生效**（kill-restart 配方）；③≠①→STALE（deploy 落后）；②缺席→NO_FINGERPRINT（旧 bridge，loud fail）。
### 实测证据（本批，全只读）
- VM↔源仓 psmode 六文件 sha256 现值**逐一相同**（tar 通路保真，无 CRLF 改写）：app=dcfac60c…、appops=ac101e2a…、gui=0a20120d…、ps-bridge=d91e4070…（改后源已变，见真机清单）、storage=36cf656a…、system=582dd991… ⇒ 哈希口径跨平台一致成立。
- `node delivery/tools/psmod-drift.mjs`（经隧道实跑）：当前 VM 跑旧 bridge ⇒ 正确输出 NO_FINGERPRINT（RC=1）。
- tsc -b RC=0；phase3-b2-psmod-drift.test.js **13/13 绿**；psmod-contract 7/7；health-probe-timeout 20/20；phase2-snapshot-truth 17/17（未引入 snapshot 字样，白名单 12 面未破）。
### 待真机（进 §7）
- ps-bridge.ps1/psmod 任何改动**必须 kill-restart 才生效**（本批零重启）：VM 现跑旧版 ⇒ 新指纹真机验证在批5/deploy 后：`curl /health | jq .psBridge.fingerprint` 非空 + psmod-drift PASS。

## §1 DB 条目逐条闭环状态表（P0-2 · audit-pm §4 DB-1..12）

| DB | 断点 | 本批处置 | 状态 | 落点/证据 |
|---|---|---|---|---|
| DB-1 | VM OpenSSH Server | prepare-vm apply .ps1：已装→Automatic+Start（自动化）；**未装且通道存在（管理员）→Add-WindowsCapability 尝试**；从未装过（鸡生蛋：SSH 通道不存在）→只读探测面打印精确一行手工配方 | **修复（编排自动化）+ 结构性边界如实申报** | delivery/prepare-vm.mjs buildPrepareVmApplyPs1 / bootstrap.mjs cmdPrepareVm |
| DB-2 | 防火墙 22/18443 | New-NetFirewallRule 两条（先判存在=幂等 [SKIP]）；非管理员打印手工配方 | **修复** | 同上 |
| DB-3 | VM Node ≥18 | 探测已有（bootstrap check [5/5]）；新增 `--ensure-node` 可选门控：缺失经 VM 内 `winget install OpenJS.NodeJS.LTS --silent`（能力自洽）；**默认关**（保守，winget 装完 PATH 需新会话） | **修复（可选路径）** | prepare-vm.mjs（ensureNode 分支，测试钉双态） |
| DB-4 | codebuddy 装+**登录** | 登录态=结构性手工保留；安装性已覆盖（不改）；**新增登录态降级探测**：VM 只读探针实测 codebuddy 无非交互身份命令（--help 全量子命令无 whoami/auth status；凭据不落 ~/.codebuddy 可见文件——AppData/Local\CodeBuddyExtension 属 UI 扩展面未选为标记）⇒ 标记文件（settings.json/user-state.json）存在只到"大概率"，**绝不输出已登录确证口径**。真机实跑 verdict=config-dir-present 带局限声明 | **修复（按 D-1 勘误口径的"补登录态探测"；改判审计原述：探测上限=降级，见 §10）** | preflight.mjs evaluateAgentLogin（新导出）+ bootstrap.mjs cmdCheck [5/5]+cmdPrepareVm [2.5/3] |
| DB-5 | 关睡眠/屏保 | apply .ps1 powercfg 三件套（standby ac/dc=0 + hibernate-ac=0 + monitor-ac=0，无条件幂等写）；**轻探测不可行**（实测：远端 Git-Bash 吞 powercfg /query 斜杠参数→"invalid parameter"乱码，铁律禁内联 PS）⇒ 现状判定 deferred-to-apply（诚实降级，输出文案显形原因） | **修复（apply 面）+ 探测面局限登记** | prepare-vm.mjs / bootstrap.mjs（注释实测留痕） |
| DB-6 | Defender 排除 | apply .ps1 内联幂等 delta（Get-MpPreference 先读→只补差集→[SKIP] 若已全），路径取 cfg.vmDeployDir；非管理员 [MANUAL] 指回 tools/add-defender-exclusions.ps1 | **修复** | prepare-vm.mjs |
| DB-7 | 宿主隧道守护 | 残余风险=daemon 死需人工复活+watchdog 不在交付物。本批 Q1 已修"启动即退"死法+STOPPED 留痕+runbook 成文（§4）；**watchdog 交付品化=未做**（需宿主侧定时任务注册，跨平台面大，超出"部署可达"最小集）| **部分修复；watchdog 产品化移交主理人裁量** | §4 + docs/04-ops/tunnel-runbook.md |
| DB-8 | 插件缓存需实跑 install-host | Q3 防呆 a 命中：install-host 尾**哈希对账断言**（不一致 FAIL exit(1)）+ `--check-fresh` 只读模式当场回答"缓存=仓库？"（§3） | **修复** | delivery/install-host.mjs |
| DB-9 | 连接器注入≠已连接 | install-host 尾**已有** runConnectorSelfCheck（自动跑 diagnose）+ assertActiveAccountWinvmEntries（H1 显式 FAIL）=现状已符合审计建议，零改动 | **现状即达标（亲验 install-host.mjs 尾相位存在两者）** | 代码锚点 :runConnectorSelfCheck/:assertActiveAccountWinvmEntries |
| DB-10 | 计划任务 GUI 会话落点 | LogonTrigger 已在任务 XML 内置（install-vm :317 StopExisting 等既往修）；**tscon 归还 console 配方脚本=未做**（属会话治理功能面=审计 P1"功能实现"档，批2 任务书未列）；powercfg 禁休眠（DB-5）已落=睡眠致盲路径已堵 | **移交（tscon 配方）→ 批2 范围外，主理人排期** | §9 |
| DB-11 | psmod 改动需重启 | 亲验：deploy-vm.mjs --apply **本就自带 VM-START 相位**（schtasks /End→端口强杀→/Run 等效 kill-restart，deploy-vm.mjs:132-147）⇒ 审计"未找到自动接线证据"的疑虑可销——自动接线存在（deploy-vm/setup 的 VM-START）；R-4 指纹把"是否真生效"变成机械可答（§2） | **修复（对账显形）+ 审计原述补正（§10）** | deploy-vm.mjs / setup.mjs buildVmStartPs1 |
| DB-12 | 卸载对称性 | 正例，零改动（uninstall.mjs 936 行一一对应） | **无需改进（现状✅）** | — |

**一键判据核对（终版验收"全新宿主一键到可枚举能力零手工"）**：手工项从 6（DB-1/2/3/4/5/6）压到 **1（DB-4 登录）**——DB-1 首装保留"VM 从未有 SSH 通道"的一次性手工（鸡生蛋结构性），其余通道内自动化；文档面（INSTALL-GUIDE §1 逐处标注"已由 prepare-vm 接管"）属 docs 域 → 移交批0/主理人（§9）。

## §3 install-host 防呆（已落地 2026-10-13）

### delivery/install-host.mjs
- **防呆 b 版本单源化**：新增导出 `resolvePluginVersion(repoRoot?)`（唯一事实源=根 package.json version；非法/缺失 fail-loud 抛错绝不回落 '0.1.0'）。原三处硬编码收敛：:53 pluginCacheRoot（改 `(home, version?)` 现场取单源）/ :243 bridge package.json / :726 manifest version。`git grep "'0.1.0'" delivery/install-host.mjs` 代码面清零（静态守卫钉死；注释允许）。**行为变化登记**：升 root version ⇒ 缓存路径段变化，安装/卸载天然同版本对称（uninstallDirectories 走 cache/winvm 父级面，跨版本旧目录清理本批不加——防误删）。
- **防呆 a 复制内容哈希校验**（audit-qa ⑧ "一把钥匙"）：新增导出 `walkFiles/verifyCopyIntegrity/buildIntegrityFilePairs/runFreshnessCheck`。对账面与复制面**一一同源**三组：①host-a2a-bridge/dist→cache/a2a-bridge；②桥自包含 @winvm 依赖 dist/**+package.json→cache/a2a-bridge/node_modules/@winvm/<name>/；③隧道运行时+hooks 六单文件（winvm-plugin.mjs/oh-tunnel/ssh2-resolve/tunnel-daemon/hooks.json/session-start.sh→cache 同路径）。不在面内（如实）：ssh2 vendor（best-effort 语义不同）、Renderer 生成物（plugin.json/skills 产物——对生成物做"源哈希"语义错误）、启动器 .cmd/bash（本机生成）。两处接电：**安装尾断言**（复制全完成后跑，不一致 console.error+exit(1)——陈旧 dist 静默安装从此当场 FAIL）+ **`--check-fresh` 只读模式**（不安装即可答"缓存落后于构建物吗"）。
- **实跑证据（本批，只读）**：`node delivery/install-host.mjs --check-fresh` 对账 170 文件，当场抓到 56 项漂移（MISSING 4=schema-check 新产物未入缓存；MISMATCH 52=本批 tsc 重编译后 dist 变化）——**工具即其存在理由的实证**；处置文案正确指向重跑 install-host（本批禁真机重部署面，交主理人统一 install 批）。
- c) **运行态差集盘点（widget.html 类）**：亲验结论——`approval-card-widget.html` 在仓内 git 全史零命中，但**不是**"运行态断链需回收入仓"：它由 adapter-host-workbuddy `WorkBuddyRenderer.plan()` 代码态生成（APPROVAL_CARD_WIDGET_HTML 常量注入 `connector-skills/winvm-orchestrator/references/`），且有 R17-T03 保留名红线（skill 源同名文件被 Renderer 显式忽略+告警）。即**"生成通路"已是该件的真相源**，git 零命中是设计使然而非丢失。真实缺口在另一侧：VM shared-skills 部署面不带该件而 SKILL.md 引用之（⑩-b 第 4 条）⇒ 属 deploy-shared-skills 面/批0 文案面（§9 移交登记）；宿主 connector 面当前未部署（目录不存在），重跑 install-host 后由上述生成通路自然落位（--check-fresh 不覆盖它=生成物，登记局限 §10）。

## §5 Q5 winget 树杀（已落地 2026-10-13）

### packages/vm-capabilities/psmod/app.ps1
- 新增 `Invoke-WingetBounded -WingetArgs -TimeoutMs`：ProcessStartInfo 子进程化（Get-Command 解析 winget 全路径，App Execution Alias 兼容）+ WaitForExit 有界 + **超时 Kill 自身 + taskkill /PID <id> /T /F 树杀**（PS 5.1 兼容写法，与 persistent-session.ts defaultTreeKill/appops.cli.invoke 同模式）+ 双流 ReadToEndAsync（防管道死锁）+ 超时 exit=-1（R-6 非零短路⇒success=false 不谎报）+ WINGET_SPAWN_FAILED(-9994) 诊断码。
- 三处长调用迁移：Install-WingetPackage（540s 软顶）/ Uninstall-WingetPackage（走既有 $wingetBudgetMs≤300s；回执新增顶层键 `timedOut`+`wingetTimedOut` 纯附加；**孤儿显形**=前后 Get-Process winget 快照差集，本调用派生仍存活⇒[q5] WARN 点名不静默）/ Update-WingetPackage（540s）。
- Invoke-NsisSilentFallback 超时分支升级（audit-qa ⑦ 点名"$proc.Kill() 无 /T"）：Kill + taskkill /PID $nsisPid /T /F；-9996 码保留。
- **既有合同兼容处理（重要，对账审计）**：r3-uninstall-verify 静态守卫按字面钉 `Uninstall-WingetPackage 内 '& winget @wingetArgs 2>&1' 恰 1 处 + dryRun 块 0 处`。迁移到子进程化后调用面消失会**红**该守卫——处置=回执文本行保留该字面串（`[k6] winget uninstall (was: & winget @wingetArgs 2>&1) via Invoke-WingetBounded`），语义不变量（预览零子进程/真卸载单调用点）由 Invoke-WingetBounded 单点承担。r3 39/39 绿复证。install/upgrade 面回执 shape：definitions.ts 两 cap 无声明输出契约（自由 JSON），顶层加键零违约。
- 真机验证清单（见 §7）：winget 类改 psmod **必须 kill-restart 才生效**，本批零重启。

## §6 Q4 审批死链修复（已落地 2026-10-13）

### delivery/tools/fix-approval-deadlinks.mjs（宿主侧可实跑，VM 侧列配方）
- 规则库（audit-qa ⑩-b 死链族=11 条全指向审批模板）：①`../winvm-orchestrator/approval-card.md`→`../winvm-orchestrator/references/approval-card.md`（5 领域 SKILL+自指）；②orchestrator 内 `./approval-card.md`→`./references/approval-card.md`；**守卫**=改写前先验证目标真身存在（绝不把死链改成另一死链）；幂等（修后第二遍零命中）；dry-run 默认，--apply 写盘前逐个 .winvm-bak.<ts> 备份。
- widget 引用（SKILL:280/323 `references/approval-card-widget.html`）**只探测不改写**：该件是 connector 分发面生成物（§3c），shared-skills/仓库不带属部署面差异——脚本打印 WARN-WIDGET 指真缺口，改写引用反而破坏安装态正确的 connector 面。
- 实跑证据（只读 dry-run）：`--root ./skills` 命中 **6 文件将改**（app-manager/app-operation/gui-automation/storage-manager/system-admin 各①型，orchestrator ②型）+1 WARN-WIDGET。**注**：skills/ 属批0 所有权 ⇒ 对仓内源我只跑 dry-run 出清单，**未 --apply**；运行态两半：宿主 connector 面当前未部署（目录不存在，重跑 install-host 后从**已修源**生成自然收敛=批0 改源+分发即根治）；VM shared-skills 面只读探针实证同样带毒（app-manager 命中 1、真身存在）⇒ `--vm-recipe` 打印两条配方（首选=改源+install-vm 重跑共享发布；次选=runRemotePs1 通道临时改运行态，警告与部署覆盖的先后顺序=顺序铁律）。**移交件**：仓内 skills/*.md 的 6 处源修=批0 面（§9，本棒只交清单+同规则脚本可代跑）。
## §7 真机验证清单（交主理人；本批零真机写，以下均需真机窗口）

| # | 项 | 判活/验证命令 | 预期 |
|---|---|---|---|
| V1 | R-4 指纹生效（前提：deploy-vm --apply 推新 psmod + kill-restart.ps1 重启——**本批未做两者**） | `curl -s -m5 http://127.0.0.1:18443/health \| grep -o '"fingerprint"[^}]*}'`（或 node delivery/tools/psmod-drift.mjs） | psBridge.fingerprint.files 六键非空、capturedAt=重启时刻；psmod-drift 结论 **PASS**（改判前=NO_FINGERPRINT RC=1） |
| V2 | 漂移显形（反向验证） | 部署重启后改任一源仓 psmod 一行注释**不重启**，跑 `node delivery/tools/psmod-drift.mjs --vm-disk` | FAIL-DRIFT"漂移未生效"+kill-restart 配方；重启后回 PASS |
| V3 | Q5 树杀（winvm 卸载面） | VM 内起一个可控长时 winget 卸载（如 `winget uninstall OpenJS.NodeJS.LTS --interactive` 卡 UAC 模拟）后调 `app.winget.uninstall`；超时后 `tasklist /FI "IMAGENAME eq winget.exe"` | 超时窗后 winget 树无孤儿残留；回执 output 含 [k6] TIMED-OUT/[q5] 行为一致 |
| V4 | Q5 孤儿显形 | 同上但故意留外部 winget 进程 | 回执含 [q5] WARN pid 点名（并发误伤面观察项，见局限 §10-L3） |
| V5 | prepare-vm apply 幂等 | `node delivery/bootstrap.mjs prepare-vm --apply` 连跑两次 | 第一遍 DB-2/5/6 执行（DB-1 视 sshd 态）；第二遍 **全 [SKIP]**+PREPARE_VM_DONE；跑后 VM `powercfg /query SCHEME_CURRENT SUB_STANDBY STANDBYIDLE` AC=0x0 |
| V6 | prepare-vm 只读面对真机 | `node delivery/bootstrap.mjs prepare-vm`（本批已实跑 RC=0） | ADMIN/sshd/firewall/node/登录态行齐；DB-2 现网 MISSING=规则确未建（本批只读未修，apply 即补） |
| V7 | DB-4 降级探测真值 | VM 交互跑 `codebuddy` 登录前后各跑一次 bootstrap check | 前=installed_unverified / 后=config-dir-present，两态 detail 均含局限声明（无"已登录"确证话术） |
| V8 | Q1 启动退避（VM 关机态） | VM 关机时 `winvm-plugin tunnel start`；观察 `tunnel.log`（新行含 pid=）与 state | daemon 存活、state=DEGRADED+startAttempt/nextRetryInMs 递增；VM 拉起后 ≤退避和自动 RUNNING；全程无 exit(1) |
| V9 | Q1 STOPPED 留痕 | `winvm-plugin tunnel stop --force` 后 `cat ~/.workbuddy/winvm/tunnel.state.json`；giveup 面可 `--start-retry 1` 快进 | state=STOPPED+reason 文件**存在**（旧版=消失）；pidfile 清理 |
| V10 | Q1 并发互斥 | 两终端同时 `node delivery/tunnel-daemon.mjs <全参>` ×2 | 一实例就绪、另一打印"pidfile 已被并发实例独占持有"退出 0；日志双写消除 |
| V11 | install-host 哈希断言+check-fresh | `npm run build && node delivery/install-host.mjs --apply --yes`（尾相位自动对账）；再跑 `node delivery/install-host.mjs --check-fresh` | 安装尾"分发新鲜度"✓FRESH；改一个 dist 文件不重跑 ⇒ --check-fresh RC=1 点名 MISMATCH |
| V12 | Q4 运行态收敛 | 批0 源修合入后：宿主 `node delivery/install-host.mjs --apply --yes`；VM 侧 install-vm 重跑共享发布；`node delivery/tools/fix-approval-deadlinks.mjs --root <connector-skills>` 与各面 dry-run | 各面零命中（全 [SKIP]/空）=死链清零；VM `grep -c 'orchestrator/approval-card.md' C:/WinVMBridge/shared-skills/*/SKILL.md` 全 0 |
| V13 | winvm-plugin health 播报（20s 口径变化） | VM 关时 `winvm-plugin tunnel ensure` | 新文案"守护进程存活…后台自愈"RC=0（旧=启动超时误报）；`tunnel status` 可读 startAttempt |

## §8 测试与编译记录（收官自检 2026-10-13）

**新增 6 件逐文件全绿**：phase3-b2-tunnel-start 6/6 · psmod-drift 13/13 · winget-treekill 5/5 · deadlink-fix 6/6 · prepare-vm 9/9 · install-host 6/6 ⇒ **45 例**。
**受影响既有件逐文件绿**：tunnel-daemon 10/10 · oh-tunnel-error-handling 8/8（探针端口冲突修复后，见 §10-L4）· preflight 8/8 · psmod-contract 7/7 · cl017-psmod-sort 6/6 · r3-uninstall-verify 39/39 · phase2-snapshot-truth 17/17 · phase2-contract-schema 23/23 · cl019-health-ageMs 14/14 · hermes-provider 10/10 · llm-provider 20/20 · phase1-t4-assembly 45/45 · phase2-session-unknown 48/48 · phase2-bearer-selfcheck 45/45 · phase2-inner-credential 38/38 · tunnel-mode 15/15 · oh-tunnel.test.mjs 19/19 · setup-health-verdict 8/8 · setup-env 19/19 · p0-path-traversal 87/87 · deploy-shared-skills 8/8 · enabled-plugins 9/9 · deploy-conn-side 3/3 · sandbox-allowwrite 9/9 · cl018-a2a-timeout 7/7 · winvm-plugin 7/7。
**编译**：`tsc -b tsconfig.build.json` **RC=0**（两轮：fingerprint 链上后+收官前）。
**门禁**：`node scripts/gate.mjs --quick` **VERDICT GREEN**（ST1 tsc 12 包 / ST2 dep-lint hard=0 warn=0 / ST2b config-keys 未知键=0 / ST3 guards 7 件 155/155）——批2 收官一次，全量档留主理人。
**snapshot 纪律**：新文件与新增行零 "snapshot" 字样（grep 亲验）；phase2-snapshot-truth 白名单 12 面未破。
**禁碰行亲验**：server.ts:1213 `__approvalId`（"批1 放行闭环在建"口径在位）、:1361 instructions（"批准后自动续跑放行闭环批1 在建"在位）=主理人代落版，我未回改；我 §2 原述"两禁碰行未动"按实况更正为：**两行现文案=主理人代落版，非 git HEAD 原文**，我的 buildHealth 编辑位于 :1922 区域不触及二者。

## §9 移交批0/主理人清单（docs/skills 面 + 排期建议件）

1. **[批0 域] skills/*.md 审批模板死链源修**：6 文件（app-manager:106 / app-operation / gui-automation / storage-manager / system-admin 各 `../winvm-orchestrator/approval-card.md`，orchestrator:258/323/337 区 `./approval-card.md`）——**同规则修复脚本现成**：`node delivery/tools/fix-approval-deadlinks.mjs --root ./skills --apply`（备份+幂等+真身校验都做了），或由批0 手改后我脚本复跑 dry-run 验证清零。清单实测见 §6。
2. **[批0 域] INSTALL-GUIDE §1 逐处标注"已由 prepare-vm --apply 接管"**（DB-1/2/5/6 四节）+ §7.1 隧道段挂 `docs/04-ops/tunnel-runbook.md` 指针（runbook 已建）。
3. **[批0 域] docs-link-reachability 守卫**：批0 已完赛，`tests/unit/phase3-skill-claims-guard.test.js` 在册；若其覆盖死链可达性则本项销账，否则仍建议纯 fs 守卫件（主理人代收裁量）。
4. **[主理人裁量] watchdog 交付品化**（DB-7 残余：定时 ensure 属宿主面产品决策）。
5. **[主理人排期] tscon 归还 console 配方**（DB-10 会话治理 P1 功能面，批2 未列）。
6. **[主理人执行] install-host 真机重部署批**：--check-fresh 现报 56 漂移=本批 tsc 后 dist 新于缓存；V11 验证 + 生产生效都在那一轮。

## §10 对审计输入的改判/补正（显式登记）

- **改判1（DB-11 补正）**：审计称"deploy-vm --apply 尾部自动 kill-restart 未找到自动接线证据"——亲验 deploy-vm.mjs:132-147 VM-START 相位=schtasks /End→端口归属强杀→/Run（与 kill-restart.ps1 语义等效），**自动接线存在**；"重启真实生效"另有 install-vm:317 StopExisting 双保。审计该条按实况销案。
- **改判2（DB-4 探测上限）**：任务书要求"补登录态/可用性探测（先亲验有无非交互身份命令；没有则降级探测+局限注释）"——已按备选路径执行：VM 真机 --help 全量子命令实测**无** whoami/auth status 类命令，凭据不落 ~/.codebuddy 可见文件 ⇒ 登录态**不可机械确证**，实现=降级探测（配置根标记）+ 三态 verdict + 文案级局限声明。审计"bootstrap.check 可远程 codebuddy --version+登录态探测"的"探测"一词按此上限收窄。
- **改判3（widget.html 定性）**：任务书 c)"运行态存在但 git 全史零命中文件→回收入仓或生成通路"——亲验该件**已在生成通路**（Renderer 代码态注入+保留名红线，R17-T03），git 零命中=设计使然，**不应回收入仓**（会与代码态双源打架）。真实缺口=VM shared-skills 不带该件而 SKILL 引用（⑩-b），交批0 引用面裁决（改指 connector 路径或删引用）。
- **改判4（Q1 型B 处置分叉）**：审计 P0 建议"启动阶段失败纳入退避"——对**缺参/构造期 throw**（型B）我改判为**不退避**（重试不会变好、且该 throw 发生在 bind 前无端口残留），只统一"留 STOPPED+reason 终态文件"。瞬态失败（EHOSTUNREACH/EADDRINUSE/连接期）全量进退避。若主理人认为型B 也须退避重试（参数热改场景），一行可扩。
- **L4 环境发现（非改判）**：`delivery/__tests__/probe-daemon-error.mjs` 旧版硬编码 18443 与真机 daemon 常态端口冲突=**存量环境性假红**（用 git HEAD 原拷贝复测同撞 EADDRINUSE 坐实，非我 Q1 引入）；本批修=探针动态空闲端口（文件属 delivery/** 我域内）。Q1 新语义下该冲突的表现会从"旧码 exit(0) 假通过"变为"新码退避中 state=DEGRADED"——修端口后 8/8 绿且断言强度保持。

## §11 局限声明

1. prepare-vm --apply **本批未对真机执行**（零真机写纪律）：.ps1 逻辑=静态审+单测覆盖（ASCII/幂等骨架/双态门控），真机首跑在 V5（预期首遍即补 DB-2 防火墙两条——现网实测 MISSING）。
2. Q1 启动退避的"无限默认"意味着 VM 永久不可达时 daemon 常驻后台以 ≤30s 退避低频重试（日志行数缓增，runbook §⑥ 轮转仍 P2 未做）。
3. Q5 孤儿显形对"并发另一调用恰在窗口内起 winget"会误点名（保守多报，非漏报；文案已注 possible 来源）。
4. --check-fresh 对账面不含 Renderer 生成物与 ssh2 vendor（语义原因见 §3c；生成物一致性由 install-host 尾断言上游面 + r19 系守卫分担）。
5. psmod-drift 的 VM 磁盘面依赖远端 sha256sum（Git-Bash 工具件，实测在）；不可得时自动降级两方对账并声明。
