/**
 * L2-D 真机探针：构造 executedBeforeCancel **有态**取消样本（确定性模板路径，零源码改动）。
 *
 * 构造原理（读码结论，详见 l2d-timeline.log）：
 *   · provider=workbuddy-deterministic ⇒ 模板 2（磁盘/空间关键词）调 step('storage.cleanup.analyze',…)
 *   · step() 在能力调用**之前** sink.onStatus('working','执行 storage.cleanup.analyze：分析磁盘占用与清理建议')
 *     → TaskStore.updateStatus（message 以裸字符串过 wire：createProgressSink 把 string 原样塞进
 *     status.message，见 task-store.ts:631 的 as 强转）→ SSE emit（非终态，不覆盖后续 canceled）
 *   · 该 progress 行一出现即满足 DETERMINISTIC_STEP_MARK ⇒ 有态输入成立；此刻 tasks/cancel
 *     落在 analyze（registry 超时 120s、ps-bridge 实测数秒~数十秒）执行中 ⇒ 无 execution-steps
 *     载体、无 artifact 流出 ⇒ 期望派生 { steps: N>=1, artifacts: 0 }（非 null ⇒ 有态）
 *
 * 三路现场（全部真机数据，零手造）：
 *   A  生产呈现面：createA2aBridgeTools → a2a.delegate handler + 真 A2AClient（HTTP 通道 127.0.0.1:18443/a2a）
 *   B  wire 现场：tasks/subscribe 逐帧 + tasks/get 轮询（Message 对象/裸字符串两种形状都抽）
 *   A' 派生面：从 VM 现网 packages/host-a2a-bridge/dist/tools.js **运行时逐字截取**
 *      STEPS_CARRIER_NAME / DETERMINISTIC_STEP_MARK / deriveExecutedBeforeCancel / canceledSummaryText
 *      （new Function 装载生产原文，非重写），输入 = B 抓到的真机 progress/artifacts 现场。
 *
 * 用法：node l2d-probe.mjs --prefix=<绝对前缀> --attempt=<n> [--goal=...] [--cancel-delay-ms=0]
 */
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = 'C:/WinVMBridge';
const BASE = 'http://127.0.0.1:18443';
const A2A = `${BASE}/a2a`;

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const PREFIX = opt('prefix', `${REPO}/dev-and-qa/scratch/l2d-probe`);
const ATTEMPT = opt('attempt', '1');
const GOAL = opt('goal', '分析 C 盘磁盘空间占用，看看哪些大文件可以清理（只分析，不要删除任何东西）');
const CANCEL_DELAY_MS = Number(opt('cancel-delay-ms', '0'));

const TL = `${PREFIX}.attempt${ATTEMPT}.timeline.log`;
const OUT = `${PREFIX}.attempt${ATTEMPT}.out.json`;
const iso = () => new Date().toISOString();
const stamp = (tag, extra = '') => {
  const line = `${iso()} A${ATTEMPT} ${tag} ${extra}`;
  try { appendFileSync(TL, line + '\n'); } catch (e) { console.error('TL write fail', String(e)); }
  console.log(line);
};

/* ---------- wire 文本抽取：Message 对象与裸字符串两种形状都吃 ---------- */
function msgText(m) {
  if (typeof m === 'string') return m;
  if (m && Array.isArray(m.parts)) {
    return m.parts
      .filter((p) => p && p.kind === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim();
  }
  return '';
}
const STEP_MARK = /^执行\s+[A-Za-z0-9_.\-]+\s*[：:]/; // 与 tools.ts:322 同型（仅探针自判时机用）
const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];

/* ---------- raw JSON-RPC（编排面 C） ---------- */
let idc = 100;
async function rpc(method, params, timeoutMs = 30_000) {
  const res = await fetch(A2A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { __raw: text.slice(0, 500), __http: res.status }; }
}

/* ---------- 生产模块装载（现网 dist，只读） ---------- */
const { A2AClient } = await import(pathToFileURL(`${REPO}/packages/a2a-framework/dist/index.js`).href);
const { HttpJsonRpcChannel } = await import(pathToFileURL(`${REPO}/packages/core/dist/transport/http-channel.js`).href);
const { createA2aBridgeTools } = await import(pathToFileURL(`${REPO}/packages/host-a2a-bridge/dist/index.js`).href);

const realClient = new A2AClient(new HttpJsonRpcChannel({ baseUrl: BASE, path: '/a2a', defaultTimeoutMs: 300_000 }));
const delegateTool = createA2aBridgeTools({
  clientProvider: { get: async () => realClient },
  defaultMaxRisk: 'L1',
  defaultTimeoutMs: 300_000,
}).find((t) => t.name === 'a2a.delegate');

/* ---------- 现网源码逐字截取（A' 派生面；只切不改） ---------- */
function loadProductionDerive() {
  const toolsSrc = readFileSync(`${REPO}/packages/host-a2a-bridge/dist/tools.js`, 'utf8');
  const start = toolsSrc.indexOf('const STEPS_CARRIER_NAME');
  const end = toolsSrc.indexOf('export function createA2aBridgeTools');
  if (start < 0 || end < 0 || end <= start) throw new Error('derive segment markers not found in deployed tools.js');
  const slice = toolsSrc.slice(start, end);
  const api = new Function(`${slice}\nreturn { deriveExecutedBeforeCancel, canceledSummaryText, STEPS_CARRIER_NAME, DETERMINISTIC_STEP_MARK };`)();
  if (typeof api.deriveExecutedBeforeCancel !== 'function' || typeof api.canceledSummaryText !== 'function') {
    throw new Error('extracted production functions missing');
  }
  return { api, slice };
}

/* ---------- 前置校验：/health provider 指纹 ---------- */
const health = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(15_000) })).json();
const providerId = health.provider?.id;
if (providerId !== 'workbuddy-deterministic') {
  writeFileSync(OUT, JSON.stringify({ case: 'L2-D precheck FAILED', providerId, at: iso() }, null, 2));
  stamp('PRECHECK_FAIL', `provider=${providerId}（需 workbuddy-deterministic）`);
  process.exit(3);
}
stamp('PRECHECK_OK', `provider=${providerId} state=${health.provider?.state}`);

/* ---------- 单次尝试 ---------- */
const evidence = {
  case: `L2-D deterministic-cancel attempt ${ATTEMPT}`,
  goal: GOAL,
  cancelDelayMs: CANCEL_DELAY_MS,
  startedAt: iso(),
  discipline: 'zero git writes; zero source edits; dist+wire read-only; all derive inputs = live captures',
  healthPrecheck: { providerId, state: health.provider?.state },
  orchestration: {},
  sseWire: [],
  progressCaptures: [],
  hostDelegate: null,
};

const TRACE_ID = `tr_l2d_a${ATTEMPT}_${Date.now().toString(36)}`;

async function runOnce() {
  /* 1) 起生产 a2a.delegate（任务由生产 handler 的 message/stream 建立，带唯一 traceId） */
  stamp('DELEGATE_START', TRACE_ID);
  const delegatePromise = delegateTool.handler(
    { goal: GOAL, maxRisk: 'L1', timeoutMs: 300_000 },
    { traceId: TRACE_ID },
  );

  /* 2) 按 metadata.traceId 精确发现本任务（VM 有既有 live 任务，绝不错杀） */
  let taskId = null;
  const dl = Date.now() + 60_000;
  while (Date.now() < dl && !taskId) {
    const l = await rpc('tasks/list', { pageSize: 50 }, 15_000);
    const list = l.result?.tasks ?? [];
    const cand = list.find((t) => t.metadata?.traceId === TRACE_ID);
    if (cand) taskId = cand.id;
    else await new Promise((r) => setTimeout(r, 300));
  }
  if (!taskId) { evidence.orchestration.error = 'no taskId with our traceId in 60s'; stamp('NO_TASK'); return false; }
  evidence.orchestration.taskId = taskId;
  evidence.orchestration.traceId = TRACE_ID;
  stamp('TASK_ID', taskId);

  /* 3) 通道 B：SSE 订阅逐帧记录 wire（尽力早挂；漏帧由 tasks/get 补——status.message 是持久位） */
  const wire = [];
  const abort = new AbortController();
  const ssePromise = (async () => {
    try {
      const res = await fetch(A2A, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method: 'tasks/subscribe', params: { id: taskId } }),
        signal: abort.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dataLines = block.split('\n').filter((x) => x.startsWith('data:')).map((x) => x.slice(5).trimStart());
          if (!dataLines.length) continue;
          const payload = dataLines.join('\n');
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const ev = obj.result ?? obj;
            if (ev && ev.kind) {
              wire.push({ at: iso(), ev });
              stamp('WIRE', `${ev.kind} state=${ev.status?.state ?? '-'} msgType=${typeof ev.status?.message} text=${JSON.stringify(msgText(ev.status?.message)).slice(0, 140)}`);
            }
          } catch { /* 忽略不可解析帧 */ }
        }
      }
    } catch (e) { stamp('SSE_END', String(e).slice(0, 140)); }
  })();

  /* 4) 通道 C：轮询；现场一出现 `执行 …`（get 或 wire 任一路）即按延迟发 tasks/cancel */
  let cancelResp = null;
  const cdl = Date.now() + 200_000;
  while (Date.now() < cdl && !cancelResp) {
    const g = await rpc('tasks/get', { id: taskId }, 15_000);
    const st = g.result?.status?.state ?? `err:${g.error?.code ?? g.error?.message}`;
    const text = msgText(g.result?.status?.message);
    const wireSteps = wire.filter((w) => STEP_MARK.test(msgText(w.ev.status?.message))).length;
    if (g.result) {
      evidence.progressCaptures.push({ at: iso(), via: 'tasks/get', state: st, rawMessage: g.result.status?.message ?? null, text });
    }
    if (TERMINAL.includes(st)) {
      evidence.orchestration.cancelSkipped = `already terminal: ${st}`;
      stamp('TERMINAL_BEFORE_CANCEL', st);
      break;
    }
    if (STEP_MARK.test(text) || wireSteps >= 1) {
      stamp('STEP_SEEN', `getText=${JSON.stringify(text).slice(0, 120)} wireSteps=${wireSteps}`);
      if (CANCEL_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CANCEL_DELAY_MS));
      cancelResp = await rpc('tasks/cancel', { id: taskId }, 15_000);
      stamp('CANCEL_SENT', JSON.stringify(cancelResp).slice(0, 300));
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  /* 5) 等终态 */
  let finalTask = null;
  const tdl = Date.now() + 150_000;
  while (Date.now() < tdl) {
    const g = await rpc('tasks/get', { id: taskId }, 15_000);
    if (g.result) finalTask = g.result;
    if (g.result && TERMINAL.includes(g.result.status.state)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  abort.abort();
  await ssePromise.catch(() => undefined);

  evidence.orchestration.cancelResponse = cancelResp;
  evidence.orchestration.finalTask = finalTask;
  evidence.orchestration.finalState = finalTask?.status?.state ?? null;
  evidence.orchestration.finalArtifacts = finalTask?.artifacts ?? [];
  evidence.sseWire = wire;

  /* 6) 真机 step 行合并去重（wire + get 两路现场） */
  const seen = new Set();
  const stepLines = [];
  for (const w of wire) {
    const t = msgText(w.ev.status?.message);
    if (STEP_MARK.test(t) && !seen.has(t)) { seen.add(t); stepLines.push({ state: w.ev.status?.state ?? 'working', message: t }); }
  }
  for (const c of evidence.progressCaptures) {
    if (STEP_MARK.test(c.text) && !seen.has(c.text)) { seen.add(c.text); stepLines.push({ state: c.state, message: c.text }); }
  }
  evidence.liveStepLines = stepLines;
  stamp('FINAL', `state=${evidence.orchestration.finalState} stepLines=${stepLines.length} artifacts=${evidence.orchestration.finalArtifacts.length}`);

  /* 7) 通道 A：生产 delegate 结果（真 handler + 真 client） */
  const host = await delegatePromise;
  evidence.hostDelegate = {
    via: 'a2a.delegate production handler + real A2AClient (HTTP channel 127.0.0.1:18443/a2a)',
    isError: host.isError,
    structuredContent: host.structuredContent,
    content: host.content,
  };
  const sc = host.structuredContent ?? {};
  stamp('HOST_A', `state=${sc.state} progressN=${(sc.progress ?? []).length} ebc=${JSON.stringify(sc.executedBeforeCancel ?? null)}`);

  /* 8) 通道 A'：现网源码逐字截取 + 真机现场喂派生 */
  const { api, slice } = loadProductionDerive();
  const ebc = api.deriveExecutedBeforeCancel(evidence.orchestration.finalArtifacts, stepLines);
  const text = api.canceledSummaryText(ebc);
  evidence.liveDerive = {
    codeSource: 'C:/WinVMBridge/packages/host-a2a-bridge/dist/tools.js —— 运行时 indexOf 截取 STEPS_CARRIER_NAME..createA2aBridgeTools 段，new Function 装载（原文逐字，未重写）',
    slicedChars: slice.length,
    sliceHead: slice.slice(0, 200),
    inputProgressSource: 'live 现场：tasks/subscribe SSE 帧 + tasks/get status.message（合并去重，见 liveStepLines）',
    inputArtifactsSource: 'live 现场：tasks/get 终态 task.artifacts（见 orchestration.finalArtifacts）',
    inputs: { progressCount: stepLines.length, artifactsCount: evidence.orchestration.finalArtifacts.length },
    executedBeforeCancel: ebc,
    canceledSummaryText: text,
  };
  stamp('A_PRIME', `ebc=${JSON.stringify(ebc)} text=${JSON.stringify(text).slice(0, 220)}`);

  const okAPrime = Boolean(ebc && ebc.steps >= 1) && text.includes('取消前已有')
    && evidence.orchestration.finalState === 'canceled'
    && stepLines.length >= 1;
  const okA = Boolean(sc.executedBeforeCancel && sc.executedBeforeCancel.steps >= 1);
  evidence.verdict = {
    productionHostChannelStateful: okA,
    liveConstructedStatefulDerive: okAPrime,
    note: okA
      ? '生产 a2a.delegate 直接产出 executedBeforeCancel（宿主 streamMessage 的 progress 通路贯通）'
      : '生产 delegate 的 progress 为空 ⇒ wire 上 status.message 为裸字符串、宿主 extractText 只认 Message.parts（既有架构结论的又一次实测）；有态由 A 路取消现场 + A 路生产源码派生成立',
  };
  return okAPrime;
}

let ok = false;
try {
  ok = await runOnce();
} catch (e) {
  evidence.fatal = String(e && e.stack ? e.stack : e);
  stamp('FATAL', evidence.fatal.slice(0, 200));
}
evidence.success = ok;
evidence.finishedAt = iso();
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
await realClient.close().catch(() => undefined);
stamp('DONE', `success=${ok} out=${OUT}`);
process.exit(ok ? 0 : 1);
