# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话复用事实；临时排查勿入。交接见 `.workbuddy/README.md`。历史批次细节见 `docs/changes/` 与 `qa/p3-batch-sweep/`。

## 架构
宿主 WB 插件操作 Win11 VM（system/app/storage/gui/appops 五域 51 + meta 3 = 54 能力；L0:27/L1:19/L2:7/L3:1）。DDD+plan-first；npm workspaces 12 包，TS strict ESM，`tsc -b tsconfig.build.json`，`node --test <单文件>`。双通道：MCP 直调 `/mcp`（简单）/ A2A 经隧道 `/a2a`（复杂，streaming 审批），同隧道承载。宿主工具名规范形态为**点分**（`system.info.get`→`winvm__system.info.get`，tools/list 实测保留点号）。VM Agent（`WINVM_VM_PROVIDER`）：`workbuddy-deterministic`(基准)/`workbuddy`(LLM codebuddy 常驻)/`hermes-agent`。

## 拓扑/环境
- 宿主=鸿蒙 NEXT（`process.platform` 实报 `openharmony`）；VM=Win11 `172.16.100.2`（ssh 免密用户名=**User**、非 towyq，以 vm-conn.json 为准；`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区）；VM 服务只监听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（**改 psmod/*.ps1 必须重启服务**）。
- **宿主插件缓存=运行态真相源**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` → 改 dist 必须实跑 `delivery/install-host.mjs`；skill 缓存真实落点=`~/.workbuddy/connectors/skills/connector-winvm/<skill名>/SKILL.md`。
- 宿主持久化 `~/.workbuddy/winvm/{vm-conn.json,tunnel.pid,tunnel.state.json,tunnel.log}`；VM 侧 `~/.workbuddy/winvm/side.json`。
- 鸿蒙沙箱：WB uid 20020171，每 App 独立挂载命名空间+HMMAC 无 root；`$HOME`(hmdfs) 唯一跨 App 通道；跨 App `kill -0`：EACCES≠死/ESRCH=死。

## 关键坑（改码/联调前必扫）
- 远端 shell=Git Bash(MSYS)：`/` 开头参数被路径转换→远端逻辑写 `.ps1`→scp(远端路径须 `C:/…`)→`powershell -NoProfile -ExecutionPolicy Bypass -File`；载荷 ASCII 防乱码。**回向通道同理**：含中文证据绝不用 `ssh … > 本地文件`→ VM 侧 `[IO.File]::WriteAllText` 落文件→scp 回传→JSON.parse 自证。杀隧道勿 `pkill -f 'ssh -N -L'`(自杀)→直 kill PID。
- **ssh `cmd &` 脱管**：VM 长观测一律前台限时或自带 PID/心跳落盘；真机窗口探针**串行化**。
- **provider=workbuddy 禁批量 tasks/cancel（真机红线）**：requestCancel abort 打断常驻会话⇒重建风暴⇒服务崩溃；单条 cancel ~3.4s。
- PS 5.1：`Sort-Object <裸键>` 对 `[ordered]@{}` 静默失效→`-Property { $_.key }`。
- 沙箱：`/tmp` 只读(用 `$HOME/wbtmp`)；git 用全路径 `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`；`rm` shim 坏→用 `fs.unlinkSync`；node 必须 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；`getcwd` 偶发异常(用绝对路径)。
- **单测绝不整批跑**→`node --test <单文件>`（junction 整批触发 `0xC0000005` 假全红）。
- **注释文本也是静态守卫输入面**（守卫扫全仓 src 含注释）：引用被守卫字段名/字样前先 grep 同名静态断言。
- **慢执行假死→熔断误判**：判活看双 timeline+git status 差异而非只看 mtime；**同任务严禁双进程并发**。
- **Grep 工具对大文件/多词 `|` 搜索假阴性**→目录级 grep/Read/Glob；仓库清点用 `git ls-files`/`git grep`。
- **版本指纹 > uptime**：证明版本须用行为/字段指纹（`/health` 开关字段、`steps[0].risk`）。
- **VM 侧运行态开关**：走 provider options（`.generated/vm-service.runtime.json`，provider 级浅合并、未知键保留；adapter 内 `opts.X ?? resolveX(env)`）；重启只用 `kill-restart.ps1`；顺序铁律：先部署→后打补丁→再 kill-restart。
- **GUI 可用性**：LogonTrigger(已登录会话)→GUI 可用；BootTrigger→不可用。锁屏态不可代码解锁（Windows 安全边界），E2E 前置人工配方（powercfg 禁休眠+session healthy 门）。
- 隧道：掉线旧隧道占监听→TCP 通但 HTTP 黑洞(判据 ping 100% 丢)；用 `delivery/tunnel-daemon.mjs`；兜底 HOURLY watchdog `aaa87da4`。`/proc` 扫进程判据须精确（cmdline 第2段以 `tunnel-daemon.mjs` 结尾）防自匹配假实例。
- **VM-START bind EACCES**：socket 未 drain 所致；解药=清全持有者+递增等待 drain+循环重试(`qa/p3-batch-sweep/m6-restart.ps1`)。**诊断铁律：先 netstat 全状态+前台直跑读 stderr 定性**。
- **凡 spawn 子进程必同时挂 exit+error**（二者互斥非冗余）。
- ssh `schtasks /run` 拖死通道（34min）→ 改经隧道轮询 `/health` 判翻转。
- **winget 经 SSH 非交互会话"拒绝访问"**（MSIX alias）→ 真卸载类需桌面会话，勿强造。
- 改源必即 `tsc -b`（dist 陈旧会让测试吃旧产物假红/假绿）。

## 里程碑（压缩）
CL-015~021 早期演进；Phase 2 收官(T1-T12+守卫+GATE-POLICY)；Phase 3~5 批0-14（审批闭环 DELEGATION_REQUIRED/双闸/C0 转呈面折叠 foldK6Verdict/批14 执法通道化 install-vm --policy-gate-wiring）；Phase 6 批15-18 完赛(398d5ba)；批19-20 技术债销账（E-2 probeError 三码/GUI 锁屏定性/K3 approvalTruth 缺省 on/R4 bearer 自检）。
- **REL-V1.4.0（10-18）**：tag@381d2d8 推 origin；`delivery/pack-release.mjs` 三包（host/vm/overall，闭包推导+MANIFEST sha256+包内 V1-V4 验证）；真机 run1-3（I-1.1 闭包漏 config 修复→--wipe 清场重做）。**REL 迭代2**：`evaluateTunnelReuse` 后端 /health=唯一硬判据，daemon 自报仅信息（23fa078）。**迭代3**：uninstall 内建查杀（/End 熔断看门狗→Kill-Sig 三签名含 ps-bridge 孤儿→/Delete→兜底；buildVmPs1 可单测）。**迭代4**：仓库 private→public；pack-release 增 zip+sha256+zip条目⊆MANIFEST fail-loud；`publish-release.mjs` 幂等上架；`tools/winvm-prepare.ps1` 单一真相源；真网首跑两雷（RFC6570 模板段→400 / headers 反压 Content-Type→400，均已修）。Release `releases/tag/V1.4.0` 匿名下载回环实测。
- **CL-026（10-20/21）审批卡强制呈现闭环 + V1.4.1 上架**：`APPROVAL_PRESENTATION_DIRECTIVE` 五携带面；SKILL.md 审批协议升 MUST（show_widget 七槽位卡→AskUserQuestion→禁纯文本代批→reply+task.get 终态）；MCP 直调无载荷出卡=违规诱导。守卫 31 例 ST3。V1.4.1 已上架并跟批缓存。
- **发布迭代铁律（用户 2026-10-18 三条裁定，强制）**：① 每迭代重部署前必须清空历史部署（`deploy-all.sh --wipe`，验证矩阵在清空重装态取数）；② uninstall 必须先查杀 VM 端本项目看门狗与 services 再清场（已内建）；③ 迭代完成后 commit 必须 push origin（github.com:athronix/workbuddy-virtual-win-plugin）。
- **hos-win-skill 入插件（10-23/24，983dfc5/2e664a8/25aad43）**：用户级 skill 评审修订 v1.1.0（11 项：工具名点分化/meta 域补全/L2L3 双闸事实/数值核源/与 orchestrator 分层互补表）→ 入插件为第 8 个 Skill（项目级 `skills/hos-win-skill/SKILL.md`，与用户级 body 逐字节一致；orchestrator relatedSkills 回指）→ 计数 7→8 全仓联动 + 已证伪 claims 订正（「每 Skill 含 mcps-reference.md」证伪：仅 winvm-mcp-reference 与 winvm-orchestrator 两家有 references/）+ 手册缺口与验证表实跑取数 + 作用域声明。**新核事实**：宿主 mcp.json `disabledTools` 静态禁用 8 个 L2/L3（install-host highRiskTools）+ 服务端 `WINVM_DELEGATION_REQUIRED_POLICY` 缺省 on 双闸；L2 全集 7（service.configure/process.terminate/registry.write/winget.uninstall/file.delete/link.manage/appops.gui.produce）+ L3 唯一 power.control；supportsDryRun 5 条；timeoutMs 10–600s；idle TTL 300s/深度空闲冷启动 49.3s/CLI 地板 75–107s/就绪预算 180s。**01:55 缓存消失事件**：平台侧崩溃（daemon 子进程 SIGKILL）中断技能枚举致 8 技能缓存整体消失（非工具缺陷，trash/DB 无痕）→ install-host 重跑完整恢复。
- 基线演进 1889→**2280** 例 GREEN（快照=`qa/p3-batch-sweep/gate-docs-overview.txt`：128 文件/2280 例/0 fail/2 skip；判据仍以最新 gate-*.txt 汇总行为准）。

## 关键口径
- **测试基线权威源 = `qa/` 最新 `gate-*.txt` 汇总行**（README/06-OVERVIEW 静态数字已废）。门禁=`npm run gate`/`gate:quick`/`lock-probe`。守卫经 dist 消费：变异/还原测试必先 `tsc -b`。
- **V1.4.0 迭代归档纪律**：旧包改名保留 `release/V<ver>.superseded-it<N>`；台账 `docs/release/issues.md`。
- 测试证据：每轮只留一份权威报告 `real-test-<date>-run<N>.md`；「未复现≠已修」须确定性注入回归；FAIL 给四元组(现象/根因/证据/路由)；证据目录删除必留痕。
- 裁决必须落档再引用：权威层级=仓库文档>任务板>聊天；引用以锚点段标签为主、行号为辅。
- 证据文件「写完再读」：写入窗口内读会得 0B 假空→"为空/缺失"须二次确认(mtime+字节+进程存活)。

## 团队/A2A 派发纪律
后台 worker「completed 通知」与「SendMessage 回报」异步分离→fresh Agent+极窄任务书+每逻辑单元即 commit+主理人按 HEAD 独立核验；只读任务也须指定增量落盘文件+每节结论即 commit。

## backlog（未修·P2）
- 深度空闲冷启动 ~49.3s：批20 用户裁定 idle TTL 保持 5min（codebuddy CLI 进程级冷启动，外部特性）；D-5 180s 判死保证不误杀；保活机制列 P2 观察。
- teams 非 winvm 残骸 45 个：Phase2 用户终裁**永久不动**（phase2-arch-design.md §7-③），非待裁项。
- GUI E2E preflight 早失败钩子（P2 观察）。
- **diagnose-connectors 查错 states 路径**（10-24 登记，根治施工中）：误查 `~/.workbuddy/connector-states.v3.json`（不存在），真实位置 `~/.workbuddy/connectors/<account>/connector-states.v3.json`；修法=枚举账户目录+排除 skills/marketplace-meta 非账户目录+legacy 根路径兼容。
- **VM 分发 hos-win 语义倒挂**（10-24 登记，根治施工中）：宿主侧技能随 skills/ 整包进 VM 共享根并 junction 给 VM Agent；缓解=25aad43 作用域声明；根治=deploy-shared-skills `HOST_ONLY_SKILLS` 排除+陈旧副本/链接清理。
- **install-host 把 connectors/skills/ 当 account 合并 mcp.json**（10-24 登记，未处理）：`account-resolve.mjs resolveAccountIds` 遍历 connectors/ 全部子目录，产出 `connectors/skills/mcp.json`、`connectors/marketplace-meta/mcp.json`（956B 仅 winvm 两条+每跑备份）；09-20 起既存怪癖，判定无害（平台不读这两处）；修法=排除已知非账户目录。
