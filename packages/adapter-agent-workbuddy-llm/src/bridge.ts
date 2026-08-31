/**
 * LlmBridge —— WorkbuddyLlmProvider 与"LLM 推理运行时"之间的可注入边界。
 *
 * - 生产默认：`CliLlmBridge` 调起 VM 内 WorkBuddy `codebuddy` CLI。
 * - 测试：注入任意 `LlmBridge`（如 MockLlmBridge），使 runGoal 不依赖真实 CLI。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

import type { Artifact, BridgeError, GoalStep, ProgressSink } from '@winvm/contracts';
import { makeError } from '@winvm/contracts';

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
}

/**
 * 默认 CLI 参数契约（占位符在渲染时替换）：
 *   {goal} 用户目标 · {prompt} 系统提示 · {endpoint} 本服务 /mcp · {output} 产物目录 · {skillsDir} 技能包目录
 *
 * ⚠ 该契约尚未在真机 codebuddy 上验证；若实际 CLI 参数不同，
 *   经 provider options.cliArgTemplate 覆盖即可，无需改代码。
 */
export const DEFAULT_CLI_ARG_TEMPLATE: readonly string[] = [
  '--goal',
  '{goal}',
  '--system-prompt',
  '{prompt}',
  '--mcp',
  '{endpoint}',
  '--output',
  '{output}',
];

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
}

export interface LlmBridge {
  runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult>;
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
    '  - 高危操作（L2/L3）须经宿主审批闸，不得自行放行；每步完成后回传截图/中间产物。',
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
}

/** 产物逐步回传的扫描节流间隔 */
const DEFAULT_ARTIFACT_SCAN_INTERVAL_MS = 2000;
/** 单个产物大小上限，超出则跳过（避免把超大文件读进内存回传） */
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

/**
 * 生产默认实现：调起 VM 内 WorkBuddy `codebuddy` CLI 作为 LLM 推理运行时。
 * CLI 契约默认：`codebuddy --goal "<goal>" --system-prompt "<prompt>" --mcp <endpoint> --output <dir>`
 * 进程退出码 0 = 成功；stdout 逐行作为进度回传；产物目录新增文件会被逐步回传。
 */
export class CliLlmBridge implements LlmBridge {
  private readonly cliPath: string;
  private readonly endpoint?: string;
  private readonly argTemplate: readonly string[];
  private readonly artifactScanIntervalMs: number;

  constructor(opts: CliLlmBridgeOptions = {}) {
    this.cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy';
    this.endpoint = opts.endpoint;
    this.argTemplate = opts.cliArgTemplate ?? DEFAULT_CLI_ARG_TEMPLATE;
    this.artifactScanIntervalMs = opts.artifactScanIntervalMs ?? DEFAULT_ARTIFACT_SCAN_INTERVAL_MS;
  }

  async runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult> {
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

    /* 产物逐步回传：节流扫描输出目录，新增文件即推给宿主（不再只在结束时一次性收集） */
    const seen = new Set<string>();
    let lastScan = 0;
    let pumping = false;
    const pumpArtifacts = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        for (const a of await collectArtifacts(outputDir, started)) {
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
    const maybePump = (): void => {
      const now = Date.now();
      if (now - lastScan < this.artifactScanIntervalMs) return;
      lastScan = now;
      void pumpArtifacts();
    };

    sink.onStatus('working', `调起 LLM 运行时：${this.cliPath}`);

    return new Promise<LlmGoalResult>((resolveResult) => {
      let child: ReturnType<typeof spawn> | undefined;
      let stdout = '';
      let settled = false;

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
        child = spawn(
          this.cliPath,
          renderCliArgs(this.argTemplate, {
            goal: input.goal,
            prompt,
            endpoint: this.endpoint ?? '',
            output: outputDir,
            skillsDir,
          }),
          { windowsHide: true, env: process.env },
        );
      } catch (e) {
        clearTimeout(timer);
        finish({
          ok: false,
          summary: `无法启动 LLM 运行时「${this.cliPath}」：${(e as Error).message}`,
          artifacts: [],
          steps: [],
          error: makeError('PROVIDER_UNAVAILABLE', 'LLM_RUNTIME_MISSING'),
        });
        return;
      }

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stdout += text;
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) sink.onStatus('working', t.slice(0, 240));
        }
        maybePump(); // 有进展就顺带扫一次产物目录
      });
      child.stderr?.on('data', (d: Buffer) => {
        const t = d.toString('utf8').trim();
        if (t) sink.onStatus('working', `stderr: ${t.slice(0, 240)}`);
      });

      child.on('error', (e) => {
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
        if (code === 0) {
          await pumpArtifacts(); // 收尾：把最后一批产物推送给宿主
          const artifacts = await collectArtifacts(outputDir, started);
          finish({
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
          });
        } else {
          finish({
            ok: false,
            summary: `LLM 运行时退出码 ${code}`,
            artifacts: [],
            steps: [],
            error: makeError('EXECUTION_FAILED', `LLM_RUNTIME_EXIT_${code}`),
          });
        }
      });
    });
  }
}
