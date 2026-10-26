# 归档区导航 · docs/archive

> 本目录收纳**历史交付件**（变更集、审计报告、测试报告），自 2026-10-26 结构重定位起由原 `docs/changes`、`docs/audit`、`docs/test` 三目录迁入，全程 `git mv` 保留历史。
> 归档内部**不做重命名**（CL-*、phase*、日期文件一律保持原名），以保护 git 历史与内部互链。
> **现行权威文档不在此区**：规范设计看 `docs/02-design/`，逐缺陷设计稿看 `docs/design/`，门禁/发布证据看 `qa/`（保留原位）。

三大块导航：

| 块 | 目录 | 内容 | 子索引 |
|----|------|------|--------|
| 变更集 | [`changes/`](changes/INDEX.md) | CL-* 变更三件套 + Phase 0~6 施工 notes | [changes/INDEX.md](changes/INDEX.md) |
| 审计报告 | [`audit/`](audit/INDEX.md) | 全维度体检 / 再审计 / 全景综述台账 | [audit/INDEX.md](audit/INDEX.md) |
| 测试报告 | [`test/`](test/INDEX.md) | 真环境测试方案 + 真机/QA 报告 | [test/INDEX.md](test/INDEX.md) |

---

## changes/ —— 变更集与批次 notes（按 CL 批 → Phase 批分组）

### CL-* 增量变更集（各含 REQUIREMENT / TECHNICAL-SOLUTION 等）
| 目录 | 一句话主题 |
|------|-----------|
| `CL-015/` | CL-015 增量需求（PRD）：ssh2 离线分发 + 常驻隧道收口（装完不可用根因） |
| `CL-016/` | CL-016 增量需求（PRD） |
| `CL-017/` | CL-017 真机 E2E 能力巡检缺陷修复（鸿蒙宿主 → Windows VM） |
| `CL-018/` | CL-018 WinVM Bridge 遗留建议逐项完善（增量 PRD） |
| `CL-019/` | CL-019 两项 P3 契约修正（增量 PRD） |
| `CL-020/` | CL-020 F2 完善 + 隧道生产化（增量修正） |
| `CL-021/` | CL-021 R17 三项需求（宿主审批卡原生渲染 / 会话工具面注入保障 / K6 卸载核验） |
| `CL-022/` | CL-022 Phase 1 安全边界兑现批（真取消 / 信任边界 / 策略收紧 / 链范围 / 凭据通路 / 文档兑现） |
| `CL-K3R/` | CL-K3R K3「静默假成功」根治（审批真值判据结构化） |

### Phase 批次 notes（按阶段分组）
| 文件 | 一句话主题 |
|------|-----------|
| `phase0-delivery-summary.md` | Phase 0 止血批交付总结 |
| `phase0-docs-notes.md` | Phase 0 文档止血 notes（P0-5） |
| `phase0-engine-notes.md` | Phase 0 引擎修复笔记（路径穿越 + dry-run 收紧） |
| `phase0-qa-notes.md` | Phase 0 止血 QA 工作笔记 |
| `phase1-arch-design.md` | Phase 1 安全边界兑现批 — 增量架构设计与任务分解 |
| `phase1-arch-class-diagram.mermaid` / `phase1-arch-sequence-diagram.mermaid` | Phase 1 架构图（类图 / 时序图） |
| `phase1-t1-notes.md` ~ `phase1-t5-notes.md` | Phase 1 T1~T5 逐任务实施笔记 |
| `phase2-arch-design.md` | Phase 2 架构排程（主题族归并 + 任务分解） |
| `phase3-b0-notes.md` ~ `phase3-b5-notes.md` | Phase 3 批 0~5 施工记录 |
| `phase4-b9-notes.md` / `phase4-b10-notes.md` | Phase 4 批 9/10 施工记录 |
| `phase5-c0-notes.md` / `phase5-residual-notes.md` | Phase 5 C0 转呈面专项 / 残项完善代码面记录 |
| `phase6-b17-decisions.md` / `phase6-b18-notes.md` / `phase6-b19-notes.md` / `phase6-b20-notes.md` / `phase6-b20-prd.md` | Phase 6 批 17~20 决策族与施工记录 |

---

## audit/ —— 全维度体检与再审计台账
详见 [audit/INDEX.md](audit/INDEX.md)。要点：`2026-10-08-comprehensive-assessment.md` 为综合总报告（先读）；`2026-10-12-full-audit.md`（Phase 3 终版）、`2026-10-14-full-audit.md`（Phase 4 终版）、`2026-10-15-panorama-phase5.md` / `2026-10-16-panorama-phase6.md` 为各阶段全景综述。

## test/ —— 真环境测试方案与报告
详见 [test/INDEX.md](test/INDEX.md)。`real-test.md` 为测试方案；`reports/` 下为逐轮真机 / QA 独立回归报告（按日期命名）。
