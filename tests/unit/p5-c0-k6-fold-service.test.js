/**
 * C0（Phase 5）· K6 折叠离线钉 —— 行为面（②③④组）
 *
 * 与 `p5-c0-k6-verdict-fold.test.js`（①⑤纯判据面）配套，本件在**真服务**上钉折叠的
 * 端到端行为：进程内 `registerProviderFactory`（loader 优先于动态 import）注入桩
 * provider，其 execute 返回**可控 data**（复刻 psmod K6 回执形态，信封恒 ok=true =
 * 进程级送达），经真 HTTP `tools/call` 走 `executeCapability` 全链：
 *
 *  ② 行为面：`data.success=false` ⇒ 回执 `ok:false` + `isError:true` +
 *    `error.code=EXECUTION_FAILED` + `reason=K6_VERIFY_FAILED` + message 含残留证据截断；
 *    `data.success=true` / 无 success 键 ⇒ **逐字旧形态**（向后兼容面，无 error 块）；
 *  ③ receiptCache/K5 链：折叠后 `GET /audit/receipt` 环形缓存条目 `ok=false`
 *    （record 在折叠后 ⇒ 缓存与呈报同源；data 仍在场 = 残留证据不吞）；
 *  ④ `toExecutedResult` 零改动复用钉：折叠回执（isError=true+ok=false）⇒ 产出
 *    `ok:false` + 失败摘要含 K6 文案（重放/委派转呈链据此诚实改判，函数本体未动）；
 *  ②b provider 自报失败（信封 res.ok=false 且 data.success=false）⇒ 不覆盖 provider
 *    自家 error（只翻转 res.ok=true 的假成功）；
 *  接线形态静态钉：折叠调用位于 receiptCache.record 之前（时序契约，防重构回退）。
 *
 * 纪律：不起 ps-bridge（桩 provider 零 PowerShell）；单端口独立；只跑本文件。
 *   node --test tests/unit/p5-c0-k6-fold-service.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_SERVICE_CONFIG, registerProviderFactory, unregisterProviderFactory } from '@winvm/core';
import { createService, toExecutedResult } from '@winvm/vm-service';

const PROVIDER_ID = 'winvm-p5-c0-fold';
const PORT = 19531;
const BASE = `http://127.0.0.1:${PORT}`;

/** 可变指令：before() 之后每个用例置 provider.execute 要返回的 data 形态。 */
const state = { data: undefined, failEnvelope: undefined };

function makeStubProvider() {
  let ctx;
  return {
    id: PROVIDER_ID,
    displayName: 'WinVM P5-C0 Fold Stub Provider',
    kind: 'deterministic',
    declareCapabilities() {
      return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
    },
    async init(injected) {
      ctx = injected;
      state.ctx = injected;
    },
    async execute(req) {
      // 信封恒 ok=true（进程级送达），成败完全由 data 表达 —— 正是 C0 病灶形态。
      // state.failEnvelope 在场时模拟 provider 自报失败（信封 false + 自家 error）。
      return {
        traceId: req.traceId,
        ok: state.failEnvelope ? false : true,
        data: state.data,
        durationMs: 1,
        ...(state.failEnvelope ? { error: state.failEnvelope } : {}),
      };
    },
    async runGoal(goal, sink) {
      sink.onStatus('working', 'p5-c0 stub');
      return { ok: true, summary: 'p5-c0 stub goal', artifacts: [], steps: [] };
    },
    async health() {
      return { ok: true, provider: { id: PROVIDER_ID, state: 'ready' }, session: {} };
    },
    async shutdown() {},
  };
}

async function callTool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e6),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  return body?.result;
}

/* ==================== 服务装配 ==================== */

describe('C0-②③④ K6 折叠服务级行为钉（桩 provider + 真 HTTP /mcp）', () => {
  let runtime;
  let auditDir;

  before(async () => {
    auditDir = mkdtempSync(join(tmpdir(), 'winvm-p5c0-'));
    registerProviderFactory(PROVIDER_ID, () => makeStubProvider());
    runtime = await createService({
      ...DEFAULT_SERVICE_CONFIG,
      server: { host: '127.0.0.1', port: PORT },
      audit: { dir: auditDir, redactParams: true },
      agent: {
        provider: PROVIDER_ID,
        providers: { ...DEFAULT_SERVICE_CONFIG.agent.providers, [PROVIDER_ID]: { package: '@winvm/e2e-inprocess', options: {} } },
      },
    });
  });

  after(async () => {
    if (runtime) await runtime.close();
    unregisterProviderFactory(PROVIDER_ID);
  });

  /* -------- ② 行为面：折叠翻转 -------- */

  test('data.success=false（真实 K6 失败回执形态）⇒ 回执 ok:false + isError:true + EXECUTION_FAILED + reason=K6_VERIFY_FAILED', async () => {
    state.failEnvelope = undefined;
    state.data = {
      id: 'WXWork',
      dryRun: false,
      exitCode: 0,
      success: false,
      verified: { exeGone: false, dirGone: null, registryGone: false, installerType: 'NSIS' },
      fallbackUsed: true,
      residualEvidence: '残留 exe: C:\\Program Files\\WXWork\\WXWork.exe；残留键: HKLM\\...\\Uninstall\\WXWork',
      output: ['[k6] verify: passed=false'],
    };
    const r = await callTool('system.info.get', {});
    assert.equal(r.isError, true, '折叠必须置 isError');
    const sc = r.structuredContent;
    assert.equal(sc.ok, false, '信封 ok 必须被折叠为 false（呈报面诚实的根判定位）');
    assert.equal(sc.error?.code, 'EXECUTION_FAILED', '复用契约既有码，不新增码');
    assert.equal(sc.error?.reason, 'K6_VERIFY_FAILED', 'K6 折叠原因码在册（CL-017 reason 先例形态）');
    assert.equal(sc.error?.retryable, false, 'EXECUTION_FAILED 默认可重试语义保持');
    assert.ok(sc.error?.message.includes('执行器自报未成功（K6 核验未过）'), `message 含基干：${sc.error?.message}`);
    assert.ok(sc.error?.message.includes('残留证据'), `message 含残留证据段：${sc.error?.message}`);
    assert.ok(sc.error?.message.includes('WXWork.exe'), '证据内容进文案（截断后原样）');
    // data 原样保留（verified/residualEvidence 不吞）
    assert.equal(sc.data.success, false, 'data 载荷不被折叠改写');
    assert.ok(sc.data.residualEvidence, 'residualEvidence 不吞');
    assert.ok(sc.data.verified, 'verified 三态不吞');
    assert.equal(typeof sc.traceId, 'string', 'traceId 面保持');
    assert.equal(typeof sc.durationMs, 'number', 'durationMs 面保持');
  });

  test('residualEvidence 超长 ⇒ message 截断（防回执膨胀），但 data 原样不截', async () => {
    state.failEnvelope = undefined;
    state.data = { success: false, residualEvidence: ['R'.repeat(300)] };
    const r = await callTool('system.info.get', {});
    const sc = r.structuredContent;
    assert.equal(sc.ok, false);
    const msg = sc.error?.message ?? '';
    const seg = msg.slice(msg.indexOf('残留证据: '));
    assert.ok(seg.length <= '残留证据: '.length + 201 + 2, `证据段须截断在近上限，实得 ${seg.length}`);
    assert.ok(msg.endsWith('…'), '截断标记在 message 尾部显形');
    assert.equal(sc.data.residualEvidence[0].length, 300, 'data 载荷不被截断（呈报截≠数据截）');
  });

  test('data.success=true ⇒ 逐字旧形态（ok:true、无 error 块）——向后兼容面', async () => {
    state.failEnvelope = undefined;
    state.data = { id: 'WXWork', dryRun: false, exitCode: 0, success: true, verified: { passed: true }, fallbackUsed: false };
    const r = await callTool('system.info.get', {});
    assert.equal(r.isError, false, 'success=true 不得被折叠');
    const sc = r.structuredContent;
    assert.equal(sc.ok, true);
    assert.equal('error' in sc, false, '未折叠 ⇒ 不得凭空造 error 块');
  });

  test('data 无 success 键（其它 53 能力的普通回执）⇒ 逐字旧形态——通用零误伤面', async () => {
    state.failEnvelope = undefined;
    state.data = { summary: 'ok', items: [1, 2, 3] };
    const r = await callTool('system.info.get', {});
    assert.equal(r.isError, false);
    const sc = r.structuredContent;
    assert.equal(sc.ok, true);
    assert.equal('error' in sc, false);
    assert.deepEqual(sc.data.items, [1, 2, 3]);
  });

  test('success:"false"（字符串）/ success:0 ⇒ 不折叠（严格判据端到端面）', async () => {
    for (const v of ['false', 0]) {
      state.failEnvelope = undefined;
      state.data = { success: v };
      const r = await callTool('system.info.get', {});
      assert.equal(r.structuredContent.ok, true, `success=${String(v)} 不得端到端触发折叠`);
      assert.equal(r.isError, false);
    }
  });

  test('provider 自报失败（信封 ok=false + 自家 error）⇒ 自家 error 不被覆盖（折叠只翻转假成功）', async () => {
    state.failEnvelope = { code: 'TIMEOUT', message: 'ps-bridge 超时', retryable: true };
    state.data = { success: false };
    const r = await callTool('system.info.get', {});
    assert.equal(r.isError, true);
    const sc = r.structuredContent;
    assert.equal(sc.ok, false, '信封已假 ⇒ 保持假（不翻案）');
    assert.equal(sc.error?.code, 'TIMEOUT', 'provider 自家码原样透传，不被 EXECUTION_FAILED 覆盖');
    assert.equal(sc.error?.reason, undefined, '自家 error 不被贴 K6 标签（K6 文案只属于被翻转的假成功）');
    state.failEnvelope = undefined;
  });

  /* -------- ③ receiptCache / K5 链：record 折叠后 ok -------- */

  test('折叠命中 ⇒ /audit/receipt 环形缓存条目 ok=false（缓存与呈报同源）', async () => {
    state.failEnvelope = undefined;
    state.data = { success: false, residualEvidence: 'exe 残留: WXWork.exe' };
    const r = await callTool('system.info.get', {});
    const traceId = r.structuredContent.traceId;
    assert.ok(traceId, '回执须带 traceId（缓存键）');
    // 审计落盘是异步 best-effort；轮询端点直至环形缓存条目可见（≤3s）。
    let receipts = [];
    const deadline = Date.now() + 3_000;
    for (;;) {
      const res = await fetch(`${BASE}/audit/receipt?traceId=${encodeURIComponent(traceId)}`);
      const body = await res.json();
      receipts = body?.receipts ?? [];
      if (receipts.length > 0 || Date.now() >= deadline) break;
      await new Promise((rr) => setTimeout(rr, 120));
    }
    assert.equal(receipts.length, 1, `回执缓存应命中一条：${JSON.stringify(receipts)}`);
    assert.equal(receipts[0].ok, false, '★ record 消费折叠后 ok（C0-1 时序契约的观测面）');
    assert.equal(receipts[0].capabilityId, 'system.info.get');
    // data 在场（残留证据不吞；脱敏/裁剪由 ReceiptCache 既有纪律负责）
    assert.ok(JSON.stringify(receipts[0].data).includes('success'), '缓存 data 仍携带 success 位');
  });

  /* -------- ④ toExecutedResult 零改动复用钉 -------- */

  test('toExecutedResult 消费折叠回执 ⇒ ok:false + 失败摘要含 K6 文案（重放/委派转呈链自动诚实）', () => {
    const folded = {
      isError: true,
      structuredContent: {
        traceId: 'tr_fold_reuse',
        ok: false,
        risk: 'L2',
        data: { success: false },
        durationMs: 1,
        error: {
          code: 'EXECUTION_FAILED',
          message: '执行器自报未成功（K6 核验未过）；残留证据: exe 残留',
          reason: 'K6_VERIFY_FAILED',
          retryable: false,
        },
      },
    };
    const res = toExecutedResult('app.winget.uninstall', folded);
    assert.equal(res.ok, false, 'sc.ok=false ⇒ toExecutedResult 诚实改判（零改动）');
    assert.ok(res.summary.includes('执行未成功'), `摘要须为失败形：${res.summary}`);
    assert.ok(res.summary.includes('K6 核验未过'), `摘要携带 K6 文案：${res.summary}`);
    assert.equal(res.error, folded.structuredContent.error.message, 'error 原因透传（桥据此改判）');
    // 反向对照：未折叠（success=true）回执仍产成功摘要（复用不破坏旧语义）
    const okRes = toExecutedResult('app.winget.uninstall', {
      isError: false,
      structuredContent: { traceId: 'tr_ok', ok: true, data: { success: true } },
    });
    assert.equal(okRes.ok, true);
    assert.ok(okRes.summary.includes('执行成功'));
  });

  /* -------- 接线形态静态钉（时序契约：折叠在 record 前） -------- */

  test('server.ts 折叠接线形态：foldK6Verdict 调用先于 receiptCache.record、isError 消费 fold', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'packages', 'vm-service', 'src', 'server.ts'),
      'utf8',
    );
    const foldAt = src.indexOf('const fold = foldK6Verdict(res.ok, res.data)');
    const recordAt = src.indexOf('receiptCache.record(res.traceId, cap.id, fold.ok, res.data)');
    assert.notEqual(foldAt, -1, 'executeCapability 必须调 foldK6Verdict（折叠单点）');
    assert.notEqual(recordAt, -1, 'receiptCache.record 必须消费 fold.ok（缓存记折叠后）');
    assert.ok(foldAt < recordAt, '★ 折叠必须发生在 record 之前（C0-1 时序契约）');
    assert.match(src, /isError: fold\.isError/, 'isError 必须消费折叠结果');
    assert.match(src, /ok: fold\.ok/, 'structuredContent.ok 必须消费折叠结果');
    assert.match(src, /reason: 'K6_VERIFY_FAILED'/, 'error 块携带 K6 原因码（接线在位）');
    // 旧未折叠形态不得回潮
    assert.equal(src.includes('receiptCache.record(res.traceId, cap.id, res.ok, res.data)'), false, 'record 不得退回未折叠 res.ok');
    assert.equal(
      /return \{\s*isError: !res\.ok/.test(src),
      false,
      '执行段 return 不得退回 isError:!res.ok（绕过折叠）',
    );
  });
});
