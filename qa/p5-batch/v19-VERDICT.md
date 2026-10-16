# V19 真机定性裁定（主理人 2026-10-16）· 详见 docs/audit/2026-10-16-v19-analysis.md §6

**结论**：C0 转呈面结构缺陷立案（P2 后续，走契约流程）；H1/H2/H4 排除；H3 并入 C0 修复后可观测。

- 只读采集 S1（注册表单条目、UninstallString 回指 winget、InstallLocation=包目录）+ S2（portable 型，Links\rg.exe=False）+ S3（dryRun：installerType=other、installRoot **正确**指向包目录、registryKey 命中 HKCU）——详见 v19-S1S2.txt / v19-S3.txt。
- C0 独立于本次 verified 真值坐实：代码 data.success 与呈报 res.ok 零折叠点；现网 (c) 下直调 L2 收口 DELEGATION_REQUIRED、委派完成步只报 appops.workflow.run 合成 ok:true——**两条呈报路径都不携带 app.winget.uninstall 的 data.success/verified/residualEvidence**，卸载成败在现呈报面不可判（K6 假成功回潮面）。
- **不做破坏性 S4**：其唯一增益=verified 三态实测，但 C0 已坐实、H1 已排除、且 (c) 下 S4 拿不到裸 data（除非临时关 (c) 偏离缺省），破坏采集无信息增益；依"不人为强造破坏"纪律收口。ripgrep 现网在位（S1 单条 + S3 installed=true 双证）。

**后续项（非本轮）**：转呈面专项——toExecutedResult/summary 层识别 data.success===false 改判摘要 + residualEvidence 进委派回执（行为改动，契约保护流程 + 离线钉先行）。
