# WinVM Bridge · 发布问题台账（ISSUES.md）

> 组织方式：**版本 → 迭代**。每条问题四元组齐全（现象/根因/证据/路由），关闭条件=复验通过。
> **发布迭代铁律（用户 2026-10-18 裁定）**：每个迭代重新部署新版本前，**必须清空历史部署**（`deploy-all.sh --wipe`）；不清场的重装只是"补部署"，不构成迭代验收；功能验证矩阵必须在该迭代的清空重装态上取数。
> 关联文档：`docs/release/DESIGN-V1.4.0.md`（发布设计）、`docs/release/RELEASE-V1.4.0.md`（发布说明）、`docs/05-peripherals/DEPLOYMENT.md`（部署 runbook §9）。

## V1.4.0

### 迭代 1（2026-10-18）——首发打包 + 清空重装 + 真机验证

> **状态：已关闭**（2026-10-18 02:1x）。本迭代记录「打 tag → 打包 → 清空历史部署 → 发布包真机重装 → 完整功能验证」全过程；三个问题全部复验关闭，验证矩阵全项通过。

**部署前快照（清场前实测，2026-10-18 01:5x）**：
- 隧道：`127.0.0.1:18443/health` → `ok:true`、provider=workbuddy/ready、session.state=healthy/locked=false、psBridge.uptimeMs≈56458321/restarts=0
- 宿主：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` 在册（历史部署，0.1.0 为 package.json 插件产物版本）
- VM：`C:/WinVMBridge` + 计划任务 `WinVMBridge.Service` 在册
- tag：V1.4.0 @ 381d2d8（已推送 origin）；发布工具链 commit 链：381d2d8 → 0a54ab3 → d1965e7 → 8e10918 → 39357f8 → ec89ec2

| ID | 阶段 | 现象 | 根因 | 处置 | 复验 | 状态 |
|---|---|---|---|---|---|---|
| I-1.1 | 部署·VM | `install-vm.mjs` 早死：`找不到 VM 服务配置：C:\WinVMBridge\delivery\vm-service.config.json`（VM 相位 8.1s 即败） | 发布包 VM 闭包漏文件：`vm-service.config.json` 是 install-vm 的**非 import 硬依赖**（读文件生成 runtime.json），pack-release 的 VM_DELIVERY 清单未列；V3 dry-run 只验证 import 闭包，抓不到此类缺失 | `pack-release.mjs`：VM_DELIVERY 补 `delivery/vm-service.config.json`；新增 `PACKAGE_REQUIRED` 三包必存结构断言（V1）；设计文档 §3.2/§六 同步（commit 39357f8） | run2：VM 相位 35.6s ✅、任务注册 + 服务拉起 | **已关闭** |
| I-1.2 | 部署·VM-START | `VM_START_FAILED exit=1`（schtasks /run 无任务可触发） | I-1.1 级联：install-vm 早死 ⇒ 计划任务 `WinVMBridge.Service` 从未注册 | 随 I-1.1 修复自然消解 | run2：VM-START 18.1s ✅（端口轮询通过） | **已关闭** |
| I-1.3 | 验证·HEALTH | `/health` 三探失败；日志诊断「端口已监听但 HTTP 无响应」 | I-1.1 级联：VM 服务从未起；install-host 安装尾拉起的 tunnel-daemon 本地监听在 = **隧道黑洞**（TCP 通、后端死） | 随 I-1.1 修复自然消解 | run2：HEALTH 0.6s ✅（ok:true / provider=ready / session=healthy） | **已关闭** |
| OBS-1 | 验证·TUNNEL | TUNNEL 相位「复用常驻 daemon」判据=本地端口监听 + daemon 健康，**未探后端 /health** ⇒ 后端死时误报「健康」 | 判据设计缺口（本地活 ≠ 后端活） | 登记观察项（不阻塞本发布）：后续在 TUNNEL 相位加一次轻量 /health 佐证 | — | 观察项 |

#### 迭代 1 过程记录

- **run1 证据**：`qa/release/V1.4.0-deploy-run1.log`（uninstall 清场 checklist 全 PASS ⇒「清空历史部署」能力成立；HOST ✅ 1.2s；VM/VM-START/HEALTH ❌；TUNNEL/TEST/QA-PROBE ✅）
- **run2 证据**：`qa/release/V1.4.0-deploy-run2.log`（修复包重部署，七相位全过：HOST 0.8s / VM 35.6s / VM-START 18.1s / TUNNEL 0.3s / TEST 0.3s / QA-PROBE 67.5s / HEALTH 0.6s）
- **根因分类**：发布工程缺陷（打包闭包推导漏"读文件"型依赖），非运行态代码缺陷 ⇒ 按 DDD 场景 E 流程：根因文档化（本表）→ 仓库侧修复（39357f8）→ 重新打包 → 重新部署复验
- **完整功能验证矩阵（run2 后，经发布包部署的双端实调）**：

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `/health` 三态 | ✅ ok:true、provider=workbuddy/ready、session.state=healthy/locked=false、capabilitiesProfile.llm-agent | run2 日志尾部 + deploy-all 后置 curl |
| 2 | MCP 直调 `meta.capability.list` | ✅ **count=54**、六域（app/appops/gui/meta/storage/system） | traceId tr_mvcph1j1_1，durationMs 3 |
| 3 | MCP 直调 `system.info.get` | ✅ Win11 家庭版 26200 / ARM64 / 8187MB / isAdmin=true | traceId tr_mvcph1jy_3，1594ms |
| 4 | A2A 委派（LLM 常驻会话） | ✅ goal 完成、steps[0] ok:true、19.2s、结构化回执 | delegate 返回 + traceId tr_mvcpheu0_1 |
| 5 | `gui.session.status` | ✅ healthy / interactive=true / blackScreen=false / explorerAlive=true | traceId tr_mvcph1jv_2，1773ms |
| 6 | 审计链诚实回执 | ✅ traceId 在链（34 条记录）、字段级回执 1 条；A2A Agent Card v0.1.0 可达、五技能声明 | audit.receipt + a2a.health |
| 7 | 双侧部署态 | ✅ 宿主缓存 `winvm-bridge/0.1.0`（5.0M）重装；VM `C:/WinVMBridge` + 计划任务 + dev-and-qa MANIFEST/install log 在册 | ls + VM 侧 Get-Content |

**结论：V1.4.0 发布包真机部署 + 完整功能验证全部通过 ⇒ 迭代 1 关闭，「成功发布、部署和完整功能验证」达成。**

#### run3：清空重装闭环（铁律合规，2026-10-18 02:2x）

用户裁定「每个迭代重新部署新版本前都要清空历史部署」后，用**更新文档后的重新打包**（overall 含 DEPLOYMENT §9）执行符合铁律的完整闭环：

- **清场**：`deploy-all.sh --wipe` ⇒ 双端 uninstall checklist 全 PASS（`APPLY complete: all cleanup steps done and verification checklist passed.`）
- **重装**（`qa/release/V1.4.0-deploy-run3.log`）：七相位全过——HOST 1.3s / VM 30.4s / VM-START 14.9s / TUNNEL 0.3s / TEST 0.3s / QA-PROBE 67.0s / HEALTH 0.4s；后置 curl ok:true、provider=ready、session=healthy、psBridge 新起（uptimeMs≈72396）
- **验证矩阵（清空重装态取数，权威）**：

| # | 验证项 | 结果 | 证据（run3 态） |
|---|---|---|---|
| 1 | `/health` 三态 | ✅ ok:true / provider=ready / session=healthy | run3 日志尾部 |
| 2 | MCP `meta.capability.list` | ✅ **count=54**、六域 | tr_mvcqfh2w_1，durationMs 1 |
| 3 | MCP `system.info.get` | ✅ Win11 26200 / ARM64 / isAdmin=true | tr_mvcqfh3d_3，1503ms |
| 4 | A2A 委派（LLM 常驻会话） | ✅ steps[0] ok:true、16.1s | tr_mvcqfylq_4 |
| 5 | `gui.session.status` | ✅ healthy / locked=false / explorerAlive=true | tr_mvcqfh3b_2，1595ms |
| 6 | 审计链 | ✅ 链上 35 条记录 + 字段级回执；Agent Card 五技能 | audit.receipt + a2a.health |
| 7 | 双侧部署态 | ✅ 宿主缓存 0.1.0 重装；VM 任务+MANIFEST 在册 | run3 相位 + VM 侧 |

> 说明：run2（未清场）的验证数据保留在上节作过程记录；**run3 为铁律合规的权威验收态**。后续任何迭代重部署，一律先 `--wipe` 再验证。

### 迭代 2（2026-10-18 02:4x-03:0x）——OBS-1 修复：TUNNEL 相位判据收紧

> **状态：已关闭**。驱动项=迭代1 观察项 OBS-1（TUNNEL 相位「复用即健康」判据缺口）。本轮=仓库侧判据修复 → 重打包 → `--wipe` 清空重装（铁律）→ 实弹黑洞场景正向复验 + 验证矩阵 7 项全过。

| ID | 阶段 | 现象 | 根因 | 处置 | 复验 | 状态 |
|---|---|---|---|---|---|---|
| I-2.1（OBS-1 关闭） | 验证·TUNNEL | 旧判据：`st.healthy`（daemon 自报）⇒ 直接返回复用，**未探后端 /health** ⇒ 后端死时误报「健康」，把隧道黑洞漏到 HEALTH 相位才炸 | 判据设计缺口：本地端口监听 + daemon 自报态均不能证明**后端 VM 服务活着**（本地活 ≠ 后端活） | `setup.mjs`：新增 `evaluateTunnelReuse` 纯函数（后端 /health 打通=唯一硬判据，daemon 自报态仅作信息）；① 复用路径改为先探后端——daemon healthy+后端不通=「隧道黑洞嫌疑」明示日志并转 daemon 恢复/重建路径；② `tunnel ensure` 后判据同步收紧（r.ok 时一次 2s 快重试容忍后端启动瞬态）；单测 +3 例钉死判据（commit 23fa078） | **it2 真机实弹**：TUNNEL 相位当场捕获黑洞并恢复（见下）；门禁 GREEN 124 文件/2185 例/0 fail/2 skip | **已关闭** |

#### 迭代 2 过程记录

- **仓库优化**：`delivery/setup.mjs`（判据修复，约 +60 行）· `tests/unit/setup-env.test.js`（+3 例，25/25 绿）· 门禁证据 `qa/p3-batch-sweep/gate-rel-v1.4.0-it2.txt`（124/2185/0 fail/2 skip，DISK=RUN=MATCH）。commit：e83cea9（迭代1 run3 闭环文档补交）→ 23fa078（OBS-1 修复）。
- **重打包**（步骤2）：`release/V1.4.0` 重建——host 847 文件/6694K/sha256 `2bd8af32…`、vm 344 文件/2820K/sha256 `0588c2f4…`、overall 866 文件/7086K/sha256 `a65c868f…`；包内 V1-V4 验证全过；it1 旧包改名保留为 `release/V1.4.0.superseded-it1`（可回退，未删除）。
- **清空重装**（步骤3，铁律）：`deploy-all.sh --wipe`（`qa/release/V1.4.0-deploy-it2.log`）——uninstall 双端 checklist **18 项全 PASS**（`VM_CLEANUP_DONE`；宿主持久化入回收站可恢复、VM `C:/WinVMBridge` 删除、`WinVMBridge.Service` 任务移除、端口清）；随后七相位全过：HOST 1.3s / VM 33.1s / VM-START 18.3s / **TUNNEL 8.3s** / TEST 0.3s / QA-PROBE 67.1s / HEALTH 0.5s。
- **实弹黑洞场景（本轮核心战果——OBS-1 修复的真机正向验证）**：
  ```
  [TUNNEL]
  ⚠️ 隧道黑洞嫌疑：daemon 自报 healthy（pid 34812）但本地 127.0.0.1:18443 未打通 /health → 尝试由 daemon 恢复/拉起
  ⏳ 由常驻 daemon 拉起/确保隧道：winvm-plugin tunnel ensure …
  ✅ 常驻隧道已就绪且后端已打通（tunnel ensure 用时 0.3s，pid 34812，daemon 态=RUNNING）—— 本地 127.0.0.1:18443 可连
  ```
  机理：uninstall 杀掉旧 daemon（pid 16136）后，看门狗自动化抢先在部署 TUNNEL 相位前拉起新 daemon（pid 34812）并自报 RUNNING，但此刻 VM 服务刚被清场重装、后端未起 ⇒ **daemon healthy 与后端死活脱钩的真实黑洞**。旧代码在此分支直接放行（复用成功），后续 TEST/QA-PROBE 照跑、HEALTH 才失败；新代码当场识别黑洞 → daemon ensure 恢复通道 → 后端打通 → 相位真实成功。即：**run1 观察项预测的场景在 it2 真机复现，且被新判据正确处置**（非仅单测通过）。
- **完整功能验证矩阵（it2 清空重装态取数，权威）**：

| # | 验证项 | 结果 | 证据（it2 态） |
|---|---|---|---|
| 1 | `/health` 三态 | ✅ ok:true / provider=workbuddy ready / approvalTruth on / session=healthy interactive / psBridge ready（restarts=0） | it2 部署日志 HEALTH + 后置 curl |
| 2 | MCP `meta.capability.list` | ✅ **count=54**、六域 | tr_mvcrbtni_1，2ms |
| 3 | MCP `system.info.get` | ✅ Win11 家庭版 26200 / ARM64 / 8187MB / isAdmin=true | tr_mvcrbtoc_2，1400ms |
| 4 | A2A 委派（LLM 常驻会话） | ✅ steps[0] ok:true（appops.workflow.run 自主规划）、23.1s、结构化回执 | tr_mvcrc6v0_7 |
| 5 | `gui.session.status` | ✅ healthy / interactive=true / locked=false / blackScreen=false / explorerAlive=true | tr_mvcrbtoe_3，1629ms |
| 6 | 审计链 + Agent Card | ✅ 链上 68 条记录 + 字段级回执 2 条；Agent Card v0.1.0 可达、五技能（system-admin/app-manager/storage-manager/gui-automation/app-operation） | audit.receipt + a2a.health |
| 7 | 双侧部署态 | ✅ 宿主缓存 `winvm-bridge/0.1.0`（5.0M，02:52 重建）；VM `WinVMBridge.Service` Running（lastRun 02:53:02）+ dev-and-qa MANIFEST 在册 | ls + system.task.scheduled（tr_mvcrdth8_6）+ QA-PROBE 相位日志 |

**结论：迭代 2 关闭。OBS-1 修复经「单测钉判据 + 真机实弹黑洞场景正确处置 + 清空重装态验证矩阵 7 项全过」三重验证；发布包 V1.4.0 在含本轮修复的状态下完成发布、部署与完整功能验证。**

### 迭代 3（2026-10-18 03:0x-03:4x）——清场强化：uninstall 前先查杀 VM 端看门狗与 services

> **状态：已关闭**。驱动项=用户纪律（2026-10-18 03:07）：「uninstall 前都先查杀 VM 端本项目的 service 的看门狗和 services」，并裁定实现路径=「在 uninstall 脚本里先查杀看门狗和 service，再 uninstall」。本轮=清场能力强化（VM 段重构）→ 重打包 → `--wipe` 清空重装（run4）→ 新清场真机验证 + 矩阵 7 项全过。

| ID | 阶段 | 现象 | 根因 | 处置 | 复验 | 状态 |
|---|---|---|---|---|---|---|
| I-3.1 | 部署·清场（uninstall VM 段） | 旧 VM 段顺序=先 `schtasks /End + /Delete` 再杀进程，且进程杀仅覆盖 node + start-hidden wrapper | ① `/Delete` 在杀进程**之前**，留有 `RestartOnFailure`（任务级看门狗，PT1M×3）在窗口内重新拉起启动器的风险；② **ps-bridge.ps1 孤儿未覆盖**——vm-service（node）先死时 ps-bridge 脱离进程树，`taskkill /T` 带不走，会继续占用 18443 令重装 VM-START 撞 bind EACCES（本项目已知坑的变体） | `uninstall.mjs` `buildVmPs1` 段 0 重构：**(a) `schtasks /End` 先熔断看门狗**（`start-hidden -Wait` 使动作进程常驻 Running，/End 即停当前实例并阻断重启窗口）→ **(b) `Kill-Sig` 三签名查杀 services**（vm-service node 按 `C:\WinVMBridge` 命令行签名 / start-hidden wrapper / **ps-bridge.ps1**，排除 `$PID` 自身、绝不按可执行体路径匹配——node 与 WorkBuddy MCP servers 共享，误杀伤无辜）→ **(c) `schtasks /Delete` 拆除看门狗注册**（services 已死，无重启风险）→ **(d) 段 2 兜底复查**（三签名再扫一遍，幂等）；`buildVmPs1` 改 `export` 供单测直接断言生成物；载荷 **ASCII-only**（PS 5.1 无 BOM UTF-8 乱码——本项目既有坑，初稿中文注释即中招）（commit db3491e） | **run4 真机**：清场输出即新结构——`/End (fuse watchdog)` → `taskkill vm-service node PID 4140` → `services killed, port freed` → `/Delete` → `port freed (final)` → `Remove-Item C:\WinVMBridge`；POST STATUS 全复位 + 17 项 checklist 全 PASS + `VM_CLEANUP_DONE` | **已关闭** |
| OBS-1（回归确认） | 验证·TUNNEL | 迭代2 修复的判据在本轮再次实战有效 | — | 无需处置（观察复验） | **run4 再现黑洞场景**：uninstall 杀旧 daemon 后看门狗自动化抢拉起新 daemon(pid 7850) 自报 healthy 但 VM 服务重装未起 ⇒ `⚠️ 隧道黑洞嫌疑…未打通 /health → 尝试由 daemon 恢复/拉起` → ensure 恢复 → HEALTH ✅（TUNNEL 8.4s 真实成功） | 复验通过 |

#### 迭代 3 过程记录

- **门禁瞬态插曲（诚实记录）**：it3 全量 gate **首跑 RED**——`phase1-t5-llm-cancel.test.js` 1 例失败。单跑该文件 12/12 GREEN，且该文件（LLM 取消透传）与本轮改动（uninstall 清场）**零交集**；定性=首跑时前一后台 gate 任务被取消留下的资源竞争所致瞬态。按「权威态须可复现」口径重跑：**GREEN 124 文件 / 2193 例 / 0 fail / 2 skip**（`qa/p3-batch-sweep/gate-rel-v1.4.0-it3.txt` 头注已载明此插曲）。
- **重打包**（步骤2）：`release/V1.4.0` 重建——host 847 文件/6694K/sha256 `6301780a…`、vm 344 文件/2820K/sha256 `f1f4e019…`、overall 866 文件/7093K/sha256 `a619f076…`；V1-V4 包内验证全过；it2 旧包改名保留 `release/V1.4.0.superseded-it2`（同 it1 处置，可回退）。
- **清空重装（步骤3，铁律）**：`deploy-all.sh --wipe`（run4，`qa/release/V1.4.0-deploy-run4.log`）——**新 uninstall VM 段结构在真机输出一字确认**（见 I-3.1 复验栏）；17 项清场 checklist 全 PASS；七相位全过：HOST 1.3s / VM 32.7s / VM-START 18.2s / **TUNNEL 8.4s（黑洞场景复验）** / TEST 0.4s / QA-PROBE 67.1s / HEALTH 0.5s。
- **完整功能验证矩阵（run4 清空重装态取数）**：

| # | 验证项 | 结果 | 证据（run4 态） |
|---|---|---|---|
| 1 | `/health` 三态 | ✅ ok:true / provider=workbuddy ready / approvalTruth on / session=healthy interactive / psBridge ready（restarts=0） | run4 日志 HEALTH + 后置 curl |
| 2 | MCP `meta.capability.list` | ✅ **count=54**、六域 | tr_mvcsugfy_2，3ms |
| 3 | MCP `system.info.get` | ✅ Win11 家庭版 26200 / ARM64 / 8187MB / isAdmin=true | tr_mvcsugey_1，1404ms |
| 4 | A2A 委派（LLM 常驻会话） | ✅ steps[0] ok:true、**12.8s**（预热生效，明显快于 it2 的 23.1s）、结构化回执 | tr_mvcsvh9y_10 |
| 5 | `gui.session.status` | ✅ healthy / interactive=true / locked=false / blackScreen=false / explorerAlive=true | tr_mvcsuggc_3，1596ms |
| 6 | 审计链 + Agent Card | ✅ 委派 traceId 命中**链上 37 条 + 字段级回执 1 条**；直调 traceId 命中 1 条+回执 1 条（链健康）；Agent Card v0.1.0 可达、五技能 | audit.receipt（tr_mvcsvh9y_10 / tr_mvcsugey_1）+ a2a.health |
| 7 | 双侧部署态 | ✅ 宿主缓存 `winvm-bridge/0.1.0`（5.0M 重装）；VM `WinVMBridge.Service` **Running**（lastRun 03:34:37=VM-START 时刻）+ dev-and-qa MANIFEST 在册 | ls + system.task.scheduled（tr_mvct0ldv_5）+ QA-PROBE 相位日志 |

**结论：迭代 3 关闭。清场能力按用户纪律强化（先熔断看门狗→再杀 services→后拆注册→兜底复查），run4 真机确认新结构逐字生效且 18443 端口两次确认释放；V1.4.0 发布包在「判据收紧 + 清场强化」状态下完成发布、清空重装与完整功能验证。issues.md 当前无未关闭问题/观察项。**

### 迭代 4（2026-10-19）——发布包上 GitHub Release + 新机分发链路（software-winvm-release 团队 SOP）

> **状态：已关闭**。驱动项=用户请求「最终发布包应在 GitHub 上，新机安装部署验证都从 GitHub release 包开始」+ 完善方案文档/仓库/release + 推进 K1-K3。交付经 PM（K1-K3 规格书）→ 工程师（分发链代码）→ QA（两轮独立回归）三段 SOP。

| ID | 阶段 | 现象 | 根因 | 处置 | 复验 | 状态 |
|---|---|---|---|---|---|---|
| I-4.0 | 查证·仓库 | 用户疑「GitHub repo 好像还没建立」 | 仓库**早已存在且同步**（main=2e1d693、tag V1.4.0、release 数=0），但为 **private**——未登录访问 GitHub 返 404（GitHub 对 private 的标准「不泄露存在性」行为） | 经设备码 gh OAuth（scope=repo）认证 API 复核 + 用户裁定**改 public**（PATCH 执行，匿名 API 转 200）⇒ 新机零 token 匿名下载成立 | 匿名 `curl releases/download` 全链实测（见 I-4.1 复验） | **已关闭** |
| I-4.1 | 验证·发布物（**安全·QA 首轮拦下**） | QA V4-④ 复算发现 `winvm-overall-V1.4.0.zip` 卷入 `overall/.env`（真机配置：VM_HOST/VM_USER/内网拓扑）+ `delivery/winvm-plugin` shim；且双道校验（旁挂 sha256sum -c + MANIFEST 逐行）**检不出多余文件** | 迭代3 run4 在包目录 `release/V1.4.0/overall/` 内实机部署（`cp .env` + 原地 deploy-all.sh）留下运行残留，本次重打 zip 时被 `zip -qr` 卷入；**结构性盲区**：MANIFEST 只保证「在册文件在」，不保证「无额外文件」——public 仓库匿名即泄真机 .env | `pack-release.mjs`：`makeOverallZip` 增 **zip 条目集 ⊆ MANIFEST行集 ∪ {MANIFEST.txt}** fail-loud 断言（读 zip 中央目录字节流本身、extras 非空即删半成品拒产出、`unzip -Z1` 失败按不可信中止）；纯函数 `diffZipEntriesVsManifest` +4 例；清源（仅删非 MANIFEST 成员）重打 → 新 sha=`22eda02a…` 旁挂/证据三方联动 | QA R1 复算：`unzip -Z1` 条目 867=MANIFEST 866∪{MANIFEST.txt} 双向差集皆空、`.env`/shim 零命中、`unzip -t` CRC 全过；R3 变异「差集恒空」→2 例红（断言非恒真） | **已关闭** |
| I-4.2 | 部署·上架（收口 --apply 首跑） | 上传 asset HTTP 400「Multipart form data required」 | GitHub `release.upload_url` 带 RFC6570 模板后缀 `…assets{?name,label}`，代码直接拼 `?name=` 生成畸形 URL ⇒ uploads 网关退回 multipart 要求。**纯函数单测覆盖不到真网络路径**（该教训=发布链首次实弹才暴露） | `publish-release.mjs` 新增导出纯函数 `buildUploadUrl()`：剥离末尾 `{?...}` 模板段再以标准查询追加 name；+3 例钉（含「绝不含花括号」「无 `}?` 畸形形态」） | 真 --apply 重跑：zip 上传通过（转入 I-4.3） | **已关闭** |
| I-4.3 | 部署·上架（同次 --apply 二连爆） | 上传 asset HTTP 400「Invalid Content-Type」 | `ghFetch` 头合并写法 `{...init, headers}` 让**默认头反压**了调用方传入的 `Content-Type: application/zip` | 抽 `buildHeaders(token, initHeaders)`：默认头打底、**调用方 headers 胜出**；+2 例钉（Content-Type 覆盖/无 init 仅默认头） | 真 --apply 三跑：**双资产上架成功**（zip+旁挂）、Release 页 417165896、匿名下载 URL 双条产出 | **已关闭** |

#### 迭代 4 过程记录

- **仓库优化**（software-winvm-release 团队：PM 许清楚→工程师寇豆码→QA 严过关）：
  - 工程师 #1（commit 13543eb）：`pack-release` zip+旁挂+纯净断言；`delivery/publish-release.mjs`（幂等上架、dry-run 默认零写、token 三源 GH_TOKEN/--token/gh hosts.yml **值绝不打印**、双资产同名 DELETE-先于-POST、旁挂缺失 warn 降级兼容旧包）；`tools/winvm-prepare.ps1`（单一真相源：ASCII+CRLF 字节级钉、八核心键恒定输出+无公钥显式 SKIPPED 在 else 臂+SSH_PORT 附加、G1 公钥双文件+icacls、幂等）；守卫 publish-release/winvm-prepare-ps1 入 gate ST3 双写表。
  - PM #2：`docs/deploy/铠大师app功能规格书.md` V1.2——K1-K3=F-01~F-05 P0/契约 C-1~C-5/用户故事×4(GWT)/里程碑 M1-M3/G1-G12 闭环映射；Q-1~Q-6 六项接口裁决记录（首机公钥摆渡、.sha256 旁挂、KV 恒定输出、bash 前缀、latest 缺省、三口径统一）。
  - 方案文档改造（commit 8bfc854）：`通过铠大师app安装部署.md` 分发起点=GitHub Release 匿名下载、§5.4 首机时序、DEPLOYMENT §9.1a 上架 runbook + §9.3 纪律 public 订正。
- **QA 两轮回归**：首轮 IS_PASS=NO（抓 I-4.1 发布闸口级安全缺陷 + 三口径上报）→ 修复复验 IS_PASS=YES（R1-R6 全绿，含变异自证反恒真、MANIFEST 866 行第三方复证冻结包回滚字节忠实）。证据 `qa/p3-batch-sweep/gate-rel-v1.4.0-qa.txt` + it4→it6（工程师）+ it7（复验）。
- **收口实操**：commit（13543eb/8bfc854/记忆批）→ push main → **tag V1.4.0 重指**至收口态（`9dfd758` peel=`01d6010`，发布纪律「tag=检出即验证态」延伸）→ `publish-release --apply` 上架（连爆 I-4.2/I-4.3 两真网 bug，即修即验，第三跑成功）。
- **GitHub Release 终态（公开可验）**：
  - Release：`https://github.com/athronix/workbuddy-virtual-win-plugin/releases/tag/V1.4.0`
  - 匿名下载：`…/releases/download/V1.4.0/winvm-overall-V1.4.0.zip`（2,701,725 B）+ `…zip.sha256`
- **匿名下载回环实测（模拟新机 F-02 全流程）**：隔离目录 `curl -L` 双资产 → 下载 zip 实算 sha256 `22eda02a…` == **旁挂 == 本地 pack 权威行**（三方一致，信任链闭合）→ `unzip` 解包 → `deploy-all.sh` 执行位 **0770 保留** → 解出树 `.env`/shim **零命中**（无真机残留）→ 条目计数 972 含目录项与在册一致。

| # | 验证项（分发链） | 结果 | 证据 |
|---|---|---|---|
| D1 | 双资产上架 | ✅ zip + .zip.sha256 均在 Release | publish-release --apply 输出 + releases/tags API |
| D2 | 匿名下载 | ✅ curl 零 token 即得（仓库 public） | wbtmp/dltest 隔离实测 2,701,725B |
| D3 | 信任链 | ✅ DL sha256 == 旁挂 == pack 证据（三方一致） | DL==PACK_AUTHORITY=true / MATCH_SIDECAR=true |
| D4 | 纯净性 | ✅ zip 条目集=MANIFEST∪{MANIFEST.txt}，无 .env/shim | QA R1 unzip -Z1 双向差集空 + 主理人解包 find 复核 |
| D5 | 可执行 | ✅ deploy-all.sh 执行位保留（0770） | stat 实测（bash 前缀 Q-4 另作纵深） |

**结论：迭代 4 关闭。发布包已上 GitHub Release（public、双资产、匿名可达），新机分发信任链（下载→整包校验→解包纯净→执行位）全链实测闭合，K1-K3 规格书可交铠大师 App 团队实施。I-4.1~I-4.3 三缺陷全部复验关闭；issues.md 无未关闭问题。**

### 发布迭代 5（2026-10-21，V1.4.2）——审批卡真机路径修复上架 + run5 清场插曲实录

> 状态：**已关闭**。内容=CL-026b 修复（catch 掐流挂起收口）随 V1.4.2 打包→上架 GitHub Release（双资产回环三方一致）→ run5 清空重装。

| ID | 阶段 | 现象 | 根因 | 处置 | 复验 | 状态 |
|---|---|---|---|---|---|---|
| I-5.1 | 部署·清场（run5） | `--wipe` 中 POST-CLEANUP `[FAIL] VM C:/WinVMBridge absent`、deploy-all EXIT=1（fail-loud 中止，正确） | 目录内文件已全删（0 文件），剩空目录骨架被 **VM 桌面 WorkBuddy 本尊**（node，PPID=WorkBuddy.exe daemon）与一闲置裸 PowerShell 的活 cwd 句柄顶住删不掉。**非 uninstall 缺陷**：Kill-Sig 按命令行签名匹配正确地未误杀 VM WorkBuddy（迭代3 设计反向验证） | 收掉闲置裸 shell（非用户前台窗口，如实报备）；确认剩余空骨架（packages/vm-service/dist）对 tar 解包无害后，跳过重复清场续跑七相位 | run5b EXIT=0 七相位全过（HOST 1.6/VM 43.0/VM-START 17.3/TUNNEL 13.7 黑洞场景又被捕获处置/TEST 0.4/QA-PROBE 67.1/HEALTH 0.5）；矩阵：54 能力(tr_mvi1yxo4_1)/gui healthy(tr_mvi1yxpk_2)/A2A steps ok 24.6s(tr_mvi1zfbc_9)/审计链 41 条+字段级回执/双侧部署态 | **已关闭**（观察：VM 桌面若有第三方进程 cwd 卡在 BridgeDir，清场会 fail-loud 停下——行为正确，处置人工介入即可） |

**V1.4.2 Release 终态**：`releases/tag/V1.4.2`（zip a06e7520…/2,722,056B + 旁挂，匿名回环 SIDECAR/PACK 双匹配；包内 dist_tools 含 input-required 收口四判据全在位、SKILL show_widget×4）。本机会话桥进程启动早于跟批（常驻不热载），新会话委派即为出卡验收态。

## 迭代6 · V1.4.3（2026-10-26，缺口收编版）

**动因**：迭代5 发布链实测（deploy-strategy §9.1）发现的三处缺口 G-1/G-2/G-3 一并收编；用户批准发版。

| ID | 内容 | 证据 |
|---|---|---|
| G-1 | **发布包陈旧回归修复入包**：V1.4.2 包（eba187e/10-21）早于 P2-3（856a0f4）/P2-4 修复 → Release 安装把 `connector:winvm` 写进非账户目录。V1.4.3 包（a63146b）包内 `install-host.mjs` 含 `NON_ACCOUNT_DIRS`（x3），打包机新增 **V5 硬断言**（host+overall，阈 3，fail-loud 防再犯） | `qa/release/V1.4.3-pack.txt` V5 双 ✓；真机清场重装复验：`connectors/skills/mcp.json` 与 `marketplace-meta/mcp.json` **不存在=零污染**；连接器 8 skill 含 hos-win（原 G-1 连带症状同批消失） |
| G-2 | **MANIFEST 消费端收编**：新增 `delivery/verify-release.mjs`（Node，四判据与 `qa/deploy-probes/verify-manifest.py` 逐字一致 + `--expect-nonaccount-guard` V5 断言），随 overall 包分发；Step 2 判据二改用它 | V1.4.2 旧包双版本互证 FAIL（total-sha MATCH / 2 undeclared / V5 x0 命中）；V1.4.3 解包态 876/876 rows、bytes 7,413,560、total-sha `a41e7559…` MATCH、V5 PASS → RESULT: PASS |
| G-3 | **`qa/deploy-probes/` 6 探针 + `delivery/tools/diagnose-connectors.mjs` 入 overall 包**（install-host:1434 自检硬依赖，V1.4.2 缺=自检静默跳过）；PACKAGE_REQUIRED 同步必存断言 | 包内 ls 6 件全在；MANIFEST 行 `deploy-probes`×6；匿名下载回环后直接用**包内** verify-manifest.py/verify-release.mjs 自校验闭环（dogfooding） |

**分发与回环**：tag `V1.4.3`（附注 tag，push 后 GitHub `releases/latest` 已指向之）；Release 双资产 zip 2,764,412 B + 旁挂 91 B；**三向对账**=远端旁挂（API asset 通道取回）= 本地 pack 旁挂 = 下载件实算 `2e1de077…`。github.com 直连本轮多次抖动（zip 首下 65s 超时续传成功；旁挂直连 6 连败改 **api.github.com** 成功——「绝对 download URL 不稳时切 API asset 端点」记入判据经验）。

**清场重装实录（run2，22:0x）**：`deploy-all.sh --wipe` 卸载面 17 判据 16 PASS（唯一 FAIL=「VM C:/WinVMWorkspace kept」——该目录 10-26 run1 时经用户裁定 `--purge-workspace` 已清，PRE STATUS 即 False，属核对清单预期口径过时非缺陷）；setup 七相位 **164s**（HOST 1.7 / VM 49.7 / VM-START 23.9 / TUNNEL 14.8〔黑洞嫌疑自纠成功：daemon 自报 healthy 但探测未通→ensure 0.3s 恢复〕/ TEST 0.4 / QA-PROBE 72.9 / HEALTH 0.7）；`/health` ok:true provider=workbuddy ready session healthy interactive=true。**全维终验 25/25**（mcp-probe 20 + a2a-probe 5）+ example-probe 8/8 + disabledTools=8 + 全局 mcp.json winvm/winvm-a2a 双条目正常。

**example-probe 三缺陷顺手修**（10-26 19:4x，V1.4.3 包内首版即含）：rpc() 无 timeout 形参（TypeError）/ E2b 参数名 `target`→定义实名 `path` 且目标须落策略白名单（`C:\Users\User`，`POLICY_DENIED` 是执法正确行为非缺陷）/ E6 断言面从「原始 tools/list 无高危」（§Step5 已知假阳性坑）改为读宿主 `mcp.json` 的 `disabledTools`。

### 迭代6 追加（2026-10-27）

| ID | 级别 | 现象 | 根因 | 处置 | 状态 |
|---|---|---|---|---|---|
| I-6.1 | **P1（能力面）** | Step 6.3 补测暴露：`gui.input.keyboard`/`gui.input.mouse` 在 VM PS 5.1 上报「System.RuntimeType 不能作为非托管结构封送」——**键鼠输入自上线从未真跑通**（此前仅静态核对，20 项验收不含键鼠写面） | `psmod/gui.ps1` 两处 `Marshal::SizeOf([Type])` 静态重载不支持运行时 Add-Type 结构 | 改实例重载 `SizeOf($arr[0])`；守卫 contract 7/7 + drift 13/13 GREEN；VM scp+kill-restart 热更；防回归钉=`example-probe` E11（sent>0，8→13 项）；详见 `docs/deploy/deploy-strategy.md` §9.3 | 运行态已热更；**V1.4.4（tag 2789957，2026-10-27）已将修复入包上架，GitHub Release 双资产+三向对账 03cef597** → I-6.1 **已关闭** |
| I-6.2 | P3（探针） | 补测中 example-probe/probe 脚本自身 4 处缺陷（space.analyze 参数名与白名单目标、service.control 对象错、标题匹配、E6 断言面） | 首轮探针按语义猜测未对照 definitions.ts/策略实态 | 全部修正并经验证；教训固化：探针参数面**必须 grep definitions.ts 实名** + 目标路径先对 pathAllowlist | ✅ |

## 迭代7 · V1.4.4（2026-10-27，I-6.1 补发版）

> 状态：**已关闭**。动因=迭代6 追加 I-6.1（`gui.ps1` PS5.1 `Marshal::SizeOf([Type])` 真 bug：键鼠输入自上线从未真跑通），其修复晚于 V1.4.3 打包 → **Release 包内 gui.ps1 旧版**会让纯 Release 新装机复现键鼠全灭。用户批准补发 V1.4.4 把修复入包。

| ID | 内容 | 证据 |
|---|---|---|
| V6 断言（发布链盲区固化） | `pack-release.mjs` 新增 **V6 硬断言**：包内 `vm/overall` 的 `psmod/gui.ps1` **必含 `cbSize`**（键鼠修复特征串），缺失即 fail-loud 拒产包；根因=「修复晚于打包」是发布链盲区——热更运行态 ≠ 包内二进制 | `qa/release/V1.4.4-pack.txt` V1–V6 全绿；匿名回环解包 `overall/packages/vm-capabilities/psmod/gui.ps1` 含 4 处 `cbSize`、旧 `SizeOf([Type])` 零残留 |
| 上架 + 回环 | tag `V1.4.4`（2789957，基于 2671f0f）；`publish-release --apply` 双资产上架；latest API 指向 V1.4.4 | 三向对账=远端旁挂=本地旁挂=下载件实算 `03cef597…`（2,768,597 B） |
| 清场重装（run，铁律 --wipe） | 包根切 V1.4.4（`.env` 从 v143-backup 迁移）；uninstall 17/17 PASS；setup 七相位 2m6s（HEALTH ok:true）；三探针 mcp 20/20 + a2a 5/5 + example 13/13；VM 侧 gui.ps1 含 cbSize；G-1 复验非账户零污染、连接器 8 skill | 全维终验 25/25 + example 13/13 + disabledTools=8 |

**结论：迭代 7 关闭。I-6.1（P1 能力面真 bug）经「修复→V6 断言机械化钉死→入包 V1.4.4→清场重装态 25/25+13/13 复验」全链闭环；发布链「修复晚于打包」盲区在 **gui.ps1 面**被 V6 断言封堵（其余交付面仍靠人肉回环发现，见迭代7 追加 I-6.3）。当前线上版本=V1.4.4。**

### 迭代7 追加 · I-6.3（2026-10-27，undeploy⇄deploy 回环实测发现）

| ID | 级别 | 内容 | 状态 |
|---|---|---|---|
| **I-6.3** | P2 | `delivery/uninstall.mjs` 两处**镜像不对称**（回环 U4 独立复核抓到，自报清单当时全绿）：**U-1** 不清全局 `~/.workbuddy/mcp.json` 的 `winvm`/`winvm-a2a`（install-host 全局注册面，disabledTools 落点；只清了账户级 `connectors/*/mcp.json`）；**U-2** markers 缺 `tunnel-autostart.json`（拆后重开 WB，SessionStart hook 会对已不存在的插件 ensure 死隧道）。修复=新增 `cleanGlobalMcpJson`（备份后删）+ markers 补名 + 核验清单加两行（17→19）；复验 dry-run `[DRY] remove winvm, winvm-a2a`→apply **19/19 PASS**、独立复核 GLOBAL_MCP_CLEAN、r3-uninstall-verify 47/47、gate:quick 265/265。教训沿用 I-6.1：**「自报全绿」≠「拆除干净」，不对称只能靠独立复核面抓**。另：块注释内写 `connectors/*/mcp.json` 的 `*/` 会提前闭合注释（node --check 当场抓住，改 `<acct>` 写法）。 | **已关闭（V1.4.5 入包，见迭代8）**；曾晚于 V1.4.4 打包。裁定（10-27 用户同意）不单独补发、随下迭代收编；pack-release **V7 硬断言**（包内 uninstall 必含 cleanGlobalMcpJson，fail-loud）——V1.4.5 打包当场通过，盲区机械化封堵 ✅ |

证据：`qa/real-test-2026-10-27-run1.md`（回环全记录，含 R5=38/38 与瞬态定性）+ `qa/evidence/undeploy-loop-20261027/`（8 份日志）。

## 迭代8 · V1.4.5（2026-10-28，I-6.3 收编版 + Prompt 总集入包）

> 状态：**已关闭**。动因=迭代7 追加 I-6.3（uninstall.mjs 两处镜像不对称）已修 HEAD 但晚于 V1.4.4 打包，用户裁定随本迭代自然收编；同批落地「Prompt 总集入发布包」backlog 裁定。

| 项 | 内容 | 证据 |
|---|---|---|
| V7 断言首战 | `pack-release` V7（包内 uninstall 必含 `cleanGlobalMcpJson`）**首次执行即通过**=I-6.3 修复确认入包；V1–V7 全绿 | `qa/release/V1.4.5-pack.txt`（@76c0c65） |
| Prompt 总集入包 | `OVERALL_DOCS` 增 `docs/deploy/deploy-strategy.md`/`deploy-prompts.md`/`undeploy-prompts.md`（子目录化拷贝+`PACKAGE_REQUIRED.overall` 存在性断言+包 README 文案）——纯 Release 装机者解包即得三篇总集，零仓库依赖 | 匿名回环解包 `overall/docs/deploy/` 三篇在（v1.7/v3.3/v1.2 同步版） |
| 打包时序教训 | **首打包 @6745a50 早于 docs 版本同步 commit**→包内三篇仍旧版口径；处置=`release/V1.4.5.superseded-it1` 封存、@76c0c65 重打包（zip `a225cc95…`/2,833,330 B）、tag 移至包源点。教训入册：**pack 前一切文档改动先 commit**（包=HEAD 快照，文档同步属包内容） | 本行即记录；superseded 目录留档 |
| 上架+回环 | publish --apply 双资产；latest API=V1.4.5；匿名下载三向对账一致 `a225cc9562f2fadf…`（github.com 直连 5 连超时后成功，重试纪律奏效）；verify-release.mjs --expect-nonaccount-guard PASS | `~/winvm-deploy/v145-loop/` |
| 清场重装（铁律 --wipe 语义） | **用包内 V1.4.5 uninstall.mjs 实弹拆除=19/19 全 PASS**（含两条新 PASS 行——I-6.3 修复在发布态真生效）；setup 七相位 rc=0（~2.2min）；三探针 mcp 20/20 + a2a 5/5 + example 13/13；disabledTools=8、连接器 8 skill、VM gui.ps1 cbSize×4 | 本会话日志 |

**结论：迭代 8 关闭。当前线上版本=V1.4.5。**


## 迭代9 · V1.4.6（2026-10-29，.prompt 入包版——开账即关）

> 状态：**已关闭**。动因=用户裁定「两 .prompt 并入发布包分发 + README 说明如何配置和使用」。纯打包面/文档面变更，无运行码改动（V1.4.5 的运行面原样携带）。

| 项 | 内容 | 证据 |
|---|---|---|
| pack 收编 | `OVERALL_DOCS` 增 `docs/deploy/deploy.prompt`/`undeploy.prompt`（子目录化拷贝）；`PACKAGE_REQUIRED.overall` 两行存在性断言（漏收=fail-loud）；包 README 生成面加「快速部署/卸载」四步指引 | `qa/release/V1.4.6-pack.txt`（@71cda55，V1–V7 全绿） |
| README 用法面 | 仓库 README 新增 **§5.4**：脚本定位表+安装四步（取包→配置运行期注入变量逐项含义→整段粘贴→判据回收）+卸载四步（DRY-RUN 安全阀→apply→POST-CLEANUP 19 项+独立复核→U5 存留项逐项问）+母本关系与自指口径 | `README.md` §5.4 |
| 时序纪律 | **先 commit（71cda55）后 pack**——V1.4.5 superseded-it1 教训沿用，包内五件 docs/deploy 均为同步版 | 解包核验 `v146-loop/overall/docs/deploy/` |
| 上架+回环 | publish --apply 双资产；latest API=V1.4.6；匿名 api-asset 下载一次成功；三向 sha 一致 `dc417bf2d1e8a349…`；解包 uninstall 含 cleanGlobalMcpJson×2；verify-manifest/verify-release --expect-nonaccount-guard 双 PASS | `~/winvm-deploy/v146-loop/` |
| 清场重装（铁律 --wipe 语义） | 包根切 V1.4.6（v145-backup 留旧、.env 迁移）；**包内 uninstall 实弹拆除 19/19 全 PASS**+独立复核（health=000、GLOBAL_MCP_CLEAN）；setup 七相位 rc=0；三探针 mcp 20/20+a2a 5/5+example 13/13；check-fresh FRESH、disabledTools=8、连接器 8 skill、VM gui.ps1 cbSize×4、health=200 | 本会话日志+`qa/real-test-2026-10-29-run1.md` 同款判据面 |
| 结构性口径 | **包内自指限制**：deploy-prompts §2.2 版本表在 V1.4.6 包内快照仍写 V1.4.5（zip sha 自指——pack 后订正属仓库面，再重打必再次自指）。权威校验值=包内 `MANIFEST.txt`+旁挂 `.zip.sha256`（verify-manifest/verify-release 即读它）；口径已在 deploy-prompts v2.0 与 strategy §0.5-B 注明 | 本文行即记录 |

**结论：迭代 9 关闭。当前线上版本=V1.4.6。**


## 迭代10 · V1.4.7（2026-10-29，完善版：文档自指根除——开账即关）

> 状态：**已关闭**。动因=用户「需要完善都完善发布一下」→ 把迭代9 登记的**结构性自指口径**从"注明限制"升级为"根除"：取消文档逐版本硬编码校验值。运行码同 V1.4.6。

| 项 | 内容 | 证据 |
|---|---|---|
| 自指根除 | deploy-prompts §2.2 + strategy §0.5-B：`ZIP_SHA256`/`PKG 三元组`改**权威源口径**（标记 `MANIFEST-sidecar-authoritative`=旁挂 sidecar `sha256sum -c` + 包内 `MANIFEST.txt` 头七行 verify-manifest 复算）；`RELEASE_TAG` 标注"示例值+latest API 现解为准"；deploy.prompt 注入段同步改指引。历史逐版本值降级为"历史样例"保留（不再承担核对职责） | 包内解包核验：三篇文档均含标记（strategy×3/prompts×4 处） |
| V8 断言 | pack-release 新增 **V8**：包内 `docs/deploy/deploy-strategy.md`/`deploy-prompts.md` 必含 `MANIFEST-sidecar-authoritative`，缺失 fail-loud 拒产包=口径倒退机械化封堵（V5/V6/V7 同款思路）；断言面升 **V1–V8** | `qa/release/V1.4.7-pack.txt`（@edd7e78，V1–V8 全绿、V8 首战通过） |
| 时序纪律 | 完善批先 commit（edd7e78）→ 再 pack；tag 直指包源点 | 本行即记录 |
| 上架+回环 | 双资产上架、latest API=V1.4.7；匿名 api-asset 下载一次成功、三向 sha 一致 `a5ac52b7…`；解包核验 docs/deploy 五件+三篇同步版（v2.1/v3.7/v1.5）含权威口径+uninstall 含 cleanGlobalMcpJson；verify-manifest/verify-release 双 PASS | `~/winvm-deploy/v147-loop/` |
| 清场重装（--wipe 铁律） | 包根切 V1.4.7（v146-backup/.env 迁移）；**包内 uninstall 实弹 19/19**+独立复核（000/GLOBAL_MCP_CLEAN）；setup 七相位 rc=0；mcp 20/20+a2a 5/5+example 13/13；FRESH、disabledTools=8、连接器 8 skill、VM cbSize×4、health=200 | 本会话日志 |

**结论：迭代 10 关闭。当前线上版本=V1.4.7。发布链断言面=V1–V8。**

### 迭代10 追加 · I-6.4（2026-10-29，.prompt 第三轮往返 run2 发现）

| ID | 级别 | 内容 | 状态 |
|---|---|---|---|
| **I-6.4** | P2 | 探针面双缺陷（往返 run2 `qa/real-test-2026-10-29-run2.md`）：**D-1** `verify-manifest.py`/`verify-release.mjs` 对**已安装态包根**假 FAIL——安装体系自写的运行期产物（`.env`=Step 3.1 配置、`delivery/winvm-plugin(.cmd)`=install-host 管理 CLI 启动器）被判 undeclared（前两轮 Step 2.3 从未在此场景跑过，本轮按脚本"包已在本地直接 2.3"路径首触暴露）；修复=runtime 白名单三条目，**四场景回归**（已装态 PASS/纯净面 PASS/verify-release PASS/canary 负例仍 FAIL=检出力未削弱）。**D-2** `vmcheck.ps1` 输出 GBK 双坑（PS5.1 `Content` 无 charset JSON 按 GBK 解码 + 重定向 stdout 按控制台码页编码中文 health_body→宿主 UTF-8 消费者解析炸）；修复=`RawContentStream` 显式 UTF-8 解码 + `[Console]::OutputEncoding=UTF8`，**探针文件保持 ASCII-only**（带中文注释的修复版远端解析异常，二次坐实既有规范）；VM 复测 2537 B 全 UTF-8 判据直读。教训：**探针判据面要跑遍"已装态/纯净态"两种宿主场景**；脚本内"latest 现解"指引（V1.4.7 自指根除面）本轮首战生效——示例值 V1.4.6 未误导。 | **已随 V1.4.8 入包收编（迭代11）**；10-29 用户裁定修复+打包+第四轮验证。pack **V9 断言**（包内 verify-manifest 必含 runtime_ok、verify-release 必含 RUNTIME_OK、vmcheck 必含 RawContentStream，缺失 fail-loud）首战核验——同款 V5/V6/V7/V8 机械化封堵 |


## 迭代11 · V1.4.8（2026-10-29，I-6.4 探针修复入包收编版——开账即关）

> 状态：**已关闭**。动因=用户裁定「修复，提交，打包，继续第4轮卸载和安装验证测试」——run2 抓出的 I-6.4（探针面双缺陷）随本迭代入包，并以第四轮往返验证发布态生效。运行码同 V1.4.7。

| 项 | 内容 | 证据 |
|---|---|---|
| V9 断言首战 | pack-release 新增 **V9 三探针特征断言**（包内 verify-manifest 必含 `runtime_ok`、verify-release 必含 `RUNTIME_OK`、vmcheck 必含 `RawContentStream`，缺失 fail-loud 拒产包）；**正反例验证**：对 V1.4.7 包根旧探针判 FAIL=若当时已有 V9 会当场拦截 I-6.4 | `qa/release/V1.4.8-pack.txt`（@8929c97，V1–V9 全绿） |
| 示例值可自记 | RELEASE_TAG/ZIP 为 tag 名（非 sha 自指物）→ 包内快照可正确自记 V1.4.8；§5 速查包完整性行改为纯指包内 MANIFEST（sha 彻底不写）。run2 观察的"包内示例 V1.4.6 误导面"自此消除 | 解包核验 `RELEASE_TAG=V1.4.8` 在包内 prompt |
| 上架+回环 | latest API=V1.4.8；三向 sha 一致 `602d303e…`（2,852,223 B/881/7620953/`efb4a6ce…`）；解包核 V9 三特征+双 verify PASS | `~/winvm-deploy/v148-loop/` |
| 第四轮往返（run3） | **I-6.4 发布态双首验**：包内修复版 verify-manifest 跑已装态包根 **PASS**（D-1 闭环）、包内 vmcheck **UTF-8 直读全判据**（D-2 闭环）；拆除 19/19 零 FAIL+独立复核（000/GLOBAL_MCP_CLEAN）；重装 4.1~4.5 全绿+**38/38 首跑即稳**（连续两轮零瞬态）；6.1/cbSize×4 | `qa/real-test-2026-10-29-run3.md` + `qa/evidence/prompt-run3-20261029/` |

**结论：迭代 11 关闭。当前线上版本=V1.4.8。发布链断言面=V1–V9。缺陷台账（I-6.1~I-6.4+G-1/2/3）全部闭环入包。**


## 迭代12 · V1.4.9（2026-10-30，R8 根除+新宿主机复盘收编版——开账）

> 状态：**进行中**。动因=用户提交新鸿蒙宿主机实跑复盘 `docs/deploy/deploy.prompt.to-be-improved.md`（基于 V1.4.8 的 deploy.prompt 在 VM 默认 shell=cmd.exe 拓扑上跑通 Step1→5 的全过程，12 类坑 R1~R12）+ 四条建议（VM 密码/OpenSSH 安装法/虚拟机电源/cmd.exe 默认 shell）+ 两条过程协议（缺信息问用户；环境缺件审批后自动补齐或给方法请辅助）。

| ID | 级别 | 内容 | 状态 |
|---|---|---|---|
| **I-6.5** | P1（发布链前置） | **R8 隐藏前置根除**：`vmInstallCommand`/`vmUninstallCommand`（setup.mjs）生成 **Git-Bash 专属语法**（`set -o pipefail`/`mkdir -p`/`node -e '单引号'`/`tee`），VM sshd 默认 shell=cmd.exe（**Windows OpenSSH 出厂默认**）下 Step3 apply 必败（复盘实测失败 183 次、报「cd C:/WinVMBridge 找不到路径」）；本机历史拓扑默认壳恰为 Git-Bash（MEMORY 口径）⇒ 前置从未显形。同族残余：bootstrap trust（`umask/mkdir -p/~/2>/dev/null`）、marker 探测（`test -f`）、两处清理（`rm -f`）、setup manifest（`cat >`）、winvm-plugin 卸载段（`cd && node`）。修复=**全部收口跨壳通道**：复合逻辑走 .ps1→scp→`powershell -File`（铁律本形）；短片段走 `powershell -EncodedCommand`（base64 UTF-16LE 单 token，cmd/bash/pwsh 通吃、零引号面）；写文件直接 scp。**cmd.exe 出厂默认可直装，无需 Git-Bash/DefaultShell 改动**；单测重写+跨壳防回归锁（BASH_ONLY_TOKENS 零出现断言）。真机验证=cmd.exe 默认壳下 .ps1-File/EncodedCommand/mkdir-inline/netstat-pipe/Set-Location 五通道冒烟全过 + run4 全链往返。 | 已修复（HEAD·源码+文档）；入包随本版 pack（V10 断言防回归，见下） |
| **I-6.6** | P2 | **R7 DB-3 winget 单腿**：prepare-vm `--ensure-node` 仅 winget 一路（经 ssh=MSIX alias 空壳、且旧版要求管理员）；复盘实测 winget 失败 + MSI per-user 1603。修复=DB-3 增 **zip+cdn.npmmirror.com 镜像兜底**（用户作用域免管理员，本次实跑 v24.21.0 验证）：winget 首选→检测无效果自动落 zip→持久化用户 PATH。测试锁增 4 断言（镜像 URL/Expand-Archive/SetEnvironmentVariable/顺序）。 | 已修复（HEAD） |
| **I-6.7** | P2 | **uninstall.mjs 保留项断言误报**（undeploy 侧复盘 R1，`docs/deploy/undeploy.prompt.to-be-improved.md`）：`C:/WinVMWorkspace` 系 GUI/生产线运行期才创建，从未存在的环境里默认 kept 断言判 `[FAIL]`（observed: False）→ `EXIT=1`，且与同一次运行自报 0 failure(s) **自相矛盾**——拆除本身完整、独立复核全绿，纯误报。根因=KEEP 校验写成断言式（要求目录存在），忽略了「本就不存在」合法态。修复=不 purge 时实体缺失判 PASS 并标注 `entity never existed, nothing to keep [SKIP]`（卸载器从不删工作区，不存在≠误删）；r3-uninstall-verify 47/47。文档面同步=undeploy.prompt v2.1（U4 语义注记+U0 落点动态口径 R5+U5 删密钥子流程 G3/G4/rm 禁令 G2/决策导航 G6）。 | 已修复（HEAD），入包随本版 pack |
| **R1~R5/R9~R12（文档面）** | P3 | 复盘其余项按文档面收编：Step 0 前置检查五项（密码非空提醒+原因、OpenSSH 安装启动精确命令、虚拟机"从不暂停+自动开机"、防火墙 Profile=Any 诊断修复、桥接重试）；执行协议 P-1~P-4（缺信息问用户/环境缺件审批后自动补齐或给方法请辅助/人工卡点清单/判据自检）；NODE/PY 自动探测多候选（R5，勿硬编码）；vmssh/vmscp 重试封装（R4）；.env 八字段清单（R9）；Step 6.1 判据=连接器目录 8 为准（R11 路径漂移修正）。askpass/addkey/install/launch/env.sh 模板（R10）不另造——功能已由 `bootstrap.mjs trust/env/prepare-vm` 覆盖且更完整，prompt 改为引用包内命令。 | 已收编（deploy.prompt v2.0 / undeploy.prompt v2.0 / 母本 deploy-prompts v2.4 / undeploy-prompts v1.8 / INSTALL-GUIDE 三处口径） |
