# project-dir-file-index — 项目目录结构与关键文件索引

> 版本 v1.1.0 · 2026-10-20 · 随文件变更即时同步

## 目录结构

| 目录 | 说明 |
|------|------|
| `AppScope/` | 应用级配置（app.json5 + 全局资源） |
| `product/phone/` | HAP 宿主壳（framework 层：EntryAbility + Index 挂载页 + 权限声明） |
| `feature/winvm-onetap/` | **功能层 HAR（自包含可移植）**：ui/domain/data/prompt/util |
| `docs/01-research/` | DDD P1 调研文档 |
| `docs/02-design/` | DDD P2 设计文档 |
| `docs/03-impl/` | DDD P3 实现逻辑文档 |
| `docs/04-verification/` | DDD P4 验证报告 |
| `docs/pre-requirements/` | 父项目问题与建议（issues-and-suggestions.md，ID-1..5） |
| `docs/guides/` | 移植指南 / 用户手册 |
| `docs/03-impl/` | 实现逻辑（IMPLEMENTATION-LOGIC.md） |
| `docs/04-verification/` | 静态验证报告（TEST-REPORT-static-review.md） |
| `tools/` | 图标生成脚本（make_icon.py，zlib 手编 PNG） |
| `.dev/` | DDD 六索引 |

## 关键文件索引

| 文件 | 用途 | 版本 |
|------|------|------|
| `README.md` | 项目总览 + 快速开始 | v1.0.0 |
| `build-profile.json5` | 工程构建配置（SDK 基线 + modules） | v1.0.0 |
| `oh-package.json5` | 根包信息 | v1.0.0 |
| `hvigorfile.ts` | 根构建脚本（appTasks） | v1.0.0 |
| `code-linter.json5` | 代码检查配置 | v1.0.0 |
| `product/phone/src/main/module.json5` | HAP 模块配置（abilities + 权限） | v1.0.0 |
| `product/phone/src/main/ets/pages/Index.ets` | 宿主挂载页 | v1.0.0 |
| `product/phone/src/main/ets/entryability/EntryAbility.ets` | 入口 Ability | v1.0.0 |
| `feature/winvm-onetap/Index.ets` | HAR 唯一出口 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/ui/DeployPage.ets` | 部署助手页面 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/data/DeployEngine.ts` | 编排引擎（FR-2/FR-4） | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/data/GitHubReleaseClient.ts` | latest 解析 + 流式下载 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/data/Sha256Verifier.ts` | 分片 sha256 校验 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/data/ZipExtractor.ts` | zlib 解压 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/data/SharedDirStore.ts` | L3 复制 + report 读回 + 权限 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/data/ClipboardService.ts` | prompt 复制 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/prompt/InstallPromptBuilder.ts` | install prompt 模板 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/domain/DeployModels.ts` | 契约类型 | v1.0.0 |
| `feature/winvm-onetap/src/main/ets/util/Logger.ts` | hilog 封装 | v1.0.0 |
| `docs/pre-requirements/issues-and-suggestions.md` | 父项目问题上单（ID-1..5） | v1.0.0 |
| `docs/guides/PORTING-GUIDE.md` | 铠大师移植指南 | v1.0.0 |
| `docs/guides/USER-GUIDE.md` | 用户手册（真机验证清单） | v1.0.0 |
| `docs/03-impl/IMPLEMENTATION-LOGIC.md` | 实现逻辑说明 | v1.0.0 |
| `docs/04-verification/TEST-REPORT-static-review.md` | 静态验证报告 | v1.0.0 |
| `tools/make_icon.py` | 图标生成（zlib 手工编码 PNG） | v1.0.0 |
| `.dev/project-dev-status.md` | 任务树/阶段状态 | v1.1.0 |
| `.dev/changing-log.md` / `.dev/changed-log.md` | 变更登记 / 已完成变更（CL-001..004） | v1.1.0 |

## 文档索引
见 `docs-index.md`。
