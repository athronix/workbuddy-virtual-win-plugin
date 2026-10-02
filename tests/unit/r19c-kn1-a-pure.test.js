/**
 * R19c T05 · K-N1 委派层审计真实性 —— **A 组：纯逻辑件**（设计 `docs/design/kn1-delegation-audit-contract.md` §9-A）
 *
 * 覆盖对象（全部可脱离 HTTP 服务 / ps-bridge / 真实 CLI 断言）：
 *   - `packages/vm-service/src/delegation-audit.ts`：`DelegationLedger` / `LedgerRegistry` /
 *     `buildDelegationAuditEntry` / `ReceiptCache` + `clipReceipt` / `wrapAuditSink` /
 *     `buildReceiptResponse`（服务端**只供事实、不改判**）；
 *   - `packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts`：`reconcileDelegationTruth`
 *     （§9-A-2 判定表 8 例）+ `evaluateDisabledRejection`（§9-A-3 真值表）—— 改判判据。
 *
 * ⚠ 实现落点偏差（登记，非测试缺陷）：设计 §8-T01 把 `reconcileDelegationTruth` /
 *   `evaluateDisabledRejection` 都列在 `vm-service/src/delegation-audit.ts`，实现按依赖方向
 *   （`vm-service → adapter`，判据产物是 `LlmGoalResult`）拆到
 *   `adapter-agent-workbuddy-llm/src/delegation-truth.ts`（该文件头注已自认偏差）。
 *   §9-A 的**判定表逐条等价**，仅 import 来源不同 —— 本文件按实况断言。
 *
 * 纪律：不起 HTTP 服务、不 spawn CLI、不碰 packages/ 源码。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDelegationAuditEntry,
  buildReceiptResponse,
  clipReceipt,
  DelegationLedger,
  DELEGATION_CAPABILITY_ID,
  LedgerRegistry,
  MAX_GOAL_CHARS,
  MAX_RECEIPT_DATA_CHARS,
  MAX_RECEIPT_ENTRIES,
  MAX_STEPS_SUMMARY,
  MAX_SUMMARY_CHARS,
  MAX_UNDERLYING_ITEMS,
  ReceiptCache,
  SHELL_CAPABILITY_ID,
  wrapAuditSink,
} from '@winvm/vm-service';
import {
  COMPLETION_CLAIM_PATTERN,
  evaluateDisabledRejection,
  reconcileDelegationTruth,
} from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const DTID = 'tr_mur1abcd_182';
const TASK = 'task_kn1_1';
const CAP = 'app.winget.uninstall';

function auditIdSeq() {
  let n = 0;
  return () => `aud_${++n}`;
}

/** `LlmGoalResult` 最小形状（桥的产物，供判据函数消费） */
function baseResult(over = {}) {
  return {
    ok: true,
    summary: 'LLM 运行时完成目标：卸载 VM 企业微信',
    artifacts: [],
    steps: [
      {
        index: 0,
        capabilityId: SHELL_CAPABILITY_ID,
        params: { goal: '卸载 VM 企业微信' },
        ok: true,
        risk: 'L1',
        durationMs: 1200,
        traceId: DTID,
        summary: 'LLM 自主规划并执行完成',
      },
    ],
    ...over,
  };
}

/** 假探针：固定/可编程活动计数 */
function probeWith(activity) {
  const calls = [];
  return {
    calls,
    probe: {
      async delegationActivity(delegationTraceId) {
        calls.push(delegationTraceId);
        if (activity instanceof Error) throw activity;
        if (typeof activity === 'function') return activity(delegationTraceId);
        return activity;
      },
    },
  };
}

const ZERO = { total: 0, executed: 0, blocked: 0, wild: 0 };
const mkActivity = (over = {}) => {
  const a = { executed: 0, blocked: 0, wild: 0, ...over };
  return { ...a, total: a.executed + a.blocked + a.wild };
};

/** `clip` 语义：截到上限后追加单个省略号 → 实际长度上限 = MAX + 1（有界性成立） */
const MAX_STEP_SUMMARY_LIMIT = 200 + 1;

/* ============================ A-1 buildDelegationAuditEntry ============================ */

describe('K-N1 A-1 壳双态审计条目（buildDelegationAuditEntry 字段/截断/脱敏口径）', () => {
  test('常量口径与设计 §2.2 逐字一致', () => {
    assert.equal(SHELL_CAPABILITY_ID, 'appops.workflow.run');
    assert.equal(DELEGATION_CAPABILITY_ID, SHELL_CAPABILITY_ID);
    assert.equal(MAX_UNDERLYING_ITEMS, 50);
    assert.equal(MAX_STEPS_SUMMARY, 10);
    assert.equal(MAX_GOAL_CHARS, 300);
    assert.equal(MAX_SUMMARY_CHARS, 500);
    assert.equal(MAX_RECEIPT_ENTRIES, 200);
    assert.equal(MAX_RECEIPT_DATA_CHARS, 1024);
  });

  test('start 态：channel=a2a / capabilityId=壳 / result.ok=true / summary=delegation.start', () => {
    const e = buildDelegationAuditEntry('start', {
      delegationTraceId: DTID,
      taskId: TASK,
      goal: '卸载 VM 企业微信',
      maxRisk: 'L2',
      allowedCapabilities: [CAP],
      startedAtMs: Date.now() - 10,
      newAuditId: auditIdSeq(),
    });

    assert.equal(e.traceId, DTID, '壳条目以**委派 traceId** 为键（S-3 端点按它反查）');
    assert.equal(e.auditId, 'aud_1');
    assert.equal(e.capabilityId, DELEGATION_CAPABILITY_ID);
    assert.equal(e.principal.channel, 'a2a', '委派通道真实化（修「181/181 恒 mcp」观测缺陷）');
    assert.equal(e.principal.host, 'vm-service');
    assert.equal(e.risk, 'L1');
    assert.deepEqual(e.policyDecision, { allowed: true, matchedRule: 'delegation' });
    assert.equal(e.result.ok, true, '受理即成功，无歧义（§2.1）');
    assert.equal(e.result.summary, 'delegation.start');
    assert.equal(e.result.errorCode, undefined);
    assert.deepEqual(e.params.allowedCapabilities, [CAP]);
    assert.equal(e.params.taskId, TASK);
    assert.equal(e.params.maxRisk, 'L2');
    assert.ok(typeof e.durationMs === 'number' && e.durationMs >= 0);
  });

  test('start 态 ext 只带 kind/delegationId/taskId —— underlying 缺席、zeroInnerCalls **不落**（未判定）', () => {
    const e = buildDelegationAuditEntry('start', {
      delegationTraceId: DTID,
      taskId: TASK,
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
    });
    assert.equal(e.ext.kind, 'delegation-start');
    assert.equal(e.ext.delegationId, DTID);
    assert.equal(e.ext.taskId, TASK);
    assert.equal('zeroInnerCalls' in e.ext, false, '未判定即不落该键（§2.2 start 条目口径）');
    assert.equal('underlying' in e.ext, false, 'start 无活动清单');
    assert.equal('terminalState' in e.ext, false);
    assert.equal('stepsSummary' in e.ext, false);
  });

  test('taskId 缺席 → ext 与 params 都不写该键（绝不出现 undefined）', () => {
    const e = buildDelegationAuditEntry('start', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
    });
    assert.equal('taskId' in e.ext, false);
    assert.equal('taskId' in e.params, false);
    assert.equal(Object.values(e.ext).some((v) => v === undefined), false);
    assert.equal(Object.values(e.params).some((v) => v === undefined), false);
  });

  test('goal 超 300 字符截断（+省略号），短 goal 逐字保留', () => {
    // 用非 base64 形态文本（纯中文），避免命中 redact 的长串 base64 指纹分支
    const long = buildDelegationAuditEntry('start', {
      delegationTraceId: DTID,
      goal: '目标'.repeat(200), // 400 字符
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
    });
    assert.equal(long.params.goal.length, MAX_GOAL_CHARS + 1, '截到 300 后追加单个省略号标记');
    assert.match(long.params.goal, /…$/);
    assert.ok(long.params.goal.startsWith('目标'.repeat(150)));

    const short = buildDelegationAuditEntry('start', {
      delegationTraceId: DTID,
      goal: '卸载企业微信',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
    });
    assert.equal(short.params.goal, '卸载企业微信');
  });

  test('goal 为超长 base64 blob 时经 redact 打为指纹形态（自由文本统一脱敏口径，零新增敏感面）', () => {
    const e = buildDelegationAuditEntry('start', {
      delegationTraceId: DTID,
      goal: 'A'.repeat(260),
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
    });
    assert.match(e.params.goal, /^<base64 len=260 sha256=[0-9a-f]{16}…>$/, 'blob 不内联原值');
    assert.doesNotMatch(e.params.goal, /A{20}/);
  });

  test('complete 态：零活动 → ok=false + summary 含「零工具调用；完成声称不予采信」+ ext 核心字段齐备', () => {
    const ledger = new DelegationLedger(DTID, TASK, [], Date.now() - 20);
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      taskId: TASK,
      goal: '卸载 VM 企业微信',
      startedAtMs: ledger.startedAtMs,
      newAuditId: auditIdSeq(),
      ledger,
      terminalState: 'failed',
      ok: false,
      errorCode: 'NO_EXECUTION_RECEIPT',
      downgraded: true,
      downgradeReason: '已超重建上限（5），此后回退单次 -p',
      steps: [{ capabilityId: SHELL_CAPABILITY_ID, ok: false, summary: '委派回合零服务端活动记录' }],
    });

    assert.equal(e.principal.channel, 'a2a');
    assert.equal(e.result.ok, false);
    assert.equal(e.result.errorCode, 'NO_EXECUTION_RECEIPT');
    assert.match(e.result.summary, /^delegation\.complete:failed/);
    assert.match(e.result.summary, /零工具调用；完成声称不予采信/);
    assert.equal(e.ext.kind, 'delegation-complete');
    assert.equal(e.ext.zeroInnerCalls, true, '★ 核心事实断言字段');
    assert.deepEqual(e.ext.underlying, []);
    assert.equal(e.ext.blockedCount, 0);
    assert.equal(e.ext.downgraded, true, '降级事实结构化（§4.4，不再靠 summary 文案匹配）');
    assert.equal(e.ext.downgradeReason, '已超重建上限（5），此后回退单次 -p');
    assert.equal(e.ext.terminalState, 'failed');
    assert.deepEqual(e.ext.stepsSummary, [
      { capabilityId: SHELL_CAPABILITY_ID, ok: false, summary: '委派回合零服务端活动记录' },
    ]);
  });

  test('complete 态 zeroInnerCalls **恒落**（即使终态 completed）—— §10-1/D-3：grep 可发现，不改判不告警', () => {
    const ledger = new DelegationLedger(DTID, TASK, [], Date.now());
    ledger.recordExecuted({ seq: 7, capabilityId: CAP, traceId: 'tr_inner' }, true);
    const act = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: ledger.startedAtMs,
      newAuditId: auditIdSeq(),
      ledger,
      terminalState: 'completed',
      ok: true,
    });
    assert.equal(act.ext.zeroInnerCalls, false);
    assert.doesNotMatch(act.result.summary, /零工具调用/);
    assert.equal(act.result.errorCode, undefined, 'completed 无 errorCode（§2.1）');

    // 零活动但 completed（无完成声称的漏网形态）→ 字段仍恒落，供人工审视
    const empty = new DelegationLedger(DTID, TASK, [], Date.now());
    const silent = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: empty.startedAtMs,
      newAuditId: auditIdSeq(),
      ledger: empty,
      terminalState: 'completed',
      ok: true,
    });
    assert.equal(silent.ext.zeroInnerCalls, true, 'D-3 拍板：零调用+completed 只保证可 grep，不改判不告警');
  });

  test('无 ledger（账本已收口/缺席）→ 按「零活动」如实落字段，绝不当成有活动', () => {
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: Date.now() - 5,
      newAuditId: auditIdSeq(),
      terminalState: 'failed',
      ok: false,
    });
    assert.equal(e.ext.zeroInnerCalls, true);
    assert.deepEqual(e.ext.underlying, []);
    assert.equal(e.ext.blockedCount, 0);
  });

  test('stepsSummary ≤10 项、单项 summary ≤200 字符（防整块输出灌进链）', () => {
    // 用非 base64 形态文本，避免命中 redact 的长串 base64 指纹分支（另有专测覆盖）
    const steps = Array.from({ length: 24 }, (_, i) => ({
      capabilityId: `app.x${i}`,
      ok: i % 2 === 0,
      summary: '结果'.repeat(300),
    }));
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
      terminalState: 'completed',
      ok: true,
      steps,
    });
    assert.equal(e.ext.stepsSummary.length, MAX_STEPS_SUMMARY, '超出 10 项部分直接丢弃');
    for (const s of e.ext.stepsSummary) {
      assert.equal(s.summary.length, MAX_STEP_SUMMARY_LIMIT, `实际 ${s.summary.length}（200+省略号）`);
      assert.ok(s.summary.startsWith('结果'.repeat(100)));
      assert.ok(typeof s.ok === 'boolean');
    }
  });

  test('result.summary 有界（含 resultSummary 追加；截断标记 +1，见回报「观测项」O-1）', () => {
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
      terminalState: 'completed',
      ok: true,
      resultSummary: '结果'.repeat(600),
    });
    // 设计 §2.1 写「≤500 字符」；实现 clip 语义是 slice(0,500)+'…' = 501。
    // 有界性（防爆链）成立，仅标记位多一个字符 → 登记为口径观测项 O-1，不改源码。
    assert.ok(e.result.summary.length <= MAX_SUMMARY_CHARS + 1, `实际 ${e.result.summary.length}`);
    assert.ok(e.result.summary.length >= MAX_SUMMARY_CHARS, '确实按上限截断而非放行长文');
    assert.match(e.result.summary, /…$/);
    assert.ok(e.result.summary.startsWith('delegation.complete:completed'));
  });

  test('underlying ≤50 项（账本聚合不爆链）', () => {
    const ledger = new DelegationLedger(DTID, TASK, [], Date.now());
    for (let i = 0; i < 70; i++) {
      ledger.recordExecuted({ seq: 100 + i, capabilityId: `app.c${i}`, traceId: `tr_i${i}` }, true);
    }
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: ledger.startedAtMs,
      newAuditId: auditIdSeq(),
      ledger,
      terminalState: 'completed',
      ok: true,
    });
    assert.equal(e.ext.underlying.length, MAX_UNDERLYING_ITEMS);
  });

  test('downgradeReason/resultSummary 走统一脱敏（纯 base64 blob 不内联原值）', () => {
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
      terminalState: 'failed',
      ok: false,
      downgraded: true,
      downgradeReason: 'B'.repeat(240),
      resultSummary: 'C'.repeat(300),
    });
    assert.match(e.ext.downgradeReason, /^<base64 len=240 sha256=[0-9a-f]{16}…>$/);
    assert.doesNotMatch(e.ext.downgradeReason, /B{20}/);
    assert.match(e.result.summary, /<base64 len=300 sha256=[0-9a-f]{16}…>/);
    assert.doesNotMatch(e.result.summary, /C{20}/);
  });

  test('ext 内敏感键名脱敏由 sink 落链前的递归 redact 兑现（§9-A-1 该条与 §9-F-1 同机制，见 F 组）', () => {
    // buildDelegationAuditEntry 产出的 ext 只含服务端可得事实字段（无自由敏感键）；
    // 「ext.password → ***REDACTED***」发生在 HashChainAuditSink.doAppend（chain.ts:288），
    // 由 r19c-kn1-f-chain.test.js F-1 逐字钉死（同一机制，避免双份断言漂移）。
    const e = buildDelegationAuditEntry('complete', {
      delegationTraceId: DTID,
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: auditIdSeq(),
      terminalState: 'failed',
      ok: false,
    });
    for (const v of Object.values(e.ext)) {
      assert.notEqual(v, undefined, '构造产物零 undefined 键（假断链护栏，contracts/audit.ts:118 纪律）');
    }
  });
});

/* ============================ A-2 reconcileDelegationTruth 判定表 ============================ */

describe('K-N1 A-2 委派账本反查判定表（§9-A-2 八例）', () => {
  const depsFor = (over = {}) => ({ delegationTraceId: DTID, taskId: TASK, ...over });

  test('① 无 taskId（纯 MCP 直调）→ 透传，且绝不查探针', async () => {
    const { probe, calls } = probeWith(ZERO);
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '企业微信已卸载，任务完成', {
      delegationTraceId: DTID,
      probe,
    });
    assert.equal(out, base, 'MCP 直调语义零改动');
    assert.equal(calls.length, 0, '非委派上下文不查账本');
  });

  test('② base.ok=false → 透传（不重复改判，两判据互斥的前提）', async () => {
    const { probe, calls } = probeWith(ZERO);
    const base = baseResult({ ok: false, summary: '已失败', error: { code: 'TIMEOUT' } });
    const out = await reconcileDelegationTruth(base, '任务完成', depsFor({ probe }));
    assert.equal(out, base);
    assert.equal(calls.length, 0, '门 1 在取证据之前');
  });

  test('③ 无完成声称 → 透传（文本无承诺时改判是过度推断，§10-1）', async () => {
    const { probe, calls } = probeWith(ZERO);
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '我需要更多信息才能继续。', depsFor({ probe }));
    assert.equal(out, base);
    assert.equal(calls.length, 0, '门 3 先于探针');
  });

  test('④ 完成声称 + total=0 → failed(NO_EXECUTION_RECEIPT)，details 带三通道计数', async () => {
    const { probe, calls } = probeWith(ZERO);
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '企业微信已卸载，任务完成', depsFor({ probe }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0], DTID, '探针键 = 委派 traceId');
    assert.equal(out.ok, false, 'K-N1 根治点：零活动假完成必须改判');
    assert.equal(out.error.code, 'EXECUTION_FAILED');
    assert.equal(out.error.reason, 'NO_EXECUTION_RECEIPT');
    assert.deepEqual(out.error.details.ledger, { executed: 0, blocked: 0, wild: 0 });
    assert.equal(out.error.details.taskId, TASK);
    assert.equal(out.error.details.delegationTraceId, DTID);
    assert.match(out.summary, /^执行回执缺失：/);
    assert.match(out.summary, /executed=0\/blocked=0\/wild=0/);
    assert.match(out.summary, /不予采信/);
  });

  test('⑤ 完成声称 + executed=1 → 透传（E1/E5 真执行委派零回归）', async () => {
    const { probe } = probeWith(mkActivity({ executed: 1 }));
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '卸载成功', depsFor({ probe }));
    assert.equal(out, base, '判「有活动」取宽松');
  });

  test('⑥ 完成声称 + blocked=1（executed=0）→ 透传（「到过且被拦」合法）', async () => {
    const { probe } = probeWith(mkActivity({ blocked: 1 }));
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '已卸载', depsFor({ probe }));
    assert.equal(out, base);

    const wildOnly = probeWith(mkActivity({ wild: 2 }));
    const out2 = await reconcileDelegationTruth(base, '已卸载', depsFor({ probe: wildOnly.probe }));
    assert.equal(out2, base, '通道 1 时间窗兜底同样构成活动证据');
  });

  test('⑦ 改判产物 steps 全 ok:false 且保留原 steps 长度（壳步骤自宣无证据地位，§3.1）', async () => {
    const { probe } = probeWith(ZERO);
    const base = baseResult({
      steps: [
        { index: 0, capabilityId: SHELL_CAPABILITY_ID, params: {}, ok: true, risk: 'L1', durationMs: 1, traceId: DTID, summary: 'a' },
        { index: 1, capabilityId: CAP, params: {}, ok: true, risk: 'L2', durationMs: 2, traceId: DTID, summary: 'b' },
        { index: 2, capabilityId: 'storage.dir.list', params: {}, ok: false, risk: 'L0', durationMs: 3, traceId: DTID, summary: 'c' },
      ],
    });
    const out = await reconcileDelegationTruth(base, '卸载成功', depsFor({ probe }));
    assert.equal(out.steps.length, 3, '长度保留（不裁步骤，宿主仍能对齐）');
    assert.ok(out.steps.every((s) => s.ok === false), 'steps 不得残留「成功」');
    assert.ok(out.steps.every((s) => s.summary === '委派回合零服务端活动记录，完成声称不予采信'));
    assert.equal(out.artifacts, base.artifacts, '产物事实不被改判抹掉（只改执行结论）');
  });

  test('⑧ error.reason 字符串与既有 reconcileExecutionTruth（bridge.ts:1025）用法逐字一致（同一 reason 复用）', async () => {
    const { probe } = probeWith(ZERO);
    const out = await reconcileDelegationTruth(baseResult(), '卸载成功', depsFor({ probe }));
    assert.equal(out.error.reason, 'NO_EXECUTION_RECEIPT');
    assert.equal(out.error.code, 'EXECUTION_FAILED', '错误码同样复用 K5 既有值（禁止出现第二种写法）');
    assert.doesNotMatch(out.error.reason, /_V2|DELEGATION_/);
  });

  test('门 4：未注入 probe（非 vm-service 宿主）→ 透传（旧行为逐字节不变）', async () => {
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '卸载成功', depsFor());
    assert.equal(out, base);
    const out2 = await reconcileDelegationTruth(base, '卸载成功', { taskId: TASK });
    assert.equal(out2, base, '无 delegationTraceId 同样透传');
  });

  test('fail-open：probe 抛错 → 透传 base + warn **恰一条**（取证故障绝不挂死委派）', async () => {
    const { probe } = probeWith(new Error('ledger store gone'));
    const warns = [];
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '卸载成功', depsFor({ probe, warn: (m, meta) => warns.push([m, meta]) }));
    assert.equal(out, base, '不改判（宁可放过，绝不误杀）');
    assert.equal(warns.length, 1, '恰一条告警（§9-B-3）');
    assert.match(warns[0][0], /探针异常/);
    assert.equal(warns[0][1].delegationTraceId, DTID);
    assert.match(String(warns[0][1].error), /ledger store gone/);
  });

  test('fail-open：probe 返回非法形状（total>0）→ 采信；warn 缺席不炸', async () => {
    const { probe } = probeWith(mkActivity({ executed: 3 }));
    const base = baseResult();
    const out = await reconcileDelegationTruth(base, '任务完成', depsFor({ probe }));
    assert.equal(out, base);
  });

  test('完成声称模式与 K5 判据同源（COMPLETION_CLAIM_PATTERN 单一来源，杜绝判据分叉）', async () => {
    assert.equal(COMPLETION_CLAIM_PATTERN.test('企业微信已卸载'), true);
    assert.equal(COMPLETION_CLAIM_PATTERN.test('uninstalled successfully'), true);
    assert.equal(COMPLETION_CLAIM_PATTERN.test('还在等待宿主审批'), false);
    assert.equal(COMPLETION_CLAIM_PATTERN.test('我无法继续，缺少参数'), false);
  });
});

/* ============================ A-3 evaluateDisabledRejection 真值表 ============================ */

describe('K-N1 A-3 disabled 三态拒绝真值表（§9-A-3，仅 (委派, persistent=true, disabled) 拒绝）', () => {
  const STATES = ['disabled', 'ready', 'stopped', 'starting'];

  for (const hasTaskId of [true, false]) {
    for (const persistent of [true, false]) {
      for (const state of STATES) {
        const shouldReject = hasTaskId === true && persistent === true && state === 'disabled';
        test(`taskId=${hasTaskId} persistent=${persistent} state=${state} → ${shouldReject ? 'REJECT' : 'pass'}`, () => {
          const v = evaluateDisabledRejection({ hasTaskId, persistent, sessionState: state });
          assert.equal(v.reject, shouldReject);
          if (shouldReject) {
            assert.equal(v.reason, 'LLM_SESSION_DISABLED');
          } else {
            assert.equal(v.reason, undefined, '放行不得带原因码');
          }
        });
      }
    }
  }

  test('边界钉死：(有 taskId, persistent=**false**, disabled) → **不拒绝**（§4.2「单次 -p 即设计」态）', () => {
    const v = evaluateDisabledRejection({ hasTaskId: true, persistent: false, sessionState: 'disabled' });
    assert.equal(v.reject, false, '两种降级语义必须可区分（假完成由账本反查兜底，不由入口拒绝）');
  });

  test('provider 未上报会话态（undefined）→ 不可判定即不拒绝（零回归取向）', () => {
    assert.equal(evaluateDisabledRejection({ hasTaskId: true, persistent: true }).reject, false);
    assert.equal(evaluateDisabledRejection({ hasTaskId: true, persistent: true, sessionState: undefined }).reject, false);
  });

  test('degraded / 未知态也不拒绝（只有 disabled 是「永久停用」语义）', () => {
    for (const s of ['degraded', 'ready', 'stopped', 'starting']) {
      assert.equal(evaluateDisabledRejection({ hasTaskId: true, persistent: true, sessionState: s }).reject, false, s);
    }
  });
});

/* ============================ A 附：账本 / 注册表 / 回执缓存 / sink 装饰器 ============================ */

describe('K-N1 A-4 DelegationLedger 三通道计数与聚合', () => {
  test('executed / blocked / wild 相加为 total，且判「零活动」必须三通道全空', () => {
    const l = new DelegationLedger(DTID, TASK, [], 1000);
    assert.deepEqual(l.activityCount(), ZERO);
    l.recordExecuted({ seq: 1, capabilityId: CAP, traceId: 'tr_a' }, true);
    assert.deepEqual(l.activityCount(), mkActivity({ executed: 1 }));
    l.recordBlocked(2, 'apr_1', 'app.store.install');
    assert.deepEqual(l.activityCount(), mkActivity({ executed: 1, blocked: 1 }));
    l.recordWild(3, 'gui.screen.capture');
    assert.deepEqual(l.activityCount(), mkActivity({ executed: 1, blocked: 1, wild: 1 }));
    assert.equal(l.blockedCount(), 1);
  });

  test('壳条目自身**永不**成为活动证据（§2.3「排除两条壳条目自身」）', () => {
    const l = new DelegationLedger(DTID, TASK, [], 1000);
    l.recordExecuted({ seq: 9, capabilityId: SHELL_CAPABILITY_ID, traceId: DTID }, true);
    assert.deepEqual(l.activityCount(), ZERO);
  });

  test('收口后一律忽略迟到登记（关账幂等，已收口账本不得被污染）', () => {
    const l = new DelegationLedger(DTID, TASK, [], 1000);
    l.recordExecuted({ seq: 1, capabilityId: CAP, traceId: 'tr_a' }, true);
    l.close();
    assert.equal(l.isClosed, true);
    l.recordExecuted({ seq: 2, capabilityId: 'app.store.install', traceId: 'tr_b' }, true);
    l.recordBlocked(3, 'apr_x', 'app.store.install');
    l.recordWild(4, 'storage.dir.list');
    l.noteInnerTraceId('tr_late');
    assert.deepEqual(l.activityCount(), mkActivity({ executed: 1 }));
    assert.deepEqual(l.innerCallTraceIds(), ['tr_a'], '迟到 traceId 不登记');
  });

  test('时间窗与暴露面判据（空集=不限制；毫秒比较，绝不用 query({since}) 字符串语义）', () => {
    const l = new DelegationLedger(DTID, TASK, [CAP], 5000);
    assert.equal(l.inWindow(5000), true);
    assert.equal(l.inWindow(4999), false);
    assert.equal(l.isExposed(CAP), true);
    assert.equal(l.isExposed('other.cap'), false);
    const all = new DelegationLedger(DTID, TASK, [], 5000);
    assert.equal(all.isExposed('anything'), true, '空暴露面视为全放行（单测/降级场景）');
  });

  test('underlying 聚合：同能力并入 count/seqs、blocked 携 approvalId、wild 并入清单（取证不断层）', () => {
    const l = new DelegationLedger(DTID, TASK, [], 1000);
    l.recordExecuted({ seq: 179, capabilityId: CAP, traceId: 'tr_i1' }, false);
    l.recordExecuted({ seq: 180, capabilityId: CAP, traceId: 'tr_i1' }, true);
    l.recordBlocked(181, 'apr_9', CAP);
    l.recordWild(182, 'gui.screen.capture');
    l.recordWild(183, CAP);

    const u = l.underlying();
    assert.equal(u.length, 2);
    const [winget, gui] = u;
    assert.equal(winget.capabilityId, CAP);
    assert.equal(winget.ok, true, '任一记录 ok=true 即 true（保守口径）');
    assert.equal(winget.count, 4, 'executed 2 + blocked 1 + wild 1');
    assert.equal(winget.approvalId, 'apr_9', 'blocked 关联审批 ID 进清单（壳被拦 vs 壳零活动第一次可区分）');
    assert.deepEqual([...winget.auditSeqs], [179, 180, 181, 183]);
    assert.equal(gui.capabilityId, 'gui.screen.capture');
    assert.equal(gui.count, 1);
    assert.equal('approvalId' in gui, false, '无 blocked 不写该键');
    assert.deepEqual(gui.auditSeqs, [182]);
  });

  test('纯 blocked 也单独成项（只有拦截、没有执行时清单仍可取证）', () => {
    const l = new DelegationLedger(DTID, TASK, [], 1000);
    l.recordBlocked(5, 'apr_only', 'app.store.install');
    const u = l.underlying();
    assert.equal(u.length, 1);
    assert.deepEqual(u[0], {
      capabilityId: 'app.store.install',
      ok: false,
      count: 1,
      approvalId: 'apr_only',
      auditSeqs: [5],
    });
  });

  test('有界性：blocked / wild ≤50 条、underlying seqs ≤50 项（长回合不爆链）', () => {
    const l = new DelegationLedger(DTID, TASK, [], 1000);
    for (let i = 0; i < 80; i++) {
      l.recordExecuted({ seq: i, capabilityId: CAP, traceId: `tr_${i}` }, true);
      l.recordBlocked(i, `apr_${i}`, CAP);
      l.recordWild(i, CAP);
    }
    assert.equal(l.underlying()[0].auditSeqs.length, MAX_UNDERLYING_ITEMS, '取证指针有界');
    assert.equal(l.blockedCount(), MAX_UNDERLYING_ITEMS, 'blocked 登记有界');
    const act = l.activityCount();
    assert.equal(act.blocked, MAX_UNDERLYING_ITEMS);
    assert.equal(act.wild, MAX_UNDERLYING_ITEMS);
    assert.equal(act.executed, 80, 'executed 计数如实（同能力计数不设上限，仅指针有界）');
    assert.equal(act.total, 80 + MAX_UNDERLYING_ITEMS * 2);
    // underlying 条目数有界（≤50 个能力）
    const many = new DelegationLedger(DTID, TASK, [], 1000);
    for (let i = 0; i < 70; i++) {
      many.recordExecuted({ seq: i, capabilityId: `app.c${i}`, traceId: `tr_${i}` }, true);
    }
    assert.equal(many.underlying().length, MAX_UNDERLYING_ITEMS);
  });
});

describe('K-N1 A-5 LedgerRegistry 归因与生命周期', () => {
  test('begin 幂等（同委派 traceId 重复注册保留原账本）；finish 关账并摘除', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const l1 = reg.begin(DTID, TASK, []);
    const l2 = reg.begin(DTID, TASK, []);
    assert.equal(l1, l2);
    assert.equal(reg.get(DTID), l1);
    const done = reg.finish(DTID);
    assert.equal(done, l1);
    assert.equal(l1.isClosed, true);
    assert.equal(reg.get(DTID), undefined, '终态即删，不永久占位');
    assert.equal(reg.finish(DTID), undefined, '重复 finish 幂等返回 undefined');
  });

  test('activityFor：存活账本取三通道；账本缺席 → 三零（桥侧 fail-open 兜底）', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const l = reg.begin(DTID, TASK, []);
    l.recordExecuted({ seq: 1, capabilityId: CAP, traceId: 'tr_a' }, true);
    assert.deepEqual(reg.activityFor(DTID), mkActivity({ executed: 1 }));
    assert.deepEqual(reg.activityFor('tr_other'), ZERO);
  });

  test('onAuditRecord 通道 2：ext.delegationId 命中存活账本 → 记 executed，**不再**重复进 wild', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    reg.begin(DTID, TASK, []);
    reg.onAuditRecord({
      seq: 11,
      ts: new Date(2000).toISOString(),
      traceId: 'tr_inner',
      capabilityId: CAP,
      policyDecision: { allowed: true, matchedRule: 'allow' },
      result: { ok: true },
      ext: { kind: 'inner-call', delegationId: DTID, channel: 'a2a' },
    });
    assert.deepEqual(reg.activityFor(DTID), mkActivity({ executed: 1 }));
    const u = reg.get(DTID).underlying();
    assert.equal(u[0].approvalId, undefined);
    assert.equal(u[0].ok, true);
  });

  test('onAuditRecord 通道 1：无 delegationId → 时间窗 + 暴露面命中的存活账本各记一条 wild', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const inWin = reg.begin('tr_a', 'task_a', [CAP]);
    reg.begin('tr_c', 'task_c', ['other.cap']);

    const rec = {
      seq: 21,
      ts: new Date(1500).toISOString(),
      traceId: 'tr_x',
      capabilityId: CAP,
      policyDecision: { allowed: true, matchedRule: 'allow' },
      result: { ok: true },
    };
    reg.onAuditRecord(rec);
    assert.deepEqual(reg.get('tr_a').activityCount(), mkActivity({ wild: 1 }));
    assert.deepEqual(reg.get('tr_c').activityCount(), ZERO, '暴露面不匹配 → 不归入');
    assert.equal(inWin.innerCallTraceIds().includes('tr_x'), true, 'wild 也登记内层 traceId 供 S-3 展开');
  });

  test('时间窗外的记录不归入（startedAtMs 毫秒比较，绕开 query({since}) 字符串陷阱）', () => {
    const reg = new LedgerRegistry({ now: () => 10_000 });
    const l = reg.begin(DTID, TASK, []); // startedAtMs = 10_000
    reg.onAuditRecord({
      seq: 1,
      ts: new Date(5_000).toISOString(),
      traceId: 'tr_old',
      capabilityId: CAP,
      policyDecision: { allowed: true, matchedRule: 'allow' },
      result: { ok: true },
    });
    assert.deepEqual(l.activityCount(), ZERO);
    reg.onAuditRecord({
      seq: 2,
      ts: new Date(10_000).toISOString(),
      traceId: 'tr_new',
      capabilityId: CAP,
      policyDecision: { allowed: true, matchedRule: 'allow' },
      result: { ok: true },
    });
    assert.deepEqual(l.activityCount(), mkActivity({ wild: 1 }));
  });

  test('壳条目与 blocked 条目在分发层被跳过（防双计：blocked 走专用通道）', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const l = reg.begin(DTID, TASK, []);
    reg.onAuditRecord({
      seq: 1,
      ts: new Date(1100).toISOString(),
      traceId: DTID,
      capabilityId: SHELL_CAPABILITY_ID,
      policyDecision: { allowed: true, matchedRule: 'delegation' },
      result: { ok: true },
      ext: { kind: 'delegation-start', delegationId: DTID },
    });
    reg.onAuditRecord({
      seq: 2,
      ts: new Date(1100).toISOString(),
      traceId: 'tr_any',
      capabilityId: CAP,
      policyDecision: { allowed: false, matchedRule: 'approval-required' },
      result: { ok: false },
    });
    assert.deepEqual(l.activityCount(), ZERO, '壳条目 + approval-required 条目都不得经此通道计数');
    l.recordBlocked(2, 'apr_1', CAP);
    assert.deepEqual(l.activityCount(), mkActivity({ blocked: 1 }), 'blocked 只由专用通道登记一次');
  });

  test('ext.kind=delegation-* 但 capabilityId 非壳（防御）同样跳过', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const l = reg.begin(DTID, TASK, []);
    reg.onAuditRecord({
      seq: 3,
      ts: new Date(1100).toISOString(),
      traceId: 'tr_z',
      capabilityId: 'app.other',
      policyDecision: { allowed: true, matchedRule: 'allow' },
      result: { ok: true },
      ext: { kind: 'delegation-complete', delegationId: DTID },
    });
    assert.deepEqual(l.activityCount(), ZERO);
  });

  test('已收口账本不再吃记录（close 门卫）', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const l = reg.begin(DTID, TASK, []);
    reg.finish(DTID);
    reg.onAuditRecord({
      seq: 4,
      ts: new Date(9000).toISOString(),
      traceId: 'tr_late',
      capabilityId: CAP,
      policyDecision: { allowed: true, matchedRule: 'allow' },
      result: { ok: true },
      ext: { kind: 'inner-call', delegationId: DTID },
    });
    assert.equal(l.isClosed, true);
    assert.deepEqual(l.activityCount(), ZERO);
  });

  test('有界：maxLive 超限按 startedAtMs 淘汰最老；保留期到期自动摘除', () => {
    let t = 1000;
    const reg = new LedgerRegistry({ maxLive: 2, retentionMs: 5000, now: () => t });
    reg.begin('tr_1', 'task_1', []);
    t += 10;
    reg.begin('tr_2', 'task_2', []);
    t += 10;
    reg.begin('tr_3', 'task_3', []);
    assert.equal(reg.get('tr_1'), undefined, '容量淘汰最老');
    assert.ok(reg.get('tr_2') && reg.get('tr_3'));

    t += 6000;
    reg.begin('tr_4', 'task_4', []);
    assert.equal(reg.get('tr_2'), undefined, '超保留期摘除');
    assert.equal(reg.get('tr_3'), undefined);
    assert.ok(reg.get('tr_4'));
  });

  test('ledgerForInnerTrace 支持按内层 traceId 串匹配回溯存活账本', () => {
    const reg = new LedgerRegistry({ now: () => 1000 });
    const l = reg.begin(DTID, TASK, []);
    l.noteInnerTraceId('tr_inner_1');
    assert.equal(reg.ledgerForInnerTrace('tr_inner_1'), l);
    assert.equal(reg.ledgerForInnerTrace(DTID), l, '委派 traceId 自身也可回溯');
    assert.equal(reg.ledgerForInnerTrace('tr_unknown'), undefined);
    reg.finish(DTID);
    assert.equal(reg.ledgerForInnerTrace('tr_inner_1'), undefined, '已收口不再关联');
  });

  test('跨任务隔离：第二次的探针计数不被第一次「洗白」（对齐 §9-B-6）', () => {
    const reg = new LedgerRegistry({ now: () => Date.now() });
    const a = reg.begin('tr_taskA', 'task_A', []);
    a.recordExecuted({ seq: 1, capabilityId: CAP, traceId: 'tr_a' }, true);
    reg.finish('tr_taskA');

    const b = reg.begin('tr_taskB', 'task_B', []);
    assert.deepEqual(reg.activityFor('tr_taskB'), ZERO, '新账本从干净状态开始');
    assert.equal(a.isClosed, true, '旧账本已关，不会被后续记录复活');
  });
});

describe('K-N1 A-6 ReceiptCache（S-3 方案 B：有界脱敏环形缓存）', () => {
  test('record/get/getAll 基本形状；空 traceId 不写入', () => {
    const c = new ReceiptCache();
    c.record('tr_1', CAP, true, { exitCode: 0, success: true });
    const e = c.get('tr_1');
    assert.equal(e.traceId, 'tr_1');
    assert.equal(e.capabilityId, CAP);
    assert.equal(e.ok, true);
    assert.match(e.data, /"exitCode":0/);
    assert.deepEqual(c.getAll(['tr_1', 'tr_missing']).map((x) => x.traceId), ['tr_1']);
    c.record('', CAP, true, {});
    assert.equal(c.size, 1);
  });

  test('只存脱敏副本：data 内 password/token/secret/apiKey 一律 ***REDACTED***', () => {
    const c = new ReceiptCache();
    c.record('tr_p', CAP, true, {
      exitCode: 0,
      password: 'Sup3rSecret',
      nested: { token: 'tok-abc', apiKey: 'ak-xyz', keep: 'WXWork' },
      list: [{ credential: 'cred-1' }],
    });
    const data = c.get('tr_p').data;
    assert.doesNotMatch(data, /Sup3rSecret|tok-abc|ak-xyz|cred-1/, '凭据明文绝不进缓存');
    assert.match(data, /\*\*\*REDACTED\*\*\*/);
    assert.match(data, /"keep":"WXWork"/, '非敏感字段保留（字段级重建的可取证性）');
  });

  test('单条 data 有界：纯 base64 blob 走指纹分支（不内联原值），长文本走 1KB 截断', () => {
    const c = new ReceiptCache();
    c.record('tr_fp', CAP, true, { blob: 'Z'.repeat(4000) });
    const fp = c.get('tr_fp').data;
    assert.match(fp, /<base64 len=4000 sha256=[0-9a-f]{16}…>/, 'blob 以指纹承载，绝不内联');
    assert.doesNotMatch(fp, /Z{20}/);

    c.record('tr_long', CAP, true, { text: '结果'.repeat(2000), tail: 'END' });
    const d = c.get('tr_long').data;
    assert.ok(d.length <= MAX_RECEIPT_DATA_CHARS + 1, `实际 ${d.length}`);
    assert.match(d, /…$/, '超长部分被裁掉并留标记');
    assert.doesNotMatch(d, /END/, '截断在尾部之前（有界性优先于完整性）');
  });

  test('clipReceipt：循环引用/不可序列化降级为占位串，绝不抛', () => {
    assert.equal(clipReceipt(undefined), 'null');
    const cyc = {};
    cyc.self = cyc;
    assert.equal(clipReceipt(cyc), '{"unserializable":true}');
  });

  test('容量 ≤200，超出按插入序淘汰最旧（环形语义）；同 traceId 覆盖不增长', () => {
    const c = new ReceiptCache(3);
    c.record('tr_1', CAP, true, {});
    c.record('tr_2', CAP, true, {});
    c.record('tr_3', CAP, true, {});
    c.record('tr_4', CAP, true, {});
    assert.equal(c.size, 3);
    assert.equal(c.get('tr_1'), undefined, '最旧被淘汰');
    assert.ok(c.get('tr_4'));
    c.record('tr_4', CAP, false, { once: 1 });
    assert.equal(c.size, 3, '同 traceId 覆盖');
    assert.equal(c.get('tr_4').ok, false);
    assert.equal(MAX_RECEIPT_ENTRIES, 200);
  });

  test('clear() 复位（进程内缓存，重启即失的显式等价物）', () => {
    const c = new ReceiptCache();
    c.record('tr_1', CAP, true, {});
    c.clear();
    assert.equal(c.size, 0);
  });
});

describe('K-N1 A-7 wrapAuditSink 装饰器（executed seq 回传服务端，零 provider 改动）', () => {
  function fakeSink() {
    const written = [];
    let n = 0;
    return {
      written,
      sink: {
        async append(input) {
          const rec = { ...input, seq: ++n, prevHash: 'GENESIS', hash: `h${n}` };
          written.push(rec);
          return rec;
        },
        async verifyChain() {
          return { valid: true, entries: written.length, checked: written.length };
        },
      },
    };
  }

  const logger = { debug() {}, info() {}, warn() {}, error() {} };

  test('每条**已落链**记录（含 seq）回调一次；append 结果原样透传', async () => {
    const f = fakeSink();
    const seen = [];
    const wrapped = wrapAuditSink(f.sink, (r) => seen.push(r.seq), logger);
    const out = await wrapped.append({ capabilityId: CAP });
    assert.deepEqual(seen, [1]);
    assert.equal(out.seq, 1);
    assert.equal(out.hash, 'h1', '不得吞掉 sink 的返回值');
    const v = await wrapped.verifyChain();
    assert.equal(v.valid, true, 'verifyChain 透传');
    assert.equal(v.entries, 1);
  });

  test('回调异常一律吞掉并 warn —— 取证登记失败绝不影响审计写入（对齐 approval-replay 纪律）', async () => {
    const f = fakeSink();
    const warns = [];
    const wrapped = wrapAuditSink(
      f.sink,
      () => {
        throw new Error('ledger boom');
      },
      { ...logger, warn: (m, meta) => warns.push([m, meta]) },
    );
    const out = await wrapped.append({ capabilityId: CAP });
    assert.equal(out.seq, 1, '审计写入结果不变');
    assert.equal(f.written.length, 1);
    assert.equal(warns.length, 1, '恰一条 warn');
    assert.match(warns[0][0], /委派账本登记失败/);
    assert.match(String(warns[0][1].error), /ledger boom/);
  });

  test('sink 写失败时**不**回调（未落链的记录不得成为活动证据）', async () => {
    const seen = [];
    const wrapped = wrapAuditSink(
      {
        append: () => Promise.reject(new Error('disk gone')),
        verifyChain: async () => ({ valid: true, entries: 0, checked: 0 }),
      },
      (r) => seen.push(r),
      logger,
    );
    await assert.rejects(() => wrapped.append({ capabilityId: CAP }), /disk gone/);
    assert.equal(seen.length, 0);
  });
});

describe('K-N1 A-8 buildReceiptResponse（委派 traceId 为键的取证展开）', () => {
  function rec(over = {}) {
    return {
      seq: 1,
      ts: '2026-10-02T02:35:09.120Z',
      traceId: DTID,
      auditId: 'aud_1',
      principal: { host: 'vm-service', user: 'User', channel: 'a2a' },
      capabilityId: DELEGATION_CAPABILITY_ID,
      risk: 'L1',
      params: { goal: 'g' },
      policyDecision: { allowed: true, matchedRule: 'delegation' },
      result: { ok: false, summary: 'delegation.complete:failed' },
      durationMs: 100,
      prevHash: 'GENESIS',
      hash: 'h1',
      ...over,
    };
  }

  test('命中壳 complete 条目 → 按 ext.underlying.auditSeqs 展开内层记录，innerSeqs 升序、records 按 seq 排序', () => {
    const shell = rec({
      seq: 182,
      result: { ok: false, errorCode: 'NO_EXECUTION_RECEIPT', summary: 'delegation.complete:failed' },
      ext: {
        kind: 'delegation-complete',
        delegationId: DTID,
        zeroInnerCalls: false,
        underlying: [{ capabilityId: CAP, ok: false, count: 2, approvalId: 'apr_1', auditSeqs: [181, 179] }],
        blockedCount: 1,
      },
    });
    const inner = [rec({ seq: 179, traceId: 'tr_inner', capabilityId: CAP, ext: { kind: 'inner-call', delegationId: DTID } }), rec({ seq: 181, traceId: 'tr_inner2', capabilityId: CAP })];
    const out = buildReceiptResponse({ traceId: DTID, records: [shell], allRecords: inner });
    assert.equal(out.traceId, DTID);
    assert.deepEqual(out.innerSeqs, [179, 181]);
    assert.deepEqual(out.records.map((r) => r.seq), [179, 181, 182]);
    assert.equal(out.records[2].channel, 'a2a', '投影透出 principal.channel（通道真实化可核验）');
    assert.equal('params' in out.records[0], false, '投影不内联 params（零新增敏感面）');
    assert.ok(out.records[0].hash && out.records[0].seq, '附 seq/hash 供与链对齐校验');
  });

  test('未命中 → records 为空数组（200 语义，绝不 4xx；§9-F-3）', () => {
    const out = buildReceiptResponse({ traceId: 'tr_unknown', records: [] });
    assert.deepEqual(out.records, []);
    assert.deepEqual(out.innerSeqs, []);
    assert.deepEqual(out.receipts, []);
    assert.equal(out.traceId, 'tr_unknown');
  });

  test('receiptLookup 补齐**账本已收口**场景下的内层字段级回执（按展开记录的 traceId 反查）', () => {
    const shell = rec({
      ext: { kind: 'delegation-complete', delegationId: DTID, underlying: [{ capabilityId: CAP, ok: true, count: 1, auditSeqs: [50] }] },
    });
    const inner = rec({ seq: 50, traceId: 'tr_inner_50', capabilityId: CAP });
    const queried = [{ traceId: DTID, capabilityId: DELEGATION_CAPABILITY_ID, ok: false, ts: 'x', data: '{}' }];
    const out = buildReceiptResponse({
      traceId: DTID,
      records: [shell],
      allRecords: [inner],
      receipts: queried,
      receiptLookup: (ids) => ids.map((id) => (id === 'tr_inner_50' ? { traceId: id, capabilityId: CAP, ok: true, ts: 'y', data: '{"exitCode":0}' } : undefined)).filter(Boolean),
    });
    assert.equal(out.receipts.length, 2);
    assert.deepEqual(
      out.receipts.map((r) => r.traceId).sort(),
      ['tr_inner_50', DTID].sort(),
      '直查回执与 lookup 补齐的内层回执并存（去重）',
    );
  });

  test('同一 traceId 的回执不重复（显式传入优先，lookup 去重）', () => {
    const e = { traceId: 'tr_a', capabilityId: CAP, ok: true, ts: 'x', data: '{}' };
    const out = buildReceiptResponse({
      traceId: 'tr_root',
      records: [rec({ seq: 1, traceId: 'tr_a' })],
      receipts: [e],
      receiptLookup: () => [{ ...e, data: '{"dup":true}' }],
    });
    assert.equal(out.receipts.length, 1);
    assert.equal(out.receipts[0].data, '{}', '显式传入未被覆盖');
  });
});
