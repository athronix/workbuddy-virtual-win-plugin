# P2-T12 设计定稿 — `createProgressSink.onStatus` 合规 Message 构造（L2-D 补强）

时间：2026-10-11（step2）。作者：software-engineer（Alex）。缺陷定案出处：设计 §3.4 L2-D 追加、
`qa/r19/t5-l2d-deterministic-evidence.md`（真机实证，勿重新论证）。

## 1. 侦查实况（源码级，行号以 HEAD=f027930 为准）

| 面 | 实况 |
|---|---|
| 契约声明 | `packages/contracts/src/bridge.ts:444` `onStatus(state: TaskState, message?: string): void` —— **只声明 string**，非联合类型 |
| 病灶 | `packages/a2a-framework/src/task-store.ts:783-785`：`onStatus(state, message) { store.updateStatus(taskId, state as A2A.TaskState, message as A2A.Message \| undefined); }` —— **裸 as-cast**，wire 上 `status.message` 成裸字符串 |
| 正确样板 | 同文件 `approvalMessage`(:457) / `approvalTimeoutMessage`(:515)：`{kind:'message', role:'agent', messageId: randomUUID(), taskId: id, parts:[...]}`；server.ts 的 `resultMessage`/`errorMessage`(:667) 同形态 |
| Message 类型 | `packages/contracts/src/a2a.ts:46-54`：`kind:'message'`、`role:'user'\|'agent'`、`messageId`（**必填**）、`parts`（必填）、`taskId?` 等可选 |
| 消费端 | `packages/host-a2a-bridge/src/tools.ts:45-46` `extractText` 首行 `if (!message?.parts) return ''` ⇒ 裸 string 恒空。**宿主侧判据是对的，零触碰** |
| 生产透传链 | `a2a-framework/src/server.ts:348-353`：handler 收到包装 sink，`onStatus` 滤掉 completed/failed 后 **verbatim 透传** `sink.onStatus(state, message)` ⇒ 本修复自动覆盖 message/send、message/stream、tasks/subscribe 全部入口 |

### 调用方清单（全仓 grep `onStatus` 的实参形态）
- `adapter-agent-workbuddy/src/index.ts:492`（确定性模板 step()）：**string**
- `adapter-agent-workbuddy-llm/src/index.ts:442,447,482`：string；`bridge.ts:984,986,1028,1208,1224,1375,1571,1698,1706`：string；`persistent-session.ts:813`：string
- `adapter-agent-hermes/src/index.ts:178,182`：string
- 测试：`protocols.test.js:23`、`phase1-t5-cancel-consume.test.js:294/296/355`、`hermes-provider.test.js:63`、`llm-provider.test.js:81`：全 string；`phase1-t3-cancel-bounded.test.js:236/319/357/630/661`：`onStatus('working')` **无 message**
- **结论：全仓零个 Message 对象传入方**。但契约参数名 `message?: string` 的"message"语义 + 修复前运行时形态本就是"任意值直存" ⇒ 保留对象透传分支 = **零行为变化 + 对第三方 provider 宽容**（它们可能已按 as-cast 的暗示直传 Message）。

### 旧断言侦查（"钉 progress 为裸 string"）
全仓 `grep` 无任何测试断言 `status.message`（working 态）等于裸字符串。最接近的：
- `hermes-provider.test.js:81` / `llm-provider.test.js:104`：手写 mock sink `statuses.push(m)`（不经 `createProgressSink`，不受影响）；
- `k5-replay.test.js:555` / `r19c-a5:722` / `phase2-mcp-signal:829`：同上，手写 sink；
- `protocols.test.js:23` 经真实 sink 发出 `'开始执行'`，但该文件只断言 state 流转与审批 parts，不读 working 文案。
⇒ **零改钉**。

### 源码文本守卫（task-store.ts 是守卫输入面，逐条核对新增不触碰）
| 守卫 | 判据 | 新增代码是否触碰 |
|---|---|---|
| `r19c-a5` C3 + `evict-observe` | `cancelRequested` 恰 4 行（声明/初始化/赋值/读取） | 否（新注释/代码不复述该词） |
| `evict-observe` | 无 AuditSink/HashChainAudit/AuditRecord/appendAudit/@winvm/core/audit 符号；不引 "snapshot" 字样；onEviction 回调形态正则 | 否 |
| `evict-observe` | O-11 切片 `create() → 审批闸` 内 delete/clear 恰 4 处 | 否（切片上界在 :390，改动在文件尾 :781+） |
| `r19c-kn1-e-shape/mutation` | 全 framework src：无审计**写入侧**符号、无 adapter import | 否 |
| `phase2-snapshot-truth` | 全仓 src snapshot 命中白名单（task-store.ts 不在名单 ⇒ 不得引 snapshot） | 否 |
| `bearer-selfcheck` / `inner-credential` | 凭据符号/白名单（task-store.ts 不在名单 ⇒ 不得引 token/credential 等） | 否（注释刻意避开这些词） |

## 2. 修复设计

```
sink.onStatus(state, message?) 的新语义（仅 createProgressSink 内，TaskStore.updateStatus 签名不动）：
  · message === undefined            ⇒ 原样透传 undefined（缺席语义不变：status 不写 message 键，
                                       既有 emit/投影逐字节旧行为 —— t3-cancel-bounded 的裸 onStatus('working') 依赖此）
  · typeof message === 'string'      ⇒ 构造合规 Message：
        { kind:'message', role:'agent', messageId: randomUUID(), taskId, parts:[{kind:'text', text}] }
       —— 对照 approvalTimeoutMessage 形态：role=agent（进度文案是 Agent 侧叙述）、带 taskId
         （resultMessage/errorMessage/approvalMessage 三样板一致携带）、单 text part（宿主
         extractText 唯一消费面，approval 的 data part 不由本路径产生）
  · string 为空串/仅空白               ⇒ **不包装**，透传 undefined。理由：修复前空串 as-cast 后
                                       宿主 extractText 恒返 '' ⇒ `if (text)` 不 push（tools.ts:450）；
                                       包装后空串会经 `texts.join('').trim()` 仍为 '' ⇒ 同样不 push。
                                       两可观测面（progress[]、SSE 事件）逐字不变。透传 undefined
                                       则连 wire 键都省掉 —— 三者宿主端不可分，取最保守形态。
  · 其余对象形态（第三方直传 Message）  ⇒ verbatim 透传（零重复包装，幂等）
```

红线：不触碰 server.ts 终态收口路径（`updateStatus(id, finalState, resultMessage(...))` 直传 store，
不经 sink）⇒ completed/failed 文案形状不变，无 wire 风险。

## 3. 测试设计（`tests/unit/phase2-progress-message.test.js`）

A. 单元：`new TaskStore()` + `createProgressSink`（生产装配）
   1. `sink.onStatus('working','文本')` ⇒ `store.get().task.status.message` 逐键：kind/role/messageId(UUID 形)/taskId/parts.length=1/parts[0].kind/text；`typeof` 非 string。
   2. SSE `status-update` emit 携带同一 Message 对象（宿主消费的是这条）。
   3. 同 id 两次 onStatus ⇒ messageId 不同（非复用常量）。
   4. `sink.onStatus('working')` ⇒ status.message 键整体缺席（非显式 undefined、非空 Message）。
   5. `sink.onStatus('working','')` ⇒ 同上缺席（空白裁断的可执行登记）。
   6. 对象透传：合法 Message verbatim；`{}` 亦透传不伪造包装。
   7. as-cast 回归钉：修复前 wire 是裸 string（`updateStatus('working','旧世界')` 直存）⇒ 经宿主 extractText 恒空（复现病灶，证明测试穿过 as-cast 层）；新路径非空。

B. 生产通道端到端：`A2AServer({tasks: store, handler=确定性模板同款文案})` + `message/stream` SSE 喂
   `createA2aBridgeTools` mock clientProvider 的 delegate ⇒
   - `structuredContent.progress[]` 含 working 文案（修复前恒空 —— RED 基线捕获）；
   - completed 终态文案仍取 `resultMessage`（旧 wire 形状不变旁证）。
C. 有态取消经生产通道：流中 canceled final ⇒ `executedBeforeCancel={steps:2,artifacts:0}`（DETERMINISTIC_STEP_MARK 正则命中 `执行 <capabilityId>：` 两条）⇒ 摘要"有执行痕迹"文案。
D. `a2a.task.get`：progress 末条文本透出（tools.ts:582）非空。
E. derive 语义级联：carrier artifact 优先（steps=5 覆盖 progress 计数=1）⇒ 两路可分。

## 4. 验证序列
1. 改前 RED 基线：新测试跑**现网 dist**（病灶未修），记录 fail 明细 → `wbtmp/p2t12-red-baseline.txt`。
2. 编辑 src + `tsc -b tsconfig.build.json` → 新测试 GREEN。
3. 必跑守卫清单 + 宿主 progress 面（host-a2a-bridge / protocols / k4-p3 / k5-replay）。
4. 全仓 sweep（p2t12-runner ← p2t7-runner 复制）→ `wbtmp/p2t12-sweep-result.txt`，基线 88/1739 对账。
5. 文档订正（HOST-A2A-BRIDGE.md 划线诚实化 + 设计文档 §3.4 追加注记，原文不删）。
