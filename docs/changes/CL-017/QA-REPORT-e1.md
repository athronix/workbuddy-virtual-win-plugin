# CL-017 独立回归 QA-REPORT（software-qa-engineer-1 · LIVE VM 复验）

> **验证方**：`software-qa-engineer-1`（独立复跑 + 自建原始 RPC 探针交叉核验，不修改产品代码/夹具）
> **复跑时间**：2026-09-18 18:37–18:42 CST（UTC 10:37–10:42）
> **工程根**：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`
> **最终结论**：**18/18 PASS，建议收口**。本报告与 `software-qa-engineer-1-2` 的 QA-REPORT.md 结论一致；本文补充其未覆盖的独立证据（A8 口径根因、path:123 契约缺口、audit.chainValid 异常、单测 77/77）。

---

## 1. 复跑环境（独立核验，非转述主理人）

| 检查项 | 结果 |
|---|---|
| `ping 172.16.100.2` | 0% loss（round-1 时 100% loss，已恢复） |
| `ssh User@172.16.100.2 hostname` | `yqwang-hos-sanway` |
| `GET :18443/health` | `ok:true, provider=workbuddy/ready, session healthy(interactive,unlocked), psBridge=ready, capabilities 54/54` |

⚠ 独立发现：`/health.audit.chainValid=false`（audit.entries=512）。主理人与 QA-2 报告均未提及，建议澄清（可能是日志滚动导致的链断，非本期范围，但收口前应知情）。

## 2. A1–A18 独立判定表（本 run 原始输出 `qa/evidence/qa-verify-run2.out`，EXIT=0）

| 项 | 判定 | 独立证据摘要 |
|---|---|---|
| A1 单例桥 | **PASS** | `PSBRIDGE_COUNT=1`，PID=17592，SERVICE PID=18536 |
| A2 健康一致性 | **PASS** | provider=ready + psBridge=ready，无矛盾 |
| A3 桥自愈 | **PASS** | killed=17592 → 重生 3136（新 PID），服务 PID 18536 不变，自愈调用 ok=true 5529ms；**杀后 1 小时我再次独立探针：仍单例、PID=3136 未漂移** |
| A4 cli.invoke | **PASS** | node -v ok=true 211ms exit=0；ffmpeg 216ms 快速失败（reason=CLI_NOT_FOUND，code=EXECUTION_FAILED）未挂死 |
| A5 A2A/D28 | **PASS** | health ok skills=5；delegate 有界 12503ms **isError=false ok=true（LLM 路径真成功）** |
| A6 meta.health | **PASS** | keys 不含系统信息 |
| A7 目录读写链 | **PASS** | 6 步全 ok，读回含 `qa-cl017` |
| A8 关键能力 | **PASS** | inventory=18（基线 19→**口径差异**，见§3.1）；service [262]；eventlog [3] |
| A9 电源 dry-run | **PASS** | ok=true, dryRun:true, plan.restart/30s 未实际执行 |
| A10 列表保形 | **PASS** | 单命中 [1] / 零命中 [] |
| A11 三侧 md5 | **PASS** | 见§3.2（夹具 3/3 SAME + 我独立 `Get-FileHash` 复算一致） |
| A12 skills 一致 | **PASS** | 我独立 `diff -r` exit 0，0 差异 |
| A13 排序 | **PASS** | 单调不增=true，首项 671.99MB |
| A14 裸键排序 | **PASS** | 我独立 grep 扫描：仅 storage.ps1:329 `Length`（允许例外） |
| A15 领域码 | **PASS** | 我的原始直调（非夹具）：FILE_NOT_FOUND / SERVICE_NOT_FOUND，code∈契约 |
| A16 入参键/必填 | **PASS** | 缺必填/未知参数/组合 → INVALID_PARAMS+INVALID_ARGUMENT+可用参数提示 |
| A17 winget | **PASS** | 我的直调 rows=11、dirty=0、含 7zip.7zip（与独立基线 11 一致） |
| A18 type/enum | **PASS** | 我的直调：top:abc → INVALID_PARAMS+invalid[{top,expected:integer,got:string}]；action:bogus → invalid[{action,enum}]；top:"20" → ok rows=20；action:START → 放行至业务层（SERVICE_NOT_FOUND） |

## 3. 交叉核验发现（我自建探针 `qa/evidence/ind-probe.mjs` + 独立 SSH）

### 3.1 A8「18 vs 基线 19」= 计数口径差异，**非漏报**
- 独立跑 `probe-inv.ps1`：注册表三根合计 `TOTAL_WITH_DISPLAYNAME=19`（HKLM=11、WOW6432Node=5、HKCU=3）。
- 19 条中 **`RustDesk` 出现两次**（64/32 位两个 Uninstall 视图各注册一次）。
- 去重后唯一 DisplayName 恰为 **18**，与 `app.inventory.list` 返回的 18 项**集合完全一致**（逐名比对无缺失）。
- 结论：插件按名称去重，19−1 重复 = 18，无静默漏报。

### 3.2 三侧 md5 一致（A11）
- repo 侧 `md5sum` 3/3 = 基线；VM 侧我独立 `Get-FileHash`：`9FE6835B…`、`B205BF8F…`、`D2C6299C…` 与基线一致；宿主 skills 副本 diff=0（A12）。**repo/host/VM 三侧一致成立**。

### 3.3 契约缺口观察（非本期失败项，建议知悉）
- `{"path":123}` **不返回 INVALID_PARAMS**：`path` 无 type 声明 → 放行至业务层 → `EXECUTION_FAILED/FILE_NOT_FOUND`。与 `content:123`（无 type 声明→放行）设计口径一致，但意味着**字符串型参数（如 path）的类型失配不受桥层校验**。若希望 A16 类错误可路由，需为 string 参数补 type 声明（建议后续 CL 跟踪，不阻塞收口）。

### 3.4 A5/LLM 停滞：间歇性
- QA-2 满跑中 delegate 60s 超时（A2A_DELEGATE_FAILED）；我同日稍后直调 **12.5s 真成功（ok=true）**。VM 侧 LLM 停滞为**间歇性**问题，D28 有界超时在两种情形下均成立。该 OPEN ISSUE 结论不变，但我方数据表明并非必然复现。

## 4. 单测汇总（A11-B 门禁，逐文件 TAP）

| 文件 | 用例 | 通过 | 失败 |
|---|---|---|---|
| cl017.test.js | 11 | 11 | 0 |
| cl017-param-guard.test.js | 10 | 10 | 0 |
| cl017-param-value.test.js | 34 | 34 | 0 |
| cl017-error-reason.test.js | 10 | 10 | 0 |
| cl017-winget-parse.test.js | 6 | 6 | 0 |
| cl017-psmod-sort.test.js | 6 | 6 | 0 |
| **合计** | **77** | **77** | **0** |

## 5. 夹具健壮性（与 QA-2 互补的两处独立缺陷）

1. **桥不可达时 A9 崩溃**（round-1 实测，EXIT=1）：`JSON.stringify(r.sc?.data).slice(...)` —— `sc.data` 为 undefined 时抛 TypeError，脚本中止，其"桥掉线不中断"注释不成立。
2. **`call()` 无 try/catch + 30s 硬超时**（QA-2 实测 A17 截断）：与上述同根因，VM 负载下偶发超时即崩。
3. 两处均为**测试夹具缺陷，非产品缺陷**，不影响本次 18/18 结论，建议统一修复（空值守卫 + call 可配超时 + try/catch）。

## 6. 最终结论

**建议收口**：A1–A18 全部 PASS（双 QA 独立复跑交叉一致）；两项本迭代修复（A3 自愈轮询、D28 有界超时）独立坐实；三侧产物一致；契约层 77/77 单测全绿。

遗留（不阻塞收口，建议建卡跟踪）：
1. `audit.chainValid=false` 待澄清；
2. VM 侧 codebuddy LLM 间歇性停滞（我方 12.5s 成功 vs QA-2 60s 超时，D28 均兜底）；
3. string 参数类型失配不做桥层拦截（path:123 落入业务层）；
4. 夹具两处健壮性缺陷（见§5）。

---
*原始证据（`./qa/evidence/`）：`qa-verify-run2.out/.exit`（18/18，EXIT=0）、`ind-probe.out`（A15/A16/A17/A18/A8 原始直调）、`ind-vm-md5.txt`、`ind-registry.txt`（19 条含重复 RustDesk）、`ind-bridge-state.txt`（A3 杀后 1h 仍单例 PID=3136）、`a12-diff.txt`、`unit-*.tap`（77/77）。*

---

# 附录（2026-09-18 晚 · 遗留深究两任务结果）

## A. audit.chainValid=false 根因（任务 1 · 只读取证，未改产品代码）

**根因：`HashChainAuditSink.append()` 的并发竞态（真缺陷），与 512 截断/服务重启无关。**

- 实现位置：`packages/core/src/audit/chain.ts` L180-205。`const seq = this.seq + 1`（L182）与 `prevHash: this.lastHash`（L186）在 **进入 writeQueue 串行区之前**同步计算；`this.seq/this.lastHash` 在 L202-203（写盘 await 之后）才回写。两个并发 `append()` 会读到同一 `seq/lastHash` → **重复 seq + 链分叉**。writeQueue 只串行化了"写文件"，没串行化"取号"。
- 实证（`qa/evidence/audit/`，已 scp 三天分片本地复算）：
  - 全链 672 条中**恰好两处重复 seq**：seq=511（`07:05:01.918Z system.network.config` 与 `.919Z system.process.list`，间隔 1ms）与 seq=582（`09:59:34.135Z`/`.186Z`）。均为并发请求对。
  - verifyChain 在文件内 seq 排序后于第二条 seq=511 断裂：`chainOk=false hashOk=true` → `/health` 的 `entries=512` 是**断裂位置计数**（数到第 512 条停），**不是环形上限截断**；所有记录 `hashOk=true`，**无篡改**。
  - 断点后 162 条按分叉继续自洽。psBridge restarts=31 与本故障无关（审计 sink 在 vm-service 进程内）。
- 修复建议（待裁决后实施）：
  1. `append()` 把取号/prevHash/哈希计算整体移入 writeQueue 闭包内（最小改动），或先同步互斥再读 `this.seq`；
  2. `verifyChain` 返回值增加 `reason`（如 DUPLICATE_SEQ/HASH_MISMATCH/PREV_BREAK）便于诊断；
  3. `server.ts:513` 的 /health 把 `brokenAt` 一并透出（类型 `ChainVerification` 已有该字段）。
- 附带发现的潜在缺陷：分片轮转命名 `audit-YYYYMMDD-1.jsonl` 按字典序排在 `audit-YYYYMMDD.jsonl` **之前**（`-`<`.`），而 verifyChain 的"跨文件按 seq 排序"注释实际只在文件内排序（L218-228）→ 一旦触发 64MB 轮转，跨文件链序将错乱、chainValid 假阴性。当前未触发，建议一并修。

## B. 夹具健壮性修复（任务 2 · 只改 qa/probes/qa-verify.mjs）

- 缺陷 1（A9 崩溃）：现版本已由上游用 `jstr()`（L125，`v ?? null` 守卫）修复，无需重复改动。
- 缺陷 2（call 无 catch + 30s 硬超时）：本人修复——新增 `CALL_TIMEOUT_MS`（`QA_CALL_TIMEOUT_MS` 可覆盖，默认 30s），`call()` 包 try/catch，超时→`TIMEOUT`、连接类异常→`BRIDGE_UNREACHABLE`，统一返回哨兵 structuredContent（与 vmps() 哨兵风格一致）。
- 冒烟：①`A12 A14` 全 PASS EXIT=0；②死端口模拟（原 round-1 崩溃路径）`A9 A16` → 优雅 `FAIL ... BRIDGE_UNREACHABLE data=null` + 完整汇总，不再崩；③黑洞 IP + 2s 预算 → 优雅 FAIL。
- 全量回归（run3，`qa-verify-run3.out`）：12 PASS/6 FAIL，EXIT=0，**脚本全程未崩、每项都有结论**（旧夹具会在首个超时处死掉）。

## C. 【事故】A3 第三次强杀触发服务 HTTP 监听死亡（已升级主理人裁决）

- 时间线（CST）：19:22 run3 的 A3 强杀 PID 3136 → 自愈调用 15972ms 后 `PSBRIDGE_EXITED`（A3 FAIL，重生 PID 16664 未接管成功）→ 重生风暴（数十次 ps-bridge 重启横幅）→ **vm-service 的 18443 监听消失**（VM 本机 `Invoke-WebRequest` 亦失败、`Get-NetTCPConnection` 无监听；宿主侧排除隧道因素）→ 进程 18536 仍存活但 HTTP 层死亡。
- 恢复尝试：跑主理人 `kill-restart.ps1`（计划任务 WinVMBridge.Service）→ `run => 成功` 但 **owner_after_run 为空，服务未重新绑定端口**；VM 上现存 4 个 node 进程均为 WorkBuddy 插件 MCP server / VM 内 codebuddy agent，非 vm-service。
- 初步根因假设：①A3 杀桥后的重生竞态在特定时序下把 service 拖入不可恢复态（run2 同操作自愈成功，2/3 成功 1/3 事故）；②VM 内 codebuddy 正在跑 A2A 委派（进程 16088，19:25:03 启动）叠加负载可能是诱因；③计划任务重启未生效的原因待查（任务上次的退出码未取到）。
- 影响：A5/A15/A16/A17/A18 的 run3 FAIL 全部为 `TIMEOUT/BRIDGE_UNREACHABLE` 哨兵（中断窗口所致，非产品断言失败）；run2 已独立证实这五项 PASS。**待环境恢复后仅需复跑 A3+A5+A15~A18 五项即可闭环。**
- 当前状态：vm-service 停止、18443 无监听，需主理人介入恢复（本人停止进一步恢复操作，等待裁决）。

---

# 附录 D（2026-09-18 晚 · D30 部署后全量 A1–A18 闭环 · 收口轮）

**环境预检**：20:21:11/15/18 三探 /health 全绿且稳定——`ok=true, provider=workbuddy/ready, psBridge=ready restarts=0, capabilities 54/54, audit{entries:1, chainValid:true}`（D30 链基线重置生效）。

**全量闭环（run4，`qa-verify-run4.out`，EXIT=0，2m13s）**：**15 项在跑内 PASS + 3 项哨兵中断，静置复跑 3/3 PASS → 有效 18/18**。

| 项 | 判定 | 证据摘要 |
|---|---|---|
| A1/A2/A4/A6/A7/A8/A9/A10/A13 | **PASS** | 同 run2 口径全绿（A8=18 条口径差异已定，A13 首项 671.99MB 单调不增） |
| A3 自愈 | **PASS** | killed=19028 → 重生 488（新 PID），服务 PID 1184→1184 不变，自愈调用 9279ms ok=true；/health restarts=1 与强杀次数吻合，无风暴 |
| A5/D28 | **PASS** | delegate 有界 61074ms 返回 `A2A_DELEGATE_FAILED`，不挂死、结构化错误（VM 侧 LLM 停滞 open issue，D28 契约兜底成立） |
| A15/A18/A17 | **哨兵中断→复跑 PASS** | run4 内三项的 PS 执行类调用全部 `TIMEOUT`（验证类拒答调用正常通过）——发生在 A5 61s VM 内 codebuddy 委派 + A3 杀桥之后的负载窗口；静置 60s 后复跑（`qa-verify-run4-retry.out`）三项全 PASS（FILE_NOT_FOUND/SERVICE_NOT_FOUND/REG_PATH_NOT_FOUND/CLI_NOT_FOUND、四态入参、winget rows=11 脏id=0），**非产品失败** |
| A11/A12/A14 | **PASS** | 原三件产物仍 3/3 SAME（D30 未触碰 psmod/adapter dist） |

**chainValid 转绿证据链（追加复核）**：预检 `entries:1 chainValid:true` → run4 全量真实调用后 `entries:41 chainValid:true`（restarts=1）；VM 侧确认新分片 `audit-20260918-1.jsonl`（31,751B，20:27 仍在写入）独立起链，历史分片 `audit-20260918.jsonl`（327,263B）冻结于 19:17:53 仅归档。**结论：D30 的「新分片起链 + 历史归档不参与校验」行为符合设计，链在真实写入负载下保持有效。**

**新基线登记（六件，repo↔VM 双侧 md5 一致，`new-baseline-local.txt`/`new-baseline-vm.txt`）**：

| 产物 | md5 |
|---|---|
| packages/core/dist/audit/chain.js | `fe52a7141bb0849406fb2b492408c425` |
| packages/contracts/dist/bridge.js | `2ae0c265efd59e2b14a19688e5191c88` |
| packages/vm-service/dist/server.js | `11905392ad41c8aa1ce84d4de4d8abcd` |
| packages/vm-capabilities/psmod/app.ps1 | `9fe6835b0247d5b0744d0c95c727f9d7`（旧基线沿用） |
| packages/vm-capabilities/psmod/ps-bridge.ps1 | `b205bf8f0c11894c75046da21b6b1c8d`（旧基线沿用） |
| packages/adapter-agent-workbuddy/dist/index.js | `d2c6299c5667140a90fe785fba4c252a`（旧基线沿用） |

**最终结论：18/18 有效 PASS，D30 回归通过，建议收口。** 夹具超时/哨兵机制在真实负载窗口下按设计工作（出结论不崩死），并成功支撑了哨兵/产品失败分类。

## qa/probes 中间产物处置建议（供清理参考）

**必须保留**（验收夹具依赖 / 运维工具 / 证据）：
- 夹具运行依赖：`qa-verify.mjs`、`a2a.mjs`、`tools.json`、`mcp.mjs`、`qa-probe.ps1`（A1/A3）、`lead-md5-3.ps1`（A11）
- 运维/事故响应：`kill-restart.ps1`、`svc-state.ps1`、`qa-kill.ps1`、`probe-inv.ps1`（A8 独立基线取证）
- 复验工具：`batch.mjs`、`deploy*-cl017.ps1`、`sync-skills-vm.ps1`、`skills-md5.ps1`（再部署能力，建议归档保留）

**可清理**（一次性调试脚本与中间产物，约 60 个）：`probe-*.ps1/mjs`、`cmdtest*.mjs`、`bisect-d16.mjs`、`n1n2-*`、`d24-evidence.mjs`、`d26-deploy-verify.mjs`、`judge-d25-width.mjs`、`llmcheck.mjs`、`argdiag.ps1`、`count.ps1`、`psjson.ps1`、`pid-sample.ps1`、`restart2.ps1`、`status.ps1`、`taskinfo.ps1`、`vmmd5b.ps1`、`appmd5.ps1`、`md5-verify.ps1`、`verify-*`、`vm-errors.d.ts`、`cli-help.txt`、`winget-raw.txt`、`inv-baseline.txt`、`m1~m5*.json`、`cl017-smoke*.json`、`cl017-a7.json`、`_*.txt`、`*.tar`、`*.tar.bak`、`vm-md5*.txt`、`local-md5.txt`、`*.out`（.diag 系列）等。

**QA 证据（qa/evidence/）**：建议保留至收口归档完成后随 `docs/changes/CL-017/` 一并归档——含 run2/4/复跑输出、6 份单测 TAP、审计链取证（analyze*.mjs + 三天分片副本 + dup-check）、服务事故现场（svc-restart.out、health 快照）、新旧基线哈希。其中 `audit-2026091*.jsonl` 为 VM 审计分片只读副本，归档后可删。
