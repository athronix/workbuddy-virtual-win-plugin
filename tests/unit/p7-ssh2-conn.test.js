#!/usr/bin/env node
/**
 * p7-ssh2-conn 单测（run16）：node ssh2 后端通道的纯逻辑部分。
 *  - buildConnectOptions：默认值 / env 覆盖 / 密码附带 / 缺 VM_HOST 与坏私钥路径的抛错（凭据纪律：错误不含密钥内容）
 *  - ssh2-conn.mjs `node --check` 语法门禁
 * 不依赖网络/ssh2 在场（纯函数 export，测试环境 delivery 路径可达性不参与）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectOptions, resolvePrivateKeyForConnect } from '../../deploy/skills/winvm-plugin-deploy/scripts/ssh2-conn.mjs';

const CONN_MJS = fileURLToPath(new URL('../../deploy/skills/winvm-plugin-deploy/scripts/ssh2-conn.mjs', import.meta.url));

/** 造一个临时“私钥”文件（内容为占位文本——buildConnectOptions 只做 existsSync，不读内容）。 */
function fakeKey() {
  const dir = mkdtempSync(join(tmpdir(), 'p7-ssh2-key-'));
  const p = join(dir, 'id_ed25519');
  writeFileSync(p, 'FAKE-KEY-NOT-REAL\n', { mode: 0o600 });
  return p;
}

test('buildConnectOptions 默认值：User/22/~/.ssh/id_ed25519/readyTimeout 15000', () => {
  const key = fakeKey();
  const o = buildConnectOptions({ VM_HOST: '172.16.100.2', WINVM_VM_KEY: key });
  assert.equal(o.host, '172.16.100.2');
  assert.equal(o.port, 22);
  assert.equal(o.username, 'User');
  assert.equal(o.privateKey, key); // 传 path，不读真实密钥
  assert.equal(o.readyTimeout, 15000);
  assert.equal(o.keepaliveInterval, 8000);
  assert.ok(!('password' in o), '未设 WINVM_SSH_PASSWORD 不应附带 password 字段');
});

test('buildConnectOptions env 覆盖：VM_USER/VM_SSH_PORT/VM_SSH_READY_TIMEOUT_MS', () => {
  const key = fakeKey();
  const o = buildConnectOptions({
    VM_HOST: '10.0.0.9',
    VM_USER: 'Admin',
    VM_SSH_PORT: '2222',
    VM_SSH_READY_TIMEOUT_MS: '8000',
    WINVM_VM_KEY: key,
  });
  assert.equal(o.host, '10.0.0.9');
  assert.equal(o.port, 2222);
  assert.equal(o.username, 'Admin');
  assert.equal(o.readyTimeout, 8000);
});

test('buildConnectOptions 密码附带：WINVM_SSH_PASSWORD 在场 → privateKey+password 同传', () => {
  const key = fakeKey();
  const o = buildConnectOptions({ VM_HOST: 'h', WINVM_VM_KEY: key, WINVM_SSH_PASSWORD: 's3cr3t' });
  assert.equal(o.privateKey, key);
  assert.equal(o.password, 's3cr3t');
});

test('buildConnectOptions 缺 VM_HOST 抛错（无凭据泄露）', () => {
  assert.throws(() => buildConnectOptions({}), /VM_HOST/);
});

test('buildConnectOptions 非法端口抛错', () => {
  assert.throws(() => buildConnectOptions({ VM_HOST: 'h', VM_SSH_PORT: '0' }), /VM_SSH_PORT/);
  assert.throws(() => buildConnectOptions({ VM_HOST: 'h', VM_SSH_PORT: 'abc' }), /VM_SSH_PORT/);
});

test('buildConnectOptions 私钥路径不存在抛错（错误只含路径不含密钥内容）', () => {
  const missing = join(tmpdir(), 'p7-definitely-missing-key-' + process.pid + '-' + Date.now());
  assert.ok(!existsSync(missing));
  assert.throws(() => buildConnectOptions({ VM_HOST: 'h', WINVM_VM_KEY: missing }), /私钥文件不存在/);
});

test('resolvePrivateKeyForConnect：path → Buffer（ssh2 需 Buffer，字符串按 PEM 解析必挂）', () => {
  const key = fakeKey();
  const o = buildConnectOptions({ VM_HOST: 'h', WINVM_VM_KEY: key });
  const r = resolvePrivateKeyForConnect(o);
  assert.ok(Buffer.isBuffer(r.privateKey), 'privateKey 应为 Buffer');
  assert.equal(r.host, 'h');
  // 已是 Buffer → 原样返回
  const asBuf = { ...o, privateKey: Buffer.from('x') };
  assert.equal(resolvePrivateKeyForConnect(asBuf).privateKey, asBuf.privateKey);
  // 路径失效 → 抛「私钥文件不存在」（不读内容）
  assert.throws(() => resolvePrivateKeyForConnect({ ...o, privateKey: '/nonexistent/p7-key' }), /私钥文件不存在/);
});

test('ssh2-conn.mjs node --check 语法门禁', () => {
  const node = process.execPath;
  execFileSync(node, ['--check', CONN_MJS], { stdio: 'pipe' });
  assert.ok(existsSync(CONN_MJS), 'ssh2-conn.mjs 应存在');
});
