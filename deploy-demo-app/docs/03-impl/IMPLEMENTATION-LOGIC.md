# 实现逻辑说明（IMPLEMENTATION-LOGIC）

> 对应 `docs/02-design/` 各设计文档的落地口径。记录「为什么这样实现」而非「代码是什么」。
> 与静态验证报告（`docs/04-verification/`）互为补充：那边讲规则，这边讲决策。

## 1. 总体数据流

```
DeployPage(V1 UI, @State 展平成扁平字段)
   │  ①③④ 按钮 → 校验表单 → buildConfig()
   ▼
DeployEngine(编排，零 ArkUI import；UI 侧仅做人 : 回调 onLog/onStage/onProgress/onReport)
   │
   ├─ resolveRelease()   SharedDirStore.ensureDownloadPermission() → GitHubReleaseClient.resolveLatest()
   ├─ fetchPackage()     download(.part→rename, requestInStream 流式)
   │                     → Sha256Verifier.verify()  → ZipExtractor.extract()  → SharedDirStore.exportTree()
   ├─ copyPrompt()       InstallPromptBuilder.build() → ClipboardService.copyText()
   └─ polling            SharedDirStore.readReportMirror() ×10s → onReport → 采信即停
```

设计要点：**UI 不与 data 服务直接对话**，全部经 DeployEngine 中转；引擎回调是 UI 的
唯一刷新来源。移植时 UI 可整体替换（重画或用 V2），引擎零改动。

## 2. 取包链（FR-2）关键决策

| 决策 | 理由 |
|---|---|
| staging = `cacheDir/winvm-stage`，全链在沙箱 | zlib 契约（F4）：`decompressFile` 的 inFile 必须是沙箱路径；同时避免半成品落共享目录 |
| 下载用 `requestInStream` + `dataReceive` 流式写盘，`.part` 后 rename | Release 资产仅 ~2.6MB 但全量缓冲进内存再写有泄漏/中断风险；`.part→rename` 保证共享/staging 里 never 出现半截文件 |
| sha256 分片 1MB 读 + `md.update` | zip 2.6MB 一次读完也可，分片口径与 exportTree 一致，大包不劣化 |
| 旁挂校验「空白分隔首 token」 | 父契约 `sha256SidecarContent` = `<hex>  <name>`；首 token 之外的字符（文件名）不得参与 hex 判定（静态验证 D1 的血泪修复） |
| 解压后必须存在 `outDir/overall/` | 包内根 = overall/（pack-release 契约），缺失=包被换/结构变更，断 fail-loud（E3001） |
| exportTree 真实 copy 每文件，1MB 分片，同名覆盖 | 父项目铁律 G7：hmdfs 禁符号链接，且目录必须是真目录交付给后续 bash 脚本 |
| exportTree 递归同步 + 计数但函数 async | 保持接口 Promise 化统一；返回值文件数进日志，便于 S2-4 人工核对 |

## 3. Prompt 生成（FR-3）关键决策

- **逐字复现 + 参数代入**：父文档 §5.2 步骤 1-8 原文照录，仅替换
  `{VERSION}/{VM_HOST}/{VM_USER}/{WINVM_VM_PROVIDER}`；`\`bash <script>\` 的转义反引号保留。
  任何措辞「优化」都会造成与父模板漂移，一律不做（issues ID-1/ID-2 因此登记而非私改）。
- **追加步骤 9（演示版旁写副本）**：父模板步骤 7 只写 `.workbuddy/winvm/`
  （WB 私有，普通 App 不可读）。为使 report 读回闭环，追加步骤 9 让 WorkBuddy
  另复制一份到共享目录。源码注释显式标注「演示版追加，正式版应由父项目模板纳入」。
- **assertNoPlaceholder 防呆**：4 个 token 逐一 indexOf 断言，防未来改模板漏替换。

## 4. Report 读回（FR-4）关键决策

- **三重采信门**（防写入窗口假空）：字节数 > 0 → JSON.parse 成功 → `finishedAt` 非空。
  任一不过即视为「未就绪」，继续轮询。
- **宽松解析 + 逐字段收窄**：`ReportRaw` 全 optional，逐字段 `?? 默认`；
  `ok`/`pass` 用 `=== true` 严格化（防字符串 "false" 之类噪声）。
- **轮询节奏**：10s × 180 轮 = 30min；采信或超时都 `clearInterval` 并回写 stage。
- **同步读**：`readReportMirror()` 同步（readTextSync），手动「刷新状态」零延迟。

## 5. 状态机与 UI 绑定

- UI 侧把引擎回调全部**展平**为 @State 标量（stageLevel/stageText/progressXxx/...），
  不持有对象引用 —— 规避链式属性与 @State 同名的 ArkTS 限制，也让 setStage 单点维护。
- `busyFlag` 与 `stageKind` 双源：按钮 `enabled(!busyFlag)` 统一防抖；
  DOWNLOADING 显式置 busy + progressVisible，DONE/FAILED/IDLE 复位。
- 日志环形保留 50 条（LOG_KEEP_MAX），seq 单调递增同时作 ForEach key。
- 页面销毁 `aboutToDisappear` → `stopReportPolling()`，防定时器泄漏。

## 6. ArkTS 约束的落地方式

| 约束 | 落地 |
|---|---|
| 禁 `@ohos.*` | 全部 `@kit.*`：NetworkKit / BasicServicesKit / CoreFileKit / CryptoArchitectureKit / AbilityKit / PerformanceAnalysisKit / ArkUI |
| 对象字面量不作类型 | 回调用 `DeployEngineCallbacks` 具名接口；Report 宽松类型用具名 `ReportRaw` |
| JSON.parse 收窄 | 单一 `as` 跳转到具名 Raw 类型，再逐字段收窄 |
| ForEach key | `item.seq.toString()` / `item.id` |
| V1 规范 | 全 @Component/@State/@Builder；模块级纯函数（stageDot/stageColor/...）不放进 struct |
| UIContext | `getUIContext().getPromptAction().showToast`；`getHostContext()` 判空后 `as common.UIAbilityContext` |
| 异步签名 | 所有 async 显式 `Promise<T>`；Promise 化 zlib callback 时 reject 收窄 `BusinessError` |

## 7. 已知边界（设计内不解决）

- ② VM 环境准备：需铠大师既有 VM 软件安装通道，普通 App 不可为（演示版禁用 + 引导文案）。
- WorkBuddy 安装/登录检测：跨应用查询需系统权限（issues ID-3），降级为文案引导。
- `~/Downloads` 命名偏差：prompt 保持父模板原文（issues ID-1），demo 落包走权威 API 不受影响。
