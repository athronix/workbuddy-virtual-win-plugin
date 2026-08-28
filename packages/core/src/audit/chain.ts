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
}

export interface ChainVerification {
  readonly valid: boolean;
  /** 断裂处的 seq（valid=false 时有值） */
  readonly brokenAt?: number;
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

  private seq = 0;
  private lastHash: string = GENESIS_HASH;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: AuditChainOptions) {
    this.dir = resolve(opts.dir);
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.prefix = opts.prefix ?? 'audit';
    this.doRedact = opts.redactParams !== false;
  }

  get directory(): string {
    return this.dir;
  }

  /** 幂等加载：扫描目录下所有分片，恢复最后一条的 seq 与 hash */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
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
    this.loaded = true;
  }

  private async listShards(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((f) => f.startsWith(this.prefix) && f.endsWith('.jsonl')).sort();
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

  /** 追加一条审计记录（串行化写入，避免并发交错破坏链序） */
  async append(input: AppendAuditInput): Promise<AuditRecord> {
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

    // 串行化：保证 seq 与 prevHash 严格单调
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(shard, line, 'utf8');
    });
    await this.writeQueue;

    this.seq = seq;
    this.lastHash = hash;
    return record;
  }

  /** 全链校验 */
  async verifyChain(): Promise<{ valid: boolean; brokenAt?: number; entries: number }> {
    await this.ensureLoaded();
    const files = await this.listShards();
    let expectedPrev: string = GENESIS_HASH;
    let checked = 0;
    let entries = 0;

    for (const f of files) {
      const content = await readFile(join(this.dir, f), 'utf8');
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
        if (!chainOk || !hashOk) {
          return { valid: false, brokenAt: rec.seq, entries };
        }
        expectedPrev = hash;
        checked++;
      }
    }
    return { valid: true, entries, ...(checked === entries ? {} : { brokenAt: entries }) };
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
