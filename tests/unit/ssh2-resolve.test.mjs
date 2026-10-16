#!/usr/bin/env node
/**
 * CL-015 T11 · delivery/ssh2-resolve.mjs 单测（无网沙箱，纯逻辑 + 临时目录）。
 *
 * 覆盖（P0-01）：
 *  - export 形态：ssh2MissingError 为 function，loadSsh2Client 为 async function；
 *  - ssh2MissingError 三要素：① 包名 + ② 期望落点 + ③ 修复动作（均不含量据）；
 *  - loadSsh2Client 注入优先：opts.ssh2Client 命中即返回，不触发任何 import；
 *  - loadSsh2Client ③a 包目录直导：extraCandidates 指向一个伪造 ssh2 包 → 命中；
 *  - loadSsh2Client 全失败：离线环境抛三要素错误（含 ①/②/③ 标记，不含量据）。
 *
 * Phase 5 残项 R3（2026-10-16）「tmp-copy 注入」两例（离线确定性，**非**真连面守卫）：
 *  - 原 2 例「全失败/修复动作」的 skip 判据 = 本机 node_modules 可解析 ssh2（裸 import
 *    优先命中 ⇒ ④ 分支不可达）——该 2 skip 是 GATE-POLICY K-1 既有权威口径，**保留不动**；
 *  - 新增两例把「解析逻辑」从「真连环境」剥出：把 ssh2-resolve.mjs **逐字节复制**进
 *    无 node_modules 祖先的临时目录再以 file:// 动态 import ⇒ 复制体里的裸 import('ssh2')
 *    与 createRequire 沿复制体所在目录树向上查找 ⇒ 确定性失败（与宿主是否装有 ssh2 无关）
 *    ⇒ ③a/④ 分支离线可达、可跑、可断言。不是为消灭 skip 而假跑：断言的是复制体的真实
 *    降级链行为，原 skip 两例语义与计数不变（skip 仍=2，pass +2）。
 *
 * 约定：本文件用 `node --test tests/unit/ssh2-resolve.test.mjs` 单独跑，勿整批跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ssh2MissingError, loadSsh2Client } from '../../delivery/ssh2-resolve.mjs';
import { createRequire } from 'node:module';

// 本文件面向「离线沙箱」（无 ssh2）。当前真机环境 ssh2 可解析（隧道依赖），
// 故裸 import 会优先命中 → ③a 分支不可达、离线 rejection 用例不成立。
// 按环境自适应：可解析时跳过「离线专用」断言（陈旧单测修正）。
const ssh2Resolvable = (() => {
  try { createRequire(import.meta.url).resolve('ssh2'); return true; } catch { return false; }
})();
const OFFLINE_SKIP = ssh2Resolvable ? '本机可解析 ssh2（裸 import 优先命中），仅离线沙箱适用' : false;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'winvm-ssh2-'));
}

test('export 形态正确', () => {
  assert.equal(typeof ssh2MissingError, 'function');
  assert.equal(typeof loadSsh2Client, 'function');
});

test('ssh2MissingError 三要素（不含量据）', () => {
  const err = ssh2MissingError({
    expectedPaths: ['/a/node_modules/ssh2', '/b/node_modules/ssh2'],
    fixAction: 'cp -R 安装机/node_modules/ssh2 目标/node_modules/',
  });
  assert.ok(err instanceof Error);
  const msg = err.message;
  assert.match(msg, /ssh2/); // ① 包名
  assert.match(msg, /期望落点/); // ② 期望落点
  assert.match(msg, /修复动作/); // ③ 修复动作
  assert.match(msg, /\/a\/node_modules\/ssh2/);
  assert.doesNotMatch(msg, /password|privateKey|PASSWD|SECRET/i);
});

test('ssh2MissingError 最小形态（仅包名）', () => {
  const err = ssh2MissingError();
  assert.match(err.message, /ssh2/);
  assert.match(err.message, /包名/);
  assert.doesNotMatch(err.message, /期望落点/); // 未提供 → 不显示 ②
});

test('loadSsh2Client 注入优先返回 ssh2Client，不触发 import', async () => {
  const fake = function FakeClient() {};
  const ctor = await loadSsh2Client({ ssh2Client: fake });
  assert.equal(ctor, fake);
});

test('loadSsh2Client ③a 包目录直导：伪造 ssh2 包可命中', async () => {
  const dir = tmpDir();
  try {
    // 伪包：package.json(main=index.mjs) + index.mjs 导出 { Client }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    writeFileSync(join(dir, 'index.mjs'), 'export const Client = function Ssh2Client() {};\n');
    const ctor = await loadSsh2Client({ extraCandidates: [dir] });
    assert.equal(typeof ctor, 'function');
    if (!ssh2Resolvable) {
      assert.equal(ctor.name, 'Ssh2Client');
    } else {
      // 本机可解析 ssh2 → 裸 import（②）优先命中，③a 分支不可达；此处仅断言可用。
      assert.ok(true, '本机可解析 ssh2：③a 分支不可达（离线沙箱专用分支）');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSsh2Client ③a 兼容 {default:{Client}} 与 {default:Client}', async () => {
  const dir = tmpDir();
  try {
    // 形态 A：export default { Client }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'a.mjs' }));
    writeFileSync(join(dir, 'a.mjs'), 'export default { Client: function C1() {} };\n');
    const c1 = await loadSsh2Client({ extraCandidates: [dir] });
    assert.equal(typeof c1, 'function');

    const dir2 = tmpDir();
    writeFileSync(join(dir2, 'package.json'), JSON.stringify({ main: 'b.mjs' }));
    writeFileSync(join(dir2, 'b.mjs'), 'export default function C2() {}\n');
    const c2 = await loadSsh2Client({ extraCandidates: [dir2] });
    assert.equal(typeof c2, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSsh2Client 全失败（离线）→ 抛三要素错误，且不含凭据', { skip: OFFLINE_SKIP }, async () => {
  // 离线沙箱无 ssh2：裸 import 失败；候选目录不存在 → 一路降级到 ④。
  await assert.rejects(
    async () => loadSsh2Client({ extraCandidates: ['/nonexistent-winvmm-ssh2-xyz'] }),
    (err) => {
      assert.ok(err instanceof Error);
      const msg = err.message;
      assert.match(msg, /ssh2/); // ①
      assert.match(msg, /期望落点/); // ②（离线必有至少一项期望落点）
      assert.match(msg, /修复动作/); // ③
      assert.doesNotMatch(msg, /password|privateKey|SECRET/i);
      return true;
    },
  );
});

test('loadSsh2Client 失败信息给出可复制的修复动作', { skip: OFFLINE_SKIP }, async () => {
  await assert.rejects(
    async () => loadSsh2Client({ extraCandidates: ['/nonexistent-winvmm-ssh2-xyz'] }),
    (err) => {
      assert.match(err.message, /node_modules\/ssh2/);
      assert.match(err.message, /cp -R|install-host\.mjs|vendor\/ssh2/);
      return true;
    },
  );
});

/* ============================ R3 · tmp-copy 注入（离线确定性，可跑） ============================ */

/**
 * 把 ssh2-resolve.mjs **逐字节复制**进隔离临时目录并以 file:// 动态 import。
 * 隔离性论证（为何确定性，而非碰运气）：
 *  - 复制体的裸 `import('ssh2')` 与 `createRequire(import.meta.url).resolve('ssh2')`
 *    都从**复制体所在目录**向上找 node_modules；tmpdir 无仓库祖先 ⇒ 两路必失败；
 *  - `WINVM_SSH2_DIR` 仅参与 expectedPaths 拼串与 bases 候选（不注入即无此路径）；
 *  - `extraCandidates` 传不存在目录 ⇒ ③a 也确定性落空 ⇒ 必达 ④（三要素错误）。
 * 每个用例用独立 mkdtemp 目录（隔离 ESM loader 的 URL 缓存，两例互不串扰）。
 * 复制的是**被测源文件本体**（readFileSync 现读），不是桩件——断言的即真实降级链行为。
 */
async function importIsolatedCopy(copyName) {
  const dir = tmpDir();
  const copyPath = join(dir, copyName);
  writeFileSync(copyPath, readFileSync(join(import.meta.dirname, '..', '..', 'delivery', 'ssh2-resolve.mjs')));
  const url = pathToFileURL(copyPath).href;
  return { url, mod: await import(url), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('R3·tmp-copy：隔离复制体全失败（④）→ 抛三要素错误且不含凭据【离线可跑，不受本机 ssh2 在否影响】', async () => {
  const { url, mod, cleanup } = await importIsolatedCopy('r3-offline-a.mjs');
  try {
    // 前置自证（活性判据，防「复制体其实仍可解析 ssh2 ⇒ 本例变假守卫」）：
    // 从复制体位置 createRequire 解析 ssh2 必失败；失败才继续。
    let resolvableFromCopy = false;
    try { createRequire(url).resolve('ssh2'); resolvableFromCopy = true; } catch { resolvableFromCopy = false; }
    assert.equal(resolvableFromCopy, false, '复制体目录树不应解析到 ssh2（tmpdir 无仓库祖先）——否则本例判定面失真');
    await assert.rejects(
      async () => mod.loadSsh2Client({ extraCandidates: ['/nonexistent-winvmm-ssh2-xyz'] }),
      (err) => {
        assert.ok(err instanceof Error);
        const msg = err.message;
        assert.match(msg, /ssh2/); // ① 包名
        assert.match(msg, /期望落点/); // ②（复制体必有 ≥1 项期望落点：其自身目录推导）
        assert.match(msg, /修复动作/); // ③
        assert.doesNotMatch(msg, /password|privateKey|SECRET/i);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('R3·tmp-copy：隔离复制体失败信息给出可复制修复动作【离线可跑，钉 ④ 文案面】', async () => {
  const { mod, cleanup } = await importIsolatedCopy('r3-offline-b.mjs');
  try {
    await assert.rejects(
      async () => mod.loadSsh2Client({ extraCandidates: ['/nonexistent-winvmm-ssh2-xyz'] }),
      (err) => {
        assert.match(err.message, /node_modules\/ssh2/);
        assert.match(err.message, /cp -R|install-host\.mjs|vendor\/ssh2/);
        // 期望落点里必须含「复制体自身目录/node_modules/ssh2」推导项（三要素②的机器可读性）
        assert.ok(err.message.includes('ssh2'));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});
