# WinVM Bridge 完整安装指引
> 文档 ID：INSTALL-GUIDE ｜ 状态：现行权威 ｜ 更新：2026-10-26（本轮文档整理）

> 面向零基础使用者：在「全新鸿蒙 HarmonyOS NEXT PC（运行 WorkBuddy 桌面版）+ 同机 Windows 虚拟机」拓扑上，从零完成 WorkBuddy 虚拟 Windows 插件（WinVM Bridge，五域 54 能力）的一键安装、部署验证与日常运维。
>
> **事实性声明出处约定**：本文涉及的行为/数值均标注来源（形如 〔出处：…〕），全部引用自本仓库既有文件与已验证文档，未含虚构。核心出处：`delivery/setup.mjs`、`delivery/preflight.mjs`、`docs/01-investigation/oh-host-install-run-test.md`（下称《安装运行测试》）、`.workbuddy/memory/MEMORY.md`（下称 MEMORY）、`delivery/tools/README.md`。

---

## 前置：将仓库传输到新宿主机（全新机器才需要）

> 鸿蒙 HMOS 沙箱**无 git**（实测 `git` command not found 〔出处：MEMORY「关键坑」〕），因此「克隆仓库」这条路走不通，须先把本仓库（含 `node_modules`，因为离线构建也依赖）从旧机/源机搬运过来。

**路径 A（推荐）：tar 打包 + scp/网盘**

```bash
# 源机上打包（排除 .git——本来就无 git；排除可再生的构建中间产物）
tar -czf workbuddy-virtual-win-plugin.tgz \
  --exclude='.git' --exclude='*/dist' --exclude='.tsbuildinfo' \
  workbuddy-virtual-win-plugin/

# 传输二选一：
scp workbuddy-virtual-win-plugin.tgz <新宿主用户>@<新宿主IP>:~/          # 或
#   用网盘/U 盘拷贝 workbuddy-virtual-win-plugin.tgz 到新宿主可写目录

# 新宿主上解压（建议放用户可写目录，与 WorkBuddy 同级，例如 ~/Documents/projects/）
mkdir -p ~/Documents/projects
tar -xzf workbuddy-virtual-win-plugin.tgz -C ~/Documents/projects/
```

**路径 B：网盘整目录拷贝**：把仓库目录（不含 `.git`）经网盘客户端同步/拷贝到新宿主同一位置亦可，完成后 `ls delivery/` 应能看到 `setup.mjs`、`bootstrap.mjs` 等文件。

**校验与入口**：进入仓库根目录（`cd ~/Documents/projects/workbuddy-virtual-win-plugin`，后续 `node delivery/...` 命令都在此目录执行）后，先跑 `node -v`（确认 node 可用）与 `node delivery/bootstrap.mjs check`（§附录三步速查第①步）——全绿即表示搬运完整，才开始 §1 之后的步骤。

---

## §0 总览与架构一句话

**一句话**：宿主（鸿蒙 WorkBuddy）通过插件把「操作 Windows 虚拟机」的能力（system / app / storage / gui / appops 五域，共 **54** 项能力）注册给 AI；VM 内 `vm-service` 仅监听 `127.0.0.1:18443`、零对外暴露，宿主的一切访问都经 SSH 隧道回到回环 〔出处：《安装运行测试》§0〕。

- **双通道**：
  - **MCP 直调**：宿主连接器 `connector:winvm` 经隧道直调 VM `/mcp`——简单任务的首选 〔出处：MEMORY「双通道架构」〕。
  - **A2A 委派**：宿主连接器 `connector:winvm-a2a` 经同一隧道调 VM `/a2a`——复杂任务（streaming 审批流）〔出处：同上〕。工具名渲染规则：契约点分名**保留点号**，仅加 `winvm__` 前缀，即 `system.info.get` → `winvm__system.info.get`（tools/list 实测，出处 `delivery/install-host.mjs:1466`）。
- **provider 三选一**（VM 内 AI Agent 执行器，`.env` 键 `WINVM_VM_PROVIDER`）〔出处：MEMORY「VM 内 AI Agent」〕：

| provider | 机制 | 依赖 | 何时选 |
|---|---|---|---|
| `workbuddy-deterministic`（默认） | 确定性执行器，**运行时不 spawn 任何 CLI**，codebuddy 缺失仅警告不阻断 | 仅 node | 要可预测、易监管的默认路径 |
| `workbuddy` | VM 内 spawn `codebuddy` CLI 走 LLM，承接开放/创意任务 | VM 装并登录 codebuddy | 需要 LLM 自由发挥 |
| `hermes-agent` | Nous Hermes 执行器，spawn `hermes` CLI（无 `--mcp`，MCP 须预注册进其 config.yaml.mcp_servers） | VM 装 hermes | 特定 Hermes 生态需求 |

- **部署总入口**：`node delivery/bootstrap.mjs`（第 0 相位：环境自检/免密/配置）→ `node delivery/setup.mjs`（7 相位：BUILD → HOST → VM → VM-START → TUNNEL → TEST → HEALTH）〔出处：delivery/setup.mjs 头注〕。
- **安全红线**：`setup.mjs` 不传 `--apply` 永远 dry-run；`WINVM_DRY_RUN=1` 是兜底保险（即便误传 `--apply` 也强制 dry-run）；`bootstrap.mjs` 自身**永不**自动 `--apply` 〔出处：delivery/setup.mjs 头注 + delivery/bootstrap.mjs 头注〕。

---

## §1 环境准备——Windows VM 侧

> 以下全部在 **Windows 虚拟机内部** 操作。

### 1.1 启用 OpenSSH Server

1. 「设置」→「应用」→「可选功能」→「查看功能」→ 搜索并安装 **OpenSSH 服务器**。
2. 启动并设为自启（管理员 PowerShell）：
   ```powershell
   Set-Service sshd -StartupType Automatic
   Start-Service sshd
   ```
3. 确认默认 shell 不影响部署：本机拓扑实测 VM 默认 ssh shell 为 Git-Bash/MSYS（CLANGARM64），部署脚本已兼容 〔出处：《安装运行测试》§0/§0.5.3〕。

### 1.2 防火墙放行 22 / 18443

```powershell
New-NetFirewallRule -DisplayName "OpenSSH-Server-22"   -Direction Inbound -Protocol TCP -LocalPort 22    -Action Allow
New-NetFirewallRule -DisplayName "WinVM-Service-18443" -Direction Inbound -Protocol TCP -LocalPort 18443 -Action Allow
```
> 说明：18443 服务本身只绑 `127.0.0.1`，正常情况下外部访问不到该端口；放行规则仅为排查期直连核验留口子（如 `Test-NetConnection 127.0.0.1 -Port 18443`），非安全暴露 〔出处：《安装运行测试》§0「仅监听 127.0.0.1:18443」〕。

### 1.3 安装 Node.js ≥ 18（含 npm）

- 下载安装 Node.js LTS（≥ 18，建议 ≥ 22），安装时勾选「加入 PATH」〔出处：delivery/preflight.mjs `checkLocalVmDeps` 对 VM node/npm 均 blocking〕。
- 验证：`node -v`、`npm -v`。
- **务必系统级 PATH**：部署/服务经 ssh 非交互会话运行，node 只在交互用户 PATH 里会导致服务拉起失败。

### 1.4 codebuddy CLI 安装与登录（仅 provider=workbuddy 需要）

以下安装方式查证自 **codebuddy.cn 官方文档**（非虚构）〔出处：codebuddy.cn/docs/cli/installation、/docs/cli/quickstart〕：

- 方式一（npm，需 Node ≥ 18.20）：
  ```powershell
  npm install -g @tencent-ai/codebuddy-code
  ```
- 方式二（原生安装器，Beta，无需 Node.js；Windows PowerShell）：
  ```powershell
  irm https://www.codebuddy.cn/cli/install.ps1 | iex
  ```
- 验证：`codebuddy --version`。
- **登录**：在 VM 内运行 `codebuddy`，按提示完成登录认证（国内微信 / 海外 GitHub）。
- **可跳过条件**：provider 保持默认 `workbuddy-deterministic` 时**不需要** codebuddy（确定性执行器运行时不 spawn CLI，preflight 对其缺失仅 `[警告]`）〔出处：delivery/preflight.mjs 注释 + MEMORY〕。

### 1.5 关闭 VM 睡眠

「设置」→「系统」→「电源」→ 屏幕和睡眠均设为「从不」。历史排查确认 VM 重启风暴与睡眠无关，但长期隧道/服务场景下关闭睡眠是稳妥前提 〔出处：MEMORY「VM 运行时架构」——AC 睡眠=never 的既有事实〕。

### 1.6 （建议）添加 Windows Defender 排除项

本类 VM 上 Defender 逐进程扫描会使 powershell.exe 进程创建出现 **10–60s 随机延迟**，是安装/超时类抖动的共同土壤。建议部署前执行 `delivery/tools/add-defender-exclusions.ps1`（排除路径 `C:\WinVMBridge`、`C:\WinVMWorkspace`，排除进程 `node.exe`、`powershell.exe`；幂等，成功后回显当前排除清单）：

- 从宿主推送：`scp -P 22 delivery/tools/add-defender-exclusions.ps1 <vm-user>@<vm-host>:C:/WinVMBridge/`
- 在 VM 内以**管理员 PowerShell** 执行：`powershell -NoProfile -ExecutionPolicy Bypass -File C:/WinVMBridge/add-defender-exclusions.ps1`（非管理员会以 `DEFENDER_EXCLUSION_FAILED` 退出码 1 失败，属预期）
- 排除后实测：powershell spawn 从 10–60s 随机抖动降到 ~2s 稳定；注意它**不解决** VM 侧 codebuddy LLM 停滞（后者见 `qa/evidence/codebuddy-stall-diagnosis.md`，根因为 CLI 启动开销）。
- 排除属系统安全配置，重置 VM/重装系统后需重做。

---

## §2 环境准备——鸿蒙宿主侧

- **WorkBuddy 桌面版**已安装并初始化（确保 `~/.workbuddy` 目录存在，这是 preflight 的阻断项）〔出处：delivery/preflight.mjs `checkHostDeps`〕。
- **node**：WB 桌面版自带 node（以 `node -v` 实测为准；实测 v24.13.0，版本随 WB 升级浮动），**无需安装 nvm、也不适用 nvm**——`bootstrap.mjs check` 在 `process.platform` 为 `ohos`/`openharmony` 时自动跳过 nvm 探测 〔出处：MEMORY「Node 选择」+ delivery/bootstrap.mjs 实现〕。
- **系统自带 CLI**：`ssh` / `scp` / `tar` / `curl` 在 HMOS 沙箱实测均存在可跑（`/usr/bin/ssh`、`/usr/bin/scp`、`/bin/tar`、`/usr/bin/curl`），setup.mjs 的 VM 分发/启动/health 相位直接 spawn 它们；TUNNEL 相位走进程内 ssh2（`oh-tunnel.mjs`），不依赖系统 ssh 〔出处：《安装运行测试》§0/§0.5.2 + MEMORY「HMOS 宿主适配」〕。
- **python**：**非必需**——全链路（构建/部署/隧道/服务）均为 Node-only，`bootstrap.mjs check` 只作标注性检查，缺 python 完全不影响 〔出处：delivery/bootstrap.mjs 实现 + 项目全 .mjs 脚本链〕。
- 沙箱需联网（已实证：`npm ping`/`npm i`/`tsc -b` 全绿）〔出处：MEMORY「HMOS 宿主适配」〕。

---

## §3 SSH 免密与稳定通道

### 3.1 用 bootstrap trust 一键引导

```bash
node delivery/bootstrap.mjs trust
```
行为（幂等，可重复执行）〔出处：delivery/bootstrap.mjs 实现〕：

1. 本机无 `~/.ssh/id_ed25519` 时自动 `ssh-keygen -t ed25519 -N ""` 生成；
2. 发起**一次** ssh 连接（提示你输一次 VM 密码），把公钥同时追加到 VM 的两处：
   - `~/.ssh/authorized_keys`（标准用户）；
   - `C:/ProgramData/ssh/administrators_authorized_keys`（管理员组用户）——**这是 Windows OpenSSH 的已知坑**：管理员组用户的 per-user authorized_keys 会被 sshd **忽略**，必须写入 ProgramData 下的该文件，且其 ACL 只允许 SYSTEM + Administrators；脚本已自动用 `icacls /inheritance:r /grant SYSTEM:F /grant BUILTIN\Administrators:F` 修正权限；
3. 自动验证：`ssh -o BatchMode=yes VM_USER@VM_HOST whoami`。

### 3.2 免密成功判据

```bash
ssh VM_USER@VM_HOST whoami
```
**不输密码、直接返回 VM 账户名 = 成功**。仍提示输密码时，按 bootstrap 输出的「Next steps」排查（sshd 的 PubkeyAuthentication、administrators_authorized_keys 的 ACL——日志关键字 `Authentication refused: bad ownership`）。

> 公钥注入与 ACL 修正亦见于既有文档 《安装运行测试》§2 注（引 DEPLOYMENT.md §7 / SECURITY-GOVERNANCE §6）；bootstrap trust 是其自动化。

---

## §4 配置（.env 逐键说明）

模板：`delivery/env.example`（带完整中文注释）。生成方式二选一：

```bash
cp delivery/env.example .env                              # 手动复制后编辑
node delivery/bootstrap.mjs env                           # 交互式生成（已存在则先备份 .env.winvm-bak.<时间戳>）
node delivery/bootstrap.mjs env --vm-host=<IP> --vm-user=<账户>   # 参数式
```

| 键 | 默认/推荐值 | 说明 |
|---|---|---|
| `WINVM_SERVICE_PORT` | `18443` | VM 内服务监听端口（仅 127.0.0.1）〔setup.mjs〕 |
| `HOST_DEPLOY` | `1` | 是否部署宿主侧插件 |
| `HOST_WORKBUDDY_HOME` | 留空 | 自动探测 `~/.workbuddy` |
| `HOST_INSTALL_USER` | `vmadmin` | 仅日志/路径提示用 |
| `VM_DEPLOY` | `1` | 是否部署 VM 侧 |
| `VM_HOST` | 【必改】 | **Windows VM 的 IP**。示例 `172.16.100.2` 仅为本文档作者真机值，**须替换成你自己的 VM IP**（虚拟机软件里查看）〔《安装运行测试》§0〕 |
| `VM_SSH_PORT` | `22` | VM OpenSSH 端口 |
| `VM_USER` | 【必改】 | VM 侧 Windows 账户名（示例 `User` 同为作者真机值） |
| `VM_DEPLOY_DIR` | `C:/WinVMBridge` | VM 内部署根目录 |
| `WINVM_VM_PROVIDER` | `workbuddy-deterministic` | 三选一（§0 表） |
| `WINVM_WORKBUDDY_CLI` | `codebuddy` | provider=workbuddy 时的 CLI 名 |
| `WINVM_HERMES_CLI` | `hermes` | provider=hermes-agent 时的 CLI 名 |
| `WINVM_SETUP_TUNNEL` | `1` | 部署后建立 SSH 本地转发 |
| `WINVM_TUNNEL_LOCAL_PORT` | `18443` | 宿主侧本地监听 |
| `WINVM_TUNNEL_REMOTE_PORT` | `18443` | VM 侧目标端口（=SERVICE_PORT） |
| `WINVM_TUNNEL_BACKEND` | `ssh2` | 鸿蒙宿主推荐显式 `ssh2`（进程内 oh-tunnel.mjs，不依赖系统 ssh）；留空时 `ohos`/`openharmony` 平台也会自动启用（setup.mjs TUNNEL 守卫双平台兼容，实机 HMOS platform 实报 `openharmony`）〔setup.mjs TUNNEL 守卫〕 |
| `WINVM_DRY_RUN` | `1` | 安全兜底，保持默认勿改 |
| `WINVM_VM_KEY` / `WINVM_VM_PASSWORD` | 留空 | 非默认私钥路径 / 临时密码兜底（仅 ssh2 后端） |

> 典型取值全套示例见 `delivery/env.example` 尾部推荐值与《安装运行测试》§2。`.env` 含连接信息，勿提交入库（已 gitignore）。

---

## §5 一键部署

```bash
# 一条龙：环境自检 → SSH 免密引导（输一次密码）→ 生成 .env → setup.mjs 预览
node delivery/bootstrap.mjs all
```

`all` 末尾只会跑 **dry-run 预览**（安全红线，bootstrap 永不自动 `--apply`）。审查计划无误后，真执行：

```bash
node delivery/setup.mjs --apply
```

7 相位含义（`--apply` 下的执行顺序）〔出处：setup.mjs buildPlan + 《安装运行测试》§3.2〕：

| 相位 | 做什么 |
|---|---|
| `BUILD` | `npm run build` 构建全部包 |
| `HOST` | `install-host.mjs`：写两个连接器（`connector:winvm` / `connector:winvm-a2a`）、注册插件、写 `vm-conn.json`、PATH 注入；先触发宿主预检 |
| `VM` | 打包（delivery + skills + 各包运行时资产，**不含 node_modules**）→ `scp` → VM 内跑 `install-vm.mjs --skip-install --skip-build`；先触发 VM 预检 |
| `VM-START` | 干净重启服务（`schtasks /end` → 强杀残留端口进程 → `schtasks /run`），轮询 18443 监听 ≤60s |
| `TUNNEL` | SSH 本地转发 `127.0.0.1:18443 → VM:127.0.0.1:18443`（ohos/ssh2 后端走进程内隧道，HEALTH 后自动关闭） |
| `TEST` | 宿主机自检 `node packages/vm-service/dist/cli.js --self-test` |
| `HEALTH` | 经隧道 `curl --noproxy 127.0.0.1 http://127.0.0.1:18443/health`（重试 3 次） |

> 预检未过会对应在 HOST/VM 阶段 `exit 1` 并打印 remedy——按提示补依赖后重跑，**不要**用 `--no-preflight` 绕过 〔《安装运行测试》§3〕。

---

## §6 部署验证

### 6.1 /health 检查要点

```bash
curl -s --noproxy 127.0.0.1 --max-time 15 http://127.0.0.1:18443/health
```
（`--noproxy` 必加：本机代理/TUN 会拦回环流量 〔setup.mjs HEALTH〕。）

判定要点：

- `ok=true`、`provider` 与 `.env` 一致且 ready（provider=workbuddy 且已登录时走 LLM 路径）〔MEMORY〕；
- `exposed=54`（全部能力注册）〔《安装运行测试》§4〕；
- `audit.chainValid=true`、`audit.entries` 随调用递增（D30 修复后：启动开新分片全新 genesis，历史分片仅归档不参与校验）〔MEMORY「遗留 1」〕；
- `session.interactive`：`true` = GUI 域可用；`false` = MCP/A2A 与 54 能力正常、仅 `gui.*`（截图/键鼠/UIA/窗口/剪贴板）被门禁。注意历史踩坑：曾有 `Get-SessionHealth` 字符串比较的假阴性 bug（已用 `OpenWindowStationW` 实测判定修复）；重启服务救不了判定 bug，只能改码 〔《安装运行测试》§4〕。
- `psBridge` 降级语义（QA 遗留 P2 修复）：`/health` 的会话子探针有独立短超时（默认 5000ms，env `WINVM_HEALTH_PROBE_TIMEOUT_MS` 可调）——ps-bridge 未就绪时 `/health` 不再阻塞 ~27s。子探针超时而桥进程仍 ready 时：`ok=true` 不变、`psBridge.state='degraded'` + `psBridge.probe='timeout'`（可辨识降级原因）、`session.state='unavailable'`（结论未知）；GUI 门禁语义不变（非 healthy 即 GUI 不可用）。桥进程本身 down 时仍为 `psBridge.state='unavailable'`、`ok=false` 〔packages/vm-service/src/health-probe.ts〕。
- VM 内核验注意：Windows PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名，要用 `curl.exe`；勿 `curl | node -e` 管道解析 JSON（中文会变 `?` 导致 parse 失败），用 `node -e "fetch(...)"` 〔《安装运行测试》§4〕。

### 6.2 A 系列验收

```bash
node qa/probes/qa-verify.mjs          # 不传参数跑全部可自动化项（A1–A18）
node qa/probes/qa-verify.mjs A1 A4 A5 # 也可单跑
```
- **探针已随装**：setup.mjs 的 [QA-PROBE] 相位（TEST→QA-PROBE→HEALTH 顺序）会把 `qa/probes/qa-probe.ps1`、`qa/probes/lead-md5-3.ps1` 推送到 VM 的 `C:/WinVMBridge/`——**新机器部署完成后可直接跑 `node qa/probes/qa-verify.mjs`**，无需再手工 scp（历史踩坑：全新安装后 A1/A3/A11 因探针不在 VM 上而误报 `VM_UNREACHABLE`）〔setup.mjs QA-PROBE 相位注释〕。探针缺失时该相位仅 WARN 不阻断（QA 夹具属开发工具，非运行时依赖）；重推单相位可用 `node delivery/setup.mjs --apply --phase QA-PROBE`。
- 脚本自包含：会自检/自建隧道；桥不可达时依赖桥的断言记 `FAIL(BRIDGE_UNREACHABLE)` 而不崩 〔qa/probes/qa-verify.mjs 头注〕。
- **A3 会强杀一个 ps-bridge 实例属预期**——验证的是自愈（服务 `restarts` +1、自愈有界不风暴；CL-017 收口实测自愈 9279ms 无风暴）〔MEMORY〕。
- VM 负载高时个别调用超时：`QA_CALL_TIMEOUT_MS=90000 node qa/probes/qa-verify.mjs` 可调大单次超时（winget 等重调用建议 ≥90s）〔qa-verify.mjs 注释 + MEMORY〕。

### 6.3 双通道冒烟

```bash
# MCP 直调（宿主侧，经隧道）
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:18443/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"meta.health.check","arguments":{}}}'

# A2A 委派（宿主侧驱动器；委派超时已具界，A2A_DELEGATE_FAILED/超时即有界返回，不挂死）
node qa/probes/a2a.mjs meta.health.check '{}'
```
〔出处：qa/probes/a2a.mjs 头注 + MEMORY D28——宿主侧流式超时有界（`timeoutMs`，默认 600s，可传小值验证）〕。A2A 委派需 provider=workbuddy 且 VM codebuddy 已登录；VM 侧 LLM 停滞（60s 零进度 → `A2A_DELEGATE_FAILED`）为已知间歇性问题，deterministic provider 不受影响 〔MEMORY「VM codebuddy LLM 停滞（OPEN ISSUE）」〕。

---

## §7 日常使用

- **provider 切换**：改 `.env` 的 `WINVM_VM_PROVIDER` → 重跑 `node delivery/setup.mjs --apply`（VM 相位会以新 provider 重装服务）或 VM 内手动重装；`workbuddy` 需先装好并登录 codebuddy（§1.4）。
- **skills 同步**：技能规范经 `node delivery/deploy-shared-skills.mjs` 下发同步到 VM（安装时 setup.mjs 亦自动随包分发 skills）〔setup.mjs deployVm sources 含 `skills`；delivery/deploy-shared-skills.mjs 存在〕。
- **服务运维（tools/ 工具箱）**：`delivery/tools/` 下 `svc-state.ps1`（只读巡检）、`kill-restart.ps1`（干净重启）、`qa-kill.ps1`（自愈复现）、`start-hidden-vm.ps1`（手动拉起）、`probe-inv.ps1`（清单探针）、`verify-d30.ps1`（审计链复验）。**先 scp 到 VM 再 `powershell -File`，勿内联**；坑位清单见 `delivery/tools/README.md`。
  > ⚠️ `start-hidden-vm.ps1` 注意：repo 内副本系**作者机器的生成物**（其中 node.exe 路径等硬编码了作者 VM 的安装位置），**你的新 VM 请以 `install-vm.mjs` 在部署时生成到 `C:/WinVMBridge/` 的那份为准**，勿直接 scp repo 副本使用 〔出处：脚本头注「由 install-vm.mjs 生成，请勿手改」+ 硬编码路径事实〕。
- **隧道守护**：宿主侧常驻隧道守护 `node delivery/tunnel-daemon.mjs`（ssh2 实现，离线可用）〔delivery/tunnel-daemon.mjs + MEMORY CL-015「常驻隧道 daemon」〕；单次部署的隧道由 setup.mjs TUNNEL 相位临时建立并在 HEALTH 后释放。**隧道黑洞**（TCP 通但 HTTP 超时）时先杀宿主侧 ssh/隧道进程再重建，判据见 tools/README.md 坑 4。
- **运维端点（`POST /admin/llm-session/reset`）——默认关闭，按需临时开启**：该端点默认 404（env `WINVM_ADMIN_ENDPOINT=1` 才注册）。VM 服务环境变量的唯一来源是部署时生成的 `C:/WinVMBridge/delivery/.generated/start-hidden.ps1`（每次部署无条件重写，手改无效），故开关落在部署脚本上：`node delivery/install-vm.mjs --admin-endpoint`（VM 内手动执行，或经 setup 的 VM 相位机制调用）会在该 ps1 追加一行 `$env:WINVM_ADMIN_ENDPOINT = '1'`，去掉开关重部署即收回。
  > ⚠ **安全**：开启后端点同时具备「复位 LLM 常驻会话」与 `?faultInjection=1`（注入 spawn 故障 = 远程打挂会话）两种能力；服务虽只监听 `127.0.0.1`，但宿主经 SSH 隧道访问的正是同一个 loopback 服务 ⇒ 暴露面扩大到隧道另一端。**仅在需要验证时显式开启，验完必须去掉开关重新部署收回。**〔出处：`delivery/install-vm.mjs` 文件头「运维端点开关」段 + `buildTaskXml()` 注入逻辑〕

---

### 7.1 隧道生产化（CL-020 B 项）

> 实测背景：实机 HMOS（Node v24.13.0）`process.platform` 实报 **`openharmony`**（而非规格里的 `ohos`），仅判 `ohos` 会让真机隧道错误回落系统 ssh（QA E-4 实证）。CL-015 / CL-018 时期 `install-host.mjs` 与 `winvm-plugin.mjs` 的平台判断漏改 `openharmony`，CL-020 已全部补齐为 `=== 'ohos' || === 'openharmony'` 双兼容（参照 `delivery/setup.mjs` TUNNEL 守卫、`delivery/bootstrap.mjs` 既有写法）。

① **安装尾随自动拉起**：`install-host.mjs` 在安装尾相位（仅 OH / ssh2 后端且非 `--no-tunnel`）以 `spawn(process.execPath, [winvm-plugin, 'tunnel', 'start'], { stdio:'inherit' })` 零人工动作拉起常驻隧道；平台判定写 `process.platform === 'ohos' || process.platform === 'openharmony' || process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2'`，故鸿蒙宿主（`openharmony`/`ohos`）或显式 `WINVM_TUNNEL_BACKEND=ssh2` 均自动启用；失败仅告警、不影响安装主干，可手动补拉〔delivery/install-host.mjs T12 + delivery/setup.mjs TUNNEL 守卫〕。

② **管理命令**（宿主侧，仓库根目录执行）〔delivery/winvm-plugin.mjs tunnel 子命令〕：

```bash
node delivery/winvm-plugin.mjs tunnel start    # 拉起常驻 ssh2 隧道 daemon（detached + unref）
node delivery/winvm-plugin.mjs tunnel status   # 读 tunnel.state.json，显示 RUNNING / DEGRADED / STOPPING
node delivery/winvm-plugin.mjs tunnel stop     # 向 daemon 发 SIGTERM，清理 pidfile / state
```

③ **进程内 ssh2 隧道**：由 `delivery/tunnel-daemon.mjs` 承载——`spawn(process.execPath, [...], { detached:true, stdio:'ignore' })` 拉起后父进程退出仍存活（reparent 到 init/pid1）；通过 `OhSshTunnel`（进程内 ssh2）监听 `127.0.0.1:<localPort>` 仅回环转发到 VM `127.0.0.1:<remotePort>`；SSH 断线经退避重连自愈，断线期间状态如实报 `DEGRADED`；状态机 `STARTING → RUNNING / DEGRADED → STOPPING`，心跳写 `tunnel.state.json`（供 `tunnel status` 读取）〔delivery/tunnel-daemon.mjs〕。

④ **HOURLY watchdog 自动化兜底**：自动化 `aaa87da4`（每小时触发）探测宿主机 `tunnel.status`，进程死亡时自动 `tunnel start` 重启，弥补 daemon 自身崩溃的极端场景〔docs/archive/changes/CL-020/TECHNICAL-SOLUTION.md〕。

⑤ **平台判定硬纪律**：任何「宿主平台判断是否走 ssh2 隧道」的代码**必须**写成 `process.platform === 'ohos' || process.platform === 'openharmony'`（二者并列），不得只判 `ohos`。新增涉及隧道/宿主平台分支的代码一律沿用此双兼容式，否则实机 HMOS（`openharmony`）会静默回落系统 ssh 导致隧道失效〔MEMORY「HMOS 宿主适配」+ QA E-4〕。

---

## §8 故障排查（提炼自 MEMORY.md）

| 现象 | 根因 / 处置 |
|---|---|
| 端口能连上但 HTTP 超时（「隧道黑洞」） | VM 掉线时宿主 `ssh -N -L` 进程假活、仍占本地监听 → **TCP connect 成功 ≠ 服务存活**。半死判据：`ping` 100% 丢包 + `ssh Host is unreachable` + TCP connect 成功 + HTTP 超时。处置：杀宿主侧隧道进程（**勿用** `pkill -f 'ssh -N -L'`——会自杀，直 kill 已知 PID）后重建隧道 〔MEMORY「关键坑」+ tools/README 坑 2/4〕 |
| 改了能力模块（psmod/*.ps1）但不生效 | **ps-bridge 不可热更**：主循环 `while($true)` 只在 stdin 关闭/未捕获异常时退出。处置：重启 `WinVMBridge.Service`（`delivery/tools/kill-restart.ps1`） 〔MEMORY「GUI interactive 判定」〕 |
| VM 掉线后 ssh 命令一直卡 | 宿主 ssh 进程假活。处置：确认 VM 网络后 `taskkill` 宿主侧残留 ssh/隧道进程，再重试 〔MEMORY「隧道黑洞诊断」〕 |
| `/health` 的 `audit.chainValid=false` | 旧版并发竞态已修（D30）：取号+哈希+回写串行化；`freshChainOnStart` 语义 = **启动即开新分片、全新 genesis**，历史分片仅归档、不参与校验（见到 entries 小 ≠ 链坏）；`/health` 会透出 `brokenAt`+`reason`（HASH_MISMATCH/SEQ_DUP/SEQ_GAP/CHAIN_BREAK）。处置：升级到含 D30 的版本后重启服务，用 `delivery/tools/verify-d30.ps1` 复验 〔MEMORY「遗留 1」〕 |
| 错误返回两层 code | 设计如此：契约层 `code`（封闭码集，单源 errors.ts、登记 §2.6，管重试/审批）+ 领域层 `reason`（psmod `UPPER_SNAKE`，管补救），唯一映射点在 `adapter-agent-workbuddy` 的 `toBridgeError()`。按 reason 找补救、按 code 定重试策略 〔MEMORY「关键坑」〕 |
| ssh 传参 `/End` 变成 `C:/.../End`、`$_` 变 `/usr/bin/bash` | 远端默认 shell = Git-Bash(MSYS)：路径转换 + 变量吞。处置：远端逻辑一律写 .ps1 推过去 `powershell -File` 跑，勿 ssh 内联 〔MEMORY「关键坑」+ tools/README 坑 1〕 |
| `Sort-Object` 排序"不生效" | PS 5.1 对 `[ordered]@{}` 用 `-Property <键>` 静默失效：不带 `-Unique` 不排序、带 `-Unique` 塌成 1 条。处置：`-Property { $_.key }`（数值套 `[double]`）〔MEMORY + tools/README 坑 3〕 |
| A3 验收把 ps-bridge 杀了？ | 属预期：A3 就是强杀自愈验收（restarts +1 正常）；历史上「A3 强杀 × 委派负载并发 → 重生风暴致 18443 监听消失」已记录为 D31（复现条件特殊，服务可自恢复）〔MEMORY「遗留 4」〕 |
| 单测整批跑全红 | 铁律：`node --test tests/unit/*.test.js` 整批会因 junction symlink 打崩共享 runner。逐文件跑 〔《安装运行测试》§5.2 + MEMORY〕 |
| HMOS 沙箱跑 qa 脚本 node 崩（Exit 133） | node 二进制选错了。**版本号不可作判据**（hnp 与 bundled 的版本都会随 WB 升级浮动）：以「运行是否触发 native getcwd 断言（Exit 133）」为准——崩的就是该换的。用 bundled `/data/storage/el1/bundle/libs/arm64/node/bin/node`（实测可用；实测版本 v24.21.0，随 WB 升级浮动）〔MEMORY「Node 选择」〕 |

### §8.1 连接器已注册但会话未注入工具（R2 · R17-T04）

**现象**：安装器已把 `winvm`（streamableHttp）与 `winvm-a2a`（stdio）写入全局 `~/.workbuddy/mcp.json`
与各 `connectors/<account>/mcp.json`（install-host 输出「全局 mcp.json : 已增量合并 / 已就位」），
但会话里 ToolSearch 搜不到 `winvm__*` / `a2a.*` 工具。

**先定性**：工具注入是 WorkBuddy 平台行为（加载时机 / trust 状态 / stdio 子进程拉起），
本插件只能诊断与规避、无法根治。**旧会话永不热注入属预期**——注册发生在会话建立之后，
平台不会向既有会话补注入，这不是缺陷。

> ⚠ **关键澄清（R2-M4 H1 修复）**：**连接器页面显示「已连接」≠ 会话工具面已注入 winvm 工具。**
> 连接器页读取的是**全局** `~/.workbuddy/mcp.json`（决定「可见 / 已连接」），而会话工具面真正消费的是
> **活跃账户级** `connectors/<activeAccount>/mcp.json`（决定工具是否注入）——两者**独立**。
> 全局已就位、页显示「已连接」，但活跃账户级文件缺 `connector:winvm` / `connector:winvm-a2a` 时，
> 新会话**仍然零工具**（本机实测即此形态，根因 H1 = 上次安装漏写活跃账户条目）。
>
> **首选修复 = 重跑安装器补齐活跃账户条目**，而非仅在连接器页「启用」：
> ```bash
> node delivery/install-host.mjs            # 经 install-host 管道把 connector:winvm / connector:winvm-a2a 写进活跃账户（已含 KNOWN_ACTIVE_ACCOUNT）
> ```
> **重跑后务必校验"注入"而非只看页状态**：在 WorkBuddy **新开一个会话**，工具面 / ToolSearch 应命中
> `winvm__*`（`winvm__system.info.get` 等，点分名保留点号）与 `a2a.*`（`a2a.delegate` 等）；仍搜不到再走下方三步路径与只读诊断
> （旧会话永不热注入属预期，必须用**新**会话核验）。

**自助三步路径**：

1. **连接器页确认「信任 + 启用」**：WorkBuddy → 连接器 / 自定义 MCP，逐项确认 `winvm` 与 `winvm-a2a`
   处于已信任、已启用状态（connector states 实际路径 = `~/.workbuddy/connectors/<account>/connector-states.v3.json`，
   按账户目录存放，由平台首启时创建，可能为加密态，以页面为准；旧根路径 `~/.workbuddy/connector-states.v3.json`
   仅 legacy 兼容，出处 `delivery/tools/diagnose-connectors.mjs` 头注 :16-19）；
2. **重开一个新会话**再查工具面（判定口径：新会话 ToolSearch `winvm` 应命中 `winvm__*` / `a2a.*`）；
3. **仍异常 → 跑只读诊断**并按其 FAIL/WARN 处置：

```bash
node delivery/tools/diagnose-connectors.mjs          # 人读 + JSON 双段；exit 0=注册面就位 / 1=有必需缺失
node delivery/tools/diagnose-connectors.mjs --json   # 供程序消费
```

   诊断四项：① 全局 mcp.json 两条 server 与 transports；② 各账户 mcp.json 的 winvm 条目；
   ③ `connector-states.v3.json` 存在性/大小/mtime（可解析则报 enabled/trust 摘要，加密态如实标注、绝不解密）；
   ④ `winvm-a2a` stdio command 可执行性（只 stat + mode 位，绝不 spawn）。
   典型 FAIL 与补救：server 未注册 → 重跑 `node delivery/install-host.mjs`；
   stdio command/桥入口脚本不存在 → 插件缓存缺失，同样重跑 install-host；
   `disabled=true` / states 缺失 → 回到第 1 步在连接器页启用。

**若诊断为「注册全就位但新会话仍不注入」**：属 WB 平台侧疑点，证据（诊断 JSON + 会话新旧 + 账户 id）
按 `docs/design/r17-connector-injection-diagnosis.md` 的「WB 平台缺陷上报」模板整理上报；
期间宿主 agent 仍须遵守 orchestrator 门禁（工具不可用 → 停止并请求启用连接器，**严禁手写脚本绕行**）。

### §8.2 非账户目录排除（安装/卸载/诊断共用口径）

`~/.workbuddy/connectors/` 下的 `skills/`、`marketplace-meta/` **不是账户目录**——install-host 账户枚举
若把它们当账户槽位，会往里写 `mcp.json` 并每跑备份、uninstall 会备份改写它们、diagnose 会把它们误报为账户。
单一事实源 = `delivery/account-resolve.mjs:34` 的 `NON_ACCOUNT_DIRS = {skills, marketplace-meta}`（install-host
安装+卸载与 diagnose-connectors 三路径共用）；宿主适配器包 `packages/adapter-host-workbuddy/src/index.ts`（约 :55）
因 deps 边界保留同语义拷贝，由 `tests/unit/host-adapter.test.js` 恒等守卫钉死（两侧改动必须同步）；
`winvm-plugin.mjs` check/list 直接 import 单一事实源过滤。另注意 VM 侧技能分发排除 `hos-win-skill`
（`HOST_ONLY_SKILLS`，出处 `delivery/deploy-shared-skills.mjs:40`：宿主 8 Skill、VM 侧分发 7）。

---

## §9 卸载/重装要点

**统一入口：`delivery/uninstall.mjs`**（双端一键卸载器，与 bootstrap/setup 安装体系一一对应）。三步走：

```bash
# ① 预览（默认 dry-run：逐条列出将执行的清理动作，不做任何改动）
node delivery/uninstall.mjs

# ② 执行（默认保留 VM 工作区 C:/WinVMWorkspace；SSH 免密配置绝不触碰）
node delivery/uninstall.mjs --apply

# ③ 核验（--apply 结束时自动输出「清理后核验清单」，两端各项应全为 PASS）
#    亦可手动抽查：
ssh User@<vm-host> "powershell -NoProfile -Command \"Test-Path C:/WinVMBridge\""   # 应为 False
curl -s --noproxy 127.0.0.1 --max-time 2 http://127.0.0.1:18443/health || echo "port closed (预期)"
```

**关键行为（以脚本为准）**：

- **默认保留工作区**：`C:/WinVMWorkspace` 含运行期用户数据，默认**保留**；确需连同删除时加 `--purge-workspace`（`--keep-workspace` 为显式同义开关）。
- **SSH 免密默认保留**：两端 `~/.ssh`（密钥 / `authorized_keys`）与 VM 的 OpenSSH Server 属 OS 级组件，**不属于插件部署，卸载绝不触碰**（`--keep-keys` 仅作显式意图声明，无实际动作）。
- **永不触碰**：项目仓库本身与 `.env`、宿主 WorkBuddy 应用本体、其它插件/连接器/技能、VM 内 WorkBuddy 自带 MCP node 进程。
- **卸载范围（与 install-host / install-vm / setup 对称）**：
  - 宿主：常驻隧道守护进程（按记录 PID 精确 kill，另精确清理 bootstrap 期遗留的 `ssh -L 18443` 转发进程）；`plugins/cache/winvm/`、`plugins/marketplaces/winvm/`、`connectors/skills/connector-winvm/`（移入 `~/.workbuddy/winvm-trash/<时间戳>/`，可恢复）；`installed_plugins.json` 的 `winvm-bridge@winvm` 条目、各 `connectors/<account>/mcp.json` 的 `connector:winvm` / `connector:winvm-a2a`、`settings.json` 沙箱白名单条目（改动前均留 `*.winvm-bak.<时间戳>` 备份）；shell profile PATH 注入（`shell-init.sh` 行 + `.bashrc`/`.profile` 标记块）；`~/.workbuddy/winvm/` 下插件标记文件（`side.json` / `vm-conn.json` / `shell-init.sh` / `tunnel.state.json` / `tunnel.pid` / `tunnel.log` / `known_hosts`，目录本身保留）。
  - VM：计划任务 `WinVMBridge.Service`（`schtasks /End` + `/Delete`）；vm-service node 进程树与 `start-hidden.ps1` 包装进程（按 `C:\WinVMBridge` **命令行特征**识别并 `taskkill /T /F`，不按可执行文件路径——服务 node 与 WorkBuddy 自带 MCP node 共用同一 node.exe）；`C:/WinVMBridge/` 整目录；指向 `shared-skills` 的 Agent 技能 junction；VM 用户 PATH 中 `C:\WinVMBridge\delivery` 条目；VM 侧 `side.json` 标记。
- **VM 侧逻辑全部走 .ps1 推送**：卸载器生成临时 `winvm-un.ps1`，`scp` 到 VM 后 `powershell -File` 执行（远端默认 shell 为 Git-Bash/MSYS，内联 PowerShell 会被路径转换破坏——铁律，勿内联）。
- **幂等可重跑**：`--apply` 可重复执行；已清理项自动 `[SKIP]`。VM 连接信息解析链：`--vm-host/--vm-user/--vm-ssh-port` > 环境变量 `WINVM_VM_*` > `~/.workbuddy/winvm/vm-conn.json` > 项目 `.env`（`VM_HOST`/`VM_USER`/`VM_SSH_PORT`，只读）。
- **回滚**：宿主删除物在 `~/.workbuddy/winvm-trash/<时间戳>/`；注册文件备份 `*.winvm-bak.<时间戳>` 与原文件同目录。
- **重装**：卸载核验全 PASS 后直接 `node delivery/bootstrap.mjs all` → `node delivery/setup.mjs --apply`（bootstrap env 对已存在 `.env` 只备份不覆盖；SSH 免密保留可复用）。

〔出处：delivery/uninstall.mjs 头注 + 2026-09-20 真机全量清理实测（dry-run→apply→核验全 PASS）〕

> 历史方式（`setup.mjs --uninstall` / `install-vm.mjs --uninstall`）仍可用，但均为「软卸载」（VM 上保留源码/dist 目录）；**全新重装前的完全清理请统一用 `uninstall.mjs`**。

---

## 附：三步速查

```bash
node delivery/bootstrap.mjs check   # ① 环境自检（只读，随时可跑）
node delivery/bootstrap.mjs all     # ② 免密 + 配置 + 部署预览
node delivery/setup.mjs --apply     # ③ 真部署（审查预览后手动执行）
```
