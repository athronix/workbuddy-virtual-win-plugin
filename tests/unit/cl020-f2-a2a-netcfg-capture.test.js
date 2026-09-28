/**
 * CL-020 T3（A 项 F2）· A2A 通道也刷新 /health.netCfg.ageMs（集成 + 静态源码守卫）
 *
 * 背景（CL-019 遗留 advisory）：CL-019 项① 把 `system.network.config` 采集时间戳捕获写进
 * server.ts 的 MCP handler，但 **A2A 通道不经过该 handler**（A2A 走 provider.runGoal →
 * provider.execute，而非 MCP 的 handler 闭包），导致 A2A 路径 refresh 后 /health.netCfg.ageMs
 * 不回落。
 *
 * 修复（本变更）：捕获逻辑上移到 `adapter-agent-workbuddy` 的 `execute` 内，经注入的
 * `reportNetCfg` 回调上抛写入 server 侧 `netCfgCache`。MCP 与 A2A 两条路径共用同一 `execute`
 * （hermes / workbuddy-llm 的 execute 仅是 `this.executor.execute(req)` 委托），故单一 hook
 * 覆盖全通道。
 *
 * 本测试分两类：
 *   ① 静态源码守卫：server.ts 注入 reportNetCfg；adapter 在 execute 内调用 reportNetCfg；
 *      hermes / workbuddy-llm 的 execute 为 this.executor.execute(req) 委托。
 *   ② 集成断言（A2A funnel = execute）：构造 mock BridgeContext，直接调 provider.execute，
 *      断言 system.network.config 成功后 server 侧 reportNetCfg 被调用（写入 serverNetCfg）；
 *      其它 capability 调用时 reportNetCfg 不被调用（零副作用守卫）。
 *
 * 运行前置：`npm run build` 已重建 dist（本集成用例 import 的是构建产物
 * `packages/adapter-agent-workbuddy/dist/index.js`，与项目验证顺序「先 build 后 test」一致）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// 构建产物（import 真实 provider，跑 a2a funnel = execute）。
import { createProvider } from '../../packages/adapter-agent-workbuddy/dist/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SERVER = readFileSync(
  join(ROOT, 'packages', 'vm-service', 'src', 'server.ts'),
  'utf8',
);
const ADAPTER = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-workbuddy', 'src', 'index.ts'),
  'utf8',
);
const HERMES = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-hermes', 'src', 'index.ts'),
  'utf8',
);
const WORKBUDDY_LLM = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-workbuddy-llm', 'src', 'index.ts'),
  'utf8',
);

const COLLECTED_AT_FIXTURE = '2026-09-22T00:00:00.000Z';

/**
 * 构造 mock BridgeContext（含注入的 reportNetCfg，写入本地 serverNetCfg 镜像）。
 * 仅满足 provider.execute 所需的字段，不依赖 PowerShell / 真实 ps-bridge。
 *
 * @returns { ctx, serverNetCfg } ctx 供 init/execute；serverNetCfg 是 server 侧 netCfgCache 的镜像，
 *           reportNetCfg 被调用时即写入它（断言对象）。
 */
function makeMockCtx() {
  const serverNetCfg = { collectedAt: /** @type {string|undefined} */ (undefined), ok: false };
  const ctx = {
    config: {},
    // 注入的桥：call 直接回构造好的 netCfg 对象（含 collectedAt）。
    bridge: {
      call: async (_module, _fn, _params, _timeoutMs) => ({
        adapters: [],
        routes: [],
        cached: false,
        collectedAt: COLLECTED_AT_FIXTURE,
        cacheAgeMs: 0,
      }),
      running: true,
    },
    // 策略引擎：恒放行。
    policy: {
      evaluate: (_req) => ({ allowed: true, matchedRule: 'allow' }),
    },
    // 注册表视图：按 id 回最小定义；无 input → 跳过入参契约校验。
    capabilities: {
      get: (id) => ({ id, risk: 'L0', requiresSession: false }),
      list: () => [],
      size: () => 54,
      intersectDeclared: () => [],
    },
    // 审计链：append 返回固定 auditId。
    audit: {
      append: async () => ({ auditId: 'x' }),
      verifyChain: async () => ({ entries: 0, valid: true }),
    },
    // 日志：全部 noop。
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      close: () => {},
    },
    newTraceId: () => 't',
    // CL-020 F2：注入的采集时间戳上抛回调（单一数据源）。
    reportNetCfg: (collectedAt) => {
      serverNetCfg.collectedAt = collectedAt;
      serverNetCfg.ok = true;
    },
  };
  return { ctx, serverNetCfg };
}

describe('CL-020 F2 · 静态源码守卫', () => {
  test('server.ts 的 bridgeCtx 注入 reportNetCfg（单一数据源写入点）', () => {
    assert.ok(SERVER.includes('reportNetCfg'), 'server.ts 应注入 reportNetCfg');
    assert.ok(
      /reportNetCfg:\s*\(collectedAt:\s*string\)/.test(SERVER),
      'reportNetCfg 签名应为 (collectedAt: string) => void',
    );
    assert.ok(
      !/res\.ok && cap\.id === 'system\.network\.config'/.test(SERVER),
      'server.ts MCP handler 不得再含双写捕获分支（单一数据源）',
    );
  });

  test('adapter 在 execute 内调用 reportNetCfg（cast 模式读取，不扩契约接口）', () => {
    assert.ok(
      /capabilityId === 'system\.network\.config'/.test(ADAPTER),
      'adapter 应在 execute 内判定 req.capabilityId === system.network.config',
    );
    assert.ok(ADAPTER.includes('reportNetCfg'), 'adapter 应调用注入的 reportNetCfg');
    assert.ok(
      /this\.ctx as unknown as \{ reportNetCfg\?/.test(ADAPTER),
      'adapter 应以 cast 模式读取注入回调（不扩 BridgeContext 接口）',
    );
  });

  test('hermes / workbuddy-llm 的 execute 为 this.executor.execute(req) 委托（单 hook 全覆）', () => {
    assert.ok(
      /return this\.executor\.execute\(req\)/.test(HERMES),
      'hermes execute 应委托 this.executor.execute(req)',
    );
    assert.ok(
      /return this\.executor\.execute\(req\)/.test(WORKBUDDY_LLM),
      'workbuddy-llm execute 应委托 this.executor.execute(req)',
    );
  });
});

describe('CL-020 F2 · 集成断言（A2A funnel = execute）', () => {
  test('system.network.config 执行成功 → reportNetCfg 被调用并写入 serverNetCfg', async () => {
    const { ctx, serverNetCfg } = makeMockCtx();
    const p = createProvider();
    await p.init(ctx);

    const res = await p.execute({
      capabilityId: 'system.network.config',
      params: {},
      risk: 'L0',
      approved: true,
      timeoutMs: 5000,
      traceId: 't1',
    });

    assert.equal(res.ok, true, 'system.network.config 应执行成功');
    assert.equal(serverNetCfg.collectedAt, COLLECTED_AT_FIXTURE, 'reportNetCfg 应收到采集时间戳');
    assert.equal(serverNetCfg.ok, true, 'reportNetCfg 应将 ok 置为 true');
  });

  test('其它 capability（system.info.get）执行成功 → reportNetCfg 不被调用（零副作用守卫）', async () => {
    const { ctx, serverNetCfg } = makeMockCtx();
    const p = createProvider();
    await p.init(ctx);

    const res = await p.execute({
      capabilityId: 'system.info.get',
      params: {},
      risk: 'L0',
      approved: true,
      timeoutMs: 5000,
      traceId: 't2',
    });

    assert.equal(res.ok, true, 'system.info.get 应执行成功');
    assert.equal(serverNetCfg.collectedAt, undefined, '非 system.network.config 时 reportNetCfg 不应被调用');
    assert.equal(serverNetCfg.ok, false, '非 system.network.config 时 serverNetCfg.ok 应保持 false');
  });
});
