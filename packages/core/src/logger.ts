/**
 * 结构化日志（traceId 贯穿，NFR-509）
 */

import type { Logger } from '@winvm/contracts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** 默认上下文字段（如 service、host） */
  readonly base?: Record<string, unknown>;
  /** 自定义输出（默认 stderr，避免污染 stdio 传输通道） */
  readonly sink?: (line: string) => void;
}

export class ConsoleLogger implements Logger {
  private readonly minLevel: number;
  private readonly base: Record<string, unknown>;
  private readonly sink: (line: string) => void;

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = LEVEL_ORDER[opts.level ?? 'info'];
    this.base = opts.base ?? {};
    this.sink = opts.sink ?? ((l) => process.stderr.write(l + '\n'));
  }

  private emit(level: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.base,
      ...(meta ?? {}),
    };
    try {
      this.sink(JSON.stringify(entry));
    } catch {
      this.sink(`${entry.ts} ${level.toUpperCase()} ${msg}`);
    }
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit('error', msg, meta);
  }

  child(base: Record<string, unknown>): ConsoleLogger {
    return new ConsoleLogger({
      level: this.levelName(),
      base: { ...this.base, ...base },
      sink: this.sink,
    });
  }

  private levelName(): LogLevel {
    if (this.minLevel <= LEVEL_ORDER.debug) return 'debug';
    if (this.minLevel <= LEVEL_ORDER.info) return 'info';
    if (this.minLevel <= LEVEL_ORDER.warn) return 'warn';
    if (this.minLevel <= LEVEL_ORDER.error) return 'error';
    return 'silent';
  }
}

/** 静默日志（测试与 provider 初始化前使用） */
export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
