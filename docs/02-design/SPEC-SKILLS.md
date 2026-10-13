# Skills 框架规范（SPEC-SKILLS）

| 项 | 值 |
|---|---|
| 文档 ID | SPEC-SKILLS-v1 |
| 版本 | v1.1 |
| 层 | L0 规范（契约） |
| 对应用户要求 | **RQ-6**：skills 框架规范独立成层；**RQ-7**：1+5 多 skills 支持 |
| 日期 | 2026-08-28（v1.1 增补 appops 于 2026-08-28） |

---

## 1. 定位

Skills 是**知识层与治理层**，不是执行层。它回答三个问题：

1. **怎么选**：用户意图 → 走 MCP 直调还是 A2A 委派？属于哪个领域？
2. **怎么做**：该领域的正确 PowerShell/UIA 惯用法、最佳实践、已知陷阱。
3. **怎么控**：风险分级、审批闸、不可逆操作清单、最小权限。

> 评估文档已明确：Skill **不担主渠道**（无法稳定维持远程连接、难以把截图作为 tool 结果回传）。因此本规范严格限定 Skill 为**配套知识与治理层**，执行一律走 MCP/A2A。

---

## 2. Skill 清单（1 + 5）

| # | Skill ID | 角色 | 领域 | 主要职责 |
|---|---|---|---|---|
| 1 | **`winvm-orchestrator`** | **总控** | 全域 | 意图识别 → 领域路由 → **通道选择** → 风险分级 → 审批闸 → 隧道就绪检查 → 结果汇总与回溯 |
| 2 | `winvm-system-admin` | 领域 | `system` | 服务/进程/计划任务（查询）/注册表/网络（查询）/用户（查询）/环境变量（读取）/事件日志/电源（更新管理 V2·当前不可用） |
| 3 | `winvm-app-manager` | 领域 | `app` | 清单/winget 安装卸载升级/启动/快捷方式（读取）/UWP（查询）；默认程序 V2·当前不可用 |
| 4 | `winvm-storage-manager` | 领域 | `storage` | 磁盘分区卷/空间分析/文件目录/搜索/压缩（创建 zip）/链接/回收站（查看）/清理建议 |
| 5 | `winvm-gui-automation` | 领域 | `gui` | 会话保活/截图/键鼠/窗口/UIA/剪贴板（只读）/等待策略；网页操作经 UIA+键鼠（CDP 直驱 V2·当前不可用） |
| 6 | `winvm-app-operation` | 领域 | `appops` | **操作 Windows 软件应用进行生产活动**：Photoshop/Office/浏览器/ffmpeg/IDE 等生产型工作流、CLI 调用、COM 自动化、GUI 多步生产 |

---

## 3. 中性 Skill 格式（与宿主无关）

```
skills/<skill-id>/
├── SKILL.md          # 必须：frontmatter + 正文
├── references/       # 可选：领域知识（按需加载，避免撑爆上下文）
│   └── *.md
└── workflows/        # 可选：多步流程
    └── *.md
```

### 3.1 `SKILL.md` frontmatter 契约

```yaml
---
id: winvm-system-admin        # 必须，与目录名一致
name: Windows 系统管理
description: >
  在 Windows 虚拟机内执行系统管理操作：服务、进程、计划任务、注册表、
  网络、用户与组、环境变量、事件日志。用于……（何时该用）
version: 0.1.0
domains: [system]             # system|app|storage|gui
entry: false                  # true 仅 winvm-orchestrator
triggers:                     # 触发场景（供宿主路由/推荐）
  - 管理服务/进程
  - 修改注册表/网络配置
relatedSkills: [winvm-orchestrator]
riskProfile:                  # 该 Skill 覆盖的风险区间
  min: L0
  max: L3
---
```

### 3.2 正文必备章节（规范强制）

| 章节 | 内容要求 |
|---|---|
| `## 适用与不适用` | 明确边界，何时**不该**用本 Skill |
| `## 前置检查` | 隧道是否就绪 / `meta.health.check` / 会话状态（GUI 场景） |
| `## 通道选择` | 什么情况 MCP 直调，什么情况 A2A 委派 |
| `## 标准流程` | 分步流程，每步标注能力与风险等级 |
| `## 高危清单` | L2/L3 操作清单 + 强制动作（dry-run / 审批 / 快照） |
| `## 已知陷阱` | 领域特有坑（如 UAC、路径转义、会话挂起） |
| `## 参考` | 指向 `references/` 与 `workflows/` |

---

## 4. 路由规则（`winvm-orchestrator` 的核心）

### 4.1 领域路由

| 意图特征 | 路由到 |
|---|---|
| 服务/进程/注册表/网络（查询）/用户（查询）/环境变量（读取）/事件日志/电源 | `winvm-system-admin` |
| 安装/卸载/升级/启动应用/快捷方式（读取）；"默认程序"路由到此但**当前不可用**（V2） | `winvm-app-manager` |
| 磁盘/分区/空间/文件/目录/搜索/压缩（仅创建 zip）/回收站（查看） | `winvm-storage-manager` |
| 截图/键鼠/窗口/UIA/剪贴板（只读）/浏览器（经 UIA+键鼠；CDP 直驱 V2） | `winvm-gui-automation` |
| 用 Photoshop/Office/浏览器/ffmpeg/IDE 等**软件把活干出来**（生产） | `winvm-app-operation` |
| 跨域或不确定 | 先 `winvm-orchestrator` 拆解，再分派 |

### 4.2 通道选择（**关键决策**）

```
是否单步且结果结构化？
  ├─ 是 → MCP 直调（透明、省 token、可复现）
  └─ 否 → 是否多步自主规划 / 强 GUI / 预期 >30s？
            ├─ 是 → A2A 委派（artifact 回传 + 进度流）
            └─ 否 → MCP 直调，宿主自己多轮编排
```

### 4.3 隧道就绪检查（避免难排查的超时故障）

任一工具调用前，`winvm-orchestrator` 必须确认：

1. SSH 隧道进程存活且 `127.0.0.1:<localPort>` 可连；
2. `meta.health.check` 返回 `ok`；
3. 若涉及 GUI：会话状态为交互式且非锁屏、截图非黑屏。

不满足时**明确报错并给出修复指引**，不重试硬扛。

---

## 5. 治理要求（写入每个 Skill）

| 要求 | 落地 |
|---|---|
| 最小权限 | 委派时**可声明** `allowedCapabilities` 限定本次可用能力（**现状 2026-10-13 批0**：声明记录于审计链，服务端执行面尚未接线＝Phase 3 批1 在建，详见 `SECURITY-GOVERNANCE.md` §2.3——Skill 文档不得把它写成已生效限权） |
| 风险上限 | 委派时**可声明** `maxRisk` 限定本次允许的最高风险（默认 L1；**执行面接线同上＝批1 在建**） |
| 高危必审 | L2/L3 必须走审批闸，禁止"先斩后奏" |
| 不可逆前置 dry-run | L3 操作必须先出 dry-run 预览 |
| 删除优先回收站 | `storage.file.delete` 默认进回收站，除非显式 `--permanent` 且已审批 |
| 禁止公网暴露 | 所有 Skill 文档均标注"VM 服务仅监听 127.0.0.1" |
| 全程留痕 | 每次操作引用 `traceId`，便于按 ID 回溯 |

---

## 6. 与宿主格式的关系（FR-404）

| 环节 | 说明 |
|---|---|
| **源** | `skills/` 中性格式（本规范） |
| **转译** | `adapter-host-workbuddy` 渲染为 WorkBuddy `connector-skills` 布局 |
| **V1 差异** | WorkBuddy 的 Skill 格式与中性格式近乎一致（frontmatter + Markdown），转译主要是注入宿主字段与目录重排 |
| **未来宿主** | 新增 Renderer 复用同一份 `skills/` 源 |

---

## 7. 内容质量红线

- ❌ Skill 不得包含具体凭据、主机 IP、密钥路径等环境敏感信息（一律占位符 `${VAR}`）
- ❌ Skill 不得给出绕过审批闸的操作建议
- ❌ Skill 不得把"删除/格式化/关机"包装成常规操作而不标注风险
- ✅ 所有示例命令必须可在受限白名单内表达（否则示例无意义）
- ✅ 所有 L2/L3 示例必须附带 `--whatif` / dry-run 形态
