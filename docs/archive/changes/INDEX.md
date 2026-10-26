# 归档导航 · docs/archive/changes

> 变更集（CL-*）与批次施工记录（phase*）的映射与目录清单。主题为各文件标题行实扫提取，非编造。
> CL-* 为「增量需求 → 技术方案 → QA/交付」三件套口径的变更集；phase* 为按阶段批次组织的施工 notes。

## CL 批 ↔ Phase 批次映射（实扫文件内容推导）

| CL 批 | 对应阶段/批次 | 依据（文件内自述） |
|-------|--------------|-------------------|
| `CL-015` ~ `CL-020` | Phase 0 之前的增量轮（2026-09-14 ~ 09-下旬；CL-015 ssh2 分发/常驻隧道、CL-016 审批闸 UX、CL-017 真机巡检修复、CL-018 遗留建议收口、CL-019 P3 契约修正、CL-020 F2 完善 + 隧道生产化） | 各 REQUIREMENT「变更标识 / 日期」行 |
| `CL-021` | R17 轮（第十七轮，2026-09-30；.dev 索引记「本轮补建」） | `CL-021/REQUIREMENT.md` 标题「R17 三项需求」 |
| `CL-022` | **Phase 1 安全边界兑现批**（T1~T5） | 标题自述「代号：Phase 1 安全兑现批」；上游 `phase1-arch-design.md`；实施记录 `phase1-t1~t5-notes.md` |
| `CL-K3R` | Phase 4 之后的 K3 根治专项（T05 真机轮 2026-10-05~06） | `CL-K3R/REQUIREMENT.md` 引 `k3r-t05-*` 真机报告 |
| `phase0-*` | **Phase 0 止血批**（2026-10-08） | 各文件标题「Phase 0」 |
| `phase1-*` | **Phase 1 安全兑现批**（= CL-022 的架构设计与 T1~T5 实施记录） | `phase1-arch-design.md` 标题 |
| `phase2-arch-design.md` | **Phase 2**（bearer 自检/内部凭据/快照事实三元组，F2 族） | 标题「Phase 2 · 架构排程」 |
| `phase3-b0~b5` | **Phase 3 批 0~5**（b0 文档止血、b1 审批闭环 P0-1 专项、b2 部署可达、b3 速赢交互包、b4 生产生态、b5 验证面恢复） | 各文件标题「Phase 3 批N · 主题」 |
| `phase4-b9` / `phase4-b10` | **Phase 4 批 9 / 批 10**（b9 教学与登记诚实化、b10 缺省形态端到端 + P2 随修族） | 各文件标题 |
| `phase5-c0` / `phase5-residual` | **Phase 5**（C0 转呈面专项、残项完善 R1/R2/R3） | 各文件标题 |
| `phase6-b17~b20` | **Phase 6 批 17~20**（b17 决策族裁决单、b18 七项裁决执行、b19 施工、b20 四项技术债/纯文档批 + b20 PRD） | 各文件标题 |

## CL 目录清单
| 目录 | 内含文件 | 主题（标题行） |
|------|---------|----------------|
| `CL-015/` | DELIVERY / REQUIREMENT / TECHNICAL-SOLUTION + 2 mermaid | CL-015 增量需求（PRD） |
| `CL-016/` | DELIVERY / QA-REPORT / REQUIREMENT / TECHNICAL-SOLUTION + 2 mermaid | CL-016 增量需求（PRD） |
| `CL-017/` | QA-REPORT / QA-REPORT-e1 / REQUIREMENT / TECHNICAL-SOLUTION | CL-017 真机 E2E 能力巡检缺陷修复（鸿蒙宿主 → Windows VM） |
| `CL-018/` | REQUIREMENT / TECHNICAL-SOLUTION | CL-018 WinVM Bridge 遗留建议逐项完善（增量 PRD） |
| `CL-019/` | REQUIREMENT / TECHNICAL-SOLUTION | CL-019 两项 P3 契约修正（增量 PRD） |
| `CL-020/` | DELIVERY-SUMMARY-2026-09-23 / DEPLOY-VERIFICATION / REQUIREMENT / TECHNICAL-SOLUTION | CL-020 F2 完善 + 隧道生产化（增量修正） |
| `CL-021/` | QA-REPORT / REQUIREMENT / TECHNICAL-SOLUTION | CL-021 R17 三项需求（宿主审批卡原生渲染 / 会话工具面注入保障 / K6 卸载核验） |
| `CL-022/` | QA-REPORT / REQUIREMENT / TECHNICAL-SOLUTION | CL-022 Phase 1 安全边界兑现批（真取消 / 信任边界 / 策略收紧 / 链范围 / 凭据通路 / 文档兑现） |
| `CL-K3R/` | QA-REPORT / REQUIREMENT / TECHNICAL-SOLUTION | CL-K3R K3「静默假成功」根治（审批真值判据结构化） |
| `CL-WBNATIVE/` | REQUIREMENT | **DEFERRED（2026-10-26 搁置）** WORKBUDDY-NATIVE ACP provider 提案：含 WorkBuddy 桌面版 ACP 服务端（`127.0.0.1:24622`）与 `codebuddy --serve --acp` 的全链路实测证据；维持 `workbuddy`+`codebuddy` 现状，未实施 |

## Phase notes 清单
| 文件 | 主题（标题行） |
|------|----------------|
| `phase0-delivery-summary.md` | Phase 0 止血批 · 交付总结（2026-10-08 深夜） |
| `phase0-docs-notes.md` | Phase0 文档止血 notes（P0-5） |
| `phase0-engine-notes.md` | Phase 0 · 引擎修复笔记（U-P0-1 路径穿越 + U-P0-3 dry-run A1 收紧） |
| `phase0-qa-notes.md` | Phase 0 止血 · QA 工作笔记（任务 #2） |
| `phase1-arch-design.md` | Phase 1 · 安全边界兑现批 —— 增量架构设计与任务分解 |
| `phase1-arch-class-diagram.mermaid` / `phase1-arch-sequence-diagram.mermaid` | Phase 1 架构图（类图 / 时序图） |
| `phase1-t1-notes.md` | Phase 1 · T1 契约与配置基座 —— 工程师实施笔记 |
| `phase1-t2-notes.md` | Phase 1 · T2 core 执行内核 —— 实现笔记（增量落盘） |
| `phase1-t3-notes.md` | Phase 1 · T3 实施笔记 — a2a-framework 真取消 + TaskStore 有界化 |
| `phase1-t4-notes.md` | Phase 1 · T4 装配层实施笔记（vm-service） |
| `phase1-t5-notes.md` | Phase 1 安全兑现批 · T5 实施笔记（执行体消费 + 宿主呈现 + 客户端 CLI + 文档兑现） |
| `phase2-arch-design.md` | Phase 2 · 架构排程（主题族归并 + 任务分解） |
| `phase3-b0-notes.md` | Phase 3 批0 · 文档止血 施工记录 |
| `phase3-b1-notes.md` | Phase 3 批1 · 审批闭环 P0-1 专项 施工记录 |
| `phase3-b2-notes.md` | Phase 3 批2 · 部署可达 — 工程师工作笔记 |
| `phase3-b3-notes.md` | Phase 3 批3 · 速赢交互包 施工记录 |
| `phase3-b4-notes.md` | Phase 3 批4 · 生产生态 施工记录 |
| `phase3-b5-notes.md` | Phase 3 批5 · 验证面恢复 施工记录 |
| `phase4-b9-notes.md` | Phase 4 · 批9 施工记录 —— 教学与登记诚实化（N-2~N-6） |
| `phase4-b10-notes.md` | Phase 4 · 批10 施工记录 —— 缺省形态端到端 + P2 随修族 |
| `phase5-c0-notes.md` | Phase 5 · C0 转呈面专项施工记录（K6 假成功回潮面根治） |
| `phase5-residual-notes.md` | Phase 5 残项完善 · 代码面施工记录（R1/R2/R3） |
| `phase6-b17-decisions.md` | Phase 6 · 批17 决策族裁决单 |
| `phase6-b18-notes.md` | Phase 6 · 批18 施工记录（7 项裁决执行） |
| `phase6-b19-notes.md` | Phase 6 · 批19 施工记录 |
| `phase6-b20-notes.md` | Phase 6 · 批20 施工记录（4 项技术债修复 · 纯文档批次） |
| `phase6-b20-prd.md` | Phase 6 · 批20 增量 PRD —— 四项技术债修复 |
