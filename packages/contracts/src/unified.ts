/**
 * 统一能力表（V-NEXT 阶段 2）—— 跨三个工具面的单一张表
 *
 * ## 为什么需要它
 *
 * 系统对 AI 暴露的工具面**实际是三块**，各自独立演进、各自一份清单：
 *
 * | 面 | 通道 | 规模 | 清单事实源 |
 * |---|---|---|---|
 * | `vm` | `POST /mcp`（本仓库 54 个结构性能力） | 54 | `vm-capabilities/src/registry/definitions.ts` |
 * | `browser` | `POST /mcp/browser`（反向代理 stdio 上游 agent-browser） | 33（**全量**，无白名单） | 上游 `tools/list` |
 * | `desktop` | `POST /mcp/desktop`（反向代理 stdio 上游 agent-desktop） | 25（**白名单**，上游共 75） | `vm-service/src/mcp-upstream.ts` 的 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` |
 *
 * 三块合计 **112**。缺统一表时，任何「跨面」的事都得手工枚举三遍 —— 策略引擎要写三套规则、
 * `meta.capability.list` 要拼三段、审批闸要为每个面单独接一次、文档里三张表互相对不上。
 *
 * ## ⚠ 本表 = 「对外**可达**面」，不是「上游**全量**面」
 *
 * 这是最容易搞错的一点，写字面值前必须先想清楚：
 * - `desktop` 上游 `agent-desktop` 有 **75** 个工具，本仓库只代理 **25** 个（白名单之外的调用
 *   在 `McpUpstream.exposedTools()` 就被滤掉）。**25 才是可达数**，75 是「上游有但本系统不放出来」。
 * - `browser` 上游 33 个，无白名单 ⇒ 33 全部可达。
 *
 * ⇒ 表的规模恒等于「用户/模型真能调到的数量」。往表里加一条，等于**对外新增一条可达能力**；
 *   从表里删一条但白名单没删，就是**说谎**（表说没有、实际还能调）。两者必须同步。
 *
 * ## `id` 的命名约定（三段式，与既有能力域名严格同构）
 *
 * 全表 `id` 一律 `<面或域>.<组>.<动作>`，恰好三段，理由不是审美而是**行为等价**：
 * `matchesCapability('system.*', id)` / `matchesCapability('browser.*', id)` 这类域级通配
 * 靠「保留结尾点做前缀匹配」实现（见 `capability.ts` 的 `matchesCapability`）。只要 id 恒为
 * 三段，**同一套通配语义就自动适用于三个面**，策略配置不必区分面写三份语法。
 *
 * | 面 | id 形态 | 例 | 上游工具名 |
 * |---|---|---|---|
 * | `vm` | 与既有能力 id **逐字相同** | `system.service.control` | 无（vm 按 id 自身路由） |
 * | `browser` | `browser.<组>.<动作>` | `browser.nav.open` | `browser_open` |
 * | `desktop` | `desktop.<组>.<动作>` | `desktop.window.maximize` | `desktop_maximize` |
 *
 * 后两个面的 `id` 与上游工具名**不相等**（点是本仓库加的、下划线是上游原样）。
 * 调用方要的是上游工具名 ⇒ 落在可选的 `tool` 字段；`vm` 面无此字段。
 */

import type { RiskLevel } from './risk.js';
import { RISK_LEVELS } from './risk.js';

/**
 * 工具面。三个面**共用同一条隧道**，仅以 `mcpPath` 区分（见 `delivery/install-host.mjs`）：
 * `vm → /mcp`、`browser → /mcp/browser`、`desktop → /mcp/desktop`。
 */
export type Surface = 'vm' | 'browser' | 'desktop';

export const SURFACES: readonly Surface[] = ['vm', 'browser', 'desktop'] as const;

/** 各面的可达能力数（**实测值**，改动须同步 `tests/unit/unified-capability-table.test.js`）。 */
export const SURFACE_EXPECTED_COUNTS: Readonly<Record<Surface, number>> = Object.freeze({
  vm: 54,
  browser: 33,
  desktop: 25,
});

/** 全表规模 = 112（54 + 33 + 25）。 */
export const UNIFIED_TOTAL = 112;

/**
 * 统一能力条目。
 *
 * 刻意**不含** `description` / `input` / `output` / `requiresSession` 等 vm 侧执行体才需要的字段：
 * 本表服务于「跨面**决策**」（审批、白名单、清单展示），不服务于「执行体**实现**」。
 * 需要完整 JSON Schema 时回 `WINDOWS_CAPABILITIES` 查，不要往本表里塞第二份。
 */
export interface CapabilityEntry {
  /**
   * 三段式统一 id。**全表唯一**，是所有跨面引用（策略规则、审计记录、审批回执）的稳定地址。
   * 约束见文件头「`id` 的命名约定」。
   */
  readonly id: string;
  /**
   * 上游工具名 —— **仅当与 `id` 不相等时才出现**。
   *
   * 为什么不做成必填：`vm` 面的 54 个能力按 `id` 自身路由（`WINDOWS_CAPABILITIES` 用 id 索引），
   * 强制它们写一份 `tool: 'system.service.control'` 纯属把同一个字符串写两遍，
   * 且一旦有人只改了一处就产生**静默错调**。缺省即「`tool` 就是 `id`」。
   */
  readonly tool?: string;
  readonly surface: Surface;
  readonly risk: RiskLevel;
  /** 人类可读短标题（`vm` 面取 `CapabilityDefinition.name`）。 */
  readonly title: string;
}

/** 从三段式 id 取首段。`vm` 面首段是 `CapabilityDomain` 之一，另两面是面内分组名。 */
export function deriveDomain(id: string): string {
  const i = id.indexOf('.');
  return i < 0 ? id : id.slice(0, i);
}

/** 该条目实际要调的 tool 名：有 `tool` 用 `tool`，否则 `id` 自身。 */
export function resolveToolName(entry: CapabilityEntry): string {
  return entry.tool ?? entry.id;
}

export class InvalidCapabilityEntryError extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(`Invalid capability entry "${id}": ${reason}`);
    this.name = 'InvalidCapabilityEntryError';
  }
}

/**
 * 构造并校验一个条目。
 *
 * 与 `defineCapability()` 的分工：那个校验的是**执行体契约**（domain 前缀一致性、risk 归一化），
 * 这个校验的是**跨面表**的三条不变式（三段式 / surface 合法 / risk 合法）。
 */
export function defineCapabilityEntry(entry: CapabilityEntry): CapabilityEntry {
  const segs = entry.id.split('.');
  if (segs.length !== 3 || segs.some((s) => s.length === 0)) {
    throw new InvalidCapabilityEntryError(
      entry.id,
      `expected exactly 3 non-empty dot-segments "<x>.<group>.<action>", got ${segs.length}`,
    );
  }
  if (!SURFACES.includes(entry.surface)) {
    throw new InvalidCapabilityEntryError(
      entry.id,
      `surface "${String(entry.surface)}" not in [${SURFACES.join(', ')}]`,
    );
  }
  if (!RISK_LEVELS.includes(entry.risk)) {
    throw new InvalidCapabilityEntryError(
      entry.id,
      `risk "${String(entry.risk)}" not in [${RISK_LEVELS.join(', ')}]`,
    );
  }
  if (!entry.title || entry.title.trim().length === 0) {
    throw new InvalidCapabilityEntryError(entry.id, 'title must be non-empty');
  }
  // 首段必须与 surface 对得上：vm 面首段是六个能力域之一，另两面首段恒等于面名。
  // 这条防的是「把 browser 工具误标成 surface:'vm'」这类**静默错标** ——
  // 它不会让任何调用失败，只会让审批闸按错的面的规则放行。
  if (entry.surface !== 'vm' && deriveDomain(entry.id) !== entry.surface) {
    throw new InvalidCapabilityEntryError(
      entry.id,
      `surface "${entry.surface}" requires id to start with "${entry.surface}.", got "${deriveDomain(entry.id)}."`,
    );
  }
  return entry;
}

/** 校验整张表：逐条合法性 + id 唯一性。返回问题清单（空 = 通过）。 */
export function validateUnifiedTable(table: readonly CapabilityEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of table) {
    try {
      defineCapabilityEntry(entry);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    if (seen.has(entry.id)) problems.push(`duplicate id: ${entry.id}`);
    seen.add(entry.id);
  }
  return problems;
}