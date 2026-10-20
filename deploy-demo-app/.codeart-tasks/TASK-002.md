# TASK-002 — 复核 5 处真实修复 + 确认仅剩环境性诊断 + 真机 HAP 路径

> 执行者：CodeArts Agent（HarmonyOS PC 沙箱）经人肉 bridge
> 前置：TASK-001 产出 `codelinter-*-181433.log`；WB 据此修复 5 处真实 API 误用（commit 见 TEST-REPORT-compiler-20261020.md §2-A）
> 读者：WorkBuddy（回读 `.codeart-out/` 确认修复生效）

---

## 1. 背景

TASK-001 用 standalone ets-loader Linter（node --jitless）报出 12 ERROR / 40 WARNING。
WB 已修复其中 **5 条真实代码缺陷**（DeployPage.ets：Column 间距构造参数、Select 字体、TextOverflow 对象包裹）。
本任务目标：**验证修复生效（真实 ERROR 归零）**，并明确 **HAP 必须用带工具链的机器产出**。

---

## 2. 你要做的（分两段）

### 段 A — 沙箱内可完成：重跑 Linter harness，确认修复

1. 复用 TASK-001 §3/§8 的 standalone 方法（`.codeart-out/_lint-try/do_lint.cjs` 若仍在；否则按 TASK-001 §3 重新驱动 ets-loader）：
   ```
   FF=$(grep '^feature/' .codeart-out/_lint-try/filelist.txt | grep -v hvigorfile.ts | tr '\n' ' ')
   node --jitless .codeart-out/_lint-try/do_lint.cjs "$PWD" \
     "$PWD/feature/winvm-onetap/src/main/module.json5" feature $FF
   PF=$(grep '^product/' .codeart-out/_lint-try/filelist.txt | grep -v hvigorfile.ts | tr '\n' ' ')
   node --jitless .codeart-out/_lint-try/do_lint.cjs "$PWD" \
     "$PWD/product/phone/src/main/module.json5" product $PF
   ```
2. 把输出写入 `.codeart-out/codelinter-<新时间戳>.log`。
3. **验收期望**（WB 预测）：
   - 真实 ERROR（A 类：DeployPage.ets 的 space/fontSize/textOverflow）总数 **12 → 0**。
   - 报告 ERROR 总数 **12 → 7**（仅 B 类 6 条 Stage/FA 伪阳性 + C 类 1 条 HAR 未 install）。
   - WARNING 数量不变（~40，属 SDK 噪声，不阻断）。

### 段 B — 沙箱外：产出真正 HAP（本机沙箱 node JIT 损坏，无法构建）

> 根因见 TEST-REPORT-compiler-20261020.md §4：本机 Node v24.13.0 默认 JIT 崩溃，ohpm/hvigor 均跑不起来。

**请在以下任一有工具链的机器操作**（工程在共享存储，可直接打开）：
- **Mac Studio**（Tailscale `100.69.208.71`）+ DevEco Studio 6.x（支持 API 23）
- **Windows** + DevEco Studio 6.x（兜底）

步骤：
1. DevEco Studio 打开 `deploy-demo-app` → **Sync**（ohpm install，解析 `winvm_onetap` HAR 本地依赖，消除 C 类错误）。
2. File → Project Structure → Signing Configs 配 **debug 自动签名**。
3. Build → Build Hap(s) → 取产物 `product/phone/build/*/outputs/default/*.hap`。
4. 把 HAP 路径、以及构建日志中**是否仍有非预期 ERROR** 回传 WB。
5. 装到本机，按 `docs/guides/USER-GUIDE.md §4` 的 S2/S3 清单真机验证。

---

## 3. 输出要求（WB 要读）

- 段 A：新 `codelinter-*.log` 的 ERROR/WARNING 计数，并确认 A 类 5 条已消失。
- 段 B（若执行）：HAP 绝对路径 + 构建是否 0 ERROR（B 类 Stage/FA 在真实 DevEco 中应不出现，请如实记录）。

---

## 4. 不要做

- 不要把 B 类 Stage/FA 误报当真去改 Stage API（会改错）。
- 本机沙箱不要尝试 `ohpm install` / `hvigorw`（node JIT 必崩）。

---

## 5. 完成判定

- 段 A：新 log 显示 **真实 ERROR = 0**。
- 段 B：拿到 HAP 路径 + 构建结论（或明确告知「无工具链机器，待安排」）。

---

## 6. 与 TASK-001 对照

| 项 | TASK-001 | TASK-002 期望 |
|---|---|---|
| 真实 ERROR（A 类） | 5 | 0 |
| 报告 ERROR 总数 | 12 | 7（B6+C1，环境性） |
| WARNING | 40 | 40（不变，噪声） |
| HAP | 未产出（工具链缺失） | 须 Mac/Win DevEco 产出 |
