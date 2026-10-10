/**
 * 审计记录模型（SECURITY-GOVERNANCE.md §4）
 *
 * 哈希链：hash_n = SHA256(canonicalJson(record_n 去掉 hash 字段))
 *         record_n.prevHash = hash_(n-1)
 * 创世记录 prevHash = "GENESIS"
 */

import type { RiskLevel } from './risk.js';

export const GENESIS_HASH = 'GENESIS';

export interface AuditPrincipal {
  /** 宿主 Agent 标识，如 "workbuddy" */
  readonly host: string;
  /** 执行身份（VM 侧用户） */
  readonly user: string;
  /** 通道：mcp | a2a | internal */
  readonly channel: 'mcp' | 'a2a' | 'internal';
}

export interface AuditPolicyDecision {
  readonly allowed: boolean;
  /** 命中的规则描述，便于回溯"为什么允许/拒绝" */
  readonly matchedRule: string;
}

export interface AuditApproval {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  /** dry-run 预览内容哈希，防止审批与实际执行不一致 */
  readonly previewHash: string;
}

/* ==================== K-N1 增量：委派层审计真实性（纯附加可选） ====================
 *
 * 铁律（对齐 CL-018 的「纯附加」纪律）：`AuditRecord` 只增**一个可选顶层字段 `ext`**。
 *  - 旧读者忽略未知字段；
 *  - 新记录的 ext 整体进入 `canonicalJson` 哈希（chain.ts doAppend 对 ext 递归 redact）；
 *  - 历史记录校验不受影响 —— `verifyChain` 从记录自身重算（chain.ts:299-343）。
 * 写入方**必须**用条件展开（`...(x ? { ext: x } : {})`）而非显式 `ext: undefined`：
 * 后者会让 `JSON.stringify` 落盘时丢键，而哈希计算时键仍在 → 重算不一致（假断链）。
 */

/** 委派回合内「一次真实目标能力活动」的聚合（`ext.underlying` 元素） */
export interface DelegationActivity {
  readonly capabilityId: string;
  /** 该能力的聚合结果：任一记录 ok=true 即 true（保守口径） */
  readonly ok: boolean;
  /** 聚合的记录条数 */
  readonly count: number;
  /** 关联审批 ID（blocked 条目承载） */
  readonly approvalId?: string;
  /** 链上 seq 清单（取证指针；≤50 项） */
  readonly auditSeqs: readonly number[];
}

/** `ext.stepsSummary` 元素：壳步骤摘要（≤10 项，summary 各截 200 字符） */
export interface AuditStepSummary {
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly summary?: string;
}

/**
 * 审计扩展字段（K-N1 设计 §2.2 / §7）。
 *
 * 全部可选：`delegation-start` 只带 kind/delegationId/taskId；`delegation-complete` 带终态与
 * 账本聚合；内层回连条目带 `{kind:'inner-call', delegationId, channel}`（通道 2 精确归因）。
 */
export interface AuditExt {
  readonly kind?:
    | 'delegation-start'
    | 'delegation-complete'
    | 'inner-call'
    /**
     * ARCH-05（**纯附加枚举成员**）：一次审批**否定决策**（rejected / timeout / canceled）
     * 的链上取证。病灶：三条决策路径（宿主拒绝、TTL 超时、挂起中被取消）过去只进 `logger`，
     * 链上「谁拒的、拒哪个 approvalId、何时拒」不可证，且 timeout 与普通 failed 折叠成一条。
     */
    | 'approval-decision'
    /**
     * ARCH-06 A2（**纯附加枚举成员**）：服务启动期对**历史归档分片**的校验结论条目。
     * 由 `vm-service` 经**原始 sink**（不经 `wrapAuditSink`）落一条，
     * 用于把「本轮 chainValid 只覆盖 session 范围」这件事补成跨轮可查的证据。
     */
    | 'chain-archive-verify'
    /**
     * Phase 2 · P2-T5 F2（**纯附加枚举成员**）：bearer 守卫**生效自检**结论条目
     * （挂载逻辑求值 + VM 内回连通路判定）。
     *
     * 为什么必须入链（与 `chain-archive-verify` 同族纪律）：`authMode` 是运行期快照，
     * 会被下一次启动覆盖；「本轮启动时守卫是否真在拒、回连是否确证可用」是**跨轮取证**事实
     * ——误开 `enforceBearer` 的危害形态（B3 实证）恰是「委派虚假完成、现场无痕」，
     * 只进 logger 等于没有证据。条目由 `vm-service` 经**原始 sink** 落链（审计自证纪律：
     * 不得经账本装饰器把自己登记成「本回合有活动」，与 `chain-archive-verify` 同 O-7 判据）。
     */
    | 'bearer-selfcheck';
  /** 委派 traceId（= A2A goal.traceId），与内层回连调用建立归因链 */
  readonly delegationId?: string;
  readonly taskId?: string;
  /**
   * ★ 核心事实断言字段：本委派回合服务端账本**零活动**。
   * **恒落**（即使终态 completed）—— 供「零调用但 completed」形态被 grep 出来人工审视（设计 §10-1）。
   */
  readonly zeroInnerCalls?: boolean;
  /** 真实目标能力清单（账本聚合，≤50 项） */
  readonly underlying?: readonly DelegationActivity[];
  /** blocked（等待宿主审批）条目计数 */
  readonly blockedCount?: number;
  /** 常驻不可用 → 单次 -p 降级事实（结构化，替代 summary 文案匹配） */
  readonly downgraded?: boolean;
  readonly downgradeReason?: string;
  /** A2A 终态（completed / failed / rejected …；input-required 挂起不落本条） */
  readonly terminalState?: string;
  readonly stepsSummary?: readonly AuditStepSummary[];
  /** 内层回连调用的通道标注（通道 2） */
  readonly channel?: AuditPrincipal['channel'];
  /**
   * ARCH-05（**纯附加可选**）：审批决策本身。仅当 `kind === 'approval-decision'` 时有意义。
   *
   * 判据顺序**写死**在服务端 `raise` 内：`canceled` > `timeout` > `rejected`
   * —— 取消导致的 `resolve(false)` 不是宿主拒绝，把它记成 rejected 会把「我们自己的取消」
   * 伪装成「人工否决」，取证方向性错误（§4 O-4）。
   *
   * `'approved'` 成员**本批不落链**（批准后重放段天然已有一条 executed 记录，双写会语义重叠
   * 并胀链 —— 设计 §5 第 2 条默认取值），但枚举预留，供 ARCH-09（previewHash）批次复用。
   */
  readonly decision?: 'approved' | 'rejected' | 'timeout' | 'canceled';
  /**
   * ARCH-06 A2（**纯附加可选**）：启动期归档校验的**聚合摘要**。
   * 仅当 `kind === 'chain-archive-verify'` 时有意义。
   *
   * 只记聚合与**断裂分片名清单**、不记逐片明细（防单条体积随分片数线性膨胀）；
   * `broken` 为空数组即「已校验范围内无断裂」—— 注意它是「已校验 subset 内无断裂」，
   * 超出 `maxShards` 未校验的分片**只计数**，不得被读成「全部历史完好」。
   */
  readonly archive?: {
    /** 目录下全部分片数 */
    readonly shardsTotal: number;
    /** 实际逐片校验的分片数（受 maxShards 上界约束） */
    readonly shardsVerified: number;
    /** 校验发现断裂的分片文件名（空数组 = 无断裂） */
    readonly broken: readonly string[];
  };
  /**
   * U-P0-3（**纯附加可选**）：本次放行**免除了本应触发的审批闸**时，免除依据的服务端事实。
   *
   * 为什么必须留痕：dry-run 免批是审批闸上唯一的放行旁路。若链上只有一条 `ok:true` 的
   * executed 记录、而 `policyDecision.matchedRule` 承载的免批事实又无人核对，事后就
   * **无法区分**「这次 L2/L3 免批是合法免批（能力声明 dry-run + 引擎按 A1 双条件放行）」与
   * 「免批被绕过」。grep `ext.bypass` 即得全部免批执行清单（与 `ext.zeroInnerCalls`
   * 「恒落供人工审视」是同一条取证纪律）。
   *
   * 唯一取值（当前）：`'dry-run'` —— 仅当策略引擎命中
   * `allow:dry-run-bypass`（调用方传 `dryRun:true` **且**能力声明 `supportsDryRun===true`）
   * 时，由**服务端**审计装饰器（`vm-service/src/delegation-audit.ts` 的 `bypassTagSink`）写入。
   * 写入方**不得**依据调用方参数自行判定是否免批，一律以 `PolicyVerdict.matchedRule` 为唯一
   * 判据（否则等于把免批判定权交回调用方 —— 正是 U-P0-3 的病灶）。
   */
  readonly bypass?: 'dry-run';
}

export interface AuditRecord {
  readonly seq: number;
  readonly ts: string;
  readonly traceId: string;
  readonly auditId: string;
  readonly principal: AuditPrincipal;
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  /** 已脱敏的参数 */
  readonly params: Record<string, unknown>;
  readonly policyDecision: AuditPolicyDecision;
  readonly approval?: AuditApproval;
  readonly result: {
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly summary?: string;
  };
  /** artifact 的 sha256（不内联大对象） */
  readonly artifacts?: readonly string[];
  /**
   * K-N1（**纯附加可选**）：审计扩展字段。缺席即旧行为（旧记录无此键，校验不受影响）。
   *
   * 写入纪律：**禁止显式 `ext: undefined`** —— `canonicalJson` 会把 undefined 序列化为 `null`
   * 参与哈希，而 `JSON.stringify` 落盘时丢键 → 重算哈希不一致（假断链）。
   * 一律用条件展开：`...(ext ? { ext } : {})`。
   */
  readonly ext?: AuditExt;
  readonly durationMs: number;
  /** 上一条记录哈希（创世为 GENESIS） */
  readonly prevHash: string;
  readonly hash: string;
}

/** 计算哈希前用于序列化的记录形态（去掉 hash 字段） */
export type HashableAuditRecord = Omit<AuditRecord, 'hash'>;
