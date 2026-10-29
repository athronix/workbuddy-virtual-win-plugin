# 真机回环报告 · 2026-10-29 run3 —— `.prompt` 第四轮往返（V1.4.8 · I-6.4 修复发布态验证）

> 动因：用户裁定「修复，提交，打包，继续第4轮卸载和安装验证测试」→ 迭代11 · V1.4.8 把 run2 抓出的
> I-6.4 探针双缺陷修复入包收编（pack V9 断言首战），随后用 **V1.4.8 包内探针/安装器**跑完整第四轮往返。
> 环境：包根 `~/winvm-deploy/overall-root` = V1.4.8 匿名回环解包面（v147-backup 留旧、.env 迁移）。

## 1. 发布链（迭代11）

| 环节 | 结果 |
|---|---|
| 先 commit 后 pack | `8929c97`（V9 断言+示例值 V1.4.8+口径文档）→ pack **V1–V9 全绿，V9 三探针首战全过** |
| V9 正反例 | 对 V1.4.7 包根旧探针判 **FAIL（拒产包）**、对 HEAD 修复版判 PASS——若 V1.4.7 时已有 V9 会当场拦截 I-6.4 |
| tag/上架 | V1.4.8@8929c97；双资产；latest API=V1.4.8 |
| 匿名回环 | 三向 sha 一致 `602d303e16baecc4…`（2,852,223 B / 881 / 7620953 / `efb4a6ce…`）；解包核验 runtime_ok×2 / RUNTIME_OK×2 / RawContentStream×1、**包内 deploy.prompt 自记 RELEASE_TAG=V1.4.8（示例误导消除）**；verify-manifest/verify-release 双 PASS |

## 2. 拆除向（undeploy.prompt，包内 V1.4.8 卸载器）

U0（免密 rc=0 / DRY_RUN=0 / health=200）→ U1 DRY-RUN 模式行正确 → U2/U3 apply rc=0 →
U4 **POST-CLEANUP 19/19 全 PASS、零 FAIL** → 独立复核：health=**000**、**GLOBAL_MCP_CLEAN**。

## 3. 部署向（deploy.prompt，包内 V1.4.8 全套）—— 含 I-6.4 修复发布态双首验

| 步 | 判据 | 结果 |
|---|---|---|
| **2.3 ★** | **用包内修复版 verify-manifest.py 跑已装态包根**（run2 假 FAIL 场景） | ✅ **RESULT: PASS**（白名单生效，D-1 发布态闭环） |
| 3.0 | vm-env-check | ✅ ENV_PRECHECK=PASS / BLOCKERS=none |
| 3.2 | deploy-vm plan→apply | ✅ rc=0（4 ✅） |
| **3.3 ★** | **用包内修复版 vmcheck.ps1**：宿主 UTF-8 直读 | ✅ 全判据一行直读：Running / 127.0.0.1×1 / side_json / bridge_dir / 200 / ok=true / **54+54**（D-2 发布态闭环） |
| 4.1~4.5 | install-host rc=0；隧道 RUNNING/healthy/ownerMatch；FRESH；health 200；disabledTools=8 | ✅ |
| 5.1/5.2/5.3 | mcp **20/20** + a2a **5/5** + example **13/13** | ✅ **38/38 首跑即稳**（连续两轮无瞬态） |
| 6.1 | hos-win 在、连接器 8 skill、VM gui.ps1 cbSize×4 | ✅ |

## 4. 结论

- **第四轮 = 迄今最干净的一轮**：零 FAIL、零瞬态、零目视豁免——且两处 ★ 直接证明 I-6.4 修复在发布态生效（装机者用包内脚本/探针即可，无需仓库 HEAD）。
- 卸载/安装/验证在 `.prompt` 纯脚本驱动下**完美实现**（用户问题的正面回答）。
- **当前线上=V1.4.8**；发布链断言面 V1–V9；运行态全绿。

证据：`~/wbtmp/prompt-run3-20261029/`（8 日志，归档 `qa/evidence/prompt-run3-20261029/`）。
