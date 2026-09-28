# GUI 健康翻绿 · 根因修复与重部署交付小结

**日期**：2026-09-14
**结论**：GUI 能力 `state` 从 `unavailable` 翻为 `healthy`，真机端到端验证通过（`/health` 实测）。

## 一、真根因（机制复核结论）

`packages/vm-capabilities/psmod/gui.ps1` 的 `Get-SessionHealth` 函数第 42 行：

```powershell
# 修复前（泄漏 bool → 数组）
[WinVM.SessionNative]::CloseWindowStation($hws)
```

`CloseWindowStation` 返回 `bool`，作为裸语句把 `$true` 写进 PowerShell **成功输出流**，与末尾 `return [ordered]@{}` 合并成 `[$true, 哈希表]` **数组**。

后续链路：
1. ps-bridge 透传 `data = [true, {...}]`；
2. `index.ts` 对**数组**取 `raw['windowStation']` / `raw['state']` → 恒为 `undefined`；
3. `normalizeState(undefined)` → `unavailable`，且 `windowStation:''`。

**关键点**：这与 session 真假无关。探针内部 `sessionId:1` 时 `state` 本就是 `healthy`，只是被外层 `[true, ...]` 包裹破坏了序列化。此前把 `windowStation:''` 误判为「catch 兜底 / PsBridgeError」是**错的**——`bridge.call` 实际成功（`ok:true`）。

## 二、修复（源码 + 已重部署）

`gui.ps1` 第 42 行改为吸收返回值：

```powershell
# 修复后（[void] 吸收 bool，返回值纯为有序哈希表）
[void][WinVM.SessionNative]::CloseWindowStation($hws)
```

ps-bridge 启动时 `dot-source` 全部模块且**不可热更** → 修复后必须重启 VM 服务才生效。

## 三、重部署动作

- 定位 VM 部署路径唯一：`C:\WinVMBridge\packages\vm-capabilities\psmod\gui.ps1`（无 dist 副本）。
- 推送修复后的 `gui.ps1` 至 VM。
- 干净重启服务：`schtasks /End` + `/Run` 计划任务 **`WinVMBridge.Service`**（其 `start-hidden.ps1` 内置按端口强杀旧 node + `MultipleInstancesPolicy=StopExisting`，避免孤儿进程）。
- 重启后新 node PID `15120`（v24.21.0，session 1）接管 18443，旧 `15560` 已退出。

## 四、验证证据（真机）

隧道 `ssh -L 18444:127.0.0.1:18443` → `curl /health`：

```json
"session":{
  "sessionId":1, "windowStation":"WinSta0", "desktop":"Default",
  "interactive":true, "locked":false, "blackScreen":false,
  "state":"healthy", "detail":"会话健康，GUI 能力可用"
}
```

`provider:ready`、`psBridge:ready`、`capabilities{count:54,available:54}`、`exposed:54` 全绿。

## 五、清理

- 删除本会话与历史遗留临时诊断文件（host `C:\Users\currentUser\*.ps1`、VM `C:\Users\User\*` 与 `C:\WinVMBridge\*diag*` 等）。
- 删除历史遗留临时计划任务 **`WinVMBridge.Diag`**；现仅余 `WinVMBridge.Service | Running`。

## 六、踩坑记录（已入 MEMORY.md）

- **VM 远端 shell 是 Git Bash（MSYS）**：ssh 直传命令里以 `/` 开头的 Windows 参数（`schtasks /End /TN`、`cmd /c`）会被 MSYS 路径转换（`/End` → `C:/Program Files/Git/End`）而报错。→ 所有远端逻辑写进 `.ps1` 再用 `powershell -File` 跑，绝不在 ssh 直调带 `/` 前缀 flag 的 Windows 命令。

## 七、遗留

- 源码已改，但 `git` 在本环境不可用，未提交；如需提交请用户在可提交环境 `git commit`。
- 全量 `tests/unit` + TS 类型检查 + 端到端冒烟仍待联网机复核（仅含 @winvm/* 的文件需构建环境）。
