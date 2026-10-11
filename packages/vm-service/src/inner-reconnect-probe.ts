/**
 * Phase 2 · P2-T6 —— VM 内回连通路的**运行期探针**（设计 §2.2 Step-1 判据 2 的「真机探针」支）。
 *
 * ## 为什么需要它（T5 留下的判据缺口）
 * `resolveInnerReconnect` 是纯函数，只能从**配置面**推理回连通路：判序④「没配变量名 ⇒
 * 回连条目零凭据 ⇒ 必 401」、⑤「有名无值 ⇒ broken」、⑥「有名有值 ⇒ unverified」。
 * ⑥ 是刻意的诚实：配置在位只是**必要条件**，它回答不了三件只有真实 HTTP 才能回答的事：
 *  1. 凭据值是否真的**到达了回连客户端**（VM 内 CLI 的 env 分发链是否接通 —— 任务计划
 *     无 env 通道、只有 `start-hidden.ps1` 显式赋值这一条注入路径，装配错一处就静默断）；
 *  2. `mcpServers.winvm.headers` 里的 `Authorization: Bearer ${VAR}` **引用形态**是否被
 *     CLI 侧 MCP 客户端展开（这是设计 §6 给 P2-T6 标注的最大不确定点；2026-10-11 真机
 *     实测确认展开成立 —— 见 `qa/r19/t6-probe-e1*`；配置面判据无法自证这件事）；
 *  3. 服务自己的 `/mcp` 在带凭据时是否真放行（守卫挂载点与豁免表在同进程里漂移时，
 *     只有真发一次请求才会暴露）。
 * 本模块把这三次求证做成**一次自环回连**，产出 `InnerReconnectHealth` 快照喂给
 * 判序③（`probeStatus`）⇒ `innerReconnect` 得以从「恒 unverified」升为「实证 ok」。
 *
 * ## 三条护栏（为什么探针不得变成启动依赖）
 *  - **PR3（T5 既有纪律）**：探针自身故障（连接被拒 / 超时 / fetch 抛错 / 无 fetch 运行时）
 *    一律归 `unverified`，**绝不冒充 broken** —— 否则「观测手段坏了」会被 fail-closed 读成
 *    「回连确证断了」并拒绝启动，把可观测性缺陷升级成可用性事故。
 *  - **拒启判据不变**：探针在 `listen()` **之后** fire-and-forget 触发（见 `server.ts`
 *    装配点），结论只回填 `/health.security.innerReconnect` 的**观测面**；启动期
 *    fail-closed 判决仍**只按配置面**（`resolveInnerReconnect` 不喂 probeStatus）。
 *    这条顺序是刻意的：探针前置于 listen 即自环死锁（自己等自己），而探针晚于拒启判定
 *    则永不可能影响拒启 ⇒ 观测面坏不得影响启动面。
 *  - **零副作用样本**：发一条带 id 的 `initialize`（MCP 只读握手，不触碰任何能力），
 *    并带 `?dtid=<探针 id>` 使自发流量可被链上/日志 grep。刻意**不用**无 id 通知
 *    （通知 ⇒ 202 空体，与 200/401 的区分度下降）。
 *  - **凭据不外泄**：只读 env **有无值**，绝不把值写进 reason/日志（reason 里连端点
 *    的 dtid 值都做脱敏）。
 */

import type { InnerReconnectHealth, InnerReconnectStatus } from './http-guard.js';

/**
 * 探针请求体：带 id 的 `initialize`（见文件头「零副作用样本」）。
 * 与真机 CLI 的首帧形态同族（`qa/r19/t6-probe-e1` 回环 echo server 实测收到的就是这条），
 * 因此探针结论对「真实回连首帧」具有可比性。
 */
export function probeInitializeBody(dtid: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: `winvm-inner-reconnect-probe/${dtid}`, version: '1.0.0' },
    },
  };
}

/** 注入 fetch 的最小响应面（单测只需 `status`；生产返回的真 Response 天然满足）。 */
export interface ProbeFetchResponse {
  readonly status: number;
}

/** 注入 fetch 的最小签名（`globalThis.fetch` 的结构性子集，便于脱网单测）。 */
export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<ProbeFetchResponse>;

/** 探针入参（`server.ts` 装配点喂事实；单测喂夹具）。 */
export interface InnerReconnectProbeInput {
  /**
   * 与 `buildMcpConfig` **完全同源**的回连端点（provider options.endpoint）。
   * 缺席 ⇒ 无法探针 ⇒ 如实 `unverified`（不猜默认端口，那会把配置错误伪装成实测结论）。
   */
  readonly endpoint?: string;
  /** 回连凭据变量名（provider options.bearerEnvName；空白/缺席 ⇒ 探针无凭据可带）。 */
  readonly bearerEnvName?: string;
  /** 注入的 env 视图（默认 `process.env`；单测注入，生产不传 ⇒ 旧行为）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 探针超时（毫秒，默认 5000；非法值回退默认）。 */
  readonly timeoutMs?: number;
  /** 自发流量标识（进 `?dtid=` 与 clientInfo.name，可 grep；默认 'startup'）。 */
  readonly probeId?: string;
  /** 注入 fetch（单测注入假响应 ⇒ 全判决分支可离线断言；生产走全局 fetch）。 */
  readonly fetchImpl?: ProbeFetch;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_DTID_PREFIX = 't6reconnect';

/** 结论包装（唯一出口，保证 status/reason 成对出现、不产出半个事实）。 */
function finish(status: InnerReconnectStatus, reason: string): InnerReconnectHealth {
  return { status, reason };
}

/** 端点脱敏（reason 里不暴露完整 dtid 值；探针 id 形态本身已足够辨识自发流量）。 */
function safeEndpoint(url: string): string {
  return url.replace(/dtid=[^&]*/g, 'dtid=<探针 id>');
}

/**
 * 执行一次回连探针（**async**；调用方 fire-and-forget，绝不 await 于启动链路）。
 *
 * 判决映射（`phase2-inner-credential.test.js` B 组逐条断言）：
 *  - `200` ⇒ `ok`（端到端实证：凭据经 env 分发到达 CLI 侧形态、headers 引用被展开、
 *    守卫放行 —— 这正是设计 §2.2 Step-1 判据 2 要的真实事实）；
 *  - `401`/`403` ⇒ `broken`（确证凭据没到位：分发链或引用形态任一环断）；
 *  - 其它状态码 ⇒ `unverified`（服务活着但语义未明，不猜）；
 *  - 网络错误/超时/抛错/端点或变量名缺席/运行时无 fetch ⇒ `unverified`（PR3）。
 *
 * 「有名无值」在这里**不**判 broken：那是配置面判序⑤的职权（且若探针也判 broken，
 * 「探针在无凭据环境里跑」这一观测事实会二次污染拒启判据）。
 */
export async function probeInnerReconnect(input: InnerReconnectProbeInput): Promise<InnerReconnectHealth> {
  const env = input.env ?? process.env;
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (!endpoint) {
    return finish('unverified', '回连探针未执行：provider options.endpoint 缺席 ⇒ 无实测事实（不猜端口）');
  }
  const envName = typeof input.bearerEnvName === 'string' ? input.bearerEnvName.trim() : '';
  if (!envName) {
    return finish('unverified', '回连探针未执行：bearerEnvName 缺席 ⇒ 探针无凭据可带（配置面已由判序④判决）');
  }
  const token = env[envName]?.trim();
  if (!token) {
    return finish(
      'unverified',
      `回连探针未执行：变量名 "${envName}" 在环境无值 ⇒ 无凭据可带（配置面按判序⑤另行判决）`,
    );
  }

  const dtid = `${PROBE_DTID_PREFIX}-${input.probeId ?? 'startup'}`;
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}dtid=${encodeURIComponent(dtid)}`;
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;

  // 运行时 fetch 探测：Node 18+ 恒有；缺失（极老运行时/裁剪环境）属**观测面不可用**，
  // 按 PR3 归 unverified，绝不冒充「回连断了」。
  const injected = input.fetchImpl;
  const globalFetch = (globalThis as unknown as { fetch?: ProbeFetch }).fetch;
  const doFetch: ProbeFetch | undefined = injected ?? globalFetch;
  if (!doFetch) {
    return finish('unverified', '回连探针未执行：运行时无 fetch ⇒ 无实测面（不猜结论）');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // 探针自己用**真值**发一次带凭据回连 —— 这正是 CLI 侧 headers 引用展开后的等价形态
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(probeInitializeBody(dtid)),
      signal: ac.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return finish(
        'broken',
        `回连探针实证：带凭据 POST ${safeEndpoint(url)} ⇒ HTTP ${res.status} ⇒ 凭据未到位（env 分发链或 CLI headers 展开任一环断）`,
      );
    }
    if (res.status === 200) {
      return finish(
        'ok',
        `回连探针实证：带凭据回连 /mcp ⇒ HTTP 200（自环 initialize 样本 ${dtid}）⇒ 凭据分发通路端到端可用`,
      );
    }
    return finish(
      'unverified',
      `回连探针得到 HTTP ${res.status}（非 200/401/403）⇒ 语义未明，绝不据此拒启（PR3）`,
    );
  } catch (e) {
    const timedOut = ac.signal.aborted;
    return finish(
      'unverified',
      `回连探针自身失败（${timedOut ? `超时 >${timeoutMs}ms` : (e as Error).message}）⇒ 事实未知，绝不据此拒启（PR3）`,
    );
  } finally {
    clearTimeout(timer);
  }
}
