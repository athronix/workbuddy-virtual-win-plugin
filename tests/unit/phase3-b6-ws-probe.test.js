/**
 * Phase 3 · 批6 A2-11：工作集探针（终结 wsProbe 死配置）。
 *
 * 覆盖面：
 *  1. parseTasklistMemUsage / parseProcStatusRss 纯解析（含千分位、坏输入不抛）；
 *  2. createWorkingSetProbe 四红线：pid 未知⇒undefined / 节流窗（同 pid 窗内只采一次）/
 *     pid 变更⇒缓存作废重采 / 失败⇒undefined 且失败进节流窗（防重试风暴）；
 *  3. 平台分支：win32 走 tasklist、其它走 /proc；
 *  4. env 开关：resolveWsProbeEnabled 缺省 true、显式假值关；resolveWsProbeIntervalMs 回退。
 *
 * 纪律：判别性双向（节流既测"窗内不重采"也测"窗外重采"）；严禁 snapshot 字样。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (p) => 'file:///' + join(ROOT, p).replace(/\\/g, '/').replace(/^\//, '');

const { createWorkingSetProbe, parseTasklistMemUsage, parseProcStatusRss } = await import(
  dist('packages/adapter-agent-workbuddy-llm/dist/working-set-probe.js')
);
const { resolveWsProbeEnabled, resolveWsProbeIntervalMs, LLM_WS_PROBE_INTERVAL_MS_DEFAULT } = await import(
  dist('packages/core/dist/constants.js')
);

describe('A2-11 · tasklist CSV 解析', () => {
  test('正常行（千分位逗号）⇒ 字节数', () => {
    assert.equal(parseTasklistMemUsage('"node.exe","5812","Console","1","1,234 K"'), 1234 * 1024);
  });
  test('无逗号/小写 k 同样可解析', () => {
    assert.equal(parseTasklistMemUsage('"a.exe","1","X","1","512 k"'), 512 * 1024);
  });
  test('坏输入全家 ⇒ undefined 不抛', () => {
    for (const bad of [null, undefined, '', 'INFO: No tasks are running', '"a","1"', '"a","1","X","1","N/A"']) {
      assert.equal(parseTasklistMemUsage(bad), undefined);
    }
  });
});

describe('A2-11 · /proc status VmRSS 解析', () => {
  test('正常行 ⇒ 字节数', () => {
    assert.equal(parseProcStatusRss('Name:node\nVmRSS:\t   4096 kB\nThreads:1'), 4096 * 1024);
  });
  test('缺行/坏输入 ⇒ undefined', () => {
    assert.equal(parseProcStatusRss('Name:node\nVmHWM: 1 kB'), undefined);
    assert.equal(parseProcStatusRss(null), undefined);
  });
});

describe('A2-11 · createWorkingSetProbe 四红线', () => {
  test('红线1 · pid 未知（未启动/回收后）⇒ undefined 且缓存作废', () => {
    let calls = 0;
    let pid;
    const probe = createWorkingSetProbe({
      pidOf: () => pid,
      platform: 'win32',
      runTasklist: () => { calls++; return '"n.exe","9","C","1","100 K"'; },
    });
    assert.equal(probe(), undefined);
    pid = 9;
    assert.equal(probe(), 100 * 1024);
    assert.equal(calls, 1);
    pid = undefined; // 回收
    assert.equal(probe(), undefined);
    pid = 9; // 同名 pid 复用（理论极低概率）⇒ 缓存已作废，重新采样
    assert.equal(probe(), 100 * 1024);
    assert.equal(calls, 2);
  });

  test('红线2 · 节流窗：窗内复用样本（0 次额外 spawn），窗外重采（判别性双向）', () => {
    let calls = 0;
    let t = 1000;
    let lastBytes = 100;
    const probe = createWorkingSetProbe({
      pidOf: () => 42,
      platform: 'win32',
      now: () => t,
      minIntervalMs: 5000,
      runTasklist: () => { calls++; return `"n.exe","42","C","1","${lastBytes} K"`; },
    });
    assert.equal(probe(), 100 * 1024);
    assert.equal(calls, 1);
    t += 4999; lastBytes = 200;
    assert.equal(probe(), 100 * 1024, '窗内必须复用旧样本');
    assert.equal(calls, 1, '窗内不得再 spawn');
    t += 1; // 恰好越窗
    assert.equal(probe(), 200 * 1024, '窗外必须重采');
    assert.equal(calls, 2);
  });

  test('红线3 · pid 变更⇒缓存作废立即重采（不等窗）', () => {
    const seen = [];
    let pid = 1;
    let t = 0;
    const probe = createWorkingSetProbe({
      pidOf: () => pid,
      platform: 'win32',
      now: () => t,
      minIntervalMs: 60_000,
      runTasklist: (p) => { seen.push(p); return `"n.exe","${p}","C","1","${p}000 K"`; },
    });
    probe();
    t += 1000; pid = 2;
    probe();
    assert.deepEqual(seen, [1, 2], '新 pid 必须重新采样，绝不复用旧进程样本');
  });

  test('红线4 · 探测失败⇒undefined 且失败进节流窗（防重试风暴）', () => {
    let calls = 0;
    let t = 0;
    const probe = createWorkingSetProbe({
      pidOf: () => 7,
      platform: 'win32',
      now: () => t,
      minIntervalMs: 5000,
      runTasklist: () => { calls++; return null; },
    });
    assert.equal(probe(), undefined);
    assert.equal(calls, 1);
    t += 1000;
    assert.equal(probe(), undefined, '失败窗内仍 unknown');
    assert.equal(calls, 1, '失败也必须进节流窗——tasklist 不可用环境不得每 tick 重试');
    t += 4000;
    assert.equal(probe(), undefined);
    assert.equal(calls, 2, '窗过后可重试');
  });

  test('非 win32 ⇒ 走 readProcStatus 分支', () => {
    let calls = 0;
    const probe = createWorkingSetProbe({
      pidOf: () => 5,
      platform: 'linux',
      readProcStatus: () => { calls++; return 'VmRSS:\t2048 kB'; },
      runTasklist: () => { throw new Error('linux 不得调 tasklist'); },
    });
    assert.equal(probe(), 2048 * 1024);
    assert.equal(calls, 1);
  });

  test('tick 消费语义兼容：返回值只可能是 number|undefined（护栏判据 typeof === number）', () => {
    const probe = createWorkingSetProbe({ pidOf: () => 1, platform: 'win32', runTasklist: () => 'garbage' });
    const v = probe();
    assert.equal(v, undefined);
    assert.notEqual(typeof v, 'number', '坏样本绝不得伪装成数字触发误回收');
  });
});

describe('A2-11 · env 开关', () => {
  test('缺省启用（默认即安全）；显式 0/false/off 关', () => {
    assert.equal(resolveWsProbeEnabled({}), true);
    assert.equal(resolveWsProbeEnabled({ WINVM_LLM_WS_PROBE: '0' }), false);
    assert.equal(resolveWsProbeEnabled({ WINVM_LLM_WS_PROBE: 'false' }), false);
    assert.equal(resolveWsProbeEnabled({ WINVM_LLM_WS_PROBE: '1' }), true);
  });
  test('节流窗：缺省 5000；正整数覆盖；非法回退', () => {
    assert.equal(resolveWsProbeIntervalMs({}), LLM_WS_PROBE_INTERVAL_MS_DEFAULT);
    assert.equal(resolveWsProbeIntervalMs({ WINVM_LLM_WS_PROBE_INTERVAL_MS: '30000' }), 30000);
    assert.equal(resolveWsProbeIntervalMs({ WINVM_LLM_WS_PROBE_INTERVAL_MS: 'abc' }), LLM_WS_PROBE_INTERVAL_MS_DEFAULT);
    assert.equal(resolveWsProbeIntervalMs({ WINVM_LLM_WS_PROBE_INTERVAL_MS: '-1' }), LLM_WS_PROBE_INTERVAL_MS_DEFAULT);
  });
});
