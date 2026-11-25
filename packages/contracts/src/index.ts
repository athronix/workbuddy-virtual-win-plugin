/**
 * @winvm/contracts —— WinVM Bridge 唯一契约源（L0 规范层）
 *
 * 依赖铁律：本包零依赖，不得依赖任何其它包；所有其它包都可以依赖本包。
 */

export * from './risk.js';
export * from './errors.js';
export * from './capability.js';
export * from './schema-check.js';
export * from './transport.js';
export * from './unified.js';
export * from './audit.js';
export * from './bridge.js';
export * from './host.js';
/**
 * 阶段 4（Step 4.1）：`Planner` —— 执行体的单一抽象。
 *
 * ⚠ 放在 `bridge.js` **之后**导出：它 import 了 `bridge.js` 的
 * `GoalRequest`/`GoalResult`/`ProgressSink`，虽然 ESM 的 `export *` 顺序不影响
 * 类型解析，但保持「被依赖者先导出」可让 `index.d.ts` 的阅读顺序与依赖方向一致。
 */
export * from './planner.js';

/**
 * A2A v1.0 类型以命名空间导出，避免与 bridge 层的 TaskState / Artifact 同名冲突。
 * 使用：`import { A2A } from '@winvm/contracts'` → `A2A.Task`, `A2A.AgentCard`
 */
export * as A2A from './a2a.js';
