# 彻底卸载 → 从零部署 演练报告（2026-11-18 ~ 11-19）

> 目标：按 `winvm-plugin-deploy` 技能指引，验证「卸载彻底（含 sshd 与密钥）」与「从零部署」两条路径。
> 要求：逐节点记时长与问题，问题给根因与处置，最后总结完善技能。
>
> **状态（2026-11-19 17:0x 定稿）**：
> **阶段 A（卸载到裸机）✅** · **阶段 B（通道重建）✅** · **阶段 C（从零部署 1→5）✅**
> —— V1.4.34 全链真机 PASS（第 4 步 245s / 第 5 步 33s `VERIFY=PASS`），
> 暴露并修完 **P1~P18** 共 18 项缺陷。其中 **P14/P15/P16/P18 是同一族**：
> 「活干对了、报告说错了」的**判据面缺陷**（假红 / 歧义 / 自伤 / 假绿混在失败行里）。
> **未做**：V1.4.34（母项目）与技能 v2.5.5 的发布 —— 见 §7 待办 1。

---

## 0. 口径

| 项 | 值 |
|---|---|
| 宿主 | 鸿蒙 WorkBuddy 沙箱（uid 20020171） |
| VM | `172.16.100.2`，用户 `User` |
| 技能 | `winvm-plugin-deploy`（演练起点 v2.4.0 → 暴露缺口升 **v2.5.0** → 补 P12/P13 升 v2.5.3 → 补 P14/P15 排错表升 **v2.5.4**） |
| 母项目包根 | 首跑 `~/wbtmp/rel-v1433/V1.4.33/overall`；**验收用 `~/wbtmp/overall-root/overall` = V1.4.34**（`commit b173cbf`，overall 1029 文件 / sha256 `52b0908e…`） |
| 「彻底」的定义 | winvm 程序/服务/任务/工作区 + agent-browser + agent-desktop + codebuddy + node 运行时（`C:\nodejs` 与 nvm）+ OpenSSH MSI + `C:\Program Files\OpenSSH` + `C:\ProgramData\ssh`（含两处 `authorized_keys`）+ VM 侧 `~/.ssh` + `C:\ProgramData\WinVMDeploy` |

---

## 1. 卸载前基线（只读探查，2026-11-18 18:3x）

| 组件 | 位置 / 形态 | 体积 |
|---|---|---|
| sshd | **手工 MSI 安装**（非 Windows 可选功能：`SSHD_CAPABILITY=NotPresent`），`C:\Program Files\OpenSSH`，v10.4.0 | 6.7 MB（MSI 缓存） |
| node | `C:\nodejs` v24.21.0（+ nvm 存储） | 171.1 MB + 416.8 MB |
| codebuddy | `@tencent-ai/codebuddy-code@2.176.0`，装在 **nvm 的 node 目录** | — |
| agent-browser / agent-desktop | 在 `C:\nodejs\node_modules`（`npm root -g`） | — |
| WinVM Bridge | `C:\WinVMBridge` 3.5 MB / `C:\WinVMWorkspace` 0.2 MB | — |
| `authorized_keys` | **两处各 1 行，同一把钥**（注释 `workbuddy-hos-winvm-tunnel`）：`C:\ProgramData\ssh\administrators_authorized_keys` + `C:\Users\User\.ssh\authorized_keys` | — |
| 远程入口 | **RDP 禁用**（`fDenyTSConnections=1`）；445 关闭；**WinRM 5985 在听但仅 Negotiate（Basic 关闭）** | — |

> 这条基线决定了整轮的硬约束：**sshd 一旦卸掉，没有任何「无凭据的带外入口」能重新进入 VM**。

---

## 2. 阶段 A：技能原生 undeploy（`--purge-workspace --remove-ssh-tunnel yes`）

**结果 `UNDEPLOY=PASS`，WALL 86s。**

| 环节 | 耗时 | 判据输出 |
|---|---|---|
| 1a 停隧道 | 2s | PASS |
| 1b 卸宿主插件 | 3s | PASS |
| 2a 通道状态 | 1s | PASS（`channel=READY`） |
| 2b 推卸载脚本 | 3s | PASS |
| 2c 停服务 + 卸模块 + 卸上游 | **42s** | PASS，`UPSTREAM_LEFT=NONE` |
| 2d VM 终态五点 | 11s | `False False 0 Running False NONE`（程序/任务/端口/工作区全清；`sshd=Running` 属预期） |
| 3a 通道判定 | 1s | `READY` → 走 SYSTEM 任务 |
| 3b SYSTEM Rollback | 26s | `POST_ROLLBACK_SCHEDULED` |

**通道实测**：执行后 `22:TIMEOUT 18443:TIMEOUT 5985:OPEN` ⇒ Rollback 确实执行了（不是假绿）。

### 2.1 但「彻底」只做到了三分之一

| 用户要求清理的 | 原生 undeploy 是否覆盖 |
|---|---|
| winvm（程序/服务/任务/工作区/上游 CLI） | ✅ 2c |
| agent-desktop / agent-browser | ✅ 2c 段 8 |
| **node 运行时**（`C:\nodejs` + nvm） | ❌ 无 |
| **codebuddy** | ❌ 无 |
| **sshd + OpenSSH MSI** | ❌ 无（`2d` 只读取状态不判断） |
| **两处 authorized_keys + VM 侧 `~/.ssh`** | ❌ 无（`-Rollback` 只还原它自己配的那一层，`C:\ProgramData\ssh` 整目录仍在） |
| `C:\ProgramData\WinVMDeploy` | ❌ 无 |

---

## 3. 问题清单（现象 / 根因 / 证据 / 处置）

### P1｜卸载能力有结构性缺口，且顺序错误就永久失联（最高）

- **现象**：`--remove-ssh-tunnel yes` 一执行完通道就断，而 node/codebuddy/sshd/密钥/WinVMDeploy 全都还在。通道一断，这些**再没有任何自动化入口**。
- **根因**：现有 undeploy 的能力边界只到「本项目组件」，把「运行时依赖」和「sshd 本身」当成宿主机资产；而拆通道又是第 3 步的最后动作，顺序上把「还能操作的窗口」提前关掉了。
- **证据**：阶段 A 跑完后 `22:TIMEOUT`，而基线里 node/nvm/codebuddy/OpenSSH 目录与两处 `authorized_keys` 仍然存在（见 §1）。
- **处置（v2.5.0 已实现）**：新增 `--purge-all`，把动作按「是否自断会话」分成两段：
  - **2e 运行时深清**（通道仍在时做）：`vm-purge-runtime.ps1` 删 `C:\nodejs` + nvm、codebuddy 包与 shim、VM 侧 `~/.ssh` 六个文件、npm 缓存、死 PATH、残留任务与防火墙；带 `-KeepWinVMDeploy` 保留 `C:\ProgramData\WinVMDeploy`。
  - **3b 同一次 SYSTEM 任务**（拆通道时做）：任务改挂临时 wrapper，先 `oneclick -Rollback`，再 `vm-purge-sshd.ps1` 停/删 sshd 服务、卸 MSI（product code **从注册表解析**，不硬编码）、删三个程序/配置目录（含两处 `authorized_keys`）、防火墙，最后删 WinVMDeploy；证据写 `C:\ProgramData\winvm-purge-sshd.log`。
  - `--purge-all` **强制** `--remove-ssh-tunnel yes`（sshd 只能在那个 SYSTEM 任务里卸，不拆就等于「sshd 留着」的半个彻底）。
- **门禁**：`purge-all` 27 项结构与 41 条变异全绿；其中 M41 专门锁「2e 里不许调 purge-sshd」（会杀掉执行它的会话）。

### P2｜3b 的 `/ST 00:00` 是过去时刻

- **现象**：日志出现 `因为 /ST 在当前时间，任务可能无法运行`。本次靠紧跟的 `/Run` 救回。
- **根因**：`schtasks /Create /SC ONCE /ST 00:00` 用了已过去的时刻；`/Run` 一旦失败，任务**永远不会自己触发**，且没有任何报错 —— 属「静默不执行」。
- **处置**：改为 `(Get-Date).AddMinutes(10).ToString('HH:mm')`，永远在未来，`/Run` 仍是实际触发手段。

### P3｜`1b.1` 指纹前缀重复

- **现象**：输出 `pub=sha256:SHA256:74Ke…`。
- **根因**：`ssh-keygen -lf` 的 `$2` 本身已带 `SHA256:`，代码又手写了一层 `sha256:`。
- **处置**：改为 `pub=${PUB_FP:-unknown}`，不再手写前缀。

### P4｜`PKG_ROOT` 指向旧包会让「新代码不在执行路径」

- **现象**：第一轮 `--only 4` 的 4c 拿到 `browser_tools=` 空值；4a 日志里根本没有 DB-7 行。
- **根因**：`PKG_ROOT` 仍是 V1.4.31 的发布包，技能调的 `delivery/bootstrap.mjs` 与 `qa/deploy-probes/vmcheck.ps1` 都是旧版。
- **处置（流程性）**：验证前必须核对包根版本；本次本地打 V1.4.33 到 `~/wbtmp/rel-v1433` 并覆盖后才验到真结果。

### P5｜新包根缺 `.env` 会导致 4b「假绿 0s PASS」

- **现象**：4b 报 `rc=0`、耗时 0s、PASS，但 VM 上仍是旧版（4c 读到旧白名单 `desktop_tools=10`）。
- **根因**：包根只有 `.env.example`，其 `WINVM_DRY_RUN=1` 兜底**优先于 `--apply`** ⇒ setup 只规划不执行。
- **处置**：4b 加闸，检测到 `DRY-RUN 只规划` 直接 FAIL 并给出「复制 `.env` 且 `WINVM_DRY_RUN=0`」。反向验证：同一场景由「0s PASS」变「1s FAIL + 根因 + 处置」。

### P6｜`vmcheck.ps1` 必须 ASCII-only

- **现象**：加了中文注释后 `ps-run.sh` 直接 `exit 3`。
- **根因**：该文件头写明 Keep ASCII-only，`ps-run.sh` 有硬闸；载荷脚本一律 ASCII。
- **处置**：注释改英文，`bytes>127 = 0` 已纳入门禁（`purge-all` 断言同时检查两个新 ps1 的 ASCII 与无 BOM）。

### P7｜`--only` 路径把 `rc=2` 误标成 `UNDEPLOY=FAIL`

- **现象**：`undeploy.sh --only 3 --purge-all`（通道 DOWN）输出 `UNDEPLOY=FAIL rc=2`，但实际是 `WAIT_USER`（等用户粘命令），属正常中间态。
- **根因**：`--only` 分支只设 `PENDING=1` 没归零 `RC`，后面的 `if [ $RC -ne 0 ]` 先命中并报 FAIL，`elif [ $PENDING -eq 1 ]` 的分支永远到不了。全链路径有归零，所以只有 `--only` 中招。
- **处置**：`--only` 分支改成 `[ $RC -eq 2 ] && { PENDING=1; RC=0; }`；复验同一条命令输出 `UNDEPLOY=PENDING_USER`。门禁 M42 用「`PENDING=1; RC=0; }\nelse`」这个唯一后缀锚定（`--only` 分支 2 空格缩进 vs 全链 4 空格，直接子串匹配会 count=2）。

### P8｜`--purge-sshd` 且通道已断时，用户命令不包含 sshd 清理

- **现象**：`--only 3 --purge-all` 的兜底命令只有 `-Rollback`。用户跑完通道照旧不回来（sshd 服务还在但钥已删），而技能这边再无入口补「卸 sshd」那一段。
- **处置**：命令改为自包含三段 —— 内联 base64 写出 `vm-purge-sshd.ps1` → 若 oneclick 脚本仍在则 `-Rollback` → `-Apply` 卸 sshd/删两处 `authorized_keys`/删 WinVMDeploy。已真机打印验证（base64 完整、`$d`/`$p`/`$rb` 变量未被吞）。

### P9｜`-File` 执行 oneclick 必挂：源文件「必须无 BOM」与副本「必须有 BOM」被混淆（P0）

- **现象**（用户从零部署粘第一条命令，2026-11-18 19:1x）：
  ```
  At C:\ProgramData\WinVMDeploy\winvm-sshd-oneclick.ps1:70 char:24
  + [switch]$NoSelfFetch,   # irm|iex 妯″紡涓嬬姝㈣仈缃戣嚜涓嬭浇...
  Missing expression after ','.
  Unexpected token '锛?' in expression or statement.
  ```
  满屏红字，**脚本一行都没有执行**。
- **根因**：两条相反的编码契约被当成一件事。
  - `winvm-sshd-oneclick.ps1` **源文件**必须 UTF-8 **无 BOM**：`irm|iex` / `[scriptblock]::Create(<文本>)` 会把 BOM 当首字符，`param` 块因此脱离参数区 ⇒「意外的属性 CmdletBinding」（M21 一直在守这条）。
  - 但 `powershell -File` 在 **Windows PowerShell 5.1 上不认 UTF-8 声明**，对无 BOM 文件按系统 ANSI（中文环境 CP936）解码 ⇒ 中文注释/文案变乱码 ⇒ 乱码里的 `?` 打断引号配对 ⇒ `ParserError`，整个文件解析失败。
  - 之前几轮用的是「整段粘贴」或 `irm|iex`（文本已是 unicode 字符串），只有 `-File` 这条路会崩；而 `-File` 恰恰是 SKILL.md 的第一条推荐命令。
- **证据**：raw 下载源首 3 字节 `3c230a`；归一化后 `efbbbf`，字节数 156457 → 156460（离线实测）。
- **处置**（v2.5.1，双向闭合，四条路径全覆盖）：
  1. oneclick 自落盘后立刻把副本重写成 UTF-8 with BOM（`copy`/`existing`/`fetch` 三态统一）⇒ 之后任何 `-File`（`-Rollback`、SYSTEM 计划任务、用户手工命令）都能解析；
  2. `1c` 主命令 / `1p` 兜底 / `3b` 用户命令 / `3b` purge 兜底命令，全部在「下载 → 执行」之间插 `ReadAllText(UTF8)` → `WriteAllText(UTF8Encoding($true))`；
  3. `3b` SYSTEM 任务在 `-File` 前归一化并回执 `BOM_NORMALIZED`；
  4. 新门禁 `bom-contract`（checks 27→28）+ M43/M44/M45 变异。
- **通用教训**：「源文件编码」和「执行副本编码」是两个独立契约，必须按**执行路径**分别满足，不能一个策略走全链。

### P10｜2e 只清两处 node 运行时，漏了 `%LOCALAPPDATA%\nodejs`（第三个 store）

- **现象**：`undeploy --purge-all` 的 2e 报 `FAIL 深清后仍残留: CMD_NODE#...nvm\installs\v24.21.0\node.exe CMD_NPM#...Local\nodejs\npm.ps1 NVM_DIR`。
- **根因**：跑过 nvm-windows 的机器上有**三个** node 运行时 store，脚本只列了两个：
  | 路径 | 来源 | 原脚本 |
  |---|---|---|
  | `C:\nodejs` | 独立 MSI 式安装 | ✅ 清了 |
  | `%LOCALAPPDATA%\Author Software\nvm` | nvm 根（`installs\<ver>`、`.nodejs`、settings） | ✅ 清了 |
  | `%LOCALAPPDATA%\nodejs` | 用户级 zip 安装（npm 前缀在此） | ❌ **漏了** |
- **证据**：2e 日志 `NODEJS_DIR=False` / `NVM_DIR=True` 同时出现，且 `CMD_NPM` 解析到 `...\Local\nodejs\npm.ps1`。
- **处置**：补第三处 → `RmTree $LocalNodeDir 'DELETE_LOCAL_NODEJS'`，PRE/POST 各加 `LOCAL_NODEJS_DIR` 断言，`undeploy-2-vm.sh` 的终态判据同步加一条。
- **教训**：**「清完还残留」先怀疑清单不全，再怀疑删不掉** —— 这一步把两个不同故障（清单漏项 vs 句柄占用）分开了，否则会一直在文件锁上打转。

### P11｜僵尸 `node.exe` 的镜像永不可删，`--purge-all` 会永久卡在 FAIL

- **现象**：补完清单后仍 `LEFT_DELETE_NVM=True`，`Remove-Item` 报「对路径 node.exe 的访问被拒绝」，`rmdir` 静默失败。
- **根因链**（逐层排除得到的结论，不是猜的）：
  1. ACL 正常（`BUILTIN\Administrators` + `User` 都是 FullControl，`takeown`+`icacls /reset` 后仍失败）；
  2. 不是普通句柄占用 —— `[IO.File]::Open(...,'None')` 报「正由另一进程使用」（确实被占）；
  3. **Restart Manager 定位到 pid 6048**，命令行是 `codebuddy mcp remove agent-desktop`（**部署脚本自己拉起的**，忘了回收）；
  4. 6048 是**僵尸**：`Get-Process` 显示 `HasExited=True`，但父进程 `cmd.exe`(session 0) 从不关闭句柄 ⇒ `Terminate` 返回 **rc=2**、`taskkill` 报「没有此进程的实例在运行」；连它的父 `cmd.exe`/`powershell` 也杀不掉（同样 rc=2）；
  5. 所以**映射中的 `node.exe` 镜像在重启前永远删不掉**（锁的是文件对象，不是名字）。
- **处置**（不重启 VM —— 最高红线）：
  - 加第三轮兜底 `EvictLocked`：把删不掉的单文件**改名移出**到 `C:\ProgramData\WinVMStale`（改名是被允许的），再登记 `PendingFileRenameOperations` 让系统开机时删除，随后目录本身即可回收 ⇒ `LEFT_*=False`，`--purge-all` 能 PASS；
  - `KillNodeHolders` 从「杀所有 node.exe」改成**只杀路径/命令行落在待删运行时根内的**（原来那种一刀切会误杀 VM 上 WorkBuddy 客户端的 4 个扩展进程，实测已误杀一次）；
  - 杀不掉时不再静默：`Rep 'KILLED_HOLDERS'` 与 `PARKED_<label>` 两行回执，让「谁被占了、几个文件被移到哪里」可追溯。
- **教训**：Windows 上「访问被拒绝」有四种完全不同的成因（ACL / 句柄占用 / 僵尸残留 / 只读属性），**必须先用 Restart Manager 拿到持有者名单再动手**，否则 `rmdir /s /q` 会把它变成一条无信息的静默失败。

### P12｜4a 只看 rc，「node 没装上」被报成 `[OK] 依赖就绪`（假绿）

- **现象**（2026-11-19 10:48 真机，从零部署首跑）：
  ```
  10:47:38 ── [4a] prepare-vm --ensure-deps（node + codebuddy + 两上游全局 CLI）
  [DB-3][MANUAL] zip install FAILED: 不能解析远程名称: 'cdn.npmmirror.com'
  [DB-7][MANUAL] node missing; DB-3 must succeed first (npm comes with node)
  10:48:37 [OK] 4a (59s) 依赖就绪        ← 假绿
  ```
  故障被推迟到 4b，以 `VM_START_FAILED exit=1` 的面目出现（服务起不来），4b 单相位烧 106s，归因成本极高。
- **根因**：`deploy-4-vm.sh` 的 4a 判据只有 `[ $PRC -ne 0 ]`。但 `prepare-vm` 生成的 `.ps1` 在 DB-3/DB-7 失败时**只 `Write-Output "[MANUAL] ..."`，不 `exit 1`**（设计上是为了「一个依赖失败不阻断其他依赖」），于是 `bootstrap.mjs` 正常退出、rc=0 ⇒ 4a 报 PASS。
- **为什么第一版没发现**：这个假绿只在「VM 缺 node」时触发，而之前的测试机都已有 node（装有 nvm），4a 永远是 `[SKIP]`。**只有「彻底卸载 → 从零」才会暴露** —— 这正是本轮演练的价值。
- **处置**：
  - 新增 `_deps_gap()` 扫日志文本：命中 `[DB-3][MANUAL]` / `[DB-7][MANUAL]` / `zip install FAILED` / `zip install ran but node still not on PATH` 任一 ⇒ 判失败；
  - rc=0 但 `_deps_gap` 为真 ⇒ 先**有界重试一次**，仍缺则**兜底装 node**（P13），最后才 `st_end 1 FAIL "依赖缺件（rc=0 但日志报 MANUAL）"`；
  - `die` 文案直指「ps1 不返非零」这个机制，避免下一个人再去查通道。
- **教训**：**判据要锚定「结果」，不能锚定「退出码」** —— 当被调用方承诺「部分失败不阻断」时，rc 天然不能承载「整体是否达标」。凡是 `*.ps1` 用 `[MANUAL]`/`[WARN]` 表达未完成的地方，调用方都必须扫文本。

### P13｜node zip 下载的瞬时失败没有重试，且原来的兜底会撞「文件被占用」

- **现象一（瞬时失败）**：`[DB-3] zip install FAILED: 不能解析远程名称: 'cdn.npmmirror.com'`。
  - 取证（VM 内，同一时刻）：`Resolve-DnsName` 六个域名全 OK（`cdn.npmmirror.com → 119.0.107.63,175.12.102.33`）；`Test-NetConnection` 到 443 三个全 True；`ProxyEnable=0`、WinHTTP 直连、`DefaultWebProxy` 正常。
  - 取证（手工复现）：`Invoke-WebRequest` 对**同一条 URL** 一次成功，`bytes=37618919`（37.6MB 完整）。
  - ⇒ 结论：**不是 DNS/代理/防火墙，是镜像侧的瞬时抖动**，而 DB-3 的 zip 分支**一次失败就放弃**（`catch { [MANUAL] ... }`）。
- **现象二（兜底自身的坑）**：第一版兜底脚本（heredoc 内联）在真机暴露两个错误：
  1. `Remove-Item $dst -Recurse` 遇到活的 `node.exe` 直接抛「文件正由另一进程使用」，`$ErrorActionPreference='Stop'` 让整个脚本中断；
  2. `$tmp` 用固定名 `node-fallback.zip`，上次残留被占用 ⇒ 连**下载**都写不进去（`attempt=1` OK 之后 `attempt=1..3` 全 FAIL 同一句「正由另一进程使用」）。
- **Restart Manager 取证（谁是占用者）**：
  ```
  target = C:\Users\User\AppData\Local\nodejs\node.exe   exists=True
    PID=12904 APP=Node.js JavaScript Runtime TYPE=5
    PID=10480 APP=XtaCache TYPE=3
  --- delete probe ---  LOCKED（独占打开失败）
  ```
  `PID=12904` 的命令行 = `"C:\Users\User\AppData\Local\nodejs\node.exe" "C:\WinVMBridge\packages\vm-service\dist\cli.js" --host 127.0.0.1 ...` —— **WinVM 服务自己在用这个 node 跑**。
  ⇒ 这不是 bug，是「node 正在服务」的正常状态；但意味着**任何「删掉 nodejs 目录再解压」的写法都会失败**。
  附带确认：`schtasks /end` 报成功、进度计划任务状态变 Ready，**但 pid 12904 仍存活**（`/end` 结束的是任务实例，不是进程树），必须 `Invoke-CimMethod Terminate` 才真能释放（实测杀完 `NOW_FREE`，重启服务 36s 后 `health=200`）。
- **处置**：
  - DB-3 之外新增独立兜底 `scripts/node-zip-fallback.ps1`（纯 ASCII / 无 BOM，`__NODE_ZIP_VER__` 由 `deploy-4-vm.sh` 替换）：
    - **下载重试 3 次**（每次 `Start-Sleep 5`），失败才 `GIVEUP`；
    - `$tmp` 与 `$stage` 都带 `$PID` 后缀，**永不撞残留占用**；
    - **逐文件复制**（不是整树 `Copy-Item -Recurse`，也不是先删再放）—— 见下条实测；
    - 若 node 已在 ⇒ `[FB] node present ... [SKIP]`，幂等；
  - 4a 侧：`_deps_gap` 命中即重试一次 prepare-vm（覆盖「镜像瞬时抖动」这一类），仍缺才调兜底，兜底成功后再跑一次 prepare-vm 让 DB-7 补三个 CLI。
- **实测否证了两个我原本写进设计的假设**（值得单列 —— 都是「想当然 + 真机打脸」）：
  - **假设一：删除不行但覆盖可以。**（P11 里 park 用的是改名，逻辑上覆盖应当被允许。）
    真机结果：**覆盖同样被拒**，而且整树复制会**中断整个脚本**：
    ```
    [FB] download OK attempt=1 bytes=37618919
    Copy-Item : 文件"C:\Users\User\AppData\Local\nodejs\node.exe"正由另一进程使用，
                因此该进程无法访问此文件。
    ```
    ⇒ 映射中的镜像**既不能删、也不能盖**。正解不是「换一种删除方式」，而是「**逐文件 + 容忍失败**」。
  - **假设二：「复制失败 = 整个兜底失败」。**
    改成逐文件复制后的真机结果（同一台机器，node 仍被服务映射）：
    ```
    [FB] download OK attempt=1 bytes=37618919
    [FB] copied=1993 skipped=1
    [FB] SKIPPED(locked): node.exe
    [FB] PATH user scope += C:\Users\User\AppData\Local\nodejs
    [FB] node OK v24.21.0
    ```
    只跳过 `node.exe` 这 1 个文件，其余 **1993 个全部落位**，node 直接可用 ——
    因为被锁的那个文件本来就在位（旧版 node.exe 仍在目录里，只是没在 PATH 上）。
    ⇒ **「锁住的文件」和「缺失的文件」往往是互补的**：锁住说明它在，缺的是其余部分。
  - ⇒ 最终形态：逐文件 `Copy-Item -LiteralPath`；单文件失败只记 `skipped` 不中断；
    回执 `copied=N skipped=M` + `SKIPPED(locked): ...` 让「哪些没装上」可见；
    若 `skipped` 含 `node.exe` 且 node 仍不可用 ⇒ 打印 **`RESCUE_NEEDS_IDLE`** + 两条可执行动作
    （`schtasks /end` + 杀 pid、或经批准重启 VM），`exit 2`，而不是甩裸异常栈。
  - 「PATH 里没有 node」**不等于**「`%LOCALAPPDATA%\nodejs` 是空的」—— 本次就是 PATH 被摘了、
    而服务仍在跑同一份 node。这两个判据必须分开。
- **教训**：
  1. **「瞬时失败」与「配置错误」必须用并行取证分开** —— 同一 URL 手工能下、DNS/443/代理全绿，就能把 DNS 从嫌疑名单里划掉，不必去改 DNS；
  2. **凡是「删目录再重建」的安装套路，在 Windows 上都要先问「目录里有进程在跑吗」**；而且**别以为覆盖就能绕过** —— 映射中的镜像两条路都堵死，正解是「逐文件 + 容忍失败 + 明确告知需要 idle」；
  3. 临时文件名必须带 pid/时间戳。固定名 + 上次残留 = 一个必然复现的「假下载失败」，比真失败更难查；
  4. **假设要真机证伪**：如果我按第一版 Copy-over 直接发布，兜底会在「服务正跑着 node」这个最常见场景下 100% 失败，而且是在 4a 已经报过一次 MANUAL 之后 —— 用户看到的是「兜底也失败」，比没有兜底更打击信任。

---

### P14｜`.ps1` 用裸文件名推送，`-File` 却找不到它（P0，只在链路抖动时现形）

- **现象**（12:04 幂等复跑，`--only 4`）：
  ```
      (.ps1 已推送 winvm-setup-1795061108104.ps1 → VM)
  Windows PowerShell 5.1
  -File 方式参数实际参数 winvm-setup-1795061108104.ps1 不存在。请提供现有 .ps1 文件的路径作为 -File 方式的一个实际参数。
  [FAIL] apply .ps1 非零退出（code=4294770688）
  ```
  **矛盾点**：前一行刚说「已推送」，下一行说「不存在」。而且 PowerShell 横幅（`Windows PowerShell 5.1` +
  版权行）**已经打出来了** —— 说明 `powershell.exe` 正常启动、正常解析参数、只是在**它的 cwd 下**
  找不到这个裸文件名。**不是**通道坏、不是脚本坏。
- **反证（这条最关键）**：11:53 轮**同样代码、同样命名格式**（`winvm-setup-1795060455849.ps1`）
  **成功执行**并返回全部 `[DB-x]` 行。⇒ 不是「功能坏了」，是**间歇性**。
- **根因**：`runRemotePs1` 把 put 与 exec 拆成**两次独立的 `withVmChannel` 调用**。
  每次调用内部都会**独立决议后端**（ssh2 / 二进制 scp）。裸相对文件名成立的前提是
  「sftp 落盘目录 == ssh 登录 cwd == scp 落盘目录」，而这三种后端的落点**并不保证同一处**
  （sftp 子系统根 vs cmd.exe 起始目录）。于是同一条代码时好时坏 —— 取决于这一轮 put 和 exec
  各自选中了哪个后端。
- **为什么之前一直没暴露**：绝大多数轮次两次调用选中同一后端，恰好一致。只有链路抖过
  （本轮 12:04 之前刚好发生过一次连接回落）才会分裂。
- **修（`delivery/setup.mjs` `runRemotePs1`）**：不是去「对齐 cwd」（那是猜，而且换台机器就变），
  而是**让路径不再依赖 cwd**：
  ```js
  const remoteDir = String(cfg.vmDeployDir || 'C:/WinVMBridge').replace(/\/+$/, '');
  const remoteNameAbs = `${remoteDir}/${remoteName}`;
  // 推送 / 执行 / 清理 三处统一用 remoteNameAbs；-File 加引号
  ```
  sftp `put` 会自动 `mkdir` 父目录；scp 兜底落 `VM_DEPLOY_DIR`（部署与卸载相位该目录必在）。
- **教训**：
  1. **「已推送」和「执行时找不到」能同时为真** —— 日志没骗人，是**两个不同的后端各自说真话**。
     看到这种矛盾，第一反应不该是「日志错了」，而是「这两步是不是不在同一个上下文里」。
  2. **跨通道的隐含假设必须写死在代码里，不能留在注释里** —— 原注释明写「scp 裸文件名=落 sftp
     默认目录=同一处」，把一条**未必成立**的前提当成了契约。
  3. 修法是**消除歧义**（绝对路径），不是**维持假设**（对齐 cwd）。前者一次解决，后者要跟着环境变。

### P15｜`state` 漏映射两个键：日志永远 `MISSING`，DB-7 永远不收敛（P0，判据面假红）

- **现象**（12:04 轮，三 CLI **早已装好**）：
  ```
   DB-7 global CLI   = codebuddy:OK desktop:MISSING browser:MISSING  (--ensure-deps 已开)
   ...
   DB-7 global CLIs (codebuddy/agent-desktop/agent-browser) => DO npm i -g agent-desktop + agent-browser
  ```
  而**同一时刻**（12:02 的 4c）读到 `browser=33 desktop=25`，两者矛盾。
- **根因**：探测脚本采集的键名是 `$o.browserCli` / `$o.desktopCli`（`builder` 侧，browser 在前），
  而 `bootstrap.mjs` 的 `state` 组装**只映射了 `agentCli`，漏了这两个**。于是：
  - 日志（`bootstrap.mjs:906-907`）读 `state.cliDesktop` / `state.cliBrowser` ⇒ 恒 `undefined` ⇒ **恒 MISSING**；
  - `planPrepareVm`（`prepare-vm.mjs:339-340`）读 `probe.cliDesktop` / `probe.cliBrowser` ⇒ 恒 falsy
    ⇒ `missCli` 恒含这两只 ⇒ 计划表**永远**给 `npm i -g agent-desktop + agent-browser`，
    **永远到不了 `[SKIP] all present`**。
- **影响面（要精确，别夸大）**：**执行面是对的**。DB-7 的 `.ps1` 内部用 `Get-Command` 自己重探
  （幂等），所以该装的装上、装好的不重装。**受害的是判据面**：日志假红 + 计划表恒给重装指令。
  真实代价是**误导**（让人以为每轮都要重装、以为 CLI 真的没装上），以及**掩盖真正的缺失**——
  当真的只剩一只缺时，日志显示两只都缺，排错方向就是错的。
- **修（`delivery/bootstrap.mjs`）**：补两个键，**注意交叉对位**：
  ```js
  cliDesktop: usedCombined ? !!J.desktopCli : (J2 ? !!J2.desktopCli : false),
  cliBrowser: usedCombined ? !!J.browserCli : (J2 ? !!J2.browserCli : false),
  ```
  降级路径（`J2`）没有这两项 ⇒ 保持既有「宁可报缺失」取向（false），不报 OK。
- **为什么只有「彻底卸载 → 从零」才暴露**：测试机若本来就有这两只 CLI，`agentCli` 一直 OK，
  人的注意力全在 node 上；只有真的一次装齐三只、再回头复跑，才会发现「装好了还在喊 MISSING」。
- **教训**：
  1. **探测端与消费端键名不一致时，map 就是唯一的契约面，必须有守卫钉住** —— 漏一个键不会报错，
     只会**静默变成恒 false**。这是最难查的一类：没有异常、没有日志、就是结论错。
  2. **交叉错位比漏映射更危险** —— `browserCli→cliDesktop` 写反了同样不报错，但会「该绿的变红、
     该红的变绿」，方向相反、更难识别。守卫必须**同时**断言「存在」与「没写反」。
  3. **「假红」和「假绿」危害不同但不能都放着**：假绿会让真缺时无人补（P12 那类），
     假红则会让「已修好」永远看起来没修好，直接摧毁下一步判断。

---

### P16｜VM-START 清扫把执行清扫的脚本自己杀掉了（P0，P14 的回归）

- **现象**（16:52 真机首跑 P14 修复版）：
  ```
  ❌ VM 服务启动触发失败（VM_START_SWEEP PID=2792 NAME=cmd.exe
  VM_START_SWEEP PID=9056 NAME=powershell.exe
  ）
  ```
  `9056` 正体就是**正在执行清扫的那个 PowerShell 进程**。它把自己 `Terminate` 了，于是后面的
  `schtasks /run` 没发出去 ⇒ 「启动触发失败」。
- **根因：两条各自正确的改动叠加出新缺陷。**
  - 清扫签名（I-6.15b 的根治手段）匹配 `WinVMBridge|start-hidden|vm-service|ps-bridge`；
  - P14 把 `.ps1` 落点统一到 `C:/WinVMBridge/winvm-setup-<ts>.ps1`；
  - ⇒ 脚本**自己的命令行就含 `WinVMBridge`** ⇒ 命中签名 ⇒ 自杀。
- **修法取舍（三选一，选了最保守的）**：

  | 方案 | 判断 |
  |---|---|
  | 排除自身 + **祖先链** | ✅ 采用：签名强度不变，只是「杀别人别杀自己」 |
  | 放宽签名 | ❌ 会让 I-6.15b 要清的**游离 vm-service 实例漏杀**，等于退回旧病 |
  | 把脚本挪出 `C:/WinVMBridge` | ❌ 破坏 P14 刻意选的稳定落点 |

  为什么是祖先链而不是只排 `$PID`：脚本常经 `cmd.exe` / `powershell` 包装启动
  （真机那条 `PID=2792 NAME=cmd.exe` 就是包装器），只排自己仍会把父包装器杀掉，症状一模一样。
- **教训**：
  1. **「签名清扫」与「固定落点」是一对天然冲突的机制** —— 前者按路径/命令行识别敌人，
     后者把自己也放进同一命名空间。以后任何「按名字匹配然后杀」的逻辑，都必须先问
     「我自己会不会匹配上」。
  2. **回归不来自错误改动，而来自正确改动的叠加**。P14 和签名清扫各自都对，
     合起来才出事 ⇒ 只测单个改动的效果是不够的，必须**跑完整链路**。
  3. 守卫要加**反向断言**（「签名必须保留」），否则后人为了修 P16 会把签名放宽，
     把 I-6.15b 的老病放回来。

### P17｜`RELEASE_TAG` 指定了版本，却静默用了另一个版本（P1，判据基准错配）

- **现象**：`RELEASE_TAG=V1.4.34 bash deploy-2-host.sh` 输出
  ```
  包根 = /storage/Users/currentUser/winvm-deploy/overall-root/overall
  版本 = V1.4.32
  ```
  **指定 V1.4.34，实得 V1.4.32，且 rc=0 不报错。**
- **根因**：`resolve_pkg_root` 的优先级是
  `env PKG_ROOT > $DEPLOY_ROOT/pkg-root.txt 状态文件 > _pick_pkg_root 现探`。
  状态文件里记着上一次的旧包根，**优先级高于 tag 探测** ⇒ tag 被完全绕过。
  而 `download-verify.sh` 的缓存快路径调用的是 `_pick_pkg_root "$TAG"`（认得 tag），
  两者不是同一个函数 ⇒ **同一脚本内两套选根口径**。
- **危害**：这是「基准错配」，比直接失败更危险。`5d` 的 `fresh` 对账基准、`PKG_VERSION` 全部
  跟错包走，**矩阵会以一个错误基准判 PASS**。本轮就实测到：内容已是 V1.4.34，
  而 state 仍写 `PKG_VERSION=V1.4.32`。
- **本轮的处置（未改代码，改环境对齐）**：清 `pkg-root.txt` → 隔离旧解包层 →
  把 V1.4.34 解到标准包根 → 写回状态文件 → 对齐 `deploy-state.env` 的 `PKG_VERSION`。
  四者（MANIFEST / 状态文件 / state / 实际内容）一致后矩阵才可信。
- **修复（2026-11-19 16:5x 已落地，技能侧）**：
  1. `resolve_pkg_root` 显式给了 tag ⇒ 只走 `_pick_pkg_root "$tag" strict`，匹配不到
     `PKG_RESOLVED=""` + `rc=1`，**状态文件直接被跳过**；不给 tag 才轮到状态文件。
  2. 新增 `pkg_root_tag_mismatch_error`，报错必须回答三个问题：要哪版、盘上实际有哪些版
     （`版本@路径` 逐条列出）、状态文件**已被忽略**。与「找不到包根」的文案分开 ——
     那一类会把人引向「去找包根」，而这里盘上明明有层，只是版本不对。
  3. **`download-verify.sh` 的缓存快路径与解包后选根都补 `strict`** —— 这是 P17 的**第二条入口**，
     比状态文件更隐蔽：`zip 在 + sha 对 + 盘上有任一合法层` 就判「缓存命中」，
     而「有合法层」≠「有这一版的层」。
  4. `deploy-2-host.sh` 加**第二道锁**：2a 拿到 `VER` 后与 `RELEASE_TAG` 对账，不符即 `st_end 1 FAIL`。
     两道锁不是冗余 —— `download-verify` 可能被 `SKIP_DOWNLOAD` / 手工摆包绕过，
     而 2a 是「包根进入 state」的唯一入口，错在这里，后面 4b/4c/5d 全在错基准上判 PASS。
- **门禁**：新增断言 `pkg-tag-priority`，**行为级**（真的 source 一份 `pkg-root.sh` 跑四个场景），
  而不是查源码字符串 —— 字符串只能证明「代码里有 strict 这个词」，
  证明不了「给了 tag 就不会静默返回旧层」，而 P17 的失败形态本身就是 rc=0、源码怎么看都对。
  四个场景：① 主案必须 rc=1 且不残留 `PKG_RESOLVED`；② **反向**：tag 有对应层时必须命中
  （防止修主案时把正常路径改坏）；③ 不给 tag 时状态文件仍生效（防止把「免重解」优化一起砍掉）；
  ④ `env PKG_ROOT` 仍最高。变异 `M54`（显式 tag 让位状态文件）、`M55`（tag 匹配退化非 strict）、
  `M56`（缓存快路径去 strict）**全部 CAUGHT**。
  > M56 第一版 MISS 了，原因值得记：断言只查 `_pick_pkg_root "$TAG" strict` 这个子串，
  > 而 `download-verify.sh` 里**有两处调用**（cache 的 `HIT=` 与解包后的 `PKG=`），
  > 子串在另一处仍然存在 ⇒ 假绿。改成逐调用点正则后 CAUGHT。
  > **教训：一个"正确写法"在文件里出现多次时，子串断言等于没断言。**
- **真机验收（16:47）**：
  ```
  [正] tag=V1.4.34 → rc=0 命中 V1.4.34 source=tag(V1.4.34)
  [反] tag=V1.4.32 → rc=1 拒绝      ← 旧代码在此静默返回 V1.4.34 的层
  [无tag]          → rc=0 source=state(...)   ← 状态文件兜底仍生效
  ```
  反例侧还跑了一次完整 2a：`RELEASE_TAG=V1.4.99` → `DOWNLOAD_FAILED` + `[FAIL] 2a`，
  且 **state 与 pkg-root.txt 均未被污染**（仍是 V1.4.34）—— 失败路径不留半个脚印。
- **教训**：
  1. **状态文件是性能优化，不是事实源**。一旦状态文件能覆盖显式参数，它就把「用户意图」
     降级成了「上次的偶然」。
  2. **静默错配比报错危险一个量级**：报错会让人停下来，错配会让人拿着错误的基准一路绿灯。
  3. 复核一致性要**四面对账**：MANIFEST 声明 / 状态文件 / deploy-state / 实际文件内容。
     本轮就是靠「MANIFEST 说 V1.4.34 而 state 说 V1.4.32」这个矛盾发现的。
  4. **同一判据有两处实现时，只修一处等于没修。** P17 有三处选根入口
     （`resolve_pkg_root` / cache 快路径 / 解包后选根），第一轮只想到前两处。

### P18｜失败行打的是 `download-verify rc=0`（P2，诊断信息自伤）

- **现象**（16:45，P17 验收时顺手撞见）：`RELEASE_TAG=V1.4.99` 正确 FAIL，但日志写
  ```
  16:45:42 [FAIL] 2a (35s) FAIL download-verify rc=0
  ```
  **明明失败了，rc 却是 0。**
- **根因**：
  ```bash
  if ! bash "$SCRIPTDIR/download-verify.sh" ... > "$DV" 2>&1; then
    st_end 1 FAIL "download-verify rc=$?"     # ← 这里的 $? 恒为 0
  ```
  `!` 取反本身是一次求值，进入 `then` 时 `$?` 已经是 **0**（取反后的成功）。
  真退出码永久丢失。
- **危害**：它专打**最该看清的那一行**。失败现场里「rc=0 却说失败」会把人推向
  「脚本逻辑有问题」的错误方向，而真凶往往是 rc=1（网络/tag 不存在）或 rc=2
  （sha256 不一致 = 事故，绝不能重试）。**诊断信息本身不可信，等于没有证据。**
- **修复**：`DVRC=0; bash ... || DVRC=$?; if [ "$DVRC" -ne 0 ]; then`，
  并把 rc 语义写进 `die` 的根因字段（rc=1 vs rc=2 处置完全不同）。
- **门禁**：新增断言 `rc-honesty`，扫所有 `scripts/*.sh` 里 `if !` 块的**前三行**是否出现 `$?`。
  变异 `M57`（整块退回旧写法）**CAUGHT**。
- **教训（与 P14/P15 同宗）**：这是第三次「**执行面对、判据面错**」。
  前两次是假红（P15）/歧义（P14），这次是**假绿混在失败行里**。
  ⇒ 排查任何缺陷时，除了问「活干对了吗」，还要问「**报告说的是真的吗**」。
  一条可复用的自检：**失败行里的每个数字，都要能被独立复算。**

---

## 4. 阶段 B：从零前的通道重建（唯一人工步骤）

通道已断（`22:TIMEOUT`），重建只有一条路 —— 技能设计的唯一人工步骤：在 VM 管理员 PowerShell 粘一条命令（远端下载 `winvm-sshd-oneclick.ps1` 并安装 OpenSSH + 写钥）。

**为什么不能自动**：
- sshd 是 MSI 安装，卸掉后 VM 侧无任何带凭据的自动化面；
- RDP 禁用、445 关闭；
- WinRM 5985 在听，但**只允许 Negotiate/Kerberos（Basic 关闭）**，需要账户口令才能手写 NTLM 握手 —— 当前环境没有 VM 口令。

> 这一条**本身就是技能设计的正确行为**，不是缺陷：卸载阶段绝不为了「后面还要用」而偷偷留后门。

### 4.1 `--purge-all` 真机终态确认（2026-11-19 10:20，WALL 114s）

| 环节 | 耗时 | 结果 |
|---|---|---|
| 1a 停 tunnel service | 2s | — |
| 1b 卸 host 插件 | 1s | `HOST_PASS=11 HOST_FAIL=0` |
| 1c host 清空复核 | 0s | `mcp_left=none` |
| 2a 通道判定 | 2s | — |
| 2b 推 VM 卸载脚本 | 6s | 三个 ps1 就位 |
| 2c 停服务 + 卸模块 | 29s | `UPSTREAM_LEFT=NONE` |
| 2d VM 终态五点 | 13s | `False False 0 Running False NONE` |
| **2e 运行时深清** | **28s** | 五个 CLI 全 `MISSING`，三处运行时目录全 `False` |
| 3a 通道状态 | 2s | `channel=READY` |
| **3b SYSTEM post** | **34s** | `PURGE_WRAPPER_READY` + `POST_ROLLBACK_SCHEDULED` |
| **合计** | **114s** | `UNDEPLOY=PASS host=clean vm=clean tunnel=yes` |

**裸机终态取证**（卸载后 60s 复测）：
- `ping 172.16.100.2` → **0% 丢包，2ms**（VM 活着，没被卸载搞崩）；
- `22` → TIMEOUT（sshd 已卸）、`18443` → TIMEOUT（服务已卸）、`5985` → TIMEOUT（服务仍在但 Basic 认证关闭且无口令，连接被拒）；
- 宿主侧：插件缓存、connector skills、`mcp.json` 的 winvm 条目、`known_hosts` 的 3 条 VM 记录 —— **全部为空**。

这正是「全删到裸机」的定义：**VM 活着、凭据入口为零**。

---

## 5. 阶段 C：从零部署（1→5 全链 PASS）

### 5.1 第 1 步（通道 DOWN，2026-11-19 10:22，WALL 19s）

| 环节 | 耗时 | 行为 |
|---|---|---|
| 1a 通道判定 | 15s | `channel=DOWN`（6s 建连窗 × 重试） |
| 1p.1 凭据可达性 | 0s | SKIP `NEED_PASSWORD`（未提供口令） |
| 1b.1 准备密钥 | 0s | 复用 `id_ed25519_winvm`，指纹 `SHA256:74Ke67…` |
| 1c.1 打印命令 | 2s | 2 个候选源，命令已含 BOM 归一化段 |

`DEPLOY=NEED_USER_ACTION rc=2`，命令现含 `ReadAllText(UTF8)` → `WriteAllText(UTF8Encoding($true))`（P9 修复已生效）。

### 5.2 第 2~5 步（V1.4.33，2026-11-19 10:47 首跑 → 11:53 收敛重跑）

**包**：`release/V1.4.33/overall`（`version: V1.4.33` / `commit: 6a74bf6`），zip sha256 `24fe60c7…` 校验通过。
**为什么用本地包**：gitee `releases/latest` 仍是 V1.4.32，而 V1.4.33 含 DB-7 四个 CLI 迁入 4a 等实改动 —— 必须让新代码进执行路径，正好复验 **P4**。

#### 首跑（10:47:31 → 10:50:23，**4b FAIL**）

| 环节 | 耗时 | 结果 |
|---|---|---|
| 1a 通道判定 | 1s | `channel=READY`（oneclick 已建好） |
| 2a 取包 | 1s | 缓存命中，`ver=V1.4.33` ← **P4 通过** |
| 2b MANIFEST 对账 | 1s | `RESULT: PASS` |
| 2c 结构就位 | 0s | host 端 4 件齐 + `.env` |
| 2d install-host | 1s | rc=0，`connector:winvm` / `winvm-a2a` 双断言 ✓ |
| 2e host 判据 | 0s | `skills=10` |
| 3a 对齐 identityFile | 0s | `id_ed25519_winvm` |
| 3b 起隧道 | 1s | 已监听，SKIP restart |
| 3c 验隧道 | 0s | `listen=yes daemon=yes health=000`（合法中间态） |
| 4.0 通道门禁 | 1s | `channel=READY` |
| **4a 依赖补齐** | **59s** | **声称 `[OK] 依赖就绪`，实为假绿（P12）** |
| **4b VM 安装** | **106s** | **FAIL `VM_START_FAILED exit=1`**（node 缺失导致服务起不来） |
| WALL | **172s** | 阶段 B 失败 |

4a 的真相（从 `prepare-vm.log` 挖出来）：
```
[DB-3] winget had no effect (MSIX alias empty-shell over ssh?); falling back to zip install
[DB-3][MANUAL] zip install FAILED: 不能解析远程名称: 'cdn.npmmirror.com' -- install Node >= 18 manually
[DB-7][MANUAL] node missing; DB-3 must succeed first (npm comes with node)
```
⇒ 这就是 **P12（假绿）+ P13（瞬时失败无重试）** 的现场。

#### 收敛重跑（11:53 → 12:02，**PASS**）

| 环节 | 耗时 | 结果 |
|---|---|---|
| 4.0 通道门禁 | 1s | READY |
| **4a 依赖补齐** | **177s** | `zip install OK v24.21.0` + 三 CLI `added 23 packages in 2m` 全 OK |
| **4b VM 安装** | **165s** | `setup rc=0`，VM 服务监听 18443 |
| **4c 七判据** | **50s** | `task_state=Running listen_count=1 health=200` `browser=33 desktop=25` |
| WALL | **396s** | `DEPLOY=PASS` |

第 5 步（`--only 5`，WALL 57s）：

| 环节 | 耗时 | 结果 |
|---|---|---|
| 5 三探针 | 41s | `PROBES 34/34 SKIP=4`（mcp 20/20、a2a 4/4、example 10/10） |
| 5d 终态矩阵 | 14s | `FRESH` SHA256 全一致 · `health=200` · `skills=10` · `task=Running listen=1 sshd=Running` |

#### 复验结论

- **P4 ✓**：`deploy-state.env` 里 `PKG_ROOT=.../overall-root/overall`、`PKG_VERSION=V1.4.33` —— 新代码确实在执行路径上（4a 真的跑了 DB-7 段，这是 V1.4.33 才有的）。
- **P5 ✓**：`setup.log` 中 `DRY-RUN 只规划` 命中 **0** 次 —— 4b 没有走「0s PASS 零动作」的假绿路径。
- **V1.4.33 的 DB-7 迁移 ✓**：4a 一次装齐 `codebuddy` + `agent-desktop` + `agent-browser`，4b 不再重复装，4c 直接读到 `browser=33 desktop=25`。
- **`npm warn install-scripts` 不是缺陷**：核实到 `agent-browser/skill-data`（27 文件）+ `skills` 子目录都在，postinstall 已实际执行；npm 11 只是把「未登记 allowScripts」的提示提级成 warn。

#### 一处遗留观察（非阻塞）→ 已在 5.3 闭环

`4a` 首跑 59s → 收敛后 177s，差异来自「这次真的要装 node + 三个 CLI」。等 node 装好后**再跑 4a 应全 `[SKIP]`**（幂等判据是 `Get-Command`），这条留给下一轮验证。

### 5.3 V1.4.34 真机复验（2026-11-19 16:00，P14/P15/P16 三修复验收）

**背景**：VM 于 12:10 整机失联、15:43 恢复。恢复后 VM 上 node 与三个 CLI 已装好，正好构成
「**幂等复验** + **判据面修复验收**」的双重条件。

**三次尝试，前两次失败都是真缺陷，不是环境问题**：

| 轮次 | 包 | 4a | 4b | 结论 |
|---|---|---|---|---|
| #1 15:49 | V1.4.34（无 P16） | 62s 全 `[SKIP]` | **0s FAIL dry-run** | P5 判据正确拦截（新包根只有 `.env.example`）；补 `.env` |
| #2 15:51 | V1.4.34（无 P16） | 55s 全 `[SKIP]` | **183s FAIL** | **P16 暴露**：`VM_START_SWEEP PID=9056 NAME=powershell.exe` 自杀 |
| #3 16:00 | V1.4.34（含 P16） | **50s 全 `[SKIP]`** | **152s rc=0** | **PASS** |

**第 4 步（V1.4.34，WALL 245s）**：

| 环节 | 耗时 | 结果 |
|---|---|---|
| 4.0 通道门禁 | 1s | `channel=READY` |
| 4a 依赖 | **50s** | 全部 `[SKIP]`：`node present v24.21.0` / `codebuddy present` / `agent-desktop present` / `agent-browser present` / **`all global CLIs present`** |
| 4b VM 端 | 152s | `setup rc=0` · `部署全部完成 ✅` · `✅ VM 服务已监听 127.0.0.1:18443` |
| 4c 七判据 | 40s | `task_state=Running listen_count=1 health_http=200 browser=33 desktop=25` |

**第 5 步（WALL 33s）**：`PROBES 34/34 SKIP=4` · `browser=33 desktop=25` ·
`FRESH` SHA256 全一致 · `health=200` · `connector skills=10` · `task=Running listen=1 sshd=Running` ·
**`VERIFY=PASS`**

#### 三修复的真机证据（这是本轮最关键的产出）

| 修复 | 判据 | 真机证据 |
|---|---|---|
| **P14** | 日志打**绝对路径** | `.ps1 已推送 C:/WinVMBridge/winvm-setup-1795075399254.ps1`（不再是裸文件名） |
| **P15** | DB-7 不再假红 | `[DB-7] all global CLIs present [SKIP]`（此前**永远**报 `desktop:MISSING browser:MISSING`） |
| **P16** | 不自伤 | `VM_START_SWEEP` 命中数 **0**，且 `✅ VM 服务已监听` 正常触发 |

#### P12 的 4a 幂等复验（原待办 1）✓

- **177s → 50s**（降 72%），且三次运行稳定在 50~62s。
- 全 `[SKIP]` 证明幂等判据（`Get-Command`）生效，**不是重装**。
- ⇒ **177s 确实是一次性成本**（要真装 node + 三 CLI），不是每轮成本。这条待办闭环。
- 仍可优化：50s 里主要是三次 ssh 往返（合并探测、apply、回验），不是安装本身。

#### 一处口径修正（重要，避免后续误读）

本轮 `5d` 曾报 `connector skills=0` 而 `fresh` 通过 —— 原因是**只跑了第 4、5 步**，
第 2 步的 `install-host`（负责分发 connector skills）是上一轮 V1.4.33 时做的，本轮未重跑。
补跑第 2 步后 `skills=10` 恢复。**教训：`--only 4`/`--only 5` 不覆盖 host 端分发，
做「完整从零」验收时必须从第 2 步起跑。**

---

## 6. 时长汇总（已得）

| 阶段 | WALL | 最大单项 |
|---|---|---|
| 原生 undeploy（1+2+3，保留通道） | **86s** | 2c 停服务+卸模块 **42s** |
| **`--purge-all` 全链（到裸机）** | **114s** | 3b SYSTEM post **34s** |
| 其中 2e 运行时深清（单跑） | 28~36s | 三处 node 运行时 + 五个 CLI 断言 |
| deploy 第 1 步（通道 DOWN） | **19s** | 1a 通道判定 15s |
| **从零部署第 2~4 步首跑（4b FAIL）** | **172s** | 4b 106s（node 缺失→服务起不来） |
| **从零部署第 4 步收敛** | **396s** | **4a 177s**（node zip 37.6MB + 三 CLI `npm i -g` 2m） |
| 从零部署第 5 步 | **57s** | 三探针 41s |
| **从零部署全链合计（1+4+5，不含人工粘贴）** | **≈ 630s** | 4a 177s + 4b 165s + 4c 50s |
| deploy `--only 4`（v2.4.0 真机，参考） | 241s | 4b 推包 **149s** |
| deploy `--only 5` | ~30s | 三探针 16s |
| **deploy `--only 4`（V1.4.34，幂等态）** | **245s** | **4b 152s**（4a 已降到 50s） |
| deploy `--only 5`（V1.4.34） | **33s** | 三探针 ~19s |
| 幂等态全链（2+4+5，已达稳态） | **≈ 300s** | 4b 152s 是唯一大头 |

**关键读数**（已按 V1.4.34 实测修正）：

1. **4a 的 177s 确是一次性成本** ✓ 已实测闭环：第二次起 **50s**（降 72%），三次稳定在 50~62s，
   全 `[SKIP]`。原来预估「回落到十几秒」**偏乐观** —— 剩下的 50s 不是安装，而是
   **三次 ssh 往返**（合并探测 15s + apply + 回验），这部分与装没装过无关。
2. **4b 的 152s 现在成了唯一大头**，且其中大头是**每次无条件 tar + scp + install + 重启**，
   与「内容有没有变」无关 ⇒ 这才是下一步该优化的点（见 §7 待办 1）。
3. 稳态全链 ≈ 300s，比首跑 630s 少一半，且**首跑多出的时间几乎全在「真装东西」上**，
   不是流程冗余。

---

## 7. 结论与待办

**已闭环**：P1（v2.5.0 `--purge-all`）、P2~P8 全部修完；**P9（BOM 契约）、P10（第三个 node store）、P11（僵尸句柄）、P12（4a 假绿）、P13（node 兜底）** 在本轮真机暴露并修完；**P14（`.ps1` 裸名路径）、P15（`state` 漏映射 CLI 键）** 在 VM 失联后经静态取证定位并修完；**P16（VM-START 清扫自杀）与 P17（`RELEASE_TAG` 静默错配）** 在 15:49/15:51 两轮失败中暴露，P16 当日修完并真机验证；**P18（失败行 `rc=0`）** 在 P17 验收时顺手撞见，同样修完并加门禁。

**门禁**：技能侧 `SELFCHECK=ALL_GREEN checks=32 fails=0` / `MUTATION_RESULT=ALL_CAUGHT 57/57`；母项目新增守卫件 `p14-p15-ps1-path-and-cli-map-guard.test.js`（**20 用例**，四段 describe）并登记进 `GATE_GUARD_FILES`，**变异全部 CAUGHT**（`-File` 回裸名 / 交叉错位 / 删键重现原 bug / 删 P16 排除条件）。母项目门禁整体仍 `RED`，但经 `git stash` 归因实验确认两件失败（`phase2-snapshot-truth`、`phase3-skill-claims-guard`）在 HEAD 上**同样 fail 1**，属既有失败（沙箱缺 fixture），与本批改动无关。

> **跑门禁要用 `/data/storage/el1/bundle/libs/arm64/node/bin/node`**，不是 `/data/service/hnp/bin/node`。
> 后者跑 `node --test` 会在 200ms 处崩在 `Check failed: 12 == (*__errno_location())`，
> 表现为「整文件 fail、0 个用例被收集」——极易误读成断言失效。（`-e` 单行脚本用它是正常的。）
>
> **技能门禁的新断言一律不许 `shutil.rmtree`**：鸿蒙沙箱按「单回合进程内 unlink 数」计，
> 一次删 51 个就撞阈值 50 抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，表现为
> 「`rc=1` 但一行 `[FAIL]` 都没打」——极易误读成断言失效。改用唯一目录名、原地新建。

**已完成的关键验证**：
- ✅ `--purge-all` 真机 PASS，到裸机终态（VM 存活 + 22/18443/5985 全不可用 + 宿主侧零残留）；
- ✅ 2e 五个 CLI 全 `MISSING`，三处运行时目录全消失；
- ✅ BOM 归一化离线回环（`3c230a` → `efbbbf`）；
- ✅ 第 1 步在通道 DOWN 时正确打印含 BOM 修复的命令（rc=2，WALL 19s）；
- ✅ **从零部署全链 PASS**（第 4 步 396s + 第 5 步 57s，`PROBES 34/34`、`health=200`、`browser=33 desktop=25`）；
- ✅ **P4 复验**：`PKG_VERSION=V1.4.33` 进 state，`PKG_ROOT` 指向新解出的层；
- ✅ **P5 复验**：`setup.log` 无 `DRY-RUN 只规划`（0 次），4b 不是 0s 假绿；
- ✅ **P12/P13 修复真机验证**：兜底逐文件复制 `copied=1993 skipped=1`（只跳过被映射的 node.exe）后 `node OK v24.21.0`；
- ✅ **P12 的幂等复验**：4a **177s → 50s**，三次稳定 50~62s，全 `[SKIP]` ⇒ 一次性成本坐实；
- ✅ **P14 真机验证**：`.ps1 已推送 C:/WinVMBridge/winvm-setup-1795075399254.ps1`（绝对路径）；
- ✅ **P15 真机验证**：`[DB-7] all global CLIs present [SKIP]`（此前永远报 `MISSING`）；
- ✅ **P16 真机验证**：`VM_START_SWEEP` 命中数 **0** + `✅ VM 服务已监听 127.0.0.1:18443`；
- ✅ **V1.4.34 全链 PASS**：第 4 步 245s（4a 50 / 4b 152 / 4c 40）+ 第 5 步 33s `VERIFY=PASS`。

**待办（按优先级）**：

1. 🔴 **发布未做**：母项目 V1.4.34（含 P14/P15/P16）需 `pack → push origin → push gitee main+tag →
   publish --apply --mirror-gitee`；技能仓 v2.5.5（含 P17/P18）需 `skill_dev.py release`
   （**顺序：commit/push 先，release 建 tag 后** —— 先手动打 tag 会报
   `tag already exists — bump frontmatter version`）。
   注：本地 `release/V1.4.34` 已按 `b173cbf` 重 pack 过（overall 1029 文件 / sha256 `52b0908e…`），
   但**尚未 push**，gitee `latest` 仍是 V1.4.32。
   ⚠ **P17/P18 改的是技能仓 `scripts/`**，不随母项目 pack 进包 —— 两者要分别发布，
   不要以为「包发了技能就发了」。
2. **4b 加「内容未变则短路」**：现在每轮无条件 tar+scp+install+重启（152s），与内容是否变化无关。
   正解 = 让 VM 侧 `MANIFEST-deploy-*.txt` 带上 `total-sha256`（源内容哈希，与 tar 时间戳无关），
   对得上就整段跳过。预计 **-100~140s/轮**，是当前**性价比最高**的一项。
3. **P12 的根因在 prepare-vm 侧未动**：DB-3/DB-7 失败仍只打印 `[MANUAL]` 不 `exit 1`。当前靠 4a
   扫文本兜住（已加门禁），但更干净的做法是让 `bootstrap.mjs` 在这些行出现时返回非零。改它要评估
   「部分失败不阻断」的既有语义，故本轮只加固调用方。
4. **`AllowScripts` 显式登记消音**：`npm config set allow-scripts=agent-browser,agent-desktop --location=user`。
   npm 11 把「未登记」提示提级成 warn，实际 postinstall 已执行（已核实 `skill-data` 27 文件在位）——
   消音是为了防止下一个人误判成「没装好」。
5. 卸载侧仍无「卸载后自动核对残留清单」的汇总行（现在靠 2d + 2e 两段分别断言）。
6. `1a`/`3a` 在通道本就 DOWN 时要烧 15s（6s 建连窗 × 重试）。可降到 3s，收益约 8s，
   但要确认不误判「慢但活着」的通道。
7. `C:\ProgramData\WinVMStale` 里被 park 的死镜像要等下次 VM 重启才清（已登记
   `PendingFileRenameOperations`）；这是**故意**的 —— 绝不为了清一个文件而重启 VM。
8. codebuddy 子进程（`codebuddy mcp remove`）没有被回收是 P11 的源头：4a 里凡是 `& codebuddy ...`
   都要 `Wait-Process` + 超时，避免再留僵尸。
9. **`--only 4`/`--only 5` 不覆盖 host 端分发**（已实测踩到 `skills=0`）：connector skills 由第 2 步
   `install-host` 分发。做「完整从零」验收必须从第 2 步起跑，否则 5d 会假红。
   考虑在 `deploy-5-verify.sh` 里加一句前置提示。
10. **P17 只在「盘上无该版本」时验证过**：真机验的是 V1.4.34（命中）与 V1.4.32（拒绝，但盘上
    只有 V1.4.34 ⇒ 属「无该层」）。**尚未验证「盘上同时有新旧两层、显式要新的」**——
    那才是「陈旧层残留」的主场景，也是 P17 报告里最想防的形态。等下次打新版时自然覆盖。

---

## 8. 插曲：VM 整机失联（2026-11-19 12:10 → 15:43 恢复）

> **本节按「当时记录」保留原文**，末尾追加恢复后的结论。
> 读的时候请注意：下面所有「未做/阻塞/待查」都已在 15:43 之后闭环（见 §5.3）。

**发生时机**：12:04 的 4a 幂等复跑（待办 1）刚开始不久，`prepare-vm` 的探测阶段正常（`[probe] 合并单往返 15.2s`、`DB-3 node = v24.21.0` 都读到了），随后 APPLY 阶段的 `.ps1` 推送后 `-File` 报「实际参数不存在」，紧接着通道彻底消失。

**证据（三段判据全指向「VM 不可达」，而不是 WEDGE）**：

| 探针 | 12:04（正常） | 12:10 起 |
|---|---|---|
| `ping 172.16.100.2` | 通 | **100% 丢包**（连续 5 次 × 2 包） |
| 裸 TCP `22`（读 banner） | `SSH-2.0-OpenSSH_for_Windows_10.4` | **SYN 超时**（TCP 握手都不完成） |
| 宿主 `18443@127.0.0.1/health` | 200 | `000`，8s 超时 |

**这不是先前那个 WEDGE**：WEDGE 的特征是「TCP 能连上但零 banner」（预认证段停摆，网络层无罪）。这次的裸 TCP **连 SYN 都超时**，说明是更底层的不可达。

**排除宿主侧**：同一时刻宿主 `ping 192.168.1.1` → 0% 丢包 2ms；`curl https://gitee.com` → 405（可达）。⇒ 宿主网络完全正常，只有 VM 掉线。

**未做的事（按红线）**：**没有重启 VM**。VM 是本项目唯一的真机验证环境，重启会丢现场（且 `--purge-all` 的 `PendingFileRenameOperations` 现场会一并清掉，反而让 P11 的证据消失）。

**当时阻塞**：待办 1（4a 幂等复验）无法继续 —— 需要 VM 恢复到 ping 可达。

**为什么这次失联「不可解释、也不该解释」**：VM 是嵌套虚拟化里的 guest，宿主的网络栈正常、
guest 的 ARP 都不应答 ⇒ 这一层我们**没有任何可用的遥控手段**（MCP 走 18443 也一起没了）。
按红线不重启 VM，就只能等。**这不是流程缺陷，是单机验证环境的结构性单点**：
唯一的真机验证对象同时也是唯一的取证对象，它掉线时既不能验证也不能取证。
⇒ 已记入待办 10（`--only 4/5` 口径）之外的长期建议：**关键改动应尽量先做到「离线可证伪」**
（本轮 P14/P15/P16 的守卫件就是这个思路，三次都是先离线断言、再真机确认）。

**顺带发现的两条（失联后已离线查清，见 P14 / P15）**：
- `DB-7 global CLI = codebuddy:OK desktop:MISSING browser:MISSING` 但 12:02 的 4c 读到 `browser=33 desktop=25`
  ⇒ **已定位为 P15**：不是两处口径不一致，而是 `bootstrap.mjs` 的 `state` 组装**漏映射**了
  `cliDesktop`/`cliBrowser` 两个键（探测端采集的是 `browserCli`/`desktopCli`）⇒ 日志与计划表恒读
  `undefined`。**执行面本来就是对的**（DB-7 的 .ps1 内部自己 `Get-Command` 重探），所以 4c 能看到真实值。
  **已修**并加守卫件（含交叉错位与删键的反向证明）。
- `-File` 报「实际参数不存在」⇒ **已定位为 P14**：`runRemotePs1` 用**裸文件名**推送，
  而 put 与 exec 是两次独立 `withVmChannel`、各自独立决议后端（sftp 落点 ≠ cmd.exe cwd）⇒
  链路抖过就分裂。11:53 轮同代码成功、12:04 轮失败即此。**已修**为统一绝对路径。

#### 恢复后的收尾（15:43 之后，全部完成）

| 时点 | 事件 | 结果 |
|---|---|---|
| 15:43 | VM 恢复（ping 通、裸 TCP 出 banner） | — |
| 15:49 | 第 1 次 `--only 4`（V1.4.34 无 P16） | 4a 62s 全 `[SKIP]`（**P15 生效**）· 4b **0s FAIL dry-run** |
| 15:51 | 第 2 次（补 `.env` 后） | 4b **183s FAIL**，`VM_START_SWEEP PID=9056 powershell.exe` ⇒ **P16 暴露** |
| 16:00 | 第 3 次（含 P16） | 第 4 步 **245s PASS**、第 5 步 **33s `VERIFY=PASS`** |

**原「剩下仍需真机的一步」已闭环**，两条判据都按预期命中：

```
✅ .ps1 已推送 C:/WinVMBridge/winvm-setup-1795075399254.ps1 → VM      ← P14（绝对路径）
✅ [DB-7] all global CLIs present [SKIP]                              ← P15（不再 MISSING）
✅ VM_START_SWEEP 命中 0 次 + VM 服务已监听 127.0.0.1:18443             ← P16（不自伤）
```

**额外收获（原计划没有的）**：这轮失联恰好把 VM 上的 node + 三 CLI 留在了「已装好」状态，
于是第一次拿到了 **4a 幂等基线 50s**（对比首跑 177s），把「一次性成本」这个假设**实测成了结论**。
