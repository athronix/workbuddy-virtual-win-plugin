# WorkBuddy 宿主版对比：鸿蒙（HMOS） vs Windows（VM 侧）

> **文档代号**：`ref:hmos-vs-windows` ｜ **作者**：架构师 高见远 ｜ **读者**：工程师、PM、真机验证者
> **目的**：系统对比「真机鸿蒙（OH）宿主版 WorkBuddy」与「Windows VM 侧 WorkBuddy（本插件操作对象）」在架构、目录、连接器、插件、沙箱、shell 等维度的差异，并**直接落到本项目（WinVM Bridge）宿主侧适配**需要知道的行为差异。
> **配套文档**：`docs/01-investigation/oh-host-selfcheck.md`（可行性门禁）、`docs/01-investigation/oh-tunnel-design.md`（ssh2 隧道设计）、`docs/01-investigation/oh-adaptation-plan.md`（适配需求+变更方案）。

---

## 0. 范围与前提（诚实声明）

| 项 | 值 / 说明 |
|---|---|
| VM（Windows）地址 | `172.16.100.2`（任务给定，VM 侧基本不动） |
| 本机（OH）探查 | 已在真机鸿蒙宿主上完成（见 `oh-host-selfcheck.md` 与本文件 §3–§7 的「已确认」标注） |
| VM（Windows）网络可达性 | **已实测**：主理人已通过 **SSH 直连 `172.16.100.2`**（密钥登录，用户 `User`）实测。VM 系统 OpenSSH = `OpenSSH_for_Windows_9.5p2`、`sshd` Running/Automatic；VM 侧 WorkBuddy v5.5.3、目录树、mcp.json、node/codebuddy 探测结论见 §2.5 与附录 B（已回填）。本沙箱对 VM 的网络隔离不影响真实部署环境。 |
| Windows 侧事实来源 | ① **主理人 SSH 进 172.16.100.2 的真实实测**（mcp.json / 目录树 / OpenSSH 版本 / node·codebuddy 探测）；② 本仓库 Windows 侧代码（`delivery/*.mjs`、`packages/*/src`、`psmod/*.ps1` 描述 VM 内 ps-bridge / 54 能力 + 宿主逻辑）；③ 仓库交接文档 `.workbuddy/handover/*.md`；④ 对 Windows 版 WorkBuddy 的已知架构（Electron 桌面 app、`C:\Program Files\WorkBuddy`、用户数据根在 `~/.workbuddy`）。 |
| Windows 侧待回填 | **已关闭**：附录 B 清单 B1–B10 已由 SSH 实测回填（含 OpenSSH 9.5、accountId `8dd0df6a-…`、node 不在 PATH、codebuddy 未装、无 winvm 部署），见附录 B「已确认」标注。原 §3/§4 的「预期形态/需回填」声明一并关闭，全部改为「已确认（实测）」。 |

> ⚠️ 历史声明「（需回填）」**已作废**：VM 已由主理人 SSH 实测，相关条目已在 §2.5 / §3 / §4 / 附录 B 以「**已确认**」标注回填真实值。本文件不再含「需回填」占位（附录 A 探查脚本保留，仅供后续其它 VM 复测参考）。

---

## 1. 功能定位对比

| 维度 | 鸿蒙（HMOS）宿主版 WorkBuddy | Windows VM 版 WorkBuddy |
|---|---|---|
| 角色 | **宿主（Host）**：AI Agent 桌面应用，运行在用户真机；通过本插件操作一台 Windows VM | **被操作对象（VM）**：运行 Windows 的虚拟机，内置 WorkBuddy + winvm 服务，对外仅经 SSH 隧道暴露 `127.0.0.1:18443` |
| 共同本质 | 都是 **WorkBuddy 桌面 AI Agent**（Electron 桌面应用），能力模型一致 | 同左；额外承载 **winvm 服务**（54 能力：system/app/storage/gui/appops 五域） |
| 本插件关系 | 宿主侧改造主体：**隧道（ssh2）/ 连接器注册 / 启动器 / 沙箱白名单** | **VM 侧不变**（由 `install-vm.mjs` 部署 ps-bridge + winvm 服务；本适配**不碰 VM 侧代码**） |
| 跨平台结论 | 两者同为 Electron+Node 同宗；差异在 **OS 层**（沙箱 / 路径 / shell / 系统 `ssh` 有无），不在 WorkBuddy 应用层 |

---

## 2. 主体技术架构对比

| 维度 | HMOS 宿主版 | Windows VM 版 |
|---|---|---|
| 应用形态 | **Electron 应用**（移植到 OH 的桌面 Electron 版，**非**原生 ArkUI）。安装目录 `/storage/Users/currentUser/appdata/el2/base/com.tencent.workbuddy/`，含 `files/ haps/ preferences/ cache/ temp/ .backup`；`haps/electron/files` + `haps/electron/cache`（Chromium PreloadCache、字体缓存） | **Electron 桌面 app**（原生 Windows）。`C:\Program Files\WorkBuddy`，用户数据在 `%APPDATA%\WorkBuddy` 与 `%LOCALAPPDATA%\WorkBuddy` |
| 运行时 | Electron 内嵌 Chromium + **Node 运行时**：宿主 `which node` → `/data/storage/el1/bundle/libs/arm64/node/bin/node` **v24.13.0**（系统级存在，arm64） | Electron 内嵌 Chromium + Node；另有**系统 `node`**（用户可装）与**系统 `ssh`（OpenSSH，通常 ≥7.6）** |
| 进程模型 | 单 Electron 主进程 + 渲染进程；插件经 marketplace 安装，子进程（A2A 桥 stdio MCP server）由 WorkBuddy 以 `process.execPath`（其自带 node）拉起 | 同左；A2A 桥以 `process.execPath` 拉起；**隧道用系统 `ssh` 子进程**（`spawn('ssh',['-N','-L',…])`） |
| 渲染 | Chromium（与 Windows 同内核） | Chromium |
| 网络模型 | 受 **OH 应用沙箱**约束（详见 §6）；回环 `127.0.0.1` 用于隧道入口 | 系统网络栈；回环 `127.0.0.1` 用于 winvm 服务监听（`requireLoopbackBind=true`，绝不公网暴露） |
| 额外桥接 | **无系统 `ssh`**（OH 大概率缺 OpenSSH 或仅精简实现）→ 隧道须**进程内 `ssh2` 纯 JS 方案**（已落地 `delivery/oh-tunnel.mjs`） | **有系统 `ssh`** → 隧道用 `spawn('ssh')`（OpenSSH `accept-new` 等语法可用） |
| PowerShell 桥 | **无**（OH 无 PowerShell / cmd） | **有**：VM 内 `ps-bridge`（PowerShell 模块）承载 54 能力中的 system/gui/appops 等需 PowerShell 的环节 |

**架构师结论**：HMOS 版与 Windows 桌面版**同宗（Electron）**，故宿主机侧（目录结构、插件机制、连接器模型、Node/ESM 运行）适配比「从零移植到 OH 原生」容易得多；**真正差异在 OS 层**——OH 的沙箱 / 类 Linux 路径 / 无 PowerShell / 无系统 `ssh` / 回环绑定约束。本插件宿主侧适配的 90% 工作量都在这几处 OS 层差异。

---

## 2.5 实测：VM（172.16.100.2）当前实际状态（裸 WorkBuddy，未部署本项目）

> **结论先行**：这台 VM 是**一台「裸」的 WorkBuddy v5.5.3（Windows 11 10.0.26200，Electron）**，与本宿主 HMOS 的 WorkBuddy **同宗同架构**，但它上面**完全没有部署本项目（WinVM Bridge）的 VM 侧**。也就是说，当前从 HMOS 宿主切过去也**连不上**——必须先在该 VM 上执行 **V1.0 的 VM 侧部署（`install-vm.mjs`）**，把 ps-bridge + 54 能力 + winvm-plugin + `/mcp` `/a2a` 服务落下去，宿主切换才有意义。

### 2.5.1 已实测事实（主理人 SSH 进 VM 实测）

| # | 事实 | VM 实测值 | 含义 / 对适配的影响 |
|---|---|---|---|
| S1 | **WorkBuddy 版本 / 形态** | Windows 11 `10.0.26200` + WorkBuddy **v5.5.3**，Electron 桌面 app（安装 `C:\Program Files\WorkBuddy`，含 `WorkBuddy.exe` 204MB / `resources/` / `locales/` / `Assets/` / `chrome_*.pak` / `ffmpeg.dll` / `libEGL.dll` / `vulkan-1.dll` / `version`） | 与 HMOS 宿主 Electron **同宗**，连接器模型 / 插件机制 / node·ESM 运行一致 → 适配工作量集中在 OS 层 |
| S2 | **本项目的 VM 侧部署** | **完全未部署**：连接器列表 100+（linear/canva/tdx/tapd/tencent-docs/weisheng-scrm/mastergo-vibe-mcp/zw3d-mcp/dcs-cloud/jufa-mcp-server/ioa …）但**没有任何 `winvm*` 连接器**；无 ps-bridge 进程/服务、无 `C:\Users\User\winvm` 或 `C:\winvm` 部署目录、无相关计划任务 | 🔴 **前置门禁**：宿主切换前必须先跑 `install-vm.mjs`（见 `oh-adaptation-plan.md` **P0-R0**） |
| S3 | **VM 连接器账户** | `mcp.json` 实址 `C:\Users\User\.workbuddy\connectors\8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8\mcp.json`，**accountId 与 HMOS 宿主完全一致**（企业 uuid） | HMOS 侧注册两连接器时应**写入同一 uuid 目录**（见 `oh-adaptation-plan.md` P0-R3 / T06），不做跨账户错配 |
| S4 | **VM 系统 OpenSSH（隧道服务端）** | `OpenSSH_for_Windows_9.5p2`（≥7.6），`sshd` 服务 **Running / Automatic** | 隧道 VM 端（ssh server）无虞；上轮实现的进程内 `ssh2` 客户端（连 VM `:22`）算法兼容（ssh2 支持 OpenSSH 9.5 的 kex/cipher）→ **P0-R2 隧道 VM 端已验证可达** |
| S5 | **VM 系统 `node`** | **不在 PATH**（`node -v` / `where node` 均失败）；`C:\Program Files\WorkBuddy` 内**未找到 node.exe**（Electron 把 node 编进二进制） | VM 侧 ps-bridge 运行需 node → `install-vm` 须**为 VM 安装 node**（或定位 WorkBuddy 内置运行时）。属 VM 侧落地前置（见 `oh-adaptation-plan.md` **P1-R10**），**不是**宿主切换的改动 |
| S6 | **VM `codebuddy` CLI** | **未安装**（`codebuddy --version` / `where codebuddy` 失败） | V1.0 的 `workbuddy` LLM provider（A2，VM 内 spawn `codebuddy` CLI）需先在 VM 装 codebuddy CLI → 属 VM 侧用户动作 + 本插件配置须正确指向其路径（见 `oh-adaptation-plan.md` **P1-R8**） |
| S7 | **VM 用户 PATH** | 极简：仅 `C:\Users\User\AppData\Local\Microsoft\WindowsApps;` | VM 侧 PATH 注入价值低，部署（ps-bridge / winvm-plugin）**用绝对路径**更稳 |

### 2.5.2 对「宿主切换」的判定

- ✅ **VM 可达 + 同宗**：网络（sshd 9.5 Running）、应用形态（Electron 同宗）、连接器模型（accountId 一致、stdio 原生）均确认无碍。
- 🔴 **但 VM 侧没部署本项目**：当前是「裸 WorkBuddy」，没有 ps-bridge / 54 能力 / winvm 服务 / `winvm*` 连接器。
- 🔴 **且 VM 缺 node + codebuddy**：ps-bridge 跑不起来、A2 的 `workbuddy` provider 无 CLI 可 spawn。
- **因此**：HMOS 宿主侧适配（T06–T10）**可以并行推进**，但**端到端跑通（A4/A5/A2）的前提是先把 VM 侧 `install-vm.mjs` 落好**（P0-R0 + P1-R10 + P1-R8），顺序见 `oh-adaptation-plan.md` §3.2 T10。

---

## 3. 安装与目录结构对比

### 3.1 两栏对照表

| 内容 | HMOS 宿主版（已确认） | Windows VM 版（已确认，SSH 实测 172.16.100.2） |
|---|---|---|
| 应用安装目录 | `/storage/Users/currentUser/appdata/el2/base/com.tencent.workbuddy/`（OH 应用沙箱 `el2/base`） | `C:\Program Files\WorkBuddy\` ✅ 实测存在（见 §2.5 真实目录树） |
| 应用数据根（`~`） | `/storage/Users/currentUser/`（即 `~/`） | `C:\Users\User\`（即 `~/`；**VM 用户名实测为 `User`**） |
| **连接器/插件数据根** | `~/.workbuddy/`（`/storage/Users/currentUser/.workbuddy/`） | `~/.workbuddy/`（`C:\Users\User\.workbuddy\`）— **模型一致，路径形态同**（实测） |
| 插件缓存 | `~/.workbuddy/plugins/cache/<marketplace>/<name>/<ver>` | 同（marketplace 安装模型一致，实测 `C:\Users\User\.workbuddy\plugins\` 结构同 HMOS：`cache/marketplaces/data/installed_plugins.json/known_marketplaces.json`） |
| 连接器目录 | `~/.workbuddy/connectors/<account>/mcp.json` | 同（实测 `C:\Users\User\.workbuddy\connectors\8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8\mcp.json`，`<account>` = 企业 uuid） |
| VM 连接配置 | `~/.workbuddy/winvm/vm-conn.json`（本插件写） | 仅宿主侧有；VM 侧无此文件（且 VM 侧 `~/.workbuddy\winvm\` 当前不存在，待 `install-vm.mjs` 创建） |
| known_hosts | `~/.workbuddy/winvm/known_hosts`（ssh2 TOFU 落盘） | 系统 `ssh` 用 `~/.ssh/known_hosts`（VM 侧 `sshd` 已 Running，详见 §2.5 / §4） |
| 用户 AppData 目录 | — | `C:\Users\User\AppData\Roaming\WorkBuddy\` **实测为空**（数据根在 `~/.workbuddy`，**非** `%APPDATA%\WorkBuddy`） |

### 3.2 目录树对比

**HMOS 宿主版（真实探查结果）**
```
/storage/Users/currentUser/appdata/el2/base/com.tencent.workbuddy/   # 应用本体（OH 沙箱）
├── files/
├── haps/electron/files            # Electron 运行时文件
├── haps/electron/cache            # Chromium PreloadCache、字体缓存
├── preferences/
├── cache/
├── temp/
└── .backup/

~/.workbuddy/                       # 用户数据根（与 Windows 同模型）
├── connectors/
│   ├── default/mcp.json           # 默认账户连接器（含 streamableHttp/stdio/sse 条目）
│   └── 8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8/   # 当前活跃「企业」账户（uuid）
│       ├── mcp.json
│       ├── connector-states.v3.json   # 含 accountIdentityKey: "<uuid>||enterprise"
│       ├── .master.key
│       └── README-DO-NOT-DELETE.txt
├── plugins/
│   ├── installed_plugins.json     # version 2, scope=user
│   ├── known_marketplaces.json
│   ├── cache/<marketplace>/<name>/<ver>/   # 已装插件（含 .codebuddy-plugin/, SKILL.md, .in_use）
│   └── marketplaces/<marketplace>/.codebuddy-plugin/marketplace.json
├── skills/  projects/  logs/  memory/  plans/  teams/  tasks/
├── sessions/  storage/  security/  binaries/  shell-snapshots/  file-history/
├── artifact-index/  audit-log/  changes-index/  local_storage/  app/  cache/
├── .workbuddy-sqlite-migrations/
├── settings.json                  # 含 sandbox.extraAllowWrite 写路径白名单
└── winvm/                         # 本插件运行时目录（vm-conn.json / known_hosts）
```

**Windows VM 版（真实探查结果，主理人 SSH 进 172.16.100.2 实测）**
```
C:\Program Files\WorkBuddy\                       # 应用本体（真实 Windows 11 10.0.26200，Electron，与 HMOS 同宗同架构）
├── WorkBuddy.exe                  # 204MB（Electron 主程序）
├── resources/                     # 含 app.asar / Electron 内嵌 node（node 编进二进制，无独立 node.exe）
├── locales/                       # 多语言资源
├── Assets/                        # 图标/资源
├── chrome_*.pak                   # Chromium 资源包
├── ffmpeg.dll  libEGL.dll  vulkan-1.dll   # 媒体/图形运行库
└── version                        # 版本文件（实测含 v5.5.3）

C:\Users\User\  (即 ~/，VM 用户名为 User)
├── AppData\Roaming\WorkBuddy\      # 实测为空（数据根不在 %APPDATA%，而在下面的 .workbuddy）
└── .workbuddy\                     # 用户数据根（与 HMOS 同模型，实测）
    ├── connectors\
    │   └── 8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8\   # 企业账户 uuid（与 HMOS 宿主完全一致）
    │       └── mcp.json            # 100+ 连接器（linear/canva/tdx/tapd/tencent-docs/weisheng-scrm/mastergo-vibe-mcp/zw3d-mcp/dcs-cloud/jufa-mcp-server/ioa …）；无任何 winvm*
    ├── plugins\                     # 结构同 HMOS（cache/marketplaces/data/installed_plugins.json/known_marketplaces.json）
    ├── settings.json
    └── (无 winvm/ 目录：VM 侧尚未部署本项目，待 install-vm.mjs 落地)

C:\  (VM 侧本项目部署点位：当前均不存在，待 install-vm.mjs 创建)
├── C:\Users\User\winvm\            # 不存在（ps-bridge + winvm-plugin + /mcp + /a2a 部署点，方案待定）
└── C:\winvm\                        # 不存在（备选部署点）
```

> 关键：连接器与插件数据根在**两侧都是 `~/.workbuddy/`**，模型完全一致；差异仅是 `~` 在 OH 是 `/storage/Users/currentUser/`，在 Windows 是 `C:\Users\User\`。**本插件宿主侧几乎不需要改连接器的「相对路径」逻辑**，只需适配 OS 层 `~` 展开、shell、沙箱白名单。
> 另：VM 的 `%APPDATA%\WorkBuddy`（`AppData\Roaming\WorkBuddy`）实测为空，真实数据根在 `~\ .workbuddy\`（与 HMOS 一致），**不要**按旧假设去读 `%APPDATA%\WorkBuddy`。

---

## 4. 连接器 / MCP 模型对比

| 维度 | HMOS 宿主版（已确认） | Windows VM 版（已确认，SSH 实测 172.16.100.2） |
|---|---|---|
| mcp.json 位置 | `~/.workbuddy/connectors/<account>/mcp.json`（也支持全局 `~/.workbuddy/mcp.json`） | 同（`C:\Users\User\.workbuddy\connectors\8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8\mcp.json`，实测） |
| 结构 | `{ "mcpServers": { "<name>": {transport 条目} } }` | 同（实测 100+ 条 `mcpServers` 条目） |
| 支持的 transport 类型 | `streamableHttp`、`streamable-http`（两种拼写都被接受）、`sse`、`stdio`、**省略 type（默认）** | 同（**实测出现 `streamableHttp` / `streamable-http` / `sse` / `http` / `stdio` 五种**，WorkBuddy 跨平台一致） |
| **stdio 是否支持** | ✅ **支持**（已确认：本机 `default/mcp.json` 与 uuid `mcp.json` 中均有 `"type":"stdio"` + `"command":"npx"/"uvx"` + `args` + `runtime:{type:"node"}` 条目，多处） | ✅ **支持（实测坐实）**：VM `mcp.json` 中 `connector:weisheng-scrm` / `mastergo-vibe-mcp` / `zw3d-mcp` / `dcs-cloud` / `jufa-mcp-server` 等均为标准 stdio 条目，且带 `runtime:{type:"node"}` → a2a 桥走 stdio 在**两侧均原生支持**（P1-R6 已确认） |
| 注册方式 | 增量合并写入（不整体覆盖）；装完需在 WorkBuddy 连接器页 **点 Trust** 激活 | 同（VM 侧注册形态一致） |
| 本插件两连接器 | `connector:winvm`（streamableHttp → `http://127.0.0.1:18443/mcp`）、`connector:winvm-a2a`（stdio → `node a2a-bridge/cli.js`） | **应直接镜像 VM 现有 stdio 条目 schema**（见 §4.1）：`connector:winvm` 走 `streamableHttp`、`connector:winvm-a2a` 走 `stdio`（`command:"node"` + `args:[<cli.js 绝对路径>]` + `runtime:{type:"node",version:">=18"}` + `env` 注入 VM 连接 + `disabled:false`） |

**OH 上观测到的 stdio 条目真实样例**（证明 stdio transport 受支持）：
```json
"connector:weisheng-scrm": {
  "type": "stdio",
  "timeout": 120000,
  "command": "npx",
  "args": ["--registry=https://registry.npmmirror.com", "-y", "mcp-server-weisheng-scrm@latest"],
  "runtime": { "type": "node", "version": ">=18" },
  "env": { "SCRM_APP_KEY": "" },
  "disabled": true
}
```
> 注：OH 的 stdio 条目普遍带 `runtime: {type:"node", version:">=…"}` 字段（提示 WorkBuddy 用哪个 node 拉起）。本插件 a2a 桥用 `command: process.execPath`（绝对 node 路径）+ `args:[cli.js,…]`，**无需 `runtime` 也能跑**；为与 OH 既有条目一致，建议渲染时附带 `runtime` 字段（见 `oh-adaptation-plan.md` T09）。

### 4.1 VM（Windows）侧 mcp.json 真实探查（SSH 实测，替代原「假设/待回填」）

> 本节用 **VM 真实 mcp.json** 替换原 §4 的「Windows 侧数据待回填」声明——该声明**现已关闭**，以下均为实测值。

**连接器规模**：`mcp.json` 内 `mcpServers` **100+** 条。实测样例（节选）：`connector:linear`、`connector:canva`、`connector:tdx`、`connector:tapd`、`connector:tencent-docs`、`connector:weisheng-scrm`、`connector:mastergo-vibe-mcp`、`connector:zw3d-mcp`、`connector:dcs-cloud`、`connector:jufa-mcp-server`、`connector:ioa` … **无任何 `winvm*` 条目**（印证 §2.5 S2：VM 侧未部署本项目）。

**transport 类型分布（实测出现）**：
- `streamableHttp` / `streamable-http`（两种拼写都被接受，混用）
- `sse`
- `http`
- `stdio`（含 `runtime:{type:"node"}`）

**stdio 真实样例（VM 侧，证明与 HMOS 同构）**：

`connector:weisheng-scrm`（与 HMOS 条目同形）：
```json
"connector:weisheng-scrm": {
  "type": "stdio",
  "timeout": 120000,
  "command": "npx",
  "args": ["--registry=https://registry.npmmirror.com", "-y", "mcp-server-weisheng-scrm@latest"],
  "runtime": { "type": "node", "version": ">=18" },
  "env": { "SCRM_APP_KEY": "" },
  "disabled": true
}
```

`connector:mastergo-vibe-mcp` / `connector:zw3d-mcp` / `connector:dcs-cloud` / `connector:jufa-mcp-server` 等同为 `type:"stdio"` + `command:"npx"` + `runtime:{type:"node"}` 形态（仅 `command`/`args`/`env` 不同）。

> **对本插件的直接约束（坐实 P1-R6）**：a2a 桥走 `stdio` → `node <cli.js>` 在 VM 与 HMOS **两侧均被原生支持**，无需 fallback 到 `streamableHttp`。故 `connector:winvm-a2a` 的渲染**直接镜像**上述现有 stdio 条目的 schema：
> ```json
> "connector:winvm-a2a": {
>   "type": "stdio",
>   "timeout": 600000,
>   "command": "node",
>   "args": ["<winvm-a2a-bridge.cli.js 绝对路径>"],
>   "runtime": { "type": "node", "version": ">=18" },
>   "env": { "WINVM_VM_HOST": "127.0.0.1", "WINVM_VM_PORT": "18443", "WINVM_VM_A2A_ENDPOINT": "http://127.0.0.1:18443/a2a" },
>   "disabled": false
> }
> ```
> （完整模板见 `oh-adaptation-plan.md` P0-R3。）

---

## 5. 插件机制对比

| 维度 | HMOS 宿主版（已确认） | Windows VM 版（已确认，SSH 实测 172.16.100.2） |
|---|---|---|
| 安装方式 | 经 **marketplace** 安装（`plugins/marketplaces/<marketplace>/.codebuddy-plugin/marketplace.json` 登记） | 同 |
| 已装清单 | `~/.workbuddy/plugins/installed_plugins.json`：`{version:2, plugins:{ "<name>@<marketplace>":[{scope:"user",installPath:"…/cache/<marketplace>/<name>/<ver>",version,…}] }}` | 同（模型一致） |
| 插件 manifest | `<pluginDir>/.codebuddy-plugin/plugin.json`：`{name,version,description,description_en,author:{name},repository,homepage,license,keywords}` | 同 |
| 插件目录内容 | `README.md` `SKILL.md` `references/` `scripts/` `templates/` `.in_use`（外加安装期 `.staging-<pid>-<ts>/` 暂存） | 同 |
| marketplace manifest | `marketplace.json`：`{name,description,owner:{name,email},plugins:[{name,description,version,source:"./plugins/…"}]}` | 同 |
| 本插件接入 | 经 `WorkBuddyRenderer` 渲染 → 落地 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` + 注册 `installed_plugins.json` + 注入 `connectors/<account>/mcp.json` | 同（渲染模型跨平台一致） |

> 结论：插件机制**两侧完全一致**，本插件适配**不需要改插件 manifest / marketplace 形态**，只需确保 OH 上 `install-host.mjs` 的渲染目标路径（`~/.workbuddy/...`）可写（受 §6 沙箱约束）。

---

## 6. 沙箱 / 安全模型对比

| 维度 | HMOS 宿主版（已确认） | Windows VM 版（已确认，SSH 实测 172.16.100.2） |
|---|---|---|
| 安全/沙箱机制 | **OH 应用沙箱** + `~/.workbuddy/settings.json` 的 `sandbox.extraAllowWrite`（写路径白名单）。当前白名单含 `~/.tencent-cloudq`、`~/.andonq`、`~/.lark-cli`、`/tmp/dws-cache`、`~/Library/Application Support/tmeet` 等十余条。**无 `~/.workbuddy/winvm` 等本插件路径**。 | Windows：**UAC / UIAccess / 文件 ACL**。无 `settings.json` 式写白名单；用户态进程默认可写自身用户目录（`C:\Users\User\` 等）。 |
| 对「写文件」约束 | 仅 `extraAllowWrite` 列出的路径（及默认用户目录内常规位置）可写；**白名单外路径写会被拒** | 默认可写用户目录；受 ACL/UAC 提权提示约束 |
| 对「起进程」约束 | **未从静态文件确认**是否限制 `spawn`/长驻子进程（待真机 §5 验证）。`oh-tunnel.mjs` 注册了 `process.on('exit'/'SIGINT'/'SIGTERM')`，若沙箱禁止进程级 signal/清理，需对策 | 系统无此约束 |
| 对「联网/出站」约束 | **未从静态文件确认**是否限制出站 TCP（待真机 §5 验证）。隧道需出站到 VM `:22`/`:18443` | 系统网络栈，默认放行（受 Windows 防火墙） |
| 凭据/known_hosts | 落 `~/.workbuddy/winvm/known_hosts`（须该路径在白名单内可写） | `ssh2` 不使用；系统 `ssh` 用 `~/.ssh/known_hosts` |
| 威胁库 | `~/.workbuddy/security/threat-database/`（存在，空目录） | 同（模型一致） |

> ⚠️ **沙箱是 HMOS 适配的头号风险**：`settings.json` 的 `sandbox.extraAllowWrite` 必须加入本插件写路径（`~/.workbuddy/winvm`、`~/.workbuddy/plugins/cache/winvm/...`）；且「沙箱是否限制进程 spawn / 长驻 / 出站 TCP」**无法从静态文件判定**，必须由用户在真机执行 `oh-host-selfcheck.md` §5 验证。若受限，属 **OS 层权限问题，非改插件代码可绕**。

---

## 7. Shell 与路径模型对比

| 维度 | HMOS 宿主版 | Windows VM 版 |
|---|---|---|
| Shell | 类 **Linux shell**（bash/sh；`which bash` 需确认，可能仅 `sh`） | **PowerShell** / **cmd** |
| `.cmd` 启动器 | ❌ 无 PATHEXT 解析，`.cmd` 不可用 | ✅ `winvm-plugin.cmd` 经 PATHEXT 解析 |
| 用户 PATH 注入 | 写 `~/.bashrc` / `~/.profile` / `~/.zshrc`（按 `process.platform` 分支） | PowerShell `[Environment]::SetEnvironmentVariable("Path","User")` + `WM_SETTINGCHANGE` 广播 |
| 回收站 | POSIX `mv` 到 `--trash-dir` 指定目录（无 COM） | `Shell.Application` COM 对象进回收站 |
| 回环地址 | `127.0.0.1`（隧道入口强制绑定，拒绝 `0.0.0.0`） | 同 |
| 路径分隔 | `/`（POSIX） | `\`（Windows）；Node `path` 已抽象 |
| 进程平台标识 | `process.platform === 'linux'`（OH 兼容内核；守卫用 `'ohos'` 仅用于隧道后端选择，见 `oh-tunnel-design.md`） | `process.platform === 'win32'` |

---

## 8. 本插件宿主侧行为差异（直接指导适配）

| # | 行为 | Windows/macOS（现状） | HMOS（适配目标） | 对应任务 |
|---|---|---|---|---|
| 8.1 | **隧道** | 系统 `ssh`：`spawn('ssh',['-N','-L',…])` | **进程内 `ssh2`**（`delivery/oh-tunnel.mjs` + `ssh-tunnel-ssh2.ts`；守卫 `process.platform==='ohos' \|\| WINVM_TUNNEL_BACKEND==='ssh2'`） | T01–T05（已落地草案） |
| 8.2 | **启动器** | `winvm-plugin.cmd` + `winvm-plugin`（POSIX） | **去掉 `.cmd`**，仅 `.mjs` + 无扩展名 bash 启动器（`#!/usr/bin/env bash`，`+x`） | T08 |
| 8.3 | **PATH 注入** | PowerShell 改用户 PATH + 广播 | 写 `~/.bashrc`/`~/.profile`（按 `process.platform` 分支，`path-util.mjs` 改造） | T08 |
| 8.4 | **known_hosts 落盘** | 系统 `ssh` 用 `~/.ssh/known_hosts` | `ssh2` TOFU 落 `~/.workbuddy/winvm/known_hosts`（须沙箱白名单可写） | T07 + P1-R7 |
| 8.5 | **连接器注册目标** | `connectors/<account>/mcp.json`，`accountId ?? 'default'` | HMOS 活跃账户为 **uuid 目录**（含 `connector-states.v3.json`）；须**解析活跃账户**或**写入所有 account 目录**（见 `oh-adaptation-plan.md` T06） | T06（P0-R3） |
| 8.6 | **沙箱白名单** | 无（Windows 无此约束） | 把 `~/.workbuddy/winvm`、`~/.workbuddy/plugins/cache/winvm/...` 加入 `settings.json` 的 `sandbox.extraAllowWrite` | T07（P0-R4） |
| 8.7 | **stdio 连接器** | `connector:winvm-a2a` 用 `stdio` + `command:process.execPath` | **同样可用**（OH 支持 stdio，已确认）；建议附带 `runtime` 字段 | T09（P1-R6，已缓解） |
| 8.8 | **回收站/卸载** | `Shell.Application` COM | POSIX `mv` 到 `--trash-dir`（`trashItem` 去 PowerShell 分支） | T08 |
| 8.9 | **A2A 桥 / MCP 通道** | 共用一条 `127.0.0.1:18443` 隧道 | 同（隧道由 8.1 提供，桥零改动） | T01–T05 |

> **零改动保证**：Windows/macOS 路径**必须零改动**——守卫 `process.platform==='ohos'`（及 `WINVM_TUNNEL_BACKEND==='ssh2'`）确保 OH 走新分支，其余平台继续走原 `spawn('ssh')`；`path-util.mjs`/`deploy-winvm-plugin.mjs`/`trashItem` 用 `process.platform` 分支，OH 走 Linux 分支、Windows 走原分支。

---

## 附录 A：Windows VM 侧探查脚本

> 用途：在 Windows VM（`172.16.100.2`）上以**管理员 PowerShell** 跑，输出结构化结果，供用户回填「附录 B」。脚本**只读探查、不改系统**。

### A.1 PowerShell 版（在 VM 上执行）

```powershell
# ===== WinVM Bridge · Windows 侧探查脚本（只读） =====
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}

# 1) 安装目录树（WorkBuddy + winvm 服务 + psmod）
$wbProg = 'C:\Program Files\WorkBuddy'
$out.WORKBUDDY_PROGRAM_FILES_EXISTS = Test-Path $wbProg
$out.WORKBUDDY_APP_TREE = (Get-ChildItem $wbProg -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 40 FullName) -join "`n"
$out.LOCALAPPDATA_WORKBUDDY = $env:LOCALAPPDATA + '\WorkBuddy'
$out.APPDATA_WORKBUDDY = $env:APPDATA + '\WorkBuddy'
$out.WINVM_SERVICE_DIR = (Get-ChildItem 'C:\Program Files','C:\ProgramData' -Recurse -Filter 'vm-service*' -ErrorAction SilentlyContinue | Select-Object -First 5 FullName) -join "`n"
$out.PSMOD_DIR = (Get-ChildItem 'C:\Program Files','C:\ProgramData' -Recurse -Filter 'psmod' -ErrorAction SilentlyContinue | Select-Object -First 5 FullName) -join "`n"

# 2) 版本 / 位数
$wbExe = Get-Item (Join-Path $wbProg 'WorkBuddy.exe') -ErrorAction SilentlyContinue
$out.WORKBUDDY_VERSION = if ($wbExe) { $wbExe.VersionInfo.ProductVersion } else { 'N/A' }
$out.WORKBUDDY_ARCH = if ($wbExe) { if ($wbExe.VersionInfo.FileVersionRaw.Revision -band 0x20) {'ARM64'} else {'X64/X86'} } else { 'N/A' }

# 3) node 路径与版本
$node = Get-Command node -ErrorAction SilentlyContinue
$out.NODE_PATH = if ($node) { $node.Source } else { 'N/A' }
$out.NODE_VERSION = if ($node) { & node -v } else { 'N/A' }

# 4) mcp.json 实际路径与内容（前 60 行）
$mcpCandidates = @(
  (Join-Path $env:USERPROFILE '.workbuddy\connectors\default\mcp.json'),
  (Join-Path $env:APPDATA '.workbuddy\connectors\default\mcp.json')
)
$mcpFound = $mcpCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$out.MCP_JSON_PATH = if ($mcpFound) { $mcpFound } else { 'NOT FOUND' }
$out.MCP_JSON_HEAD = if ($mcpFound) { (Get-Content $mcpFound -TotalCount 60) -join "`n" } else { '' }

# 5) ps-bridge 服务状态（VM 内 PowerShell 桥，承载 54 能力）
$svc = Get-Service -Name '*winvm*','*psbridge*','*ps-bridge*' -ErrorAction SilentlyContinue
$out.PSBRIDGE_SERVICE = if ($svc) { ($svc | ForEach-Object { "$($_.Name)=$($_.Status)" }) -join "`n" } else { 'no matching service (may run in-process)' }
$out.PSMOD_MODULE = if (Get-Module -ListAvailable -Name '*winvm*','*psbridge*' -ErrorAction SilentlyContinue) { (Get-Module -ListAvailable -Name '*winvm*','*psbridge*' | Select-Object -First 5 Name,Version) -join "`n" } else { 'no ps module found' }

# 6) codebuddy CLI 安装情况（A2，VM 侧 LLM provider 路径）
$cb = Get-Command codebuddy -ErrorAction SilentlyContinue
$out.CODEBUDDY_CLI = if ($cb) { $cb.Source + ' | ' + (& codebuddy --version 2>$null) } else { 'NOT INSTALLED' }

# 7) 系统 ssh 版本（分水岭：OpenSSH >=7.6 才支持 StrictHostKeyChecking=accept-new）
$ssh = Get-Command ssh -ErrorAction SilentlyContinue
$out.SSH_PATH = if ($ssh) { $ssh.Source } else { 'NO SYSTEM SSH' }
$out.SSH_VERSION = if ($ssh) { (ssh -V 2>&1) } else { 'N/A' }
$out.SSH_GE_7_6 = if ($ssh) { try { [version](ssh -V 2>&1).Split(' ')[0].Trim('_OpenSSH_') -ge [version]'7.6.0' } catch { $false } } else { $false }

# 8) winvm 服务端口监听确认（应仅 127.0.0.1:18443）
$out.LISTENING_18443 = (Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) state=$($_.State)" }) -join "`n"

# 输出 JSON 摘要
$out | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 "$env:USERPROFILE\winvm-vm-probe.json"
Write-Host '=== WinVM VM-side probe complete ===' -ForegroundColor Green
$out | Format-List
Write-Host "`n结果已写入: $env:USERPROFILE\winvm-vm-probe.json" -ForegroundColor Cyan
```

### A.2 bash 版（若 VM 上以 WSL / Git Bash 探查，或 macOS 对照）

```bash
#!/usr/bin/env bash
# WinVM Bridge · Windows 侧探查（bash/WSL 视角，只读）
set +e
echo "=== WORKBUDDY PROGRAM FILES ==="; ls -d "/c/Program Files/WorkBuddy" 2>/dev/null || echo "N/A (native path differs in WSL)"
echo "=== LOCALAPPDATA WORKBUDDY ==="; ls -d "$LOCALAPPDATA/WorkBuddy" 2>/dev/null || echo "N/A"
echo "=== NODE ==="; which node && node -v
echo "=== MCP.JSON ==="; for p in "$USERPROFILE/.workbuddy/connectors/default/mcp.json" "$APPDATA/.workbuddy/connectors/default/mcp.json" "$HOME/.workbuddy/connectors/default/mcp.json"; do [ -f "$p" ] && { echo "FOUND: $p"; head -60 "$p"; break; }; done || echo "NOT FOUND"
echo "=== PS-BRIDGE SERVICE ==="; powershell.exe -NoProfile -Command "Get-Service -Name '*winvm*','*psbridge*' | ForEach-Object { \"$($_.Name)=$($_.Status)\" }" 2>/dev/null || echo "no service"
echo "=== CODEBUDDY CLI ==="; which codebuddy && codebuddy --version || echo "NOT INSTALLED"
echo "=== SSH VERSION (分水岭 >=7.6) ==="; ssh -V 2>&1
echo "=== LISTENING 18443 ==="; powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 18443 | ForEach-Object { \"$($_.LocalAddress):$($_.LocalPort) state=$($_.State)\" }" 2>/dev/null || echo "N/A"
echo "=== DONE ==="
```

---

## 附录 B：Windows（VM）侧事实清单 · 已回填（SSH 实测 172.16.100.2）

> **状态：全部已确认（主理人 SSH 实测）**。原「待回填」声明已关闭，下表不再是占位，而是实测真值。这些值是后续真机端到端验证（A4/A5/A2）与适配方案校准的输入。未决项仅余「HMOS 宿主沙箱是否限制出站 TCP/进程 spawn」（见 `oh-host-selfcheck.md` §5，与 VM 无关）。

| # | 事实 | Windows VM 实际值（已确认） | 影响 |
|---|---|---|---|
| B1 | WorkBuddy 应用安装目录 | `C:\Program Files\WorkBuddy\` ✅（含 `WorkBuddy.exe` 204MB / `resources/` / `locales/` / `Assets/` / `chrome_*.pak` / `ffmpeg.dll` / `libEGL.dll` / `vulkan-1.dll` / `version`） | §3 目录树已校准为真实树 |
| B2 | WorkBuddy 版本 / 位数 | **v5.5.3**，宿主 **Windows 11 `10.0.26200`**；Electron 桌面版（位数未实测，推测 X64） | 确认 Electron 同宗（与 HMOS 一致） |
| B3 | 系统 `node` 路径 / 版本 | **🔴 缺失**：`node` 不在 PATH（`node -v` / `where node` 失败）；`C:\Program Files\WorkBuddy` 内无 `node.exe`（node 编进 Electron 二进制） | VM 侧 ps-bridge 需 node → `install-vm` 须为 VM 装 node（见 `oh-adaptation-plan.md` **P1-R10**） |
| B4 | `~/.workbuddy` 实际根路径（Windows） | `C:\Users\User\.workbuddy\` ✅（模型同 HMOS）；`AppData\Roaming\WorkBuddy` 实测为空 | 确认连接器模型一致，数据根在 `~/.workbuddy` |
| B5 | `mcp.json` 实际路径 | `C:\Users\User\.workbuddy\connectors\8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8\mcp.json` ✅（企业 uuid 目录，与 HMOS 一致） | 校准 §4 / §8.5 注册位置与账户解析 |
| B6 | ps-bridge 服务状态 / 模块 | **🔴 未部署**：VM 内无任何 `winvm*` / `psbridge` 进程、服务、PowerShell 模块；无 `C:\Users\User\winvm` / `C:\winvm` 部署目录、无相关计划任务 | 须先跑 `install-vm.mjs`（见 `oh-adaptation-plan.md` **P0-R0**） |
| B7 | `codebuddy` CLI 是否安装 / 版本 | **🔴 未安装**：`codebuddy --version` / `where codebuddy` 失败 | VM 侧装 codebuddy CLI（见 `oh-adaptation-plan.md` **P1-R8**） |
| B8 | 系统 `ssh -V`（是否 ≥7.6） | **`OpenSSH_for_Windows_9.5p2`**（≥7.6 ✅），`sshd` 服务 **Running / Automatic** | 隧道 VM 端（ssh server）已验证可达；ssh2 客户端算法兼容（P0-R2） |
| B9 | `127.0.0.1:18443` 监听确认 | **当前无监听**（预期：VM 侧尚未部署本项目，`:18443` 由 winvm 服务起，待 `install-vm` 后复测） | 隧道出口正确性依赖 P0-R0 部署 |
| B10 | 账户目录形态（`default` / uuid） | **企业 uuid 目录 `8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8`**（实测，与 HMOS 宿主完全一致）；未实测 `default` 目录是否存在，但保留遍历兜底 | 校准 §8.5 账户解析：注册写该 uuid 目录 |

---

> 本文档所有「已确认」标注来源已扩展为：**真机 OH 宿主探查**（`~/.workbuddy`、`appdata/el2/base/com.tencent.workbuddy`、`settings.json`、已装插件目录）+ **主理人 SSH 进 172.16.100.2 的 VM 实测**（`C:\Program Files\WorkBuddy` 目录树、`C:\Users\User\.workbuddy\connectors\8dd0df6a-…\mcp.json`、OpenSSH 9.5、node/codebuddy 探测）+ 仓库既有实现。原「需回填」占位已全部关闭。
