# Phase 0 止血批 · 交付总结（2026-10-08 深夜）

> **TL;DR**：owner 五项裁决后 3 小时内，六域体检定级的 Phase 0 全部子项闭环——路径穿越（U-P0-1）、dry-run 旁路 A1 化（U-P0-3）、守卫测试（P0-4）、测试脚本（R3）、幽灵能力文档止血（P0-5）、仓库卫生（R13）合入，新权威基线 **71 文件 / 1247 例（1245 pass / 0 fail / 2 skipped）** 零红收官。

## 交付概览

| 项 | 状态 | 提交 | 执行 |
|---|---|---|---|
| owner 五项裁决登记 + `.tmp`×22 解除跟踪 | ✅ | `13d7a12` `870fab2` | 主理人 |
| P0-5 幽灵能力×7 止血 + 名实不符×12 如实化 + 场景 C/E 重写 + Skill 双侧同步 | ✅ | `9dd13bd` | 许清楚 |
| C2/C6 连带（layout 引述 7 处失效标注 + 口径迁移） | ✅ | `0468791` | 许清楚 |
| P0-4 守卫：psmod 契约 7 例 + S-4/A5 装配点 24 例 | ✅ | `c10a400` | 严过关 |
| R3：test:unit 逐文件化（根除违禁整批 glob）+ layout 死入口删除 + s5 断言6 语义化 | ✅ | `c10a400` | 严过关 |
| **U-P0-1** normalizePath win32 段消解（total/幂等/UNC 不误伤/先归一后匹配） | ✅ | `ba02fbb` | 寇豆码 |
| **U-P0-1 连带发现第二绕过面**：extractPathTokens 盘符正则硬编码反斜杠（正斜杠盘符命令内嵌穿越根本不进策略视野） | ✅ 同批修复 | `ba02fbb` | 寇豆码 |
| **U-P0-3** dry-run A1 服务端声明制：supportsDryRun（6 条确凿声明）+ 引擎双条件 fail-closed + 哨兵常量契约化 + `ext.bypass='dry-run'` 链上取证 + SECURITY §3.4.1 | ✅ | `ba02fbb` | 寇豆码 |
| p0-path-traversal 守卫 84 例（段消解三态/逃逸对照/声明位集合钉死/内存变异 X1-X4/防注释自匹配） | ✅ | `ba02fbb` | 寇豆码 |
| 收官索引 + 基线 71/1247 三处同步 | ✅ | `ee939da` `9b64738` | 主理人 |

## 质量关卡记录

- **看门狗**：工程师首派静默死亡（53 分钟零产出）→ 团队重建 `software-winvm-phase0-e339` → 重派任务书带真实路径纠偏（engine.ts 在 `packages/core/` 非 vm-service）成功。
- **主理人独立核验**：全部 diff 审阅 + 复跑（p0 84/84、cl017 12/12、assembly-guard 24/24）+ `path.win32.resolve` 权威参照逐条裁定首轮 7 红（6 断言错 / 1 实现遗漏）+ 全量 `npm run test:unit` 实跑 `files=71 failed=0`。
- **变异验证三域齐全**：R1 7/7 RED、R2 24 条 RED、R3 4/4 RED、行为级 A/B/C（浅归一还原→穿越重新 ALLOW；单条件还原→未声明能力被免批；采集层回退→token 层与端到端双红）。
- **装配点纪律**：成员零 git 写、增量落盘 `docs/changes/phase0-{engine,qa,docs}-notes.md` 全程可回溯。

## Phase 1 输入（已登记 changed-log「遗留登记」节）

1. 安全兑现批：ARCH-06 A2 链范围透出 / ARCH-22 真取消 / ARCH-05 审批三态落链 / ARCH-07 bearer 或 requireLoopbackBind 不可关 / ARCH-17 白名单收紧 / ARCH-18 commandAllowlist（owner 已裁"暂缓，Phase 1 再二选一"）。
2. U-P0-1b 候选：注册表域不做段消解（`HKLM:\SOFTWARE\..\SAM` 字面命中 ALLOW，同族缺陷、非本次引入）。
3. R-3：buildPreview"可预览≠可免批"文案分叉，真机轮如涉旧文案断言需同步。
4. 真机轮（A5 复验最高优先，已获时间窗）：psmod 改动须落在构建指纹 R1' 之后。
5. 运维项：VM `C:\WinVMBridge\shared-skills` 重发布（隧道可达时）、skill frontmatter version bump。

## 下一步建议

1. `npm run test:unit`（新逐文件 runner）即可安全复现 1247 例基线；`npm test` = build + unit 全链。
2. VM 侧生效本次策略修复需部署轮：构建 → deploy-vm → `kill-restart.ps1`（顺序铁律：先部署→后补丁→再重启）。
3. 宿主插件缓存若要消费新契约（supportsDryRun 出现在 AgentCard/schema），实跑 `delivery/install-host.mjs`。
4. Phase 1 开工前把总报告 §4 Phase 1 清单 + 上述 5 项输入合并排程。
