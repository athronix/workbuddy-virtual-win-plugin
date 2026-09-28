#!/usr/bin/env node
/**
 * path-util.mjs 单测：覆盖 applyPathOp 的 add/remove 幂等与精确匹配，
 * 锁住「卸载时仅移除精确条目、不误删含该目录名的其它路径」这一回归点。
 * 不触碰系统 PATH（只测纯函数）。
 *
 * 平台适配（T08）：applyPathOp 的分隔符随平台（Windows ';'，POSIX ':'），
 * 故样例目录/分隔符按 process.platform 选取——避免在鸿蒙宿主上把 Windows
 * 盘符路径（含 ':'）误当分隔符解析。原回归语义（精确匹配/尾斜杠容忍/空串）
 * 在两种平台下均保持。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPathOp, normalizePathEntry } from '../../delivery/path-util.mjs';

const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? ';' : ':';
// 平台样例目录：Windows 用盘符路径，POSIX 用 '/' 路径
const A = IS_WIN ? 'C:\\Windows' : '/usr/bin';
const B = IS_WIN ? 'C:\\Users' : '/home/u';
const MINE = IS_WIN ? 'C:\\MyApp' : '/opt/myapp';
const MINE_DATA = IS_WIN ? 'C:\\MyAppData' : '/opt/myappdata';
const j = (...p) => p.join(SEP);

test('normalizePathEntry 去尾斜杠与空白', () => {
  assert.equal(normalizePathEntry('C:\\a\\b\\'), 'C:\\a\\b');
  assert.equal(normalizePathEntry('C:/a/b/'), 'C:/a/b');
  assert.equal(normalizePathEntry('  C:\\a\\b  '), 'C:\\a\\b');
});

test('add：追加新目录', () => {
  const r = applyPathOp(j(A, B), MINE, 'add');
  assert.equal(r, j(A, B, MINE));
});

test('add：已存在则幂等（原样返回）', () => {
  const cur = j(A, MINE);
  const r = applyPathOp(cur, MINE, 'add');
  assert.equal(r, cur);
});

test('add：尾斜杠差异视为同一项（不重复追加）', () => {
  const cur = j(A, MINE + '/');
  const r = applyPathOp(cur, MINE, 'add');
  assert.equal(r, cur);
});

test('add：空 PATH 直接成为唯一项', () => {
  assert.equal(applyPathOp('', MINE, 'add'), MINE);
  assert.equal(applyPathOp(null, MINE, 'add'), MINE);
});

test('remove：精确剔除相等条目', () => {
  const r = applyPathOp(j(A, MINE, B), MINE, 'remove');
  assert.equal(r, j(A, B));
});

test('remove：尾斜杠差异仍能精确匹配剔除', () => {
  const r = applyPathOp(j(A, MINE + '/'), MINE, 'remove');
  assert.equal(r, A);
});

test('remove：不含该目录则原样返回（不误删）', () => {
  const cur = j(A, MINE_DATA, B);
  const r = applyPathOp(cur, MINE, 'remove');
  // 关键回归点：不能把 MyAppData（含子串 MyApp）误删
  assert.equal(r, cur);
});

test('remove：空 PATH 安全返回空', () => {
  assert.equal(applyPathOp('', MINE, 'remove'), '');
});
