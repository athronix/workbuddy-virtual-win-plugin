# TASK-003 — 产出功能完整的 HAP（ohpm install + 重构建 + 验功能）

> 执行者：CodeArts Agent（鸿蒙沙箱，node --jitless）或 Mac/Win DevEco Studio，经人肉 bridge
> 前置：WB 已把 TASK-001 副本验证过的 8 个工程缺陷中的 7 个应用到真实源码（commit 见 TEST-REPORT-config-fixes-20261021.md）
> 读者：WorkBuddy（回读 `.codeart-out/` 确认 HAP 含功能）

---

## 1. 背景

TASK-001 重跑：`CompileArkTS` 成功、HAP 产出并验签，**但 modules.abc 仅含壳 EntryAbility，
HAR(winvm_onetap) 与 pages/Index.ets 未编入**——根因是未执行 `ohpm install`（D8）。
本任务目标：让 HAR 真正并入，产出**功能完整**的 HAP。

WB 已修复（真实源码）：D1/D2 hvigorfile、D3 modelVersion、D5 SDK 版本(26.0.0)、
D6 module.json5(2in1+deliveryWithInstall)、D7 configuration.json、D4 改空签名(可移植)。
→ 你现在应基于**修复后的真实工程**构建，而非 `_build-try/proj` 副本。

---

## 2. 你要做的

### 段 A — 获取 ohpm 并安装依赖（关键）
本机沙箱此前 `ohpm NOT FOUND`。按优先级尝试：
1. 若 hvigor-home（`.codeart-out/_build-try/hvigor-home/node_modules`）内已有 ohpm 相关可执行，直接用；
2. 否则从华为源安装：`npm install @ohos/ohpm`（或 `@ohos/hvigor-ohos-plugin` 自带的 ohpm），
   参照 TASK-001 安装 hvigor 的方式（repo.harmonyos.com/npm，node --jitless，装到 `_build-try` 隔离目录，勿污染工程）；
3. 仍不行 → 切到 **Mac/Win DevEco Studio**，打开工程 → **Sync**（DevEco 自动 ohpm install）。

### 段 B — 安装依赖 + 重构建
```bash
# 在工程根，ohpm 可用的前提下：
ohpm install                       # 生成 product/phone/oh_modules/winvm_onetap（D8）
# 复用 TASK-001 §7 的沙箱构建法（NODE_PATH 注入 hvigor、DEVECO_SDK_HOME 指向 SDK、node --jitless）
node --jitless <...>/@ohos/hvigor/bin/hvigor.js --mode module -p product=default -p buildMode=debug assembleHap
# DevEco 路线则直接 Build → Build Hap(s)
```

### 段 C — 验功能并入（WB 验收点）
解包 HAP，确认 `ets/modules.abc` 体积明显大于上轮空壳（上轮 debug.hap 45KB 但功能空），
并确认包含 DeployPage / DeployEngine / InstallPromptBuilder 等 HAR 符号（可用 strings 或 ets-loader 反查）。
把结论写入 `.codeart-out/verify-functional-<ts>.log`。

### 段 D — 打包 + 签名 + 回报
按 TASK-001 §6 手工 pack + hap-sign-tool 签名（沙箱无 java），产物落 `.codeart-out/winvmonetap-demo-functional.hap`。
回报：HAP 绝对路径 + `ohpm install` 是否成功 + modules.abc 是否含 HAR 功能符号。

---

## 3. 输出要求（WB 要读）

- `ohpm install` 退出码 + 是否生成 `product/phone/oh_modules/winvm_onetap`。
- 重构建 `assembleHap` 结果（是否 0 ERROR；D5 版本、D4 空签名是否引入新问题）。
- 功能并入结论：modules.abc 是否含 HAR 代码。
- 功能完整 HAP 的绝对路径。

---

## 4. 不要做

- 不要再用 `_build-try/proj` 旧副本构建（那是修复前的探针）；基于**修复后的真实工程**。
- 不要把 `oh_modules/`、签名材料提交 git（已 gitignore）。
- 沙箱内若 ohpm 实在装不上，明确说明并转段「Mac/Win DevEco」。

---

## 5. 完成判定

`.codeart-out/winvmonetap-demo-functional.hap` 存在，且 `verify-functional-*.log` 证明
**modules.abc 含 HAR 功能代码**（而非仅壳 EntryAbility）。

---

## 6. 与 TASK-001 对照

| 项 | TASK-001（重跑） | TASK-003 目标 |
|---|---|---|
| CompileArkTS | ✅ | ✅ |
| HAP 产出 | ✅（空壳） | ✅ 功能完整 |
| HAR 并入 modules.abc | ❌ | ✅ |
| ohpm install | ❌ 未执行 | ✅ 执行 |
| 签名 | 手工验签通过 | 手工/IDE 验签通过 |
