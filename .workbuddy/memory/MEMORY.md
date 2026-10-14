# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话复用事实；临时排查勿入。交接见 `.workbuddy/README.md` + `handover/07-migration-checklist.md`。

## 架构
宿主 WB 插件操作 Win11 VM（system/app/storage/gui/appops 五域 54 能力）。DDD+plan-first；npm workspaces 12 包，TS strict ESM，`tsc -b tsconfig.build.json`，`node --test <单文件>`。双通道：MCP 直调 `/mcp`（简单）/ A2A 经隧道 `/a2a`（复杂，streaming 审批），同隧道承载。工具名 `system.info.get`→`winvm__system_info.get`。VM Agent（`WINVM_VM_PROVIDER`）：`workbuddy-deterministic`(基准)/`workbuddy`(LLM codebuddy 常驻)/`hermes-agent`(config.yaml.mcp_servers 预注册)。

## 拓扑/环境
- 宿主=鸿蒙 NEXT，`process.platform` 实报 `openharmony`；VM=Win11 `172.16.100.2`（ssh 免密用户名=**User**（vm-conn.json 为准，非 towyq）；`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区）；VM 服务只监听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（**改 psmod/*.ps1 必须重启服务**）。
- **宿主插件缓存=运行态真相源**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`（真实副本）→ 改 dist 必须实跑 `delivery/install-host.mjs`。
- 宿主持久化 `~/.workbuddy/winvm/{vm-conn.json,tunnel.pid,tunnel.state.json,tunnel.log}`；VM 侧 `~/.workbuddy/winvm/side.json`。
- 鸿蒙沙箱：WB uid 20020171，每 App 独立挂载命名空间+HMMAC 无 root；`$HOME`(hmdfs) 唯一跨 App 通道；跨 App `kill -0`：EACCES≠死/ESRCH=死。

## 关键坑（改码/联调前必扫）
- 远端 shell=Git Bash(MSYS)：`/` 开头参数被路径转换→远端逻辑写 `.ps1`→scp(远端路径须 `C:/…`)→`powershell -NoProfile -ExecutionPolicy Bypass -File`；载荷 ASCII 防乱码。杀隧道勿 `pkill -f 'ssh -N -L'`(自杀)→直 kill PID。
- **ssh `cmd &` 脱管（T7 实证双坑）**：ssh 退出后 Git Bash 后台进程**存活继续跑**，且"谁在跑什么"失去真相（成员对自家前轮 burst 探针失认）⇒ VM 长观测一律前台限时、或脚本自带 PID 落盘+心跳文件；真机窗口探针**串行化**。
- **provider=workbuddy 禁批量 tasks/cancel（T7 真机红线）**：每个 requestCancel abort 打断**同一 LLM 常驻会话**当前轮⇒重建风暴⇒服务崩溃（实测 198×并发8 打挂+~90 孤儿 node）；单条 cancel 端到端 ~3.4s。filler 任务实况=working 数分钟自然收口（LLM 纯文本答完，非确定性执行器快速 failed）。
- PS 5.1：`Sort-Object <裸键>` 对 `[ordered]@{}` 静默失效→`-Property { $_.key }`。
- 沙箱：`/tmp` 只读(用 `$HOME/wbtmp`)；**git 不在 PATH 但二进制真实存在** `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`(v2.55.0)→用全路径 commit/log/show；`rm` shim 坏→用 `fs.unlinkSync`/`renameSync`；node 必须 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；`getcwd` 偶发异常(用绝对路径)。
- **单测绝不整批跑**→`node --test <单文件>`（`link-workspace.test.js` 的 junction 整批触发 `0xC0000005` 假全红）。
- **注释文本也是静态守卫输入面**（Phase1 T1 D-5：`r19c-a5` C3 全仓扫源码含注释的标识符计数；T8 活例：delegation-audit 注释含 DelegationTerminalSnapshot 字样触 `phase2-snapshot-truth` 白名单守卫=全仓 src 大小写不敏感扫 snapshot 命中文件集须恰 12 白名单，名单外任何新文件含 snapshot 字样即红）：写病灶注释引用被守卫的字段名前，先 grep 同名静态断言。
- **慢执行假死→熔断误判→双棒并发（T8 新型）**：LLM 成员 step4 长静默写作期（闷头写码 20+ 分钟零落盘）与网络致死窗口外观同形；重派后旧棒可能自察复活⇒违反"同任务严禁双进程并发"。预防=任务书内置"每文件编辑即 timeline 心跳"；判活优先看**双 timeline+git status 差异**而非只看 mtime；已发 shutdown 后翻 timeline 必须复核（shutdown_request 可撤回改指令）。
- **Grep 工具对大文件/多词 `|` 搜索假阴性**→用目录级 grep / Read / Glob；仓库清点用 `git ls-files`/`git grep` 而非 FS find/grep（getcwd 失效下 FS 搜索产假象）。
- **版本指纹 > uptime**：`psBridge.uptimeMs` 只证明重启时间，证明版本须用**行为/字段指纹**（如 `/health` 开关字段、`steps[0].risk`）。
- **VM 侧运行态开关切法**：走 provider options（`.generated/vm-service.runtime.json` 的 `agent.providers.<id>.options.<key>`，provider 级浅合并、未知键保留）→ adapter 内 `opts.X ?? resolveX(process.env)`。重启只用 `kill-restart.ps1`（不重跑 install-vm）；⚠ `deploy-vm.mjs --apply` 重新生成运行时配置⇒顺序铁律：先部署→后打补丁→再 kill-restart。
- **GUI 可用性成因**：VM 任务经 LogonTrigger(已登录会话)→交互式→GUI 可用；BootTrigger(无会话)→非交互→GUI 不可用。
- 隧道：VM 掉线旧隧道仍占监听→TCP 通但 HTTP 黑洞(判据 ping 100% 丢)；用 `delivery/tunnel-daemon.mjs`(进程内 ssh2+指数退避+仅绑回环+pidfile；无 `--daemon` 直接跑即常驻)；兜底 HOURLY watchdog `aaa87da4`。
- **VM-START TIMEOUT 真身=Node Windows SO_EXCLUSIVEADDRUSE bind EACCES**(Phase3 批4 亲验)：上监听者(含继承 18443 句柄的 ps-bridge 子 powershell)被 kill 后 socket 未 drain，新实例重绑同端口返 **EACCES 非 EADDRINUSE**；`start-hidden.ps1` 的 Wait 500ms 必不够。解药=清全持有者(18443 全状态+vm-service node+ps-bridge)+**递增等待 drain(12/24/36/48s)**+循环重试(`qa/p3-batch-sweep/m6-restart.ps1` 可复用；本窗 attempt2 即恢复)。**诊断铁律：Windows 端口重启故障先 netstat 全状态+前台直跑读 stderr 定性 EACCES/EADDRINUSE/EPERM，勿凭"占用"直觉猜幽灵进程/保留区间**(曾被 netsh excludedportrange 实测证伪)。
- **ps-bridge spawn 只挂 once('exit') 无 'error'**(Phase3 批5-Q3 修)：Windows spawn ENOENT/EACCES(自愈重建 PATH 竞态/杀软隔离)Node 只发 error 不发 exit ⇒ 未捕获异常可**打挂 vm-service**+pending 悬挂，"自愈"反成崩溃源。修=spawned.once('error') 折叠同族收口(failAll PSBRIDGE_SPAWN_FAILED+比对 spawned 清 child 防误清新进程)。**通用红线：凡 spawn 子进程必同时挂 exit+error 监听，二者互斥非冗余**。
- `/proc` 扫进程须精确判据(cmdline 第2段以 `tunnel-daemon.mjs` 结尾)防自匹配假实例。

## 里程碑（压缩）
CL-015鸿蒙适配｜CL-016审批闸UX｜CL-017 5域×2通道E2E 18/18｜CL-018常驻会话｜CL-019缓存新鲜度/routeMetric｜CL-020全通道采集+隧道生产化｜CL-021 R17审批卡原生渲染+诊断+K6。
- **Phase 2 收官(2026-10-12)**：T1–T12+T3b 全部交付（§13.1–13.12）；T11 守卫基建四件套（dep-lint/config-key-lint/gate/lock-probe+GATE-POLICY「跳过门禁即未验收」）；QA 严过关终判 **IS_PASS=YES**（92/1889 双路径闭合，终态基线）；提交链 928f437(T8)→349ecc2(T9)→d1d34a6(T11)→2a11337(close)。**T13 候选在册未定夺**：audit-20260918.jsonl 断片（链断非篡改，analyze.out 定位 entry#512 prevHash 指错；Phase 1 已建 verifyArchive 片内校验框架可承载处置批）。winvm 停摆团队残骸已清 35 个（留痕 qa/r19/p2close-teams-cleanup.txt）；~/.workbuddy/teams 尚有 45 个非 winvm 历史残骸未动（待用户裁）。
- **Phase 3(2026-10-13~14) 启动批+批3~6 交付**：终版体检报告 docs/audit/2026-10-12-full-audit.md（§8 执行状态跟踪）；批0文档止血 f568427/批2部署可达 235d7a0/批3速赢 2bfaf95/批4-M7+M3+M6 三面 0fc388e·04b20ca·30e9203/批5保留期+R-5+A2-3+T13+Q3 6f350de·da4abc4·f4cb1f7/批6深债四件 1d2e521·ccf8a86·3e46810+D-3销账。真机 E2E 16/16 PASS(P0-4 收口)。M6 读-写分派保 54 计数(Invoke-*Manage，带写参⇒写/不带⇒读逐字旧行为)。用户五裁项全部入库(§7:①T13A销账②R-5B主动③teams非winvm永久不动④retention 90天∧2GB超限删最老⑤ARCH-09A补建)。
- **Phase 3 批1 审批闭环 P0-1 全收官(2026-10-14)**：七笔 531ec01→f7d80ff→7096166→fd60050→4f454b9→63832ad。**P0×4 全部收敛**。出路(c)新契约码 `DELEGATION_REQUIRED`(retryable=false)——纯直调命中 L2/L3 按通道事实(isInnerDelegation=dtid∨协调器活动委派槽,不可自报,全fail-safe)收口"须走委派"不发死令牌；开关 `WINVM_DELEGATION_REQUIRED_POLICY`缺省on。双闸(E-1/M2)evaluateScoped单点+三调用点(MCP/replay留存值复评/deterministic step)+F-1装配单源化(buildGoal)+F-3判源 `maxRiskSource==='agent'`(旧桥恒发回退L1,缺席当声明=断崖);灰度 `WINVM_POLICY_GATE_WIRING`缺省**shadow**(观测不执法,升on需运维显式)。F-2 `delegation-scope.ts`服务端留存(仅声明值入表,精确双键无模糊)。E-2最小诚实收口(suspendSupported显形)。A2-1三补二不补(notes§4b有据)。守卫同步(受契约保护):S-4计数2→6、preview-hash顺序钉evaluateScoped化。**教训**:src=vmagent传输标方案被buildMcpConfig LEGACY_OUT 38处逐字节守卫挡死→回退(动传输/配置形态先grep断言面);provider.execute收scope透传与shadow矛盾→执法单点定服务层。
- **Phase 4 再审计(2026-10-14)**：docs/audit/2026-10-14-full-audit.md aecaf4b。六棒429全波熔断→主理人亲验串行。P0×0/P1×3/P2×6:**N-1批1分发未跟批**(仓库≠分发真相源第三复现,新亚型=分发滞后于批;直调L2现网仍旧死令牌全形+health无policyGate块;真机三源互证)/N-5产品三册教**不存在的tasks/resubscribe**(真实通路=client.replyApproval→message/send data→continueTask→resolveApproval)/N-2 §2.6错误码表9 vs errors.ts封闭集12(三次添码两次欠表同病再发)。N-8候选**反证推翻**(c转委派有真实通道=install-host:1162双连接器+delegate工具在册,未反证会误报P0)。上轮7项在册复验全账实相符。完善路径:批8分发跟批+真机V17(待批准deploy-vm --apply)∥批9教学登记诚实化+漂移钉→批10常驻缺省形态E2E+P2随修(N-7 F-5残余/N-9(c)并发窄窗/N-10缺省形态零端到端)。
- **K2(2026-09-24 run7 全绿)**：A2A 冷启动停滞→启动期 fire-and-forget 预热 `provider.warmup()`（独立 `PersistentCliSession.warmup()`，超时不杀会话，env `WINVM_LLM_SESSION_WARMUP_MS` 默认180s，同 outputDir 单例）。
- **K3 假成功根治(CL-K3R 2026-10-05~06)**：`bridge.ts` `!turn.ok` 补 shadow 门控 `reconcileApprovalWait`；灰度 `approvalTruth=on|shadow|off`；T05 真机 `on`×3 全 input-required。
- **S-4(2026-10-07 已修✅)**：POLICY_DENIED 硬拒绝原零审计→注入 `recordPolicyDeniedAudit`(approval-replay.ts:150，经 index.ts:18 导出)于 `server.ts:605/837` 两处早退前；回归 `r19c-s4-policy-denied-audit.test.js`(245行)闭环。⚠ 曾因 grep 臆测旧函数名零命中误判"仍存"，以目录级 grep+源码裁定为 ✅。
- **A5 / K-N1 / K-N2**：A5 L2 审批 `rejected` 置位路径真机不可达(activeTaskId 被 cancel 清掉)；K-N1 委派回合未发起 tools/call 致 K5 回执反查早退(0 执行仍 completed)；K-N2 dryRun 内层 success=false。均已有 `r19c-*` 单测覆盖。

## 关键口径
- **测试基线 114 文件 / 2079 例（2077 pass/0 fail/2 skip）**（2026-10-14 Phase 3 批1 全收官 63832ad，全量 gate GREEN DISK=RUN=MATCH，qa/p3-batch-sweep/gate-b1-cl7.txt；2 skip 恒 ssh2-resolve OFFLINE_SKIP）。旧口径留档：Phase2 92/1889(T11 d1d34a6)；Phase3 演进 99/1945(QA回归 ed07434)→105/1993→106/1999(批4/6 b39816d)→110/2036(批4 M6 bc1cefd)→112/2046(Q3 f4cb1f7)→**114/2079(批1 审批闭环+双闸接线，p3-b1 两件新测试 33 例+smoke 双态化)**。**Q3 起 sweep = tests/unit/** + delivery/__tests__/**（listSweepFiles 合流）**，孤儿 oh-tunnel-error-handling 已进门禁。**基线数字权威源=qa/ 最新 `gate-*.txt` 汇总行（README/06-OVERVIEW 已废静态数字）**。门禁=`npm run gate`/`gate:quick`/`lock-probe`（GATE-POLICY.md：跳过门禁即未验收）。
- 测试证据口径：每轮只留一份权威报告 `real-test-<date>-run<N>.md`；「未复现≠已修」须确定性注入回归；FAIL 给四元组(现象/根因/证据/路由)；证据目录删除必留痕。
- 裁决必须落档再引用编号：权威层级=仓库文档>任务板>聊天；文档引用锚点段标签为主、行号(号)为辅（并行改动行号漂移）。
- 证据文件「写完再读」：落在写入窗口内得 0B 假空→任何"为空/缺失"须二次确认(mtime+字节+进程存活)。

## 团队/A2A 派发纪律
后台 worker「completed 通知」与「SendMessage 结果回报」异步分离→fresh Agent+极窄任务书+每逻辑单元即 commit+主理人按 HEAD 独立核验；**同任务严禁双进程并发**；分析/只读子任务也须指定增量落盘文件(绝对路径)+每节结论即 commit（不落文件⇒worker 静默中断零产出不可恢复）。团队句柄跨会话易失效→重建团队即可。

## backlog（未修·P2）
- **D-3（Phase 1 T1 发现）**：`capability.schema.json` 的 `domain.enum`/`id.pattern` 缺 `appops` 且**全仓无运行期校验器消费该 schema**（`additionalProperties:false` 拒止能力从未兑现）→ Phase 2 死配置/漂移清扫族，或裁断"schema 接入运行期校验"。
- K3 遗留：兜底是启发式(依赖 LLM 措辞)，根治=bridge 直读 MCP 结构化结果(更大改造)；建议补 reconcileApprovalWait 直接单测。
- 预热会话 idle 回收(5min)后深度空闲首调仍付冷启动(K2 只覆盖重启后紧随委派)。
- `SessionHealth` 无法表达「未知」(interactive 等必填，超时被迫填假值)→先做文档级注明"仅 state==='healthy' 才有意义"。
- 真实 GUI 自动化点击端到端回归受远端锁屏限制(P2)。
- **R4 根治=B3 实测(2026-10-10, commit 7e5e6c1)**：误开 enforceBearer(双条件齐)实况=VM 内回连 401 打在工具面⇒委派**零副作用虚假完成**(completed+zeroInnerCalls:true，CL-K3R 不采信兜住)，非"当场 401"；文档六处已订正。Phase 2 补 **bearer 生效自检**(开守卫后主动探测 VM 内回连并拒绝静默退化)+回连凭据分发通路。QA 收官小修：`a2a.task.cancel` ok 语义(传输层成功≠业务生效，与 zeroInnerCalls 同源口径)。
- 教训：警告块"危害形态"须实证方向；"未实证危害形态≠危害形态已写对"。
