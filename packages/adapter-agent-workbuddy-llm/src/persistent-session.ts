/**
 * CL-018 C1 · codebuddy **常驻会话**（根治 A2A 委派停滞）
 *
 * 问题（`qa/evidence/codebuddy-stall-diagnosis.md`）：VM 内 LLM 执行器走 codebuddy CLI 的
 * **单次 `-p`**，每次都付全额进程级冷启动（真机实测最简提示词端到端即 75–107s，
 * 其中 `AuthDoInitProbe afterRestore` + Agent 端点生命周期 ≈30s+），宿主 timeout 到期即
 * `A2A_DELEGATE_FAILED`。
 *
 * 方案：一个**长驻**子进程，参数
 *   `-p --input-format stream-json --output-format stream-json --session-id <固定>
 *    --permission-mode bypassPermissions --add-dir <output> --mcp-config <file> --strict-mcp-config`
 * 每个 goal 作为**一条** NDJSON user 消息投喂 stdin，读到 `type=result` 即该轮结束，进程跨轮复用。
 *
 * 真机依据（`qa/evidence/cl018-streamjson-multiturn.raw.log`、
 * `cl018-multiturn-n.summary.json`）：同 PID 完成 4 轮，24492 → 4694 → 1928 → 2129 ms，
 * `alive=true`、`exitCode=0`；第 2 轮起 `cache_read_input_tokens` 25k→79k，缓存命中即延迟骤降机制。
 *
 * C1 修复（QA 真机验收 B 组实锤，`qa/evidence/cl018-qa/cl018-qa-b-*`）：
 * **codebuddy stream-json 的 `system/init` 是懒事件 —— 收到首条用户消息才发出**。
 *   - 探针 A：spawn 后不写任何 stdin → 70s 内 stdout 0 行，`system/init` 永不到来；
 *   - 探针 B：spawn 后 +2s 写入首条用户消息 → init 于消息后 ~6.7s 到达（同 PID 第二轮仅 2.35s）。
 * 因此时序必须为：**spawn → 立即写出本轮 NDJSON 用户消息 → 再等 init（有界）→ 消费本轮响应**；
 * 旧实现「spawn → 先等 init → 再写消息」构成逻辑死锁：每次首调必付 readyTimeout 全额 60s +
 * killChild + 降级单次 `-p`（QA D1=75.6s / D2=80.3s 实证）。
 *
 * 硬约束（验收）：
 *   - AC1.4 固定 `--session-id`；
 *   - AC1.5 **降级不破功能**：常驻不可用时 `runTurn` 返回 `unavailable=true`，
 *     由 `CliLlmBridge` 自动回退单次 `-p` 路径，委派结果语义不变；
 *   - AC1.6 资源：空闲 TTL 回收、重建上限、空闲期不占 CPU（无轮询，仅 1s 级 idle 定时器）。
 *
 * 进程归属：由 **vm-service 进程持有**（非独立守护）—— 服务停即回收，避免孤儿与第二实例。
 */

import { spawn as nodeSpawn } from 'node:child_process';

import type { LlmSessionHealth, LlmSessionState, TaskState } from '@winvm/contracts';

/** 子进程最小形状（便于单测注入假进程；生产由 `spawn` 提供） */
export interface CliChild {
  readonly pid?: number;
  exitCode: number | null;
  killed?: boolean;
  readonly stdout: { on(event: string, listener: (chunk: any) => void): unknown } | null;
  readonly stderr: { on(event: string, listener: (chunk: any) => void): unknown } | null;
  readonly stdin: { write(chunk: string): unknown; end?(): unknown } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: string): unknown;
}

/** 启动器：把渲染后的参数列表变成子进程（生产实现负责 win32 的 cmd.exe 包装） */
export type CliSpawnFn = (args: readonly string[]) => CliChild;

/** 单轮结果 */
export interface TurnResult {
  readonly ok: boolean;
  readonly text: string;
  readonly durationMs: number;
  /**
   * 常驻会话**不可用**（spawn 失败 / 未就绪 / 进程中途退出 / stdin 写失败）——
   * 上层**必须**据此回退单次 `-p`（AC1.5）。与「轮内超时 / LLM 报错」区分开：
   * 后者 `unavailable` 缺省，不得重复劳动。
   */
  readonly unavailable?: boolean;
  readonly error?: string;
}

/** 会话日志出口（默认静默；由 CliLlmBridge 接到服务 logger） */
export type SessionLog = (msg: string, meta?: Record<string, unknown>) => void;

export interface PersistentCliSessionOptions {
  /** 已解析的 CLI 可执行文件路径 */
  readonly cliPath: string;
  /** 产物目录（`--add-dir`） */
  readonly outputDir: string;
  /** MCP 配置文件路径（`--mcp-config`） */
  readonly mcpConfigPath: string;
  readonly sessionId: string;
  readonly idleTtlMs: number;
  readonly readyTimeoutMs: number;
  readonly maxRestarts: number;
  readonly maxWsBytes: number;
  /**
   * K2 修复（A2A 冷启动停滞）：启动期预热 init 等待上限。
   * 与 `readyTimeoutMs`（真实轮次 init 上限）解耦——预热路径允许更宽松的等待且超时不杀会话。
   * 缺席时 `warmup()` 回退 180_000ms。
   */
  readonly warmupReadyMs: number;
  readonly spawnFn: CliSpawnFn;
  /** 时间源（测试可控空闲回收/超时判定） */
  readonly now?: () => number;
  /** 可选：子进程工作集探针（字节）。未注入则不启用 ws 上限护栏（生产默认不注入） */
  readonly wsProbe?: () => number | undefined;
  /**
   * 可选：树杀实现（以 cmd 包装进程 pid 终结整棵进程树）。默认 win32 用
   * `taskkill /PID <pid> /T /F`；测试注入 spy 断言。未注入且非 win32 时为 no-op。
   */
  readonly treeKillFn?: (pid: number) => void;
  readonly log?: SessionLog;
  /**
   * L1 §6.2（**纯附加可选**）：初始即注入「每次 spawn 立即错误退出」故障（默认 false=零影响）。
   * 仅管理端点（`WINVM_ADMIN_ENDPOINT=1` + `?faultInjection=1`）经桥转发置位，供 K-N1
   * 确定性回归；生产路径永不触达。运行期可经 `setSpawnFault()` 注入/清除。
   */
  readonly spawnFault?: boolean;
}

/**
 * 常驻会话参数模板（真机实测有效形态）。
 *
 * 注意：**`-c/--resume` 不能替代常驻** —— 实测每轮仍 spawn 且仍付全额 ~22.7s 进程级冷启动
 * （`cl018-multiturn-n.raw.log` 中 `proc1(cold) wallMs=22467`、`proc2(--resume) wallMs=22729`）。
 */
export const PERSISTENT_CLI_ARG_TEMPLATE: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--session-id',
  '{sessionId}',
  '--permission-mode',
  'bypassPermissions',
  '--add-dir',
  '{output}',
  '--mcp-config',
  '{mcpConfig}',
  '--strict-mcp-config',
];

/** 渲染参数模板（本地实现，避免与 bridge.ts 形成循环依赖） */
export function renderPersistentArgs(vars: Readonly<Record<string, string>>): string[] {
  return PERSISTENT_CLI_ARG_TEMPLATE.map((t) => t.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

/**
 * 树杀默认实现（win32）：`taskkill /PID <pid> /T /F`。
 *
 * 背景（QA Round 2 实测）：常驻 CLI 经 cmd.exe 包装启动（`launchCliProcess` 的 isScript 分支），
 * 仅 `child.kill()` 只终止 cmd 包装进程，真实 CLI（node 孙进程）会**孤儿化**——孤儿迟到的
 * `system/init` 事件曾把状态机置回「无子进程却 ready」的不一致态。树杀确保孙进程一并终止。
 * 非 win32（单测环境）为 no-op，依赖既有 `child.kill()` 兜底。
 */
function defaultTreeKill(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    const p = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    p.on('error', () => undefined); // taskkill 不可用/进程已消失时不影响主流程（kill() 已兜底）
    p.unref?.();
  } catch {
    /* ignore */
  }
}

/** 构造 NDJSON 用户消息帧（共享知识 §8 的既定形态） */
export function buildUserMessageFrame(prompt: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }) + '\n'
  );
}

/** 判定是否「就绪」事件（首个 `system/init`） */
export function isInitEvent(ev: Record<string, unknown>): boolean {
  const t = ev['type'];
  if (t === 'system/init' || t === 'init') return true;
  return t === 'system' && ev['subtype'] === 'init';
}

/** 从 assistant 事件抽取可读文本（仅 text part；tool_use 等忽略） */
export function extractAssistantText(ev: Record<string, unknown>): string {
  const msg = ev['message'];
  if (msg !== null && typeof msg === 'object') {
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((p): p is { type: string; text: string } => {
          const o = p as { type?: unknown; text?: unknown } | null;
          return !!o && o.type === 'text' && typeof o.text === 'string';
        })
        .map((p) => p.text);
      if (texts.length > 0) return texts.join('\n');
    }
    const direct = (msg as { text?: unknown }).text;
    if (typeof direct === 'string') return direct;
  }
  const flat = ev['text'];
  return typeof flat === 'string' ? flat : '';
}

/**
 * 常驻 CLI 会话。
 *
 * 状态机：`stopped --spawn--> starting --system/init--> ready --退出--> degraded --重建--> starting`
 * 超重建上限 → `disabled`（此后恒定回退单次 `-p`）。
 *
 * D11（观测缺陷修复 · 幻象降级）：`state` 只反映**当前**是否健康，历史失败另记于
 * `lastError` / `lastErrorAt`（两信号分离）。会话被终结（`killChild`，如 init 超时/重建前）
 * 时把驻留的 `degraded` 重置为 `stopped`；新会话建立点（`spawnOnce`）置 `starting`（探测中）；
 * 一次成功的 `system/init` 置 `ready` 并**清空** `lastError`/`lastErrorAt`（自愈，无需人工干预）。
 */
export class PersistentCliSession {
  private state: LlmSessionState = 'stopped';
  private child: CliChild | undefined;
  private pid: number | undefined;
  private lastError: string | undefined;
  /** D11：最近一次失败**发生时刻**（ISO 8601，与 lastError 成对维护；恢复时一并清空） */
  private lastErrorAt: string | undefined;
  private lastUsedMs = 0;
  /** 累计 spawn 次数（含首次）；`restarts = spawnAttempts - 1` */
  private spawnAttempts = 0;
  private disposed = false;

  private buffer = '';
  private initSeen = false;
  private readyWaiter: ((ok: boolean) => void) | undefined;
  /** 最近一次 execTurn 是否因「init 有界等待超时」而降级（用于跳过同轮重建，见 runTurn） */
  private initWaitTimedOut = false;
  private activeHandler: ((ev: Record<string, unknown>) => void) | undefined;
  private activeAbort: ((reason: string) => void) | undefined;
  /** K2：预热进行中（单飞；避免 fire-and-forget 重入重复 spawn / 重复写消息） */
  private warmupInFlight: Promise<boolean> | undefined;
  /**
   * L1 §6.2：故障注入位 —— true 时每次 `spawnOnce` 成功后**立即模拟错误退出**
   * （onError + killChild），使状态机沿**既有**路径推进：degraded → 下次 ensureReady
   * 计数递增 → 达 `maxRestarts` 后 `disabled`。默认 false（构造缺席）→ 行为与 HEAD 逐字一致。
   */
  private spawnFaultOn: boolean;

  /** 串行链：新一轮必须等上一轮 `result` 之后才投喂（避免消息交错） */
  private chain: Promise<unknown> = Promise.resolve();

  private idleTimer: NodeJS.Timeout | undefined;

  private readonly opts: PersistentCliSessionOptions;
  private readonly now: () => number;
  private readonly treeKill: (pid: number) => void;

  constructor(opts: PersistentCliSessionOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.treeKill = opts.treeKillFn ?? defaultTreeKill;
    this.spawnFaultOn = opts.spawnFault === true;
    // 空闲回收定时器：1s 级探测（不轮询子进程，空闲期近零 CPU 占用）
    const interval = Math.max(1000, Math.min(Math.floor(opts.idleTtlMs / 2), 30_000));
    this.idleTimer = setInterval(() => this.tick(), interval);
    this.idleTimer.unref?.();
  }

  /* ------------------------------ 观测 ------------------------------ */

  get sessionState(): LlmSessionState {
    return this.state;
  }

  /** 累计重建次数（severe：必须计数并暴露，禁止静默） */
  get restarts(): number {
    return Math.max(0, this.spawnAttempts - 1);
  }

  snapshot(): LlmSessionHealth {
    return {
      state: this.state,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      restarts: this.restarts,
      idleMs: this.lastUsedMs === 0 ? 0 : Math.max(0, this.now() - this.lastUsedMs),
      // D11：失败原因与**发生时刻**成对透出（历史信号），与 state（当前信号）分离。
      ...(this.lastError
        ? { lastError: this.lastError, ...(this.lastErrorAt ? { lastErrorAt: this.lastErrorAt } : {}) }
        : {}),
    };
  }

  /* ------------------------------ 就绪 ------------------------------ */

  private childAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    try {
      this.opts.log?.(msg, meta);
    } catch {
      /* 日志失败不得影响会话 */
    }
  }

  /**
   * D11：记录一次失败原因与**发生时刻**（成对维护）。
   *
   * 将「历史上失败过」（`lastError` / `lastErrorAt`）与「此刻是否健康」（`state`）两个信号分离：
   * 失败后 `state` 会被如实重置（如终结子进程 → `stopped`），而失败痕迹保留在本对字段里。
   * 一律经本方法写入，杜绝只写 `lastError` 而漏掉时间戳的路径。
   */
  private setLastError(message: string): void {
    this.lastError = message;
    this.lastErrorAt = new Date(this.now()).toISOString();
  }

  /**
   * 确保常驻子进程已启动（lazy：首次调用才 spawn）。
   *
   * `budgetMs`（CL-018 R2 补齐）：调用方本轮可等待的**剩余预算**（即 `runTurn` 收到的
   * `timeoutMs`）。spawn 失败/预算耗尽返回 `false` → 上层走**既有降级路径**。
   *
   * ⚠ C1 修复后的语义：本方法只保证「子进程已 spawn 且存活」，**不再等待 `system/init`**
   * （init 是懒事件，必须先写出首条用户消息才会到来 —— 见类头注释）。init 的有界等待
   * 移入 `execTurn`：上界取 `min(readyTimeoutMs, 本轮剩余预算)`，沿用 R2 的预算语义
   * （预算充足时上界仍为 readyTimeoutMs=60s；预算更短时就绪等待不超过预算）。
   * 超时即 `unavailable` → 上层**既有降级路径**（单次 `-p`），不新增静默失败分支。
   */
  async ensureReady(budgetMs?: number): Promise<boolean> {
    if (this.disposed) return false;
    if (this.state === 'disabled') return false;
    if (this.childAlive()) return true;
    if (this.restarts >= this.opts.maxRestarts) {
      this.state = 'disabled';
      this.setLastError(`已超重建上限（${this.opts.maxRestarts}），此后回退单次 -p`);
      this.log('LLM 常驻会话已停用', { restarts: this.restarts, maxRestarts: this.opts.maxRestarts });
      return false;
    }
    return this.spawnOnceBounded(budgetMs);
  }

  /**
   * 在 `min(readyTimeoutMs, budgetMs)` 上界内启动一次常驻子进程。
   *
   * C1 修复后 spawn 本身近即时（init 等待已移入 `execTurn`），本有界包装主要保留
   * 「预算耗尽（budgetMs<=0）不予 spawn」与「spawn 异常有界上报」的 R2 语义；
   * 未给预算（`undefined`）或预算非有限值 → 退化为原始 `spawnOnce()`，保持既有调用方行为不变。
   */
  private spawnOnceBounded(budgetMs?: number): Promise<boolean> {
    if (budgetMs === undefined || !Number.isFinite(budgetMs)) return this.spawnOnce();
    if (budgetMs <= 0) {
      // 本轮预算已耗尽：不再 spawn，直接按「不可用」上报（上层走既有降级路径）
      this.setLastError('本轮预算已耗尽（timeoutMs<=0），常驻会话不予就绪等待');
      this.log('LLM 常驻会话就绪等待超预算', { budgetMs: 0 });
      return Promise.resolve(false);
    }
    const budget = Math.min(this.opts.readyTimeoutMs, budgetMs);
    // 预算不小于就绪上限 → 上界由 readyTimeoutMs 决定，等价于原行为（避免无谓 race）
    if (budget >= this.opts.readyTimeoutMs) return this.spawnOnce();

    const spawnPromise = this.spawnOnce();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.setLastError(`常驻会话就绪等待超过本轮预算（${budget}ms）`);
        this.log('LLM 常驻会话就绪等待超预算', {
          budgetMs: budget,
          readyTimeoutMs: this.opts.readyTimeoutMs,
        });
        // 不杀子进程、不改状态：底层 readyTimeout 上界仍会兜底；
        // 本轮按「不可用」上报 → 上层既有降级路径（单次 -p）。
        resolve(false);
      }, budget);
      timer.unref?.();
      spawnPromise.then(
        (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  private spawnOnce(): Promise<boolean> {
    this.child = undefined;
    this.pid = undefined;
    this.initSeen = false;
    this.buffer = '';

    const args = renderPersistentArgs({
      sessionId: this.opts.sessionId,
      output: this.opts.outputDir,
      mcpConfig: this.opts.mcpConfigPath,
    });

    let child: CliChild;
    try {
      child = this.opts.spawnFn(args);
    } catch (e) {
      this.state = 'degraded';
      this.setLastError(`无法启动常驻 CLI：${(e as Error).message}`);
      this.log('LLM 常驻会话启动失败', { error: this.lastError });
      return Promise.resolve(false);
    }

    this.state = 'starting';
    if (this.spawnAttempts > 0) this.log('LLM 常驻会话重建', { attempt: this.spawnAttempts + 1 });
    this.spawnAttempts += 1;
    this.child = child;
    this.pid = child.pid;
    // 生命周期日志（info 级，由 index.ts 接线；不含用户消息内容/凭据，脱敏纪律不变）
    this.log('LLM 常驻会话已启动', { pid: child.pid ?? null, attempt: this.spawnAttempts, sessionId: this.opts.sessionId });

    // L1 §6.2：故障注入 —— spawn 后立即模拟「进程错误退出」，沿**既有** onError/killChild →
    // degraded → ensureReady 计数 → maxRestarts → disabled 路径推进（不新增状态语义）。
    // 排在事件挂载之前：注入路径不经事件监听器（child 事件仍照常挂，真实事件后到也被门卫比对拦截）。
    if (this.spawnFaultOn) {
      this.faultExit(child);
      return Promise.resolve(false);
    }

    // —— 事件门卫（QA Round 2）：四个事件源全部按 child 实例比对，仅接受**当前** child 的事件。
    // child 引用被 killChild/重建替换后，旧 child（孤儿）的任何 stdout/stderr/exit/error 都不得
    // 再驱动状态机（含迟到的 system/init 把状态机置回 ready 的不一致态）。
    const ch = child;
    child.stdout?.on('data', (d: unknown) => {
      if (this.child !== ch) return;
      this.onStdout(String(d));
    });
    child.stderr?.on('data', (d: unknown) => {
      if (this.child !== ch) return;
      this.onStderr(String(d));
    });
    child.on('exit', (...a: unknown[]) => {
      if (this.child !== ch) return;
      this.onExit(Number(a[0]));
    });
    child.on('error', (...a: unknown[]) => {
      if (this.child !== ch) return;
      this.onError(a[0]);
    });

    /**
     * C1 修复（QA 探针 A/B 铁证）：spawn 后**不得**在此等待 `system/init` ——
     * codebuddy stream-json 的 init 是懒事件，收到首条用户消息才发；先等 init 再写消息
     * 会逻辑死锁（每次首调必付 readyTimeout 全额 60s + killChild + 降级，QA D1/D2 实证）。
     * spawn 即返回 true；init 的有界等待移入 `execTurn`：先写出本轮用户消息，
     * 再等 `min(readyTimeoutMs, 本轮剩余预算)`。
     */
    return Promise.resolve(true);
  }

  /* ------------------------------ stdout 解析 ------------------------------ */

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非协议输出（理论上不应出现），忽略以免污染
      }
      this.dispatch(ev);
    }
  }

  private onStderr(chunk: string): void {
    const t = chunk.trim();
    // stderr 仅作诊断（真机未登录等致命信息由上层 one-shot 路径的 isFatalRuntimeStderr 甄别）
    if (t) this.log('LLM 常驻会话 stderr', { detail: t.slice(0, 240) });
  }

  private dispatch(ev: Record<string, unknown>): void {
    if (isInitEvent(ev)) {
      this.initSeen = true;
      if (this.state === 'starting' || this.state === 'degraded') this.state = 'ready';
      // D11：恢复即同时清空「历史失败」信号（原因 + 时刻），使 /health 不再残留旧失败。
      this.lastError = undefined;
      this.lastErrorAt = undefined;
      this.log('LLM 常驻会话就绪', { pid: this.pid, sessionId: this.opts.sessionId });
      this.readyWaiter?.(true);
    }
    this.activeHandler?.(ev);
  }

  private onExit(code: number): void {
    const wasAlive = this.child !== undefined;
    this.child = undefined;
    this.pid = undefined;
    if (!wasAlive) return;
    if (this.state !== 'disabled') {
      this.state = 'degraded';
      this.setLastError(`常驻 CLI 进程退出（code=${code}）`);
      this.log('LLM 常驻会话进程退出', { code });
    }
    this.readyWaiter?.(false);
    this.activeAbort?.(`常驻 CLI 进程退出（code=${code}）`);
  }

  private onError(err: unknown): void {
    this.state = 'degraded';
    const msg = `常驻 CLI 进程错误：${err instanceof Error ? err.message : String(err)}`;
    this.setLastError(msg);
    this.log('LLM 常驻会话进程错误', { error: msg });
    this.readyWaiter?.(false);
    this.activeAbort?.(msg);
  }

  private killChild(): void {
    const c = this.child;
    const pid = this.pid;
    this.child = undefined;
    this.pid = undefined;
    if (!c) return;
    try {
      c.stdin?.end?.();
    } catch {
      /* ignore */
    }
    try {
      c.kill();
    } catch {
      /* ignore */
    }
    // 树杀（QA Round 2）：常驻 CLI 经 cmd.exe 包装启动，仅 c.kill() 只终止包装进程、
    // node 孙进程孤儿化 —— 以 cmd 包装进程 pid 连树终结（/T /F）。先清引用再杀，
    // 保证孤儿后续事件被事件门卫拦截。
    if (typeof pid === 'number' && pid > 0) {
      try {
        this.treeKill(pid);
      } catch {
        /* 树杀失败不影响既有兜底（stdin.end + kill） */
      }
    }
    // D11（观测缺陷修复）：子进程被终结后，会话**当前**即「未运行」——把仍驻留的
    // 'degraded' 重置为 'stopped'，使 /health.llmSession.state 只反映当前，不再呈现
    // 「幻象降级」（进程已死、却在空闲期持续报 degraded 直到下次委派）。历史失败原因由
    // lastError/lastErrorAt 保留（当前信号与历史信号分离）。'disabled'/'starting'/'stopped'
    // 均不受影响；因 `if (!c) return` 早退，本重置仅在**确有子进程被终结**时发生。
    if (this.state === 'degraded') this.state = 'stopped';
  }

  /* ------------------------------ 轮次（串行） ------------------------------ */

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // 用同一履行/拒绝处理器续链：任何一轮失败都不得卡死后续轮（串行 ≠ 一次性）
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 投喂一轮目标。
   *
   * `unavailable=true` 表示「常驻会话不可用」，调用方应回退单次 `-p`（AC1.5）。
   * 崩溃场景下**至多重建 1 次**再重试该轮（重建次数计入 restarts 上限）。
   */
  runTurn(
    prompt: string,
    sink: { onStatus(state: TaskState, message?: string): void },
    timeoutMs: number,
  ): Promise<TurnResult> {
    return this.enqueue(async () => {
      const started = this.now();
      if (this.disposed) return this.unavailableResult(started, '会话已关闭（shutdown）');
      if (this.state === 'disabled') return this.unavailableResult(started, this.lastError ?? '常驻会话已停用');

      // 子进程启动纳入本轮预算（CL-018 R2）；C1 修复后 init 等待在 execTurn 内、于消息写出之后
      const ready = await this.ensureReady(timeoutMs);
      if (!ready || !this.childAlive()) {
        return this.unavailableResult(started, this.lastError ?? '常驻会话未就绪');
      }

      this.lastUsedMs = this.now();
      // —— C1 修复（时序重排）：execTurn 内先写出本轮用户消息，再等 init ——
      // init 有界等待上界 = min(readyTimeoutMs, 本轮剩余预算)，R2 预算语义不变。
      const first = await this.execTurn(prompt, sink, timeoutMs, Math.max(0, timeoutMs - (this.now() - started)));
      if (!first.unavailable) return first;

      // init 有界等待超时 → 直接走既有降级（上报 unavailable → 上层回退单次 -p），**不进入
      // 同轮重建**：init 是懒事件，立即重建再等大概率再次超时且重复消耗预算；对齐 R2 既有
      // 语义（ensureReady 失败即上报、不重建）。
      if (this.initWaitTimedOut) return first;

      // —— 崩溃重建：至多 1 次（AC1.5 + 设计「重建 ≤1」）——
      if (this.restarts >= this.opts.maxRestarts) return first;
      this.log('LLM 常驻会话不可用，尝试重建后重试本轮', { error: first.error ?? '' });
      this.killChild();
      this.state = 'stopped';
      // 重建就绪同样受本轮**剩余预算**约束（CL-018 R2）
      const rebuilt = await this.ensureReady(Math.max(0, timeoutMs - (this.now() - started)));
      if (!rebuilt) return first;
      this.lastUsedMs = this.now();
      // 重建后的 execTurn 同样「先写消息、再等 init」，且受本轮剩余预算约束
      return this.execTurn(prompt, sink, timeoutMs, Math.max(0, timeoutMs - (this.now() - started)));
    });
  }

  private unavailableResult(started: number, reason: string): TurnResult {
    return { ok: false, text: '', durationMs: this.now() - started, unavailable: true, error: reason };
  }

  /**
   * K2 修复（A2A 冷启动停滞 · 第二版）：服务启动期 fire-and-forget 预热。
   *
   * 与 `runTurn`→`execTurn` 的**关键差异**：
   *   1. **init 等待上界取 `warmupReadyMs`（默认 180s，更长）**，覆盖 codebuddy 进程级冷启动
   *      （auth probe + agent 端点 ≈75–107s），使首个真实委派免付冷启动；
   *   2. **init 超时仅返回、绝不杀会话**（不置 degraded、不调 `killChild`）—— 让冷机在启动期
   *      后台继续暖；真实委派首调若尚未 ready 会再走一次短等待（≤ `readyTimeoutMs`），最坏情形
   *      退化为旧行为（降级单次 `-p`），绝不破坏功能；
   *   3. 预热写出一条无害「OK」用户消息（触发 `system/init` 懒事件，C1 时序铁律），并**消费其
   *      `result` 后再判定为 ready** —— 经串行链 `enqueue` 与真实 `runTurn` 互斥，避免残留 result
   *      被首个真实轮次误吞（竞态污染）。
   *
   * ⚠ 超时**不写 `lastError`** —— 即便预热未达 ready，也不在 `/health.llmSession` 残留伪失败；
   *   进程退出/错误等真实失败仍由 `onExit`/`onError` 正常记录。
   */
  async warmup(prompt: string, budgetMs?: number): Promise<boolean> {
    if (this.warmupInFlight) return this.warmupInFlight;
    const warmupMs = this.opts.warmupReadyMs ?? 180_000;
    const task = this.enqueue(async (): Promise<boolean> => {
      if (this.disposed || this.state === 'disabled') return false;
      // 已就绪（initSeen）→ 直接成功，不重复 spawn / 不写消息
      if (this.childAlive() && this.initSeen) return true;

      const ready = await this.ensureReady(budgetMs ?? warmupMs);
      if (!ready || !this.childAlive()) return false;
      if (this.initSeen) return true; // 已被真实委派抢先拉起并 ready

      return new Promise<boolean>((resolve) => {
        let settled = false;
        let gotResult = false;
        const finishWarm = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          if (initTimer) {
            clearTimeout(initTimer);
            initTimer = undefined;
          }
          if (this.readyWaiter === onReady) this.readyWaiter = undefined;
          if (this.activeHandler === onEvent) this.activeHandler = undefined;
          if (this.activeAbort === abort) this.activeAbort = undefined;
          resolve(ok);
        };
        const abort = (reason: string): void => {
          this.log('LLM 常驻会话预热被中断', { reason });
          finishWarm(false);
        };
        const onEvent = (ev: Record<string, unknown>): void => {
          if (ev['type'] === 'result') {
            gotResult = true;
            // init 已到 + 本轮 result 已消费 → 预热真正完成（会话干净 ready）
            if (this.initSeen) finishWarm(true);
          }
        };
        const onReady = (ok: boolean): void => {
          if (settled) return;
          if (!ok) {
            finishWarm(false);
            return;
          }
          if (gotResult) finishWarm(true);
        };

        const bound = Math.max(0, Math.min(warmupMs, budgetMs ?? warmupMs));
        if (bound <= 0) {
          resolve(false);
          return;
        }
        this.readyWaiter = onReady;
        this.activeHandler = onEvent;
        this.activeAbort = abort;
        let initTimer: NodeJS.Timeout | undefined = setTimeout(() => {
          if (settled) return;
          // K2：预热超时**不杀会话**、不置 degraded、不写 lastError —— 让冷机后台继续暖。
          this.readyWaiter = undefined;
          this.log('LLM 常驻会话预热 init 等待超时（不杀会话，后台继续）', { warmupReadyMs: bound });
          finishWarm(false);
        }, bound);
        initTimer.unref?.();

        const child = this.child;
        if (!child?.stdin) {
          finishWarm(false);
          return;
        }
        try {
          // C1 时序铁律：先写出首条用户消息 → 再等 init
          child.stdin.write(buildUserMessageFrame(prompt));
          this.lastUsedMs = this.now();
        } catch (e) {
          this.readyWaiter = undefined;
          if (initTimer) clearTimeout(initTimer);
          this.activeHandler = undefined;
          this.activeAbort = undefined;
          this.log('LLM 常驻会话预热写入 stdin 失败', { error: (e as Error).message });
          resolve(false);
        }
      });
    });
    this.warmupInFlight = task.finally(() => {
      this.warmupInFlight = undefined;
    });
    return this.warmupInFlight;
  }


  /**
   * 执行一轮：**先写出本轮用户消息，再（仅在尚未收到 init 时）有界等待 `system/init`**，
   * 然后消费本轮响应（assistant 进度 + result）。
   *
   * `initBudgetMs`：本轮剩余预算（`timeoutMs - 已耗时`）。init 等待上界取
   * `min(readyTimeoutMs, initBudgetMs)`；超时 → 走**既有降级语义**（杀常驻子进程 →
   * `unavailable=true` → 上层回退单次 `-p`），不新增静默失败分支。
   * 会话已 ready（initSeen=true）的后续轮次直接写消息、不等 init（复用路径）。
   */
  private execTurn(
    prompt: string,
    sink: { onStatus(state: TaskState, message?: string): void },
    timeoutMs: number,
    initBudgetMs?: number,
  ): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      const started = this.now();
      this.initWaitTimedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let initTimer: NodeJS.Timeout | undefined;

      const finish = (r: TurnResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (initTimer) {
          clearTimeout(initTimer);
          initTimer = undefined;
        }
        if (this.readyWaiter === onReady) this.readyWaiter = undefined;
        if (this.activeHandler === onEvent) this.activeHandler = undefined;
        if (this.activeAbort === abort) this.activeAbort = undefined;
        // 轮次耗时（info 级生命周期日志；仅元数据，不含消息内容 —— 脱敏纪律不变）
        this.log('LLM 常驻会话轮次完成', {
          durationMs: this.now() - started,
          ok: r.ok,
          ...(r.unavailable ? { unavailable: true } : {}),
        });
        resolve(r);
      };

      const abort = (reason: string) => finish(this.unavailableResult(started, reason));

      const onEvent = (ev: Record<string, unknown>): void => {
        const t = ev['type'];
        if (t === 'assistant') {
          const text = extractAssistantText(ev);
          if (text) {
            try {
              sink.onStatus('working', text.slice(0, 240));
            } catch {
              /* 进度回传失败不影响执行 */
            }
          }
          return;
        }
        if (t === 'result') {
          const isErr = ev['is_error'] === true || ev['subtype'] === 'error';
          const text = typeof ev['result'] === 'string' ? ev['result'] : '';
          finish({
            ok: !isErr,
            text,
            durationMs: this.now() - started,
            ...(isErr ? { error: `LLM 返回错误结果${text ? `：${text.slice(0, 200)}` : ''}` } : {}),
          });
        }
      };

      /** init 等待的就绪回调：init 到达（ok=true）则继续消费本轮响应；init 前退出则按不可用上报 */
      const onReady = (ok: boolean): void => {
        if (settled) return;
        if (initTimer) {
          clearTimeout(initTimer);
          initTimer = undefined;
        }
        if (!ok) {
          // init 前进程退出/错误：onExit/onError 已置 lastError
          finish(this.unavailableResult(started, this.lastError ?? '常驻会话未就绪（init 前退出）'));
        }
      };

      // —— init 有界等待（仅「已 spawn 但尚未收到 init」的轮次需要）——
      // 时序保证：定时器虽先于写消息注册，但其回调最早也要到下一个事件循环 tick 才可能触发，
      // 而下方的 stdin.write 在**同一同步块内**先行完成 —— 即「首条消息写出于 await init 之前」。
      // 注册顺序：init 定时器必须先于轮次超时定时器注册 —— bound ≤ timeoutMs，二者相等时
      // 同延时定时器按注册序触发，后注册会让「单轮超时」抢在「init 超预算降级」之前。
      if (!this.initSeen) {
        const bound = Math.max(0, Math.min(this.opts.readyTimeoutMs, initBudgetMs ?? this.opts.readyTimeoutMs));
        if (bound <= 0) {
          finish(this.unavailableResult(started, '本轮预算已耗尽，常驻会话 init 等待不予进行'));
          return;
        }
        this.readyWaiter = onReady;
        initTimer = setTimeout(() => {
          if (settled) return;
          this.readyWaiter = undefined;
          this.initWaitTimedOut = true;
          const msg = `常驻会话在 ${bound}ms 内未收到 system/init（首条用户消息已写出）`;
          this.setLastError(msg);
          this.state = 'degraded';
          this.log('LLM 常驻会话就绪超时', { initWaitMs: bound, readyTimeoutMs: this.opts.readyTimeoutMs });
          // D11：killChild 会把驻留的 degraded 重置为 stopped（state 只反映当前）；
          // 本次「init 超时」事实由 lastError/lastErrorAt 保留（历史信号）。
          this.killChild();
          finish(this.unavailableResult(started, msg));
        }, bound);
        initTimer.unref?.();
      }

      const turnTimeout = setTimeout(() => {
        finish({
          ok: false,
          text: '',
          durationMs: this.now() - started,
          error: `单轮超时（>${timeoutMs}ms）`,
        });
      }, timeoutMs);
      turnTimeout.unref?.();
      timer = turnTimeout;

      this.activeHandler = onEvent;
      this.activeAbort = abort;

      const child = this.child;
      if (!child?.stdin) {
        finish(this.unavailableResult(started, '常驻会话 stdin 不可写'));
        return;
      }
      try {
        child.stdin.write(buildUserMessageFrame(prompt));
      } catch (e) {
        finish(this.unavailableResult(started, `写入常驻会话 stdin 失败：${(e as Error).message}`));
      }
    });
  }

  /* ------------------------------ 回收 ------------------------------ */

  /**
   * 空闲回收 / 资源护栏。（`tick` 由内部定时器调用，亦公开以便测试与上层手动触发。）
   *
   * - 空闲 TTL 到期 → 释放子进程（`state='stopped'`，**下次 runTurn 重建**）；
   * - 注入 `wsProbe` 时，工作集超限 → 释放并重建。
   *
   * 释放是**软**的：不同于 `shutdown()`，不进入 disabled，故服务重启/空闲后仍可复用。
   */
  tick(nowMs: number = this.now()): void {
    if (this.disposed || this.state === 'disabled') return;

    if (this.childAlive() && this.lastUsedMs > 0 && nowMs - this.lastUsedMs > this.opts.idleTtlMs) {
      const idleMs = nowMs - this.lastUsedMs;
      this.log('LLM 常驻会话空闲回收', { idleMs, ttlMs: this.opts.idleTtlMs });
      void this.dispose();
      return;
    }

    if (this.childAlive() && this.opts.wsProbe) {
      const ws = this.opts.wsProbe();
      if (typeof ws === 'number' && ws > this.opts.maxWsBytes) {
        this.log('LLM 常驻会话工作集超限，回收重建', { wsBytes: ws, maxWsBytes: this.opts.maxWsBytes });
        void this.dispose();
      }
    }
  }

  /** 软释放：杀死子进程并回到 `stopped`（可再次 `ensureReady()` 重建） */
  /* ------------------------------ 生命周期（L1 运维） ------------------------------ */

  /**
   * L1 §6.1：运维复位（`POST /admin/llm-session/reset` 的唯一动作）。
   *
   * 语义（严格按设计）：杀现存子进程（若有，复用 `killChild` 的树杀 + 事件门卫路径）→
   * `spawnAttempts = 0`（**累计制计数归零**，`restarts` getter 自动回 0，disabled 的
   * 「计数 ≥ maxRestarts」前提由此解开）→ 清故障注入位 → `state → 'stopped'`
   * （**即使当前是 disabled** —— 这正是本方法存在的意义；`dispose()` 从 disabled
   * 不复位，所以这里不能复用它做状态流转）→ **保留 `lastError`/`lastErrorAt`**
   * （D11 两信号分离纪律：复位解除的是「当前不可用」，抹不掉「历史上失败过」）。
   *
   * 幂等：非 disabled 态调用同样复位计数、不报错（端点语义 §6.1）。
   * 返回复位后的快照（端点 `before/after` 对照）。
   */
  restartFresh(): LlmSessionHealth {
    this.killChild();
    this.spawnAttempts = 0;
    this.spawnFaultOn = false;
    this.disposed = false;
    this.buffer = '';
    this.initSeen = false;
    this.initWaitTimedOut = false;
    // killChild 只在 degraded 时置 stopped；disabled 态必须在此显式复位 ——
    // 但 lastError / lastErrorAt **绝不触碰**（D11：历史信号保留，运维据此判断复位前状态）。
    this.state = 'stopped';
    // shutdown 曾清除空闲定时器；复位后若不重新挂起，会话将永不因空闲回收
    if (!this.idleTimer && !this.disposed) {
      const interval = Math.max(1000, Math.min(Math.floor(this.opts.idleTtlMs / 2), 30_000));
      this.idleTimer = setInterval(() => this.tick(), interval);
      this.idleTimer.unref?.();
    }
    this.log('LLM 常驻会话已复位（L1 admin reset）', {
      lastError: this.lastError ?? '',
      lastErrorRetained: this.lastError !== undefined,
    });
    return this.snapshot();
  }

  /**
   * L1 §6.2：注入/清除「每次 spawn 立即错误退出」故障钩子（测试专用，同一 admin 门控）。
   * 注入后：后续 1 + maxRestarts 次 `ensureReady` 即**确定性**进入 disabled
   * （走既有计数路径，不依赖真实 LLM 会话劣化）。返回注入后的状态位。
   */
  setSpawnFault(on: boolean): boolean {
    this.spawnFaultOn = on === true;
    this.log('LLM 常驻会话故障注入位变更', { spawnFault: this.spawnFaultOn });
    return this.spawnFaultOn;
  }

  /** 当前是否处于故障注入态（观测/断言用） */
  get spawnFaultInjected(): boolean {
    return this.spawnFaultOn;
  }

  /**
   * 故障注入的退出模拟：先清 child 引用（事件门卫使真实迟到事件全被拦截），
   * 再沿 **既有** `onError` → `killChild` 路径推进状态机 —— 零新增状态语义。
   */
  private faultExit(ch: CliChild): void {
    const msg = 'spawnFault 注入：常驻 CLI 启动后立即错误退出（测试注入）';
    this.child = undefined;
    this.pid = undefined;
    this.state = 'degraded';
    this.setLastError(msg);
    this.log('LLM 常驻会话故障注入生效', { attempt: this.spawnAttempts });
    this.readyWaiter?.(false);
    this.activeAbort?.(msg);
    // 真实子进程同样终结（spawnFn 可能已拉起 cmd 包装进程 —— 不留孤儿）
    try {
      ch.stdin?.end?.();
    } catch {
      /* ignore */
    }
    try {
      ch.kill();
    } catch {
      /* ignore */
    }
    const pid = ch.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        this.treeKill(pid);
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------ 关闭 ------------------------------ */
  async dispose(): Promise<void> {
    this.killChild();
    if (this.state !== 'disabled') this.state = 'stopped';
    // 等待串行链排空，确保释放后无悬挂轮次
    try {
      await this.chain;
    } catch {
      /* 链上错误已在各自轮次内消化 */
    }
  }

  /** 硬关闭（服务退出路径）：此后 `runTurn` 恒返回 unavailable，不再重建 */
  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    this.killChild();
    this.state = 'disabled';
    try {
      await this.chain;
    } catch {
      /* ignore */
    }
  }
}
