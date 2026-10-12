# WinVM Bridge · 测试验证 / 部署运维 / 文档规范三维全面审计（QA 严过关 · 只读）

- 审计人：Edward（software-qa-engineer）· 团队 software-winvm-audit
- 审计时间：2026-10-12 19:42 起（+08:00）；HEAD=`13b8705`（Phase 2 收官批后）
- 纪律：全程只读。唯一写入=本报告 + `/storage/Users/currentUser/wbtmp/audit-qa-timeline.log` + 探针输出 `/storage/Users/currentUser/wbtmp/audit-gate-quick.txt`（仓外）。
- 实跑证据：`node scripts/gate.mjs --quick` → **VERDICT GREEN**（ST1 tsc / ST2 dep-lint packages=12 hard=0 warn=0 info=11 / ST2b config-keys 未知键=0 / ST3 守卫 7 件 155/155），见 wbtmp/audit-gate-quick.txt。

---

## ① 门禁覆盖承诺-执行对账表

`scripts/GATE-POLICY.md` §2「不进门禁」共 6 行（任务书说 5 类，实测 6 行：真机/VM 件、SSH 隧道件、宿主沙箱平台件、link-workspace、运行期接线、类型级审计耦合）。抽查结论：**承诺基本落地，不悬空**，但有 2 处口径瑕疵。

| 不进门禁类 | 承诺的覆盖去处 | 实测执行记录（文件路径+摘录） | 判定 |
|---|---|---|---|
| SSH 隧道与传输件（ssh2-resolve/tunnel-daemon/oh-tunnel/tunnel-mode/preflight/deploy-conn-side） | 「ST4 全量档覆盖（逐文件）」 | `qa/r19/t11-sweep-result.txt` 逐行 GREEN：`tunnel-daemon.test.mjs tests=10 pass=10`、`ssh2-resolve.test.mjs tests=8 pass=6 skip=2`、`oh-tunnel.test.mjs 19/19`、`tunnel-mode 15/15`、`preflight 8/8`、`deploy-conn-side` 亦在 92 件清单内；终判批 `qa/r19/p2close-sweep.txt` 92/92 GREEN 二次复证 | **承诺成立**（最近两次全量 sweep 均覆盖） |
| 宿主沙箱平台件（sandbox-allowwrite/launcher-posix/path-util-posix/account-resolve） | 「ST4 全量档覆盖」 | 同上：`sandbox-allowwrite 9/9`、`launcher-posix 5/5`、`path-util-posix 7/7`、`account-resolve 4/4`（t11 + p2close 双档在场） | **承诺成立** |
| `link-workspace.test.js` | 「ST4 逐文件档，gate 恒逐文件 spawn ⇒ 天然安全」 | `qa/r19/t11-sweep-result.txt`：`GREEN tests/unit/link-workspace.test.js rc=0 tests=16 pass=16`；gate.mjs `runPerFile()` 每文件独立子进程（代码级约束，`scripts/gate.mjs:26-29`） | **承诺成立** |
| 真机/VM 依赖件（qa/r19 探针、deploy-vm/install-vm 实跑） | 「真机窗口档期，主理人派工 + lock-probe 前置判定」 | ①`qa/r19/t11-lock-probe.txt`（lock-probe VERDICT=GO 真机只读读数，2026-10-12 17:4x）；②真机执行留档：`docs/test/reports/real-test-2026-09-30-r19.md`（E1–E5）、`k3r-t05-real-machine-2026-10-06.md`、`qa/r19/t5-*`/`t6-*`/`t7-*`（T5/T6/T7 真机批次各 10+ 件证据）；③隧道 `curl /health` 在 p2close-final-report §①有预检记录 | **承诺成立但有结构性缺口（详见④：真机 E2E 全量轮与 src 批次不同步）** |
| 运行期接线（schema 入注册期 / bearer 常开 / policy 未知键拒启） | 「不覆盖——已裁决的设计选择」 | Q1=(b) 裁决在 `docs/changes/phase2-arch-design.md` §13；SECURITY-GOVERNANCE §3.2 现状限定改述已回填（T1 commit 664eff9 文档面） | **成立（诚实登记为"不覆盖"，无假承诺）** |
| 类型级审计耦合（`import type { AuditRecord }`） | 「人工核对（承诺不成立 ⇒ 不写成成立）」 | 全仓 grep「人工核对」：Phase 1/2 各批 commit 叙事中有 dep-lint 恢复前的人工核对记录（`docs/changes/phase0-docs-notes.md:159`、`CL-K3R/TECHNICAL-SOLUTION.md §8.3`）；但**T11 之后针对"框架侧新增 import type 审计类型"的单次人工核对留档＝未找到**（GATE-POLICY 只声明由判据 A+C 兜住） | **P2 瑕疵：承诺形式成立，执行痕迹缺档**（属"低概率+文档已诚实"类，建议每批 diff 抽查留一行） |

**P2 建议**：GATE-POLICY §2 表头「5 类」与实表 6 行一致性无问题（无静态数字），但「不进门禁」项的"覆盖去处"若为 ST4，应显式标注最近一次覆盖它的 sweep 文件名，否则仍需人回翻（现由我逐件对账完成）。

---

## ② 测试结构瑕疵存量

**describe 嵌套错位扫描（AST 级，typescript 解析全 92 件）**：
- 用 `node_modules/typescript` 对 `tests/unit/*.test.js|*.test.mjs` 全文 AST 遍历，统计"describe 套在 describe 内"的位置。**唯一命中=`phase2-truth-mcp-direct.test.js`**：
  - L685 `describe('P2-T8 桥侧接线：…')` 与 L881 `describe('P2-T8 静态红线：…')` 嵌在 L601 `describe('P2-T8 G-b 入链…')`（即 E 组）体内——与已知留档瑕疵一致（F/G 组套 E 套件）。
  - 其余 91 件**零同类**（顶层 describe 平铺）。
- 结论：**存量=1 件 2 处，无扩散**。属组织学瑕疵（不影响例数与判定，TAP 层级名会变 `E > F`），修复成本=移动 2 个闭包收尾大括号；建议列入 P2-T13 候选清单（与 §13.x 停摆遗留并列）。
- **套件名不符内容抽查**：`tests/e2e/smoke.test.js:69` 名「能力注册表已装入全部四大能力域」而实测 6 域 54 能力、断言 `≥4`——该条已在 `docs/audit/2026-10-08-test-docs-audit.md:92` 登记（"绿灯但不再描述现实"），**仍未修**（本审计复核：文件未变）。归 P2。

**238 个 tests/*.log 实况澄清（与任务书表述不同，重要）**：
- `find tests -name '*.log'` = **238 个，全部位于 `tests/fixtures/cl018-logs/log-*/` 子目录**（20 个 `log-` 夹具目录 × 每目录 8–14 个伪日志），非"tests/ 下 238 个历史输出"。
- 定性=**测试运行残留而非历史归档**：`tests/unit/cl018-file-logger.test.js:23-25,35` 用 `mkdtempSync(join(BASE,'log-'))` 在 `tests/fixtures/cl018-logs/` 下造夹具、`after()` 里 `rmSync` 清理。磁盘上 20 个 `log-*`（mtime 2026-09-20 ~ 2026-10-12 18:22，即收官 sweep 仍在新增）＝**清理未全效**（进程被杀/清理失败被 `catch{/*ignore*/}` 吞）。`cl018-config/cfg-*` 同类 17 个。
- .gitignore 现状：`*.log`（全局）+ `tests/fixtures/cl018-logs/log-*/` + `tests/fixtures/cl018-config/cfg-*/` 三条已覆盖（`git check-ignore -v` 实证命中），`git ls-files tests | grep -c '\.log$'` = **0** ⇒ 零入库风险，纯磁盘卫生问题。
- **P1 建议**：①夹具目录改 `os.tmpdir()`（同仓 `tests/e2e/smoke.test.js` 与 `phase2-dead-config.test.js` 已是 tmpdir/mkdtemp 范式，cl018 系唯一例外）；②或在 cl018-file-logger 文件头 `before` 里做 `log-*`/`cfg-*` 陈旧目录 GC（>1 天即清）。现"归档规则化"无需做——本就不是证据文件。

---

## ③ 断言面质量抽查（三件守卫：钉住现状 vs 验证正确性）

对照样板＝`scripts/dep-lint.mjs`（T11 派生式：`LAYER_RANK` 由 `packages/*/package.json` 的 `layer` 字段派生，新增包自动入面，不靠人记清单）。三件守卫逐一实测：

**A. `tests/unit/r19b-s5-write-allowlist-pairing.test.js`（389 行）→ 判定：正面样板（行为级），但夹 1 条恒真断言**
- 断言 1–5 全为**真实调用 `evaluate()` 的行为断言**（构造 ctx 喂策略引擎，断 allow/deny），且含**成对性守卫**：只写 (a) 半段或只写 (b) 半段的规则 ⇒ 必红（`L289-316`）。这类"半截配置必失败"是反恒真的正确姿势。
- 它读 `package.json` 的 runner 字段做语义判据（禁止 glob 回潮），而非 grep 字符串——派生式，好。
- **⚠ 断言 6（P2）**：`本文件以 .test.js 结尾且被 test:unit 覆盖` = 对**自身文件名**的字符串检查，永不失败（该文件存在即文件名固定），属"自我命名检查"型恒真。建议删除或改为"守卫件必须出现在 `GATE_GUARD_FILES`"（可从 `scripts/gate.mjs` 导出符号派生，真能失败）。

**B. `tests/unit/phase2-dead-config.test.js`（230 行）→ 判定：合格（有变异自证），但有 2 处覆盖假象**
- C 组含**注入式变异测试**：向校验函数喂 `0` / `'120000'` / `null` 假配置，断言**恰好 1 条 warn 显形**——即"如果告警代码被删，测试必红"。这是"验证正确性"而非"钉现状"的教科书式做法。
- B 组静态守卫：`LEGAL='packages/core/src/config/index.ts'` 要求读取点**恰 1 命中且位置落在 `validateServiceConfig` 函数体内**（位置判据，不只是计数判据）——强。
- **⚠ P2-1 覆盖假象**：只覆盖 `vm-service.config.json` + `delivery/.generated/vm-service.runtime.json` 两个 target（`scripts/config-key-lint.mjs` `DEFAULT_TARGETS`）。实测 `lintConfigKeys()` L369-372：**target 文件不存在 ⇒ 返回 `skipped` 且进程 code 0**（gate --quick 里显示 `未知键=0` 绿灯）。而 `delivery/.generated/` 是 2026-09-30 的陈旧产物，VM **真实运行配置在 VM 侧磁盘**（不在仓库扫描面）⇒ "配置键守卫绿"≠"VM 实跑配置被守"。建议：target 缺失应降级为 warn 并在报告行显式写 `SKIPPED(missing:<path>)`，禁止静默 0。
- **⚠ P2-2 磁盘残留**：`FIXTURES=tests/fixtures/phase2-dead-config` 用 `mkdtempSync` 生成 `cfg-*`，该目录**不在 .gitignore 覆盖内**（`git check-ignore -v` 对 `tests/fixtures/phase2-dead-config/cfg-xxx` 无命中）。本次实测该目录下已存 17 个 `cfg-*` 残留（与 cl018-config 同批统计）。虽当前无被 `git add` 迹象，属**未在册的入库风险**。建议同 cl018 系加 `tests/fixtures/**/{cfg,log}-*/` 通配。

**C. `tests/unit/phase2-snapshot-truth.test.js`（323 行）→ 判定：真实风险＝双白名单硬清单，存在可绕过的检测盲区（P1，方向 fail-closed 正确）**
- 机理：`WHITELIST` **硬编码 12 个文件**（3 个声明/校验 + 9 个"同词异物"），对全仓 grep `snapshot` 命中做"命中文件必须 ∈ WHITELIST，且若消费则必须命中 `CONSUME_RE`"的双条件钉。这是**清单钉（roster-pinning）**，与 dep-lint 的派生式对立。
- **实测绕过（node 探针，本审计亲手跑）**：`CONSUME_RE = /audit\s*\??\s*\.\s*snapshot|\.snapshot\s*[!=]==?|beforeAfter|SnapshotPolicy|spec\.snapshot/` 对两种**解构写法**均不命中——
  - `const { snapshot } = cap.audit;`
  - `const { audit: { snapshot } } = def;`
  二者都会命中文件级 `/snapshot/i` ⇒ 结果是 **WHITELIST 判红（fail-closed）**。即：绕过者会撞红，但**报因误导**（提示"未在白名单"而非"消费检测不到"），且若有人为了让它变绿而**把这行加进 WHITELIST**，则真实盲区固化。
- 结论：不构成"假绿灯"，但构成**"每新增一个含 snapshot 字样的文件就要人手改测试"**的维护税——正是 GATE-POLICY K-10「永绿守卫等于没有守卫」的反面情形（这里是"永红守卫"）。
- **P1 建议**：①`CONSUME_RE` 补解构/别名分支（`\{\s*snapshot\s*\}`、`snapshot\s*[:,}]`）；②WHITELIST 改为**从 contracts 的 `AuditRecord` 字段派生**（同 T11 样板：读 `packages/contracts/src/*.ts` 抽 snapshot 相关符号名，命中即视为在册），保留"同词异物"9 项为显式豁免表。

**③ 汇总**：三件中 1 件样板（s5，除 1 条自我命名恒真）、1 件合格（dead-config，除 target 静默 skipped）、1 件需改（snapshot-truth 双白名单）。P0 无；**P1=2**（snapshot 派生化、config-key-lint target 缺失静默绿）。

---

## ④ 真机 / VM 回归缺口（**P0**）

**最近一次"全量真机 E2E"= `docs/test/reports/real-test-2026-09-24-run7.md`（A1–A18 矩阵 18/18 PASS，含 A11 部署逐字节一致、A12 宿主-VM 技能同步 diff 无差异、A5 A2A 委派 18.4s 真完成）**。上一同类为 `docs/changes/CL-017/QA-REPORT.md`（2026-09-18，同 18/18）。此后**再无任何 A1–A18 全量矩阵轮**。

**自那次起 src 改动量（git 实测）**：
- `git log --since=2026-09-24 -- packages delivery scripts` = **59 个提交 / 98 个文件变更**。
- 按目录分布（改动行数计）：`packages/vm-service/src` **48**、`adapter-agent-workbuddy-llm/src` **34**、`contracts/src` **31**、`delivery` **26**、`a2a-framework/src` **13**、`core/src` **12**、`core/src/policy` **9**、`host-a2a-bridge/src` **8**、`vm-capabilities/psmod` **8**。
- **psmod（VM 内真跑的 PowerShell）在 run7 后被改过 3 批**：`c93133f`(09-28，6 个 ps1 全量含 `ps-bridge.ps1`)、`96bb472`(09-30，app.ps1 卸载核验状态机)、`1c3814a`(10-02，K-N2 dry-run 改宿主侧纯查询)。
- **最后一次任何真机留档 = `k3r-t05-real-machine-2026-10-06.md`（mtime 2026-10-06 21:17）**；`git log --since=2026-10-06 --diff-filter=A -- docs qa | grep -i 'real'` 只回它自己 ⇒ **10-06 之后 24 批 src 提交（10-08～10-12，Phase 0 止血 + Phase 1 + Phase 2 T1–T12）零真机轮**。

**这 24 批里"必然需要真机才能证"的运行期行为**（离线单测只能证纯函数/形状，证不了现网）：
1. **P2-T4 断连即中止（ARCH-29）**：`cbd5dfd` 自述「三层语义闭环（framework→capabilities→adapter）离线全证；**真机断连端到端降为遗留复核点**」；`phase2-arch-design.md:504` 明列遗留三条（①B2 类 cmd.exe 长调用中途断连实证「VM 内继续跑」+ 迟到回执无 pending 残留；②宿主 curl 中途断 ⇒ 链上恰一条 TASK_CANCELED；③streamableHttp 单 POST 前提复核，若有 SSE 长连则 dispose 时机重审）——**本审计全仓 grep「遗留真机复核」仅此 1 处出现、无任何闭合记录 ⇒ 三条全部未闭合**。该功能新增 54 例离线测试，但 54 例全是替身 signal。
2. **P2-T5/T6 bearer 生效自检 + 回连凭据通路**：设计 §PR3/PR4 明写"真机必须实测一次"。实况 T5/T6 确有真机轮（`phase2-arch-design.md:512/526`：E3 自环探针 HTTP200、E4 三态 NOAUTH=401/AUTHED=200/WRONGTOKEN=401、BYTE_IDENTICAL 还原）——**这是 Phase 2 里真机做得最扎实的一项**，值得点名（非缺口）。
3. **P2-T7 TaskStore 驱逐观测**：设计要求"≥200 任务或 1h 驻留窗口的可复现脚本，落 `qa/` 下"，产出 `evictedCount` 增长曲线。实测 `qa/r19/` **未见该长会话脚本与曲线产物**（`ls qa/r19 | grep -i evict` 空；`phase2-task-store-evict-observe.test.js` 为离线件）⇒ **观测曲线缺口未补**（若已跑在别处留档＝未找到）。
4. **P2-T9 冷启动度量 / P2-T12 progress Message 呈现**：设计口径均为"真机顺带"。顺带=可跑可不跑 ⇒ 实测 `qa/r19/t12-design.md` 仅 1 处提真机且指向 t5 证据；**T9 的"预热命中率/冷启动发生率两个数"未见产出留档**（未找到）。

**离线全绿 ≠ 真机健康的结构性原因**：`tests/unit/psmod-contract.test.js` 文件头第 18 行自述「**纯 `readFileSync` + 正则解析，零 PowerShell 依赖、零 spawn、不起服务（沙箱可跑）**」。它证的是"注册表 54 条 ↔ ps1 函数名存在性/大小写/孤儿"（**跨语言命名一致性**），**不证任何一条能力在 VM 里的真实行为**。psmod 实有 **91 个 `function` 定义**（app 27 / system 17 / storage 15 / gui 14 / ps-bridge 9 / appops 9），其真实调用回归**只能靠真机 A 系列**——而 A 系列已 18 天（run7→审计日）未全量跑，中间 psmod 改了 3 批。

**旁证：本地"真装配"验证也已断**：`tests/e2e/smoke.test.js`（16 例，唯一 `createService` 真起服务的件）在本机**不可跑绿**——实测 `which pwsh powershell` 均为空，`docs/audit/2026-10-08-test-docs-audit.md:16` 记 `16 pass / 1 fail（spawn pwsh ENOENT uncaughtException 逃逸，after 钩子未 drain ps-bridge 自愈重试）`，且该件**不在 gate 枚举面**（见⑤）⇒ 离线 1889 与真机之间"中间层"是空的。

**分级建议**：
- **P0**：开一次真机窗口跑 **A1–A18 全量 + T4 遗留三条 + T7 驱逐曲线**（可打包同窗，遵守 K-5 错峰独占、lock-probe 前置 GO）。理由：①这是唯一能覆盖"psmod 3 批改动 + Phase2 运行期改动"的手段；②门禁/离线面已充分自证，边际收益全在真机侧；③PR10（真机档期）本就是设计自评的"最高现实风险"。
- **P1**：把 `phase2-arch-design.md:504` 三条遗留复核升格为**在册任务**（现在只有一行叙述，没有 ID、没有验收判据、没有归属批 ⇒ 天然流失）。
- **P1**：`tests/e2e/smoke.test.js` 加 PowerShell 环境守卫（缺席 ⇒ `skip`，并文档写明"无 PS 环境应有 N skipped"）——体检 §7-2 已建议，存量未修。

---

## ⑤ 孤儿测试核查（gate 表 / ST4 清单 / runner 清单 三方一致性）

**三方实测对齐结果**（本审计逐边核验）：

| 边 | 事实源 A | 事实源 B | 一致性 |
|---|---|---|---|
| ST3 进门禁守卫件 | `scripts/gate.mjs:65-105 GATE_GUARD_FILES`（7 项） | `scripts/GATE-POLICY.md` ST3 表（7 行：snapshot-truth 17 / dead-config 14 / contract-schema 23 / contract-code-fidelity 22 / session-unknown 48 / assembly-guard 24 / psmod-contract 7 ＝172＋…；实跑 155 例含 dep-direction 族 32 例） | **一致 ✅**（件名逐条对得上，无单边条目） |
| ST4 sweep 清单 | `qa/r19/t11-sweep-result.txt` `FILES=92` | `gate.mjs listUnitTestFiles()` 枚举 `tests/unit` ⇒ 磁盘 92 | **一致 ✅**（t11 CROSSCHECK 行亦记 `DISK_TEST_FILES=92 RUN=92 MATCH`） |
| runner 清单 | `package.json` `test:unit`（内联 node -e，同枚举 `tests/unit` 两类后缀） | gate ST4 | **一致 ✅**（同目录同后缀判据） |
| **不进门禁声明表** | `gate.mjs GATE_EXCLUDED` = **5 条**（L112-127） | `GATE-POLICY.md` §2 = **6 行**（多「类型级审计耦合 `import type { AuditRecord }`」） | **不一致 ⚠ P2**：双写已产生单边项（文档有、代码无 ⇒ 代码侧改表时不会有人提醒要同步） |
| **测试文件枚举面 vs 真实测试资产** | gate/runner 仅枚举 `readdirSync(TEST_DIR)`＝`tests/unit`（L272-276 实证：`.filter(.test.js/.test.mjs)`） | 磁盘另有 `tests/e2e/smoke.test.js`（**16 例**）、`delivery/__tests__/oh-tunnel-error-handling.test.mjs`（**8 例**）、`delivery/__tests__/probe-{daemon,tunnel}-error.mjs`（故障注入探针，非 test 后缀）、`tests/psbridge-smoke.mjs` | **结构性孤儿 ❌ P1** |

**孤儿详单与"承诺回填"核验**：
1. `tests/e2e/smoke.test.js`（16 例，全仓**唯一真起 HTTP 服务 + 真装配 createService** 的件）。
   - gate 枚举面进不去（目录不是 `tests/unit`）；`qa/r19/t11-sweep-result.txt` grep `tests/e2e` = **0 命中**（ST4 也没跑）。
   - GATE-POLICY §2「不进门禁」**也没登记它** ⇒ 属"既不在覆盖面、也不在豁免面"的**沉默孤儿**（最坏象：看起来被门禁保护，实则任何批次都不跑）。
   - 它当前在本机**跑不绿**（`spawn pwsh ENOENT`，见④）。
   - 该缺口 2026-10-08 体检 §2-N11 已登记为 P1（"唯一真实装配验证既没被数进基线，也没被环境守卫"），`R7` 建议新增 `tests/e2e/routes.test.js` ——**实测 `tests/e2e/` 仅 1 个文件，R7 未落地**。
2. `delivery/__tests__/oh-tunnel-error-handling.test.mjs`（8 例，隧道崩溃 BugFix 的专属回归）。
   - `.workbuddy/memory/2026-10-04.md:144` **明文规定工程师把测试落在 `delivery/__tests__/`**（"不触碰 QA 独占的 tests/**"）——即**治理规则主动制造了一个 gate 枚举面之外的测试目录**。
   - gate ST4 不含；`t11-sweep-result.txt` grep `__tests__` = **0 命中**；`qa/r19/p2close-out/*.log` 逐文件输出 92 件里亦无。⇒ **8 例长期不入基线**（1889 恒不含）。
   - 这直接构成"隧道件不进门禁 ⇒ ST4 覆盖"承诺的**部分空洞**：`oh-tunnel.test.mjs`(19 例) 在 tests/unit 有覆盖，但工程师侧那 8 例错误处理回归无人跑。
3. `tests/psbridge-smoke.mjs`：体检 §N6（P2）在册，无 npm script 引用，仅 `.dev/changed-log.md:14` 提过一次 ⇒ 一次性脚本无人维护。
4. 基线数字的"分母口径"未同步到 `.dev`：`.dev/project-dev-status.md:38` 仍写「**当前权威口径** 71 文件 / 1247 tests」（2026-10-08），而 `qa/r19/t11-sweep-result.txt:93` = **92 文件 / 1889**；`.dev/docs-index.md:96` 同样是 1247 口径。⇒ 与 README 声明的"唯一权威源=最新 sweep 汇总行"相矛盾（README 自己在 T11 起已废静态数字，`.dev` 没跟着改口径写法）。**P1**。
5. README L286-292 给出的"查当前基线"命令 `ls -1 qa/*/sweep-result.txt qa/*/*-sweep-result.txt | sort | tail -1`：实测 `sort` 是**字典序**，`t9-*` > `t11-*` ⇒ 该命令返回 `qa/r19/t9-sweep-result.txt`（91 文件/1857）而**非** t11（92/1889）。README 正文下一句自己又锚定 t9=1857 为"上一权威基线"，口径自洽但**命令本身给出过期结果**。**P1**（改 `sort -V` 或按 mtime `ls -1t`）。
6. 证据入库完整性：`git status --porcelain --ignored=matching qa/` = **107 个被忽略文件**（含 `qa/r19/p2close-out/*.log` 92 件逐文件 TAP 输出——这恰是 1889 可复核性的原始凭据；以及 `qa/r19/*.timeline.log` 25 个心跳面证据，被 `.gitignore:20 *.log` 吞掉）。`*.txt` 汇总件已入库 ✅（26 个 timeline 类 .txt 在册），但**原始逐文件 TAP 输出与 timeline 不入库** ⇒ 基线"可复核"依赖本机磁盘（P2：归档规则化：`qa/r19/**/evidence/` 打包或 `.gitignore` 加 `!qa/r19/**/*.timeline.log` 反向白名单）。
7. 工作树卫生（审计期间实测，只读登记未动）：`git status --porcelain` = 14 项，其中 **9 个 `.workbuddy/commit_msg*.txt` 未跟踪未忽略**（`.workbuddy/` 整目录设计上入库，故它们随时可能被 `git add .` 顺手带进去——临时件治理漏洞，P2）；`qa/r19/p2close-teams-cleanup.txt` 未提交（收官证据有落件未入库，P2）；仓库内 `%LOCALAPPDATA%/`（4 文件，最近写入 **2026-10-09**）与 `C:/`（9 文件，**2026-10-09**）两个垃圾目录仍在（`.gitignore` 已忽略但缺陷本体未修——见⑪/⑫ 联动：每次跑 e2e/裸跑安装器都会复活）。

---

## ⑥ 隧道单点故障复盘与 runbook 缺口（**P0/P1 混合**）

**事实源**：`/storage/Users/currentUser/.workbuddy/winvm/tunnel.log`（456 行，全程未截断）+ `tunnel.state.json` + `tunnel.pid` + `.workbuddy/memory/2026-10-12.md:1-27`（实况叙述）+ 代码 `delivery/tunnel-daemon.mjs` / `delivery/oh-tunnel.mjs`。当前实况（审计时只读复核）：pid **51633 存活**、`curl -m5 /health` → `ok:true`（provider ready / session healthy / unlocked）。

**今日（2026-10-12）三次"死"逐次归因**（memory 与日志对得上）：

| # | 时刻(+08) | 表现 | 根因（日志/代码实证） | 分型 |
|---|---|---|---|---|
| 死1 | 09:2x 前（事发 01:27Z 段） | 旧实例网络风暴后**残存但不健康**，宿主侧 curl 黑洞 | `tunnel.log:440-447` `Keepalive timeout` + 7×`No response from server` 全为 WARN（已内部消化走退避）⇒ 进程未死、`_client/_alive` 假在；`_onLocalConnection` 对每个新连接 `localSocket.destroy()`（`oh-tunnel.mjs:585-589`）⇒ **端口听、连接秒断**＝黑洞（memory:24 记为 `rc=7 conn refused`） | **A 型：僵尸转发态（不退出但不可用）** |
| 死2 | 01:41（=09:41 前后主理人重启那次） | 重启即退，双行 ERROR | `tunnel.log:448-449` `ERROR 隧道启动失败：缺少必填项 vmHost` ×2 ⇒ 主理人**手动 nohup 未带全参**（`normalizeOpts()` `oh-tunnel.mjs:118` 构造期 throw）。**关键机理（代码级）**：`runDaemon` 在 `new Tunnel()` **之前**已 `writePidfileAtomic` + `writeStateAtom('STARTING')`（`tunnel-daemon.mjs:159-166`），throw 落 `catch` → `logLine ERROR` → `shutdown()`（L273-276）；throw 在 `_listen()` 之前 ⇒ 本例端口未绑。**真实危险序在另一条路**：`start()` L277 `await this._listen()` 先绑 18443、L283 才 `_connectWithTimeout()` ⇒ 任何**连接期一次性致命错误**（如 ready 前的 ssh2 fatal）会让 daemon 在"端口已被自己占用"状态下退出。CL-020 文档 §8 的"黑洞四条件判据"正是这一族的后遗症 | **B 型：缺参/参数面重启即退（人工触发，非自动恢复）** |
| 死3 | 15:40 前后 | 又死一次，主理人亲复活 → pid 51633 | memory:8「daemon pid 16219 又死（**ESRCH 实证**）；state.json 停在 01:43 RUNNING 是**僵尸快照**」＋ memory:27「查 kill -0 38438=ESRCH 真死 → 带全参 nohup 复活 → 新 pid **51633**」 | **C 型：pid 消失（进程被外部/OS 回收）+ state 文件撒谎** |

**跨日死因全景（同一日志，2026-09-30 起）**：
- `09-30 09:28–09:31`：10 连 `隧道启动失败：connect EHOSTUNREACH`（**这是"启动失败即 return 1"分型，不是退避**——注意与"已内部消化走退避重连"两种措辞的差别，L433 同型）⇒ VM 不可达时 daemon 直接放弃，不自愈。
- `10-09 06:47–06:53`：13 次 WARN 退避（间隔 3s→7s→9s→19s→38s→34s→34s→34s→36s→42s→34s→38s→31s，**指数退避 + jitter 实现在 `oh-tunnel.mjs:553-556`：`min(30s, 1s×2^(n-1)) + rand×0.3×delay`，`maxAttempts` 默认 `Infinity`（L170）**）后跟一条 `ERROR 隧道启动失败` ⇒ **退避本体工作正常，但"重连耗尽"路径从未在今天日志出现过（grep `重连耗尽` = 0 命中）**：即所有死法都**不是**耗尽 maxAttempts 而死，而是"启动阶段失败即退"或"外部杀/回收"。
- `10-09 10:19` / `10-12 01:41` ×2：`缺少必填项 vmHost`（同 B 型人工重启）。

**并发实例旁证（新发现，P1）**：`awk` 统计同文件**相邻重复行 = 9 处**，且都集中在 10-12 01:41/01:43/02:35/07:49 —— 逐条核：
- `01:41:35.529Z ERROR 缺少必填项 vmHost` ×2（**同毫秒**）
- `01:43:58.791Z INFO 隧道已就绪…` ×2（同毫秒）
- `02:35:25.887Z INFO 隧道已就绪…` ×2（同毫秒）
- `07:49:04.444Z WARN 已有隧道进程 pid 51633，不重复启动` ×2（同毫秒）
  机理澄清（本审计代码核验，避免误判）：这两条消息**每个成功启动的进程只写一次**（`tunnel-daemon.mjs:271` 与 `:134`），且 `spawnTunnelDaemon` 用 `stdio:'ignore'`（`winvm-plugin.mjs:1070-1074`）⇒ **不是 stdout 双落**。同毫秒双写 ⇒ 只能是**两个进程各自 append 同一行**。而"隧道已就绪"双写意味着**两个 daemon 都成功 bind**——`_listen()` 未设 `SO_REUSEPORT`，正常应 EADDRINUSE。⇒ 高度可疑：**`tunnel ensure` / autostart 钩子与人工 nohup 并行下发**，一个在旧实例还持有端口的窗口里成功（旧实例已 close 但 OS 未及时释放，或不同 localPort），随后旧实例被替换。旁证链：`07:49` 双写 `已有隧道进程 pid 51633，不重复启动` ＝同一次 ensure 被触发两遍（`install-host.mjs:1137` spawnSync ensure + `tunnel-autostart.json` 钩子 + HOURLY watchdog 三源）。**这是"守护重复启动"的直接留痕，且 pidfile 幂等只挡住"第三实例"，挡不住同一毫秒的竞态。**

**退避重连覆盖面（结论）**：
- ✅ 覆盖：连接**建立之后**的 ssh 断线（keepalive timeout / No response / ECONNRESET / forwardOut 错误）——`_safeEmitError` + `_markDeadAndReconnect` + `maxAttempts=Infinity`，今天日志里 8 条 WARN 全被内部消化、进程存活。
- ❌ 不覆盖 1：**启动阶段失败**（ssh 从未 ready 成功过）⇒ `catch → shutdown() → exit 1`，**没有任何重试**，必须外部再 ensure（`09-30` 10 连 EHOSTUNREACH 即此型；VM 重启慢 1 分钟就可能踩到）。
- ❌ 不覆盖 2：**僵尸转发态（A 型）**——进程活着、`_alive` 真值摇摆，但转发秒毁 socket。`state.json` 会写 `DEGRADED`，然而**宿主侧调用者若只看 pid 存活/curl 成败，就会得到"黑洞"**（memory:3/8 两条教训原话：`state.json≠实况，判活终靠 kill -0 + curl`）。
- ❌ 不覆盖 3：**state/pid 文件语义**——`giveup` 与 `shutdown` 都 `rmSync` 两文件 ⇒ "文件消失"既可能是"从未启动"也可能是"死透自清"（memory:3 明载）；反之 01:43 RUNNING 快照能挂 4 小时不变（memory:8 僵尸快照）⇒ **两向都不可信，唯一事实源是 kill -0 + curl**。

**现有 runbook 成文度**：
- ✅ **配方存在且正规**：`winvm-plugin tunnel ensure`（幂等三态收敛：RUNNING→跳过 / DEGRADED→重启一次 / STOPPED→拉起，`winvm-plugin.mjs:1165-1181`）；`restart` 动作先 stop 再起（L1150-1159）。生产化落地在 `delivery/setup.mjs:862`（ensure 用时/pid 回显）与 `install-host.mjs:1132-1145`（写 `tunnel-autostart.json`）。
- ✅ **平台双判据铁律已成文**：`docs/INSTALL-GUIDE.md` §7.1 第④⑤条（HOURLY team-watchdog + "state.json 是快照≠实况"）；`docs/INSTALL-GUIDE.md` §8 故障排查表含**隧道黑洞四条件判据**。自动化实测有效：`.workbuddy/memory/automations/aaa87da4-4215-45d4-a466-b82c70d46426/memory.md` 记 **15:38 `tunnel ensure` 自动复活**（本审计期间 git status 见该文件为 `M`，即今天仍在写）。
- ❌ **缺一份"隧道运维专页"**：`find docs -iname '*tunnel*'` 只有 3 件——`docs/oh-tunnel-design.md`（设计）、`docs/design/tunnel-crash-fix-progress.md`（进度）、`docs/test/reports/tunnel-mode-qa-2026-09-28.md`（测试报告）。**没有 `RUNBOOK-TUNNEL.md` 类文档**；配方散落在 INSTALL-GUIDE §7.1/§8 表格行 + DEPLOYMENT.md + `.workbuddy/memory` 每日叙述里。**今天三次死，三次都是主理人在 memory 里手写"复活配方"（含全参列表来源 vm-conn.json），而仓内没有一处"照抄即可用"的 runbook 段落可指**（`memory/2026-10-12.md:3` 那句"必须带全参（--vm-host/--vm-user/--vm-ssh-port/--local-port/--remote-port/--key，值源 vm-conn.json）"就是本该进 runbook 的内容）。
- ❌ **B 型缺参重启无人拦**：人工 `nohup node tunnel-daemon.mjs` 漏参 ⇒ 启动即退（今天真发生）。仓内已有正规入口 `tunnel ensure/start`，但**没有文档明写"禁止手裸跑 daemon，必须经 winvm-plugin"**（MEMORY/memory 里是当事人自觉，不是规范条款）。

**分级建议**：
- **P0（代码）**：`runDaemon` 的启动阶段失败应**改为带退避重试**（复用 `_scheduleReconnect` 同款退避，或至少 `--retry-start N`），否则"VM 还没醒、先起 daemon"必然一次性死亡且无人告警；同时 `catch` 分支目前 `shutdown()` 会 `rmSync` pidfile/state ⇒ 启动失败后**不留任何 STOPPED 终态文件**，运维只能靠翻日志。建议失败时保留 `state=STOPPED + reason` 再退（与 `giveup` 路径的语义对齐——现 giveup 也 rmSync，两处都丢诊断）。
- **P1（文档）**：新建 `docs/05-peripherals/RUNBOOK-TUNNEL.md`，四段式：①判活三值（`kill -0 pid` + `curl /health` + state.json，明写前两者为终判）；②三型死法速查表（A 僵尸转发/B 缺参即退/C pid 回收，各给日志特征串）；③恢复动作（**唯一推荐** `winvm-plugin tunnel ensure`，明令禁止裸跑 daemon；给 vm-conn.json 全参来源）；④并发实例排查（`ps | grep tunnel-daemon` + pidfile cmd 第 2 段核对缓存根路径）。并在 `README.md` §6/§8 与 `INSTALL-GUIDE.md` §8 各挂一行指针。
- **P1（代码/治理）**：`ensure` 路径加**互斥**（对 pidfile 用 `wx` 独占创建或 file lock），消除同毫秒双写竞态；日志行加 `pid` 前缀（现无 pid ⇒ 重复行无法归因），这样并发实例可被机械检出。
- **P2**：`tunnel.log` 无轮转（456 行尚可，但已跨 09-20→10-12 三周），加 size-based rotate 或纳入 `uninstall.mjs:511` 的清理策略说明。

---

## ⑦ VM 侧服务生命周期成文度

**结论：核心三条（不可热更 / kill-restart 配方 / 顺序铁律）已成文且相当醒目，唯"运行期红线"与"VM 遗留物盘点"两处欠账。**

1. **「改 psmod/*.ps1 必须重启服务」醒目度＝充分（多面冗余，非孤点）**：实测命中 8 处成文（`git grep`）：
   - 门禁纪律：`docs/changes/phase2-arch-design.md:330` **K-7**「改 `psmod/*.ps1` 必须重启服务；重启只用 `kill-restart.ps1`（不重跑 install-vm）」——即这条已是**流程铁律编号项**。
   - 排障表：`docs/INSTALL-GUIDE.md:298` 现象行「改了能力模块（psmod/*.ps1）但不生效」→ 根因「**ps-bridge 不可热更**：主循环 `while($true)` 只在 stdin 关闭/未捕获异常时退出」→ 处置 `kill-restart.ps1`。
   - 运维工具箱：`delivery/tools/README.md:23`（kill-restart=强杀 18443 占用者**及其子进程树（含 ps-bridge）**→ 兜底清残留 → `/run`）、`:36` 铁律第 5 条。
   - 领域设计：`docs/02-design/CAPABILITY-MODEL.md:147`（"ps-bridge 常驻进程按启动时快照加载 psm*"）。
   - 变更单：`CL-018/REQUIREMENT.md:189`、`CL-018/TECHNICAL-SOLUTION.md:256/539`（**并要求"本地↔VM md5 一致校验"**）、`CL-019/REQUIREMENT.md:67`、`CL-019/TECHNICAL-SOLUTION.md:128`。
   - 记忆：`.workbuddy/memory/MEMORY.md:8`（括号内加粗）。
   ⇒ **醒目度评级：P0 级坑已被 K-7 编号 + 8 处冗余覆盖，不需追加。** 唯一小缺口：`README.md` §6「运维」六行命令表**未列"改 psmod 须 kill-restart"这一条**（README 是新人首读面，现只在 INSTALL-GUIDE/设计文档）⇒ P2。

2. **kill-restart 配方成文度＝好，且代码侧防护已升级（修正既往认知）**：
   - `delivery/install-vm.mjs:317` `<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>`，注释 `:312` 明写"本服务靠 start-hidden.ps1 以 -Wait 拉起 node，StopExisting 保证 /run 总会先停旧实例再起新实例，重启真实生效"⇒ **历史上"孤儿 node + IgnoreNew ⇒ 反复重启无用"的机制 bug 已在部署生成物层根治**（对照 `.workbuddy/memory/2026-09-16.md:118`、`2026-09-17.md:79/101` 的原始事故叙述）；`:222/272` 另有按 `Get-NetTCPConnection -LocalPort -OwningProcess` 端口归属强杀双保险；`delivery/tools/start-hidden-vm.ps1:6` 亦 Self-clean。
   - 树杀防护：`packages/adapter-agent-workbuddy-llm/src/persistent-session.ts:140-151`（明写"仅 `child.kill()` 只终止 cmd 包装进程，真实 CLI（node 孙进程）会孤儿化"并实现 taskkill 树杀，非 win32 no-op 兜底）、`:544-548`（"树杀（QA Round 2）"）。⇒ **常驻会话侧已修**。
   - **仍存缺口**：`docs/audit/2026-10-08-implementation-ops-audit.md:788` 指出的 **winget 子进程树**（`child.kill()` 无 `/T` ⇒ 可能留孤儿 winget 继续安装）**实测在 `packages/vm-capabilities/psmod/app.ps1` 未见 taskkill `/T` 相关实现**（grep `tree-kill|/T\b|taskkill` 于 app.ps1 = 0 命中）⇒ 该条**在册未修**，且卸载类操作留孤儿进程属安全面（P1）。
3. **顺序铁律「先部署 → 后打补丁 → 再 kill-restart」醒目度＝强**：`docs/05-peripherals/DEPLOYMENT.md:465` 独立成句加粗「顺序铁律不变：**deploy → 补丁 → kill-restart**（`deploy-vm.mjs --apply` 会重新生成运行时配置与 ps1，手工补丁必须在部署之后）」；`.workbuddy/memory/MEMORY.md:24` 同口径（"重启只用 kill-restart.ps1（不重跑 install-vm）；⚠ deploy-vm --apply 重新生成运行时配置⇒顺序铁律"）；根因面登记 `DEP-03`（P1：`.generated/` "再生成即覆盖手改补丁"，**建议改声明式 overlay**，现仍靠人工顺序）。⇒ 成文充分；**结构性建议仍是 P1（把顺序铁律变成机械保证：overlay 配置文件）**。
4. **VM 遗留物盘点＝缺（P2）**：仓内**无"VM 侧遗留物清单/定期清场"文档**。现存相关件：`qa/harness/tidy-vm-devqa.ps1`（清场脚本，仅 `overview.md`/`memory/2026-09-23.md` 提及，**未进任何 runbook**）、`delivery/cleanup-vm-stage.ps1`、`docs/05-peripherals/DEPLOYMENT.md` 的卸载范围、`uninstall.mjs:511` markers 列表。真实遗留物（本次只读抽查 VM 侧，`Test-Path` 实证）：`C:/WinVMBridge/shared-skills/` 7 个 skill 目录（含⑪节死链）、`.generated/`（仓库侧陈旧件 09-30）、`%LOCALAPPDATA%/WinVMBridge/{logs,audit}`。**没有一份"哪些是预期存在、哪些是可清、清理配方是谁"的对账表** ⇒ 每次排障靠人回忆。建议在⑥建议的 runbook 体系里加 `RUNBOOK-VM-ASSETS.md`（或 DEPLOYMENT.md 新增一节）：预期文件清单 + 归属 + 清理命令 + "禁清"项（如 audit 分片归档）。

---

## ⑧ 插件分发新鲜度（运行态真相源 + 版本治理）

**坑本体已在册，但"醒目度"不足——它只在记忆/审计/设计里，不在操作者会查的两张排障表里。**

- **铁证：活 daemon 确实从缓存根运行，而非仓库路径**：`tunnel.pid` 的 cmdline 第 2 段＝`/storage/Users/currentUser/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs`（本审计读取 pidfile 实证）。⇒ 改 `delivery/*.mjs` 不重跑 `install-host` = **改动不生效**。
- **在册处（3 处，均为"叙述型"）**：`.workbuddy/memory/MEMORY.md:9`「**宿主插件缓存=运行态真相源** …→ 改 dist 必须实跑 `delivery/install-host.mjs`」；`docs/changes/phase2-arch-design.md:348` **K-25**（沙箱纪律条目）；`docs/audit/2026-10-08-implementation-ops-audit.md:103`（"真正的脆弱点是'改 dist 必须实跑 install-host 才生效'**缺乏防呆校验**"）+ `:1553`（"插件缓存 0.1.0 dist 是否与仓库一致 **无法证明**（DEP-02 的核心：工程没有指纹）"）。
- **未在册处（醒目度缺口，P1）**：
  - `docs/INSTALL-GUIDE.md` §8 故障排查表（10 行）里**没有**"改了代码/重跑 build 但行为没变 → 实跑 install-host"这一行；`:348` 只覆盖更罕见的"插件缓存缺失"。
  - `README.md` §6 运维 / §8 开发 均无此行（`README.md:216` 只给安装命令，未给"缓存=真相源"警告）。
  - **⇒ 该坑对新人零可见度，只有踩过的人（写 MEMORY 的主理人）知道。** 这是典型的"写了但没写到该写的地方"。
- **防呆缺失（代码级，P1）**：`install-host.mjs` 对 dist 只做**存在性**校验（审计 `DEP-05`：`install-host.mjs:234-236`，"陈旧 dist 静默安装，无 mtime 防呆"）。本审计复核：`grep 'createHash|sha256|drift|--check'` on install-host.mjs = **0 命中** ⇒ **无任何一致性/新鲜度校验**。反向坑也在（`:1007`："改了 src 没 build，实跑 install-host 也不生效"）。
- **新鲜度实测（今日）**：缓存根 4 个宿主侧脚本（`oh-tunnel.mjs`/`tunnel-daemon.mjs`/`ssh2-resolve.mjs`/`winvm-plugin.mjs`）与 `delivery/` 同名文件 **cmp 全 SAME**；`a2a-bridge/*.js` 与 `packages/host-a2a-bridge/dist/*.js` **全 SAME**。但缓存整体 mtime = **2026-10-10 10:09**（= 最后一次 install-host），而 cache 之后又有 **2 批** 触及 `packages/host-a2a-bridge`/`delivery` 的提交（`d277882` T5 10-11 03:49、`e0b6945` T6 10-11 10:28）——当前 SAME 是因为这两批主要改 `vm-service/src`（VM 侧，不走插件缓存）。⇒ **本次侥幸一致，但机制上无保证**：T5/T6 改了 `server.ts` 的 `/mcp` 接线与 `/health.security` 透出，**VM 侧生效需要 deploy-vm + kill-restart**，而这既无指纹可验、也无 checklist 强制。
- **版本恒 0.1.0 的治理（P2）**：`install-host.mjs:53/243/726` **三处硬编码 `'0.1.0'`**（缓存路径段 / 生成的 package.json / manifest version）；`package.json` 顶层 version=0.1.0、12 个包全 0.1.0；`server.ts:880/:982` `agentCard.version` 亦硬编码（审计 DEP-02/`:917`）；而 git tag 已有 **`V1.0.0`**（2026-09-10）⇒ **"0.1.0（V1 基线）"（README:5）与 V1.0.0 标签并存，版本号体系与实际发布物语义脱钩**。后果：`/health` 无 version/buildId（DEP-02）⇒ 无法回答"VM 里跑的是哪一版"，`update`/`reinstall` 也无"回到上一构建"入口（OPS-07）。建议：**版本单一事实源＝`package.json` version（或 git describe）**，`install-host.mjs` 三处从 `plugin.json`/`package.json` 读，缓存路径带版本段，`/health` 增 `version`+`buildId`（纯附加，不破现有形状钉）。分级 P2（工程治理项，不阻塞当下正确性，但直接决定⑥⑦⑧ 三节所有"实跑了吗"类问题能否被机械回答）。

- **建议**：`install-host.mjs` 安装尾相位加一道**新鲜度断言**（缓存文件与 `dist`/`delivery` 源文件哈希比对，不一致 ⇒ FAIL 或至少显式 WARN 列出差异清单，把 DEP-02 的"无法证明"变成"当场证明"）。这是**同时收敛⑥⑦⑧三类"实跑了吗"问题的那一把钥匙**（P1，收益最高的一条低成本加固）。

---

## ⑨ 凭据与安全运维（扫描结论：**零明文入仓，治理合格**）

**扫描面与方法**（全用 `git grep` 于 tracked 文件，避免工具假阴性）：
1. `git ls-files | grep -iE '\.env|vm-conn'` ⇒ tracked 只有 **`.env.example`** 一个（模板）。真件 `.env.deploy-vm` 由 `.gitignore:36` `.env.deploy*` 命中忽略（`git check-ignore -v` 实证），且文件头自述「临时 VM-only 部署配置（部署脚本生成，用后删除，非入库）」。**逐键抽查（脱敏打印键名）**：15 个键全为端口/主机/用户/目录/provider 名，**无密码无 token 字段**。
2. 明文模式扫描：`git grep -nIE "(password|passwd|token|secret|api[_-]?key|Bearer [A-Za-z0-9+/]{20,})\s*[:=]\s*['\"][^'\"]{8,}"` 排除 example/placeholder/test 后**仅剩 1 条**：`qa/r19/t6-a2a-call-bearer.mjs:12` `const token = 'p2t6-wired-token-4c7e'`。核性质：该件是 **P2-T6 真机探针脚本**，token 为一次性合成值；旁证三条——① `docs/changes/phase2-arch-design.md:512` 明写「探针 token 为一次性合成值（已随还原消失，非真实凭据，留档可安全入库）」；② `qa/r19/t6-curl-reconnect.ps1:35` 用 `'Bearer deliberately-wrong-token'`（同族合成）；③ 真机链已 `BYTE_IDENTICAL` 还原（三点哈希）。⇒ **判定：非泄漏，登记为"可接受的合成值"**（若要更干净，可加 `// SYNTHETIC-NOT-A-CREDENTIAL` 注释钉，P2 微调）。
3. 22 条 `password/secret` 命中**全部落在测试件**（`tests/unit/approval-audit.test.js` 的 `SENTINEL_*` 哨兵值、`oh-tunnel.test.mjs` 的 `test-password`/`SUPER_SECRET_PASSWORD_xyz`、`k5-replay`/`r1-approval-card`/`r19c-kn1-*` 的 `Sup3rSecret`、`delivery/__tests__` 的 `probe-password`）——**这些是脱敏守卫的"被断言对象"**（证明日志/审计链不打印密码），属正例而非风险。
4. **NFR-511 明文不落盘通路已机械化**：`buildMcpConfig` 产 `Bearer ${WINVM_BEARER_TOKEN}` **引用**，真值只进 VM 侧 `start-hidden.ps1` 显式赋值行；且有 `containsBearerCredentialLiteral` 两步 strip + 词边界谓词，**落盘前不可达防线命中即抛**（`e0b6945` commit 叙事 + `phase2-inner-credential` 38 例守卫在册）。凭据纪律成文于 `DEPLOYMENT.md:460-465`（三步 + "值不进命令行"）。⇒ **这是本维度最强的一项：凭据安全不是文档承诺，是有代码防线 + 有守卫件 38 例的强制面。**
5. **`vm-conn.json` 实况**（`~/.workbuddy/winvm/vm-conn.json`）：权限 **`-rw-rw----`（0660）**，owner `20001006:file_manager`；键＝`host,user,sshPort,servicePort,identityFile`（**无 password 字段，凭据走 identityFile 指向 `~/.ssh/<key>`**）。同目录 `tunnel.log/tunnel.pid/tunnel.state.json` 亦 0660（均为 host/user/port 类信息，无凭据）；`~/.ssh/id_ed25519` = **0600**、`known_hosts` 0600、`id_ed25519.pub` 0660。
   - **P2 提示**：`vm-conn.json` 的 0660 让**同组成员可读**。风险很低（鸿蒙沙箱单用户组语义），但 `id_ed25519` 用 0600 说明"作者知道该怎么收紧"。建议落盘统一 `0600`（writeJson 的 mode 参数），一行改动。
6. **未入仓但被文档/记忆提及的路径**：`.workbuddy/memory/*.md`（6 个文件）出现 `id_ed25519` 字样——均为**路径引用/操作叙述**，无密钥内容（抽查确认）。`.workbuddy/` 整目录设计上入库（`.gitignore` 注释明写），故任何"贴密钥到 memory"的动作会直接入库 ⇒ **建议加一条纪律：memory/文档禁贴任何可复用凭据（含 VM 口令），只允许路径与合成哨兵**（P2）。

**⑨ 结论**：**无 P0/P1 凭据问题**，这一维度是加分项。分级：P2×3（合成 token 加注释钉 / vm-conn.json 收 0600 / memory 贴凭据纪律成文）。

---

## ⑩ 索引新鲜度与文档死链批量验（**P1**）

### ⑩-a `.dev/` 六索引新鲜度（实测：**Phase 2 交付物系统性未登记**）

`.dev/` 实有 **7 个 .md**（`README.md` `changed-log.md` `changing-log.md` `docs-index.md` `kn2-s4-a5-verify.md` `project-dev-status.md` `project-dir-file-index.md`），而 `.dev/README.md` 的标题仍是「**六大索引导航**」且表内只列 5 行（`kn2-s4-a5-verify.md` 未列，`README.md` 自身未列）⇒ 索引文件的索引先自漏一个。mtime：`project-dir-file-index.md`=**10-07 23:17**、`project-dev-status.md`=10-08 22:57、`docs-index.md`=10-08 23:02、`changing-log.md`=10-08 18:12、`changed-log.md`=10-10 09:51 ⇒ **Phase 1（10-08～10-10）与 Phase 2（10-10～10-12，T1–T12 + Phase 0 止血）五个批次的交付物，最晚登记时间＝10-10，收官两日零登记。**

逐件核验「Phase 2 新文件是否在 `.dev/` 有登记」（grep 全 `.dev/`）：

| 应登记新件 | `.dev/` 命中 | 判定 |
|---|---|---|
| `scripts/gate.mjs`（门禁本体，P0 基建） | **0 命中**（`grep -rl 'gate.mjs' .dev/` 空） | ❌ 未登记 |
| `scripts/GATE-POLICY.md`（门禁判据权威说明） | **0 命中** | ❌ 未登记 |
| `scripts/dep-lint.mjs` | 仅命中"**已删除**/属 Phase 2 规划"的过期叙述（`docs-index.md:90`「根 `package.json` `layout` 脚本键已删除（指向不存在的 `scripts/dep-lint.mjs`）」、`project-dev-status.md:41-42` 同） | ❌ **反向失真**：文件现已存在（T11 落地），索引仍写"不存在" |
| `scripts/config-key-lint.mjs`、`scripts/lock-probe.mjs` | **0 命中** | ❌ 未登记 |
| `tests/unit/phase2-{dep-direction,session-unknown,truth-mcp-direct,progress-message,mcp-signal,bearer-selfcheck,inner-credential,task-store-evict-observe}.test.js` | **0 命中** | ❌ 未登记（Phase 2 新增 8+ 测试件） |
| `docs/02-design/` 新页（见 ⑩-b） | `docs-index.md` 有 `ARCHITECTURE.md`/`06-OVERVIEW.md` 行，但 **`INSTALL-GUIDE.md` 等 8 个 `docs/*.md` 零命中** | ❌ 部分登记 |

**静态数字写死导致的必然过期（`.dev/project-dir-file-index.md:13`）**：仍写「`tests/unit/`（**59 个 `*.test.js`**）」，磁盘实为 **92 个测试文件**（t11 权威）⇒ 该文件 mtime 10-07，**体检 `docs/audit/2026-10-08-test-docs-audit.md:307` 早已指出同一行"滞后"**，一周后仍未修（且这行的成因正是"写死计数"，README 已为测试基线立了"不静态维护数字"的规矩，`.dev` 没沿用）。⇒ **P1：`.dev/` 应同 README 一样把计数改为"实跑/命令查法"，或由脚本派生。**

**`.dev/README.md` 的自我声明即违规根据**：文件内明写「本文件由 agent 在交付阶段同步维护」——**Phase 2 收官批（`13b8705`，10-12 18:44）未同步 `.dev/`**，这是规范未执行，不是规范缺失（对照⑫节）。

### ⑩-b `docs/` 死链批量验（**P1，且已污染 VM 运行态**）

用 `wbtmp/_linkcheck.mjs`（`git ls-files '*.md'` 全 184 件，正则抽相对链接并 `existsSync` 判定）实测：
```
MD files scanned: 184  relative links checked: 18  BROKEN: 11
```
**11 条死链全部指向同一族"审批卡片模板"**：
| 死链源 | 链接目标 | 真身实际位置 |
|---|---|---|
| `skills/winvm-app-manager/SKILL.md`（`:104`）等 **5 个领域 SKILL.md**（app-manager / app-operation / gui-automation / storage-manager / system-admin） | `../winvm-orchestrator/approval-card.md` | `skills/winvm-orchestrator/**references**/approval-card.md` |
| `skills/winvm-orchestrator/references/approval-card.md` 自身 | `../winvm-orchestrator/approval-card.md`（自指回上级，更绕） | 同上（即自己） |
| `skills/winvm-orchestrator/SKILL.md`（`:256` `:321` `:335`） | `./approval-card.md` | `./references/approval-card.md` |
| `skills/winvm-orchestrator/SKILL.md`（`:280`） | `./references/approval-card-widget.html` | **仓内不存在**；仅 `~/.workbuddy/connectors/skills/connector-winvm/winvm-orchestrator/references/approval-card-widget.html` 存在 |
| `docs/changes/CL-016/TECHNICAL-SOLUTION.md` | `../winvm-orchestrator/approval-card.md`（从 `docs/changes/` 出发根本跨不到 `skills/`） | — |

**三点加重定性**：
1. **这是 CL-016 的核心承诺破功**：CL-016 技术方案主张"审批卡片**唯一一份模板、6/6 Skill 引用**"，实测 **6 个引用点 100% 断链**（含被引用文件自己也在断链）。承诺-执行对账在这里不成立（不是"没做"，是"做了但路径写错，且机械不可达"）。
2. **污染运行态**：`~/.workbuddy/connectors/skills/connector-winvm/`（宿主 agent 实际加载的那份）**同样断链**（实测 `MISS winvm-orchestrator/approval-card.md`）；VM 侧 `C:/WinVMBridge/shared-skills/` 也断（本审计经 SSH **只读** `Test-Path` 实证：`approval-card.md`=False，`references/approval-card.md`=True）⇒ **宿主与 VM 两侧 agent 读到的都是错路径**，agent 若真去"按模板输出审批卡"就会读不到文件（退化为自由发挥，正是 CL-016 想根治的问题）。`approval-card-widget.html` 在 VM 侧也不存在（False）⇒ 引用了**只有 connector 分发面才有、shared-skills 部署不带**的件（双侧内容不一致，见⑫节 skills 同步度）。
3. **无机械防线**：全仓**没有**任何"文档内链可达性"守卫（`ls tests/unit | grep -iE 'index|docs|link'` = 0 命中，无 npm script、无 gate 件）⇒ 这 11 条只能靠人肉发现。对照 `phase2-snapshot-truth`/`contract-schema` 这类"文档即守卫输入面"的既有做法，加一件 `docs-link-reachability.test.js`（遍历 tracked `*.md` 的相对链接判 existsSync）成本极低、恒可跑（纯 fs，零环境依赖），**建议列为 P1 首要落地项**。

### ⑩-c 其余索引一致性观察（P2）

- `.dev/docs-index.md` 覆盖 `docs/02-design/*` 较全，但 `docs/` 根级 9 个 md 中 **8 个未登记**（`INSTALL-GUIDE.md` `INSTALL-VERIFY-REPORT.md` `gui-health-fix-2026-09-14.md` `oh-adaptation-plan.md` `oh-host-adaptation-delivery.md` `oh-host-install-run-test.md` `oh-host-selfcheck.md` `oh-tunnel-design.md`）⇒ 尤其 `INSTALL-GUIDE.md` 是**安装主入口文档**却不在索引阅读顺序里（索引第 10 条指向 `DEPLOYMENT.md`）。
- `.dev/project-dev-status.md:38` 权威口径行仍是 `71 文件/1247`（见⑤第 4 条）；`docs-index.md:96` 亦 1247。
- `.dev/changed-log.md` 与 `.dev/changing-log.md` **两个名字近似、职责不同（已交付/进行中）且互相引用**（各含对方名 3/1 次），`project-dir-file-index.md` 未列 `changing-log.md`（10-07 mtime，早于其诞生）⇒ 认知负担型设计，建议合并或明确改名（`delivered.md`/`pending.md`），P2。
- `docs/06-OVERVIEW.md:117` 指向 `.dev/changing-log.md`（存在 ✅），但同段"双连接器同生效…均已落地"的"落地"依据是 R18/R19/A2A/K3R 报告（其中 `real-test-2026-09-30-r18.md` 实况为 **BLOCKED-BY-ENVIRONMENT**）⇒ 把 BLOCKED 轮计入"多轮完成"的措辞偏乐观，P2 表述级（非假承诺，因链接可查）。

---

## ⑪ 文档一致性漂移清单（分层表 / 现状段 / 双概览）

**J-1（P1）ARCHITECTURE 分层三源互相矛盾，且 dep-lint 承诺的"口径注记显形"未兑现**
- 事实源 A（ASCII 图 `docs/02-design/ARCHITECTURE.md:101-107`）：L2 框内**只列 4 包**＝`adapter-host-workbuddy` / `adapter-agent-workbuddy` / `vm-service` / `vm-capabilities`。
- 事实源 B（§2.1 分层表 `:119-127`，10 行）：`host-a2a-bridge` 被标 **L2**（`:126`）；表内**无** `adapter-agent-workbuddy-llm`、无 `adapter-agent-hermes` 行。
- 事实源 C（机检唯一真源＝`packages/*/package.json` 的 `layer` 字段，12 包实测）：L2 前缀实为 **6 包**（`adapter-host-workbuddy`/`adapter-agent-workbuddy`/`adapter-agent-workbuddy-llm`/`adapter-agent-hermes`/`vm-service`/`vm-capabilities`），且 **`host-a2a-bridge` = `L3-host-bridge`**（图上无 L3 框、表上标 L2）。
- ⇒ 三源两两不一致：**图上缺 2 个 L2 包 + 缺 L3 整层；表上把 L3 包标成 L2；机检 rank 取 `L3=50`（`scripts/dep-lint.mjs:95-102`）**。
- **加重项（承诺未执行）**：`dep-lint.mjs:88-93` 注释明写"机检必须单一事实源 ⇒ 取 `layer` 字段（散文与字段若有分歧，**由本批 README/ARCHITECTURE 口径注记显形**，不在 lint 里私改一套 rank）"。实测：`grep 'layer' README.md` = **0 命中**；`ARCHITECTURE.md` 内 `` `layer` 字段``/`package.json` 作事实源的声明 = **0 命中**（仅 `scripts/GATE-POLICY.md:47` 有一句"分层 rank 取各包 `package.json` 的 `layer` 字段（机检单一事实源）"——**声明只活在工具文档里，架构正文不知情**）。⇒ T11 批承诺的"口径注记显形"**未落地**，正是"写了没人执行"的样本（P1）。
- 附 P2：`dep-lint.mjs:91` 称"设计 §254 散文把 `vm-service` 写作 L3"，实测 ARCHITECTURE 全文 `vm-service.*L3` = **0 命中** ⇒ 注释所引锚点在当前文档不成立（或已被 K-20 订正改写而注释未跟）。

**J-2（P2）门禁"不进门禁"表双写已产生单边项**：`GATE-POLICY.md` §2 = **6 行**，`gate.mjs GATE_EXCLUDED` = **5 条**（`grep -c 'scope:'`）⇒ 文档多出"类型级审计耦合"一行（代码无从机检，故不能进 GATE_EXCLUDED 数组——语义合理，但**双写无守卫** ⇒ 未来任一侧改表不会报警）。对照：ST3 七件表因有 `phase2-dep-direction.test.js` U-5「gate 导出的『进门禁表』与磁盘一致」而受保护（t11-red1.txt 在场），**唯独 §2 排除面没有一致性断言**。建议：把 §2 行数/范围文本纳入同族"表-码一致"断言，或文档改为"从 gate.mjs 导出符号渲染"。P2→建议提级 P1（成本一行测试）。

**J-3（P1）根 `overview.md` 把已废数字当"当前态"引用**：`overview.md:101`（tracked，mtime 2026-09-28）写「权威记录见 `docs/06-OVERVIEW.md`（**当前态：194/194 测试通过、12 包**）」——而 README §8 与 06-OVERVIEW **自 T11 起已废静态数字**（权威源＝最新 `*-sweep-result.txt`），194/194 更是第十七轮前的远古口径（现 92 件/1889）。同文件 `:19/:22/:48` 混用"5 个能力 / 5 个 A2A Skill / 54 能力"。该文件 `:101` 有「本文件为早期会话总结，止于第三轮」的自我限定（部分诚实 ✅），但**"当前态"三字仍会把读者引到过期数字**。建议：把"当前态：194/194"改为"当时的当前态（已废，见 README §8 查法）"，或整篇加 `.superseded` 头（K-20 前向指针惯例）。

**J-4（P1）HOST-A2A-BRIDGE §9 风险表过期，违反自家 K-20 惯例**：`:215-222` 四行仍标「❗未验证」——① `codebuddy` CLI 参数契约 ② 真机 VM 全链路 ③ GUI 类任务 ④ 宿主双连接器支持度。实测：②已由 `real-test-2026-09-24-run7.md` A5（18.4s 真实委派完成）+ `CL-K3R` on 模式 3/3 真机 + `a2a-coverage-2026-10-03.md` 覆盖；④由 `INSTALL-GUIDE.md` §8.1/`r2-m4-diagnosis.md` 闭环（双 connector 同生效，见 `06-OVERVIEW.md:117`）；①由 `e0b6945`（T6 真机 E1 探针实证 codebuddy 展开 `--mcp-config` headers 插值）间接验证 ⇒ **至少 2–3 行已过期**。而同文件 `:127` 已有规范做法的正面样本（「P2-T12 订正注记（2026-10-11）：缺陷已修复」+ 划线留痕）⇒ **同文档内新注记与旧风险表并存，说明作者知道该怎么改但 §9 漏了**。K-20「历史文档以加前向指针方式订正」在 §9 未执行。

**J-5（P1）K5 设计文档状态行过期**：`docs/02-design/K5-server-replay-approval.md:3`「**状态：设计定稿，待实现**」。实测该设计已落地并真机验收：`tests/unit/k5-replay.test.js`（41 例在册，且在 gate ST4 92 件内）、`docs/test/reports/k5-fix-qa-2026-09-29.md`、`docs/test/reports/real-test-2026-09-29-k5-e2e.md`；文件自己 `:106` 还追加了「§7 P2-T8 现状对齐（2026-10-12）」——**正文已随 Phase 2 更新到 10-12，头部状态行仍停在"待实现"**（13 天）。这是最典型的"局部更新、全局失真"。修法一行。

**J-6（P2）06-OVERVIEW「端到端全绿」无对应事实源**：`docs/06-OVERVIEW.md:4`「全部 12 个包编译通过，**单元测试与端到端全绿**」。实况：1889 例基线**不含任何 e2e**（⑤：`tests/e2e` 被枚举面结构性排除），而 `tests/e2e/smoke.test.js` 本机因无 PowerShell 不可跑绿（`which pwsh powershell` 空）。⇒ "端到端全绿"目前唯一可指的事实是**真机 A 系列**（最近 run7，④）。措辞需限定（"端到端＝真机 A 系列，最近轮 run7"）。
**J-7（P2）基线数字与权威口径的四处不同步**：`README.md:286-292` 命令返回 t9(1857) ≠ t11(1889)；`.dev/project-dev-status.md:38` 仍 71/1247；`.dev/docs-index.md:96` 同；`.dev/project-dir-file-index.md:13` 仍"59 个"；`docs-index.md:90` 仍称 `dep-lint.mjs` "不存在/属 Phase 2 规划"（反向失真，T11 已落地）。⇒ 见⑩-a/⑤-4，统一由"命令查法 + 派生"收敛。

**漂移分级汇总**：P1×5（J-1 J-3 J-4 J-5 J-7）、P2×3（J-2 J-6 + dep-lint 锚点）。**全部为"低成本一行到十行可修"类**，但 J-1/J-4 是**承诺未执行型**（比纯错字严重一档，因为它证明"文档纪律条款在跨批传递中会丢"）。

---

## ⑫ 规范执行迹象盘点（写了 vs 有人执行）

规范事实源：`docs/changes/phase2-arch-design.md` §7「约束继承」**K-1 … K-26 共 26 条**（实测 `grep -c '^| K-'` = 26），加 `scripts/GATE-POLICY.md`、`.workbuddy/memory/MEMORY.md:39`、`.dev/README.md` 自述。逐条抽验"是否有执行留痕"：

| 规范 | 成文处 | 执行留痕（实证） | 判定 |
|---|---|---|---|
| K-1 基线只进不退 + 对账式差异 | §7 K-1 | `qa/r19/` 演进链 8 档：`t8` 90/1809 → `t9` 91/1857 → `t11` **92/1889**（`p2close-sweep` 复证同数）；commit 叙事逐档带对账（如 `c5a9e40`「82/1511→84/1558（+47 逐位）」、`d277882`「85/1612→86/1657（+45 精确）」）；2 skip 恒 ssh2-resolve 有钉（`t11` CROSSCHECK + `gate.mjs` K-1 注释） | **执行良好（范本级）** |
| K-2 绝不 glob 整批 | §7 K-2 / GATE-POLICY §3① + `gate.mjs:26-29` 代码内建 | gate `runPerFile()` 每文件子进程；`phase2-dep-direction` U-5 断言"全量档参数不含目录式 glob"（t11-red1.txt 在场）；`qa/r19/p2close-out/*.log` 92 个逐文件 TAP 原始件 | **执行良好（且已机械化）** |
| K-10 守卫必须证伪 | §7 K-10 | 留档：`qa/r19/t11-red1.txt`/`t11-red2.txt`（假图必红 + 真仓反证"非恒绿"）、`t12-red-baseline.txt`（A1 逐键钉 RED 基线，含失败定位行号与错误文案）、`p2close-*.txt`；GATE-POLICY `:73` 自述"本批实测（K-10 证伪先行）"、`:156` config-key-lint"注入假键 ⇒ RED（证伪过）"、`:161` dep-direction"每条判据各一个反例" | **执行良好**，⚠ 但存在**证伪覆盖假象**（③A）：config-key-lint 只证伪了"假键"，**未证伪"target 文件不存在 ⇒ skipped 且 code 0"** ⇒ 永绿分支仍在。P1（补一条"缺 target 应判红/至少显式 SKIPPED"反例） |
| K-18 每轮只留一份权威 real-test（`real-test-<date>-run<N>.md`） | `MEMORY.md:39`、§7 K-18、`CL-020/DELIVERY-SUMMARY:138` | `docs/test/reports/` 22 份中**仅 5 份**符合命名模式；2026-09-23 同日 **5 份**（base+run2/3/4/6，run5 编号有洞）；10-05/10-06 用 `k3r-t05-*` 前缀，09-28/09-29 有 `real-test-2026-09-28-k4-approval`/`-uninstall-wecom` 等变体名 ⇒ **命名纪律弱执行**（体检 `:408` 已判"⚠ 部分"，本审计复核仍未修）；**Phase 2 期间（10-08～10-12）零 real-test 件** | **未执行（但成因正当）**：Phase 2 无全量真机轮 ⇒ 无从产出。纪律本身没被违反，**违反的是它依赖的前提（真机档期）**，与④同源。P1：命名模式建议加守卫件（`ls docs/test/reports` 判"同日多份须带 .superseded"或至少文档化） |
| K-19 裁决必须落档再引用编号 | §7 K-19 | `phase2-arch-design.md:456-640` **§13 + 13.1…13.12 连续 12 节**（L2-D 追加、T2 复核、T3b、T4 裁断、T5–T9、T12、T11、收官终判），逐节含"主理人独立核验/复跑/采信依据"；`.dev/changing-log.md:54`「Owner 裁决登记」；commit 引用形如「Q1=(b)」「§13.4 裁断」「PR10」 | **执行强（全项目最规范的一条）**；⚠ 唯一缺口：13.x **缺 T1 / T3 本体 / T10 的独立交付节**（有节者：T2、T3b、T4、T5、T6、T7、T8、T9、T11、T12），三者的交付证据只存在于 commit message（`664eff9`/`26f8e1c`/`c5a9e40`，实测 `git log | grep -oE 'phase2-T[0-9]+'` 13 个任务**全部有 commit**）⇒ **落档完整但节次不齐**，检索需回翻 commit。P2 |
| K-26 worker 增量落盘 + 真实 date 心跳 | §7 K-26 | `qa/r19/` 26 个 `*timeline*.txt` tracked + 25 个 `*.timeline.log`（被 `*.log` 忽略未入库，⑤-6）；`p2close-timeline.txt` 在场；13.9/13.10 明载"心跳密集零双写/双源判活" | **执行良好**（本审计自身遵同口径） |
| GATE-POLICY 门禁"跳过即视为未验收" | README §8 前引 + GATE-POLICY | 本审计实测 `node scripts/gate.mjs --quick` = **VERDICT GREEN**（ST1/ST2 hard=0 warn=0 info=11/ST2b 未知键=0/ST3 7 件 155 例），落盘 `wbtmp/audit-gate-quick.txt`；`qa/r19/p2close-gate-full.txt` + `t11-gate-full-rerun.txt` 全量档双档在场 | **执行良好**（有本次独立复跑直证） |
| K-23 版本指纹 > uptime（证 VM 跑哪版） | §7 K-23 | `grep buildId packages/*/src/*.ts` = **0 命中**；`/health` 无 `version`（`server.ts` 仅 `version:'0.1.0'` 硬编码）；DEP-02/OPS-07 在册未修 | **纪律在册、实现缺位**（⑧版本治理同源）。P2（但它是⑥⑦⑧"实跑了吗"的通用解药，建议提级） |
| `.dev` 交付阶段同步维护 | `.dev/README.md` 自述 | 见⑩-a：**Phase 2 收官批零同步**，最晚登记 10-10 | **未执行**（P1） |
| Skills 与 VM shared-skills 同步度 | `SPEC-SKILLS.md`、`deploy-shared-skills.mjs`、`install-vm` | 纠偏任务书表述：仓库 `skills/*/SKILL.md` 实测 **7 个**（非 9）＝1 总控 + 5 领域 + 1 MCP 参考（`docs-index.md:89` 亦记"7 目录"）。三面对账：**宿主 connector** `~/.workbuddy/connectors/skills/connector-winvm/` 7/7 与仓库 **cmp 逐字节 SAME**；**VM 现网**（SSH 只读抽查）`winvm-storage-manager` 白名单段**已含 `%USERPROFILE%` 新版**（⇒ VM 与仓库同步）；仓库内 `C:/` 陈旧快照（09 月末那次裸跑残留）则仍是旧白名单 `C:\Users\**`（缺 ARCH-17 收紧）⇒ 差异来源是**陈旧快照非运行态**。⚠ 真缺口＝`approval-card-widget.html` 仅存在 connector 面、shared-skills 部署不带（`Test-Path` False），而 `SKILL.md:280` 引用它 ⇒ 运行态断链（⑩-b）。守卫面：`tests/unit/deploy-shared-skills.test.js` 覆盖 `planSharedSkillLinks`/`planSkillPublish` 纯函数（含"绝不覆盖用户技能"）⇒ **链路有测试，但没有"三面对账（仓库/宿主/VM 逐字节一致）"守卫**；run7 的 A12「宿主-VM 技能同步 diff 无差异」正是这道对账，但它属真机轮（④：18 天未跑）⇒ 机械缺口成立。P1：把 A12 对账逻辑离线化为守卫件（比对 `skills/` 与 `~/.workbuddy/connectors/skills/connector-winvm/`，纯 fs 可跑） | **部分执行**（同步本身良好，缺机械对账 + widget 引用面未纳入部署集） |
| Phase 0 止血类"名实不符如实化" | `docs-index.md:89`、`phase0-docs-notes.md` | `9dd13bd` 处理 7 幽灵能力 + 12 条名实不符；本审计复核**仍有 2 处残留**：`tests/e2e/smoke.test.js:69`"四大能力域"（体检 `:92` 已登记未修）、`docs/06-OVERVIEW.md:4`"端到端全绿"（J-6） | **执行过，但存量未清零**（P2） |

**⑫ 总判**：工程纪律**总体不是"写了没人执行"**——26 条 K-x 里，我能拿出执行留档（文件路径+内容）的有 **K-1 / K-2 / K-10 / K-18（前提型缺档）/ K-19 / K-26 / GATE-POLICY / K-23（在册未实现）/ skills 同步（部分）**；**明确"写了未执行"的只有 2 条：`.dev` 索引同步（⑩-a，P1）与 ARCHITECTURE/README 的 layer 口径注记（J-1，P1）**。这正是"高纪律、低索引"的组合：执行面证据极其充分（每批 commit 数百字叙事 + qa/r19 逐档留档），但**面向新读者的入口文档（.dev/ 索引、ARCHITECTURE 分层图、README 基线查法）成了系统性短板**——它们不参与门禁，于是最先腐化。

---

## 汇总：问题分级与最小行动集

**审计期间实测的健康直证（不是坏消息）**：`gate --quick` VERDICT GREEN（本审计独立复跑，`wbtmp/audit-gate-quick.txt`）；终态基线 92 件/1889 例/0 fail/2 skip 双路径同口径（`qa/r19/t11-sweep-result.txt` + `p2close-sweep.txt`）；裁决落档（§13.1–13.12）、证伪留档（red1/red2/t12-red-baseline）、心跳留档齐备；凭据面零泄漏且 NFR-511 有代码防线 + 38 例守卫；隧道退避与幂等 ensure 设计正确且 HOURLY watchdog 实测今日 15:38 自动复活过一次。**Phase 2 的执行面纪律是这个项目最强的资产。**

### P0（须在下一批前处理／或本身即下一批）
1. **④ 真机全量回归缺口**：最近全量真机 E2E＝`real-test-2026-09-24-run7.md`，其后 **59 批 src 提交 / 98 文件变更**（含 psmod 3 批、`vm-service/src` 48 处）；最后一次任何真机留档＝**2026-10-06**，其后 24 批（Phase 0/1/2 全部）零真机。`psmod-contract` 自述"零 PowerShell 依赖、零 spawn" ⇒ 91 个 PS 函数的真实行为只由 A 系列担保。**行动**：派一次真机窗口（lock-probe GO 前置 + K-5 错峰），跑 A1–A18 + T4 遗留三条 + T7 驱逐曲线（同窗打包）。
2. **⑥ 隧道启动失败不重试且不留终态证据**：`tunnel-daemon.mjs:273-276` catch ⇒ `shutdown()`（rmSync pidfile+state）⇒ exit 1，**无退避重试**（2026-09-30 09:28–09:31 十条 EHOSTUNREACH 即此型，VM 晚醒一分钟就踩）；失败后**不留 STOPPED 文件**，运维只能翻日志。**行动**：启动阶段纳入同款指数退避（`oh-tunnel.mjs:553-556` 现成），失败保留 `state=STOPPED+reason`（与 giveup 路径语义对齐）。

### P1（下一批内修，逐条都有明确落点）
| # | 问题 | 落点 |
|---|---|---|
| ⑩-b | **审批卡 11 条死链**（6/6 引用点 100% 断链，宿主 connector 面与 VM `shared-skills` 面同样断，`approval-card-widget.html` 仅 connector 独有）＝CL-016"唯一模板"承诺破功且污染运行态 | `skills/*/SKILL.md` 改指 `../winvm-orchestrator/references/approval-card.md`；widget 纳入部署集或删除引用；**新增 `docs-link-reachability.test.js`**（纯 fs，可进 ST3） |
| ⑤-1/2 | **孤儿测试**：`tests/e2e`(16 例) + `delivery/__tests__`(8 例) 被 `gate.mjs:273-278` 枚举面结构性排除，且 §2「不进门禁」也未登记 e2e ⇒ 沉默孤儿；治理规则（memory 2026-10-04:144）主动把测试引到 gate 覆盖外 | 枚举面加 `tests/e2e`（带 PowerShell 环境守卫 skip）与 `delivery/__tests__`，或在 GATE-POLICY §2 显式登记覆盖去处 |
| ③C | `phase2-snapshot-truth` 双白名单＝**永红守卫**（解构写法实测绕过 `CONSUME_RE`，靠文件级 `/snapshot/i` 撞 WHITELIST 报错误因）；每新增含 snapshot 字样文件需手改测试 | `CONSUME_RE` 补解构分支 + WHITELIST 改从 contracts 审计符号派生（T11 样板） |
| ③B | `config-key-lint` target 缺失 ⇒ `skipped` + code 0，`delivery/.generated/` 是 09-30 陈旧件、VM 真跑配置不在扫描面 ⇒ **覆盖假象**；且 K-10 证伪未覆盖此分支 | 缺 target 显式输出 `SKIPPED(missing:…)` 并降为 warn/红；补反例测试 |
| ⑥/⑫ | 无**隧道运维专页**（配方散落 INSTALL-GUIDE §7.1/§8 + memory 手写）；`ensure` 无互斥（今日 4 处同毫秒双写＝并发实例旁证）；日志行无 pid 无法归因 | 新建 `docs/05-perPeriphals/RUNBOOK-TUNNEL.md`（判活三值/三型死法/唯一恢复动作/并发排查）；pidfile `wx` 独占；日志加 pid 前缀 |
| ⑧ | 「改 dist 必须实跑 install-host」只在 MEMORY/审计/设计里，**README §6/§8 与 INSTALL-GUIDE §8 两张排障表零可见度**；`install-host.mjs` 对 dist 仅存在性校验（`grep createHash`=0）⇒ 新鲜度无从证明 | 排障表各加一行；install-host 尾相位加**缓存↔源哈希对账断言**（一条改动同时收敛⑥⑦⑧类问题） |
| ⑦ | winget 子进程树未 taskkill `/T`（审计 OPS 在册未修，`app.ps1` grep 0 命中）⇒ 卸载类操作可留孤儿安装进程 | `app.ps1`/`appops.ps1` 侧引入与 `persistent-session.ts:140-151` 同款树杀 |
| ⑩-a/⑪ | **`.dev` 六索引 Phase 2 零登记**（gate.mjs/GATE-POLICY/config-key-lint/lock-probe/8 个 phase2-* 测试全 0 命中；`dep-lint.mjs` 仍写"不存在"＝反向失真；`project-dir-file-index.md:13` 仍写 59 个）；**ARCHITECTURE 分层三源矛盾**（图缺 2 个 L2 包与 L3 整层、表把 `host-a2a-bridge`(L3) 标 L2、机检取 `layer` 字段）且 T11 承诺的"README/ARCHITECTURE 口径注记显形"**未兑现**（两文件 `layer` 0 命中） | 索引一次性补齐 + 计数改"命令查法"；ARCHITECTURE §2.1 补 L3 框与 2 包并明写"`package.json` `layer`＝机检单一事实源"；README 加同句指针 |
| ⑪ | 状态行过期三处：K5 设计 `:3`「待实现」（实已落地+真机验收，正文却更新到 10-12）、HOST-A2A-BRIDGE §9 四行「未验证」（至少 2–3 行已由 run7/K3R/T6 闭环，违反自家 K-20）、`overview.md:101` 把"194/194"称"当前态" | 各加前向指针/订正注记（10 行内） |
| ⑫ | Skills **三面对账无离线守卫**（宿主 connector 7/7 与仓库 cmp SAME、VM 现网同步良好，但对账只在真机 A12，18 天未跑）；K-18 real-test 命名纪律 22 份中仅 5 份合规且无机械检查 | A12 逻辑离线化为守卫件；命名模式加轻守卫或文档化 |
| ② | 238 个 `tests/fixtures/cl018-logs/log-*` 残留（收官 sweep 仍在新增，清理被 `catch{/*ignore*/}` 吞）＋ `phase2-dead-config` 的 `cfg-*` **不在 .gitignore 覆盖内**（未在册入库风险） | 夹具改 `os.tmpdir()` 或加陈旧 GC；`.gitignore` 补 `tests/fixtures/**/{cfg,log}-*/` |
| ⑨ | — | （本维度无 P1） |

### P2（择机／可并入 T13 候选清单，共 14 项，详见各节）
`phase2-truth-mcp-direct` describe 嵌套 1 件 2 处（AST 全扫唯一命中）｜`smoke.test.js:69` 名实不符｜s5 断言 6 自我命名恒真｜GATE-POLICY §2 与 `GATE_EXCLUDED` 双写单边项无一致性断言｜`tests/psbridge-smoke.mjs` 无归属｜qa 逐文件 TAP 原始件与 timeline.log 不入库（107 ignored）｜9 个 `commit_msg*.txt` 未忽略｜工作树 `%LOCALAPPDATA%`/`C:/` 垃圾目录仍在（缺陷本体未修，跑 e2e 即复活）｜tunnel.log 无轮转｜README §6 未列"改 psmod 须 kill-restart"｜VM 遗留物无对账清单｜版本 0.1.0 三处硬编码 + tag V1.0.0 并存 + `/health` 无 version/buildId（K-23 缺位）｜合成 token 注释钉 + `vm-conn.json` 收 0600 + memory 凭据纪律成文｜`§13.x` 缺 T1/T3/T10 独立节｜`.dev` changed-log/changing-log 双名近似且互引。

### 建议起手顺序（若只挑三件）
1. 真机窗口批（P0-④，一次性关掉④⑤⑦⑫里所有"只有真机能证"的缺口）；
2. 死链 + 文档内链可达性守卫 + `.dev`/ARCHITECTURE 口径补齐（P1 中最廉价、影响新人最大的一组）；
3. `install-host` 缓存哈希对账 + tunnel 启动退避（各 10–30 行，把⑥⑦⑧的"实跑了吗"变成机械可答）。
