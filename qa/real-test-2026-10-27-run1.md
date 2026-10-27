# 真机回环验收 · 2026-10-27 run1 —— undeploy-prompts ⇄ deploy-prompts 闭环实测

> 目的：对 `docs/deploy/undeploy-prompts.md`（v1.0，当日新立项）与 `docs/deploy/deploy-prompts.md`（v1.5）做**实弹双向回环**：
> 按 undeploy U0~U4 拆除 → 按 deploy Step 3~5 重装（免密通道未动，Step 1/2 可跳）→ 三探针回绿。
> 同时逐条核对两份文档里的判据、命令与输出格式是否与真机一致；不一致即回改文档（本次共修订 10 处，见 undeploy v1.1）。
> 工具链：宿主=鸿蒙 WorkBuddy 沙箱；VM=172.16.100.2（User）；包根=`~/winvm-deploy/overall-root`（V1.4.4，`WINVM_DRY_RUN=0`）。
> 证据日志：`qa/evidence/undeploy-loop-20261027/`（u1-dryrun / u2-apply / u2-apply-fixed / r-setup / r5-mcp / r5-a2a / r5-example / r5-example2）。

## 结论

**回环成立，且抓到并修复了 2 个真缺陷（uninstall.mjs 镜像不对称）。**
拆除（修复后 19/19 全 PASS 零 FAIL）→ 重装 → `mcp 20/20 + a2a 5/5 + example 13/13 = 38/38` 全绿；
**可交付**：两份 Prompt 总集与实现行为一致，undeploy 文档升 v1.1。

---

## U0 · 拆除前置检查

| # | 判据 | 预期 | 实测 | 结果 |
|---|---|---|---|---|
| U0.1 | `ssh -o BatchMode=yes User@VM whoami` | 用户名 + rc=0 | `User` rc=0 | ✅ |
| U0.2 | `.env` `WINVM_DRY_RUN` | `0` | `0`（L51） | ✅ |
| U0.3 | 拆除前基线 | — | 隧道 RUNNING/healthy=true、health=200、全局 mcp.json winvm=disabledTools 8、插件缓存在、**connector-winvm 目录不在 `connectors/skills/`**（该处实测缺失——见"文档差异 D-1"） | ✅ |

## U1 · DRY-RUN 规划（零改动）

| 判据 | 预期 | 实测 | 结果 |
|---|---|---|---|
| 首段 | `mode : DRY-RUN (no changes...)` | 逐字一致 | ✅ |
| 清单不越界 | 只列本项目落点；OS 级/他人 key 不动 | 全部 `[DRY]/[SKIP]/[KEEP]`，头段声明 `ssh keys: NEVER touched`、`workspace: KEEP (default)` | ✅ |
| VM 相位预推 | `winvm-un.ps1` probe-only push 只读 | `[INFO] probe-only push ... MODE=DRY-RUN` + PRE STATUS 如实（BRIDGE_DIR=True/TASK_EXISTS=True/SSHD=Running） | ✅ |
| 尾部 | `DRY-RUN complete: nothing was modified.` | 逐字一致 | ✅ |

⚠ 操作坑（已回写 undeploy §8）：第二轮 uninstall 时 `vm-conn.json` 已被首轮删除 → 必须显式
`--vm-host 172.16.100.2 --vm-user User`，否则 VM 相位 `SKIPPED`+failure。文档 v1.0 未覆盖此场景，v1.1 补。

## U2/U3 · 拆除 apply（宿主 + VM 同次调用）

| 判据 | 实测 | 结果 |
|---|---|---|
| rc=0 + `APPLY complete...verification checklist passed.` | 逐字一致 | ✅ |
| 隧道按记录 PID kill（无 pkill） | `[DO] kill tunnel daemon pid 6277`（命令行精确匹配） | ✅ |
| 宿主删除物移入 trash 非直接 rm | `-> ~/.workbuddy/winvm-trash/2026-10-27T08-59-07-291Z/` | ✅ |
| VM `.ps1` 经 scp + `-File` 执行 | `winvm-un.ps1` pushed；POST STATUS `BRIDGE_DIR=False TASK_EXISTS=False PORT_LISTEN=False BRIDGE_NODE_LEFT=False SSHD=Running WORKSPACE_DIR=True` | ✅ |

## U4 · POST-CLEANUP 核验 —— **抓到两处真缺陷**

首轮 apply 自报 17/17 全 PASS，但按 undeploy §U4.2 做**独立复核**时发现两条残留：

| ID | 缺陷 | 现象（独立复核证据） | 根因 | 严重度 |
|---|---|---|---|---|
| **U-1** | uninstall 不清**全局** `~/.workbuddy/mcp.json` | `LEFT:winvm,winvm-a2a`（winvm disabledTools=8 键完整残留） | `cleanConnectorMcpJson` 只遍历 `connectors/*/mcp.json`（键名 `connector:winvm`）；而 install-host L1237 把**无前缀**键 `winvm`/`winvm-a2a` 注册进全局文件（连接器页面读取面）。安装面有、拆除面没有 = 镜像不对称 | **P2**（残留条目在连接器页显示为无效 MCP；重装时 install-host 幂等合并无实害） |
| **U-2** | `~/.workbuddy/winvm/tunnel-autostart.json` 残留 | 拆除后 `ls ~/.workbuddy/winvm/` 仍见该文件 | install-host L1378 写该标记（SessionStart hook 据此自拉隧道）；uninstall `markers` 数组缺名 → 拆完重开 WB，hooks 会尝试 ensure 一个插件缓存已不存在的隧道 | **P2**（自拉即败不产生黑洞，但属不该有的副作用与残留） |

**修复**（`delivery/uninstall.mjs`，按"修复回源码"纪律）：
1. 新增 `cleanGlobalMcpJson()` + `GLOBAL_MCP_KEYS=['winvm','winvm-a2a']` 常量 + 主流程新相位
   `--- HOST: global ~/.workbuddy/mcp.json winvm entries ---`（备份后再删，dry-run 显示 `[DRY]`）。
2. `markers` 数组补 `tunnel-autostart.json`；两处核验各加一行（清单 17→**19 项**）。
3. 头注同步（落点清单补第 18 项）。⚠ 编码坑实录：新块注释内写了 `connectors/*/mcp.json`，
   其中 `*/` **提前闭合注释** → `SyntaxError: Unexpected identifier '外'`；`node --check` 当场抓住，改 `<acct>` 后过。

**修复复验**：
- 语法：`node --check` OK；单测 `r3-uninstall-verify.test.js` 47/47（import 面零破坏）。
- dry-run：`[DRY] .../mcp.json: remove winvm, winvm-a2a` + `[DRY] delete .../tunnel-autostart.json` + 核验 `[PLAN]` 两新行 ✅。
- apply：**19/19 全 PASS**（`u2-apply-fixed.log`），独立复核 `GLOBAL_MCP_CLEAN`、autostart 消失 ✅。
- 门禁：`npm run gate:quick` **265/265 GREEN**（含 claims-guard/psmod-contract）。

## R · 重装（deploy-prompts Step 3→4，免密通道复用跳 Step 1/2）

`setup.mjs --apply --skip-build`（V1.4.4 包根 `.env`，WINVM_DRY_RUN=0）：

| 相位 | 判据 | 实测 | 结果 |
|---|---|---|---|
| VM 部署 | task Running / 127.0.0.1 监听 / side.json / health | HEALTH 相位 curl `ok:true provider=workbuddy state=ready session=healthy` | ✅ |
| TUNNEL | 复用常驻 daemon 或拉起 | ⚠ 报 `EADDRINUSE 18443`（daemon 自报 healthy 但瞬时黑洞 → 回落自建撞 daemon 已占端口）；**随后 curl /health=200、tunnel status RUNNING/ownerMatch=true 已自愈**。setup rc=1 仅此一步。定性=瞬态竞态，已回写 undeploy §6 排错表 | 🟡→✅ |
| install-host | `--check-fresh` | `FRESH`（187 文件逐 SHA 一致） | ✅ |
| 对账面 | 全局 mcp.json winvm disabledTools=8；连接器 8 skill；hos-win 就位 | `winvm disabledTools=8`、`connector-winvm/`=8、`~/.workbuddy/skills/hos-win-skill/SKILL.md` 在 | ✅ |

## R5 · 全维度复验

| 探针 | 判据 | 实测 | 结果 |
|---|---|---|---|
| `mcp-probe.py` | RESULT: PASS | **20/20 PASS** | ✅ |
| `a2a-probe.py` | RESULT: PASS | **5/5 PASS** | ✅ |
| `example-probe.py` 首跑 | 13/13 | 11/13——E7/E8 FAIL：`PSBRIDGE_EXITED`（stderr 两份「ps-bridge 启动」banner，重装窗口内 ps-bridge 换代竞态；E7 恰 50.5s 超时） | 🟡 |
| 单发重放 E7/E8 ×3 | ok=true | E7 ok=true；E8 run1-3 全 ok=true | ✅ |
| `example-probe.py` 复跑 | 13/13 | **RESULT: PASS (13/13)**（含 E11 键鼠 sent=2 防回归钉、E6 disabledTools=8） | ✅ |

合计 **38/38**；E7/E8 首跑 FAIL 定性=**重启瞬态**（非产品缺陷、非本次修复引入），复跑即稳，已写入排错表。

## 文档一致性核对（两份 Prompt 逐条 vs 真机）

| 项 | 核对结果 |
|---|---|
| undeploy §1/§3/§4 各命令 | 全部可原样执行；DRY-RUN/APPLY 输出与文档引用逐字一致 |
| undeploy U4 核验清单 | **修订**：16~17 项 → 「全 PASS 零 FAIL，动态 16→19 项」；补两条新 PASS 行；§2.3 落点 17→18 项（D-修复） |
| undeploy §7 存留项 | 准确（trash/目录骨架/密钥/工作区均如实保留，实测一致） |
| **D-1** | undeploy §2.3 第 4 行与 U4 写「connector-winvm 8 skill 在 `connectors/skills/connector-winvm/`」——**首轮独立复核时该目录实际不在**（本轮 V1.4.4 重装后为 8，本次运行期来源为 HEAD 安装链），而 uninstall 自报 `[PASS] connectors/skills/connector-winvm absent` 是"不存在=通过"的空真值，**核验清单该条在从未装过/已被历史卸载的场景天然 PASS，不构成安装态证据**。文档补注：该判据须与 U0 基线（存在）配对读 |
| deploy-prompts Step 3~5 | 判据逐字命中（vmcheck 面本轮由 HEALTH 相位覆盖、20/20、5/5）；「隧道末尾自动拉起」实测成立；`--check-fresh` FRESH 面=187 文件（文档 §4.3 未写数字，无冲突） |

## 失败四元组（本轮唯一 apply-rc=1 与首跑 FAIL 项）

| 项 | 现象 | 根因 | 证据 | 处置 |
|---|---|---|---|---|
| setup TUNNEL 相位 | `EADDRINUSE 18443`，setup rc=1 | daemon 正持端口 + 黑洞预热竞态；HEALTH 相位随后 200 证明链路通 | r-setup.log；tunnel status RUNNING/ownerMatch=true | 记排错表（瞬态自愈，无需干预）；观察是否反复（若反复再立 issue） |
| example 首跑 E7/E8 | `PSBRIDGE_EXITED` | 重装窗口 ps-bridge 换代竞态，首调打中换代瞬间 | 双份启动 banner；单发 ×3 全 ok；整跑复跑 13/13 | 记排错表（复跑即稳）；不判缺陷 |

## 发布链影响（须决策）

U-1/U-2 修复晚于 **V1.4.4 打包**（`overall-root` 与 `v144-loop` 包内 `uninstall.mjs` 均无 `cleanGlobalMcpJson`，grep=0）——与 I-6.1 同款「修复晚于打包」盲区，本次由 pack V6 之外的面暴露：**V6 只钉 gui.ps1，uninstall 对称性无机械化断言**。
- 影响面：纯 Release 新装用户执行包内 uninstall → 全局 mcp.json 残留 winvm 键 + autostart 标记（P2，非阻断，重装可幂等自愈）。
- **裁定（10-27 用户同意）**：不单独补发（无阻断），修复随下一迭代自然收编；pack-release 已增 **V7 硬断言**（`overall/delivery/uninstall.mjs` 必含 `cleanGlobalMcpJson`，缺失 fail-loud 拒产包），自 V1.4.5 起每次打包当场核验「修复已入包」，本盲区机械化钉死。
