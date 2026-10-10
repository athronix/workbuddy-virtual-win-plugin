# 交付概览 · WinVM 跨机 Agent 插件（1+5 双通道方案）

> 让宿主机 WorkBuddy 完全操作一台 Windows 虚拟机的完整实现已交付。
> 遵循 DDD（文档驱动）+ plan-first 方法论；全部 12 个包编译通过，**79 文件 / 1457 例（1455 pass / 0 fail / 2 skipped；skip 恒为 `ssh2-resolve` 离线用例）**（2026-10-10 Phase 1 T5 收官 QA 独立复跑基线 = `.test.js` 71 文件 1387 例 + `.test.mjs` 8 文件 70 例；演进链 1247(Phase 0)→1253(T1/T2)→1283(T3)→1400(T4)→1456(T5)→1457(T5 收官小修)）。覆盖契约/策略/审计/双协议/审批链 K3/K4/K5/K-N1/K-N2/S-4/A5/CL-K3R、Phase 0 安全守卫 U-P0-1 路径穿越 / U-P0-3 dry-run A1 / psmod 契约 / 装配点，以及 Phase 1 安全兑现批 T1–T5（链范围透出 / 审批三态入链 / `/health.audit.scope` / 非回环 fail-closed / ARCH-22 真取消：执行体消费取消 + LLM 双路打断 + 宿主事实化呈现 + `--token-env` 通路）。
> 已补齐"操作 Windows 软件应用进行生产活动"这一被遗漏的关键维度（appops 域 + winvm-app-operation Skill + LLM provider 开放任务路径）。
> **VM 侧 AI Agent 已可经 `agent.provider` 一键切换**：`workbuddy-deterministic`（确定性，默认）/ `workbuddy`（LLM Agent，V1 已实现）/ `hermes-agent`（Nous Research Hermes Agent，MCP 预注册）。
> **双通道已完整闭环**：简单任务 → 宿主 MCP client 直调 VM 的 MCP 工具；复杂任务 → 宿主经 A2A 委派桥（`host-a2a-bridge`）把目标交给 VM 内 AI Agent，过程与产物按 A2A 规范回流。

---

## 一、方案定调（用户拍板 + 评估建议结论）

**1+5 双通道方案**：
- **1** 套统一能力模型 + 1 套可替换 Agent 服务桥接层（标准 SPI）
- **5** 个领域 Skill（系统 / 应用 / 存储 / GUI / **应用生产操作 appops**）+ **1** 个总控编排 Skill
- **双通道**：MCP（工具级精确执行）+ A2A v1.0（任务级委派），VM 侧**同端口双协议**暴露

落地选型：V1 宿主与 VM 内 Agent 均以 **WorkBuddy** 为例实现，但通过 **宿主插件规范 / 桥接 SPI / 适配器** 三层解耦，后续可零改上层适配其他宿主 Agent（Claude/Cursor）或 VM 内 Agent（Hermes Agent / LangGraph 等）。VM 内 Agent 的选型由 `agent.provider` 统一开关控制——提供 `workbuddy-deterministic`（确定性执行器）、`workbuddy`（LLM Agent，VM 内 `codebuddy` CLI 承接开放/创意任务，V1 实现）与 `hermes-agent`（Nous Research **Hermes Agent** CLI 承接开放/创意任务，`init` 时把本服务 `/mcp` 预注册进 hermes 配置）三种，桥接层 / MCP / A2A / 共享 Skills **零改动**即可切换。

---

## 二、分层解耦架构（满足"模块化、可监管"硬性要求）

```
[L0] contracts          全系统唯一契约源（风险/能力/传输/审计/桥接/宿主/A2A）
[L1] core               策略引擎 / 哈希链审计 / 传输抽象 / 会话保活 / 桥接加载器 / 配置
[L2] mcp-framework      MCP server+client（Streamable HTTP + stdio）
     a2a-framework      A2A v1.0 server+client（AgentCard/message/send/stream/tasks/*/artifacts/input-required）
[L3] host-sdk           中性插件模型 SDK（解耦宿主规范）
     adapter-host-workbuddy → 渲染为 WorkBuddy 原生 plugin.json/marketplace.json/connector mcp.json
     vm-capabilities    ps-bridge 常驻进程 + system/app/storage/gui/appops 五大 PowerShell 模块
     adapter-agent-workbuddy → VM 内确定性执行器（实现桥接 SPI，可替换）
[装配] vm-service        同端口双协议服务端 + CLI（agent.provider 总开关）
[知识] skills×7          1 总控 + 5 领域 + 1 MCP 参考（含应用生产操作 appops）
[VM Agent] adapter-agent-workbuddy       确定性执行器（agent.provider=workbuddy-deterministic）
          adapter-agent-workbuddy-llm     LLM Agent（agent.provider=workbuddy，V1 实现）
          adapter-agent-hermes           LLM Agent（agent.provider=hermes-agent，Nous Research Hermes Agent，MCP 预注册）
[交付] delivery          安装器 + VM 服务配置
```

依赖方向严格单向：L0 ← L1 ← L2 ← L3，无环。

---

## 三、"最可监管"的三道闸

1. **策略引擎（core/policy）**：L0–L3 风险分级；路径黑名单（系统区全禁）+ 白名单（Phase 1 收紧为**仅当前服务用户**：`%USERPROFILE%\**` 等六条，跨账户恒 DENY）；**命令面只有黑名单**（`commandAllowlist` 已删除，ARCH-18）；进程黑名单；默认委派最高风险 `L1`；**拒绝优先**。
2. **审批闸**：L2/L3 在 MCP 通道 `requiresApproval`、A2A 通道 `input-required` 挂起，宿主确认后续跑；超时 fail-closed 拒绝；批准/拒绝/超时/取消**四态均入链**（Phase 1）。
3. **防篡改哈希链审计（core/audit）**：每条操作含 traceId/能力/参数（敏感键打码）/风险/判定/结果/前后哈希，可 `--audit verify` 校验完整性。⚠ 运行期 `verifyChain()` 覆盖**本轮分片**（`/health.audit.scope='session'`）；跨轮历史由启动归档校验条目提供证据（`SECURITY-GOVERNANCE.md` §4.3.1 / §6.4）。

网络信任边界（Phase 1 起为显式声明）：**回环绑定不可关** + SSH 隧道 + 审批闸；`vm-service` 不承担身份鉴权，`security.enforceBearer` 为可选加固（默认关；开启前须补齐 VM 内回连凭据通路）。详见 `SECURITY-GOVERNANCE.md` §2.1。

会话保活（core/session）监控隧道断线，~30s 内标记失活。

---

## 四、实测验证

| 项 | 结果 |
|----|------|
| 全量编译 `tsc -b` | ✅ 12/12 包通过 |
| 单元测试 + 端到端 | ✅ **79 文件 / 1457 例（1455 pass / 0 fail / 2 skipped；skip 恒为 `ssh2-resolve` 离线用例）**（2026-10-10 Phase 1 T5 收官 QA 独立复跑基线 = `.test.js` 71 文件 1387 例 + `.test.mjs` 8 文件 70 例；演进链 1247(Phase 0)→1253(T1/T2)→1283(T3)→1400(T4)→1456(T5)→1457(T5 收官小修)；覆盖契约/策略/审计/双协议/审批链 K3/K4/K5/K-N1/K-N2/S-4/A5/CL-K3R、Phase 0 安全守卫 U-P0-1/U-P0-3/psmod 契约/装配点，以及 Phase 1 安全兑现批 T1–T5（含 ARCH-22 真取消），无回归） |
| ps-bridge 真实链路 | ✅ 真实 PowerShell 5.1，五大模块加载，返回真实系统数据 |
| 安装器 dry-run | ✅ 6 Skill / 7 文件 / 1 增量补丁 / 静态禁用 8 高危工具 |
| VM 服务配置校验 | ✅ 0 错误 0 警告，强制回环绑定 |
| self-test（含 provider 目录） | ✅ 默认 + `workbuddy` + `hermes-agent` LLM 均打印并校验 provider 能力目录，`/health` 报告 `provider.id` 正确 |
| 共享 Skills 部署 dry-run | ✅ 发布 7 技能 + 为 workbuddy/hermes-agent 建 symlink 规划（不写盘、不触碰只读 hermes 目录） |

---

## 五、交付物清单

**文档（docs/）**
- `01-investigation/CONTEXT-ANALYSIS.md` 调研基线
- `02-design/` 需求/架构/能力模型/3 份解耦规范/接口/安全监管（9 篇）
- `05-peripherals/` 部署指南 + 用户手册
- `06-OVERVIEW.md` 本文件

| 端到端委派冒烟 | ✅ 宿主桥（stdio MCP）→ A2A → VM provider → ps-bridge → PowerShell，目标"查看系统信息"返回 `completed` 并带回产物 |
| 空闲自愈 | ✅ ps-bridge 空闲 55s 后仍可正常委派（修复前必失败，见 `HOST-A2A-BRIDGE.md` §7） |

**代码（packages/ 12 包）**：contracts · core · mcp-framework · a2a-framework · host-sdk · adapter-host-workbuddy · **host-a2a-bridge（宿主 A2A 委派桥）** · vm-capabilities · adapter-agent-workbuddy · **adapter-agent-workbuddy-llm（LLM Agent）** · **adapter-agent-hermes（Hermes Agent）** · vm-service

**Skills（skills/ 7 目录）**：winvm-orchestrator（总控）+ system/app/storage/gui + **app-operation（应用生产操作）** + winvm-mcp-reference（MCP 参考）

**交付（delivery/）**：`setup.mjs`（双端一键：构建/宿主/VM/隧道/自检，默认 dry-run、`--apply` 真执行，读 `.env`）· `install-host.mjs` / `install-vm.mjs`（幂等/增量/dry-run/--provider/--cli/--skills-root/--skip-skills/--skip-install/--skip-links/uninstall）· `link-workspace.mjs`（VM 侧 @winvm workspace junction 软链，免 npm ci/免联网，修复远程分发链路缺 node_modules 的根因）· `deploy-shared-skills.mjs`（共享 Skills 发布 + 各候选 Agent symlink 规划，可 `--apply`）· `vm-service.config.json`（含三 provider 定义：`workbuddy-deterministic` / `workbuddy` / `hermes-agent`）· `.env.example`

**DDD 索引（.dev/ 6 文件）**：README / project-dir-file-index / docs-index / project-dev-status / changed-log / changing-log

---

## 六、下一步

> 真机终验已于 R18 / R19 / A2A 覆盖补齐 / CL-K3R T05 多轮完成（详见 `docs/test/reports/` 与 `.dev/changing-log.md`）：`--self-test`、SSH 隧道端到端闭环、双连接器同生效、`codebuddy`/`hermes` CLI、A2A 委派 + 共享 Skills 下发、GUI 自动化均已落地；CL-K3R（K3 静默假成功根治）经 `on` 模式 3/3 真机委派验证通过。

1. （可选）扩充能力广度、加其他宿主/VM Agent 适配器（见 Roadmap §9.4）。
2. （可选）多 VM 联邦编排（V1 未做，当前单 VM）。
3. 维护：每次交付后同步 `.dev/` 六大索引（文档驱动纪律）。

详见 `docs/05-peripherals/DEPLOYMENT.md` 与 `.dev/changing-log.md`。
