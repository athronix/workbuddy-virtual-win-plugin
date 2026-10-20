# TASK-001 — ArkTS 规则检查 + HAP 构建（编译器权威裁决）

> 执行者：CodeArts Agent（鸿蒙 PC，内置 DevEco CLI）
> 触发者：人（bridge）— 在 CodeArts Agent 中打开本工程并说「读取并严格执行 TASK-001」
> 产物读者：WorkBuddy（回读 `.codeart-out/` 分析错误）

---

## 1. 背景

`deploy-demo-app` 是 HarmonyOS NEXT 多模块演示工程：

- HAP 壳：`product/phone`（仅挂载页面，不含业务逻辑）
- HAR 功能层：`feature/winvm-onetap`（一键部署真实实现，零 ArkUI import）
- API 目标：`6.1.0(23)`，compatible `6.0.0(20)`
- 全部源码由 WorkBuddy 在「只读父项目」约束下生成

WorkBuddy 已做静态自审（声称 10 条 ArkTS 规则 × 26 文件 **0 violations**），但**未经编译器裁决**。
本任务目标：用编译器 / Linter 做**真实权威验证**。

---

## 2. 你要做的（按顺序）

1. **打开工程**：文件 → 打开项目，选择 `deploy-demo-app` 根目录（含 `build-profile.json5`）。
2. **首次准备**：若提示未 Sync，先执行 Sync / `ohpm install`（让 `node_modules` 与 `hvigorw` wrapper 就绪）。
3. **ArkTS 规则检查（Code Linter / codelinter）**，覆盖全部 `.ets`：
   - 推荐：运行 `bash tools/build.sh lint`（脚本自动探测 codelinter 或 hvigorw code-linter）。
   - 或直接在 IDE 触发 Code Linter，把完整输出保存。
4. **构建 HAP**：`bash tools/build.sh build`（或 IDE 构建 HAP；需 debug 签名——可用内置自动签名）。
5. **落盘输出**：脚本已自动写入 `.codeart-out/codelinter-<ts>.log` 与 `.codeart-out/assembleHap-<ts>.log`。
   若你用 IDE 手动触发，请手动把输出追加到这两个文件。

---

## 3. 输出要求（WB 要读这些）

- 任何 **error / warning** 必须含：**完整文件路径 + 行号 + 规则码**（如 `arkts-no-obj-literals-as-types`）+ 原始消息。
- 构建**最终退出码**（成功 / 失败）。
- 若成功，给出产物 **HAP 的绝对路径**。
- 若 codelinter / hvigorw 不可用，明确说明你用的替代方式。

---

## 4. 不要做

- **不要**修改 `feature/winvm-onetap/` 或 `product/phone/` 下源码（除非遇到必须修的硬错误，
  且需在回复里显式标注「改了什么文件、哪一行、为什么」）。
- **不要**把构建产物提交到 git。

---

## 5. 完成判定

`.codeart-out/` 下存在 `codelinter-*.log` 与 `assembleHap-*.log`，且你已在对话里给出结论摘要：
**error 数 / warning 数 / 是否成功产出 HAP**。

---

## 6. 已知自审结论（供你对照编译器裁决）

WB 静态自审声称 0 violations，覆盖文件清单（节选关键）：

- `feature/winvm-onetap/src/main/ets/data/DeployEngine.ts`
- `feature/winvm-onetap/src/main/ets/data/GitHubReleaseClient.ts`
- `feature/winvm-onetap/src/main/ets/data/Sha256Verifier.ts`（已修 D1 解析 bug）
- `feature/winvm-onetap/src/main/ets/data/ZipExtractor.ts`
- `feature/winvm-onetap/src/main/ets/data/SharedDirStore.ts`
- `feature/winvm-onetap/src/main/ets/data/ClipboardService.ts`
- `feature/winvm-onetap/src/main/ets/prompt/InstallPromptBuilder.ts`
- `feature/winvm-onetap/src/main/ets/ui/DeployPage.ets`
- `feature/winvm-onetap/src/main/ets/domain/DeployModels.ts`
- `feature/winvm-onetap/src/main/ets/util/Logger.ts`
- `feature/winvm-onetap/Index.ets`
- `product/phone/src/main/ets/pages/Index.ets`
- `product/phone/src/main/ets/EntryAbility/EntryAbility.ets`

若编译器报出上述文件之外的错误，或推翻 0-violation 结论，请逐条列出——这正是本任务要捕获的真值。
