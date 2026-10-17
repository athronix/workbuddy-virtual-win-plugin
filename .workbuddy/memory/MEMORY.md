# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话复用事实；临时排查勿入。交接见 `.workbuddy/README.md` + `handover/07-migration-checklist.md`。

## 架构
宿主 WB 插件操作 Win11 VM（system/app/storage/gui/appops 五域 54 能力）。DDD+plan-first；npm workspaces 12 包，TS strict ESM，`tsc -b tsconfig.build.json`，`node --test <单文件>`。双通道：MCP 直调 `/mcp`（简单）/ A2A 经隧道 `/a2a`（复杂，streaming 审批），同隧道承载。工具名 `system.info.get`→`winvm__system_info.get`。VM Agent（`WINVM_VM_PROVIDER`）：`workbuddy-deterministic`(基准)/`workbuddy`(LLM codebuddy 常驻)/`hermes-agent`。

## 拓扑/环境
- 宿主=鸿蒙 NEXT（`process.platform` 实报 `openharmony`）；VM=Win11 `172.16.100.2`（ssh 免密用户名=**User**，以 vm-conn.json 为准，非 towyq；`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区）；VM 服务只监听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（**改 psmod/*.ps1 必须重启服务**）。
- **宿主插件缓存=运行态真相源**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` → 改 dist 必须实跑 `delivery/install-host.mjs`。
- 宿主持久化 `~/.workbuddy/winvm/{vm-conn.json,tunnel.pid,tunnel.state.json,tunnel.log}`；VM 侧 `~/.workbuddy/winvm/side.json`。
- 鸿蒙沙箱：WB uid 20020171，每 App 独立挂载命名空间+HMMAC 无 root；`$HOME`(hmdfs) 唯一跨 App 通道；跨 App `kill -0`：EACCES≠死/ESRCH=死。

## 关键坑（改码/联调前必扫）
- 远端 shell=Git Bash(MSYS)：`/` 开头参数被路径转换→远端逻辑写 `.ps1`→scp(远端路径须 `C:/…`)→`powershell -NoProfile -ExecutionPolicy Bypass -File`；载荷 ASCII 防乱码。**回向通道同理**：含中文证据**绝不用 `ssh … > 本地文件`**（控制台码页腐化 UTF-8 尾字节吞引号=非法 JSON）→ VM 侧 `[IO.File]::WriteAllText(path,$ln,(New-Object Text.UTF8Encoding($false)))` 落文件→scp 回传→JSON.parse 自证。杀隧道勿 `pkill -f 'ssh -N -L'`(自杀)→直 kill PID。
- **ssh `cmd &` 脱管**：ssh 退出后 Git Bash 后台进程**存活继续跑**且失去真相源 ⇒ VM 长观测一律前台限时或自带 PID/心跳落盘；真机窗口探针**串行化**。
- **provider=workbuddy 禁批量 tasks/cancel（真机红线）**：每个 requestCancel abort 打断同一 LLM 常驻会话当前轮⇒重建风暴⇒服务崩溃；单条 cancel ~3.4s。filler 任务=working 数分钟自然收口。
- PS 5.1：`Sort-Object <裸键>` 对 `[ordered]@{}` 静默失效→`-Property { $_.key }`。
- 沙箱：`/tmp` 只读(用 `$HOME/wbtmp`)；**git 不在 PATH 但二进制在** `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`(v2.55.0)→用全路径；`rm` shim 坏→用 `fs.unlinkSync`/`renameSync`；node 必须 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；`getcwd` 偶发异常(用绝对路径)。
- **单测绝不整批跑**→`node --test <单文件>`（`link-workspace.test.js` junction 整批触发 `0xC0000005` 假全红）。
- **注释文本也是静态守卫输入面**（`phase2-snapshot-truth` 等白名单守卫扫全仓 src 含注释）：写病灶注释引用被守卫字段名/字样前，先 grep 同名静态断言。
- **慢执行假死→熔断误判→双棒并发**：LLM 成员长静默写作期与网络致死窗口外观同形；判活看**双 timeline+git status 差异**而非只看 mtime；**同任务严禁双进程并发**。
- **Grep 工具对大文件/多词 `|` 搜索假阴性**→用目录级 grep/Read/Glob；仓库清点用 `git ls-files`/`git grep`（getcwd 失效下 FS 搜索产假象）。
- **版本指纹 > uptime**：`psBridge.uptimeMs` 只证明重启时间，证明版本须用行为/字段指纹（`/health` 开关字段、`steps[0].risk`）。
- **VM 侧运行态开关切法**：走 provider options（`.generated/vm-service.runtime.json` 的 `agent.providers.<id>.options.<key>`，provider 级浅合并、未知键保留）→ adapter 内 `opts.X ?? resolveX(process.env)`。重启只用 `kill-restart.ps1`；⚠ 顺序铁律：先部署→后打补丁→再 kill-restart（`deploy-vm.mjs --apply` 会重新生成运行时配置）。
- **GUI 可用性成因**：LogonTrigger(已登录会话)→交互式→GUI 可用；BootTrigger(无会话)→非交互→GUI 不可用。
- 隧道：VM 掉线旧隧道仍占监听→TCP 通但 HTTP 黑洞(判据 ping 100% 丢)；用 `delivery/tunnel-daemon.mjs`(进程内 ssh2+指数退避+仅绑回环+pidfile)；兜底 HOURLY watchdog `aaa87da4`。
- **VM-START TIMEOUT 真身=Node Windows SO_EXCLUSIVEADDRUSE bind EACCES**：上监听者被 kill 后 socket 未 drain，新实例重绑同端口返 **EACCES 非 EADDRINUSE**；解药=清全持有者(18443 全状态+vm-service node+ps-bridge)+**递增等待 drain(12/24/36/48s)**+循环重试(`qa/p3-batch-sweep/m6-restart.ps1`)。**诊断铁律：先 netstat 全状态+前台直跑读 stderr 定性，勿凭"占用"直觉猜**（曾被 netsh excludedportrange 证伪）。
- **ps-bridge spawn 只挂 exit 无 error 会打挂 vm-service** ⇒ **凡 spawn 子进程必同时挂 exit+error**（二者互斥非冗余）。
- `/proc` 扫进程须精确判据(cmdline 第2段以 `tunnel-daemon.mjs` 结尾)防自匹配假实例。
- ssh `schtasks /run` 会拖死通道（实测 34min）→ 改经隧道轮询 `/health` 判翻转。
- **winget 经 SSH 非交互会话“拒绝访问”**（MSIX App Execution Alias，多次复现）→ 真卸载类实弹需桌面会话，非交互窗不可达，勿强造。
- 改源必即 `tsc -b`（dist 陈旧会让测试吃旧产物假红/假绿）。

## 里程碑（压缩）
CL-015鸿蒙适配｜CL-016审批闸UX｜CL-017 5域×2通道E2E 18/18｜CL-018常驻会话｜CL-019缓存新鲜度/routeMetric｜CL-020全通道采集+隧道生产化｜CL-021 R17审批卡原生渲染+诊断+K6。
- **Phase 2 收官(10-12)**：T1–T12+T3b 交付；T11 守卫基建四件套+GATE-POLICY「跳过门禁即未验收」；QA IS_PASS=YES（92/1889）。
- **Phase 3(10-13~14)**：批0文档止血→批6深债四件；真机 E2E 16/16 PASS(P0-4 收口)；用户五裁项入库。批1 审批闭环 P0-1 收官：新契约码 `DELEGATION_REQUIRED`(retryable=false)按通道事实(isInnerDelegation=dtid∨协调器活动委派槽,不可自报,全fail-safe)收口；双闸 evaluateScoped 单点+三调用点；判源 `maxRiskSource==='agent'`；灰度 `WINVM_POLICY_GATE_WIRING` 缺省 shadow。**教训**：动传输/配置形态先 grep 断言面（src=vmagent 方案被 LEGACY_OUT 38 处逐字节守卫挡死）；执法单点定服务层。
- **Phase 4 再审计(10-14)→批10 完赛(10-15)**：P1×3+P2×6 全销账，基线 116/2103 GREEN。N-1 分发未跟批（仓库≠分发真相源）、N-5 文档教不存在的 `tasks/resubscribe`（真实通路=client.replyApproval→message/send data→continueTask→resolveApproval）、N-2 错误码表 vs errors.ts 封闭集漂移（同病三次）。
- **Phase 5(10-15~16)**：批11-14 + 残项（capability.list 名实、skip 档、V19 定性→C0）+ **C0 转呈面专项**（`foldK6Verdict` 把 `data.success===false` 翻转为 `ok:false/isError:true/EXECUTION_FAILED/K6_VERIFY_FAILED`，在 `receiptCache.record` 前折叠⇒K5/重放转呈/哈希链同源诚实）；QA 回归 IS_PASS=YES（三组变异反证 6/1/1 红还原全绿）；**基线 121 件/2162 例 GREEN**（`qa/p3-batch-sweep/gate-p5-c0-final.txt`）。批14 执法通道化：`install-vm.mjs --policy-gate-wiring off|shadow|on`（注入 start-hidden.ps1 **赋值区**，须 env 行号 < Start-Process 行号）+ DEPLOYMENT.md §1.7/1.8 runbook。
- **Phase 6(10-16~)**：第二轮全景 `docs/audit/2026-10-16-panorama-phase6.md`；批15 宿主跟批闭合（SKILL 真实落点=`~/.workbuddy/connectors/skills/connector-winvm/`，跟批判据 `git diff --no-index` 逐字节 IDENTICAL）；批16 V20 观察窗收口（三轮真委派暴露实弹级 N-5 委派呈报失真：服务端已执行并写诚实 K6 折叠回执、任务层却报"未匹配到模板"、链上 err 被顶替 `UNKNOWN_CAPABILITY`；C0 真机复验那轮 seq=6 即同路径⇒稳定复现非偶发）；批17 决策族 7 项经用户裁决全按建议处置→**批18 完赛**（commit 398d5ba）。
- **批18(10-17)**：D-6 根治——`shouldDegrade` 命中 D4.4 前先经既有 `DelegationTruthProbe.delegationActivity` 反查（同 K-N1 接口/账本/traceId 键，不增契约面）：`total>0` 抑制降级+终态透传服务端活动事实与 LLM 真实码（steps 全翻 ok:false，sink 回传 D-6 状态）；`total=0` 照常降级但 summary 必带 `（LLM 侧收口：<code>[/<reason>]）`+`error.details.degradedFrom*`；probe 缺席/抛错 fail-open ⇒ 真机 V20 达成（stepCount 0→1、err→`REPLAY_FAILED`），destructive"已执行却报未匹配"静默窗消除；D-5 ready 超时默认 60s→**180s** 与 WARMUP 对齐（真机 restarts=0、首调 49278→12858ms）；D-7 失败站点 `matchedRule` 由 error.code 订正为 `runtime:execution-failed`（错误语义归 `result.errorCode` 独立承载）；D-1/D-2 backlog 陈旧销账（schema enum/pattern 早已含 appops 且有反向守卫钉"运行期不接"；`phase2-approval-wait-fallback.test.js` 24 例即"要补的单测"）；D-3/D-4 固化 SECURITY-GOVERNANCE §4.6（链存归因不存全量载荷）/§4.7（deterministic 不挂起）；N-6 定性=设计行为非缺陷（多未决审批取最旧一条改判，其余 warn+details.others 透出）。
- K2 预热 `provider.warmup()`（`WINVM_LLM_SESSION_WARMUP_MS` 默认180s）；K3 假成功根治（shadow 门控 `reconcileApprovalWait`，灰度 `approvalTruth`）；S-4 POLICY_DENIED 零审计已修（注入 `recordPolicyDeniedAudit`）；A5/K-N1/K-N2 均有 `r19c-*` 单测覆盖。

## 关键口径
- **测试基线权威源 = `qa/` 最新 `gate-*.txt` 汇总行**（README/06-OVERVIEW 静态数字已废）。当前 **124 文件 / 2179 例 GREEN**（`qa/p3-batch-sweep/gate-p6-b18-final.txt`；2 skip 恒 ssh2-resolve OFFLINE_SKIP）。Q3 起 sweep = `tests/unit/**` + `delivery/__tests__/**`。门禁=`npm run gate`/`gate:quick`/`lock-probe`。
- 测试证据：每轮只留一份权威报告 `real-test-<date>-run<N>.md`；「未复现≠已修」须确定性注入回归；FAIL 给四元组(现象/根因/证据/路由)；证据目录删除必留痕。
- 裁决必须落档再引用：权威层级=仓库文档>任务板>聊天；文档引用以锚点段标签为主、行号为辅（并行改动行号漂移）。
- 证据文件「写完再读」：写入窗口内读会得 0B 假空→任何"为空/缺失"须二次确认(mtime+字节+进程存活)。

## 团队/A2A 派发纪律
后台 worker「completed 通知」与「SendMessage 回报」异步分离→fresh Agent+极窄任务书+每逻辑单元即 commit+主理人按 HEAD 独立核验；**同任务严禁双进程并发**；只读任务也须指定增量落盘文件(绝对路径)+每节结论即 commit。

## backlog（未修·P2）
- `SessionHealth` 无法表达「未知」→ 先文档注明"仅 state==='healthy' 才有意义"（**唯一待用户裁项**）。
- 真实 GUI 自动化点击端到端回归受远端锁屏限制。
- 深度空闲冷启动 ~49.3s 仍存在（K2 预热只覆盖重启后紧随委派）；D-5 已把判死阈值提至 180s ⇒ 不再误杀，但首调延迟本身未消除。
- K3 兜底仍为启发式（依赖 LLM 措辞）；批18 裁**保留**作 fail-safe，根治=bridge 直读 MCP 结构化结果，暂缓。
- R4 根治=B3 实测(commit 7e5e6c1)：误开 enforceBearer 实况=VM 内回连 401 打在工具面⇒委派**零副作用虚假完成**，非"当场 401"；文档六处已订正，待补 bearer 生效自检。
- ~~teams 非 winvm 残骸 45 个~~ → **已于 Phase2(10-12) 用户终裁永久不动**（`phase2-arch-design.md` §7-③"一律不动（永久纪律）"，后续任何批次不得触碰 `~/.workbuddy/teams` 非 winvm 域）⇒ 非待裁项。
