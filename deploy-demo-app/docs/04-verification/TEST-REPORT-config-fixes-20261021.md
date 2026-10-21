# TEST-REPORT-config-fixes-20261021 — 工程配置/构建链缺陷修复

> 阶段：P4-v 编译器裁决 · 第二轮（TASK-001 重跑）
> 输入：`.codeart-out/assembleHap-20261020-191453.log` + `PROPOSED-FIXES.md` + 副本 diff（`_build-try/proj`，即成功构建的那份）
> 结论：官方 hvigor `:phone:default@CompileArkTS` 编译成功（20.99s，无错）；HAP 已产出并验签通过；但功能为空（HAR 未并入）→ 本轮修复 8 个工程缺陷的 7 个（源码层），D8（ohpm install）留待 TASK-003。

---

## 1. 里程碑（本轮 TASK-001 重跑）

| 项 | 本轮 | 上轮 |
|---|---|---|
| ArkTS 规则违反（arkts-no-*） | 0 | 0 |
| ERROR | 4（3 环境误判 + 1 HAR 未装） | 12 |
| WARNING | 40 | 40 |
| CompileArkTS | ✅ 成功 20.99s | 未跑 |
| HAP 产出 | ✅ 是（已签名验签） | 否 |
| HAP 是否含功能 | ❌ 否（仅壳，见 §4） | — |

关键链：官方 hvigor 6.26.8 + `@ohos/hvigor-ohos-plugin@6.26.8`（华为源 npm，`node --jitless` 驱动）。
打包因环境无 java 改用 SDK 原生 `ohos_packing_tool`；签名用 SDK OpenHarmony 调试材料，`verify-app` 通过。

---

## 2. 8 个工程缺陷裁决与处置

> 全部修复先在 `_build-try/proj` 副本验证通过，WB 逐条核验 diff 后应用到真实源码。

| ID | 缺陷 | 位置 | 处置 | 应用到真实源码 |
|---|---|---|---|---|
| D1 | hvigorfile 引用包名错误（`@ohos/hvigor` 不含 appTasks/hapTasks/harTasks） | 3 个 hvigorfile.ts | 改 `@ohos/hvigor-ohos-plugin` + `export default {system, plugins}` | ✅ |
| D2 | `harpTasks` 拼写错误（应为 `harTasks`） | feature hvigorfile.ts | 随 D1 修正 | ✅ |
| D3 | 缺 `modelVersion`（hvigor 6.x 报 00303024 结构未升级） | oh-package.json5 + hvigor-config.json5 | 加 `"5.0.0"` | ✅ |
| D4 | 签名配置缺失（signingConfig "default" not found） | build-profile.json5 | **见 §3（WB 决策，偏离副本）** | ✅（可移植方案） |
| D5 | SDK 版本字段不匹配（6.1.0(23) 不在 SDK 26 中） | build-profile.json5 | `compatibleSdkVersion: "26.0.0"`，去掉 compile/target | ✅ |
| D6 | module.json5 非法：deviceTypes 含 "PC"（应为 2in1）+ 缺 deliveryWithInstall | phone + feature module.json5 | deviceTypes→["2in1"]；phone 加 deliveryWithInstall/installationFree | ✅ |
| D7 | configuration.json `fontSizeMaxScale: "3.0"` 非法 | AppScope profile | 改 `"3.2"`（枚举上限） | ✅ |
| D8 | HAR 未 `ohpm install` → 未编入 HAP | 工程依赖 | 操作性，需带 ohpm 环境 | ⏳ TASK-003 |

### 版本基线订正（重要）
早先设计文档假设「HarmonyOS 6.1.0 = API 23」，但**本机/本 SDK 实证为 API 26 / platformVersion 26.0.0**（`ohos-sdk_26.0.0.18`）。
故 `compatibleSdkVersion` 订正为 `"26.0.0"`；早先 `"6.1.0(23)"` 在本环境必然 00303313 报错。

---

## 3. D4 签名：WB 决策（偏离副本）

副本为跑通本机构建，在 build-profile 内嵌了 SDK **绝对路径** OpenHarmony 调试材料 + 密码 `123456`。
WB **不采用**该写法提交仓库，理由：
- 绝对路径（`/data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18/...`）在 Mac/Win DevEco 不存在，破坏可移植性；
- 把密钥/密码写进入库文件是安全坏味道。

**采用**：`signingConfigs: []` + 移除 product 的 `signingConfig` 引用（即 DevEco 新建工程未配签名的一致状态）。
- 后果：`assembleHap` 产出**未签名** HAP（合法，不影响构建验证）；
- 正式签名：DevEco「自动签名」（推荐，IDE 自动回填 signingConfigs）或 CI 注入材料。
- 本机沙箱继续用手工 `hap-sign-tool` 签名（本轮已验证可行）。

---

## 4. 仍未解决：HAP 功能为空（D8）

`assembleHap` 产出的 HAP 内 `modules.abc` **仅含壳 EntryAbility + ResourceTable**，
`pages/Index.ets` 与 HAR（winvm_onetap）业务代码**未编入**。
根因：未执行 `ohpm install`，`import { DeployPage } from 'winvm_onetap'` 未解析，
phone 的 Index.ets 未作为入口编译、HAR 未 rollup 并入。

**必须**：在具备 ohpm 的环境执行 `ohpm install`（或 DevEco Sync）生成 `oh_modules/winvm_onetap`，
再 `assembleHap`，才能得到**功能完整**的 HAP。见 TASK-003。

---

## 5. 误报风险声明

- D1/D3/D5/D6/D7 为 hvigor/schema **硬报错**，修复后有副本成功构建背书，可信度高。
- D4 采用空签名方案**未经本机 assembleHap 直接验证**（本轮 hvigor 在 PackageHap 阶段因缺 java 中断，
  签名由手工工具补）；预期产出未签名 HAP、无 error，但以真实 DevEco 构建为终局。
- D8 的功能完整 HAP **尚未产出**，不可宣称「一键部署功能已验证」——仅「工程可编译 + 壳可安装」。
- 4 条残留 ERROR 中 3 条 Stage/FA 为 harness 误判（工程本为 Stage），1 条为 D8（HAR 未装），均非源码缺陷。
