/**
 * 统一错误码（INTERFACES.md §2.6）
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
  | 'EXECUTION_FAILED';

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
