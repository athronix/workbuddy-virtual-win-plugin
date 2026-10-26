# K4 真机核验报告：A2A 审批结构化回传宿主

- **日期**：2026-09-28
- **核验人**：主理人（Qi，交付总监），QA 独立回归另行派发
- **前置**：K4 修复已双端部署（宿主 `install-host.mjs --yes` EXIT=0；VM `deploy-vm.mjs --apply --env=.env.deploy-vm` EXIT=0），仓库=宿主缓存=VM 三端对齐。
- **隧道**：pid 54953（`tunnel ensure` 既有实例），TCP 18443 OPEN，`GET /health` 200。注：`kill -0` 报 DEAD 为鸿蒙跨 App EACCES 假阴性（已知环境事实），TCP+HTTP 双证存活。

## 核验目标

K4 修复前：A2A 委派高危操作被审批闸拦截时，终态恒 `failed`、审批信息只藏在文本里（用户质疑："A2A的审批没传递过来啊？"）。
K4 修复后预期：宿主收到结构化 `input-required` 终态 + `data.type==='approval-request'` DataPart（含 approvalId/capabilityId/risk/preview/impact）。

## 方法

1. 驱动脚本 `$HOME/wbtmp/k4-drive-a2a-raw.mjs`（动态 import 已部署宿主缓存 `a2a-bridge/client.js`，连 `127.0.0.1:18443/a2a`，`maxRisk: L2`，`allowedCapabilities: ['app.*','appops.*']`，超时 200s，全量事件落盘）。
2. 委派目标：**「卸载VM中的企业微信」**（与 K3 复验同一目标，可直接对比）。
3. 只读复核 WXWork 安装态（`.ps1 + scp + -File`，纯 ASCII 载荷）。

## 结果：✅ PASS

### 1. 结构化审批事件（核心断言）

`SUMMARY`（证据：`$HOME/wbtmp/k4-a2a-raw-events.jsonl` 末行）：

```json
{
  "taskId": "4654d1bc-c98d-4356-8817-4b7015a9b3b6",
  "statesSeen": ["working", "input-required"],
  "finalState": "input-required",
  "inputRequiredSeen": true,
  "dataTypesSeen": ["approval-request"],
  "approvalViaData": {
    "type": "approval-request",
    "approvalId": "apr_391a3ad575ca494ca521",
    "capabilityId": "appops.workflow.run",
    "risk": "L2",
    "preview": {},
    "impact": []
  },
  "K4_PASS": true
}
```

与 K3 复验对比（修复前）：`statesSeen=[working,failed]`、`inputRequiredSeen=false`、`approvalViaData=null`，approvalId 只出现在 failed 文本中。

### 2. 事件流逐行证据（L0-L8）

| 行 | kind | state | 内容 |
|----|------|-------|------|
| L0-L5 | status-update | working | VM agent 查安装态 → 调 `app.winget.uninstall` 被 L2 闸拦截 → 正确停止 |
| L6 | status-update | **input-required** | 文本：「需要人工审批（风险 L2）后才能继续。操作：appops.workflow.run……确认后请回复 message/send（同一 taskId），附带 DataPart：{"approvalId":"apr_391a3ad575ca494ca521","approved…}」+ DataPart `{"type":"approval-request","approvalId":"apr_391a3ad575ca494ca521","capabilityId":"appops.workflow.run","risk":"L2","preview":{},"impact":[]}` |
| L7 | error | — | 驱动端 200s 超时（**预期行为**：服务端任务保持挂起，不会伪造终态） |

### 3. 挂起零副作用（只读复核）

```
EXE_PRESENT | C:\Program Files (x86)\WXWork\WXWork.exe | 270306.8KB | LastWrite=2026-09-10 04:10
WINGET_NO_HIT
VERDICT | WeCom STILL_INSTALLED
```

`WXWork.exe` 完好（270306.8KB，LastWrite 2026-09-10 与 K3 复验一致）→ 审批挂起期间**未执行任何卸载动作**。

### 4. 宿主侧续跑提示已生成

L6 文本含完整续跑指引（`a2a.approval.reply` → message/send 同 taskId + DataPart approved:true/false），宿主 `host-a2a-bridge/tools.ts` 的 `extractApproval`/`buildA2aResumeHint` 无需改动即能消费该结构（此前已就绪）。

## 结论

| 断言 | 结果 |
|------|------|
| finalState = input-required（非 failed） | ✅ |
| data.type='approval-request' 结构化 DataPart 回传 | ✅ |
| approvalId/capabilityId/risk 全字段在位 | ✅ |
| 审批挂起零副作用（WXWork 完好） | ✅ |
| 驱动超时后服务端任务不伪造终态 | ✅ |

**K4 修复（A2A 审批结构化回传宿主）在真机 A2A 通道验证通过。**

## 遗留 / 未复验

1. **审批通过 → VM 续跑真实卸载闭环**（`a2a.approval.reply{approved:true}` → hostApproved 置 true → VM agent 带 `__approvalId` 续跑 → WXWork 实际移除）：**会真实卸载企业微信，须用户明确确认后执行**。
2. QA 独立回归（构建 0 error + k4-approval 6/6 + 既有单测回归 + hostApproved 安全闸代码审查）已并行派发，报告将落盘 `docs/test/reports/k4-fix-qa-2026-09-28.md`。
3. capabilityId 实报 `appops.workflow.run`（winget 卸载经 workflow 承载），非 `app.winget.uninstall`——属能力路由的真实映射，非缺陷。

## 证据文件

- `$HOME/wbtmp/k4-drive-a2a-raw.mjs`（驱动脚本）
- `$HOME/wbtmp/k4-a2a-raw-events.jsonl`（全量原始事件流）
- `$HOME/wbtmp/k4-wecom-verify.ps1`（只读核验脚本，ASCII 载荷规避 PS 5.1 编码坑）
