# WinVM Bridge · 真机 HarmonyOS（OH）宿主可行性自检清单

> **用途**：在动移植代码之前，先在真机 OH 宿主上逐条执行本清单，输出 PASS / FAIL，作为后续编码的**前置门禁（gate）**。
> **范围**：仅核查**宿主侧（OH WorkBuddy）**能否支撑移植；**VM 侧不变**（Windows，IP 假设 `172.16.100.2`，已装 WorkBuddy，可装 codebuddy CLI）。
> **面向**：真机 OH 设备上的终端（OH 为类 Linux shell；若你通过 `hdc shell` / WorkBuddy 内置终端进入，命令相同）。
> **语言**：简体中文。本文只给"查什么、怎么查、判什么"，**不改写项目代码**，代码改造见各条目 `⚙ 移植提示`。

---

## 0. 环境与假设

| 项 | 值 | 说明 |
|---|---|---|
| VM 地址 | `172.16.100.2` | 任务给定，可调 |
| VM SSH 端口 | `22` | 默认；VM 侧仅公钥认证 |
| VM winvm 服务端口 | `18443` | `vm-service.config.json` 中 `server.port`，仅监听 `127.0.0.1` |
| VM 服务基址 | `http://127.0.0.1:18443` | 经 SSH 隧道映射到本机回环 |
| 本地转发端口 | `18443` | `--local-port`，与 remote 同号即可 |
| VM 登录用户 | `<vmuser>` | 替换为真实用户名 |
| 宿主连接文件 | `~/.workbuddy/connectors/<account>/mcp.json` | 连接器注册位置（见 §2） |

> 命令中凡是 `<...>` 占位符请替换为真实值。建议先 `export VM=172.16.100.2 VMUSER=<vmuser>` 再跑下面的探测。

---

## 1. 判读总览（先读这张表）

| # | 维度 | 若 FAIL 是否阻塞移植 | 阻塞点 |
|---|---|---|---|
| 1 | Node 运行时 | 🔴 **阻塞** | 宿主插件/桥/A2A 全靠 node 跑，无 node 即无宿主侧 |
| 2 | OH WorkBuddy 连接器配置路径 | 🔴 **阻塞** | 找不到 mcp.json 落地位置，双通道连接器无处注册 |
| 3 | VM 网络可达性 | 🔴 **阻塞** | 到不了 VM，隧道/MCP/A2A 全部无连接 |
| 4 | 纯 JS 隧道可行性 | 🔴 **阻塞** | 当前隧道依赖系统 `ssh` 二进制；OH 若无 `ssh`，须有纯 JS 方案（ssh2 vendor） |
| 5 | OH 沙箱 / 进程约束 | 🟠 **大概率阻塞** | 长驻进程 / 本地监听 / 端口转发任一被禁，双通道起不来 |
| 6 | 路径 / shell 差异 | 🟡 **需改造（不阻塞可行性，阻塞"开箱即用"）** | 当前大量 Windows 专属代码（PowerShell / .cmd / 回收站 COM），需改；但属确定性改造，不取决环境是否允许 |

**结论**：1/2/3/4 任一 FAIL = 不可移植（环境不支持）；5 任一 FAIL = 不可移植（沙箱禁限）；6 是"代码改造清单"，FAIL 表示"当前实现不能直接在 OH 跑"，必须改，但改造本身有明确路径。

---

## 2. 逐项自检

### 检查 1 · Node 运行时  🔴 阻塞项

**检查目的**：宿主侧所有组件（安装器、A2A 委派桥、winvm-plugin 管理 CLI）都是 Node/ESM 脚本，且 A2A 桥以 `process.execPath`（即运行它的 node）被 WorkBuddy 拉起。须确认 OH 上 node 可被 WorkBuddy 子进程 spawn，架构为 arm64，版本满足要求。

**在 OH 上跑的命令**：

```bash
# 1) node 是否存在且可被找到
which node
echo "PATH 中的 node: $?"

# 2) 版本（项目实测通过 v22.22 / v24.18；绝对下限 node >= 18）
node -v

# 3) 架构与平台（OH 设备多为 arm64；确认 process.platform 报告值）
node -e 'console.log("arch=",process.arch,"platform=",process.platform,"version=",process.version)'

# 4) 能否被子进程 spawn 起来（模拟 WorkBuddy 拉起 A2A 桥）
node -e 'const{spawnSync}=require("child_process");const r=spawnSync(process.execPath,["-e","console.log(\"child ok\")"]);console.log("spawn child:",r.stdout?.toString().trim()||r.error?.message)'
```

**预期结果**：
- `which node` 给出路径，退出码 0。
- `node -v` ≥ `v18`（**强烈建议 ≥ v22**，与项目实测一致；低于 22 不一定崩，但未经测试）。
- `process.arch` 为 `arm64`（常见）或 `x64`；`process.platform` 通常为 `linux`（OH 为 Linux 兼容内核）。
- 子进程 spawn 回显 `child ok`。

**PASS / FAIL 判读**：
- ✅ PASS：node 存在、版本 ≥ 18（建议 ≥22）、能被 spawn。
- ❌ FAIL：`which node` 为空 / 版本 < 18 / 子进程 spawn 失败 → **阻塞**，需先在 OH 安装/注入 node（且须能让 WorkBuddy 的子进程继承到 PATH）。

**⚙ 移植提示**：`install-host.mjs` 用 `process.execPath` 作 A2A 桥 `command`，故桥会沿用 **WorkBuddy 自身的 node**——只要 WorkBuddy 能跑，桥基本就能跑；重点确认 WorkBuddy 的 node 版本与 PATH 继承。

---

### 检查 2 · OH WorkBuddy 连接器配置路径（mcp.json）  🔴 阻塞项

**检查目的**：双通道连接器（`connector:winvm` = MCP 直调、`connector:winvm-a2a` = A2A 委派桥）注册在 `mcp.json`。须确认 OH WorkBuddy 的连接器注册文件落在哪个路径、是否支持 `streamableHttp` 与 `stdio` 两种 transport、以及是否需手动 Trust。

**当前实现事实**（供对照，详见 `packages/adapter-host-workbuddy/src/index.ts`）：
- 渲染目标路径：`~/.workbuddy/connectors/<accountId>/mcp.json`（`accountId` 默认 `default`）。
- 全局亦可：`~/.workbuddy/mcp.json`。
- 写入后结构（增量合并，绝不整体覆盖）：

```json
{
  "mcpServers": {
    "connector:winvm": {
      "timeout": 120000,
      "disabled": false,
      "disabledTools": [ "..." ],
      "type": "streamableHttp",
      "url": "http://127.0.0.1:18443/mcp"
    },
    "connector:winvm-a2a": {
      "timeout": 600000,
      "disabled": false,
      "type": "stdio",
      "command": "<node 绝对路径>",
      "args": ["<pluginRoot>/a2a-bridge/cli.js", "--endpoint", "http://127.0.0.1:18443", "--timeout", "600000"]
    }
  }
}
```

**在 OH 上跑的命令**：

```bash
# 1) 定位 OH WorkBuddy 的连接器 mcp.json（等价 Windows 的 ~/.workbuddy/mcp.json）
find ~ -type f -name mcp.json 2>/dev/null
find ~ -type d -name connectors 2>/dev/null

# 2) 若已存在（如其它连接器），看它支持什么 transport 形态
cat ~/.workbuddy/connectors/default/mcp.json 2>/dev/null | head -60

# 3) 确认 WorkBuddy 根目录结构存在（插件/连接器/marketplaces 树）
ls -la ~/.workbuddy 2>/dev/null
ls -la ~/.workbuddy/connectors 2>/dev/null

# 4) 验证 OH WorkBuddy 的 MCP 客户端是否支持 streamableHttp（回环 HTTP）
#    —— 用一个最小 loopback 服务模拟 VM /mcp，看连接器能否连上（进阶，见 §5 后再做）
```

**预期结果**：
- 能定位到至少一个 `mcp.json`（路径形态为 `~/.workbuddy/connectors/<account>/mcp.json` 或 `~/.workbuddy/mcp.json`）。
- 现有条目里能看到 `type: "streamableHttp"` 或 `type: "stdio"`（证明 OH WorkBuddy 支持这两种 transport）。
- `~/.workbuddy` 目录树存在且可写。

**PASS / FAIL 判读**：
- ✅ PASS：mcp.json 路径明确 + OH WorkBuddy 支持 `streamableHttp` 与 `stdio`。
- ❌ FAIL：找不到 mcp.json 落点 / OH WorkBuddy 仅支持 `stdio` 不支持 `streamableHttp` → **阻塞**（MCP 直调通道依赖 streamableHttp 回环）。

**⚙ 移植提示**：
- 若 OH WorkBuddy 的账户 id 不是 `default`，安装器需传 `--account <id>`（`install-host.mjs` 已支持）。
- 据 `handover/05`：连接器装完通常需在 WorkBuddy **连接器管理页点 Trust** 才激活——OH 上同样需手动信任 `connector:winvm` / `connector:winvm-a2a`。

---

### 检查 3 · VM 网络可达性  🔴 阻塞项

**检查目的**：从 OH 宿主到 VM（`172.16.100.2`）必须可达。验证三层：ICMP（主机在线）、TCP 22（SSH 可建隧道）、TCP 18443（winvm 服务已起且监听回环经隧道可达）。

**在 OH 上跑的命令**（OH 常缺 `ping`/`nc`，优先用 **node 探测**，最稳）：

```bash
export VM=172.16.100.2 VMUSER=<vmuser>

# A) ICMP（仅当 OH 有 ping；无则跳过，ICMP 被防火墙挡也可能误 FAIL）
ping -c 3 "$VM" 2>/dev/null || echo "（OH 无 ping 或 ICMP 被挡，以 B/C 为准）"

# B) TCP 22（ssh 端口）—— 权威"主机+ssh 可达"判据
node -e 'const n=require("net");const s=n.connect({host:process.env.VM,port:22},()=>{console.log("OPEN tcp/22");s.destroy();process.exit(0)});s.on("error",e=>{console.log("FAIL tcp/22",e.code);process.exit(1)});s.setTimeout(3000,()=>{console.log("TIMEOUT tcp/22");s.destroy();process.exit(1)})'

# C) TCP 18443（VM winvm 服务；需 VM 侧已按方案启动并监听 127.0.0.1:18443）
#    注意：未建隧道前 18443 在 VM 内回环，宿主机直连会 FAIL —— 这是预期；
#    先确认 VM 内 `netstat -an | findstr 18443` 监听，再建隧道后复测（见 §4）。
node -e 'const n=require("net");const s=n.connect({host:process.env.VM,port:18443},()=>{console.log("OPEN tcp/18443 (直连)");s.destroy();process.exit(0)});s.on("error",e=>{console.log("FAIL tcp/18443(直连,预期建隧道前 FAIL):",e.code);process.exit(1)});s.setTimeout(3000,()=>{console.log("TIMEOUT tcp/18443");s.destroy();process.exit(1)})'

# 备选（若 OH 有这些工具）：
nc -zv "$VM" 22 2>&1; nc -zv "$VM" 18443 2>&1
python3 -c "import socket;s=socket.socket();s.settimeout(3);s.connect(('$VM',22));print('python OPEN 22');s.close()" 2>&1
```

**预期结果**：
- B：TCP 22 `OPEN`（主机在线且 ssh 可连）。
- C：建隧道**前**直连 18443 预期 FAIL（服务只在 VM 回环）——**不要误判**；建隧道后§4 复测应 OPEN。
- A 仅作参考，ICMP 被挡不代表不可达。

**PASS / FAIL 判读**：
- ✅ PASS：TCP 22 OPEN（且 VM 内确认 18443 已监听）。
- ❌ FAIL：TCP 22 不通 → **阻塞**（无法建隧道，全部通道断）。

**⚙ 移植提示**：VM 服务**只监听 127.0.0.1**（`requireLoopbackBind`），绝不暴露公网；所有访问必须经 SSH 隧道。OH→VM 的路由（同网段 / VPN / 热点直连）需在真机环境实测。

---

### 检查 4 · 纯 JS 隧道可行性（ssh 二进制 vs ssh2）  🔴 阻塞项

**检查目的**：确认 OH 上能否建立 SSH 本地端口转发隧道。当前实现 `packages/core/src/transport/ssh-tunnel.ts` 直接 `spawn('ssh', ['-N','-L',...])`，仓库**无任何 JS ssh 库**。若 OH 无系统 `ssh`（或只有 dropbear 等精简实现，不支持 `StrictHostKeyChecking=accept-new` / `ExitOnForwardFailure=yes`），则必须改走纯 JS 隧道（vendoring `ssh2`）。

**当前隧道依赖的 ssh 能力**（来自代码，移植必保）：
```
ssh -N -L <local>:127.0.0.1:<remote>
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3
    -o StrictHostKeyChecking=accept-new
    [-p <sshport>] [-i <identityFile>]
    <user>@<host>
```

**在 OH 上跑的命令**：

```bash
# 1) 系统是否有 ssh，版本/实现（OpenSSH 还是 dropbear？）
which ssh || echo "NO system ssh"
ssh -V 2>&1

# 2) 实测能否建一条临时隧道（需 VM 侧已起 + 本机已放好公钥）
#    —— 后台起隧道，3 秒后探 127.0.0.1:18443，再 kill
ssh -N -L 18443:127.0.0.1:18443 \
    -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    "$VMUSER@$VM" & TUN=$!
sleep 3
node -e 'const n=require("net");const s=n.connect({host:"127.0.0.1",port:18443},()=>{console.log("TUNNEL OK 127.0.0.1:18443");s.destroy();process.exit(0)});s.on("error",e=>{console.log("TUNNEL FAIL:",e.code);process.exit(1)});s.setTimeout(3000,()=>{console.log("TUNNEL TIMEOUT");s.destroy();process.exit(1)})'
kill $TUN 2>/dev/null

# 3) 若第 1 步 "NO system ssh" 或 dropbear 不支持上述 -o：评估纯 JS 方案
#    3a) npm 是否可用、能否拉到 ssh2（需联网）
node -v; npm -v
npm ping 2>&1 | head -2
npm view ssh2 version 2>&1 | head -2
#    3b) 离线 vendor 预案：是否已准备好预置的 node_modules/ssh2 包（arm64 无关，纯 JS）
ls -d ./vendor/ssh2 2>/dev/null && echo "vendor ssh2 已就绪" || echo "（无 vendor ssh2，需从开发机拷贝）"
```

**预期结果**：
- **路径 A（系统 ssh 可用）**：`which ssh` 有路径、`ssh -V` 显示 OpenSSH（≥7.6 以支持 `accept-new`）、第 2 步 `TUNNEL OK`。→ 现有实现**零改动**即可在 OH 建隧道。
- **路径 B（无系统 ssh / dropbear）**：第 1 步 NO/不支持 → 必须改纯 JS：
  - 且 3a：`npm ping` 成功 + `npm view ssh2` 返回版本 → 可 `npm i ssh2`；
  - 或 3b：已有 vendor 的 `ssh2` 包可随插件分发（无需联网）。
  - 另需写一段"纯 JS 隧道"小封装（用 `ssh2` 建立本地 `net.Server` 监听 `127.0.0.1:18443` → 转发到 VM `127.0.0.1:18443`）。**这是工程师的活，本文不给代码。**

**PASS / FAIL 判读**：
- ✅ PASS：
  - 路径 A：`TUNNEL OK`；或
  - 路径 B：`npm` 可用并能装 `ssh2` **或** 已有 vendor `ssh2` 且能随包分发。
- ❌ FAIL：既无系统 ssh，又无 npm 联网、也无 vendor 包 → **阻塞**，宿主无法打通到 VM 的隧道。

**⚙ 移植提示**：
- `install-host.mjs` 的 postActions 与 `winvm-plugin` 管理 CLI 的 `server/health/command` 也都依赖 `ssh`（SSH 中继）——纯 JS 化需一并覆盖。
- `StrictHostKeyChecking=accept-new` 是 OpenSSH 7.6+ 语法；dropbear 不支持，需改用 `StrictHostKeyChecking=no` 或预先 `ssh-keyscan` 写 known_hosts。这是优先选纯 JS（ssh2）方案的重要原因。

---

### 检查 5 · OH 沙箱 / 进程约束  🟠 大概率阻塞项

**检查目的**：OH 应用运行在沙箱内。须确认 OH WorkBuddy 的沙箱允许：① 拉起**长驻** node 子进程（A2A 桥 stdio MCP server 需常驻）；② 进程**监听本地回环端口**（纯 JS 隧道 / 或系统 ssh 的本地转发监听）；③ **出站 TCP** 到 VM 的 22 / 18443；④ 进程间 stdin/stdout 管道（stdio MCP）。任一被禁，双通道起不来。

**在 OH 上跑的命令**（全部用 node 探，避免依赖外部工具）：

```bash
# 1) 本地回环监听 + 连接（验证沙箱允许 bind/listen 127.0.0.1 + 本地连）
node -e 'require("http").createServer((q,r)=>r.end("ok")).listen(18443,"127.0.0.1",()=>console.log("LISTEN OK 127.0.0.1:18443"))' &
SRV=$!; sleep 1
node -e 'require("http").get("http://127.0.0.1:18443/",r=>{console.log("LOOPBACK HTTP",r.statusCode);process.exit(0)}).on("error",e=>{console.log("LOOPBACK ERR",e.code);process.exit(1)})'
kill $SRV 2>/dev/null

# 2) 长驻子进程 + stdout 管道（验证 stdio MCP 所需的父子进程常驻通信）
node -e 'const{spawn}=require("child_process");const c=spawn(process.execPath,["-e","setInterval(()=>process.stdout.write(\"beat\\n\"),500)"],{stdio:["ignore","pipe","ignore"]});let n=0;c.stdout.on("data",d=>{n++;if(n>=3){console.log("LONG-LIVED CHILD OK ("+n+" beats)");c.kill();process.exit(0)}});setTimeout(()=>{console.log("CHILD NOT PERSISTENT");c.kill();process.exit(1)},2500)'

# 3) 出站 TCP 到 VM（与 §3 的 B 同义，但强调"沙箱是否放行出站"）
node -e 'const n=require("net");const s=n.connect({host:process.env.VM,port:22},()=>{console.log("EGRESS OK -> VM:22");s.destroy();process.exit(0)});s.on("error",e=>{console.log("EGRESS FAIL",e.code);process.exit(1)});s.setTimeout(3000,()=>{console.log("EGRESS TIMEOUT");s.destroy();process.exit(1)})'
```

**预期结果**：
- 1：`LISTEN OK` 且 `LOOPBACK HTTP 200`——沙箱允许本地监听与回环连接。
- 2：`LONG-LIVED CHILD OK`——能拉起并维持子进程、stdout 管道畅通（stdio MCP 的前提）。
- 3：`EGRESS OK -> VM:22`——沙箱放行到 VM 的出站 TCP。

**PASS / FAIL 判读**：
- ✅ PASS：三项全过。
- ❌ FAIL：任一项失败 → **大概率阻塞**。需查 OH 沙箱/IoC 配置（如 `ohos.permission.*`、`app_permission`、是否 `debug`/`shell` 模式运行、是否需 `INTERNET`/socket 权限）。`listen` 失败常为"无本地 socket 权限"；`EGRESS FAIL` 常为"无网络/被防火墙拦"。

**⚙ 移植提示**：OH 应用默认权限较紧。WorkBuddy 若在受限沙箱跑，监听/长驻/出站都可能被拦；这是真机环境特有风险，**只能在真机 OS 层配置解决**，不是改插件代码能绕过的。

---

### 检查 6 · 路径 / shell 差异（移植改造清单）  🟡 需改造项（不阻塞"可行性"，阻塞"开箱即用"）

**检查目的**：当前宿主侧大量代码假设 **Windows**（`.cmd` 启动器、PowerShell 改 PATH、`Shell.Application` 回收站、`WM_SETTINGCHANGE` 广播）。OH 是类 Linux shell，须逐项确认"当前实现能否直接跑"，FAIL = 必须改，但改造路径明确、不取决于环境是否允许。

**在 OH 上跑的命令（确认 OH 的 shell 形态）**：

```bash
# OH 是否具备 bash（启动器 shebang 用 #!/usr/bin/env bash）
which bash || echo "NO bash（可能只有 sh/mksh）"
which sh
echo "SHELL=$SHELL"

# 确认无 Windows 专属工具（这些在 OH 上必不存在，仅作记录）
which powershell.exe cmd.exe 2>/dev/null || echo "NO Windows shells（符合预期）"

# 当前用户 shell profile（PATH 注入目标文件）
ls -la ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null
```

**需改造清单（逐条判读）**：

| # | 现有 Windows 假设（代码位置） | OH 上是否可用 | 判读 | 改造方向 |
|---|---|---|---|---|
| 6.1 | 启动器三件套含 `winvm-plugin.cmd`（仅 Windows PATHEXT 解析） | ❌ OH 无 `.cmd` | FAIL（预期） | 丢弃 `.cmd`，保留 `.mjs` + 无扩展名 `winvm-plugin`（bash 启动器） |
| 6.2 | `path-util.mjs` 用 PowerShell `[Environment]::SetEnvironmentVariable("Path","User")` + `WM_SETTINGCHANGE` 广播改用户 PATH | ❌ OH 无 powershell | FAIL（预期） | 改写：把插件缓存根写入 `~/.bashrc`/`~/.profile` 的 `PATH`，或交给 WorkBuddy 注入；`addToUserPath/removeFromUserPath` 需按 `process.platform` 分支 |
| 6.3 | `install-host.mjs` `trashItem` 用 COM `Shell.Application` 进回收站（`powershell` 调用） | ❌ OH 无 COM/powershell | FAIL（预期） | 卸载走 `--trash-dir` 指定目录，或改为 POSIX `mv` 到回收目录；删除逻辑去掉 powershell 分支 |
| 6.4 | `broadcastEnvChange()` 用 `user32.dll SendMessageTimeout` 广播环境变量变更 | ✅ 已用 `if (process.platform!=='win32') return` 守卫 | **PASS**（无需改） | 保持现状即可 |
| 6.5 | A2A 桥 `command: process.execPath` + `args:[cli.js,...]`（绝对路径） | ✅ 沿用 WorkBuddy 的 node，arm64 JS 无关 | **PASS**（无需改） | dist 为平台无关 JS，node_modules 自包含即可 |
| 6.6 | `disabledTools` 高危工具静态禁用、`installed_plugins.json` 注册、`vm-conn.json` 持久化 | ✅ 纯 JSON/FS，跨平台 | **PASS**（无需改） | 路径同 `~/.workbuddy/...`，OH 一致 |
| 6.7 | 启动器 shebang `#!/usr/bin/env bash` + `chmod +x` | ⚠ 取决于 OH 是否有 `bash` | 视 §6 命令结果 | 若仅 `sh`，把 shebang 改为 `#!/bin/sh`，并确认 `sh` 能 `exec node` |
| 6.8 | `process.platform` 判读：代码多处 `if (process.platform==='win32')` 走 Windows 专属 | ✅ OH 通常报 `linux`，正确跳过 Windows 分支 | **PASS**（无需改） | 仅需在新增 OH 分支时复用同一守卫 |

**PASS / FAIL 判读（本维度整体）**：
- ✅ 可接受：6.4 / 6.5 / 6.6 / 6.8 当前已跨平台；6.1~6.3 + 6.7 需改造但**有确定方案**。
- ❌ "开箱即用" FAIL：当前代码**不能**在 OH 直接跑（因为有 Windows 专属逻辑），必须做 §6 改造。
- 本维度**不阻塞可行性**——改造是确定性工程任务，不依赖环境是否"允许"。

**⚙ 移植提示（给工程师的改造顺序）**：
1. `path-util.mjs`：按 `process.platform` 增加 OH/Linux 分支（写 `~/.profile` 或 `~/.bashrc`）；保留 Windows 分支。
2. `deploy-winvm-plugin.mjs`：OH 下不写 `.cmd`，仅写 `.mjs` + 无扩展名启动器（shebang 适配 `bash`/`sh`）。
3. `install-host.mjs` `trashItem`：OH 下去掉 `powershell`/`Shell.Application`，改 `--trash-dir` 或 POSIX `mv`。
4. 全仓 `spawnSync('powershell',...)` 处加 `process.platform` 守卫（grep 自查）。

---

## 3. 门禁结论模板（贴回工程）

跑完上面 6 组，按此模板出结论：

```
[1] Node 运行时            : PASS / FAIL
[2] 连接器 mcp.json 路径   : PASS / FAIL
[3] VM 网络可达性          : PASS / FAIL
[4] 纯 JS 隧道可行性       : PASS(path A 系统ssh) / PASS(path B ssh2) / FAIL
[5] OH 沙箱/进程约束       : PASS / FAIL
[6] 路径/shell 差异        : 需改造（明确清单已列）/ 阻塞

门禁判定：
  - 若 [1][2][3][4][5] 全 PASS  → 环境可行，可进入编码（先做 [6] 改造）
  - 若 [1][2][3][4][5] 任一 FAIL → 环境不支持，先解决环境/沙箱/隧道，再编码
  - [6] 永远需要改造，但不作为"能否动手"的 blockers
```

---

## 4. 附录：当前宿主侧实现事实（给工程师对照，非自检步骤）

- **隧道**：`packages/core/src/transport/ssh-tunnel.ts` `spawn('ssh',['-N','-L',...])`；仓库无 JS ssh 库。
- **连接器渲染**：`packages/adapter-host-workbuddy/src/index.ts` `resolveWorkBuddyPaths` → `~/.workbuddy/connectors/<accountId>/mcp.json`；`renderConnectorEntry` 把 `ssh-tunnel` transport 渲染为 `type:streamableHttp` + `url:http://127.0.0.1:<localPort>/mcp`，`stdio` transport 原样输出 `command/args`。
- **A2A 桥**：`packages/host-a2a-bridge` 以本地 stdio MCP server 形态运行，`command=process.execPath`，内部用 `A2AClient` 经同一条 SSH 隧道调 VM `/a2a`；与 MCP 通道共用隧道。
- **安装器**：`delivery/install-host.mjs` 写 `connector:winvm` + `connector:winvm-a2a` 增量补丁、注册 `installed_plugins.json`、写 `vm-conn.json`、把插件缓存根加入用户 PATH。
- **管理 CLI**：`delivery/winvm-plugin.mjs`（`side:host` 自动识别）的 `server/health/command` 经 SSH 中继，亦依赖 `ssh` 二进制。
- **VM 侧不变**：`vm-service.config.json` 仅监听 `127.0.0.1:18443`，transport 优先 `mcp-streamable-http` / `a2a-http`；`requireLoopbackBind=true`。

> 本文档为**可行性门禁清单**，只负责"能不能动手"。所有代码改造（§4/§6 的 ⚙ 提示）由工程师在编码阶段完成，不在本清单范围内。
