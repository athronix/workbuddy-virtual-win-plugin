/**
 * CL-018 T03 · 服务日志落盘（轮转 / 保留 / 降级 / 脱敏）
 *
 * 纪律：临时目录一律建在**项目目录内**（本机 /tmp 只读），跑完即清理。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleLogger, FileLogger, RotatingFileSink, createFileLogger, redactSecrets } from '@winvm/core';

const BASE = join(import.meta.dirname, '..', 'fixtures', 'cl018-logs');
mkdirSync(BASE, { recursive: true });
const tmp = mkdtempSync(join(BASE, 'log-'));
let seq = 0;
const sub = (name) => {
  const d = join(tmp, `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

const linesOf = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean);

describe('CL-018 T03 · redactSecrets（脱敏，AC3.6）', () => {
  test('具名凭据键的值被掩码（JSON / k=v / Bearer / JWT 四种形态）', () => {
    const out = redactSecrets(
      JSON.stringify({
        token: 'SUPERSECRETVALUE123',
        Authorization: 'Bearer abcdefghijklmnop',
        password: 'p@ssw0rd',
      }),
    );
    assert.ok(!out.includes('SUPERSECRETVALUE123'), 'token 明文必须消失');
    assert.ok(!out.includes('abcdefghijklmnop'), 'Bearer 明文必须消失');
    assert.ok(!out.includes('p@ssw0rd'), 'password 明文必须消失');
    assert.ok(out.includes('REDACTED'));

    assert.ok(!redactSecrets('apiKey=AAAA1111BBBB2222').includes('AAAA1111BBBB2222'));
    assert.ok(!redactSecrets('authorization: Bearer xyzxyzxyz').includes('xyzxyzxyz'));
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456';
    assert.ok(!redactSecrets(`t=${jwt}`).includes(jwt), 'JWT 形态应被掩码');
  });

  test('无命名高熵长串（≥40 含字母+数字）被掩码；短串/纯数字不受影响', () => {
    const opaque = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    assert.ok(!redactSecrets(`raw=${opaque}`).includes(opaque));
    assert.equal(redactSecrets('short=abc123'), 'short=abc123');
    assert.equal(redactSecrets('num=12345678901234567890123456789012345678901234'), 'num=12345678901234567890123456789012345678901234');
  });
});

describe('CL-018 T03 · ConsoleLogger 白名单字段裁剪', () => {
  test('提供 metaAllowlist 时，未登记键（params 等原始载荷）不落盘', () => {
    const got = [];
    const l = new ConsoleLogger({
      level: 'debug',
      metaAllowlist: ['traceId'],
      redact: true,
      sink: (line) => got.push(line),
    });
    l.info('m', { traceId: 't1', params: { token: 'LEAKME1234' } });
    assert.equal(got.length, 1);
    const entry = JSON.parse(got[0]);
    assert.equal(entry.traceId, 't1');
    assert.equal(entry.params, undefined, 'params 应被白名单裁掉');
    assert.ok(!got[0].includes('LEAKME1234'));
  });

  test('未提供 metaAllowlist 时保持旧行为（不过滤）', () => {
    const got = [];
    const l = new ConsoleLogger({ level: 'debug', redact: false, sink: (line) => got.push(line) });
    l.info('m', { anything: 1 });
    assert.equal(JSON.parse(got[0]).anything, 1);
  });
});

describe('CL-018 T03 · 落盘有效性 / 命名（AC3.1、AC3.2）', () => {
  test('写入后可 flush 到 `winvm-service-YYYY-MM-DD.log`，含 ts/level/msg', () => {
    const dir = sub('basic');
    const logger = createFileLogger(
      { dir, level: 'info', maxBytes: 10 * 1024 * 1024, maxFiles: 7, maxDays: 14 },
      { mirrorToStderr: false },
    );
    logger.info('服务已启动', { port: 18443 });
    logger.flush();
    logger.close();

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^winvm-service-\d{4}-\d{2}-\d{2}\.log$/);
    const entry = JSON.parse(linesOf(join(dir, files[0]))[0]);
    assert.equal(entry.msg, '服务已启动');
    assert.equal(entry.level, 'info');
    assert.equal(entry.port, 18443);
    assert.ok(typeof entry.ts === 'string' && entry.ts.includes('T'), '应含 ISO 时间戳');
  });

  test('定时器 unref：仅创建 sink 不会阻止进程退出', () => {
    const dir = sub('unref');
    const sink = new RotatingFileSink({ dir, flushIntervalMs: 50 });
    assert.ok(!sink.status().degraded);
    sink.close();
  });
});

describe('CL-018 T03 · 轮转 / 保留（AC3.3）', () => {
  test('超单文件上限即轮转出新文件，旧内容保留在归档里', () => {
    const dir = sub('rotate');
    const sink = new RotatingFileSink({ dir, maxBytes: 300, maxFiles: 20, maxDays: 14, flushThreshold: 1 });
    for (let i = 0; i < 12; i++) {
      sink.write(`{"i":${i},"pad":"${'x'.repeat(60)}"}`);
      sink.flush();
    }
    sink.close();
    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    assert.ok(files.length >= 2, `应发生轮转，实际文件：${files.join(', ')}`);
    assert.ok(files.some((f) => /\.\d+\.log$/.test(f)), '应存在序号归档文件');
  });

  test('保留上限：maxFiles=2 时最旧文件被删', () => {
    const dir = sub('prune');
    // 预置 5 个日志文件，并**显式设置递增 mtime** —— 不能依赖「刚写入」的 mtime
    // （同毫秒内创建会并列，排序不稳定，测试会随机红）。
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `winvm-service-2026-09-0${i + 1}.log`);
      writeFileSync(p, `old-${i}\n`, 'utf8');
      const t = new Date(Date.UTC(2026, 8, i + 1));
      utimesSync(p, t, t);
    }
    const sink = new RotatingFileSink({ dir, maxFiles: 2, maxDays: 3650, flushThreshold: 1 });
    sink.prune();
    sink.close();
    const left = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    assert.deepEqual(left, ['winvm-service-2026-09-04.log', 'winvm-service-2026-09-05.log'], `应保留最新 2 个，实际：${left.join(', ')}`);
  });

  test('保留上限：maxDays 超期的旧文件被删', () => {
    const dir = sub('prune-days');
    const old = join(dir, 'winvm-service-2000-01-01.log');
    writeFileSync(old, 'ancient\n', 'utf8');
    // 显式把 mtime 拨回 2000 年（否则刚写入的文件 mtime 是「现在」，不构成超期）
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(old, ancient, ancient);
    const sink = new RotatingFileSink({ dir, maxFiles: 99, maxDays: 1 });
    sink.prune();
    sink.close();
    assert.equal(existsSync(old), false, '超期文件应被删除');
  });
});

describe('CL-018 T03 · 失败降级（AC3.5 硬要求）', () => {
  test('日志目录不可写时构造不抛错，status().degraded=true 且给出 reason', () => {
    const dir = sub('degraded');
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf8'); // 用「同名普通文件」让 mkdir/写入失败
    let logger;
    assert.doesNotThrow(() => {
      logger = createFileLogger(
        { dir: asFile, level: 'info', maxBytes: 1024, maxFiles: 7, maxDays: 14 },
        { mirrorToStderr: false },
      );
    }, '目录不可写绝不阻断服务启动');
    const st = logger.logging();
    assert.equal(st.degraded, true);
    assert.ok(st.reason && st.reason.length > 0, '应给出降级原因');
    assert.doesNotThrow(() => {
      logger.info('仍可调用');
      logger.flush();
    }, '降级后写日志不得抛错');
    logger.close();
  });

  test('降级 sink 的 write/flush 为静默 no-op（不抛错、不产生文件）', () => {
    const dir = sub('degraded2');
    const asFile = join(dir, 'blocker');
    writeFileSync(asFile, 'x', 'utf8');
    const sink = new RotatingFileSink({ dir: asFile });
    assert.equal(sink.status().degraded, true);
    assert.doesNotThrow(() => {
      sink.write('{"a":1}');
      sink.flush();
      sink.prune();
      sink.close();
    });
  });
});

describe('CL-018 T03 · FileLogger 双写与脱敏端到端（AC3.6）', () => {
  test('含已知 token 的请求日志：文件 0 命中，且 stderr 镜像同样脱敏', () => {
    const dir = sub('e2e');
    const stderrLines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(String(chunk));
      return true;
    };
    try {
      const logger = new FileLogger({ dir, level: 'info', flushThreshold: 1 });
      logger.info('请求处理异常', {
        path: '/mcp',
        error: 'Authorization: Bearer KNOWNTOKEN-abcdefghijklmnop',
        params: { token: 'KNOWNTOKEN-abcdefghijklmnop' },
      });
      logger.flush();
      logger.close();
    } finally {
      process.stderr.write = orig;
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    assert.equal(files.length, 1);
    const content = readFileSync(join(dir, files[0]), 'utf8');
    assert.ok(!content.includes('KNOWNTOKEN-abcdefghijklmnop'), '日志文件不得含已知 token');
    assert.ok(content.includes('REDACTED'));
    assert.ok(!content.includes('"params"'), 'params 字段应被白名单裁掉');
    assert.ok(
      stderrLines.every((l) => !l.includes('KNOWNTOKEN-abcdefghijklmnop')),
      'stderr 镜像同样不得含已知 token',
    );
  });

  test('child() 派生 logger 仍写入同一文件（框架侧子 logger 不丢日志）', () => {
    const dir = sub('child');
    const logger = createFileLogger(
      { dir, level: 'info', maxBytes: 10 * 1024 * 1024, maxFiles: 7, maxDays: 14 },
      { mirrorToStderr: false },
    );
    const child = logger.child({ module: 'ps-bridge' });
    child.warn('子 logger 写入', { count: 2 });
    logger.flush();
    logger.close();
    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    const content = readFileSync(join(dir, files[0]), 'utf8');
    assert.ok(content.includes('子 logger 写入'));
    assert.ok(content.includes('ps-bridge'));
  });
});
