/**
 * 结构化日志（traceId 贯穿，NFR-509）+ CL-018 C3 脱敏/字段裁剪能力。
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

/**
 * 凭据键名集合（与 host-a2a-bridge 的呈现脱敏同源语义）。
 * 命中后其值一律替换为 `***REDACTED***`。
 */
const CRED_KEY =
  '(?:authorization|proxy-authorization|token|access[_-]?token|refresh[_-]?token|id[_-]?token|' +
  'bearer|secret|client[_-]?secret|password|passwd|pwd|api[_-]?key|apikey|private[_-]?key|' +
  'credential|credentials|signature|session[_-]?key|cookie|set-cookie)';

const CRED_KEY_VALUE_RE = new RegExp(
  `("?(?:${CRED_KEY})"?\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s,;}]+))`,
  'gi',
);
const BEARER_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}\b/g;
/** 无命名的高熵长串（≥40 字符）—— 兜底防「裸 token 直接落在 message 里」 */
const LONG_OPAQUE_RE = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;

export const REDACTED = '***REDACTED***';

/**
 * 日志行脱敏（AC3.6 硬要求）。
 *
 * 三层防御：
 *   ① 具名凭据键（`token`/`password`/`authorization`…）的值 → 掩码；
 *   ② `Bearer <cred>` / JWT 形态 → 掩码；
 *   ③ 无命名的高熵长串（≥40 且含字母+数字）→ 掩码。
 *
 * 注意：这是**纵深防御**，不是唯一防线 —— 真正的第一道防线是 `metaAllowlist`
 * 字段裁剪（`params` 等原始载荷根本不进日志）。
 */
export function redactSecrets(line: string): string {
  let out = line;
  // 顺序敏感：先处理 `Bearer/Basic <cred>` 与 JWT —— 否则具名键规则只会吃掉 `Bearer`
  // 这个词本身，把真正的凭据留在行里（实测踩过）。
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(CRED_KEY_VALUE_RE, (_m, head: string) => `${head}"${REDACTED}"`);
  out = out.replace(LONG_OPAQUE_RE, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? REDACTED : m));
  return out;
}

/**
 * 文件日志的**字段白名单**（CL-018 C3 · 白名单式裁剪）。
 *
 * 设计取舍：白名单（只记已知安全字段）比黑名单（排除已知敏感字段）更保守 ——
 * 任何**未登记**的字段（尤其 `params` / `value` / `headers`）都不会落盘，
 * 从根上避免「新代码顺手把请求原文塞进 meta」造成凭据外泄。
 */
export const DEFAULT_LOG_META_ALLOWLIST: readonly string[] = [
  'traceId',
  'capabilityId',
  'ok',
  'durationMs',
  'error',
  'provider',
  'providerId',
  'session',
  'state',
  'from',
  'to',
  'detail',
  'count',
  'degraded',
  'host',
  'port',
  'exposed',
  'path',
  'method',
  'status',
  'level',
  'msg',
  'ts',
  'service',
  'id',
  'kind',
  'phase',
  'dir',
  'file',
  'files',
  'bytes',
  'module',
  'function',
  'action',
  'restarts',
  'reason',
  'risk',
  'approved',
  'pending',
  'timedOut',
  'summary',
  'note',
  'retry',
  'attempt',
  'name',
  'probe',
  'lastError',
  'cached',
  'ageMs',
  'ttlMs',
  'removed',
  'kept',
];

/** 按白名单裁剪对象字段（未登记键整体丢弃，绝不落盘） */
export function filterMetaByAllowlist(
  meta: Record<string, unknown>,
  allowlist: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(allowlist);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** 默认上下文字段（如 service、host） */
  readonly base?: Record<string, unknown>;
  /** 自定义输出（默认 stderr，避免污染 stdio 传输通道） */
  readonly sink?: (line: string) => void;
  /** CL-018 C3：meta 字段白名单（设置后未登记键被丢弃；未设置则不过滤） */
  readonly metaAllowlist?: readonly string[];
  /** CL-018 C3：是否对输出行做凭据脱敏（默认 **true**，安全优先） */
  readonly redact?: boolean;
}

export class ConsoleLogger implements Logger {
  private readonly minLevel: number;
  private readonly base: Record<string, unknown>;
  private readonly sink: (line: string) => void;
  private readonly metaAllowlist: readonly string[] | undefined;
  private readonly redact: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = LEVEL_ORDER[opts.level ?? 'info'];
    this.base = opts.base ?? {};
    this.sink = opts.sink ?? ((l) => process.stderr.write(l + '\n'));
    this.metaAllowlist = opts.metaAllowlist;
    this.redact = opts.redact ?? true;
  }

  private emit(level: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const merged: Record<string, unknown> = { ...this.base, ...(meta ?? {}) };
    const payload = this.metaAllowlist ? filterMetaByAllowlist(merged, this.metaAllowlist) : merged;
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...payload };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = `${entry['ts']} ${level.toUpperCase()} ${msg}`;
    }
    try {
      this.sink(this.redact ? redactSecrets(line) : line);
    } catch {
      // 输出本身失败绝不能拖垮调用方（如日志目录/管道异常）
      try {
        this.sink(`${entry['ts']} ${level.toUpperCase()} ${msg}`);
      } catch {
        /* 静默：日志失败不得影响业务 */
      }
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
      ...(this.metaAllowlist ? { metaAllowlist: this.metaAllowlist } : {}),
      redact: this.redact,
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
