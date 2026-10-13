/**
 * Phase 3 批4 · M7（provider 能力差集显形）派生纯函数测试。
 *
 * 核心命题：**能力画像派生自 SPI 可选成员的方法存在性，而非按 kind 猜**——
 * hermes 与 workbuddy-llm 同为 kind='llm-agent'，若按 kind 硬分即 PM §3 要消灭的静默降级。
 * 本测用 mock provider 直接断言三键派生正确，兑现"证明有效而非确认存在"。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const MOD = pathToFileURL(join(ROOT, 'packages', 'vm-service', 'dist', 'capabilities-profile.js')).href;
const { deriveCapabilitiesProfile } = await import(MOD);

const TRUTH_ON = { mode: 'on', enabled: true, shadow: false };

describe('M7 · deriveCapabilitiesProfile 三键派生', () => {
  test('workbuddy-llm 形态：三 SPI 成员齐 + approvalTruth 回报 ⇒ 全 true', () => {
    const llm = {
      kind: 'llm-agent',
      llmSessionHealth: () => undefined,
      warmup: async () => {},
    };
    const p = deriveCapabilitiesProfile(llm, TRUTH_ON);
    assert.deepEqual(p, {
      kind: 'llm-agent',
      persistentSession: true,
      warmup: true,
      approvalTruth: TRUTH_ON,
    });
  });

  test('**hermes 形态（关键判别）**：kind 同为 llm-agent，但 SPI 成员缺席 ⇒ persistentSession/warmup=false', () => {
    // hermes 不实现 llmSessionHealth/warmup（真机 SPI 面：仅 workbuddy-llm 实现）；approvalTruth 也不回报
    const hermes = { kind: 'llm-agent' };
    const p = deriveCapabilitiesProfile(hermes, undefined);
    assert.equal(p.kind, 'llm-agent', 'kind 与 workbuddy-llm 逐字相同');
    assert.equal(p.persistentSession, false, 'hermes 无常驻会话 ⇒ 派生 false（若按 kind 猜会谎报 true）');
    assert.equal(p.warmup, false, 'hermes 无预热 ⇒ 派生 false');
    assert.equal(p.approvalTruth, null, 'provider 不回报真值层 ⇒ null（区分"没启用"vs"shadow 未命中"由三元组自身承担）');
    // 决定性：与 workbuddy-llm 的画像必然不同，尽管 kind 相同 —— 这就是 M7 消灭的静默降级
    const llm = deriveCapabilitiesProfile({ kind: 'llm-agent', llmSessionHealth: () => {}, warmup: async () => {} }, TRUTH_ON);
    assert.notDeepEqual(p, llm, 'kind 相同但画像不同 = 派生正确、按 kind 硬分错误');
  });

  test('deterministic 形态：无 SPI 成员无真值 ⇒ 三 false/null', () => {
    const det = { kind: 'deterministic' };
    const p = deriveCapabilitiesProfile(det, undefined);
    assert.deepEqual(p, { kind: 'deterministic', persistentSession: false, warmup: false, approvalTruth: null });
  });

  test('只实现 warmup 未实现 llmSessionHealth ⇒ 两键独立派生（非一荣俱荣）', () => {
    const p = deriveCapabilitiesProfile({ kind: 'llm-agent', warmup: async () => {} }, TRUTH_ON);
    assert.equal(p.warmup, true);
    assert.equal(p.persistentSession, false, 'warmup 在场不代表 llmSessionHealth 在场，逐成员独立判');
    assert.equal(p.approvalTruth?.mode, 'on');
  });

  test('approvalTruth 三元组透传不加工（shadow/off 各态原样）', () => {
    for (const t of [
      { mode: 'on', enabled: true, shadow: false },
      { mode: 'shadow', enabled: false, shadow: true },
      { mode: 'off', enabled: false, shadow: false },
    ]) {
      assert.deepEqual(deriveCapabilitiesProfile({ kind: 'custom' }, t).approvalTruth, t);
    }
  });

  test('非函数值（null/对象）不误判为已实现（typeof 严判，防 truthy 假阳）', () => {
    const p = deriveCapabilitiesProfile({ kind: 'custom', llmSessionHealth: null, warmup: {} }, undefined);
    assert.equal(p.persistentSession, false, 'llmSessionHealth=null 不得被当函数');
    assert.equal(p.warmup, false, 'warmup={} 对象不得被当函数');
  });
});
