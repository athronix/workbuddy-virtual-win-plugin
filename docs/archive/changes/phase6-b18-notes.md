# Phase 6 · 批18 施工记录（7 项裁决执行）

> 输入：`docs/changes/phase6-b17-decisions.md`（7 项全按建议处置）
> 执行：2026-10-17（主理人亲验，未派棒）
> 结论：**D-6/D-7/D-5/D-2/D-1/D-3/D-4 全部闭合**；N-6 定性完成（设计行为非缺陷）。

---

## 一、D-6 委派呈报失真（P2·实弹）—— 修法 A+C

### 1.1 根因（施工中补全的证据链，超出原 VERDICT 的定位精度）

原 VERDICT 定位到 `shouldDegrade()` 命中降级分支即止。施工期取到**服务端委派账本的
`underlying` 字段**（此前取证脚本把它 stringify 成 `System.Object[]` 漏掉了），得到更精确的事实：

```json
{"capabilityId":"app.winget.uninstall","ok":false,"count":2,
 "approvalId":"apr_4e8eea44b71b4c648e4f","auditSeqs":[19,20]}
```

即服务端**完整知道**这次委派真实执行过（blocked seq=19 + 重放 seq=20）。同时全景文档
补记的 seq=6（09:09 C0 真机复验那轮）走的是一模一样的路径 ⇒ **该缺陷自 C0 复验起即稳定
复现，不是偶发**；原 C0 记录里"被 VM 重启后 LLM 瞬态降级干扰未直达"的登记**不准确**，
已在批16 VERDICT §五与本记录中订正。

降级分支的问题因此是双重的：
- **行为面**：服务端已执行 ⇒ 降级到确定性模板兜底毫无意义（模板匹配不到），却把
  "已执行"改写成"未匹配到模板"；
- **归因面**：终态 `error` 取兜底的 `UNKNOWN_CAPABILITY`，LLM 侧真实收口码**只在瞬时
  `working` 状态文案里出现、终态被丢** ⇒ 本轮最初即因此被误导去查冷启动。

### 1.2 实现（`packages/adapter-agent-workbuddy-llm/src/index.ts`）

新增 `delegationActivityFor(goal)`：经 **既有** `DelegationTruthProbe.delegationActivity`
（与 K-N1 账本反查同一接口/同一账本/同一 traceId 键）反查三通道计数，**不新增契约面**。

降级分支改为三段：
1. **服务端有活动（`total>0`）⇒ 抑制降级**：不调确定性执行器；终态 summary 带服务端
   活动事实 + `traceId`（指向审计链）；`error` 保持 LLM 侧**真实码**（不被兜底码替换）；
   `steps` 全量改 `ok:false`（与 K5/K-N1 两条真值判据同构，失败终态不得保留完成声称）；
   并向 sink 回传 `D-6：…不降级为确定性执行器`（宿主可见）+ `logger.warn`（入 VM 日志）。
2. **服务端零活动 ⇒ 照常降级**（D4.4 语义逐字保留），但 summary **必须**追加
   `（LLM 侧收口：<code>[/<reason>]）`，且 `error.details.degradedFromCode/degradedFromReason`
   双通道透出真实码（兜底错误本体仍为 `error`，既有守卫/语义零变化）。
3. **fail-open**：probe 缺席或抛错 ⇒ `undefined` ⇒ 照常降级（取证失败绝不改变执行行为）。

### 1.3 回归

`tests/unit/p6-d6-degrade-suppress.test.js` —— 10 例全绿，覆盖：抑制/不调执行器/真实码保留/
reason 保留/步骤翻转/D-6 状态回传/零活动照常降级/truthTag 带 code+reason/details 双通道/
probe 缺席 fail-open/probe 抛错 fail-open/TIMEOUT 仍不降级。

---

## 二、D-7 matchedRule 字段漂移 —— 订正为规则名

- 病灶：`packages/adapter-agent-workbuddy/src/index.ts` 失败站点写
  `policyDecision: { allowed:false, matchedRule: error.code }` ⇒ 链上 seq=16 出现
  `matchedRule='EXECUTION_FAILED'`，把运行时失败污染成"策略规则名"。
- 依据：`task-evict-audit` 的同族语义（matchedRule=事实陈述、allowed=许可判定）与
  server.ts 既有 `runtime:<fact>` 命名（`runtime:provider-unavailable`，且有静态守卫钉着）。
- 改法：`matchedRule: 'runtime:execution-failed'`；错误语义由 `result.errorCode` **独立**
  承载（二者不互相顶替）。`allowed` 未动（超出裁决命名面）。
- 回归：`tests/unit/p6-d7-matchedrule-drift.test.js` —— 2 例全绿（规则名恒定 + errorCode 独立）。

---

## 三、D-5 就绪超时与预热预算对齐 —— 默认 60s → 180s

- 证据：`firstCallLatencyMs=49278`（深度空闲冷启动 49.3s）逼近 60s 阈值 ⇒ 概率性
  「60000ms 内未收到 system/init」误判 ⇒ 委派静默落单次 `-p` 降级路径。
  且 K2 注释自述 codebuddy 进程级冷启动 ≈**75–107s**，**本身已超过 60s** ⇒ 默认值与
  文档化的冷启动成本自相矛盾。
- 改法：`packages/core/src/constants.ts` `LLM_SESSION_READY_MS_DEFAULT` 60_000 → **180_000**，
  与 `LLM_SESSION_WARMUP_MS_DEFAULT` 对齐（预热预算与真实轮次预算描述同一个冷启动过程，
  不一致等于让预热白做）。env `WINVM_LLM_SESSION_READY_MS` 覆盖仍生效。
- 回归：`tests/unit/p6-d5-ready-timeout-align.test.js` —— 5 例全绿（对齐不变式 /
  大于 107s 实测上界 / 小于 600s 委派预算 / 出厂默认 / env 覆盖）。
- ⚠ **施工期订正**：D-5 严重度在批17 裁决单中已下调（轮3 起始 `llmSession=ready` 仍失败
  ⇒ 冷启动**非**委派失败主因，主因是 D-6）；本项是"顺带修正不一致的默认值"，不是主修。

---

## 四、D-2 K3 启发式 —— 保留 + **backlog 条目本身不成立**

- 裁决 A（保留）执行：`reconcileApprovalWait` 函数体与文案**一字未改**（SK-9 约束对象
  是判定逻辑与回包文案），仍是结构化判据退场时的 fail-safe 兜底。
- **配套"补直接单测"经核验不成立**：`tests/unit/phase2-approval-wait-fallback.test.js`
  （P2-T10 K3-C4）就是直接单测，16 个 test 声明 / **24 例全绿**（含与
  `reconcileApprovalTruth` 的门序交互 D3a/D3b/D4）。故**不写重复测试**，backlog 销账。
  这是本轮第二个"backlog 说没做、其实早做了"的条目（第一个是 D-1 的 schema）。

---

## 五、D-1 schema 条目销账

全景 N-4 原文指控两项经回仓核验均不成立：
- `domain.enum`（`capability.schema.json` L29）与 `id.pattern`（L26）**均已含** `appops`；
- 「无运行期校验器消费」实为**既有裁决**：`tests/unit/phase2-contract-schema.test.js:237`
  有反向守卫「vm-capabilities / vm-service 源码不 import schema-check（校验只活在测试/门禁面）」
  ⇒ Phase 3 批6 已实际销账。N-4 属陈旧复宣。
已在全景 N-4 行内订正并划账。

---

## 六、D-3 / D-4 文档口径固化

`docs/02-design/SECURITY-GOVERNANCE.md` 新增两节：
- **§4.6 链存归因、不存全量载荷**：落链边界表（params 原样 / result 三元 / artifacts 仅
  sha256）+ 三条理由（不可篡改=不可删除，与保留期策略冲突；敏感面放大；体积与可审性）+
  「未来若要全量落链，必须先解决链上删除这一前提，否则不予受理」。
- **§4.7 deterministic 不实现审批挂起**：定位（基准/测试执行器）、fail-safe 方向
  （拒绝而非放行）、审批挂起 E2E 已由 LLM provider 覆盖、代价如实登记
  （deterministic 永远无法单独覆盖审批挂起回归）。

---

## 七、N-6 定性完成（非缺陷）

`delegation-truth.ts` 判据 3 的 `rest.length>0` 分支：服务端有**多个**可归因到本委派的
未决审批时，**取最旧一条**改判，其余经 `warn` + `error.details.others` 透出，提示宿主逐条
处理 ⇒ **设计行为，安全**。残留观察（不修，登记）：宿主若只批最旧一条，其余未决审批按
TTL 收口；该语义随 K4/K5 TTL 一并观察。

---

## 八、变更清单

| 文件 | 变更 |
|---|---|
| `packages/adapter-agent-workbuddy-llm/src/index.ts` | D-6：降级抑制 + 真实码透传 + `delegationActivityFor` |
| `packages/adapter-agent-workbuddy/src/index.ts` | D-7：失败站点 matchedRule 订正 |
| `packages/core/src/constants.ts` | D-5：ready 超时默认 60s→180s（与预热对齐） |
| `tests/unit/p6-d6-degrade-suppress.test.js` | 新增（10 例） |
| `tests/unit/p6-d7-matchedrule-drift.test.js` | 新增（2 例） |
| `tests/unit/p6-d5-ready-timeout-align.test.js` | 新增（5 例） |
| `docs/02-design/SECURITY-GOVERNANCE.md` | 新增 §4.6 / §4.7 |
| `docs/audit/2026-10-16-panorama-phase6.md` | N-4 订正销账 |

**未改任何 `psmod/*.ps1`** ⇒ 无需重启 ps-bridge；D-5/D-6/D-7 均需 `deploy-vm --apply`
+ `kill-restart.ps1` 才在现网生效（顺序铁律：先部署→后打补丁→再 kill-restart）。

---

## 九、门禁与真机复验（2026-10-17 09:0x–09:1x）

### 9.1 全量 gate：**GREEN · 124 文件 / 2179 例 / 0 fail / 2 skip**

`qa/p3-batch-sweep/gate-p6-b18-final.txt`（DISK=RUN=MATCH）。
基线演进：121/2162（C0 收官）→ **124/2179**（+3 文件 = p6-d6 10 例 / p6-d7 2 例 / p6-d5 5 例，合计 +17 例，与 2162+17=2179 逐位吻合）。

**中间态 RED 1 件（如实登记）**：首跑 `cl018-config.test.js` 失败 —— `llmSession` 验收基线
硬编码 `readyTimeoutMs: 60_000`，正是 D-5 裁决**有意变更**的值。处置=更新基线为 180_000
并加注释引 D-5 与回归钉（**非削弱守卫**：该测试断言的是"出厂默认 = 验收基线"，基线由裁决改变）。
复跑转绿。2 skip 恒 ssh2-resolve OFFLINE_SKIP（既有权威口径）。

### 9.2 部署

`deploy-vm.mjs --apply` **EXIT=0**（BUILD → scp/install → VM-START 重启 → QA-PROBE → 端口轮询）。
已核实 VM 侧 `C:\WinVMBridge\delivery\.generated\vm-service.runtime.json` **不含** `llmSession` 段
⇒ 新默认 180s 自动生效，无需改配置。

### 9.3 D-5 真机复验：**首个正面样本**

部署后 `/health`：`llmSession={state:"ready", pid:8052, restarts:0}` —— 常驻会话
**首次即就绪、零重建**（此前每次深度空闲后必现 restarts 递增 + 60s 判死）。
随后 V20 委派全程 `restarts=0`，且 `firstCallLatencyMs=12858`（对比修复前 49278）。
（说明：该样本是"服务刚启动、暖身在 180s 预算内完成"的形态；深度空闲冷启动的复测待自然窗。）

### 9.4 D-6 真机复验：**V20 目标达成**

同一委派场景（`app.winget.uninstall id="Nonexistent.Test.Zzz"` → L2 挂起 `apr_3cc5e5ba42c243b0b392`
→ 批准 → 服务端确定性重放）：

| 面 | 修复前（`v20-trace3.txt` / 链 seq=21） | 修复后（`v20-trace4.txt` / 链 seq=6） |
|---|---|---|
| 任务终态 | failed，呈报「已降级为确定性执行，但**执行器未匹配到模板**」 | failed，呈报「**服务端执行回执失败**：…执行器自报未成功（K6 核验未过）；服务端已记录本委派活动（executed=0/blocked=1/wild=1），**未降级为确定性执行器**（真实执行/拦截已发生，详见审计链 traceId=…）」 |
| `data.steps` | `stepCount=0` / `steps=[]` | **`stepCount=1`**，step 携带诚实失败文案 |
| 链上 `delegation.complete` 错误码 | `UNKNOWN_CAPABILITY`（兜底码顶替真实病因） | **`REPLAY_FAILED`** |
| `underlying`（服务端账本） | 同（本就有，只是没被任务层消费） | 同，且**已被任务层消费** |

⇒ **V20（委派完成步携带折叠回执）在 D-6 修复后正式达成**；同时"已卸载却报未匹配"的
destructive 静默窗口被消除。证据：`qa/p5-batch/b16/{v20-trace4.txt,v20-final4.json,v20-suspend4.json,chain-after-d6-fix.txt}`。

### 9.5 D-7 真机复验：**通过**

经 MCP 直调两个失败场景后取链：
- `app.winget.search`（INVALID_PARAMS）⇒ `matchedRule=runtime:execution-failed`
- `system.registry.read`（EXECUTION_FAILED / REG_PATH_NOT_FOUND）⇒ `matchedRule=runtime:execution-failed`

即原 seq=16 的 `matchedRule='EXECUTION_FAILED'` 漂移已消除，错误语义由 `result.errorCode` 独立承载。

### 9.6 顺带观测

- 本轮 `policyGate` 保持 `wiring=on` / `shadowHits=0` / `delegationRequiredPolicy=true`；
  `directWithActiveTurn` 由 0→1（新 epoch 内首次命中，与批10 N-9 观测同族）。
- 链上 seq=2 `ARCHIVE_CHAIN_BROKEN`（1 片断裂，30/99）为**启动期既有归档校验事实**
  （T13 候选在册，断片非篡改），与本批无关。
- `llmSession.wsEvictions=0`，`psBridge` 正常。
