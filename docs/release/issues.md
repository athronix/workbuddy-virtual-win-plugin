# WinVM Bridge · 发布问题台账（issues.md）

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

### 迭代 3 及以后

> （预留）每次迭代 = 依据本轮 issues 做仓库侧优化 → 重新打包 → `--wipe` 清空重装 → 重新验证。当前无未关闭问题/观察项；若用户提出新的验收要求或复验暴露新问题，按同一循环推进。
