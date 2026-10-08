# WinVM Bridge（winvm-bridge）

> 一套**分层解耦、标准协议驱动、强监管**的宿主 AI Agent 插件体系，使宿主机 AI Agent（V1 = WorkBuddy）能够安全、可控、可审计地**完全操作一台 Windows 虚拟机**——覆盖系统管理、应用管理、存储管理、GUI 自动化与图形化生产操作。

- **版本**：`0.1.0`（V1 基线）
- **形态**：npm workspaces 单仓，12 个可独立编译/发布的包 + 7 个 WorkBuddy Skill（1 总控 + 5 领域 + 1 MCP 参考）+ 双端一键部署器
- **状态**：核心链路与审批链已真机验收（详见 §10 文档导航与 `.dev/` 索引）
- **License**：私有（当前为单一项目仓库）

---

## 1. 项目目标

让"宿主机上的 AI Agent 接管一台 Windows 虚拟机"这件事从 demo 走向**可交付、可运维、可审计**：

1. **完全可操作**：几乎覆盖所有 Windows 事务——系统 / 应用 / 存储 / GUI / 图形化生产（见 §2.2）。
2. **标准化最高**：工具层用 **MCP**，委派层用 **A2A v1.0**（Linux Foundation 治理协议），Agent Card 落 `/.well-known/agent-card.json`。
3. **最可靠**：GUI 强制运行在交互式会话；会话挂起自动探测；传输断线重连；操作超时可控；黑屏检出即告警而非静默失败。
4. **最高效**：高频 PowerShell 调用走常驻 `ps-bridge` 进程（避免每次 ~1s 进程启动）；默认走省 token 的 MCP 直调，仅长任务委派 A2A。
5. **最可监管**：L0–L3 风险分级 + 策略引擎（白名单拒绝优先）+ 人工审批闸 + **防篡改哈希链审计** + 全链路 traceId。
6. **高度解耦、可替换**：VM 内 Agent 可替换（SPI 接入）、宿主 Agent 可适配、Skills 与宿主格式解耦、分层边界强制单向依赖。

---

## 2. 功能特性

### 2.1 双通道

| 通道 | 用途 | 特点 |
|------|------|------|
| **MCP 直调**（主干） | 简单、确定性、工具级精确执行（查磁盘 → 启服务 → 装应用） | 透明、省 token、结构化 tool 结果 |
| **A2A v1.0 委派**（长任务） | 把多步 / 强 GUI 任务整体交给 VM 内 Agent，流式回传进度 | `tasks/get` 轮询、`tasks/cancel`、`input-required` 审批、artifact 回传（截图/日志/变更清单） |

两通道共享**同一套能力注册表**与**同一套策略/审批内核**，绝不出现两套风控。

### 2.2 五大 Windows 能力域（54 个能力）

| 能力域 | 覆盖内容 |
|--------|----------|
| **系统管理** `system` | 服务 / 进程 / 计划任务 / 注册表 / 网络配置 / 用户与组 / 环境变量 / 系统信息 / 电源与更新 / 事件日志 |
| **应用管理** `app` | 已装清单、winget 安装/卸载/升级、启动与激活、快捷方式、默认程序、UWP 包 |
| **存储管理** `storage` | 磁盘/分区/卷、空间分析、目录树、文件读写与搜索、压缩解压、符号链接、配额、回收站、清理建议 |
| **GUI 自动化** `gui` | 截图（全屏/窗口/区域）、键鼠模拟、窗口枚举与置顶、UIA 元素树与点击、剪贴板、浏览器自动化 |
| **应用生产操作** `appops` | 用 Photoshop/Office/ffmpeg/IDE 等软件**把活干出来**（应用状态/CLI 调度/工作流/COM 自动化/GUI 生产） |

### 2.3 七 Skill（1 总控 + 5 领域 + 1 MCP 参考）

| Skill | 职责 |
|-------|------|
| `winvm-orchestrator`（总控） | 意图识别 → 领域路由 → 通道选择（MCP 直调 vs A2A 委派）→ 风险分级 → 审批闸 → 结果汇总 |
| `winvm-system-admin` | 系统管理领域知识、PowerShell 惯用法、常见陷阱 |
| `winvm-app-manager` | 应用管理（winget/Store/卸载残留清理等） |
| `winvm-storage-manager` | 存储管理（空间分析、安全清理边界、不可逆操作清单） |
| `winvm-gui-automation` | GUI 自动化（会话保活、坐标 vs UIA、截图判读、等待策略） |
| `winvm-app-operation` | 应用生产操作领域知识（"用哪个软件、按什么生产逻辑出成品"） |
| `winvm-mcp-reference`（MCP 参考） | WinVM MCP 服务部署与接入参考（端点 / 鉴权 / VM Agent 选型接入 / 注册验证 / 常见故障） |

### 2.4 强监管内核（NFR 落点）

- **风险分级** `L0/L1/L2/L3`：每个能力标注风险等级。
- **策略引擎**：命令白/黑名单（正则）、路径白名单、进程白名单、网络端点限制；**默认拒绝优先**。
- **审批闸**：L2/L3 操作默认需人工确认（A2A `input-required` / MCP 侧前置确认）；支持按能力免审。
- **防篡改审计**：结构化 append-only 日志，**哈希链**（每条含前一条 hash），篡改任意一条 → 校验立即失败。
- **可观测**：全链路 `traceId` 贯穿 宿主→传输→VM 服务→能力执行；关键操作附 before/after 快照 artifact。
- **网络安全**：VM 侧服务**仅监听 `127.0.0.1`**；SSH 隧道本地端口转发；Streamable HTTP 模式强制 TLS + bearer + Origin 校验；VM 对外零端口暴露。

### 2.5 可替换的 Agent / 宿主

- **VM 内 Agent 三选项**（经 `agent.provider` 一行切换，框架零改动）：
  - `workbuddy-deterministic`（确定性执行器，**默认**，先把链路与安全内核跑通）
  - `workbuddy`（VM 内 `codebuddy` CLI 的 LLM 执行器，V1 已实现）
  - `hermes-agent`（Nous Research 的 Hermes Agent，经 `config.yaml.mcp_servers` 预注册 MCP）
- **宿主侧适配器**：V1 = WorkBuddy；`host-sdk` 已中性化，可另加 `adapter-host-claude`/`adapter-host-cursor` 等。

---

## 3. 技术方案

### 3.1 架构总览（三层解耦 + 双通道 + 七 Skill）

```
┌─────────────────────────────── 宿主机（Host） ───────────────────────────────┐
│  ┌──────────────────────── 宿主机 Agent（V1 = WorkBuddy） ─────────────────┐ │
│  │   ┌─────────────── 知识层：7 Skills（1+5+1 MCP 参考） ──────────────┐      │ │
│  │   │  winvm-orchestrator   ← 总控：路由 / 通道选择 / 风控    │          │ │
│  │   │  winvm-system-admin   │  winvm-app-manager              │          │ │
│  │   │  winvm-storage-manager│  winvm-gui-automation           │          │ │
│  │   │  winvm-app-operation  ← 应用生产操作                    │          │ │
│  │   └────────────────────────────────────────────────────────┘          │ │
│  │            │ 路由                                                          │
│  │   ┌────────▼──────────── 通道层 ──────────────────────┐                 │ │
│  │   │  通道 A：MCP Client（主干·透明·省 token）         │                 │ │
│  │   │  通道 B：A2A Client（委派·长任务·artifacts）      │                 │ │
│  │   └────────┬──────────────────────────────────────────┘                 │ │
│  └────────────┼──────────────────────────────────────────────────────────┘ │
│               │  adapter-host-workbuddy（宿主适配器，可替换）                 │
└───────────────┼────────────────────────────────────────────────────────────┘
                │
        ┌───────▼──────── 传输层（可插拔） ────────┐
        │  ssh-tunnel（默认·VM 仅监听 127.0.0.1）  │
        │  streamable-http（TLS + bearer）         │
        │  stdio（本地/测试）                        │
        └───────┬──────────────────────────────────┘
                │
┌───────────────▼───────── Windows 虚拟机（VM） ──────────────────────────────┐
│  ┌──────────── vm-service：统一 Agent 服务（交互式会话内） ──────────────┐  │
│  │   MCP Server（/mcp）            A2A Server（/a2a + Agent Card）       │  │
│  │        └────────────┬────────────────────┘                            │  │
│  │   ┌───────── 标准 Agent 服务桥接转换层（SPI） ─────────┐              │  │
│  │   │  AgentServiceProvider 接口 + 可替换 adapter         │              │  │
│  │   └──────────────────────┬─────────────────────────────┘              │  │
│  │   ┌──────── 统一能力注册表 + 策略引擎 + 审计链 ────────┐              │  │
│  │   │  L0/L1/L2/L3 风险分级 · 白名单 · 审批闸 · 哈希链   │              │  │
│  │   └──────────────────────┬─────────────────────────────┘              │  │
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

### 3.2 分层包结构（12 包，依赖单向）

| 层 | 包 | 职责 |
|----|----|------|
| **L0 规范** | `contracts` | 全系统唯一契约源：风险/能力/传输/审计/桥接/宿主/A2A 的 TS 类型 + JSON Schema |
| **L1 核心** | `core` | transport（HTTP/SSH/stdio 抽象）、registry、policy（策略引擎）、audit（哈希链）、session（保活）、bridge（加载器）、config |
| **L2 协议** | `mcp-framework` | MCP server/client（Streamable HTTP + stdio） |
| | `a2a-framework` | A2A v1.0 server/client（AgentCard/message/send/stream/tasks/*/artifacts/input-required） |
| **L3 宿主规范** | `host-sdk` | 中性插件模型 SDK（patch/skill-loader/渲染抽象） |
| | `adapter-host-workbuddy` | 把中性模型渲染为 WorkBuddy 原生 plugin.json / marketplace.json / connector mcp.json（MCP 直调 + A2A 委派桥两个连接器） |
| | `host-a2a-bridge` | stdio MCP server，暴露 `a2a.delegate` / `task.get` / `approval.reply` / `task.cancel` / `health`，内部用 A2A client 调 VM `/a2a`（补齐宿主→VM 的 A2A 一跳） |
| **L3 VM 能力** | `vm-capabilities` | ps-bridge 常驻进程 + system/app/storage/gui/appops 五大 PowerShell 模块 + 能力注册表 + 空闲自愈 |
| **L3 VM 适配** | `adapter-agent-workbuddy` | VM 内确定性执行器（`workbuddy-deterministic`，可替换） |
| | `adapter-agent-workbuddy-llm` | VM 内 LLM 执行器（`workbuddy` 选型，V1 实现），复用确定性执行器、仅 `runGoal` 为 LLM 驱动 |
| | `adapter-agent-hermes` | Hermes Agent 执行器（`hermes-agent` 选型），MCP 经 `config.yaml` 预注册 |
| **装配** | `vm-service` | 同端口双协议服务端 + CLI 入口（`agent.provider` 总开关） |

> 依赖方向单向：`contracts` ← `core/frameworks` ← `adapters/vm-service`，由 `scripts/dep-lint.mjs` 在本地把关（反向依赖即失败）。

### 3.3 双通道设计

- **何时走哪个**：简单、确定性、可一步完成的 → MCP 直调；长任务、强 GUI、需多步自主决策 → A2A 委派。
- **同一内核**：两个通道共用能力注册表、策略引擎、审批闸与审计链，风险分级与审批行为完全一致（FR-103）。

### 3.4 Windows 能力层

- **为什么 PowerShell + .NET**：零依赖、可审计、与宿主运行时一致（不引 Python 方案）。
- **ps-bridge 常驻进程**：高频调用不再每次 spawn（约 1s 启动开销），热路径 P95 < 300ms（NFR-503）；带 ping 探测看门狗，空闲僵死自动重启。
- **会话保活**：服务注册为**交互式会话内的计划任务（LogonTrigger）**而非 Windows 服务——避免 Session 0 黑屏（ADR-7）。

### 3.5 关键技术决策（ADR 摘要）

| ID | 决策 | 选择理由 |
|----|------|----------|
| ADR-1 | 双通道 MCP + A2A | 兼顾透明度与自主性，二者标准且互补 |
| ADR-2 | 默认 SSH 隧道（端口转发） | stdio 无法承载 A2A；端口转发统一支撑双通道且 VM 零端口暴露 |
| ADR-3 | PowerShell + .NET 能力层 | 零依赖、可审计、与宿主运行时一致 |
| ADR-4 | ps-bridge 常驻进程 | 满足 P95 < 300ms |
| ADR-5 | TypeScript/Node 服务层 | MCP/A2A TS SDK 成熟；WorkBuddy 自带 Node ≥20 |
| ADR-6 | V1 默认确定性执行器 | 先把链路与安全内核跑通；`agent.provider` 一行切换升级 LLM，框架零改动 |
| ADR-7 | 服务禁注册为 Windows 服务 | Session 0 必然黑屏 |
| ADR-8 | 契约集中在 `contracts` | 单一事实源，契约校验可 CI 化 |
| ADR-9 | 新增 `appops` 第五能力域 | "操作软件进行生产"是独立维度，与 gui 解耦 |
| ADR-10 | `agent.provider` 作 VM AI Agent 总开关 | 可插拔 provider 动态 `import`，切换仅改一行 |
| ADR-11 | 宿主侧以 stdio MCP 桥补齐 A2A 一跳 | 宿主是 MCP client 非 A2A client，桥以本地 stdio 落地，零改造 |
| ADR-12 | ps-bridge 看门狗先 ping 再重启 | 修复"心跳超时误杀健康进程且永不恢复" |

---

## 4. 目录结构

```
workbuddy-virtual-win-plugin/
├── package.json              # workspace 根（npm workspaces，12 包）
├── tsconfig.base.json        # 共享 TS 配置（strict, ESM）
├── tsconfig.build.json       # 构建引用图（注意：根目录无 tsconfig.json，须用此文件构建）
├── docs/                     # 调研 / 设计 / 交付文档（01-investigation / 02-design / test/reports）
├── packages/                 # 12 个可独立编译/发布的 npm 包（见 §3.2）
├── skills/                   # 7 个 WorkBuddy Skill（1 总控 + 5 领域 + 1 MCP 参考）+ 各 Skill 内 mcps-reference
├── tests/                    # unit/（逐文件运行）+ e2e/
├── delivery/                 # 安装器 + 部署配置（见 §5/§6）
└── .dev/                     # DDD 文档驱动开发六大索引（开发治理入口）
```

---

## 5. 安装与部署

### 5.1 前置条件

- **宿主机**：Node ≥ 20；已安装本插件对应宿主 Agent（V1 = WorkBuddy）。
- **Windows VM**：已开启 SSH（OpenSSH Server）；VM 内有一台登录用户（`User@172.16.100.2`）；`codebuddy` CLI（LLM provider 需要）。
- **网络**：宿主机可 SSH 到 VM；VM 内服务仅监听 `127.0.0.1:18443`，经 SSH 隧道在宿主机本地回环转发。
- **配置**：复制 `.env.example` → `.env`（双端部署配置，含 `WINVM_VM_PROVIDER` / `WINVM_VM_HOST` / `WINVM_VM_USER` / `WINVM_VM_SSH_PORT` / `WINVM_VM_PORT`）。

### 5.2 双端一键部署（推荐）

```bash
# 先 dry-run 看七阶段计划（构建 / 宿主 / VM / 隧道 / 自检）
node delivery/setup.mjs
# 真执行
node delivery/setup.mjs --apply
```

`setup.mjs` 读 `.env`，按阶段执行：BUILD → HOST（安装宿主插件到缓存）→ VM（SSH 分发 + 建软链 + 注册交互式计划任务 + 自检）→ TUNNEL（SSH 端口转发）→ HEALTH（解析 `/health` 的 `session.interactive`）。

### 5.3 分步部署（排查用）

```bash
# 宿主侧：安装 / 卸载（幂等、增量、dry-run 支持）
node delivery/install-host.mjs --yes        # 安装到 ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/
node delivery/install-host.mjs --uninstall --yes

# VM 侧：分发 + 注册计划任务 + 自检（--provider 选 workbuddy-deterministic|workbuddy|hermes-agent）
node delivery/deploy-vm.mjs --apply --env=.env.deploy-vm [--provider workbuddy]

# 隧道：复用 / 守护 / 回落（仅绑本地回环，pidfile + state 持久化）
node delivery/winvm-plugin.mjs tunnel ensure
```

> 部署期会把 VM 连接信息持久化到 `~/.workbuddy/winvm/vm-conn.json`；宿主侧 `health`/`server`/`command` 无需每次传 `--vm-host/--vm-user`。

---

## 6. 运维

所有日常运维通过零依赖的 `winvm-plugin.mjs`（host/VM 同一份脚本，自动识别上下文）：

```bash
node delivery/winvm-plugin.mjs health          # 全链路健康：隧道 / provider / GUI / 审计链 / 54 能力
node delivery/winvm-plugin.mjs tunnel status    # 隧道状态（运行中 / 监听 / 目标 VM / 进程 pid / pidfile 属主）
node delivery/winvm-plugin.mjs tunnel ensure    # 确保隧道存在（复用 / 守护 / 回落三级）
node delivery/winvm-plugin.mjs server status    # VM 服务进程状态
node delivery/winvm-plugin.mjs list skills      # 已装领域 Skill 清单
node delivery/winvm-plugin.mjs list mcp-tools   # 暴露的 MCP 工具清单
node delivery/winvm-plugin.mjs command "<ps>"   # 在 VM 内执行一条 PowerShell（受策略内核约束）
node delivery/winvm-plugin.mjs uninstall --vm   # 卸载（宿主 / VM 侧）
```

**重要运维事实（鸿蒙宿主场景）**：

- **隧道是宿主 WorkBuddy 的 UID 进程**，不是系统级服务。`detached` 使其脱离终端、父进程退出后仍存活；但强制停止 / 卸载 WorkBuddy 会被按 UID 一并杀掉（鸿蒙 UID 生命周期硬约束，非 bug）。
- 隧道状态文件写在共享存储（`~/.workbuddy/winvm/tunnel.pid|state.json|log`），故可在另一 App（如 HiShell）用同一脚本"看见"其状态；其判活依赖 `kill(pid,0)` 的跨 UID `EACCES≠死 / ESRCH=死` 语义，不表示隧道已提升为系统服务。
- **审计日志（VM 侧）**：`%LOCALAPPDATA%\WinVMBridge\audit\audit-YYYYMMDD.jsonl`（哈希链，可事后校验）。

---

## 7. 使用（在 WorkBuddy 中）

1. 插件与 7 个 Skill 安装后，宿主连接器写 `mcp.json` 暴露两个连接器：`connector:winvm`（MCP 直调）与 `connector:winvm-a2a`（A2A 委派桥）。
2. 直接用自然语言下达 Windows 操作指令即可，例如：
   - "看看 VM 的 C 盘还剩多少空间" → 总控路由到 `storage` 域，MCP 直调。
   - "在虚拟机里把 Photoshop 导出的图批量转成 webp" → 路由到 `appops`，A2A 委派长任务，流式回传进度与产物。
3. **审批体验**：涉及 L2/L3 的操作，宿主侧弹出**审批卡片**（含能力 ID、风险等级、真实目标摘要 `underlying`）→ 你批准 → 结果传回 VM Agent → 按审批结果继续（K5 已根治"批准后假成功"：服务端确定性重放真实执行，LLM 文本不再是完成证据，审计链留下 `*-replay` 执行回执）。

---

## 8. 开发

```bash
npm install
npm run build                 # = tsc -b tsconfig.build.json（根无 tsconfig.json，必须带此参数）
npm run typecheck            # 同上，类型检查

# ⚠️ 测试须逐文件跑（沙箱约束）：整批 node --test 会因 link-workspace 的 symlink(junction)
# 触发进程访问违例、连带判死所有文件。务必逐文件：
for f in tests/unit/*.test.js; do node "$f"; done
```

当前测试基线（2026-10-07 逐文件实测）：**1054/1054（59 个测试文件，全量逐文件 PASS / 0 fail / 0 skipped）**，覆盖契约、策略、审计、双协议、审批链（K3/K4/P3/K5/A5/K-N1/K-N2/S-4/CL-K3R）等核心模块。

---

## 9. 后续完善建议（Roadmap）

### 9.1 能力层修复（建议优先）

- **K6 · winget 假卸载**：`winget uninstall` 对部分 NSIS 打包应用（如企业微信）报 `exit 0 / "Successfully uninstalled"` 但磁盘无变化（ARP 无 `QuietUninstallString`）。修复方向：`app.winget.uninstall` 增加**卸载后核验** + NSIS `/S` 回退；影响面是整个卸载能力，建议立项修复。

### 9.2 体验与可靠性边界

- **深度空闲冷启动**（K2 P2 边界）：服务重启后预热会话被 5min idle TTL 回收，首调会付一次冷启动（常驻 init 60s + 单次 `-p` 兜底）。可评估"idle 回收时延迟再预热"调度，覆盖该边界。
- **灰度 off 态 token 保留**（P2）：`WINVM_APPROVAL_REPLAY=off` 时 token 待短 TTL 清理。

### 9.3 监管韧性

- **`COMPLETION_CLAIM_PATTERN` 词表有限**（P2）：LLM 非常规措辞可能绕过回执反查；根治 = bridge 直读 MCP 结构化工具结果（更大改造）。
- **blocked 审计写失败仅 warn**（QA 遗留 Low）：建议升级为 error 级 + 计数指标，避免告警被吞。
- **workflow 场景 `goalText` 常缺席**（P3）：input schema 无 goal 字段，`deriveUnderlying` 尽力而为。

### 9.4 扩展性

- **更多 VM Agent 适配**：本轮已实现 `hermes-agent`；后续可加 `adapter-agent-langgraph` 等，共用同一桥接 SPI。
- **更多宿主适配**：`host-sdk` 已中性化，可加 `adapter-host-claude`/`adapter-host-cursor`（实现 `RenderPlan` 渲染为对应原生格式）。
- **能力广度**：五大模块当前为代表性能力集（每域 5–8 个工具），注册表驱动，按需扩充只需改 `definitions.ts` + 对应 `.ps1`。
- **多 VM 联邦编排**（V1 未做）：当前单 VM。

### 9.5 真机终验遗留（Backlog）

> 历史上登记的「真机未验证 6 项」（codebuddy CLI 契约 / hermes 真机 CLI / SSH 隧道闭环 / 双连接器宿主侧生效 / A2A 委派 + 共享 Skills / 真实 GUI 点击回归）已于 **R18（2026-09-30）/ R19（2026-09-30 ~ 10-02）/ A2A 覆盖补齐（2026-10-03）/ CL-K3R T05（2026-10-05~06）** 多轮真机验证中基本闭环；当前仅剩「真实 GUI 自动化点击回归」受远端锁屏环境限制为 P2 待补，详见 `.dev/changing-log.md`「待在真实环境终验」。

- 当前开放 Backlog（P2 级）：真实 GUI 自动化点击端到端回归（远端锁屏 / 非 WinSta0 环境限制，属预期环境约束，非部署故障）。

---

## 10. 文档导航与参考

| 文档 | 内容 |
|------|------|
| [`.dev/README.md`](.dev/README.md) | DDD 六大索引入口（本项目开发治理说明） |
| `docs/02-design/REQUIREMENTS.md` | 需求规格（FR/NFR 全表） |
| `docs/02-design/ARCHITECTURE.md` | 总体架构设计（含 ADR 全文） |
| `docs/02-design/CAPABILITY-MODEL.md` | 能力模型与风险分级 |
| `docs/02-design/SECURITY-GOVERNANCE.md` | 安全治理（策略/审批/审计） |
| `docs/02-design/LLM-PROVIDER.md` | LLM provider（workbuddy / hermes）设计 |
| `docs/02-design/HOST-A2A-BRIDGE.md` | 宿主 A2A 委派桥设计 |
| `docs/test/reports/real-test-2026-09-29-k5-e2e.md` | K5 真机端到端验收报告（审批闭环铁证） |
| `docs/test/reports/k5-fix-qa-2026-09-29.md` | K5 独立安全深审报告（路由 NoOne） |
| `.dev/changed-log.md` | 历轮交付变更记录（K3→K6 全程） |
| `.dev/changing-log.md` | 进行中 / 待定 / 后续建议 |

> 开发过程遵循 **DDD（文档驱动开发）** 规范：六大索引（`.dev/` 下）随交付同步维护，变更按轮次原子化提交。
