# CL-018 · WinVM Bridge 遗留建议逐项完善（增量 PRD）

> 变更标识：`CL-018` ｜ 性质：**增量需求**（CL-017 backlog 逐项收口；不改协议方法名/端点/既有字段语义）
> 作者：许清楚（Product Manager）｜ 来源：CL-017 收口后滞后项 + `qa/evidence/codebuddy-stall-diagnosis.md`
> 范围：6 项（C1–C6）｜ 本文件**只描述需求与验收**，不含实现设计

---

## 1. 变更概述

**一句话**：把 CL-017 收口时记入 backlog 的 6 项遗留建议（A2A 委派停滞根治、短期缓解、服务日志落盘、窗口误列、网络配置冷启动、inventory 去重），逐项转成**可机器验收**的增量需求。

**背景**：WinVM Bridge 是宿主 WorkBuddy 插件（宿主 = 鸿蒙 HarmonyOS NEXT，平台串实报 `openharmony`），用于操作 Windows VM（`172.16.100.2`；VM 内 `C:\WinVMBridge` 部署程序、`C:\WinVMWorkspace` 为工作区）。五域 54 能力（system/app/storage/gui/appops），双通道：MCP 直调 VM `/mcp`（简单任务）/ A2A 经 SSH 隧道调 VM `/a2a`（复杂任务，走 VM 内 LLM Agent）。当前最突出的遗留问题是 **A2A LLM 委派间歇性停滞**（`A2A_DELEGATE_FAILED`），根因已由 `qa/evidence/codebuddy-stall-diagnosis.md` 确诊为 codebuddy CLI 单次 `-p` 冷启动固有开销。

**与 CL-017 的关系**：CL-017（`docs/changes/CL-017/REQUIREMENT.md`）是"真机 E2E 能力巡检缺陷修复"，已修 D1–D31；其 **§7「明确不纳入本变更（backlog）」**（L300–306）显式列出 D19/D20，并由 `.workbuddy/memory/MEMORY.md:77-79` 的 backlog 段记入 4 项（D19、D20、D12 冷启动未达标、inventory 同名重复去重），加上诊断报告「建议处置」①②③ 共形成本变更的 6 项输入。本变更**只做增量**：不改协议方法名/端点/既有字段语义（沿用 CL-017 约束），新增字段一律可选，旧调用方行为不变。

### R2 修订记录（2026-09-20 · 依据架构师真机验证）

> 触发：架构师高见远完成真机验证（`docs/changes/CL-018/TECHNICAL-SOLUTION.md` §1、§2、§9 + `qa/evidence/cl018-*` 24 份原始证据），发现 R1 版 PRD 有 4 处前提与实测不符，按 SOP 回退 PM 澄清。**下列 5 处已按主理人裁决落文**，保留可追溯性。

| # | 位置 | R1（原表述） | **R2（修正后）** | 依据（证据文件） |
|---|---|---|---|---|
| R2-1 | §2 C1「技术前提」+ §5 #1 | "官方文档**不存在** serve/ACP 子命令" | **官方文档页面未列出，但真机 `--help` 实际存在 `--serve`/`--acp`**；主选形态仍为 stream-json（改动面最小），`--acp`/`--serve` 列为后续备选（另开变更评估） | `qa/evidence/cl018-probe-cli.out.txt` L77（`--serve`）、L84-85（`--acp`）；`TECHNICAL-SOLUTION.md` §1.1 证据 C |
| R2-2 | §2 C2 · AC2.1 + 定位 | "默认 `timeoutMs ≥ 150000`（建议 180000）" | 当前部署 A2A 连接器 `timeout` **已是 600000ms（≥150s），出厂默认本来就达标**；诊断里的"60s/90s"是 QA **显式传入** `params.timeoutMs`。→ AC2.1 改为「**新增 env 覆盖能力** `WINVM_A2A_TIMEOUT_MS`（优先级 CLI > env > 默认 600000ms），出厂默认不得回退」；C2 定位由"提上限"改为"**开放可配置能力 + 超时文案改善**" | `TECHNICAL-SOLUTION.md` §0 前提修正 2、§2.C2、§9-2 |
| R2-3 | §2 C6 背景 + AC6.1/6.2 | "真因是 RustDesk 的 **64/32 位**重复注册"；AC6.1 按 `name` 合并；AC6.2 `architectures:["x64","x86"]` | 实测唯一同名重复是 `RustDesk` ×2、**两条同在 HKLM64、同版本**（**同架构**重复登记，非 32/64）；AC6.1 合并键改 **`(name, version)`**；AC6.2 改为 `architectures` **仅在能从 hive/路径推断时填充**（推不出可空/省略）+ 新增 `registryKeyCount` | `qa/evidence/cl018-probe-inventory.out.txt`（raw 20 → 唯一 19）；`cl018-call-mcp.out.txt` L550；`TECHNICAL-SOLUTION.md` §1.4 |
| R2-4 | §2 C4 · AC4.1/AC4.2 | AC4.1"至少含 `ApplicationFrameHost`"（按进程名排除） | 实测 `ApplicationFrameHost` **承载真实 UWP 应用**（窗口标题「设置」= Windows 设置）。→ **AC4.2（不误杀）优先于 AC4.1（排除）**；AC4.1 口径改为**基于「窗口是否具备生产型内容」而非纯进程名黑名单**：排除空标题框架宿主 / 安装器临时标题（`*tmp Setup*`）/ 明确非生产型（实测 `NotifyHelper`）；**保留** `ApplicationFrameHost` 承载的有真实应用标题的窗口 | `qa/evidence/cl018-probe-windows.out.txt`、`cl018-call-mcp.out.txt` L66-143；`TECHNICAL-SOLUTION.md` §1.3 |
| R2-5 | §2 C2 · AC2.4 | "**CLI 是否提供此类 env 属未知**（需验证）；若不存在标记'不适用'" | env **实测存在**（`DISABLE_TELEMETRY`/`DISABLE_AUTOUPDATER`/`CODEBUDDY_DISABLE_PLUGIN_INSTALLS`/`CODEBUDDY_SKIP_BUILTIN_MARKETPLACE`），但 A/B 计时**未观测到冷启动下降**（含 36s 离群，判定为噪声）→ 改标「env 存在但**无实测收益**，**不作为缓解手段**」 | `qa/evidence/cl018-probe-env.out.txt`、`cl018-env-ab*.out.txt`；`TECHNICAL-SOLUTION.md` §1.2 |

**派生一致性修正（因 R2-2/3/4 直接导致原句失真，做最小改动，非新增范围）**：§2 C1 优先级去"条件"限定 → **P0（已具备可行性依据）**；§2 优先级总览同步；§2 C1 AC1.2 阈值引用改为已裁决；§2 C4 用户故事、§2 C6 小节标题随口径同步；§3 性能阈值 C2 行、§4 上游反馈行引用、§6 场景 S7/S16/S17/S19/S21 及 §6 引言随 R2-2/3/4 同步（详见各节）。以上均**不改需求范围**，仅消除自相矛盾。

---

## 2. 需求池

> 每项含 `ID / 名称 / 优先级 / 用户故事 / 验收标准（可机器判定）/ 依赖与风险`

**优先级总览与排序说明**：C1 = **P0（已具备可行性依据）**（见 §5 #1；唯一根治路线）；C2 = **P1**（C1 的过渡缓解）；C3、C5 = **P1**（本变更内"价值高 / 代价低"的两项：C3 解决"故障不可诊断"这一贯穿本变更所有问题的根障碍，C5 是已有量化目标但未达标的性能缺口）；C4、C6 = **P2**（价值中等、代价低的数据语义完善项）。同一优先级内按"用户可感知价值 ÷ 实现代价"降序。

### C1 · codebuddy 常驻会话（根治 A2A 委派停滞）

**优先级**：**P0（已具备可行性依据）** —— 待确认问题 #1（stream-json 单进程多轮）**已经架构师真机验证通过**（单进程 4 轮实测：24492 → 4694 → 1928 → 2129 ms，同 PID、冷启动仅一次；见 `TECHNICAL-SOLUTION.md` §1.1 与 §5 #1），本项为**唯一根治路线**，不再附条件。

**现状与根因（引自 `qa/evidence/codebuddy-stall-diagnosis.md`）**：VM 内 LLM 执行器走 `codebuddy` CLI **单次 `-p` 冷启动**。诊断实测**最简提示词端到端也要 75–107s**（L19–30：SAMPLE_1 106892ms / SAMPLE_2 75880ms），耗时拆解（L50–63）：`[AuthDoInitProbe] afterRestore ≈29.5s` + Agent 端点生命周期 ≈30s + 模型推理仅 ≈9s；VM 为 StratoVirt 6 vCPU 重度限速，单核有效算力约为桌面 **1/6–1/10**（L65–70）。宿主 delegate timeout（60s/90s，实测 180s 仍失败）在 CLI 产出**第一个进度事件之前**就到期 → `A2A_DELEGATE_FAILED`。诊断报告**建议③**（L104–105）：以常驻会话替代每次冷 spawn，把 30s 级启动开销**摊销为一次性**。

**技术前提（R2 修正：以真机 `--help` 为准）**：codebuddy CLI（v2.154.0）官方文档页面（codebuddy.cn/docs/cli/reference）**未列出** serve/ACP，但**真机 `--help` 实测存在 `--serve`（"Start HTTP server (Web UI, REST API, ACP over HTTP SSE)"）与 `--acp`（"communication via stdin/stdout using ndJsonStream"）**（证据 `qa/evidence/cl018-probe-cli.out.txt` L77 / L84-85）；主选形态仍为 **stream-json（改动面最小）**，`--acp`/`--serve` 列为**后续备选**（另开变更评估）。支持的选项包括：`-p/--print`；`--output-format text|json|stream-json`（仅与 `--print` 配合）；`--input-format text|stream-json`（**实时流式输入**，仅与 `--print` 配合）；`-c/--continue`、`-r/--resume [sessionId]`、`--session-id <uuid>`；`--permission-mode bypassPermissions`；`--mcp-config <fileOrString>` + `--strict-mcp-config`；`--add-dir`。官方明确：`-p` 模式下调用需授权工具**必须** `--dangerously-skip-permissions`。
→ 主选形态为 **`-p` + `--input-format stream-json` + `--output-format stream-json` 的长驻子进程 + 固定 `--session-id`**（一次冷启动、多轮投喂）。
**验证依据（反向印证该组合受支持）**：官方 `--replay-user-messages` 的说明为 *"only works with `--input-format=stream-json` and `--output-format=stream-json`"* —— 这是 **stream-json 输入/输出组合被官方直接支持**的证据（`qa/evidence/cl018-probe-cli.out.txt`）。**真机实测**（`TECHNICAL-SOLUTION.md` §1.1：2 轮同 PID 1796、4 轮 24492→4694→1928→2129ms、`alive=true`、`cache_read_input_tokens` 256→79936 递增）**确证"一个进程处理多轮"成立**。

**用户故事**：As a 通过 A2A 发起复杂委派的调用方（Agent / Skill 用户），I want VM 内 codebuddy LLM 执行器以**常驻会话**方式复用（一次冷启动、多轮投喂），so that 第 2 次及以后的委派不再承担 30s 级冷启动开销，委派能在宿主 timeout 内产出首个进度事件并完成，不再出现 `A2A_DELEGATE_FAILED`。

**验收标准（可机器判定）**：
- **AC1.1 冷启动仅一次**：常驻 CLI 子进程在其生命周期内，`AuthDoInitProbe afterRestore` 级别的启动开销**只发生一次**；连续 N≥3 次委派，第 2 次及以后**不再出现**该启动序列（判定：VM 侧 CLI 日志 `AuthDoInitProbe` 计数 + 子进程启动计数 = 1）。
- **AC1.2 首进度事件时延**：常驻会话**已就绪（预热完成）**状态下，单次委派从宿主 `a2a.delegate` 发起到宿主收到**首个进度事件**的时延 —— 阈值 **P50 ≤ 5s、P95 ≤ 15s**（**阈值校准见 §5 #2，已裁决**：真机已就绪态**轮级**端到端实测 P50≈2.1s、P95≈4.7s（n=4，VM 空闲），首进度事件必早于该值 → 本阈值可满足；可行时 P95 可收紧至 ≤10s）。
- **AC1.3 端到端成功率**：连续 10 次委派（含 ≥1 次多步 MCP 能力调用）成功率 **≥ 9/10**，且单次端到端时延 ≤ 宿主 timeout 设定值。
- **AC1.4 会话身份稳定**：常驻子进程使用**固定** `--session-id <uuid>`（或等价会话标识），多次委派复用同一 session，续接语义（`-c/--continue` 或 stream-json 续接）可被真机确认。
- **AC1.5 降级不破功能（硬要求）**：常驻不可用（启动失败 / 进程退出 / 协议不支持）时，**必须**自动回退现有单次 `-p` 冷启动路径，委派结果语义不变 —— **不得因改造导致原可用路径失效**（无功能倒退）。
- **AC1.6 资源约束**：常驻子进程在空闲期内存/句柄占用上限明确（单次冷启动实测 ws 已达 106→290MB，L43–46），且**不持续占用 CPU**；空闲回收策略与"服务重启后会话重建"须可验证（见 AC 对应验收场景 S6）。

**依赖与风险**：
- **依赖（已解除）待确认 #1**：`-p` + `--input-format stream-json` + `--output-format stream-json` 的"一个进程处理多轮"**已经架构师真机验证通过**（`TECHNICAL-SOLUTION.md` §1.1）——原为 P0 定性前提，现成立。
- **风险**：长驻进程内存/句柄占用、空闲回收、服务重启后重建、VM 算力受限下的持续负载。
- **风险（降级路径的时延预期须写清）**：`-c/--resume` 每轮仍 spawn 且**仍付全额 ~22.7s 进程级冷启动**（`--resume` 属**进程**启动开销、非会话级，`TECHNICAL-SOLUTION.md` §1.1 降级路径实测）→ 降级路径**只保证功能不倒退（AC1.5），不提供时延收益**；故必须做「常驻进程」而非「会话续接」。
- **风险**：`-p` 模式授权工具须 `--dangerously-skip-permissions`（官方明确），常驻形态下权限模式须保持一致且安全边界须记录。
- **实现坐标**：`packages/adapter-agent-workbuddy-llm/src/bridge.ts`（`DEFAULT_CLI_ARG_TEMPLATE`、`runGoal()`、PATHEXT 解析 `codebuddy.cmd` → `cmd.exe /d /s /c`、`collectArtifacts`）、`packages/vm-service/src/`。

### C2 · 短期缓解（C1 落地前的过渡）

**优先级**：**P1（过渡缓解）** —— 与 C1 **并列保留**；C1 落地并验证达标后，本项降为**兜底**（保留 env 覆盖能力，出厂默认不回退）。

**定位（R2 修正）**：C2 **不是"把超时上限提上去"** —— 当前部署的 A2A 连接器 `timeout` **已是 600000ms（≥150s），出厂默认本来就达标**（诊断里出现的"60s/90s"是 QA 测试**显式传入** `params.timeoutMs` 的结果，非默认值）。故 C2 的实质是「**开放超时配置能力（env 覆盖）+ 改善超时文案**」。

**与 C1 的关系（必须讲清）**：C2 是 C1 之前/之外可立即生效的**缓解**手段，**不是修复**。诊断报告 L93–99 已明确：**单纯提高上限只是「必要不充分」**——**180s 仍出现 0 进度超时**；裸 CLI 基线 75–107s 仅是「最简提示词」的冷启动地板，真实委派 = CLI 启动（64–107s 实测）+ 大系统提示词 + Agent 多步 MCP 能力调用（每步秒级），总时长天然远超裸基线。→ **本项 PRD 如实表述为「缓解（降低失败率）」，不得给用户虚假承诺「已解决」。**

**用户故事**：As a 运维/集成方，I want 能在不改代码的前提下按需调大（或用 env 覆盖）宿主对该 VM 的 A2A 委派超时、且超时文案说明"可能处于正常冷启动窗口"，so that 间歇性委派有更大机会在冷启动窗口内完成，且失败时我不误判为环境故障。

**验收标准（可机器判定）**：
- **AC2.1 env 覆盖能力（R2 修正）**：新增 **env 覆盖** `WINVM_A2A_TIMEOUT_MS`，优先级 **`--timeout`(CLI) > `WINVM_A2A_TIMEOUT_MS` > 默认 `600000`ms**；使运维可在不重新构建的情况下调整。**出厂默认不得回退**（仍为 600000ms，对齐 `TECHNICAL-SOLUTION.md` §2.C2 / §8）。
- **AC2.2 超时文案**：`A2A_DELEGATE_FAILED`（超时态）的 `message`/`summary` **必须**包含"可能处于正常冷启动窗口（首轮冷启动可达 75–107s）"之类的**可操作说明**，且**不含**"已修复/已解决/彻底解决"等承诺性措辞（grep 断言）。
- **AC2.3 定位标注**：文档/Skill 中本项**显式标注为"缓解"**，并注明 C1 达标后降为兜底（可静态扫描断言关键词"缓解"存在、"修复"不存在于本项描述）。
- **AC2.4（R2 修正）VM 侧 env ——「存在但无实测收益，不作为缓解手段」**：**env 实测存在**（`DISABLE_TELEMETRY`、`DISABLE_AUTOUPDATER`，另有 `CODEBUDDY_DISABLE_PLUGIN_INSTALLS`/`CODEBUDDY_SKIP_BUILTIN_MARKETPLACE` 等，`qa/evidence/cl018-probe-env.out.txt`），但 A/B 计时**未观测到冷启动下降**（顺序实验方向相反；配对交替差异 ≈8–10%，落在轮间噪声范围内，含 1 个 36s 首次冷启动离群，`cl018-env-ab*.out.txt`）。→ **标注「env 存在但无实测收益，不作为缓解手段采纳」**；**不得**虚构收益或呈现为"已缓解"（与 AC2.2 同类红线）。**不标"不适用"**（env 确实存在）。

**依赖与风险**：
- **风险**：窗口过长会**延长"失败反馈时间"**（用户等更久才知失败），须与 C1 的时间预算协调；宿主侧 A2A 委派长挂死已由 CL-017 D28（有界超时）兜底，但窗口变长会放大感知等待。
- **依赖（已裁决）**：env 覆盖落点在宿主 adapter / `install-host.mjs`；env 名 = `WINVM_A2A_TIMEOUT_MS`（见 §5 #3）。
- **非目标**：本项**不承诺**消除 `A2A_DELEGATE_FAILED`（消除由 C1 负责）；**不承诺** env 能带来启动提速（AC2.4）。

### C3 · D19 服务日志落盘

**优先级**：**P1** —— 本变更内「价值最高、代价最低」的一项：本变更涉及的**所有**故障（委派停滞、D27 隧道半死、D31 重生风暴、D15 部署漂移）都因"服务无日志"而**不可诊断**（CL-017 §3 D19，L179；§7 backlog，L304）。

**原始定义（CL-017 L179）**：`服务无日志落盘（ConsoleLogger 写隐藏进程 stdout，丢失）→ 故障不可诊断；建议落 %LOCALAPPDATA%/WinVMBridge/logs/`。
**实现坐标**：`packages/core/src/logger.ts` 的 `ConsoleLogger`（`packages/vm-service/src/server.ts:108` 实例化）；服务由 `start-hidden.ps1` 以 `-WindowStyle Hidden` 拉起 → stdout 丢弃。

**用户故事**：As a 运维/排查人员，I want WinVM Bridge 服务把日志落盘到 `%LOCALAPPDATA%/WinVMBridge/logs/`，so that 服务故障（如 D31 重生风暴、D27 黑洞态、A2A 委派停滞）可在**事后**诊断，而非依赖已丢失的隐藏进程 stdout。

**验收标准（可机器判定）**：
- **AC3.1 路径与命名**：默认日志目录 `%LOCALAPPDATA%/WinVMBridge/logs/`；文件名含日期或轮转序号（如 `winvm-service-YYYY-MM-DD.log`），可被文件系统枚举校验。
- **AC3.2 落盘有效性**：服务以 `start-hidden.ps1 -WindowStyle Hidden`（stdout 被丢弃）拉起时，日志**仍能**写入文件；重启服务后**产生新日志文件且含本次启动条目**。
- **AC3.3 轮转/保留策略**：达到单文件大小上限**或**跨天时轮转；保留策略可配（最多 N 个文件 或 最多 M 天），超限旧文件**自动清理**；验收给出"写满触发轮转 + 最旧文件被删"的可判定条件。
- **AC3.4 级别与 env 可配**：日志级别（debug/info/warn/error）与日志目录可通过环境变量配置；未配置时用默认值。
- **AC3.5 失败降级（硬要求）**：日志目录**不可写**（权限/磁盘满）时，服务**不得启动失败**，须降级（回退 stdout/静默），并**在 `/health` 暴露一个标记**（如 `logging: {degraded: true, reason}`）。
- **AC3.6 脱敏（安全）**：日志**不得**包含 bearer / token / 密码 / 凭据 / 私钥等敏感串；验收：用**含已知 token 的请求**跑一遍，grep 日志确认**0 命中**。

**依赖与风险**：
- **风险**：本 VM 磁盘/CPU 受限，日志写入须异步/缓冲，避免放大 IO；轮转存在多进程/多线程竞态。
- **风险**：脱敏若只做关键词黑名单可能漏 —— 须明确"哪些字段永不入日志"（白名单式字段裁剪）。
- **依赖**：与 C1 常驻会话状态、C5 缓存状态的可观测性可共享同一日志通道（见 §3 可观测性）。

### C4 · D20 `appops.state.query` 误列安装器/框架宿主窗口

**优先级**：**P2** —— 数据语义正确性完善，代价低，用户可感知价值中等（影响 Agent 对"当前运行什么应用"的判断）。

**原始定义（CL-017 §3 L180；§7 backlog L305）**：`appops.state.query 把安装器/框架宿主窗口（...tmp Setup、ApplicationFrameHost）也列为「生产型应用」`。
**实现坐标**：`packages/vm-capabilities/psmod/appops.ps1`（418 行，需自行定位窗口枚举与过滤逻辑）。

**用户故事**：As a 通过 `appops.state.query` 判断"当前有哪些生产型应用在运行"的调用方，I want 只有**具备生产型内容**的窗口被列为生产型应用、安装器临时窗口 / 空标题框架宿主 / 明确非生产型壳进程被排除，so that 我既不把 `*tmp Setup*` 这类**非生产窗口**误当生产应用，也**不会**因为按进程名整类排除而**漏掉** UWP 真实应用（如「设置」）。

**验收标准（可机器判定）**：
- **AC4.1 排除口径（R2 重写：基于「窗口是否具备生产型内容」，非纯进程名黑名单）**：
  - **排除**：① 标题为空的框架宿主窗口；② 安装器临时标题（形如 `*tmp Setup*`）；③ 明确非生产型（实测如 `NotifyHelper`，标题 `ShellMsgGetMessageWindow`）。
  - **保留（必须）**：`ApplicationFrameHost` 承载的、**有真实应用标题**的窗口 —— 实测其窗口标题为「设置」（= Windows 设置），**必须保留**。
  - **判据形式**：由「进程名数组 + 进程名正则 + **窗口标题正则**」共同判定（数据化，可配），**不得**对 `ApplicationFrameHost` 整体按进程名一刀切。
  - `ShellExperienceHost`/`RuntimeBroker`/`TextInputHost`/`SearchHost` 等同族项：**须以 AC4.2 的正例回归为准逐个判定**，**不得整类排除**（实测 `TextInputHost` 标题「Windows 输入体验」可排除，但须逐项给出依据）。实测候选名单见 `qa/evidence/cl018-probe-windows.out.txt` + `TECHNICAL-SOLUTION.md` §1.3。
- **AC4.2 不误杀真实生产型应用（回归硬要求，**优先于 AC4.1**）**：**主理人裁决：AC4.2 优先于 AC4.1** —— 只要 AC4.2 与 AC4.1 冲突，一律以 AC4.2 为准。现有被正确识别的生产型应用（实测正例：`chrome`、`WindowsTerminal`、`WorkBuddy`，以及记事本/Office 等）在过滤后**仍被列出**；`ApplicationFrameHost` 承载的 UWP 真应用窗口（实测「设置」）**必须保留**；验收须给出正例清单 + 逐项判定。
- **AC4.3 可扩展 / 可配**：过滤规则以**数据化清单**（进程名数组 + 进程名正则 + 标题正则数组）实现，可配置（env 或配置文件），**新增模式不需改核心逻辑**；验收：注入一条自定义模式后**生效**。
- **AC4.4 口径说明**：明确"白名单（只列已知生产型）"vs"黑名单（排除已知非生产）"的取舍。**采用「黑名单 + 保留原有生产型判定逻辑」**（`TECHNICAL-SOLUTION.md` §2.C4），避免白名单漏掉长尾应用；且黑名单**不包含** `ApplicationFrameHost`（改由"标题为空/系统名"剔除）。

**依赖与风险**：
- **风险（最需防）**：过度过滤误杀真实应用 —— AC4.2 为回归门禁，且**优先于 AC4.1**。进程名与标题须**分别匹配**（`Doubao_installer` 在进程名、`ShellMsgGetMessageWindow` 在标题，不可混用同一维度）。
- **依赖（已裁决）**：过滤名单口径见 §5 #8（`TECHNICAL-SOLUTION.md` §1.3/§2.C4 已给实测名单与 env：`WINVM_APPOPS_EXCLUDE_PROCS`、`WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS`）。

### C5 · D12 `system.network.config` 冷启动 14183ms

**优先级**：**P1** —— 已有**量化目标（<3s）但未达标**的性能缺口，代价低（进程内缓存），有明确可判定阈值。

**原始定义（CL-017 §2 D12，L153）**：`system.network.config 返回未投影 CIM 对象（CimClass/CimSuperClass 递归），12.5s`；要求：投影为 `[{nextHop, routeMetric}]`、`dnsServers` 去重、**总时长 < 3s**。

> ⚠️ **当前真实状态（2026-09-17 验收，务必采信，勿按"未投影"错误前提）**（`.workbuddy/memory/2026-09-17.md:142`）：**投影本身已修正确（无 `CimClass`/`CimSuperClass` 递归），但冷启动 14183ms / 热态 1178ms → 仅热态达标，冷启动 <3s 未达成**，建议加缓存。**本项不得再按"未投影"写需求。**

**用户故事**：As a 调用 `system.network.config` 的调用方，I want **首次（冷启动）调用**也在合理时限内返回**正确**的网络配置，so that 网络诊断类任务不因单次 ~14s 冷启动而超时或被误判为桥故障。

**验收标准（可机器判定）**：
- **AC5.1 目标口径（必须明确）**：`<3s` 的适用对象。**建议**：**热态**必须 <3s（现已 1178ms 达成，须**保持不回退**）；**冷启动**目标为 <3s（当前 14183ms，gap 明确）。"是否要求首调用也硬性 <3s" 属**待确认 #5**（涉及是否接受"首调用慢 + 后续快"）。
- **AC5.2 冷启动改善**：引入进程内缓存后，冷启动（服务 / ps-bridge 重启后的**首次**调用）时延从 **14183ms** 降至 **≤ 3000ms**（若采纳硬目标）；或（若采纳软目标）降至 **≤ 5000ms** 且**第二次调用 ≤ 1178ms（热态基线不回退）**。
- **AC5.3 缓存失效条件**：明确"网络配置变更后多久必须反映"，给出**可判定规则**：TTL ≤ N 秒（建议 **30–60s**）**或**提供**强制刷新入口**（如 params `refresh:true` 时绕过缓存）；验收：变更配置（或模拟变更）后 **TTL 内返回旧值、超 TTL 返回新值**（或 `refresh:true` 立即返回新值）。
- **AC5.4 陈旧风险边界**：返回陈旧配置的最大窗口 = TTL，须在返回值中（或文档）标注 `cached: true` / 采集时间戳，使调用方可判。
- **AC5.5 载体**：`packages/vm-capabilities/psmod/ps-bridge.ps1` 是**常驻进程**（不可热更，改能力模块须重启服务），为**进程内缓存**提供天然载体；须确认缓存生命周期与 ps-bridge 进程一致（进程重启即失效，符合"冷启动重建"语义）。

**依赖与风险**：
- **风险**：TTL 过长 → 网络变更后诊断误导；过短 → 缓存收益下降（待确认 #6 裁决 TTL 与刷新入口）。
- **风险**：ps-bridge **不可热更** → 本项落地须随服务重启（部署纪律见 §3）。
- **风险**：缓存须保证**正确性不回退**（投影形态、`dnsServers` 去重不得因缓存改造被破坏，见 AC5.1/验收场景 S13）。

### C6 · inventory 同名同版本重复登记未合并

**优先级**：**P2** —— 数据语义完善项；当前输出已与"去重基线"逐名一致，价值在于**合并语义显式化 + 不丢失多登记信息**，代价低。

**背景（R2 修正）**：实测唯一同名重复是 **`RustDesk` ×2**，**两条同在 `HKLM64`、同版本（1.4.9.29722258）**——即**同架构、同 hive 的重复登记**，**不是「32/64 位重复注册」**（证据 `qa/evidence/cl018-probe-inventory.out.txt`：raw 有 DisplayName 行 20 → 唯一 DisplayName 19；插件 `app.inventory.list` 返回 **19**，逐名一致，`cl018-call-mcp.out.txt` L550）。注：CL-017 A8 曾观察"插件 18 / 基线 19"，本变更以更完整的实测基线（20→19）为准。backlog 记法见 `MEMORY.md:78`。
**实现坐标**：`packages/vm-capabilities/psmod/app.ps1`（360 行，需自行定位 `Get-InstalledApps` / `Get-AppInventory` 与注册表遍历）。

**用户故事**：As a 调用 `app.inventory.list` 的调用方，I want 同一 `(name, version)` 的多条注册登记被**合并为一条**、且能看出"该应用有几条注册登记 / 涉及哪些架构"，so that 清单无重复项，同时我仍能区分"同版本多登记"与"同名不同版本共存"。

**验收标准（可机器判定）**：
- **AC6.1 合并键（R2 修正）**：以 **`(DisplayName, DisplayVersion)`** 为合并键 —— 同一 `(name, version)` 的多条注册登记合并为**一条**。**不得**只按 `name` 合并（会误合并"同名不同版本"，见 AC6.3）。
- **AC6.2 多登记的可见性（R2 修正）**：合并后须体现原始登记信息 ——
  - 新增 **`registryKeyCount: number`**（该 `(name,version)` 的原始注册键条数，反映"重复登记"）；
  - 新增 **`architectures: string[]`**，**仅在能从注册表 hive/路径推断时填充**（HKLM32→`x86`、HKLM64→`x64`、HKCU→`unknown`）；**推断不出则可为空/省略**。
  - ⚠ **不得**把 `["x64","x86"]` 当作必然示例 —— 本机 RustDesk 两条**都是 x64**，`x86` 推不出（`TECHNICAL-SOLUTION.md` §1.4）。
- **AC6.3 同名不同版本规则（保留不变，与新区则自洽）**：**同名但不同版本 → 保留两条**（真实共存信息）；**仅合并"同名同版本"的多条登记**。判定依据：`DisplayVersion`（缺失时回退注册表键名）。
- **AC6.4 与独立注册表基线的对齐口径**：验收须与**独立基线**交叉校验（沿用 CL-017 A8/A17 方法论），给出"注册表裸条数 → 合并后条数"的**换算规则**；验收：插件返回集合 = 基线按 `(name,version)` 合并后的集合（**逐 name 一致**，允许多登记字段差异）。本次实测：**raw 20 → 唯一 19，与插件 19 一致**。**不得只断言条数。**
- **AC6.5 实现陷阱（必须固化）**：`app.ps1` 使用 `Sort-Object -Property { $_.key }` **脚本块**形式；**PS 5.1 对 `[ordered]@{}` 用裸键名会静默失效**（CL-017 D21 同族，L120–125）。本项新增的任何排序/去重**必须**用脚本块访问器，并加**静态扫描断言**（对齐 CL-017 A14，L217）。

**依赖与风险**：
- **风险**：合并规则若按 `name` **强去重**，会丢失"同名不同版本"真实共存 —— 故 AC6.1 用 `(name,version)`、AC6.3 保留两条（**已裁决**，见 §5 #7）。
- **风险**：PS 5.1 `[ordered]@{}` 裸键名静默失效陷阱（已明确，须静态扫描门禁）。

---

## 3. 非功能要求

- **性能阈值**
  - C1：常驻就绪后**首进度事件** P50 ≤ 5s、P95 ≤ 15s（待校准）；单次委派端到端 ≤ 宿主 timeout 设定值。
  - C5：**热态 <3s（保持不回退）**；冷启动目标见 AC5.2（硬 ≤3s / 软 ≤5s）。
  - C2：宿主 A2A 委派出厂默认 `600000ms`（**不回退**）；可用 `WINVM_A2A_TIMEOUT_MS` 覆盖（优先级 `--timeout`(CLI) > env > 默认）。
- **兼容性**：**不改协议方法名 / 端点 / 既有字段语义**（沿用 CL-017 约束，L3）；新增字段一律**可选**，旧调用方不传新参数时行为不变；`/health` 增量为纯附加字段（对齐 CL-017 D2 "保持既有字段不变，纯增量"）。
- **可观测性**：C3 日志落盘（含轮转/级别/目录 env）；`/health` 暴露关键状态 —— C1 常驻会话状态（就绪/降级/重建）、C3 日志降级标记、C5 缓存命中与时间戳。
- **安全 / 脱敏**：C3 日志**不得**含 bearer/token/密码/凭据/私钥（AC3.6）；C1 常驻进程的权限模式（`--dangerously-skip-permissions`）与安全边界须在实现文档中记录并受控。
- **资源约束（C1）**：长驻子进程内存/句柄占用上限明确；**空闲期不持续占用 CPU**；空闲回收策略；服务重启后会话重建；须考虑 VM 为 StratoVirt 6 vCPU 重度限速（单核约为桌面 1/6–1/10，诊断报告 L65–70），常驻进程不得与 ps-bridge 争抢导致能力调用抖动。
- **部署纪律**：`psmod/*.ps1` 改动**必须重启服务**（ps-bridge 启动时 dot-source 全部模块、不可热更，CL-017 D15 L168）；改后须做「本地 ↔ VM」**md5 一致**校验（对齐 CL-017 A11/D15）。
- **测试纪律**：单测**必须逐文件** `node --test <file>`，**绝不整批跑**（junction symlink 会打崩共享 runner，MEMORY.md:318 同族纪律）。

---

## 4. 明确不纳入本轮

| ID / 事项 | 说明 | 不纳入理由 |
|---|---|---|
| D27 · 隧道半死时 stdio 桥长挂起 | `ssh -L` 本地监听接受 TCP 但转发到不可达 VM 时永不返回 → 宿主桥"静默挂起"（CL-017 §10，L412–427） | 修复方向（隧道就绪探测 / 缩短 stdio 桥超时预算）**不属本次验证范围**，且需 VM 掉线态专门构造；已记 backlog（CL-017 L427） |
| D29 · `{"path":123}` 过桥层校验直达业务层 | 记录不修（CL-017 §12，L469–484） | 已裁决：与 PS `[string]` 强转语义对齐，"宁可漏报不可误报"；实际后果可控（回 `FILE_NOT_FOUND` 可路由） |
| D31 · ps-bridge 重生风暴致 vm-service 监听消失 | 记录不修（CL-017 §13，L488–492） | 复现条件复杂（强杀时机 × 委派负载并发），需专门复现实验定位因果链后再修 |
| 原 CL-017 #13 · 修陈旧断言 | 已撤销（CL-017 §7 L306、§7.1 L308–320） | **前提已被主理人证伪**：全仓无 `-Wait` 断言、该测试 8/8 通过；"279/280"为整批运行假红 |
| 上游 CLI 侧改动（向 codebuddy 反馈 `AuthDoInitProbe`/插件管线启动开销） | 诊断报告**建议②**（L100–103） | **非本仓库可控**，须提上游；本变更**不再以 VM 侧 env 缓解替代**（AC2.4 实测 env 存在但**无实测收益**）；启动开销的根治由 C1 常驻会话承担 |
| 竞品分析 / 市场定位象限图 | —— | 本变更为**增量 PRD**，不需要（主理人明确） |

> 注：本变更 **不扩围**。以上条目若后续要修，须**另开变更**（与 CL-017 §7 backlog 的处置约定一致）。

---

## 5. 待确认问题（R2：均已裁决）

> **状态：#1–#10 已全部由架构师真机验证或主理人裁决**（依据 `docs/changes/CL-018/TECHNICAL-SOLUTION.md` §1/§2/§9 与 `qa/evidence/cl018-*` 原始证据）。下表保留原问题以供追溯，并附**裁决结论**。若实现中暴露新问题，**另起**条目。

| # | 关联 | 原问题（R1） | **裁决结论（R2 · 已裁决）** | 依据 |
|---|---|---|---|---|
| **1** | **C1（第 1 号）** | `-p` + `--input-format stream-json` + `--output-format stream-json` 是否支持"一个进程处理多轮"？ | ✅ **可行（FEASIBLE）**。真机确证单进程多轮：**4 轮 24492 → 4694 → 1928 → 2129 ms，同 PID 1796、冷启动仅一次**（`alive=true`，`exitCode=0`）。→ **C1 维持 P0**，主选 stream-json。另：真机 `--help` **确有 `--serve`/`--acp`**（非官方文档所列），列为后续备选（另开变更） | `TECHNICAL-SOLUTION.md` §1.1；`cl018-multiturn-n.raw.log`、`cl018-probe-cli.out.txt` |
| 2 | C1 | 会话生命周期归属/崩溃恢复/空闲回收；AC1.2 阈值校准 | ✅ **vm-service 持有**（非独立守护）→ 服务停即回收；空闲 TTL **300000ms**（`WINVM_LLM_SESSION_IDLE_MS`）；崩溃重建≤1；**阈值校准：已就绪态轮级 P50≈2.1s、P95≈4.7s（n=4，VM 空闲）→ AC1.2（P50≤5s/P95≤15s）可满足**，可行时 P95 收紧至 ≤10s | `TECHNICAL-SOLUTION.md` §2.C1、§1.1 |
| 3 | C2 | `timeoutMs` 配置落点与 env 名（是否已有该 env？） | ✅ 现状**已是 600000ms**（≥150s，出厂达标）；**新增 env 覆盖 `WINVM_A2A_TIMEOUT_MS`**，优先级 `--timeout`(CLI) > env > 默认 600000。→ AC2.1 已按此重写 | `TECHNICAL-SOLUTION.md` §2.C2、§8 |
| 4 | C2 | CLI 是否提供关闭遥测/插件自动更新的 env？ | ✅ env **存在**（`DISABLE_TELEMETRY`/`DISABLE_AUTOUPDATER`/`CODEBUDDY_DISABLE_PLUGIN_INSTALLS`/`CODEBUDDY_SKIP_BUILTIN_MARKETPLACE`…），但 A/B **未观测到冷启动下降**（含 36s 离群，判定噪声）→ **「存在但无实测收益，不作为缓解手段」，不标"不适用"** | `TECHNICAL-SOLUTION.md` §1.2；`cl018-probe-env.out.txt`、`cl018-env-ab*.out.txt` |
| 5 | C5 | `<3s` 是否硬性要求**首调用（冷启动）**也达标？ | ✅ 采纳**软目标 + 启动预热**：热态**硬 <3s**（现 ~1s，保持）；冷启动经**服务启动预热**达 **≤3000ms**；预热失败（真冷）保底 **≤5000ms** | `TECHNICAL-SOLUTION.md` §2.C5、§9-5 |
| 6 | C5 | 网络配置陈旧窗口（TTL）与强制刷新入口？ | ✅ TTL **45000ms**（`WINVM_NETCFG_TTL_MS`）+ 入参 **`refresh:true`** 绕过缓存 | `TECHNICAL-SOLUTION.md` §2.C5、§8 |
| 7 | C6 | 多架构字段形态？同名不同版本裁决？ | ✅ 字段 **`architectures: string[]`**（仅 hive 可推断时填充）+ **`registryKeyCount: number`**；**同名不同版本 → 保留两条** | `TECHNICAL-SOLUTION.md` §1.4、§2.C6 |
| 8 | C4 | 过滤名单权威口径 / 白黑名单 / 可配？ | ✅ 名单**已实测**（§1.3）；**`ApplicationFrameHost` 不得整类排除**（AC4.2 优先于 AC4.1）；黑名单口径 + env `WINVM_APPOPS_EXCLUDE_PROCS`/`WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS` | `TECHNICAL-SOLUTION.md` §1.3、§2.C4 |
| 9 | C3 | 日志轮转/保留默认值与级别？ | ✅ 单文件 **10MB** / 按天 / 保留 **7 文件** / **14 天** / 级别 **info**（均 env 可配） | `TECHNICAL-SOLUTION.md` §2.C3、§8 |
| 10 | C1+C2 | C1 达标后是否仍需 C2 双轨？首次预热与 timeout 关系？ | ✅ **C2 双轨保留**（C2 降为兜底：保留 env 覆盖，默认 600000 **不回退**）；**会话冷启动后的第一次委派仍建议走 C2 长超时预算**（首次预热 ≈16–25s） | `TECHNICAL-SOLUTION.md` §9-9 |

---

## 6. 验收场景清单

> 供 QA 直接转测试用例。每条给出「前置 / 步骤 / 期望（含数值阈值）」。C1 场景前提（待确认 #1）已由架构师真机验证通过。

| # | 对应 | 场景 | 前置 | 步骤 | 期望（可判定） |
|---|---|---|---|---|---|
| S1 | C1 · AC1.1 | 常驻会话冷启动仅一次 | 常驻会话已实现且预热完成 | 连续发起 3 次委派 | 仅第 1 次出现 `AuthDoInitProbe afterRestore` 级启动序列；后 2 次无；子进程启动计数 = 1（VM CLI 日志佐证） |
| S2 | C1 · AC1.2 | 首进度事件时延 | 会话就绪（预热完成） | 完成 ≥10 次委派，逐次测"发起 → 首个进度事件" | P50 ≤ 5s、P95 ≤ 15s（阈值以真机基线校准；**待确认 #2**） |
| S3 | C1 · AC1.3 | 端到端成功率 | 会话就绪 | 连续 10 次委派，含 ≥1 次多步 MCP 能力调用 | 成功 ≥ 9/10；单次端到端 ≤ 宿主 timeout |
| S4 | C1 · AC1.4 | 会话身份稳定 | 会话就绪 | 多次委派并抓 CLI 进程命令行 / 会话日志 | 复用同一 `--session-id`（或等价会话标识）；续接语义被真机确认 |
| S5 | C1 · AC1.5 | **降级不破功能** | 会话就绪 | 杀掉常驻进程 / 模拟 stream-json 不支持后发起委派 | **自动回退单次 `-p` 路径**，委派结果语义不变，无功能倒退；`summary` 标注已降级 |
| S6 | C1 · AC1.6 | 资源约束 | 会话就绪并空闲 ≥ T | 采样进程内存/句柄/CPU | 空闲期 CPU 占用 ≈0；内存/句柄在上限内；空闲 T 后被回收；服务重启后会话重建 |
| S7 | C2 · AC2.1 | 超时默认 + env 覆盖 | 宿主配置可读 | ① 读默认值；② 未设 env 时的默认；③ 设 `WINVM_A2A_TIMEOUT_MS` 后重读 | 出厂默认 = `600000ms`（**不回退**）；env 覆盖生效；优先级 `--timeout`(CLI) > env > 默认 |
| S8 | C2 · AC2.2 | 超时文案 | 制造一次委派超时 | 触发 `A2A_DELEGATE_FAILED`（超时） | message/summary 含"可能处于正常冷启动窗口（75–107s）"类提示；**grep 无"已修复/已解决"承诺措辞** |
| S9 | C3 · AC3.2 | 日志落盘有效性 | 服务以 `start-hidden.ps1 -WindowStyle Hidden` 拉起 | 重启服务后枚举日志目录 | 产生新日志文件且含本次启动条目 |
| S10 | C3 · AC3.3 | 轮转 / 保留 | 日志目录可写 | 写满触发轮转 | 新文件产生、最旧文件被删（符合保留策略） |
| S11 | C3 · AC3.5 | **目录不可写降级** | 将日志目录设为不可写 | 启动服务 | 服务**仍成功启动**；`/health` 暴露 `logging.degraded=true` |
| S12 | C3 · AC3.6 | **脱敏** | 服务运行 + 日志落盘 | 用**含已知 token** 的请求调用后 grep 日志 | 敏感串 **0 命中** |
| S13 | C5 · AC5.2 | 冷启动时延 | 重启服务（清缓存） | 首次调用 → 第二次调用，各计时 | 首次 ≤ 3000ms（硬目标）或 ≤5000ms（软目标）；第二次 ≤ 1178ms（热态不回退） |
| S14 | C5 · AC5.3 | 缓存失效 | 缓存已填充 | 变更网络配置（或模拟）后：TTL 内调用 / 超 TTL 调用 /（若有）`refresh:true` 调用 | TTL 内返回旧值；超 TTL 返回新值；`refresh:true` 立即返回新值 |
| S15 | C5 · AC5.1 | **投影正确性回归** | 服务运行 | 冷/热各调一次 | 无 `CimClass`/`CimSuperClass` 递归；routes 投影 `[{nextHop, routeMetric}]`；`dnsServers` 去重；`cached`/时间戳可判 |
| S16 | C4 · AC4.1 | 排除非生产窗口（按内容，**非按进程名**） | 构造/触发：安装器临时窗口、空标题框架宿主、`NotifyHelper` 类非生产项 | 调用 `appops.state.query` | 结果**不含**安装器临时标题窗口（`*tmp Setup*`）、空标题框架宿主、明确非生产型项 |
| S17 | C4 · AC4.2 | **不误杀回归（优先于 AC4.1）** | 打开实测正例：`chrome`/`WindowsTerminal`/`WorkBuddy`/记事本/Office；并触发 `ApplicationFrameHost` 承载的「设置」 | 调用 `appops.state.query` | 正例应用**仍被列出**（逐项判定全通过）；**`ApplicationFrameHost` 的「设置」窗口必须保留**（不得按进程名排除） |
| S18 | C4 · AC4.3 | 过滤可配 | 可编辑过滤清单 | 注入 1 条自定义模式后调用 | 生效（对应窗口被排除） |
| S19 | C6 · AC6.1/6.2 | 同名同版本多登记合并 | 存在同名同版本重复登记（如 `RustDesk` ×2 @HKLM64） | 调用 `app.inventory.list` | 合并为**一条**，附 `registryKeyCount=2`；`architectures` 由 hive 推断（本机两条同 `x64`；推断不出时可空） |
| S20 | C6 · AC6.3 | 同名不同版本 | 构造同名不同版本 | 调用 `app.inventory.list` | 按裁决规则返回（建议**保留两条**） |
| S21 | C6 · AC6.4 | **基线对齐** | 可读注册表基线 | 插件返回 vs 独立基线按 `(name,version)` 合并规则换算 | 插件返回集合 = 基线合并后集合（**逐 name 一致**，允许多登记字段差异）；本次实测 raw 20 → 19 ≡ 插件 19 |
| S22 | C6 · AC6.5 | **陷阱静态扫描** | 源码可读 | 扫描 `app.ps1` | 不存在对 `[ordered]@{}` 直接 `Sort-Object -Property <裸键名>` 的写法（对齐 CL-017 A14） |

> **通用纪律（供 QA 沿用）**：① 声明"已修"必须附**真机原始返回**（正例 + 边界例），代码位置不算行为证据（CL-017 §8 补记，L352）；② 与"独立基线"交叉校验，不得只信插件自报 `ok`（CL-017 A8/A17）；③ 每条证据标注"本轮取数/上轮遗留"及环境前提（CL-017 §10 补记，L446）。
