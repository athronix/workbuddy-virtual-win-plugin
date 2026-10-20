# CHANGE-OBJECTIVE — 变更目标确认

> DDD Phase 1 Step 1.5 调研产物 · 版本 v1.0.0 · 2026-10-20

---

## 1. 变更性质

**场景 A（NEW-PROJECT）**：在父项目只读边界内，从零创建子项目 `deploy-demo-app`
（鸿蒙 native app + DDD 文档体系）。父项目目录零改动（验收见 TASK-UNDERSTANDING A8）。

## 2. 交付目标（按 DDD 七阶段映射）

| 阶段 | 交付物 | 落点 |
|------|--------|------|
| P1 调研 | PROJECT-OVERVIEW / TASK-UNDERSTANDING / CHANGE-OBJECTIVE | docs/01-research/ |
| P2 设计 | REQUIREMENT / TECHNICAL-SOLUTION / ARCHITECTURE / DESIGN / INTERFACE-DEFINITION / TEST-PLAN | docs/02-design/ |
| P3-P5 实现验证 | feature HAR + phone HAP + AppScope 工程；静态验证报告 | feature/ product/ AppScope/ docs/04-verification/ |
| P6 配套 | issues-and-suggestions.md / PORTING-GUIDE / USER-GUIDE / README | docs/pre-requirements/ docs/guides/ |
| P7 交付 | .dev 六索引 + 原子化 git 提交 | .dev/ |

## 3. 功能目标（一句话定义）

> 在 HarmonyOS PC 上，用 ≤3 次点击 + 一次粘贴，把 V1.4.0+ 的 WinVM Bridge 发布包
> 从 GitHub Release **真实下载、校验、解压、落到共享目录**，生成可粘贴的
> WorkBuddy install prompt 并复制，随后**轮询读回** deploy-report 展示部署验证结果。

## 4. 与父项目的协作目标

- **问题上单而非动手**：发现父项目问题/缺口 → 登记 `docs/pre-requirements/issues-and-suggestions.md`
  （含严重度、影响、建议、证据），不修改父项目文件。
- **协议对齐**：prompt 模板、KV 契约、report JSON 契约、包命名均与父文档保持一致；
  不可避免的偏差（如 report 旁写副本）在 issues 中显式申报。

## 5. 不在范围内（Out of Scope）

1. VM 环境准备按钮的真实执行（无 VM 通道）。
2. WorkBuddy 安装检测（无跨应用查询权限）。
3. 离线兜底包内置（铠大师侧能力，文档注明即可）。
4. 任何父项目侧代码/文档修改。
5. 上架 AGC 所需的签名/ACL 配置（demo 用 debug 签名跑真机）。

## 6. 回滚策略

全部产物限本子项目目录；如需回滚 = 删除 deploy-demo-app 目录即恢复父项目原状
（目录为 git 新增，父项目 HEAD 不受影响）。
