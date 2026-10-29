# WinVM Bridge（winvm-bridge）

> 一套**分层解耦、标准协议驱动、强监管**的宿主 AI Agent 插件体系，使宿主机 AI Agent（V1 = WorkBuddy）能够安全、可控、可审计地**完全操作一台 Windows 虚拟机**——覆盖系统管理、应用管理、存储管理、GUI 自动化与图形化生产操作。

- **版本**：`0.1.0`（插件内部版本，对应宿主缓存路径 `winvm-bridge/0.1.0`；**发布版本以 GitHub Release 最新 tag 为准（当前 `V1.4.3`，2026-10-26）**，演进链见 `docs/RELEASE-NOTES.md`）
- **形态**：npm workspaces 单仓，12 个可独立编译/发布的包 + 8 个 WorkBuddy Skill（1 总控 + 5 领域 + 1 MCP 参考 + 1 宿主分派）+ 双端一键部署器
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
| **系统管理** `system` | 服务 / 进程 / 计划任务（查询）/ 注册表 / 网络配置（查询）/ 用户与组（查询）/ 环境变量（读取）/ 系统信息 / 电源 / 事件日志（Windows 更新管理为 V2 规划·当前不可用） |
| **应用管理** `app` | 已装清单、winget 安装/卸载/升级、启动应用、快捷方式（读取）、UWP 包（查询）；窗口激活经 `gui.window.control`；默认程序关联为 V2 规划·当前不可用 |
| **存储管理** `storage` | 磁盘/分区/卷、空间分析、文件读写与搜索、压缩（创建 zip）、符号链接、回收站（查看）、清理建议（解压与回收站清空当前不可用） |
| **GUI 自动化** `gui` | 截图（全屏/窗口/区域）、键鼠模拟、窗口枚举与状态控制、UIA 元素树与点击、剪贴板（只读）、等待条件；网页操作经 UIA+键鼠（CDP 浏览器直驱为 V2 规划·当前不可用） |
| **应用生产操作** `appops` | 用 Photoshop/Office/ffmpeg/IDE 等软件**把活干出来**（应用状态/CLI 调度/工作流/COM 自动化/GUI 生产） |

### 2.3 八 Skill（1 总控 + 5 领域 + 1 MCP 参考 + 1 宿主分派）

| Skill | 职责 |
|-------|------|
| `winvm-orchestrator`（总控） | 意图识别 → 领域路由 → 通道选择（MCP 直调 vs A2A 委派）→ 风险分级 → 审批闸 → 结果汇总 |
| `winvm-system-admin` | 系统管理领域知识、PowerShell 惯用法、常见陷阱 |
| `winvm-app-manager` | 应用管理（winget/Store/卸载残留清理等） |
| `winvm-storage-manager` | 存储管理（空间分析、安全清理边界、不可逆操作清单） |
| `winvm-gui-automation` | GUI 自动化（会话保活、坐标 vs UIA、截图判读、等待策略） |
| `winvm-app-operation` | 应用生产操作领域知识（"用哪个软件、按什么生产逻辑出成品"） |
| `winvm-mcp-reference`（MCP 参考） | WinVM MCP 服务部署与接入参考（端点 / 鉴权 / VM Agent 选型接入 / 注册验证 / 常见故障） |
| `hos-win-skill`（宿主分派） | 鸿蒙 WorkBuddy 侧任务分派预判（哪些步骤留鸿蒙本地、哪些经 winvm 通道送 VM）与通道速判；进入 VM 后以 `winvm-orchestrator` 为唯一总控 |

### 2.4 强监管内核（NFR 落点）

- **风险分级** `L0/L1/L2/L3`：每个能力标注风险等级。
- **策略引擎**：路径白名单、命令黑名单（正则）、进程白名单/黑名单、注册表根键白名单；**命令面只有黑名单**（`commandAllowlist` 已从契约/配置/schema 三处删除，ARCH-18）；**默认拒绝优先**。
- **审批闸**：L2/L3 操作默认需人工确认（A2A `input-required` / MCP 侧前置确认）；支持按能力免审。
- **防篡改审计**：结构化 append-only 日志，**哈希链**（每条含前一条 hash），篡改任意一条 → **本轮运行期内**校验立即失败；跨轮历史的证据是启动 `verifyArchive()` 落的 `chain-archive-verify` 条目，**不是** `chainValid`（限定语见 `SECURITY-GOVERNANCE.md` §4.3.1）。
- **可观测**：全链路 `traceId` 贯穿 宿主→传输→VM 服务→能力执行；~~关键操作附 before/after 快照 artifact~~（**订正**：快照为**信息性声明、运行期不产**——用户裁决 Q2 2026-10-10 降级，`audit.snapshot` 声明只参与交付面形状校验；事后证据 = 哈希链 + `artifacts` 哈希，权威口径 `SECURITY-GOVERNANCE.md` §3.2，判据 `tests/unit/phase2-snapshot-truth.test.js`）。
- **网络安全**：VM 侧服务**仅监听 `127.0.0.1`**，且该约束**不可关**（非回环绑定 ⇒ 启动 `error`，`security.requireLoopbackBind=false` 不再能放宽）；SSH 隧道本地端口转发；Streamable HTTP 模式 TLS + **可选** bearer（`security.enforceBearer` 默认 `false`，宿主侧由 `--token-env` 给出环境变量名）；~~Origin 校验~~（**规划项·未实现**，源码零命中，2026-10-13 批0 诚实化，见 `SECURITY-GOVERNANCE.md` §2 第 1 层）；VM 对外零端口暴露。信任边界 = 回环 + SSH 隧道 + 审批闸（§2.1）。

### 2.5 可替换的 Agent / 宿主

- **VM 内 Agent 三选项**（经 `agent.provider` 一行切换，框架零改动）：
  - `workbuddy-deterministic`（确定性执行器，**默认**，先把链路与安全内核跑通）
  - `workbuddy`（VM 内 `codebuddy` CLI 的 LLM 执行器，V1 已实现）
  - `hermes-agent`（Nous Research 的 Hermes Agent，经 `config.yaml.mcp_servers` 预注册 MCP）
- **宿主侧适配器**：V1 = WorkBuddy；`host-sdk` 已中性化，可另加 `adapter-host-claude`/`adapter-host-cursor` 等。

---

## 3. 技术方案

### 3.1 架构总览（三层解耦 + 双通道 + 八 Skill）

```
┌─────────────────────────────── 宿主机（Host） ───────────────────────────────┐
│  ┌──────────────────────── 宿主机 Agent（V1 = WorkBuddy） ─────────────────┐ │
│  │   ┌─────────────── 知识层：8 Skills（1+5+1 MCP 参考+1 宿主分派） ──────────────┐      │ │
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
│      ↑ 会话健康探针（在位）；session-guard 保活恢复＝规划项·未实现          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 分层包结构（12 包，依赖单向）

> **分层口径（2026-10-13 批0 统一，J-1 三源矛盾收敛）**：下表"层"列与 `packages/*/package.json` 的 `layer` 字段**逐包对齐**——该字段是机检（`scripts/dep-lint.mjs`，rank 序 `L0 < L1a < L1b < L1c < L2 < L3`）的**唯一事实源**；`ARCHITECTURE.md` §2.2 同步此口径。任何散文与本字段分歧时，以字段为准并回改散文（这是 P2-T11 dep-lint 批承诺"口径注记显形"的兑现位）。

| 层（`layer` 字段） | 包 | 职责 |
|----|----|------|
| **L0** `L0-contracts` | `contracts` | 全系统唯一契约源：风险/能力/传输/审计/桥接/宿主/A2A 的 TS 类型 + JSON Schema |
| **L1a** `L1a-core` | `core` | transport（HTTP/SSH/stdio 抽象）、registry、policy（策略引擎）、audit（哈希链）、session（探针）、bridge（加载器）、config |
| **L1b** `L1b-mcp-framework` | `mcp-framework` | MCP server/client（Streamable HTTP + stdio） |
| **L1b** `L1b-a2a-framework` | `a2a-framework` | A2A v1.0 server/client（AgentCard/message/send/stream/tasks/*/artifacts/input-required） |
| **L1c** `L1c-host-sdk` | `host-sdk` | 中性插件模型 SDK（patch/skill-loader/渲染抽象） |
| **L2** `L2-adapter-host` | `adapter-host-workbuddy` | 把中性模型渲染为 WorkBuddy 原生 plugin.json / marketplace.json / connector mcp.json（MCP 直调 + A2A 委派桥两个连接器） |
| **L3** `L3-host-bridge` | `host-a2a-bridge` | stdio MCP server，暴露 `a2a.delegate` / `task.get` / `approval.reply` / `task.cancel` / `health`，内部用 A2A client 调 VM `/a2a`（补齐宿主→VM 的 A2A 一跳。**注意：机检层=L3**，宿主侧桥不进入 VM 分层主体） |
| **L2** `L2-vm-capabilities` | `vm-capabilities` | ps-bridge 常驻进程 + system/app/storage/gui/appops 五大 PowerShell 模块 + 能力注册表 + 空闲自愈 |
| **L2** `L2-adapter-agent` | `adapter-agent-workbuddy` | VM 内确定性执行器（`workbuddy-deterministic`，可替换） |
| **L2** `L2-adapter-agent-llm` | `adapter-agent-workbuddy-llm` | VM 内 LLM 执行器（`workbuddy` 选型，V1 实现），复用确定性执行器、仅 `runGoal` 为 LLM 驱动 |
| **L2** `L2-adapter-agent-llm` | `adapter-agent-hermes` | Hermes Agent 执行器（`hermes-agent` 选型），MCP 经 `config.yaml` 预注册 |
| **L2** `L2-vm-service` | `vm-service` | 同端口双协议服务端 + CLI 入口（`agent.provider` 总开关） |

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
├── skills/                   # 8 个 WorkBuddy Skill（1 总控 + 5 领域 + 1 MCP 参考 + 1 宿主分派）+ 各 Skill 内 mcps-reference
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

### 5.4 用 `.prompt` 一键安装 / 卸载（推荐：整段粘贴给 WorkBuddy）

发布包（V1.4.6 起）与仓库均自带两份**纯 Prompt 脚本**——把「总 Prompt + 运行期环境变量」抽成可整段复制的独立文件，粘给 WorkBuddy（鸿蒙宿主）新会话即可自动执行，每一步自带判据、任一判据不过立即停下报告（现象/根因/证据/建议），不会跳步硬推：

| 脚本 | 用途 | 结构 |
|---|---|---|
| `docs/deploy/deploy.prompt` | **从零部署**（密码建免密 → 取包三重校验 → VM-service → 宿主插件+隧道 → 全维度测试 → 交付引导） | 运行期注入变量段 + Step 1→6 判据 + 排错速查 |
| `docs/deploy/undeploy.prompt` | **镜像拆除**（只删安装体系自己放的东西；OS 级与 SSH 密钥默认不动；删除物入 trash 可回滚） | 运行期注入变量段 + U0→U5 判据（DRY-RUN 先行 / POST-CLEANUP 全 PASS + 独立复核防假 PASS / 存留项逐项问用户）+ 排错速查 |

**安装步骤**：

1. 取发布包 `winvm-overall-<TAG>.zip`（GitHub Release）解压，解出目录即**包根**（含 `MANIFEST.txt` 与 `delivery/`）；已在本仓库内则包根=仓库构建态亦可。
2. 打开 `docs/deploy/deploy.prompt`，按其开头【运行期注入】段配置环境变量（执行前 `export`，或改脚本内默认值）：
   - `VM_HOST` / `VM_USER` / `VM_SSH_PORT`：Windows VM 的 SSH 可达信息；
   - `WINVM_SSH_PASSWORD`：**仅**从零建免密通道（Step 1）时需要——只走环境变量，禁止写入文件/提交/日志回显；免密已建好则整段跳过 Step 1；
   - `DEPLOY_ROOT` / `PKG_ROOT`：部署工作目录与包根（`ls $PKG_ROOT/MANIFEST.txt` 判定布局，不对就按注释换值）；
   - `NODE` / `PY`：宿主运行时**绝对路径**（鸿蒙沙箱场景必须绝对路径）；
   - `RELEASE_TAG` / `ZIP` / `REPO`：下载面参数（包已在本地可跳下载校验段）；
   - `WINVM_DRY_RUN=0`：⚠ 必须为 0——`=1` 会把 `--apply` 降级为 dry-run（假成功）。
3. **整段复制全文**粘贴给 WorkBuddy 新会话发送；等它按 Step 1→5 跑完并给出三探针结果（mcp 20/20 + a2a 5/5 + example 13/13）与健康/连接/FRESH/disabledTools=8 判据。

**卸载步骤**：

1. 同样打开 `docs/deploy/undeploy.prompt` 配置运行期变量（不需要密码，除非免密已失效）。
2. 整段粘贴给 WorkBuddy；它会先跑 U1 **DRY-RUN** 列拆除清单（这一步是安全阀：清单里出现不该删的落点会立即停），核对无误才 `--apply`。
3. 完成后看 POST-CLEANUP 核验清单全 `[PASS]`（条目随运行态动态 16~19 项）+ 独立复核（18443 拒连、全局 `~/.workbuddy/mcp.json` 无 winvm 键、VM 目录/计划任务 absent、sshd 存活）。
4. 存留项（SSH 密钥、`C:/WinVMWorkspace`、trash、下载物）按脚本 U5 **逐项征询后处置**——想彻底清或准备 `--wipe` 清场重装，看脚本 §8 衔接说明（拆除阶段保留密钥与下载物，重装从 Step 2 起即可）。

> 两份脚本的"母本"是 `docs/deploy/deploy-prompts.md` / `undeploy-prompts.md` 总集的 §3（含分步 Prompt 与更多论证细节）；脚本已于 2026-10-29 真机回环验证（拆除 19/19 + 重装 38/38，见 `qa/real-test-2026-10-29-run1.md`），V1.4.6 起随发布包分发。
>
> **校验值权威源口径**：文档不硬编码逐版本 zip sha / MANIFEST 三元组（`MANIFEST-sidecar-authoritative`）——下载后以 release 旁挂 `.zip.sha256` 做 `sha256sum -c`，解包后以包内 `MANIFEST.txt` 头七行为准跑 `verify-manifest.py`；`RELEASE_TAG` 以 releases/latest API 现解为准。V1.4.7 起打包面 V8 断言机械化钉死此口径。

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

1. 插件与 8 个 Skill 安装后，宿主连接器写 `mcp.json` 暴露两个连接器：`connector:winvm`（MCP 直调）与 `connector:winvm-a2a`（A2A 委派桥）。
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
# 触发进程访问违例、连带判死所有文件。务必逐文件（`.js` 与 `.mjs` 两类都要覆盖）：
for f in tests/unit/*.test.js tests/unit/*.test.mjs; do node --test "$f"; done

# 本地门禁（Phase 2 起为一等公民，推荐用它代替上面手工循环 ——
# gate 内部即为「每文件独立子进程」spawn，代码层面杜绝整批 glob）：
npm run gate:quick            # 快档：tsc -b → dep-lint → config-key-lint → 契约/schema 守卫件
npm run gate                  # 全量档：快档四段 + 全仓逐文件 sweep（汇总行口径同 qa sweep-result）
npm run layout                # 只跑分层方向守卫（scripts/dep-lint.mjs，读各包 dist 编译产物）
npm run lock-probe            # 锁屏前置探针（只读 GET /health → GUI 能力可用性前置判定）
```

> **门禁纪律（P2-T11）**：任何批次的交付**必须**先跑 `npm run gate`（或至少 `gate:quick`）并 GREEN
> 方可进入验收——**跳过门禁即视为未验收**。哪些判据进门禁、哪些明确不进（及不进的覆盖去处），
> 权威清单见 `scripts/GATE-POLICY.md`。

**测试基线的权威口径**：本文件**不静态维护**测试文件数/例数——任何"当前基线 = N 文件 / M 例"的
叙述都会随批次漂移并造成文档与实跑不一致。唯一权威源是 `qa/` 下**最新一轮** `*-sweep-result.txt`
的汇总行（`FILES=` / `TOTAL_TESTS=` / `TOTAL_FAIL=` / `TOTAL_SKIP=`，逐文件 TAP 计数可复核）。
查当前基线：`ls -1 qa/*/sweep-result.txt qa/*/*-sweep-result.txt qa/p3-batch-sweep/gate-*.txt | sort -V | tail -1` 后读其汇总行。
> **查法订正（2026-10-13 批0，J-7/Q3 基线倒挂实验）**：旧句式 `sort | tail -1` 按**字典序**排，
> `t9` 排在 `t11`/`t12` **之后**（`9 > 1` 逐字符比较）⇒ 返回过期件；`ls -1t`（mtime 序）同样不可靠，
> 因 mtime 会被 checkout 重置。`sort -V`（版本序）对 `t<数字>` 命名正确排序。取到最新文件后仍需**核对
> `FILES=` 与 `BASELINE:` 对账行**：个别轮次是子集复跑（文件集小于当时磁盘全集，如 r19 内 t12=89 系
> 批次窄口径），此时以最近一次**全枚举** sweep 为基线锚，并在提交叙事里显式说明。
最近一轮（P2-T11 守卫基建，2026-10-12）逐文件实跑的完整留档随该批证据归档，其 `BASELINE`
对账行锚定的上一权威基线为 `qa/r19/t9-sweep-result.txt` = **91 文件 / 1857 例**，本批唯一增项
`tests/unit/phase2-dep-direction.test.js`。历史上曾出现过 1054 / 1247 / 1457 等多版数字，
一律以最新 sweep 留档为准，旧文档叙述仅作演进记录、不作事实源。

> 覆盖范围（定性）：契约、策略、审计、双协议、审批链（K3/K4/P3/K5/A5/K-N1/K-N2/S-4/CL-K3R）、
> Phase 0 安全守卫（U-P0-1 路径穿越 / U-P0-3 dry-run A1 / psmod 契约 / S-4·A5 装配点）、
> Phase 1 安全兑现批（T1–T5：链范围透出 / 审批三态入链 / `/health.audit.scope` / 非回环
> fail-closed / **真取消 ARCH-22** —— 执行体消费取消 + LLM 双路打断 + 宿主事实化呈现 +
> `--token-env` 通路），以及 Phase 2 守卫基建批（P2-T11：分层方向 dep-lint / 配置全键白名单
> config-key-lint / 门禁聚合 gate / 锁屏前置探针 lock-probe）。skip 恒为 `ssh2-resolve`
> 离线用例（OFFLINE_SKIP，见 sweep 留档 `SKIP_ATTRIBUTION` 行）。

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
- **能力广度**：五大模块当前为代表性能力集（注册表共 **54 个能力**，各域 meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5，以 `definitions.ts` 为准），注册表驱动，按需扩充只需改 `definitions.ts` + 对应 `.ps1`。
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
| `docs/06-OVERVIEW.md` | 交付概览（能力面/测试基线权威指针） |
| `docs/INSTALL-GUIDE.md` | 安装指南（开发者本机/仓库通道 `setup.mjs` 一条龙；从零/灾备见下行策略文档） |
| `docs/deploy/deploy-strategy.md` | **部署策略 v2（从零安装，权威）**：六步可行性+变量表+Step 3.0 运行时前置+§2.1-B 空密码预案+§5.0 遇困决策协议+Step 6 交付引导+缺口台账（§9.1）与实测记录 |
| `docs/deploy/deploy-prompts.md` | **部署 Prompt 总集**：变量确认表+总 Prompt（一键粘贴）+分步 P1~P6+验收速查+§8 异常处置协议 |
| `docs/deploy/undeploy-prompts.md` | **卸载 Prompt 总集（deploy-prompts 逆向镜像，现 v1.4；回环实测→I-6.3 修复已入 V1.4.5 包）**：十八落点镜像清单+总 Prompt U0~U5（DRY-RUN 先行/POST-CLEANUP 核验/存留项逐项问用户）+`--wipe` 清场重装衔接 |
| `docs/deploy/deploy.prompt` / `undeploy.prompt` | **纯 Prompt 一键粘贴脚本**（总集 §3 的独立脚本版+运行期注入变量；10-29 真机回环双向验证：拆 19/19+装 38/38；**V1.4.6 起随发布包分发**，配置与用法见本文 §5.4） |
| `docs/04-ops/OPS-OVERVIEW.md` | 运维权威手册：部署/运行机制综述+配置逐键穷举+坑速查 |
| `docs/RELEASE-NOTES.md` | **Release Notes（演进链/能力面/已知限制，权威）**；旧 `V1.0.0-release-notes.md` 已冻结并移至 `docs/archive/legacy-release-notes-V1.0.0.md` |
| `docs/05-peripherals/DEPLOYMENT.md` | 部署指南（含 §1.7 分发跟批闭环、策略闸执法切换） |
| `qa/real-test-2026-10-26-run1.md` | 部署策略 v2 首跑全维验收报告（25/25 PASS + Step 3.0 三例） |
| `qa/INDEX.md` | QA 区导航（探针/证据/基线权威 gate 件落点） |
| `docs/archive/audit/2026-10-12-full-audit.md` | Phase 3 终版台账（P0×4 收敛全程） |
| `docs/archive/audit/2026-10-14-full-audit.md` | Phase 4 终版台账（P1×3+P2×6 销账全程） |
| `docs/archive/audit/2026-10-15-panorama-phase5.md` | Phase 5 全景综述与完善路径 |
| `docs/archive/test/reports/real-test-2026-09-29-k5-e2e.md` | K5 真机端到端验收报告（审批闭环铁证） |
| `docs/archive/test/reports/k5-fix-qa-2026-09-29.md` | K5 独立安全深审报告（路由 NoOne） |
| `.dev/changed-log.md` | 历轮交付变更记录（K3→K6 全程） |
| `.dev/changing-log.md` | 进行中 / 待定 / 后续建议 |

> 开发过程遵循 **DDD（文档驱动开发）** 规范：六大索引（`.dev/` 下）随交付同步维护，变更按轮次原子化提交。
