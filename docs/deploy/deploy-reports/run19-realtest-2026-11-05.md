# run19 · 终局全链验收（QA Edward，2026-11-05）

对象：commit **767c4af**（未 push，5 files +117/-16，delivery/ 零改动）——run18 判定 NO 后 P-1~P-5 回修。
视角：独立实跑，未采信自报（含「verify-manifest PASS 两轮」「4/4 钉」等）。
证据：`~/wbtmp/vmdeploy-run19/`（steps.tsv、logs/、undeploy-stdout.log{首轮}、undeploy-stdout-2.log、deploy-stdout.log、verify-stdout.log{首轮}、verify-stdout-2.log）。

## 判定：**NO（按任务书原样命令块：undeploy rc=1、verify rc=2 —— 新阻断 R-1=P-1 选根传导未覆盖 undeploy/verify）**
## 但：**P-1~P-5 五项回修本体独立复验全部 PASS**；绕行（显式 `PKG_ROOT=$HOME/winvm-deploy/overall-root/overall`）后三段真值 **0/0/0，全链功能面收官达成**（deploy 原样即 0，其 C2 自带选根传导）。

R-1 是修复**覆盖面缺口**而非逻辑回归：767c4af 只给 deploy.sh 装了动态选根，undeploy.sh/verify.sh 的 PKG 默认值仍指外层——而 P-1 隔离重解恰恰把外层变成了「只有 .env + overall/」的空壳。一行 helper 共享即闭。

---

## 一、根因独立复核（任务 1，全部亲验）

| 复核项 | 结果 |
|---|---|
| `git show 767c4af` 通读 | 5 files +117/-16 ✓；P-1 隔离（renameSync 整体搬 stale-quarantine，.env 回位时序钉 cp 前 mkdir）+ `_pick_root` 版本==TAG 选根 + cache 快路径（sha 相符免重解）+ .env 下传内层；P-3 PIPESTATUS+内容判；P-4 UHRC capture+HCODE 恒须 000；P-5 begin/end id 配对归一；P-2 回归钉扩展——**diff 逻辑与自报一致，无夹带** ✓ |
| stale-quarantine 隔离亲验 | `~/winvm-deploy/stale-quarantine/` 存在，两份：`overall-root-1793887485`=外层 MANIFEST **V1.4.19**（陈旧复制品本尊）、`overall-root-1793887586`=无外层 MANIFEST 的重解中间态；隔离面自洽 ✓ |
| 当前 overall-root 新鲜度 | 外层仅 `.env + overall/`；内层 `overall/MANIFEST.txt` 首行注释+`version: V1.4.20`+commit 2eedf36 ✓；内层 `grep -c '\.\.\.(\s*ensureNode' delivery/prepare-vm.mjs` = **1** ✓ |
| 亲跑 verify-manifest（对真根） | `MRC=0`，`recomputed … -> MATCH`，**RESULT: PASS**（QA 独立重定向取证，非 tail 假象）✓ |
| `node --test p7-x567-deploy-reports-fixes.test.js` | **4/4 pass**（新 P-2 签名钉：`) {,` 零再现+DB-3 行级独立+源级 `...(ensureNode` 在场）✓ |
| `node --test p7-ssh2-conn.test.js` | **12/12 pass** ✓ |
| `npm run gate:quick` | **VERDICT: GREEN**，files=14 tests=281，ST3 实跑含 p7-ssh2-conn ✓ |
| P-1 根因叙事独立印证 | pkg/ 内 `winvm-overall-V1.4.20.zip{,.sha256}` 在场且 `sha256sum -c OK`；download-verify 独立单跑 → **`[cache] tag=V1.4.20 本地包根完整（…/overall-root/overall）` rc=0 秒出**——cache 快路径与选根逻辑亲验成立 ✓ |

## 二、run19 三段真值

### 任务书原样（14:15:53Z–14:16:13Z / 14:19:23Z–14:27:35Z / 14:28:09Z，零并发、rc echo 直跟命令）

| 段 | **真实 rc** | 墙钟 | 失败点 |
|---|---|---|---|
| undeploy.sh --apply | **1** | 20s | U1 `Cannot find module …/overall-root/delivery/uninstall.mjs`（U1 即时 exit 路径正确生效） |
| deploy.sh --apply | **0** | 8m11s | 无——`DEPLOY_APPLY_DONE PKG_ROOT=…/overall-root/overall`（C2 自动选根传导 ✓） |
| verify.sh | **2** | 0.2s | `包根缺 qa/deploy-probes：…/overall-root`（入口即 fail-fast，正确拒绝空壳外层） |

### 绕行取证（显式 PKG_ROOT=内层真根；同一 run 目录续行，不硬修代码）

| 段 | 真实 rc | 墙钟 | 哨兵 |
|---|---|---|---|
| undeploy --apply（14:17:21Z） | **0** | 1m11.8s | UNDEPLOY_DONE；U0–U4 全 6/6 真 PASS；U4 `health=000(期望000, curl rc=7)` |
| deploy --apply（原样即 0，未复跑） | 0 | — | 同上 |
| verify（14:28:24Z） | **0** | 2m44.6s | VERIFY=PASS；38/38；矩阵全绿含真 VM 行 |

**结论链**：undeploy/verify 的失败与绕过全 0 之间唯一变量=PKG 指向 → **R-1 定谳=包根路径传导缺口，非通道/环境/ssh2 问题**。

## 三、重点盯防项逐一核验（任务书指定）

1. **C2 段（P-1 传导）**：`[C2] 包根=download-verify 最新判定 …/overall-root/overall` → `RESULT: PASS` → `END C2/2 rc=0 PASS dur=2s`——**PASS 且 dur 正常（无空白）** ✓（cache 命中免 500MB 重解，2s 含 verify-manifest 全扫）
2. **C3.2 prepare-vm apply（P-2 传导）**：prepare-vm.log 中 `) {,`/`MissingExpressionAfterOperator` 签名 **grep 计数=0**；DB-5/6 真执行逐行在场（`DB-5 Power => DO powercfg … (idempotent)`、`DB-6 Defender exclusions => DO ensure Add-MpPreference delta` + 远端 `[DB-1] sshd already Automatic [SKIP]` 等逐行输出）；C3.2 **rc=0 PASS dur=231s** ✓——P-2 随 P-1 消解实锤（V1.4.20 恒含 X-5 修复）
3. **P-4 语义（U4 严格 000 判）**：本轮未出现「活端口 200→FAIL」场景——U2 真拆先 kill daemon（apply.log `[DO] killed tunnel daemon pid 33717`），U4 时端口已拆净，`health=000 curl rc=7` 为真不可连形态 → **判据如实计数（000 通过=正确，非吞）**；若 daemon 活着，UHRC/非 000 码必计败（静态复核 diff 语义成立）✓
4. **P-3 复验**：verify VM 行现走 `PIPESTATUS[0]` + `grep -q "VM: task="` 双判，本轮 `VM: task=Running listen=1 sshd=Running` 真行落 `vm-terminal.txt` 且 VERIFY/6 rc=0；且首轮 verify 的 fail-fast（rc=2 入口拒绝）证明无静默通道 ✓
5. **P-5 复验**：steps.tsv 本轮 **零空 dur 行**（对比 run18 三行空白；C2/2、C4/4.1、C4/4.5、C5/5 全部 begin/end 成对且 dur 有值）✓
6. **相位**：run19 全程（14:15–14:31 UTC）ssh2 路径零 124 零挂死；probe/U0.3 baseline/C3.0/C3.3 全秒-分级通过；无灭相位事件需记录
7. **零假 PASS**：steps.tsv 25 行中 FAIL 仅两行=首轮 R-1 真实失败（U1/U2 rc=1），**如实记录非误判**；其余每行均与日志实证对得上（baseline 真 BRIDGE 行、env-check 真 ENV_PRECHECK=PASS、vmcheck 七判据 JSON、U4 真终态行 `False False 0 Running True` 命中期望串）

## 四、Top5 计时表（run19 全 25 步 sum=734s，含首轮失败行与绕行重复行）
```
231s C3/3.2  prepare-vm --ensure-node + setup（rc=0；DB 逐行真执行）
172s C5/5    三探针 38 项（deploy 轮内，rc=0）
102s VERIFY/5-example-probe  RESULT: PASS (13/13)
 36s VERIFY/5-a2a-probe      RESULT: PASS
 30s C3/3.0  ENV_PRECHECK 真执行（14:19:53Z 轮）
```
（注：steps.tsv 为 RUN_DIR 累计账本，含首轮 undeploy FAIL 行与绕行重跑行——聚合 report 出现 U0/U1/U2 双行属预期留痕，非重复计数缺陷。）

## 五、终态矩阵原文（verify 绕行轮，14:31:09Z）
```
FRESH：缓存与仓库构建物逐文件 SHA256 全部一致（"实跑了 install-host 且此后未改 dist"已被当场证明）
winvm disabledTools=8
winvm-a2a disabledTools=0
health=200
connector skills=8
VM: task=Running listen=1 sshd=Running
```

## 六、新缺陷四元组

**R-1（阻断）P-1 选根传导未覆盖 undeploy.sh / verify.sh**
- 现象：任务书原样命令块下 undeploy rc=1（U1 `Cannot find module $HOME/winvm-deploy/overall-root/delivery/uninstall.mjs`）、verify rc=2（`包根缺 qa/deploy-probes：…/overall-root`）；deploy rc=0（C2 自带选根）。
- 根因：767c4af 的隔离重解使真包根=嵌套层 `overall-root/overall`（zip 带 overall/ 前缀），但 undeploy.sh:13 `PKG="${PKG_ROOT:-$HOME/winvm-deploy/overall-root}"` 与 verify.sh:8 同型默认值仍指外层；外层隔离后只剩 `.env + overall/`（无 MANIFEST/delivery/qa）。`_pick_root` 逻辑只活在 download-verify/deploy C2 路径，拆除/验证链无从得知选中根。
- 复现：任务书命令块原样跑（run19 首轮活体即复现，14:16:11Z dry.log/14:28:09Z verify-stdout.log 头行）；绕行 `export PKG_ROOT=$HOME/winvm-deploy/overall-root/overall` 后三段全 0（run19 实测）。
- 影响：默认布局下「拆+验」链必断；deploy→undeploy→deploy 完整往返（本 skill 核心业务动作）在任务书原样面不闭环。
- 建议（工程师一行面）：①undeploy/verify 的 PKG 默认值改为同款 `_pick_root`（外层无 MANIFEST 时探测 `overall/` 内层，或读 deploy 落的 pkg-root 状态文件如 `~/.workbuddy/winvm/pkg-root`）；②短期文档面：SKILL.md/troubleshooting 增「R-1 绕行=显式 PKG_ROOT」一行。p7-x567/p7-ssh2-conn 均无此面覆盖（shell 层无测基，属已知空白）。

**R-2（低·观测面）**deploy C2 内嵌调用 download-verify 时仅 `tail -1` 取末行，`[cache]`/`[quarantine]`/`.env 下传`等信息行全丢（run19 deploy-stdout.log grep `[cache]`=0，独立单跑才有）——C2 排障时看不到「走了 cache 还是重下重解」。建议 deploy.sh 把 download-verify 全量输出落 `$LOGD/download-verify.log` + step log。

**R-3（低·账本语义）**同一 RUN_DIR 下失败轮与重跑轮步骤行混叠（run19 report steps=25 含首轮 FAIL 行），聚合 Top5/sum 会混入重跑双记（如 U0/0.3 出现 14s+13s 两行）。非缺陷（如实留痕），但报告/复盘需按「轮次时间戳」分段读，建议 step.sh 或文档注明轮次分隔实践（如每轮前归档旧 steps.tsv）。

## 七、run18→run19 回修闭环确认
| run18 | 状态 |
|---|---|
| P-1 | **修复生效**（deploy C2 选根 PASS+cache 秒回+manifest PASS 亲验），唯覆盖缺口=R-1 |
| P-2 | **定谳成立且传导生效**（签名零再现+DB-5/6 真执行+C3.2 rc=0）；「不存在第二处裸三元」与 HEAD 源级钉一致 |
| P-3 | **修复生效**（PIPESTATUS+内容判，VM 真行在场） |
| P-4 | **修复生效**（UHRC capture，000 严格判+真拆 kill 证据链） |
| P-5 | **修复生效**（零 dur 空白） |
| D-1/D-3/D-4/N-1/D-8（run17 系） | 持续在位（gate 14 件 281 测含 ssh2-conn 实跑；U0.3/C3.0/C3.3/矩阵真执行） |

## 八、收官建议
系统终态：**已部署健康态**（run19 绕行轮完整 undeploy→deploy→verify，38/38+矩阵全绿+daemon/隧道在位）。R-1 为最小一行面修复（undeploy/verify 选根传导）；修后原样任务书三段应即 0/0/0——QA 复跑成本 ~12min（三段全跑）。P-1~P-5 本体可签收。
