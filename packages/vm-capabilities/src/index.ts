/**
 * @winvm/vm-capabilities —— Windows 能力层（L2）
 *
 * 包含：
 *   - ps-bridge 常驻 PowerShell 进程客户端（热路径，NFR-503）
 *   - 四大能力域（system/app/storage/gui）的能力定义注册表
 *   - Windows 会话健康探针（GUI 前置守卫）
 *
 * 实现语言取舍（ADR-3）：PowerShell + .NET 而非 Python —— 零依赖、原生 cmdlet 全覆盖、
 * 可审计（脚本即清单，便于白名单匹配）、与 WorkBuddy 自带运行时一致。
 */

import type { SessionHealth } from '@winvm/contracts';
import type { SessionProbe } from '@winvm/core';

import { PsBridge, type PsBridgeOptions } from './ps-bridge.js';
import { WINDOWS_CAPABILITIES, CAPABILITIES_BY_DOMAIN } from './registry/definitions.js';

export { PsBridge, detectPowerShell, defaultScriptPath, PsBridgeError } from './ps-bridge.js';
export type { PsBridgeOptions, PsCallResult } from './ps-bridge.js';
export { WINDOWS_CAPABILITIES, CAPABILITIES_BY_DOMAIN } from './registry/definitions.js';

/** 平台标识：本能力层仅适用 Windows */
export const PLATFORM = 'windows';

/* ------------------------------ 会话探针 ------------------------------ */

/**
 * Windows 会话健康探针。
 *
 * 通过 ps-bridge 调用 gui.Get-SessionHealth，把 PowerShell 结果映射为契约中的 SessionHealth。
 * 探针失败（如 ps-bridge 未启动）时返回 unavailable —— **绝不猜测为健康**。
 */
export class PsBridgeSessionProbe implements SessionProbe {
  constructor(private readonly bridge: PsBridge) {}

  async probe(): Promise<SessionHealth> {
    try {
      const raw = await this.bridge.call<Record<string, unknown>>('gui', 'Get-SessionHealth', {}, 20_000);
      return {
        sessionId: typeof raw['sessionId'] === 'number' ? raw['sessionId'] : 0,
        windowStation: typeof raw['windowStation'] === 'string' ? raw['windowStation'] : '',
        desktop: typeof raw['desktop'] === 'string' ? raw['desktop'] : '',
        interactive: raw['interactive'] === true,
        locked: raw['locked'] === true,
        blackScreen: raw['blackScreen'] === true,
        state: normalizeState(raw['state']),
        ...(typeof raw['detail'] === 'string' ? { detail: raw['detail'] } : {}),
      };
    } catch (e) {
      return {
        sessionId: 0,
        windowStation: '',
        desktop: '',
        interactive: false,
        locked: false,
        blackScreen: false,
        state: 'unavailable',
        detail: `会话探针失败：${(e as Error).message}`,
      };
    }
  }
}

function normalizeState(v: unknown): SessionHealth['state'] {
  if (v === 'healthy' || v === 'degraded' || v === 'unavailable' || v === 'black-screen') return v;
  return 'unavailable';
}

/** 便捷构造：ps-bridge + 会话探针 */
export function createWindowsRuntime(opts: PsBridgeOptions = {}): {
  bridge: PsBridge;
  sessionProbe: PsBridgeSessionProbe;
} {
  const bridge = new PsBridge(opts);
  return { bridge, sessionProbe: new PsBridgeSessionProbe(bridge) };
}
