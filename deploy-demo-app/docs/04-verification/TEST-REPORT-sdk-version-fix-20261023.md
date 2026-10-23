# TEST-REPORT — SDK 版本不匹配安装失败排查与修复（2026-10-23）

> 触发：用户用 hap_installer 安装 `winvmonetap-demo-functional-20261022-153659.hap` 报
> 「由于设备的 sdk 版本较低导致安装失败（该问题是由于编译打包的 sdk 版本与设备镜像版本不匹配引起的）」。

## 1. 结论（直接答案）

**本鸿蒙系统（设备）的 API 版本 = 24**。编译打包应使用 **HarmonyOS SDK 6.1.1 Release（API 24）**，
`build-profile.json5` 版本串为：

| 字段 | 值 | 作用 |
|---|---|---|
| `compatibleSdkVersion` | `"6.0.0(20)"` | 决定 minAPIVersion（**安装门槛**）→ 20 ≤ 24 ✅ |
| `targetSdkVersion` | `"6.1.1(24)"` | 决定 targetAPIVersion → 与设备一致 |
| `compileSdkVersion` | 省略（默认用配套 SDK） | 官方建议：编译时默认使用 DevEco 配套 SDK 版本 |

标准构建环境：**DevEco Studio 6.1.1 Release**（配套 SDK = Ohos_sdk_public 6.1.1.125，API 24 Release）。
Mac Studio 或 Windows 任一终端安装该版本即可。

## 2. 证据链（全部本地实证，无推测）

| # | 证据 | 值 |
|---|---|---|
| E1 | 设备 API 版本：`param get const.ohos.apiversion` | **24**（稳定复现） |
| E2 | 设备发布类型：`param get const.ohos.releasetype` | Release |
| E3 | 失败 HAP 的 minAPIVersion（module.json 解包） | **260000026（API 26）** |
| E4 | 失败 HAP 的 compileSdkVersion / targetAPIVersion | 26.0.0.18 / 260000026 |
| E5 | 沙箱唯一 SDK：`/data/service/hnp/ohos-sdk.org/` 列表 | 仅 `ohos-sdk_26.0.0.18`（API 26） |
| E6 | 官方映射（developer.huawei.com）：6.1.0(23) Release 为受限发布；**6.1.1(24) Release 公开发布**（SDK 6.1.1.125，API 24，2026-05-26） | — |

**根因**：E3（minAPI 26）> E1（设备 API 24）→ 安装门槛不满足 → 报「设备 sdk 版本较低」。
**次级根因**：E5 沙箱构建机唯一 SDK 是 API 26（WB 运行时自带 hnp SDK，高于设备两个大版本），
CL-007 时按沙箱 SDK 将版本串跟随写为 "26.0.0"，导致产物 minAPI 26——**沙箱产物结构上装不上本机**。
这不是代码缺陷，是构建环境 SDK 版本高于设备版本导致的版本门槛错配。

## 3. 已落地的修复（源码级，提交见 git log）

`build-profile.json5`（D5 遗留项「正式机回写」由本次设备报错触发落地）：

```json5
"compatibleSdkVersion": "6.0.0(20)",   // 原 "26.0.0" → minAPI 20
"targetSdkVersion": "6.1.1(24)",       // 原 "26.0.0" → 与设备对齐
// compileSdkVersion 省略：DevEco 6.1.1 打开工程时默认取配套 SDK
```

注释同步更新：记录设备实证 API 24、沙箱 SDK 26 高于设备的死结、标准构建环境要求。

## 4. 运行期兼容性评估（minAPI 降级后的符号风险）

demo 使用的系统 API 清单及最低 API 版本（均 ≤ 20，远低于设备 24）：

| Kit | 用法 | 最低 API |
|---|---|---|
| NetworkKit | `http.createHttp()` / `requestInStream` | 9 |
| BasicServicesKit | `zlib.decompressFile` / `pasteboard` | 9 / 9 |
| CryptoArchitectureKit | `cryptoFramework.createMd('SHA256')` | 9 |
| CoreFileKit | `fileIo` / `Environment.getUserDownloadDir()` | 9 / 12 |
| AbilityKit | `UIAbility` / `abilityAccessCtrl.requestPermissionsFromUser` | 9 |
| ArkUI | `bindSheet` + `SheetSize` / `Toggle` / `TextInput` / `Select` / `$$` 双向绑定 | 12 |

未使用 API 21–26 的任何新符号（沙箱 26 SDK 编译通过仅证明语法/类型正确，不证明设备运行正确；
但上述清单表明无高版本符号依赖，运行期风险低）。

## 5. 构建与安装步骤（用户执行）

1. Mac Studio（Tailscale 100.69.208.71）或 Windows：安装 **DevEco Studio 6.1.1 Release**
2. 打开 `/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app`
   （共享存储直连，或先同步到本地）
3. Sync（`ohpm install` 解析 HAR 依赖——同时消 D8 软链遗留）
4. 自动签名（debug 证书，本机安装足够）
5. Build → Build Hap(s) → 产物 `product/phone/build/default/outputs/default/phone-default-signed.hap`
6. 传到本机，文件管理器双击安装；或 DevEco 直连本机 Run
7. 按 `USER-GUIDE.md §4` S2（8 项）+ S3（6 项）验证

## 6. 误报风险声明

- **未执行编译/设备验证**：本环境（WB 沙箱 + CodeArts Agent 沙箱）均无 API 24 SDK，
  版本串回写后的构建结果未经验证；DevEco 6.1.1 若报「SDK 6.1.1(24) 未安装」，说明装的 DevEco 版本不对，
  应装 6.1.1 Release（不是 6.1.0 或更新大版本）。
- **沙箱复构建警告**：若仍在 CodeArts Agent 沙箱构建，会因找不到 SDK "6.1.1(24)" 报错——
  这是预期行为（沙箱只有 API 26 SDK），不代表源码错误；功能完整 HAP 必须由标准 DevEco 环境产出。
- **minAPIVersion 240000024→20 的兼容声明边界**：compatible 20 意味着声明兼容 API 20 设备；
  若未来代码引入 API 21+ 符号而无版本守卫，低版本设备运行期才暴露——当前清单无此风险。
