/**
 * LlmBridge —— WorkbuddyLlmProvider 与"LLM 推理运行时"之间的可注入边界。
 *
 * - 生产默认：`CliLlmBridge` 调起 VM 内 WorkBuddy `codebuddy` CLI。
 * - 测试：注入任意 `LlmBridge`（如 MockLlmBridge），使 runGoal 不依赖真实 CLI。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import type { Artifact, BridgeError, GoalStep, ProgressSink } from '@winvm/contracts';
import { makeError } from '@winvm/contracts';

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
export function buildSystemPrompt(input: LlmGoalInput): string {
  const capList = input.capabilities.length ? input.capabilities.join('\n  - ') : '（无）';
  return [
    '你是运行在 Windows 虚拟机内的 WorkBuddy LLM Agent，负责把用户的自然语言目标转化为对 Windows 应用的实际操作。',
    '',
    '【可用能力（仅可调用以下已注册能力，禁止臆造工具）】',
    `  - ${capList}`,
    '',
    '【执行约束】',
    `  - 每步操作必须通过本服务的 MCP 端点调用上述能力：${input.endpoint ?? '(未配置 endpoint)'}`,
    `  - 所有产物写入：${input.outputDir}`,
    '  - 高危操作（L2/L3）须经宿主审批闸，不得自行放行；每步完成后回传截图/中间产物。',
    '  - 不得直连宿主机、不得访问与任务无关的目录。',
    '',
    `【用户目标】${input.goal}`,
  ].join('\n');
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
}

/**
 * 生产默认实现：调起 VM 内 WorkBuddy `codebuddy` CLI 作为 LLM 推理运行时。
 * CLI 契约（V1）：`codebuddy --goal "<goal>" --system-prompt "<prompt>" --mcp <endpoint> --output <dir>`
 * 进程退出码 0 = 成功；stdout 逐行作为进度回传。
 */
export class CliLlmBridge implements LlmBridge {
  private readonly cliPath: string;
  private readonly endpoint?: string;

  constructor(opts: CliLlmBridgeOptions = {}) {
    this.cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy';
    this.endpoint = opts.endpoint;
  }

  async runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult> {
    const started = Date.now();
    const outputDir = resolve(input.outputDir.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => process.env[n] ?? m));
    const prompt = buildSystemPrompt({ ...input, outputDir });

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
          ['--goal', input.goal, '--system-prompt', prompt, '--mcp', this.endpoint ?? '', '--output', outputDir],
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
