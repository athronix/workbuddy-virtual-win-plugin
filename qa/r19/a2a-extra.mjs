/**
 * A2A 通道「真机未覆盖 5 项」补齐验证驱动（代号 A-X，真机验证轮，不改源码）。
 *
 * 用法：node /storage/Users/currentUser/wbtmp/a2a-extra.mjs <subcmd> [选项]
 *   stream  --prefix=<绝对路径前缀> [--goal=...] [--timeout-ms=700000]
 *   list    --prefix=<绝对路径前缀> [--expect-task=<id>] [--page-size=50]
 *   card    --prefix=<绝对路径前缀>
 *   cancel  --prefix=<绝对路径前缀> [--goal=...] [--settle-ms=8000]
 *   reject  --prefix=<绝对路径前缀> [--pkg=QA.R19B.Nonexistent.99997]
 *   overlap --prefix=<绝对路径前缀> [--poll-ms=1000] [--settle-ms=3000] [--goal-a=...] [--pkg=...]
 *
 * 两个已知坑（本脚本已规避）：
 *   ① 证据落盘一律用**绝对路径前缀**（cwd 失效时相对路径不落盘）—— 现有 qa/r19/a2a-call.mjs
 *      的 writeFileSync 用相对路径，故不能复用其落盘逻辑；
 *   ② 参数一律 `--k=v` 等号形式（空格形式会 NaN → ERR_OUT_OF_RANGE）。
 *
 * SSE 读取：必须**增量**读取多个 `data:` 帧（现有 a2a-call.mjs 只取第一行就返回，不可复用）。
 */

import { writeFileSync, appendFileSync, statSync } from 'node:fs';

const ENDPOINT = 'http://127.0.0.1:18443/a2a';
const BASE = 'http://127.0.0.1:18443';

const argv = process.argv.slice(2);
const sub = argv[0];
const opts = {};
for (const a of argv.slice(1)) {
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
  const v = eq === -1 ? 'true' : a.slice(eq + 1);
  opts[k] = v;
}

const PREFIX = opts.prefix;
if (!PREFIX) {
  console.error('缺少 --prefix=<绝对路径前缀>');
  process.exit(2);
}
if (!PREFIX.startsWith('/')) {
  console.error(`--prefix 必须是绝对路径：${PREFIX}`);
  process.exit(2);
}
const OUT = `${PREFIX}.out.json`;
const TL = `${PREFIX}.timeline.log`;

const T0 = Date.now();
const stamp = (tag, extra = '') => {
  const line = `${new Date().toISOString()} ${tag} ${extra}`;
  try {
    appendFileSync(TL, line + '\n');
  } catch (e) {
    console.error('timeline 写入失败', String(e));
  }
  console.log(line);
};

/** 写完再读：二次确认 mtime + 字节数（避免读到 0B 假空文件） */
function writeEvidence(obj) {
  const json = JSON.stringify(obj, null, 2);
  writeFileSync(OUT, json);
  const st = statSync(OUT);
  if (st.size === 0) throw new Error(`证据文件为空（0B）：${OUT}`);
  return { file: OUT, bytes: st.size, mtime: st.mtime.toISOString() };
}

let idc = 1;
async function rpc(method, params, timeoutMs = 700_000) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  stamp('RPC', `${method} http=${res.status} bytes=${text.length}`);
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text, __http: res.status };
  }
}

function msg(text, extra = {}) {
  return { kind: 'message', role: 'user', messageId: 'msg_' + Date.now().toString(36), parts: [{ kind: 'text', text }], ...extra };
}

function sendParams(goal, { maxRisk = 'L1', allowedCapabilities, timeoutMs = 600_000, blocking = true, traceId } = {}) {
  const metadata = {
    traceId: traceId ?? 'tr_ax_' + Date.now().toString(36),
    maxRisk,
    timeoutMs,
    ...(allowedCapabilities ? { allowedCapabilities } : {}),
  };
  return {
    message: msg(goal),
    metadata,
    configuration: { blocking },
  };
}

const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];

async function pollUntil(taskId, { maxMs = 660_000, intervalMs = 10_000, stopOnInputRequired = false } = {}) {
  const seen = [];
  let last = null;
  while (Date.now() - T0 < maxMs) {
    const g = await rpc('tasks/get', { id: taskId }, 60_000);
    const st = g.result?.status?.state ?? g.error?.code ?? '?';
    seen.push({ atMs: Date.now() - T0, state: st });
    stamp('POLL', `${st} ${Date.now() - T0}ms`);
    if (g.result) last = g.result;
    if (stopOnInputRequired && st === 'input-required') break;
    if (TERMINAL.includes(st)) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { seen, final: last };
}

function approvalDataOf(task) {
  const fromStatus = (task?.status?.message?.parts ?? []).find((p) => p.kind === 'data')?.data;
  if (fromStatus?.approvalId) return fromStatus;
  const hist = [...(task?.history ?? [])].reverse();
  for (const m of hist) {
    const d = (m.parts ?? []).find((p) => p.kind === 'data' && p.data?.approvalId)?.data;
    if (d?.approvalId) return d;
  }
  return null;
}

/* ============================ A1 message/stream（SSE 增量读取） ============================ */

async function runStream() {
  const goal = opts.goal ?? '列出 VM 上 C:\\Windows\\Temp 目录下的文件名（最多 10 个），只读取不改任何东西';
  const timeoutMs = Number(opts['timeout-ms'] ?? 700_000);
  const params = sendParams(goal, { maxRisk: opts['max-risk'] ?? 'L1', timeoutMs: 600_000 });
  stamp('SSE_OPEN', `goal=${goal.slice(0, 60)}`);

  const tOpen = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method: 'message/stream', params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out = {
    case: 'A1-message/stream',
    goal,
    http: res.status,
    contentType: res.headers.get('content-type'),
    at: new Date().toISOString(),
    events: [],
  };
  stamp('SSE_HEAD', `http=${res.status} ct=${out.contentType}`);
  if (!res.body) {
    out.error = '响应无 body（非流式）';
    out.evidence = writeEvidence(out);
    return out;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let firstFrameMs = null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        if (firstFrameMs === null) firstFrameMs = Date.now() - tOpen;
        const payload = line.slice(6);
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          ev = { __raw: payload };
        }
        const result = ev.result ?? ev;
        out.events.push({
          atMs: Date.now() - tOpen,
          kind: result.kind ?? ev.kind ?? '?',
          final: result.final === true,
          state: result.status?.state ?? result.status ?? undefined,
          raw: result,
        });
        stamp('SSE_EV', `#${out.events.length} ${result.kind ?? '?'} final=${result.final === true} state=${result.status?.state ?? '-'}`);
      }
    }
    const lastEv = out.events[out.events.length - 1];
    if (lastEv && lastEv.kind === 'status-update' && lastEv.final) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* 已结束 */
  }

  out.firstFrameMs = firstFrameMs;
  out.eventCount = out.events.length;
  out.eventKindSeq = out.events.map((e) => e.kind);
  out.terminalEvent = out.events.find((e) => e.kind === 'status-update' && e.final) ?? null;
  out.totalMs = Date.now() - tOpen;
  // 从事件里取任务 id（status-update 通常带 taskId）
  const withId = out.events.map((e) => e.raw).find((r) => r?.taskId || r?.task?.id);
  out.taskId = withId?.taskId ?? withId?.task?.id ?? null;
  out.evidence = writeEvidence(out);
  stamp('SSE_DONE', `events=${out.eventCount} firstFrame=${firstFrameMs}ms total=${out.totalMs}ms`);
  return out;
}

/* ============================ A2 tasks/list ============================ */

async function runList() {
  const expect = opts['expect-task'];
  const out = { case: 'A2-tasks/list', at: new Date().toISOString() };
  // 依据 client.ts:169-180：listTasks(filter)，filter 含 contextId/status/pageSize/pageToken
  const r = await rpc('tasks/list', { pageSize: Number(opts['page-size'] ?? 50) }, 60_000);
  out.raw = r;
  out.result = r.result ?? null;
  const tasks = r.result?.tasks ?? [];
  out.taskCount = tasks.length;
  out.nextPageToken = r.result?.nextPageToken ?? null;
  out.totalSize = r.result?.totalSize ?? null;
  out.states = tasks.slice(0, 10).map((t) => ({ id: t.id, state: t.status?.state }));
  if (expect) {
    out.expectTaskId = expect;
    out.expectFound = tasks.some((t) => t.id === expect);
  }
  stamp('LIST', `count=${out.taskCount} totalSize=${out.totalSize} expectFound=${out.expectFound ?? 'n/a'}`);
  out.evidence = writeEvidence(out);
  return out;
}

/* ============================ A3 agent card ============================ */

async function runCard() {
  const out = { case: 'A3-agent-card', at: new Date().toISOString() };
  const wellKnown = `${BASE}/.well-known/agent-card.json`;
  const res = await fetch(wellKnown, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  out.wellKnown = {
    url: wellKnown,
    http: res.status,
    contentType: res.headers.get('content-type'),
    bytes: text.length,
    hasCapabilities: !!json && ('capabilities' in json),
    hasSkills: !!json && ('skills' in json),
    keys: json ? Object.keys(json) : null,
    name: json?.name ?? null,
    version: json?.version ?? null,
    capabilities: json?.capabilities ?? null,
    skillsCount: Array.isArray(json?.skills) ? json.skills.length : null,
    raw: json ?? text.slice(0, 2000),
  };
  stamp('CARD_GET', `http=${res.status} caps=${out.wellKnown.hasCapabilities} skills=${out.wellKnown.hasSkills}`);

  const ext = await rpc('agent/getAuthenticatedExtendedCard', {}, 60_000);
  out.extendedCardRpc = ext;
  stamp('CARD_EXT', JSON.stringify(ext.result ?? ext.error ?? {}).slice(0, 200));
  out.evidence = writeEvidence(out);
  return out;
}

/* ============================ A4 tasks/cancel ============================ */

async function runCancel() {
  const goal = opts.goal ?? '递归统计 VM 上 C:\\Windows\\System32 目录下所有 .dll 文件的数量，只统计不修改任何东西';
  const settleMs = Number(opts['settle-ms'] ?? 8000);
  const out = { case: 'A4-tasks/cancel', goal, at: new Date().toISOString() };

  // 非阻塞发起 → 立刻拿到 taskId
  const params = sendParams(goal, { maxRisk: opts['max-risk'] ?? 'L1', timeoutMs: 600_000, blocking: false });
  const s = await rpc('message/send', params, 120_000);
  out.send = s.result ?? s.error ?? s;
  const taskId = s.result?.id ?? null;
  out.taskId = taskId;
  stamp('SEND', `task=${taskId} state=${s.result?.status?.state ?? '?'}`);
  if (!taskId) {
    out.error = '未取得 taskId，无法取消';
    out.evidence = writeEvidence(out);
    return out;
  }

  // 等到首个非终态推进（working）再取消
  await new Promise((r) => setTimeout(r, settleMs));
  const g1 = await rpc('tasks/get', { id: taskId }, 60_000);
  out.stateBeforeCancel = g1.result?.status?.state ?? null;
  stamp('BEFORE_CANCEL', String(out.stateBeforeCancel));

  const c = await rpc('tasks/cancel', { id: taskId }, 60_000);
  out.cancel = c.result ?? c.error ?? c;
  out.stateAfterCancelRpc = c.result?.status?.state ?? null;
  stamp('CANCEL_RPC', `state=${out.stateAfterCancelRpc ?? JSON.stringify(c.error ?? {}).slice(0, 160)}`);

  const polled = await pollUntil(taskId, { maxMs: 300_000, intervalMs: 5000 });
  out.pollSeen = polled.seen;
  out.final = polled.final;
  out.finalState = polled.final?.status?.state ?? null;
  stamp('CANCEL_FINAL', String(out.finalState));
  out.evidence = writeEvidence(out);
  return out;
}

/* ============================ A5 审批拒绝 → rejected ============================ */

async function runReject() {
  const pkg = opts.pkg ?? 'QA.R19B.Nonexistent.99997';
  // A5-v2：v1 用 10s 轮询，若 input-required 只存在几秒会被整段漏掉 → 默认 1s 密采。
  const pollMs = Number(opts['poll-ms'] ?? 1000);
  const goal = `卸载 VM 上的软件包 ${pkg}（该包 id 故意不存在，勿改动其它任何软件）`;
  const out = { case: 'A5-approval-reject', pkg, goal, at: new Date().toISOString() };

  /* ---- 静默窗口前置留证（A5-v2a 判据）----
   * P1 的成因是「已 cancel 但 runGoal 仍在飞」的委派收尾清掉单例 activeTaskId，
   * 而 `cancelRequested` 只写不读 ⇒ tasks/list 全终态**不足以**证明无在飞委派。
   * 故发包前先快照 tasks/list（条数 + 各条 state + 与上一终态的时间距），
   * 把「本次是否真在静默窗口」变成可审计字段，而不是事后口述。
   */
  try {
    const pre = await rpc('tasks/list', { pageSize: 50 }, 30_000);
    const list = pre.result?.tasks ?? [];
    out.preflight = {
      taskCount: list.length,
      totalSize: pre.result?.totalSize ?? null,
      states: list.map((t) => ({ id: t.id, state: t.status?.state ?? '?' })),
      note:
        'tasks/list 全终态仅说明状态已收口，不证明其 runGoal 已返回（cancelRequested 只写不读）；' +
        '金标准为「服务重启后首发」，次选为全终态 + 距上一终态 ≥60s',
    };
    stamp('PREFLIGHT_LIST', `count=${list.length} states=${list.map((t) => t.status?.state ?? '?').join(',')}`);
  } catch (e) {
    out.preflight = { error: String(e) };
    stamp('PREFLIGHT_LIST', `error=${String(e).slice(0, 120)}`);
  }

  const params = sendParams(goal, {
    maxRisk: 'L2',
    allowedCapabilities: ['app.winget.uninstall'],
    timeoutMs: 600_000,
    blocking: false,
  });
  const s = await rpc('message/send', params, 120_000);
  out.send = s.result ?? s.error ?? s;
  const taskId = s.result?.id ?? null;
  out.taskId = taskId;
  stamp('SEND', `task=${taskId} state=${s.result?.status?.state ?? '?'}`);
  if (!taskId) {
    out.error = '未取得 taskId';
    out.evidence = writeEvidence(out);
    return out;
  }

  // 等到 input-required（审批挂起）
  let approval = null;
  let reachedInputRequired = false;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const g = await rpc('tasks/get', { id: taskId }, 60_000);
    const st = g.result?.status?.state ?? '?';
    stamp('POLL', `${st} ${Date.now() - T0}ms`);
    if (g.result) out.lastTask = g.result;
    if (st === 'input-required') {
      reachedInputRequired = true;
      approval = approvalDataOf(g.result);
      out.taskAtInputRequired = g.result;
      stamp('INPUT_REQUIRED', JSON.stringify(approval ?? {}).slice(0, 300));
      break;
    }
    if (TERMINAL.includes(st)) {
      out.earlyTerminal = st;
      stamp('EARLY_TERMINAL', `${st} ${Date.now() - T0}ms`);
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  out.reachedInputRequired = reachedInputRequired;
  out.approvalData = approval;

  if (!approval?.approvalId) {
    // A5-v2 诊断：即便没拿到挂起态的 approvalId，也从终态文本里回捞 apr_ token，并**照协议
    // 真发一次拒绝回复** —— 用服务端应答把「该任务上根本没有待处理审批」从推断升级为协议级
    // 证据（预期：continueTask 报「任务上没有待处理的审批 <id>」）。
    const blob = JSON.stringify(out.lastTask ?? {});
    // 收紧为 ≥8 位十六进制：避免把 messageId（已改 msg_ 前缀）或其它短串误当 token
    const m = blob.match(/apr_[0-9a-f]{8,}/);
    out.approvalIdFromText = m ? m[0] : null;
    out.error = '未进入 input-required，未拿到挂起态 approvalId；改用终态文本回捞 token 试发拒绝以取证';
    stamp('TEXT_TOKEN', String(out.approvalIdFromText));
    if (!out.approvalIdFromText) {
      out.evidence = writeEvidence(out);
      return out;
    }
    approval = { approvalId: out.approvalIdFromText, source: 'terminal-text' };
    out.approvalData = approval;
  }

  const reply = {
    kind: 'message',
    role: 'user',
    messageId: 'msg_' + Date.now().toString(36),
    taskId,
    parts: [{ kind: 'data', data: { approvalId: approval.approvalId, approved: false } }],
  };
  const rr = await rpc('message/send', { message: reply, metadata: { traceId: params.metadata.traceId + '-reply' } }, 120_000);
  out.replyRpc = rr.result ?? rr.error ?? rr;
  out.stateAfterReply = rr.result?.status?.state ?? null;
  stamp('REPLY_FALSE', `state=${out.stateAfterReply ?? JSON.stringify(rr.error ?? {}).slice(0, 200)}`);

  const polled = await pollUntil(taskId, { maxMs: 300_000, intervalMs: 8000 });
  out.pollSeen = polled.seen;
  out.final = polled.final;
  out.finalState = polled.final?.status?.state ?? null;
  out.finalTerminalStateExt = polled.final?.status?.message ?? null;
  stamp('REJECT_FINAL', String(out.finalState));
  out.evidence = writeEvidence(out);
  return out;
}

/* ==================== R3 ② A4+A5 交叠：A5 仍必须挂起 ==================== *
 * A5 缺陷的**核心场景**：上一次委派（A4）的 runGoal 仍在飞时发起 A5，
 * A4 收尾 endTask() 清掉服务级单例 ⇒ A5 的 raise 早退 no-active-task ⇒ 从不挂起。
 * 本子命令用**真实时序**复现该交叠（非 sleep 猜测）：
 *   A4 非阻塞发起 → 等到 A4 进入非终态推进（working/submitted）→ 此时发起 A5
 *   → 1s 密采轮训 A5 是否到达 input-required。
 * 判据（修复后）：a5.reachedInputRequired === true。
 * 判据（修复前，基线）：A5 直接进终态 failed，earlyTerminal='failed'。
 *
 * 用法：overlap --prefix=<绝对路径前缀> [--poll-ms=1000] [--settle-ms=3000]
 *              [--goal-a=...] [--pkg=QA.R19B.Nonexistent.99997]
 * ======================================================================== */

async function runOverlapCase() {
  const pollMs = Number(opts['poll-ms'] ?? 1000);
  const settleMs = Number(opts['settle-ms'] ?? 3000);
  const pkg = opts.pkg ?? 'QA.R19B.Nonexistent.99997';
  const goalA =
    opts['goal-a'] ??
    '递归统计 VM 上 C:\\Windows\\System32 目录下所有 .dll 文件的数量，只统计不修改任何东西';
  const goalB = `卸载 VM 上的软件包 ${pkg}（该包 id 故意不存在，勿改动其它任何软件）`;
  const out = { case: 'A5-overlap-A4+A5', goalA, goalB, pkg, at: new Date().toISOString() };

  /* ---- 静默窗口前置留证（同 runReject）---- */
  try {
    const pre = await rpc('tasks/list', { pageSize: 50 }, 30_000);
    const list = pre.result?.tasks ?? [];
    out.preflight = {
      taskCount: list.length,
      states: list.map((t) => ({ id: t.id, state: t.status?.state ?? '?' })),
      note: '全终态仅说明状态已收口，不证明其 runGoal 已返回（cancelRequested 只写不读）',
    };
    stamp('PREFLIGHT_LIST', `count=${list.length} states=${list.map((t) => t.status?.state ?? '?').join(',')}`);
  } catch (e) {
    out.preflight = { error: String(e) };
    stamp('PREFLIGHT_LIST', `error=${String(e).slice(0, 120)}`);
  }

  /* ---- A4：长耗时只读委派，非阻塞发起（模拟「上一次委派仍在飞」）---- */
  const sA = await rpc(
    'message/send',
    sendParams(goalA, { maxRisk: 'L1', timeoutMs: 600_000, blocking: false, traceId: 'tr_r3_a4' }),
    120_000,
  );
  const tA = sA.result?.id ?? null;
  out.a4 = { taskId: tA, sendState: sA.result?.status?.state ?? null, sendAtMs: Date.now() - T0 };
  stamp('SEND_A4', `task=${tA} state=${out.a4.sendState} atMs=${out.a4.sendAtMs}`);
  if (!tA) {
    out.error = '未取得 A4 的 taskId';
    out.evidence = writeEvidence(out);
    return out;
  }

  // 让 A4 真正跑起来（非终态）后，再发起 A5 —— 这才构成「交叠」
  await new Promise((r) => setTimeout(r, settleMs));
  const gA = await rpc('tasks/get', { id: tA }, 60_000);
  out.a4.stateWhenA5Sent = gA.result?.status?.state ?? null;
  out.a4.msBeforeA5Sent = Date.now() - T0;
  stamp('A4_STATE_WHEN_A5_SENT', `${out.a4.stateWhenA5Sent} ${out.a4.msBeforeA5Sent}ms`);

  /* ---- A5：高危卸载委派，交叠中发起 ---- */
  const sB = await rpc(
    'message/send',
    sendParams(goalB, {
      maxRisk: 'L2',
      allowedCapabilities: ['app.winget.uninstall'],
      timeoutMs: 600_000,
      blocking: false,
      traceId: 'tr_r3_a5',
    }),
    120_000,
  );
  const tB = sB.result?.id ?? null;
  out.a5 = { taskId: tB, sendState: sB.result?.status?.state ?? null, sendAtMs: Date.now() - T0 };
  stamp('SEND_A5', `task=${tB} state=${out.a5.sendState} atMs=${out.a5.sendAtMs}`);
  if (!tB) {
    out.error = '未取得 A5 的 taskId';
    out.evidence = writeEvidence(out);
    return out;
  }

  /* ---- 密采 A5：是否真的挂起 input-required ---- */
  let approval = null;
  let reachedInputRequired = false;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const g = await rpc('tasks/get', { id: tB }, 60_000);
    const st = g.result?.status?.state ?? '?';
    stamp('POLL_A5', `${st} ${Date.now() - T0}ms`);
    if (g.result) out.a5.lastTask = g.result;
    if (st === 'input-required') {
      reachedInputRequired = true;
      approval = approvalDataOf(g.result);
      out.a5.taskAtInputRequired = g.result;
      out.a5.msToInputRequired = Date.now() - T0;
      stamp('A5_INPUT_REQUIRED', JSON.stringify(approval ?? {}).slice(0, 300));
      break;
    }
    if (TERMINAL.includes(st)) {
      out.a5.earlyTerminal = st;
      out.a5.msToEarlyTerminal = Date.now() - T0;
      stamp('A5_EARLY_TERMINAL', `${st} ${out.a5.msToEarlyTerminal}ms`);
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  out.a5.reachedInputRequired = reachedInputRequired;
  out.a5.approvalData = approval;

  /* ---- 收尾：等 A4 终态（记录 A4 轮次耗时，供 Q2 取证对照）---- */
  const polledA = await pollUntil(tA, { maxMs: 300_000, intervalMs: 5000 });
  out.a4.pollSeen = polledA.seen;
  out.a4.finalState = polledA.final?.status?.state ?? null;
  out.a4.final = polledA.final;
  out.a4.msToTerminal = Date.now() - T0;
  stamp('A4_FINAL', `${out.a4.finalState} ${out.a4.msToTerminal}ms`);

  out.evidence = writeEvidence(out);
  return out;
}

/* ============================ 分派 ============================ */

const RUN = { stream: runStream, list: runList, card: runCard, cancel: runCancel, reject: runReject, overlap: runOverlapCase };

(async () => {
  const fn = RUN[sub];
  if (!fn) {
    console.error(`未知 subcmd: ${sub}（可选 ${Object.keys(RUN).join(' / ')}）`);
    process.exit(2);
  }
  try {
    const o = await fn();
    console.log('\n=== EVIDENCE ===');
    console.log(JSON.stringify({ case: o.case, evidence: o.evidence }, null, 2));
    process.exit(0);
  } catch (e) {
    stamp('FATAL', String(e && e.stack ? e.stack : e));
    try {
      writeEvidence({ case: sub, fatal: String(e && e.stack ? e.stack : e), at: new Date().toISOString() });
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
})();