/**
 * CL-018 共享常量与 env 解析 —— 跨文件/跨层的**单一事实来源**。
 *
 * 为什么单独成模块：C1/C2/C3/C5 的默认值与 env 名被 TS（core / adapter / vm-service /
 * host-a2a-bridge / delivery）与 PowerShell（psmod）共用。散落各处必然漂移，
 * 故集中于此；psmod 侧因语言隔离只能硬编码同名 env（由单测静态扫描锁定一致性）。
 *
 * 纪律：
 *   - 所有 env 读取**只在此处**做解析与回退，其它模块不得自行 `Number(process.env[...])`；
 *   - 非法值（NaN / ≤0 / 未知枚举）一律**回退默认**而不是抛错 —— 服务启动不得因一个坏 env 失败。
 */

import type { LogLevelName } from '@winvm/contracts';

/** env 视图（便于测试注入） */
export type EnvView = Record<string, string | undefined>;

/* ================================ 通用解析 ================================ */

/** 解析正整数 env；非法（NaN / ≤0 / 非整数）→ 回退默认 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 解析布尔 env：`1/true/yes/on` → true；`0/false/no/off` → false；其余 → 回退默认 */
export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

const LOG_LEVELS: readonly LogLevelName[] = ['debug', 'info', 'warn', 'error', 'silent'];

/** 解析日志级别 env；未知取值 → 回退默认 */
export function parseLogLevel(raw: string | undefined, fallback: LogLevelName = 'info'): LogLevelName {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevelName) : fallback;
}

/* ============================ C3 · 服务日志落盘 ============================ */

/** 默认日志目录（`%LOCALAPPDATA%` 占位符由 config 层展开；服务以交互用户运行） */
export const LOG_DIR_TEMPLATE = '%LOCALAPPDATA%/WinVMBridge/logs';
/** 日志文件前缀（完整名 `winvm-service-YYYY-MM-DD.log`） */
export const LOG_FILE_PREFIX = 'winvm-service';
/** 单文件上限：10MB（超限即轮转） */
export const LOG_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
/** 最多保留 7 个日志文件（超限删最旧） */
export const LOG_MAX_FILES_DEFAULT = 7;
/** 最多保留 14 天（超限删最旧） */
export const LOG_MAX_DAYS_DEFAULT = 14;
/** 默认级别（info） */
export const LOG_LEVEL_DEFAULT: LogLevelName = 'info';

export const ENV_LOG_DIR = 'WINVM_LOG_DIR';
export const ENV_LOG_LEVEL = 'WINVM_LOG_LEVEL';
export const ENV_LOG_MAX_BYTES = 'WINVM_LOG_MAX_BYTES';
export const ENV_LOG_MAX_FILES = 'WINVM_LOG_MAX_FILES';
export const ENV_LOG_MAX_DAYS = 'WINVM_LOG_MAX_DAYS';

/** 日志落盘解析结果（`dir` 仍可能是含 `%ENV%` 的模板，由 config 层展开） */
export interface LoggingConfig {
  readonly dir: string;
  readonly level: LogLevelName;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxDays: number;
}

export function resolveLoggingConfig(env: EnvView = process.env): LoggingConfig {
  return {
    dir: env[ENV_LOG_DIR] && env[ENV_LOG_DIR]!.trim() ? env[ENV_LOG_DIR]!.trim() : LOG_DIR_TEMPLATE,
    level: parseLogLevel(env[ENV_LOG_LEVEL], LOG_LEVEL_DEFAULT),
    maxBytes: parsePositiveInt(env[ENV_LOG_MAX_BYTES], LOG_MAX_BYTES_DEFAULT),
    maxFiles: parsePositiveInt(env[ENV_LOG_MAX_FILES], LOG_MAX_FILES_DEFAULT),
    maxDays: parsePositiveInt(env[ENV_LOG_MAX_DAYS], LOG_MAX_DAYS_DEFAULT),
  };
}

/* ========================== C1 · LLM 常驻会话 ========================== */

/** 是否启用常驻会话（默认启用；置 0 可强制走单次 `-p`，用于排障/回滚） */
export const ENV_LLM_PERSISTENT = 'WINVM_LLM_PERSISTENT';
/** 固定会话标识（AC1.4：多次委派复用同一 session） */
export const ENV_LLM_SESSION_ID = 'WINVM_LLM_SESSION_ID';
export const LLM_SESSION_ID_DEFAULT = 'winvm-persistent';
/** 空闲 TTL：到期释放常驻子进程，下次委派重建 */
export const ENV_LLM_SESSION_IDLE_MS = 'WINVM_LLM_SESSION_IDLE_MS';
export const LLM_SESSION_IDLE_MS_DEFAULT = 300_000;
/**
 * 就绪（首个 `system/init`）等待上限。
 *
 * ⚠ 与设计文档的「30s」不同：架构师真机实测冷启动 16–25s（并存在 36s 离群），
 *   30s 会把「正常慢启动」误判为不可用而**降级到单次 `-p`（又一次全额冷启动）**，
 *   与 AC1.2/AC1.5 目标相悖。故放宽到 60s（仍远小于宿主 600s 委派预算）。
 */
export const ENV_LLM_SESSION_READY_MS = 'WINVM_LLM_SESSION_READY_MS';
export const LLM_SESSION_READY_MS_DEFAULT = 60_000;
/** 累计重建上限：超限置 disabled（此后恒定回退单次 `-p`，不再尝试常驻） */
export const ENV_LLM_SESSION_MAX_RESTARTS = 'WINVM_LLM_SESSION_MAX_RESTARTS';
export const LLM_SESSION_MAX_RESTARTS_DEFAULT = 5;
/** 常驻子进程工作集上限（超限回收重建） */
export const ENV_LLM_SESSION_MAX_WS_BYTES = 'WINVM_LLM_SESSION_MAX_WS_BYTES';
export const LLM_SESSION_MAX_WS_BYTES_DEFAULT = 512 * 1024 * 1024;
/**
 * K2 修复（A2A 冷启动停滞）：启动期预热 init 等待上限。
 *
 * 与 `readyTimeoutMs`（真实委派轮次的 init 上限，60s）**解耦**——预热在启动期 fire-and-forget，
 * 允许更宽松的等待（默认 180s）以覆盖 codebuddy 进程级冷启动（auth probe + agent 端点 ≈75–107s），
 * 且**超时仅返回、不杀会话**（`PersistentCliSession.warmup` 专用路径），让冷机在启动期从容完成
 * init，使首个真实委派免付冷启动。运行时通过 `WINVM_LLM_SESSION_WARMUP_MS` 可调。
 */
export const ENV_LLM_SESSION_WARMUP_MS = 'WINVM_LLM_SESSION_WARMUP_MS';
export const LLM_SESSION_WARMUP_MS_DEFAULT = 180_000;

export interface LlmSessionConfig {
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly idleTtlMs: number;
  readonly readyTimeoutMs: number;
  readonly maxRestarts: number;
  readonly maxWsBytes: number;
  /** K2：启动期预热 init 等待上限（见 `ENV_LLM_SESSION_WARMUP_MS` 注释） */
  readonly warmupReadyMs: number;
}

export function resolveLlmSessionConfig(env: EnvView = process.env): LlmSessionConfig {
  return {
    enabled: parseBoolean(env[ENV_LLM_PERSISTENT], true),
    sessionId: env[ENV_LLM_SESSION_ID] && env[ENV_LLM_SESSION_ID]!.trim()
      ? env[ENV_LLM_SESSION_ID]!.trim()
      : LLM_SESSION_ID_DEFAULT,
    idleTtlMs: parsePositiveInt(env[ENV_LLM_SESSION_IDLE_MS], LLM_SESSION_IDLE_MS_DEFAULT),
    readyTimeoutMs: parsePositiveInt(env[ENV_LLM_SESSION_READY_MS], LLM_SESSION_READY_MS_DEFAULT),
    maxRestarts: parsePositiveInt(env[ENV_LLM_SESSION_MAX_RESTARTS], LLM_SESSION_MAX_RESTARTS_DEFAULT),
    maxWsBytes: parsePositiveInt(env[ENV_LLM_SESSION_MAX_WS_BYTES], LLM_SESSION_MAX_WS_BYTES_DEFAULT),
    warmupReadyMs: parsePositiveInt(env[ENV_LLM_SESSION_WARMUP_MS], LLM_SESSION_WARMUP_MS_DEFAULT),
  };
}

/* ======================== C5 · 网络配置进程内缓存 ======================== */

/** 缓存 TTL：45s（`refresh:true` 可绕过） */
export const ENV_NETCFG_TTL_MS = 'WINVM_NETCFG_TTL_MS';
export const NETCFG_TTL_MS_DEFAULT = 45_000;

export function resolveNetCfgTtlMs(env: EnvView = process.env): number {
  return parsePositiveInt(env[ENV_NETCFG_TTL_MS], NETCFG_TTL_MS_DEFAULT);
}

/** 启动预热超时（与日常调用超时解耦）：预热处于 WMI/CIM 未装载的极端冷态，真实耗时 >20s，
 *  若与日常调用同用 20s 会必然超时失败（CL-018 C5 实证 4/6 次）。预热 fire-and-forget、用户不等待，故给宽松上限。 */
export const ENV_NETCFG_PREWARM_TIMEOUT_MS = 'WINVM_NETCFG_PREWARM_TIMEOUT_MS';
export const NETCFG_PREWARM_TIMEOUT_MS_DEFAULT = 60_000;

export function resolveNetCfgPrewarmTimeoutMs(env: EnvView = process.env): number {
  return parsePositiveInt(env[ENV_NETCFG_PREWARM_TIMEOUT_MS], NETCFG_PREWARM_TIMEOUT_MS_DEFAULT);
}

/* ======================== K4/P3 · A2A 审批等待 TTL ======================== */

/**
 * 审批等待（A2A `input-required` 挂起）的默认 TTL：30 分钟。
 *
 * 为什么要 TTL（P3-3）：`TaskStore.waitApproval` 挂起后若宿主永不应答
 * （桥接连接断开、宿主 Agent 崩溃、人工离场），任务会**永久**停在 `input-required`，
 * 挂起的 runner 与宿主侧续跑令牌一起泄漏。超时按**拒绝**收口（绝不放行）：
 * 挂起 Promise resolve(false)、任务转 `failed`（原因 `approval timeout`）、
 * 清理挂起记录并通过超时回调让 vm-service 侧删除残留续跑令牌。
 *
 * 取 30 分钟：远大于人工审批的合理响应窗口，又足以让泄漏任务在一天内自然收口。
 * 经 `WINVM_APPROVAL_TTL_MS` 可调（非法值回退默认 —— 服务不得因一个坏 env 失败）。
 */
export const ENV_APPROVAL_TTL_MS = 'WINVM_APPROVAL_TTL_MS';
export const APPROVAL_TTL_MS_DEFAULT = 1_800_000;

export function resolveApprovalTtlMs(env: EnvView = process.env): number {
  return parsePositiveInt(env[ENV_APPROVAL_TTL_MS], APPROVAL_TTL_MS_DEFAULT);
}

/* ======================== K5 · 审批放行后服务端重放（灰度开关） ======================== */

/**
 * K5 灰度开关 env 名：**审批放行后由服务端确定性重放被拦截的能力调用**。
 *
 * 为什么需要开关：K5 把执行权从「LLM 是否愿意重发」收归服务端（`resolveApproval(true)` 后
 * 协调器直接用留存原参数走真实执行段）。这是执行路径的实质变更，需要一个可一键回滚的保险：
 *   - `on`（默认）：批准后服务端重放，结构化回执随决议返回，桥把真实回执注入续跑 prompt。
 *   - `off`：跳过重放，批准后仅返回 `approved:true`（`executed` 缺席）→ 桥退回 K4 提示词行为
 *     （提示 LLM 带 `__approvalId` 重发）。
 *
 * 纪律（与既有 env 一致）：解析**只在此处**做；非法值回退默认（on）；绝不抛错 ——
 * 服务启动不得因一个坏 env 失败。注意 `off` 只关闭**重放**，绝不放宽任何审批闸：
 * 未获宿主批准时依旧 `approved:false`。
 */
export const ENV_APPROVAL_REPLAY = 'WINVM_APPROVAL_REPLAY';
export const APPROVAL_REPLAY_DEFAULT = true;

/** 审批重放开关（true=服务端重放；false=退回 K4 提示词行为） */
export function resolveApprovalReplay(env: EnvView = process.env): boolean {
  return parseBoolean(env[ENV_APPROVAL_REPLAY], APPROVAL_REPLAY_DEFAULT);
}

/* ============================ tunnel-mode 通道模式 ============================
 *
 * 宿主侧「通道选择策略」的单一事实来源。插件有两条通往 VM 的通道：
 *   - MCP 直调（connector:winvm）：简单 / 单步 / 结构化任务；
 *   - A2A 委派（connector:winvm-a2a）：复杂 / 多步 / GUI / 开放意图任务。
 *
 * tunnel-mode 控制宿主 Agent 如何在两者之间选择：
 *   - `mcp`（默认）  ：只允许/建议 MCP 直调通道；
 *   - `a2a`          ：只允许/建议 A2A 委派通道；
 *   - `intelligent`  ：按任务特征智能判断（即主控 skill 的决策树）。
 *
 * 边界说明（重要）：本配置**不在代码层强制拦截**工具调用 —— 宿主 Agent 的工具调用
 * 无法在 stdio 桥层拦截另一连接器。消费入口是：
 *   1. 主控 skill 文档指引（宿主 LLM 读 skill 决定调哪个连接器）；
 *   2. CLI `winvm-plugin tunnel-mode` 的存取与展示（配置事实源，写 vm-conn.json）。
 */

/** tunnel-mode env 名（CLI `--tunnel-mode` > env > vm-conn.json 的 tunnelMode > 默认） */
export const ENV_TUNNEL_MODE = 'WINVM_TUNNEL_MODE';

/** 通道模式：mcp（MCP 直调）/ a2a（A2A 委派）/ intelligent（智能判断） */
export type TunnelMode = 'mcp' | 'a2a' | 'intelligent';

/** 全部合法模式（供 CLI 帮助 / 校验 / skill 文档引用） */
export const TUNNEL_MODES: readonly TunnelMode[] = ['mcp', 'a2a', 'intelligent'];

/** 默认模式：mcp（保守起步，透明可控） */
export const TUNNEL_MODE_DEFAULT: TunnelMode = 'mcp';

export interface TunnelModeResolution {
  readonly mode: TunnelMode;
  /** 仅当原始值非法回落默认时给出（供 CLI 打印告警） */
  readonly warning?: string;
}

/**
 * 解析 tunnel-mode 原始值：trim + 小写后匹配枚举。
 * 空 / undefined → 默认 mcp；命中枚举 → 对应值；其它 → mcp + 告警。
 * 与 delivery/winvm-plugin.mjs 内联实现保持同语义（部署缓存无 node_modules，无法跨包 import）。
 */
export function resolveTunnelMode(raw: string | undefined | null): TunnelModeResolution {
  const v = raw?.trim().toLowerCase();
  if (!v) return { mode: TUNNEL_MODE_DEFAULT };
  if ((TUNNEL_MODES as readonly string[]).includes(v)) return { mode: v as TunnelMode };
  return {
    mode: TUNNEL_MODE_DEFAULT,
    warning: `未知 tunnel-mode "${raw}"，回落 mcp（可用：${TUNNEL_MODES.join('/')}）`,
  };
}

/* ========================== C2 · A2A 委派超时 ========================== */

/** 出厂默认 600000ms（≥150s，**不得回退**）；优先级 `--timeout`(CLI) > env > 默认 */
export const ENV_A2A_TIMEOUT_MS = 'WINVM_A2A_TIMEOUT_MS';
export const A2A_TIMEOUT_MS_DEFAULT = 600_000;

export function resolveA2aTimeoutMs(env: EnvView = process.env): number {
  return parsePositiveInt(env[ENV_A2A_TIMEOUT_MS], A2A_TIMEOUT_MS_DEFAULT);
}

/* ======================= C4 · appops 过滤名单（env 名） =======================
 *
 * 名单本体在 PowerShell 侧（`packages/vm-capabilities/psmod/appops.ps1`）；
 * 此处只登记 env 名，供 TS 侧文档/部署与静态扫描测试保持与 psmod 一致。
 */

/** 追加到默认进程名黑名单（逗号/分号分隔） */
export const ENV_APPOPS_EXCLUDE_PROCS = 'WINVM_APPOPS_EXCLUDE_PROCS';
/** 追加到默认标题正则名单（逗号/分号分隔） */
export const ENV_APPOPS_EXCLUDE_TITLE_PATTERNS = 'WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS';
/** 追加到默认**进程名正则**名单（逗号/分号分隔，CL-018 R2；模式应锚定以免误杀） */
export const ENV_APPOPS_EXCLUDE_PROC_PATTERNS = 'WINVM_APPOPS_EXCLUDE_PROC_PATTERNS';
