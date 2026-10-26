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
全维度测试）均已实测通过。

| 步骤                 | 结论          | 关键前置                                                                 | 实测 |
| ------------------ | ----------- | -------------------------------------------------------------------- | -- |
| 1 密码登录 + 建免密通道     | ✅ 可行（需非空密码） | VM 账户有密码；宿主有 `ssh`；Windows 管理员组用户需写 `administrators_authorized_keys` | ✅  |
| 2 获取 Release 并校验解压 | ✅ 可行        | 出网（GitHub）；`curl`+`sha256sum`+`unzip`                                | ✅  |
| 3 远程部署 VM-service  | ✅ 可行        | 免密通道；VM 有 Node ≥18                                                   | ✅  |
| 4 安装宿主插件 + 隧道      | ✅ 可行        | 免密通道；宿主 Node ≥18                                                     | ✅  |
| 5 连通性/健康/功能全测      | ✅ 可行        | 隧道在线；provider 就绪                                                     | ✅  |

---

## 0.5 部署参数变量表（Variable Manifest）

> **生成最终 `deploy-prompts.md` 前，必须逐项与用户确认本表。** 下表所有值均为本机实测默认值；  
> 换机器 / 换网络时只改本表，不要改正文命令（正文一律用变量引用）。
>
> ⚠️ **密码不入库**：`VM_PASSWORD` 仅存于运行期环境变量 `WINVM_SSH_PASSWORD`；仓库、文档、  
> `.env` 都不写明文。下表只标注「运行时注入」。

### A. 目标环境

| 变量            | 默认值                           | 含义 / 来源                                                        | 确认 |
| ------------- | ----------------------------- | -------------------------------------------------------------- | -- |
| `VM_HOST`     | `172.16.100.2`                | Windows VM IP（局域网固定地址）                                         | ☐  |
| `VM_USER`     | `User`                        | VM 账户（**Administrators 组成员**，决定公钥落点）                           | ☐  |
| `VM_PASSWORD` | *运行时注入*（`WINVM_SSH_PASSWORD`） | 仅第 1 步密码认证用；**必须非空**（见 §2.1-B）                                 | ☐  |
| `VM_PW_MODE`  | `normal`                      | `normal`=设非空密码（推荐）／`blank-allow`=两层放行空密码（**免密建好即回滚**，见 §2.1-B） | ☐  |
| `VM_SSH_PORT` | `22`                          | VM sshd 端口                                                     | ☐  |
| `VM_SHELL`    | Git Bash(MSYS)                | 远端默认 shell；决定「逻辑写 `.ps1` 再 `-File` 执行」铁律                       | ☐  |

### B. 分发包

| 变量                                      | 默认值                                                                        | 含义                              | 确认 |
| --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- | -- |
| `GITHUB_REPO`                           | `athronix/workbuddy-virtual-win-plugin`                                    | 仓库全名                            | ☐  |
| `RELEASE_URL`                           | `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/latest` | latest 跳转链接                     | ☐  |
| `RELEASE_TAG`                           | `V1.4.2`（由 latest 解析）                                                      | 发布标签                            | ☐  |
| `ZIP_NAME`                              | `winvm-overall-V1.4.2.zip`                                                 | 分发单元（含 host∪vm∪bootstrap∪tools） | ☐  |
| `ZIP_SHA256`                            | `a06e7520…d00e149`（91 B sidecar）                                           | 整包校验值                           | ☐  |
| `PKG_FILES` / `PKG_BYTES` / `PKG_TOTAL` | `867` / `7313511` / `8d753c70…ecdd3a3`                                     | MANIFEST 三元组（重装核对用）             | ☐  |
| `DEPLOY_ROOT`                           | `~/winvm-deploy`                                                           | 宿主解压根                           | ☐  |
| `PKG_DIR`                               | `$DEPLOY_ROOT/pkg`                                                         | zip + sidecar 存放                | ☐  |
| `PKG_ROOT`                              | `$DEPLOY_ROOT/overall-root/overall`                                        | 解压后的包根（脚本入口所在）                  | ☐  |

### C. 服务与端口

| 变量                  | 默认值                   | 含义                           | 确认 |
| ------------------- | --------------------- | ---------------------------- | -- |
| `VM_SERVICE_PORT`   | `18443`               | VM-service 监听端口              | ☐  |
| `VM_SERVICE_BIND`   | `127.0.0.1`           | **仅回环**，VM 零对外暴露             | ☐  |
| `TUNNEL_LOCAL_PORT` | `18443`               | 宿主侧隧道本地端口（与 VM 端口同号）         | ☐  |
| `MCP_PATH`          | `/mcp`                | MCP 直调通道                     | ☐  |
| `A2A_PATH`          | `/a2a`                | A2A 复杂委派通道                   | ☐  |
| `SCHEDULED_TASK`    | `WinVMBridge.Service` | VM 计划任务名（托管 `ps-bridge.ps1`） | ☐  |
| `BRIDGE_DIR`        | `C:/WinVMBridge`      | VM 侧程序目录                     | ☐  |
| `VM_WORKSPACE`      | `C:/WinVMWorkspace`   | VM 侧工作区                      | ☐  |

### D. 宿主侧落点

| 变量                  | 默认值                                                   | 含义                                                                 | 确认 |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | -- |
| `HOST_STATE_DIR`    | `~/.workbuddy/winvm`                                  | `vm-conn.json` / `tunnel.pid` / `tunnel.state.json` / `tunnel.log` | ☐  |
| `HOST_PLUGIN_CACHE` | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0` | 插件缓存（单文件白名单，9 文件）                                                  | ☐  |
| `HOST_SKILL_DIR`    | `~/.workbuddy/connectors/skills/connector-winvm`      | 8 个 Skill 缓存落点                                                     | ☐  |
| `SSH_KEY`           | `~/.ssh/id_ed25519`                                   | 宿主身份密钥                                                             | ☐  |
| `ASKPASS`           | `~/wbtmp/askpass.sh`                                  | 密码非交互化脚本（`chmod 700`）                                              | ☐  |

### E. 行为开关

| 变量                                        | 默认值            | 含义                                                                             | 确认 |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------ | -- |
| `AGENT_PROVIDER`                          | `workbuddy`    | VM 侧 Agent 实现（**用户裁定为默认**；`workbuddy-deterministic` 为基准/对照档；`hermes-agent` 三方） | ☐  |
| `WINVM_WORKBUDDY_CLI`                     | `codebuddy`    | `provider=workbuddy` 时 VM 内 LLM CLI 可执行名                                       | ☐  |
| `WINVM_DELEGATION_REQUIRED_POLICY`        | `on`           | 服务端审批闸（L2/L3 需授权）                                                              | ☐  |
| `READY_BUDGET`                            | `180s`         | 端到端就绪预算                                                                        | ☐  |
| `IDLE_TTL`                                | `300s`         | 空闲回收（LLM provider 冷启动 ~49s 的外部特性）                                              | ☐  |
| `MCP_TIMEOUT_DEFAULT` / `MCP_TIMEOUT_MAX` | `10s` / `600s` | MCP 工具超时区间                                                                     | ☐  |

### F. VM 侧运行时前提（Step 3 的 3.0 自检项）

| 变量                 | 默认值                          | 本轮实测                            | 含义                                                     | 确认 |
| ------------------ | ---------------------------- | ------------------------------- | ------------------------------------------------------ | -- |
| `VM_MIN_NODE`      | `18.0.0`                     | `v24.21.0`                      | VM 内 Node 版本下限（`preflight.vm-node` 的同一个判据）             | ☐  |
| `VM_NPM_REQUIRED`  | `true`                       | `11.19.0`                       | VM 内 npm 必须可用（`preflight.vm-npm`）                      | ☐  |
| `VM_AGENT_CLI`     | `codebuddy`                  | `2.167.0`                       | `provider=workbuddy` 时 `preflight.vm-agent-cli` 探测的命令名 | ☐  |
| `VM_AGENT_CLI_PKG` | `@tencent-ai/codebuddy-code` | `latest=2.176.0`                | 缺失时用于 `npm i -g` 的包名（`registry.npmjs.org` 可达）          | ☐  |
| `VM_NODE_PM`       | `nvm-windows 2.0.0`          | `* 24.21.0 (default)`           | Node 版本管理器（**已装**）；切版本会使全局 CLI 失效，见 §4 Step 3.0        | ☐  |
| `VM_AUTH_DIR`      | `~/.codebuddy`               | `settings.json,user-state.json` | 登录态探测标记目录（`evaluateAgentLogin` 同源）                     | ☐  |

> VM 侧完整链路 = **node ≥18 → npm → codebuddy CLI → 已登录**。前三项由 `preflight` 硬门禁  
> （`blocking=true`），缺任一项 `deploy-vm --apply` 直接中止；**登录态只能降级探测**（codebuddy  
> 无非交互身份命令），故第 4 项靠 `AUTH_VERDICT=config-dir-present` + 首次委派实测。

---

## 1. 环境事实基线（本机实测，2026-10-26）

| 项                | 事实                                                                                                                                                                          | 取证方式                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 宿主 OS            | HarmonyOS NEXT，WorkBuddy 沙箱                                                                                                                                                 | `process.platform=openharmony`    |
| 宿主工具             | `ssh(OpenSSH_9.6p1)` / `scp` / `unzip` / `tar` / `sha256sum` / `curl` / `node`                                                                                              | `command -v`                      |
| **`sshpass`**    | **不存在** → 密码认证必须用 `SSH_ASKPASS`（见 §4 Step 1）                                                                                                                                | `command -v sshpass`              |
| VM               | `172.16.100.2:22`，账户 `User`（**Administrators 组**），密码非空                                                                                                                      | `whoami /groups` → `isAdmin=True` |
| VM sshd          | `sshd` Running/Automatic；`PermitEmptyPasswords` 默认 `no`                                                                                                                     | `Get-Service sshd`、`sshd_config`  |
| **空密码网络登录**      | **被禁**：`HKLM\SYSTEM\CurrentControlSet\Control\Lsa\LimitBlankPasswordUse=1`                                                                                                  | 实测空密码 → `Permission denied`       |
| VM 服务端口          | `18443`，**仅回环**（VM 零对外暴露）                                                                                                                                                   | `Get-NetTCPConnection`            |
| 公钥落点             | 管理员组用户走 `C:\ProgramData\ssh\administrators_authorized_keys`（**不是** `~/.ssh/authorized_keys`），且 ACL 必须仅 `SYSTEM + Administrators`                                            | `sshd_config:88` + 实测             |
| 最新 Release       | `V1.4.2`，资产 `winvm-overall-V1.4.2.zip`（2,722,056 B）+ `.zip.sha256`（91 B）                                                                                                    | GitHub API                        |
| **VM 运行时链**      | `node v24.21.0` / `npm 11.19.0` / `codebuddy 2.167.0`（`@tencent-ai/codebuddy-code`）；由 **nvm-windows 2.0.0** 管理，全局包在 `%LOCALAPPDATA%\Author Software\nvm\installs\v24.21.0\` | `vm-env-check.ps1`（§4 Step 3.0）   |
| VM 权限/会话         | ssh 会话为**管理员**上下文（`IS_ADMIN=true`）、**非交互**（`SESSIONNAME` 空）                                                                                                                 | 同上                                |
| **`winget`（VM）** | 命令存在但 `--version` **输出为空且 exit 0**（MSIX alias 空壳）→ 非交互 ssh 下不可用                                                                                                             | 只读探针                              |
| **空密码网络登录**      | **两层同时被拒**：OpenSSH `PermitEmptyPasswords` = 默认 `no`（该行为注释）+ LSA `LimitBlankPasswordUse=1`                                                                                   | 只读探针；空密码实测 → `Permission denied`  |
| 测试基线             | `qa/p3-batch-sweep/gate-docs-overview.txt`（128 文件 / 2280 例 / 0 fail）                                                                                                        | 门禁快照                              |

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

| 层             | 位置                                                                           | 该改什么                                                                                   | VM 实测现值（2026-10-26）                                                                          |
| ------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ① OpenSSH     | `C:\ProgramData\ssh\sshd_config`（**不是 Program Files**）                       | `PasswordAuthentication yes`（默认已 yes）<br />`PermitEmptyPasswords yes`（默认 **no**，必须显式写） | 两行**均被注释**：`#PasswordAuthentication yes`、`#PermitEmptyPasswords no` → 生效值 = `yes` / **`no`** |
| ② Windows LSA | `HKLM\SYSTEM\CurrentControlSet\Control\Lsa` → `LimitBlankPasswordUse`（DWORD） | 设为 **`0`**（默认 `1`）                                                                     | **`=1`**（启用 → 直接拒绝网络登录）                                                                      |

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
VER=V1.4.2
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

| 缺失项                  | 判据现象                                 | 补齐方式                                                                                                                                    | 说明                                 |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **node <18 或无 node** | `NODE_OK=false` / `NODE_FOUND=false` | ① 有 nvm：`nvm install 24.21.0 && nvm use 24.21.0`<br />② 无 nvm：官方 MSI `msiexec /i node-v24.21.0-x64.msi /qn /norestart`（需管理员 + **桌面会话**） | **`winget` 在本链路不可依赖**（见下）          |
| **无 npm**            | `NPM_FOUND=false`                    | 随 Node 一并装（npm 自带），不要单独装                                                                                                                | npm 缺失 99% 是 node 没装对              |
| **无 codebuddy CLI**  | `CLI_OK=false` + `CLI_INSTALL_CMD`   | `npm i -g @tencent-ai/codebuddy-code`                                                                                                   | 写用户目录，**无需提权**；实测 16s / 102 包      |
| **登录态未确认**           | `AUTH_VERDICT=installed-unverified`  | VM 内**交互式**跑一次 `codebuddy` 完成登录                                                                                                         | 结构性不可脚本化（无 `whoami`/`auth status`） |

自动化一条命令（只自动补 CLI，运行时不缺就短路）：

```sh
ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1 -Fix'
```

**Node/npm 故意不自动安装**：VM 用的是 nvm-windows，`nvm use` 会切换 prefix 前缀，  
**全局安装的 codebuddy 会立即「消失」**——自动装 Node 等于给下一步埋雷。故 Node 缺失时  
探针只输出 `RUNTIME_HINT_*` 让人决策。


**无探针时的最小检查**（`qa/deploy-probes/` 不在发布包里，见 §9.1-G3；纯 Release 安装时用这条）：

```sh
ssh User@$VM_HOST 'powershell -NoProfile -Command "node -v; npm -v; codebuddy --version"'
# 三行都出版本号即 PASS（实测 v24.21.0 / 11.19.0 / 2.167.0）；
# 缺哪个会打印 CommandNotFoundException 而非版本号。
# 补装 CLI（与探针 -Fix 等价）：
ssh User@$VM_HOST 'powershell -NoProfile -Command "npm i -g @tencent-ai/codebuddy-code"'
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
>   - 三条 `RUNTIME_HINT_*`。**证明检测与提示双向正确**。
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
>      **结论与处置**：Release 包必须**在 `pack-release` 前先 `tsc -b` + 从 HEAD 重打**，  
>      并发布新版本（建议 V1.4.3）；否则「从 GitHub Release 安装」这条策略在功能上虽通，  
>      但会引入已被修复的缺陷。详见 §9 待办。
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
> | 组        | 项数 | 内容                                                                                                             | 结果  |
> | -------- | -- | -------------------------------------------------------------------------------------------------------------- | --- |
> | A 健康与指纹  | 6  | `/health ok`、能力 54、会话 healthy/locked=false、仅回环、审计链、审批闸                                                         | 6/6 |
> | B MCP 面  | 7  | initialize、tools/list、点分名 54/54、工具数 54、禁用表、抽样在册、宿主 `disabledTools=8`                                           | 7/7 |
> | C 跨域功能   | 5  | `meta.capability.list` / `system.info.get` / `storage.disk.list` / `app.inventory.list` / `gui.session.status` | 5/5 |
> | D A2A 发现 | 2  | `agent-card.json`（name + 5 skills）、`POST /a2a` 存活（200）                                                         | 2/2 |
> | E A2A 委派 | 5  | cli 存在、stdio initialize、6 个 a2a 工具、`a2a.health`、`a2a.delegate` 真委派                                             | 5/5 |
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

---

## 5. 排错速查

| 现象                                                      | 根因                                                                                                         | 处置                                                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 密码登录 `Permission denied`（账户**有**密码）                     | 密码错 / 账户禁用 / 组策略限制                                                                                         | 核对密码；`Get-LocalUser <name>` 看 `Enabled`                                                                                                                   |
| 密码登录 `Permission denied`（账户**空**密码）                     | **两层串联拦截**：OpenSSH `PermitEmptyPasswords` 默认 `no` **且** LSA `LimitBlankPasswordUse=1`（VM 实测两层都在拒，见 §2.1-B） | **首选**：让用户设非空密码后重跑 Step 1。**次选**：两层同时放行（`PermitEmptyPasswords yes` + `LimitBlankPasswordUse=0`）+ `Restart-Service sshd`，判据 `BLANK_PW_OK`，**建好免密后立即回滚这两层** |
| key 登录仍要密码                                              | 管理员组用户写了 `~/.ssh/authorized_keys`（Windows 忽略）                                                              | 改写到 `C:\ProgramData\ssh\administrators_authorized_keys` 并 `icacls /inheritance:r`                                                                         |
| `ssh` 一直等密码                                             | 无 TTY 且未设 askpass                                                                                          | `SSH_ASKPASS`+`SSH_ASKPASS_REQUIRE=force`（无 `sshpass`）                                                                                                    |
| `--check-fresh` 报 MISSING/多余                            | 缓存白名单与 integrity 面不同源                                                                                      | 两处名单必须同名同源（见 SECURITY-GOVERNANCE §9.2）                                                                                                                    |
| 会话里看不到 `winvm__*` 工具                                    | 连接器写入的是活跃账户 `mcp.json`，**新会话**才注入                                                                          | 重跑 `install-host.mjs` 后新开会话；`diagnose-connectors` 定位                                                                                                      |
| VM `/health` 通、宿主不通                                     | 隧道未起/旧隧道占监听                                                                                                | `winvm-plugin tunnel status` → `ensure`；必要时 kill 旧 PID 再起                                                                                                 |
| GUI 能力失败                                                | 会话非交互式/已锁屏                                                                                                 | 用 LogonTrigger 的已登录会话；锁屏态属 Windows 安全边界                                                                                                                   |
| 401 `AUTH_REQUIRED`                                     | `enforceBearer=true` 且配了 token                                                                             | 走回环隧道（默认 `loopback-only` 豁免）或带 `Authorization: Bearer`                                                                                                    |
| 下载 `curl (28) Failed to connect to github.com port 443` | 链路抖动（非封禁）                                                                                                  | `curl -I https://github.com` 数次拿到 200 即抖动；加 `--retry 5 --retry-all-errors -C -`，并用 `releases/download/<TAG>/` 绝对 URL                                      |
| 部署打印「✅ 完成」但服务没起                                         | `.env` 里 `WINVM_DRY_RUN=1` 把 `--apply` 降级成 dry-run                                                         | 改 `WINVM_DRY_RUN=0` 重跑                                                                                                                                    |
| `deploy-vm` 报 `vm-node` 检查失败                            | VM 无 Node 或 <18（`blocking`）                                                                                | 先跑 Step 3.0：有 nvm 就 `nvm install 24.21.0 && nvm use 24.21.0`，无 nvm 用 MSI 静默装（需桌面会话）                                                                       |
| `deploy-vm` 报 `vm-npm` 检查失败                             | 只有 node 没有 npm（非常见：node 安装残缺）                                                                              | 重装完整 Node 发行版；不要单独补 npm                                                                                                                                   |
| `deploy-vm` 报 `vm-agent-cli` 检查失败                       | VM 内 `codebuddy --version` 非 0（`provider=workbuddy` 时 `blocking`）                                          | `npm i -g @tencent-ai/codebuddy-code`；或临时改 `WINVM_VM_PROVIDER=workbuddy-deterministic` 先通链路                                                               |
| 装完 codebuddy 后又「找不到命令」                                  | `nvm use` 切了 Node 版本 → 全局包在旧版本 prefix 里                                                                    | 在当前版本重装：`npm i -g @tencent-ai/codebuddy-code`；核对 `npm config get prefix`                                                                                  |
| 想用 `winget install OpenJS.NodeJS.LTS` 装 Node            | 经 ssh 非交互会话 MSIX alias 空壳（`winget --version` 输出空且 exit 0）                                                  | 不要依赖 winget；用 nvm 或 MSI 静默安装                                                                                                                              |
| 远端 PowerShell `ParserError` / 中文乱码                      | 内联 `-Command` 被本地 bash 展开 `$_`；UTF-8 中文载荷乱码                                                                | 逻辑写 `.ps1` → `scp` → `powershell -NoProfile -ExecutionPolicy Bypass -File`；载荷保持 ASCII                                                                     |
| `tools/list` 能看到高危工具                                    | **正常**：原始 MCP 面恒列全 54                                                                                      | 闸门在宿主 `~/.workbuddy/mcp.json` 的 `disabledTools`（8 条），不在此处                                                                                                 |
| `a2a.delegate` → `INVALID_PARAMS: goal 必填`              | 参数是 `goal`（自然语言），不是 `capability`/`input`                                                                   | 传 `{"goal":"…"}`，可带 `maxRisk`                                                                                                                             |
| `/a2a/health` → 404                                     | 该路由不存在（404 ≠ 故障）                                                                                           | 发现用 `GET /.well-known/agent-card.json`；健康用 MCP 工具 `a2a.health`                                                                                            |
| `app.inventory.list` → `INVALID_PARAMS 不支持的参数 limit`    | 该能力无 `limit` 形参                                                                                            | 传 `{}`                                                                                                                                                    |
| 安装后 `connectors/skills/mcp.json` 被写入 winvm              | 用了早于 P2-3 修复的 Release 包                                                                                    | 从 HEAD 重打并发布新版本（见 §9）；不要直接依赖旧 tag                                                                                                                         |


## 7. 指导 WorkBuddy 全流程安装的 Prompt

> 使用方式：把下面整段粘给 WorkBuddy（鸿蒙宿主），它会按此自驱动完成六步并在失败时停在判据处。  
> 变量取值先与用户确认（见 §0.5）；正式版见 `docs/deploy/deploy-prompts.md`。

```text
你是 WinVM Bridge 的部署执行者。请从零完成本项目的双端安装，严格按顺序执行并在每一步用
「判据」自检；任何判据不通过就停下并报告（现象/根因/证据/建议），不要跳步硬推。

【环境常量】VM_HOST=172.16.100.2  VM_USER=User  VM_SSH_PORT=22  SERVICE_PORT=18443
  VM_DEPLOY_DIR=C:/WinVMBridge  PROVIDER=workbuddy  WORKBUDDY_CLI=codebuddy
  RELEASE_TAG=V1.4.2  ZIP=winvm-overall-V1.4.2.zip
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
  判据二：python3 qa/deploy-probes/verify-manifest.py <包根> → RESULT: PASS
        （逐文件 sha256 + files/bytes 计数 + total-sha256 复算 + 无多余/缺失文件）
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

| 维度   | 旧流程（INSTALL-GUIDE §5）                      | 本策略（v2）                                          |
| ---- | ------------------------------------------ | ------------------------------------------------ |
| 代码来源 | 本地仓库 `npm ci` + `tsc -b` 现构建               | **GitHub Release 整包**（预构建 + sha256/MANIFEST 双校验） |
| 起点   | 假定已有免密通道                                   | **从密码登录开始**，免密通道由第 1 步现场建立                       |
| 编排   | `setup.mjs` 一条龙（BUILD→HOST→VM→TUNNEL→TEST） | 拆成**可独立验证的 6 步**，每步带判据                           |
| 适用   | 开发者本机                                      | 新机/重装/交付第三方                                      |

> 两者不冲突：本策略在 Step 3/4 之后可直接复跑 `setup.mjs --apply --skip-build` 做整体回归。

---

## 9. 变更记录

| 日期         | 版本   | 变更                                                                                                                                                                                                                                                                  |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-26 | v2.0 | 首版：六步策略、可行性论证、实测基线与排错表、WorkBuddy 指导 Prompt                                                                                                                                                                                                                          |
| 2026-10-26 | v2.1 | 六步**全流程真机实测通过**（25/25）：补 §0.5 部署参数变量表、各步「实测记录」、`qa/deploy-probes/` 四探针；`AGENT_PROVIDER` 默认改 `workbuddy`                                                                                                                                                             |
| 2026-10-26 | v2.2 | 新增 **Step 3.0 VM 运行时前置自检**（node≥18 / npm / codebuddy CLI / 登录态）：`qa/deploy-probes/vm-env-check.ps1`（含 `-Fix` 与 `-SimulateMissing` 自测）+ §0.5-F 前提变量表 + §2.3 安装面实测 + 排错 6 条。**provider 维持 `workbuddy` + `WINVM_WORKBUDDY_CLI=codebuddy`（用户裁定不引入 `workbuddy-native`）** |
| 2026-10-26 | v2.3 | 新增 **§2.1-B 空密码分支预案**（首选设密码／次选两层同时放行 + 建好即回滚）+ `VM_PW_MODE` 变量 + §0/§1 口径订正（原「与 PermitEmptyPasswords 无关」被实测证伪：**两层都在拒**）+ 排错拆成「有密码/空密码」两条                                                                                                                           |

### 9.1 本次实测发现的三处发布链缺口（须在下次发版前处置）

| #   | 缺口                                                                | 证据                                                                                                                                                                                                           | 影响                                                                                                                         | 建议                                                                                                                                                    |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1 | **V1.4.2 包早于 HEAD 的 P2 修复**（包构建于 `eba187e`/10-21，修复在 10-24~10-25） | 包内 `install-host.mjs` 无 `NON_ACCOUNT_DIRS`（0 次，仓库 3 次）；安装后 `connectors/skills/mcp.json`、`connectors/marketplace-meta/mcp.json` 被写入 `connector:winvm`；包内缺 `delivery/tools/diagnose-connectors.mjs`（安装末尾自检被跳过） | 用 Release 安装会**带回已修缺陷**，并制造非账户目录污染                                                                                         | 发 **V1.4.3**：`tsc -b` → `pack-release` → `publish-release`，把 `delivery/tools/` 一并纳入包；`pack-release` 增加「包内 `install-host.mjs` 必须含 NON_ACCOUNT_DIRS」硬断言 |
| G-2 | **`MANIFEST.txt` 无消费者校验**                                         | 全仓只有 `pack-release.mjs` 生成；`delivery/` 下无 verifier                                                                                                                                                           | 第 2 步「第三层校验」原本无法执行，包内损坏无法在安装前发现                                                                                            | 把 `qa/deploy-probes/verify-manifest.py` 收编为 `delivery/verify-release.mjs`（Node 实现），并在 Step 2 判据里强制调用                                                  |
| G-3 | **`qa/deploy-probes/` 不进发布包**                                     | `pack-release.mjs` 的 VM_PROBES 只含 `qa/probes/qa-probe.ps1`、`qa/probes/lead-md5-3.ps1`；V1.4.2 包内 `grep -c 'deploy-probes' MANIFEST.txt` → **0**                                                               | Step 2 的 `verify-manifest.py`、Step 3.0 的 `vm-env-check.ps1`、Step 3/5 的 `vmcheck/mcp-probe/a2a-probe` 在**纯 Release 安装**下拿不到 | 把 `qa/deploy-probes/` 加入 overall 白名单；在此之前 Step 3.0 用**内联最小判据**兜底                                                                                      |

> 三处缺口**不影响本策略可行**（六步均已实测通过），但影响「从 Release 安装」的**交付质量**。  
> 处置顺序建议：先修 G-2 / G-3（低成本、纯增量）→ 再随 V1.4.3 一起关 G-1。
