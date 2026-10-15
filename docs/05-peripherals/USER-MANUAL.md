# 用户手册 · 让宿主机 WorkBuddy 完全操作你的 Windows 虚拟机

> 目标读者：使用宿主机 WorkBuddy、需要远程"使唤"Windows 虚拟机干活的你。

---

## 1. 你能做什么

装好 `winvm-bridge` 后，你在宿主机 WorkBuddy 里直接说人话，它会通过 **5 个 Skill** 把指令送到虚拟机执行：

| Skill | 领域 | 典型能干的事 |
|-------|------|--------------|
| `winvm-orchestrator` | 总控 | 拆解目标、选通道（MCP 精确 / A2A 任务）、编排、兜底 |
| `winvm-system-admin` | 系统 | 查系统/服务/进程/事件日志/注册表、重启服务（Windows 更新管理当前不可用，V2 规划） |
| `winvm-app-manager` | 应用 | 列出/安装/卸载/升级/启动应用（Winget、MSStore、EXE/MSI）；结束进程走 `system.process.terminate` |
| `winvm-storage-manager` | 存储 | 磁盘/分区/卷/文件/回收站（查看）的查询与整理 |
| `winvm-gui-automation` | GUI | 截屏、找窗口/控件、键鼠自动操作（UIA/Accessibility） |

> 高危动作（关机、删文件、改注册表、卸应用）默认**禁用 + 需审批**，不会悄悄执行。

---

## 2. 两个通道，怎么选

- **MCP 通道（工具级）**：精确、可控、低延迟。适合"执行具体命令/查具体信息"。WorkBuddy 把它当成一组工具直接调用。
- **A2A 通道（任务级）**：把自然语言目标丢给虚拟机 Agent，它自己拆解步骤、汇报进度、遇到高风险动作会**停下来问你**。适合"帮我把这个 VM 整理干净""把某软件装好并配好"。

总控 Skill `winvm-orchestrator` 会根据任务自动选通道。

---

## 3. 日常用法示例

### 3.1 精确查询（MCP）
> "查一下虚拟机 192.168.1.77 的磁盘剩余和内存占用"

WorkBuddy 调用 `storage.disk.list` + `system.info.get`，返回结构化结果。

### 3.2 委派任务（A2A）
> "把虚拟机里 C 盘临时文件清理一下，超过 30 天的放进回收站，别真删"

走 A2A：`message/send` 委派 → 逐步执行 → 真要删文件时发 `input-required` 问你 → 你批准后经 `a2a.approval.reply` 续跑 → 回传 artifact。

### 3.3 GUI 自动化
> "打开虚拟机里的记事本，输入'hello'，保存为 test.txt"

走 `winvm-gui-automation`：截屏定位 → UIA 找控件 → 键鼠操作 → 校验。

---

## 4. 审批怎么处理

当任务命中 L2/L3 风险，工具/任务会**挂起**并提示你确认：

- MCP 通道：`requiresApproval: true`，WorkBuddy 弹出确认
- A2A 通道：任务状态变 `input-required` 挂起等你确认。你批准后，WorkBuddy 经 `a2a.approval.reply` 应答（底层是带审批结果的 `message/send`），VM 服务端收到批准后续跑

**拒绝或超时**会安全中止，不做任何破坏性动作。

---

## 5. 审计与回放

所有操作（含被拒的）都写入 **防篡改哈希链** 审计日志，落盘于 VM 侧
`%LOCALAPPDATA%\WinVMBridge\audit\audit-YYYYMMDD.jsonl`。

**查看方式（当前）**：SSH 进 VM 直接读取该 jsonl（每行一条：traceId、能力 ID、
参数〔敏感键打码〕、风险、策略判定、执行结果、前后哈希）。

**链完整性（当前）**：`GET /health` 响应中的 `chainValid` / `brokenAt` 字段即全链校验结果，
任一条被篡改都会如实报出。

> ⚠ `winvm-service` CLI 当前**没有** `--audit tail / --audit verify` 子命令（仅
> `--config/--port/--host/--self-test/--help`）；内容级查询能力 `meta.audit.query` 为
> **V2 规划·当前不可用**（见 `CAPABILITY-MODEL.md` §5），规划落地后再回补本节命令示例。

---

## 6. 常见问题

**Q：工具调用一直超时？**
A：多半是 SSH 隧道没建或断了。重跑 `ssh -f -N -L 18443:127.0.0.1:18443 vmadmin@<vm-ip>`。

**Q：高危工具报"已禁用"？**
A：属预期。需在安装器配置里显式解除 `disabledTools` 并走审批流程，详见 DEPLOYMENT.md §4.1。

**Q：换一台虚拟机？**
A：改 `--host`/`--user` 重跑安装器即可，插件与 Skill 不变（解耦设计）。

**Q：虚拟机里想换成别的 Agent 框架？**
A：只需替换 `adapter-agent-workbuddy`（实现桥接 SPI），上层 MCP/A2A/宿主插件都不动。
