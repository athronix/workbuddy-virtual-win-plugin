#!/usr/bin/env node
/**
 * P2-T7 · L1 长会话真机窗口 —— **溢出轮（自然收口版）**（在 VM 内运行，本机回环 18443）
 *
 * 设计依据（现场实证，见 wbtmp/p2t7-timeline.log step7-C / t7-converge-probe）：
 *   1. provider=workbuddy 为 LLM 常驻会话，filler 任务（零能力白名单 allowedCapabilities:[]
 *      + maxRisk:L0 + 文案避开模板关键词）平均 **~5s 自然收口成 `completed` 终态**；
 *   2. ⚠ **不用 `tasks/cancel` 排空**：并发取消会让常驻会话「打断→重建→再打断」风暴
 *      （restarts 触顶 5 ⇒ 会话停用 ⇒ 服务崩溃，已在 step7-C 现场复现一次），风险不可控；
 *   3. 驱逐**只**由 `create()` 尾部触发（O-11）且候选须**终态**（R5），故构造手法为：
 *      「一波投递 30 条 → 轮询等全部收口成终态 → 再投下一波」。
 *      存量 ≤200 时不触闸门；越过 200 后每波 create 都在尾部逐出 1 条最旧终态
 *      ⇒ `evictedCount` 以斜率 1 线性爬升（阶梯曲线可直接观测）；
 *   4. 驱逐次序 = 投递次序（波间已 settle，`terminalAtMs` 与创建同序），故
 *      **客户端可精确预言每一条被逐 id**（victim(i) = created[evictedTotal 起点 + i]）
 *      ⇒ 归因观测用「真值」而不是猜测：
 *        · 窗口内被逐 id（evictedCount 末 64 名）⇒ `error.data.evicted === true`；
 *        · 窗口外被逐 id（最前若干名，落在环形容量 64 之外）⇒ **诚实 false**（无 evicted 键）；
 *        · 从未存在 id ⇒ 无 evicted 键（旧形状逐字节不变）；
 *        · 存活 id ⇒ 有 result。
 *   5. TTL 闸门（1h）本轮不会触发 ⇒ 链上 `ext.evict` 应只见 overflow 分布（ttlCount=0），
 *      这本身是「闸门可分」的反向实证。
 *
 * 目标量：TOTAL=280 ⇒ 越过 200 上限 80 次 ⇒ evictedCount≈80 > 环形容量 64
 * ⇒ 同时具备「窗口内 true」与「窗口外 false」两侧样本。
 *
 * 零副作用纪律：blocking:false + maxRisk:'L0' + allowedCapabilities:[]，全程只走
 * /a2a 的 message/send / tasks/get / tasks/list 与 /health；无 cancel、无审批触达、
 * 无能力执行（收敛探测已实证 filler 走 LLM 纯文本应答 → completed）。
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const A2A_URL = 'http://127.0.0.1:18443/a2a';
const HEALTH_URL = 'http://127.0.0.1:18443/health';
const STATE = 'C:/WinVMBridge/t7-round-state.json';
const FILLER_PHRASE = 'P2T7 bounded-retention pressure probe (no capability requested)';

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}
const TOTAL = Math.max(1, Number.parseInt(arg('tasks', '280'), 10) || 280);
const WAVE = Math.max(1, Number.parseInt(arg('wave', '30'), 10) || 30);
const SETTLE_MS = Math.max(30_000, Number.parseInt(arg('settle-ms', '420000'), 10) || 420_000);
const OUT = arg('out', 'C:/WinVMBridge/t7-round-result.json');

let rpcId = 1;
const t0 = Date.now();
const stamp = () => `${new Date().toISOString()} +${Math.round((Date.now() - t0) / 1000)}s`;

async function rpc(method, params, timeoutMs = 20_000) {
  const res = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}
async function health() {
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
  return res.json();
}
async function healthTasks() {
  const j = await health();
  return j.tasks ?? null;
}

const created = []; // {seq, id, sentAt}
const curve = []; // {at, phase, sent, tasks}
async function sample(phase, extra = {}) {
  const tasks = await healthTasks().catch(() => null);
  const rec = { at: stamp(), phase, sent: created.length, tasks, ...extra };
  curve.push(rec);
  console.log(`${stamp()} ${phase} sent=${created.length} tasks=${JSON.stringify(tasks)}`);
  return tasks;
}

await sample('boot');

let waveNo = 0;
while (created.length < TOTAL) {
  waveNo += 1;
  const n = Math.min(WAVE, TOTAL - created.length);
  const batch = [];
  for (let i = 0; i < n; i += 1) {
    const seq = created.length + 1;
    const r = await rpc('message/send', {
      message: {
        kind: 'message',
        role: 'user',
        messageId: `msg_t7_r_${seq}_${Date.now()}`,
        parts: [{ kind: 'text', text: `${FILLER_PHRASE} #r-${seq}` }],
      },
      metadata: { traceId: `tr_t7_round_${seq}`, maxRisk: 'L0', timeoutMs: 300_000, allowedCapabilities: [] },
      configuration: { blocking: false },
    });
    const id = r.result?.id ?? null;
    if (id) created.push({ seq, id, sentAt: Date.now(), sentState: r.result?.status?.state ?? null });
    else console.log(`${stamp()} SEND_FAIL seq=${seq} ${JSON.stringify(r.error ?? {})}`);
  }
  const tSent = await sample(`wave-${waveNo}-sent`);

  // settle：轮询本波 id 直到全部终态（或超时）。只读，不 cancel。
  const deadline = Date.now() + SETTLE_MS;
  let pending = created.slice(-n).map((c) => c.id);
  let lastCount = -1;
  let stableRounds = 0;
  while (Date.now() < deadline && pending.length > 0) {
    await new Promise((r) => setTimeout(r, 6000));
    const stillWorking = [];
    for (const id of pending) {
      const r = await rpc('tasks/get', { id }, 12_000).catch((e) => ({ getErr: String(e?.message) }));
      const st = r.result?.status?.state;
      if (st === 'working' || st === 'submitted') stillWorking.push(id);
    }
    pending = stillWorking;
    if (stillWorking.length === lastCount) stableRounds += 1;
    else stableRounds = 0;
    lastCount = stillWorking.length;
    if (stableRounds >= 8) {
      console.log(`${stamp()} wave-${waveNo} settle stalled with ${pending.length} working (give up waiting)`);
      break;
    }
  }
  await sample(`wave-${waveNo}-settled`, { stillWorking: pending.length });
  if (created.length < TOTAL) await new Promise((r) => setTimeout(r, 2000));
}

/* ================= 真值预言 + 归因观测 ================= */
const hEndRaw = await health();
const hEnd = hEndRaw.tasks ?? null;
const evicted = hEnd?.evictedCount ?? 0;
const maxTasks = hEnd?.maxTasks ?? 200;
const RING = 64;

// 驱逐次序 = 创建次序（波间 settle 保证 terminalAtMs 与创建同序）；
// 越过上限后每次 create 逐 1 条 ⇒ victim(i) = created[i]（i 从 0 起，最旧先出）
const victims = created.slice(0, evicted).map((c) => c.id);
const inWindow = victims.slice(-RING); // 末 64 名：环形窗口内 ⇒ 应 evicted:true
const outWindow = victims.slice(0, Math.max(0, victims.length - RING)); // 窗口外 ⇒ 诚实 false
const livePred = created.slice(evicted).map((c) => c.id);

async function probe(kind, id, expected) {
  const r = await rpc('tasks/get', { id }, 15_000).catch((e) => ({ fetchErr: String(e?.message) }));
  const rec = {
    kind,
    id,
    expected,
    hasResult: r.result !== undefined,
    state: r.result?.status?.state ?? null,
    errorData: r.error?.data ?? null,
    errorMessage: r.error?.message ?? null,
    hasEvictedKey: Boolean(r.error && r.error.data && 'evicted' in r.error.data),
    evictedTrue: Boolean(r.error?.data?.evicted === true),
    dataKeys: r.error?.data ? Object.keys(r.error.data).sort().join(',') : null,
  };
  console.log(`${stamp()} PROBE ${JSON.stringify(rec)}`);
  return rec;
}

const probes = [];
for (const id of inWindow.slice(0, 3)) probes.push(await probe('evicted-in-window', id, 'evicted:true'));
for (const id of inWindow.slice(-2)) probes.push(await probe('evicted-in-window-tail', id, 'evicted:true'));
for (const id of outWindow.slice(0, 3)) probes.push(await probe('evicted-out-of-window', id, 'honest-false'));
{
  const neverId = 't7-never-exists-00000000-0000-0000-0000-000000000000';
  probes.push(await probe('never-existed', neverId, 'legacy-shape'));
}
for (const id of livePred.slice(-3)) probes.push(await probe('live', id, 'hasResult'));

const hFinalRaw = await health();
const result = {
  meta: {
    purpose: 'P2-T7 L1 overflow-gate + attribution + evictedCount curve (natural convergence, no cancel)',
    zeroSideEffect: 'blocking:false + maxRisk:L0 + allowedCapabilities:[]；无 cancel、无审批、无能力执行',
    args: { TOTAL, WAVE, SETTLE_MS },
    startedAt: new Date(t0).toISOString(),
    elapsedMs: Date.now() - t0,
    node: process.version,
  },
  createdHead4: created.slice(0, 4).map((c) => c.id),
  createdTail4: created.slice(-4).map((c) => c.id),
  curve,
  victimsHead6: victims.slice(0, 6),
  victimsTail6: victims.slice(-6),
  inWindowHead6: inWindow.slice(0, 6),
  outWindowHead6: outWindow.slice(0, 6),
  probes,
  endHealth: { tasks: hFinalRaw.tasks ?? null, audit: hFinalRaw.audit ?? null, security: hFinalRaw.security ?? null },
  summary: {
    createdOk: created.length,
    evictedCountEnd: evicted,
    liveEnd: hEnd?.live ?? null,
    capRespected: (hFinalRaw.tasks?.live ?? 0) <= maxTasks,
    overflowGateFired: evicted > 0,
    curveMonotonic: curve.every(
      (r, i) => i === 0 || (r.tasks?.evictedCount ?? 0) >= (curve[i - 1].tasks?.evictedCount ?? 0),
    ),
    inWindowEvictedTrue: probes.filter((p) => p.kind.startsWith('evicted-in-window') && p.evictedTrue).length,
    inWindowProbes: probes.filter((p) => p.kind.startsWith('evicted-in-window')).length,
    outWindowHonestFalse: probes.filter((p) => p.kind === 'evicted-out-of-window' && !p.hasEvictedKey).length,
    outWindowProbes: probes.filter((p) => p.kind === 'evicted-out-of-window').length,
    neverLegacyShape: probes.filter((p) => p.kind === 'never-existed' && p.dataKeys === 'code').length,
    liveProbesOk: probes.filter((p) => p.kind === 'live' && p.hasResult).length,
    chainValid: hFinalRaw.audit?.chainValid ?? null,
    auditEntries: hFinalRaw.audit?.entries ?? null,
    threeValuesDefault:
      hFinalRaw.security?.authMode === 'loopback-only' &&
      hFinalRaw.security?.bearerSelfCheck?.code === 'not-mounted' &&
      hFinalRaw.security?.innerReconnect?.status === 'unverified',
  },
};
writeFileSync(OUT, JSON.stringify({ ...result, createdIds: created.map((c) => c.id) }, null, 2), 'utf8');
writeFileSync(STATE, JSON.stringify({ done: true, at: stamp(), out: OUT }, null, 2), 'utf8');
console.log(`${stamp()} DONE -> ${OUT}`);
console.log(`${stamp()} SUMMARY ${JSON.stringify(result.summary)}`);
