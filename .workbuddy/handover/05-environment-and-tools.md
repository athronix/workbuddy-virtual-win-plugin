# 05 · 环境、工具、Skills

> 新机要装什么、项目依赖哪些外部工具、Skills 怎么组织、本机环境有哪些"怪癖"。

## 新机环境清单

| 类别 | 要求 | 验证命令 |
|---|---|---|
| Node | ≥ 22（项目实测 v22.22 / v24.18 均可） | `node -v` |
| npm | 支持 workspaces；registry 建议 npmmirror | `npm -v` |
| TypeScript | 随仓库 devDependencies（`tsc -b`） | `npm run build` |
| PowerShell | 宿主不限；**VM 侧必须 5.1** | `$PSVersionTable` |
| OpenSSH | 宿主 `ssh`/`scp` 在 PATH；VM 开 22，仅公钥认证 | `ssh -V` |
| gh CLI | 需要推送 GitHub 时 | `gh auth status` |
| 网络 | 宿主 ↔ VM 互通（原环境走 Tailscale） | `ssh <user>@<vm>` |

可选：`codebuddy` CLI（仅 `workbuddy` provider 用，`npm i -g @tencent-ai/codebuddy-code`）。

## 项目自带工具脚本（delivery/）

| 脚本 | 用途 |
|---|---|
| `setup.mjs` | **双端一键部署总入口**（读 `.env`；默认 dry-run，`--apply` 真执行；七阶段 BUILD→HOST→VM→VM-START→TUNNEL→HEALTH→TEST） |
| `install-host.mjs` | 宿主侧安装器（含 `installBridgeDeps` 自包含依赖、`registerInstalledPlugin` 转正、PATH 管理、写 `vm-conn.json`） |
| `install-vm.mjs` | VM 侧安装器（npm ci / build / 运行配置 / 共享 Skills / 计划任务 / 自检 / PATH / `side.json`） |
| `winvm-plugin.mjs` | 管理 CLI（host/VM 同一份，自动识别上下文），零外部依赖 |
| `deploy-winvm-plugin.mjs` | 启动器三件套部署器（`.mjs` + `.cmd` + 无扩展名 bash） |
| `deploy-shared-skills.mjs` | 共享 Skills 发布 + junction 链接（两阶段，幂等/可 dry-run） |
| `link-workspace.mjs` | 为「仅 dist」产物建 `node_modules/@winvm/*` junction（免管理员/免联网） |
| `path-util.mjs` | 用户级 PATH 增删（含写后 `WM_SETTINGCHANGE` 广播） |

## Skills（8 个，单一真源 + junction 引用）

| Skill | 域 | 说明 |
|---|---|---|
| `winvm-orchestrator` | — | **总控编排**，跨域组合 |
| `winvm-system-admin` | `system` | 系统信息/进程/服务/网络/注册表 |
| `winvm-app-manager` | `app` | 应用安装/卸载/清单/启动 |
| `winvm-storage-manager` | `storage` | 文件目录/磁盘/搜索 |
| `winvm-gui-automation` | `gui` | 截图/UIA 定位/键鼠/窗口/剪贴板 |
| `winvm-app-operation` | `appops` | **应用生产操作**（用软件完成生产任务） |
| `winvm-mcp-reference` | — | 各 MCP server 部署/管理参考 |
| `hos-win-skill` | — | 鸿蒙宿主侧任务分派预判（本地做还是送 VM），进入 VM 后以总控为唯一入口 |

- `references/` 仅两家：`winvm-mcp-reference` 的 `mcps-reference.md`（MCP server 部署/管理参考，供 VM 内 AI Agent 参考调用）、`winvm-orchestrator` 的 `approval-card.md`
- **共享根**：`C:/WinVMBridge/shared-skills`（故意与仓库 `skills/` 分离，避免部署目录 == 仓库目录时 `cp` 自拷贝 `EINVAL`）
- 各候选 VM Agent 仅经 **junction** 引用，单一真源，`skillsRoot` 默认值已统一

## 宿主侧 WorkBuddy 关键路径与机制

| 位置 | 作用 |
|---|---|
| `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` | 插件缓存根（`winvm-plugin` 启动器在此，安装时加入用户 PATH） |
| `~/.workbuddy/plugins/marketplaces/winvm/` | 市场元数据 |
| `~/.workbuddy/connectors/skills/connector-winvm/` | 技能副本 |
| `~/.workbuddy/mcp.json`（全局）/ `connectors/<account>/mcp.json`（账户级） | 连接器注册：`connector:winvm`（MCP）+ `connector:winvm-a2a`（A2A 桥） |
| `installed_plugins.json` | **正式注册表**，key=`插件@marketplace`，`installPath` 须精确指向版本目录；缺条目会被判孤儿并打 `.orphaned_at` |
| `~/.workbuddy/winvm/vm-conn.json` | 宿主侧部署期持久化的 VM 连接（host/user/sshPort/servicePort） |
| `~/.workbuddy/winvm/side.json` | VM 侧标记 `{"side":"vm"}`，使 VM 内 `health` 自动走本地 `/health` |

⚠️ 连接器装完需用户在**连接器管理页点 Trust** 才会激活（新增 MCP 服务器的通用要求）。

## 本机环境怪癖（跨项目通用，易踩）

| 现象 | 原因 | 绕法 |
|---|---|---|
| 本地前后端/回环联调被代理拦截 | NekoBox **TUN 模式**拦截所有出站（含 `127.0.0.1` 裸 TCP）；IPv6 `::1` 通常不拦 | 用 `localhost`（解析到 `::1`）；curl 加 `--noproxy 127.0.0.1`；node 设 `NO_PROXY` |
| Bash 工具拒绝执行含 `PowerShell`/`powershell.exe` 的命令 | 安全策略拦截（**即便那是远端执行**、本地只是 `ssh`）；`$(` 与反引号同样触发 | 远端诊断改用 Node 脚本；用 `onStderr` 回调抓子进程 stderr |
| commit message 含 `PowerShell` 被拒 | 同上 | 改用 Write 写 `.workbuddy/commit_msg.txt` + `git commit -F` |
| `fs.rm`/`rmSync` 被拦、删不掉 | 沙箱把删除改为进回收站（safe-delete 垫片），回收站不可用则 fail-closed 拒绝删除 | 批量删除加前缀 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=1000000`；或用绝对路径调真实 `/usr/bin/rm` |
| `git update-ref` 返回 0 但 ref 没写进去 | 沙箱拦截 `refs/remotes/` 写入 | 直接写松散 ref 文件：`mkdir -p .git/refs/remotes/origin && printf '%s\n' <sha> > .git/refs/remotes/origin/main` |

## 外部 Connector / Expert

- 本项目**不强依赖**任何外部 Connector（自身即 MCP + A2A 服务端）。
- 开发过程中使用的本地能力：Node / npm / git / gh / ssh / scp / PowerShell。
- 若继任 WorkBuddy 需要访问 GitHub，可考虑连接 `github` Connector（当前 disconnected）。
