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
- **注释文本也是静态守卫输入面**（`phase2-snapshot-truth` 等白名单守卫扫全仓 src 含注释；`phase2-session-unknown` E5 还钉禁四份活文档出现裸表述「仅 state==='healthy' 才有意义」）：写病灶注释、**乃至向用户提的裁决建议措辞**，引用被守卫字段名/字样前，先 grep 同名静态断言（批19 建议措辞即因此返工）。
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
- **批18(10-17)**：D-6 根治——`shouldDegrade` 命中 D4.4 前先经既有 `DelegationTruthProbe.delegationActivity` 反查（同 K-N1 接口/账本/traceId 键，不增契约面）：`total>0` 抑制降级+终态透传服务端活动事实与 LLM 真实码（steps 全翻 ok:false，sink 回传 D-6 状态）；`total=0` 照常降级但 summary 必带 `（LLM 侧收口：<code>[/<reason>]）`+`error.details.degradedFrom*`；probe 缺席/抛错 fail-open ⇒ 真机 V20 达成（stepCount 0→1、err→`REPLAY_FAILED`），destructive"已执行却报未匹配"静默窗消除；D-5 ready 超时默认 60s→**180s** 与 WARMUP 对齐（真机 restarts=0、首调 49278→12858ms）；D-7 失败站点 `matchedRule` 由 error.code 订正为 `runtime:execution-failed`（错误语义归 `result.errorCode` 独立承载）；D-1/D-2 backlog 陈旧销账（schema enum/pattern 早已含 appops 且有反向守卫钉"运行期不接"；`phase2-approval-wait-fallback.test.js` 24 例即"要补的单测"）；D-3/D-4 固化 SECURITY-GOVERNANCE §4.6（链存归因不存全量载荷）/§4.7（deterministic 不挂起）；N-6 定性=设计行为非缺陷（多未决审批取最旧一条改判，其余 warn+details.others 透出）。**批19 开**（10-17）：T1 SessionHealth 文档注明执行完（销账模式，见 backlog 区；第三例 stale backlog）。**批20**（10-17）：4 项技术债修复（software-company 团队 SOP，PM→工程师→QA 快速模式路由）——K3/bearer 为第 5、6 例 stale backlog 销账（根治早已缺省在网：`APPROVAL_TRUTH_DEFAULT='on'`、P2-T5/T6）、GUI 锁屏定性不可代码修复（§5.4 过期注释订正+E2E 人工配方）、冷启动用户裁保持 TTL 5min 转观察项；零 src 改动，gate GREEN 124/2179。
- K2 预热 `provider.warmup()`（`WINVM_LLM_SESSION_WARMUP_MS` 默认180s）；K3 假成功根治（shadow 门控 `reconcileApprovalWait`，灰度 `approvalTruth`）；S-4 POLICY_DENIED 零审计已修（注入 `recordPolicyDeniedAudit`）；A5/K-N1/K-N2 均有 `r19c-*` 单测覆盖。
- **REL-V1.4.0 发布（10-18）**：tag `V1.4.0`@381d2d8 已推 origin；`delivery/pack-release.mjs` 产出 `release/V1.4.0/{host,vm,overall}` 三包（闭包推导+一键脚本+MANIFEST sha256+包内 V1-V4 验证；`--skip-build`：包内 dist 已指纹且不含 src/tsconfig/tsc）。真机：run1 暴露 I-1.1（VM 闭包漏 `vm-service.config.json`——install-vm 的**非 import 硬依赖**，dry-run 盲区）→ 修复（39357f8 + PACKAGE_REQUIRED 结构断言）→ run2 全相位过 + 验证矩阵 7 项全过（54 能力/双通道/审计链）⇒ 用户裁定发布迭代铁律：**每次迭代重部署前必须清空历史部署**（run2 未清场 ⇒ run3 以 `--wipe` 重做闭环，验证矩阵 7 项在清空重装态全过）。台账 `docs/release/issues.md`（版本→迭代）。
- **REL 迭代2（10-18，OBS-1 关闭）**：TUNNEL 相位旧判据 `st.healthy`（daemon 自报）直接放行复用、未探后端 ⇒ 黑洞漏到 HEALTH 才炸。修复（23fa078）：`evaluateTunnelReuse` 纯函数——**后端 /health 打通=唯一硬判据，daemon 自报态仅作信息**；复用路径先探后端（黑洞嫌疑明示日志+转 daemon 恢复）；ensure 后判据同步收紧（r.ok 时 2s 快重试）。**it2 真机实弹**：uninstall 杀旧 daemon(16136)后看门狗抢拉起新 daemon(34812) 自报 RUNNING 但 VM 服务刚重装未起 ⇒ 新判据当场捕获黑洞、ensure 0.3s 恢复打通（旧码会直接放行）。清空重装（--wipe，17 项 checklist 全 PASS）七相位过 + 验证矩阵 7 项全过；门禁 124/2185 GREEN（gate-rel-v1.4.0-it2.txt）。it1 旧包改名保留 `release/V1.4.0.superseded-it1`。
- **REL 迭代3（10-18，清场强化）**：用户纪律「uninstall 前先查杀 VM 端本项目看门狗与 services」内建进 `uninstall.mjs` `buildVmPs1` 段0（db3491e）：`/End` 熔断任务级看门狗（RestartOnFailure PT1M×3 重启窗口）→ `Kill-Sig` 三签名查杀 services（vm-service node 按命令行签名/排除 $PID 绝不按 exe 路径——node 与 WorkBuddy MCP 共享防误杀；**ps-bridge 孤儿显式覆盖**——vm-service 先死时脱树占 18443 致重装 VM-START bind EACCES）→ `/Delete` 拆注册 → 兜底复查。载荷 ASCII-only（PS 5.1 无 BOM 乱码坑，初稿中文注释中招）。`buildVmPs1` export 供单测直接断言生成物（+8 例）。**run4 真机**：新结构逐字生效、17 项 checklist 全 PASS、黑洞场景再现并被正确处置、矩阵 7 项全过；门禁 GREEN 124/2193。it2 旧包保留 `release/V1.4.0.superseded-it2`。
- **REL 迭代4（10-19，GitHub Release 分发链）**：目标=新机一切从 GitHub 开始。交付（software-winvm-release 团队 SOP）：①仓库 **private→public**（匿名下载成立；设备码 gh OAuth token 在 `~/.config/gh/hosts.yml`，scope=repo）；②pack-release 增 zip 资产 `winvm-overall-<ver>.zip`（zip -qr 保执行位）+旁挂 `.zip.sha256`（sha256sum -c 兼容）+**zip条目集⊆MANIFEST∪{MANIFEST.txt} fail-loud 断言**（QA 缺陷#1 根治：run4 曾在包目录内实机部署致 .env/shim 卷入重打的 zip——public 即泄真机配置；**教训：包目录=部署现场，重打包前必清运行残留**）；③`delivery/publish-release.mjs` 幂等上架 Release（dry-run 默认/双资产 DELETE-先于-POST/token 三源绝不打印）；④`tools/winvm-prepare.ps1` 单一真相源（八核心键恒定输出+SSH_PORT 附加+未知键忽略·Q-6 裁决；G1 公钥双文件+icacls）；⑤`docs/deploy/铠大师app功能规格书.md` V1.2（K1-K3=F-01~05 P0/契约 C-1~5/M1-M3；prompt 含公钥摆渡子句 Q-1+bash 前缀 Q-4+WINVM_DRY_RUN=0 硬断言）。门禁 GREEN **126/2229**（it7=QA 复验权威；publish-release 27+winvm-prepare-ps1 9 入 ST3 双写表）。QA 两轮回归 IS_PASS=YES（变异自证反恒真有效）。
- **发布迭代纪律（用户 2026-10-18 三条裁定）**：① 每个迭代重新部署前必须清空历史部署（`deploy-all.sh --wipe`）；② uninstall 必须先查杀 VM 端本项目看门狗与 services 再清场（已内建 `uninstall.mjs` VM 段：/End 熔断→Kill-Sig 三签名(node/start-hidden/ps-bridge 孤儿)→/Delete→兜底复查）；③ 迭代完成后 commit 必须 push origin（github.com:athronix/workbuddy-virtual-win-plugin，SSH 通路已验证）。

## 关键口径
- **发布迭代铁律（用户 2026-10-18 裁定，强制执行）**：**每个迭代重新部署新版本前，必须清空历史部署**——`release/V<ver>/overall/deploy-all.sh --wipe`（双端 uninstall，宿主持久化与 VM C:/WinVMBridge 入回收站可恢复，VM 的 WinVMWorkspace 默认保留）。不清场的重装只是"补部署"，不构成迭代验收；验证矩阵必须在该迭代的清空重装态上取数。
- **测试基线权威源 = `qa/` 最新 `gate-*.txt` 汇总行**（README/06-OVERVIEW 静态数字已废）。当前 **126 文件 / 2229 例 GREEN**（`qa/p3-batch-sweep/gate-rel-v1.4.0-it7.txt`；2 skip 恒 ssh2-resolve OFFLINE_SKIP）。Q3 起 sweep = `tests/unit/**` + `delivery/__tests__/**`。门禁=`npm run gate`/`gate:quick`/`lock-probe`。
- 测试证据：每轮只留一份权威报告 `real-test-<date>-run<N>.md`；「未复现≠已修」须确定性注入回归；FAIL 给四元组(现象/根因/证据/路由)；证据目录删除必留痕。
- 裁决必须落档再引用：权威层级=仓库文档>任务板>聊天；文档引用以锚点段标签为主、行号为辅（并行改动行号漂移）。
- 证据文件「写完再读」：写入窗口内读会得 0B 假空→任何"为空/缺失"须二次确认(mtime+字节+进程存活)。

## 团队/A2A 派发纪律
后台 worker「completed 通知」与「SendMessage 回报」异步分离→fresh Agent+极窄任务书+每逻辑单元即 commit+主理人按 HEAD 独立核验；**同任务严禁双进程并发**；只读任务也须指定增量落盘文件(绝对路径)+每节结论即 commit。

## backlog（未修·P2）
- ~~SessionHealth 无法表达「未知」~~ → **批19 销账**：E-2（P2-T9）早已以 `probeError`/`probeErrorCode` 三码（PROBE_NOT_WIRED/TIMEOUT/EXCEPTION）根治「未知」表达并三处载明（SECURITY §5.3 / INTERFACES IF-6 / 契约注释）；批19 按用户裁决以**准确措辞**补 IF-6 消费者注（state 四值均有效观测、无 unknown 枚举系 B6 设计裁定、不得把非 healthy 反推为未知）——原建议裸表述「仅 state==='healthy' 才有意义」被 E5 静态守卫钉禁（未兑现临时口径），见 `docs/changes/phase6-b19-notes.md`。
- ~~真实 GUI 自动化点击端到端回归受远端锁屏限制~~ → **批20 定性**：锁屏态=Winlogon 安全桌面，会话内进程无法合成输入解锁（Windows 安全边界）+ tscon 需管理员提升 ⇒ **不可代码修复**；批20 已订正 §5.4 过期注释（"工具面无 sessionId 数据源"不成立——sessionId 契约必填且 /health 透出）并补 E2E 前置人工配方（powercfg 禁休眠/待机+屏幕保护+/health.session.state==='healthy' 前置门）；P2 观察项=E2E preflight 早失败钩子。
- 深度空闲冷启动 ~49.3s：**批20 用户裁定 idle TTL 保持 5min（300_000）不变** ⇒ 冷启动定性为 TTL 回收语义的固有代价（codebuddy CLI 进程级冷启动，外部特性不可根除）；D-5 的 180s 判死阈值已保证不误杀；保活机制列 P2 观察（未评估副作用：串行链排队可能增加首调延迟）。
- ~~K3 兜底仍启发式~~ → **批20 销账**：根治早已兑现——`reconcileApprovalTruth` 服务端审批账本结构化反查（delegation-truth.ts）+ P2-T8 归属键放宽 `taskId ?? traceId` + `WINVM_APPROVAL_TRUTH` 缺省 **on**（constants.ts:316）；文本兜底按用户裁决（SK-9）保留作 fail-safe；SECURITY §3.3 已固化运营观测口径（decidedBy='text-fallback' 计数=兜底命中率，长期观察项）。
- ~~R4 待补 bearer 生效自检~~ → **批20 销账**：P2-T5（commit d277882）已落地挂载自检五码+innerReconnect 三态+fail-closed 拒启+链上取证（45 例；http-guard.ts:179 `runBearerMountSelfCheck`、server.ts:830-943 装配）；P2-T6（e0b6945）补齐回连凭据通路；B3 两段式实况（7e5e6c1）与文档六处订正在册。
- ~~teams 非 winvm 残骸 45 个~~ → **已于 Phase2(10-12) 用户终裁永久不动**（`phase2-arch-design.md` §7-③"一律不动（永久纪律）"，后续任何批次不得触碰 `~/.workbuddy/teams` 非 winvm 域）⇒ 非待裁项。
