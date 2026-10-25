#!/usr/bin/env node
/**
 * 连接器账户解析（宿主机侧多账户适配）
 *
 * WorkBuddy 在 ~/.workbuddy/connectors/ 下以「账户 uuid 目录」组织连接器配置。
 * 写入错误目录（如 default）会导致 WorkBuddy 读不到 connector:winvm / connector:winvm-a2a。
 * 本模块集中解析「应当写入哪些账户目录」，供 install-host 循环使用（宿主机=鸿蒙场景必需）。
 *
 * 非账户目录排除（P2-3）：connectors/ 下除账户 uuid 目录外，还有平台内部目录
 * （skills=连接器技能缓存、marketplace-meta=平台市场元数据）——它们不是账户，
 * 枚举/写入必须排除（NON_ACCOUNT_DIRS 单一事实源）：否则 install-host 会往里写
 * mcp.json+每跑备份、uninstall 也会备份改写它，diagnose 更会把它们当账户槽位上报。
 * 安装 / 卸载 / 诊断三路径共用本名单，保持对称。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 当前实测活跃的企业账户 uuid（宿主机=鸿蒙 WorkBuddy）。
 * connectors 目录里除 default 外，被激活的是该 uuid 目录；
 * 连接器必须写入此目录而非 default，否则 WorkBuddy 读不到。
 */
export const KNOWN_ACTIVE_ACCOUNT = '8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8';

/**
 * `~/.workbuddy/connectors/` 下的**非账户目录**（平台内部目录，单一事实源）：
 *  - `skills`：连接器技能缓存（如 connector-winvm），非账户；
 *  - `marketplace-meta`：平台市场元数据，非账户。
 * 枚举账户必须排除——否则 install-host 会往里写 mcp.json+每跑备份、
 * uninstall 也会备份改写它、diagnose 会把它们当账户槽位上报（09-20 起既存怪癖，P2-3 根治）。
 * install-host（安装+卸载）与 diagnose-connectors 三路径共用本名单。
 */
export const NON_ACCOUNT_DIRS = new Set(['skills', 'marketplace-meta']);

/**
 * 解析需要写入连接器配置的目标账户目录 id 列表。
 * 非账户目录（NON_ACCOUNT_DIRS）在枚举时排除；显式 override 是用户意图，
 * 即便名字在排除名单里也放行（优先级最高，先于枚举）。
 * @param {string} hostRoot 宿主机 WorkBuddy 根目录（~/.workbuddy）
 * @param {string} [override] 显式指定单一账户（来自 --account / WINVM_ACCOUNT）；优先级最高
 * @returns {string[]} 账户目录 id 列表（去重，保留传入顺序）
 */
export function resolveAccountIds(hostRoot, override) {
  // 显式 --account 直接覆盖：只写该账户目录（用户意图优先于排除名单）
  if (typeof override === 'string' && override.length > 0) {
    return [override];
  }

  // 默认：先含已知活跃账户，再遍历 connectors/ 下所有子目录（仅目录、排除非账户目录）去重追加
  const ids = [KNOWN_ACTIVE_ACCOUNT];
  const connectorsRoot = join(hostRoot, 'connectors');
  try {
    for (const entry of readdirSync(connectorsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (NON_ACCOUNT_DIRS.has(entry.name)) continue;
      if (!ids.includes(entry.name)) ids.push(entry.name);
    }
  } catch {
    // connectors 目录不存在：仅返回已知活跃账户（install 时该目录会被自动创建）
  }
  return ids;
}
