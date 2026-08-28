/**
 * @winvm/vm-service —— VM 侧标准 Agent 服务（L2）
 *
 * 统一暴露 MCP（主干）与 A2A v1.0（委派）双通道，二者共享同一内核：
 *   能力注册表 → 策略引擎 → 审批闸 → 审计链 → 桥接层 → 能力执行
 */

export { createService } from './server.js';
export type { ServiceRuntime, PendingApproval } from './server.js';
export { DEFAULT_SERVICE_CONFIG, loadServiceConfig } from '@winvm/core';
export type { ServiceConfig } from '@winvm/core';
