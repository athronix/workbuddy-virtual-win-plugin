# 父项目问题与建议（issues-and-suggestions）

> 本文件记录 `deploy-demo-app` 开发过程中发现的 **workbuddy-virtual-win-plugin 父项目**
> 问题与改进建议。按用户要求：**不修改父项目任何文件**，仅文档化。
> 每条含：证据（可复核的源码/文档位置）、影响、建议（父项目侧 / demo 侧处置）、状态。

- 记录日期：2026-10-20
- 发现阶段：P1 调研（证据检索）+ P3/P4 实现与静态验证（D1 根因比对）
- 编号规则：`ID-n`，按严重度排序

---

## ID-1（中）部署文档落包目录 `~/Downloads/` 与本机权威路径 `Download/` 命名偏差

- **证据**：`docs/deploy/通过铠大师app安装部署.md` §5.2 步骤 1 写 `mkdir -p ~/Downloads/winvm-release && cd ~/Downloads/winvm-release`；
  本机实测 `Environment.getUserDownloadDir()` = `/storage/Users/currentUser/Download`（**单数**），
  `~/Downloads` 不存在。demo 侧同理：`SharedDirStore.downloadRoot()` 拼出
  `/storage/Users/currentUser/Download/winvm-release`。
- **影响**：
  1. 新机/新协作者按文档执行 `mkdir -p ~/Downloads/...` 会**静默创建一个多余目录**（命令不报错），
     落包位置与规范路径分叉，后续人工排查时容易在 Downloads/Download 两个目录间迷失；
  2. 与本规范路径联动的消费方（如本 demo 的 report 副本读回）路径不一致。
- **建议（父项目侧）**：§5.2 及一切出现 `~/Downloads` 处统一改为 `~/Download`
  （或直接用绝对路径 `/storage/Users/currentUser/Download/winvm-release`，与步骤 7/9 口径一致）；
  建议 grep 全仓 `Downloads` 一次性清理（注意排除真正的英文复数目录引用）。
- **建议（demo 侧）**：不改 prompt 模板原文（保持逐字复现原则），落包走权威 API；
  demo 会目双双轨，属可接受演示态。
- **状态**：待父项目确认

## ID-2（高）deploy-report 规范路径对普通 App 不可读，读回通道缺正式契约

- **证据**：§5.2 步骤 7 要求写 `/storage/Users/currentUser/.workbuddy/winvm/deploy-report.json`；
  鸿蒙安全模型下 `.workbuddy` 属 WorkBuddy App 数据目录，**普通应用（铠大师 app / 本 demo）无权限读取**
  （per-uid 隔离，调研结论 F3/F10）。即：报告写入了，但第三方 App 永远读不到。
- **影响**：部署状态读回（一键部署的最后一步「验证结果展示」）在第三方 App 侧**原理性不可达**；
  各接入方只能各自发明旁路（本 demo 用了 prompt 追加步骤 9 让 WorkBuddy 复制副本到共享目录），
  缺乏统一契约 → 接入质量参差。
- **建议（父项目侧）**：在 §5.2 prompt 模板中**正式纳入旁写副本步骤**：第 7 步同时把报告复制到
  `/storage/Users/currentUser/Download/winvm-release/deploy-report.json`（共享目录，普通 App 可读）。
  该步骤的 prompt 措辞可由父项目定稿，各接入方一律引用，不再各自追加。
- **建议（demo 侧）**：已在 prompt builder 追加步骤 9 临时实现（逐字注释声明为演示版追加）；
  父项目定稿后 demo 同步对齐。
- **状态**：待父项目确认；demo 已有临时通道

## ID-3（中）WorkBuddy 安装/登录态检测需要系统权限，普通 App 无法实现

- **证据**：demo 需求评估「注入前先检测 WorkBuddy 是否已安装」。
  鸿蒙侧跨应用查询需 `ohos.permission.LIST_BUNDLE_INFO`（或查询全部应用的隐私级权限），
  普通应用申请不到（调研结论 F10）；`bundleManager` 对第三方 bundle 的可见性受
  SEE_APP_ACROSS_USERS/交互可见性规则限制。
- **影响**：三方 App 无法在前置校验中给出「请先安装 WorkBuddy」的确定性提示，
  只能降级为文案引导（本 demo 即此方案）。
- **建议（铠大师 app 侧）**：若 app 为**系统预置/特权应用**，可申请上述权限实现精确检测；
  否则沿用文案引导 + 剪贴板粘贴模式。建议父文档明确该能力边界归属，避免各接入方重复调研。
- **状态**：demo 已按文案引导实现，待铠大师确认权限路径

## ID-4（低）旁挂 .sha256 的字节级格式仅存在于源码，缺对外文档契约

- **证据**：`delivery/pack-release.mjs:341-344` 注释 `sha256sum -c 兼容内容（一行 <hex>  <name>，两空格=二进制模式）`——
  权威格式只在源码注释里；部署文档只写了消费命令 `sha256sum -c`，未写明字节级格式。
- **影响**：外部集成方（本 demo 的 Sha256Verifier）只能读源码或按 `sha256sum -c` 惯例**推断**格式，
  推断口径误差曾导致解析 bug（静态验证 D1：按「拼接整行 hex 字符」解析会把文件名里的
  hex 字母计入，64+5=69 必然误报）。
- **建议（父项目侧）**：在部署文档 Q-2 处补一行格式契约：
  `winvm-overall-<V>.zip.sha256 内容 = "<64位小写hex>  <zipName>\n"（两空格，二进制模式，sha256sum -c 兼容）`，
  并把 `sha256SidecarContent()` 单测中的样例行贴入文档，供外部集成方零成本对齐。
- **状态**：demo 已按源码契约实现（D1 已修复）；建议父项目补文档

## ID-5（低）`~/Downloads` 同源问题：publish-release 产物 URL 形态无文档速查

- **证据**：Gate 策略（`scripts/GATE-POLICY.md:110`）称匿名下载 URL 形态为「新机分发链唯一入口，拼错=文档全链静默失效」，
  但该 URL 形态（`https://github.com/athronix/.../releases/download/<tag>/<zipName>`）无一处速查表，
  散落在 gate.mjs/publish-release 测试与 §5.2 示例中。
- **影响**：集成方拼 URL 需通读多处；演示 app 的 `GitHubReleaseClient.buildRelease()` 是从
  §5.2 示例反推的。
- **建议（父项目侧）**：部署文档加「分发资产速查表」：两个资产的 URL 模板 + 命名契约 + 匿名可达性说明。
- **状态**：demo 已实现并与源码比对一致；建议父项目补文档

---

## 汇总

| ID | 标题 | 严重度 | 状态 |
|---|---|---|---|
| ID-1 | `~/Downloads` vs `Download/` 命名偏差 | 中 | 待父项目确认 |
| ID-2 | report 规范路径普通 App 不可读，旁写副本未正式化 | 高 | 待父项目确认（demo 临时通道已实现） |
| ID-3 | WB 安装检测需系统权限 | 中 | demo 文案引导降级 |
| ID-4 | 旁挂 .sha256 字节级格式缺对外契约 | 低 | demo 已按源码契约修复 |
| ID-5 | 分发 URL 形态无速查表 | 低 | demo 已比对源码实现 |

**处理原则**（与用户约定一致）：demo 只消费契约、不改父项目；建议落地权在父项目维护方。
