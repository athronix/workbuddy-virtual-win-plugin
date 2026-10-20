# ARCHITECTURE — 系统层/模块层架构设计

> DDD Phase 2.2 Step 2.2.2/2.2.3 产物 · 版本 v1.0.0 · 2026-10-20

---

## 1. 工程目录结构（系统层）

```
deploy-demo-app/                          ← 子项目根（本 demo 仓库边界）
├── AppScope/
│   ├── app.json5                         # bundleName/vendor/versionCode/versionName/icon/label
│   └── resources/
│       ├── base/element/string.json      # app_name
│       └── base/profile/configuration.json
├── product/phone/                        # HAP（宿主框架层，仅挂载）
│   └── src/main/
│       ├── module.json5                  # entry/EntryAbility + requestPermissions(2条)
│       ├── resources/
│       │   ├── base/element/string.json  # 模块级字符串
│       │   ├── base/profile/main_pages.json  # "pages/Index"
│       │   └── base/media/               # app_icon
│       └── ets/
│           ├── entryability/EntryAbility.ets
│           └── pages/Index.ets           # import { DeployPage } from 'winvm_onetap'
├── feature/winvm-onetap/                 # HAR（功能层，自包含可移植）
│   ├── Index.ets                         # 唯一出口：导出页面/引擎/类型
│   ├── README.md                         # 模块说明（移植方第一手资料）
│   ├── oh-package.json5                  # name: winvm_onetap, main: Index.ets
│   ├── build-profile.json5
│   ├── hvigorfile.ts                     # export { harpTasks } from '@ohos/hvigor'
│   └── src/main/
│       ├── module.json5                  # type: har, deviceTypes
│       ├── resources/base/element/string.json
│       └── ets/
│           ├── domain/DeployModels.ts
│           ├── data/GitHubReleaseClient.ts
│           ├── data/Sha256Verifier.ts
│           ├── data/ZipExtractor.ts
│           ├── data/SharedDirStore.ts
│           ├── data/ClipboardService.ts
│           ├── data/DeployEngine.ts
│           ├── prompt/InstallPromptBuilder.ts
│           ├── ui/DeployPage.ets
│           └── util/Logger.ts
├── build-profile.json5                   # app{products{sdk versions}} + modules[phone,winvm_onetap]
├── oh-package.json5                      # 根（name/version）
├── hvigorfile.ts                         # export { appTasks } from '@ohos/hvigor'
├── code-linter.json5
├── docs/  .dev/  README.md               # DDD 文档体系与索引
```

## 2. 模块职责（模块层）

| 模块 | 职责 | 禁止事项 |
|------|------|----------|
| `domain/DeployModels` | 纯类型与契约：`WinvmConfig`、`ResolvedRelease`、`DeployReport`、`ReportCheck`、`FetchStage` 枚举、`LogEntry` | 不得含任何平台 import |
| `data/GitHubReleaseClient` | latest tag 解析；资产下载（requestInStream → .part → rename）；HTTP 生命周期管理 | 不做校验/解压 |
| `data/Sha256Verifier` | 文件分片 sha256；hex 化；旁挂文件解析与比对 | 不读网络 |
| `data/ZipExtractor` | 调 zlib.decompressFile；输出目录预创建 | 不复制到 L3 |
| `data/SharedDirStore` |权限申请；getUserDownloadDir；staging 管理；递归导出；report 镜像读回 | 不做业务编排 |
| `data/ClipboardService` | prompt 文本入剪贴板 | 不生成文本 |
| `prompt/InstallPromptBuilder` | §5.2 模板参数化生成 | 不触碰 UI |
| `data/DeployEngine` | 编排 FR-2/FR-4；对外暴露回调（onLog/onStage/onProgress/onReport/onDone） | 不含 ArkUI import（无 UI 依赖，保证可移植） |
| `ui/DeployPage` | 表单、三按钮+一键、日志列表、状态面板 | 不含网络/文件细节（全部委托 data 层） |
| `util/Logger` | hilog 封装（统一 TAG/DOMAIN） | — |

## 3. 状态管理设计（V1，禁混 V2）

- `DeployPage` 内 `@State`：表单字段（vmHost/vmUser/provider/version）、
  `isBusy`、`fetchStage`、`progressValue`、日志数组 `logLines: string[]`、
  报告视图模型 `reportView`。
- 引擎回调 → 页面：回调内一律**新数组/新对象重新赋值**（`this.logLines = [...this.logLines, s]`），
  不原地 push（V1 引用检测限制）。
- 引擎无状态持有页面引用（单向回调，防泄漏）。

## 4. 与外部系统的协作视图

```
demo App ──HTTPS──▶ GitHub Release（匿名资产 + latest API）
demo App ──fs─────▶ Download/winvm-release/（L3，落包 + report 副本读回）
用户 ──粘贴──▶ WorkBuddy 沙箱 ──prompt 驱动──▶ VM（SSH/七相位部署）
WorkBuddy ──cp──▶ Download/winvm-release/deploy-report.json（旁写副本，ID-3）
铠大师（移植方）──拷走 HAR──▶ 其宿主 App 声明 2 权限 + 挂载页面
```
