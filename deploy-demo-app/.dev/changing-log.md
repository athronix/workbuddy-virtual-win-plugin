# changing-log — 进行中的变更记录

> 变更开始时登记；测试通过后迁移至 changed-log.md 并清空本文件。

## 当前变更

- **CL-005（构建管线脚手架）**：新增 `.codeart-tasks/`（README + TASK-001）、`tools/build.sh`、` .codeart-out/`（.gitignore + .gitkeep），
  建立 WB↔CodeArts Agent 文件交接管线；同步索引。TASK-001 执行待 bridge 在 CodeArts Agent 跑通。
- **CL-006（编译器裁决 + A类修复）**：TASK-001 跑通，产出 12E/40W 三分类（5真实+7环境）；修复 DeployPage.ets 5 处真实 API 误用
  （Column 间距构造参数 / Select.font→.font({size}) / TextOverflow 对象包裹×3）；新增 TEST-REPORT-compiler-20261020.md + TASK-002.md；
  根因锁定：本机沙箱 Node JIT 损坏致 HAP 无法产出，须 Mac/Win DevEco。

## 说明

- CL-001（P1/P2 + 六索引）、CL-002（工程骨架）、CL-003（HAR 实现）、CL-004（文档+提交）见 changed-log.md。
- 下一批次预计为用户真机验证后的 P5 迭代（CL-005）。
