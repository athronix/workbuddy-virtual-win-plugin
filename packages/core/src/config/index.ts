/**
 * 服务配置（含安全默认值）
 *
 * 安全红线：
 *   - server.host 默认 127.0.0.1（VM 对外零端口暴露，NFR-510）
 *   - 绑定到非回环地址必须显式 requireLoopbackBind=false，且启动时会告警
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { TransportDecl } from '@winvm/contracts';

import type { AgentProviderConfig } from '../bridge/loader.js';
import type { PolicyConfig } from '../policy/defaults.js';
import {
  ENV_LLM_PERSISTENT,
  ENV_LLM_SESSION_ID,
  ENV_LLM_SESSION_IDLE_MS,
  ENV_LLM_SESSION_MAX_RESTARTS,
  ENV_LLM_SESSION_MAX_WS_BYTES,
  ENV_LLM_SESSION_READY_MS,
  ENV_LLM_SESSION_WARMUP_MS,
  ENV_LOG_DIR,
  ENV_LOG_LEVEL,
  ENV_LOG_MAX_BYTES,
  ENV_LOG_MAX_DAYS,
  ENV_LOG_MAX_FILES,
  LLM_SESSION_ID_DEFAULT,
  LLM_SESSION_IDLE_MS_DEFAULT,
  LLM_SESSION_MAX_RESTARTS_DEFAULT,
  LLM_SESSION_MAX_WS_BYTES_DEFAULT,
  LLM_SESSION_READY_MS_DEFAULT,
  LLM_SESSION_WARMUP_MS_DEFAULT,
  LOG_DIR_TEMPLATE,
  LOG_LEVEL_DEFAULT,
  LOG_MAX_BYTES_DEFAULT,
  LOG_MAX_DAYS_DEFAULT,
  LOG_MAX_FILES_DEFAULT,
  parseBoolean,
  parseLogLevel,
  parsePositiveInt,
  type EnvView,
  type LlmSessionConfig,
  type LoggingConfig,
} from '../constants.js';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** 对外公告地址（Agent Card 的 url）。未配置时用 http://host:port */
  readonly publicBaseUrl?: string;
}

export interface AuditConfig {
  readonly dir: string;
  readonly maxFileBytes?: number;
  readonly redactParams?: boolean;
}

export interface SessionConfig {
  readonly probeIntervalMs: number;
}

export interface SecurityConfig {
  /** bearer token 的环境变量名（HTTP 模式）。禁止明文配置。 */
  readonly tokenEnv?: string;
  /** 强制回环绑定。默认 true —— 关掉等于把 VM 服务暴露出去。 */
  readonly requireLoopbackBind: boolean;
}

export interface ServiceConfig {
  readonly server: ServerConfig;
  readonly transport: { readonly preferred: readonly TransportDecl[] };
  readonly agent: AgentProviderConfig;
  readonly policy: Partial<PolicyConfig>;
  readonly audit: AuditConfig;
  readonly session: SessionConfig;
  readonly security: SecurityConfig;
  /** CL-018 C3：服务日志落盘（含轮转/保留/级别，全部 env 可覆盖） */
  readonly logging: LoggingConfig;
  /** CL-018 C1：codebuddy 常驻会话（空闲 TTL / 就绪超时 / 重建上限） */
  readonly llmSession: LlmSessionConfig;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  server: { host: '127.0.0.1', port: 18443 },
  transport: { preferred: [] },
  agent: {
    provider: 'workbuddy-deterministic',
    providers: {
      'workbuddy-deterministic': {
        package: '@winvm/adapter-agent-workbuddy',
        options: { maxConcurrency: 4, enableLlmPlanning: false },
      },
      'workbuddy': {
        package: '@winvm/adapter-agent-workbuddy-llm',
        options: {
          runtime: 'codebuddy',
          cliPath: 'codebuddy',
          endpoint: 'http://127.0.0.1:18443/mcp',
          maxConcurrency: 2,
          outputDir: '%USERPROFILE%\\WinVMWorkspace\\out',
          // 随部署复制到 VM 的技能规范目录，作为 VM 内 Agent 的操作指引（共享根，独立于仓库 skills/）
          skillsRoot: 'C:/WinVMBridge/shared-skills',
        },
      },
    },
  },
  policy: {},
  audit: { dir: '%LOCALAPPDATA%/WinVMBridge/audit', redactParams: true },
  session: { probeIntervalMs: 15_000 },
  security: { requireLoopbackBind: true },
  // CL-018 C3：日志落盘。目录保持 `%LOCALAPPDATA%` 模板（在 resolveServiceConfig 展开），
  // 使 DEFAULT_SERVICE_CONFIG 在不同环境下保持确定性、且不产生副作用。
  logging: {
    dir: LOG_DIR_TEMPLATE,
    level: LOG_LEVEL_DEFAULT,
    maxBytes: LOG_MAX_BYTES_DEFAULT,
    maxFiles: LOG_MAX_FILES_DEFAULT,
    maxDays: LOG_MAX_DAYS_DEFAULT,
  },
  // CL-018 C1：常驻会话默认（真机实测冷启动 16–25s，就绪上限放宽见 constants.ts 注释）
  llmSession: {
    enabled: true,
    sessionId: LLM_SESSION_ID_DEFAULT,
    idleTtlMs: LLM_SESSION_IDLE_MS_DEFAULT,
    readyTimeoutMs: LLM_SESSION_READY_MS_DEFAULT,
    maxRestarts: LLM_SESSION_MAX_RESTARTS_DEFAULT,
    maxWsBytes: LLM_SESSION_MAX_WS_BYTES_DEFAULT,
    warmupReadyMs: LLM_SESSION_WARMUP_MS_DEFAULT,
  },
};

/** 展开 Windows 环境变量占位符（%LOCALAPPDATA% 等），非 Windows 原样返回 */
export function expandEnvPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => env[name] ?? m);
}

export function resolveServiceConfig(cfg: ServiceConfig, env: EnvView = process.env): ServiceConfig {
  return {
    ...cfg,
    audit: { ...cfg.audit, dir: isAbsolute(cfg.audit.dir) ? cfg.audit.dir : resolve(expandEnvPath(cfg.audit.dir)) },
    logging: resolveLogging(cfg.logging, env),
    llmSession: resolveLlmSession(cfg.llmSession, env),
  };
}

/**
 * 日志配置的 env 覆盖（CL-018 C3）。
 *
 * 优先级：**env（显式设置时）> 配置文件 > 内置默认**。
 * 关键点：env **未设置**时必须保留配置文件里显式写的值 —— 不能拿「默认值」去盖掉它。
 */
function resolveLogging(cfg: LoggingConfig, env: EnvView): LoggingConfig {
  const dirRaw = env[ENV_LOG_DIR]?.trim();
  const dir = dirRaw ? dirRaw : cfg.dir;
  return {
    dir: isAbsolute(dir) ? dir : resolve(expandEnvPath(dir, env as NodeJS.ProcessEnv)),
    level: env[ENV_LOG_LEVEL] ? parseLogLevel(env[ENV_LOG_LEVEL], cfg.level) : cfg.level,
    maxBytes: env[ENV_LOG_MAX_BYTES] ? parsePositiveInt(env[ENV_LOG_MAX_BYTES], cfg.maxBytes) : cfg.maxBytes,
    maxFiles: env[ENV_LOG_MAX_FILES] ? parsePositiveInt(env[ENV_LOG_MAX_FILES], cfg.maxFiles) : cfg.maxFiles,
    maxDays: env[ENV_LOG_MAX_DAYS] ? parsePositiveInt(env[ENV_LOG_MAX_DAYS], cfg.maxDays) : cfg.maxDays,
  };
}

/** 常驻会话配置的 env 覆盖（CL-018 C1）。优先级同 resolveLogging。 */
function resolveLlmSession(cfg: LlmSessionConfig, env: EnvView): LlmSessionConfig {
  const sessionIdRaw = env[ENV_LLM_SESSION_ID]?.trim();
  return {
    enabled: env[ENV_LLM_PERSISTENT] !== undefined && env[ENV_LLM_PERSISTENT] !== ''
      ? parseBoolean(env[ENV_LLM_PERSISTENT], cfg.enabled)
      : cfg.enabled,
    sessionId: sessionIdRaw ? sessionIdRaw : cfg.sessionId,
    idleTtlMs: env[ENV_LLM_SESSION_IDLE_MS] ? parsePositiveInt(env[ENV_LLM_SESSION_IDLE_MS], cfg.idleTtlMs) : cfg.idleTtlMs,
    readyTimeoutMs: env[ENV_LLM_SESSION_READY_MS]
      ? parsePositiveInt(env[ENV_LLM_SESSION_READY_MS], cfg.readyTimeoutMs)
      : cfg.readyTimeoutMs,
    maxRestarts: env[ENV_LLM_SESSION_MAX_RESTARTS]
      ? parsePositiveInt(env[ENV_LLM_SESSION_MAX_RESTARTS], cfg.maxRestarts)
      : cfg.maxRestarts,
    maxWsBytes: env[ENV_LLM_SESSION_MAX_WS_BYTES]
      ? parsePositiveInt(env[ENV_LLM_SESSION_MAX_WS_BYTES], cfg.maxWsBytes)
      : cfg.maxWsBytes,
    warmupReadyMs: env[ENV_LLM_SESSION_WARMUP_MS]
      ? parsePositiveInt(env[ENV_LLM_SESSION_WARMUP_MS], cfg.warmupReadyMs)
      : cfg.warmupReadyMs,
  };
}

export interface ConfigIssues {
  errors: string[];
  warnings: string[];
}

/** 配置安全校验。errors 必须阻断启动；warnings 需显式提示。 */
export function validateServiceConfig(cfg: ServiceConfig): ConfigIssues {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (cfg.security.requireLoopbackBind && !isLoopback(cfg.server.host)) {
    errors.push(
      `server.host="${cfg.server.host}" 不是回环地址，而 security.requireLoopbackBind=true。` +
        `这会违反"VM 对外零端口暴露"（NFR-510）。请改回 127.0.0.1，或显式关闭该开关并自行承担风险。`,
    );
  }
  if (!cfg.security.requireLoopbackBind && !isLoopback(cfg.server.host)) {
    warnings.push(
      `server.host="${cfg.server.host}" 为非回环地址，服务将对外可达。` +
        `必须同时启用 TLS 与鉴权，且不得暴露到公网。`,
    );
  }
  if (!cfg.agent.providers[cfg.agent.provider]) {
    errors.push(
      `agent.provider="${cfg.agent.provider}" 未在 agent.providers 中定义。` +
        `可用：${Object.keys(cfg.agent.providers).join(', ') || '(空)'}`,
    );
  }
  if (cfg.server.port < 1 || cfg.server.port > 65535) {
    errors.push(`server.port 非法：${cfg.server.port}`);
  }
  if (cfg.session.probeIntervalMs < 1000) {
    warnings.push(`session.probeIntervalMs=${cfg.session.probeIntervalMs} 过小，建议 ≥5000`);
  }

  return { errors, warnings };
}

/** 从 JSON 文件加载并与默认配置合并（浅合并 + 关键段深合并） */
export async function loadServiceConfig(path: string): Promise<ServiceConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ServiceConfig>;
  return {
    server: { ...DEFAULT_SERVICE_CONFIG.server, ...(parsed.server ?? {}) },
    transport: { preferred: parsed.transport?.preferred ?? [] },
    agent: {
      provider: parsed.agent?.provider ?? DEFAULT_SERVICE_CONFIG.agent.provider,
      providers: { ...DEFAULT_SERVICE_CONFIG.agent.providers, ...(parsed.agent?.providers ?? {}) },
    },
    policy: parsed.policy ?? {},
    audit: { ...DEFAULT_SERVICE_CONFIG.audit, ...(parsed.audit ?? {}) },
    session: { ...DEFAULT_SERVICE_CONFIG.session, ...(parsed.session ?? {}) },
    security: { ...DEFAULT_SERVICE_CONFIG.security, ...(parsed.security ?? {}) },
    logging: { ...DEFAULT_SERVICE_CONFIG.logging, ...(parsed.logging ?? {}) },
    llmSession: { ...DEFAULT_SERVICE_CONFIG.llmSession, ...(parsed.llmSession ?? {}) },
  };
}
