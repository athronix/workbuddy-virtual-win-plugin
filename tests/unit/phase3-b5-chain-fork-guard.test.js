/**
 * Phase 3 批5 · T13 防再发（用户 A 销账 + 要求"确保以后不再出现审计存档指向错乱"）。
 *
 * 根因回顾（真机实证 audit-20260918 分片 entry#511/#582 重复 seq ⇒ prevHash 指错 = 并发分叉）：
 * 旧 `append()` 在**进串行区之前**同步取号（seq=this.seq+1、prevHash=this.lastHash），
 * 且状态回写延后到写盘完成 ⇒ 并发 append 取到同 seq/同 prevHash ⇒ 链分叉。
 * 现修复：全部状态读写移入 `writeQueue` 串行闭包（chain.ts:481-494 doAppend）。
 *
 * 本测**锁死这条修复**：并发压 append ⇒ 断言 seq 严格连续、prevHash 逐条指向前驱 hash、
 * verifyChain 全链 valid。任何把取号挪回串行区外、或轮转时基线错接的重构 ⇒ 当场红。
 * 轮转分片（小 maxFileBytes 逼出跨片）尤其关键——"存档指向错乱"就发生在片边界接链。
 *
 * 纯 stdlib；逐文件跑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const CORE = pathToFileURL(join(ROOT, 'packages', 'core', 'dist', 'index.js')).href;

function mkRec(n) {
  return {
    ts: new Date(Date.UTC(2026, 9, 13, 0, 0, n)).toISOString(),
    traceId: `tr_b5_${n}`,
    auditId: `aud_b5_${n}`,
    principal: { host: 'test', user: 'u', channel: 'mcp' },
    capabilityId: 'system.info.get',
    risk: 'L0',
    params: { n },
    policyDecision: { allowed: true, matchedRule: 'test' },
    result: { ok: true, summary: 'ok' },
    durationMs: 1,
  };
}

describe('T13 防再发 · 并发 append 链零分叉（锁死 D30 串行闭包修复）', async () => {
  const { HashChainAuditSink } = await import(CORE);
  let dir;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p3b5-fork-'));
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('50 条并发 append（单 tick 齐射）⇒ seq 1..50 严格连续、链全 valid', async () => {
    // maxFileBytes 给足（不分片）：纯验并发取号串行
    const sink = new HashChainAuditSink({ dir, maxFileBytes: 10 * 1024 * 1024 });
    const N = 50;
    const recs = await Promise.all(Array.from({ length: N }, (_, i) => sink.append(mkRec(i))));

    // 落盘 seq 集合必须是 1..N 无重无漏
    const seqs = recs.map((r) => r.seq).sort((a, b) => a - b);
    for (let i = 0; i < N; i++) {
      assert.equal(seqs[i], i + 1, `并发落盘 seq 应恰为 1..${N}（第 ${i} 位实得 ${seqs[i]}）—— 重复 seq=D30 分叉复活`);
    }

    const v = await sink.verifyChain();
    assert.equal(v.valid, true, `链校验必须 valid；实得 reason=${v.reason} brokenAt=${v.brokenAt}`);
    assert.equal(v.entries, N);
  });

  test('并发 append + **强制轮转**（小 maxFileBytes）⇒ 跨片 prevHash 逐条正确接链、全链 valid', async () => {
    // 关键：轮转片边界正是"存档指向错乱"发生处。maxFileBytes 极小 ⇒ N 条被拆成多片。
    const sink = new HashChainAuditSink({ dir, maxFileBytes: 200 });
    const N = 40;
    await Promise.all(Array.from({ length: N }, (_, i) => sink.append(mkRec(i))));

    const shards = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(shards.length > 1, `小阈值应逼出多片轮转，实得 ${shards.length} 片——未测到跨片接链`);

    // verifyChain 跨文件按 seq 排序连续校验：任何片边界 prevHash 指错 ⇒ 非 valid
    const v = await sink.verifyChain();
    assert.equal(v.valid, true, `跨片接链必须 valid；实得 reason=${v.reason} brokenAt=${v.brokenAt}`);
    assert.equal(v.entries, N);

    // 逐条亲验 prevHash == 前驱 hash（不依赖 verifyChain 内部，独立复核"指向"这件事本身）
    const allLines = shards
      .flatMap((s) => readFileSync(join(dir, s), 'utf8').split('\n'))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .sort((a, b) => a.seq - b.seq);
    assert.equal(allLines.length, N);
    const { sha256, canonicalJson } = await import(CORE);
    let expectedPrev = undefined; // 创世
    for (const rec of allLines) {
      if (expectedPrev === undefined) {
        assert.ok(rec.prevHash, '首条 prevHash 应为 GENESIS（非空）');
      } else {
        assert.equal(rec.prevHash, expectedPrev, `seq=${rec.seq} prevHash 指错（应=${expectedPrev?.slice(0, 12)}… 实=${rec.prevHash?.slice(0, 12)}…）—— 分叉形态`);
      }
      const { hash, ...rest } = rec;
      assert.equal(rec.hash, sha256(canonicalJson(rest)), `seq=${rec.seq} 自哈希不符`);
      expectedPrev = hash;
    }
  });

  test('两轮并发齐射（重启续链）⇒ 第二轮接第一轮尾 hash，seq 延续不重置', async () => {
    const a = new HashChainAuditSink({ dir, maxFileBytes: 10 * 1024 * 1024 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => a.append(mkRec(i))));
    // 新实例（模拟重启，非 freshChain ⇒ 续接历史链）
    const b = new HashChainAuditSink({ dir, maxFileBytes: 10 * 1024 * 1024 });
    const more = await Promise.all(Array.from({ length: 10 }, (_, i) => b.append(mkRec(100 + i))));
    assert.equal(more[9].seq, 20, `续链 seq 应接 10 后到 20，实得 ${more[9].seq}`);
    const v = await b.verifyChain();
    assert.equal(v.valid, true, `跨重启全链必须 valid；实得 reason=${v.reason} brokenAt=${v.brokenAt}`);
    assert.equal(v.entries, 20);
  });
});
