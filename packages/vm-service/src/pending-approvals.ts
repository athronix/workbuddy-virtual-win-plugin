/**
 * ENG-01 —— MCP 续跑令牌表的**有界化**登记处（`PendingApprovalRegistry`，从 `server.ts` 拆出）。
 *
 * ## 病灶
 * `server.ts` 的 `pendingApprovals = new Map<string, PendingApproval>()` 是**裸 Map**：
 * 只有「宿主应答 / 重放消费 / A2A 审批 TTL 回调」三条**被动**删除路径。若 L2/L3 调用
 * 只是不断被拦截而宿主从不应答（脚本化探测、或宿主侧 UI 故障），令牌条目**只进不出**
 * —— 长跑服务内存单调增长，且残留令牌的 `hostApproved=false` 虽不构成放行漏洞
 * （K4 续跑闸是严格等值），仍会让 `collectApprovalFacts` 的窗口归因面（R3）越扫越宽。
 *
 * ## 设计（`docs/archive/changes/phase1-arch-design.md` §1.6-1）
 * - **替换而非改造**：`implements` 一个窄 `ReadonlyMap` 接口面（`get/has/size/values/
 *   entries/forEach/[Symbol.iterator]`）⇒ `server.ts` 既有三类调用点
 *   （`set` / `get` / `delete`）与 `collectApprovalFacts(ReadonlyMap)` 形参**签名不变**
 *   ——「同签名调用点」是本文件存在的先决条件；
 * - **TTL 复用既有旋钮**：`WINVM_APPROVAL_TTL_MS`（`resolveApprovalTtlMs()`，
 *   `core/constants`）⇒ MCP 与 A2A 两通道同一旋钮、同一语义（30 分钟）。
 *   **不新造同义 env 旋钮**（§8 硬纪律）；策略面亦无超时字段可言 —— 那个默认 120s、
 *   零消费、会在真人反应之前批量误逐的死字段已在 Phase 2 · P2-T2 删除（设计 §5 第 1 条）；
 * - **O-10 在途保护**：`sweepExpired` **跳过** `hostApproved === true` 的条目 ——
 *   那是「宿主已批准、服务端正在重放执行」的在途令牌；重放是有界的 `await`，
 *   误删会打断真实执行（批准已生效却无法落 executed，取证与执行双双失真）。
 *   重放结束由 `raise` 一次性 `delete`（既有 K5 纪律），不需要清扫器代劳；
 * - **定时器 `unref()`**：不得因未决审批把服务进程拖住不退出；
 * - **`close()` 幂等**：接 `server.ts` 生命周期；关闭后 `startTimer` 不再复活（判据⑥）。
 *
 * ## 取证面纪律
 * 被逐条目由 `sweepExpired` **返回给调用方**（本模块零审计依赖 ⇒ 不 import 任何 sink），
 * `server.ts` 据此落 `timeout` 决策审计并做去重。本文件是**纯数据结构**，
 * 可脱离 HTTP 服务与 ps-bridge 直接单测（对齐 `approval-replay.ts` / `health-probe.ts` 纪律）。
 */

/** 清扫判据所需的最小条目形状（避免反向依赖 `server.ts` 的 `PendingApproval`）。 */
export interface SweeperEntry {
  /** 登记时刻（毫秒时间戳）—— TTL 起算点 */
  readonly createdAtMs: number;
  /** 宿主是否已批准（true ⇒ 在途重放，**不得**逐出，O-10） */
  readonly hostApproved?: boolean;
}

/** 注入的定时器句柄形状（单测可用假定时器驱动，无需真计时）。 */
export interface RegistryTimerHandle {
  /** 使定时器不阻止进程退出（Node `unref`；假实现可省略 ⇒ 判据⑥只认返回值） */
  unref?(): void;
  refresh?(): void;
}

/** `startTimer` 的定时器工厂形状（默认 `setTimeout`；测试注入用）。 */
export type TimerFactory = (fn: () => void, delayMs: number) => RegistryTimerHandle;

/** 停表函数形状（默认 `clearTimeout`）。 */
export type TimerClear = (handle: RegistryTimerHandle) => void;

export interface PendingApprovalRegistryOptions {
  /**
   * 令牌 TTL（毫秒）。非法值（`0` / 负 / 非有限 / NaN）⇒ **不设限**（永不过期，
   * 逐字旧行为）——与 `TaskStore.approvalTtlMs` / `resolveApprovalTtlMs` 的
   * 「坏配置不得打挂服务、也不得悄悄改语义」归一纪律同构。
   */
  readonly ttlMs: number;
  /** 日志出口（缺席即 no-op；用于清扫结果与异常留痕） */
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
  /** 定时器工厂（默认 `setTimeout`；单测注入假定时器） */
  readonly setTimer?: TimerFactory;
  /** 停表函数（默认 `clearTimeout`） */
  readonly clearTimer?: TimerClear;
  /** 当前时刻提供者（默认 `Date.now`；单测可注入确定时刻） */
  readonly now?: () => number;
}

/**
 * 窄 Map 接口面（`server.ts` 既有调用点 + `collectApprovalFacts` 的 `ReadonlyMap` 形参所需）。
 * 刻意**只**声明这些成员：将来若装配层需要更多 Map 能力，必须显式扩本接口并同步测试，
 * 而不是让 Registry 悄悄退化成"又一个 Map"（有界化判据会随之失效）。
 */
export interface ApprovalTokenMap<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  readonly size: number;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  forEach(cb: (value: V, key: string, map: ReadonlyMap<string, V>) => void): void;
  [Symbol.iterator](): IterableIterator<[string, V]>;
}

/**
 * 有界续跑令牌表。内部 `Map` + TTL + 清扫器；对外是 `Map` 的**同签名**替身。
 */
export class PendingApprovalRegistry<V extends SweeperEntry> implements ApprovalTokenMap<V> {
  private readonly map = new Map<string, V>();
  private readonly ttlMs: number;
  private readonly logger: PendingApprovalRegistryOptions['logger'];
  private readonly setTimer: TimerFactory;
  private readonly clearTimer: TimerClear;
  private readonly now: () => number;
  /** 定时器句柄（`startTimer` 后非空；`close()` 后置空并判 `closed`）。 */
  private timer: RegistryTimerHandle | undefined;
  /** 生效清扫间隔（毫秒）—— `startTimer` 归一后写入，`arm()` 自续时复用同一值。 */
  private intervalMs: number | undefined;
  /** 清扫结果回传出口（装配层落 `timeout` 决策 + `pruneDecided`；缺席即只逐出不取证）。 */
  private onSwept: ((swept: Array<[string, V]>) => void) | undefined;
  /** 已关闭标志：置真后 `startTimer` 不再复活、`set` 仍可写（装配层收尾竞态不得吞数据）。 */
  private closed = false;

  constructor(opts: PendingApprovalRegistryOptions) {
    this.ttlMs =
      Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : Number.POSITIVE_INFINITY;
    this.logger = opts.logger;
    this.setTimer = opts.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs) as unknown as RegistryTimerHandle);
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? ((): number => Date.now());
  }

  /* ---------------- 窄 Map 面（与既有调用点同签名） ---------------- */

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): void {
    this.map.set(key, value);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  forEach(cb: (value: V, key: string, map: ReadonlyMap<string, V>) => void): void {
    this.map.forEach((value, key) => cb(value, key, this));
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.map[Symbol.iterator]();
  }

  /* ---------------- 有界化面 ---------------- */

  /** 生效 TTL（`Infinity` ⇒ 未启用过期清扫；供 `/health`/日志与测试读取，不回吐配置来源）。 */
  get ttl(): number {
    return this.ttlMs;
  }

  /**
   * 逐出**已过期**条目并返回它们（调用方据此落 `timeout` 决策审计，§1.2 表末行）。
   *
   * 判据：`createdAtMs + ttlMs < now`（严格小于 ⇒ 恰好到点这一拍不逐，下一拍逐，
   * 与 `TaskStore.waitApproval` 的 `setTimeout` 时序对齐，杜绝"边界同刻双写"）。
   *
   * **O-10 在途保护**：`hostApproved === true` 的条目**一律跳过**（宿主已批准、
   * 服务端重放正在执行中 —— 误删会打断真实执行）。这类条目由 `raise` 的
   * 一次性 `delete` 收口，不属清扫器职责。
   *
   * 全程 try/catch 兜底？—— 本方法体内无可抛 I/O（纯 Map 操作），故不加：
   * 加了反而掩盖"条目形状不符"这类真实缺陷。调用方（`server.ts`）在定时器回调里
   * 自带 try/catch + warn（取证面纪律）。
   *
   * `ttlMs = Infinity` ⇒ 恒返回 `[]`（未启用过期语义）。
   */
  sweepExpired(nowMs: number = this.now()): V[] {
    return this.sweepExpiredEntries(nowMs).map(([, entry]) => entry);
  }

  /**
   * 清扫并返回 `[key, entry]`（**装配层用这个**：落审计需要 approvalId，
   * Map key 与条目 `approvalId` 在既有装配里本就相等，仍显式回传键，
   * 以免依赖那条隐含不变式）。
   */
  sweepExpiredEntries(nowMs: number = this.now()): Array<[string, V]> {
    if (!Number.isFinite(this.ttlMs)) return [];
    const expired: Array<[string, V]> = [];
    for (const [key, value] of this.map) {
      if (value.hostApproved === true) continue; // O-10 在途重放保护
      if (value.createdAtMs + this.ttlMs < nowMs) expired.push([key, value]);
    }
    for (const [key] of expired) this.map.delete(key);
    return expired;
  }

  /**
   * 启动周期清扫定时器（**幂等**：已在跑则不重复挂）。
   *
   * 间隔 = `max(60_000, ttl/4)`（设计 §1.6-1）：下限 60s 避免高频扫表，
   * 上限 ttl/4 保证最坏滞留不超过 1.25×TTL。`ttl=Infinity` ⇒ 不挂表
   * （未启用过期语义时挂表只会空转）。
   *
   * 实现用**自续链式 `setTimeout`** 而不是 `setInterval`：
   *  - `setInterval` 在回调耗时超过间隔时会**堆积排队**（慢盘上清扫重叠）；
   *  - 自续链保证「上一轮完成之后」才挂下一轮，且 `close()` 后自然断链（无需追踪多个句柄）；
   *  - 对外仍是单一句柄（`timerHandle` 恒指向**当前**待发的那一枚），`close()` 只需 `clear` 它。
   *
   * `onSwept`（可选）：每次清扫后把**被逐出的条目**交回装配层 —— 设计 §1.2-3 表末行
   * 「MCP 直调令牌过期 ⇒ `'timeout'/'mcp-ttl-sweep'` 决策入链」的落点在本模块之外
   * （本文件是**纯数据结构**，零审计依赖），装配层用这个回调去 `recordDecision` +
   * `pruneDecided`。回调异常被吞并 warn（定时器回调里的异常逃逸 = uncaughtException
   * = 打挂服务，这是取证面/执行面分离纪律的反面）。
   *
   * 返回句柄（可能为 `undefined` ⇒ 未挂表），句柄恒 `unref()`（判据⑥），
   * 且**同一句柄**在 `close()` 里被 `clearTimeout`。
   */
  startTimer(intervalMs?: number, onSwept?: (swept: Array<[string, V]>) => void): RegistryTimerHandle | undefined {
    if (this.closed || !Number.isFinite(this.ttlMs)) return this.timer;
    if (this.timer) return this.timer;
    const raw = intervalMs ?? Math.max(60_000, Math.floor(this.ttlMs / 4));
    this.intervalMs = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Math.max(60_000, Math.floor(this.ttlMs / 4));
    this.onSwept = onSwept;
    this.arm();
    return this.timer;
  }

  /** 挂下一轮清扫（自续链的唯一 `setTimer` 调用点，`close()` 后不再进入）。 */
  private arm(): void {
    if (this.closed || this.intervalMs === undefined) return;
    const handle = this.setTimer(() => {
      // 本轮已触发 ⇒ 句柄失效，先清引用，避免 `close()` 去 clear 一枚已完成的定时器
      this.timer = undefined;
      try {
        const swept = this.sweepExpiredEntries();
        if (swept.length > 0) {
          this.logger?.warn('续跑令牌 TTL 清扫', { swept: swept.length, ttlMs: this.ttlMs, remaining: this.map.size });
          this.onSwept?.(swept);
        }
      } catch (e) {
        // 定时器回调内的异常绝不得逃逸（uncaughtException 会打挂服务）。
        this.logger?.warn('续跑令牌清扫异常（不影响服务）', { error: String(e) });
      }
      this.arm(); // 自续：仅在未关闭时真正挂表（见方法首行）
    }, this.intervalMs);
    handle.unref?.();
    this.timer = handle;
  }

  /** 当前定时器句柄（判据⑥断言用：`close()` 后恒 `undefined`）。 */
  get timerHandle(): RegistryTimerHandle | undefined {
    return this.timer;
  }

  /** 是否已关闭（判据⑥：关闭后不得再有定时器）。 */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 停表并置关闭标志（**幂等**）。由 `server.ts` 的 `close()` 调用。
   * 不清空表内容 —— 收尾语义属装配层（`raise` 的一次性消费仍是唯一删除者）；
   * 停表这件事本身才是本方法的全部职责。
   */
  close(): void {
    this.closed = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
