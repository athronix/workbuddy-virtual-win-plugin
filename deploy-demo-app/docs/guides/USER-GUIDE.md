# 用户手册 — WinVM Bridge 部署助手（演示版）

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 设备 | HarmonyOS 6.1.0（API 23）PC / 2in1 | 版本基线 compile/target `6.1.0(23)`；compatible `6.0.0(20)` |
| WorkBuddy | 已安装并登录 | 安装与验证由 WorkBuddy 执行，本助手只负责取包/指令/读回 |
| 网络 | 可匿名访问 GitHub | 下载 `api.github.com` 与 `objects.githubusercontent.com` |
| 目标 VM | 可达（如 172.16.100.10） | port 22 可达；部署执行发生在 VM 侧 |
| 共享目录 | 授权下载目录访问 | 首次使用弹窗申请 `READ_WRITE_DOWNLOAD_DIRECTORY` |

## 2. 构建与安装（DevEco Studio）

1. DevEco Studio 打开 `deploy-demo-app/` 目录（工程根，含 `build-profile.json5`）。
2. 首次构建会提示配置签名：`File > Project Structure > Signing Configs` 登录华为账号
   自动生成（`build-profile.json5` 的 `signingConfigs` 为空数组属正常模板形态）。
3. 选择 `default` product，目标设备选本机（PC/2in1），Run。
4. 安装后桌面出现「WinVM 部署助手」图标。

> 本仓库交付状态：静态验证已通过（见 `docs/04-verification/`），
> **未含编译产物**；以上步骤由使用方在本地 DevEco 完成。

## 3. 界面与操作

页面四区块：表单（版本/VM 地址/VM 用户/Provider）+ 四个操作按钮 + 进度/日志 + 部署状态。

| 按钮 | 作用 | 前置条件 |
|---|---|---|
| ① 获取发布包 | 下载 zip + 旁挂 .sha256 → sha256 校验 → 解压 → 落到 `/storage/Users/currentUser/Download/winvm-release/` | VM 表单必填 |
| ② VM 环境准备 | 演示版不实现（需铠大师既有 VM 软件安装通道） | 禁用 |
| ③ 复制安装指令 | 生成 WorkBuddy 安装 prompt 并复制到剪贴板（可复用已下载的发布包版本，不重复解析） | VM 表单必填 |
| ④ 一键部署 | ①+③ 连续执行，成功后自动开始轮询部署报告 | VM 表单必填 |

表单字段：
- **版本**：`latest`（默认，走 GitHub releases/latest）或具体 tag（如 `V1.4.0`）；
  点「获取 latest」可把解析出的真实 tag 回填。
- **Provider**：`workbuddy`（需 VM 内 codebuddy CLI 登录态）或
  `workbuddy-deterministic`（首机零登录跑通全链，父文档 G4 建议）。
- SSH 端口固定 22（prompt 内写死，与父文档一致）。

**一键部署后的完整链路**：本助手落包 + 复制 prompt → 用户打开 WorkBuddy
**新建任务、粘贴 prompt**（prompt 内含全部部署指令，WorkBuddy 全程自动执行）→
WorkBuddy 按 prompt 步骤 9 把部署报告副本写入共享目录 → 助手每 10 秒轮询读回，
采信即停（30 分钟超时）。

## 4. 真机验证清单（S2/S3）

> 对应 `docs/02-design/TEST-PLAN.md` S2/S3。逐项打勾，异常记录到日志卡。

### S2 单机功能（无需 VM）

- [ ] S2-1 首次启动：页面渲染正常，权限弹窗出现；允许后按钮①③④可点
- [ ] S2-2 拒绝权限：按钮①给出 E4001 提示并引导去系统设置（设置 > 应用 > 本应用 > 权限）
- [ ] S2-3 ① 获取发布包：版本填 `V1.4.0`（或 latest），进度条走到 100%，
      日志出现 `sha256 校验通过`、`解压完成: overall/ 就绪`、`已落包 N 个文件`
- [ ] S2-4 共享目录核对：`文件管理 > Download/winvm-release/` 下存在 `overall/`、`bootstrap.mjs` 等
- [ ] S2-5 ③ 复制安装指令：toast「安装指令已复制」；粘贴到记事本可见完整 9 步 prompt，
      无 `{VERSION}` 等占位符残留，VM 地址/用户/Provider 已代入
- [ ] S2-6 手动点「刷新状态」：未部署时 toast「尚未读到部署报告」
- [ ] S2-7 杀进程重进：日志/状态为空属正常（演示版无持久化）

### S3 端到端（需 VM + WorkBuddy）

- [ ] S3-1 表单填真实 VM IP/用户，Provider 选 `workbuddy-deterministic`（首机）
- [ ] S3-2 ④ 一键部署 → toast「已复制安装指令」
- [ ] S3-3 打开 WorkBuddy 新建任务**粘贴**，观察其自动执行 7 相位
      （HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH）与 7 项验证矩阵
- [ ] S3-4 WorkBuddy 完成后，助手自动显示「部署验证成功」+ 版本/完成时间/检查项明细
      （轮询最长 30 分钟；未超时前勿杀助手）
- [ ] S3-5 失败路径抽查：若某相位失败，助手显示「部署验证失败」及 failures 明细
- [ ] S3-6 卸载重来：卸载本助手 → 重装 → ①③④ 复跑（幂等验证）

## 5. 常见问题

| 现象 | 原因 | 处置 |
|---|---|---|
| E1001 latest 解析失败 | 网络不可达 GitHub API / 代理问题 | 检查网络，或手填版本号 |
| E2001 sha256 不匹配 | 下载损坏或 Release 资产被替换 | 重新①取包；持续失败上报父项目 |
| E3001 解压结果缺少 overall/ 目录 | Release 包结构与契约不符 | 上报父项目（包内根应为 overall/） |
| E4001 未获得共享下载目录权限 | 用户拒绝授权 | 系统设置中允许后重试 |
| 「获取 latest」按钮无响应 | busyFlag 防抖中 | 等当前操作完成 |
| 轮询 30 分钟超时 | 未在 WorkBuddy 粘贴 prompt，或 WorkBuddy 侧失败 | 重试④并确认粘贴执行 |
| 按钮②点击提示不实现 | 设计边界（issues ID-3/移植边界） | 由铠大师通道执行 winvm-prepare.ps1 |

## 6. 目录约定速查

- 沙箱暂存：`cacheDir/winvm-stage/`（下载/校验/解压，用完重建）
- 共享落包：`/storage/Users/currentUser/Download/winvm-release/overall/`
- 报告副本：`/storage/Users/currentUser/Download/winvm-release/deploy-report.json`
  （WorkBuddy 按 prompt 步骤 9 写入）
- WB 私有规范路径（普通 App 不可读）：`/storage/Users/currentUser/.workbuddy/winvm/deploy-report.json`
