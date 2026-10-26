# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话复用事实；临时排查勿入。交接见 `.workbuddy/README.md`。历史批次细节见 `docs/archive/changes/`（10-26 起，原 docs/changes）与 `qa/p3-batch-sweep/`。

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
- **大文档多轮 Edit 会静默缩水（10-26 血泪）**：`deploy-strategy.md` 十余次 Edit 后 785→575 行、整章 `## 6` 消失，但每次 Edit 都返回成功、`git diff` 只显 415 行变动（混杂表格 padding 变化）。**铁律**：① 改前先 `git show HEAD:<file>` 留基线；② 一批改动用**一次性脚本 + 每处断言 count==1、不匹配整体拒写**；③ 写完立即 `wc -l` + 关键 heading/锚点 grep 核验（不信任 Edit 返回值）。
- **版本指纹 > uptime**：证明版本须用行为/字段指纹（`/health` 开关字段、`steps[0].risk`）。
- **VM 侧运行态开关**：走 provider options（`.generated/vm-service.runtime.json`，provider 级浅合并、未知键保留；adapter 内 `opts.X ?? resolveX(env)`）；重启只用 `kill-restart.ps1`；顺序铁律：先部署→后打补丁→再 kill-restart。
- **GUI 可用性**：LogonTrigger(已登录会话)→GUI 可用；BootTrigger→不可用。锁屏态不可代码解锁（Windows 安全边界），E2E 前置人工配方（powercfg 禁休眠+session healthy 门）。
- 隧道：掉线旧隧道占监听→TCP 通但 HTTP 黑洞(判据 ping 100% 丢)；用 `delivery/tunnel-daemon.mjs`；兜底 HOURLY watchdog `aaa87da4`。`/proc` 扫进程判据须精确（cmdline 第2段以 `tunnel-daemon.mjs` 结尾）防自匹配假实例。
- **宿主缓存=单文件白名单投放拓扑**（10-25 P2-4 血泪）：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` 只含 `deploy-winvm-plugin.mjs` 的 extraFiles 白名单所列文件（`winvm-plugin.mjs` + 隧道三件套 + hooks + **10-25 起含 `account-resolve.mjs`**），VM 侧才是 setup.mjs tar 整包 delivery/。**故任何给 winvm-plugin.mjs 新增的相对 import，必须同时进 `install-host.mjs` 宿主缓存 extraFiles（:1298）与 `buildIntegrityFilePairs` 单文件面（:211）**，否则 PATH 上的 `winvm-plugin` 直接 ERR_MODULE_NOT_FOUND（=回归非修复）；:1300（面向仓库 delivery/ 的自拷贝调用）**不必加**——extraFiles 循环自带 `resolve(fSrc)===resolve(fDst)` 跳过分支（实测「已就位，跳过复制」），加了是空操作。加完必须 `--check-fresh` 验证对账面一致（现 187 对）。
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
- **P2 两项根治（10-24，027cf0d，engineer-p2 施工+主理人独立核验）**：A=diagnose-connectors states 账户目录口径（详见 backlog 销账项）；B=VM 技能分发 host-only 排除（`HOST_ONLY_SKILLS` 两段式：skip-host-only/remove/remove-link）。核验证据：诊断工具真实 home+合成 home 双路、dry-run 7 发布+清理 1+零写盘、单测 11/11+相关 6 文件 75 例、两副本 body diff 空+缓存 SAME。
- **P2-3 账户枚举排除非账户目录（10-25，856a0f4）**：`NON_ACCOUNT_DIRS` 单一事实源上收 account-resolve.mjs，安装/卸载/诊断三路径对称排除 skills/marketplace-meta；18 个历史误写文件移入回收站（winvm/nonaccount-mcp-trash-20261025/）；核验=合成 home E2E（目标账户出列+真实账户正常写+零污染）+单测 7/7。其连带发现的两处同型已于 10-25 **P2-4 销账**（b98a7f7/b9f1086，见下方 backlog 销账项）。
- 基线演进 1889→**2280** 例 GREEN（快照=`qa/p3-batch-sweep/gate-docs-overview.txt`：128 文件/2280 例/0 fail/2 skip；判据仍以最新 gate-*.txt 汇总行为准）。
- **部署策略 v2 六步全流程真机实测通过（10-26，验收 25/25）**：`docs/deploy/deploy-strategy.md`（v2.1）+ `docs/deploy/deploy-prompts.md`（总 Prompt 集）+ `qa/deploy-probes/` 四探针（verify-manifest.py / vmcheck.ps1 / mcp-probe.py / a2a-probe.py）+ 报告 `qa/real-test-2026-10-26-run1.md`。六步：密码登录→免密通道（**空密码被 `LimitBlankPasswordUse=1` 硬阻断**，必须非空；公钥 base64 传参避 MSYS 引号地狱；写两处 authorized_keys）→Release 三层校验→`deploy-vm --apply --skip-build`(71s/53s)→`install-host --yes`（自带拉隧道，`--check-fresh` 186 文件 FRESH）→MCP 20/20 + A2A 5/5。**用户裁定**：`WINVM_VM_PROVIDER` 默认 `workbuddy`（配 `WINVM_WORKBUDDY_CLI=codebuddy`、`VM_DEPLOY_DIR=C:/WinVMBridge`）；部署参数收敛为「变量+默认值」表待确认。**新铁律/陷阱**：`WINVM_DRY_RUN=1` 会把 `--apply` 降级 dry-run（假成功）；`$_` 被本地 bash 展开成 `/usr/bin/bash`→远端 ParserError（一律 `.ps1`+`-File`）；`github.com` 本网段抖动非封禁（`--retry-all-errors -C -` + 绝对 URL，勿用 `releases/latest`）；`disabledTools` 落点是**全局** `~/.workbuddy/mcp.json` 而非 `connectors/<acct>/mcp.json`；`/mcp` 原始面恒列全 54（不可断言"不含高危"）；`a2a.delegate` 必填 `goal`；**无 `/a2a/health` 路由**（发现走 `/.well-known/agent-card.json`，健康走 MCP `a2a.health`）；`app.inventory.list` 无 `limit`。
- **文档全面 review+重构（10-26，614c869/90224ec/2edc445）**：Tier1-4 全档落地——工具名点分订正 5 处、06-OVERVIEW 计数（9 文件/12 篇）、RELEASE-NOTES 补 V1.4.1/V1.4.2+基线指针+去硬编码 SHA、根 overview.md 冻结头、§8.2/治理红线两条入 SECURITY-GOVERNANCE、docs/archive 迁移+5 INDEX+docs-index v 更新、issues.md→ISSUES.md。守卫 phase3-skill-claims-guard 迁移后 11/11 GREEN。分析员两处误判已纠（qa 可整体迁=否、SPEC-SKILLS 七个Skill=grep 路径错）。

## 关键口径
- **测试基线权威源 = `qa/` 最新 `gate-*.txt` 汇总行**（README/06-OVERVIEW 静态数字已废）。门禁=`npm run gate`/`gate:quick`/`lock-probe`。守卫经 dist 消费：变异/还原测试必先 `tsc -b`。
- **V1.4.0 迭代归档纪律**：旧包改名保留 `release/V<ver>.superseded-it<N>`；台账 `docs/release/ISSUES.md`（10-26 起大写名，注意 hmdfs 大小写不敏感、盘上物理名仍 issues.md，以 git 索引为准）。
- **文档体系 10-26 重构**：历史归档 `docs/changes|audit|test` → `docs/archive/`（git mv 保历史，各区有 INDEX.md）；`qa/` **保留原位**（setup.mjs/pack-release.mjs 活引用 probes/，gate 权威在 p3-batch-sweep/，不可迁）；导航权威=.dev/docs-index.md。改文档路径前先查脚本活引用。
- 测试证据：每轮只留一份权威报告 `real-test-<date>-run<N>.md`；「未复现≠已修」须确定性注入回归；FAIL 给四元组(现象/根因/证据/路由)；证据目录删除必留痕。
- 裁决必须落档再引用：权威层级=仓库文档>任务板>聊天；引用以锚点段标签为主、行号为辅。
- 证据文件「写完再读」：写入窗口内读会得 0B 假空→"为空/缺失"须二次确认(mtime+字节+进程存活)。

## 团队/A2A 派发纪律
后台 worker「completed 通知」与「SendMessage 回报」异步分离→fresh Agent+极窄任务书+每逻辑单元即 commit+主理人按 HEAD 独立核验；只读任务也须指定增量落盘文件+每节结论即 commit。

## backlog（未修·P2）
- **G-3 `qa/deploy-probes/` 不进发布包（10-26 发现）**：`pack-release.mjs` 的 VM_PROBES 只含 `qa/probes/qa-probe.ps1`+`lead-md5-3.ps1`；V1.4.2 包 `MANIFEST` 搜 `deploy-probes` = **0**。→ 纯 Release 安装拿不到 `verify-manifest.py`/`vm-env-check.ps1`/`vmcheck/mcp-probe/a2a-probe`。当前兜底：Step 3.0 内联 `node -v; npm -v; codebuddy --version`。处置：加入 overall 白名单（随 V1.4.3）。
- **G-1 发布包陈旧（10-26 发现，待发 V1.4.3）**：`winvm-overall-V1.4.2.zip` 构建于 `eba187e`(10-21)，**早于 10-24~10-25 的 P2 修复**。证据：包内 `delivery/install-host.mjs` 无 `NON_ACCOUNT_DIRS`（0 次 vs 仓库 3）；实测安装后 `~/.workbuddy/connectors/skills/mcp.json` 与 `connectors/marketplace-meta/mcp.json` **各被写入 `connector:winvm`**（=P2-3/856a0f4 回归）；包内缺 `delivery/tools/diagnose-connectors.mjs`（连接器自检被跳过）。处置：`tsc -b`→`pack-release`→`publish-release` 发 V1.4.3 并把 `delivery/tools/` 纳入包 + `pack-release` 加「包内 install-host.mjs 必须含 NON_ACCOUNT_DIRS」硬断言。本轮污染已移入 `~/wbtmp/winvm-nonaccount-trash-20261026/`（各 956B，两真账户完好，复测 20/20 绿）。**用户裁决待定**。
- **G-2 `MANIFEST.txt` 无消费者（10-26 发现）**：全仓仅 `pack-release.mjs:312 writeManifest` 生成，`delivery/` 无 verifier → 包内损坏安装前不可知。已用 `qa/deploy-probes/verify-manifest.py` 补第 2 步第三层（口径：`sha256(rows.join('\n'))`，行格式 `"<relpath>  <sha256>"` 双空格、按路径排序、不含 MANIFEST 自身；解析须先定位 `# ---- per-file` 分隔行否则头 `version:` 行被误当文件）。建议收编为 `delivery/verify-release.mjs`。
- 深度空闲冷启动 ~49.3s：批20 用户裁定 idle TTL 保持 5min（codebuddy CLI 进程级冷启动，外部特性）；D-5 180s 判死保证不误杀；保活机制列 P2 观察。
- teams 非 winvm 残骸 45 个：Phase2 用户终裁**永久不动**（phase2-arch-design.md §7-③），非待裁项。
- GUI E2E preflight 早失败钩子（P2 观察）。
- ~~**diagnose-connectors 查错 states 路径**~~ → **10-24 销账（027cf0d）**：`probeConnectorStates` 重写为账户目录口径（枚举 connectors/ 排除 skills/marketplace-meta、legacy 根并入 pseudo-account、聚合 state+账户前缀 winvm 摘要）；根治本机活跃账户 525B states 被误报"不存在"。
- ~~**VM 分发 hos-win 语义倒挂**~~ → **10-24 销账（027cf0d）**：`deploy-shared-skills.mjs` 新增 `HOST_ONLY_SKILLS=['hos-win-skill']`，两段式均排除（repo 侧 skip-host-only/共享根残留 remove/Agent 目录历史 junction remove-link，lstat→rm/rmdir 绝不递归进目标）；宿主侧 install-host 仍 8 skill 不变；docs 验证表 VM 侧改 7；已知边界=无 SKILL.md 的残目录不扫（listSharedSkills 合法技能定义，现实陈旧副本必含 SKILL.md）。
- ~~**install-host 把 connectors/skills/ 当 account 合并 mcp.json**~~ → **10-25 销账（856a0f4）**：`NON_ACCOUNT_DIRS` 上收 `account-resolve.mjs` 单一事实源，安装（resolveAccountIds）/卸载（uninstallConnectors）/诊断（probeAccountMcp）三路径对称排除 skills/marketplace-meta；override 显式意图仍优先。**既存 18 个误写文件已移入可恢复回收站** `~/.workbuddy/winvm/nonaccount-mcp-trash-20261025/`（skills 12+marketplace-meta 6，用户 10-25 裁定）。
- ~~**adapter uninstall 同型写路径**~~ → **10-25 销账（b98a7f7）**：`packages/adapter-host-workbuddy/src/index.ts` 新增导出 `NON_ACCOUNT_DIRS`（同语义拷贝，注释写明 delivery 侧为交付链单一事实源、本包不反向依赖 delivery），uninstall 枚举加 `!NON_ACCOUNT_DIRS.has(e.name)`；由 `host-adapter.test.js` **恒等守卫**（与 delivery 侧 deepEqual）+ 行为例（非账户目录 mcp.json 逐字节不变）双钉死防漂移。
- ~~**winvm-plugin status 只读罗列同型**~~ → **10-25 销账（b9f1086）**：`winvm-plugin.mjs` check 的 accounts 循环与 `list mcp-servers --side host` 两处均过滤 `NON_ACCOUNT_DIRS`；**修法非"直接 import"而是先扩宿主部署集**（详见下方 key pitfalls「宿主缓存单文件投放拓扑」）。修复前若非账户目录有含 connector:winvm 的 mcp.json，`check` 会**假绿**——比 cosmetic 更严重。
- ~~**连接器自检 spawn 未传 --home**~~ → **10-25 销账（b98a7f7）**：install-host `runConnectorSelfCheck` spawn 补 `--home <安装目标 home>`，"安装到哪验哪"。
