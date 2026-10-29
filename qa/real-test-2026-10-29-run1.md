# 真机回环报告 · 2026-10-29 run1 —— `undeploy.prompt` ⇄ `deploy.prompt` 纯脚本验证

> 动因：用户要求把 deploy/undeploy 两侧「一键复制给 WorkBuddy」的纯 Prompt（连带运行期环境变量）
> 从文档总集中抽出为独立脚本 `docs/deploy/deploy.prompt` / `docs/deploy/undeploy.prompt`，
> 并**再次用这两个脚本真机验证**拆除与部署全过程。
> 环境：V1.4.5 包根 `~/winvm-deploy/overall-root`（迭代8 清场重装态）、VM 172.16.100.2、宿主鸿蒙沙箱。

## 1. 脚本自纠（执行前发现并修正的口径问题）

| # | 问题 | 处置 |
|---|---|---|
| S-1 | deploy.prompt 初稿 `PKG_ROOT=~/winvm-deploy/overall-root/overall`（按 zip 顶层 `overall/` 直觉写死），与本机既有布局（overall-root 即解平包根）不符 | 改为双布局说明 + `ls $PKG_ROOT/MANIFEST.txt` 判定法；undeploy.prompt 同步对齐 |
| S-2 | undeploy.prompt U4.2 独立复核 VM 面初稿写内联 `powershell -Command` | **违反自家红线**（`$null`/`$_` 被本地 bash 展开→ParserError，strategy §6 血泪坑）——10-27 实测回环当场抓住，改为临时 `.ps1` → scp → `-File` 通道，并在脚本内显式警示 |

## 2. undeploy.prompt 验证结果（拆除向）

| 步 | 内容 | 结果 |
|---|---|---|
| U0.1 | 免密 `whoami` | ✅ rc=0 |
| U0.2 | WINVM_DRY_RUN=0 | ✅ |
| U0.3 | 基线快照（缓存/marketplace/connector/全局 mcp.json 键/health） | ✅ 落点齐全 |
| U1 | DRY-RUN：`mode: DRY-RUN` 开头；**含全局 mcp.json 两键行与 tunnel-autostart 行**（I-6.3 修复的规划面可见） | ✅ 逐项不越界 |
| U2/U3 | `--apply` rc=0；POST-CLEANUP 自报 **19/19 全 [PASS]** | ✅ |
| U4.2 | 独立复核：health=**000**（拒连）、插件缓存 absent、**GLOBAL_MCP_CLEAN**、VM 五连 **False/False/0/Running/True** | ✅ 自报+独立双面对齐 |

## 3. deploy.prompt 验证结果（部署向，Step 1 免密已在→按脚本许可跳过）

| 步 | 判据 | 结果 |
|---|---|---|
| 1.5 | 免密复核 | ✅ rc=0 |
| 2.3 | `verify-manifest.py` | ✅ RESULT: PASS；README/MANIFEST/install-host/deploy-vm/docs 面在 |
| 3.0 | `vm-env-check.ps1` | ✅ **ENV_PRECHECK=PASS / BLOCKERS=none**（nvm v24.21.0、CLI config-dir-present） |
| 3.1 | `.env` 八项（VM_HOST/USER/PORT/DEPLOY_DIR/SERVICE_PORT/PROVIDER/CLI/DRY_RUN=0） | ✅ 逐项符合 |
| 3.2 | `deploy-vm.mjs --skip-build`（规划）→ `--apply` | ✅ rc=0；VM/VM-START/QA-PROBE 全 ✅，监听 127.0.0.1:18443 |
| 3.3 | `vmcheck.ps1` | ✅ task_state=Running / listen 127.0.0.1 ×1 / side_json / bridge_dir / health 200 ok:true / **54/54** / session healthy |
| 4.1 | `install-host.mjs --yes` | ✅ rc=0，H1 断言（活跃账户+default mcp.json 双含 connector:winvm/winvm-a2a） |
| 4.2~4.5 | 隧道 RUNNING/healthy/ownerMatch/!stale；check-fresh **FRESH**；health **200**；disabledTools winvm=**8** | ✅ 四判据全绿 |
| 5.1/5.2/5.3 | mcp **20/20** + a2a **5/5** + example **13/13**（首跑即稳，无 E7/E8 瞬态；E11 键鼠防回归钉真跑） | ✅ **38/38** RESULT: PASS |
| 6.1 | hos-win SKILL.md 存在；connector-winvm = **8** | ✅ |

## 4. 结论

- **两个 `.prompt` 脚本判据与真机输出逐条一致**，可作为「整段粘贴即执行」的交付面；S-2 类内联 PowerShell 坑已在脚本正文内置警示（防复制者踩坑）。
- 拆除 **19/19** + 独立复核零残留 + 部署 **38/38**：V1.4.5 运行态在纯脚本驱动下完整往返闭环。
- 过程瞬态：本轮未复现 TUNNEL EADDRINUSE 与 ps-bridge 换代抖动（排错速查条目仍有效）。
- **可交付**：`docs/deploy/deploy.prompt`、`docs/deploy/undeploy.prompt` v1.0 验证通过。

## 5. 后续（backlog，不阻断）

- 两 `.prompt` 脚本是否并入 `OVERALL_DOCS` 随发布包分发：涉及三元组判据面，**留待下一迭代统一收编**（同 10-28 三篇总集入包的裁定路径），勿单独塞。

证据：`~/wbtmp/prompt-test-*.log`（u1/u23/d32plan/d32apply/d4/d5-mcp/d5-a2a/d5-example 全量日志）。
