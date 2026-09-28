#!/usr/bin/env node
/**
 * T06 · delivery/account-resolve.mjs 单测（无网沙箱，纯文件系统 + 临时目录）。
 *
 * 覆盖（P0-R3 / P1-R9）：
 *  - 导出形态：resolveAccountIds 为 function，KNOWN_ACTIVE_ACCOUNT 为 uuid 字符串；
 *  - connectors 目录不存在时不抛错，返回 [KNOWN_ACTIVE_ACCOUNT]（
 *    宿主机=鸿蒙场景该目录由安装自动创建）；
 *  - override（--account / WINVM_ACCOUNT）优先级最高：只返回 [override]；
 *  - 遍历 connectors/ 下所有子目录做兜底、去重，且已知活跃 uuid 恒在首位；
 *  - 非目录（普通文件）被忽略。
 *
 * 约定：本文件用 `node --test tests/unit/account-resolve.test.mjs` 单独跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAccountIds, KNOWN_ACTIVE_ACCOUNT } from '../../delivery/account-resolve.mjs';

/** 建临时「宿主根」，返回其路径；调用方负责 rmSync。 */
function mkHostRoot() {
  return mkdtempSync(join(tmpdir(), 'winvm-acct-'));
}

test('导出形态正确', () => {
  assert.equal(typeof resolveAccountIds, 'function');
  assert.equal(typeof KNOWN_ACTIVE_ACCOUNT, 'string');
  assert.match(KNOWN_ACTIVE_ACCOUNT, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('connectors 目录不存在时不抛错，返回已知活跃账户', () => {
  const root = mkHostRoot();
  try {
    const ids = resolveAccountIds(root);
    assert.deepEqual(ids, [KNOWN_ACTIVE_ACCOUNT]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('override 优先级最高，仅返回该账户', () => {
  const root = mkHostRoot();
  try {
    mkdirSync(join(root, 'connectors', 'default'), { recursive: true });
    assert.deepEqual(resolveAccountIds(root, 'acct-x'), ['acct-x']);
    assert.deepEqual(resolveAccountIds(root, KNOWN_ACTIVE_ACCOUNT), [KNOWN_ACTIVE_ACCOUNT]);
    // 空字符串视为「未指定」，退回默认解析
    assert.equal(resolveAccountIds(root, '')[0], KNOWN_ACTIVE_ACCOUNT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('遍历 connectors 下所有目录、已知活跃 uuid 在首位且去重', () => {
  const root = mkHostRoot();
  try {
    const conn = join(root, 'connectors');
    mkdirSync(join(conn, 'default'), { recursive: true });
    mkdirSync(join(conn, KNOWN_ACTIVE_ACCOUNT), { recursive: true });
    mkdirSync(join(conn, 'extra-acc'), { recursive: true });
    // 非目录项应被忽略
    writeFileSync(join(conn, 'README.md'), 'x');

    const ids = resolveAccountIds(root);
    assert.equal(ids[0], KNOWN_ACTIVE_ACCOUNT, '已知活跃 uuid 恒在首位');
    assert.ok(ids.includes('default'));
    assert.ok(ids.includes('extra-acc'));
    assert.ok(!ids.includes('README.md'), '非目录被忽略');
    assert.equal(new Set(ids).size, ids.length, '无重复');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
