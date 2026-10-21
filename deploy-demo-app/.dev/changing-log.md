# changing-log — 进行中的变更记录

> 变更开始时登记；测试通过后迁移至 changed-log.md 并清空本文件。

- **CL-008（D9 真根因修复 + 功能 HAP 验收）**：TASK-003 产出功能完整 HAP（209,859 B，modules.abc ×29.7，HAR 全量符号命中，验签通过）。
  WB 独立核验（sha256 一致 / pages 行已落盘未入库 / main_pages.json 正确）后：将 D9（宿主 module.json5 缺 `"pages": "$profile:main_pages"`）
  落入版本库；gitignore 加固（build/、BuildProfile.ets、oh-package-lock.json5 三类生成物）；新增 TEST-REPORT-functional-hap-20261021.md
  （含误报风险声明：HAP 未真机运行，S2/S3 清单仍必须执行）。真根因 = D8（依赖解析）+ D9（编译入口）叠加。

- **CL-005（构建管线脚手架）**：新增 `.codeart-tasks/`（README + TASK-001）、`tools/build.sh`、` .codeart-out/`（.gitignore + .gitkeep），
  建立 WB↔CodeArts Agent 文件交接管线；同步索引。TASK-001 执行待 bridge 在 CodeArts Agent 跑通。
- **CL-006（编译器裁决 + A类修复）**：TASK-001 跑通，产出 12E/40W 三分类（5真实+7环境）；修复 DeployPage.ets 5 处真实 API 误用
  （Column 间距构造参数 / Select.font→.font({size}) / TextOverflow 对象包裹×3）；新增 TEST-REPORT-compiler-20261020.md + TASK-002.md；
  根因锁定：本机沙箱 Node JIT 损坏致 HAP 无法产出，须 Mac/Win DevEco。
- **CL-007（工程配置缺陷修复）**：TASK-001 重跑，官方 hvigor 编译成功 + HAP 验签；裁决 8 工程缺陷，应用 7 个到真实源码
  （3×hvigorfile 包名+harTasks拼写 / modelVersion / SDK版本26.0.0 / module.json5 2in1+deliveryWithInstall / configuration.json 3.2 / 新建 hvigor-config.json5）；
  D4 采可移植空签名（不入库密钥）；D8 ohpm install 留 TASK-003；gitignore 加 oh_modules/ local.properties；新增 TEST-REPORT-config-fixes-20261021.md + TASK-003.md。

## 说明

- CL-001（P1/P2 + 六索引）、CL-002（工程骨架）、CL-003（HAR 实现）、CL-004（文档+提交）见 changed-log.md。
- 下一批次预计为用户真机验证后的 P5 迭代（CL-005）。
