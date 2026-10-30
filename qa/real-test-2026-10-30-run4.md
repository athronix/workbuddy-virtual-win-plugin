# 真机测试报告 · run4（2026-10-30，迭代12 修复验证——R8 根除实弹）

> 对象：HEAD `eae3a4a`（仓库态，pack 前）——I-6.5 跨壳通道 / I-6.6 zip 兜底 / I-6.7 KEEP 误报修复
> 环境：鸿蒙宿主 ↔ Win11 VM `172.16.100.2`（User）；**VM sshd 默认 shell = cmd.exe（出厂默认，未做任何改动）**——本轮的核心验证面
> 结论：**可交付**。拆除 19/19 零 FAIL（rc=0）、重装全判据、三探针 38/13 复跑全绿；R8 根除实弹成立。

## 1. 健康与连接

| 项 | 结果 |
|---|---|
| 拆除后 18443 | 000（拒连）✅ |
| 全局 mcp.json | GLOBAL_MCP_CLEAN ✅ |
| 重装后隧道 | RUNNING / healthy / ownerMatch / stateStale=false ✅ |
| check-fresh | FRESH（逐文件 SHA256 一致）✅ |
| 宿主 /health | 200 ✅ |
| disabledTools | winvm=8 ✅ |
| VM 侧 | task=Running、listen=127.0.0.1×1、side.json、bridge_dir、health ok=true、caps=54 ✅ |
| gui.ps1 cbSize | ×4（I-6.1 修复运行态在位）✅ |
| 连接器 | connector-winvm=8 + hos-win 用户级 ✅ |

## 2. 拆除向（U0~U4，修复版 uninstall.mjs）

- U1 DRY-RUN rc=0、mode 行正确；U2/U3 `--apply` **退出码 0**、POST-CLEANUP **19/19 [PASS]、0 [FAIL]**。
- **I-6.7 生效**：本轮 VM `C:/WinVMWorkspace` 本就不存在（GUI 线未跑过），KEEP 断言按新逻辑判 SKIP=PASS——修复前该场景必现 `[FAIL]+EXIT=1` 误报（undeploy 复盘 R1）。
- 独立复核：health=000、cache/winvm absent、GLOBAL_MCP_CLEAN、VM 五连经 .ps1 -File（False/False/0/Running/True）。

## 3. 部署向（deploy-vm 新 .ps1 通道 —— R8 根除实弹）

| 步 | 判据 | 结果 |
|---|---|---|
| Step 3.0 vm-env-check（cmd.exe 壳下 -File） | ENV_PRECHECK=PASS / BLOCKERS=none / NODE_OK / CLI_OK | ✅ |
| **deploy-vm --apply**（新 buildVmInstallPs1 通道） | rc=0；`[VM] ✅`（哨兵 VM_INSTALL_DONE 命中才打印）；tar→rm→install-vm→Tee-Object 全程在 **cmd.exe 默认壳** 下一次过 | ✅ **R8 根除实证** |
| VM-START | 端口轮询 ✅ 服务监听 127.0.0.1:18443 | ✅ |
| QA-PROBE | 2 探针 → dev-and-qa/probes（目录治理在位） | ✅ |
| Step 3.3 vmcheck | 全判据 + 54 能力（UTF-8 直读，I-6.4 修复面） | ✅ |
| Step 4 install-host | rc=0 + 4.2~4.5 四判据全绿 | ✅ |
| Step 5 三探针 | mcp 20/20 + a2a 5/5 + example **首跑 12/13（E7 冷态瞬态）→ 复跑 13/13** | ✅ 38/38 |
| Step 6.1 | 连接器 8 + hos-win | ✅ |

## 4. E7 瞬态四元组（非缺陷）

- 现象：首跑 E7 `storage.cleanup.analyze` FAIL（durationMs=45518，EXEC 超时）；E8 同窗 PASS。
- 根因：VM 重装后首轮 ps-bridge 冷启动（能力执行 36~39s 稳态 vs 首跑 45.5s 超探针阈值）。
- 证据：单发重放 ×3 全 ok=true（39.4s/38.1s/36.3s）；整跑复跑 13/13。
- 建议：既有排错口径「首跑瞬态复跑即稳」再次命中，无需改动。

## 5. 通道冒烟（cmd.exe 默认壳五通道）

`.ps1 -File`、`powershell -EncodedCommand`（bootstrap trust/marker 形态）、`powershell -Command "New-Item…"` 裸参数（deployVm mkdir）、`netstat -ano | findstr`（waitForRemotePort）、`Set-Location -LiteralPath`（winvm-plugin 卸载形）——全部实弹通过（见 `qa/evidence/run4-20261030/` 9 日志 + 本会话）。

## 6. 结论

**可交付**。R8（Git-Bash 隐藏前置）在 cmd.exe 出厂默认壳下经全链实弹根除：拆除 rc=0/19/19、重装一次过、38/38。发布态复验（包内 V1.4.9 --wipe 清场重装）见本报告迭代12 台账（ISSUES 迭代12）。
