/**
 * CL-017 D23 · PS 领域错误码分层（单元测试）
 *
 * 背景：psmod 内 35 处 `throw "UPPER_SNAKE: msg"`（FILE_NOT_FOUND / CLI_NOT_FOUND /
 * SERVICE_NOT_FOUND ...）。旧 `toBridgeError()` 只有 9 项白名单，领域码全部被压成
 * `EXECUTION_FAILED` 且**码丢失** → 调用方无法按原因路由补救动作。
 *
 * 现语义：`error.code` = 契约层封闭码集（单源 errors.ts，决定重试 / 审批）；
 *         `error.reason` = 领域层原因码（决定具体补救动作）。
 *
 * 本测试经 **公开路径** `execute()`（真实调用点 `catch → toBridgeError`）验证，
 * 不依赖私有方法名。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PS_BRIDGE = join(__dirname, '..', '..', 'packages', 'vm-capabilities', 'psmod', 'ps-bridge.ps1');

/** 构造一个「注入式桥」的 provider：其 bridge.call 一律抛出给定错误 */
async function providerThatThrows(err) {
  const bridge = {
    running: true,
    uptimeMs: 1,
    async start() {},
    async stop() {},
    async call() {
      throw err;
    },
    health() {
      return { state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 0 };
    },
  };
  const ctx = {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'aud_x' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: () => ({ risk: 'L1', requiresSession: false }),
      list: () => ['storage.file.read'],
      has: () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bridge,
    newTraceId: () => 'tr_test',
  };
  const p = new DeterministicAgentProvider({});
  await p.init(ctx);
  return p;
}

/** 执行一次必然失败的能力调用，返回规范化后的 error 对象 */
async function normalizedError(err) {
  const p = await providerThatThrows(err);
  const res = await p.execute({
    traceId: 'tr_test',
    capabilityId: 'storage.file.read',
    params: {},
    risk: 'L1',
    approved: false,
    timeoutMs: 1000,
  });
  assert.equal(res.ok, false, '应返回失败');
  return res.error;
}

const CONTRACT_CODES = [
  'INVALID_PARAMS',
  'UNKNOWN_CAPABILITY',
  'UNSUPPORTED_GOAL',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'SESSION_UNAVAILABLE',
  'SESSION_BLACK_SCREEN',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'EXECUTION_FAILED',
];

describe('CL-017 D23 · 领域错误码分层（code + reason）', () => {
  test('契约层封闭码集原样透传（code 不变、message 不变、不带 reason）', async () => {
    for (const code of CONTRACT_CODES) {
      const e = await normalizedError({ code, message: `${code} 说明` });
      assert.equal(e.code, code, `code 应原样透传：${code}`);
      assert.equal(e.message, `${code} 说明`, `message 应保留：${code}`);
      assert.equal(e.reason, undefined, `${code} 不应带 reason`);
    }
  });

  test('FILE_NOT_FOUND → EXECUTION_FAILED + reason=FILE_NOT_FOUND（不再丢码）', async () => {
    const e = await normalizedError({
      code: 'FILE_NOT_FOUND',
      message: 'FILE_NOT_FOUND: C:\\Users\\User\\__nope__.txt',
    });
    assert.equal(e.code, 'EXECUTION_FAILED');
    assert.equal(e.reason, 'FILE_NOT_FOUND');
    assert.ok(e.message.includes('FILE_NOT_FOUND'), 'message 应保留原始文本');
  });

  test('其它领域码 → EXECUTION_FAILED + 原领域码入 reason', async () => {
    for (const code of [
      'SERVICE_NOT_FOUND',
      'CLI_NOT_FOUND',
      'PATH_NOT_FOUND',
      'PROCESS_NOT_FOUND',
      'WINDOW_NOT_FOUND',
      'ELEMENT_NOT_FOUND',
      'WINGET_NOT_FOUND',
      'REG_PATH_NOT_FOUND',
      'FILE_TOO_LARGE',
      'COM_NOT_FOUND',
      'UNSUPPORTED_APP',
    ]) {
      const e = await normalizedError({ code, message: `${code}: detail` });
      assert.equal(e.code, 'EXECUTION_FAILED', `base code: ${code}`);
      assert.equal(e.reason, code, `reason: ${code}`);
    }
  });

  test('INVALID_ARGUMENT / INVALID_RECT → INVALID_PARAMS + reason', async () => {
    for (const code of ['INVALID_ARGUMENT', 'INVALID_RECT']) {
      const e = await normalizedError({ code, message: `${code}: bad` });
      assert.equal(e.code, 'INVALID_PARAMS', `base code: ${code}`);
      assert.equal(e.reason, code, `reason: ${code}`);
    }
  });

  test('TIMEOUT → TIMEOUT（retryable=true；TIMEOUT 本身就是契约码，故不带 reason）', async () => {
    const e = await normalizedError({ code: 'TIMEOUT', message: 'TIMEOUT: ps-bridge 无响应' });
    assert.equal(e.code, 'TIMEOUT');
    // TIMEOUT 属于契约层封闭码集 → 走「原样透传」分支，无需再记 reason（原因即 code 本身）
    assert.equal(e.reason, undefined);
    assert.equal(e.retryable, true);
  });

  test('领域码透传 details（含上游 exceptionType）', async () => {
    const e = await normalizedError({
      code: 'CLI_NOT_FOUND',
      message: 'CLI_NOT_FOUND: 未找到 ffmpeg.exe',
      details: { exceptionType: 'RuntimeException' },
    });
    assert.equal(e.reason, 'CLI_NOT_FOUND');
    assert.deepEqual(e.details, { exceptionType: 'RuntimeException' });
  });

  test('兜底：非法 / 缺失 code / 普通 Error → EXECUTION_FAILED 且不带 reason', async () => {
    const cases = [
      { code: 'not a code', message: 'boom' }, // 含空格小写 → 非领域码形态
      { code: 'lowercase_code', message: 'boom' }, // 非大写首字母
      { code: 'AB', message: 'boom' }, // 长度不足 3
      { message: 'boom2' }, // 无 code
      new Error('plain error'), // 普通异常
      'just a string',
    ];
    for (const c of cases) {
      const e = await normalizedError(c);
      assert.equal(e.code, 'EXECUTION_FAILED', `兜底 code: ${JSON.stringify(c)}`);
      assert.equal(e.reason, undefined, `兜底不应带 reason: ${JSON.stringify(c)}`);
    }
  });
});

/**
 * CL-017 D25-② · PS 参数绑定异常 → INVALID_ARGUMENT（纵深防御）
 *
 * ps-bridge.ps1 在 catch 中把「PowerShell 参数绑定失败」归一为领域码 `INVALID_ARGUMENT`
 * （仅按异常类型判定）。本组从**契约链路**与**PS 源码静态**两面锁住该行为，并加反向对照，
 * 防止把真实执行失败误判为 INVALID_PARAMS。
 */
describe('CL-017 D25-② · PS 参数绑定异常 → INVALID_ARGUMENT', () => {
  test('契约链路：code=INVALID_ARGUMENT + details.exceptionType → INVALID_PARAMS + reason（details 保留）', async () => {
    const excType = 'System.Management.Automation.ParameterBindingArgumentTransformationException';
    const e = await normalizedError({
      code: 'INVALID_ARGUMENT',
      message: 'INVALID_ARGUMENT: 无法处理对参数“Top”的参数转换。',
      details: { exceptionType: excType },
    });
    assert.equal(e.code, 'INVALID_PARAMS', '对外契约码应为 INVALID_PARAMS（与 D24 同形）');
    assert.equal(e.reason, 'INVALID_ARGUMENT');
    assert.equal(e.retryable, false, 'INVALID_PARAMS 不可重试');
    assert.deepEqual(e.details, { exceptionType: excType }, 'details.exceptionType 应原样保留');
    assert.ok(e.message.startsWith('INVALID_ARGUMENT:'), 'message 应带领域码前缀');
  });

  test('反向对照：真实执行失败（无领域码）不得被判为 INVALID_PARAMS', async () => {
    // 真实执行失败：命令不存在 / 运行时异常 —— 无 `CODE:` 前缀
    const e = await normalizedError({ code: 'EXECUTION_FAILED', message: '命令不存在或执行失败' });
    assert.equal(e.code, 'EXECUTION_FAILED');
    assert.equal(e.reason, undefined);
    assert.notEqual(e.code, 'INVALID_PARAMS', '不得把执行失败误判为参数错误');
  });

  test('静态：ps-bridge.ps1 仅按异常类型判定（含派生类），映射为 INVALID_ARGUMENT 且不引入新领域码', () => {
    const src = readFileSync(PS_BRIDGE, 'utf8');

    assert.ok(src.includes('function Test-ParameterBindingException'), '应含参数绑定异常判定函数');
    assert.ok(
      src.includes('[System.Management.Automation.ParameterBindingException]'),
      '必须按**异常类型**判定（ParameterBindingException 及其派生类）',
    );
    // 异常链遍历（InnerException）以防止绑定异常被包装
    assert.ok(src.includes('$e.InnerException'), '应遍历 InnerException 链');
    // 映射为 INVALID_ARGUMENT
    assert.ok(
      /Test-ParameterBindingException -Exception \$ex\)\s*\{\s*\$code = 'INVALID_ARGUMENT'/.test(src),
      '参数绑定异常应映射为领域码 INVALID_ARGUMENT',
    );
    // message 前缀
    assert.ok(src.includes("'INVALID_ARGUMENT: ' + $msg"), 'message 应补 INVALID_ARGUMENT: 前缀');
    // 不得引入新领域码
    assert.ok(!/PARAMETER_BINDING_[A-Z_]*\s*:/.test(src) && !src.includes("'PARAMETER_BINDING"), '不得引入新领域码');
    // 不得用「消息含 parameter 字样」这类模糊匹配
    assert.ok(!/-match\s+'[^']*[Pp]arameter/.test(src), '禁止对异常消息做模糊匹配');
    assert.ok(!/-like\s+'[^']*[Pp]arameter/.test(src), '禁止对异常消息做模糊匹配');
  });
});
