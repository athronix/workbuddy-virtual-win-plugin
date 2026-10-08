/**
 * S-4 修复单元测试：策略硬拒绝（黑名单命中 / 能力未注册 / 超 maxRisk / 不在白名单等）
 * 必须入哈希链审计（`blocked:policy-denied`），闭合「两处 POLICY_DENIED 早退零审计」的取证盲区。
 *
 * 纯函数测试（不起 HTTP 服务、不 spawn ps-bridge），镜像 `tests/unit/k5-replay.test.js`
 * 中 `recordBlockedApprovalAudit` 的测试风格。核心不变式：
 *
 * ① 主断言：策略硬拒绝写入的 record 满足
 *      policyDecision.allowed === false
 *      policyDecision.matchedRule === 真实拒绝规则（如 'path-blacklist'）
 *      result.ok === false
 *      result.errorCode === 'POLICY_DENIED'
 *      result.summary 含 'blocked:policy-denied'
 * ② 写失败纪律：audit.append 抛错时返回 { ok:false } 且 logger.warn 被调用（绝不抛到调用方——
 *      拒绝语义优先）。
 * ③ 账本跳过：policy-denied 记录经 onAuditRecord 被跳过（不污染 blocked/wild 计数）。
 *
 * 纪律：不起 HTTP 服务、不 spawn 真实 CLI。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LedgerRegistry, recordPolicyDeniedAudit } from '@winvm/vm-service';

/* ============================ 通用夹具 ============================ */

const CAP = 'app.winget.uninstall';

/** 全 no-op logger；warn 可被断言捕获 */
function makeLogger(logs = []) {
  return {
    debug: () => {},
    info: () => {},
    warn: (m, f) => logs.push([m, f]),
    error: () => {},
  };
}

/** 捕获 append 入参的 mock audit sink（不落盘，避免 fs 依赖） */
function captureAudit() {
  const records = [];
  const audit = {
    append: async (inp) => {
      records.push(inp);
      return { ...inp, seq: records.length, hash: `h${records.length}` };
    },
  };
  return { audit, records };
}

/* ============================ S-4 主断言 + 写失败纪律 ============================ */

describe('S-4 策略硬拒绝审计留痕（recordPolicyDeniedAudit）', () => {
  test('主断言：策略硬拒绝写入 record 满足 blocked:policy-denied 语义（终态拒绝、未执行）', async () => {
    const logs = [];
    const logger = makeLogger(logs);
    const { audit, records } = captureAudit();

    const res = await recordPolicyDeniedAudit(
      audit,
      logger,
      {
        traceId: 'tr_pd_1',
        capabilityId: CAP,
        risk: 'L2',
        params: { packageId: 'WXWork' },
        startedAtMs: Date.now() - 5,
        matchedRule: 'path-blacklist',
        errorCode: 'POLICY_DENIED',
        errorMessage: '路径命中黑名单',
      },
      () => 'aud_pd_1',
      { channel: 'mcp' },
    );

    assert.deepEqual(res, { ok: true }, '成功写入应返回 { ok: true }');
    assert.equal(records.length, 1, '必须恰好落一条审计');

    const rec = records[0];
    assert.equal(rec.traceId, 'tr_pd_1');
    assert.equal(rec.auditId, 'aud_pd_1');
    assert.equal(rec.capabilityId, CAP);
    // 策略判定：终态拒绝
    assert.equal(rec.policyDecision.allowed, false);
    assert.equal(rec.policyDecision.matchedRule, 'path-blacklist', '保留真实拒绝规则（便于事后溯源）');
    // 审批位：哨兵 policy-denied（终态拒绝而非待审批）
    assert.equal(rec.approval.approvalId, 'policy-denied');
    assert.equal(rec.approval.approvedBy, 'policy-engine');
    // 执行结果：明确未执行
    assert.equal(rec.result.ok, false, '被策略拒绝绝不能记成成功');
    assert.equal(rec.result.errorCode, 'POLICY_DENIED');
    assert.match(rec.result.summary, /blocked:policy-denied/, 'summary 必须含 blocked:policy-denied 标记');
    // 通道与归因
    assert.equal(rec.principal.host, 'vm-service');
    assert.equal(rec.principal.channel, 'mcp');
    assert.ok(typeof rec.durationMs === 'number' && rec.durationMs >= 0, 'durationMs 应可计算');
    assert.equal(logs.length, 0, '成功路径不应有 warn');
  });

  test('写失败纪律：audit.append 抛错 → 返回 { ok:false } 且 logger.warn 被调用（拒绝语义优先，绝不抛到调用方）', async () => {
    const logs = [];
    const logger = makeLogger(logs);
    const audit = { append: () => Promise.reject(new Error('disk gone')) };

    let threw = false;
    let res;
    try {
      res = await recordPolicyDeniedAudit(
        audit,
        logger,
        {
          traceId: 'tr_pd_x',
          capabilityId: CAP,
          risk: 'L2',
          params: {},
          startedAtMs: Date.now(),
          matchedRule: 'capability-not-registered',
          errorCode: 'POLICY_DENIED',
        },
        () => 'aud_pd_x',
        { channel: 'mcp' },
      );
    } catch (e) {
      threw = true;
    }

    assert.equal(threw, false, '审计写失败绝不可冒泡到调用方');
    assert.equal(res.ok, false, '写失败必须返回 ok:false');
    assert.match(res.error, /disk gone/);
    assert.equal(logs.length, 1, '失败必须留一条 warn 日志');
    assert.match(logs[0][0], /policy-denied 审计写入失败/);
  });

  test('K-N1 归因：传入 delegationId → record.ext 携带 inner-call 归因（通道 a2a）', async () => {
    const logger = makeLogger();
    const { audit, records } = captureAudit();

    await recordPolicyDeniedAudit(
      audit,
      logger,
      {
        traceId: 'tr_pd_d',
        capabilityId: CAP,
        risk: 'L2',
        params: {},
        startedAtMs: Date.now(),
        matchedRule: 'max-risk',
        errorCode: 'POLICY_DENIED',
      },
      () => 'aud_pd_d',
      { channel: 'a2a', delegationId: 'dt_a2a_1' },
    );

    const rec = records[0];
    assert.equal(rec.ext.kind, 'inner-call', 'K-N1 归因 ext 应存在');
    assert.equal(rec.ext.delegationId, 'dt_a2a_1');
    assert.equal(rec.ext.channel, 'a2a');
  });

  test('无 delegationId → record 不带 ext（旧形态逐字节不变，不污染账本归因）', async () => {
    const logger = makeLogger();
    const { audit, records } = captureAudit();

    await recordPolicyDeniedAudit(
      audit,
      logger,
      {
        traceId: 'tr_pd_nd',
        capabilityId: CAP,
        risk: 'L2',
        params: {},
        startedAtMs: Date.now(),
        matchedRule: 'no-white-list',
        errorCode: 'POLICY_DENIED',
      },
      () => 'aud_pd_nd',
      { channel: 'mcp' },
    );

    assert.equal('ext' in records[0], false, '无 delegationId 时整 ext 键缺席');
  });
});

/* ============================ S-4 账本跳过规则 ============================ */

describe('S-4 账本跳过：policy-denied 记录不得污染 blocked/wild 计数', () => {
  test('onAuditRecord 对真实策略拒绝记录（matchedRule=具体规则名 + approval 哨兵）提前 return（不重复计为 executed/wild）', () => {
    const registry = new LedgerRegistry();
    registry.begin('dt1', 't1', ['cap.x']);

    // 真实记录形状：matchedRule 是引擎具体规则名（非字面 'policy-denied'），
    // 策略拒绝靠我们自己写入的 approval.approvalId='policy-denied' 哨兵判别。
    registry.onAuditRecord({
      seq: 1,
      capabilityId: 'cap.x',
      ts: new Date().toISOString(),
      traceId: 'dt1',
      policyDecision: { allowed: false, matchedRule: 'maxRisk:5' }, // 真实规则名
      approval: { approvalId: 'policy-denied' }, // 哨兵
      result: { ok: false, errorCode: 'POLICY_DENIED' },
    });

    const act = registry.activityFor('dt1');
    assert.equal(act.blocked, 0, 'policy-denied 不应被计为 blocked');
    assert.equal(act.wild, 0, 'policy-denied 不应被计为 wild');
    assert.equal(act.executed, 0);
    assert.equal(act.total, 0);
  });

  test('对照：普通内层调用（无 policyDecision）仍正常计为 wild（确保跳过规则只针对 blocked 类）', () => {
    const registry = new LedgerRegistry();
    registry.begin('dt1', 't1', ['cap.x']);

    registry.onAuditRecord({
      seq: 2,
      capabilityId: 'cap.x',
      ts: new Date().toISOString(),
      traceId: 'dt1',
      result: { ok: true },
    });

    const act = registry.activityFor('dt1');
    assert.equal(act.wild, 1, '普通内层调用仍应被计为 wild（跳过规则不误伤）');
    assert.equal(act.blocked, 0);
  });

  test('负向：带真实规则名但无 approvalId 哨兵的记录，不应被 policy-denied 跳过规则误判为 blocked（该规则须经自身审计通道，此处仅校验跳过判别器不误伤）', () => {
    const registry = new LedgerRegistry();
    registry.begin('dt2', 't2', ['cap.x']);
    // 注意：这里未带 approval.approvalId='policy-denied'，故不应触发跳过；
    // 它会被正常计为 wild（无 ext.delegationId）。本条锁定「判别器只认哨兵、不认规则名」。
    registry.onAuditRecord({
      seq: 3,
      capabilityId: 'cap.x',
      ts: new Date().toISOString(),
      traceId: 'dt2',
      policyDecision: { allowed: false, matchedRule: 'maxRisk:5' },
      result: { ok: false, errorCode: 'POLICY_DENIED' },
    });
    const act = registry.activityFor('dt2');
    assert.equal(act.wild, 1, '无哨兵的真实拒绝记录不被 policy-denied 跳过规则捕获（按设计经自身审计通道，此处只校验判别器不误伤）');
    assert.equal(act.total, 1);
  });
});
