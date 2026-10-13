/**
 * Phase 3 批3 · M4/M8：宿主桥 `audit.receipt` 工具 + 直调审批载荷 TTL 槽。
 * 纯 stdlib；fetch 经 globalThis 替身注入；逐文件跑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const TOOLS = pathToFileURL(join(ROOT, 'packages', 'host-a2a-bridge', 'dist', 'tools.js')).href;

function fakeClientProvider() {
  return { get: async () => ({}) };
}

async function makeTools(extra = {}) {
  const { createA2aBridgeTools } = await import(TOOLS);
  const tools = createA2aBridgeTools({
    clientProvider: fakeClientProvider(),
    baseUrl: 'http://127.0.0.1:18443',
    ...extra,
  });
  const receipt = tools.find((t) => t.name === 'audit.receipt');
  assert.ok(receipt, 'audit.receipt 必须在工具表内（6 工具=5 旧+1 新）');
  assert.equal(tools.length, 6, `工具表应恰 6 件（delegate/taskGet/approvalReply/cancel/health/receipt），实得 ${tools.length}`);
  return receipt;
}

const ctx = { traceId: 'tr_test' };

describe('P3-b3 · audit.receipt 桥工具（M4）', () => {
  const savedFetch = globalThis.fetch;
  test.afterEach(() => {
    globalThis.fetch = savedFetch;
    delete process.env.WINVM_TEST_BEARER;
  });

  test('缺 traceId ⇒ INVALID_PARAMS（不出网）', async () => {
    const receipt = await makeTools();
    const r = await receipt.handler({}, ctx);
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'INVALID_PARAMS');
  });

  test('stdio 无 baseUrl ⇒ TRANSPORT_UNSUPPORTED（诚实归因而非谎报隧道死）', async () => {
    const { createA2aBridgeTools } = await import(TOOLS);
    const tools = createA2aBridgeTools({ clientProvider: fakeClientProvider() });
    const receipt = tools.find((t) => t.name === 'audit.receipt');
    const r = await receipt.handler({ traceId: 'tr_x' }, ctx);
    assert.equal(r.structuredContent.error.code, 'TRANSPORT_UNSUPPORTED');
  });

  test('tokenEnv 给出但变量未设值 ⇒ AUTH_REQUIRED fail-loud（与 establishTransport 同三态纪律，绝不静默降级无凭据请求）', async () => {
    let reachedFetch = false;
    globalThis.fetch = async () => {
      reachedFetch = true;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const receipt = await makeTools({ bearerTokenEnv: 'WINVM_TEST_BEARER' });
    const r = await receipt.handler({ traceId: 'tr_x' }, ctx);
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'AUTH_REQUIRED');
    assert.equal(reachedFetch, false, 'fail-loud 必须在出网之前');
  });

  test('凭据头正确拼装：tokenEnv 设值 ⇒ authorization: Bearer 值', async () => {
    process.env.WINVM_TEST_BEARER = 'sekrit-token';
    let seenHeaders = null;
    globalThis.fetch = async (url, init) => {
      seenHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ records: [{ seq: 1 }], receipts: [] }),
      };
    };
    const receipt = await makeTools({ bearerTokenEnv: 'WINVM_TEST_BEARER' });
    const r = await receipt.handler({ traceId: 'tr_deleg_1' }, ctx);
    assert.equal(seenHeaders['authorization'], 'Bearer sekrit-token');
    assert.equal(r.structuredContent.ok, true);
    assert.equal(r.structuredContent.recordCount, 1);
  });

  test('VM 401（enforceBearer 开了但本桥没配）⇒ AUTH_REQUIRED 如实归因', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{}' });
    const receipt = await makeTools();
    const r = await receipt.handler({ traceId: 'tr_x' }, ctx);
    assert.equal(r.structuredContent.error.code, 'AUTH_REQUIRED');
  });

  test('未命中（records 空）⇒ ok:true + 计数 0 + 人话区分"链上为空才是硬未发生"（非 4xx 语义保持）', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ traceId: 'tr_x', records: [], receipts: [] }),
    });
    const receipt = await makeTools();
    const r = await receipt.handler({ traceId: 'tr_x' }, ctx);
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.recordCount, 0);
    assert.match(r.content[0].text, /链上为空才是硬未发生/);
  });

  test('回执体含凭据键 ⇒ 呈现面脱敏（scrub 与审批卡同族纪律）', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        records: [{ msg: 'password=hunter2 出现于参数' }],
        receipts: [],
      }),
    });
    const receipt = await makeTools();
    const r = await receipt.handler({ traceId: 'tr_x' }, ctx);
    const body = JSON.stringify(r.structuredContent);
    assert.doesNotMatch(body, /hunter2/, '凭据值不得出现在回执');
  });

  test('fetch 抛错（隧道断）⇒ TUNNEL_UNAVAILABLE 既有码复用', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:18443');
    };
    const receipt = await makeTools();
    const r = await receipt.handler({ traceId: 'tr_x' }, ctx);
    assert.equal(r.structuredContent.error.code, 'TUNNEL_UNAVAILABLE');
  });

  test('readOnlyHint 标注在位（安全属性：只读工具不得标可写）', async () => {
    const receipt = await makeTools();
    assert.equal(receipt.annotations.readOnlyHint, true);
    assert.equal(receipt.annotations.destructiveHint, false);
  });
});

describe('P3-b3 · 直调审批载荷 TTL 槽（M8）', () => {
  test('server.ts APPROVAL_REQUIRED 载荷含条件 ttl 键源（静态钉：expiresAtMs 表达式在位且受 Infinity 保护）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(ROOT, 'packages', 'vm-service', 'src', 'server.ts'), 'utf8');
    assert.match(
      src,
      /Number\.isFinite\(pendingApprovals\.ttl\)[\s\S]{0,160}expiresAtMs: Date\.now\(\) \+ pendingApprovals\.ttl/,
      'M8 TTL 槽必须有限 TTL 才写 expiresAtMs（Infinity ⇒ 键缺席=旧形状）',
    );
  });
});
