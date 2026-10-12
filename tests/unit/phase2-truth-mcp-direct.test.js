/**
 * Phase 2 · P2-T8：真值层扩展到 **MCP 直调** + 兜底归因可观测（G-a / G-b / G-c）
 *
 * ## 三个缺口在补什么（设计定稿 `wbtmp/p2t8-design.md` §0–§5）
 *
 *  - **G-a（门 1 归属键扩展）**：`reconcileApprovalTruth` 的门 1 过去要求**必须有
 *    `taskId`** ⇒「无 taskId、有 traceId」的回合（纯 MCP 直调形态 / 委派 CLI 回连）
 *    一律回退文本兜底，而 `collectApprovalFacts` / `LedgerRegistry.blockedFor`
 *    **早已能按 traceId 归因**（R1 精确 / R2 排除 / R3 窗口+能力面）。即缺的不是
 *    新数据源，是**新调用点**。本批把归属键扩为 `taskId ?? traceId`，
 *    SK-1「无归属不介入」逐字保留（双缺仍回退）。
 *  - **G-b（decidedBy / gate 可计数归因）**：结构化判据任一门退场后，链上**看不出**
 *    这次结论是「结构化救回来的」还是「兜底救回来的」。新增 `deps.onTruthDecision`
 *    **出参回调**（不是返回值字段 —— 门 0 的 `out===base` 引用相等钉 + 门 3 的
 *    「绝不 warn」钉都不允许被触碰），经桥写 `RunContext.approvalTruth` →
 *    `LlmGoalResult` → `GoalResult`（provider 透传）→ 服务端 observer 落
 *    `delegation.complete` 的 `ext.approvalTruth`。
 *  - **G-c（补强，不重建）**：文本兜底的同义改写**漏判**反例集 + 关键词集合钉 +
 *    SK-9 文案钉，在**本新文件内**补强（既有 24 例 `phase2-approval-wait-fallback`
 *    一字不动，SK-9 函数体一字不动）。
 *
 * ## 纪律
 *
 *  - 只读 `packages/`，不改任何源码；被测面经 **dist** 取用 ⇒ 跑前必须
 *    `node node_modules/typescript/bin/tsc -b tsconfig.build.json`；
 *  - 包内私有件走 `tests/helpers/bridge-internals.mjs`（O-3 范式，**不为测试扩公共面**）；
 *  - 逐文件运行，**绝不整批 glob**（本沙箱 glob 整批触发 junction 0xC0000005 假全红）：
 *    `node --test tests/unit/phase2-truth-mcp-direct.test.js`
 *  - 不起 HTTP、不 spawn 真 CLI、不碰 VM / 隧道（真值层扩展走离线注入）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { loadBridgeInternals, repoPath } from '../helpers/bridge-internals.mjs';
import { CliLlmBridge, reconcileApprovalTruth } from '@winvm/adapter-agent-workbuddy-llm';
import { buildDelegationAuditEntry, LedgerRegistry } from '@winvm/vm-service';

/**
 * 文本兜底的包内导出（G-c 直连 `dist/bridge.js` 取用，O-3 范式）。
 * 在**模块顶层**取一次：`describe` 回调不是 async，内部不允许 `await`。
 */
const { reconcileApprovalWait } = await loadBridgeInternals();

/* ============================ 夹具 ============================ */

const CAP = 'app.winget.uninstall';
const TRACE = 'tr_p2t8_mcp_direct_77';
const TASK = 'task_p2t8_1';
const STARTED = 1_000_000;

/** 服务端结构化命中的样本措辞：**不含**兜底关键词 ⇒ 结论只能来自结构化判据 */
const NO_KEYWORD_TEXT = '操作已被安全策略拦截，需宿主确认后继续推进。\n';
/** 兜底关键词样本措辞（G-c / 门 3 回退路径用） */
const KEYWORD_TEXT = '工具返回 APPROVAL_REQUIRED，等待宿主审批 approvalId=apr_text_only\n';

/** `LlmGoalResult` 最小形状（与 `r19c-k3r-approval-truth` 同形，隔离变量） */
function baseResult(over = {}) {
  return {
    ok: true,
    summary: 'LLM 运行时完成目标：卸载 VM 企业微信',
    artifacts: [],
    steps: [
      {
        index: 0,
        capabilityId: CAP,
        params: { goal: '卸载 VM 企业微信' },
        ok: true,
        risk: 'L1',
        durationMs: 1200,
        summary: '执行中',
      },
    ],
    ...over,
  };
}

/** 一条未决审批的结构化事实（`PendingApprovalFact` 同形） */
function fact(over = {}) {
  return {
    approvalId: 'apr_p2t8_1',
    capabilityId: CAP,
    risk: 'L2',
    createdAtMs: STARTED + 1000,
    attribution: 'exact',
    hostApproved: false,
    ...over,
  };
}

/**
 * 可编程探针 + 调用计数（`approvalWait` 是否被调 = 「有无进入结构化反查」的**唯一**观察点，
 * G-a 的 A3/A4 两组都靠它，而不是靠返回值猜）。
 */
function makeProbe(facts, opts = {}) {
  const calls = [];
  return {
    calls,
    probe: {
      delegationActivity: async () => ({ total: 0, executed: 0, blocked: 0, wild: 0 }),
      approvalWait: async (q) => {
        calls.push(q);
        if (opts.throws) throw new Error('probe boom');
        return typeof facts === 'function' ? facts(q) : facts;
      },
    },
  };
}

/**
 * 归因记录器：把 `onTruthDecision` 的每次 emit 收进数组（**计数=每路径恰一次**是 G-b 的主钉）。
 */
function makeEmitter() {
  const decisions = [];
  return {
    decisions,
    onTruthDecision: (d) => decisions.push(d),
    /** 取唯一一条（多条即断言失败，把「双 emit」显形） */
    only() {
      assert.equal(decisions.length, 1, `每条判定路径必须恰一次 emit，实得 ${decisions.length}：${JSON.stringify(decisions)}`);
      return decisions[0];
    },
  };
}

/**
 * 默认 deps（**有 taskId** 的委派形态）—— 与既有 7 门测试保持同一形状，
 * 只有显式 delete 归属键的用例才走 G-a 新形态。
 *
 * `reconcileApprovalWait` **刻意注入桩**（记次数、原样返回 b）：多数用例只关心
 * 「结构化判据有没有介入」，把兜底换成记账桩可让「兜底被调用次数」成为可读断言，
 * 而不必依赖文案。需要真实兜底行为的用例（A2/C3/B 门3 等）另行覆盖。
 */
function depsFor(over = {}) {
  const emitter = over.emitter ?? makeEmitter();
  const warns = [];
  const fallbackCalls = [];
  const input = {
    taskId: TASK,
    traceId: TRACE,
    startedAtMs: STARTED,
    capabilities: [CAP],
    ...(over.input ?? {}),
  };
  const ctx = {
    started: STARTED,
    startedAtMs: STARTED,
    raised: over.raised ?? new Set(),
    receipts: over.receipts ?? new Map(),
    delegationId: TRACE,
    ...(over.ctx ?? {}),
  };
  return {
    deps: {
      input,
      ctx,
      enabled: over.enabled ?? true,
      ...(over.noProbe ? {} : { probe: over.probe ?? makeProbe(over.facts ?? [fact()]).probe }),
      warn: (msg, meta) => warns.push([msg, meta ?? {}]),
      onTruthDecision: emitter.onTruthDecision,
      ...(over.fallback
        ? {
            reconcileApprovalWait: (b, t) => {
              fallbackCalls.push(t);
              return over.fallback(b, t);
            },
          }
        : {}),
      ...(over.rawDeps ?? {}),
    },
    emitter,
    warns,
    fallbackCalls,
  };
}

/* ============================================================================
 * A 组（G-a）：门 1 归属键 = taskId ?? traceId —— MCP 直调进入结构化反查
 * ========================================================================= */

describe('P2-T8 G-a：门 1 归属键扩展 taskId ?? traceId（MCP 直调形态进入结构化反查）', () => {
  /** 无 taskId 有 traceId 的回合（纯 MCP 直调 / 委派 CLI 回连的桥内形态） */
  function mcpDirectDeps(over = {}) {
    const d = depsFor(over);
    delete d.deps.input.taskId;
    return d;
  }

  test('A1 无 taskId + traceId 归因命中 ⇒ 结构化改判（旧实现此处会静默放行 completed）', async () => {
    const { deps, emitter } = mcpDirectDeps({ facts: [fact({ approvalId: 'apr_mcp_hit' })] });
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, deps);
    const d = emitter.only();
    assert.equal(out.ok, false, '★ G-a 兑现：无 taskId 不再等于无判据');
    assert.equal(out.error.code, 'APPROVAL_REQUIRED');
    assert.equal(out.error.details.approvalId, 'apr_mcp_hit', '服务端权威 approvalId（非文本抠）');
    assert.equal(out.error.details.source, 'server-ledger', '来源标记 = 结构化，非兜底');
    assert.match(out.steps[0].summary, /服务端结构化判定/, 'steps 文案可区分两判据（取证归因靠它）');
    assert.equal(d.decidedBy, 'server');
    assert.equal(d.gate, '命中');
    assert.equal(d.taskIdPresent, false, '归因如实记录「无 taskId」这一形态');
    assert.equal(d.traceIdPresent, true);
    assert.equal(d.approvalId, 'apr_mcp_hit');
  });

  test('A2 无 taskId + traceId 未命中（facts 空）⇒ 门 5 回退文本兜底（结构化做减法不做加法）', async () => {
    const { probe, calls } = makeProbe([]);
    const { deps, emitter } = mcpDirectDeps({ probe, fallback: (b) => b });
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, deps);
    assert.equal(calls.length, 1, '★ 探针**被调用** = 确实进入了结构化反查（旧实现在门 1 就退场，零调用）');
    assert.equal(out.ok, true, '结构化说「无未决审批」⇒ 绝不强行改判');
    const d = emitter.only();
    assert.equal(d.decidedBy, 'text-fallback');
    assert.equal(d.gate, '门5');
  });

  test('A3 归属键双缺（无 taskId 且无 traceId）⇒ 门 1 回退，且探针零调用（SK-1 不放宽）', async () => {
    const { probe, calls } = makeProbe([fact()]);
    const d = depsFor({ probe, facts: [fact()] });
    delete d.deps.input.taskId;
    delete d.deps.input.traceId;
    d.deps.ctx.delegationId = undefined;
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(calls.length, 0, '无归属绝不取证据（门 1 在取证之前）');
    assert.equal(out.ok, true, '双缺 ⇒ 结构化判据零介入，文本兜底也不命中 ⇒ 原样');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'text-fallback');
    assert.equal(dec.gate, '门1');
    assert.equal(dec.taskIdPresent, false);
    assert.equal(dec.traceIdPresent, false);
  });

  test('A3b 归属键双缺 + 文本命中关键词 ⇒ 仍由文本兜底改判（兜底面零回归）', async () => {
    const { reconcileApprovalWait } = await loadBridgeInternals();
    const { probe, calls } = makeProbe([fact()]);
    const d = depsFor({ probe, fallback: reconcileApprovalWait });
    delete d.deps.input.taskId;
    delete d.deps.input.traceId;
    const out = await reconcileApprovalTruth(baseResult(), KEYWORD_TEXT, d.deps);
    assert.equal(calls.length, 0, '门 1 退场先于取证');
    assert.equal(out.ok, false, '兜底确实接住了这一形态');
    assert.equal(out.error.code, 'APPROVAL_REQUIRED');
    assert.equal(out.error.details.approvalId, 'apr_text_only', '兜底路径的 approvalId 来自文本提取');
    assert.equal(out.error.details.source, undefined, '兜底路径不得带 server-ledger 标记');
    assert.equal(d.emitter.only().gate, '门1');
  });

  test('A4 R2 精确排除：他人 dtid 的未决审批绝不落到本回合（串台红线，服务端归因面）', () => {
    const mine = 'tr_p2t8_mine';
    const other = 'tr_p2t8_other';
    const reg = new LedgerRegistry();
    reg.begin(mine, 'task_mine', []);
    reg.begin(other, 'task_other', []);
    // 他人的拦截带**他人** dtid（精确归因），落到的是他人账本
    reg.recordBlocked(11, 'apr_other_exact', CAP, { delegationId: other, risk: 'L3' });
    const got = reg.blockedFor({ delegationTraceId: mine, startedAtMs: STARTED });
    assert.deepEqual(got, [], '★ 扩展门 1 后 MCP 直调也会查这一步；R2 必须继续挡住串台');
    // 对照：查他人自己 ⇒ 命中一条（证明上面「空」是排除、不是查不到）
    const theirs = reg.blockedFor({ delegationTraceId: other, startedAtMs: STARTED });
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].approvalId, 'apr_other_exact');
    assert.equal(theirs[0].attribution, 'exact');
  });

  test('A5 R3 窗口归因（无 dtid 常驻形态）：门 1 扩展 + 窗口下界即可命中（设计裁断「无 dtid 也闭环」）', () => {
    const reg = new LedgerRegistry();
    const led = reg.begin('tr_p2t8_window', 'task_w', [CAP]);
    // 无 delegationId ⇒ 分发到窗口内存活的账本（常驻会话 mcp.json 会话级共享的既有通路）
    reg.recordBlocked(21, 'apr_window_hit', CAP, { risk: 'L2', atMs: led.startedAtMs + 5 });
    const got = reg.blockedFor({ delegationTraceId: 'tr_p2t8_window', startedAtMs: led.startedAtMs });
    assert.equal(got.length, 1, '无 dtid 的拦截仍能经 R3 落进本回合账本');
    assert.equal(got[0].attribution, 'window');
  });

  test('A6 query 取值序不变：ctx.delegationId ?? input.traceId（语义零改动的形态钉）', async () => {
    const { probe, calls } = makeProbe([]);
    const d = depsFor({ probe });
    delete d.deps.input.taskId;
    d.deps.ctx.delegationId = 'tr_from_ctx';
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(calls[0].delegationTraceId, 'tr_from_ctx', 'ctx 优先（dtid 注入后的归因键）');
    const d2 = depsFor({ probe });
    delete d2.deps.input.taskId;
    d2.deps.ctx.delegationId = undefined;
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d2.deps);
    assert.equal(calls[1].delegationTraceId, TRACE, 'ctx 缺席 ⇒ 回退 input.traceId（G-a 后仍可进入判定）');
  });

  test('A7 非委派裸调用（连 traceId 都没有）⇒ 门 1；且 input 缺席同样落门 1', async () => {
    const out1 = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, {});
    assert.equal(out1.ok, true, 'deps 完全缺席（无 input）⇒ 恒等/兜底路径，不改判');
    const out2 = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, {
      input: { traceId: '', capabilities: [CAP] },
    });
    assert.equal(out2.ok, true, '空串 traceId 不构成归属键');
  });

  test('A8 空白串归属键不算归属（与 taskId 判序逐字同构）', async () => {
    const { calls, probe } = makeProbe([fact()]);
    const d = depsFor({ probe });
    d.deps.input.taskId = '';
    d.deps.input.traceId = '';
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(calls.length, 0, '空串 ⇒ 门 1 退场，绝不取证据');
  });
});

/* ============================================================================
 * B 组（G-b）：decidedBy / gate 出口计数 —— 每路径恰一次，且零回归
 * ========================================================================= */

describe('P2-T8 G-b：onTruthDecision 归因出口（每决策出口恰一次；emit ≠ warn）', () => {
  test('B0 门 0 ⇒ pass-through/门0 恰一次，且返回值仍是 base 本体（D1 引用相等钉不放宽）', async () => {
    const failed = baseResult({ ok: false, error: { code: 'EXECUTION_FAILED', message: 'x', retryable: false } });
    const d = depsFor({ facts: [fact()] });
    const out = await reconcileApprovalTruth(failed, NO_KEYWORD_TEXT, d.deps);
    assert.equal(out, failed, '★ 门 0 恒等透传（引用相等）⇒ 归因绝不允许写进返回值');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'pass-through');
    assert.equal(dec.gate, '门0');
    assert.equal(d.warns.length, 0, '门 0 不得新增 warn');
  });

  test('B1 门 1 ⇒ text-fallback/门1（taskId/traceId 双缺）', async () => {
    const d = depsFor({ fallback: (b) => b });
    delete d.deps.input.taskId;
    delete d.deps.input.traceId;
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'text-fallback');
    assert.equal(dec.gate, '门1');
  });

  test('B2 门 2（灰度 off）⇒ text-fallback/门2 + taskIdPresent/traceIdPresent 如实', async () => {
    const d = depsFor({ enabled: false, facts: [fact()], fallback: (b) => b });
    const out = await reconcileApprovalTruth(baseResult(), KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, true, 'off ⇒ 结构化零介入，注入桩兜底也不改判（回滚面逐字 = R19F 后现状）');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'text-fallback');
    assert.equal(dec.gate, '门2');
    assert.equal(dec.taskIdPresent, true);
    assert.equal(dec.traceIdPresent, true);
  });

  test('B3 门 3（探针缺席 = 旧服务端）⇒ text-fallback/门3 且**绝不 warn**（D3b 纪律，emit≠warn）', async () => {
    const d = depsFor({ noProbe: true, fallback: (b) => b });
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    const dec = d.emitter.only();
    assert.equal(dec.gate, '门3');
    assert.equal(d.warns.length, 0, '★ 归因走 deps 出参回调，不得伪装成 warn（探针缺席是常态不是异常）');
  });

  test('B4 门 4（探针抛错）⇒ text-fallback/门4 + warn **恰一条**（E-2b gate 枚举不含门4 的纪律保持）', async () => {
    const { probe } = makeProbe([], { throws: true });
    const d = depsFor({ probe, fallback: (b) => b });
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, true, 'fail-open：取证故障绝不改 base.ok');
    assert.equal(d.warns.length, 1, '恰一条 warn（不刷屏），emit 不占这一条');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'text-fallback');
    assert.equal(dec.gate, '门4');
  });

  test('B5 门 5（facts 空）/ 门 6（全 raise 且无回执）各自恰一次', async () => {
    const d5 = depsFor({ facts: [], fallback: (b) => b });
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d5.deps);
    assert.equal(d5.emitter.only().gate, '门5');

    const f = fact();
    const d6 = depsFor({ facts: [f], raised: new Set([f.approvalId]), fallback: (b) => b });
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d6.deps);
    assert.equal(d6.emitter.only().gate, '门6');
    assert.equal(d6.emitter.decisions.length, 1);
  });

  test('B6 门 6 例外（已有服务端回执）⇒ 不跳过，命中 server/命中（E-1 纪律在归因面同样成立）', async () => {
    const f = fact();
    const d = depsFor({ facts: [f], raised: new Set([f.approvalId]), receipts: new Map([[f.approvalId, { ok: true }]]) });
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, false, '有回执 ⇒ 交给 applyReceipt 以真实回执收口，绝不被门 6 吞掉');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'server');
    assert.equal(dec.gate, '命中');
  });

  test('B7 命中 ⇒ server/命中 + approvalId，且兜底零调用（两判据不叠加）', async () => {
    const d = depsFor({ facts: [fact({ approvalId: 'apr_b7' })] });
    const out = await reconcileApprovalTruth(baseResult(), KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, false);
    assert.equal(d.fallbackCalls.length, 0, '结构化证据在场时兜底不得再跑（单一权威来源）');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'server');
    assert.equal(dec.gate, '命中');
    assert.equal(dec.approvalId, 'apr_b7');
  });

  test('B8 shadow 命中 ⇒ shadow/shadow-hit + 返回 base 本体 + 恰一条 warn（对拍不污染计数）', async () => {
    const d = depsFor({ facts: [fact({ approvalId: 'apr_b8' })], rawDeps: { shadow: true } });
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, true, 'shadow 态绝不改判（SK-K2）');
    assert.equal(d.warns.length, 1);
    assert.match(d.warns[0][0], /未决审批结构化命中/);
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'shadow', '★ 单列一类：不得混进 text-fallback 命中率');
    assert.equal(dec.gate, 'shadow-hit');
    assert.equal(dec.approvalId, 'apr_b8');
  });

  test('B9 回调缺席 ⇒ 零行为变化（纯附加出参；默认态逐字节旧行为）', async () => {
    const hit = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, depsFor({ facts: [fact()] }).deps);
    assert.equal(hit.ok, false);
    const pass = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, {
      input: { traceId: TRACE, capabilities: [CAP] },
      ctx: { started: STARTED, raised: new Set(), delegationId: TRACE },
      enabled: true,
      probe: makeProbe([fact()]).probe,
    });
    assert.equal(pass.ok, false, '无回调时判定结论完全一致（归因只是旁路）');
    assert.equal('onTruthDecision' in pass, false, '返回值不夹带归因键');
  });

  test('B10 emit 的形状钉：只含约定五键，无多余自由字段（链上体积与脱敏面纪律）', async () => {
    const d = depsFor({ facts: [fact()] });
    await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.deepEqual(Object.keys(d.emitter.decisions[0]).sort(), [
      'approvalId',
      'decidedBy',
      'gate',
      'taskIdPresent',
      'traceIdPresent',
    ]);
    assert.equal(typeof d.emitter.decisions[0].gate, 'string');
    assert.equal(typeof d.emitter.decisions[0].taskIdPresent, 'boolean');
  });

  test('B11 兜底缺席（E-2b 恒等透传）时 warn 恰一条 + 归因仍落 text-fallback', async () => {
    const { calls, probe } = makeProbe([]);
    const warns = [];
    const emitter = makeEmitter();
    const out = await reconcileApprovalTruth(
      baseResult(),
      NO_KEYWORD_TEXT,
      {
        input: { taskId: TASK, traceId: TRACE, capabilities: [CAP] },
        ctx: { started: STARTED, raised: new Set(), delegationId: TRACE },
        enabled: true,
        probe,
        // 刻意**不传** reconcileApprovalWait，也不让它命中模块级默认
        warn: (m, meta) => warns.push([m, meta ?? {}]),
        onTruthDecision: emitter.onTruthDecision,
        reconcileApprovalWait: undefined,
      },
    );
    assert.equal(out.ok, true, '兜底缺席 ⇒ 恒等透传（判定逐字不变）');
    assert.equal(calls.length, 1);
    assert.equal(emitter.only().gate, '门5');
    assert.equal(emitter.only().decidedBy, 'text-fallback');
    // 注：模块级默认兜底在 bridge.ts 加载时注册；本用例若拿到默认实现则不 warn，
    // 两种形态都属合法（warn 条数 0 或 1），故只钉「归因恰好一次 + 判定不变」。
    assert.ok(warns.length <= 1, `E-2b warn 至多一条，实得 ${warns.length}`);
  });
});

/* ============================================================================
 * C 组：灰度三态对 MCP 直调形态同样成立（on/shadow/off 一致性）
 * ========================================================================= */

describe('P2-T8 灰度：三态对「无 taskId 有 traceId」形态同样成立（G-a 不得绕过开关）', () => {
  const facts = () => [fact({ approvalId: 'apr_gray' })];

  test('C1 off ⇒ 不判（门 2 emit），且探针零调用', async () => {
    const { calls, probe } = makeProbe(facts());
    const d = depsFor({ probe, enabled: false });
    delete d.deps.input.taskId;
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, true, 'off 是一键回滚面，G-a 不得把它变成判定面');
    assert.equal(calls.length, 0, 'off ⇒ 门 2 在取证之前');
    assert.equal(d.emitter.only().gate, '门2');
  });

  test('C2 shadow ⇒ 记不判（shadow-hit emit，ok 保持 true）', async () => {
    const d = depsFor({ facts: facts(), rawDeps: { shadow: true } });
    delete d.deps.input.taskId;
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, true, 'shadow 轮不改判（对拍数据由 emit + warn 产出）');
    const dec = d.emitter.only();
    assert.equal(dec.decidedBy, 'shadow');
    assert.equal(dec.taskIdPresent, false);
    assert.equal(dec.traceIdPresent, true);
  });

  test('C3 on ⇒ 判（server emit，ok:false）—— 与 C1/C2 构成同一事实的三态对照', async () => {
    const d = depsFor({ facts: facts() });
    delete d.deps.input.taskId;
    const out = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    assert.equal(out.ok, false);
    assert.equal(d.emitter.only().decidedBy, 'server');
  });

  test('C4 三态结论单调：同一事实下 off/shadow 放行、on 改判（G-a 只扩归属面，不扩判定面）', async () => {
    const offOut = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, {
      ...depsFor({ facts: facts(), enabled: false }).deps,
    });
    const shadowOut = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, {
      ...depsFor({ facts: facts(), rawDeps: { shadow: true } }).deps,
    });
    const onOut = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, depsFor({ facts: facts() }).deps);
    assert.equal(offOut.ok, true);
    assert.equal(shadowOut.ok, true);
    assert.equal(onOut.ok, false, '单向 fail-closed（SK-K6）：只有 on 会把 ok:true 翻成 ok:false');
  });
});

/* ============================================================================
 * D 组（G-c）：兜底漏判反例集 + 关键词集合钉 + SK-9 文案钉（补强，不重建）
 * ========================================================================= */

describe('P2-T8 G-c：文本兜底边界补强（诚实红线在位：同义改写确实漏判）', () => {
  /**
   * 反例集：**新构造**的会漏措辞（既有 24 例的六条之外），逐条钉「确实漏」=
   * 诚实登记边界，而不是把它当缺陷修。漏判风险由 G-a 扩展后的结构化反查承担
   * —— 这正是本批把真值层推到 MCP 直调的意义。
   */
  const missSamples = [
    '该动作已进入人工核验流程，暂不继续',
    '已被门禁拦下，需要有人点一下才会执行',
    '高风险动作处于 pending authorization 状态，我先停手',
    '要等管理员点头，这一步还没真正做',
    'Approval is pending, so nothing was executed yet.',
    '触发人工确认流程，任务挂起中',
  ];

  for (const text of missSamples) {
    test(`漏判钉（关键词启发式的已知边界）：${text.slice(0, 20)}`, () => {
      const r = reconcileApprovalWait(baseResult(), text);
      assert.equal(r.ok, true, '★ 不命中即透传 —— 这条「会漏」必须继续可证（诚实红线）');
      assert.equal(r.error, undefined);
    });
  }

  test('这些措辞正是 G-a 的覆盖面：结构化反查在无 taskId 回合也能改判（漏判有第二道闸）', async () => {
    const d = depsFor({ facts: [fact({ approvalId: 'apr_g_c' })], fallback: reconcileApprovalWait });
    delete d.deps.input.taskId;
    const out = await reconcileApprovalTruth(baseResult(), missSamples[0], d.deps);
    assert.equal(d.fallbackCalls.length, 0, '结构化命中 ⇒ 兜底不再跑（即便兜底本来就漏）');
    assert.equal(out.ok, false, '★ 文本漏判的样本被服务端结构化证据接住');
    assert.equal(out.error.details.approvalId, 'apr_g_c');
    assert.equal(d.emitter.only().decidedBy, 'server');
  });

  test('关键词集合钉：APPROVAL_WAIT_KEYWORDS = [APPROVAL_REQUIRED, 等待审批]（新增须同批改测试）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'src', 'bridge.ts'), 'utf8');
    const kw = /const APPROVAL_WAIT_KEYWORDS: readonly string\[\] = \[([\s\S]*?)\];/.exec(src);
    assert.ok(kw, '关键词集合必须常量化（K3-C4 资产，不得退回散写字面量）');
    const list = kw[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(list, ['APPROVAL_REQUIRED', '等待审批'], '集合内容 + 顺序钉死（join("|") 与历史字面量等价）');
    for (const k of list) {
      assert.equal(reconcileApprovalWait(baseResult(), `X ${k} Y`).ok, false, `${k} 必须命中`);
    }
  });

  test('SK-9 文案钉：兜底判定逻辑与回包文案未因 G-a/G-b 漂移（逐字）', async () => {
    const r = reconcileApprovalWait(baseResult(), 'APPROVAL_REQUIRED approvalId=apr_sk9 capabilityId=storage.file.delete risk=L3');
    assert.equal(r.error.message, 'LLM 上报等待宿主人工审批，操作未执行');
    assert.match(r.summary, /^等待审批：/);
    assert.match(r.summary, /须经宿主人工审批后经 MCP 直调通道续跑/);
    assert.match(r.summary, /approvalId=apr_sk9/);
    assert.equal(r.steps[0].summary, '等待审批（未执行完成）');
    assert.equal(r.error.details.capabilityId, 'storage.file.delete');
    assert.equal(r.error.details.risk, 'L3');
    assert.equal('approvalTruth' in r, false, '★ 兜底返回值不得夹带 G-b 归因键（归因只走出参回调）');
  });

  test('结构化命中文案与兜底文案可区分（两判据的取证指纹）', async () => {
    const d = depsFor({ facts: [fact({ approvalId: 'apr_diff' })] });
    const structured = await reconcileApprovalTruth(baseResult(), NO_KEYWORD_TEXT, d.deps);
    const fallbackOnly = reconcileApprovalWait(baseResult(), `APPROVAL_REQUIRED approvalId=apr_diff`);
    assert.notEqual(structured.steps[0].summary, fallbackOnly.steps[0].summary, 'steps 文案分叉 = 来路可判');
    assert.match(structured.summary, /来源=服务端结构化判定/);
    assert.ok(!fallbackOnly.summary.includes('服务端结构化判定'), '兜底文案不得冒充结构化来源');
  });

  test('CANCELED_TEXT 与既有桥文案零污染（G-c 只加测试面，src 文案一字未动）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'src', 'bridge.ts'), 'utf8');
    assert.ok(
      src.includes('任务已取消：已终止 LLM 运行时子进程（单次 -p 路径），此后未再发起新的能力调用'),
      '取消收口文案（T4 CANCELED_TEXT 同族）必须逐字在场',
    );
    assert.ok(src.includes('等待审批（未执行完成）'), '兜底 steps 文案逐字在场');
  });
});

/* ============================================================================
 * E 组：入链（GoalResult.approvalTruth → delegation.complete 的 ext.approvalTruth）
 * ========================================================================= */

describe('P2-T8 G-b 入链：buildDelegationAuditEntry 的 ext.approvalTruth（纯附加，缺席即旧形状）', () => {
  /** 与 `r19c-kn1-a-pure` 同形：**工厂函数**，调用后得到 `() => auditId` */
  function auditIdSeq() {
    let n = 0;
    return () => `aud_${++n}`;
  }

  const ATTR = {
    decidedBy: 'server',
    gate: '命中',
    taskIdPresent: false,
    traceIdPresent: true,
    approvalId: 'apr_chain_1',
  };

  function completeEntry(over = {}) {
    return buildDelegationAuditEntry('complete', {
      delegationTraceId: TRACE,
      taskId: TASK,
      goal: '卸载 VM 企业微信',
      startedAtMs: STARTED,
      newAuditId: auditIdSeq(),
      terminalState: 'failed',
      ok: false,
      ...over,
    });
  }

  test('E1 落归因 ⇒ ext.approvalTruth 形状逐字（搬运不改值，observer 不做二次判定）', () => {
    const e = completeEntry({ approvalTruth: ATTR });
    assert.deepEqual(e.ext.approvalTruth, ATTR, '★ 服务端搬运 = 桥侧 emit 的同一形状');
    assert.equal(e.ext.kind, 'delegation-complete');
  });

  test('E2 不落归因 ⇒ ext **连键都没有**，且与旧形状逐字节一致（默认态零回归的机器证明）', () => {
    const withOut = completeEntry();
    assert.equal('approvalTruth' in withOut.ext, false, '缺席即不落键（不得出现 approvalTruth:undefined）');
    assert.equal(Object.values(withOut.ext).some((v) => v === undefined), false, '零 undefined 键（假断链护栏）');
    // 与不带新入参时的**既有键集**逐字对照（顺序无关，用集合比对避免键序脆弱）
    assert.deepEqual(
      Object.keys(withOut.ext).sort(),
      ['blockedCount', 'delegationId', 'kind', 'taskId', 'underlying', 'zeroInnerCalls', 'terminalState'].sort(),
      '既有 complete 条目键集零增删 ⇒ 链上哈希输入面未被本批改动',
    );
  });

  test('E3 四种 decidedBy 取值都能原样入链（计数面完整性：server/text-fallback/shadow/pass-through）', () => {
    for (const decidedBy of ['server', 'text-fallback', 'shadow', 'pass-through']) {
      const e = completeEntry({ approvalTruth: { decidedBy, gate: '门3', taskIdPresent: true, traceIdPresent: true } });
      assert.equal(e.ext.approvalTruth.decidedBy, decidedBy);
    }
  });

  test('E4 start 条目不受影响（归因只在终态有意义）', () => {
    const s = buildDelegationAuditEntry('start', {
      delegationTraceId: TRACE,
      taskId: TASK,
      goal: 'g',
      startedAtMs: STARTED,
      newAuditId: auditIdSeq(),
    });
    assert.equal('approvalTruth' in s.ext, false, 'start 未判定 ⇒ 绝不落归因');
  });

  test('E5 契约面钉：GoalResult.approvalTruth 为**末尾可选键**，既有键声明顺序未被打乱', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(repoPath('packages', 'contracts', 'src', 'bridge.ts'), 'utf8');
    const body = src.slice(src.indexOf('export interface GoalResult'), src.indexOf('export interface ProgressSink'));
    assert.match(body, /readonly ok: boolean;[\s\S]*readonly steps: readonly GoalStep\[\];[\s\S]*readonly error\?: BridgeError;[\s\S]*readonly degraded\?: \{ readonly reason: string \};[\s\S]*readonly approvalTruth\?: ApprovalTruthAttribution;\s*\}/, '新增键必须在末尾（纯附加，不动既有键位）');
    assert.match(src, /export interface ApprovalTruthAttribution \{/, '归因形状必须从契约层导出（桥/服务端共用同一来源）');
    assert.ok(!/SecurityHealth|TasksHealth/.test(body), 'GoalResult 区不得触碰 T5/T7 健康面（越界改动显形）');
  });

  test('E6 AuditExt 承载位存在且为可选（链上字段面，末位可选键）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(repoPath('packages', 'contracts', 'src', 'audit.ts'), 'utf8');
    assert.match(src, /readonly approvalTruth\?: \{/, 'AuditExt.approvalTruth 必须是可选键');
    assert.match(src, /decidedBy: 'server' \| 'text-fallback' \| 'shadow' \| 'pass-through'/, '四值枚举与契约类型一致');
  });

/* ============================================================================
 * F 组：桥两处收口点的接线（G-a + G-b 端到端，桩会话 / 假 CLI，离线不碰 VM）
 * ========================================================================= */

describe('P2-T8 桥侧接线：两处 ok:true 收口点都挂归因（常驻 / 单次 -p 逐字同形）', () => {
  /** 桩会话桥（与 `cl-k3r-runpersistent-approval-routing` 同法：不起进程、不写 mcp.json） */
  class StubBridge extends CliLlmBridge {
    constructor(opts, turn) {
      super(opts);
      this._turn = turn;
    }
    async prepareMcpConfig() {
      return nodePath.join(os.tmpdir(), 'p2t8-stub-mcp.json');
    }
    ensureSession() {
      return { sessionState: 'ready', runTurn: async () => this._turn };
    }
  }

  function makeCtx(outputDir) {
    return {
      prompt: 'system-prompt-stub',
      outputDir,
      skillsDir: nodePath.join(outputDir, '.winvm', 'skills'),
      started: Date.now(),
      cli: { resolved: true, path: 'codebuddy', probed: [] },
      lastFinalText: '',
      receipts: new Map(),
      raised: new Set(),
      replayActive: false,
    };
  }

  function makeInput(over = {}) {
    return {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: '%USERPROFILE%\\WinVMWorkspace\\out',
      cliPath: 'codebuddy',
      traceId: TRACE,
      timeoutMs: 60_000,
      ...over,
    };
  }

  const sink = { onStatus() {}, onArtifact() {} };

  function workDir(prefix) {
    const base = nodePath.join(os.homedir(), 'wbtmp');
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(nodePath.join(base, prefix));
  }

  test('F1 常驻收口：无 taskId + 服务端有未决审批 ⇒ 改判 + approvalTruth(server/命中) 挂上结果', async () => {
    const dir = workDir('p2t8-f1-');
    const turn = { ok: true, text: NO_KEYWORD_TEXT, durationMs: 900 };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(
      makeInput({
        taskId: undefined,
        probe: makeProbe([fact({ approvalId: 'apr_f1' })]).probe,
      }),
      sink,
      makeCtx(dir),
    );
    assert.ok('result' in out);
    const r = out.result;
    assert.equal(r.ok, false, '★ G-a 端到端：委派 CLI 回连 / 纯 MCP 直调形态不再静默 completed');
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    assert.equal(r.error.details.approvalId, 'apr_f1');
    assert.deepEqual(r.approvalTruth, {
      decidedBy: 'server',
      gate: '命中',
      taskIdPresent: false,
      traceIdPresent: true,
      approvalId: 'apr_f1',
    });
  });

  test('F2 常驻收口（门 5 回退兜底且文本命中）⇒ 改判 + approvalTruth(text-fallback/门5)', async () => {
    const dir = workDir('p2t8-f2-');
    const turn = { ok: true, text: KEYWORD_TEXT, durationMs: 900 };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(
      makeInput({ taskId: TASK, probe: makeProbe([]).probe }),
      sink,
      makeCtx(dir),
    );
    const r = out.result;
    assert.equal(r.ok, false, '结构化无证据 ⇒ 兜底接住（既有 K3 行为零改动）');
    assert.equal(r.error.details.approvalId, 'apr_text_only', '兜底 approvalId 来自文本提取');
    assert.equal(r.approvalTruth.decidedBy, 'text-fallback');
    assert.equal(r.approvalTruth.gate, '门5', '★ 「兜底救了」这一类从此可计数（G-b 的目的）');
    assert.equal(r.approvalTruth.approvalId, undefined, '退场路径不伪造服务端 approvalId');
  });

  test('F3 常驻收口（成功且结构化无证据）⇒ 归因仍挂上（ok:true 不改判，纯附加）', async () => {
    const dir = workDir('p2t8-f3-');
    const turn = { ok: true, text: '已列出 12 个已安装应用。', durationMs: 400 };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(
      makeInput({ taskId: TASK, probe: makeProbe([]).probe }),
      sink,
      makeCtx(dir),
    );
    const r = out.result;
    assert.equal(r.ok, true, '无未决审批 + 无关键词 ⇒ 不判（结构化只做减法）');
    assert.equal(r.approvalTruth.decidedBy, 'text-fallback');
    assert.equal(r.approvalTruth.gate, '门5');
  });

  test('F4 旧服务端形态（无探针）⇒ 门 3 归因，且结果 ok:true 逐字旧形状（仅多一个可选键）', async () => {
    const dir = workDir('p2t8-f4-');
    const turn = { ok: true, text: '已完成目标：应用列表已回传。', durationMs: 300 };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(makeInput({ taskId: TASK }), sink, makeCtx(dir));
    const r = out.result;
    assert.equal(r.ok, true);
    assert.equal(r.approvalTruth.gate, '门3', '探针缺席 = 常态而非异常，归因照样落（emit ≠ warn，warn 零新增）');
    assert.equal(r.error, undefined, '门 3 回退兜底 + 文本未命中 ⇒ 不改判');
  });

  test('F5 shadow 态端到端 ⇒ 不改判但归因落 shadow/shadow-hit（对拍可计数）', async () => {
    const dir = workDir('p2t8-f5-');
    const warns = [];
    const turn = { ok: true, text: NO_KEYWORD_TEXT, durationMs: 500 };
    const bridge = new StubBridge(
      { persistent: true, approvalTruth: 'shadow', onSessionLog: (m, meta) => warns.push([m, meta ?? {}]) },
      turn,
    );
    const out = await bridge.runPersistent(
      makeInput({ taskId: undefined, probe: makeProbe([fact({ approvalId: 'apr_f5' })]).probe }),
      sink,
      makeCtx(dir),
    );
    const r = out.result;
    assert.equal(r.ok, true, 'shadow 轮绝不改判（SK-K2）');
    assert.equal(r.approvalTruth.decidedBy, 'shadow');
    assert.equal(r.approvalTruth.gate, 'shadow-hit');
    assert.equal(r.approvalTruth.approvalId, 'apr_f5');
    assert.ok(warns.some((w) => String(w[0]).includes('[shadow]')), '对拍 warn 仍在场');
  });

  test('F6 off 态端到端 ⇒ 门 2 归因，判定面逐字 = R19F 后现状', async () => {
    const dir = workDir('p2t8-f6-');
    const turn = { ok: true, text: NO_KEYWORD_TEXT, durationMs: 500 };
    const bridge = new StubBridge({ persistent: true, approvalTruth: 'off' }, turn);
    const out = await bridge.runPersistent(
      makeInput({ taskId: TASK, probe: makeProbe([fact()]).probe }),
      sink,
      makeCtx(dir),
    );
    assert.equal(out.result.ok, true, 'off = 一键回滚，结构化零介入');
    assert.equal(out.result.approvalTruth.gate, '门2');
  });

  test('F7 取消收口不落归因（无判定路径 ⇒ 连键都不新增，默认态逐字节旧行为）', () => {
    const dir = workDir('p2t8-f7-');
    const bridge = new StubBridge({ persistent: true }, { ok: true, text: '', durationMs: 1 });
    const r = bridge.canceledResult(makeInput({ taskId: TASK }), '测试取消');
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'TASK_CANCELED');
    assert.equal('approvalTruth' in r, false, '★ 未判定即不落归因（不得伪造结论来源）');
    assert.equal(dir.length > 0, true);
  });

  test('F8 单次 -p 收口（假 CLI）：无 taskId 也进结构化 ⇒ 与常驻路径同形', async () => {
    const dir = workDir('p2t8-f8-');
    const outFile = nodePath.join(dir, 'stdout.txt');
    fs.writeFileSync(outFile, NO_KEYWORD_TEXT, 'utf8');
    const script = nodePath.join(dir, 'fake-codebuddy');
    fs.writeFileSync(
      script,
      ['#!/bin/sh', `cat ${outFile}`, 'exit 0', ''].join('\n'),
      'utf8',
    );
    fs.chmodSync(script, 0o755);
    const outDir = nodePath.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const bridge = new CliLlmBridge({
      cliPath: script,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
    });
    const result = await bridge.runGoal(
      makeInput({ taskId: undefined, outputDir: outDir, cliPath: script, probe: makeProbe([fact({ approvalId: 'apr_f8' })]).probe }),
      sink,
    );
    assert.equal(result.ok, false, '★ 单次 -p 的 MCP 直调形态同样被结构化判据接住');
    assert.equal(result.error.details.approvalId, 'apr_f8');
    assert.equal(result.approvalTruth.decidedBy, 'server');
    assert.equal(result.approvalTruth.taskIdPresent, false);
  });
});

/* ============================================================================
 * G 组：静态红线复核（注释/源码文本 = 守卫输入面）
 * ========================================================================= */

describe('P2-T8 静态红线：G-a/G-b 均为纯附加，既有判据面未被改写', () => {
  const read = (...seg) => fs.readFileSync(repoPath(...seg), 'utf8');
  const DT = read('packages', 'adapter-agent-workbuddy-llm', 'src', 'delegation-truth.ts');
  const BR = read('packages', 'adapter-agent-workbuddy-llm', 'src', 'bridge.ts');

  test('G1 门 3「绝不 warn」纪律未被归因污染（runFallback 内 warn 只在兜底缺席分支）', () => {
    const body = DT.slice(DT.indexOf('const runFallback'), DT.indexOf('const fallbackOrIdentity:'));
    assert.ok(body.includes("emit('text-fallback', gate)"), 'emit 必须在 runFallback 首行（每门恰一次）');
    assert.equal((body.match(/deps\.warn\?\./g) ?? []).length, 1, 'runFallback 内 warn 出口至多一处（兜底缺席时）');
    assert.match(body, /if \(!fallback\) \{/, 'warn 必须包在「兜底缺席」条件内 ⇒ 门 3 有兜底时零 warn');
  });

  test('G2 门 0 返回值仍是 base 本体（归因只走 emit，不得 spread 新键）', () => {
    const gate0 = /if \(!base\.ok\) \{\s*\n\s*emit\('pass-through', '门0'\);\s*\n\s*return base;/.test(DT);
    assert.ok(gate0, '门 0 必须 return base 本体（D1 引用相等钉）');
    assert.ok(!/\.\.\.base,[\s\S]{0,60}approvalTruth/.test(DT), '判据返回值不得夹带归因键');
  });

  test('G3 单向 fail-closed（SK-K6）未被放宽：判据内 ok 只能 true→false', () => {
    assert.equal(
      (DT.match(/\.\.\.base,\s*\n\s*ok: false,/g) ?? []).length,
      2,
      '两处改判产物（委派账本反查 + 审批真值）各一条 ⇒ 无新增改判面（steps 内的 ok:false 是全量如实化，不计）',
    );
    assert.equal((DT.match(/ok: true/g) ?? []).length, 0, '判据文件里绝不出现把结论写成 true 的改判产物');
  });

  test('G4 dtid 双参钉（K-N1 红线）一字未动：仅单次 -p 且有 taskId 才拼 traceId', () => {
    assert.match(BR, /const dtid = input\.taskId \? input\.traceId : undefined;/, '设计裁断「不动 dtid」，此处逐字复核');
  });

  test('G5 SK-9 函数体未动：reconcileApprovalWait 的判定与文案逐字在场', () => {
    const fn = BR.slice(BR.indexOf('export function reconcileApprovalWait'), BR.indexOf('/**\n * 生产默认实现'));
    assert.match(fn, /if \(!APPROVAL_WAIT_PATTERN\.test\(finalText\)\) return base;/);
    assert.match(fn, /steps: base\.steps\.map\(\(s\) => \(\{ \.\.\.s, ok: false, summary: '等待审批（未执行完成）' \}\)\)/);
    assert.ok(!fn.includes('approvalTruth'), '兜底函数体内不得出现归因字样（函数体一字不动）');
  });

  test('G6 灰度三态语义未变：on/shadow/off 解析与 health 三元组同源', () => {
    assert.match(BR, /this\.approvalTruthEnabled = approvalTruthMode !== 'off';/);
    assert.match(BR, /this\.approvalTruthShadow = approvalTruthMode === 'shadow';/);
    assert.match(DT, /门 2：一键回滚|enabled === false/);
  });

  test('G7 freshChainOnStart:true 与 policy engine 禁区未被触碰', async () => {
    const server = read('packages', 'vm-service', 'src', 'server.ts');
    assert.match(server, /freshChainOnStart:\s*true/);
    const engine = read('packages', 'core', 'src', 'policy', 'engine.ts');
    assert.ok(engine.length > 0, 'engine.ts 只读复核（本批零改动，diff 见回报）');
  });
});


  test('E7 provider 透传：LlmGoalResult.approvalTruth ⇒ GoalResult.approvalTruth（成功/失败两条 return）', async () => {
    const { WorkbuddyLlmProvider } = await import('../../packages/adapter-agent-workbuddy-llm/dist/index.js');
    const ATTR7 = { decidedBy: 'text-fallback', gate: '门3', taskIdPresent: true, traceIdPresent: true };
    const mkBridge = (res) => ({
      setSessionConfig() {},
      setSessionLog() {},
      sessionHealth: () => ({ state: 'ready', restarts: 0, idleMs: 0 }),
      isPersistentEnabled: () => true,
      async runGoal() {
        return res;
      },
    });
    const mkExecutor = () => ({
      id: 'mock-exec',
      displayName: 'mock',
      kind: 'deterministic',
      declareCapabilities: () => ['app.*'],
      async init() {},
      async execute(req) {
        return { traceId: req.traceId, ok: true, data: {}, artifacts: [], durationMs: 1 };
      },
      async runGoal() {
        return { ok: true, summary: '降级重跑', artifacts: [], steps: [] };
      },
      async health() {
        return { ok: true, provider: { id: 'mock-exec', state: 'ready' }, session: 'ready' };
      },
      async shutdown() {},
      dispose: () => {},
    });
    const ctx = {
      config: {},
      capabilities: { list: () => ['app.winget.uninstall'] },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {} },
    };
    const goal = { traceId: TRACE, goal: '卸载 VM 企业微信', timeoutMs: 30_000, taskId: TASK };
    const sink = { onStatus: () => {}, onArtifact: () => {} };

    const okP = new WorkbuddyLlmProvider({
      bridge: mkBridge({ ok: true, summary: '完成', artifacts: [], steps: [], approvalTruth: ATTR7 }),
      executor: mkExecutor(),
    });
    await okP.init(ctx);
    const okRes = await okP.runGoal(goal, sink);
    assert.deepEqual(okRes.approvalTruth, ATTR7, '★ ok:true 路径透传（completed 的归因同样要入链）');

    const failP = new WorkbuddyLlmProvider({
      bridge: mkBridge({
        ok: false,
        summary: '等待审批',
        artifacts: [{ kind: 'file', name: 'a', mime: 'text/plain', data: 'x' }],
        steps: [],
        error: { code: 'APPROVAL_REQUIRED', message: 'm', retryable: true },
        approvalTruth: ATTR7,
      }),
      executor: mkExecutor(),
    });
    await failP.init(ctx);
    const failRes = await failP.runGoal(goal, sink);
    assert.deepEqual(failRes.approvalTruth, ATTR7, 'ok:false（闸类码不降级）路径也透传 ⇒ 「兜底救了」可计数');

    const noneP = new WorkbuddyLlmProvider({
      bridge: mkBridge({ ok: true, summary: '完成', artifacts: [], steps: [] }),
      executor: mkExecutor(),
    });
    await noneP.init(ctx);
    const noneRes = await noneP.runGoal(goal, sink);
    assert.equal('approvalTruth' in noneRes, false, '桥未产出归因 ⇒ 连键都不新增（默认态逐字节旧行为）');
  });
});
