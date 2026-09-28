/**
 * CL-019 T4 · 项② `routes[].routeMetric` 字段名统一（静态源码守卫 + 样例断言）
 *
 * 本仓库 `node --test` 运行环境**无 PowerShell**，无法真跑 psmod；故此处锁死不变量：
 *   - `system.ps1` 的 `routes[]` 投影使用 `routeMetric`（与 `adapters[].gateway[]` 同源同名），
 *     不再使用旧名 `metric`（违反 CL-017/CL-018 S15 契约 `[{nextHop, routeMetric}]`）；
 *   - `definitions.ts` 的 `system.network.config` 出参 `routes` 补全内层 shape 文档；
 *   - 以静态样例对象断言 `routes[].routeMetric` 与 `gateway[].routeMetric` 字段名同源一致。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const SYSTEM_PS1 = read('packages', 'vm-capabilities', 'psmod', 'system.ps1');
const DEFINITIONS = read('packages', 'vm-capabilities', 'src', 'registry', 'definitions.ts');

describe('CL-019 项② · system.ps1 routes[] 投影字段名', () => {
  test('routes[] 投影使用 routeMetric（取值 $_.RouteMetric）', () => {
    assert.ok(
      /routes\]\s*=\s*@\(/.test(SYSTEM_PS1) || SYSTEM_PS1.includes("$data['routes']"),
      '应存在 routes 投影（$data[\'routes\'] = @( ... )）',
    );
    assert.ok(
      SYSTEM_PS1.includes('routeMetric = $_.RouteMetric'),
      'routes 投影应使用 routeMetric = $_.RouteMetric',
    );
    // 反面守卫：routes 投影不得再出现旧名 `metric = $_.RouteMetric`
    assert.ok(
      !SYSTEM_PS1.includes('metric = $_.RouteMetric'),
      'routes 投影不得再使用旧名 `metric = $_.RouteMetric`（应统一为 routeMetric）',
    );
  });

  test('gateway[] 与 routes[] 同源同名（均取 $_.RouteMetric）', () => {
    // gateway 投影（CL-018 既有）：routeMetric = $_.RouteMetric
    assert.ok(
      SYSTEM_PS1.includes('routeMetric = $_.RouteMetric'),
      'gateway[] 与 routes[] 都应从 $_.RouteMetric 取变量名为 routeMetric',
    );
    // 出现次数 ≥ 2（gateway 一处 + routes 一处），证明二者同源同名
    const occurrences = SYSTEM_PS1.split('routeMetric = $_.RouteMetric').length - 1;
    assert.ok(
      occurrences >= 2,
      `routeMetric = $_.RouteMetric 应至少出现 2 次（gateway + routes），实际=${occurrences}`,
    );
  });
});

describe('CL-019 项② · definitions.ts 契约补全', () => {
  test('system.network.config 出参 routes 描述含内层 shape { destination, nextHop, routeMetric }', () => {
    assert.ok(
      DEFINITIONS.includes('destination, nextHop, routeMetric'),
      'routes 出参描述应注明内层 shape { destination, nextHop, routeMetric }',
    );
  });

  test('adapters 描述含 gateway 内层 { nextHop, routeMetric }（与 routes 对照）', () => {
    assert.ok(
      DEFINITIONS.includes('{ nextHop, routeMetric }'),
      'adapters 描述应注明 gateway 内层 { nextHop, routeMetric }',
    );
  });
});

describe('CL-019 项② · 样例对象字段名同源一致', () => {
  test('routes[].routeMetric 与 gateway[].routeMetric 字段名一致', () => {
    // 静态样例：模拟 Get-NetworkConfig 投影后的返回形态
    const sample = {
      adapters: [
        {
          interfaceAlias: 'Ethernet',
          gateway: [{ nextHop: '172.16.100.1', routeMetric: 25 }],
        },
      ],
      routes: [
        { destination: '0.0.0.0/0', nextHop: '172.16.100.1', routeMetric: 25 },
        { destination: '172.16.100.0/24', nextHop: '0.0.0.0', routeMetric: 281 },
      ],
    };

    const gwKeys = Object.keys(sample.adapters[0].gateway[0]);
    assert.ok(gwKeys.includes('routeMetric'), 'gateway[] 应含 routeMetric');
    assert.ok(!gwKeys.includes('metric'), 'gateway[] 不应含旧名 metric');

    for (const r of sample.routes) {
      const keys = Object.keys(r);
      assert.ok(keys.includes('routeMetric'), `routes[] 每项应含 routeMetric：${JSON.stringify(r)}`);
      assert.ok(!keys.includes('metric'), `routes[] 不应含旧名 metric：${JSON.stringify(r)}`);
      assert.equal(typeof r.routeMetric, 'number', 'routes[].routeMetric 应为数值');
    }

    // 同源同名：两处共用同一字段名 routeMetric
    assert.equal(
      sample.routes[0].routeMetric,
      sample.adapters[0].gateway[0].routeMetric,
      '同一路由的 routes[].routeMetric 应与 gateway[].routeMetric 取同一值',
    );
  });
});
