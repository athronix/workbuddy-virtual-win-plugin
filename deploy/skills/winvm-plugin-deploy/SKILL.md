---
name: winvm-plugin-deploy
description: WinVM Bridge（workbuddy-virtual-win-plugin）鸿蒙宿主与 Windows VM 双端一键安装、拆除、复验专用技能（v1.1.1：run13 增通道判稳器/能力通道自救/rhythm-check 周期暂停定性/预算纪律）。当用户要求部署、安装、重装、拆除或卸载本项目到 VM，跑 deploy.prompt 或 undeploy.prompt，验证 VM 插件安装，处理发布包下载慢或失败、VM ssh 连不上、不稳定、挂起、安装前置检查与环境体检时使用。封装两主流程的分环节子流程、数十个实战问题的现象根因解法百科，并提供分步计时、双通道连接、远端 PowerShell 铁律执行、一键体检、取包校验与验证 driver 脚本。
version: 1.1.4
agent_created: true
---

# WinVM 插件部署技能（winvm-plugin-deploy）

把「鸿蒙宿主 ⇄ Windows VM 安装 WinVM Bridge」从长 Prompt 升级为**分环节可执行流程 + 高效脚本 + 问题百科**。业务权威判据仍以仓库 `docs/deploy/deploy.prompt`（安装）与 `docs/deploy/undeploy.prompt`（拆除）为准；本技能负责跑得**快**（driver+计时）、**稳**（通道/超时/避坑内建）、**卡住秒级定位**（troubleshooting 按现象查表）。

## 铁律（任何环节先遵守）

1. **取包 gitee 主源、github 备源**；tag 以 `releases/latest` 现解为准（gitee API），示例值仅参考。
2. **远端 PowerShell 铁律**：复合逻辑=写 `.ps1` → scp → `powershell -File`；短片段=`-EncodedCommand`（base64 UTF-16LE）。**任何情况下不双引号内联含 `$` 的 PS**——本地 bash 与远端壳都会吞改（R8 安装链 183 次失败、run11 本地 `$_` 展开两案定谳）。本技能一律经 `scripts/ps-run.sh`。
3. **宿主删文件禁 `rm`**（部分鸿蒙宿主坏 shim=`bad interpreter`）→ `fs_rm`（node fs）。禁 `rm -rf <目录>` 式清理——**误写 `rm -f ~/.config` 类通配/目录删除可能被沙箱提权批准后真执行**；清理具体文件用 `node -e 'fs.unlinkSync(路径)'`（存在性先判断，幂等）。
4. **ssh/scp 必须外层 timeout**：VM sshd 连接位占满时 TCP 层**无限挂起**（连 BatchMode 不退，实测卡死 8 分钟）——`vm-conn.sh` 已内建 `VM_SSH_TIMEOUT=25`。
4. **shell 拼接纪律**：命令行内嵌 python/sed 含嵌套单引号会被 eval 撕碎（run13 实证：token 提取一行式炸整链 exit 127）→ 复杂逻辑一律先写脚本文件再执行；令牌经文件/环境变量中转并即删。
5. **密码只走环境变量**（askpass / `WINVM_VM_PASSWORD`），不落盘不进命令行；`.env` 凭据 V1.4.20 起自动回注（旧包=外部 export 后跑 setup）。
6. **每步判据自检不过 = 停**：按四元组（现象/根因/证据/处置）记录并查 `references/troubleshooting.md`，不跳步硬推；缺信息问用户（P-1）。

## 安装主流程（deploy.sh 一键化，对应 deploy.prompt Step 0→6）

```bash
cd <包根或仓库>            # 包根缺失先：bash scripts/download-verify.sh [--tag V1.4.x]
export VM_HOST=<ip> VM_USER=<user>          # 未知 → P-1 问用户
bash scripts/env-detect.sh                  # 运行时冒烟探测（NODE/PY/BASH，D1 教训产品化）
# shellcheck disable=SC1090
source ~/wbtmp/vmdeploy-env.sh
bash scripts/preflight.sh                   # Step0 体检：RED/YELLOW/GREEN+修复指引
bash scripts/deploy.sh                      # DRY-RUN：体检+通道+计划预览
bash scripts/deploy.sh --apply              # 真执行：通道→取包→prepare→setup→vmcheck→host→38探针→交付
```

- 每环节自动计时留痕到 `~/wbtmp/vmdeploy-run-<日期>/steps.tsv`（显式指定 `export VMDEPLOY_RUN_DIR=~/wbtmp/vmdeploy-run13-<日期>` 使多日/多轮不混算）；收尾打 Top5/问题行/失败行。
- 幂等：任一相位失败 → 查表处置后**只重跑失败相位**（deploy.sh 各步独立可重入）。
- BUILD 假败（缺 typescript）、.env 密码不回注 两坑已在 ≥V1.4.20 包内根除；旧包按 troubleshooting B 表绕行。

## 拆除主流程（undeploy.sh，对应 undeploy.prompt U0→U4）

```bash
bash scripts/undeploy.sh                 # DRY-RUN：基线+dry 清单核对
bash scripts/undeploy.sh --apply         # 真拆：19 项核验+U4 独立复核；存留项全默认保留
# 存留项（SSH 密钥/trash/下载物）逐项问用户（U5；删密钥走 undeploy.prompt 的 vm-rmkey 子流程）
```

## 复验与汇报

```bash
bash scripts/verify.sh                   # 三探针 38 项 + 终态矩阵（fresh/8/隧道/health/skill/VM 点）
bash scripts/step.sh report              # 计时汇总；交付报告=总表+Top5+问题清单直接成文
```

## 通道自救路径（run13 定谳：ssh 通道死、MCP 隧道活的组合态）

> ⚠ **红线（用户明令 2026-11-04，最高优先级）：绝不主动重启 VM/guest**——`self-rescue.sh restart-guest`、`shutdown /r`、taskkill sshd 树等复位手段**一律禁用**，除非用户当次明确要求。通道坏了的正确姿势=**探测并利用健康窗口**跑最短链（隧道 ensure→undeploy→deploy→verify 一气呵成），无窗则止损上报等用户处置，不许用重启赌窗口。

判据形态：`ssh` TCP 秒连但 **banner 8s 不吐**（node 裸探针可证）、sshd 服务 Running、`restart sshd` 无效、RDP 亦超时——= guest 监听栈僵死/半开堆积，**旧长连接仍可用来救场**。此时**先走能力通道，勿找 hypervisor**：

```bash
bash scripts/self-rescue.sh check              # health=200? sshd Running? banner 8s 不吐?（形态确认）
bash scripts/self-rescue.sh restart-guest 8    # 能力通道发 shutdown /r /t 8 /f（审计在册）
bash scripts/wait-channel.sh 3 10              # 稀疏轮询判稳（75s 间隔 3 连击）；⚠ 外层 timeout ≥ rounds×120、reboot 后睡 240s 再测（run14 课）
bash scripts/self-rescue.sh rhythm-check      # 交替采样二分定性（run14 修正）：
                                              #  ssh 灭+隧道【稳 200】=SSHD_STACK_WEDGE（vCPU 活着≠暂停！监听栈坏死，
                                              #  整机重启续命 ~7-11min 窗，抢不进 driver 即环境级上报）；
                                              #  ssh 与隧道【都】间歇挂=真暂停指纹（查 Step 0.3）
# 隧道若 DEGRADED：node delivery/winvm-plugin.mjs tunnel ensure（自检自动重建）
```

预算纪律（run13 亲犯两次的课）：**外层 `timeout` ≥ 内层最坏耗时总和**——probe 五试最坏 5×(VST+15s)≈275s，包它的 timeout 给 300s 起；外层先杀=整段白跑还留下"失败假象"误导诊断。

## 卡住时（先查表再动手）

`references/troubleshooting.md`：按现象组织（A 通道网络 / B 安装拆除 / C 宿主特例 / D gitee 发布面 / E 版本门槛速查）。高频五例：

| 现象 | 一句话根因 | 处置 |
|---|---|---|
| ssh 无输出无限挂起 | VM sshd 连接位占满（TCP 层不退） | 一切 ssh 外层 timeout（已内建）；持续则 VM 内 `Restart-Service sshd`；多 agent 禁并发同 VM |
| 远端 PS 报 ParserError/`$_` 变怪值 | 本地或远端壳吞改写 | 只走 `ps-run.sh`（铁律） |
| 420s 未监听/拆不净+杀不掉 | 僵而不绑/僵尸 node（三式强杀免疫） | ≥V1.4.16 签名清扫根治；旧包：重跑本相位 / VM `shutdown /r /t 5 /f` 重启复拆 |
| E7 `EXECUTION_TIMEOUT`（≈120000ms） | 服务端能力闸（≠客户端 timed out） | ≥V1.4.17 族 300s；两形态勿混（X-5 带宽） |
| `.env` 填了密码隧道仍要密码 | ≤V1.4.19 不回注 process.env | ≥V1.4.20 自动回注；旧版先 source 含 export 的 env.sh |

## 脚本清单（scripts/）

| 脚本 | 职责 |
|---|---|
| `env-detect.sh` | 运行时探测（node=.mjs 冒烟/py=-c/bash=可执行带 shebang 脚本/rm 可用性）→ 生成 `~/wbtmp/vmdeploy-env.sh` |
| `vm-conn.sh` | 双通道（key 免密/password askpass）+ `vm_channel_probe` + `vmssh/vmscp`（三试+timeout）+ `fs_rm` |
| `ps-run.sh` | 铁律执行器：`ps-run.sh x.ps1`（ASCII 门禁+推送+执行+远端清理）；`-c '单行'` EncodedCommand |
| `preflight.sh` | Step 0 一键体检（信息/运行时/通道/VM 前置 sshd·node·防火墙），RED/YELLOW/GREEN+逐项修复命令 |
| `download-verify.sh` | 取包三件套（gitee 主+github 备、sha256、解压、verify-manifest）→ `PKG_ROOT=` |
| `wait-channel.sh` | 通道判稳器：稀疏轮询（75s 间隔）连击 N 判稳；冷开机/挂起期勿单发判死（run13 沉淀） |
| `self-rescue.sh` | 能力通道自救三合一：check（health+sshd+banner 探针定谳挂起形态）/ restart-guest（shutdown /r 经 app.process.launch）/ restart-service；隧道健在时免碰 hypervisor（run13 实测 ~70s 复活） |
| `deploy.sh` / `undeploy.sh` | 主流程 driver（默认 dry-run；--apply 真执行；全程 step 计时） |
| `verify.sh` | 三探针 + 终态矩阵（装后随时可跑） |
| `step.sh` | 分步计时/留痕/汇总（begin/end/log/report） |
| `env.example` | `.env` 模板（provider 选择与密码纪律注释齐） |

## references（按需加载）

- `troubleshooting.md` — 问题百科（现象→根因→解法，含 run/ISSUES 出处与版本门槛表）
- `known-good-flow.md` — 每环节判据摘录 + 预期耗时带（run11/12 实测基线），判"慢是否异常"

## 权威文档关系

本技能是**流程编排层**：判据细节、参数表、发布链以 `docs/deploy/deploy.prompt`、`docs/deploy/undeploy.prompt`、`docs/deploy/deploy-strategy.md`、用户实跑复盘 `docs/deploy/deploy-reports/` 为准。两 .prompt 每次升版（发布面改动，pack V11 机械化断言保障入包），本技能流程/脚本如有出入以新版 .prompt 为准并同步回改本技能。
