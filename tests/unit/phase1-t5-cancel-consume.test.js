/**
 * Phase 1 安全兑现批 · T5 离线行为守卫（执行体消费取消 + 客户端凭据通路）
 *
 * 覆盖 §7.4-T5 判据 ①②③④（离线可判部分；真机①②③由主理人部署后另跑）：
 *   ① 确定性 provider：取消后**不再发起下一次能力调用**（`step()` 咽喉断言）。
 *   ② LLM provider（常驻路径）：取消时 `abortActiveTurn` 被真实调用，且结果以
 *      `TASK_CANCELED` 收口 —— **绝不**顺着降级通道回落单次 `-p` 重跑。
 *   ③ LLM provider（单次 -p 路径）：取消信号 kill 子进程 + promise 落 TASK_CANCELED。
 *   ④ 客户端凭据通路：`--token-env` 真给值 ⇒ 请求带 `authorization: Bearer`；
 *      有名无值 ⇒ fail-loud（且**前置到建隧道之前**）；缺席 ⇒ 不加头（旧行为）。
 *   外加 §10 R3 的呈现面两态可分（判据③文案侧）已在 host-a2a-bridge.test.js 同步。
 *
 * 关键安全红线（本文件反复钉的那一条）：取消收口的契约码必须是 `TASK_CANCELED`。
 *   `WorkbuddyLlmProvider.shouldDegrade` 会把 `EXECUTION_FAILED 且零 artifact` 判定为
 *   「运行时不可用」并回落确定性执行器**重跑** —— 用错码等于把用户已叫停的任务再执行一遍。
 *   故本文件的每个取消用例都同时断「码正确」与「降级路径未被触发」。
 *
 * 零真机 / 零 VM / 零隧道 / 零 codebuddy：全部用注入替身 + 本地回环 http server
 * + 以 `process.execPath` 自 spawn 一个可 kill 的 node 子进程。
 */

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';
import { CliLlmBridge, WorkbuddyLlmProvider } from '@winvm/adapter-agent-workbuddy-llm';
import { applyBearerHeader, establishTransport, TransportError } from '@winvm/core';
import { buildTransport } from '@winvm/host-a2a-bridge';

/* ==================================================================== *
 * 夹具
 * ==================================================================== */

/** 可编程取消源：isCancelled 与 cancellationSignal **同源**（T3 移交第 6 条口径）。 */
function cancelSource() {
  const ac = new AbortController();
  const box = { cancelled: false };
  return {
    box,
    signal: ac.signal,
    cancel(reason) {
      box.cancelled = true;
      ac.abort(reason ?? new Error('canceled'));
    },
    isCancelled: () => box.cancelled,
  };
}

/** 记录型 sink（ProgressSink 的离线替身）。 */
function makeSink(src, hooks = {}) {
  const seen = { status: [], artifacts: [] };
  return {
    seen,
    onStatus(state, message) {
      seen.status.push({ state, message: message ?? '' });
      hooks.onStatus?.(state, message ?? '', seen);
    },
    onArtifact(artifact) {
      seen.artifacts.push(artifact);
      hooks.onArtifact?.(artifact, seen);
    },
    async onApprovalRequired() {
      return false;
    },
    isCancelled: src.isCancelled,
    cancellationSignal: src.signal,
  };
}

// 注册表实现绑定的契约键名是 `function`（`CapabilityDefinition.implementation.function`），
// provider 内部再映射成 `impl.fn` —— 夹具写错键名会让 bridge.call 收到 undefined fn（曾踩）。
const CAP_IMPL = {
  'app.winget.search': { module: 'app', fn: 'Search-Package' },
  'app.winget.install': { module: 'app', fn: 'Install-Package' },
  'storage.cleanup.analyze': { module: 'storage', fn: 'Analyze-Cleanup' },
  'system.info.get': { module: 'system', fn: 'Get-SystemInfo' },
  'gui.screen.capture': { module: 'gui', fn: 'Capture-Screen' },
};

/**
 * 确定性 provider 注入替身：`bridge.call` 记录每一次**真实能力调用**（= 断言「取消后零新调用」的探针）。
 * 与 cl017-param-guard.test.js 同范式（走公开路径 init + runGoal，不依赖私有方法名）。
 */
async function makeDeterministic(opts = {}) {
  const calls = [];
  const bridge = {
    running: true,
    uptimeMs: 1,
    async start() {},
    async stop() {},
    async call(module, fn, params) {
      calls.push({ module, fn, params });
      const hit = opts.results?.[`${module}.${fn}`] ?? opts.defaultResult;
      if (hit instanceof Error) throw hit;
      return hit ?? { ok: true, module, fn };
    },
    health() {
      return { state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 0 };
    },
  };
  const capabilityDefs = new Map(
    Object.entries(CAP_IMPL).map(([id, impl]) => [
      id,
      { id, input: {}, implementation: { module: impl.module, function: impl.fn }, output: {} },
    ]),
  );
  const ctx = {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'aud_x' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: (id) => ({ risk: id.startsWith('app.winget.install') ? 'L3' : 'L1', requiresSession: false }),
      list: () => [...capabilityDefs.keys()],
      has: () => true,
    },
    capabilityDefs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bridge,
    newTraceId: () => 'tr_t5',
  };
  const p = new DeterministicAgentProvider(opts.providerOptions ?? {});
  await p.init(ctx);
  return { p, calls };
}

const GOAL_BASE = { traceId: 'tr_t5', timeoutMs: 10_000 };

/* ==================================================================== *
 * 判据① 确定性 provider：step() 咽喉 —— 取消后零新能力调用
 * ==================================================================== */

describe('T5 判据① 确定性执行体消费取消（step() 咽喉点）', () => {
  test('委派入口已取消 ⇒ 零能力调用 + TASK_CANCELED + 不谎称「未执行任何变更」', async () => {
    const src = cancelSource();
    src.cancel();
    const { p, calls } = await makeDeterministic();
    const sink = makeSink(src);
    const res = await p.runGoal({ ...GOAL_BASE, goal: '安装 Notepad', allowedCapabilities: ['app.*'] }, sink);

    assert.equal(calls.length, 0, '取消后 step() 必须**一次都不**发起能力调用（咽喉断言）');
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TASK_CANCELED', '取消码不得被 EXECUTION_FAILED 顶替');
    assert.equal(res.steps.length, 0);
    assert.equal(res.artifacts.length, 0);
    assert.ok(res.summary.includes('0 次能力调用'), `文案须事实化调用数，实测：${res.summary}`);
    assert.equal(sink.seen.artifacts.length, 0);
  });

  /**
   * 「搜索成功 → 宿主在这时叫停 → 安装绝不发起」——本批 T5 的核心安全断言：
   * 取消落在两次调用之间，写操作必须被咽喉点拦下（判据①）。
   * 取消源用 `calls.length > 0` 建模：第一次判定时尚无调用 ⇒ 放行搜索；
   * 之后一律已取消 ⇒ 安装入口的咽喉判定必然命中。
   */
  test('两次调用的模板：第一次执行后取消 ⇒ 第二次（真实写入）**绝不发起**', async () => {
    const { p, calls } = await makeDeterministic({
      defaultResult: [{ id: 'Microsoft.Notepad', name: 'Notepad' }],
    });
    const res = await p.runGoal(
      { ...GOAL_BASE, goal: '安装 Notepad', allowedCapabilities: ['app.*'] },
      makeSink({ isCancelled: () => calls.length > 0 }),
    );

    assert.equal(calls.length, 1, `只应发起 1 次调用，实测 ${calls.length}：${JSON.stringify(calls)}`);
    assert.equal(calls[0].fn, 'Search-Package', '唯一一次调用应是只读的搜索（写操作 Install-Package 不得发生）');
    assert.equal(res.error?.code, 'TASK_CANCELED', '取消后的收口码必须是 TASK_CANCELED');
    assert.equal(res.ok, false);
    assert.equal(res.steps.length, 1, '取消前确已发生的调用要如实记账（呈现面事实源）');
    assert.ok(!JSON.stringify(res).includes('未执行任何变更'), '绝不得宣称未执行任何变更');
    assert.ok(res.summary.includes('共发起 1 次能力调用'), `实测：${res.summary}`);
  });

  /**
   * 双闸分叉口径（主理人裁定，见 notes §D-31）：取消落在调用**期间**时 ——
   *   · 本地 `GoalResult.artifacts` **保留**那一份已完成的截图（不得抹痕：宿主文案计数与
   *     QA 反查唯一可读的事实源就是它，框架 O-2 快照也带 `result` 在场）；
   *   · 流出面 `sink.onArtifact` **为 0**（外推通道关死，框架 `TaskStore.addArtifact`
   *     另有终态二次闸门）。
   * 两个数**不等**正是本用例的价值 —— 若实现把本地集也清空，就是抹痕缺陷。
   */
  test('单次调用模板（截图）：调用期间取消 ⇒ 本地如实收纳产物、但不再外推', async () => {
    const { p, calls } = await makeDeterministic({
      results: { 'gui.Capture-Screen': { data: 'iVBORw0KGgo=' } },
    });
    const sink = makeSink({ isCancelled: () => calls.length > 0 });
    const res = await p.runGoal({ ...GOAL_BASE, goal: '帮我截屏看看' }, sink);

    assert.equal(calls.length, 1);
    assert.equal(res.error.code, 'TASK_CANCELED');
    assert.equal(res.steps.length, 1, '调用已发生 ⇒ steps 必须记账');
    assert.equal(res.artifacts.length, 1, '★ 取消收口不得抹掉已完成的产物（本地事实账）');
    assert.equal(sink.seen.artifacts.length, 0, '取消后的产物不得向宿主推送（观测面一致性）');
    assert.ok(res.artifacts.length > sink.seen.artifacts.length, '本地账 ≥ 流出面：双闸分叉的机器可读表达');
    assert.ok(res.summary.includes('产出 1 个 artifact'), `实测：${res.summary}`);
  });

  test('未取消 ⇒ 行为与改造前一致（正常路径零回归：调用发生、码不变成取消码）', async () => {
    const src = cancelSource();
    const { p, calls } = await makeDeterministic({
      results: { 'system.Get-SystemInfo': { os: 'Windows' } },
    });
    const res = await p.runGoal({ ...GOAL_BASE, goal: '给我系统信息' }, makeSink(src));
    assert.equal(calls.length, 1);
    assert.equal(res.ok, true);
    assert.equal(res.error, undefined);
    assert.ok(res.summary.includes('已获取系统信息'), '既有模板文案不得被 T5 改动（回归护栏）');
  });
});

/* ==================================================================== *
 * 判据② LLM 常驻路径：abortActiveTurn 被调 + 不降级重跑
 * ==================================================================== */

/** 桩桥：只暴露 runPersistent 实际读取的成员（同 cl-k3r-runpersistent-approval-routing 范式）。 */
class SessionStubBridge extends CliLlmBridge {
  constructor(turn) {
    super({ persistent: false });
    this._turn = turn;
    this.abortCalls = [];
  }
  async prepareMcpConfig() {
    return '/tmp/t5-stub-mcp.json';
  }
  ensureSession() {
    const self = this;
    return {
      sessionState: 'ready',
      abortActiveTurn(reason) {
        self.abortCalls.push(reason);
        return true;
      },
      runTurn: async () => this._turn,
    };
  }
}

function makeRunCtx(outputDir) {
  return {
    prompt: 'sys',
    outputDir,
    skillsDir: join(outputDir, '.winvm', 'skills'),
    started: Date.now(),
    cli: { resolved: true, path: 'codebuddy', probed: [] },
    lastFinalText: '',
    receipts: new Map(),
    raised: new Set(),
    replayActive: false,
  };
}

const PERSIST_INPUT = {
  goal: '用 Excel 生成周报',
  capabilities: ['appops.workflow.run'],
  outputDir: '%USERPROFILE%\\WinVMWorkspace\\out',
  cliPath: 'codebuddy',
  traceId: 'tr_t5_p',
  timeoutMs: 60_000,
};

describe('T5 判据② LLM 常驻路径：取消打断当前轮且不降级', () => {
  test('runPersistent 入口前置闸：取消 ⇒ 不碰会话、TASK_CANCELED、abortActiveTurn 无需调用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't5-persist-'));
    const src = cancelSource();
    src.cancel();
    const bridge = new SessionStubBridge({ ok: true, text: 'done', durationMs: 1 });
    const sink = makeSink(src);
    const out = await bridge.runPersistent(PERSIST_INPUT, sink, makeRunCtx(dir));

    assert.ok('result' in out, '必须走 result 收口，**不得**返回 { unavailable }（那会触发降级重跑）');
    assert.equal(out.result.error.code, 'TASK_CANCELED');
    assert.equal(bridge.abortCalls.length, 0, '入口闸命中时不该去打断任何轮次');
    assert.equal(out.result.ok, false);
  });

  test('turn 边界轮询：会话上报状态时命中取消 ⇒ abortActiveTurn 被调、本轮不再向前推进', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't5-persist-'));
    const src = cancelSource();
    // 会话内上报一次状态后再取消：模拟「CLI 正在跑，宿主在这时叫停」
    const bridge = new SessionStubBridge({ ok: true, text: 'partial', durationMs: 5 });
    const origRunTurn = bridge.ensureSession.bind(bridge);
    const self = bridge;
    bridge.ensureSession = () => {
      const s = origRunTurn();
      return {
        ...s,
        runTurn: async (_prompt, turnSink) => {
          turnSink.onStatus('working', 'CLI 正在规划第 1 步');
          src.cancel(); // 下一次 onStatus 即命中轮询
          turnSink.onStatus('working', 'CLI 正在规划第 2 步');
          return self._turn;
        },
      };
    };
    const sink = makeSink(src);
    const out = await bridge.runPersistent(PERSIST_INPUT, sink, makeRunCtx(dir));

    assert.equal(bridge.abortCalls.length, 1, '取消必须由 bridge 真实触达 abortActiveTurn');
    assert.ok('result' in out, '取消收口不得借道 { unavailable } ⇒ 降级单次 -p');
    assert.equal(out.result.error.code, 'TASK_CANCELED');
    assert.equal(sink.seen.status.filter((s) => s.message.includes('第 2 步')).length, 0, '打断后的状态上报不得再转给宿主');
  });

  test('取消信号（事件驱动）路径：不轮询也能打断（signal → abortActiveTurn）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't5-persist-'));
    const src = cancelSource();
    const bridge = new SessionStubBridge({ ok: true, text: 'partial', durationMs: 5 });
    const orig = bridge.ensureSession.bind(bridge);
    bridge.ensureSession = () => {
      const s = orig();
      return {
        ...s,
        runTurn: async (_p, _sink) => {
          src.cancel(); // 只发信号、不上报状态（真机 CLI 思考期常见）
          return new Promise((r) => setTimeout(() => r(bridge._turn), 20));
        },
      };
    };
    const out = await bridge.runPersistent(PERSIST_INPUT, makeSink(src), makeRunCtx(dir));
    assert.equal(bridge.abortCalls.length, 1, 'cancellationSignal 必须独立驱动打断');
    assert.equal(out.result.error.code, 'TASK_CANCELED');
  });

  test('降级红线：TASK_CANCELED 不落入 shouldDegrade ⇒ 确定性执行器不得被重跑', async () => {
    const executorCalls = [];
    const fakeExecutor = {
      id: 'fake-exec',
      kind: 'deterministic',
      displayName: 'fake',
      declareCapabilities: () => [],
      async init() {},
      async execute() {
        return { traceId: 't', ok: true, data: {}, durationMs: 1 };
      },
      async health() {
        return { ok: true, provider: { id: 'f', state: 'ready' }, session: {}, psBridge: { state: 'ready', uptimeMs: 1, pending: 0 } };
      },
      async runGoal() {
        executorCalls.push('runGoal');
        return { ok: false, summary: '不该被调用', artifacts: [], steps: [] };
      },
      async shutdown() {},
    };
    const src = cancelSource();
    src.cancel();
    const bridgeStub = {
      async runGoal(_input, sink) {
        // 与真实桥一致：取消收口直接返回 TASK_CANCELED
        sink.onStatus('working', '取消收口');
        return {
          ok: false,
          summary: '任务已取消',
          artifacts: [],
          steps: [],
          error: { code: 'TASK_CANCELED', message: 'TASK_CANCELED', retryable: false },
        };
      },
      isPersistentEnabled: () => true,
      sessionHealth: () => undefined,
    };
    const p = new WorkbuddyLlmProvider({ bridge: bridgeStub, executor: fakeExecutor });
    await p.init({
      config: {},
      audit: { append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'a' }), verifyChain: async () => ({ valid: true, entries: 0 }) },
      policy: { evaluate: () => ({ allowed: true, matchedRule: 't' }) },
      capabilities: { get: () => ({ risk: 'L1', requiresSession: false }), list: () => [], has: () => true },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      newTraceId: () => 'trace_t5',
    });
    const res = await p.runGoal({ traceId: 'tr_t5', goal: '开放性生产任务', timeoutMs: 60_000 }, makeSink(src));

    assert.equal(executorCalls.length, 0, '安全红线：被取消的任务绝不得回落确定性执行器重跑');
    assert.equal(res.error.code, 'TASK_CANCELED');
    assert.equal(res.ok, false);
  });

  test('对照：EXECUTION_FAILED + 零产物**确实**会触发降级（证明上一条用例不是恒真）', async () => {
    const executorCalls = [];
    const fakeExecutor = {
      id: 'fake-exec', kind: 'deterministic', displayName: 'f', declareCapabilities: () => [],
      async init() {},
      async execute() { return { traceId: 't', ok: true, data: {}, durationMs: 1 }; },
      async health() { return { ok: true, provider: { id: 'f', state: 'ready' }, session: {}, psBridge: { state: 'ready', uptimeMs: 1, pending: 0 } }; },
      async runGoal() { executorCalls.push('x'); return { ok: false, summary: '无模板', artifacts: [], steps: [] }; },
      async shutdown() {},
    };
    const src = cancelSource();
    const p = new WorkbuddyLlmProvider({
      executor: fakeExecutor,
      bridge: {
        async runGoal() {
          return { ok: false, summary: 'boom', artifacts: [], steps: [], error: { code: 'EXECUTION_FAILED', message: 'X' } };
        },
        isPersistentEnabled: () => false,
      },
    });
    await p.init({
      config: {},
      audit: { append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'a' }), verifyChain: async () => ({ valid: true, entries: 0 }) },
      policy: { evaluate: () => ({ allowed: true, matchedRule: 't' }) },
      capabilities: { get: () => ({ risk: 'L1', requiresSession: false }), list: () => [], has: () => true },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      newTraceId: () => 'trace_t5',
    });
    await p.runGoal({ traceId: 'tr_t5', goal: '开放性生产任务', timeoutMs: 60_000 }, makeSink(src));
    assert.equal(executorCalls.length, 1, '对照组必须为真 ⇒ 上一条 TASK_CANCELED 用例的「零重跑」是有效断言');
  });
});

/* ==================================================================== *
 * 判据③ 单次 -p：取消信号 kill 子进程 + 落终态
 * ==================================================================== */

describe('T5 判据③ 单次 -p 子进程可被取消 kill', () => {
  const baseInput = (outputDir) => ({
    goal: '生成报表',
    capabilities: ['appops.workflow.run'],
    outputDir,
    cliPath: process.execPath,
    traceId: 'tr_t5_oneshot',
    timeoutMs: 30_000,
  });

  test('运行中被取消 ⇒ 子进程被终止、结果以 TASK_CANCELED 落终态（promise 不悬挂）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't5-oneshot-'));
    const src = cancelSource();
    const bridge = new CliLlmBridge({
      persistent: false,
      cliPath: process.execPath,
      outputDir: dir,
      cliArgTemplate: ['-e', 'console.log("t5-child-alive"); setTimeout(() => {}, 30000)'],
    });
    const sink = makeSink(src, {
      onStatus: (_state, message) => {
        // 子进程已 spawn 并回显第一行 stdout ⇒ 此刻宿主叫停（真实取消时机）
        if (message.includes('t5-child-alive') && !src.box.cancelled) src.cancel();
      },
    });
    const res = await bridge.runGoal(baseInput(dir), sink);
    assert.equal(res.error?.code, 'TASK_CANCELED', `取消须以 TASK_CANCELED 收口，实测：${JSON.stringify(res.error ?? res.summary)}`);
    assert.equal(res.ok, false);
    assert.ok(!res.degraded, '取消路径不得被记成「常驻不可用 ⇒ 已降级」');
  });

  test('委派入口即取消 ⇒ 根本不 spawn 子进程（前置闸）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't5-oneshot-'));
    const src = cancelSource();
    src.cancel();
    let spawned = 0;
    const sink = makeSink(src, { onStatus: () => { spawned += 1; } });
    const bridge = new CliLlmBridge({
      persistent: false,
      cliPath: process.execPath,
      outputDir: dir,
      cliArgTemplate: ['-e', 'setTimeout(() => {}, 30000)'],
    });
    const res = await bridge.runGoal(baseInput(dir), sink);
    assert.equal(res.error?.code, 'TASK_CANCELED');
    assert.equal(spawned, 0, '入口闸命中时不得再有任何 onStatus/spawn 活动');
  });

  test('未取消 ⇒ 子进程正常跑完并回成功（零回归：signal 缺席即旧行为）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't5-oneshot-'));
    const src = cancelSource();
    const bridge = new CliLlmBridge({
      persistent: false,
      cliPath: process.execPath,
      outputDir: dir,
      cliArgTemplate: ['-e', 'console.log("done"); process.exit(0)'],
    });
    const res = await bridge.runGoal(baseInput(dir), makeSink(src));
    assert.equal(res.ok, true, `正常路径须成功，实测：${JSON.stringify(res.summary)}`);
    assert.equal(res.error, undefined);
  });
});

/* ==================================================================== *
 * 判据④ 客户端凭据通路（--token-env → applyBearerHeader → 真实 header）
 * ==================================================================== */

describe('T5 判据④ --token-env 真给值时请求带 Bearer 头', () => {
  test('cli.buildTransport：给值才落 tokenEnv 键；缺席 ⇒ 整键不存在（旧行为逐字节）', () => {
    const base = {
      endpoint: 'http://127.0.0.1:18443',
      a2aPath: '/a2a',
      timeoutMs: 600_000,
      maxRisk: 'L1',
      help: false,
    };
    const off = buildTransport({ ...base, tokenEnv: '' });
    assert.equal('tokenEnv' in off, false, '默认（回环隧道）不得带凭据声明');
    const on = buildTransport({ ...base, tokenEnv: 'WINVM_BEARER_TOKEN_T5' });
    assert.equal(on.tokenEnv, 'WINVM_BEARER_TOKEN_T5');
  });

  test('applyBearerHeader 三态：缺席不加头 / 有值加头 / 有名无值 fail-loud', () => {
    const ENV = 'WINVM_T5_TOKEN_STATE3';
    const none = applyBearerHeader({ 'x-a': '1' }, undefined, { [ENV]: 'secret' });
    assert.deepEqual(none, { 'x-a': '1' }, '未配置 ⇒ 原样返回，绝不加头');
    const some = applyBearerHeader({ 'x-a': '1' }, ENV, { [ENV]: 'secret-abc' });
    assert.equal(some.authorization, 'Bearer secret-abc');
    assert.equal(some['x-a'], '1', '既有头不得被覆盖');
    assert.throws(() => applyBearerHeader({}, ENV, {}), /未找到 bearer token 环境变量/, '有名无值必须抛（禁止静默裸请求）');
  });

  test('ssh-tunnel 分支：凭据校验**前置到建隧道之前**（T2 D-11 顺序不回归）', async () => {
    const ENV = 'WINVM_T5_TOKEN_UNSET';
    delete process.env[ENV];
    await assert.rejects(
      () =>
        establishTransport(
          { kind: 'ssh-tunnel', host: '127.0.0.1', user: 't5-nobody', remotePort: 1, localPort: 1, tokenEnv: ENV },
          { path: '/a2a' },
        ),
      (e) => {
        assert.ok(e instanceof TransportError, `须是 TransportError，实测 ${e?.name}`);
        assert.match(e.message, /bearer token/);
        assert.ok(!/隧道|tunnel|ssh:/i.test(e.message), '报错必须在建隧道**之前** ⇒ 消息不得含隧道相关字样');
        return true;
      },
    );
  });

  test('端到端（离线回环）：decl.tokenEnv 有值 ⇒ 服务端实收 authorization 头', async () => {
    const ENV = 'WINVM_T5_TOKEN_E2E';
    process.env[ENV] = 't5-e2e-secret';
    const received = [];
    const server = createServer((req, res) => {
      received.push({ auth: req.headers['authorization'] ?? null, path: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const managed = await establishTransport(
        { kind: 'streamable-http', url: `http://127.0.0.1:${port}`, tokenEnv: ENV, timeoutMs: 5_000 },
        { path: '/a2a' },
      );
      await managed.channel.request({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
      await managed.close();
      assert.equal(received.length, 1);
      assert.equal(received[0].auth, 'Bearer t5-e2e-secret', '真实请求必须携带 Bearer 头');
    } finally {
      delete process.env[ENV];
      await new Promise((r) => server.close(r));
    }
  });

  test('端到端（离线回环）：未配置 tokenEnv ⇒ 请求**不带** authorization（现网零变化）', async () => {
    const received = [];
    const server = createServer((req, res) => {
      received.push(req.headers['authorization'] ?? null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const managed = await establishTransport(
        { kind: 'streamable-http', url: `http://127.0.0.1:${port}`, timeoutMs: 5_000 },
        { path: '/a2a' },
      );
      await managed.channel.request({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
      await managed.close();
      assert.equal(received[0], null, '回环默认形态不得凭空加凭据头');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
