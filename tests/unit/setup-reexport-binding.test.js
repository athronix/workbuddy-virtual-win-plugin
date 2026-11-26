/**
 * setup-reexport-binding.test.js — 守住「re-export 不等于建立本地绑定」这一类缺陷
 *
 * 背景（2026-11-26 真机实证 / I-38.6）：
 *   阶段 5.1（部署解耦）把私钥探测链从 setup.mjs 下沉到 connect-channel.mjs，
 *   setup.mjs 改成 `export { resolveTunnelIdentityFile } from './connect-channel.mjs';`
 *   —— 语法合法、符号也在文件里、连 `import * as m` 都能拿到它，
 *   于是 vnext-build-artifacts 那条「符号存在」断言 PASS。
 *   但 `export ... from` **只在导出表挂名，不建立模块内绑定**，
 *   而 setup.mjs 内部两处（ssh2Creds / OH 宿主隧道分支）直接调用它
 *   ⇒ 真机跑到 4a prepare-vm 时 `ReferenceError: resolveTunnelIdentityFile is not defined`。
 *
 * 本测试的判据全部是**行为性**的（加载 + 实调），故意不查字符串：
 *   查子串类判据对本缺陷完全无效 —— 缺陷代码里符号恰恰「存在」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SETUP = resolve(ROOT, 'delivery/setup.mjs');

describe('setup.mjs 与 connect-channel.mjs 的符号绑定', () => {
  test('① setup.mjs 导出的 resolveTunnelIdentityFile 可实际调用并返回合法结构', async () => {
    const mod = await import(pathToFileURL(SETUP).href);
    assert.equal(typeof mod.resolveTunnelIdentityFile, 'function',
      'setup.mjs 必须导出 resolveTunnelIdentityFile 函数');
    const r = mod.resolveTunnelIdentityFile();
    assert.ok(r && typeof r === 'object', '返回值必须是对象');
    assert.ok('identityFile' in r, '返回值必须含 identityFile 字段');
    assert.ok(['env', 'default', 'none'].includes(r.source),
      `source 必须是 env|default|none，实际=${r.source}`);
  });

  test('② setup.mjs 与 connect-channel.mjs 解析结果必须完全一致（同一事实源）', async () => {
    const [a, b] = await Promise.all([
      import(pathToFileURL(SETUP).href),
      import(pathToFileURL(resolve(ROOT, 'delivery/connect-channel.mjs')).href),
    ]);
    assert.deepEqual(a.resolveTunnelIdentityFile(), b.resolveTunnelIdentityFile(),
      '两者必须指向同一实现（阶段 5.1 下沉后 connect-channel 是唯一事实源）');
  });

  test('③ ★ 源码层面：凡在模块体内调用该符号，就必须有 import 绑定', () => {
    const src = readFileSync(SETUP, 'utf8');
    // 剥注释（防「注释里写了 import」凑数）
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    const hasImport = /^\s*import\s*\{[^}]*\bresolveTunnelIdentityFile\b[^}]*\}\s*from\s*['"]\.\/connect-channel\.mjs['"]/m
      .test(stripped);
    // 模块体内的调用行（排除 import/export 语句行）
    const callLines = stripped.split('\n')
      .filter((l) => /\bresolveTunnelIdentityFile\s*\(/.test(l))
      .filter((l) => !/^\s*(import|export)\b/.test(l));

    if (callLines.length > 0) {
      assert.ok(hasImport,
        `文件内有 ${callLines.length} 处 resolveTunnelIdentityFile() 调用，但缺少 import 绑定。`
        + `\n仅用 \`export { X } from './m.js'\` 不会建立模块内绑定，调用时会 ReferenceError（I-38.6）。`
        + `\n调用行：${callLines.map((l) => l.trim()).join(' | ')}`);
    }
  });

  test('④ ★ 突变反证：删掉 import 后，行为判据必须变红（证明本测试真的能抓到这个缺陷）', async () => {
    const src = readFileSync(SETUP, 'utf8');
    // 复现缺陷形态：把 import 行整行删除，只剩 `export { X };`
    const mutated = src.replace(
      /^\s*import\s*\{[^}]*\bresolveTunnelIdentityFile\b[^}]*\}\s*from\s*['"]\.\/connect-channel\.mjs['"];?\s*$/m,
      '// MUTATED: import removed to reproduce I-38.6',
    );
    assert.notEqual(mutated, src, '突变必须真的改到源码（否则下面断言无意义）');

    // 写进临时目录再加载：此时 `export { X };` 因无绑定 ⇒ 加载期 SyntaxError
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'setupprobe-'));
    const target = join(dir, 'setup.mjs');
    // 依赖相对路径，拷一份 connect-channel 过去
    writeFileSync(target, mutated);
    writeFileSync(join(dir, 'connect-channel.mjs'), readFileSync(resolve(ROOT, 'delivery/connect-channel.mjs'), 'utf8'));
    try {
      await assert.rejects(
        () => import(pathToFileURL(target).href),
        (e) => e instanceof SyntaxError || e instanceof ReferenceError,
        '删掉 import 后模块必须加载失败（SyntaxError: Export ... is not defined）或调用时报 ReferenceError',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});