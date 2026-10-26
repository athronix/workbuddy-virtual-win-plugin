# Phase 3 批1 · 审批闭环 P0-1 专项 施工记录（主理人齐活林直接实现）

> 任务：台账 §5 批1 行处方——出路(c) 策略化 + maxRisk/allowedCapabilities 双闸接线（同一 CL）
> + A2-1 早退审计顺带 + E-2 挂起语义对齐 + F-1/F-2/F-3 三项硬前置。
> 验收判据（台账原文）：① L2 能力批准→续跑闭环测试用例存在且绿；② maxRisk:L1 委派下 L2 步
> POLICY_DENIED 实锤；③ allowed 白名单外能力 DENY 实锤。
> 提交链：531ec01(CL1) → f7d80ff(CL2) → 7096166(CL3) → fd60050(CL4/CL5) → 本 CL6(收口)。

## §1 设计裁决与中途修正（过程留痕，防"为什么长这样"失忆）

1. **F-3 判源两次收紧**：初版「缺席视为声明从严」被推翻——旧版宿主桥对未声明也恒发
   回退 defaultMaxRisk（L1），"缺席=声明"接线瞬间=全部 L2/L3 委派封顶 L1=以修复名义
   引入新 P0（F-3 预警原案成立）。终版：仅 `maxRiskSource==='agent'` 为声明
   （宿主桥显式打标，旧桥/回退一律非声明）⇒ **零断崖由判源构造保证**，不靠灰度兜。
2. **src=vmagent 传输层身份标方案作废并全量回退**：曾设计给 VM 回连端点拼 `?src=vmagent`
   做通道判据，实证会触碰 `buildMcpConfig` LEGACY_OUT 逐字节回归护栏（38 处断言面，
   QA 红线）。终版通道判据=**纯服务端事实**：`ctx.delegationId(dtid) ∨ 协调器活动委派槽
   getActiveTaskId()`——与 raise 的 input-required 挂接读同一份事实，不新增串台面；
   误判方向 fail-safe（直调撞并发 turn 窗口⇒被当内层=逐字旧行为，绝不放宽放行）。
3. **provider.execute 不收 scope feed**：曾把 scope 透传进 LLM provider 的 execute，
   与 shadow「服务层降级放行+provider 再拒」自相矛盾 ⇒ 执法单点定在服务层
   evaluateScoped；deterministic 的 in-process 评估（第三调用点）自带接线（step 仅 on 态
   喂 goal 声明值，shadow 观测归服务层，两处计数不分裂）。
4. **判据下沉 core/policy-gate.ts**（依赖方向铁律：adapter→vm-service 非法），
   vm-service/policy-gate.ts 改再导出垫片（对齐 approval-hash 双端单源打法）。
5. **E-2 取最小诚实收口而非挂起双链路**：deterministic provider 全仓零 coordinator
   引用（raise 唯一生产点在 LLM 桥）⇒ 给它新建挂起链路=在触闸面为零的路径上引入第二套
   审批实现，超批1 半径。终版=命中审批闸的 error.details 纯附加显形
   （suspendSupported:false + nextActions 两条真实出路），完整挂起对齐登记 backlog。

## §2 交付明细（按提交）

### CL1 `531ec01` 装配单源化+来源标记（硬前置）
- framework `buildGoal` 单源（send/stream 共用，流式补 allowedCapabilities/context
  ——A2-19 结构性消除）；`maxRiskDeclared` 契约字段（展示值与声明性解耦）。
- 宿主桥 maxRiskSource 打标（'agent'|'host-default'）两路 client 透传。
- 回归 `p3-b1-goal-assembly.test.js`（7 例：流式同形/两路逐字段一致/来源四态/防再漂移钉）。

### CL2 `f7d80ff` (c) 收口 + F-2 scope 留存 + 双闸三调用点
- 新契约码 `DELEGATION_REQUIRED`（retryable=false）。
- `delegation-scope.ts`：双键索引（traceId/taskId）+ 精确查找无模糊匹配 + 终态销账
  + TTL(复用 WINVM_APPROVAL_TTL_MS)+容量(256) 双有界；observer accepted 注册（仅声明
  两元组）/terminal 销账（input-required 不销）。
- handler：`evaluateScoped` 单点（off 不喂/shadow 评估改道计数/on 执法）；纯直调命中
  审批闸 ⇒ (c) 收口 + recordPolicyDeniedAudit 入链（matchedRule=policy:delegation-required）；
  内层 token 留存 scope ⇒ 重放用留存值复评（批什么执行什么的外延）。
- 回归 `p3-b1-policy-gate.test.js`（19 例）：纯函数真值表/scope 表行为面/引擎端到端
  实锤②③/F-3 零断崖行为面/装配源码钉。

### CL3 `7096166` 第三调用点 + E-2
- deterministic：构造函数读 wiring；step 仅 on 态喂 goal 声明值；execute evaluate 补两键。
- E-2 APPROVAL_REQUIRED 分支 augment details（判别性测试锁死硬拒路径零漂移）。
- +5 行为例（真实引擎）+⑥ 源码钉。

### CL4/CL5 `fd60050` 观测块 + 文档族终态
- /health.policyGate 四元组观测；scope 兜底清扫并入令牌定时器。
- server.ts 两行"在建"代落文案 + 治理面 8 文档全部"已落地"口径（claims-guard 全绿，
  残留=0）；smoke 审批用例双态化，离线真服务 16/16 绿（(c) 行为级实证）。

## §3 验收判据对照（可证伪）

| 判据 | 状态 | 证据 |
|---|---|---|
| ① L2 批准→续跑闭环用例存在且绿 | ✅ | 既有委派闭环（k4/k5/a5 面 204 例零回归）+ smoke 内层形态 APPROVAL_REQUIRED+approvalId 判别对照 + (c) 直调收口行为级实证 |
| ② maxRisk:L1 委派下 L2 步 POLICY_DENIED 实锤 | ✅ | p3-b1-policy-gate ③ 引擎端到端 + ⑤ deterministic 行为面（真实 CorePolicyEngine，零桥调用） |
| ③ allowed 白名单外能力 DENY 实锤 | ✅ | 同上「白名单外 DENY」+ 通配命中放行下一闸判别 |
| 零断崖（F-3） | ✅ | 行为面「不喂 scope ⇒ L2 照旧走审批闸」+ 判源构造（仅 agent 声明）|
| (c) 判别性（委派不误伤） | ✅ | isInnerDelegation 真值表 + smoke 双态对照 + (c) 独立开关 off 回滚位 |

## §4 遗留与 backlog 增补

- **双闸缺省 shadow**：升级窗口观察 `/health.policyGate.shadowHits` 归稳后运维显式
  `WINVM_POLICY_GATE_WIRING=on`（文档已写明）；真机观察件清单并入批5 窗余项。
- **E-2 完整挂起对齐**（deterministic 真挂起 input-required）：触闸面为零 ⇒ 登记 backlog，
  不再列批1 欠账。
- **on 态真机端到端**（声明 L1 打 L2 实锤拒 + shadow 命中观测）需真机窗，V17 在册。
- **批1 受契约保护守卫同步（CL6）**：①`assembly-guard` S-4 计数 2→3——(c) 收口是新增
  终态拒绝点、同守 S-4"终态拒绝必入审计"纪律补第三处注入（守卫原文即授权"新增注入点⇒
  同步本守卫计数"，`if (!verdict.allowed)` 块计数仍=2 不变）；②`phase3-b6-preview-hash-binding`
  顺序钉锚点 `policy.evaluate`→`evaluateScoped`（语义逐字不变：拒绑赋值仍须早于紧随其后的
  策略评估，仅调用收拢改名）。两处均在 gate 红项定位后按判据实况修（非放宽）。

## §4b A2-1 早退审计收口（CL7）

台账 A2-1 点名 5 处终态拒绝零审计，逐处核后**三分补、二分不补**（各有据）：

| 处 | 现场 | 裁处 |
|---|---|---|
| executeCapability PROVIDER_UNAVAILABLE | 真盲区 | ✅ 补注入 matchedRule=`runtime:provider-unavailable`（收口①） |
| replay CAPABILITY_NOT_EXPOSED | 真盲区 | ✅ 补注入 `replay:capability-not-exposed`（收口②） |
| replay UNKNOWN_CAPABILITY | 真盲区 | ✅ 补注入 `replay:capability-not-registered`（收口③） |
| runGoal 入口 PROVIDER_UNAVAILABLE | **非盲区** | ❌ 不补——delegationObserver 的 delegation.complete 条目已带 errorCode 入链，双写=胀链 |
| raise no-active-task | **现实不可达+warn 在位** | ❌ 不补——批1 后委派桥 raise 必带 req.taskId（Fix-1B），早退仅剩协调器未 bind 的装配事故形态，该形态由 A5-m5 变异守卫钉住；warn 面 P1-Fix 已补 |

- 三处注入对齐 S-4 纪律：`void` best-effort（审计失败不改早退语义）、channel 按
  delegationId 归因（'a2a'/'mcp'）。
- `assembly-guard` S-4 调用计数 3→6（两 allowed 块各 1 + handler (c) 收口 1 +
  executeCapability provider 缺席 1 + replay 两处 2；`if (!verdict.allowed)` 块计数
  恒=2 不变）；变异探针 m1b 改指 handler (c) 收口注入（全文序位 4），标签同步实名。
- 回归：p3-b1-policy-gate ⑧ 段新增 1 例（三 matchedRule 实名钉）⇒ 26 例全绿。

## §5 过程教训（固化）

1. **QA 逐字节守卫=改动面的先验边界**：src 标记方案写了一半才被 phase2-inner-credential
   /r19c-kn1-b 的 LEGACY_OUT 拦住——动传输/配置形态前先 grep 断言面，可省一整轮返工。
2. **"缺席视为声明从严"是伪 fail-closed**：从严方向若打在缺省路径上=可用性事故；
   判源必须区分「谁的声明」，与 K4 不记名令牌同一条信任线。
3. **执法单点纪律**：同一 scope 在服务层与 provider 层各评一次 ⇒ shadow 语义分裂；
   跨层透传裁决值（seg.verdict）或单点评估，不双写。
