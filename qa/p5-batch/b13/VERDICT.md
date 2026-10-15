# 批13 服务层真卸载验证窗 · 裁定（2026-10-15 20:0x）

## 主结论：审批闭环端到端真机实锤 ✅（V6 达成；on 态执法在网）
全链路（LLM 常驻委派，wiring=on 现网）：
1. 挂起：`input-required`+`apr_7ee0a7247be14cba83ae`（L2 风险+真实目标参数+TTL 拒绝语义文案，uninstall-hang.json 留证）
2. 批准：真实审批通路 `message/send`（taskId+data part `{approvalId,approved:true}`）→ resp=working
3. 重放：链上 seq26 `tr_mv9hnnlv_8-replay`：`matchedRule=allow:policy-passed`+**approvedBy=host**+`ok=true`+**durationMs=24941**（真实 winget 执行时长，对照 dryRun=4591ms/失败态≈0ms）
4. 链完整：seq25（approval-required 挂起）→seq26（replay 成功）→seq27（委派 completed）prevHash/hash 衔接；install 侧 seq30 `allow:policy-passed` 5982ms
5. 复原：装机后 inventory ripgrep=在（`9baa936e` completed），VM 回到起点态、零破坏遗留。

## 新观察项 V19（如实登记，不在本轮钉死）：portable 包"卸载成功但清单残留"
- 现象：seq26 `ok=true`（K6 语义=exit0∧核验过）后 10 秒 `app.inventory.list` 仍见 `RipGrep MSVC 15.2.0/installDate=20260921`；随后 L1 install 5.98s 即"成功"（疑似 winget 视为已装幂等秒回）。
- 候选解释：① portable 包（WinGet\Packages\ 型，`winget uninstall --product-code`）的核验对象 installPath/注册表键在"半卸载"态未消失；② 注册表 Uninstall 键与实际文件树脱钩；③ inventory 快照缓存。
- 定性所需：r3-uninstall-verify 三态判据（exeGone/dirGone/registryGone）细读 + VM 现场目录比对——**登记后续专项**，本轮不冒判"假成功"（K3 教训：未复现≠已修，反向亦成立：单例疑点≠系统性缺陷）。
- 佐证不缺：dryRun 预览当时明示 `installerType=other ⇒ 非 NSIS 永不回退，核验未过即 success=false`——即回执 ok=true 意味着核验判过，与清单残留构成矛盾面，值得查。

## 收尾读数
- `/health.policyGate`：`wiring=on`（批12 切换在网）、**`directWithActiveTurn=2`**（批10 G3 观测计数首次非零——实弹期并发窄窗实况显形，属登记观察非缺陷）、scopeEntries=2（input-required 不销账=设计态）。
- llmSession：restarts=2（实弹期 LLM 会话有过重启，与前两轮"LLM runtime 不可用→降级"时间线吻合，瞬态已自愈）、wsPeakMb=18.5。

## 证据清单
- live-fire-trace.txt / live-fire-summary.txt（全程时间线）
- uninstall-hang.json（挂起 preview 全文）/ uninstall-final.json / reinstall-final.json
- chain-read（seq 时间线）/ chain-replay（seq26 全文，本文件上方摘录）
