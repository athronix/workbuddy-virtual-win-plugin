# Phase 3 批0 · 文档止血 施工记录（工程师：寇豆码 Alex）

> 任务：P0-3 失实承诺族诚实化 + SKILL 教学错误订正 + 漂移治理 + 新静态守卫 `phase3-skill-claims-guard`。
> 约束：严禁 git 写操作；禁跑 `tsc -b` / `node scripts/gate.mjs`；单测只单文件跑；只写所有权清单内文件。
> 本文档为增量落盘主账本，每改完一个文件/一个新判据立即 append。

## §0 骨架（开工登记）

- 状态：进行中
- 变更清单（任务书 A1–A5 / B6–B10 / C11–C12 / D13–D14）：
  - [x] A1 ARCHITECTURE.md session-guard 宣称（:71、:276-278）
  - [x] A2 SECURITY-GOVERNANCE.md Origin 校验（:38）+ maxRisk/allowedCapabilities（:53）
  - [x] A3 INTERFACES.md `__approvalId` 续跑（:212）+ E-1 处理（:195-196）
  - [x] A4 K5-server-replay-approval.md 状态行（:3）+ 自相矛盾修订（:67/:91）
  - [x] A5 ARCH-09 previewHash 措辞统一（grep 定位）
  - [x] B6 winvm-mcp-reference SKILL.md `__approvalId` 教学（:212-213）
  - [x] B7 approval-card.md 三处（:33/:60/:142）
  - [x] B8 winvm-gui-automation SKILL.md tscon 配方（:32）+ 幻影动作（:188）
  - [x] B9 winvm-storage-manager（:143）+ winvm-app-manager（:100）powershell 教学
  - [x] B10 winvm-orchestrator 健康门（:137/:140）+ dryRun（:315、:262-264）
  - [x] C11 CAPABILITY-MODEL.md §7 路径漂移
  - [x] C12 README 基线查法 + 分层叙述 + GATE-POLICY:98 静态数字 + 双概览对齐
  - [x] D13 tests/unit/phase3-skill-claims-guard.test.js 新建（a/b/c 三判据）
  - [x] D14 守卫自测全绿 + wbtmp 副本判红自证
- 环境实测：git 需全路径；node OK；`getcwd` 噪音无害；工作区 M 文件 `.workbuddy/memory/...` 非我方产生（已报备主理人，不动）。

## §1 逐处施工明细

### A1 ARCHITECTURE.md session-guard（完成）
- `ARCHITECTURE.md` ASCII 图（原 :71）：`↑ session-guard 保活：自动登录 / tscon / 禁休眠` → `↑ 会话健康探针（在位）；session-guard 保活恢复＝规划项·未实现`。
- `§6.3`（原 :269-283）：删 `core/session + vm-capabilities/session-guard 提供` 现在时宣称，加诚实化订正引言块（注明 A-14 旧账、setup.mjs tsconfig 假阳排除、恢复需人工）；机制表拆两列状态：探针/黑屏告警/降级=✅ 在位；tscon/自动登录/禁休眠=⚠️ 规划项（未实现）。
- 附带（同源失实）：`§5.1` 传输表 `streamable-http` 行（原 :231）`强制 HTTPS + token + Origin 校验` → `强制 HTTPS + token；~~Origin 校验~~（规划项·未实现…）`。**改判说明：任务书只列 :71/:276-278，但 :231 同一 Origin 失实承诺在 ARCHITECTURE 复现，属 A2 同族口径，一并诚实化（不扩面到别的功能域）。**
- 亲验：`packages/core/src/session/` 仅 `health.ts`（探针契约，无恢复动作）；`grep -rn "tscon|AutoAdminLogon|powercfg" packages/ delivery/` 真实现零命中（setup.mjs 命中系 tsconfig 子串）。

### A2 SECURITY-GOVERNANCE.md（完成）
- 原 :38 第 1 层框：`HTTPS + bearer + Origin 校验（HTTP 模式）` → `HTTPS + 可选 bearer（enforceBearer，缺省 false）；Origin 校验＝规划项·未实现（源码零命中）`。亲验：`packages/vm-service/src` + `packages/mcp-framework/src` grep Origin 零命中。
- 原 :53 第 6 层框：`委派携带 allowedCapabilities + maxRisk` → 加 `（声明记录于审计链；执行面尚未接线＝Phase 3 批1 在建，见 §2.3）`。
- **新增 §2.3**（E-1 终版定性节）：五环节状态表（宿主可填✅/审计留痕✅/进 evaluate 实参❌/流式装配❌（deterministic provider 白名单 index.ts:755-756 为唯一消费先例）/端到端用例❌），并立"读法约束"：全文其余 maxRisk/allowedCapabilities 处（§3.1 第 7 步、默认表 :151/:412 等）一律按"声明+留痕"读，不得读作服务端强制。原 §3.1 判定顺序第 7 步与 :151/:412 默认值行**未逐行改写**——由 §2.3 统一"读法约束"覆盖，避免打地鼠式漂移；此为设计决定，记此备查。

### A3 INTERFACES.md（完成）
- 原 :195-196（§3.4 示例两键）后加订正注记块：声明记录于审计链、执行面尚未接线、批1 在建，引 §2.3（SECURITY）。
- 原 :212（宿主桥义务行）保留通道隔离原句（该句本就禁止 A2A 用 `__approvalId`，不失实），**其后新增** `__approvalId` 续跑现状订正块：批准即删 token（server.ts:464）⇒ 缺省灰度下重发恒返 APPROVAL_REQUIRED ⇒ 批1 在建、不得写成现在时可用路径。
- §3.5 前段"宿主确认后发 message/send 带同一 taskId 继续"（A2A 通道）亲验可达（approval.reply→waitApproval→raise→replay），不属失实承诺，未改。

### A4 K5-server-replay-approval.md（完成）
- :3 状态行：`设计定稿，待实现` → `已实现并真机验收`（k5-replay.test.js 41 例、两份 09-29 报告在册），保留作者/前置行，加 J-5 订正注记。
- :67 代码注释 `保留：/mcp 直调续跑仍可用（人工显式路径）` → `置位后立即被下方一次性删除吞并——直调续跑实际不可达（订正见 §4-2；批1 在建）`。
- :91 安全纪律第 2 条：原文保留 + 追加"口径统一订正"段：**缺省灰度下批准即删 token，直调续跑实际不可达；严格闸保留仅指闸语义不放宽，不承诺续跑可达；续跑可达性=批1 在建；replay=off 回滚态下 K4 直调续跑仍可用（回滚位非主路径）**。server.ts:447/:450-464 实况亲验：replayEnabled&&replay 时先 hostApproved=true 后无条件 delete token；off 时 token 保留。

### A5 ARCH-09 previewHash（完成，用户终裁=补建措辞）
- grep previewHash 文档面命中：SECURITY-GOVERNANCE:175（设计文档，改）、docs/design/r17-design.md、docs/changes/CL-016/*（**changes/设计存档不在所有权清单，不动**）。
- SECURITY-GOVERNANCE:175 改写：保留宿主侧计算落点描述（approval-audit.ts 真实在位），把"比对/不一致即标记不静默通过"降为**目标行为**，加订正注记：**绑定机制批6 在建，当前 previewHash 为空**（服务端恒 ''，server.ts:250/:1187 注释自证预留；两侧数据未打通、比对从未运行）。凭据永不入账（在位）保留。

### B6 mcp-reference SKILL（完成）
- :212 续跑表 MCP 直调行：现在时"以同一参数并附 __approvalId 重新调用" → **当前不可自动续跑**+机理（批准即删 token）+批1 在建+死循环禁令；关键标记列注"批1 前不可依赖"。

### B7 approval-card.md 四处同窗口（完成）
- :33（L2 模板续跑指令）、:60-61（L3 模板续跑指令）、:142（§9 续跑指令对照）三处 MCP 通道行全部改为"批1 前不可依赖"口径；卡片模板示例内串统一保留 approvalId 槽位演示值语义但动作改"告知用户等待，勿死循环重发"。:145/:187 通道隔离红线句不失实未动。§3 引言"凡是支持 dryRun 的"（原 S-3 泛化句）一并精修为 supportsDryRun 声明制口径（同窗口一致性需要）。

### B8 gui-automation SKILL（完成）
- :32 tscon 配方行：`tscon <sessionId> /dest:console 归还控制台；或配置自动登录` → **需人工在 VM 控制台物理操作**（session-guard 自动恢复未实现、SKILL/能力面无 sessionId 数据源，Agent 不可自动执行）。亲验：definitions.ts/meta.health.check 输出无 sessionId 字段（health.ts 兜底结构含 sessionId 但为服务端内部探针字段，非宿主可读工具输出）。
- :188 `（均可重试，需先恢复会话）` → 删幻影前置动作，改**真实路径**：`meta.session.status`/`winvm-plugin health` 判会话态，恢复只能人工（RDP 重连/物理控制台），Agent 侧动作=告知用户+不自动重试至恢复。

### B9 powershell 教学两处（完成，按实测改判 pm2）
- 亲验 `definitions.ts:381` enum 无 powershell；`appops.ps1:234-245` custom 分支真实（首词解析为 exe）；`defaults.ts` 黑名单不含 Expand-Archive（仅 -enc/iex/FromBase64String 等混淆形态）。
- **可达路径存在**：`app:'custom'` + `command:'powershell -NoProfile -Command "..."'`。storage-manager:143 与 app-manager:100 均改教该形态，并显式警告 `app` 枚举无 powershell（直传恒 INVALID_PARAMS）。
- 与 pm2 NEW-UX-01 建议差异：其给的双路径方案（command='powershell'/arguments=...）实测可行度不如单串 command 形态（custom 把 command 首词解析为 exe 后其余入参，arguments 会追加其后——语义等效，但文档以单串 command 最简）。记入对账差异。

### B10 orchestrator 健康门+dryRun 双口径（完成）
- :137/:140-141 判据 `ok:true ∧ available==count` → **`ok:true` 即放行**；degraded（available=3 仅 meta.*）给归因读法（provider.state/detail）+处置（tunnel ensure/重启服务）+禁令（不得拿等式当门禁/不得自锁循环）。核心判据满足"不得存在数学上不可满足的门"。
- :315 dryRun 泛化句：改"仅对声明 supportsDryRun 的 5 条能力免审批；未声明者 dryRun 照常被拦"。亲验声明全集=5（definitions.ts:146/179/205/301/314）。
- :262-264 与 :330 高危清单行同步 supportsDryRun 措辞（三处双口径对齐）。
- :261 S-1 续跑教学：同 A4/B6 口径改口（批1 前不要重发，如实告知等待）。

## §9 移交（清单外新发现，不擅自扩面）

- **N1（ARCHITECTURE §2.2 L2 表行）**：§2.2 包清单表把 `host-a2a-bridge` 标 L2（机检事实源=L3-host-bridge）、缺 adapter-agent-workbuddy-llm/hermes 两行——J-1 分层三源矛盾族的表侧。ASCII 图与 README 侧本次统一为"包清单+权威指针"，**表侧行建议随 C12 一并处理**（见下）；若判改动过面带风险，移交主理人裁。
- （其余暂无）


### C11 CAPABILITY-MODEL.md §7 路径漂移（完成）
- §7 整节重写：旧 5 步流程引用两个**不存在**路径（`packages/vm-capabilities/powershell/<domain>/`、`packages/vm-capabilities/registry/<domain>.ts`）——依 audit-arch.md ⑤ D-6a/5.2 取证改为实况 7 步：`psmod/<domain>.ps1` 单文件六域亲验（ls 命中 system/app/storage/gui/appops/ps-bridge）、`src/registry/definitions.ts` 单文件 54 条亲验、`EXPECTED_TOTAL=54` @ psmod-contract.test.js:126 亲验、第 3 步"运行契约校验（自动）"如实化为"测试/门禁面手动（Q1=(b)）"、补第 7 步"改 psmod 必须重启 VM 服务"（R-4 铁律）。加订正头注（J 系漂移留痕）。

### C12 README/GATE-POLICY/双概览（完成）
- **README §8 基线查法**：`sort | tail -1` → `sort -V | tail -1`，机理写明（字典序 t9>t12 返过期件 / mtime 被 checkout 重置⇒ls -1t 同不可靠 / sort -V 实测对 t<数字> 正确）。亲验：sort 尾=t9（过期 1857），sort -V 尾=t12。**防呆注**：取最新文件后必须核对 FILES= 与 BASELINE: 对账行——t12=89/1751 系批次窄口径（BASELINE 行自证 p2t7 88+1=89），t11=92/1889 为全量锚（gate 双路 CROSSCHECK 在册）；旧文 t9 锚句（"最近一轮 P2-T11...锚定 t9=91/1857"）已被新口径覆盖改写（静态"最近一轮"叙述本身即漂移源，K-18）。
- **README §2.4**：快照行划线改口（信息性声明/运行期不产，指向 SECURITY §3.2 权威句+既有判据）；Origin 校验划线"规划项·未实现"。**这两处是任务书清单外但以"失实承诺零残留"验收判据强制要求**（README 属批0 台账点名面，现时态承诺词不得残留），登记于此备查。
- **README §3.2 分层表 + ARCHITECTURE §2.1 图/§2.2 表（N1，主理人批准顺手修）**：三源统一为 package.json `layer` 字段权威（dep-lint node 实测 12 包逐名 dump：contracts=L0-contracts / core=L1a-core / mcp=L1b-mcp-framework / a2a=L1b-a2a-framework / host-sdk=L1c-host-sdk / adapter-host=L2-adapter-host / **host-a2a-bridge=L3-host-bridge** / vm-capabilities=L2-vm-capabilities / adapter-agent=L2-adapter-agent / **llm+hermes=L2-adapter-agent-llm** / vm-service=L2-vm-service）。ARCHITECTURE ASCII L2 框补两 llm 包+新立 L3 框（host-a2a-bridge）；§2.2 表 host-a2a-bridge 行 L2→L3 改标+补 llm/hermes 两行+J-1 订正注记；README §3.2 表"层"列逐包带 layer 字段值+口径头注（"dep-lint 承诺的口径注记显形"兑现位，J-1 加重项闭环）。
- **GATE-POLICY.md:98 族**：ST3 表静态"例数"列整列删除（17/14/23/22/48/24/7——违自家 K-18"基线数字只写实测"），改动态查法句式（node --test 单件 tail / 最新 sweep 逐文件行）。亲验：无测试解析该表例数列（dep-direction U-5 只断 gate.mjs 导出表↔磁盘，不读 md 表格）；phase2-snapshot-truth.test.js 实测 17 与旧列一致，但静态列必漂故删。
- **overview.md（J-3）**：:101"（当前态：194/194 测试通过、12 包）"→"当时的当前态已废+权威指针（README §8 查法）"订正注记。:19/:22/:48 混用计数系第三轮当时叙事（历史轮次记录，K-20 惯例=不回写史），头注已限定"止于第三轮"，未逐行改写——登记此判为设计决定。
- **docs/06-OVERVIEW.md（J-6）**："单元测试与端到端全绿"→"单元测试全绿"+端到端限定注（tests/e2e 不在枚举面且本机不可跑；端到端唯一可指=真机 A 系列最近轮 run7，文件名已亲验在册 real-test-2026-09-24-run7.md；断供需批5）。两概览分工显形：overview.md=历史快照（已加废数字订正）、06-OVERVIEW=交付概览（e2e 口径订正），J 系双概览漂移收敛。

### §9 移交（清单外新发现，不擅自扩面）——更新
- **N1 已闭环**（主理人批准，见 C12）。
- **N2（新登记）**：ARCHITECTURE.md `§6.3` 旧表下 `docs/audit/2026-10-08` A-14 旧账已在订正注记点名；另 README:86-90 ASCII 宿主区"7 Skill"叙述与 SPEC-SKILLS 计数一致未动。未发现其它清单外失实承诺**现在时**残留（grep 自证见 §2 终检）。

### C11+/C12+ 追加诚实化（grep 终检逼出的同族残留，均已改）
- **SECURITY-GOVERNANCE §5.4 恢复动作表**（tscon/自动登录/禁休眠 现在时配方）：加"执行形态"列逐行标注人工/未实现+诚实化注记（引用 ARCH §6.3 订正）；§8 风险对应表 :445 行"会话探针 + tscon + 自动登录"改"探针+降级（在位）；tscon/自动登录=人工配方（自动恢复未实现）"。
- **SECURITY-GOVERNANCE :190**"审批记录包含…预览内容哈希"裸列举 → 加"（当前服务端侧恒空、绑定批6 在建）"内嵌限定（A5 同族回潮点）。
- **REQUIREMENTS.md :85 NFR-510**"强制 TLS + bearer token + Origin 校验"→ 保留需求目标态 + 括注"Origin 校验为需求目标态、代码未实现/规划项，实况口径见 SECURITY §2"（需求规格与实现现状两层分离，2026-10-08 旧审计 PM-02 早已点名此矛盾）。
- **REQUIREMENTS.md :77 NFR-502**"会话挂起自动检测并恢复"：检测✅恢复❌——同族，但 NFR 表为需求口径非能力宣称，且恢复三件已由 ARCHITECTURE §6.3/SECURITY §5.4 双点订正覆盖；为防守卫误判已加限定词模式统一，NFR-502 行未改（登记为设计决定，若主理人认为需加注可一行补）。

### D13 新守卫 tests/unit/phase3-skill-claims-guard.test.js（完成）
- 纯 node stdlib、零 import 被测包、只读文本。11 例 4 组：
  - **批0-a**：skills/**.md 全部 ≥3 段点分 token ∈ definitions.ts 注册 id（动态派生，≥50 自检）∪ 白名单。白名单逐类注释：pm2 穷举 4 串照抄（agent.providers.workbuddy.options.endpoint/preview.params.permanent+tunnel.state.json+health.logging.degraded）+卡片谓词 approval.preview.params+config.yaml.bak（文件路径类）+宿主桥 a2a.* 五件（tools.ts 真实注册名）+⑥类未注册设想能力四串（app.default.manage/app.process.activate/gui.browser.control/storage.volume.destructive——**并强制出现行同行带"未注册/规划"限定词**，双保险）。
  - **批0-b**：`__approvalId`/`hostApproved` 治理面（README/overview/06-OVERVIEW/GATE-POLICY/docs-02-design/skills）出现行必带"批1/在建/不可达/不可依赖/否定式/一次性删除/人工/回滚/历史留痕(根因|旧|~~)"口径词 + K5 状态行钉已落地口径。
  - **批0-c**：session-guard/`Origin 校验` 同理（未实现/规划/零命中/订正/批X/~~/人工）+ previewHash 行必带"批6/在建/为空/恒''" + E-1 两键"限定/封顶/授权/强制"承诺形态行必带"尚未接线/在建/§2.3/声明"。
  - **批0-d**：判据灵敏度变异自证（内存注入三变异体必须落入口径词正则的"不含"分支 + ⑥类现存在场行正面自证）——防守卫空转。
- **红线自检**：`grep -in` 被禁扫描词 = 零命中（文件命名/内容/判据全部走点分 token+中文口径词路线，与该词族零交集）；phase2-snapshot-truth 复跑 17/17 绿互证。

### D14 判据活性自证（完成）
- REPO 现态：`node --test tests/unit/phase3-skill-claims-guard.test.js` → **11 pass / 0 fail**。
- 改前仓库副本自证（$HOME/wbtmp/p3b0-red：git ls-files 844 文件全量按 HEAD 版本重建 + 拷入新守卫）→ **6 fail / 5 pass**，红项恰为 b×1+c×4+K5 状态行×1——**每个判据族都在改前态判红，活性实证**；a 族在改前也绿（pm2 穷举=工具名层零例 的正面结论一致，a 是防未来回潮的基线锁）。全程 REPO 零污染。
- 回归面（只跑与本文本域交叠件，逐文件）：r1-approval-card 69/69、host-adapter 35/35、deploy-shared-skills 8/8、phase2-snapshot-truth 17/17、phase2-dead-config 14/14、phase2-dep-direction 32/32、phase2-contract-schema 23/23、phase2-session-unknown 48/48、audit 25/25、policy 25/25、p0-path-traversal 87/87、phase2-bearer-selfcheck 45/45、phase2-inner-credential 38/38、r19b-s1 35/35、r19b-s5 39/39 —— 全绿。
- **r3-uninstall-verify 2 fail 与批0 无关**：断言对象=psmod/app.ps1（批2 在飞 M 文件，git diff 104+行），属并行棒中间态；我域零涉及，不动不修（报主理人知悉）。

### ② grep 终检结果（自证）
- 旧承诺词现在时残留=**0**：`session-guard 保活：自动登录`（仅存于本 notes 引文）、`Origin 校验`未限定行（仅存 docs/design/*.html 与 docs/audit/** 历史归档——均非我所有权域，HTML 记入移交）、`powershell/<domain>|registry/<domain>.ts`（仅本 notes+audit 归档引用）、`sort | tail -1`（README 新句内以"旧句式"引述在场+audit 归档）、`available == capabilities.count` 门禁形态（仅 pm2 归档引文）。
- 新口径在位：批1 在建口径 5 文件命中、批6 在建 SECURITY×2、规划项·未实现 ARCH6+README2+SECURITY3 处。

### §9 移交（终版）
- **N3（packages/** 域，批2/主理人）**：失实承诺族剩余两处现在时承诺在源码内——`vm-service/src/server.ts:1213` inputSchema `__approvalId` description"审批通过后用于续跑执行"与 `:1361` instructions"风险等级 L2/L3 需先取 approvalId 再续跑"（P0-1 台账"四处文档"之代码面两处，批0 台账点名"随批0 一并订正"但文件在批2/独占域，我禁碰）。建议同批1 CL 一并改口或即改两句文案。
- **N4（docs/05-peripherals/** 域外 3 处 E-1 话术）**：DEPLOYMENT.md:279（"宿主显式 maxRisk 授权"）、SCENARIOS.md:144-145/:210-211（示例携带两键无现状注）+SPEC-SKILLS:124-125 已在我域改口，此三处文件所有权在批2（docs/04-ops/**… 05-peripherals 未明列任何棒清单——保守移交主理人裁定归属）。
- **N5（docs/design/winvm_connector_plan.html:163）**：Origin 校验现在时宣称在 HTML 设计稿（非我域），低危（历史设计稿），移交登记。
- **N6**：overview.md 头注无 .superseded 前向指针（J-3 建议项的第二方案，已采"当前态括注订正"方案，K-20 全篇标记未做——若主理人欲彻底化可加一行 superseded 头）。
- **N7（环境观察）**：批2 在飞导致 r3-uninstall-verify 暂时 2 红（见 D14），非缺陷、勿在批2 收官前引用该件红为证据。

### 状态：批0 A1–D14 全部完成，待主理人独立核验统一提交。

### N4 收口（主理人批准，2026-10-13 续轮）
- **DEPLOYMENT.md:279**：L3 行"需审批 + 宿主显式 maxRisk 授权"→"可声明 maxRisk（声明记录于审计链、执行面尚未接线＝批1 在建，不是已生效授权闸，指针 SECURITY §2.3）"，与 SPEC-SKILLS:124-125 已改措辞同款。
- **SCENARIOS.md 两处示例**：亲验服务端真实装配=a2a-framework/server.ts:244-271 从 `params.metadata` 解析两键（INTERFACES §3.4 示例亦 metadata；:264 行 context 由 message.metadata **派生**）⇒ 旧示例独立 key `"context"` 系**契约漂移**（照做恒被忽略——两键根本读不到）。按实况订正 `"context"`→`"metadata"`（C 场景 :144-145、D 场景 :210-211 含 imageRef 同迁），每处附 E-1 现状注（声明+留痕、批1 在建）+ 订正机读指针。**改判登记**：此 key 名订正超出"N4 仅话术"字面，但属同一失实族（示例承诺的调用形态服务端不消费），且与批0"宣称-实现一致性"验收判据直接冲突，故按实况收口；代码零改动（packages/** 未碰，imageRef 全仓 src 零消费——仅示例形态修正，未宣称其在位）。
- 附带修复：首轮编辑曾把 C 场景代码块围栏打断（双 ```jsonc 嵌套），复验 fence 计数=28（偶）+ 块内容逐行回读确认已复原。
- 守卫复跑：11/11 绿（05-peripherals 不在守卫扫描面，改动不与判据交叠）。
- N5/N6 遵裁不做（历史归档不回写，K-20 同族）。
### 终态：批0（含 N4）完赛。
