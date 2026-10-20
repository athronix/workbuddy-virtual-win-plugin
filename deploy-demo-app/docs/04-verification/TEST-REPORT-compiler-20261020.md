# TEST-REPORT-compiler-20261020 — 编译器/API 层裁决

> 阶段：P4-v 编译器裁决（TASK-001 产出）
> 执行者：CodeArts Agent（HarmonyOS PC 沙箱）经人肉 bridge
> 输入：`.codeart-out/codelinter-20261020-181433.log` + `assembleHap-20261020-181433.log`

---

## 0. 一句话结论

**ArkTS 语法/规则层（arkts-no-*）0 violations 成立**（印证 WB 静态自审）；
**API/类型层被编译器级检查报出 12 ERROR / 40 WARNING**，其中 **5 条为真实代码缺陷（已修复）+ 7 条为环境/依赖伪阳性**；
**HAP 未能产出 —— 根因是沙箱工具链缺失 + node JIT 崩溃，与代码无关**（见 §4）。

---

## 1. 执行环境事实（权威证据，来自 log §1）

| 项 | 状态 |
|---|---|
| 官方 `codelinter` | NOT FOUND |
| 官方 `hvigorw` | NOT FOUND（工程内也无 wrapper） |
| `ohpm` | NOT FOUND |
| `devecocli` | NOT FOUND（hmosBuild 报 `devecocli not found and auto-install failed`） |
| 全盘搜索 codelinter/hvigor/ohpm/devecocli | 0 命中 |
| Node 运行时 | `/data/service/hnp/bin/node v24.13.0` |
| **Node JIT** | **默认 JIT 下任何脚本崩溃**（`Check failed: 12 == (*__errno_location())` / Signal 5）；**仅 `node --jitless` 可跑** |
| 可用 SDK | `/data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18`（含 ets-loader Linter、hap-sign-tool 等，但**无 hvigor/codelinter/ohpm 二进制**） |

`tools/build.sh all` 实测 `rc=4`（官方链缺失，预建 log 0 字节）。
其余 12 ERROR / 40 WARNING 来自 Agent 手搓的 **standalone ets-loader Linter harness**（`node --jitless` 驱动），是真实编译器引擎（typescript@4.9.5-r4 ArkTSLinter_1_1），结果可信。

---

## 2. 12 ERROR 分类裁决

### A 类 · 真实代码缺陷（5 条 → 已全部修复）

| ID | 位置 | 错误 | 根因 | 修复 |
|---|---|---|---|---|
| A1 | DeployPage.ets:74 | `Property 'space' does not exist on ColumnAttribute` | 用链式 `.space(12)`，但 Column 间距是**构造参数** | `Column({ space: 12 }) {` + 删 `.space(12)` |
| A2 | DeployPage.ets:174 | `Property 'fontSize' does not exist on SelectAttribute` | `Select` 无 `.fontSize()`，须用 `.font({...})` | `.font({ size: 14 })` |
| A3a | DeployPage.ets:281 | `TextOverflow` 不可赋值给 `TextOverflowOptions` | `textOverflow()` 收 **对象** `{ overflow: }`，非枚举直传 | `.textOverflow({ overflow: TextOverflow.Ellipsis })` |
| A3b | DeployPage.ets:332 | 同上 | 同上 | 同上 |
| A3c | DeployPage.ets:390 | 同上 | 同上 | 同上 |

> 上述 5 条是 **API 形态误用**，与运行模式无关 —— **在真实 DevEco Stage 构建中也会报错**，必须修。已修并自检验证（见 git commit）。

### B 类 · 环境/模式伪阳性（6 条 → 不改）

报错文本统一为 `This API is used only in Stage Mode, but the current Mode is FA.`：

- SharedDirStore.ts:24, :25（`abilityAccessCtrl.requestPermissionsFromUser`）
- DeployEngine.ts:45（`this.context.cacheDir`）
- DeployPage.ets:550（`this.getUIContext().getHostContext()`）
- EntryAbility.ets:8, :15（`UIAbility` 体系）

**判定**：工程为 **Stage 模型**（使用 UIAbility / Context / UIContext 是正确的 Stage API）。
harness 未完整复刻 hvigor 的 Stage 编译上下文（误判为 FA），故误报。
**不修改** —— 改为 FA 写法才是错。真实 DevEco 构建中此 6 条不出现。

### C 类 · 依赖未安装（1 条 → 不改）

- Index.ets:2 `Cannot find module 'winvm_onetap'`

**判定**：HAR 本地依赖（`file:../../feature/winvm-onetap`）未 `ohpm install` / Sync。
真实构建中 ohpm 解析后即消除。

> 用户摘要「7 环境性」= B(6) + C(1)。

---

## 3. 40 WARNING 说明（不阻断构建）

- **~38 条** `Function may throw exceptions. Special handling is required.` —— SDK API 检查器对可能抛异常的系统 API 的常规提示，**非 ArkTS 规则违反**，不阻断 HAP。
- **2 条** `To use this API, you need to apply for the permissions: ohos.permission.INTERNET`
  （GitHubReleaseClient.ts:31, :113）—— 已在 `product/phone module.json5` 声明 `INTERNET` 权限；harness 未读取声明故提示，真实构建中消失。

---

## 4. HAP 未产出的根因（关键）

`assembleHap` 从未真正执行。根因链：

```
沙箱缺 codelinter/hvigorw/ohpm/devecocli
        ↓
且 Node v24.13.0 默认 JIT 崩溃（仅 --jitless 可跑）
        ↓
ohpm install / hvigorw assembleHap（均为 node 脚本）必然崩溃 → 无法拉起构建
        ↓
HAP 无法产出（与源码正确性无关）
```

**结论**：本机 CodeArts Agent 沙箱的 Node 运行时 JIT 损坏，**HarmonyOS 构建工具链（ohpm/hvigor，均 node 驱动）在此环境根本无法运行**。这是**机器级环境缺陷**，非代码问题，也无法靠改码解决。

---

## 5. 修复后预期（待 TASK-002 复核）

重跑 standalone Linter harness（同一 `node --jitless` 方法）后：

- **真实 ERROR**：12 → **0**（A 类 5 条已修，B/C 非代码）
- **报告 ERROR 总数**：12 → **7**（仅 B 类 6 + C 类 1，均为环境/依赖）
- WARNING 数量不变（属 SDK 噪声，不阻断）

---

## 6. 产出真正 HAP 的路径（必读）

| 路径 | 可行性 | 说明 |
|---|---|---|
| 本机 CodeArts Agent（沙箱） | ❌ | node JIT 损坏，ohpm/hvigor 跑不起来 |
| Mac Studio（Tailscale 100.69.208.71）+ DevEco Studio 6.x | ✅ 推荐 | 支持 API 23；工程在共享存储，直接打开、签名、产出 HAP 拷回本机装 |
| Windows + DevEco Studio 6.x | ✅ | 同上兜底 |

**步骤（任一有工具链机器）**：
1. DevEco Studio 打开 `deploy-demo-app` → Sync（ohpm install，拉起 HAR 依赖）
2. File → Project Structure → Signing Configs 配 debug 自动签名
3. Build → Build Hap(s) → 取 `product/phone/build/*/outputs/default/*.hap`
4. 拷回本机，按 `docs/guides/USER-GUIDE.md §4` 的真机清单装 + 跑 S2/S3

---

## 7. 误报风险声明

- 本报告基于 `node --jitless` standalone harness（非官方 `hvigorw` 全量构建）。B 类 6 条 Stage/FA 伪阳性**已在 SDK .d.ts 独立核验**为 harness 产物，但**最终以真实 DevEco 构建输出为准**。
- A 类 5 条修复**未经过真实编译器链接验证**（本环境无法构建），依据为 ArkUI 官方 API 形态 + SDK .d.ts 核对；真实 DevEco 构建是终局裁决。
- 40 WARNING 未处理（属噪声），不阻断构建，但建议后续统一加 `try/catch` 或 `@ts-ignore` 收敛（低优先级）。
