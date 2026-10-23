---
id: hos-win-skill
name: 鸿蒙↔Windows 任务分派
description: >
  鸿蒙 WorkBuddy 处理用户任务的分派指引——判定哪些步骤在鸿蒙本地完成、哪些经 winvm 通道交给 Windows VM；
  涉及 Windows 系统/应用/存储/GUI 管理、跨 App 数据或目标文件在 VM 时触发；进入 VM 后以 winvm-orchestrator 为唯一总控。
version: 0.1.0
domains: [meta]
triggers:
  - Windows 操作
  - 虚拟机任务
  - C 盘清理
  - 装软件
  - VM 文件
  - 跨 App 数据
  - 鸿蒙做不了
relatedSkills:
  - winvm-orchestrator
  - winvm-mcp-reference
---

# hos-win-skill：鸿蒙 ↔ Windows VM 任务分派指引

## 0. 一句话规则

**「文档、分析、创作、编排留鸿蒙；系统、应用、GUI、跨 App 去 Windows。」**
需要触碰 Windows 系统面（服务/进程/注册表/计划任务/电源）、应用面（安装/卸载/盘点/启动）、存储管理（磁盘/清理/归档/回收站）、GUI 自动化，或目标数据就在 Windows VM 上 ⇒ 必须经 winvm 通道执行；鸿蒙本地**不存在**这些系统入口（OS 不给 API，非权限问题）。

**通道速判（三条铁律，优先级从高到低）：**
1. **风险优先**：目标能力是 L2/L3 ⇒ 一律 `a2a.delegate`（宿主侧 mcp.json 已把全部 8 个 L2/L3 工具写进 `disabledTools` 静态禁用，直调面本就看不见它们；即便绕过禁用直调，服务端 `DELEGATION_REQUIRED` 策略缺省 on 收口，不返回审批卡、不发续跑令牌，重试无益）。
2. **步骤定界**：能预先穷举为确定步骤（1–2 步、无中间判断）⇒ MCP 直调；步骤依赖上一步结果、需看屏决策或开放意图（只给目标态不给步骤）⇒ `a2a.delegate`。
3. **拿不确定先探后定**：先用 MCP 直调一条 L0 读能力（info.get / health.check）取事实，再按 1/2 定通道；直调途中收到 `DELEGATION_REQUIRED` ⇒ 立即转委派，勿重试。

## 1. 分派判定表

### 1.1 在鸿蒙本地完成（不委托）

| 任务类别 | 例子 | 依据 |
|---|---|---|
| 文档/表格/PPT 创作 | 报告、纪要、简历、数据分析报告 | WB 应用能力两平台一致，鸿蒙产出即用户所在端 |
| 信息检索与网络内容 | WebSearch/WebFetch、行情、竞品调研 | 鸿蒙出站网络实测可用 |
| 共享存储文件操作 | `~/Documents`、`~/Downloads` 下整理/重命名/归档/清理分析（只读先行） | hmdfs 是鸿蒙 WB 唯一完整可写面 |
| 鸿蒙自有工具面 | hish-bridge 命令、hmdfs 内文件、WB 连接器（腾讯文档/会议/IMA 等）、定时任务编排、Ardot 设计、3D/图像/视频生成 | 均为 WB/连接器能力，与 VM 无关 |
| 代码读写（项目在鸿蒙侧） | 本仓 TS/JS 开发、`tsc -b`、单测 | 工具链齐备（git 需全路径） |
| 多端协同控制 | 手机→鸿蒙 PC 远程发令/审批/停止 | WB 官方能力 |

### 1.2 委托 Windows VM 完成（winvm 通道）

| 任务类别 | 对应能力域 | 例子 |
|---|---|---|
| Windows 系统管理 | `system.*`（14 项） | 查服务/控制服务、进程盘点/终止、注册表读写、计划任务、事件日志、环境变量、电源控制(L3 必 dryRun)、service.configure/process.terminate/registry.write 为 L2 |
| Windows 应用管理 | `app.*`（8 项） | winget search/install/uninstall/upgrade、已装应用盘点、启动 exe、快捷方式、appx、winget.uninstall 为 L2 |
| 应用操作自动化 | `appops.*`（5 项） | CLI 调用、COM 自动化、GUI 产出、状态查询、工作流编排、gui.produce 为 L2 |
| Windows 存储管理 | `storage.*`（13 项） | 磁盘清单、空间/清理分析、文件增删改查、归档、回收站、符号链接、搜索、file.delete/link.manage 为 L2 |
| GUI 自动化 | `gui.*`（11 项） | 截屏/分析、UIA 树与调用、键鼠合成、剪贴板、窗口列表/控制、条件等待 |
| 服务/能力元查询 | `meta.*`（3 项） | meta.health.check 健康、meta.capability.list 能力清单、meta.session.status 会话健康 |
| 目标文件在 VM 上 | `C:\WinVMWorkspace`、`C:\Users\...` 等 | 任何落点为 VM 文件系统的读写 |
| 需 Windows 工具链的任务 | VM 内 node/git/PS 5.1 生态 | 在 VM 上跑构建/脚本/依赖安装 |

五域+meta 共 54 项（L0:27/L1:19/L2:7/L3:1）。

## 2. 通道选择：MCP 直调 vs winvm-a2a 委派（核心声明）

> **本节是强制性声明**：凡调用 winvm 工具，必须先按本节判定通道；禁止默认全走 MCP 或全走 A2A。

### 2.0 何时用普通 MCP 通道（winvm，`/mcp` 直调）

满足**全部**条件时用 MCP 直调：
- ✅ 目标能力风险档为 **L0 或 L1**；
- ✅ **单步可完成**：一个能力调用 + 固定入参即可得出最终结果，无需看返回值再决定下一步；
- ✅ 结果**可预期**：调用前就能说出成功长什么样（如"读到此注册表值""列出 N 个服务"）；
- ✅ 预期秒级完成：单能力 timeoutMs 10–600s（未声明回落 30s），MCP 连接器总超时 120s。

> 宿主工具名以会话 tools/list 实际返回为准（点分能力 ID 为本项目规范形态，部分宿主会将点号渲染为下划线）。

**典型场景 → 工具**：
| 场景 | 直调工具 |
|---|---|
| 查系统信息/会话/健康 | `winvm__system.info.get`、`winvm__meta.health.check`、`winvm__meta.session.status` |
| 盘点类读查询 | `winvm__system.service.list`、`winvm__system.process.list`、`winvm__app.inventory.list`、`winvm__system.task.scheduled`、`winvm__system.eventlog.query` |
| 文件读/搜/单文件复制 | `winvm__storage.file.read`、`winvm__storage.search.query`、`winvm__storage.file.copy`、`winvm__storage.space.analyze` |
| 截屏/UIA 观测（只看不操作） | `winvm__gui.screen.capture`、`winvm__gui.uia.tree`、`winvm__gui.window.list` |
| L1 简单变更（机械单步） | `winvm__storage.file.move`、`winvm__system.env.manage`、`winvm__gui.clipboard.manage` |

### 2.1 何时用 A2A 通道（winvm-a2a，`a2a.delegate`）

满足**任一**条件即必须委派：
- ✅ 目标能力风险档为 **L2/L3**（删除/卸载/结束进程树/写注册表/创建链接/电源控制）——强制，无例外；
- ✅ **多步编排**：≥3 步，或步骤 2+ 的入参依赖步骤 1 的返回值；
- ✅ **开放意图**：用户只描述目标态（"把 C 盘清出 20GB""在 VM 上装好 X 并验证""帮我把这个软件配置好"），步骤需 VM 侧 agent 自主规划；
- ✅ **需看屏决策**：GUI 自动化要「截图→分析→再操作」循环；
- ✅ **预期 > 30s** 或需要失败重试/条件分支/进度流式回传；
- ✅ MCP 直调已返回 `DELEGATION_REQUIRED`（此时委派是唯一正确动作）。

**典型场景**：部署并验证、卸载+残留核验、C 盘清理方案+执行、Word/Excel 多步生产（appops.gui.produce）、浏览器登录操作、跨多能力的排障（查日志→定位→改配置→重启→验证）。

### 2.2 双通道对照表

| 判据 | MCP 直调（`/mcp`，`winvm__<域>.<动作>`） | A2A 委派（`/a2a`，delegate） |
|---|---|---|
| 任务形态 | **单步、能力一一对应**：一个能力调用可完成 | **多步、有状态、需推理**：需要 VM 侧 agent 规划-执行-验证闭环 |
| 典型例子 | `winvm__system.info.get`、`winvm__storage.file.read`、单文件复制 | 「在 VM 上部署 X 并验证」「分析 C 盘空间并给清理方案」「卸载 Y 并核验残留」 |
| 风险路由 | L0/L1 直接执行；**L2/L3 一律 `DELEGATION_REQUIRED`**（宿主侧 mcp.json 已把全部 8 个 L2/L3 工具写进 `disabledTools` 静态禁用，直调面本就看不见；即便绕过禁用（如裸 HTTP 打 `/mcp`），服务端 `WINVM_DELEGATION_REQUIRED_POLICY` 缺省 on 收口——不返回 approvalId、不发续跑令牌，重试无益） | L2 审批闸（input-required 出卡）；L3 先 dryRun 预览→审批+二次确认 |
| 审批呈现 | 无审批面 | 七槽位审批卡（show_widget）→ AskUserQuestion 权威收口 → `a2a.approval.reply` → `a2a.task.get` 轮询终态 |
| 状态 | 无会话（幂等查询为主） | 常驻会话（task.get 跟踪；空闲 TTL 300s（`WINVM_LLM_SESSION_IDLE_MS` 可调）；TTL 回收后首次委派付进程级冷启动（深度空闲实测 49.3s，CLI 地板 75–107s）；会话就绪预算 180s（`WINVM_LLM_SESSION_READY_MS`），窗内 0 进度属正常，勿判死勿重试） |
| 选择原则 | 能一条 L0/L1 调用做完就不委派——延迟低、审计链短 | 涉及多能力编排/条件分支/失败重试，或命中 L2/L3，或返回 `DELEGATION_REQUIRED` 时委派 |

**红线**（真机已验证）：
- **L2/L3 经 MCP 直调 = `DELEGATION_REQUIRED`**（缺省策略 on）：宿主侧 mcp.json 已静态禁用全部 8 个 L2/L3 工具（`disabledTools`）——直调面本就看不见它们；即便绕过禁用（如裸 HTTP 打 `/mcp`），服务端 `WINVM_DELEGATION_REQUIRED_POLICY` 缺省 on 收口，不返回 approvalId、不发续跑令牌，重试无益；唯一正确动作 = 改 `a2a.delegate` 委派同一目标。
  - L2 全集 7 个：system.service.configure / system.process.terminate / system.registry.write / app.winget.uninstall / storage.file.delete / storage.link.manage / appops.gui.produce；L3 唯一：system.power.control。
- provider=workbuddy 时**禁止批量 tasks/cancel**——每个 requestCancel 会打断常驻 LLM 会话引发重建风暴；单条 cancel ~3.4s。
- 审批呈现协议 MUST：show_widget 七槽位审批卡 → AskUserQuestion 批准/拒绝/暂不 → 禁纯文本代批 → reply + task.get 取终态。
- 禁 SSH 直调 winget（非交互会话 MSIX alias 拒绝访问，结构性限制）；winget 动作一律走服务层（MCP/A2A）。
- 5 条 supportsDryRun 免审批全集：power.control / file.delete / winget.install / winget.uninstall / winget.upgrade（dryRun=true 直接放行返回计划、不出卡）；未声明 supportsDryRun 的 L2/L3 能力传 dryRun 照常被审批闸拦（fail-closed，不会免批）。

## 3. 决策流程

```
用户任务
  ├─ 目标产物/数据在鸿蒙侧？且纯文档/分析/创作/编排？
  │    └─ 是 → 鸿蒙本地完成（WB 原生能力 + 连接器）
  ├─ 涉及 Windows 系统面/应用面/GUI/VM 文件系统？（通道判定按 §2 声明）
  │    ├─ 单步 + L0/L1 + 结果可预期 + <30s → MCP 直调（§2.0 场景表）
  │    ├─ L2/L3、≥3 步/开放意图/看屏决策/预期 >30s → winvm-a2a 委派（§2.1）
  │    │   （L2 出审批卡，L3 dryRun→审批→二次确认）
  │    ├─ 直调返回 DELEGATION_REQUIRED → 改 a2a.delegate，勿重试
  │    ├─ 通道健康检查 → meta.health.check（隧道黑洞判据：ping 100% 丢/TCP 通 HTTP 死）
  │    └─ 判定走 VM ⇒ 加载 winvm-orchestrator（唯一总控：审批协议/领域路由/工具缺失处置以其为准，本 skill 不重复）
  ├─ 涉及鸿蒙其它 App 沙箱/系统设置写入/预装应用管理？
  │    └─ 鸿蒙 OS 无入口 → 如 Windows VM 上有等价物则走 VM，否则如实告知不可行
  └─ 混合任务（如"整理鸿蒙文档并同步到 VM"）→ 拆分：鸿蒙段本地做，Windows 段按 §2 分通道，产物经共享路径/回执合并
```

## 4. 已知能力边界（不承诺做不到的事）

| 边界 | 位置 | 处置 |
|---|---|---|
| 锁屏态 GUI 自动化 | Windows VM（Winlogon 安全桌面边界） | 不可代码解锁；E2E 前置人工配方（powercfg 禁休眠 + session.state==='healthy' 门） |
| winget 非交互 MSIX alias | Windows VM | "拒绝访问"多次复现；真卸载类需桌面会话，勿强造 |
| 其它鸿蒙 App 沙箱 / 系统设置写入 | 鸿蒙 | OS 级隔离无入口；走 URI 授权机制的场景仅限 App 内，CLI 不可用 |
| 鸿蒙定时任务粒度 | 鸿蒙 | automation 最小 HOURLY；更细粒度安全网靠会话内巡检 |
| VM 深度空闲冷启动 | Windows VM | ~49.3s 深度空闲实测（TTL 5min 语义）；CLI 进程级地板 75–107s；就绪预算 180s 内 0 进度属正常 |
| provider=hermes-agent 的 L2/L3 | Windows VM | 审批续跑与真值反查不可用（特性子集不同），切非全特性 provider 时如实告知（orchestrator 口径） |

## 5. 产物回传约定

- VM 侧产物统一落 `C:\WinVMWorkspace\`，经 `storage.file.read` 或 A2A 回执取回；含中文证据**必须**走「VM 侧 UTF8 落文件 → scp/回执回传 → JSON.parse 自证」，禁止 `ssh > 本地文件`（码页腐化）。
- 审计与转呈：服务端回执为唯一事实（success 以事后核验为准）；宿主如实转呈，不得改写失败为成功。

## 6. 与本项目 skills 的分层与互补

| Skill | 层级定位 | 职责边界 |
|---|---|---|
| `hos-win-skill`（本 skill） | 宿主侧分派层 | 鸿蒙本地 vs Windows VM 的任务分派预判 + 通道速判；宽触发，不进入 VM 内细则 |
| `winvm-orchestrator` | VM 内唯一总控 | 入口/审批闸协议/领域路由/工具缺失指引；进入 VM 后一切以其为准，本 skill 不重复 |
| `winvm-system-admin` / `winvm-app-manager` / `winvm-storage-manager` / `winvm-gui-automation` / `winvm-app-operation` | 域内细则层 | 五域各自的领域知识、惯用法与陷阱 |
| `winvm-mcp-reference` | 接入与排障参考 | WinVM MCP 服务部署与接入参考（端点/鉴权/注册验证/常见故障） |

依据文档：本仓 docs/reference/workbuddy-hos-vs-win-panorama.md（开发期参考）。插件内技能名 `winvm-orchestrator` 等以连接器技能面为准。
