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

### 迭代 2 及以后

> （预留）每次迭代 = 依据本轮 issues 做仓库侧优化 → 重新打包 → 重新部署 → 重新验证。
