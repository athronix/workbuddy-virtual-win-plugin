# changed-log — 已完成的原子化变更记录

> 从 changing-log.md 迁移；每条含变更内容 + 验证结论 + 提交号（如有）。

## CL-001 项目初始化：P1/P2 文档 + .dev 六索引

- **开始**：2026-10-20 12:05
- **完成**：2026-10-20（随 CL-004 提交）
- **内容**：docs/01-research 3 份、docs/02-design 6 份、.dev 六索引初始化
- **验证**：人工通读；任务树 #1-#3 完成
- **提交**：见 CL-004 commit

## CL-002 工程骨架：AppScope + HAP 壳 + HAR 骨架 + 构建配置

- **内容**：AppScope/app.json5（bundleName com.example.winvmonetapdemo）；
  product/phone（EntryAbility + pages/Index 挂载 + module.json5 双权限 + 资源 + 图标）；
  feature/winvm-onetap（module.json5 + build-profile + hvigorfile + oh-package 依赖 file 引用）；
  根 build-profile.json5（SDK 6.1.0(23)/compatible 6.0.0(20)）；tools/make_icon.py（zlib 手编 PNG）
- **验证**：目录树与 build-profile modules 对照一致；module.json5 srcEntry 与实际文件路径核对一致
  （entryability 小写）；PNG 头字节合法

## CL-003 HAR 实现：data 层 + prompt + UI + HAP 接线

- **内容**：domain/DeployModels（契约类型 + error 码 E1001-E6001）；
  data/：GitHubReleaseClient（latest 解析 + requestInStream 流式下载 .part→rename）、
  Sha256Verifier（分片 sha256 + 旁挂解析）、ZipExtractor（zlib Promise 化）、
  SharedDirStore（权限/L3 复制/report 三重采信读回）、ClipboardService、DeployEngine（编排 + 10s 轮询）；
  prompt/InstallPromptBuilder（父模板 §5.2 逐字 + 步骤 9 追加 + 防呆断言）；
  ui/DeployPage（V1 四按钮/进度/日志/报告卡）；Index.ets 出口
- **验证**：静态自审 10 规则 0 violations、8 组 Kit API 签名核对、父契约逐条比对
  （详见 docs/04-verification/TEST-REPORT-static-review.md）
- **内含修复**：D1 parseSidecar 全行 hex 拼接 bug → 空白分隔首 token（对照 pack-release.mjs:344）

## CL-004 配套文档 + 索引同步 + 原子提交

- **内容**：docs/04-verification/TEST-REPORT-static-review.md；docs/03-impl/IMPLEMENTATION-LOGIC.md；
  docs/pre-requirements/issues-and-suggestions.md（ID-1..5）；
  docs/guides/PORTING-GUIDE.md + USER-GUIDE.md；README.md；.dev 五索引同步
- **验证**：docs-index 与实际文件一一对应；project-dev-status 任务树全 ✅
- **提交**：本提交（deploy-demo-app 整目录，父项目零改动——git status 仅 ?? deploy-demo-app/）
