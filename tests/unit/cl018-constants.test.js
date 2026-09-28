/**
 * CL-018 T01 · 共享常量与 env 解析（单一事实来源）
 *
 * 覆盖：
 *   - 解析器容错（非法值回退默认，绝不抛错）
 *   - C1/C2/C3/C5 默认值与验收基线一致（600000 / 300000 / 45000 / 10MB / 7 / 14 / info）
 *   - env 覆盖生效
 *   - TS 侧 env 名与 PowerShell 侧（psmod）**字面量一致**（跨语言静态扫描，防漂移）
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_TIMEOUT_MS_DEFAULT,
  ENV_A2A_TIMEOUT_MS,
  ENV_APPOPS_EXCLUDE_PROCS,
  ENV_APPOPS_EXCLUDE_TITLE_PATTERNS,
  ENV_LLM_SESSION_IDLE_MS,
  ENV_NETCFG_TTL_MS,
  LLM_SESSION_IDLE_MS_DEFAULT,
  LLM_SESSION_MAX_RESTARTS_DEFAULT,
  LLM_SESSION_MAX_WS_BYTES_DEFAULT,
  LLM_SESSION_READY_MS_DEFAULT,
  LOG_FILE_PREFIX,
  LOG_LEVEL_DEFAULT,
  LOG_MAX_BYTES_DEFAULT,
  LOG_MAX_DAYS_DEFAULT,
  LOG_MAX_FILES_DEFAULT,
  NETCFG_TTL_MS_DEFAULT,
  parseBoolean,
  parseLogLevel,
  parsePositiveInt,
  resolveA2aTimeoutMs,
  resolveLlmSessionConfig,
  resolveLoggingConfig,
  resolveNetCfgTtlMs,
} from '@winvm/core';

const PSMOD = join(import.meta.dirname, '..', '..', 'packages', 'vm-capabilities', 'psmod');

describe('CL-018 T01 · 通用解析容错', () => {
  test('parsePositiveInt：非法/非正/NaN → 回退默认；正数 → 取整', () => {
    assert.equal(parsePositiveInt(undefined, 42), 42);
    assert.equal(parsePositiveInt('', 42), 42);
    assert.equal(parsePositiveInt('abc', 42), 42);
    assert.equal(parsePositiveInt('0', 42), 42);
    assert.equal(parsePositiveInt('-5', 42), 42);
    assert.equal(parsePositiveInt('123.9', 42), 123);
    assert.equal(parsePositiveInt('5000', 42), 5000);
  });

  test('parseBoolean：1/true/yes/on → true；0/false/no/off → false；其余回退', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(parseBoolean(v, false), true, v);
    for (const v of ['0', 'false', 'no', 'off']) assert.equal(parseBoolean(v, true), false, v);
    assert.equal(parseBoolean('maybe', true), true);
    assert.equal(parseBoolean(undefined, true), true);
  });

  test('parseLogLevel：已知级别小写归一回显；未知回退', () => {
    assert.equal(parseLogLevel('WARN', 'info'), 'warn');
    assert.equal(parseLogLevel('debug', 'info'), 'debug');
    assert.equal(parseLogLevel('verbose', 'info'), 'info');
    assert.equal(parseLogLevel(undefined, 'error'), 'error');
  });
});

describe('CL-018 T01 · 默认值 = 验收基线（不得回退）', () => {
  test('C3 日志默认：10MB / 7 文件 / 14 天 / info', () => {
    const cfg = resolveLoggingConfig({});
    assert.equal(cfg.maxBytes, 10 * 1024 * 1024);
    assert.equal(cfg.maxBytes, LOG_MAX_BYTES_DEFAULT);
    assert.equal(cfg.maxFiles, 7);
    assert.equal(cfg.maxFiles, LOG_MAX_FILES_DEFAULT);
    assert.equal(cfg.maxDays, 14);
    assert.equal(cfg.maxDays, LOG_MAX_DAYS_DEFAULT);
    assert.equal(cfg.level, 'info');
    assert.equal(cfg.level, LOG_LEVEL_DEFAULT);
    assert.equal(LOG_FILE_PREFIX, 'winvm-service');
    assert.ok(cfg.dir.includes('WinVMBridge'), '默认目录应位于 WinVMBridge 下');
    assert.ok(cfg.dir.includes('logs'), '默认目录应含 logs');
  });

  test('C1 会话默认：idle 300000 / maxRestarts 5 / ws 512MB / enabled', () => {
    const cfg = resolveLlmSessionConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.idleTtlMs, 300_000);
    assert.equal(cfg.idleTtlMs, LLM_SESSION_IDLE_MS_DEFAULT);
    assert.equal(cfg.maxRestarts, 5);
    assert.equal(cfg.maxRestarts, LLM_SESSION_MAX_RESTARTS_DEFAULT);
    assert.equal(cfg.maxWsBytes, 512 * 1024 * 1024);
    assert.equal(cfg.maxWsBytes, LLM_SESSION_MAX_WS_BYTES_DEFAULT);
    assert.ok(cfg.readyTimeoutMs >= 45_000, `就绪上限须容纳真机冷启动 16–25s（含离群），实际 ${cfg.readyTimeoutMs}`);
    assert.equal(cfg.readyTimeoutMs, LLM_SESSION_READY_MS_DEFAULT);
  });

  test('C2 委派超时默认 600000（出厂基线，不得回退）', () => {
    assert.equal(A2A_TIMEOUT_MS_DEFAULT, 600_000);
    assert.equal(resolveA2aTimeoutMs({}), 600_000);
    assert.equal(ENV_A2A_TIMEOUT_MS, 'WINVM_A2A_TIMEOUT_MS');
  });

  test('C5 缓存 TTL 默认 45000', () => {
    assert.equal(NETCFG_TTL_MS_DEFAULT, 45_000);
    assert.equal(resolveNetCfgTtlMs({}), 45_000);
    assert.equal(ENV_NETCFG_TTL_MS, 'WINVM_NETCFG_TTL_MS');
  });
});

describe('CL-018 T01 · env 覆盖', () => {
  test('日志 env 覆盖生效；非法值回退默认', () => {
    const cfg = resolveLoggingConfig({
      WINVM_LOG_LEVEL: 'debug',
      WINVM_LOG_MAX_BYTES: '2048',
      WINVM_LOG_MAX_FILES: '3',
      WINVM_LOG_MAX_DAYS: '1',
      WINVM_LOG_DIR: 'C:/logs',
    });
    assert.equal(cfg.level, 'debug');
    assert.equal(cfg.maxBytes, 2048);
    assert.equal(cfg.maxFiles, 3);
    assert.equal(cfg.maxDays, 1);
    assert.equal(cfg.dir, 'C:/logs');
    assert.equal(resolveLoggingConfig({ WINVM_LOG_MAX_BYTES: 'nope' }).maxBytes, LOG_MAX_BYTES_DEFAULT);
  });

  test('会话 env 覆盖生效（含禁用开关）', () => {
    const cfg = resolveLlmSessionConfig({
      [ENV_LLM_SESSION_IDLE_MS]: '60000',
      WINVM_LLM_PERSISTENT: '0',
      WINVM_LLM_SESSION_ID: 's-42',
    });
    assert.equal(cfg.idleTtlMs, 60_000);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.sessionId, 's-42');
  });

  test('C2/C5 env 覆盖生效', () => {
    assert.equal(resolveA2aTimeoutMs({ [ENV_A2A_TIMEOUT_MS]: '900000' }), 900_000);
    assert.equal(resolveNetCfgTtlMs({ [ENV_NETCFG_TTL_MS]: '30000' }), 30_000);
  });
});

describe('CL-018 T01 · TS ↔ psmod 跨语言 env 名一致性（防漂移）', () => {
  test('C5/C4 env 名字面量与 psmod 源码一致', () => {
    const system = readFileSync(join(PSMOD, 'system.ps1'), 'utf8');
    const appops = readFileSync(join(PSMOD, 'appops.ps1'), 'utf8');
    assert.ok(system.includes(ENV_NETCFG_TTL_MS), `system.ps1 应引用 ${ENV_NETCFG_TTL_MS}`);
    assert.ok(appops.includes(ENV_APPOPS_EXCLUDE_PROCS), `appops.ps1 应引用 ${ENV_APPOPS_EXCLUDE_PROCS}`);
    assert.ok(
      appops.includes(ENV_APPOPS_EXCLUDE_TITLE_PATTERNS),
      `appops.ps1 应引用 ${ENV_APPOPS_EXCLUDE_TITLE_PATTERNS}`,
    );
  });
});
