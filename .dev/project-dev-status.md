# 开发状态 · project-dev-status

状态表（截至本次交付）：✅ 已实现并通过编译/测试 · 🟡 部分/占位 · ⬜ 未开始

## 设计文档
| 文档 | 状态 |
|------|------|
| CONTEXT-ANALYSIS | ✅ |
| REQUIREMENTS | ✅ |
| ARCHITECTURE | ✅ |
| CAPABILITY-MODEL | ✅ |
| SPEC-HOST-AGENT-PLUGIN | ✅ |
| SPEC-AGENT-SERVICE-BRIDGE | ✅ |
| SPEC-SKILLS | ✅ |
| INTERFACES | ✅ |
| SECURITY-GOVERNANCE | ✅ |
| DEPLOYMENT / USER-MANUAL | ✅ |
| LLM-PROVIDER | ✅ |
| SCENARIOS / 06-OVERVIEW | ✅ |

## 代码包（12 个）
| 包 | 编译 | 测试 | 备注 |
|----|------|------|------|
| contracts | ✅ | — | 契约唯一源 |
| core | ✅ | ✅ policy/audit/session | 监管核心 |
| mcp-framework | ✅ | ✅ | Streamable HTTP + stdio |
| a2a-framework | ✅ | ✅ | A2A v1.0 全方法 |
| host-sdk | ✅ | ✅ | 中性渲染 SDK |
| adapter-host-workbuddy | ✅ | ✅ | WorkBuddy 原生渲染（双连接器） |
| host-a2a-bridge | ✅ | ✅ 11 项单测 | **宿主 A2A 委派桥**（stdio MCP server，补齐宿主→VM 的 A2A 一跳） |
| vm-capabilities | ✅ | ✅ e2e 真实 PS | ps-bridge 常驻（五大模块）＋ 空闲自愈（ping 探测 + 自动重启） |
| adapter-agent-workbuddy | ✅ | ✅ | 确定性执行器（agent.provider=workbuddy-deterministic，可替换） |
| adapter-agent-workbuddy-llm | ✅ | ✅ 10 项单测 + K3R 专项 4 项 | **LLM Agent（agent.provider=workbuddy，V1 已实现）**＋技能下发；**CL-K3R 修复**：`runPersistent` 的 `!turn.ok` 分支补 shadow 门控 `reconcileApprovalWait`，根治审批暂停态的静默假成功（灰度 `approvalTruth=on/shadow/off`，真机 `on`×3 全 `input-required`） |
| adapter-agent-hermes | ✅ | ✅ 10 项单测 | **Hermes Agent（agent.provider=hermes-agent）**：复用确定性执行器/CLI 桥/SKILL 加载；MCP 经 `config.yaml` 预注册（`mcp-registrar.ts` 幂等 upsert + 写 `.env` token）；init 失败降级不阻断 |
| vm-service | ✅ | ✅ e2e 双通道 | 装配 + CLI（agent.provider 总开关，3 选项：workbuddy-deterministic / workbuddy / hermes-agent） |

## 测试
- **【当前权威口径 · 2026-10-08 Phase 0 收官全量实跑】：71 个测试文件 ／ 1247 tests ／ 1245 pass ／ 0 fail ／ 2 skipped**
  = `tests/unit/*.test.js` **63 文件 / 1177 例** ＋ `tests/unit/*.test.mjs` **8 文件 / 70 例**（逐文件方式）。
  增量来源：QA Phase 0 R1/R2 新守卫（`psmod-contract` + `assembly-guard`，commit `c10a400`）＋工程师 U-P0 安全守卫 `p0-path-traversal.test.js` 84 例（commit `ba02fbb`）。skip 3→2：`assembly-guard` 的 dry-run 软探针随 `ba02fbb` 落地转硬断言并通过。
  同日 20:xx QA 口径曾为 70/1162（`ba02fbb` 合入前），已被本行取代，历史快照备查于下行。
  同轮连带口径变更：根 `package.json` 的 `layout` 脚本（指向不存在的 `scripts/dep-lint.mjs`）**已删除**，
  依赖方向守卫 `dep-lint` 属 **Phase 2 规划**，改前请人工核对包间依赖方向。
- **【历史快照 · 2026-10-07】单元测试（逐文件复核）：59 个 `tests/unit/*.test.js` ／ 1054 tests ／ 1054 pass ／ 0 fail ／ 0 skipped**（口径仅覆盖 `.test.js`，已被上一行取代，保留备查）。
  ⚠ 2026-10-08 体检口径修正（`docs/audit/2026-10-08-test-docs-audit.md` §1）：`tests/unit/*.test.js` 实为 **60 个**（git ls-files 证实，现随 R3 增至 62）；另有 8 个 `*.test.mjs`（70 例）、`delivery/__tests__`（8 例）、`tests/e2e/`（17 例，本机 1 fail=pwsh ENOENT 无守卫）**均不在 1054 口径内**。1054 数字本身抽验属实无虚报。
  相较第十七轮（51 文件 / 736 pass / 0 fail / 2 skipped）净增 **8 个文件、318 个用例**，主要来自：K-N1 专项 `r19c-kn1-*` 7 文件、K3R 专项 `r19c-k3r-*` 3 文件 + `cl-k3r-runpersistent-approval-routing.test.js`、A5 专项 `r19c-a5-*` 2 文件、以及 `r19b-*`、`r3-uninstall-verify`、`install-vm-admin-endpoint`、`cl017` 等。
- 单元测试（逐文件复核，截至第十五轮 2026-09-29）：**636 tests / 634 pass / 0 fail / 2 skipped**（24 个 `tests/unit/*.test.js`；第十五轮新增 `k5-replay.test.js` 41 项、`k4-p3.test.js` 扩至 16 项，`k4-approval.test.js` 适配 ApprovalOutcome 契约 6 项；另含第十五轮前累计新增的 K2 预热/tunnel-mode 等测试）。历史快照曾记 214/214（第十四轮）、178 单测 + 16 e2e（分类口径不同）。
- 审批链专项（K3/K4/P3/K5）：k5-replay 41/41、k4-approval 6/6、k4-p3 16/16 全绿；`tsc -b tsconfig.build.json` 0 error。
- ⚠️ **运行方式硬约束**：必须**逐文件**跑（`for f in tests/unit/*.test.js tests/unit/*.test.mjs; do node --test "$f"; done`，`.js`/`.mjs` 两类都覆盖才等于 70 文件权威口径）。整批 `node --test tests/unit/*.test.js` 会因 `link-workspace.test.js` 的 `symlink(...,'junction')` 在本沙箱触发 node 进程访问违例（`2147483651`/`0xC0000005`），共享 runner 被打崩，同进程**所有**文件被连带判死、呈假全红、且无汇总计数。单跑该文件 16/16 正常，故属环境问题非代码回归。
- ps-bridge 真实拉起 PowerShell 5.1，五大模块加载并返回真实系统数据
- 端到端委派冒烟通过：宿主桥 → A2A → VM provider → ps-bridge → PowerShell，`completed` 并回传产物
- 空闲自愈验证通过：常驻 55s 空闲后委派仍成功（修复前必失败）
- ps-bridge 真实拉起 PowerShell 5.1，五大模块加载并返回真实系统数据
- 端到端委派冒烟通过：宿主桥 → A2A → VM provider → ps-bridge → PowerShell，`completed` 并回传产物
- 空闲自愈验证通过：常驻 55s 空闲后委派仍成功（修复前必失败）

## Skills（7）
- 7/7 已写 SKILL.md（1 总控 + 5 领域，含应用生产操作 appops + `winvm-mcp-reference` MCP 接入参考）。
  ⚠ 2026-10-08 体检修正：本节旧写「Skills（6）」与 skills/ 实际 7 目录、README/docs-index 7 口径矛盾（QA §5⑥）。

## 交付物
- 安装器 `delivery/install-host.mjs`：dry-run/正式/uninstall 验证通过（**第十轮修复 `node:fs` 漏导 `cpSync` 导致的 HOST 安装运行时崩溃 `cpSync is not defined`**）；**第十二轮新增 PATH 管理**：正式安装把插件缓存根 `…/plugins/cache/winvm/winvm-bridge/0.1.0`（含 `winvm-plugin` 启动器）加入【用户 PATH】（幂等），卸载（`--yes`）精确移除（不误删含该目录名的其它路径），逻辑抽至 `delivery/path-util.mjs` 并单测覆盖（⚠️ 写入用 PowerShell 单引号字符串，JSON.stringify 会把反斜杠翻倍导致注册表路径带双反斜杠、回读匹配失败）
- VM 侧 `delivery/install-vm.mjs`：支持 `--provider <id>`/`--cli <exe>`/`--skills-root <dir>`，dry-run/self-test/uninstall 验证通过；任务计划 登录即启（LogonTrigger）+ **隐藏 node 控制台窗口**。⚠️ 第十一轮修正认知：InteractiveToken 任务下 Windows **忽略** `<Hidden>true</Hidden>`，故改为生成 `delivery/.generated/start-hidden.ps1`，由 `powershell -WindowStyle Hidden -File` 经 `Start-Process -WindowStyle Hidden … -Wait` 拉起 node（保留 InteractiveToken 以维持 GUI 交互式会话；`-Wait` 保持任务 Running 语义，已补 8 项单测锁住回归）。**第十四轮**：部署启动器（`winvm-plugin`）后把 `<repoRoot>/delivery` 加入 **VM 用户 PATH**（修复 VM 内「`winvm-plugin` 不是内部或外部命令」），并写 `~/.workbuddy/winvm/side.json={"side":"vm"}`（使 VM 内 `winvm-plugin health` 自动走本地 `/health`、无需 vm-host/vm-user）；卸载时一并清理 PATH 与 side 标记
- **共享 Skills 部署器 `delivery/deploy-shared-skills.mjs`**：publish 仓库 `skills/` → 共享根 `C:/WinVMBridge/shared-skills`，再经 junction 让各候选 VM Agent 引用（单一真源，幂等/dry-run 验证通过）
- **双端一键 `delivery/setup.mjs`**（读 `.env`）+ `.env.example`：dry-run 生成七阶段计划验证通过（含 VM-START 轮询端口 ≤60s、HEALTH 解析 session.interactive 并打印 GUI 启用命令）。**第十轮修复 `reachable()`/`waitForRemotePort()` 误带 `-o BatchMode=yes` 致 `VM-START`/`VM-UNINSTALL` 被偶发误判「VM 不可达」而跳过（连带 HEALTH 失败、VM 卸载未执行），已去掉该选项并加 1 次重试与真实 ssh 行为对齐**。**第十二轮**：`reachable()` 预检门禁**彻底移除**——VM / VM-START / VM-UNINSTALL 三阶段改为**直接尝试真实 ssh 部署**，失败才报真实错误（不再静默跳过整步，根除「实测可达却被判不可达」卡死 reinstall 的问题）；TUNNEL 文案由假阳性「✅ 隧道已在后台启动」改为诚实的「连通性由 HEALTH 验证」
  - **插件管理 CLI `delivery/winvm-plugin.mjs`**（ESM、零依赖）：host/vm 同一份脚本自动识别上下文，提供 `help/check/health/list[skills,mcp-servers,mcp-tools,dirs]/server[start,status,stop,restart]/command/uninstall/update/reinstall`；启动器三件套（`.mjs`+`.cmd`+无扩展名 bash 启动器 `+x`）由 **`delivery/deploy-winvm-plugin.mjs`** 统一生成（`install-host.mjs` 部署到插件缓存根 + 仓库 `delivery/`、`install-vm.mjs` 落盘于 `delivery/`，命令真正可达）。**第十三轮**：`.cmd` 启动器健壮化——自重载 `cmd /d /c` 跳过 conda_hook 的 DOSKEY AutoRun 噪声，并显式定位 node（先查 nvm4w/Program Files，再回退 PATH），根除 `DOSKEY`/`node` not recognized；同时清理本机 User PATH 的历史双反斜杠损坏与 4 个 `__path_test__` 垃圾项（原始值备份 `.workbuddy/tmp_path_raw_backup.txt`，恢复脚本 `.workbuddy/clean_user_path.ps1`）。**第十四轮**：`loadVmConn` 重构为纯函数 `resolveVmConn`（优先级 argv > env WINVM_VM_* > .env VM_* > **部署期持久化 `~/.workbuddy/winvm/vm-conn.json`** > 默认值），宿主侧 health/server/command **无需每次传 --vm-host/--vm-user**；`install-host.mjs` 安装时写该文件、`setup.mjs` 的 HOST 步骤透传 `--vm-host/--vm-user/--vm-ssh-port/--vm-port`，卸载时移除
  - VM 产物已改为**排除法**分发（含 `psmod/`、`contracts/schemas/`），修复「远端服务起得来、自检过半，但 54 个能力一个都跑不了」
- **workspace 软链器 `delivery/link-workspace.mjs`**：远端无 `node_modules` 时建 `@winvm/*` junction（幂等/dry-run 验证通过）。本地模拟产物树实测：修复前 `ERR_MODULE_NOT_FOUND: Cannot find package '@winvm/contracts'`，修复后 `--self-test` 完整通过（54 项能力 + ps-bridge 探针全 OK）
- VM 服务配置 `delivery/vm-service.config.json`：含三 provider 定义（workbuddy-deterministic / workbuddy / hermes-agent），待在真实 VM 上跑一次 `--self-test` 做终验

## 第十八轮起变更状态（2026-09-30 ~ 2026-10-06）

| 变更 / 轮次 | 状态 | 关键结论 |
|---|---|---|
| **CL-021（R17）** | ✅ 条件 PASS / 路由 NoOne | 审批卡原生渲染 / 会话工具面诊断 / K6 卸载核验 / T02b 超时链；真机 5 例 BLOCKED 遗留 |
| **R19 真机轮** | ✅ 报告已出（含新缺陷） | E1 NSIS 卸载 / E2 MSI 对照 / E3 dryRun 异常复现 PASS；E4 BLOCKED；E5 超时链 PASS |
| **K-N1（High）** | ✅ 已修复 + 242/242 单测 | 委派回合零 `tools/call` 时 `reconcileDelegationTruth` 先行反查 ⇒ 零账本活动报 `failed`/`NO_EXECUTION_RECEIPT`；`r19c-kn1-*` 7 文件 242 例全绿（真机复证可选，单测已闭环） |
| **K-N2** | ✅ 已修复 + 74/74 单测 | dryRun 改宿主侧纯查询预览 `Get-UninstallDryRunPlan`（`app.ps1:693`），零 winget 调用；`r19b-s1-registry-forms` 35/35 + `r3-uninstall-verify` 39/39 全绿；真机码 `-1978335230`（0x8A150002）已断言 |
| **S-4** | ✅ 已修复 | `POLICY_DENIED` 硬拒绝现经 `recordPolicyDeniedAudit` 落 `blocked:policy-denied` 审计（`server.ts:605` & `:837` 双早退前）；账本跳过规则改用哨兵 `approval.approvalId==='policy-denied'` 判别（`delegation-audit.ts:383`），避免真实规则名（`maxRisk:…`/`pathDenylist:…`）漏判污染 K-N1 账本；`r19c-s4-policy-denied-audit.test.js` 7/7 + 回归 82/82 |
| **A2A A5（`rejected`）** | ✅ 核心已修 + 26/26 单测 | `endTask`/`raise` 加单例 `activeTaskId` 护栏（`server.ts:189-200`/`:205`），`rejected` 终态可达且已由 A5 coordinator 测试 B3（`:369`）+ `:283`/`:305` 断言；唯一残留（非阻塞）= 死字段 `cancelRequested`（`a2a-framework/task-store.ts:51/116/188` 无读取方） |
| **CL-K3R（K3 根治）** | ✅ 真机 T05 A~F 全过 | `on`×3 全 `input-required`（`apr_1bdd3e1e4b9e4e318b7e`）；harness 收紧后复验 PASS（`apr_7e7b60b61a0c4075b510`） |

### 测试口径（硬约束复述）
- 必须**逐文件**跑：`for f in tests/unit/*.test.js tests/unit/*.test.mjs; do node --test "$f"; done`（`.js`/`.mjs` 两类都覆盖才等于 §测试 节 70 文件权威口径）。整批 `node --test tests/unit/*.test.js` 会因 `link-workspace.test.js` 的 `symlink(...,'junction')` 在本沙箱触发 node 进程访问违例（`0xC0000005`），共享 runner 被打崩，同进程所有文件被连带判死呈**假全红**。
- 第十七轮（2026-10-07）当时实测即按逐文件方式聚合，得 **1054 / 1054 / 0 fail / 0 skipped**（仅 `.test.js` 口径）；当前权威口径见本文 §测试 首行（70 文件 / 1162 例 / 1159 pass / 3 skip，2026-10-08）。
