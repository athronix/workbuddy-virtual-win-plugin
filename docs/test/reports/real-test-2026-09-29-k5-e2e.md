# K5 最终验收报告：宿主 MCP 路径端到端真机演示（2026-09-29）

> 主理人齐活林执行 · 团队 software-k5-verify-r2 · QA 独立深审见 `k5-fix-qa-2026-09-29.md`（路由 NoOne）。

## TL;DR

**K5（审批结构化回传 + 服务端确定性重放）验收 PASS**——审批卡片含真实目标、批准后服务端重放真实执行、审计链留铁证（`-replay` 条目 `approvedBy:"host"`）、任务 completed 且最终文本如实转告服务端回执。同时**暴露能力层新缺陷（→ backlog K6）**：`winget uninstall` 对企业微信报假成功（exit 0 / "Successfully uninstalled" 但磁盘无变化），真实卸载须走 NSIS `/S`——已实测完成卸载。

## 1. E2E 全链路证据（taskId 7fa3a03f-318a-4de7-9109-bf0c97d76dfc）

| 环节 | 证据 |
|------|------|
| 委派 | A2A streamMessage「卸载VM中的企业微信」（maxRisk L2，allowedCapabilities app.*/appops.*） |
| **审批卡片（K5 增强项）** | `input-required` 事件 DataPart：`type:approval-request, approvalId:apr_b544ab5b90044870b461, capabilityId:appops.workflow.run, risk:L2`，**含 `underlying:{capabilityId:"app.winget.uninstall", paramsSummary:"id=Tencent.WeCom"}`**；text part 出现「真实目标：能力 app.winget.uninstall · 参数 id=Tencent.WeCom」行 |
| 批准 | `replyApproval(taskId, apr_…, true)` → 任务回 `working` |
| **服务端确定性重放（K5 核心）** | 审计链 `audit-20260929.jsonl` seq7：`traceId: tr_mum3z2y8_6-replay`、`approvedBy:"host"`、`ok:true`、`durationMs:6564`、policy `allow:policy-passed`；前置 seq6 为 blocked 条目（`APPROVAL_REQUIRED`，未执行）。blocked→replay 哈希链完整（prevHash 衔接） |
| 终态 | `completed`；最终文本「服务端执行回执（app.winget.uninstall）：app.winget.uninstall 执行成功」——executionSuffix 注入后 LLM 如实转告，未自宣、未重复调用 |

对照 K4 时代假成功（任务 completed + 审计零执行记录），K5 不变式「**能力是否真实执行以服务端结构化回执为准**」经真机验证成立。

## 2. 冷启动波折（环境级，非 K5 缺陷）

- 第一次委派（taskId e6762a9e）failed：服务 02:36 重启后预热会话早已过 5min idle TTL 回收 → 10:05 首调撞「深度空闲冷启动」：常驻会话 60s init 超时（`lastError` 留痕）→ 降级单次 `-p` 又 >300s 超时。属记忆中 K2 明确不覆盖的 P2 边界（深度空闲后首调付冷启动）。
- 第二次委派即正常：11:19 发起 → 11:20:22 `input-required`（约 72s，单次 `-p` 路径跑通）→ 11:25 批准 → 11:26:44 `completed`（重放 6.5s + 续跑收口）。

## 3. 能力层新缺陷（K6 入 backlog）：winget 对 WeCom 静默假卸载

**现象**：K5 重放真实调用了 `winget uninstall --id Tencent.WeCom`（exit 0），VM 内手工重跑同样输出「Successfully uninstalled」——但 `WXWork.exe`（270MB）/安装目录（10931 项）/winget list 全部原样，winget 报告与磁盘事实相悖。

**根因取证**：
- WeCom 的 ARP 卸载键（HKLM WOW6432Node，键名 GBK 乱码显示但 UninstallString 明确）：`C:\Program Files (x86)\WXWork\Uninstall.exe`，**无 QuietUninstallString**。
- `Uninstall.exe` 为 NSIS（Nullsoft）打包（二进制嗅探命中 NSIS/Nullsoft//S 标志），ver 5.0.12.1001。
- 推断：winget 静默模式对该包的卸载命令未携带有效静默参数，卸载器被拉起后未执行实际卸载即返回 0（winget 只信 exit code → 假成功）。

**实测修复路径**：先杀 `WXWork` 进程 → `Uninstall.exe /S`（NSIS 静默）→ exit 0 → **`EXE_GONE` + `DIR_GONE` + `WINGET_REMOVED`**，真实卸载成功（用户已授权）。

**建议修复（K6）**：`app.winget.uninstall` 能力增加**卸载后核验**（重查 winget list / ARP 键 / 关键路径），核验失败则结果 `ok:false` 并提示改用 UninstallString /S；或对 NSIS 类包直接改用注册表 QuietUninstallString/UninstallString 执行。在修复前，winget 卸载的 `ok:true` 只代表 winget exit code，不代表磁盘事实。

## 4. 结论与状态

- **K5 桥接/审批/重放链：验收 PASS**（QA 独立深审 NoOne + 真机 E2E 双重证据）。
- **能力层 winget 假卸载：K6 待办**（本报告 §3 已给根因与修复建议）。
- 遗留环境项：深度空闲首调冷启动（K2 边界，P2）；streamMessage 长流 240s 超时断流但服务端任务不受影响（客户端观测问题，P3）。

## 5. 证据文件

- 原始事件流：`$HOME/wbtmp/k5-e2e-raw.jsonl`（审批卡片全文含 underlying）
- 驱动日志：`$HOME/wbtmp/k5-e2e-drive.log` / `k5-e2e-approve.log`（AFTER_REPLY→POLL→FINAL 全程）
- 审计链：VM `C:\Users\User\AppData\Local\WinVMBridge\audit\audit-20260929.jsonl`（seq6 blocked + seq7 -replay）
- 取证脚本：`$HOME/wbtmp/k5-audit-read.ps1` / `k5-post-uninstall.ps1` / `k5-reg-probe2.ps1` / `k5-real-uninstall.ps1`
