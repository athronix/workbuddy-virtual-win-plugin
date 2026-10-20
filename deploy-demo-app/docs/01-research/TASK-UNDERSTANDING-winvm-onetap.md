# TASK-UNDERSTANDING — 任务内容理解

> DDD Phase 1 Step 1.4 调研产物 · 版本 v1.0.0 · 2026-10-20
> 任务：为 workbuddy-virtual-win-plugin 开发鸿蒙 demo app（一键下载安装部署及验证）

---

## 1. 用户原始需求（逐条编号还原）

1. 项目归属：`workbuddy-virtual-win-plugin` 项目的子项目，仓库
   `/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`（**只读**）。
2. 目标：开发一个**鸿蒙 native app**（ArkTS 编写），演示并实现父项目在鸿蒙 App 中的
   **一键部署安装功能**；实现逻辑可参考父项目 `docs/deploy/*.md` 及其实现。
3. 用途：验证一键安装逻辑，为**铠大师 app 团队**移植提供参考与实现逻辑。
4. 形态：**极简**鸿蒙 native app，仅作演示和功能测试用。
5. 功能面：「workbuddy-virtual-win-plugin 一键下载安装部署及验证」功能，
   **为父项目在真机环境下的下载安装部署及验证功能的真实实现**（非 mock）；
   包括**生成 WorkBuddy prompt 及 copy 按钮**。
6. 解耦：demo app 的**框架**与**一键部署功能**完全解耦，便于发给铠大师团队移植。
7. 开发目录：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app`。
8. 流程规范：遵从 `ddd-skill` 与 `plan-first` skill 指引。
9. 边界铁律：**不得改动 `./deploy-demo-app` 之外的任何父项目目录/文件**；
   发现的父项目问题写进 `./deploy-demo-app/docs/pre-requirements/issues-and-suggestions.md`，
   由父项目团队后续参考开发。

## 2. 关键语义澄清（需求解读中的判定）

| # | 问题 | 判定 | 理由 |
|---|------|------|------|
| Q1 | 「一键下载安装部署及验证」= demo 自己完成部署？ | **否**。demo 完成「下载+校验+解压+落包+prompt 生成+报告读回」；真正的安装部署由 WorkBuddy 按 prompt 执行 | 部署执行体在 WB 沙箱（L2），普通 App 无 node/electron/SSH 工具链；这是父项目既定架构（§3 三方职责矩阵） |
| Q2 | 「真实实现」= 非 mock 到什么程度？ | 网络下载、sha256 校验、zlib 解压、L3 复制、剪贴板、报告轮询全部真调真跑，参数（IP/用户/provider/版本）真实生效 | 用户明确「真机环境下的真实实现」 |
| Q3 | demo 要不要做 VM 环境准备（按钮②）？ | **不做功能，留界面对照**：禁用态按钮 + 说明文案，指向父项目单真相源 `tools/winvm-prepare.ps1` | 需铠大师 VM 通道（普通 App 无）；保留契约展示便于移植方理解三按钮全貌 |
| Q4 | prompt 版本 {VERSION} 怎么定？ | 缺省 = **latest**：调 GitHub API 解析 latest tag 代入；允许手改；解析失败必须停下报错 | 父文档 §5.2 Q-5 口径 |
| Q5 | deploy-report 怎么读回？ | prompt 追加「旁写副本」步骤：WB 写规范路径后，再复制一份到 `Download/winvm-release/deploy-report.json`，demo 轮询该副本 | 规范路径 `.workbuddy/winvm/` 普通 App 权限不可达（F2 只覆盖 Download）；差异登记 issues 建议父项目正式化 |
| Q6 | 下载/解压中间产物放哪？ | 全程在 **App 沙箱**（cacheDir）完成，最终产物真实目录复制到共享 Download | F4：zlib 要求沙箱路径；G7：hmdfs 真实复制 |
| Q7 | 最低 API 基线？ | compatibleSdkVersion `6.0.0(20)`，compile/target `6.1.0(23)`（设备 API 23） | F9；所有用到的 API ≤ API 13 即齐备（留版本余量） |

## 3. 验收标准（Definition of Done）

- [ ] A1 工程可在 DevEco Studio 6.1.0（API 23 SDK）打开、同步、构建 HAP 不报结构性错误。
- [ ] A2 「① 获取发布包」：匿名下载 `winvm-overall-<V>.zip`（V=latest 解析所得）→ 旁挂 `.sha256` 校验
      → 解压 → 复制到 `Download/winvm-release/`，全程有进度与日志，失败有明确错误呈现。
- [ ] A3 「③ 复制安装指令」：按父项目 §5.2 模板参数化生成 prompt（VERSION/VM_HOST/VM_USER/
      provider 真实代入），写入系统剪贴板，toast 反馈。
- [ ] A4 部署状态读回：轮询 `Download/winvm-release/deploy-report.json`，解析 `ok/phases/checks/failures`
      并展示；超时有「尚未开始」提示。
- [ ] A5 「一键部署」：一次点击串起 A2→A3→启动轮询，符合「≤3 次点击 + 一次粘贴」UX 目标。
- [ ] A6 解耦：功能集中于 `feature/winvm-onetap` HAR 模块，仅依赖公开 HarmonyOS API；
      宿主壳（AppScope + product/phone）除路由挂载与权限声明外无业务代码。
- [ ] A7 文档：四件套齐备——issues-and-suggestions.md（父项目问题登记）、
      移植指南（PORTING-GUIDE）、用户手册、DDD 六索引。
- [ ] A8 边界：除 deploy-demo-app 外零改动（git status 证明）。

## 4. 非功能需求

- N1 最小权限：仅 INTERNET + READ_WRITE_DOWNLOAD_DIRECTORY（+ 运行期 requestPermissionsFromUser）。
- N2 全 ASCII 路径（G8：防 ssh/PS 码页腐化）；App 内用户可见文案中文。
- N3 长任务不卡 UI：下载流式落盘、分片哈希、分片复制（>1MB 分块）。
- N4 无 V1/V2 混用；无 `any` 宽松类型；ArkTS 静态约束零违规（quick-rules 自审项）。
- N5 真机目标：HarmonyOS PC / 2in1（API 23）；`deviceTypes` 相应声明。

## 5. 风险与对策（继承父文档 G 系列 + demo 特有）

| ID | 风险 | 对策 |
|----|------|------|
| R1 | 下载中途失败/超时 | `.part` 临时文件 + 完成后 rename；readTimeout 60s；失败即清理 |
| R2 | sha256 不匹配 | 弃包重取（按钮可重试），错误原文入日志 |
| R3 | zlib 只认沙箱路径 | 全程沙箱 staging，最终复制到 L3 |
| R4 | Download 权限被拒 | 前置 requestPermissionsFromUser；拒绝时按钮置灰 + 引导去设置 |
| R5 | report 副本写入窗口假空 | 读回时校验 JSON 可解析 + `finishedAt` 存在 + bytes>0 才采信 |
| R6 | latest API 解析失败 | 必须停下报「latest 解析失败」，禁止空 tag 拼 URL（Q-5） |
| R7 | 铠大师误把 demo 当成品 | README/PORTING-GUIDE 明示 demo 边界与移植必读项 |
