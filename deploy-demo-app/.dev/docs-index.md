# docs-index — 文档索引和版本管理

> 版本 v1.1.0 · 2026-10-20 · 文档变更即时同步

## P1 调研（docs/01-research/）

| 文档 | 说明 | 版本 |
|------|------|------|
| PROJECT-OVERVIEW.md | 项目概况理解（父项目部署体系 + 鸿蒙侧事实表 F1-F10） | v1.0.0 |
| TASK-UNDERSTANDING-winvm-onetap.md | 任务理解（Q1-Q7 澄清 + 验收 A1-A8） | v1.0.0 |
| CHANGE-OBJECTIVE-demo-app.md | 变更目标确认（七阶段映射 + Out of Scope） | v1.0.0 |

## P2 设计（docs/02-design/）

| 文档 | 说明 | 版本 |
|------|------|------|
| REQUIREMENT-winvm-onetap.md | 需求设计（FR-1..7 + NF-1..6） | v1.0.0 |
| TECHNICAL-SOLUTION-winvm-onetap.md | 技术方案（选型表 + 三层架构 + 异常降级） | v1.0.0 |
| ARCHITECTURE-system.md | 系统/模块层架构（目录结构 + 职责表） | v1.0.0 |
| DESIGN-deploy-module.md | 模块详细设计（分层契约与实现约束） | v1.0.0 |
| INTERFACE-DEFINITION-winvm-onetap.md | 接口定义（HAR API / 下载协议 / prompt / report） | v1.0.0 |
| TEST-PLAN-winvm-onetap.md | 测试方案（S1 静态 + S2 真机 + S3 降级） | v1.0.0 |

## P3 实现 / P4 验证 / P6 配套 / P7 交付

| 文档 | 说明 | 版本 |
|------|------|------|
| docs/03-impl/IMPLEMENTATION-LOGIC.md | 实现逻辑说明（与设计对照：数据流 + 关键决策） | v1.0.0 |
| docs/04-verification/TEST-REPORT-static-review.md | 静态验证报告（10 规则 0 violations；D1 已修复；编译/真机未执行） | v1.0.0 |
| docs/pre-requirements/issues-and-suggestions.md | 父项目问题与建议（ID-1..5） | v1.0.0 |
| docs/guides/PORTING-GUIDE.md | 铠大师移植指南（框架/功能解耦 + 清单） | v1.0.0 |
| docs/guides/USER-GUIDE.md | 用户手册（真机操作 + S2/S3 验证清单） | v1.0.0 |
| README.md | 项目总览 + 快速开始 | v1.0.0 |

## 更新记录

| 日期 | 文档 | 变更 | 作者 |
|------|------|------|------|
| 2026-10-20 | 全部（P1/P2） | 初版创建 | agent |
| 2026-10-20 | P3/P4/P6 + README + 本索引 | CL-002..004：实现逻辑/静态报告/issues/指南/手册/总览补全 | agent |
