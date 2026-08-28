/**
 * @winvm/contracts —— WinVM Bridge 唯一契约源（L0 规范层）
 *
 * 依赖铁律：本包零依赖，不得依赖任何其它包；所有其它包都可以依赖本包。
 */

export * from './risk.js';
export * from './errors.js';
export * from './capability.js';
export * from './transport.js';
export * from './audit.js';
export * from './bridge.js';
export * from './host.js';

/**
 * A2A v1.0 类型以命名空间导出，避免与 bridge 层的 TaskState / Artifact 同名冲突。
 * 使用：`import { A2A } from '@winvm/contracts'` → `A2A.Task`, `A2A.AgentCard`
 */
export * as A2A from './a2a.js';
