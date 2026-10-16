# C0 转呈面折叠 · 真机复验裁定（2026-10-16 17:1x）

## 结论：折叠现网生效 ✅（K6 假成功回潮面根治实证闭合）

**样本**：委派真卸载不存在的包 `Nonexistent.Test.Zzz`（零真实变更风险），挂起 `apr_6214c4a6` → 宿主批准 → 服务端重放。

**链上决定性证据**（`chain-replay-entry.json`，shard audit-20261016-2 seq5 全文）：
- `policyDecision.matchedRule=allow:policy-passed`（审批通路正常）
- **`result.ok:false` + `errorCode:EXECUTION_FAILED` + summary=`app.winget.uninstall 执行未成功：执行器自报未成功（K6 核验未过）`**——`K6_FAIL_MESSAGE` 折叠专属文案直接命中，即 `data.success===false` 被 fold 翻转呈报；
- `durationMs:27050`：winget 真实执行 27s 后失败，非瞬造（对照首轮 attempt1 ps-bridge 死亡 45s 超时路径——两族失败各归其位，均诚实）。

**对照面**：批13 同场景（真包卸载核验未过）当时呈报被压平为「执行成功」；本轮同链路呈报诚实——C0 定性（`v19-VERDICT.md`）的修复预期兑现。

**分层验证矩阵**：
| 层 | 真机证据 | 状态 |
|---|---|---|
| 服务回执（structuredContent ok/isError/error.reason） | 链上条目同源（sink 写自折叠后回执）+ 离线 fold-service 9 例 | ✅ |
| 审计链条目（2c 写入点） | 本条 seq5 全文直接实证 | ✅ |
| receiptCache→K5/重放转呈 | 离线行为钉④（toExecutedResult 消费折叠回执产失败摘要）+ 本轮呈报无假成功 | ✅（结构保证） |
| 委派完成步携带折叠回执 | 本轮被 LLM 会话瞬态降级干扰未直达（VM 刚重启窗口，known transient），呈报仍诚实 failed 无假成功 | 自然样本待会话健康期复现（可选观察，不阻塞） |

**插曲如实登记**：① 首轮实弹（attempt1-*）撞上 ps-bridge 死亡+VM 随后整机失联（16:5x~17:0x，宿主侧非我们代码所致）；VM 恢复后服务经计划任务拉起、隧道守护自动重连——运维链路（schtasks 短超时+health 轮询姿势）按 §1.8 教训执行成功。② 首轮样本意外成为"基础设施失败诚实呈报"旁证（链上 `EXECUTION_FAILED ps-bridge 未心跳`原样透传未被覆盖——2b"provider 自报失败不覆盖自家 error"裁断的真实路径验证）。

**基线**：121 件/2162 例 GREEN（gate-p5-c0-final.txt）；现网 wiring=on+折叠在位（deploy-c0.txt）。
