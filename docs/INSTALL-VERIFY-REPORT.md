# WinVM Bridge 全新安装后全功能验收报告（INSTALL-VERIFY）

- 执行人：QA（Edward，software-qa-engineer）
- 日期：2026-09-20
- 被测环境：宿主 = 鸿蒙 openHarmony（本项目仓库）；VM = 172.16.100.2（User@，免密 SSH）
- 被测版本：`uninstall 16/16 → setup.mjs --apply 七相位 7/7` 全新安装产物（run6 部署，fresh build）
- 原始输出：全部落 `qa/evidence/`（见文末附录）

---

## 一、结论

**PASS（功能验收 18/18 项全部通过）。**
（A12 部署一致性缺口已由工程师按 QA 推荐方案修复——两文档移入各自 `references/`，经修复后复验 PASS + 主理人独立复核确认。）
MCP / A2A 双通道冒烟通过；单元测试 342/342 通过；`/health` 全绿（provider ready、session healthy/interactive、ps-bridge ready、54/54 能力、audit chainValid=true）。

---

## 二、安装回归摘要

### 2.1 卸载（uninstall.mjs，APPLY）

- 16/16 项 POST-CLEANUP VERIFICATION CHECKLIST 全部 PASS（`qa/evidence/uninstall-pre-run3.log`）。
- 要点：宿主插件缓存/注册表/mcp.json/settings.json PATH 标记、VM 侧 C:\WinVMBridge、计划任务、18443 端口、技能 junction 全部清除；OpenSSH Server 存活（必须项）；workspace 默认保留。

### 2.2 全新安装（setup.mjs --apply 七相位，7/7）

| 相位 | 结果 | 耗时 | 备注 |
|---|---|---|---|
| BUILD | ✅ | 1.9s | npm run build |
| HOST | ✅ | 1.4s | 宿主侧插件部署 |
| VM | ✅ | 245.4s | 产物 scp + install-vm.mjs（provider=workbuddy, cli=codebuddy） |
| VM-START | ✅ | 191.0s | schtasks 拉起，端口监听轮询通过 |
| TUNNEL | ✅ | 1.4s | 进程内 ssh2 隧道（默认钥探测成功） |
| TEST | ✅ | 0.9s | 宿主侧 --self-test |
| HEALTH | ✅ | 54.8s | 首探 1 次未通重试后通过（ps-bridge 冷启动窗口） |

来源：`qa/evidence/fresh-install-apply-run2.log`。部署收尾时服务短暂处于非交互降级会话（GUI 门禁提示），随后恢复 healthy（见 2.3）。

### 2.3 /health 快照（本次验收实测）

验收开始前（`qa/evidence/health-verify-snapshot.json`）：

```json
{"ok":true,"provider":{"id":"workbuddy","state":"ready"},
 "session":{"sessionId":1,"windowStation":"WinSta0","desktop":"Default","interactive":true,"locked":false,"state":"healthy"},
 "psBridge":{"state":"ready","uptimeMs":357646,"pending":0,"restarts":3},
 "capabilities":{"count":54,"available":54},"audit":{"entries":16,"chainValid":true},"exposed":54}
```

验收结束（A3 破坏性用例之后，`qa/evidence/health-verify-final.json`）：ok=true、provider=ready、session=healthy/interactive、ps-bridge=ready（restarts=5，含 QA 两次强杀自愈）、54/54、audit chainValid=true。**服务全程自愈，无人工干预。**

---

## 三、A1–A18 逐项判定表

> 判定规则：首轮（run1）FAIL 的项按预案静置/隔离后**单独复跑**，复跑结果作数。A3 为破坏性用例（强杀 ps-bridge），单独末位执行。

| 项 | 内容 | 首轮 | 复跑终判 | 证据（关键行） |
|---|---|---|---|---|
| A1 | ps-bridge 单例 | FAIL（VM_UNREACHABLE） | **PASS**（复跑2） | `PSBRIDGE_COUNT=1`；SERVICE PID=18660，PORT_18443_OWNER=18660 |
| A2 | /health 一致性 | PASS | PASS | `provider.state=ready psBridge.state=ready ok=true → 一致` |
| A3 | 桥自愈（破坏性） | FAIL（夹具探针缺失连带） | **PASS**（单独复跑） | `killed=19360 → 重生为 19336（新 PID=true） 单例=true`；`服务未重启=true（18660→18660）`；自愈调用 ok=true 15.4s |
| A4 | appops.cli.invoke | PASS | PASS | `node -v ok=true 3491ms exit=0`；`ffmpeg(未安装) ms=1582 未挂死` |
| A5 | A2A 委派（LLM 路径） | PASS | PASS | `health ok=true skills=5`；`delegate（有界60s）返回 60501ms isError=true code=A2A_DELEGATE_FAILED → 不挂死=true`（已知 open issue，D28 兜底） |
| A6 | meta.health.check 不泄露系统信息 | PASS | PASS | `ok=true keys=ok,provider,session,psBridge,capabilities,audit,exposed` |
| A7 | 生产工作目录读写链（6 步） | PASS | PASS | `dir/write/read/search/zip/space 全 ok=true`；读回含内容=true |
| A8 | 关键能力（inventory/service/eventlog） | PASS | PASS | inventory 条数=18（注册表基线 19，阈值 ≥15）；service [262]；eventlog [3] |
| A9 | L3 dry-run 免审批 | PASS | PASS | `ok=true err=无 data={"dryRun":true,"plan":{...}}` |
| A10 | 列表保形 | PASS | PASS | 单命中=[1]、零命中=[] |
| A11 | 本地↔VM 产物 md5 一致 | FAIL（VM_UNREACHABLE） | **PASS**（复跑2） | app.ps1 / ps-bridge.ps1 / adapter dist index.js → `3/3 SAME`（fresh build 一致性成立） |
| A12 | 仓库 skills ↔ 宿主副本一致 | FAIL | **PASS（修复后复验）** | 首轮：`Only in skills: winvm-mcp-reference/mcps-reference.md`、`Only in skills: winvm-orchestrator/approval-card.md`。修复：两文档移入各自 `skills/winvm-mcp-reference/references/mcps-reference.md`、`skills/winvm-orchestrator/references/approval-card.md`（SKILL.md 补可发现性指引，宿主+VM 两侧同步）；修复后复验 PASS + 主理人独立复核（references/ 在位、旧路径已清、宿主副本 diff -r CLEAN） |
| A13 | 排序类能力真排序 | PASS | PASS | `单调不增=true 首项=671.99MB` |
| A14 | psmod 静态扫描（裸键排序） | PASS | PASS | `裸键排序命中=0` |
| A15 | 领域错误码上浮 | PASS | PASS | `FILE_NOT_FOUND / SERVICE_NOT_FOUND / REG_PATH_NOT_FOUND / CLI_NOT_FOUND`，code∈契约，成功路径未坏 |
| A16 | 入参契约可路由（D24） | PASS | PASS | 缺必填/未知参数/组合 三例均 `INVALID_PARAMS + INVALID_ARGUMENT` |
| A17 | winget.search 不静默空（D25） | FAIL（winget 冷启动 0/0 行） | **PASS**（静置60s 复跑） | `插件 rows=11 / 基线 rows=11 含7zip.7zip=true 含7-Zip=true 脏id行=0` |
| A18 | 入参 type/enum 校验（D26） | PASS | PASS | 严格两例 `INVALID_PARAMS+INVALID_ARGUMENT+details.invalid[]`；宽松对照 `top:"20"/top:20/content:123` 均未误拒；`action:"START"` 放行到业务层（reason=SERVICE_NOT_FOUND） |

**汇总：run1 = 13 PASS / 5 FAIL；复跑后终判 = 18 PASS / 0 FAIL（A12 经修复后复验 PASS）。**

### 失败定性（Smart Routing）

| 项 | 定性 | 路由 |
|---|---|---|
| A1 / A3 / A11 首轮失败 | **夹具基础设施缺口，非产品 bug**：全新安装只分发 `delivery skills packages/*/dist package.json`，`qa/probes/qa-probe.ps1`、`qa/probes/lead-md5-3.ps1` 两个 QA 探针未随装推送，卸载后 VM 上缺失，`powershell -File` 报“路径不存在”被夹具误读为 VM_UNREACHABLE。QA 已手工 `scp` 两探针至 `C:\WinVMBridge\`（未改动任何产品/夹具文件）后复跑即 PASS | 建议交付修复：setup/install-vm 增加 QA 探针分发步骤（或 qa-verify ensureTunnel 同款自举探针） |
| A17 首轮失败 | **环境瞬时**：winget 源冷启动，插件与独立基线同时 0 行（非插件解析缺陷，结构不变量脏 id=0）；静置复跑 11/11 全对齐 | 无需修复 |
| A12 | **真实一致性缺口**：两个未引用的 skill 根目录 .md 未被渲染器装载。已由 Engineer 按方案①（移入 references/）修复，修复后复验 PASS + 主理人独立复核 | ✅ 已闭环 |

---

## 四、双通道冒烟结果

### 4.1 MCP 通道（HTTP，经隧道 127.0.0.1:18443）

- `initialize`：返回 `serverInfo={"name":"winvm-bridge","version":"0.1.0"}`，协议 2025-06-18 ✅
- `tools/list`：**54 个工具**（`qa/evidence/mcp-smoke-toolslist.json`）✅
- `tools/call meta.health.check`：`ok=true`，返回 provider/session/psBridge/capabilities/audit/exposed ✅（`qa/evidence/mcp-smoke-call.json`）

### 4.2 A2A 通道（stdio 桥，qa/probes/a2a.mjs）

- `a2a.health`：`ok=true`，426ms，Agent v0.1.0 可达（/a2a），声明 5 技能（system-admin / app-manager / storage-manager / gui-automation / app-operation）✅（`qa/evidence/a2a-smoke-health.out`）
- `a2a.delegate`：A5 用例实测走 LLM 路径（provider=workbuddy/ready），60s 有界返回 `A2A_DELEGATE_FAILED`，**宿主不挂死**（D28 兜底成立）。VM 侧 codebuddy LLM 停滞为已知 open issue，按验收准则记 PASS（不挂死即过）。

### 4.3 单元测试

- `npm run test:unit`：**342/342 通过，0 失败**（2.2s，`qa/evidence/verify-unit-run1.out`）。

---

## 五、本次安装回归发现并修复的问题（交付侧 4 项，交付组已修复，本次复验确认有效）

| # | 问题 | 根因 | 修复 | 复验证据 |
|---|---|---|---|---|
| 1 | VM 相位超时 ×2（VM / VM-START 挂 420s+） | VM 侧 PowerShell 进程创建受 Defender 扫描拖慢（10–60s 随机），旧逻辑等待窗口不足且无端口轮询上限兜底 | setup.mjs 重写 VM-START 相位：.ps1 推送执行（结束旧实例→强杀端口残留→schtasks /run→端口轮询 ≤420s） | VM 245.4s、VM-START 191.0s 均在窗口内完成 ✅ |
| 2 | VM-START 失败 | 旧实现依赖 VM 内交互式 PowerShell 环境，无人值守场景不可达 | install-vm.mjs 改为 .ps1 推送（scp + `-File` 执行），零交互依赖 | 7/7 相位全绿 ✅ |
| 3 | TUNNEL 相式默认钥失败 | `ssh -N -L` 依赖系统 ssh 找不到默认私钥（宿主为非标准用户目录布局） | oh-tunnel.mjs 增加默认 `~/.ssh` 私钥探测链（本次使用 `/storage/Users/currentUser/.ssh/id_ed25519`），并改进程内 ssh2 隧道（随部署进程生命周期） | TUNNEL 1.4s 建立成功；qa-verify 的 ensureTunnel 复用同链路亦成功 ✅ |
| 4 | 卸载不可回退/残留 | 缺统一卸载入口，两端口径不一（宿主缓存/注册表/mcp.json 与 VM 计划任务/目录/junction） | 新增 delivery/uninstall.mjs：APPLY/DRY-RUN、回收站式可恢复、16 项 POST-CLEANUP 自校验、SSH 密钥永不触碰 | 16/16 checklist PASS（run2/run3 两轮一致）✅ |
| 5 | ps-bridge 握手 15s 超时偶发误杀 | 握手超时写死 15s，Defender 拖慢下误判未就绪 | ps-bridge.ts 握手超时改为 env 可覆盖（复验期 restarts=3→5 稳定，无握手误杀） | /health ps-bridge=ready、A3 自愈 PASS ✅ |

**修复文件清单**：`delivery/setup.mjs`、`delivery/install-vm.mjs`、`packages/vm-capabilities/src/ps-bridge.ts`、`delivery/oh-tunnel.mjs`、`delivery/env.example`；新增 `delivery/uninstall.mjs`。（均为交付组本轮改动，QA 只读复核，未改动任何产品代码与 `.env`。）

---

## 六、遗留观察与建议

1. **QA 探针未随装分发（夹具基础设施）**：`qa/probes/qa-probe.ps1`、`qa/probes/lead-md5-3.ps1` 卸载后即消失，A1/A3/A11 依赖其存在于 `C:\WinVMBridge`。建议 setup.mjs 增加 `[QA-PROBE]` 可选相位或 qa-verify 增加探针自举（本次 QA 手工 scp 恢复）。夹具文件本轮未改动。
2. **/health 在 ps-bridge 未就绪时阻塞 ~27s**（未修，观察项）：安装收尾窗口内首个 /health 需等待；建议后续给 /health 的 psBridge 子探针加独立短超时，避免网关侧误判。
3. **VM Defender 排除项（建议项，需 VM 管理员操作）**：建议将 `C:\WinVMBridge`、`node.exe`、PowerShell `-File` 执行路径加入 Defender 排除，可消除 10–60s 随机进程创建延迟，显著缩短 VM/VM-START 相位与 PS 类断言抖动。
4. **VM 侧 codebuddy LLM 停滞（open issue）**：a2a.delegate 走 LLM 路径 60s 内无完成态；D28 的有界超时兜底有效（不挂死），待 VM 侧 codebuddy 会话恢复后复测真实委派成功路径。

---

## 七、附：原始输出文件索引（qa/evidence/）

| 文件 | 内容 |
|---|---|
| `verify-a-run1.out` | A1–A18 全量首轮（13/5） |
| `verify-a1-a11-rerun.out` / `verify-a1-a11-rerun2.out` | A1/A11 复跑（探针恢复前/后） |
| `verify-a3-rerun.out` | A3 破坏性用例单独复跑 |
| `verify-a17-rerun.out` | A17 静置 60s 后复跑 |
| `health-verify-snapshot.json` / `health-verify-final.json` | 验收前 / 验收后（A3 之后）/health 快照 |
| `mcp-smoke-headers.txt` / `mcp-smoke-toolslist.json` / `mcp-smoke-call.json` | MCP 通道 initialize / tools/list / tools/call 原始报文 |
| `a2a-smoke-health.out` | A2A 通道 a2a.health 原始输出 |
| `verify-unit-run1.out` | 单元测试 342/342 |
| `uninstall-pre-run2.log` / `uninstall-pre-run3.log` | 卸载 APPLY 两轮 16/16 checklist |
| `fresh-install-apply-run2.log` | setup --apply 七相位 7/7 全量日志（含计时） |

*注：复跑用例命中的 MCP 会话与审计条目已计入 VM audit 链（entries 16→36，chainValid=true 全程成立）。*
