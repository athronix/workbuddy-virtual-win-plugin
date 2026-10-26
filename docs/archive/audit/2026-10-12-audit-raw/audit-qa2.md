# WinVM Bridge 三维全面审计 · 接力棒 B（QA 严过关 2 · 只读）

- 审计人：software-qa-engineer-2（接力棒）· 团队 software-winvm-audit
- 开工：2026-10-12 20:30（+08:00）；HEAD=`13b8705`；工作树 `git status` 仅 .workbuddy/ 与 qa/r19/p2close-teams-cleanup.txt、v3-kn2.* 等未跟踪件，**零 tracked 改动**（本棒亦零写入 REPO）
- 接力判定：前棒 `wbtmp/audit-qa.md`（6634B / mtime 2026-10-12 20:12:36）实际写到 **A1(①)+A2(②) 完整成节**，其 timeline 末行 `B6 20:05:19` 为开工心跳、正文无 ⑥ 节 ⇒ **本棒自 ⑥ 起接续**。并发监测：20:29:49 与 20:36 两次 stat 均为 6634B/20:12:36 未增长 ⇒ **前棒未复活**（若其后复活由主理人按节号合并两文件）。
- 纪律：全程只读。唯一写入=本文件 + `wbtmp/audit-qa2-timeline.log` + 探针输出 `wbtmp/audit-qa2-health.json`（仓外）。

---

## ⑥ 隧道三死死因模式 + runbook 成文缺口

**数据源**：`~/.workbuddy/winvm/tunnel.log`（456 行，跨度 2026-09-21T12:01Z → 2026-10-12T07:49Z）、`delivery/tunnel-daemon.mjs`、`delivery/oh-tunnel.mjs`、`delivery/winvm-plugin.mjs`（spawnTunnelDaemon/cmdTunnel）、`delivery/hooks/hooks.json`、在线只读探针。

**日志分级实计**（grep -c / sort|uniq -c）：
- WARN「隧道错误（已内部消化，走退避重连）」**360 条**：`connect EHOSTUNREACH 172.16.100.2:22` 292 / `No response from server` 47 / `Timed out while waiting for handshake` 11 / `Keepalive timeout` 10。
- ERROR「隧道启动失败」**45 条**：`connect EHOSTUNREACH` 37 / **`缺少必填项 vmHost` 8**（时间戳 09-30×2、10-03×1、10-09×3、10-12T01:41:35×2）。
- ERROR「重连耗尽，有序退出」（giveup）**0 条**。INFO「隧道已就绪」41 条。

**退避逻辑代码事实**：`oh-tunnel.mjs:554` 指数退避 `min(30s, 1s×2^(n-1))` + 0~30% 抖动；`:170` `maxAttempts` 默认 **Infinity**，而 `tunnel-daemon.mjs:220-237` 构造 Tunnel 时**不传 maxAttempts** ⇒ giveup 路径在 daemon 默认配置下**永不触发**（与日志 0 命中互证）；keepalive 30s（daemon 覆写 `:232`）、readyTimeout 15s（`:231`）。

### 三死死因（证据归位）

| # | 死因模式 | 机制 | 日志/代码实证 |
|---|---|---|---|
| D1 | **VM 不可达 → 黑洞→退出**（主死因，占 ERROR 82%） | 断连后指数退避重连（WARN 消化）；重连后 `tunnel.start()` 再失败走 `catch ⇒ logLine(ERROR) ⇒ shutdown()`（tunnel-daemon.mjs:270-274）→ 进程退出、pidfile/state 删除、18443 停监听 | 10-09 06:29:18 起 20 连串 WARN（Keepalive timeout→No response→EHOSTUNREACH×17）→ 06:53:23 一条 ERROR 启动失败即终；`EHOSTUNREACH` 合计 329 条。MEMORY 看门狗同日记录「200+OPEN baseline broken…VM appears powered off」 |
| D2 | **裸 daemon 无参启动即退**（复活失手型，即今日手工复活的踩坑面） | daemon 不读 `vm-conn.json`，连接参数只能从 argv 来（`parseDaemonArgv` 全空初值）；`oh-tunnel.mjs:118` 校验抛「缺少必填项 vmHost」→ 死因一尾部 catch → 启动即退。**正确入口是 `winvm-plugin tunnel ensure`**（cmdTunnel→spawnTunnelDaemon 从 vm 记录补 `--vm-host/--vm-user/--key`，winvm-plugin.mjs:1058-1066） | 8 条 ERROR；10-12 序列=01:41:35 缺参失败×2 → 01:43:58 带参就绪 → 02:35:25 再就绪 → 07:40:29 第三次就绪(pid 51633)，与主理人「今日三次手工复活」逐一对齐。**注意**：`~/.workbuddy/memory/MEMORY.md:26` 运维配方写的恰是裸 `delivery/tunnel-daemon.mjs` 用法——配方本身埋雷 |
| D3 | **同秒双实例竞写**（幂等判据无锁） | `spawnTunnelDaemon` 先 `readTunnelStatus()` 判 STOPPED 再 detached spawn（:1053-1076），**检查与拉起间无锁**；两个 ensure 并发时双双通过判定 → 两实例同抢 18443，输者 EADDRINUSE/黑洞退出，但胜者就绪行与重复行已同秒写进日志，判读时极易误当「就绪后又死」 | 紧邻全等重复行 9 组（awk 实测）：如 10-12 01:43:58.791 `隧道已就绪`×2、01:41:35.529 ERROR×2、07:49:04.444 `已有隧道进程 pid 51633，不重复启动`×2（hook SessionStart 与手工 ensure 同秒并发实证）。注：`logLine` 双写 stdout+文件（daemon:103-107），文件行内无 pid 字段，重复行≠双进程，需与 pidfile 对读 |

**在线复验（只读探针，20:3x）**：pid 51633 存活；`tunnel.state.json` = RUNNING/ready@07:40:29Z；`curl http://127.0.0.1:18443/health` → **HTTP 200（400ms）**，body 存 `wbtmp/audit-qa2-health.json`（provider ready、session healthy、capabilities 54/54、audit chainValid、bearer not-mounted ok）。隧道面当前健康。

### runbook 成文缺口判定

**已成文（合格）**：恢复动作三级命令 `tunnel status / ensure / restart` 权威口径在 `skills/winvm-orchestrator/SKILL.md:91-140`（含「判定只以本命令输出为权威，state.json 可能陈旧不得据其判健康」）、`README.md:223/236-237`、`docs/INSTALL-GUIDE.md:281/285`；黑洞半死判据在 `INSTALL-GUIDE.md:297`；SessionStart 自启钩子 `delivery/hooks/hooks.json`（幂等 ensure、失败不阻塞）。CL-020 D8/D16 已把 skills 内处方性手工 ssh 文案改净并复证。

**未成文（缺口）**：
1. **P1 文档硬冲突**：`docs/05-peripherals/USER-MANUAL.md:82` 故障自救仍教手工 `ssh -f -N -L 18443:127.0.0.1:18443 vmadmin@<vm-ip>` —— 与 `winvm-orchestrator/SKILL.md:92-93`「隧道由 daemon 承载、手工 ssh 会与守护进程争抢 18443 而失败」**直接冲突**；且用户名 `vmadmin` 与实际 `User` 不符。product-audit J1/J13（2026-10-08）已登记，本审计复核**至今未修**（非工程用户第一入口给的是错误处方）。
2. **P1 三死因自诊表缺失**：全仓 docs 对「缺少必填项 vmHost」0 命中（git grep）；裸 daemon vs `tunnel ensure` 的入口之辨、双实例同秒竞写的日志判读、`隧道已就绪`重复行含义，均无处成文。`docs/design/tunnel-crash-fix-progress.md` 只覆盖 D1 的代码侧修复（F1–F8），不含 D2/D3 运维判读。今日三次手工复活 = 为该缺口付费的实况证据。**建议**：INSTALL-GUIDE 排障章补「隧道三死因速判表」（日志特征→死因→第一动作= `tunnel ensure`，并显著标注禁用裸 `node tunnel-daemon.mjs`）。
3. **P2 giveup 死代码**：daemon 未设 maxAttempts ⇒ F6/F7「重连耗尽有序退出+STOPPED 留痕」永不发生，黑洞态实际表现为 D1（start 再失败退出）或无限 30s 封顶退避；读者若信「giveup 会留 STOPPED 痕迹」会在日志里找不到对应行而误判。要么 daemon 显式传有限 attempts，要么在 GATE-POLICY/design 写明「giveup 仅测试面可达」。
4. **P2 凭据路径漂移不可辨**：`spawnTunnelDaemon` 仅在 `vm.identityFile` 在场时传 `--key`；缺席时静默落 `oh-tunnel.mjs` 的 `~/.ssh` 默认探测链（INSTALL-VERIFY-REPORT.md:117 的修复）。vm-conn.json 的 identityFile 漂移后失败表象与真网络故障（EHOSTUNREACH/handshake timeout）在日志里**同形**，建议 ensure 日志行打印 key 来源。
5. **P2 无轮转**：tunnel.log 无 logrotate（21 天 58KB，量级暂无害，重复行噪声稀释判读）。

**分级建议汇总⑥**：P1×2（USER-MANUAL 手工 ssh 冲突未修；三死因自诊 runbook 缺失）；P2×3（giveup 死代码；key 来源不可辨；无轮转）。

---

## ⑦ VM 生命周期口径成文度（改 psmod 必重启 / kill-restart / deploy 顺序铁律）

三件事逐一问「在哪份文档、写了几处、醒目否」，实测如下。

**1. 「改 `psmod/*.ps1` 必须重启 VM 服务」（ps-bridge 不可热更）→ 成文合格，散布 10+ 处**
- 权威设计面：`docs/02-design/CAPABILITY-MODEL.md:147`「运维事实：修改 psmod/app.ps1 后**必须重启 VM 服务**才生效（ps-bridge 常驻进程按启动时快照加载 psmod）」。
- 排障面：`docs/INSTALL-GUIDE.md:298`（§8 故障排查表行「改了能力模块但不生效」→ 处置 `delivery/tools/kill-restart.ps1`）。
- Skill 面（用户/agent 第一触点）：`skills/winvm-mcp-reference/SKILL.md:191` 第 4 步「重启 WinVMBridge.Service（ps-bridge 启动时 dot-source 全部模块，**不可热更**；不重启则旧模块仍在内存）」——运维 skill 在场，✅。
- 契约文档 + 源码注释：`docs/design/r19b-s1-kn2-contract.md:239` 甚至预写了判读口径（「重启前实测观察到旧行为 ≠ 修复失效」）；MEMORY.md:8 拓扑段一行内嵌。
- 判定：**已成文、双通道（人读 INSTALL-GUIDE + agent 读 SKILL.md）均可达，合格**。小瑕疵：DEPLOYMENT.md（§5 监管与运维章）未提该纪律——运维文档族里只有 INSTALL-GUIDE 与 mcp-reference skill 承载，读 DEPLOYMENT 的部署者会漏（P2）。

**2. 「重启只用 `kill-restart.ps1`（不重跑 install-vm）」→ 成文位置最深，醒目度不足（P1）**
- 唯一成文处＝`docs/changes/phase2-arch-design.md:330` K-7 行 + MEMORY.md:24 + `docs/changes/CL-K3R/TECHNICAL-SOLUTION.md:222`、`docs/test/reports/k3r-t05-runbook-2026-10-05.md:39`。全部是**变更/会话档**，docs/02 与 docs/05 设计·运维权威面**零命中**（git grep 实证：DEPLOYMENT/INSTALL-GUIDE/ARCHITECTURE 无「不重跑 install-vm」字样）。
- 危害不对称：INSTALL-GUIDE:298 只教了「重启用 kill-restart.ps1」，但没写反例禁令——新人在 VM 上「重启服务」时顺手重跑 `install-vm.mjs` ⇒ `.generated/vm-service.runtime.json` 与 `start-hidden.ps1` 被重新生成 ⇒ bearer/env 手改补丁被静默抹掉（正是 DEP-03 登记的病灶，`implementation-ops-audit.md:938` 评 P1、建议改声明式 overlay 至今未落地，见 :1590 R2 行）。
- 脚本侧佐证：`delivery/tools/kill-restart.ps1` 实测 27 行纯 schtasks+taskkill，无 config 再生成，「不覆盖补丁」成立——纪律本身正确，缺的是把它抬进权威运维文档。

**3. 「顺序铁律：先部署 → 后打补丁 → 再 kill-restart」→ 三处权威成文，合格；附一条机检缺口**
- 权威面在场：`docs/05-peripherals/DEPLOYMENT.md:465`「顺序铁律不变：**deploy → 补丁 → kill-restart**（deploy-vm.mjs --apply 会重新生成运行时配置与 ps1，手工补丁必须在部署之后）」——置于 bearer 三步开启流程尾部，正是踩坑场景；K-6（phase2-arch-design.md:329）；INSTALL-GUIDE §5 一键部署的相位表（:205-206 VM→VM-START 顺序即机制保证）。
- **缺口（P2）**：三处成文全部是**文字承诺**，deploy-vm/install-vm 内**零 md5 校验**（git grep `md5|Get-FileHash` 于 delivery/deploy-vm.mjs、install-vm.mjs、kill-restart.ps1 = 0 命中）——CL-018/TECHNICAL-SOLUTION.md:539 明文要求「psmod 改后本地↔VM md5 一致校验」，但该纪律只存在于变更文档，脚本未实装、门禁未覆盖，实际靠 QA 手工探针留档（qa/ 中 t6/t7 轮三哈希 BYTE_IDENTICAL 是手工证据）。顺序违反（补丁先、部署后）目前**无任何机检显形面**，DEP-03 的声明式 overlay 方案在 comprehensive-assessment.md:70 仍列 backlog。

**⑦ 结论**：三件事中 1、3 成文合格（位置正确、双通道可达）；第 2 件「kill-restart 排他」是 P1 醒目度缺口——最重要禁令只活在 changes/ 会话档，未进 DEPLOYMENT §5 / INSTALL-GUIDE §8；另 P2×2（DEPLOYMENT 未提 psmod 重启纪律；md5 校验与顺序铁律无机检兜底）。建议合并动作：在 DEPLOYMENT.md §5 增设「VM 侧变更三分法」小节（改 psmod→kill-restart；改 runtime 配置→补丁后禁止再 --apply；改 dist→走 deploy-vm 全流程），一并吸收 K-6/K-7。

---

## ⑧ 插件分发：改 dist 必实跑 install-host 的醒目度 + 版本恒 0.1.0 治理

**A. 「改 dist/源码 ≠ 运行态生效，必须实跑 install-host」醒目度：弱（P1）**
- 全仓检索该口径的成文位置：`overview.md:196`「仓库修复 ≠ 运行态生效：须实跑 `delivery/install-host.mjs`（宿主缓存是运行态真相源）+ VM 侧部署重启服务」——**但该句挂在 overview.md 的「待办（部署未做）」标题下**（`## 待办（部署未做）` 小节），语义被局部化为"CL-K3 那一批没部署"，读者不会当作长期纪律；且 overview.md 已被 `docs/06-OVERVIEW.md` 取代为权威概览（见⑪双概览），而 **06-OVERVIEW.md 全文零命中「install-host」**。
- README.md 的安装段（:223 隧道、:296 Phase0 守卫）未出现「改码后必须重跑 install-host」字样；`skills/winvm-orchestrator/SKILL.md` 只写连接器信任/重启会话，未写分发刷新（git grep `install-host` 于 skills/ 仅命中 mcp-reference 与 deploy 相关段落，无「运行态真相源」口径）。
- `docs/INSTALL-GUIDE.md` §7/§8 亦无该坑条目：§8 排障表有「psmod 不生效」但没有「改 packages/dist 后宿主侧仍跑旧缓存」。
- 实证危害在场：`.workbuddy/memory/2026-09-*` 多轮记录"部署态插件缓存才是真相源、改仓不改缓存 = QA 实测到旧码"；`docs/audit/2026-10-08-implementation-ops-audit.md` DEP 族亦登记「宿主缓存陈旧」类问题。⇒ 该坑**已被反复踩且已留痕**，但从未抬到醒目位。
- **P1 建议**：把「改 dist / 改 delivery / 改 skills ⇒ 必实跑 `node delivery/install-host.mjs`（幂等，dry-run 先行）方可验收」写进 ①README §8 门禁纪律段（与"跳过门禁即视为未验收"并列）②`docs/06-OVERVIEW.md` 交付段 ③`INSTALL-GUIDE §8` 排障表新增一行；overview.md 那句应划线移交权威文档而非留在旧概览。

**B. 版本恒 0.1.0 治理：无版本面纪律，缓存路径硬编码版本（P1）**
- 事实源实测：根 `package.json` 无 `version` 字段（`$GIT grep '"version"' package.json` → 零命中）；`delivery/winvm-plugin`/plugin 清单版本恒 `0.1.0`。缓存根路径 = `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`。
- 文档面把**具体版本号写死进命令**：`skills/winvm-orchestrator/SKILL.md:96/97/134/135/136`、`skills/winvm-app-manager/SKILL.md:21`、`skills/winvm-app-operation/SKILL.md:30` 共 7 处字面量 `winvm-bridge/0.1.0/winvm-plugin`，且 SKILL 自己注明「本机 `<version>` = 0.1.0」；`docs/INSTALL-GUIDE.md:285`、`overview.md` 拓扑段亦写死 `0.1.0`。
- 治理缺口三点：①**无 bump 规则**——GATE-POLICY / phase2-arch-design 无版本策略条，`install-host.mjs` 亦无版本比对/迁移逻辑（git grep 未见 version bump）；②**版本不变 ⇒ 缓存目录不隔离**：改码后重跑 install-host 是就地覆盖 `0.1.0/`，运行态与仓库无指纹可对照（`implementation-ops-audit` DEP-03/R1「运行配置无 rev 指纹」同族病灶，:1590 R1 行建议加产物指纹至今未落地）；③**版本号写死在 skill 命令里**——一旦真 bump 到 0.1.1，9+ 处文档命令全部失效（新坑，且没有任何守卫钉住它们：`skills-check` 只比对双树一致性，不校验版本字面量与安装器版本对齐）。
- **P1 建议**：(a) `install-host.mjs` 打印「缓存根 rev + 关键产物 sha」并在 `/health` 或 `winvm-plugin check` 透出 `distFingerprint`（对齐 audit R1）；(b) skill/文档里把 `0.1.0` 改为 `<version>` 占位 + 一句"用 `winvm-plugin --version` 或 ls 缓存根取实值"，或 (c) 明确声明「0.1.0 为静态发布版本、每次分发覆盖同目录」并写入 GATE-POLICY「不进门禁」之外的《分发口径》小节——三选一，但**必须有其一**，当前状态是既无 bump 也无"就地覆盖"声明，属治理真空。

---

## ⑨ 凭据面扫描（入仓迹象 + 权限面）

**方法**：`git ls-files` 文件名模式筛 + `git grep` 内容形态筛（私钥块 / password 字面量 / token 赋值）+ `.gitignore` `check-ignore -v` 实证 + `git log --all` 历史漏网回溯 + 运行态文件权限实测。全程只读。

**结论：零真实凭据入仓，防线成立；3 处卫生级瑕疵（P2）+ 1 处工具缺口（P1）。**

| 检查项 | 实测 | 判定 |
|---|---|---|
| `.env` / `.key` / `.pem` 类文件名入仓 | `git ls-files \| grep -iE '\.(env\|key\|pem\|p12\|pfx)$'` → **仅 `.env.example`**（模板，本应入库）；`delivery/env.example` 同 | ✅ 干净 |
| 真实 `.env` / `.env.deploy-vm` 是否被忽略 | `git check-ignore -v`：`.env` ← `.gitignore:16`、`.env.deploy-vm` ← `:36 .env.deploy*`、`delivery/.generated/` ← `:9` 三条**全部命中**；两文件工作树存在（660/417B）但未跟踪 | ✅ 规则在册且生效 |
| 历史漏网（曾经提交过） | `git log --all --oneline -- .env .env.deploy-vm` → **0 条**；`git ls-files delivery/.generated` → **0 条** | ✅ 无历史包袱 |
| 私钥块字面量 | `git grep 'BEGIN .*PRIVATE KEY'` → **0 命中** | ✅ |
| 口令/令牌字面量 | `git grep -E 'password\s*[:=]\s*"..."'` 仅 2 处：`delivery/__tests__/oh-tunnel-error-handling.test.mjs:174 password:'test-password'`、`probe-tunnel-error.mjs:154 'probe-password'`（测试哨兵值，且 `oh-tunnel.test.mjs:349 'SUPER_SECRET_PASSWORD_xyz'` 是**断言不泄漏的反例夹具**）；`WINVM_BEARER_TOKEN='<值>'` 形态仅出现在 `qa/r19/t5-enforce-patch.mjs:17 'p2t5-probe-token-9f3a'`、`t6-a2a-call-bearer.mjs:12 'p2t6-wired-token-4c7e'` —— **一次性合成探针值**（T5 commit 自述"探针 token 一次性合成值非真实凭据"），非真实凭据 | ✅ 成立，但见 P2-1 |
| 运行态凭据文件权限 | `~/.ssh/id_ed25519` = **600** ✅；`~/.workbuddy/winvm/vm-conn.json` = **660**（组内可读写，内容=host/user/sshPort/**identityFile 绝对路径**，无密钥本体）；同目录 `tunnel.log`/`tunnel.pid`/`state.json` 亦 660 | ⚠ P2-2 |
| 会话记忆入仓的面 | `.workbuddy/memory/**` 设计上入库，内含 VM IP `172.16.100.2`、用户名 `User`、密钥路径、pid 等**基础设施拓扑**（MEMORY.md:8、看门狗日志数百行） | ⚠ P2-3 |

**P1（工具缺口）：敏感扫描无强制面。**
- 现状=纯人工习惯：`.workbuddy/memory/2026-10-11.md:49`「提交前敏感扫描干净」是 commit 叙事里的一句话，**没有对应脚本**——`scripts/` 仅 gate/dep-lint/config-key-lint/lock-probe 四件，`package.json` scripts 无 `scan/secrets` 项，`git ls-files .git/hooks` 实跑 `.git/hooks/` 非 sample 文件 **0 个**（**无任何 pre-commit 钩子**）。⇒ 「扫描干净」这一断言不可复核、不可重放，与门禁「跳过门禁即视为未验收」的自定纪律**不对称**（分层/配置键有 dep-lint+config-key-lint 双机检，凭据面反倒只有口头）。
- 建议（P1）：新增 `scripts/secret-scan.mjs`（形态：私钥块 / `password|passwd|token|secret` 赋长值 / `Bearer `+长串 / 十六进制 ≥32 位连续串），排除 `*.example`、测试哨兵白名单（`test-password`/`probe-password`/`p2t5-probe-token-*` 等），**入 gate ST2c**（与 ST2/ST2b 同为静态档），GATE-POLICY 里登记为「安全承诺型判据」族。成本极低（现成 `git ls-files` + 正则，纯 node stdlib），正对 K-10「永绿守卫」风险——因为它是**唯一还没有机检的安全面**。

**P2 三条**：①`qa/r19/t5-enforce-patch.mjs:17` 把「注入 start-hidden.ps1 的 env 行模板」整行入库，虽值是合成的，但**脚本可被原样重放以在生产 VM 上开 enforce**，且真实运维若沿用同文件名替换值，容易把真值写进同名受版本控制文件——建议脚本加显著标记「合成值，禁止替换成真值后提交」并改名 `*.example.mjs`；②`vm-conn.json` 660 → 建议 install-host 落盘时 `writeFileSync(..., {mode:0o600})`（现仅 `writeJson` 默认 666&~umask），组内用户可读「VM IP+用户名+私钥绝对路径」是横向信息暴露，改一行即可；③`.workbuddy/memory/` 入库的拓扑（IP/用户名/密钥路径）在仓库若外发即泄漏，建议交付前做一次「memory 目录脱敏策略」裁决（当前 README 未声明本仓仅限内部分发）。

---

## ⑩ .dev/ 六索引新鲜度 + docs 相对链接死链批量扫描

（并发注记：前棒复活已续写 ③④⑤ 至 audit-qa.md 22192B@21:04，本节与本棒 ⑥⑦⑧⑨ 均不与 ③④⑤ 重叠；⑤ 孤儿测试已由前棒覆盖，本棒不复做，仅在⑫复核其 sweep 归档口径时引用。）

**A. 六索引新鲜度（mtime 实测 + 内容对账）**

| 索引 | mtime | 新鲜度判定 |
|---|---|---|
| `.dev/README.md` | 09-10 | 导航表只列 5 件（README+4 索引），`kn2-s4-a5-verify.md`（10-08 新增第 6 件）未入导航表——体检 R11 已登记「登记第 7 个 .dev 文件」**仍未修**（P2） |
| `.dev/project-dir-file-index.md` | 10-07 | **Phase 2 全部新资产零登记**：`scripts/GATE-POLICY.md`、`scripts/gate.mjs`、`scripts/lock-probe.mjs`、恢复的 `dep-lint.mjs`/`config-key-lint.mjs` 在该文件 grep `gate\.mjs|GATE-POLICY|lock-probe|config-key-lint` = **0 命中**；`delivery/__tests__/`（N5）、`tests/psbridge-smoke.mjs`（N6）也未补登（P1，见下） |
| `.dev/project-dev-status.md` | 10-08 | 测试基线停在 **70 文件/1162→1247/71**（10-08 口径），与终态 **92/1889** 差 22 文件/642 例；Phase 1 T1-T5、Phase 2 T1-T12 全部模块状态未入表（表体最新行=CL-K3R 10-06）（P1） |
| `.dev/changed-log.md` | 10-10 09:51 | 最后一条=「2026-10-10 QA 收官批」；**10-10 下午起的 Phase 2 批（664eff9 T1 → 13b8705 收官，22 个 packages commits）零登记**（P1） |
| `.dev/changing-log.md` | 10-08 | 10-08 体检裁定其 :4-9 六项「待终验」与 README「已闭环」互斥应统一修复（R4），现状需与 Phase 2 完成态再对账（P2 联动⑪） |
| `.dev/docs-index.md` | 10-08 | grep `phase1|phase2` = **0 命中**——`docs/changes/phase1-arch-design.md`、`phase1-t1..t5-notes.md`、`phase2-arch-design.md`（Phase 2 权威设计，664 行级）、`docs/changes/CL-021/022/K3R` 后续批文档均未入阅读顺序索引；文件停在止血收官轮（10-08）（P1） |

**结论**：六索引自 **2026-10-10 之后集体停更**，Phase 2 全期（T1–T12，基线 79→92 文件、1457→1889 例、门禁基建四件）在 DDD 索引面**零登记**——正是 ddd-skill「索引即时同步」红线的大面积失守。危害实证：新人/新棒 agent 按 `.dev` 导航进入，会拿到「71 文件/1247 例、gate 不存在、Phase 2 未开始」的过期世界模型，与本审计开工时的判定困难（要翻 22 条 commit 才能拼出现状）即为其直接代价。**P1 建议**：T13 候选清单加一项「六索引 Phase 2 补登轮」（docs-index 补 phase1/2 设计+notes 全部、dev-status 基线 92/1889、dir-index 补 scripts 四件+delivery/__tests__+psbridge-smoke、changed-log 补 10-10~10-12 段、README 导航补第 6/7 件）；成本≈一次文档批。

**B. docs/skills 相对链接死链批量扫描（AST 级脚本，118 个 .md / 18 个相对 md 链接 → 11 死链）**
- **族 1（8 处）：审批卡模板路径过期**——R17 原生渲染批把 `approval-card.md` 从 skill 根移入 `references/`，但引用未全部改：5 个领域 SKILL.md（app-manager:104 / app-operation:187 / gui-automation:131 / storage-manager:104 / system-admin:97）与 `docs/changes/CL-016/TECHNICAL-SOLUTION.md` 仍写 `../winvm-orchestrator/approval-card.md`（实际在 `../winvm-orchestrator/references/approval-card.md`）；总控 SKILL.md 自己也有 2 处 `./approval-card.md`（:256/:335）指错层（实际 `./references/approval-card.md`）；`references/approval-card.md:166` 内部相对链接 `../winvm-orchestrator/approval-card.md` 自指回旧路径。⇒ agent 按链接取模板即 404。P1（skill 是 agent 运行时读物）。
- **族 2（3 处）：`approval-card-widget.html` 仓库失踪**——SKILL.md:280/:323 与 approval-card.md:166 引用该 HTML，**仓库 git 全历史零命中**（`git log --all --diff-filter=D` 0 条、`ls-files` 0），但部署态 `~/.workbuddy/connectors/skills/connector-winvm/.../references/approval-card-widget.html`（4071B，10-10）**存在**。⇒ 该文件从未入库（或被手工塞进部署树）：**仓库 ≠ 分发真相源**，skills 双树一致性检查（deploy-shared-skills 的 skills-check）显然只比对已入库文件，漏了这个孤儿。若有人重跑 install/deploy 覆盖 connector 树，视觉卡模板将丢失且不可再生。P1（建议：把 html 提交入库，纳入 deploy 清单对账）。
- docs/ 域内其余相对链接全活（18-11=7 处活链 + backtick 路径引用非链接不计）。`.dev/docs-index.md` 的 83 个反引号路径引用中 31 个裸名不可直接解析（多为文件名简写非路径，属叙述性引用，不判死链；但 dir-index 缺登记见 A）。
- **建议**：死链扫描脚本值得沉淀为 `scripts/link-lint.mjs` 入 gate ST3（纯 stdlib fs，<10s），否则每次修文档都会再漂。

---

## ⑪ 文档一致性漂移（ARCHITECTURE vs package.json layer vs dep-lint rank / 现状段过期 / 双概览）

> 任务书注"前棒维①已证 3 处偏差可引用"——实测前棒报告通篇 grep「偏差」零命中（其①为 GATE-POLICY 对账，③引 dep-lint 派生式样板），**该 3 处偏差未在其文落成可引用条目**，故本节为我独立三角核验全量结论（若前棒后补同题，以其+本节合并）。

### 三角核验：ARCHITECTURE.md ↔ packages/*/package.json layer ↔ dep-lint LAYER_RANK

**rank 侧无漂移**：`scripts/dep-lint.mjs:95-102` 前缀表 `L0=0/L1a=10/L1b=20/L1c=30/L2=40/L3=50`，与 12 包 `layer` 字段前缀（实采 L0-contracts/L1a-core/L1b-a2a-framework/L1b-mcp-framework/L1c-host-sdk/L2-adapter-agent/L2-adapter-agent-llm×2/L2-adapter-host/L2-vm-capabilities/L2-vm-service/L3-host-bridge）全可映射；`:343` 有"新层位未同步 rank 表"报错兜底。**字段→rank 这一边是活的（T11 派生式，机检在面）。**

但**文档侧三处实证漂移**：

1. **P1｜host-a2a-bridge 层位互相矛盾**：`docs/02-design/ARCHITECTURE.md:126` 包清单表把 `packages/host-a2a-bridge` 列在 **L2**（"宿主 A2A 通道"），而 `packages/host-a2a-bridge/package.json` 的 `layer="L3-host-bridge"`（rank=50），dep-lint 按字段判 L3 ⇒ 机检事实源与权威设计表**层位相反**。ASCII 框图（:100-108「L2 适配层」）也未画该包（更无 L3 框）。
2. **P1｜dep-lint 承诺的"口径注记"从未落地（悬空承诺）**：`scripts/dep-lint.mjs:88-93` 头注明文「散文与字段若有分歧，**由本批 README/ARCHITECTURE 口径注记显形**，不在 lint 里私改一套 rank」——但 `git grep -E '单一事实源|口径注记|散文与字段' -- docs README.md` 中 **ARCHITECTURE/README 零命中**（唯一命中在 REQUIREMENTS.md:33，另一主题）。且注释所引「设计 §254 散文把 vm-service 写作 L3」处（现 :254 已是 PowerShell 选型表）经 T6（e0b6945，10-11「文档九处订正」）改写后**原句已不在**，指针对着已消失的文本。⇒ 承诺的止血动作没做，反而留下"注释引用过期原文"的次生漂移。
3. **P2｜包清单表缺 2 行**：ARCHITECTURE §2.2 表（:120-129）共 10 行，盘上 12 包 ⇒ `adapter-agent-workbuddy-llm`（layer=L2-adapter-agent-llm）仅在 :187 散文中一句带过、**无表行**；`adapter-agent-hermes`（同层）完全缺表，且 ADR-10（:328）仍写「**后续可加** `hermes`/…框架零改动」——hermes 包与 HERMES-AGENT-PROVIDER.md 均已入库多时，**选型叙述停在"未来式"**。

### 现状段过期抽查（K5 / HOST-A2A-BRIDGE）

- **K5-server-replay-approval.md ✅ 新鲜**：最后提交 928f437（10-12，T8 同批），新增「§7 P2-T8 现状对齐（2026-10-12）」并把旧设计划线诚实化——是全仓"设计文现状段维护"的样板，无需整改。
- **HOST-A2A-BRIDGE.md ⚠ P1 一处过期叙述**：§6（:176）「⚠ **该契约尚未在真机 codebuddy 上验证**」+ §9 风险表（:219）「codebuddy CLI 参数契约 ❗未验证」——与两处实况冲突：①代码 `packages/adapter-agent-workbuddy-llm/src/bridge.ts:127-137` 的 `DEFAULT_CLI_ARG_TEMPLATE` 已是 CL-017 REQUIREMENT.md:91 裁定的**真机契约**（`-p {prompt} --output-format text --permission-mode bypassPermissions --add-dir {output} --mcp-config {mcpConfig}`，与旧 `--goal/--system-prompt` 形态完全不同）；②`.dev/changing-log.md:3` 口径对齐段明文「codebuddy CLI 参数契约 已在 R18/R19/CL-K3R T05 真机轮闭环」。⇒ 文档 10-12 还有提交（349ecc2 加了 §8 P2-T9 登记）却**漏改 §6/§9 现状断言**——正是 T11 防漂移口径要防的"文档说有、代码已是"族。次生 P2：§8 :206「单元测试 143 项全绿」静态数字违反自家 T11 口径（README:286"任何'当前基线=N 文件/M 例'…不静态维护"；06-OVERVIEW:5 同），过期数（现基线 92 件/1889 例）留在设计文里易被引用。

### 双概览：overview.md（根）vs docs/06-OVERVIEW.md

- **P1｜根概览整体过期 14 天且指针自身也漂**：`overview.md` 最后提交 **c93133f（2026-09-28），落后 HEAD 182 commits**；其 §九（:99-103）自声明「后续轮次与本文档不同步，以权威文档为准」并把读者指向 06-OVERVIEW——但该指针括注「当前态：**194/194 测试通过、12 包**」对照 `docs/06-OVERVIEW.md` 现文：**"194"零命中**（T11 后 06-OVERVIEW:5 明确拒绝静态数字、改锚 qa/ sweep 汇总行）。⇒ 连"以权威为准"的转述都已漂；而文件头（:1-3）仍是"第一轮澄清总结"叙事、:196「待办（部署未做）：须实跑 install-host」与运行态真相相悖（见我的⑧，前棒⑧同题）。从仓库根进来的读者/Agent 第一眼是一页**自称待办实已做**的旧状态页。
- **P2｜结构性并立无治理动作**：两文并存、体裁不同（overview.md=追加式会话流水 232 行多轮 H1 堆叠；06-OVERVIEW=维护中的 123 行现状页），但无 deprecated 横幅、无移动 archive、README §8 权威链未点名 overview.md 处置。建议：根 overview.md 顶部加一行「历史轮次存档，现状唯一入口 docs/06-OVERVIEW.md」并在 dir-index 登记，比删除更可审计。
- **06-OVERVIEW 自身 ✅**：d1d34a6（10-12，T11）同批更新，基线锚定口径正确（漂移风险由 .dev 索引断供承接，见我的⑩-A）。

**分级汇总**：P1×4（host-a2a-bridge 层位矛盾；口径注记悬空；HOST-A2A-BRIDGE §6/§9 过期；根 overview 漂 182 commits 且指针失实）+ P2×3（包清单缺 2 行+ADR-10 未来式；§8 静态数字违规；双概览无治理横幅）。**修复优先级**：口径注记悬空（②）最廉价——只需在 ARCHITECTURE §2.2 表加一行注记「层位以 package.json layer 字段为准（dep-lint 单一事实源），本表散文若与字段分歧以字段为准」，同时即消解①的对外歧义。

---

## ⑫ 规范执行迹象盘点（权威报告命名 / GATE-POLICY / 测试口径 / 裁决落档 → qa/ 与 docs 实况）

### 一、「每轮一份权威 real-test-<date>-runN.md」命名合规度

**规范原文**（三处成文）：`docs/test/reports/real-test-2026-09-23.md:154`「自本轮起每轮仅一份权威报告，路径固定 `docs/test/reports/real-test-<YYYY-MM-DD>-run<N>.md`」；`docs/changes/CL-020/DELIVERY-SUMMARY-2026-09-23.md:138`；已升格为坑 **K-18**（`docs/changes/phase2-arch-design.md:341`，含「证据目录删除必留痕」附加条款）。

`docs/test/reports/` 22 份实测：

| 时段 | 命名形态 | 合规判定 |
|---|---|---|
| 09-23~24 迁移期 | `real-test-2026-09-23{,-run2,-run3,-run4,-run6}.md`、`real-test-2026-09-24-run7.md` | ✅ 符合 `<date>-run<N>`（**run5 空洞**：run6:3 明写「前置：run5 部署」而 run5 文件不存在——git 无删除痕迹，即"run5=当日双份其一被作废合并进 run6"，与规范"改名 .superseded"留痕要求不符，编号洞无痕可寻） |
| 09-28~30 | `real-test-2026-09-28-k4-approval.md`、`-09-29-k5-e2e.md`、`-09-30-r18/r19.md` 等 | ⚠ 前缀保留但后缀换成**主题名**（k4/k5/r18/r19，无 run 号）——同日多事时（09-28 有 -k4-approval 与 -uninstall-wecom 两份）"每轮一份权威"靠语义自觉 |
| 10 月（K3R 轮起） | `k3r-t05-real-machine-2026-10-06.md`、`k3r-t05-runbook/blocker-2026-10-05.md`、`a2a-coverage-2026-10-03.md`、`r2-m4-diagnosis.md`、`r17-qa-2026-09-30.md`、`k3/k4/k5-fix-qa-*.md`、`tunnel-mode-qa-2026-09-28.md` | ❌ **`real-test-` 前缀完全消失**——最后命中规范名的文件停在 09-30-r19；10-06 后真机权威报告（k3r-t05-real-machine）+T5/T6/T7 真机批次证据（`qa/r19/t5-*`,`t6-*`,`t7-*`，前棒①证实存在 10+ 件/批）**全部不在 reports/ 权威命名体系内** |

**P1 结论**：规范执行呈"9 月合规→10 月弃用"曲线，且**旧名与新名并存导致"最新权威真机报告"无法由命名推导**——只能靠内容考古（前棒④判真机全量最后权威轮=09-24-run7、最后真机记录=10-06 k3r，正是命名漂移的直接代价；其 P0 与本条互为表里）。
**P2 佐证链**：①轮次台账失效——`docs/test/real-test.md:1084-1088` §9「执行记录（Run 归档）」表**只有 Run1 一行**，run2~7、r18/r19、k3r 全部未回填，末行提交停在 c93133f（09-28）；②作废留痕条款失效——Run1 冲突两份中"前者改名 `.superseded.md`"（DELIVERY-SUMMARY:138 自述已做）**盘上与 git --all 全史均查无**（`qa/evidence/real-test-run1-20260923.md` 无入库/删除/改名记录，仅存裸证据目录 `qa/evidence/run1-20260923/`）＝"删除必留痕"（K-18 附加条款）未执行；③模板自相矛盾——`real-test.md:875` 仍建议证据落 `qa/evidence/real-test-run<N>-<YYYYMMDD>.md`，与 :154"权威只认 reports/ 下 real-test-<date>-run<N>.md"双轨并存。
**建议**：把权威真机报告收敛为 `real-test-<date>-<批次代号>.md`（承认主题名替代 run 号的既成事实），并给 gate 加"新增 docs/test/reports/*.md 必同步 §9 台账行"的文档守卫（模式已有：K5 §7、P2-T9「文档在位」钉均先例）；`.superseded` 改名补一次留痕 commit。

### 二、GATE-POLICY ↔ 执行证据

- ✅ **门禁真在跑**：每批收官 sweep 留档成链条——`qa/r19/p2t11-gate-quick-rerun.txt`/`gate-full-rerun.txt`、`t11-lock-probe.txt`（VERDICT=GO）、t11/t12/p2close 多档 sweep-result；GATE-POLICY.md 与 gate.mjs 双写声明有 GATE_GUARD_FILES 表对位。执行迹象良好。
- ❌ **P1｜GATE-POLICY ST4 表自身违 K-18**：`scripts/GATE-POLICY.md:98` 静态写「`phase2-snapshot-truth.test.js` | … | **17**」——用例数硬编码进规范文件，而 T11 自家口径（README:286、06-OVERVIEW:5）明令**不得静态维护计数**。数字今日恰为 17＝静默过期型（改测试不减守卫绿，表却悄悄说谎）。建议该行改锚「见最新 sweep 行」或派生（gate 报告行已有 tests=N 数据面）。
- ✅ K-1（基线只进不退）有 p2close 92/92 GREEN + t11 92/1889 双证；K-1 对 2 skip 的"既有权威口径不得当回归"注（GATE-POLICY:127）与实测一致。

### 三、测试基线口径（README:286 / 06-OVERVIEW:5 三规则）

README:286-292 立的口径三规则**自身执行不自洽**：

1. **❌ 规则1（权威源=qa/ 最新一轮 sweep 汇总行）在文件间冲突**：`qa/r19/t12-sweep-result.txt`（mtime **09:37**，git 序=09:44 **T12 收官**，汇总行 FILES=89 TOTAL_TESTS=1751）晚于 `t8-sweep-result.txt` 但**早于** t9(91/1857)→t11(92/1889)（提交序 3fbaea6 T12 → 7429090 → 0abdfa2 T9 → d1d34a6 T11）。按"最新**一轮**"（git 收官序）＝t11=92/1889 ✅ 与我方基线一致；按"最新**文件**"（mtime/字典序）＝t12=89/1751 ❌。同目录混放**编号与完成序倒挂**的工件，字面口径两读两果。
2. **❌ 规则3（按 mtime/`sort -V` 取最新）实测即错**：`ls -1 qa/r19/*sweep-result.txt | sort | tail -1` → `t9-sweep-result.txt`（91/1857，过期），`ls -1t` → `t9`（mtime 被 git checkout 重置为 15:58，最晚却内容最旧）——**两种推荐查法都返回过期文件**（前棒①第 5 条实测 `sort|tail -1` 给 t9 非 t11，判 P1，与本条互证）。
3. ⚠ **P2 格式双轨无标注**：`t11-sweep-result.txt` 无汇总行（`GREEN … tests=N` 逐行+尾注），`p2close-sweep.txt` 是 `90/92 … verdict=GREEN` 行式（前棒①引证时"两种线格式"踩坑实感同源）。汇总行机器解析不可移植，建议统一模板。
4. ✅ 规则2（skip=2 恒 ssh2-resolve OFFLINE_SKIP）逐档兑现：t12/p2close/SKIP_ATTRIBUTION 行均带归因。

### 四、裁决落档（决策-归档规范）

- **抽查 4 项裁决全部有据** ✅：Q1=(b)（运行期接线不入门禁）→ GATE-POLICY:85/130 + phase2-arch-design §13；Q2（snapshot 降级为信息性，10-10）→ phase2-arch-design:461 §13 表 + `docs/02-design/ARCHITECTURE.md:297`「经用户裁决不实现（Phase 2 · P2-T3 / Q2 裁决 2026-10-10，降级为信息性）」三处一致（snapshot-truth 守卫 17 例为其强制面）；PM-08（零平台成本门禁优先）→ GATE-POLICY:14；Q7（warn 除框架审计边）→ GATE-POLICY:54。落档纪律是本仓**最强项**：裁决→设计表→规范→守卫测试四级贯通。
- ⚠ P2 一处形态例外：Owner 裁决集中登记在 `.dev/changing-log.md:54`「Owner 裁决登记（2026-10-08 晚·体检后拍板）」——该表落在 **`.dev/` 索引区**而非 docs/changes 决策链，且 `.dev/` 索引停摆（我的⑩：changed-log 最后条目 10-10、22 个 Phase2 commit 未登记）意味着**裁决登记与索引同步纪律是人工自觉、无机检**（对照 §13/守卫有测试钉——治理不对称）。

### 分级汇总

**P1×3**：权威报告命名规范 10 月起事实弃用（与④真机缺口互锁）；基线"最新一轮"口径规则1 在 t8→t12 倒挂工件上两读两果（规则3 推荐查法实测双双返错）。**P2×4**：GATE-POLICY:98 静态计数违自家 K-18；§9 轮次台账仅 Run1；run5 洞+.superseded 留痕缺失＋real-test.md:875 模板双轨；sweep 汇总行格式双轨＋裁决登记落 .dev 区无索引机检同步。
**正面确认**：GATE-POLICY 执行证据链完整（本维度最大存量资产）、K-1/K-1 判据兑现、四项抽查裁决四级落档全部成立——规范"制定-执行-留痕"骨架真实存在，漂的是**命名/计数/指针**三类机械细节，与⑩索引断供同根（缺自动同步面）。

---

## 接力收尾（software-qa-engineer-2 · 交棒状态）

- **接力起点判定**：开工时 audit-qa.md=6634B（前棒止于②全文+B6 起稿 stub）⇒ 我按任务书从 **⑥** 续写，未动 ①–⑤；期间前棒复活连续补齐 ③④⑤⑥⑦⑧⑨⑩（终检 52024B@22:11），**与我 ⑥–⑩ 重叠**——按铁律我从未写 audit-qa.md 本体、也未删改任何重叠判断，两文互为独立取证（结论方向一致、证据面互补：我侧独有 D1/D2/D3 三死亡模式日志考古、t12/t9 基线倒挂实验、三角层位核验、K-18 命名曲线表；前棒侧独有 ④真机缺口 P0、⑤孤儿测试三方对账全表）。
- **本人成稿**：⑥⑦⑧⑨⑩⑪⑫ 七节（本文件），⑪⑫ 为前棒尚未触达的净增量。
- **我的 P0 清单**：⑥–⑫ 无 P0（最高 P1）。全案唯一 P0 来自前棒④（真机 E2E 全量轮 09-24-run7 后断档 59 commits，k3r 10-06 仅窄域记录）；前棒⑥自评"P0/P1 混合"以其文为准。
- **合并建议**：终稿（主理人任务 #2）以 audit-qa.md 为主干（①–⑩），⑪⑫ 直接拼接本文件；⑥–⑩ 重叠区可按"P0/P1 取并集、证据取并集"折叠，两文对同一问题的定级差异仅 ⑥（前棒含 P0 定性、我全 P1——差异点在"隧道死亡是否已造成实损"，合并时以主理人运行态观察裁断）。

---

## 勘误（22:3x 终检，合并前必读）

前棒于 22:28 复活补齐 ⑪⑫+汇总（audit-qa.md=72907B 全案闭环）。本节文件状态相应变更：
1. **⑪"K5 ✅ 新鲜"判定作废**——前棒 J-5 纠正：`K5-server-replay-approval.md:3` 头部状态行仍"设计定稿，待实现"（实已落地+真机验收，停更 13 天）。以 J-5 为准。
2. **⑪⑫ 整体从"净增量"降级为"证据补充件"**，主干用前棒①–⑫+汇总。本文件 ⑫ 仍存的三处净证据（建议并入）：a) 基线查法双失效实验（`sort|tail -1`→t9、`ls -1t`→t9，mtime 被 checkout 重置的机理）；b) GATE-POLICY:98 静态"17 例"违 K-18；c) `.superseded` 改名 git --all 全史查无实据。
3. ⑥–⑩ 重叠区与⑪⑫互证部分维持原状（独立取证方向一致）。team-lead 裁断：⑥整体 P1（runDaemon 缺参即退保留 P1）；前棒汇总的 P0-2 需按其裁断下调。
