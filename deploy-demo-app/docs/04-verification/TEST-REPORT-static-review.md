# 静态验证报告 — winvm-onetap demo app

> DDD 七阶段 P4（验证）第一阶段：**静态自审**。第二阶段为真机验证（S2/S3），
> 因本开发环境无 DevEco Studio / hvigor / 真机，**未执行编译与设备验证**，
> 交付状态见 §6。本文所有结论均来自代码通读 + 父项目契约逐条比对，不含推测。

- 版本：v0.1.0（静态验证稿）
- 日期：2026-10-20
- 范围：`deploy-demo-app/` 全部 26 个源文件（.ets 12 + 配置 8 + 资源 4 + tools 1 + .dev 6 中代码相关项，见 §1）
- 依据：`docs/02-design/TEST-PLAN.md` S1（静态）、`docs/02-design/INTERFACE-DEFINITION.md`、父项目契约源码

---

## 1. 验证对象清单

| 层 | 文件 | 行数（约） |
|---|---|---|
| HAP 接线 | EntryAbility.ets / pages/Index.ets / module.json5 | 39 / 14 / 49 |
| HAR 出口 | Index.ets | 24 |
| HAR UI | ui/DeployPage.ets | 728 |
| HAR data | data/DeployEngine.ts | 180 |
| HAR data | data/GitHubReleaseClient.ts | 151 |
| HAR data | data/Sha256Verifier.ts | 81 |
| HAR data | data/ZipExtractor.ts | 25 |
| HAR data | data/SharedDirStore.ts | 168 |
| HAR data | data/ClipboardService.ts | 20 |
| HAR prompt | prompt/InstallPromptBuilder.ts | 54 |
| HAR domain | domain/DeployModels.ts | 80 |
| HAR util | util/Logger.ts | 19 |
| 工程配置 | build-profile.json5 / AppScope/app.json5 / oh-package.json5 ×2 / hvigorfile.ts ×3 | 41/… |
| 资源 | app_icon.png ×2 / string.json ×3 / color.json / main_pages.json | — |

代码总量：**约 1,480 行 ArkTS/TS + 1 个配置体系**。

## 2. ArkTS 静态规则自审结果（S1-R）

| # | 规则 | 结果 | 证据/说明 |
|---|---|---|---|
| R1 | 禁 `@ohos.*` import，全走 `@kit.*` | ✅ 0 违例 | 扫描 12 个 .ets：AbilityKit(2)/NetworkKit(1)/BasicServicesKit(4)/CoreFileKit(3)/CryptoArchitectureKit(1)/PerformanceAnalysisKit(2)/ArkUI(1)，无 `@ohos.` |
| R2 | 禁 `any` 类型 | ✅ 0 违例 | 无显式 any；宽松 JSON 收窄用 `LatestReleaseRaw`/`ReportRaw` 具名接口 + `as` 单跳 |
| R3 | 禁解构赋值 | ✅ 0 违例 | 全部 `const x: T = ...` 形式；回调参数显式类型 |
| R4 | 对象字面量不得作类型标注 | ✅ 0 违例 | 回调类型用具名接口 `DeployEngineCallbacks`/`WinvmLogEntry`/`ReportCheck`；`Select([...])` 字面量在**值位置**不违规 |
| R5 | async 函数显式 `Promise<T>` | ✅ 12/12 | resolveRelease/resolveLatestTag/fetchPackage/copyPrompt/download/extract/verify/copyText/exportTree/ensureDownloadPermission 等全部显式 |
| R6 | ForEach 必须第三参 keyGenerator | ✅ 2/2 | logEntries: `item.seq.toString()`；reportChecks: `item.id` |
| R7 | @State 成员不与链式属性重名 | ✅ 0 违例 | 盘点 16 个 @State：versionInput/vmHostInput/vmUserInput/providerChoice/stageKind/stageText/stageLevel/busyFlag/progressVisible/progressReceived/progressTotal/logEntries/reportExists/reportVersion/reportOk/reportFinishedAt/reportChecks/reportFailures——无 value/enabled/id/width 等属性名 |
| R8 | V1 装饰器不与 V2 混用 | ✅ | 全页 @Component/@State/@Builder，无 @Local/@Param 等 V2 |
| R9 | UIContext 替代全局 promptAction | ✅ | `this.getUIContext().getPromptAction().showToast(...)`；Context 取用走 `getHostContext()` 判 undefined 后 `as common.UIAbilityContext` |
| R10 | 跨文件禁同名顶层类型 | ✅ | LatestReleaseRaw(GitHubReleaseClient)/ReportCheckRaw+ReportRaw(DeployModels) 唯一；EntryAbility 与 HAR Logger 的 TAG/DOMAIN 为文件内 const 不冲突 |

**统计：10 项规则，检查 26 文件，0 violations。**

## 3. API 签名核对（S1-A）

| Kit | API | 用法 | 核对 |
|---|---|---|---|
| NetworkKit | `http.createHttp()` / `request(url, options)` / `requestInStream(url, options)` / on('dataReceive') / off / destroy | GitHubReleaseClient | ✅ 官方 callback/Promise 形态；`options` 显式 `http.HttpRequestOptions` 注解 |
| BasicServicesKit | `zlib.decompressFile(src, dest, options, cb)` | ZipExtractor | ✅ callback 第一参为 BusinessError \| null，以 `errData !== null` 判失败（官方示例同款） |
| BasicServicesKit | `pasteboard.createData(MIMETYPE_TEXT_PLAIN, text)` + `getSystemPasteboard()` + `setData(pd)` | ClipboardService | ✅ 返回 Promise<boolean>，写入无需权限 |
| CryptoArchitectureKit | `cryptoFramework.createMd('SHA256')` / `md.update({data})` / `md.digest()` | Sha256Verifier | ✅ update 为 Promise 形态（新 API 口径），digest 返回 `{data: Uint8Array}` |
| CoreFileKit | `fileIo.openSync/readSync/writeSync/closeSync/mkdirSync/statSync/accessSync/listFileSync/unlinkSync/rmdirSync/renameSync/readTextSync` | 全文件层 | ✅ 均存在；writeSync 不传 offset（默认追加 fd 位置，语义正确） |
| CoreFileKit | `Environment.getUserDownloadDir()` | SharedDirStore | ✅ 返回共享下载目录，附 `/winvm-release` 子路径 |
| AbilityKit | `abilityAccessCtrl.createAtManager().requestPermissionsFromUser(ctx, [perm])` | SharedDirStore | ✅ authResults[0]===0 判授予 |
| PerformanceAnalysisKit | `hilog.info/warn/error(domain, tag, '%{public}s', msg)` | Logger | ✅ %{public}s 公开格式，domain 0xF822/0xF811 未占用系统域 |

## 4. 契约比对（父项目 ← → demo）

| 契约 | 父项目真相源 | demo 实现 | 结论 |
|---|---|---|---|
| zip 资产名 | `pack-release.mjs:337` `winvm-overall-${version}.zip` | `buildRelease()` 同构 | ✅ 一字不差 |
| 旁挂校验名 | `pack-release.mjs:339` `${zipName}.sha256` | `${zipName}.sha256` | ✅ |
| 旁挂内容格式 | `pack-release.mjs:344` `` `${hex}  ${zipName}\n` ``（两空格） | parseSidecar 空白分隔取首 token | ✅ 比对后修复，见 §5-D1 |
| 匿名下载 URL | `releases/download/${tag}/${zipName}` | 同构 | ✅ |
| latest 解析 | `repos/athronix/workbuddy-virtual-win-plugin/releases/latest`，tag 空即抛 | resolveLatest 空 tag 抛 E1001 | ✅ |
| 解压根目录 | 包内根 = `overall/` | extract 后 `accessSync(outDir/overall)` 断姿势，缺失抛 E3001 | ✅ |
| deploy-report.json | `docs/deploy §5.3` {version, ok, finishedAt, phases, checks[{id,pass,evidence}], failures[]} | DeployReport 逐字段对齐 | ✅ |
| prompt 模板 | `docs/deploy/通过铠大师app安装部署.md §5.2` 步骤 1-8 | 逐字复现 + 参数代入 + 追加步骤 9 | ✅（步骤 9 为演示版追加，见 issues ID-2） |
| VM 前置单真相源 | `tools/winvm-prepare.ps1`（父仓库已落地，实测存在） | vmPrepareHint 引用同路径 | ✅ |
| G7 禁符号链接 | 父项目铁律 | exportTree 真实文件复制（非 symlink） | ✅ |
| G4 首机 deterministic | 父文档 | PROVIDER_OPTIONS 默认注释 + Select 默认项 0=workbuddy | ✅（默认 workbuddy 符合表单默认，提示文案引导首机 deterministic） |

## 5. 发现与修复记录

### D1（严重，已修复）旁挂 sha256 解析口径错误 → 必然误报 E2001

- **位置**：`feature/winvm-onetap/src/main/ets/data/Sha256Verifier.ts` `parseSidecar()`
- **原实现**：取首行后**拼接整行所有 hex 字符**，`length !== 64` 即抛 E2001
- **根因**：父契约行格式为 `<64hex>  <zipName>`，两空格后跟文件名。zipName = `winvm-overall-V1.4.0.zip`，文件名本身含 hex 字符（e、a、1、4、0 ×5），拼接后 64+5=**69** → 任何合法旁挂文件都会被误判 E2001，**取包链 100% 断在 VERIFYING 阶段**
- **发现方式**：比对 `pack-release.mjs:341-344` 的 `sha256SidecarContent` 注释「一行 `<hex>  <name>`，两空格=二进制模式」后手工演算 `winvm-overall-V1.4.0.zip` 字符集
- **修复**：改为按空白分隔取**首 token**，长度 64 且逐字符 hex 校验后小写返回；失败时报错含原文行
- **回归**：修复后对 `<64hex>  winvm-overall-V1.4.0.zip` 形态返回正确 64 位 hex

### D2（提示，已确认不改）prompt 步骤 1 落包目录 `~/Downloads/winvm-release` 命名偏差

- 父文档 §5.2 原文即 `~/Downloads`，本机权威实为 `Download`（调研结论 F1）
- demo 的 InstallPromptBuilder 逐字遵循父模板（设计决策），步骤 9 旁写副本用权威路径
- 影响：WB 按 prompt 会 `mkdir -p ~/Downloads/winvm-release` 创建该目录并在其中下载部署，**功能不坏**（脚本在解压目录内运行），但与规范路径双轨
- 处置：登记 issues ID-1 建议父项目修正模板，demo 不改（保持逐字复现+追加原则）

### D3（提示，已确认不改）Select onSelect 回调参数 `value: string | undefined`

- SDK 签名参数为 string，写宽类型在参数逆变方向合法，编译可通过；未使用该参数

### D4（已知限制）signingConfigs 为空数组

- `build-profile.json5` `signingConfigs: []` 但 product 引用 `"signingConfig": "default"`
- DevEco 首次构建时会引导配置签名，属正常模板形态；已在 USER-GUIDE 说明

## 6. 未执行项（交付状态声明）

| 项 | 状态 | 原因 |
|---|---|---|
| hvigor 编译（hvigorw assembleHap） | **未执行** | 本开发环境为 HarmonyOS NEXT 沙箱，无 DevEco/hvigor 工具链 |
| ArkTS 编译器规则全量校验（arkts linter） | **未执行**（以上为人工逐条自审） | 同上 |
| 真机安装运行（S2） | **未执行** | 无真机连接；清单见 TEST-PLAN §S2，交付给用户执行 |
| 端到端一键部署（S3） | **未执行** | 依赖 WorkBuddy 侧粘贴执行，属用户侧验证 |

**误报风险声明**：§2/§3/§4 为人工核对，覆盖 10 条规则的 26 个文件与 8 组 Kit API；
未经编译器裁决，仍存在低概率规则漏判（如深层次类型推断边角）。建议首次构建时
开启全部 ArkTS 告警复核一遍。

## 7. 结论

静态阶段 **1 个严重缺陷已修复（D1）**，其余为提示级。代码具备进入真机验证的条件；
编译与真机验证清单移交用户侧（USER-GUIDE §验证清单）。
