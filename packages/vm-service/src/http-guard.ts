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

/* ============================================================================================
 * P2-T5（F2 Step 1）· **bearer 生效自检** —— 拒绝静默退化
 *
 * 病灶（设计 §2.1，B3 真机实测）：`/health.security.authMode` 回答的是「配置意图 + env 有值」
 * 这一**装配事实**，它回答不了两件事：
 *   ① 守卫代码是否**真的在拒**（挂载逻辑漂移成永 allow ⇒ 事实面与执行面分家）；
 *   ② VM 内回连通路在守卫生效时是否**真的可用**（不可用 ⇒ 401 打在工具面 ⇒ 委派零副作用
 *      虚假完成，比当场失败更隐蔽）。
 * 自检就是把这两件事变成机器可读事实：`bearerSelfCheck`（同进程正/反例求值，成本≈0）与
 * `innerReconnect`（回连通路三态）。`enforceBearerFailClosed` 决定 `broken` 时是否拒启（Q4）。
 *
 * 纪律：
 *  - 三个函数**全是纯函数**（输入 ⇒ 输出，零 I/O、零 setTimeout、不碰 process 之外的可变态），
 *    可脱 ps-bridge 逐条断言（`phase2-bearer-selfcheck.test.js` 的决策表全分支）；
 *  - **探针不可达/超时绝不冒充 broken** ⇒ `unverified` 是独立三态值（PR3：否则服务因探针
 *    自身故障起不来，把观测风险升级成可用性事故）；
 *  - 默认态（守卫未挂载）**只观测不改判**：`bearerSelfCheck.code='not-mounted'` +
 *    `innerReconnect.status='unverified'`，`shouldFailClosedStart` 恒 `false` ⇒ 现网逐字零回归。
 * ============================================================================================ */

/** 挂载自检结论码（五值封闭集；`ok` 是 `code` 的单调映射，冗余便于 grep）。 */
export type BearerSelfCheckCode =
  /** 守卫未挂载（`resolveBearerToken` 为空）⇒ 跳过挂载求值；默认态。 */
  | 'not-mounted'
  /** 守卫已挂载且正反例均符合预期（无凭据 deny、正确凭据 pass）。 */
  | 'mounted-pass'
  /** 守卫已挂载却对无凭据请求放行 ⇒ 挂载逻辑漂移成永 allow（**静默退化**）。 */
  | 'mounted-fail-guard-always-allow'
  /** 守卫已挂载但对正确凭据判 deny ⇒ 装配错误，全部合法调用会被 401。 */
  | 'mounted-fail-guard-rejects-correct-token'
  /** 守卫已挂载但拿不到求值器 ⇒ 挂载逻辑**事实未知**（装配缺陷；不伪装成 not-mounted）。 */
  | 'mounted-evaluator-absent';

/** `/health.security.bearerSelfCheck` 透出形状（`reason` 为人读诊断，**绝不含凭据值**）。 */
export interface BearerSelfCheckHealth {
  readonly code: BearerSelfCheckCode;
  readonly ok: boolean;
  readonly reason: string;
}

/** 挂载自检入参（生产装配由 `server.ts` 喂；单测注入 `evaluate` 覆盖 4 条判决分支）。 */
export interface BearerMountSelfCheckInput {
  /** `resolveBearerToken(...)` 的结论：有值 ⇔ 守卫真挂载（`authMode==='bearer-enforced'`）。 */
  readonly bearerToken?: string;
  /** 守卫求值器（生产传 `createBearerGuard` 产物；缺席 ⇒ 不谎称 pass，见下）。 */
  readonly evaluate?: (req: GuardableRequest) => GuardVerdict;
}

/** 自检用非豁免请求样本（POST `/mcp`：委派工具面，**绝不在豁免表内**）。 */
function selfCheckRequest(authorization?: string): GuardableRequest {
  const headers: Record<string, unknown> = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  return { method: 'POST', url: '/mcp', headers };
}

/**
 * 挂载逻辑自检（设计 §2.2 Step-1 判据 1）。
 *
 * 为什么「不发真实 HTTP」：本沙箱内起服务会 spawn ps-bridge 触发原生 fatal（既有纪律），
 * 且「守卫代码是否在拒」是**进程内逻辑事实**，同进程直调 `createBearerGuard` 产物即可
 * 完整求值，成本≈0、离线可证、真机同码。真实 HTTP 面的可用性由 `qa/r19/` 探针脚本另证。
 */
export function runBearerMountSelfCheck(input: BearerMountSelfCheckInput): BearerSelfCheckHealth {
  const token = input.bearerToken;
  if (token === undefined || token === '') {
    // 未挂载：透出事实但**绝不 ok:false**（默认态不得因"没开守卫"被读成异常）。
    return { code: 'not-mounted', ok: true, reason: 'bearer 守卫未挂载（authMode≠bearer-enforced），跳过挂载求值' };
  }
  if (input.evaluate === undefined) {
    // 已挂载却拿不到求值器 ⇒ 事实未知。刻意**不复用** not-mounted（那会把"未知"伪装成
    // "确实没挂"），也不谎称 pass，更不冒用 always-allow（那是**实测**出来的永 allow 事实，
    // 与"没测到"是两种证据强度）。
    return {
      code: 'mounted-evaluator-absent',
      ok: false,
      reason: '守卫已挂载但未注入求值器 ⇒ 挂载逻辑不可证（装配缺陷，自检拒绝静默放行）',
    };
  }
  const evaluate = input.evaluate;
  const noCred = evaluate(selfCheckRequest());
  if (noCred.verdict !== 'deny') {
    return {
      code: 'mounted-fail-guard-always-allow',
      ok: false,
      reason: '守卫已挂载却对不带凭据的非豁免请求放行 ⇒ 挂载逻辑漂移成永 allow（静默退化）',
    };
  }
  const withCred = evaluate(selfCheckRequest(`Bearer ${token}`));
  if (withCred.verdict !== 'pass') {
    return {
      code: 'mounted-fail-guard-rejects-correct-token',
      ok: false,
      reason: '守卫已挂载但对正确 bearer 判 deny ⇒ 凭据装配漂移，全部合法调用将被 401',
    };
  }
  return { code: 'mounted-pass', ok: true, reason: '挂载求值通过：无凭据 deny、正确凭据 pass' };
}

/** VM 内回连通路三态（**必须能表达「未验证」** —— PR3 护栏 + F5 E-2 同族纪律）。 */
export type InnerReconnectStatus = 'ok' | 'broken' | 'unverified';

/** `/health.security.innerReconnect` 透出形状。 */
export interface InnerReconnectHealth {
  readonly status: InnerReconnectStatus;
  readonly reason: string;
}

/** 回连判定的输入视图（provider options 子集 + security 意图；键名与 `delivery/*` 同源）。 */
export interface InnerReconnectView {
  /** 守卫生效事实（`resolveAuthMode` 同源结论）；非 `bearer-enforced` ⇒ 无判定意义。 */
  readonly authMode: HealthAuthMode;
  /** 生效中的 provider options（`cfg.agent.providers[cfg.agent.provider].options`）。 */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  /**
   * 真机探针结论（可选）。**A2-13 诚实化订正（Phase 3 批6）**：本字段是 `resolveInnerReconnect`
   * 的**纯函数契约面**（判序③：提供 ⇒ 端到端实证优先于配置推理），供探针脚本离线评估与未来
   * 统一判决面复用（`phase2-inner-credential.test.js` D 组钉其语义）；**生产 fail-closed 路径
   * 不喂入本字段** —— 拒启判据被 PR3 红线钉死为「恒按配置面」（`server.ts:806` 取 `innerReconnect.status`，
   * 装配点 `:798` 只传 authMode/providerOptions 两键）。运行期探针的实证结论走另一条通路升级
   * **观测面**：`server.ts:2163` `innerReconnectObserved = probed`（直接赋值，语义等价判序③"原样采用"，
   * 但绕开本函数 ⇒ 观测面升级绝不反噬拒启判定）。故"由调用方回填本函数"是旧注释的失实表述，已订正。
   */
  readonly probeStatus?: InnerReconnectStatus;
  /** 探针失败原因（超时/不可达等）；提供 ⇒ 强制 `unverified`（绝不误判 broken）。同为纯函数契约面，生产 fail-closed 不喂入（见 probeStatus 注）。 */
  readonly probeError?: string;
}

/**
 * VM 内回连通路判定（设计 §2.2 Step-1 判据 2；**纯函数、零 I/O**）。
 *
 * 语义演变（P2-T5 立判序 ⇒ P2-T6 通路面就位）：
 *  - **T5 期（通路不存在）**：守卫真生效时回连条目零凭据 ⇒ **结构上必 401** ⇒ 判 `broken`
 *    是唯一诚实结论（也就是 fail-closed 的触发条件，Q4）。
 *  - **T6 后（通路存在，本节）**：`buildMcpConfig` 已能在 `mcpServers.winvm.headers` 承载
 *    `Authorization: Bearer ${<envName>}`（真机实证 codebuddy 会展开该引用，`qa/r19/t6-probe-e1-*`），
 *    于是「配置面上到底有没有把凭据交给回连」重新变成一个**可判定**的事实：
 *      · 没配变量名 ⇒ 回连条目零凭据 ⇒ 与 T5 期同一形态 ⇒ 仍判 `broken`（此时拒启是**正确的**：
 *        通路可用但没接线，一开守卫委派必退化为零副作用虚假完成）；
 *      · 有名无值 ⇒ `broken`（双条件缺件，O-9 同族）；
 *      · 有名有值 ⇒ `unverified`（配置在位只是**必要条件**，端到端可用性须探针/演练实证，
 *        判序③的 `probeStatus` 即为此预留 —— 本函数**不**谎称已证）。
 *  守卫未生效 ⇒ `unverified`（只观测不改判，回环默认态永远不会因此拒启）。
 *
 * 判据（优先级从上到下）：
 *  1. `authMode !== 'bearer-enforced'` ⇒ `unverified`（守卫没挂，回连带不带凭据都通，无判定意义）；
 *  2. `probeError` 在场（探针自身不可达/超时）⇒ `unverified`（PR3：探针故障不得升级成可用性事故）；
 *  3. `probeStatus` 在场 ⇒ 原样采用（端到端实证优先）；
 *     ⚠ **A2-13**：判序②③是纯函数契约面（D 组单测钉语义）；生产 fail-closed 装配点**不喂**这两键
 *     （拒启恒按配置面=PR3 红线），运行期探针实证结论经 `server.ts` `innerReconnectObserved = probed`
 *     直接升级**观测面**，不回流本函数 ⇒ 判序②③在生产判决路径不可达是**设计使然**，非缺陷。
 *  4. provider options 未承载任何 bearer 变量名（`bearerEnvName` 缺席/空白）⇒ `broken`
 *     （通路**可用但未接线**：`buildMcpConfig` 条目零凭据 ⇒ 回连必 401）；
 *  5. 配了变量名但 env 无值 ⇒ `broken`（有名无值，双条件缺件）；
 *  6. 配了变量名且 env 有值 ⇒ `unverified`（配置在位只是必要条件，不谎称已证）。
 */
export function resolveInnerReconnect(
  view: InnerReconnectView,
  env: Readonly<Record<string, string | undefined>> = process.env,
): InnerReconnectHealth {
  if (view.authMode !== 'bearer-enforced') {
    return {
      status: 'unverified',
      reason: `authMode=${view.authMode}：守卫未挂载 ⇒ 回连通路无判定意义（只观测不改判，默认态恒不拒启）`,
    };
  }
  if (view.probeError) {
    return { status: 'unverified', reason: `回连探针自身失败（${view.probeError}）⇒ 事实未知，绝不据此拒启` };
  }
  if (view.probeStatus) {
    return { status: view.probeStatus, reason: '采用真机/装配期探针端到端结论（实证优先于配置推理）' };
  }
  const raw = view.providerOptions?.['bearerEnvName'];
  const envName = typeof raw === 'string' ? raw.trim() : '';
  if (!envName) {
    return {
      status: 'broken',
      reason:
        '守卫已生效，但 VM 内回连通路未配置任何 bearer 凭据变量名（provider options.bearerEnvName 缺席 ⇒ buildMcpConfig 条目零凭据）⇒ 回连必 401；凭据分发通路已具备（P2-T6），但**尚未接线**：请在 agent.providers.<id>.options.bearerEnvName 写变量名（默认约定 WINVM_BEARER_TOKEN）并让 start-hidden.ps1 显式赋值该 env',
    };
  }
  if (!(env[envName]?.trim())) {
    return {
      status: 'broken',
      reason: `回连 bearer 变量名 "${envName}" 已配置但环境无值 ⇒ 回连不带凭据必 401（有名无值，双条件缺件）`,
    };
  }
  return {
    status: 'unverified',
    reason: `回连 bearer 变量名 "${envName}" 已配置且 env 有值 ⇒ 配置在位；端到端可用性须探针实证（本判定不谎称已证）`,
  };
}

/** fail-closed 决策入参（三条件齐才拒启 —— §13 Q4 裁决的机器可读形态）。 */
export interface FailClosedDecisionInput {
  /** `/health.security.authMode` 的**同源**结论（仅 `bearer-enforced` 有权拒启，PR3）。 */
  readonly authMode: HealthAuthMode;
  /** 回连通路三态。 */
  readonly innerReconnect: InnerReconnectStatus;
  /** `security.enforceBearerFailClosed` 生效值（默认 true；false ⇒ 一键回滚）。 */
  readonly failClosed: boolean;
}

/** fail-closed 判决：`refuse`=拒绝进入服务态；`rollbackWarn`=回滚位生效时的显式告警。 */
export interface FailClosedDecision {
  readonly refuse: boolean;
  readonly rollbackWarn: boolean;
}

/**
 * fail-closed 决策表（`phase2-bearer-selfcheck.test.js` 逐格断言）：
 *
 * | authMode | innerReconnect | failClosed | refuse | rollbackWarn |
 * |---|---|---|---|---|
 * | `loopback-only` | 任意 | 任意 | **false** | false |
 * | `bearer-configured-missing` | 任意 | 任意 | **false** | false |
 * | `bearer-enforced` | `unverified` | true/false | false | false |
 * | `bearer-enforced` | `ok` | true/false | false | false |
 * | `bearer-enforced` | `broken` | true | **true** | false |
 * | `bearer-enforced` | `broken` | false | false | **true** |
 */
export function shouldFailClosedStart(input: FailClosedDecisionInput): FailClosedDecision {
  if (input.authMode !== 'bearer-enforced') return { refuse: false, rollbackWarn: false };
  if (input.innerReconnect !== 'broken') return { refuse: false, rollbackWarn: false };
  return input.failClosed ? { refuse: true, rollbackWarn: false } : { refuse: false, rollbackWarn: true };
}

/* ---- 自检的链上取证（设计 §2.2 Step-1 判据 2：`ext.kind:'bearer-selfcheck'` 条目） ----
 *
 * 与 `chain-archive-verify` **同族纪律**：写**原始 sink**（不经 `wrapAuditSink`），否则
 * 审计自证（自己的条目把自己登记成「本回合有活动」）。字段形态（`matchedRule` 前缀、
 * `capabilityId:'meta.audit.chain'`、`risk:'L0'`、`principal.channel:'internal'`）逐字
 * 对齐 `approval-replay.ts:571` 的既有自发条目范式，防两套口径漂移。
 *
 * ⚠ 返回**裸对象**（不带 `ext` 键）当且仅当调用方要求 `emitChainEntry:false`；默认恒带
 * `ext` ⇒ 落盘条目 `ext.kind='bearer-selfcheck'` 可 grep（取证纪律：与 `zeroInnerCalls`
 * 「恒落供人工审视」同源 —— 危害形态是「无痕的虚假完成」，证据必须无条件在场）。
 */

/** 自检链上条目的可注入输入（`server.ts` 装配点喂实测事实；单测喂夹具）。 */
export interface BearerSelfCheckAuditInput {
  readonly traceId: string;
  /** `/health.security.authMode` 同源结论。 */
  readonly authMode: HealthAuthMode;
  readonly selfCheck: BearerSelfCheckHealth;
  readonly innerReconnect: InnerReconnectHealth;
  /** fail-closed 生效值（透出「本轮若判 broken 会不会拒启」这一决策事实）。 */
  readonly failClosed: boolean;
  /** fail-closed 是否真的拒启（仅拒启轮为 true；回滚位轮/放行轮 false）。 */
  readonly refuse: boolean;
  /** 自检发起时刻（毫秒 epoch，用于 durationMs）。 */
  readonly startedAtMs: number;
}

/** 自检链上条目的**裸形态**（`AppendAuditInput` 的结构子集，不含 seq/hash/prevHash）。 */
export interface BearerSelfCheckAuditEntry {
  readonly ts: string;
  readonly traceId: string;
  readonly auditId: string;
  readonly principal: { readonly host: string; readonly user: string; readonly channel: 'internal' };
  readonly capabilityId: string;
  readonly risk: 'L0';
  readonly params: Record<string, unknown>;
  readonly policyDecision: { readonly allowed: true; readonly matchedRule: string };
  readonly result: { readonly ok: boolean; readonly summary: string };
  readonly durationMs: number;
  readonly ext: {
    readonly kind: 'bearer-selfcheck';
    readonly selfCheck: BearerSelfCheckHealth;
    readonly innerReconnect: InnerReconnectHealth;
    readonly authMode: HealthAuthMode;
    readonly failClosed: boolean;
    readonly refused: boolean;
  };
}

/**
 * 构造 `ext.kind:'bearer-selfcheck'` 链上条目（纯函数，`newAuditId` 注入 ⇒ 可脱服务断言）。
 *
 * `ok` 的口径（**不得加码也不得放松**）：守卫**未挂载**（默认态）⇒ `ok:true`（没开守卫
 * 不是故障，判序见 `resolveAuthMode`）；守卫挂载 ⇒ `ok = 挂载求值通过 ∧ 回连非 broken`。
 * `matchedRule` 把「回连必被打断」这一最恶形态单独成码（`bearer-selfcheck:inner-reconnect-broken`），
 * 使 grep 一条码即得全部「误开守卫且回连必断」的启动轮。
 */
export function buildBearerSelfCheckAuditEntry(
  input: BearerSelfCheckAuditInput,
  newAuditId: () => string,
): BearerSelfCheckAuditEntry {
  const mounted = input.authMode === 'bearer-enforced';
  const innerBroken = input.innerReconnect.status === 'broken';
  const ok = mounted ? input.selfCheck.ok && !innerBroken : true;
  const matchedRule = innerBroken
    ? 'bearer-selfcheck:inner-reconnect-broken'
    : !input.selfCheck.ok
      ? `bearer-selfcheck:${input.selfCheck.code}`
      : mounted
        ? 'bearer-selfcheck:mounted-pass'
        : 'bearer-selfcheck:not-mounted';
  const summary = ok
    ? `bearer 生效自检：authMode=${input.authMode} / selfCheck=${input.selfCheck.code} / innerReconnect=${input.innerReconnect.status}（判定合格，服务放行）`
    : `bearer 生效自检：authMode=${input.authMode} / selfCheck=${input.selfCheck.code} / innerReconnect=${input.innerReconnect.status}` +
      (input.refuse ? '⇒ fail-closed 拒绝进入服务态' : `⇒ 放行（enforceBearerFailClosed=${input.failClosed}）`) +
      '；VM 内回连不带凭据 ⇒ 委派将退化为零副作用虚假完成（B3 实证形态），详见 SECURITY-GOVERNANCE §2.1';
  return {
    ts: new Date().toISOString(),
    traceId: input.traceId,
    auditId: newAuditId(),
    principal: {
      host: 'vm-service',
      user: process.env['USERNAME'] ?? 'unknown',
      // internal：服务端自发条目，不是任何外部主体的请求（与 chain-archive-verify 同口径）
      channel: 'internal',
    },
    // 审计子系统自证属 meta 能力域（同 approval-replay.ts:603 的权威值），不占业务面
    capabilityId: 'meta.audit.chain',
    risk: 'L0',
    params: {
      authMode: input.authMode,
      selfCheckCode: input.selfCheck.code,
      innerReconnect: input.innerReconnect.status,
      failClosed: input.failClosed,
      refused: input.refuse,
    },
    // 自检是**事实陈述**而非许可判定 ⇒ allowed 恒 true，语义全在 matchedRule 与 result.ok
    policyDecision: { allowed: true, matchedRule },
    result: { ok, summary },
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
    ext: {
      kind: 'bearer-selfcheck',
      selfCheck: { ...input.selfCheck },
      innerReconnect: { ...input.innerReconnect },
      authMode: input.authMode,
      failClosed: input.failClosed,
      refused: input.refuse,
    },
  };
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
 *
 * ★ P2-T5 附加两键（**纯附加、条件展开**）：`bearerSelfCheck` / `innerReconnect`。
 * 两键只在调用方**给到快照**时才进对象（缺席 ⇒ 整键不存在 ⇒ 旧读者逐字旧形状，K-13）。
 * 快照本身由 `server.ts` 在启动期算好一次并常驻（不在每次 /health 请求里重复求值 ——
 * 探针是启动期事实，运行期重复探测等于 DoS 自我放大）。
 */
export function buildSecurityHealth(opts: {
  readonly enforceBearer?: boolean;
  readonly tokenEnv?: string;
  /** 实际监听地址（`server.address()?.address`）；缺席时调用方应传配置值。 */
  readonly boundHost: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** P2-T5：启动期挂载自检快照（缺席 ⇒ 不写 `bearerSelfCheck` 键）。 */
  readonly selfCheck?: BearerSelfCheckHealth;
  /** P2-T5：VM 内回连通路判定快照（缺席 ⇒ 不写 `innerReconnect` 键）。 */
  readonly innerReconnect?: InnerReconnectHealth;
}): {
  readonly loopbackOnly: boolean;
  readonly boundLoopback: boolean;
  readonly authMode: HealthAuthMode;
  readonly bearerSelfCheck?: BearerSelfCheckHealth;
  readonly innerReconnect?: InnerReconnectHealth;
} {
  return {
    loopbackOnly: true,
    boundLoopback: isLoopbackHost(opts.boundHost),
    authMode: resolveAuthMode(opts.enforceBearer, opts.tokenEnv, opts.env ?? process.env),
    // 条件展开（禁止显式 undefined —— 会让 JSON 落盘丢键而重算不一致的同族纪律不适用此处，
    // 但「缺席即旧形状」的纯附加语义同样要求不写空键）。
    ...(opts.selfCheck ? { bearerSelfCheck: { ...opts.selfCheck } } : {}),
    ...(opts.innerReconnect ? { innerReconnect: { ...opts.innerReconnect } } : {}),
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
