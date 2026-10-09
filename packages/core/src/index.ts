/**
 * @winvm/core —— 宿主机 Agent 插件核心功能模块（L1a）
 *
 * 内含：传输抽象 / 能力注册表 / 策略引擎 / 哈希链审计 / 会话保活 / 桥接 SPI 加载器 / 配置 / 日志
 * 依赖铁律：仅依赖 @winvm/contracts，禁止依赖任何 framework 或 adapter。
 */

/* ------------------------------ 传输 ------------------------------ */
export {
  establishTransport,
  applyBearerHeader,
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
export { CorePolicyEngine, globToRegex, collectStringValues, looksLikePath, looksLikeRegistryPath, normalizePath, normalizeRegistryPath, expandPolicyPathPattern } from './policy/engine.js';
// U-P0-3（A1）：dry-run 免批放行规则的哨兵值（引擎产出、服务端审计装饰器与单测共用同一常量，
// 拼写漂移不得静默使免批执行失去链上证据）。
export { DRY_RUN_BYPASS_MATCHED_RULE } from './policy/engine.js';
// R19-B · S-1（契约 docs/design/r19b-s1-kn2-contract.md）：归一/匹配/形态提示为策略层唯一权威，
// 导出供 vm-capabilities 侧复用与单测断言（不得在 psmod / 其他层再实现第二份归一）。
export { canonicalRegistryPath, matchRegistryAllowlist, describeRegistryForms, extractPathTokens } from './policy/engine.js';
// R19-B · S-5（docs/design/s5-registry-write-allowlist-pairing.md §③(a)/§④-1）：写动词判定
// 是 4b 选读表/写表的唯一依据，导出供单测逐能力比对与静态守卫（不得在别处再实现一份）。
export { isWriteCapability } from './policy/engine.js';
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
  ARCHIVE_VERIFY_MAX_SHARDS,
} from './audit/chain.js';
// ARCH-06 A2 / D-4：`ArchiveVerification` 的**权威定义在 contracts（L0）**，此处只做再导出
// （`AuditSink.verifyArchive?()` 的返回类型属 L0 契约面，不得引用 L1a 类型；core 复制同形
// 结构会造成两份定义漂移）。消费方按既有 `from '@winvm/core'` 取名即可。
export type { AuditChainOptions, ChainVerification, AppendAuditInput } from './audit/chain.js';
export type { ArchiveVerification } from '@winvm/contracts';

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
