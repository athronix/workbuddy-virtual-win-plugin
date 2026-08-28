/**
 * A2A v1.0 类型（Linux Foundation 治理）
 *
 * ⚠️ 版本对齐要点（易错点）：
 *   - v1.0 方法名：`message/send` / `message/stream` / `tasks/get` / `tasks/list`
 *                 `tasks/cancel` / `tasks/subscribe` / `agent/getAuthenticatedExtendedCard`
 *   - 已废弃旧名：`tasks/send`（→ message/send）、`tasks/sendSubscribe`（→ message/stream）
 *   - 接口声明用 `supportedInterfaces[]`（旧字段 preferredTransport / additionalInterfaces 已废弃）
 *   - 版本协商走 `A2A-Version` 请求头
 */

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_VERSION_HEADER = 'A2A-Version';

/* ------------------------------ Parts ------------------------------ */

export interface TextPart {
  readonly kind: 'text';
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FilePart {
  readonly kind: 'file';
  readonly file: {
    readonly name?: string;
    readonly mimeType?: string;
    /** base64 内联 */
    readonly bytes?: string;
    /** 或外部 URI */
    readonly uri?: string;
  };
  readonly metadata?: Record<string, unknown>;
}

export interface DataPart {
  readonly kind: 'data';
  readonly data: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

/* ------------------------------ Messages ------------------------------ */

export interface Message {
  readonly kind: 'message';
  readonly role: 'user' | 'agent';
  readonly messageId: string;
  readonly parts: readonly Part[];
  readonly contextId?: string;
  readonly taskId?: string;
  readonly metadata?: Record<string, unknown>;
}

/* ------------------------------ Artifacts ------------------------------ */

export interface Artifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly Part[];
  readonly metadata?: Record<string, unknown>;
}

/* ------------------------------ Task ------------------------------ */

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export interface TaskStatus {
  readonly state: TaskState;
  readonly message?: Message;
  readonly timestamp?: string;
}

export interface Task {
  readonly kind: 'task';
  readonly id: string;
  readonly contextId: string;
  readonly status: TaskStatus;
  readonly artifacts?: readonly Artifact[];
  readonly history?: readonly Message[];
  readonly metadata?: Record<string, unknown>;
}

/* ------------------------------ Streaming events ------------------------------ */

export interface TaskStatusUpdateEvent {
  readonly kind: 'status-update';
  readonly taskId: string;
  readonly contextId: string;
  readonly status: TaskStatus;
  /** 是否为该流的最后一个事件 */
  readonly final: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  readonly kind: 'artifact-update';
  readonly taskId: string;
  readonly contextId: string;
  readonly artifact: Artifact;
  readonly append?: boolean;
  readonly lastChunk?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export type A2AStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/* ------------------------------ Agent Card ------------------------------ */

export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
  readonly examples?: readonly string[];
}

export interface AgentInterface {
  readonly url: string;
  readonly protocolBinding: 'JSONRPC' | 'GRPC' | 'HTTP+JSON';
  readonly protocolVersion: string;
  readonly tenant?: string;
}

export interface AgentCapabilities {
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
  readonly stateTransitionHistory?: boolean;
}

export interface AgentCard {
  readonly protocolVersion: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly url: string;
  readonly provider?: { readonly organization: string; readonly url?: string };
  readonly iconUrl?: string;
  readonly capabilities: AgentCapabilities;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  /** v1.0：声明各协议绑定及其版本号 */
  readonly supportedInterfaces: readonly AgentInterface[];
  readonly skills: readonly AgentSkill[];
  readonly securitySchemes?: Readonly<Record<string, Record<string, unknown>>>;
  readonly security?: readonly Record<string, string[]>[];
  /** v1.0 签名卡（JWS / Ed25519 / RFC 8785 JCS）；未签名时省略 */
  readonly signature?: string;
}

/* ------------------------------ JSON-RPC ------------------------------ */

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** JSON-RPC 标准错误码 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** A2A 语义错误码（映射到 JSON-RPC error.data 中的 code 字符串） */
export const A2A_ERROR_CODES = {
  TASK_NOT_FOUND: 'TaskNotFoundError',
  TASK_NOT_CANCELABLE: 'TaskNotCancelableError',
  UNSUPPORTED_OPERATION: 'UnsupportedOperationError',
  CONTENT_TYPE_NOT_SUPPORTED: 'ContentTypeNotSupportedError',
  VERSION_NOT_SUPPORTED: 'VersionNotSupportedError',
  INVALID_AGENT_RESPONSE: 'InvalidAgentResponseError',
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED: 'AuthenticatedExtendedCardNotConfiguredError',
  PUSH_NOTIFICATION_NOT_SUPPORTED: 'PushNotificationNotSupportedError',
  INVALID_PARAMS: 'InvalidParamsError',
} as const;

/** v1.0 支持的方法名 */
export const A2A_METHODS = [
  'message/send',
  'message/stream',
  'tasks/get',
  'tasks/list',
  'tasks/cancel',
  'tasks/subscribe',
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'agent/getAuthenticatedExtendedCard',
] as const;

export type A2AMethod = (typeof A2A_METHODS)[number];

/** 已废弃的 v0.x 方法名 —— 收到时返回 MethodNotFound，不做静默兼容 */
export const A2A_DEPRECATED_METHODS = ['tasks/send', 'tasks/sendSubscribe'] as const;

/* ------------------------------ 请求参数 ------------------------------ */

export interface SendMessageParams {
  readonly message: Message;
  readonly configuration?: {
    readonly blocking?: boolean;
    readonly historyLength?: number;
    readonly acceptedOutputModes?: readonly string[];
  };
  readonly metadata?: Record<string, unknown>;
}

export interface GetTaskParams {
  readonly name?: string; // tasks/{task_id}
  readonly id?: string;
  readonly historyLength?: number;
  readonly tenant?: string;
}

export interface CancelTaskParams {
  readonly name?: string;
  readonly id?: string;
  readonly tenant?: string;
}

export interface ListTasksParams {
  readonly contextId?: string;
  readonly status?: TaskState;
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly historyLength?: number;
  readonly includeArtifacts?: boolean;
  readonly tenant?: string;
}
