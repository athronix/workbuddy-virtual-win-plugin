/**
 * 迭代21 / D-2 单测：delivery/ssh2-client.mjs 共享执行体 + delivery/ssh2-backend.mjs 三级开关。
 *
 * 背景：鸿蒙 WB 沙箱 OpenSSH 二进制对 VM 相位性挂起（rc=124），node ssh2 库同秒恒通；
 * delivery 发布层 24 处 ssh/scp 调用点全部 ssh2 化（auto 优先 / key 兜底）。本文件钉住
 * 新执行体的**纯逻辑面**（零网络、零真实 ssh2）：
 *   ① buildConnectOptions 参数装配（host/user/port 校验、path→Buffer 转换、password 并存、
 *      凭据全缺报错、错误零凭据泄露）；
 *   ② loadSsh2Client 失败时 createSshRunner 抛「ssh2 不可用 → 请临时 WINVM_SSH_BACKEND=key」
 *      引导错误（noSsh2 型，auto 可回落）；
 *   ③ runWithBackend 三态策略：key 直落二进制 / ssh2 显式失败不碰二进制 /
 *      auto 仅连接级失败回落一发（远端非零码=业务真值**绝不回落**）；
 *   ④ isInfraFailure 错误分型（超时/握手/网络/认证=infra；远端码/out 业务值=非 infra）；
 *   ⑤ runVmOp 装配器：假 runner 注入下 exec→{ok,code,out,stdout,stderr} 映射、
 *      finally close、backend=key 零 ssh2 触碰；
 *   ⑥ ssh2-backend 三级判定（env > config > auto；非法值下坠；resolveVmKeyPath env 优先）。
 *
 * 运行（只跑本文件）：node --test tests/unit/ssh2-client.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Ssh2InfraError,
  briefError,
  isInfraFailure,
  buildConnectOptions,
  resolvePrivateKeyForConnect,
  runWithBackend,
  mapRunnerResult,
  runVmOp,
  createSshRunner,
  Ssh2Runner,
  RC_INFRA,
} from '../../delivery/ssh2-client.mjs';
import {
  normalizeSshBackend,
  resolveSshBackend,
  resolveVmKeyPath,
  readVmConnBackend,
  syncVmBackend,
} from '../../delivery/ssh2-backend.mjs';

const CLIENT_MJS = fileURLToPath(new URL('../../delivery/ssh2-client.mjs', import.meta.url));
const BACKEND_MJS = fileURLToPath(new URL('../../delivery/ssh2-backend.mjs', import.meta.url));

/** 造一个临时“私钥”文件（内容=占位文本；resolvePrivateKeyForConnect 读为 Buffer）。 */
function fakeKey(content = 'FAKE-KEY-NOT-REAL\n') {
  const dir = mkdtempSync(join(tmpdir(), 'd2-ssh2-key-'));
  const p = join(dir, 'id_ed25519');
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

/* ============================ ① 参数装配 ============================ */

describe('buildConnectOptions：参数装配与校验（凭据纪律）', () => {
  test('最小合法集：host/port/user/privateKeyPath → readyTimeout/keepalive 默认值', () => {
    const key = fakeKey();
    const o = buildConnectOptions({ host: '172.16.100.2', port: 22, user: 'User', privateKeyPath: key });
    assert.equal(o.host, '172.16.100.2');
    assert.equal(o.port, 22);
    assert.equal(o.username, 'User');
    assert.equal(o.privateKeyPath, key); // 纯函数只登记 path（不读盘）
    assert.equal(o.readyTimeout, 15000);
    assert.equal(o.keepaliveInterval, 8000);
    assert.ok(!('password' in o), '未设 password 不应附带 password 字段');
    assert.ok(!('privateKey' in o), 'path 形态不得提前生成 privateKey 字段');
  });

  test('readyTimeoutMs 覆盖 + port 字符串归一', () => {
    const key = fakeKey();
    const o = buildConnectOptions({ host: 'h', port: '2222', user: 'u', privateKeyPath: key, readyTimeoutMs: 8000 });
    assert.equal(o.port, 2222);
    assert.equal(o.readyTimeout, 8000);
  });

  test('password 与 privateKeyPath 可并存（加密私钥口令形态）', () => {
    const key = fakeKey();
    const o = buildConnectOptions({ host: 'h', user: 'u', privateKeyPath: key, password: 's3cr3t' });
    assert.equal(o.privateKeyPath, key);
    assert.equal(o.password, 's3cr3t');
  });

  test('缺 host 报错（且错误信息不含任何凭据内容）', () => {
    const key = fakeKey('SECRET-PEM-CONTENT');
    assert.throws(
      () => buildConnectOptions({ user: 'u', privateKeyPath: key, password: 'top-secret' }),
      (e) => {
        assert.match(e.message, /host 未设/);
        assert.ok(!e.message.includes('SECRET-PEM-CONTENT'), '错误不得含密钥内容');
        assert.ok(!e.message.includes('top-secret'), '错误不得含密码内容');
        return true;
      },
    );
  });

  test('缺 user / 非法 port / 凭据全缺 → 各自精确报错（零凭据打印）', () => {
    assert.throws(() => buildConnectOptions({ host: 'h', privateKeyPath: fakeKey() }), /user 未设/);
    assert.throws(() => buildConnectOptions({ host: 'h', port: '0', user: 'u', privateKeyPath: fakeKey() }), /port 非法/);
    assert.throws(() => buildConnectOptions({ host: 'h', port: 'abc', user: 'u', privateKeyPath: fakeKey() }), /port 非法/);
    assert.throws(() => buildConnectOptions({ host: 'h', user: 'u', password: '' }), /凭据缺失/);
  });

  test('privateKey（PEM Buffer）直传形态：无 path 也合法；字符串 PEM 原样保留', () => {
    const buf = Buffer.from('PEM-BYTES');
    const o = buildConnectOptions({ host: 'h', user: 'u', privateKey: buf });
    assert.equal(o.privateKey, buf);
    assert.ok(!('privateKeyPath' in o));
    const o2 = buildConnectOptions({ host: 'h', user: 'u', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx' });
    assert.equal(typeof o2.privateKey, 'string', '字符串 PEM 原样（ssh2 按字面量解析=正确语义）');
  });
});

describe('resolvePrivateKeyForConnect：path → Buffer（run17 实锤坑）', () => {
  test('路径读为 Buffer（ssh2 对字符串 privateKey 按 PEM 字面量解析，传路径必挂）', () => {
    const key = fakeKey();
    const o = buildConnectOptions({ host: 'h', user: 'u', privateKeyPath: key });
    const r = resolvePrivateKeyForConnect(o);
    assert.ok(Buffer.isBuffer(r.privateKey), 'privateKey 应为 Buffer');
    assert.ok(!('privateKeyPath' in r), '转换后不得残留 privateKeyPath 字段');
    assert.equal(r.host, 'h');
    assert.equal(r.username, 'u');
    assert.ok(!('password' in r), 'password 不在场不得凭空附加');
  });

  test('已是 Buffer（PEM 直传）→ 原样透传', () => {
    const buf = Buffer.from('X');
    const r = resolvePrivateKeyForConnect({ host: 'h', privateKey: buf });
    assert.equal(r.privateKey, buf);
  });

  test('路径不存在 → 抛「私钥文件不存在」（只含路径，不含内容）', () => {
    const missing = join(tmpdir(), 'd2-definitely-missing-' + process.pid + '-' + Date.now());
    assert.ok(!existsSync(missing));
    assert.throws(() => resolvePrivateKeyForConnect({ host: 'h', privateKeyPath: missing }), /私钥文件不存在/);
  });

  test('password 与 Buffer 私钥并存透传', () => {
    const key = fakeKey();
    const o = buildConnectOptions({ host: 'h', user: 'u', privateKeyPath: key, password: 'pp' });
    const withPass = resolvePrivateKeyForConnect(o);
    assert.ok(Buffer.isBuffer(withPass.privateKey));
    assert.equal(withPass.password, 'pp');
  });
});

/* ============================ ② ssh2 不可用引导错误 ============================ */

describe('createSshRunner：ssh2 解析失败 → 「不可用→请临时 WINVM_SSH_BACKEND=key」引导', () => {
  test('loadClient 抛错时包装为 noSsh2 型 infra，文案含包名与 key 引导', async () => {
    const key = fakeKey();
    await assert.rejects(
      createSshRunner({
        host: 'h', user: 'u', privateKeyPath: key,
        loadClient: async () => { throw new Error('缺少必需运行时依赖：ssh2（鸿蒙 ssh2 隧道的唯一通路依赖）'); },
      }),
      (e) => {
        assert.ok(e instanceof Ssh2InfraError, '应为 Ssh2InfraError');
        assert.equal(e.noSsh2, true, 'noSsh2 标记=auto 可识别回落');
        assert.equal(e.infra, true);
        assert.match(e.message, /ssh2 不可用/);
        assert.match(e.message, /WINVM_SSH_BACKEND=key/);
        return true;
      },
    );
  });

  test('loadClient 返回非函数（解析为空）同样归 noSsh2', async () => {
    await assert.rejects(
      createSshRunner({ host: 'h', user: 'u', privateKeyPath: fakeKey(), loadClient: async () => ({}) }),
      (e) => e.noSsh2 === true && /Client 构造器解析为空/.test(e.message),
    );
  });

  test('参数级失败（缺 host）也被规整为 infra 型（auto 可落二进制——二进制或有 agent 可救）', async () => {
    await assert.rejects(
      createSshRunner({ user: 'u', privateKeyPath: fakeKey() }),
      (e) => e instanceof Ssh2InfraError && e.infra === true && /host 未设/.test(e.message),
    );
  });

  test('私钥文件缺失 → infra 型且 isInfraFailure 命中（auto 回落面）', async () => {
    const missing = join(tmpdir(), 'd2-missing-key-' + Date.now());
    await assert.rejects(
      createSshRunner({ host: 'h', user: 'u', privateKeyPath: missing }),
      (e) => e.infra === true && isInfraFailure(e),
    );
  });

  test('注入 ssh2Client（假 Client 构造器）→ 返回可用 runner（不触网，未建连）', async () => {
    function FakeClient() {}
    const runner = await createSshRunner({
      host: 'h', user: 'u', privateKeyPath: fakeKey(), ssh2Client: FakeClient,
    });
    assert.ok(runner instanceof Ssh2Runner);
    assert.equal(runner._conn, null, '惰性建连：create 后不得已连接');
    await runner.close();
  });
});

/* ============================ ③ 回落策略 ============================ */

describe('runWithBackend：三态策略（key/ssh2/auto），仅连接级失败回落', () => {
  test('key=原行为：二进制直走，op 绝不被调', async () => {
    let opCalled = 0;
    const r = await runWithBackend({
      backend: 'key',
      binary: async () => 'BINARY',
      op: async () => { opCalled++; return 'SSH2'; },
    });
    assert.equal(r, 'BINARY');
    assert.equal(opCalled, 0);
  });

  test('auto：op 成功（含远端非零码业务值 {ok:false}）绝不落二进制', async () => {
    let binCalled = 0;
    const r = await runWithBackend({
      backend: 'auto',
      binary: async () => { binCalled++; return 'BINARY'; },
      op: async () => ({ ok: false, code: 42, out: '业务失败真值' }),
    });
    assert.deepEqual(r, { ok: false, code: 42, out: '业务失败真值' });
    assert.equal(binCalled, 0, '远端非零码=业务真值，回落只会重复执行副作用');
  });

  test('auto：infra 失败 → onFallback 后二进制一发', async () => {
    const seen = [];
    let bin = 0;
    const r = await runWithBackend({
      backend: 'auto',
      binary: async () => { bin++; return 'BINARY'; },
      op: async () => { throw new Ssh2InfraError('ssh2 ready 超时（15000ms）host=h'); },
      onFallback: (e) => seen.push(e.message),
    });
    assert.equal(r, 'BINARY');
    assert.equal(bin, 1);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /ready 超时/);
  });

  test('auto：非 infra 错误（代码缺陷型）原样上抛，不掩盖', async () => {
    await assert.rejects(
      runWithBackend({
        backend: 'auto',
        binary: async () => 'BINARY',
        op: async () => { throw new TypeError('cannot read property foo of undefined'); },
      }),
      TypeError,
    );
  });

  test('auto：noSsh2 型必回落（即使文案不命中特征表）', async () => {
    let bin = 0;
    const r = await runWithBackend({
      backend: 'auto',
      binary: async () => { bin++; return 'BINARY'; },
      op: async () => { const e = new Error('zzz-unknown'); e.noSsh2 = true; throw e; },
    });
    assert.equal(r, 'BINARY');
    assert.equal(bin, 1);
  });

  test('ssh2 显式后端：infra 失败也**不碰二进制**（错误原样显形）', async () => {
    let bin = 0;
    await assert.rejects(
      runWithBackend({
        backend: 'ssh2',
        binary: async () => { bin++; return 'BINARY'; },
        op: async () => { throw new Ssh2InfraError('ssh2 连接错误: ECONNREFUSED'); },
      }),
      /ECONNREFUSED/,
    );
    assert.equal(bin, 0, '显式 ssh2=单一后端承诺，回落=撒谎');
  });
});

/* ============================ ④ 错误分型 ============================ */

describe('isInfraFailure：连接级特征分型（auto 回落的唯一判据门）', () => {
  test('infra 特征全命中：ready 超时/handshake/ECONNREFUSED/socket 断/认证失败/ssh2 缺失/私钥缺失', () => {
    for (const msg of [
      'ssh2 ready 超时（15000ms）host=h',
      'Handshake timed out',
      'connect ECONNREFUSED 172.16.100.2:22',
      'socket hang up',
      'Authentication failed.',
      'ssh2 不可用（运行时依赖解析失败）',
      '私钥文件不存在: /x/y',
    ]) {
      assert.ok(isInfraFailure(new Error(msg)), `应判 infra：${msg}`);
    }
    // 远端目录创建失败=通道不健康形态：真实代码以 Ssh2InfraError 抛出（实例判定，非文案匹配）
    assert.ok(isInfraFailure(new Ssh2InfraError('远端目录创建失败: C:/a（permission denied）')));
  });

  test('非 infra：空消息/纯业务文本；Ssh2InfraError 与 {infra:true} 直判真', () => {
    assert.ok(!isInfraFailure(null));
    assert.ok(!isInfraFailure(''));
    assert.ok(!isInfraFailure(new Error('VM_START_FAILED exit=1')));
    assert.ok(isInfraFailure(new Ssh2InfraError('anything')));
    assert.ok(isInfraFailure({ infra: true }));
  });

  test('briefError：CRLF 归一 + 120 字符截断（凭据纪律的呈现面）', () => {
    const long = 'x'.repeat(300);
    assert.equal(briefError(new Error(long)).length, 120);
    assert.equal(briefError(new Error('a\r\nb')), 'a\nb');
    assert.equal(briefError(undefined), 'unknown');
  });

  test('RC_INFRA=111 与 ssh2-conn 对齐（可重试形态码）', () => {
    assert.equal(RC_INFRA, 111);
  });
});

/* ============================ ⑤ runVmOp 装配器 ============================ */

describe('runVmOp：建连→op→finally close 的装配语义（假 runner 注入）', () => {
  /** 假 runner：记录调用与 close。 */
  function fakeRunner(behavior) {
    const log = { closed: 0, ops: [] };
    const runner = {
      async exec(cmd) { log.ops.push(['exec', cmd]); return behavior(cmd); },
      async put(l, r) { log.ops.push(['put', l, r]); return behavior(l); },
      async close() { log.closed++; },
    };
    return { runner, log };
  }

  test('exec 成功 → mapRunnerResult {ok,code,out,stdout,stderr}', async () => {
    const { runner, log } = fakeRunner(() => ({ ok: true, code: 0, stdout: 'win-hos-ywang-s\\user\r\n', stderr: '' }));
    const res = await runVmOp({
      backend: 'auto',
      host: 'h', port: 22, user: 'u', privateKeyPath: fakeKey(),
      op: (r) => r.exec('whoami'),
      binary: async () => ({ ok: false, code: 124, out: 'TIMEOUT' }),
      createRunner: async () => runner,
    });
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, 'win-hos-ywang-s\\user\r\n');
    assert.equal(res.out.includes('win-hos-ywang-s'), true);
    assert.equal(log.closed, 1, 'finally close 必须执行');
    assert.deepEqual(log.ops[0], ['exec', 'whoami']);
  });

  test('远端非零码=业务真值原样返回（不回落、不 throw），close 仍执行', async () => {
    const { runner, log } = fakeRunner(() => ({ ok: false, code: 3, stdout: '', stderr: 'no rules match' }));
    let bin = 0;
    const res = await runVmOp({
      backend: 'auto',
      host: 'h', user: 'u', privateKeyPath: fakeKey(),
      op: (r) => r.exec('netsh'),
      binary: async () => { bin++; return { ok: true, code: 0, out: 'MUST-NOT-RUN' }; },
      createRunner: async () => runner,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 3);
    assert.equal(bin, 0);
    assert.equal(log.closed, 1);
  });

  test('infra 建连失败（createRunner 抛）→ auto 落 binary 一发 + onFallback', async () => {
    const seen = [];
    const res = await runVmOp({
      backend: 'auto',
      host: 'h', user: 'u', privateKeyPath: fakeKey(),
      op: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      binary: async () => ({ ok: true, code: 0, out: 'BINARY-OK' }),
      createRunner: async () => { throw new Ssh2InfraError('ssh2 ready 超时（15000ms）host=h'); },
      onFallback: (e) => seen.push(e.message),
    });
    assert.equal(res.out, 'BINARY-OK');
    assert.equal(seen.length, 1);
  });

  test('backend=key：createRunner 与 op 绝不触碰（零 ssh2 副作用）', async () => {
    let created = 0;
    const res = await runVmOp({
      backend: 'key',
      host: 'h', user: 'u', privateKeyPath: fakeKey(),
      op: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      binary: async () => ({ ok: true, code: 0, out: 'B' }),
      createRunner: async () => { created++; return fakeRunner(() => ({})).runner; },
    });
    assert.equal(created, 0);
    assert.equal(res.out, 'B');
  });

  test('op 中途 infra 断流 → close 仍 finally 执行 + auto 回落', async () => {
    const { runner, log } = fakeRunner(() => { throw new Ssh2InfraError('ssh2 exec 通道异常中断（code=null）'); });
    const res = await runVmOp({
      backend: 'auto',
      host: 'h', user: 'u', privateKeyPath: fakeKey(),
      op: (r) => r.exec('boom'),
      binary: async () => ({ ok: false, code: 124, out: 'TIMEOUT' }),
      createRunner: async () => runner,
    });
    assert.equal(res.out, 'TIMEOUT');
    assert.equal(log.closed, 1);
  });

  test('mapRunnerResult：code 兜底（非有限值=1）+ out 拼接序 stdout→stderr', () => {
    assert.deepEqual(
      mapRunnerResult({ ok: true, code: 0, stdout: 'A', stderr: 'B' }),
      { ok: true, code: 0, out: 'AB', stdout: 'A', stderr: 'B' },
    );
    assert.equal(mapRunnerResult({ ok: false, stdout: '', stderr: 'x' }).code, 1);
    assert.equal(mapRunnerResult({ ok: false, code: null, stdout: '', stderr: '' }).code, 1);
  });
});

/* ============================ ⑥ 三级开关 ============================ */

describe('ssh2-backend：WINVM_SSH_BACKEND 三级判定（env > config > auto）', () => {
  test('normalizeSshBackend：大小写/空白宽容，非法值=未设（下坠）', () => {
    assert.equal(normalizeSshBackend('KEY'), 'key');
    assert.equal(normalizeSshBackend(' ssh2 '), 'ssh2');
    assert.equal(normalizeSshBackend('Auto'), 'auto');
    assert.equal(normalizeSshBackend('whatever'), '');
    assert.equal(normalizeSshBackend(undefined), '');
    assert.equal(normalizeSshBackend(''), '');
  });

  test('env 最高优先：压过 config 字段', () => {
    assert.equal(resolveSshBackend({ WINVM_SSH_BACKEND: 'key' }, 'ssh2'), 'key');
  });

  test('env 未设/非法 → config 字段；两者全缺 → auto（默认零冲击缺省）', () => {
    assert.equal(resolveSshBackend({}, 'ssh2'), 'ssh2');
    assert.equal(resolveSshBackend({ WINVM_SSH_BACKEND: 'bogus' }, 'key'), 'key');
    assert.equal(resolveSshBackend({}, ''), 'auto');
    assert.equal(resolveSshBackend({}, 'bogus'), 'auto');
  });

  test('resolveVmKeyPath：env WINVM_VM_KEY 最高优先（含指向不存在文件=诚实反映），否则默认键探测链', () => {
    const key = fakeKey();
    assert.equal(resolveVmKeyPath({ WINVM_VM_KEY: key }, '/nonexistent-home'), key);
    assert.equal(resolveVmKeyPath({ WINVM_VM_KEY: '/nonexistent/forced' }, '/nonexistent-home'), '/nonexistent/forced');
    assert.equal(resolveVmKeyPath({}, join(tmpdir(), 'd2-empty-home-' + Date.now())), '');
  });

  test('readVmConnBackend / syncVmBackend：env > vm-conn.sshBackend > 既有值 > auto；坏 JSON 容错', () => {
    const home = mkdtempSync(join(tmpdir(), 'd2-vmconn-home-'));
    const deep = join(home, '.workbuddy', 'winvm');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'vm-conn.json'), '{"host":"h","sshBackend":"key"}\n', 'utf8');
    assert.equal(readVmConnBackend(home), 'key');
    const saved = process.env.WINVM_SSH_BACKEND;
    try {
      delete process.env.WINVM_SSH_BACKEND;
      const obj = { vmSshBackend: 'ssh2' };
      syncVmBackend(obj, home);
      assert.equal(obj.vmSshBackend, 'key', 'vm-conn 字段在场时生效（env 未显式设）');
      process.env.WINVM_SSH_BACKEND = 'auto';
      syncVmBackend(obj, home);
      assert.equal(obj.vmSshBackend, 'auto', 'env 显式最高优先');
    } finally {
      if (saved === undefined) delete process.env.WINVM_SSH_BACKEND;
      else process.env.WINVM_SSH_BACKEND = saved;
    }
    // 坏 JSON / 不存在 → ''（安全下坠）
    writeFileSync(join(deep, 'vm-conn.json'), '{not-json', 'utf8');
    assert.equal(readVmConnBackend(home), '');
    assert.equal(readVmConnBackend(join(home, 'nope')), '');
  });
});

/* ============================ Ssh2Runner 单件（假 Client，零网络） ============================ */

describe('Ssh2Runner：exec/put/get 与错误分型（假 ssh2 Client 注入）', () => {
  /**
   * 最小假 ssh2 Client：可编程 ready/error、exec 流、sftp 通道。
   * @param {{mode?:'ready'|'error'|'close'|'never', execCode?:number, execErr?:Error,
   *          sftpErr?:Error, fastPutErr?:Error}} spec
   */
  function makeFakeClient(spec = {}) {
    class FakeConn extends EventEmitter {
      connect() {
        setImmediate(() => {
          if (spec.mode === 'error') this.emit('error', spec.err || new Error('All configured authentication methods failed'));
          else if (spec.mode === 'close') this.emit('close');
          else if (spec.mode !== 'never') this.emit('ready');
        });
      }
      end() { if (spec.endEmitsClose !== false) setImmediate(() => this.emit('close')); }
      exec(cmd, cb) {
        if (spec.execOpenErr) {
          // 真实 ssh2 的 cb(err) 在下一 tick 到达（监听器已注册）；同步回调会被
          // 真实 runner 的监听时序吞掉，故此处同样 setImmediate（假件语义对齐）。
          setImmediate(() => cb(spec.execOpenErr));
          return;
        }
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        setImmediate(() => {
          if (spec.execErr) { stream.emit('error', spec.execErr); return; }
          stream.emit('data', Buffer.from(spec.stdout || ''));
          stream.stderr.emit('data', Buffer.from(spec.stderrText || ''));
          stream.emit('close', spec.execCode === undefined ? 0 : spec.execCode);
        });
        cb(null, stream);
      }
      sftp(cb) {
        if (spec.sftpErr) { setImmediate(() => cb(spec.sftpErr)); return; }
        setImmediate(() => cb(null, {
          mkdir(p, f) { f(null); },
          stat(p, f) { f(null, {}); },
          fastPut(l, r, f) { f(spec.fastPutErr || null); },
          createReadStream() {
            const rs = new EventEmitter();
            setImmediate(() => {
              rs.emit('data', Buffer.from(spec.getPayload || 'GOT'));
              rs.emit('close');
            });
            return rs;
          },
        }));
      }
    }
    return FakeConn;
  }

  test('未 ready 即 error → exec 抛 Ssh2InfraError（可 auto 回落）', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ mode: 'error' }), { host: 'h', port: 22, username: 'u', readyTimeout: 500 });
    await assert.rejects(runner.exec('whoami'), (e) => e instanceof Ssh2InfraError && isInfraFailure(e));
    await runner.close();
  });

  test('ready 超时（mode=never + 极小 readyTimeout）→ infra 型', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ mode: 'never' }), { host: 'h', port: 22, username: 'u', readyTimeout: 80 });
    await assert.rejects(runner.exec('x'), /ready 超时/);
    await runner.close();
  });

  test('exec 远端码 3 → {ok:false, code:3}（业务真值，不 throw）', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ execCode: 3, stdout: '', stderrText: 'no rules match' }), { host: 'h', readyTimeout: 500 });
    const r = await runner.exec('netsh');
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.equal(r.stderr, 'no rules match');
    await runner.close();
  });

  test('exec code=null（通道异常断）→ infra 型 throw', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ execCode: null }), { host: 'h', readyTimeout: 500 });
    await assert.rejects(runner.exec('x'), (e) => e instanceof Ssh2InfraError && /code=null/.test(e.message));
    await runner.close();
  });

  test('exec 打开通道失败 → infra 型', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ execOpenErr: new Error('Too many open channels') }), { host: 'h', readyTimeout: 500 });
    await assert.rejects(runner.exec('x'), Ssh2InfraError);
    await runner.close();
  });

  test('put：本地文件缺失=业务形态 {ok:false}（不 throw）；在位=fastPut OK', async () => {
    const runner = new Ssh2Runner(makeFakeClient({}), { host: 'h', readyTimeout: 500 });
    const miss = await runner.put(join(tmpdir(), 'd2-no-such-file-' + Date.now()), 'C:/x.ps1');
    assert.equal(miss.ok, false);
    const key = fakeKey();
    const good = await runner.put(key, 'C:/a/b/winvm-un.ps1');
    assert.equal(good.ok, true);
    await runner.close();
  });

  test('put：sftp 协议级文件错（code=3）=业务 {ok:false}；通道级断=infra throw', async () => {
    const runner1 = new Ssh2Runner(makeFakeClient({ fastPutErr: Object.assign(new Error('permission denied'), { code: 3 }) }), { host: 'h', readyTimeout: 500 });
    const r = await runner1.put(fakeKey(), 'C:/a/x.ps1');
    assert.equal(r.ok, false);
    assert.match(r.stderr, /sftp put 失败/);
    await runner1.close();
    const runner2 = new Ssh2Runner(makeFakeClient({ fastPutErr: new Error('socket closed') }), { host: 'h', readyTimeout: 500 });
    await assert.rejects(runner2.put(fakeKey(), 'C:/a/x.ps1'), Ssh2InfraError);
    await runner2.close();
  });

  test('get：流 close → 写本地文件 ok；sftp 打不开=infra', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ getPayload: 'HELLO' }), { host: 'h', readyTimeout: 500 });
    const dest = join(mkdtempSync(join(tmpdir(), 'd2-get-')), 'out.bin');
    const r = await runner.get('C:/a/out.bin', dest);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(dest, 'utf8'), 'HELLO');
    await runner.close();
    const runner2 = new Ssh2Runner(makeFakeClient({ sftpErr: new Error('sftp subsystem failed') }), { host: 'h', readyTimeout: 500 });
    await assert.rejects(runner2.get('C:/x', join(tmpdir(), 'd2-x-' + Date.now())), Ssh2InfraError);
    await runner2.close();
  });

  test('close 后再 op=infra（禁止复用已关 runner）；close 幂等', async () => {
    const runner = new Ssh2Runner(makeFakeClient({ endEmitsClose: false }), { host: 'h', readyTimeout: 500 });
    await runner.close();
    await runner.close();
    await assert.rejects(runner.exec('x'), /已 close/);
  });

  test('exec 通道超时（远端永挂）→ infra「超时」型 → auto 落 binary', async () => {
    // 假 runner：exec 按 timeoutMs 到点抛 infra（与真实 Ssh2Runner.exec 同语义的最小模拟）
    const hangRunner = {
      exec: (cmd, { timeoutMs = 60000 } = {}) =>
        new Promise((_, rej) => setTimeout(() => rej(new Ssh2InfraError(`ssh2 exec 超时（${timeoutMs}ms）host=h`)), timeoutMs)),
      put: () => new Promise(() => {}),
      close: async () => {},
    };
    let fellBack = 0;
    const res = await runVmOp({
      backend: 'auto',
      host: 'h', user: 'u', privateKeyPath: fakeKey(),
      timeoutMs: 30,
      op: (r) => r.exec('hang', { timeoutMs: 30 }),
      binary: async () => { fellBack++; return { ok: false, code: 124, out: 'BINARY-124' }; },
      createRunner: async () => hangRunner,
      onFallback: () => {},
    });
    assert.equal(res.out, 'BINARY-124');
    assert.equal(fellBack, 1, '通道超时=可重试 infra 形态，auto 回落一发');
  });
});

/* ============================ 分发面一致性（历轮已知大坑对冲） ============================ */

describe('分发白名单对账：winvm-plugin/setup 的相对 import 必须逐一在册', () => {
  const deliveryDir = fileURLToPath(new URL('../../delivery/', import.meta.url));
  const read = (f) => readFileSync(join(deliveryDir, f), 'utf8');

  /** 提取 .mjs 文件里的静态相对 import（不含注释/动态 import）。 */
  function staticImports(src) {
    const out = new Set();
    for (const m of src.matchAll(/^import[^'"]*['"](\.\/[^'"]+)['"]/gm)) out.add(m[1].replace(/^\.\//, ''));
    return [...out];
  }

  test('winvm-plugin.mjs 静态+动态相对依赖 ⊆ install-host extraFiles/对账面（同名同源）', () => {
    const src = read('winvm-plugin.mjs');
    const deps = staticImports(src);
    // 已知面：account-resolve / ssh2-backend 静态；oh-tunnel / ssh2-client / ssh2-resolve 等动态
    assert.ok(deps.includes('account-resolve.mjs'), 'account-resolve 静态依赖应在');
    assert.ok(deps.includes('ssh2-backend.mjs'), '迭代21 D-2：ssh2-backend 静态依赖必须已登记');
    const ih = read('install-host.mjs');
    // 隧道/ssh2 运行面五件：integrity 对账面 + 插件缓存 extraFiles + 仓库 delivery extraFiles（三处齐备）
    for (const f of ['winvm-plugin.mjs', 'ssh2-backend.mjs', 'ssh2-client.mjs', 'ssh2-resolve.mjs', 'tunnel-daemon.mjs', 'oh-tunnel.mjs']) {
      const listed = (ih.match(new RegExp(`['"]${f.replace('.', '\\.')}['"]`, 'g')) || []).length;
      assert.ok(listed >= 3, `${f} 必须在 install-host 三处名单齐备（integrity + 两处 extraFiles），实际 ${listed}`);
    }
    // account-resolve=既有面（integrity + 插件缓存两处；仓库 delivery 自拷贝跳过属原设计）
    assert.ok((ih.match(/'account-resolve\.mjs'/g) || []).length >= 2, 'account-resolve 登记不得回退');
  });

  test('setup.mjs 相对依赖（ssh2-backend 静态）在 pack-release VM_DELIVERY 白名单在册', () => {
    const deps = staticImports(read('setup.mjs'));
    assert.ok(deps.includes('ssh2-backend.mjs'), 'setup 的 ssh2-backend 静态依赖应在');
    const pr = read('pack-release.mjs');
    for (const f of ['ssh2-client.mjs', 'ssh2-backend.mjs', 'ssh2-resolve.mjs']) {
      assert.ok(pr.includes(`'delivery/${f}'`), `pack-release 白名单必须含 delivery/${f}（VM 相位执行体依赖）`);
    }
    // PACKAGE_REQUIRED 断言面（防漂移 V 体系沿用）
    for (const kind of ['host', 'vm']) {
      const block = pr.slice(pr.indexOf(`${kind}: [`));
      assert.ok(block.includes("'delivery/ssh2-client.mjs'") && block.includes("'delivery/ssh2-backend.mjs'"),
        `PACKAGE_REQUIRED.${kind} 必须钉 ssh2 运行面存在性`);
    }
  });
});

/* ============================ 语法门禁 ============================ */

test('ssh2-client.mjs / ssh2-backend.mjs node --check 语法门禁', () => {
  execFileSync(process.execPath, ['--check', CLIENT_MJS], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', BACKEND_MJS], { stdio: 'pipe' });
  assert.ok(existsSync(CLIENT_MJS) && existsSync(BACKEND_MJS));
});
