/**
 * /health 会话子探针的独立短超时护栏（QA 遗留 P2）
 *
 * 背景：server.ts 的 buildHealth 同步 await 会话探针（PsBridgeSessionProbe →
 * bridge.call('gui','Get-SessionHealth')）。ps-bridge 未就绪时，bridge.call 入口先走
 * lazy 自愈（spawn powershell + ready 握手，最长受 WINVM_PSBRIDGE_READY_TIMEOUT_MS 支配），
 * 单个 /health 请求实测可阻塞 ~27s —— 监控场景不可接受。
 *
 * 方案：给该子探针加**独立短超时**（默认 5000ms，env WINVM_HEALTH_PROBE_TIMEOUT_MS 可覆盖，
 * env-gate 写法对齐 ps-bridge.ts 的 WINVM_PSBRIDGE_READY_TIMEOUT_MS）。超时**不是失败**：
 *  - /health 仍返回（ok 按既有公式计算，桥进程 ready 时依旧 ok:true）；
 *  - psBridge.state 给出可辨识降级值 'timeout'（桥进程活着但子探针在时限内未应答）；
 *  - session.state='unavailable'（契约 SessionState 无 'unknown'，'unavailable' 语义即
 *    「本次未取得结论」），detail 记录超时事实。
 *
 * GUI 门禁语义**不变**：guiAllowed 要求 state==='healthy' 且 interactive 且非黑屏，
 * 超时回退态天然不可用 —— 只是消除了长阻塞，绝不放宽 GUI 能力判定。
 */

import type { HealthStatus, SessionHealth } from '@winvm/contracts';

/** /health 会话子探针的独立短超时（env WINVM_HEALTH_PROBE_TIMEOUT_MS 可覆盖） */
export function resolveHealthProbeTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env['WINVM_HEALTH_PROBE_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return 5_000;
  const n = Number(raw);
  // 非法值（NaN / ≤0）回退默认：0 会造成「立即超时」歧义，负值无意义
  return Number.isFinite(n) && n > 0 ? n : 5_000;
}

/**
 * psBridge.state 映射（/health 顶层）：
 *  - 桥进程未运行（'down'）→ 'unavailable'（既有语义不变）；
 *  - 桥进程 ready 且子探针按时应答 → 'ready'；
 *  - 桥进程 ready 但子探针在短超时内未应答 → 'degraded'（契约 ProviderState 内的可辨识
 *    降级值；配合扩展字段 psBridge.probe='timeout' 可与其它降级原因区分 —— 见 server.ts。
 *    不直接扩 'timeout' 字面量进 ProviderState：那会改动跨包契约并在 ServiceRuntime.health
 *    的 Promise<HealthStatus> 赋值处产生类型破裂）。
 */
export function resolvePsBridgeHealthState(
  bridgeState: 'ready' | 'down',
  probeTimedOut: boolean,
): 'ready' | 'degraded' | 'unavailable' {
  if (bridgeState === 'down') return 'unavailable';
  return probeTimedOut ? 'degraded' : 'ready';
}

/**
 * 超时/失败回退的会话观测项：state='unavailable'（结论未知，绝不猜测为健康）。
 *
 * P2-T9（E-2）：本函数是「被迫填假值」制造点之二 —— 追加 `probeError`/`probeErrorCode`
 * （码 `PROBE_TIMEOUT`）使「探测超时未得出结论」与「探测成功且确非交互」可区分。
 * 既有八键值**逐字不变**（含 detail 原文案），两新键纯附加，fail-closed 方向零变化。
 */
export function timeoutSessionSnapshot(timeoutMs: number): SessionHealth {
  return {
    sessionId: 0,
    windowStation: '',
    desktop: '',
    interactive: false,
    locked: false,
    blackScreen: false,
    state: 'unavailable',
    detail: `会话子探针在 ${timeoutMs}ms 内未返回（WINVM_HEALTH_PROBE_TIMEOUT_MS 可调）：ps-bridge 可能未就绪，本次结论未知`,
    // P2-T9（E-2 · 纯附加）：探测失败事实 + 机读码（与 detail 同源文案，语义独立信号）
    probeError: `会话子探针在 ${timeoutMs}ms 内未返回，本次未取得结论`,
    probeErrorCode: 'PROBE_TIMEOUT',
  };
}

export interface SessionProbeOutcome {
  readonly session: SessionHealth;
  /** true = 探针在时限内未返回（结果未知，绝非「会话不健康」的强断言） */
  readonly timedOut: boolean;
}

/**
 * 通用短超时 race helper（race 而非 abort，/health 全部子探针共用这一套实现，
 * 不重复造两套）。/health 的任何 await 都不允许无界阻塞 —— 新子探针一律走本 helper。
 *
 * 关键语义：
 *  - 任务按时 resolve → 原样透传（timedOut=false）；
 *  - 任务在时限内未返回 → 返回调用方给定的降级 fallback（timedOut=true），**不抛错** ——
 *    /health 必须尽快给出降级快照而非 5xx；
 *  - 任务自身 reject → 同样回退 fallback（timedOut=false）：race 创建时已挂上拒绝处理器，
 *    不会产生 unhandled rejection；
 *  - 底层 Promise **不被中断**（race 而非 abort）：慢操作继续在后台完成/自愈，
 *    下一次 /health 通常即可拿到真实结果（探针本身兼作桥的预热）；
 *  - timer unref，不阻碍服务进程自然退出。
 */
export interface RaceOutcome<T> {
  readonly value: T;
  /** true = 任务在时限内未返回（结果未知，绝非「不健康」的强断言） */
  readonly timedOut: boolean;
}

export async function raceWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<RaceOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<'__timeout__'>((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
    timer.unref?.();
  });
  try {
    // 任务的 resolve/reject 都在此处被消费（even if timeout wins），不会产生 unhandled rejection
    const winner = await Promise.race([
      task.then(
        (v) => ({ ok: true as const, v }),
        () => ({ ok: false as const }),
      ),
      timeoutP,
    ]);
    if (winner === '__timeout__') return { value: fallback, timedOut: true };
    return { value: winner.ok ? winner.v : fallback, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给会话探针加独立短超时（race 而非 abort，基于通用 raceWithTimeout 实现）。
 *
 * 关键语义：
 *  - 超时返回回退快照、**不抛错** —— /health 必须尽快给出降级快照而非 5xx；
 *  - 底层探针 Promise **不被中断**：ps-bridge 的 lazy 自愈继续在后台进行，
 *    下一次 /health 通常即可拿到真实结果（探针本身兼作桥的预热）；
 *  - 探针自身 reject（未运行且自愈失败等）同样回退 unavailable 快照，但不标 timedOut
 *    （此时 bridge.health().state 一般已是 'down' → psBridge.state='unavailable'，语义自洽）；
 *  - timer unref，不阻碍服务进程自然退出。
 */
export async function raceSessionProbe(
  probe: () => Promise<SessionHealth>,
  timeoutMs: number,
): Promise<SessionProbeOutcome> {
  const out = await raceWithTimeout(probe(), timeoutMs, timeoutSessionSnapshot(timeoutMs));
  return { session: out.value, timedOut: out.timedOut };
}

/**
 * provider.health() 超时/失败回退快照（/health 顶层 provider 字段的可辨识降级形态）。
 *
 * 契约不破坏：buildHealth 的 ok 由桥进程状态独立计算（桥 ready 时仍 ok:true），既有字段
 * 不缺失；本快照仅把 provider.state 标为 'degraded'（ProviderState 既有降级值，与
 * adapter 自身 degraded 语义同构），并以 detail 记录超时事实。
 */
export function providerHealthTimeoutSnapshot(providerId: string, timeoutMs: number): HealthStatus {
  return {
    ok: false,
    provider: {
      id: providerId,
      state: 'degraded',
      detail: `provider.health() 在 ${timeoutMs}ms 内未返回（WINVM_HEALTH_PROBE_TIMEOUT_MS 可调）：本次结论未知，已降级呈现`,
    },
    session: timeoutSessionSnapshot(timeoutMs),
  };
}

export interface HealthSubProbesOutcome {
  readonly session: SessionHealth;
  /** true = 会话子探针在时限内未返回 */
  readonly sessionTimedOut: boolean;
  /** undefined = 服务无 provider（非 workbuddy 场景），保持既有「provider 未加载」兜底行为 */
  readonly providerHealth: HealthStatus | undefined;
  /** true = provider.health() 在时限内未返回 */
  readonly providerTimedOut: boolean;
}

/**
 * /health 两路子探针的**并发**短超时编排（P2 第二段：provider.health() 纳入护栏）。
 *
 * 背景：provider.health()（workbuddy adapter：health → sessionHealth →
 * bridge.call('gui','Get-SessionHealth', {}, 20_000)）内部会再同步跑一次 20s 级会话探针。
 * 若在会话子探针之后**顺序** await，即使各自有 5s 短超时也会 5s+5s 叠加 ——
 * QA 实测 kill ps-bridge 后 /health 总时延仍 10.4–12.5s（> 8s 目标）。
 * 故两路并发 race，总时延收敛到 max(单路超时) ≈ 5s 级。
 */
export async function raceHealthSubProbes(args: {
  sessionProbe: () => Promise<SessionHealth>;
  /** undefined = 服务无 provider，保持既有「provider 未加载」行为（不做 race） */
  providerHealth: (() => Promise<HealthStatus>) | undefined;
  /** 降级快照里的 provider.id（优先用真实 provider.id，回退配置名） */
  providerId: string;
  timeoutMs: number;
}): Promise<HealthSubProbesOutcome> {
  const [sessionOut, providerOut] = await Promise.all([
    raceSessionProbe(args.sessionProbe, args.timeoutMs),
    args.providerHealth
      ? raceWithTimeout(
          args.providerHealth(),
          args.timeoutMs,
          providerHealthTimeoutSnapshot(args.providerId, args.timeoutMs),
        )
      : Promise.resolve<RaceOutcome<HealthStatus | undefined>>({ value: undefined, timedOut: false }),
  ]);
  return {
    session: sessionOut.session,
    sessionTimedOut: sessionOut.timedOut,
    providerHealth: providerOut.value,
    providerTimedOut: providerOut.timedOut,
  };
}
