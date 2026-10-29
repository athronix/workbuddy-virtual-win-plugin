# 真机回环报告 · 2026-10-29 run2 —— `.prompt` 第三轮往返验证（V1.4.7 运行态）

> 动因：用户要求「再验证一次 undeploy.prompt 和 deploy.prompt，看是否完美实现卸载和安装及验证」。
> 环境：V1.4.7 包根 `~/winvm-deploy/overall-root`（迭代10 清场重装态）、VM 172.16.100.2。
> 全程严格按两份脚本（undeploy.prompt v1.1 / deploy.prompt v1.1-包内快照）命令原样执行。

## 1. 拆除向（undeploy.prompt U0~U4）—— 完美

| 步 | 判据 | 结果 |
|---|---|---|
| U0.1/0.2 | 免密 whoami rc=0；`WINVM_DRY_RUN=0` | ✅ |
| U0.3 | 基线：三落点目录在、全局键 [winvm, winvm-a2a]、health=200 | ✅ |
| U1 | DRY-RUN 模式行正确；35 项 [DRY]；**全局 mcp.json 两键与 tunnel-autostart 在计划面** | ✅ 逐项不越界 |
| U2/U3 | `--apply` rc=0 | ✅ |
| U4.1 | POST-CLEANUP **19/19 全 [PASS]、零 [FAIL]** | ✅ |
| U4.2 独立复核 | health=**000**、插件缓存 No such file、**GLOBAL_MCP_CLEAN**、connector-winvm=0、winvm/ 仅剩无关 trash 子目录、VM 五连（`.ps1 -File` 正解通道）**False/False/0/Running/True** | ✅ 与脚本预期逐字一致 |

## 2. 部署向（deploy.prompt Step 1.5~6.1）—— 全判据达成，过程抓出 2 个工具面缺陷

| 步 | 判据 | 结果 |
|---|---|---|
| 1.5 | 免密复核 | ✅（按脚本许可跳 Step 1） |
| 2.3 | verify-manifest | ⚠→✅ 首跑 **FAIL**（见 D-1），修复复测 PASS；文件面七件全在 |
| 3.0 | vm-env-check | ✅ ENV_PRECHECK=PASS / BLOCKERS=none |
| 3.1 | .env 八项 | ✅ 逐项符合 |
| 3.2 | plan→apply | ✅ rc=0，VM-START 监听、QA-PROBE 推送 |
| 3.3 | vmcheck | ⚠→✅ 首跑输出 GBK 噪声解析炸（见 D-2），修复后**全判据干净解析**：Running/127.0.0.1×1/side_json/bridge_dir/200/ok=true/session=healthy/54+54 |
| 4.1~4.5 | install-host rc=0（H1 双断言 ✓）；隧道 RUNNING/healthy/ownerMatch/!stale；**FRESH**；health **200**；disabledTools winvm=**8** | ✅ |
| 5.1/5.2/5.3 | mcp **20/20** + a2a **5/5** + example **13/13** | ✅ **38/38 首跑即稳** |
| 6.1 | hos-win SKILL.md 在、连接器 **8** skill | ✅ |

## 3. 本轮抓出的 2 个工具面缺陷（已修 HEAD，均探针面、非产品缺陷）

- **D-1（P2·探针判据失真）verify-manifest.py / verify-release.mjs 对"已安装态包根"假 FAIL**：
  两探针把磁盘上 MANIFEST 未声明文件一律判多余，但**安装体系会往包根自写运行期产物**——`.env`（Step 3.1 用户配置，undeploy U5.5 明文"重装从 Step 2 起"就预设其存在）与 `delivery/winvm-plugin(.cmd)`（install-host→deployWinvmPlugin 管理 CLI 启动器）。前两轮 Step 2.3 从未在已装态根上跑过（10-27 走备份跳过、10-29 run1 在刚解包面跑），本轮按脚本"包已在本地直接 2.3"路径首触暴露。
  修复=两探针 runtime 白名单（`.env`/`delivery/winvm-plugin`/`.cmd`）。**四场景验证**：①已装态包根 PASS ②纯净回环面 PASS（不受影响）③verify-release 已装态 PASS ④**负例 canary（纯净面塞多余文件）仍 FAIL——检出力未削弱**。
- **D-2（P3·探针显示缺陷）vmcheck.ps1 输出非 UTF-8**：PS5.1 双坑——(a) `Invoke-WebRequest.Content` 对无 charset JSON 按 GBK 解码；(b) 重定向 stdout 按控制台码页（zh-CN=GBK）编码中文 health_body → 宿主 UTF-8 消费者解析炸（本轮 position 622 实测）。
  修复=`RawContentStream.ToArray()` 显式 UTF-8 解码 + `[Console]::OutputEncoding=UTF8`（**文件保持 ASCII-only**——首轮带中文注释版 scp 后解析异常，再次坐实"探针 ASCII"规范）。VM 复测：2537 字节全 UTF-8，脚本列出的每项判据可直读。

## 4. 附带观察（非缺陷，已在册口径生效）

- 包内 `deploy.prompt` 快照 `RELEASE_TAG=V1.4.6`（示例值落后一版=自指面），但脚本内"以 latest API 现解为准"指引在（V1.4.7 完善面首战生效）——本轮按其指引以 latest=V1.4.7 为权威，未被陈旧示例误导。

## 5. 结论

- **卸载完美**：19/19 + 独立复核零残留 + VM 五连逐字命中 + OS 级（sshd/密钥/工作区）毫发无损。
- **安装完美**：Step 1.5→6.1 全判据逐条达成、38/38 首跑即稳；两处探针面失真当场根因修复并四场景回归。
- **可交付**：`.prompt` 双脚本在 V1.4.7 运行态第三轮往返 = 卸载/安装/验证全链闭环。

D-1/D-2 修复晚于 V1.4.7 打包（探针在包内分发面）→ 随下一迭代自然收编（同款 I-6.3 路径，非阻断）；证据 `qa/evidence/prompt-rerun-20261029b/`。
