# 现状调研与上下文分析（CONTEXT-ANALYSIS）

| 项 | 值 |
|---|---|
| 文档 ID | CONTEXT-ANALYSIS-winvm-bridge-001 |
| 项目 | workbuddy-virtual-win-plugin（产品名：**WinVM Bridge**） |
| 场景 | **A - NEW-PROJECT**（全新项目开发） |
| 调研日期 | 2026-08-28 |
| 调研人 | 架构交付总监（齐构成） |
| 状态 | 已完成，待评审 |

---

## 1. 项目概况理解（DDD Step 1.1）

### 1.1 用户诉求原文要点

> 为 workbuddy（宿主机上的一个具体 AI Agent 实现）构建一个插件，通过此插件宿主机的 workbuddy 可以**完全操作**我的 Windows 虚拟机，帮我在 Windows 虚拟机里做事（Windows 系统管理和使用、Windows 应用管理和使用、Windows 系统存储管理等**几乎所有**的 Windows 事情）。

### 1.2 诉求拆解

| 编号 | 诉求 | 性质 |
|---|---|---|
| RQ-1 | 宿主机 Agent（WorkBuddy）获得对 Windows VM 的**全域操作能力** | 功能性 |
| RQ-2 | 覆盖域：系统管理、应用管理、存储管理、以及"几乎所有 Windows 事情" | 功能性（开放性边界） |
| RQ-3 | 交付形态是"插件"，而非一次性脚本 | 架构性 |
| RQ-4 | VM 内 Agent 选型必须可替换（服务/模块/插件化解耦），V1 用 WorkBuddy | 架构性（**解耦要求**） |
| RQ-5 | 宿主机 Agent 插件规范必须可适配更多宿主 Agent，V1 用 WorkBuddy | 架构性（**解耦要求**） |
| RQ-6 | 分层解耦：宿主插件规范 / 宿主插件核心模块 / MCP 框架 / A2A 框架 / skills 规范 / 标准 Agent 服务桥接层 / VM 具体 Agent 服务层 | 架构性（**模块化要求**） |
| RQ-7 | 倾向 **1+4 方案 + 多 skills 支持** | 选型倾向 |
| RQ-8 | 技术体系可参考 WorkBuddy 部署（只读，禁止修改） | 调研约束 |
| RQ-9 | 遵从 ddd-skill + plan-first 方法论 | 流程约束 |
| RQ-10 | 目标："最先进、最可靠、最高效、标准化最高、最可监管" | 非功能性（**质量属性**） |

### 1.3 "1+4 方案" 语义澄清（关键决策点）

评估文档中「方案 1」= MCP 连接器底座，「方案 4」= A2A 服务 + Skill。用户同时提到"多 skills 支持"。

本项目的落地映射（两层含义兼容）：

- **通道层 1+4 中的一个"1"与一个"4"**：1 = MCP 连接器底座（方案 1）；4 = A2A 桥接服务（方案 4）。
- **知识层 1+4**：1 个总控编排 Skill + 4 个领域 Skill（系统 / 应用 / 存储 / GUI）。

最终形态：**双通道（MCP 主干 + A2A 委派）+ 五 Skill（1 总控 + 4 领域）**。此映射在 `REQUIREMENTS.md` 中基准确认。

---

## 2. 现状分析（DDD Step 1.2）

### 2.1 工作区现状

| 项 | 现状 |
|---|---|
| 目录 | `D:\Users\towyq\Documents\Projects\workbuddy-virtual-win-plugin` |
| 已有内容 | 仅 `docs/design/winvm_connector_plan.html`（前序方案评估建议） |
| 代码 | **无**（全新项目） |
| Git | 已初始化，无提交 |
| `.dev/` | 不存在，需新建 |

### 2.2 结论

属 **DDD 场景 A（NEW-PROJECT）**，Phase 1 执行 Step 1.1 / 1.4 / 1.5，跳过 1.2 深度（无历史）与 1.3（无存量 Bug）。

---

## 3. 评估建议调研（DDD Step 调研维度 6）

来源：`docs/design/winvm_connector_plan.html`（2026-08-28，依据 Windows MCP / A2A v1.0 / MCP 传输安全 / Windows 会话隔离）。

### 3.1 四方案评估结论摘录

| 方案 | 机制 | GUI 覆盖 | 结论 |
|---|---|---|---|
| 1. MCP/CLI 连接器 | VM 内起 MCP server，宿主机直接调 tools | 可覆盖（需交互式会话） | **推荐底座** |
| 2. Skill 而非连接器 | 写成 Skill 指引靠 prompt 执行 | 弱（无法稳定维持连接/回传截图） | 仅作配套 |
| 3. VM 内 Agent + 桥接连接器 | VM 内 Agent 自主完成，宿主机委派 | 最佳 | 高阶执行层 |
| 4. A2A 服务 + Skill | 同 3，桥改用 A2A 协议 | 最佳 | **桥接首选协议** |

### 3.2 推荐架构（分层混合 1 + 3/4）

- 以 **方案 1（MCP 连接器）为底座**承担 90% 命令行/系统/存储乃至 GUI 操作；
- 叠加 **方案 3/4（VM 内 Agent + A2A 桥）**作为高阶自主执行层，专攻多步骤、强 GUI 任务；
- 方案 2（Skill）只作配套知识，不担主渠道；
- 传输优先 **ssh 隧道跑 MCP stdio**；多客户端/生产化再上 Streamable HTTP + 令牌/TLS。

### 3.3 关键约束（分水岭）

> **Windows 会话隔离（Session 0）**：Windows 服务默认跑在 Session 0（无图形界面），截图得到**黑屏**、模拟键鼠 `Access denied`。GUI 自动化必须在 **Session 1+ 的交互式桌面（WinSta0\Default）**中运行。
>
> **RDP 断开即"失明"**：远程桌面点 X 断开，会话被挂起为无头状态，UI 自动化立刻失效。解决：`tscon` 交还物理控制台 / 虚拟或物理显示器 / 自动登录 + 禁休眠。
>
> **落地要求**：承载 GUI 的控制进程**必须作为用户会话进程启动**（登录自启、或"仅在用户登录时运行"的计划任务、或托盘程序），**不能**注册成系统服务。

### 3.4 风险清单（前序识别）

| 风险 | 缓解 |
|---|---|
| 等于给 VM 开 RCE | 强制令牌/SSH 鉴权、命令与路径白名单、仅限内网、全量日志；高危操作人工确认 |
| GUI 黑屏/失效 | 控制进程跑在用户会话 + 保活（自动登录 / tscon / 虚拟显示） |
| 委派"黑盒" | VM Agent 必须回传 artifact（截图、日志、变更清单），保持宿主机可见 |
| 资源占用 | VM Agent 仅在需要时启动，或常驻低配 |

### 3.5 落地路线图（前序建议）

Day 1 底座验证 → 会话保活 → 连接器接入；Day 2 加固（受控 shell）；Day 3+ 高阶（VM Agent + A2A + Skill）。

---

## 4. WorkBuddy 宿主技术体系调研（**本项目最关键的调研成果**）

调研源：`D:\program files\WorkBuddy`（**只读，未做任何修改**）。

### 4.1 运行时形态

| 项 | 事实 |
|---|---|
| 应用形态 | Electron 应用（`WorkBuddy.exe` + `resources/app.asar`，asar 体积 ~283MB） |
| 内置运行时 | `resources/vendor/` 自带 `node.zip`、`python.zip`、`PortableGit.zip` |
| 原生模块 | `app.asar.unpacked/node_modules/` 含 `better-sqlite3`、`koffi`(FFI)、`node-pty` |
| CLI | `app.asar.unpacked/cli/`（独立 CLI 二进制分发） |

> **推论**：WorkBuddy 自带 Node ≥20 与 Python，宿主机与虚拟机内均可复用其运行时，**无需额外安装 Node**。

### 4.2 插件（Plugin）体系

| 项 | 事实 |
|---|---|
| 插件缓存根 | `%USERPROFILE%\.workbuddy\plugins\cache\<marketplace>\<plugin>\<version>\` |
| 安装注册表 | `%USERPROFILE%\.workbuddy\plugins\installed_plugins.json`（`version: 2`） |
| Marketplace 清单 | `<marketplace-root>\.codebuddy-plugin\marketplace.json` |
| 单插件清单 | `<plugin-root>\.codebuddy-plugin\plugin.json` |

**marketplace.json 结构**（实测）：

```json
{
  "name": "workbuddy-builtin",
  "description": "...",
  "owner": { "name": "WorkBuddy", "email": "workbuddy@tencent.com" },
  "metadata": { "version": "1.0.0", "phase": "addon-context-orchestration" },
  "plugins": [
    { "name": "skill-wb-finance-skill", "description": "...",
      "source": "./skills/wb-finance-skill", "version": "0.1.0", "category": "skill" }
  ]
}
```

**plugin.json 结构**（实测，skill 类）：

```json
{
  "name": "skill-wb-finance-skill",
  "version": "0.1.0",
  "description": "WorkBuddy bundled skill resource: wb-finance-skill.",
  "author": { "name": "WorkBuddy" },
  "category": "skill",
  "keywords": ["workbuddy", "builtin-skill", "wb-finance-skill"],
  "workbuddy": {
    "kind": "builtin-skill",
    "legacyResourceName": "wb-finance-skill",
    "bundleSegments": ["plugins", "workbuddy-builtin", "skills", "wb-finance-skill"]
  }
}
```

**实测 category 取值**：`skill`、`mcp-app`、`interaction`、`welcomeMode`、`template`。

**Skill 插件目录形态**：

```
skills/<name>/
├── .codebuddy-plugin/plugin.json
├── SKILL.md                 # 必须
├── references/              # 可选：领域知识
├── workflows/               # 可选：多步流程
├── rules/                   # 可选：硬规则
├── scripts/                 # 可选：可执行脚本
└── scenes.json / scenes-en.json   # 可选：场景触发词
```

### 4.3 MCP 连接器（Connector）体系

| 项 | 事实 |
|---|---|
| 连接器配置 | `%USERPROFILE%\.workbuddy\connectors\<account-id>\mcp.json` |
| 全局 MCP | `%USERPROFILE%\.workbuddy\mcp.json`（用户自定义） |
| 聚合代理 | `%USERPROFILE%\.workbuddy\.mcp.json` → `connector-proxy` 聚合到 `http://127.0.0.1:<port>/mcp` |
| 启用状态 | `connector-states.v3.json`（`enabled` / `userDisabled` / `disabledToolsOverrides` / 加密 `headerOverrides`） |
| 凭据加密 | `aes-256-gcm` + `hkdf-sha256`，另有 `.master.key` |

**mcpServers 条目实测支持字段**：

| 字段 | 说明 | 实测样例 |
|---|---|---|
| `type` | `stdio` \| `streamableHttp` \| `streamable-http` \| `sse` \| `http` | `"streamableHttp"` |
| `url` | 远端端点 | `https://.../mcp` |
| `command` + `args` | stdio 本地进程 | `npx` + `["-y","@cloudbase/cloudbase-mcp@latest"]` |
| `headers` | 含 `${ENV_VAR}` 占位 | `{"Authorization":"Bearer ${BUGLY_ACCESS_TOKEN}"}` |
| `staticHeaders` | 静态请求头 | `{"X-Request-Source":"workbuddy"}` |
| `env` / `staticEnv` | 环境变量 | `{"NO_PROXY":"localhost,127.0.0.1,::1"}` |
| `runtime` | 运行时约束 | `{"type":"node","version":">=20"}` |
| `npmRegistry` | 源覆盖 | `https://registry.npmmirror.com` |
| `timeout` | 毫秒 | `600000` |
| `disabled` | 默认禁用 | `true` |
| **`disabledTools`** | **禁用指定危险工具** | `["lebao_drop"]` |

> **关键推论 ①**：WorkBuddy 连接器原生支持 **`disabledTools`**，可在宿主侧静态禁用 VM 侧的高危工具 —— 这是"最可监管"的现成抓手。
>
> **关键推论 ②**：WorkBuddy 连接器原生支持 **stdio + command/args**，因此评估文档推荐的 **ssh 隧道跑 MCP stdio**（`ssh vmuser@vmip <agent> --stdio`）可直接映射为 `command: "ssh"`, `args: [...]`，**零改造接入**。

### 4.4 Connector + Multi-Skills 现成范式（**直接对应"1+4 + 多skills"**）

实测目录 `%USERPROFILE%\.workbuddy\connectors\skills\connector-wecom\`：

```
connector-wecom/
├── wecomcli-shared/SKILL.md      # 公共前置（CLI 检查/授权/输出约束）
├── wecomcli-calendar/SKILL.md
├── wecomcli-contact/SKILL.md
├── wecomcli-disk/SKILL.md
├── wecomcli-doc/SKILL.md + references/ + scripts/
├── wecomcli-doc-manage/SKILL.md
├── wecomcli-email/SKILL.md
├── wecomcli-media/SKILL.md
├── wecomcli-meeting/SKILL.md
├── wecomcli-message/SKILL.md
├── wecomcli-sheet/SKILL.md
├── wecomcli-smartpage/SKILL.md
├── wecomcli-smartsheet/SKILL.md
└── wecomcli-todo/SKILL.md
```

**这是 WorkBuddy 官方的一手范式：1 个 MCP 连接器 + N 个配套 Skills。**

本项目直接复用该范式：

```
connector-winvm/
├── winvm-orchestrator/SKILL.md        # 1 总控（路由+安全分级+审批）
├── winvm-system-admin/SKILL.md        # 4 领域之一：系统管理
├── winvm-app-manager/SKILL.md         # 4 领域之二：应用管理
├── winvm-storage-manager/SKILL.md     # 4 领域之三：存储管理
└── winvm-gui-automation/SKILL.md      # 4 领域之四：GUI/桌面/浏览器
```

### 4.5 对架构设计的硬约束总结

| 约束 | 影响 |
|---|---|
| 插件清单必须含 `.codebuddy-plugin/plugin.json` | 宿主适配器的产物形态被固定 |
| Skill 必须有 `SKILL.md` | Skills 规范的落地格式被固定 |
| 连接器通过 `mcp.json` 的 `mcpServers` 注册 | 底座通道的接入方式被固定 |
| 连接器支持 `disabledTools` | 宿主侧静态风控可行 |
| 连接器支持 stdio + command/args | SSH 隧道方案零改造可行 |
| WorkBuddy 自带 Node ≥20 / Python | VM 侧服务可不依赖外部安装 |

---

## 5. 标准协议调研（DDD Step 调研维度 2/6）

### 5.1 MCP（Model Context Protocol）

| 项 | 事实 |
|---|---|
| 定位 | **客户端 → 工具**。让 AI 应用连接数据源、工具、工作流 |
| 传输 | `stdio`（本地子进程，无网络面）+ **Streamable HTTP**（远端，取代旧 HTTP+SSE） |
| 交互 | JSON-RPC 2.0，同步请求/响应为主 |
| 适合 | 调用具体工具；**不适合**与自治实体协商任务 |

### 5.2 A2A（Agent2Agent Protocol）v1.0

| 项 | 事实 |
|---|---|
| 定位 | **Agent ↔ Agent** 任务委派与协作 |
| 治理 | Google 发起，2025-06 起由 **Linux Foundation** 托管；**v1.0（2026）** |
| 规范分层 | 第 1 层 规范数据模型（protobuf 为唯一权威源 `spec/a2a.proto`）；第 2 层 抽象操作；第 3 层 协议绑定 |
| 绑定 | **JSON-RPC 2.0 over HTTPS**（最常用）、gRPC、HTTP+JSON/REST |
| 发现 | Agent Card：`/.well-known/agent-card.json`（RFC 8615） |
| 版本协商 | 请求头 `A2A-Version`；不支持返回 `VersionNotSupportedError` |
| **v1.0 方法名** | `message/send`、`message/stream`、`tasks/get`、`tasks/list`、`tasks/cancel`、`tasks/subscribe`、`tasks/pushNotificationConfig/set`、`tasks/pushNotificationConfig/get`、`agent/getAuthenticatedExtendedCard` |
| 任务状态 | `submitted` → `working` → `completed` / `failed` / `canceled` / `rejected` / **`input-required`** |
| Part 类型 | `TextPart`、`FilePart`、`DataPart` |
| Artifact | 任务产出的输出（文档、图像、结构化数据），由 Parts 组成 |
| 流式 | SSE（`TaskStatusUpdateEvent` + `TaskArtifactUpdateEvent`） |
| 推送通知 | 服务端 HTTP POST 到客户端 webhook |
| **v1.0 新增** | **签名 Agent Card**（JWS / Ed25519 / RFC 8785 JCS 规范化）；原生**多租户**（`tenant`）；`supportedInterfaces[]` 声明各绑定及各自 `protocolVersion` |

> **注意（易错点）**：v1.0 已将旧方法 `tasks/send` → **`message/send`**、`tasks/sendSubscribe` → **`message/stream`**；旧字段 `preferredTransport`/`additionalInterfaces` → **`supportedInterfaces[]`**。部分网络教程仍使用旧名，实现时必须以 v1.0 为准。

### 5.3 A2A 与 MCP 的关系（混合架构，二者都要）

> 生产级复合 AI 应用：**A2A 负责高层编排，MCP 负责具体工具执行。**
> 例：A2A「HR Agent」委派 → A2A「Calendar Agent」→ 该 Agent 本地用 MCP 调日历工具 → 结果作为 artifact 经 A2A 回传。

**本项目完全符合该模式**：
- 宿主 WorkBuddy →（A2A）→ VM 内 Agent（委派长任务 / 强 GUI 多步任务）
- 宿主 WorkBuddy →（MCP）→ VM 内工具（直接调 PowerShell 能力）
- VM 内 Agent →（本地 MCP）→ Windows 能力工具集

### 5.4 Windows 侧能力来源调研

| 来源 | 说明 | 选型考虑 |
|---|---|---|
| `windows-mcp` | Python，UI 自动化 + PowerShell | 依赖 Python 环境，GUI 强 |
| `win-cli-mcp-server` | 受控多 shell，命令/路径白名单 + 日志 | 安全模型好 |
| **原生 PowerShell + .NET** | PowerShell 5.1+ 系统/应用/存储全原生；GUI 可 `Add-Type` P/Invoke `user32.dll` `SendInput`，UIA 走 `System.Windows.Automation` | **零依赖、可审计、与 WorkBuddy 自带运行时一致** |

---

## 6. 问题成因调研（DDD Step 1.3）

**不适用** —— 全新项目，无存量问题。历史方案评估中识别的风险已列入 §3.4，将在安全设计中逐条给出工程化缓解措施。

---

## 7. 调研结论与下一步

### 7.1 已确认的可行性

1. ✅ WorkBuddy 插件体系可承载"连接器 + 多 Skills"，且有官方一手范式（wecom）。
2. ✅ WorkBuddy 连接器原生支持 stdio/ssh 与 Streamable HTTP 双传输，评估方案可直接落地。
3. ✅ WorkBuddy 连接器原生支持 `disabledTools`，宿主侧静态风控可行。
4. ✅ WorkBuddy 自带 Node ≥20 / Python，VM 侧服务无需额外安装运行时。
5. ✅ A2A v1.0 与 MCP 均为 Linux Foundation / 行业生产级标准，满足"标准化最高"。
6. ✅ GUI 约束有明确工程解（交互式会话 + 保活），非阻塞性难题。

### 7.2 关键设计决策（待 REQUIREMENTS.md 基准确认）

| 编号 | 决策 | 依据 |
|---|---|---|
| D-1 | **双通道**：MCP（主干/透明/省 token）+ A2A（委派/长任务/强 GUI） | 评估建议 §三、A2A/MCP 混合架构 |
| D-2 | **1+4 Skills**：1 总控 + 4 领域（系统/应用/存储/GUI） | 用户倾向 + WorkBuddy connector-skills 范式 |
| D-3 | **传输默认 SSH 隧道**（VM 仅监听 127.0.0.1，宿主本地端口转发） | 评估建议 §四；不开公网端口，最安全 |
| D-4 | **VM 侧能力实现用原生 PowerShell + .NET**，经常驻 `ps-bridge` 进程调用 | 零依赖 + 高效（避免每次 ~1s 进程启动开销） |
| D-5 | **VM 侧服务必须运行在交互式用户会话**，禁止注册为 Windows 服务 | 评估建议 §二（Session 0 黑屏） |
| D-6 | **三层解耦**：规范（contracts）/ 核心（core+frameworks）/ 适配器（adapters） | 用户 RQ-4、RQ-5、RQ-6 |
| D-7 | **实现语言 TypeScript/Node**（服务与协议层）+ PowerShell（能力层） | WorkBuddy 自带 Node；MCP/A2A TS SDK 成熟 |

### 7.3 下一步

进入 **Phase 2 设计阶段**：
- `REQUIREMENTS.md` —— 功能/非功能需求基线与确认（R1/R2）
- `ARCHITECTURE.md` —— 总体架构（R3）
- 四份解耦规范 + `INTERFACES.md` + `SECURITY-GOVERNANCE.md`

---

## 8. 调研检查清单

- [x] 是否了解当前版本状态？（全新项目，仅 1 份评估 HTML）
- [x] 是否了解相关模块架构？（WorkBuddy 插件/连接器/Skills 体系已实测）
- [x] 是否了解业务流程？（宿主委派 → 传输 → VM Agent → Windows 能力）
- [x] 是否完成根因分析？（N/A，无存量 Bug）
- [x] 是否查阅历史决策？（已读 `winvm_connector_plan.html` 全部结论）
- [x] 是否收集相关建议？（用户 RQ-1~RQ-10 已拆解；评估建议已摘录）
- [x] 是否调研标准协议？（A2A v1.0 + MCP 已核实，含 v1.0 方法名易错点）
- [x] 是否调研运行环境约束？（Windows Session 0 / RDP 挂起 / WorkBuddy 运行时）
