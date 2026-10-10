/**
 * Phase 2 · P2-T4 —— `ToolContext.signal` 接通（ARCH-29：宿主 HTTP 断连即中止在途能力调用）
 *
 * 钉死四件事（缺一不可）：
 *   ① **断连 ⇒ abort ⇒ 取消语义**三层贯通：传输层（`watchClientDisconnect`）→
 *      框架层（`callTool` 的判据 1/2 + `CANCELED_TEXT`）→ 执行侧（`provider.execute` 的
 *      边界闸与 `PSBRIDGE_CANCELED` → `TASK_CANCELED` 映射）。
 *   ② **缺席即旧行为**：stdio / 双参调用 / 不传 opts ⇒ `ToolContext` 键集与形态逐字不变，
 *      ps-bridge 走既有 4 参路径（零回归）。
 *   ③ **中止强度如实**：取消口径只说「本地停止等待」，`inFlightMayContinue:true` 必须在场；
 *      **任何**「已强杀 VM 内进程 / 未执行任何变更」式表述都不得出现（不实陈述）。
 *   ④ **监听器随 settle 摘除**：框架 `raceAbort` 与桥 `rawCall` 都必须在 settle 后
 *      `removeEventListener`（HTTP keep-alive 复用同一 signal ⇒ 否则无界增长）。
 *
 * 关键反证（K-10「永绿守卫等于没有守卫」）：
 *   - `close` 但 `writableEnded===true`（**正常写完**）**绝不许** abort —— 只挂 `close` 的实现
 *     会把每一次成功调用读成取消（假取消，比漏报更严重）。本文件用**真实 HTTP 服务器**
 *     分别覆盖「客户端中途 destroy」与「正常收到完整响应」两态，让这条判据被现实证伪。
 *   - 取消**不得**折叠成 `EXECUTION_FAILED`：LLM 层 `shouldDegrade` 会把
 *     「EXECUTION_FAILED 且零 artifact」判为运行时不可用并**回落确定性执行器重跑**
 *     （CL-022 3a / K-12 降级红线）。
 *
 * 纪律：不碰 VM / PowerShell / 真服务（`createService` 在本沙箱会 spawn ps-bridge 并触发
 *       原生 fatal，见 `k5-replay.test.js` 头注同类先例）。import 构建产物 ⇒ 跑前须
 *       `tsc -b tsconfig.build.json`（K-3）。真实 HTTP 用例只绑 127.0.0.1（loopback）。
 *
 * 运行（逐文件，绝不整批 glob，K-2）：
 *   node --test tests/unit/phase2-mcp-signal.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import { EventEmitter } from 'node:events';

import { McpServer, CANCELED_TEXT } from '@winvm/mcp-framework';
import { PsBridge } from '@winvm/vm-capabilities';
import { createProvider as createDeterministic } from '../../packages/adapter-agent-workbuddy/dist/index.js';
import {
  watchClientDisconnect,
  buildMcpRequestContext,
} from '../../packages/vm-service/dist/mcp-transport.js';

/* ============================ 夹具 ============================ */

/** 最小 JSON-RPC tools/call 请求体 */
const callBody = (name = 'demo', args = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

/**
 * 可编排 handler：`gate` 决定它是「自消费 signal 提前返回」还是「不消费 signal 被兜底竞速打断」。
 * `invocations` 记录**真实发起次数**（判据 1 的零副作用探针）。
 */
function makeTool(gate, opts = {}) {
  const invocations = [];
  const handler = async (params, ctx) => {
    invocations.push(ctx);
    if (opts.throwsAbortError) {
      const err = new Error('宿主连接断开，工具调用已中止');
      err.name = 'AbortError';
      throw err;
    }
    // 等 signal，或等一个足够长的固定时延（供兜底竞速先落地）
    await new Promise((resolve) => {
      const t = setTimeout(resolve, opts.delayMs ?? 30);
      if (opts.selfConsume && ctx.signal) {
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      }
    });
    return { structuredContent: { ok: true, selfConsumed: opts.selfConsume === true } };
  };
  return { handler, invocations };
}

async function makeServer(gate, toolName = 'demo') {
  const srv = new McpServer({
    name: 'p2t4-test',
    version: '0.0.0',
    tools: [{ name: toolName, description: '测试工具', inputSchema: {}, handler: gate.handler }],
  });
  return srv;
}

/** 数监听器的**替身 signal**：只实现框架/桥真正使用的三个成员，用于摘除断言（④）。 */
function makeCountingSignal() {
  const added = [];
  const removed = [];
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    addEventListener(_ev, fn) {
      added.push(fn);
    },
    removeListener: undefined,
    removeEventListener(_ev, fn) {
      removed.push(fn);
    },
    fire() {
      aborted = true;
      for (const fn of added.slice()) fn();
    },
    stats: () => ({ added: added.length, removed: removed.length, live: added.length - removed.length }),
  };
}

/**
 * 真实可中止的假 ps-bridge（供执行侧三层贯通用例）：
 * `call` 的第 5 参 `opts.signal` **必须被消费** —— abort 时按 `PSBRIDGE_CANCELED` 拒绝，
 * 与真实 `PsBridge.rawCall` 同一契约形状（下面 PsBridge 真身用例另行自证）。
 */
function makeSignalBridge(holdMs = 50) {
  const writes = [];
  const state = { inFlight: 0 };
  return {
    writes,
    state,
    get pendingCount() {
      return state.inFlight;
    },
    running: true,
    health: () => ({ state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 1 }),
    async call(module, fn, params, timeoutMs, opts) {
      writes.push({ module, fn, params, timeoutMs, hasOpts: opts !== undefined });
      const signal = opts?.signal;
      if (signal?.aborted === true) {
        throw bridgeCanceled('派发前宿主连接已断开');
      }
      state.inFlight += 1;
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, holdMs);
          if (!signal) return;
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(bridgeCanceled('宿主连接已断开'));
            },
            { once: true },
          );
        });
      } finally {
        state.inFlight -= 1;
      }
      return { ok: true, module, fn };
    },
  };
}

function bridgeCanceled(cause) {
  const e = new Error(`调用已中止：${cause}；本地停止等待，VM 内已下发的操作可能仍在继续（协作式中止，非强杀）。`);
  e.code = 'PSBRIDGE_CANCELED';
  e.details = { canceled: true, inFlightMayContinue: true };
  return e;
}

/** 确定性 provider 的注入上下文（与 `phase1-t5-provider-cancel` 同构） */
const CAPABILITY_IDS = ['system.info.get', 'gui.screen.capture'];

function makeCtx(bridge) {
  return {
    config: {},
    bridge,
    capabilityDefs: new Map(
      CAPABILITY_IDS.map((id) => [id, { implementation: { module: id.split('.')[0], function: 'Noop' }, input: {}, timeoutMs: 5_000 }]),
    ),
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'allow' }) },
    capabilities: {
      get: (id) => ({ id, risk: 'L1', requiresSession: false }),
      list: () => [...CAPABILITY_IDS],
      size: () => CAPABILITY_IDS.length,
      intersectDeclared: () => [],
    },
    audit: {
      append: async () => ({ auditId: 'aud_p2t4' }),
      verifyChain: async () => ({ entries: 0, valid: true }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {} },
    newTraceId: () => 'tr_p2t4',
  };
}

async function withProvider(bridge, fn) {
  const p = createDeterministic();
  await p.init(makeCtx(bridge));
  try {
    return await fn(p);
  } finally {
    await p.shutdown().catch(() => undefined);
  }
}

const BASE_REQ = {
  traceId: 'tr_p2t4',
  capabilityId: 'system.info.get',
  params: {},
  risk: 'L1',
  approved: false,
  timeoutMs: 5_000,
};

/* ==================== ①′ 传输层：断连侦测判据（含反证） ==================== */

describe('P2-T4 传输层：watchClientDisconnect 的 close 双条件判据', () => {
  test('close 且未正常写完 ⇒ signal abort（断连的真实形态）', () => {
    const res = new EventEmitter();
    res.writableEnded = false;
    const watch = watchClientDisconnect(res);
    assert.equal(watch.signal.aborted, false, '挂上监听时不得立刻 abort');
    res.emit('close');
    assert.equal(watch.signal.aborted, true, '宿主中途走开 ⇒ 必须 abort');
    watch.dispose();
  });

  test('★ 反证：close 但 writableEnded===true（**正常写完**）⇒ 绝不 abort（防假取消）', () => {
    const res = new EventEmitter();
    res.writableEnded = true;
    const watch = watchClientDisconnect(res);
    res.emit('close');
    assert.equal(
      watch.signal.aborted,
      false,
      'Node 里成功响应结束同样触发 close；只看 close 的实现会把每次成功调用读成取消',
    );
    watch.dispose();
  });

  test('dispose() 摘除 close 监听 ⇒ 之后 emit close 不再影响（收口纪律）', () => {
    const res = new EventEmitter();
    res.writableEnded = false;
    const watch = watchClientDisconnect(res);
    watch.dispose();
    assert.equal(res.listenerCount('close'), 0, 'dispose 必须摘干净（长连接上不得残留）');
    res.emit('close');
    assert.equal(watch.signal.aborted, false, 'dispose 后不得再有 abort 副作用');
  });

  test('dispose() 幂等（重复调用不得抛）', () => {
    const res = new EventEmitter();
    res.writableEnded = false;
    const watch = watchClientDisconnect(res);
    watch.dispose();
    watch.dispose();
    assert.equal(res.listenerCount('close'), 0);
  });

  test('reqCtx 装配：dtid/signal 都缺席 ⇒ undefined（双参旧调用形态逐字节不变）', () => {
    assert.equal(buildMcpRequestContext(undefined, undefined), undefined);
    assert.equal(buildMcpRequestContext(), undefined);
  });

  test('reqCtx 装配：只有 dtid ⇒ 不含 signal 键（纯附加，禁显式 undefined）', () => {
    const ctx = buildMcpRequestContext('dt_1');
    assert.deepEqual(Object.keys(ctx), ['delegationId'], '键集必须恰为 delegationId');
  });

  test('reqCtx 装配：只有 signal ⇒ 不含 delegationId 键（无 dtid 的纯宿主直调）', () => {
    const ac = new AbortController();
    const ctx = buildMcpRequestContext(undefined, ac.signal);
    assert.deepEqual(Object.keys(ctx), ['signal'], '键集必须恰为 signal');
  });

  test('reqCtx 装配：dtid + signal 并存 ⇒ 两键都在（委派内层回连断连）', () => {
    const ac = new AbortController();
    const ctx = buildMcpRequestContext('dt_1', ac.signal);
    assert.deepEqual(Object.keys(ctx).sort(), ['delegationId', 'signal']);
  });
});

/* ==================== ①″ 真实 HTTP：close+!writableEnded 的现实证伪 ==================== */

describe('P2-T4 传输层：真实 HTTP 服务器两态（断连 vs 完整响应）', () => {
  /**
   * 起一个 loopback 服务，处理器内挂 `watchClientDisconnect`，由 `mode` 决定：
   *  - 'client-aborts'：客户端拿到响应头即销毁 socket（宿主走开）；
   *  - 'normal'：服务端正常写完，客户端读完整个响应。
   * 返回「观察到的 signal.aborted 终值」—— 这是本设计选型唯一能用现实证伪的判据。
   */
  async function runHttpCase(mode) {
    const observed = { abortedAfterSettle: undefined, listenErr: undefined };
    const server = createServer((req, res) => {
      const watch = watchClientDisconnect(res);
      if (mode === 'normal') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        watch.dispose();
        observed.abortedAfterSettle = watch.signal.aborted;
        return;
      }
      // 客户端中途销毁：先回个头，让客户端确实「收到一点再走」
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":true');
      const timer = setTimeout(() => {
        // 断连若被正确侦测，此处 signal 已 aborted；写下去会失败但不影响断言
        try {
          res.end('}');
        } catch {
          /* 已断连，忽略 */
        }
        watch.dispose();
      }, 40);
      timer.unref?.();
      watch.signal.addEventListener(
        'abort',
        () => {
          observed.abortedAfterSettle = watch.signal.aborted;
        },
        { once: true },
      );
      void req;
    });

    await new Promise((resolve, reject) => {
      server.once('error', (e) => {
        observed.listenErr = e;
        reject(e);
      });
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const port = server.address().port;
      await new Promise((resolve) => {
        const req = httpGet({ host: '127.0.0.1', port }, (res) => {
          if (mode === 'client-aborts') {
            res.destroy(); // 宿主走开：不读完、直接销毁
            resolve();
            return;
          }
          let buf = '';
          res.on('data', (d) => {
            buf += d;
          });
          res.on('end', () => resolve());
        });
        req.on('error', () => {
          if (mode === 'client-aborts') resolve();
        });
      });
      // 给服务端 close/abort 事件一点落地时间
      await new Promise((r) => setTimeout(r, mode === 'client-aborts' ? 120 : 30));
      return observed;
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  test('真实断连（客户端销毁 socket）⇒ 侦测点产出 abort', async () => {
    const obs = await runHttpCase('client-aborts');
    assert.equal(obs.listenErr, undefined, 'loopback 监听必须成功');
    assert.equal(obs.abortedAfterSettle, true, '宿主没收到完整响应就走 ⇒ 必须 abort');
  });

  test('★ 反证：正常写完的响应 ⇒ 侦测点绝不 abort（每次成功调用不得被读成取消）', async () => {
    const obs = await runHttpCase('normal');
    assert.equal(obs.abortedAfterSettle, false, '响应完整送达后 Node 仍会触发 close ⇒ 判据必须含 !writableEnded');
  });
});

/* ==================== ① 框架层：signal 注入与两判据 ==================== */

describe('P2-T4 框架层：reqCtx.signal ⇒ ToolContext.signal 与取消语义', () => {
  test('signal 在场：handler 收到同一 AbortSignal 实例（不得复制/包装掉身份）', async () => {
    const ac = new AbortController();
    const gate = makeTool(ac, { delayMs: 5 });
    const srv = await makeServer(gate);
    await srv.handleRequest(callBody(), { signal: ac.signal });
    assert.equal(gate.invocations.length, 1);
    assert.equal(gate.invocations[0].signal, ac.signal, '必须是**同一个** signal 对象（跨层身份守恒）');
  });

  test('判据 1：派发前已 abort ⇒ handler 零发起 + CANCELED_TEXT + isError', async () => {
    const ac = new AbortController();
    ac.abort(); // 断连早于派发
    const gate = makeTool(ac, { delayMs: 5 });
    const srv = await makeServer(gate);

    const res = await srv.handleRequest(callBody(), { signal: ac.signal });

    assert.equal(gate.invocations.length, 0, '★ 取消优先于执行：handler 一次都不许发起（零新副作用）');
    assert.equal(res.result.isError, true, '取消必须以 isError 呈现，不得伪装成功');
    assert.equal(res.result.content[0].text, CANCELED_TEXT, '取消文案必须是框架层唯一权威串');
  });

  test('判据 1 的返回体形状：只有 content+isError（不得凭空造 structuredContent）', async () => {
    const ac = new AbortController();
    ac.abort();
    const gate = makeTool(ac);
    const srv = await makeServer(gate);
    const res = await srv.handleRequest(callBody(), { signal: ac.signal });
    assert.equal('structuredContent' in res.result, false, '未发起执行 ⇒ 不得有结构化结果');
    assert.deepEqual(Object.keys(res.result).sort(), ['content', 'isError']);
  });

  test('判据 2：handler 未自消费而在途断连 ⇒ 取消语义（canceled:true + inFlightMayContinue:true）', async () => {
    const ac = new AbortController();
    const gate = makeTool(ac, { delayMs: 200 }); // handler 不看 signal，靠兜底竞速
    const srv = await makeServer(gate);

    const inflight = srv.handleRequest(callBody(), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const res = await inflight;

    assert.equal(gate.invocations.length, 1, '在途 ⇒ handler 确实发起过（与判据 1 区分）');
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, CANCELED_TEXT);
    assert.equal(res.result.structuredContent.ok, false);
    assert.equal(res.result.structuredContent.canceled, true, '取消语义必须显式落结构化面');
    assert.equal(
      res.result.structuredContent.inFlightMayContinue,
      true,
      '★ 必须如实标记 VM 内在途副作用可能仍在继续（协作式中止，非强杀）',
    );
  });

  test('AbortError 是**独立错误对象**（name 精确，不得与普通失败混淆）', async () => {
    const gate = makeTool(undefined, { throwsAbortError: true });
    const srv = await makeServer(gate);
    const ac = new AbortController(); // 在场但**不** abort ⇒ 走 handler 自己抛 AbortError 的路径
    const res = await srv.handleRequest(callBody(), { signal: ac.signal });
    assert.equal(res.result.structuredContent.canceled, true, 'handler 抛 AbortError 也归取消语义');
    assert.equal(res.result.structuredContent.inFlightMayContinue, true);
    assert.match(res.result.content[0].text, /协作式中止|非强杀/);
  });

  test('普通异常仍是「执行失败」，不得被误标成取消（取消语义不得泛化）', async () => {
    const srv = new McpServer({
      name: 'p2t4-test',
      version: '0.0.0',
      tools: [
        {
          name: 'demo',
          description: 't',
          inputSchema: {},
          handler: async () => {
            throw new Error('桥那边炸了');
          },
        },
      ],
    });
    const res = await srv.handleRequest(callBody(), { signal: new AbortController().signal });
    assert.match(res.result.content[0].text, /执行失败/);
    assert.equal('structuredContent' in res.result, false, '普通失败不得借道取消结构化标记');
  });

  test('handler 在断连**之前**已正常 settle ⇒ 框架不得事后改写既有结果（竞速只兜底）', async () => {
    const ac = new AbortController();
    const gate = makeTool(ac, { selfConsume: true, delayMs: 5 }); // 很快正常返回
    const srv = await makeServer(gate);

    const res = await srv.handleRequest(callBody(), { signal: ac.signal });
    ac.abort(); // 结果已送达之后才断连
    await new Promise((r) => setImmediate(r));

    assert.equal(res.result.isError, false, '先 settle 者定：断连发生在返回后 ⇒ 不得把成功改判为取消');
    assert.equal(res.result.structuredContent.ok, true);
    assert.equal(res.result.structuredContent.selfConsumed, true);
  });

  test('在途 abort 时框架兜底竞速与 handler 监听同刻触发 ⇒ 取消语义优先（不得出现半成功体）', async () => {
    // 语义自证：abort 事件是**同步派发**的，框架 `raceAbort` 的 reject 与 handler 自己的
    // resolve 在同一次事件里都会跑；先注册的 reject 决定这条 promise 的终态 ⇒ 响应体
    // **必然**是取消形（isError + CANCELED_TEXT），绝不会是「content 成功 + 结构化取消」的矛盾体。
    const ac = new AbortController();
    const gate = makeTool(ac, { selfConsume: true, delayMs: 5_000 });
    const srv = await makeServer(gate);
    const inflight = srv.handleRequest(callBody(), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const res = await inflight;

    assert.equal(res.result.isError, true, '在途断连 ⇒ 终态必须是取消，不得伪装成功');
    assert.equal(res.result.content[0].text, CANCELED_TEXT);
    assert.equal(res.result.structuredContent.canceled, true);
    assert.equal(res.result.structuredContent.inFlightMayContinue, true);
    assert.equal('ok' in res.result.structuredContent && res.result.structuredContent.ok, false);
  });

  test('④ raceAbort 监听器摘除：handler settle 后 signal 上不留闭包（防 keep-alive 无界增长）', async () => {
    const stub = makeCountingSignal();
    const gate = makeTool(stub, { delayMs: 5 });
    const srv = await makeServer(gate);
    await srv.handleRequest(callBody(), { signal: stub });

    const s = stub.stats();
    assert.equal(s.added, 1, '在途竞速应挂恰一个 abort 监听');
    assert.equal(s.removed, 1, `settle 后必须摘除（实得 removed=${s.removed}）`);
    assert.equal(s.live, 0, '★ 存活监听必须归零');
  });

  test('④ raceAbort 监听器摘除（reject 出口同样摘）', async () => {
    const stub = makeCountingSignal();
    const srv = new McpServer({
      name: 'p2t4-test',
      version: '0.0.0',
      tools: [
        {
          name: 'demo',
          description: 't',
          inputSchema: {},
          handler: async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('boom');
          },
        },
      ],
    });
    await srv.handleRequest(callBody(), { signal: stub });
    const s = stub.stats();
    assert.equal(s.added, 1);
    assert.equal(s.live, 0, '异常出口也必须摘监听（否则每条失败请求漏一个闭包）');
  });

  test('④ 判据 1 出口不挂监听（派发前已 abort ⇒ 根本不需要竞速）', async () => {
    const stub = makeCountingSignal();
    stub.fire(); // 先 abort ⇒ 走判据 1
    const gate = makeTool(stub, { delayMs: 5 });
    const srv = await makeServer(gate);
    await srv.handleRequest(callBody(), { signal: stub });
    assert.equal(gate.invocations.length, 0);
    assert.equal(stub.stats().added, 0, '未派发 ⇒ 不得在 signal 上留下任何监听');
  });

  test('CANCELED_TEXT 只陈述可证事实（禁「未执行任何变更 / 已强杀」式不实陈述）', () => {
    assert.ok(CANCELED_TEXT.length > 0, '权威取消文案不得为空');
    for (const lie of ['未执行任何变更', '已终止', '已强杀', '已停止 VM', '无任何影响']) {
      assert.ok(!CANCELED_TEXT.includes(lie), `取消文案含不实承诺「${lie}」`);
    }
    assert.match(CANCELED_TEXT, /可能仍在继续/, '必须保留「VM 内在途副作用可能继续」这一可证事实');
  });
});

/* ==================== ② 缺席即旧行为（零回归） ==================== */

describe('P2-T4 零回归：signal 缺席 ⇒ 逐字节旧形态', () => {
  test('双参调用不带 reqCtx ⇒ ToolContext 键集恰为 [traceId]', async () => {
    const gate = makeTool(undefined, { delayMs: 5 });
    const srv = await makeServer(gate);
    const res = await srv.handleRequest(callBody());
    assert.equal(gate.invocations.length, 1);
    assert.deepEqual(Object.keys(gate.invocations[0]), ['traceId'], '旧调用方看到的 ctx 形状不得多一个键');
    assert.equal('signal' in gate.invocations[0], false, '不得写显式 undefined（K-13）');
    assert.equal(res.result.structuredContent.ok, true, '无 signal ⇒ 正常执行，与接通前一致');
  });

  test('reqCtx 只带 delegationId ⇒ ctx 键集恰为 [traceId, delegationId]（signal 不得凭空出现）', async () => {
    const gate = makeTool(undefined, { delayMs: 5 });
    const srv = await makeServer(gate);
    await srv.handleRequest(callBody(), { delegationId: 'dt_9' });
    assert.deepEqual(Object.keys(gate.invocations[0]).sort(), ['delegationId', 'traceId']);
  });

  test('单参 handleRequest（stdio / 既有测试范式）零改动仍可用', async () => {
    const gate = makeTool(undefined, { delayMs: 5 });
    const srv = await makeServer(gate);
    const initialized = await srv.handleRequest({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    const listed = await srv.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.equal(listed.result.tools.length, 1);
  });

  test('通知类请求（notifications/cancelled）仍返回 null（取消通知不产生响应）', async () => {
    const gate = makeTool(undefined);
    const srv = await makeServer(gate);
    const res = await srv.handleRequest(
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { signal: new AbortController().signal },
    );
    assert.equal(res, null, 'MCP 的 cancelled 通知本就无响应体（不得因 signal 接通而改判）');
  });

  test('未知工具 / 缺 name 的错误码不受 signal 接通影响', async () => {
    const gate = makeTool(undefined);
    const srv = await makeServer(gate);
    const ac = new AbortController();
    const r1 = await srv.handleRequest(callBody('nope'), { signal: ac.signal });
    assert.equal(r1.error.code, -32602);
    const r2 = await srv.handleRequest(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} },
      { signal: ac.signal },
    );
    assert.equal(r2.error.code, -32602);
    assert.equal(gate.invocations.length, 0, '协议错误路径同样不得派发 handler');
  });
});

/* ==================== ③ 执行侧：PsBridge 真身消费 per-call signal ==================== */

/**
 * 构造一个「已就绪」的 PsBridge 实例而不 spawn 任何进程：
 * 直接塞入假子进程引用，再用 `onData` 投递 NDJSON 回执。
 * （真实 `spawn powershell` 在本沙箱不可用，且会让单测依赖 VM。）
 */
function makeReadyBridge() {
  const bridge = new PsBridge({ scriptPath: '/nonexistent/ps-bridge.ps1' });
  const written = [];
  const child = {
    exitCode: null,
    stdin: { writable: true, write: (s) => written.push(String(s)) },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    once: () => child,
    kill: () => {},
  };
  bridge.child = child;
  bridge.stopped = false;
  return { bridge, written, child };
}

/** 从 stdin 已写帧里取出请求 id（rawCall 的 id 形如 `r<seq>`） */
function frameId(payload) {
  const m = /"id":"(r\d+)"/.exec(payload);
  return m ? m[1] : undefined;
}

describe('P2-T4 执行侧：PsBridge.call 的 per-call signal（协作式中止）', () => {
  test('缺席（4 参旧形态）⇒ 正常往返，行为与接通前逐字一致', async () => {
    const { bridge, written } = makeReadyBridge();
    const p = bridge.call('system', 'Get-SystemInfo', {}, 1_000);
    await new Promise((r) => setImmediate(r));
    const id = frameId(written[0]);
    assert.ok(id, '旧路径仍必须写出请求帧');
    bridge.onData(JSON.stringify({ id, ok: true, data: { v: 1 }, durationMs: 0 }) + '\n');
    assert.deepEqual(await p, { v: 1 });
    assert.equal(bridge.pendingCount, 0, '回执后等待位归零');
  });

  test('派发前已 abort ⇒ 一个字节都不写（零副作用）+ PSBRIDGE_CANCELED', async () => {
    const { bridge, written } = makeReadyBridge();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => bridge.call('system', 'Get-SystemInfo', {}, 1_000, { signal: ac.signal }),
      (e) => e.code === 'PSBRIDGE_CANCELED',
    );
    assert.equal(written.length, 0, '★ 已断连 ⇒ 绝不向 VM 下发新请求');
    assert.equal(bridge.pendingCount, 0);
  });

  test('在途 abort ⇒ 本地停止等待（PSBRIDGE_CANCELED），等待位被摘除', async () => {
    const { bridge, written } = makeReadyBridge();
    const ac = new AbortController();
    const p = bridge.call('app', 'Install-Winget', { id: 'Foo' }, 60_000, { signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    assert.equal(written.length, 1, 'abort 前请求已真实下发（这正是「in-flight 可能继续」的根源）');
    assert.equal(bridge.pendingCount, 1, '在途 ⇒ 等待位恰一个');

    ac.abort();
    await assert.rejects(
      () => p,
      (e) => {
        assert.equal(e.code, 'PSBRIDGE_CANCELED', '中止码必须是取消族（不得是 PSBRIDGE_TIMEOUT）');
        assert.equal(e.details.canceled, true);
        assert.equal(e.details.inFlightMayContinue, true, '★ 必须如实带「VM 内可能仍在继续」');
        return true;
      },
    );
    assert.equal(bridge.pendingCount, 0, '★ 中止后等待位必须摘除（否则迟到回执认领无人 promise + 内存泄漏）');
  });

  test('中止后迟到的 VM 回执 ⇒ 静默丢弃，不得复活已取消的调用', async () => {
    const { bridge, written } = makeReadyBridge();
    const ac = new AbortController();
    const p = bridge.call('app', 'Install-Winget', {}, 60_000, { signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    const id = frameId(written[0]);
    ac.abort();
    await assert.rejects(() => p, (e) => e.code === 'PSBRIDGE_CANCELED');
    // 迟到的成功回执：解析无人认领 ⇒ 只应被忽略，绝不产生未处理拒绝
    bridge.onData(JSON.stringify({ id, ok: true, data: { late: true }, durationMs: 0 }) + '\n');
    await new Promise((r) => setImmediate(r));
    assert.equal(bridge.pendingCount, 0);
  });

  test('④ abort 监听随 settle 摘除（正常回执出口）', async () => {
    const { bridge, written } = makeReadyBridge();
    const stub = makeCountingSignal();
    const p = bridge.call('system', 'Get-SystemInfo', {}, 1_000, { signal: stub });
    await new Promise((r) => setImmediate(r));
    assert.equal(stub.stats().added, 1, '在途竞速恰挂一个监听');
    bridge.onData(JSON.stringify({ id: frameId(written[0]), ok: true, data: 1, durationMs: 0 }) + '\n');
    await p;
    assert.equal(stub.stats().live, 0, '★ 回执后必须摘监听（长命 signal 上的无界增长点）');
  });

  test('④ abort 监听随超时出口摘除（超时路径同样不得残留监听）', async () => {
    const { bridge } = makeReadyBridge();
    const stub = makeCountingSignal();
    await assert.rejects(
      () => bridge.call('system', 'Get-SystemInfo', {}, 10, { signal: stub }),
      (e) => e.code === 'PSBRIDGE_TIMEOUT',
    );
    assert.equal(stub.stats().added, 1);
    assert.equal(stub.stats().live, 0, '超时出口同样要摘监听（曾经的漏网点：timeout 路径绕过统一收尾）');
  });

  test('opts 在场但 signal 未 abort ⇒ 正常往返（opts 本身不改变语义）', async () => {
    const { bridge, written } = makeReadyBridge();
    const ac = new AbortController();
    const p = bridge.call('storage', 'Get-CleanupAnalysis', {}, 1_000, { signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    bridge.onData(JSON.stringify({ id: frameId(written[0]), ok: true, data: { top: [] }, durationMs: 0 }) + '\n');
    assert.deepEqual(await p, { top: [] });
    ac.abort(); // 收口后 abort 不应产生任何后续影响（监听已摘）
    await new Promise((r) => setImmediate(r));
  });
});

/* ==================== ④ 执行侧：provider.execute 边界闸与收口码 ==================== */

describe('P2-T4 执行侧：DeterministicAgentProvider.execute 的断连闸与 TASK_CANCELED 收口', () => {
  test('派发前已 abort ⇒ 零桥调用 + TASK_CANCELED + retryable:false', async () => {
    const bridge = makeSignalBridge();
    const ac = new AbortController();
    ac.abort();
    const result = await withProvider(bridge, (p) => p.execute({ ...BASE_REQ, signal: ac.signal }));
    assert.equal(bridge.writes.length, 0, '★ 取消优先于执行：一次能力调用都不许发起');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASK_CANCELED', '收口码必须是 TASK_CANCELED');
    assert.equal(result.error.retryable, false, '重跑必须重新过审批闸，不得自动 retry');
    assert.equal(result.error.reason, 'HOST_DISCONNECTED', '中止来源必须可辨识（审计反查键）');
    assert.equal(result.error.details.inFlightMayContinue, true, '未派发 ⇒ 该字段仍如实为「可能有在途」的保守表述');
  });

  test('在途 abort ⇒ 桥侧中止上浮为 TASK_CANCELED（绝不折叠成 EXECUTION_FAILED）', async () => {
    const bridge = makeSignalBridge(300);
    const ac = new AbortController();
    const p = withProvider(bridge, (prov) => prov.execute({ ...BASE_REQ, signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.writes.length, 1, 'abort 前调用已真实下发');
    ac.abort();
    const result = await p;
    assert.equal(result.ok, false);
    assert.equal(
      result.error.code,
      'TASK_CANCELED',
      '★ 降级红线（CL-022 3a / K-12）：折叠成 EXECUTION_FAILED 会被 shouldDegrade 回落确定性执行器**重跑**已叫停的操作',
    );
    assert.equal(result.error.reason, 'PSBRIDGE_CANCELED', '领域中止码必须留在 reason 面（保码不压平）');
    assert.equal(result.error.details.inFlightMayContinue, true);
    assert.doesNotMatch(JSON.stringify(result.error), /未执行任何变更/, '取消文案不得宣称零变更（已下发一次）');
  });

  test('signal 在场且未 abort ⇒ 正常执行（第 5 参形态被真实传递）', async () => {
    const bridge = makeSignalBridge(5);
    const result = await withProvider(bridge, (p) => p.execute({ ...BASE_REQ, signal: new AbortController().signal }));
    assert.equal(result.ok, true);
    assert.equal(bridge.writes.length, 1);
    assert.equal(bridge.writes[0].hasOpts, true, 'signal 在场 ⇒ 必须走带 opts 的分支');
  });

  test('signal 缺席 ⇒ 走既有 4 参形态（hasOpts=false，逐字节旧行为）', async () => {
    const bridge = makeSignalBridge(5);
    const result = await withProvider(bridge, (p) => p.execute({ ...BASE_REQ }));
    assert.equal(result.ok, true);
    assert.equal(bridge.writes[0].hasOpts, false, '★ 旧调用形态不得被塞进 opts（否则 r3 的 T02b 超时形态钉失去意义）');
  });

  test('中止发生在策略/校验之前 ⇒ 不产审计失败条目污染（fail 路径仍只落一条链上条目）', async () => {
    const appended = [];
    const bridge = makeSignalBridge(5);
    const ctx = makeCtx(bridge);
    ctx.audit.append = async (e) => {
      appended.push(e);
      return { auditId: 'aud_x' };
    };
    const p = createDeterministic();
    await p.init(ctx);
    const ac = new AbortController();
    ac.abort();
    const result = await p.execute({ ...BASE_REQ, signal: ac.signal });
    await p.shutdown().catch(() => undefined);
    assert.equal(result.error.code, 'TASK_CANCELED');
    assert.equal(appended.length, 1, '取消收口恰落一条链上条目（取证面不得缺席，也不得多写）');
    assert.equal(appended[0].result.ok, false);
    assert.equal(appended[0].result.errorCode, 'TASK_CANCELED', '链上 errorCode 必须是取消码');
  });

  test('中止强度文案：执行侧只承诺「本地」层级，绝不承诺强杀 VM', async () => {
    const bridge = makeSignalBridge(300);
    const ac = new AbortController();
    const p = withProvider(bridge, (prov) => prov.execute({ ...BASE_REQ, signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const result = await p;
    // 该路径的文案来自**桥层**（PSBRIDGE_CANCELED 上浮、reason 保留中止来源），
    // 断言按「诚实性」而非「具体来源」：必须落在「本地」这一可证层级，并如实带在途可能继续。
    assert.match(result.error.message, /本地/, `文案须落在「本地」这一可证层级：${result.error.message}`);
    assert.match(result.error.message, /可能仍在继续|本地已停止跟进/, '必须保留「VM 内在途可能继续」这一可证事实');
    assert.ok(
      !/已终止.*(VM|虚拟机|进程)/.test(result.error.message),
      `不得宣称已强杀 VM 内进程（cmd.exe 无信号透传）：${result.error.message}`,
    );
  });
});

/* ==================== ⑤ A2A 通道对齐：sink.cancellationSignal 透传 ==================== */

describe('P2-T4 两通道口径：A2A 委派取消信号透传到 execute', () => {
  /**
   * 设计意图（SECURITY §2.2 两通道取消口径）：
   *  - A2A 委派 = `ProgressSink.cancellationSignal`（任务取消）；
   *  - MCP 直调 = `ToolContext.signal`（宿主断连）；
   *  二者现在**都**流进同一个 `CapabilityRequest.signal` 消费面，并共用 `TASK_CANCELED` 收口。
   * 本组用例证明委派通道也真的把信号交给了 execute（旧实现只在 step() 边界**轮询**，
   * 一次长能力调用最坏要等它自己跑完 540s 才能被感知）。
   */
  async function runGoalWithSignal(at, holdMs = 200) {
    const ac = new AbortController();
    const bridge = makeSignalBridge(holdMs);
    const p = createDeterministic();
    await p.init(makeCtx(bridge));
    const statuses = [];
    const sink = {
      onStatus: (s, m) => statuses.push([s, m ?? '']),
      onArtifact: () => {},
      onApprovalRequired: async () => true,
      isCancelled: () => ac.signal.aborted,
      cancellationSignal: ac.signal,
    };
    // 'before' 必须在 runGoal **之前** abort —— 否则咽喉点已经在跑了，
    // 断言「零能力调用」会退化成「取消时机不确定」的假命题。
    if (at === 'before') ac.abort();
    const run = p.runGoal({ traceId: 'tr_p2t4_goal', goal: '查看系统信息', timeoutMs: 30_000 }, sink);
    if (at === 'during') {
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
    }
    const result = await run;
    await p.shutdown().catch(() => undefined);
    return { result, bridge, ac, statuses };
  }

  test('委派信号在场 ⇒ execute 收到同一 signal 实例（透传未断链）', async () => {
    const { bridge, ac } = await runGoalWithSignal('never', 5);
    assert.equal(bridge.writes.length >= 1, true, '模板确实发起过能力调用');
    assert.equal(bridge.writes[0].hasOpts, true, '★ cancellationSignal 必须落到 execute ⇒ 桥 opts');
    assert.equal(ac.signal.aborted, false, '未取消 ⇒ 正常跑完');
  });

  test('在途取消 ⇒ 该次长调用被中止并以 TASK_CANCELED 收口（不再等它自己跑完）', async () => {
    const started = Date.now();
    const { result } = await runGoalWithSignal('during', 5_000);
    const took = Date.now() - started;
    assert.equal(result.error.code, 'TASK_CANCELED');
    assert.ok(took < 2_000, `取消应在边界即刻生效（实得 ${took}ms，旧实现会等满 5s）`);
    assert.equal(result.ok, false);
  });

  test('取消先于执行 ⇒ 零能力调用（step() 咽喉与 req.signal 闸双路同口径）', async () => {
    const { result, bridge } = await runGoalWithSignal('before');
    assert.equal(bridge.writes.length, 0, '已叫停 ⇒ 一个能力调用都不许发起');
    assert.equal(result.error.code, 'TASK_CANCELED');
  });
});

/* ==================== ⑥ 三层贯通：传输层 → 框架 → provider → 桥 ==================== */

describe('P2-T4 端到端（离线）：断连信号三层贯通', () => {
  /**
   * 复刻 vm-service `/mcp` handler 的**信号消费形状**（那段代码在单写者文件里，
   * 本用例用同构 handler 证语义；真机端到端见交付说明的遗留复核点）：
   *   ToolContext.signal ⇒ CapabilityRequest.signal ⇒ PsBridge per-call opts.signal。
   */
  test('框架 handler 把 ctx.signal 交给 provider.execute ⇒ 桥侧被 abort 即刻收口', async () => {
    const ac = new AbortController();
    const bridge = makeSignalBridge(5_000);
    // 层 3 的**带外**观测：provider 的 TASK_CANCELED 结果在 handler 返回前就被框架兜底
    // 竞速判定为取消（abort 同步派发，框架的 reject 注册在 handler 的 resolve 之前），
    // 因此必须另辟一条通道把「执行侧到底收口成什么码」取出来，否则该断言会打空。
    let observedExecuteResult;
    // 框架兜底竞速会**先**判定响应终态，handler 随后才跑完 ⇒ 必须另备一个 deferred 等它，
    // 否则层 2 的取证断言会在结果尚未产生时打空。
    let markHandlerSettled;
    const handlerSettled = new Promise((resolve) => {
      markHandlerSettled = resolve;
    });
    const srv = new McpServer({
      name: 'p2t4-e2e',
      version: '0.0.0',
      tools: [
        {
          name: 'system.info.get',
          description: 't',
          inputSchema: {},
          handler: async (params, ctx) => {
            const result = await withProvider(bridge, (p) =>
              p.execute({ ...BASE_REQ, params, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
            );
            observedExecuteResult = result;
            markHandlerSettled();
            return {
              isError: !result.ok,
              structuredContent: { traceId: result.traceId, ok: result.ok, ...(result.error ? { error: result.error } : {}) },
            };
          },
        },
      ],
    });

    const inflight = srv.handleRequest(callBody('system.info.get'), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.writes.length, 1, '三层链路已把请求下发到桥');
    assert.equal(bridge.writes[0].hasOpts, true, '★ 层 2→层 3 未断链：signal 必须落到桥的 per-call opts');

    ac.abort();
    const res = await inflight;
    await handlerSettled; // 等 handler 真正跑完，再取层 2 的收口码

    // 层 1（框架）：断连 ⇒ 取消语义的响应体
    assert.equal(res.result.isError, true);
    assert.equal(res.result.structuredContent.canceled, true);
    assert.equal(res.result.structuredContent.inFlightMayContinue, true);

    // 层 2（provider）：收口码必须是 TASK_CANCELED（带外取证）
    assert.ok(observedExecuteResult, 'handler 应已跑到 execute 收口');
    assert.equal(observedExecuteResult.error.code, 'TASK_CANCELED', '★ 三层贯通后执行侧收口码仍是取消族，绝非 EXECUTION_FAILED');
    assert.equal(observedExecuteResult.error.details.inFlightMayContinue, true);

    // 层 3（桥）：等待位已摘除（迟到回执不会再被认领）
    assert.equal(bridge.pendingCount, 0);
  });

  test('同一 signal 上连发多请求 ⇒ 每条都摘干净监听（无界增长反证）', async () => {
    const stub = makeCountingSignal();
    const srv = await makeServer(makeTool(stub, { delayMs: 5 }));
    const many = [];
    for (let i = 0; i < 8; i += 1) many.push(srv.handleRequest(callBody('demo', {}, i), { signal: stub }));
    const results = await Promise.all(many);
    const s = stub.stats();
    assert.equal(s.added, s.removed, `并发 8 条后 added(${s.added}) 必须等于 removed(${s.removed})`);
    assert.equal(s.live, 0, '★ 存活监听必须为 0（否则复用同一 signal 的长连接会无界堆积闭包）');
    assert.equal(results.length, 8);
    for (const r of results) assert.equal(r.result.structuredContent.ok, true, '未 abort ⇒ 每条都正常完成');
  });

  test('reqCtx 经 buildMcpRequestContext 装配后走框架 ⇒ delegationId + signal 双键同时生效', async () => {
    const ac = new AbortController();
    const gate = makeTool(ac, { delayMs: 5 });
    const srv = await makeServer(gate);
    const reqCtx = buildMcpRequestContext('dt_77', ac.signal);
    await srv.handleRequest(callBody(), reqCtx);
    assert.equal(gate.invocations[0].delegationId, 'dt_77');
    assert.equal(gate.invocations[0].signal, ac.signal);
    assert.deepEqual(Object.keys(gate.invocations[0]).sort(), ['delegationId', 'signal', 'traceId']);
  });
});

/* ==================== ⑦ 静态守卫（源码形态，K-10 自证灵敏度） ==================== */

describe('P2-T4 静态面：接线形态不得静默退化', () => {
  const read = async (...segs) => {
    const fs = await import('node:fs');
    const { repoPath } = await import('../helpers/bridge-internals.mjs');
    return fs.readFileSync(repoPath(...segs), 'utf8');
  };

  test('框架：signal 必须**条件展开**注入（禁显式 undefined 污染 ctx 键集）', async () => {
    const mcp = await read('packages', 'mcp-framework', 'src', 'server.ts');
    assert.match(mcp, /\.\.\.\(reqCtx\?\.signal \? \{ signal: reqCtx\.signal \} : \{\}\)/, 'signal 注入须条件展开');
    assert.ok(!/signal:\s*reqCtx\?\.signal,/.test(mcp), '不得无条件写 signal（含 undefined）');
    assert.match(mcp, /export const CANCELED_TEXT/, '取消文案必须是导出的框架层权威串');
  });

  test('框架：判据 1 与判据 2 两个出口都在场（缺一即取消语义不完整）', async () => {
    const mcp = await read('packages', 'mcp-framework', 'src', 'server.ts');
    assert.match(mcp, /aborted === true/, '判据 1：派发前 aborted 闸');
    assert.match(mcp, /name === 'AbortError'/, '判据 2：AbortError 走取消语义而非执行失败');
    assert.match(mcp, /inFlightMayContinue: true/, '取消结构化面必须带在途可能继续标记');
  });

  test('框架：raceAbort 摘监听（removeEventListener）在 settle 路径上', async () => {
    const mcp = await read('packages', 'mcp-framework', 'src', 'server.ts');
    assert.match(mcp, /removeEventListener\('abort'/, '监听器必须随 settle 摘除');
    assert.match(mcp, /addEventListener\('abort', onAbort, \{ once: true \}\)/, '注册须 once:true');
  });

  test('执行侧：取消码经 DOMAIN_CODE_TO_BASE 归一到 TASK_CANCELED（不扩契约 10 码）', async () => {
    const det = await read('packages', 'adapter-agent-workbuddy', 'src', 'index.ts');
    assert.match(det, /PSBRIDGE_CANCELED: 'TASK_CANCELED'/, '中止码 ⇒ 契约取消码的显式映射');
    assert.ok(!/^\s*'PSBRIDGE_CANCELED',\s*$/m.test(det.split('BRIDGE_ERROR_CODES')[1]?.slice(0, 400) ?? ''),
      'PSBRIDGE_CANCELED 不得进对外契约封闭码集（内部中止不是新契约错误码）');
  });

  test('执行侧：边界判定必须走函数（内联 readonly 属性判定会被 TS 收窄成假守卫）', async () => {
    const det = await read('packages', 'adapter-agent-workbuddy', 'src', 'index.ts');
    assert.match(det, /function isHostGone\(/, '边界判据须封装为函数（每次真读 aborted）');
    assert.ok(!/if \(req\.signal\?\.aborted === true\)/.test(det),
      '不得内联写 req.signal?.aborted 判定 —— TS 会把 readonly 属性收窄并保持 ⇒ 后续边界永远读不到取消');
    const sites = (det.match(/isHostGone\(req\.signal\)/g) ?? []).length;
    assert.ok(sites >= 3, `能力边界闸须 ≥3 处（入口 / 会话探针后 / 发起前），实得 ${sites}`);
  });

  test('桥：per-call signal 是第 5 参（第 4 参 timeoutMs 形态零改动 ⇒ T02b 超时钉不被破坏）', async () => {
    const ps = await read('packages', 'vm-capabilities', 'src', 'ps-bridge.ts');
    assert.match(ps, /timeoutMs\?: number,\s*\n\s*opts\?: PsCallOptions,/, 'opts 必须是新增第 5 参');
    assert.match(ps, /'PSBRIDGE_CANCELED'/, '取消码字面量须在桥层落地');
    assert.match(ps, /removeEventListener\('abort'/, '中止监听须随 settle 摘除');
  });

  test('传输层新模块不得反向依赖 vm-service 主文件（单写者隔离 + 依赖方向）', async () => {
    const t = await read('packages', 'vm-service', 'src', 'mcp-transport.ts');
    assert.ok(!/from '\.\/server\.js'/.test(t), '新模块绝不可 import server.ts（否则单写者文件被间接改动）');
    assert.ok(!/from '@winvm\/(vm-capabilities|adapter-agent)/.test(t), '传输层不得下探能力层/adapter（分层铁律）');
    assert.match(t, /writableEnded/, '判据必须含「未正常写完」这一半');
  });

  test('★ 反证（灵敏度自证）：把 close 判据的 !writableEnded 摘掉 ⇒ 形态守卫必须命中该退化', async () => {
    const t = await read('packages', 'vm-service', 'src', 'mcp-transport.ts');
    const mutant = t.replace(/if \(\(res as DisconnectWatchable\)\.writableEnded\) return;/, 'if (false) return;');
    assert.notEqual(mutant, t, '变异必须真的改到字节（否则变异打空）');
    assert.ok(!/if \(\(res as DisconnectWatchable\)\.writableEnded\) return;/.test(mutant),
      '摘掉正常写完豁免 ⇒ 本条判据的精确性已被证实非空转');
  });
});
