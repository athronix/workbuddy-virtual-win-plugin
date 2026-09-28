/**
 * 哈希链审计单元测试（SECURITY-GOVERNANCE.md §4）
 *
 * 核心验证：**防篡改** —— 改动任意一条记录，全链校验必须立即失败。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HashChainAuditSink, canonicalJson, computeRecordHash, sha256, redact } from '@winvm/core';

let dir;
function freshSink(opts = {}) {
  dir = mkdtempSync(join(tmpdir(), 'winvm-audit-'));
  return new HashChainAuditSink({ dir, ...opts });
}

function rec(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    traceId: 'tr_test_001',
    auditId: 'aud_test_001',
    principal: { host: 'workbuddy', user: 'vmuser', channel: 'mcp' },
    capabilityId: 'storage.file.delete',
    risk: 'L2',
    params: { path: 'C:\\Users\\alice\\old' },
    policyDecision: { allowed: true, matchedRule: 'pathAllowlist' },
    result: { ok: true, summary: '已删除' },
    durationMs: 12,
    ...overrides,
  };
}

/** 直接把记录写进当前分片文件（D30 测试用：手工构造链/断链现场） */
function writeChainFile(fileName, records) {
  writeFileSync(join(dir, fileName), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** 构造一条带正确 hash 的记录（不经过 sink） */
function makeRecord(seq, prevHash, overrides = {}) {
  const partial = { ...rec({ auditId: `aud_${seq}` }), seq, prevHash, ...overrides };
  return { ...partial, hash: computeRecordHash(partial) };
}

describe('规范化 JSON 与哈希', () => {
  test('键名递归排序，保证同一对象序列化一致', () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":3,"d":4},"b":1}');
  });

  test('键序不同但内容相同的对象哈希一致', () => {
    assert.equal(sha256(canonicalJson({ x: 1, y: 2 })), sha256(canonicalJson({ y: 2, x: 1 })));
  });

  test('内容不同则哈希不同', () => {
    assert.notEqual(sha256('a'), sha256('b'));
  });
});

describe('脱敏', () => {
  test('敏感键名打码', () => {
    const out = redact({ password: 'hunter2', apiKey: 'abc', user: 'alice' });
    assert.equal(out.password, '***REDACTED***');
    assert.equal(out.apiKey, '***REDACTED***', 'apiKey 属敏感凭据，必须打码');
    assert.equal(out.user, 'alice', '非敏感字段保持原样');
  });

  test('token 类凭据一律打码', () => {
    const out = redact({ accessToken: 't', refresh_token: 'r', bearerToken: 'b' });
    assert.equal(out.accessToken, '***REDACTED***');
    assert.equal(out.refresh_token, '***REDACTED***');
    assert.equal(out.bearerToken, '***REDACTED***');
  });

  test('超长 base64 截断并记录哈希前缀', () => {
    const long = 'A'.repeat(300);
    const out = redact({ blob: long });
    assert.match(out.blob, /^<base64 len=300 sha256=[0-9a-f]{16}…>$/);
  });

  test('嵌套结构递归脱敏', () => {
    const out = redact({ a: { b: { apiKey: 'secret' } } });
    assert.equal(out.a.b.apiKey, '***REDACTED***');
  });
});

describe('哈希链写入与校验', () => {
  let sink;
  beforeEach(() => {
    sink = freshSink();
  });

  test('首条记录 prevHash 为 GENESIS', async () => {
    const r = await sink.append(rec());
    assert.equal(r.seq, 1);
    assert.equal(r.prevHash, 'GENESIS');
    assert.match(r.hash, /^[0-9a-f]{64}$/);
  });

  test('seq 与 prevHash 严格链式递进', async () => {
    const a = await sink.append(rec());
    const b = await sink.append(rec({ auditId: 'aud_2' }));
    const c = await sink.append(rec({ auditId: 'aud_3' }));
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(c.seq, 3);
    assert.equal(b.prevHash, a.hash);
    assert.equal(c.prevHash, b.hash);
  });

  test('空链校验通过', async () => {
    const v = await sink.verifyChain();
    assert.equal(v.valid, true);
    assert.equal(v.entries, 0);
  });

  test('正常链校验通过', async () => {
    for (let i = 0; i < 5; i++) await sink.append(rec({ auditId: `aud_${i}` }));
    const v = await sink.verifyChain();
    assert.equal(v.valid, true);
    assert.equal(v.entries, 5);
  });

  test('敏感参数写入时被自动脱敏', async () => {
    const r = await sink.append(rec({ params: { password: 'hunter2', path: 'C:\\Users\\a' } }));
    assert.equal(r.params.password, '***REDACTED***');
    assert.equal(r.params.path, 'C:\\Users\\a');
  });

  test('按 traceId 查询', async () => {
    await sink.append(rec({ traceId: 'AAA' }));
    await sink.append(rec({ traceId: 'BBB', auditId: 'aud_b' }));
    await sink.append(rec({ traceId: 'AAA', auditId: 'aud_c' }));
    const out = await sink.query({ traceId: 'AAA' });
    assert.equal(out.length, 2);
    assert.ok(out.every((r) => r.traceId === 'AAA'));
  });
});

describe('哈希链防篡改（核心安全属性）', () => {
  test('篡改内容 → 校验立即失败', async () => {
    const sink = freshSink();
    await sink.append(rec({ auditId: 'aud_1' }));
    await sink.append(rec({ auditId: 'aud_2' }));
    await sink.append(rec({ auditId: 'aud_3' }));

    // 直接改磁盘上的第 2 条：把结果从 ok 改成 ok，但改掉路径（模拟掩盖操作对象）
    const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl')));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.params = { path: 'C:\\Users\\victim\\innocent' };
    lines[1] = JSON.stringify(tampered);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    // 用全新实例校验（避免命中内存缓存）
    const verifier = new HashChainAuditSink({ dir });
    const v = await verifier.verifyChain();
    assert.equal(v.valid, false, '篡改必须被检出');
    assert.equal(v.brokenAt, 2, '应定位到第 2 条');
  });

  test('删除中间记录 → 校验失败', async () => {
    const sink = freshSink();
    await sink.append(rec({ auditId: 'aud_1' }));
    await sink.append(rec({ auditId: 'aud_2' }));
    await sink.append(rec({ auditId: 'aud_3' }));

    const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl')));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n', 'utf8');

    const verifier = new HashChainAuditSink({ dir });
    const v = await verifier.verifyChain();
    assert.equal(v.valid, false, '删除记录必须被检出');
  });

  test('追加新实例后链仍然延续（断点恢复）', async () => {
    const sink = freshSink();
    const a = await sink.append(rec({ auditId: 'aud_1' }));

    const sink2 = new HashChainAuditSink({ dir });
    const b = await sink2.append(rec({ auditId: 'aud_2' }));
    assert.equal(b.seq, 2);
    assert.equal(b.prevHash, a.hash);

    const v = await sink2.verifyChain();
    assert.equal(v.valid, true);
    assert.equal(v.entries, 2);
  });
});

describe('D30：并发取号竞态修复', () => {
  test('并发 append 不得重复取号、不得链分叉', async () => {
    const sink = freshSink();
    const N = 24;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => sink.append(rec({ auditId: `aud_${i}` }))),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1), 'seq 必须为 1..N 且无重复');

    // 链必须严格串接：每条 prevHash 恰为 seq-1 的 hash
    const bySeq = new Map(results.map((r) => [r.seq, r]));
    for (const r of results) {
      if (r.seq === 1) assert.equal(r.prevHash, 'GENESIS');
      else assert.equal(r.prevHash, bySeq.get(r.seq - 1).hash, `seq=${r.seq} 的 prevHash 必须指向前一条`);
    }

    const v = await sink.verifyChain();
    assert.equal(v.valid, true);
    assert.equal(v.entries, N);
    assert.equal(v.reason, undefined);
  });

  test('单条写入失败不阻断后续写入', async () => {
    const sink = freshSink();
    await sink.append(rec({ auditId: 'aud_1' }));
    // 塞一个非法分片路径让第一次 append 失败后，后续仍可正常写
    const broken = Object.create(sink);
    broken.currentShard = async () => { throw new Error('模拟磁盘故障'); };
    await assert.rejects(() => broken.append(rec({ auditId: 'aud_bad' })));
    const ok = await sink.append(rec({ auditId: 'aud_2' }));
    assert.equal(ok.seq, 2, '失败不应吞掉或重复 seq');
    const v = await sink.verifyChain();
    assert.equal(v.valid, true);
  });
});

describe('D30：verifyChain 断裂原因', () => {
  test('内容篡改 → HASH_MISMATCH', async () => {
    freshSink();
    const r1 = makeRecord(1, 'GENESIS');
    const r2 = makeRecord(2, r1.hash);
    writeChainFile('audit-20260101.jsonl', [r1, { ...r2, params: { path: 'C:\\tampered' } }]);
    const v = await new HashChainAuditSink({ dir }).verifyChain();
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'HASH_MISMATCH');
    assert.equal(v.brokenAt, 2);
  });

  test('重复 seq → SEQ_DUP', async () => {
    freshSink();
    const r1 = makeRecord(1, 'GENESIS');
    const r2 = makeRecord(2, r1.hash);
    const r2dup = makeRecord(2, r2.hash, { auditId: 'aud_2_dup' });
    writeChainFile('audit-20260101.jsonl', [r1, r2, r2dup]);
    const v = await new HashChainAuditSink({ dir }).verifyChain();
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'SEQ_DUP');
    assert.equal(v.brokenAt, 2);
  });

  test('seq 跳号 → SEQ_GAP', async () => {
    freshSink();
    const r1 = makeRecord(1, 'GENESIS');
    const r3 = makeRecord(3, r1.hash);
    writeChainFile('audit-20260101.jsonl', [r1, r3]);
    const v = await new HashChainAuditSink({ dir }).verifyChain();
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'SEQ_GAP');
    assert.equal(v.brokenAt, 3);
  });

  test('prevHash 断链（哈希与 seq 均合法）→ CHAIN_BREAK', async () => {
    freshSink();
    const r1 = makeRecord(1, 'GENESIS');
    const r2 = makeRecord(2, 'NOT_THE_PREV');
    writeChainFile('audit-20260101.jsonl', [r1, r2]);
    const v = await new HashChainAuditSink({ dir }).verifyChain();
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'CHAIN_BREAK');
    assert.equal(v.brokenAt, 2);
  });
});

describe('D30：分片排序修复', () => {
  test('轮转分片 -1 排在正名之后，跨文件链校验通过（旧字典序会假阴性）', async () => {
    freshSink();
    const r1 = makeRecord(1, 'GENESIS');
    const r2 = makeRecord(2, r1.hash);
    const r3 = makeRecord(3, r2.hash);
    // 写入顺序模拟轮转：正名先写满，随后数据进 -1
    writeChainFile('audit-20260101.jsonl', [r1, r2]);
    writeChainFile('audit-20260101-1.jsonl', [r3]);
    const v = await new HashChainAuditSink({ dir }).verifyChain();
    assert.equal(v.valid, true, '轮转分片必须排在正名之后（同日内）');
    assert.equal(v.entries, 3);
  });
});

describe('D30：freshChainOnStart（新链基线随启动重置）', () => {
  test('历史断链分片仅归档：新 sink 全新 genesis 起链，verifyChain 恒 valid，query 仍可查历史', async () => {
    dir = mkdtempSync(join(tmpdir(), 'winvm-audit-'));
    // 历史分片：含重复 seq 断链（模拟真机 seq=511 现场）
    const r1 = makeRecord(1, 'GENESIS');
    const r2 = makeRecord(2, r1.hash);
    const r2dup = makeRecord(2, r2.hash, { auditId: 'aud_2_dup' });
    writeFileSync(join(dir, 'audit-20260101.jsonl'), [r1, r2, r2dup].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // 旧模式续接：chainValid=false（历史断链拖累）
    const legacy = await new HashChainAuditSink({ dir }).verifyChain();
    assert.equal(legacy.valid, false);
    assert.equal(legacy.reason, 'SEQ_DUP');

    // freshChain：起新分片 + 全新 genesis；历史分片不参与判定
    const sink = new HashChainAuditSink({ dir, freshChainOnStart: true });
    const v0 = await sink.verifyChain();
    assert.equal(v0.valid, true, '启动即校验（尚无新记录）应为 valid');
    assert.equal(v0.entries, 0);

    const first = await sink.append(rec({ auditId: 'aud_new_1' }));
    assert.equal(first.seq, 1, '新链 seq 从 1 重计');
    assert.equal(first.prevHash, 'GENESIS', '新链以全新 genesis 起链');

    await sink.append(rec({ auditId: 'aud_new_2' }));
    const v1 = await sink.verifyChain();
    assert.equal(v1.valid, true, '新链不受历史断链影响');
    assert.equal(v1.entries, 2, '只统计本轮分片');

    // 新记录必须落在与历史分片**不同**的文件里（绝不混写）
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length >= 2, `应有历史分片 + 新分片，实际：${files.join(', ')}`);
    const histFile = files.find((f) => f === 'audit-20260101.jsonl');
    assert.ok(histFile, '历史分片保持原样（归档）');

    // 归档仍可查询
    const all = await sink.query({});
    assert.equal(all.length, 5, 'query 覆盖历史归档 + 新链');
  });

  test('同日重启不与历史链混写同一分片', async () => {
    dir = mkdtempSync(join(tmpdir(), 'winvm-audit-'));
    const r1 = makeRecord(1, 'GENESIS');
    writeChainFile('audit-20260101.jsonl', [r1]);
    const sink = new HashChainAuditSink({ dir, freshChainOnStart: true });
    const first = await sink.append(rec({ auditId: 'aud_new_1' }));
    assert.equal(first.seq, 1);
    const v = await sink.verifyChain();
    assert.equal(v.valid, true, '不得把新记录追加进已含历史链的正名分片');
  });
});
