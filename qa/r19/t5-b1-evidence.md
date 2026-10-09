# B1 真机：LLM 常驻会话途中取消（provider=workbuddy，2026-10-09）

| 点位 | 证据 |
|---|---|
| 取消前会话 | `/health.llmSession = {state:"ready", pid:4536, restarts:0}` |
| 发起 | `message/send`（非阻塞）task `cde70b18` → `working`（"WinVM WorkBuddy LLM Agent 接管目标"= LLM 路径实锤） |
| 取消 | settle 12s 后 `tasks/cancel` → `canceled`；`CANCEL_FINAL canceled` |
| 取消后会话 | `/health.llmSession = {state:"stopped", restarts:0}` ⇒ **pid 消失=CLI 被 killChild 真杀；restarts=0 ⇒ 同轮重建闸（turnAbortedByCancel）守住，未重投** |
| 链上 | `audit-20261009-5.jsonl`：`delegation-complete` `ok:false` `errorCode:"TASK_CANCELED"` `durationMs:12362`，summary 含"常驻会话当前轮被取消打断…此后未再发起新的能力调用"（canceledResult 三纪律文案真机成立） |
| 判定 | **B1=PASS**（判据②：turn 边界/事件打断 + killChild + 零重跑） |

复现件：`qa/r19/t5-b1-cancel.out.json` + `t5-b1-chain.ps1`（VM 侧 Select-String 原始行法）。
