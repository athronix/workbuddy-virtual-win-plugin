/**
 * CL-018 T05 · C2 A2A 委派超时（env 覆盖 + 冷启动文案）
 *
 * - env 解析逻辑位于 `@winvm/core` 的 `resolveA2aTimeoutMs`（优先级 CLI > env > 默认）→ 功能测试；
 * - `cli.ts` / `install-host.mjs` 的接线为静态守卫（parseArgs 未导出，故锁源码形态）；
 * - 超时文案（AC2.2）静态守卫：须提及「正常冷启动窗口（75–107s）」，**严禁**「已修复/已解决」类承诺。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { A2A_TIMEOUT_MS_DEFAULT, ENV_A2A_TIMEOUT_MS, resolveA2aTimeoutMs } from '@winvm/core';
import { buildTransport, main } from '@winvm/host-a2a-bridge';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

describe('CL-018 C2 · 委派超时（默认 / env / 非法回退）', () => {
  test('默认 600000（≥150s，不得回退）', () => {
    assert.equal(A2A_TIMEOUT_MS_DEFAULT, 600_000);
    assert.equal(resolveA2aTimeoutMs({}), 600_000);
    assert.equal(ENV_A2A_TIMEOUT_MS, 'WINVM_A2A_TIMEOUT_MS');
  });

  test('env 覆盖生效；非法值回退默认（服务不得因坏 env 失败）', () => {
    assert.equal(resolveA2aTimeoutMs({ [ENV_A2A_TIMEOUT_MS]: '900000' }), 900_000);
    assert.equal(resolveA2aTimeoutMs({ [ENV_A2A_TIMEOUT_MS]: 'abc' }), 600_000);
    assert.equal(resolveA2aTimeoutMs({ [ENV_A2A_TIMEOUT_MS]: '0' }), 600_000);
    assert.equal(resolveA2aTimeoutMs({ [ENV_A2A_TIMEOUT_MS]: '-5' }), 600_000);
  });

  test('cli.ts：`--timeout` 覆盖 env（CLI > env > 默认）', () => {
    const cli = read('packages', 'host-a2a-bridge', 'src', 'cli.ts');
    assert.ok(cli.includes('resolveA2aTimeoutMs(process.env)'), 'cli 应以 env（或默认）打底');
    assert.ok(cli.includes("case '--timeout'"), 'cli 应解析 --timeout（最高优先级）');
    assert.ok(cli.includes('ENV_A2A_TIMEOUT_MS'), 'usage 应展示 env 名');
  });

  test('buildTransport 透传 timeoutMs', () => {
    const t = buildTransport({
      endpoint: 'http://127.0.0.1:18443',
      a2aPath: '/a2a',
      timeoutMs: 654_321,
      maxRisk: 'L1',
      tokenEnv: '',
      help: false,
    });
    assert.equal(t.timeoutMs, 654_321);
  });

  test('usage 文本提及冷启动与 env（--help 功能性验证）', async () => {
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
    assert.ok(buf.includes(ENV_A2A_TIMEOUT_MS), 'usage 应提及 WINVM_A2A_TIMEOUT_MS');
    assert.ok(buf.includes('冷启动'), 'usage 应说明冷启动语义');
  });

  test('AC2.2 超时文案：提及「正常冷启动窗口（75–107s）」，且无「已修复/已解决」承诺', () => {
    const tools = read('packages', 'host-a2a-bridge', 'src', 'tools.ts');
    assert.ok(tools.includes('正常冷启动窗口'), '超时文案应说明正常冷启动窗口');
    assert.ok(tools.includes('75–107s'), '应给出真机冷启动区间 75–107s');
    // 负向守卫针对**实际会回传宿主/用户的文本**：先剥离注释（注释中可出现这些词用于自我约束说明）
    const code = tools.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!code.includes('已修复'), '严禁在回传文本中出现「已修复」类承诺措辞');
    assert.ok(!code.includes('已解决'), '严禁在回传文本中出现「已解决」类承诺措辞');
  });

  test('install-host.mjs：落点时间取 env，并写入连接器 --timeout/timeoutMs', () => {
    const ih = read('delivery', 'install-host.mjs');
    assert.ok(ih.includes('WINVM_A2A_TIMEOUT_MS'), 'install-host 应读取 WINVM_A2A_TIMEOUT_MS');
    assert.ok(ih.includes('resolveA2aTimeoutFromEnv'), '应有 env 解析函数');
    assert.ok(ih.includes("'--timeout',"), '应把 --timeout 写入连接器 args');
    assert.ok(ih.includes('timeoutMs: args.a2aTimeoutMs'), '连接器 timeoutMs 应取解析结果');
  });
});
