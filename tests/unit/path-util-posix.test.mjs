#!/usr/bin/env node
/**
 * path-util.mjs · POSIX（鸿蒙/Linux/macOS）分支单测（T08 / P0-R5）
 *
 * 覆盖：
 *  ① applyPathOp 在非 win32 平台用 ':' 分隔（本机 process.platform==='openharmony'），add/remove 幂等；
 *  ② setProfilePathRaw 的 shell profile 落地：
 *     - add：写 ~/.workbuddy/winvm/shell-init.sh（单行 export PATH="<dir>:$PATH"）
 *            并在 ~/.bashrc / ~/.profile 追加标记块；二次 add 不再变更（幂等）；
 *     - remove：清理干净（shell-init.sh 仅剩该行时删文件；profile 标记块摘除、文件本身保留）；
 *  ③ addToUserPath/removeFromUserPath 在 POSIX 委托给 profile 分支。
 *
 * 隔离：**在动态 import() 之前**把 process.env.HOME 指向 mkdtemp 临时目录，
 *       因为 POSIX 的 os.homedir() 会读取 $HOME；测试结束恢复并清理临时目录。
 * 注：若在 win32 上运行，①③ 自动跳过（POSIX 分支不适用）。
 *
 * 约定：本文件用 `node --test tests/unit/path-util-posix.test.mjs` 单独跑。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IS_WIN = process.platform === 'win32';

// —— 关键：先改 HOME，再动态 import（homedir() 在调用期读 $HOME）——
const HOME_TMP = mkdtempSync(join(tmpdir(), 'winvm-posix-home-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = HOME_TMP;

const {
  applyPathOp,
  setProfilePathRaw,
  getProfilePathRaw,
  // POSIX 委托入口（addToUserPath 在 win32 会走 PowerShell，故仅非 win32 断言）
  addToUserPath,
  removeFromUserPath,
} = await import('../../delivery/path-util.mjs');

const SHELL_INIT = join(HOME_TMP, '.workbuddy', 'winvm', 'shell-init.sh');
const BASHRC = join(HOME_TMP, '.bashrc');
const PROFILE = join(HOME_TMP, '.profile');
const MARKER = '# WinVM Bridge PATH';

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  rmSync(HOME_TMP, { recursive: true, force: true });
});

/* ------------------------------ ① applyPathOp POSIX 分隔符 ------------------------------ */

test('applyPathOp：非 win32 平台用 ":" 分隔，add 追加且幂等', { skip: IS_WIN }, () => {
  const a = '/usr/bin';
  const b = '/opt/tools';
  const added = applyPathOp(`${a}:${b}`, '/opt/myapp', 'add');
  assert.equal(added, `${a}:${b}:/opt/myapp`);
  // 幂等：已存在则原样返回
  assert.equal(applyPathOp(added, '/opt/myapp', 'add'), added);
});

test('applyPathOp：非 win32 平台 remove 精确剔除、不误删子串', { skip: IS_WIN }, () => {
  const cur = '/usr/bin:/opt/myapp:/opt/tools';
  assert.equal(applyPathOp(cur, '/opt/myapp', 'remove'), '/usr/bin:/opt/tools');
  // 关键回归点：/opt/myappdata 含子串 myapp，但不能被误删
  const cur2 = '/usr/bin:/opt/myappdata';
  assert.equal(applyPathOp(cur2, '/opt/myapp', 'remove'), cur2);
});

/* ------------------------------ ② setProfilePathRaw ------------------------------ */

test('setProfilePathRaw(add)：写 shell-init.sh + profile 标记块，二次 add 幂等', () => {
  const dir = '/opt/winvm-bridge'; // 无尾随斜杠
  const changed1 = setProfilePathRaw(dir, { op: 'add' });
  assert.equal(changed1, true, '首次 add 应报告变更');

  // shell-init.sh：单行 export
  assert.equal(existsSync(SHELL_INIT), true, '应创建 shell-init.sh');
  const init = readFileSync(SHELL_INIT, 'utf8');
  assert.ok(init.includes(`export PATH="${dir}:$PATH"`), `shell-init.sh 应含 export PATH="${dir}:$PATH"`);
  assert.equal(getProfilePathRaw(dir), init, 'getProfilePathRaw 应回读同一内容');

  // profile：标记块（标记行 + source 行）
  for (const f of [BASHRC, PROFILE]) {
    assert.equal(existsSync(f), true, `应创建 ${f}`);
    const c = readFileSync(f, 'utf8');
    assert.ok(c.includes(MARKER), `${f} 应含标记块 ${MARKER}`);
    // G4（CL-015/P1-01）修正：改用 POSIX 内建 `.` 并引 $HOME（兼容 /bin/sh），
    // 不再写 bashism `source ~/...`。断言已同步更新（陈旧单测修正）。
    assert.ok(c.includes('. "$HOME/.workbuddy/winvm/shell-init.sh"'), `${f} 应 . "$HOME/.workbuddy/winvm/shell-init.sh"`);
  }

  // 幂等：二次 add 不再变更，内容原样
  const snapshot = [readFileSync(SHELL_INIT, 'utf8'), readFileSync(BASHRC, 'utf8'), readFileSync(PROFILE, 'utf8')];
  const changed2 = setProfilePathRaw(dir, { op: 'add' });
  assert.equal(changed2, false, '二次 add 应报告无变更');
  assert.deepEqual(
    [readFileSync(SHELL_INIT, 'utf8'), readFileSync(BASHRC, 'utf8'), readFileSync(PROFILE, 'utf8')],
    snapshot,
    '二次 add 不应改写任何文件',
  );
});

test('setProfilePathRaw(remove)：清理干净——shell-init.sh 仅剩该行则删文件，profile 标记块摘除', () => {
  const dir = '/opt/winvm-bridge';
  // 保底：确保已 add（前面用例已 add，这里再确保一次）
  setProfilePathRaw(dir, { op: 'add' });

  const changed = setProfilePathRaw(dir, { op: 'remove' });
  assert.equal(changed, true, 'remove 应报告变更');

  // shell-init.sh 仅含该行 → 删除整个文件
  assert.equal(existsSync(SHELL_INIT), false, 'shell-init.sh 仅剩该行时应删除文件');
  assert.equal(getProfilePathRaw(dir), '', 'getProfilePathRaw 应返回空');

  // profile 文件保留（可能是用户既有），但标记块已摘除
  for (const f of [BASHRC, PROFILE]) {
    const c = existsSync(f) ? readFileSync(f, 'utf8') : '';
    assert.ok(!c.includes(MARKER), `${f} 标记块应被摘除`);
    assert.ok(!c.includes('shell-init.sh'), `${f} 不应残留悬空 source 行`);
  }

  // 幂等：再次 remove 无变更
  assert.equal(setProfilePathRaw(dir, { op: 'remove' }), false, '二次 remove 应报告无变更');
});

test('setProfilePathRaw(remove)：保留用户既有 profile 内容（仅摘本插件块）', () => {
  const dir = '/opt/winvm-bridge-2';
  writeFileSync(BASHRC, 'export EDITOR=vim\n', 'utf8'); // 用户既有内容
  setProfilePathRaw(dir, { op: 'add' });
  assert.ok(readFileSync(BASHRC, 'utf8').includes('export EDITOR=vim'));
  setProfilePathRaw(dir, { op: 'remove' });
  const after = readFileSync(BASHRC, 'utf8');
  assert.ok(after.includes('export EDITOR=vim'), '用户既有内容应保留');
  assert.ok(!after.includes(MARKER), '本插件标记块应被摘除');
});

/* ------------------------------ ③ addToUserPath / removeFromUserPath 委托 ------------------------------ */

test('addToUserPath/removeFromUserPath：POSIX 委托 profile 分支（幂等）', { skip: IS_WIN }, () => {
  const dir = '/opt/winvm-delegate';
  assert.equal(addToUserPath(dir, { dryRun: false }), true, '首次加入应变更');
  assert.equal(addToUserPath(dir, { dryRun: false }), false, '再次加入应幂等');
  assert.equal(removeFromUserPath(dir, { dryRun: false }), true, '移除应变更');
  assert.equal(removeFromUserPath(dir, { dryRun: false }), false, '再次移除应幂等');
});

test('dry-run：不写盘但报告「将变更」', { skip: IS_WIN }, () => {
  const dir = '/opt/winvm-dry';
  assert.equal(addToUserPath(dir, { dryRun: true }), true, 'dry-run 应报告将变更');
  assert.equal(existsSync(SHELL_INIT), false, 'dry-run 不应创建 shell-init.sh');
});
