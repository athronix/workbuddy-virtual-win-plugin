# 项目根索引 · winvm-virtual-win-plugin

> DDD 文档驱动开发六大索引的入口。本文件由 agent 在交付阶段同步维护；其余 5 个索引文件见本目录。

## 这是什么
为 **宿主机 WorkBuddy（AI Agent）** 构建的插件，使其能**完全操作一台 Windows 虚拟机**——系统管理、应用管理、存储管理、GUI 自动化，几乎覆盖所有 Windows 事务。

## 方案选型
**1+5 双通道方案**（评估建议结论 + 用户拍板）：
- **1**：一套统一能力模型 + 一套可替换 Agent 服务桥接层（标准 SPI）
- **5**：5 个领域 Skill（系统 / 应用 / 存储 / GUI / 应用生产操作 appops）+ 1 个总控编排 Skill
- **双通道**：MCP（工具级精确执行）+ A2A v1.0（任务级委派），VM 侧同端口双协议暴露
- **3 VM Agent 选项**：`workbuddy-deterministic`（确定性执行器）/ `workbuddy`（LLM 执行器，VM 内 codebuddy CLI）/ `hermes-agent`（Nous Research 的 Hermes Agent，经 `WINVM_VM_PROVIDER=hermes-agent` 切换）；三者实现同一桥接 SPI，Skills 与协议零改动。Skills 以 **单一真源 + 各 Agent symlink 引用** 方式独立部署（见 `delivery/deploy-shared-skills.mjs`），含 `mcps-reference.md` 指导 MCP server 部署管理。

## 六大索引导航
| 文件 | 内容 |
|------|------|
| `project-dir-file-index.md` | 目录与关键文件地图 |
| `docs-index.md` | 文档清单与阅读顺序 |
| `project-dev-status.md` | 各包/模块开发状态 |
| `changed-log.md` | 本次交付变更记录 |
| `changing-log.md` | 进行中/待定项 |

## 关键约束（来自用户）
1. VM 内 Agent 选型尽量以服务/模块/插件形式与全局框架解耦（V1 以 WorkBuddy 为例，可替换）
2. 宿主机插件规范以插件框架规范形式与整体解耦（V1 以 WorkBuddy 为例，可适配更多宿主 Agent）
3. 架构高度模块化：宿主插件规范 / 核心功能 / MCP 框架 / A2A 框架 / Skills 规范 / 桥接转换层 / VM 具体服务层，分层解耦
4. 遵从 DDD + plan-first 方法论
