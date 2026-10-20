# CL-026 —— 审批卡强制呈现闭环（TECHNICAL-SOLUTION）

| 项 | 值 |
|---|---|
| 文档 ID | TECHSOL-CL026-v1 |
| 类型 | FEATURE-ADD（DDD 场景 D）· 文档先行（原则 7） |
| 上游依据 | `docs/design/r17-design.md`（R17 两段式渲染契约，本件**引用不改动**）、`skills/winvm-orchestrator/references/approval-card.md` §9/§10（唯一正文） |
| 真机病灶取证日 | 2026-10-20（主理人现场实证） |
| 状态 | 已实现（本文 §5 守卫预检全部落地，代码/文档/测试同批） |
| 落地人 | Alex（software-engineer） |

---

## 0. 一句话病灶

A2A 委派挂起审批时，`a2a.delegate` 返回的 `input-required` 载荷**数据齐全**
（`approvalId` / `kind='approval-request'` / `underlying` 真实意图 / `previewHash`），
但**返回文案与 SKILL.md 都没有指挥宿主 agent 用「审批卡 + 权威确认控件」呈现**——
是否出卡全凭宿主 agent 自由发挥。真机那张卡是主理人**现场按 R17 规范手工渲染**的，
**不是系统保证**。本件把"出卡"从**agent 自觉**升为**契约强制**：

> **每次审批挂起，宿主 WB agent 必然先 `show_widget` 出七槽位卡，再 `AskUserQuestion` 收口权威裁决。**

R17 已裁定的机制（本件**不推翻、不改写**，只补"指挥"这一层）：
渲染契约 = `show_widget`（视觉载体，只展示不放行）+ `AskUserQuestion`（权威收口）两段式。

---

## 1. 呈现指令契约（规范文案 · 逐字入档）

### 1.1 单一权威串

新增导出常量 `APPROVAL_PRESENTATION_DIRECTIVE`（`packages/host-a2a-bridge/src/tools.ts`），
**恰好 4 行**（行数被守卫钉死，防文案面膨胀）：

```text
【呈现要求·MUST】① 先 show_widget 出审批卡：七槽位取本 approval 载荷（操作/目标=underlying 真实意图/通道/风险/影响清单/可逆性/预览），并展示 approvalId 与续跑指令。
② 随后 AskUserQuestion 权威收口：批准 / 拒绝 / 暂不决定（超时观察，任务保持挂起），选项文案带 approvalId 摘要。
③ 禁止用纯文本转呈代替出卡、禁止代替用户批准；show_widget 或 AskUserQuestion 任一不可用 → 逐字降级 references/approval-card.md 文本模板。
④ 批准后调 a2a.approval.reply，再用 a2a.task.get 轮询至终态并汇报证据。
```

锚点串 = **「呈现要求」**（预检 §5.1：全仓此前零命中 ⇒ 可作守卫锚点，不与任何现有钉冲突）。

### 1.2 四条要点的契约含义

| # | 要点 | 对应既有权威（本件只引用不复述） |
|---|---|---|
| ① | `show_widget` 出卡，七槽位取**本 approval 载荷**；「目标」取 `underlying` 真实意图优先 | `approval-card.md` §4 槽位对照表 / §10.3 卡片必含项（唯一正文） |
| ② | `AskUserQuestion` 权威收口，选项文案带 `approvalId` 摘要 | `approval-card.md` §10.2 第②段；R17 §A1.1 选型 |
| ③ | 禁止纯文本转呈代替出卡 / 禁止代用户批准；渲染面不可用 → **逐字降级**文本模板 | `approval-card.md` §10.5 降级触发条件（强制路径，非可选优化） |
| ④ | 批准后唯一续跑指令 + 轮询至终态 | `approval-card.md` §9 A2A 行：`a2a.approval.reply { taskId, approvalId, approved }` |

**第三选项「暂不决定（超时观察，任务保持挂起）」的口径**：其语义 = 「未作答」，
⇒ **不发任何 reply**、VM 侧保持挂起、超时按拒绝处理（fail-closed、零重放），
与 `approval-card.md` §10.2 的两段式与 `SKILL.md` 超时分支**完全一致**，
不构成第三种放行口实（本件在 SKILL.md 明写这条等价关系，见 §3）。

### 1.3 红线（沿用，不因本件放宽）

1. **卡片/文案绝不含 MCP 续跑标记字面量**（双下划线 + `approvalId` 的那个拼接串）。
   本件所有新增面（指令常量、工具 description、SKILL.md 新增行、新测试、本设计文档）
   **一律零该字面量**；测试内同样用**拆段写法**构造（`'__appr' + 'ovalId'`），
   与 `packages/adapter-host-workbuddy/src/approval-card.ts:62`、`tests/unit/r1-approval-card.test.js:53` 同纪律。
2. **按钮不直调 reply**；放行只能来自 `AskUserQuestion` 的结构化答案（R17 裁定 Q2）。
3. **凭据不进卡**：指令常量为固定文本，零插值 ⇒ 天然不含凭据；
   且拼接进 `summary` 后仍走既有 `scrubText`（同一呈现面口径）。
4. 唯一续跑指令 = `a2a.approval.reply { taskId, approvalId, approved }`。

---

## 2. 落点（呈现要求的携带面）

呈现要求必须出现在**宿主 agent 必然读到的位置**，即工具返回面，而非仅文档面。

| # | 面 | 落点（源码位置以段标签为准） | 形态 |
|---|---|---|---|
| **L1** | `a2a.delegate` 早退（`input-required` + approval）的 `summary` 合成文案 | `createA2aBridgeTools` → `delegate.handler` → `const summary = scrubText(... approval ? ... )` 审批分支 | 在「任务挂起等待审批：<message>」+「真实目标：…」之后**换行追加**整段指令 ⇒ 同时进 `structuredContent.summary` 与 `content[0].text` |
| **L2** | `a2a.delegate` 返回的 `approval` 载荷 | `withA2aResumeHint(...)` 外层再套 `withPresentationDirective(...)` | 新增**纯附加可选字段** `presentationDirective?: string` |
| **L3** | `a2a.task.get` 观测到挂起审批（超时后轮询/重连后取结果**同样**是审批挂起面） | `taskGet.handler` → `approvalOut` 同款包装；`content[0].text` 追加 | 同 L2 + 文案面 |
| **L4** | `a2a.delegate` 工具 `description` | delegate 工具注册对象 | 追加一句「挂起审批时返回体携带『呈现要求』：必须先 show_widget 出卡、再 AskUserQuestion 收口」（宿主 `tools/list` 稳定读到的说明书） |
| **L5** | `a2a.approval.reply` 工具 `description` | approvalReply 工具注册对象 | 追加「批准/拒绝只能来自 AskUserQuestion 权威收口，且必须先完成审批卡呈现」——从 reply 侧反向闭合，杜绝"未出卡直接 reply" |

**幂等纪律**：`withPresentationDirective` 与既有 `withA2aResumeHint` 同规（已有该字段则原样返回），
不改任何既有字段取值；既有逐字断言（`buildA2aResumeHint` 无 underlying 时逐字不变、
`resumeHint` 形态、`impact`/`preview` 深等）全部保持。

---

## 3. 影响面清单（逐文档一致性检查结论）

### 3.1 需改动

| 文件 | 改动 | 与既有逻辑的冲突点 → 处置 |
|---|---|---|
| `packages/host-a2a-bridge/src/tools.ts` | 新增 `APPROVAL_PRESENTATION_DIRECTIVE` + `withPresentationDirective`（导出）；L1/L2/L3/L4/L5 五个面接线 | 无冲突。纯附加；`ExtractedApproval` 增可选键（SK-4 纯附加可选纪律） |
| `packages/host-a2a-bridge/src/index.ts` | re-export 两枚新符号 | 无冲突 |
| `skills/winvm-orchestrator/SKILL.md` | 审批闸协议 A2A 小节：三步软描述 → **MUST 流程清单**（显式绑定两工具名 + 两段顺序 + 红线指针）；标准执行路径第 2 步补 MUST 口径 | **冲突 1**：原小节只写「两段式（缺一不可）」但未绑定"返回体自带指令"这一事实 ⇒ 改为显式指向 `presentationDirective`。<br>**冲突 2**：原文无「超时观察」第三选项口径 ⇒ 新增等价声明（第三选项 = 未作答 = 不发 reply）。<br>**冲突 3**：`task.get` 轮询面此前无呈现要求 ⇒ 同步声明"挂起审批经 task.get 观测到时同样必须出卡"。 |
| `docs/02-design/HOST-A2A-BRIDGE.md` | §4.4 审批闸：补 CL-026 呈现要求段（携带面 L1–L5 + 唯一权威串指针） | **冲突**：原文仅「必须先向用户展示影响清单」＝软描述 ⇒ 升为"返回体携带 MUST 指令"。 |
| `tests/unit/cl026-approval-presentation.test.js` | 新增静态钉 + 行为钉（见 §4） | — |

### 3.2 明确**不改**（含理由）

| 文件 | 不改理由 |
|---|---|
| `skills/winvm-orchestrator/references/approval-card.md` | **唯一正文纪律**。§4/§5/§9/§10 已是槽位、降级、续跑、渲染的权威源；本件只在指令文案里**引用**它，绝不复制正文，也不新增槽位。 |
| `docs/design/r17-design.md` | 上游设计，本件引用不改动。 |
| `packages/adapter-host-workbuddy/src/approval-card.ts` | R17 已定型的渲染层；呈现指挥属**桥返回面 + SKILL 门禁**两层，渲染层零改动（R17 §B3-7 最小变更纪律）。 |
| `docs/02-design/INTERFACES.md` | 其 `resumeHint` 样例属 **MCP 直调通道**口径，与 A2A 呈现面无关；改动即跨通道串台。 |
| `scripts/gate.mjs` `GATE_GUARD_FILES` + `scripts/GATE-POLICY.md` | ~~不动门禁表~~ → **主理人裁决 1（2026-10-20）批准升 ST3**：新守卫属安全承诺族（纯离线 0.9s、失效后果=呈现承诺与运行态分叉），按入选三标准 (a)(b)(c) 入表；**双写**（gate.mjs 表末新项 + GATE-POLICY.md ST3 表新行，格式照 `winvm-prepare-ps1` / `publish-release` 先例）。校验器 `phase2-dep-direction.test.js` 32/32 GREEN；`gate:quick` guards **12 件 250/250**；`gate.mjs:447` `alreadyRun` 去重 ⇒ ST3+1/sweep−1，全量 **FILES=127 守恒**。 |
| `package.json` 版本号 / git commit / 打包 | 主理人统一收口。 |
| `C:/WinVMBridge/shared-skills/winvm-orchestrator/SKILL.md`（仓内误落的部署产物副本）、`release/V1.4.0*/` 归档、`~/.workbuddy/connectors/skills/connector-winvm/` 部署缓存 | 发布/部署产物面，**不由工程师手改**；标注「待主理人收口时跟批」。 |

### 3.3 MCP 直调路径核查结论（任务书要求项）

逐个返回面对账，结论 = **两处不落地，理由如下**，同时把"两处口径"写清：

| 直调面 | 现状 | 是否同款指令 | 口径 |
|---|---|---|---|
| `DELEGATION_REQUIRED`（`vm-service/src/server.ts` 批1(c)：纯宿主直调命中 L2/L3 ⇒ 服务端策略收口） | 返回体**不含任何审批载荷**（不发 `approvalId`、无 `impact`/`preview`），指引是「改走 `a2a.delegate`」 | **不落** | 无 approval 载荷即无七槽位可填；`approval-card.md` §4/§7 明写「无 `approvalId` ⇒ **不得出卡片**」。此处塞呈现指令会造出"对空载荷出卡"的违规诱导。正确闭环 = 转委派后由 L1/L2 面携带指令。 |
| `APPROVAL_REQUIRED` + 令牌态（同文件，委派内层拦截 / `WINVM_DELEGATION_REQUIRED_POLICY=off` 回滚态） | 返回体含 `approval{approvalId,risk,capabilityId,preview,impact,resumeHint}`，其 `resumeHint` 是 **MCP 通道**续跑形态 | **不落** | ① 该面面向 **VM 内 Agent**（委派内层），不是宿主审批卡的直接来源；② 对宿主可达的唯一形态是回滚位（非主路径），且其续跑标记与 A2A 卡片红线互斥（R17 §B3-5 通道隔离）——在 VM 侧文件加 A2A 式出卡指令即串台。③ 改 `vm-service/src/server.ts` 属跨端 VM 侧单写者文件，本批不做。 |
| **A2A 委派通道**（宿主桥 `tools.ts`） | L1/L2/L3/L4/L5 | **两处口径 = 落地** | delegate 早退面（L1/L2）与 task.get 观测挂起面（L3）——两者都是"宿主 agent 手里正握着一次待裁决审批"的时刻，必须同款指令、同一权威串。 |

---

## 4. 守卫设计（新件 `tests/unit/cl026-approval-presentation.test.js`）

判据族（静态 + 行为，纯离线，不碰 VM/网络）：

| 组 | 判据 | 防的复发 |
|---|---|---|
| **C-1 文案契约** | `tools.ts` 源含锚点「呈现要求」+ 两工具名 `show_widget` / `AskUserQuestion`；指令常量**恰 4 行**；含七槽位名、`approvalId 摘要`、「禁止…代替用户批准」、「逐字降级」、「a2a.task.get 轮询」 | 指令被删/缩水/改回软描述 |
| **C-2 接线面** | 行为钉（经 dist `createA2aBridgeTools` + mock client）：① delegate 挂起 ⇒ `structuredContent.summary` 与 `content[0].text` 均含指令；② `approval.presentationDirective` 在位且 === 权威常量；③ **task.get 观测挂起同样携带**（L3 不退化）；④ 无审批载荷时**不得**出现 `presentationDirective` 键（纯附加，K-13 禁显式 undefined）；⑤ delegate/reply 两工具 description 均含呈现口径 | 只改文档不改返回面（= 真机原病灶）；或只改 delegate 漏 task.get |
| **C-3 SKILL 门禁** | `SKILL.md` A2A 小节含 `MUST` + `show_widget` + `AskUserQuestion` + `presentationDirective` + 第三选项等价声明；且节内**不引入新的三级标题**（`###`）——R1-9 用节切片做断言，新增 `###` 会**截断**它的取证范围 | SKILL 升格被回退成散文；或改动误伤既有 R1-9 钉 |
| **C-4 红线（拆段写法）** | **整文件扫描集**（零字面量）：`tools.ts` src+dist、`index.ts`、本设计文档、`HOST-A2A-BRIDGE.md`、本测试文件自身。**SKILL.md 采分节扫描**（因 R1-9 反向钉要求 MCP 小节保留该说明）：A2A 小节 + 标准执行路径块零标记，同时**反向断言** MCP 小节标记仍在位（既有说明不被误删）。测试内用 `'__appr' + 'ovalId'` 拆段构造；行为钉对 delegate / task.get 两路各做一次 `JSON.stringify` 全量扫描；另加凭据哨兵行为钉（打码后呈现要求仍携带、哨兵零外泄） | 通道串台（R1-a）；以及"为过红线而删掉合法 MCP 说明"的误伤 |
| **C-5 灵敏度自证** | 变异体（去掉锚点词 / 把三段式改两段 / 把指令塞进 marker）必须命中判据 | 永绿守卫（K-10） |

**为什么 C-2 走 dist**：`tools.ts` 的返回面是契约消费者（宿主 agent）真正读到的东西，
静态 grep 只能证明"文件里有这句话"，证明不了"审批挂起时它进了返回体"。
既有 `host-a2a-bridge.test.js` 同范式（`import from '@winvm/host-a2a-bridge'` ⇒ 先 `tsc -b`）。

---

## 5. 守卫面预检记录（原则 7 硬性前置 · 批19 教训）

> 纪律：**任何**注释/文案/文档字样，在写入前先 grep 同名静态断言。下面是本件逐锚点的实测结论。

| # | 拟写入面/措辞 | 预检命令要点 | 结论 / 处置 |
|---|---|---|---|
| 5.1 | 锚点串「呈现要求」 | 全仓 `grep -rn "呈现要求" tests skills packages docs delivery` | **零命中** ⇒ 可安全用作新钉锚点，不与任何既有钉抢语义。 |
| 5.2 | SKILL.md 新增小节层级 | 读 `r1-approval-card.test.js` R1-9：`A2A_SECTION` = `indexOf('### A2A 通道')` → 下一个 `\n##\s` 或 `\n###\s` | ⚠ **会截断既有取证**。处置：本件新增 MUST 内容全部落在**同一小节内**，用 `**粗体**` 标签，**不新增 `###`**。该约束由 C-3 反向钉死（防后人加 `###` 静默使 R1-9 失明）。 |
| 5.3 | SKILL.md「严格禁止」条目 | R1-9 钉 `[^- ❌]` 计数 **恒等于 5** | 处置：**不在该块增删条目**；MUST 流程落在审批闸协议节。 |
| 5.4 | SKILL.md 标准执行路径 | R1-9 钉 `/两段式/` 与 `/approval-request/`；`**标准执行路径**`→`**为什么**` 切片 | 处置：改写第 2 步时**保留**两串原词。 |
| 5.5 | SKILL.md A2A 节内出现续跑标记 | R1-9 钉 A2A 节**零**标记；MCP 节**必须含**标记 | 处置：新增行不写该标记；不动 MCP 节原文。 |
| 5.6 | `tools.ts` 文件级"标记恒零" | `grep -c` 实测（改动前）：`src/tools.ts` = **2**（`:83`、`:202` JSDoc 注释）、`dist/tools.js` = 1 | ⚠ 既有事实：该字面量出现在**注释**里是合法且必要的自我约束说明（`cl018-a2a-timeout.test.js` AC2.2 同样按"先剥注释再断言"口径）。**本批处置（比红线更严）**：把两处注释改写为「MCP 续跑标记 / 双下划线 + approvalId 的那个串」⇒ `src/tools.ts` 与 `dist/tools.js` 计数**双双归零**（与 `approval-card.ts` 同纪律），C-4 因此可对**整文件**扫描。语义未变（注释仍完整表达"绝不含"的约束），`grep -c` 全仓该字面量的命中集因此**缩小**，不触碰任何既有钉（R1-8 只扫 adapter 源码 + `approval-card.md` §9，均未改）。 |
| 5.6b | `SKILL.md` 整文件零扫描 | 读 `r1-approval-card.test.js` R1-9：`assert.ok(mcpSection.includes(MCP_MARKER), 'MCP 通道小节保留其续跑方式（不被误删）')` | ⚠ **反向钉**：`### MCP 通道` 小节**必须**含该字面量 ⇒ 守卫**不得**对 SKILL.md 做整文件零扫描（会误删合法内容或判红）。处置：C-4 对 SKILL.md 采**分节扫描**——A2A 小节 + 标准执行路径块零标记（本件改动面），同时反向断言 MCP 小节标记**仍在位**（既有说明不被误删）。 |
| 5.7 | 指令常量塞进 `summary` | `host-a2a-bridge.test.js` 钉 `summary.includes('任务挂起等待审批')`、`!JSON.stringify(res).includes(marker)`、凭据哨兵零出现 | 处置：只做**尾部换行追加**（前缀逐字不动）；指令文本零凭据键、零 marker；追加后仍整体走 `scrubText`。 |
| 5.8 | 改 `resumeHint` | `k5-replay.test.js:815` 钉 `buildA2aResumeHint` 不带 underlying 时**逐字不变**；`host-a2a-bridge.test.js:551` 钉逐字串 | 处置：**不碰** `buildA2aResumeHint`/`withA2aResumeHint`；呈现指令走**独立新字段**。 |
| 5.9 | 新增第 7 个工具 | `phase3-b3-receipt-ttl.test.js:26` 钉 `tools.length === 6` | 处置：零新增工具（只加字段与文案）。 |
| 5.10 | SKILL.md 契约码表行 | `p4-b9-errcode-registration-pin.test.js` 钉 `| \`error.code\`` 行的码集 ↔ `errors.ts` | 处置：**不改该行、不往该行加码**。 |
| 5.11 | skills/**.md 新增点分 token | `phase3-skill-claims-guard.test.js` 判据 a：≥3 段点分 token ∈ 注册 id ∪ 白名单（白名单含 a2a 五件） | 处置：新增行只用 `a2a.delegate` / `a2a.task.get` / `a2a.approval.reply`（白名单内）+ `references/approval-card.md`（1 点，不被正则匹配）。⚠ 反例：`structuredContent.approval.presentationDirective`（2 点 ⇒ 违规）⇒ 文档里写作「返回体 `approval` 的 `presentationDirective` 字段」。 |
| 5.12 | 治理面文档写续跑承诺词 | 同守卫判据 b：治理面（含 `docs/02-design`）出现该行须携口径词 | 处置：`HOST-A2A-BRIDGE.md` 新增行**不写**该标记字面量（改写为「MCP 通道续跑标记」），零风险。 |
| 5.13 | 「超时观察」第三选项 | 全仓 grep `批准 / 拒绝` 无唯一性钉；HTML 卡按钮数由 R1-5 钉为 2 | 处置：第三选项只作用于 **AskUserQuestion 收口面**（非卡片按钮），不触碰 `data-wac-choice` 计数；文档 §1.2 写明其 = 「未作答」等价语义。 |
| 5.14 | 承诺性措辞族（CL-018 C2 AC2.2 的负向钉：剥注释后的代码体零命中） | 读 `cl018-a2a-timeout.test.js` AC2.2 判据 | 处置：本件全部新增文案（注释体外）**不写**该族词；文档状态行用「已实现」。 |
| 5.15 | 快照族字样（`phase2-snapshot-truth` 消费侧白名单 + `phase2-session-unknown` E6 复算钉） | grep 该字样命中文件集 | 处置：本件新增文案零该字样，避免进白名单/触发复算红。 |

---

## 6. 验收判据

| # | 判据 | 口径 |
|---|---|---|
| A1 | `node --test tests/unit/cl026-approval-presentation.test.js` 全绿 | 新守卫（C-1…C-5） |
| A2 | `node --test tests/unit/r1-approval-card.test.js` 全绿（69 例） | 既有 R1 基线零回归 |
| A3 | `node --test tests/unit/host-a2a-bridge.test.js` / `k5-replay.test.js` / `cl018-a2a-timeout.test.js` / `phase3-b3-receipt-ttl.test.js` 全绿 | 返回面既有逐字钉零回归 |
| A4 | `node --test tests/unit/phase3-skill-claims-guard.test.js` / `r19b-s1-registry-forms.test.js` / `phase2-mcp-signal.test.js` 全绿 | SKILL 文案面 + 桥信号面零回归 |
| A5 | `tsc -b tsconfig.build.json` 零错误 | 改了 TS 必重建（K-3） |
| A6 | `npm run gate:quick` 全绿 | ST1+ST2+ST2b+ST3 |
| **A7** | **真机**：委派一个 L2 目标 → `a2a.delegate` 返回体含「呈现要求」+ `presentationDirective` → **宿主 agent 未手工干预即自动出七槽位卡** → `AskUserQuestion` 收口 → 批准后 `reply` + `task.get` 轮询至 `completed` | **本件的唯一真判据**：出卡由系统保证，不再依赖 agent 自觉或主理人现场补渲染 |

A7 的判据细节：出卡前**不得**出现纯文本转呈即请求批准；批准前**不得**出现 `a2a.approval.reply`；
选「暂不决定（超时观察）」时**必须**零 reply、任务恒挂起。
