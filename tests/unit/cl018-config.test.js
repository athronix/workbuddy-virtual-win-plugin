/**
 * CL-018 T01 · 服务配置增量（logging / llmSession）
 *
 * 覆盖：
 *   - DEFAULT_SERVICE_CONFIG 含新段（出厂默认 = 验收基线）
 *   - loadServiceConfig 保留新段（字段级合并，不得丢字段）
 *   - resolveServiceConfig 展开 %ENV% 目录 + **优先级 env > 配置文件 > 内置默认**
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SERVICE_CONFIG,
  loadServiceConfig,
  resolveServiceConfig,
  validateServiceConfig,
} from '@winvm/core';

const BASE = join(import.meta.dirname, '..', 'fixtures', 'cl018-config');
mkdirSync(BASE, { recursive: true });
const tmp = mkdtempSync(join(BASE, 'cfg-'));

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('CL-018 T01 · 配置默认段', () => {
  test('DEFAULT_SERVICE_CONFIG 含 logging / llmSession，且为验收基线值', () => {
    const c = DEFAULT_SERVICE_CONFIG;
    assert.ok(c.logging, '应有 logging 段');
    assert.equal(c.logging.maxBytes, 10 * 1024 * 1024);
    assert.equal(c.logging.maxFiles, 7);
    assert.equal(c.logging.maxDays, 14);
    assert.equal(c.logging.level, 'info');
    assert.deepEqual(c.llmSession, {
      enabled: true,
      sessionId: 'winvm-persistent',
      idleTtlMs: 300_000,
      readyTimeoutMs: 60_000,
      maxRestarts: 5,
      maxWsBytes: 512 * 1024 * 1024,
      warmupReadyMs: 180_000,
    });
  });

  test('validateServiceConfig 不受新段影响（既有校验不变）', () => {
    const v = validateServiceConfig(DEFAULT_SERVICE_CONFIG);
    assert.deepEqual(v.errors, []);
  });
});

describe('CL-018 T01 · loadServiceConfig 保留新段', () => {
  test('JSON 未含新段时沿用默认；含新段时字段级合并', async () => {
    const p = join(tmp, 'svc.json');
    writeFileSync(
      p,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 19999 },
        logging: { level: 'warn' },
        llmSession: { idleTtlMs: 120000 },
      }),
      'utf8',
    );
    const cfg = await loadServiceConfig(p);
    assert.equal(cfg.server.port, 19999);
    // 只覆盖显式给出的字段，其余保留默认（防止丢字段 → 运行期 undefined）
    assert.equal(cfg.logging.level, 'warn');
    assert.equal(cfg.logging.maxBytes, 10 * 1024 * 1024);
    assert.equal(cfg.logging.maxFiles, 7);
    assert.equal(cfg.llmSession.idleTtlMs, 120_000);
    assert.equal(cfg.llmSession.sessionId, 'winvm-persistent');
    assert.equal(cfg.llmSession.maxRestarts, 5);
  });
});

describe('CL-018 T01 · resolveServiceConfig 目录展开与 env 优先级', () => {
  test('logging.dir 走 expandEnvPath + 绝对化（%LOCALAPPDATA% 已设时被展开）', () => {
    const cfg = resolveServiceConfig(DEFAULT_SERVICE_CONFIG, { LOCALAPPDATA: 'C:/Users/User/AppData/Local' });
    assert.ok(cfg.logging.dir.endsWith(join('AppData', 'Local', 'WinVMBridge', 'logs')), cfg.logging.dir);
    assert.ok(!cfg.logging.dir.includes('%LOCALAPPDATA%'), '占位符应已展开');
  });

  test('优先级：env > 配置文件 > 内置默认（env 未设时不得用默认盖掉配置值）', () => {
    const custom = {
      ...DEFAULT_SERVICE_CONFIG,
      logging: { ...DEFAULT_SERVICE_CONFIG.logging, level: 'error', maxFiles: 3 },
      llmSession: { ...DEFAULT_SERVICE_CONFIG.llmSession, idleTtlMs: 111_111 },
    };
    // ① 未设 env → 保留配置文件里的显式值
    const noEnv = resolveServiceConfig(custom, {});
    assert.equal(noEnv.logging.level, 'error');
    assert.equal(noEnv.logging.maxFiles, 3);
    assert.equal(noEnv.llmSession.idleTtlMs, 111_111);

    // ② 设 env → env 覆盖配置文件
    const withEnv = resolveServiceConfig(custom, {
      WINVM_LOG_LEVEL: 'debug',
      WINVM_LOG_MAX_FILES: '9',
      WINVM_LLM_SESSION_IDLE_MS: '222222',
    });
    assert.equal(withEnv.logging.level, 'debug');
    assert.equal(withEnv.logging.maxFiles, 9);
    assert.equal(withEnv.llmSession.idleTtlMs, 222_222);
  });

  test('WINVM_LOG_DIR 覆盖目标目录（相对路径也绝对化）', () => {
    const cfg = resolveServiceConfig(DEFAULT_SERVICE_CONFIG, { WINVM_LOG_DIR: 'rel/logs-here' });
    assert.ok(cfg.logging.dir.endsWith(join('rel', 'logs-here')), cfg.logging.dir);
    assert.ok(cfg.logging.dir.startsWith('/') || /^[A-Za-z]:/.test(cfg.logging.dir), '应为绝对路径');
  });

  test('WINVM_LLM_PERSISTENT=0 可禁用常驻会话（排障/回滚通道）', () => {
    assert.equal(resolveServiceConfig(DEFAULT_SERVICE_CONFIG, { WINVM_LLM_PERSISTENT: '0' }).llmSession.enabled, false);
    assert.equal(resolveServiceConfig(DEFAULT_SERVICE_CONFIG, {}).llmSession.enabled, true);
  });
});
