# WinVM Bridge · 鸿蒙宿主安装 / 运行 / 测试指南（本机拓扑版）

> 适用环境：**宿主 = 鸿蒙 HMOS WorkBuddy**（本机），**VM = Windows 11**（IP `172.16.100.2`）。
> 本文是把「安装 / 运行 / 测试」流程落盘的单一事实源，命令均按本机拓扑给出。
> 相关文档：`docs/oh-host-selfcheck.md`（真机可行性门禁）、`docs/oh-host-adaptation-delivery.md`（宿主适配交付）、`DEPLOYMENT.md`（通用部署）。

---

## 0. 你的拓扑与关键事实

| 角色 | 系统 | 地址 / 路径 | 说明 |
|---|---|---|---|
| 宿主（本机） | 鸿蒙 HMOS WorkBuddy（Electron 移植版，arm64） | `~/.workbuddy` | 自带 node **v24.13.0**；**TUNNEL 相位**走进程内 **ssh2**（`WINVM_TUNNEL_BACKEND=ssh2` 或 `process.platform==='ohos'` 自动启用）；**VM 分发 / 启动 / health 相位** spawn 系统 `ssh`/`scp`/`tar`/`curl`（实测 HMOS 沙箱 `/usr/bin/ssh`·`/usr/bin/scp`·`/bin/tar`·`/usr/bin/curl` 均存在可跑） |
| VM | Windows 11（裸 WorkBuddy v5.5.3） | `172.16.100.2`，SSH `User@172.16.100.2:22`（公钥认证） | **已部署**（2026-09-16 真机一键部署成功）：node v24.21.0 / npm 11.19.0 / codebuddy 2.149.0；VM 默认 ssh shell 为 CLANGARM64 **bash**（非 cmd） |
| 服务 | VM 内 `vm-service` | 仅监听 `127.0.0.1:18443` | 零对外暴露；所有访问经 SSH 隧道 |
| 隧道 | 宿主 ↔ VM | `127.0.0.1:18443 → 172.16.100.2:127.0.0.1:18443` | 回环双向 pipe（direct-tcpip），仅绑 `127.0.0.1` |

---

## 0.5 执行环境模型说明（安装 / 部署代码跑在哪）

> 你曾问「安装代码是否在 hish-bridge / HiShell 终端里执行？」——答案：**不是**。本节把"安装脚本的执行环境"讲清楚，避免后续改码时搞错责任边界。

### 0.5.1 安装脚本 ≠ hish-bridge

- 所有安装 / 部署逻辑都是一组 **Node `.mjs` 脚本**（`delivery/setup.mjs` 编排，`install-host.mjs` / `install-vm.mjs` / `oh-tunnel.mjs` 等），由**宿主 WorkBuddy 自带的 Node**（`process.execPath`，本机沙箱内为 v24.13.0）直接 `spawn` 子进程执行——属于"插件内部逻辑"。
- **hish-bridge / HiShell 终端**是 WorkBuddy 用来**绕沙箱跑宿主机 OS 命令**的通道（真实 shell / node / python）。安装脚本不需要它，二者职责无关。（grep `hish|hishell|hishctl` 在安装脚本里零命中，可佐证。）
- 含义：改安装脚本时，按"Node 程序"的规矩来（路径、引号、子进程），不要假设它继承了 hish-bridge 的 shell 环境。

### 0.5.2 各部署相位的执行载体

| 相位 | 执行载体 | 依赖 |
|---|---|---|
| BUILD（`npm run build` / `tsc -b`） | 宿主 WorkBuddy 自带 node 内跑 JS | 仅需 node + 联网 `npm i` |
| HOST（`install-host.mjs`） | 宿主 node 内写盘 / 注册 connector | 仅 node |
| VM 分发（`scp` 传包 + 远端 `tar -xzf`） | **spawn 系统 `ssh` / `scp` / `tar`** | HMOS 沙箱实测均有 |
| VM-START（远端 `schtasks` / PowerShell） | **spawn 系统 `ssh`** 调远端 PowerShell | 系统 `ssh` |
| TUNNEL（本地 18443 ↔ VM 18443 转发） | **进程内纯 JS ssh2**（`oh-tunnel.mjs`） | 不依赖系统 `ssh` |
| TEST（宿主 `selfTest`） | 宿主 node 内跑（非 win32 跳过 ps-bridge） | 仅 node |
| HEALTH（探 `/health`） | 可 host node 内 `fetch`，或 **`curl`** | 系统 `curl` 或 node fetch |

要点：除 TUNNEL 走内置 ssh2，**其余涉及"触及 VM"的相位都 spawn 系统 `ssh`/`scp`/`tar`/`curl`**——而这些命令在 HMOS 沙箱里确实存在（推翻了早期"OH 无系统 ssh"的担忧）。

### 0.5.3 远端命令的 shell 陷阱（已踩坑，写入 §4）

- VM 默认 ssh shell 是 **CLANGARM64 bash**（非 cmd）：cmd 专用命令（如 `del`）不识别 → VM 分发改用 `node -e fs.rmSync`。
- 经 `ssh` 调远端 PowerShell 时，PowerShell 变量 `$p` / `$(...)` 会被**远端 bash 当变量 / 命令替换展开**炸语法 → 远端 PS 脚本须用**单引号**包住（见 §4 VM-START）。

### 0.5.4 安全默认

- `setup.mjs` **无 `--apply` 即 dry-run**：只打印计划，不写盘、不连 VM、不起隧道。
- 唯一真实执行入口是 `--apply`；`WINVM_DRY_RUN=1` 是硬门禁（即便带 `--apply` 也强制 dry-run）。

---

## 1. 依赖预检门禁（安装前的硬门槛 ⚠️）

> 这是你明确要求的点：**依赖不满足时，安装脚本必须中止，要求用户先补齐依赖**。
> 实现：`delivery/preflight.mjs`（零外部依赖，不 import 任何 `@winvm/*`，可在未构建 / 离线沙箱下加载与单测）。

### 1.1 宿主侧（由 `install-host.mjs` 在写盘 / 构建前检查）

| 检查项 | 是否阻断 | 不满足的处置 |
|---|---|---|
| 宿主已部署 WorkBuddy（`~/.workbuddy` 目录存在） | 🔴 阻断 | 在本机（鸿蒙）安装并初始化 WorkBuddy，确保 `~/.workbuddy` 存在 |
| Node.js ≥ 18（强烈建议 ≥ 22） | 🔴 阻断 | 安装 Node ≥ 18；HMOS 宿主通常沿用 WorkBuddy 自带 node v24，一般已满足 |

宿主侧任一阻断项不满足 → 脚本打印 `[缺失(阻断)]` + 处置行，并 `process.exit(1)`。

### 1.2 VM 侧（由 `install-vm.mjs` 在 **VM 内部** 本地检查，不走 SSH）

> 因为 `install-vm.mjs` 本身就在 VM 内运行，所以 node / npm / Agent CLI 直接靠 shell 解析 PATH 本地探测。

| 检查项 | 是否阻断 | 说明 |
|---|---|---|
| VM 内 Node.js ≥ 18 | 🔴 阻断 | VM 内未装 node 则部署无法继续 |
| VM 内 npm | 🔴 阻断 | 随 Node 一并安装 |
| VM AI Agent CLI（默认 `codebuddy`） | ⚠️ **取决于 provider** | `provider=workbuddy` / `hermes-agent` → 🔴 阻断（运行时要 spawn 该 CLI）；`workbuddy-deterministic`（默认）→ 仅 `[警告]`，因为确定性执行器运行时不 spawn 任何 CLI |

### 1.3 最小依赖补齐清单（按本机拓扑）

- **宿主（鸿蒙）**：
  - 安装并初始化 **WorkBuddy**（确保 `~/.workbuddy` 存在）。
  - 确认 node ≥ 18：`node -v`（HMOS 宿主 WorkBuddy 自带 v24，通常已满足）。
- **VM（Windows，进 VM 内操作）**：
  - 安装 **Node.js ≥ 18**（含 npm，加入 PATH）。
  - 若用 LLM provider：安装 **codebuddy** CLI（WorkBuddy CLI）并加入 PATH；或把 `WINVM_VM_PROVIDER` 保持为 `workbuddy-deterministic`（无需 codebuddy）。

### 1.4 预检的开关与边界

- 两脚本均加 `--no-preflight`（仅调试用，正常情况下不要加）。
- `--uninstall` **不触发**预检（卸载不需要依赖齐全）。
- 预检在真正写盘 / `npm ci` / `node` 调用之前执行，因此能在"依赖缺失"时干净地中止，而不是中途崩。

---

## 2. 准备配置

```bash
# 进入仓库根
cd <repoRoot>          # 即本项目根目录

# 复制模板为 .env 并填写（.env 含连接信息，已 gitignore，勿入库）
cp .env.example .env
```

`.env` 关键字段（按本机拓扑填）：

```ini
WINVM_SERVICE_PORT=18443

HOST_DEPLOY=1
VM_DEPLOY=1

# VM 连接（已公钥认证，.env 无密码字段）
VM_HOST=172.16.100.2
VM_SSH_PORT=22
VM_USER=User
VM_DEPLOY_DIR=C:/WinVMBridge

# VM 内 AI Agent：默认确定性执行器（无需 codebuddy）
WINVM_VM_PROVIDER=workbuddy-deterministic
WINVM_WORKBUDDY_CLI=codebuddy

# 隧道（OH 宿主自动用进程内 ssh2，无需系统 ssh）
WINVM_SETUP_TUNNEL=1
WINVM_TUNNEL_LOCAL_PORT=18443
WINVM_TUNNEL_REMOTE_PORT=18443

# 安全默认：WINVM_DRY_RUN=1 是兜底保险，即便传 --apply 也强制 dry-run
WINVM_DRY_RUN=1
```

> SSH 公钥：把宿主 `~/.ssh/id_ed25519.pub` 内容追加进 VM 的 `%USERPROFILE%\.ssh\authorized_keys` 并修 ACL（见 `DEPLOYMENT.md §7` / `SECURITY-GOVERNANCE §6`）。

---

## 3. 安装（一键 + 安全默认）

### 3.1 先 dry-run 预览（不改动任何系统）

```bash
node delivery/setup.mjs
```

- 不传 `--apply` ⇒ 只打印计划（BUILD → HOST → VM → VM-START → TUNNEL → TEST → HEALTH），不执行。
- `WINVM_DRY_RUN=1` 是兜底：即便误传 `--apply` 也强制 dry-run。

### 3.2 真正执行

```bash
node delivery/setup.mjs --apply
```

执行顺序（`setup.mjs` 编排）：

1. **BUILD** — `npm run build`（构建全部包）。
2. **HOST** — `install-host.mjs`（写连接器 `connector:winvm` + `connector:winvm-a2a`、注册插件、写 `vm-conn.json`、把插件缓存根加入 PATH）。**此处先触发 §1.1 宿主预检**。
3. **VM** — 打包 `delivery + skills + 各包运行时资产`（不含 node_modules）→ `scp` 到 VM → 在 VM 内运行 `install-vm.mjs --skip-install --skip-build`。**此处先触发 §1.2 VM 预检**（VM 内本地探测 node/npm/CLI）。
4. **VM-START** — 干净重启服务（`schtasks /end` → 强杀残留端口 → `schtasks /run`），轮询 `127.0.0.1:18443` 监听 ≤ 60s。
5. **TUNNEL** — 宿主侧建 SSH 本地转发（OH 自动走进程内 ssh2 隧道，随部署进程生命周期，HEALTH 后自动关闭）。
6. **TEST** — 宿主机自检 `node packages/vm-service/dist/cli.js --self-test`。
7. **HEALTH** — 经隧道 `curl http://127.0.0.1:18443/health`（重试 3 次）。

> 若任一预检未过，对应安装步骤会在 HOST / VM 阶段直接 `exit 1`，并打印 remedy 指引；此时请回到 §1.3 补齐依赖后重试，不要绕过 `--no-preflight`。

---

## 4. 运行 / 健康检查

```bash
# 健康检查（宿主侧，需隧道已建立；--noproxy 绕开本机代理对回环的拦截）
curl -s --noproxy 127.0.0.1 --max-time 15 http://127.0.0.1:18443/health
```

> **VM 本机核验陷阱（⚠️ 必看）**：若直接在 VM 桌面的 PowerShell 跑，注意两点：
> 1. Windows 的 `curl` 是 `Invoke-WebRequest` 的**别名**（非真 curl），会逼你要 `-Uri` 参数。必须用 `curl.exe`（带 `.exe` 绕过别名）或 `Invoke-RestMethod http://127.0.0.1:18443/health`。
> 2. **不要** `curl | node -e "…"` 管道解析 JSON——Windows 控制台会把 JSON 里的 UTF-8 中文（`detail` 字段）转成 `?` 导致 `JSON.parse` 报 `Expected ',' or '}'`。改用 node 直接发请求（UTF-8 安全）：
>    ```powershell
>    node -e "fetch('http://127.0.0.1:18443/health').then(r=>r.json()).then(j=>console.log('interactive=',j.session.interactive,'state=',j.session.state)).catch(e=>console.log('ERR',e.message))"
>    ```

返回 JSON 含 `exposed=54`（全部能力）。注意 `session.interactive`：

- `true` → 全部能力（含 GUI 域）可用。
- `false`（降级）→ MCP/A2A 与 54 项能力正常，**仅 gui.*（截图 / 键鼠 / UIA / 窗口 / 剪贴板）被门禁**。
  - **⚠ 真根因（2026-09-17 实测订正）**：不是「会话没进入交互桌面」，而是 `Get-SessionHealth`（`packages/vm-capabilities/psmod/gui.ps1`）的判定本身有 bug——
    它用 `GetUserObjectInformationW(UOI_NAME)` 把窗口站名读进 `StringBuilder` 再和字面量 `'WinSta0'` 比较，但**该函数在本机实测读出 `"W"`（应为 `"WinSta0"`，P/Invoke 封送假值）**，
    导致 `$ws -eq 'WinSta0'` 恒成立 `false` → `interactive` 恒 `false` → GUI 被门禁，**即便进程确在交互会话（session≥1、Explorer 在跑、未锁屏）也如此**。
    **所以 RDP 登录 + `schtasks` 重启永远救不活 GUI**——重启只是重新生成「读出 W 的 node」，判定照样 false。这是假阴性，不是真降级。
  - **修复（改判定逻辑，非重启）**：把 `gui.ps1` 里靠不住的字符串比较换成**实测**——用 `OpenWindowStationW('WinSta0')` 看当前进程能否真正打开交互窗口站（仅交互会话内进程可成功，session 0 服务返回 NULL）。
    - 已修复源文件：见 `packages/vm-capabilities/psmod/gui.ps1`（`OpenWindowStationW` 探测替代 `GetUserObjectInformationW` 字符串比较，并顺手修掉桌面读取 `n=7` 非法索引 → `desktop` 永远 `"unknown"` 的副 bug）。
    - 落地方式二选一：① 宿主侧重跑 `node delivery/setup.mjs --apply`（重推 `packages/` 树 + 重新 junction 链接 + 重启服务，会把修复后的 `gui.ps1` 带上 VM）；② 或直接在 VM 上给已部署的 `C:/WinVMBridge/packages/vm-capabilities/psmod/gui.ps1` 打等价补丁（用 node 脚本做确定性字符串替换，规避 PowerShell 转义），再重启服务。
  - **重启服务的端口陷阱（仍有效）**：`start-hidden.ps1` 用 `Start-Process -WindowStyle Hidden` 拉起的 node 是脱离 powershell 父进程的孤儿，`schtasks /end` 只杀壳、node 仍占 18443；
    清理时必须用 `-ExpandProperty` 取出 PID 整数再 `Stop-Process`（`Stop-Process -Id $pids` 传对象会静默失败、杀不掉）。
    重跑 §4 健康检查（VM 本机用 `curl.exe` 或 `node -e fetch` 写法），修复后应见 `session.interactive=true`、`windowStation=WinSta0`。

---

## 5. 测试

### 5.1 宿主机自检（能力注册表 / ps-bridge / provider 能力目录）

> 需先 `npm run build` 才有 `dist/cli.js`。

```bash
node packages/vm-service/dist/cli.js --self-test
```

### 5.2 单元测试（⚠️ 必须逐文件跑）

```bash
# 1) 先构建（联网机 / 可构建环境）
npm i && npm run build

# 2) 逐文件跑单测（严禁整批 *.test.js —— 见下方说明）
for f in tests/unit/*.test.js tests/unit/*.test.mjs; do
  node --test "$f" || echo "FAIL: $f"
done
```

> **铁律**：**绝不要** `node --test tests/unit/*.test.js`。`link-workspace.test.js` 的 `symlink(...,'junction')` 会触发 Node 进程访问违例（`0xC0000005`），**打崩共享 runner** → 整批假全红（代码其实没坏）。单跑一切正常。
>
> **离线沙箱提示**：本仓库离线环境无 `node_modules` / `dist` → 含 `@winvm/*` import 的 9 个测试文件必 `ERR_MODULE_NOT_FOUND`（**预存限制，非 bug**）；`214/214` 基线需在可构建环境复核。
> 其中 `tests/unit/preflight.test.mjs`（8 项）**零依赖、可离线跑**：覆盖预检解析、宿主 / VM 阻断判定、警告非阻断等。

### 5.3 端到端（待真机复核）

- 真实 VM `--self-test`、真实 SSH 隧道端到端、codebuddy / hermes CLI 拉起。
- HMOS 宿主 `install-host --apply` 全流程、沙箱白名单生效、端到端 A4/A5/A2。

---

## 6. 卸载（双端一键，安全）

```bash
node delivery/setup.mjs --uninstall          # 预览：打印宿主+VM 待移除项，不删除
node delivery/setup.mjs --uninstall --apply  # 执行：仅移除本项目部分，删除物入回收站（可恢复）
```

- 卸载**不触发依赖预检**。
- 宿主角落 `installed_plugins.json` / `mcp.json` 改动前已备份 `*.winvm-bak.<时间戳>`；VM 侧删除物默认落到 VM 内 `.uninstall-trash/<时间戳>/`（RDP 进 VM 可找回）。

---

## 7. 真机遗留 / 待复核清单

1. **HMOS 沙箱约束**（决定性）：沙箱是否放行出站 TCP / 长驻进程 / 本地监听 —— 见 `docs/oh-host-selfcheck.md §5` 三命令验证；FAIL 属 OS 权限，非改插件可绕。
2. **联网构建复核**：在可联网真机 `npm i && npm run build` 后，**逐文件**复跑全量 `tests/unit`（基线 214/214）+ `tsc` 类型检查。
3. **端到端冒烟**：MCP vs A2A 七槽位等价性、`codebuddy` CLI flag 兼容、`hermes` CLI 拉起 + MCP 自动加载。

---

## 8. 故障排查速查

| 现象 | 原因 / 处置 |
|---|---|
| 安装时 `宿主环境依赖不满足 … exit 1` | §1.1 宿主预检未过 → 按 remedy 装 WorkBuddy / node 后重试（勿用 `--no-preflight` 绕过） |
| VM 部署 `VM 环境依赖不满足 … exit 1` | §1.2 VM 预检未过 → 进 VM 装 node/npm；用 LLM provider 还需 codebuddy，或改 `workbuddy-deterministic` |
| `install-host` 离线报 `ERR_MODULE_NOT_FOUND: @winvm/host-sdk` | 沙箱预存限制（未构建），非 bug；在可构建环境 `npm i && npm run build` 后复跑 |
| 隧道不通 / `/health` 失败 | 确认公钥已注入 VM、OH 走 ssh2 后端（`process.platform==='ohos'` 自动）；`curl` 加 `--noproxy 127.0.0.1` |
| `/health` 显示 `session.interactive=false` | GUI 降级，按 §4 在 VM 交互式 PowerShell 执行重启命令块 |
| 单测整批假全红 | 误用了 `*.test.js` 整批；改逐文件 `node --test <file>` |

---

> 维护说明：本文与 `delivery/preflight.mjs`、`install-host.mjs`、`install-vm.mjs`、`setup.mjs`、`.env.example` 同步；若脚本门禁行为变更，本文 §1 / §3 同步更新。
