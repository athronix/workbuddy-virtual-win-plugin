/**
 * Phase 1 · T5 行为守卫（判据①）—— 确定性执行体的取消消费
 *
 * 钉死 §7.4-T5 判据①：「确定性 provider：取消后模板不再发起下一次能力调用
 * （`step()` 咽喉断言）」。
 *
 * 覆盖三件事，缺一不可：
 *   A. `step()` 入口取消闸 ⇒ **bridge.call 零新增**（咽喉点断言：取消后能力调用次数
 *      与取消判定时一模一样，多模板链也不会继续往下走）。
 *   B. 取消收口的契约形状：`ok:false` + `error.code==='TASK_CANCELED'` +
 *      `retryable===false` + **不写 `goalSummary/stepCount` 类推断**（文案只报可证事实）。
 *   C. 安全红线：取消**绝不得**折叠成 `EXECUTION_FAILED` ——
 *      `adapter-agent-workbuddy-llm/src/index.ts` 的 `shouldDegrade` 会把
 *      「EXECUTION_FAILED 且零 artifact」判定为可降级并**回落确定性执行器重跑**，
 *      等于把用户已叫停的任务再执行一遍。本文件末尾用真实导出面（`WorkbuddyLlmProvider`）
 *      端到端证伪这条路径。（行号有意不写：`shouldDegrade` 在 P2-T10 同批改动中位置会变，
 *      钉行号即脆断言 —— 该函数的行为由本文件 + `phase2-contract-code-fidelity.test.js` 守护。）
 *
 * 纪律：不碰 VM / PowerShell / HTTP；import 构建产物（与 `cl020-f2-*` 同风格，
 *       跑测前须 `tsc -b tsconfig.build.json --force`，T4 移交第 D-28 条）。
 *
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase1-t5-provider-cancel.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider as createDeterministic } from '../../packages/adapter-agent-workbuddy/dist/index.js';
import { WorkbuddyLlmProvider } from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const TRACE = 'tr_t5_cancel_01';

/**
 * 可编程取消闸：`at` 之后 `isCancelled()` 恒真（0=执行前即已取消，
 * 1=第一次能力调用返回后取消，…）。
 */
function makeCancelController(at) {
  let calls = 0;
  return {
    cancelRequested: () => calls >= at,
    noteCall: () => {
      calls += 1;
    },
    get callCount() {
      return calls;
    },
  };
}

/**
 * 假 ps-bridge：每次 `call` 计数并回一份最小可用载荷。
 * `counts` 按 `模块/函数` 累计，供「零新增调用」断言。
 */
function makeBridge(gate) {
  const counts = {};
  return {
    counts,
    running: true,
    async call(module, fn, params, timeoutMs) {
      if (gate) gate.noteCall();
      const key = `${module}/${fn}`;
      counts[key] = (counts[key] ?? 0) + 1;
      if (module === 'app') {
        // app.winget.search 返回列表；app.winget.install 回单对象
        return fn === 'Search-Winget' ? [{ id: 'Foo.Bar', name: 'Foo' }] : { success: true, id: params?.id };
      }
      // gui.* 回 base64 串 ⇒ provider 的 extractArtifacts 会真产出一个 artifact
      // （否则「取消后零推送」用例的对象本身就是空的，断言会空转）
      if (module === 'gui') return { data: 'AAAA', width: 1920, height: 1080 };
      return { ok: true, key, echoedTimeout: timeoutMs };
    },
  };
}

/** 注册表视图（`implementationOf` / `definitionOf` 的权威源，见 provider :183-215） */
const CAPABILITY_DEFS = new Map(
  [
    ['app.winget.search', { module: 'app', fn: 'Search-Winget', risk: 'L1' }],
    ['app.winget.install', { module: 'app', fn: 'Install-Winget', risk: 'L2' }],
    ['storage.cleanup.analyze', { module: 'storage', fn: 'Get-CleanupAnalysis', risk: 'L1' }],
    ['system.info.get', { module: 'system', fn: 'Get-SystemInfo', risk: 'L0' }],
    ['gui.screen.capture', { module: 'gui', fn: 'Get-ScreenCapture', risk: 'L1' }],
  ].map(([id, impl]) => [
    id,
    { implementation: { module: impl.module, function: impl.fn }, input: {}, timeoutMs: 5_000 },
  ]),
);

function makeCtx(bridge) {
  return {
    config: {},
    bridge,
    // provider 经 cast 读 capabilityDefs（不扩 BridgeContext 契约接口，同 reportNetCfg 惯例）
    capabilityDefs: CAPABILITY_DEFS,
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'allow' }) },
    capabilities: {
      get: (id) => ({ id, risk: 'L1', requiresSession: false }),
      list: () => [...CAPABILITY_DEFS.keys()],
      size: () => CAPABILITY_DEFS.size,
      intersectDeclared: () => [],
    },
    audit: {
      append: async () => ({ auditId: 'aud_t5' }),
      verifyChain: async () => ({ entries: 0, valid: true }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {} },
    newTraceId: () => TRACE,
  };
}

/**
 * 跑一次确定性模板委派。
 * @param {string} goal 目标文本（决定命中哪个模板）
 * @param {{at?:number, statuses?:Array, artifacts?:Array}} opts
 *        `at` = 第几次能力调用后开始视为已取消（默认 0 = 执行前即取消）
 */
async function runDeterministic(goal, opts = {}) {
  const gate = makeCancelController(opts.at ?? 0);
  const bridge = makeBridge(gate);
  const p = createDeterministic();
  await p.init(makeCtx(bridge));

  const statuses = [];
  const pushedArtifacts = [];
  const sink = {
    onStatus: (state, message) => statuses.push([state, message ?? '']),
    onArtifact: (a) => pushedArtifacts.push(a),
    isCancelled: () => gate.cancelRequested(),
  };
  const result = await p.runGoal({ traceId: TRACE, goal, timeoutMs: 30_000 }, sink);
  await p.shutdown().catch(() => undefined);
  return { result, bridge, gate, statuses, pushedArtifacts };
}

/* ============================ A 咽喉点：零新增调用 ============================ */

describe('T5 判据① step() 咽喉：取消后模板不再发起下一次能力调用', () => {
  test('单步模板（磁盘分析）执行前已取消 ⇒ bridge.call 恰 0 次', async () => {
    const { result, bridge, gate } = await runDeterministic('分析磁盘空间占用并给清理建议', { at: 0 });

    assert.equal(gate.callCount, 0, '取消先于执行 ⇒ 一次能力调用都不许发起');
    assert.deepEqual(Object.keys(bridge.counts), [], '咽喉点未放行 ⇒ 不得有任何模块/函数被调用');
    assert.equal(result.ok, false);
    assert.equal(result.steps.length, 0, '未真实执行的步骤不得记账（steps 是链上权威源）');
  });

  test('单步模板执行中取消 ⇒ 该步照常记账（可证事实），但不再走第二个 step', async () => {
    const { result, gate } = await runDeterministic('分析磁盘空间占用并给清理建议', { at: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASK_CANCELED');
    // 第一次调用发生在取消判定之前 ⇒ 它是**真实执行过的**，必须留在 steps 里（不得抹痕）
    assert.equal(result.steps.length, 1, '取消点之前已完成的调用须如实记账');
    assert.equal(gate.callCount, 1, '第二个 step 不得再发起调用');
  });

  test('多步模板（安装应用）第 1 步后取消 ⇒ 安装调用零发起（安全核心用例）', async () => {
    const { result, bridge, gate } = await runDeterministic('安装 Foo 应用', { at: 1 });

    assert.equal(gate.callCount, 1, '搜索可执行，但安装必须在取消后停住');
    assert.equal(bridge.counts['app/Install-Winget'] ?? 0, 0, '★ 已叫停的**写操作**绝不得发起');
    assert.equal(bridge.counts['app/Search-Winget'], 1, '取消前那次只读搜索照常发生');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASK_CANCELED');
  });

  test('取消后 sink.onArtifact 零推送（与框架 addArtifact 终态守卫形成双闸）', async () => {
    const { result, pushedArtifacts } = await runDeterministic('截一张当前屏幕看看', { at: 1 });
    assert.equal(result.error.code, 'TASK_CANCELED');
    assert.equal(pushedArtifacts.length, 0, '取消命中后不得再向 sink 推 artifact（框架 addArtifact 另有终态二次闸门）');
    // 双闸**分叉**口径（主理人裁定 · T5）：框架 O-2 决定 canceled 收口不落链 ⇒ 流出面为 0 是对的，
    // 但 provider 本地 `GoalResult.artifacts` 必须仍承载那一份**已完成**的产物 —— 它是宿主文案计数
    // 与 QA 反查唯一可读的事实源（框架 observer 快照里 `result` 在场，`task.artifacts` 不替 provider 补记）。
    // 收口时清空本地集 = 把「确实产出了这份产物」从账上抹掉 ⇒ 属不实记账，不得反向放宽本断言。
    assert.equal(result.artifacts.length, 1, '★ 取消前已完成的产物须如实留在本地结果集（不得抹痕）');
    assert.ok(
      result.artifacts.length > pushedArtifacts.length,
      '本地账 ≥ 流出面：双闸分叉的机器可读表达（两侧口径若被改成相等，说明有一侧漂了）',
    );
    // 被抹掉的只有「产物」这一可外推的副作用面；**事实计数**（steps）必须保留，
    // 宿主呈现面的 N 正是从它派生 —— 这才是本用例的区分力所在。
    assert.equal(result.steps.length, 1, '★ 已真实发生的调用必须留在 steps（取消文案的权威事实源）');
  });
});

/* ============================ B 契约形状与文案 ============================ */

describe('T5 判据① 取消收口的契约形状', () => {
  test('ok:false + TASK_CANCELED + retryable:false（不静默成功、不可自动重试）', async () => {
    const { result } = await runDeterministic('获取系统信息', { at: 0 });
    assert.equal(result.ok, false, '契约纪律：命中取消即停止副作用并以 TASK_CANCELED 收口，不得静默返回成功');
    assert.equal(result.error.code, 'TASK_CANCELED');
    assert.equal(result.error.retryable, false, '自动重试等于把已叫停的操作再跑一遍');
  });

  test('文案只陈述可证事实：含计数、绝不宣称「未执行任何变更」', async () => {
    const zero = await runDeterministic('获取系统信息', { at: 0 });
    assert.match(zero.result.summary, /发起 0 次能力调用/, '零痕迹态须给出 0 的事实计数');

    const some = await runDeterministic('获取系统信息', { at: 1 });
    assert.match(some.result.summary, /发起 1 次能力调用/, '有痕迹态按 steps 实况计数');
    for (const r of [zero, some]) {
      assert.ok(
        !r.result.summary.includes('未执行任何变更'),
        '★ 不实陈述必须退场：取消是协作式的，取消点之前可能已真实改动虚拟机',
      );
      assert.ok(!r.result.summary.includes('已修复') && !r.result.summary.includes('已解决'), '承诺措辞红线');
    }
  });

  test('未取消路径逐字回归：TASK_CANCELED 不得污染正常失败/成功语义', async () => {
    const { result, bridge } = await runDeterministic('获取系统信息', { at: 999 });
    assert.equal(result.ok, true, '无取消 ⇒ 模板正常成功（旧行为不变）');
    assert.equal(result.error, undefined);
    assert.equal(result.steps.length, 1);
    assert.equal(bridge.counts['system/Get-SystemInfo'], 1);
  });

  test('非取消失败走 goalFail 并**保住来路契约码**（POLICY_DENIED 不再被折叠）', async () => {
    const gate = makeCancelController(999);
    const bridge = makeBridge(gate);
    const ctx = makeCtx(bridge);
    ctx.policy = {
      evaluate: () => ({ allowed: false, matchedRule: 'pathAllowlist:miss' }),
    };
    const p = createDeterministic();
    await p.init(ctx);
    const result = await p.runGoal(
      { traceId: TRACE, goal: '分析磁盘空间占用并给清理建议', timeoutMs: 30_000 },
      { onStatus: () => {}, onArtifact: () => {}, isCancelled: () => gate.cancelRequested() },
    );
    assert.equal(result.ok, false);
    // P2-T10（O-1）改写了本用例的期望值：旧实现 `step()` 只把 `res.error.message` 上抛为
    // 字符串，模板层统一包成 EXECUTION_FAILED ⇒ execute 内的 POLICY_DENIED 在模板路径上
    // 被折叠（当时登记为观察项 O-1）。现 `step()` 结构化透传 `BridgeError`、`goalFail()`
    // 沿用来路码 ⇒ 策略硬拒以 **POLICY_DENIED** 收口，`retryable:false` 由
    // `DEFAULT_RETRYABLE` 决定（不可自动重试）。折叠形态的钉法见本文件头注释与
    // `phase2-contract-code-fidelity.test.js`（保码 + 降级边界双向守卫）。
    assert.equal(result.error.code, 'POLICY_DENIED', '★ O-1 保码：策略硬拒不得再看起来像执行失败');
    assert.equal(result.error.retryable, false, 'POLICY_DENIED 默认不可重试（重跑等于绕闸）');
    assert.match(result.error.message, /被策略拒绝/, 'summary/message 仍携带上游可读文案');
    assert.match(result.summary, /分析失败/, '模板层文案形状不变（仅码保真）');
    await p.shutdown().catch(() => undefined);
  });

  test('模板业务判定（上游无码）仍折叠为 EXECUTION_FAILED —— 兜底语义未变', async () => {
    // 与上一条互为对照：只有**上游带来错误**时才沿用其码；模板自身业务结论
    // （未找到匹配包）无来路码 ⇒ 仍 `EXECUTION_FAILED`，逐字等于旧行为。
    // 价值：证明保码不是「把所有失败都改成 POLICY_DENIED」的空改。
    const bridge = makeBridge(null);
    bridge.call = async (module, fn) => (module === 'app' && fn === 'Search-Winget' ? [] : {});
    const p = createDeterministic();
    await p.init(makeCtx(bridge));
    const result = await p.runGoal(
      { traceId: TRACE, goal: '安装 NoSuchPkg 应用', timeoutMs: 30_000 },
      { onStatus: () => {}, onArtifact: () => {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EXECUTION_FAILED', '无来路码 ⇒ 兜底仍 EXECUTION_FAILED');
    assert.equal(result.error.reason, undefined, '兜底不得凭空造 reason');
    assert.match(result.error.message, /未找到与/);
    await p.shutdown().catch(() => undefined);
  });

  test('取消与失败的判定互斥：isCancelled 缺席（第三方 provider 未实现）⇒ 逐字旧行为', async () => {
    // 旧 provider / 旧宿主注入的 sink 不带 isCancelled ⇒ `?.()` 短路为 undefined，
    // 严格等值 `=== true` 不成立 ⇒ 模板照常执行（纯附加可选铁律：缺席即旧行为）。
    const bridge = makeBridge(null);
    const p = createDeterministic();
    await p.init(makeCtx(bridge));
    const legacySink = { onStatus: () => {}, onArtifact: () => {} };
    assert.equal('isCancelled' in legacySink, false, '本用例前提：sink 未实现该成员');
    const result = await p.runGoal(
      { traceId: TRACE, goal: '获取系统信息', timeoutMs: 30_000 },
      legacySink,
    );
    assert.equal(result.ok, true, '未实现取消成员的宿主不得因本批改造被误判为已取消');
    assert.equal(bridge.counts['system/Get-SystemInfo'], 1);
    await p.shutdown().catch(() => undefined);
  });
});

/* ============================ C 安全红线：取消不得触发降级重跑 ============================ */

describe('T5 判据① 安全红线：取消码不进 shouldDegrade（不得回落确定性执行器重跑）', () => {
  /** 恒返回取消结果的假桥（模拟 VM 内 LLM 执行体被取消打断后的终态） */
  function canceledBridge() {
    return {
      setSessionConfig() {},
      setSessionLog() {},
      sessionHealth: () => ({ state: 'ready', restarts: 0, idleMs: 0 }),
      isPersistentEnabled: () => true,
      async runGoal() {
        return {
          ok: false,
          summary: '任务已取消（桥层 TASK_CANCELED）',
          artifacts: [],
          steps: [],
          error: { code: 'TASK_CANCELED', message: 'LLM_TURN_CANCELED', retryable: false },
        };
      },
    };
  }

  test('桥回 TASK_CANCELED ⇒ 确定性执行器零调用、结果原样透出', async () => {
    const executorCalls = { runGoal: 0, execute: 0 };
    const executor = {
      id: 'mock-deterministic',
      displayName: 'mock',
      kind: 'deterministic',
      declareCapabilities: () => ['app.*'],
      async init() {},
      async execute(req) {
        executorCalls.execute += 1;
        return { traceId: req.traceId, ok: true, data: {}, artifacts: [], durationMs: 1 };
      },
      async runGoal() {
        executorCalls.runGoal += 1;
        return { ok: true, summary: '降级重跑', artifacts: [], steps: [] };
      },
      async health() {
        return { ok: true };
      },
      async shutdown() {},
      dispose: () => {},
    };

    const p = new WorkbuddyLlmProvider({ bridge: canceledBridge(), executor });
    await p.init(makeCtx(makeBridge(null)));
    const res = await p.runGoal(
      { traceId: TRACE, goal: '分析磁盘空间占用并给清理建议', timeoutMs: 30_000, taskId: 'task_t5' },
      { onStatus: () => {}, onArtifact: () => {} },
    );

    assert.equal(executorCalls.runGoal, 0, '★ 已叫停的任务绝不得被降级重跑（这是取消折叠成 EXECUTION_FAILED 的真实后果）');
    assert.equal(executorCalls.execute, 0);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TASK_CANCELED', '取消码须原样透出到宿主/observer');
    await p.shutdown().catch(() => undefined);
  });

  test('对照实验：同形状但 EXECUTION_FAILED ⇒ 确实会降级重跑（证明上一条不是空断言）', async () => {
    const executorCalls = { runGoal: 0 };
    const bridge = {
      setSessionConfig() {},
      setSessionLog() {},
      sessionHealth: () => ({ state: 'ready', restarts: 0, idleMs: 0 }),
      isPersistentEnabled: () => true,
      async runGoal() {
        return {
          ok: false,
          summary: '执行失败',
          artifacts: [],
          steps: [],
          error: { code: 'EXECUTION_FAILED', message: 'X', retryable: false },
        };
      },
    };
    const executor = {
      id: 'mock-deterministic',
      displayName: 'mock',
      kind: 'deterministic',
      declareCapabilities: () => ['app.*'],
      async init() {},
      async execute(req) {
        return { traceId: req.traceId, ok: true, data: {}, artifacts: [], durationMs: 1 };
      },
      async runGoal() {
        executorCalls.runGoal += 1;
        return { ok: true, summary: '降级重跑', artifacts: [], steps: [] };
      },
      async health() {
        return { ok: true };
      },
      async shutdown() {},
      dispose: () => {},
    };
    const p = new WorkbuddyLlmProvider({ bridge, executor });
    await p.init(makeCtx(makeBridge(null)));
    await p.runGoal({ traceId: TRACE, goal: 'x', timeoutMs: 30_000 }, { onStatus: () => {}, onArtifact: () => {} });
    assert.equal(executorCalls.runGoal, 1, '本用例的价值在于证明 shouldDegrade 通路是活的 ⇒ 上一条零调用是真结论');
    await p.shutdown().catch(() => undefined);
  });
});
