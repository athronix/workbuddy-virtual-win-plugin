/**
 * C0（Phase 5）· 2c 链上审计诚实化钉
 *
 * 病灶：adapter（确定性执行器）`execute` 成功支的 `ctx.audit.append` 条目
 * `result:{ok:true, summary:'… 执行成功'}` 恒真——ok 来源 = bridge.call 未抛
 * （进程级送达），`data.success===false` 的 K6 失败回执在**链条目面**被记作成功
 * （委派账本归因消费点 delegation-audit `recordExecuted(record, record.result?.ok===true)`）。
 *
 * 修复（2c）：写入前应用与响应面（2b）**同一纯函数** `foldK6Verdict`
 * （单源 @winvm/core k6-verdict）：折叠命中 ⇒ 条目 `ok:false` +
 * `errorCode:'EXECUTION_FAILED'` + 诚实 summary（`执行未成功：… K6 核验未过 …残留证据: …`）。
 * provider 返回信封保持 ok=true（送达事实）——呈报折叠在服务层回执面与链条目面
 * 各自独立由同一判据产生，互不叠加。
 *
 * 打法（对齐 cl020-f2 集成断言纪律）：mock BridgeContext（假 bridge.call 回构造的
 * K6 回执）+ 注入 sink 桩（捕获 append 条目）直调 `provider.execute`——不起真
 * ps-bridge、不落真链，断言的是**写入值**（条目形态即链上形态）。
 *
 * 运行（只跑本文件）：node --test tests/unit/p5-c0-k6-audit-fold.test.js
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider } from '../../packages/adapter-agent-workbuddy/dist/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ADAPTER = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-workbuddy', 'src', 'index.ts'),
  'utf8',
);

/** K6 失败回执（复刻 psmod Uninstall-WingetPackage 核验不过形态）。 */
const K6_FAIL_DATA = {
  id: 'WXWork',
  dryRun: false,
  exitCode: 0,
  success: false,
  verified: { exeGone: false, dirGone: null, registryGone: false, installerType: 'NSIS' },
  fallbackUsed: true,
  residualEvidence: '残留 exe: C:\\Program Files\\WXWork\\WXWork.exe；残留键: Uninstall\\WXWork',
  output: ['[k6] verify: passed=false'],
};

/**
 * mock BridgeContext：假 bridge.call 恒回 `replyData`；audit.append 捕获条目进 sink。
 * @param {unknown} replyData bridge.call 返回的原始 data
 * @returns {{ ctx: any, entries: any[] }}
 */
function makeCtx(replyData) {
  /** @type {any[]} */
  const entries = [];
  const ctx = {
    config: {},
    bridge: {
      call: async () => replyData,
      running: true,
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'allow' }) },
    capabilities: {
      get: (id) => ({ id, risk: 'L0', requiresSession: false }),
      list: () => [],
      size: () => 54,
      intersectDeclared: () => [],
    },
    audit: {
      append: async (e) => {
        entries.push(e);
        return { auditId: 'aud_test' };
      },
      verifyChain: async () => ({ entries: 0, valid: true }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {} },
    newTraceId: () => 't',
  };
  return { ctx, entries };
}

async function runExecute(replyData) {
  const { ctx, entries } = makeCtx(replyData);
  const p = createProvider();
  await p.init(ctx);
  const res = await p.execute({
    capabilityId: 'system.info.get',
    params: {},
    risk: 'L0',
    approved: true,
    timeoutMs: 5000,
    traceId: 'tr_c0_2c',
  });
  return { res, entries };
}

describe('C0-2c 链上审计条目折叠（写入值断言）', () => {
  test('data.success=false ⇒ 链条目 ok:false + errorCode=EXECUTION_FAILED + 诚实 summary 含 K6 文案与残留证据', async () => {
    const { entries } = await runExecute(K6_FAIL_DATA);
    assert.equal(entries.length, 1, `应恰写一条审计条目：${entries.length}`);
    const e = entries[0];
    assert.equal(e.result.ok, false, '★ 折叠命中 ⇒ 链条目不得再记「执行成功」');
    assert.equal(e.result.errorCode, 'EXECUTION_FAILED', '复用契约码落 errorCode 位（fail() 站点同型）');
    assert.ok(e.result.summary.includes('执行未成功'), `summary 须失败形：${e.result.summary}`);
    assert.ok(e.result.summary.includes('K6 核验未过'), `summary 携带 K6 定性：${e.result.summary}`);
    assert.ok(e.result.summary.includes('残留证据'), `summary 携带残留证据段：${e.result.summary}`);
    assert.ok(e.result.summary.includes('WXWork.exe'), '证据内容进 summary（截断后）');
    assert.ok(e.result.summary.length < 400, `summary 不得整块灌输出（截断纪律）：len=${e.result.summary.length}`);
  });

  test('折叠命中时 provider 信封仍 ok:true（送达事实不改写；呈报折叠归服务层，两面无叠加）', async () => {
    const { res } = await runExecute(K6_FAIL_DATA);
    assert.equal(res.ok, true, '信封=进程级送达位，链面诚实由条目折叠承担（2b 服务层再折回执面）');
    assert.equal(res.data.success, false, 'data 不吞');
  });

  test('data.success=true ⇒ 条目逐字旧形态（ok:true +「执行成功」）——向后兼容面', async () => {
    const { entries } = await runExecute({ success: true, exitCode: 0 });
    assert.equal(entries[0].result.ok, true);
    assert.equal(entries[0].result.summary, 'system.info.get 执行成功', '未折叠 ⇒ 文案逐字不变');
    assert.equal('errorCode' in entries[0].result, false, '未折叠 ⇒ 不得造 errorCode 键');
  });

  test('data 无 success 键 / success:"false" 字符串 ⇒ 条目不折叠（严格判据端到端）', async () => {
    for (const d of [{ info: 'normal' }, { success: 'false' }, { success: 0 }, 'plain string', null]) {
      const { entries } = await runExecute(d);
      assert.equal(entries[0].result.ok, true, `不触发面 data=${JSON.stringify(d)} 必须保持旧形态`);
      assert.equal(entries[0].result.summary, 'system.info.get 执行成功');
    }
  });

  test('接线形态静态钉：审计写入前调 foldK6Verdict、result 消费 fold、判据单源 @winvm/core', () => {
    assert.match(ADAPTER, /import \{[^}]*foldK6Verdict[^}]*\} from '@winvm\/core'/, 'adapter 必须从 core 单源导入折叠件（2a 下沉的动机面）');
    const foldAt = ADAPTER.indexOf('const fold = foldK6Verdict(true, data)');
    const appendAt = ADAPTER.indexOf('const audit = await ctx.audit.append({');
    assert.notEqual(foldAt, -1, 'execute 成功支必须调 foldK6Verdict');
    assert.notEqual(appendAt, -1, '审计写入锚点在位');
    assert.ok(foldAt < appendAt, '★ 折叠必须发生在审计写入之前');
    assert.match(ADAPTER, /result: fold\.k6Failed/, '条目 result 必须消费折叠位');
    // 旧恒真形态不得回潮（唯一成功支写入点改判）
    assert.equal(
      /result: \{ ok: true, summary: `\$\{req\.capabilityId\} 执行成功` \}/.test(ADAPTER),
      false,
      '旧字面量 result:{ok:true,…执行成功} 不得作为无条件写入形态回潮（已折入三元）',
    );
  });

  test('LLM/宿主侧无第二处「不看 data.success 的链上执行回执写入点」（2c 侦察结论钉）', () => {
    // 侦察结论：全仓 adapter 域 audit.append 仅两处（本件成功支 + fail() 站点）；
    // fail() 站点 result.ok=false 恒诚实（异常路径）；LLM 桥/框架零审计写入符号
    // （r19c-kn1-e-mutation E-3(a) 既有钉承保）。本例防「第三写入点」悄悄长出。
    const writers = (ADAPTER.match(/ctx\.audit\.append\(\{/g) ?? []).length;
    assert.equal(writers, 2, `adapter 审计写入点应恰 2（成功支+fail 站点），实得 ${writers}——第三写入点即 K6 假成功旁路`);
    assert.match(ADAPTER, /result: \{ ok: false, errorCode: error\.code, summary: error\.message \}/, 'fail 站点诚实形态保持');
  });
});
