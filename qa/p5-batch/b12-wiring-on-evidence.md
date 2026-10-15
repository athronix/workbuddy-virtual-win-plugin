# 批12 现网 shadow→on 切换实录（2026-10-15 18:1x~18:5x）

## 读稳判定（第0步）
切换前 `/health.policyGate`：`{"wiring":"shadow","shadowHits":0,"delegationRequiredPolicy":true,"scopeEntries":0,"directWithActiveTurn":0}`
⇒ 宿主声明形态健康（两键从未被声明，hits=0）⇒ on 态增量风险≈0，满足读稳标准。

## 切换过程（含真机证伪一条）
1. **首打失败（教训入册）**：`Add-Content` 追加 `$env:WINVM_POLICY_GATE_WIRING='on'` 到 start-hidden.ps1 **文件尾** → kill-restart 后 wiring 仍 shadow。根因=脚本末尾位于 `WaitForExit` 阻塞之后，追加行永不执行。
2. **修正**：还原 bak → 在 `$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS` 行后**插入**（复核 ENV-LINE=3 < START-PROCESS-LINE=13）→ 再重启。
3. **重启通道坑**：ssh 远程 `schtasks /run` 拖住 ssh 不返回（挂 34min 被终止，任务实际已成功）——改经隧道轮询 `/health` 判翻转。
（两条已回写 DEPLOYMENT §1.8 硬约束注记。）

## 三查回验（全中）
- 查1 `GET /health`：`policyGate={"wiring":"on",...}` **翻转确认** ✓
- 查2 纯直调 L2（storage.file.delete WinVMWorkspace 路径）：`DELEGATION_REQUIRED`+retryable:false+无令牌 ✓（on 不回归 (c) 面）
- 查3 可用性：`meta.health.check ok=true` ✓；provider=ready、session 正常
- 执法实弹（V18）：待一次带 `maxRisk:'L1'` 声明的真实委派自然样本，链上 `matchedRule='maxRisk:L1'` 为证；离线行为面（p3-b1 ③⑤+E2E 五象限）已实锤，不伪造。

## 运维裁定
**保持 on 观察**（不回滚）。回滚位=§1.8 第3步（删插入行+kill-restart 即回 shadow）。
注意：补丁系临时运维态，任何 `deploy-vm --apply` 后须按 §1.7 顺序铁律重打（或批14 通道化后持久）。
