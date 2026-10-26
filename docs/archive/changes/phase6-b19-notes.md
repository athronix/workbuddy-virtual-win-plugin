# Phase 6 · 批19 施工记录

> 开批：2026-10-17（用户裁断批18 收口时剩余唯一待裁项后）
> 结论：**T1（SessionHealth「未知」语义边界文档注明）执行完毕** —— 以准确措辞落注 IF-6，
> 规避 E5 守卫钉禁的裸表述；全量 gate 复跑 GREEN（§三）。

---

## 一、T1 · SessionHealth「未知」语义边界文档注明（P2，不改代码）

### 1.1 用户裁决

批18 收口时剩余唯一待用户裁项：`SessionHealth` 无法表达「未知」。
用户裁（2026-10-17）：按建议处置 = 文档注明「仅 `state==='healthy'` 时该字段才有意义」，不改代码，并入批19。

### 1.2 施工前核验：建议措辞与在册静态守卫冲突（本批最关键发现）

回仓核验发现，建议措辞中的裸表述「仅 state === 'healthy' 才有意义」正是
`tests/unit/phase2-session-unknown.test.js` **E5 组明令钉禁**的字样：

```
E5 旧临时口径未回潮：活文档不再出现「仅 state===healthy 才有意义」裸表述
  ⇒ HOST-A2A-BRIDGE.md / INTERFACES.md / SECURITY-GOVERNANCE.md / health.ts 四份活文档
```

该裸表述是 P2-T9（E-2，commit 349ecc2）**之前的临时口径**，E5 自那时起钉禁其回潮，
理由是它**未兑现且与现行语义相悖**：E-2 落地后，「未知」已有正式表达通道
（`probeError`/`probeErrorCode` 三码：`PROBE_NOT_WIRED`/`PROBE_TIMEOUT`/`PROBE_EXCEPTION`），
`state` 四值（`healthy`/`degraded`/`unavailable`/`black-screen`）**均为有效观测**。
若按原措辞落字 ⇒ ① E5 判红、门禁不过；② 向消费者传达与 SECURITY §5.3 相悖的过期语义。

⇒ **本 Phase 第三例「backlog 说没做、其实早已以更好方式完成」**（前两例：批18 D-1 schema、D-2 K3 单测）：
backlog 的「先文档注明」是 E-2 之前的止损计划；E-2 既根治了问题（机读码表达未知），
也已把语义边界写进三处活文档（§5.3「探测失败 ≠ 会话不可交互」/ IF-6 E-2 字段注 / 契约接口注释）。

### 1.3 实际执行（忠于裁决意图 + 准确措辞）

用户裁决的**意图**是把「未知」语义边界向消费者显性化（不改代码）。以现行语义的准确措辞兑现，
落点 `docs/02-design/INTERFACES.md` IF-6（/health 消费者契约），新增一段注：

> **`session.state` 取值语义（消费者必读）**：四值 `healthy`/`degraded`/`unavailable`/`black-screen`
> **均为有效观测**——`healthy` 为会话健康；`degraded`/`black-screen` 为探针应答后确认的异常；
> `unavailable` 为确实无交互式会话。合约**不引入 `unknown` 枚举**（会话状态三态化已被设计否决，
> `tests/unit/phase2-session-unknown.test.js` B6 钉）：「探测未能得出结论」**不由 `state` 承载**，
> 而由 `probeError`/`probeErrorCode` 显形（见下注）⇒ 消费者**不得**把非 `healthy` 的 `state`
> 反推为「状态未知」；只有 `unavailable` 且两键缺席，才是「确实无交互会话」的结论。

新注与 E5 禁字零交集（不含「才有意义」字样），与 E2 要求子串（probeError/probeErrorCode/
PROBE_TIMEOUT/纯附加/firstCallLatencyMs）全部保留；且补上了原文档缺失的一块——
「state 无 `unknown` 枚举系设计裁定（B6 钉）」此前只存在于测试、未对消费者明示。

### 1.4 未改代码的确认

零 src 改动（`git status` 仅 1 个文档文件 + 记忆/证据文件）⇒ 无需 tsc 重建产物、无需 deploy/重启。

---

## 二、变更清单

| 文件 | 变更 |
|---|---|
| `docs/02-design/INTERFACES.md` | IF-6 新增 `session.state` 取值语义消费者注（准确措辞，过 E5/E2） |
| `docs/changes/phase6-b19-notes.md` | 本记录（新建） |
| `qa/p3-batch-sweep/gate-p6-b19-t1.txt` | 全量 gate 证据（新建） |

## 三、验证

| 判据 | 结果 |
|---|---|
| `phase2-session-unknown.test.js`（E1–E7 文档守卫 + PR8 恒 false 矩阵，含 E5 禁字复算） | **48/48 绿**（改前基线 + 改后复跑各一次） |
| `p4-b9-errcode-registration-pin.test.js`（INTERFACES §2.6 码表钉，同文档另一锚点） | **12/12 绿** |
| 全量 gate（ST1 tsc → ST2 dep-lint → ST2b config-keys → ST3 守卫 9 件 → ST4 sweep 115 件） | **GREEN · FILES=124 FAILED_FILES=0 TOTAL_TESTS=2179 TOTAL_FAIL=0 TOTAL_SKIP=2 · DISK=RUN=MATCH** |

基线 124/2179 零漂移（纯文档注，不增删测试例）；2 skip 恒 ssh2-resolve OFFLINE_SKIP（既有权威口径）。

## 四、backlog 销账

MEMORY.md backlog 区「SessionHealth 无法表达「未知」」条按销账模式替换（原文见 §1.2 论证）；
里程碑段补「批19 开」；关键坑段「静态守卫输入面」从 src 注释扩展到**裁决建议措辞**（§五）。

## 五、方法论留痕

1. **裁决措辞先过守卫面再落字**：本批给用户的建议措辞直接引用了一条被静态守卫钉禁的过期字样
   （E5）。教训：把字段名/字样写进任何交付物——**包括向用户提的处置建议**——之前，
   先 grep 同名静态断言。这是 MEMORY「注释文本也是静态守卫输入面」的同族扩展，
   本次把该纪律的适用范围从 src 注释扩展到裁决建议与文档措辞。
2. **「先文档注明 X」类 backlog 要核验 X 是否已被更好的方案兑现**：E-2 不但根治还载明了边界，
   原措辞反而成了过期信息（第三例 stale backlog，前两例 D-1/D-2 均在同批返工）。
   判别式：backlog 含「先/临时/待补」字样 ⇒ 高嫌疑陈旧，回仓查该字段的现行测试钉与文档注。
