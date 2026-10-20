# TECHNICAL-SOLUTION — 技术方案设计

> DDD Phase 2.2 产物 · 版本 v1.0.0 · 2026-10-20

---

## 1. 技术选型

| 决策点 | 选型 | 理由 | 备选（否决不选的原因） |
|--------|------|------|------------------------|
| 语言/UI | ArkTS + ArkUI 声明式（V1 状态管理） | 项目要求 native + 极简；HAR 内嵌页面便于移植 | V2（与宿主范式耦合风险，且团队参考项目多为 V1） |
| 工程形态 | 多模块：AppScope + `product/phone`(HAP) + `feature/winvm-onetap`(**HAR**) | **解耦铁律**：功能全在 HAR，宿主零业务；HAR 可被铠大师整包移植 | 单 HAP（无法满足框架/功能解耦）；HSP（HAR 更轻、足以静态复用） |
| 下载 | `@ohos.net.http` `requestInStream` 流式 + fs 分片落盘 | 进度可控、内存安全；API 10+ 稳定 | @ohos.request agent（后台下载语义过重，进度回调到 UI 链路更长） |
| 哈希 | `@ohos.security.cryptoFramework` `createMd('SHA256')` 分段 update | 官方现行指南 API（API 12+），支持分片 | createHash（旧式，官方示例已迁移 createMd） |
| 解压 | `@ohos.zlib` `decompressFile` | 官方 zip 解压，Promise 化 | 三方 jszip（引入依赖违背「仅公开 API」） |
| 公共目录 | `@kit.CoreFileKit` `Environment.getUserDownloadDir()` + 权限申请 | PC/2in1 API 13+ 可用；路径权威不硬编码 | 硬编码 `/storage/Users/currentUser/Download`（脆） |
| 剪贴板 | `@kit.BasicServicesKit` `pasteboard` 写接口 | 写剪贴板无需权限 | — |
| Toast | `getUIContext().getPromptAction().showToast` | API 18 起官方推荐路径 | 静态 promptAction.showToast（已废弃） |
| SDK 基线 | compile/target `6.1.0(23)`，compatible `6.0.0(20)` | 设备 API 23；覆盖 6.0+ 设备 | compatible 12（版本串格式转换风险，且目标场景为 PC/NEXT） |
| 构建 | 标准 hvigor 多模块（root `appTasks` + HAP `hapTasks` + HAR `harpTasks`） | DevEco 原生 | — |

## 2. 总体架构（三层）

```
┌─────────────────────────────────────────────────────────────┐
│ 宿主框架层（框架，可替换）                                     │
│   AppScope/app.json5（bundleName/label/icon/version）        │
│   product/phone：EntryAbility（loadContent pages/Index）      │
│                 Index.ets（仅 import HAR 并渲染 DeployPage）  │
│                 module.json5（abilities + requestPermissions  │
│                   INTERNET / READ_WRITE_DOWNLOAD_DIRECTORY）  │
├─────────────────────────────────────────────────────────────┤
│ 功能层（feature/winvm-onetap HAR，自包含、可整体移植）          │
│   ui/       DeployPage.ets（表单+按钮+日志+状态面板）          │
│   domain/   DeployModels.ts（WinvmConfig/DeployReport/事件）   │
│   data/     GitHubReleaseClient / Sha256Verifier / ZipExtractor│
│             SharedDirStore / ClipboardService / DeployEngine  │
│   prompt/   InstallPromptBuilder（模板参数化）                 │
│   util/     Logger / HexUtil                                   │
├─────────────────────────────────────────────────────────────┤
│ 平台能力层（公开 HarmonyOS API，PROJECT-OVERVIEW F2-F8）       │
│   @ohos.net.http / @ohos.zlib / cryptoFramework / file.fs     │
│   file.environment / pasteboard / prompt / bundle             │
└─────────────────────────────────────────────────────────────┘
```

**解耦契约**：功能层只依赖平台能力层；宿主只做「挂载 + 权限声明 + 签名」。
移植到铠大师 = 拷 `feature/winvm-onetap/` → 加一行 `import { DeployPage } from 'winvm-onetap'`
→ 在宿主 module.json5 声明两条权限（详见 PORTING-GUIDE）。

## 3. 数据流（主链路）

```
[DeployPage] --config--> [DeployEngine]
  ①fetchPackage:
   GitHubReleaseClient.resolveLatest() --> tag
   GitHubReleaseClient.downloadToFile(zipURL, shaURL, staging/*.part) --> rename
   Sha256Verifier.verifyFile(zip, expectedHex) --> boolean
   ZipExtractor.extract(zip, staging/out)   (zlib.decompressFile)
   SharedDirStore.exportToDownloads(staging/out)  (真实目录复制)
  ②→InstallPromptBuilder.build(config, resolvedVersion) --> prompt 文本
   ClipboardService.copyText(prompt) --> toast
  ③轮询(10s) SharedDirStore.readReportMirror() --> DeployReport | null
   --> DeployPage 状态面板
```

## 4. 关键流程细节

1. **权限时序**：进入页面即检查权限；点①时 `requestPermissionsFromUser`（inuse）；
   授权后才取 `getUserDownloadDir()` 写包。权限被拒 → ①/一键按钮置灰 + 文案引导。
2. **staging 清理**：每次 ① 先清空 cacheDir/winvm-stage 再开始（避免陈旧文件被误用）。
3. **sha256 比对口径**：旁挂文件为 `<hex>  <zipname>` 一行；解析取行首 64 位 hex（忽略
   空格与文件名），大小写不敏感比对。
4. **复制语义**：递归遍历 staging/out，`mkdirSync` 建对应目录，逐文件
   `openSync(READ_ONLY)` → 目标 `openSync(CREATE|READ_WRITE|TRUNC)` → 1MB 分片 `readSync/writeSync`
   → `closeSync`；同名覆盖。
5. **prompt 旁写副本步骤**（demo 对父模板的唯一追加，见 ID-3）：
   步骤 9：WB 写完规范路径 report 后，`cp` 一份到 `Download/winvm-release/deploy-report.json`。
6. **轮询守卫**：每条轮询结果校验 `byteLength>0` + `JSON.parse` 成功 + `finishedAt` 非空，
   否则视为「写入窗口假空」（G10），继续等下一次。

## 5. 异常与降级

| 场景 | 行为 |
|------|------|
| latest 解析失败 | 中止①，日志与界面提示；版本框回填 `V1.4.0` 仅作示例不改写 URL 逻辑（仍要求用户确认版本） |
| 下载非 200 / 网络错误 | 错误码原文入日志；`.part` 清理；按钮恢复可重试 |
| sha256 不匹配 | 弃包（删 .part/坏 zip），提示重取 |
| 解压失败 | 报 zlib 错误码；检查 zip 完整性（重新下载） |
| 权限拒绝 | 按钮置灰 + 引导系统设置 |
| report 30min 未现 | 「尚未开始」提示 |
| report 解析失败 | 保持轮询，日志记原始错误 |
