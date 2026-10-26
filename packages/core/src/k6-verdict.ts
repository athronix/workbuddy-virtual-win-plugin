/**
 * C0（Phase 5 · K6 假成功回潮面根治）：K6 权威判定位折叠 —— **纯函数件**。
 *
 * 病灶（立案见 `qa/p5-batch/v19-VERDICT.md` 与 `docs/archive/audit/2026-10-16-v19-analysis.md` §6.2）：
 * psmod 卸载回执携带 K6 权威判定 `data.success`（exit0 ∧ 最终核验；核验不过
 * `success=false` 并附 `residualEvidence`），但 Node 呈报全链只消费信封 `ok`
 * （进程级"调用送达"），`data.success` 零消费点 —— `data.success=false` 的失败回执
 * 被信封 ok=true 压平成「执行成功」呈给宿主/LLM/审计摘要。
 *
 * 本件是该断链的**单点折叠**：在执行回执组装处（`server.ts` `executeCapability`，
 * `receiptCache.record` **之前**）把执行器自报的失败折进信封，使 K5 回执链、
 * 重放路径（`toExecutedResult` 读 `structuredContent.ok`，零改动即诚实改判）、
 * 委派转呈与 `/audit/receipt` 端点全部自动受益。
 *
 * 判据（严格，向后兼容零误伤）：`data` 为 plain object 且 `data.success === false`
 * （严格布尔 false）。`undefined` / `true` / 字符串 `"false"` / 数字 `0` / 数组 / null
 * ⇒ 一律**不触发**。dryRun 回执（`success=true` 或无 `success` 键）不受影响；
 * 54 能力中当前只有 uninstall 族产 `success` 键，但规则通用 —— 未来任何 psmod
 * 能力自报 `success=false` 即诚实呈报。
 *
 * 纪律：错误码复用契约既有 `EXECUTION_FAILED`（retryable=false，见
 * `@winvm/contracts` errors.ts），不新增码、§2.6 登记面与漂移钉不受触；
 * `reason='K6_VERIFY_FAILED'` 走 CL-017 D23 领域原因码先例。
 */

/** 折叠结果形状（服务层消费）。 */
export interface K6Fold {
  /** 折叠后的信封 ok（K5/toExecutedResult/委派转呈的唯一判定位）。 */
  readonly ok: boolean;
  /** 折叠后的 MCP 结果 isError。 */
  readonly isError: boolean;
  /** 本调用是否命中 K6 自报失败折叠（true ⇒ 调用方须补 error 块）。 */
  readonly k6Failed: boolean;
  /** 折叠命中时的失败文案（含残留证据摘要；未命中为 undefined）。 */
  readonly errorMessage?: string;
}

/** K6 折叠失败文案基干（契约码 EXECUTION_FAILED 的 message）。 */
export const K6_FAIL_MESSAGE = '执行器自报未成功（K6 核验未过）';

/** plain object 判定（数组/null/primitive 一律 false）——与 approval-replay isRecord 同语义。 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * K6 折叠单点判据：信封 ok + 执行回执 data ⇒ 折叠后信封。
 *
 * 规则（纯函数、零副作用）：
 *  - `data` 为 plain object 且 `data.success === false`（严格）⇒ `ok=false`、
 *    `isError=true`、`k6Failed=true`、`errorMessage=基干+残留证据摘要（若有）`；
 *  - 其余任何形态 ⇒ 原样透传（`ok=envelopeOk`、`isError=!envelopeOk`、`k6Failed=false`）。
 */
export function foldK6Verdict(envelopeOk: boolean, data: unknown): K6Fold {
  const fail = isPlainRecord(data) && data['success'] === false;
  if (!fail) {
    return { ok: envelopeOk, isError: !envelopeOk, k6Failed: false };
  }
  const evidence = residualEvidenceSummary(data);
  return {
    ok: false,
    isError: true,
    k6Failed: true,
    errorMessage: evidence ? `${K6_FAIL_MESSAGE}；残留证据: ${evidence}` : K6_FAIL_MESSAGE,
  };
}

/** 残留证据截断长度（防回执膨胀，与 summaryFromData 的 200 字符纪律同档）。 */
const RESIDUAL_CLIP = 200;

/**
 * 残留证据摘要：取 `data.residualEvidence`（psmod K6 核验不过时的人类可读清单，
 * 字符串或字符串数组），序列化后截断 200 字符。空形态（缺键/null/空串/空数组/
 * 序列化后为 `{}`/`[]`）⇒ undefined（不写入文案，零误伤）。
 */
export function residualEvidenceSummary(data: unknown): string | undefined {
  if (!isPlainRecord(data)) return undefined;
  const raw = data['residualEvidence'];
  if (raw === undefined || raw === null) return undefined;
  let text: string;
  if (typeof raw === 'string') {
    text = raw.trim();
  } else {
    try {
      text = JSON.stringify(raw) ?? '';
    } catch {
      text = String(raw);
    }
    if (text === '[]' || text === '{}') text = '';
  }
  if (!text) return undefined;
  return text.length > RESIDUAL_CLIP ? `${text.slice(0, RESIDUAL_CLIP)}…` : text;
}
