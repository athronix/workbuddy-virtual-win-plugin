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

import { HashChainAuditSink, canonicalJson, sha256, redact } from '@winvm/core';

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
