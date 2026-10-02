/**
 * LlmBridge —— WorkbuddyLlmProvider 与"LLM 推理运行时"之间的可注入边界。
 *
 * - 生产默认：`CliLlmBridge` 调起 VM 内 WorkBuddy `codebuddy` CLI。
 * - 测试：注入任意 `LlmBridge`（如 MockLlmBridge），使 runGoal 不依赖真实 CLI。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import type {
  ApprovalCoordinator,
  ApprovalRequest,
  Artifact,
  BridgeError,
  CapabilityId,
  DelegationTruthProbe,
  ExecutedResult,
  GoalStep,
  LlmSessionHealth,
  ProgressSink,
  RiskLevel,
  TaskState,
} from '@winvm/contracts';
import { makeError } from '@winvm/contracts';
import { resolveApprovalReplay, resolveLlmSessionConfig, type LlmSessionConfig } from '@winvm/core';

import {
  PersistentCliSession,
  type CliChild,
  type SessionLog,
  type TurnResult,
} from './persistent-session.js';
import { COMPLETION_CLAIM_PATTERN, reconcileDelegationTruth } from './delegation-truth.js';

/** 下发给 VM 内 Agent 的技能规范（供其按规范拆解步骤 / 编写脚本 / 调用工具） */
export interface LlmSkillDoc {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly body: string;
}

export interface LlmGoalInput {
  readonly goal: string;
  /** 平台已注册能力目录（来自 declareCapabilities ∩ 平台可用），作为 LLM 可用工具清单 */
  readonly capabilities: readonly string[];
  /** 产物输出目录（绝对或含 %USERPROFILE% 等环境变量） */
  readonly outputDir: string;
  /** CLI 可执行名或绝对路径，默认 codebuddy */
  readonly cliPath: string;
  /** 本服务 /mcp，供 LLM 运行时回连调用能力 */
  readonly endpoint?: string;
  readonly traceId: string;
  readonly timeoutMs: number;
  /** 下发的技能规范（落盘到工作区供 VM 内 Agent 查阅，并摘要注入系统提示） */
  readonly skills?: readonly LlmSkillDoc[];
  /** 技能包落盘目录；未指定时用 outputDir 的同级 .winvm/skills */
  readonly skillsDir?: string;
  /** K4：A2A 委派任务 id（由 provider 从 GoalRequest.taskId 透传，供审批协调器挂接 input-required） */
  readonly taskId?: string;
  /**
   * K-N1（**纯附加可选**）：服务端委派账本探针（vm-service 经 BridgeContext cast 注入，
   * provider 逐调用下传）。收口处 `reconcileDelegationTruth` 用它反查「本委派回合服务端
   * 是否真有过活动」；缺席即旧行为（透传不改判）。
   */
  readonly probe?: DelegationTruthProbe;
  /**
   * K-N1（**纯附加**）：告警出口（provider 注入 `ctx.logger.warn`；缺席回退桥内会话日志出口）。
   * 收口反查 fail-open 时记「恰一条」warn（设计 §9-B-3）—— 取证故障可观测，但绝不影响委派。
   */
  readonly warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * 默认 CLI 参数契约（占位符在渲染时替换）。
 *
 * ⚠ 已按真机 `codebuddy`（v2.149.0）实测契约修正（CL-017 D4）：
 *   旧模板用的 `--goal/--system-prompt/--mcp/--output` 在真机**全部不存在** → 委派必失败。
 *   真机契约：
 *     - 非交互：`-p/--print`，提示词为**位置参数**（无 `--system-prompt`，系统提示须并入位置提示词）
 *     - 输出：`--output-format text|json|stream-json`
 *     - MCP：`--mcp-config <fileOrString>`（JSON 文本**或文件路径**）+ `--strict-mcp-config`
 *       ⚠ 经 cmd.exe 传输时内联 JSON 的双引号会被破坏 → 运行时默认写临时文件并传**路径**（见 runGoal）
 *     - 目录授权：`--add-dir <dirs...>`
 *     - 免交互：`--permission-mode bypassPermissions`（或 `-y, --dangerously-skip-permissions`）
 *     - **无 `--output`** → 产物靠扫描 outputDir（见 collectArtifacts）
 *
 * 占位符：
 *   {goal} 用户目标 · {prompt} 系统提示（已含目标，运行时做换行适配）
 *   {endpoint} 本服务 /mcp · {output} 产物目录 · {skillsDir} 技能包目录
 *   {mcpConfig} MCP 配置（默认渲染为**配置文件路径**，回退时为 JSON 串）
 */
export const DEFAULT_CLI_ARG_TEMPLATE: readonly string[] = [
  '-p',
  '{prompt}',
  '--output-format',
  'text',
  '--permission-mode',
  'bypassPermissions',
  '--add-dir',
  '{output}',
  '--mcp-config',
  '{mcpConfig}',
];

/**
 * 给端点 URL 追加 `?dtid=<委派traceId>`（K-N1 通道 2，设计 §2.3）。独立导出便于
 * `tests/unit` 直接断言拼接形态（§9-B-5）：
 *  - 已有 query → `&` 追加；无 query → `?`；
 *  - endpoint 非字符串 / dtid 缺席 → **逐字节返回原值**（旧行为回归护栏）；
 *  - dtid 经 `encodeURIComponent`（traceId 实际只含 `[A-Za-z0-9_-]`，编码是无害保险）。
 */
export function appendDtid(endpoint: string | undefined, dtid: string | undefined): string | undefined {
  if (!endpoint || !dtid) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}dtid=${encodeURIComponent(dtid)}`;
}

/**
 * 构造 MCP 配置串（真机 `--mcp-config` 接受 JSON 文本，而非 URL）。
 *
 * K-N1（**纯附加可选**第 2 参 `delegationId`）：存在时端点拼 `?dtid=<委派traceId>` ——
 * VM 内 CLI 的 streamableHttp 客户端原样使用该 URL 回连 `/mcp`，服务端解析 dtid 注入
 * ToolContext → provider 审计落 `channel:'a2a'` + `ext.delegationId`（精确归因）。
 * 缺席时输出与旧实现**逐字节一致**（设计 §9-B-5 回归护栏）。
 */
export function buildMcpConfig(endpoint: string | undefined, delegationId?: string): string {
  if (!endpoint) return JSON.stringify({ mcpServers: {} });
  return JSON.stringify({
    mcpServers: {
      winvm: { type: 'streamableHttp', url: appendDtid(endpoint, delegationId) },
    },
  });
}

/** CLI 解析结果（CL-017 D4：可操作的错误提示需要「是否解析到 / 探测过哪些路径 / 是否为脚本」） */
export interface CliResolveResult {
  /** 解析到的可执行文件路径（未解析到时为原样输入） */
  readonly path: string;
  readonly resolved: boolean;
  /** 是否需经 cmd.exe 启动（Windows 下的 .cmd/.bat 等非 .exe 脚本） */
  readonly isScript: boolean;
  /** 探测过的候选路径（用于错误提示） */
  readonly probed: readonly string[];
}

/** 取 Windows PATHEXT（未设置时给常用默认），统一小写 */
function pathExts(): string[] {
  const raw = process.env['PATHEXT'];
  const list = raw && raw.trim()
    ? raw.split(';')
    : ['.COM', '.EXE', '.BAT', '.CMD'];
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/**
 * 解析 CLI 可执行文件路径（CL-017 D4）。
 *
 * 背景：真机里 npm 安装的 CLI 是 `codebuddy.cmd`，Node `spawn` **不解析 .cmd/.bat、也不读 PATHEXT**
 * （除非 shell:true），直接 spawn 会 `ENOENT`。故这里按 PATHEXT 探测真实文件，并标记是否为脚本。
 *
 * 支持：绝对路径、`~/` 家目录、`%ENV%` 环境变量、裸命令名（在 PATH 中按 PATHEXT 探测）。
 * 解析失败时返回 `resolved=false` 与探测清单，供调用方给出**可操作**错误。
 */
export function resolveCliPath(input: string): CliResolveResult {
  const expanded = input.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => process.env[n] ?? m);
  let p = expanded;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2));

  const win = process.platform === 'win32';
  const exts = win ? pathExts() : [''];
  const probed: string[] = [];

  /**
   * 解析候选：**优先**按 PATHEXT 探测可执行扩展名，其次才回退到原名。
   *
   * 为什么必须先探扩展名：npm/nvm 常在 PATH 里同时放 `codebuddy`（无扩展名的 POSIX 启动脚本）
   * 与 `codebuddy.cmd`。若先命中无扩展名的 `codebuddy`，cmd.exe 无法执行它
   * （真机报「不是内部或外部命令」）→ 委派必失败。故按 .cmd/.exe/... 先解析到真正可执行的文件。
   */
  const tryExt = (base: string): string | undefined => {
    for (const ext of exts) {
      if (!ext) continue;
      const cand = base + ext;
      probed.push(cand);
      if (existsSync(cand)) return cand;
    }
    probed.push(base);
    return existsSync(base) ? base : undefined;
  };

  // 绝对 / 家目录展开后的路径
  if (isAbsolute(p)) {
    const hit = tryExt(p);
    probed.push(p);
    const found = hit ?? p;
    const ext = extname(found).toLowerCase();
    return {
      path: found,
      resolved: hit !== undefined,
      isScript: win && ext !== '.exe',
      probed,
    };
  }

  // 裸命令名：在 PATH 各目录按 PATHEXT 探测
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const hit = tryExt(join(dir, p));
    if (hit) {
      const ext = extname(hit).toLowerCase();
      return { path: hit, resolved: true, isScript: win && ext !== '.exe', probed };
    }
  }

  return { path: p, resolved: false, isScript: win && extname(p).toLowerCase() !== '.exe', probed };
}

/**
 * 转义单个参数以嵌入 cmd.exe 命令行（CL-017 D4）。
 *
 * 必须按 **msvcrt/CommandLineToArgvW** 规则转义：`"` → `\"`，且**结尾反斜杠翻倍**
 * （否则路径以 `\` 结尾时闭合引号会被该反斜杠转义 → 引号失配）。
 * 含 cmd 元字符（`& | < > ^`）或空白/引号的参数必须整体加引号，否则会被 cmd 拆分/解释。
 */
export function escapeWinArg(a: string): string {
  if (a.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

/**
 * CLI 命令行「换行」适配（CL-017 D4）。
 *
 * cmd.exe 的命令行是**单行**的：参数里出现 CR/LF 会被当作命令分隔符，换行之后的内容被丢弃
 * （真机实测：多行系统提示词只到达第一行）。故把 CRLF/CR/LF 统一替换为 Unicode
 * LINE SEPARATOR (U+2028)——它既不是 cmd 的命令分隔符（真机实测可完整透传），
 * 又保留「行」的语义供 LLM 理解。
 */
export function flattenPromptForCli(prompt: string): string {
  return prompt.replace(/\r\n|\r|\n/g, '\u2028');
}

/** 渲染 CLI 参数模板 */
export function renderCliArgs(
  template: readonly string[],
  vars: Readonly<Record<string, string>>,
): string[] {
  return template.map((t) => t.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

/** 把技能规范落盘到工作区，供 VM 内 Agent 按需查阅 */
export async function writeSkillPack(
  skills: readonly LlmSkillDoc[],
  dir: string,
): Promise<string[]> {
  if (!skills.length) return [];
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const s of skills) {
    const safeId = s.id.replace(/[^a-z0-9._-]/gi, '_');
    const p = join(dir, `${safeId}.md`);
    await writeFile(p, s.body.endsWith('\n') ? s.body : `${s.body}\n`, 'utf8');
    files.push(p);
  }
  return files;
}

export interface LlmGoalResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly artifacts: readonly Artifact[];
  readonly steps: readonly GoalStep[];
  readonly error?: BridgeError;
  /**
   * K-N1 §4.4（**纯附加**）：本次走了「常驻会话不可用 → 单次 -p」降级的**结构化事实**
   * （summary 文案保留供宿主读，但取证/判定不再依赖字符串匹配）。
   * provider 映射到 `GoalResult.degraded`，服务端 observer 落 `delegation.complete.ext.downgraded`。
   */
  readonly degraded?: { readonly reason: string };
}

export interface LlmBridge {
  runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult>;
  /**
   * CL-018 C1（纯附加可选）：释放常驻会话资源。
   * 非常驻实现（如测试 Mock）无须实现 —— `WorkbuddyLlmProvider.shutdown()` 以可选调用处理。
   */
  dispose?(): Promise<void>;
  /** CL-018 C1（纯附加可选）：常驻会话健康快照（供 `/health.llmSession`） */
  sessionHealth?(): LlmSessionHealth | undefined;
  /** CL-018 C1（纯附加可选）：注入常驻会话参数（来自 `resolveServiceConfig().llmSession`） */
  setSessionConfig?(cfg: Partial<LlmSessionConfig>): void;
  /** CL-018 C1（纯附加可选）：注入常驻会话日志出口（接到服务 logger） */
  setSessionLog?(log: SessionLog): void;
  /**
   * K4（纯附加可选）：注入 A2A 审批协调器。VM 服务注入后，桥接层命中宿主审批拦截时经它把任务
   * 挂起为 input-required 并等待宿主人工决议；缺席即非 A2A 旧行为（纯 MCP / 单测）。
   */
  setApprovalCoordinator?(coordinator: ApprovalCoordinator): void;
  /**
   * K2 修复（A2A 冷启动停滞 · 纯附加可选）：启动期 fire-and-forget 预热常驻会话。
   * 仅常驻实现须实现；非持久化 Mock 实现无须实现（provider 以可选调用处理）。
   * 返回 true 表示预热达成 ready（或已就绪），false 表示未能在窗口内就绪（不阻断服务）。
   */
  warmup?(prompt: string): Promise<boolean>;
  /**
   * L1（**纯附加可选**）：常驻会话复位（disabled → stopped，计数归零，保留 lastError）。
   * 由 provider 的 `llmSessionReset()` SPI 经管理端点调用；无会话对象返回 undefined。
   */
  sessionReset?(): LlmSessionHealth | undefined;
  /**
   * L1（**纯附加可选**）：注入/清除「每次 spawn 立即错误退出」故障钩子（测试确定性回归用，
   * §6.2）。返回是否注入成功（无会话对象 / 非常驻 → false，如实报告）。
   */
  sessionInjectFault?(on: boolean): boolean;
  /**
   * K-N1 §4.1（**纯附加**）：常驻启用配置面（`persistentEnabled`）的只读访问，
   * provider 入口的 disabled 拒绝判定用（「disabled=故障」与「单次 -p=设计」的区分前提）。
   */
  isPersistentEnabled?(): boolean;
}

/** 构造喂给 LLM 的系统提示：能力目录 + 输出约束 + 安全边界 */
/** 构造喂给 LLM 的系统提示：技能规范 + 能力目录 + 输出约束 + 安全边界 */
export function buildSystemPrompt(input: LlmGoalInput): string {
  const capList = input.capabilities.length ? input.capabilities.join('\n  - ') : '（无）';
  const skills = input.skills ?? [];
  const skillsDir = input.skillsDir ?? join(dirname(input.outputDir), '.winvm', 'skills');

  const lines: string[] = [
    '你是运行在 Windows 虚拟机内的 WorkBuddy LLM Agent，负责把用户的自然语言目标转化为对 Windows 应用的实际操作。',
    '',
    '【可用能力（仅可调用以下已注册能力，禁止臆造工具）】',
    `  - ${capList}`,
    '',
  ];

  if (skills.length > 0) {
    lines.push(
      '【技能规范与操作指引】（完整正文已落盘，可按需查阅）',
      `  - 技能包目录：${skillsDir}`,
      ...skills.map((s) => `  - ${s.id}：${s.name}${s.description ? ` — ${s.description}` : ''}`),
      '  - 优先按上述技能规范拆解步骤与选择工具；技能未覆盖时，可自行编写脚本完成，',
      '    再用 appops.cli.invoke 在 VM 内执行（支持 powershell / python / node / ffmpeg / magick 等）。',
      '',
    );
  }

  lines.push(
    '【执行约束】',
    `  - 每步操作必须通过本服务的 MCP 端点调用上述能力：${input.endpoint ?? '(未配置 endpoint)'}`,
    `  - 所有产物写入：${input.outputDir}`,
    // K3 修复：明确的审批纪律。真机实证：LLM 曾把能力返回的 APPROVAL_REQUIRED 误读为「已执行成功」，
    // 导致宿主收到 ok=true 但实际操作（如卸载应用）并未发生。以下 4 条为硬约束，逐条可测。
    '  - 审批纪律（L2/L3 高危操作，硬约束，违反即任务失败）：',
    '    1. 当工具返回 APPROVAL_REQUIRED（响应含 approvalId 字段）时，必须立即停止执行，如实上报「等待审批」；',
    '       上报内容必须包含该 approvalId 与被拦截的能力名，严禁继续执行后续步骤。',
    '    2. 严禁把 APPROVAL_REQUIRED 当作已执行成功；严禁在未获宿主人工审批前声称目标已完成/已卸载/已删除。',
    '       被审批闸拦截后，本任务的结果状态是「等待审批」，不是「完成」。',
    '    3. 严禁自行携带 __approvalId 重发任何请求。审批只能由宿主人工确认后经 MCP 直调通道完成；',
    '       A2A 通道绝不透传 __approvalId，VM 内 Agent 自行携带 __approvalId 续跑等于绕过人工审批，属违规行为。',
    '  - 每步完成后回传截图/中间产物。',
    '  - 不得直连宿主机、不得访问与任务无关的目录。',
    '',
    '【工作方式】把目标拆成可验证的小步，逐步执行并把阶段性进展输出到 stdout，',
    '每完成一个可见阶段就把中间产物写入产物目录（会被实时回传给宿主机）。',
    '',
    `【用户目标】${input.goal}`,
  );

  return lines.join('\n');
}

function mimeOf(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function collectArtifacts(outputDir: string, sinceMs: number): Promise<Artifact[]> {
  if (!existsSync(outputDir)) return [];
  const entries = await readdir(outputDir);
  const out: Artifact[] = [];
  for (const name of entries) {
    const full = join(outputDir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs < sinceMs) continue; // 只收集本次任务期间新增/修改的文件
      if (st.size > MAX_ARTIFACT_BYTES) continue; // 超大文件不读进内存回传
      const buf = await readFile(full);
      out.push({
        kind: 'file',
        name,
        mime: mimeOf(full),
        data: buf.toString('base64'),
        encoding: 'base64',
      });
    } catch {
      // 单个文件读取失败不影响其余
    }
  }
  return out;
}

/**
 * 启动 CLI 子进程（CL-018 抽出，供**单次 `-p`** 与**常驻会话**共用，避免两套转义逻辑漂移）。
 *
 * .cmd/.bat 无法被 Node spawn 直接执行（不解析 PATHEXT）→ 经 cmd.exe /d /s /c 启动：
 *  - 整条命令行再用一对引号包起来（cmd `/s` 会剥掉最外层一对引号）；
 *  - `windowsVerbatimArguments=true` —— 命令行已自行转义，禁止 Node 再次加引号
 *    （Node 默认把含引号参数转义为 `\"`，而 cmd.exe 不认 → 真机报「找不到指定路径」）。
 */
export function launchCliProcess(
  cli: CliResolveResult,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliChild {
  if (process.platform === 'win32' && cli.isScript) {
    const cmdExe = env['ComSpec'] ?? 'cmd.exe';
    const cmdLine = [cli.path, ...args].map(escapeWinArg).join(' ');
    return spawn(cmdExe, ['/d', '/s', '/c', `"${cmdLine}"`], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as CliChild;
  }
  return spawn(cli.path, args.slice(), {
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as CliChild;
}

/** 产物逐步回传的节流泵（单次 `-p` 与常驻会话共用） */
export interface ArtifactPump {
  /** 节流触发一次扫描（有进展时调用） */
  maybePump(): void;
  /** 收尾：立即扫一遍（把最后一批产物推给宿主） */
  flush(): Promise<void>;
}

export function createArtifactPump(
  outputDir: string,
  sinceMs: number,
  sink: ProgressSink,
  intervalMs: number,
): ArtifactPump {
  const seen = new Set<string>();
  let lastScan = 0;
  let pumping = false;
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (const a of await collectArtifacts(outputDir, sinceMs)) {
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        try {
          sink.onArtifact(a);
        } catch {
          /* 单个产物回传失败不影响任务执行 */
        }
      }
    } catch {
      /* 目录暂不可读时忽略，下次扫描再试 */
    } finally {
      pumping = false;
    }
  };
  return {
    maybePump(): void {
      const now = Date.now();
      if (now - lastScan < intervalMs) return;
      lastScan = now;
      void pump();
    },
    async flush(): Promise<void> {
      await pump();
    },
  };
}

export interface CliLlmBridgeOptions {
  readonly runtime?: string;
  readonly cliPath?: string;
  readonly endpoint?: string;
  /**
   * CLI 参数模板（支持 {goal} {prompt} {endpoint} {output} {skillsDir} 占位符）。
   * 未指定时用 DEFAULT_CLI_ARG_TEMPLATE；真机 CLI 契约不同时经配置覆盖即可。
   */
  readonly cliArgTemplate?: readonly string[];
  /** 产物扫描间隔（毫秒），用于把中间产物逐步回传宿主，默认 2000 */
  readonly artifactScanIntervalMs?: number;
  /** CL-018 C1：是否启用常驻会话（默认取 env `WINVM_LLM_PERSISTENT`，缺省启用） */
  readonly persistent?: boolean;
  /** CL-018 C1：常驻会话参数覆盖（未给字段回退 env / 内置默认） */
  readonly sessionConfig?: Partial<LlmSessionConfig>;
  /** CL-018 C1：常驻会话日志出口（接到服务 logger，便于事后诊断） */
  readonly onSessionLog?: SessionLog;
  /**
   * K2 修复：预热用的产物目录（须与真实 `runGoal` 使用的 `outputDir` 一致，否则会构造出
   * 第二个会话单例、预热错对象）。缺省 `'%USERPROFILE%\\WinVMWorkspace\\out'`，与 provider 默认一致。
   */
  readonly outputDir?: string;
  /**
   * K5：服务端重放模式（显式配置优先；未指定时取 env `WINVM_APPROVAL_REPLAY`，缺省 on）。
   * on：批准后消费服务端回执 + 完成声明做回执反查；off：退回 K4 提示词行为（不反查）。
   */
  readonly approvalReplay?: boolean;
}

/** 产物逐步回传的扫描节流间隔 */
const DEFAULT_ARTIFACT_SCAN_INTERVAL_MS = 2000;
/** 单个产物大小上限，超出则跳过（避免把超大文件读进内存回传） */
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

/**
 * CLI 运行时的「致命」stderr 特征（CL-017 D4）。
 *
 * 真机 `codebuddy` 在**未登录**等不可用状态下会把错误写到 stderr 但**退出码仍为 0**；
 * 若不甄别就会给出「完成目标」的假结论。命中即按 PROVIDER_UNAVAILABLE 上报 → 触发 D4.4 降级。
 */
const FATAL_STDERR_PATTERNS: readonly RegExp[] = [
  /Authentication required/i,
  /please use \/login/i,
  /not logged in/i,
  /unauthorized/i,
  /invalid api key/i,
];

/** 判断 CLI stderr 是否命中「致命」特征（未登录/未授权等）——用于纠正「退出码 0 的假成功」。 */
export function isFatalRuntimeStderr(stderr: string): boolean {
  return FATAL_STDERR_PATTERNS.some((re) => re.test(stderr));
}

/**
 * K3 修复：结果如实性检查——甄别 LLM 文本中的「等待审批」信号。
 *
 * 背景（真机实证）：能力被策略引擎拦截时返回 `APPROVAL_REQUIRED`（含 approvalId）。
 * LLM 若如实停止并上报，其最终文本会包含该错误码；此时轮次/进程本身正常结束
 * （ok=true），但操作**并未发生**——若仍组装为「完成目标」，就是结构性假成功。
 *
 * 规则：最终文本命中 `APPROVAL_REQUIRED`（或 LLM 明示「等待审批」）时，结果改为
 * `ok=false`、状态语义为「等待审批」，并把 approvalId（若能从文本中提取）透传给宿主。
 */
const APPROVAL_WAIT_PATTERN = /APPROVAL_REQUIRED|等待审批/;

/** 从 LLM 文本中提取审批 ID（`apr_...` 形态，见 vm-service newId('apr')） */
function extractApprovalId(text: string): string | undefined {
  const m = /\bapr_[A-Za-z0-9_-]+/.exec(text);
  return m ? m[0] : undefined;
}

/**
 * 从 LLM 文本解析审批拦截的结构化信息（K4 续跑需要 capabilityId / risk）。
 * codebuddy 把 MCP 工具返回的 APPROVAL_REQUIRED 原样回显到 stdout，其中含
 * `approvalId` / `capabilityId` / `risk` 字段，正则尽力提取；缺失时给安全默认。
 */
function parseApprovalBlock(text: string): { approvalId?: string; capabilityId?: string; risk: RiskLevel } {
  const approvalId = extractApprovalId(text);
  const capM = /capabilityId["']?\s*[:=]\s*["']?([a-zA-Z0-9.*_-]+)/i.exec(text);
  const riskM = /risk["']?\s*[:=]\s*["']?(L[0-3])/i.exec(text);
  return {
    approvalId,
    capabilityId: capM ? capM[1] : undefined,
    risk: (riskM ? (riskM[1] as RiskLevel) : 'L2') ?? 'L2',
  };
}

/* ============================ K5：完成声称识别（回执反查用） ============================ */

/**
 * LLM 文本中的「目标已完成」声称特征（K5 回执反查与 K-N1 账本反查**共用**的触发面）。
 *
 * K-N1：定义已迁至 `delegation-truth.ts`（单一来源，杜绝两条判据的模式漂移），
 * 此处 re-export 保持既有引用面（本文件 :916 与任何外部 import）逐字可用。
 */
export { COMPLETION_CLAIM_PATTERN } from './delegation-truth.js';

/**
 * 对「轮次/进程正常结束」的结果做如实性修正（runPersistent 与 runOneShot 共用）。
 *
 * LLM 文本表明其在等待审批时，不得断言成功：改为 `ok=false` + 「等待审批」语义的 summary，
 * 并保留已收集的产物（截图等中间产物对宿主人工审批有参考价值）。
 */
function reconcileApprovalWait(base: LlmGoalResult, finalText: string): LlmGoalResult {
  if (!APPROVAL_WAIT_PATTERN.test(finalText)) return base;
  const parsed = parseApprovalBlock(finalText);
  return {
    ...base,
    ok: false,
    summary:
      `等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED），目标「${base.summary}」未执行完成，` +
      `须经宿主人工审批后经 MCP 直调通道续跑` +
      (parsed.approvalId ? `；approvalId=${parsed.approvalId}` : ''),
    steps: base.steps.map((s) => ({ ...s, ok: false, summary: '等待审批（未执行完成）' })),
    error: makeError('APPROVAL_REQUIRED', 'LLM 上报等待宿主人工审批，操作未执行', {
      ...(parsed.approvalId
        ? {
            details: {
              approvalId: parsed.approvalId,
              ...(parsed.capabilityId ? { capabilityId: parsed.capabilityId } : {}),
              risk: parsed.risk,
            },
          }
        : {}),
    }),
  };
}

/**
 * 生产默认实现：调起 VM 内 WorkBuddy `codebuddy` CLI 作为 LLM 推理运行时。
 * CLI 契约默认：`codebuddy --goal "<goal>" --system-prompt "<prompt>" --mcp <endpoint> --output <dir>`
 * 进程退出码 0 = 成功；stdout 逐行作为进度回传；产物目录新增文件会被逐步回传。
 */
/** 单次执行上下文（runGoal 计算一次，供常驻 / 单次两条路径共用，避免重复计算漂移） */
interface RunContext {
  readonly prompt: string;
  readonly outputDir: string;
  readonly skillsDir: string;
  readonly started: number;
  readonly cli: CliResolveResult;
  /**
   * K5：最近一轮 LLM 的**最终文本**（回执反查的判定输入）。
   * 每轮结束（常驻 turn / 单次 stdout 收尾）按时间顺序覆写；续跑轮的文本是最终答案，
   * 所以「内层先写、外层 await 后不再写」天然留下最后一轮的值。
   */
  lastFinalText: string;
}

/**
 * K5 续跑轮指令的两态（判别联合）：
 * - `{ executed }` —— 服务端已真实执行（重放），注入真实回执（`executionSuffix`）；
 * - `{ approvalId, capabilityId }` —— 灰度 off 的 K4 路径，提示 LLM 带 `__approvalId` 重发。
 */
type ResumeTurn =
  | { readonly executed: ExecutedResult }
  | { readonly approvalId: string; readonly capabilityId: CapabilityId };

export class CliLlmBridge implements LlmBridge {
  private readonly cliPath: string;
  private readonly endpoint?: string;
  private readonly argTemplate: readonly string[];
  private readonly artifactScanIntervalMs: number;

  /** C1：常驻会话开关（CLI 未解析成功时一律走单次路径） */
  private persistentEnabled: boolean;
  /** C1：常驻会话参数覆盖（provider 可注入 resolveServiceConfig().llmSession） */
  private sessionConfig: Partial<LlmSessionConfig> | undefined;
  private onSessionLog: SessionLog | undefined;
  /** C1：lazy 单例常驻会话（与其产物目录绑定，目录变化即重建） */
  private persistent: PersistentCliSession | undefined;
  private persistentDir: string | undefined;
  /**
   * L1 §6.2：故障注入的**延迟生效位** —— 管理端点可能在会话对象存在之前就被调用
   * （服务刚启动、尚无委派）。置 true 后在下一个 `ensureSession` 建会话时补注入；
   * 置 undefined（清除）同时清现存会话的注入位。
   */
  private pendingSpawnFault: true | undefined;
  /** K2：预热使用的产物目录（须与真实 runGoal 的 outputDir 一致） */
  private readonly outputDir: string;
  /** K4：A2A 审批协调器（VM 服务注入；缺席即非 A2A 旧行为） */
  private coordinator: ApprovalCoordinator | undefined;
  /**
   * K5：服务端执行回执登记表（approvalId → 真实执行结果）。
   * 核心不变式的载体：**能力是否真实执行，以服务端结构化回执为准，LLM 文本永远不是完成证据**。
   * beginTask 时清空（每个委派任务独立）。
   */
  private readonly taskReceipts = new Map<string, ExecutedResult>();
  /** K5：本任务已 raise 过的 approvalId 集合（去重二次 raise + 回执反查的触发面）。 */
  private readonly raisedApprovals = new Set<string>();
  /**
   * K5：本任务是否**实际进入过服务端重放模式**（任一 raise 回包携带 `executed`）。
   *
   * 只有服务端真的重放过，才有「回执」这个客观参照物可反查；若服务端处于
   * `WINVM_APPROVAL_REPLAY=off`（回包只有 `approved:true`、无 `executed`），则整条链路
   * 逐字退回 K4 提示词行为 —— 此时做反查会把 K4 下合法的「LLM 带 __approvalId 重发成功」
   * 误杀成假失败，故反查退场（回滚保险的另一半）。
   */
  private k5ReplayActive = false;
  /**
   * K5：服务端重放模式开关（env `WINVM_APPROVAL_REPLAY`，非法值回退 on；显式配置优先）。
   * 仅决定**回执反查**是否启用：off 时协调器不重放、无回执可查，若仍反查会把合法的
   * K4「LLM 重发」完成误杀成假成功 —— 故 off 时反查退场，逐字保持 K4 行为。
   */
  private readonly replayEnabled: boolean;

  constructor(opts: CliLlmBridgeOptions = {}) {
    this.cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy';
    this.endpoint = opts.endpoint;
    this.argTemplate = opts.cliArgTemplate ?? DEFAULT_CLI_ARG_TEMPLATE;
    this.artifactScanIntervalMs = opts.artifactScanIntervalMs ?? DEFAULT_ARTIFACT_SCAN_INTERVAL_MS;
    this.sessionConfig = opts.sessionConfig;
    this.onSessionLog = opts.onSessionLog;
    this.outputDir = opts.outputDir ?? '%USERPROFILE%\\WinVMWorkspace\\out';
    // 默认取 env（缺省启用）；显式配置优先
    this.persistentEnabled = opts.persistent ?? resolveLlmSessionConfig(process.env).enabled;
    this.replayEnabled = opts.approvalReplay ?? resolveApprovalReplay(process.env);
  }

  /**
   * 委派入口（CL-018）：**常驻会话优先，单次 `-p` 兜底**（AC1.5）。
   *
   * 两条路径的**外部语义完全一致**（同一 `LlmGoalResult` 形状、同样的产物回传与进度流）；
   * 差别只在「是否复用长驻进程」。常驻不可用时降级并在 `summary` 如实标注，绝不伪装成功。
   */
  async runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult> {
    // K5：每次委派任务独立的回执登记从干净状态开始（设计 §3.3：beginTask/endTask 清）。
    // k5ReplayActive 一并清零：它决定「回执反查」是否介入，跨任务残留会让上一任务的
    // 「服务端在重放」事实错误污染本任务（本任务服务端若处于灰度 off 就会被误判成假失败）。
    this.taskReceipts.clear();
    this.raisedApprovals.clear();
    this.k5ReplayActive = false;
    // K4：进入委派任务（供审批协调器挂接 input-required）；无 coordinator 时为空操作。
    this.coordinator?.beginTask(input.taskId ?? '');
    try {
      return await this.runGoalInner(input, sink);
    } finally {
      this.coordinator?.endTask();
    }
  }

  /** runGoal 实际主体（K4：在 begin/endTask 之间执行，便于续跑 await 期间维持 activeTaskId） */
  private async runGoalInner(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult> {
    const started = Date.now();
    const outputDir = resolve(input.outputDir.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => process.env[n] ?? m));
    const skillsDir = input.skillsDir ?? join(dirname(outputDir), '.winvm', 'skills');

    /* 下发技能规范：落盘到工作区供 VM 内 Agent 按规范拆解步骤（失败不阻断执行） */
    if (input.skills && input.skills.length > 0) {
      try {
        const files = await writeSkillPack(input.skills, skillsDir);
        sink.onStatus('working', `已下发 ${files.length} 份技能规范 → ${skillsDir}`);
      } catch (e) {
        sink.onStatus('working', `技能包落盘失败（继续执行）：${(e as Error).message}`);
      }
    }

    const prompt = buildSystemPrompt({ ...input, outputDir, skillsDir });
    // D4：先按 PATHEXT 解析真实 CLI 文件（win32 上 npm 安装的可能是 codebuddy.cmd）
    const cli = resolveCliPath(this.cliPath);
    const ctx: RunContext = { prompt, outputDir, skillsDir, started, cli, lastFinalText: '' };

    const res = await this.runGoalCore(input, sink, ctx);
    // K-N1 §3.3：**委派账本反查先行、无条件**（只受 taskId/delegationTraceId/probe 门控，
    // 不受 replayEnabled / k5ReplayActive 审批灰度门控 —— 账本参照物与审批灰度无关）。
    // 改判产物 ok:false → 下面既有 reconcileExecutionTruth 的 `!base.ok` 透传分支自然生效，
    // 两判据互斥、不可能产生矛盾终态（设计 §9-B-4）。**D-1：:913-914 两道既有门一字不动。**
    const truthed = await reconcileDelegationTruth(res, ctx.lastFinalText, {
      delegationTraceId: input.traceId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.probe ? { probe: input.probe } : {}),
      // fail-open 告警出口：provider 注入的服务 logger.warn 优先，缺席回退会话日志出口
      warn: input.warn ?? this.onSessionLog ?? undefined,
    });
    // K5 回执反查：对**最终一轮** LLM 文本做「完成声称 vs 服务端回执」核对
    // （放在最外层，保证续跑轮的文本才是被核对的那一份）。
    return this.reconcileExecutionTruth(truthed, ctx.lastFinalText);
  }

  /** runGoalInner 的执行主体（常驻优先 → 单次兜底），K5 反查在其返回后由 runGoalInner 施加。 */
  private async runGoalCore(input: LlmGoalInput, sink: ProgressSink, ctx: RunContext): Promise<LlmGoalResult> {
    if (this.persistentEnabled && ctx.cli.resolved) {
      const out = await this.runPersistent(input, sink, ctx);
      if ('result' in out) return out.result;
      sink.onStatus('working', `常驻会话不可用（${out.unavailable}），回退单次 -p 冷启动`);
      const oneShot = await this.runOneShot(input, sink, ctx);
      return {
        ...oneShot,
        summary: `${oneShot.summary}（常驻会话不可用：${out.unavailable}，已降级为单次 -p 路径）`,
        // K-N1 §4.4：降级事实**结构化**承载（summary 文案保留供宿主读；取证/判定不再字符串匹配）。
        // provider 透传到 `GoalResult.degraded` → 服务端 observer 落 `ext.downgraded/downgradeReason`。
        degraded: { reason: out.unavailable },
      };
    }

    return this.runOneShot(input, sink, ctx);
  }

  /** 常驻会话健康快照（供 `/health.llmSession`） */
  sessionHealth(): LlmSessionHealth | undefined {
    return this.persistent?.snapshot();
  }

  /**
   * L1 §6.1：常驻会话复位（管理端点 → provider.llmSessionReset → 本方法 → session.restartFresh）。
   * 尚无会话对象（从未委派过 / 常驻未启用）→ undefined，端点如实返回「无可复位对象」。
   */
  sessionReset(): LlmSessionHealth | undefined {
    return this.persistent?.restartFresh();
  }

  /**
   * L1 §6.2：注入/清除 spawn 故障钩子（测试专用，同一 admin 门控）。
   * 无会话对象时**延迟生效**：记下待注入位，下次 `ensureSession` 建会话时补上 ——
   * 使「服务刚启动、还没跑过任何委派」也能注入（K-N1 回归的现场时序正是这个）。
   */
  sessionInjectFault(on: boolean): boolean {
    this.pendingSpawnFault = on === true ? true : undefined;
    if (this.persistent) return this.persistent.setSpawnFault(on);
    return on === true;
  }

  /** K-N1 §4.1：常驻启用配置面只读（provider 的 disabled 拒绝判定前提） */
  isPersistentEnabled(): boolean {
    return this.persistentEnabled;
  }

  /**
   * K2 修复（A2A 冷启动停滞）：启动期 fire-and-forget 预热常驻会话。
   *
   * 与真实 `runGoal` 使用**同一产物目录**构造会话单例（确保预热的就是首调会复用的对象），
   * 把 codebuddy 进程级冷启动（auth probe + agent 端点 ≈75–107s）前移到 VM 服务启动期，
   * 使首个真实委派免付冷启动、不再撞上宿主有界超时返回「冷启动窗口」引导文案。
   * 失败（CLI 缺失/不可用）安全返回 false，不阻断服务。
   */
  async warmup(prompt: string): Promise<boolean> {
    if (!this.persistentEnabled) return false;
    const cli = resolveCliPath(this.cliPath);
    if (!cli.resolved) return false;
    const outputDir = resolve(
      this.outputDir.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => process.env[n] ?? m),
    );
    const mcpConfigPath = await this.prepareMcpConfig(outputDir);
    if (!mcpConfigPath) return false;
    const session = this.ensureSession(outputDir, mcpConfigPath, cli);
    return session.warmup(prompt);
  }

  /** 释放常驻会话（服务关闭路径） */
  async dispose(): Promise<void> {
    const s = this.persistent;
    this.persistent = undefined;
    this.persistentDir = undefined;
    if (s) await s.shutdown().catch(() => undefined);
  }

  /** 由 provider 注入（来自 resolveServiceConfig().llmSession）—— 使配置/健康态同源 */
  setSessionConfig(cfg: Partial<LlmSessionConfig>): void {
    this.sessionConfig = { ...(this.sessionConfig ?? {}), ...cfg };
    if (cfg.enabled !== undefined) this.persistentEnabled = cfg.enabled;
  }

  /** 由 provider 注入常驻会话日志出口（接到服务 logger；须在首次 runGoal 前调用） */
  setSessionLog(log: SessionLog): void {
    this.onSessionLog = log;
  }

  /** K4：由 provider 注入 A2A 审批协调器（VM 服务侧创建并绑定任务存储与令牌表） */
  setApprovalCoordinator(coordinator: ApprovalCoordinator): void {
    this.coordinator = coordinator;
  }

  /**
   * K4 续跑指令（`WINVM_APPROVAL_REPLAY=off` 灰度回退路径）：追加给 codebuddy 的提示。
   *
   * 纪律（对齐 K3）：`__approvalId` 只在本续跑真实能力调用里出现（此时已被宿主批准）；
   * A2A 首轮 data 绝不携带 `__approvalId`。
   *
   * ⚠ K5 根因（真机实证）：本提示依赖 LLM「愿意重发」。实测它不重发、直接文本自宣完成
   * → 假成功。K5 默认走 `executionSuffix`（服务端已真实执行，只要求如实转告）。
   */
  private resumeSuffix(approval: { approvalId: string; capabilityId: CapabilityId }): string {
    return (
      `宿主已批准本次操作（approvalId=${approval.approvalId}，capabilityId=${approval.capabilityId}）。` +
      `请立即以参数 __approvalId: ${approval.approvalId} 重发该能力调用以完成执行` +
      `（此前被审批闸拦截的能力现在可执行，无需再次等待审批）。`
    );
  }

  /**
   * K5 续跑指令（默认路径）：把**服务端真实执行回执**如实注入续跑 turn。
   *
   * 与 K4 的本质区别：执行已经完成，LLM 的任务只剩「如实转告 + 处理剩余步骤」，
   * 严禁重复调用该能力（重复调用会真的重复执行），严禁声称未经执行的操作。
   * 回执内容全部来自服务端结构化结果，不来自 LLM 文本。
   */
  private executionSuffix(executed: ExecutedResult): string {
    const verdict = executed.ok
      ? `结果：成功 —— ${executed.summary}`
      : `结果：失败 —— ${executed.summary}${executed.error ? `（原因：${executed.error}）` : ''}`;
    return (
      `【系统已执行】宿主已批准该操作，服务端已按批准的原始参数**真实执行**能力 ${executed.capabilityId}。` +
      `${verdict}。` +
      `你的任务是**如实转告用户上述真实执行结果**并处理目标中剩余的未完成步骤；` +
      `严禁再次调用该能力（该操作已执行完毕，重复调用会造成重复的真实变更）；` +
      `对未经服务端执行的操作严禁声称完成/已卸载/已删除；` +
      `严禁把上述回执当作需要你重新发起的待办。`
    );
  }

  /**
   * K5 审批续跑中枢：命中审批拦截且存在 coordinator 时，把任务挂起为 input-required 并等待宿主决议。
   *
   * - `!approved`（拒绝 / TTL 超时 / 无挂接任务）→ 保持 K3 行为（等待审批，绝不自批）。
   * - `approved + executed`（K5 默认）→ 服务端已真实执行：登记回执，续跑 turn 注入**真实回执**
   *   （`executionSuffix`），LLM 只需如实转告；随后由 `reconcileExecutionTruth` 对完成声明做反查。
   * - `approved` 无 `executed`（灰度 off / 未注入重放）→ 退回 K4 提示词行为（`resumeSuffix`）。
   * - 同一 approvalId 二次进入 → **不再二次挂起**，直接用已登记回执判定（修 K4 的旧 token 复用）。
   *
   * @param mode 'oneshot' 续跑重拉一次 `-p`；'persistent' 在常驻会话上补发一轮续跑消息。
   */
  private async maybeResume(
    base: LlmGoalResult,
    input: LlmGoalInput,
    sink: ProgressSink,
    ctx: RunContext,
    mode: 'oneshot' | 'persistent',
  ): Promise<LlmGoalResult> {
    const blocked = base.error?.code === 'APPROVAL_REQUIRED' || !!base.error?.details?.approvalId;
    if (!blocked || !this.coordinator) return base; // 无 coordinator：保持 K3 旧行为

    const details = (base.error?.details ?? {}) as Record<string, unknown>;
    const approvalId = typeof details['approvalId'] === 'string' ? details['approvalId'] : undefined;
    if (!approvalId) return base; // 拿不到 token 无法续跑，保持「等待审批」

    const capabilityId = (typeof details['capabilityId'] === 'string'
      ? details['capabilityId']
      : 'appops.workflow.run') as CapabilityId;
    const risk = (typeof details['risk'] === 'string' ? details['risk'] : 'L2') as RiskLevel;

    // K5 去重：同一 approvalId 已挂起过（真机实证：续跑 turn 里 LLM 回显旧 apr_ token →
    // 二次 raise 会复用同一 token 再挂一轮审批）。二次进入不再挂起，直接用已登记回执判定。
    if (this.raisedApprovals.has(approvalId)) {
      return this.applyReceipt(approvalId, base);
    }

    const req: ApprovalRequest = {
      approvalId,
      capabilityId,
      risk,
      summary: input.goal,
      preview: {},
      impact: [],
    };

    this.raisedApprovals.add(approvalId);
    const outcome = await this.coordinator.raise(req);
    if (!outcome.approved) return base; // 宿主拒绝 / 超时 / 无任务：保持「等待审批」，绝不自批（K3 纪律）

    // K4 兼容（灰度 off / 未注入重放）：无回执 → 退回「提示 LLM 带 __approvalId 重发」行为
    if (!outcome.executed) {
      sink.onStatus('working', `宿主已批准（approvalId=${approvalId}），续跑执行${capabilityId ? `：${capabilityId}` : ''}`);
      const approvalArg = { approvalId, capabilityId };
      if (mode === 'oneshot') {
        return this.runOneShot(input, sink, ctx, approvalArg);
      }
      const retry = await this.runPersistent(input, sink, ctx, approvalArg);
      if ('result' in retry) return retry.result;
      // 常驻不可用：降级为单次 `-p` 续跑（语义不变）
      return this.runOneShot(input, sink, ctx, approvalArg);
    }

    // K5 默认：服务端已真实执行 → 登记回执，续跑 turn 只要求「如实转告 + 处理剩余步骤」
    const executed = outcome.executed;
    this.taskReceipts.set(approvalId, executed);
    // 服务端确实处于重放模式（回包带回执）→ 才启用「完成声明 vs 回执」反查
    this.k5ReplayActive = true;
    sink.onStatus(
      'working',
      `宿主已批准（approvalId=${approvalId}），服务端已执行 ${executed.capabilityId}：` +
        (executed.ok ? executed.summary : `${executed.summary}${executed.error ? `（${executed.error}）` : ''}`),
    );
    if (mode === 'oneshot') {
      return this.runOneShot(input, sink, ctx, { executed });
    }
    const retry = await this.runPersistent(input, sink, ctx, { executed });
    if ('result' in retry) return retry.result;
    // 常驻不可用：降级为单次 `-p` 续跑（回执注入语义不变）
    return this.runOneShot(input, sink, ctx, { executed });
  }

  /**
   * K5 回执反查（升级自 K3/K4 的纯文本判定）。
   *
   * 仅在「本任务发生过审批挂起」时介入，其余路径零改动（K3 语义逐字保留）：
   *   - 最终文本含完成声称 + 回执集中**无** `ok:true` → 改判 `failed`
   *     （执行回执缺失，完成声明不予采信）—— 这就是根治的「假成功」判据；
   *   - 回执集中**有** `ok:true` → **采信**，放行 completed（执行事实以服务端回执为准）。
   */
  private reconcileExecutionTruth(base: LlmGoalResult, finalText: string): LlmGoalResult {
    // 反查只在「本桥开启 K5 且服务端确实重放过」时介入：
    //   - 灰度 off（本桥或桥侧 env 关）→ 无回执这一客观参照物，硬做反查会把 K4 下合法的
    //     「LLM 带 __approvalId 重发成功」误判成假失败，故退场（退回 K4 行为）；
    //   - 服务端未重放（回包无 executed）同理退场。
    if (!this.replayEnabled || !this.k5ReplayActive) return base;
    if (this.raisedApprovals.size === 0) return base; // 本任务未发生审批 → K3 行为逐字不变
    if (!base.ok) return base; // 已是失败态：交给既有「等待审批」判定，不重复改判
    if (!COMPLETION_CLAIM_PATTERN.test(finalText)) return base; // 无完成声称：不猜

    const receipts = [...this.taskReceipts.values()];
    if (receipts.some((r) => r.ok)) return base; // 有成功回执 → 采信 completed

    const failedReceipt = receipts.find((r) => !r.ok);
    return {
      ...base,
      ok: false,
      summary:
        `执行回执缺失：审批后服务端未产生成功执行记录，完成声明不予采信。` +
        (failedReceipt ? `已登记的失败回执：${failedReceipt.summary}（${failedReceipt.error ?? '无原因'}）` : ''),
      steps: base.steps.map((s) => ({ ...s, ok: false, summary: '无服务端成功回执，完成声明不予采信' })),
      error: makeError('EXECUTION_FAILED', '执行回执缺失（服务端未记到执行成功）', {
        reason: 'NO_EXECUTION_RECEIPT',
        details: { approvalIds: [...this.raisedApprovals], receipts: receipts.length },
      }),
    };
  }

  /**
   * K5 同 approvalId 二次进入时的判定：以**已登记回执**为准，不再挂起等待。
   *
   * 真机实证续跑 turn 的 LLM 会回显旧 `apr_` token 文本（被 K3 判为「等待审批」），
   * 若此时服务端其实已成功执行，就应据回执改判；反之（回执失败）也据回执给出真实结论。
   */
  private applyReceipt(approvalId: string, base: LlmGoalResult): LlmGoalResult {
    const r = this.taskReceipts.get(approvalId);
    if (!r) {
      // 无回执（首轮被拒 / 超时 / 灰度 off）：保持「等待审批」旧语义，绝不二次挂起
      return base;
    }
    if (r.ok) {
      return {
        ...base,
        ok: true,
        summary: `服务端执行回执（${r.capabilityId}）：${r.summary}`,
        error: undefined,
        steps: base.steps.map((s) => ({ ...s, ok: true, summary: r.summary })),
      };
    }
    return {
      ...base,
      ok: false,
      summary: `服务端执行回执（${r.capabilityId}）失败：${r.summary}${r.error ? `（${r.error}）` : ''}`,
      steps: base.steps.map((s) => ({ ...s, ok: false, summary: '服务端执行回执为失败' })),
      error: makeError('EXECUTION_FAILED', r.summary, {
        reason: 'REPLAY_FAILED',
        ...(r.error ? { details: { error: r.error } } : {}),
      }),
    };
  }

  /** 常驻会话（lazy 单例；产物目录变化时重建） */
  private ensureSession(outputDir: string, mcpConfigPath: string, cli: CliResolveResult): PersistentCliSession {
    if (this.persistent && this.persistentDir === outputDir) return this.persistent;
    if (this.persistent) void this.persistent.shutdown();
    const cfg: LlmSessionConfig = { ...resolveLlmSessionConfig(process.env), ...(this.sessionConfig ?? {}) };
    this.persistent = new PersistentCliSession({
      cliPath: cli.path,
      outputDir,
      mcpConfigPath,
      sessionId: cfg.sessionId,
      idleTtlMs: cfg.idleTtlMs,
      readyTimeoutMs: cfg.readyTimeoutMs,
      warmupReadyMs: cfg.warmupReadyMs,
      maxRestarts: cfg.maxRestarts,
      maxWsBytes: cfg.maxWsBytes,
      spawnFn: (args) => launchCliProcess(cli, args, process.env),
      // L1 §6.2：延迟生效的故障注入位（管理端点在无会话时置位，建会话时补上）
      ...(this.pendingSpawnFault ? { spawnFault: true } : {}),
      ...(this.onSessionLog ? { log: this.onSessionLog } : {}),
    });
    this.persistentDir = outputDir;
    return this.persistent;
  }

  /**
   * 把 MCP 配置落盘为文件并返回**路径**（D4：经 cmd.exe 传内联 JSON 会被内层双引号破坏）。
   * 落盘失败返回 undefined，由调用方决定回退策略。
   *
   * K-N1（**纯附加可选**第 2 参）：`delegationId` 存在时端点拼 `?dtid=`（通道 2 精确归因）。
   * 纪律：**只在单次 -p 路径传入** —— 常驻会话的 `mcp.json` 是**会话级共享文件**
   * （按 outputDir 复用同一 CLI 进程），把逐次委派 dtid 写进去只在该进程**下次 spawn** 时才生效，
   * 归因时点错位、且会把上一委派的 dtid 留在文件里；常驻路径的内层归因由**通道 1（时间窗 wild）**
   * 兜底，判定同样成立（零活动 = 窗口内一条非壳记录都没有）。登记为设计偏差（§10-5 同类）。
   */
  private async prepareMcpConfig(outputDir: string, delegationId?: string): Promise<string | undefined> {
    const inline = buildMcpConfig(this.endpoint, delegationId);
    try {
      const cfgDir = join(dirname(outputDir), '.winvm');
      await mkdir(cfgDir, { recursive: true });
      const cfgFile = join(cfgDir, 'mcp.json');
      await writeFile(cfgFile, inline, 'utf8');
      return cfgFile;
    } catch {
      return undefined;
    }
  }

  /** C1：常驻会话执行一轮；不可用则返回 `{ unavailable }` 供调用方回退 */
  private async runPersistent(
    input: LlmGoalInput,
    sink: ProgressSink,
    ctx: RunContext,
    resume?: ResumeTurn,
  ): Promise<{ result: LlmGoalResult } | { unavailable: string }> {
    const mcpConfigPath = await this.prepareMcpConfig(ctx.outputDir);
    if (!mcpConfigPath) return { unavailable: 'MCP 配置文件落盘失败（产物目录不可写）' };

    const session = this.ensureSession(ctx.outputDir, mcpConfigPath, ctx.cli);
    const pump = createArtifactPump(ctx.outputDir, ctx.started, sink, this.artifactScanIntervalMs);
    sink.onStatus('working', `复用 codebuddy 常驻会话（state=${session.sessionState}）`);

    const turnSink = {
      onStatus: (state: TaskState, message?: string): void => {
        pump.maybePump();
        sink.onStatus(state, message);
      },
    };

    let turn: TurnResult;
    try {
      // K4/K5：续跑轮只发续跑指令（常驻会话保留前轮上下文，无需重复系统提示）——
      // K5 默认注入「系统已真实执行 + 回执」；灰度 off 时退回「请带 __approvalId 重发」。
      turn = await session.runTurn(
        resume ? this.resumeTurnText(resume) : ctx.prompt,
        turnSink,
        input.timeoutMs,
      );
    } catch (e) {
      return { unavailable: `常驻会话异常：${(e as Error).message}` };
    }
    if (turn.unavailable) return { unavailable: turn.error ?? '常驻会话不可用' };
    // K5：记录本轮最终文本（供最外层回执反查；续跑轮后写 → 留下的是最后一轮）
    ctx.lastFinalText = turn.text;

    await pump.flush();
    const artifacts = await collectArtifacts(ctx.outputDir, ctx.started);
    if (!turn.ok) {
      return {
        result: {
          ok: false,
          summary: `LLM 运行时（常驻会话）未完成目标：${turn.error ?? '未知原因'}`,
          artifacts,
          steps: [],
          error: makeError('EXECUTION_FAILED', 'LLM_PERSISTENT_TURN_FAILED'),
        },
      };
    }
    return {
      result: await this.maybeResume(
        reconcileApprovalWait(
          {
            ok: true,
            summary:
              `LLM 运行时（常驻会话）完成目标：${input.goal}` +
              (artifacts.length ? `（产出 ${artifacts.length} 个文件）` : ''),
            artifacts,
            steps: [
              {
                index: 0,
                capabilityId: 'appops.workflow.run',
                params: { goal: input.goal, runtime: this.cliPath, session: 'persistent' },
                ok: true,
                risk: 'L1',
                durationMs: turn.durationMs,
                traceId: input.traceId,
                summary: 'LLM 常驻会话自主规划并执行完成',
              },
            ],
          },
          turn.text,
        ),
        input,
        sink,
        ctx,
        'persistent',
      ),
    };
  }

  /** 选择续跑轮文案：有回执=K5「系统已执行」；仅 token=K4「请重发」（灰度 off 路径）。 */
  private resumeTurnText(resume: ResumeTurn): string {
    return 'executed' in resume ? this.executionSuffix(resume.executed) : this.resumeSuffix(resume);
  }

  /**
   * 降级路径（AC1.5）：单次 `-p` 冷启动，语义与改造前**完全一致**。
   */
  private async runOneShot(
    input: LlmGoalInput,
    sink: ProgressSink,
    ctx: RunContext,
    resume?: ResumeTurn,
  ): Promise<LlmGoalResult> {
    const { outputDir, started, cli } = ctx;
    const pump = createArtifactPump(outputDir, started, sink, this.artifactScanIntervalMs);
    // K4/K5：续跑时把续跑指令追加到完整系统提示之后，重新拉起一次 codebuddy。
    // K5 默认注入「服务端已真实执行 + 回执」；灰度 off 时退回「请带 __approvalId 重发」。
    const prompt = resume ? `${ctx.prompt}\n\n${this.resumeTurnText(resume)}` : ctx.prompt;

    sink.onStatus('working', `调起 LLM 运行时：${this.cliPath}`);

    if (!cli.resolved) {
      return {
        ok: false,
        summary:
          `找不到 LLM 运行时「${this.cliPath}」。` +
          `已搜索：${cli.probed.length ? cli.probed.slice(0, 12).join(' ; ') : '(PATH 为空或无可候选)'}。` +
          `建议：在 agent.providers.workbuddy.options.cliPath 填**绝对路径**` +
          `（如 "C:\\\\Program Files\\\\nodejs\\\\codebuddy.cmd"），并确认 codebuddy 已安装。`,
        artifacts: [],
        steps: [],
        error: makeError('PROVIDER_UNAVAILABLE', 'LLM_RUNTIME_MISSING'),
      };
    }

    // 产物目录须预先存在：真机 CLI 会对不存在的 `--add-dir` 目标告警（`... not found`），
    // 且产物扫描依赖该目录存在；创建失败不阻断执行（交由后续扫描/错误处理）。
    try {
      await mkdir(outputDir, { recursive: true });
    } catch {
      /* 目录不可创建时不阻断，交由 CLI 与产物收集自行处理 */
    }

    // D4：`--mcp-config` 支持「文件路径或 JSON 串」。经 cmd.exe 传内联 JSON 会因内层双引号
    // 被 cmd 破坏（真机报「找不到指定路径」），故优先把配置写入文件、只把**路径**放进命令行。
    // 落盘失败（如产物目录不可写）时回退为内联 JSON——POSIX 直接 spawn 无 cmd 引用问题。
    // 单次 -p 是**逐次委派**独立进程 → 可安全拼 dtid（通道 2 精确归因）。
    // 仅在委派上下文（有 taskId）时拼 —— 非委派调用绝不新增 query（旧行为逐字节保持）；
    // 常驻路径（runPersistent）**不传** —— mcp.json 会话级共享，dtid 归因时点错位（见方法注释）。
    const dtid = input.taskId ? input.traceId : undefined;
    const mcpConfigArg = (await this.prepareMcpConfig(outputDir, dtid)) ?? buildMcpConfig(this.endpoint, dtid);

    const args = renderCliArgs(this.argTemplate, {
      goal: input.goal,
      prompt: flattenPromptForCli(prompt),
      endpoint: this.endpoint ?? '',
      output: outputDir,
      skillsDir: ctx.skillsDir,
      mcpConfig: mcpConfigArg,
    });

    return new Promise<LlmGoalResult>((resolveResult) => {
      let child: CliChild | undefined;
      let stderr = '';
      let settled = false;
      /** K3：累计 stdout 文本（供结果如实性检查——甄别 LLM 上报的「等待审批」） */
      let stdoutText = '';

      const finish = (r: LlmGoalResult) => {
        if (settled) return;
        settled = true;
        if (child && !child.killed) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* noop */
          }
        }
        resolveResult(r);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          summary: `LLM 运行时超时（>${Math.round(input.timeoutMs / 1000)}s）`,
          artifacts: [],
          steps: [],
          error: makeError('TIMEOUT', 'LLM_PROVIDER_TIMEOUT'),
        });
      }, input.timeoutMs);

      try {
        child = launchCliProcess(cli, args, process.env);
      } catch (e) {
        clearTimeout(timer);
        finish({
          ok: false,
          summary: `无法启动 LLM 运行时「${cli.path}」：${(e as Error).message}`,
          artifacts: [],
          steps: [],
          error: makeError('PROVIDER_UNAVAILABLE', 'LLM_RUNTIME_MISSING'),
        });
        return;
      }

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stdoutText += text;
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) sink.onStatus('working', t.slice(0, 240));
        }
        pump.maybePump(); // 有进展就顺带扫一次产物目录
      });
      child.stderr?.on('data', (d: Buffer) => {
        const raw = d.toString('utf8');
        stderr += raw;
        const t = raw.trim();
        if (t) sink.onStatus('working', `stderr: ${t.slice(0, 240)}`);
      });

      child.on('error', (e: Error) => {
        clearTimeout(timer);
        finish({
          ok: false,
          summary: `LLM 运行时错误：${e.message}`,
          artifacts: [],
          steps: [],
          error: makeError('PROVIDER_UNAVAILABLE', 'LLM_RUNTIME_ERROR'),
        });
      });

      child.on('close', async (code) => {
        clearTimeout(timer);
        // 真机 codebuddy 在**未登录**时会把错误写到 stderr 但**退出码仍为 0**。若直接按退出码判成功，
        // 就会给出「完成目标」的假结论（违背「如实标注」）。故退出码为 0 时仍需甄别致命 stderr。
        const fatal = isFatalRuntimeStderr(stderr);
        if (code === 0 && fatal) {
          finish({
            ok: false,
            summary: `LLM 运行时未就绪（${stderr.trim().slice(0, 200)}）`,
            artifacts: [],
            steps: [],
            error: makeError('PROVIDER_UNAVAILABLE', 'LLM_RUNTIME_NOT_READY'),
          });
        } else if (code === 0) {
          await pump.flush(); // 收尾：把最后一批产物推送给宿主
          const artifacts = await collectArtifacts(outputDir, started);
          // K5：记录本轮最终文本（供最外层回执反查；续跑轮后写覆盖 → 留最后一轮）
          ctx.lastFinalText = stdoutText;
          // K3 结果如实性检查：LLM 上报「等待审批」时不得断言成功（防结构性假成功）
          // K4：若命中审批拦截且存在 coordinator，挂起 input-required 等宿主批准后续跑；
          //     无 coordinator / 未命中则保持 K3 旧行为（返回「等待审批」）。
          finish(
            await this.maybeResume(
              reconcileApprovalWait(
                {
                  ok: true,
                  summary: `LLM 运行时完成目标：${input.goal}` + (artifacts.length ? `（产出 ${artifacts.length} 个文件）` : ''),
                  artifacts,
                  steps: [
                    {
                      index: 0,
                      capabilityId: 'appops.workflow.run',
                      params: { goal: input.goal, runtime: this.cliPath },
                      ok: true,
                      risk: 'L1',
                      durationMs: Date.now() - started,
                      traceId: input.traceId,
                summary: 'LLM 自主规划并执行完成',
              },
            ],
          },
          stdoutText,
        ),
        input,
        sink,
        ctx,
        'oneshot',
      ),
    );
        } else {
          finish({
            ok: false,
            summary: `LLM 运行时退出码 ${code}` + (stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : ''),
            artifacts: [],
            steps: [],
            error: makeError('EXECUTION_FAILED', `LLM_RUNTIME_EXIT_${code}`),
          });
        }
      });
    });
  }
}
