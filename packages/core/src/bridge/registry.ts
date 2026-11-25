/**
 * Agent provider 装配的**进程内工厂注册表**（Step 4.4 改造后）。
 *
 * ## 本文件曾经叫 `loader.ts`，且会动态 import
 *
 * 改动前这里有一个 `await import(entry.package)`：配置文件里一个字符串
 * （`agent.providers.<id>.package`）就是**运行期任意模块的加载目标**。三个后果：
 *
 * | # | 后果 | 具体形态 |
 * |---|---|---|
 * | ① | 安全面 | 配置文件（运维/安装脚本可改写）等价于「任意代码加载开关」，与「配置只是参数」的直觉相反 |
 * | ② | 打包面 | 两个 adapter 无法被静态分析进产物，只能靠 `node_modules` 解析；打错包名直到运行期才炸 |
 * | ③ | 诊断面 | 包名写错只得到「无法 import 包 X」，而真正该回答的问题是「你配的是哪个 planner」 |
 *
 * 现在生产者只有**两个**（`template` / `cli-agent`），「可切换」不需要动态加载来支撑
 * —— 静态二选一即可，且由 `vm-service/src/agent-assembly.ts` 显式 import 完成。
 *
 * ## 保留下来的注册表**不是**生产装配路径
 *
 * 它是**测试注入通道**：e2e / 单测用 `registerProviderFactory(id, ...)` 塞进替身
 * provider，再让 `ServiceConfig.agent.providers[id]` 声明占位 entry。这条路必须留 ——
 * 否则「常驻形态 / 折叠翻转 / 零调用」这类只能端到端观察的行为，就得靠真跑 codebuddy CLI
 * 才能测，等于不测。
 *
 * 生产为什么也走这里：`agent-assembly.ts` 在装配期把两个 adapter 的 `createProvider`
 * **按 planner 名注册**进本表，随后统一 `loadProvider` 查表命中。于是「生产」与「测试」
 * 共用同一条查表逻辑、只差谁注册的工厂 —— 而不是两条各自漂移的装配路径。
 *
 * ## 依赖方向
 *
 * `core` 的依赖只有 `contracts`（见 package.json），**不能** import 两个 adapter。
 * 故静态 import 只能落在 `vm-service`（它本来就依赖两个 adapter），本文件保持纯注册表。
 */

import type { AgentServiceProvider, BridgeContext, PlannerId } from '@winvm/contracts';

export interface ProviderEntry {
  /**
   * 包名。
   *
   * ⚠ Step 4.4 起**装配路径不再用它做 import**（本包已删动态 import）。
   * 保留原因：`vm-service/src/cli.ts` 的 `probeProvider()` 仍用它做 `winvm doctor` 的
   * 「包可解析 + 导出 createProvider」自检 —— 那是**诊断**职责，不是装配职责，
   * 让诊断路径保留动态 import 是恰当的（诊断本来就该验真实解析行为）。
   */
  readonly package: string;
  readonly options?: Record<string, unknown>;
}

export interface AgentProviderConfig {
  /**
   * ★ Step 4.4 新增的**唯一生产装配键**：用哪个 planner。
   *
   * 之前「用哪个执行体」是由 `provider`（一个字符串 id）决定的，而那个 id 又要到
   * `providers` 表里查包名再动态 import。现在收敛成一句：选 `template` 还是 `cli-agent`。
   *
   * 类型复用 `contracts` 的 `PlannerId`（`'template' | 'cli-agent'`）而**不另写一份字面量
   * 联合** —— 抄一份枚举就等着它独立漂移（新增 planner 时只改一处、这里悄悄失配）。
   *
   * 可选：缺席 ⇒ 走 `agent.provider` 的旧键兼容路径（见 `vm-service/src/agent-assembly.ts`
   * 的解析顺序），使已部署的老配置文件零改动继续启动。
   */
  readonly planner?: PlannerId;
  /** 当前启用的 provider id（旧键：Step 4.4 起降级为兼容/诊断用途） */
  readonly provider: string;
  /**
   * 装配表。
   *
   * ⚠ Step 4.4 起它的角色变了：**不再是「可插拔目录」，而是「测试注入通道 + options 载体」**。
   * 具体地：
   *  - **生产**：`agent-assembly.ts` 按 `planner` 静态注册工厂，本表只提供 `options`
   *    （如 `skillsRoot` / `bearerEnvName`），`package` 字段在生产装配路径上**不被读取**；
   *  - **测试**：e2e/单测用 `registerProviderFactory(id, 替身)` 塞入桩，并在本表声明占位
   *    entry —— 这是观测「常驻形态 / 折叠翻转 / 零调用」的唯一通道，删不得。
   *
   * 保留 `provider` + `providers` 而不按原计划整体删除，正是因为实测发现它同时还是
   * `http-guard` 的 bearer fail-closed 判据源（读 `options.bearerEnvName`）与
   * `install-vm.mjs` 的配置注入点。把它们一起删掉会让「守卫已生效但凭据未接线」
   * 这条判据失去数据来源。
   */
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

/** 进程内工厂注册表：生产由 `agent-assembly.ts` 按 planner 名注册，测试注册替身。 */
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

/**
 * 按配置取出并初始化 provider。
 *
 * ## 与改动前的两处语义差异（都是刻意的）
 *
 * | 维度 | 改动前 | 改动后 |
 * |---|---|---|
 * | 工厂来源 | 先查注册表，**再回落到 `await import(package)`** | **只查注册表**；未注册即失败 |
 * | 失败文案 | 「包 X 未导出 createProvider」 | 指明「planner 未注册」，并把可用 id 列出来 |
 *
 * 第 2 条不是文案美化：改动前的文案会把读者引向「检查包有没有导出 createProvider」，
 * 而真实原因（planner 名没接上装配）根本不是那个方向 —— 错误信息指错方向比不给信息更贵。
 *
 * 失败语义（SECURITY §3.4）不变：抛出 `ProviderLoadError`，调用方必须据此把服务置为
 * degraded 且仅暴露 `meta.*` 能力，**绝不静默降级为无限制执行**。
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

  const factory = factories.get(id);
  if (!factory) {
    throw new ProviderLoadError(
      id,
      `尚未注册该 id 的装配工厂。已注册：${listRegisteredFactoryIds().join(', ') || '(空)'}。` +
        `生产形态请检查 agent.planner 是否在 ('template'|'cli-agent') 内 —— ` +
        `两个 adapter 由 vm-service/src/agent-assembly.ts 静态注册；` +
        `测试形态请先调用 registerProviderFactory("${id}", ...)。`,
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