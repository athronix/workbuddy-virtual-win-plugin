/**
 * R19c T05 · K-N1 委派层审计真实性 —— **F 组：哈希链兼容集成**（设计 §9-F，可脱沙箱直接跑）
 *
 * 用**真实** `HashChainAuditSink`（临时目录，不起 HTTP、不 spawn ps-bridge）钉死：
 *   F-1 带 `ext` 的记录 append → `verifyChain().valid === true`；`ext` 内 `password` 读出为
 *       `***REDACTED***`（`chain.ts:288` doAppend 对 ext 递归 redact）；
 *   F-2 旧记录（无 ext）与新记录（有 ext）混链 → 校验通过（模拟 D30 续链）；
 *   F-3 `GET /audit/receipt?traceId`：命中壳条目 + `ext.underlying.auditSeqs` 可展开；
 *       未命中 → `{records: []}` 且 HTTP 200 非 4xx。
 *       **降级说明**：本沙箱 `createService` 会 spawn ps-bridge 触发 V8 原生 fatal（起不了服务），
 *       故 F-3 的**行为**用「真实 sink 数据 + `buildReceiptResponse` 纯函数」覆盖，
 *       路由形态（path/method/200/400/`sink.query`/`redact` 依赖）由 E 组源码守卫钉死，
 *       并在 E 组登记残余风险（路由体未做行为级验证）。
 *
 * 另加 K-N1 契约级不变式：
 *   - 壳双态条目（`buildDelegationAuditEntry` 产物）经真实 sink 落链后链仍合法
 *     （这是「哈希链结构零破坏」这条设计承诺的唯一可执行证明）；
 *   - `seq` 严格单调 + `prevHash` 逐条对齐 → ext 的加入不打乱链序；
 *   - 显式 `ext: undefined` 被 doAppend 删键（`contracts/audit.ts:118` 假断链陷阱的回归锁）；
 *   - 链上 `channel` 真实值（委派壳 a2a / 内层 a2a / 宿主直调 mcp）可被取证复核。
 */

import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { HashChainAuditSink, canonicalJson, computeRecordHash, sha256, redact } from '@winvm/core';
import {
  buildDelegationAuditEntry,
  buildReceiptResponse,
  DelegationLedger,
  DELEGATION_CAPABILITY_ID,
  SHELL_CAPABILITY_ID,
} from '@winvm/vm-service';

const DTID = 'tr_kn1_chain_166';
const INNER = 'tr_kn1_inner_900';
const CAP = 'app.winget.uninstall';

function newSink(label) {
  const dir = mkdtempSync(join(tmpdir(), `kn1-chain-${label}-`));
  return { dir, sink: new HashChainAuditSink({ dir }) };
}

/** `AppendAuditInput` 基座（无 ext，模拟历史记录形态）；`__i` 仅用于错开 ts，不落入记录 */
function legacyInput(rawOver = {}) {
  const { __i = 0, ...over } = rawOver;
  return {
    ts: new Date(Date.parse('2026-09-30T10:00:00.000Z') + __i * 1000).toISOString(),
    traceId: 'tr_legacy',
    auditId: 'aud_legacy',
    principal: { host: 'workbuddy', user: 'User', channel: 'mcp' },
    capabilityId: 'system.info.get',
    risk: 'L0',
    params: { password: 'OldSecret', keep: 1 },
    policyDecision: { allowed: true, matchedRule: 'allow' },
    result: { ok: true, summary: 'ok' },
    durationMs: 5,
    ...over,
  };
}

function lines(dir) {
  const f = readdirSync(dir).find((x) => x.endsWith('.jsonl'));
  return readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/* ============================ F-1 ext 入链 ============================ */

describe('K-N1 F-1 带 ext 的记录入链：链合法 + ext 内凭据脱敏', () => {
  test('ext 记录 append → verifyChain().valid=true；seq 单调、prevHash 逐条对齐', async () => {
    const { dir, sink } = newSink('f1');
    const r1 = await sink.append({
      ...legacyInput({ capabilityId: CAP, traceId: INNER }),
      ext: { kind: 'inner-call', delegationId: DTID, channel: 'a2a' },
    });
    const r2 = await sink.append({
      ...legacyInput({ capabilityId: DELEGATION_CAPABILITY_ID, traceId: DTID }),
      ext: { kind: 'delegation-complete', delegationId: DTID, zeroInnerCalls: false, underlying: [] },
    });

    const v = await sink.verifyChain();
    assert.equal(v.valid, true, 'ext 必须能被哈希链无损承载（设计 §2.2「哈希链结构零破坏」）');
    assert.equal(v.entries, 2);
    assert.equal(r1.seq, 1);
    assert.equal(r2.seq, 2, 'seq 严格单调');
    assert.equal(r2.prevHash, r1.hash, 'prevHash 指向上一条 hash');

    const onDisk = lines(dir);
    assert.equal(onDisk[0].ext.kind, 'inner-call');
    assert.equal(onDisk[1].ext.zeroInnerCalls, false);
    // 重算一致性：ext 已参与 canonicalJson 哈希
    const { hash, ...rest } = onDisk[1];
    assert.equal(computeRecordHash(rest), hash, 'ext 进哈希（篡改 ext 即断链）');
  });

  test('ext 内 password/token/secret/credential 一律 ***REDACTED***（doAppend 递归 redact，零新增敏感面）', async () => {
    const { dir, sink } = newSink('f1-redact');
    await sink.append({
      ...legacyInput(),
      ext: {
        kind: 'inner-call',
        delegationId: DTID,
        channel: 'a2a',
        password: 'Sup3rSecret',
        apiToken: 'tok_live_123',
        nested: { credential: 'cred-abc', keep: 'WXWork' },
        stepsSummary: [{ capabilityId: CAP, ok: true, summary: 'plain-text-ok' }],
        underlying: [{ capabilityId: CAP, ok: true, count: 1, approvalId: 'apr_1', auditSeqs: [1] }],
      },
    });
    const raw = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl'))), 'utf8');
    assert.doesNotMatch(raw, /Sup3rSecret|tok_live_123|cred-abc/, '凭据明文绝不入链');
    const rec = JSON.parse(raw.trim());
    assert.equal(rec.ext.password, '***REDACTED***');
    assert.equal(rec.ext.apiToken, '***REDACTED***');
    assert.equal(rec.ext.nested.credential, '***REDACTED***');
    assert.equal(rec.ext.nested.keep, 'WXWork', '非敏感字段保留（可回溯真实意图）');
    assert.equal(rec.ext.stepsSummary[0].summary, 'plain-text-ok');
    assert.equal(rec.ext.underlying[0].approvalId, 'apr_1');
    assert.equal(rec.params.password, '***REDACTED***', 'params 沿用既有 doRedact（同一纪律）');

    const v = await sink.verifyChain();
    assert.equal(v.valid, true, '脱敏发生在取号算哈希之前，链仍自洽');
  });

  test('篡改 ext 值 → verifyChain 立即红（ext 具备与其余字段同级的防篡改力）', async () => {
    const { dir, sink } = newSink('f1-tamper');
    await sink.append({ ...legacyInput(), ext: { kind: 'inner-call', delegationId: DTID, zeroInnerCalls: true } });
    const f = join(dir, readdirSync(dir).find((x) => x.endsWith('.jsonl')));
    const original = readFileSync(f, 'utf8');
    const tampered = original.replace('"zeroInnerCalls":true', '"zeroInnerCalls":false');
    assert.notEqual(tampered, original, '夹具需能改写 ext');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, tampered, 'utf8');
    const v = await sink.verifyChain();
    assert.equal(v.valid, false, '「零调用」事实被改写必须可发现（K-N1 取证面的防篡改底线）');
    assert.equal(v.reason, 'HASH_MISMATCH');
  });

  test('显式 `ext: undefined` 被 doAppend 删键 → 不产生假断链（contracts/audit.ts:118 陷阱回归锁）', async () => {
    const { dir, sink } = newSink('f1-undef');
    const a = await sink.append({ ...legacyInput(), ext: undefined });
    const b = await sink.append({ ...legacyInput({ capabilityId: CAP }), ext: undefined });
    const v = await sink.verifyChain();
    assert.equal(v.valid, true, 'canonicalJson(undefined→null) 与 JSON.stringify(丢键) 的差异必须被消解');
    const recs = lines(dir);
    assert.equal('ext' in recs[0], false, '键整体消失，不落 null');
    assert.equal('ext' in recs[1], false);
    assert.equal(b.seq, a.seq + 1);
  });

  test('ext 的哈希可被离线复算（canonicalJson 键序无关 → 取证方可独立验链）', async () => {
    const { dir, sink } = newSink('f1-canonical');
    await sink.append({
      ...legacyInput(),
      ext: { kind: 'inner-call', delegationId: DTID, underlying: [{ capabilityId: CAP, ok: true, count: 1, auditSeqs: [1] }] },
    });
    const rec = lines(dir)[0];
    const { hash, ...rest } = rec;
    assert.equal(sha256(canonicalJson(rest)), hash);
    // 键序打乱后重排一致
    assert.notEqual(canonicalJson({ b: 1, a: 2 }), '{"b":1,"a":2}', 'canonicalJson 按键排序');
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.deepEqual(JSON.parse(JSON.stringify(redact({ apiKey: 'k' }))), { apiKey: '***REDACTED***' });
  });
});

/* ============================ F-2 新旧混链 ============================ */

describe('K-N1 F-2 旧记录（无 ext）与新记录混链 → 校验通过（D30 续链形态）', () => {
  test('先落 2 条无 ext 历史记录，再落 2 条 ext 记录 → valid=true、entries=4', async () => {
    const { dir, sink } = newSink('f2');
    await sink.append(legacyInput({ __i: 0 }));
    await sink.append(legacyInput({ __i: 1, capabilityId: CAP }));
    await sink.append({
      ...legacyInput({ capabilityId: DELEGATION_CAPABILITY_ID, traceId: DTID }),
      ext: { kind: 'delegation-start', delegationId: DTID },
    });
    await sink.append({
      ...legacyInput({ capabilityId: DELEGATION_CAPABILITY_ID, traceId: DTID }),
      result: { ok: false, errorCode: 'NO_EXECUTION_RECEIPT', summary: 'delegation.complete:failed' },
      ext: { kind: 'delegation-complete', delegationId: DTID, zeroInnerCalls: true, underlying: [], blockedCount: 0 },
    });

    const v = await sink.verifyChain();
    assert.equal(v.valid, true, '历史记录校验不受新增可选字段影响（verifyChain 从记录自身重算）');
    assert.equal(v.entries, 4);
    const recs = lines(dir);
    assert.equal('ext' in recs[0], false);
    assert.equal(recs[2].ext.kind, 'delegation-start');
    assert.equal(recs[3].ext.zeroInnerCalls, true);
  });

  test('同一 sink 串行并发 append（含 ext）→ 无重复 seq、无分叉（D30 竞态修复在 ext 形态下仍成立）', async () => {
    const { sink } = newSink('f2-concurrent');
    const tasks = [];
    for (let i = 0; i < 20; i++) {
      const input =
        i % 2 === 0
          ? legacyInput({ traceId: `tr_c${i}`, capabilityId: CAP })
          : {
              ...legacyInput({ traceId: `tr_c${i}`, capabilityId: DELEGATION_CAPABILITY_ID }),
              ext: { kind: 'inner-call', delegationId: DTID, channel: 'a2a' },
            };
      tasks.push(sink.append(input));
    }
    const recs = await Promise.all(tasks);
    const seqs = recs.map((r) => r.seq);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1), 'seq 严格单调无重复');
    const v = await sink.verifyChain();
    assert.equal(v.valid, true);
    assert.equal(v.entries, 20);
  });
});

/* ============================ K-N1 契约形态：壳双态条目真实入链 ============================ */

describe('K-N1 F 附：委派壳双态条目按真实链路落盘（设计 T02 验收「链上恰 2 条 channel=a2a 壳条目」）', () => {
  test('start + 内层 executed + complete 三条记录：壳两条均 channel=a2a，complete 带 zeroInnerCalls=false', async () => {
    const { dir, sink } = newSink('shell');
    const ledger = new DelegationLedger(DTID, 'task_shell', [CAP], Date.now() - 40);
    const startedAtMs = ledger.startedAtMs;

    const start = await sink.append(
      buildDelegationAuditEntry('start', {
        delegationTraceId: DTID,
        taskId: 'task_shell',
        goal: '卸载 VM 企业微信',
        maxRisk: 'L2',
        allowedCapabilities: [CAP],
        startedAtMs,
        newAuditId: () => 'aud_s1',
      }),
    );
    const inner = await sink.append({
      ...legacyInput({ traceId: INNER, capabilityId: CAP }),
      result: { ok: true, summary: 'winget uninstall 完成：WXWork' },
      params: { packageId: 'WXWork' },
      ext: { kind: 'inner-call', delegationId: DTID, channel: 'a2a' },
    });
    ledger.recordExecuted(inner, true);

    const complete = await sink.append(
      buildDelegationAuditEntry('complete', {
        delegationTraceId: DTID,
        taskId: 'task_shell',
        goal: '卸载 VM 企业微信',
        startedAtMs,
        newAuditId: () => 'aud_c1',
        ledger,
        terminalState: 'completed',
        ok: true,
        steps: [{ capabilityId: SHELL_CAPABILITY_ID, ok: true, summary: 'LLM 自主规划并执行完成' }],
      }),
    );

    const v = await sink.verifyChain();
    assert.equal(v.valid, true, 'K-N1 新增条目形态不得破坏哈希链');
    assert.equal(v.entries, 3);
    assert.equal(start.principal.channel, 'a2a');
    assert.equal(complete.principal.channel, 'a2a');
    assert.equal(complete.ext.zeroInnerCalls, false, '有真实内层调用 → 事实字段如实为 false');
    assert.deepEqual(complete.ext.underlying.map((u) => [u.capabilityId, u.count]), [[CAP, 1]]);
    assert.equal(complete.result.summary, 'delegation.complete:completed');
    assert.equal(start.durationMs >= 0, true);

    const recs = lines(dir);
    assert.equal(recs[0].auditId, 'aud_s1');
    assert.equal(recs[2].ext.underlying[0].auditSeqs.includes(inner.seq), true, '内层 seq 指针可取证展开');
  });

  test('K-N1 现场复刻：零调用 + 完成声称 → complete 条目落 NO_EXECUTION_RECEIPT 与 zeroInnerCalls=true', async () => {
    const { dir, sink } = newSink('kn1-scene');
    const ledger = new DelegationLedger(DTID, 'task_kn1', [], Date.now() - 17_403);
    await sink.append(
      buildDelegationAuditEntry('start', {
        delegationTraceId: DTID,
        taskId: 'task_kn1',
        goal: '卸载 VM 企业微信',
        startedAtMs: ledger.startedAtMs,
        newAuditId: () => 'aud_s',
      }),
    );
    const complete = await sink.append(
      buildDelegationAuditEntry('complete', {
        delegationTraceId: DTID,
        taskId: 'task_kn1',
        goal: '卸载 VM 企业微信',
        maxRisk: 'L2',
        allowedCapabilities: [CAP],
        startedAtMs: ledger.startedAtMs,
        newAuditId: () => 'aud_c',
        ledger,
        terminalState: 'failed',
        ok: false,
        errorCode: 'NO_EXECUTION_RECEIPT',
        downgraded: true,
        downgradeReason: '已超重建上限（5），此后回退单次 -p',
        steps: [{ capabilityId: SHELL_CAPABILITY_ID, ok: false, summary: '委派回合零服务端活动记录，完成声称不予采信' }],
      }),
    );

    assert.equal(complete.result.ok, false);
    assert.equal(complete.result.errorCode, 'NO_EXECUTION_RECEIPT');
    assert.equal(complete.ext.zeroInnerCalls, true, '链上存在可证伪「假完成」的记录（K-N1 根因闭环）');
    assert.equal(complete.ext.downgraded, true);
    const v = await sink.verifyChain();
    assert.equal(v.valid, true);
    const raw = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl'))), 'utf8');
    assert.match(raw, /"zeroInnerCalls":true/);
    assert.match(raw, /"channel":"a2a"/);
  });

  test('query({traceId}) 以委派 traceId 为键同时命中壳两条（S-3「一鱼两吃」的检索前提）', async () => {
    const { sink } = newSink('f-query');
    await sink.append(
      buildDelegationAuditEntry('start', {
        delegationTraceId: DTID,
        goal: 'g',
        startedAtMs: Date.now(),
        newAuditId: () => 'aud_q1',
      }),
    );
    await sink.append({
      ...legacyInput({ traceId: 'tr_other', capabilityId: CAP }),
      ext: { kind: 'inner-call', delegationId: DTID, channel: 'a2a' },
    });
    await sink.append(
      buildDelegationAuditEntry('complete', {
        delegationTraceId: DTID,
        goal: 'g',
        startedAtMs: Date.now() - 10,
        newAuditId: () => 'aud_q2',
        terminalState: 'completed',
        ok: true,
      }),
    );

    const mine = await sink.query({ traceId: DTID });
    assert.equal(mine.length, 2, '壳两条按委派 traceId 可检索（内层条目 traceId 不同 → 靠 ext.underlying 展开）');
    assert.deepEqual(mine.map((r) => r.ext.kind), ['delegation-start', 'delegation-complete']);

    const byCap = await sink.query({ capabilityId: DELEGATION_CAPABILITY_ID });
    assert.equal(byCap.length, 2, 'T02 验收：query({capabilityId:壳}) 非空');

    // 陷阱回归（§2 注记）：since 是**字符串日期**比较，用它做窗口过滤会漏/多 —— 契约要求用 seq/ext
    const since = new Date(Date.now() + 60_000).toISOString();
    assert.deepEqual(await sink.query({ since }), [], '未来 since → 空（证明 since 不可用作回合窗口过滤）');
  });
});

/* ============================ F-3 回执端点语义（纯函数层，路由层见 E 组） ============================ */

describe('K-N1 F-3 GET /audit/receipt 语义（真实 sink 数据 + buildReceiptResponse）', () => {
  test('命中委派壳 complete → 返回链上记录（附 seq/hash）+ ext.underlying.auditSeqs 可展开内层', async () => {
    const { sink } = newSink('f3');
    const ledger = new DelegationLedger(DTID, 'task_f3', [CAP], Date.now() - 30);
    await sink.append(
      buildDelegationAuditEntry('start', {
        delegationTraceId: DTID,
        taskId: 'task_f3',
        goal: '卸载 VM 企业微信',
        startedAtMs: ledger.startedAtMs,
        newAuditId: () => 'aud_a',
      }),
    );
    const inner1 = await sink.append({
      ...legacyInput({ traceId: 'tr_i1', capabilityId: CAP, auditId: 'aud_i1' }),
      result: { ok: false, errorCode: 'APPROVAL_REQUIRED', summary: 'blocked:approval-required' },
      policyDecision: { allowed: false, matchedRule: 'approval-required' },
    });
    ledger.recordBlocked(inner1.seq, 'apr_f3', CAP);
    const inner2 = await sink.append({
      ...legacyInput({ traceId: 'tr_i2', capabilityId: CAP, auditId: 'aud_i2' }),
      ext: { kind: 'inner-call', delegationId: DTID, channel: 'a2a' },
    });
    ledger.recordExecuted(inner2, true);
    const complete = await sink.append(
      buildDelegationAuditEntry('complete', {
        delegationTraceId: DTID,
        taskId: 'task_f3',
        goal: '卸载 VM 企业微信',
        startedAtMs: ledger.startedAtMs,
        newAuditId: () => 'aud_b',
        ledger,
        terminalState: 'completed',
        ok: true,
      }),
    );

    // 与 server.ts 路由体同构的数据准备（sink.query + 需要展开时全量查询）
    const records = await sink.query({ traceId: DTID });
    const needExpand = records.some((r) => r.ext?.kind === 'delegation-complete');
    const allRecords = needExpand ? await sink.query({ limit: 5000 }) : undefined;
    const out = buildReceiptResponse({ traceId: DTID, records, allRecords });

    assert.equal(out.traceId, DTID);
    assert.deepEqual(out.innerSeqs, [inner1.seq, inner2.seq], 'blocked + executed 的 seq 都可经壳条目展开');
    assert.deepEqual(out.records.map((r) => r.seq), [records[0].seq, inner1.seq, inner2.seq, complete.seq]);
    assert.equal(out.records[0].channel, 'a2a');
    assert.ok(out.records.every((r) => typeof r.hash === 'string' && r.hash.length === 64), '附 hash 供与链对齐校验');
    assert.equal('params' in out.records[1], false, '投影不内联 params（零新增敏感面）');
    assert.deepEqual(out.receipts, [], '环形缓存缺席 → receipts 空数组（非 null）');

    // 与链对齐：投影 hash 必须能在链上找到同 seq 同 hash 的记录
    const chain = await sink.query({});
    for (const p of out.records) {
      const found = chain.find((c) => c.seq === p.seq);
      assert.equal(found.hash, p.hash, `seq=${p.seq} 投影与链一致`);
    }
  });

  test('未命中 → `{ records: [] }`（HTTP 200 语义，绝不 4xx）', async () => {
    const { sink } = newSink('f3-miss');
    await sink.append(legacyInput());
    const records = await sink.query({ traceId: 'tr_not_exist' });
    assert.deepEqual(records, [], 'sink.query 未命中返回空数组（路由据此 200 而非 404）');
    const out = buildReceiptResponse({ traceId: 'tr_not_exist', records });
    assert.deepEqual(out, { traceId: 'tr_not_exist', records: [], innerSeqs: [], receipts: [] });
  });

  test('单次直调（无 ext 壳条目）traceId 同样可查：不触发展开、innerSeqs 空', async () => {
    const { sink } = newSink('f3-plain');
    const r = await sink.append({ ...legacyInput({ traceId: 'tr_direct', capabilityId: CAP }) });
    const records = await sink.query({ traceId: 'tr_direct' });
    const out = buildReceiptResponse({
      traceId: 'tr_direct',
      records,
      allRecords: await sink.query({ limit: 5000 }),
    });
    assert.equal(out.records.length, 1);
    assert.deepEqual(out.innerSeqs, [], '无 delegation-complete 条目 → 不展开');
    assert.equal(out.records[0].seq, r.seq);
  });
});

/* ============================ F-4 委派终态口径（D-5：按路径区分，不跨路径泛化） ============================ */

/**
 * D-5 覆盖缺口补丁：`ext.terminalState` 的 `rejected` 分支此前**无任何测试覆盖**
 * （全仓断言只覆盖 completed/failed）。D-5 明确「`rejected` 非死语义，语义收窄为
 * **仅**宿主显式拒绝审批路径」，故此处补该路径的落链断言，为 D-5 裁定补上护栏。
 */
describe('K-N1 F-4 委派终态：宿主显式拒绝 → terminalState=rejected（D-5 覆盖缺口补丁）', () => {
  /** 落一条壳 complete 条目（模拟 observer 在宿主拒绝后落链） */
  async function appendComplete(label, { terminalState, ok, errorCode, resultSummary }) {
    const { dir, sink } = newSink(label);
    const ledger = new DelegationLedger(DTID, 'task_kn1', [], Date.now() - 4200);
    const rec = await sink.append(
      buildDelegationAuditEntry('complete', {
        delegationTraceId: DTID,
        taskId: 'task_kn1',
        goal: '卸载 VM 企业微信',
        startedAtMs: ledger.startedAtMs,
        newAuditId: () => 'aud_c',
        ledger,
        terminalState,
        ok,
        ...(errorCode ? { errorCode } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      }),
    );
    const v = await sink.verifyChain();
    return { dir, rec, valid: v.valid, raw: lines(dir) };
  }

  test('宿主拒绝 → ext.terminalState=rejected 入链且可取证（ok:false、summary 标 rejected）', async () => {
    const { rec, valid, raw } = await appendComplete('rejected', {
      terminalState: 'rejected',
      ok: false,
      resultSummary: '宿主拒绝审批：企业微信未卸载',
    });

    assert.equal(rec.ext.terminalState, 'rejected', 'D-5 保留的 rejected 语义须真实落链可取证');
    assert.equal(rec.ext.kind, 'delegation-complete');
    assert.equal(rec.result.ok, false, 'rejected 属非completed 终态 → result.ok=false');
    assert.match(rec.result.summary, /^delegation\.complete:rejected/, 'summary 前缀须如实标出终态');
    assert.equal(valid, true, 'rejected 条目入链不得破坏哈希链');
    assert.match(JSON.stringify(raw), /"terminalState":"rejected"/, '链上原始记录可grep 到 rejected');
  });

  test('路径区分：disabled 拒绝 → failed（绝不与宿主拒绝的 rejected 混同）', async () => {
    // D-5：ok:false 在框架层收口 failed；rejected 只在宿主显式拒绝路径出现。
    // 两者 result.ok 同为 false，**唯一区分信号就是 terminalState** —— 故该字段不得被泛化写死。
    const rej = await appendComplete('cmp-rejected', { terminalState: 'rejected', ok: false });
    const fail = await appendComplete('cmp-failed', {
      terminalState: 'failed',
      ok: false,
      errorCode: 'LLM_SESSION_DISABLED',
    });

    assert.equal(fail.rec.ext.terminalState, 'failed', 'disabled 拒绝终态是 failed（D-5 笔误更正）');
    assert.equal(fail.rec.result.errorCode, 'LLM_SESSION_DISABLED', '原因码独立于终态表达');
    assert.equal(rej.rec.ext.terminalState, 'rejected');
    assert.equal(
      rej.rec.result.ok,
      fail.rec.result.ok,
      '两者 ok 同为 false —— 证明跨路径泛化 ok 会丢失终态语义',
    );
    assert.notEqual(rej.rec.ext.terminalState, fail.rec.ext.terminalState, '终态必须按路径可区分');
  });

  test('terminalState 缺席时按 ok 兜底（completed/failed），不产出第三种臆造终态', async () => {
    const okCase = await appendComplete('fallback-ok', { ok: true });
    assert.equal(okCase.rec.ext.terminalState, undefined, '未给 terminalState 时不凭空造字段');
    assert.match(okCase.rec.result.summary, /^delegation\.complete:completed/, 'summary 兜底 completed');

    const failCase = await appendComplete('fallback-fail', { ok: false });
    assert.equal(failCase.rec.ext.terminalState, undefined);
    assert.match(failCase.rec.result.summary, /^delegation\.complete:failed/, 'summary 兜底 failed');
  });
});
