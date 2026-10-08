# 技术实现质量与部署运维审计报告（2026-10-08）

> 审计人：寇豆码（software-engineer）｜性质：**只读审计**，未修改任何源码。
> 仓库：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`
> 证据口径：`文件:行号`；`git ls-files`/`git grep` 为检索手段（内置 Grep 对大文件假阴性已用 `git grep` 二次证实）；推测一律标「假设」。
> 语法检查：`node --check` 抽查 10 个 delivery 脚本全部通过（exit 0）。

## 0. TL;DR

整体工程实现质量**高于平均水位**：审批闸（K4/K5）安全语义、审计哈希链 D30 竞态修复、ps-bridge D2 自愈+退避、
`/health` 双段超时护栏（`raceHealthSubProbes`）、TaskStore 审批 TTL 唯一收口点（`settled` 消解竞态）
等关键位置都有明确的"为什么这样写"注释与真实踩坑取证，属于成熟的防御式设计。

本次审计共发现 **54 条问题：0 个 P0、19 个 P1、35 个 P2**，分四域编号
（**ENG** 源码 24 条：10×P1 + 14×P2 ｜ **PSM** PowerShell 6 条：2×P1 + 4×P2 ｜
**DEP** 部署链 12 条：3×P1 + 9×P2 ｜ **OPS** 可观测/运维/宿主约束 12 条：4×P1 + 8×P2），
集中在四类：**长跑资源回收缺失**、**进程间并发模型假设不一致**、**信任边界单薄（含策略层 `..` 绕过，本地已复现）**、
**部署产物无指纹导致"跑的哪版代码"不可证**。以下先列 §1 的 8 条源码 P1 速览，
其余 11 条 P1 见 §0.1、全部 35 条 P2 见 §0.2（三张索引表的编号与正文**逐条一一对应**：ENG 在 §1、PSM 在 §2、DEP-01～10 在 §3、OPS 在 §4；
**DEP-11/12 与 OPS-09～12 例外**——它们是 §5 鸿蒙约束核验时新发现的问题，就地展开在 §5.2/§5.3，编号仍归各自域）。

| # | 级别 | 一句话 | 定位 |
|---|------|--------|------|
| ENG-01 | P1 | `pendingApprovals` 令牌表在非 A2A（纯 MCP）拦截路径下**永不回收**，长跑内存增长且陈旧令牌仍可被批准续跑 | server.ts:766 / 仅 :543 / :864 / :280 三处删除 |
| ENG-02 | P1 | ps-bridge `spawnAndReady()` **重挂** stdout/stderr/exit 监听器且**从不**清理旧进程流；旧进程 `exit` 事件不触发 → 在途请求 `failAll` 丢失 | ps-bridge.ts:146-162（无 removeAllListeners） |
| ENG-03 | P1 | ps-bridge `child` 无 `'error'` 监听器；`stdin.write()` 无回调无 catch → `ready()` 静默空转到超时 | ps-bridge.ts:146-162, 355 |
| ENG-04 | P1 | `server.ts:453` `await runtime.bridge.start().catch(()=>undefined)` 吞掉启动失败，随后 health 子探针又触发 lazy `selfHeal` → **并发 spawn 两个 powershell**（与 D1 单例意图相悖）；且 `restarts++` 在失败路径也自增，语义失真 | server.ts:453 / ps-bridge.ts:229,234 / 376 |
| ENG-05 | P1 | `HttpChannel`（宿主→VM 主传输）**零鉴权**：任意 VM 内本地进程可经隧道调用 L2/L3 能力，审批闸成为唯一防线；`token` 配置项在该通道未被消费 | http-channel.ts（全文无 Authorization 处理）/ core/config |
| ENG-06 | P1 | `GET /audit/receipt` 无 traceId 格式校验直入文件检索；命中壳条目时**全量读取 ≤5000 条审计记录**，可被循环调用放大为 CPU/IO DoS | server.ts:1107-1131（:1117 全量读） |
| ENG-07 | P1 | `readBody` 超 8MB 时 `reject` 后**不销毁连接**（外层 catch 再 `sendJson` 到已 abort 的 res），存在悬挂/异常噪声与半关闭风险 | server.ts:306-322 |
| ENG-08 | P1 | TaskStore `tasks` Map **无任何删除/上限**（长跑泄漏）；LedgerRegistry 有界（maxLive）、ReceiptCache 有界（200），唯委派任务本体无界 | task-store.ts（`this.tasks.delete` 零命中） |

### 0.1 其余 P1 索引（ENG-13/24 + PSM / DEP / OPS 域，正文逐条展开）
| # | 级别 | 一句话 | 定位 |
|---|------|--------|------|
| ENG-13 | P1 | ps-bridge Node 侧**多路复用**（`pending: Map`）与 PS 侧**同步单工**假设不一致 → 排队时间计入每个请求超时，慢调用连带把快调用判成 `PSBRIDGE_TIMEOUT` | `ps-bridge.ts:74-77/349-356` vs `ps-bridge.ps1:273` |
| PSM-01 | P1 | ps-bridge 主循环**同步单工**：一个慢调用阻塞全部后续调用 **且阻塞心跳读取**，与 45s 看门狗叠加即可复现 D31 重生风暴 | `psmod/ps-bridge.ps1:253-284`（心跳块 :278-283 在执行之后） |
| PSM-02 | P1 | Node 侧已在 payload 下发 `timeoutMs`（`ps-bridge.ts:347`），**PS 侧完全不消费** → 超时只是"客户端放弃"，VM 内副作用继续跑且与审计"已失败"语义矛盾 | `ps-bridge.ps1:147-224`（无 timeout 分支）/ `ps-bridge.ts:347` |
| DEP-01 | P1 | 七相位 APPLY **无短路、无相位依赖守卫**：失败只 `failed++` 后继续下一相位，可产出"计数非零但仍声称部署完成"的自洽假成功 | `setup.mjs:1096-1200`（各相位独立 `if (!r.ok) failed++`）、`:1230+` 成功摘要 |
| DEP-02 | P1 | **无部署产物指纹**：MANIFEST 无哈希/rev、`/health` 无 `version`/`buildId`、`agentCard.version` 恒 `0.1.0`、12 个 package.json 全 0.1.0 → "版本指纹 > uptime"口径**当前无代码落点** | `setup.mjs:300-320`；`server.ts:880`、`:982`；`contracts/src/bridge.ts:125`（`HealthStatus` 无 version） |
| DEP-03 | P1 | `.generated/` 运行配置"再生成即覆盖手改补丁"，只能靠**三段顺序铁律**（先部署→后打补丁→再 kill-restart）人工保证 → 应改为声明式 overlay | `install-vm.mjs:713-727`（step 3 无条件 `writeJson(runtimeConfig)`）；`.workbuddy/memory/2026-10-05.md:46-47` |
| OPS-01 | P1 | **全工程无告警出口**：所有异常只落 `logger.warn`/`/health` 被动字段，`pushNotifications:false`（A2A 能力位声明不支持推送），运维必须轮询才能发现问题 | `a2a-framework/src/server.ts:138`；`server.ts:1255-1353`（纯被动） |
| OPS-02 | P1 | `freshChainOnStart:true` 使哈希链校验作用域**止于本次启动**，历史分片"可查但不参与判定" → 跨重启篡改检测不到，而 `/health.audit.chainValid:true` 容易被读成"全链有效" | `chain.ts:311-312`（`this.freshChain ? [...this.activeShards] : await this.listShards()`）、`server.ts:377-382` |
| OPS-03 | P1 | "隧道黑洞"判据（ping 丢包 ∧ ssh 不可达 ∧ 本地 TCP 通 ∧ HTTP 超时）**只存在于文档**；代码里的 `readTunnelStatus` 恰好只看"pid 存活 + 本地端口可连"= 黑洞场景下仍报 RUNNING | `delivery/tools/README.md:35`、`docs/INSTALL-GUIDE.md:297` vs `winvm-plugin.mjs:1016-1038` |
| ENG-24 | **P1（安全，本地已复现）** | 策略引擎 `normalizePath()` **不消解 `.`/`..`**，黑名单与白名单都是纯字符串 glob → `C:\Users\a\..\..\Windows\…` **同时绕过两层**，`appops.cli.invoke` 与 `storage.file.manage` 均实测 ALLOW | `core/src/policy/engine.ts:152-159`（normalize）、`:441-455`/`:484-500`（deny/allow）、`defaults.ts:3-5`（自陈基线） |
| OPS-09 | P1 | core 侧隧道平台判据**漏 `openharmony`**（delivery 四处已修、第五处从未纳入），未设 `WINVM_TUNNEL_BACKEND` 且经 core `ssh-tunnel` 传输时会 spawn 不存在的系统 `ssh`；根因是 AC-B.1 只点名两个文件 | `core/src/transport/ssh-tunnel.ts:68-69` vs `setup.mjs:870-872`/`install-host.mjs:1134`/`winvm-plugin.mjs:374`/`bootstrap.mjs:56`；`CL-020/REQUIREMENT.md:53` |

### 0.2 P2 全量索引（35 条）

| # | 级别 | 一句话 | 定位 |
|---|------|--------|------|
| ENG-09 | P2 | 超时链不一致（10 处不同预算，宿主委派 60s < 内层能力 600s），无端到端预算收敛 | `definitions.ts:56/156/270/273`、`index.ts:39`、`health-probe.ts`、`server.ts:474` |
| ENG-10 | P2 | 审计写失败仅 `warn` 且返回值被 `void` 丢弃，与 ps-bridge 的 D2"失败必须计数并暴露"纪律双标 | `approval-replay.ts:111-114/195-198`、`server.ts:605/790/837` |
| ENG-11 | P2 | `activeTaskId` 同类竞态两处未收敛：`beginTask/endTask` 单槽顺序交叠、`netCfgCache` 预热与上报双写致 `ageMs` 失真 | `server.ts:186-206/427-430/513-518` |
| ENG-12 | P2 | 不安全默认值清单（`freshChainOnStart` 硬编码 true、`/admin` 开启即无鉴权、审计无总量上限） | `server.ts:377-382/1182`、`chain.ts:120` |
| ENG-14 | P2 | `SessionMonitor.probeOnce` 冷启动期防重入失效（`last===undefined` 时仍发完整探针） | `core/src/session/health.ts:81-99` |
| ENG-15 | P2 | `/health.ok` 与"结论未知"耦合：不看 session/audit/logging/probe 超时；契约无 `'unknown'` 态致 `unavailable` 一值三义 | `server.ts:1323`、`health-probe.ts:10-17` |
| ENG-16 | P2 | 审计**无保留期与总量上限**（日志侧 10MB×7/14 天做得很好，形成不对称），磁盘满→取证静默失效而 `ok:true` | `chain.ts:66-82/120/176-197` vs `file-logger.ts:89-90/189-218` |
| ENG-17 | P2 | SSE 流无 `res.on('close')`，宿主断开后 VM 侧委派继续跑到自然结束（"以为取消了还在装软件"） | `server.ts:1215-1231` |
| ENG-18 | P2 | 无 `requestTimeout/keepAliveTimeout` 护栏；`close()` 未 `closeAllConnections` → kill-restart 偶发卡住，`logger.close()` 在其后才执行 | `server.ts:1357-1360/1380-1388` |
| ENG-19 | P2 | 审批卡片与审计脱敏口径分裂（`preview.params` 明文），最危险的 `appops.cli.invoke` 卡片只有 200 字符截断命令行 | `server.ts:1401/1434-1456`、`approval-replay.ts:301-313` |
| ENG-20 | P2 | 纯 MCP 令牌 `hostApproved` 无有效期（TTL 只在有 A2A 任务时生效），可跨策略变更"永远新鲜" | `task-store.ts:257`、`server.ts:751` |
| ENG-21 | P2 | `approvalTruth`/`llmSession` 等纯附加字段两跳透传靠人工记忆（已有真机丢字段实证），无契约测试防呆 | `server.ts:1329-1332`（注释即踩坑记录） |
| ENG-22 | P2 | `appops.cli.invoke`（"任意可执行 + 任意参数"）风险登记为 **L1** → 不触发审批闸，等于在审批体系上开语义旁门（黑名单枚举式防御兜底） | `definitions.ts:344-356`、`policy/engine.ts:597-608/466-481` |
| ENG-23 | P2 | 客户端侧同样**无凭据通路**：`ssh-tunnel` 分支不支持 `tokenEnv`，回环信任从未被显式声明为信任域前提（ENG-05 的另一面） | `core/src/transport/index.ts:50-68`、`host-a2a-bridge/src/cli.ts:96-103` |
| PSM-03 | P2 | `appops.cmd.run`/`appops.cli.invoke`（risk **L1**）是"任意可执行 + 任意参数"通用执行面，防线仅命令黑名单正则 | `definitions.ts:344-356`、`policy/engine.ts:466-481` |
| PSM-04 | P2 | `Import-CapabilityModule` 死分支 + 模块加载失败对调用方不可见（无"模块就绪态"上报） | `ps-bridge.ps1:97-107` |
| PSM-05 | P2 | `Get-RecycleBinInfo` COM 对象未 `Release`（同文件 `appops.ps1:462-463` 有释放纪律，风格不一致） | `storage.ps1:283-290` |
| PSM-06 | P2 | 全局 `Stop` + 大量 `SilentlyContinue` 局部覆盖，掩盖真实失败面（需逐处核对是否都有兜底判断） | `ps-bridge.ps1:35`、`storage.ps1` 多处 |
| DEP-04 | P2 | 二次运行需人工确认两处（计划任务 Delete+Create 之间的失败窗口；`killServiceProcess` 端口占用强杀） | `install-vm.mjs` step 4/5 |
| DEP-05 | P2 | `install-host.mjs` 无构建步骤，仅靠 dist **存在性**校验（:234-236）→ 陈旧 dist 静默安装，无 mtime 防呆 | `install-host.mjs:234-236`、`:934-937` |
| DEP-06 | P2 | `deploy-vm.mjs` 与 `setup.mjs` VM 相位逻辑重复，**判据已分叉**（QA 缺失 `>0` vs `===length`） | `deploy-vm.mjs:152` vs `setup.mjs:1171-1173` |
| DEP-07 | P2 | dry-run 文案"未对任何系统做改动"与实际只读网络探测不符（离线环境变慢） | `setup.mjs:1082-1084` |
| DEP-08 | P2 | 远端 PowerShell 铁律有一处残余内联：`deployVm` 建目录走 `-Command` 单引号拼接 | `setup.mjs:608-615` |
| DEP-09 | P2 | 基线配置只做存在性检查，缺"可解析 + 关键键齐全"前置校验（缺失路径已被 :489-490 防御） | `install-vm.mjs:489-490/502/713-714` |
| DEP-10 | P2 | **新增**：`setup.mjs` / `winvm-plugin.mjs` 多处 `spawn` 裸 `'node'`（非 `process.execPath`），PATH 无 node 时整条部署/管理链报 ENOENT 且失败面含糊（详见 DEP-10） | `setup.mjs:123`、`:562`、`:146`；`winvm-plugin.mjs:940/959/973/982`、`:939`；`install-vm.mjs:647/765`；`bootstrap.mjs:527`；`preflight.mjs:139/157` |
| DEP-11 | P2 | `uninstall.mjs` 写临时 .ps1 **缺少 `/tmp` 只读回落**（`setup.mjs:668-675` 有、它没有）→ 换宿主时"能装不能卸"；本次实测本宿主 tmpdir 可写，故非现役缺陷 | `uninstall.mjs:706-711` vs `setup.mjs:668-675` |
| DEP-12 | P2 | SessionStart 钩子的自愈完全依赖 `CODEBUDDY_PLUGIN_ROOT`，缺失时 `${0%/*}` 回落推导可能错位且**静默 exit 0**（C2 隧道保活的唯一自愈机制无可观测性） | `hooks/session-start.sh:20-28/41-44/47-50` |
| OPS-04 | P2 | ps-bridge 看门狗 ping 超时 5s **不感知在途请求**：慢调用执行期心跳被阻塞（PSM-01），看门狗据此判死并 `restart()` → 自我实现的重生 | `ps-bridge.ts:193-208`（watchdog 不查 `pending.size`） |
| OPS-05 | P2 | 审计检索只有一道窄门（`/audit/receipt?traceId=`），运维排障无"按能力/时间窗/风险级"查询面，只能手抠 JSONL；`query()` 全分片扫描无扫描上界 | `server.ts:1107-1131`、`chain.ts:367-394` |
| OPS-06 | P2 | `/health.ok` 语义过窄且**无 `checks` 汇总位**（ENG-15 的运维面重述）；监控只能各自拼布尔，判据不统一 | `server.ts:1323`、`:1332-1352` |
| OPS-07 | P2 | 升级无版本核验、回滚无版本可回：`update`=重跑 install-host、`reinstall`=uninstall+update，**无"回到上一构建"入口**；备份仅时间戳文件与回收站（DEP-02 的运维延伸） | `winvm-plugin.mjs:968-993`、`install-host.mjs:393/430-436/698-717` |
| OPS-08 | P2 | `logging.degraded` 有透出但无"缓冲丢弃行数/刷盘失败次数"反压指标；日志降级期间取证静默缩水而无人知晓 | `file-logger.ts`（degraded 标志位有、计数无）、`server.ts:1294-1300` |
| OPS-10 | P2 | VM 部署根"安装面默认 `C:/WinVMBridge`"与"运维面默认 `C:/Users/User/.WinVMBridge`"**字面不一致**；`WINVM_VM_DEPLOY_DIR` 全仓仅 1 处读取、零写入点 ⇒ `uninstall --vm` 恒 `cd` 到不存在目录后失败 | `winvm-plugin.mjs:964-966`/`:949` vs `setup.mjs:102`/`env.example:38`/`install-vm.mjs:336`；`install-host.mjs:1332-1347`（持久化字段缺 `deployDir`） |
| OPS-11 | P2 | `WINVM_NODE` 逃生门**已设计但未接电**：启动器/钩子写 `${WINVM_NODE:-node}` 且有单测钉住，但全仓无写入点、profile 注入只加插件目录不加 node、JS 侧 5 处裸 `'node'` 根本不读该 env（`sh()` 不经 shell） | `deploy-winvm-plugin.mjs:140`、`session-start.sh:55`、`launcher-posix.test.mjs:49`（仅 3 处命中）；断链见 `path-util.mjs:26-42`、`winvm-plugin.mjs:940/959/973/982`、`bootstrap.mjs:527` |
| OPS-12 | P2 | 鸿蒙 safe-delete 垫片可 **fail-closed 拒绝删除**，而全部清理点一律 `catch { /* ignore */ }` ⇒ 陈旧 pidfile/state 反复残留、`.setup-tmp/` 永久累积（且未进 `.gitignore`）、`shell-init.sh` 变脏，全线零可见性 | `handover/05:69`/`06:149`/`memory/2026-09-09.md:21`；吞错点 `setup.mjs:345/636/696`、`tunnel-daemon.mjs:183-189/266-267`、`winvm-plugin.mjs:1037/1106/1120`、`path-util.mjs:108`、`uninstall.mjs:520` |

### 0.3 四条横向归纳

1. **长跑回收缺失（ENG-01/08、ENG-16、ENG-02/03）**：一次性/终态对象缺 TTL 与上限是当前最集中的缺陷族；同工程内 `ReceiptCache`(200)、`LedgerRegistry.maxLive`、`file-logger` 7 文件上限都证明作者**会**做有界化，只是没覆盖这三处。
2. **进程间并发模型假设不一致（ENG-13/PSM-01/PSM-02/ENG-02/03/04）**：Node 侧多路复用 ↔ PS 侧同步单工；Node 侧删 timer 放弃 ↔ PS 侧继续执行；Node 侧新 spawn 重挂监听 ↔ 旧进程流永不清理。三条链都指向"缺一层代际(generation)与取消(cancel)契约"。
3. **信任边界单薄（ENG-24、ENG-05/06/07/22/23）**：VM 侧 `127.0.0.1:18443` 无鉴权、无速率限制、无响应侧资源上界；审批闸是唯一防线，而审批闸自身有两处破口——**ENG-24（策略层不消解 `..`，路径黑白名单可同时绕过，本地已复现）**与 ENG-01/20（令牌生命周期），ENG-22 又提供了 L1 免审批的通用执行原语。
4. **可证明性不足（DEP-02/03/05/10、OPS-01/02/03/07）**：MEMORY 中反复出现的"仓库修复 ≠ 运行态生效"（3 次告警）本质是**工程缺"我跑的是哪个构建"的机器可验证证据**，目前只能靠人工字节比对（`docs/changes/CL-020/DEPLOY-VERIFICATION.md:54` 的 B3 项）。第 4 类同时解释了为什么本报告的运维域条目密集——**功能已到位，可证明性与自愈性未到位**。

> **本次审计的覆盖边界（诚实声明）**：`adapter-agent-workbuddy-llm/src/bridge.ts`（1499 行）、
> `persistent-session.ts`（996 行）、`vm-service/src/delegation-audit.ts`（846 行）、
> `core/src/transport/ssh-tunnel-ssh2.ts`（520 行）四个大文件**未逐行深读**（仅 `git grep` 定点核验 +
> 关键段落通读）。§1 的结论不覆盖这四个文件内部的独立缺陷；若需全覆盖建议另开一轮专项（见 §7 R9）。

**部署链与运维面**：`setup.mjs` 七相位 APPLY 是**无短路**顺序执行（失败计数后继续），
故"重跑自愈"能力主要依赖各下游脚本自身幂等——VM 侧（`install-vm.mjs`）幂等较好（先部署→后打补丁→再 kill-restart，
含 `--uninstall` 反向路径与回收站可恢复），宿主侧 `install-host.mjs` 以"增量补丁"为主。
**真正的脆弱点**是 §3 所述："改 dist 必须实跑 install-host 才生效"缺乏防呆校验、`.generated/` 运行时配置的
生成-补丁-重启三段顺序无法声明式回滚（一旦半途失败，运行配置可能与源码不一致且无版本号可核对）。

**鸿蒙宿主约束**（§5）：**文档化 A、代码防御 B+、自动断言 C**。
`getcwd`、`/tmp` 只读、坏 `rm` shim、`node --test` 0xC0000005、无系统 ssh（`oh-tunnel.mjs`）、
`detached` 常驻进程语义都留下了高质量的"文档 + 代码"双侧记载
（其中 `oh-tunnel.mjs:21-30` 的"永不因 emit('error') 崩宿主"契约值得直接复用到其它鸿蒙项目）；
但 §5.3 新查出四条：**core 侧平台判据漏 `openharmony`（OPS-09，P1）**、
VM 部署根两处默认值不一致（OPS-10）、**`WINVM_NODE` 逃生门"已设计未接电"（OPS-11）**、
safe-delete 拒绝删除的后果全线静默（OPS-12）。
根因是**缺一条统一的"环境前提断言"自检**（`preflight.mjs checkHostDeps()` 现仅 2 项，
且 `:77` 用 `void platform` 显式放弃了平台维度）→ 建议方案见 §7 R8b。

**真机相关项**（§6）：本次 VM 172.16.100.2 **未验证**（按要求不长时间重试、且沙箱网络隔离会误导判读），
16 项依赖真机的判定逐条登记在 §6.2；本次新增的本地确定性核验仅有两类：
`node --check` **17/17 通过** + `sh -n` 钩子通过，以及 **ENG-24 的策略引擎纯内存复现**（7 组用例含 3 组对照 DENY）。

---

## 1. 源码实现质量问题清单

### ENG-01｜P1｜审批令牌表存在无界增长路径（非 A2A 拦截路径永不回收）

**现象**
`pendingApprovals` 只有三条删除通道：
1. MCP 续跑成功执行前：`server.ts:864` `if (approvalId) pendingApprovals.delete(approvalId)`
   —— 仅当调用方**带上** `__approvalId` 重发时才删；
2. 服务端重放后一次性消费：`server.ts:280`（协调器 `raise` 内，仅 replay 启用路径）；
3. TaskStore 审批 TTL 超时回调：`server.ts:543`（`onApprovalTimeout` 内 `pendingApprovals.delete`）。

而 `server.ts:766` 的登记发生在 **MCP handler 拦截分支**，该分支**不要求存在 A2A 任务**。
纯 MCP 直调（宿主直接 `/mcp`，无委派回合）被拦时：令牌入表、返回 `APPROVAL_REQUIRED`，
但若调用方**不再带 `__approvalId` 重发**（LLM 换思路、或用户放弃），
则：没有 TaskStore 任务 → 没有 `waitApproval` → **没有 TTL 定时器** → 令牌永久驻留。

**证据**
- 登记：`packages/vm-service/src/server.ts:763-783`
- 删除：同文件 `:280`、`:543`、`:864`
- `grep pendingApprovals` 全仓仅上述命中（`git grep -n "pendingApprovals" -- packages/vm-service/src/server.ts`）
- 对照：`receiptCache`（200 条环形，delegation-audit.ts:65/:689）、`LedgerRegistry.maxLive`（:521 溢出摘除）
  —— **同文件内其他结构均有界，唯令牌表无界**，说明是遗漏而非设计取舍。
- 全仓无任何定时清扫（`git grep -n "sweep\|prune\|stale" -- packages/vm-service/src/server.ts` → 零命中）。

**影响**
1. 长跑内存与参数留存（`PendingApproval` 含完整 `params`，可能带敏感参数明文——虽有 `redact` 在审计侧，**令牌内是原值**）。
2. **安全面**：陈旧令牌的 `hostApproved` 一旦被后续任何路径置真（同一 `approvalId` 被宿主延迟批准），
   即可用旧参数续跑，跨越了"拦截时刻"的策略上下文（策略配置此时可能已变更）。
   缓解：`replay` 段会重新 `policy.evaluate`（:588-597），黑名单命中仍拒——故定为 P1 而非 P0。
3. 运维面：无 `pendingApprovals.size` 观测（`/health` 未透出）。

**修复建议**
- 给 MCP 拦截登记的令牌加**独立 TTL 清扫**：复用 `WINVM_APPROVAL_TTL_MS`，在 ps-bridge 看门狗同级
  加一个 `setInterval(...).unref()` 扫表删除 `Date.now()-createdAtMs > ttl` 并 warn 落痕；
- `/health` 增 `approvals: { pending: n, oldestAgeMs }`；
- （可选）令牌登记时若无活跃 A2A 任务，落一条 `metadata.expiredAtMs`，`collectApprovalFacts`（approval-replay.ts:348）
  据 `nowMs` 过滤已过期的 window 归因项，减少串台误报。

---

### ENG-02｜P1｜ps-bridge 重启路径监听器堆积 + 旧进程 `failAll` 丢失

**现象**
`spawnAndReady()`（`packages/vm-capabilities/src/ps-bridge.ts:132-173`）每次调用都对
**新的** `this.child.stdout/stderr` 挂 `'data'`，对新 child 挂 `once('exit')`。
但：
- **从不调用** `oldChild.stdout?.removeAllListeners()` / 也不置 `null`；
- `kill()`（:400-409）里 `this.child.kill()` 之后**立即** `this.child = undefined`，
  而 `'exit'` 是异步事件，旧 child 对象仍存活并持有监听器。

由此产生两个后果：

1. **在途请求丢失（真机语义偏差）**：`restart()` 路径（:244-267）先 `failAll(...)` 再 `kill()`，
   这条 OK；但 `selfHeal()` 路径（:216-241）在"进程已退出"分支拉起新进程时，
   旧进程 `once('exit')` 回调（:155-162）里 `this.failAll(err)` 会**清掉新进程的 pending 表**
   ——因为 `pending` 是实例级共享 Map，`failAll` 不区分请求归属于哪个子进程。
   注释 :152-153 已经意识到"`exit` 是异步事件…会把新进程误清成 undefined"，
   并只对 `this.child = undefined` 做了 `if (this.child === spawned)` 比对，
   **但同一回调里的 `failAll(err)` 漏了同样的守卫**。
2. **监听器堆积**：反复自愈/重启会在同一事件循环内留下多个未 GC 的 stdout/stderr 流与闭包。
   Node 对单流无上限（`setMaxListeners` 只警告），但旧 ChildProcess 对象及其 `stderrTail` 拼接
   因闭包引用无法回收，构成小幅常驻泄漏。

**证据**
- `ps-bridge.ts:146` / `:147` / `:154-162`（挂载与比对守卫）
- `ps-bridge.ts:329-335`（`failAll` 遍历整个 `this.pending`，无进程归属判定）
- `ps-bridge.ts:400-409`（`kill()` 先置 `undefined`，exit 异步）

**影响**
自愈成功但**新进程上刚发出的调用被误判为 `PSBRIDGE_EXITED` 失败**——
上层看到的是"随机一次调用失败"，与"ps-bridge 已恢复"自相矛盾，排查成本高（正是注释里 D2 想消除的"故障时无从判断"）。

**修复建议**
- `spawnAndReady()` 开头保存 `const prev = this.child`，`await this.ready()` 成功后
  `prev?.stdout?.removeAllListeners(); prev?.stderr?.removeAllListeners(); prev?.stdin?.end()`；
- `failAll` 改为按请求归属分桶：`pending` 的 value 加 `generation: number`（自增的 spawn 代号），
  `failAllForGeneration(gen, err)` 只清对应代；exit 回调携带自己的 gen。
  （此项比 removeAllListeners 更根治，推荐。）

---

### ENG-03｜P1｜ps-bridge 子进程缺 `'error'` 监听 + `stdin.write` 错误静默

**现象**
- `spawn()`（`ps-bridge.ts:136`）返回的 child 只挂了 `stdout/stderr/exit`，**没有 `'error'`**。
  Node 语义：ChildProcess 的 `'error'` 事件无监听器时，底层错误（如 `spawn powershell.exe ENOENT`）
  会作为 **unhandled error event 抛出**，可击穿整个 vm-service 进程。
- `rawCall()`（:355）`this.child!.stdin!.write(payload)` 既无回调也无 `'error'` 监听：
  管道断裂（EPIPE）时错误在下一个 tick 从 stream 冒泡，若 stdin 无 error 监听同样抛出；
  即便被吞，**Promise 只能等到 `timeoutMs` 才 reject**，`ready()` 因此变成
  "每 200ms 轮询、每次都 write 到坏管道"，白等满 60s（`WINVM_PSBRIDGE_READY_TIMEOUT_MS`）。

**证据**
- `git grep -n "stdin\|stdout\|stderr" -- packages/vm-capabilities/src/ps-bridge.ts` 全部命中见上，
  **无任何 `'error'` 监听**（对比 `packages/core/src/transport/ssh-tunnel-ssh2.ts:206` 明确写了
  "挂上 'error' 监听器吞掉 ECONNRESET —— Node net 语义：socket 无 'error' 监听器时错误会抛到调用栈顶层"，
  同一工程内两处纪律不一致）。

**影响**
VM 上 `powershell.exe` 不在 PATH / 被安全软件拦截时：轻则握手静默空转到超时（运维看到的是"就绪超时"
而非"spawn 失败"，误导定位），重则进程崩溃（假设：需真机复验是否真的抛穿）。

**修复建议**
`spawnAndReady()` 加 `spawned.on('error', (e) => { this.lastError = ...; failAllForGen(...) })`；
`rawCall` 用 `this.child.stdin.write(payload, (err) => { if (err) { clearTimeout(timer); this.pending.delete(id); reject(...) } })`。

---

### ENG-04｜P1｜启动期桥接失败被吞，随后并发双 spawn；`restarts` 计数语义失真

**现象（三段）**
1. `packages/vm-service/src/server.ts:453`：`await runtime.bridge.start().catch(() => undefined);`
   —— 桥接启动失败（脚本缺失 / 握手超时）被完全吞掉，紧接着 `loadProvider()` 照常进行，
   `sessionMonitor.start()` 也照常启动。
2. `sessionMonitor` 周期探针 → `PsBridgeSessionProbe.probe()`（`vm-capabilities/src/index.ts:39`）
   → `bridge.call(...)` → `!this.running` 时走 `selfHeal()`（`ps-bridge.ts:376`）
   → **再次 `spawnAndReady()`**。同时 netCfg 预热（`server.ts:512` `runtime.bridge.call('system', 'Get-NetworkConfig', ...)`）
   也走同一条 lazy 自愈。两条链在同一 5s 退避窗口外并发 → **两个 powershell 常驻进程**。
   这与 `server.ts:414-416` 写下的 D1 注释意图（"使其复用同一进程，而不是自建第二个实例"）直接冲突。
   `restarting` 标志（:222/:238）只在单次自愈内互斥，退避窗口（`HEAL_BACKOFF_MS=3000`，:93/:220）
   会让"第二个调用者先返回 false、稍后再试成功"，最终仍是两次 spawn。
3. `selfHeal()` 失败分支也执行 `this.restarts++`（:234），与成功分支（:229）同码
   ——`/health.psBridge.restarts` 无法区分"自愈成功 N 次"与"自愈尝试 N 次全失败"。

**证据**：上述行号；`server.ts:500-526`（预热 fire-and-forget 并发点）；`server.ts:361-370`（monitor 启动）；
`ps-bridge.ts:216-241`（selfHeal 两个 `restarts++`）。

**影响**
- 真机形态：ps-bridge 进程翻倍 → 每个都 dot-source 6 个 psmod（≈6s×N）、内存翻倍；
  两进程各自维护 `Get-SessionHealth`，健康态自相矛盾（正是 D1 注释担心的场景）。
- 观测面：`restarts` 语义污染，运维判断"是否在故障风暴"失准。

**修复建议**
- `start()` 失败改为**记录 `providerError` 同级的 `bridgeStartupError`** 并写入 `/health.psBridge.lastError`，
  而不是 `catch(()=>undefined)`；
- `spawnAndReady()` 在 `this.restarting=true` 之后**先**同步置 `lastHealAttemptMs=now`
  （目前置位发生在 `selfHeal` 入口 :221，`ready()` 期间的并发 `call` 会穿透）；
  更稳妥：`call()` 入口若 `restarting===true` 则**等待**进行中的 ready（`this.readyPromise` 复用）。
- `restarts` 拆分 `healAttempts` / `healSuccess`。

---

### ENG-05｜P1｜能力通道零鉴权：隧道对任何 VM 内本地进程开放

**现象**
- VM 服务仅 `127.0.0.1:18443` 监听（`core/src/config/index.ts:91` 默认值 + `:205-213` 回环校验），
  这一点做得好；但"仅回环"的威胁模型前提是**VM 内没有其他可执行代码**。
- 宿主经 SSH 本地转发把该端口映射到宿主机 `127.0.0.1:<tunnelLocalPort>`。转发是**双向透明**的：
  VM 内任意进程也可以连接 `127.0.0.1:18443` 并直接 `POST /mcp` 调用 `app.winget.install`、
  `storage.file.manage`、`appops.workflow.run` 等 L1/L2/L3 能力。
- `core/src/transport/http-channel.ts`（宿主侧客户端）**全文无任何鉴权头**（`git grep -n "Authorization\|Bearer\|token"`
  在该文件零命中），即服务端也没有校验入口。
- `core/src/config/index.ts` 里 `agent.endpoint: 'http://127.0.0.1:18443/mcp'`（:105）确认端点形状，
  配置面存在 `security.requireLoopbackBind` 但**没有** `security.token` 类字段被服务端消费。

**证据**：`http-channel.ts`（无鉴权）；`server.ts:1059-1212`（路由分发全链路无鉴权检查，
除 `/admin/llm-session/reset` 的 env 门控 :1182）；`server.ts:1098-1105` 注释自陈
"安全边界：与 /health 同级（服务仅 loopback 监听）"。

**影响**
把"VM 内任意本地进程"当作可信调用方。与项目自身的安全叙事（哈希链审计、审批闸、策略黑名单）不对齐：
一旦 VM 内的 LLM Agent（常驻 codebuddy 子进程）被提示注入，它就能**绕过宿主审批卡片**直接打 `/mcp`
——`hostApproved` 只在**已登记令牌**上生效，而攻击者可自己发起调用、拿到 `approvalId`，
再自行以 `__approvalId` 重发：`server.ts:751` 要求 `hostApproved===true`，
而 `hostApproved` 只能由协调器经 A2A `approval.reply` 置真（:255），该 reply 端点同样无鉴权
→ **同机进程可自批自跑**。这是本次最值得主理人判断的一条（是否接受"VM 内即信任域"的模型）。

**修复建议（分档，按 ROI）**
- 低成本：启动时生成一次性 token 写入 `.generated/vm-service.runtime.json`（VM 本地文件），
  隧道建立后由宿主侧经带外通道取回并附 `Authorization: Bearer`；服务端缺省 401。
- 或：给 `/mcp`、`/a2a` 增加"principal 必须是隧道连接"判定（对端地址 + 可选 peername 白名单不足，
  需配合 token）。
- 文档化：若决定接受 VM 内为信任域，请在 `SECURITY-GOVERNANCE.md` 明确写出该边界（目前只写了"零端口暴露"，
  容易让读者误以为已解决本地调用面）。

---

### ENG-06｜P1｜`/audit/receipt` 可被放大为 CPU/IO DoS；traceId 无格式校验

**现象**
`server.ts:1107-1131`：
- `traceId` 直接取 query 参数，无长度/字符集校验，传入 `audit.query({ traceId })`；
- `core/src/audit/chain.ts:372-394` `query()` **没有任何上限**：
  `listShards()` 全部审计分片 → 逐文件 `readFile` **全量读入内存** → 逐行 `JSON.parse` 过滤。
  注意 `filter.limit` 只在**结果集**上做 `slice(-limit)`（:393），不减少读取量。
- 更热的一行：`server.ts:1117` `const allRecords = needExpand ? await audit.query({ limit: 5000 }) : undefined;`
  → 当命中 `delegation-complete` 壳条目时，**再次全量读取所有分片**并解析，然后才 slice 5000。
- 注释自陈"有界：全量查询限量 5000，杜绝无上限扫描（链体量随运行增长）"
  ——**限的是返回条数，不是扫描量**，与注释意图不符。

**证据**：`server.ts:1113-1117`；`chain.ts:366-394`（`readFile` 全量 + `slice(-limit)`）。

**影响**
审计目录按天轮转 + 64MB/片（`chain.ts:120`），无保留/清理策略（见 ENG-16）。
运行数月后单次 `/audit/receipt` 可能读入数百 MB、阻塞事件循环数十秒；
loopback + 隧道使其可被宿主侧误用（脚本循环取证）放大。定为 P1（非恶意前提下的可用性风险）。

**修复建议**
- `query()` 加**扫描上限**：倒序读文件、按行 `indexOf(filter.traceId)` 预筛后再 `JSON.parse`，
  并支持 `maxBytesScanned`；
- `/audit/receipt` 对 `traceId` 做 `^[\w.-]{1,128}$` 校验并限长；
- 或改为维护 `traceId → {shard, offset}` 索引（内存有界 LRU），彻底消除全量读。

---

### ENG-07｜P1｜`readBody` 超限后连接未销毁，且外层 catch 会对已终止响应二次写

**现象**
`server.ts:306-322`：超过 `maxBytes` 时 `reject(new Error('请求体过大'))` + `req.destroy()`。
随后 `server.ts:1082`（`/mcp`）或 `:1134`（`/a2a`）的 `await readBody(req)` 抛出，
被 `:1207` 的 `catch` 捕获，执行 `sendJson(res, 500, {...})`
—— 此时请求已被 destroy，`res` 多半不可写，Node 会产生
`ERR_STREAM_WRITE_AFTER_END`/`EPIPE` 类噪声（`res.writeHead` 在已关闭 socket 上不抛但静默失败）。
另外：**没有请求体大小/超时的整体护栏**（无 `req.setTimeout`、无 `headersTimeout`），
慢速 POST（slowloris 形态）会长期占用连接。

**证据**：`server.ts:306-322`、`:1082`、`:1134`、`:1207-1210`；全文件无 `server.timeout` /
`headersTimeout` / `requestTimeout` 设置。

**影响**
超限请求的响应语义不确定（客户端可能收到 202/空/连接重置）；日志噪声；
连接面缺乏 idle 超时（假设：Node 18+ 默认 `requestTimeout=300s`、`headersTimeout=60s` 提供部分兜底，
故定 P1 偏低而非 P0）。

**修复建议**
`readBody` 超限时改为 `sendJson(res, 413, {...})` 后 `req.destroy()` 并**标记已应答**
（如返回 `{ handled: true }`），外层 catch 先 `if (res.headersSent) return res.end()`。
显式设 `server.requestTimeout` / `server.headersTimeout` 并在 `config` 里可配。

---

### ENG-08｜P1｜TaskStore 任务本体无界（长跑内存泄漏）

**现象**
`packages/a2a-framework/src/task-store.ts:85` `private readonly tasks = new Map<string, InternalTask>()`；
`git grep -n "this.tasks.delete\|tasks.clear" -- packages/a2a-framework/src/task-store.ts` **零命中**
→ 任务创建后永不摘除。`create()` 在每次 A2A 委派调用；`InternalTask` 持有
`task.history`（`appendHistory` :159-163 每次追加并复制数组）、`artifacts`（base64 截图等大对象）、
`subscribers: Set`。审批有 TTL（:92-97）、账本有 `maxLive`（delegation-audit.ts:521）、回执有 200 环（:65），
**唯委派任务本体无界**。

**影响**
vm-service 是常驻进程（计划任务双触发器长跑）。截图类 artifact 单张 base64 可达数 MB
（`gui.screen.capture` `asBase64`），数十次委派即数百 MB 常驻。
这会让"服务越跑越慢/内存高"成为无日志可归因的运维谜团。

**修复建议**
终态任务（`completed/failed/canceled/rejected`）保留窗口化回收：
`setTimeout(...).unref()` 扫 `isTerminalTaskState` 且 `now - status.timestamp > TASK_RETENTION_MS`（默认 30min）删除；
`artifacts` 落库时剥离 base64 正文只留 `kind/name/mime/bytes`（`/audit/receipt` 已有"字段级重建"先例可复用）。

---

### ENG-09｜P2｜超时链不一致：多处硬编码、无端到端预算收敛

**现象（逐项，均为证据行号）**
| 层 | 超时 | 位置 | 备注 |
|---|---|---|---|
| 能力声明 | `cap.timeoutMs` 默认 30s，最长 **600s**（winget install/upgrade/workflow） | `vm-capabilities/src/registry/definitions.ts:56`、`:156`、`:270`、`:273` | 由 provider 透传 |
| ps-bridge 默认 | 30s | `ps-bridge.ts:99` | |
| ps-bridge 单次 ready ping | 3s | `ps-bridge.ts:282` | |
| ps-bridge 握手总预算 | 15s 默认 / env 60s | `ps-bridge.ts:276` | install-vm 侧设 60000 |
| 看门狗 ping | 5s | `ps-bridge.ts:198` | |
| 会话探针 | **20s**（硬编码） | `vm-capabilities/src/index.ts:39` | 与 `gui.session.status` 声明的 20s 一致但与护栏 5s 冲突 |
| /health 子探针护栏 | **5s** 默认 env 可覆盖 | `server.ts:1256` + `health-probe.ts` | 小于探针自身 20s → 常态性截断（设计如此，已有 `probe:'timeout'` 标注） |
| netCfg 预热 | 60s（专用） | `server.ts:511-512` | |
| 审批 TTL | 30min | `task-store.ts:92-97` | |
| 宿主 A2A 委派等待 | 60s（A5 默认，注释所述） | `server.ts:474` 注释 | **< 内层 workflow 600s** |

**关键不一致**：宿主侧一次委派的等待预算（≈60s）远小于其内部可能触发的能力超时（600s），
且 ps-bridge `call()` **没有"服务端权威超时"**——超时后 Node 侧只是 `pending.delete(id)` 后 reject
（`ps-bridge.ts:350-353`），**PowerShell 侧并不知晓**，被调函数继续跑到自然结束。
后果：① 该调用对应的 `PSBRIDGE_TIMEOUT` 只是"客户端放弃"，VM 内副作用仍在发生（与审批/审计"已失败"的语义矛盾）；
② 请求 id 已删，函数最终输出到达时 `dispatch` 找不到 waiter 被静默丢弃（:323 `if (!waiter) return`）；
③ 后续调用继续复用同一串行 PowerShell 工（见 ENG-13），形成排队。

**修复建议**
- 把 `timeoutMs` 一并下发（**已经在 payload 里带 `timeoutMs`**：`ps-bridge.ts:347` —— 但 ps-bridge.ps1
  **未使用它做任何取消**，见 ENG-13）；PS 侧对可中断长任务实现协作取消或至少在超时时落一条
  `CANCELED_BY_CALLER` 诊断，供审计对齐。
- 端到端预算收敛：`runGoal` 收到宿主 budget 后，取 `min(budget_remaining, cap.timeoutMs)` 下发内层调用
  （`persistent-session` 已有 `ensureReady(budgetMs)` 的预算语义，可推广到 ps 调用层）。

---

### ENG-10｜P2｜"仅 warn 落痕"的 best-effort 审计写失败：已知案例复现于三处同构代码

**现象**
`vm-service/src/approval-replay.ts:111-114`（blocked）、`:195-198`（policy-denied）
在审计写入失败时 `logger.warn(...)` 后返回 `{ok:false}`，**调用方忽略返回值**：
`server.ts:790`、`server.ts:837`、`server.ts:605` 三处均为 `void recordXxxAudit(...)`。
即"取证写失败"这件事只存在于服务日志，**不进入任何可查询的健康/告警面**。

设计上"拦截语义优先"是对的（注释也讲清了），但缺一条：失败计数不暴露。
对照 `ps-bridge.ts:260-263` 的 D2 纪律（"重启失败必须计数并暴露，禁止静默吞掉"）——
同一工程内对"失败的可见性"存在两套纪律。

**证据**：`approval-replay.ts:111-114`、`:195-198`；`server.ts:605`、`:790`、`:837`（`void` 前缀丢弃返回值）。

**修复建议**
`auditWriteFailures` 计数器 + `/health.audit.writeFailures`（与 `chainValid` 并列）；
连续 N 次失败升级为 `logger.error` 并置 `/health.ok=false` 的 degraded 原因。

---

### ENG-11｜P2｜单例竞态同类项：`VmApprovalCoordinator.activeTaskId` 之外的两处

**现象**
`activeTaskId` 的并发交叠问题已由 P1-Fix 处理（`server.ts:186-206`：`req.taskId` 优先、
`endTask(taskId)` 归属比对）——修复质量高。但同类"服务级单例 + 并发请求"模式仍有两处未收敛：

1. **`approvalCoordinator.beginTask/endTask` 与 A2A runner 的配对**：
   并发两条委派时，若某条走 `beginTask(A)` → `beginTask(B)` → `endTask(A)`（顺序交叠），
   活动槽停在 `B` 而 A 已释放——注释承认此为"保持不动"的保守策略（:194），
   但**A 的 raise 若不携带 `req.taskId`**（旧调用方、或桥未透传）就会错挂到 B 的审批槽。
   建议：`beginTask` 改为**栈/引用计数**（`Map<taskId, depth>`）而非单槽。
2. **`netCfgCache` 与 `reportNetCfg` 双写**：
   `server.ts:427-430`（provider 回调写 `collectedAt`/`ok`）与 `server.ts:513-518`
   （预热成功写 `warmedAtMs`/`ok`/`collectedAt`）**并发**写同一对象（预热 fire-and-forget 期间，
   用户请求可已完成并上报更新的 collectedAt）。
   后果：`ok` 被预热路径回写为 true 且 `collectedAt` 可能被**较旧**值覆盖 → `/health.cache.netCfg.ageMs` 偏大。
   属观测面失真（非功能错误），P2。
   建议：`reportNetCfg` 单调写（仅当新值 > 旧值才覆盖），预热路径只写 `warmedAtMs` 不写 `collectedAt`。

---

### ENG-12｜P2｜不安全默认值清单（工程卫生）

| 项 | 值 | 位置 | 评估 |
|---|---|---|---|
| `server.host` | `127.0.0.1` | `core/src/config/index.ts:91` | ✅ 良好（回环默认 + `requireLoopbackBind` 校验 :205） |
| `audit.maxFileBytes` | 64MB/片，**无总量上限、无保留期** | `audit/chain.ts:120` | ⚠ P2：磁盘无限增长（见 ENG-16） |
| `freshChainOnStart` | 硬编码 `true`（不可配置） | `server.ts:377-382` | ⚠ P2：注释理由充分（历史断链），但导致**每次重启链基线重置**，跨重启取证必须靠归档分片人工拼接，且 `chainValid` 只覆盖本轮 → 运维易把"valid"误读为"全链有效" |
| 审批重放开关 | 默认 `on`，`off` 回退 K4 | `server.ts:1055` `resolveApprovalReplay()` | ✅ 灰度合理，但非法值回退 `on`（fail-tight，正确） |
| `/admin` 端点 | env `WINVM_ADMIN_ENDPOINT`，默认关 | `server.ts:1182` | ✅ 门控合理；但故障注入端点**一旦开启即无鉴权**（ENG-05 同源） |
| `ErrorActionPreference='Stop'` | ps-bridge 全局 | `psmod/ps-bridge.ps1:35` | ✅ 良好（配合 StrictMode V1 的取舍有注释 :30-33） |

---

### ENG-13｜P1｜ps-bridge 请求**串行单工**（与 PSM-01 同源，本条记 Node 侧责任）

**现象**
Node 侧 `PsBridge` 是**多路复用**设计（`pending: Map<id, waiter>`，`ps-bridge.ts:74-77`、
`rawCall` 并发写 stdin :337-357），但 PS 侧主循环是**单工**（`ps-bridge.ps1:253-284` 同步执行）。
两侧对并发模型的假设不一致：Node 侧允许任意数量在途请求，PS 侧一次只处理一个。
因此"并发调用"实际是"入队 + 全部按最慢的那个计时"，而 Node 侧每个请求各自持有 `timeoutMs` 计时器
（:350）→ **排队时间计入调用超时**，慢调用会连带把后面本可快速返回的调用判为 `PSBRIDGE_TIMEOUT`。

**证据**：`ps-bridge.ts:349-356`（每请求独立 timer）；`ps-bridge.ps1:273`（同步分发）；
`definitions.ts:156/:273`（600s 能力存在）。

**影响**：① 排队放大超时（假失败）；② `pendingCount` 有透出（`server.ts:1283` `psBridge.pending`）
但**没有队列等待时间指标**，运维看不出"是调用慢还是在排队"；③ 与 PSM-01 的心跳阻塞叠加成 D31 形态。

**修复建议**
- 短期：Node 侧对**长时能力**（`timeoutMs > heartbeatTimeoutMs`）在发送前登记"预期占用窗口"，
  看门狗据此顺延（见 PSM-01 建议 1）；
- 中期：`/health.psBridge` 增 `pendingMaxAgeMs`（最老在途请求等待时长）与 `pendingByTimeout`（最久预算），
  把"排队"变成可观测事实；
- 长期：PS 侧 Runspace 池（`runspace` 并发 2~4）或按模块分队列（gui 单工、其余可并发）。

---

### ENG-14｜P2｜`SessionMonitor.probeOnce` 并发早退返回 `undefined` 快照缺失（小缺陷）

**现象**：`core/src/session/health.ts:82`
`if (this.probing) return this.last ?? (await this.probe.probe());`
—— 已有探测在飞时，若 `this.last` 为 `undefined`（首次探测尚未返回），
**仍然会再发起一次完整探针**，即"防重入"在最需要它的冷启动阶段失效。
冷启动阶段正是 `server.ts:453`（provider 加载）+ `:455`（`sessionMonitor.start()`）+
`:505-526`（netCfg 预热）+ `:1258`（`/health`）并发触碰 ps-bridge 的时刻，与 ENG-04 的并发 spawn 相互放大。

**证据**：`health.ts:81-99`、`server.ts:453/455/505/1258`。

**影响**：多一次 20s 级探针调用与一次 lazy 自愈尝试（`ps-bridge.ts:376`），
在 ready 后是无害冗余，在冷启动期是资源争抢源。

**修复建议**：`this.last === undefined && this.probing` 时返回一个
`{ state:'unavailable', detail:'首次探测进行中' }` 轻量快照，或复用进行中的 Promise（`this.inflight ??=`）。

---

### ENG-15｜P2｜`/health.ok` 语义与"结论未知"耦合，且 `ok` 不体现会话/审计状态

**现象**
`server.ts:1323` `ok: provider !== undefined && bridgeHealth.state === 'ready'`
—— `ok` 只看两件事（provider 已加载 + 桥进程 ready），
**不看**：会话是否可用（GUI 门禁的真实前提）、审计链是否有效（`audit.chainValid`）、
日志是否降级（`logging.degraded`）、`psBridge.probe==='timeout'`。
同时契约 `SessionState`（`contracts`）**没有 `'unknown'`**，超时只能用 `'unavailable'` 表达
（`health-probe.ts:13-14` 注释坦承"契约 SessionState 无 'unknown'，'unavailable' 语义即『本次未取得结论』"）——
即主理人点名的已知 P2 在代码里是**有意识的妥协**，而非疏漏。

**证据**：`server.ts:1323`、`:1332-1352`；`health-probe.ts:10-17`、`:40-46`、`:49-60`；
`contracts/src/bridge.ts:125`（`HealthStatus` 定义处）。

**影响**
- 监控侧用 `/health.ok` 做存活判据时，"会话不可用（GUI 全废）"与"链断裂（取证失效）"
  都是 `ok:true` → 不会触发任何告警；
- `'unavailable'` 一值三义（真的无交互会话 / 探针未接入 / 本次超时未知），
  只能靠 `detail` 文本区分（`health-probe.ts:58` 的中文 detail）——**结构化字段退化成日志**。

**修复建议**（低成本、高收益）
1. `/health` 增 `checks: { provider:..., bridge:..., session:..., audit:..., logging:... }`
   与 `ok = 全绿`（纯附加字段，不改既有 `ok` 语义可分两步：先加 `checks`，再在下一大版本收紧 `ok`）；
2. `SessionState` 增可选 `'unknown'`（属"纯附加"纪律允许的范围，`contracts/src/bridge.ts:53` 已确立
   "以下类型全部为纯附加"的写法）；`timeoutSessionSnapshot` 改回 `state:'unknown'`，
   保持 `guiAllowed()` 判定不变（`health.ts:42` 要求 `=== 'healthy'`，天然不受影响）。

---

### ENG-16｜P2｜审计/日志保留策略不对称：日志有 7 文件上限，审计**无总量与保留期**

**现象**
- `core/src/file-logger.ts:89-90`（默认 10MB × 7 文件）+ `:100`（启动即清理）+
  `:152-155`（跨天切换顺手清理）+ `:189-218`（节流的"文件数与天数双上限，超限删最旧"）
  —— **日志侧做得很好**，是标准答案级别的实现。
- `core/src/audit/chain.ts:120`（`maxFileBytes` 默认 64MB）只有**单片**阈值轮转，
  **没有** `maxFiles` / 天数保留 / 总量上限；`listShards()` 只增不减（:176-197）。
  审计是 append-only 合规资产，"自动删最旧"确有争议（与不可篡改性叙事冲突），
  但**当前形态是"无限增长直到磁盘满"**，而磁盘满会让服务写日志与审计双双失败
  （`FileLogger` 会自行降级 `degraded=true`，`server.ts:1294-1300`；审计侧 `append` 抛错
  → 被 `recordXxxAudit` warn 吞掉，见 ENG-10 → **取证静默失效而服务仍 ok:true**）。

**证据**：`chain.ts:66-82`（`AuditChainOptions` 无 retention 字段）、`:120`；
`file-logger.ts:29-31/89-90/189-218`。

**修复建议**
加 `audit.maxTotalBytes`（默认如 2GB）：超限时**不删**，而是
① 停止写入并把 `/health.audit` 标 `degraded:true, reason:'QUOTA_EXCEEDED'`（告警可见）；
② 或"归档压缩 + 移出活动目录"（保留合规、释放活动面）。
两条都比"静默写失败"好。同时 ENG-10 的失败计数器让这条链路可观测。

---

### ENG-17｜P2｜`SSE` 流式响应无客户端断开处理，委派在后台继续

**现象**：`server.ts:1215-1231` `writeSse` 用 `for await` 写事件；
未注册 `req.on('close')` / `res.on('close')`，也不 `break` 迭代。
客户端（宿主）断开后，`res.write()` 返回 false 但不抛错，迭代继续消费
`a2a.handleStream(...)` 直到任务自然结束。

**证据**：`server.ts:1156-1163`（调用点）、`:1215-1231`（实现，无 close 处理）。

**影响**：宿主取消/超时后 VM 侧委派继续跑（含其内层能力调用）→
"用户以为取消了，VM 里还在装软件"。属语义正确性问题，非崩溃；P2。

**修复建议**：`const abort = () => iterable.return?.(); res.once('close', abort)`；
或给 A2A `tasks/cancel` 与 SSE 断开统一走 `taskStore.requestCancel`（:183-195 已有取消语义，复用即可）。

---

### ENG-18｜P2｜`server` 无空闲/慢请求护栏，`close()` 不切断在途连接

**现象**
- `server.ts:1357-1360` 仅 `server.once('error', reject)` 后 `listen`，无 `server.requestTimeout`/
  `headersTimeout`/`keepAliveTimeout` 显式设置（依赖 Node 默认，见 ENG-07）；
- `close()`（:1380-1388）`await new Promise(resolve => server.close(() => resolve()))`
  —— `server.close()` **不关闭已建立的 keep-alive 连接**，Node 18+ 需 `server.closeIdleConnections()`
  或 `closeAllConnections()`。配合隧道/HTTP 客户端的 keep-alive，服务退出（kill-restart）时
  可能卡在 `close()` 回调不返回，最终被 `schtasks` 强杀 —— 表现为"重启偶发慢/审计未 flush"。
  （`logger.close()` 在 `server.close()` **之后**，若 close 卡住则最后一段缓冲日志丢失。假设，需真机验证。）

**证据**：`server.ts:1357-1360`、`:1380-1388`（顺序：monitor → provider.shutdown → bridge.stop →
server.close → logger.close）。

**修复建议**：`server.closeAllConnections?.()` 后 `await server.close()`；
`logger.close()` 用 `finally` 保证无论前面哪步抛错都执行。

---

### ENG-19｜P2｜`collectImpact` / `deriveUnderlying` 的信息量与脱敏边界（审批卡片可读性）

**现象**
- `server.ts:1434-1456` `collectImpact` 只对"像路径的值"入清单（盘符/UNC/注册表前缀正则），
  采集不到时退化为"列出所有标量参数"（:1448-1453）—— 这条退化**未经 `redact`**，
  而 `approval-replay.ts:301-313` `summarizeParams` 是**逐值 `redact(v,k)`** 的。
  两处同为"给人看的参数摘要"，脱敏纪律不一致 → `preview.params` 本身
  （`buildPreview` :1401 **原样透传 params，未脱敏**）已含明文，故 `impact` 不脱敏并未新增暴露面，
  但**审计侧脱敏、卡片侧明文**这一分裂值得记录（卡片走宿主通道，属可控面；
  若未来把 impact 落审计或转储日志，会成真实泄露点）。
- `deriveUnderlying`（:271-284）对 `workflow` 型壳能力"尽力推断内层目标"，
  但 `appops.cli.invoke` 的 `command`/`arguments`（`definitions.ts:344-356`）
  不在 `firstCapLike` 的键集（`capabilityId|capability|tool|action`）里 →
  最危险的"任意 CLI"能力的卡片**只有一条长 command 文本**（靠 `summarizeParams` 截断到 200 字符）。
  人工审批看到 200 字符截断的命令行，判断质量有限。

**修复建议**：为 `appops.cli.invoke` / `appops.workflow.run` 定制 `impact` 提取器
（提取可执行文件名 + 全部路径 token，`extractPathTokens` 已在 `policy/engine.ts` 存在，可复用），
并给 `buildPreview` 的 `params` 走 `redact`（与审计同口径）。

---

### ENG-20｜P2｜`exposedCapabilities` 与令牌表的能力漂移（服务不重启时策略/注册表变更不反映到在途令牌）

**现象**：`replay`（:690-707）会校验 `exposedIds.has(capabilityId)` 与 `capabilityDefs.get(...)`
—— 做得对。但 `PendingApproval.params` 是拦截时刻的**深引用**（未结构化克隆，:770 直接存 `rest`），
`rest` 来自 handler 入参，后续无人改写，风险低；
真正的问题是 **`hostApproved` 无有效期**（ENG-01 的另一面）：
30 分钟 TTL **只在存在 A2A 任务时**才生效（`task-store.ts:257`），
纯 MCP 令牌可"永远新鲜"，跨过 VM 侧策略热改（若未来支持）或风险等级重新评估。

**修复建议**：随 ENG-01 的清扫一并做；顺带把令牌登记时刻的策略 `matchedRule` 一起留存，
重放时若 `matchedRule` 变化则**要求重新审批**（防止"低危时刻批准、重放时已按高危配置运行"的口径漂移）。

---

### ENG-21｜P2｜`approvalTruth` / `llmSession` 等纯附加字段的透传完整性依赖人工记忆

**现象**：`server.ts:1329-1332` 有一条真实踩坑记录：
"CL-K3R E-3（纯附加）：…… 此处不透传就会在最后一跳被丢弃（T05 真机实测命中：
`/health.provider` 缺 `approvalTruth` ⇒ shadow 轮不可证）"。
这说明"provider 侧新增观测字段 → vm-service `buildHealth` 必须手工透传"是一条**易漏的两跳链**，
目前无自动化防护（无契约测试断言字段集）。

**修复建议**：加一条单测（不起服务）：对 `providerHealth` 快照对象做键集白名单断言，
新增字段必须同时出现在 `buildHealth` 输出的期望清单里 —— 低成本防呆，符合本仓"纯附加纪律"。

---

### ENG-22｜P2｜`appops.cli.invoke` 是"任意可执行 + 任意参数"面，风险登记为 **L1**
**现象**：`registry/definitions.ts:344-356` 把 `appops.cli.invoke` 登记为 `risk: 'L1'`，
绑定 PS 侧 `Invoke-AppCli`（`psmod/appops.ps1:242-249` 的 `custom` 分支 + `:272-283` 的
exe 绝对路径解析 + `:289-301` 的 `ProcessStartInfo`）。
按 `riskAtLeast(req.risk,'L2') && !approved → requiresApproval` 的闸口径
（`policy/engine.ts:597-608`），**L1 不触发审批**，即该工具可被宿主侧 LLM 直接调用执行任意本地程序。

**缓解（已存在，故仅 P2）**：
① `COMMAND_KEY_RE`（`engine.ts:106`，含 `command|arguments`）会把 `command`/`arguments` 键
纳入命令黑名单扫描（`engine.ts:466-481`），`Invoke-Expression`/`-enc`/`FromBase64String` 等在
`policy/defaults.ts` 黑名单内；② `processDenylist` 与路径黑名单同样适用；
③ `appops.ps1:266-269` 显式拒绝 node/python 空参（避免落进 REPL 挂死）。

**残余风险**：黑名单是**枚举式**防御，`cmd.exe /c <内建>`、解释器脚本文件路径、
或"白名单内 exe + 危险参数"（如 `curl` 写盘、`reg` 改键）不必然命中；
而 L2/L3 的能力恰恰都要求审批。把"通用执行器"定级为 L1，等于在审批体系上开了一个语义旁门。
（与 PSM-03 同源：PSM-03 记 PS 侧实现面，本条记**风险定级**这一决策。）

**修复建议**：把 `appops.cli.invoke` 升为 `risk: 'L2'`（默认要求审批），
或拆成 `appops.cli.invoke.known`（白名单 winget/npm/pip 等，L1）+ `appops.cli.invoke.custom`（L2）；
同时给策略引擎补一条"参数中含绝对路径 / `-c` `/c` 类传递执行"的启发式加严规则。

---

### ENG-23｜P2｜`HttpJsonRpcChannel`（宿主→VM）不附带任何凭据，回环信任完全外溢给隧道
**现象**：`core/src/transport/index.ts:50-68` 建立 `ssh-tunnel` 传输时，
`HttpJsonRpcChannel` 只带 `baseUrl`（`http://127.0.0.1:<localPort>`）与可选 `headers`，
`createA2aClient` 的调用点（`host-a2a-bridge/src/client.ts:59-64`）**不传** `headers`；
`host-a2a-bridge/src/cli.ts:96-103` 的 `buildTransport` 注释明写
"回环（SSH 隧道映射到本机）无需 bearer token；仅显式 `--token-env` 时才带凭据"。
连接器落地的 mcp.json 亦只有 URL、无 Authorization（`adapter-host-workbuddy/src/index.ts:117-123`）。

这与 ENG-05 是同一枚硬币的两面：ENG-05 讲**服务端**（VM 内任意本地进程可直连 `:18443`，零鉴权），
本条讲**客户端**（宿主侧同样无凭据可带，因此将来即便服务端加鉴权，
现有传输层也没有传递凭据的通路）。当前 `streamable-http` 分支支持 `tokenEnv`
（`index.ts:70+`、`contracts/src/transport.ts:32`），说明机制存在，只是 `ssh-tunnel` 分支未接。

**影响**：安全边界完全等价于"127.0.0.1 回环 + 单用户机器"这一假设。
该假设在本项目里通常是成立的（VM 与宿主各自单用户），但**从未在代码或文档里被显式声明为信任域前提**。
**修复建议**：① 在 `ssh-tunnel` 分支同样支持 `tokenEnv`，VM 侧 `HttpChannel` 消费
（与 ENG-05 合并实施）；或 ② 若决定"回环即信任"，则把它写成一段明确的信任域声明
（`docs/design/` 或 `INSTALL-GUIDE` 安全节），并让 `/health` 透出 `auth: 'loopback-trust'`
以便审计时知道"这里没有第二道门"。

---

### ENG-24｜P1｜策略引擎**不做 `..` 消解**，点穿越可同时绕过路径黑名单与白名单（本地已复现）

**现象**
`normalizePath()`（`core/src/policy/engine.ts:152-159`）只做三件事：正斜杠→反斜杠、
折叠重复分隔符、去尾分隔符 —— **不解析 `.`/`..` 相对段**（全仓 `git grep -n "node:path"`
在 `packages/core/src/policy/` 零命中，即策略层从未引入 `path.resolve`/`path.normalize`）。
而黑名单（`:441-455`）与白名单（`:484-500`）都是**纯字符串 glob 前缀比对**
（`globToRegex` `:31-50`，`pathMatchesAny` `:141-145`）。
于是 `C:\Users\a\..\..\Windows\System32\x.dll` 既匹配不了 `C:\Windows\**`（黑名单不命中），
又匹配得上 `C:\Users\**`（白名单命中）→ **两层同时放行**。

**证据（本地纯内存复现，未触碰 VM；用 `packages/core/dist/policy/engine.js` 直接 `evaluate`）**

| 用例（capabilityId / 参数路径） | 结果 | matchedRule |
|---|---|---|
| `storage.file.manage` / `C:\Windows\System32\drivers\x.sys` | **DENY**（正确） | `pathDenylist:^C:\\Windows\\.*$` |
| `storage.file.manage` / `C:\Users\a\..\..\Windows\System32\drivers\x.sys` | **ALLOW**（绕过） | `allow:policy-passed` |
| `appops.cli.invoke` / `-y C:\Users\a\..\..\Windows\System32\evil.dll` | **ALLOW** | `allow:policy-passed` |
| `appops.cli.invoke` / `-y C:/Users/a/../../Windows/System32/evil.dll`（正斜杠同形） | **ALLOW** | `allow:policy-passed` |
| `appops.cli.invoke` / `-y C:\Temp\..\Program Files\x\y.exe` | **ALLOW** | `allow:policy-passed` |
| `appops.cli.invoke` / `-y D:\other\x`（对照：无穿越） | DENY | `pathAllowlist:miss` |
| `appops.cli.invoke` / `-y C:\PROGRA~1\x\y`（8.3 短名，对照） | DENY | `pathAllowlist:miss` |

`normalizePath('C:\\Users\\a\\..\\..\\Windows')` 原样返回，`extractPathTokens`
也如实把穿越串整体抽出（`:123-137`）—— **提取环节是对的，缺的是归一环节**。
配套检索：`git grep -rln "traversal|穿越|dotdot"` 在 `tests/`、`docs/`、`packages/` **零命中**，
`tests/unit/policy.test.js` 无含 `..\` 的用例 ⇒ **无任何测试或文档覆盖该攻击面**。

**影响**
1. 违背 `defaults.ts:3-5` 自陈的安全基线（"拒绝优先…命中即拒；未命中白名单同样拒绝"）：
   `pathDenylist` 声称覆盖 `C:\Windows\**`、`C:\Program Files\**`、`C:\ProgramData\**`、UNC 等
   （`:33-48`），**全部可被 `..\` 前缀改写绕过**；
2. **影响所有能力**，非只 `appops.cli.invoke`（上表已用 `storage.file.manage` 复现同一绕过）；
   命令串内嵌路径同样绕过（`pathCandidates` `:356-363` 抽出 token 后走同一比对）；
3. 与审批卡片的可读性叠加成**误导型审批**：预览/`buildPreview`（`server.ts:1394+`）显示的是
   字面路径，人看到的是"C:\Users\…开头"，容易判为安全而批准，实际落点是系统目录；
4. 与 PSM-03/ENG-22（任意执行原语 L1）叠加时**不新增**攻击面（同调用方已可执行任意程序），
   但它击穿的是"防误操作护栏"这一层——而这一层正是本项目对 LLM 的主要防线；
   对"宿主 LLM 被提示注入后写坏 VM 系统目录"这一威胁模型，护栏当前**形同不存在**。

**定级说明**：P1 而非 P0 —— 触发前提是调用方本身已是攻击者/被注入方（同 ENG-05 的信任域假设），
不构成远程可达的独立漏洞；但它是**可确定性复现的安全控制失效**，且与文档叙事直接冲突，故列 P1。

**修复建议**（单点改动，收益覆盖全链）
1. `normalizePath()` 引入 `node:path`：先 `replace(/\//g,'\\')`，再用
   `path.win32.normalize()`（或手写 `..` 折叠：逐段处理，`..` 出栈、遇根则钳制）
   得到**消解后的绝对形态**，黑名单与白名单都基于消解结果比对；
   注意保留现有"UNC `\\` 前缀不被折叠"与"根路径不吞"两个既有正确行为（`:155`）。
2. 归一后若仍以 `..` 开头（越出根）→ **直接 `POLICY_DENIED`**（fail-closed），不要猜工作目录。
3. 可选加严：额外拦 8.3 短名（`~1`）与大小写/重解析点差异——当前 `globToRegex` 默认不区分大小写
   （`:31` 参数 `caseSensitive=false`），短名已由上表证明会被白名单拒（保守失败，可接受），
   但归一后建议对 `~` 形态做警告而非放行。
4. **必须补测**：在 `tests/unit/policy.test.js` 增一组穿越用例
   （`C:\Users\a\..\..\Windows\…` 期望 `pathDenylist:*`；正斜杠同形；`C:\Temp\..\Program Files\…`），
   并在 `SECURITY-GOVERNANCE.md` 记录"路径判定基于消解后形态"这一契约（本次缺陷的本质是
   文档说"命中即拒"、代码做的是"字符串像不像"）。
5. 与 §4 OPS-02/ENG-22 一并处理：策略层加一条"参数含 `..` 且解析后落在原串所属目录之外"
   的启发式，作为审批卡片的**显式风险提示**（让人看到"C:\Users\… 实际写入 C:\Windows\…"）。

---

## 2. PowerShell 模块审计

审计范围：`packages/vm-capabilities/psmod/{ps-bridge,system,app,appops,storage,gui}.ps1`（合计 3485 行）。



### 2.1 总体评价：**良好**，已知陷阱均有"注释 + 反例固化"的双重防呆

| 维度 | 结论 | 证据 |
|---|---|---|
| BOM | ✅ 6 个 ps1 **全部带 UTF-8 BOM**（`efbbbf`），PS 5.1 中文注释必需 | `head -c3 psmod/*.ps1 \| xxd` 全部命中 |
| 严格模式 | ✅ `Set-StrictMode -Version 1`（**刻意不用 Latest**，注释说明可选属性缺失会被 Latest 打成整类失败） | `ps-bridge.ps1:30-34` |
| 错误偏好 | ✅ 全局 `$ErrorActionPreference='Stop'`；局部降级显式 `-ErrorAction SilentlyContinue`（共 36 处，均为"可选信息探测"语义） | `ps-bridge.ps1:35`；计数：app 10 / system 10 / storage 9 / gui 5 / appops 1 / ps-bridge 1 |
| 输出流纪律 | ✅ stdout 只写协议 JSON（`Write-ProtocolLine`），诊断一律 stderr；警告流 `4>&1` 被捕获转 `warnings[]` 而非污染 data | `ps-bridge.ps1:45-57`、`:180-185` |
| 换行消毒 | ✅ `ConvertTo-Json -Compress` 后再 `\r`/`\n` → 空格替换，保证 NDJSON 单行 | `ps-bridge.ps1:49` |
| 参数绑定错误归一 | ✅ 按**异常类型**（`ParameterBindingException` 族）判定并归一为 `INVALID_ARGUMENT`，明确拒绝"消息文本模糊匹配"（跨语言不可靠） | `ps-bridge.ps1:59-75`、`:204-214` |
| PS 5.1 `Sort-Object` 裸键陷阱 | ✅ **已根治且写了防回退注释**：4 处 `[ordered]@{}` 列表排序全部改脚本块访问器 + 显式 `[double]` 强转；1 处对 `FileInfo` 保留裸键并注释说明"该场景有效" | `storage.ps1:106-109`（含"切勿改回 `-Property sizeMB`"）、`storage.ps1:324-329`（反向说明）、`system.ps1:156`、`app.ps1:64`、`app.ps1:199` |
| 输出泄漏陷阱 | ✅ `CloseWindowStation` 返回值用 `[void]` 吸收，注释记录真根因（哈希表与 bool 合并成数组导致 `state` 恒 unavailable） | `gui.ps1:42-46` |
| 子进程 stdin 死锁 | ✅ `Invoke-AppCli` **立即关闭**子进程 stdin（D3 死锁根因），并用 `ReadToEndAsync` 避免管道写满死锁；超时 `taskkill /T /F` 杀树（PS 5.1 无 `Kill($true)`） | `appops.ps1:310-322` |
| 编码写入 | ✅ 显式 `UTF8Encoding($false)` 无 BOM 写文件，注释说明 PS 5.1 `Set-Content -Encoding UTF8` 会加 BOM 导致读回 `\ufeff` | `storage.ps1:150-155` |
| 交互式会话铁律 | ✅ 模块头与 `Get-SessionHealth` 都写明 Session≥1 / WinSta0\Default；`explorerAlive` 参与判定 | `gui.ps1:6`、`:40-54` |

### 2.2 发现的问题（PSM-xx）

#### PSM-01｜P1｜ps-bridge 主循环**串行单工**：一个慢调用阻塞全部调用 + 心跳
**现象**
`Invoke-BridgeRequest`（`ps-bridge.ps1:147-224`）在主循环内**同步**调用目标函数
（`$resp = Invoke-BridgeRequest -Request $req`，:273），期间：
- 不读 stdin，不检查 `ReadLineAsync` → 后续请求只在 Node 侧 `pending` Map 里排队；
- 心跳块（:277-283）位于 `if ($pending.Wait(1000))` **之后**，主循环阻塞在函数体内时
  **心跳完全发不出去**。

能力超时上限是 **600s**（`registry/definitions.ts:156` `app.winget.install`、`:273` `app.winget.upgrade`），
远超 Node 侧 `heartbeatTimeoutMs=45_000`（`ps-bridge.ts:100`）。

**后果链（推导，标假设需真机复验）**
一次 winget install（>45s）→ 无心跳 → Node 看门狗判定僵死 → `rawCall('__meta','ping',{},5000)`
（`ps-bridge.ts:198`）：ping 请求入 `pending` 但 PS 仍在忙 → 5s 超时 → `restart('ping 超时或失败')`
（:206）→ **kill 掉正在执行 winget 的 powershell，同时在途的 600s 调用被 `failAll` 判失败**。
VM 内 winget 进程为其子进程：`child.kill()` 只杀 powershell 不杀树（无 `/T`）→ 可能留下**孤儿 winget 继续安装**，
而调用方已收到 `PSBRIDGE_HEARTBEAT_TIMEOUT`，两侧状态永久不一致。
（旁证：项目自身已把类似形态记录为 **D31「ps-bridge 重生风暴致 vm-service 监听消失」并"记录不修"**
—— `docs/changes/CL-017/REQUIREMENT.md:488`、`CL-018/REQUIREMENT.md:200`。本条给出的是 D31 的一条**可解释因果链**。）

**修复建议（低成本，三选一或组合）**
1. 看门狗加"有在途请求即顺延"判据：`if (this.pending.size > 0 && now - lastResponseAtMs < 当前请求 timeoutMs + 余量) return;`
   —— 用**在途请求自身声明的超时**替代固定 45s，是最小改动的正解；
2. 或 PS 侧改为 `Invoke-BridgeRequest` 后台 Job / Runspace 执行，主循环只负责心跳与分发（改动大，收益也大）；
3. 至少：`restart()` 前先检查 `this.pending.size`，非空则只 warn 不 kill。

#### PSM-02｜P1｜`timeoutMs` 下发但 PS 侧完全不用；超时语义两侧不一致
**现象**：Node 侧把 `timeoutMs` 放进请求帧（`ps-bridge.ts:347`），`ps-bridge.ps1` **没有任何一处读取
`$Request.timeoutMs`**（`git grep -n "timeoutMs" -- psmod/ps-bridge.ps1` 仅命中文件头协议注释 :10）。
即：超时只是客户端放弃等待，PS 侧继续执行到自然完成；完成后的响应因 `id` 已从 `pending` 删除而被
`dispatch` 静默丢弃（`ps-bridge.ts:323`）。
**影响**：① 审计/回执记"失败"，VM 实际"成功执行"（副作用真实发生）——这是**假失败**，与项目花大力气根治的
"假成功"（K3/K5）互为镜像，同样破坏取证一致性；② 后续调用被排队（PSM-01）。
**修复建议**：PS 侧对可中断长任务实现协作取消（或至少在超时时写一条 `CANCELED_BY_CALLER` 诊断行到 stderr）；
Node 侧超时响应到达时应落一条 `late_response_dropped` 日志（当前是完全静默）。

#### PSM-03｜P2｜`appops.cli.invoke` 是"任意可执行文件 + 任意参数"的通用执行面
**现象**：`Invoke-AppCli`（`appops.ps1:236-353`）接受 `App='custom'` + `Command="<exe> [args...]"`，
`ConvertTo-AppCliArgumentList` 分词后直接进 `ProcessStartInfo.Arguments`（:291，逐参数
`ConvertTo-AppCliQuotedArg` 加引号）。
**评估**：**没有** `Invoke-Expression`，也没有拼进 `cmd.exe /c`（这点做得好——`git grep -n "Invoke-Expression"`
全仓仅命中 `core/src/policy/defaults.ts:79`，且是**黑名单项**，说明策略层已把它视为危险词）；
逐参数引用也规避了经典注入。因此不构成注入漏洞，但它本质是**任意代码执行原语**：
- exe 解析仅校验"存在"（`Get-Command` / `Test-Path`，:274-283），无路径白名单；
- 风险等级与审批：**已核验为 `L1`**（`registry/definitions.ts:345-347` `appops.cli.invoke`
  `risk:'L1'`、`timeoutMs:600_000`、`policy.pathAllowlist=['%USERPROFILE%\\WinVMWorkspace\\out',
  'C:\\WinVMWorkspace\\out']`）→ **不触发审批闸**（`engine.ts:597-608` 要求 `riskAtLeast(...,'L2')`）。
  定级问题另见 **ENG-22**；该能力配合策略层未消解 `..` 的绕过见 **ENG-24**。
**建议**：给 `custom` 模式加可选的命令白名单（env 或配置项，如 `WINVM_CLI_ALLOW`），
并在策略引擎层对该能力路径参数加入黑名单（当前黑名单已有 `Invoke-Expression`，可同处扩展）。

#### PSM-04｜P2｜`Import-CapabilityModule` 是死分支 + 模块加载失败对调用方不可见
**现象**
- `Import-CapabilityModule`（`ps-bridge.ps1:97-107`）在 `LoadedModules` 命中时 `return $true`，
  **否则无条件 `throw "MODULE_NOT_PRELOADED"`**——文件存在性检查（:103-105）与
  `Join-Path $PSScriptRoot "$Name.ps1"` 构成不可达分支（永远走不到"运行时按需加载"）。
  这是有意的（注释 :226-231 解释了函数作用域 dot-source 的坑），但函数名与参数语义（`-Name` 按需导入）
  与实现不符，易误导后续维护者以为可以热加载。
- 启动期 dot-source 失败只 `Write-Diagnostic`（:239-242）**不记录到任何结构化状态**，
  `ping` 只回 `loaded = @($script:LoadedModules.Keys)`（:123）——Node 侧从不消费 `loaded`
  （`ps-bridge.ts` 的 `ready()` 只看 `res.ok`），因此**一个能力模块加载失败 = 该域全部能力
  运行时报 `UNKNOWN_FUNCTION`**（:172-177），且 `/health` 完全不体现。
**影响**：VM 上 Defender/AMS 拦截或语法兼容问题导致某模块加载失败时，故障表现为"函数不存在"，
定位会跑到注册表/命名上去。
**修复建议**：`ready()` 里比对 `loaded` 与期望模块集（6 个），缺失即 `logger.error` 并写入
`/health.psBridge.loadFailures: string[]`；`Import-CapabilityModule` 改名 `Assert-CapabilityModuleLoaded`。

#### PSM-05｜P2｜`Get-RecycleBinInfo` COM 对象未释放
**现象**：`storage.ps1:283-290` `New-Object -ComObject Shell.Application` 后不 `ReleaseComObject`、
不进 `try/finally`；同文件 `:294-342` `Get-CleanupSuggestions` 又调用它一次（叠加
`Get-ChildItem -Recurse` 全用户目录扫描，声明超时 120s）。
对照 `appops.ps1:462-463` 明确做了 `$app.Quit()` + `Marshal::ReleaseComObject` —— 同一工程两处纪律不一致。
**影响**：常驻 ps-bridge 内 Shell.Application 每次泄漏一个 RCW 直至 GC，配合 `Get-ChildItem -Recurse`
在超大用户目录上的枚举，属于长跑内存/CPU 抖动源（假设，需真机压测）。
**修复建议**：COM 部分按 `appops.ps1` 先例加 `finally` 释放；`Get-CleanupSuggestions` 的大文件扫描
加"目录数上限 / 早停"参数。

#### PSM-06｜P2｜`$ErrorActionPreference='Stop'` + 大量 `SilentlyContinue` 的取舍面
统计显示 36 处 `-ErrorAction SilentlyContinue`，抽样判断均为"可选属性/可选源探测"
（如 `Get-Disk`/`Get-Volume`/注册表卸载键枚举），语义合理；但需注意：
`ps-bridge.ps1` 把**任何**非终止错误也随 `4>&1` 之后的管道处理，
`Write-Error` 在 SilentlyContinue 下会**静默消失**（既不进 `warnings` 也不进 error 包）。
**建议**：把 `warnings` 通道同时接收 `ErrorRecord`（用 `2>&1` 且只转不丢），
或在能力契约里要求探测分支显式 `Write-Warning` 而非依赖默认行为。（低优先，属可观测性打磨。）

---

## 3. 部署链健壮性

范围：`delivery/setup.mjs`(1315) / `install-host.mjs`(1353) / `install-vm.mjs`(848) /
`deploy-vm.mjs`(172) / `uninstall.mjs`(936) / `winvm-plugin.mjs`(1361) / `tunnel-daemon.mjs`(299) /
`bootstrap.mjs`(598) / `preflight.mjs`(234) / `path-util.mjs`(254) / `oh-tunnel.mjs`(736) / `ssh2-resolve.mjs`(139)。

### 3.1 做得好的部分（明确肯定，避免误伤）

1. **dry-run 优先且语义统一**：`setup.mjs` / `deploy-vm.mjs` / `install-vm.mjs` / `install-host.mjs`
   均以"无 `--apply`/`--yes` 即只规划"为默认（`setup.mjs:1072`、`deploy-vm.mjs:98-107`、
   `install-host.mjs:803`），且 dry-run **绝不高调 spawn**（`install-host.mjs:1190` 注释把它标为铁律）。
2. **卸载安全性**：宿主侧"先备份 → 改 → 打印 diff → `--yes` 才移入回收站"，
   且注册文件写前一律 `*.winvm-bak.<ts>`，绝不整体覆盖用户既有白名单
   （`install-host.mjs:430-436`、`:393`、`:455`、`:621/:645/:668` diff 打印、`:698-717` `--purge-backups`）。
   VM 侧卸载用"移入 `.uninstall-trash/<时间戳>/`"而非物理删除（`setup.mjs:1124`）。
3. **失败归因文案质量高**：`setup.mjs:1208-1216` HEALTH 失败时区分"本地隧道端口没监听"与
   "端口通但 HTTP 无响应"，并直接给出隧道黑洞处置命令；`install-vm.mjs:692-696`
   把"软链失败 → 服务无法解析 @winvm/*"的后果写在错误消息里。
4. **重试策略有实证依据**：`install-vm.mjs:759-771` 自检最多 3 次（注释给出"本 VM 上 spawn
   powershell 进程创建延迟 10s~60s+，Defender/AMSI 逐进程扫描"的真机取证）；
   `setup.mjs:1197-1236` HEALTH 两段式（传输级 4 次 + 载荷级 10s×≤6 退避重探，D15）。
5. **隧道 daemon 生命周期成熟**：`tunnel-daemon.mjs:178-217` SIGTERM/SIGINT + `uncaughtException`/
   `unhandledRejection` 双兜底（明确"单次 ssh 错误不得整进程退出"）+ `giveup` 有序退出并清 pidfile
   （:254-269）+ `writeStateAtom` 原子写状态 + `keepAlive.unref()` 的注释解释（:288-290）。
   `winvm-plugin.mjs:1001-1038` 的 pidfile/state 属主交叉校验（D6-B：陈旧 state 绝不参与健康决策）
   是很成熟的判活设计。
6. **鸿蒙沙箱自适应**：`setup.mjs:668-676` 写 `os.tmpdir()` 失败时**回落项目内 `.setup-tmp/`**
   （注释"部分沙箱 /tmp 只读"）—— 这正是本次审计环境事实的代码化防御。

### 3.2 问题清单

#### DEP-01｜P1｜七相位 APPLY 无短路/无依赖守卫 → 半途状态可自洽地"假成功"
**现象**
`setup.mjs:1098-1250` 的 APPLY 主循环对每个相位独立 `failed++` 后**继续下一相位**，
不存在"前置相位失败即跳过后继"的守卫。可构造的半途状态：
- `VM`（部署）失败 → `VM-START` 仍执行：对**旧版本**产物做 kill+`schtasks /Run`（`setup.mjs:1141-1163`），
  端口能起来 → `HEALTH` 通过 → 整体打印"部署完成"，但**新代码根本没上 VM**。
  `docs/changes/CL-K3R/QA-REPORT.md:35` 已经把这条写成红线：
  "**必须先部署，否则真机跑的是旧代码，任何『验证通过』都是假的**" —— 而脚本自身不阻止这种误判。
- `TUNNEL` 失败 → `HEALTH` 必然失败，但错误文案（:1212）能正确归因，属可接受；
- `HOST` 失败 → 后续 VM 相位照常执行，出现"VM 新、宿主插件旧"的版本错配（见 OPS-04 无版本核验）。

**证据**：`setup.mjs:1098-1164`（无 `if (failed) break/continue-skip` 逻辑）；
`deploy-vm.mjs:122-147` 独立子脚本**是有短路的**（每步失败即 `process.exitCode=1; return`）
—— 说明"短路"是团队认可的语义，只是总一键脚本没实现。

**修复建议**
1. 相位依赖图 + 守卫：`VM` 失败 ⇒ `VM-START`/`HEALTH` 标 `SKIPPED (前置失败)`；
   终局打印区分 `DEPLOYED` / `DEGRADED-PARTIAL` / `FAILED`；
2. `VM` 相位失败时**必须**非零退出（对齐 `deploy-vm.mjs`），并在 HEALTH 前插入"产物指纹比对"（见 DEP-02）。

#### DEP-02｜P1｜部署无产物指纹比对 → 无法证明"跑的就是刚部署的代码"
**现象**
- `setup.mjs:236-248` `buildDeployManifest()` 只写 `deployedAt / archive / installLog / probes`，
  **不含任何内容哈希、git rev、包版本**；
- 分发方式（MEMORY 2026-09-22/09-28 固化的范式）= `dist 打包 tar → scp → VM 内解包覆盖`，
  解包后不校验；
- VM 侧服务**不暴露版本**：`server.ts:880` / `:982` 的 `version: '0.1.0'` 是**两处硬编码字面量**，
  `contracts/src/bridge.ts` 里 `HealthStatus` **没有** version/buildId 字段
  （`git grep -n "version" -- packages/contracts/src/bridge.ts` 零命中），
  12 个 `package.json` 版本全为 `0.1.0`（`grep '"version"' packages/*/package.json`）。
- 已知运维口径"**版本指纹 > uptime**"（主理人交代）在当前代码里**没有落点**：
  既无 `/health.version`，也无 `/health.buildId`，唯一可用的"指纹"是
  `agentCard.version='0.1.0'`（恒定不变，无法区分构建）与 `uptimeMs`（易被误读）。
  `docs/changes/CL-020/DEPLOY-VERIFICATION.md:54` B3 记录了"备份 `.cl020.bak` → scp 新 dist →
  kill-restart → **验证字节一致**"的**人工**做法 —— 说明校验存在于流程文档而非工具里。

**影响**
"修了没生效"类误判的最大来源。MEMORY 2026-10-04:66 已明确
"真机跑的是 VM 侧已部署产物，与本地 `packages/*/dist` 无关"，但工具链没有任何一环能自动证明这一点。

**修复建议**（ROI 最高的一条，建议优先做）
1. 构建期注入：`vm-service` 编译时写 `dist/build-info.json`（`git rev-parse --short HEAD` +
   `sha256(dist/**/*.js)` 聚合 + 构建时间），启动读入并透传到 `/health.build = {rev, digest, builtAt}`；
   Agent Card `version` 改为读该值，删掉两处硬编码；
2. `setup.mjs` HEALTH 相位断言 `health.build.digest === 本地 tar 内计算的 digest`，不一致直接 FAILED；
3. `MANIFEST-deploy` 增 `sourceRev` 与 `distDigest` 字段（纯增量，零风险）。

#### DEP-03｜P1｜`.generated/` 运行配置"再生成即覆盖手改补丁"—— 顺序铁律应改为声明式
**现象**
`install-vm.mjs:713-727`（step 3/6）以基线配置为模板**重写**
`delivery/.generated/vm-service.runtime.json`（强制 `server.host='127.0.0.1'`、`port`、
`agent.provider`、`options.cliPath`）。运维实践里大量存在**手改该文件切开关**的操作
（`MEMORY.md:20`：运行态开关走 `agent.providers.<id>.options.<key>`；
`2026-10-06.md:7` "阶段 C 切 shadow：workbuddy.options 加 `approvalTruth:"shadow"`"），
而 `.workbuddy/memory/2026-10-05.md:47` 写下顺序铁律：

> ⚠ **顺序铁律**：`deploy-vm.mjs --apply` 会**重新生成**运行时配置 ⇒ 必须先部署、后打补丁、再用 kill-restart 重启。反过来补丁会被冲掉。

同文件 :46 亦记录"重启只用 `kill-restart.ps1`（不重跑 install-vm ⇒ 不重新生成 `.generated/`）"——
即当前**规避方式是"不去碰生成器"**，属于流程性脆弱点：
- 一旦有人为修复其它问题而重跑 `deploy-vm.mjs --apply`，**shadow 开关等运行态补丁静默消失**，
  且 `/health` 上 `providerApprovalTruth` 字段回退 → 事后极难归因（表现为"功能又回到旧行为"）；
- `install-vm.mjs` 无 `--keep-config` / 无 `overrides` 概念
  （`git grep -n "overrides\|keep-config\|preserve" -- delivery` 仅命中 `bootstrap.mjs` 的 env 参数解析，
  与运行配置无关），CLI 全集 20 个 `--` 选项（:113-131）里没有一项能保护补丁；
- 铁律只存在于 `MEMORY.md` / memory 日记，**代码与 `--help` 文案里没有**（`install-vm.mjs:713`
  只是 `console.log('[3/6] 生成运行配置 ...')`，不告警"这会覆盖你的手工开关"）。

**评估"是否值得改为声明式"**：**值得**，且代价低。建议三档：
- **档 1（最小，建议本期做）**：分离文件——基线 `delivery/vm-service.config.json`（仓库真相）
  + 叠加 `delivery/.generated/vm-service.overrides.json`（运维真相，**生成器永不写**）；
  `resolveServiceConfig` 按"基线 ← overrides"浅合并（provider options 已是浅合并语义，
  `MEMORY.md:20` "provider 级浅合并、未知键保留"说明内核侧已具备能力）。
  生成器只写 `.generated/vm-service.runtime.json`（派生物），overrides 不存在时行为与今日逐字一致。
- **档 2**：`install-vm.mjs` 在重写 runtime.json **之前**比对手工键差异并**告警 + 落一份
  `vm-service.runtime.json.pre-<ts>.bak`（与宿主侧 `*.winvm-bak.<ts>` 同规格，团队已有先例）；
  加 `--keep-config` 显式跳过 step 3。
- **档 3（声明式终态）**：运行态开关迁到 `schtasks` 任务的 env 或独立的 `feature-flags.json`，
  部署链完全无感；`--help` 与 INSTALL-GUIDE 同步。
档 1 + 档 2 组合即可把"顺序铁律"从人记规则变成结构保证，**ROI 排在本次建议清单第 2 位**。

#### DEP-04｜P2｜幂等性总体良好，但存在两处"二次运行需人工确认"
**幂等做法（正面）**：`install-vm.mjs:738-746` 计划任务"存在即 `schtasks /Delete` 再 `/Create`"，
并先 `killServiceProcess(port)` 清端口占用者（注释说明"确保新 Hidden=true 实例能绑定"）；
`install-host.mjs` 的注册条目/白名单写入是"读-改-写 + 去重 + 备份"；
`winvm-plugin.mjs:599` / `setup.mjs:1108-1114`（D14 daemon-aware：先复用在线隧道，
否则 `tunnel ensure`，避免 EADDRINUSE）。→ **重跑自愈能力：VM 侧强、宿主侧中、隧道侧强。**

**残留点**
1. `setup.mjs` 归档名 `WINVM_ARCHIVE`（`.tgz`）在 VM 上解包覆盖，**旧文件不删**：
   若某模块在新版本被**重命名/删除**，VM 上会残留旧文件。由于 `import` 走 `dist` 路径显式引用，
   残留文件通常不被加载，但 `psmod/*.ps1` 是**目录全量 dot-source**
   （`ps-bridge.ps1:232-243` `Get-ChildItem -Filter '*.ps1'`）→
   **删除/改名的能力模块不会被清掉**，重启后仍会被加载进 `LoadedModules`，
   同名函数还会**互相覆盖**（dot-source 顺序 = `Get-ChildItem` 顺序，非确定）。
   （旁证：`qa/r19/scan-uninstall-keys.ps1`、`qa/probes/archive/*` 等历史件的存在说明"归档不删"是常态做法。）
   建议：`install-vm.mjs` 部署时对 `psmod/` 做**镜像同步**（删多余项入回收站），
   或在 `ps-bridge.ps1` 里对重复函数名做启动期检测（`git grep` 显示**当前 6 个 ps1 之间无重名函数**，
   故这是潜在风险而非现存缺陷）。
2. `runRemotePs1`（`setup.mjs:664-698`）临时脚本名 `winvm-setup-<Date.now()>.ps1` 落在**远端 HOME 根**，
   用后 `rm -f` 清理（:693）——若 scp 成功而 ssh 失败则**远端残留**（下次运行不冲突，因带时间戳，
   但会在 `C:/Users/User/` 持续堆积）。建议固定 `winvm-setup-tmp/` 子目录 + 启动时清旧。
3. `buildVmStartPs1`（`setup.mjs:704-719`）用 `schtasks /End` + `/Run`，`$ErrorActionPreference='Continue'`
   + `$null = ... 2> $null`：`/End` 在任务未运行时返回非零被吞掉（可接受），但
   `/Run` 成功即输出 `VM_START_TRIGGERED`——**"触发成功"≠"服务已监听"**（后续 `waitForRemotePort` 弥补了这点，
   `setup.mjs:1157` 预算 420s），语义链条完整，仅文案易误读。属可接受。

#### DEP-05｜P2｜`install-host.mjs` 无构建步骤，依赖"先跑过 npm run build"—— 防呆只在缺失时报错
**现象**
`install-host.mjs` **不执行** `npm run build`，只检查产物存在性：
`:234-236`（`@winvm/*` dep dist 缺失 → throw "请先执行 npm run build"）、
`:934-937`（`host-a2a-bridge/dist` 缺失 → throw）。
这提供了**存在性**防呆，但**没有新鲜度（staleness）防呆**：
`dist` 存在但**落后于 `src`**（改完源码没重新 build）时，`installBridgeDeps`
（`:231-240` `cpSync(src, join(dest,'dist'), {recursive:true})`）会把**旧 dist** 复制进插件缓存，
`install-host` 打印"完成"，运行态是旧代码——这正是主理人点名的已知坑
（"改 dist 必须实跑 `install-host.mjs` 才生效"的反向形态："改了 src 没 build，实跑 install-host 也不生效"）。

MEMORY 里"仓库修复 ≠ 运行态生效"的告警已出现 3 次（`2026-09-28.md:11`、`2026-10-04.md:66`、
`2026-10-05.md:46-47`），说明该坑复发频率高。

**修复建议**
1. `install-host.mjs` 复制前做**新鲜度比对**：对每个 `packages/<name>/dist/**/*.js`，
   若存在同名 `src/**/*.ts` 的 `mtime > dist mtime`，**警告并列清单**（或直接拒绝，提供 `--force`）；
   更严格：比对聚合 `sha256(src)` vs `sha256(dist)` 需要编译，不实用，mtime 足够。
2. `winvm-plugin check`（`:567-603`）增一项"源码/构建产物新鲜度"；
3. 与 DEP-02 的 `build-info.json` 打通：`check` 直接比对插件缓存里的 `build-info.rev`
   与仓库 `git rev-parse`（只读调用，符合本工程 git 全路径约定）。

#### DEP-06｜P2｜`deploy-vm.mjs` 与 `setup.mjs` 的 VM 相位逻辑重复（漂移风险）
**现象**：`deploy-vm.mjs:122-158` 完整复刻了 BUILD/VM/VM-START/QA-PROBE 的执行序列与文案，
虽然注释（`:15-16`）声明"复用 setup.mjs 的 deployVm/runRemotePs1/…保证行为完全一致"，
但**重试次数、文案、`process.exitCode` 语义**是各写各的
（对比：`setup.mjs:1146-1150` VM-START 重试 1 次 + `sleep(5000)`；
`deploy-vm.mjs:135-139` 同样逻辑独立实现；
`setup.mjs:1171-1173` QA 缺失判定用 `missing.length === QA_PROBE_FILES.length`，
`deploy-vm.mjs:152` 用 `missing.length > 0` —— **两处口径已经不同**）。
**影响**：未来改一处忘另一处的典型漂移；QA/部署脚本行为分叉会引发"子脚本通过、总脚本失败"类误判。
**建议**：`deploy-vm.mjs` 改为直接调用 `setup.mjs` 导出的**相位执行函数**（目前只导出了纯逻辑件），
或抽 `delivery/lib-vm-phase.mjs` 单一实现。

#### DEP-07｜P2｜`setup.mjs --apply` 的 dry-run 也会做只读探测（与"零改动"文案略有出入）
**现象**：`setup.mjs:1082-1084` 打印"DRY-RUN 完成：**未对任何系统做改动**"，
但 `buildPlan()`/`resolveConfig()` 路径中含只读探测（主理人在任务说明里亦提示"dry-run 也会做只读探测"；
如 `setup.mjs:978` 注释描述的"端口连通 exe 探测"、`preflight.mjs` 的可达性检查）。
**影响**：仅文案严谨性（探测本身无副作用），但 dry-run 在**离线**环境下可能因探测超时而变慢，
影响 CI/巡检体验。**建议**：文案改为"未做任何写操作（含只读连通探测）"，并给 dry-run 探测加短超时。

#### DEP-08｜P2｜远端 PowerShell 铁律**存在一处残余内联**：`deployVm` 建目录用 `-Command`
**现象**：铁律（`setup.mjs:656-659`）要求"凡远端 PowerShell 逻辑一律写 .ps1 → scp → `-File`"。
但 `deployVm` 的建目录步骤（`setup.mjs:608-615`）是内联的：
```
powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '<dir>' | Out-Null"
```
今天能跑通的原因：路径经单引号包裹、无 `$` 变量、`|` 落在 bash 的双引号内不被解释。
一旦 `cfg.vmDeployDir` 含 `$`/空格/反斜杠尾随（`.env` 里手输 `C:\Users\User\.WinVMBridge\` 这类形态完全可能），
MSYS 与 PowerShell 的双层解析就可能重演"`/End` → `C:/…/End`"那类破坏。
同文件其它远端逻辑（`buildVmStartPs1` :704-719、`uninstall.mjs:708`）都规规矩矩走 `.ps1` 推送 ——
即这一处是**风格不一致**，非有意取舍。

**同类**：`vmInstallCommand`（`setup.mjs:540-548`）在 ssh 串里用 `node -e '…rmSync…'` 做删除，
注释（:528-538）详尽解释了引号与 MSYS 陷阱的处置（**做得好**）；
`writeDeployManifest`（:320 `cat > … && echo MANIFEST_WRITTEN`）依赖"远端 = Git-Bash"这一隐式前提，
**但已有 scp 回落**（:329-339）→ 属"已防御"。

**建议**：把 `deployVm` 建目录改为 `.ps1` 推送（或干脆并入 `install-vm.mjs`，它本来就在 VM 内跑），
并给"远端 shell = Git-Bash"这一前提在 `preflight.mjs` 加一条探测断言（`ssh ... echo $0`）。

#### DEP-09｜P2｜基线配置只做"存在性"前置检查，未做"可解析 + 关键键"前置校验
**现象（已核验，表述修正）**：`setup.mjs:545-547` 拼出的安装命令是
`node delivery/install-vm.mjs --skip-install --skip-build --provider … --cli …`，
不带 `--config`；`install-vm.mjs:487` 取 `args.config ?? defaultConfig`，
而 **`:489-490` 已有存在性前置检查**（`if (!existsSync(cfgPath)) { console.error('找不到 VM 服务配置：…') }`）；
且 `deployVm` 的 `sources` 显式包含 `'delivery'`（`setup.mjs:603`）⇒ 配置文件必然随 tar 分发。
故"文件缺失 → VM 内深层抛错"这一路径**已被防御**，本项不再指控失败面后置。

**残余缺口**：存在性检查之后到 `readJson`/键消费（`install-vm.mjs:502`）之间，
没有"JSON 可解析 + 关键键齐全（`agent.provider` / `service.host` / `service.port`）"的校验。
`readJson` 抛错时（JSON 语法坏、UTF-16 BOM 误存）宿主侧仍只拿到"尾部 2000 字"（`setup.mjs:1133`）；
键缺失时（如 `agent` 段被人为删空）则在 step 3 的 `runtime.agent = runtime.agent ?? {}`（:718）被静默补齐，
最终写入的运行配置与基线**语义不同**却无任何提示。

**修复建议**：`install-vm.mjs` 在 step 3 之前加"可解析 + 关键键"校验（`preflight.mjs:231`
`assertDeps` 已有"阻断项/警告项"框架可复用），文案直接指出"缺哪个键/JSON 第几行语法错"。

---

#### DEP-10｜P2｜多处 `spawn` 使用裸 `'node'`（而非 `process.execPath`），部署链可执行体解析不一致
**现象**
工程内两种写法**并存且无注释说明取舍**：
- 用 `process.execPath`（正确）：`install-host.mjs:829/1137/1211`、`setup.mjs:791/858`、
  `winvm-plugin.mjs:1070`（隧道 daemon 拉起）、`install-vm.mjs:748`（计划任务 nodeExe）；
- 用裸 `'node'`（依赖 PATH）：`setup.mjs:123`（HOST 相位命令）、`:146`（VM 无 host 时的指引文案）、
  `:562`（HOST-UNINSTALL）、`winvm-plugin.mjs:940/959/973/982`（uninstall/update/reinstall 四条主路径）、
  `install-vm.mjs:647/765`（`--self-test`）、`bootstrap.mjs:527`、`preflight.mjs:139/157`（`node -v` 探测，带 `shell:true`）。

**证据**（本次实机环境核验）：当前 WorkBuddy 沙箱 PATH **确实**含
`/data/storage/el1/bundle/libs/arm64/node/bin`（故裸 `node` 可用），且 `git` **不在** PATH ——
这正好说明"PATH 完整性"在本宿主上是**逐项随机**的，不能作为隐含前提。

**影响**
1. `winvm-plugin` 是被安装进插件缓存目录、由宿主 Agent 直接调用的入口，其 `uninstall/update/reinstall`
   全部走裸 `node`：一旦宿主 Agent 运行环境 PATH 不含 node（或含的是另一个不兼容版本），
   失败表现为 `ENOENT`/版本错配，而 `sh()` 把 `r.error` 塞进返回值（`winvm-plugin.mjs:60-67`）后
   仅以 `status!==0` 置 `exitCode`，**用户看不到"找不到 node"这一条真实原因**。
2. `setup.mjs:123` 生成的**计划命令字符串**（dry-run 预览与 APPLY 都按它执行）显示为 `node delivery/...`，
   与实际解析结果可能不一致 → 预览即不可复现（人工按预览命令手敲时更甚）。
3. `install-vm.mjs:647/765` 用裸 `node` 跑自检，而计划任务用 `process.execPath`（:748）
   → "自检通过的 node"与"服务实际用的 node"**可能不是同一个二进制**，自检结论对服务无效。

**修复建议**
统一规则并写进交付文档：**所有由已运行 Node 进程发起的子 Node 调用一律 `process.execPath`**；
仅"VM 内 PowerShell 调外部 CLI"这类跨语言场景才允许裸名。
`sh()`/`run()` 在 `r.error`（ENOENT）时打印 `命令解释器未找到：<cmd>，请检查 PATH` 并保留原始 code。
`install-vm.mjs` 自检改用 `process.execPath`（与计划任务同源）。
若 `delivery/vm-service.config.json` 被手改坏（本项目运行配置是**磁盘上的 JSON**，
MEMORY 已记录运维会在 VM 上直接改它），失败仍发生在 step 3 之后（生成
`.generated/vm-service.runtime.json` 时，`:713-727`），
且此时 step 1（软链）/ step 2（build）已执行完 → **半途状态**（见 DEP-03 顺序陷阱）。
**建议**：`:489` 那段前移为小 preflight（复用 `preflight.mjs` 的 `Check[]` 结构），
把"存在 + 可解析 + 关键键"三项一起断言，失败即在任何写操作前退出。

---

## 4. 可观测性与运维缺口

### 4.1 做得好的部分（先记功，避免后文被读成"整体薄弱"）

| 方面 | 实现 | 证据 |
|---|---|---|
| 健康面结构 | `/health` 已含 `provider/session/psBridge/capabilities/audit/llmSession/logging/cache` 七段，且后四段遵循"纯附加"纪律（不改既有字段语义） | `contracts/src/bridge.ts:125-150`、`server.ts:1290-1352` |
| 超时护栏 | `raceHealthSubProbes` 两路子探针**并发**编排（避免 5s+5s 叠加）+ `raceWithTimeout`（注释明确"race 不 abort"）+ `resolvePsBridgeHealthState`（ready+超时→`degraded` 且附 `probe:'timeout'`） | `health-probe.ts`（全文）、`server.ts:1258-1288` |
| 故障可见性 D2 | ps-bridge `restarts` / `lastError` / `lastHeartbeatAgoMs` 全量透出，注释明写"避免故障时无从判断（旧实现把重启失败静默吞掉）" | `ps-bridge.ts:415-434`、`server.ts:1271-1288` |
| 日志保留 | 10MB×7 文件 + 14 天双上限、启动即 `prune()`、跨天切换顺手清理、60s 节流、目录不可写**降级不抛错**并在 `/health.logging` 透出 `degraded/reason` | `file-logger.ts:89-90/100/152-155/189-218`、`server.ts:1294-1300` |
| 隧道属主校验 | D6-B：`tunnel.state.json` 的 pid 与 pidfile 不一致即判"陈旧、绝不参与健康决策"，避免陈旧 state 把健康隧道误判 DEGRADED，也避免 `ensure` 误重启 | `winvm-plugin.mjs:1008-1038` |
| 审计链取证 | `canonicalJson` + SHA256 + `prevHash` + seq 单调性四态判定（HASH_MISMATCH/SEQ_DUP/SEQ_GAP/CHAIN_BREAK），`brokenAt`/`reason` 透出到 `/health` | `chain.ts:311-364`、`server.ts:1337-1343` |
| 离线复验工具 | `delivery/tools/verify-d30.ps1`（触发一次调用 → 列分片 → 复查 `/health`），`tools/README.md:27` 标明"只读" | 已核验 |
| CLI 运维面 | `winvm-plugin` 提供 `help/check/health/list/server/command/tunnel/tunnel-mode/uninstall/update/reinstall`，`health` 会对"非交互会话 → GUI 不可用"给出**可直接粘贴的修复命令** | `winvm-plugin.mjs:12-24`、`:653-697` |

### 4.2 缺口清单

#### OPS-01｜P1｜全链路**没有任何告警出口**：所有故障只能靠"有人去查"
**现象**：`git grep -i "webhook|alert|metric|prometheus|otlp"` 在 `packages/` 与 `delivery/` 的命中
**全部**是 MCP/A2A 协议方法名（`notifications/initialized`、`pushNotificationConfig`）或 PS 字段名
（`nextHop`/`routeMetric`），**零**主动外发通道。工程里"故障"的最终归宿只有两类：
1. `logger.warn/error` 落文件（`file-logger`，7 文件×10MB 滚动，最旧即删）；
2. 等某次 `/health` 或 `meta.health.check` 被调用时被动带出。

A2A 框架侧甚至显式声明 `pushNotifications: false`（`a2a-framework/src/server.ts:138`、
`server.ts:985`）—— 即协议层面主动关闭了"服务端推事件"的能力。

**影响**：ps-bridge 反复重启（`restarts` 累积）、审计链断裂（`chainValid:false`）、
日志降级（`logging.degraded`）、LLM 会话进入 `disabled`（`persistent-session.ts` maxRestarts 收口）——
这四类都是"发生时无人在场、事后只在日志里"的故障。日志会轮转覆盖，
**故障事实的生命周期 = 7 个日志文件写完的时间**，远短于多数问题的发现周期。
审批链这类安全语义尤其需要"未处置即升级"的机制。

**修复建议**（成本从低到高，任一档都比现状好）：
1. **落盘告警流水**：新增 `~/.workbuddy/winvm/alerts.ndjson`（VM 侧对应 `%LOCALAPPDATA%/WinVMBridge/alerts.ndjson`），
   由 `server.ts` 已有的几个 `logger.warn` 关键点位（桥重启、链断裂、会话 disabled、审批写审计失败）
   同时追加一条结构化事件；`winvm-plugin health` 末尾打印"最近 N 条未确认告警"。零外部依赖，
   不受日志轮转吞没，可被 WorkBuddy 会话直接读取。
2. `winvm-plugin` 增 `watch` 子命令（轮询 `/health` + 隧道状态，异常时打印/落盘），补齐"无人值守巡检"。
3. 若要保持"纯本地、无外发"的既有安全叙事，档 1 + 档 2 即为终态，不必引入 webhook。

#### OPS-02｜P1｜`freshChainOnStart: true` 使链校验作用域**止于本次启动**，跨重启篡改不可检测
**现象**：`server.ts:379` **硬编码** `freshChainOnStart: true`（非配置项），`verifyChain()` 因此
只校验 `this.activeShards`（`chain.ts:313`），历史分片"可查但不参与判定"（注释 :310、:79 明确写出）。
这是 D30 的正确修复（历史已含 511/582 重复 seq，续接会让 `chainValid` 永久 false），
但**副作用未被记录**：任何人改动/删除历史分片，`/health.audit.chainValid` 恒为 true；
而每次 `kill-restart`（本工程最常用的运维动作）都会**重置链基线**，
`/health.audit.entries` 也归零重计 —— 于是"entries 单调增长"这一最常用的审计健康直觉不成立。

**证据**：`server.ts:373-380`；`chain.ts:79`（"不再参与 verifyChain 判定"）、`:115`、`:130-156`、`:313`；
`.workbuddy/memory/MEMORY.md:20` + `docs/INSTALL-GUIDE.md`（kill-restart 为常规操作）。

**影响**：取证叙事（"哈希链不可篡改"）与运行时可观测面（`chainValid` 只覆盖本轮）之间存在**语义落差**；
运维若用 `chainValid` 做"审计完整性"告警判据，会得到系统性假阴。

**修复建议**：
1. `AuditConfig` 增 `verifyScope: 'session' | 'all'`（默认 `session` 保持现状），
   `'all'` 时校验全部分片并输出"首个断裂点 + 该点是否早于本轮基线"；
2. `/health.audit` 增 `chainSince`（本轮 genesis 的 ISO 时间）与 `archivedShards`（数），
   把"我只校验了本轮"变成**显式事实**而非依赖读者记得实现细节；
3. 提供离线全链校验命令（`verify-d30.ps1` 目前只查活动面）：
   新增 `delivery/tools/verify-audit-all.mjs`，遍历 `listShards()` 全量重算，供取证场景调用。

#### OPS-03｜P1｜"隧道黑洞"判据只存在于文档，代码里的健康判据恰好是那个会误判的判据
**现象**：坑 4 明确记录（`delivery/tools/README.md:35`、`docs/INSTALL-GUIDE.md:297`、`:265`）：
"VM 掉线时宿主 ssh/隧道进程假活、仍占本地监听 → **TCP connect 成功 ≠ 服务存活**"，
半死判据 = `ping` 100% 丢包 ∧ `ssh Host is unreachable` ∧ TCP connect 成功 ∧ HTTP 超时。

但代码侧 `readTunnelStatus()` 的健康判据正是
`alive（pid 存活）∧ portOpen（TCP 可连）` → `state:'RUNNING'`（`winvm-plugin.mjs:1027-1031`），
`cmdCheck` 据此打 ✅（`:600`），`setup.mjs` TUNNEL 相位据此"复用常驻 daemon、跳过自建"（`:836`）。
**即：文档警告的那条假阳性路径，是当前唯一的实现。**

**证据**：`winvm-plugin.mjs:1016-1038`（判据）、`:600`（check 项）、`setup.mjs:770-772/829-836`（复用）；
`docs/INSTALL-GUIDE.md:297`、`delivery/tools/README.md:35`（判据仅文档）。

**影响**：VM 掉线/半死时，`check` ✅、`tunnel status` "运行中（可连）"、setup 复用隧道并跳过重建 ——
三层都给出乐观结论，用户只在下一步真正调工具时才撞上 HTTP 超时，且此时已失去"隧道假活"这一归因线索。
（`CL-020/DEPLOY-VERIFICATION.md:233` 记 I2"黑洞 44.4s < 60s"，说明该形态在真机确证存在。）

**修复建议**：
1. `readTunnelStatus()` 增加第三判据：**经隧道发一次 HTTP `GET /health`（短超时 2~3s）**，
   三态合成 `RUNNING / TUNNEL_ONLY（活着但后端不通）/ STOPPED`；
   `TUNNEL_ONLY` 时 `ensure` 应**主动 restart 一次**并提示"VM 侧服务或网络异常"，
   与既有"DEGRADED → 重启一次"分支同构（`:1169-1173`），改动面很小。
2. `tunnel status --json` 透出 `httpProbe` 字段（`ok|timeout|refused|skipped`），
   让脚本与人都能一眼区分"隧道通"与"服务通"。
3. 把坑 4 的四条判据写成一个诊断脚本（`delivery/tools/diagnose-tunnel.mjs`），
   避免"文档里的方法论"与"代码里的判据"长期分叉。

#### OPS-04｜P2｜ps-bridge 看门狗覆盖不到"在途慢调用"，与 600s 能力叠加可复现 D31（引用 PSM-01/ENG-13）
**现象**：看门狗以 `lastHeartbeatAgoMs > 45s` 判死（`ps-bridge.ts:187-208`），
而 PS 侧主循环是同步单工（`ps-bridge.ps1:249-291`），心跳块在长调用执行期间被完全阻塞
（PSM-01）。`definitions.ts:156/:270/:273` 存在 `timeoutMs = 600_000` 的能力。
→ 一个 >45s 的合法调用即可触发"看门狗判死 → restart → 在途请求 `failAll` → 上层重试 → 再次超 45s"的重启风暴
（`CL-017/REQUIREMENT.md:488`、`CL-018/REQUIREMENT.md:200` 记 D31，结论"记录不修"）。

**运维侧缺口（本条新增，PSM-01 已从模块侧论述）**：
`/health.psBridge` 目前**无法区分**三种完全不同的形态 ——
①桥真的死了；②桥活着但有一个 600s 的长调用在跑（心跳必然静默）；③桥活着但在排队（ENG-13）。
三者都表现为 `state`/`pending`/`uptimeMs` 的某种组合，运维看到 `restarts` 增长
无法判断是"故障"还是"正常长任务"。

**修复建议**：见 PSM-01（在途感知的看门狗顺延）+ ENG-13（`pendingMaxAgeMs` 队列年龄）。
补充一条**低成本即做**的：`/health.psBridge` 增 `inflight: [{id, capabilityId, startedAt, budgetMs}]`（上限 10 条），
把"现在正被谁占着"变成事实。

#### OPS-05｜P2｜审计检索只有"按 traceId 取回执"一条窄门，缺运维可用的检索面
**现象**：HTTP 路由中审计相关仅 `GET /audit/receipt?traceId=…`（`server.ts:1107-1131`），
且该端点是**内存环形缓存**（S-3，`MAX_RECEIPT_ENTRIES=200`，重启即失，不入链，
`server.ts:387-393`）—— 不是文件审计的查询接口。
`HashChainAuditSink.query()`（`chain.ts:367-394`，支持 traceId/capabilityId/since）
在 `packages/` 内仅供 `verifyChain` 类内部逻辑与单测使用，
`capabilities` 的 54 项定义里（`definitions.ts`，`grep audit` 仅命中 `:61` 的 `audit:{snapshot}` 元数据）
**没有**任何"查审计"能力，`meta` 域只有 `health.check` / `capability.list` / `session.status`
（`definitions.ts:69-96`）。CLI 侧 `winvm-plugin list` 只有 `skills|mcp-servers|mcp-tools|dirs`（`:15-18`）。

**影响**：一次审批/拒绝/执行的事后追溯需要"SSH 进 VM → 手翻
`%LOCALAPPDATA%\WinVMBridge\audit\*.jsonl`"（`config/index.ts:115` 给出默认目录），
与工程本身"证据链驱动"的方法论（每个结论要 traceId/指纹）不匹配。
`verify-d30.ps1` 也是靠 `Get-ChildItem` 人肉列分片（`delivery/tools/verify-d30.ps1:14-15`）。

**修复建议**：
1. 暴露 `GET /audit/query`（复用已有 `query()`，强制 `limit` 上限与 `since` 必填，
   返回**脱敏后**投影；注意与 ENG-06 的"全量扫描放大"一并设计，加扫描上界）；
2. 或新增 `meta.audit.query` 能力（L0、idempotent），走既有 MCP 通道，宿主侧零改造；
3. CLI 增 `winvm-plugin audit <traceId>`（内部调 1/2，离线时回落读文件）。

#### OPS-06｜P2｜`/health.ok` 语义过窄 + 无 `checks` 汇总（ENG-15 的运维面重述）
**现象**：`server.ts:1323` `ok: provider !== undefined && bridgeHealth.state === 'ready'`
—— 会话不可用（GUI 全废）、审计链断、日志降级、LLM 会话 `disabled` 均不影响 `ok`。
工程内唯一"聚合式"判据在 `cmdHealth`：只对 `session.interactive === false` 做特判提示
（`winvm-plugin.mjs:658-662`），其余段原样 dump JSON。
**影响**：任何"用 `ok` 做存活告警"的接法都是假阴；任何"人读 JSON"的接法都依赖读者记得每个字段含义。
**建议**：见 ENG-15（先加 `checks`，下个大版本再收紧 `ok`）；
CLI 侧 `cmdHealth` 顺带做 `checks` 摘要打印（一处改动，人/机同时受益）。

#### OPS-07｜P2｜升级无版本核验、回滚无版本可回（部署链 DEP-02 的运维面延伸）
**现象**：
- `cmdUpdate` = 重跑 `install-host.mjs`（`winvm-plugin.mjs:966-978`），
  `cmdReinstall` = `uninstall` + `update`（`:979-985`）—— **都是"再装一遍当前工作树"**，
  不存在"装某个版本"或"退回上一个版本"的语义；
- 12 个 `package.json` 版本恒 `0.1.0`，`agentCard.version` 硬编码 `'0.1.0'`（`server.ts:880`、`:982`），
  `HealthStatus` 契约无 `version`/`buildId`（`contracts/src/bridge.ts:125-150`）
  → **运行态无法自证是哪次构建**（DEP-02 已论证，此处记运维后果）：
  "版本指纹 > uptime"这条判据在文档/MEMORY 里被当作铁律使用，但**代码里没有任何指纹可比对**；
- 备份面只有 `*.winvm-bak.<ts>`（`install-host.mjs:393/430-436/455/621/645/668`）
  与 `~/.workbuddy/winvm-trash/<ts>/`、`.uninstall-trash/<ts>`（`docs/INSTALL-GUIDE.md:384`）
  —— 可恢复**单个文件**，不可恢复"一整套部署"，且没有 `winvm-plugin rollback` 之类的入口把它们串起来。

**影响**：升级出问题时，实际恢复手段 = "手工把 bak 文件拷回去 + 猜哪些文件动过 + kill-restart"，
无自动化、无版本可比对、无法验证回滚是否完整生效（回到 DEP-02 的假验证风险）。

**修复建议**（与 ROI §7 第 1 条同一件事）：
1. 构建时写 `dist/build-info.json`（`rev`/`buildAt`/`dirty`），`install-host`/`install-vm` 随产物分发；
   `/health` 增**纯附加** `build?: {rev,buildAt,dirty}`；
2. `install-host` 每次在 `~/.workbuddy/winvm/manifests/<rev>.json` 落一份"本次写了哪些文件+哈希"，
   `winvm-plugin rollback [--to <rev>]` 据清单精确还原 + kill-restart；
3. `check` 增"版本一致性"项：插件缓存 `build-info.rev` vs 仓库 `git rev-parse HEAD`
   （只读调用，符合本工程 git 全路径约定），不一致即 ❌。

#### OPS-08｜P2｜`logging.degraded` 有透出但没有"日志写不进去"的反压指标
**现象**：`file-logger` 的降级只发生在**构造期**（目录不可写/创建失败 → `degraded=true` 后 `return`，
`:97-105`）；运行期若 `appendFile` 失败、或缓冲 `flushThreshold` 触发的批量写失败，
是否有计数/透出未核验（`file-logger.ts:225` 之后的写入路径本次未逐行深读）。
`/health.logging` 只有 `degraded/dir/level/reason`（`server.ts:1295-1300`）。
**影响**：磁盘满（与 ENG-16 的审计无配额叠加是同一现场）会让"取证"和"事后归因"双双静默退化。
**建议**：`logging` 增 `droppedLines: number`（纯附加），构造期之后的运行期失败计入该值。

---

**§4 小结**：工程的可观测性**结构**是好的（七段 `/health`、纯附加纪律、双段超时护栏、D2 故障透出、
日志保留策略堪称范本），**缺的是"没有人在场时也能成立"的那一层**：
无告警出口（OPS-01）、链校验作用域被静默收窄（OPS-02）、
隧道判据恰好是文档警告的假阳性（OPS-03）、无版本核验与回滚入口（OPS-07）。
这四项都是"运维完备性"而非"功能正确性"问题，也正是本项目当前最薄弱的面。

## 5. 鸿蒙宿主约束防护评估

**评估方法**：逐条约束做「**文档化 / 代码防御 / 本次实测**」三面核验。
文档化面主要落在 `docs/INSTALL-GUIDE.md` §8 故障排查表（`:297-306`）与 `delivery/tools/README.md` 坑位清单；
代码防御面用 `git grep` 定位；本次实测面用只读命令现场验证（下表"本次实测"列）。

### 5.1 约束 × 防护 对照表

| # | 鸿蒙约束 | 文档化 | 代码防御（证据） | 本次实测 | 结论 |
|---|---|---|---|---|---|
| C1 | `getcwd` 失败（shell 每条命令报 `error retrieving current directory`） | ✅ `INSTALL-GUIDE.md:306`（明确"native getcwd 断言 Exit 133"，给出正确 node 二进制路径）；`.workbuddy/memory/2026-09-15.md:28`（"shell 偶发 getcwd 报错但不影响绝对路径操作"） | ✅ 全部路径解析基于 `import.meta.url`/`__dirname`，**无一处依赖 cwd**：`ps-bridge.ts:19-24`（注释专门说明 ESM 无 `__dirname` 会回退 `process.cwd()` 的陷阱）、`deploy-vm.mjs:35`、`install-vm.mjs:481`、`setup.mjs` 的 `ROOT`。⚠ 但 `winvm-plugin.mjs:171/564` 用 `findUp(process.cwd(), …)` 作 **.env/仓库根探测的起点**（见 §5.2 观察项 O1） | ✅ 实测 `node -e "process.cwd()"` 在报错环境下**仍正常返回**（本次 shell 层 stderr 反复报 getcwd，Node 层不受影响） | **防护到位**（代码侧），文档侧亦充分。仅剩 §5.2 的 O1 一致性观察 |
| C2 | 沙箱 uid 生命周期：WorkBuddy 被强杀 → 连带杀死进程内隧道 daemon | ✅ `INSTALL-GUIDE.md:265`（区分"常驻 daemon" vs "单次部署临时隧道"两种生命周期）；`hooks/hooks.json:2` + `session-start.sh:1-19`（以 SessionStart 钩子实现"会话重建"这一**自愈**思路） | ✅ `session-start.sh`（POSIX sh、恒 `exit 0`、后台不阻塞、best-effort 日志）+ `winvm-plugin.mjs:1042-1075`（`detached:true` + `stdio:'ignore'` 拉起）+ `tunnel-daemon.mjs:110/170-189`（pidfile + `process.on('exit')` 清理 + `uncaughtException/unhandledRejection` 兜底写 DEGRADED 后 `giveup` 有序退出）<br>⚠ **无任何 `setsid`/脱离会话组的代码**（`git grep setsid` 全仓零命中）——`detached` 在 POSIX 上等价于 `setsid`（Node 文档语义），但在鸿蒙沙箱的会话/uid 组管理下能否存活**本次未验证** | ❌ 未实测（需强杀 WorkBuddy 观察 daemon 存活，属破坏性操作，超出只读审计范围）→ **本次未验证** | **设计层面已针对该约束做了正确应对**（钩子重保活），但对"是否能真正跨 uid 会话存活"这一鸿蒙特性**缺少代码内断言与真机证据**（见 §5.2 O2） |
| C3 | `rm` 是坏 shim（缺 `/bin/bash` → exit 126），删文件不可靠 | ⚠ **仅在记忆**：`.workbuddy/memory/2026-09-09.md:21`（"安全删除垫片会拦 `fs.rm`"）、`2026-09-15.md:28`（"`rm` 是坏 shim，改用 `node -e fs.unlinkSync`"）——`INSTALL-GUIDE.md` §8 表里**没有**这一行 | ✅ 所有删除都走 `node:fs` 的 `rmSync({force:true})`/`unlinkSync`，**无一处 shell 出去调 `rm`**：`install-host.mjs:343/833/1351`、`install-vm.mjs:834`、`path-util.mjs:108`、`setup.mjs:345/636/696`、`tunnel-daemon.mjs:137/183-184/189/266-267`、`winvm-plugin.mjs:1037/1106/1120`、`uninstall.mjs:520`；且 `session-start.sh:11` 明确写"本脚本不得使用任何 bashism（已知坑：safe-bin 的 `rm` shim 因缺 /bin/bash 而 exit 126）"<br>⚠ **例外**：`setup.mjs:543` 与 `:693` 在**远端**（VM 的 Git-Bash）用 `rm -f`/`node -e rmSync` —— 远端不是鸿蒙沙箱，且 :528-538 已详注引号陷阱，属正确处置 | ✅ 实测确认宿主 `command -v rm` 命中 `safe-bin` 目录（`rm`/`rmdir`/`unlink` 三个 shim 存在），故代码侧**绕开 shell rm 的纪律是必要且已成立** | **防护优秀**（代码纪律统一）。唯一缺口是**文档**：`INSTALL-GUIDE` §8 未收录此坑，新环境排障者只能靠翻记忆 |
| C4 | `/tmp` 只读 | ⚠ `tools/README.md`/`INSTALL-GUIDE` 未见收录 | ⚠ **部分**：`setup.mjs:668-675`（`runRemotePs1` 写临时 .ps1 失败 → 回落 `ROOT/.setup-tmp`）有防御；`uninstall.mjs:706-711`（同名逻辑）**无回落**，写失败仅 `console.log('[WARN] cannot write temp ps1')` 后 `return {ok:false}` → 卸载 VM 相位直接失败 | ✅ **本次实测修正了该"约束"的表述**：`os.tmpdir()` = `/data/storage/el2/base/cache`，Node 层**可写可删**（写入+unlinkSync 均成功）；而 shell 层 `/tmp` 目录本身不可用（`touch /tmp/…` 被拒）。即：**"只有 shell `/tmp` 不可用"这一说法对本项目代码路径实际不构成阻塞**，Node 侧回落逻辑是为更受限沙箱预留的保险 | **防御不彻底**（两个同构函数一个有一个没有）；但本宿主下**实际不触发**。建议按 §5.2 O3 处理（统一 + 更新文档口径） |
| C5 | `node --test` 整批跑触发 `0xC0000005` 崩共享 runner（link-workspace junction） | ✅ `INSTALL-GUIDE.md:305`、`docs/oh-host-install-run-test.md:222`、`.workbuddy/memory/2026-09-03.md:237`（三处记载，且给出"逐文件跑"的处置） | ⚠ 仅文档约束，**无代码级守卫**：`link-workspace.mjs` 未在非 win32 平台跳过 junction 分支；测试脚本层未见"逐文件"的 Makefile/npm script 强制（`package.json` test 脚本本次未核） | ✅ 本次遵守约束：**未跑任何整批测试** | **文档防护充分、代码防护缺失**（属可接受取舍：这是测试运行方式约束而非产品行为约束）；建议给 `npm run test:safe` 一条逐文件脚本（见 §7 R10） |
| C6 | 远端 shell = Git-Bash/MSYS（`/End`→路径转换、`$_` 被吞） | ✅ `INSTALL-GUIDE.md:302`、`tools/README.md:33` 坑 1、`setup.mjs:656-659` 铁律注释 | ✅ `runRemotePs1` 统一 `.ps1` 推送 + `-File`（`setup.mjs:665-700`）；`vmInstallCommand`（:528-548）有专门的引号/MSYS 处置注释<br>⚠ 残余一处内联（DEP-08：`deployVm:608-615`） | ✅ 本次未执行远端命令（VM 不可达） | **防护良好**，仅 DEP-08 一处不一致 |
| C7 | `git` 不在 PATH（须用全路径） | ✅ `.workbuddy/memory/2026-09-15.md:28`、`2026-09-10.md:48` | ⚠ 不适用（产品代码不调 git）；本次审计**全程用全路径** | ✅ 实测 `command -v git` → **NOT_ON_PATH**（确证） | 与产品代码无关；对**审计/CI 脚本**（如 §7 R1 建议的 `git rev-parse` 校验项）是硬约束 → 建议任何"读 git 元数据"的实现都走可配置全路径 + 缺失时降级为"未获取到 rev"而非报错 |
| C8 | 内置 Grep 对大文件/多词 `|` 正则假阴性 | ✅ 本次主理人指令中提出；工程文档未收录（属工具面而非产品面，不必收录） | — | ✅ 本次流程：`git grep` 全量检索 → 定点 `Read` 通读 → 结论二次证实。**由此发现并纠正了一处我自己的误判**（DEP-09 原指控"文件缺失→深层抛错"，实为 `install-vm.mjs:489-490` 已有存在性检查） | 流程有效；建议把"`git grep` 二次证实"写进 DDD 文档纪律（见 §7 R10） |

### 5.2 本节约论与新增观察项

**总评**：鸿蒙约束的**知识沉淀是本工程最突出的优点之一**（C1/C5/C6 均有三处以上互相印证的记载，
且都给出了可执行处置，不是"记一句现象"了事）。防护的**不均匀**体现在"文档强于代码"：
C3/C6 已经落进代码纪律，而 C4/C5 只在个别脚本里有回落、其余靠约定。

| 编号 | 级别 | 观察 | 证据 | 建议 |
|---|---|---|---|---|
| O1 | P2（并入 DEP 域计数外的观察，不重复计入 47 条） | `winvm-plugin.mjs:171/564` 用 `findUp(process.cwd(), …)` 作为 `.env` 与"仓库 install-host.mjs"的探测起点。宿主 Agent 调用插件 CLI 时 cwd 通常是 WorkBuddy 的运行目录（本次实测该沙箱 `process.cwd()` 仍可用，但 `winvm-plugin` 被安装到 `~/.workbuddy/plugins/cache/...`，从该处向上找不到仓库 `.env` 与 `delivery/install-host.mjs`） → 依赖 `vm-conn.json` 持久化配置兜底（`install-host.mjs:15` 的写入）。**即：从插件缓存目录运行 `uninstall/update/reinstall` 时，`repoDirForHostInstaller()` 返回 null → 直接报"未找到仓库 install-host.mjs"** | `winvm-plugin.mjs:563-565`、`:937-944`、`:970-976`；USAGE 示例（`:1290` 附近）亦未提示该限制 | ① `repoDirForHostInstaller()` 增加回落链：`--repo` 显式参 > `vm-conn.json` 持久化的 `repoRoot` > `findUp(process.cwd())`；② 在 `check` 里显式列出"仓库根可定位"一项；③ USAGE 标注"update/uninstall 需在项目目录运行" |
| O2 | 假设（需真机） | `detached:true` 能否在鸿蒙沙箱跨 WorkBuddy 会话存活**无代码断言**：`tunnel-daemon.mjs` 写 pidfile，但没有任何"启动后自检父会话归属"的逻辑，`winvm-plugin tunnel status` 只判 pid 存活 | `winvm-plugin.mjs:1042-1075`、`tunnel-daemon.mjs:130-137` | 真机做一次"杀 WorkBuddy → 重启 → `tunnel status`"验证并把结论写进 `INSTALL-GUIDE`（该验证成本低、价值高，属 §7 R6 前置） |
| O3 | P2（计入 DEP-11，见下） | 同构函数的 `/tmp` 回落实现不一致 | `setup.mjs:668-675` vs `uninstall.mjs:706-711` | 抽公共 helper（`delivery/tmp-write.mjs`：`writeTempWithFallback(name, body)`），两处共用 |

#### DEP-11｜P2｜`uninstall.mjs` 写临时 `.ps1` **缺少 `/tmp` 只读回落**（与 `setup.mjs` 同构逻辑实现不一致）
**现象**：`runRemotePs1`（`setup.mjs:668-675`）对 `writeFileSync(tmpdir()/…)` 包了 `catch` 并回落到
`ROOT/.setup-tmp`；而 `uninstall.mjs:706-711` 的同一逻辑写失败后仅打印
`[WARN] cannot write temp ps1: <msg>` 就 `return { ok:false }` → **VM 侧卸载相位整体失败**，
用户看到的下一步只能是"手工删计划任务"。

**证据**：`setup.mjs:668-675`（有回落）、`uninstall.mjs:706-711`（无回落）。

**本次实测修正**：在当前鸿蒙宿主上 `os.tmpdir()` = `/data/storage/el2/base/cache`，
**Node 层可写**（实测写入 + `unlinkSync` 均成功）；shell 层 `/tmp` 才不可用。
⇒ 本条**在本宿主不触发**，严重度定为 P2（跨沙箱可移植性 + 同构代码风格一致性），非现役缺陷。

**影响**：更换宿主（更严格的沙箱、或 `TMPDIR` 指向只读点）时，部署链能自愈而卸载链不能 →
"能装不能卸"是最难看的失败形态（且卸载失败常残留计划任务与端口占用，二次安装会被 DEP-04 的
Delete+Create 窗口进一步放大）。

**建议**：抽 `writeTempWithFallback()` 公共件，两处共用；并在 `preflight.mjs` 增一条
"临时目录可写"断言（`blocking:false`，输出实际使用的回落目录），把 C4 约束变成**可观测**而非"靠某个脚本记得做"。

#### DEP-12｜P2｜`session-start.sh` 的自愈能力完全依赖平台注入 `CODEBUDDY_PLUGIN_ROOT`，缺失时回落推导可能错位
**现象**：钩子（`delivery/hooks/session-start.sh:20-28`）先取 `${CODEBUDDY_PLUGIN_ROOT:-}`，
缺失时按 `${0%/*}` 再取 `${script_dir%/*}` 推插件根。但 `hooks.json` 调用本脚本时 `$0` 的形态
取决于平台执行方式（若以 `sh -c "…"` 或符号链接调用，`${script_dir%/*}` 可能推出仓库 `delivery/`
而非插件缓存根）。脚本的防御是"启动器缺失则静默 `exit 0`"（`:41-44`）——**安全但不可观测**：
隧道没被拉起这件事在会话里不留任何痕迹（日志文件也只在能写时才追加，`:47-50`）。

**证据**：`session-start.sh:20-28`（回落推导）、`:41-44`（静默退出）、`:47-50`（best-effort 日志）；
`install-host.mjs:1082`（把 `hooks/hooks.json` 与 `session-start.sh` 随插件分发）。

**影响**：C2（沙箱 uid 杀隧道）的**唯一自愈机制**如果因路径推导错位而静默失效，
表现就是"隧道时好时坏"——这与 OPS-03（黑洞判据未落地）叠加后排障成本极高。

**建议**：① 钩子内把推导结果与 `--version`/`tunnel status` 的最小探活写入 `tunnel.log`
（现仅写一行"ensure (hook)"，`:47-50`），让"钩子到底找没找到启动器"可事后判断；
② `winvm-plugin check` 增加"SessionStart 钩子可解析插件根"一项（读 `hooks.json` + 模拟 `${0%/*}` 推导）。

### 5.3 追加发现（OPS-09～12，第二轮回扫：平台判据 / 路径一致性 / node 逃生门 / 清理可见性）

> 本小节收窄 §5.1 对照表中 C2/C7 两行的"防护到位"结论，并新增两条与
> "沙箱内 node 只能用 bundle 绝对路径"直接相关的实质项。四条均由本次 `git grep` 实测确证。

#### OPS-09｜P1｜core 侧隧道平台判据**漏 `openharmony`**，与 delivery 四处不一致（根因是 AC 验收面遗漏）
**现象**：§5.1 C2 记的"双值兼容"只覆盖 `delivery/`，**运行时内核漏了**：
```
packages/core/src/transport/ssh-tunnel.ts:68-69
  const useSsh2Backend =
    (process.platform as string) === 'ohos' || process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2';
```
`git grep -n "openharmony" -- packages` **零命中**（本次实测）⇒
`bootstrap.mjs:56`、`install-host.mjs:1134`、`setup.mjs:870-872`、`winvm-plugin.mjs:374`
四处都按 QA E-4 真机实证修过，**第五处（core）从未被纳入该轮修复面**。
根因写在验收标准里：`docs/changes/CL-020/REQUIREMENT.md:53` 的 AC-B.1 只点名
"`install-host.mjs` 与 `winvm-plugin.mjs` 两文件"，未写"全仓平台判据"。

**为什么今天没炸（两条兜底，故未升 P0）**：
① 宿主连接器实跑走 `streamable-http`（`host-a2a-bridge/src/cli.ts:96-103`，注释
"回环（SSH 隧道映射到本机）无需 bearer token"），隧道由 `delivery/tunnel-daemon.mjs` 承载，
**不消费** core 的 `establishSshTunnel`；
② `env.example:64` 与 `INSTALL-GUIDE.md:178` 推荐显式设 `WINVM_TUNNEL_BACKEND=ssh2`，env 兜住判据。
⇒ 触发条件收窄为"未设 env **且** 经 core `ssh-tunnel` 传输"，而该传输类型确实被写进交付配置
（`install-host.mjs:740-751` 生成 `connector.transports:[{kind:'ssh-tunnel',…}]`），
`transport/index.ts:41-52` 据此会 `spawn('ssh', …)` → 鸿蒙无系统 ssh → 隧道直接失败。

**证据**：`ssh-tunnel.ts:60-75`（判据）、`transport/index.ts:41-52`（消费点）、
`install-host.mjs:740-751`（配置生成面）、上列四处 `openharmony`、`CL-020/REQUIREMENT.md:53`。

**影响**：一条"文档已认定、代码只修了一半"的**平台适配回归**；失败形态是 spawn 不存在的 `ssh`
（与 DEP-10/OPS-11 同型：错误只到 ENOENT 层，不指向"平台判据漏值"）。

**修复建议**（一处改动消除五处漂移）：
1. `core/src/constants.ts` 增 `export function isOhHost(p = process.platform) { return p === 'ohos' || p === 'openharmony'; }`，
   五处统一引用（delivery 四处也改为 import 该谓词，防止再次分叉）；
2. AC 口径升级为"全仓 `process.platform` 判据均经 `isOhHost()`"，并加**静态断言单测**：
   `git grep -n "process.platform" -- packages delivery` 的命中行必须含 `isOhHost`
   （杜绝"新增一处判据又漏一个值"）；
3. `preflight.mjs checkHostDeps()` 打印 `process.platform` 实报值
   （现 `:77` 是 `void platform`，显式放弃了平台维度）—— 一行输出即可让该缺陷装机时自现。

#### OPS-10｜P2｜VM 部署根"安装面默认"与"运维面默认"**字面不一致**，且 `WINVM_VM_DEPLOY_DIR` 无任何写入点
**现象**：安装面四处默认统一为 `C:/WinVMBridge`
（`setup.mjs:102`、`bootstrap.mjs:431`、`env.example:38`、`install-vm.mjs:336/448`），
但运维面另起一套：
```
delivery/winvm-plugin.mjs:964-966
function vmPathsForSsh(vm) {
  return process.env['WINVM_VM_DEPLOY_DIR'] || 'C:/Users/User/.WinVMBridge';
}
```
`git grep -rn -F ".WinVMBridge" -- delivery` 本次实测**全仓仅此 1 处命中** ⇒
`C:/Users/User/.WinVMBridge` **不是任何脚本的真实产物**；
`git grep -n "WINVM_VM_DEPLOY_DIR"` 亦**仅此 1 处读取**（无写入点：`install-host.mjs` 不写它，
`writeVmConnConfig`（`install-host.mjs:1332-1347`）的字段清单只有
`host/user/sshPort/servicePort/identityFile`，**不含 `deployDir`**）。

**影响**：`winvm-plugin uninstall --vm` 会 `cd "C:/Users/User/.WinVMBridge"`（多半不存在）后失败
（`winvm-plugin.mjs:949`），错误信息是远端 `cd`/node 报错，**不指向真因**；
即使用户从未改过 `.env`（就用默认 `C:/WinVMBridge`）也一样失败 ⇒ 卸载路径不可用。
定 P2（不影响主功能链，且可从 VM 侧手工执行 `install-vm.mjs --uninstall` 绕过）。

**修复建议**：`deployDir` 纳入 `writeVmConnConfig` 持久化字段（安装时即落），
`vmPathsForSsh()` 改为 `--vm-deploy-dir > env > persisted.deployDir > 'C:/WinVMBridge'`（与安装面同源）；
`check` 增"VM 部署根一致"项。

#### OPS-11｜P2｜`WINVM_NODE` 逃生门**已设计但未接电**（DEP-10 的配套处置缺失）
**现象**：工程其实**已经**为"node 只能用绝对路径"设计了逃生门 ——
启动器与钩子都写 `${WINVM_NODE:-node}`（`deploy-winvm-plugin.mjs:140`、`hooks/session-start.sh:55`），
并有单测钉住该写法（`tests/unit/launcher-posix.test.mjs:49`）。但本次核验发现**三处断链**：
1. **无写入点**：`git grep -n "WINVM_NODE"` 在 `delivery`/`tests`/`packages` 三域仅 **3 处命中**
   （2 处使用 + 1 处单测断言；另有 4 处纯文档记载：`CL-015/DELIVERY.md`、`CL-015/TECHNICAL-SOLUTION.md`、
   `memory/2026-09-14.md`、`memory/2026-09-22.md`），**没有任何代码导出或写入** `WINVM_NODE`；
2. **profile 注入不含 node**：`path-util.mjs:26-27`（注释）与 `:31-42`（实现）只写
   `export PATH="<插件目录>:$PATH"` + `~/.bashrc`/`~/.profile` 标记块，
   注入的是**插件目录**而非 node 目录，也不设 `WINVM_NODE`；
3. **JS 侧完全不看该 env**：`winvm-plugin.mjs:940/959/973/982` 与 `bootstrap.mjs:527` 用字面 `'node'`；
   `sh()`（`:60-67`）是 `spawnSync(cmd,args)`（**不经 shell**），故只吃 `process.env.PATH`。

**证据**：上列行号；对照**同文件内已正确**使用 `process.execPath` 的
`winvm-plugin.mjs:1070`、`setup.mjs:791/858`、`install-host.mjs:829/1137/1211`、`install-vm.mjs:748`
⇒ 两种口径并存，说明"用 execPath"的纪律未推广到跨脚本调用。
另：`sh()` 无 `'error'` 分支（只把 `r.error` 归一为 `status:1`），
而 `setup.mjs:959`、`deploy-vm.mjs:67` 的异步 `run()` **都有** `child.on('error')`
⇒ ENOENT 在 `update/reinstall/uninstall` 路径上只表现为"退出码 1"，归因线索丢失。

**影响**：非登录 shell、WB 内部 spawn、`PATH` 未含 node 的新终端这三类上下文里，
`winvm-plugin update|reinstall|uninstall` 与 `bootstrap … setup.mjs` 都可能 ENOENT；
VM 侧计划任务动作串同样由 `setup.mjs:123/562` 以 `'node'` 字面拼出 ——
`install-vm.mjs:28-30` 的注释**已承认**"计划任务的动作不含任何 env 元素"，
说明该风险工程内已知，只是宿主侧未同治。

**修复建议**（接电三件套，成本 S，与 DEP-10 同治，归入 §7 R8）：
1. 增 `resolveNodeExe()`：`process.execPath` > `env.WINVM_NODE` > `'node'`，替换上述 5 处裸 `'node'`；
2. `path-util.mjs` 的 profile 注入额外写一行 `export WINVM_NODE="<process.execPath>"`，
   让启动器/钩子的逃生门真正生效；
3. 写入任何"计划任务/自启动动作串"前**断言 node 为绝对路径**；
   `winvm-plugin check`（现 6 项，`:571-603`）增"node 可解析且为绝对路径"一项。

#### OPS-12｜P2｜沙箱"删除语义受限"的**后果全线不可见**：清理类调用一律 `catch { /* ignore */ }`
**现象**：§5.1 C3 已确证"代码绕开 shell `rm`、统一 `fs.rmSync({force:true})`"是好纪律；
但同一沙箱还有**另一半**未被应对：`fs.rm`/`rmSync` 被 safe-delete 垫片改写为进回收站，
**回收站不可用则 fail-closed 拒绝删除**（`.workbuddy/handover/05-environment-and-tools.md:69`、
`06-lessons-learned.md:149`、`memory/2026-09-09.md:21` 三处记载）。
本工程所有清理点都写作静默吞错：
`setup.mjs:345`（临时归档）、`:636`（本地 tar 包）、`:696`（临时 `.ps1`）、
`tunnel-daemon.mjs:183-184/189/266-267`（pidfile/state，含 `process.on('exit')` 内）、
`winvm-plugin.mjs:1037`（陈旧 pidfile）、`:1106`/`:1120`、
`path-util.mjs:108`（shell-init 清空时删文件）、`install-host.mjs:343/1351`、
`install-vm.mjs:834`、`uninstall.mjs:520`。**零处**留下失败痕迹
（`tunnel-daemon.mjs` 明明有 `appendFileSync` 日志能力，`:189` 仍写 `/* ignore */`）。

**证据**：上列行号；`.gitignore` 本次核验**含** `.workbuddy/tmp/` 却**不含** `.setup-tmp/`
（回落目录一旦累积会污染 `git status`；工作树当前无该目录，即"本次审计未产生残留"）。

**影响**（三条都不致命，但都是"运维看不到"型）：
① 陈旧 `tunnel.pid`/`tunnel.state.json` 残留 → `tunnel status` 给"pidfile 有、进程无"的混合信号
（虽 `readTunnelStatus` 会再清一次，仍依赖下一次 `rmSync` 成功，可反复失败反复残留）；
② `.setup-tmp/winvm-setup-<ts>.ps1` 每次 dry-run/apply **各留一份、永久累积**；
③ `path-util.mjs:108` 删不掉时 `shell-init.sh` 残留空行/无效行，PATH 注入面变脏。
与 ENG-10 同型（"best-effort 失败必须有计数"），本条专指**鸿蒙删除语义**这一诱因。

**修复建议**：
1. `catch { /* ignore */ }` → `catch (e) { log.warn('清理失败', { path, reason: e.message }) }`
   （各文件都有现成日志通道，零新依赖）；
2. `winvm-plugin check` 增两项"陈旧文件"：`tunnel.pid` 指向不存在的 pid、`.setup-tmp/` 非空 → ⚠️；
3. `.gitignore` 补一行 `.setup-tmp/`；`runRemotePs1` 启动时清该目录下 N 天前的旧文件
   （与 §3 DEP-10 附近 `:980` 的建议同一处落地）。

#### §5.3 附：正面记录（不计入问题数，避免本节读起来全是批评）
`oh-tunnel.mjs:21-30` 的"**本类任何情况下都不会因 emit('error') 让宿主进程崩溃**"契约
（含 `_safeEmitError` 与"单通道失败只丢该连接 / 连接层错误才整条重连"的**两级错误分层**），
以及 `docs/changes/CL-015/TECHNICAL-SOLUTION.md:469` 对 detached 语义的边界划分
（"进程组级 kill 仍存活属预期"vs"OH 沙箱若禁止 spawn 长驻子进程属 OS 层 blocker，非改插件可绕"），
**是可直接复用到其它鸿蒙项目的范式**。本次未发现这两处有问题。

---

## 6. 真机相关项核验状态

**核验声明**：本次审计**未执行任何网络探测**（未 `ping`/未 TCP connect/未 HTTP 请求 172.16.100.2:18443），
按主理人指令"连通性检查失败即记为本次未验证，不长时间重试"，此处直接记为**整体未验证**。
所有依赖真机的判定在下表逐条列出，供下一轮真机验证时**按编号逐项回填**。

### 6.1 本次已完成的核验（只读、离线）

| 项 | 方式 | 结果 |
|---|---|---|
| `delivery/*.mjs` 语法完整性 | `node --check`（`/data/storage/el1/bundle/libs/arm64/node/bin/node`，v24.13.0）逐文件 | **16/16 全部 PASS**：`account-resolve / bootstrap / deploy-shared-skills / deploy-vm / deploy-winvm-plugin / install-host / install-vm / link-workspace / oh-tunnel / path-util / preflight / setup / ssh2-resolve / tunnel-daemon / uninstall / winvm-plugin` |
| `delivery/tools/*.mjs` + `hooks/*.sh` 语法 | 同上（`node --check delivery/tools/diagnose-connectors.mjs`）+ `sh -n delivery/hooks/session-start.sh` | **全部 PASS**（合并计数 **17/17**，`SYNTAX-FAIL=0`）；`sh -n` 通过 → 确证 §5.1 C3 的"纯 POSIX、无 bashism"纪律成立 |
| **策略引擎纯内存复现**（无网络/无 VM/无写盘） | 直接 `import` 已构建的 `packages/core/dist/policy/engine.js` 并调 `evaluate()` | 7 组用例：3 组**绕过成功**（`C:\Users\a\..\..\Windows\System32\…`、正斜杠同形、`C:\Temp\..\Program Files\…` 均 `ALLOW`）、1 组跨能力复现（`storage.file.manage` 同样 `ALLOW`）、2 组**对照 DENY**（`D:\other\x`、`C:\PROGRA~1\x` 命中 `pathAllowlist:miss`）+ 1 组绝对系统路径 DENY（`pathDenylist`）⇒ **DENY 通路本身正常，缺陷精确定位在"未消解 `..`"** → ENG-24 成立 |
| 穿越缺陷的既有测试覆盖 | `git grep -rln "traversal\|穿越\|dotdot" -- tests docs packages`；`git grep -rn -F '..\' -- tests` | 前者**零命中**；后者仅 1 处无关命中（`r3-uninstall-verify.test.js:130` 注释）⇒ **"无测试钉住该攻击面"结论成立**（ENG-24 建议 4 的依据） |
| `openharmony` 在 `packages/` 的命中 | `git grep -n "openharmony" -- packages` | **零命中**（delivery 四处均有）→ **OPS-09 成立** |
| `WINVM_NODE` 全仓命中 | `git grep -n "WINVM_NODE"` | 仅 **3 处**（启动器 + 钩子 + 单测断言），**无写入点** → **OPS-11 成立** |
| `WINVM_VM_DEPLOY_DIR` / `C:/Users/User/.WinVMBridge` 全仓命中 | `git grep -n "WINVM_VM_DEPLOY_DIR"`；`git grep -rn -F ".WinVMBridge" -- delivery` | 各**仅 1 处**（`winvm-plugin.mjs:964-966` 的读取与假默认）→ **OPS-10 成立** |
| 裸 `'node'` vs `process.execPath` 分布 | `git grep -n -e "'node'" -e "execPath" -- delivery` | 裸 `'node'`：`bootstrap.mjs:527`、`winvm-plugin.mjs:940/959/973/982`、`setup.mjs:123/562`、`install-vm.mjs:647/765`、`preflight.mjs:139`；`execPath`：`setup.mjs:791/858`、`install-host.mjs:829/1137/1211`、`winvm-plugin.mjs:1070`、`install-vm.mjs:748` ⇒ **同仓两种口径并存**（DEP-10/OPS-11 依据） |
| `os.tmpdir()` 可写性 | Node 写入 + `unlinkSync`（探针文件自清理） | **可写**（`/data/storage/el2/base/cache`）→ 据此把 DEP-11 从"现役缺陷"降级为"可移植性缺陷" |
| shell `/tmp` | `touch /tmp/…` | **不可用**（写入被拒） |
| `git` / `node` / `ssh` / `scp` / `tar` / `npm` 是否在 PATH | `command -v` 逐个 | `node`(bundled)/`ssh`/`scp`/`tar`/`npm` 在；**`git` 不在** → 确证 C7 |
| `spawn` ENOENT 时是否触发 `close` 事件（为 OPS-11 定性） | 本地 `spawn('不存在的二进制')` 探针 | 事件序列 = `error:ENOENT` → `close:-2/null`（**不触发 `exit`**）⇒ 只监听 `exit`/`close` 而不监听 `error` 的写法会把 ENOENT 误当"进程起来又退了"，错误码 -2 无意义 → OPS-11 建议 1（`resolveNodeExe` + `error` 监听）的必要性成立 |
| `safe-bin` shim 内容 | `ls` | 含 `rm`/`rmdir`/`unlink` + `safe-delete-*.sh` → 确证 C3 的存在性与"绕开 shell rm"纪律的必要性；三处文档记载 fail-closed 语义 → **OPS-12 成立** |
| `psmod/*.ps1` 编码 | 逐文件首字节核验（见 §2.1） | 6 个 ps1 **全部带 UTF-8 BOM**；6 个 psmod 之间**无重名函数** |
| 全仓 `Invoke-Expression` | `git grep` | **零命中**（仅 `policy/defaults.ts:79` 作为黑名单项存在） |
| `this.tasks.delete` / `tasks.clear` | `git grep` | **零命中** → ENG-08 结论成立 |
| `setsid` / `nohup` / `process.getuid` | `git grep` | **零命中** → O2"无跨会话存活断言"结论成立 |
| 告警出口存在性 | `git grep -i "webhook\|alert\|metric\|prometheus\|otlp"` | 命中**全部**为协议方法名/PS 字段名，**零**外发通道；A2A 显式 `pushNotifications:false`（`a2a-framework/src/server.ts:138`、`server.ts:985`）→ **OPS-01 成立** |
| 审计/回执检索能力面 | `git grep -n "audit" -- definitions.ts`；`definitions.ts` 的 `META` 三项、`winvm-plugin` USAGE 的 `list` 四项 | **无**任何"查审计"能力/子命令 → **OPS-05 成立** |
| `verifyChain` 作用域 | `git grep -n "freshChain"` → `server.ts:379` **硬编码 true**（非配置项） | `chain.ts:313` 仅校验 `activeShards` → **OPS-02 成立**（且"配置不可关"是 ENG-12 已记的不安全默认值） |
| 版本指纹落点 | `git grep version` in `contracts/src/bridge.ts` + 12 个 `package.json` | `HealthStatus` 无 `version` 字段；12 包全 `0.1.0`；`server.ts:880/:982` 硬编码 → DEP-02 结论成立 |
| `.setup-tmp/` 是否入库/是否已残留 | `cat .gitignore`；`ls -la .setup-tmp` | `.gitignore` 含 `.workbuddy/tmp/` 但**不含** `.setup-tmp/`；工作树**当前无该目录** ⇒ 本次审计**未产生任何残留**（OPS-12 建议 3 的依据） |
| **本报告唯一写入物** | `git status` 视角（只读核对） | 仅新增 `docs/audit/2026-10-08-implementation-ops-audit.md`；**未** `git add`/`commit`、**未**删除任何文件、**未**执行任何 `--apply/--yes` |

**未做的核验（超出只读范围或有崩溃风险）**：整批 `node --test`（C5）、任何 `--apply/--yes` 写模式、
`install-host`/`install-vm`/`setup` 的实际执行、`git add/commit`（主理人统一提交）、文件删除（C3）。

### 6.2 待真机回填清单（按编号）

| 编号 | 待验证判定 | 静态结论 | 真机验证方法（建议） | 状态 |
|---|---|---|---|---|
| VM 可达性 | — | — | `ping 172.16.100.2` + `nc -z 127.0.0.1 18443`（隧道在时）+ `curl http://127.0.0.1:18443/health` | **本次未验证** |
| ENG-01 | 令牌表泄漏的**实际速率** | 代码路径确定存在（仅 3 处删除点，均不覆盖纯 MCP 拦截） | 长跑：连续触发 100 次 L2 拦截不批准，观察 RSS 与 `/health`（若有该字段）；或在测试内构造 1000 令牌后取 heapSnapshot 计数 | **未验证（仅静态证实）** |
| ENG-02/03/04 | 监听器堆积/`'error'` 缺失/并发双 spawn 的**现场后果** | 逻辑成立；D1 单例被破坏的触发条件依赖 `start()` 失败 + health 探针并发 | `delivery/tools/kill-restart.ps1` 制造失败窗口 + 立即连续 `curl /health`，数 `Get-Process powershell` 实例数 | **未验证** |
| ENG-13 / PSM-01 | 串行单工 + 心跳阻塞 → **D31 重生风暴**的可复现性 | 因果链完整但为**假设**：需"存在 >45s 的能力调用"且"调用期间恰好有心跳/看门狗判定" | 触发 `appops.workflow.run`（600s，`definitions.ts:273`）期间观察 `/health.psBridge.restarts` 是否 +N；复现即坐实 | **未验证（假设）** |
| ENG-15 | `probe:'timeout'` 在真机上的**出现频率**（是否常态截断） | 探针 20s vs 护栏 5s → 静态推断常态 | 连续 20 次 `curl /health`，统计 `psBridge.probe==='timeout'` 占比 | **未验证** |
| ENG-18 | `close()` 卡住导致 kill-restart 偶发慢 / 末段日志丢失 | 静态推断；`logger.close()` 排在 `server.close()` 之后（顺序确定，卡住与否取决于 keep-alive） | `restart` 计时 10 次，比对 `winvm-service-*.log` 末行时间戳与重启时刻差值 | **未验证** |
| OPS-02 | 跨重启篡改**确实检测不到** | 代码确定（`verifyChain` 仅校验 `activeShards`） | 重启服务后手工改历史分片一行 → `curl /health` 看 `chainValid` 是否仍 true | **未验证（静态确定）** |
| OPS-03 | 隧道黑洞态下 `tunnel status` 是否确实报 RUNNING | 静态确定（判据只有 pid+端口） | VM 断电 → 不杀宿主 daemon → `winvm-plugin tunnel status` + `curl /health` 超时 | **未验证** |
| PSM-05 | `Get-RecycleBinInfo` 反复调用的**内存增长** | COM 未释放是静态事实；是否可观测属真机 | VM 内循环 500 次调用，观察 `powershell` 工作集 | **未验证** |
| C2 / O2 | `detached` daemon 能否跨 WorkBuddy 会话存活 | 无代码断言（`setsid` 零命中） | 强杀 WorkBuddy → 观察 `tunnel.pid` 进程是否存活、新会话后钩子是否重拉 | **未验证（本次不做破坏性操作）** |
| OPS-09 | 实机 `process.platform` 的**实际取值**（`ohos` vs `openharmony`）与"未设 env 时经 core `ssh-tunnel` 传输是否真的失败" | 静态确定 `packages/` 无 `openharmony`；触发路径依赖是否有代码经 core 建隧道（当前连接器走 `streamable-http`，**可能自然不可达**） | ① 真机 `node -e "console.log(process.platform)"`；② 真机 `unset WINVM_TUNNEL_BACKEND` 后调 `establishTransport({kind:'ssh-tunnel'})`（或经 `host-a2a-bridge` 显式配 ssh-tunnel）观察是否 spawn `ssh` | **未验证**；若确证"该路径在现网不可达"，本条可**降级为 P2（工程一致性问题）**，`isOhHost()` 收口仍建议做 |
| OPS-10 | `winvm-plugin uninstall --vm` 在真实部署根下的**实际失败形态** | 静态确定两处默认值字面不一致、`WINVM_VM_DEPLOY_DIR` 零写入点 | 真机直接跑一次 `winvm-plugin uninstall --vm`（**破坏性，需主理人批准后另开窗口**），或先在 VM 内 `Test-Path C:/WinVMBridge` 与 `C:/Users/User/.WinVMBridge` 比对 | **未验证**（本次不执行卸载，属写操作） |
| OPS-11 | 宿主计划任务/非登录 shell 上下文中裸 `node` 是否真 ENOENT；VM 侧 `schtasks` 动作串的实际内容 | 静态确定 5 处裸 `'node'` 与 `WINVM_NODE` 零写入点；`install-vm.mjs:28-30` 注释已承认 VM 侧同类风险 | ① 真机 `env -i /bin/sh -c 'node -v'` 类比（验证"无 PATH"时行为）；② 只读导出 VM 计划任务 XML 查动作串是否为绝对路径 | **未验证** |
| OPS-12 | safe-delete 垫片在本宿主**是否真会拒绝** `fs.rmSync`（决定是否从 P2 升 P1） | 静态仅知"回收站不可用时 fail-closed"的文档记载（三处）；本次**未对该垫片做现场触发测试**（需写删文件，虽为探针但已越"只读"边界） | 主理人允许时用探针：写 `$HOME/wbtmp/x` → `rmSync` → 观察是否抛错/是否落入回收站目录 | **未验证**（本次未做删除探针，仅用 `os.tmpdir()` 的一次写删确认 Node 层通路可写可删） |
| 常驻会话（`bridge.ts`/`persistent-session.ts`） | LLM provider 真实降级链路与 warmup 预算表现 | 仅静态审查（未逐行深读） | `WINVM_VM_PROVIDER=workbuddy` 下跑 A5 类 GUI 模板验收 | **未验证** |
| 服务真实版本 | 插件缓存 `0.1.0` dist 是否与仓库一致 | 无法证明（DEP-02 的核心：工程没有指纹） | 建议 `delivery/tools/README.md` 里已记录的 B3 人工字节比对法（`docs/changes/CL-020/DEPLOY-VERIFICATION.md:54`） | **未验证** |

### 6.3 覆盖边界（诚实声明"我没能看到什么"）

1. **四个大文件未逐行深读**：`adapter-agent-workbuddy-llm/src/bridge.ts`（1499 行）、
   `persistent-session.ts`（996 行，仅读 `:200-330`）、`vm-service/src/delegation-audit.ts`（846 行，
   仅读常量与关键段）、`core/src/transport/ssh-tunnel-ssh2.ts`（520 行，仅 grep 到平台判据一处）。
   §1/§4 的结论**不外推**进这四个文件内部；全覆盖需另开一轮（§7 R9）。
2. **`server.ts`（1458 行）与 `winvm-plugin.mjs`（约 1400 行）分段全读**，但非逐行；
   路由表（`:1059-1212`）、健康构建（`:1255-1353`）、生命周期（`:1357-1389`）、
   审批闸（`:746-875`）、`check`（`:567-625`）、`tunnel`（`:1008-1210`）这些结论密集区是完整读过的。
3. **`file-logger.ts` 的运行期写入失败路径**（`:225` 之后）未逐行核验 ⇒ OPS-08 定 P2 并标注"未核验"。
4. **单测未运行**：`tests/unit/`（59 文件 / 1054 基线，`handover/03-current-status.md:5`）本次**未跑**
   （硬约束禁整批 `node --test`；逐文件跑 59 次超出本轮预算）。
   ⇒ "本报告指出的缺陷是否已有单测**钉住反向契约**（即改了会红）"这一层**未系统核验**，
   仅对 ENG-24（穿越，零命中）、OPS-09（`openharmony` 在 `tests/` 未见相关断言）、
   OPS-11（`WINVM_NODE` 仅 `launcher-posix.test.mjs:49` 钉住启动器写法）做了定点检索。
   **特别提示主理人**：修 ENG-24 前建议先跑 `tests/unit/policy.test.js` 单文件建立基线，
   因为路径归一的改动很可能触碰 S-1（`HKLM:` 盘符误判）与 S-5 的既有断言。
5. **ENG-24 的复现基于已构建产物** `packages/core/dist/policy/engine.js`，与 DEP-05 所述
   "dist 可能与 src 漂移"是同一风险面 ⇒ 已用 `git grep` 在 **src** 侧独立核验
   `normalizePath`（`:152-159` 无消解）与 `pathCandidates`（`:356-363` 走同一比对），
   两处文本与 dist 行为一致 ⇒ **结论稳**，但"src 是否已被更 newer 的提交修过"我无法排除
   （本审计基于当前工作树，且未执行任何 git 写操作）。


## 7. 完善路径建议（按 ROI 排序）

**排序原则**：ROI = （消除的失败面 × 该失败面的发生概率）÷（改动行数 × 回归风险）。
本工程的关键特征是"功能已对、可证明性不足"，因此**排在最前的不是修 bug，而是让 bug 变得可见**。
每条给出：覆盖编号｜成本（S/M/L）｜收益｜前置依赖｜验收判据。

| 序 | 主题 | 覆盖编号 | 成本 | 收益 | 前置依赖 |
|---|---|---|---|---|---|
| **R0** | **策略层路径归一（安全修复，优先级高于本表其余全部条目）** | ENG-24（连带 ENG-22/PSM-03） | **S** | ★★★★★ 唯一"本地已复现的绕过"；护栏层当前形同不存在，修复后 §1 的多个 P2（脱敏/审批可读性）价值才成立 | 无 |
| **R0b** | **平台判据收口 `isOhHost()`**（P1 中成本最低的一条） | OPS-09（连带 §5.1 C2 结论修正） | **S** | ★★★★☆ 一处新函数消除五处漂移；附带把 AC 口径从"点名两文件"升级为"全仓判据"，杜绝同类回归 | 无（改动前跑 `tests/unit/policy.test.js` 无关，但建议顺带加静态断言单测） |
| **R1** | **构建指纹贯通**（先让"跑的是哪版代码"可证） | DEP-02、DEP-05、OPS-07、ENG-21 | **S** | ★★★★★ 一次性终结 MEMORY 里 3 次复发的"仓库修复≠运行态"误判；同时是 R2/R5 的判据基础 | 无（纯增量） |
| **R2** | `.generated/` 运行配置**声明式化**（替代三段顺序铁律） | DEP-03、DEP-04 | M | ★★★★☆ 消除"半途失败→配置与源码不一致且无从核对"；把人读文档避坑变成机器保证 | R1（overlay 需带 rev 才能确认生效） |
| **R3** | **有界化专项**：令牌表 + TaskStore + 审计配额 | ENG-01、ENG-08、ENG-16、ENG-20、ENG-10 | M | ★★★★☆ 唯一直接消除长跑风险的批次；且顺手补上 D2 纪律的双标 | 无 |
| **R4** | **ps-bridge 在途感知** + `'error'` 监听 + 代际隔离 | PSM-01、PSM-02、ENG-02、ENG-03、ENG-04、ENG-13、OPS-04 | L | ★★★★☆ 把 D31"记录不修"转为"可修"；同时消除并发 spawn 与监听器堆积 | 建议先做 R5 的观测部分（拿到 restarts/pendingMaxAge 现场数据再动桥） |
| **R5** | `/health` **checks 汇总位 + unknown 态** + 告警出口 | OPS-01、OPS-06、ENG-15、ENG-14 | S～M | ★★★★☆ 纯附加字段，风险极低；是 R1/R3/R4 全部验收判据的载体 | 无 |
| **R6** | **隧道黑洞判据落地**（文档→代码） | OPS-03、DEP-12、O2 | S | ★★★☆☆ 判据已写在两处文档里，实现即"抄自己的文档"；顺带回答 C2 的存活假设 | 需一次真机窗口（VM 可断电场景） |
| **R7** | **鉴权与资源护栏**：`/mcp` `/a2a` token 或明确信任域声明 + 连接销毁 + 回执检索上界 | ENG-05、ENG-23、ENG-06、ENG-07、ENG-17、ENG-18 | M | ★★★☆☆ 安全语义收口；其中 ENG-06/07 是 5 行级修改，可先行 | R5（`auth:'loopback-trust'` 需 health 承载） |
| **R8** | **setup 相位依赖守卫**（APPLY 短路/前置断言） | DEP-01、DEP-06、DEP-07、DEP-08、DEP-09、DEP-10、DEP-11 | M | ★★★☆☆ 部署链"假成功"的根治；顺带统一裸 `node` 与 tmp 回落 | R1（守卫的判据就是指纹） |
| **R8b** | **鸿蒙宿主适配收尾批**（§5.3 四条，与 R8 同域、可并一次评审） | OPS-10（部署根一致性）、OPS-11（`WINVM_NODE` 接电）、OPS-12（清理可见性 + `.gitignore`）、O1（`repoDirForHostInstaller` 回落链） | **S** | ★★★☆☆ 全仓 `git grep` 已把每条的定位钉死，改动集中在 `winvm-plugin.mjs` / `path-util.mjs` / `.gitignore`；做完后 `check` 从 6 项扩到 9 项，鸿蒙侧装机自诊断能力显著上升 | 无（建议 `check` 扩展与 R5 的 `/health.checks` 用同一套"检查项"心智模型，避免两种实现） |
| **R9** | **大文件专项深读**（本轮未逐行覆盖的 4 个文件） | 覆盖边界声明（§6.3） | M（人力） | ★★☆☆☆ 预防性；若 R4 完成后仍有桥/会话异常再启动 | R4 的现场数据 |
| **R10** | **工程卫生批**（低风险小修，随时夹带） | ENG-09、ENG-11、ENG-12、ENG-19、ENG-22、PSM-03、PSM-04、PSM-05、PSM-06 | S | ★★☆☆☆ 单项收益小，但 `appops.cli.invoke` 定级（ENG-22/PSM-03）例外，建议提到 R7 一起做 | 无 |

### 7.0 关于 R0 / R0b 的补充说明（两条 P1 级"一处改动"项）

**R0（ENG-24）为什么排在本表最前**：其余条目的收益多为"让问题可见"或"消除长跑风险"，
而 R0 是**唯一一条"当前安全控制实际失效"的项**，且本次已给出确定性复现（§6.1 的 7 组用例）。
它的改动面也小：`normalizePath()`（`engine.ts:152-159`）是**单函数**，
黑名单（`:441-455`）与白名单（`:484-500`）都经它 → 一处修好两层同时受益。

**R0 的实现纪律**（避免"修一个绕过、引入一个 S-1 型误杀"）：
1. 归一必须是**纯语法消解**（`a\..\b` → `b`、根之上的 `..` 钳制在根），
   **不得**调用 `path.resolve()` 借工作目录展开 —— 相对路径在本工程语义里应当**直接拒绝**
   而非"按 cwd 猜"（cwd 在鸿蒙沙箱下不可靠，见 §5.1 C1 / O1）；
2. 保留 `normalizePath` 现有两个正确行为：UNC `\\` 前缀不被折叠、根路径不被吞尾斜杠（`:155`）；
3. **改前先建基线**：`tests/unit/policy.test.js` + `r19c-*` 系列单文件跑通
   （S-1 的 `HKLM:` 盘符误判、S-5 的注册表配对断言都在这片区域，
   归一改动最容易连带把 `HKLM:\SOFTWARE\…` 的形状改掉）；
4. 改后补测：穿越三形态（反斜杠 / 正斜杠 / 混合）+ 越根钳制 + UNC 穿越 + 注册表串不受影响，
   并把 `defaults.ts:3-5` 的"命中即拒"承诺在 `SECURITY-GOVERNANCE.md` 里
   改写为"基于**语法归一后**的形态判定" —— 文档与代码必须同一口径（DDD 原则 7）。

**R0b（OPS-09）为什么单独成项而不是并进 R8/R10**：它是**唯一的"平台适配类 P1"**，
且修复方式与其它所有条目不同（不是加防御，而是**抽谓词 + 加静态断言单测**）。
成本约 20 行（一个函数 + 五处引用 + 一个 grep 型断言测试），
收益包含一项**外溢价值**：`preflight checkHostDeps()` 打印 `process.platform` 实报值之后，
未来任何"WB 升级导致 platform 取值变化"都会**在装机阶段自现**，
而历史上这类变化是靠 QA 真机跑出来再回写 AC 的（QA E-4）。

**两条一起做的顺序**：R0 → R0b（R0 涉及安全、R0b 涉及可用性；两者无代码交叠，可同轮不同 PR）。

### 7.1 R1 详细方案（ROI 第 1，建议本轮就做）

**为什么第一**：本报告中至少 **6 条结论的最终验收**（ENG-02/03/04、DEP-03、OPS-03、PSM-01）都依赖
"先证明真机跑的是含修复的构建"。`docs/changes/CL-K3R/QA-REPORT.md:35` 的原话是
"必须先部署，否则真机跑旧代码，**任何验证通过都是假的**"；
当前唯一手段是人工字节比对（`docs/changes/CL-020/DEPLOY-VERIFICATION.md:54` 的 B3 项）。

**最小实现（三处改动，全部纯附加）**
1. 构建产物加指纹：`npm run build` 末尾（或 `install-vm.mjs` step 2 后）写
   `packages/vm-service/dist/build-info.json = { rev, buildAt, dirty, node }`；
   `rev` 取 `git rev-parse --short HEAD`，**必须走可配置全路径**（C7：本宿主 `git` 不在 PATH，实测确证），
   取不到则降级为 `"unknown"` 而非报错。
2. `/health` 透出：`HealthStatus` 增**可选** `build?: {rev,buildAt,dirty}`（`contracts/src/bridge.ts:125`，
   符合该文件 :53 已确立的"纯附加"纪律），`buildHealth()`（`server.ts:1255`）读取 dist 同目录 JSON 填入。
   `agentCard.version`（`server.ts:880`）同样从 `build-info.rev` 派生而非硬编码 `0.1.0`。
3. 部署断言：`setup.mjs` HEALTH 相位（现有两段式重试处）比对
   "期望 rev（本地 build 时算出，写入 `buildDeployManifest`，`setup.mjs:300-320` 现无哈希字段）"
   与 "真机 `/health.build.rev`"，不一致 → 明确输出
   `❌ 版本不匹配：期望 <a>，实跑 <b>（说明部署未生效或插件缓存未更新）` 并置 `failed++`。
   `install-host.mjs` 侧同理：复制 dist 前做 `src mtime > dist mtime` 新鲜度告警（R1 与 DEP-05 合并）。

**验收判据**：故意只改 `src` 不 `build` 跑一次 → HEALTH 相位必须 ❌；正常全流程 → 必须 ✅ 且 `/health.build.rev` 非 `unknown`。
**成本**：约 80～120 行（含 2 个单测：`build-info` 解析缺文件降级、rev 不一致判定）。
**风险**：极低（纯附加字段 + 只读比对；不动任何执行路径）。

### 7.2 ENG-01～08 的打包建议（回答"哪些应一次修完"）

**建议分两批，不要一批**（理由：批次 1 与批次 2 的回归面完全不同域，混在一起会让真机验收无法归因）。

**批次 A（同一 PR，长跑内存/资源回收主题）——覆盖 ENG-01、ENG-08、ENG-20、ENG-16、ENG-10**
- 共同点：全是"给一个当前无界的结构加界"，改动集中在 `server.ts` 的 Map 生命周期、
  `task-store.ts` 的终态回收、`chain.ts` 的配额。互相**无时序耦合**，可并行实现、一次评审。
- 关键设计约定（避免各改各的）：统一引入一个 `sweep(periodMs)` 的**单一定时器**模式
  （复用 `ps-bridge.ts` 已有的 `watchdog` + `timer.unref()` 纪律，`server.ts` 生命周期 `close()` 处需一并 `stop()`）。
  ENG-01 的令牌 TTL、ENG-08 的终态任务 TTL、ENG-16 的配额检查共用这一个清扫器 → 不新增第二个定时器泄漏。
- 验收：新增单测"1000 令牌过期后 `pendingApprovals.size===0`"、"终态任务 N 分钟后不在 `tasks`"、
  "超过 `maxTotalBytes` 时 `/health.audit.degraded===true` 且不再写入"。

**批次 B（同一 PR，ps-bridge 进程间契约主题）——覆盖 ENG-02、ENG-03、ENG-04、ENG-13、PSM-01、PSM-02、OPS-04**
- 理由：这七条是**同一个契约缺失的七个投影**（Node 多路复用 ↔ PS 同步单工；无代际；无取消；错误静默）。
  单独修 ENG-03（加 `'error'` 监听）或单独修 OPS-04（看门狗感知在途）都会留下"修了但仍会误判"的半态。
- 建议的最小自洽集：
  ① `spawnAndReady` 前对旧 child `removeAllListeners()` + 显式 `failAll(new Error('BRIDGE_RESTART'))`（ENG-02）；
  ② `child.on('error')` + `stdin.write(payload, err => …)`（ENG-03）；
  ③ `start()` 加**单飞 Promise**（`this.starting ??=`），去掉 `server.ts:453` 的 `.catch(()=>undefined)`，
     改为 catch 后 `logger.error` + 记 `lastError`（ENG-04），并让 `restarts` **只在成功重启后自增**；
  ④ 请求 payload 带 `gen`（代际号），`dispatch` 丢弃非本代响应（替代 `if(!waiter) return` 的静默）；
  ⑤ 看门狗在 `pending.size>0` 且最老在途 < 其 `timeoutMs` 时**顺延**（OPS-04）；
  ⑥ PS 侧消费 `timeoutMs`：至少对可中断者协作取消，不可中断者在超时点落一条
     `CANCELED_BY_CALLER` 诊断行（PSM-02），并把长任务改为"提交-轮询"或与 ⑦ 一并做；
  ⑦ PS 主循环心跳与请求解耦（PSM-01）：至少把"执行期心跳"改为执行前先回一条
     `BUSY:<id>` 帧，让 Node 侧知道"桥活着但在忙"。
- 顺序依赖：**批次 B 的 ⑤⑥⑦ 必须配合一次 ps-bridge 重启（铁律：psmod 不可热更，
  `docs/INSTALL-GUIDE.md:298`）**，且**必须落在 R1 之后**——否则真机验收无法区分"改了没生效"与"改坏了"。
- ENG-05/06/07（安全与资源护栏）留在 **R7**：与桥无耦合，独立小批。

**批次归属表**

| 编号 | 归属 | 理由 |
|---|---|---|
| ENG-01 | A | 无界结构 |
| ENG-02 | B | 桥契约 |
| ENG-03 | B | 桥契约 |
| ENG-04 | B | 桥契约（单飞/计数语义与 B③ 同一处代码） |
| ENG-05 | R7 | 信任域收口，独立 |
| ENG-06 | R7 | 端点资源上界，独立 |
| ENG-07 | R7 | 5 行级，可随 R7 先行 |
| ENG-08 | A | 无界结构 |
| ENG-13 | B | 与 PSM-01 同契约 |
| ENG-20 | A | 随令牌 TTL 一并做 |
| ENG-16 | A | 配额 + 清扫器 |
| ENG-10 | A | 计数暴露与 A 的 `/health` 改动同文件 |
| ENG-09/11/12/14/15/17/18/19/21/22/23 | R10 / R5 / R7 | 见上表 |
| **ENG-24** | **R0** | 安全控制失效，单函数改动，优先级高于其余全部条目 |
| ENG-22 / PSM-03 | R7（随鉴权批） | `appops.cli.invoke` 定级 + `custom` 白名单是同一处收口 |
| ENG-23 | R7 | 与 ENG-05 同一信任域决策，必须一起定调 |
| PSM-01/02 | B ｜ PSM-04/05/06 | R10 |
| DEP-01～12 | R8（DEP-02/05 归 R1、DEP-03 归 R2、DEP-11 归 R8b） | 部署链主题内聚 |
| OPS-01/06 | R5 ｜ OPS-02 | R5（`chainScope` 字段）｜ OPS-03/04 | R6/R4 ｜ OPS-05/07/08 | R1/R5 |
| **OPS-09** | **R0b** | 平台判据收口，独立且极小 |
| **OPS-10 / OPS-11 / OPS-12 / O1** | **R8b** | 鸿蒙适配收尾批，与 R8 同域可并一次评审；OPS-11 与 DEP-10 同治 |

### 7.3 明确"不建议现在做"的三项（避免审计被读成整改清单）

1. **不建议把审批闸改成"默认拒绝"**：`DEFAULT_POLICY` 的路径/命令双黑名单 + `requiresApproval` 分级
   是当前工程能同时满足"dryRun 免审批（`allow:dry-run-bypass`）"与"L2+ 必须记名批准"的平衡点，
   收紧会直接冲击宿主侧自动化可用性。ENG-22 的 `appops.cli.invoke` 定级问题应在**该能力自身**收口，不动全局。
   ⚠ 注意与 R0 区分：**R0（ENG-24）不是"收紧策略"，而是"让已声明的策略真正生效"** ——
   文档写的是"命中即拒"（`defaults.ts:3-5`），代码做的是"字符串像不像"，
   修 R0 不改变任何一条黑白名单的内容，只改变判定基座，因此不会冲击自动化。
2. **不建议现在重写 ps-bridge 为"多工作线程 PowerShell"**：PS 5.1 无 cheap 并发模型，
   R4 的 ⑤⑥⑦ 三招（在途感知 + 取消语义 + BUSY 帧）已能消除 D31 的触发条件；
   真并发需换 PS 7 + Job，成本与本项目的收益不匹配（D31 历史记录亦为"复现条件特殊，服务可自恢复"，
   `docs/changes/CL-018/REQUIREMENT.md:200`）。
3. **不建议引入第三方日志/审计存储**（如 SQLite/ELK）：`file-logger` 的自研轮转（10MB×7、14 天、
   启动清理、60s 节流）已达"范本"水准，`chain.ts` 的哈希链依赖 append-only 文件语义；
   换存储会破坏既有取证叙事，收益只在"检索面"，而检索面可用 R5/OPS-05 的 `audit.query` HTTP 端点低成本补齐。

### 7.4 一页纸结论

- **代码质量**：高于平均。防御式设计（D1～D30 系列、K4/K5/K-N1 安全语义、纯附加纪律）有真实的"为什么"注释与踩坑取证，
  这类工程的可维护性溢价远大于本报告列出的 **19 个 P1**。
- **最值得马上做的三件事**：
  **R0**（`normalizePath` 消解 `..`，S 成本，**唯一本地已复现的安全绕过**）>
  **R0b**（`isOhHost()` 收口，20 行，消除五处漂移）>
  **R1**（构建指纹贯通，S 成本，终结长期"仓库修复≠运行态"误判）；
  其后是 **R3** 有界化批次（M 成本，消除唯一确定的长跑泄漏）。
- **必须靠真机才能定论的 16 项**已全部登记在 §6.2（含本轮新增的 OPS-09/10/11/12 四条），
  **本轮不声称任何真机结论**；其中 ENG-13/PSM-01 的 D31 因果链在 §1/§2 中**均已显式标注为「假设」**。
- **本次审计的可复现产出**：除静态证据外，新增了**两项本地确定性核验**——
  ① `node --check` 17/17 通过（含 `tools/diagnose-connectors.mjs`）+ `sh -n` 钩子通过；
  ② 策略引擎纯内存复现 ENG-24（7 组用例，含 3 组对照 DENY 证明 DENY 通路本身正常）。
- **本报告的覆盖边界**：4 个大文件（`bridge.ts` 1499 / `persistent-session.ts` 996 /
  `delegation-audit.ts` 846 / `ssh-tunnel-ssh2.ts` 520 行）未逐行深读，结论不外推到这些文件内部；
  `tests/unit/` 59 个单测文件本轮**未运行**（禁整批 + 预算），故"缺陷是否已被反向契约钉住"仅做定点检索。
- **纪律遵循**：全程只读 —— 未执行任何 `git add/commit`、未运行任何 `--apply/--yes` 写模式、
  未删除任何文件、除本报告（`docs/audit/2026-10-08-implementation-ops-audit.md`）外未改动任何文件。

