# REQUIREMENT — 需求设计（功能/非功能）

> DDD Phase 2.1 产物 · 版本 v1.0.0 · 2026-10-20

---

## 1. 范围

一个鸿蒙 native demo app（工程名 `winvm-onetap-demo`）：极简宿主壳 + 一个自包含功能 HAR
（`winvm-onetap`）。功能 = WinVM Bridge 一键下载安装部署及验证（GitHub Release 取包 →
校验 → 解压 → 落共享目录 → 生成并复制 WorkBuddy install prompt → 读回部署验证报告）。

## 2. 功能需求

### FR-1 发布源与版本解析
- FR-1.1 默认发布源：GitHub Release 匿名资产（仓库 `athronix/workbuddy-virtual-win-plugin`）。
- FR-1.2 版本缺省 `latest`：调 `releases/latest` API 取 `tag_name` 代入；
  解析结果为空 → **中止并报「latest 解析失败」**，禁止空 tag 拼 URL。
- FR-1.3 版本可手动改写（文本输入）。
- FR-1.4 资产地址模板：
  `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/<V>/winvm-overall-<V>.zip`
  与旁挂 `.sha256`。

### FR-2 一键获取发布包（按钮①）
流水线（任一失败 → 停止 + 日志原文 + 可重试）：
1. 申请 `READ_WRITE_DOWNLOAD_DIRECTORY` 权限（拒绝则置灰并引导）。
2. 沙箱 staging 目录准备（cacheDir/winvm-stage）。
3. `requestInStream` 流式下载 zip 与 `.sha256` 到 staging（`.part` 临时名 → 完成 rename），
   实时进度（dataReceiveProgress）。
4. sha256 校验：分片读 zip 计算摘要，hex 化后与旁挂内容比对（容忍空白行/文件名差异，
   只取 64 位 hex）。不匹配 → 弃包。
5. `zlib.decompressFile` 解压到 staging/out（目录预创建）。
6. 真实目录复制 staging/out → `<getUserDownloadDir()>/winvm-release/`（递归、分片、
   覆盖同名；禁止符号链接）。
7. 日志输出每步结果与最终大小清单。

### FR-3 WorkBuddy install prompt 生成与复制（按钮③）
- FR-3.1 按父项目 `docs/deploy/通过铠大师app安装部署.md` §5.2 模板**逐字**生成，
  参数：`{VERSION}`（FR-1）、`{VM_HOST}`、`{VM_USER}`、`{WINVM_VM_PROVIDER}`；
  SSH 端口固定 22。
- FR-3.2 provider 取值集合：`workbuddy` / `workbuddy-deterministic`（后者零登录依赖，
  父文档 G4 建议首机先用它跑通全链）。
- FR-3.3 复制定律：一次点击 = 生成 → `pasteboard` 写入 → toast「已复制」。
- FR-3.4 表单校验：VM_HOST/VM_USER 非空；未填时按钮禁用并提示。

### FR-4 部署状态读回（自动轮询）
- FR-4.1 轮询对象：`<getUserDownloadDir()>/winvm-release/deploy-report.json`
  （WB 旁写副本，见 ID-3）。
- FR-4.2 轮询频率 10s；文件存在且 bytes>0 且 JSON 可解析且 `finishedAt` 存在 → 采信并展示：
  总体 `ok`、`phases` 耗时、`checks` 七项明细、`failures`。
- FR-4.3 超 30min 无文件 → 提示「WorkBuddy 尚未开始，请粘贴安装指令」。
- FR-4.4 采信后停止轮询；提供「刷新状态」手动重入。

### FR-5 一键部署（主按钮）
FR-2 →（界面引导用户切 WB 粘贴）→ FR-3（自动复制并提示）→ 启动 FR-4 轮询。
失败任一步骤 → 主流程停在该步，可单独重试。

### FR-6 VM 环境准备（按钮②，**仅界面对照**）
禁用态按钮 + 说明：需铠大师 VM 软件安装通道；VM 前置单真相源 =
父仓库 `tools/winvm-prepare.ps1`（八核心键 KV 契约，不 fork）。

### FR-7 WorkBuddy 提示（替代 G11 检测）
页面顶部固定提示条：「安装部署由 WorkBuddy 执行：请先在鸿蒙机安装并登录 WorkBuddy，
再粘贴本 App 生成的指令」。（普通 App 无跨应用安装查询权限，无法自动检测。）

## 3. 非功能需求

| ID | 需求 | 验证方式 |
|----|------|----------|
| NF-1 | 最小权限：INTERNET + READ_WRITE_DOWNLOAD_DIRECTORY | module.json5 静态核对 |
| NF-2 | 长任务不阻塞 UI：流式落盘 + 分片哈希/复制（1MB 块） | 代码走查 |
| NF-3 | ArkTS 静态约束：V1/V2 不混用、无 any、命名不与链式属性冲突、forEach 显式 key | quick-rules 自审清单 |
| NF-4 | 可移植：HAR 仅依赖公开 API；宿主只做挂载+权限 | 目录/依赖审查 |
| NF-5 | 日志可诊断：每步 hilog + 界面日志双通道 | 代码走查 |
| NF-6 | 新 API 版本基线 API 23；兼容 ≥ API 20 运行 | build-profile 核对 |

## 4. 需求追溯

| 需求 | 来源 |
|------|------|
| FR-1..FR-5 | TASK-UNDERSTANDING Q1/Q2/Q4/Q5 + 父文档 §4.2/§5.2 |
| FR-6/FR-7 | PROJECT-OVERVIEW §5 边界表 |
| NF-* | TASK-UNDERSTANDING §4 |
