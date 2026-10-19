# 通过铠大师 App 在新鸿蒙机上安装部署 WinVM Bridge（Release 版）

> 状态：设计方案（V1，2026-10-18）· 适用发布版本：**V1.4.0+**（`release/{version}/overall` 三包发布形态）
> 关联文档：`docs/05-peripherals/DEPLOYMENT.md` §9（发布包与一键部署）、`docs/release/RELEASE-V1.4.0.md`、`docs/release/issues.md`

## 1. 背景与目标

本项目部署横跨 **5 个环境层**，其中两层对 WorkBuddy 是硬边界：

| 层 | 说明 | WorkBuddy 可达性 |
|---|---|---|
| L1 鸿蒙宿主 OS | HarmonyOS NEXT，每 App 独立沙箱 + HMMAC，无 root 概念 | ❌ 仅 `$HOME`（hmdfs 共享目录）可读写 |
| L2 WorkBuddy App 沙箱 | `com.tencent.workbuddy`（uid 20020171），自带 node/electron | ✅ 本尊（工作区/沙箱私有 fs） |
| L3 用户共享数据目录 | `/storage/Users/currentUser/`（hmdfs） | ✅ 读写（跨 App 唯一通道） |
| L4 VM Windows 系统层 | OpenSSH Server 安装/防火墙/电源策略等 OS 级前置 | ⚠️ 仅 SSH **之后**可达；sshd 未装时通道不存在（鸡生蛋） |
| L5 VM↔宿主 SSH/隧道 | `ssh/scp` 免密通道 + tunnel-daemon | ✅ 通道建立后 |

**铠大师 App**（自有，鸿蒙端高权限，可在 VM 内安装软件）恰好补齐 WorkBuddy 做不了或做不好的三件事：
1. **L3 落包**：把 release 包放进共享目录（比任何沙箱内传输都稳）；
2. **L4 前置**：VM 侧 OpenSSH Server / 防火墙 / Node /（可选）SSH 公钥注入——解决「sshd 未装则 SSH 通道不存在」的鸡生蛋；
3. **交互降维**：把 WorkBuddy 侧的多步命令压缩成**一条可复制的 install prompt**。

**目标 UX（用户裁定的极简标准）**：铠大师 ≤3 次点击 + 一次粘贴 → 全自动部署 + 验证报告。

## 2. 三方职责矩阵

```
┌─ 铠大师 App ──────────────┐   ┌─ WorkBuddy（宿主沙箱）──────────┐
│ ① 复制 release 包 → L3     │   │ ④ 解包 → bootstrap check/env    │
│ ② VM 一键前置（L4）        │──▶│ ⑤ prepare-vm --apply（幂等兜底） │
│    sshd/防火墙/Node/公钥    │   │ ⑥ deploy-all.sh --wipe          │
│ ③ 生成并复制 install prompt│   │ ⑦ 验证矩阵 7 项 + 落 report     │
└────────────────────────────┘   └───────────────┬─────────────────┘
        （用户动作：粘贴 prompt，仅此一次）          │
                                ┌────────────────▼────────────────┐
                                │ ⑧ deploy-report.json 写回 L3     │
                                │    铠大师读回 → 状态面板显示 ✅/❌ │
                                └──────────────────────────────────┘
```

- **铠大师**：L3 落包 + L4 前置 + prompt 生成 + 结果读回（新功能规格见 §4）。
- **WorkBuddy**：L5 通道（tunnel-daemon）+ 插件安装 + VM 服务部署 + 功能验证——全部由 prompt 驱动，无交互。
- **用户**：点 3 下 + 粘贴 1 次。

## 3. 端到端流程（新鸿蒙机 SOP）

### 阶段 A：铠大师侧（约 1 分钟，3 次点击）

```
A1 [复制包]   release/V1.4.0/overall（或 zip）→ /storage/Users/currentUser/Downloads/winvm-release/
A2 [VM 前置]  对 VM 执行「WinVM 环境准备」（经铠大师既有 VM 软件安装/PowerShell 通道）：
              · OpenSSH Server：Installed 检查 → Add-WindowsCapability（离线回退 MSI）→ Automatic + Running
              · 防火墙：入站 22（仅对内网/虚拟网卡段，服务口 18443 只绑 VM 回环、**无需**开）
              · Node ≥18：缺则静默装（VM 侧服务运行依赖；provider=workbuddy 还依赖 codebuddy CLI，见 §9-G4）
              · 公钥注入（快路径，可选）：把 WorkBuddy 的 id_ed25519.pub 写入
                `~/.ssh/authorized_keys` **及** `C:/ProgramData/ssh/administrators_authorized_keys`（icacls 修 ACL）
                ※ Windows OpenSSH 对 Administrators 组成员**忽略** per-user authorized_keys——不注入此文件免密必失败
A3 [复制指令] 表单填 VM IP / 用户名 / provider → 生成 install prompt → 复制到剪贴板
```

### 阶段 B：用户（10 秒）

打开 WorkBuddy → 新建任务 → **粘贴 A3 的 prompt** → 发送。

### 阶段 C：WorkBuddy 自动执行（约 6–8 分钟，零交互）

prompt 指令 WB 依次做（细节见 §5）：
1. 解包到工作区 → `bootstrap.mjs check`（依赖自检）+ `env`（非交互生成 .env）
2. SSH 免密验证：`ssh -o BatchMode=yes … whoami`——若铠大师 A2 已注入公钥则秒过；失败回退 `bootstrap.mjs trust`（一次密码交互，§9-G2）
3. `bootstrap.mjs prepare-vm --apply --ensure-node`（经 SSH 对阶段 A 做幂等兜底，全 [SKIP] 即证 A2 生效；**必须在免密建立之后**——它经 ssh 执行）
4. `cd release && ./deploy-all.sh --wipe`（发布迭代铁律：先清空历史部署→七相位重装）
5. 验证矩阵 7 项（§6）→ 结果写 `/storage/Users/currentUser/.workbuddy/winvm/deploy-report.json`

### 阶段 D：铠大师读回（1 次点击）

铠大师轮询/手动刷新 `deploy-report.json` → 状态面板显示 `ok` / 失败相位 + traceId 证据。

## 4. 铠大师 App 新功能规格（最小集）

按「越简单越好」原则，功能面 = **一个页面 + 三个按钮 + 一个脚本资产**：

### 4.1 UI：「WinVM 部署」页（新增）

```
┌ WinVM Bridge 部署助手 ────────────────────────────┐
│ 发布包目录:  [选择… ]  → 目标: ~/Downloads/winvm-release │
│ VM 地址:     [172.16.100.__]  用户: [User]  ☑ 提供 SSH 公钥注入 │
│ Provider:    [workbuddy ▾]                          │
│                                                     │
│ [① 复制发布包]   [② VM 环境准备]   [③ 复制安装指令]  │
│ ─────────────────────────────────────────────────── │
│ 部署状态:  ● 等待粘贴安装  /  ✅ 成功(03:41)  /  ❌ VM-START 失败 │
└─────────────────────────────────────────────────────┘
```

### 4.2 按钮契约

| 按钮 | 内部动作 | 失败呈现 |
|---|---|---|
| ① 复制发布包 | 把内置/选定的 `overall` 包拷到 `~/Downloads/winvm-release/`（hmdfs，WB 可读）| 空间不足/权限 → toast |
| ② VM 环境准备 | 经**既有 VM 软件安装通道**推送并执行 `winvm-prepare.ps1`（§4.3），解析 `KV=VALUE` 输出打勾列表 | 逐项 ❌ + 一行修复建议 |
| ③ 复制安装指令 | 按模板（§5.2）填参生成 prompt 到剪贴板 | — |
| （自动）状态读回 | 每 10s 读 `deploy-report.json`（存在即显示），完成后停止轮询 | 超 30min 无文件 → 「WorkBuddy 尚未开始，请粘贴指令」 |

### 4.3 `winvm-prepare.ps1`（铠大师资产，ASCII-only，幂等，可独立演进）

探测先行、只改缺项（与 `delivery/prepare-vm.mjs` DB-1/2/3/公钥注入的判据**保持同一口径**，双实现互证）：

```powershell
# 关键步骤（完整参考实现附录 A）：
# 1) sshd: Get-Service → 缺则 Add-WindowsCapability OpenSSH.Server... → Set-Service Automatic → Start
# 2) firewall: New-NetFirewallRule WinVM-SSH-22（先判存在；Profile Any，RemoteAddress 限内网段）
# 3) node: Get-Command node → 缺则静默装 Node LTS（msiexec /q 或既有软件源）
# 4) pubkey（若提供）：写入 authorized_keys + administrators_authorized_keys + icacls 收紧 ACL
#    （SYSTEM 拥有、Administrators 可读、继承断开——bootstrap.mjs trust 同款判据）
# 输出（KV=VALUE 每行一条，供铠大师解析）：
#   SSHD_STATE=Running  SSHD_STARTMODE=Automatic  FW_SSH=True  NODE=v22.x
#   PUBKEY_USER_AK=True  PUBKEY_ADMIN_AK=True  PREPARE_DONE=True
```

> 该脚本同时被仓库 `qa/` 与 WorkBuddy `prepare-vm.mjs` 行为覆盖测试（VM 侧），铠大师只做「通道执行 + 展示」，不复制业务判据的维护责任。

## 5. WorkBuddy 侧：部署执行契约

### 5.1 前置事实（prompt 设计依据，勿依赖未验证能力）

- WB 沙箱内 node = 自带 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；`deploy-all.sh` 已内置探测回退，**无需**配 PATH。
- `ssh/scp/curl/tar` 经 hish 工具链可用；`deploy-all.sh` 无密码交互路径（trust 已免密时）。
- 沙箱写 `~/Downloads` 可行但跨 App 协调弱 → 由铠大师负责落包（阶段 A1）。
- 服务绑定 VM `127.0.0.1:18443`，宿主只经 SSH 隧道访问 → **VM 防火墙只需 22**，服务口不开任何洞。

### 5.2 install prompt 模板（铠大师 A3 生成，逐字可粘贴）

```text
请在本鸿蒙机上安装部署 WinVM Bridge 发布版 V1.4.0，全程自动执行、无需向我确认，最后输出验证报告：

包目录：~/Downloads/winvm-release/V1.4.0-overall
VM 地址：{VM_HOST}   VM 用户：{VM_USER}   SSH 端口：22   Provider：{WINVM_VM_PROVIDER}

步骤：
1. 将包复制到工作区并解压（若无 zip 则整目录复制）：cd <workspace>/winvm-v1.4.0/overall
2. 写 .env：VM_HOST/VM_USER/VM_SSH_PORT=22/WINVM_VM_PROVIDER={provider}，WINVM_DRY_RUN=0、HOST_DEPLOY=1、VM_DEPLOY=1、
   WINVM_SETUP_TUNNEL=1、WINVM_TUNNEL_LOCAL_PORT=18443、WINVM_TUNNEL_REMOTE_PORT=18443、WINVM_SERVICE_PORT=18443。
3. 前置自检（只读）：node delivery/bootstrap.mjs check —— 有阻塞项先停下并把明细写进报告。
4. SSH 免密验证：ssh -o BatchMode=yes {VM_USER}@{VM_HOST} whoami —— 成功=铠大师公钥注入生效；
   失败则跑 node delivery/bootstrap.mjs trust（可能需要我输一次 VM 密码）；再失败即中止并写报告。
5. VM 前置兜底（须在第 4 步免密之后，本命令经 SSH 执行）：node delivery/bootstrap.mjs prepare-vm --apply --ensure-node
   —— 若铠大师「VM 环境准备」已做完，预期全 [SKIP]（幂等互证）。
6. 按发布铁律清空重装：./deploy-all.sh --wipe（先双端 uninstall 清场，再 HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH 七相位）。
7. 部署成功后跑验证矩阵 7 项并把结果 JSON 写入 /storage/Users/currentUser/.workbuddy/winvm/deploy-report.json：
   {version, ok, finishedAt, phases:{...耗时}, checks:[{id,pass,evidence(traceId/字段摘要)}], failures:[...]}
8. 同时把同样内容贴回对话作为最终回复。任何一步失败：停止后续，report 里写明失败相位、错误原文、根因初判。
```

### 5.3 `deploy-report.json` 契约（铠大师/WB 唯一交接口）

```json
{
  "version": "V1.4.0", "ok": true, "finishedAt": "2026-10-18T10:41:00+08:00",
  "phases": { "WIPE": "17/17 PASS", "HOST": 1.3, "VM": 32.7, "VMSTART": 18.2,
              "TUNNEL": 8.4, "TEST": 0.4, "QAPROBE": 67.1, "HEALTH": 0.5 },
  "checks": [
    { "id": "health",      "pass": true, "evidence": "ok:true provider=workbuddy/ready" },
    { "id": "capabilities","pass": true, "evidence": "count=54 domains=6 tr_xxx" },
    { "id": "systeminfo",  "pass": true, "evidence": "Win11 26200 ARM64 tr_xxx" },
    { "id": "a2a",         "pass": true, "evidence": "steps[0] ok 12.8s tr_xxx" },
    { "id": "gui",         "pass": true, "evidence": "healthy interactive=true" },
    { "id": "audit",       "pass": true, "evidence": "chain=37 receipt=1 card=5skills" },
    { "id": "bothends",    "pass": true, "evidence": "cache=0.1.0 task=Running" }
  ],
  "failures": []
}
```

- 路径固定（L3 共享目录，WB 可写、铠大师可读）；**写完再读**自证（项目坑：写入窗口内读到 0B 假空——WB 落盘后 `stat` 二次确认字节数>0）。

## 6. 验证矩阵（与 DEPLOYMENT.md §9.4 同源，prompt 第 7 步即执行）

| # | 项 | 判据 | 通道 |
|---|---|---|---|
| 1 | /health | ok:true、provider ready、session healthy | 隧道 curl |
| 2 | meta.capability.list | count=54、六域 | MCP 直调 |
| 3 | system.info.get | OS/CPU/内存/isAdmin 实返 | MCP 直调 |
| 4 | a2a.delegate | L1 goal 终态 ok、steps 结构化回执 | A2A |
| 5 | gui.session.status | healthy、interactive、explorerAlive | MCP 直调 |
| 6 | 审计链+Agent Card | 委派 traceId 在链、字段级回执、五技能 | audit.receipt / a2a.health |
| 7 | 双侧部署态 | 宿主缓存版本路径在册、VM 任务 Running、MANIFEST | ls + schtasks |

## 7. 降级路径（无铠大师时仍可部署）

纯 WorkBuddy + 手工：用户自行在 VM 内装 OpenSSH Server（管理员 PowerShell 一行 `Add-WindowsCapability`）、`bootstrap.mjs trust` 输一次密码、`scp` 或共享盘落包——其余步骤（§5.2 的 2–8）完全相同。**铠大师方案没有引入任何新部署语义，只做了「权限补位 + 交互降维」，两条路径共用同一条发布链**（这是方案可行性的根基：发布包/脚本矩阵已被 run1–run4 真机反复验证）。

## 8. 实施分工建议（可直接拆任务）

| # | 工作项 | 落点 | 估量 |
|---|---|---|---|
| K1 | 「WinVM 部署」页 + ①③按钮 + report 轮询 | 铠大师 App | 小（纯 UI+文件 IO） |
| K2 | `winvm-prepare.ps1` 资产 + ②按钮（走既有 VM 软件安装通道） | 铠大师资产库 / 本仓库 `tools/` 双写 | 中（脚本判据对齐 prepare-vm.mjs） |
| K3 | prompt 模板（§5.2）参数化生成 | 铠大师 K1 内 | 小 |
| W1 | `bootstrap.mjs check` 增「离线公钥模式」文档说明（公钥由铠大师注入时 trust 跳过密码路径的行为已在 BatchMode 验证中天然覆盖，只需文档确认） | 本仓库 docs | 极小 |
| W2 | 新鸿蒙机真机演练一次（吃自己的狗粮），结果按发布纪律记 `docs/release/issues.md` 或演练报告 | 联调 | 1 轮真机 |

## 9. 风险与已知坑清单（务必逐条设计规避）

| ID | 风险 | 规避（已内化在上文设计中） |
|---|---|---|
| G1 | Windows OpenSSH **Administrators 组忽略 per-user authorized_keys** | 公钥必写 `administrators_authorized_keys` + icacls ACL（A2-④、prepare 脚本、bootstrap trust 三处同判据） |
| G2 | `bootstrap trust` 需一次密码，与「零交互」冲突 | 快路径=铠大师 A2 注入公钥 → prompt 第 5 步 BatchMode 秒过；密码交互仅兜底 |
| G3 | 新 VM 镜像 sshd 未装（鸡生蛋） | 正是铠大师核心价值：L4 前置在 SSH 之前完成 |
| G4 | provider=workbuddy 依赖 VM 内 codebuddy CLI **登录态**（DB-4 结构性不可脚本化） | 首台机建议先 `WINVM_VM_PROVIDER=workbuddy-deterministic` 跑通全链（零登录依赖），再引导用户完成一次 codebuddy 登录切回 workbuddy；prompt 模板已参数化 |
| G5 | VM 掉线旧隧道黑洞（TCP 通/HTTP 死） | 迭代2 已修：TUNNEL 相位后端 /health 硬判据（evaluateTunnelReuse） |
| G6 | 重装撞 18443 bind EACCES（ps-bridge 孤儿/端口未 drain） | 迭代3 已修：uninstall 先熔断看门狗+三签名查杀；部署端递增等待重试 |
| G7 | hmdfs 不建符号链接 | 落包用**真实目录复制**（K1），勿在共享盘做 junction |
| G8 | 中文文件名路径经 ssh/PS 码页腐化 | 包路径全 ASCII（`winvm-release/V1.4.0-overall`）；PS 载荷 ASCII-only |
| G9 | 铁律「每轮重部署前清空历史部署」 | prompt 第 6 步固定 `--wipe`，不可省略 |
| G10 | report 文件写入窗口假空 | §5.3：写完 stat 二次确认；铠大师读 `finishedAt` 字段存在才采信 |
| G11 | 新鸿蒙机 WB 未安装/未登录 | K1 页面顶部前置检测项①：共享目录存在 + WB 版本探测（可读 `~/.workbuddy/` 结构）；缺则提示用户装 WB |
| G12 | `bootstrap.mjs env --参数` 模式不覆盖 `WINVM_DRY_RUN`（模板缺省=1），而 setup 有「`WINVM_DRY_RUN=1` 时即便 `--apply` 也强制 dry-run」的防呆兜底 → 新机器部署会**全程假成功**（只打印计划不动真格） | prompt 第 2 步**显式写** `WINVM_DRY_RUN=0`；§6 验证矩阵的 traceId 实调证据天然不可伪造，report 缺 traceId 即可判此坑 |

## 附录 A：winvm-prepare.ps1 参考骨架（交铠大师内置资产）

```powershell
# WINVM PREPARE - ASCII only - idempotent - KV output contract
# 运行位置：VM Windows 管理员 PowerShell（由铠大师既有安装通道执行）
$ErrorActionPreference = 'Continue'
param([string]$PubKey='', [int]$SshPort=22)
# --- 1) sshd ---
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  $sshd = Get-Service sshd
}
Set-Service sshd -StartupType Automatic
if ($sshd.Status -ne 'Running') { Start-Service sshd }
Write-Output ("SSHD_STATE=" + (Get-Service sshd).Status)
# --- 2) firewall (inbound 22, intranet only) ---
if (-not (Get-NetFirewallRule -DisplayName 'WinVM-SSH-22' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'WinVM-SSH-22' -Direction Inbound -Protocol TCP `
    -LocalPort $SshPort -Action Allow -Profile Any | Out-Null
}
Write-Output 'FW_SSH=True'
# --- 3) node >= 18 (service runtime) ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -e }
Write-Output ('NODE=' + (& node -v 2>$null))
# --- 4) pubkey injection (G1: BOTH files + ACL) ---
if ($PubKey -ne '') {
  $akUser = "$env:USERPROFILE\.ssh\authorized_keys"; $akAdmin = 'C:\ProgramData\ssh\administrators_authorized_keys'
  foreach ($ak in @($akUser, $akAdmin)) {
    $dir = Split-Path $ak; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $line = $PubKey.Trim()
    if (-not ((Get-Content $ak -ErrorAction SilentlyContinue) -contains $line)) { Add-Content -Path $ak -Value $line }
    if ($ak -eq $akAdmin) {
      icacls $ak /inheritance:r /grant 'SYSTEM:(F)' ('BUILTIN\Administrators:(R)') | Out-Null
    }
  }
  Write-Output 'PUBKEY_USER_AK=True'; Write-Output 'PUBKEY_ADMIN_AK=True'
}
Write-Output 'PREPARE_DONE=True'
```

> 注：本骨架与 `delivery/prepare-vm.mjs` 的 DB 项判据同源；正式版以 `tools/winvm-prepare.ps1` 入本仓库、铠大师直接引用同一资产（单一真相源，K2 任务）。

## 附录 B：时序图

```
用户            铠大师                     共享目录 L3            WorkBuddy(L2)          VM(L4/L5)
 │ ① 打开页面     │                            │                      │                    │
 │                │──复制 release 包──────────▶│                      │                    │
 │ ② 点「VM准备」 │──winvm-prepare.ps1(既有通道)─┼──────────────────────┼───────────────────▶│ sshd/FW/node/pubkey
 │                │◀─────────────KV 输出（全 ✅）┼──────────────────────┼────────────────────│
 │ ③ 点「复制指令」│─按模板生成 prompt           │                      │                    │
 │ ④ 切到 WB 粘贴 ─┼────────────────────────────┼─▶ check/env/prepare兜底/trust(BatchMode秒过)
 │                │                            │   deploy-all.sh --wipe ─────────────────▶│ 清场→七相位
 │                │                            │   验证矩阵 7 项 ◀─────────────────────────│ 54能力/A2A/审计
 │                │                            │◀─deploy-report.json──│                    │
 │ ⑤ 看结果      │◀─轮询读 report──────────────│                      │   （或对话内报告）  │
```
