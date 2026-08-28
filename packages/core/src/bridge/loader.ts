/**
 * 标准 Agent 服务桥接转换层 —— Provider 加载器（SPEC-AGENT-SERVICE-BRIDGE.md §5）
 *
 * 换 VM 内 Agent 只需：新增一个实现包 + 改配置项 agent.provider。
 * core / mcp-framework / a2a-framework / skills 全部零改动。
 */

import type { AgentServiceProvider, BridgeContext } from '@winvm/contracts';

export interface ProviderEntry {
  /** 可动态 import 的包名，如 "@winvm/adapter-agent-workbuddy" */
  readonly package: string;
  readonly options?: Record<string, unknown>;
}

export interface AgentProviderConfig {
  /** 当前启用的 provider id */
  readonly provider: string;
  readonly providers: Readonly<Record<string, ProviderEntry>>;
}

export class ProviderLoadError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`加载 Agent provider "${providerId}" 失败：${message}`);
    this.name = 'ProviderLoadError';
  }
}

export type ProviderFactory = (
  options?: Record<string, unknown>,
) => AgentServiceProvider | Promise<AgentServiceProvider>;

/** 进程内工厂注册表：优先于动态 import，便于单测与打包场景 */
const factories = new Map<string, ProviderFactory>();

export function registerProviderFactory(id: string, factory: ProviderFactory): void {
  factories.set(id, factory);
}

export function unregisterProviderFactory(id: string): void {
  factories.delete(id);
}

export function listRegisteredFactoryIds(): string[] {
  return [...factories.keys()];
}

interface ProviderModuleShape {
  createProvider?: ProviderFactory;
  default?: ProviderFactory | { createProvider?: ProviderFactory };
}

function extractFactory(mod: unknown): ProviderFactory | undefined {
  if (!mod || typeof mod !== 'object') return undefined;
  const m = mod as ProviderModuleShape;
  if (typeof m.createProvider === 'function') return m.createProvider;
  if (typeof m.default === 'function') return m.default;
  const dflt = m.default as ProviderModuleShape | undefined;
  if (dflt && typeof dflt.createProvider === 'function') return dflt.createProvider;
  return undefined;
}

/**
 * 按配置加载并初始化 provider。
 *
 * 失败语义（SECURITY §3.4）：抛出 ProviderLoadError —— 调用方必须据此
 * 将服务置为 degraded 并仅暴露 meta.* 能力，**绝不静默降级为无限制执行**。
 */
export async function loadProvider(
  cfg: AgentProviderConfig,
  ctx: BridgeContext,
): Promise<AgentServiceProvider> {
  const id = cfg.provider;
  const entry = cfg.providers[id];
  if (!entry) {
    throw new ProviderLoadError(
      id,
      `配置中不存在该 provider。可用：${Object.keys(cfg.providers).join(', ') || '(空)'}`,
    );
  }

  let factory = factories.get(id);

  if (!factory) {
    try {
      const mod = await import(entry.package);
      factory = extractFactory(mod);
    } catch (e) {
      throw new ProviderLoadError(id, `无法 import 包 ${entry.package}`, e);
    }
  }

  if (!factory) {
    throw new ProviderLoadError(
      id,
      `包 ${entry.package} 未导出 createProvider（也未注册进程内工厂）`,
    );
  }

  const provider = await factory(entry.options);
  try {
    await provider.init(ctx);
  } catch (e) {
    throw new ProviderLoadError(id, `init() 失败：${(e as Error).message}`, e);
  }
  return provider;
}
