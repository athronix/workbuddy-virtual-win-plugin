# P5-C0 转呈面专项（K6 折叠）· QA 独立回归验证报告

- 验证人：严过关（QA）· 2026-10-16
- 被验对象：`4e83985`（纯函数件+真值表16）/ `a17eaf5`（下沉 core）/ `5883b40`（server 接线+服务行为钉9）/ `85aa573`（adapter 审计折叠+钉6）/ `330a163`+`e25611e`（文档+notes）
- 纪律：不采信任何自报与主理人摘要，逐件亲跑；变异反证在仓库外副本（`/storage/Users/currentUser/wbtmp/qa-c0/repo`）进行，仓库零写盘；不碰 VM/SSH/deploy
- node v24.13.0；全部单文件 `node --test`（绝不 glob 整批）

## 终判：**IS_PASS: YES**（附 1 条 ⚠ 证据副本层缺陷，路由主理人，不影响代码结论）

---

## V1 逐件亲跑（期望=自报值 vs 实际=亲跑值）

| 件 | 期望 | 实际 | 结论 |
|---|---|---|---|
| p5-c0-k6-verdict-fold | 16 | tests=16 pass=16 fail=0 | ✅ |
| p5-c0-k6-fold-service | 9 | tests=9 pass=9 fail=0 | ✅ |
| p5-c0-k6-audit-fold | 6 | tests=6 pass=6 fail=0 | ✅ |
| k5-replay | 41 | tests=41 pass=41 fail=0 | ✅ |
| r3-uninstall-verify | 39 | tests=39 pass=39 fail=0 | ✅ |
| cl017-error-reason | 10 | tests=10 pass=10 fail=0 | ✅ |
| phase2-contract-code-fidelity | 22 | tests=22 pass=22 fail=0 | ✅ |
| p4-b9-errcode-registration-pin | 12 | tests=12 pass=12 fail=0 | ✅ |
| phase2-dep-direction | 32 | tests=32 pass=32 fail=0 | ✅ |
| `npx tsc -b tsconfig.build.json` | EXIT=0 | EXIT=0 | ✅ |

九件 187 例全绿、计数与自报逐一吻合；触及面（k5-replay/r3/cl017/fidelity/b9/dep-direction）六件同步亲验无一红。

## V2 折叠判据活性反证（三组变异，仓库外副本，改消费面 dist 产物）

副本基线先跑：三件 16/9/6 全绿（排除复制/junction 环境噪音）。

| 变异 | 手法 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| MUT-1 | `packages/core/dist/k6-verdict.js` 判据 `=== false`→`!== true` | verdict-fold 的 `{}`/`"false"`/`0` 不触发例转红 | **fail=6**：不触发面②组 4 例（`{}`/`"false"`/falsy 族/dryRun 无键）+ ⑤组 2 例变异对照全红 | ✅ 判据真活 |
| MUT-2 | `packages/vm-service/dist/server.js` record 还原 `fold.ok`→`res.ok` | fold-service audit/receipt 观测钉红 | **fail=1**：恰「/audit/receipt 环形缓存条目 ok=false」红（其余 8 例不受触——呈报面走 structuredContent 与 record 独立，符合接线形态） | ✅ record 前折叠是真判据非源码钉 |
| MUT-3 | `packages/adapter-agent-workbuddy/dist/index.js` 折叠调用摘除（fold 置恒不触发形） | audit-fold 写入值断言红 | **fail=1**：恰「data.success=false ⇒ 链条目 ok:false+EXECUTION_FAILED+诚实 summary」红（静态钉 5 例仍绿——证实静态面与行为面分层，行为面独立有效） | ✅ 写入值断言真活 |

**变异后逐一点还原、复跑三件 16/9/6 全绿**（副本 grep 复核零残留）——排除环境残留假红/假绿。三组变异反证全部闭合：折叠守卫不是装饰品。

## V3 真实现场行为复核（离线直调 `packages/core/dist/index.js`，脚本 `wbtmp/qa-c0/v3-behavior.mjs`）

- ① `{success:false, residualEvidence:'R'×300}` ⇒ errorMessage 含「残留证据」截断段、尾带 `…`、**总长 225 ≤ 有界**；✅
- ② `{success:false}` 无证据 ⇒ `errorMessage === K6_FAIL_MESSAGE` 恰等基干（无空证据段、无双拼）；✅
- ③ 数组顶层 `[{success:false}]` ⇒ 不触发（ok=true/errorMessage=undefined）；✅
- ④ **双拼互证（notes §6 第③条单源声明核实）**：实读两处消费源码——`server.ts` L1338 `message: fold.errorMessage ?? K6_FAIL_MESSAGE`（消费组装完成的单串，`??` 仅未命中兜底，折叠命中时证据段只出现一次，脚本断言基干与分隔符各仅 1 次 ✅）；`approval-replay.ts` L230-232 `toExecutedResult` 失败支 `执行未成功：${errorMsg}` 直接透传 `sc.error.message`，**不再二次拼证据段、不调 residualEvidenceSummary**；`summaryFromData`（L247）仅成功支消费，失败支不走。结论：**单源组装成立，无 server 侧双拼**；✅（v3 4/4 EXIT=0）

## V4 契约与文档一致性抽查

1. **§2.6 EXECUTION_FAILED 行**：`git show 330a163` diff 核实仅该行描述列变更（`底层执行失败（附 PowerShell 错误）；含…折叠呈报（reason=K6_VERIFY_FAILED，C0）`），码列/可重试列（否）未动 ⇒ p4-b9 双向对账（钉的是码集行序，非描述）不受触，亲跑 12/12 绿自洽。✅
2. **error 块形状**：`{code,message,retryable,reason}` vs contracts `errors.ts` L54-95（`reason?: string` 纯增量、显式才写）与 §2.4 既有码块 `{code,message,details,retryable}` 形状互读一致；server 直写字面量对齐现场同构（notes §6 ① 已如实登记）。✅
3. **VERDICT 残留口径**：分层矩阵「委派完成步携折叠回执=可选观察不阻塞」与 notes §7 残留第 1 条一致；grep「端到端全绿/全绿」于 `qa/p5-batch/c0/VERDICT.md` **零命中**，无过度宣称。✅
4. **adapter 信封不折叠（notes §6 ④）**：`git show 85aa573` diff 判语义——折叠仅作用于 `ctx.audit.append` 条目的 `result` 三元形态，provider 返回信封 `res.ok` 零触碰；audit-fold 第 2 例活测 `res.ok===true ∧ res.data.success===false` 实证（副本直调真实 dist）。宣称与语义一致。✅
5. **⚠ 证据副本字节损坏**：`qa/p5-batch/c0/chain-replay-entry.json`（seq5 决定性实证副本）**非法 JSON**——`JSON.parse` SyntaxError@pos 567；hexdump 实测 summary 串尾为 `EF BC 3F 7D 2C`，应有形态 `EF BC 89 22 7D 2C`（`）"},"`）：全角右括号「）」U+FF09 第三字节 `89` 腐化为 `3F`（`?`）且**字符串闭合引号 `22` 被吞**——典型 Windows→Linux 转写多字节边界截断（1 个解码替换符）。四元组：现象=证据副本文件不可 JSON 解析；根因=归档转写编码截断（非链本身、非被验代码）；证据=hexdump+parse 栈（本件为 25926b4/c9fc767 引入的副本层）；关键判定信息（`ok:false`、`EXECUTION_FAILED`、`…K6 核验未过` 文本、seq5、prevHash/hash 字段）肉眼面仍完整，VERDICT 引用文本与链语义吻合。**路由主理人**：从 VM shard 原链重导出该条替换副本并复核 hash（QA 不重写证据、不碰 VM）。不影响 IS_PASS。

## V5 gate 证据复核

`qa/p3-batch-sweep/gate-p5-c0-final.txt`：汇总行 `FILES=121 FAILED_FILES=0 TOTAL_TESTS=2162 PASS=2160 FAIL=0 SKIP=2 · DISK=RUN=121 MATCH · VERDICT: GREEN`。抽查口径：C0 三件（16/9/6）+ 触及面 k5-replay 41 / r3 39 / cl017-error-reason 10 / fidelity 22 / b9 12 / dep-direction 32——**九件 gate 数字与我 V1 亲跑逐一吻合**，ST3/ST4 分账（178+1984=2162）自洽。✅

---

## 结论汇总

- V1 ✅ 九件+触及面全绿计数吻合，tsc EXIT=0
- V2 ✅ 三组变异各自精确转红（6/1/1 例）且还原转绿——折叠判据、record 前时序、审计写入值三层守卫全为活性
- V3 ✅ 真 dist 直调行为吻合 + 单源防双拼源码互证成立
- V4 ✅×4 + ⚠×1（证据副本腐化，路由主理人重导出）
- V5 ✅ gate 数字与亲跑口径一致

**IS_PASS: YES** —— C0 K6 折叠实现（纯函数件/服务接线/审计写入点）经独立亲跑+活性变异反证+行为复核+契约互读可信；无源码缺陷需路由工程师；唯一 ⚠ 为证据归档副本字节层损坏，归主理人处置。
