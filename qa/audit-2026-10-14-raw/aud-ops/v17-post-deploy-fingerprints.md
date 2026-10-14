# V17 部署后行为指纹（2026-10-14 20:3x，批8 部署收口= N-1 闭合证据）

## 部署
- `deploy-vm.mjs --apply` EXIT=0（v17-deploy-b1.log）：BUILD→VM scp/install→VM-START(监听18443)→QA-PROBE 全绿，42s。

## 指纹1 /health.policyGate（新块在册=新码在场）
三次读取同值：
`{"wiring":"shadow","shadowHits":0,"delegationRequiredPolicy":true,"scopeEntries":0}`
（部署前同端点 keys 无 policyGate=旧码，三源见 N-1）

## 指纹2 纯直调 L2 ⇒ (c) 收口
`[直调] code=DELEGATION_REQUIRED retryable=false hasApprovalId=false traceId=tr_mv83a1hs_1`

## 指纹3 ?dtid 内层 ⇒ 不误伤
`[内层] code=APPROVAL_REQUIRED hasApprovalId=true`（链上 seq=4 channel=a2a matchedRule=approval-required）

## 链上入审计（S-4/A2-1 纪律真机实证，seq=3 原始行）
```
{"ts":"2026-10-14T12:31:39.292Z","traceId":"tr_mv83a1hs_1","channel":"mcp",
 "capabilityId":"storage.file.delete","risk":"L2",
 "policyDecision":{"allowed":false,"matchedRule":"policy:delegation-required"},
 "approval":{"approvalId":"policy-denied","approvedBy":"policy-engine","previewHash":""},
 "result":{"ok":false,"errorCode":"DELEGATION_REQUIRED","summary":"blocked:policy-denied（策略硬拒绝，未执行）"},
 "seq":3,"prevHash":"4a4328431f7e…","hash":"5ebabb33d4f3…"}
```
链 5 条 chainValid=true（audit-20261014-5.jsonl，fresh session 分片）。

## 附注
- 直调 `storage.space.analyze` 对照=INVALID_PARAMS（参数面拦截，与 (c) 无涉）。
- PS5.1 `ConvertFrom-Json` 读含中文 UTF-8 行报 GBK 解码错（已知载荷编码坑的镜像形态），
  错误输出本身完整回显原始 JSON ⇒ 证据取得不受影响。

---

# 真机观察件收尾裁定（批1 后现网实况，主理人亲验 20:3x）

## V15（A2-17 批准→换参续跑拒）**端到端=设计不可达**，裁"离线已闭、真机无面"
- 换参拒绑发生在 **人工续跑路径**（`/mcp` 带 `__approvalId` 重发→ARCH-09 比对 storedHash vs 重算）。
- 缺省灰度 `WINVM_APPROVAL_REPLAY=on`（现网 providerApprovalTruth.mode=on 实证）下，批准即服务端重放+**一次性删 token**（server.ts "无论成功失败都无条件删除"）⇒ 人工续跑路径**拿不到已批准 token**=批1 发现本身（`__approvalId` 事实死字段）。
- 推论：V15 端到端在缺省态**无触发形态**；仅 `replay=off` 回滚态可达（届时 token 保留）。
- 行为证据已在离线：`phase3-b6-preview-hash-binding` 11 例 + `p3-b1-policy-gate`（重放用 token 留存值复评）钉死比对逻辑与拒绑语义。
- **裁定：V15 销账**——非"未测"而是"缺省设计路径上不可达"，真机强测须改回放态=偏离缺省实况，不划算；回滚态专项如未来需要另开。

## V14（wsProbe 长跑采样）**无显形面**，登记为观测增强需求（非缺陷）
- `working_set_probe` 仅内存判据（persistent-session.ts:983 工作集超限→释放重建），**/health 与日志均无采样读数透出**（health.llmSession 无 workingSet 键，现网实证）。
- "长跑采样显形"=需要观测点，但**当前没有可采样的观测点**⇒ V14 的"观察"在缺省不可执行，非 VM 场景问题。
- 若需真机显形⇒批10 补 `llmSession.wsLatest`/峰值采样入 health（观测面补建），再谈长跑。当前 **V14 裁为"待观测面"**。

## V3/V4（真卸载→树杀）**破坏性，待用户显式点头**
- `app.winget.uninstall` / 计划任务删除属**不可逆**，且批2 已证部署幂等（V5 实跑）。卸载→重部署窗=一次完整往返（42s 部署可复现，但 VM 状态扰动较大）。
- 树杀逻辑（Q5 winget /T、ps-bridge spawn-error 折叠）已在**离线单测钉死**（psbridge-spawn-error 2 例、uninstall 真卸载在批2 窗有证据）。
- **裁定：V3/V4 不主动执行**——离线证据充分+破坏性+现网刚部署稳定态，扰动它需用户批准；登记"用户点头即可 42s 重部署复现"。
