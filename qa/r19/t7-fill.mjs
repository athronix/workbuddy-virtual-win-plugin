#!/usr/bin/env node
/**
 * P2-T7 · L1 长会话驱逐观测 —— **任务填充器**（在 **VM 内**运行，走 VM 本机回环 127.0.0.1:18443）
 *
 * 用途（设计 §3.1-3 / 任务书第③件）：在**默认 200/1h** 参数下构造 ≥200 个**零副作用** A2A 任务，
 * 把 TaskStore 的 `maxTasks` **溢出闸门**真实打出来，并观测：
 *   · `/health.tasks.evictedCount` 的增长曲线（逐批采样）；
 *   · 被逐 id 的 `tasks/get` 归因形态（`error.data.evicted` 在场/缺席）；
 *   · 存活集与驱逐计数的一致性（`live ≤ maxTasks`，`live + evicted ≈ 投递数`）。
 *
 * ★ 零副作用纪律（任务书铁律「绝不发起任何系统能力执行、不碰审批面」）：
 *   1. `blocking:false` —— 填充器不等终态，投完即返回（避免 200× LLM 会话串行了结的等待）；
 *   2. `metadata.maxRisk:"L0"` —— 任何需要 L1+ 授权的动作在策略引擎处即被拒 ⇒ 永不触达
 *      能力执行、永不触发审批闸（零审批挂起、零副作用）；
 *   3. `metadata.allowedCapabilities:[]` —— **空数组**使确定性执行器的 `allowed()` 对**所有**
 *      模板判 false ⇒ 五个目标模板一个都不进 ⇒ 走「无匹配模板」分支，**零能力调用**、
 *      任务以 `failed(UNKNOWN_CAPABILITY)` 快速收口（这正是我们要的廉价终态，
 *      终态才会成为驱逐候选）；
 *      （注意：传 `['*']` 会让 startsWith 匹配上全部能力 ⇒ 模板可达 ⇒ 真执行，**严禁**）
 *   4. `goal` 文案刻意避开全部模板关键词（安装/磁盘/系统信息/截图/生产处理等）；
 *   5. 全程只走 `/a2a` 协议面（message/send + tasks/get），不碰 `/mcp`。
 *
 * 用法（VM 内，Git Bash）：
 *   node /c/WinVMBridge/tools-t7/t7-fill.mjs --endpoints=18443 --tasks=240 --batch=12 \
 *        --health-every=2 --out=/c/WinVMBridge/tools-t7/t7-fill-result.json
 */

import { writeFileSync } from 'node:fs';

const A2A_URL = 'http://127.0.0.1:18443/a2a';
const HEALTH_URL = 'http://127.0.0.1:18443/health';

/** 避开全部确定性模板关键词的填充文案（不匹配 /安装/ 、/磁盘|空间|容量|占满|清理建议/ 、
 *  /系统信息|系统状态|配置|版本/ 、/截图|截屏|看看屏幕|当前屏幕/ 、productionHint∧appHint） */
const FILLER_PHRASE = 'P2T7 bounded-retention pressure probe (no capability requested)';

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}

const TOTAL = Math.max(1, Number.parseInt(arg('tasks', '240'), 10) || 240);
const BATCH = Math.max(1, Number.parseInt(arg('batch', '12'), 10) || 12);
const HEALTH_EVERY = Math.max(1, Number.parseInt(arg('health-every', '2'), 10) || 2);
const OUT = arg('out', 'C:/WinVMBridge/tools-t7/t7-fill-result.json');
const KEEP_PROBE = Math.max(1, Number.parseInt(arg('probe-ids', '8'), 10) || 8);

let rpcId = 1;
const t0 = Date.now();
const stamp = () => `${new Date().toISOString()} +${Date.now() - t0}ms`;

async function rpc(method, params, timeoutMs = 30_000) {
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
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  return {
    tasks: j.tasks ?? null,
    auditEntries: j.audit?.entries ?? null,
    chainValid: j.audit?.chainValid ?? null,
    authMode: j.security?.authMode ?? null,
    bearerSelfCheck: j.security?.bearerSelfCheck?.code ?? null,
    innerReconnect: j.security?.innerReconnect?.status ?? null,
  };
}

/** 投递一个零副作用任务（blocking:false ⇒ 立即拿到 submitted Task 句柄） */
async function sendOne(seq) {
  const message = {
    kind: 'message',
    role: 'user',
    messageId: `msg_t7_${seq}_${Date.now()}`,
    parts: [{ kind: 'text', text: `${FILLER_PHRASE} #${seq}` }],
  };
  const r = await rpc('message/send', {
    message,
    metadata: {
      traceId: `tr_t7_fill_${seq}`,
      maxRisk: 'L0',
      timeoutMs: 300_000,
      allowedCapabilities: [], // 空数组 ⇒ allowed() 恒 false ⇒ 零模板零能力执行
    },
    configuration: { blocking: false },
  });
  return {
    seq,
    id: r.result?.id ?? null,
    state: r.result?.status?.state ?? null,
    error: r.error ? { code: r.error.code, message: r.error.message } : null,
  };
}

const sent = [];
const healthSamples = [];
const probes = []; // 早期任务的归因观测（必然被溢出轮逐出）
const survivors = []; // 末期任务（应仍在场）

const h0 = await health();
healthSamples.push({ at: stamp(), phase: 'start', ...h0 });
console.log(`${stamp()} HEALTH start ${JSON.stringify(h0.tasks)}`);

let cursor = 0;
while (cursor < TOTAL) {
  const n = Math.min(BATCH, TOTAL - cursor);
  const batch = [];
  for (let i = 0; i < n; i += 1) {
    cursor += 1;
    batch.push(sendOne(cursor));
  }
  const done = await Promise.all(batch);
  for (const d of done) {
    sent.push(d);
    if (d.error) console.log(`${stamp()} SEND_ERROR seq=${d.seq} ${JSON.stringify(d.error)}`);
  }
  // 前 KEEP_PROBE 个与最后 KEEP_PROBE 个分别留作「被逐归因」与「存活」观测样本
  if (cursor <= KEEP_PROBE) probes.push(...done.map((d) => d.id).filter(Boolean));
  if (cursor > TOTAL - KEEP_PROBE) survivors.push(...done.map((d) => d.id).filter(Boolean));

  const rounds = Math.ceil(TOTAL / BATCH);
  const thisRound = Math.ceil(cursor / BATCH);
  if (thisRound % HEALTH_EVERY === 0 || thisRound === rounds) {
    const h = await health();
    healthSamples.push({ at: stamp(), phase: `after-round-${thisRound}`, sentTo: cursor, ...h });
    console.log(
      `${stamp()} ROUND ${thisRound}/${rounds} sent=${cursor} health.tasks=${JSON.stringify(h.tasks)}`,
    );
  }
  // 批间让出事件循环：驱逐只在 create() 尾部发生 ⇒ 串行投递才有干净的计数阶梯
  await new Promise((r) => setTimeout(r, 120));
}

/* ---- 归因观测：被逐 id vs 从未存在 id ---- */
const attribution = [];
for (const id of probes.slice(0, KEEP_PROBE)) {
  const r = await rpc('tasks/get', { id });
  attribution.push({
    kind: 'early-sent',
    id,
    hasResult: r.result !== undefined,
    state: r.result?.status?.state ?? null,
    errorData: r.error?.data ?? null,
    message: r.error?.message ?? null,
  });
}
const neverId = 't7-never-exists-00000000-0000-0000-0000-000000000000';
{
  const r = await rpc('tasks/get', { id: neverId });
  attribution.push({
    kind: 'never-existed',
    id: neverId,
    hasResult: false,
    errorData: r.error?.data ?? null,
    message: r.error?.message ?? null,
  });
}
for (const id of survivors.slice(-KEEP_PROBE)) {
  const r = await rpc('tasks/get', { id });
  attribution.push({
    kind: 'late-sent',
    id,
    hasResult: r.result !== undefined,
    state: r.result?.status?.state ?? null,
    errorData: r.error?.data ?? null,
  });
}

const hEnd = await health();
healthSamples.push({ at: stamp(), phase: 'end', ...hEnd });

const out = {
  meta: {
    purpose: 'P2-T7 L1 long-session eviction observation (overflow gate, default 200/1h)',
    zeroSideEffect: {
      blocking: false,
      maxRisk: 'L0',
      allowedCapabilities: [],
      note: '空 allowedCapabilities ⇒ 确定性执行器 allowed() 恒 false ⇒ 零模板零能力调用；L0 ⇒ 无审批闸触达',
    },
    total: TOTAL,
    batch: BATCH,
    startedAt: new Date(t0).toISOString(),
    elapsedMs: Date.now() - t0,
    node: process.version,
  },
  sent,
  healthSamples,
  attribution,
  summary: {
    sentOk: sent.filter((s) => s.id !== null).length,
    sendErrors: sent.filter((s) => s.error).length,
    evictedCountEnd: hEnd.tasks?.evictedCount ?? null,
    liveEnd: hEnd.tasks?.live ?? null,
    maxTasks: hEnd.tasks?.maxTasks ?? null,
    terminalTtlMs: hEnd.tasks?.terminalTtlMs ?? null,
    identityCheck: {
      // live + evicted 与投递数的差额只能由「尚未收口的在飞任务」解释 ⇒ 曲线自洽性判据
      livePlusEvicted: (hEnd.tasks?.live ?? 0) + (hEnd.tasks?.evictedCount ?? 0),
      sentOk: sent.filter((s) => s.id !== null).length,
    },
    earlyProbesEvictedAttributed: attribution
      .filter((a) => a.kind === 'early-sent')
      .filter((a) => a.errorData && a.errorData.evicted === true).length,
    neverExistedHasEvictedKey: attribution
      .filter((a) => a.kind === 'never-existed')
      .some((a) => a.errorData && 'evicted' in a.errorData),
  },
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`${stamp()} DONE -> ${OUT}`);
console.log(`${stamp()} SUMMARY ${JSON.stringify(out.summary)}`);
