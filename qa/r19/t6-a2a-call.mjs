// P2-T6 E2E driver: bearer-aware message/send + tasks/get polling (a2a-call.mjs sibling).
// enforceBearer is ON in the drill window, so every non-exempt call must carry
// `Authorization: Bearer <token>`; token passed via argv (drill-only value, not a secret).
// usage: node t6-a2a-call.mjs <outPrefix> <mode:delegate|get> <bearerToken> [jsonArg]
import { writeFileSync, appendFileSync } from 'node:fs';

const ENDPOINT = 'http://127.0.0.1:18443/a2a';
const [, , prefix, mode, bearer, rawArg] = process.argv;
if (!bearer) {
  console.error('FATAL: bearer token (argv[4]) required while enforceBearer is ON');
  process.exit(1);
}
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
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
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
    messageId: 'msg_t6_' + Date.now(),
    parts: [{ kind: 'text', text: arg.goal }],
  };
  const params = {
    message,
    metadata: {
      traceId: 'tr_t6_' + Date.now().toString(36),
      maxRisk: arg.maxRisk ?? 'L1',
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
    }
    out.final = JSON.parse(last);
  }
} else if (mode === 'get') {
  const r = await rpc('tasks/get', { id: arg.taskId });
  out.result = r;
  stamp('GET', r.result?.status?.state ?? JSON.stringify(r.error ?? {}).slice(0, 200));
} else {
  console.error('usage: delegate|get');
  process.exit(1);
}

out.endElapsedMs = Date.now() - T0;
writeFileSync(`${prefix}.out.json`, JSON.stringify(out, null, 2));
stamp('DONE', `${out.endElapsedMs}ms`);
