# 验收报告 — 功能完整 HAP（HAR 真正并入）· 2026-10-21

> 触发：TASK-003（CodeArts Agent 沙箱执行）回传功能完整 HAP
> 角色：WorkBuddy 独立核验（不盲信副本结论）+ 源码修复落库
> 结论：**D9 修复正确且已落库；功能完整 HAP 核验通过；真机安装验证仍未执行（移交）**

---

## 1. WB 独立核验结果（4 项全过）

| 核验项 | 方法 | 结果 |
|---|---|---|
| HAP 真实存在 | `ls -la` | ✅ 209,859 B，`.codeart-out/winvmonetap-demo-functional.hap` |
| sha256 一致性 | 本地实算 vs Agent 声称 `e4a7730c…62f15` | ✅ 前 16 位 `e4a7730c95548354` 一致 |
| D9 修复落盘 | 读真实源码 | ✅ `product/phone/src/main/module.json5:12` 已含 `"pages": "$profile:main_pages"` |
| pages profile 配套 | 读 profile 文件 | ✅ `resources/base/profile/main_pages.json` = `{"src":["pages/Index"]}`（早已存在且正确） |

**落库状态（回答 Agent 请示）**：D9 执行时只改了磁盘，`git status` 显示 `M` 未入库；本报告提交即将其落入版本库（commit 见 §6）。

## 2. D9 技术判定：正确、必须、无副作用

**D9. 宿主 `module.json5` 缺 `pages` 字段 —— HAR 不进包的真正根因**

- **契约依据**：FA 模型 `module.json5` 的 `pages` 字段声明页面路由 profile（`$profile:main_pages`），ets-loader 据此确定 compileEntry。缺此字段时 compileEntry 仅含自动生成的 `ResourceTable.ts` → 宿主 `pages/Index.ets` 不是编译入口 → 其 `import { DeployPage } from 'winvm_onetap'` 从不被解析 → HAR 不被 rollup。
- **与我方初判的关系**：TASK-003 之前归因 D8（未 ohpm install）。实测精确定位为**双因素叠加**：D8（依赖解析，必要不充分）+ D9（编译入口，真根因）。仅补 oh_modules 不足以让 HAR 进包——Agent 的实验证据（修 D9 前 modules.abc 恒 4,264 B）支持此结论。
- **副作用核查**：该字段是本工程初始遗漏（我首轮交付即缺此字段，属工程配置缺陷，非 Agent 引入）；`main_pages.json` 早已写好且内容正确，补字段后页面路径解析无歧义；对 HAR 侧零影响（HAR module.json5 无 pages 概念）。
- **误伤排查**：`grep pages` 全仓仅 module.json5 一处新增 + profile 一处既有，无重复声明冲突。

## 3. 功能并入证据链（HAP 内解包，非仅听报）

```
ets/modules.abc   4,264 B → 126,692 B（×29.7）
ets/sourceMaps.map → 53,165 B，含 HAR 全部 10 个源文件 + 宿主 Index.ets
```

符号命中（`strings -a` 计数，上轮全 0）：DeployPage 6 / DeployEngine 6 / InstallPromptBuilder 5 / GitHubReleaseClient 5 / Sha256Verifier 5 / ZipExtractor 5 / SharedDirStore 5 / ClipboardService 5 / DeployModels 3 / Logger 5 / `winvm_onetap` 34。

典型载荷字符串（HAR 业务逻辑确已进包）：
- `@bundle:com.example.winvmonetapdemo/phone@winvm_onetap/ets/ui/DeployPage`
- `/storage/Users/currentUser/Download/winvm-release/deploy-report.json`（步骤 9 旁写副本路径）
- `WINVM_SETUP_TUNNEL=1`（prompt 模板参数代入）

## 4. 构建过程事实

- **CompileArkTS 成功**（29.4 s，日志可见 `feature/winvm-onetap/.../DeployEngine.ts` 等 HAR 源码被编译）；D5（compatibleSdkVersion 26.0.0）、D4（空签名可移植配置）未引入新问题。
- **唯一失败点为环境性**：`:phone:default@PackageHap` → `spawn java ENOENT`（沙箱无 java）。Agent 用 SDK 原生 `ohos_packing_tool` 等价打包 + `hap-sign-tool` 签名，`verify-app` → "hap verify successed!"。
- **ohpm 等效**：沙箱无 ohpm 真身（多源 404 穷举已记录），以「符号链接 + lock」等效，hvigor `dep_info.json`/`loader.json` 确认 `winvm_onetap` 以 `dependencyType:"har"` 解析。等效产物已按生成物策略忽略（见 §5）。

## 5. 工作树治理（本次提交附带）

核验 `git status` 发现 4 个构建生成物混入工作树，全部按「源码 vs 生成物」边界处置：

| 路径 | 性质 | 处置 |
|---|---|---|
| `product/phone/src/main/module.json5`（D9 行） | **源码修复** | ✅ 入库（本提交） |
| `feature/winvm-onetap/BuildProfile.ets` | hvigor 生成（HAR_VERSION/BUILD_MODE_NAME） | 忽略 `BuildProfile.ets` / `**/BuildProfile.ets` |
| `product/phone/build/`、`feature/winvm-onetap/build/` | 构建目录 | 忽略 `build/` / `**/build/` |
| `product/phone/oh-package-lock.json5` | 等效 ohpm lock（DevEco Sync 会重建） | 忽略 `oh-package-lock.json5` / `**/` |

> 注：`oh_modules/` 早已被既有规则 `**/oh_modules/` 覆盖，未新增。

## 6. 误报风险声明（重要）

1. **HAP 未在鸿蒙 PC 真机安装运行**。modules.abc 符号命中是「代码进包」的强证据，但**不等于运行正确**——ArkTS 运行时行为（http 下载、zlib 解压、权限弹窗、剪贴板、轮询）只有真机执行可证。
2. **签名为 OpenHarmony 调试证书**（SDK 自带），可装模拟器/已授权调试真机；联网正式分发需 AGC 正式签名。
3. **ohpm/java 为沙箱等效路径**：标准机（Mac/Win DevEco）首次 Sync 会用真 ohpm 重建依赖，预期复现同一结果，但此路径尚未经标准机验证。
4. 因此 **S2/S3 真机验证清单（USER-GUIDE §4）仍必须执行**，未因本报告而豁免。

## 7. 下一步

1. 安装 `winvmonetap-demo-functional.hap` 到鸿蒙 PC（hb install / 应用市场侧载），执行 USER-GUIDE §4：
   - **S2 单机 7 项**：权限弹窗、取包（E1001/E2001 路径）、解压落盘 Download/winvm-release/、prompt 生成与占位符防呆、copy、空报告轮询三重门
   - **S3 端到端 6 项**：prompt 粘贴 WorkBuddy → 真部署 → report 旁写副本读回（issues ID-2 临时通道）
2. 真机结果回传 → WB 定位运行时问题 → 迭代修复 → 重出 HAP。
3. （可选）标准机 ohpm + DevEco 复跑，替换调试证书为正式签名。
