# winvm-onetap（功能层 HAR）

WinVM Bridge **一键下载安装部署及验证**功能模块——自包含、仅依赖公开 HarmonyOS API，
可整包移植到铠大师 App（见仓库 `docs/guides/PORTING-GUIDE.md`）。

## 能力面（对应父项目 §4.2 三按钮契约）

| 契约 | 状态 | 入口 |
|------|------|------|
| ① 获取发布包（GitHub Release 下载 + sha256 + 解压 + 落 L3） | ✅ | `DeployEngine.fetchPackage()` |
| ② VM 环境准备 | ❌ 需 VM 通道（超纲，界面保留禁用态） | 父仓库 `tools/winvm-prepare.ps1` 单真相源 |
| ③ 复制安装指令（prompt 生成 + 剪贴板） | ✅ | `InstallPromptBuilder.build()` + `ClipboardService.copyText()` |
| （自动）状态读回（report 轮询） | ✅ | `DeployEngine.startReportPolling()` |
| 页面（表单 + 按钮 + 日志 + 状态面板） | ✅ | `DeployPage` |

## 目录

```
Index.ets                  # 唯一出口（export 页面/引擎/类型）
src/main/ets/
  ui/DeployPage.ets        # 部署助手页面（V1 状态管理）
  domain/DeployModels.ts   # 契约类型（无平台依赖）
  data/GitHubReleaseClient.ts  # latest 解析 + 流式下载
  data/Sha256Verifier.ts       # 分片 sha256 + 旁挂比对
  data/ZipExtractor.ts         # zlib 解压
  data/SharedDirStore.ts       # 权限 + L3 复制 + report 读回
  data/ClipboardService.ts     # 剪贴板写入
  data/DeployEngine.ts         # 编排（无 ArkUI 依赖）
  prompt/InstallPromptBuilder.ts # install prompt 模板（父文档 §5.2）
  util/Logger.ts               # hilog 封装
```

## 宿主接线（最小）

1. `oh-package.json5` 依赖：`"winvm_onetap": "file:../../feature/winvm-onetap"`；
   并在根 `build-profile.json5` 的 `modules` 登记本模块。
2. 宿主 `module.json5` 声明权限：
   `ohos.permission.INTERNET` + `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY`（user_grant，inuse）。
3. 页面：`import { DeployPage } from 'winvm_onetap'` 后直接渲染。

## 依赖的权限（宿主必须声明）

| 权限 | 用途 |
|------|------|
| `ohos.permission.INTERNET` | GitHub Release 下载/latest API |
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | `Download/winvm-release/` 落包与 report 副本读回（PC/2in1） |

## 设计约束

- 引擎层（data/）不 import 任何 ArkUI 组件，保证可无 UI 复用。
- 下载/校验/解压全程在 App 沙箱 staging 完成，最终真实目录复制到共享 Download
  （zlib 沙箱路径契约 + 父项目 G7 禁符号链接铁律）。
- report 读回路径 = `<Environment.getUserDownloadDir()>/winvm-release/deploy-report.json`
  （WB 旁写副本；规范路径 `.workbuddy/winvm/` 普通 App 不可达，见仓库 issues ID-2）。
