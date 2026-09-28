#!/usr/bin/env node
/**
 * WinVM Bridge —— 宿主侧 A2A 委派桥 CLI（stdio MCP server）
 *
 * 宿主 Agent 以 MCP 连接器接入本进程；本进程内部用 A2A client 调 VM 侧 /a2a。
 * 用法（通常由 install-host.mjs 生成的连接器条目自动调用）：
 *   node dist/cli.js --endpoint http://127.0.0.1:18443 [--a2a-path /a2a] [--timeout 600000] [--max-risk L1]
 */

import { pathToFileURL } from 'node:url';

import { DEFAULT_LOCAL_PORT, type RiskLevel, type TransportDecl } from '@winvm/contracts';
import { A2A_TIMEOUT_MS_DEFAULT, ENV_A2A_TIMEOUT_MS, NullLogger, resolveA2aTimeoutMs } from '@winvm/core';
import { McpServer } from '@winvm/mcp-framework';

import { createLazyClientProvider } from './client.js';
import { startStdioBridge } from './stdio.js';
import { createA2aBridgeTools } from './tools.js';

const RISK_LEVELS: readonly RiskLevel[] = ['L0', 'L1', 'L2', 'L3'];

interface CliArgs {
  endpoint: string;
  a2aPath: string;
  timeoutMs: number;
  maxRisk: RiskLevel;
  /** 为空表示不使用 bearer token（回环隧道场景，VM 侧仅监听 127.0.0.1） */
  tokenEnv: string;
  help: boolean;
}

function usage(): string {
  return [
    'WinVM Bridge —— 宿主侧 A2A 委派桥（stdio MCP server）',
    '',
    '用法：winvm-a2a-bridge [选项]',
    '',
    '选项：',
    `  --endpoint <url>   VM 侧服务基址（默认 http://127.0.0.1:${DEFAULT_LOCAL_PORT}）`,
    '  --a2a-path <path>  A2A 端点路径（默认 /a2a）',
    `  --timeout <ms>     单次委派等待上限（优先级：--timeout > 环境变量 ${ENV_A2A_TIMEOUT_MS} > 默认 ${A2A_TIMEOUT_MS_DEFAULT}）`,
    '  --max-risk <L>     默认最高风险：L0/L1/L2/L3（默认 L1）',
    '  --token-env <name> bearer token 环境变量名（默认 WINVM_BEARER_TOKEN）',
    '  -h, --help         显示本帮助',
    '',
    '说明：本进程由宿主 MCP 连接器以 stdio 方式拉起，stdout 仅输出 JSON-RPC。',
    `      委派超时默认 ${A2A_TIMEOUT_MS_DEFAULT}ms（≥150s，不得下调）：VM 内 LLM 运行时首次委派`,
    '      需全额进程级冷启动（真机实测 75–107s），超时属**正常冷启动窗口**而非故障。',
    '',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    endpoint: `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`,
    a2aPath: '/a2a',
    // CL-018 C2：优先级 `--timeout`(CLI) > env `WINVM_A2A_TIMEOUT_MS` > 默认 600000。
    // 先用 env（或默认）打底，`--timeout` 若显式给出再覆盖（见下）。
    timeoutMs: resolveA2aTimeoutMs(process.env),
    maxRisk: 'L1',
    tokenEnv: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--endpoint':
        out.endpoint = argv[++i] ?? out.endpoint;
        break;
      case '--a2a-path':
        out.a2aPath = argv[++i] ?? out.a2aPath;
        break;
      case '--timeout': {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) out.timeoutMs = n; // CLI 显式 → 最高优先级
        break;
      }
      case '--max-risk': {
        const v = argv[++i];
        if (v && (RISK_LEVELS as readonly string[]).includes(v)) out.maxRisk = v as RiskLevel;
        break;
      }
      case '--token-env':
        out.tokenEnv = argv[++i] ?? out.tokenEnv;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

export function buildTransport(args: CliArgs): TransportDecl {
  // 回环（SSH 隧道映射到本机）无需 bearer token；仅显式 --token-env 时才带凭据
  return {
    kind: 'streamable-http',
    url: args.endpoint,
    ...(args.tokenEnv ? { tokenEnv: args.tokenEnv } : {}),
    timeoutMs: args.timeoutMs,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const provider = createLazyClientProvider({
    transport: buildTransport(args),
    a2aPath: args.a2aPath,
    timeoutMs: args.timeoutMs,
  });

  const tools = createA2aBridgeTools({
    clientProvider: provider,
    defaultMaxRisk: args.maxRisk,
    defaultTimeoutMs: args.timeoutMs,
    baseUrl: args.endpoint,
  });

  const server = new McpServer({
    name: 'winvm-a2a-bridge',
    version: '0.1.0',
    tools,
    logger: new NullLogger(),
    instructions:
      'WinVM Bridge A2A 委派桥：用于把**复杂 / 开放性**的 Windows 虚拟机任务交给 VM 内 AI Agent 自主完成。' +
      '单步、结构化、可精确控制的简单任务请改用 winvm 连接器的 MCP 能力工具（点分能力 ID）。' +
      '本连接器的 a2a.delegate 会返回 taskId 与进度；任务挂起审批时返回 approvalId，' +
      '须先向用户展示影响清单、取得确认后再用 a2a.approval.reply 放行，不得代替用户批准。',
  });

  try {
    await startStdioBridge({ server });
  } finally {
    await provider.close().catch(() => undefined);
  }
}

// 仅作为入口运行时执行（被测试或库引用 import 时不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`winvm-a2a-bridge 启动失败：${(e as Error).message}\n`);
    process.exit(1);
  });
}
