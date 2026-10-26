# 交付基线适配 · 交付报告（2026-10-23 · 任务组 12–18）

> 依据：`.codeartsdoer/specs/winvm_onetap/tasks.md` 第二轮；spec 5.8；design 2.4。执行者：CodeArts Agent（HarmonyOS PC 沙箱）。

## 结论

- 收敛声明生效：产物 `minAPIVersion=60000020`（6.0.0/API 20）、`targetAPIVersion=60101024`（6.1.1/API 24），均 ≤ 设备 API 24。
- 验签通过：`hap verify successed!`。
- 沙箱无设备，真机安装/启动验收阻塞（移交标准环境）。

## 产出文件

| 类型 | 路径 |
| --- | --- |
| 接口库（E/F/H） | `tools/delivery-baseline/delivery-baseline.cjs` |
| 接口库（G） | `tools/delivery-baseline/build-pipeline.cjs` |
| 编排入口 | `tools/delivery-baseline/run.cjs` |
| 签名 HAP（本轮） | `.codeart-out/winvmonetap-demo-baseline-20261023-191208.hap` |
| 流水线证据 | `.codeart-out/delivery-baseline-20261023-191208.log`、`.codeart-out/baseline-report-20261023-191208.json` |
| 反例/可重复性 | `.codeart-out/baseline-evidence-verify.log` |
| 构建日志 | `.codeart-out/assembleHap-20261023-191208.log` |
| 功能并入验证 | `.codeart-out/verify-functional-20261023-191208.log` |
| 正式测试报告 | `docs/04-verification/TEST-REPORT-delivery-baseline-20261023.md` |
| 错误码台账 | `.codeart-out/ISSUES.md` §5 |

## error / warning

- ArkTS:ERROR = 0；`ERROR` 行 = 3（环境性 `PackageHap → spawn java ENOENT`）；ArkTS:WARN = 61（既有资源告警）。
- `00303312/00303313`：本轮未出现（收敛声明在 26 供给下可解析）。

## 遗留

1. 标准环境（DevEco 6.1.1 Release / SDK 6.1.1.125）复构建与 `apiReleaseType=Release` 对齐（tasks 14.2）。
2. 真机（API 24 / OpenHarmony-6.1.1.135）安装 + 启动验收（tasks 15.2 / 17.3）。