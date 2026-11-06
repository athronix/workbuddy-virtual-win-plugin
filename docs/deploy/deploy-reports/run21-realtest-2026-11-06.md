# run21 实弹报告（2026-11-06 16:44~16:57，V1.4.21 首航 = 灭窗全程实战）

## 结论：**三段全绿 UND=0 / DEP=0 / VER=0**，累计 798s（13m18s），steps.tsv 20 行全 PASS 零假绿零 dur 空白。

## 本轮特殊性：全程灭窗实战
- 起跑快照 16:44:47 二进制单发 **rc=124**；收链后 16:59 对照二进制**仍 rc=124**——**本轮从第一秒到最后一秒，OpenSSH 二进制通路都处于灭相位**。
- 同一时间窗内链条全绿 = D-2（迭代21 delivery ssh2 化）的终极实战证明：
  - skill 层：U0 通道判定 **1s 即过**（ssh2 ping 单发快路径；run13~16 同场景=五试 261s 挂死拦停）
  - delivery 层：C3.2 prepare-vm+setup --apply **217s 全过、日志『回落』计数=0**（auto 默认走 ssh2 恒通，二进制兜底压根没轮到出场）
- 对照 run20（好相位幸存+同秒分叉补证）：run21 是首个**全程灭窗**下完成的往返，验证强度再上一档。

## 计时表（steps.tsv 摘要）
| 段 | 用时 | 备注 |
|---|---|---|
| U0 通道判定 | 1s | ssh2 快路径（灭窗实证） |
| U1 dry-run | 17s | |
| U2 真拆 | 25s | 19 项全过 |
| U4 独立复核 | ~24s | health=000 真终态 |
| P0 preflight | 23s | READINESS=GREEN（灭窗下——旧版此处 261s RED） |
| C2 取包校验 | 2s | cache 快路径 [cache] tag=V1.4.21 命中（R-2 修复后信息行在册） |
| C3.0 env-check | 33s | ENV_PRECHECK=PASS（D-1 修复后真执行） |
| C3.2 prepare+setup | 217s | **回落 0 次**（auto=ssh2 恒通） |
| C4 install-host+fresh | 2s | FRESH/health=200 |
| C5 三探针 | 210s | mcp+a2a+example 全过（冷带正常） |
| C6 skills | 0s | =8 |
| VERIFY 三探针+矩阵 | ~206s | VERIFY=PASS 38/38 |
| sum | 778s | |

## 终态矩阵（verify 原文）
FRESH（逐文件 SHA256 一致）/ winvm disabledTools=8 / winvm-a2a disabledTools=0 / health=200 / connector skills=8 / 真 VM 行 `VM: task=Running listen=1 sshd=Running`。

## 观测登记
- CLIXML 进度流噪音混入矩阵 VM 行输出（QA iter21 §6 已登记的既知低优项，判据走 grep 内容不受影响）。
- `[PKG] root=…/overall-root/overall（来源=state(pkg-root.txt)）` 三段一致 = R-1 传导在真实链路再次实证。
- 证据：~/wbtmp/vmdeploy-run21/（full.log、steps.tsv、logs/×6）。
