# Phase 5 · C0 转呈面专项施工记录（K6 假成功回潮面根治，software-engineer-2）

日期：2026-10-16 · 立案：`qa/p5-batch/v19-VERDICT.md` / `docs/audit/2026-10-16-v19-analysis.md` §6.2
分笔：`4e83985`（C0-1a 纯函数件+真值表钉）→ `a17eaf5`（C0-2a 下沉 core）→ `5883b40`（C0-2b 服务接线+行为钉）→ `85aa573`（C0-2c 链审计折叠+写入值钉）→ 本笔（C0-2d 文档+notes）

## 1. 锚点与前后对照

### C0-1 · 服务层单点折叠（`packages/vm-service/src/server.ts` `executeCapability`）

现场锚点（改前）：
- L1306 `receiptCache.record(res.traceId, cap.id, res.ok, res.data)`
- L1309-1311 `return { isError: !res.ok, structuredContent: { traceId, ok: res.ok, … } }`

改后（行号 1312-1345）：
```ts
const fold = foldK6Verdict(res.ok, res.data);
const k6Flip = fold.k6Failed && res.ok;
receiptCache.record(res.traceId, cap.id, fold.ok, res.data);   // ← 折叠在 record 前（时序契约）
return {
  isError: fold.isError,
  structuredContent: {
    ok: fold.ok,
    …,
    ...(k6Flip
      ? { error: { code: 'EXECUTION_FAILED', message: fold.errorMessage ?? K6_FAIL_MESSAGE,
                   reason: 'K6_VERIFY_FAILED', retryable: false } }
      : res.error ? { error: res.error } : {}),
  },
};
```
- 折叠命中 ⇒ `structuredContent.ok=false`、`isError=true`、error 块复用契约码 `EXECUTION_FAILED`
  （retryable=false 取 `DEFAULT_RETRYABLE` 缺省，未新增码 ⇒ §2.6 行集与 p4-b9 漂移钉不受触，
  仅描述列加一句语义）；`reason='K6_VERIFY_FAILED'` 走 CL-017 D23 reason 字段先例。
- 残留证据：`fold.errorMessage` 在 k6-verdict 内组装即含 `；残留证据: <截断200>`——
  进 summary/error 文案（委派链与 LLM 天然可见），不新增顶层大对象，防回执膨胀。
- **只翻转假成功**：`k6Flip = fold.k6Failed && res.ok`——provider 已自报失败（res.ok=false，
  携带自家 TIMEOUT/POLICY 类 error）的回执原样透传，不被 EXECUTION_FAILED 覆盖（行为钉②b）。
- `data` 原样保留（verified 三态/residualEvidence 不吞）；dryRun（success=true/无键）不受影响。
- 下游零改动受益面：`toExecutedResult`（读 `sc['ok']===true`）诚实改判 ⇒ K5 重放、
  委派 bridge.ts `服务端执行回执` 转呈、`/audit/receipt` 环形缓存（record 已消费 fold.ok）。

### 折叠判据真源（`packages/core/src/k6-verdict.ts`，C0-1a + 2a 下沉）

- `foldK6Verdict(envelopeOk, data)`：plain object ∧ `data.success === false`（**严格布尔**）⇒
  `{ok:false, isError:true, k6Failed:true, errorMessage}`；`undefined/true/"false"/0/null/[]/{}/primitive`
  一律不触发（向后兼容零误伤）。信封已假时保持假（只收紧不翻案），k6Failed 仍标记供文案面用。
- `residualEvidenceSummary(data)`：string 原样 / 其它 JSON.stringify，截断 200 字符+`…`；
  空形态（缺键/null/空串/空数组/`{}`/`[]`）⇒ undefined（不写空证据段）。
- 下沉 core 动机（2a）：adapter 链上面与 server 回执面**双侧消费同一函数**（依赖方向
  L2-adapter / L2-vm-service → L1a-core 合法；phase2-dep-direction 32 例复绿）；
  `vm-service/index.ts` 保留 `@winvm/core` 再导出垫片（同 policy-gate 纪律）。

### C0-2c · 链上审计写入点（`packages/adapter-agent-workbuddy/src/index.ts` execute 成功支）

现场锚点（改前）：L542 `result: { ok: true, summary: \`${req.capabilityId} 执行成功\` }`
（恒真——ok 来源=bridge.call 未抛=进程级送达；`data.success` 零消费；消费面
`delegation-audit.ts:390` `recordExecuted(record, record.result?.ok === true)` ⇒ 账本归因被污染）。

改后：写入前 `const fold = foldK6Verdict(true, data)`；条目改三元：
```ts
result: fold.k6Failed
  ? { ok: false, errorCode: 'EXECUTION_FAILED',
      summary: `${req.capabilityId} 执行未成功：${fold.errorMessage ?? '执行器自报未成功（K6 核验未过）'}` }
  : { ok: true, summary: `${req.capabilityId} 执行成功` },
```
- provider 返回信封保持 `res.ok=true`（送达事实不改写——呈报折叠归服务层回执面，两面对同一
  data 各自判、互不叠加；K5/委派转呈经服务层 fold 已诚实）。
- `errorCode` 落位形态对齐同文件 fail() 站点既有先例（L1247 `result:{ok:false, errorCode, summary}`）。

## 2. C0-2 呈报文案核对结论（规格第二组）

- `adapter index.ts:542` 即主理人裁定的例外（2c），已折叠（上节）。
- LLM provider（adapter-agent-workbuddy-llm）与 host-a2a-bridge、a2a-framework：**零链上
  执行回执写入点**——git grep `audit.append` 全仓 adapter 域恰 2 处（本成功支 + fail 站点）；
  框架零写入由既有 r19c-kn1-e-mutation E-3(a) 钉承保。防漂移钉已加
  （p5-c0-k6-audit-fold ⑥：写入点数≠2 即红）。
- `bridge.ts:1548-1567` 合成步骤 `ok:true`（回合级恒值）不改：V19 病灶的呈报路径经
  `executeCapability`/链条目两面折叠后，内层回执与链摘要已携带 K6 真值，合成步语义为
  「回合送达」非「业务成功」，动它=行为改动超规格——登记不扩改。
- delegation-truth.ts（LLM 桥 K3 启发式）零触碰（第二层保留，本批是第一层）。

## 3. 守卫预检与同步清单（先跑再改，全部零同步）

| 预检 | 结果 | 处置 |
|---|---|---|
| `git grep -n "EXECUTION_FAILED" -- tests/` | 命中均为他路语义（取消/审批路由/领域码映射/b9 变异面） | 零同步 |
| `git grep -n "执行成功" -- tests/ skills/ docs/` | k5-replay:360（toExecutedResult 正例 data 无 success 键）等 | 零同步，复跑绿 |
| `git grep "receiptCache.record(res.traceId\|isError: !res.ok" -- tests/` | 空 | 旧形态无钉 |
| k5-replay E 组源码形态钉（`async function executeCapability(` 等） | 接线不触字面量 | 复跑 41/41 绿 |
| assembly-guard（recordPolicyDeniedAudit 计数/块切片） | 未触 | 24/24 绿 |
| r19c-kn1-e-mutation（channel 双写点/ext 三元组计数） | 2c 不动 principal/ext 形态 | 54/54 绿 |
| phase2-snapshot-truth（server.ts 白名单+消费形态） | 未引入 snapshot 词 | 17/17 绿 |
| p4-b9-errcode-registration-pin（§2.6 双向对账+数字复写） | 仅描述列加一句、无新增码、文案无「封闭N码」 | 12/12 绿 |
| phase3-skill-claims-guard | 未触 SKILL | 11/11 绿 |
| audit / p0-path-traversal（SECURITY-GOVERNANCE 消费面） | §4.5 纯新增小节 | 112/112 绿 |

**注**：「K6 折叠失败文案基干 `执行器自报未成功（K6 核验未过）`」为新串，与既有钉文案
（`执行未成功`、`执行回执缺失…`）无冲突；errors.ts 头注「封闭码集」字样未复写数字。

## 4. 过关序列终跑（逐件，绝不 glob）

| 件 | 数 | 结果 |
|---|---|---|
| p5-c0-k6-verdict-fold（新，①⑤） | 16 | 绿 |
| p5-c0-k6-fold-service（新，②③④+静态钉） | 9 | 绿 |
| p5-c0-k6-audit-fold（新，2c 写入值+防漂移） | 6 | 绿 |
| k5-replay | 41 | 绿 |
| r3-uninstall-verify | 39 | 绿 |
| cl017-error-reason | 10 | 绿 |
| phase2-contract-code-fidelity | 22 | 绿 |
| phase2-mcp-signal | 54 | 绿 |
| p4-b9-errcode-registration-pin | 12 | 绿 |
| phase3-skill-claims-guard | 11 | 绿 |
| p4-b10-resident-scope-e2e（重放/receipt 触及面） | 11 | 绿 |
| phase2-dep-direction（2a 下沉触及面） | 32 | 绿 |
| 补判触及面：cl020-f2 5 / r19c-kn1-e 54 / kn1-a 76 / hermes 10 / cl017-param-guard 10 / param-value 34 / t5-provider-cancel 12 / assembly-guard 24 / t4-assembly 45 / p3-b1-policy-gate 29 / snapshot-truth 17 / cl019 14 / p5-r1 17 / audit+p0-traversal 112 | — | 全绿 |

tsc：`npx tsc -b tsconfig.build.json` EXIT=0（每笔 commit 前均复跑）。

## 5. 真值表逐例结果（C0-3 ①–⑤）

- ① 纯函数真值表：`{success:false}`+ok=true⇒折叠 ✓；`{success:true}`⇒不折 ✓；`{}`/无键 ✓；
  `success:"false"`（字符串）✓；`success:0/null/''/NaN` ✓；null/数组/primitive data ✓；
  envelopeOk=false⇒假保持+不翻案 ✓；dryRun 形态 ✓（= 16 例中 ①组 9 例）。
- ② 行为面：桩 provider（信封恒 true+可控 data）起真服务打真 HTTP ⇒ `ok:false`+`isError:true`
  +`EXECUTION_FAILED`+`reason=K6_VERIFY_FAILED`+message 含残留证据截断+data 不吞 ✓；
  `success:true`/无键/字符串 ⇒ 逐字旧形态（无 error 键）✓；provider 自报失败 ⇒ 自家 error 不被覆盖 ✓。
- ③ receiptCache/K5 链：`GET /audit/receipt` 观测 `receipts[0].ok=false`（record 消费 fold.ok）✓。
- ④ toExecutedResult 复用钉：折叠回执⇒`ok:false`+摘要「执行未成功：…K6 核验未过…残留证据…」+
  error 原因透传；未折叠⇒成功摘要逐字不变 ✓（函数零改动）。
- ⑤ 变异自证：`===false`→`!==true` 内存副本 ⇒ `{}`/`"false"`/`0` 转红 ✓；`==false` 宽松变异 ⇒
  `0`/`''` 转红 ✓（双变异互补：`'false'==false` 为假的 JS 事实由前者捕获）；均带真实现反向对照。
  静态面：旧 `record(…res.ok…)` / `isError: !res.ok` 回潮反证钉 ✓；adapter 旧恒真字面量回潮反证钉 ✓。

## 6. 现场与规格不符处登记（如实）

1. **规格 C0-1「error 块复用 makeError」现场取直写对象字面量**：structuredContent.error 的既有
   同构形态（POLICY_DENIED 返回点）即 `{code,message(,+retryable)}` 字面量/verdict.error 透传，
   未走 `makeError()`（该函数在 contracts，server.ts 已 import makeError 但既有失败返回点
   均未使用——对齐现场同构，不引入新写法）。retryable:false 显式写出（与 DEFAULT_RETRYABLE 一致）。
2. **规格「summary 若服务层有组装位 ⇒ 折叠态改文案」**：executeCapability 的 structuredContent
   现场**无 summary 键组装位**（回执 summary 由 `toExecutedResult` 在映射层产）——不硬造键，
   链上面 summary 在 2c 条目内已诚实。
3. **`residualEvidenceSummary` server 侧未二次调用**：errorMessage 在 k6-verdict 内组装即含
   证据段（第 1 小步实现形态），server 只消费 `fold.errorMessage`——与规格「拼进 message」
   等价、单源防双拼。
4. **adapter 信封不折（`foldK6Verdict(true,data)` 的 envelopeOk 恒传 true 仅取 k6Failed 语义）**：
   provider 达 adapter 时「送达」已由未抛异常坐实；把 data.success=false 折进 provider 返回
   信封会改变 hermes/t5/委派内层等**信封消费面**行为（超规格）——链条目面折叠达成 C0 定性
   要求的「审计摘要诚实」，呈报信封面折叠归服务层（2b）。两面对同一 data 独立判、无叠加。
5. **C0-2 原判定「流经⇒无需改」被 2c 裁定推翻**：主理人复核后认定 index.ts:542 恰是链条目
   病灶本体（例外），已按 2c 处置。

## 7. 残留

- **真机复验（归主理人窗）**：K6 失败样本（NSIS 假成功型）经 MCP 直调/委派 replay 两路径应呈
  `ok:false`+`EXECUTION_FAILED`+`reason=K6_VERIFY_FAILED`+残留证据摘要；`/audit/receipt` 与
  链上条目同步诚实。V19 的 portable 残留观察（H3）在折叠后可观测。
- **部署节奏**：本批全部 Node 面改动随下次 deploy-vm + 服务重启现网生效（与 R1 同节奏）。
- **success=true 不代表安装**（upgrade/install 族 `success=($exit-eq-0)` 语义）：折叠只消费
  严格 false，positive 面语义不变——若未来要把 install 族 success 也升格 K6 核验，属 psmod
  侧契约变更与本批无关。
- 环形缓存重启即失（§10-4 既有信任局限）不因本批改变；链上条目现已携带成败（2c），
  「审计不存载荷」盲区由 2c 部分缓解（summary 带截断证据），全量载荷落链仍为登记 backlog。
