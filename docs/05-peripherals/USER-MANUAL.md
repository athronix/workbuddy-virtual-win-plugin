# 用户手册 · 让宿主机 WorkBuddy 完全操作你的 Windows 虚拟机

> 目标读者：使用宿主机 WorkBuddy、需要远程"使唤"Windows 虚拟机干活的你。

---

## 1. 你能做什么

装好 `winvm-bridge` 后，你在宿主机 WorkBuddy 里直接说人话，它会通过 **5 个 Skill** 把指令送到虚拟机执行：

| Skill | 领域 | 典型能干的事 |
|-------|------|--------------|
| `winvm-orchestrator` | 总控 | 拆解目标、选通道（MCP 精确 / A2A 任务）、编排、兜底 |
| `winvm-system-admin` | 系统 | 查系统/服务/进程/事件日志/注册表、重启服务、装更新 |
| `winvm-app-manager` | 应用 | 列出/装/启/停应用（Winget、MSStore、EXE/MSI）、查窗口 |
| `winvm-storage-manager` | 存储 | 磁盘/分区/卷/文件/回收站/配额/去重 的查看与整理 |
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

走 A2A：`tasks/send` → 逐步执行 → 真要删文件时发 `input-required` 问你 → 你确认 → 续跑 → 回传 artifact。

### 3.3 GUI 自动化
> "打开虚拟机里的记事本，输入'hello'，保存为 test.txt"

走 `winvm-gui-automation`：截屏定位 → UIA 找控件 → 键鼠操作 → 校验。

---

## 4. 审批怎么处理

当任务命中 L2/L3 风险，工具/任务会**挂起**并提示你确认：

- MCP 通道：`requiresApproval: true`，WorkBuddy 弹出确认
- A2A 通道：任务状态变 `input-required`，你回复"继续/取消/改参数"，WorkBuddy 用 `tasks/resubscribe` 续跑

**拒绝或超时**会安全中止，不做任何破坏性动作。

---

## 5. 审计与回放

所有操作（含被拒的）都写入 **防篡改哈希链** 审计日志：

```bash
# 查看最近 50 条（VM 侧）
node packages/vm-service/dist/cli.js --audit tail 50

# 校验链完整性（任一条被改都会报错）
node packages/vm-service/dist/cli.js --audit verify
```

审计条目含：traceId、能力 ID、参数（敏感键打码）、风险、策略判定、执行结果、前后哈希。

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
