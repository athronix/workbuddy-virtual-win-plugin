#!/usr/bin/env node
/**
 * path-util.mjs 单测：覆盖 applyPathOp 的 add/remove 幂等与精确匹配，
 * 锁住「卸载时仅移除精确条目、不误删含该目录名的其它路径」这一回归点。
 * 不触碰系统 PATH（只测纯函数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPathOp, normalizePathEntry } from '../../delivery/path-util.mjs';

test('normalizePathEntry 去尾斜杠与空白', () => {
  assert.equal(normalizePathEntry('C:\\a\\b\\'), 'C:\\a\\b');
  assert.equal(normalizePathEntry('C:/a/b/'), 'C:/a/b');
  assert.equal(normalizePathEntry('  C:\\a\\b  '), 'C:\\a\\b');
});

test('add：追加新目录', () => {
  const r = applyPathOp('C:\\Windows;C:\\Users', 'C:\\MyApp', 'add');
  assert.equal(r, 'C:\\Windows;C:\\Users;C:\\MyApp');
});

test('add：已存在则幂等（原样返回）', () => {
  const cur = 'C:\\Windows;C:\\MyApp';
  const r = applyPathOp(cur, 'C:\\MyApp', 'add');
  assert.equal(r, cur);
});

test('add：尾斜杠差异视为同一项（不重复追加）', () => {
  const cur = 'C:\\Windows;C:\\MyApp\\';
  const r = applyPathOp(cur, 'C:\\MyApp', 'add');
  assert.equal(r, cur);
});

test('add：空 PATH 直接成为唯一项', () => {
  assert.equal(applyPathOp('', 'C:\\MyApp', 'add'), 'C:\\MyApp');
  assert.equal(applyPathOp(null, 'C:\\MyApp', 'add'), 'C:\\MyApp');
});

test('remove：精确剔除相等条目', () => {
  const r = applyPathOp('C:\\Windows;C:\\MyApp;C:\\Users', 'C:\\MyApp', 'remove');
  assert.equal(r, 'C:\\Windows;C:\\Users');
});

test('remove：尾斜杠差异仍能精确匹配剔除', () => {
  const r = applyPathOp('C:\\Windows;C:\\MyApp\\', 'C:\\MyApp', 'remove');
  assert.equal(r, 'C:\\Windows');
});

test('remove：不含该目录则原样返回（不误删）', () => {
  const cur = 'C:\\Windows;C:\\MyAppData;C:\\Users';
  const r = applyPathOp(cur, 'C:\\MyApp', 'remove');
  // 关键回归点：不能把 C:\MyAppData（含子串 MyApp）误删
  assert.equal(r, cur);
});

test('remove：空 PATH 安全返回空', () => {
  assert.equal(applyPathOp('', 'C:\\MyApp', 'remove'), '');
});
