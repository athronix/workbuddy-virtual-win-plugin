// P2-T6 E5: host-side A2A delegation WITH bearer credential, through the tunnel.
// Goal is deliberately one that can ONLY be answered by a real inner tool call
// (VM-side CLI reconnecting to /mcp?dtid=) => if the credential path were broken,
// the chain would show completed + zeroInnerCalls:true (the T5/B3 harm shape).
// usage: node t6-a2a-call-bearer.mjs <outPrefix> <delegate|get|health> [jsonArg]
import { writeFileSync, appendFileSync } from 'node:fs';

const ENDPOINT = 'http://127.0.0.1:18443/a2a';
const HEALTH = 'http://127.0.0.1:18443/health';
const [, , prefix, mode, rawArg] = process.argv;
const arg = rawArg ? JSON.parse(rawArg) : {};
const token = 'p2t6-wired-token-4c7e';
const timeline = `${prefix}.timeline.log`;
let idc = 1;
const stamp = (tag, extra = '') => {
  const line = `${new Date().toISOString()} ${tag} ${extra}`;
  appendFileSync(timeline, line + '\n');
  console.log(line);
};
const headers = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${token}`,
});

async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }),
    signal: AbortSignal.timeout(700_000),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return { http: res.status, body: JSON.parse(line ? line.slice(6) : text) };
}

async function health() {
  const res = await fetch(HEALTH, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  const j = await res.json().catch(() => ({}));
  return { http: res.status, security: j.security, ok: j.ok };
}

const T0 = Date.now();
const out = { mode, tokenNote: 'bearer sent', t0: new Date(T0).toISOString() };

if (mode === 'delegate') {
  out.healthBefore = await health();
  stamp(
    'HEALTH_BEFORE',
    `http=${out.healthBefore.http} authMode=${out.healthBefore.security?.authMode} inner=${out.healthBefore.security?.innerReconnect?.status}`,
  );
  const params = {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'msg_t6e5_' + Date.now(),
      parts: [{ kind: 'text', text: arg.goal }],
    },
    metadata: {
      traceId: 'tr_t6e5_' + Date.now().toString(36),
      maxRisk: arg.maxRisk ?? 'L1',
      timeoutMs: arg.timeoutMs ?? 600000,
      ...(Array.isArray(arg.allowedCapabilities) ? { allowedCapabilities: arg.allowedCapabilities } : {}),
    },
    configuration: { blocking: arg.blocking ?? true },
  };
  out.traceId = params.metadata.traceId;
  stamp('SEND', JSON.stringify(params.metadata));
  const r = await rpc('message/send', params);
  out.sendHttp = r.http;
  out.send = r.body;
  stamp('SEND_DONE', `http=${r.http} ${Date.now() - T0}ms task=${r.body.result?.id ?? JSON.stringify(r.body.error ?? '?')}`);
  const taskId = r.body.result?.id;
  if (taskId) {
    const deadline = Date.now() + (arg.pollBudgetMs ?? 420000);
    const seen = [];
    let last = null;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, arg.pollMs ?? 6000));
      const g = await rpc('tasks/get', { id: taskId });
      last = g.body.result ?? g.body;
      const st = last?.status?.state ?? '?';
      seen.push(`${st}@${Date.now() - T0}ms`);
      stamp('POLL', st);
      if (['completed', 'failed', 'canceled', 'rejected', 'input-required'].includes(st)) break;
    }
    out.taskId = taskId;
    out.pollSeen = seen;
    out.final = last;
    out.terminal = last?.status?.state ?? 'unknown';
    stamp('FINAL', out.terminal);
  } else {
    out.terminal = 'no-task';
  }
  out.healthAfter = await health();
  stamp(
    'HEALTH_AFTER',
    `http=${out.healthAfter.http} inner=${out.healthAfter.security?.innerReconnect?.status}`,
  );
} else if (mode === 'health') {
  out.health = await health();
  stamp('HEALTH', JSON.stringify(out.health.security?.innerReconnect ?? {}));
} else if (mode === 'get') {
  const g = await rpc('tasks/get', { id: arg.taskId });
  out.http = g.http;
  out.body = g.body;
}
writeFileSync(`${prefix}.json`, JSON.stringify(out, null, 2) + '\n');
console.log('DONE terminal=' + (out.terminal ?? '?'));
