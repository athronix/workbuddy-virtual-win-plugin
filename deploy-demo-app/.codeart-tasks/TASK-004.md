# TASK-004 — 标准 DevEco 6.1.1 环境产出可安装 HAP（API 24 基线）

> 背景：10-22 沙箱产物（SDK 26.0.0.18 / API 26）在本机（API 24）被安装器拒装
> （「设备 sdk 版本较低」）。`build-profile.json5` 已回写为设备基线
> （compatible 6.0.0(20) / target 6.1.1(24)）。本任务在**标准工具链环境**重建。

## 执行环境（二选一）

- **A. Mac Studio**（Tailscale 100.69.208.71）：DevEco Studio **6.1.1 Release**
- **B. Windows**：DevEco Studio **6.1.1 Release**

> 版本核对：Help → About DevEco Studio 应显示 6.1.1.x（290/300 等 patch 均可）；
> Help → About HarmonyOS SDK 应显示 Ohos_sdk_public 6.1.1.125（API 24）。
> **不要**用 6.1.0（API 23 受限发布）或任何 API ≥ 26 的预览 SDK。

## 步骤

1. 同步工程到构建机（共享存储直连或 scp/rsync），路径保持
   `.../workbuddy-virtual-win-plugin/deploy-demo-app`
2. DevEco 打开工程 → 若提示 Sync / ohpm install，执行（消 D8 软链遗留，生成真实 oh_modules）
3. 确认 `build-profile.json5` 版本串为 compatible 6.0.0(20) / target 6.1.1(24)
   （本任务提交后已就位；若 DevEco 弹「SDK 版本不存在」，说明 DevEco 版本装错，回到环境核对）
4. 签名：File → Project Structure → Signing Configs 自动登录生成 debug 签名
5. Build → Build Hap(s)（或 Build App(s)）
6. 将产物 HAP 拷回本机（共享存储即可）：建议命名
   `.codeart-out/winvmonetap-demo-deveco611.hap`

## 验收点（回传时逐项报告）

1. HAP 绝对路径 + 字节数
2. `unzip -p <hap> module.json` 中 minAPIVersion / targetAPIVersion / compileSdkVersion 三值
   （**预期 minAPIVersion ≤ 240000024**，即 6.0.0(20) 或 6.1.1(24) 基线）
3. 构建日志中 CompileArkTS 是否 OK、有无 ERROR/WARNING 计数
4. 安装到本机是否成功（文件管理器双击；若仍报版本错，贴 module.json 三值回传）
5. ohpm install 是否生成真实 `oh_modules/`（D8 关闭）

## 安装后

按 `docs/guides/USER-GUIDE.md §4` 执行 S2（8 项）+ S3（6 项），结果回传 WB 迭代。
