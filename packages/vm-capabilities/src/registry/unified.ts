/**
 * 统一能力表的 **vm 面**（54 项）—— 从 `definitions.ts` **派生**，不重写。
 *
 * ## 为什么是派生而不是抄一份
 *
 * `WINDOWS_CAPABILITIES` 已经是 vm 侧的**唯一事实源**：`id` / `name` / `risk` 三件都在里面，
 * 且被 MCP 注册、策略引擎、schema 校验、A2A skill 生成等多处消费。本文件只做**投影**：
 *
 * ```
 * CapabilityDefinition  --project-->  CapabilityEntry
 *   id        ────────────────────────→ id
 *   name      ────────────────────────→ title
 *   risk      ────────────────────────→ risk
 *   （无 tool：vm 面按 id 自身路由，见 contracts/unified.ts 的 tool 字段注释）
 * ```
 *
 * 抄一份字面量表的代价不是「多写 54 行」，而是**两处会漂移**：新增能力时只改 definitions、
 * 忘了改 unified ⇒ 统一表少一条 ⇒ 审批闸对这条能力**静默无规则**（fail-open）。
 * 用 `map` 派生则同一份数据只有一个写入点，漂移在物理上不可能发生。
 *
 * ## ⚠ 本节只覆盖 vm 面。browser / desktop 面去哪了
 *
 * - **desktop 面（已补齐，阶段 2.4）**：见 `./upstream-tools.js` 的 `DESKTOP_TOOLS`。
 *   该常量与 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` **同源派生**（25 条，逐条带 `risk`），
 *   并在模块加载期校验「白名单 ↔ 标注表」双向一致 —— 防 fail-open（见该文件注释）。
 *   为消除成环依赖，白名单常量已**下沉**到本包（owner 2026-11-24 裁定方案 A），
 *   `vm-service/src/mcp-upstream.ts` 改为 re-export 保持调用方 import 不变。
 * - **browser 面（已补齐，阶段 2.3）**：见 `./upstream-tools.js` 的 `BROWSER_TOOLS`（33 条）。
 *   与 desktop 不同，browser **没有白名单**（`defaultUpstreamSpecs()` 不传 `toolAllowlist`
 *   ⇒ 上游全量暴露），因此那 33 条**不是从白名单派生的，是逐条显式声明的**，
 *   并在模块加载期校验「条数 33 / id 无重复 / tool 无重复」。
 *   ⚠ 本面含 **1 条 L2**（`browser.meta.eval`）—— desktop 的 L2=0 来自白名单刻意收窄，
 *   不可据此推断 browser 也没有破坏性动作。
 */

import type { CapabilityEntry } from '@winvm/contracts';
import { defineCapabilityEntry } from '@winvm/contracts';

import { WINDOWS_CAPABILITIES } from './definitions.js';
import { BROWSER_TOOLS, DESKTOP_TOOLS } from './upstream-tools.js';

/**
 * vm 面 54 条。
 *
 * 逐条过 `defineCapabilityEntry`：`definitions.ts` 那边校验的是**执行体契约**，本表要保证的是
 * **跨面表的形状不变式**（三段式 / surface 合法 / risk 合法 / title 非空）。两者不是重复校验：
 * 将来若有人给 `definitions.ts` 加一条 `id: 'foo'`（单段），执行体侧可能仍能跑，
 * 但它在统一表里会**破坏 `foo.*` 通配语义** ⇒ 这里必须炸。
 */
export const VM_CAPABILITIES: readonly CapabilityEntry[] = Object.freeze(
  WINDOWS_CAPABILITIES.map((c) =>
    defineCapabilityEntry({
      id: c.id,
      surface: 'vm',
      risk: c.risk,
      title: c.name,
    }),
  ),
);

/**
 * 按面分组的统一表。
 *
 * 当前 = vm(54) + browser(33) + desktop(25) = **112**（阶段 2 收口）。
 *
 * ⚠ 顺序固定为 `vm → browser → desktop`（与 `contracts` 的 `SURFACES` 常量同序）。
 * `browser` 段是**插在中间**的（2.3 晚于 2.4 落地），没有追加到末尾 ——
 * 顺序若与 `SURFACES` 不一致，任何「按下标取某面第 n 项」的消费方都会错位。
 */
export const UNIFIED_CAPABILITIES: readonly CapabilityEntry[] = Object.freeze([
  ...VM_CAPABILITIES,
  ...BROWSER_TOOLS,
  ...DESKTOP_TOOLS,
]);