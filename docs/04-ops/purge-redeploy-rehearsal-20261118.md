# 彻底卸载 → 从零部署 演练报告（2026-11-18）

> 目标：按 `winvm-plugin-deploy` 技能指引，验证「卸载彻底（含 sshd 与密钥）」与「从零部署」两条路径。
> 要求：逐节点记时长与问题，问题给根因与处置，最后总结完善技能。
> 状态：**阶段 A 完成 · 阶段 B 完成 · 阶段 C 阻塞在人工粘一条命令**

---

## 0. 口径

| 项 | 值 |
|---|---|
| 宿主 | 鸿蒙 WorkBuddy 沙箱（uid 20020171） |
| VM | `172.16.100.2`，用户 `User` |
| 技能 | `winvm-plugin-deploy`（演练起点 v2.4.0，演练中因暴露缺口升至 **v2.5.0**） |
| 母项目包根 | `~/wbtmp/rel-v1433/V1.4.33/overall`（`PKG_ROOT` 覆盖；旧值指向 V1.4.31 旧包，见坑 3） |
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

---

## 4. 阶段 B：从零前的通道重建（阻塞点）

通道已断（`22:TIMEOUT`），重建只有一条路 —— 技能设计的唯一人工步骤：在 VM 管理员 PowerShell 粘一条命令（远端下载 `winvm-sshd-oneclick.ps1` 并安装 OpenSSH + 写钥）。

**为什么不能自动**：
- sshd 是 MSI 安装，卸掉后 VM 侧无任何带凭据的自动化面；
- RDP 禁用、445 关闭；
- WinRM 5985 在听，但**只允许 Negotiate/Kerberos（Basic 关闭）**，需要账户口令才能手写 NTLM 握手 —— 当前环境没有 VM 口令。

> 这一条**本身就是技能设计的正确行为**，不是缺陷：卸载阶段绝不为了「后面还要用」而偷偷留后门。

---

## 5. 阶段 C：从零部署（待执行）

计划：粘命令恢复通道 → `deploy.sh` 全链 → 逐节点记时长。

**已在通道缺失状态实测过的部分**（`--only 1`，WALL 20s）：

| 环节 | 耗时 | 行为 |
|---|---|---|
| 1a 通道判定 | 16s | `channel=DOWN`（6s 建连窗口 × 重试） |
| 1p.1 | 1s | SKIP（无可用口令） |
| 1b.1 | 2s | 复用现有密钥（`rotate=0`） |
| 1c.1 | 1s | 打印「从零建通道」那一条命令 |

预期：1p 会因无口令 SKIP → 1b/1c 给命令 → 用户粘 → **1p 成功即整步结束（1b/1c/1d 一个都不跑）** → 第 2/3/4/5 步在空白 VM 上跑。

---

## 6. 时长汇总（已得）

| 阶段 | WALL | 最大单项 |
|---|---|---|
| 原生 undeploy（1+2+3） | **86s** | 2c 停服务+卸模块 **42s** |
| deploy 第 1 步（通道缺失） | **20s** | 1a 通道判定 16s |
| deploy `--only 4`（v2.4.0 真机，参考） | 241s | 4b 推包 **149s** |
| deploy `--only 5` | ~30s | 三探针 16s |

---

## 7. 结论与待办

**已闭环**：P1（v2.5.0 `--purge-all`）、P2、P3、P5、P6、P7、P8 全部修完并有门禁覆盖（`SELFCHECK=ALL_GREEN checks=27` / `ALL_CAUGHT 42/42`）。

**待办**：
1. 🔴 阶段 C 未跑：需用户在 VM 粘一次命令恢复通道（唯一人工步骤）。
2. 🔴 彻底卸载的 2e + `--purge-sshd` 尚未真机跑过（本轮只做了离线载荷校验：占位符全替换、base64 逐字节回环一致、括号平衡、wrapper 与未来时刻都在；兜底命令已真机打印验证）。
3. 卸载侧仍无「卸载后自动核对残留清单」的汇总行（现在靠 2d + 2e 两段分别断言）。
4. `3a` 在通道本就 DOWN 时要烧 16s（6s 建连窗 × 重试）。可考虑把窗降到 3s，收益约 8s，但要确认不误判「慢但活着」的通道。
