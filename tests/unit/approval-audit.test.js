/**
 * 宿主侧审批留痕（packages/host-a2a-bridge/src/approval-audit.ts）单元测试 —— CL-016
 *
 * 验证：
 *   - canonicalJson 键序无关、剔除凭据键（哨兵值）
 *   - previewHash 稳定性与敏感性
 *   - approvalId ↔ traceId 双向可查、唯一性（同 id 更新）
 *   - 结果四态可辨
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson,
  hashApprovalPreview,
  recordHostApprovalAudit,
  lookupByApprovalId,
  lookupByTraceId,
  _resetAuditIndex,
  CREDENTIAL_KEY_RE,
  REDACTED,
  redactCredentials,
} from '@winvm/host-a2a-bridge';

describe('CL-016 canonicalJson', () => {
  test('键序无关：同内容不同键序 → 同字符串', () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.equal(
      canonicalJson({ z: { y: 1, x: 2 }, a: 3 }),
      canonicalJson({ a: 3, z: { x: 2, y: 1 } }),
    );
  });

  test('剔除凭据键（哨兵值断言）', () => {
    const s = canonicalJson({
      user: 'u',
      password: 'SENTINEL_PW',
      privateKey: 'SENTINEL_KEY',
      passphrase: 'SENTINEL_PP',
      token: 'SENTINEL_TK',
      secret: 'SENTINEL_SEC',
      nested: { password: 'SENTINEL_NESTED', keep: 'ok' },
    });
    assert.ok(!s.includes('SENTINEL_PW'));
    assert.ok(!s.includes('SENTINEL_KEY'));
    assert.ok(!s.includes('SENTINEL_PP'));
    assert.ok(!s.includes('SENTINEL_TK'));
    assert.ok(!s.includes('SENTINEL_SEC'));
    assert.ok(!s.includes('SENTINEL_NESTED'));
    assert.ok(s.includes('"user":"u"'));
    assert.ok(s.includes('"keep":"ok"'));
  });

  test('不输出 undefined 字面量', () => {
    assert.ok(!canonicalJson({ a: undefined, b: 1 }).includes('undefined'));
  });
});

describe('CL-016 previewHash', () => {
  test('同输入同哈希（键序无关）', () => {
    const h1 = hashApprovalPreview({ capabilityId: 'c', risk: 'L2', preview: { x: 1 }, impact: ['a'] });
    const h2 = hashApprovalPreview({ impact: ['a'], preview: { x: 1 }, risk: 'L2', capabilityId: 'c' });
    assert.equal(h1, h2);
  });

  test('敏感性：改 preview 则哈希变', () => {
    const h1 = hashApprovalPreview({ preview: { x: 1 } });
    const h2 = hashApprovalPreview({ preview: { x: 2 } });
    assert.notEqual(h1, h2);
  });

  test('敏感性：改 impact 则哈希变', () => {
    assert.notEqual(hashApprovalPreview({ impact: ['a'] }), hashApprovalPreview({ impact: ['a', 'b'] }));
  });

  test('输出为 64 位小写 hex', () => {
    assert.match(hashApprovalPreview({ preview: {} }), /^[0-9a-f]{64}$/);
  });

  test('凭据键不参与哈希（改凭据值哈希不变）', () => {
    const h1 = hashApprovalPreview({ preview: { password: 'SENTINEL_A' } });
    const h2 = hashApprovalPreview({ preview: { password: 'SENTINEL_B' } });
    assert.equal(h1, h2);
  });
});

describe('CL-016 审计索引', () => {
  beforeEach(() => _resetAuditIndex());

  test('approvalId ↔ traceId 双向可查', () => {
    const rec = recordHostApprovalAudit({
      approvalId: 'apr_1',
      traceId: 'tr_1',
      channel: 'a2a',
      capabilityId: 'storage.file.delete',
      risk: 'L2',
      previewHash: hashApprovalPreview({ capabilityId: 'storage.file.delete', risk: 'L2' }),
      result: 'pending',
    });
    const byId = lookupByApprovalId('apr_1');
    assert.ok(byId);
    assert.equal(byId.traceId, 'tr_1');
    assert.equal(byId.at, rec.at);
    assert.ok(!Number.isNaN(Date.parse(rec.at)), 'at 应为可解析的 ISO 8601');

    const byTrace = lookupByTraceId('tr_1');
    assert.equal(byTrace.length, 1);
    assert.equal(byTrace[0].approvalId, 'apr_1');
  });

  test('同 approvalId 重复记录 → 更新而非重复', () => {
    recordHostApprovalAudit({ approvalId: 'apr_2', traceId: 'tr_2', channel: 'a2a', result: 'pending' });
    recordHostApprovalAudit({ approvalId: 'apr_2', traceId: 'tr_2', channel: 'a2a', result: 'approved' });
    assert.equal(lookupByApprovalId('apr_2').result, 'approved');
    assert.equal(lookupByTraceId('tr_2').length, 1, 'approvalId 唯一，不应重复');
  });

  test('结果四态可辨（pending/approved/rejected/timeout/canceled）', () => {
    for (const r of ['pending', 'approved', 'rejected', 'timeout', 'canceled']) {
      const rec = recordHostApprovalAudit({ approvalId: `apr_${r}`, traceId: 'tr_x', channel: 'a2a', result: r });
      assert.equal(rec.result, r);
      assert.equal(lookupByApprovalId(`apr_${r}`).result, r);
    }
  });

  test('凭据不入审计记录（入口双重剔除）', () => {
    const rec = recordHostApprovalAudit({
      approvalId: 'apr_3',
      traceId: 'tr_3',
      channel: 'a2a',
      result: 'pending',
      password: 'SENTINEL_PW',
      token: 'SENTINEL_TK',
    });
    const s = JSON.stringify(rec);
    assert.ok(!s.includes('SENTINEL_PW'));
    assert.ok(!s.includes('SENTINEL_TK'));
    assert.equal('password' in rec, false);
    assert.equal('token' in rec, false);
  });

  test('traceId 可查多条审批事件', () => {
    recordHostApprovalAudit({ approvalId: 'apr_a', traceId: 'tr_multi', channel: 'a2a', result: 'approved' });
    recordHostApprovalAudit({ approvalId: 'apr_b', traceId: 'tr_multi', channel: 'a2a', result: 'rejected' });
    const list = lookupByTraceId('tr_multi');
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((r) => r.approvalId).sort(), ['apr_a', 'apr_b']);
  });
});

describe('CL-016 统一凭据正则（并集口径）', () => {
  test('CREDENTIAL_KEY_RE 覆盖并集键名（含 passphrase / apikey / credential / passwd）', () => {
    for (const k of ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'api_key', 'credential', 'privateKey', 'private_key']) {
      assert.ok(CREDENTIAL_KEY_RE.test(k), `应命中 ${k}`);
    }
    assert.equal(REDACTED, '***REDACTED***');
    for (const k of ['user', 'path', 'note', 'capabilityId']) {
      assert.ok(!CREDENTIAL_KEY_RE.test(k), `不应命中 ${k}`);
    }
  });

  test('canonicalJson：passphrase / apikey / api_key / credential 也剔除', () => {
    const s = canonicalJson({
      passwd: 'SENTINEL_PWD',
      passphrase: 'SENTINEL_PP',
      apikey: 'SENTINEL_AK',
      api_key: 'SENTINEL_AK2',
      credential: 'SENTINEL_CRED',
      keep: 'ok',
    });
    for (const sent of ['SENTINEL_PWD', 'SENTINEL_PP', 'SENTINEL_AK', 'SENTINEL_AK2', 'SENTINEL_CRED']) {
      assert.ok(!s.includes(sent), `canonicalJson 不应含 ${sent}`);
    }
    assert.ok(s.includes('"keep":"ok"'));
  });

  test('redactCredentials：并集键名打码（递归），非凭据值原样保留', () => {
    const out = redactCredentials({
      user: 'alice',
      password: 'SENTINEL_1',
      passphrase: 'SENTINEL_2',
      apikey: 'SENTINEL_3',
      credential: 'SENTINEL_4',
      nested: { token: 'SENTINEL_5', keep: 'v' },
      list: [{ secret: 'SENTINEL_6' }, 'plain'],
    });
    assert.equal(out.user, 'alice');
    assert.equal(out.password, '***REDACTED***');
    assert.equal(out.passphrase, '***REDACTED***');
    assert.equal(out.apikey, '***REDACTED***');
    assert.equal(out.credential, '***REDACTED***');
    assert.equal(out.nested.token, '***REDACTED***');
    assert.equal(out.nested.keep, 'v');
    assert.equal(out.list[0].secret, '***REDACTED***');
    assert.equal(out.list[1], 'plain');
  });
});
