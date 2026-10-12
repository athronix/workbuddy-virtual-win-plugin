/**
 * Windows 交互式会话健康监控（SECURITY-GOVERNANCE.md §5）
 *
 * 铁律：承载 GUI 的服务进程必须运行在交互式会话（WinSta0\Default，Session ≥ 1）。
 * 会话不可用时，GUI 能力必须**明确报错**，绝不静默返回黑屏截图。
 *
 * 本文件定义契约与状态机；Windows 侧的真实探针实现位于
 * `packages/vm-capabilities`（通过 PowerShell 采集）。
 */

import type { SessionHealth, SessionState } from '@winvm/contracts';

export interface SessionProbe {
  probe(): Promise<SessionHealth>;
}

/**
 * 非 Windows / 探针未接入时的兜底：会话不可用。
 *
 * P2-T9（E-2）：本类是「被迫填假值」制造点之一 —— 兜底里的 `interactive:false` 并非观测值，
 * 而是「本次未能得出结论」的 fail-closed 填充。故追加 `probeError`/`probeErrorCode`
 * （码 `PROBE_NOT_WIRED`）把「探测失败」与「探测成功且确非交互」区分开。
 * 既有七字段值**逐字不变**（含 detail 原文案），两新键纯附加。
 */
export class UnavailableSessionProbe implements SessionProbe {
  constructor(private readonly detail = '会话探针未接入（非 Windows 环境或未初始化）') {}
  async probe(): Promise<SessionHealth> {
    return {
      sessionId: 0,
      windowStation: '',
      desktop: '',
      interactive: false,
      locked: false,
      blackScreen: false,
      state: 'unavailable',
      detail: this.detail,
      // P2-T9（E-2 · 纯附加）：探针未能得出结论的稳定事实 + 机读码
      probeError: this.detail,
      probeErrorCode: 'PROBE_NOT_WIRED',
    };
  }
}

export interface SessionMonitorOptions {
  readonly intervalMs?: number;
  readonly probe: SessionProbe;
  readonly onChange?: (next: SessionHealth, prev: SessionHealth | undefined) => void;
}

/**
 * 会话状态对应的可用能力语义（§5.5 降级矩阵）。
 *
 * **P2-T9（E-2）判据注释 —— 本函数判据行一字未改（PR8 红线）**：
 *  `probeError` 在场时本判据恒 false，靠的是三重冗余而非新增分支：
 *  1. 三处假值制造点（PROBE_TIMEOUT / PROBE_EXCEPTION / PROBE_NOT_WIRED）的 `state`
 *     都落非 `'healthy'` ⇒ 合取首项即短路拒绝；
 *  2. 同三处的 `interactive` 恒为保守 `false` ⇒ 即使未来有人误改某条失败路径的 `state`，
 *     第二项仍兜底；
 *  3. 本判据**不读** `probeError` ⇒ 该字段在场与否都不可能被用来放行（无从放宽）。
 *
 * 因此 E-2 只是将「为何被拒」的原因显形（探测失败 vs 确非交互），**不改变任何放行结论**。
 * `probeError` 的用途是运维定位（该查探测通路还是查会话配置），不是门禁输入。
 */
export function guiAllowed(session: SessionHealth): boolean {
  return session.state === 'healthy' && session.interactive && !session.blackScreen;
}

export function nonGuiAllowed(session: SessionHealth): boolean {
  return session.state !== 'unavailable';
}

export function describeSessionState(state: SessionState): string {
  switch (state) {
    case 'healthy':
      return '会话健康，GUI 能力可用';
    case 'degraded':
      return '会话降级（锁屏/Explorer 未运行/窗口站异常），GUI 能力不可用';
    case 'black-screen':
      return '检出黑屏：控制进程很可能运行在 Session 0 或会话已被挂起';
    case 'unavailable':
      return '无交互式会话（服务可能以系统服务方式运行，或未登录）';
  }
}

/**
 * 周期性会话健康监控。
 * 检出异常时通过 onChange 回调通知上层置 degraded 并告警。
 */
export class SessionMonitor {
  private readonly probe: SessionProbe;
  private readonly intervalMs: number;
  private readonly onChange?: (next: SessionHealth, prev: SessionHealth | undefined) => void;

  private timer: NodeJS.Timeout | undefined;
  private last: SessionHealth | undefined;
  private probing = false;

  constructor(opts: SessionMonitorOptions) {
    this.probe = opts.probe;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.onChange = opts.onChange;
  }

  async probeOnce(): Promise<SessionHealth> {
    if (this.probing) return this.last ?? (await this.probe.probe());
    this.probing = true;
    try {
      const next = await this.probe.probe();
      const prev = this.last;
      const changed =
        prev === undefined ||
        prev.state !== next.state ||
        prev.blackScreen !== next.blackScreen ||
        prev.locked !== next.locked ||
        prev.interactive !== next.interactive;
      this.last = next;
      if (changed) this.onChange?.(next, prev);
      return next;
    } finally {
      this.probing = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.probeOnce();
    this.timer = setInterval(() => {
      void this.probeOnce().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  current(): SessionHealth | undefined {
    return this.last;
  }
}
