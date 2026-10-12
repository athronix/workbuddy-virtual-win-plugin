#!/usr/bin/env node
/**
 * lock-probe —— 真机窗口**前置**探针（Phase 2 · P2-T11 / 设计 §3.4 E-3、§308 P2-T11 行「部分（锁屏探针需真机）」）
 *
 * ## 为什么存在
 * 设计 §3.4 的原话口径是「**F3 不承诺"解决锁屏"，只承诺"不再浪费档期"**」。真实 GUI 端到端
 * 回归受 VM 会话锁屏限制（MEMORY 关键坑段给出成因：`LogonTrigger` 有会话 ⇒ GUI 可用；
 * `BootTrigger` 无会话 ⇒ 不可用；`ps-bridge` 由计划任务托管）。Phase 1 §5 的经验是
 * 「见到红必须先分诊」——而**能在开工前判 BLOCKED 就别浪费档期**。本探针把这件事变成一条命令。
 *
 * ## 判据（与 `core/session/health.ts` 的 `guiAllowed` 逐字同判据）
 *   `state === 'healthy' && interactive === true && blackScreen === false` ⇒ GO
 * 额外把契约里的 `locked`（P2-T9 已透出的既有字段）**单独报出**：`locked === true`
 * 在服务侧会让 `state` 落到 `degraded`，故 GO 判据已覆盖它；单列的目的是让运维一眼看到
 * 「到底是锁屏、还是黑屏、还是压根没会话」——这三种停手原因的处置动作不同。
 *
 * 探测未能得出结论时（P2-T9 的 `probeError` 在场）⇒ 本探针判 **UNKNOWN**：
 * 服务其余布尔字段是 fail-closed 兜底值而**不是观测值**，把它当「GUI 不可用」直接开工
 * 或者当「可用」硬开工都是错的 ⇒ 独立退出码 3，让调用方（人）决定，不假装判定。
 *
 * ## 只读铁律（任务书交付面 7：「不得动 VM 侧文件/服务」）
 * 唯一动作 = 对既有 `/health` 端点发一次 GET。零 POST、零写、零重启、零配置改动、
 * 不 import 任何被测包（PR9 同源纪律，亦避开本仓 junction 假红坑）。
 *
 * ## 用法
 *   node scripts/lock-probe.mjs                      # 默认 http://127.0.0.1:18443/health
 *   node scripts/lock-probe.mjs --base-url <url>      # 换端点（如 VM 侧直连）
 *   node scripts/lock-probe.mjs --token-env NAME      # 需要 bearer 时**只传变量名**（K-17：凭据不落明文）
 *   node scripts/lock-probe.mjs --json                # 机读输出
 *   node scripts/lock-probe.mjs --timeout 8000
 *
 * ## 退出码
 *   0 = GO（GUI 端到端可开工）
 *   1 = BLOCKED（会话非交互/锁屏/黑屏 ⇒ **本轮 GUI 端到端标 BLOCKED 并停手**，这不是代码红）
 *   2 = 探测失败（隧道/服务不可达 ⇒ 按任务书「黑洞⇒回报主理人，不自启」，本脚本绝不尝试拉起服务）
 *   3 = UNKNOWN（`probeError` 在场，服务侧未能得出结论 ⇒ 交人裁断）
 */

import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:18443';
const DEFAULT_TIMEOUT_MS = 8000;

/** 探针结论枚举（回报与 GATE-POLICY.md 引用同一串）。 */
export const VERDICT = /** @type {const} */ ({
  GO: 'GO',
  BLOCKED: 'BLOCKED',
  UNKNOWN: 'UNKNOWN',
  UNREACHABLE: 'UNREACHABLE',
});

/**
 * 纯函数：由 `/health` 响应体得出会话可用性前置判定（无 I/O ⇒ 单测可直接喂假 JSON）。
 * @param {any} health 解析后的 /health JSON
 * @returns {{verdict:string, code:number, reasons:string[], session:Record<string,unknown>|null}}
 */
export function judgeSessionHealth(health) {
  const session = health && typeof health === 'object' ? health.session : null;
  if (!session || typeof session !== 'object') {
    return {
      verdict: VERDICT.UNKNOWN,
      code: 3,
      reasons: ['响应体缺 session 字段（契约 `HealthStatus.session` 为必填 ⇒ 响应形状不符，不猜）'],
      session: null,
    };
  }
  const /** @type {string[]} */
    reasons = [];
  const state = String(session.state || '');
  const interactive = session.interactive === true;
  const blackScreen = session.blackScreen === true;
  const locked = session.locked === true;

  // P2-T9 的未知态优先：兜底布尔值不是观测值 ⇒ 不得据此判 GO，也不得据此判「GUI 坏了」。
  if (session.probeError !== undefined && session.probeError !== null) {
    return {
      verdict: VERDICT.UNKNOWN,
      code: 3,
      reasons: [
        `探针未能得出结论：probeError=${String(session.probeError)}${session.probeErrorCode ? ` (${String(session.probeErrorCode)})` : ''}`,
        `其余布尔字段（interactive=${String(session.interactive)} / locked=${String(session.locked)} / blackScreen=${String(session.blackScreen)}）是 fail-closed 兜底值而**不是观测值** ⇒ 交人裁断，不自动判 GO/BLOCKED`,
      ],
      session,
    };
  }

  // guiAllowed 同判据（core/session/health.ts:6-8）
  if (state === 'healthy' && interactive && !blackScreen) {
    return { verdict: VERDICT.GO, code: 0, reasons: [`guiAllowed 判据成立（state=healthy ∧ interactive ∧ !blackScreen）${locked ? '；⚠ locked=true 与 state=healthy 并存，请核对探针口径' : ''}`], session };
  }
  if (locked) reasons.push('locked=true（VM 会话锁屏 ⇒ GUI 能力在策略层被拒）');
  if (blackScreen) reasons.push('blackScreen=true（控制进程很可能运行在 Session 0 或会话被挂起）');
  if (!interactive) reasons.push('interactive=false（无交互式窗口站会话）');
  if (state !== 'healthy') reasons.push(`state=${state || '<空>'}（非 healthy）`);
  return {
    verdict: VERDICT.BLOCKED,
    code: 1,
    reasons: reasons.length ? reasons : ['guiAllowed 判据不成立'],
    session,
  };
}

/**
 * 只读 GET 一个 JSON 端点。零副作用；超时上界由参数控制（对齐 PR3「探针有超时上界」纪律）。
 * @param {string} baseUrl
 * @param {{token?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, status:number, body:any, error?:string}>}
 */
export async function fetchJson(baseUrl, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  return await new Promise((resolve) => {
    /** @type {URL} */
    let url;
    try {
      url = new URL('/health', baseUrl);
    } catch (e) {
      resolve({ ok: false, status: 0, body: null, error: `base-url 无法解析：${String(e && e.message)}` });
      return;
    }
    const transport = url.protocol === 'https:' ? httpsRequest : request;
    /** @type {Record<string,string>} */
    const headers = { accept: 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let settled = false;
    const finish = (/** @type {any} */ r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = transport(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        /** @type {any} */
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          finish({ ok: false, status, body: null, error: `响应非 JSON（长度 ${raw.length}，前 120 字符：${raw.slice(0, 120)}）` });
          return;
        }
        finish({ ok: status >= 200 && status < 300, status, body });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, status: 0, body: null, error: `超时 ${timeoutMs}ms（隧道黑洞/服务未起 ⇒ 按纪律回报主理人，**本探针不自启服务**）` });
    });
    req.on('error', (err) => {
      finish({ ok: false, status: 0, body: null, error: `${err.name}: ${err.message}` });
    });
    req.end();
  });
}

/**
 * 一次完整前置探测（fetch + 判定）。
 * @param {{baseUrl?:string, token?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{verdict:string, code:number, reasons:string[], session:Record<string,unknown>|null, http:Record<string,unknown>}>}
 */
export async function probeLockStatus(opts = {}) {
  const baseUrl = opts.baseUrl || (process.env.WINVM_HEALTH_BASE || DEFAULT_BASE_URL);
  const res = await fetchJson(baseUrl, { token: opts.token, timeoutMs: opts.timeoutMs });
  if (!res.ok) {
    return {
      verdict: VERDICT.UNREACHABLE,
      code: 2,
      reasons: [`GET ${baseUrl}/health 失败（status=${res.status}）：${res.error || '未知错误'}`],
      session: null,
      http: { baseUrl, status: res.status, error: res.error || null },
    };
  }
  const j = judgeSessionHealth(res.body);
  return { ...j, http: { baseUrl, status: res.status } };
}

/** CLI 入口。 */
async function cli() {
  const argv = process.argv.slice(2);
  /** @type {Record<string,string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--') && !a.includes('=')) {
      const key = a.slice(2);
      if (key === 'json' || key === 'help') {
        args[key] = 'true';
        continue;
      }
      args[key] = argv[i + 1] || '';
      i += 1;
    } else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      args[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/lock-probe.mjs [--base-url URL] [--token-env NAME] [--timeout MS] [--json]\n' +
        '  真机 GUI 窗口开工前的**只读**会话前置判定（零 VM 侧写）。\n' +
        '  exit 0=GO 1=BLOCKED(锁屏/黑屏/非交互 ⇒ 标 BLOCKED 停手) 2=UNREACHABLE(隧道黑洞,不自启) 3=UNKNOWN(probeError 在场,交人裁断)\n',
    );
    return;
  }
  // K-17：命令行只承载**变量名**，token 值从环境取，绝不落明文参数。
  const token = args['token-env'] ? process.env[args['token-env']] : undefined;
  const out = await probeLockStatus({
    baseUrl: args['base-url'],
    token: token || undefined,
    timeoutMs: args.timeout ? Number(args.timeout) : undefined,
  });
  const s = out.session || {};
  if (args.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(`lock-probe · ${out.http.baseUrl}/health（只读前置探针）\n`);
    if (Object.keys(s).length > 0) {
      process.stdout.write(
        `  session: state=${String(s.state ?? '-')} interactive=${String(s.interactive ?? '-')} ` +
          `locked=${String(s.locked ?? '-')} blackScreen=${String(s.blackScreen ?? '-')} ` +
          `sessionId=${String(s.sessionId ?? '-')}${s.probeError ? ` probeError=${String(s.probeError)}` : ''}\n`,
      );
    }
    for (const r of out.reasons) process.stdout.write(`  · ${r}\n`);
    process.stdout.write(`VERDICT: ${out.verdict}\n`);
    if (out.code === 1) {
      process.stdout.write('  ⇒ 本轮 GUI 端到端标记 **BLOCKED** 并停手（设计 §3.4：能提前判 BLOCKED 就别浪费档期）。这不是代码红，勿去改测试。\n');
    }
    if (out.code === 2) {
      process.stdout.write('  ⇒ 隧道/服务不可达：按纪律**回报主理人，不自启 daemon**。\n');
    }
    if (out.code === 3) {
      process.stdout.write('  ⇒ 探测面未知态：服务侧兜底值不可用作结论，需人工核对探测通路。\n');
    }
  }
  process.exitCode = out.code;
}

/**
 * 是否作为脚本被**直接执行**（被单测 import 时不跑 CLI）。
 * ⚠ 两侧都过 realpath 再比：本仓 node_modules/@winvm/* 是 junction，且 spawn 方传入的
 *   argv[1] 与 import.meta.url 可能带不同挂载别名（/storage/... vs 真路径）⇒ 裸字符串相等会假不成立。
 *   realpath 抛错（鸿蒙 getcwd 偶发异常）⇒ 退化为原路径比较。
 * @returns {boolean}
 */
function isDirectRun() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  const safe = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return safe(fileURLToPath(import.meta.url)) === safe(resolve(argvPath));
}

if (isDirectRun()) {
  await cli();
}
