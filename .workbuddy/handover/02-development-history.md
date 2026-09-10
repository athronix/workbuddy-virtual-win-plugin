# 02 · 开发历史（14 轮 / 18 次提交）

> 时间跨度：2026-08-28 → 2026-09-09，共 **18 次提交**、**14 个正式轮次**（外加 3 个补丁）。
> 权威逐轮变更记录在 `.dev/changed-log.md`（462 行）；本文是**脉络与转折点**提炼。

## 提交时间线

| # | Commit | 轮次 | 主题 | 单测基线 |
|---|--------|------|------|---------|
| 1 | `056afe0` | 第一轮 | 分层解耦双通道（1+5）+ LLM provider + 双端一键部署（初始提交） | 112/112 |
| 2 | `837bee3` | 第三轮 | 宿主 A2A 委派桥 + VM 内技能下发 + ps-bridge 空闲自愈 | — |
| 3 | `6182587` | 第四轮 | `hermes-agent` VM Agent + 共享 Skills 独立部署 | — |
| 4 | `afe7d2c` | — | DEPLOYMENT 新增远程 Windows 部署与 SSH 认证 §7 | — |
| 5 | `47ac880` | — | SSH 密钥认证与双层模型同步进安全治理/.env/索引 | — |
| 6 | `28b6808` | 第五轮 | 远程分发链路修复（缺 node_modules + 缺运行时资产） | 194/194 |
| 7 | `aca7d08` | — | 真机终验：ps-bridge 中文 BOM + BUILD `spawn npm ENOENT` | — |
| 8 | `67cbe30` | — | 修 `WINVM_DRY_RUN` footgun + `/health` 独立成 HEALTH 阶段 | 198/198 |
| 9 | `d787c7f` | 第九轮 | 补 deployWinvmPlugin 持久化单测 + 输出一致性收尾 | 187/187 |
| 10 | `b1b4a63` | 第十轮 | 修 install 实跑两处崩溃（`cpSync` 未导入 / `reachable` 误判不可达） | 187/187 |
| 11 | `aecf5cc` | 第十一轮 | 隐藏 VM 控制台窗口 + 补 `buildTaskXml` 单测 | 195/195 |
| 12 | `68b4f6b` | 第十二轮 | 宿主 PATH 管理 + 移除可达性预检门禁 + 实证 Q3 根因 | 204/204 |
| 13 | `9d695a1` | 第十三轮 | 健壮化 `winvm-plugin.cmd` + 清理本机损坏 User PATH | 204/204 |
| 14 | `2b9ecbd` | 第十四轮 | VM 侧 `winvm-plugin` 可达 + 部署期持久化 VM 连接 | 214/214 |
| 15 | `928b113` | 十四轮补 | VM check 端口未监听时给出明确修复指引 | — |
| 16 | `9874092` | 十四轮补2 | 修 VM check/server status 端口探测**假阴性**（真 bug） | — |
| 17 | `aa7ea0d` | 十四轮补3 | 写 User PATH 后广播 `WM_SETTINGCHANGE`（新终端免注销） | 214/214 |
| 18 | `acc966b` | — | 推送前脱敏：移除硬编码内网 IP，改由 `.env` 提供 | 214/214 |

> 基线口径说明：187/195/204/214 为**逐文件**跑 `tests/unit/*.test.js` 的纯单测计数；
> 194 为「178 单测 + 16 e2e」的另一口径，非回退。

## 第二阶段关键轮次（第一轮之外，按日志补）

- **Q1–Q5 澄清 + `appops` 第五域**（08-28）：用户指出原 4 个 Skill 漏了「操作 Windows 软件进行生产活动」这一维度（"用 Photoshop 把大山换成海洋"）。新增 `appops` 域 5 能力 + 第 6 个 Skill `winvm-app-operation`，全量文档 1+4 → **1+5**。
- **第二轮**（08-28）：LLM provider 真正落地（`adapter-agent-workbuddy-llm`，组合复用确定性执行器）+ 双端一键部署 `setup.mjs`（五阶段，默认 dry-run）。
- **第六轮**（09-03）：启动健壮性 + GUI 启用提示——VM-START 轮询端口 ≤60s、`GUI_RESTART_COMMAND` 命令块。
- **第七轮**（09-03）：插件管理 CLI `winvm-plugin`（host/VM 统一，自动识别上下文）。
- **第八轮**（09-03）：部署脚本 5 项问题（误报失败 / 命令可达 / 残留窗口 / 回收站澄清 / 输出可见性）。

## 六个真正的转折点

1. **能力 ID 三段式**（第一轮）：初版 `appops.app_state` 只有两段 → `parseCapabilityId` 抛错、服务启动即崩。全部改为 `<domain>.<group>.<action>` 三段式。dispatch 走 `implementation.module`+`function`，与 `id` 解耦，故改名安全。
2. **远程分发三连修**（第五轮 + 真机终验）：远端只发 `dist` → `ERR_MODULE_NOT_FOUND`；漏发 `psmod/`、`schemas/`；`psmod/*.ps1` 中文无 BOM → PS 5.1 按 GBK 解码导致 ps-bridge 启动即退。分别用 **junction 软链**、**排除法清单**、**前置 UTF-8 BOM** 解决。
3. **`WINVM_DRY_RUN` footgun**（09-03）：`WINVM_DRY_RUN=0` 时不传 `--apply` 也会真执行，与文档矛盾，会误伤真机。改为「未传 `--apply` 或 `WINVM_DRY_RUN=1` 之一成立即 dry-run」。
4. **InteractiveToken 忽略 `<Hidden>`**（第十一轮）：GUI 能力要求交互式会话（`InteractiveToken`），而 Windows 对这类任务**忽略** `<Hidden>true</Hidden>`，直接以 `node.exe` 为动作必弹常驻窗口。隐藏改在**进程创建层**（`start-hidden.ps1` + `Start-Process -WindowStyle Hidden -Wait`）。
5. **端口探测假阴性**（十四轮补2）：`spawnSync(..., {stdio:'ignore'})` 吞掉 stdout → `portOk` 恒 false，表现为「服务明明在跑却报端口未监听」。改用 Node `net` 的 `isPortListening()`。
6. **PATH 写入后不生效**（十四轮补3）：VM 内 SSH 能跑 `winvm-plugin`、RDP 里报「命令找不到」。根因是 RDP 陈旧会话 env 未刷新（非代码缺陷）。写完 User PATH 后广播 `WM_SETTINGCHANGE`，让新终端免注销生效。

## 方法论演进

- 项目自始至终按 **DDD（文档驱动开发）** 推进，`.dev/` 六索引（README / project-dir-file-index / docs-index / project-dev-status / changed-log / changing-log）每轮同步。
- 用户明确要求：**DDD 原则 7（改码前先改文档）+ plan-first（先规划任务树，执行-验证-反馈闭环）**。
- 每轮固定收尾动作：`node --check` → 逐文件跑单测 → 同步四份 `.dev` 索引 → 原子提交。
