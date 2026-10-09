# 总体架构设计（ARCHITECTURE）

| 项 | 值 |
|---|---|
| 文档 ID | ARCHITECTURE-winvm-bridge-v1 |
| 版本 | v1.0 |
| 上游 | `REQUIREMENTS.md`、`CONTEXT-ANALYSIS.md` |
| 日期 | 2026-08-28 |
| 状态 | 待确认（R3 技术方案） |

---

## 1. 架构总览

**WinVM Bridge** 采用 **"三层解耦 + 双通道 + 六 Skill"** 架构：

- **三层解耦**：`规范层（contracts）` → `核心层（core + frameworks）` → `适配层（adapters + vm-service）`
- **双通道**：MCP（主干，透明直调）+ A2A v1.0（委派，长任务/强 GUI）
- **六 Skill**：1 总控（`winvm-orchestrator`）+ 5 领域（系统 / 应用 / 存储 / GUI / 应用生产操作）

```
┌─────────────────────────────── 宿主机（Host） ───────────────────────────────┐
│                                                                              │
│  ┌──────────────────────── 宿主机 Agent（V1 = WorkBuddy） ─────────────────┐ │
│  │                                                                        │ │
│  │   ┌──────────────── 知识层：6 Skills（1+5） ────────────────┐          │ │
│  │   │  winvm-orchestrator   ← 总控：路由 / 通道选择 / 风控    │          │ │
│  │   │  winvm-system-admin   │  winvm-app-manager              │          │ │
│  │   │  winvm-storage-manager│  winvm-gui-automation           │          │ │
│  │   │  winvm-app-operation  ← 应用生产操作（photoshop/office…）│         │ │
│  │   └────────────────────────────────────────────────────────┘          │ │
│  │            │ 路由                                                      │ │
│  │   ┌────────▼──────────────── 通道层 ──────────────────────┐           │ │
│  │   │  通道 A：MCP Client（主干 · 透明 · 省 token）          │           │ │
│  │   │  通道 B：A2A Client（委派 · 长任务 · artifacts）       │           │ │
│  │   └────────┬──────────────────────────────────────────────┘           │ │
│  └────────────┼──────────────────────────────────────────────────────────┘ │
│               │  adapter-host-workbuddy（宿主适配器，可替换）                │
└───────────────┼────────────────────────────────────────────────────────────┘
                │
        ┌───────▼──────── 传输层（可插拔） ────────┐
        │  ssh-tunnel（默认·VM 仅监听 127.0.0.1）  │
        │  streamable-http（TLS + bearer）         │
        │  stdio（本地/测试）                       │
        └───────┬──────────────────────────────────┘
                │
┌───────────────▼───────── Windows 虚拟机（VM） ──────────────────────────────┐
│                                                                             │
│  ┌──────────── vm-service：统一 Agent 服务（交互式会话内） ──────────────┐  │
│  │                                                                       │  │
│  │   MCP Server（/mcp）            A2A Server（/a2a + Agent Card）       │  │
│  │        │                                 │                            │  │
│  │        └────────────┬────────────────────┘                            │  │
│  │                     ▼                                                 │  │
│  │   ┌───────── 标准 Agent 服务桥接转换层（SPI） ─────────┐              │  │
│  │   │  AgentServiceProvider 接口                         │              │  │
│  │   │   └── adapter-agent-workbuddy（V1，可替换）        │              │  │
│  │   └──────────────────────┬─────────────────────────────┘              │  │
│  │                          ▼                                            │  │
│  │   ┌──────── 统一能力注册表 + 策略引擎 + 审计链 ────────┐              │  │
│  │   │  L0/L1/L2/L3 风险分级 · 白名单 · 审批闸 · 哈希链   │              │  │
│  │   └──────────────────────┬─────────────────────────────┘              │  │
│  │                          ▼                                            │  │
│  │   ┌──────── vm-capabilities：Windows 能力层 ───────────┐              │  │
│  │   │  ps-bridge（常驻 PowerShell 进程，热路径 <300ms）   │              │  │
│  │   │  system / app / storage / gui / appops 五大能力域   │              │  │
│  │   └──────────────────────┬─────────────────────────────┘              │  │
│  └──────────────────────────┼───────────────────────────────────────────┘  │
│                             ▼                                              │
│               Windows 交互式会话（WinSta0\Default，Session 1+）             │
│               ↑ session-guard 保活：自动登录 / tscon / 禁休眠               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 分层与包边界（对应用户 RQ-6）

### 2.1 依赖方向（**单向，禁止反向**）

```
                    ┌──────────────────────────┐
       L0 规范层     │  packages/contracts      │   ← 唯一契约源（JSON Schema + TS 类型）
                    └────────────┬─────────────┘
                                 │ 被所有层依赖
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
┌──────▼───────┐      ┌──────────▼──────────┐    ┌─────────▼────────┐
│ L1a 核心模块  │      │ L1b 协议框架         │    │ L1c 宿主 SDK      │
│ core         │      │ mcp-framework       │    │ host-sdk         │
│ ├ transport  │      │ a2a-framework       │    │ （插件规范抽象）   │
│ ├ registry   │      └──────────┬──────────┘    └─────────┬─────────┘
│ ├ policy     │                 │                         │
│ ├ audit      │                 │                         │
│ ├ session    │                 │                         │
│ └ bridge(SPI)│                 │                         │
└──────┬───────┘                 │                         │
       │                         │                         │
       └────────────┬────────────┴─────────────────────────┘
                    │
       ┌────────────▼───────────────────────────────────────┐
       │ L2 适配层（可替换实现）                              │
       │  adapter-host-workbuddy    （宿主 V1）              │
       │  adapter-agent-workbuddy   （VM Agent V1）          │
       │  vm-service                （VM 服务编排）           │
       │  vm-capabilities           （Windows 能力实现）      │
       └─────────────────────────────────────────────────────┘

依赖铁律：
  adapters  ──依赖──▶ core / frameworks / host-sdk / contracts
  core      ──依赖──▶ contracts          （禁止依赖 adapters / frameworks）
  frameworks──依赖──▶ contracts + core   （禁止依赖 adapters）
  contracts ──依赖──▶ 无                 （零依赖，纯契约）
```

### 2.2 包清单与职责

| 层 | 包 | 职责 | 对应用户要求 |
|---|---|---|---|
| L0 | `packages/contracts` | **唯一契约源**：能力模型、风险分级、传输配置、A2A/MCP 消息扩展、插件清单的 JSON Schema + TS 类型 + 校验器 | 标准化最高 |
| L1a | `packages/core` | **宿主机 Agent 插件核心功能模块**：<br>`transport` 传输抽象（ssh-tunnel / streamable-http / stdio）<br>`registry` 统一能力注册表与路由<br>`policy` 策略引擎（L0-L3、白名单、审批闸）<br>`audit` 哈希链审计<br>`session` Windows 交互式会话保活<br>`bridge` **标准 Agent 服务桥接转换层 SPI**<br>`config` 配置加载与校验 | 核心功能模块 + 桥接转换层 |
| L1b | `packages/mcp-framework` | **MCP 架构框架**：Server（工具注册/校验/执行/audit 织入）、Client（连接/重试/超时）、Streamable HTTP + stdio 传输适配 | MCP 架构框架 |
| L1b | `packages/a2a-framework` | **A2A 架构框架**：Agent Card 生成与签名、Task 状态机、`message/send`、`message/stream`(SSE)、`tasks/get`、`tasks/list`、`tasks/cancel`、`tasks/subscribe`、artifact 管理、`input-required` 审批闸 | A2A 架构框架 |
| L1c | `packages/host-sdk` | **宿主机 Agent 插件规范 SDK**：抽象插件模型（PluginManifest / SkillBundle / ConnectorDecl / LifecycleHooks），负责把中性规范**渲染**为具体宿主格式 | 宿主插件规范 |
| L2 | `packages/adapter-host-workbuddy` | **宿主 WorkBuddy 适配器**：产出 `.codebuddy-plugin/plugin.json`、`marketplace.json`、`connectors/.../mcp.json`（两个连接器：MCP 直调 + A2A 委派桥）、`connectors/skills/connector-winvm/<6 skills>` | 宿主 V1 |
| L2 | `packages/host-a2a-bridge` | **宿主侧 A2A 委派桥**：以本地 stdio MCP server 形态补齐宿主的 A2A 一跳；对外暴露 `a2a.delegate` 等工具，内部用 `A2AClient` 调 VM 侧 `/a2a`，把进度/产物/审批事件翻译回 MCP 结果（见 `HOST-A2A-BRIDGE.md`） | 宿主 A2A 通道 |
| L2 | `packages/vm-service` | **VM 侧标准 Agent 服务**：同时暴露 MCP `/mcp` 与 A2A `/a2a` + `/.well-known/agent-card.json`；编排 能力注册表→策略→审计→能力执行 | VM 服务层 |
| L2 | `packages/vm-capabilities` | **Windows 能力实现**：`ps-bridge` 常驻 PowerShell 进程 + 五大能力域（system / app / storage / gui / appops）的 PowerShell 模块与安全封装 | 能力层 |
| L2 | `packages/adapter-agent-workbuddy` | **VM 内 Agent 适配器 V1**：实现 `AgentServiceProvider` SPI；默认 `workbuddy-deterministic`（确定性轻量执行器，不依赖 LLM），可通过改 `agent.provider` 平滑升级为 LLM provider（如 VM 内 WorkBuddy `codebuddy` CLI，开放任务大脑） | VM Agent V1 |

---

## 3. 双通道设计（FR-101 / FR-102）

### 3.1 何时走哪个通道

| 判据 | 通道 | 理由 |
|---|---|---|
| 单步、结果结构化、需精确控制 | **MCP 直调** | 透明、可复现、省 token |
| 多步骤、需自主规划 | **A2A 委派** | 宿主不必逐步往返 |
| 强 GUI、长时（>30s） | **A2A 委派** | 需 artifact（截图/变更清单）与进度流 |
| L2/L3 高危 | 任一通道，但**必须过审批闸** | 策略引擎统一拦截 |
| 需要"看屏幕再决定下一步" | **A2A 委派** | 截图作为 artifact 回传，宿主再决策 |

### 3.2 通道共享同一内核（FR-103）

两个通道**不是两套实现**，而是同一内核的两个门面：

```
        MCP Server                      A2A Server
             │                               │
             └───────────► 统一能力注册表 ◄───┘
                                 │
                        策略引擎（L0-L3）
                                 │
                        审批闸（input-required / 待确认）
                                 │
                        审计链（哈希链）
                                 │
                    桥接转换层 SPI → Agent 适配器
                                 │
                    能力执行（ps-bridge → PowerShell）
```

> **关键**：同一能力经 MCP 或 A2A 调用，风险分级、白名单、审批、审计**完全一致**。

---

## 4. 解耦机制（对应用户 RQ-4 / RQ-5）

### 4.1 VM 内 Agent 解耦（FR-401）

核心是 `packages/core/bridge` 定义的 **SPI（标准 Agent 服务桥接转换层）**：

```ts
interface AgentServiceProvider {
  readonly id: string;                    // 如 "workbuddy-deterministic"
  readonly displayName: string;
  readonly capabilities: CapabilityId[];  // 声明可提供的能力
  init(ctx: BridgeContext): Promise<void>;
  execute(req: CapabilityRequest): Promise<CapabilityResult>;
  health(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
}
```

- V1 实现：`adapter-agent-workbuddy`（确定性执行器，`id=workbuddy-deterministic`）、`adapter-agent-workbuddy-llm`（LLM Agent，`id=workbuddy`，V1 选型）
- 替换方式：新增一个实现 `AgentServiceProvider` 的包 + 在 `agent.providers` 注册一条 entry + 改配置项 `agent.provider=<id>`
- **双 provider 共存**：`agent.provider` 是 VM 侧 AI Agent 总开关；`workbuddy-deterministic`（默认，确定性、可预测、易监管）与 `workbuddy`（LLM 自主规划，承接开放/创意任务）通过同一 SPI 互换，宿主协议层零感知
- **不改**：`core` / `mcp-framework` / `a2a-framework` / `vm-service` / `skills`

### 4.2 宿主 Agent 解耦（FR-402）

`packages/host-sdk` 定义**中性插件模型**，适配器负责渲染为宿主格式：

```ts
interface NeutralPlugin {
  manifest: PluginManifest;       // 名称/版本/描述/关键词
  skills: SkillBundle[];          // 与宿主无关的 Skill 源
  connector: ConnectorDecl;       // 传输/端点/工具白黑名单
  lifecycle?: LifecycleHooks;     // install/enable/disable/uninstall
}
```

- V1 渲染器：`adapter-host-workbuddy` → WorkBuddy 的 `plugin.json` + `mcp.json` + `connector-skills/`
- 适配新宿主：新增一个 `Renderer` 实现，输入同一份 `NeutralPlugin`
- **不改**：`core` / frameworks / `vm-service` / `skills`

### 4.3 Skills 与宿主解耦（FR-404）

Skills 以**中性格式**存放于 `skills/<name>/`：

```
skills/<name>/
├── SKILL.md          # 中性主体（frontmatter + 正文），不绑定任何宿主私有语法
├── references/       # 领域知识
└── workflows/        # 多步流程
```

宿主适配器在 **install 阶段**转译（WorkBuddy V1 为近乎原样复制 + 注入 frontmatter 字段）。

---

## 5. 传输设计（FR-104 / NFR-510 / NFR-511）

### 5.1 三种传输

| ID | 传输 | 形态 | 适用 | 网络暴露 |
|---|---|---|---|---|
| `ssh-tunnel` | **SSH 隧道（默认）** | VM 服务仅监听 `127.0.0.1:18443`；宿主 `ssh -L 18443:127.0.0.1:18443 user@vm` | 单客户端、本地/私有 VM | **VM 对外零端口** |
| `streamable-http` | TLS + bearer | VM 监听内网口，强制 HTTPS + token + Origin 校验 | 多客户端/生产化 | 内网/VPN 限定 |
| `stdio` | 本地进程 | 宿主直接 spawn（含 `ssh vm ... --stdio` 变体） | 本地测试、极简部署 | 无 |

### 5.2 为什么默认 SSH 隧道

1. **零端口暴露**：VM 服务只绑回环，外部不可达 —— 直接满足 NFR-510。
2. **鉴权与加密由 SSH 承担**：密钥登录，无需自签证书或 token 轮换。
3. **统一支撑双通道**：MCP 与 A2A 都是 HTTP 语义，一条隧道即可同时承载 `/mcp`、`/a2a`、`/.well-known/agent-card.json`。（评估文档建议的 "ssh→stdio" 只解决 MCP，无法承载 A2A。）
4. Windows 10/11 内置 OpenSSH Server，启用成本低。

---

## 6. Windows 能力层设计（FR-201~204 / NFR-503）

### 6.1 为什么用 PowerShell + .NET，而非 Python 方案

| 维度 | PowerShell + .NET | Python（windows-mcp 类） |
|---|---|---|
| 依赖 | **零**（Windows 内置 PS 5.1+） | 需装 Python + uiautomation/pywinauto |
| 系统/应用/存储 | **原生 cmdlet 全覆盖** | 多靠 subprocess 转发 |
| GUI | `Add-Type` P/Invoke `user32.dll`；UIA 走 `System.Windows.Automation` | uiautomation 库成熟 |
| 与 WorkBuddy 一致性 | WorkBuddy 自带 PS 可用 | 需额外环境 |
| 可审计性 | 脚本即清单，易于白名单匹配 | 依赖库内部行为不透明 |

**结论**：V1 采用 **PowerShell + .NET**，零依赖、可审计、与宿主运行时一致。

### 6.2 ps-bridge：常驻进程解决性能（NFR-503）

每次 `powershell.exe -File` 冷启动约 500ms~1s。为达 P95 < 300ms：

- Node 侧启动**一个常驻 PowerShell 宿主进程**（`ps-bridge`），通过 **newline-delimited JSON over stdio** 通信；
- 每次能力调用 = 一次 JSON 请求/响应，**无进程启动开销**；
- 进程崩溃/超时自动重启并重建会话；
- 所有请求经 `policy` 前置校验后才进入 ps-bridge。

### 6.3 会话保活（NFR-502 / 评估建议 §二）

**铁律：承载 GUI 的服务进程必须运行在交互式用户会话（WinSta0\Default, Session 1+），禁止注册为 Windows 服务。**

`core/session` + `vm-capabilities/session-guard` 提供：

| 机制 | 作用 |
|---|---|
| **会话健康探针** | 定期校验：当前 SessionId ≥ 1、窗口站 = WinSta0、桌面 = Default、屏幕非黑屏（截图熵检测） |
| **黑屏检出即告警** | 检出"Session 0 / 会话已断开 / 截图纯黑"立即置服务为 degraded 并告警，**绝不静默返回黑图** |
| **tscon 归还控制台** | RDP 断开后自动 `tscon <session> /dest:console` |
| **自动登录配置** | 生成 Sysinternals Autologon 风格配置，重启后自动进入交互会话 |
| **禁休眠/禁锁屏** | 电源与屏幕保护策略调整 |
| **降级模式** | 无交互会话时，仅提供 L0/L1 无 GUI 能力，GUI 能力明确报"会话不可用"而非黑屏 |

---

## 7. 监管与可观测（NFR-504~509）

详见 `SECURITY-GOVERNANCE.md`，此处仅列架构落点：

| 机制 | 架构落点 |
|---|---|
| 风险分级 L0-L3 | `contracts` 定义 + `vm-capabilities` 每个能力声明 + `core/policy` 执行 |
| 白名单 / 拒绝优先 | `core/policy`（路径/进程/注册表白名单 + 路径/命令/进程黑名单；**命令面只有黑名单**，`commandAllowlist` 已删除，ARCH-18） |
| 审批闸 | `core/policy` 判定 → MCP 侧返回待确认 / A2A 侧置 `input-required` |
| 哈希链审计 | `core/audit`（append-only，每条含 `prevHash`）。⚠ **校验范围限定语**：`vm-service` 装配为 `freshChainOnStart:true` ⇒ `verifyChain()`（= `/health.audit.chainValid`）**只覆盖本轮运行的分片**，跨轮历史改由启动 `verifyArchive()` 落的 `chain-archive-verify` 条目提供证据；范围本身机器可读（`audit.scope='session'|'full'` + `shardsVerified/shardsTotal/shardsArchived`）。详见 `SECURITY-GOVERNANCE.md` §4.3.1 与 §6.4 权衡一 |
| 信任边界 | **回环绑定 + SSH 隧道 + 审批闸**，服务端不承担身份鉴权；非回环 ⇒ 启动 `error`（`requireLoopbackBind=false` 已无法放宽，ARCH-07 B 基线）。`security.enforceBearer` 为**可选加固**（默认 false；双条件才挂载守卫；`/health.security.authMode` 三态透出）——**开启前须先补齐 VM 内回连凭据通路，否则宿主不带凭据当场 401、VM 内回连全 401 使委派退化为零副作用虚假完成（`completed`+`zeroInnerCalls:true`，B3 真机实测，见 §10 R4 与本表下方说明）** |
| 任务取消（真取消） | 契约 `ProgressSink.isCancelled()/cancellationSignal` → 框架 `TaskStore.cancelController` + `addArtifact` 终态守卫 → 服务端 `onGoalTerminal` 三分支（`canceled` 入链、`errorCode:'TASK_CANCELED'`）→ 执行体消费（确定性 `step()` 咽喉 / LLM turn 边界 + CLI 子进程 kill）→ 宿主两态事实化。**协作式、非抢占**（见 `SECURITY-GOVERNANCE.md` §2.2） |
| 宿主侧静态禁用 | `adapter-host-workbuddy` 生成 `mcp.json` 时写入 `disabledTools` |
| traceId 全链路 | `core` 注入，贯穿 MCP/A2A/能力执行/审计 |
| before/after 快照 | L2/L3 操作自动截图 + 变更清单，作为 A2A artifact 回传 |

---

## 8. 部署视图

| 组件 | 部署位置 | 形态 | 运行身份 |
|---|---|---|---|
| 6 个 Skills | 宿主机 `~/.workbuddy/connectors/skills/connector-winvm/` | 文件 | — |
| 连接器配置 | 宿主机 `~/.workbuddy/connectors/<account>/mcp.json` | 配置 | — |
| 插件清单 | 宿主机 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/<ver>/` | 文件 | — |
| SSH 隧道 | 宿主机 | 由 `winvm-orchestrator` 管理的后台进程 | 当前用户 |
| `vm-service` | VM | 常驻进程（**交互式会话内**） | VM 登录用户 |
| `ps-bridge` | VM | `vm-service` 的子进程 | 同上 |
| 审计日志 | VM | `%LOCALAPPDATA%\WinVMBridge\audit\*.jsonl` | 同上 |

---

## 9. 关键技术决策（ADR 摘要）

| ID | 决策 | 备选 | 选择理由 |
|---|---|---|---|
| ADR-1 | 双通道 MCP + A2A | 单 MCP | 兼顾透明度与自主性；二者均为标准且互补 |
| ADR-2 | 默认 SSH 隧道（端口转发） | ssh→stdio | stdio 无法承载 A2A；端口转发统一支撑双通道且 VM 零端口暴露 |
| ADR-3 | PowerShell + .NET 能力层 | Python windows-mcp | 零依赖、可审计、与宿主运行时一致 |
| ADR-4 | ps-bridge 常驻进程 | 每次 spawn | 满足 NFR-503 P95 < 300ms |
| ADR-5 | TypeScript/Node 服务层 | Python | MCP/A2A TS SDK 成熟；WorkBuddy 自带 Node ≥20 |
| ADR-6 | V1 VM Agent = 确定性执行器（**默认 provider**） | 复用 WorkBuddy LLM | 确定性、省资源、可预测，先把链路与安全内核跑通；`agent.provider` 一行切换即可升级为 LLM provider，框架零改动（见 SPEC-AGENT-SERVICE-BRIDGE §6.1） |
| ADR-7 | 服务禁注册为 Windows 服务 | Windows 服务 | Session 0 必然黑屏（评估建议 §二） |
| ADR-8 | 契约集中在 `contracts` 包 | 各包自建类型 | 单一事实源，契约校验可 CI 化 |
| ADR-9 | 新增 **appops（应用生产操作）第五能力域** | 仅在 gui 域堆叠 | 用户要的"操作 Windows 软件应用进行生产活动"是独立维度：与 gui（交互/自动化原语）解耦，承载 应用状态/CLI 调度/工作流/ COM 自动化/ GUI 生产；确定性 V1 与后续 LLM provider 共用同一契约 |
| ADR-10 | `agent.provider` 作 VM 侧 AI Agent 总开关；V1 落地 `workbuddy`（LLM）选型 | 把 LLM 写死进确定性执行器 | 可插拔 provider 经 loader 动态 `import`，切换仅改 `agent.provider` 一行；V1 先实现 `workbuddy`（VM 内 `codebuddy` CLI 运行时），后续可加 `hermes`/`remote-proxy` 等，框架零改动（见 `LLM-PROVIDER.md`） |
| ADR-11 | 宿主侧以 **stdio MCP 桥** 补齐 A2A 一跳；简单任务走 MCP 直调、复杂任务走 A2A 委派 | 要求宿主原生支持 A2A；或把委派塞进 VM 侧某个 MCP 工具 | 宿主（WorkBuddy）是 MCP client 而非 A2A client，扩展点只有 MCP 连接器；桥以本地 stdio MCP server 落地，宿主零改造即可发 A2A，且同一条 SSH 隧道同时承载 `/mcp` 与 `/a2a`，不新增暴露面（见 `HOST-A2A-BRIDGE.md`） |
| ADR-12 | ps-bridge 看门狗**先 ping 探测再重启**，并真正实现自动重启 | 仅凭"心跳超时"直接 kill（原注释声称重启但未实现） | ps-bridge.ps1 主循环在等 stdin 时阻塞、空闲期发不出心跳，原逻辑会把健康进程误杀且永不恢复（服务空闲约 45s 后必废）。改为 ping 得通即视为健康；ping 不通才 kill + 重新 spawn，并修复"旧进程 exit 回调误清新进程引用"的竞态 |

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| VM 服务等于开放 RCE | **信任边界 = 回环监听 + SSH 隧道 + 审批闸**（服务端**不**承担身份鉴权，此为 ARCH-07 裁定的设计选择而非缺口）：仅回环绑定且**不可关**（非回环 ⇒ 启动 error）+ L2/L3 审批闸 + 拒绝优先白名单 + 宿主侧 `disabledTools`；`enforceBearer` 为可选加固（默认关，开前须补 VM 内回连凭据通路）。VM 内**任意本地进程都在信任域内** ⇒ 第 4/5 层不得放宽。详见 `SECURITY-GOVERNANCE.md` §2.1 |
| GUI 黑屏静默失败 | 会话健康探针 + 截图熵检测 + degraded 降级 + 明确报错 |
| 委派黑盒不可见 | A2A artifact 强制回传（截图/日志/变更清单）+ traceId 全链路 + 取消终态入链（`canceled` / `TASK_CANCELED`）+ 宿主 `executedBeforeCancel` 事实化 |
| ps-bridge 进程僵死 | 心跳 + 超时重启 + 请求级超时 |
| 审计被篡改 | 哈希链：**本轮运行期内**任一改动即校验失败（`/health.audit.scope='session'`）；跨轮历史由启动归档校验条目提供证据。⚠ 残留：跨轮整片删除不留断裂痕迹、审计无保留期 ⇒ 已登记为权衡（`SECURITY-GOVERNANCE.md` §4.3.1 / §6.4），非"已根治" |
| 依赖方向腐化 | CI 依赖方向检查脚本（FR-403） |
