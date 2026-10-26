# 批16 观察窗 · V20 终判（2026-10-17）

> 观察对象：**V20 = 委派完成步（`data.steps[]`）携带 K6 折叠回执的自然样本**
> 结论：**V20 目标面未命中，但采样过程暴露一个真实 P2 缺陷（N-5）** ⇒ V20 由「待自然样本」转「结构性不可达（依附 N-5）」，不再作为独立观察项挂账。
>
> **【2026-10-17 09:1x 更新 · 批18 D-6 修复后】** N-5 已修复并经真机复验，
> **V20 目标正式达成** —— 见本文 §六 与 `docs/archive/changes/phase6-b18-notes.md` §9.4。

---

## 一、三轮采样结果

| 轮 | 时间(UTC) | 起始 llmSession | 挂起 | 批准 | 终态 | 结果 |
|---|---|---|---|---|---|---|
| 轮1（暖身） | 16:31 | stopped / restarts 1 / idle 4.86h | — | — | completed | ✅ 但**降级为单次 `-p` 路径**（返回文本自证） |
| 轮2 | 16:33 | stopped→attempt4 就绪 | ✅ `apr_fa556138d46c40aca0d6` | ✅ working | **failed** | 链 seq=16：基础设施失败（ps-bridge 未心跳重启），诚实 |
| 轮3 | 16:36 | **ready / pid 6092 / restarts 3** | ✅ `apr_4e8eea44b71b4c648e4f` | ✅ working | **failed** | 链 seq=20：**K6 折叠回执在册**；任务层 steps=0 |

轮3 起始**常驻会话已是 `ready`**，排除「冷启动导致」这一归因（推翻本轮最初的假设）。

---

## 二、决定性证据：服务端真的执行了，任务层却说没匹配到模板

**链上条目**（`chain-replay-entries.txt`，源 `C:\Users\User\AppData\Local\WinVMBridge\audit\audit-20261016-2.jsonl`）：

```
IDX=19 seq=20 traceId=tr_mvb6vtsx_4-replay
  capabilityId = app.winget.uninstall
  policyDecision.matchedRule = allow:policy-passed
  result.ok = false
  result.errorCode = EXECUTION_FAILED
  result.summary = app.winget.uninstall 执行未成功：执行器自报未成功（K6 核验未过）
  durationMs = 18976
```

**同一时刻的任务层终态**（`v20-final3.json`）：

```
state = failed
text  = 已降级为确定性执行，但执行器未匹配到模板：确定性执行器未匹配到内置目标模板…
data  = { ok:false, stepCount:0, steps:[] }
```

**VM 侧日志**（`vm-log-excerpt.txt`，`winvm-service-2026-10-17.log`）时间线：

```
16:35:53 warn 批10 N-9 观测：纯直调命中审批闸且活动委派槽在场 … traceId=tr_mvb6vtsx_4
16:36:01 info [llm-session] 常驻会话轮次完成 durationMs=19280 ok=true
16:36:01 warn 同一委派存在多个未决审批（请宿主逐条处理）
16:36:12 info 审批放行，服务端确定性重放执行  traceId=tr_mvb6vtsx_4-replay
16:36:39      A2A 任务收口 failed
```

⇒ **服务端在 16:36:12 真实重放执行了该能力并写入折叠回执（seq=20），而任务层在 16:36:39 呈报"执行器未匹配到模板 / 零步骤"。两者对同一事实给出相反陈述。**

---

## 三、N-5（新登记 · P2 · 呈报失真）

- **现象**：委派经审批放行后，服务端确定性重放**真实执行**了能力（链上留下 `ok=false / EXECUTION_FAILED / K6 核验未过` 的诚实折叠回执），但 A2A 任务终态呈报为「已降级为确定性执行，但执行器未匹配到模板」且 `steps=[]`。
- **根因（定位到代码面）**：LLM provider `runGoal` 在审批挂起后收口为 `res.ok=false` 且 `artifacts` 为空 ⇒ 命中 `packages/adapter-agent-workbuddy-llm/src/index.ts` `shouldDegrade()`（`code==='EXECUTION_FAILED'` ∧ 零产物 ∧ `reason` 不在 `NON_DEGRADABLE_CODES` 闸类集内）⇒ 进 D4.4 降级分支，改由确定性执行器 `runGoal` 兜底 ⇒ 该兜底**既不复用服务端已完成的重放结果，也不知悉"已执行"事实**，因无匹配模板返回失败 ⇒ 最终 summary 由兜底文案生成，**彻底丢掉真实错误码**（真实码只出现在瞬时 `working` 状态文案里，不进终态）。
- **危害**：① 对 destructive 能力尤其危险——**真实卸载已发生，宿主却读到"没匹配到模板"**；② 委派完成步永远携带不到折叠回执（V20 结构性不可达，非偶发）；③ 排障被误导（本轮即被误导一次，先误判为冷启动问题）。
- **证据**：`chain-replay-entries.txt`(IDX=19/seq=20)、`v20-final3.json`、`v20-trace3.txt`、`vm-log-excerpt.txt`。
- **修法候选**（待裁）：
  - (a) 降级前先按 traceId 反查服务端是否已有该委派的执行回执，有则**不降级、直接复用**；
  - (b) 把「服务端已重放执行」提升为 `NON_DEGRADABLE` 信号（与 `NO_EXECUTION_RECEIPT` 豁免同位）；
  - (c) 最小诚实收口：终态 summary 必须带上真实 `res.error.code` 与「服务端已执行，见 traceId」提示，杜绝归因失实。
- **路由**：进 Phase 6 批18（缺陷修复批），与批17 决策族 D-6 同一裁决面。

---

## 四、V20 销账口径

V20 **不再单列**为观察项：其目标面的不可达已由 N-5 解释清楚，修 N-5 即等于 V20 成真。
附带收获（正向）：**链上 seq=20 是 C0 折叠在「委派批准→服务端确定性重放」这一真实通路上的第二次独立实证**（第一次为 C0 真机复验 seq=5），且本次 `matchedRule=allow:policy-passed`（放行后执行失败）与 C0 那次的放行语境互补 ⇒ **C0 折叠在生产通路已双样本闭合**。

---

## 五、附带观察（低优先级，登记不修）

1. **同委派多未决审批**：日志两轮均出现 `同一委派存在多个未决审批（请宿主逐条处理）`。单个工具调用却产生 >1 个未决审批，宿主若只批一条即收口 ⇒ 可能与 N-5 的零步骤收口同源。建议随 N-5 一并查。
2. **seq=16 的 `policyDecision.matchedRule` 被写成 `EXECUTION_FAILED`**（基础设施失败路径）：该字段语义应为策略规则名，失败路径填错误码属漂移；是否修待裁（D-7 候选）。
3. **ps-bridge 稳定性**：轮2 因 `ps-bridge 超过 45000ms 未心跳且探测失败…正在重启` 失败（诚实），随后自愈（健康面 `psBridge.uptimeMs` 回归小值）。与既有「ps-bridge 自愈」机制一致，非新缺陷。

---

*留痕：主理人亲验（三轮真机 A2A 委派 + VM 日志 + 审计链双向取证），未派审计棒。证据获取遵循「含中文证据一律 VM 侧 UTF8 字节级落文件 + scp 回传」纪律，未走 ssh stdout 重定向。*

---

## 六、批18 D-6 修复后复验（2026-10-17 09:1x）—— V20 达成

修复落地后重打同一委派场景（`app.winget.uninstall id="Nonexistent.Test.Zzz"` → L2 挂起
`apr_3cc5e5ba42c243b0b392` → 批准 → 服务端确定性重放），证据
`v20-trace4.txt` / `v20-final4.json` / `chain-after-d6-fix.txt`：

| 面 | 修复前 | 修复后 |
|---|---|---|
| 任务终态 | failed，呈报「已降级为确定性执行，但**执行器未匹配到模板**」 | failed，呈报「**服务端执行回执失败**：…执行器自报未成功（K6 核验未过）；服务端已记录本委派活动（executed=0/blocked=1/wild=1），**未降级为确定性执行器**（真实执行/拦截已发生，详见审计链 traceId=tr_f9b1253f-…）」 |
| `data.steps` | `stepCount=0` / `steps=[]` | **`stepCount=1`**，step 携带诚实失败文案 |
| 链上 `delegation.complete` | `err=UNKNOWN_CAPABILITY`（兜底码顶替真实病因） | **`err=REPLAY_FAILED`** |
| 服务端账本 `underlying` | 有记录但任务层不消费 | 有记录且**已被任务层消费** |

**结论**：N-5（委派呈报失真）已根治；V20 目标（委派完成步携带折叠回执）**正式达成**；
"已卸载却报未匹配"的 destructive 静默窗口消除。修复实现与判据见
`docs/archive/changes/phase6-b18-notes.md` §一，回归钉 `tests/unit/p6-d6-degrade-suppress.test.js`（10 例）。

**附带（D-5）**：同轮 `/health` 显示 `llmSession={state:"ready", restarts:0}`、
`firstCallLatencyMs=12858`（修复前 49278）—— 就绪超时与预热预算对齐后常驻会话零重建。
