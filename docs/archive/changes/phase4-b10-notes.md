# Phase 4 · 批10 施工记录 —— 缺省形态端到端 + P2 随修族（N-7/N-9/N-10 + M6 声明 + ⚠-1 随修）

> 施工日期：2026-10-15。依据 = `docs/audit/2026-10-14-full-audit.md` §4 批10 行 + §1 N-7/N-9/N-10
> + §2 M6 声明位 + 批9 notes §8a ⚠-1 七处「封闭 10 码」登记。
> 基线 = 批9 完赛 `5daf055`（全量 gate 115件/2087例 GREEN）。前实例零落盘（工作树净），
> 本实例从干净基线起，七组 G1–G7 逐组做完各 commit 一笔。
> 环境纪律全程遵守：git 全路径、单测逐文件（绝不整批 glob，K-2 教训）、tsc -b 复验、写完再读、
> 同任务无并发、每组先 commit 再继续。**不碰 VM**（V3/V4 真卸载窗归主理人）。

## 0. 事实底账（施工前亲验）+ 过关 checklist

- **沙箱 createService 可起真服务**（亲验探针 `.scratch-b10/probe.mjs`，后移仓库外 wbtmp）：
  516ms 起、`degraded=false`（deterministic provider，ps-bridge 未就绪但**不阻断启动**）、
  `/health.policyGate` 块在册 `{wiring:shadow, shadowHits:0, delegationRequiredPolicy:true, scopeEntries:0}`、
  直调 L2 返 `DELEGATION_REQUIRED`。**p3-b1 注释「本沙箱 createService 会 spawn ps-bridge 触发 V8 fatal」
  是 K-2 junction 旧环境教训的措辞遗留**——本环境 createService 正常起，故 G1 走真服务 E2E 而非绕行。
- **批1 scope 执法链三处锚**（亲读）：`delegation-scope.ts` 双索引精确回查（taskId 主/traceId 辅）；
  server.ts `onGoalAccepted`→`scopeRegistry.register`（1738，`maxRiskDeclared===true` 才存封顶，F-3 防线）；
  handler `evaluateScoped`（1152）三态 + `isInnerDelegation`/`scopeLookupKeys`/`shouldReturnDelegationRequired`
  通道判据（1499–1521，全取服务端事实）。引擎 scope 闸实名：`scope:capability-not-in-allowed-set`（白名单外）、
  `maxRisk:<封顶>`（超上限），二者 `requiresApproval:false`（硬拒，非审批闸）。
- **常驻形态内层判定唯一可用证据 = 协调器活动委派槽**（`getActiveTaskId()`，dtid 在常驻不生效，
  delegation-scope 头注 A2-18/arch3 F-2 原文）；`beginTask/endTask` 由 `CliLlmBridge.runGoal`（bridge.ts:997–1003）
  包裹整个委派 turn；测试经契约 SPI `BridgeContext.approvalCoordinator` 复刻该 turn 形态（非手搓内部状态）。
- **A2A `message/send` blocking 链路**：`buildGoal`（metadata.allowedCapabilities 在场即声明、
  maxRiskSource==='agent' 才标 declared）→ `runGoalWithLifecycle` 注入 `goalWithTask={...goal,taskId}` →
  `observe(onGoalAccepted)` **同步**回调（server.ts:398 try/fn() 非 microtask）→ handler.runGoal →
  终态 `onGoalTerminal`（非 input-required ⇒ retire）。全链可脱 LLM 独立驱动。
- **errors.ts 封闭码集 = 12 码**；INTERFACES §2.6 表 = 12 行（批9 补齐）；`BRIDGE_ERROR_CODES` 镜像数组
  = 10 项（批9 主理人裁定 notes §8a：两新码不经 toBridgeError 通道，动数组=行为改动，phase2-mcp-signal 钉形态）。
- `meta.capability.list` 亲验**真在注册表**（definitions.ts:107，L0）且 psmod 有实现（ps-bridge.ps1:173 `listModules`），
  非幽灵能力 ⇒ G4 补声明合法（不制造"宣称-实现不符"）。
- 过关 checklist（全部实跑，见 §8）：① G1/G7 两新件逐件绿 ② p3-b1/pin/claims/fidelity/kn1-d/mcp-signal 逐件绿
  ③ G2/G7 关联既有件回归绿 ④ `npx tsc -b` EXIT=0 ⑤ F-5 grep 清零 ⑥ dep-lint GREEN ⑦ 逐组 commit。

## 1. G1（N-10）常驻缺省形态服务级 E2E —— `tests/e2e/p4-b10-resident-scope-e2e.test.js`

新建件起**真 createService**（两灰度态各一实例：wiring 在构造期解析，不可运行中切换），经
`registerProviderFactory` 注入常驻 provider 替身（忠实复刻 CliLlmBridge 的 `beginTask→HTTP回连/mcp（无dtid）→endTask`
turn 包裹，判据面零 mock），11 例全绿（10 G1 + 1 G3 窄窗实锤）：

| 象限 | 用例 | 覆盖确认 |
|---|---|---|
| ① 委派 accepted 装配 | shadow 套件首测断 `/health.policyGate` 初态 + 二测走真 `message/send` blocking → `onGoalAccepted`→`scopeRegistry.register`（scopeEntries 观测印证，非手搓） | ✅ 命中 |
| ② 内层回连·白名单外 | shadow：无 dtid 纯活动槽回连 `storage.file.delete`（白名单只含 read）⇒ **改道** `APPROVAL_REQUIRED`+approvalId（(c) 不误伤内层）+ `shadowHits>0`；on：⇒ `POLICY_DENIED`+链上 matchedRule=`scope:capability-not-in-allowed-set` | ✅ 两态命中 |
| ③ maxRisk:L1+L2 | shadow（白名单放行、声明封顶 L1）⇒ 改道+hits 再增；on ⇒ `POLICY_DENIED`+链上 matchedRule=`maxRisk:L1`；**F-3 断崖防线端到端**：无 maxRiskSource ⇒ 封顶不喂 ⇒ 白名单内 L2 走审批闸 | ✅ 三态命中 |
| ④ 判别性 | terminal 后 `scopeEntries` 回落 0（retire 生效）+ 槽清除后同请求纯直调 ⇒ `DELEGATION_REQUIRED`（(c) 生效面回归，inner 判定随活动槽翻转）；on 套件复现 | ✅ 命中 |
| ⑤ 全程零伪造 | 通道判据/scope 回查/灰度三态/(c) 收口全由服务端真实装配执行；matchedRule 从审计 jsonl 链读实名（内存判据不足时的取证面补强） | ✅ |

**无卡点**（任务书预留的"若离线无法模拟完整链路如实报告"条件**不成立**——构造面齐备）。
链上 matchedRule 取证（`readChainEntries` 轮询 jsonl）替代了「getHealth 读 scope 拒绝详情」——
`buildPolicyGateHealth` 现不返 matchedRule 名，故拒绝**规则实名**经 S-4 审计条目（`recordPolicyDeniedAudit`
`policyDecision.matchedRule`）实锤，比 health 计数更贴 on 态执法判据。

## 2. G2（N-7·F-5）合成步骤 risk 如实化 —— `bridge.ts` + `index.ts`

**撞守卫预检命中**（任务书命令实跑）：`tests/` 内 `maxRisk ?? 'L2'` 零命中，但 `r19c-a5-fix4-risk.test.js`
F4b-1/F4b-2 两例**钉旧形态**（`steps[0].risk === 'L3' / === 'L2'`）。按实况同步（受契约保护变更）。

| 位置 | 改前 | 改后 |
|---|---|---|
| bridge.ts 常驻路径 step（旧 1545） | `risk: input.maxRisk ?? 'L2'` | `risk: WORKFLOW_RUN_RISK` |
| bridge.ts 单次路径 step（旧 1844） | `risk: input.maxRisk ?? 'L2'` | `risk: WORKFLOW_RUN_RISK` |
| bridge.ts 新常量 | —（无） | `const WORKFLOW_RUN_RISK: RiskLevel = WINDOWS_CAPABILITIES.find(c=>c.id==='appops.workflow.run')?.risk ?? 'L1'`（模块加载期从注册表取权威值，回落 'L1' 加注释交代；亲读 definitions.ts:400 现值=L1） |
| bridge.ts `LlmGoalInput.maxRisk` 字段 | 存在（透传消费） | **退役删除**（桥内两处改注册表值后零消费；`GoalRequest.maxRisk` 契约字段不动——scope/策略仍消费） |
| index.ts provider 透传行 | `...(goal.maxRisk ? { maxRisk: goal.maxRisk } : {})` | 删除 + 注释交代封顶执法通路归 scope→evaluate（批1 F-2/F-3） |
| r19c-a5-fix4 F4b-1/2 | `==='L3'` / `==='L2'` | `==='L1'`（两态同值=封顶通路已退役的判别性）+ 头注订正 Q4 旧裁定即 F-5 病灶 |

**核对 :98-105 注释宣称**：字段注释已随退役改写（不再宣称"步骤 risk 如实化用 maxRisk"，改述"封顶≠步骤风险，
权威通道=审批卡 token.risk〔F4a〕+ 合成步骤取 cap.risk 注册表值〔本件〕"）——与新形态语义一致。
`dep-lint` GREEN（llm→vm-capabilities 同层 L2 合法边，新增 import 不违方向铁律）。

## 3. G3（N-9）(c) 并发窄窗观测计数 —— `directWithActiveTurn`（纯附加零行为改动）

| 面 | 改动 |
|---|---|
| core `policy-gate.ts` | 新增纯函数 `isDirectWithActiveTurn(input)` = `requiresApproval ∧ delegationId===undefined ∧ activeTaskId!==undefined`；`PolicyGateHealthView` 补 `directWithActiveTurn`；`buildPolicyGateHealth` **改对象入参**（字段可独立缺省，观测扩展不再牵动位置参数序，判据仍纯函数） |
| vm-service `policy-gate.ts` 垫片 | 再导出补 `isDirectWithActiveTurn`（保持面） |
| core/vm-service 两处 `index.ts` | 再导出补 `isDirectWithActiveTurn` |
| server.ts `(c)` 判定现场（1519–1533） | 命中审批闸分支**先于** (c) 收口判定调 `isDirectWithActiveTurn({...channelProbe, requiresApproval:true})` ⇒ `policyGateCounters.directWithActiveTurn += 1` + warn（窄窗=「(c) 在场却不收口」，与收口分支互斥，顺序判别性钉死） |
| server.ts `buildHealth`（2456） | `buildPolicyGateHealth({... directWithActiveTurn: policyGateCounters.directWithActiveTurn})` 透传 |
| p3-b1 **新增 ⑨ 段**（任务书"补 ⑧ 段"，因原文件末尾已有"⑧ CL7"段，编号让位取 ⑨ 避免撞号） | 场景 A（直调+槽在场⇒真）/B（直调+槽空⇒假，(c) 生效面）/C（dtid 命中⇒假，非纯直调）真值表 + 与 shouldReturnDelegationRequired 互斥判别 + health view 五键同出 + server 装配钉（判据在 (c) 之前、计数器透传） |
| E2E 窄窗实锤 | 非阻塞委派 beginTask 后挂起屏障 ⇒ 活动槽在场时打无 dtid 纯直调 ⇒ `directWithActiveTurn +1` + 被按内层发令牌（(c) 不误伤）+ 放行后 scope 销账 ⇒ 同请求翻回 DELEGATION_REQUIRED 且计数不再涨 |
| 文档 SECURITY-GOVERNANCE §2.3 | 补窄窗限定句（"直调撞常驻 turn 窗口⇒被按内层处理=(c) 不触发；观测=`/health.policyGate.directWithActiveTurn`；显式身份标被 buildMcpConfig LEGACY_OUT 挡死⇒维持观测不修复"） |

**不作修复承诺**（任务书原话），warn-only 纯观测。

## 4. G4（M6 声明位）4 份域 SKILL 补 `meta.capability.list`

**现场漂移**（如实登记）：任务书称"app-operation 为唯一已声明者，亲读对齐其形态"——但亲读 `winvm-app-operation/SKILL.md`
全文**无 `meta.capability.list` 字面声明**（只有 `meta.health.check`/`meta.session.status`）；`git grep meta.capability.list
-- skills/` **全域零命中**，`git log --all -S` 仅命中批0 幽灵摘除（9dd13bd）与 audit 文本。任务书"唯一已声明者"现场不可达。
⇒ **按 M6 台账原意**（2026-10-12 §76 "7 份 SKILL 缺 `meta.capability.list` 声明" + 2026-10-14 §33 "4 份域技能=0"）
自拟统一措辞补 **4 份纯域技能**（system-admin/app-manager/storage-manager/gui-automation），置于各文件「## 能力清单」
表头下：声明 `meta.capability.list` 为发现类元能力、**下表=预期清单 vs 运行期暴露面权威**（provider degraded
⇒ 收窄仅 `meta.*` ⇒ 未暴露调用得 `CAPABILITY_NOT_EXPOSED`/`PROVIDER_UNAVAILABLE`，不重试先核对）。
措辞保守：ID 级权威指向 `tools/list`（亲验 `meta.capability.list` psmod 实现返回**模块名**非能力 ID 全清单——
既有名实偏差，不在此复写放大）。`winvm-app-operation`（已含 meta.health.check 前置）/`mcp-reference`（无统一声明表，
仅计数行）/`orchestrator`（总控，meta 提及充分）三份按任务书条件（"若 X 有统一声明表同步"）**不成立**不动。
claims-guard 判据 a（点分 token ∈ 注册 id ∪ 白名单）11/11 绿（`meta.capability.list` ∈ 注册表在册）。

## 5. G5（⚠-1 七处「封闭 10 码」随修·注释/文案面，**数组本体不动**）

| 处 | 文件 | 改动 |
|---|---|---|
| ①a | `mcp-reference/SKILL.md:83` | 表头「封闭 10 码」→「封闭码集，单源 `errors.ts`，登记 §2.6」；**枚举格补** `TASK_CANCELED` `DELEGATION_REQUIRED`（+ 排查规则列表补两码处置行，语义逐字对 §2.6） |
| ①b | `orchestrator/SKILL.md:352` | 表头去数字同 ①a；枚举补两码；retryable 说明行补两码专属处置（逐字对 §2.6） |
| ② | `adapter-agent-workbuddy/src/index.ts` | 四处注释去数字：文件头 BRIDGE_ERROR_CODES 声明块（加"镜像非逐字相等"批9 §8a 交代）、`:396`、`:1144`、`:1153`。**`BRIDGE_ERROR_CODES` 数组本体一字未动（10 项）**（grep 复核 `^  '[A-Z]` =10） |
| ③a | `cl017-error-reason.test.js` | `:8`/`:90`/`:140` 三处注释/标题句式去数字（`CONTRACT_CODES` 数组本体不动） |
| ③b | `vm-capabilities/src/ps-bridge.ts:480` | 注释「契约 10 码」→「契约层封闭码集」（域码不进 BRIDGE_ERROR_CODES 说明不变） |

**撞守卫预检**：`git grep "10 码" -- tests/` 命中项均为**自身留痕**（pin M4 变异夹具用"封闭 10 码"作变异输入、
fidelity/mcp-signal 注释描述历史）——R4 `DIGIT_REWRITE=/封闭\s*\d+\s*码/` 只扫 ERRORS/INSTALL **两文件**，
不扫 tests/skills ⇒ 无放宽判据、无绕行。`:1140`「旧实现只有 9 项白名单」是**历史实况**描述非现状数字复写，保留。

## 6. G6 漂移钉收集面扩至 SKILL 码表 —— `p4-b9-errcode-registration-pin.test.js` R5

**顺序合规**：G5① 先落地（591f8af）后加 R5（8e25bc3），R5 首跑即绿（非红，符合纪律）。

- `extractSkillCodeRow`：锚点切片取 `^\| \`error.code\`` **单行**内反引号包裹的纯大写蛇形 token（≥2 字符），
  剔除小写/含点 token（`retryable`/`error`/`reason`）。**关键**：领域码在独立的 `error.reason` 行，锚切片天然排除
  ⇒ 不误判成幽灵码（现场两 SKILL 契约码是**单格空格枚举**，非逐码 `| \`CODE\` |` 行——任务书"表体补两行"预设的
  逐码行形态不存在，按实况用枚举行提取，登记为形态差）。
- `checkSkillRegistration`：双向对账（missing=码集有表无 / ghosts=表有码集无），收集面 2→4 文件（+SKILL_MCPREF/+SKILL_ORCH，
  纳入 SRC/HASH/F 三方，SHA-256 磁盘自证随 `Object.entries(F)` 循环自动覆盖）。
- 变异自证（内存副本，零写盘）：M5 删一份 SKILL 一行码⇒missing 点名、M6 加幽灵码⇒ghosts 点名、
  M7 领域码混入契约行⇒判幽灵（**判据活性反证**，沿用批9 QA 打法）；各配真源未变异=空的反证。
- 判据下限：提取 <10 即红（表形态漂移=守卫失效显形）。

## 7. G7（V14 观测面补建）llmSession 工作集采样显形 —— 纯附加零行为改动

| 面 | 改动 |
|---|---|
| `persistent-session.ts` 字段 | 私有累计 `wsSampled/wsLatestBytes/wsPeakBytes/wsEvictions`（服务生命周期口径，与 `firstCallLatencyMs` 同族） |
| `tick()` 探针消费点 | 任何**数字样本**旁录 latest/peak；**超限触发软释放时** `wsEvictions+=1`（回收判据/行为逐字不变，纯观测） |
| `snapshot()` | `wsSampled` 为真 ⇒ 末尾条件追加 `wsLatestMb`/`wsPeakMb`（字节/1024² 一位小数）/`wsEvictions`；**未采样⇒三键整体不进**（K-13 禁显式 undefined + 守 `phase2-session-unknown` D6 键序钉：无探针夹具键序零变化，亲验 48/48） |
| `contracts/bridge.ts` | `LlmSessionHealth` 补三可选键（同进同缺注释交代） |
| provider/server **零改动** | 同步 SPI `llmSessionHealth()`→`bridge.sessionHealth()`→`snapshot()` 整体 spread ⇒ server.ts:2362/2477 已透传（缺探针时 undefined ⇒ `{...(llmSession!==undefined?{llmSession}:{})}` 块不进） |
| `restartFresh()` | **不清** ws 观测账（复位≠服务重启，历史采样/回收痕迹保留，与 firstCallLatencyMs 同保守口径） |
| 新件 | `p4-b10-ws-health-observe.test.js` 9 例：缺探针三键不进 / 未启动 tick 不触达 / 探针 undefined 不进（fail-safe 不误杀）/ 单样本值语义 / 先升后降 latest 跟新 peak 锁大 / 超限 evictions 递增 / MB 一位小数 / 字节判据不变 / restartFresh 不清账 |

**真机长跑采样（探针真实 spawn tasklist）留主理人观察窗**，本件只交付离线注入面。

## 8. 过关记录（逐件实跑，绝不整批）

| 件 | 结果 | 归属 |
|---|---|---|
| `p4-b10-resident-scope-e2e.test.js` | **11/11** | G1（10）+G3（窄窗 1） |
| `p3-b1-policy-gate.test.js` | **29/29** | G3 ⑧ 段 |
| `p4-b9-errcode-registration-pin.test.js` | **12/12** | G6（8→12，+R5+M5/M6/M7） |
| `phase3-skill-claims-guard.test.js` | **11/11** | G4/G5/G6 |
| `phase2-contract-code-fidelity.test.js` | **22/22** | G2/G5/G6 |
| `r19c-kn1-d-provider.test.js` | **28/28** | G2 |
| `phase2-mcp-signal.test.js` | **54/54** | G2/G5②（数组形态负断言未破） |
| `p4-b10-ws-health-observe.test.js` | **9/9** | G7 新件 |
| `r19c-a5-fix4-risk.test.js` | **4/4** | G2（F4b 订正） |
| `r19c-kn1-b-bridge.test.js` | **23/23** | G2 |
| `cl017-error-reason.test.js` | **10/10** | G5③a |
| `assembly-guard.test.js` | **24/24** | G3（server 装配） |
| `k5-replay.test.js` | **41/41** | G3（server 改动面） |
| `phase1-t4-assembly.test.js` | **45/45** | G3（server 源码钉） |
| `phase2-session-unknown.test.js` | **48/48** | G7（**含 D6 键序钉**） |
| `phase3-b6-ws-probe.test.js` | **13/13** | G7 |
| `phase3-b5-idle-recycle-budget.test.js` | **5/5** | G7（wsProbe 回收） |
| `r19c-kn1-c-session.test.js` | **17/17** | G7 |
| `cl018-persistent-session.test.js` | **19/19** | G7 |
| `phase3-b2-deadlink-fix.test.js` | **6/6** | G5①（读两 SKILL） |
| `r1-approval-card.test.js` | **69/69** | G5①（读 orchestrator） |

- `npx tsc -b tsconfig.build.json`：**EXIT=0**（多次重建，含 G2 新 import、G3 core 签名改、G7 契约+session）。
- `node scripts/dep-lint.mjs`：**GREEN**（G2 llm→vm-capabilities 同层合法边）。
- **F-5 grep 清零**：`grep -n "maxRisk ?? 'L2'" bridge.ts` → **0 命中**（验收锚达成，病灶注释已避开字面序列）。
- **全量 gate 由主理人跑**（未自触 `scripts/gate.mjs`，避免并发）。

## 9. 残留（不闭项如实登记）

- **G1 无卡点**（任务书预留条件不成立，完整链路离线可跑通，判据面零 mock）。
- **V14 真机长跑采样**（tasklist 真实读数）留主理人观察窗——G7 只交付离线注入面。
- **V3/V4 真卸载窗**（破坏性，不主动执行）归主理人独立处理。
- **`meta.capability.list` 名实偏差**：psmod `listModules` 返回**模块名**（app/storage/...）而非能力 ID 全清单，
  与注册表 description「列出当前已注册并暴露的能力清单」有既有落差（批0 幽灵摘除遗留窄面）——G4 措辞已保守规避
  （ID 权威指 `tools/list`），**未改 psmod 实现**（不属本批处方，登记为后续可修窄面）。
- **G2 字段退役面**：`LlmGoalInput.maxRisk` 删除仅限桥内输入形状；`GoalRequest.maxRisk`（契约）、
  host-bridge delegate schema **未动**（仍承载 scope 声明通路）。
- **G4 现场漂移**：任务书"app-operation 唯一已声明者"与实况不符（全域零字面声明），按 M6 台账原意执行 4 份补齐 +
  自拟统一措辞，**未伪造 app-operation 既有形态**（登记 §4）。
- **`.workbuddy/memory/.../memory.md`**：会话自动生成，非本批改动，未纳入任何 commit（`git restore --staged` 剔除）。

## 10. 分笔提交（本批，基线 5daf055 之后）

| 笔 | 哈希 | 摘要 |
|---|---|---|
| G1 | `c70d2f0` | 常驻 scope 链服务级 E2E 新件 |
| G2 | `e271596` | 合成步骤 risk 注册表权威值 + maxRisk 透传退役 + F4b 同步 |
| G3 | `b4fc9e3` | directWithActiveTurn 窄窗观测计数（core+server+垫片+⑧段+E2E实锤+文档） |
| G4 | `1e1f81e` | 4 份域 SKILL 补 meta.capability.list 声明位 |
| G5 | `591f8af` | 七处「封闭 10 码」注释/文案随修（数组不动） |
| G6 | `8e25bc3` | 漂移钉 R5 扩 SKILL 码表收集面 + M5/M6/M7 变异 |
| G7 | `06164ce` | llmSession 工作集观测透传 + 新件 |
| notes | 本笔 | 施工记录（台账批10行不动，主理人收口统一改） |

## 11. QA 回归修正（⚠①）—— 五处 SKILL 归因订正（未暴露直调实为 JSON-RPC -32602）

- **现象**（QA 亲验+主理人复验）：G4 声明段末句写「未暴露能力直接调用会得到
  `CAPABILITY_NOT_EXPOSED` / `PROVIDER_UNAVAILABLE`」——归因失实（把两条语义各异的码
  错安在"未暴露直调"这一不产出它们的场景上）。
- **根因/实况锚点**（本次亲验）：未暴露能力**不进 `mcpTools` 注册**
  （server.ts:1425 `mcpTools = exposedCapabilities.map`），MCP 框架对清单外工具名直接回
  **JSON-RPC `-32602` 未知工具**（mcp-framework/src/server.ts:240），**不经策略/契约码通路**；
  `CAPABILITY_NOT_EXPOSED` 仅在**批准后服务端重放路径**产出（server.ts:1334–1355，token
  留存能力不在暴露面的复核早退）；`PROVIDER_UNAVAILABLE` 是**已暴露**能力在 provider
  未就绪时的返回——与"未暴露"两回事。
- **修正五处**（文档措辞面，同族同步）：
  | # | 文件:行（改后） | 修正 |
  |---|---|---|
  | 1 | `winvm-system-admin/SKILL.md:53-56`（M6 声明段） | 末句改「未暴露能力不会进入工具清单，直调得到 JSON-RPC `-32602`（未知工具）而非契约错误码；`CAPABILITY_NOT_EXPOSED` 仅在批准后重放路径出现，`PROVIDER_UNAVAILABLE` 指已暴露能力的 provider 未就绪态（均与"未暴露直调"无涉——不重试，先核对暴露面）」 |
  | 2 | `winvm-app-manager/SKILL.md:52-55` | 同 ①（四份逐字一致） |
  | 3 | `winvm-storage-manager/SKILL.md:69-72` | 同 ① |
  | 4 | `winvm-gui-automation/SKILL.md:63-66` | 同 ① |
  | 5 | `winvm-orchestrator/SKILL.md:142` | 括号内旧句「域能力调用会得到 `PROVIDER_UNAVAILABLE`/`CAPABILITY_NOT_EXPOSED`」→「已暴露的域能力调用会得到 `PROVIDER_UNAVAILABLE`，未暴露能力此时直接 `-32602` 不在工具清单」（provider 降级语境保留） |
- **撞守卫预检**：`git grep "CAPABILITY_NOT_EXPOSED" -- tests/` = **零命中**（无测试钉旧措辞；
  claims-guard b/c 判据不含该词面，预期零红成立）。
- **复跑**：`phase3-skill-claims-guard` **11/11**、`p4-b9-errcode-registration-pin` **12/12**
  （R5 只扫 `error.code` 码表行，声明段措辞不入其收集面）。
