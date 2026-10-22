# changing-log — 进行中的变更记录

> 变更开始时登记；测试通过后迁移至 changed-log.md 并清空本文件。

- **CL-010（D10 硬错误修复 + 工作树落库 + 台账归档）**：10-22 轮编译器裁决出 D10（`InputType.NUMBER`→`InputType.Number`，ArkTS 规则码 10505001，阻断 CompileArkTS），Agent 已修于工作树；本次将三项未提交改进落库：
  - `DeployPage.ets` D10 修复（×2，高级设置端口输入框枚举形态）；
  - `build-profile.json5` 显式补 `targetSdkVersion: "26.0.0"`（消 hvigor 00303313/00303312 告警；正式机回写 6.1.0(23) 目标已在注释标注，D5 遗留）；
  - `InstallPromptBuilder.ts` ID-1 路径修正（`~/Downloads/` 复数 → 权威 `/storage/Users/currentUser/Download/` 单数，步骤 1 curl 目标与步骤 9 读回目录语义一致）。
  - 归档 Agent 台账 `.codeart-out/ISSUES.md` → `docs/04-verification/BUILD-DEFECTS-LEDGER-20261022.md`（ID-1/2 + D1-D10 处置链）。
  - 状态：10-22 15:41 功能完整 HAP（256,598 B，SDK 原生签名）基于本工作树构建，源码与产物一致；移交用户真机安装测试。

- **CL-009（高级设置可视化配置）**：用户裁定加「⚙ 高级设置」入口（P5 功能迭代）。
  - 弹窗形态选型：专家包 quick-rules 明确 CustomDialogController 自 API 12 不推荐（本项目 API 26）→ 采
    `bindSheet` 半模态（速查表有完整签名背书；openCustomDialog 无签名背书，按专家纪律不强行使用）。
  - 7 项配置：SSH 端口(22)/隧道本地端口(18443)/VM 部署目录(C:\WinVMBridge)/隧道后端(ssh2)/
    干跑模式(关, G12 警示)/部署宿主机侧(开)/部署 VM 侧(开)；Provider 留主表单防双真相源。
  - WinvmConfig 扩 6 字段 + domain 默认常量（权威源 = 父 delivery/env.example）；
    WINVM_SERVICE_PORT/TUNNEL_REMOTE_PORT 固定 18443 不暴露（vm-service.config.json 安全基线）。
  - InstallPromptBuilder §5.2 第 2 步参数化（原硬编码 22/18443/1/1/0）；防呆断言保持。
  - 静态自审：ArkTS 规则 + codelinter 5 处教训机检通过（textOverflow 对象包裹/Column 构造参数/
    Select .font({size})/$$ 绑定×7/@State 命名避链式属性/无 any 解构/括号配平）；**未执行编译/设备验证**。
  - 文档：USER-GUIDE §3 高级设置表 + S2-8 验证项；README 能力范围补一行；HAR Index.ets 出口补 7 常量。

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
