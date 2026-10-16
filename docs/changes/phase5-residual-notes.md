# Phase 5 残项完善 · 代码面施工记录（R1/R2/R3，2026-10-16，工程师 Alex）

> 范围纪律：全程仓库离线面，未碰 VM/SSH/隧道/deploy。psmod 面无改动（R1 选 Node 拦截；R2 只读分析）。
> 分笔：`7d80416`(R1) / `3a3d81f`(R2) / `3020b2a`(R3) + 本收口笔。只 commit 未 push。

## R1 · `meta.capability.list` 名实对齐（B-4，P2）——**方案 A（Node 侧拦截）**

### 选择理由
1. **拦截链现成**：D5 `meta.health.check` 先例（`adapter-agent-workbuddy/src/index.ts` execute 内 `impl.module==='__meta' && impl.fn==='healthCheck' ⇒ buildHealthSnapshot()`，不经 bridge.call）就是注册表 `__meta` 能力的 Node 侧分派面，扩展成本=一个三元分支+一个私有方法。
2. **description 兑现零改写**：「列出当前已注册并暴露的能力清单」在方案 A 下逐字成真；方案 B（改 description 迁就 psmod 现状）是把名实落差永久化。
3. **暴露面语义同源**：provider 直供集 = `WINDOWS_CAPABILITIES ∩ declareCapabilities()`，与服务端 `exposedCapabilities = registry.intersectDeclared(provider.declareCapabilities())`（server.ts:718，registry 由 `registerAll(WINDOWS_CAPABILITIES)` 构建，server.ts:579）同算法同数据源 ⇒ 与 MCP `tools/list` 逐条一致，兑现 SKILL 面「以 tools/list 为权威」口径。三 provider（deterministic/llm/hermes）`declareCapabilities` 六域通配逐字相同，且 llm/hermes `execute` 均委托确定性执行器（`executor.execute(req)` 单点）⇒ 拦截对全 provider 生效成立；此假设由新钉 A5 静态防漂移（未来收窄声明即红，不许静默失真）。
4. **degraded 面反而更强**：旧实现经桥应答（ps-bridge 挂了拿不到）；Node 直供零桥往返零会话依赖。原「degraded 时返回模块名列表」本就无暴露面语义，无兼容价值损失。
5. **psmod `listModules` 分支保留不动**（内部诊断面，rawCall 面可达），符合任务书"保留"要求。

### 前后对照
| 面 | 前 | 后 |
|---|---|---|
| 注册表绑定 | `__meta.listModules`（definitions.ts:112） | `__meta.capabilityList`（B-4 注释随迁，healthCheck 注释体例） |
| 应答来源 | ps-bridge.ps1:173-178 扫 `*.ps1` 文件名 | provider `buildCapabilityList()`（注册表直供，零桥往返） |
| 返回形态 | `{ok, modules:["app","appops","gui","storage","system"]}`（不含 meta） | `{ok, count, capabilities:[{id,name,risk}]按id升序, domains:[…含meta]}` |
| description | 承诺与实不符（名实落差） | 不改一字、逐字兑现 |
| 测试登记 | psmod-contract `NODE_BUILT_IN_META={healthCheck}` | 扩员 `{healthCheck, capabilityList}`（受契约保护变更登记：绑定变更即 ps1↔注册表映射变更，注释同步实况） |
| SKILL×4 | 「以 tools/list 为权威，或先 capability.list 自检」 | 同句补括注「B-4 后由 Node 侧注册表直供，返回 …capabilities…，与 tools/list 同源一致」 |
| real-test.md TC-MCP-02 | 判据=data.modules 5 域名数组 | 期望/判据改新形态 + **回退判据**（旧形态=未随部署生效的显形，非缺陷）——主理人真机窗照单复验 |
| RELEASE-NOTES §三-4 | 已知限制在册 | 划账为已修（生效=下次 deploy-vm+服务重启，Node 面同样受部署节奏约束，如实标注） |

### 新钉 + 复跑
- `p5-r1-capability-list-pin.test.js` **17 例**（A1 绑定与 description 兑现 / A2 形态与零桥往返 / A3 与注册表全集逐条一致+排序稳定 / A4 拦截定向性+诊断分支在册 / A5 三 provider 通配防漂移+委托面 / A6 SKILL 口径句回潮防线）。
- 触及面复跑（逐件、非 glob）：psmod-contract 7、cl017 12、cl017-param-guard 10、cl017-param-value 34、r3-uninstall-verify 39、phase2-mcp-signal 54、phase2-contract-code-fidelity 22、phase2-contract-schema 23、phase2-snapshot-truth 17、p3-b1-policy-gate 29、phase3-skill-claims-guard 11、p4-b9-errcode-registration-pin 12、phase3-b2-deadlink-fix 6、r19b-s5-write-allowlist-pairing 39、r1-approval-card 69、host-adapter 35——**全绿**。

## R2 · V19 离线判据分析（不改实现）→ `docs/audit/2026-10-16-v19-analysis.md`

摘要（全文见该档）：
- **核心发现 C0（排序第一）**：批13 登记「seq26 ok=true（K6 语义=exit0∧核验过）」的等式**不成立**——Node 全链 `res.ok`（信封=「成功调用」）与 psmod 回执 `data.success`（K6=「核验通过」）之间**不存在任何折叠点**（server.ts / approval-replay / mcp-framework / 三 adapter / ps-bridge.ts 全文 grep `success` 零命中）；`uninstall-final.json` 自身即旁证（完成步是 `appops.workflow.run` 合成步骤，恒 `ok:true`，无 success/verified 一键）；审计链只落 summary、receiptCache 重启即失 ⇒ 当次真值不可追，只有真机复采 S4 能定性。
- **三态判据空真通道**（app.ps1:599-678 摘录）：`$root` 派生不出 ⇒ `exeGone` 恒初始 true、`dirGone=$null` 不阻断；「键从未匹配到」与「键已消失」同为 `registryGone=true`。portable 合成键 `UninstallString` 回指 winget 时反推 root=winget 客户端目录（核验对象错位，H1）；双登记残留（H2，installDate=20260921 未变是其指纹候选）。
- **候选排序**：C0 > H2 ≈ H1 > H3（半卸载+查不到互斥倾向，弱）> H4（时序/缓存——`Get-InstalledApps` 现扫无缓存，离线可基本排除）。
- **真机采集清单 S1–S8**：SSH 只读探针（三 hive 全枚举 `*ripgrep*`、WinGet\Packages/Links 存在性）+ MCP 直调拿全量 data 落盘（dryRun 预览钉形 → 真卸载全量回执 → 即时复检 → 复原+秒回定性 → 0/5/30s 三点采样钉 H4 → 链上对照）；每步给期望读数与判据分叉表；最小伤害=标的 ripgrep 可再卸载+install 复原（批13 已证复原通路），winget 动作一律走服务层（SSH 直调 winget 结构性不可用，residual-realwindow V3 节）。
- **后续处置预案**：C0 实锤 ⇒ 转呈面立项（success=false 改判摘要+residualEvidence 进回执，属行为改动走契约流程）；H1/H2 ⇒ app.ps1 核验对象修正议题（离线钉先行）。

## R3 · ssh2-resolve skip 档（B-8 轻处置）——**补可跑例，skip 语义保留**

- 亲读确认：2 例恒 skip 的判据=「本机 node_modules 可解析 ssh2 ⇒ 裸 import 优先命中 ⇒ ④ 全失败分支不可达」（仓内 ssh2 实装，本环境必跳）；GATE-POLICY K-1 明文「2 skip 是既有权威口径不得当回归」——MEMORY 基线行同口径（「2 skip 恒 ssh2-resolve OFFLINE_SKIP」）。
- 处置=任务书首选路：skip 判据**可离线确定性注入**——把被测源逐字节复制进无仓库祖先的 mkdtemp 目录、`file://` 动态 import，复制体的裸 `import('ssh2')` 与 `createRequire(import.meta.url)` 双路确定性失败 ⇒ ④ 必达，补 2 个**可跑**例（三要素错误形态 + 修复动作文案面），各带「复制体视角不可解析」前置自证防假守卫；两例独立 tmpdir（隔离 ESM URL 缓存）。
- 原 2 例 OFFLINE_SKIP **未动**（真连面守卫语义保留）；件态 10 tests / 8 pass / 0 fail / **2 skip**（skip 计数不变，pass+2）——非为消灭 skip 而假跑，断言对象是复制体真实降级链。
- 注意：全量 gate 下次 sweep 时基线数字将位移（+1 文件 p5-r1 / +2 pass ssh2 件 / r1 件 17 例入列）——**由主理人 gate 亲跑重锚**，本档只记增量。

## 残留（非本窗可闭）
1. **V19 定性待真机**：按 v19-analysis §4 S1–S8 照单采数（主理人窗）；采回后按分叉表对号，再走 §5 预案动刀。
2. **超时树杀 `[k6] TIMED-OUT/[q5]` 分支**：归主理人真机窗（residual-realwindow V3 裁定维持）。
3. **R1 现网生效**：随下次 deploy-vm + 服务重启（Node 面产物同受部署节奏）；TC-MCP-02 已带回退判据可区分「未部署」与「缺陷」。
4. qa/probes/tools.json、qa/evidence/*、qa/r19/* 为历史真机快照（无测试消费、无 pin），不随本次刷新（刷新=伪造历史证据，禁）。
