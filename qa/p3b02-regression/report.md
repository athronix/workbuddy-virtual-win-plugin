# Phase 3 启动批（批0 f568427 + 批2 235d7a0）独立回归验证报告

- QA: Edward（software-qa-engineer 严过关）
- 时间窗: 2026-10-13T07:01Z 起（429 中断一次，timeline 增量落盘自救后续跑）
- HEAD 观测: 099d850；验证对象 = f568427（批0 文档止血）+ 235d7a0（批2 部署可达）
- 纪律执行: 零 git 写 ✓；真机面只读 ✓；单测逐文件 spawn ✓；脏项回避 ✓；新文件零禁扫描词 ✓

## ★ Phase 3 新基线（V-A.1 实测，醒目位）

> **99 件 / 1945 例 · pass 1943 / fail 0 / skip 2 · gate FULL VERDICT = GREEN**
> 证据: `qa/p3b02-regression/gate-full-run.txt`（FILES=99 FAILED_FILES=0 TOTAL_TESTS=1945
> TOTAL_PASS=1943 TOTAL_FAIL=0 TOTAL_SKIP=2；DISK_TEST_FILES=99 RUN=99 MATCH）

与理论值精确吻合：Phase 2 终态 92 件/1889 例 + 批0 新守卫 1 件 11 例 + 批2 新 6 件 45 例
= 99 件/1945 例。批2 六件逐件在册（deadlink 6 / install-host 6 / prepare-vm 9 / psmod-drift 13 /
tunnel-start 6 / winget-treekill 5 = 45 ✓）。

skip=2 唯一来源核验：`ssh2-resolve.test.mjs skip=2`（OFFLINE_SKIP 既有权威口径，gate 行 104），
无其他 skip/fail/todo。

分段结果：ST1 tsc GREEN（12 包编译）｜ST2 dep-lint GREEN（hard=0 warn=0）｜ST2b config-keys
GREEN（未知键=0）｜ST3 guards GREEN（7 件 155 例）｜ST4 sweep GREEN（92 件 1790 例）。

## V-A 全量回归

通过。补充防假绿机制核验：gate.mjs `parseTapCounts` 解析不到 TAP 计数单独判红（NOSUMMARY 机制
在位，行 240-255）；ST4 恒逐文件 spawn 避 junction 0xC0000005 假全红；DISK/RUN MATCH 防枚举漏件。

## V-B 批0 对抗面复核

### V-B.3 旧承诺零残留 grep（独立构造词表，未照抄成员清单）——五条全过

| 词表 | 结果 | 关键命中语境 |
|---|---|---|
| ① session-guard 现在时 | ✅ 零残留 | ARCHITECTURE:71/279、SECURITY:332/337、gui SKILL:32、README:122 全部带"规划项·未实现/零实现/人工" |
| ② Origin 校验在位能力 | ✅ 零残留 | ARCHITECTURE:240 划线~~、REQUIREMENTS:85 需求目标态注、README:65 划线；SECURITY:39 规划项 |
| ③ `__approvalId` 续跑现在时 | ✅ 零残留 | INTERFACES:216/K5:94/mcp-ref:212/orch:263/approval-card:33/60/142 均"批1 在建/不可依赖/恒返 APPROVAL_REQUIRED" |
| ④ available==count 当门禁 | ✅ 零残留 | 仅 orchestrator SKILL:137 **反面禁令**形态在场（"不得把它当门禁"+ok:true 即放行新判据）；INTERFACES:291/DEPLOYMENT:89 为响应示例值非门禁句（见 D-4 小瑕） |
| ⑤ previewHash 在位比对 | ✅ 零残留 | SECURITY:190/194 带"当前服务端侧恒空、绑定批6 在建"订正注记；CL-016 归档面豁免（K-20 不回写史） |

### V-B.4 守卫件亲跑 + 判据源码读判（恒真评估）

亲跑：11 pass / 0 fail（修改前后各一次，均 11/11）。281 行判据源码通读。

**能拦**：
- 判据 a（token 白名单）：注册 id 派生自 definitions.ts 且自带 `ids.size>=50` 防空转锚 ✓；白名单
  19 串逐类登记（①配置键/②卡片谓词/③文件路径/④health 字段/⑤a2a.* 五件——亲验 host-a2a-bridge
  tools.ts:385/554/630/686/755 真实在册 ✓；⑥设想能力 4 串同行强制"未注册/规划"限定词 ✓）。
  拦得住：幻觉 token 裸入 SKILL、⑥类不带限定词复活、注册表解析失效（size 锚连锁红）。
- 判据 b/c（口径回潮钉）：拦得住"未带任何口径词的现在时承诺行"（批0-d 变异自证段在位，三变异体
  实测正则判据有效）。
- K5 状态行双锚（钉"已实现并真机验收"正向句 + 禁"待实现"旧句回潮）。

**拦不住**（明示局限）：
1. **单字口径词撒盐绕过**——对抗样本实测：`'审批通过后系统自动续跑执行，勿需人工干预。'` 因含
   `勿` 字被 APPROVAL_CALIBER 判"已诚实化"放行 = 绕过成立（登记 D-2，P2）。
2. **大写/混合大小写幻觉 token**——DOTTED_TOKEN_RE 仅匹配小写段。
3. **治理面收集空转**——`governanceDocs()` 无下限断言，若 docs/02-design 目录迁移改名，b/c 判据
   0 次迭代静默绿 = 恒真风险。判据 a 有 `files.length>=7` 锚但 b/c 没有。**已自修**（D-1，见下）。
4. 跨段落点：口径词判定为行级，`docs/04-05` 运维面与 `docs/design/` 不在 b/c 收集域（实测 04-ops/
   05-peripherals 当前零命中=无现患，属盲区非残留）。

### V-B.5 三处最重改口交叉对码——全部吻合

1. **健康门 `ok:true 即放行`**：server.ts:1983 `ok: provider !== undefined && bridgeState === 'ready'`
   ——provider 加载 ∧ ps-bridge ready 合成语义与 SKILL:137 新判据描述逐字对应 ✓；degraded 面
   `available=3`（meta.*）在 :653-655 intersectDeclared(['meta.*']) 得证 ✓。
2. **SECURITY §2.3 五环节表**：三处生产 `policy.evaluate` 调用点 server.ts:1060/:1229、
   adapter-agent-workbuddy/index.ts:295 实参均**不含** allowedCapabilities/maxRisk（裸调用）⇒
   表"进入实参=❌"属实 ✓；a2a-framework/server.ts:268-270 非流式装配 maxRisk 恒有值（缺省
   this.defaultMaxRisk 兜底）✓；:511 流式装配确不含 allowedCapabilities 解析 ⇒ 表第 4 行❌属实 ✓。
3. **SCENARIOS context→metadata 改判**：a2a-framework/server.ts:264
   `context: message.metadata`（由 message.metadata 派生）——SCENARIOS:214-216 改判注记属实 ✓。

## V-C 批2 对抗面复核

### V-C.6 psmod-drift（只读实跑）
**NO_FINGERPRINT RC=1** = 预期"正确显形"（VM 跑旧 ps-bridge，无指纹可证）。若出 PASS 反而是假绿——
未发生。输出含配方指引（deploy-vm+kill-restart 真机面本工具不执行）✓。

### V-C.7 install-host --check-fresh（只读复跑）
RC=1；现值 = 对账 170 文件中 **MISSING 4 + MISMATCH 52 = 56**（成员报 56 吻合，缓存=旧 dist
形态，与"新 bridge 待部署"一致）。**只读性代码坐实**：check-fresh 分支（:1004-1009）在全部写操作
函数之前 return；调用链 runFreshnessCheck→buildIntegrityFilePairs→verifyCopyIntegrity 仅
readFileSync/existsSync/SHA256，零 mkdirSync/writeFileSync/rmSync ✓。

### V-C.8 tunnel-daemon 新面静态审读 + 单测复证（tunnel-daemon 10/10、phase3-b2-tunnel-start 6/6 绿）

三 hunt 结论：
1. **退避循环 stop() 失败路径**：`try{ await tunnel.stop() }catch{ignore}` 吞住 throw ✓；
   oh-tunnel.stop() 的 `_started=false` 在 finally 块 ⇒ 即便 _teardownClient 抛错下次 start()
   仍真实重入（不被 `if(this._started) return handle` 短路）✓。**边界观察**：若 `_server.close()`
   回调悬挂则 await 永挂（理论面，taskkill 语义正常时不触发；登记 D-6 同族观察项）。
2. **陈旧锁甄别**：任务书问"acquirePidfileExclusive 对陈旧 pid 是否 kill-0 甄别"——甄别在**主流程
   上游**而非 acquire 本身：runDaemon:228-232 `readJsonSafe→prev?.pid && isAlive(prev.pid)`
   （isAlive = `process.kill(pid,0)` **kill-0 甄别在位** ✓）→ 死进程则 rmSync 清陈旧锁继续。
   **新发现边界缺陷候选**（D-5）：wx 裸写窗口（acquire 写裸文本 `"pid\n"` 到 writePidfileAtomic
   升级 JSON 之间）读侧 readJsonSafe 解析失败→`prev=undefined`→被判"无主"走 rmSync=删除他人在场
   锁，理论双实例+writeStoppedTrace 互删对方锁。窗口微秒级×双 daemon 同发才触发，winvm-plugin
   父侧 readTunnelStatus alive 预检已挡主路径 ⇒ 评 **P2 缺陷候选**（纯理论推演，无实锤，误报风险
   显式声明）。
3. **start-config-error 不重试路径与播报一致性**：daemon 侧构造期 throw→writeStoppedTrace
   (STOPPED, reason=start-config-error, retryable:false)→return 1 ✓；winvm-plugin:1095-1104 端口
   20s 未监听时先 `isPidAlive(pidObj.pid)` 甄别——daemon 存活(退避重试中)=报"自愈中"RC0、
   daemon 已退=报"启动失败+state.reason 指认"RC1 ⇒ 语义一致 ✓。三终态留痕哲学一致：signal 驱动
   shutdown 删 state（正常收场），giveup/start-giveup/start-config-error 保 STOPPED（可信死因）✓。

### V-C.9 prepare-vm（只读探测面）
- 裸跑 `node delivery/prepare-vm.mjs`：模块守卫提示（引导走 bootstrap）RC=0，输出友好 ✓。
- **实跑** `node delivery/bootstrap.mjs prepare-vm`（不带 --apply）RC=0：ssh 只读探测全通
  （ADMIN=true / sshd installed·Running·Auto / firewall ssh·service 双 MISSING / node v24.21.0 /
  DB-4 verdict=config-dir-present 带"登录态无法机械确证"诚实局限）。零 VM 写（sc/netsh 查询族）✓，
  输出落 `qa/p3b02-regression/prepare-vm-probe.txt`。
- **planPrepareVm 幂等先探后动审读**：六项全部基于 probe 实参三分 [SKIP]/DO/[MANUAL]（sshd
  installed+Auto→SKIP；firewall 规则在→SKIP；DB-5 因 MSYS 吞参不可轻探测→apply .ps1 无条件幂等
  置 0 自洽；DB-4 结构性手工永不谎报）✓。鸡生蛋边界（首装 OpenSSH 不可达）注释诚实声明 ✓。

### V-C.10 app.ps1 Invoke-WingetBounded 静态审读 + r3 复跑
- r3-uninstall-verify **39/39 绿**（成员报数吻合）；合同锚行 app.ps1:940 保留字面串且注释说明
  迁移语义（预览零子进程/真卸载单调用点由 Invoke-WingetBounded 承担）✓。
- PS 5.1 兼容：`[ordered]@{}`、`WaitForExit(ms)` 布尔返回、`ReadToEndAsync()+.Result`、
  `Get-Command` 显式解析 App Execution Alias 全路径 ✓ 无 PS7-only 语法。
- 超时树杀覆盖 NSIS：Kill()→`taskkill /PID /T /F`→（winget 为 MSIX stub 时）再按镜像名
  `taskkill /IM winget.exe /T /F` 扫树→二次 WaitForExit(5000) 收尸 ✓。
- 失败回执结构化：spawn 失败 exitCode=-9994+`WINGET_SPAWN_FAILED:`+output 数组+timedOut 布尔；
  超时 -1+留痕行 ✓。三调用点 :338/:1101（540s 预算）/:942（卸载 budgetMs）✓。
- 观察项 D-6：`$stdoutTask.Result` 无超时保护——若 taskkill 后孤孙仍持 stdout 句柄则理论阻塞；
  /T 树杀正常清场，评 P2 观察。

### V-C.11 隧道 /health 只读探针
隧道通。`ok=true`；**psBridge 段无 fingerprint 字段 = 旧 bridge 预期态**（与 V-C.6 NO_FINGERPRINT
互证）；psBridge 现值 `{state:ready, uptimeMs:184002719(≈2.13天), pending:0, restarts:0}`；
capabilities 54/54；session.state=healthy。证据 `qa/p3b02-regression/health-now.json`。

## V-D 交叉一致性

### V-D.12 批0↔批2 接缝
- **代落两行同语核验 ✓**：server.ts:1213 schema description "审批续跑标记（批1 放行闭环在建：
  当前批准后重发仍需审批，勿依赖此参数续跑）"、:1361 instructions "批准后自动续跑放行闭环批1
  在建，当前重发仍需审批"——与批0 文档面（INTERFACES:216 / K5:94 / SKILL:212）口径同语，无
  "已可用"残留。
- **批2 验收判据"全新宿主一键到可枚举能力零手工"达成度评估**：
  - 代码面+单测面：prepare-vm（手工 6→1）/install-host 防呆/隧道自愈/指纹链 全部落地且绿 ⇒
    "批2 代码交付验收"达成。
  - **真机待执行项显式列**（达成判据的实证缺口，非缺陷）：① psmod/ps-bridge 新逻辑生效窗口
    （deploy-vm --apply + kill-restart，NO_FINGERPRINT 为当前态证据）；② prepare-vm --apply
    真机写面验证；③ 全新宿主 E2E（install-host --apply 全序列→能力枚举）；④ 审批死链修复的
    VM 面配方执行。
  - 判据文字本身：设计层"零手工"不成立——author 诚实声明 DB-4 登录结构性手工 + 首装 OpenSSH
    鸡生蛋手工 ⇒ 合理达成读法 = "手工 6→2（结构性下限）"，建议主理人验收措辞按此归档。

### V-D.13 GATE-POLICY.md ↔ gate.mjs 一致性抽读
- 静态例数列删除**无悬空引用**：grep 无测试解析该表（批0 notes C12 亲验在案）；gate.mjs 不读
  GATE-POLICY.md（表在代码 GATE_GUARD_FILES 内自持，POLICY 表 7 件与代码 7 条逐一吻合 ✓）。
- README 基线查法 sort -V 订正在位，"91/1857"仅历史锚叙述句（自称非事实源）✓。
- **漂移点 D-3**：新守卫 `phase3-skill-claims-guard.test.js` **未登记进 ST3 门禁表**（gate.mjs
  GATE_GUARD_FILES 与 GATE-POLICY 表双缺）。它满足入选三标准（纯离线/安全承诺族/<30s）——
  全量档 ST4 能扫到（本次实测在册 GREEN），但 **quick 档不跑** = 提交前廉价防线看不见它，
  恰是批0 自己反对的"写了没人跑"失效面的雏形。路由：主理人转工程师补 1 行（代码面）。

## 缺陷登记（四元组）

| # | 级别 | 现象 | 根因 | 证据 | 路由 |
|---|---|---|---|---|---|
| D-1 | P2（测试件，**已自修**） | 守卫 b/c 判据治理面收集无下限断言，目录迁移则空转恒绿 | governanceDocs() 缺 files.length 锚（a 判据有、b/c 无） | phase3-skill-claims-guard.test.js:158-170 修改前后各跑 11/11 绿 | QA 自修完成（写权内），随证据提交 |
| D-2 | P2 卫生 | 口径钉可被单字否定词撒盐绕过 | APPROVAL_CALIBER 含 勿/曾/旧 等超宽泛字，行级判定 | 对抗样本 `'…勿需人工干预'` 实测放行；守卫文件 :156 | 主理人（收紧词表 vs 误伤权衡，宜批1 文档治理时一并） |
| D-3 | P2 卫生 | skill-claims-guard 未进 ST3 门禁表，quick 档不跑 | 批0 建守卫未同步登记门禁表 | gate.mjs:62-112 GATE_GUARD_FILES 7 件无它；GATE-POLICY ST3 表同缺 | 主理人→工程师（两行内改动，含双写纪律） |
| D-4 | P2 卫生 | INTERFACES.md:291 health 示例 count=50 陈旧（注册表实 54） | 示例值静态维护 | definitions.ts 54 条 id；DEPLOYMENT:89 已 54 | 主理人（文档单侧） |
| D-5 | P2 缺陷候选（理论） | wx 裸写文本窗口 readJsonSafe 判无主→rmSync 删活锁→双实例+互删 | acquire 裸写形态与主流程 JSON 甄别形态不一致；甄别缺失于"损坏文件"路径 | tunnel-daemon.mjs:138-157/227-234 + node 实测 bare-pid→null；isAlive 对 JSON 形态工作正常 | 主理人裁（修法=裸写也 JSON 化或 rmSync 前先 kill-0 裸 pid）；误报风险声明：微秒窗口无实锤 |
| D-6 | P2 观察 | stop() 内 _server.close 回调悬挂 / $stdoutTask.Result 无超时 | 理论阻塞面，正常 OS 语义不触发 | oh-tunnel.mjs:291-319；app.ps1 Invoke-WingetBounded .Result 行 | 观察记录，不阻断 |

**无 P0/P1。未发现源码功能性 bug；无假绿迹象（NO_FINGERPRINT/56 漂移均为正确显形）。**

## 结论

**IS_PASS: YES** —— 批0/批2 启动批回归通过，Phase 3 新基线 99 件/1945 例 登记生效。
六项发现全部 P2 卫生/理论观察级：D-1 已自修复证；D-3 建议尽快补登记（一行改动防 quick 档盲区）；
D-5 为唯一新缺陷候选（理论面，建议批1 隧道续作时顺手修）。真机待执行清单（V-D.12 ①-④）属
主理人既定安排窗口，非本批缺陷。
