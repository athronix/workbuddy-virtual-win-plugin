/**
 * D16 / I-6.9（2026-11-02 run5 取证）· PsBridge 看门狗忙态守卫单测
 *
 * 病灶（真机连败两轮实弹定性，非瞬态）：ps-bridge.ps1 单线程，长同步调用
 * （storage.cleanup.analyze 实测 ~46s）期间主循环阻塞——既发不出心跳、也无法应答
 * 任何消息（含看门狗 ping）。旧 watchdog 心跳超时后 ping 不通即 restart()，
 * **杀死正在干活的桥**：调用方收到 PSBRIDGE_HEARTBEAT_TIMEOUT（=被自己看门狗误杀），
 * 并发调用撞重启窗收 PSBRIDGE_EXITED。run1~4 的"E7 首跑瞬态、复跑即稳"实为
 * 46s vs 45s 阈值的临界侥幸（复跑缓存热了 ~39s < 45s 才过）。
 *
 * 修复：watchdog 在心跳陈旧时先看 pendingCount——
 *   忙（>0）⇒ 不 ping 不重启（假阳性源；在途调用有 per-call 超时兜底）；
 *   闲（=0）⇒ ping 确证后才判真僵死（旧语义原样保留 ⇒ 真死桥自愈不失明）。
 *
 * 覆盖：
 *  1. 纯判据 shouldProbeStaleHeartbeat（0=探测 / ≥1=放行）；
 *  2. 集成·忙态不被误杀（fake 单线程桥阻塞 6.5s > 心跳阈值+ping 窗口；修复前
 *     必现 restart 杀桥 → busy 调用 reject；修复后 ok + restarts=0 + 子进程未换）；
 *  3. 集成·真僵死仍被检出（idle 且心跳陈旧且 ping 无应答 → restart 照跑=守卫不削弱自愈）。
 *
 * 运行（只跑本文件）：node --test tests/unit/p6-d16-psbridge-busy-guard.test.js
 * （仅 POSIX 宿主；Windows 真 ps-bridge 由真机探针覆盖）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const { PsBridge } = await import(
  'file:///' + join(ROOT, 'packages/vm-capabilities/dist/ps-bridge.js').replace(/\\/g, '/')
);

const IS_POSIX = process.platform !== 'win32';

/* ---------------- fake 单线程桥（模拟 ps-bridge.ps1 协议面） ---------------- */

const FAKE_DIR = join(homedir(), 'wbtmp', 'd16-fakes');
mkdirSync(FAKE_DIR, { recursive: true });

// fake-bridge.js：ping 快答；__test.busy=阻塞事件循环（心跳/ping 全停=真实忙态）；
// __test.freeze=答完后全体静默（idle 真僵死模拟）。
const FAKE_BRIDGE = join(FAKE_DIR, 'fake-bridge.js');
writeFileSync(
  FAKE_BRIDGE,
  `'use strict';
const rl = require('readline').createInterface({ input: process.stdin });
let frozen = false;
const send = (o) => { if (!frozen) process.stdout.write(JSON.stringify(o) + '\\n'); };
setInterval(() => send({ type: 'heartbeat', ts: new Date().toISOString() }), 300).unref?.();
rl.on('line', (l) => {
  let r; try { r = JSON.parse(l); } catch { return; }
  if (frozen) return;
  if (r.module === '__meta' && r.function === 'ping') { send({ id: r.id, ok: true, data: { module: '__meta' } }); return; }
  if (r.module === '__test' && r.function === 'busy') {
    const ms = Number(r.params && r.params.ms) || 1000;
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 单线程阻塞 = ps1 长同步调用 */ }
    send({ id: r.id, ok: true, data: { done: ms } });
    return;
  }
  if (r.module === '__test' && r.function === 'freeze') {
    send({ id: r.id, ok: true, data: {} });
    frozen = true; // 此后心跳与应答全停（进程活着但僵死）
    return;
  }
  send({ id: r.id, ok: false, error: { code: 'UNKNOWN_FN' } });
});
`,
  'utf8',
);

// wrapper：吃掉 -NoProfile 等固定前缀，把 `-File <script>` 转交 node（与 ps-bridge 调用形态同构）
const FAKE_PS = join(FAKE_DIR, 'fake-powershell.sh');
writeFileSync(
  FAKE_PS,
  [
    '#!/bin/sh',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-File" ]; then exec "${FAKE_BRIDGE_NODE:-node}" "$a"; fi',
    '  prev="$a"',
    'done',
    'exit 2',
    '',
  ].join('\n'),
  'utf8',
);
chmodSync(FAKE_PS, 0o755);
process.env['FAKE_BRIDGE_NODE'] = process.execPath;

function newBridge(heartbeatTimeoutMs) {
  return new PsBridge({
    scriptPath: FAKE_BRIDGE,
    powershellPath: FAKE_PS,
    heartbeatTimeoutMs,
  });
}

/* ================= 1. 纯判据 ================= */

test('D16 判据：pending=0 ⇒ 探测；pending≥1（忙）⇒ 放行不探测', () => {
  assert.equal(PsBridge.shouldProbeStaleHeartbeat(0), true, 'idle 心跳陈旧必须照常探测（真死检出力不削弱）');
  assert.equal(PsBridge.shouldProbeStaleHeartbeat(1), false, '一发在途调用 = 忙态，禁止 ping-判死');
  assert.equal(PsBridge.shouldProbeStaleHeartbeat(7), false, '并发多发同样放行');
});

/* ================= 2. 忙态不被误杀 ================= */

test(
  '集成·忙态守卫：长调用(6.5s)期间 watchdog 不 ping 不重启——修复前该场景必现 HEARTBEAT_TIMEOUT 误杀',
  { skip: !IS_POSIX ? 'POSIX-only（fake sh wrapper）' : false },
  async () => {
    const prevRt = process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'];
    process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'] = '5000';
    const b = newBridge(1000); // 心跳阈值 1s：阻塞期必然"陈旧"，逼看门狗做决策
    try {
      await b.start();
      const pidBefore = b['child']?.pid;
      assert.ok(pidBefore, 'fake 桥已启动');

      // busy(7s) > 心跳阈值(1s) + 看门狗 ping 超时(5s) ⇒ 修复前旧逻辑在 t≈6s
      // ping 超时而 restart 杀桥，在途调用 t=6s 即被 failAll(HEARTBEAT_TIMEOUT) 打死；
      // 修复后守卫放行（pending>0 不 ping 不重启），调用 t=7s 完整收口。
      const BUSY_MS = 7000;
      const callP = b.call('__test', 'busy', { ms: BUSY_MS }, BUSY_MS + 9000);
      await new Promise((r) => setTimeout(r, 1600)); // 已过心跳阈值，调用在途（pending=1）

      // 手动触发一拍看门狗（等价于内部 5s 定时器的决策路径）——此刻必须只"放行"不"探测"
      await b['watchdog']();
      assert.equal(b['restarting'], false, '忙态守卫：watchdog 不得进入 restart 路径');
      assert.equal(b['child']?.pid, pidBefore, '看门狗不得杀死正在干活的桥');

      const data = await callP; // 修复前：此处 reject PSBRIDGE_HEARTBEAT_TIMEOUT
      assert.equal(data?.done, BUSY_MS, '在途长调用必须完整跑完并正常收口（call() 返回解包 data）');
      assert.equal(b['restarts'], 0, '全程零重启');
      assert.equal(b['child']?.pid, pidBefore, '桥进程身份未换');
    } finally {
      await b.stop();
      if (prevRt === undefined) delete process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'];
      else process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'] = prevRt;
    }
  },
);

/* ================= 3. 真僵死检出力不削弱 ================= */

test(
  '集成·idle 真僵死：心跳陈旧且 ping 无应答（pending=0）⇒ watchdog 照常 restart（守卫不 blinded 真死）',
  { skip: !IS_POSIX ? 'POSIX-only（fake sh wrapper）' : false },
  async () => {
    const prevRt = process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'];
    process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'] = '8000'; // 重启后新 fake 干净握手可完成
    const b = newBridge(1000);
    try {
      await b.start();
      const pidBefore = b['child']?.pid;
      await b.call('__test', 'freeze', {}, 4000); // freeze 应答后桥转入静默（进程活、心跳停、ping 无应答）
      await new Promise((r) => setTimeout(r, 1500)); // 心跳确定陈旧（无 pending）

      await b['watchdog'](); // ping(5s) 无应答 → restart → kill 旧 pid + 重 spawn
      assert.ok(b['restarts'] >= 1, '真僵死必须被检出并尝试重启（检出力保持）');
      assert.notEqual(b['child']?.pid, pidBefore, '旧僵死进程已被替换');
      assert.equal(b.running, true, '重启后新桥应在位');
    } finally {
      await b.stop();
      if (prevRt === undefined) delete process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'];
      else process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'] = prevRt;
    }
  },
);
