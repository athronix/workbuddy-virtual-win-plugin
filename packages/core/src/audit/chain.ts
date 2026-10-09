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
import type { ArchiveVerification, AuditSink } from '@winvm/contracts';

/**
 * D-4 兑现（ARCH-06 A2）：`ArchiveVerification` 的**权威定义在 contracts（L0）** ——
 * `AuditSink.verifyArchive?()` 是 L0 契约成员的返回类型，L0 不得引用 L1a 的类型。
 * core 侧只做**再导出**，供既有 `from '@winvm/core'` 的消费方（含单测）按同一名字取用；
 * 全仓只允许这一份定义，禁止在 core 复制同形结构（两份同形接口会彼此漂移，
 * 且 TS 结构化类型让漂移**静默通过编译**）。
 */
export type { ArchiveVerification };

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

/**
 * ARCH-06 A2（O-8）：`verifyArchive` 单次最多校验的历史分片数 —— **写死的有界上限**。
 *
 * 为什么要写死而不是做成配置项：本方法会被启动 fire-and-forget 与 `/health` 级路径调用，
 * 历史分片在长跑部署里可以有成百个；无界扫描会让一次健康检查变成整目录读盘。
 * 超出上限的分片**只计数不校验**（调用方拿到的数组长度即已校验数，可与 `shardsTotal`
 * 对比看出「还有多少没看」）。取值 30：够覆盖「一天轮转若干片 × 最近数日」的量级，
 * 且单次代价可控（每片一次 readFile + 一次线性哈希重算）。
 */
export const ARCHIVE_VERIFY_MAX_SHARDS = 30;

export interface ChainVerification {
  readonly valid: boolean;
  /** 断裂处的 seq（valid=false 时有值） */
  readonly brokenAt?: number;
  /** 断裂原因（valid=false 时有值） */
  readonly reason?: ChainBreakReason;
  readonly entries: number;
  readonly checked: number;
  /**
   * ARCH-06 A2（**纯附加可选**，缺席即旧行为）：本次结论**校验了什么范围**。
   *
   * 病灶：`server.ts` 硬写 `freshChainOnStart: true`，本方法在 freshChain 模式下只读
   * 本轮 `activeShards` ⇒ 历史分片永久退出判定面，而 `/health.audit` 只报 `chainValid` ——
   * 「校验过的那条链」与「磁盘上全部的链」是两个东西，但呈现面把它们说成同一个。
   * 本批**不改** `freshChainOnStart` 行为（P0 根治另立项），只把既有事实显式化：
   * `'session'` = 仅本轮运行期分片；`'full'` = 目录下全部分片。
   * ⚠ 这四个字段**不参与** `valid` 判定（判定逻辑逐字不变），只是把范围说清楚。
   */
  readonly scope?: 'session' | 'full';
  /** 参与判定的分片数 */
  readonly shardsVerified?: number;
  /** 审计目录下的全部分片数 */
  readonly shardsTotal?: number;
  /** 未参与判定的归档分片数（= shardsTotal − shardsVerified） */
  readonly shardsArchived?: number;
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
    /*
     * K-N1：`ext`（委派审计扩展）与 `params` 同纪律递归脱敏，并做**键归一**——
     * 显式 `ext: undefined` 必须整键删除。原因：`canonicalJson` 把 undefined 序列化为 `null`
     * 参与哈希，而 `JSON.stringify` 落盘时**丢键** → 重算哈希与链上 hash 不符（假断链）。
     * 同理 `null` 值：`canonicalJson` 与 `JSON.stringify` 都输出 `null`，键保留一致，无需处理。
     */
    const base: Record<string, unknown> = { ...input };
    if (base['ext'] === undefined) {
      delete base['ext'];
    } else if (this.doRedact) {
      base['ext'] = redact(base['ext']);
    }
    const partial: Omit<AuditRecord, 'hash'> = {
      ...(base as unknown as Omit<AuditRecord, 'hash' | 'seq' | 'prevHash'>),
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
    // ARCH-06 A2：先取**目录下全部分片**用于范围透出（代价 = 一次 readdir），
    // 判定用的 files 仍按既有规则选取 —— 下面的 valid 判定逻辑**逐字未改**。
    const all = await this.listShards();
    const files = this.freshChain ? [...this.activeShards] : all;
    // 纯附加信息：算范围数时读盘失败绝不改变判定结果（故整段包 try，兜底为「不知道就不报」）。
    const scopeInfo = this.scopeInfo(all, files);
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
          return { valid: false, brokenAt: rec.seq, reason, entries, checked, ...scopeInfo };
        }
        expectedPrev = hash;
        lastSeq = rec.seq;
        checked++;
      }
    }
    return { valid: true, entries, checked, ...scopeInfo };
  }

  /**
   * ARCH-06 A2：范围透出（**纯附加**，不参与任何判定）。
   *
   * `shardsArchived = shardsTotal − shardsVerified`，即「目录里有、但本次结论没看」的片数 ——
   * 这正是 `freshChainOnStart:true` 下历史链退出判定面的那部分，跨轮事实改由
   * {@link verifyArchive} 的归档校验条目提供证据。
   */
  private scopeInfo(all: readonly string[], files: readonly string[]): Partial<ChainVerification> {
    try {
      const shardsTotal = all.length;
      const shardsVerified = files.length;
      return {
        scope: this.freshChain ? 'session' : 'full',
        shardsVerified,
        shardsTotal,
        shardsArchived: Math.max(shardsTotal - shardsVerified, 0),
      };
    } catch {
      return {};
    }
  }

  /**
   * ARCH-06 A2（O-8）：对**历史归档分片**逐片做片内校验，返回每片结论。绝不抛。
   *
   * 为什么只校验**片内**：历史片彼此无链关系，且与本轮新片也无关系（freshChain 以 GENESIS
   * 起新链）。若把跨片首条的 `prevHash` 也拿来比对，**每一条历史分片都会报断**（全红），
   * 那份证据就等于噪音。故每片**独立**校验「seq 单调 + prevHash 接得上」，报出的
   * `brokenAt` 是**该片内**的 seq；跨片首条不比对（实现见 {@link verifyShardIntraChain}）。
   *
   * 有界：最多校验 `ARCHIVE_VERIFY_MAX_SHARDS` 片（超出的只计数不校验）—— 本方法可能被
   * `/health` 级路径或启动 fire-and-forget 调用，历史分片多时不允许长阻塞。
   * 全程 try/catch：读盘/解析失败只体现为该片的 `valid:false` 或跳过，绝不向上抛
   * （取证面不得影响主流程，与 `doAppend` / 审批重放同一纪律）。
   */
  async verifyArchive(maxShards: number = ARCHIVE_VERIFY_MAX_SHARDS): Promise<readonly ArchiveVerification[]> {
    try {
      await this.ensureLoaded();
      const all = await this.listShards();
      // 「归档集」= 目录里的分片去掉本轮活跃分片。freshChain 模式下即全部历史片（新链只有一片）；
      // 非 freshChain 模式下 activeShards 为空 ⇒ 逐片复核全部（比 verifyChain 的口径更宽，不作证据缺失）。
      const archived = all.filter((f) => !this.activeShards.includes(f));
      // 非正值/NaN ⇒ 回退默认上限（env 或调用方给坏值不得让校验失效或全量扫盘）
      const limit = Number.isFinite(maxShards) && maxShards > 0 ? Math.floor(maxShards) : ARCHIVE_VERIFY_MAX_SHARDS;
      const targets = archived.slice(0, limit);
      const out: ArchiveVerification[] = [];
      for (const shard of targets) {
        out.push(await this.verifyShardIntraChain(shard));
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 单片「片内链」校验（{@link verifyArchive} 的实现体；绝不抛） */
  private async verifyShardIntraChain(shard: string): Promise<ArchiveVerification> {
    let content: string;
    try {
      content = await readFile(join(this.dir, shard), 'utf8');
    } catch (e) {
      // 读不到：这是**事实**（分片消失/权限问题），报成该片不可信而不是抛
      return { shard, entries: 0, valid: false, reason: `UNREADABLE:${(e as NodeJS.ErrnoException).code ?? 'ERR'}` };
    }
    const recs = content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as AuditRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is AuditRecord => r !== null)
      .sort((a, b) => a.seq - b.seq);

    // **片内基线取自本片首条**（这是 O-8「只校验片内」的另一半，与「跨片首条 prevHash
    // 不比对」是同一件事的两种说法）：
    //   - 轮转/归档分片的首条 `prevHash` 指向**上一片**的尾条，`seq` 也从上一片继续 ——
    //     若硬用 `expectedPrev = GENESIS` / `lastSeq = 0` 起步，每一片**正常轮转**的历史都
    //     会报 `CHAIN_BREAK`/`SEQ_GAP`（全红），那份证据等于噪音，正是设计点名要防的形态；
    //   - 首条的**接链关系**在片内无从校验（它的可信性由写它那天 verifyChain 的全链判定
    //     负责），但首条的**自洽性**（存储 hash 是否等于内容重算值）片内完全可判 ⇒ 单独查
    //     一次，让「只改首条内容」也当场显形，而不是拖到第二条才报。
    // 「接不上上一片」不是断裂，但**片内**任何一处篡改都跑不掉：改某条内容 ⇒ 它的 hash 与
    // 后一条的 prevHash 不符；改后一条的 prevHash ⇒ 它自己的 hash 重算不符。
    const first = recs[0];
    if (first) {
      const { hash: firstHash, ...firstRest } = first;
      if (sha256(canonicalJson(firstRest)) !== firstHash) {
        return { shard, entries: recs.length, valid: false, brokenAt: first.seq, reason: 'HASH_MISMATCH' };
      }
    }
    let expectedPrev: string = first?.hash ?? GENESIS_HASH;
    let lastSeq: number = first?.seq ?? 0;
    for (const rec of recs.slice(1)) {
      const { hash, ...rest } = rec;
      const recomputed = sha256(canonicalJson(rest));
      const chainOk = rec.prevHash === expectedPrev;
      const hashOk = recomputed === hash;
      if (!chainOk || !hashOk || rec.seq !== lastSeq + 1) {
        const reason: ChainBreakReason = !hashOk
          ? 'HASH_MISMATCH'
          : rec.seq <= lastSeq
            ? 'SEQ_DUP'
            : rec.seq !== lastSeq + 1
              ? 'SEQ_GAP'
              : 'CHAIN_BREAK';
        return { shard, entries: recs.length, valid: false, brokenAt: rec.seq, reason };
      }
      expectedPrev = hash;
      lastSeq = rec.seq;
    }
    return { shard, entries: recs.length, valid: true };
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
