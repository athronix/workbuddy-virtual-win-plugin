# deploy-demo-app — WinVM Bridge 鸿蒙一键部署演示 App

`workbuddy-virtual-win-plugin` 父项目的**鸿蒙 native demo 子项目**：极简 ArkTS 工程，
用于演示和真机功能测试「WorkBuddy 一键下载安装部署 WinVM Bridge 及验证」链路。

> 本工程只位于 `deploy-demo-app/` 内，**不改动父项目任何文件**；
> 父项目问题与建议见 `docs/pre-requirements/issues-and-suggestions.md`。

## 能力范围（演示版）

- ✅ ① 从 GitHub Release 匿名下载发布包（zip + 旁挂 .sha256），sha256 整包校验，解压，落共享下载目录
- ✅ ③ 生成 WorkBuddy 安装 prompt（逐字遵循父项目 §5.2 模板 + 参数代入）并复制到剪贴板
- ✅ ④ 一键部署 = ① + ③，并自动轮询读回部署验证报告（10s 间隔/30min 超时）
- ✅ ⚙ 高级设置：SSH 端口 / 隧道本地端口 / VM 部署目录 / 隧道后端 / 干跑模式 / 双端部署开关
  （半模态面板，默认值对齐父仓库 `delivery/env.example`，保存时校验）
- ❌ ② VM 环境准备：需铠大师既有 VM 软件安装通道，演示版不实现（UI 内说明）
- ❌ WorkBuddy 安装检测：跨应用查询需系统权限，降级为文案引导

**分工定位**：安装与验证由鸿蒙机上的 WorkBuddy 执行（粘贴本助手生成的 prompt 即可）；
本助手负责取包/指令/状态读回。框架壳（HAP）与功能层（HAR）**完全解耦**，
`feature/winvm-onetap/` 整目录即移植单元 —— 铠大师 app 移植见 `docs/guides/PORTING-GUIDE.md`。

## 工程结构

```
AppScope/                  bundleName/图标/文案（demo 专属，移植丢弃）
product/phone/             框架壳：EntryAbility + Index 挂载页 + 权限声明（移植替换）
feature/winvm-onetap/      功能 HAR（移植单元）：
  ├── Index.ets            唯一出口
  ├── src/main/ets/domain/     契约类型（零平台 import）
  ├── src/main/ets/data/       取包/校验/解压/共享目录/剪贴板 + DeployEngine 编排（无 ArkUI import）
  ├── src/main/ets/prompt/     install prompt 生成器
  ├── src/main/ets/ui/         V1 部署页面（可整体替换）
  └── src/main/ets/util/       hilog 封装
docs/                      调研/设计/实现逻辑/验证/指南/pre-requirements 全套 DDD 文档
.dev/                      六索引（状态/文件/日志）
tools/make_icon.py         图标生成（zlib 手工编码 PNG，无 PIL 环境）
```

## 快速开始

1. DevEco Studio（API 23 基线）打开本目录，配置签名后 Run 到 PC/2in1 设备；
2. 首次允许「下载目录」权限；
3. 填 VM 地址/用户 → ④ 一键部署 → 打开 WorkBuddy 新建任务粘贴；
4. 等待轮询显示「部署验证成功」。

详细操作与真机验证清单见 **[docs/guides/USER-GUIDE.md](docs/guides/USER-GUIDE.md)**。

## 文档索引

| 阶段 | 文档 |
|---|---|
| 调研 | `docs/01-research/PROJECT-OVERVIEW.md`、`TASK-UNDERSTANDING-winvm-onetap.md`、`CHANGE-OBJECTIVE-demo-app.md` |
| 设计 | `docs/02-design/REQUIREMENT`、`TECHNICAL-SOLUTION`、`ARCHITECTURE-system`、`DESIGN-deploy-module`、`INTERFACE-DEFINITION`、`TEST-PLAN` |
| 实现 | `docs/03-impl/IMPLEMENTATION-LOGIC.md` |
| 验证 | `docs/04-verification/TEST-REPORT-static-review.md`（静态已过：1 严重缺陷修复；编译/真机待使用方） |
| 指南 | `docs/guides/USER-GUIDE.md`、`docs/guides/PORTING-GUIDE.md` |
| 父项目问题 | `docs/pre-requirements/issues-and-suggestions.md`（ID-1..5） |

## 契约依赖

prompt 模板 / zip+sha256 命名与 URL / deploy-report JSON 均以父项目
`docs/deploy/` 与 `delivery/pack-release.mjs` 为真相源；父项目 REL 迭代时按
移植指南 §7 联动核对。
