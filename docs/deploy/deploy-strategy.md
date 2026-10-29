# WinVM Bridge 部署策略（v2 · 从零安装）

> 文档 ID：DEPLOY-STRATEGY-v2
> 状态：**已在本机（鸿蒙宿主 + Win11 VM）逐步骤实测**
> 更新：2026-10-26
> 适用：全新宿主 / 完全重装 / 灾备重建
> 关联：`docs/INSTALL-GUIDE.md`（逐项细节）、`docs/02-design/SECURITY-GOVERNANCE.md`（安全约束）、`delivery/*.mjs`（实现）

---

## 0. 一句话结论

**六步策略可行，但第 1 步必须带一个硬前置：VM 账户不能使用「空密码」。** 空密码 SSH 登录被
**两层串联**拦截（实测两层同时处于「拒绝」状态）：① OpenSSH `PermitEmptyPasswords` 默认 `no`；
② Windows LSA `LimitBlankPasswordUse=1` 禁止空密码账户**网络登录**。只改任一层都必然失败。
→ 首选让用户设非空密码；确实要保持空密码时按 §2.1-B 同时放行两层，并在建好免密通道后
**立即回滚**。其余五步（免密通道、Release 获取与校验、VM-service 远程部署、宿主插件+隧道、
全维度测试）均已实测通过。部署跑通后进入 **Step 6 交付引导**（加载 `hos-win-skill` 并示范
如何正确下发 VM 任务），它不参与部署判据，但决定后续任务的**通道路由是否正确**。

| 步骤 | 结论 | 关键前置 | 实测 |
|---|---|---|---|
| 1 密码登录 + 建免密通道 | ✅ 可行（需非空密码） | VM 账户有密码；宿主有 `ssh`；Windows 管理员组用户需写 `administrators_authorized_keys` | ✅ |
| 2 获取 Release 并校验解压 | ✅ 可行 | 出网（GitHub）；`curl`+`sha256sum`+`unzip` | ✅ |
| 3 远程部署 VM-service | ✅ 可行 | 免密通道；VM 有 Node ≥18 | ✅ |
| 4 安装宿主插件 + 隧道 | ✅ 可行 | 免密通道；宿主 Node ≥18 | ✅ |
| 5 连通性/健康/功能全测 | ✅ 可行 | 隧道在线；provider 就绪 | ✅ |

---

## 0.5 部署参数变量表（Variable Manifest）

> **生成最终 `deploy-prompts.md` 前，必须逐项与用户确认本表。** 下表所有值均为本机实测默认值；
> 换机器 / 换网络时只改本表，不要改正文命令（正文一律用变量引用）。
>
> ⚠️ **密码不入库**：`VM_PASSWORD` 仅存于运行期环境变量 `WINVM_SSH_PASSWORD`；仓库、文档、
> `.env` 都不写明文。下表只标注「运行时注入」。

### A. 目标环境

| 变量 | 默认值 | 含义 / 来源 | 确认 |
|---|---|---|---|
| `VM_HOST` | `172.16.100.2` | Windows VM IP（局域网固定地址） | ☐ |
| `VM_USER` | `User` | VM 账户（**Administrators 组成员**，决定公钥落点） | ☐ |
| `VM_PASSWORD` | *运行时注入*（`WINVM_SSH_PASSWORD`） | 仅第 1 步密码认证用；**必须非空**（见 §2.1-B） | ☐ |
| `VM_PW_MODE` | `normal` | `normal`=设非空密码（推荐）／`blank-allow`=两层放行空密码（**免密建好即回滚**，见 §2.1-B） | ☐ |
| `VM_SSH_PORT` | `22` | VM sshd 端口 | ☐ |
| `VM_SHELL` | Git Bash(MSYS) | 远端默认 shell；决定「逻辑写 `.ps1` 再 `-File` 执行」铁律 | ☐ |

### B. 分发包

| 变量 | 默认值 | 含义 | 确认 |
|---|---|---|---|
| `GITHUB_REPO` | `athronix/workbuddy-virtual-win-plugin` | 仓库全名 | ☐ |
| `RELEASE_URL` | `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/latest` | latest 跳转链接 | ☐ |
| `RELEASE_TAG` | `V1.4.6`（由 latest 解析，2026-10-29 上架；历史 run 用 `V1.4.5`/`V1.4.4`） | 发布标签 | ☐ |
| `ZIP_NAME` | `winvm-overall-V1.4.3.zip` | 分发单元（V1.4.3 起含 delivery/tools/ + qa/deploy-probes/ + verify-release.mjs） | ☐ |
| `ZIP_SHA256` | `dc417bf2…c4d468`（91 B sidecar；V1.4.6） | 整包校验值 | ☐ |
| `PKG_FILES` / `PKG_BYTES` / `PKG_TOTAL` | `881` / `7606427` / `2562a598…473fbe` | MANIFEST 三元组（重装核对用；V1.4.6 实算=匿名回环三向一致，历史 V1.4.5=879/7580107/88fd11c1…；包内快照自指限制见 deploy-prompts v2.0 行——权威=包内 MANIFEST.txt/sidecar） | ☐ |
| `DEPLOY_ROOT` | `~/winvm-deploy` | 宿主解压根 | ☐ |
| `PKG_DIR` | `$DEPLOY_ROOT/pkg` | zip + sidecar 存放 | ☐ |
| `PKG_ROOT` | `$DEPLOY_ROOT/overall-root/overall` | 解压后的包根（脚本入口所在） | ☐ |

### C. 服务与端口

| 变量 | 默认值 | 含义 | 确认 |
|---|---|---|---|
| `VM_SERVICE_PORT` | `18443` | VM-service 监听端口 | ☐ |
| `VM_SERVICE_BIND` | `127.0.0.1` | **仅回环**，VM 零对外暴露 | ☐ |
| `TUNNEL_LOCAL_PORT` | `18443` | 宿主侧隧道本地端口（与 VM 端口同号） | ☐ |
| `MCP_PATH` | `/mcp` | MCP 直调通道 | ☐ |
| `A2A_PATH` | `/a2a` | A2A 复杂委派通道 | ☐ |
| `SCHEDULED_TASK` | `WinVMBridge.Service` | VM 计划任务名（托管 `ps-bridge.ps1`） | ☐ |
| `BRIDGE_DIR` | `C:/WinVMBridge` | VM 侧程序目录 | ☐ |
| `VM_WORKSPACE` | `C:/WinVMWorkspace` | VM 侧工作区 | ☐ |

### D. 宿主侧落点

| 变量 | 默认值 | 含义 | 确认 |
|---|---|---|---|
| `HOST_STATE_DIR` | `~/.workbuddy/winvm` | `vm-conn.json` / `tunnel.pid` / `tunnel.state.json` / `tunnel.log` | ☐ |
| `HOST_PLUGIN_CACHE` | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0` | 插件缓存（单文件白名单，9 文件） | ☐ |
| `HOST_SKILL_DIR` | `~/.workbuddy/connectors/skills/connector-winvm` | Skill 缓存落点（**=8 含 hos-win**，HEAD 与 V1.4.3 包一致；历史 V1.4.2 包=7 属 G-1，已随 V1.4.3 收敛） | ☐ |
| `SSH_KEY` | `~/.ssh/id_ed25519` | 宿主身份密钥 | ☐ |
| `ASKPASS` | `~/wbtmp/askpass.sh` | 密码非交互化脚本（`chmod 700`） | ☐ |

### E. 行为开关

| 变量 | 默认值 | 含义 | 确认 |
|---|---|---|---|
| `AGENT_PROVIDER` | `workbuddy` | VM 侧 Agent 实现（**用户裁定为默认**；`workbuddy-deterministic` 为基准/对照档；`hermes-agent` 三方） | ☐ |
| `WINVM_WORKBUDDY_CLI` | `codebuddy` | `provider=workbuddy` 时 VM 内 LLM CLI 可执行名 | ☐ |
| `WINVM_DELEGATION_REQUIRED_POLICY` | `on` | 服务端审批闸（L2/L3 需授权） | ☐ |
| `READY_BUDGET` | `180s` | 端到端就绪预算 | ☐ |
| `IDLE_TTL` | `300s` | 空闲回收（LLM provider 冷启动 ~49s 的外部特性） | ☐ |
| `MCP_TIMEOUT_DEFAULT` / `MCP_TIMEOUT_MAX` | `10s` / `600s` | MCP 工具超时区间 | ☐ |
### F. VM 侧运行时前提（Step 3 的 3.0 自检项）

| 变量 | 默认值 | 本轮实测 | 含义 | 确认 |
|---|---|---|---|---|
| `VM_MIN_NODE` | `18.0.0` | `v24.21.0` | VM 内 Node 版本下限（`preflight.vm-node` 的同一个判据） | ☐ |
| `VM_NPM_REQUIRED` | `true` | `11.19.0` | VM 内 npm 必须可用（`preflight.vm-npm`） | ☐ |
| `VM_AGENT_CLI` | `codebuddy` | `2.167.0` | `provider=workbuddy` 时 `preflight.vm-agent-cli` 探测的命令名 | ☐ |
| `VM_AGENT_CLI_PKG` | `@tencent-ai/codebuddy-code@latest` | `latest=2.176.0`（VM 现装 2.167.0） | 缺失时用于 `npm i -g` 的包名；**默认取 latest，不锁定版本号**（用户裁定） | ☐ |
| `VM_NODE_PM` | `nvm-windows 2.0.0` | `* 24.21.0 (default)` | Node 版本管理器（**已装**）；切版本会使全局 CLI 失效，见 §4 Step 3.0 | ☐ |
| `VM_AUTH_DIR` | `~/.codebuddy` | `settings.json,user-state.json` | 登录态探测标记目录（`evaluateAgentLogin` 同源） | ☐ |

> VM 侧完整链路 = **node ≥18 → npm → codebuddy CLI → 已登录**。前三项由 `preflight` 硬门禁
> （`blocking=true`），缺任一项 `deploy-vm --apply` 直接中止；**登录态只能降级探测**（codebuddy
> 无非交互身份命令），故第 4 项靠 `AUTH_VERDICT=config-dir-present` + 首次委派实测。


---

## 1. 环境事实基线（本机实测，2026-10-26）


| 项 | 事实 | 取证方式 |
|---|---|---|
| 宿主 OS | HarmonyOS NEXT，WorkBuddy 沙箱 | `process.platform=openharmony` |
| 宿主工具 | `ssh(OpenSSH_9.6p1)` / `scp` / `unzip` / `tar` / `sha256sum` / `curl` / `node` | `command -v` |
| **`sshpass`** | **不存在** → 密码认证必须用 `SSH_ASKPASS`（见 §4 Step 1） | `command -v sshpass` |
| VM | `172.16.100.2:22`，账户 `User`（**Administrators 组**），密码非空 | `whoami /groups` → `isAdmin=True` |
| VM sshd | `sshd` Running/Automatic；`PermitEmptyPasswords` 默认 `no` | `Get-Service sshd`、`sshd_config` |
| **空密码网络登录** | **被禁**：`HKLM\SYSTEM\CurrentControlSet\Control\Lsa\LimitBlankPasswordUse=1` | 实测空密码 → `Permission denied` |
| VM 服务端口 | `18443`，**仅回环**（VM 零对外暴露） | `Get-NetTCPConnection` |
| 公钥落点 | 管理员组用户走 `C:\ProgramData\ssh\administrators_authorized_keys`（**不是** `~/.ssh/authorized_keys`），且 ACL 必须仅 `SYSTEM + Administrators` | `sshd_config:88` + 实测 |
| 最新 Release | `V1.4.3`（10-26 上架），资产 `winvm-overall-V1.4.3.zip`（2,764,412 B）+ `.zip.sha256`（91 B）；历史 `V1.4.2`=2,722,056 B | GitHub API |
| **VM 运行时链** | `node v24.21.0` / `npm 11.19.0` / `codebuddy 2.167.0`（`@tencent-ai/codebuddy-code`）；由 **nvm-windows 2.0.0** 管理，全局包在 `%LOCALAPPDATA%\Author Software\nvm\installs\v24.21.0\` | `vm-env-check.ps1`（§4 Step 3.0） |
| VM 权限/会话 | ssh 会话为**管理员**上下文（`IS_ADMIN=true`）、**非交互**（`SESSIONNAME` 空） | 同上 |
| **`winget`（VM）** | 命令存在但 `--version` **输出为空且 exit 0**（MSIX alias 空壳）→ 非交互 ssh 下不可用 | 只读探针 |
| **空密码网络登录** | **两层同时被拒**：OpenSSH `PermitEmptyPasswords` = 默认 `no`（该行为注释）+ LSA `LimitBlankPasswordUse=1` | 只读探针；空密码实测 → `Permission denied` |
| 测试基线 | `qa/p3-batch-sweep/gate-docs-overview.txt`（128 文件 / 2280 例 / 0 fail） | 门禁快照 |

> **密码信息不落库**：本文档与仓库任何文件都不得写入 VM 密码。密码只存在于运行期环境变量
> （`WINVM_SSH_PASSWORD`）或调用方交互输入。

---

## 2. 可行性与风险逐条论证

### 2.1 第 1 步：密码登录 + 建立免密通道

**结论：可行，但有三个容易踩空的点。**

1. **非交互密码输入**：WorkBuddy 的 bash 无 TTY，`ssh` 的密码提示无法人工输入，且本机无
   `sshpass`。唯一可靠路径是 OpenSSH 自带的 askpass 机制：
   ```sh
   # askpass 脚本从环境变量读密码，绝不硬编码
   printf '#!/bin/sh\nprintf "%%s\\n" "$WINVM_SSH_PASSWORD"\n' > ~/wbtmp/askpass.sh
   chmod 700 ~/wbtmp/askpass.sh
   DISPLAY=:0 SSH_ASKPASS=$HOME/wbtmp/askpass.sh SSH_ASKPASS_REQUIRE=force \
     ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password \
         -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=accept-new \
         User@172.16.100.2 "echo PASSWORD_AUTH_OK"
   ```
   实测输出 `PASSWORD_AUTH_OK`；空密码则 `Permission denied`（见 §1）。
   注意：`SSH_ASKPASS_REQUIRE=force` 需要 OpenSSH ≥ 8.4（本机 9.6 满足）。

2. **公钥落点选错会「看起来成功、实际仍要密码」**：Windows OpenSSH 对 **Administrators 组**
   成员**忽略** `%USERPROFILE%\.ssh\authorized_keys`，只读
   `C:\ProgramData\ssh\administrators_authorized_keys`。`delivery/bootstrap.mjs trust`
   已实现「两处都写 + `icacls /inheritance:r` 只留 SYSTEM/Administrators」，这是推荐入口。

3. **两种操作模式**：
   - **交互式（人在电脑前）**：`node delivery/bootstrap.mjs trust` —— 一次密码提示，自动生成
     `~/.ssh/id_ed25519`、写入两处 authorized_keys、修 ACL。
   - **非交互（WorkBuddy 自动执行）**：用 §2.1-1 的 askpass 通道自建 key 并写入（见 §4 Step 1），
     或把 `WINVM_SSH_PASSWORD` 注入环境后跑 `bootstrap trust`（`ssh` 无 TTY 时自动走 askpass）。

**失败模式**：账户空密码（本文 §1 已证）／密码错／Administrators ACL 未收紧（sshd 拒绝该文件）／
防火墙未放行 22。→ 逐项判据见 §5 排错表。

#### 2.1-B 空密码账户的处置（分支预案）

**首选：让用户设一个非空密码**（改完后重跑 Step 1 即可，无需改任何系统策略）。
这是唯一不降低安全基线的路径，也是本策略实测采用的路径。

**次选：若用户坚持保持空密码**，必须**同时**放开两层，只改一层一定失败——两层是**串联**的：

| 层 | 位置 | 该改什么 | VM 实测现值（2026-10-26） |
|---|---|---|---|
| ① OpenSSH | `C:\ProgramData\ssh\sshd_config`（**不是 Program Files**） | `PasswordAuthentication yes`（默认已 yes）<br>`PermitEmptyPasswords yes`（默认 **no**，必须显式写） | 两行**均被注释**：`#PasswordAuthentication yes`、`#PermitEmptyPasswords no` → 生效值 = `yes` / **`no`** |
| ② Windows LSA | `HKLM\SYSTEM\CurrentControlSet\Control\Lsa` → `LimitBlankPasswordUse`（DWORD） | 设为 **`0`**（默认 `1`） | **`=1`**（启用 → 直接拒绝网络登录） |

```powershell
# ① OpenSSH 层（VM 内，管理员）：取消注释并置 yes，然后重启服务
$cfg = 'C:\ProgramData\ssh\sshd_config'
$t = Get-Content $cfg -Raw
$t = $t -replace '(?m)^#\s*PermitEmptyPasswords\s+no\s*$', 'PermitEmptyPasswords yes'
if ($t -notmatch '(?m)^PermitEmptyPasswords\s+yes') { $t += "`r`nPermitEmptyPasswords yes`r`n" }
Set-Content -Path $cfg -Value $t -Encoding ASCII
Restart-Service sshd

# ② LSA 层（PowerShell 以管理员运行即可，无需重启）
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name LimitBlankPasswordUse -Value 0 -Type DWord
```

判据（改完立即验，仍用 §2.1-1 的 askpass 通道）：

```sh
WINVM_SSH_PASSWORD='' DISPLAY=:0 SSH_ASKPASS=$HOME/wbtmp/askpass.sh SSH_ASKPASS_REQUIRE=force \
  ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password \
      -o NumberOfPasswordPrompts=1 User@172.16.100.2 "echo BLANK_PW_OK"
```

> ⚠ **风险必须由用户确认后执行**：`LimitBlankPasswordUse=0` 意味着该机器上**所有**空密码本地账户
> 都可被网络登录（SSH/RDP/SMB 全算），等于把「物理接触才能登录」的保护降为「网络可达即可试」。
> 家庭版无 `secpol.msc`，只能走注册表；专业版可用
> `secpol.msc → 本地策略 → 安全选项 → 「账户:使用空白密码的本地账户只允许进行控制台登录」→ 已禁用`。
> 域账户 / Microsoft 账户不受此策略约束（它们必有密码）。
> **改完应在建好免密通道后立刻回滚**（把值改回 `1`、`PermitEmptyPasswords` 改回 `no` 并
> `Restart-Service sshd`）——免密通道建成后 Step 2~5 全程只用公钥，不再需要密码。

> **实测记录 · 空密码双层取证（2026-10-26 17:3x，只读探针）**
>
> `LSA_LimitBlankPasswordUse=1`；`sshd_config` 中 `PasswordAuthentication` 与
> `PermitEmptyPasswords` **两行都被注释**（`#…yes` / `#…no`），`Include` 为空；
> `Get-LocalUser User` → `PasswordRequired=False`（当时为空密码账户）、`sshd=Running`。
> → **两层同时处于「拒绝」状态**，这正是此前空密码 `Permission denied` 的完整解释（不是单点问题）。
> 后来用户设置密码（`PasswordLastSet=2026/10/26 15:59:23`）后 Step 1 一次通过。
>
> **上面 ① 的 PowerShell 片段已做 dry-run 验证**（只读、不写 `sshd_config`）：
> `ORIG_HAS_COMMENTED=True` → 替换后 `RESULT_HAS_EFFECTIVE=True`、`RESULT_COMMENTED_LEFT=False`、
> `LINE_DELTA=-1`（注释行被就地替换，未冗余追加）、`IDEMPOTENT=True`（二次执行零变化）。
> 即该片段可**原样复制执行**；尤其"已存在生效行就不再追加"的分支经实测命中，不会把文件改脏。


### 2.2 第 2 步：从 GitHub Release 获取并校验

**结论：可行，且是比「传仓库压缩包」更可复现的分发方式。**

- 分发单元是 `winvm-overall-<ver>.zip`（包根 = `overall/`，含 host ∪ vm ∪ bootstrap/prepare-vm/
  uninstall ∪ 文档与 `tools/winvm-prepare.ps1`），伴生 `.zip.sha256`。
- 校验三层：① `sha256sum -c <zip>.sha256`（传输完整性）；② 包内 `MANIFEST.txt`
  （`total-sha256` + 逐文件 sha256）；③ 包内已构建 `dist/`，安装时 `--skip-build` 依赖 ② 的指纹。
- 仓库为 public，匿名 `curl -fL` 即可，无需 token。

**风险**：release 未上架／资产被替换（用 sha256 旁挂可发现）／解压工具缺失（本机 `unzip` 在）。
**替代**：无网环境走「整包 tgz 拷贝」（`docs/INSTALL-GUIDE.md` §前置）。

### 2.3 第 3 步：远程部署 VM-service

**结论：可行。** `delivery/deploy-vm.mjs --apply --skip-build` 在宿主端运行：scp 产物 →
`ssh install-vm.mjs` → 注册计划任务 `WinVMBridge.Service`（登录即启、崩溃重启）→ 拉起并轮询
VM 回环 `18443`。

**先行条件（Step 3.0，缺一即中止）**：VM 内 **node ≥18**、**npm**、**codebuddy CLI** 三项由
`preflight.checkLocalVmDeps` 硬门禁（`blocking=true`）；`provider=workbuddy` 另有**登录态**要求
（只能降级探测，见 §0.5-F）。`deploy-vm` 对缺失只**报错不代装**，故本策略把「检查 + 补齐」
前移为 3.0 独立步骤（`qa/deploy-probes/vm-env-check.ps1`，支持 `-Fix` 只补 npm 包）。

**判据**：`schtasks /query` 存在且 Running；`Get-NetTCPConnection -LocalPort 18443` LISTENING；
**VM 本机** `curl 127.0.0.1:18443/health` 返回 `ok:true`。
**风险**：VM Node <18（preflight 拦截）；计划任务需交互式会话（GUI 能力依赖 LogonTrigger）；
`provider=workbuddy` 需 VM 内 codebuddy **已安装且已登录**（否则 preflight 直接阻断，或运行期降级
`workbuddy-deterministic`）。
**已实测的安装面**（2026-10-26）：VM 用 **nvm-windows 2.0.0** 管 Node，全局包落在
`%LOCALAPPDATA%\Author Software\nvm\installs\v24.21.0\`（非 `C:\Program Files\nodejs`）；
`npm i -g` 写该目录**无需提权**（`--dry-run` → `changed 102 packages in 16s`）。
**关键耦合**：`nvm use <其它版本>` 会切换 prefix 前缀 → **全局 codebuddy 立即「消失」**，
换版本后必须重装 CLI。

### 2.4 第 4 步：宿主插件 + 隧道

**结论：可行。** `install-host.mjs --yes` 落插件缓存（单文件白名单 + A2A 桥）、8 个 Skills、
连接器声明（`connector:winvm` / `connector:winvm-a2a`，写入活跃账户 `mcp.json`）、`settings.json`
启用与沙箱写白名单、`~/.workbuddy/winvm/` 运行态；随后隧道常驻守护 `tunnel-daemon.mjs`
（`winvm-plugin tunnel ensure`）。

**判据**：`--check-fresh` 对账面 FRESH；`tunnel status --json` 为 RUNNING；宿主
`curl 127.0.0.1:18443/health` 返回 `ok:true`。
**风险**：`new session` 才会注入 MCP 工具（同会话不刷新，见 §5）；插件缓存新增相对依赖必须同时进
`extraFiles` 与 `buildIntegrityFilePairs`（否则 `ERR_MODULE_NOT_FOUND`）。

### 2.5 第 5 步：全维度测试

**结论：可行。** 三层：
1. **连通性**：隧道 RUNNING + `/health`；`POST /mcp` 的 `tools/list` 可枚举 54 能力（点分名）；
2. **健康性**：`/health` 的 `provider/session` 字段；`meta.health.check`、`meta.session.status`；
3. **功能性**：跨域抽样调用（system/storage/app）+ A2A 委派冒烟（`a2a.health`，复杂任务走流式审批）。

**风险**：`/mcp` 与 `/a2a` **不在** bearer 豁免表内——若 `enforceBearer=true` 且配置了 token，
必须带 `Authorization: Bearer`；走回环隧道时默认不启用（`loopback-only` 豁免形态）。
GUI 类能力需已登录的交互式会话（锁屏态不可测）。

---

## 3. 六步流程（总览）

```
[0] 前置：VM 有密码 + sshd 22 + 防火墙放行 + Node≥18 ；宿主出网
     │
[1] 密码通道 ──► 生成 ed25519 ──► 写入 administrators_authorized_keys(+ACL)
     │                               └─► 验证：key-only 免密 whoami
[2] 下载 winvm-overall-<ver>.zip + .sha256 ──► sha256sum -c ──► unzip ──► overall/
     │
[3.0] VM 运行时自检：node≥18 ─► npm ─► codebuddy CLI ─► 登录态（缺则先装）
     │        └─ vm-env-check.ps1 → ENV_PRECHECK=PASS (BLOCKERS=none)
[3] deploy-vm.mjs --apply --skip-build ──► 计划任务/端口/健康（VM 本机）
     │
[4] install-host.mjs --yes ──► tunnel ensure ──► 宿主 health + check-fresh
     │
[5] 连通性/健康/功能测试 ──► qa/real-test-<date>-run<N>.md
     │
[6] 交付引导（不参与判据）：加载 hos-win-skill ──► 通道速判 ──► 任务下发示范
```

> Step 3.0 是**硬前置**：`deploy-vm` 的 `preflight` 对 node/npm/agent-CLI 均为 `blocking`，
> 缺任何一项 `--apply` 会**直接中止**（不是警告）。故必须先在 3.0 把环境补齐再进 Step 3。

---

## 4. 分步操作手册

### Step 0 · 前置检查

```sh
# VM 侧（经密码通道执行一次）
ssh User@172.16.100.2 "powershell -NoProfile -Command \"node -v; [bool](Get-Service sshd)\""
# 宿主侧
ssh -V; unzip -v | head -1; command -v sha256sum curl
```
判据：VM `node ≥ v18`；`sshd` True；宿主三项工具齐全。

### Step 1 · 密码登录 → 免密通道

```sh
VM_HOST=172.16.100.2; VM_USER=User
# 1.1 密码通道自检（askpass，见 §2.1-1）
# 1.2 生成宿主密钥（若已存在则跳过）
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
PUB="$(cat ~/.ssh/id_ed25519.pub)"
# 1.3 经密码通道写入两处 authorized_keys 并收紧 ACL（MSYS 规则：远端逻辑走 .ps1）
#     推荐直接用项目自带入口（交互）：
#       node delivery/bootstrap.mjs trust
#     自动化（无 TTY）：
#       WINVM_SSH_PASSWORD=*** node delivery/bootstrap.mjs trust
# 1.4 判据：禁用密码/公钥以外的认证，只靠 key 登录成功
ssh -o BatchMode=yes -o PreferredAuthentications=publickey User@$VM_HOST "whoami && echo KEY_OK"
```
判据：`KEY_OK`。若仍提示密码 → 检查 `administrators_authorized_keys` 的 ACL 与落点（§2.1-2）。

> **若是空密码账户**（Step 1.1 报 `Permission denied`）：**不要再猜密码**，直接走 §2.1-B 分支——
> ① 请用户设非空密码（首选，改完从 1.1 重跑）；② 用户坚持空密码时，需**同时**放行 OpenSSH 层
> （`PermitEmptyPasswords yes` + `Restart-Service sshd`）与 LSA 层（`LimitBlankPasswordUse=0`），
> 判据 `BLANK_PW_OK`，**且在建好免密通道后立即回滚这两层**（之后全程只用公钥）。

> **实测记录 Step 1 · 2026-10-26 16:07 · PASS**
>
> - **askpass 落地**：`~/wbtmp/askpass.sh` 内容 `#!/bin/sh\nprintf "%s\n" "$WINVM_SSH_PASSWORD"`，`chmod 700`；调用时必须同时给 `DISPLAY=:0`（否则 OpenSSH 拒绝走 askpass），并置 `SSH_ASKPASS_REQUIRE=force`（OpenSSH ≥ 8.4；本机 9.6p1）。
> - **密码通道自检**：`ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1` → `PASSWORD_AUTH_OK`。
> - **公钥注入的引号陷阱（关键经验）**：公钥含空格与 `+/`，内联 `-Key "<PUB>"` 经 MSYS 两层 shell 转义极易 `unexpected EOF`。**改用 base64 单参数**：宿主 `PUBB64=$(cat ~/.ssh/id_ed25519.pub | base64 -w0)`，远端脚本 `param([string]$KeyB64)` + `[Convert]::FromBase64String` 解码 → 零引号问题，且天然 ASCII 安全。
> - **两处落点都写**：`C:\Users\User\.ssh\authorized_keys`（1 行，新增）与 `C:\ProgramData\ssh\administrators_authorized_keys`（原有他人 key 1 行 → 变 2 行，**幂等去重 `-notcontains`，绝不覆盖**）。`User` 属 Administrators 组，故管理员文件才是生效落点。
> - **ACL 收紧**：`icacls $adminFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'`（用 **SID 而非名称**，规避本地化 SYSTEM/Administrators 名称差异）。执行后 icacls 仍列出 `User:(F)`、`Administrator:(R)` 等显式历史 ACE —— **这是无害的**：User 属于 Administrators，sshd 的 ACL 校验通过；判据以「公钥登录是否成功」为准，不以 icacls 行数为准。
> - **最终判据**：`ssh -o BatchMode=yes -o PreferredAuthentications=publickey -o NumberOfPasswordPrompts=0 User@172.16.100.2 "whoami"` → `User`，退出码 0。**KEY_OK**。
> - **收尾**：`qa/tmp-trust.ps1` 与 VM 侧 `C:/Users/User/tmp-trust.ps1` 均为临时探针，用后即删，不入库（`delivery/bootstrap.mjs trust` 是正式入口）。

### Step 2 · 获取 Release 并校验解压

```sh
VER=V1.4.3   # 历史 run 为 V1.4.2；V1.4.3=10-26 缺口收编版
BASE=https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/$VER
# 关键：github.com 在本网段存在抖动（GET 偶发 60s 超时）。必须带 --retry-all-errors + -C -，
# 且用绝对 URL 而非 latest 跳转（latest 多一跳 302，放大抖动）。
curl -fsSL --connect-timeout 20 --max-time 900 --retry 5 --retry-delay 3 --retry-all-errors -C - \
     -o winvm-overall-$VER.zip        $BASE/winvm-overall-$VER.zip
curl -fsSL --connect-timeout 20 --max-time 120 --retry 5 --retry-delay 3 --retry-all-errors \
     -o winvm-overall-$VER.zip.sha256 $BASE/winvm-overall-$VER.zip.sha256
sha256sum -c winvm-overall-$VER.zip.sha256          # 必须 OK
mkdir -p ~/winvm-deploy/overall-root && unzip -q -o winvm-overall-$VER.zip -d ~/winvm-deploy/overall-root
cd ~/winvm-deploy/overall-root/overall && ls MANIFEST.txt delivery/install-host.mjs
grep -m1 '^total-sha256' MANIFEST.txt                # 记录指纹
# 包内完整性（第三层）：用 §7 附带的 verify-manifest.py 复算 867 文件 + total-sha256
python3 ~/wbtmp/verify-manifest.py ~/winvm-deploy/overall-root/overall
```
判据：`sha256sum -c` → `OK`；`overall/delivery/*.mjs` 存在；`MANIFEST.txt` 存在；
`verify-manifest.py` → `RESULT: PASS`。

> **实测记录 Step 2 · 2026-10-26 16:14 · PASS**
>
> - **网络抖动（首要坑）**：首次下载 `curl: (28) Failed to connect to github.com port 443 after 65559 ms`。
>   同一时刻 `api.github.com` 正常、`curl -I https://github.com` 三次分别 `connect=0.10s / 1.11s / 0.09s`
>   → **不是封禁，是链路抖动**。判据：`curl -sS -o /dev/null -w '%{http_code} connect=%{time_connect}' -I https://github.com`
>   连续几次能拿到 `200` 即恢复。**处置**：`--retry 5 --retry-delay 3 --retry-all-errors -C -`
>   （`--retry-all-errors` 才能覆盖 connect timeout；默认 `--retry` 只重试 HTTP 5xx）。
> - **不要用 `releases/latest`**：多一跳 302 到 `release-assets.githubusercontent.com`（签名 URL，
>   有效期 1h），抖动窗口翻倍。直接用 `releases/download/<TAG>/<ZIP_NAME>` 绝对地址。
> - **实测数值**：zip `2,722,056 B`、sha256 `a06e75206dadb4a895bdd3b02762aca7315f3973845c6f99d86eb54a9d00e149`
>   （与 sidecar 逐字节一致）；解压后 `overall/` **867 文件 / 7,313,511 B** /
>   `total-sha256 8d753c700848c9ef4280038497db8009f5d8d359be0a129e01721b7abecdd3a3`。
> - **`total-sha256` 口径**（复算必须同口径，否则假红）：`sha256( rows.join('\n') )`，
>   `rows = 每个文件一行 "\<relpath>  \<sha256>"`（**两个空格**分隔），按路径排序，**不含 MANIFEST.txt 自身**
>   —— 对应 `delivery/pack-release.mjs:318`。
> - **解析 MANIFEST 的坑**：头部有 `version:` / `commit:` / `date:` / `package:` 等行，
>   它们不含双空格，若按「末段双空格切分」会把 `version: V1.4.2` 当文件名 → 假 FAIL（首跑就是栽在这）。
>   **必须先定位 `# ---- per-file (relpath  sha256) ----` 分隔行，只解析其后的行**。
> - **发布链缺口（本次发现）**：`MANIFEST.txt` 全仓**只有 `pack-release.mjs` 生成，没有任何消费者校验**。
>   为使第 2 步的「第三层校验」可执行，本次在 `~/wbtmp/verify-manifest.py` 落地独立校验器
>   （不入库，避免扰动包内容与守卫计数）；建议后续收编进 `delivery/` 作为正式入口。
> - **解压目标目录**：zip 内**含顶层 `overall/`**，故解压到 `overall-root/` 后包根是
>   `~/winvm-deploy/overall-root/overall`（不是 `~/winvm-deploy/overall`）。

### Step 3 · 部署 VM-service

#### Step 3.0 · VM 运行时前置自检（node / npm / codebuddy CLI）

**必须先做**：`deploy-vm` 的 `preflight` 对以下三项都是 `blocking:true`，缺任何一项
`--apply` **直接中止**（不是警告），且**不会代装**。用一条探针一次取全结论：

```sh
PKG=~/winvm-deploy/overall-root/overall
scp qa/deploy-probes/vm-env-check.ps1 User@$VM_HOST:C:/Users/User/vm-env-check.ps1
ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1'
```

判据：`ENV_PRECHECK=PASS` 且 `BLOCKERS=none`（内含 `NODE_OK=true` / `NPM_FOUND=true` /
`CLI_OK=true`）。另有 `AUTH_VERDICT` 用于登录态粗判（`config-dir-present` = 大概率已登录）。

缺什么补什么（**按此顺序**，前一项是后一项的前提）：

| 缺失项 | 判据现象 | 补齐方式 | 说明 |
|---|---|---|---|
| **node <18 或无 node** | `NODE_OK=false` / `NODE_FOUND=false` | ① 有 nvm：`nvm install 24.21.0 && nvm use 24.21.0`<br>② 无 nvm：官方 MSI `msiexec /i node-v24.21.0-x64.msi /qn /norestart`（需管理员 + **桌面会话**） | **`winget` 在本链路不可依赖**（见下） |
| **无 npm** | `NPM_FOUND=false` | 随 Node 一并装（npm 自带），不要单独装 | npm 缺失 99% 是 node 没装对 |
| **无 codebuddy CLI** | `CLI_OK=false` + `CLI_INSTALL_CMD` | `npm i -g @tencent-ai/codebuddy-code@latest` | 写用户目录，**无需提权**；实测 16s / 102 包。**默认 latest，不锁版本**（探针等价于 `@latest`） |
| **登录态未确认** | `AUTH_VERDICT=installed-unverified` | VM 内**交互式**跑一次 `codebuddy` 完成登录 | 结构性不可脚本化（无 `whoami`/`auth status`） |

自动化一条命令（只自动补 CLI，运行时不缺就短路）：

```sh
ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1 -Fix'
```

**Node/npm 故意不自动安装**：VM 用的是 nvm-windows，`nvm use` 会切换 prefix 前缀，
**全局安装的 codebuddy 会立即「消失」**——自动装 Node 等于给下一步埋雷。故 Node 缺失时
探针只输出 `RUNTIME_HINT_*` 让人决策。

**无探针时的最小检查**（G-3 已随 V1.4.3 关闭——`qa/deploy-probes/` 已在包内；此行保留给旧包 V1.4.2 及更早）：

```sh
ssh User@$VM_HOST 'powershell -NoProfile -Command "node -v; npm -v; codebuddy --version"'
# 三行都出版本号即 PASS（实测 v24.21.0 / 11.19.0 / 2.167.0）；
# 缺哪个会打印 CommandNotFoundException 而非版本号。
# 补装 CLI（与探针 -Fix 等价）：
ssh User@$VM_HOST 'powershell -NoProfile -Command "npm i -g @tencent-ai/codebuddy-code@latest"'
```

> ⚠ 这条内联式**只可用于「读版本号」这类无 `$_` 的简单载荷**；任何含 `$_`/`$?`/引号的逻辑
> 仍必须走 `.ps1 → scp → -File`，否则会被**本地 bash 先展开**（§5 排错第 4 类）。

> **实测记录 Step 3.0 · 2026-10-26 17:3x（三例全绿）**
>
> - **正例**（VM 现态）：`NODE_VERSION=v24.21.0`、`NPM_VERSION=11.19.0`、
>   `CLI_VERSION=2.167.0`、`GLOBAL_PKG=@tencent-ai/codebuddy-code@2.167.0`、
>   `NPM_PREFIX=%LOCALAPPDATA%\Author Software\nvm\installs\v24.21.0`、
>   `AUTH_MARKERS=settings.json,user-state.json`、`ENV_PRECHECK=PASS`。
> - **负例**（`-SimulateMissing` 剥掉 PATH 中的 node 目录）：`BLOCKERS=node,npm,cli`、
>   `ENV_PRECHECK=FAIL`、`NEEDS_RUNTIME=true`、`CLI_INSTALL_CMD=npm i -g @tencent-ai/codebuddy-code`
>   + 三条 `RUNTIME_HINT_*`。**证明检测与提示双向正确**。
> - **幂等**（已装时 `-Fix`）：无 `installing` 输出、无 `AFTER_FIX_*`、直接 `ENV_PRECHECK=PASS`。
> - **安装可行性**（不真装，用 npm 只读/dry-run 证）：`npm view … version` → `2.176.0`（exit 0，
>   registry `https://registry.npmjs.org/` 可达）；`npm i -g … --dry-run` → `DRYRUN_EXIT=0`、
>   `changed 102 packages in 16s`（**用户目录写入，未提权**）。
> - **`winget` 陷阱实证**：`Get-Command winget` 能找到，但 `winget --version` **输出为空且 exit 0**
>   （MSIX alias 空壳，非交互 ssh 会话不可用）。故 Node 安装指引把 winget 排到最后并标注不可靠。
> - **VM 是管理员上下文**（`IS_ADMIN=true`，`SESSIONNAME` 空 = 非交互）——这解释了为什么
>   `administrators_authorized_keys` 是唯一生效落点（§2.1-1）。

#### Step 3.1 · 部署（先 DRY-RUN 再真执行）

```sh
PKG=~/winvm-deploy/overall-root/overall
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node      # 鸿蒙宿主必须用绝对路径 node
cd "$PKG"
cp -n .env.example .env
# 逐键确认（默认值见 §0.5）：VM_HOST / VM_USER / VM_SSH_PORT / VM_DEPLOY_DIR /
#   WINVM_SERVICE_PORT / WINVM_VM_PROVIDER=workbuddy / WINVM_WORKBUDDY_CLI=codebuddy
# ⚠ 真执行必须 WINVM_DRY_RUN=0（=1 是兜底保险：即使传 --apply 也强制 dry-run）
$NODE delivery/deploy-vm.mjs --skip-build --env=.env            # 先 DRY-RUN 看规划
$NODE delivery/deploy-vm.mjs --apply --skip-build --env=.env    # 再真执行
# 判据（VM 本机）——远端逻辑一律 .ps1 → scp → powershell -File（见 §5 排错）
scp qa/deploy-probes/vmcheck.ps1 User@$VM_HOST:C:/Users/User/vmcheck.ps1
ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vmcheck.ps1'
```
判据（JSON 一次取全）：`task_state=Running`、`listen_addr=127.0.0.1`、`listen_count=1`、
`side_json=true`、`bridge_dir=true`、`health_http=200` 且 `health_body.ok=true`。

> **实测记录 Step 3 · 2026-10-26 16:18（deterministic）/ 16:24（workbuddy）· PASS**
>
> - **必须先 `--skip-build`**：发布包不含 `src/tsconfig/tsc`，无法重建；包内 `dist` 已构建且指纹在
>   `MANIFEST.txt`。不加该 flag 会尝试 BUILD 并失败。
> - **`WINVM_DRY_RUN` 是双保险语义**（易踩）：`--apply` 才是真执行开关，但 `.env` 里
>   `WINVM_DRY_RUN=1` 会把 `--apply` 降级回 dry-run。**真部署前必须改成 `0`**，否则「部署成功」
>   提示下其实什么都没做。实测顺序：先 `WINVM_DRY_RUN=1` + 不带 `--apply` 看规划 → 改 `0` → 带 `--apply`。
> - **一次 apply 完成四段**：`VM（scp→ssh install-vm.mjs）` → `VM-START（重启+轮询端口）` →
>   `QA-PROBE（推 2 个探针）` → 端口验证。耗时 **71s**（deterministic）/ **53s**（workbuddy）。
> - **实测产物指标**：`C:/WinVMBridge` 存在、`C:/Users/User/.workbuddy/winvm/side.json` 存在、
>   计划任务 `WinVMBridge.Service` = `Running`、`127.0.0.1:18443` 单条 LISTEN。
> - **`/health` 的关键字段速读**：`capabilities.count=54`、`security.loopbackOnly=true`、
>   `audit.chainValid=true`、`policyGate.delegationRequiredPolicy=true`、
>   `psBridge.fingerprint`（6 个 ps1 的 sha256 + pid，**版本指纹优先于 uptime**）。
> - **provider 切换只需改 `.env` + 重跑 Step 3**（无需手工 kill）：`WINVM_VM_PROVIDER` 改为
>   `workbuddy` 后重新 `--apply`，`deploy-vm` 自带 VM-START 重启与端口轮询。实测
>   `provider={id:"workbuddy",state:"ready"}`、`capabilitiesProfile.kind="llm-agent"`、
>   `persistentSession=true`、`warmup=true`、`approvalTruth={mode:"on",enabled:true,shadow:false}`。
> - **不要用 `ssh … "powershell -Command \"… \$_.Exception …\""`**：`$_` 会被**本地 bash** 展开成
>   `/usr/bin/bash` → 远端 ParserError。一律走 `.ps1` 文件。

### Step 4 · 安装宿主插件 + 隧道

```sh
PKG=~/winvm-deploy/overall-root/overall; NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
cd "$PKG"
$NODE delivery/install-host.mjs --yes --vm-host 172.16.100.2 --vm-user User --vm-ssh-port 22
# install-host 末尾会自动拉起常驻隧道；如需手动确认/兜底：
$NODE ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin.mjs tunnel status --json
# 对账面（只读，零写入）
$NODE delivery/install-host.mjs --check-fresh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/health
```
判据：`tunnel.status.state=RUNNING` 且 `healthy=true` 且 `ownerMatch=true` 且 `stateStale=false`；
`--check-fresh` → `FRESH`；宿主 `/health` → `200`。

> **实测记录 Step 4 · 2026-10-26 16:19 · PASS（但发现发布包陈旧）**
>
> - **一次 install-host 全做完**：12 个文件写入、7 个 Skill、`installed_plugins.json` 转正、
>   `enabledPlugins`、全局 `mcp.json` 两个连接器、PATH、沙箱白名单、`vm-conn.json`、
>   `node_modules`（ssh2 5 包）、**自动拉起隧道**（无需手工 `tunnel ensure`）。
> - **实测隧道**：`state=RUNNING healthy=true pid=8758 ownerMatch=true stateStale=false`，
>   `lastEvent=ready`；宿主 `/health` 经隧道 `200`。
> - **实测对账面**：`186 个文件` / `FRESH`（逐文件 SHA256 全一致）。注意仓库 HEAD 自检口径是
>   **187 对**——差 1 是因为 V1.4.2 包构建于 `eba187e`（10-21），不含 10-25 新增的
>   `account-resolve.mjs` 相关面。
> - 🔴 **关键发现：V1.4.2 包早于 P2 修复，用 Release 安装会带回已修 bug**。证据三连：
>   1. `delivery/install-host.mjs` 中 `NON_ACCOUNT_DIRS` 出现次数：**包内 0 / 仓库 3**；
>   2. 实测安装后 `~/.workbuddy/connectors/skills/mcp.json` 与
>      `connectors/marketplace-meta/mcp.json` **被写入 `connector:winvm`（各 2 处）** ——
>      这正是 P2-3（856a0f4）已修掉的「把非账户目录当账户」缺陷回归；
>   3. 包内**缺 `delivery/tools/diagnose-connectors.mjs`** → 安装末尾
>      「连接器自检 ⚠ 诊断工具缺失，跳过」。
>   **结论与处置**：Release 包必须**在 `pack-release` 前先 `tsc -b` + 从 HEAD 重打**，
>   并发布新版本（建议 V1.4.3）；否则「从 GitHub Release 安装」这条策略在功能上虽通，
>   但会引入已被修复的缺陷。详见 §9 待办。
> - **`disabledTools` 的真实落点是 `~/.workbuddy/mcp.json`（全局）**，不是
>   `connectors/<acct>/mcp.json`。校验必须读全局文件（实测 `winvm: disabledTools=8`）。

### Step 5 · 全维度测试

用仓库内三个探针（`qa/deploy-probes/`），一条命令出结论：

```sh
PY=/data/service/hnp/bin/python3      # 鸿蒙宿主
PKG=~/winvm-deploy/overall-root/overall
$PY qa/deploy-probes/verify-manifest.py "$PKG"     # ① 包完整性（867 文件 + total-sha256）
$PY qa/deploy-probes/mcp-probe.py                  # ② 20 项：健康/能力/点分名/禁用表/跨域抽样/A2A 发现
$PY qa/deploy-probes/a2a-probe.py                  # ③ 5 项：stdio 桥 + a2a.health + a2a.delegate 真委派
```
判据：三个脚本均 `RESULT: PASS`。

手工最小复核（不依赖探针）：

```sh
curl -s http://127.0.0.1:18443/health                     # ok:true / count:54 / loopbackOnly:true
curl -s -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1:18443/.well-known/agent-card.json    # 200（A2A 发现）
```

> **实测记录 Step 5 · 2026-10-26 16:21~16:26 · PASS（25/25）**
>
> | 组 | 项数 | 内容 | 结果 |
> |---|---|---|---|
> | A 健康与指纹 | 6 | `/health ok`、能力 54、会话 healthy/locked=false、仅回环、审计链、审批闸 | 6/6 |
> | B MCP 面 | 7 | initialize、tools/list、点分名 54/54、工具数 54、禁用表、抽样在册、宿主 `disabledTools=8` | 7/7 |
> | C 跨域功能 | 5 | `meta.capability.list` / `system.info.get` / `storage.disk.list` / `app.inventory.list` / `gui.session.status` | 5/5 |
> | D A2A 发现 | 2 | `agent-card.json`（name + 5 skills）、`POST /a2a` 存活（200） | 2/2 |
> | E A2A 委派 | 5 | cli 存在、stdio initialize、6 个 a2a 工具、`a2a.health`、`a2a.delegate` 真委派 | 5/5 |
>
> - **两种 provider 各跑一遍全绿**：`workbuddy-deterministic` 25/25；`workbuddy`（LLM 常驻）25/25。
>   `a2a.delegate` 在 deterministic 下走 `system.info.get` 单步（1262ms）；在 `workbuddy` 下走
>   `appops.workflow.run` 由 LLM 编排 —— 两者都是 `steps[].ok=true` 的诚实回执。
> - **踩坑 1（断言写错，非产品缺陷）**：不能断言 "`/mcp` 的 `tools/list` 里不含 8 个高危工具"。
>   原始 MCP 面**必然列全 54**，`disabledTools` 是**宿主侧**（`~/.workbuddy/mcp.json`）对模型
>   视野的过滤。正确断言 = 读全局 `mcp.json` 的 `disabledTools.length===8`。
> - **踩坑 2**：`app.inventory.list` **不接受 `limit`** 参数 → `INVALID_PARAMS`。空对象即可。
> - **踩坑 3**：`a2a.delegate` 的必填参数是 **`goal`（自然语言目标）**，不是 `capability`/`input`；
>   `maxRisk` 可选。传错 → `INVALID_PARAMS: goal 必填`。
> - **踩坑 4**：A2A **没有 `/a2a/health` 路由**（404 ≠ 故障）。发现端点 =
>   `GET /.well-known/agent-card.json`；执行端点 = `POST /a2a`；健康探测走 MCP 工具 `a2a.health`。
> - **reporting**：汇总写入 `qa/real-test-2026-10-26-run<N>.md`（三张表 + 失败四元组）。

### Step 6 · 交付引导（加载 hos-win-skill 并示范任务下发）

> **这一步不参与部署成功判据**（Step 0~5 全绿即部署完成），它解决的是**"交付之后怎么用"**。
> 跳过不会立刻报错，但后续任务极可能**走错通道**（例如让 WB 裸 ssh 跑 PowerShell，绕过能力层
> 与审批闸）——那等于把你刚建好的安全边界从使用面拆掉。

#### 6.1 先加载两个 Skill（顺序不能反）

| Skill | 落点 | 作用 | 加载方式 |
|---|---|---|---|
| **`hos-win-skill`**（鸿蒙↔Windows 任务分派） | 仓库第 8 Skill；**VM 侧不分发**（`HOST_ONLY_SKILLS`）。宿主侧落点随安装源：**HEAD 仓库安装=连接器目录 8 个（含本 skill）**；**V1.4.2 包安装=连接器 7 个**（包早于 10-23 并入，属 G-1）。用户级 `~/.workbuddy/skills/hos-win-skill/` 为**独立手工副本**，两条线互不依赖 | 判定「哪一步在鸿蒙做、哪一步经 winvm 通道交给 VM」，并给通道路由三条铁律 | `@skill:hos-win-skill`，或由 triggers 自动触发（`Windows 操作`/`虚拟机任务`/`C 盘清理`/`装软件`/`VM 文件`/`跨 App 数据`） |
| **`winvm-orchestrator`**（VM 总控编排） | 连接器 `~/.workbuddy/connectors/skills/connector-winvm/winvm-orchestrator/` | 进入 VM 后的**唯一总控入口**，负责能力选择与调用 | 由 hos-win-skill 带入，或 `@skill:winvm-orchestrator` |

判据：`ls ~/.workbuddy/skills/hos-win-skill/SKILL.md` 存在；且 `ls ~/.workbuddy/connectors/skills/connector-winvm/`
按安装源核对——V1.4.2 包=**7**（无 hos-win）/ HEAD=**8**（含）。连接器仅 7 而预期 8 ⇒ hos-win 未随包，属 G-1 已知，不阻塞交付。

**为什么必须先加载**：不加载时模型倾向"直接用 ssh 跑 powershell"，这会绕过宿主 `mcp.json` 的
`disabledTools` 静态禁用与 `DELEGATION_REQUIRED` 审批闸——**审批卡不会出现、操作不留审计回执**。

#### 6.2 通道路由三条铁律（摘自 hos-win-skill，优先级从高到低）

1. **风险优先**：目标是 **L2/L3** 能力（`service.configure`/`process.terminate`/`registry.write`/
   `winget.uninstall`/`file.delete`/`link.manage`/`appops.gui.produce`/`power.control`，共 8 项）
   ⇒ **一律 `a2a.delegate`**，直调面本就看不到它们；即便绕过直调，服务端策略也会收口。
2. **步骤定界**：能预先穷举成 1–2 步、无中间判断 ⇒ **MCP 直调**；步骤依赖上一步结果、
   需看屏决策、或只给目标态 ⇒ **`a2a.delegate`**。
3. **先探后定**：不确定就先直调一条 L0 读能力（`system.info.get` / `meta.health.check`）取事实
   再定通道；直调途中收到 `DELEGATION_REQUIRED` ⇒ **立即转委派，不要重试**。

#### 6.3 典型任务 Prompt 示例（可直接粘贴给 WorkBuddy）

写法模板：**【在哪】VM + 【要什么】目标态 + 【约束】只读/可改/先方案后执行 + 【验收】怎么算成功**

| # | 场景 | 建议 Prompt（照抄） | 通道 | 命中能力 | 能力实测 |
|---|---|---|---|---|---|
| 1 | 只读盘点 | 「在 Windows 虚拟机里列出所有已安装的软件，按名称排序，**只查不改**，结果给我表格」 | MCP 直调 | `app.inventory.list` | ✅ 已实跑 |
| 2 | 空间分析 | 「分析 VM 的 C 盘空间占用，给我占空间最大的前 10 个目录，**只读**」 | MCP 直调 | `storage.disk.list` + `storage.space.analyze` | ✅ 两项全实跑（E2a/E2b；space.analyze 目标须落白名单如 `C:\Users\User`，否则 `POLICY_DENIED`=执法正确） |
| 3 | 看屏幕 | 「截一张 VM 当前桌面的图，告诉我屏幕上开着哪些窗口」 | MCP 直调 | `gui.screen.capture` + `gui.window.list` | ✅ 三项全实跑（E3a/E3b/E3c，capture 全屏 base64 回传；不依赖窗口标题） |
| 4 | 装软件（含验证） | 「在 VM 上安装 7-Zip，装完启动一次确认能用，失败就告诉我卡在哪一步」 | A2A（多步+验证） | `app.winget.install` | ✅ dryRun 面实跑（E10：`supportsDryRun=true`，链路通；真装=winget MSIX 空壳约束 `exitCode=-1978335230`，需 VM 桌面登录态，见 MEMORY）；多步验证走 A2A（见 S10） |
| 5 | 服务排障 | 「VM 上 `WinVMBridge.Service` 停了，查明原因并恢复，最后确认 `/health` 正常」 | A2A（多步+决策） | `system.service.list/control` + `system.eventlog.query` | ✅ 三项实跑（E5/E8 + `system.service.control` 用 W32Time restart 实证；⚠ `WinVMBridge.Service` 是**计划任务非 Windows 服务**，service.control 对其报 `SERVICE_NOT_FOUND`=正确行为，重启走 `schtasks`/`kill-restart.ps1`） |
| 6 | C 盘清理 | 「把 VM 的 C 盘腾出 20GB：**先给清理方案和预计回收量**，我确认后再执行」 | A2A（L2 删除） | `storage.cleanup.analyze` → `storage.file.delete` | ✅ analyze 实跑（E7，只分析不删）；`file.delete` 直调被 `DELEGATION_REQUIRED` 闸**实证拦截**（删除须走审批通道，验收中不静默实删=设计正确） |
| 7 | GUI 操作 | 「打开 VM 里的记事本，输入一行 `hello from host`，保存到 `C:\WinVMWorkspace\hi.txt`」 | A2A（看屏循环） | `gui.input.keyboard` + `gui.uia.invoke` | ✅ 链实跑（launch→activate→keyboard sent>0→screen.capture→window.close 全绿；uia.invoke focus/setValue 实证）。**本轮发现并修复 `gui.ps1` 真 bug**：PS 5.1 下 `Marshal::SizeOf([Type])` 静态重载对运行时 Add-Type 结构抛「不能作为非托管结构封送」致键鼠全灭→改实例取尺寸，详见 §9.3 |
| 8 | 应用生产 | 「用 VM 里的 Photoshop 把 `C:\WinVMWorkspace\in.jpg` 裁成 1920×1080，导出 PNG 到同目录」 | A2A（L2） | `appops.gui.produce` | ✅ 直调被 `DELEGATION_REQUIRED` 闸**实证拦截**（L2 必经委派审批，能力在册）；生产链本身经 A2A 委派多步 goal 跑通（见 S10） |
| 9 | 跨端取文件 | 「把 VM 桌面上的 `report.xlsx` 拷到鸿蒙 `~/Downloads`，再读前几行内容给我」 | MCP 直调 | `storage.file.copy` + `storage.file.read` | ✅ 链实跑（dir.manage→file.write→file.read→search.query→file.copy 全绿；E9 收 search 只读面）。注：能力面拷贝=VM 内路径，跨端到鸿蒙经 scp/tunnel（部署链既有能力，非单工具） |

> **实测口径（2026-10-27 更新）**：✅ = 已在真机实跑通过（只读安全项固化进 `qa/deploy-probes/example-probe.py`
> 现 **13 项**；写/删/L2 项走 dryRun 或 `DELEGATION_REQUIRED` 闸拦截实证，不静默改系统）。
> 全 9 场景能力已 100% 覆盖实测；证据目录 `~/wbtmp/step63-20261027/`。
> 补测脚本：`qa/deploy-probes/example-probe.py`（只读，VM 恢复后一条命令跑完）。

#### 6.4 三种常见「错误下发」及其后果

| 错误说法 | 实际会发生什么 | 正确说法 |
|---|---|---|
| 「你 ssh 进 VM 跑一下 `Get-Service`」 | 绕过能力层与审批闸：**审批卡不出现**、操作**不留审计回执**、能力层校验全跳 | 「查一下 VM 里的服务状态」（走 `system.service.list`） |
| 「顺手把 C 盘清一下」 | L2 删除没有方案对照，**不可逆**风险 | 「先分析 C 盘给清理方案，我确认后再删」 |
| 「帮我在 VM 里把环境配好」 | 目标态过开放，VM Agent 可能自行选错路径/装错版本 | 「在 VM 装 Node LTS + codebuddy latest，装完输出 `node -v`/`codebuddy --version`」 |

#### 6.5 交付自检（3 条全过才算「真能用」）

```sh
# ① skill 就位
ls ~/.workbuddy/skills/hos-win-skill/SKILL.md
ls ~/.workbuddy/connectors/skills/connector-winvm/ | wc -l        # 期望 7
# ② 通道可用（宿主经隧道）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/health   # 期望 200
# ③ 实跑一个只读任务：在 WB 会话里说「查一下 VM 的系统信息」
#    → 应命中 winvm__system.info.get 并返回真实字段（不是"没找到工具"）
```

---

## 5. 排错速查

### 5.0 遇到困难时的处置协议（先读这节）

**原则：不停机、不硬推、不静默降级。** 任何一步失败都走同一条三段式：

1. **定位根因**（给证据，不给猜测）——取证最小集：退出码 + stderr 首行 + 该步判据字段的实际值
   （`ENV_PRECHECK` / `task_state` / `health_body.ok` / `tunnel.state`）+ 一条对照证据。
   禁止用「可能是网络问题」结案。
2. **给方案**（2~3 个，每个标注**可逆性 / 风险 / 耗时 / 影响面**）。
3. **要决策**（带推荐项，等用户选；用户不表态就默认选**可逆**那个，并在报告里写明"默认选择"）。

**必须停下来问用户的 5 类动作**（不得自行决定）：

| 类别 | 例子 | 为什么必须问 |
|---|---|---|
| 降低安全基线 | `LimitBlankPasswordUse=0`、`PermitEmptyPasswords yes`、关防火墙、删 `disabledTools` 条目 | 影响面超出本项目 |
| 不可逆数据操作 | 批量 `storage.file.delete`、`--purge-workspace`、清回收站 | 删了不可恢复 |
| 破坏性系统动作 | `power.control`（L3）、终止系统进程、改服务启动类型 | 可能打断用户工作 |
| 换版本 / 换 provider | `nvm use` 切 Node、`WINVM_VM_PROVIDER` 改档、升级到 `@latest` | 会改变已验证的基线 |
| 放宽验收判据 | 「这步先跳过」「警告也算过」 | 等于降低交付质量 |

**重试纪律**：同一判据连续失败 **2 次**必须停下来问（不许第 3 次盲试）；重试前必须改变一个变量
（端口/超时/顺序/凭据/版本），否则就是"同样的实验期待不同结果"。

**多轮交互要求**：一次问不动就换角度再问（补数据、给对比、给可选项），直到拿到明确决策；
**每次交互都要给可选项与推荐项**，不许开放式"你说怎么办"。每轮结论落
`~/winvm-deploy/deploy-session.md`（决策台账：步骤 / 现象 / 根因 / 决策 / 结果），
防止上下文丢失后重复问同一件事。

### 5.1 速查表

| 现象 | 根因 | 处置 |
|---|---|---|
| 密码登录 `Permission denied`（账户**有**密码） | 密码错 / 账户禁用 / 组策略限制 | 核对密码；`Get-LocalUser <name>` 看 `Enabled` |
| 密码登录 `Permission denied`（账户**空**密码） | **两层串联拦截**：OpenSSH `PermitEmptyPasswords` 默认 `no` **且** LSA `LimitBlankPasswordUse=1`（VM 实测两层都在拒，见 §2.1-B） | **首选**：让用户设非空密码后重跑 Step 1。**次选**：两层同时放行（`PermitEmptyPasswords yes` + `LimitBlankPasswordUse=0`）+ `Restart-Service sshd`，判据 `BLANK_PW_OK`，**建好免密后立即回滚这两层** |
| key 登录仍要密码 | 管理员组用户写了 `~/.ssh/authorized_keys`（Windows 忽略） | 改写到 `C:\ProgramData\ssh\administrators_authorized_keys` 并 `icacls /inheritance:r` |
| `ssh` 一直等密码 | 无 TTY 且未设 askpass | `SSH_ASKPASS`+`SSH_ASKPASS_REQUIRE=force`（无 `sshpass`） |
| `--check-fresh` 报 MISSING/多余 | 缓存白名单与 integrity 面不同源 | 两处名单必须同名同源（见 SECURITY-GOVERNANCE §9.2） |
| 会话里看不到 `winvm__*` 工具 | 连接器写入的是活跃账户 `mcp.json`，**新会话**才注入 | 重跑 `install-host.mjs` 后新开会话；`diagnose-connectors` 定位 |
| VM `/health` 通、宿主不通 | 隧道未起/旧隧道占监听 | `winvm-plugin tunnel status` → `ensure`；必要时 kill 旧 PID 再起 |
| GUI 能力失败 | 会话非交互式/已锁屏 | 用 LogonTrigger 的已登录会话；锁屏态属 Windows 安全边界 |
| 401 `AUTH_REQUIRED` | `enforceBearer=true` 且配了 token | 走回环隧道（默认 `loopback-only` 豁免）或带 `Authorization: Bearer` |
| 下载 `curl (28) Failed to connect to github.com port 443` | 链路抖动（非封禁） | `curl -I https://github.com` 数次拿到 200 即抖动；加 `--retry 5 --retry-all-errors -C -`，并用 `releases/download/<TAG>/` 绝对 URL |
| 部署打印「✅ 完成」但服务没起 | `.env` 里 `WINVM_DRY_RUN=1` 把 `--apply` 降级成 dry-run | 改 `WINVM_DRY_RUN=0` 重跑 |
| `deploy-vm` 报 `vm-node` 检查失败 | VM 无 Node 或 <18（`blocking`） | 先跑 Step 3.0：有 nvm 就 `nvm install 24.21.0 && nvm use 24.21.0`，无 nvm 用 MSI 静默装（需桌面会话） |
| `deploy-vm` 报 `vm-npm` 检查失败 | 只有 node 没有 npm（非常见：node 安装残缺） | 重装完整 Node 发行版；不要单独补 npm |
| `deploy-vm` 报 `vm-agent-cli` 检查失败 | VM 内 `codebuddy --version` 非 0（`provider=workbuddy` 时 `blocking`） | `npm i -g @tencent-ai/codebuddy-code`；或临时改 `WINVM_VM_PROVIDER=workbuddy-deterministic` 先通链路 |
| 装完 codebuddy 后又「找不到命令」 | `nvm use` 切了 Node 版本 → 全局包在旧版本 prefix 里 | 在当前版本重装：`npm i -g @tencent-ai/codebuddy-code`；核对 `npm config get prefix` |
| 想用 `winget install OpenJS.NodeJS.LTS` 装 Node | 经 ssh 非交互会话 MSIX alias 空壳（`winget --version` 输出空且 exit 0） | 不要依赖 winget；用 nvm 或 MSI 静默安装 |
| 远端 PowerShell `ParserError` / 中文乱码 | 内联 `-Command` 被本地 bash 展开 `$_`；UTF-8 中文载荷乱码 | 逻辑写 `.ps1` → `scp` → `powershell -NoProfile -ExecutionPolicy Bypass -File`；载荷保持 ASCII |
| `tools/list` 能看到高危工具 | **正常**：原始 MCP 面恒列全 54 | 闸门在宿主 `~/.workbuddy/mcp.json` 的 `disabledTools`（8 条），不在此处 |
| `a2a.delegate` → `INVALID_PARAMS: goal 必填` | 参数是 `goal`（自然语言），不是 `capability`/`input` | 传 `{"goal":"…"}`，可带 `maxRisk` |
| `/a2a/health` → 404 | 该路由不存在（404 ≠ 故障） | 发现用 `GET /.well-known/agent-card.json`；健康用 MCP 工具 `a2a.health` |
| `app.inventory.list` → `INVALID_PARAMS 不支持的参数 limit` | 该能力无 `limit` 形参 | 传 `{}` |
| 安装后 `connectors/skills/mcp.json` 被写入 winvm | 用了早于 P2-3 修复的 Release 包 | 从 HEAD 重打并发布新版本（见 §9）；不要直接依赖旧 tag |

---

## 6. 回滚与清理

> Prompt 版（把本节交给 WorkBuddy 驱动执行）见 `docs/deploy/undeploy-prompts.md` —— deploy-prompts 的逆向镜像：U0 前置→U1 DRY-RUN→U2/U3 apply→U4 POST-CLEANUP 核验→U5 存留项逐项问用户；`--wipe` 清场重装的拆除衔接见彼文 §8。

```sh
node delivery/uninstall.mjs                      # 默认 dry-run，先看清单
node delivery/uninstall.mjs --apply              # 保留 C:/WinVMWorkspace 与 ssh 密钥
node delivery/uninstall.mjs --apply --purge-workspace   # 连工作区一起清（不可逆）
```
**永不触碰**（设计约束）：仓库与 `.env`、两端 `~/.ssh`、VM 的 OpenSSH Server、宿主其它插件。

**ssh 免密通道的单独清理**（卸载器按设计不动密钥）：
```sh
# VM：仅删本项目那一条 key，保留他人 key
#   C:\ProgramData\ssh\administrators_authorized_keys 去行 + 重建 ACL
# 宿主：删除 ~/.ssh/id_ed25519{,.pub}；从 ~/.ssh/known_hosts 去掉 VM 行
```
本次实测记录：`qa/evidence/cleanup-20261026/uninstall-apply-*.log`（17/17 PASS）。

> ⚠️ **血泪坑（本轮踩到）：`~/.ssh/id_ed25519` 往往是「一号多用」** —— 同一个默认密钥既做
> VM 免密，也做 GitHub 推送凭据。第 1 步「清理旧通道 → 删 id_ed25519 → 重新 ssh-keygen」
> 会**连带废掉 `git push`**（现象：`git@github.com: Permission denied (publickey)`）。
> **处置顺序**：
> 1) 清理前把旧密钥备份（本项目实际做法：`~/wbtmp/winvm-cleanup-<ts>/id_ed25519{,.pub}`）；
> 2) 恢复时**不要直接覆盖**新密钥（否则 VM 免密又断），而是落成独立文件
>    `~/.ssh/id_ed25519_github`（`chmod 600`），推送时按需指定：
>    `GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519_github -o IdentitiesOnly=yes" git push origin HEAD`
> 3) 长期正解：**GitHub 与 VM 用两把不同的密钥**，清理 VM 通道时永不触碰推送密钥。

---

## 7. 指导 WorkBuddy 全流程安装的 Prompt

> 使用方式：把下面整段粘给 WorkBuddy（鸿蒙宿主），它会按此自驱动完成六步并在失败时停在判据处。
> 变量取值先与用户确认（见 §0.5）；正式版见 `docs/deploy/deploy-prompts.md`。

```text
你是 WinVM Bridge 的部署执行者。请从零完成本项目的双端安装，严格按顺序执行并在每一步用
「判据」自检；任何判据不通过就停下并报告（现象/根因/证据/建议），不要跳步硬推。

【环境常量】VM_HOST=172.16.100.2  VM_USER=User  VM_SSH_PORT=22  SERVICE_PORT=18443
  VM_DEPLOY_DIR=C:/WinVMBridge  PROVIDER=workbuddy  WORKBUDDY_CLI=codebuddy
  RELEASE_TAG=V1.4.6  ZIP=winvm-overall-V1.4.6.zip
【宿主工具】node=/data/storage/el1/bundle/libs/arm64/node/bin/node（必须绝对路径）
            python3=/data/service/hnp/bin/python3；有 ssh/scp/unzip/sha256sum/curl；无 sshpass
【安全红线】不要把密码写进任何文件/提交；不要在日志里回显密码。

Step 1 密码登录并建立免密通道
  1) 用 SSH_ASKPASS 以密码登录一次（本机无 sshpass）：
     DISPLAY=:0 SSH_ASKPASS=$HOME/wbtmp/askpass.sh SSH_ASKPASS_REQUIRE=force \
       ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password \
           -o NumberOfPasswordPrompts=1 User@$VM_HOST "echo PASSWORD_AUTH_OK"
     判据：输出 PASSWORD_AUTH_OK。若 Permission denied → 先区分「密码错」还是「空密码」：
     空密码时**两层串联拦截**（OpenSSH PermitEmptyPasswords 默认 no + LSA LimitBlankPasswordUse=1），
     此时 ① 首选请用户设非空密码后重跑本步；② 用户坚持空密码时须**同时**放行两层：
        sshd_config 置 PermitEmptyPasswords yes → Restart-Service sshd；
        注册表 HKLM\SYSTEM\CurrentControlSet\Control\Lsa 的 LimitBlankPasswordUse 置 0；
        判据 echo BLANK_PW_OK，且**建好免密通道后立即回滚这两层**（之后只用公钥）。
  2) 若 ~/.ssh/id_ed25519 不存在则 ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519。
  3) 把公钥写入 VM 两处：C:/Users/<user>/.ssh/authorized_keys 与
     C:/ProgramData/ssh/administrators_authorized_keys（Windows 管理员组成员只认后者），
     对后者 icacls /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'。
     ⚠ 公钥含空格与 +/，禁止内联拼进 ssh 命令；用 base64 传参由 .ps1 解码。
     ⚠ 远端逻辑必须写成 .ps1 → scp → powershell -NoProfile -ExecutionPolicy Bypass -File；
       内联 powershell -Command 会被本地 bash 展开 $_ 而 ParserError。
  4) 判据：ssh -o BatchMode=yes -o PreferredAuthentications=publickey \
            -o NumberOfPasswordPrompts=0 User@$VM_HOST whoami  → 输出用户名、退出码 0。
     注意：icacls 输出里仍可能有 User/(R) 等历史显式 ACE，只要公钥能登就通过，别按行数验收。

Step 2 获取并校验 Release
  用绝对 URL（不要 releases/latest，多一跳 302 放大抖动）：
    BASE=https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.2
    curl -fsSL --connect-timeout 20 --max-time 900 --retry 5 --retry-delay 3 \
         --retry-all-errors -C - -o $ZIP $BASE/$ZIP
    curl -fsSL --connect-timeout 20 --max-time 120 --retry 5 --retry-delay 3 \
         --retry-all-errors -o $ZIP.sha256 $BASE/$ZIP.sha256
  判据一：sha256sum -c $ZIP.sha256 → OK。
  解压：mkdir -p ~/winvm-deploy/overall-root && unzip -q -o $ZIP -d ~/winvm-deploy/overall-root
        （zip 内含顶层 overall/，包根 = ~/winvm-deploy/overall-root/overall）
  判据二：node delivery/verify-release.mjs <包根> --expect-nonaccount-guard → RESULT: PASS
        （逐文件 sha256 + files/bytes 计数 + total-sha256 复算 + 无多余/缺失 + V5 G-1 防回归断言；
        V1.4.3 起校验器已随包，纯 Release 安装零仓库依赖；无 Node 环境兜底 = 包内 verify-manifest.py）
  若下载 connect timeout：先用 curl -I https://github.com 确认是抖动还是断网，再重试。

Step 3 部署 VM-service（用免密通道）
  3.0 先做运行时前置自检（**硬门禁：缺一即中止，installer 不会代装**）：
      scp qa/deploy-probes/vm-env-check.ps1 User@$VM_HOST:C:/Users/User/vm-env-check.ps1
      ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1'
      判据：ENV_PRECHECK=PASS 且 BLOCKERS=none（NODE_OK/NPM_FOUND/CLI_OK 全 true）。
      缺失时按序补齐：
        node<18 或无 → 有 nvm 用 `nvm install 24.21.0 && nvm use 24.21.0`；
                       无 nvm 用官方 MSI 静默装（需管理员+桌面会话）。
                       ⚠ 不要用 winget（ssh 非交互会话是 MSIX alias 空壳）。
        npm 缺失     → 随 Node 一起装，不要单独补。
        codebuddy 缺 → `npm i -g @tencent-ai/codebuddy-code`（用户目录，无需提权）。
                       ⚠ nvm 切版本会让全局 CLI 失效 → 切换后必须重装。
        AUTH_VERDICT=installed-unverified → 在 VM 内交互式跑一次 `codebuddy` 完成登录。
      可自动化：以上探针加 -Fix（只自动补 CLI；已装则短路）。
  3.1 cd <包根>；cp -n .env.example .env；确认 VM_HOST/VM_USER/VM_SSH_PORT/VM_DEPLOY_DIR/
  WINVM_SERVICE_PORT/WINVM_VM_PROVIDER=workbuddy/WINVM_WORKBUDDY_CLI=codebuddy。
  ⚠ 必须把 .env 里 WINVM_DRY_RUN 改成 0，否则即使加 --apply 也只会 dry-run（假成功）。
  先规划：node delivery/deploy-vm.mjs --skip-build --env=.env
  再执行：node delivery/deploy-vm.mjs --apply --skip-build --env=.env
  判据：把 qa/deploy-probes/vmcheck.ps1 scp 到 VM 并 powershell -File 执行，得到
        task_state=Running、listen_addr=127.0.0.1、listen_count=1、side_json=true、
        bridge_dir=true、health_http=200、health_body.ok=true。

Step 4 安装宿主插件与隧道
  node delivery/install-host.mjs --yes --vm-host $VM_HOST --vm-user $VM_USER --vm-ssh-port 22
  （该命令末尾会自动拉起常驻隧道，一般不需要再 tunnel ensure）
  判据一：node ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin.mjs tunnel status --json
        → state=RUNNING、healthy=true、ownerMatch=true、stateStale=false
  判据二：node delivery/install-host.mjs --check-fresh → FRESH
  判据三：curl http://127.0.0.1:18443/health → 200
  判据四：读 ~/.workbuddy/mcp.json，winvm 条目的 disabledTools.length 必须为 8。

Step 5 全维度测试并出报告
  python3 qa/deploy-probes/mcp-probe.py     # 20 项：健康/能力/点分名/禁用表/跨域抽样/A2A 发现
  python3 qa/deploy-probes/a2a-probe.py     # 5 项：stdio 桥 + a2a.health + a2a.delegate 真委派
  判据：两个脚本都 RESULT: PASS（合计 25/25）。
  报告写 qa/real-test-<今天>-run<N>.md：健康/连接/功能/A2A 四张表 + 失败四元组，
  并给出「可交付 / 有阻塞」的明确结论。

Step 6 交付引导（不参与部署判据，但决定后续任务通道路由）
  6.1 加载 skill：@skill:hos-win-skill（宿主用户级 ~/.workbuddy/skills/hos-win-skill/）
      由它带入 winvm-orchestrator（连接器 7 个 winvm-* skill 之一）。
      判据：ls ~/.workbuddy/skills/hos-win-skill/SKILL.md 存在；连接器目录 wc -l：V1.4.2 包=7 / HEAD=8（按安装源核对）
  6.2 通道路由三条铁律：风险优先（L2/L3 一律 a2a.delegate）> 步骤定界（1~2 步可穷举→MCP 直调）
      > 先探后定（先 L0 读能力取事实；收到 DELEGATION_REQUIRED 立即转委派，勿重试）。
  6.3 给用户 3 个可直接粘贴的示范（按通道各一）：
      - 直调读：「在 Windows 虚拟机里列出所有已安装软件，只查不改，给表格」→ app.inventory.list
      - 直调诊断：「分析 VM 的 C 盘空间占用，给前 10 大目录，只读」→ storage.space.analyze
      - 委派多步：「VM 上 WinVMBridge.Service 停了，查明原因并恢复，最后确认 /health 正常」
        → a2a.delegate（goal 传自然语言）
  6.4 明确告知用户：**不要**让助手 ssh 进 VM 裸跑 PowerShell（会绕过审批卡与审计回执）。

【排错速查】
- 密码拒绝：先区分密码错 / 空密码。空密码是**两层串联拦截**（OpenSSH PermitEmptyPasswords=no
  默认 + LSA LimitBlankPasswordUse=1）→ 首选请用户设非空密码；坚持空密码则两层同时放行，
  建好免密后立即回滚（详见 §2.1-B）。
- 公钥无效：写的是 ~/.ssh/authorized_keys 但用户属 Administrators → 必须写
  C:/ProgramData/ssh/administrators_authorized_keys；icacls 用 SID 不写名称。
- 远端 PowerShell 报 ParserError / 中文乱码：改为 .ps1 文件 + powershell -File；载荷保持 ASCII。
- 部署"成功"但服务没起：检查 .env 的 WINVM_DRY_RUN 是否为 1。
- 隧道 TCP 通但 HTTP 黑洞：旧隧道占监听，看 tunnel status 的 ownerMatch/stateStale，
  必要时 kill 旧 pid 后 tunnel ensure。
- tools/list 里能看到高危工具：正常，过滤发生在宿主 mcp.json 的 disabledTools，不是服务端。
- a2a.delegate 报 goal 必填：参数是 goal（自然语言），不是 capability/input。
- /a2a/health 404：该路由不存在；A2A 发现用 GET /.well-known/agent-card.json，
  健康用 MCP 工具 a2a.health。
```

---

## 8. 与旧流程的差异

| 维度 | 旧流程（INSTALL-GUIDE §5） | 本策略（v2） |
|---|---|---|
| 代码来源 | 本地仓库 `npm ci` + `tsc -b` 现构建 | **GitHub Release 整包**（预构建 + sha256/MANIFEST 双校验） |
| 起点 | 假定已有免密通道 | **从密码登录开始**，免密通道由第 1 步现场建立 |
| 编排 | `setup.mjs` 一条龙（BUILD→HOST→VM→TUNNEL→TEST） | 拆成**可独立验证的 6 步**，每步带判据 |
| 适用 | 开发者本机 | 新机/重装/交付第三方 |

> 两者不冲突：本策略在 Step 3/4 之后可直接复跑 `setup.mjs --apply --skip-build` 做整体回归。

---

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-26 | v2.0 | 首版：六步策略、可行性论证、实测基线与排错表、WorkBuddy 指导 Prompt |
| 2026-10-26 | v2.1 | 六步**全流程真机实测通过**（25/25）：补 §0.5 部署参数变量表、各步「实测记录」、`qa/deploy-probes/` 四探针；`AGENT_PROVIDER` 默认改 `workbuddy` |
| 2026-10-26 | v2.2 | 新增 **Step 3.0 VM 运行时前置自检**（node≥18 / npm / codebuddy CLI / 登录态）：`qa/deploy-probes/vm-env-check.ps1`（含 `-Fix` 与 `-SimulateMissing` 自测）+ §0.5-F 前提变量表 + §2.3 安装面实测 + 排错 6 条。**provider 维持 `workbuddy` + `WINVM_WORKBUDDY_CLI=codebuddy`（用户裁定不引入 `workbuddy-native`）** |
| 2026-10-26 | v2.3 | 新增 **§2.1-B 空密码分支预案**（首选设密码／次选两层同时放行 + 建好即回滚）+ `VM_PW_MODE` 变量 + §0/§1 口径订正（原「与 PermitEmptyPasswords 无关」被实测证伪：**两层都在拒**）+ 排错拆成「有密码/空密码」两条 |
| 2026-10-26 | v2.4 | **安装默认取 latest 不锁版本**（`@latest`，用户裁定）+ 新增 **§5.0 遇到困难时的处置协议**（三段式：定位根因→给方案→要决策；5 类必须问的动作；2 次重试熔断；决策台账）+ 新增 **Step 6 交付引导**（加载 `hos-win-skill`/`winvm-orchestrator`、通道三铁律、9 个典型任务 Prompt 示例、3 种错误下发对照、交付自检 3 条） |
| 2026-10-26 | v2.5 | Step 6.3 示例表增「能力实测」列（✅5 实跑／⏳7 语义核未跑）+ **§9.2 VM 断连事件与待补测台账**（18:05 起不可达，分层定位=根因在 VM）+ 补测脚本 `example-probe.py` 入库 |
| 2026-10-26 | v2.6 | 文档一致性盘点修复：Step 6.1 hos-win 落点口径改「HEAD=连接器 8／V1.4.2 包=连接器 7／用户级=独立手工副本」（原「宿主用户级 host-only」与渲染器实态不符）+ §0.5-D HOST_SKILL_DIR 括注双口径 + 头注标准化 |
| 2026-10-26 | v2.7 | **V1.4.3 发布销账**：§9.1 三缺口关闭注记（G-1 修复入包+V5 断言/G-2 verify-release.mjs/G-3 探针入包）+ §9.2 VM 断连闭环注记（25/25+example 8/8）+ RELEASE_TAG 默认升 V1.4.3 + Step 2 判据二改用包内 verify-release + Step 6/HOST_SKILL_DIR 口径收敛=8 |
| 2026-10-27 | v2.8 | **Step 6.3 全矩阵补测闭环**：9 场景能力 100% 实跑（表格「能力实测」列全 ✅ 含证据与判据注记）；发现并修复 **gui.ps1 PS5.1 `Marshal::SizeOf([Type])` 真 bug**（键鼠输入此前从未真跑通，实例重载修正+防回归钉 E11）；example-probe 8→13 项；新增 §9.3（含 ⚠ 发布链影响：V1.4.3 包内 gui.ps1 仍旧版，建议补发 V1.4.4） |
| 2026-10-27 | v2.9 | **V1.4.4 补发销账**：§9.3 发布链影响裁定（补发 V1.4.4 已执行闭环）+ I-6.1 关闭注记；`pack-release` V6 硬断言（包内 gui.ps1 必含 `cbSize`）固化「修复晚于打包」盲区；RELEASE_TAG 默认升 V1.4.4 |
| 2026-10-27 | v3.0 | **卸载 Prompt 总集立项**：新增 `docs/deploy/undeploy-prompts.md` v1.0（deploy-prompts 的逆向镜像：§2.3 十七落点镜像清单 + U0~U5 总 Prompt + POST-CLEANUP 核验 + 存留项决策表 + `--wipe` 清场重装衔接）；§6 回滚与清理加 Prompt 版指针；deploy-prompts 头注加对偶行 |
| 2026-10-27 | v3.1 | **undeploy⇄deploy 回环实测（run1）**：拆除 19/19 + 重装 38/38 全绿；抓出并修复 `uninstall.mjs` 两处镜像不对称（全局 mcp.json / tunnel-autostart，ISSUES I-6.3）；`undeploy-prompts.md` 升 v1.1（十八落点、动态 16→19 核验口径、--vm-host 兜底、排错补 2 条瞬态）。详见 `qa/real-test-2026-10-27-run1.md` |
| 2026-10-27 | v3.2 | **版本引用同步 V1.4.4 + 裁定落地**：§0.5-B RELEASE_TAG/ZIP_SHA256/PKG 三元组升 V1.4.4（**补 v2.9 漏网**——变更行宣称"默认升 V1.4.4"但 §0.5 表与 §7 Prompt 未同步，10-27 回环核对 deploy-prompts 时发现同款陈旧）；§7 总 Prompt 版本行同步；I-6.3 用户裁定（不补发、下迭代收编）+ pack-release **V7 硬断言**（包内 uninstall 必含 cleanGlobalMcpJson，正反例验证：V1.4.4 旧包=拒产/HEAD=过） |
| 2026-10-29 | v3.6 | **迭代9 · V1.4.6 发布闭环**：.prompt 两篇入 OVERALL_DOCS+PACKAGE_REQUIRED；V1–V7 全绿打包 @71cda55（zip `dc417bf2…`/881/7606427/`2562a598…`）→上架 latest=V1.4.6→匿名回环三向一致+解包 docs/deploy 五件核验→清场重装（包内 uninstall 实弹 **19/19**+独立复核零残留→setup 七相位 rc=0→**mcp 20/20+a2a 5/5+example 13/13**+FRESH+disabledTools=8+连接器 8 skill+VM cbSize×4）；仓库 README §5.4 配置用法说明+包 README 快速部署/卸载四步随包分发 |
| 2026-10-29 | v3.5 | **`.prompt` 入包裁定（迭代9 起点）**：deploy/undeploy 两脚本并入 OVERALL_DOCS+PACKAGE_REQUIRED（V1.4.6 收编），包 README 增「快速部署/卸载」指引、仓库 README §5.4 配置用法说明；入包与否的 backlog 当场销账 |
| 2026-10-29 | v3.4 | **纯 Prompt 脚本面**：deploy-prompts/undeploy-prompts §3 总 Prompt 各抽出独立可粘贴脚本 `docs/deploy/deploy.prompt`/`undeploy.prompt`（含运行期注入变量段、判据内嵌）；同日真机回环验证拆除 19/19+独立复核零残留+部署 38/38（`qa/real-test-2026-10-29-run1.md`）；入包与否留迭代统一裁定（backlog 同款路径） |
| 2026-10-28 | v3.3 | **迭代8 · V1.4.5**：① Prompt 总集三篇入发布包（OVERALL_DOCS 增 `docs/deploy/deploy-strategy.md`/`deploy-prompts.md`/`undeploy-prompts.md` 子目录化拷贝 + PACKAGE_REQUIRED 存在性断言 + 包 README 文案）——backlog 口径疑点裁定收编，纯 Release 装机者零仓库依赖；② §0.5-B/§7 版本引用升 V1.4.5（zip `a225cc95…`/三元组 879/7580107/`88fd11c1…`；首打包早于 docs 同步=包内三篇仍旧版，已 `superseded-it1` 封存重打包 @76c0c65——**pack 前一切文档改动先 commit** 教训入册）；③ V1.4.5=I-6.3 收编版——本迭代打包 V7 断言当场核验包内 uninstall 含 cleanGlobalMcpJson（10-27"修复晚于打包"盲区正式闭合） |

### 9.1 本次实测发现的三处发布链缺口（**已随 V1.4.3 全部关闭**，2026-10-26；原发现记录保留）

| # | 缺口 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| G-1 | **V1.4.2 包早于 HEAD 的 P2 修复**（包构建于 `eba187e`/10-21，修复在 10-24~10-25） | 包内 `install-host.mjs` 无 `NON_ACCOUNT_DIRS`（0 次，仓库 3 次）；安装后 `connectors/skills/mcp.json`、`connectors/marketplace-meta/mcp.json` 被写入 `connector:winvm`；包内缺 `delivery/tools/diagnose-connectors.mjs`（安装末尾自检被跳过） | 用 Release 安装会**带回已修缺陷**，并制造非账户目录污染 | 发 **V1.4.3**：`tsc -b` → `pack-release` → `publish-release`，把 `delivery/tools/` 一并纳入包；`pack-release` 增加「包内 `install-host.mjs` 必须含 NON_ACCOUNT_DIRS」硬断言 |
| G-2 | **`MANIFEST.txt` 无消费者校验** | 全仓只有 `pack-release.mjs` 生成；`delivery/` 下无 verifier | 第 2 步「第三层校验」原本无法执行，包内损坏无法在安装前发现 | 把 `qa/deploy-probes/verify-manifest.py` 收编为 `delivery/verify-release.mjs`（Node 实现），并在 Step 2 判据里强制调用 |
| G-3 | **`qa/deploy-probes/` 不进发布包** | `pack-release.mjs` 的 VM_PROBES 只含 `qa/probes/qa-probe.ps1`、`qa/probes/lead-md5-3.ps1`；V1.4.2 包内 `grep -c 'deploy-probes' MANIFEST.txt` → **0** | Step 2 的 `verify-manifest.py`、Step 3.0 的 `vm-env-check.ps1`、Step 3/5 的 `vmcheck/mcp-probe/a2a-probe` 在**纯 Release 安装**下拿不到 | 把 `qa/deploy-probes/` 加入 overall 白名单；在此之前 Step 3.0 用**内联最小判据**兜底 |

> 三处缺口**不影响本策略可行**（六步均已实测通过），但影响「从 Release 安装」的**交付质量**。
> 处置顺序建议：先修 G-2 / G-3（低成本、纯增量）→ 再随 V1.4.3 一起关 G-1。

### 9.2 VM 断连事件与待补测项（**已闭环**：VM 10-26 恢复，三探针 25 项回归 + example-probe 8/8 全绿；下文保留事件记录与处置过程）

**现象**：2026-10-26 18:05 起 VM `172.16.100.2` 从宿主**完全不可达**（`ping` 3/3 丢包、
`ssh: Host is unreachable`、宿主 `18443` 隧道随之 `Connection refused`）。

**分层定位（已做，排除宿主侧）**：

| 层 | 探针 | 结果 | 结论 |
|---|---|---|---|
| 宿主出网 | `curl -m10 https://github.com` | **200** | 宿主网络正常 |
| VM 网段网关 | `ping 172.16.100.1` | **OK** | 宿主到该网段路由正常 |
| 目标 VM | `ping 172.16.100.2` ×3 | **全丢** | 故障点在 **VM 本身** |
| VM sshd | `ssh -o ConnectTimeout=8` | `Host is unreachable` | 非 sshd/防火墙"拒绝"，是**主机不响应** |
| 宿主隧道 | `curl 127.0.0.1:18443/health` | `Connection refused` | 隧道因上游断连而退出（**结果，非原因**） |

**2026-10-27 二次复现与全矩阵补测完成**（见 §9.3）：VM 恢复后 Step 6.3 全部 9 场景实跑，
> 期间修复 `gui.ps1` PS5.1 `Marshal::SizeOf` 真 bug。原「⏳ 未验证」口径作废。

**最可能原因**（需用户在 VM 控制台确认）：VM 休眠/关机、虚拟网卡断开、或宿主侧虚拟化
服务暂停。这类问题**无法从宿主侧远程修复**（没有带外管理通道）。

**处置建议**：① 在 VM 控制台/RDP 确认电源与网络状态；② 若为休眠，唤醒后隧道需
`winvm-plugin tunnel ensure` 重起；③ 恢复后跑：

```sh
python3 qa/deploy-probes/mcp-probe.py     # 20 项回归
python3 qa/deploy-probes/a2a-probe.py     # 5 项回归
python3 qa/deploy-probes/example-probe.py # Step 6 示例能力补测（本次新增，只读）
```

**（10-26 口径，已被 §9.3 取代）**：部署本身在 17:2x 前完成 25/25 验收；当时 Step 6.3
标 ⏳ 的项属"语义已核、未实跑"、不得对外宣称已验证。**2026-10-27 已全部实跑闭环，见 §9.3。**

### 9.3 Step 6.3 全矩阵补测 + gui.ps1 PS5.1 SizeOf 真 bug 修复（2026-10-27）

**触发**：用户要求把 Step 6.3 标 ⏳ 的示例**全部实跑验证**（VM 恢复后）。

**方法**：三轮 MCP 直调矩阵（`~/wbtmp/step63-20261027/probe*.py`）+ 一次 A2A 委派；只读/零副作用
项固化进 `qa/deploy-probes/example-probe.py`（8→**13 项**，E7 cleanup.analyze / E8 eventlog.query /
E9 search.query / E10 winget dryRun 如实回报 / E11 键鼠 sent>0 防回归钉）；写/删/L2 项以 **dryRun
成功** 或 **`DELEGATION_REQUIRED` 闸拦截** 为「链路通」判据——验收全程不静默改系统（记事本链不落盘、
工作区测试目录 ssh 清理）。

**结果**：9 场景能力 **100% 覆盖实跑**；终态回归 `mcp-probe` 20/20、`a2a-probe` 5/5、
`example-probe` **13/13**；A2A 多步存储体检委派 **65.3s** 成功（LLM 常驻会话，artifact 回传）。

**发现与修复**：

| # | 位置 | 现象 | 根因 | 处置 |
|---|---|---|---|---|
| BUG-1 | `psmod/gui.ps1`（SendInput 两处） | `gui.input.keyboard`/`gui.input.mouse` 报「`System.RuntimeType` 不能作为非托管结构封送」⇒ **键鼠输入从未真跑通** | PS 5.1 `Marshal::SizeOf([Type])` 静态重载不支持运行时 Add-Type 结构 | 改 `Marshal::SizeOf($arr[0])` 实例重载；psmod-contract 7/7 + b2-psmod-drift 13/13 GREEN；VM 侧 scp+kill-restart 热更即时生效；防回归钉=E11 |
| 探针缺陷① | E2b | space.analyze 报 INVALID / POLICY_DENIED | 参数名 `target`≠定义 `path`；`C:\` 不在 pathAllowlist | 改 `path=C:\Users\User`；**POLICY_DENIED=执法正确**（策略收紧后跨账户目录须白名单） |
| 探针缺陷② | S5 | `service.control WinVMBridge.Service` 报 SERVICE_NOT_FOUND | 该名是**计划任务**非 Windows 服务 | 改测 `W32Time restart` 实证；表格 S5 加口径注 |
| 探针缺陷③ | S4 | winget install dryRun 报 K6_VERIFY_FAILED | VM winget=MSIX 空壳（MEMORY 在册约束），exit `-1978335230` | 判据改「能力层如实回报=链路通」；真装需 VM 桌面登录态 |
| 窗口匹配 | R2-1b/2a | 「Untitled」/「记事本」标题匹配失败 | 历史遗留 notepad 开着旧文件、标题=文档名 | 改按 `window.list` 的 processName=Notepad 过滤 + 「Notepad」子串匹配 |

**⚠ 发布链影响（已决策并闭环，2026-10-27）**：BUG-1 修复晚于 V1.4.3 打包（10-26）——**GitHub Release 的
`winvm-overall-V1.4.3.zip` 内 `gui.ps1` 仍是带 bug 旧版**（运行态 VM 已热更不受影响；纯 Release
新装机会复现键鼠全灭）。**裁定：补发 V1.4.4** → **已执行并闭环**：tag `V1.4.4`（2789957，基于 2671f0f）
上架、三向对账 `03cef597…`（2,768,597 B）；清场重装 `--wipe` 七相位 2m6s + **25/25** + example-probe
**13/13** + VM 侧 gui.ps1 含 `cbSize`；`pack-release.mjs` 新增 **V6 硬断言**（包内 `gui.ps1` 必含 `cbSize`）
把「修复晚于打包」盲区永久封堵。详见 `docs/release/ISSUES.md` 迭代7。
已在 `docs/release/ISSUES.md` 迭代6 尾注登记。
