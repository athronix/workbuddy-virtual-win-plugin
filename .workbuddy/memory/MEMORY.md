# 项目长期记忆 · winvm-virtual-win-plugin（索引）
> **完整版**=`MEMORY-full-20261120-1300.md`（12K，架构全量/坑清单/待办/基线红）。本文件只留「不看就会踩」的硬约束。
> 交接=`.workbuddy/README.md`；细节=`docs/archive/`、`qa/`、`docs/release/ISSUES.md`；决策台账=`~/winvm-deploy/deploy-session.md`（新会话先读）。
> **架构真相=`docs/design/proj-arch-review/`（2026-11-23 复审，源码实证 > 设计意图）**：改动核心逻辑前先读 `04-FINDINGS.md`，跑 `node docs/design/proj-arch-review/verify-claims.mjs` 确认结论是否仍成立（当前 16/17，唯一 FAIL 是刻意的文档漂移基线）。
> **⭐ 单页入口 = `15-OPTIMIZATION-DIGEST.md`**（2026-11-24 新增）：七份 4371 行压成一页 —— 改什么/怎么改/做到哪/待拍板。要回答「优化了什么、做到哪了」先读它，别通读 `13`+`14`。`05` 与 `10` 是**过程稿，不必读**（结论已被 `11`/`13` 取代）。
> **⚠ 基线红真因已实证更正**：`phase2-snapshot-truth` 数的是「src 出现 `snapshot` 字样的**文件集**=白名单」，`mcp-upstream.ts:65` 的**注释**也会命中；`phase3-skill-claims-guard` 的 `registeredIds()` 是**从 `definitions.ts` 源码正则提取、不读统一表**，offender `response.data.unserializable` 是上游文档字段路径。⇒ **两条红与「三面未统一」无关，阶段 3 不会让它们转绿**（原 `13`§4.5/`14`Step3.2 的「自证设计」已作废）。
> **下一版架构定稿 = 同目录 `11-ARCHITECTURE-VNEXT.md` + `12-DEPLOYMENT-THREE-PARTS.md`**。核心 6 裁决：执行路径 3→1（上游 58 工具裸奔必须收进闸）/ provider 3→1（LLM 降级为 planner）/ 能力表 54→**112** / 审批位置不动只补覆盖面 / 删 3 类零消费 / 部署解耦。**`11` 号文取代 `05` 号文的 B-1（域模型改 6 值 → 改为直接删领域）**。

## 一句话架构
宿主 WB 插件（鸿蒙）→ Win11 VM `172.16.100.2`（用户 `User`，密码不落库）= 54 能力 / `/mcp` 直调 + `/a2a` 委派；VM 服务只听 `127.0.0.1:18443`（计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`，改 `psmod/*.ps1` 必重启）；另挂 `/mcp/browser`(33，**无白名单=全量**) 与 `/mcp/desktop`(**25**，VM 侧白名单；上游 agent-desktop 共 75) 两 stdio 上游，**共用同一条隧道只差 path**。⇒ 三面合计 **112**。部署唯一权威 = `winvm-plugin-deploy` skill。

## 当前态（2026-11-26）
- **★ 发布面铁律（I-38.11 实测）**：发版必须**逐端点**验证，不能由日志外推。
  `tag ≠ release ≠ 资产` 是三个独立对象 —— `git ls-remote --tags` 看到 tag 在，
  **完全不能证明** release 存在。实测 V1.4.39/40 曾只有 `sanway-tech` 齐，
  `athronix` 双端 4 个 URL 全 404（Gitee release 列表最高仅 V1.4.38）。
  已验证方式：`curl -r 0-0` 逐端点取 http_code（200/206/404）+ 远端 `.sha256`
  与本地逐字节比对。补齐命令：`publish-release.mjs --repo <owner/repo> --apply --mirror-gitee`
  （走 HTTPS API，**不吃 SSH 权限**；`GITHUB_PAT` 对 athronix `admin/push=true`）。
- **★ `credentials.env` 带连字符的键 shell 无法 source**：`GITHUB_PAT_SANWAY-TECH` /
  `GITEE_PAT_SANWAY-TECH` / `GITHUB_GRAINED_PAT_SANWAY-TECH` 全报 `command not found`
  ⇒ 这 3 个 token **从未被加载过**。绕过用 `GITHUB_PAT` + `GITEE_ACCESS_TOKEN`；
  **待改**键名为 `_SANWAY_TECH`。
- 母项目 **V1.4.40 已真机闭环**（`DEPLOY=PASS` 232s / 探针 34/34 / `health=200` / `browser=33 desktop=25`，
  2026-11-26 19:49）；**I-38.1 / 38.3 / 38.7 / 38.10 全部关闭**。技能仓 **v2.6.4+**（`HEAD=83c0809`）。
  技能门禁 `ALL_GREEN checks=37 / fails=0`；全量单测 `files=143 failed=0`（`✖` 严格计数 0）。
- **★ 上游闸门三向判别取证（判「闸门真生效」的唯一充分形态）**：
  ① L2 工具（`agent_browser_eval`）→ `DELEGATION_REQUIRED`；
  ② 低风险工具（`agent_browser_get_title`）→ **原始上游结果** `{exitCode,response,success}`、**无** `code/matchedRule` ⇒ 真执行未误伤；
  ③ 未知工具 → `UNKNOWN_UPSTREAM_TOOL`（fail-closed）。
  只验 ① 无法区分「按风险分级」与「另一种全拒」。
- **★ 判据数值要从判据脚本读，别从台账/记忆抄**：`shared-skills` 现行判据是 **≥10**
  （`deploy-5-verify.sh:148-150`），台账曾误写「应为 9」，实测 10。
- ⚠ `deploy/skills/winvm-plugin-deploy` 是**指向** `~/Documents/projects/skills/winvm-plugin-deploy`
  的 symlink（红线 10 形态），改技能只改源码仓一处即可。
- v2.5.9 = **零配置上手**：默认 `172.16.100.2`/`User`/无密码 + `~/.winvm-pass` 自动认（文件存在才生效）+ 全仓禁裸 `/tmp`（鸿蒙只读）。
- v2.6.2/2.6.3 = **安装链**：`scripts/install.sh` **默认装 release 包**（gitee 优先/github 兜底 + sha256/name/version 三重校验，校验全过才落地成真实目录），**`--from-local` 才 symlink 挂工作区**；覆盖 symlink 先记原指向再删链、绝不 `cp -R` 写穿。
- 真机：`UNDEPLOY=PASS` 48s / `DEPLOY=PASS` 303s / `VERIFY=PASS`，探针 34/34、health=200；证据 `qa/real-test-2026-11-20-v1437.md`。
- **V-NEXT 阶段 1 已在工作区完成、尚未发版/提交**（净删 1572 行，40 文件）。下一次发版前须注意：`packages/` 已 12→11 包（`adapter-agent-hermes` 消失），`vm-service.config.json` 的 provider 只剩 `workbuddy-deterministic` + `workbuddy`，`TransportDecl` 只剩 `streamable-http` / `stdio`。
- **V-NEXT 阶段 2 半程已完成（2.1/2.2，2026-11-24）**：`contracts/src/unified.ts`（`Surface`/`CapabilityEntry`/四条运行期不变式/`SURFACE_EXPECTED_COUNTS`=54·33·25/`UNIFIED_TOTAL`=112）+ `vm-capabilities/src/registry/unified.ts`（vm 面 54 条 `.map` 派生，零字面量）+ `tests/unit/unified-capability-table.test.js`（24 绿）。全量单测 **PASS=125/FAIL=5**（失败清单=基线）。
  **⚠ 2.4 动工前必须先解的分层阻碍**：desktop 白名单住 `vm-service`，而 `vm-service` 已依赖 `@winvm/vm-capabilities` ⇒ 反向 import 成环。须先把 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` **下沉**到 `vm-capabilities/src/registry/`（推荐）或 `contracts`，**不得**在 vm-capabilities 里硬编码 25 项。

## 推送凭据（不看必卡，2026-11-23 实测）
- **Gitee**：必须 `id_ed25519_gitee`（= sanway-tech）。`id_ed25519` 在 Gitee 是 **athronix**，推 sanway-tech 仓必 `Auth error: Access denied`。`~/.workbuddy/git-ssh.sh` 已修（加 `*gitee.com*` 分支）。
- **GitHub**：SSH 钥、gh token、`GITHUB_PAT` **全是 athronix（无 push 权限）**；唯一能推的是 `credentials.env` 的 **`GITHUB_PAT_SANWAY-TECH`** → HTTPS + 临时凭据文件 + `-c core.sshCommand=`（**必须显式清空**，否则被 git-ssh.sh 导向 SSH）。GitHub 常 `Could not connect`(65s)，**必须重试循环 + `ls-remote` 比对 HEAD**，不能只看单次 rc。
- **Gitee attach_files** 不吃 `?access_token=`（报 `40001 登录失效`），**必须 `-F access_token=<tok>`**；create release 则两种都行。

## 十条红线（详见完整版）
1. **绝不**自启 VM/guest 重启。
2. 通道后端默认必须 `auto`；退化 `key` ⇒ `rc=124` + 假 `NO_CHANNEL`。
3. `ps-run.sh` 载荷**纯 ASCII**（中文注释也算）；违规表现「~1.6s 零输出」，极易当成功。
4. 载荷脚本 UTF-8 **无 BOM**、首行禁 `#requires`；`ps-run.sh` **无 `-File`**。
5. **传输预算 ≠ 载荷预算**：`VM_SSH_TIMEOUT`(25s) 只管连接，载荷走 `VM_PS_TIMEOUT`(180s)；rc=124+零输出 → 先量耗时。
6. **`health=200` 不是通道判据**（长连口径），须 ping + 裸 TCP banner 三段取证。
7. `deploy.sh` 装的是 **release tag 的包**，不是工作区源码 ⇒ 改完码**先发版**再验证；也没有 `--dry-run`。
   **★ 推论（2026-11-25 实证）：探针全通 ≠ 改动已生效。** 真机验证前必须先比对 VM 侧构建时间：
   `vm-service/dist/server.js` 的 MTIME 必须晚于本轮改动时间，否则拿到的是旧包的健康报告。
   同时核验关键新符号是否存在于 dist（如 `gateAndExecute`、`gateway.js`、`winvm-browser`），
   **只改工作区不发版 = 真机上完全没有这些代码**。归因时按**真实落点包**写
   （3.6b 在 `adapter-agent-workbuddy-llm`，不在 `adapter-agent-workbuddy`）。
8. 门禁假绿三类：查子串 / 查次数 / 查注释（`strip_comments` 剥注释）→ 逐条锚定独有代码上文。**追加第四类**：同一行代码在多个分支复用（如 local/release 都有 `unlinkSync`）时，「全文件位置/存在性」断言必然假绿 → 断言要收进目标函数体按相对偏移比。
9. 鸿蒙 `/tmp` 只读（`curl -o` 报 23，像网络问题）→ 跑完即弃的文件用 `${TMPDIR:-$HOME/wbtmp}`；**要长期留的回滚记录必须 `$HOME/wbtmp` 优先**（`TMPDIR` 在鸿蒙 = `el2/base/cache`，清缓存会整目录回收）；git 不在 PATH，用 `$HOME/.harmonybrew/opt/git/bin/git`。
10. symlink 陷阱：`~/.workbuddy/skills/<name>` 为软链时 `cp -r` 备份的是链接、覆盖会写穿到源仓库 → 先 `readlink` 再删链重建（`install.sh` 已是唯一入口）。

## 基线红（不可当回归）
**★ 2026-11-25 已清零**：`--quick` = `FILES=16 FAILED_FILES=0` 322/322 `GREEN`；全量 sweep = `FILES=143 FAILED_FILES=0` 2575/2573/0/2 `GREEN`（11-26 加入 `vnext-build-artifacts` 后）；`verify-claims` 17/17；`selfcheck` ALL_GREEN 37；`dep-lint` GREEN。
原基线 5 红（`p8-probe-fresh` / `r19c-kn1-e-mutation` / `r19c-kn1-e-shape` / `phase2-snapshot-truth` / `phase3-skill-claims-guard`）已全部按真因修掉，**现在若看到它们再红 = 新回归，不是基线**。
判据仍只能**逐条比对失败清单**，不能只看 VERDICT。

## 两条新增工程纪律（2026-11-26 自踩）
- **核验落点前先 `grep -rln <符号>`，不要按「逻辑上应该在哪」猜路径。** 本轮同一毛病犯四遍：
  3.6b 在 `adapter-agent-workbuddy-llm`（非 `adapter-agent-workbuddy`）、4.3 在独立 `cli-agent-planner.ts`（`bridge.js` 只有注释）、
  2.4 在 `registry/unified.ts`（`desktop-allowlist.ts` 根本不存在）、5.1 在 `delivery/connect-channel.mjs`。
  猜路径产生的 FAIL 是**假红**，白花一轮排查。
- **`tsc -b` 不能靠 mtime 判新旧。** 它按 tsbuildinfo 的**内容 hash** 增量，内容未变时**不重写 dist**
  ⇒ dist mtime 早于 src 完全正常。判断「是否最新」应跑 `tsc -b` 看有没有报错，不是比时间。
- **写「符号出现 N 次」型判据时，先枚举除真实使用外还有谁会命中它**：import 语句、注释、同类命名变量，
  三类都能凑数（本轮 `gateAndExecute >= 2` 就被 import + 一行注释凑过，突变把调用点全删仍 PASS）。

## 待办
**★ 2026-11-25/26 架构复审六步（`docs/design/proj-arch-review/14-EXECUTION-PLAN.md`）已全部完成静态收口 + 构建产物核验**（commit `653a195`+`b4d79fc`+`0435061`+`bb23681`+`9b6a003`+`fb8462d`+`f176d51`）。唯一未闭环 = **发版 + 重部署**（属发布动作，需 owner 裁定）。
**★★ 发版的优先级已从「可选」变为「安全项」**（2026-11-26 真机实证）：VM 当前构建上
`gateUpstreamAndExecute`=False、`upstreamGates`=False，且 `POST /mcp/browser` 调
`agent_browser_eval`（= `browser.meta.eval`，**risk=L2 页内执行任意 JS**）**直接执行成功返回 result=2**
⇒ **上游 58 个工具此刻在真机上完全裸奔**（无闸门/无审计）。修复代码在本地已完备
（`step32-upstream-gate.test.js` 23/23），只差部署。**只要不重部署，这个洞就一直开着。**
① 第 1 步「从零通道」真·端到端演练（尚未做）；② **待裁定**：`INSTALL_PROMPT.md` 是否补 Gitee 双源（现 GitHub raw 单源，曾挂 6m47s）；③ 拆通道后 `WinRM 5985 OPEN` 但脚本无引导路径（能力缺口）。
④ **架构复审 14 条待处理**（`docs/design/proj-arch-review/05-OPTIMIZATION-PLAN.md`）：第一批「止血」A-1~A-5 约 1-2 天，做完即可让「隧道死代码」「domains 静默丢失」两件事在 30 秒内可见。**A-2 → B-1、A-4 → B-5 是唯一两条硬依赖**，其余可并行。
⑤ **V-NEXT 改造（22-23d，`11`+`12` 号文）**：阶段 1 删除(3d) → 2 统一 112 项(5d) → 3 闸门(4d) → 4 LLM 降级 planner(4d) → 5 部署解耦(3d) → 6 验收(2d)。**硬链：1→2→3→4，5 最末**。工期压到 10d 内则只做 1/2/3（安全+分类；4/5 只影响维护成本）；阶段 5 只做 5a（抽 `connect-channel.mjs`，1d）也能消灭最严重的错位。
  - **阶段 1 ✅ 已完成（2026-11-23）**：净删 **1572 行**（40 文件，-1922/+350）。删 `core/transport/ssh-tunnel*`(690) + `adapter-agent-hermes`(488,包级) + 2 个死函数 + `SkillDomain`；**顺带修掉潜伏 bug B-1**（渲染出字面量 `Bearer ${undefined}`）。收口：`dep-lint packages=12→11`，门禁 RED 仍为基线 2 条，全量单测 **123 过/5 败＝基线**，渲染三 URL 逐字未变。唯一挂起项 = Step 1.4（见 ⑦）。
  - **Step 1.2/1.3 两处经验**：① `skills/*/SKILL.md` 的 `domains:` 行**不要删**（零收益却会撞 skill-claims 守卫造成假红）；② `hermes-agent` 有两个同名不同义的存在——VM provider（已删）vs **Skill 部署目标** `deploy-shared-skills.mjs:64`（**必须留**，删了=stdio 上游技能包静默不同步）。已加命名撞车警示注释。
  - **新规矩**：断言「数量」要断**不变式**（dep-lint 包数 == `tsconfig.build.json` references 数），不要断字面量（`>= 12`）——否则合法删包/合并包必然假红。
⑥ **待 owner 拍板**：审批黑名单的最小初始 4 条（`browser.meta.eval` / `desktop_launch` 直启 cmd/regedit / `system.power.control` shutdown/restart / `pathDenylist` 初始值）——当前 `CapabilityPolicy` 全字段可选且**内容为空**，「默认放开」实际等于无防护。
⑦ **待 owner 裁定（阶段 1.4 已挂起）**：`WINVM_DELEGATION_REQUIRED_POLICY` 是否删除。实测它是 `(c) 收口`（直调 L2/L3 ⇒ `DELEGATION_REQUIRED`）的**回滚保险**，被 5 处运维/设计文档当承诺面引用（`OPS-OVERVIEW:306,528` / `deploy-strategy:93` / `INTERFACES:221` / `SECURITY-GOVERNANCE:126`+`K5:94`）。`(c)` 本身是安全修复（替换 P0-1 死循环）⇒ 删开关 = 撤掉退回已知可用旧态的绳。**折中方案**：保留键名 + 双分支收敛成单分支 + 启动废弃 WARN（0.5d，不撤承诺）。
（聚合仓已于 2026-11-23 追平 v2.6.3：双端 `marketplace.json` 9125B/`b4d49929` 与 `winvm-plugin-deploy.link.json` 454B/`1b8e2673` 均 SAME。）