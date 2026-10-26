# P2-T9 设计定稿（工程师侦查后落盘，2026-10-12）

## 0. server.ts 组装链结论：**spread/透传形态 ⇒ 本批零改动，无需主理人裁断**

- `/health.session` 透出点：`buildHealth()` return 对象里 `session,`（server.ts:1981）——
  **整对象引用直传**，非逐字段白名单。SessionHealth 新增可选成员自动随 JSON.stringify 透出。
- `/health.llmSession` 透出点：`...(llmSession !== undefined ? { llmSession } : {})`（server.ts:2026）——
  **spread 透传**，`llmSession = provider?.llmSessionHealth?.()`（:1939）同步取 `snapshot()` 返回值整对象。
  LlmSessionHealth 新增观测键同样自动透出。
- ⇒ 符合设计预期（任务书："默认期待组装为 spread 形态零改动"）。**server.ts 本批只读，未动一行。**

## 1. E-2：SessionHealth +probeError?/probeErrorCode?（纯附加）

### 1.1 契约形状（packages/contracts/src/bridge.ts SessionHealth 区 :38-47）

```ts
export interface SessionHealth {
  /* —— 既有七字段逐字不动（interactive/locked/blackScreen/state 保持必填）—— */
  readonly detail?: string;
  /**
   * P2-T9（E-2 · 纯附加可选）：探针**未能得出结论**时的一次性事实描述。
   * 在场 ⇒ 本报告其余布尔字段是保守兜底值（fail-closed 填充），不是观测值；
   * 缺席 ⇒ 结论真实（旧形状逐字节）。
   */
  readonly probeError?: string;
  /** P2-T9（E-2 · 纯附加可选）：probeError 的稳定机读码（首批三码，见 1.2）。 */
  readonly probeErrorCode?: string;
}
```

### 1.2 probeErrorCode 语义边界（三码，逐点对应假值制造点）

| 码 | 制造点 | 触发条件 |
|---|---|---|
| `PROBE_TIMEOUT` | `vm-service/src/health-probe.ts timeoutSessionSnapshot()` | 会话子探针在短超时（默认 5000ms）内未应答 |
| `PROBE_EXCEPTION` | `vm-capabilities/src/index.ts PsBridgeSessionProbe.probe() catch 分支`（:50-61） | ps-bridge 调用抛异常（未就绪且自愈失败等） |
| `PROBE_NOT_WIRED` | `core/src/session/health.ts UnavailableSessionProbe.probe()`（:18-32） | 非 Windows / 探针未接入（设计 §3.3 点名的三处病灶之一，侦查裁定纳入：它同样是"被迫填假值"点，E-2 闭环不应留角） |

- 语义 = **「探测失败」与「探测成功且确非交互」从此可区分**：运维看 probeError 在场即知应查探测通路，
  而不是查会话配置。
- 值形态：`probeError` 一句话（含原因/时限），`probeErrorCode` 大写下划线枚举串。两键**成对出现**
  （三处制造点都同时给），但契约上各自独立可选（`probeErrorCode` 无 `probeError` 时禁止单飞——测试 D/C 组钉）。
- **不做**的事：`interactive` 不改三态（设计明令）；`state` 枚举不扩 'unknown'（会破 SessionState 跨包消费面，
  且 fail-closed 方向 state='unavailable' 已正确表达「无结论」）；detail 既有文案**逐字保留**
  （probeError 是旁边新增的第二信号，不是对 detail 的替换——旧读者零影响）。

### 1.3 isGuiAllowed 行为钉（PR8 红线）

`core/src/session/health.ts:41-43` 判据行 **一字不改**：

```ts
export function guiAllowed(session: SessionHealth): boolean {
  return session.state === 'healthy' && session.interactive && !session.blackScreen;
}
```

只在该函数上方加判据注释（probeError 在场恒 false 的三重冗余证明：三条失败路径 state 都落
非 'healthy' ⇒ 合取首项即短路；即使未来有人把某失败路径 state 改错，interactive:false 仍兜底；
probeError 本身不进判据——判据零改动即行为零放宽，这本身就是最硬的钉）。

新测试 B 组矩阵钉：`probeError × {interactive:true,false} × {blackScreen:true,false} × {locked 组合}`
全组合恒 false（含人造 state:'healthy'+probeError 在场 的防御性组合——判据不读 probeError，
healthy+interactive:true+非黑屏的**人造矛盾体**仍旧放行，这恰证明"行为一字未改"；
真实三处制造点永不产出该组合，A 组另钉）。

### 1.4 三处改造点的形状规则

- 探测成功：两键**缺席**（不写 `probeError: undefined`——键缺席与值为 undefined 在 JSON 层面不同，
  测试用 `Object.keys` 钉死缺席形态=逐字节旧形状）。
- 探测失败：既有字段值**逐字不变**（sessionId:0 / '' / '' / interactive:false / locked:false /
  blackScreen:false / state:'unavailable' / detail: 原文案），只**追加**两键。fail-closed 方向零变化。

## 2. E-1：LlmSessionHealth +firstCallLatencyMs?（冷启动度量位）

### 2.1 形状定稿

`packages/contracts/src/bridge.ts LlmSessionHealth`（:73-90）末尾纯附加：

```ts
  /**
   * P2-T9（E-1 · 纯附加可选）：**首个真实委派轮**（runTurn）从入口到本轮 settle 的毫秒数。
   * 缺席 = 服务启动后尚未发生首调（含仅预热未投喂的窗口）。一次性采样，后续轮不覆盖。
   * 度量语义（设计 §5.1：只度量不优化）：
   *  - ≤ readyTimeoutMs ⇒ 首调到达时会话已 ready ⇒ **预热命中**；
   *  - ≫ readyTimeoutMs ⇒ 首调付了完整进程级冷启动（auth probe + agent 端点 ≈75–107s 量级）⇒ **冷启动发生**。
   */
  readonly firstCallLatencyMs?: number;
```

### 2.2 为什么选这个形状（侦查现状后的裁断，任务书授权自定）

- 备选「warmup 命中标记（boolean）」被否：二值信息量低，且「命中」需要定义（init 先到？result 先到？），
  引入跨方法时序假设；延迟数值**天然蕴含**命中信息（阈值比较）且额外给出冷启动深度分布。
- 备选「firstCallAt（时间戳）」被否：/health 已被 idleMs 类"相对时长"口径占主导，时长比时刻可直接对账
  `WINVM_LLM_SESSION_WARMUP_MS`/`readyTimeoutMs` 两个既有旋钮。
- 采样点：`runTurn` 已有 `started = this.now()`（:608），首调 settle 时（含 unavailable 终局——
  首调即使降级单次 -p，其常驻路径耗时同样反映冷度）记录一次。`ensureReady` 在预算内，
  所以**首调耗时 = 预热是否兑现的体验真相**，一个数即可导出设计要的两个率（跨多次重启聚合）。
- 实现约束：不动 spawn/init/状态机路径；纯观测；`restartFresh()` 不清零
  （它度量的是「服务生命周期内的首调」，运维复位不是服务重启——保守口径，理由写进注释）。

### 2.3 消费面

`snapshot()`（persistent-session.ts:274）末尾追加条件展开；server.ts 组装自动透传（见 §0）；
无静态守卫消费 LlmSessionHealth 的成员集（grep `Object.keys.*snapshot`/`deepEqual.*snapshot`：
kn1-d 的 deepEqual 消费的是**测试内联 fixture** `health()` 构造物，与真实 snapshot() 无关）。

## 3. 文档口径升级（K-20 划线诚实化 + 改前 grep 结论）

**grep 结论（守卫输入面核查）**：
- 字串「仅 state==='healthy' 才有意义」**从未落地**到 HOST-A2A-BRIDGE.md / health.ts（audit-2026-10-08
  B4 行实测"全仓 grep 未见 ⇒ 仍为裸 backlog"）。它现存于 docs/archive/changes/CL-020、docs/audit、
  docs/archive/changes/phase2-arch-design（均为历史登记件，**不是**本批可改的活文档，不回改）。
  ⇒ 所谓"升级"= 把这条**从未兑现**的临时口径，以正式判据形态落地到活文档，
  并在 CL-020 历史件旁不碰（K-20 的历史件本来就是划线对象）。
- 静态断言消费核查：`snapshot-truth` 白名单守卫要求含 "snapshot" 字样的 src 文件集恰=12 ——
  我的措辞**避开 "snapshot" 词**（用「快照」/「观测项」）；SECURITY 反证守卫要求
  before/after 行必须同行带信息性口径 ⇒ 新文档行**不写** before/after 字样。
- HOST-A2A-BRIDGE.md / INTERFACES.md 无任何测试读取其文本（grep 结果里的命中全是断言消息字符串或
  注释引用，不读文档文件）⇒ 文档编辑零红险。

**改动清单**：
1. `docs/02-design/SECURITY-GOVERNANCE.md` §5.3 表下追加口径行（探测失败≠会话不可交互，probeError 判据）。
2. `docs/02-design/INTERFACES.md` IF-6 样例后追加 probeError 字段注。
3. `docs/02-design/HOST-A2A-BRIDGE.md` §8 测试与验证追加 P2-T9 判据登记行（该文档无 /health.session
   专节，诚实登记在验证面）。
4. `packages/core/src/session/health.ts` guiAllowed 上方判据注释（§1.3）。
5. `packages/contracts/src/bridge.ts` SessionHealth 区新增成员文档注释（§1.1）。

## 4. 新测试 `tests/unit/phase2-session-unknown.test.js` 组结构

- **A 组 probeError 形态**：timeoutSessionSnapshot 两键在场 + 假值逐字不变；raceSessionProbe 超时/
  reject 路径两键在场；PsBridgeSessionProbe catch 路径（注入 reject bridge）两键在场；
  UnavailableSessionProbe 两键在场；三制造点码值钉；成功路径两键缺席逐字节旧形状。
- **B 组 isGuiAllowed 恒 false 矩阵**（PR8）：probeError×interactive×blackScreen 全组合 + locked 组合 +
  四态 state 枚举；判据函数与 guiAllowed 双钉；「healthy+probeError 人造矛盾体」行为与 HEAD 逐字一致的
  防御性钉（证明判据不消费 probeError ⇒ 无从放宽）。
- **C 组契约纯附加**：bridge.ts 源文本 SessionHealth 块内 interactive/locked/blackScreen/state 仍必填
  （非 `?:`），两新键 `?:`；probeErrorCode 不脱离 probeError 单飞；旧消费方读旧字段零变化。
- **D 组冷启动度量**：PersistentCliSession 注入确定性时钟 + FakeChild（照 cl018 范式）：
  从未 runTurn ⇒ firstCallLatencyMs 缺席；首调后 = 精确毫秒数；二调不覆盖；unavailable 首调同样计。
- **E 组文档判据在位**：三处文档新行 grep 在场（判据自指登记范式，对齐 snapshot-truth §④）。

## 5. 执行序与对账

基线=90 文件/1809 例（qa/r19/t8-sweep-result.txt 口径）；新增 1 文件 ⇒ 预期 91 文件/1809+Δ 例。
server.ts / engine.ts / contracts 的 T5/T7/T8 区（SecurityHealth :142 / TasksHealth :193 /
approvalTruth :266 / ApprovalTruthAttribution :449）**逐字零触碰**（只动 :38-47 SessionHealth 块尾
与 :73-90 LlmSessionHealth 块尾，两块与禁区之间隔着 ProviderState/CL-018 段落，物理不重叠）。
