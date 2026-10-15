# GATE-POLICY —— 哪些判据进门禁、哪些不进（Phase 2 · P2-T11）

> **权威口径**：本文件与 `scripts/gate.mjs` 里的 `GATE_GUARD_FILES` / `GATE_EXCLUDED` 是**双写**，
> 二者不一致时以 `gate.mjs` 为准（代码是执行面，文档是说明面）——但同时在本仓纪律里，
> 「文档写了而执行面没有」正是 Phase 2 命题禁止的**第四种状态**。⇒ 改表必须同批改两处。

---

## 0. 强制条款（PR9 的文档对冲）

> **跳过门禁即视为未验收。**

设计 §365 PR9 明写这一风险的成因：本仓**无 CI**（残留评级「中（无 CI 的结构性残留）」），
门禁的唯一强制力来自「人记得跑」。PM-08 裁决 = 优先做**零平台成本门禁**（本地即拦，CI 后置），
Q8 用户裁决 = 纳入 Phase 2（理由原文：「否则 F1/F4 的所有守卫仍是文档承诺」）。
Phase 1 的直接教训是同族的 `layout`：脚本键指向不存在的 `dep-lint`，**写了却没人能跑**，最终被删。

⇒ 因此本文件的职责不是"介绍有个工具"，而是把「哪些防线有强制力、哪些没有、为什么」写成
**可审计的事实**。任何一条守卫若既不进门禁、也没有其它强制面，它就只是文档承诺。

### 使用方式

| 档 | 命令 | 内容 | 预计耗时 | 用途 |
|---|---|---|---|---|
| **quick** | `npm run gate:quick`（= `node scripts/gate.mjs --quick`） | ST1+ST2+ST2b+ST3 | 约 1–2 分钟 | 改完代码/提交前自查；dep-lint 与守卫件的廉价强制面 |
| **full** | `npm run gate`（= `node scripts/gate.mjs`） | + ST4 全仓逐文件 sweep | 约 25–30 分钟 | **批次收官**；等价于主理人亲跑的 sweep |
| **lock-probe** | `npm run lock-probe` | 真机会话前置判定（只读） | < 10 秒 | 占用真机窗口**之前**跑（设计 §3.4 E-3） |

`--out <file>` 把结果逐行落盘（长档期的心跳面）；`--stage=<a,b>` 只跑指定段（排障用，
**不构成验收证据**）。

---

## 1. 进门禁的判据

### ST1 `tsc -b tsconfig.build.json`（build）

| 判据 | 为什么必进 |
|---|---|
| 12 包全量编译 exit 0 | PR9 的**直接要求**：`dep-lint` 读 `packages/*/dist`，不先 build 则门禁判的是上一版产物（"源码改了、产物没改"）。同时它是 K-3（消费 dist 的测试先 build 后跑）的第一步 |

gate 在 ST1 失败时**立即终止并返回 2**（不假装后续段有判定意义）。

### ST2 `dep-lint`（依赖方向，读 dist 产物）

判据事实源：`ARCHITECTURE.md` §2.1「依赖方向（单向，禁止反向）」+ 设计 §4.4 第 1–3 点。
分层 rank 取各包 `package.json` 的 `layer` 字段（机检单一事实源）。

| ID | 判据 | 严重级 | 依据 |
|---|---|---|---|
| `LAYER_DIRECTION` | 低 rank 包 import 高 rank 包（反向边） | **hard** | ARCHITECTURE §2.1 依赖铁律；设计 §258「低层包 import 高层包 ⇒ 红」 |
| `UNDECLARED_EDGE` | dist 有真实 import 边但 `package.json` 未声明（幽灵依赖） | **hard** | 可靠性判据：宿主分发产物只带 `dist`+`package.json`（无 `node_modules`），`delivery/link-workspace.mjs` 按声明补 junction ⇒ 声明漂移在部署形态上运行期直接炸。属可靠性，不受 Q7「只 warn」约束（Q7 的只 warn 限定语是"除框架审计边外"中的**审计边**，见下） |
| `FRAMEWORK_TO_BUSINESS` | `a2a-framework`/`mcp-framework` import `vm-service`/`vm-capabilities`/`adapter-*` | **hard** | **既有铁律的机检化**，不是新增严格化：ARCHITECTURE §2.1 原文「frameworks──依赖──▶ contracts + core（**禁止依赖 adapters**）」 |
| `AUDIT_EDGE_IN_FRAMEWORK` | 框架包 import **审计符号** | **warn** | 设计 §254 末句「框架层永不 import 审计语义」+ §258 第 3 条。按 §13 **Q7 裁决**「首月除框架审计边外只 warn」取 warn；`--strict-warn` 一键升级为 hard（到期切换用，不改代码） |
| `DECLARED_UNUSED` | 声明了依赖但 dist 无该语句边 | **info** | 不判违规：两类成因都是**设计选择** —— ① type-only import 编译期擦除（`mcp-framework`/`adapter-host-workbuddy`/`vm-capabilities` → contracts 实测全是这种）；② provider 动态装载（`vm-service` → `adapter-agent-workbuddy-llm` 经 `core/bridge/loader.ts`）。仅显形，供人判断是否该收紧 |
| `DIST_MISSING` / `ROOT_UNREADABLE` / `LAYER_UNKNOWN` | 无法判定 | **hard**（exit 2） | 「判不了」必须与「判违规」区分；新增层位未登记 `LAYER_RANK` ⇒ 强制同步，防静默漏判 |

**审计符号清单不硬编码**（K-10：永绿守卫等于没有守卫）：从
`core/dist/index.js` 中**源路径含 `audit`** 的具名再导出 + `contracts/dist/audit.js` 顶层导出**派生**。
实测当前 = 7 个符号（`HashChainAuditSink / canonicalJson / sha256 / computeRecordHash / redact /
ARCHIVE_VERIFY_MAX_SHARDS / GENESIS_HASH`）。core 未来新增 `audit/*` 导出会**自动**进入判据面。

**已知盲区（如实登记，不假装覆盖）**：TS `interface`/`type` 编译期擦除 ⇒ 框架侧若只
`import type { AuditRecord }` 从 dist 取不到。该面由 `FRAMEWORK_TO_BUSINESS` 与
`LAYER_DIRECTION` 兜住（`@winvm/vm-service` 等真实包边不会因类型擦除而消失）；类型级审计耦合
仍需人工核对，**没有**运行期防线 —— 这条承诺不成立，所以不写成成立的。

### ST2b `config-key-lint`（配置全键集白名单）

来源：设计 **§13.2-②**（P2-T2 独立验证者遗留、主理人明令转入本批）：
「**policy 全键集白名单守卫**（现仅逐键告警已知死键，任意未知键仍静默透传）⇒ 列入 P2-T11 gate 候选判据」。

本批实测（K-10 证伪先行）确认「静默透传」成立：
`validateServiceConfig` 喂 `policy:{totallyUnknownKey:1}` ⇒ `errors=0 / warnings=0`；
顶层多一个 `notASection` 同样零告警。⇒ 病灶与 ARCH-18 命令白名单、P2-T2 `approvalTimeoutMs`
同族：**配了却不生效还不吭声 = 假安全感**。

| 判据 | 严重级 | 说明 |
|---|---|---|
| 配置资产的**全部键名 ⊆ 派生白名单**（顶层段名 + 段内键名，两层） | **hard** | 白名单**派生自 TS 类型**（`ServiceConfig` 成员类型表达式 → 逐段解 `PolicyConfig`/`SecurityConfig`/…/union type `TransportDecl` 取分支并集），**不抄第二份手写清单**（手抄 = 漂移源）。取不到 interface ⇒ **exit 2 拒绝判定**，不当白名单为空 |
| `$schema` / `comment` / `_comment` / `note` / `notes` | 放行 | 注释性键；`delivery/vm-service.config.json` 的 `policy.comment` 已在用，禁掉会让工具开箱即红 |
| `agent.providers.<id>`、`transport.preferred[]`、`providers.<id>.options` | 不判 | **天然开放集合**（provider id 由 `agent.provider` 选单；options 是各家自由参数）。判深度固定 2 层，写在 `JUDGED_DEPTH` 常量里 |

**为什么是交付面静态守卫、而不是往 `validateServiceConfig` 加运行期告警**：两条既有纪律同时禁止
运行期版本 —— ① **Q1=(b) 裁决**（交付面单测 + 门禁，不入运行期）；② **运行期零新依赖纪律**
（`phase2-contract-schema.test.js` 头注原文：运行期**不**接本校验）。⇒ 本批 **src 零改动**，
强制力落在部署前 + 门禁。口径差异明写在这里，避免造出「文档说运行期校验、实际只在门禁校验」的第四种状态。

### ST3 进门禁的守卫件（quick 档与全量档都跑）

入选标准（**三条全满足**才进 ST3）：
(a) 纯离线（零 VM / 零真机 / 零网络 / 零隧道）；
(b) 判据属**安全承诺 / 契约保真 / 分层纪律**族 —— 即失效后果 = 文档与运行态分叉（Phase 2 命题本体）；
(c) 单文件耗时可接受（< 30s）。

> **例数口径（2026-10-13 批0 订正，K-18「测试基线数字只写实测」自家纪律）**：下表旧版静态维护了各件例数（如 snapshot-truth "17"），随批次增删用例必漂——静态数字列已删。查任意一件的**实测例数**：`node --test tests/unit/<文件> 2>&1 | tail -3`（读 `# tests` 行），或读最新全量 sweep 的对应逐文件行（查法见 `README.md` §8 基线口径）。

| 文件 | id | 入选理由 |
|---|---|---|
| `phase2-snapshot-truth.test.js` | snapshot-truth | ARCH-04 事实三元组（声明/消费/承载）防再漂移 = 用户 **Q2 裁决「降级为信息性」**的唯一强制面；被悄悄改回「宣称实现」必须在这里红 |
| `phase2-dead-config.test.js` | dead-config | 死字段删除族 + 旧键**恰一条**告警（PR2）；安全承诺型配置不得静默失效 |
| `phase2-contract-schema.test.js` | contract-schema | schema 交付面校验 + schema↔`CAPABILITY_DOMAINS` 漂移守卫；**Q1=(b)** 把校验点定在交付面 ⇒ 交付面必须有强制力 |
| `phase2-contract-code-fidelity.test.js` | contract-code-fidelity | O-1 契约码保真 = **安全性质**（策略拒绝被压平成 `EXECUTION_FAILED` 后可被 `shouldDegrade` 绕过） |
| `phase2-session-unknown.test.js` | session-unknown | P2-T9 未知态 + **PR8 红线**「`isGuiAllowed` 行为零放宽」——GUI 门禁被无意放宽属安全回归面 |
| `assembly-guard.test.js` | assembly-guard | S-4/A5 **装配点**守卫：重构删掉注入点时上千例纯函数测试**照样全绿**（Phase 1 体检原话），只有这里拦得住取证盲区复活 |
| `psmod-contract.test.js` | psmod-contract | 注册表 ↔ PowerShell **跨语言隐式契约**（54 条映射）：编译器与 `tsc` 都看不见它；2026-10-08 全维度体检实测当时**零回归覆盖** |
| `phase3-skill-claims-guard.test.js` | skill-claims | 批0 文档止血的**反向守卫**：SKILL/治理面点分 token ∈ 注册 id ∪ 白名单（幻觉能力钉）+ 续跑承诺现在时回潮钉（P0-1 四处文案族）+ 收集面下限断言（防目录迁移致判据空转恒真）。**QA 回归 D-3 补登记**——此前"写了没进 ST3"恰是本守卫反对的"写了没人跑"病灶自体复现 |
| `p4-b9-errcode-registration-pin.test.js` | errcode-registration-pin | Phase 4 批9（N-2/N-6）**错误码登记漂移钉**：`errors.ts` 封闭码集 ↔ `INTERFACES.md` §2.6 表**双向**对账（加码欠登记⇒红、表私加幽灵码⇒红、retryable 列与 `DEFAULT_RETRYABLE` 实值不符⇒红）+「封闭 N 码」数字复写防回潮钉；N-2 同病再发两次（10→12 两次欠账），只有机检能终结 |

> **裁决项去向注**：设计 §6 P2-T11 行的字面表述是「契约一致性 + schema shape 校验」⇒ 上表
> `contract-schema` / `contract-code-fidelity` 两行即其承载；§13.2-② 的 policy 白名单 ⇒ ST2b 承载。
> 本表刻意**不**为 ST2b 再造一个同名 `.test.js`：那样只测「工具会不会报错」，测不到裁决要的东西。
> `config-key-lint` 的判据自证（白名单派生、假配置注入 ⇒ 应红、真机配置资产 ⇒ 应绿）落在
> `tests/unit/phase2-dep-direction.test.js` 的独立 describe 里，与 dep-lint 同属「scripts/ 静态守卫」族。

### ST4 全仓逐文件 sweep（**仅全量档**）

`tests/unit/` 全部 `*.test.js` + `*.test.mjs`，**逐文件独立子进程**。这是 K-2 的实现点，
也是「测试基线只进不退」（K-1）的证据面。ST3 已跑过的文件不重复（省时且计数不双记）。

---

## 2. **不进门禁**的判据与理由

设计 §267 的警告是双向的：「**不进门禁的守卫会慢慢失效**」。⇒ 不进门禁必须给理由，
把「为什么不跑」变成可审计事实，而不是遗忘。

| 范围 | 为什么不进 ST3 | 那它在哪儿被覆盖 |
|---|---|---|
| 真机/VM 依赖件（`qa/r19/` 全部 `.mjs`/`.ps1` 探针、`deploy-vm` / `install-vm` 实跑路径） | 需 VM 隧道 + 真实交互会话，违反入选标准 (a)。本地强跑 = 隧道黑洞时门禁**恒红** ⇒ 门禁本身失效（PR3 同族病灶：探针自身故障不该改判） | 真机窗口档期，由主理人派工 + `lock-probe` 前置判定 |
| SSH 隧道与传输件（`ssh2-resolve` / `tunnel-daemon` / `oh-tunnel` / `tunnel-mode` / `preflight` / `deploy-conn-side`） | 平台/环境相关，恒含 `OFFLINE_SKIP`（`ssh2-resolve` 的 **2 skip 是既有权威口径，不得当回归**，K-1） | ST4 全量档覆盖（逐文件） |
| 宿主沙箱平台件（`sandbox-allowwrite` / `launcher-posix` / `path-util-posix` / `account-resolve`） | 判据本体是鸿蒙/POSIX 宿主行为，与仓库分层/契约纪律无关，属部署面 | ST4 全量档覆盖 |
| `link-workspace.test.js` | **本仓 junction `0xC0000005` 假全红的已知触发源**（K-2）。它自己逐文件跑是绿的，但绝不与其他文件同批 spawn | ST4 逐文件档（gate 恒逐文件 spawn ⇒ 天然安全）；任务书「单独跑，勿入任何 glob」在 gate 里等价于「不入 glob」 |
| 运行期接线（schema 校验入能力注册期 / bearer 自检常开 / policy 未知键**拒启**） | **Q1=(b) 裁决明确「不入运行期」**；本门禁是**交付面**强制力，不是运行期防线。混为一谈正是「文档说有、运行期没有」 | 不覆盖 —— 这是**已裁决的设计选择**（SECURITY-GOVERNANCE §3.2 第 3 条的「现状限定」改述已如实写明） |
| `AUDIT_EDGE_IN_FRAMEWORK` 的**类型级**耦合（`import type { AuditRecord }`） | TS 编译期擦除 ⇒ dist 取不到，见 ST2 盲区注 | 人工核对（承诺不成立 ⇒ 不写成成立） |

---

## 3. 门禁自身的两条内建硬约束（写在代码里，不是运行手册）

1. **绝不 glob 整批跑测试**。`node --test tests/unit/`（目录/glob）会因 `link-workspace` 的
   symlink(junction) 触发 `0xC0000005` 进程访问违例、**连带判死全部文件** = 假全红
   （MEMORY 关键坑段 / K-2 / 设计 §262 第 5 点）。⇒ `gate.mjs` 的 `runPerFile()` **每文件一个
   独立子进程**，无任何"批量优化"路径。这条约束是**门禁的实现细节**，不依赖使用者记得它。
2. **门禁与静态守卫不 import 被测包**。`dep-lint` / `config-key-lint` / `lock-probe` / `gate`
   只用 node stdlib + 子进程（PR9：「不 import 被测包（避开 junction 假红）」）。
   否则门禁自己会变成最容易炸的那个东西 —— 而一个经常炸的门禁等于没有门禁。

附带：`runPerFile()` 解析不到 TAP 计数时**判红**（`NOSUMMARY`）而非当 0 例通过（K-10）。
计数前缀随 reporter 变化（node 24 默认 `ℹ tests`；`--test-reporter=tap` 为 `# tests`），
`gate.mjs` 恒显式 tap，且两种前缀都认。

---

## 4. 本批交付物清单与「写了就能跑」对账

| 交付物 | 状态 | 自证 |
|---|---|---|
| `scripts/dep-lint.mjs` | 新增 | `npm run layout` 实跑 GREEN（12 包 / 66 js / 22 包级边 / 0 hard / 0 warn） |
| `scripts/config-key-lint.mjs` | 新增（§13.2-②） | 真机配置资产 GREEN；注入假键 ⇒ RED（证伪过） |
| `scripts/gate.mjs` | 新增 | `npm run gate:quick` + 全量各跑通一次 |
| `scripts/lock-probe.mjs` | 新增 | 真机只读读数 GO/BLOCKED（设计 §3.4 E-3） |
| 根 `package.json` `layout` | **恢复**（原指向不存在的 dep-lint ⇒ 现指向真实存在的脚本） | `npm run layout` exit 0 |
| 根 `package.json` `gate` / `gate:quick` / `lock-probe` | 新增 | 同上 |
| `tests/unit/phase2-dep-direction.test.js` | 新增 | 合法图 GREEN + 违规图 RED（每条判据各一个反例）+ 不 import 被测包 |
| 本文件 | 新增 | 逐条判据/理由成文（PR9 的文档对冲面） |
