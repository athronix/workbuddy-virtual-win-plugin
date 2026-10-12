/**
 * Phase 2 · P2-T9 单元测试：SessionHealth 未知态（E-2）+ 冷启动度量透出（E-1）
 *
 * 覆盖五组判据（设计定稿 wbtmp/p2t9-design.md §4）：
 *   A 组 **probeError 形态** —— 三处「被迫填假值」制造点的两键在场 + 既有字段逐字不变 +
 *      成功路径两键**缺席**（= 旧形状逐字节，用 Object.keys 钉死，不用 `undefined` 值糊弄）；
 *   B 组 **guiAllowed 恒 false 矩阵**（PR8 红线）—— probeError × interactive × blackScreen ×
 *      locked × state 全组合，证明判据**不消费** probeError ⇒ 无从放宽；
 *   C 组 **契约纯附加**—— SessionHealth/LlmSessionHealth 旧字段必填性零变化、新键皆 `?:`、
 *      probeErrorCode 不脱离 probeError 单飞、T5/T7/T8 契约区锚点逐字在场；
 *   D 组 **firstCallLatencyMs 度量形状**—— 注入确定性时钟 + FakeChild：从未首调⇒键缺席、
 *      首调⇒精确毫秒、二调不覆盖、unavailable 首调同样计、restartFresh 不清零、
 *      采样时点=settle 非入口；
 *   E 组 **文档判据在位**—— 三处活文档 + health.ts 判据注释的新行在场（判据自指登记范式）。
 *
 * 运行：node --test tests/unit/phase2-session-unknown.test.js
 * ⚠ 依赖已重建 dist（`node node_modules/typescript/bin/tsc -b tsconfig.build.json`）。
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableSessionProbe, guiAllowed, nonGuiAllowed } from '@winvm/core';
import {
  timeoutSessionSnapshot,
  raceSessionProbe,
  raceHealthSubProbes,
} from '@winvm/vm-service';
import { PsBridgeSessionProbe } from '@winvm/vm-capabilities';
import { PersistentCliSession } from '@winvm/adapter-agent-workbuddy-llm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const BRIDGE_TS = 'packages/contracts/src/bridge.ts';
const HEALTH_TS = 'packages/core/src/session/health.ts';
const PROBE_TS = 'packages/vm-service/src/health-probe.ts';
const CAPS_TS = 'packages/vm-capabilities/src/index.ts';
const SESSION_TS = 'packages/adapter-agent-workbuddy-llm/src/persistent-session.ts';

/** 旧七/八字段的 fail-closed 填充值（三处制造点共有形状，A 组逐点钉） */
const FALLBACK_BASE = Object.freeze({
  sessionId: 0,
  windowStation: '',
  desktop: '',
  interactive: false,
  locked: false,
  blackScreen: false,
  state: 'unavailable',
});

const KEYS_OLD = ['sessionId', 'windowStation', 'desktop', 'interactive', 'locked', 'blackScreen', 'state'];

/* ============================================================================
 * A 组 · probeError 形态（E-2）
 * ========================================================================== */

describe('P2-T9 A · probeError 形态：三处假值制造点两键在场', () => {
  test('A1 timeoutSessionSnapshot：两键在场且码为 PROBE_TIMEOUT', () => {
    const s = timeoutSessionSnapshot(5_000);
    assert.equal(typeof s.probeError, 'string');
    assert.ok(s.probeError.length > 0, 'probeError 须为一句话事实描述（非空壳）');
    assert.equal(s.probeErrorCode, 'PROBE_TIMEOUT');
  });

  test('A1b timeoutSessionSnapshot：既有八字段值逐字不变（纯追加，detail 原文案保留）', () => {
    const s = timeoutSessionSnapshot(5_000);
    for (const [k, v] of Object.entries(FALLBACK_BASE)) {
      assert.equal(s[k], v, `既有键 ${k} 的值被改动 ⇒ E-2 不再是纯附加`);
    }
    assert.match(s.detail ?? '', /会话子探针在 5000ms 内未返回/, 'detail 文案须与 HEAD 逐字同源');
    assert.match(s.detail ?? '', /WINVM_HEALTH_PROBE_TIMEOUT_MS 可调/);
    assert.match(s.probeError ?? '', /未取得结论/);
  });

  test('A1c timeoutSessionSnapshot：键序=旧键在前、两新键在尾（JSON 序列化旧读者形状不变）', () => {
    const keys = Object.keys(timeoutSessionSnapshot(1_000));
    assert.deepEqual(keys.slice(0, KEYS_OLD.length), KEYS_OLD, '旧键前缀顺序逐字节不变');
    assert.deepEqual(keys, [...KEYS_OLD, 'detail', 'probeError', 'probeErrorCode']);
  });

  test('A2 raceSessionProbe 超时路径：两键在场（timedOut=true），底层不被中断', async () => {
    let bgDone = false;
    const never = new Promise((r) => setTimeout(() => { bgDone = true; r(FALLBACK_BASE); }, 40));
    const out = await raceSessionProbe(() => never, 5);
    assert.equal(out.timedOut, true);
    assert.equal(out.session.probeErrorCode, 'PROBE_TIMEOUT');
    assert.equal(typeof out.session.probeError, 'string');
    assert.ok(out.session.probeError.length > 0);
    for (const [k, v] of Object.entries(FALLBACK_BASE)) assert.equal(out.session[k], v, `超时路径既有键 ${k} 漂移`);
    await never;
    assert.equal(bgDone, true, 'race 不 abort：底层 promise 须继续在后台完成');
  });

  test('A2b raceSessionProbe reject 路径：同样两键在场（fallback 形态），不抛错', async () => {
    const boom = () => Promise.reject(new Error('bridge down'));
    const out = await raceSessionProbe(boom, 50);
    assert.equal(out.timedOut, false, 'reject 不标 timedOut（既有语义逐字保留）');
    assert.equal(out.session.probeErrorCode, 'PROBE_TIMEOUT', 'race 层回退走 timeoutSessionSnapshot 形态');
    assert.equal(typeof out.session.probeError, 'string');
    assert.equal(out.session.state, 'unavailable');
    assert.equal(out.session.interactive, false);
  });

  test('A2c raceHealthSubProbes（并发编排）：会话路超时两键在场，provider 路不受影响', async () => {
    const out = await raceHealthSubProbes({
      sessionProbe: () => new Promise(() => {}),
      providerHealth: undefined,
      providerId: 'workbuddy',
      timeoutMs: 5,
    });
    assert.equal(out.sessionTimedOut, true);
    assert.equal(out.session.probeErrorCode, 'PROBE_TIMEOUT');
    assert.equal(out.providerHealth, undefined, '无 provider 时保持既有兜底（不新增键）');
  });

  test('A3 PsBridgeSessionProbe catch 路径：两键在场且码为 PROBE_EXCEPTION', async () => {
    const bridge = { call: () => Promise.reject(new Error('ps-bridge 未就绪')) };
    const s = await new PsBridgeSessionProbe(bridge).probe();
    assert.equal(s.probeErrorCode, 'PROBE_EXCEPTION');
    assert.match(s.probeError ?? '', /抛异常/);
    assert.match(s.probeError ?? '', /ps-bridge 未就绪/, 'probeError 含原因，运维可据此查探测通路');
    for (const [k, v] of Object.entries(FALLBACK_BASE)) {
      assert.equal(s[k], v, `异常路径既有键 ${k} 漂移`);
    }
    assert.match(s.detail ?? '', /会话探针失败：ps-bridge 未就绪/, 'detail 既有文案逐字保留');
  });

  test('A4 UnavailableSessionProbe：两键在场且码为 PROBE_NOT_WIRED，detail 默认文案不变', async () => {
    const s = await new UnavailableSessionProbe().probe();
    assert.equal(s.probeErrorCode, 'PROBE_NOT_WIRED');
    assert.equal(s.probeError, '会话探针未接入（非 Windows 环境或未初始化）');
    assert.equal(s.detail, '会话探针未接入（非 Windows 环境或未初始化）', 'detail 与 HEAD 逐字一致（probeError 是并列第二信号，不是替换）');
    for (const [k, v] of Object.entries(FALLBACK_BASE)) {
      assert.equal(s[k], v, `未接入路径既有键 ${k} 漂移`);
    }
  });

  test('A4b UnavailableSessionProbe 自定义 detail：probeError 与 detail 同源透出', async () => {
    const s = await new UnavailableSessionProbe('现场原因文案').probe();
    assert.equal(s.probeError, '现场原因文案');
    assert.equal(s.detail, '现场原因文案');
    assert.equal(s.probeErrorCode, 'PROBE_NOT_WIRED');
  });

  test('A5 三码齐备且互不相同（机读码集合钉）', async () => {
    const codes = [
      timeoutSessionSnapshot(5_000).probeErrorCode,
      (await new PsBridgeSessionProbe({ call: () => Promise.reject(new Error('x')) }).probe()).probeErrorCode,
      (await new UnavailableSessionProbe().probe()).probeErrorCode,
    ];
    assert.deepEqual(codes, ['PROBE_TIMEOUT', 'PROBE_EXCEPTION', 'PROBE_NOT_WIRED']);
    assert.equal(new Set(codes).size, 3, '三码不得重复（否则运维无法定位通路）');
    for (const c of codes) assert.match(c, /^PROBE_[A-Z_]+$/, '码形为大写下划线枚举串');
  });

  test('A6 成功路径：两键缺席（Object.keys 钉死 = 旧形状逐字节，非 undefined 值）', async () => {
    const raw = {
      sessionId: 2,
      windowStation: 'WinSta0',
      desktop: 'Default',
      interactive: true,
      locked: false,
      blackScreen: false,
      state: 'healthy',
    };
    const s = await new PsBridgeSessionProbe({ call: async () => raw }).probe();
    const keys = Object.keys(s);
    assert.ok(!keys.includes('probeError'), '成功路径不得出现 probeError 键（含值为 undefined 的形态）');
    assert.ok(!keys.includes('probeErrorCode'), '成功路径不得出现 probeErrorCode 键');
    assert.deepEqual(keys, KEYS_OLD, '成功路径（raw 无 detail）键集恰为旧七键');
    assert.equal(s.state, 'healthy');
    assert.equal(s.interactive, true);
  });

  test('A6b 成功路径带 detail 时：键集=旧八键，两新键仍缺席', async () => {
    const raw = {
      sessionId: 1,
      windowStation: 'WinSta0',
      desktop: 'Default',
      interactive: false,
      locked: true,
      blackScreen: false,
      state: 'degraded',
      detail: '锁屏中',
    };
    const s = await new PsBridgeSessionProbe({ call: async () => raw }).probe();
    assert.deepEqual(Object.keys(s), [...KEYS_OLD, 'detail']);
    assert.equal(s.probeError, undefined, '探测成功且确非交互 ⇒ probeError 缺席（与失败态可区分）');
  });

  test('A7 JSON 层面：失败态多两键、成功态序列化逐字节旧形状', async () => {
    const okRaw = { sessionId: 2, windowStation: 'W', desktop: 'D', interactive: true, locked: false, blackScreen: false, state: 'healthy' };
    const okJson = JSON.parse(JSON.stringify(await new PsBridgeSessionProbe({ call: async () => okRaw }).probe()));
    assert.deepEqual(Object.keys(okJson), KEYS_OLD, '序列化后仍不得凭空长出两键（键缺席 ≠ null/undefined）');
    const failJson = JSON.parse(JSON.stringify(timeoutSessionSnapshot(5_000)));
    assert.equal(failJson.probeErrorCode, 'PROBE_TIMEOUT');
    assert.ok('probeError' in failJson);
  });

  test('A8 制造点总数钉：全仓 src 内 probeErrorCode 赋值恰三处（第四处即漂移/留角）', () => {
    const hits = [];
    const re = /probeErrorCode:\s*'(PROBE_[A-Z_]+)'/g;
    for (const rel of [HEALTH_TS, PROBE_TS, CAPS_TS]) {
      const m = src(rel).matchAll(re);
      for (const x of m) hits.push([rel.split('/').slice(-1)[0], x[1]]);
    }
    assert.equal(hits.length, 3, `probeErrorCode 赋值点应为 3，实得 ${hits.length}`);
    assert.deepEqual(hits.map((h) => h[1]).sort(), ['PROBE_EXCEPTION', 'PROBE_NOT_WIRED', 'PROBE_TIMEOUT']);
  });
});

/* ============================================================================
 * B 组 · guiAllowed 恒 false 矩阵（PR8 红线：行为一字未改）
 * ========================================================================== */

const STATES = ['healthy', 'degraded', 'unavailable', 'black-screen'];

/** HEAD 判据的**独立复算**（与生产实现无共享代码；两者互为对账） */
function criteriaAtHead(session) {
  return session.state === 'healthy' && session.interactive && !session.blackScreen;
}

function baseSession(state, interactive, blackScreen, locked) {
  return {
    sessionId: interactive ? 2 : 0,
    windowStation: interactive ? 'WinSta0' : '',
    desktop: interactive ? 'Default' : '',
    interactive,
    locked,
    blackScreen,
    state,
    detail: 'fixture',
  };
}

describe('P2-T9 B · guiAllowed 不消费 probeError（恒 false 矩阵，PR8）', () => {
  test('B1 全组合矩阵：probeError 在场/缺席 ⇒ 放行结论逐一相同（无从放宽）', () => {
    const rows = [];
    for (const state of STATES) {
      for (const interactive of [true, false]) {
        for (const blackScreen of [true, false]) {
          for (const locked of [true, false]) {
            const plain = baseSession(state, interactive, blackScreen, locked);
            const withErr = {
              ...plain,
              probeError: '会话子探针在 5000ms 内未返回，本次未取得结论',
              probeErrorCode: 'PROBE_TIMEOUT',
            };
            const expected = criteriaAtHead(plain);
            assert.equal(guiAllowed(plain), expected, `判据行漂移（无 probeError 组）：${JSON.stringify(plain)}`);
            assert.equal(
              guiAllowed(withErr),
              expected,
              `probeError 在场改变了放行结论 ⇒ PR8 违背：${JSON.stringify(withErr)}`,
            );
            rows.push([state, interactive, blackScreen, locked, expected]);
          }
        }
      }
    }
    assert.equal(rows.length, 32, '矩阵应有 4×2×2×2=32 组合');
  });

  test('B2 真实三处假值形态：guiAllowed 恒 false（探测失败与确非交互都拒）', async () => {
    const shapes = [
      timeoutSessionSnapshot(5_000),
      await new PsBridgeSessionProbe({ call: () => Promise.reject(new Error('x')) }).probe(),
      await new UnavailableSessionProbe().probe(),
    ];
    for (const s of shapes) {
      assert.equal(guiAllowed(s), false, `假值形态放行 ⇒ 安全红线破裂：${s.probeErrorCode}`);
      assert.equal(nonGuiAllowed(s), false, 'unavailable 下非 GUI 能力同样受限（既有语义不变）');
    }
  });

  test('B3 人造矛盾体防御钉：healthy+interactive:true+probeError 在场 仍旧放行（证明判据不读该键）', () => {
    // 三处真实制造点**永不**产出该组合（B2 已钉）；此组只钉一件事：判据零改动。
    const mutant = {
      ...baseSession('healthy', true, false, false),
      probeError: '人造',
      probeErrorCode: 'PROBE_TIMEOUT',
    };
    assert.equal(guiAllowed(mutant), true, '若此处变 false ⇒ 判据被改成消费 probeError（行为变更，PR8 红线）');
  });

  test('B4 判据行逐字钉：health.ts 源码合取式与 HEAD 完全一致（零新增分支）', () => {
    const s = src(HEALTH_TS);
    assert.match(
      s,
      /return session\.state === 'healthy' && session\.interactive && !session\.blackScreen;/,
      '判据行一字未改（PR8 实证）',
    );
    assert.ok(!/probeError/.test(s.split('export function guiAllowed')[1].split('}')[0]), '判据函数体内不得出现 probeError（不消费即无从放宽）');
    assert.ok(!/unknown/.test(s.match(/export function guiAllowed[\s\S]*?\n}/)[0]), '判据未引入三态/unknown 逻辑');
  });

  test('B5 interactive 仍为必填 boolean（设计明令禁三态）', () => {
    const blk = src(BRIDGE_TS).match(/export interface SessionHealth \{[\s\S]*?\n\}/)[0];
    assert.match(blk, /readonly interactive: boolean;/, 'interactive 不得可选化');
    assert.ok(!/interactive\?:/.test(blk), '出现 interactive?: ⇒ 破坏性契约变更');
    assert.ok(!/boolean \| undefined/.test(blk), '出现三态类型 ⇒ 判据改成本上升，设计已否');
  });

  test('B6 SessionState 枚举不扩 unknown（结论未知由 fail-closed 的 unavailable 表达）', () => {
    const t = src(BRIDGE_TS).match(/export type SessionState = [^;]+;/)[0];
    assert.equal(t, "export type SessionState = 'healthy' | 'degraded' | 'unavailable' | 'black-screen';");
    assert.ok(!/unknown/.test(t), "SessionState 扩 'unknown' 会破跨包消费面（设计 §1.2 已否）");
  });

  test('B7 恒 false 方向的独立复算：三码路径的合取首项即短路', () => {
    for (const code of ['PROBE_TIMEOUT', 'PROBE_EXCEPTION', 'PROBE_NOT_WIRED']) {
      const s = { ...baseSession('unavailable', false, false, false), probeError: code, probeErrorCode: code };
      assert.equal(s.state === 'healthy', false, `${code} 路径 state 必须非 healthy（短路即拒）`);
      assert.equal(guiAllowed(s), false);
    }
  });
});

/* ============================================================================
 * C 组 · 契约纯附加（旧读者零影响）
 * ========================================================================== */

describe('P2-T9 C · SessionHealth 契约纯附加', () => {
  test('C1 旧七字段全部保持必填（无 `?:`）', () => {
    const blk = src(BRIDGE_TS).match(/export interface SessionHealth \{[\s\S]*?\n\}/)[0];
    for (const f of ['sessionId: number', 'windowStation: string', 'desktop: string', 'interactive: boolean', 'locked: boolean', 'blackScreen: boolean', 'state: SessionState']) {
      assert.ok(blk.includes(`readonly ${f};`), `旧字段 ${f} 必填声明漂移`);
      assert.ok(!blk.includes(`readonly ${f.split(':')[0]}?:`), `旧字段 ${f.split(':')[0]} 被可选化 ⇒ 破坏性变更`);
    }
  });

  test('C2 两新键为可选且位于块尾（detail 之后追加）', () => {
    const blk = src(BRIDGE_TS).match(/export interface SessionHealth \{[\s\S]*?\n\}/)[0];
    assert.match(blk, /readonly probeError\?: string;/);
    assert.match(blk, /readonly probeErrorCode\?: string;/);
    const body = blk.replace(/\/\*[\s\S]*?\*\//g, '');
    const order = [...body.matchAll(/readonly (\w+)\??:/g)].map((m) => m[1]);
    assert.deepEqual(order, [...KEYS_OLD, 'detail', 'probeError', 'probeErrorCode'], '声明顺序：旧字段逐字在前，两新键在尾');
  });

  test('C3 probeErrorCode 不脱离 probeError 单飞（源码赋值点 + 类型注释双向钉）', () => {
    for (const rel of [HEALTH_TS, PROBE_TS, CAPS_TS]) {
      const text = src(rel);
      const pe = (text.match(/probeError:/g) ?? []).length;
      const pec = (text.match(/probeErrorCode:/g) ?? []).length;
      assert.equal(pec, pe, `${rel} 两键赋值次数不等 ⇒ 存在单飞路径`);
      assert.ok(pe >= 1, `${rel} 应至少一处成对赋值`);
    }
    const blk = src(BRIDGE_TS).match(/export interface SessionHealth \{[\s\S]*?\n\}/)[0];
    assert.match(blk, /不得脱离/, '契约注释须写明成对约定');
  });

  test('C4 三处运行时形态：两键成对出现（在场则同在）', async () => {
    const shapes = [
      timeoutSessionSnapshot(5_000),
      await new PsBridgeSessionProbe({ call: () => Promise.reject(new Error('x')) }).probe(),
      await new UnavailableSessionProbe().probe(),
      await new PsBridgeSessionProbe({ call: async () => ({ sessionId: 2, windowStation: 'W', desktop: 'D', interactive: true, locked: false, blackScreen: false, state: 'healthy' }) }).probe(),
    ];
    for (const s of shapes) {
      assert.equal('probeError' in s, 'probeErrorCode' in s, '两键在场性必须一致（无单飞）');
    }
  });

  test('C5 旧消费面读旧字段零变化（新增键不影响既有读取）', async () => {
    const s = await new UnavailableSessionProbe().probe();
    // 以旧读者视角逐字段取数
    const legacy = {
      sessionId: s.sessionId,
      windowStation: s.windowStation,
      desktop: s.desktop,
      interactive: s.interactive,
      locked: s.locked,
      blackScreen: s.blackScreen,
      state: s.state,
      detail: s.detail,
    };
    assert.deepEqual(legacy, {
      sessionId: 0,
      windowStation: '',
      desktop: '',
      interactive: false,
      locked: false,
      blackScreen: false,
      state: 'unavailable',
      detail: '会话探针未接入（非 Windows 环境或未初始化）',
    }, '旧字段读数即 HEAD 行为');
    assert.equal(Object.keys(legacy).length, 8);
  });

  test('C6 T5/T7/T8 契约区锚点逐字在场（本批零触碰）', () => {
    const text = src(BRIDGE_TS);
    assert.match(text, /export interface SecurityHealth \{/, 'T5 区失踪');
    assert.match(text, /export interface TasksHealth \{/, 'T7 区失踪');
    assert.match(text, /readonly approvalTruth\?:/, 'T8 GoalResult.approvalTruth 失踪');
    assert.match(text, /export interface ApprovalTruthAttribution \{/, 'T8 ApprovalTruthAttribution 失踪');
    assert.match(text, /export interface LlmSessionHealth \{/, 'CL-018 区失踪');
  });

  test('C7 LlmSessionHealth 旧字段必填性零变化', () => {
    const blk = src(BRIDGE_TS).match(/export interface LlmSessionHealth \{[\s\S]*?\n\}/)[0];
    assert.match(blk, /readonly state: LlmSessionState;/);
    assert.match(blk, /readonly restarts: number;/);
    assert.match(blk, /readonly idleMs: number;/);
    assert.match(blk, /readonly lastError\?: string;/);
    assert.match(blk, /readonly lastErrorAt\?: string;/);
    assert.match(blk, /readonly firstCallLatencyMs\?: number;/);
  });
});

/* ============================================================================
 * D 组 · firstCallLatencyMs 冷启动度量（E-1）
 * ========================================================================== */

class FakeChild {
  constructor(pid, behavior) {
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
    this.out = new EventEmitter();
    this.err = new EventEmitter();
    this.proc = new EventEmitter();
    this.frameIndex = 0;
    this.behavior = behavior;
    const self = this;
    this.stdout = { on: (e, l) => self.out.on(e, l) };
    this.stderr = { on: (e, l) => self.err.on(e, l) };
    this.stdin = {
      write: (chunk) => {
        self._onWrite(chunk);
        return true;
      },
      end: () => self._finish(0),
    };
  }
  on(e, l) {
    this.proc.on(e, l);
    return this;
  }
  kill() {
    this.killed = true;
    this._finish(0);
  }
  emitEv(ev) {
    this.out.emit('data', JSON.stringify(ev) + '\n');
  }
  _finish(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.proc.emit('exit', code);
  }
  _onWrite(chunk) {
    const index = this.frameIndex++;
    this.behavior({
      index,
      childNo: this.pid - 1000,
      chunk,
      emit: (ev) => this.emitEv(ev),
      exit: (code = 0) => this._finish(code),
    });
  }
}

const DSINK = { onStatus: () => {} };

/**
 * 确定性时钟会话夹具（照 cl018 范式）：`now` 由外部变量控制，
 * 故首调耗时可精确到毫秒（离线可证，不依赖真实计时器精度）。
 */
function makeSession(behavior, opts = {}) {
  const spawnCalls = [];
  const children = [];
  let clock = 1_000_000;
  const session = new PersistentCliSession({
    cliPath: 'codebuddy',
    outputDir: 'C:\\out',
    mcpConfigPath: 'C:\\out\\mcp.json',
    sessionId: 'p2t9',
    idleTtlMs: opts.idleTtlMs ?? 10_000,
    readyTimeoutMs: opts.readyTimeoutMs ?? 200,
    warmupReadyMs: opts.warmupReadyMs ?? 200,
    maxRestarts: opts.maxRestarts ?? 5,
    maxWsBytes: 1_000_000_000,
    spawnFn: (args) => {
      spawnCalls.push(args);
      const child = new FakeChild(1000 + spawnCalls.length, behavior);
      children.push(child);
      if (!opts.noInit) queueMicrotask(() => child.exitCode === null && child.emitEv({ type: 'system/init' }));
      return child;
    },
    now: () => clock,
    log: () => {},
  });
  return { session, spawnCalls, children, setClock: (v) => (clock = v), clock: () => clock };
}

const OK_BEHAVIOR = ({ emit }) => {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
  emit({ type: 'result', subtype: 'success', result: 'done' });
};

describe('P2-T9 D · firstCallLatencyMs 度量形状（E-1）', () => {
  test('D1 从未首调 ⇒ 键缺席（不是 0）', () => {
    const { session } = makeSession(OK_BEHAVIOR);
    const snap = session.snapshot();
    assert.ok(!Object.keys(snap).includes('firstCallLatencyMs'), '缺席即「服务启动后尚未发生首调」；填 0 会被误读为首调极快');
    assert.equal(snap.state, 'stopped');
  });

  test('D1b 仅预热未投喂 ⇒ 键仍缺席（预热窗口不是首调）', async () => {
    const { session } = makeSession(OK_BEHAVIOR);
    await session.warmup('预热目标', 200);
    const snap = session.snapshot();
    assert.ok(!Object.keys(snap).includes('firstCallLatencyMs'), 'warmup 不经 runTurn ⇒ 不得采样');
    assert.equal(session.firstCallSampled, false);
    await session.dispose();
  });

  test('D2 首调 ⇒ 精确毫秒数（确定性时钟，离线可证）', async () => {
    const { session, setClock } = makeSession(OK_BEHAVIOR);
    const p = session.runTurn('goal-1', DSINK, 5_000);
    setClock(1_000_000 + 8_700); // 本轮 settle 时时钟推进 8.7s（真机冷启动量级）
    const r = await p;
    assert.equal(r.ok, true);
    const snap = session.snapshot();
    assert.equal(snap.firstCallLatencyMs, 8_700, '首调耗时 = 入口→settle 的毫秒数');
    assert.equal(session.firstCallSampled, true);
  });

  test('D2b 采样时点 = settle 非入口（在飞期间未采样）', async () => {
    const { session } = makeSession(OK_BEHAVIOR);
    const p = session.runTurn('goal-1', DSINK, 5_000);
    assert.equal(session.firstCallSampled, false, '轮未 settle ⇒ 不得提前采样');
    await p;
    assert.equal(session.firstCallSampled, true, 'settle 后（同一微任务批次）即采样');
  });

  test('D3 二调不覆盖（一次性采样）', async () => {
    const { session, setClock } = makeSession(OK_BEHAVIOR);
    const p1 = session.runTurn('goal-1', DSINK, 5_000);
    setClock(1_000_000 + 1_000);
    await p1;
    assert.equal(session.snapshot().firstCallLatencyMs, 1_000);
    const p2 = session.runTurn('goal-2', DSINK, 5_000);
    setClock(1_000_000 + 99_000);
    await p2;
    assert.equal(session.snapshot().firstCallLatencyMs, 1_000, '后续轮不得覆盖首调指标（否则度量失去冷启动含义）');
  });

  test('D4 unavailable 首调同样计（常驻降级轮的耗时同样反映冷度）', async () => {
    const { session, setClock } = makeSession(OK_BEHAVIOR);
    await session.shutdown(); // 硬关闭态 ⇒ runTurn 走既有 unavailableResult 终局，不 spawn
    const p = session.runTurn('goal-x', DSINK, 5_000);
    setClock(1_000_000 + 333);
    const r = await p;
    assert.equal(r.unavailable, true);
    assert.equal(session.snapshot().firstCallLatencyMs, 333, 'unavailable 终局同样是一次首调');
  });

  test('D4b ensureReady 失败路径（超重建上限→disabled）首调同样计', async () => {
    const { session, setClock } = makeSession(OK_BEHAVIOR, { maxRestarts: 0 });
    // maxRestarts=0 ⇒ ensureReady 立刻置 disabled 并返回 false ⇒ unavailableResult
    const p = session.runTurn('goal-y', DSINK, 5_000);
    setClock(1_000_000 + 77);
    const r = await p;
    assert.equal(r.unavailable, true);
    assert.equal(session.snapshot().firstCallLatencyMs, 77, '就绪失败终局也计入首调耗时（度量口径=settle 而非成功）');
  });

  test('D5 restartFresh 不清零（运维复位 ≠ 服务重启，保守口径）', async () => {
    const { session, setClock } = makeSession(OK_BEHAVIOR);
    const p = session.runTurn('goal-1', DSINK, 5_000);
    setClock(1_000_000 + 2_500);
    await p;
    assert.equal(session.snapshot().firstCallLatencyMs, 2_500);
    const after = session.restartFresh();
    assert.equal(after.state, 'stopped', '复位后 state 归 stopped（既有行为）');
    assert.equal(session.snapshot().firstCallLatencyMs, 2_500, 'firstCallLatencyMs 不随复位清零');
    assert.equal(after.firstCallLatencyMs, 2_500, '复位返回的观测项同样透出');
  });

  test('D6 透出形态：新键在观测项末尾追加，旧键相对顺序零变化', async () => {
    const { session, setClock } = makeSession(OK_BEHAVIOR);
    const p = session.runTurn('goal-1', DSINK, 5_000);
    setClock(1_000_000 + 42);
    await p;
    const keys = Object.keys(session.snapshot());
    assert.deepEqual(keys, ['state', 'pid', 'restarts', 'idleMs', 'firstCallLatencyMs'], '旧观测键逐字在前、新键在尾追加（无中间插键）');
  });

  test('D7 阈值语义可对账：≤readyTimeoutMs=预热命中、≫=冷启动发生（形状非计算）', async () => {
    const warm = makeSession(OK_BEHAVIOR, { readyTimeoutMs: 60_000 });
    const p1 = warm.session.runTurn('g', DSINK, 5_000);
    warm.setClock(1_000_000 + 5_000);
    await p1;
    const hit = warm.session.snapshot().firstCallLatencyMs;
    assert.ok(hit <= 60_000, '本例落在「预热命中」判据区间');

    const cold = makeSession(OK_BEHAVIOR, { readyTimeoutMs: 60_000 });
    const p2 = cold.session.runTurn('g', DSINK, 5_000);
    cold.setClock(1_000_000 + 95_000);
    await p2;
    const deep = cold.session.snapshot().firstCallLatencyMs;
    assert.ok(deep > 60_000, '本例落在「冷启动发生」判据区间（真机 ≈75–107s 量级）');
  });

  test('D8 度量只读不改行为：有无耗时推进都不改变本轮结果', async () => {
    const a = makeSession(OK_BEHAVIOR);
    const ra = await a.session.runTurn('g', DSINK, 5_000);
    const b = makeSession(OK_BEHAVIOR);
    const pb = b.session.runTurn('g', DSINK, 5_000);
    b.setClock(1_000_000 + 7_000);
    const rb = await pb;
    assert.equal(rb.ok, ra.ok);
    assert.equal(rb.text, ra.text);
    assert.equal(ra.durationMs, 0);
    assert.equal(a.session.snapshot().firstCallLatencyMs, 0, '冻结时钟下首调耗时 0 ⇒ 在场（0 是合法值，缺席才代表未首调）');
    assert.equal(rb.durationMs, 0, '本轮 durationMs 仍由内部 started 起算，不被度量位改道');
  });

  test('D9 源码钉：runTurnInner 主体保留既有串行链与判据（仅外层包采样）', () => {
    const s = src(SESSION_TS);
    assert.match(s, /runTurn\(\n\s*prompt: string,/, 'runTurn 公开签名不变');
    assert.match(s, /const entryMs = this\.now\(\);/, '入口即取起点（排队前）');
    assert.match(s, /private runTurnInner\(/, '主体拆为私有方法（enqueue 语义不变）');
    assert.match(s, /if \(this\.firstCallLatencyMs !== undefined\) return;/, '幂等：已有值绝不覆盖');
    assert.match(s, /firstCallLatencyMs: this\.firstCallLatencyMs/, '观测项条件透出');
    assert.ok(!s.includes('firstCallLatencyMs = 0'), '不得清零（restartFresh 保留）');
  });

  test('D10 server.ts 零改动结论复算：两处透出面为整对象/展开形态', () => {
    const s = src('packages/vm-service/src/server.ts');
    assert.match(s, /^ {6}session,$/m, '/health.session 整对象直传 ⇒ 新键自动透出');
    assert.match(s, /\.\.\.\(llmSession !== undefined \? \{ llmSession \} : \{\}\)/, '/health.llmSession 展开透传 ⇒ 新键自动透出');
    assert.match(s, /const llmSession = provider\?\.llmSessionHealth\?\.\(\);/, '同步取观测项整对象（无逐字段白名单）');
  });
});

/* ============================================================================
 * E 组 · 文档判据在位（K-20 划线诚实化的落地面）
 * ========================================================================== */

describe('P2-T9 E · 文档口径升级在位', () => {
  test('E1 SECURITY §5.3 表下口径行在场（探测失败 ≠ 会话不可交互）', () => {
    const d = src('docs/02-design/SECURITY-GOVERNANCE.md');
    const seg = d.slice(d.indexOf('### 5.3 会话健康探针'), d.indexOf('### 5.4 恢复动作'));
    assert.match(seg, /探测失败 ≠ 会话不可交互/, 'E-2 判据升级行须在 §5.3 表下');
    assert.match(seg, /PROBE_NOT_WIRED|PROBE_TIMEOUT/);
    assert.match(seg, /probeError/);
    assert.match(seg, /phase2-session-unknown/, '判据自指：登记测试为钉死点');
    assert.match(seg, /一字未改|一字未改/, 'PR8 门禁行为不变的口径须写明');
  });

  test('E2 INTERFACES IF-6 字段注在场（probeError/probeErrorCode + firstCallLatencyMs）', () => {
    const d = src('docs/02-design/INTERFACES.md');
    const seg = d.slice(d.indexOf('## 6. IF-6 健康检查'), d.indexOf('## 7.') > 0 ? d.indexOf('## 7.') : d.length);
    assert.match(seg, /probeError/);
    assert.match(seg, /probeErrorCode/);
    assert.match(seg, /PROBE_TIMEOUT/);
    assert.match(seg, /纯附加/);
    assert.match(seg, /firstCallLatencyMs/, 'E-1 度量位同步登记（否则文档只讲一半）');
  });

  test('E3 HOST-A2A-BRIDGE §8 判据登记行在场', () => {
    const d = src('docs/02-design/HOST-A2A-BRIDGE.md');
    const seg = d.slice(d.indexOf('## 8. 测试与验证'), d.indexOf('## 9.'));
    assert.match(seg, /P2-T9/);
    assert.match(seg, /probeError/);
    assert.match(seg, /firstCallLatencyMs/);
    assert.match(seg, /guiAllowed 判据一字未改|判据一字未改/, 'PR8 口径落地');
    assert.match(seg, /phase2-session-unknown/);
  });

  test('E4 health.ts 判据注释在场（probeError 不进判据的理由留档）', () => {
    const s = src(HEALTH_TS);
    assert.match(s, /判据行一字未改/, 'guiAllowed 上方判据注释在场');
    assert.match(s, /三重冗余/, '三重冗余证明（短路/兜底/不消费）须写明');
  });

  test('E5 旧临时口径未回潮：活文档不再出现「仅 state===healthy 才有意义」裸表述', () => {
    for (const rel of ['docs/02-design/HOST-A2A-BRIDGE.md', 'docs/02-design/INTERFACES.md', 'docs/02-design/SECURITY-GOVERNANCE.md', HEALTH_TS]) {
      assert.ok(!/仅 state === 'healthy' 才有意义|仅 state==='healthy' 才有意义/.test(src(rel)), `${rel} 出现未兑现的临时口径`);
    }
  });

  test('E6 守卫字样规避复算：三处非白名单 src 文件零 snapshot 字样', () => {
    for (const rel of [BRIDGE_TS, HEALTH_TS, CAPS_TS]) {
      assert.ok(!/snapshot/i.test(src(rel)), `${rel} 出现 snapshot 字样 ⇒ 会命中 phase2-snapshot-truth 白名单守卫`);
    }
  });

  test('E7 SECURITY 反证守卫兼容：新增行不含裸 before/after 字样', () => {
    const d = src('docs/02-design/SECURITY-GOVERNANCE.md');
    const bare = d
      .split('\n')
      .filter((l) => /before\/after|before-after/.test(l))
      .filter((l) => !/信息性|不产|不实现|零消费/.test(l));
    assert.deepEqual(bare.map((l) => l.slice(0, 60)), [], '含 before/after 的行必须同行带信息性口径（phase2-snapshot-truth 反证①）');
  });
});
