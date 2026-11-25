/**
 * Agent 装配：把 `agent.planner` 这个**单值**翻译成一次静态注册 + 一次查表（Step 4.4）。
 *
 * ## 为什么要这个文件（它替代了什么）
 *
 * 改动前，`agent.providers.<id>.package` 是一个**包名字符串**，`core/bridge/loader.ts`
 * 用它做 `await import(...)`。也就是说：**配置文件里的一行字符串 = 运行期任意模块加载目标**。
 * 三个后果见 `core/src/bridge/registry.ts` 的文件头（安全面 / 打包面 / 诊断面）。
 *
 * 现在生产者只有两个（`template` / `cli-agent`），「可切换」用不着动态加载 ——
 * 静态二选一即可。本文件就是那个二选一。
 *
 * ## 依赖方向（决定了它**只能**放在 vm-service）
 *
 * | 包 | 依赖 | 能否在此 import adapter |
 * |---|---|---|
 * | `core` | 只有 `contracts` | ❌ 会构成 core → adapter 反向依赖 |
 * | `vm-service` | 两个 adapter（package.json 已声明） | ✅ |
 *
 * 所以「删动态 import」这件事的落点必然是装配层，不是 core。core 只保留那张纯注册表
 * （`registry.ts`），不持有任何具体 adapter 的知识 —— 这个分界与改动前一致，只是
 * 「谁往里注册」从配置字符串变成了本文件的静态映射。
 *
 * ## 为什么仍然走 `registerProviderFactory`（而不是直接 new 出来返回）
 *
 * 这样**生产与测试共用同一条查表逻辑**：生产由本文件按 planner 名注册真实工厂，
 * e2e/单测用 `registerProviderFactory(id, 替身)` 注册替身工厂，随后两者都经
 * `loadProvider()` 命中。若生产另走一条「直接 new」的短路，就会变成两条装配路径 ——
 * 而两条路径必然漂移（这是本仓 K5「重放与 MCP 共用同一段真实执行」的同一纪律）。
 */

import {
  loadProvider,
  registerProviderFactory,
  type AgentProviderConfig,
  type ProviderLoadError,
} from '@winvm/core';
import type { AgentServiceProvider, BridgeContext } from '@winvm/contracts';
// 静态 import：两个 adapter 进入编译产物，包名不再由配置决定
import { createProvider as createTemplateProvider } from '@winvm/adapter-agent-workbuddy';
import { createProvider as createCliAgentProvider } from '@winvm/adapter-agent-workbuddy-llm';

/**
 * planner → 装配描述。
 *
 * `providerId` 沿用改动前的 id 字面量（`workbuddy-deterministic` / `workbuddy`）而**不**
 * 改成 `template` / `cli-agent`：这个 id 会出现在 `/health.provider.id`、审计
 * `principal.host` 的下游展示、以及运维排障时的既有 grep 习惯里。改名属**无收益的观测面
 * 漂移**（老部署的看板会突然认不出），而本步要收敛的是「装配机制」不是「id 命名」。
 *
 * `legacyAliases`：改动前 `agent.provider` 的合法取值就是这些 id。保留它们是**为了干净升级**
 * ——已部署的 `vm-service.config.json` 里写的是 `agent.provider:"workbuddy-deterministic"`，
 * 若这里只认新词，升级瞬间所有老部署会因「配置不存在该 provider」而起不来。
 */
interface PlannerAssembly {
  readonly providerId: string;
  readonly packageName: string;
  readonly factory: (options?: Record<string, unknown>) => AgentServiceProvider;
  readonly legacyAliases: readonly string[];
}

const ASSEMBLY: Readonly<Record<'template' | 'cli-agent', PlannerAssembly>> = Object.freeze({
  template: {
    providerId: 'workbuddy-deterministic',
    packageName: '@winvm/adapter-agent-workbuddy',
    factory: (o) => createTemplateProvider(o as Parameters<typeof createTemplateProvider>[0]),
    legacyAliases: ['workbuddy-deterministic'],
  },
  'cli-agent': {
    providerId: 'workbuddy',
    packageName: '@winvm/adapter-agent-workbuddy-llm',
    factory: (o) => createCliAgentProvider(o as Parameters<typeof createCliAgentProvider>[0]),
    legacyAliases: ['workbuddy'],
  },
});

/** `agent.planner` 的出厂值：与改动前 `agent.provider` 的出厂值指向同一个执行体。 */
export const DEFAULT_PLANNER = 'template' as const;

export type PlannerName = keyof typeof ASSEMBLY;

export function isPlannerName(v: unknown): v is PlannerName {
  return v === 'template' || v === 'cli-agent';
}

/**
 * 把一个 `ServiceConfig.agent` 交给注册表并加载。
 *
 * **解析顺序**（前两条是为了让改动前后的配置都能起来，第 3 条才是本步的主路径）：
 *
 * 1. `agent.planner` 在场且合法 ⇒ 按它装配（**新主键，唯一生产路径**）；
 * 2. `agent.provider` 命中某个 planner 的 `legacyAliases` ⇒ 按对应 planner 装配
 *    （老配置文件零改动继续工作，`agent.planner` 缺席时才走这里）；
 * 3. 以上都不成立 ⇒ **不猜**，抛 `ProviderLoadError`，并在文案里列出两个合法值。
 *
 * 为什么第 3 条不「回落到 template」：静默回落意味着「配置写错了、服务照常起，
 * 但用的是另一个 planner」—— 那会让一次拼写错误变成一次**行为变更**且现场无痕。
 * 与本仓 `mode === 'off'` 分支宁可逐字旧行为、也不做隐式推断是同一条纪律。
 *
 * 若调用方注册过同 id 的工厂（测试替身），**替身优先**并跳过静态工厂注册 ——
 * 否则会把测试的桩覆盖成真实 adapter（e2e 正是靠这条跑起来的）。
 */
export async function loadAgentProvider(
  agent: AgentProviderConfig,
  ctx: BridgeContext,
  deps: {
    /** 已注册的 id 清单（`listRegisteredFactoryIds`），用于「替身优先」判定。 */
    readonly registeredIds: readonly string[];
  },
): Promise<{ provider: AgentServiceProvider; planner: PlannerName }> {
  /**
   * ★ 替身优先（**必须早于 planner 解析**）。
   *
   * 病灶（实测）：e2e/单测用**任意 id**（`winvm-p5-c0-fold` / `winvm-e2e-b10-resident`）
   * 注册桩工厂，而 `resolvePlanner()` 只认两个固定 planner 名。若先解析 planner，
   * 这些替身会在「无法确定 agent planner」处直接被拒 —— 7 条 e2e 断言当场变红，
   * 而它们测的（K6 折叠、常驻形态）与 planner 选择**毫无关系**。
   *
   * 判据：注册表里已有该 id ⇒ 说明这是注入形态（生产不会注册未知 id），原样交给
   * `loadProvider` 查表命中，不参与 planner 解析、也不被静态工厂覆盖。
   * 返回的 `planner` 报 `'template'` 作为**占位**，并在下方注释说明它不是装配事实
   * —— degrade 观测面上宁可给一个明确标注的默认值，也不要让 `/health.planner` 在
   * 测试替身形态下凭空消失（缺席会被读成「这一版没这个字段」）。
   */
  const injected = deps.registeredIds.includes(agent.provider);
  if (injected) {
    const provider = await loadProvider(
      {
        provider: agent.provider,
        providers: {
          [agent.provider]: agent.providers[agent.provider] ?? {
            package: '(injected)',
            options: {},
          },
        },
      },
      ctx,
    );
    return { provider, planner: DEFAULT_PLANNER };
  }

  const resolved = resolvePlanner(agent);
  const asm = ASSEMBLY[resolved];

  // 生产：按 planner 静态注册工厂（若同 id 已注册则说明是注入，上面已提前返回）
  if (!deps.registeredIds.includes(asm.providerId)) {
    registerProviderFactory(asm.providerId, asm.factory);
  }

  const provider = await loadProvider(
    {
      provider: asm.providerId,
      // 生产 entry 只承载 options：`package` 已不再用于 import，但仍要填 ——
      // `AgentProviderConfig` 保留该字段是给 `cli.ts` 的诊断自检用的（见类型注释）。
      providers: {
        [asm.providerId]: { package: asm.packageName, options: agent.providers[asm.providerId]?.options },
      },
    },
    ctx,
  );
  return { provider, planner: resolved };
}

/**
 * 纯解析：`agent` 配置 ⇒ planner 名。**不装配、不注册**，故可直接单测。
 *
 * 抽成独立函数是为了让「配置解析」与「装载」分开 —— 前者是纯函数（可穷举所有配置形态），
 * 后者有副作用（import / init / spawn）。
 */
export function resolvePlanner(agent: {
  readonly planner?: unknown;
  readonly provider?: unknown;
}): PlannerName {
  if (isPlannerName(agent.planner)) return agent.planner;

  if (typeof agent.provider === 'string') {
    for (const [name, asm] of Object.entries(ASSEMBLY)) {
      if (asm.legacyAliases.includes(agent.provider) || agent.provider === name) {
        return name as PlannerName;
      }
    }
  }

  throw new Error(
    `无法确定 agent planner：agent.planner=${JSON.stringify(agent.planner)}，` +
      `agent.provider=${JSON.stringify(agent.provider)}。` +
      `合法值：agent.planner ∈ ('template'|'cli-agent')，` +
      `或沿用旧键 agent.provider ∈ ('workbuddy-deterministic'|'workbuddy')。`,
  );
}

/** 供单测断言「装配表与真实 adapter 的导出对得上」用（不改行为）。 */
export const PLANNER_ASSEMBLY_VIEW: Readonly<
  Record<PlannerName, { providerId: string; packageName: string; legacyAliases: readonly string[] }>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(ASSEMBLY).map(([k, v]) => [
      k,
      { providerId: v.providerId, packageName: v.packageName, legacyAliases: v.legacyAliases },
    ]),
  ) as Record<PlannerName, { providerId: string; packageName: string; legacyAliases: readonly string[] }>,
);

/** 让 `ProviderLoadError` 类型在本文件可用（仅类型引用，避免未使用告警）。 */
export type { ProviderLoadError };