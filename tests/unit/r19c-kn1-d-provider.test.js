/**
 * R19c T05 · K-N1 委派层审计真实性 —— **D 组：`WorkbuddyLlmProvider.runGoal` 三态拒绝**
 * （设计 `docs/design/kn1-delegation-audit-contract.md` §9-D）
 *
 * 覆盖 §9-D 的 3 条（外加 4 条接线/回归护栏）：
 *   D-1 disabled + persistent=true + 委派（有 taskId）→ `failed(LLM_SESSION_DISABLED)`，
 *       且 **`bridge.runGoal` 零调用**、`shouldDegrade` 不触发（确定性执行器亦零调用）——
 *       这是 §4.1 的核心：**拒绝发生在桥调用之前**，A2A 框架据 `result.ok===false`
 *       收口 `failed`，宿主在 `message/send` 响应里直接拿到原因码（零静默）；
 *   D-2 disabled + `persistent=false` → **不拒绝**，委派正常进 `bridge.runGoal`
 *       （钉死 §4.2「两种部署态可区分」：单次 -p 即设计态没有「disabled=故障」概念）；
 *   D-3 非委派（无 taskId）+ disabled → 行为不变（MCP 直调零回归）。
 *
 * 护栏加值（不属 §9 编号，但同源）：
 *   D-4 拒绝分支**不进** `shouldDegrade`：`PROVIDER_UNAVAILABLE` 本是 D4.4 的降级触发码，
 *       若拒绝结果流入降级分支，确定性模板会把「假完成/不可用」洗白成「降级成功」——
 *       与 `NO_EXECUTION_RECEIPT` 同款边界，源码用「提前 return」而非条件排除实现此语义；
 *   D-5 probe 注入面：ctx 经 cast 读 `delegationProbe`，逐调用下传桥（缺席即桥门 4 透传）；
 *   D-6 `degraded` 事实从桥 `LlmGoalResult` 透传到 `GoalResult`（observer 落
 *       `ext.downgraded` 的唯一来源；§4.4）。
 *
 * 纪律：**不 spawn 真实 CLI**（桥与确定性执行器均以 mock 注入）、不起 HTTP、
 *       **不修改 packages/ 源码**，发现偏差只登记不迁就。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkbuddyLlmProvider } from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const CAP = 'app.winget.uninstall';
const TRACE = 'tr_kn1_d_01';
const TASK = 'task_kn1_d';

/** 会话健康快照（`LlmSessionHealth` 最小可用形状） */
function health(state, over = {}) {
  return { state, restarts: 5, idleMs: 0, ...over };
}

/** disabled 现场态：超重建上限后的典型快照（D11 两信号：state 与 lastError 分离） */
const DISABLED = health('disabled', {
  lastError: 'spawn exit 1（已超重建上限）',
  lastErrorAt: '2026-10-02T02:34:00.000Z',
});

/**
 * 可编程 mock 桥（`LlmBridge` 形状）。
 * 记录 `runGoal` 调用序列与入参，供「零调用 / 调用次数」断言。
 *
 * 注意：用 `hasOwnProperty` 而非解构默认值 —— `session: undefined` 必须表示
 * 「桥**未实现** sessionHealth」（老宿主/Mock 场景），而不是「回退到 DISABLED」。
 */
function makeBridge(opts = {}) {
  const calls = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(opts, k);
  const session = has('session') ? opts.session : DISABLED;
  const persistent = has('persistent') ? opts.persistent : true;
  const result = opts.result;
  return {
    calls,
    lastInput: () => (calls.length ? calls[calls.length - 1][0] : undefined),
    bridge: {
      setSessionConfig() {},
      setSessionLog() {},
      ...(has('session') ? { sessionHealth: () => session } : { sessionHealth: undefined }),
      isPersistentEnabled: () => persistent,
      async runGoal(input, sink) {
        calls.push([input, sink]);
        return (
          result ?? {
            ok: true,
            summary: 'LLM 运行时完成目标：卸载 VM 企业微信',
            artifacts: [],
            steps: [
              {
                index: 0,
                capabilityId: 'appops.workflow.run',
                params: { goal: input.goal },
                ok: true,
                risk: 'L1',
                durationMs: 900,
                traceId: input.traceId ?? TRACE,
                summary: 'LLM 自主规划并执行完成',
              },
            ],
          }
        );
      },
    },
  };
}

/** mock 确定性执行器（`AgentServiceProvider` 形状）—— D-4 用它断言「零调用」 */
function makeExecutor() {
  const calls = { init: 0, runGoal: 0, shutdown: 0 };
  return {
    calls,
    executor: {
      id: 'mock-deterministic',
      displayName: 'mock',
      kind: 'deterministic',
      declareCapabilities: () => ['app.*'],
      async init() {
        calls.init += 1;
      },
      async execute(req) {
        return { ok: true, capabilityId: req.capabilityId, summary: 'mock', data: {} };
      },
      async runGoal() {
        calls.runGoal += 1;
        return {
          ok: true,
          summary: '确定性模板命中',
          artifacts: [],
          steps: [],
        };
      },
      async health() {
        return { ok: true, provider: { id: 'mock-deterministic', state: 'ready' } };
      },
      async shutdown() {
        calls.shutdown += 1;
      },
    },
  };
}

/** 采集日志的 noop logger */
function makeLogger() {
  const logs = [];
  return {
    logs,
    debug: (msg, meta) => logs.push(['debug', msg, meta ?? {}]),
    info: (msg, meta) => logs.push(['info', msg, meta ?? {}]),
    warn: (msg, meta) => logs.push(['warn', msg, meta ?? {}]),
    error: (msg, meta) => logs.push(['error', msg, meta ?? {}]),
  };
}

/** 最小 `BridgeContext`（provider 只用到 config / capabilities.list / logger / cast 读 probe） */
function makeCtx({ probe } = {}) {
  const logger = makeLogger();
  const ctx = {
    config: {},
    audit: { append: async () => ({}), query: async () => [] },
    policy: { evaluate: () => ({ allowed: true }) },
    capabilities: {
      list: () => [CAP],
      has: () => true,
      get: () => ({ risk: 'L1', requiresSession: false }),
    },
    logger,
    newTraceId: () => TRACE,
  };
  if (probe) ctx.delegationProbe = probe; // K-N1：provider 以 cast 读取（非契约字段）
  return { ctx, logger };
}

/** 组装 provider（桥与执行器均注入 → 零进程 spawn）并完成 init */
async function makeProvider(opts = {}) {
  const probe = opts.probe;
  const b = makeBridge(opts);
  const e = makeExecutor();
  const { ctx, logger } = makeCtx({ probe });
  const provider = new WorkbuddyLlmProvider({ bridge: b.bridge, executor: e.executor });
  await provider.init(ctx);
  const goal = { traceId: TRACE, goal: '卸载 VM 企业微信', timeoutMs: 30_000 };
  const sink = { onStatus: () => {}, onArtifact: () => {} };
  return {
    provider,
    calls: b.calls,
    lastInput: b.lastInput,
    execCalls: e.calls,
    logs: logger.logs,
    /** 发起一次委派（默认带 taskId = A2A 委派上下文） */
    delegate: (extra = {}) => provider.runGoal({ ...goal, ...extra }, sink),
  };
}

/* ============================ D-1 disabled + persistent + 委派 → 显式拒绝 ============================ */

describe('K-N1 D-1 disabled + persistent=true + 委派 → failed(LLM_SESSION_DISABLED)，桥零调用', () => {
  test('ok:false + reason=LLM_SESSION_DISABLED + PROVIDER_UNAVAILABLE 错误码', async () => {
    const { delegate } = await makeProvider({ session: DISABLED, persistent: true });
    const r = await delegate({ taskId: TASK });

    assert.equal(r.ok, false, 'K-N1 §4.1：disabled 委派入口显式失败，绝不静默 completed');
    assert.equal(r.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(r.error.reason, 'LLM_SESSION_DISABLED', '原因码是运维可据以走 L1 复位的唯一抓手');
    assert.equal(r.error.retryable, true, '沿用 PROVIDER_UNAVAILABLE 契约默认语义（未硬改）');
    assert.deepEqual(r.steps, [], '未开始执行 → 无步骤记录（拒绝不是「跑完但失败」）');
    assert.deepEqual(r.artifacts, []);
    assert.match(r.summary, /^委派通道不可用：LLM 常驻会话已停用/);
    assert.match(r.summary, /spawn exit 1（已超重建上限）/, 'lastError 如实回显（运维可定位原因）');
  });

  test('bridge.runGoal 零调用（拒绝发生在任何桥调用之前 —— §4.1 入口语义）', async () => {
    const { delegate, calls } = await makeProvider({ session: DISABLED, persistent: true });
    await delegate({ taskId: TASK });
    assert.equal(calls.length, 0, '一次桥调用都不得发生：disabled 委派连降级回合都不进入');
  });

  test('错误 details 如实带 restarts / lastErrorAt（D11 两信号可读）', async () => {
    const { delegate } = await makeProvider({ session: DISABLED, persistent: true });
    const r = await delegate({ taskId: TASK });
    assert.deepEqual(r.error.details, {
      restarts: 5,
      lastErrorAt: '2026-10-02T02:34:00.000Z',
    }, '运维从失败响应即可判断「已自愈几次 / 最后一次何时失败」');
  });

  test('拒绝必发 warn 一条（含 taskId/traceId/restarts）—— 可观测但不刷屏', async () => {
    const { delegate, logs } = await makeProvider({ session: DISABLED, persistent: true });
    await delegate({ taskId: TASK });
    const warns = logs.filter(([lvl]) => lvl === 'warn');
    const hit = warns.find(([, msg]) => msg.includes('LLM_SESSION_DISABLED'));
    assert.ok(hit, '拒绝必须可观测（否则又成「诊断黑洞」）');
    assert.deepEqual(hit[2], {
      taskId: TASK,
      traceId: TRACE,
      restarts: 5,
      lastErrorAt: '2026-10-02T02:34:00.000Z',
    });
  });

  test('无 lastError 的 disabled 态 → summary 不留空括号，details 不带 lastErrorAt', async () => {
    const { delegate } = await makeProvider({
      session: health('disabled'),
      persistent: true,
    });
    const r = await delegate({ taskId: TASK });
    assert.equal(r.summary, '委派通道不可用：LLM 常驻会话已停用', '无可引用的 lastError 时不加空装饰');
    assert.deepEqual(r.error.details, { restarts: 5 });
  });
});

/* ============================ D-4 拒绝不进 shouldDegrade ============================ */

describe('K-N1 D-4 拒绝结果不进 D4.4 降级链（确定性执行器零调用）', () => {
  test('exec.runGoal 零调用：PROVIDER_UNAVAILABLE 不被降级分支洗白', async () => {
    // PROVIDER_UNAVAILABLE 是 shouldDegrade 的触发码之一；若拒绝结果流入降级分支，
    // 确定性模板会把「委派通道不可用」包装成「已降级为确定性执行」→ 静默 completed 复活。
    const { delegate, execCalls } = await makeProvider({ session: DISABLED, persistent: true });
    const r = await delegate({ taskId: TASK });

    assert.equal(execCalls.runGoal, 0, '拒绝分支提前 return，绝不回落确定性模板（§4.3）');
    assert.doesNotMatch(r.summary, /已降级为确定性执行/, '终态不得出现任何「降级成功」措辞');
    assert.equal(r.error.reason, 'LLM_SESSION_DISABLED', '终态原因码仍是拒绝码');
  });

  test('对照：桥自身返回 PROVIDER_UNAVAILABLE 时 D4.4 降级仍照常发生（既有语义零回归）', async () => {
    // 同一错误码、同一降级分支：只有「disabled 入口拒绝」被豁免，桥层失败照旧降级。
    const { delegate, execCalls } = await makeProvider({
      session: health('ready'),
      persistent: true,
      result: {
        ok: false,
        summary: 'codebuddy CLI 不可用（ENOENT）',
        artifacts: [],
        steps: [],
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'CLI 不可用', retryable: true },
      },
    });
    const r = await delegate({ taskId: TASK });

    assert.equal(execCalls.runGoal, 1, 'D4.4 既有降级语义未被 K-N1 改动');
    assert.equal(r.ok, true, '降级后由确定性执行器给出结果');
    assert.match(r.summary, /已降级为确定性执行/);
    assert.doesNotMatch(r.summary, /LLM_SESSION_DISABLED/, '不得与拒绝语义混淆');
  });

  test('对照：桥返回 NO_EXECUTION_RECEIPT（假完成改判）不降级（§4.3 K-N1 边界）', async () => {
    const { delegate, execCalls, calls } = await makeProvider({
      session: health('ready'),
      persistent: true,
      result: {
        ok: false,
        summary: '执行回执缺失：委派回合服务端零活动记录',
        artifacts: [],
        steps: [
          {
            index: 0,
            capabilityId: 'appops.workflow.run',
            params: {},
            ok: false,
            risk: 'L1',
            durationMs: 10,
            traceId: TRACE,
            summary: '委派回合零服务端活动记录，完成声称不予采信',
          },
        ],
        // EXECUTION_FAILED + 零 artifact 本应触发降级；reason 把它排除（改判本身即终态）
        error: {
          code: 'EXECUTION_FAILED',
          message: '委派回合零服务端活动记录，完成声称不予采信',
          reason: 'NO_EXECUTION_RECEIPT',
          details: { ledger: { executed: 0, blocked: 0, wild: 0 } },
          retryable: false,
        },
      },
    });
    const r = await delegate({ taskId: TASK });

    assert.equal(calls.length, 1, '桥被正常调用（改判发生在桥内，非 provider 入口）');
    assert.equal(execCalls.runGoal, 0, '假完成改判不得被降级重试洗白成成功');
    assert.equal(r.ok, false);
    assert.equal(r.error.reason, 'NO_EXECUTION_RECEIPT');
  });
});

/* ============================ D-2 persistent=false → 不拒绝 ============================ */

describe('K-N1 D-2 disabled + persistent=false → 委派正常进桥（§4.2 两种部署态可区分）', () => {
  test('ok:true 且 bridge.runGoal 恰 1 次（单次 -p 即设计，不存在「disabled=故障」）', async () => {
    const { delegate, calls, lastInput } = await makeProvider({
      session: DISABLED,
      persistent: false,
    });
    const r = await delegate({ taskId: TASK });

    assert.equal(r.ok, true, '显式选择「单次 -p 即设计」的部署不被拒绝');
    assert.equal(calls.length, 1, '委派确实进入桥执行');
    assert.equal(r.error, undefined, '不得携带 LLM_SESSION_DISABLED');
    assert.equal(lastInput().taskId, TASK, 'taskId 仍透传（委派上下文完整，账本反查可工作）');
  });

  test('对照：persistent=true 且 state=disabled 才拒绝 —— 同一 disabled 事实、两种部署态两种结论', async () => {
    const on = await makeProvider({ session: DISABLED, persistent: true });
    const off = await makeProvider({ session: DISABLED, persistent: false });
    const rOn = await on.delegate({ taskId: TASK });
    const rOff = await off.delegate({ taskId: TASK });

    assert.equal(rOn.ok, false, 'persistent=true：disabled 是故障 → 显式拒绝 + 运维信号');
    assert.equal(rOff.ok, true, 'persistent=false：无「disabled=异常」概念 → 不拒绝，账本反查兜底');
    assert.equal(on.calls.length, 0);
    assert.equal(off.calls.length, 1);
  });

  test('persistent=false 时即使会话 disabled 也不产生拒绝 warn（噪音纪律）', async () => {
    const { delegate, logs } = await makeProvider({ session: DISABLED, persistent: false });
    await delegate({ taskId: TASK });
    assert.equal(
      logs.filter(([, msg]) => msg.includes('LLM_SESSION_DISABLED')).length,
      0,
      '未拒绝就不该发「拒绝」告警（否则告警与事实不符）',
    );
  });
});

/* ============================ D-3 非委派上下文零回归 ============================ */

describe('K-N1 D-3 非委派（无 taskId）+ disabled → 行为不变（MCP 直调零回归）', () => {
  test('无 taskId → 不拒绝，桥正常执行', async () => {
    const { delegate, calls } = await makeProvider({ session: DISABLED, persistent: true });
    const r = await delegate(); // 不带 taskId = 非 A2A 委派

    assert.equal(r.ok, true, 'MCP 直调语义逐字不变（K-N1 只治 A2A 委派壳）');
    assert.equal(calls.length, 1, '非委派路径照常走桥');
    assert.equal('taskId' in calls[0][0], false, '无 taskId 时不得凭空注入（否则凭空进账本反查）');
  });

  test('persistent=true + 无 taskId + disabled 三条件齐备仍不拒绝（门序：hasTaskId 优先）', async () => {
    const { delegate, calls, execCalls } = await makeProvider({
      session: DISABLED,
      persistent: true,
    });
    const r = await delegate();
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(execCalls.runGoal, 0, '成功路径本就不该降级');
  });
});

/* ============================ D-5 会话态矩阵（provider 接线层） ============================ */

describe('K-N1 D-5 会话态矩阵：仅 disabled 触发拒绝（接线与纯函数真值表一致）', () => {
  const STATES = ['stopped', 'starting', 'ready', 'degraded', 'disabled'];

  for (const state of STATES) {
    test(`persistent=true + taskId + state=${state} → ${state === 'disabled' ? '拒绝' : '放行'}`, async () => {
      const { delegate, calls } = await makeProvider({
        session: health(state),
        persistent: true,
      });
      const r = await delegate({ taskId: TASK });
      assert.equal(r.ok, state !== 'disabled', `state=${state} 的结论必须与 §9-A-3 真值表一致`);
      assert.equal(calls.length, state === 'disabled' ? 0 : 1);
      if (state === 'disabled') assert.equal(r.error.reason, 'LLM_SESSION_DISABLED');
    });
  }

  test('桥未实现 sessionHealth（老宿主/Mock）→ undefined 视为不可判定，放行', async () => {
    // provider 对 `sessionHealth?.()` 缺席的桥取 undefined → 不拒绝（旧宿主零回归）。
    const { delegate, calls } = await makeProvider({ session: undefined, persistent: true });
    const r = await delegate({ taskId: TASK });
    assert.equal(r.ok, true, '会话态不可知时不得误杀委派（fail-open 与判据 1 一致）');
    assert.equal(calls.length, 1);
  });

  test('桥未实现 isPersistentEnabled（老 Mock）→ 视为非常驻，放行', async () => {
    const runGoalCalls = [];
    const provider = new WorkbuddyLlmProvider({
      bridge: {
        //刻意不实现 isPersistentEnabled（老 Mock 形状）
        async runGoal(input) {
          runGoalCalls.push(input);
          return { ok: true, summary: 'ok', artifacts: [], steps: [] };
        },
      },
      executor: makeExecutor().executor,
    });
    await provider.init(makeCtx().ctx);
    const r = await provider.runGoal(
      { traceId: TRACE, goal: '卸载 VM 企业微信', taskId: TASK, timeoutMs: 30_000 },
      { onStatus: () => {}, onArtifact: () => {} },
    );
    assert.equal(r.ok, true, '缺 isPersistentEnabled 的 Mock 桥不得被拒绝');
    assert.equal(runGoalCalls.length, 1, '委派照常进桥');
  });
});

/* ============================ D-6 probe 下传 + degraded 透传 ============================ */

describe('K-N1 D-6 接线面：probe 逐调用下传 + degraded 事实透传（§4.4）', () => {
  test('ctx.delegationProbe 经 cast 读取并逐调用下传给桥', async () => {
    const probe = { delegationActivity: async () => ({ total: 0, executed: 0, blocked: 0, wild: 0 }) };
    const { delegate, lastInput } = await makeProvider({ session: health('ready'), probe });
    await delegate({ taskId: TASK });
    assert.equal(lastInput().probe, probe, '同一探针实例下传（桥据此反查服务端账本）');
  });

  test('ctx 无 delegationProbe → 入参不含 probe 键（缺席即旧行为，不塞 undefined）', async () => {
    const { delegate, lastInput } = await makeProvider({ session: health('ready') });
    await delegate({ taskId: TASK });
    assert.equal('probe' in lastInput(), false, '桥门 4「未注入=旧行为」依赖该键缺席');
  });

  test('桥的 degraded 事实透传到 GoalResult（observer 落 ext.downgraded 的唯一来源）', async () => {
    const { delegate } = await makeProvider({
      session: health('ready'),
      persistent: true,
      result: {
        ok: true,
        summary: 'LLM 运行时完成目标（常驻会话不可用：已降级为单次 -p 路径）',
        artifacts: [],
        steps: [],
        degraded: { reason: '已超重建上限（5），此后回退单次 -p' },
      },
    });
    const r = await delegate({ taskId: TASK });
    assert.deepEqual(r.degraded, { reason: '已超重建上限（5），此后回退单次 -p' });
  });

  test('非降级路径不产 degraded 键（避免 observer 误记 ext.downgraded）', async () => {
    const { delegate } = await makeProvider({ session: health('ready') });
    const r = await delegate({ taskId: TASK });
    assert.equal('degraded' in r, false);
  });

  test('桥失败且带 degraded 时 degraded 仍透传（降级事实不因终态失败而丢失）', async () => {
    const { delegate } = await makeProvider({
      session: health('ready'),
      result: {
        ok: false,
        summary: '降级单次 -p 后零活动',
        artifacts: [],
        steps: [],
        degraded: { reason: '常驻会话不可用' },
        error: { code: 'EXECUTION_FAILED', message: '零活动', reason: 'NO_EXECUTION_RECEIPT', retryable: false },
      },
    });
    const r = await delegate({ taskId: TASK });
    assert.equal(r.ok, false);
    assert.deepEqual(r.degraded, { reason: '常驻会话不可用' }, '取证需要「既降级又失败」这一组合事实');
  });

  test('未 init 就 runGoal → 抛「provider 尚未 init」（SPI 前置条件不被绕过）', async () => {
    const provider = new WorkbuddyLlmProvider({
      bridge: makeBridge().bridge,
      executor: makeExecutor().executor,
    });
    await assert.rejects(
      () =>
        provider.runGoal(
          { traceId: TRACE, goal: 'g', taskId: TASK, timeoutMs: 1 },
          { onStatus: () => {}, onArtifact: () => {} },
        ),
      /provider 尚未 init/,
    );
  });

  test('llmSessionReset / llmSessionInjectFault 薄转发到桥（管理端点 SPI 面）', async () => {
    const b = makeBridge({ session: DISABLED, persistent: true });
    b.bridge.sessionReset = () => health('stopped');
    b.bridge.sessionInjectFault = (on) => on === true;
    const e = makeExecutor();
    const { ctx } = makeCtx();
    const provider = new WorkbuddyLlmProvider({ bridge: b.bridge, executor: e.executor });
    await provider.init(ctx);

    assert.deepEqual(provider.llmSessionHealth(), DISABLED);
    assert.deepEqual(provider.llmSessionReset(), health('stopped'));
    assert.equal(provider.llmSessionInjectFault(true), true);
    assert.equal(provider.llmSessionInjectFault(false), false);
  });

  test('桥未实现 L1 SPI → 转发返回 undefined/false（端点据此如实报不可用）', async () => {
    const provider = new WorkbuddyLlmProvider({
      bridge: { async runGoal() { return { ok: true, summary: '', artifacts: [], steps: [] }; } },
      executor: makeExecutor().executor,
    });
    const { ctx } = makeCtx();
    await provider.init(ctx);
    assert.equal(provider.llmSessionReset(), undefined, '不得假成功');
    assert.equal(provider.llmSessionInjectFault(true), false);
  });
});