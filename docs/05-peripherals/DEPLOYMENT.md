# 部署指南 · WinVM 跨机 Agent 插件（1+5 双通道方案）

> 本指南描述如何将 `winvm-bridge` 插件部署到 **宿主机 WorkBuddy**（控制端）与 **Windows 虚拟机**（被控端），形成"宿主机完全操作虚拟机"的能力闭环。

---

## 0. 架构一句话

```
宿主机 WorkBuddy
  └─ 插件 winvm-bridge（connector + 6 skills）
        │  MCP 通道（工具级，精确执行 / 自动化首选）
        │  A2A 通道（任务级，自然语言目标 / 委派首选）
        ▼  (仅经 SSH 隧道 127.0.0.1:18443，双栈 rest 端口)
Windows 虚拟机
  └─ vm-service（MCP+A2A 双协议服务端）
        └─ agent.provider 总开关（VM 侧 AI Agent 选型）
              ├─ workbuddy-deterministic → adapter-agent-workbuddy（确定性执行器）
              ├─ workbuddy             → adapter-agent-workbuddy-llm（LLM Agent，V1 已实现）
              └─ hermes-agent         → adapter-agent-hermes（Nous Research Hermes Agent，MCP 预注册）
              └─ vm-capabilities（ps-bridge 常驻进程 + 五大 PowerShell 模块）
```

---

## 1. 双端一键部署（setup.mjs，推荐）

`delivery/setup.mjs` 读取项目根目录 `.env`，**一条命令完成「宿主机侧 + VM 侧」的安装、部署、隧道与自检**，生成 BUILD → HOST → VM → TUNNEL → TEST → HEALTH 六阶段计划。

> ⚠️ **安全默认**：
> - 不加 `--apply` 即 `--dry-run`，只打印计划、**不改动任何系统**；真执行的**唯一**入口是显式 `--apply`
>   （`.env` 里写 `WINVM_DRY_RUN=0` **也不会**自动触发执行）。
> - `WINVM_DRY_RUN=1` 是兜底保险：即便传了 `--apply` 也强制保持 dry-run。

```bash
# 1) 复制模板并填写（.env 含连接凭据，已被 .gitignore 忽略，勿入库）
cp .env.example .env
#   编辑 .env：HOST_DEPLOY / VM_DEPLOY / VM_HOST / VM_USER /
#             WINVM_VM_PROVIDER / WINVM_SETUP_TUNNEL / WINVM_DRY_RUN …

# 2) 先 dry-run 看清将执行的步骤（默认，可不带任何参数）
node delivery/setup.mjs

# 3) 确认无误后真正执行（构建 + 双端部署 + 隧道 + 自检）
node delivery/setup.mjs --apply

# 指定配置文件（默认 .env，也可用 --env=路径/.env）
node delivery/setup.mjs --apply --env=/path/to/.env
```

### 1.1 `.env` 关键项

| 配置 | 含义 | 默认 |
|------|------|------|
| `WINVM_SERVICE_PORT` | VM 服务监听端口（仅 127.0.0.1） | `18443` |
| `HOST_DEPLOY` | 是否部署宿主机侧插件 | `1` |
| `HOST_WORKBUDDY_HOME` | WorkBuddy 主目录（留空自动探测 `~/.workbuddy`） | 空 |
| `VM_DEPLOY` | 是否部署 VM 侧 | `1` |
| `VM_HOST` / `VM_SSH_PORT` / `VM_USER` | VM 地址与 SSH（留空则转为本地手动部署指引） | — |
| `VM_DEPLOY_DIR` | VM 内部部署根目录 | `C:/WinVMBridge` |
| `WINVM_VM_PROVIDER` | **VM 侧 AI Agent 选型**（`agent.provider`） | `workbuddy-deterministic` |
| `WINVM_WORKBUDDY_CLI` | LLM 运行时可执行名（仅 `workbuddy` 选型生效） | `codebuddy` |
| `WINVM_HERMES_CLI` | LLM 运行时可执行名（仅 `hermes-agent` 选型生效） | `hermes` |
| `WINVM_SKILLS_ROOT` | 共享 Skills 根（覆盖 provider 默认 `C:/WinVMBridge/shared-skills`） | 空（用 provider 默认） |
| `WINVM_SETUP_TUNNEL` | 是否建立 SSH 本地转发 | `1` |
| `WINVM_DRY_RUN` | `1`=强制只规划（兜底，即便 `--apply` 也不执行）；`0`=允许执行但仍需显式 `--apply` | `1` |

### 1.2 VM 侧 AI Agent 选型（agent.provider）

通过 `WINVM_VM_PROVIDER` 即可切换 VM 内承接任务的 AI Agent，**桥接层 / MCP / A2A / Skills 全部零改动**：

| 取值 | 包 | 能力 |
|------|----|------|
| `workbuddy-deterministic` | `@winvm/adapter-agent-workbuddy` | 确定性执行器（可预测、易监管，默认） |
| `workbuddy` | `@winvm/adapter-agent-workbuddy-llm` | LLM Agent（VM 内 `codebuddy` CLI 承接开放/创意任务，V1 已实现） |
| `hermes-agent` | `@winvm/adapter-agent-hermes` | LLM Agent（Nous Research **Hermes Agent** CLI 承接开放/创意任务；`init` 时把本服务 `/mcp` 预注册进 hermes 配置，无 `--mcp` 参数故走预注册，见 ADR-13） |

`setup.mjs` 会把该选型透传给 `install-vm.mjs --provider <id> --cli <exe>`，生成的运行配置即 `agent.provider=<id>`；`vm-service` 启动时据此动态加载对应 provider 包。详见 `docs/02-design/LLM-PROVIDER.md` 与 `SPEC-AGENT-SERVICE-BRIDGE.md §6.1`。

### 1.3 TEST / HEALTH 阶段自检

`--apply` 末尾两个阶段各司其职：

- **TEST**：本地跑 `vm-service --self-test`，校验能力注册表、ps-bridge 与所选 provider 的能力目录。self-test 会打印 provider 的 `id / kind / 声明能力目录`，可作为「provider 是否生效」的冒烟验证。
- **HEALTH**（需 `WINVM_SETUP_TUNNEL=1` 且 `VM_HOST` 已配置）：经隧道 `curl` 远端 `/health`，并**打印响应体**——含 `ok` / `provider` / `psBridge` / `capabilities` / `audit`，是端到端验收的直接证据：

  ```json
  {"ok":true,"provider":{"id":"workbuddy","state":"ready"},"psBridge":{"state":"ready"},
   "capabilities":{"count":54,"available":54},"audit":{"chainValid":true},"exposed":54}
  ```

  `session.state` 若为 `degraded`（如远端锁屏 / Explorer 未运行），表示 **GUI 能力不可用**，属预期环境限制而非部署故障 —— ps-bridge 设计要求 GUI 必须跑在交互式用户会话内。

> HEALTH 依赖 VM 侧 HTTP 服务已运行。该服务由计划任务 `WinVMBridge.Service`（**登录即启**）拉起；刚部署完若远端尚未重新登录，可手动触发：`schtasks /run /tn WinVMBridge.Service`。

> 若 `VM_HOST` 留空，`setup.mjs` 不会自动 ssh，而是打印本地手动部署指引（`install-vm.mjs --dry-run --provider …`），你可在 VM 内手动跑。

---

## 2. 前置条件

| 角色 | 要求 |
|------|------|
| 宿主机 | 已安装 WorkBuddy；Node.js ≥ 18；能 SSH 到被控端（**推荐密钥**，见 §7.2）；可读取 `~/.workbuddy` 配置目录 |
| 虚拟机 | Windows 10/11 或 Server 2016+；PowerShell 5.1+（代码已兼容 5.1，无需 PS7）；**若被控端是远程 Windows，需开启 OpenSSH Server 且 22 端口从宿主可达**（本地 VM 通常已具备）；`vm-service` 仅监听 `127.0.0.1` |

> ⚠️ **安全红线**：VM 侧 `vm-service` **只允许监听 `127.0.0.1`**。任何将 `0.0.0.0` 暴露到公网的配置都属高危，违反 SECURITY-GOVERNANCE 规范。

---

## 3. 虚拟机侧（被控端）部署

### 3.1 一键部署（推荐）

```powershell
# 先 dry-run 确认将执行的步骤，不写盘
node delivery/install-vm.mjs --dry-run

# 确认无误后正式部署（npm ci + build + 生成配置 + 注册任务计划程序自启 + 自检）
node delivery/install-vm.mjs

# 指定 VM 侧 AI Agent 选型（agent.provider）：确定性 / LLM / Hermes Agent
#   等价写法还支持环境变量 WINVM_VM_PROVIDER / WINVM_WORKBUDDY_CLI / WINVM_HERMES_CLI
#   provider 为 hermes-agent 时 CLI 自动解析为 hermes（可 --cli 覆盖）
node delivery/install-vm.mjs --provider workbuddy --cli codebuddy
node delivery/install-vm.mjs --provider workbuddy-deterministic
node delivery/install-vm.mjs --provider hermes-agent        # CLI 自动取 hermes；init 时把本服务 /mcp 注册进 hermes 配置

# 仅自检（验证 ps-bridge 五大模块、服务配置、provider 能力目录）
node delivery/install-vm.mjs --self-test

# 卸载（停服务 + 移除自启任务 + 清理生成物，保留源码）
node delivery/install-vm.mjs --uninstall
```

安装器会：
1. **依赖解析**：默认 `npm ci`（按 lockfile 精确还原依赖，保证可复现）；若以宿主 `setup.mjs` 推送的「仅 dist」产物部署（带 `--skip-install`），则跳过 `npm ci`，改由 `link-workspace.mjs` 建 `@winvm/*` workspace junction 软链来解析裸包名 import（详见 §7.6）。加 `--skip-links` 可跳过软链步骤。
2. `npm run build` 编译所有 packages 到 `dist/`
3. 基于 `delivery/vm-service.config.json` 生成运行配置（强制 `host=127.0.0.1`），并写入 `agent.provider`（来自 `--provider` / `WINVM_VM_PROVIDER` / 配置默认）及所选 LLM provider 的 `cliPath`
4. **部署共享 Skills**：把仓库 `skills/` 发布到独立共享根（默认 `C:/WinVMBridge/shared-skills`，单一事实源），并为各候选 VM AI Agent 的 skills 目录建立 **junction 引用**（不复制、不覆盖用户技能；可用 `--skills-root` / `WINVM_SKILLS_ROOT` 覆盖，`--skip-skills` 跳过）。详见 `docs/02-design/SPEC-SKILLS.md`
5. 注册 **Windows 任务计划程序** 任务（`WinVMBridge.Service`），登录即启、崩溃重启、仅在交互式会话运行（**不注册为 Windows 服务**，避免 Session 0 黑屏）
6. 运行自检：ps-bridge 五大模块可加载、配置校验通过、端口回环绑定、provider 能力目录可解析

### 3.2 手动部署（备选）

```powershell
cd D:\path\to\winvm-virtual-win-plugin
npm install --registry=https://registry.npmmirror.com
npm run build          # 编译所有 packages 到 dist/
```

### 3.3 启动 vm-service

```powershell
# 仅监听本机，双协议同端口 18443
node packages/vm-service/dist/cli.js `
  --host 127.0.0.1 `
  --port 18443 `
  --config delivery/vm-service.config.json
```

建议以 **Windows 服务 / 任务计划程序** 常驻（开机自启、崩溃重启）。配置项见 `delivery/vm-service.config.json`（含策略引擎默认 `defaultMaxRisk=L1`、路径黑名单、审计写入路径）。

### 3.4 自检

```powershell
node packages/vm-service/dist/cli.js --self-test   # 验证 ps-bridge 五大模块可加载
```

---

## 4. 宿主机侧（控制端）部署

### 4.1 运行安装器（幂等、增量、dry-run 先行）

```bash
# 先 dry-run 确认产物，不写盘
node delivery/install-host.mjs --dry-run \
  --home "$HOME/.workbuddy" \
  --host 192.168.1.77 --user vmadmin

# 确认无误后正式安装
node delivery/install-host.mjs \
  --home "$HOME/.workbuddy" \
  --host 192.168.1.77 --user vmadmin
```

安装器会：
1. 把 6 个 Skill 渲染为 WorkBuddy `connector-skills/connector-winvm/*/SKILL.md`
2. 生成插件清单 `plugin.json` + `marketplace.json`
3. 以 **增量 JSON patch** 方式写入 `connectors/default/mcp.json`，产出 **两个连接器条目**，**绝不整体覆盖**用户已有连接器：

   | 连接器 | 指针 | 形态 | 用途 |
   |---|---|---|---|
   | `winvm` | `/mcpServers/connector:winvm` | `streamableHttp` → VM `/mcp` | 简单任务：MCP 直调点分能力 ID |
   | `winvm-a2a` | `/mcpServers/connector:winvm-a2a` | `stdio` → 本地 `a2a-bridge/cli.js` | 复杂任务：`a2a.delegate` 委派给 VM 内 AI Agent |

4. 把 A2A 委派桥产物复制到插件目录 `plugins/cache/winvm/winvm-bridge/<ver>/a2a-bridge/`
5. **静态禁用 8 个高危工具**（`disabledTools`），需显式解除 + 审批才可用

> **为什么宿主侧要跑一个本地桥**：宿主（WorkBuddy）是 **MCP client，不是 A2A client**，
> 它的扩展点只有 MCP 连接器。`host-a2a-bridge` 以本地 stdio MCP server 形态补齐这一跳——
> 宿主调 `a2a.delegate`，桥内部再用 A2A client 调 VM 侧 `/a2a`。
> 桥与 MCP 通道**共用同一条 SSH 隧道**（`/mcp` 与 `/a2a` 并存），不新增任何暴露面。
> 详见 `docs/02-design/HOST-A2A-BRIDGE.md`。

### 4.2 建立 SSH 隧道（关键）

VM 服务仅监听 `127.0.0.1`，宿主机必须经隧道访问：

```bash
ssh -f -N -L 18443:127.0.0.1:18443 vmadmin@192.168.1.77
```

> ⚠️ 未建立隧道就调用工具会出现难排查的超时故障。隧道断线后服务端 `SessionMonitor` 会在 ~30s 内标记会话失活。

### 4.3 激活

重启 WorkBuddy → 连接器管理 → 确认 `winvm` 连接器已 **启用**（信任）。

---

## 5. 监管与运维

### 5.1 风险分级与审批

| 风险 | 工具示例 | 默认策略 |
|------|----------|----------|
| L0 | meta.health.check, system.info.get | 直接放行 |
| L1 | app.list, storage.disk.list, gui.window.list | 直接放行 |
| L2 | app.install, storage.file.copy, gui.control.click | **需人工/审批闸** |
| L3 | system.power.control, storage.file.delete, system.registry.write | 需审批 + 宿主显式 `maxRisk` 授权 |

- L2/L3 在 A2A 通道以 `input-required` 状态挂起，宿主确认后才 `tasks/resubscribe` 续跑
- 审计链（哈希链，防篡改）落盘于配置指定路径，可随时核验

### 5.2 监控

- 宿主侧：连接器状态、隧道存活、最近调用
- VM 侧：`SessionMonitor` 心跳保活；`vm-service --status` 输出健康度
- 审计查询：见 `USER-MANUAL.md` 的"审计与回放"章节

---

## 6. 卸载

```bash
node delivery/install-host.mjs --uninstall --home "$HOME/.workbuddy"
```

卸载同样走增量 patch（移除 `/mcpServers/connector:winvm` 指针），保留用户其他连接器。

---

## 7. 远程 Windows（非本地 VM）部署与 SSH 认证

本插件对"被控端是不是真·虚拟机"无感知——`vm-service` 只要跑在一台 Windows 上、经 SSH 隧道在 `127.0.0.1:18443` 可达即可。因此**把 `VM_HOST` 指向一台远程 Windows（物理机 / 云主机 / 内网机器），把本地当宿主、远程 Windows 当"VM"，完全适用**，效果就是"本地操作远程 Windows"。

### 7.1 与本地 VM 的唯一差别：远程 Windows 需开 SSH 服务

| 项 | 本地 VM | 远程 Windows |
|----|---------|--------------|
| 被控端 OS | Windows 10/11/Server | 同左 |
| 可达性 | 宿主已能 ssh/虚拟化访问 | **需 OpenSSH Server 监听 22 且宿主可路由** |
| 部署命令 | `setup.mjs`（scp + ssh） | 同左，仅 `VM_HOST` 换成远程 IP |
| 隧道 | `ssh -L … user@VM` | `ssh -L … user@远程IP`（完全一样） |

远程 Windows 上一次性前置（管理员 PowerShell）：

```powershell
# 安装 OpenSSH Server（Windows 可选功能）
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
# 防火墙放行 22
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH SSH Server' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

> `vm-service` 仍**只绑 `127.0.0.1`**（安全红线），对外只暴露 22（SSH），不直接暴露 18443。所有 18443 流量都走隧道；非回环直连会被 `requireLoopbackBind` 拒绝，且会触发 `tokenEnv`（`WINVM_BEARER_TOKEN`）bearer 校验。

### 7.2 SSH 通道怎么认证：用密钥，不用密码

`setup.mjs` / `install-vm.mjs` / `install-host.mjs` 内部的 `ssh` / `scp` / `ssh -L` 都是**直接调用系统 `ssh`**，脚本本身**不接收、不传递任何密码**（`.env` 里也没有密码字段，只有 `VM_HOST` / `VM_USER` / `VM_SSH_PORT`）。因此隧道与文件推送的认证**完全交给操作系统 SSH**——推荐且唯一能无人值守跑通的方式是 **SSH 公钥**。

**① 推荐：SSH 密钥（免密、`--apply` 可无人值守）**

```bash
# 1) 在宿主生成密钥（已有可跳过）
ssh-keygen -t ed25519 -C "winvm-host"      # 产物 ~/.ssh/id_ed25519.pub

# 2) 把公钥写入远程 Windows 用户的 authorized_keys
#    远程 Windows 的 authorized_keys 路径是 %USERPROFILE%\.ssh\authorized_keys
ssh <VM_USER>@<VM_HOST> "mkdir -p %USERPROFILE%\.ssh"
cat ~/.ssh/id_ed25519.pub | ssh <VM_USER>@<VM_HOST> "cat >> %USERPROFILE%\.ssh\authorized_keys"

# 3) 在远程 Windows 上修 ACL（OpenSSH 对权限极敏感，ACL 不对会直接无视该文件）
#    （在远程 PowerShell 执行，仅保留本人完全控制）
$acl = Get-Acl "$env:USERPROFILE\.ssh\authorized_keys"
$acl.SetAccessRuleProtection($true, $false)
# 然后按需移除多余继承项、仅留当前用户完全控制
```

> 若宿主 `~/.ssh` 下默认密钥不是 `id_ed25519`，脚本不会自动带 `-i`。请在宿主 `~/.ssh/config` 里按 `VM_HOST` 匹配一段 `IdentityFile`，或使用同名默认密钥，否则 `setup.mjs --apply` 仍会交互式要密码。

**② 密码：不建议，且基本无法无人值守**

- Windows 自带 `ssh`/`scp` 是交互式读密码的，脚本没有、也不会传密码；`.env` 也无密码字段。
- `sshpass` 在原生 Windows 上不随系统提供（需 WSL / Git-Bash 里的 `sshpass`，或改用 PuTTY `plink -pw`，但本插件调用的是 `ssh`/`scp` 而非 `plink`）。
- 因此若坚持用密码，只能**手动**在终端跑通一次 `ssh user@host`（让系统记住），或借助 ssh agent；`setup.mjs --apply` 这种一次性拉起多步 SSH 的流程会出现交互卡顿或失败。

> 结论：**远程 Windows 场景一律用 SSH 密钥**。密码只适合你本人在终端偶尔手动连一下。

### 7.3 首次连接的主机密钥确认

脚本不会自动带 `-o StrictHostKeyChecking=…`。第一次 `ssh`/`scp` 到新远程机会提示 `Are you sure you want to continue connecting (yes/no)?`，无人值守时会卡住。提前处理：

```bash
# 手动接受一次主机密钥（写入 known_hosts）
ssh -o StrictHostKeyChecking=accept-new <VM_USER>@<VM_HOST> echo ok
```

或在宿主 `~/.ssh/config` 对应 Host 块加 `StrictHostKeyChecking accept-new`、`UserKnownHostsFile ~/\.ssh/known_hosts`。

### 7.4 端到端验证（远程目标）

```bash
# 1) 确认密钥能免密登远程 Windows
ssh <VM_USER>@<VM_HOST> "powershell -c 'Get-ComputerInfo -Property CsDNSHostName'"

# 2) 跑 setup 一键（VM_HOST 已是远程 IP）
node delivery/setup.mjs --apply

# 3) 确认隧道打通 + 远端 /health
curl -s http://127.0.0.1:18443/health      # 应返回 VM 侧健康态
```

### 7.5 能力边界（与本地 VM 一致）

- 54 个能力在**远程 Windows 本机**执行 PowerShell（ps-bridge 在远端 spawn PowerShell 5.1），操作的正是那台远程机——即"本地操作远程 Windows"。
- **GUI 自动化**仍依赖远程 Windows 有活跃交互会话/显示器；无头远程机可能跑不了 GUI 模块（与本地 VM 同源限制）。
- 仅支持 Windows 被控端（强依赖 PowerShell 5.1），远程 Linux 不可作此"VM"。
- 另注意：SSH 认证（host ↔ 远程 Windows）与 MCP/A2A 的 **bearer token**（connector ↔ vm-service）是两回事。隧道是回环，bearer 免校验；只有非回环直连才需要 `WINVM_BEARER_TOKEN` + `tokenEnv`。

### 7.6 远程分发产物里有什么、依赖怎么解析（关键）

一键部署把**宿主已构建好的产物**直接推到远程 Windows，VM 侧 `install-vm.mjs` 以 `--skip-install --skip-build` 收尾（dist 已随产物到达）。这里有两个容易踩的坑，已在 V1 修复：

**① 产物清单（排除法，含运行时资产、不含 node_modules）**

`setup.mjs` 经 `packagePayloadPaths()` 发出每个 `packages/<name>/` 下、**排除** `src` / `node_modules` / `tsconfig*` 之后的**全部条目**，因此产物包含：

- `dist/`（编译产物）
- `psmod/`（**54 个 Windows 能力的 PowerShell 实现**，ps-bridge 运行必需）
- `schemas/`（`packages/contracts/schemas/`，契约 JSON Schema）
- 各 `package.json`
- **不含** `node_modules`（不传任何 npm 依赖）——因为 12 个包全部只有内部 `@winvm/*` 依赖，无需联网装包。

> 早期版本只发 `dist` + `package.json`，漏发 `psmod/` 与 `schemas/`，self-test 会报「找不到 ps-bridge 脚本」。

> ⚠ **`psmod/*.ps1` 必须保留 UTF-8 BOM**：脚本含中文注释/字符串 + `$(...)` 子表达式。中文 Windows 的 PowerShell 5.1 对**无 BOM 的 .ps1 默认按系统 ANSI 代码页（GBK）解码**，会把含 `$(...)` 的中文行误判为「字符串缺少终止符」、`ps-bridge` 进程启动即退出（`PSBRIDGE_NOT_RUNNING`）。加 BOM 后 PS 5.1 才会按 UTF-8 读。宿主 e2e 能过只是因为宿主 PS 环境（pwsh7 / UTF-8 代码页）碰巧解码正常——远端中文 Windows 仍会炸。重写这些文件时切勿丢掉 BOM。

**② 依赖解析：junction 软链代替 npm ci**

`dist` 里的 ESM import 仍是裸包名（如 `from '@winvm/contracts'`，编译期不重写）。远程若没有 `node_modules/@winvm/*`，`node cli.js` 会直接 `ERR_MODULE_NOT_FOUND`。

修复：`install-vm.mjs` 在 `--skip-install` 时调用 **`link-workspace.mjs`**，为每个包建一条 Windows **junction 软链**：

```
node_modules/@winvm/<pkg>  ──junction──▶  packages/<pkg>
```

junction 免管理员、免联网、幂等（已指向正确目标则跳过，被非 junction 占用则跳过并告警）。裸包名 import 由此解析，**远程 VM 全程不碰 npm registry**。

- 想保留 `npm ci` 路径（如要做二次开发）：去掉 `--skip-install`，安装器走 `npm ci`。
- 想跳过软链（如你已手动建好 node_modules）：加 `--skip-links`。
