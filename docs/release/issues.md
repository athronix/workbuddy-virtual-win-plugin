# WinVM Bridge · 发布问题台账（issues.md）

> 组织方式：**版本 → 迭代**。每条问题四元组齐全（现象/根因/证据/路由），关闭条件=复验通过。
> 关联文档：`docs/release/DESIGN-V1.4.0.md`（发布设计）、`docs/release/RELEASE-V1.4.0.md`（发布说明）、`docs/05-peripherals/DEPLOYMENT.md`（部署 runbook）。

## V1.4.0

### 迭代 1（2026-10-18）——首发打包 + 清空重装 + 真机验证

> 状态：进行中。本迭代记录「打 tag → 打包 → 清空历史部署 → 发布包真机重装 → 完整功能验证」全过程的问题。

**部署前快照（清场前实测，2026-10-18 01:5x）**：
- 隧道：`127.0.0.1:18443/health` → `ok:true`、provider=workbuddy/ready、session.state=healthy/locked=false、psBridge.uptimeMs≈56458321/restarts=0
- 宿主：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` 在册（历史部署，0.1.0 为 package.json 插件产物版本）
- VM：`C:/WinVMBridge` + 计划任务 `WinVMBridge.Service` 在册
- tag：V1.4.0 @ 381d2d8（已推送 origin）；发布工具链 commit 链：381d2d8 → 0a54ab3 → d1965e7 → 8e10918

| ID | 阶段 | 现象 | 根因 | 处置 | 复验 | 状态 |
|---|---|---|---|---|---|---|
| I-1.1 | 部署·VM | `install-vm.mjs` 早死：`找不到 VM 服务配置：C:\WinVMBridge\delivery\vm-service.config.json`（VM 相位 8.1s 即败） | 发布包 VM 闭包漏文件：`vm-service.config.json` 是 install-vm 的**非 import 硬依赖**（读文件生成 runtime.json），pack-release 的 VM_DELIVERY 清单未列；V3 dry-run 只验证 import 闭包，抓不到此类缺失 | `pack-release.mjs`：VM_DELIVERY 补 `delivery/vm-service.config.json`；新增 `PACKAGE_REQUIRED` 三包必存结构断言（V1）；设计文档 §3.2/§六 同步（commit 39357f8） | 重打包后 V1 断言过；待重部署 | 已修复·待复验 |
| I-1.2 | 部署·VM-START | `VM_START_FAILED exit=1`（schtasks /run 无任务可触发） | I-1.1 级联：install-vm 早死 ⇒ 计划任务 `WinVMBridge.Service` 从未注册 | 随 I-1.1 修复自然消解 | 待重部署 | 级联·待复验 |
| I-1.3 | 验证·HEALTH | `/health` 三探失败；日志诊断「端口已监听但 HTTP 无响应」 | I-1.1 级联：VM 服务从未起；且 install-host 安装尾拉起的 tunnel-daemon（pid 52009）本地监听在 = **隧道黑洞**（TCP 通、后端死），TUNNEL 相位误判「复用健康」 | 随 I-1.1 修复自然消解；隧道健康判据缺陷（本地监听≠后端活）登记观察项 | 待重部署 | 级联·待复验 |
| — | — | （待填） | — | — | — | 进行中 |

### 迭代 1 补充记录

- **run1 证据**：`qa/release/V1.4.0-deploy-run1.log`（uninstall 清场 checklist 全 PASS；HOST ✅ 1.2s；VM/VM-START/HEALTH ❌；TUNNEL/TEST/QA-PROBE ✅）
- **清场验证**：`uninstall.mjs --apply` 双端 checklist 全 PASS（VM 端口无监听、无 vm-service node、OpenSSH Server 存活、WinVMWorkspace 保留）⇒「清空历史部署」能力本身成立
- **正面收获**：① HOST 相位从发布包安装成功（含插件缓存/连接器/mcp.json 合并/隧道拉起）；② QA-PROBE 推送 2/2 探针 + 部署 MANIFEST 落 VM；③ TEST 自检过
- **根因分类**：发布工程缺陷（打包闭包推导漏"读文件"型依赖），非运行态代码缺陷 ⇒ 按 DDD 场景 E 流程：根因文档化（本表）→ 仓库侧修复（39357f8）→ 重新打包 → 重新部署复验
- **观察项（不阻塞）**：TUNNEL 相位「复用常驻 daemon」的判据是本地端口监听 + daemon 健康，**未探后端 /health**；后端死时呈现"假活"。后续可在 TUNNEL 相位加一次轻量 /health 探测佐证（候选改进，列入 backlog）

### 迭代 2 及以后

> （预留）每次迭代 = 依据本轮 issues 做仓库侧优化 → 重新打包 → 重新部署 → 重新验证。
