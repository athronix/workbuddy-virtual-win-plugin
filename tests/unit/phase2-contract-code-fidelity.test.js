/**
 * Phase 2 · P2-T10 · O-1 契约码保真守卫（API 保真，安全性质）
 *
 * ## 钉的是什么
 *
 * 设计 §4.1 C-1 把 O-1 从「观测失真」升级为「**安全性质可被绕过**」，机制链条是：
 *
 *   `execute()` 算出 `POLICY_DENIED`
 *     → 旧 `step()` 用 `res.error.message` 把它折成字符串（**丢码 + 丢 reason**）
 *     → 旧模板层统一 `makeError('EXECUTION_FAILED', msg)`（**压平成通用执行失败**）
 *     → LLM 层 `shouldDegrade` 判据 = `PROVIDER_UNAVAILABLE` 或
 *        （`EXECUTION_FAILED` 且零 artifact）⇒ **正好命中**
 *     → 回落确定性执行器**重跑**一次本应被硬拒的操作（绕审批闸意图）。
 *
 * 本文件因此必须**双向**证明（危害基准两条，缺一即不可验收）：
 *
 *   【A 不得误放行】策略硬拒（POLICY_DENIED / APPROVAL_REQUIRED / SESSION_*）
 *     零产物 ⇒ **不降级**，确定性执行器零调用；
 *   【B 不得误伤】真运行时不可用（PROVIDER_UNAVAILABLE / 真 EXECUTION_FAILED
 *     且非策略折叠来路）零产物 ⇒ **仍降级**（K2 修复的回退能力不得被本批改没了）。
 *
 * 以及【C 保真本身】：确定性模板路径上三闸类码可见（旧形态全是 EXECUTION_FAILED），
 * `reason` / `retryable` 保真，宿主可读文案零漂移。
 *
 * ## 纪律
 *
 * 不碰 VM / PowerShell / HTTP；import 构建产物（O-3 范式，见
 * `tests/helpers/bridge-internals.mjs`）。跑前先 `./node_modules/.bin/tsc -b tsconfig.build.json`。
 *
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase2-contract-code-fidelity.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBridgeInternals, loadDeterministicProvider } from '../helpers/bridge-internals.mjs';
import { WorkbuddyLlmProvider } from '../../packages/adapter-agent-workbuddy-llm/dist/index.js';

const TRACE = 'tr_p2t10_fidelity';

/* ============================ 夹具 ============================ */

/** 注册表视图（provider `implementationOf` 的权威源，与 phase1-t5-* 同形） */
const CAPABILITY_DEFS = new Map(
  [
    ['app.winget.search', { module: 'app', fn: 'Search-Winget' }],
    ['app.winget.install', { module: 'app', fn: 'Install-Winget' }],
    ['storage.cleanup.analyze', { module: 'storage', fn: 'Get-CleanupAnalysis' }],
    ['system.info.get', { module: 'system', fn: 'Get-SystemInfo' }],
    ['gui.screen.capture', { module: 'gui', fn: 'Get-ScreenCapture' }],
  ].map(([id, impl]) => [id, { implementation: { module: impl.module, function: impl.fn }, input: {}, timeoutMs: 5_000 }]),
);

/**
 * 假 ps-bridge：可按能力注入返回/抛出，用于构造「上游各种来路码」。
 * `throwOn` 命中时抛出 `Error & {code}`（走 provider 的 `toBridgeError` 三层规范化）。
 */
function makeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    running: true,
    async call(module, fn, params, timeoutMs) {
      const key = `${module}/${fn}`;
      calls.push(key);
      const ov = overrides[key];
      if (ov instanceof Error) throw ov;
      if (ov !== undefined) return ov;
      if (module === 'app') return fn === 'Search-Winget' ? [{ id: 'Foo.Bar', name: 'Foo' }] : { success: true };
      if (module === 'gui') return { data: 'AAAA', width: 1920, height: 1080 };
      return { ok: true, key };
    },
  };
}

function domainError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function makeCtx(bridge, policyEvaluate) {
  return {
    config: {},
    bridge,
    capabilityDefs: CAPABILITY_DEFS,
    policy: { evaluate: policyEvaluate ?? (() => ({ allowed: true, matchedRule: 'allow' })) },
    capabilities: {
      get: (id) => ({ id, risk: 'L1', requiresSession: false }),
      list: () => [...CAPABILITY_DEFS.keys()],
      size: () => CAPABILITY_DEFS.size,
      intersectDeclared: () => [],
    },
    audit: { append: async () => ({ auditId: 'aud' }), verifyChain: async () => ({ entries: 0, valid: true }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {} },
    newTraceId: () => TRACE,
  };
}

/** 跑一次确定性模板委派，返回 GoalResult（保码侧的观察点） */
async function runDeterministic(goal, { policy, bridgeOverrides } = {}) {
  const { createProvider } = await loadDeterministicProvider();
  const bridge = makeBridge(bridgeOverrides ?? {});
  const p = createProvider();
  await p.init(makeCtx(bridge, policy ? () => policy : undefined));
  const result = await p.runGoal(
    { traceId: TRACE, goal, timeoutMs: 30_000 },
    { onStatus: () => {}, onArtifact: () => {} },
  );
  await p.shutdown().catch(() => undefined);
  return { result, bridge };
}

/**
 * 假 LLM 桥：恒回指定的 `LlmGoalResult`（模拟「LLM 运行时的终态」）。
 * `error` 传 `undefined` 表示成功轮次。
 */
function llmBridge(error, artifacts = []) {
  return {
    setSessionConfig() {},
    setSessionLog() {},
    sessionHealth: () => ({ state: 'ready', restarts: 0, idleMs: 0 }),
    isPersistentEnabled: () => true,
    async runGoal() {
      return {
        ok: error ? false : true,
        summary: error ? 'LLM 轮次失败' : 'LLM 轮次成功',
        artifacts,
        steps: [],
        ...(error ? { error } : {}),
      };
    },
  };
}

/** 记账用的假确定性执行器（降级是否发生的唯一权威观察点） */
function countingExecutor() {
  const calls = { runGoal: 0, execute: 0 };
  return {
    calls,
    executor: {
      id: 'mock-deterministic',
      displayName: 'mock',
      kind: 'deterministic',
      declareCapabilities: () => ['app.*'],
      async init() {},
      async execute(req) {
        calls.execute += 1;
        return { traceId: req.traceId, ok: true, data: {}, artifacts: [], durationMs: 1 };
      },
      async runGoal() {
        calls.runGoal += 1;
        return { ok: true, summary: '降级重跑', artifacts: [], steps: [] };
      },
      async health() {
        return { ok: true };
      },
      async shutdown() {},
      dispose: () => {},
    },
  };
}

/**
 * 用真实 `WorkbuddyLlmProvider` 跑一次委派，返回 executor 被降级调用的次数。
 * @param {object|undefined} error 桥回的错误（`BridgeError` 形状）
 * @param {unknown[]} artifacts 桥回的产物（影响「零产物」判据）
 */
async function degradeCount(error, artifacts = []) {
  const { calls, executor } = countingExecutor();
  const p = new WorkbuddyLlmProvider({ bridge: llmBridge(error, artifacts), executor });
  await p.init(makeCtx(makeBridge()));
  const res = await p.runGoal(
    { traceId: TRACE, goal: '分析磁盘空间占用并给清理建议', timeoutMs: 30_000 },
    { onStatus: () => {}, onArtifact: () => {} },
  );
  await p.shutdown().catch(() => undefined);
  return { calls, res };
}

/* ============================ A 危害基准 1：策略硬拒不得降级 ============================ */

describe('P2-T10 危害基准 A：闸类契约码零产物 ⇒ 不降级（重跑等于绕闸）', () => {
  const denied = { code: 'POLICY_DENIED', message: '被策略拒绝：pathAllowlist:miss', retryable: false };

  test('A1 POLICY_DENIED（code）⇒ 确定性执行器零调用', async () => {
    const { calls, res } = await degradeCount(denied);
    assert.equal(calls.runGoal, 0, '★ 策略硬拒被当「运行时不可用」重跑 = 绕审批闸（O-1 危害面 1）');
    assert.equal(res.error.code, 'POLICY_DENIED', '不降级时错误原样透出到宿主/observer');
  });

  test('A2 残余折叠路径：EXECUTION_FAILED + reason=POLICY_DENIED ⇒ 不降级', async () => {
    // 来路：`adapter-agent-workbuddy#toBridgeError()` 第二层把领域码 POLICY_DENIED
    // 按 DOMAIN_CODE_TO_BASE 映射后把**原码写进 reason**。保码后正常不会到这儿，
    // 但判据必须自己守住 —— 否则任何一条新的折叠路径都会把洞重新打开（设计 §4.1 原子性要求）。
    const { calls } = await degradeCount({ code: 'EXECUTION_FAILED', message: '被策略拒绝', reason: 'POLICY_DENIED', retryable: false });
    assert.equal(calls.runGoal, 0, 'reason 维度也必须认闸类码（判据不能只看 code）');
  });

  test('A3 APPROVAL_REQUIRED / SESSION_UNAVAILABLE / SESSION_BLACK_SCREEN / TASK_CANCELED 同样不降级', async () => {
    for (const code of ['APPROVAL_REQUIRED', 'SESSION_UNAVAILABLE', 'SESSION_BLACK_SCREEN', 'TASK_CANCELED']) {
      const { calls } = await degradeCount({ code, message: `${code} 终态`, retryable: code === 'APPROVAL_REQUIRED' });
      assert.equal(calls.runGoal, 0, `${code} 是「按规则不该执行」的终态，不得重跑`);
    }
  });

  test('A4 证伪（K-10）：把闸类码换成真执行失败 ⇒ 同一夹具立刻降级 1 次', async () => {
    const { calls } = await degradeCount({ code: 'EXECUTION_FAILED', message: 'X', retryable: false });
    assert.equal(calls.runGoal, 1, '上一条 A1–A3 的零调用不是空断言 —— 差异只来自码/reason');
  });
});

/* ============================ B 危害基准 2：真不可用仍须降级（K2 不误伤） ============================ */

describe('P2-T10 危害基准 B：真运行时不可用零产物 ⇒ 仍降级（K2 回退能力保留）', () => {
  test('B1 PROVIDER_UNAVAILABLE（真：CLI 缺失）⇒ 降级 1 次', async () => {
    const { calls } = await degradeCount({ code: 'PROVIDER_UNAVAILABLE', message: 'LLM_RUNTIME_MISSING', retryable: true });
    assert.equal(calls.runGoal, 1);
  });

  test('B2 真 EXECUTION_FAILED 且无 reason（bridge.ts 的 LLM_PERSISTENT_TURN_FAILED / LLM_RUNTIME_EXIT_n 形态）⇒ 降级', async () => {
    for (const message of ['LLM_PERSISTENT_TURN_FAILED', 'LLM_RUNTIME_EXIT_1']) {
      const { calls } = await degradeCount({ code: 'EXECUTION_FAILED', message, retryable: false });
      assert.equal(calls.runGoal, 1, `真运行时失败（${message}）必须仍能回退确定性模板`);
    }
  });

  test('B3 真 EXECUTION_FAILED + 非闸类 reason（领域码 FILE_NOT_FOUND）⇒ 降级', async () => {
    const { calls } = await degradeCount({ code: 'EXECUTION_FAILED', message: '文件未找到', reason: 'FILE_NOT_FOUND', retryable: false });
    assert.equal(calls.runGoal, 1, 'reason 只在命中闸类集合时才拦降级，普通领域码不得被误判为策略折叠');
  });

  test('B4 EXECUTION_FAILED + 有产物 ⇒ 不降级（旧判据的「零产物」条件未被本批改没）', async () => {
    const { calls } = await degradeCount({ code: 'EXECUTION_FAILED', message: 'X', retryable: false }, [{ kind: 'file', name: 'a.txt', mime: 'text/plain', data: 'x', encoding: 'base64' }]);
    assert.equal(calls.runGoal, 0, '有产物说明执行体真干了活，重跑是重复劳动');
  });

  test('B5 K-12 红线：TIMEOUT 不降级（避免重复劳动）', async () => {
    const { calls } = await degradeCount({ code: 'TIMEOUT', message: 'LLM_PROVIDER_TIMEOUT', retryable: true });
    assert.equal(calls.runGoal, 0);
  });

  test('B6 K-12 红线：NO_EXECUTION_RECEIPT 改判不降级（调用点豁免仍生效）', async () => {
    const { calls, res } = await degradeCount({
      code: 'EXECUTION_FAILED',
      message: '执行回执缺失（服务端未记到执行成功）',
      reason: 'NO_EXECUTION_RECEIPT',
      retryable: false,
    });
    assert.equal(calls.runGoal, 0, '改判本身就是终态，重跑会把「假完成」洗成「降级重试成功」');
    assert.equal(res.error.reason, 'NO_EXECUTION_RECEIPT');
  });

  test('B7 K-12 红线：取消（TASK_CANCELED）不降级 —— 与 phase1-t5-* 三处对照同结论', async () => {
    const { calls } = await degradeCount({ code: 'TASK_CANCELED', message: 'LLM_TURN_CANCELED', reason: 'LLM_TURN_CANCELED', retryable: false });
    assert.equal(calls.runGoal, 0);
  });
});

/* ============================ C 保真：模板路径上闸类码可见 ============================ */

describe('P2-T10 O-1 保真：确定性模板路径保留来路契约码', () => {
  test('C1 策略硬拒（模板 2 磁盘分析）⇒ POLICY_DENIED，文案逐字不变', async () => {
    const { result } = await runDeterministic('分析磁盘空间占用并给清理建议', {
      policy: { allowed: false, matchedRule: 'pathAllowlist:miss' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'POLICY_DENIED', '旧形态是 EXECUTION_FAILED（折叠）⇒ 现须保码');
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.message, '被策略拒绝：pathAllowlist:miss', 'message 零漂移：宿主/链上文案面不受本批影响');
    assert.match(result.summary, /分析失败：被策略拒绝/, 'summary 仍携带上游可读文案');
  });

  test('C2 策略给出的自定义错误（verdict.error）⇒ code/reason/details 全保真', async () => {
    const { result } = await runDeterministic('获取系统信息', {
      policy: {
        allowed: false,
        matchedRule: 'custom',
        error: { code: 'APPROVAL_REQUIRED', message: '需批准：高危写操作', reason: 'NEED_APPROVAL', details: { approvalId: 'apr_1' }, retryable: true },
      },
    });
    assert.equal(result.error.code, 'APPROVAL_REQUIRED');
    assert.equal(result.error.reason, 'NEED_APPROVAL', 'reason 是运维按原因路由补救动作的唯一抓手，不得在模板层丢失');
    assert.deepEqual(result.error.details, { approvalId: 'apr_1' });
    assert.equal(result.error.retryable, true, '来路显式覆写的 retryable 不得被模板层改写');
  });

  test('C3 上游 VM 侧抛领域码 POLICY_DENIED ⇒ 经 toBridgeError 第一层保码到模板', async () => {
    // 分层实况（`adapter-agent-workbuddy#toBridgeError`，顺序敏感）：
    //   `POLICY_DENIED` 既在契约 10 码表（层①，原样透传、不带 reason），也在
    //   `DOMAIN_CODE_TO_BASE`（层②，映射并写 reason）。层①先命中 ⇒ reason 恒缺。
    //   故本例钉「码保真」这一实际可观测结论；reason 侧的闸类识别由 A2 用例覆盖
    //   （那里模拟的是「闸类码经某种路径落在 reason」的残余折叠，判据必须自己守住）。
    const { result } = await runDeterministic('获取系统信息', {
      bridgeOverrides: { 'system/Get-SystemInfo': domainError('POLICY_DENIED', 'VM 侧策略拒绝') },
    });
    assert.equal(result.error.code, 'POLICY_DENIED', '旧形态会是 EXECUTION_FAILED（丢码）');
    assert.equal(result.error.message, 'VM 侧策略拒绝', '上游 message 保真透传');
    assert.equal(result.error.retryable, false, 'POLICY_DENIED ⇒ DEFAULT_RETRYABLE=false');
  });

  test('C3b 上游 VM 侧抛映射型领域码（CLI_NOT_FOUND）⇒ EXECUTION_FAILED + reason 保真', async () => {
    // 非 10 码、但匹配领域码形态 ⇒ 层②：base code 兜底 + 原码入 reason。
    // 本例的价值是证明保码改造**没有把 reason 面弄丢**（真运行时失败的补救路由靠它）。
    const { result } = await runDeterministic('获取系统信息', {
      bridgeOverrides: { 'system/Get-SystemInfo': domainError('CLI_NOT_FOUND', 'winget 未安装') },
    });
    assert.equal(result.error.code, 'EXECUTION_FAILED', 'CLI_NOT_FOUND 不在最小映射表 ⇒ 仍兜底通用执行失败');
    assert.equal(result.error.reason, 'CLI_NOT_FOUND', 'reason 须保真（运维据此选补救动作）');
  });

  test('C4 GUI 会话闸（requiresSession 缺席路径由 execute 侧构造）⇒ 非 EXECUTION_FAILED 兜底', async () => {
    // 直接验 execute 面：会话守卫产 SESSION_UNAVAILABLE，step() 保码后模板须沿用。
    const { createProvider } = await loadDeterministicProvider();
    const bridge = makeBridge();
    const ctx = makeCtx(bridge);
    ctx.capabilities.get = (id) => ({ id, risk: 'L1', requiresSession: true });
    const p = createProvider();
    await p.init(ctx);
    // provider 无 VM ⇒ sessionHealth 归 unavailable ⇒ SESSION_UNAVAILABLE
    const res = await p.execute({ traceId: TRACE, capabilityId: 'gui.screen.capture', params: {}, risk: 'L1', approved: false });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'SESSION_UNAVAILABLE', '会话闸码不得被压成 EXECUTION_FAILED');
    assert.equal(res.error.retryable, true, 'SESSION_UNAVAILABLE 默认可重试（会话恢复后即可再来）');
    await p.shutdown().catch(() => undefined);
  });

  test('C5 无来路码（模板业务判定）⇒ 仍 EXECUTION_FAILED 且不带 reason —— 兜底未漂', async () => {
    const { result } = await runDeterministic('安装 NoSuchPkg 应用', { bridgeOverrides: { 'app/Search-Winget': [] } });
    assert.equal(result.error.code, 'EXECUTION_FAILED');
    assert.equal(result.error.reason, undefined);
    assert.match(result.error.message, /未找到与/);
  });

  test('C6 取消哨兵结构化（与 goalCanceled 同族码）⇒ TASK_CANCELED 而非字符串/EXECUTION_FAILED', async () => {
    const { createProvider } = await loadDeterministicProvider();
    const p = createProvider();
    await p.init(makeCtx(makeBridge()));
    const result = await p.runGoal(
      { traceId: TRACE, goal: '获取系统信息', timeoutMs: 30_000 },
      { onStatus: () => {}, onArtifact: () => {}, isCancelled: () => true },
    );
    assert.equal(result.error.code, 'TASK_CANCELED');
    assert.equal(result.steps.length, 0, '取消先于执行 ⇒ 无步骤记账');
    await p.shutdown().catch(() => undefined);
  });

  test('C7 端到端组合：真确定性执行器 + 策略硬拒 ⇒ LLM 层既不降级、宿主拿到 POLICY_DENIED', async () => {
    // 这是危害链的**完整闭环**证明（A 组用假桥证判据、C1–C6 证保码，本条把两端接起来）：
    // 桥失败 → 走真实 executor.runGoal 做降级（若命中判据就会真重跑一次被拒操作）。
    const { calls, executor } = countingExecutor();
    const { createProvider } = await loadDeterministicProvider();
    const real = createProvider();
    const denyCtx = makeCtx(makeBridge(), () => ({ allowed: false, matchedRule: 'pathAllowlist:miss' }));
    await real.init(denyCtx);
    // 用真确定性 provider 当 executor：它的 runGoal 会真发能力调用 ⇒ 若被降级即等于绕闸重跑
    const spy = { runGoal: 0 };
    const wrapped = { ...executor, runGoal: async (g, s) => { spy.runGoal += 1; return real.runGoal(g, s); } };
    const p = new WorkbuddyLlmProvider({
      bridge: llmBridge({ code: 'EXECUTION_FAILED', message: 'LLM_RUNTIME_EXIT_1', retryable: false }),
      executor: wrapped,
    });
    await p.init(makeCtx(makeBridge()));
    await p.runGoal({ traceId: TRACE, goal: '分析磁盘空间占用并给清理建议', timeoutMs: 30_000 }, { onStatus: () => {}, onArtifact: () => {} });
    assert.equal(spy.runGoal, 1, '真运行时失败 ⇒ 降级路径活着（本条前提是 B2 成立）');
    const denied = await real.runGoal({ traceId: TRACE, goal: '分析磁盘空间占用并给清理建议', timeoutMs: 30_000 }, { onStatus: () => {}, onArtifact: () => {} });
    assert.equal(denied.error.code, 'POLICY_DENIED', '降级链上拿到的失败码是真码，而非折叠后的 EXECUTION_FAILED');
    assert.equal(calls.runGoal, 0);
    await p.shutdown().catch(() => undefined);
    await real.shutdown().catch(() => undefined);
  });
});

/* ============================ D 守卫输入面：源码形状静态钉 ============================ */

describe('P2-T10 守卫输入面：折叠点必须真的消失（防「源码对、产物错」）', () => {
  test('D1 step() 不再出现 `res.error.message` 折叠（src 与 dist 双侧计数为 0）', async () => {
    const fs = await import('node:fs');
    const { repoPath } = await import('../helpers/bridge-internals.mjs');
    const src = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy', 'src', 'index.ts'), 'utf8');
    const dist = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy', 'dist', 'index.js'), 'utf8');
    const COLLAPSE = /error:\s*res\.error\.message/;
    assert.ok(!COLLAPSE.test(src), 'src 不得再出现 step() 的 message 折叠');
    assert.ok(!COLLAPSE.test(dist), '★ dist 同样不得有折叠 —— 只钉 src 会漏「源码对、产物错」');
    // 反向：双侧都必须存在结构化透传（否则说明改动被回滚或写错了地方）
    const STRUCTURED = /error:\s*res\.error\b/;
    assert.ok(STRUCTURED.test(src) && STRUCTURED.test(dist), 'step() 须结构化透传 BridgeError');
  });

  test('D2 shouldDegrade 的闸类排除集合与降级触发码不冲突（防集合漂移）', async () => {
    const bridge = await loadBridgeInternals();
    assert.equal(typeof bridge.reconcileApprovalWait, 'function', '桥内部面可经 helper 取到（O-3 范式生效）');
    const fs = await import('node:fs');
    const { repoPath } = await import('../helpers/bridge-internals.mjs');
    const src = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'src', 'index.ts'), 'utf8');
    const block = /const NON_DEGRADABLE_CODES[\s\S]*?\];/.exec(src);
    assert.ok(block, 'NON_DEGRADABLE_CODES 常量须存在');
    for (const code of ['POLICY_DENIED', 'APPROVAL_REQUIRED', 'SESSION_UNAVAILABLE', 'SESSION_BLACK_SCREEN', 'TASK_CANCELED']) {
      assert.ok(block[0].includes(`'${code}'`), `集合须含 ${code}`);
    }
    assert.ok(!block[0].includes('PROVIDER_UNAVAILABLE'), 'PROVIDER_UNAVAILABLE 是可降级码，混进排除集即误伤 K2');
    assert.ok(!block[0].includes("'EXECUTION_FAILED'"), 'EXECUTION_FAILED 不得整体排除（真运行时失败要降级）');
  });

  test('D3 同批原子性：保码在场**且**判据排除集在场（缺一即洞仍在）', async () => {
    // 设计 §4.1 的原子性要求：判据与消费点分两个任务改 ⇒ 中间窗口就是新的漏。
    // 本例不是重复 A/C 组的行为断言，而是**跨文件静态**钉「两侧都改了」：
    //   只改保码不改判据 ⇒ POLICY_DENIED 直判不在排除集内（旧判据本就不认它 ⇒ 不降级，
    //     表面没事），但 APPROVAL_REQUIRED/SESSION_* 一旦被某条路径压成 EXECUTION_FAILED
    //     就仍然命中降级；
    //   只改判据不改保码 ⇒ 模板仍产 EXECUTION_FAILED 且 reason 被抹 ⇒ 排除集救不了。
    // ⇒ 必须两侧同时在场。用 src↔dist 双侧计数，防「源码对、产物错」。
    const fs = await import('node:fs');
    const { repoPath } = await import('../helpers/bridge-internals.mjs');
    const sides = [
      { label: 'workbuddy/src', text: fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy', 'src', 'index.ts'), 'utf8') },
      { label: 'workbuddy/dist', text: fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy', 'dist', 'index.js'), 'utf8') },
      { label: 'llm/src', text: fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'src', 'index.ts'), 'utf8') },
      { label: 'llm/dist', text: fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'dist', 'index.js'), 'utf8') },
    ];
    for (const s of sides) {
      if (s.label.includes('workbuddy/')) {
        assert.ok(/templateError/.test(s.text), `${s.label}: 保码收口函数须在场`);
        assert.ok(!/error:\s*res\.error\.message/.test(s.text), `${s.label}: 折叠形态须已退场`);
      } else {
        assert.ok(/NON_DEGRADABLE_CODES/.test(s.text), `${s.label}: 降级排除集须在场`);
      }
    }
    // 反证（灵敏度自证）：把两侧标记都删掉的那份「假文本」必须过不了上面的断言
    const mutated = sides.map((s) => ({ ...s, text: s.text.replace(/templateError/g, 'x').replace(/NON_DEGRADABLE_CODES/g, 'y').replace(/error:\s*res\.error\b/g, 'error: res.error.message') }));
    let caught = 0;
    for (const s of mutated) {
      if (s.label.includes('workbuddy/')) {
        if (!/templateError/.test(s.text) || /error:\s*res\.error\.message/.test(s.text)) caught += 1;
      } else if (!/NON_DEGRADABLE_CODES/.test(s.text)) caught += 1;
    }
    assert.equal(caught, 4, '★ 守卫灵敏度：假文本（回滚两侧改动）须被逐侧捕获，否则本守卫是空断言');
  });
});
