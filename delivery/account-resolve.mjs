#!/usr/bin/env node
/**
 * 连接器账户解析（宿主机侧多账户适配）
 *
 * WorkBuddy 在 ~/.workbuddy/connectors/ 下以「账户 uuid 目录」组织连接器配置。
 * 写入错误目录（如 default）会导致 WorkBuddy 读不到 connector:winvm / connector:winvm-a2a。
 * 本模块集中解析「应当写入哪些账户目录」，供 install-host 循环使用（宿主机=鸿蒙场景必需）。
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
 * 解析需要写入连接器配置的目标账户目录 id 列表。
 * @param {string} hostRoot 宿主机 WorkBuddy 根目录（~/.workbuddy）
 * @param {string} [override] 显式指定单一账户（来自 --account / WINVM_ACCOUNT）；优先级最高
 * @returns {string[]} 账户目录 id 列表（去重，保留传入顺序）
 */
export function resolveAccountIds(hostRoot, override) {
  // 显式 --account 直接覆盖：只写该账户目录
  if (typeof override === 'string' && override.length > 0) {
    return [override];
  }

  // 默认：先含已知活跃账户，再遍历 connectors/ 下所有子目录（仅目录）去重追加
  const ids = [KNOWN_ACTIVE_ACCOUNT];
  const connectorsRoot = join(hostRoot, 'connectors');
  try {
    for (const entry of readdirSync(connectorsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!ids.includes(entry.name)) ids.push(entry.name);
    }
  } catch {
    // connectors 目录不存在：仅返回已知活跃账户（install 时该目录会被自动创建）
  }
  return ids;
}
