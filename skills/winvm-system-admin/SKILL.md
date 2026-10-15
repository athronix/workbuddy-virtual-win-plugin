---
id: winvm-system-admin
name: Windows 系统管理
description: >
  在 Windows 虚拟机内执行系统管理：服务、进程、计划任务（查询）、注册表、网络配置（查询）、
  本地用户与组（查询）、环境变量（读取）、事件日志、电源。用于查询系统状态、
  启停服务、排查故障、调整系统配置。Windows 更新管理当前不可用（V2 规划）。
version: 0.1.0
domains: [system]
triggers:
  - 虚拟机系统
  - 虚拟机服务
  - 虚拟机网络
relatedSkills:
  - winvm-orchestrator
---

# Windows 系统管理

> **前置（隧道在线健康）**：任何工具调用前先确保隧道在线健康 ——
> 运行 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure`（幂等；不健康自动重启）→ 再 `… health` 需 `ok:true`（**部署态命令，任意 cwd 可用**）。
> 详见 [`winvm-orchestrator`](../winvm-orchestrator/SKILL.md) §前置检查：tunnel 在线健康。

## 适用与不适用

**适用**：服务/进程/计划任务/注册表/网络/用户/环境变量/事件日志的查询与受控变更
（其中计划任务、网络、用户为**只读查询**；受控变更面 = 服务启停/配置、注册表写、进程终止、电源）。

**不适用**：
- **Windows 更新管理**（检查/安装补丁）→ 能力**当前未注册、不可调用**（V2 规划），
  用户提出"打补丁/更新系统"时如实告知并建议人工在 VM 内 Windows Update 操作
- 计划任务注册/修改/删除、改 IP/DNS、账户改密/组成员变更、环境变量**写入** → 当前不可用
  （查询/读取可用；写侧 V2 或"已实现待挂载"，见 §能力清单注记）
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

> **发现类能力（M6 声明位）**：`meta.capability.list`（L0，全域通用）是服务端元能力，
> 用于运行期核对当前 provider **实际暴露的能力面**（provider degraded 时收窄至仅
> `meta.*`）。下表为本域**预期**清单；若不确定目标能力此刻是否可用，以 MCP `tools/list`
> 的能力 ID 级暴露面为权威，或先 `meta.capability.list` 自检再决定直调/委派——对未暴露
> 能力直接调用会得到 `CAPABILITY_NOT_EXPOSED` / `PROVIDER_UNAVAILABLE`（不重试，先核对暴露面）。

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
| `system.env.manage` | L1 | 环境变量**读写**（带 `value` ⇒ 写入，空串=删除变量；不带 ⇒ 读取。M6 起写侧已挂载；Machine 目标需管理员令牌） |
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

> `system.service.list` 的 `name` 是**模糊匹配**（子串，不区分大小写），可只给片段；
> 不传 `name` 时返回**全部服务**（已优化为一次 `Get-CimInstance Win32_Service` 建表，不再逐项过滤超时）。
> `system.service.control` 的 `name` 则要求**精确短名**。

### 示例：排查服务启动失败

```
1. system.service.list   { name: "<svc>" }
2. system.eventlog.query { logName: "System", maxEvents: 50, level: "Error" }
3. 关联分析后向用户报告，不擅自改配置
```

## 高危清单（L2/L3 强制动作）

> 审批卡片：统一模板见 [`../winvm-orchestrator/references/approval-card.md`](../winvm-orchestrator/references/approval-card.md)（§审批卡片模板 · 唯一正文；本文件不复制正文）

| 操作 | 风险 | 强制动作 |
|---|---|---|
| `system.service.configure` | L2 | 展示现状 → 审批 → 执行 → 验证 |
| `system.process.terminate` | L2 | 展示进程与子进程清单 → 审批 |
| `system.registry.write` | L2 | **先读后写**，展示旧值 → 审批 → 执行 |
| `system.power.control` | L3 | **必须**先 `dryRun: true` 预览 → 用户二次确认 → 再执行 |

> 上表「展示现状 / 进程清单与子进程 / 旧值」即模板的 **目标**、**影响清单**、**dry-run 预览** 槽位；卡片格式与填充规则以模板为准（引用见本节开头），本文件不复制正文。

## 入参契约错误处理（`INVALID_PARAMS` / `INVALID_ARGUMENT`）

调用本域工具若返回 `error.code == "INVALID_PARAMS"` 且 `error.reason == "INVALID_ARGUMENT"`，
说明**入参不符合能力契约**（参数名写错 / 漏传必填 / 取值非法），由 VM 服务在发起 PowerShell **之前**拦截，
**不产生桥往返**（毫秒级返回）。

- **不重试**（`retryable=false`）：参数不变，重试必然再次失败。
- **看 `error.details`**：`missing`（缺失的必填）、`unknown`（不支持的参数名）、`allowed`（该能力可用参数）、
  `invalid`（已提供但取值非法的键，含 `expected`/`got`）；按 `error.message` 中的「该能力可用参数：…」改正参数后**再调用**。
- **先查 `inputSchema`**：`tools/list` 中该工具的 `inputSchema.required`（必填）与
  `inputSchema.properties`（可用参数）即**权威契约**，调用前先比对可避免此类错误。

## 已知陷阱

- **服务名 vs 显示名**：`Get-Service` 的 `Name` 是短名（如 `Spooler`），
  显示名是"Print Spooler"。工具参数用**短名**
- **受保护进程拒绝终止**：`lsass`/`csrss`/`winlogon`/`services`/`smss`/`wininit`
  一律被策略拒绝，这是**刻意设计**，不要试图绕过
- **注册表路径写法（重要）**：用 `HKCU:\Software\X` / `HKLM:\SOFTWARE\X`（**带冒号**）。
  若误写成 `HKLM\SOFTWARE\X`（无冒号），策略层会**自动归一化为 `HKLM:\SOFTWARE\X`**；但**仍建议显式写冒号**，以免歧义。
  **可读根键白名单**：`HKCU:\**`（含 `HKEY_CURRENT_USER\**`）、`HKLM:\SOFTWARE\**`（含 `HKEY_LOCAL_MACHINE\SOFTWARE\**`）；
  其它根键（`HKLM:\SYSTEM`、`HKLM:\SAM`、`HKLM:\SECURITY`）**读/写一律拒绝**。
- **HKLM 写入**：写白名单为 `HKCU:\**` 与 `HKLM:\SOFTWARE\**`（其中 `HKLM:\SOFTWARE` **需 L2 审批**：
  S-5 修复后 `registryWriteAllowlist` 才真正生效，而 `system.registry.write` 风险为 L2 ⇒
  两表内路径的写入未批 → `approval-required`，批准后放行），`HKLM:\SYSTEM` 等其它根键写入被策略**硬拒**
  （`registryWriteAllowlist:miss`，白名单 miss 在审批闸之前 ⇒ 不转「需批准」）
- **事件日志 `level`**：推荐**英文枚举** `Critical` / `Error` / `Warning` / `Information` / `Verbose`
  （同时接受中文别名「严重 / 错误 / 警告 / 信息 / 详细」，但**推荐英文**）；内部映射为数字 `Level` 过滤。
  `level` 传了未识别的值不会报错，但**会返回空结果** —— 查不到日志时先核对枚举拼写。
- **事件日志消息很长**：工具已截断到 500 字符，需要完整内容请缩小查询范围
- **环境变量作用域**：`User` 与 `Machine` 不同，读取时按 `target` 区分；
  当前该能力**只读**（写入待挂载），不要向用户宣称"已设置环境变量"

## 参考

- 能力定义：`docs/02-design/CAPABILITY-MODEL.md` §3.1
- 错误码：`docs/02-design/INTERFACES.md` §2.6
- 策略基线：`docs/02-design/SECURITY-GOVERNANCE.md` §3.2
