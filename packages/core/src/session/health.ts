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

/** 非 Windows / 探针未接入时的兜底：会话不可用 */
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
    };
  }
}

export interface SessionMonitorOptions {
  readonly intervalMs?: number;
  readonly probe: SessionProbe;
  readonly onChange?: (next: SessionHealth, prev: SessionHealth | undefined) => void;
}

/** 会话状态对应的可用能力语义（§5.5 降级矩阵） */
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
