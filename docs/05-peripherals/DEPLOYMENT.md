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
              └─ workbuddy             → adapter-agent-workbuddy-llm（LLM Agent，V1 已实现）
              └─ vm-capabilities（ps-bridge 常驻进程 + 五大 PowerShell 模块）
```

---

## 1. 双端一键部署（setup.mjs，推荐）

`delivery/setup.mjs` 读取项目根目录 `.env`，**一条命令完成「宿主机侧 + VM 侧」的安装、部署、隧道与自检**，生成 BUILD → HOST → VM → TUNNEL → TEST 五阶段计划。

> ⚠️ **安全默认**：不加 `--apply` 即 `--dry-run`，只打印计划、**不改动任何系统**。需要真正执行时再加 `--apply`。

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
| `WINVM_SETUP_TUNNEL` | 是否建立 SSH 本地转发 | `1` |
| `WINVM_DRY_RUN` | `1`=只规划；传 `--apply` 才真执行 | `1` |

### 1.2 VM 侧 AI Agent 选型（agent.provider）

通过 `WINVM_VM_PROVIDER` 即可切换 VM 内承接任务的 AI Agent，**桥接层 / MCP / A2A / Skills 全部零改动**：

| 取值 | 包 | 能力 |
|------|----|------|
| `workbuddy-deterministic` | `@winvm/adapter-agent-workbuddy` | 确定性执行器（可预测、易监管，默认） |
| `workbuddy` | `@winvm/adapter-agent-workbuddy-llm` | LLM Agent（VM 内 `codebuddy` CLI 承接开放/创意任务，V1 已实现） |

`setup.mjs` 会把该选型透传给 `install-vm.mjs --provider <id> --cli <exe>`，生成的运行配置即 `agent.provider=<id>`；`vm-service` 启动时据此动态加载对应 provider 包。详见 `docs/02-design/LLM-PROVIDER.md` 与 `SPEC-AGENT-SERVICE-BRIDGE.md §6.1`。

### 1.3 TEST 阶段自检

`--apply` 末尾的 TEST 阶段会执行：`vm-service --self-test`（含 provider 能力目录校验）+ 经隧道 `curl /health`。self-test 现在会打印并校验所选 provider 的 `id / kind / 声明能力目录`，可作为「provider 是否生效」的冒烟验证。

> 若 `VM_HOST` 留空，`setup.mjs` 不会自动 ssh，而是打印本地手动部署指引（`install-vm.mjs --dry-run --provider …`），你可在 VM 内手动跑。

---

## 2. 前置条件

| 角色 | 要求 |
|------|------|
| 宿主机 | 已安装 WorkBuddy；Node.js ≥ 18；能 SSH 到虚拟机（密钥或密码）；可读取 `~/.workbuddy` 配置目录 |
| 虚拟机 | Windows 10/11 或 Server 2016+；PowerShell 5.1+（代码已兼容 5.1，无需 PS7）；网络可达宿主机 SSH 端口；防火墙放行 18443 仅 `127.0.0.1` |

> ⚠️ **安全红线**：VM 侧 `vm-service` **只允许监听 `127.0.0.1`**。任何将 `0.0.0.0` 暴露到公网的配置都属高危，违反 SECURITY-GOVERNANCE 规范。

---

## 3. 虚拟机侧（被控端）部署

### 3.1 一键部署（推荐）

```powershell
# 先 dry-run 确认将执行的步骤，不写盘
node delivery/install-vm.mjs --dry-run

# 确认无误后正式部署（npm ci + build + 生成配置 + 注册任务计划程序自启 + 自检）
node delivery/install-vm.mjs

# 指定 VM 侧 AI Agent 选型（agent.provider）：确定性 / LLM
#   等价写法还支持环境变量 WINVM_VM_PROVIDER / WINVM_WORKBUDDY_CLI
node delivery/install-vm.mjs --provider workbuddy --cli codebuddy
node delivery/install-vm.mjs --provider workbuddy-deterministic

# 仅自检（验证 ps-bridge 五大模块、服务配置、provider 能力目录）
node delivery/install-vm.mjs --self-test

# 卸载（停服务 + 移除自启任务 + 清理生成物，保留源码）
node delivery/install-vm.mjs --uninstall
```

安装器会：
1. `npm ci`（按 lockfile 精确还原依赖，保证可复现）
2. `npm run build` 编译所有 packages 到 `dist/`
3. 基于 `delivery/vm-service.config.json` 生成运行配置（强制 `host=127.0.0.1`），并写入 `agent.provider`（来自 `--provider` / `WINVM_VM_PROVIDER` / 配置默认）
4. 注册 **Windows 任务计划程序** 任务（`WinVMBridge.Service`），登录即启、崩溃重启、仅在交互式会话运行（**不注册为 Windows 服务**，避免 Session 0 黑屏）
5. 运行自检：ps-bridge 五大模块可加载、配置校验通过、端口回环绑定、provider 能力目录可解析

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
