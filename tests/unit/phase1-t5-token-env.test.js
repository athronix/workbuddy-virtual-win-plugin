/**
 * Phase 1 · T5 行为守卫（判据④）—— `--token-env` 客户端凭据通路真正生效
 *
 * 钉死 §7.4-T5 判据④：「`--token-env` 真给值时隧道请求带 header」。
 * 与设计 §5 第 3 条 / ENG-23 一致：`applyBearerHeader` 是**两条远程传输分支的唯一实现**，
 * 本文件把它从「CLI 解析」到「线上请求头」整条链路一次打穿：
 *
 *   A 形态层：`buildTransport` 仅在显式给出 `--token-env` 时才产出 `tokenEnv` 键
 *             （缺席即旧行为：回环场景不带凭据 —— 与 `requireLoopbackBind` 不可关相呼应）。
 *   B 纯函数层：`applyBearerHeader` 三态（T2 交付；本批把它**固化为持久测试**——
 *             T2 的判据⑥ 当时只以证据脚本验证、未落 `tests/unit`，见 notes 观察 O-2）。
 *   C 装配层：`establishTransport` 两条分支都把凭据交给 `HttpJsonRpcChannel`；
 *             ssh-tunnel 分支的校验**前置**到建隧道之前（有名无值 ⇒ 抛的是凭据错，
 *             且错误串中不含任何隧道字样 ⇒ 证明没起 SSH 进程、无隧道泄漏，T2 D-11）。
 *   D 线上层：起一个 127.0.0.1 的回显 HTTP 服务，真实 `fetch` 一次，断言
 *             `authorization: Bearer <token>` 落到线上（这是判据④的字面要求）。
 *   E 文案层：`--help` 的 `--token-env` 说明不得再宣称「默认 WINVM_BEARER_TOKEN」
 *             （旧文案与实现矛盾：实现默认**不启用**凭据）。
 *
 * 纪律：不连 VM、不起 SSH（C 组只验证「抛在起进程之前」这一点）；
 *       D 组用 node 内置 http 服务，端口回环、随用例关闭。
 *
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase1-t5-token-env.test.js
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTransport, main } from '@winvm/host-a2a-bridge';
import { applyBearerHeader, establishTransport, HttpJsonRpcChannel, TransportError } from '@winvm/core';

const ROOT = join(import.meta.dirname, '..', '..');
const TRANSPORT_SRC = readFileSync(join(ROOT, 'packages', 'core', 'src', 'transport', 'index.ts'), 'utf8');

/* ============================ A 形态层：CLI ⇒ TransportDecl ============================ */

const CLI_ARGS_BASE = {
  endpoint: 'http://127.0.0.1:18443',
  a2aPath: '/a2a',
  timeoutMs: 600_000,
  maxRisk: 'L1',
  help: false,
};

describe('T5 判据④ buildTransport：tokenEnv 纯附加条件展开', () => {
  test('未给 --token-env ⇒ decl 不含 tokenEnv 键（回环默认无凭据，逐字节旧行为）', () => {
    const decl = buildTransport({ ...CLI_ARGS_BASE, tokenEnv: '' });
    assert.equal(decl.kind, 'streamable-http');
    assert.equal(decl.url, 'http://127.0.0.1:18443');
    assert.equal('tokenEnv' in decl, false, '显式 undefined 会改变 canonicalJson 语义（null）⇒ 必须条件展开');
    assert.equal(decl.timeoutMs, 600_000);
  });

  test('真给值 ⇒ decl.tokenEnv = 该变量名（名而非值，凭据永不进配置）', () => {
    const decl = buildTransport({ ...CLI_ARGS_BASE, tokenEnv: 'WINVM_BEARER_TOKEN' });
    assert.equal(decl.tokenEnv, 'WINVM_BEARER_TOKEN');
    // 凭据值本身绝不出现在 decl 任何字段里（只传变量名）
    assert.ok(!JSON.stringify(decl).includes('Bearer'), 'decl 只承载变量名，不得出现凭据形态');
  });
});

/* ============================ B 纯函数层：三态 ============================ */

describe('T5 判据④ applyBearerHeader 三态（凭据语义唯一实现）', () => {
  test('态 1 未配置 ⇒ 原 headers 逐字不变且不含 authorization', () => {
    const base = { 'content-type': 'application/json' };
    const out = applyBearerHeader(base, undefined, {});
    assert.deepEqual(out, base);
    assert.equal('authorization' in out, false);
    const empty = applyBearerHeader(base, '', {});
    assert.deepEqual(empty, base, '空串 tokenEnv 等同未配置（CLI 默认即此态）');
  });

  test('态 2 有值 ⇒ authorization: Bearer <token>，其它头保留', () => {
    const out = applyBearerHeader({ 'x-trace': 't' }, 'WINVM_T5_OK', { WINVM_T5_OK: 'sekret' });
    assert.equal(out['authorization'], 'Bearer sekret');
    assert.equal(out['x-trace'], 't');
  });

  test('态 3 有名无值 ⇒ 抛 TransportError（fail-loud，绝不静默降级成裸请求）', () => {
    for (const env of [{}, { WINVM_T5_MISSING: '' }, { WINVM_T5_MISSING: undefined }]) {
      assert.throws(
        () => applyBearerHeader(undefined, 'WINVM_T5_MISSING', env),
        (e) => e instanceof TransportError && /WINVM_T5_MISSING/.test(e.message),
        `env=${JSON.stringify(env)} 属「有名无值」，必须抛（静默 = 运维以为鉴权开了）`,
      );
    }
  });

  test('返回新对象：readonly 入参不得被改写（无副作用契约）', () => {
    const frozen = Object.freeze({ 'content-type': 'application/json' });
    const out = applyBearerHeader(frozen, 'WINVM_T5_OK', { WINVM_T5_OK: 'v' });
    assert.notEqual(out, frozen);
    assert.equal('authorization' in frozen, false, '入参必须逐字未变');
  });
});

/* ============================ C 装配层：ssh-tunnel 校验前置（无泄漏） ============================ */

describe('T5 判据④ establishTransport：凭据校验前置到建隧道之前（T2 D-11）', () => {
  const tunnelDecl = {
    kind: 'ssh-tunnel',
    host: '127.0.0.1',
    user: 'nobody',
    remotePort: 18443,
    localPort: 0,
    identityFile: '/nonexistent/t5-key',
    tokenEnv: 'WINVM_T5_NO_SUCH_VAR',
  };

  test('有名无值 ⇒ 抛的是凭据错且错误串无任何隧道字样 ⇒ 未起 SSH 进程、无隧道泄漏', async () => {
    const err = await establishTransport(tunnelDecl, { path: '/a2a' }).then(
      () => undefined,
      (e) => e,
    );
    assert.ok(err instanceof TransportError, `应抛 TransportError，实得 ${String(err)}`);
    assert.match(err.message, /WINVM_T5_NO_SUCH_VAR|bearer/i, '必须是凭据错误');
    assert.ok(
      !/隧道|tunnel|SSH|ssh|Connection refused|进程提前退出/i.test(err.message),
      '★ 若错误串里出现隧道/SSH 字样，说明校验发生在 establishSshTunnel **之后** —— ' +
        '那条路径会同时泄漏隧道子进程并把凭据故障伪装成网络故障',
    );
  });

  test('装配次序形态钉：ssh-tunnel 分支的凭据调用点位于建隧道之前（不发真实 SSH 连接）', () => {
    // 本用例刻意**不**跑 tokenEnv 缺席的 establishTransport —— 那会真的尝试建 SSH 隧道
    // （连到不存在的主机），把离线守卫变成网络用例。次序改由源码形态钉死。
    const iApply = TRANSPORT_SRC.indexOf('const headers = applyBearerHeader(opts.headers, decl.tokenEnv)');
    const iTunnel = TRANSPORT_SRC.indexOf('await establishSshTunnel(');
    assert.ok(iApply > 0 && iTunnel > 0, '两处调用点都须在场');
    assert.ok(iApply < iTunnel, '★ 凭据校验必须先于建隧道：否则态 3 抛错时隧道已起而句柄未回，close() 永不执行 ⇒ 泄漏');
    // streamable-http 分支同样消费同一函数（单一实现，不得漂移出第二份 header 拼装）
    const uses = TRANSPORT_SRC.match(/applyBearerHeader\(opts\.headers, decl\.tokenEnv\)/g) ?? [];
    assert.equal(uses.length, 2, `两条远程分支各一处，实得 ${uses.length}`);
    // 凭据拼装只允许一处代码写入点（`out['authorization'] =` 在 applyBearerHeader 内）；
    // 分支里再出现 authorization 赋值 = 第二份实现漂移（正是 T2 要根治的病灶）。
    const assignSites = TRANSPORT_SRC.match(/(?:out|headers)\[(?:'|")authorization(?:'|")\]\s*=/g) ?? [];
    assert.equal(assignSites.length, 1, `authorization 赋值点须恰 1 处（在 applyBearerHeader 内），实得 ${assignSites.length}`);
    assert.equal(
      (TRANSPORT_SRC.match(/['"]authorization['"]\s*:/g) ?? []).length,
      0,
      '不得以对象字面量形式另写 authorization 头（那会绕过三态语义）',
    );
  });
});

/* ============================ D 线上层：header 真的落到请求 ============================ */

describe('T5 判据④ 线上断言：隧道/HTTP 请求带 authorization 头', () => {
  /** 回环 echo 服务：把收到的 authorization 头写进响应体，随用例关闭 */
  async function withEchoServer(fn) {
    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ authorization: req.headers['authorization'], body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      await fn(`http://127.0.0.1:${port}`, seen);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  test('establishTransport(streamable-http + tokenEnv 有值) ⇒ 请求头含 Bearer', async () => {
    await withEchoServer(async (baseUrl, seen) => {
      process.env['WINVM_T5_ECHO'] = 'tok-42';
      try {
        const handle = await establishTransport(
          { kind: 'streamable-http', url: baseUrl, tokenEnv: 'WINVM_T5_ECHO', timeoutMs: 5_000 },
          { path: '/a2a' },
        );
        await handle.channel.request({ jsonrpc: '2.0', id: 1, method: 'x', params: {} });
        await handle.close();
        assert.equal(seen.length, 1, 'echo 服务须恰收到一次请求');
        assert.equal(seen[0].authorization, 'Bearer tok-42', '★ 判据④的字面要求：真给值 ⇒ 线上带 header');
      } finally {
        delete process.env['WINVM_T5_ECHO'];
      }
    });
  });

  test('未配置 tokenEnv ⇒ 线上无 authorization（现网部署零变化）', async () => {
    await withEchoServer(async (baseUrl, seen) => {
      const handle = await establishTransport(
        { kind: 'streamable-http', url: baseUrl, timeoutMs: 5_000 },
        { path: '/a2a' },
      );
      await handle.channel.request({ jsonrpc: '2.0', id: 1, method: 'x', params: {} });
      await handle.close();
      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, undefined, '回环默认不带凭据：不得静默加头');
    });
  });

  test('HttpJsonRpcChannel 直连：headers 注入即生效（传输无关的同一落点）', async () => {
    await withEchoServer(async (baseUrl, seen) => {
      const channel = new HttpJsonRpcChannel({
        baseUrl,
        path: '/mcp',
        headers: applyBearerHeader({}, 'WINVM_T5_DIRECT', { WINVM_T5_DIRECT: 'direct-7' }),
      });
      await channel.request({ jsonrpc: '2.0', id: 2, method: 'y', params: {} });
      await channel.close();
      assert.equal(seen[0].authorization, 'Bearer direct-7');
    });
  });
});

/* ============================ E 文案层：usage 与实现一致 ============================ */

describe('T5 判据④ usage 文案：--token-env 默认值陈述与实现一致', () => {
  async function captureHelp() {
    const orig = process.stdout.write;
    let buf = '';
    process.stdout.write = (s) => {
      buf += String(s);
      return true;
    };
    try {
      await main(['--help']);
    } finally {
      process.stdout.write = orig;
    }
    return buf;
  }

  test('usage 说明「默认不启用」，不再谎称默认 WINVM_BEARER_TOKEN', async () => {
    const help = await captureHelp();
    assert.match(help, /--token-env/, '须列出该选项');
    assert.match(help, /默认\*\*不启用\*\*|默认不启用/, '★ 旧文案「默认 WINVM_BEARER_TOKEN」与 parseArgs 的 tokenEnv:\'\' 矛盾');
    assert.ok(
      !/token-env <name> bearer token 环境变量名（默认 WINVM_BEARER_TOKEN）/.test(help),
      '旧矛盾文案须已退场',
    );
    // 既有守卫项不得被文案改动破坏（cl018-a2a-timeout 的 --help 功能性断言）
    assert.match(help, /WINVM_A2A_TIMEOUT_MS/);
    assert.match(help, /冷启动/);
  });

  test('usage 提示「有名无值 ⇒ 报错退出」，与态 3 fail-loud 语义一致', async () => {
    const help = await captureHelp();
    assert.match(help, /未设值.*报错|直接报错退出/, '运维必须能从文案预判 fail-loud，而不是线上撞 401');
  });
});
