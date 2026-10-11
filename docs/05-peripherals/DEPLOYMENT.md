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

`delivery/setup.mjs` 读取项目根目录 `.env`，**一条命令完成「宿主机侧 + VM 侧」的安装、部署、隧道与自检**（卸载时加 `--uninstall` 即可对称地一键移除双端本项目部分），生成 BUILD → HOST → VM → VM-START（部署后 `schtasks /run` 拉起服务，**并轮询 VM 本机 18443 端口监听 ≤60s 才认为启动完成**）→ TUNNEL → TEST → HEALTH（端口已通前提下取 /health JSON，短重试 3 次）七阶段计划。

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

  `session.state` 若为 `degraded`（如远端锁屏 / Explorer 未运行 / **服务落在非交互式会话**），表示 **GUI 能力不可用**，属预期环境限制而非部署故障 —— ps-bridge 设计要求 GUI 必须跑在交互式用户会话（WinSta0）内。

> **VM-START 已默认轮询端口监听（≤60s）**：一键部署在 VM 部署后默认经 `schtasks /run /tn WinVMBridge.Service` 拉起服务，并轮询 VM 本机 `127.0.0.1:18443` 直到进入监听态（最长 60s）才进入 TUNNEL/HEALTH。这消除了「服务冷启动 + 探针窗口太短」的竞态，绝大多数情况下 HEALTH 一次即通过；若 60s 仍未监听，会在日志中提示手动 `schtasks /run /tn WinVMBridge.Service` 后重跑。

> ⚠️ **GUI 可用性的关键约束**：经 **SSH 远程** `schtasks /run` **不保证**服务落在交互式（RDP）会话——它仅在「当前 VM 上已有 RDP 交互式登录」时才会落入该会话；若触发时只有 SSH/网络登录、无活跃 RDP 会话，服务会落到非交互会话（`windowStation` 非 `WinSta0`），`/health` 报 `session.interactive=false`、GUI 被门禁（MCP/A2A 与 54 项能力不受影响）。**要让 GUI 可用，服务必须在交互式会话内启动**：
> - 推荐：RDP 登录 VM，登录触发器（`AtLogOn`，任务 XML 已内置）会在你的交互式会话里**随 VM 登录自动拉起**服务；
> - 或安装完成后，在 VM 的**交互式 PowerShell（RDP 桌面内）**手动重启服务——`setup.mjs` 在检测到 `session.interactive=false` 时会**直接打印如下命令**，复制执行即可：
>   ```powershell
>   # 1) 结束当前（非交互式）服务实例；schtasks /end 会让调度器标记结束，后续 /run 不被 IgnoreNew 拦截
>   schtasks /end /tn WinVMBridge.Service
>   Start-Sleep -Seconds 2
>   # 2) 兜底强杀仍占用 18443 的进程，确保端口释放（先 /end 再强杀，/run 才会真正起新实例）
>   $p = (Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
>   if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
>   Start-Sleep -Seconds 1
>   # 3) 在当前交互式会话重新拉起（GUI 可用）
>   schtasks /run /tn WinVMBridge.Service
>   ```
>   执行后重跑 `setup.mjs --apply` 的 HEALTH 阶段（或刷新 `/health`），应见 `session.interactive=true`、GUI 可用。
>
>   ⚠️ **「在交互式会话里启动服务」≠「GUI 一定可用」**：`Get-SessionHealth` 判定 GUI 可用还额外要求**当前未锁屏**（`LogonUI` 未运行）且 **Explorer 在跑**。若在**锁屏状态**下执行上面第 3 步，`/health` 仍会报 `session.state=degraded`（detail「会话降级（锁屏或 Explorer 未运行）」）—— 此时会话确实是交互式的，但桌面被锁屏界面覆盖，截图 / SendInput 依然不可用。
>   遇到这种情况：**先解锁（或重新登录）VM 桌面、确认 Explorer 已启动**，再重跑第 3 步即可转为 `healthy`。该判定是刻意保留的，未放宽。
> **隐藏窗口机制（重要，易误解）**：任务以 `InteractiveToken` 运行（GUI 能力域必需 —— Session>=1 才能截图 / SendInput），而 Windows 对 InteractiveToken 任务**忽略 `<Hidden>true</Hidden>`**；单靠 XML 设 `Hidden=true` **仍会弹出常驻 node 控制台窗口**（用户可见、易误关，一关服务即停）。
> 因此部署时会在 `delivery/.generated/start-hidden.ps1` 生成启动器，计划任务实际执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<该脚本>"`，脚本内部再以 `Start-Process -WindowStyle Hidden -FilePath $nodeExe -ArgumentList $cliArgs -WorkingDirectory $workDir -Wait` 拉起 node —— 隐藏发生在**进程创建层**，这才是真正无窗口的做法。
> `-Wait` 让服务存活期间任务保持 Running，故 `schtasks /end /tn WinVMBridge.Service` 仍可终止服务、node 崩溃时仍触发自动重启，原有语义不变。

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

# 卸载（安全：仅删本项目，软链/共享 Skills 移入回收站，保留源码与 dist）
#   默认预览，加 --yes 才真正移除；--root 可指定仓库根（隔离测试）
node delivery/install-vm.mjs --uninstall        # 预览
node delivery/install-vm.mjs --uninstall --yes  # 执行
```

安装器会：
1. **依赖解析**：默认 `npm ci`（按 lockfile 精确还原依赖，保证可复现）；若以宿主 `setup.mjs` 推送的「仅 dist」产物部署（带 `--skip-install`），则跳过 `npm ci`，改由 `link-workspace.mjs` 建 `@winvm/*` workspace junction 软链来解析裸包名 import（详见 §7.6）。加 `--skip-links` 可跳过软链步骤。
2. `npm run build` 编译所有 packages 到 `dist/`
3. 基于 `delivery/vm-service.config.json` 生成运行配置（强制 `host=127.0.0.1`），并写入 `agent.provider`（来自 `--provider` / `WINVM_VM_PROVIDER` / 配置默认）及所选 LLM provider 的 `cliPath`
4. **部署共享 Skills**：把仓库 `skills/` 发布到独立共享根（默认 `C:/WinVMBridge/shared-skills`，单一事实源），并为各候选 VM AI Agent 的 skills 目录建立 **junction 引用**（不复制、不覆盖用户技能；可用 `--skills-root` / `WINVM_SKILLS_ROOT` 覆盖，`--skip-skills` 跳过）。详见 `docs/02-design/SPEC-SKILLS.md`
5. 注册 **Windows 任务计划程序** 任务（`WinVMBridge.Service`），**登录即启（`LogonTrigger`，随 VM 登录自动启动）**、崩溃重启、仅在交互式会话运行、**无 node 控制台窗口**（经 `start-hidden.ps1` 以 `Start-Process -WindowStyle Hidden` 拉起；⚠️ `InteractiveToken` 下 XML 的 `Hidden=true` 会被 Windows 忽略，详见上文「隐藏窗口机制」）（**不注册为 Windows 服务**，避免 Session 0 黑屏）
6. 运行自检：ps-bridge 五大模块可加载、配置校验通过、端口回环绑定、provider 能力目录可解析

> **关于 GUI 能力**：安装时注册的 `WinVMBridge.Service` 已内置 `LogonTrigger`，**VM 登录即自动启动**；但经 SSH 远程 `schtasks /run`（如 `setup.mjs` 的 VM-START 阶段）**不保证落在交互式会话**，从而 GUI 可能被门禁。若 `/health` 报 `session.interactive=false`，见 §1.3 的「在 VM 交互式 PowerShell 中 restart」命令块，复制执行即可让 GUI 可用。

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

> ⚠ **升级前清理旧键**：旧 `policy.approvalTimeoutMs` 键已被忽略并告警，升级前请删除（审批等待的真实 TTL 走环境变量 `WINVM_APPROVAL_TTL_MS`，默认 30 分钟；该配置键自 Phase 2 · P2-T2 起是死字段，留着只会在每次启动校验时多一条 warning，不改变任何行为）。

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

4. 把 A2A 委派桥产物复制到插件目录 `plugins/cache/winvm/winvm-bridge/<ver>/a2a-bridge/`，**并把它依赖的四个 `@winvm/*` 包（`contracts` / `core` / `mcp-framework` / `a2a-framework`）的 `dist` + `package.json` 一并打进 `a2a-bridge/node_modules/@winvm/`，使桥目录自包含**：
   - 桥是 ESM `stdio` 进程，`cli.js` 顶部 `import` 了这些 `@winvm/*` 包；ESM **不使用 NODE_PATH**，必须真实落地 `node_modules`。若缺失，点「信任」会报 `MCP error -32000: Connection closed`（`node cli.js` 启动即 `Cannot find module` 退出）。安装器已内置 `collectWinvmDeps()` + `installBridgeDeps()` 处理，重装不再复发。
   - 这四个 `@winvm` 包运行时**零第三方依赖**，仅彼此引用，故无需联网装包。
     > ⚠️ **订正（2026-09-14 · CL-015）**：上述断言**不准确**——`@winvm/core` 运行时**依赖 `ssh2@^1.16.0`**（及其传递依赖 `asn1` / `bcrypt-pbkdf` / `tweetnacl`）。`collectWinvmDeps()`（`install-host.mjs:119`）**显式跳过所有非 `@winvm/*` 依赖**，故第三方依赖**不经此路径分发**；`ssh2` 由 **CL-015 T11** 单独离线分发到 `<pluginRoot>/node_modules/ssh2`（顶层落点，覆盖 `oh-tunnel.mjs` 与 `a2a-bridge/node_modules/@winvm/core/dist/*` 两条 ESM 向上查找路径），optional 原生依赖（`cpu-features`/`nan`）缺失即降级。**CL-015 T11 已于 2026-09-14 落地**：`delivery/ssh2-resolve.mjs` 提供确定性解析链（注入 → 裸 `import('ssh2')` → `createRequire` 绝对兜底 → 三要素引导错误），`install-host.mjs` 的 `copySsh2Runtime()` 把 `ssh2` + 纯 JS 传递依赖（`asn1`/`bcrypt-pbkdf`/`tweetnacl`）扁平落地到插件缓存、`optional` 原生依赖缺失即降级；离线单测 `tests/unit/ssh2-resolve.test.mjs` 已锁。其余 `@winvm` 包当前无第三方运行时依赖。
5. **静态禁用 8 个高危工具**（`disabledTools`），需显式解除 + 审批才可用
6. **正式注册（转正）**：向 `plugins/installed_plugins.json` 写入 `winvm-bridge@winvm` 条目（schema `{version:2, plugins:{...}}`，含 `scope/installPath/version/installedAt/lastUpdated`），并清掉插件目录下的 `.orphaned_at` 标记。这样插件在 WorkBuddy 里显示为「已安装」而非孤儿，**不依赖运行时扫描时机**；`--uninstall` 会同步移除该条目。

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

1. **重启 WorkBuddy**，让它干净读取新写入的插件清单、Skills、`installed_plugins.json` 与连接器配置。
2. 打开 **连接器管理**，对以下两个连接器分别点 **信任（Trust）/ 启用**：
   - `winvm`（Windows 虚拟机）—— MCP 直调通道，连 VM `/mcp`。
   - `winvm-a2a`（Windows 虚拟机 · A2A 委派）—— 本地 `stdio` 桥，连 VM `/a2a`；复杂任务走 `a2a.delegate`。
3. 两个连接器端点都指向 `http://127.0.0.1:18443`，需先建立 §4.2 的 SSH 隧道且远端 VM 服务在监听，调用工具才会真正连通（同 §1.3 `/health` 前提）。

> 激活后即可在宿主 Agent 里以 MCP 工具形式调用 54 个 Windows 能力（`winvm` 通道）或委派复杂任务给 VM 内 Agent（`winvm-a2a` 通道）。

#### 4.3.1 排错：`winvm-a2a` 点信任报 `MCP error -32000: Connection closed`

这是 **stdio 桥进程启动即崩** 的典型表现，根因几乎总是 `a2a-bridge/` 缺少 `@winvm/*` 运行时依赖：

- 现象：点信任瞬间失败，日志显示 `Connection closed`；或连接器状态反复「未连接」。
- 排查：`ls <hostRoot>/plugins/cache/winvm/winvm-bridge/<ver>/a2a-bridge/node_modules/@winvm/` 应看到 `contracts` / `core` / `mcp-framework` / `a2a-framework` 四个目录（各含 `dist/index.js` + `package.json`）。
- 修复：**重跑 `install-host.mjs`**（它会自动把这四个包打入 `node_modules` 并写 `a2a-bridge/package.json`）。若仍缺，先 `npm run build` 再装。
- 注意：握手阶段的崩溃与「隧道/VM 服务是否就绪」无关——后者只影响工具调用，不影响信任握手。信任能握上手即说明桥进程已正常启动。

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

## 6. 卸载（双端一键，安全：仅删本项目、入回收站可恢复）

卸载**只移除本项目安装的部分**，绝不碰其它插件 / 连接器 / 技能 / 注册。所有被删除的目录与软链都**移入回收站（可恢复）**；注册文件的改动**先备份再改并打印 diff**，确认无误后才落盘。

### 6.1 一键卸载（推荐，setup.mjs）

与安装对称：不加 `--apply` 即预览，加 `--apply` 才真执行（`WINVM_DRY_RUN=1` 兜底）：

```bash
# 预览：打印宿主+VM 待移除项，不删除任何东西
node delivery/setup.mjs --uninstall

# 确认无误后真正卸载（宿主 install-host.mjs --uninstall --yes
#                     + VM ssh install-vm.mjs --uninstall --yes）
node delivery/setup.mjs --uninstall --apply
```

- `HOST-UNINSTALL`：移除 `installed_plugins.json` 的 `winvm-bridge@winvm` 条目、删除 `connectors/<account>/mcp.json` 里的 `connector:winvm` / `connector:winvm-a2a` 指针、把 `plugins/cache/winvm/winvm-bridge`、`plugins/marketplaces/winvm`、`connectors/skills/connector-winvm` 移入回收站（其余插件/连接器/技能原样保留）。
- `VM-UNINSTALL`：经 SSH 在 VM 内跑 `install-vm.mjs --uninstall --yes`，移除任务计划程序任务、`node_modules/@winvm/*` 中**仅指向 `packages/<pkg>`** 的 junction、各候选 Agent 技能目录中指向共享根的 junction、共享 Skills 根、`delivery/.generated`；源码与已编译 dist 始终保留。**VM 侧删除物默认落到 VM 内 `<repoRoot>/.uninstall-trash/<时间戳>/`（系统回收站经 SSH 不可见，故用此可恢复目录）**。

### 6.2 单端卸载（分开执行）

```bash
# 宿主机（控制端）：先预览（备份+diff，不移动目录）→ 确认后加 --yes 执行
node delivery/install-host.mjs --uninstall --home "$HOME/.workbuddy"        # 预览
node delivery/install-host.mjs --uninstall --yes --home "$HOME/.workbuddy"  # 执行（目录入回收站）

# 回收目录可改用自定义目录（便于测试 / 非 Windows）
node delivery/install-host.mjs --uninstall --yes --trash-dir /tmp/winvm-trash
# 清理卸载产生的 *.winvm-bak.* 备份（同样移入回收站）
node delivery/install-host.mjs --purge-backups

# 虚拟机（被控端）：先预览 → 加 --yes 执行（--root 可指定仓库根，用于隔离测试）
node delivery/install-vm.mjs --uninstall            # 预览
node delivery/install-vm.mjs --uninstall --yes      # 执行（任务移除 + 软链/共享 Skills 移入回收站）
#   ⚠ 经 SSH 执行时系统回收站不可见，删除物默认落到 VM 内 <repoRoot>/.uninstall-trash/<时间戳>/
#      RDP 进 VM 即可找回；如需系统回收站请在 VM 内交互运行并加 --recycle-bin
#      （也可用 --trash-dir <目录> 指定自定义回收目录）
```

> **安全细节（满足"先备份→改→diff 确认→才删 / 删除均入回收站"）**
> - 宿主侧对 `installed_plugins.json`、各 account 的 `mcp.json` 改动前先备份为 `*.winvm-bak.<时间戳>`；改动后打印行级 diff，确认**仅删除了本项目条目**。
> - 宿主侧目录/软链移入 **Windows 回收站**（可用 `--trash-dir` 指定本地目录）；**VM 侧因卸载经 SSH 执行、系统回收站写入不会反映到 RDP 桌面看到的回收站，默认落到 VM 内可恢复目录 `<repoRoot>/.uninstall-trash/<时间戳>/`**（RDP 进 VM 即可找回/恢复），亦可显式 `--recycle-bin`（仅限 VM 内 RDP 交互运行）或 `--trash-dir <目录>`。
> - 卸载**保留**源码、`packages/*/dist`，以及用户的其它插件 / 连接器 / 技能。

> **为什么「回收站里看不到某些被删的东西」是预期行为（对应常见疑问）**
> - **VM 侧回收站是空的**：卸载经 SSH 在 VM 内执行，系统回收站写入**不会反映到 RDP 桌面看到的回收站**（非交互会话上下文不同）。所以删除物默认落到 VM 内可恢复目录 `<repoRoot>/.uninstall-trash/<时间戳>/`（如 `C:/WinVMBridge/.uninstall-trash/2026-.../`），**不进 Windows 回收站**。RDP 进 VM 到该目录即可找回/恢复；若要进系统回收站，请在 VM 内**交互式**运行并加 `--recycle-bin`。
> - **宿主侧回收站里的文件比预期少**：宿主侧对注册文件（`installed_plugins.json` / `mcp.json`）是「**先备份 `*.winvm-bak.<时间戳>` → 改 → 打印 diff**」，备份文件**默认保留不进回收站**（便于回滚），所以回收站里看不到这些单文件；而本项目的三个目录才被移入回收站。确认无误后用 `install-host.mjs --purge-backups` 清理备份。

### 6.3 卸载 → 重装 → 验证 闭环

与你"卸载→重装→验证→再卸载→再装"的回归顺序一致：

1. `node delivery/setup.mjs --uninstall --apply` 卸载旧版（或分端跑 §6.2）
2. `node delivery/setup.mjs --apply` 一键重装（构建 + 双端部署 + 隧道 + 自检）
3. 重启 WorkBuddy → 连接器管理页对 `winvm` 与 `winvm-a2a` 分别「信任」→ 验证 54 能力可调 / 复杂任务可委派
4. `node delivery/setup.mjs --uninstall --apply` 再次卸载，确认宿主机与 VM 上的本项目痕迹均已清除（删物在回收站可恢复）
5. 最后 `node delivery/setup.mjs --apply` 装回，供日常测试

---

## 7. 插件管理命令 `winvm-plugin`

部署完成后，宿主机与 VM 两侧都会落地同一个管理 CLI `winvm-plugin`，自动识别运行上下文（host / vm），提供统一的查验与管理命令。

**落地位置与启动器（每处都带三件套：`winvm-plugin.mjs` 源 + `winvm-plugin.cmd` Windows 启动器 + 无扩展名 `winvm-plugin` POSIX 启动器 `+x`）：**
- **宿主机**：① 插件缓存根 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`；② 仓库 `delivery/`（`delivery/.winvm-context.json` 标记 `side=host`）。
- **VM**：部署根 `C:/WinVMBridge/delivery/`（`delivery/.winvm-context.json` 标记 `side=vm`）。

**怎么调（任选其一，均自动识别 side）：**
```bash
# 宿主机（在仓库目录内最顺手）
node delivery/winvm-plugin.mjs check                 # 通用写法，所有环境可用
./delivery/winvm-plugin check                        # Git Bash：靠无扩展名启动器 +x
# 或把 delivery/ 加入 PATH 后直接： winvm-plugin check
# Windows cmd/PowerShell 进到 delivery/ 后： winvm-plugin check  （经 PATHEXT 解析到 .cmd）

# VM 内（RDP/SSH 进到 C:/WinVMBridge/delivery/ 后）
node winvm-plugin.mjs check
./winvm-plugin check                                 # Git Bash
winvm-plugin check                                   # cmd/PowerShell（PATHEXT → .cmd）
```
> 若 `winvm-plugin`（无扩展名）提示权限不足，多半是该环境未设可执行位——直接用 `node winvm-plugin.mjs <子命令>` 即可，效果完全相同。

> 上下文判定优先级：`--side host|vm` > 同目录 `.winvm-context.json` > 启发式（注册表 + Skills 存在 → host；含 `packages/vm-service/dist/cli.js` → vm）。

### 7.1 子命令一览

| 子命令 | 说明 |
| --- | --- |
| `help` | 显示帮助 |
| `check` | 查验本侧部署完整性（注册条目 / 连接器 / 任务 / 文件 / 端口） |
| `health` | 探测 VM 服务 `/health`（host 经 SSH，vm 本地） |
| `list skills` | 列出已部署的共享 Skills |
| `list mcp-servers` | 列出 MCP 服务（host：连接器条目；vm：计划任务 + 端点） |
| `list mcp-tools` | 列出已暴露的 MCP 工具（按能力域分组，共 54 项） |
| `list dirs` | 列出本侧关键安装目录 |
| `server start\|status\|stop\|restart` | 控制 VM 服务（host 经 SSH；vm 本地 `schtasks`） |
| `command <tool> [--args '<json>']` | 直接调用一个 MCP 工具（host 经临时 SSH 隧道 + JSON-RPC 调 `/mcp`；vm 本地） |
| `uninstall [--vm]` | 卸载本侧（host 加 `--vm` 同时卸载 VM） |
| `update` | 重新应用本侧部署（等价于重跑安装器） |
| `reinstall` | 先卸载后重新安装本侧 |

### 7.2 Host 侧需要 VM 连接信息

`server` / `health` / `command` 在 host 侧会经 SSH 中继到 VM，连接信息按以下优先级获取：

1. 命令行：`--vm-host` / `--vm-user` / `--vm-ssh-port` / `--vm-port`
2. 环境变量：`WINVM_VM_HOST` / `WINVM_VM_USER` / `WINVM_VM_SSH_PORT` / `WINVM_VM_PORT`
3. 当前或向上目录的 `.env`：`VM_HOST` / `VM_USER` / `VM_SSH_PORT` / `WINVM_SERVICE_PORT`

> 提示：在**项目仓库目录**里运行 host 侧命令即可自动读 `.env`；否则显式传 `--vm-host` / `--vm-user`。

### 7.3 常用示例

```powershell
# —— 宿主机（管理端）——
winvm-plugin list mcp-tools                       # 看全部 54 个能力/工具（按域分组）
winvm-plugin check                                # 查验宿主机注册/连接器完整性
winvm-plugin health                                # 不传 --vm-host/--vm-user 则读 .env（VM_HOST/VM_USER）
winvm-plugin server restart --vm-host 192.168.1.50 --vm-user vmadmin   # 显式覆盖示例
winvm-plugin command meta.health.check            # 直接调一个 MCP 工具（需 .env 或 --vm-*）

# —— VM 内（已 RDP 登录的交互式会话）——
winvm-plugin check                                # 查验 VM 部署完整性 + 端口监听
winvm-plugin server status                        # 看计划任务是否注册、端口是否监听
winvm-plugin command system.info.query --args '{}'
```

### 7.4 GUI 不可用时的重启提示

`health` 若发现服务运行在**非交互式会话**（`session.interactive=false`），会自动打印一段在 VM 交互式 PowerShell 中执行的重启命令——先 `schtasks /end` 杀掉非 GUI 服务、强杀残留端口进程，再 `schtasks /run` 在交互式会话拉起 GUI 可用实例。这与 `setup.mjs` HEALTH 阶段的提示一致（详见 §1.3）。

---

## 8. 远程 Windows（非本地 VM）部署与 SSH 认证

本插件对"被控端是不是真·虚拟机"无感知——`vm-service` 只要跑在一台 Windows 上、经 SSH 隧道在 `127.0.0.1:18443` 可达即可。因此**把 `VM_HOST` 指向一台远程 Windows（物理机 / 云主机 / 内网机器），把本地当宿主、远程 Windows 当"VM"，完全适用**，效果就是"本地操作远程 Windows"。

### 8.1 与本地 VM 的唯一差别：远程 Windows 需开 SSH 服务

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

> `vm-service` 仍**只绑 `127.0.0.1`**（安全红线），对外只暴露 22（SSH），不直接暴露 18443。所有 18443 流量都走隧道。
> 关于"绑定"与"凭据"两件事，Phase 1 起口径如下（权威声明见 `SECURITY-GOVERNANCE.md` §2.1，勿凭旧印象配置）：
>
> - **回环约束不可关**：`bind` 非回环（如 `0.0.0.0`）⇒ 校验恒 **error** 且**启动被拒**；`security.requireLoopbackBind=false` 自 Phase 1 起**不再能放宽**该约束，只会额外产生一条 warning。因此"非回环直连"这种部署形态在本系统里**不存在**，跨机访问的唯一受支持形态就是本节讲的 `ssh -L` 隧道。
> - **bearer 是可选加固，默认不校验**：`security.enforceBearer` 默认 `false`；要生效需**双条件**（`enforceBearer===true` **且** `tokenEnv` 指向的 env 有值，缺一即逐字旧行为），是否真挂载由 `/health.security.authMode` 三态显形（`loopback-only` / `bearer-enforced` / `bearer-configured-missing`）。走回环隧道时默认**不需要**任何 bearer 配置。
> - ⚠ **`enforceBearer` 开启前置条件：VM 内回连凭据通路（P2-T6 已落地，默认未接线；三步见下）**。未接线就误开（双条件齐）——`buildMcpConfig()` 下发给 VM 内 agent CLI 的 `mcpServers` 条目零凭据——危害分两段（2026-10-10 B3 真机演练实测订正）：宿主不带凭据 ⇒ **HTTP 层当场 401**（可见，`--token-env` 覆盖此段）；VM 内回连段 401 打在**工具面** ⇒ 委派不报错、退化为**零副作用的虚假完成**（终态 `completed` + 链上 `zeroInnerCalls:true`「完成声称不予采信」，由 CL-K3R 真值层兜住）。⇒ 演练/排障时**不得**以"任务显示成功"推断守卫未生效；运维自查看 `/health.security.authMode`、`/health.security.innerReconnect`（P2-T6 起运行期自环探针会把实证结论 `ok/broken` 回填该观测面；fail-closed 拒启判据仍只看配置面）与服务日志 `bearer 守卫拒绝请求` warn（拒绝不入审计链）。残留登记见 `docs/changes/phase1-arch-design.md` §10 R4 与 `SECURITY-GOVERNANCE.md` §2.1（启用前置条件）/ §6.4（两项权衡）。
>
> **VM 内回连凭据分发三步（enforceBearer 开启的上线前置操作，P2-T6 交付）**——凭据纪律 = 变量名进配置、真值只进 VM 进程环境（NFR-511/K-17 不落任何明文盘）：
>
> 1. **分发 env（值）**：VM 上生成的 `delivery/.generated/start-hidden.ps1` 里显式赋值 `$env:WINVM_BEARER_TOKEN = '<真值>'`（计划任务无 env 通道，这是服务进程 env 的**唯一来源**；node 由 `Start-Process` 从该 ps1 继承环境，并经 `launchCliProcess` 透传给 codebuddy 子进程）。部署时可用 `node delivery/install-vm.mjs --bearer-env-name WINVM_BEARER_TOKEN` 让生成器写入**占位赋值行**（默认不写 ⇒ 产物逐字节旧形态；真值由运维替换，或部署会话先 `$env:` 设好、`--bearer-env-name` 会自动读取同名 env 写真值——值不进命令行）。
> 2. **配变量名（名）**：运行时配置 `agent.providers.workbuddy.options.bearerEnvName = "WINVM_BEARER_TOKEN"`（与 `security.tokenEnv` 同名 = 默认约定；`--bearer-env-name` 会一并写入生成配置）。`buildMcpConfig` 据此在 `mcpServers.winvm.headers` 产出 `Authorization: Bearer ${WINVM_BEARER_TOKEN}` **引用**（真机实证 codebuddy 会按子进程 env 展开）。
> 3. **开 enforce**：`security.enforceBearer = true`（双条件的另一半：服务进程 env 里 `WINVM_BEARER_TOKEN` 必须真有值，否则 `authMode=bearer-configured-missing` 半开态显形）。然后 kill-restart 重启服务，验收两件事：`/health.security.authMode = bearer-enforced` 且 `/health.security.innerReconnect = ok`（自环探针实证；`unverified` 表示探针未跑/未定，`broken` 表示带凭据回连被 401 —— 回头查第 1 步的 env 赋值）。
>
> 顺序铁律不变：**deploy → 补丁 → kill-restart**（`deploy-vm.mjs --apply` 会重新生成运行时配置与 ps1，手工补丁必须在部署之后）。

### 8.2 SSH 通道怎么认证：用密钥，不用密码

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

### 8.3 首次连接的主机密钥确认

脚本不会自动带 `-o StrictHostKeyChecking=…`。第一次 `ssh`/`scp` 到新远程机会提示 `Are you sure you want to continue connecting (yes/no)?`，无人值守时会卡住。提前处理：

```bash
# 手动接受一次主机密钥（写入 known_hosts）
ssh -o StrictHostKeyChecking=accept-new <VM_USER>@<VM_HOST> echo ok
```

或在宿主 `~/.ssh/config` 对应 Host 块加 `StrictHostKeyChecking accept-new`、`UserKnownHostsFile ~/\.ssh/known_hosts`。

### 8.4 端到端验证（远程目标）

```bash
# 1) 确认密钥能免密登远程 Windows
ssh <VM_USER>@<VM_HOST> "powershell -c 'Get-ComputerInfo -Property CsDNSHostName'"

# 2) 跑 setup 一键（VM_HOST 已是远程 IP）
node delivery/setup.mjs --apply

# 3) 确认隧道打通 + 远端 /health
curl -s http://127.0.0.1:18443/health      # 应返回 VM 侧健康态
```

### 8.5 能力边界（与本地 VM 一致）

- 54 个能力在**远程 Windows 本机**执行 PowerShell（ps-bridge 在远端 spawn PowerShell 5.1），操作的正是那台远程机——即"本地操作远程 Windows"。
- **GUI 自动化**仍依赖远程 Windows 有活跃交互会话/显示器；无头远程机可能跑不了 GUI 模块（与本地 VM 同源限制）。
- 仅支持 Windows 被控端（强依赖 PowerShell 5.1），远程 Linux 不可作此"VM"。
- 另注意：SSH 认证（host ↔ 远程 Windows）与 MCP/A2A 的 **bearer token**（connector ↔ vm-service）是两回事。隧道两端都是回环 ⇒ bearer **默认免校验**（`security.enforceBearer` 默认 `false`）；本系统不存在"非回环直连"这种受支持形态（非回环绑定即启动 `error`，见 §8.1），因此绝大多数部署**只需配 SSH 密钥**，`WINVM_BEARER_TOKEN` / `tokenEnv` 不必动。确要在 VM 侧开 `enforceBearer` 时，宿主侧凭 `--token-env` 给出**变量名**（见 §8.1 警告块两段式实况：宿主不带凭据段 ⇒ 当场 401；VM 内回连凭据通路未接线（P2-T6 已交付通路，默认未接线，三步见 §8.1）⇒ 回连 401 打在工具面、委派退化为**零副作用虚假完成**（`completed`+`zeroInnerCalls:true`，B3 真机实测，见 `SECURITY-GOVERNANCE.md` §2.1/D-43），**不得**以"任务显示成功"推断守卫未生效）。

### 8.6 远程分发产物里有什么、依赖怎么解析（关键）

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
