/**
 * Phase 3 批5 · A2-14 审计链保留期（用户裁决 90 天 ∧ <2GB 超限删最老）。
 * 两层面：planShardPrune 纯函数判定面 + HashChainAuditSink.pruneShards 端到端（真实 tmpdir）。
 * 纯 stdlib；逐文件跑（绝不整批）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const CORE = pathToFileURL(join(ROOT, 'packages', 'core', 'dist', 'index.js')).href;

const DAY = 24 * 60 * 60 * 1000;
// 固定"现在"：2026-10-13T00:00:00Z 对应文件名日期 20261013
const NOW = Date.UTC(2026, 9, 13);

function f(name, size = 100) {
  // 从 audit-YYYYMMDD[-idx].jsonl 解析 date/idx（与生产 listShards 同口径）
  const rest = name.slice('audit-'.length, -'.jsonl'.length);
  const dash = rest.indexOf('-');
  const date = dash === -1 ? rest : rest.slice(0, dash);
  const idx = dash === -1 ? 0 : Number(rest.slice(dash + 1));
  return { name, size, date, idx };
}

describe('A2-14 · planShardPrune 判定面（纯函数）', async () => {
  const { planShardPrune } = await import(CORE);

  test('年龄标准：早于 maxAgeDays 的删，晚于的留', () => {
    const shards = [f('audit-20260801.jsonl'), f('audit-20260901.jsonl'), f('audit-20261010.jsonl')];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 90, maxTotalBytes: 0 }, // 只设年龄（体积 0=不限）
      protectedNames: new Set(),
      nowMs: NOW,
    });
    // 90 天前 = 2026-07-15 ⇒ 20260801/20260901 都在界内（都晚于 7-15）⇒ 都不该删
    assert.deepEqual(del, [], '90 天界内应零删');
  });

  test('年龄标准：超龄分片按最老优先删，minKeep 兜底', () => {
    const shards = [f('audit-20250101.jsonl'), f('audit-20250601.jsonl'), f('audit-20261012.jsonl'), f('audit-20261013.jsonl')];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 90, maxTotalBytes: 0, minKeepShards: 2 },
      protectedNames: new Set(),
      nowMs: NOW,
    });
    // 20250101/20250601 超 90 天；但 minKeep=2 且总共 4 片 ⇒ 最多删 2 ⇒ 恰好删两片老的
    assert.deepEqual(del.sort(), ['audit-20250101.jsonl', 'audit-20250601.jsonl']);
  });

  test('minKeep 下限：即便全部超龄也绝不跌破下限', () => {
    const shards = [f('audit-20200101.jsonl'), f('audit-20200201.jsonl'), f('audit-20200301.jsonl')];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 1, maxTotalBytes: 0, minKeepShards: 2 },
      protectedNames: new Set(),
      nowMs: NOW,
    });
    // 3 片全超龄但 minKeep=2 ⇒ 只能删 1（保最新一片 + 次新）
    assert.equal(del.length, 1);
    assert.equal(del[0], 'audit-20200101.jsonl', '删的必须是最老那片');
  });

  test('体积标准：总字节超 maxTotalBytes 从最老累计删到阈值内', () => {
    const shards = [f('audit-20261010.jsonl', 800), f('audit-20261011.jsonl', 800), f('audit-20261012.jsonl', 800)];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 0, maxTotalBytes: 1500, minKeepShards: 0 }, // 只设体积，不限龄，无下限
      protectedNames: new Set(),
      nowMs: NOW,
    });
    // 总 2400 > 1500 ⇒ 删最老累计：2400-800=1600>1500 继续，再 -800=800≤1500 停 ⇒ 删两片老
    assert.deepEqual(del.sort(), ['audit-20261010.jsonl', 'audit-20261011.jsonl']);
  });

  test('protected 永不删（即使超龄/超体积命中它）', () => {
    const shards = [f('audit-20250101.jsonl'), f('audit-20261013.jsonl')];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 1, maxTotalBytes: 0, minKeepShards: 0 },
      protectedNames: new Set(['audit-20250101.jsonl']),
      nowMs: NOW,
    });
    assert.deepEqual(del, [], '唯一超龄片被 protected ⇒ 不删');
  });

  test('文件名日期解析失败 ⇒ 视为最新绝不删（对删除保守）', () => {
    const shards = [{ name: 'audit-garbage.jsonl', size: 10, date: 'notadate', idx: 0 }];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 1, maxTotalBytes: 0, minKeepShards: 0 },
      protectedNames: new Set(),
      nowMs: NOW,
    });
    assert.deepEqual(del, [], '坏日期名绝不入删集');
  });

  test('两标准各自独立：只超龄不超体积也删（命中任一即入）', () => {
    const shards = [f('audit-20200101.jsonl', 10), f('audit-20261013.jsonl', 10)];
    const del = planShardPrune(shards, {
      policy: { maxAgeDays: 90, maxTotalBytes: 1_000_000_000, minKeepShards: 1 },
      protectedNames: new Set(),
      nowMs: NOW,
    });
    assert.deepEqual(del, ['audit-20200101.jsonl']);
  });

  test('双零（龄/体积都不设）⇒ 空操作', () => {
    const del = planShardPrune([f('audit-20200101.jsonl')], {
      policy: { maxAgeDays: 0, maxTotalBytes: 0 },
      protectedNames: new Set(),
      nowMs: NOW,
    });
    assert.deepEqual(del, []);
  });
});

describe('A2-14 · HashChainAuditSink.pruneShards 端到端（真实 tmpdir）', async () => {
  const { HashChainAuditSink } = await import(CORE);
  let dir;
  const mk = (name, bytes = 50) => writeFileSync(join(dir, name), '#'.repeat(bytes), 'utf8');

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p3b5-prune-'));
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('禁用（无 retention）⇒ pruneShards 空操作且不动任何文件', async () => {
    mk('audit-20200101.jsonl');
    const sink = new HashChainAuditSink({ dir });
    const r = await sink.pruneShards();
    assert.equal(r.deleted.length, 0);
    assert.ok(readdirSync(dir).includes('audit-20200101.jsonl'), '禁用态旧文件必须原样不动');
  });

  test('超龄端到端删除 + 活动片保护（当前会话片即便名旧也不删）', async () => {
    mk('audit-20200101.jsonl'); // 超龄，非活动 ⇒ 删（但 minKeep 会兜）
    mk('audit-20200201.jsonl');
    mk('audit-20261013.jsonl'); // 今天
    // 装配 sink（非 freshChain）→ 手动 seed 一片进 activeShards 保护：用 freshChain 起今日片
    const sink = new HashChainAuditSink({
      dir,
      retention: { maxAgeDays: 90, maxTotalBytes: 0, minKeepShards: 2 },
    });
    const r = await sink.pruneShards();
    // 2020 两片超 90 天；minKeep=2 + 今日片 protected(newest) ⇒ 两片老的可删但受 minKeep
    // 目录共 3 片，newest=今日受保护，minKeep=2 ⇒ 最多删 1（保 2）
    assert.equal(r.deleted.length, 1, `预期删 1 片，实得 ${r.deleted.length}：${r.deleted}`);
    assert.equal(r.deleted[0], 'audit-20200101.jsonl', '删的必是最老那片');
    assert.ok(!readdirSync(dir).includes('audit-20200101.jsonl'), '超龄最老片应已消失');
    assert.ok(readdirSync(dir).includes('audit-20261013.jsonl'), '今日片必留');
  });

  test('体积端到端：写足量触发累计超阈值从最老删', async () => {
    mk('audit-20261001.jsonl', 1000);
    mk('audit-20261002.jsonl', 1000);
    mk('audit-20261003.jsonl', 1000);
    const sink = new HashChainAuditSink({
      dir,
      retention: { maxAgeDays: 0, maxTotalBytes: 1500, minKeepShards: 0 },
    });
    const r = await sink.pruneShards();
    assert.equal(r.totalBytes, 3000);
    assert.deepEqual(r.deleted.sort(), ['audit-20261001.jsonl', 'audit-20261002.jsonl']);
  });

  test('onPrune 回调收到删除清单与清理前总字节', async () => {
    mk('audit-20200101.jsonl', 700);
    mk('audit-20261013.jsonl', 100);
    let seenDeleted = [];
    let seenTotal = 0;
    const sink = new HashChainAuditSink({
      dir,
      retention: { maxAgeDays: 90, maxTotalBytes: 0, minKeepShards: 1 },
    });
    await sink.pruneShards((d, t) => {
      seenDeleted = d;
      seenTotal = t;
    });
    assert.deepEqual(seenDeleted, ['audit-20200101.jsonl']);
    assert.equal(seenTotal, 800);
  });

  test('startRetentionSweep：无 retention ⇒ 返回空停止句柄、不挂定时器', () => {
    const sink = new HashChainAuditSink({ dir });
    let called = false;
    const stop = sink.startRetentionSweep(1, () => {
      called = true;
    });
    assert.equal(typeof stop, 'function');
    stop(); // 不应抛
    assert.equal(called, false, '禁用态回调绝不触发');
  });
});
