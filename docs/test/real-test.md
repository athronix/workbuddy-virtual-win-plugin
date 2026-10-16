# WinVM Bridge 真实环境测试方案（real-test）

| 项 | 值 |
|---|---|
| 文档 ID | REAL-TEST-winvm-bridge-v1 |
| 版本 | v1.0 |
| 作者 | QA（Edward，software-qa-engineer） |
| 日期 | 2026-09-23 |
| 适用对象 | CL-020（F2 全通道采集 + 隧道生产化）真机部署后的**全量真环境验收** |
| 本轮性质 | **只制定方案，不执行真部署、不触碰 VM**（真执行见后续迭代任务，本方案的「执行记录模板」供其逐轮填写） |
| 关联资料（只读参考） | `docs/INSTALL-GUIDE.md`、`docs/INSTALL-VERIFY-REPORT.md`、`docs/02-design/CAPABILITY-MODEL.md`、`docs/changes/CL-020/DEPLOY-VERIFICATION.md`、`.workbuddy/README.md`、`delivery/env.example` |

---

## 0. 目的、范围与判读约定

### 0.1 目的
以**可执行、可判读**的方式，在真机（鸿蒙宿主 + Windows 11 VM）上验证三件事：
1. **插件部署完整性**——宿主缓存根运行态文件、VM 侧 `dist`、计划任务、隧道四者可运行且与仓库同源；
2. **插件组件服务健康性**——`/health` 全绿、F2 懒刷新生效、隧道断线自愈；
3. **WorkBuddy 端各类型任务用例**——覆盖 5 大能力域（system / app / storage / gui / appops）与 MCP / A2A 双通道的真实操作。

### 0.2 范围
- **含**：宿主 CLI（`delivery/winvm-plugin.mjs`）、VM 服务双通道（`POST /mcp` / `POST /a2a`）、常驻隧道（`delivery/tunnel-daemon.mjs`）、54 项能力。
- **不含**：源码级单元测试（`tests/` 已有 342 例）、破坏性 L3 能力（`system.power.control` 真实执行、`storage.volume.destructive` 红线能力）。

### 0.3 判读约定（全文档统一）
- **用例状态词**只用四个：`PASS` / `FAIL` / `BLOCKED`（前置不满足，非缺陷）/ `SKIP`（本轮不适用）。
- **安全红线**：所有命令默认**只读或可逆**；L2/L3 用例**只走 dry-run 或审批闸**，绝不在本方案中直接执行不可逆变更。
- 全文命令均可**直接复制**；`$REPO` / `$NODE` / `$CACHE` 见 §1.2（先 `source` 一次即可）。

---

## 1. 测试环境与前置准备

### 1.1 拓扑与硬约束

```
┌──────────────────────────────────────────┐         ┌───────────────────────────────┐
│  宿主 HarmonyOS NEXT PC (WorkBuddy 插件)  │         │  Windows 11 VM                 │
│  process.platform = openharmony           │         │  172.16.100.2                  │
│  node v24.13.0                            │         │                                │
│                                           │  SSH    │  ┌──────────────────────────┐ │
│  常驻隧道 127.0.0.1:18443 ───────────────┼────────►│  │ vm-service 仅监听 127.0.0.1│ │
│  (tunnel-daemon.mjs, 进程内 ssh2)         │  隧道    │  │  18443 (POST /mcp, /a2a)  │ │
│                                           │         │  └──────────────────────────┘ │
│  插件缓存根 ~/.workbuddy/plugins/cache/   │         │  C:/WinVMBridge/               │
│    winvm/winvm-bridge/0.1.0/              │         │   packages/*/dist              │
│  隧道状态 ~/.workbuddy/winvm/             │         │   计划任务 WinVMBridge.Service │
└──────────────────────────────────────────┘         └───────────────────────────────┘
```

硬约束（违反即判 FAIL，不允许放宽）：
- VM 服务**强制只监听 `127.0.0.1`**，访问一律经 SSH 隧道；
- GUI 能力要求在**未锁屏 + Explorer 在跑**的交互式会话，否则 `degraded`（设计门禁，非缺陷）；
- 真执行的唯一入口是显式 `--apply`（本方案**不含**部署执行）。

### 1.2 环境变量速查（每次测试前 `source`）

```bash
export REPO=/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin
export NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
export CACHE=/storage/Users/currentUser/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0
export HOME_WINVM=/storage/Users/currentUser/.workbuddy/winvm
```

> 说明：宿主 `node`/`npm` 均位于 `/data/storage/el1/bundle/libs/arm64/node/bin/`；`/tmp` 只读；`getcwd` 偶发异常，故所有命令用**绝对路径**或 `cd "$REPO" &&`。

### 1.3 环境快照（每轮测试**开始前**先采集，贴入执行记录模板）

```bash
# 1) 平台与 node 版本
"$NODE" -e 'console.log(process.platform, process.version)'

# 2) VM 连接持久化配置（应存在；注意 identityFile 是否已持久化，见 §2.1 备注）
"$NODE" -e 'console.log(require("fs").readFileSync(process.env.HOME_WINVM+"/vm-conn.json","utf8"))'

# 3) 隧道状态文件（pid/state/alive）
"$NODE" -e 'const f=require("fs");console.log("tunnel.pid:",f.readFileSync(process.env.HOME_WINVM+"/tunnel.pid","utf8"));console.log("tunnel.state.json:",f.readFileSync(process.env.HOME_WINVM+"/tunnel.state.json","utf8"))'

# 4) 仓库 HEAD（本沙箱无 git；若可用）
cd "$REPO" && git rev-parse --short HEAD 2>/dev/null || echo "(无 git，记录文件 md5 基线代替)"
```

---

## 2. 第一类：插件部署完整性验证

### 2.1 宿主侧 —— 缓存根运行态文件齐全且与仓库一致

**被测对象**：`~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`
**关键运行态文件**（`deploy-winvm-plugin.mjs` 以 `extraFiles` 随启动器一并投放，路径均为缓存根**同目录**）：

| 文件 | 来源（仓库） | 作用 |
|---|---|---|
| `winvm-plugin.mjs` | `delivery/winvm-plugin.mjs` | 管理 CLI 主体 |
| `tunnel-daemon.mjs` | `delivery/tunnel-daemon.mjs` | 常驻隧道守护进程 |
| `oh-tunnel.mjs` | `delivery/oh-tunnel.mjs` | 进程内 ssh2 隧道实现 |
| `ssh2-resolve.mjs` | `delivery/ssh2-resolve.mjs` | ssh2 模块解析（三要素引导） |
| `a2a-bridge/cli.js` | `packages/host-a2a-bridge/dist/cli.js` | A2A 委派桥 CLI |
| `.winvm-context.json` | 部署期生成 | `{"side":"host"}` 上下文标记 |

**逐文件比对方法（可移植 md5，规避 `md5sum` 可能缺失）**：

```bash
cd "$REPO" && "$NODE" -e '
const fs=require("fs"), c=require("crypto");
const R=process.env.REPO, C=process.env.CACHE;
const h=p=>fs.existsSync(p)?c.createHash("md5").update(fs.readFileSync(p)).digest("hex"):"(缺失)";
const pairs=[
  ["winvm-plugin.mjs","delivery/winvm-plugin.mjs"],
  ["tunnel-daemon.mjs","delivery/tunnel-daemon.mjs"],
  ["oh-tunnel.mjs","delivery/oh-tunnel.mjs"],
  ["ssh2-resolve.mjs","delivery/ssh2-resolve.mjs"],
  ["a2a-bridge/cli.js","packages/host-a2a-bridge/dist/cli.js"],
];
let bad=0;
for(const [rel,src] of pairs){
  const a=h(R+"/"+src), b=h(C+"/"+rel);
  const ok=a===b && a!=="(缺失)";
  if(!ok) bad++;
  console.log((ok?"OK  ":"DIFF")+"  "+rel+"  repo="+a.slice(0,12)+"  cache="+b.slice(0,12));
}
process.exit(bad?1:0);
'
```

**通过判据**：全部 5 行输出 `OK`，退出码 `0`。
**快照时效（重要）**：本项「全 `SAME`」结论**仅在采集快照的那一刻有效**。每次执行轮须**重新采集**并在报告中**标注快照时间戳**与各方 md5。已知后续变更窗口：工程师 D5 只改 `install-host.mjs`（不影响此 4 文件）；**D6 修复会改 `winvm-plugin.mjs`/`tunnel-daemon.mjs`** → D6 之后本项 md5 将再次变化，须以「是否已重投」口径判读。
**判缺陷前置（重要，Q1 裁定）**：出现 `DIFF` 时**先判「本次重投部署是否已完成」**（`install-host.mjs` 是否已把新 `delivery/*.mjs` 投放到缓存根），**再**判缺陷。若为「仓库已前进、运行态未重投」（典型：本轮新增子命令/修复尚未投放，如 `tunnel` 的 `ensure`），属**部署待办**（闭到部署验收项），**不得直接报 P0**；重投后复跑本脚本必须全 `OK`。
**额外结构校验**（防止「Hash 一致但上下文错」）：
```bash
"$NODE" -e 'console.log(require("fs").readFileSync(process.env.CACHE+"/.winvm-context.json","utf8"))'   # 期望 {"side":"host"}
```

> **备注（I1，本轮落盘 · Q4 裁定）**：`~/.workbuddy/winvm/vm-conn.json` 应在**重投部署后**含 `identityFile`（I1：`install-host.mjs` 于部署期把探测到的默认私钥持久化进该字段）。执行轮在重投后断言：① `identityFile` 存在且指向真实私钥文件；② `command <tool>` 可连。B4 的运行时默认私钥探测链（`~/.ssh/id_ed25519 → id_ecdsa → id_rsa`）**保留为兜底**。
> ```bash
> "$NODE" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.env.HOME_WINVM+"/vm-conn.json","utf8"));console.log("identityFile=",(c.identityFile||"(缺失)"),"exists=",c.identityFile?fs.existsSync(c.identityFile):false)'
> ```
> `identityFile` 缺失时**不阻断**（运行时探测兜底仍可用），记 **P2**。

---

### 2.2 VM 侧 —— `dist` 与仓库字节一致 + 计划任务双触发

**被测对象**：`C:/WinVMBridge/packages/<pkg>/dist`、计划任务 `WinVMBridge.Service`。

#### 2.2.1 字节一致（宿主 → 隧道 → VM 计算 md5 后回传）

宿主侧对每个包同时算「仓库 md5」与「VM md5」，逐包比对：

```bash
cd "$REPO" && "$NODE" -e '
const {execFileSync}=require("child_process");
const fs=require("fs"), c=require("crypto");
const R=process.env.REPO, VM=process.env.VM_DEPLOY_DIR || "C:/WinVMBridge";
const ssh=(cmd)=>execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2",cmd],{encoding:"utf8"}).trim();
const md5=p=>{try{return c.createHash("md5").update(fs.readFileSync(p)).digest("hex")}catch{return "(缺失)"}};
// 关键 dist（CL-020 涉及的两份 + 服务入口）
const targets=[
  ["packages/vm-service/dist/server.js", VM+"/packages/vm-service/dist/server.js"],
  ["packages/adapter-agent-workbuddy/dist/index.js", VM+"/packages/adapter-agent-workbuddy/dist/index.js"],
  ["packages/vm-service/dist/cli.js", VM+"/packages/vm-service/dist/cli.js"],
];
for(const [rel,vmPath] of targets){
  const local=md5(R+"/"+rel);
  let remote;
  try{ remote=ssh(`powershell -NoProfile -Command "(Get-FileHash -Algorithm MD5 -LiteralPath \"${vmPath}\").Hash"`).toLowerCase(); }
  catch(e){ remote="(SSH失败:"+e.message.slice(0,60)+")"; }
  console.log((local===remote?"SAME ":"DIFF ")+rel+"  repo="+local.slice(0,12)+"  vm="+remote.slice(0,12));
}
'
```

> 若 SSH 直接执行遇 Defender 拖慢，可改用 `qa/probes/lead-md5-3.ps1`（随装分发在 `C:/WinVMBridge/`）：
> `ssh User@172.16.100.2 "powershell -NoProfile -ExecutionPolicy Bypass -File C:/WinVMBridge/lead-md5-3.ps1"`

**通过判据**：关键 dist 全部 `SAME`。任一 `DIFF` → **P0**（运行态非源码态，F2/修复不生效）。

#### 2.2.2 计划任务存在且为「开机 + 登录」双触发

> **命令形态（重要，实测修正）**：本沙箱 shell 为 **MSYS/Git-Bash**，会把 `schtasks /Query` 的 `/Query` 误转为本地路径、并吞掉反斜杠；且 **VM 侧默认 SSH shell 是 bash/MSYS**（不是 cmd）。
> 因此**不要**用 `ssh "schtasks /Query ..."` 直连。统一走 **Node-spawned `execFileSync("ssh",…)`（绕过 MSYS 层）+ PowerShell 命令 + 正斜杠路径**。

```bash
# ① 任务存在性 + 触发类型（Node 直接 spawn ssh，规避 MSYS 路径转换；PowerShell 读回 XML，正斜杠）
cd "$REPO" && "$NODE" -e '
const {execFileSync}=require("child_process");
const run=(ps)=>execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2",
  "powershell -NoProfile -Command "+JSON.stringify(ps)],{encoding:"utf8",timeout:70000}).trim();
// 任务存在性 + 关键字段
console.log(run("Get-ScheduledTask -TaskName WinVMBridge.Service | Select-Object TaskName,State | Format-List"));
// 触发类型明细（Name + Enabled），规避本地化输出差异
console.log("TRIGGERS:",
  run("(Get-ScheduledTask -TaskName WinVMBridge.Service).Triggers | Select-Object -ExpandProperty CimClass | Select-Object -ExpandProperty CimClassName"));
'
# 期望：存在 WinVMBridge.Service；TRIGGERS 同时含 MSFT_TaskBootTrigger 与 MSFT_TaskLogonTrigger
```

> 期望的 Task XML（`install-vm.mjs` 生成，UTF-16LE+BOM，`schtasks /Create /XML`）：`<Triggers>` 内**同时**存在
> `<BootTrigger><Enabled>true</Enabled></BootTrigger>` 与 `<LogonTrigger><Enabled>true</Enabled></LogonTrigger>`；
> `<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>`、`<RestartOnFailure><Count>3</Count>`、
> `<LogonType>InteractiveToken</LogonType>`、`<Hidden>true</Hidden>`。
> 直接读回 XML 校验（推荐，规避本地化输出差异；同样走 Node-spawned ssh + PowerShell）：
```bash
cd "$REPO" && "$NODE" -e '
const {execFileSync}=require("child_process");
const ps="[xml]$x=(schtasks /Query /TN WinVMBridge.Service /XML); $x.Task.Triggers.ChildNodes | ForEach-Object { $_.Name + \" enabled=\" + $_.Enabled }";
console.log(execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2","powershell -NoProfile -Command "+JSON.stringify(ps)],
  {encoding:"utf8",timeout:70000}).trim());
'
# 期望输出两行：BootTrigger enabled=True  与  LogonTrigger enabled=True
```

**通过判据**：任务存在，且 `BootTrigger` 与 `LogonTrigger` **各自的 `enabled=True`**。
**说明**：BootTrigger 落在 Session 0（无交互桌面，GUI 不可用）；登录后 LogonTrigger 在交互式会话再拉起（`StopExisting` 先停后起），GUI 才可用。**两者共存即满足"开机自启"承诺**。

> **⚠ 实测修正（Run1，2026-09-23）**：上方 `Get-ScheduledTask` / `schtasks /Query ... /XML` 样例虽经 Node-spawn ssh，
> 但 **VM 侧默认 shell 是 bash/MSYS**，会二次处理该串：吞掉 `$x`/`$_` 并把 `/Query` `/TN` `/XML` 路径转换为
> `C:/Program Files/Git/Query` → 触发 `无效参数/选项`。**改用下面这条已实测可用的命令（双斜杠）**：
> ```bash
> cd "$REPO" && "$NODE" -e '
> const {execFileSync}=require("child_process");
> const xml=execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2",
>   "schtasks //Query //TN WinVMBridge.Service //XML"],{encoding:"utf8",timeout:90000});
> const boot=(xml.match(/<BootTrigger>/g)||[]).length, logon=(xml.match(/<LogonTrigger>/g)||[]).length;
> console.log("BootTrigger=",boot,"LogonTrigger=",logon,"| PASS=",boot>=1&&logon>=1);
> console.log((xml.match(/<Triggers>[\s\S]*?<\/Triggers>/)||["(未找到)"])[0].replace(/></g,">\n<"));
> '
> ```
>
> **⚠ 判缺陷前置（先判「VM 侧是否已重投」）**：`live task` 缺 `BootTrigger` 时，**先比对 VM 侧与仓库的生成器版本**再判缺陷：
> ```bash
> cd "$REPO" && "$NODE" -e '
> const {execFileSync}=require("child_process"),fs=require("fs");
> const enc=(p)=>"powershell -NoProfile -EncodedCommand "+Buffer.from("Get-Content -Raw -LiteralPath '"+"'"+"'"+p+"'"+"'"+"'","utf16le").toString("base64");
> /* 注意：请用下面简化写法（EncodedCommand 规避 bash 展开） */
> const rd=(p)=>{const ps="Get-Content -Raw -LiteralPath \x27"+p+"\x27";
>   const b64=Buffer.from(ps,"utf16le").toString("base64");
>   return execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2","powershell -NoProfile -EncodedCommand "+b64],{encoding:"utf8",timeout:90000});};
> const cnt=(s,r)=>(s.match(r)||[]).length;
> const repo=fs.readFileSync(process.env.REPO+"/delivery/install-vm.mjs","utf8");
> console.log("repo install-vm.mjs  Boot=",cnt(repo,/BootTrigger/g),"Logon=",cnt(repo,/LogonTrigger/g));
> try{const vmf=rd("C:/WinVMBridge/delivery/install-vm.mjs");console.log("VM   install-vm.mjs  Boot=",cnt(vmf,/BootTrigger/g),"Logon=",cnt(vmf,/LogonTrigger/g))}catch(e){console.log("VM install-vm read err",e.message.slice(0,80))}
> try{const tx=rd("C:/WinVMBridge/delivery/.generated/task.xml");console.log("VM   task.xml        Boot=",cnt(tx,/BootTrigger/g),"Logon=",cnt(tx,/LogonTrigger/g))}catch(e){console.log("VM task.xml read err",e.message.slice(0,80))}
> '
> ```
> **判读**：仓库 `BootTrigger>=1` 而 VM 侧 `BootTrigger=0` → **部署未重投 / 任务未重注册**（部署缺陷，路由工程师+交付），**非**源码 bug；
> 两侧都 `0` → 源码/生成器缺陷（路由工程师）。

---

### 2.3 隧道 —— CLI 判定 + pid 归属 + 端口监听（D6 口径）

**被测对象**：`tunnel.pid` / `/proc/<pid>` 归属 / `127.0.0.1:18443` 监听（`tunnel.state.json` 仅作参考，见 D6 豁免）。

```bash
# ① 三态读取（CLI 自带三态判定：RUNNING / DEGRADED / STOPPED）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs tunnel status --json

# ② 端口监听（Node net 直连，规避 PowerShell Test-NetConnection 的 locale/stdio 陷阱）
"$NODE" -e '
const net=require("net");const s=net.connect(18443,"127.0.0.1");
s.setTimeout(1500);
s.once("connect",()=>{console.log("LISTENING 127.0.0.1:18443");s.destroy();process.exit(0)});
s.once("timeout",()=>{console.log("NOT LISTENING (timeout)");s.destroy();process.exit(1)});
s.once("error",()=>{console.log("NOT LISTENING (error)");s.destroy();process.exit(1)});
'
```

**一致性判据（D6 裁定后口径；全部满足才 `PASS`）**：
1. **`tunnel status --json` 报 `state=="RUNNING"`、`healthy==true`**（**以 CLI 为准**，`state.json` 不作判据）；
2. `tunnel.pid` 的 `pid` 进程**真实存活**（`process.kill(pid,0)` 不抛错），且 `/proc/<pid>/cmdline` 含 `tunnel-daemon.mjs`（确为隧道守护进程，非被复用的无关 pid）；
3. 127.0.0.1:18443 处于 `LISTENING`。

**D6 豁免（不判 FAIL）**：`tunnel.state.json` 与 pidfile **不一致**（`state.json` 可能陈旧）→ **仅记为 D6 引用**，不影响本项 `PASS`。已知 D6（P1）：`state.json` 声称 `pid=58555/alive=true` 但该进程已死；真正存活的是 pidfile 的 pid 300。

**取证命令（只读）**：
```bash
# ① 隧道 CLI 判定（权威）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs tunnel status --json
# ② pidfile pid 存活 + cmdline 归属校验
"$NODE" -e '
const fs=require("fs"), H=process.env.HOME_WINVM;
const pid=JSON.parse(fs.readFileSync(H+"/tunnel.pid","utf8")).pid;
let alive=true; try{process.kill(pid,0)}catch{alive=false}
let cmd=""; try{cmd=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").replace(/\0/g," ").trim()}catch{}
console.log("pidfile pid=",pid,"alive=",alive,"isTunnelDaemon=",cmd.includes("tunnel-daemon.mjs"));
console.log("cmdline=",cmd.slice(0,160));
'
# ③ 端口监听（Node net 直连，规避 PowerShell Test-NetConnection 的 locale/stdio 陷阱）
"$NODE" -e '
const net=require("net");const s=net.connect(18443,"127.0.0.1");
s.setTimeout(1500);
s.once("connect",()=>{console.log("LISTENING 127.0.0.1:18443");s.destroy();process.exit(0)});
s.once("timeout",()=>{console.log("NOT LISTENING (timeout)");s.destroy();process.exit(1)});
s.once("error",()=>{console.log("NOT LISTENING (error)");s.destroy();process.exit(1)});
'
```

> 三态语义（`winvm-plugin.mjs#readTunnelStatus`）：`RUNNING` = 进程存活 ∧ 端口可连 ∧ `state.alive===true`；
> `DEGRADED` = 存活且端口可连但 `state.alive!==true`；`STOPPED` = 进程已不在（陈旧 pidfile 会被自动清理）。
> 注：`readTunnelStatus` 以 **pidfile 的 pid** 判定存活，故 pidfile 陈旧（指向已被复用的 pid）时可能给出「假 RUNNING」——判据 2 的 cmdline 归属校验用于交叉印证。

---

## 3. 第二类：插件组件服务健康性验证

### 3.1 `/health` 全绿判据

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs health
```

期望快照（结构见 `packages/vm-service/src/server.ts#buildHealth`）：

```jsonc
{
  "ok": true,
  "provider": { "id": "workbuddy", "state": "ready" },
  "session":  { "interactive": true, "locked": false, "state": "healthy" },
  "psBridge": { "state": "ready", "pending": 0, "restarts": <n> },
  "capabilities": { "count": 54, "available": 54 },
  "audit": { "entries": <n>, "chainValid": true },
  "cache": { "netCfg": { "cached": true, "ageMs": <n>, "ttlMs": 45000 } },
  "logging": { "degraded": false },
  "exposed": 54
}
```

**逐字段通过判据**：

| 字段 | 期望 | 不达标定性 |
|---|---|---|
| `ok` | `true` | P0（provider 未加载或 ps-bridge down） |
| `provider.state` | `ready` | P0 |
| `capabilities.count == capabilities.available` | `54 == 54` | P0（能力暴露面缺失） |
| `audit.chainValid` | `true` | P0（审计链断裂；需查 `audit.brokenAt/reason`） |
| `psBridge.state` | `ready` | P0；`degraded`+`probe:"timeout"` 为**可辨识降级**（P2，短超时护栏生效） |
| `session.state` | `healthy` | 非 healthy 为环境门禁（`BLOCKED`，影响 GUI 用例，非产品缺陷） |
| `exposed` | `54` | P0 |

### 3.2 F2 懒刷新（CL-020 核心）—— 缓存 TTL 45s 窗口

**机制**：`system.network.config` 有进程内 TTL 缓存（`WINVM_NETCFG_TTL_MS=45000`）；服务启动异步预热；
`/health.cache.netCfg.ageMs = now - Date.parse(collectedAt)`，`ttlMs=45000`。

**步骤与命令**：

```bash
# ① BEFORE：读缓存年龄
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs health > /dev/null 2>&1   # 预热/刷新一次快照
"$NODE" -e '
const {execFileSync}=require("child_process");
const out=execFileSync(process.env.NODE,["delivery/winvm-plugin.mjs","health"],{cwd:process.env.REPO,encoding:"utf8"});
const h=JSON.parse(out); const n=h.cache.netCfg;
console.log("BEFORE netCfg:", JSON.stringify(n));
'
# ② 触发一次真实采集（走 MCP 通道，provider.execute 内经 reportNetCfg 上抛刷新）
"$NODE" delivery/winvm-plugin.mjs command system.network.config
# ③ AFTER：再读缓存年龄，应落入 TTL 45s 窗口
"$NODE" -e '
const {execFileSync}=require("child_process");
const out=execFileSync(process.env.NODE,["delivery/winvm-plugin.mjs","health"],{cwd:process.env.REPO,encoding:"utf8"});
const n=JSON.parse(out).cache.netCfg;
console.log("AFTER  netCfg:", JSON.stringify(n));
console.log("PASS:", n.cached===true && n.ageMs>=0 && n.ageMs < n.ttlMs);
'
```

**通过判据**：
1. 命令②输出 `"ok": true` 且 `data.cached === false`、`data.cacheAgeMs === 0`（本次为冷采集）；
2. 命令③ `AFTER` 中 `cached===true && 0 <= ageMs < ttlMs(45000)`；
3. 若 `BEFORE.ageMs` 陈旧（> ttlMs），刷新后必须**骤降**进入窗口 —— 这是 F2 生效的直接证据。
**参照基线**（CL-020 真机实测）：`50,446,574ms → 13,266ms`。

> **A2A 侧覆盖**（F2 的「全通道」语义）：F2 修复把采集上抛从 MCP handler 移到 `provider.execute`，MCP/A2A 共用同一 execute。
> A2A 侧验证见 §4.7 TC-A2A-01 后追加的 `health` 复查（委派后 `cache.netCfg.ageMs` 同样回落）。

### 3.3 隧道自愈 —— VM 服务重启后的黑洞时长与恢复

**机制**：`tunnel-daemon.mjs` 用 `OhSshTunnel` 退避重连，断线期间状态报 `DEGRADED`，恢复后回 `RUNNING`。

> **触发方式（实测修正，重要）**：宿主 CLI 的 `server restart` 在本环境**不可用** —— 它经 SSH 在 VM 执行 `schtasks /end /tn …`，而 **VM 默认 SSH shell 为 MSYS Git-Bash**（`SHELL=/c/program files/git/bin/bash.exe`），会把 `/end`、`/tn` 路径转换为 `C:/Program Files/Git/end`，令 `schtasks` 报「无效参数/选项」→ 命令抛错（**缺陷 D7，P1**，见报告）。故触发改用 **Node-spawned ssh + PowerShell**（绕过 VM MSYS 转换）：

```bash
# ① 记录基线黑洞前状态
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs tunnel status --json
# ② 触发 VM 服务重启（Node-spawned ssh + PowerShell；不重启隧道 daemon）
# 实测：`schtasks //end` 与 `Stop-ScheduledTask` 均**未能**停服（运行实例未被任务调度器跟踪，端口仍在）；
# 真正能触发黑洞的是“杀掉端口属主进程”（等价于 server restart 内的 killCmd）。用 EncodedCommand 规避 bash 展开。
cd "$REPO" && "$NODE" -e '
const {execFileSync}=require("child_process");
const ps="$p=(Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique; if($p){Stop-Process -Id $p -Force; Write-Output (\"killed \"+$p)} else {Write-Output \"none\"}";
const b64=Buffer.from(ps,"utf16le").toString("base64");
console.log(execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2","powershell -NoProfile -EncodedCommand "+b64],{encoding:"utf8",timeout:60000}).trim()||"ok");
'
# ③ 立刻开始轮询：记录首个失败时刻与首个成功时刻，计算黑洞时长
"$NODE" -e '
const {execFileSync}=require("child_process");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t0=Date.now(); let firstFail=null, firstOK=null;
  for(let i=0;i<60;i++){               // 最多轮询 ~120s（60×2s）
    let ok=false;
    try{
      const out=execFileSync(process.env.NODE,["delivery/winvm-plugin.mjs","command","meta.health.check"],
        {cwd:process.env.REPO,encoding:"utf8",timeout:20000});
      ok = out.includes("\"ok\": true");
    }catch{ ok=false; }
    const dt=Date.now()-t0;
    if(!ok && firstFail===null) firstFail=dt;
    if(ok){ firstOK=dt; break; }
    await sleep(2000);                 // 粗粒度轮询间隔
  }
  console.log("firstFailMs=",firstFail," firstRecoverMs=",firstOK,
    " blackholeMs=",(firstOK!=null&&firstFail!=null)?(firstOK-firstFail):"(未观察到黑洞)");
})();
'
```

**通过判据**：
1. 过程内 `tunnel status` 一次进入 `DEGRADED`（若黑洞足够长可观测）后自动回到 `RUNNING`——**无人工干预**；
2. 恢复后 `command meta.health.check` 返回 `ok:true`，且 `tunnel.status` 的 pid 不变（同一守护进程自愈，而非新进程顶替）；
3. 记录**黑洞时长**（`firstOK - firstFail`）。
**参照**（CL-020 I2 观察）：重启后隧道短暂黑洞 **~18s** 后自愈。黑洞 < 45s 视为正常；> 60s 记 **P2**。
> **实测备注（Run1，2026-09-23）**：三种触发对比 —— ① `server restart`（宿主 CLI）**抛错**（D7：`C:/Program Files/Git/end`）；② `schtasks //end` 与 `Stop-ScheduledTask` **未停服**（端口保持监听，无黑洞）；③ **杀端口属主进程**（EncodedCommand）才产生黑洞：`firstFail=3924ms → firstRecover=83207ms`，**黑洞 ≈79s**（`>60s`，按上参照记 **P2**）。恢复后 daemon pid **不变（300）**、`state=RUNNING`、`lastEvent=reconciled` → 判据 2 达成；判据 1 的 `DEGRADED` 自始未出现（daemon 全程 RUNNING，黑洞实际发生在 **VM 服务侧**而非隧道 daemon 重连）→ **§3.3 记 BLOCKED**（触发路径不可靠 + 语义偏离）。

---

## 4. 第三类：WorkBuddy 端各类型任务用例（重点）

### 4.0 字段说明与用例总览

**每条用例统一字段**：`ID | 域 | 通道(MCP/A2A) | 目的 | 前置 | 命令(可直接复制) | 期望结果 | 通过判据 | 清理`。
**通道**：`MCP` = 宿主 CLI `winvm-plugin.mjs command <tool>` 直调 VM `/mcp`；`A2A` = 经 `qa/probes/a2a.mjs` 驱动宿主 A2A 桥（`a2a.delegate` 等）委派 VM `/a2a`。

> **响应信封（实测，重要）**：`command <tool>` 的 JSON 是**统一信封** `{ traceId, ok, risk, data, durationMs, auditRef? }`，**能力载荷在 `data` 下**（**非**顶层）。
> 例：`meta.health.check` 的健康体在 `data.capabilities.count`；`storage.file.read` 在 `data.content`。
> 且**信封 `ok` 与能力 `data.ok` 是两层**：传输成功即信封 `ok:true`，能力本身失败时 `data.ok:false`（如 `appops.workflow.run` 未找到工作流 → 信封 `ok:true` 但 `data.ok:false` + `data.error.code`）。判据须**同时**看两层。
> **A2A 夹具限制**：`qa/probes/a2a.mjs` 对输出做 `.slice(0,4000)`（见其第 48 行），**含大载荷（截图 base64）的用例输出会被截断**（`structuredContent` 不可见）——以可见的 `content` 文本块与 `### <tool> <ms>` 行头判读即可，**不判 FAIL**。
**通用前置**（除特别说明）：`§1.3 快照已采集` ∧ `§2 部署完整性 PASS` ∧ `tunnel status = RUNNING` ∧ `health ok:true`。

**用例总览（共 25 条：MCP 22 / A2A 3）**

| ID | 域 | 通道 | 操作类型 | 目的（一句） |
|---|---|---|---|---|
| TC-SYS-01 | system | MCP | 查询 | 系统信息 |
| TC-SYS-02 | system | MCP | 查询 | 服务清单 |
| TC-SYS-03 | system | MCP | 查询 | 事件日志 |
| TC-SYS-04 | system | MCP | 审批门禁(L3 dry-run) | 电源控制免审批预览 |
| TC-APP-01 | app | MCP | 查询 | 已装应用清单 |
| TC-APP-02 | app | MCP | 查询 | winget 搜索 |
| TC-APP-03 | app | MCP | 启动 | 启动 notepad |
| TC-APP-04 | app | MCP | 文件/变更 | 快捷方式增查删 |
| TC-STO-01 | storage | MCP | 查询 | 磁盘/卷 |
| TC-STO-02 | storage | MCP | 文件写 | 创建目录+写文件 |
| TC-STO-03 | storage | MCP | 文件读 | 读回文件 |
| TC-STO-04 | storage | MCP | 文件删(审批闸 L2) | 删除（含审批续跑） |
| TC-GUI-01 | gui | MCP | 查询 | 会话健康 |
| TC-GUI-02 | gui | MCP | GUI | 截图 |
| TC-GUI-03 | gui | MCP | GUI | 窗口枚举 |
| TC-GUI-04 | gui | MCP | GUI | 等待条件 |
| TC-AOP-01 | appops | MCP | 查询 | 生产状态 *(保证实跑)* |
| TC-AOP-02 | appops | MCP | CLI | 调 node CLI *(保证实跑)* |
| TC-AOP-03 | appops | MCP | 工作流 | 运行登记工作流 *(条件执行：缺工作流→BLOCKED)* |
| TC-AOP-04 | appops | MCP | CLI(带参) | 参数透传验证 *(保证实跑)* |
| TC-MCP-01 | meta | MCP | 查询 | 健康快照（MCP 直调） |
| TC-MCP-02 | meta | MCP | 查询 | 能力清单（MCP 直调） |
| TC-A2A-01 | system+storage | A2A | 复杂委派(streaming) | 查信息并写摘要文件 |
| TC-A2A-02 | storage+appops | A2A | 复杂委派(streaming) | CLI 生成文件并压缩 |
| TC-A2A-03 | gui | A2A | 复杂委派(streaming) | 截图并描述桌面 |

> **统计**：system 4 · app 4 · storage 4 · gui 4 · appops 4 · meta(MCP) 2 · A2A 3 = **25**；通道 **MCP 22 / A2A 3**。
> **appops 域实跑保障（Q2 裁定）**：TC-AOP-03 依赖 VM 内已登记工作流，**缺则记 BLOCKED**；故 appops 域另有 **TC-AOP-01/02/04 三条无外部依赖的可执行用例**保证该域实跑覆盖 ≥1。

**QA 工作区约定**（所有文件类用例统一落此目录，便于清理与策略白名单命中）：

```
VM 工作区根：C:/WinVMWorkspace/qa-real-test/
本轮子目录：C:/WinVMWorkspace/qa-real-test/<YYYYMMDD-HHmm>/
```

> 策略依据：默认 `pathAllowlist` 含 `C:\WinVMWorkspace\**`、`C:\Users\**`、`C:\Temp\**`；`pathDenylist` 含 `C:\Windows\**` 等系统区（`packages/core/src/policy/defaults.ts`）。

---

### 4.1 `system` 域（4 条）

#### TC-SYS-01 · `system.info.get`（system｜MCP）
- **目的**：验证「宿主 → 隧道 → MCP → provider → PS 桥」全链路连通，返回**真实 VM** 系统信息。
- **前置**：隧道 RUNNING。
- **期望结果**：`ok:true`，`data` 含 `computerName` / `caption` / `architecture` / `cores` / `totalMemoryMB` / `isAdmin`。
- **通过判据**：输出 JSON `"ok": true` 且 `data.computerName` 非空、`durationMs` 为有限数值。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.info.get
```

#### TC-SYS-02 · `system.service.list`（system｜MCP）
- **目的**：验证列表类能力「保形为数组」（D10 不变量）。
- **前置**：同通用。
- **期望结果**：`ok:true`，`data` 为**数组**（非对象、非 `null`；空结果应为 `[]`）。
- **通过判据**：`Array.isArray(data)` 且 `data.length >= 10`（实测 99）；元素含 `name`/`displayName`/`status`/`startType` 字段。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.service.list --args '{"status":"Running"}'
```

#### TC-SYS-03 · `system.eventlog.query`（system｜MCP）
- **目的**：验证查询类能力在带参（日志名/上限）下正常收敛。
- **前置**：同通用。
- **期望结果**：`ok:true`，`data` 为数组（≤ `maxEvents`）。
- **通过判据**：`Array.isArray(data)`；每项含时间/级别/来源等键；无「未捕获异常」类错误码。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.eventlog.query --args '{"logName":"System","maxEvents":5,"level":"Error"}'
```

#### TC-SYS-04 · `system.power.control`（system｜MCP）—— 审批门禁类（L3 dry-run 免审批）
- **目的**：验证 **L3 高危能力在 `dryRun:true` 时免审批直接返回执行计划**（不改变系统状态）。
- **前置**：同通用。**严禁**去掉 `dryRun`（会真实重启 VM，不可逆）。
- **期望结果**：`ok:true`，`data.dryRun === true`，`data.plan` 含目标动作计划；**不产生**审批挂起。
- **通过判据**：`ok:true && data.dryRun===true && data.plan` 存在；输出**不含** `APPROVAL_REQUIRED`。
- **清理**：无（未执行任何变更）。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.power.control --args '{"action":"restart","dryRun":true}'
```

> 策略依据：`policy/engine.ts` 步骤 6 —— `risk >= L2 && !approved` 时，若 `params.dryRun === true` → `allow:dry-run-bypass`（免审批，但仍受路径/命令/注册表安全检查约束）。

---

### 4.2 `app` 域（4 条）

#### TC-APP-01 · `app.inventory.list`（app｜MCP）
- **目的**：验证注册表卸载键 + UWP 合并清单能力。
- **前置**：同通用。
- **期望结果**：`ok:true`，`data` 为数组。
- **通过判据**：`Array.isArray(data)` 且 `data.length >= 15`（参照基线 18–19）；元素含 `name`/`version`。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command app.inventory.list --args '{"includeUwp":false}'
```

#### TC-APP-02 · `app.winget.search`（app｜MCP）
- **目的**：验证 winget 查询通路与「不静默空」。
- **前置**：同通用。**注意**：winget 源可能冷启动，首轮 0 行属环境瞬时，静置 60s 复跑（见 INSTALL-VERIFY A17）。
- **期望结果**：`ok:true`，`data` 为数组。
- **通过判据**：`Array.isArray(data)` 且 `data.length >= 1`；命中项含 `7zip.7zip` 或 `7-Zip`（大小写不敏感）；脏 id 行为 0。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command app.winget.search --args '{"query":"7zip","limit":5}'
```

#### TC-APP-03 · `app.process.launch`（app｜MCP）—— 启动类
- **目的**：验证启动应用/打开文件能力（`Start-Process`）。
- **前置**：同通用。
- **期望结果**：`ok:true`，进程已启动。
- **通过判据**：`ok:true`；随后 `system.process.list --args '{"name":"notepad"}'` 能查到对应进程。
- **清理**：结束 notepad（避免残留）。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command app.process.launch --args '{"target":"notepad.exe"}'
# 复核
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.process.list --args '{"name":"notepad"}'
# 清理（L2，需审批，见 §4.3 审批续跑写法）：终结 notepad 进程树
# ⚠ 实测修正：system.process.terminate 入参是 processId（**非** name）——传 name 会 INVALID_PARAMS。
#   先取 pid，再两步审批：首调拿 approvalId → 带 __approvalId 续跑。
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.process.list --args '{"name":"notepad"}'   # 取其 processId（记 NPID）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.process.terminate --args '{"processId":<NPID>}'   # 首调 → APPROVAL_REQUIRED + approvalId
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.process.terminate --args '{"processId":<NPID>,"__approvalId":"<APR>"}'   # 续跑 → ok:true,terminated:true
```

#### TC-APP-04 · `app.shortcut.manage`（app｜MCP）—— 文件/变更类
- **目的**：验证 `.lnk` 快捷方式创建与读取（`WScript.Shell` COM）。
- **前置**：同通用；工作区目录已建（见 TC-STO-02）。
- **期望结果**：`ok:true`，`.lnk` 落盘。
- **通过判据**：创建返回 `ok:true`；读取回显的 `targetPath` 与传入一致。
- **清理**：删除该 `.lnk`（`storage.file.delete`，L2 审批）。
- **⚠ 目标路径须在白名单内（实测修正）**：`targetPath` 走**同一套路径策略**——`C:\Windows\**` 命中 `pathDenylist` 会返回 `POLICY_DENIED`。故目标改用工作区文件（白名单 `C:\WinVMWorkspace\**`），**不要**用 `C:/Windows/System32/notepad.exe`。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command app.shortcut.manage --args '{"path":"C:/WinVMWorkspace/qa-real-test/shortcut.lnk","targetPath":"C:/WinVMWorkspace/qa-real-test/note.txt"}'
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command app.shortcut.manage --args '{"path":"C:/WinVMWorkspace/qa-real-test/shortcut.lnk"}'
```

---

### 4.3 `storage` 域（4 条）

> 统一工作区：`C:/WinVMWorkspace/qa-real-test/`（默认 `pathAllowlist` 命中）。若需多轮隔离，可在路径中追加时间戳子目录，如 `.../qa-real-test/20260923-1430/note.txt`。

#### TC-STO-01 · `storage.disk.list`（storage｜MCP）
- **目的**：验证磁盘/分区/卷查询。
- **前置**：同通用。
- **期望结果**：`ok:true`，`data` 为**对象**（`{ disks, volumes }`），`includesVolumes:true` 时 `volumes` 为数组。
- **通过判据**：`ok:true`；`data.disks` / `data.volumes` 均为数组，且 `data.volumes.length >= 1`。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command storage.disk.list --args '{"includeVolumes":true}'
```

#### TC-STO-02 · `storage.file.write`（storage｜MCP）—— 文件写
- **目的**：验证目录创建（`createDirectory`）+ 写文件。
- **前置**：同通用。
- **期望结果**：`ok:true`，文件落盘，内容与写入一致。
- **通过判据**：`ok:true`；后续 TC-STO-03 能读回同样内容（含标记串）。
- **清理**：见 TC-STO-04。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command storage.file.write --args '{"path":"C:/WinVMWorkspace/qa-real-test/note.txt","content":"WINVM-QA-REAL-TEST\n","createDirectory":true}'
```

#### TC-STO-03 · `storage.file.read`（storage｜MCP）—— 文件读
- **目的**：验证读回（UTF-8），闭环 TC-STO-02。
- **前置**：TC-STO-02 PASS。
- **期望结果**：`ok:true`，`data` 内容含 `WINVM-QA-REAL-TEST`。
- **通过判据**：输出含标记串 `WINVM-QA-REAL-TEST`。
- **清理**：见 TC-STO-04。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command storage.file.read --args '{"path":"C:/WinVMWorkspace/qa-real-test/note.txt"}'
```

#### TC-STO-04 · `storage.file.delete`（storage｜MCP）—— 文件删 + **审批闸续跑**（L2）
- **目的**：验证 **L2 破坏性能力的两步审批流**：首次返回 `APPROVAL_REQUIRED + approvalId`，带 `__approvalId` 重发才真正执行（默认进回收站，可恢复）。
- **前置**：TC-STO-03 PASS；目标文件存在。
- **期望结果**：首调 `ok:false` + `error.code=="APPROVAL_REQUIRED"` + `approval.approvalId`；续跑后 `ok:true`。
- **通过判据**：① 首调返回审批挂起且带 `approvalId`；② 带 `__approvalId` 重发返回 `ok:true`；③ 默认**非永久删除**（不带 `permanent`）。
- **清理**：默认即入回收站（可恢复）；如需彻底清理可另用回收站能力，**不建议** `permanent:true`。

```bash
# ① 首次调用：应返回 APPROVAL_REQUIRED（不会删除）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command storage.file.delete --args '{"path":"C:/WinVMWorkspace/qa-real-test/note.txt"}'
# 从①输出中取出 approval.approvalId（记为 APR），再续跑（把 <APR> 替换为真实值）：
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command storage.file.delete --args '{"path":"C:/WinVMWorkspace/qa-real-test/note.txt","__approvalId":"<APR>"}'
```

> **dry-run 变体（可作免审批对照）**：`--args '{"path":"...","dryRun":true}'` 应返回计划且**不**要求审批。

---

### 4.4 `gui` 域（4 条）

> **前置（GUI 专属，务必先判定）**：执行时**实时**取 `gui.session.status` / `meta.session.status`：`session.state=="healthy"` ∧ `session.interactive==true` ∧ `locked==false` ∧ `blackScreen==false` ∧ Explorer 在跑。
> 若此刻变为 `locked`/黑屏/非交互会话 → 相关用例记 **BLOCKED**（环境门禁，非缺陷）；**不要**强行解锁或输入密码。启用方法见 `winvm-plugin health` 打印的 `printGuiRestart()` 命令块。
> **Q5 裁定（本轮）**：主理人实测当前 `locked=false`、`blackScreen=false`、`state=healthy` → 本域 4 条 + TC-A2A-03 **本轮按可执行处理**（仍以执行时实时取数为准）。

#### TC-GUI-01 · `gui.session.status`（gui｜MCP）
- **目的**：验证会话探针，产出 GUI 门禁依据。
- **前置**：同通用。
- **期望结果**：`ok:true`，含 `sessionId` / `windowStation`（应为 `WinSta0`）/ `desktop` / `interactive` / `locked`。
- **通过判据**：`ok:true`；`windowStation=="WinSta0"` 且 `interactive==true` 时，本域其余 GUI 用例方可判 `PASS`（否则 `BLOCKED`）。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command gui.session.status
```

#### TC-GUI-02 · `gui.screen.capture`（gui｜MCP）—— GUI 类
- **目的**：验证截图 + base64 回传。
- **前置**：TC-GUI-01 为 healthy/interactive。
- **期望结果**：`ok:true`，`data` 含 base64 PNG（或返回 artifact）。
- **通过判据**：`ok:true` 且存在图片载荷（base64 长度 > 1000）。
- **⚠ 载荷键位（实测修正）**：`data === { encoding:"base64", mimeType:"image/png", data:"<base64>", width, height, bytes, capturedAt }` —— base64 在 **`data.data`**，**不是** `data.base64`/`data.image`。判据用 `data.data.length > 1000`。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command gui.screen.capture --args '{"asBase64":true}'
```

#### TC-GUI-03 · `gui.window.list`（gui｜MCP）—— GUI 类
- **目的**：验证窗口枚举。
- **前置**：TC-GUI-01 为 healthy/interactive。
- **期望结果**：`ok:true`，`data` 为数组。
- **通过判据**：`Array.isArray(data)`；元素含 `title`/`handle`/`processId` 等。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command gui.window.list --args '{"visibleOnly":true}'
```

#### TC-GUI-04 · `gui.wait.condition`（gui｜MCP）—— GUI 类
- **目的**：验证轮询等待条件的正确收敛（含超时语义）。
- **前置**：TC-GUI-01 为 healthy/interactive。
- **期望结果**：对一个**已存在**窗口等待 `windowExists` 应在超时前返回 `ok:true`。
- **通过判据**：`ok:true` 且 `data.met===true`（在 `timeoutMs` 内命中）且耗时 < `timeoutMs`。
- **⚠ 窗口标题须实测存在（本地化，实测修正）**：原用 `"Program Manager"` 在中文系统**不存在**（桌面窗口标题被本地化），会 `met:false,timedOut:true`（仍属「有界不挂死」，但按原判据会误判 FAIL）。**先** `gui.window.list` 取真实标题（实测有 `设置`、`Windows PowerShell` 等）再填入。
- **清理**：无。

```bash
# 先取真实窗口标题（复制其一，如 "设置"）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command gui.window.list --args '{"visibleOnly":true}'
# 再等待该标题（示例用实测存在的 "设置"；10s 内应 met:true）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command gui.wait.condition --args '{"condition":"windowExists","windowTitle":"设置","timeoutMs":10000}'
```

---

### 4.5 `appops` 域（4 条）

> **前置**：`appops.*` 输出目录受 `pathAllowlist` 约束（默认 `C:\WinVMWorkspace`、`%USERPROFILE%\WinVMWorkspace`）。统一用 `C:/WinVMWorkspace/out`。
> **Q2 裁定**：TC-AOP-03 无工作流登记清单则记 `BLOCKED`（不判 FAIL）；appops 域实跑覆盖由 TC-AOP-01/02/04 保证。

#### TC-AOP-01 · `appops.state.query`（appops｜MCP）
- **目的**：验证生产上下文查询（运行中生产型应用 / 打开文档 / 活动窗口），并核对过滤名单透明性。
- **前置**：同通用。
- **期望结果**：`ok:true`，含 `count` / `apps` / `scannedAt` / `filteredCount` / `filtered` / `policy`。
- **通过判据**：`ok:true`；`count` 为整数；`filtered` 为数组（可能为空）；字段齐全。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command appops.state.query
```

#### TC-AOP-02 · `appops.cli.invoke`（appops｜MCP）—— CLI 类
- **目的**：验证调用应用自带 CLI（此处用 `node` 做无害探针）。
- **前置**：同通用。
- **期望结果**：`ok:true`，返回 `node -v` 版本串，`exitCode==0`。
- **通过判据**：`ok:true` 且输出含 `v` 版本号（如 `v24`）。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command appops.cli.invoke --args '{"app":"node","command":"node","arguments":"-v","workingDirectory":"C:/WinVMWorkspace/out"}'
```

#### TC-AOP-03 · `appops.workflow.run`（appops｜MCP）—— 工作流类 · 条件执行
- **目的**：验证运行 VM 内已登记的生产型工作流。
- **前置**：VM 工作区存在**已登记工作流**。执行轮先用**只读方式**尝试定位登记名（VM `C:/WinVMBridge` 下 appops 配置 / 约定清单）；**找不到就记 `BLOCKED`（原因：无可用登记工作流）**，**不判 FAIL**。
- **期望结果**：`ok:true`，产出落 `outputDirectory`。
- **通过判据**：`ok:true`；若工作流约定产物路径，产物存在。前置不满足 → `BLOCKED`。
- **清理**：删除本轮产物（`storage.file.delete`，L2 审批）。

```bash
# ① 先只读探测是否存在可用工作流登记文件（无则 BLOCKED，不执行）
cd "$REPO" && "$NODE" -e '
const {execFileSync}=require("child_process");
const rec="Get-ChildItem -Path C:/WinVMWorkspace,C:/WinVMBridge -Recurse -Depth 2 -Include *.workflow.json,workflows.json,appops*.json -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName";
const b64=Buffer.from(rec,"utf16le").toString("base64");
try{const o=execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2","powershell -NoProfile -EncodedCommand "+b64],{encoding:"utf8",timeout:90000}).trim();
  console.log("workflow registry:", o||"(无登记文件 → BLOCKED)");}catch(e){console.log("probe err:",e.message.slice(0,120))}
'
# ② 仅当①找到登记名时才执行（否则记 BLOCKED，勿执行）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command appops.workflow.run --args '{"workflow":"<登记的工作流名>","outputDirectory":"C:/WinVMWorkspace/out"}'
```
> **Run1 实测（2026-09-23）**：① 探测结果 **无任何工作流登记文件** → **TC-AOP-03 记 `BLOCKED`（无可用登记工作流）**；appops 域实跑覆盖由 TC-AOP-01/02/04 保证（本域 3 条实跑全 PASS）。

#### TC-AOP-04 · `appops.cli.invoke`（appops｜MCP）—— CLI 带参透传（保证实跑）
- **目的**：验证 CLI 调用**参数透传**正确性（无外部依赖、零副作用、无文件写入）。
- **前置**：同通用。
- **期望结果**：`ok:true`，返回 `node -p 6*7` 的计算结果 `42`。
- **通过判据**：`ok:true` 且输出含 `42`。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command appops.cli.invoke --args '{"app":"node","command":"node","arguments":"-p 6*7","workingDirectory":"C:/WinVMWorkspace/out"}'
```

---

### 4.6 MCP 直调通道专属用例（2 条）

> 用于**独立验证 `/mcp` 通道本身**（与业务语义解耦），并作为「通道可用性」的快速判据。

#### TC-MCP-01 · `meta.health.check`（meta｜MCP）
- **目的**：验证 MCP 直调最小闭环，且**不泄露系统敏感信息**。
- **前置**：隧道 RUNNING。
- **期望结果**：信封 `ok:true`；健康体在 **`data`** 下，键集含 `ok, provider, session, psBridge, capabilities, audit`（另有 `logging, cache, exposed, llmSession`），**不含** `computerName` 等系统敏感字段。
- **通过判据**：`ok:true`（信封）且 **`data.capabilities.count==54`**（**注意在 `data` 下**）；`data.ok===true`；**无**系统敏感字段（参照 INSTALL-VERIFY A6）。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command meta.health.check
# 精简判据（防信封/载荷两层混淆）：
cd "$REPO" && "$NODE" -e 'const{execFileSync}=require("child_process");const r=JSON.parse(execFileSync(process.env.NODE,["delivery/winvm-plugin.mjs","command","meta.health.check"],{cwd:process.env.REPO,encoding:"utf8"}));console.log("envOk="+r.ok,"dataOk="+r.data.ok,"count="+r.data.capabilities.count,"avail="+r.data.capabilities.available,"leak="+/computerName/.test(JSON.stringify(r)))'
```

#### TC-MCP-02 · `meta.capability.list`（meta｜MCP）
- **目的**：验证能力发现。
- **前置**：同通用。
- **期望结果**（R1·方案A 名实对齐后形态，2026-10-16 仓库面变更，现网生效=下次 deploy-vm+服务重启）：`ok:true`，`data.capabilities` 为能力条目数组（每条含 `id/name/risk`）、`data.count` 为条数、`data.domains` 为域前缀数组；**不再有** `data.modules`（旧模块面已退役为内部诊断面）。
- **通过判据**：`ok:true` 且 `data.count == 54` 且 `data.capabilities` 每条含 `id,risk`；能力 ID 集与 `tools/list` 逐条一致（同源注册表直供）；`data` 无 `modules` 键。
- **回退判据**（若现网仍是旧态=未随部署生效）：`data.modules` 为含 5 个域名的数组（`["app","appops","gui","storage","system"]`，不含 `meta`）⇒ 报告「Node 面未部署」，非缺陷。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command meta.capability.list
```

> **MCP 通道冒烟补充（可选）**：`cd "$REPO" && "$NODE" qa/probes/mcp.mjs --list`（应列出 54 个工具名）、
> `... list mcp-tools`（按域分组显示 54 项）。

---

### 4.7 A2A 委派通道用例（3 条，复杂任务 streaming）

> **驱动方式**：宿主 A2A 桥（`a2a-bridge/cli.js`）为 stdio MCP server，暴露 5 个工具 ——
> `a2a.health` / `a2a.delegate` / `a2a.task.get` / `a2a.approval.reply` / `a2a.task.cancel`。
> 用 `qa/probes/a2a.mjs` 驱动：`node qa/probes/a2a.mjs <tool> '<json-args>'`。
> **通道语义**：`a2a.delegate` 经 VM `/a2a` 以 streaming（SSE）委派自然语言目标给 VM 内 AI Agent；
> **首次委派冷启动 75–107s 属正常**（`WINVM_A2A_TIMEOUT_MS` 默认 600000，不得下调）。
>
> **本轮判据裁定（Q3，重要）**：本轮 A2A 用例一律按「**有界不挂死**」判 `PASS` —— 能起（桥可达、能建立委派）、能**流式回传进度**、在超时窗口内**有界结束**（正常结束，或返回 `A2A_DELEGATE_FAILED` / `timedOut:true` 均算「有界」）。
> 「**成功回收产物**」（`artifacts` 非空）为**严格判据，留待下一轮**。
> VM 侧 codebuddy LLM 停滞作为 **P1 已知问题**单列于报告（根因 + 现状），**不计入本轮 FAIL**。
>
> **⚠ A2A 产物落盘基目录（Run1 实测，OB-2 定因）**：A2A **委派侧**的输出基目录由 adapter 约定为
> **`%USERPROFILE%\WinVMWorkspace\out`**（即 `C:\Users\<user>\WinVMWorkspace\out`，见
> `packages/adapter-agent-workbuddy/src/index.ts:485`、`packages/core/src/config/index.ts:105`），
> **不是**用例里常见的 `C:\WinVMWorkspace\out`（后者是 **MCP 直调** `appops.cli.invoke` 的 `workingDirectory` 白名单项）。
> 两条路径**都在** `pathAllowlist`（`definitions.ts:249`）。故校核 A2A 产物请到 **`%USERPROFILE%\WinVMWorkspace\out`**；
> 若目标产物「找不到」，先按此基目录定位，**不要**直接判 FAIL（Run1 即因此把产物误记为「未落盘/无残留」，已修正）。
> ```bash
> # 定位 A2A 产物（真实基目录）
> "$NODE" -e '
> const {execFileSync}=require("child_process");
> const ps="$d=Join-Path $env:USERPROFILE \\"WinVMWorkspace\\out\\"; if(Test-Path $d){Get-ChildItem -Path $d -File | Select-Object -ExpandProperty FullName}else{Write-Output (\\"no \\"+$d)}";
> console.log(execFileSync("ssh",["-o","BatchMode=yes","User@172.16.100.2","powershell -NoProfile -EncodedCommand "+Buffer.from(ps,"utf16le").toString("base64")],{encoding:"utf8",timeout:60000}).trim())'
> ```

#### TC-A2A-01 · `a2a.health` + `a2a.delegate`（system+storage｜A2A）—— 简单委派闭环
- **目的**：验证 A2A 桥可达、Agent Card 与 5 技能声明正确；委派一个**系统查询**任务并回收结果。
- **前置**：隧道 RUNNING；`qa/probes/a2a.mjs` 的 `CLI` 路径指向已部署缓存根 `a2a-bridge/cli.js`。
- **期望结果**：`a2a.health` 返回 `ok:true` 且 `skills` 含 5 项（system-admin / app-manager / storage-manager / gui-automation / app-operation）；`a2a.delegate` 返回 `taskId`、进度事件与最终 `state`。
- **通过判据**：**本轮（宽松）**：`a2a.health.ok==true` 且技能数=5；`delegate` 在超时窗口内**有界结束**（`ok:true` 或 `A2A_DELEGATE_FAILED`/`timedOut:true` 均判 PASS，属已知冷启动/LLM 停滞窗口）。**下一轮（严格）**：`delegate.ok==true` 且 `state` 为终态成功。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" qa/probes/a2a.mjs --tools
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.health '{}'
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.delegate '{"goal":"查询这台 Windows 虚拟机的操作系统版本与可用内存，并用一句话汇总","maxRisk":"L1","timeoutMs":600000}'
# 若 delegate 返回 taskId，可跟踪：
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.task.get '{"taskId":"<TASKID>"}'
# F2 全通道复核：委派后再读 health，cache.netCfg.ageMs 应同样落入 TTL 窗口
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command system.network.config
cd "$REPO" && "$NODE" -e 'const{execFileSync}=require("child_process");const h=JSON.parse(execFileSync(process.env.NODE,["delivery/winvm-plugin.mjs","health"],{cwd:process.env.REPO,encoding:"utf8"}));console.log("netCfg:",JSON.stringify(h.cache.netCfg))'
```

#### TC-A2A-02 · `a2a.delegate`（storage+appops｜A2A）—— 多步生产委派
- **目的**：委派一个**跨域多步**目标（创建文件 → 压缩），验证 streaming 进度与产物回收。
- **前置**：同 TC-A2A-01；工作区存在。
- **期望结果**：`ok:true`，产出 artifact（zip），`progress` 有多条状态更新。
- **通过判据**：**本轮（宽松）**：有界结束（`ok:true` 或 `A2A_DELEGATE_FAILED`/`timedOut:true`）且 `progress.length >= 1`。**下一轮（严格）**：`ok:true` 且 `artifacts` 非空（或引用产物路径）。
- **清理**：删除 `C:/WinVMWorkspace/out` 下本轮产物（L2 审批）。

```bash
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.delegate '{"goal":"在 C:/WinVMWorkspace/out 下创建一个包含三行文本的 report.txt，然后用 storage.archive.manage 把它压缩为 report.zip，最后报告产物路径","allowedCapabilities":["storage.*","appops.*"],"maxRisk":"L1","timeoutMs":600000}'
```

#### TC-A2A-03 · `a2a.delegate`（gui｜A2A）—— GUI 生产委派
- **目的**：委派 GUI 相关目标（截图并描述），验证 GUI 能力在 A2A 通道上的可达性。
- **前置**：`session` healthy/interactive（否则记 `BLOCKED`）；同 TC-A2A-01。
- **期望结果**：`ok:true`，返回图片/文本产物。
- **通过判据**：**本轮（宽松）**：有界结束且 `progress.length >= 1`。**下一轮（严格）**：`ok:true` 且产物含图像或对桌面的文本描述。
- **清理**：无。

```bash
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.delegate '{"goal":"截取当前 Windows 桌面，并用一句话描述屏幕上主要可见内容","allowedCapabilities":["gui.*"],"maxRisk":"L1","timeoutMs":600000}'
```

> **审批闸 A2A 用例（可选）**：委派一个 L2 目标（如「删除工作区某文件」）时，应返回 `approval.approvalId` 与
> `resumeHint`；用 `a2a.approval.reply '{"taskId":"...","approvalId":"...","approved":false}'` 拒绝（演练 fail-closed），**不批准**。

---

## 5. 执行记录模板（每轮迭代一份）

> 复制以下模板，文件名建议 `qa/evidence/real-test-run<N>-<YYYYMMDD>.md`。每轮迭代填一份。

```markdown
# WinVM Bridge 真环境测试执行记录 · Run<N>

## 一、环境快照
- 日期时间：
- 宿主平台 / node：
- 仓库 HEAD / 关键文件 md5：
- VM 地址 / 服务端口：
- 隧道状态（state/pid/alive/端口）：
- /health 摘要（provider/session/psBridge/capabilities/audit/exposed/cache.netCfg）：
- vm-conn.json 是否含 identityFile（I1）：

## 二、第一类 · 部署完整性
| 检查项 | 结果 | 证据 |
|---|---|---|
| 宿主缓存根 4 文件 + a2a-bridge 与仓库一致 | | |
| .winvm-context.json == host | | |
| VM 关键 dist 字节一致 | | |
| 计划任务 WinVMBridge.Service 存在 | | |
| 双触发 BootTrigger + LogonTrigger enabled | | |
| 隧道 state/pid/监听 三一致 | | |

## 三、第二类 · 健康性
| 检查项 | 结果 | 证据（数值） |
|---|---|---|
| /health 全绿（ok/54/chainValid/ready） | | |
| F2 懒刷新（BEFORE→AFTER ageMs） | | BEFORE=____ms AFTER=____ms |
| 隧道自愈（黑洞时长 / 恢复判据） | | 黑洞=____s |

## 四、第三类 · 用例逐条结果
| ID | 域 | 通道 | 结果(PASS/FAIL/BLOCKED/SKIP) | 关键证据 / 错误码 | 备注 |
|---|---|---|---|---|---|
| TC-SYS-01 | system | MCP | | | |
| ...（25 条全列） | | | | | |

## 五、通过率
- 用例总数：25（MCP 22 / A2A 3）
- PASS：__ | FAIL：__ | BLOCKED：__ | SKIP：__
- 部署完整性：__/6 | 健康性：__/3
- 综合通过率：__%

## 六、缺陷清单（每条含：编号/严重度/现象/根因/证据/路由/状态）
| 编号 | 严重度 | 现象 | 根因 | 证据 | 路由 | 状态 |
|---|---|---|---|---|---|---|
| (P1 已知) A2A LLM 停滞 | P1 | A2A 委派走 LLM 路径超时/停滞 | VM 侧 codebuddy 会话停滞（见 INSTALL-VERIFY A5） | | 工程师/VM 侧 | 已知，本轮不计 FAIL |

## 七、结论与下一轮动作
- 结论：
- 建议版本：
- 待修复项（送工程师）/ 自修项（QA）/ 观察项：
```

---

## 6. 缺陷分级标准 · 智能路由 · 收敛规则

### 6.1 缺陷分级（P0 / P1 / P2）

| 级别 | 定义 | 典型示例 | 处置时限 |
|---|---|---|---|
| **P0（阻断）** | 核心链路不可用或运行态与源码不一致，导致功能整体不可信 | 隧道不通 / `/health.ok != true` / `capabilities.count != available` / VM dist 与仓库 `DIFF` / 审计链断裂 / SSH 隧道后 VM 端口未监听 | 立即修，当前轮必闭 |
| **P1（严重）** | 主功能可用但存在明确功能缺陷或验收不达标 | `command <tool>` 报凭证错误（CL-020 B4 类）/ F2 刷新后 `ageMs` 未落入 TTL / 关键用例 FAIL / 审批闸未拦截 L2 | 当轮或次轮修复 |
| **P2（一般/观察）** | 不阻断使用，但影响体验/稳健性/可维护性 | 隧道自愈黑洞 > 60s / `psBridge.degraded` 短超时 / `vm-conn.json` 缺 `identityFile`（I1）/ 文案歧义 | 记录并排期 |

> 归因红线：**先判归属再动手**。锁屏 → `degraded`、RDP 会话 env 陈旧、SSH 下回收站不可见、winget 冷启动 0 行等均为**环境现象**，应记 `BLOCKED`/`SKIP` 或环境项，**不得**当作产品缺陷改出真 bug。

### 6.2 智能路由（缺陷归属 → 处置方）

| 判据 | 归属 | 路由 |
|---|---|---|
| 断言/判据符合 PRD/设计/契约，但产品输出错误 | **源码缺陷** | → **工程师（Alex / software-engineer）**：附失败用例、期望 vs 实际、源文件与函数、错误码/堆栈 |
| 源码行为正确（符合契约），但对应用例断言写错/前置缺失/路径写错 | **用例或脚本缺陷** | → **QA 自修**（改本方案或夹具，不计产品缺陷） |
| 环境不满足（锁屏、无工作流、winget 冷启动、探针未分发） | **环境/夹具基础设施** | 记 `BLOCKED`/`SKIP` 或环境项；夹具缺口报交付侧补分发布步骤 |
| 部署期产物与仓库不一致 | **部署缺陷（P0）** | → 工程师 + 交付：重新投放并复验字节一致 |

### 6.3 收敛规则（**最多 2 轮**）

```
Round 1：执行本方案 → 采集证据 → 分析 → 路由
  ├─ 全 PASS → 出「成功报告」，结束
  ├─ 源码缺陷 → 出缺陷报告给工程师，等修复
  └─ 用例/脚本缺陷 → QA 自修（Round 1 即完成）
Round 2：回归（工程师已修 / QA 已自修）
  ├─ 全 PASS → 出「成功报告」，结束
  └─ 仍有失败 → **立即结束**，将剩余问题全部登记为「Known Issues」，不再进入第 3 轮
```

**硬约束**：2 轮为上限。长循环是交付延迟的第一大来源；剩余边界问题**文档化**而非无限调试。

---

## 7. 附录

### 7.1 命令速查

```bash
# —— 宿主管理 CLI ——
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs help
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs check                    # 本侧部署完整性
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs health                   # /health（经 SSH）
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs list mcp-tools           # 54 项能力/工具
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs list skills|mcp-servers|dirs [--json]
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs server start|status|stop|restart
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs command <tool> [--args '<json>']
cd "$REPO" && "$NODE" delivery/winvm-plugin.mjs tunnel start|ensure|status|stop [--json] [--force]

# —— 双端部署编排（本方案不执行，仅备查）——
cd "$REPO" && "$NODE" delivery/setup.mjs                    # 预览（dry-run）
cd "$REPO" && "$NODE" delivery/setup.mjs --apply            # 真执行（唯一入口）
cd "$REPO" && "$NODE" delivery/setup.mjs --apply --only-host   # 仅宿主侧
cd "$REPO" && "$NODE" delivery/setup.mjs --apply --only-vm     # 仅 VM 侧
cd "$REPO" && "$NODE" delivery/setup.mjs --apply --phase QA-PROBE   # 单相位（补推 QA 探针）

# —— 通道冒烟夹具 ——
cd "$REPO" && "$NODE" qa/probes/mcp.mjs --list
cd "$REPO" && "$NODE" qa/probes/mcp.mjs <capability> '<json-args>'
cd "$REPO" && "$NODE" qa/probes/a2a.mjs --tools
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.health '{}'
cd "$REPO" && "$NODE" qa/probes/a2a.mjs a2a.delegate '{"goal":"...","maxRisk":"L1"}'

# —— 全量验收夹具（可选，历史 A1–A18）——
cd "$REPO" && "$NODE" qa/probes/qa-verify.mjs
```

### 7.2 环境雷区（务必遵守）

| 雷区 | 规避 |
|---|---|
| `getcwd` 偶发异常 | 一律用绝对路径或 `cd "$REPO" &&` |
| `/tmp` 只读 | 临时文件落仓库内或 `~/.workbuddy/winvm/` |
| `rm` shim 坏 | 删文件用 `node -e "require('fs').unlinkSync(p)"` |
| Grep 对 `.mjs`/`.ts` 漏匹配 | 改用 Read 或 Node 逐行扫描 |
| `md5sum` 可能缺失 | 用 Node `crypto` 计算（本方案已采用） |
| 本地 curl 经隧道不通 | 加 `--noproxy 127.0.0.1` 或用 `localhost` |
| winget 冷启动 0 行 | 静置 60s 复跑，勿判为解析缺陷 |
| 锁屏 / 非交互会话 | GUI 用例记 `BLOCKED`，按 `health` 提示的 `printGuiRestart()` 启用 |

### 7.3 关键路径索引（真机运行态真相源）

| 对象 | 路径 |
|---|---|
| 宿主插件缓存根 | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` |
| 隧道 pidfile / 状态 / 日志 | `~/.workbuddy/winvm/tunnel.pid` · `tunnel.state.json` · `tunnel.log` |
| 宿主 VM 连接配置 | `~/.workbuddy/winvm/vm-conn.json` |
| VM 部署根 | `C:/WinVMBridge/` |
| VM 服务入口 / 运行配置 | `C:/WinVMBridge/packages/vm-service/dist/cli.js` · `delivery/.generated/vm-service.runtime.json` |
| VM 计划任务 | `WinVMBridge.Service` |
| 共享 Skills | `C:/WinVMBridge/shared-skills` |

### 7.4 能力域统计（54 项，来源 `packages/vm-capabilities/src/registry/definitions.ts`）

| 域 | 数量 | 代表能力 |
|---|---|---|
| meta | 3 | `meta.health.check` / `meta.capability.list` / `meta.session.status` |
| system | 14 | `system.info.get` / `system.service.list` / `system.eventlog.query` / `system.power.control` |
| app | 8 | `app.inventory.list` / `app.winget.search` / `app.process.launch` / `app.shortcut.manage` |
| storage | 13 | `storage.disk.list` / `storage.file.*` / `storage.search.query` / `storage.archive.manage` |
| gui | 11 | `gui.session.status` / `gui.screen.capture` / `gui.window.list` / `gui.wait.condition` |
| appops | 5 | `appops.state.query` / `appops.cli.invoke` / `appops.workflow.run` |
| **合计** | **54** | 5 大能力域 + 元能力 |

---

---

## 8. 方案自验记录（命令可用性预检）

> 目的：在正式执行轮之前，证明本方案的**只读命令**均可「原样复制运行」。本节只读、无 VM 写、不改仓库（约束遵守）。

**自验时间**：2026-09-23 · **执行人**：QA（Edward） · **环境**：`openharmony v24.13.0`

| 命令（章节） | 结果 | 备注 |
|---|---|---|
| §1.3 环境快照 4 条 | ✅ 原样可用 | `vm-conn.json` 当前**无** `identityFile`（I1 待重投落盘） |
| §2.1 md5 比对脚本（Node crypto） | ✅ 原样可用 | 正确报 `winvm-plugin.mjs` DIFF（Q1：仓库已前进/运行态未重投，非缺陷） |
| §2.1 上下文校验 | ✅ 原样可用 | `{"side":"host"}` |
| §2.3 `tunnel status --json` + 端口探测 | ✅ 原样可用 | `RUNNING`、`healthy:true`、18443 `LISTENING` |
| §2.3 陈旧态取证命令 | ✅ 原样可用 | 实测暴露 `state.json` 陈旧（见下「观察项 A」） |
| §3.1 `/health` 全量 | ✅ 原样可用 | `ok:true`、54/54、`chainValid:true`、provider/session/psBridge ready |
| §3.2 F2 BEFORE 取数（不触发刷新） | ✅ 原样可用 | `{"cached":true,"ageMs":7468940,"ttlMs":45000}`（陈旧，符合预期） |
| §4.1 TC-SYS-01 `system.info.get` | ✅ 原样可用 | `ok:true`，5793ms，`data.computerName` 非空 |
| §4.1 TC-SYS-02 `system.service.list` | ✅ 原样可用 | `ok:true`，`data` array[99] |
| §4.1 TC-SYS-03 `system.eventlog.query` | ✅ 原样可用 | `ok:true`，array[5] |
| §4.3 TC-STO-01 `storage.disk.list` | ✅ 原样可用 | `ok:true`，`data={disks,volumes}` |
| §4.4 TC-GUI-01 `gui.session.status` | ✅ 原样可用 | `ok:true`，含 sessionId/windowStation/…/state |
| §4.2 TC-APP-01 `app.inventory.list` | ✅ 原样可用 | `ok:true`，array[23] |
| §4.6 TC-MCP-01 `meta.health.check` | ✅ 原样可用 | `ok:true`，键集含 logging/cache/exposed |
| §4.6 TC-MCP-02 `meta.capability.list` | ✅ 原样可用 | `ok:true`，`data.modules=["app","appops","gui","storage","system"]` |

**结论**：上述 **15 条命令全部原样可用**，无一条需修正命令本体。

**因自验修订的判据（命令正确，仅精化判据）**：
1. §4.6 TC-MCP-02：判据由「能力数与 exposed 一致」修正为「`data.modules` 为 5 域名数组（不含 meta）」——实测返回的是**域名单**而非能力清单。
2. §4.6 TC-MCP-01：判据键集修正为「含 ok/provider/session/psBridge/capabilities/audit，另有 logging/cache/exposed」。
3. §4.3 TC-STO-01：判据修正为「`data.disks`/`data.volumes` 为数组且 `volumes.length>=1`」——实测 `data` 为**对象**。
4. §4.2 TC-SYS-02：判据补充实测元素键 `name/displayName/status/startType`。
5. §2.3：新增「`state.pid` 存活交叉校验」+ 陈旧态取证命令（源于观察项 A）。

**观察项 A（运行时，非本方案缺陷；供团队研判）**：
- 现象：`tunnel.state.json` 的 `pid=58555`（**已死**，`alive:true` 为**陈旧**残留），而 `tunnel.pid` 的 `pid=300`（存活），`tunnel status` 报 `RUNNING` 且 18443 正常监听。
- 影响：**隧道本身可用**（实际由 pid 300 承载）；风险在 `state.json` 可能残留陈旧 `alive:true`，以及 `readTunnelStatus` 以 pidfile 的 pid 判活（若 pid 被系统复用，可能「假 RUNNING」）。
- 定性：**P2**（状态文件陈旧），潜在 P2（pid 判活健壮性）；**非**隧道不可用。
- 待执行轮复测确认（重投部署后 `tunnel.state.json` 与 `tunnel.pid` 应一致）。
- **执行轮（Run1）复测**：`tunnel.state.json` 已**和解**为 `pid=300 / alive=true / lastEvent=reconciled`，与 pidfile **一致** → 症状本轮未复现；隐患仍在（`statePath` 硬编码），见报告 **D6（P1）**。

---

## 9. 执行记录（Run 归档）

| 轮次 | 日期 | 报告 | 结论 |
|---|---|---|---|
| Run1 | 2026-09-23 | [`docs/test/reports/real-test-2026-09-23.md`](reports/real-test-2026-09-23.md) | 25 用例 24 PASS / 1 BLOCKED / 0 FAIL；部署 5/6；健康 2 PASS+1 BLOCKED；**新缺陷 D7、D8**；需第 2 轮窄回归 |

---

*本文档为方案（执行细则）+ 命令预检；真机执行证据在后续迭代的 `docs/test/reports/real-test-<date>.md` 中归档。*
