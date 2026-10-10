# P2-T5 真机证据包 —— bearer 生效自检 / fail-closed / 回滚位 / 还原

窗口：2026-10-11T03:33+08:00 ～ 03:42+08:00（本批次唯一写入者，K-5）
VM：Win11 172.16.100.2（ssh 免密，服务 loopback 18443，宿主经 delivery/tunnel-daemon.mjs 隧道观测）
HEAD 基线：cbd5dfd；HEAD 未做任何 git 写操作（只读 diff）。

## 0. 探针脚本（本窗口新增，全部 ASCII payload / node 侧解析规避 PS5.1 中文乱码）

- `qa/r19/t5-selfcheck-probe.ps1` —— 审计目录 + 活跃分片尾部 + bearer-selfcheck 条目 grep
- `qa/r19/t5-enforce-patch.mjs` —— on / off / restore 三态补丁（order 铁律的 patch 步；restore 从 *.bak-p2t5 逐字节回拷）
- `qa/r19/t5-refuse-readback.mjs` —— 跨分片 bearer-selfcheck 条目结构化回读（拒启/回滚轮取证）
- `qa/r19/t5-refuse-readback.ps1` —— 监听数 / node 进程数 / 孤儿 ps-bridge 数 判活探针

## 1. 部署前基线（旧 build，隧道存活确认）

`t5-health-before-deploy.json`（probe_ts=2026-10-11T03:33:26+08:00，HTTP 200）

```json
"security": {"loopbackOnly":true,"boundLoopback":true,"authMode":"bearer-configured-missing"}
```

要点：旧 build 真机恒报**半开态** bearer-configured-missing（delivery 配置写了 tokenEnv 却没写
enforceBearer 的悬挂形态，判序③）。本批 config 自洽整改（删 tokenEnv + 显式 enforceBearer:false）
后转为干净 loopback-only。runtime.json 部署前 sha256=6602635C551FAA1C4C29B5A253874AC3383E877CAD7F8FC11636BCA545622DFE（旧形态）。

## 2. 部署后默认态（deploy-vm.mjs --apply，BUILD→VM→VM-START 一次完成）

`delivery/deploy-vm.mjs --apply` 全程成功（provider=workbuddy 选型由 .env 决定，未漂移）。
`t5-health-default-after-deploy.json`（probe_ts=2026-10-11T03:34:51+08:00，HTTP 200）：

```json
"security": {
  "loopbackOnly": true,
  "boundLoopback": true,
  "authMode": "loopback-only",
  "bearerSelfCheck": { "code": "not-mounted", "ok": true,
    "reason": "bearer 守卫未挂载（authMode≠bearer-enforced），跳过挂载求值" },
  "innerReconnect": { "status": "unverified",
    "reason": "authMode=loopback-only：守卫未挂载 ⇒ 回连通路无判定意义（只观测不改判，默认态恒不拒启）" }
}
```

install-vm 重生成的 runtime.json（sha256=f61dd89f9d558ef6…）security 块 =
`{requireLoopbackBind:true, enforceBearer:false, enforceBearerFailClosed:true}`（tokenEnv 键已删）。

链上取证（audit-20261010-2.jsonl，seq=1 GENESIS）：

```
rule=bearer-selfcheck:not-mounted ok=true refused=false inner=unverified
selfCheck=not-mounted authMode=loopback-only failClosed=true principal.channel=internal
cap=meta.audit.chain risk=L0  durationMs=8
```

（默认态也恒落一条证据，可 grep；与 zeroInnerCalls 恒落同纪律。）

## 3. enforce-on 拒启轮（fail-closed 真机实证）

补丁（patch 步，03:38:39+08:00）：runtime.security.enforceBearer=true + tokenEnv=WINVM_BEARER_TOKEN；
start-hidden.ps1 注入 `$env:WINVM_BEARER_TOKEN='p2t5-probe-token-9f3a'`（任务计划无 env 通道，
ps1 显式赋值是服务进程 env 的唯一来源——install-vm 文件头注释同口径）。

kill-restart（03:38:43+08:00）后：
- `owner_after_run=`（空）——服务没起来；
- 宿主隧道三连探测 HTTP=000/curl exit 52（拒连，非黑屏黑洞：ping 侧 0% 丢包）；
- VM 内判活探针（t5-refuse-readback.ps1）：`LISTEN_18443=0 NODE_PROCS=0 ORPHAN_PSBRIDGE=0`
  —— **零泄漏**：抛错路径把 sessionMonitor / ps-bridge / logger 全部收口（改动集 2c 的真机佐证）。

链上取证（audit-20261010-3.jsonl，seq=1 GENESIS，ts=2026-10-10T19:38:58.678Z UTC）：

```
rule=bearer-selfcheck:inner-reconnect-broken ok=false refused=true
inner=broken selfCheck=mounted-pass authMode=bearer-enforced failClosed=true
summary=…⇒ fail-closed 拒绝进入服务态；VM 内回连不带凭据 ⇒ 委派将退化为零副作用虚假完成（B3 实证形态）…
```

要点：**证据先落链再抛错**；挂载逻辑本身 pass（病不在守卫在回连）；matchedRule 单独成码可 grep。

## 4. enforce-on + 回滚位轮（enforceBearerFailClosed=false）

补丁 off（03:40:21+08:00）+ kill-restart 后，`t5-health-enforce-rollbackmode.json`
（probe_ts=03:40:47+08:00，HTTP 200）：

```json
"security": {
  "authMode": "bearer-enforced",
  "bearerSelfCheck": { "code": "mounted-pass", "ok": true },
  "innerReconnect": { "status": "broken", "reason": "…provider options.bearerEnvName 缺席 ⇒ buildMcpConfig 条目零凭据 ⇒ 回连必 401；回连凭据分发通路属 P2-T6（未实现）" }
}
```

链上取证（audit-20261010-4.jsonl，seq=1 GENESIS）：

```
rule=bearer-selfcheck:inner-reconnect-broken ok=false refused=false failClosed=false
summary=…⇒ 放行（enforceBearerFailClosed=false）…
```

要点：回滚位 = 放行 + 显式告警 + 链上 refused=false/failClosed=false 三处齐备，绝不静默。
「诚实的 broken 语义」在真机成立：回连通路未实现期，判据如实报 broken（innerReconnect.reason
直说 P2-T6 未实现），fail-closed 据 Q4 拒启、回滚位据 Q4 放行告警。

## 5. 还原证明（BYTE_IDENTICAL）

`node t5-enforce-patch.mjs restore`（从 *.bak-p2t5 逐字节回拷）后：

| 文件 | 备份前 ORIGINAL sha256 | 还原后 sha256 | 判定 |
|---|---|---|---|
| vm-service.runtime.json | f61dd89f9d558ef6b82dbeee35348eb5e21691c7e507db52cf103046c0b36d4e | f61dd89f9d558ef6b82dbeee35348eb5e21691c7e507db52cf103046c0b36d4e | BYTE_IDENTICAL |
| start-hidden.ps1 | 801038bc95a21b6eb49596ebdab3e1ca43b30f3996247689f30359215ba55179 | 801038bc95a21b6eb49596ebdab3e1ca43b30f3996247689f30359215ba55179 | BYTE_IDENTICAL |

还原后再 kill-restart（03:41:4x），最终态 `t5-health-restored-default.json`：
authMode=loopback-only、bearerSelfCheck=not-mounted、innerReconnect=unverified、
provider=workbuddy ready、ok=true。三个值全部回到默认（enforceBearer=false / FailClosed=true /
无 bearer env 注入）。

## 6. 范围外发现（只报告、未动手）

真机链上 `chain-archive-verify` 条目恒 ok=false，broken=["audit-20260918.jsonl"]，
**自 2026-10-09T16:46 即存在**（8 个分片一致），早于本窗口与 HEAD=cbd5dfd，与本批改动无关。
已登记 residual risk，请主理人定夺是否立批处理。
