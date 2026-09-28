/**
 * @winvm/core —— 宿主机 Agent 插件核心功能模块（L1a）
 *
 * 内含：传输抽象 / 能力注册表 / 策略引擎 / 哈希链审计 / 会话保活 / 桥接 SPI 加载器 / 配置 / 日志
 * 依赖铁律：仅依赖 @winvm/contracts，禁止依赖任何 framework 或 adapter。
 */

/* ------------------------------ 传输 ------------------------------ */
export {
  establishTransport,
  HttpJsonRpcChannel,
  StdioJsonRpcChannel,
  establishSshTunnel,
  renderSshCommand,
  parseSseChunk,
  TransportError,
} from './transport/index.js';
export type {
  JsonRpcChannel,
  TransportHandle,
  ManagedTransport,
  EstablishOptions,
} from './transport/index.js';
export type { TunnelHandle, EstablishTunnelOptions } from './transport/ssh-tunnel.js';
export type { HttpChannelOptions } from './transport/http-channel.js';
export type { StdioChannelOptions } from './transport/stdio-channel.js';

/* ------------------------------ 能力注册表 ------------------------------ */
export { CapabilityRegistry, DuplicateCapabilityError } from './registry/capability-registry.js';

/* ------------------------------ 策略引擎 ------------------------------ */
export { CorePolicyEngine, globToRegex, collectStringValues, looksLikePath, looksLikeRegistryPath, normalizePath, normalizeRegistryPath } from './policy/engine.js';
export type { EvaluateInput, PolicyEngineOptions, StringValue } from './policy/engine.js';
export { DEFAULT_POLICY, mergePolicy } from './policy/defaults.js';
export type { PolicyConfig } from './policy/defaults.js';

/* ------------------------------ 审计 ------------------------------ */
export {
  HashChainAuditSink,
  canonicalJson,
  sha256,
  computeRecordHash,
  redact,
} from './audit/chain.js';
export type { AuditChainOptions, ChainVerification, AppendAuditInput } from './audit/chain.js';

/* ------------------------------ 会话 ------------------------------ */
export {
  SessionMonitor,
  UnavailableSessionProbe,
  guiAllowed,
  nonGuiAllowed,
  describeSessionState,
} from './session/health.js';
export type { SessionProbe, SessionMonitorOptions } from './session/health.js';

/* ------------------------------ 桥接 ------------------------------ */
export {
  loadProvider,
  registerProviderFactory,
  unregisterProviderFactory,
  listRegisteredFactoryIds,
  ProviderLoadError,
} from './bridge/loader.js';
export type { AgentProviderConfig, ProviderEntry, ProviderFactory } from './bridge/loader.js';

/* ------------------------------ 配置 ------------------------------ */
export {
  DEFAULT_SERVICE_CONFIG,
  loadServiceConfig,
  validateServiceConfig,
  resolveServiceConfig,
  expandEnvPath,
} from './config/index.js';
export type {
  ServiceConfig,
  ServerConfig,
  AuditConfig,
  SessionConfig,
  SecurityConfig,
  ConfigIssues,
} from './config/index.js';

/* ------------------------------ 常量（CL-018 共享事实来源） ------------------------------ */
export * from './constants.js';

/* ------------------------------ 日志 ------------------------------ */
export {
  ConsoleLogger,
  NullLogger,
  redactSecrets,
  filterMetaByAllowlist,
  DEFAULT_LOG_META_ALLOWLIST,
  REDACTED,
} from './logger.js';
export type { LogLevel, LoggerOptions } from './logger.js';
export { FileLogger, RotatingFileSink, createFileLogger } from './file-logger.js';
export type { FileLoggerOptions, RotatingFileSinkOptions, LoggingStatus } from './file-logger.js';

/* ------------------------------ trace ------------------------------ */
import { randomUUID } from 'node:crypto';

/** 生成全链路 traceId（NFR-509） */
export function newTraceId(): string {
  return `tr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
