# P4 批10 QA 独立回归验证报告（software-qa-engineer-2 / 严过关）

- 基线：`5daf055` 之后九笔（c70d2f0 G1 → e271596 G2 → b4fc9e3 G3 → 1e1f81e G4 → 591f8af G5 → 06164ce G7 → d08fa8b notes → 17a2ca5 证据归档）
- 纪律：不采信任何自报；逐件 `node --test tests/unit/<单文件>` 亲跑（零 glob）；变异全在 `/storage/Users/currentUser/wbtmp/qa-b10/`（仓库零写盘，本报告除外）；不碰 VM/隧道/deploy；不跑全量 gate。
- **终判：IS_PASS: YES**（12/12 件亲跑全绿、三红线全部守住、四组活性反证全红；2 项 ⚠ 文档口径类路由主理人，非阻塞）

---

## V1 逐件亲跑（期望自报 vs 实际）

| 件 | 期望 | 实际 | 结论 |
|---|---|---|---|
| `tests/e2e/p4-b10-resident-scope-e2e.test.js` | 11 | **11 pass / 0 fail** | ✅ |
| `tests/unit/p4-b10-ws-health-observe.test.js` | 9 | **9/0** | ✅ |
| `tests/unit/p4-b9-errcode-registration-pin.test.js` | 12 | **12/0** | ✅ |
| `tests/unit/p3-b1-policy-gate.test.js` | 29 | **29/0** | ✅ |
| `tests/unit/phase3-skill-claims-guard.test.js` | 11 | **11/0** | ✅ |
| `tests/unit/phase2-contract-code-fidelity.test.js` | 22 | **22/0** | ✅ |
| `tests/unit/r19c-a5-fix4-risk.test.js` | 4 | **4/0** | ✅ |
| `tests/unit/r19c-kn1-d-provider.test.js` | 28 | **28/0** | ✅ |
| `tests/unit/phase2-mcp-signal.test.js` | 54 | **54/0** | ✅ |
| `tests/unit/r1-approval-card.test.js` | 69 | **69/0** | ✅ |
| `tests/unit/phase2-session-unknown.test.js` | （未列期望） | **48/0**（notes 自报 48 一致，D6 在） | ✅ |
| `tests/unit/assembly-guard.test.js` | 24 | **24/0** | ✅ |

独立复跑 `tsc -b tsconfig.build.json` ⇒ **exit 0**。合计 12 件 321 例全绿，与自报逐件一致。

## V2 G1 E2E 质量深检（批10 主项，防侥幸绿）——✅

① **判据读实**：
- shadow 态断言为**增量式**：先 `getHealth().policyGate.shadowHits` 取 hits0，委派后断 `> hits0`（test:244-263、266-280、360-363 三处），非恒真；服务端 `shadowHits` 唯一累加点 `server.ts:1193`（`enforceScopeRejection=false ∧ !allowed ∧ !requiresApproval ∧ isScopeGateRejection`）——计数与执法严格分离实读确认。
- on 态 `matchedRule` 走**真审计链反查**：`readChainEntries` 轮询 mkdtemp 目录 jsonl 全文（test:143-167），断言 `policyDecision.matchedRule === 'scope:capability-not-in-allowed-set' ∧ result.errorCode === 'POLICY_DENIED'`——规则名**亲读源码实名对照**：`packages/core/src/policy/engine.ts:608`（scope 闸字面量）与 `:763`（`maxRisk:${maxRisk}` 模板）逐字命中；`maxRisk:L1` 链上证取同理。**行为测试非源码钉**（钉在 p3-b1 ④/⑧ 段另有其位，本件判据全走服务端真实装配）。
- **真 createService**：两处 `before` 钩子（test:212-227 / 376-390）真起 `createService`（19481/19482 端口、真 A2A `message/send`、真 HTTP 回连 `/mcp` 无 dtid）；provider 仅以进程内工厂替身注入（`registerProviderFactory`，忠实复刻 CliLlmBridge 的 beginTask→回连→finally endTask 包裹形态），策略判定/scope 回查/(c) 收口/shadow 改道**零 mock**。

② **活性反证（两例，内存副本，全红）**：
- **MUT-A**（`WINVM_POLICY_GATE_WIRING 'on'→'shadow'`，测试副本）：11 例 ⇒ **3 fail**——on 态 scope 执法②、maxRisk 封顶③、F-3 零断崖断言全灭。判据对灰度档位敏感 ✅。
- **MUT-B**（dist 副本 `onGoalAccepted` 的 `if (goal.taskId)` 改 `if (false && goal.taskId)` ⇒ scope 注册整体摘除）：11 例 ⇒ **6 fail**——shadow 改道计数、内层不误伤、窄窗 scopeEntries、on 态两闸链上证取、④ 判别性全灭。判据对 scope 回查链真实依赖 ✅（绝非"摘掉注册也绿"的装饰件）。

③ 附加判别性实读确认：④ 段 terminal 后 `scopeEntries===0` + 同请求翻 `DELEGATION_REQUIRED`（retire+槽清除双翻转）；N-9 窄窗段用真并发屏障（非阻塞委派 + turnHold Promise）实测计数 +1→放行→不再涨。

## V3 G3 红线：零行为改动——✅

`git show b4fc9e3` 逐 diff 审（8 文件）：
- core：`isDirectWithActiveTurn` 纯函数（三事实全服务端现场，无副作用）+ `PolicyGateHealthView` 附加字段 + `buildPolicyGateHealth` 位置参数改对象入参（调用面全仓仅 server.ts:2456 与 p3-b1 测试两处，均已同步，无第三方调用者破坏）。
- server：**仅**计数器声明 + `requiresApproval` 分支内先于 (c) 的计数块（`+= 1` + `logger.warn`，无 return/无控制流改变）+ health 字段透传。计数器判据与 (c) `shouldReturnDelegationRequired` 的块顺序（先计数后收口）实读确认。
- 双 index/垫片仅导出追加；docs 一句限定话；测试新增。
- **互斥钉在位**：p3-b1 ⑨ 段（:336 起）真值表四形态（直调+槽在场=计 / 直调+槽空=不计 / dtid 内层=不计 / 非审批闸=不计）+ 互斥判别（窄窗真 ⇒ `shouldReturn=false`，同请求不得双计数）+ 装配顺序钉（计数须先于 (c)）+ E2E 真并发计数 +1/不再涨。29/29 绿。

## V4 G2 检查——✅

① 取值链：`WORKFLOW_RUN_RISK = WINDOWS_CAPABILITIES.find('appops.workflow.run')?.risk ?? 'L1'`（模块加载期）；注册表现值**亲核两处一致**：`registry/definitions.ts:400 risk:'L1'` + dist 动态 import 实读 `registry risk = L1`。回落 L1=现值语义合理（漂移面注释交代，绝不回落 'L2' 冒充）。
② 摘除后残留 grep：`LlmGoalInput` 全仓消费面仅剩函数签名/类型位（14 处），无 `input.maxRisk` 读取；`goal.maxRisk` 消费全在**契约 GoalRequest→scope 留存合法通路**（adapter:336/583 scopeMaxRisk、server:1766/1775/1845、delegation-audit/scope）——与 notes §9"字段退役面仅限桥内输入形状"登记一致，零断链。
③ F-5 复跑：`git grep -n "maxRisk ?? 'L2'" -- packages/` ⇒ **零命中**（exit 1）。
④ F4b 语义审判：**收紧非放宽**——旧断言 L3-specified⇒'L3'、缺省⇒'L2'（两态异值=透传通路在场）；新断言两态均 ⇒'L1'（异值通路被摘除的判别性，且 `runOneshot` 仍传 maxRisk='L3' 作"注入也不变"活性探针）。测试文件传多余键在 JS 层无运行时效应，恰构成 F-5 清零的行为证据。

## V5 G5/G6 联动与红线——✅

① `git show 591f8af -- adapter index.ts` 过滤非注释行 ⇒ **零输出**（纯注释面）；数组本体亲读 `index.ts:37-47` 十项原样（INVALID_PARAMS…EXECUTION_FAILED），`BRIDGE_ERROR_CODES` 未动。
② 三源互核（独立脚本）：errors.ts 封闭集 12 码 ↔ §2.6 表 12 行 ↔ 两份 SKILL 码表各 12 码，双向差集 **∅/∅**（`extractSkillCodeRow` 亲提两表均 12）。
③ **R5 独立变异反证**（`wbtmp/qa-b10/mutate-r5.mjs`，直调导出纯函数，零写盘）：MUT-A 删 mcp-reference 码表 `TASK_CANCELED` ⇒ missing 点名 ✅红；MUT-B orchestrator 混入领域码 `FILE_NOT_FOUND` ⇒ ghosts 点名 ✅红；MUT-C 注入自造幽灵码 `GHOST_QA_B10` ⇒ ghosts 点名 ✅红；基线两表 clean（判据不空转前提成立）。与件内 M5/M6/M7 互印——**R5 是活判据非装饰**。
④「封闭 10 码」全域复扫（排除 docs/audit、docs/changes、qa、.workbuddy/memory 留痕）：命中仅 `p4-b9-errcode-registration-pin.test.js` 自身（L12/22 防回潮注释 + L269-270 M4 变异载荷字面量，**属守卫本体职能非残留**）⇒ 产品/文档面残留 **=0** ✅。R4 防回潮钉在位（12/12 含 M4 红证）。

## V6 G7 K-13 红线——✅

① 未采样⇒三键不进：pin 测试 9 例中 3 例专钉（缺探针/未启动 tick/探针返 undefined ⇒ `Object.keys(snap)` 无 ws* 键，且 state 不误杀）；**独立恒追加变异反证**：`ps-mut-alwaysappend.js`（`...(this.wsSampled` ⇒ `...(true`）+ 变异测试副本重定向 PKG ⇒ **3 fail**（三例缺席断言全灭）——K-13 守卫为活 ✅。
② 透传链一致：contracts `LlmSessionHealth` 三可选键（bridge.ts，`?` 同进同缺注释）→ provider `llmSessionHealth()`（index.ts:378）→ `bridge.sessionHealth()`（:1092→snapshot 条件追加 src:324-328，与 dist 编译一致）→ server `provider?.llmSessionHealth?.()`（:2362）→ `{...(llmSession !== undefined ? { llmSession } : {})}`（:2477）——SPI→spread 链零改动实读确认（G7 diff 三面仅 +272 行纯附加：persistent-session 旁录 + contracts 键 + 新件）。
③ restartFresh 不清账：notes **§7**（G7 节 :139）有据（复位≠服务重启，历史采样/回收痕迹保留，与 firstCallLatencyMs 同保守口径——判读：运维复位后"峰值已消失"误读风险 > 账目陈旧风险，口径合理）；测试第 9 例钉 `wsEvictions`/`wsPeakMb` 保留 + `restarts` 归零分离。

## V7 口径一致性抽查——✅（附 1 ⚠ 路由）

- G4 四份 SKILL 声明段**逐字互读一致**（system-admin/app-manager/storage-manager/gui-automation 四段同文，6 行/+24 总计与 stat 吻合）。
- claims-guard：`git log c70d2f0~1..HEAD -- tests/unit/phase3-skill-claims-guard.test.js` ⇒ **批10 零改动**（最后触及仍为批9 9e77690）——无判据放宽，合规。
- `meta.capability.list` 注册实名亲核：`registry` L107 id + L110 `risk:'L0'`——声明段"（L0，全域通用）"名实相符。
- ⚠-1/⚠-2 见下。

---

## ⚠ 发现（非阻塞，路由主理人裁断）

### ⚠-1 G4 声明段末句错误码归因不实（文档教学面）
- **现象**：四份新声明段（及 notes :96）称"对未暴露能力**直接调用**会得到 `CAPABILITY_NOT_EXPOSED` / `PROVIDER_UNAVAILABLE`（不重试，先核对暴露面）"。
- **根因**：实证通路并非如此。真实探针（`wbtmp/qa-b10/probe-unexposed.mjs`：provider 仅声明 `meta.*` 起真服务，直调 `storage.file.delete`）⇒ **HTTP 200 + JSON-RPC `-32602 "未知工具"`**（未暴露能力根本不进 `mcpTools`，`server.ts:1425` 以 `exposedCapabilities` 注册，框架层 `callTool` 查不到 tool 即协议错，永不到达能力层错误码）。`CAPABILITY_NOT_EXPOSED` 实为**批准后重放路径**专属（`server.ts:1334-1355` `replay:capability-not-exposed`）；`PROVIDER_UNAVAILABLE` 属执行段/provider 缺席早退（:1261 族）。该措辞与 orchestrator:142 既有句同族承袭（批9 前旧文），G4 复制进四份新段时未实证。
- **证据**：探针输出（本会话亲跑）+ `server.ts:1425/718-720`、`mcp-framework/src/server.ts callTool "未知工具"`、`server.ts:1345/1355`、notes §9 已自登记"capability.list 名实窄面…ID 权威指 tools/list"（同一病灶的近亲，规避了清单面但未规避错误码面）。
- **路由**：**主理人裁断**（非源码缺陷、非本批处方项；修复涉及 4+1 份 SKILL 口径统一——建议改写方向："未暴露能力**不在 `tools/list`**，直接调用会在协议层被拒（未知工具）；批准后重放期撤暴露才得到 `CAPABILITY_NOT_EXPOSED`"）。未自行落笔：单改四份将与 orchestrator:142 旧句失同步，措辞归批11 文档面统一处理更净。
- 影响定级：教学面归因窄偏，处置建议（"不重试，先核对暴露面"）本身正确 ⇒ **不阻塞过关**。

### ⚠-2 台账批10 行"声明位 7/7"验收口径歧义（登记面）
- **现象**：台账验收列"声明位 7/7"；严格字面 `meta.capability.list` 现命中 **4/7**（G4 新增四份），app-operation/orchestrator/mcp-reference 仅宽松口径（"能力清单"/references 文档）命中。
- **根因**：台账批4 行原计数即宽松口径（"orchestrator(3)/app-operation(1)"非字面命中），7/7 沿用宽松计数；notes §4 已如实登记现场漂移与执行裁量（"任务书与现场不符按 M6 台账原意执行"）。
- **证据**：`grep -rl "meta.capability.list" skills/`（4 文件）vs 宽松模式（7 文件）两态亲跑；notes §4/§9。
- **路由**：主理人收口改台账批10 行时**二选一**：标注"7/7（宽松口径）/4/7（字面声明段）"双计数，或维持宽松并注口径脚注。非施工缺陷。

## ❌ 无

---

## 活性反证汇总结论

| 反证 | 施加面（全内存/仓库外副本） | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| MUT-A E2E on→shadow | 测试副本 env | 红 | **3 fail** | ACTIVE |
| MUT-B E2E scope 注册摘除 | dist 副本 server.js | 红 | **6 fail** | ACTIVE |
| R5 三变异（删码/领域码混入/幽灵码） | 导出纯函数直调 | 红 | 全部点名显形 | ACTIVE |
| G7 恒追加（K-13 击穿） | dist 副本 persistent-session | 红 | **3 fail** | ACTIVE |
| 反向验证（原样件复跑） | — | 绿 | 12 件 321 例 0 fail | 基线绿真实 |

**终判：IS_PASS: YES** —— 批10 九笔交付面全部亲验过关：G1 主件为真链路行为级 E2E 且判据活性实证；G2/G3/G5/G6/G7 红线（零行为改动/数组本体不动/K-13/F-5 清零）全部守住；两项 ⚠ 均为文档归因/登记口径类，路由主理人，不构成回炉。
