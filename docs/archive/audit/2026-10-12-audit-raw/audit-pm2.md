# WinVM Bridge 产品功能完备性审计（PM 视角）· 续 §2–§7

- 审计人：许清楚（Product Manager / software-product-manager-2，接力棒）
- 日期：2026-10-12（接力开工 20:18，前棒 §1 落盘 mtime 基线 19:52:41）
- 基线：HEAD `13b8705`（Phase 2 收官，92 files / 1889 例）
- 前棒产出（**直接采信、不重验**）：`audit-pm.md` §1 能力矩阵——54/54 registered+impl+tests 齐；缺口=4 条「已实现待挂载」、4 类 V2 实缺（recycle-clear / browser CDP / update / default）、7 个 SKILL.md 未声明 `meta.capability.list`、`app.shortcut.manage` 文档落后实现。
- 并发保险：全程只读 REPO；本报告只写本文件；每次落盘前核对 `audit-pm.md` mtime，开工至今未见新写入（见 timeline）。
- 方法：逐条结论附文件路径/段标签；无证据处显式写「未找到证据」。

---

## ② 双通道功能对等性（MCP 直调 vs A2A 委派）

判据框架：**审批、取消、进度回流、审计**四件事在两通道的口径是否一致；找出「一条路径能做、另一条不能做」的功能差。

### 2.1 四件事逐条对照

| 维度 | MCP 直调（连接器 `winvm`，54 工具） | A2A 委派（连接器 `winvm-a2a`，`a2a.delegate`） | 对等判定 |
|---|---|---|---|
| **拦截语义** | `policy.evaluate` 未批 → 结构化 `ok:false` + `APPROVAL_REQUIRED` + `approval{approvalId,risk,capabilityId,preview,impact,resumeHint}`，`isError:false`（server.ts:1290-1310） | VM 内 Agent 回连 `/mcp?dtid=` 撞同一闸 → provider `maybeResume` 提取 `details.approvalId` → `coordinator.raise(req)` → Task 置 `input-required`，宿主 `extractApproval` 还原 `approval`（tools.ts:331 区） | ✅ **同一闸、同一 payload**。CL-016 已抹平信息不对称（REQUIREMENT.md:100「用户不需要知道这次是直调还是委派」），CL-021 卡片模板收口（QA-REPORT §2a/R1-8/R1-10）。这是双通道最成熟的一块 |
| **批准入口（放行机制）** | 令牌注册恒 `hostApproved:false`（server.ts:1250）；续跑要求同参 + `__approvalId` 重发并校验 `hostApproved===true`（:1227）。全仓 `hostApproved=true` **唯一**写入点 = `VmApprovalCoordinator.raise` 的批准分支（:424），而 `raise` 唯一生产调用点 = LLM bridge `maybeResume`（bridge.ts:1232） | `a2a.approval.reply` → `client.replyApproval` → A2A `resolveApproval(true)`（server.ts:301）→ 唤醒 `waitApproval` → `raise` 置 `hostApproved=true` → **K5 服务端确定性重放** | ⚠️ **名实差（P0 级，见 2.2-①）**：文档/SKILL 宣称 MCP 直调可「以 `__approvalId` 重发放行」（SECURITY-GOVERNANCE §3.3、mcp-reference SKILL:212、`resumeHint` 文案「确认后以 __approvalId 重发同一请求」），但**没有任何生产代码路径会把该令牌置为 `hostApproved=true`**——置 true 只发生在 A2A 委派回合的 `raise`；纯直调请求无 `activeTaskId`/无委派回合 → `raise` 走 `no-active-task` 早退（server.ts:368-378 区）。测试侧也无直调批准闭环用例（grep `hostApproved.*true` 在 tests 仅命中 O-10 清扫/在途保护与源码字符串断言）→ **直调 L2/L3 在纯宿主路径上「有闸无解」** |
| **取消** | 只有「传输层断连」语义：`watchClientDisconnect` → `disconnect.signal` → ARCH-29 执行侧同型闸（派发前已断连 → 零副作用收口；provider index.ts:280-288）。**没有面向用户的显式 cancel 工具**（未找到 `cancel` 类 MCP 工具，54 能力表内亦无） | `a2a.task.cancel` → `tasks/cancel` → `requestCancel`（先 `abort('canceled')` 后落 canceled，顺序纪律 O-1，task-store.ts:115-120）→ 协作式取消；`cancelObserved` 如实位（已终态任务 cancel 返 `false`+「取消未生效」文案）；两态呈现 `executedBeforeCancel{steps,artifacts}`（HOST-A2A-BRIDGE §4.5 表） | ⚠️ **单向缺**：委派可显式取消并向用户交代「取消前已有 N 操作/M 产物」；直调只能靠宿主断连，用户说「停」时 MCP 通道**无可调用的停止动作**，长耗时能力（winget 安装/upgrade 等）体验缺口。SECURITY-GOVERNANCE §2.2.1「两通道取消口径（P2-T4 接通）」实际接通的是**委派通道 + 直调的断连侧**，两通道**能力不对称** |
| **进度回流** | 无进度面：单次工具调用 = 请求/响应，`timeoutMs` 到点返 `TIMEOUT`（retryable:true，errors.ts:65 区）。长任务只能用户干等 | `progress[]` 累积（status-update working）；P2-T12 修复后确定性路径实时进度**恢复可见**（此前 wire 裸字符串 → 宿主 `extractText` 恒空，HOST-A2A-BRIDGE §4.3.1）；超时 `timedOut:true` + `taskId` 可 `a2a.task.get` 续取 | ⚠️ **不对称**：委派有「有态进度 + 超时可续取」；直调有「超时可重试但无进度、无续取句柄」。对用户的后果：同一件慢活，走委派能看到在干什么、超时还能捞回；走直调既盲等、超时即丢上下文 |
| **审计** | `executed` / `policy-denied` / `blocked:approval-required` 三类均落链（server.ts:1259-1290 blocked 补记为 K5 收口；S-4 硬拒绝入链）；`channel:'mcp'` | 同一条 `executeCapability` → provider 审计；委派内层回连带 `ext.delegationId` 精确归因（K-N1 通道2）；`delegation.complete` 另带 `ext.approvalTruth{decidedBy,gate,...}` 可观测（K5 §7 G-b） | ✅ **口径一致且委派更富**（多 delegation 归因 + 真值判定归因链）。共同缺口：**审计链无对外查询面**——`definitions.ts` 内除 `audit:{snapshot}` 元数据外零命中，54 能力与 `a2a.*` 工具面都**没有任何「查审计」工具**；`host-a2a-bridge/approval-audit.ts` 只写宿主本地留痕。用户/合规想回溯「谁批准了什么」得去 VM 里翻链文件 |

### 2.2 「一条能做、另一条不能做」的功能差清单（按对承诺的伤害排序）

1. **① 直调审批只能挂起、不能放行（P0，安全语义名实差）**——后果双向都糟：
   - 可用性：用户经 MCP 直调触发 L2/L3（如 `storage.file.delete` permanent、`system.registry.write`）→ 拿到 `APPROVAL_REQUIRED` + `resumeHint`，按文案重发 `__approvalId` **仍返回需审批**（`hostApproved` 恒 false），Agent 容易在此死循环或误报「已批准」。
   - 安全性反向：文档口径暗示存在「重发即放行」通道，任何未来接线若把 `hostApproved` 置 true 点放宽，就会绕过审批卡片体系（K5 §4 安全纪律 2 正是为此而设的严格闸）。
   - 定性：属 K5 设计 §6「不碰 MCP 直调通道行为」的**遗留面**，P2-T8 只扩了「真值反查覆盖面」、**没扩「批准入口」**。三条出路（择一即可，成本从低到高）：(a) 诚实化——`resumeHint` 改为「请改走 A2A 委派完成审批，或由人工执行」，SKILL §212 行删除；(b) 产品化——`__approvalId` 续跑配套一个受策略保护的「宿主确认」入口（等价 `approval.reply` 的 MCP 侧形态）；(c) 策略化——把纯直调会命中的 L2/L3 能力在 MCP 面降级为「必须委派」（风险上限 `maxRisk` 由调用方参数 → **服务端事实**，消除 K5 §1 与 SKILL:212 已点名的「自报参数=安全边界」信任错位）。
2. **② 直调无显式取消（P1）**——见 2.1 取消行。
3. **③ 直调无进度/续取句柄（P1）**——见 2.1 进度行。`a2a.task.get` 形态在直调面不存在（`traceId` 虽返回，但无查询工具）。
4. **④ 两通道共缺审计查询面（P1）**——见 2.1 审计行。
5. **⑤ 委派独有能力面收窄（P2，设计如此）**：直调 54 能力 vs 委派 5 工具（`a2a.delegate/task.get/approval.reply/task.cancel/health`）。委派的价值是多步编排，不构成缺口；但**委派的 `allowedCapabilities` / `maxRisk` 由调用方自报**（HOST-A2A-BRIDGE §4.2「最小权限」表述与实现语义有差：实现是「Agent 自报参数」而非服务端强制）→ 与 ①(c) 同根，建议合并处置。
6. **⑥ GUI/生产活动路径不对称（P2）**：直调可逐条调 `gui.*`（最高 L1，不出卡片，SKILL gui-automation:139）；委派强 GUI 走 VM 内 Agent。两侧都能做，但**同一件 GUI 任务的产物形态不同**（直调返结构化、委派产 artifacts），宿主侧对「产物预览/下载」的统一呈现未见规范（未找到证据：docs/02-design 与 skills 无 artifacts 呈现规范条目）。

### 2.3 本节结论

两通道在**审批信息完整性**上已做到真对等（CL-016/021 的成绩，值得点名），但在**审批放行入口、取消、进度**三件事上是「委派强、直调弱」的单向不对称，且审批入口存在文档—代码名实差（P0）；审计口径一致但共同缺一块对外查询面。

- 心跳：§2 落盘 20:26。

---

## ⑧ §5 独立扫 · UX 缺口（前棒转派任务 1 · 22:30 落盘）

> 范围纪律：只收「前棒 §5（UX-1..9）未覆盖或覆盖但未实证」的增量；与前棒同结论处标注【互证】，推翻处标注【勘误】。

### 8.1 错误码对账（三层账，逐码核毕）

| 层 | 实际码数 | 位置 | 与契约差 |
|---|---|---|---|
| 契约 `BridgeErrorCode` | **11** | contracts/src/errors.ts:16-36（ARCH-18/22 追加 `TASK_CANCELED`；DEFAULT_RETRYABLE:70=false） | 基准 |
| SKILL 码表 ×2 | **10** | mcp-reference/SKILL.md:83、orchestrator/SKILL.md:343（两处均自称「封闭 10 码」） | **缺 TASK_CANCELED** |
| adapter 本地白名单 | **10** | adapter-agent-workbuddy/src/index.ts:34-46（注释:29-33 自称「= @winvm/contracts 的 BridgeErrorCode」**已不实**） | **缺 TASK_CANCELED** |
| INSTALL-GUIDE | 10 口径 | docs/INSTALL-GUIDE.md:301「契约层（封闭 10 码）…唯一映射点在 toBridgeError()」 | 缺码 + 映射点表述不全（见下 ③b） |

- **① 「文档有码实现无」= 零例**：两份 SKILL 十码全部在契约枚举内且各有生产发射/映射点；领域 `reason` 码 10 个（FILE_NOT_FOUND/PATH_NOT_FOUND/CLI_NOT_FOUND/SERVICE_NOT_FOUND/PROCESS_NOT_FOUND/REG_PATH_NOT_FOUND/INVALID_ARGUMENT/FILE_TOO_LARGE/PROTECTED_PROCESS/WINGET_NOT_FOUND）逐一在 `packages/vm-capabilities`（psmod/*.ps1 + ps-bridge.ts）有发射实现（计数 grep 全 >0）。**反向账平**——前棒问的「有无文档有码实现无」，答案：暂未发现。
- **② 「实现有码文档无」= `TASK_CANCELED` 一处实锤，三个连带缺位面**：
  - (a) **用户/Agent 不可解读**：取消收口会真实返回 `code=TASK_CANCELED`（发射点实测 6+ 处：adapter index.ts:103/:489/:1149、llm bridge.ts:1590/:1729/:1775；链上归因 server.ts:1430 固定写该码），但两份 SKILL 码表无此行——orchestrator:347 的通则句「其余 false」侥幸把 retryable 判对，却丢了契约注释（errors.ts:67-69）明载的关键指引：**「确需重跑必须重新发起委派（重新过审批闸），不是对同一任务 retry」**。用户问「取消了能自动重试吗」时 SKILL 面给不出正确答案。
  - (b) **潜伏透传不一致（D-5 后半，工程面）**：`toBridgeError()` 层①透传判据 = 10 码白名单（:1009-1011），`TASK_CANCELED` 不在内 → 若一个 `code=TASK_CANCELED` 的错误穿过 `execute()` 的 catch（:451-452），会被压平成 `EXECUTION_FAILED` 且 **reason 丢失**。边界已核：现有四条生产路径（hostDisconnectedError :287/:342/:359 直接进 fail 不穿 toBridgeError；step() 哨兵 :489；llm/a2a 收口不穿 provider.execute catch）**均不触发** ⇒ 定性=**潜伏性**（未来在 execute 内新增 signal 消费即踩中）。反证补强：`PSBRIDGE_CANCELED` 被刻意设计成领域码形态走层②映射（:61-67 + ps-bridge.ts:425-437 注释），说明「白名单必须含取消码」是团队自己的设计意图，纯契约码 TASK_CANCELED 反被落下=白名单漏更。
  - (c) **契约层内部注释债**：errors.ts:44/:48 两处「封闭 10 码」字样未随 ARCH-18 追加更新——文档债最深处在契约自己肚子里。
  - **在册逾期**：phase1-t1-notes.md:162（D-1′）**早已登记**该漂移并「建议 T5 顺手同步注释与列表」→ T5 未做。**定级 P2**（不伤当下行为，伤排障面完整性）；修法=一个 commit：SKILL 两表 +1 行（含 retryable=false 与「重跑须重新过闸」指引）+ adapter 白名单 +1 + errors.ts 注释改「11 码」。
- 【互证】前棒 UX-6「错误呈现基座=全仓最佳」整体成立；本小节是其唯一未盘点角落。

### 8.2 「教 Agent 做实现不支持/半支持动作」全扫（7 份 SKILL + references）

按「请/应/须 + 调用/重发/reply/retry + approval/cancel/retry」句式全扫（git grep -E，7 份 SKILL.md + references/*.md），逐条核实实现可达性。**新登 4 条**（前棒已抓的 orchestrator:259-261 类同项标【互证】）：

| # | SKILL 位置 | 教的指令 | 实现可达性 | 定级 |
|---|---|---|---|---|
| S-1 | orchestrator/SKILL.md:261「取得确认后，用同一参数并附 `__approvalId` 重新调用」+ mcp-reference/SKILL.md:212 续跑表 | 直调审批续跑 | **不可达**（hostApproved 唯一写点在委派回合 raise 内，纯直调 no-active-task 早退——§2.2-1 P0 链，我独立复现） | P0【互证】 |
| S-2 | **approval-card.md:33 / :60 / :142**（前棒只点名该文件、未给行号；我补齐精确清单） | 卡片正文内实例化的「（MCP 通道续跑指令）以同一参数并附 __approvalId=apr_xxxx 重新调用本工具」 | 同上不可达。**关键增量**：卡片是用户可见文案的真正来源——只修 §212 表格不修卡片模板=用户照卡片做仍死循环；整改必须**四处同窗口**（orchestrator:261、mcp-reference:212、approval-card:33/:60/:142） | P0 整改范围精确化 |
| S-3 | orchestrator/SKILL.md:315「L3 一律**先 `dryRun:true` 预览（免审批）**→ 审批 → 执行」 | 对任意 L3 先 dryRun 拿免费预览 | **半可达**：实现是双条件（`dryRun:true` ∧ 注册表声明 `supportsDryRun===true`，engine.ts:575-586；声明全集=**5 条**：power.control / winget.install / winget.uninstall / storage.file.delete / +1，我逐条 grep definitions.ts 核毕）。对未声明能力传 dryRun → 照常被 APPROVAL_REQUIRED 拦（cl017.test.js:116-118 钉的正是该行为，属实现正确、**教学过度泛化**）。同文件 :262-264 括注「凡是支持 dryRun 的能力（如…）」表述是对的——**同一 SKILL 内双口径**，Agent 会采宽的那句 | P2（措辞）；改法::315 补「以能力声明 supportsDryRun 为准，未声明者 dryRun 仍需审批」 |
| S-4 | gui-automation/SKILL.md:32「RDP 断开后失效 → `tscon <sessionId> /dest:console` 归还控制台」 | 手工跑 tscon 配方 | **配方无数据源**：tscon 全仓 packages/+delivery/ 零实现【勘误加固：前棒把它归为「恢复全靠人」正确；我补一条——`delivery/setup.mjs` 的 grep 命中实为 `tsconfig.json` 子串误报，正式排除 ⇒ 连部署脚本面也没有】；且 `meta.session.status`/`gui.session.status` 快照**是否透出 sessionId 未证实**（health.ts:29 兜底结构含该字段，成功路径未见）⇒ Agent 照教做不出来 | P2；改法：补 sessionId 透出（一行）或把配方改指 SECURITY §5.3 已有的 RDP 重连叙述 |
| S-5 | （缺失型）7 份 SKILL **零**处「用户想停止在途直调任务怎么办」的教学；委派侧 `a2a.task.cancel` 仅在参考表出现，无触发话术/时机指引 | — | 与 UX-9（cancelled 通知被吞，mcp-framework/src/server.ts:177-180【互证前棒新发现】）叠加 ⇒ **实现与话术双缺**：首周用户对 600s winget 说「停」，既按不了钮也没词可说 | 并入 §7-9a 修复时一并补 SKILL 行 |

- 诚实标注面复核（找「反方向」好的一面）：四条 V2 缺口在 SKILL 里的「未注册、不可调用」标注（app-manager:32、app-operation:120、gui-automation:112、system-admin:30）与注册面**逐条一致**【互证前棒 §1.3】。
- **「SKILL 教幻觉能力」= 零例（穷举已做）**：我把 7 份 SKILL.md + references/*.md 里所有点分标识符（`\b[a-z]+\.[a-z]+\.[a-z]+\b`）与 `definitions.ts` 注册 id 全集做差集，非能力域的剩余 4 串逐一定位核实**都不是能力幻觉**：`agent.providers.workbuddy.options.endpoint`（mcps-reference:59 = 配置键路径）、`preview.params.permanent`（approval-card:111 / storage SKILL:113 = 卡片判定表达式）、`tunnel.state.json`（orchestrator:134 = 文件路径，且同句已声明「判定只以 `winvm-plugin tunnel status` 输出为权威」= 正确口径）、`health.logging.degraded`（orchestrator:430 = `/health` 快照字段，**已核实真实**：`file-logger.ts:10` AC3.5 + `server.ts:528`）。三个 `meta.*` 工具名也全部已注册（definitions.ts:94/:107/:118）。⇒ 前棒 §1「7 份 SKILL 缺 `meta.capability.list`」是**文档债（清单段未声明该工具）**，不是幻觉指引，两者须在终版分开表述，否则会误导排期（前者改文档、后者改实现）。真正的「教做不到的动作」全在**参数形态/枚举值**层面（S-1..S-5 + foreign 段的 `(powershell)` 那条），而非工具名层面。
- 编排门禁互证：orchestrator:140 健康闸「`capabilities.available == count`」经 server.ts:1983 核实为真实字段面 ⇒ degraded（仅 meta.* 暴露，:651-657）时该闸**能**拦住——对前棒 UX-3/D-3 无冲突，记录互证。

**§8 一句话结论**：十码表与实现账平（反向零缺），但 `TASK_CANCELED` 构成「实现有码、三处文档无码」的唯一实锤且早在 phase1-t1-notes D-1′ 在册未修；「教做不支持动作」新增 S-2（卡片模板三行=整改必须四处同窗口）、S-3（dryRun 泛化句双口径）、S-4（tscon 配方无数据源+setup.mjs 误报排除）、S-5（取消教学缺失）四条增量（D-5/D-6/D-9）。

---


## ⑧ §5 UX 缺口独立扫（续棒第二轮 · 22:30 落盘 · 只读 REPO@13b8705）

> 任务书来源：前棒 21:2x 转派（不用我重复 (a) 取消三层 / (b) WORKFLOW_NOT_FOUND 三源）。
> 证据纪律：每条附文件:行号；无命中处显式写「零命中」。

### 8.1 ① SKILL「教 Agent 做实现不支持的动作」全扫（7 份 SKILL.md）

扫描面：`git grep -nE "(请|应|须|需要|可|直接)[^。\n]{0,30}(调用|重新调用|重发|回复|reply|重试|retry|取消|cancel|批准|审批|approval)"` + 补充面 `可改走|改用|替代` + `\`\w+\.\w+\.\w+\`\` 引用面 + 错误码指引面。

已知同类（前棒已抓，我复核确认在位、不重复计数）：`winvm-orchestrator:261`、`winvm-mcp-reference:212`（直调续跑 `__approvalId`）—— 属 §2.2-① P0 同一根因的两个文档落点 ✅。

**NEW-UX-01（本轮最硬的增量，前棒未覆盖）**：SKILL 给的「替代路径」本身被入参校验恒拒。
- 教学位：`winvm-storage-manager:143`「需要解压时可改走 `appops.cli.invoke`(powershell) `Expand-Archive`（用户审批）或人工操作」；`winvm-app-manager:100`「可改走 `appops.cli.invoke`(powershell) 由用户审批后执行」（快捷方式创建）。合计 **2 处、全仓唯一使用 `(powershell)` 作为 app 值的两处**（`git grep -hoE "appops\.cli.invoke\`?\([^)]{0,30}\)" -- skills/` 统计：powershell×2 / ffmpeg×2 / pandoc×1 / magick×1 / node-python×1）。
- 实现位：`appops.cli.invoke` 入参 `app` 的 enum = `['ffmpeg','magick','soffice','pandoc','node','python','custom']`（`definitions.ts:381`），**无 `powershell`**；`checkParamValue` 第①层 enum 判定（`adapter-agent-workbuddy/src/index.ts:837-845`）在**发起 PowerShell 之前**返回 `INVALID_PARAMS` + `reason=INVALID_ARGUMENT`；即便绕过 Node 侧，PS 侧 `appops.ps1:234-235` 亦抛 `UNSUPPORTED_APP`（**双闸都拒**）。
- 用户/Agent 后果：照文档做的 Agent 收到的不是「应用不支持」而是「**你参数写错了**」——归因错位，且 `INVALID_PARAMS.retryable=false`（`errors.ts:57`），Agent 的合理反应是放弃或反复改参数。
- 可达的正确形态其实存在：`app:'custom'` + `command:'powershell -c "..."'`（`appops.ps1:242-245` 解析首词为 exe），但**两处 SKILL 都没写 custom 形态**。命令黑名单（`defaults.ts:86-97`）拦的是 `-enc`/`Invoke-Expression`/`FromBase64String` 等混淆执行，普通 `Expand-Archive` 不撞 ⇒ 替代路径可达、只是文档写错。
- 定性：与前棒抓的「续跑指令」**完全同类**（教做实现面上不存在的调用），但更隐蔽（无 `__approvalId` 字样可 grep，仅靠 enum 交叉核对才暴露）。**修复=一行文档×2 处，建议并入「文档诚实化」P0 当轮批**。

**NEW-UX-02**：`winvm-gui-automation:188`「`SESSION_UNAVAILABLE` / `SESSION_BLACK_SCREEN`（均可重试，**需先恢复会话**）」。
- 「可重试」✅ 与实现一致（`errors.ts:62-63` retryable:true）。
- 「需先恢复会话」❌ **无任何可调用恢复动作**：54 条能力 id 中会话面只有 `gui.session.status`（L0 检测，`definitions.ts:328`）与 `meta.session.status`（:118）；`git grep -niE "restore|unlock|wake|reconnect"` 在 `definitions.ts` 仅命中 `gui.window.control` 的 `state:'restore'`（**窗口**还原，非会话）。恢复机制代码零命中独立复现：`tscon|autologon|powercfg|screen.?saver` 在 `packages/*/src`、`psmod`、`delivery/*.mjs` 仅命中 `setup.mjs:484` 的 `tsconfig.json`（假阳性）⇒ **幻影动作**。
- 与前棒 UX-4「恢复全靠人 RDP」同根，但从「SKILL 句式」角度是新落点：**教 Agent 去做一个不存在的前置步骤**，Agent 会在此挂起等待或反复重试。

**NEW-UX-03（软缺口，定级 P2）**：`winvm-mcp-reference:75`「仍然失败 → 查服务端日志与审计目录（`%LOCALAPPDATA%/WinVMBridge/audit`）」。
- 可达性上不是硬阻断（`storage.file.read` 是 L0、`pathAllowlist` 含 `%USERPROFILE%\**`，`defaults.ts:74`），但它与「两通道共缺审计查询面」（我 §2.1 审计行 / D-2）自相矛盾：**文档把用户推向手工翻链文件**，而仓内 `GET /audit/receipt?traceId=` 已实现（`server.ts:1706-1738`）却零宿主消费者 ⇒ 排障面教的是最笨的一条路。属「面已建、无桥接」的文档侧症状。

**核对为无问题（明确记录，避免虚报）**：`orchestrator:108`（有界重试/自愈 → `ps-bridge.ts` lazy 自愈在位 ✅）；`orchestrator:140`（健康门 → 见下方 8.1.1 但属另一类）；`orchestrator:352`「先装应用或改用已装 CLI」→ `app.winget.install` L1 可达 ✅；`orchestrator:353` `system.service.list` 模糊匹配 ✅；`app-manager:29` 改用 `gui.*`/委派 ✅；`orchestrator:299/302` `a2a.task.get`/`a2a.task.cancel` 5 工具在位 ✅。

**8.1.1 顺带命中的健康门判据问题（非取消/审批类，另一条独立缺口）**：`orchestrator:137/141` 把门禁判据写成「`ok:true` 且 `capabilities.available == capabilities.count`」，并要求「健康确认通过后**方可调用任何 MCP / A2A 工具**」。实现位 `server.ts:1983` `capabilities: { count: registry.size(), available: exposedIds.size }`，而 `exposedIds` = `registry.intersectDeclared(provider.declareCapabilities())`（:651-656）——**provider degraded 时 exposed 收窄为仅 `meta.*`（3 条）**，`count` 仍是注册表全集（54）⇒ 该等式**永不成立**。三个后果：① provider 加载失败（degraded）时 Agent 按门禁**永久自锁、且不会收到「degraded」归因**（文档没教这个分支）；② 三 provider 的 `declareCapabilities()` 实测**完全相同**（`['meta.*','system.*','app.*','storage.*','gui.*','appops.*']`，deterministic:236-239 / llm:249-252 / hermes:124-126），正常态恒相等 ⇒ 该判据**只在故障态有意义、而故障态恰好把它写成不可能**；③ `delivery/winvm-plugin.mjs:653-682` `cmdHealth` 只打印 JSON + 非交互会话告警，**不实现 available==count 判定**、不设 exitCode ⇒ SKILL 教的「判定」在 CLI 上没有对应断言物。⇒ 文档命令无对应判据实现（P1 文档/门禁类，与前棒 UX-3「probeError 无人教」同族但更硬，因为它直接导致 Agent 卡门禁）。

### 8.2 ② 错误码表逐一对账（契约层 / 文档层 / 实现内部白名单层 三层）

**结论一句话**：不存在「文档有码实现无」（零命中）；存在 **3 类「实现有码/文档无码」**，其中一类是**首周最高频**错误码。

| 层 | 位置 | 码数 | 含 `TASK_CANCELED` |
|---|---|---|---|
| 契约（权威） | `contracts/src/errors.ts:16-36` | **11** | ✅（`DEFAULT_RETRYABLE` :70 = false） |
| SKILL 表 A | `winvm-mcp-reference:83`（表头「**封闭 10 码**」） | 10 | ❌ |
| SKILL 表 B | `winvm-orchestrator:343`（表头「**契约层（封闭 10 码）**」） | 10 | ❌ |
| 契约层自身注释 | `errors.ts:44`「契约层**封闭 10 码**」、:48「契约层 **10 码**与 DEFAULT_RETRYABLE 语义保持不变」 | — | ❌（自我陈旧；:8-10 与 :69 才是正确表述） |
| 确定性 adapter 白名单 | `adapter-agent-workbuddy/src/index.ts:31-46` 注释「**封闭 10 码**（= `@winvm/contracts` 的 `BridgeErrorCode`）」 | 10 | ❌ |
| **测试**同份清单 | `tests/unit/cl017-error-reason.test.js:76-87` `CONTRACT_CODES` | 10 | ❌ |
| LLM adapter（已同步） | `adapter-agent-workbuddy-llm/src/index.ts:66-73` `NON_DEGRADABLE_CODES` | 5 | ✅ |

**(i) 漂移不只是注释陈旧——有一条真实的压平路径（前棒/在册 D-1′ 均未指出机制）**
`toBridgeError` 三层（`index.ts:1004-1030`）：① `err.code ∈ BRIDGE_ERROR_CODES` → 原样透传；② 命中 `DOMAIN_CODE_RE`（:75）→ `DOMAIN_CODE_TO_BASE` 定 base + 原码入 `reason`；③ 兜底 `EXECUTION_FAILED`。
`TASK_CANCELED` **不在①**、但**在②的形态域内**（全大写正则命中）、且**不在 `DOMAIN_CODE_TO_BASE`**（:53-68 只登记 `PSBRIDGE_CANCELED: 'TASK_CANCELED'`）⇒ 任何以 `code:'TASK_CANCELED'` 进入 `execute()` catch 的错误被**压平成 `EXECUTION_FAILED` + reason=TASK_CANCELED，并丢 `details`**。
- 我主动做了可达性反证（避免夸大成现行缺陷）：今天**无生产路径**让契约码 TASK_CANCELED 进 `toBridgeError` —— ps-bridge 取消抛的是领域码 `PSBRIDGE_CANCELED`（`ps-bridge.ts:428-438`，注释「不进 BRIDGE_ERROR_CODES」✅ 走②保码）；`hostDisconnectedError`（:103）、`step()` 取消哨兵（:489）、K5 收口（:1149）**全部 return 而非 throw**，不经此函数。测试侧同样无此用例（`cl017` 的 10 码清单不含它；`phase2-contract-code-fidelity` 只测 LLM 降级判定层 :201-204/:399，那里码集是齐的）。
- ⇒ 定性：**「一半接线」的潜伏陷阱**——ARCH-22 时同步改了 LLM 侧 `NON_DEGRADABLE_CODES`，**漏改确定性侧白名单**，且连带漏改两份 SKILL 码表 + 契约自身两处注释 + 一份测试清单（共 **6 处陈旧点**）。任何未来把取消错误改 throw、或第三方 provider 直抛契约码的实现，都会静默把「用户叫停」伪装成「执行失败」，正面撞上 `SECURITY-GOVERNANCE:115`「取消码绝不折叠为失败码」这条红线（该红线目前的守护方式是 `DOMAIN_CODE_TO_BASE` 显式映射，**恰好没覆盖码位同名情形**）。
- 在册证据：`docs/changes/phase1-t1-notes.md:162` D-1′ **早已登记**该漂移并写「建议 T5 顺手同步注释与列表」——T5 未做 ⇒ 属「在册未修 + 已过期」。
- 定级 **P1**（非 P0：当前不可达；但同步 6 处成本≈半小时，属"该做没做"的最差一类）。

**(ii) 契约码集外的对外发射码：`TUNNEL_UNAVAILABLE`（本轮第二个增量，且是首周第一高频）**
`host-a2a-bridge/src/tools.ts:419`（delegate）、`:577`、`:659`、`:711`、`:765`（`a2a.health`）**五处**返回 `error.code='TUNNEL_UNAVAILABLE'`，文案「无法连接 VM 侧 A2A 服务（请确认 SSH 隧道已建立）」——它**既不在 `BridgeErrorCode`、也不在两份 SKILL 码表**（`git grep TUNNEL_UNAVAILABLE -- skills/` **零命中**；仅 `tests/unit/host-a2a-bridge.test.js:199` 与 `docs/changes/CL-017/REQUIREMENT.md:452` 命中）。
- 用户后果：**A2A 面最常撞的故障码之一**（隧道没起/掉了，README:313 K2 边界亦属该面），在「错误码分层（排查必读）」表里**完全不存在** ⇒ Agent 按表路由落空。
- 定性：**「实现有码、文档无码」的实锤第 2 例**，且比 (i) 更常被真实撞到。它同时暴露一个契约面事实：宿主桥在**自造码位**而未登记为契约码/领域码 —— 建议要么显式收进码表（并声明 `retryable:true` 语义），要么改emit既有 `PROVIDER_UNAVAILABLE` + `reason:'TUNNEL_UNAVAILABLE'`（与 CL-017 分层设计一致，成本最低）。定级 **P1**。
- 诚实区分：`PSBRIDGE_UNKNOWN`（`ps-bridge.ts:480`）经②归一为 `EXECUTION_FAILED`+reason，符合分层设计，**不算漂移**；`AUTH_REQUIRED` 已在 `errors.ts:12-14` **显式声明**「不进 BridgeError、属传输层事实」，**不算缺陷**（已登记）。

**(iii) reason（领域层）覆盖率对账（前棒 §5/UX-6 把它评为「全仓文档化最好的一块」——我给出修正）**
- 反向（文档有码实现无）：SKILL 两表所列 9 项 reason + mcp-reference 额外 `WINGET_NOT_FOUND` **全部有 psmod 发射点** ✅ 零缺失（`FILE_TOO_LARGE` 2、`PROTECTED_PROCESS` 1、`REG_PATH_NOT_FOUND` 1、`SERVICE_NOT_FOUND` 2、`PROCESS_NOT_FOUND` 1、`CLI_NOT_FOUND` 3、`PATH_NOT_FOUND` 5、`FILE_NOT_FOUND` 1、`INVALID_ARGUMENT` 3、`WINGET_NOT_FOUND` 3）。
- 正向（实现有码文档无）：psmod 侧另有 **12 个**领域码在两表未列 —— `WINDOW_NOT_FOUND`(4)、`PATTERN_UNSUPPORTED`(3)、`COM_AUTOMATION_FAILED`(2)、`UNSUPPORTED_KEY`(1)、`UNSUPPORTED_APP`(1)、`UNSUPPORTED_WORKFLOW_TYPE`(1)、`UNKNOWN_STEP_KIND`(1)、`MODULE_NOT_PRELOADED`(1)、`MODULE_NOT_FOUND`(1)、`COM_NOT_FOUND`(1)、`ELEMENT_NOT_FOUND`(1)、`INVALID_RECT`(1，注：此码在 `DOMAIN_CODE_TO_BASE:55` 已登记映射，但 SKILL 表未列)。Node 侧另有 7 个 reason 未列：`HOST_DISCONNECTED`、`NO_EXECUTION_RECEIPT`、`REPLAY_FAILED`、`HASH_MISMATCH`、`LLM_SESSION_DISABLED`、`LLM_CHILD_PROCESS_KILLED`、`LLM_TURN_CANCELED`。
- 关键缺陷是**兜底话术缺失**：`orchestrator:360` 只写「`reason` 缺失时按 `code` 处理」，**没有任何一句教「reason 不在表内怎么办」** ⇒ Agent 面对未知 reason 只能自行发挥（最可能退化为泛化重试，而其中 `UNSUPPORTED_APP`/`UNSUPPORTED_WORKFLOW_TYPE` 恰恰是 retryable 无意义的）。
- 爆炸半径：**GUI 与应用生产是首周主用途**，而 `WINDOW_NOT_FOUND`（psmod 出现 4 次，GUI 域最高频码）+ `ELEMENT_NOT_FOUND` + `COM_AUTOMATION_FAILED` 三个高频码**零指引**。⇒ 我认为 UX-6 的「保持/良好」评级**偏高**，应改「基座好、覆盖面有 12+7 个空洞 + 无未知码兜底话术」；定级 **P1**（纯文档，一次补表即可，成本最低收益最直接的一档）。

### 8.3 与前棒 UX-1..9 的交叉判定
同意：UX-1、UX-2、UX-3（`probeError` 在 skills **0 命中**我已独立 grep 复现 ✅）、UX-4（恢复机制代码 0 命中 ✅）、UX-5、UX-8、UX-9（`mcp-framework/src/server.ts:177-180` 实读确认 `notifications/cancelled` 与 `notifications/initialized`/`initialized` 并 case 直接 `return null` ✅ 前棒新发现成立）。
**修正**：UX-6 评级偏高（见 8.2(iii)）。**口径遵守**：不写 SECURITY §2.2.1「失实」——该节 §2.2 表（:108-109）确实同时列出两通道取消口径、且 MCP 直调行诚实写的是「宿主 HTTP 连接断开」⇒ 它承诺的是中止语义一致，未承诺取消触发面；我只写「`§2.2.1` 表头『两通道取消口径』易误读为两通道对等，建议加『触发面不对称：直调仅断连级』限定」。
**我的 §5 增量（前棒未覆盖 5 条）**：NEW-UX-01（powershell 替代配方恒 `INVALID_PARAMS`，双闸拒）、NEW-UX-02（「需先恢复会话」幻影动作）、8.1.1（健康门 `available==count` 在 degraded 态不可能成立、CLI 无对应判定实现）、8.2(i)（TASK_CANCELED 压平路径机制 + 6 处陈旧点 + 在册未修）、8.2(ii)（TUNNEL_UNAVAILABLE 码位漂移）、8.2(iii)（12+7 个 reason 空洞 + 无未知码兜底话术）。

---

> ⚠️ **所有权注记（22:4x，作者=许清楚 / software-product-manager-2）**：本文件 46–84 行（「## ⑧ §5 独立扫 · UX 缺口」+ 8.1/8.2 三层对账表 + S-1..S-5）与 87–154 行（「## ⑧ … 续棒第二轮」）是**两份独立写成的同题稿**。后者非我撰写（我 22:35 落盘自己那份后，文件于 22:39:39 被外部追加，我的第二次 Edit 因「file modified」失败）。已按铁律停笔上报主理人，裁定=两份视为互补证据、由主理人合并，我不再改动 §8 任何一段（包括不删别人的）。**两份判据零冲突**（TASK_CANCELED 三层漂移、反向「文档有码实现无」零例、phase1-t1-notes D-1′ 在册未修，三条同结论）；各自独有增量：46–84 行独有=S-2 `approval-card.md:33/:60/:142` 精确行号（→ 直调续跑整改必须**四处同窗口**）、S-3 `orchestrator:315` dryRun 泛化句 vs 同文件 :262-264 双口径、S-4 tscon 配方无 `sessionId` 数据源 + `setup.mjs` 命中系 `tsconfig.json` 假阳性的正式排除、psmod 90 函数 vs definitions 53 绑定差集交叉验证（「待挂载确为 3 成品 + 1 文档低报、无第 4 条遗漏」）；87–154 行独有=NEW-UX-01（`(powershell)` 替代配方恒 `INVALID_PARAMS`）、8.1.1（degraded 态健康门恒不成立 → Agent 永久自锁）、(ii) `TUNNEL_UNAVAILABLE` 自造码、(iii) 12+7 reason 空洞。合并时取并集即可，无一句互相矛盾。以下 SECTION 9/10 为同一作者（我）的续写。

---

## ⑨ §6 需求池定级 · 对抗性复核（前棒转派任务 2 · 22:5x 落盘）

> 立场：专挑前棒 §6 **偏高/偏低**给反证；已互证成立项不重复计数。前棒自答的两问（生产就绪包该不该 P0 / session-guard「失实 P0 + 整改 P1」是否自相矛盾）我给**独立裁定**：一处推翻、一处维持但扩面、一处新升档。

### 9.1 「生产就绪包 3a = P0」→ **推翻，降 P1**（判据补强，方向不变）

前棒 21:25 自查结论是「承诺写在对外头条 ⇒ 不可整体降 P1」。我复核其三条支撑，判据不成立：

1. **默认 provider 根本不承载 appops 委派**（新增硬证据）：`runGoal` 是 5 条正则模板（adapter index.ts:553-621），生产类唯一入口=模板 5 → 硬编码 `workflow.run generic_production`；未匹配直接 `makeError('UNKNOWN_CAPABILITY','UNSUPPORTED_GOAL：无匹配的目标模板')`（:675）。⇒ 默认形态下「出成品」在**委派侧连 workflow 都进不去**（WORKFLOW_NOT_FOUND，三源已证），但**在直调侧今天就能做**（下条）。
2. **直调路径可兑现且缺件时错误可路由**：`appops.cli.invoke` L1 免审批（definitions.ts:373-394，enum=ffmpeg/magick/soffice/pandoc/node/python/custom），CLI 未装 → `appops.ps1:275-279` `Get-Command` 未命中即 `throw "CLI_NOT_FOUND: …"` → 经 `toBridgeError()` 层②保码入 `reason` → **恰好命中 mcp-reference:89 已教的处置**（「不是桥的问题，先装应用，别重试」）。⇒ 用户得到的是**可执行补救指引**，不是死循环，也不是静默失败。
3. **承诺强度核实**（判据原文比对）：README:3「完全操作…覆盖…与图形化生产操作」+ README:44「用 Photoshop/Office/ffmpeg/IDE 等软件把活干出来」——这是**「该能力域存在」承诺**（54 条里 appops 确有 5 条且非空壳），不是「开箱即出成品」承诺；README:331 还主动披露真机验证边界。**对照 session-guard**：NFR-502 写「会话挂起自动检测**并恢复**」= 把不存在的动作写成现在进行时 ⇒ **两者性质不同**（前者=默认组合缺失，后者=失实陈述）。

⇒ **裁定 P1**（前棒的 3a 保留为 **P1 首位速赢**，成本≈一处 provider 编排）。但 3a 的**实现方案要纠一处技术错误**：前棒建议「先 `appops.state.query` 预检、命中已装 CLI 应用即走 `cli.invoke`」——我核 `state.query` 定义（definitions.ts:351-372 + `Get-AppOpState`）：它读的是**正在运行的生产型应用+其文档/窗口**（L0，output=apps/count/filtered/policy），**探测不到未安装、未运行的 CLI** ⇒ 用它做「装机性预检」不成立。正确配对：改用 `app.inventory.list`（或 ps-bridge 的 `Get-Command` 形态），且**失败文案应给出具体补救**（「先装 ffmpeg：`app.winget.install` id=GyanCal…/或直接跑 winvm-app-manager 配方」）而非现在的 `WORKFLOW_NOT_FOUND`。⇒ 结论：**降档 + 方案修正**，不是撤销该条。

### 9.2 「session-guard 文档 P0 / 实现 P1 是否自相矛盾」→ **不矛盾（同意前棒），但整改面应扩到 4 处、实现侧建议降 P2**

- 判据（「失实是否诱导用户做错误决策」）我认可 ⇒ 把「文档失实」与「功能缺失」分列两台账不构成自相矛盾。
- **加重（前棒未覆盖）**：同一幻影机制的**最下游落点**是 `winvm-gui-automation/SKILL.md:32`——把 `tscon <sessionId> /dest:console` 当**排障配方**直接教给 Agent。⇒ P0 文档整改清单应是 **4 处**（`ARCHITECTURE.md:71` 架构图行 + `§6.3:266-279` 六机制表 + `REQUIREMENTS:77` NFR-502 + **gui SKILL:32 配方行**），前棒的「两处」（NFR-502/ARCHITECTURE）漏了 SKILL 面；而 SKILL 恰是用户实际会照做的那一处。
- 独立复现的实装缺位：`grep -rniE "tscon|AutoAdminLogon|powercfg|ScreenSaveActive"` 在 `packages/`、`delivery/` **零真命中**（`setup.mjs:484-485` 是 `tsconfig.json` 子串假阳性，已正式排除）；`vm-capabilities` 无 `session-guard` 文件（前棒 §4-DB-5 同结论）；`packages/core/src/session/` 目录实存文件仅 `health.ts`（探针+guiAllowed+describeSessionState，无恢复动作）。
- **偏高质疑（实现侧）**：「会话治理最小实现」不必包级立项 ⇒ **降 P2**。前棒 §4-DB-5 自己已给等效便宜解（`powercfg` 三行挂进 `install-vm` + 文档手工步骤保留），§7-8 内容其实也是 powercfg，只是标题把它写大了。真正欠的是**部署脚本 3 行 + 文档诚实化**（后者已在 P0 台账）。

### 9.3 「maxRisk 默认口径差异 = P2」→ **改判：不是 P2、也不是我初稿写的 P1 语义，而是「最小权限两参数在服务端未接线」（P1 安全相邻，且是 (c) 策略化出路的前置）**

> ⚠️ **自我纠错声明**：本节初稿我曾写「委派默认 L1 → L2/L3 静默硬拒 → Agent 无自救路径」。复核后**该判断不成立**，原因见下；我把它留在这里作为推理痕迹，结论以下面为准（前棒 §2.2-3 的「由调用方自报」方向也需一并精修——事实不是「自报就生效」，而是「自报了也不生效」）。

**实证链（本轮新取证，逐处行号）**：

1. 引擎侧**两条最小权限判定都实现了**：`allowedCapabilities` 白名单判定 = `engine.ts:603-611`（`req.allowedCapabilities && length>0` → `matchesCapability` → 否则 `POLICY_DENIED`）；`maxRisk` 封顶判定 = `engine.ts:759-770`（**仅当 `req.maxRisk !== undefined`** 才生效，注释 :755-758 明写「MCP 直调场景宿主未声明范围，此时由审批闸管辖」）。
2. 但**全仓三处生产 `policy.evaluate` 调用点，一处都不传这两个字段**：
   - `server.ts:1229-1236`（MCP 工具 handler，含委派内层回连 `/mcp?dtid=`）→ 传 `capabilityId/params/risk/approved/approvalId/capabilityPolicy`，**无 maxRisk、无 allowedCapabilities**；
   - `server.ts:1059-1067`（`executeCapability`，K5 重放与直连共用）→ 同上，**无**；
   - `adapter-agent-workbuddy/src/index.ts:295-301` → 同上，**无**。
   ⇒ `req.maxRisk` 在生产路径恒 `undefined` ⇒ **引擎第 5 步永不触发**（死代码）；`allowedCapabilities` 在引擎第 3 步同理。
3. `goal.maxRisk` 的真实去向只有两处，均**不构成执行约束**：① 审计留痕字段（`server.ts:1387/:1450` 条件展开 + `delegation-audit.ts:654`）；② LLM provider 把它当**记账**写进 `GoalStep.risk`（`bridge.ts:1526` 与 `:1825`：`risk: input.maxRisk ?? 'L2'`）——这是 steps[] 里的展示/取证字段，不是策略入参。③ 唯一真实生效的限权消费在**确定性 provider 的模板层自查**：`adapter-agent-workbuddy/src/index.ts:755-756`（`goal.allowedCapabilities` 空则放行，否则按前缀匹配决定是否执行该步）⇒ **只覆盖 deterministic 的 runGoal，不覆盖 LLM provider 经 `/mcp` 回连的内层调用**。
4. 测试面旁证：`policy.test.js:239-245` 是**直接调 engine**才测出该行为；`host-a2a-bridge.test.js:202-215` 测的是「参数透传到 client」，不是「策略据此拒绝」。⇒ 没有任何端到端用例覆盖「委派设了 maxRisk/allowedCapabilities ⇒ 实际能力调用被拦」。

**对外承诺面（这才是问题所在）**：`a2a.delegate` 的 schema 描述把两者当**真能力**卖给宿主——`tools.ts:368-373`（`allowedCapabilities` + 「本次委派允许的最高风险，**默认 L1**」），设计文档 `HOST-A2A-BRIDGE §4.2` 称「最小权限」。⇒ 用户/Agent 以为给这次委派划了风险上限与能力白名单，**服务端事实上按原策略全量放行**（LLM provider 内层回连可命中任意已注册能力，包括 L2/L3——它们仍要过审批闸，所以不是「绕闸」，而是「第二层可选限权不存在」）。

**产品定性与定级**：
- 性质：**安全控制宣称与实现不符**（纵深防御少一层），**不是**审批闸被绕过（主闸 :1229 + 黑名单 + 风险分级仍全量生效）⇒ 我明确**不拔高成 P0**；定 **P1（安全相邻，建议按 P0 窗口讨论）**，与前棒「hermes 静默降级」同档。
- **对排期的实际约束（给主理人的关键一句）**：前棒 §7-1 与我 §2.2-1 共同推荐的出路 **(c)「策略化——把 maxRisk 变成服务端事实」如果要做，本条是它的前置**——先接 `goal.maxRisk/allowedCapabilities → policy.evaluate` 的传递（三处调用点各加一行条件展开），否则「抬默认值/改描述」全是空转。⇒ 建议把本条与 (c) 合并为**同一个 CL**，验收判据写成端到端式：「委派 `maxRisk:'L1'` ⇒ 内层回连命中 L2 能力返 `POLICY_DENIED(matchedRule=maxRisk:L1)`，当前该用例不存在」。
- 顺带修正前棒与我 D-4 的口径：把「由调用方**自报**（自报即生效=信任错位）」精修为「由调用方自报、**且自报值未落到执行面**（限权承诺空转）」。后者更准，也解释了为什么前棒找不到「服务端强制」的实现。

**未夸大的诚实标注**：`engine.ts:755-758` 的注释把「直调不封顶是故意的」讲清楚了（防止 L2/L3 永不可执行），所以**引擎设计本身没问题**；缺的只是委派侧把声明传进来。这一点前棒 §2.2-3 若读到这里，应把「与 ①(c) 同根」升级为「①(c) 的必要前置」。

### 9.4 「审计查询面 P2」→ **升 P1**（README 头条承诺 + 成本已核实为「包装非开发」）

README 四处以「**可审计**」为卖点（:3/:14/:20/:63），而宿主侧**零消费者**：`GET /audit/receipt?traceId=` 已实现（`server.ts:1707-1715` + `delegation-audit.ts:824` `buildReceiptResponse`），全仓该路径的引用**只有 vm-service 自身与 http-guard 的「不豁免」说明**（无桥接、无 CLI、无 SKILL 指引）；mcp-reference:75 教的是「去 `%LOCALAPPDATA%/WinVMBridge/audit` 翻文件」——普通用户做不到、Agent 也做不到（无工具）。⇒ 卖点对应面**已建成但未接出去**，成本=包装；与前棒 §6「CLI `audit tail|verify` P2」是同一件事的两种估价，我按「承诺强度 + 现成度」定 **P1**。

### 9.5 其余抽查（维持同意项，给完整性反证）

| 前棒定级 | 我的裁定 | 依据 |
|---|---|---|
| P0 `bootstrap prepare-vm`（DB-1/2/5/6） | **同意** | `install-vm.mjs` 对 `openssh|firewall|powercfg|defender` 零真命中（:802-804 仅把 Defender 当性能现象注释）⇒ §4 断点清单站得住 |
| P1「挂载 4 条已实现写侧」 | **同意，且给出完整性反证** | psmod `^function`（90）vs definitions `fn:`（53）取差集：真·未挂载写侧成品恰 3 条（`Set-ClipboardTextValue`/`Set-EnvironmentVariableInfo`/`Expand-ZipArchiveItem`）+ 第 4 条 `Get-ShortcutInfo` 确为**文档低报非欠挂载**（注册 fn 已含创建分支，与前棒一致）；差集其余为 helper/内部 `Get-*`，**无第 4 条遗漏** ⇒ 批 3 验收判据可写成可证伪式 |
| P1「hermes 安全特性静默缺失」 | **同意 P1**，补一条降低实现成本的实证 | 三 provider `declareCapabilities()` **完全相同**（deterministic:236-240 / llm / hermes:124-126 全六域）⇒ 切 hermes 后 `meta.health.check` 照样绿、健康闸拦不住 ⇒ 印证「静默降级」定性，同时说明**修法就是往快照加一个布尔位**（比 §7-5 的「横幅+对照表」更省） |
| P1「USER-MANUAL 重写」／P1「审批卡 TTL 第八槽+直调拒绝回执」 | **同意** | 拒绝回执侧我补一条正向证据：`server.ts:363/:420/:441` 确有 `approved:false, reason:'no-active-task'|'timeout'|'rejected'` 三态可复用——文案数据源现成，属包装 |

**§9 一句话结论**：与前棒 **2 处改档**（生产就绪包 3a：P0→**P1**，且其预检能力选错、应改 `app.inventory.list` 并给可执行补救文案；maxRisk：P2→**P1 安全相邻**，但定性由「自报即生效的信任错位」改为「**自报了也不生效=最小权限两参数服务端未接线**」，并因此成为前棒出路 (c) 的**必要前置**，建议并同一个 CL）、**1 处升档**（审计查询面 P2→**P1**）、**1 处扩面+1 处降档**（session-guard 文档整改 2→**4 处**含 gui SKILL:32 配方行；其实现侧包级立项降 **P2**）。其余抽查同意，并为「挂载 4 条」提供差集完整性反证。

> **对我自己 §2.2-⑤ 的勘误（同轮）**：本文件 2.2-⑤ 原写「委派的 `allowedCapabilities`/`maxRisk` 由调用方自报…实现是「Agent 自报参数」而非服务端强制」——方向对、强度不够：正解是**自报值根本没有到达策略引擎**（§9.3 实证三处 `policy.evaluate` 均不传）。原文保留以存推理痕迹，终版请以 §9.3 为准。

---

## ⑩ §7 Top10 · 用户视角重排（前棒转派任务 3 · 23:2x 落盘）

**排序判据（与前棒不同，且这是本轮唯一的方法论分歧）**：前棒 §7 标题写「按用户价值排序」，实际权重是 **审计严重度 × 工程可行性**（证据：其 ① 自己注了「深水区高危、非首日必撞」却仍列第 1；⑦「审批卡 TTL 槽」这种小修排在 ⑧「锁屏致 GUI 全灭」之前）。我按 **首周（Day0–Day7）真实必撞概率 × 后果可逆性** 重排，并给每项标「首周撞上面时的用户原话」。

### 10.1 重排对照表

| 我的位次 | 条目（前棒原位次） | 首周必撞性（判据） | 用户原话 | 与前棒分歧 |
|---|---|---|---|---|
| **1** | `bootstrap prepare-vm` 一键前置（②→①） | **Day0 100%**：6 项纯手工前置我已独立复核 `install-vm.mjs` 对 `openssh/firewall/powercfg/defender` **零真命中** | 「文档说一键，我怎么折腾了一晚上」 | 前棒第 2，我认为它压过一切（未装上=没有产品） |
| **2** | **直调长任务体验包 = 前棒 ⑨a 接 `notifications/cancelled` + ⑨b 时长先行告知（⑨→②）** | **Day1 高概率**：README:19 **明确引导**「默认走省 token 的 MCP 直调，仅长任务委派 A2A」⇒ 首周用户就在没有进度、没有停止的那条通道上；而**首周最高频动作恰是装应用**（`app.winget.install`/`upgrade` 600s 超时，definitions.ts:179/:301） | 「它在干什么？卡死了吗？——停！……它没停」 | **主要分歧点**：前棒把它放第 9 并称「性价比最高的速赢」——性价比（工程侧）我完全同意，但用户侧它是**第 2 个会撞的墙**，且撞了就只能强杀宿主进程 |
| **3** | **首周排障地图 = 文档诚实化族（前棒 ⑥ + 我的 §8 全部 + ⑨.2 扩面）（⑥→③）** | **Day1 起持续**：首周 80% 的挫败发生在「第一次失败后查文档」，而地图本身错：SKILL 码表缺 `TASK_CANCELED`（取消后能不能重试无答案）、缺 `TUNNEL_UNAVAILABLE`（**A2A 面第一高频码**，五处发射 tools.ts:419/577/659/711/765，表里零）、12+7 个 reason 空洞且无「未知 reason 怎么办」兜底句、`gui:32` 教跑不存在的 `tscon`、两处 SKILL 教 `cli.invoke(powershell)` 而 enum 无此值恒返 `INVALID_PARAMS`（**归因错位：把「不支持」教成「你参数写错」**）、`orchestrator:140` 健康门 `available==count` 在 degraded 态**恒不成立→Agent 永久自锁** | 「按文档做了，文档在骗我」 | 前棒放第 6。我主张：**这是唯一一个「零代码、当轮可闭、且修的是全部其它条目的可发现性」的条目**，任何 P0/P1 修完若不修地图，用户仍然撞 |
| **4** | **会话治理最小包（前棒 ⑧ 拆分，只留最小三件）（⑧→④）** | **Day2–3 高概率**：RDP 窗口一关 = 会话挂起 = GUI/截图/键鼠全灭；而 ARCHITECTURE §6.3 + NFR-502 + gui SKILL:32 **三处教用户以为会自愈**（恢复机制零实现，我已排除 `setup.mjs` 的 `tsconfig` 假阳性） | 「昨天还能截图，今天全黑，文档说会自动恢复」 | 前棒第 8。我把「文档划线」上提到位次 3，**只把实现最小集（powercfg 三行挂 install-vm + 首屏告知 + 解锁配方脚本）留在这里**；真正落 tscon/自动登录 属 P2（§9.2） |
| **5** | **MCP 直调审批闭环（前棒 ①，P0 不变）（①→⑤）** | **Day3+ 中概率**：严重度我完全同意（全仓最高危承诺矛盾，我独立复现），但爆炸半径已核：L2=7 条 / L3=1 条、5 条 dryRun 免批可绕、默认 provider 6 能力全 L0/L1 **永不触闸** ⇒ **不是首日必撞**。整改面须含**四处同窗口**（`orchestrator:261`、`mcp-reference:212`、**`approval-card.md:33/:60/:142`**——卡片是用户真正照做的那份文案，只改参考表等于没改） | 「我批了，它又说没批」 | 前棒第 1。**这是最实质的一处降位**，理由不是「不重要」而是「它排在『装不上』和『停不下来』之后才轮到」 |
| **6** | 最小权限两参数接线（新增，来自 §9.3） | Day4+ 低概率但**后果不可逆**（安全控制宣称与实现不符）；与前棒 ① 的出路 (c) 同根 ⇒ **必须与位次 5 同一个 CL**，否则 (c) 空转 | （用户不直接撞；宿主/合规侧撞） | 前棒原列 P2「maxRisk 话术」；我升 P1 并**改为接线**，位次紧随 ⑤ |
| **7** | 生产就绪包 3a（③→⑦，档亦降 P1，见 §9.1） | Day1 意图高（「帮我压个视频/转个格式」）**但可绕**：直调 `appops.cli.invoke` 今天可用，缺件时 `CLI_NOT_FOUND` 有可执行指引 ⇒ 属「要自己组」不是「坏了」 | 「说好的生产操作呢」——但能自助走出 | 前棒 P0 第 3；我给 P1 第 7（§9.1 三条实证） |
| **8** | provider 能力差集显形（⑤→⑧） | **切了 provider 才撞**，首周用户多数不切（默认 deterministic）；但一旦切 hermes 是**静默**失去审批重放/真值层（`declareCapabilities` 三 provider 相同 ⇒ 健康闸拦不住）⇒ 价值真实、频率不高 | （第 2 周、进阶用户） | 前棒第 5，我按「首周命中率」降位，但**修法我给出更便宜的版本**（快照加一个布尔位即可） |
| **9** | 挂载 4 条已实现写侧 + shortcut 文档（④→⑨） | 「想要才撞」——解压/写剪贴板/写环境变量不是首周默认路径；且**解压已有替代教育**（虽然那条教育本身写错了，见位次 3 的 `cli.invoke(powershell)` ⇒ 两件事应同批修，先修文档、再挂真值） | 「文档说能解压，结果只压缩」 | 前棒第 4；我按必撞性降位，但同意「零新代码=速赢」，建议**并入位次 3 的文档批**做「文档改对 + 挂载到位」二连 |
| **10** | 审计查询面（⑥/§6 P2→我的 P1，位次 10） | 合规/事后回溯场景，首周几乎不撞；但 README 四处以「可审计」为头条卖点，且 `/audit/receipt` 已建（成本=包装）⇒ **定级升 P1，位次仍靠后**（价值型而非救火型） | 「谁批的这个操作？」（通常发生在第 2 周之后） | 前棒未列入 Top10（只在其 §6 末行 P2）；我升档 P1 但不抢前 3——这是我对「档位」与「位次」刻意分开的一处示范 |

### 10.2 对前棒 Top10 的正面回应（转派点名：4/5/6 位中有没有该进前 3 的？）

- **第 6 位（USER-MANUAL 重写 + NFR-502/快照划线）→ 该进前 3**，且我认为它是全案唯一一个「零代码 × 高频 × 修完能让其它所有条目的修复被用户看见」的条目 ⇒ 我的位次 3，内容扩为「首周排障地图」（含我 §8 的码表/配方/健康门四类增量 + 前棒 UX-3 的 `probeError` 无人教 + 8.1.1 健康门自锁）。**这是我对前棒排序唯一的「前移」主张。**
- **第 4 位（挂载 4 条）→ 不该进前 3**：零代码是真的，但「用户想要才撞」，且其中「解压」的正确修法是先改那两处教错的替代配方（位次 3）再挂载，否则改完文档仍在教 `INVALID_PARAMS`。
- **第 5 位（provider 差集显形）→ 不该进前 3**：默认 provider 不切就不撞；但它是**第 2 周进阶用户的安全语义塌陷点**，我主张保留 P1 且修法降成本（快照加布尔位，不必先做横幅+对照表全家桶）。
- **额外主张（前棒未列位次、我前移两条）**：① 其 ⑨a（接 `notifications/cancelled`）从第 9 → **第 2**；② 会话治理拆出的「最小包」从第 8 → **第 4**。这两条的共同理由：它们的必撞时点在 Day1–Day3，且**用户无法自救**（一个停不下来、一个全屏黑），而位次 5 那条直调审批至少有 dryRun/改走委派两条活路。

### 10.3 一句话

前棒的 Top10 是**审计严重度序**，我的 Top10 是**首周墙序**；两者对 P0 台账（审批闭环 / prepare-vm / 文档诚实化）**没有分歧**，分歧只在位次：我主张把「停不下来的长直调」和「错误的地图」排在「有闸无解」之前，因为后者用户还能绕、前者只能弃用插件。

