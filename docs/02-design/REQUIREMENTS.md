# 需求规格说明书（REQUIREMENTS）

| 项 | 值 |
|---|---|
| 文档 ID | REQUIREMENTS-winvm-bridge-v1 |
| 版本 | v1.0（基线） |
| 上游 | `docs/01-investigation/CONTEXT-ANALYSIS.md` |
| 日期 | 2026-08-28 |
| 状态 | 待确认（R1 需求理解 / R2 范围） |

---

## 1. 产品定位

**WinVM Bridge** —— 一套**分层解耦、标准协议驱动、强监管**的插件体系，使宿主机 AI Agent（V1 = WorkBuddy）能够安全、可控、可审计地**完全操作**一台 Windows 虚拟机，覆盖系统管理、应用管理、存储管理与图形化（桌面/浏览器）操作。

---

## 2. 功能需求（FR）

### 2.1 通道能力

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-101 | 提供 **MCP 主干通道**：宿主直接调用 VM 侧 Windows 能力工具 | P0 | 宿主可在一次会话内完成"查磁盘 → 启服务 → 装应用"全链路，每步有结构化 tool 结果 |
| FR-102 | 提供 **A2A 委派通道**：宿主把长任务/强 GUI 多步任务整体委派给 VM 内 Agent | P0 | 委派后宿主可 `tasks/get` 轮询、`tasks/cancel` 取消，并取回 artifact（截图/日志/变更清单） |
| FR-103 | 两个通道共享**同一套能力注册表**与**同一套策略引擎**，不出现两套风控 | P0 | 同一高危操作经 MCP 与 A2A 调用，产生一致的风险分级与审批行为 |
| FR-104 | 传输可插拔：至少支持 **SSH 隧道**（默认）、**Streamable HTTP**、**本地 stdio** | P0 | 通过配置切换传输，上层代码零改动 |
| FR-105 | A2A 通道支持**流式**（SSE）进度回传 | P1 | 长任务执行中宿主可持续收到 `TaskStatusUpdateEvent` |

### 2.2 Windows 能力域（"几乎所有 Windows 事情"的可操作化拆解）

> **口径注记（2026-10-08 止血）**：下表为**需求面**（该域应覆盖什么），不是"当前可用能力清单"。
> 当前兑现面以 `packages/vm-capabilities/src/registry/definitions.ts`（54 条注册表）与
> `CAPABILITY-MODEL.md` §3 为准；未注册项（如 Windows 更新管理、默认程序、CDP 浏览器直驱、
> 解压/剪贴板写入/快捷方式创建挂载等）对用户一律表述为"当前不可用（V2 规划/待挂载）"，
> 不得写成现有功能。

| ID | 能力域 | 覆盖内容 | 优先级 |
|---|---|---|---|
| FR-201 | **系统管理** | 服务/进程/计划任务/注册表/网络配置/用户与组/环境变量/系统信息/电源与更新/事件日志 | P0 |
| FR-202 | **应用管理** | 已装应用清单、winget 安装/卸载/升级、启动与激活、快捷方式、默认程序、UWP 包、应用进程守护 | P0 |
| FR-203 | **存储管理** | 磁盘/分区/卷、空间分析、目录树、文件读写与搜索、压缩解压、符号链接、配额、回收站、清理建议 | P0 |
| FR-204 | **GUI 与桌面自动化** | 截图（全屏/窗口/区域）、键鼠模拟、窗口枚举与置顶、UIA 元素树与点击、剪贴板、浏览器自动化 | P0 |
| FR-205 | **审计与回溯** | 每次操作留痕（principal/action/target/result/duration），关键 GUI 操作前后截图入档 | P0 |
| FR-206 | **能力可扩展** | 新增能力只需在注册表声明 + 提供实现，不改框架 | P1 |

### 2.3 Skills（1+5）

| ID | Skill | 职责 | 优先级 |
|---|---|---|---|
| FR-301 | `winvm-orchestrator`（总控） | 意图识别 → 领域路由 → 通道选择（MCP 直调 vs A2A 委派）→ 风险分级 → 审批闸 → 结果汇总 | P0 |
| FR-302 | `winvm-system-admin` | 系统管理领域知识、最佳实践、PowerShell 惯用法、常见陷阱 | P0 |
| FR-303 | `winvm-app-manager` | 应用管理领域知识（winget/Store/卸载残留清理等） | P0 |
| FR-304 | `winvm-storage-manager` | 存储管理领域知识（空间分析、安全清理边界、不可逆操作清单） | P0 |
| FR-305 | `winvm-gui-automation` | GUI 自动化领域知识（会话保活、坐标 vs UIA 选择、截图判读、等待策略） | P0 |
| FR-306 | `winvm-app-operation` | **应用生产操作领域知识**（操作 Photoshop/Office/浏览器/ffmpeg/IDE 等软件把活干出来：应用状态/CLI 调度/工作流/COM 自动化/GUI 生产）；与 `winvm-gui-automation` 互补——gui 管"怎么操作界面"，本 Skill 管"用哪个软件、按什么生产逻辑出成品" | P0 |

> **设计演进（回应 Q2）**：原始 1+4 漏掉了"操作 Windows 软件应用进行生产活动"这一关键维度。新增 `winvm-app-operation` 与 `appops` 能力域后，VM 既能在 MCP 通道精确调用生产工具（如 ffmpeg 转码），又能在升级为 LLM VM Agent 后承接"用 Photoshop 把大山背景换成海洋"等开放生产任务（详见 SPEC-AGENT-SERVICE-BRIDGE §6.1）。

### 2.4 解耦与可扩展（用户 RQ-4 / RQ-5 / RQ-6）

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-401 | **VM 内 Agent 可替换**：通过"标准 Agent 服务桥接转换层"（SPI）接入，V1 用 WorkBuddy 适配器 | P0 | 替换 VM Agent 只需新增一个 adapter 实现 + 改配置，**不改** core / mcp-framework / a2a-framework / skills |
| FR-402 | **宿主 Agent 可适配**：宿主侧插件规范抽象化，V1 提供 WorkBuddy 适配器 | P0 | 适配新宿主只需新增 host-adapter，**不改** core / frameworks / vm-service / skills |
| FR-403 | **分层边界强制**：contracts（规范）/ core（核心）/ frameworks（MCP·A2A）/ adapters / vm-* 依赖方向单向，禁止反向依赖 | P0 | 依赖检查脚本可检出任何反向依赖并失败 |
| FR-404 | **Skills 与宿主解耦**：Skills 内容不绑定 WorkBuddy 私有格式，经宿主适配器转译后安装 | P1 | 同一份 Skill 源可产出 WorkBuddy 与其他宿主的格式 |

---

## 3. 非功能需求（NFR）—— 对应用户"最先进/最可靠/最高效/标准化最高/最可监管"

| ID | 质量属性 | 需求 | 度量方式 |
|---|---|---|---|
| NFR-501 | **标准化最高** | 工具层用 **MCP**，委派层用 **A2A v1.0**（Linux Foundation 治理）；Agent Card 落 `/.well-known/agent-card.json`；方法名严格用 v1.0（`message/send` 等，禁用旧 `tasks/send`） | 与官方 SDK/schema 做契约测试；Agent Card 通过 JSON Schema 校验 |
| NFR-502 | **最可靠** | GUI 进程强制运行在交互式会话；会话挂起自动检测并恢复；传输断线重连；操作超时可控 | 会话健康探针；断线重连成功率；GUI 黑屏检出率 100%（检出即告警而非静默失败） |
| NFR-503 | **最高效** | 高频 PowerShell 调用走**常驻 ps-bridge 进程**（避免每次 ~1s 进程启动）；默认走省 token 的 MCP 直调，仅长任务委派 A2A | 单次工具调用 P95 < 300ms（ps-bridge 热路径）；冷启动除外 |
| NFR-504 | **最可监管 - 风险分级** | 每个能力标注风险等级 **L0/L1/L2/L3** | 见 §4 风险分级表 |
| NFR-505 | **最可监管 - 策略引擎** | 命令白/黑名单（正则）、路径白名单、进程白名单、网络端点限制；默认**拒绝优先** | 未命中白名单的调用一律拒绝并记录 |
| NFR-506 | **最可监管 - 审批闸** | L2/L3 操作默认需人工确认（A2A `input-required` / MCP 侧前置确认）；支持按能力配置免审 | 未经审批的 L2/L3 操作执行率 = 0 |
| NFR-507 | **最可监管 - 防篡改审计** | 结构化 append-only 审计日志，**哈希链**（每条含前一条 hash），支持事后校验 | 篡改任意一条 → 校验立即失败 |
| NFR-508 | **最可监管 - 宿主侧静态风控** | 生成宿主插件时同步产出 `disabledTools` 建议清单（WorkBuddy 原生支持） | 高危工具默认在宿主侧静态禁用 |
| NFR-509 | **最可监管 - 可观测** | 全链路 traceId 贯穿 宿主→传输→VM 服务→能力执行；~~关键操作附带 before/after 快照 artifact~~（**Q2 裁决：信息性声明、未实现且不实现** —— `audit.snapshot` 声明只参与交付面形状校验，运行期零消费、不产任何快照；事实化可观测面 = traceId 端到端检索 + 哈希链审计，判据 `tests/unit/phase2-snapshot-truth.test.js`，口径权威 `SECURITY-GOVERNANCE.md` §3.2） | 任一操作可按 traceId 端到端检索 |
| NFR-510 | **安全性 - 网络** | VM 侧服务**仅监听 127.0.0.1**；SSH 隧道本地端口转发；严禁裸奔公网。Streamable HTTP 模式强制 TLS + bearer token + Origin 校验 | 端口扫描验证：VM 对外无监听端口 |
| NFR-511 | **安全性 - 鉴权** | SSH 密钥鉴权（默认）；HTTP 模式 bearer token + 可选 mTLS；`A2A-Version` 版本协商 | 无凭据访问全部拒绝 |
| NFR-512 | **可维护性** | 全部契约以 JSON Schema 表达并集中存放；契约校验纳入 CI | 契约变更 → 校验失败即阻断 |
| NFR-513 | **可测试性** | 核心模块（策略引擎、审计链、能力注册表、A2A 任务状态机、MCP 工具编排）必须有单元测试，覆盖率高优先级路径 | 见 `TEST-PLAN.md` |

---

## 4. 风险分级模型（NFR-504 定义）

| 等级 | 名称 | 语义 | 典型操作 | 默认策略 |
|---|---|---|---|---|
| **L0** | 只读 | 不改变系统状态 | 查进程、查磁盘、截图、读注册表、列目录 | 直接执行，仅留痕 |
| **L1** | 可回滚写 | 状态改变但可撤销 | 启/停服务、创建文件、安装应用、改环境变量、写注册表非关键项 | 直接执行 + 留痕 + 记录回滚提示 |
| **L2** | 破坏性 | 不可逆或影响面大 | 删除文件/目录、卸载应用、结束进程树、改网络配置、改注册表关键项、格式化卷 | **需人工审批** + ~~before/after 快照~~（信息性声明、运行期不产，Q2/P2-T3，口径权威 `SECURITY-GOVERNANCE.md` §3.2，判据 `phase2-snapshot-truth` 守卫） |
| **L3** | 关键/高危 | 可能导致系统不可用或数据全损 | 磁盘分区/格式化、系统关机/重启、重置系统、改启动配置、批量删除、关闭安全组件（防火墙/Defender） | **需人工审批** + 二次确认 + ~~全量快照~~（同上：信息性声明、未实现且不实现） + 强制 dry-run 前置 |

**默认拒绝优先**：任何未在能力注册表中声明风险的调用 → 按 **L3** 处理。

---

## 5. 范围界定（R2 范围确认）

### 5.1 V1 范围内

- 宿主机：WorkBuddy（V1 唯一宿主适配器）
- 虚拟机：Windows（V1 唯一能力平台）
- VM 内 Agent：WorkBuddy 适配器（V1 唯一 Agent 适配器）
- 通道：MCP（Streamable HTTP / stdio）+ A2A v1.0（JSON-RPC over HTTPS）
- 传输：SSH 隧道（默认）、Streamable HTTP、本地 stdio
- Skills：5 个（1 总控 + 4 领域）
- 能力域：系统 / 应用 / 存储 / GUI（**不含**：域控级 AD 操作、驱动级内核操作、BitLocker 恢复密钥处理）

### 5.2 V1 范围外（架构预留，不实现）

- 其他宿主 Agent 适配器（Claude Code / Cursor / Codex 等）—— **架构与 SPI 已预留**
- 其他 VM 内 Agent 实现 —— **桥接层已预留**
- 多 VM 编排、任务队列持久化到外部 DB、Web 控制台
- Windows 之外的客体系统（Linux/macOS VM）

### 5.3 明确不做（安全红线）

- 任何绕过审批闸的执行路径
- 任何将 VM 服务暴露到公网的配置模板
- 凭据明文落盘（一律走 SSH key / token 注入 / WorkBuddy 加密 header 机制）

---

## 6. 需求到架构的追溯矩阵

| 需求 | 对应架构组件 | 对应规范 |
|---|---|---|
| FR-101 MCP 主干 | `packages/mcp-framework` + `packages/vm-service` | `INTERFACES.md` §2 |
| FR-102 A2A 委派 | `packages/a2a-framework` + `packages/vm-service` | `INTERFACES.md` §3 |
| FR-104 传输可插拔 | `packages/core/transport` | `SPEC-AGENT-SERVICE-BRIDGE.md` |
| FR-201~204 能力域 | `packages/vm-capabilities` | `CAPABILITY-MODEL.md` |
| FR-301~305 Skills | `skills/` | `SPEC-SKILLS.md` |
| FR-401 VM Agent 可替换 | `packages/adapter-agent-workbuddy` + SPI | `SPEC-AGENT-SERVICE-BRIDGE.md` |
| FR-402 宿主可适配 | `packages/host-sdk` + `packages/adapter-host-workbuddy` | `SPEC-HOST-AGENT-PLUGIN.md` |
| FR-403 分层边界 | 全仓库依赖方向 | `ARCHITECTURE.md` §4 |
| NFR-504~508 监管 | `packages/core/policy` + `packages/core/audit` | `SECURITY-GOVERNANCE.md` |
| NFR-502 会话保活 | `packages/core/session` + `packages/vm-capabilities` | `SECURITY-GOVERNANCE.md` §5 |

---

## 7. 待确认事项（R1/R2 提审）

| 编号 | 事项 | 默认建议 |
|---|---|---|
| Q-1 | VM 内 Agent（V1）是否直接复用 WorkBuddy CLI，还是用本项目自带的轻量执行器（不依赖 LLM）？ | **默认**：V1 用本项目自带轻量执行器（确定性、省资源、可预测），WorkBuddy 适配器仅作为可选增强，后续可切 |
| Q-2 | 默认传输是否确定为 SSH 隧道（需 VM 开启 OpenSSH Server）？ | **默认**：是；同时提供 Streamable HTTP 作为备选 |
| Q-3 | L2/L3 审批闸的交互形态？ | **默认**：A2A 走 `input-required` 状态；MCP 走工具返回"待确认"并附 dry-run 预览 |
| Q-4 | 是否需要 V1 就支持多 VM？ | **默认**：单 VM，配置结构预留多实例 |

> 以上默认建议将在用户未另行指示时按默认值执行，并在设计文档中显著标注。
