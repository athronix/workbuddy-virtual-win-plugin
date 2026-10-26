# 导航 · qa/

> QA 证据与驱动脚本区。本目录**整体保留原位、不迁移**：多个脚本存在活路径依赖——
> `delivery/setup.mjs:291` 读 `qa/probes/`；`delivery/pack-release.mjs:40` 写 `qa/release/`（evidenceDir）、`:149/:163` 引用 `qa/probes/*`。
> 本文件仅新建导航汇总，**不移动、不改动 qa/ 下任何现有文件**。

| 子目录 / 文件 | 用途（一句话） |
|---------------|----------------|
| `probes/` | **脚本活路径**（被 setup.mjs / pack-release.mjs 引用），勿动 |
| `release/` | 发布证据：逐版本 `V*-pack.txt`（三包指纹）+ `V*-deploy-run*.log` 部署实录（pack-release.mjs 的 evidenceDir 落点） |
| `p3-batch-sweep/` | Phase 3 批扫证据与**测试基线权威**：`gate-*.txt`（README §8 指向「qa 最新 gate-*.txt」；`gate-docs-overview.txt` 等在册） |
| `p3b02-regression/` | Phase 3 批0-2 回归证据（gate 运行输出、check-fresh、report.md） |
| `p5-batch/` | Phase 5 批次证据（b12 wiring、b13、b16 VERDICT、v19 VERDICT、c0、residual 真窗等） |
| `p4-b9-qa-regression.md` / `p4-b10-qa-regression.md` / `p5-c0-qa-regression.md` | Phase 4 批9/批10、Phase 5 C0 的 QA 回归记录 |
| `r18/` | R18 真机轮历史证据（VM 部署日志、diagnose-connectors 输出） |
| `r19/` | R19 真机轮历史证据与驱动脚本（`a2a-extra.mjs` 等）+ t9/t11 设计件 |
| `harness/` | 验证驱动脚本（e2e-p3-5x2.mjs、tidy-vm-devqa.ps1） |
| `evidence/` | 杂项证据（gate 逐轮输出、accept-* 脚本、a2a smoke 回执等） |
| `audit-2026-10-14-raw/` | 2026-10-14 再审计原始分域件（aud-* 系列 + ledger-lead.md） |
| `archive/` | 早期临时件（`early-tmp/`） |

> 历史测试报告（真机/QA 逐轮）已迁至 `docs/archive/test/reports/`（见 [docs/archive/INDEX.md](../docs/archive/INDEX.md)）；本目录以**脚本 + 原始证据**为主。
