/**
 * 服务配置（含安全默认值）
 *
 * 安全红线：
 *   - server.host 默认 127.0.0.1（VM 对外零端口暴露，NFR-510）
 *   - 非回环绑定 = **恒定 error**（ARCH-07 B 基线：V1 服务端只允许回环绑定，
 *     `requireLoopbackBind` 自 Phase 1 起**不再能放宽**，置 false 只会得到一条 warning）
 *   - 服务端身份鉴权是可选项：`enforceBearer`（默认 false）+ `tokenEnv` 有值 ⇒ 双条件才生效
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { TransportDecl } from '@winvm/contracts';

import type { AgentProviderConfig } from '../bridge/loader.js';
import type { PolicyConfig } from '../policy/defaults.js';
import {
  expandEnvPath,
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
  /**
   * bearer token 的**环境变量名**（禁止明文配置，NFR-511）。默认约定 `WINVM_BEARER_TOKEN`。
   *
   * ARCH-07 / ENG-23 后的真实语义（旧事实：全仓唯一读取点只是回环检查的文案，值从未被消费）：
   * - 服务端：与 `enforceBearer` **双条件**共同决定是否挂 bearer 守卫（§4 O-9，与 dry-run
   *   bypass 双条件同构，防「以为开了」）；
   * - 客户端：`streamable-http` 与 `ssh-tunnel` 两条远程传输分支经同一个 `applyBearerHeader`
   *   消费同名变量（T2 落地）；有名无值 ⇒ **fail-loud 抛错**，不静默降级成裸请求。
   */
  readonly tokenEnv?: string;
  /**
   * ARCH-07（B 基线，**刻意破坏性收紧**）：本字段自 Phase 1 起**不再能放宽**。
   *
   * V1 服务端只允许回环绑定：`validateServiceConfig` 里「非回环」已升级为**恒定 error**
   * （不看本字段取值），把 `requireLoopbackBind:false` 也判为配置无效并给出 warning。
   * 字段本身**保留**（不删）—— 删除会打断 `delivery/vm-service.config.json:59` 与既有文档，
   * 破坏性更大（设计 §1.4-1 择一 ①）；旧配置仍可解析、不会因解析失败而启动不了。
   *
   * 为什么要收紧：过去安全推理的公理是**部署形态**（「仅回环 + SSH 隧道」），而代码不保证它
   * （审计 D-10 / ARCH-07）。把回环约束变成代码不变量后，「配置漂移导致裸 HTTP 对外可达」
   * 这一更大的风险被关掉；服务端身份鉴权（bearer）另由 `enforceBearer` 作为可选加固承接。
   */
  readonly requireLoopbackBind: boolean;
  /**
   * ARCH-07 A 形态（**纯附加可选，默认 false**）：是否对非豁免端点强制校验 bearer。
   *
   * `false`（默认）⇒ 现网行为逐字节不变，信任边界由「回环绑定 + SSH 隧道 + 审批闸」承担，
   * 服务端**不承担身份鉴权**（SECURITY-GOVERNANCE §2 已如实声明；把「文档说有防护、
   * 实际裸奔」的旧承诺诚实化，本身就是修复）。
   *
   * `true` ⇒ 生效还**必须**满足第二条件 `process.env[tokenEnv]` 非空（双条件同构 O-9）；
   * 生效后端点校验 `authorization: Bearer <token>`，用 `crypto.timingSafeEqual` 常时比较
   * （长度不等先拒），豁免清单 = `GET /health` 与 `GET /.well-known/agent-card.json`，
   * `/admin/llm-session/reset` **不豁免**（它有能力效果）。失败响应
   * `401 { error:'unauthorized', code:'AUTH_REQUIRED' }`，不入审计链（HTTP 层属传输事实）。
   *
   * ⚠ 开启动作的前置条件（R4，必须在文档写黑）：VM 内 codebuddy 回连 `/mcp?dtid=` 的
   * mcpServers 条目**目前不含凭据**（`adapter-agent-workbuddy-llm/src/bridge.ts` 的
   * `buildMcpConfig`）⇒ 直接开 `enforceBearer` 会让 VM 内回连全 401。B3 真机实测（2026-10-10）
   * 订正失败形态：401 打在工具面 ⇒ 委派不当场失败，而是退化为零副作用虚假完成
   * （`completed` + 链上 `zeroInnerCalls:true`，CL-K3R 真值层不予采信兜住）；宿主不带凭据段则当场 401。
   * 回连凭据分发通路属部署契约（设计 §5 第 3 条：本批不实现）。
   */
  readonly enforceBearer?: boolean;
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

/**
 * `expandEnvPath` 自 Phase 1 T2 下沉到 `constants.ts`（策略引擎模式侧也要走同一条
 * 展开通路，见该处的说明）。此处**只做再导出**，既有调用点与 `core/src/index.ts`
 * 的导出名保持不变。
 */
export { expandEnvPath };

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
    dir: isAbsolute(dir) ? dir : resolve(expandEnvPath(dir, env)),
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

/**
 * 配置安全校验。errors 必须阻断启动；warnings 需显式提示。
 *
 * @param cfg 待校验配置
 * @param env 环境变量视图（默认 `process.env`）。ARCH-07 起需要读 env 才能判定
 *   「tokenEnv 有名无值」这类**生效事实**，故把它做成可注入的第二个参数（**附加可选** ⇒
 *   既有单参调用点逐字不变，`vm-service/server.ts:337` 无须改）。
 */
export function validateServiceConfig(cfg: ServiceConfig, env: EnvView = process.env): ConfigIssues {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ARCH-07（B 基线）**不可关**：非回环 ⇒ 恒定 error，**不再看** `requireLoopbackBind` 取值。
  // 为什么从「可关的开关」升级为「代码不变量」：V1 的服务端不做身份鉴权（见下 tokenEnv 注释），
  // 整套安全推理的公理是「仅回环 + SSH 隧道」；只要这个公理能被一个配置项静默放宽，
  // 得到的是「文档说有防护、实际裸 HTTP 零鉴权」的服务（审计 ARCH-07 / D-10）。
  // 语义单调（更严），旧配置文件仍可解析：默认值为 true 的部署零变化。
  if (!isLoopback(cfg.server.host)) {
    errors.push(
      `server.host="${cfg.server.host}" 不是回环地址，违反「V1 服务端只允许回环绑定」这条代码不变量` +
        `（NFR-510：VM 对外零端口暴露）。请把 server.host 改回 127.0.0.1，` +
        `外部访问一律经 SSH 隧道映射到本机回环；security.requireLoopbackBind=false 不能放宽本约束。`,
    );
  }
  if (cfg.security.requireLoopbackBind === false) {
    warnings.push(
      `security.requireLoopbackBind=false 已失效：该开关自 Phase 1 起不再能放宽回环约束` +
        `（非回环绑定一律按 error 阻断启动）。字段保留只为兼容既有配置文件，建议删除本项或改回 true。`,
    );
  }

  // ENG-05：tokenEnv「有名无值」必须显形 —— 否则运维以为鉴权开了，实际任何请求都不带凭据。
  const tokenEnvName = cfg.security.tokenEnv?.trim();
  const tokenValue = tokenEnvName ? env[tokenEnvName]?.trim() : undefined;
  if (tokenEnvName && !tokenValue) {
    warnings.push(
      `security.tokenEnv="${tokenEnvName}" 已配置，但环境变量 ${tokenEnvName} 无值 ⇒ bearer 鉴权不会生效` +
        `（服务端守卫需「enforceBearer===true 且 tokenEnv 有值」双条件；客户端发请求时同样会 fail-loud 抛错）。` +
        `未开 enforceBearer 时信任边界仍由「回环 + SSH 隧道 + 审批闸」承担（SECURITY-GOVERNANCE §2），这是设计选择而非故障。`,
    );
  }
  if (cfg.security.enforceBearer === true && !tokenEnvName) {
    warnings.push(
      `security.enforceBearer=true 但未配置 security.tokenEnv ⇒ 无 token 可比对，守卫不会生效` +
        `（/health.security.authMode 将报 "loopback-only"，而非 "bearer-enforced"）。请补 tokenEnv 或关掉 enforceBearer。`,
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
