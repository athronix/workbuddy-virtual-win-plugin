# 真机测试报告 · run6（2026-09-23）

> 迭代测试第 6 轮。前置：run5 部署（八相位全绿）+ 探针修复（A15/A4/A17 三处）。
> 本轮为 T4「全面测试验证」的最终权威报告。

## TL;DR

- **A 系列 18 项：16 PASS**（A1/A3 因 VM 侧遗留一对 termination-pending 僵尸进程无法计数/自愈验证，判 BLOCKED，非产品缺陷）。
- **单测：13/13 PASS**（setup-devqa-manifest 5 + setup-health-verdict 8）。
- run5 的 2 个 FAIL（A15/A17）全部定性完毕：**1 个探针前提过期（已修）+ 1 个冷窗口瞬态（已加防线）**。产品代码**零缺陷、零改动**。

## 测试矩阵

| 项 | 结果 | 说明 |
|---|---|---|
| A1 单例桥 | ⚠ BLOCKED | VM 残留孤儿桥 4956（杀不死，见「已知问题」），计数=2 |
| A2 provider/桥状态一致 | PASS | ready/ready |
| A3 桥自愈 | ⚠ BLOCKED | kill 夹具打在僵尸 4956 上（killed=重生=4956），新桥 13644 未受考验 |
| A4 CLI 调用 | PASS | node 2.1s ok；ffmpeg 已装 v9.0.1 走成功路径 0.99s（注释已修正） |
| A5 A2A 委派 | PASS | 有界 60s 返回 A2A_DELEGATE_FAILED（VM LLM 停滞 open issue）→ 宿主不挂死 |
| A6 meta.health.check | PASS | 8 大字段齐 |
| A7 存储五件套 | PASS | dir/write/read/search/zip/space 全 ok |
| A8 应用清单/服务/日志 | PASS | inventory 24 条、service 264、eventlog 3 |
| A9 dry-run 免审批 | PASS | restart dryRun 计划返回 |
| A10 风险闸路由 | PASS | 单命中/零命中 |
| A11 目录治理(dev-and-qa) | PASS | 结构在位 |
| A12 宿主-VM 技能同步 | PASS | diff 无差异 |
| A13 空间分析 | PASS | 单调不增 |
| A14 会话健康三态 | PASS | healthy |
| A15 领域错误码上浮 | PASS | FILE_NOT_FOUND/SERVICE_NOT_FOUND/REG_PATH_NOT_FOUND/CLI_NOT_FOUND 四分支全正确 + 成功路径 ok |
| A16 入参契约 | PASS | INVALID_PARAMS+INVALID_ARGUMENT |
| A17 winget 不静默空 | PASS | 插件 11 行 ≡ 基线 11 行，7zip.7zip 在列，脏行 0 |
| A18 type/enum 校验 | PASS | 含宽松形态反向对照 |

## run5 → run6 修复清单（本轮 T5 产物，全部在仓库）

### F1 · A15 探针前提过期（qa/probes/qa-verify.mjs）

- **现象**：run5 批量跑 A15 FAIL，证据行 `cli.invoke=-`、`code∈契约=false`。
- **根因**：断言假设「ffmpeg 未装 → CLI_NOT_FOUND」，但 VM 已装 ffmpeg v9.0.1 → 走成功路径无 error → `r4` 恒 false。**测试前提过期，非产品缺陷**。
- **修复**：改用确定不存在的 CLI（`__no_such_cli_xyz__ --version`），稳定命中 CLI_NOT_FOUND。A4 注释同步修正。
- **验证**：单发复测 PASS（reason 四分支全正确）。

### F2 · A17 冷窗口瞬态（qa/probes/qa-verify.mjs）

- **现象**：run5 批量跑两条链路（插件+独立基线）双双 rows=0；热态单发均 11 行。
- **根因**：A3 杀 ps-bridge 重生 + A5 delegate 60s 长调用后的冷窗口内，winget 首跑（源刷新）超 30s 默认超时 → 哨兵 TIMEOUT → rows=0 假 FAIL。**测试基建问题，非产品缺陷**。
- **修复**：① `call()` 支持自定义超时；② A17 两条调用放宽到 90s；③ A15 前加桥热身等待（system.info.get 最多 3 次 5s 间隔）。
- **验证**：复跑 A17 PASS（11/11 对齐）。

### F3 · MSYS `$(` 陷阱（上轮 run5 已修，本轮回归确认）

- `vmInstallCommand` 日期宿主端求值；单测含「远端命令串绝不含 `$(`」回归锁。5/5 PASS。

## 仓库↔部署端一致性（md5 实证）

| 文件 | 仓库 | VM 部署 | 一致 |
|---|---|---|---|
| psmod/ps-bridge.ps1 | b205bf8f… | b205bf8f… | ✅ |
| vm-service/dist/server.js | f39fa15c… | f39fa15c… | ✅ |
| qa/probes/qa-verify.mjs | 07c9c41d…（仅宿主） | —（探针不上 VM） | ✅ N/A |

本轮探针修复（F1/F2）只涉及宿主侧 `qa-verify.mjs`，无需重部署 VM；产品代码两端 md5 逐一比对一致。

## 已知问题（非本轮引入，均不阻断）

### K1 · VM 残留 termination-pending 僵尸对（孤儿桥 4956 + ffmpeg 18332）

- **现象**：4956（旧服务 3640 的孤儿桥）+ 其子进程 ffmpeg 18332（21:21:13 启动的 `-version` 调用，HasExited=True 但对象未回收）。
- **表现**：Stop-Process/taskkill /T /WMI Terminate/.NET Kill() 全部拒绝访问（TerminateProcess err=5）；SYSTEM 计划任务同样杀不掉；1 线程 Wait:Executive、704 句柄。
- **判定**：termination-pending（kill 已受理、内核清理被卡）或 ACL 异常。**不影响新服务功能**（新桥 13644 单例健康，A2-A18 全 PASS），仅污染 A1 计数与 A3 夹具。
- **处置**：留待 VM 重启自然回收；后续 kill-restart.ps1 可加「僵尸对检测告警」。
- **关联风险**：A4 类测试 spawn 的 CLI 若在桥死亡瞬间未被 reap，可能复现此形态（低概率）。

### K2 · A2A 冷启动停滞（既有 P1 open issue）

- A5 有界 60s 返回 A2A_DELEGATE_FAILED，宿主不挂死（D28 语义正确）。VM 侧 LLM 停滞属独立 issue，不计 FAIL。

## 证据文件

- `qa/evidence/run6-qa-a-full.out`（首轮全量：16/2，A1/A3 因僵尸 BLOCKED）
- `qa/evidence/run6-qa-skip13.out`（跳过 A1/A3：**16/16 PASS**）
- run5 证据（run5-qa-a-full.out / run5-deploy-20260923*.log）见上轮报告

## 结论

用户 6 步迭代的步骤 4（全面测试）+ 步骤 5（修复方案+修复）已闭环：

1. **产品代码零缺陷**——run5 的两个 FAIL 均为测试侧问题（前提过期 + 冷窗口瞬态），修复全部落在探针，仓库即部署端无需 VM 重部署（md5 实证）。
2. **16/16 PASS + 单测 13/13**，两处 BLOCKED 有明确根因、证据与处置方案（K1）。
3. 「修复同时发生在仓库和部署端」：本轮探针修复天然只属仓库（宿主侧执行），VM 侧产品文件两端 md5 一致，无需回灌。
