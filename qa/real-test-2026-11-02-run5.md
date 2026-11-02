# 真机测试报告 · run5（2026-11-02，迭代13——智能体安装脚本发布链 + I-6.9/I-6.10 现场）

> 对象：V1.4.10（在途上架版）清场重装 run5 首跑 → 揪出两真缺陷 → 修复 → **V1.4.11 发布态复验全绿**
> 环境：鸿蒙宿主 ↔ Win11 VM `172.16.100.2`（User，默认 shell=cmd.exe）
> 结论：**可交付（V1.4.11）**。run5 首跑的 E7/E8 连败定性为 P1 真缺陷（看门狗忙态误杀）并完成修复复验；setup TUNNEL 假败同步修复。

## 1. run5 首跑（V1.4.10 包面）——两处连败定性过程

| 现象 | 定性 |
|---|---|
| example-probe 首跑 11/13：E7 `storage.cleanup.analyze` FAIL（dur=44927，**HEARTBEAT_TIMEOUT"正在重启"**）、E8 `system.eventlog.query` FAIL（dur=27，**PSBRIDGE_EXITED**+双份启动 banner）；**复跑仍 11/13 同点连败** | 连败=非瞬态 → 根因：ps-bridge.ps1 单线程，长同步调用期心跳/ping 双停，TS watchdog 45s 心跳超时→ping 排同队列必超时→restart **误杀在干活**的桥（I-6.9，P1）。历轮"首跑瞬态复跑即稳"=缓存热 39s<45s 阈值**临界侥幸**，口径证伪 |
| setup rc=1「部署完成但有 1 个步骤失败」而 HEALTH 相位 32.7s 后 /health 200 | TUNNEL 相位假败（I-6.10，P2）：ensure 后 1×2s 探窗 vs VM 冷启动 ~30s 必空 → 误回落 ssh2 撞 EADDRINUSE（daemon 持端口）→ 计失败 |

## 2. 修复与验证（三层证据）

- **I-6.9**：`shouldProbeStaleHeartbeat` 纯函数判据（忙=放行 / idle 且陈旧且 ping 无应答=照判重启）。
  - 单测 `p6-d16-psbridge-busy-guard.test.js` 3/3；**判别性核验**：dist 模拟旧行为 → test2 必翻转 FAIL（复现 HEARTBEAT_TIMEOUT 误杀）、test3 恒 PASS（真僵死检出力不削弱）。
  - VM 热更实弹：修复 dist 入 `C:\WinVMBridge` + VM-START 后 **E7×3（104.5s / 63.2s / 67.7s，全在旧必死区 >45s）+E8×3 连发全 ok=true**、restarts=0。
- **I-6.10**：ensure 后探窗放宽 10×2s + 回落撞 EADDRINUSE 且端口被持有 ⇒ 判"复用"交 HEALTH 端到端。
- **发布态复验（V1.4.11 包，--wipe 清场重装链）**：包内 uninstall **19/19 零 FAIL rc=0** + 独立复核（000/GLOBAL_MCP_CLEAN）→ setup 七相位 **rc=0「部署全部完成 ✅」**（假败消除，对比 run5 修复前 rc=1）→ **mcp 20/20 + a2a 5/5 + example 首跑即 13/13**（E7 无瞬态）= **38/38**。

## 3. 智能体安装脚本裁定核验面（本迭代主题）

- 匿名回环解包：`docs/deploy/deploy.prompt`/`undeploy.prompt` 与仓库 HEAD **逐字节一致**（v2.0.2/v2.2 深化面=Step 0 前置五项+执行协议+vm-rmkey 实测模板）。
- pack **V11 内容断言**首战通过（此前 V1.4.9 包内 v2.1 若遇 V11 会被拒产——机械化封堵"深化滞后"）。
- undeploy.prompt v2.2 的 vm-rmkey.ps1 模板此前已真机实弹（注入假密钥→两处 REMOVED=1→他人密钥无损）。

## 4. 指纹

V1.4.11：tag@`0a01b15`（包源点）；zip `ddd8a3db29e5ca99…`（2,878,157 B）；三元组 881 / 7,681,227 / `2e64d9c3…`；latest API=V1.4.11。V1.4.10 为在途上架版（`a396a314…`，不撤回，被 V1.4.11 取代）。

## 5. 结论

**可交付**。run5 的价值在于拒绝"复跑即稳"的旧口径继续掩盖 P1——看门狗忙态误杀自此根除（忙/死判别入判据+单测+实弹三层钉死），setup 清场重装回归 rc=0。证据日志：`qa/evidence/run5-v1411-20261102/`（10 件，含修复前连败现场与修复后发布态全绿）。
