/**
 * ARCH-07 / ENG-05 —— 服务端 bearer 守卫（**纯函数模块**，从 `server.ts` 拆出）。
 *
 * 为什么单独成模块（对齐 `approval-replay.ts` / `health-probe.ts` 的「纯逻辑件」纪律）：
 * 守卫是 V1 唯一的服务端身份鉴权面，其判据必须能在**不起 HTTP 服务、不拉 ps-bridge**
 * 的条件下被逐条断言（本沙箱里 `createService` 的 ps-bridge spawn 会触发 V8 fatal，
 * 无法作为单测入口）。
 *
 * ## 设计口径（`docs/changes/phase1-arch-design.md` §1.4-2 / §4 O-9）
 * - **双条件生效（O-9）**：`enforceBearer === true` **且** `process.env[tokenEnv]` 非空
 *   ⇒ 才真正校验凭据。与 dry-run 免批双条件同构，防「以为开了」。任一半缺件 ⇒
 *   守卫不生效（**逐字旧行为**），该降级事实由 `/health.security.authMode`
 *   = `'bearer-configured-missing' | 'loopback-only'` 显形，绝不静默。
 * - **默认关**：现网 `delivery/vm-service.config.json` 未写 `enforceBearer`（⇒ undefined
 *   ⇒ falsy）⇒ 路由行为逐字节不变。这是本批**关键回归**（判据⑤）。
 * - **常时比较**：`node:crypto.timingSafeEqual`，长度不等先拒（否则 timingSafeEqual 抛）。
 *   长度早退不泄露有价值的信息：token 长度不是秘密的载体，比较耗时才是。
 * - **豁免清单（硬编码，不可配）**：`GET /health` 与 `GET /.well-known/agent-card.json`
 *   （A2A 发现端点，RFC 8615 要求公开可取）。`/admin/llm-session/reset` **不豁免**
 *   （它有能力效果：杀常驻会话子进程）。契约 `SecurityHealth.endpointAllowlist?: never`
 *   把「端点白名单可配」钉为类型级负空间，防承诺漂移。
 * - **失败响应**：`401 { error:'unauthorized', code:'AUTH_REQUIRED' }`。
 *   `'AUTH_REQUIRED'` 仅 HTTP 层 JSON 体，**不进** `BridgeErrorCode` 枚举
 *   （T1 已在 `contracts/src/errors.ts` 注释写明此边界）。
 * - **不新增审计**：HTTP 层鉴权属传输事实，不入哈希链（ARCH-23 单列 P2），只 `logger.warn`
 *   （含 remoteAddress，使探测行为可见）。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** 守卫判决（判别联合：pass=放行 / deny=拒绝并给出 HTTP 语义）。 */
export type GuardVerdict =
  | { readonly verdict: 'pass' }
  | { readonly verdict: 'deny'; readonly reason: GuardDenyReason };

/** 拒绝原因（进 401 响应体 `code` 旁的诊断字段与 logger.warn，不进链）。 */
export type GuardDenyReason = 'missing-authorization-header' | 'malformed-authorization-header' | 'token-mismatch';

/** HTTP 请求的最小读取面（`IncomingMessage` 的结构性子集，便于脱框架单测）。 */
export interface GuardableRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: { readonly authorization?: string | string[] | undefined } & Record<string, unknown>;
}

/** warn 出口的最小形状（与 `ApprovalWarnSink` 同风格：缺席即 no-op）。 */
export interface GuardWarnSink {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface BearerGuardOptions {
  /**
   * 配置意图（来自 `cfg.security.enforceBearer`）。**缺席/false ⇒ 守卫整体停用**，
   * 每次判决恒 `pass`（现网默认形态，判据⑤关键回归）。
   */
  readonly enforceBearer?: boolean;
  /**
   * bearer token 的**环境变量名**（来自 `cfg.security.tokenEnv`；禁止明文落盘，NFR-511）。
   * 名字缺席/空串 ⇒ 无 token 可比对 ⇒ 第二条件恒不成立。
   */
  readonly tokenEnv?: string;
  /** 注入的 env 视图（默认 `process.env`；单测注入用，生产装配不传 ⇒ 旧行为）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * 注入的豁免路径表（默认 = 模块常量 `DEFAULT_EXEMPT_PATHS`，**硬编码不可配**）。
   * 仅供单测构造「非豁免端点」样本之外的极少数场景；生产装配点**禁止**传入
   * （契约 `endpointAllowlist?: never` 的同源纪律：豁免面不由配置决定）。
   */
  readonly exemptPaths?: readonly string[];
  /** 告警出口（拒绝时 warn；缺席即 no-op ⇒ 纯逻辑场景零副作用）。 */
  readonly logger?: GuardWarnSink;
}

/**
 * 豁免清单（**唯一权威、硬编码**）：A2A 发现 + 健康检查。
 * 只读、无能力效果；`/admin/llm-session/reset` 与 `/mcp` `/a2a` `/audit/receipt` 一律**不**豁免。
 */
export const DEFAULT_EXEMPT_PATHS: readonly string[] = Object.freeze([
  '/health',
  '/.well-known/agent-card.json',
] as const);

/** 401 响应体（`code` 用约定串 `'AUTH_REQUIRED'`，仅 HTTP 层，不进 BridgeError 枚举）。 */
export const BEARER_UNAUTHORIZED_BODY = Object.freeze({
  error: 'unauthorized',
  code: 'AUTH_REQUIRED',
} as const);

/**
 * `authorization` 头的期望前缀（大小写敏感：RFC 6750 定义 `Bearer`）。
 * 头**名**查找走 Node 的小写 header 键（Node http 已归一），无需大小写宽容；
 * 头**值**的 scheme 按 Bearer 严格匹配（宽容 scheme 等于给客户端留两条实现分叉）。
 */
const BEARER_PREFIX = 'Bearer ';

/** 摘要长度（SHA-256 全 32 字节 ⇒ 64 位 hex；日志只落前 16 位）。 */
const DIGEST_PREFIX_LEN = 16;

/**
 * 常时比较（设计 §1.4-2 字面口径：`crypto.timingSafeEqual`，**长度不等先拒**）。
 *
 * 顺序纪律：`timingSafeEqual` 在两侧字节长度不等时会**抛** ⇒ 长度判据必须前置。
 * 长度早退泄露的是「token 多长」而非「token 是什么」——凭据长度不是秘密的载体
 * （设计如此裁断，本实现逐字遵守）；进入等长分支后走唯一一次常时字节比较，
 * 逐字节比对无短路 ⇒ 猜测任意前缀不改变响应时间。
 */
function tokenEquals(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** 摘要前缀（十六进制，截 16 字符）—— 日志侧身份指纹，可 grep、不可还原。 */
function digestPrefix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, DIGEST_PREFIX_LEN);
}

/**
 * 构造 bearer 守卫纯函数（**无状态、无 I/O** —— env 只在构造期读一次期望值）。
 *
 * 返回的 `(req) => GuardVerdict`：
 * - 双条件缺件 ⇒ 恒 `{verdict:'pass'}`（旧行为逐字）；
 * - 豁免路径（**无条件**，与是否生效无关）⇒ `pass`；
 * - 其余：缺头 / 非 Bearer 前缀 / token 不等 ⇒ `deny`（并 warn 一次，含 remoteAddress 由调用方补）。
 *
 * 为什么 env 读取放在构造期：`server.ts` 的进程 env 在服务生命周期内不会重排
 * （bearer 属部署期注入凭据）；构造期快照同时让 `createBearerGuard` 的产物可被
 * 纯函数式测试（给定 opts ⇒ 给定判决），也让 `/health.security.authMode` 与守卫
 * 可以共享**同一次** `resolveBearerToken` 结论，避免两处读取漂移。
 */
export function createBearerGuard(opts: BearerGuardOptions): (req: GuardableRequest) => GuardVerdict {
  const exempt = new Set<string>(opts.exemptPaths ?? DEFAULT_EXEMPT_PATHS);
  const expected = resolveBearerToken(opts.enforceBearer, opts.tokenEnv, opts.env ?? process.env);

  // 双条件缺件（O-9）：守卫**停用** ⇒ 恒 pass（= 现网旧行为）。
  if (expected === undefined) {
    return () => ({ verdict: 'pass' });
  }

  return (req: GuardableRequest): GuardVerdict => {
    // 豁免只读端点（GET；非 GET 即使路径命中也不豁免 —— 面从窄定义）
    const path = extractPath(req.url);
    if (req.method === 'GET' && exempt.has(path)) {
      return { verdict: 'pass' };
    }

    const header = req.headers['authorization'];
    if (header === undefined || header === null) {
      return deny('missing-authorization-header', opts, req, path);
    }
    // Node 允许重复头 ⇒ string[]；多值视为畸形（我们的客户端只会发一个）
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw !== 'string' || !raw.startsWith(BEARER_PREFIX)) {
      return deny('malformed-authorization-header', opts, req, path);
    }
    const presented = raw.slice(BEARER_PREFIX.length);
    // 空 token（"Bearer "）不是凭据，与缺头同等处理，省掉一次无意义比较
    if (!presented) {
      return deny('malformed-authorization-header', opts, req, path);
    }
    if (!tokenEquals(presented, expected)) {
      return deny('token-mismatch', opts, req, path);
    }
    return { verdict: 'pass' };
  };
}

/**
 * 解析**生效期望值**（O-9 双条件的求值本体，`/health.security.authMode` 复用同一函数 ⇒
 * 事实面与执行面同源，杜绝「health 报 enforced 而守卫实际停用」的自相矛盾）。
 *
 * 三态归一（返回 undefined ⇒ 守卫不生效）：
 * - `enforceBearer !== true`（含 undefined/false）⇒ undefined（`loopback-only`）；
 * - `tokenEnv` 缺席/空白 ⇒ undefined（配了开关没配变量名 ⇒ 无密可比）；
 * - `process.env[tokenEnv]` 空白 ⇒ undefined（有名无值 ⇒ `bearer-configured-missing`）；
 * - 其余 ⇒ 非空 token 字符串（`bearer-enforced`）。
 */
export function resolveBearerToken(
  enforceBearer: boolean | undefined,
  tokenEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (enforceBearer !== true) return undefined;
  const name = tokenEnv?.trim();
  if (!name) return undefined;
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * `/health.security` 的三态事实（ARCH-07 透出，与 `resolveBearerToken` 同源判据）。
 *
 * ⚠ `bearer-configured-missing` 是**必须显形的降级态**：配置意图开了鉴权、生效事实没开。
 * 把它读成 `bearer-enforced` 就是「以为开了」的审计谎言（体检 U-P0-2 点名的形态）。
 */
export type HealthAuthMode = 'loopback-only' | 'bearer-enforced' | 'bearer-configured-missing';

export function resolveAuthMode(
  enforceBearer: boolean | undefined,
  tokenEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HealthAuthMode {
  if (resolveBearerToken(enforceBearer, tokenEnv, env) !== undefined) return 'bearer-enforced';
  if (enforceBearer === true) return 'bearer-configured-missing';
  const name = tokenEnv?.trim();
  if (name && !env[name]?.trim()) return 'bearer-configured-missing';
  return 'loopback-only';
}

/**
 * 回环地址判定（`/health.security.boundLoopback`）。
 *
 * 与 `core/src/config` 的私有 `isLoopback`（`config/index.ts:127`）取**逐字相同的枚举口径**
 * （`127.0.0.1` / `localhost` / `::1` / `[::1]`，**不做** `127.` 前缀宽容）：那边负责
 * 「非回环即拒绝启动」，这边负责「把实际绑定态报出来」。两处判据若漂移（例如这里多收
 * `127.0.0.2`），就会出现「配置校验拒绝启动、健康检查却自称回环」的自相矛盾事实 ⇒
 * 故刻意保持同一硬枚举。
 *
 * 刻意 **不** import core 的私有函数：它是模块私有的，导出会扩大公开面；本模块保持
 * 零跨包依赖的纯函数形态（可脱 ps-bridge 直测）。若将来 core 导出该判定，此处改为引用。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

/**
 * `/health.security` 块（ARCH-07 判据⑤事实面）。
 *
 * 三字段全是**运行时事实**，不是配置意图：
 * - `loopbackOnly` —— V1 恒 `true`：回环约束自 Phase 1 起不可关
 *   （`validateServiceConfig` 对非回环绑定恒出 error，`requireLoopbackBind:false` 只出
 *   warning）。故此处报的是**契约承诺**而非 `cfg.security.requireLoopbackBind` 的取值 ——
 *   读那个字段会把「用户写了 false」误报成「服务端允许非回环」，与事实相反。
 * - `boundLoopback` —— **实际**监听地址是否回环（调用方传 `server.address()?.address`
 *   的实测值；listen 前缺席 ⇒ 回落配置值，保守不误报 true）。
 * - `authMode` —— 与守卫生效判据**同源**（都走 `resolveBearerToken` 的 O-9 双条件），
 *   杜绝「health 说 enforced、守卫其实停用」的自相矛盾。
 *
 * `endpointAllowlist` 是契约 `never` 负空间 ⇒ **绝不**构造该键（豁免面硬编码，不可配）。
 *
 * ★ 全仓**唯一**的 security 快照构造器：`server.ts` 以
 * `import { buildSecurityHealth as buildSecurityHealthSnapshot }` 取用（本地别名只为表达
 * 「这是纯构造器，不是服务闭包里的薄封装」）。不要再在此文件另开同形函数 —— 两份实现
 * 漂移 = `/health` 报出的安全事实与守卫生效事实分家（判据⑤的同源性要求）。
 */
export function buildSecurityHealth(opts: {
  readonly enforceBearer?: boolean;
  readonly tokenEnv?: string;
  /** 实际监听地址（`server.address()?.address`）；缺席时调用方应传配置值。 */
  readonly boundHost: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): { readonly loopbackOnly: boolean; readonly boundLoopback: boolean; readonly authMode: HealthAuthMode } {
  return {
    loopbackOnly: true,
    boundLoopback: isLoopbackHost(opts.boundHost),
    authMode: resolveAuthMode(opts.enforceBearer, opts.tokenEnv, opts.env ?? process.env),
  };
}

/** `url`（形如 `/mcp?dtid=x` 或非法串）⇒ pathname。非法 URL 保守取全串（不会命中豁免 ⇒ fail-closed）。 */
function extractPath(url: string | undefined): string {
  if (!url) return '/';
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return url;
  }
}

/** 拒绝分支的统一留痕（logger.warn，**不入审计链** —— HTTP 层是传输事实）。 */
function deny(
  reason: GuardDenyReason,
  opts: BearerGuardOptions,
  req: GuardableRequest,
  path: string,
): GuardVerdict {
  opts.logger?.warn('bearer 守卫拒绝请求', {
    reason,
    method: req.method ?? '',
    path,
    /** 仅当调用方传入带 socket 的真实请求时记录（纯函数单测可省略） */
    remoteAddress: ((req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress) ?? '',
    /** 呈现凭据的摘要前缀（不可还原），使「发了错 token」与「没发 token」在日志里可分辨 */
    presentedDigest: extractPresentedDigest(req),
  });
  return { verdict: 'deny', reason };
}

function extractPresentedDigest(req: GuardableRequest): string {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? digestPrefix(value) : '';
}
