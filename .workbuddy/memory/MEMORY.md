# 项目长期记忆 · winvm-virtual-win-plugin

> 跨会话可复用的事实与约定。临时排查/单次结果勿入此文件。

> 🔴 **迁移交接（2026-09-10，跨机继续开发专用）**
> 本项目已生成完整迁移交接档案。**新机器上的 WorkBuddy 请先读 `.workbuddy/README.md`**
> （目录索引 + handover 总纲），再按 `.workbuddy/handover/07-migration-checklist.md` 逐项落地。
> 档案清单：`handover/01` 概览 · `02` 开发历史 · `03` 当前状态 · `04` 问题与方向 ·
> `05` 环境/工具/Skills · `06` **踩坑集（改码前必扫）** · `07` 新机落地清单。

## 项目定位
为**宿主机 WorkBuddy（AI Agent）**开发的插件，使其能完全操作一台 Windows 虚拟机（系统/应用/存储/GUI/应用生产操作 appops 五大能力域，共 54 个能力）。DDD + plan-first 双方法论驱动；npm workspaces 12 包，TypeScript strict ESM，`tsc -b` 构建，`node --test` 单测（214/214，逐文件运行）。

## 三选项 VM 内 AI Agent（经 `WINVM_VM_PROVIDER` 切换）
- `workbuddy-deterministic`：确定性执行器（`adapter-agent-workbuddy`），可替换基准实现。
- `workbuddy`：LLM 执行器（`adapter-agent-workbuddy-llm`），VM 内 spawn `codebuddy` CLI（`--goal/--system-prompt/--mcp/--output`，真机未验证）。
- `hermes-agent`：**Nous Research 的 Hermes Agent**（`adapter-agent-hermes`）。⚠️ **Hermes CLI 无 `--mcp` 参数**——MCP 必须预注册进 `config.yaml.mcp_servers`（url 类型 + `.env` 的 `MCP_WINVM_API_KEY` Bearer），靠 `mcp_startup.py` 自启加载。registrar 失败仅 warn 降级。

## 共享 Skills 部署范式（用户明确要求"独立于各候选 Agent"）
- 单一真源：仓库 `skills/`（6 个 Skill：orchestrator 总控 + 5 领域；每个含 `mcps-reference.md` 指导 MCP server 部署）。
- 共享根：**`C:/WinVMBridge/shared-skills`**（故意与仓库 `skills/` 分离，避免 VM 部署目录==仓库目录时 `cp` 自拷贝 `EINVAL`）。
- 各候选 Agent 仅经 **junction**（Windows 免管理员）引用共享根；`delivery/deploy-shared-skills.mjs` 两阶段（publish → link），幂等/可 dry-run。
- `skillsRoot` 默认值已统一为 `C:/WinVMBridge/shared-skills`。

## 双通道架构（非显然）
- 简单任务：宿主 Agent 直接经 MCP 调 VM `/mcp` 的 54 能力工具。
- 复杂任务：宿主 `host-a2a-bridge`（stdio MCP server，暴露 `a2a.delegate` 等）经 SSH 隧道调 VM `/a2a`（A2A v1.0，SSE + tasks/* + input-required 审批）。
- 同一条隧道承载 `/mcp` 与 `/a2a`；回环隧道免 bearer token（`tokenEnv` 仅对非回环强制）。

## VM 服务计划任务：隐藏窗口与 GUI 会话判定（易踩坑，第十一轮实证）
- **`<Hidden>true</Hidden>` 对 InteractiveToken 任务无效**：GUI 能力域要求服务跑在交互式会话（`<LogonType>InteractiveToken</LogonType>`，Session>=1，否则截图全黑 / SendInput 拒绝访问），而 Windows 对这类任务**忽略** XML 的 Hidden 设置 —— 直接以 `node.exe` 作为任务动作必然弹出**常驻控制台窗口**（用户可见、易误关，一关服务即停）。`schtasks /run` 重启走同一份任务定义，故重启后窗口会重现。
- **隐藏必须发生在进程创建层**：`buildTaskXml` 生成 `delivery/.generated/start-hidden.ps1`，任务动作改为 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<ps1>"`，脚本内 `Start-Process -WindowStyle Hidden -FilePath $nodeExe -ArgumentList $cliArgs -WorkingDirectory $workDir -Wait` 拉起 node。
  - 用 `-File` 而非 `-Command`：node 参数含带双引号的路径，`-Command` 需再嵌一层命令行引号（`/\"`）转义，极易出错；`-File` 只剩一层，参数原样写进 `.ps1`。
  - **`-Wait` 不可省**：否则 `Start-Process` 立即返回、任务动作即结束，node 可能被作业对象连带回收；加上后服务存活期间任务保持 Running，`schtasks /end` 仍可终止、崩溃仍触发 RestartOnFailure，原语义不变。
- **「在交互式会话启动」≠「GUI 一定可用」**：`psmod/gui.ps1` 的 `Get-SessionHealth` 还要求**未锁屏**（`LogonUI` 未运行）且 **Explorer 在跑**，否则 `state=degraded`（detail「会话降级（锁屏或 Explorer 未运行）」）。锁屏状态下重启服务仍会 degraded —— 先解锁 / 登录桌面、确认 Explorer 已启动，再重启。该判定刻意保留，**勿放宽**。

## 单测运行约定（沙箱硬约束，非显然）
- **绝对不要**整批跑 `node --test tests/unit/*.test.js`——`link-workspace.test.js` 里 `symlink(...,'junction')` 在本沙箱触发 Node 进程访问违例（`exitCode 2147483651`/`0xC0000005`），会**打崩共享 runner**，连带同进程所有文件被判死且无汇总计数，呈现「整批假全红」的假象（实则一行代码都没坏）。
- **正确做法**：每个文件单独起一个 `node --test <file>` 进程（for 循环逐个跑），再汇总 `# pass`。单跑 `link-workspace` 16/16 完全正常。
- 当前真实基线：**214/214 全绿**（16 文件逐文件跑；含 `path-util.test.js` 9 项、`winvm-plugin.test.js` 7 项、`deploy-conn-side.test.js` 3 项）。改动后复核须沿用此法，否则极易误判回归。

## PowerShell 字符串转义坑（可复用，第十二轮实证）
- **PowerShell 双引号字符串里反斜杠不是转义符**（`"` 内的 `\\` 是字面双反斜杠；转义符是反引号 `` ` ``）。把含反斜杠的路径用 `JSON.stringify` 拼进 `powershell -Command "..."` 会**翻倍反斜杠**（`C:\foo` → `C:\\foo`），写进注册表/文件后路径带 `\\`，回读 `includes`/匹配全失败。
- **正确做法**：用 **单引号字符串**嵌入路径（`'` 用 `''` 转义内部单引号），反斜杠保持字面量。例：`setUserPathRaw` 用 `[Environment]::SetEnvironmentVariable("Path", 'C:\dir', "User")` 而非 JSON.stringify。
- 该坑曾伪装成「沙箱注册表隔离」（写成功但跨进程读不到），排查时先怀疑转义而非环境隔离。

## 本机 User PATH 历史损坏 + conda AutoRun 噪声（第十三轮实证）
- **现象**：在 PowerShell 跑 `winvm-plugin` / `node` 等经 `cmd /c` 启动的命令时，刷 `'DOSKEY' is not recognized` + `'node' is not recognized`。
- **DOSKEY 来源**：HKCU `cmd` AutoRun = `conda_hook.bat`（anaconda 安装写入），其第 17 行 `@DOSKEY conda=...` 在每次 `cmd /c` 时执行，子进程 doskey.exe 解析不到即报错（与本项目无关，但污染输出）。
- **node 来源**：本机 **User 级 PATH 被某工具以 JSON 风格转义写入，每条目带双反斜杠（`\\`）**，node 条目 `d:\nvm4w\nodejs` 也在损坏之列，`cmd /c` 子进程定位失败。这是 kmaster/hermes/anaconda 等历史残留，**非本项目 Q2 的 PATH 写入造成**（Q2 写入的缓存条目是干净的）。
- **修复范式（已落地 `winvm-plugin.cmd`）**：① 启动器自重载 `cmd /d /c "%~f0" %*` 跳过 AutoRun 消除 DOSKEY 噪声；② 显式定位 node（先查 `d:\nvm4w\nodejs\node.exe`/`C:\Program Files\nodejs\node.exe`，再 `for %%i in (node.exe) do %%~$PATH:i` 回退，最后兜底裸 `node`），不依赖 PATH 恰好含 node。
- **清理本机 PATH 的脚本**：`.workbuddy/clean_user_path.ps1`（从 `tmp_path_raw_backup.txt` 备份重跑；正则 `'\\{2,}'`→`'\'` 折叠连续多反斜杠、剔除 `__path_test__`、去重）。⚠️ 本机曾出现**连续 4 个反斜杠**（`\\\\`），单 `\\`→`\` 只修一半，必须用 `\\{2,}` 一次折叠到底。原始值备份在 `.workbuddy/tmp_path_raw_backup.txt` 可回滚。

## 部署期持久化标记（第十四轮实证，可复用范式）
- **VM 内 `winvm-plugin` 不可达**：VM 部署（`install-vm.mjs`）只把启动器落盘到 `<repoRoot>/delivery/`，**必须** `addToUserPath` 把该目录加入 VM 用户 PATH，VM 内才能 `winvm-plugin <cmd>`。宿主侧同理（Q2 已做，缓存根）。
- **VM 内 health 误走 host 分支**：`detectSide()` 最高优先级读 `~/.workbuddy/winvm/side.json`（VM 部署写 `{"side":"vm"}`）→ health 走本地 `127.0.0.1:/health`，无需 vm-host/vm-user。
- **宿主侧 health 每次要 --vm-host/--vm-user**：`install-host.mjs` 安装时把 VM 连接写入 `~/.workbuddy/winvm/vm-conn.json`，`winvm-plugin.mjs` 的 `resolveVmConn` 把它当兜底来源（优先级 argv > env WINVM_VM_* > .env VM_* > vm-conn.json > 默认）；`setup.mjs` HOST 步骤需透传 `--vm-host/--vm-user/--vm-ssh-port/--vm-port`。
- 文件型标记（side.json / vm-conn.json）抽成导出函数（接受 `home` 参数），便于单测注入临时 home。

## 真机未验证项（V1 遗留，需真实 Windows VM）
- 真实 VM `--self-test`、真实 SSH 隧道端到端、真实 `codebuddy` CLI flag 兼容、`hermes` 真机 CLI 拉起 + MCP 自动加载。
