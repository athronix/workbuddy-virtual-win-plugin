#!/usr/bin/env node
/**
 * P2-T7 · 真机收敛性探测（决定 overflow 轮的构造手法）
 *
 * 问题：fill 轮 480 个任务恒 working ⇒ 非终态 ⇒ 不是驱逐候选 ⇒ 双闸门不动。
 * 需要实证：workbuddy provider（LLM 常驻会话串行消化）把一个 filler 任务从
 * submitted/working 收口到终态（completed/failed/canceled）需要多久、队列是否清得空。
 *
 * 手法：投 5 个零副作用任务（同 fill 参数），然后每 5s 轮询一次状态 + /health.tasks，
 * 最多 180s。输出每个 id 的 state 时间线。
 */
import { writeFileSync } from 'node:fs';

const A2A_URL = 'http://127.0.0.1:18443/a2a';
const HEALTH_URL = 'http://127.0.0.1:18443/health';
let rpcId = 1;
const t0 = Date.now();
const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`;

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
async function healthTasks() {
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
  const j = await res.json();
  return j.tasks ?? null;
}

const ids = [];
for (let i = 1; i <= 5; i += 1) {
  const r = await rpc('message/send', {
    message: {
      kind: 'message',
      role: 'user',
      messageId: `msg_t7_probe_${i}_${Date.now()}`,
      parts: [{ kind: 'text', text: `P2T7 convergence probe #${i} (no capability requested)` }],
    },
    metadata: { traceId: `tr_t7_probe_${i}`, maxRisk: 'L0', timeoutMs: 300_000, allowedCapabilities: [] },
    configuration: { blocking: false },
  });
  ids.push({ id: r.result?.id ?? null, sentState: r.result?.status?.state ?? null, err: r.error ?? null });
  console.log(`${stamp()} sent#${i} ${JSON.stringify(ids[i - 1]).slice(0, 200)}`);
}

const timeline = [];
let allTerminal = false;
for (let round = 1; round <= 36 && !allTerminal; round += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const states = [];
  for (const it of ids) {
    if (!it.id) { states.push('no-id'); continue; }
    const r = await rpc('tasks/get', { id: it.id }, 10_000);
    states.push(r.result?.status?.state ?? `ERR:${r.error?.code}`);
  }
  const h = await healthTasks().catch(() => null);
  const rec = { at: stamp(), round, states, tasks: h };
  timeline.push(rec);
  console.log(`${stamp()} r${round} ${states.join(',')} | tasks=${JSON.stringify(h)}`);
  allTerminal = states.every((s) => s === 'completed' || s === 'failed' || s === 'canceled' || s === 'rejected');
}

writeFileSync('C:/WinVMBridge/t7-converge-result.json', JSON.stringify({ ids, timeline }, null, 2), 'utf8');
console.log(`${stamp()} DONE allTerminal=${allTerminal} -> C:/WinVMBridge/t7-converge-result.json`);
