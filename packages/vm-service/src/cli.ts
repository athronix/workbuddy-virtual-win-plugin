#!/usr/bin/env node
/**
 * WinVM Bridge —— VM 侧服务 CLI 入口
 *
 * 用法：
 *   winvm-service [--config <path>] [--port <n>] [--host <addr>]
 *
 * ⚠ 运行形态铁律（SECURITY-GOVERNANCE.md §5.2）：
 *   本进程**必须在交互式用户会话内启动**（登录自启 / 计划任务「仅在用户登录时运行」/ 托盘程序）。
 *   注册为 Windows 服务会落入 Session 0，导致截图黑屏与 SendInput 拒绝访问。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCapabilityId } from '@winvm/contracts';
import { DEFAULT_SERVICE_CONFIG, loadServiceConfig, type ServiceConfig } from '@winvm/core';
import {
  CAPABILITIES_BY_DOMAIN,
  WINDOWS_CAPABILITIES,
  createWindowsRuntime,
} from '@winvm/vm-capabilities';

import { createService } from './server.js';

interface CliArgs {
  config?: string;
  port?: number;
  host?: string;
  selfTest?: boolean;
  help?: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--config':
      case '-c':
        out.config = argv[++i];
        break;
      case '--port':
      case '-p':
        out.port = Number(argv[++i]);
        break;
      case '--host':
        out.host = argv[++i];
        break;
      case '--self-test':
        out.selfTest = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
    }
  }
  return out;
}

function usage(): string {
  return [
    'WinVM Bridge —— VM 侧标准 Agent 服务',
    '',
    '用法：winvm-service [选项]',
    '',
    '选项：',
    '  -c, --config <path>   配置文件路径（JSON）',
    '  -p, --port <n>        监听端口（默认 18443）',
    '      --host <addr>     监听地址（默认 127.0.0.1；**严禁改为 0.0.0.0**）',
    '      --self-test       自检（验证配置 / 能力注册表 / ps-bridge 模块加载）后退出',
    '  -h, --help            显示本帮助',
    '',
    '端点：',
    '  POST /mcp                         MCP 主干通道',
    '  POST /a2a                         A2A v1.0 委派通道（支持 SSE）',
    '  GET  /.well-known/agent-card.json  A2A 发现',
    '  GET  /health                      健康检查',
    '',
  ].join('\n');
}

/**
 * 自检：验证配置红线 + 能力注册表结构 + ps-bridge 模块可加载（启动即 dot-source 全部 psmod/*.ps1）。
 * 仅做只读探针，不启动 HTTP 服务，检查完即退出。
 */
/**
 * 轻量探测选中的 Agent provider 包：动态 import → createProvider → declareCapabilities。
 * 不调用 init()（无需完整 BridgeContext），仅验证「包可解析、导出 createProvider、能力目录可用」。
 */
async function probeProvider(agentCfg: ServiceConfig['agent']): Promise<{
  id: string;
  kind: string;
  caps: readonly string[];
}> {
  const id = agentCfg.provider;
  const entry = agentCfg.providers[id];
  if (!entry) {
    throw new Error(
      `agent.provider="${id}" 未在 agent.providers 中定义。可用：${Object.keys(agentCfg.providers).join(', ') || '(空)'}`,
    );
  }
  let mod: unknown;
  try {
    mod = await import(entry.package);
  } catch (e) {
    throw new Error(`无法 import 包 ${entry.package}：${(e as Error).message}`);
  }
  const m = mod as { createProvider?: (o?: Record<string, unknown>) => unknown; default?: unknown };
  let factory = m.createProvider;
  if (typeof factory !== 'function') {
    const dflt = m.default as { createProvider?: (o?: Record<string, unknown>) => unknown } | undefined;
    if (dflt && typeof dflt.createProvider === 'function') factory = dflt.createProvider;
  }
  if (typeof factory !== 'function') {
    throw new Error(`包 ${entry.package} 未导出 createProvider`);
  }
  const provider = (await factory(entry.options ?? {})) as {
    id: string;
    kind: string;
    declareCapabilities: () => readonly string[];
  };
  return { id: provider.id, kind: provider.kind, caps: provider.declareCapabilities() };
}

async function selfTest(config: ServiceConfig): Promise<void> {
  process.stdout.write('== WinVM Bridge 自检 ==\n');

  // 1. 安全红线：仅监听回环
  if (config.server.host !== '127.0.0.1') {
    throw new Error(`安全红线：VM 服务必须仅监听 127.0.0.1，当前为 "${config.server.host}"`);
  }

  // 2. 能力注册表结构校验（ID 必须为 <domain>.<group>.<action> 三段）
  let badIds = 0;
  for (const c of WINDOWS_CAPABILITIES) {
    try {
      parseCapabilityId(c.id);
    } catch {
      badIds++;
      process.stderr.write(`  ✗ 非法能力 ID：${c.id}\n`);
    }
  }
  if (badIds > 0) throw new Error(`${badIds} 个能力 ID 非法`);
  const domains = Object.keys(CAPABILITIES_BY_DOMAIN);
  process.stdout.write(`  能力域 ：${domains.length} 个（${domains.join(' / ')}）\n`);
  process.stdout.write(`  能力总数：${WINDOWS_CAPABILITIES.length} 项\n`);

  // 2.5 provider 能力目录校验（验证 agent.provider 指向的包可加载并声明能力目录）
  try {
    const { id, kind, caps } = await probeProvider(config.agent);
    const provDomains = [...new Set(caps.map((c) => c.split('.')[0]))];
    process.stdout.write(`  provider ：${id}（${kind}）\n`);
    process.stdout.write(`  声明能力 ：${caps.length} 项，覆盖 ${provDomains.length} 个能力域（${provDomains.join(' / ')}）\n`);
  } catch (e) {
    process.stderr.write(`  ✗ provider 能力目录校验失败：${(e as Error).message}\n`);
    throw new Error(`provider 校验失败：${(e as Error).message}`);
  }

  // 3. ps-bridge 模块加载（握手失败即说明某 psmod/*.ps1 有语法/加载错误）
  const { bridge } = createWindowsRuntime();
  await bridge.start();
  process.stdout.write('  ps-bridge 已启动，模块加载正常\n');
  try {
    const modules = [...new Set(WINDOWS_CAPABILITIES.map((c) => c.implementation.module))];
    for (const mod of modules) {
      const probe = WINDOWS_CAPABILITIES.find(
        (c) => c.implementation.module === mod && c.risk === 'L0' && !c.requiresSession,
      );
      if (!probe) {
        process.stdout.write(`  · 模块 ${mod}：无 L0 无会话探针，跳过\n`);
        continue;
      }
      try {
        await bridge.call(mod, probe.implementation.function, {}, 15_000);
        process.stdout.write(`  · 模块 ${mod}：探针 ${probe.implementation.function} OK\n`);
      } catch (e) {
        process.stdout.write(
          `  · 模块 ${mod}：探针警告（${(e as Error).message}）—— 多为环境相关，非模块加载错误\n`,
        );
      }
    }
  } finally {
    await bridge.stop();
  }
  process.stdout.write('自检通过 ✅\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  let config: ServiceConfig = DEFAULT_SERVICE_CONFIG;
  if (args.config) {
    const p = resolve(args.config);
    if (!existsSync(p)) {
      process.stderr.write(`配置文件不存在：${p}\n`);
      process.exitCode = 1;
      return;
    }
    config = await loadServiceConfig(p);
  }
  if (args.port !== undefined && Number.isFinite(args.port)) {
    config = { ...config, server: { ...config.server, port: args.port } };
  }
  if (args.host) {
    config = { ...config, server: { ...config.server, host: args.host } };
  }

  if (args.selfTest) {
    await selfTest(config);
    return;
  }

  const runtime = await createService(config);

  process.stdout.write(
    `WinVM Bridge 已启动\n` +
      `  监听      http://${config.server.host}:${runtime.port}\n` +
      `  MCP       POST /mcp\n` +
      `  A2A       POST /a2a   AgentCard /.well-known/agent-card.json\n` +
      `  暴露能力  ${runtime.exposedCapabilities.length} 项\n` +
      `  审计目录  ${config.audit.dir}\n` +
      `  Provider  ${runtime.provider?.id ?? '(未就绪，degraded)'}\n`,
  );

  const shutdown = async (signal: string) => {
    process.stdout.write(`\n收到 ${signal}，正在优雅关闭…\n`);
    try {
      await runtime.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`启动失败：${(e as Error).message}\n`);
  process.exit(1);
});
