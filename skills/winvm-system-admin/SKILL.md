---
id: winvm-system-admin
name: Windows 系统管理
description: >
  在 Windows 虚拟机内执行系统管理：服务、进程、计划任务、注册表、网络配置、
  本地用户与组、环境变量、事件日志、电源与更新。用于查询系统状态、
  启停服务、排查故障、调整系统配置。
version: 0.1.0
domains: [system]
triggers:
  - 查看/启动/停止/重启服务
  - 查看/结束进程
  - 查看事件日志排查故障
  - 修改注册表或环境变量
  - 查看网络配置
relatedSkills:
  - winvm-orchestrator
---

# Windows 系统管理

## 适用与不适用

**适用**：服务/进程/计划任务/注册表/网络/用户/环境变量/事件日志的查询与受控变更。

**不适用**：
- 分区、格式化、改启动配置（BCD）→ L3，本系统不提供，需人工在 VM 内执行
- 域控级 AD 操作 → 范围外
- 修改 `HKLM:\SYSTEM`、`HKLM:\SAM`、`HKLM:\SECURITY` → 策略禁止

## 前置检查

按 `winvm-orchestrator` §前置检查 执行（隧道 / 健康）。本域不需要交互式会话
（除需观察 GUI 结果外），因此在无 GUI 会话时仍可工作。

## 通道选择

- **查询类**（列出服务、读注册表、查日志）→ **MCP 直调**，单步且结构化
- **排查类**（"帮我查为什么某某服务起不来"）→ **A2A 委派**，需多步关联日志与配置

## 能力清单

| 能力 ID | 风险 | 说明 |
|---|---|---|
| `system.info.get` | L0 | OS 版本/内存/CPU/域/启动时间/是否管理员 |
| `system.service.list` | L0 | 服务清单与启动类型 |
| `system.service.control` | L1 | 启动/停止/重启服务 |
| `system.service.configure` | L2 | 改启动类型（**需审批**） |
| `system.process.list` | L0 | 进程清单（PID/会话/内存/命令行） |
| `system.process.terminate` | L2 | 结束进程（含进程树，**需审批**） |
| `system.task.scheduled` | L0 | 计划任务与最近/下次运行时间 |
| `system.registry.read` | L0 | 读注册表（限可读取根键） |
| `system.registry.write` | L2 | 写注册表（限可写根键，**需审批**） |
| `system.network.config` | L0 | 网卡/IP/DNS/路由 |
| `system.user.manage` | L0 | 本地用户与启用状态 |
| `system.env.manage` | L1 | 读写用户/系统环境变量 |
| `system.eventlog.query` | L0 | 事件日志查询 |
| `system.power.control` | **L3** | 关机/重启/休眠/睡眠（**先 dry-run**） |

## 标准流程

1. **先查后改**：变更类操作前先用 L0 能力确认现状
2. **判断风险**：L2/L3 走审批闸（见总控 §审批闸协议）
3. **执行**：优先用最小作用范围的参数
4. **验证**：改动后再次查询确认生效
5. **留痕**：记录 `traceId` 与 before/after 差异

### 示例：重启打印后台服务

```
1. system.service.list   { name: "Spooler" }        # L0 查现状
2. system.service.control { name: "Spooler", action: "restart" }   # L1 直接执行
3. system.service.list   { name: "Spooler" }        # L0 验证
```

### 示例：排查服务启动失败

```
1. system.service.list   { name: "<svc>" }
2. system.eventlog.query { logName: "System", maxEvents: 50, level: "错误" }
3. 关联分析后向用户报告，不擅自改配置
```

## 高危清单（L2/L3 强制动作）

| 操作 | 风险 | 强制动作 |
|---|---|---|
| `system.service.configure` | L2 | 展示现状 → 审批 → 执行 → 验证 |
| `system.process.terminate` | L2 | 展示进程与子进程清单 → 审批 |
| `system.registry.write` | L2 | **先读后写**，展示旧值 → 审批 → 执行 |
| `system.power.control` | L3 | **必须**先 `dryRun: true` 预览 → 用户二次确认 → 再执行 |

## 已知陷阱

- **服务名 vs 显示名**：`Get-Service` 的 `Name` 是短名（如 `Spooler`），
  显示名是"Print Spooler"。工具参数用**短名**
- **受保护进程拒绝终止**：`lsass`/`csrss`/`winlogon`/`services`/`smss`/`wininit`
  一律被策略拒绝，这是**刻意设计**，不要试图绕过
- **注册表路径写法**：用 `HKCU:\Software\X` 或 `HKLM:\SOFTWARE\X`（带冒号与反斜杠）
- **HKLM 写入**：默认只允许 `HKCU` 写入；`HKLM:\SOFTWARE` 需 L2 审批，
  `HKLM:\SYSTEM` 等被策略禁止
- **事件日志消息很长**：工具已截断到 500 字符，需要完整内容请缩小查询范围
- **环境变量作用域**：`User` 与 `Machine` 不同；改 `Machine` 通常需管理员权限

## 参考

- 能力定义：`docs/02-design/CAPABILITY-MODEL.md` §3.1
- 错误码：`docs/02-design/INTERFACES.md` §2.6
- 策略基线：`docs/02-design/SECURITY-GOVERNANCE.md` §3.2
