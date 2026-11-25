/**
 * V-NEXT 阶段 1.4 · `WINVM_DELEGATION_REQUIRED_POLICY` 废弃处理守卫
 *
 * 背景（owner 2026-11-23 裁定）：该开关**不删除**，改为「保留键名 + 收敛单分支 + 废弃 WARN」。
 * 理由：它是 `(c) 收口`（直调 L2/L3 ⇒ `DELEGATION_REQUIRED`）的**回滚保险**，
 * 而 `(c)` 本身是安全修复（替换 P0-1「批准即删令牌 ⇒ 恒返 APPROVAL_REQUIRED 死循环」）。
 * 改安全路径的代码却同时撤掉「能退回已知可用旧态」的绳 = 单方面撤承诺。
 *
 * 本文件钉三件事：
 *   A 语义等价：新入口 `resolveDelegationRequiredPolicyWithWarning().enabled`
 *     必须与旧 `resolveDelegationRequiredPolicy()` **逐字等价**（否则「保留回滚位」是假的）。
 *   B 废弃显形：只有 `off`/`false`/`0`/`no` 才置 `deprecatedOff=true`；缺省与 on 不告警。
 *   C 反向钉：`server.ts` 必须真的**消费**该标记（存在 WARN 调用 + 引用常量），
 *     否则「废弃」只是注释，运维永远看不到。
 *
 * 运行：node --test tests/unit/delegation-required-policy-deprecation.test.js
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENV_DELEGATION_REQUIRED_POLICY,
  resolveDelegationRequiredPolicy,
  resolveDelegationRequiredPolicyWithWarning,
} from '@winvm/core';

const ROOT = join(import.meta.dirname, '..', '..');

describe('A · 语义等价：废弃处理不得改变任何判定', () => {
  const CASES = [
    ['未配置', {}, true, false],
    ['空串（同未配置）', { [ENV_DELEGATION_REQUIRED_POLICY]: '' }, true, false],
    ['on', { [ENV_DELEGATION_REQUIRED_POLICY]: 'on' }, true, false],
    ['true', { [ENV_DELEGATION_REQUIRED_POLICY]: 'true' }, true, false],
    ['1', { [ENV_DELEGATION_REQUIRED_POLICY]: '1' }, true, false],
    ['yes', { [ENV_DELEGATION_REQUIRED_POLICY]: 'yes' }, true, false],
    ['off（废弃回滚位）', { [ENV_DELEGATION_REQUIRED_POLICY]: 'off' }, false, true],
    ['false（废弃回滚位）', { [ENV_DELEGATION_REQUIRED_POLICY]: 'false' }, false, true],
    ['0（废弃回滚位）', { [ENV_DELEGATION_REQUIRED_POLICY]: '0' }, false, true],
    ['no（废弃回滚位）', { [ENV_DELEGATION_REQUIRED_POLICY]: 'no' }, false, true],
    ['非法值 ⇒ 回退 on 且不告警', { [ENV_DELEGATION_REQUIRED_POLICY]: 'whatever' }, true, false],
    ['OFF 大写', { [ENV_DELEGATION_REQUIRED_POLICY]: 'OFF' }, false, true],
    [' off 前后空格', { [ENV_DELEGATION_REQUIRED_POLICY]: ' off ' }, false, true],
  ];

  for (const [label, env, expectEnabled, expectDeprecated] of CASES) {
    test(`${label} ⇒ enabled=${expectEnabled} deprecatedOff=${expectDeprecated}`, () => {
      const r = resolveDelegationRequiredPolicyWithWarning(env);
      assert.equal(r.enabled, expectEnabled, 'enabled 判定漂移');
      assert.equal(r.deprecatedOff, expectDeprecated, '废弃标记漂移');
      // ★ 核心不变式：新入口的判定位与旧函数**必须**同源
      assert.equal(
        r.enabled,
        resolveDelegationRequiredPolicy(env),
        '新入口 enabled 与旧 resolveDelegationRequiredPolicy 不一致 ⇒ 「保留回滚位」名不副实',
      );
    });
  }
});

describe('B · 废弃显形：server.ts 必须真的把标记用起来（反向钉）', () => {
  const SERVER = readFileSync(join(ROOT, 'packages', 'vm-service', 'src', 'server.ts'), 'utf8');

  test('装配点使用带告警的解析入口，而非裸旧函数', () => {
    assert.match(
      SERVER,
      /resolveDelegationRequiredPolicyWithWarning\s*\(/,
      '必须调带废弃告警的入口，否则 off 取值仍然静默',
    );
    assert.ok(
      !/const delegationRequiredPolicy = resolveDelegationRequiredPolicy\(/.test(SERVER),
      '不得退回裸旧函数（那会让废弃标记形同虚设）',
    );
  });

  test('读到 deprecatedOff 时有 logger.warn，且文案点名环境变量与「已废弃」', () => {
    assert.match(SERVER, /deprecatedOff/, '必须消费 deprecatedOff 标记');
    // 取 deprecatedOff 出现处之后 600 字符内必须有 logger.warn
    const idx = SERVER.indexOf('deprecatedOff');
    const near = SERVER.slice(idx, idx + 900);
    assert.match(near, /logger\.warn\(/, 'deprecatedOff 判定后必须打 WARN（否则运维看不到）');
    assert.match(near, /已废弃/, 'WARN 文案须明说「已废弃」，不能只说「已启用」');
    assert.match(
      near,
      /ENV_DELEGATION_REQUIRED_POLICY/,
      'WARN 文案须点名环境变量，运维才知道去删哪个键',
    );
  });

  test('数据面仍只消费单一布尔位（enabled），不散落第二份解析', () => {
    // 除装配点外，server.ts 不应再出现 resolve* 调用（防两处解析漂移）
    const calls = SERVER.match(/resolveDelegationRequiredPolicyWithWarning\s*\(/g) ?? [];
    assert.equal(calls.length, 1, `解析入口应恰 1 处，实得 ${calls.length}`);
  });
});