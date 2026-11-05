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
import { buildConnectOptions, resolvePrivateKeyForConnect, classifyScpShape, isRemoteLike } from '../../deploy/skills/winvm-plugin-deploy/scripts/ssh2-conn.mjs';

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

/* ── run17 D-8：vmscp 判形纯函数（vm-conn.sh _scp_shape 与本件共用同一事实源） ── */

const PFX = 'User@172.16.100.2:';

test('isRemoteLike：user@host: 前缀与 xxx:/ 正斜杠形态=真；裸文件名/本地绝对路径=假', () => {
  assert.ok(isRemoteLike('User@172.16.100.2:C:/a/b.ps1', PFX));
  assert.ok(isRemoteLike('User@172.16.100.2:bare.ps1', PFX));     // 剥前缀后裸文件名（home 相对）
  assert.ok(isRemoteLike('C:/WinVMWorkspace/x.ps1', PFX));        // 盘符正斜杠形态
  assert.ok(!isRemoteLike('/storage/tmp/x.txt', PFX));            // 本地绝对路径
  assert.ok(!isRemoteLike('bare.ps1', PFX));                      // 裸文件名
  assert.ok(!isRemoteLike('', PFX));
});

test('classifyScpShape 正例：local→remote=put；remote→local=get；两侧非文件且 a1 像 remote=get（下载目标不存在常态）', () => {
  assert.equal(classifyScpShape(true, false, '/tmp/x.ps1', PFX + 'C:/a/x.ps1', PFX), 'put');
  assert.equal(classifyScpShape(true, false, '/tmp/x.ps1', 'bare.ps1', PFX), 'unknown'); // 对侧不像 remote
  assert.equal(classifyScpShape(false, true, PFX + 'C:/a/x.ps1', '/tmp/down.txt', PFX), 'get');
  assert.equal(classifyScpShape(false, false, PFX + 'C:/a/x.ps1', '/tmp/new.txt', PFX), 'get');
  assert.equal(classifyScpShape(false, false, 'C:/a/x.ps1', '/tmp/new.txt', PFX), 'get');  // 无 host 前缀盘符形
});

test('classifyScpShape D-5 负例：a1 为目录名（非 -f、无冒号）→ unknown 不猜（勿静默错传）', () => {
  // QA D-5：宿主上恰有同名目录（[ -f ]=false）且无 ':' → 判不住 → unknown，调用方显式报错
  assert.equal(classifyScpShape(false, true, 'somedir', '/tmp/out.txt', PFX), 'unknown');
  assert.equal(classifyScpShape(true, true, '/tmp/a.txt', '/tmp/b.txt', PFX), 'unknown'); // 两侧本地文件=无 remote
});

test('shape 子命令 CLI（零连接）：put/get 输出与纯函数一致', () => {
  const node = process.execPath;
  const out = execFileSync(node, [CONN_MJS, 'shape', '1', '0', '/tmp/x.ps1', PFX + 'C:/a/x.ps1', PFX], { encoding: 'utf8' }).trim();
  assert.equal(out, 'put');
  const out2 = execFileSync(node, [CONN_MJS, 'shape', '0', '0', 'somedir', 'other', PFX], { encoding: 'utf8' }).trim();
  assert.equal(out2, 'unknown');
});
