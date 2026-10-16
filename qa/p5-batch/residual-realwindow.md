# Phase 5 残项 · 真机窗裁定（2026-10-16 主理人）

## V3 [k6] TIMED-OUT 超时树杀分支 —— 真机不可安全构造，维持离线钉 + 如实登记
- 探针 `v3-k6.ps1`（dot-source 生产 app.ps1 调 `Invoke-WingetBounded -TimeoutMs 300`）经 SSH 实测：`exitCode=-9994 WINGET_SPAWN_FAILED 拒绝访问`——**SSH 非交互会话内 winget.exe（MSIX App Execution Alias）不可执行**（与批13 前两轮 LLM 降级、probe3「拒绝访问」同因，第三次独立复现坐实这是 OS 级结构限制，非产品缺陷、非偶发）。
- 经服务层委派触发超时分支同样不可安全构造：`Uninstall-WingetPackage` 入参仅 `Id/DryRun`，`wingetBudgetMs=300000` 硬编码（app.ps1 函数体），要自然触发超时需一个真实 >300s 挂起的卸载（等 UAC/交互确认）——属高危不可控，且会留半卸载态。
- **裁定**：超时树杀分支逻辑由离线 `r3-uninstall-verify`(39) + `phase3-b5-psbridge-spawn-error` 钉死（taskkill /T 树杀语义 + 不谎报 success）；真机自然触发登记为"需真实挂起窗"观察项（同批2 V5 幂等实跑后的遗留族处置），**不人为强造**。批13 已真机坐实"正常卸载路径"（seq26 24.9s 真实执行）——超时分支是其对偶，语义面已由离线覆盖。

## V14 wsEvictions 自然触发 —— 决策不主动低阈值注入（风险>收益）
- 现网 `llmSession`：`wsLatestMb≈15-18 / wsPeakMb=18.5 / wsEvictions=0 / restarts=2`。回收判据 `persistent-session.ts:1016 ws>maxWsBytes(缺省512MB)⇒evictions+1+回收重建`（:1018-1019），路径由 `p4-b10-ws-health-observe` 单测钉死。
- 强触发手段=start-hidden.ps1 注 `WINVM_LLM_SESSION_MAX_WS_BYTES` 远低于当前 ws ⇒ 立即 evict。但：① 新会话 spawn 即可能仍超限 ⇒ **重启风暴撞 maxRestarts→会话 disabled**（MEMORY provider=workbuddy 打挂会话红线同源教训）；② 属"人为构造"非"自然显形"，验证价值低于扰动风险。
- **裁定**：V14 读数显形已在（B-5 半闭达成：`/health` 三键在网、批13 采到 18.5MB 峰值）；"evictions>0 自然触发"维持长跑量观察项，**不低阈值强触发**。护栏"存在且接线"已由批6 A2-11+批10 G7+离线钉三方坐实，回收计数真实生效性属可后验项。

## 真机窗状态：转 V19 采集（待工程师 R2 出分叉表照单打）
