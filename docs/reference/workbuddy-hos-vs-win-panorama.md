# WorkBuddy 平台能力全景对比：鸿蒙（HarmonyOS NEXT） vs Windows

> **文档代号**：`ref:hos-vs-win-panorama` ｜ 日期：2026-10-22 ｜ 维护：WinVM Bridge 项目
> **目的**：从「操作系统能力 → 应用生态能力 → WorkBuddy 在该系统上的操作管理能力」三层递进，全面对比鸿蒙与 Windows 两个平台上 WorkBuddy 的能力异同，为 `hos-win-skill`（任务分派指引）提供依据。
> **前置文档**：`workbuddy-hmos-vs-windows.md`（部署适配视角，本文不重复其安装/目录/连接器注册细节）。

---

## 1. 结论先行

1. **WorkBuddy 应用层同宗**：两平台均为 Electron 桌面 AI Agent，任务规划、专家/技能/连接器/定时任务/资料库等应用能力**一致**，数据根均为 `~/.workbuddy/`。
2. **系统能力天差地别**：鸿蒙 NEXT 对普通 App 施加**内核级强沙箱**（每 App 独立挂载命名空间 + HMMAC，无 root），只能管理「自己沙箱内 + 共享存储 `$HOME`」；Windows 侧 WB 以**用户态进程**运行，可 spawn PowerShell、改注册表、管理服务/进程/计划任务、GUI 自动化——这就是 WinVM Bridge 54 能力得以存在的根基。
3. **鸿蒙 WB 的系统操作天花板 = hish-bridge / 共享存储**；**越过天花板的系统级、应用级操作应经 winvm-a2a 通道委托 Windows VM 内的 WorkBuddy（codebuddy CLI）执行**。

---

## 2. 第一层：操作系统能力对比

| 维度 | HarmonyOS NEXT（鸿蒙 PC） | Windows 11 |
|---|---|---|
| 安全模型 | 每 App 强沙箱：独立挂载命名空间 + HMMAC；UID 隔离（WB uid 20020171）；**无 root/管理员概念**，沙箱不豁免 | 用户态 + ACL + UAC 提权；管理员账户下进程可直达 HKLM/服务/计划任务 |
| 应用间隔离 | **物理隔离**：即使知道对方沙箱路径也 ENOENT/权限拒绝；跨 App 数据流必须走 URI 授权/Picker/安全控件 | 同账户进程共享 OS 命名空间；可遍历 `C:\`、跨进程窗口消息、COM 自动化 |
| 文件系统视图 | 仅：本 App 沙箱（el2/base/...）、共享存储 hmdfs（`/storage/Users/currentUser` ≈ 449GB 持久区）、少量系统只读挂载；`/data`、其它 App 目录**不可见** | 全盘可见（受 ACL 约束）；NTFS 任意读写（用户权限内） |
| Shell/脚本 | 类 Linux shell（bash/sh），**无 PowerShell/cmd**；`/tmp` 只读；git/node 等需专用路径 | PowerShell 5.1/7 + cmd + PATHEXT；计划任务、服务、注册表、WMI/CIM |
| 进程管理 | 仅能管理自己 App 树内进程；跨 App `kill -0` 仅得 EACCES/ESRCH 语义 | 可列举/终止任意用户态进程树（含他人子进程）；服务 SCM 全控 |
| GUI 自动化 | 无法触达其它 App 的窗口/UI（沙箱隔离；系统合成输入接口不对普通 App 开放） | UIA 树遍历、合成鼠标键盘、截屏、剪贴板、窗口管理全可用（交互式会话内） |
| 网络 | 应用级网络栈隔离；出站受系统管控；无系统 ssh（隧道须进程内 ssh2） | 系统网络栈 + OpenSSH 9.5 服务端/客户端；防火墙策略化 |
| 后台/保活 | suspend manager 冻结后台 App、回收临时权限；长时任务须 KEEP_BACKGROUND_RUNNING+常驻通知 | 后台进程自由驻留；计划任务 RestartOnFailure 自愈 |
| 包管理 | 只有华为应用市场（AppGallery）；CLI 无包管理器；系统预装应用不可卸载 | winget 全量 CLI 包管理（search/install/uninstall/upgrade）；MSIX/MSI/NSIS 生态 |
| 典型报错语义 | ENOENT（路径不在命名空间）、EACCES（属主是别的 uid）、Permission denied（HMMAC） | Access Denied（ACL/UAC）、0x8A150002（winget 参数）等 |

**要点**：鸿蒙的隔离是「**不给能力**」而非「**要授权**」——大量系统/应用管理动作对普通 App 根本不存在 API 入口；Windows 的限制是「**要权限**」——动作存在，够权限即可执行。

---

## 3. 第二层：应用生态与应用管理能力对比

| 能力 | 鸿蒙系统及应用体系 | Windows 系统及应用体系 |
|---|---|---|
| 应用清单/盘点 | 系统**禁止普通 App 读取已安装应用列表**（NEXT 阉割该权限）；只能看到自己 | 注册表卸载键 + UWP 包清单全量可查（54 能力 `app.inventory.list`） |
| 应用安装 | 仅应用市场（企业/开发者签名渠道另计） | winget/MSI/EXE 任意来源（`app.winget.install`） |
| 应用卸载/升级 | 用户手动或市场；预装应用禁卸 | winget 卸载+事后核验、NSIS 静默回退（`app.winget.uninstall/upgrade`） |
| 应用启动/自动化 | 仅能拉起自己 App 的 ability；后台 startAbility 被系统拦截 | 任意 exe 启动（`app.process.launch`）、COM/UIA 驱动第三方应用 |
| 应用操作自动化(appops) | 无对应系统面 | `appops.*`：CLI 调用、COM 自动化、GUI 产出、状态查询、工作流编排 |
| 系统设置管理 | 系统设置仅系统 App/受限入口可写；普通 App 只能引导用户跳转 | 注册表读写（HKLM/HKCU 限根键）+ 环境变量 + 服务配置直达 |
| 存储/磁盘管理 | 共享存储内文件操作可用；磁盘/分区层不可达 | 磁盘清单、空间分析、清理分析、归档、回收站、链接（`storage.*` 13 项） |
| GUI/窗口 | 不可跨 App | 截屏/分析/UIA/键鼠/剪贴板/窗口列表与控制/条件等待（`gui.*` 11 项） |

**要点**：第二层的差异完全由第一层决定——鸿蒙应用体系对第三方是「黑盒 + 市场white-list」，Windows 应用体系对用户态进程是「白盒 + 全 API 面」。

---

## 4. 第三层：WorkBuddy 在两系统上的操作管理能力对比

### 4.1 WorkBuddy 自身能力（两平台一致）

- 自然语言任务规划与多步执行；多任务并行
- 专家/技能/连接器（MCP：stdio、streamableHttp、sse、http 四种 transport 实测均支持）/定时任务（automation_update；鸿蒙最小粒度 HOURLY）
- 资料库/文档表格 PPT 生成、Ardot 设计创意、Teams 协作、记忆系统
- 本地文件操作（授权后）；数据根 `~/.workbuddy/` 模型一致
- 多端协同：移动端（iOS/Android/鸿蒙/小程序）远程控制**桌面端**（发令/续聊/停止/审批），执行始终在桌面端

### 4.2 WorkBuddy 对操作系统的操作管理能力（关键差异面）

| 操作管理域 | 鸿蒙 WB 实际可达 | Windows WB 实际可达（含本项目 54 能力承载） |
|---|---|---|
| 文件/文档 | ✅ `$HOME`(hmdfs) 全量读写 + 本沙箱；⚠ 其它 App 沙箱不可达 | ✅ 全盘（用户权限内）；含删除(回收站)/移动/复制/搜索/归档/链接/清理分析 |
| 应用管理 | ❌ 盘点/安装/卸载/升级均无系统入口 | ✅ winget 四件套 + 应用清单 + 快捷方式 + appx |
| 系统管理 | ❌ 服务/进程/注册表/计划任务/电源/用户/事件日志/环境变量均不可达 | ✅ `system.*` 14 项全承载（服务控制/进程终止/注册表读写/计划任务查询/电源 L3/事件日志等） |
| GUI 自动化 | ❌ 无法触达其它 App 窗口 | ✅ `gui.*` 11 项（交互式会话内；锁屏态受 Windows 安全边界限制，不可代码解锁） |
| 网络/隧道 | ✅ 但无系统 ssh → 进程内 ssh2；出站 TCP 实测可用 | ✅ OpenSSH 双向可用 |
| 跨 App 数据 | ⚠ 仅 `$HOME` 共享通道；URI 授权机制不对 CLI 开放 | ✅ 无限制 |
| 写路径约束 | ⚠ `settings.json sandbox.extraAllowWrite` 白名单（需把 winvm 路径加入） | ✅ 用户目录默认可写 |
| 定时任务 | ✅ automation 最小粒度 HOURLY | ✅ 同 WB 能力 + 系统计划任务兜底 |

### 4.3 两边都做不到的（诚实边界）

- 鸿蒙侧：系统级管理（其它 App、系统设置写入、root 级操作）——**OS 不给入口，WB 无解**。
- Windows 侧：锁屏态 GUI 合成输入（Winlogon 安全桌面边界）；MSIX App Execution Alias 的非交互 winget 操作（实测拒绝访问，需桌面会话）。

---

## 5. 差异对 WinVM Bridge 的意义（承接 hos-win-skill）

1. 鸿蒙 WB 是「**强应用能力、弱系统触达**」的宿主：文档/分析/创作/网络信息/定时编排等留在鸿蒙本地完成。
2. 一切需要**系统面/应用面/跨 App/GUI** 的操作，唯一通路 = winvm 隧道（MCP 直调 `/mcp` 或 A2A `/a2a`）→ Windows VM 内 WB（codebuddy CLI）。
3. 风险分级与审批：L0/L1 直调；**L2/L3 经 MCP 直调一律 `DELEGATION_REQUIRED`**（缺省策略 on，直调通道不审批）→ 必须转 A2A 委派出审批卡；L3（电源类）A2A 通道内仍须 dryRun 先行。5 条 supportsDryRun 免审批全集：power.control / file.delete / winget.install / winget.uninstall / winget.upgrade。通道选择纪律见 `~/.workbuddy/skills/hos-win-skill/SKILL.md`。

分派规则正文见插件技能 `hos-win-skill`（仓内 `skills/hos-win-skill/SKILL.md`，宿主侧用户级副件同源）。

---

## 附：信息来源

- 本仓实测：`docs/reference/workbuddy-hmos-vs-windows.md`（SSH 实测附录 B）、`packages/vm-capabilities/src/registry/definitions.ts`（54 能力权威定义）、项目 MEMORY.md（真机红线）
- 官方：workbuddy.cn（平台覆盖：Windows/macOS/鸿蒙 PC/Linux 桌面端；iOS/Android/鸿蒙/小程序移动端）、多端协同文档、codebuddy.cn Overview
- 系统：HarmonyOS NEXT 安全技术白皮书、华为开发者社区沙箱/权限机制文档、Netwrix/Position-everything Windows Agent OS 分析
