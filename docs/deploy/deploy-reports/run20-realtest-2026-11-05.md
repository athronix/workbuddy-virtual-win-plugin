# run20 · 收官终局全链验收（QA Edward，2026-11-05）

对象：commit **419c1c4**（未 push，6 files +123/-32，全 skill 侧，delivery/ 零改动）——run19 R-1/R-2/R-3 回修。
视角：独立实跑，未采信自报。任务书命令**逐字原样**（不显式设 PKG_ROOT）。
证据：`~/wbtmp/vmdeploy-run20/`（steps.tsv、logs/、三段 stdout.log）。

# 判定：**YES（收官达成）**

五条硬判据逐项命中：
1. 三段 rc 真值 **UND=0 / DEP=0 / VER=0**（echo 直跟命令，零管道）✅
2. verify **38/38**（mcp `SUMMARY: 20/20 PASS, 0 FAIL`、a2a `SUMMARY: 5/5 PASS, 0 FAIL`、example `RESULT: PASS (13/13)`）✅
3. 终态矩阵全绿（FRESH SHA256 一致 / winvm disabledTools=8 / health=200 / skills=8 / **真 VM 行** `VM: task=Running listen=1 sshd=Running`）✅
4. steps.tsv **20 行全 rc=0 PASS、零假 PASS、零 dur 空白**，report `issue_rows=0`、失败/跳过段空 ✅
5. 三段日志 `[PKG] root=…` 均指内层 V1.4.20 真根，来源=state/probe（见下摘录）✅

R-1 定谳修复；ssh2 后端全链三轮（run18/19/20）稳定零挂死。

## 一、[PKG] 来源行摘录（任务书指定核对项）

| 段 | 原样输出（逐字） |
|---|---|
| undeploy | `[PKG] root=/storage/Users/currentUser/winvm-deploy/overall-root/overall（来源=state(/storage/Users/currentUser/winvm-deploy/pkg-root.txt)）` |
| deploy | `[cache] tag=V1.4.20 本地包根完整（…/overall-root/overall），跳过下载/解包` → `[PKG] root=…/overall-root/overall（来源=download-verify 最新判定）` → `[PKG] 状态文件已写 ~/winvm-deploy/pkg-root.txt` |
| verify | `[PKG] root=…/overall-root/overall（来源=state(/storage/Users/currentUser/winvm-deploy/pkg-root.txt)）` |

- **state 级闭环实证**：undeploy（开局，命中工程师 run19 后写实的状态文件）与 verify（deploy C2 重写后）均走 L2 state → 内层根；deploy 走 download-verify→cache 快路径→写状态。三级链全环在真实序列跑通。
- **run19 遗留布局（外层空壳 .env+overall/）未触发"状态指向已被移走层"场景**——undeploy 不搬包根，pkg-root.txt 全程有效。设计内回退路径由 fixture 离线亲验替代（见三）。

## 二、独立复核简跑（任务 1）

| 项 | 结果 |
|---|---|
| `git show 419c1c4` 通读 | 6 files +123/-32 ✓；pkg-root.sh 单一事实源（_pick_pkg_root 内层优先+版本匹配 strict 可选；resolve_pkg_root 三级 env>state>probe；pkg_root_usage_error 三选语文案）；download-verify 删本地 `_pick_root` 改共享（防两版漂移）；deploy/undeploy/verify 全挂 pkg-root.sh；R-2 C2 全量落 `$LOGD/download-verify.log`（run19 我 grep `[cache]`=0 的失明面已愈）；R-3 SKILL.md:36 分轮注记。**diff 与自报一致无夹带** ✓ |
| `bash -n` pkg-root + 八脚本 | 全 OK ✓ |
| `node --test p7-ssh2-conn.test.js` | **12/12** ✓ |
| `npm run gate:quick` | **GREEN，files=14 tests=281**（pkg-root.sh 为 bash 件不在 ts gate 面——已知空白，见 nit-2）✓ |
| fixture 空壳 resolve 亲验 | 独立 bash 现场：三皆空 → `resolve rc=1` 正确 + 三选语文案全打 ✓ |
| 三级优先级亲验 | L1 `env PKG_ROOT`→`来源=env PKG_ROOT`；L2 state→内层根；L3 删状态文件后 probe→内层根；`_pick_pkg_root V1.4.20 strict`→内层；`V9.9.9 strict`→空 rc=1 ✓ |
| fixture undeploy 入口 exit 2 | `DEPLOY_ROOT=<空壳> … bash undeploy.sh --apply` → ⚠告警+三选文+`UNDEPLOY_PKG_ROOT_MISSING` **rc=2**（不静默空壳）✓（注：保底 echo 文案小瑕疵见 nit-1） |

## 三、run20 计时表（14:51:21Z → 15:03:23Z，全程 **12m02s**；串行单轨零并发，未重启 VM）

| 段 | 真实 rc | 墙钟 |
|---|---|---|
| undeploy --apply | **0** | 1m15.8s |
| deploy --apply | **0** | 7m40.3s |
| verify | **0** | 2m40.8s |

step.sh report（steps=20 sum_dur=687s）Top5：
```
226s C3/3.2  prepare-vm --ensure-node + setup（rc=0；`) {,`/MissingExpression grep=0；[DB-5] powercfg DO 行、[DB-6] ALREADY_CONFIGURED 逐行真执行）
147s C5/5    三探针（deploy 轮内全 PASS）
 84s VERIFY/5-example-probe   13/13
 48s VERIFY/5-a2a-probe       5/5
 30s C3/3.0  ENV_PRECHECK 真执行
```
相位：run20 全程 ssh2 路径零 124 零挂死（U0.1/C1 ping 秒级；三段间隔 ~14:51–15:03 UTC 连续开窗无灭相位事件）。

## 四、残留 nits（均不阻断收官）

- **nit-1（低·文案失真）**：undeploy.sh resolve 失败分支 echo「保底用 /storage/Users/currentUser/winvm-deploy/overall-root」——①该保底值硬拼 `$HOME/winvm-deploy`，未随 fixture 注入的 `DEPLOY_ROOT` 变化（实测 fixture 下 echo 真根路径、错误正文却正确显示 fixture DEPLOY_ROOT）；②echo 说「保底用」但下一行即 `exit 2`，保底路径实际从不被使用=误导。建议 echo 改「即将退出」或删保底句。（pkg-root.sh 本体无此问题；verify.sh 的 resolve 失败分支 echo 与行为一致。）
- **nit-2（低·覆盖空白）**：pkg-root.sh 新纯函数（_pick_pkg_root/resolve_pkg_root）无机检（gate 为 node 测面，bash 件不入）。本轮靠 fixture 手验三级链+strict+空壳五场景全过，但回归防护=零。建议后续加 bash 级冒烟（或转 node 测 spawn `bash -c source`）。
- **nit-3（观感）**：verify 的 VM 终态行 CLIXML 进度流噪声（powershell stderr 形态，`tr -d '\r'` 不滤）铺满日志数百字节——run19 已存在，非本轮引入，判据面（PIPESTATUS+grep 内容）正确不受影响。可考虑 `-c` 命令前加 `-NoLogo` 或 stderr 分离。

## 五、四轮验收闭环总表

| 轮 | 判定 | 关键定谳 |
|---|---|---|
| run17 | NO | ssh2 本体合格；D-1 函数缺失被 ssh2 快路径变必现；D-2 delivery 面缺口 |
| run18 | NO | D-1/D-3/D-4 复验 PASS；止血暴露 P-1（陈旧双层包根）/P-2（V1.4.19 副本无 X-5 钉） |
| run19 | NO（原样）/0-0-0（绕行） | P-1~P-5 本体全 PASS；R-1=选根传导未覆盖 undeploy/verify |
| **run20** | **YES** | **R-1 修复原样三段全 0；38/38；矩阵全绿含真 VM 行；steps.tsv 完美账本** |

系统终态：**已部署健康态**（deploy 重装+verify 全绿在位）。skill 侧（VM_SSH_BACKEND=ssh2 全链）验收**关闭**；遗留工程项=D-2（delivery 层 ssh2 化，范围裁定归 team-lead）与三条低优 nit。
