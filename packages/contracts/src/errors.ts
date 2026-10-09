/**
 * 统一错误码（INTERFACES.md §2.6）
 */

/**
 * 契约层对外错误码（封闭集）。
 *
 * ARCH-18/Phase 1 增量登记：`TASK_CANCELED`（ARCH-22 协作式取消的收口码）。
 * 它不是 PS 领域码（不进 `DOMAIN_CODE_TO_BASE` 映射、不经 `normalizedError` 压平），
 * 而是**执行体主动退出**时的契约结论，与 `TIMEOUT` / `APPROVAL_REQUIRED` 同级。
 *
 * 明确**不**加入本枚举的约定串：`'AUTH_REQUIRED'`（ARCH-07 HTTP 守卫）—— 它只出现在
 * HTTP 层 JSON 响应体里（`{ error:'unauthorized', code:'AUTH_REQUIRED' }`），
 * 不进 `BridgeError`，因为 401 属传输层事实、不携带能力执行语义（§8 错误码风格）。
 */
export type BridgeErrorCode =
  | 'INVALID_PARAMS'
  | 'UNKNOWN_CAPABILITY'
  | 'UNSUPPORTED_GOAL'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'SESSION_UNAVAILABLE'
  | 'SESSION_BLACK_SCREEN'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'EXECUTION_FAILED'
  /**
   * ARCH-22（**纯附加枚举成员**）：任务被取消，执行体在某个能力边界协作式退出。
   *
   * 为什么必须进契约码：`GoalResult.error.code` 是宿主与服务端（链上 `errorCode`）唯一
   * 可读的收口依据。旧实现下取消会折叠成 `EXECUTION_FAILED`（甚至 `ok:true`），
   * 使「谁停的、停在哪」不可证。新增本成员后，provider 用既有 `makeError('TASK_CANCELED', …)`
   * 即可表达，`BridgeError` 的**形状**（字段集）不变。
   * 未实现取消的新字段（`isCancelled` / `cancellationSignal`）的第三方 provider 不会用到它 ⇒ 无感。
   */
  | 'TASK_CANCELED';

export interface BridgeError {
  readonly code: BridgeErrorCode;
  readonly message: string;
  /**
   * 领域层「原因码」（CL-017 D23）。
   *
   * `code` 是**契约层封闭 10 码**（决定是否重试 / 是否需要审批）；`reason` 是**领域层原因码**
   * （如 PS 侧 `FILE_NOT_FOUND` / `CLI_NOT_FOUND` / `SERVICE_NOT_FOUND`），供调用方按原因选择
   * **具体补救动作**（修路径 / 先装应用 / 校验名称 / 调大超时）。
   *
   * 纯增量可选字段：契约层 10 码与 `DEFAULT_RETRYABLE` 语义**保持不变**。
   */
  readonly reason?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

/** 各错误码的默认可重试语义 */
const DEFAULT_RETRYABLE: Record<BridgeErrorCode, boolean> = {
  INVALID_PARAMS: false,
  UNKNOWN_CAPABILITY: false,
  UNSUPPORTED_GOAL: false,
  POLICY_DENIED: false,
  APPROVAL_REQUIRED: true,
  SESSION_UNAVAILABLE: true,
  SESSION_BLACK_SCREEN: true,
  PROVIDER_UNAVAILABLE: true,
  TIMEOUT: true,
  EXECUTION_FAILED: false,
  // ARCH-22：取消是**用户/宿主意志**的结果，不是可恢复的故障。自动重试等于把已被叫停的
  // 操作再跑一遍（最危险的一类静默行为），故 false。调用方若确需重跑，必须重新发起委派
  // （重新过审批闸），而不是对同一任务 retry。既有 10 码的取值逐字不变。
  TASK_CANCELED: false,
};

export function makeError(
  code: BridgeErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; retryable?: boolean; reason?: string },
): BridgeError {
  return {
    code,
    message,
    // reason 为纯增量：仅在显式提供时写入，保证既有调用方（不传 reason）行为完全不变
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
    ...(options?.details !== undefined ? { details: options.details } : {}),
    retryable: options?.retryable ?? DEFAULT_RETRYABLE[code],
  };
}

export function isBridgeError(value: unknown): value is BridgeError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['code'] === 'string' && typeof v['message'] === 'string';
}

/** 把任意异常规范化为 BridgeError，避免内部堆栈泄漏给调用方 */
export function normalizeError(err: unknown): BridgeError {
  if (isBridgeError(err)) return err;
  if (err instanceof Error) {
    return makeError('EXECUTION_FAILED', err.message);
  }
  return makeError('EXECUTION_FAILED', String(err));
}
