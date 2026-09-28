#!/usr/bin/env node
/**
 * CL-015 T14 · delivery/deploy-winvm-plugin.mjs 生成的 POSIX 启动器单测（无网沙箱）。
 *
 * 覆盖（P1-01 / G4）：
 *  - 非 Windows（鸿蒙/Linux/macOS）宿主：生成 shebang=#!/bin/sh 的 POSIX 启动器，
 *    体用参数展开求脚本目录、再以 exec 调用 node 拉起同目录 winvm-plugin.mjs（不依赖外部 dirname）；
 *  - Windows 宿主：不生成 POSIX 启动器，改生成 .cmd（路径字节不变，D6）；
 *  - 附带文件（extraFiles）随启动器一并落地（G3）；
 *  - .winvm-context.json 写入 side=host（writeContext=true）。
 *
 * 约定：本文件用 `node --test tests/unit/launcher-posix.test.mjs` 单独跑，勿整批跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deployWinvmPlugin } from '../../delivery/deploy-winvm-plugin.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'winvm-launcher-'));
}

const EXTRA = ['oh-tunnel.mjs', 'ssh2-resolve.mjs', 'tunnel-daemon.mjs'];

test('POSIX 启动器：shebang=#!/bin/sh 且体为纯 POSIX（非 Windows）', () => {
  if (process.platform === 'win32') {
    // Windows 宿主走 .cmd 分支，此处跳过 POSIX 断言（见下一用例）
    return;
  }
  const dir = tmpDir();
  try {
    deployWinvmPlugin({
      targetDir: dir,
      side: 'host',
      dryRun: false,
      writeContext: true,
      extraFiles: EXTRA,
    });
    const launcher = join(dir, 'winvm-plugin');
    assert.ok(existsSync(launcher), 'POSIX 启动器 winvm-plugin 应存在');
    const text = readFileSync(launcher, 'utf8');
    const lines = text.split('\n');
    assert.equal(lines[0], '#!/bin/sh', 'shebang 应为 #!/bin/sh');
    assert.match(text, /case "\$0" in \*\/\*\) d=\$\{0%\/\*\};; \*\) d=\.;; esac/);
    assert.match(text, /exec "\$\{WINVM_NODE:-node\}" "\$d\/winvm-plugin\.mjs" "\$@"/);
    // 纯 POSIX：不得含 bashism（source / 数组 / [[ ）
    assert.doesNotMatch(text, /\bsource\b|\[\[/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows 宿主：生成 .cmd 启动器（POSIX 启动器仅非 Windows 才生成）', () => {
  const dir = tmpDir();
  try {
    deployWinvmPlugin({
      targetDir: dir,
      side: 'host',
      dryRun: false,
      writeContext: true,
      extraFiles: EXTRA,
    });
    if (process.platform === 'win32') {
      assert.ok(existsSync(join(dir, 'winvm-plugin.cmd')), 'Windows 应生成 .cmd');
    } else {
      assert.equal(existsSync(join(dir, 'winvm-plugin.cmd')), false, '非 Windows 不应生成 .cmd');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('附带文件（G3）随启动器落地', () => {
  const dir = tmpDir();
  try {
    deployWinvmPlugin({
      targetDir: dir,
      side: 'host',
      dryRun: false,
      writeContext: true,
      extraFiles: EXTRA,
    });
    for (const rel of EXTRA) {
      assert.ok(existsSync(join(dir, rel)), `附带文件 ${rel} 应已复制`);
    }
    // 主脚本也应在
    assert.ok(existsSync(join(dir, 'winvm-plugin.mjs')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.winvm-context.json 写入 side=host', () => {
  const dir = tmpDir();
  try {
    deployWinvmPlugin({ targetDir: dir, side: 'host', dryRun: false, writeContext: true, extraFiles: EXTRA });
    const ctx = JSON.parse(readFileSync(join(dir, '.winvm-context.json'), 'utf8'));
    assert.equal(ctx.side, 'host');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run 不写盘（仅预览）', () => {
  const dir = tmpDir();
  try {
    deployWinvmPlugin({ targetDir: dir, side: 'host', dryRun: true, writeContext: true, extraFiles: EXTRA });
    const files = readdirSync(dir);
    assert.equal(files.length, 0, 'dry-run 不应在目标目录产生任何文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
