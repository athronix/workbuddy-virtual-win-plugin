// R19 A2A driver: message/send + tasks/get polling, timeline logging
// usage: node a2a-call.mjs <outPrefix> <mode:delegate|reply|get> [jsonArg]
//  delegate: {"goal":"...","allowedCapabilities":[...],"maxRisk":"L2","blocking":false,"timeoutMs":...}
//  reply:    {"taskId":"...","approvalId":"...","approved":true}
//  get:      {"taskId":"..."}
import { writeFileSync, appendFileSync } from 'node:fs';

const ENDPOINT = 'http://127.0.0.1:18443/a2a';
const [, , prefix, mode, rawArg] = process.argv;
const arg = rawArg ? JSON.parse(rawArg) : {};
const timeline = `${prefix}.timeline.log`;
let idc = 1;
const stamp = (tag, extra = '') => {
  const line = `${new Date().toISOString()} ${tag} ${extra}`;
  appendFileSync(timeline, line + '\n');
  console.log(line);
};

async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }),
    signal: AbortSignal.timeout(700_000),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

const T0 = Date.now();
const out = { mode, arg, t0: new Date(T0).toISOString() };

if (mode === 'delegate') {
  const message = {
    kind: 'message',
    role: 'user',
    messageId: 'msg_r19_' + Date.now(),
    parts: [
      {
        kind: 'text',
        text: arg.goal,
      },
    ],
  };
  const params = {
    message,
    metadata: {
      traceId: 'tr_r19_' + Date.now().toString(36),
      maxRisk: arg.maxRisk ?? 'L2',
      timeoutMs: arg.timeoutMs ?? 600000,
      ...(Array.isArray(arg.allowedCapabilities) ? { allowedCapabilities: arg.allowedCapabilities } : {}),
    },
    configuration: { blocking: arg.blocking ?? true },
  };
  stamp('SEND', JSON.stringify(params.metadata));
  const r = await rpc('message/send', params);
  out.sendElapsedMs = Date.now() - T0;
  out.send = r;
  stamp('SEND_DONE', `${out.sendElapsedMs}ms task=${r.result?.id ?? r.error?.code ?? '?'}`);
  const taskId = r.result?.id;
  // poll to terminal state
  if (taskId) {
    let state = r.result?.status?.state;
    out.terminalSeen = { state, atMs: Date.now() - T0 };
    let last = JSON.stringify(r.result);
    while (state && !['completed', 'failed', 'canceled', 'rejected'].includes(state) && Date.now() - T0 < (arg.pollMaxMs ?? 660000)) {
      await new Promise((s) => setTimeout(s, 15000));
      const g = await rpc('tasks/get', { id: taskId });
      state = g.result?.status?.state ?? state;
      out.terminalSeen = { state, atMs: Date.now() - T0 };
      stamp('POLL', `${state} ${Date.now() - T0}ms`);
      if (g.result) last = JSON.stringify(g.result);
      if (state === 'input-required') {
        out.pending = g.result;
        const ap = (g.result.status?.message?.parts ?? []).find((p) => p.kind === 'data')?.data
          ?? (g.result.history ?? []).slice().reverse().flatMap((m) => (m.parts ?? [])).find((p) => p.kind === 'data' && p.data?.approvalId)?.data;
        out.approvalData = ap ?? null;
        stamp('INPUT_REQUIRED', JSON.stringify(ap ?? {}).slice(0, 300));
        if (!arg.autoReply) break;
        if (ap?.approvalId) {
          const reply = {
            kind: 'message', role: 'user', messageId: 'apr_' + Date.now(), taskId,
            parts: [{ kind: 'data', data: { approvalId: ap.approvalId, approved: arg.approved ?? true } }],
          };
          const rr = await rpc('message/send', { message: reply, metadata: { traceId: params.metadata.traceId + '-reply' } });
          stamp('REPLY_DONE', rr.result?.status?.state ?? JSON.stringify(rr.error ?? {}).slice(0, 200));
          state = rr.result?.status?.state ?? 'working';
          out.reply = rr.result ?? rr.error;
        } else break;
      }
    }
    out.final = JSON.parse(last);
  }
} else if (mode === 'reply') {
  const reply = {
    kind: 'message', role: 'user', messageId: 'apr_' + Date.now(), taskId: arg.taskId,
    parts: [{ kind: 'data', data: { approvalId: arg.approvalId, approved: arg.approved ?? true } }],
  };
  const r = await rpc('message/send', { message: reply, metadata: { traceId: 'tr_r19_reply_' + Date.now().toString(36) } });
  out.result = r;
  stamp('REPLY', JSON.stringify(r.result?.status ?? r.error ?? {}).slice(0, 300));
} else {
  const r = await rpc('tasks/get', { id: arg.taskId });
  out.result = r;
  stamp('GET', r.result?.status?.state ?? JSON.stringify(r.error ?? {}).slice(0, 200));
}

out.endElapsedMs = Date.now() - T0;
writeFileSync(`${prefix}.out.json`, JSON.stringify(out, null, 2));
stamp('DONE', `${out.endElapsedMs}ms`);
