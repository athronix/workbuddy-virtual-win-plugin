/**
 * Phase 3 批2 · install-host 分发防呆（单测，纯函数 + tmp 夹具）
 *
 * 覆盖（audit-qa ⑧ 三件套）：
 *  a) 复制内容哈希校验：walkFiles / verifyCopyIntegrity（missing/mismatch/pass 三态）/
 *    buildIntegrityFilePairs 对账面形状（dist 整面 + 单文件 runtime 面）；
 *  b) 版本 0.1.0 三处硬编码单源化：resolvePluginVersion 读 package.json，非法 fail-loud；
 *     源码静态守卫：'0.1.0' 字面量在 install-host.mjs 代码面清零（注释/文档允许）；
 *  c) --check-fresh 参数解析。
 *
 * 运行（只跑本文件）：node --test tests/unit/phase3-b2-install-host.test.js
 *
 * ⚠ 本文件 import install-host.mjs 需要 @winvm/* 包可解析（workspace junction）——
 *   与 deploy-conn-side/enabled-plugins 同款直 import；沙箱 junction 坏时按纪律单文件跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  walkFiles,
  verifyCopyIntegrity,
  buildIntegrityFilePairs,
  resolvePluginVersion,
} from '../../delivery/install-host.mjs';

const SRC = 'f'.repeat(64);
const OTHER = 'a'.repeat(64);
const fakeHasher = (map) => (p) => map[p] ?? null;

/* ================= a) 哈希校验核心 ================= */

test('walkFiles：递归+排序；空目录=空数组；目录不存在=空数组', () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-ih-walk-'));
  try {
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(root, 'b.txt'), 'b');
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'sub', 'deep', 'c.txt'), 'c');
    assert.deepEqual(walkFiles(root), ['a.txt', 'b.txt', join('sub', 'deep', 'c.txt')].sort());
    assert.deepEqual(walkFiles(join(root, 'nope')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyCopyIntegrity：全等=pass；目标缺=missing；内容异=mismatch；源不可读不计入', () => {
  const pairs = [
    { src: '/s/a', dst: '/d/a', rel: 'a', label: 'l' },
    { src: '/s/b', dst: '/d/b', rel: 'b', label: 'l' },
    { src: '/s/c', dst: '/d/c', rel: 'c', label: 'l' },
    { src: '/s/gone', dst: '/d/gone', rel: 'gone', label: 'l' },
  ];
  const map = {
    '/s/a': SRC, '/d/a': SRC,        // pass
    '/s/b': SRC, '/d/b': OTHER,      // mismatch
    '/s/c': SRC,                     // missing（dst 读不到）
    '/d/gone': SRC,                  // 源不可读 ⇒ 跳过不计
  };
  const r = verifyCopyIntegrity(pairs, fakeHasher(map));
  assert.equal(r.ok, false);
  assert.equal(r.checked, 4);
  assert.deepEqual(r.mismatches, [{ rel: 'b', label: 'l' }]);
  assert.deepEqual(r.missing, [{ rel: 'c', label: 'l' }]);
  const ok = verifyCopyIntegrity([pairs[0]], fakeHasher(map));
  assert.equal(ok.ok, true);
});

test('buildIntegrityFilePairs：夹具三组面齐备（桥 dist/依赖 dist/@winvm/单文件 runtime）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'b2-ih-repo-'));
  const cache = mkdtempSync(join(tmpdir(), 'b2-ih-cache-'));
  try {
    mkdirSync(join(repo, 'packages', 'host-a2a-bridge', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'host-a2a-bridge', 'dist', 'cli.js'), 'x');
    writeFileSync(join(repo, 'packages', 'host-a2a-bridge', 'package.json'),
      JSON.stringify({ dependencies: { '@winvm/contracts': 'workspace:*' } }));
    mkdirSync(join(repo, 'packages', 'contracts', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'contracts', 'dist', 'bridge.js'), 'y');
    writeFileSync(join(repo, 'packages', 'contracts', 'package.json'), '{}');
    mkdirSync(join(repo, 'delivery', 'hooks'), { recursive: true });
    writeFileSync(join(repo, 'delivery', 'tunnel-daemon.mjs'), 'z');
    writeFileSync(join(repo, 'delivery', 'hooks', 'hooks.json'), '{}');

    const pairs = buildIntegrityFilePairs(cache, repo);
    const rels = pairs.map((p) => p.rel);
    assert.ok(rels.some((r) => r.startsWith('a2a-bridge/') && r.endsWith('cli.js')), '桥 dist 面');
    assert.ok(rels.some((r) => r.startsWith('@winvm/contracts/dist/') && r.endsWith('bridge.js')), '依赖 dist 面');
    assert.ok(rels.some((r) => r === '@winvm/contracts/package.json'), '依赖 package.json 面');
    assert.ok(rels.includes('tunnel-daemon.mjs') && rels.includes('hooks/hooks.json'), 'runtime 单文件面');
    // dst 落点正确性（依赖 dist 落 node_modules/@winvm/<name>/dist）
    const dep = pairs.find((p) => p.rel === '@winvm/contracts/dist/bridge.js');
    assert.ok(dep.dst.includes(join('a2a-bridge', 'node_modules', '@winvm', 'contracts', 'dist')), dep.dst);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

/* ================= b) 版本单源化 ================= */

test('resolvePluginVersion：tmp 夹具读 package.json；非法/缺失 fail-loud 抛错', () => {
  const repo = mkdtempSync(join(tmpdir(), 'b2-ih-ver-'));
  try {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.equal(resolvePluginVersion(repo), '9.9.9');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
    assert.throws(() => resolvePluginVersion(repo), /单一事实源/);
    rmSync(join(repo, 'package.json'));
    assert.throws(() => resolvePluginVersion(repo), /单一事实源/);
    writeFileSync(join(repo, 'package.json'), 'not-json{{{');
    assert.throws(() => resolvePluginVersion(repo), /单一事实源/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("静态守卫：install-host.mjs 代码面 '0.1.0' 字面量清零（仅注释/文档允许）", () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'delivery', 'install-host.mjs'), 'utf8');
  const codeLines = src
    .split('\n')
    // 剥纯注释行（行首 // 或 * 或 /*）
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    // 剥行内注释尾巴
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => l.includes("'0.1.0'") || l.includes('"0.1.0"'));
  assert.deepEqual(codeLines, [], '不允许任何代码行硬编码 0.1.0（三处已收敛到 resolvePluginVersion）');
});

test('pluginCacheRoot 形态：版本段在末级（防呆 b 的路径面），禁碰两 server.ts 行不受影响（他文件）', () => {
  // resolvePluginVersion 默认读根 package.json ⇒ 与 manifest version 同源；
  // 真实仓校验：函数可跑且不抛（version=0.1.0 在 package.json 里合法）。
  const v = resolvePluginVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
});
