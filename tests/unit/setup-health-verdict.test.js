/**
 * D15 回归：HEALTH 会话门禁三态判定（`interpretHealth`）—— 确定性单测。
 *
 * 背景（team-lead 在 run#1 部署日志中独立发现）：探针**超时**时服务把
 * `session.interactive` 默认成 `false`、`session.state='unavailable'`；旧逻辑仅凭
 * `interactive===false` 就断言「服务运行在非交互式会话 → GUI 不可用」并打印人工补救命令
 * —— 属**误报（false negative）**（约 1 分钟后实测 session.interactive=true / healthy）。
 *
 * 本测试用**真实载荷**（run#1 日志原始超时载荷 + 05:03 复探健康载荷）锁定三态语义，
 * 防止「把冷启瞬态当终态」的误报回归。
 *
 * 契约：主流程仅在 `interpretHealth(...).vet === 'gui-degraded'` 时置 `guiDegraded=true`
 * 并打印补救块 → 故断言 `vet !== 'gui-degraded'` 等价于「`guiDegraded` 未被置位」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { interpretHealth } from '../../delivery/setup.mjs';

/** 用例①：run#1 部署日志中的原始超时载荷（原样保留 detail 文本） */
const PAYLOAD_TIMEOUT = {
  ok: true,
  provider: {
    id: 'workbuddy',
    state: 'degraded',
    detail: 'provider.health() 在 5000ms 内未返回（WINVM_HEALTH_PROBE_TIMEOUT_MS 可调）：本次结论未知，已降级呈现',
  },
  session: {
    sessionId: 0,
    windowStation: '',
    desktop: '',
    interactive: false,
    locked: false,
    blackScreen: false,
    state: 'unavailable',
    detail: '会话子探针在 5000ms 内未返回（WINVM_HEALTH_PROBE_TIMEOUT_MS 可调）：ps-bridge 可能未就绪，本次结论未知',
  },
  psBridge: { state: 'degraded', uptimeMs: 15609, pending: 5, restarts: 0, probe: 'timeout' },
};

/** 用例②：05:03 复探到的健康载荷 */
const PAYLOAD_HEALTHY = {
  ok: true,
  provider: { id: 'workbuddy', state: 'ready' },
  session: {
    sessionId: 1,
    windowStation: 'WinSta0',
    desktop: 'Default',
    interactive: true,
    locked: false,
    blackScreen: false,
    state: 'healthy',
    detail: '会话健康，GUI 能力可用',
  },
  psBridge: { state: 'ready', uptimeMs: 41840, pending: 0, restarts: 0 },
};

/** 用例③：确证非交互（state=healthy 且 interactive=false，sessionId 为正） */
const PAYLOAD_DEGRADED = {
  ok: true,
  provider: { id: 'workbuddy', state: 'ready' },
  session: {
    sessionId: 1,
    windowStation: 'WinSta0',
    desktop: 'Default',
    interactive: false,
    locked: false,
    blackScreen: false,
    state: 'healthy',
  },
  psBridge: { state: 'ready', pending: 0 },
};

/** 用例④：载荷缺 `session` 字段 */
const PAYLOAD_NO_SESSION = {
  ok: true,
  provider: { id: 'workbuddy', state: 'ready' },
  psBridge: { state: 'ready', pending: 0 },
};

describe('interpretHealth —— 会话门禁三态（D15 回归）', () => {
  test('① run#1 超时载荷（interactive 默认 false）⇒ unknown，且不置 guiDegraded（防误报）', () => {
    const v = interpretHealth(PAYLOAD_TIMEOUT);
    assert.equal(v.vet, 'unknown', '超时/未知 ⇒ 必须 unknown');
    assert.notEqual(v.vet, 'gui-degraded', 'guiDegraded 仅在 vet==="gui-degraded" 时置位 → 此处必须未置位');
    assert.equal(v.probeTimeout, true, '应识别到探针超时信号（state=unavailable / psBridge.probe=timeout）');
    assert.equal(v.sessionId, 0);
  });

  test('② 健康载荷（interactive=true / state=healthy / psBridge.ready pending=0）⇒ gui-ok', () => {
    const v = interpretHealth(PAYLOAD_HEALTHY);
    assert.equal(v.vet, 'gui-ok');
    assert.equal(v.interactive, true);
    assert.equal(v.sessionId, 1);
    assert.equal(v.windowStation, 'WinSta0');
    assert.equal(v.probeTimeout, false);
  });

  test('③ state=healthy + interactive=false + sessionId=1 + windowStation=WinSta0 ⇒ gui-degraded（确证）', () => {
    const v = interpretHealth(PAYLOAD_DEGRADED);
    assert.equal(v.vet, 'gui-degraded');
    assert.equal(v.interactive, false);
    assert.equal(v.sessionId, 1);
    assert.equal(v.windowStation, 'WinSta0');
    assert.equal(v.probeTimeout, false);
  });

  test('④ 缺 session 字段 ⇒ unknown', () => {
    const v = interpretHealth(PAYLOAD_NO_SESSION);
    assert.equal(v.vet, 'unknown');
    assert.equal(v.sessionId, null);
  });

  test('补充：仅 psBridge.probe==="timeout"（无 session）⇒ unknown（不得误断非交互）', () => {
    const v = interpretHealth({ ok: true, psBridge: { state: 'degraded', probe: 'timeout' } });
    assert.equal(v.vet, 'unknown');
  });

  test('补充：state=healthy 但 sessionId 非正 ⇒ unknown（防御，不误断非交互）', () => {
    const v = interpretHealth({ session: { sessionId: 0, interactive: false, state: 'healthy' } });
    assert.equal(v.vet, 'unknown');
  });

  test('补充：state=healthy + interactive=false 但仍见探针超时信号 ⇒ unknown（不确证）', () => {
    const v = interpretHealth({
      session: { sessionId: 1, windowStation: 'WinSta0', interactive: false, state: 'healthy' },
      psBridge: { state: 'degraded', probe: 'timeout' },
    });
    assert.equal(v.vet, 'unknown');
  });

  test('补充：非对象输入（undefined / null / 字符串）⇒ unknown 且不抛异常', () => {
    assert.equal(interpretHealth(undefined).vet, 'unknown');
    assert.equal(interpretHealth(null).vet, 'unknown');
    assert.equal(interpretHealth('nope').vet, 'unknown');
  });
});
