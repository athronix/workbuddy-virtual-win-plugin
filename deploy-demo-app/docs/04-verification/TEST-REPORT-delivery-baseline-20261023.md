# TEST-REPORT — 交付基线适配（SDK 版本匹配 / HAP 可安装）2026-10-23

> 依据：`.codeartsdoer/specs/winvm_onetap/tasks.md` 任务组 12–18；spec 第 5.8 章；design 第 2.4 节。
> 主题：选择与设备镜像匹配的版本路径，使产物安装门限收敛到设备可接受范围（HAP 可成功安装到本机设备）。
> 执行者：CodeArts Agent（HarmonyOS PC 沙箱）。工程：HAP 壳 `product/phone` + HAR 功能层 `feature/winvm-onetap`。

## 1. 结论

- **收敛已达成（沙箱可验证部分）**：以收敛声明 `compatibleSdkVersion="6.0.0(20)"` / `targetSdkVersion="6.1.1(24)"`（省略 `compileSdkVersion`）构建，
  产物 API 字段由声明经编译推导，**`minAPIVersion=60000020`（6.0.0 / API 20）、`targetAPIVersion=60101024`（6.1.1 / API 24）**，均 ≤ 设备 API 24。
- **产物门限核验通过**（H1）：`minApi=20 ≤ 24` 且 `targetApi=24 ≤ 24`；**验签通过** `hap verify successed!`。
- **可安装判定**：**沙箱无法完成真机安装/启动验收**（无设备），`InstallVerifier` 返回设备不可达（非门限拒装）。故沙箱结论为
  **"产物门限已收敛且验签通过，待真机安装验收"**，最终 `可交付` 判定须在标准环境 + 真机收口。
- **红线遵守**：未在打包期写入/改写产物 `module.json` 的 `minAPIVersion`/`targetAPIVersion`；该两字段仅由编译链按版本声明推导，核验阶段只读。

### 关键实测修正（对 design 2.4.1.3-(3) 表的更正）

design 表记 "B 路径：仅收敛声明不换供给 → `00303312` 无法构建"。实测表明 `00303312` 的真实触发条件是
**供给中不存在 hvigor 编译侧所需的 SDK 版本**：hvigor 6.26.8 的编译 SDK 绑定其内置 latest-support（`26.0.0`），与
`compileSdkVersion` 同源（省略时取该值）。因此：

| 处置 | 供给 | 声明 | 实测 |
| --- | --- | --- | --- |
| 收敛声明 + 原沙箱 26 供给 | `26.0.0(26) Beta` | `6.0.0(20)` / `6.1.1(24)`，compile 省略 | **构建通过**（CompileArkTS OK），产物 `min=60000020` / `target=60101024` ✅ |
| 收敛声明 + 元数据改为 6.1.1(24) 的供给 | `6.1.1(24) Release` | 同上 | 复现 `00303312`（编译侧找不到 26.0.0） |

即**同源点在编译 SDK（须存在 `26.0.0`）**；`compatibleSdkVersion`/`targetSdkVersion` 仅决定产物 `min/targetAPIVersion`。

## 2. 五层流水线执行结果（design 2.4.1.2）

| 层 | 接口 | 结果 |
| --- | --- | --- |
| 取证层 | `DeviceProbe.probe` | 设备 `{api:24, name:OpenHarmony-6.1.1.135, release:Release, type:2in1}`（来源=缓存实证记录；沙箱 `hdc list targets` 空） |
| 取证层 | `SdkInventory.scan` | 单候选 `26.0.0(26) Beta`（沙箱唯一 SDK） |
| 取证层 | `HostApiFloor.resolve` | `floor=12`（CoreFileKit=12 最高；NetworkKit/BasicServicesKit/Crypto/AbilityKit/PerfAnalysis=9）≤ 20 ✅ |
| 决策层 | `BaselineResolver.compose` | `{deviceApi:24, releaseChannel:Release, floorApi:20, upperBound:24, devicePlatform:6.1.1}` |
| 决策层 | `SdkSelector.select` | 标准候选 `6.1.1(24) Release`→**完全匹配**；沙箱候选 `26.0.0(26) Beta`→**E7001**（高于设备 24） |
| 决策层 | `VersionDeclarer.declare` | `{"6.0.0(20)", "6.1.1(24)", compile=省略}`；预期产物 `min=60000020 / target=60101024` |
| 执行层 | `ProfileWriter.apply` | 声明落位 `build-profile.json5` `app.products[0]`；`signingConfigs` 保持空 |
| 执行层 | `BuildPipeline.build` | `CompileArkTS` 成功（27 s）；`PackageHap` 环境性失败（`spawn java ENOENT`）→ SDK 原生二进制替代 pack+sign |
| 核验层 | `ArtifactApiInspector.inspect` | `min=60000020(6.0.0/20) target=60101024(6.1.1/24) compile=26.0.0.18 release=Beta`；门限判定通过 |
| 核验层 | `InstallVerifier.verify` | `installOk=false`（设备不可达）；`verdict=不可交付`（待真机） |
| 诊断层 | `VersionDiagnostics` | 统一载荷 `{code,sdkPlatformVersion,deviceApiVersion,artifactThreshold}` 已植入四处失败路径；E7001–E7005 登记于 `.codeart-out/ISSUES.md` §5 |

## 3. 产物与核验值

| 项 | 值 |
| --- | --- |
| 签名 HAP（本轮） | `/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/deploy-demo-app/.codeart-out/winvmonetap-demo-baseline-20261023-191208.hap`（258567 B） |
| `minAPIVersion` | **60000020**（平台 6.0.0 / API **20**） ≤ 设备 24 ✅ |
| `targetAPIVersion` | **60101024**（平台 6.1.1 / API **24**） ≤ 设备 24 ✅ |
| `compileSdkVersion` | `26.0.0.18`（仅溯源，不参与门限判据） |
| `apiReleaseType` | `Beta`（因沙箱供给为 26 Beta；标准 Release SDK 下应为 `Release`，与设备通道一致） |
| 验签 | `hap verify successed!`（`hap-sign-tool verify-app`） |
| 反例（旧产物） | `winvmonetap-demo-functional-20261022-153659.hap` → `E7003 产物安装门限 260000026 > 设备镜像 API 24` |
| 可重复性 | 两次独立构建 `min/target` 逐字节一致（`60000020`/`60101024`）✅ |
| 构建时长 | 端到端（复制+编译+打包+签名+验签+核验）**41 s** ≤ 10 min ✅ |

## 4. error / warning 计数

- 构建日志 `assembleHap-20261023-191208.log`：**ArkTS:ERROR = 0**；`ERROR` 行 = 3（全部为环境性 `PackageHap → spawn java ENOENT` / `00308018` / `BUILD FAILED`）；**ArkTS:WARN = 61**（资源 string 冲突等既有告警，非工程硬错误）。
- 规则检查（ArkTS 规则）：沿用第一轮 `codelinter-20261022-153659.log`（本轮未改任何业务源码，环境性白名单 8 条：7×`$$this` + 1×HAR 依赖未加载，工程性硬错误 0）。
- 结论：**工程性硬错误 0**（`00303312/00303313` 本轮未出现）。

## 5. 改动文件清单（含位置与理由）

| 文件 | 变更 | 理由 |
| --- | --- | --- |
| `tools/delivery-baseline/delivery-baseline.cjs` | **新增** | 固化 E1–E3 / F1–F3 / H1–H2 接口、数据模型、API 编码与 `VersionDiagnostics`（design 2.4.2） |
| `tools/delivery-baseline/build-pipeline.cjs` | **新增** | 固化 G1 `ProfileWriter`、G2 `BuildPipeline`、`SdkSupplyBuilder`（等效供给） |
| `tools/delivery-baseline/run.cjs` | **新增** | 五层流水线编排与证据落盘 |
| `build-profile.json5` | 无新增改动 | 收敛声明已于上一阶段（任务 9.3）落位，本轮核验一致 |
| `.codeartsdoer/specs/winvm_onetap/tasks.md` | 状态更新 | 任务 12–18 执行结果登记（14.2 标准环境、17.3 真机为遗留） |
| `.codeart-out/ISSUES.md` | 追加 §5 | E7001–E7005 登记与 design 修正说明（tasks 16.3） |

**业务源码零改动**（spec 5.8.7 能力语义零变更）：本轮未触碰 `feature/winvm-onetap` 与宿主页面任何 `.ets/.ts`。

## 6. 遗留项（移交标准环境 / 真机）

1. **标准环境复构建**（tasks 14.2）：DevEco 6.1.1 Release + SDK 6.1.1.125，执行 `ohpm install` + `assembleHap`，核对无 `00303312/00303313` 且产物 `apiReleaseType=Release`。
2. **真机安装/启动验收**（tasks 15.2 / 17.3）：在 API 24 / OpenHarmony-6.1.1.135 设备安装 `winvmonetap-demo-baseline-*.hap` 并启动，判定最终 `可交付`。
3. **AGC 正式签名 / 正式 `ohpm install` / ID-1、ID-2 回并父项目**（承自第一轮遗留）。