/**
 * Hermes Agent Provider（adapter-agent-hermes）单元测试
 *
 * 关键约束：hermes 的 Windows 部署目录为只读（用户约定不可修改），
 * 因此 runGoal/execute 委托测试一律 registerMcp:false，避免触碰真实 hermes 配置。
 * MCP 注册逻辑由「独立 registrar 集成测试（临时 config）」单独覆盖。
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createProvider,
  PROVIDER_ID,
  HERMES_CLI_ARG_TEMPLATE,
  HermesMcpRegistrar,
} from '@winvm/adapter-agent-hermes';

function fakeCtx() {
  return {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'a' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: () => ({ risk: 'L1', requiresSession: false }),
      list: () => ['system.info.get', 'appops.gui.produce', 'gui.screen.capture'],
      has: () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    newTraceId: () => 'trace_' + Math.random().toString(36).slice(2),
  };
}

function fakeExecutor() {
  const calls = [];
  return {
    calls,
    id: 'fake-exec',
    kind: 'deterministic',
    displayName: 'fake',
    declareCapabilities: () => [],
    async init() {},
    async execute(req) {
      calls.push(req);
      return { traceId: req.traceId, ok: true, data: { echoed: req.capabilityId }, durationMs: 1 };
    },
    async health() {
      return { ok: true, provider: { id: 'fake', state: 'ready' }, session: {}, psBridge: { state: 'ready', uptimeMs: 1, pending: 0 } };
    },
    async shutdown() {},
  };
}

function mockBridge(ok) {
  return {
    async runGoal(input, sink) {
      sink.onStatus('working', 'mock step');
      if (!ok) {
        return { ok: false, summary: 'mock fail', artifacts: [], steps: [], error: { code: 'EXECUTION_FAILED', message: 'MOCK_FAIL' } };
      }
      return {
        ok: true,
        summary: 'mock ok',
        artifacts: [{ kind: 'file', name: 'out.png', mime: 'image/png', data: 'YWJj', encoding: 'base64' }],
        steps: [{ index: 0, capabilityId: 'appops.gui.produce', params: { goal: input.goal }, ok: true, risk: 'L1', durationMs: 1, traceId: input.traceId, summary: 'mock' }],
      };
    },
  };
}

function captureSink() {
  const statuses = [];
  return {
    statuses,
    onStatus(_s, m) { statuses.push(m); },
    onArtifact() {},
    async onApprovalRequired() { return true; },
  };
}

describe('HermesAgentProvider 基本契约', () => {
  test('createProvider 暴露 id=hermes-agent / kind=llm-agent', () => {
    const p = createProvider({ registerMcp: false, bridge: mockBridge(true), executor: fakeExecutor() });
    assert.equal(p.id, 'hermes-agent');
    assert.equal(p.kind, 'llm-agent');
    assert.equal(PROVIDER_ID, 'hermes-agent');
  });

  test('声明全能力域（与 workbuddy LLM provider 对齐）', () => {
    const p = createProvider({ registerMcp: false });
    const caps = p.declareCapabilities();
    for (const d of ['meta', 'system', 'app', 'storage', 'gui', 'appops']) {
      assert.ok(caps.includes(`${d}.*`), `应声明 ${d}.*`);
    }
  });

  test('HERMES_CLI_ARG_TEMPLATE 符合 v0.18.2 实测契约', () => {
    const t = HERMES_CLI_ARG_TEMPLATE.join(' ');
    for (const k of ['chat', '-q', '{prompt}', '-Q', '--yolo', '--source', 'winvm-bridge']) {
      assert.ok(t.includes(k), `模板应含 ${k}`);
    }
    assert.ok(!t.includes('--mcp'), 'hermes CLI 无 --mcp 参数，MCP 走预注册');
  });
});

describe('HermesAgentProvider runGoal / execute 委托', () => {
  test('runGoal 成功：注入 mock bridge → ok + artifact + step + 进度回传', async () => {
    const p = createProvider({ registerMcp: false, bridge: mockBridge(true), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const sink = captureSink();
    const res = await p.runGoal({ traceId: 't1', goal: '用 PS 把大山换成海洋', timeoutMs: 1000 }, sink);
    assert.equal(res.ok, true);
    assert.equal(res.artifacts.length, 1);
    assert.equal(res.artifacts[0].name, 'out.png');
    assert.equal(res.steps.length, 1);
    assert.ok(sink.statuses.length >= 1, '应回传进度');
  });

  test('runGoal 失败：注入失败 bridge → ok:false + error，不伪造', async () => {
    const p = createProvider({ registerMcp: false, bridge: mockBridge(false), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const res = await p.runGoal({ traceId: 't2', goal: '未知目标', timeoutMs: 1000 }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EXECUTION_FAILED');
  });

  test('execute 委托给确定性执行链路（复用 ps-bridge 内核）', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ registerMcp: false, bridge: mockBridge(true), executor: exec });
    await p.init(fakeCtx());
    const req = { traceId: 't3', capabilityId: 'gui.screen.capture', params: {}, risk: 'L1', approved: false, timeoutMs: 1000 };
    const r = await p.execute(req);
    assert.equal(r.ok, true);
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].capabilityId, 'gui.screen.capture');
  });

  test('health 在底层 ready 时返回 ready', async () => {
    const p = createProvider({ registerMcp: false, bridge: mockBridge(true), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const h = await p.health();
    assert.equal(h.ok, true);
    assert.equal(h.provider.id, 'hermes-agent');
  });
});

describe('HermesMcpRegistrar 集成（临时 config，不触碰真实 hermes）', () => {
  let dir;
  let cfgPath;

  async function fresh() {
    dir = await mkdtemp(join(tmpdir(), 'hermes-cfg-'));
    cfgPath = join(dir, 'config.yaml');
    await writeFile(cfgPath, 'hermes:\n  home: x\n', 'utf8');
  }

  test('ensureRegistered 幂等：首次 created，二次 noop，且 .env 写入 token', async () => {
    await fresh();
    const reg = new HermesMcpRegistrar({ configPath: cfgPath, url: 'http://127.0.0.1:18443/mcp', token: 'testtok', backup: false });
    const r1 = await reg.ensureRegistered();
    assert.equal(r1.ok, true);
    assert.equal(r1.action, 'created');
    assert.equal(r1.tokenEnvVar, 'MCP_WINVM_API_KEY');

    const cfg = await readFile(cfgPath, 'utf8');
    assert.match(cfg, /^mcp_servers:/m);
    assert.match(cfg, /winvm:/);
    assert.match(cfg, /url: http:\/\/127\.0\.0\.1:18443\/mcp/);
    assert.match(cfg, /Authorization: Bearer \$\{MCP_WINVM_API_KEY\}/);

    const env = await readFile(join(dir, '.env'), 'utf8');
    assert.match(env, /MCP_WINVM_API_KEY=testtok/);

    const r2 = await reg.ensureRegistered();
    assert.equal(r2.ok, true);
    assert.equal(r2.action, 'noop', '二次注册应幂等 noop');
  });

  test('init 时 registrar 失败仅告警、不阻断启动（降级）', async () => {
    const exec = fakeExecutor();
    // configPath 指向不存在的文件 → 读取失败 → ok:false；provider 应继续 init executor
    const p = createProvider({
      registerMcp: true,
      hermesConfigPath: join(tmpdir(), 'no-such-dir-xyz', 'config.yaml'),
      bridge: mockBridge(true),
      executor: exec,
    });
    // 不应抛异常
    await p.init(fakeCtx());
    const req = { traceId: 't4', capabilityId: 'gui.screen.capture', params: {}, risk: 'L1', approved: false, timeoutMs: 1000 };
    const r = await p.execute(req);
    assert.equal(r.ok, true, '降级后仍可经 executor 执行能力');
  });

  test('清理临时目录', async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
});
