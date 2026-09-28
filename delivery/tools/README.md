# delivery/tools/ —— VM 侧运维工具箱

> 收编自项目 `qa/probes/`（原为 CL-017 真机巡检期的运维脚本，2026-09-20 `qa/probes` 清理时保留的 13 项夹具/运维脚本中的运维部分）。
> 全部脚本 **ASCII-only、无 BOM**。本 README 为使用说明（简体中文）。

## 执行方式（重要，勿内联）

**先 `scp` 到 VM，再在 VM 内 `powershell -File` 执行；不要把脚本内容经 ssh 内联传递。**

```bash
# 宿主侧推送（在项目根执行）
scp -P 22 delivery/tools/svc-state.ps1 User@172.16.100.2:C:/WinVMBridge/

# VM 侧执行（宿主远程触发亦可，但逻辑必须在 .ps1 文件内）
ssh -p 22 User@172.16.100.2 "powershell -NoProfile -ExecutionPolicy Bypass -File C:/WinVMBridge/svc-state.ps1"
```

## 脚本清单

| 脚本 | 用途 | 观测/干预 | 典型场景 |
|---|---|---|---|
| `svc-state.ps1` | 一屏看清服务状态：18443 监听者 PID/进程名/启动时间、vm-service node 进程数、ps-bridge 数量、残留部署类 powershell | 只读（observe-only，绝不触碰运行中服务） | 日常巡检 / 排障第一步 |
| `kill-restart.ps1` | 干净重启服务：强杀 18443 占用者及其子进程树（含 ps-bridge）→ 兜底清残留 ps-bridge → `schtasks /End` + `/Run` → 打印重启前后 PID | 干预（重启） | 服务假死/ps-bridge 不可热更后重启 |
| `qa-kill.ps1` | 强杀一个 ps-bridge.ps1 实例并展示重生情况（A3 自愈验收的独立复现器） | 干预（杀单进程） | 验证 ps-bridge 自愈（`restarts` 计数 +1 属预期） |
| `start-hidden-vm.ps1` | 隐藏窗口启动器：自清理端口占用 → `Start-Process -WindowStyle Hidden` 拉起 node → 退出时兜底杀子进程。**由 install-vm.mjs 生成，勿手改**；VM 上 `C:/WinVMBridge/` 的副本才是运行态权威 | 干预（启动） | 计划任务异常时手动拉起 |
| `probe-inv.ps1` | 清单探针：枚举三个卸载注册表根的 DisplayName，统计安装项总数（64/32 位同名重复属已知口径差异，见 MEMORY.md A8） | 只读 | 应用清单能力（app.* 域）比对验证 |
| `verify-d30.ps1` | D30（审计哈希链）复验三步：触发一次能力调用产生审计记录 → 列出审计分片 → 复查 `/health` 的 `audit.entries/chainValid/psBridge.restarts` | 只读（触发一次正常调用） | 审计链 freshChainOnStart 语义验证 |
| `add-defender-exclusions.ps1` | 给 Windows Defender 加排除项：排除路径 `C:\WinVMBridge`、`C:\WinVMWorkspace`，排除进程 `node.exe`、`powershell.exe`。先 `Get-MpPreference` 检测现有排除避免重复（幂等），成功后回显当前排除清单。**必须以管理员 PowerShell 运行**（非管理员会 `DEFENDER_EXCLUSION_FAILED` 退出码 1，脚本自身只读时不会误改） | 干预（系统安全配置，需管理员） | 消除 Defender 逐进程扫描造成的 powershell.exe 启动 10–60s 随机延迟（安装/超时类抖动共同根因；全周期 ~9min → ~4min） |

## 已知坑（血泪教训，全部来自 MEMORY.md / 真机事故）

1. **MSYS 路径转换**：VM 默认 ssh shell 是 Git-Bash（MSYS/CLANGARM64）。ssh 直传以 `/` 开头的 Windows 参数会被转换（如 `/End` → `C:/.../End`）——**所有远端逻辑必须写进 .ps1 再 `powershell -File` 跑**，勿在 ssh 命令行内联 PowerShell 逻辑（内联时 `$_` 还会被远端 bash 吞掉变 `/usr/bin/bash`）。
2. **pkill -f 'ssh -N -L' 是自杀禁忌**：模式会匹配到你自己的 ssh 会话进程，把自己的连接杀掉。清理隧道进程请直 kill 已知 PID（先 `Get-NetTCPConnection -LocalPort 18443` 查 OwningProcess）。
3. **PS 5.1 `Sort-Object -Property <键>` 对 `[ordered]@{}` 静默失效**：不带 `-Unique` 退化为不排序；带 `-Unique` 会塌缩成 1 条。必须用脚本块 `-Property { $_.key }`，数值键再套 `[double]`。
4. **隧道黑洞判据**：VM 掉线时宿主侧 `ssh -N -L` 进程仍活着并占着本地监听 → **TCP connect 成功 ≠ 服务存活**。半死判据 = `ping` 100% 丢包 + `ssh Host is unreachable` + 本地 TCP connect 仍成功 + HTTP 超时。此时应杀掉宿主侧隧道进程重建，而非只看端口连通。
5. **ps-bridge 不可热更**：改任何能力模块（`packages/vm-capabilities/psmod/*.ps1`）后必须重启 `WinVMBridge.Service` 才生效——常驻 ps-bridge 主循环 `while($true)` 只在 stdin 关闭/未捕获异常时退出，磁盘上的新文件不会被它重新加载。重启用 `kill-restart.ps1`。
6. **Stop-Process 传对象会静默失败**：`(Get-NetTCPConnection ...).OwningProcess` 结果须 `-ExpandProperty`/取整后传入；`kill-restart.ps1` 用 `taskkill /PID $p /T /F` 规避了此坑（/T 连子进程树一起杀）。
7. **`schtasks /end` 只杀壳**：`start-hidden-vm.ps1` 用 `Start-Process -WindowStyle Hidden` 拉起的 node 是孤儿，任务 /end 后仍占 18443。两个脚本都内置了「先强杀端口占用者再拉起」的自清理，直接用即可。

## 维护约定

- 新增脚本保持 **ASCII-only、无 BOM**（HMOS 沙箱编辑器/传输链路对非 ASCII 与 BOM 敏感）。
- 脚本与 `qa/probes/` 原件同源；`qa/probes/` 属验收夹具区，运维演进以本目录为准，反向同步需评审。
- `qa/probes/qa-verify.mjs`（A 系列 18 项验收）不在本目录：它依赖宿主侧项目根与隧道，属 QA 夹具而非 VM 运维工具。
