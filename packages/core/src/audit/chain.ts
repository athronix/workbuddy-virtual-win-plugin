/**
 * 哈希链审计（SECURITY-GOVERNANCE.md §4）
 *
 *   hash_n    = SHA256( canonicalJson(record_n 去掉 hash 字段) )
 *   prevHash  = hash_(n-1)，创世记录为 "GENESIS"
 *
 * 任一记录被篡改 → 重算 hash 与链上 prevHash 不符 → 校验立即失败。
 * 存储为 append-only NDJSON（每行一条），按天/按大小轮转。
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { GENESIS_HASH, type AuditRecord } from '@winvm/contracts';
import type { AuditSink } from '@winvm/contracts';

/* ------------------------------ 规范化 JSON ------------------------------ */

/** 键名递归排序的紧凑 JSON —— 保证同一对象在任何环境下序列化结果一致 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 计算某条审计记录的哈希（不含 hash 字段本身） */
export function computeRecordHash(record: Omit<AuditRecord, 'hash'>): string {
  return sha256(canonicalJson(record));
}

/* ------------------------------ 脱敏 ------------------------------ */

const SENSITIVE_KEY_RE = /(password|passwd|secret|token|apikey|api_key|credential|privatekey|private_key)/i;
const LONG_B64_RE = /^[A-Za-z0-9+/]{200,}={0,2}$/;
const REDACTED = '***REDACTED***';

/** 递归脱敏：敏感键名直接打码；超长 base64 截断并记哈希前缀 */
export function redact(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key !== undefined && SENSITIVE_KEY_RE.test(key)) return REDACTED;
    if (LONG_B64_RE.test(value)) {
      return `<base64 len=${value.length} sha256=${sha256(value).slice(0, 16)}…>`;
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redact(v, k);
  }
  return out;
}

/* ------------------------------ Sink ------------------------------ */

export interface AuditChainOptions {
  /** 审计目录，如 %LOCALAPPDATA%\WinVMBridge\audit */
  readonly dir: string;
  /** 单文件切分阈值（字节） */
  readonly maxFileBytes?: number;
  /** 文件名前缀 */
  readonly prefix?: string;
  /** 是否脱敏（默认 true） */
  readonly redactParams?: boolean;
  /**
   * D30：服务启动即起新链（默认 false，沿用旧行为「续接已有链」）。
   * true 时**不**扫描历史分片恢复 seq/lastHash，而是开启一个当日空闲的全新分片、
   * 以 GENESIS 起链（seq 从 1 重计）；历史分片仅作归档（query 可查），
   * **不再参与 verifyChain 判定** —— 已含断链的历史数据不会拖累新链的 chainValid。
   */
  readonly freshChainOnStart?: boolean;
}

/** D30：链断裂原因 */
export type ChainBreakReason = 'HASH_MISMATCH' | 'SEQ_DUP' | 'SEQ_GAP' | 'CHAIN_BREAK';

export interface ChainVerification {
  readonly valid: boolean;
  /** 断裂处的 seq（valid=false 时有值） */
  readonly brokenAt?: number;
  /** 断裂原因（valid=false 时有值） */
  readonly reason?: ChainBreakReason;
  readonly entries: number;
  readonly checked: number;
}

export type AppendAuditInput = Omit<AuditRecord, 'hash' | 'prevHash' | 'seq'>;

/**
 * append-only 哈希链审计写入器。
 * 启动时惰性扫描已有文件以恢复 seq 与 lastHash，避免重复初始化开销。
 */
export class HashChainAuditSink implements AuditSink {
  private readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly prefix: string;
  private readonly doRedact: boolean;
  private readonly freshChain: boolean;

  private seq = 0;
  private lastHash: string = GENESIS_HASH;
  /** 初始化互斥：并发 ensureLoaded 不得重复扫盘 / 重复起新分片（D30 memoize） */
  private loadPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  /** D30：freshChain 模式下本轮写入的分片名（verifyChain 只校验这些，历史分片仅归档） */
  private activeShards: string[] = [];

  constructor(opts: AuditChainOptions) {
    this.dir = resolve(opts.dir);
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.prefix = opts.prefix ?? 'audit';
    this.doRedact = opts.redactParams !== false;
    this.freshChain = opts.freshChainOnStart === true;
  }

  get directory(): string {
    return this.dir;
  }

  /** 幂等加载（memoize）：freshChain 模式起新分片；否则扫描已有分片恢复最后一条的 seq 与 hash */
  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (this.freshChain) {
      // D30：全新 genesis —— 不恢复历史链基线；选取当日第一个**不存在**的分片名，
      // 保证绝不与历史链混写同一文件（混写会让新链首条 prevHash 对不上历史尾条 hash）。
      const day = this.shardName().slice(this.prefix.length + 1, -6);
      let idx = 0;
      for (;;) {
        const name = idx === 0 ? `${this.prefix}-${day}.jsonl` : `${this.prefix}-${day}-${idx}.jsonl`;
        try {
          await stat(join(this.dir, name));
          idx += 1; // 已被历史链占用 → 跳过
        } catch {
          this.activeShards = [name];
          // 物化空分片：启动即建立「新链基线」，verifyChain 空链恒 valid
          await appendFile(join(this.dir, name), '', 'utf8');
          break;
        }
      }
      return;
    }
    const files = await this.listShards();
    for (const f of files) {
      const content = await readFile(join(this.dir, f), 'utf8');
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t) as AuditRecord;
          if (typeof rec.seq === 'number' && rec.seq > this.seq) {
            this.seq = rec.seq;
            this.lastHash = rec.hash;
          }
        } catch {
          // 损坏行：不阻断加载，但校验阶段会报出断裂
        }
      }
    }
  }

  private async listShards(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      const files = entries.filter((f) => f.startsWith(this.prefix) && f.endsWith('.jsonl'));
      // D30：按「日期 + 轮转序号」排序。字典序会把 `audit-YYYYMMDD-1.jsonl` 排在
      // `audit-YYYYMMDD.jsonl` 之前（'-' < '.'），而轮转分片的数据实际产生于正名之后
      // → 跨文件 seq 校验出现假阴性。语义顺序：同日内正名(0)在先，-1/-2/… 依次在后。
      const key = (f: string): { date: string; idx: number } => {
        const rest = f.slice(this.prefix.length + 1, -6); // 去掉 `prefix-` 与 `.jsonl`
        const dash = rest.indexOf('-');
        if (dash === -1) return { date: rest, idx: 0 };
        return { date: rest.slice(0, dash), idx: Number(rest.slice(dash + 1)) || 0 };
      };
      return files.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka.date !== kb.date ? (ka.date < kb.date ? -1 : 1) : ka.idx - kb.idx;
      });
    } catch {
      return [];
    }
  }

  private shardName(): string {
    const d = new Date();
    const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
    return `${this.prefix}-${day}.jsonl`;
  }

  private async currentShard(): Promise<string> {
    // D30：freshChain 模式固定写本轮分片；仅在超阈值时按序号继续轮转
    if (this.activeShards.length > 0) {
      const base = this.activeShards[this.activeShards.length - 1]!;
      const day = base.slice(this.prefix.length + 1, -6).split('-')[0]!;
      const matched = base.match(/-(\d+)\.jsonl$/);
      let i = matched ? Number(matched[1]) : 0;
      const p = join(this.dir, base);
      try {
        const s = await stat(p);
        if (s.size < this.maxFileBytes) return p;
      } catch {
        return p; // 尚未落盘（首条写入时由 appendFile 创建）
      }
      for (;;) {
        i += 1;
        const next = `${this.prefix}-${day}-${i}.jsonl`;
        const np = join(this.dir, next);
        try {
          const s2 = await stat(np);
          if (s2.size >= this.maxFileBytes) continue; // 该轮转位也已满 → 继续找
        } catch {
          // 不存在 → 可用
        }
        this.activeShards.push(next);
        return np;
      }
    }

    const name = this.shardName();
    const p = join(this.dir, name);
    try {
      const s = await stat(p);
      if (s.size >= this.maxFileBytes) {
        // 轮转：追加序号
        let i = 1;
        for (;;) {
          const alt = join(this.dir, `${this.prefix}-${name.slice(6, 14)}-${i}.jsonl`);
          try {
            const s2 = await stat(alt);
            if (s2.size < this.maxFileBytes) return alt;
            i++;
          } catch {
            return alt;
          }
        }
      }
    } catch {
      // 文件不存在，直接用
    }
    return p;
  }

  /** 追加一条审计记录（取号 → 计算 prevHash/hash → 写盘 → 回写基线，整体在 writeQueue 串行闭包内） */
  async append(input: AppendAuditInput): Promise<AuditRecord> {
    // D30 竞态修复：旧实现在**进串行区之前**同步取号（seq = this.seq + 1、prevHash = this.lastHash），
    // 且 this.seq / lastHash 在写盘完成后才回写 → 并发 append 会取到相同 seq 并以相同 prevHash 起链，
    // 造成「重复取号 + 链分叉」（真机实证：三天分片 672 条恰两处重复 seq：511 与 582）。
    // 现将全部状态读写移入串行闭包，保证 seq 严格单调、链严格不分叉。
    const run = this.writeQueue.then(() => this.doAppend(input));
    // 队列必须恒为 fulfilled：单条失败只向调用方抛错，不中断后续写入
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doAppend(input: AppendAuditInput): Promise<AuditRecord> {
    await this.ensureLoaded();
    const seq = this.seq + 1;
    const partial: Omit<AuditRecord, 'hash'> = {
      ...input,
      seq,
      prevHash: this.lastHash,
      ...(this.doRedact ? { params: redact(input.params) as Record<string, unknown> } : {}),
    };
    const hash = computeRecordHash(partial);
    const record: AuditRecord = { ...partial, hash };

    const line = JSON.stringify(record) + '\n';
    const shard = await this.currentShard();
    await mkdir(this.dir, { recursive: true });
    await appendFile(shard, line, 'utf8');

    // 写盘成功后回写链基线（仍在串行区内，回写顺序即写序）
    this.seq = seq;
    this.lastHash = hash;
    return record;
  }

  /** 全链校验（freshChain 模式仅校验本轮分片；历史分片归档可查但不参与判定） */
  async verifyChain(): Promise<ChainVerification> {
    await this.ensureLoaded();
    const files = this.freshChain ? [...this.activeShards] : await this.listShards();
    let expectedPrev: string = GENESIS_HASH;
    let lastSeq = 0;
    let checked = 0;
    let entries = 0;

    for (const f of files) {
      let content: string;
      try {
        content = await readFile(join(this.dir, f), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // freshChain 首条写入前分片可能尚空
        throw e;
      }
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      // 跨文件按 seq 排序，保证链式顺序
      const recs = lines
        .map((l) => {
          try {
            return JSON.parse(l) as AuditRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is AuditRecord => r !== null)
        .sort((a, b) => a.seq - b.seq);

      for (const rec of recs) {
        entries++;
        const { hash, ...rest } = rec;
        const recomputed = sha256(canonicalJson(rest));
        const chainOk = rec.prevHash === expectedPrev;
        const hashOk = recomputed === hash;
        // D30：seq 单调性也纳入断裂判定 —— 重复 seq / 跳号即使 hash 与 prevHash 自洽也是断链
        //（真机实证的 511/582 重复 seq 现场，正是「哈希全对但 seq 重复」的形态）。
        if (!chainOk || !hashOk || rec.seq !== lastSeq + 1) {
          const reason: ChainBreakReason = !hashOk
            ? 'HASH_MISMATCH'
            : rec.seq <= lastSeq
              ? 'SEQ_DUP'
              : rec.seq !== lastSeq + 1
                ? 'SEQ_GAP'
                : 'CHAIN_BREAK';
          return { valid: false, brokenAt: rec.seq, reason, entries, checked };
        }
        expectedPrev = hash;
        lastSeq = rec.seq;
        checked++;
      }
    }
    return { valid: true, entries, checked };
  }

  /** 按条件查询（只读） */
  async query(filter?: {
    traceId?: string;
    capabilityId?: string;
    since?: string;
    limit?: number;
  }): Promise<AuditRecord[]> {
    await this.ensureLoaded();
    const files = await this.listShards();
    const out: AuditRecord[] = [];
    for (const f of files) {
      const content = await readFile(join(this.dir, f), 'utf8');
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t) as AuditRecord;
          if (filter?.traceId && rec.traceId !== filter.traceId) continue;
          if (filter?.capabilityId && rec.capabilityId !== filter.capabilityId) continue;
          if (filter?.since && rec.ts < filter.since) continue;
          out.push(rec);
        } catch {
          // 跳过损坏行
        }
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return filter?.limit ? out.slice(-filter.limit) : out;
  }
}
