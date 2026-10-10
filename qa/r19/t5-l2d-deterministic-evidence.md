# L2-D · `executedBeforeCancel` 有态真机构造（确定性模板路径）+ 补强实证：生产呈现面两 provider 均不可达

> 日期：2026-10-10。当日早前两趟边界取证（`t5-l2-late-cancel-evidence.md`，commit `1faec49`）给出架构结论"有态只在 workbuddy-deterministic 模板路径可达"；本趟真机构造证实**派生逻辑本身有态可达**（A′ 路），同时**补强一个更深发现**：连确定性路径的**宿主生产呈现面**（`a2a.delegate` 的 progress 收集）也因 wire 消息形态缺口不可达。
> 执行：工程师（software-engineer，团队 software-winvm-phase2-d526）；主理人独立复验（源码级 + /health 实测）。
> 证据：`t5-l2d-deterministic-evidence.json`（汇总）+ `t5-l2d-attempt{1,2}.out.json`（现场原文）+ `t5-l2d.timeline.txt` + 探针脚本 `t5-l2d-probe.mjs`/`t5-l2d-switch.mjs`。

## 一、构造结果（两次复现成功）

| 项 | attempt-1（即时取消） | attempt-2（延迟 1.5s） |
|---|---|---|
| 任务 | `b01a1a05-a745-4c88-a9db-14d502f0dcc1` | `87b065fb-07ce-461d-b2ea-01510e0bf357` |
| 终态 | canceled | canceled |
| 现场 step 行 | `执行 storage.cleanup.analyze：分析磁盘占用与清理建议`（SSE `status-update(working)` 捕获） | 同左 |
| 终态 artifacts | 0 | 0 |
| 生产 delegate 回包 | progress=0、`executedBeforeCancel=null`、无态文案 | 同左 |
| A′ 现场喂生产 derive | `{steps:1, artifacts:0}` ⇒ 「取消前已有 1 个操作执行、0 个产物」 | 同左 |

**方法合规**：派生输入全部真机现场捕获（tasks/subscribe SSE 帧 + tasks/get 轮询 + 终态 artifacts），零手造；derive 函数为 VM 现网 `host-a2a-bridge/dist/tools.js` 运行时逐字截取（1292 字符，`STEPS_CARRIER_NAME`..`createA2aBridgeTools` 段）经 `new Function` 装载，非重写。

## 二、补强实证（本趟核心新发现）：sink→wire 类型级谎报

同一次任务上，生产 `a2a.delegate` 实测 progress 恒空。根因经主理人源码级核验坐实，是一条**类型契约谎报**，而非措辞差异：

1. **契约声明 string**：`ProgressSink.onStatus(state, message?: string)`（`packages/contracts/src/bridge.ts:381`）。
2. **生产者传 string**：确定性模板 `sink.onStatus('working', '执行 <cap>：<summary>')`（`packages/adapter-agent-workbuddy/src/index.ts:418`，即 `DETERMINISTIC_STEP_MARK` 的模板来源）。
3. **中转 as-cast 上 wire**：`createProgressSink` 把该 string **直接 cast** 成 `A2A.Message` 存入 `status.message`（`packages/a2a-framework/src/task-store.ts:630-631`）——wire 上 `status.message` 成为裸字符串（真机探针 `msgType=string` 实证）。
4. **消费端只认 Message**：宿主 `extractText(message?: A2A.Message)` 首行 `if (!message?.parts) return ''`（`packages/host-a2a-bridge/src/tools.ts:45-46`），对裸字符串恒返回空串 ⇒ delegate 的 `progress.push` 永不发生（`:450-451`）⇒ `deriveExecutedBeforeCancel` 输入 progress=0。

**推论（修正既有结论的适用范围）**：
- 有态取消文案的**生产可达性 = 两种 provider 均为零**（LLM 路径另有 steps 恒空的防降级红线；确定性路径栽在 sink as-cast）——"只在确定性路径可达"须精确化为"**只在派生函数层面可达，生产呈现面两路径均不可达**"。
- 病灶可修（sink 内构造合规 `A2A.Message{parts:[{kind:'text',text}]}`，纯框架侧一处），且**不止影响取消呈现**：delegate 的实时进度回显（working 消息）对确定性路径同样恒空。对照面：框架自有的 `approvalTimeoutMessage`（task-store.ts:439）就正确构造 Message——证明 as-cast 处是疏漏而非设计。
- **审批链路不受影响**（input-required 走 waitApproval/正确 Message 形状 + `extractApproval` 独立通路），本趟实证范围仅 progress/取消文案。

**路由**：列入 Phase 2 改动集，建议并入 **P2-T7（TaskStore 驱逐可观测化，同文件 task-store.ts 单写者）** 或独立小任务，待用户裁。

## 三、复原复验（主理人独立 /health 实测，隧道 127.0.0.1:18443）

`{"provider":{"id":"workbuddy","state":"ready"},"authMode":"bearer-configured-missing","tasks":{"live":0},"exposed":54,"approvalTruth":{"mode":"on"}}` — 三值指纹与现网态一致；`llmSession=stopped`（idleMs≈13min）为自然空闲回收，非配置差异。runtime 配置 `cp -p` 字节级还原（`.orig` 2867B 保留于 VM scratch）；零 git 写、零源码改动、模板2 只读无残留。
