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
};

/** 展开 Windows 环境变量占位符（%LOCALAPPDATA% 等），非 Windows 原样返回 */
export function expandEnvPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => env[name] ?? m);
}

export function resolveServiceConfig(cfg: ServiceConfig): ServiceConfig {
  return {
    ...cfg,
    audit: { ...cfg.audit, dir: isAbsolute(cfg.audit.dir) ? cfg.audit.dir : resolve(expandEnvPath(cfg.audit.dir)) },
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
  };
}
