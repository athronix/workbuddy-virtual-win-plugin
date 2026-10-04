/**
 * T04 · CL-K3R「静默假成功」根治 —— 红档 B 组：`collectApprovalFacts` / `LedgerRegistry.blockedFor`
 * 的 R1 精确 / R2 精确排除 / R3 窗口兜底 三规则 + **串台排除**（SK-K4 反例）
 *
 * 被测对象（设计 §5.5 / §7.2，落地于 `packages/vm-service`）：
 *   - `collectApprovalFacts(pendingApprovals: Map, q: ApprovalWaitQuery, nowMs: number): PendingApprovalFact[]`
 *     （纯函数，S1 主通道事实构造；经 `vm-service/src/index.ts` 导出）
 *   - `LedgerRegistry.blockedFor(q: ApprovalWaitQuery): PendingApprovalFact[]`
 *     （S2 副通道 / 交叉验证，R1/R2/R3 归因，补 V-3 常驻路径 blocked 恒空）
 *
 * 接口契约（按设计 §6.2 `ApprovalWaitQuery` 精确命名与形状）：
 *   `q = { delegationTraceId, startedAtMs, capabilities? }`
 *   `PendingApprovalFact = { approvalId, capabilityId, risk, createdAtMs, attribution:'exact'|'window', hostApproved }`
 * 红档纪律：T01/T02 未合入 dist 前，`collectApprovalFacts` 与 `LedgerRegistry.blockedFor` 尚未导出/落地
 *   → 本文件运行即红（ESM 命名导出缺失 / 方法未定义）。工程师 T01–T02 落地 + 重建 dist 后应整体转绿
 *   （§7.2 验收判据 1/2）。若落地签名与本假设不符导致无法转绿，回报主理人协调，不改 packages/。
 *
 * 运行（只跑本文件，绝不整批）：
 *   TMPDIR="$HOME/wbtmp" node --test tests/unit/r19c-k3r-approval-wait.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { collectApprovalFacts, LedgerRegistry } from '@winvm/vm-service';

/* ============================ 夹具 ============================ */

const CAP = 'app.winget.uninstall';
const CAP_OTHER = 'app.winget.install'; // 宿主并发直调的另一 capability（串台反例）
const MY = 'tr_k3r_my';
const OTHER = 'tr_k3r_other'; // 他人委派 traceId（R2 排除反例）
const TASK = 'task_k3r_1';
const T0 = 1_000_000; // 本委派进入时刻（startedAtMs 下界）

/** 构造一条 `PendingApproval` 状事实（服务端令牌表条目形状） */
function pa(id, over = {}) {
  return {
    approvalId: id,
    capabilityId: CAP,
    risk: 'L2',
    createdAtMs: T0 + 1000,
    hostApproved: false,
    ...over,
  };
}

/**
 * 六条目令牌表，覆盖全部归因分支：
 *   apr_r1 : delegationId === MY                 → R1 精确命中
 *   apr_r2 : delegationId === OTHER              → R2 精确排除（他人委派拦截）
 *   apr_r3 : 无 delegationId + 窗口内 + 能力面命中 → R3 窗口兜底命中
 *   apr_r4 : 无 delegationId + 窗口内 + **能力面不命中** → R3 能力过滤排除（★串台反例：宿主并发直调另一 capability）
 *   apr_r5 : 无 delegationId + createdAtMs < T0  → R3 窗口下界排除（R-K3 陈旧拦截）
 *   apr_r6 : hostApproved === true               → 已批准不返（只返未决项）
 */
const pending = new Map([
  ['apr_r1', pa('apr_r1', { delegationId: MY, createdAtMs: T0 + 1000 })],
  ['apr_r2', pa('apr_r2', { delegationId: OTHER, createdAtMs: T0 + 2000 })],
  ['apr_r3', pa('apr_r3', { createdAtMs: T0 + 3000 })],
  ['apr_r4', pa('apr_r4', { capabilityId: CAP_OTHER, createdAtMs: T0 + 4000 })],
  ['apr_r5', pa('apr_r5', { createdAtMs: T0 - 500 })],
  ['apr_r6', pa('apr_r6', { createdAtMs: T0 + 5000, hostApproved: true })],
]);

const q = { delegationTraceId: MY, startedAtMs: T0, capabilities: [CAP] };

/* ============================ collectApprovalFacts（S1 主通道） ============================ */

describe('CL-K3R `collectApprovalFacts` R1/R2/R3 三规则 + 串台排除', () => {
  test('R1 精确 + R3 窗口兜底命中；R2 他人 / 串台 capability / 陈旧窗口 / 已批准 全排除', () => {
    const facts = collectApprovalFacts(pending, q, T0 + 10_000);
    const ids = facts.map((f) => f.approvalId).sort();
    assert.deepEqual(ids, ['apr_r1', 'apr_r3'], '仅 R1 + R3 命中，其余四个分支均被排除');
    const r1 = facts.find((f) => f.approvalId === 'apr_r1');
    const r3 = facts.find((f) => f.approvalId === 'apr_r3');
    assert.equal(r1.attribution, 'exact', 'R1 精确归因标记 exact');
    assert.equal(r3.attribution, 'window', 'R3 窗口兜底标记 window');
    assert.equal(r3.hostApproved, false);
    assert.equal(r3.capabilityId, CAP);
    // 返回按 createdAtMs 升序
    const order = facts.map((f) => f.createdAtMs);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'facts 按 createdAtMs 升序');
  });

  test('R2 精确排除（SK-K4 反例）：delegationId 属他人 → 不误计入本委派', () => {
    const facts = collectApprovalFacts(pending, q, T0 + 10_000);
    assert.ok(!facts.some((f) => f.approvalId === 'apr_r2'), '他人委派的拦截绝不串到本委派');
  });

  test('串台排除（SK-K4 反例）：窗口内宿主并发直调另一 capability → 不误挂本委派', () => {
    const facts = collectApprovalFacts(pending, q, T0 + 10_000);
    assert.ok(
      !facts.some((f) => f.approvalId === 'apr_r4'),
      'apr_r4（不同 capability、无 delegationId、窗口内）被能力面过滤，不误归本委派',
    );
  });

  test('R3 窗口下界（R-K3）：createdAtMs < startedAtMs 的陈旧拦截不命中', () => {
    const facts = collectApprovalFacts(pending, q, T0 + 10_000);
    assert.ok(!facts.some((f) => f.approvalId === 'apr_r5'), '早于本委派进入时刻的拦截不误归');
  });

  test('只返未决项：hostApproved === true 不返回', () => {
    const facts = collectApprovalFacts(pending, q, T0 + 10_000);
    assert.ok(!facts.some((f) => f.approvalId === 'apr_r6'), '已批准项被剔除');
    assert.ok(facts.every((f) => f.hostApproved === false), '返回项恒为未决');
  });

  test('R3 能力面缺席 ⇒ 不按能力过滤（宽口径，与 K-N1 wild 归因同形）', () => {
    const qWide = { delegationTraceId: MY, startedAtMs: T0, capabilities: undefined };
    const facts = collectApprovalFacts(pending, qWide, T0 + 10_000);
    // 无能力面时 R3 不过滤 capability ⇒ apr_r4（不同 cap）也会被窗口兜底纳入
    assert.ok(
      facts.some((f) => f.approvalId === 'apr_r4'),
      '能力面缺席 ⇒ R3 宽口径，不过滤 capability（与 K-N1 同纪律）',
    );
  });

  test('空令牌表 ⇒ 返回空数组（门 5 逐字等价）', () => {
    const empty = new Map();
    const facts = collectApprovalFacts(empty, q, T0 + 10_000);
    assert.deepEqual(facts, [], '无未决审批 ⇒ 空，判据回退文本启发式');
  });
});

/* ============================ LedgerRegistry.blockedFor（S2 副通道 / V-3 补） ============================ */

describe('CL-K3R `LedgerRegistry.blockedFor` R1/R2/R3 归因（S2 副通道，补常驻路径 blocked 恒空 V-3）', () => {
  /**
   * 注册一条 blocked 事实：兼容工程师 T02 可能采用的两种签名
   * （§5.5 `recordBlocked(seq, approvalId, capabilityId)` 或 §7.2 `recordBlockedWindow(seq, id, capId, q?)`）。
   * 注册点采用「无 delegationId」形态，模拟常驻路径（V-3 实证：常驻路径 blocked 恒空），
   * 故 `blockedFor` 必须经 R3 窗口归因才能把它归属到本委派。
   */
  function recordBlocked(reg, approvalId, capabilityId) {
    if (typeof reg.recordBlocked === 'function') {
      reg.recordBlocked(1, approvalId, capabilityId);
    } else if (typeof reg.recordBlockedWindow === 'function') {
      reg.recordBlockedWindow(1, approvalId, capabilityId, {
        delegationTraceId: MY,
        startedAtMs: T0,
        capabilities: [capabilityId],
      });
    } else {
      throw new Error('LedgerRegistry 未提供 recordBlocked / recordBlockedWindow（T02 未落地）');
    }
  }

  test('常驻路径：begin + recordBlocked（无 delegationId）→ blockedFor 经 R3 窗口返回本委派 blocked 事实', () => {
    const reg = new LedgerRegistry();
    reg.begin(MY, TASK, [CAP]);
    recordBlocked(reg, 'apr_b1', CAP);
    const facts = reg.blockedFor({ delegationTraceId: MY, startedAtMs: T0, capabilities: [CAP] });
    assert.ok(Array.isArray(facts), 'blockedFor 返回数组');
    assert.ok(facts.length >= 1, '常驻路径 blocked 不再恒空（V-3 被补）');
    assert.equal(facts[0].approvalId, 'apr_b1', '本委派的 blocked 事实被正确归属');
  });

  test('blockedFor：能力面不匹配 ⇒ 不返回（防串台，与 S1 同纪律）', () => {
    const reg = new LedgerRegistry();
    reg.begin(MY, TASK, [CAP_OTHER]); // 本委派暴露面仅 CAP_OTHER
    recordBlocked(reg, 'apr_b2', CAP_OTHER);
    const facts = reg.blockedFor({ delegationTraceId: MY, startedAtMs: T0, capabilities: [CAP] }); // 查询面为 CAP
    assert.equal(facts.length, 0, '能力面不匹配的 blocked 不误归本委派');
  });

  test('blockedFor：未 begin 的委派查询 → 返回空（不抛、不误归他人）', () => {
    const reg = new LedgerRegistry();
    const facts = reg.blockedFor({ delegationTraceId: MY, startedAtMs: T0, capabilities: [CAP] });
    assert.deepEqual(facts, [], '无账本上下文 ⇒ 空，绝不误报');
  });
});
