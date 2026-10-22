# WinVM 一键部署（winvm_onetap）偏差与缺陷处置台账（ISSUES）

> 依据：`.codeartsdoer/specs/winvm_onetap/tasks.md` 任务 9.4。
> 范围：契约偏差 ID-1 / ID-2 + 构建缺陷 D1–D10 的处置结果，形成可追溯台账。
> 本轮执行日期：2026-10-22；执行者：CodeArts Agent（HarmonyOS PC 沙箱）。

## 一、契约偏差（业务语义）

| 编号 | 偏差 | 权威依据 | 处置 | 证据 |
| --- | --- | --- | --- | --- |
| ID-1 | 安装指令模板第 1 步文本 `~/Downloads/winvm-release`（复数）与本机权威落包目录 `Download`（单数）命名不一致 | spec 4.5.3 / design 1.1.2 | **已处理**：`InstallPromptBuilder.ts` 第 16、21 行路径统一为 `/storage/Users/currentUser/Download/winvm-release`，使步骤 1 的 `curl` 目标目录与步骤 9 / App 读回目录语义一致 | `feature/winvm-onetap/src/main/ets/prompt/InstallPromptBuilder.ts:16,21` |
| ID-2 | 安装指令追加"步骤 9 旁写报告副本"，父项目模板无此步 | spec 5.3.1-1 / design 1.1.2 | **保留并登记**：该步为演示版报告读回通道所必需（普通 App 不可读 WorkBuddy 私有规范路径）；不得在无登记情况下删除；建议正式版回并父模板 | `feature/winvm-onetap/src/main/ets/prompt/InstallPromptBuilder.ts:43-50` |

## 二、构建缺陷处置结果（D1–D10）

| 编号 | 缺陷 | 处置 | 当前位置 / 证据 |
| --- | --- | --- | --- |
| D1 | 工程根 / 宿主 / 功能层 `hvigorfile.ts` 从 `@ohos/hvigor` 导出 `appTasks`/`hapTasks`/`harTasks`（该包不导出），任务列表为空 | **已修复**：三文件改为 `import { ... } from '@ohos/hvigor-ohos-plugin'` + `export default { system, plugins }` | 根 `hvigorfile.ts`、`product/phone/hvigorfile.ts`、`feature/winvm-onetap/hvigorfile.ts` |
| D2 | `feature/winvm-onetap/hvigorfile.ts` 拼写错误 `harpTasks` | **已修复**：改为 `harTasks` | `feature/winvm-onetap/hvigorfile.ts:1` |
| D3 | 缺 `modelVersion`，hvigor 6.x 报 `00303024` | **已修复**：根 `oh-package.json5` 与 `hvigor/hvigor-config.json5` 均补 `"modelVersion": "5.0.0"` | 两文件首字段 |
| D4 | `build-profile.json5` 签名配置缺失，product 硬引用 `signingConfig:"default"` | **已处理**：`app.signingConfigs` 保持空数组、不提交签名材料与 SDK 绝对路径；product 不再硬引用 `signingConfig`；签名由 DevEco 自动签名 / CI 注入 | `build-profile.json5`（app 段） |
| D5 | SDK 版本字段与工具链不匹配（`00303313/00303312`）+ 未设 `targetSdkVersion` 告警 | **沙箱已处理**：`compatibleSdkVersion`=26.0.0 且显式补 `targetSdkVersion`=26.0.0，告警已消除；**正式机回写目标**（compileSdkVersion/targetSdkVersion=6.1.0(23)、compatibleSdkVersion=6.0.0(20)）已在文件中标注，落地动作见遗留项 | `build-profile.json5`（products[0]） |
| D6 | `module.json5` 缺 `deliveryWithInstall`；`deviceTypes` 含非法 `"PC"` | **已修复**：补 `deliveryWithInstall:true`、`installationFree:false`；deviceTypes 收敛为 `["2in1"]`（宿主与功能层一致） | `product/phone/src/main/module.json5`、`feature/winvm-onetap/src/main/module.json5` |
| D7 | `configuration.json` 的 `fontSizeMaxScale="3.0"` 非法 | **已修复**：改为允许枚举值 `"3.2"` | `AppScope/resources/base/profile/configuration.json` |
| D8 | HAR 依赖未解析（缺 `ohpm install`），HAR 不进包 | **沙箱等效处理**：建立 `product/phone/oh_modules/winvm_onetap` → `feature/winvm-onetap` 符号链接（`oh_modules/` 已被 `.gitignore` 忽略）；**正式环境执行 `ohpm install`** | `product/phone/oh_modules/winvm_onetap`（软链） |
| D9 | 宿主 `module.json5` 缺 `"pages"` 字段，宿主 `pages/Index.ets` 不作为编译入口 → HAR 完全不进包（空壳根因） | **已修复**：补 `"pages": "$profile:main_pages"`（配合 `main_pages.json`=`{"src":["pages/Index"]}`） | `product/phone/src/main/module.json5`；证据 `.codeart-out/verify-functional-20261022-153659.log` |
| D10 | `DeployPage.ets` 使用非法枚举 `InputType.NUMBER`（ArkTS 规则码 `10505001`，阻断 `CompileArkTS`） | **已修复**：第 298、314 行改为 `InputType.Number`（"必须修的硬错误"例外） | `feature/winvm-onetap/src/main/ets/ui/DeployPage.ets:298,314` |

## 三、环境性误报白名单（不计为工程缺陷，tasks 2.5）

| 项 | 说明 |
| --- | --- |
| `DeployPage.ets` 的 `$$this` 双向绑定（7 处） | 合法 ArkUI 语法糖，由 ets-loader transform 展开；独立 lint 的纯 TS 类型检查阶段误报，权威 `CompileArkTS` 不报 |
| `product/phone/src/main/ets/pages/Index.ets` 的 `import ... from 'winvm_onetap'` | 独立 lint 未加载 HAR 依赖解析；权威构建（经 oh_modules 解析）不报 |
| `PackageHap → spawn java ENOENT` | 沙箱无 java；已用 SDK 原生 `ohos_packing_tool` / `hap-sign-tool` 等价替代（rc=0） |

## 四、遗留项（移交正式环境，tasks 9.3 / 11.4）

1. **版本基线回写**（tasks 9.3）：在具备标准 toolchains 的环境将 `build-profile.json5` 回写为 `compileSdkVersion/targetSdkVersion="6.1.0(23)"`、`compatibleSdkVersion="6.0.0(20)"`（当前文件已标注目标值）。
2. **正式 `ohpm install`**（D8）：在标准环境执行以生成真实 `oh_modules`（替换沙箱软链）。
3. **AGC 正式签名**（D4）：接入 AGC 发布证书与 profile，替换沙箱 OpenHarmony 调试材料。
4. **ID-1 / ID-2 与父项目对齐**：建议正式版将"步骤 9 旁写副本"回并父项目模板、将路径命名统一，使"逐字模板"约束重新成立。