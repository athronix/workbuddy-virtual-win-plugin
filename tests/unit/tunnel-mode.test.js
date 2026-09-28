#!/usr/bin/env node
/**
 * tunnel-mode 通道模式配置单测
 *
 * 覆盖：
 *   - resolveTunnelMode（CLI 内联实现）：默认 / 合法三值 / 大小写 / 空白 / 非法回落 + warning
 *   - resolveTunnelModeFromSources：优先级 argv(--tunnel-mode) > env WINVM_TUNNEL_MODE
 *     > vm-conn.json 的 tunnelMode > 默认 mcp；来源标注（flag/env/vm-conn/default）
 *   - 与 packages/core 常量字面量一致（跨层静态对齐，防漂移）
 *   - resolveVmConn 的 tunnelMode 集成：非法持久化值回落 mcp，其余连接字段不受影响
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTunnelMode,
  resolveTunnelModeFromSources,
  resolveVmConn,
} from '../../delivery/winvm-plugin.mjs';

const CORE_CONSTANTS = readFileSync(
  join(import.meta.dirname, '..', '..', 'packages', 'core', 'src', 'constants.ts'),
  'utf8',
);

describe('tunnel-mode · resolveTunnelMode（单值解析）', () => {
  test('空/undefined/null → 默认 mcp，无 warning', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = resolveTunnelMode(raw);
      assert.equal(r.mode, 'mcp', `raw=${JSON.stringify(raw)}`);
      assert.equal(r.warning, undefined);
    }
  });

  test('合法三值逐一命中', () => {
    assert.deepEqual(resolveTunnelMode('mcp'), { mode: 'mcp' });
    assert.deepEqual(resolveTunnelMode('a2a'), { mode: 'a2a' });
    assert.deepEqual(resolveTunnelMode('intelligent'), { mode: 'intelligent' });
  });

  test('大小写混合 + 首尾空白 → 归一化命中', () => {
    assert.equal(resolveTunnelMode('  MCP ').mode, 'mcp');
    assert.equal(resolveTunnelMode('A2A').mode, 'a2a');
    assert.equal(resolveTunnelMode('\tIntelligent\n').mode, 'intelligent');
  });

  test('非法值 → 回落 mcp 且携带告警（含原始值）', () => {
    const r = resolveTunnelMode('auto');
    assert.equal(r.mode, 'mcp');
    assert.ok(r.warning.includes('auto'), r.warning);
    assert.ok(r.warning.includes('mcp/a2a/intelligent'), r.warning);
  });
});

describe('tunnel-mode · resolveTunnelModeFromSources（来源优先级）', () => {
  test('全缺省 → default 来源 mcp，无 warning', () => {
    assert.deepEqual(resolveTunnelModeFromSources({}), { mode: 'mcp', source: 'default' });
  });

  test('argv 最高优先：覆盖 env / persisted', () => {
    const r = resolveTunnelModeFromSources({
      argv: { tunnelMode: 'a2a' },
      env: { WINVM_TUNNEL_MODE: 'mcp' },
      persisted: { tunnelMode: 'intelligent' },
    });
    assert.equal(r.mode, 'a2a');
    assert.equal(r.source, 'flag');
  });

  test('env 次之：覆盖 persisted，低于 argv', () => {
    const r = resolveTunnelModeFromSources({
      argv: {},
      env: { WINVM_TUNNEL_MODE: 'intelligent' },
      persisted: { tunnelMode: 'a2a' },
    });
    assert.equal(r.mode, 'intelligent');
    assert.equal(r.source, 'env');
  });

  test('persisted 兜底：仅 argv/env 全缺时生效', () => {
    const r = resolveTunnelModeFromSources({ argv: {}, env: {}, persisted: { tunnelMode: 'a2a' } });
    assert.equal(r.mode, 'a2a');
    assert.equal(r.source, 'vm-conn');
  });

  test('非法值逐级回落 mcp 并保留来源与告警', () => {
    for (const [input, source] of [
      [{ tunnelMode: 'bogus' }, 'flag'],
      [{}, 'env'],
      [{}, 'vm-conn'],
    ]) {
      const env = source === 'env' ? { WINVM_TUNNEL_MODE: 'bogus' } : {};
      const persisted = source === 'vm-conn' ? { tunnelMode: 'bogus' } : {};
      const r = resolveTunnelModeFromSources({ argv: input, env, persisted });
      assert.equal(r.mode, 'mcp');
      assert.equal(r.source, source);
      assert.ok(r.warning?.includes('bogus'), r.warning);
    }
  });

  test('空字符串不视作显式来源：argv.tunnelMode="" / env 空串 → 逐级下沉', () => {
    const r = resolveTunnelModeFromSources({
      argv: { tunnelMode: '' },
      env: { WINVM_TUNNEL_MODE: '' },
      persisted: { tunnelMode: 'intelligent' },
    });
    assert.equal(r.mode, 'intelligent');
    assert.equal(r.source, 'vm-conn');
  });
});

describe('tunnel-mode · resolveVmConn 集成', () => {
  test('resolveVmConn 透出 tunnelMode + tunnelModeSource（persisted 命中）', () => {
    const r = resolveVmConn({
      argv: {},
      env: {},
      dotEnv: {},
      persisted: { host: 'h', tunnelMode: 'intelligent' },
    });
    assert.equal(r.tunnelMode, 'intelligent');
    assert.equal(r.tunnelModeSource, 'vm-conn');
    assert.equal(r.host, 'h'); // 既有字段不受影响
  });

  test('resolveVmConn：persisted 非法 tunnelMode → 回落 mcp + warning', () => {
    const r = resolveVmConn({
      argv: {},
      env: {},
      dotEnv: {},
      persisted: { tunnelMode: 'whatever' },
    });
    assert.equal(r.tunnelMode, 'mcp');
    assert.equal(r.tunnelModeSource, 'vm-conn');
    assert.ok(r.tunnelModeWarning?.includes('whatever'), r.tunnelModeWarning);
  });

  test('resolveVmConn：全缺省 → mcp + default 来源，无 warning', () => {
    const r = resolveVmConn({});
    assert.equal(r.tunnelMode, 'mcp');
    assert.equal(r.tunnelModeSource, 'default');
    assert.equal(r.tunnelModeWarning, undefined);
  });
});

describe('tunnel-mode · 跨层一致性（静态对齐 core 常量）', () => {
  test('CLI 内联 TUNNEL_MODES 与 packages/core/src/constants.ts 字面量一致', () => {
    const cliSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'delivery', 'winvm-plugin.mjs'),
      'utf8',
    );
    const cliMatch = cliSrc.match(/const TUNNEL_MODES = \[([^\]]+)\]/);
    assert.ok(cliMatch, 'delivery/winvm-plugin.mjs 应内联声明 TUNNEL_MODES');
    const cliModes = cliMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));

    const coreMatch = CORE_CONSTANTS.match(/TUNNEL_MODES[^=]*= \[([^\]]+)\]/);
    assert.ok(coreMatch, 'packages/core/src/constants.ts 应声明 TUNNEL_MODES');
    const coreModes = coreMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));

    assert.deepEqual(cliModes, coreModes);
    assert.deepEqual(coreModes, ['mcp', 'a2a', 'intelligent']);
  });

  test('CLI 内联 ENV 名与 core 的 ENV_TUNNEL_MODE 一致', () => {
    assert.ok(CORE_CONSTANTS.includes("export const ENV_TUNNEL_MODE = 'WINVM_TUNNEL_MODE'"));
    const cliSrc = readFileSync(
      join(import.meta.dirname, '..', '..', 'delivery', 'winvm-plugin.mjs'),
      'utf8',
    );
    assert.ok(cliSrc.includes("const ENV_TUNNEL_MODE = 'WINVM_TUNNEL_MODE'"));
  });
});
