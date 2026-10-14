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
