/**
 * CL-018 C3 · 服务日志落盘（轮转 + 保留 + 失败降级 + 脱敏）
 *
 * 背景（CL-017 D19）：服务由 `start-hidden-vm.ps1 -WindowStyle Hidden` 拉起，`ConsoleLogger`
 * 写 stderr 被系统丢弃 → 委派停滞 / 隧道半死 / 重生风暴 / 部署漂移全都**事后不可诊断**。
 *
 * 设计约束（逐条对应验收）：
 *   - AC3.1 路径 `%LOCALAPPDATA%\WinVMBridge\logs\winvm-service-YYYY-MM-DD.log`
 *   - AC3.3 单文件 10MB / 按天 / 保留 7 文件 / 14 天（全部可配）
 *   - AC3.5 **目录不可写绝不阻断服务启动**：构造失败即降级，`/health.logging.degraded=true`
 *   - AC3.6 脱敏：白名单字段裁剪（`DEFAULT_LOG_META_ALLOWLIST`）+ 双层正则掩码（`redactSecrets`）
 *
 * 实现取舍：不引入第三方轮转库（避免供应链成本）；写入走**内存缓冲 + 定时/阈值刷盘**，
 * 避免热路径上每条日志一次同步 IO（本 VM 磁盘/CPU 受限）。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ConsoleLogger, DEFAULT_LOG_META_ALLOWLIST, type LogLevel } from './logger.js';
import { LOG_FILE_PREFIX, type LoggingConfig } from './constants.js';

export interface RotatingFileSinkOptions {
  /** 日志目录（调用方应已展开 %ENV% 并绝对化） */
  readonly dir: string;
  /** 文件前缀（默认 `winvm-service`） */
  readonly filePrefix?: string;
  /** 单文件上限字节（默认 10MB） */
  readonly maxBytes?: number;
  /** 最多保留文件数（默认 7） */
  readonly maxFiles?: number;
  /** 最多保留天数（默认 14） */
  readonly maxDays?: number;
  /** 注入用：时间源（测试可控轮转/保留判定） */
  readonly now?: () => Date;
  /** 刷盘阈值（缓冲行数，默认 16） */
  readonly flushThreshold?: number;
  /** 定时刷盘间隔（毫秒，默认 1000；≤0 表示不装定时器） */
  readonly flushIntervalMs?: number;
}

/** `/health.logging` 的 sink 侧视图 */
export interface LoggingStatus {
  readonly degraded: boolean;
  readonly dir: string;
  readonly reason?: string;
  /** 当前写入的文件名（降级时为 undefined） */
  readonly currentFile?: string;
}

const DEFAULT_FLUSH_THRESHOLD = 16;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/** 本地日期 → `YYYY-MM-DD`（日志文件名用本地时间，与「按天切」语义一致） */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 带轮转/保留的文件 sink。
 *
 * 线程/进程安全说明：本服务为**单进程**（vm-service），故无需跨进程文件锁；
 * 轮转采用「先改名再写新文件」的顺序，最坏情况下（rename 失败）退化为继续写原文件。
 */
export class RotatingFileSink {
  private readonly dir: string;
  private readonly prefix: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxDays: number;
  private readonly now: () => Date;
  private readonly flushThreshold: number;

  private buffer: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private degraded = false;
  private reason: string | undefined;
  private currentFile: string | undefined;
  /** 上次保留清理时间（避免每次 flush 都 readdir） */
  private lastPruneMs = 0;

  constructor(opts: RotatingFileSinkOptions) {
    this.dir = opts.dir;
    this.prefix = opts.filePrefix ?? LOG_FILE_PREFIX;
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 7;
    this.maxDays = opts.maxDays && opts.maxDays > 0 ? opts.maxDays : 14;
    this.now = opts.now ?? (() => new Date());
    this.flushThreshold = opts.flushThreshold && opts.flushThreshold > 0 ? opts.flushThreshold : DEFAULT_FLUSH_THRESHOLD;

    // AC3.5：目录创建 / 可写性探测失败 → 降级，**绝不抛错**（服务必须仍能启动）
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      this.probeWritable();
      this.currentFile = this.pathFor(this.now());
      // 启动即做一次保留清理（AC3.3：超限旧文件自动清理）
      this.prune();
    } catch (e) {
      this.degraded = true;
      this.reason = `日志目录不可写（${this.dir}）：${(e as Error).message}`;
      return;
    }

    const intervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.flush(), intervalMs);
      // 不得因日志定时器阻碍进程自然退出
      this.timer.unref?.();
    }
  }

  /** 可写性探测：真实写一个探针文件再删除（比 `access()` 更能暴露只读/满盘） */
  private probeWritable(): void {
    const probe = join(this.dir, `.winvm-write-probe-${process.pid}.tmp`);
    try {
      appendFileSync(probe, '');
    } finally {
      try {
        if (existsSync(probe)) rmSync(probe, { force: true });
      } catch {
        /* 探针残留无害 */
      }
    }
  }

  private nameFor(d: Date): string {
    return `${this.prefix}-${localDate(d)}.log`;
  }

  private pathFor(d: Date): string {
    return join(this.dir, this.nameFor(d));
  }

  /** 写入一行（已序列化的 JSON 文本） */
  write(line: string): void {
    if (this.degraded || this.closed) return;
    this.buffer.push(line);
    if (this.buffer.length >= this.flushThreshold) this.flush();
  }

  /** 刷盘（同步 append；失败即降级，不抛错） */
  flush(): void {
    if (this.degraded || this.closed || this.buffer.length === 0) return;
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer = [];
    try {
      const today = this.pathFor(this.now());
      // 跨天：文件名天然切换 → 顺手做一次保留清理（AC3.3）
      if (this.currentFile && this.currentFile !== today) this.prune();
      this.currentFile = today;
      this.rotateIfNeeded();
      appendFileSync(today, chunk);
      this.maybePrune();
    } catch (e) {
      this.degraded = true;
      this.reason = `日志写入失败：${(e as Error).message}`;
      // 已丢弃的缓冲无法恢复；降级事实经 status() 暴露（调用方另有 stderr 镜像）
    }
  }

  /** 超限则轮转：当日文件改名为 `<prefix>-<date>.<n>.log` */
  rotateIfNeeded(): void {
    if (this.degraded) return;
    const target = this.pathFor(this.now());
    try {
      if (!existsSync(target)) return;
      const size = statSync(target).size;
      if (size < this.maxBytes) return;
      let n = 1;
      while (n < 10_000) {
        const cand = join(this.dir, `${this.prefix}-${localDate(this.now())}.${n}.log`);
        if (!existsSync(cand)) {
          renameSync(target, cand);
          break;
        }
        n++;
      }
    } catch {
      // 轮转失败不致命：退化为继续写原文件（下次 flush 再试）
      return;
    }
    this.prune();
  }

  /** 节流的保留清理（每 60s 最多一次） */
  private maybePrune(): void {
    const nowMs = this.now().getTime();
    if (nowMs - this.lastPruneMs < 60_000) return;
    this.lastPruneMs = nowMs;
    this.prune();
  }

  /** 保留清理：文件数与天数双上限，超限删最旧 */
  prune(): void {
    if (this.degraded) return;
    try {
      const entries = readdirSync(this.dir)
        .filter((f) => f.startsWith(`${this.prefix}-`) && f.endsWith('.log'))
        .map((f) => {
          const full = join(this.dir, f);
          let mtime = 0;
          try {
            mtime = statSync(full).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime); // 新 → 旧

      const cutoff = this.now().getTime() - this.maxDays * 24 * 60 * 60 * 1000;
      entries.forEach((e, idx) => {
        const tooOld = e.mtime > 0 && e.mtime < cutoff;
        const tooMany = idx >= this.maxFiles;
        if (tooOld || tooMany) {
          try {
            rmSync(e.full, { force: true });
          } catch {
            /* 单个文件删除失败不影响其余 */
          }
        }
      });
    } catch {
      /* 目录暂不可读时不阻塞 */
    }
  }

  status(): LoggingStatus {
    return {
      degraded: this.degraded,
      dir: this.dir,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.currentFile && !this.degraded ? { currentFile: this.currentFile } : {}),
    };
  }

  /** 停止定时器并尽力刷盘（进程退出路径） */
  close(): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
    this.closed = true;
  }
}

export interface FileLoggerOptions extends RotatingFileSinkOptions {
  readonly level?: LogLevel;
  readonly base?: Record<string, unknown>;
  /** 是否同时镜像到 stderr（默认 true —— 目录降级时至少还有控制台） */
  readonly mirrorToStderr?: boolean;
}

/**
 * 控制台 + 文件双写 Logger。
 *
 * 关键：`child()` 继承的是**同一个 sink**（含文件写入），故 provider/框架用 `logger.child(...)`
 * 派生的子 logger 依旧落盘；但子 logger 是 `ConsoleLogger` 实例，不携带 `logging()` 方法
 * （健康态请从**根** FileLogger 取）。
 */
export class FileLogger extends ConsoleLogger {
  private readonly fileSink: RotatingFileSink;

  constructor(opts: FileLoggerOptions) {
    const fileSink = new RotatingFileSink(opts);
    const mirror = opts.mirrorToStderr !== false;
    super({
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      metaAllowlist: DEFAULT_LOG_META_ALLOWLIST,
      redact: true,
      sink: (line: string) => {
        if (mirror) {
          try {
            process.stderr.write(line + '\n');
          } catch {
            /* stderr 不可写时忽略（文件 sink 仍尝试落盘） */
          }
        }
        fileSink.write(line);
      },
    });
    this.fileSink = fileSink;
  }

  /** `/health.logging` 数据源 */
  logging(): LoggingStatus {
    return this.fileSink.status();
  }

  flush(): void {
    this.fileSink.flush();
  }

  close(): void {
    this.fileSink.close();
  }
}

/** 由服务配置（含 env 覆盖后的结果）构造文件日志器 */
export function createFileLogger(
  cfg: LoggingConfig,
  opts: { base?: Record<string, unknown>; mirrorToStderr?: boolean; now?: () => Date } = {},
): FileLogger {
  return new FileLogger({
    dir: cfg.dir,
    maxBytes: cfg.maxBytes,
    maxFiles: cfg.maxFiles,
    maxDays: cfg.maxDays,
    level: cfg.level,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.mirrorToStderr !== undefined ? { mirrorToStderr: opts.mirrorToStderr } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}
