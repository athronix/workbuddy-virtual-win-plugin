/**
 * 默认策略基线（SECURITY-GOVERNANCE.md §3.2）
 *
 * 安全默认值原则：拒绝优先（deny by default）。
 * 黑名单优先级最高，命中即拒；未命中白名单同样拒绝。
 */

import type { RiskLevel } from '@winvm/contracts';

export interface PolicyConfig {
  /** 路径黑名单（glob）。优先级最高，命中即拒。 */
  readonly pathDenylist: readonly string[];
  /** 路径白名单（glob）。未命中即拒。 */
  readonly pathAllowlist: readonly string[];
  /** 命令黑名单（正则）。优先级最高，命中即拒。
   *
   *  Phase 1 ARCH-18：本表**曾有**的姊妹字段「命令白名单」已删除。删除理由（与
   *  `contracts/src/capability.ts` 类型头注释同源，三处一一对应）：
   *  ① 引擎从未读取它（全仓零消费点，`cmdAllowRe` 只编译不比对）；
   *  ② 唯一写入点 `appops.workflow.run` 的能力声明已在 T1 同批删除；
   *  ③ 命令面的真实边界由 `commandDenylist` + 能力风险/审批闸决定，白名单语义在此
   *     只会造成「配了却不生效」的假安全感。
   *  命令策略面**只有黑名单**是本表的既定口径。 */
  readonly commandDenylist: readonly string[];
  /** 禁止操作的进程名（小写，不含 .exe 也可匹配）。 */
  readonly processDenylist: readonly string[];
  /** 允许写入的注册表根键前缀。 */
  readonly registryWriteAllowlist: readonly string[];
  /** 允许读取的注册表根键前缀。 */
  readonly registryReadAllowlist: readonly string[];
  /** 委派默认最高风险 */
  readonly defaultMaxRisk: RiskLevel;
  /** 审批超时（毫秒）。超时按拒绝处理（fail-closed）。 */
  readonly approvalTimeoutMs: number;
  /** 网络端点白名单（HTTP 模式下生效） */
  readonly endpointAllowlist?: readonly string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  // —— 路径黑名单：系统关键区域，任何能力都不得触碰 ——
  pathDenylist: [
    'C:\\Windows\\**',
    'C:\\Program Files\\**',
    'C:\\Program Files (x86)\\**',
    'C:\\ProgramData\\**',
    'C:\\System Volume Information\\**',
    'C:\\Recovery\\**',
    'C:\\Boot*',
    'C:\\bootmgr*',
    'C:\\hiberfil*',
    'C:\\pagefile*',
    'C:\\swapfile*',
    '\\\\?\\**',
    '\\\\*',
  ],

  // —— 路径白名单：默认仅**当前用户**数据区（ARCH-17 收紧）——
  // 旧写法 `C:\Users\**` 覆盖**全体账户**，而 `storage.file.read` 是 L0 免审批 ⇒
  // 跨账户 Profile/桌面/下载在策略层被直接放行，与 SECURITY §3.2 承诺的
  // `C:\Users\<vmuser>\**` 不符。收紧为「`%USERPROFILE%` 运行时展开」而**不是**在默认值里
  // 硬拼用户名：用户名是部署期事实，硬编码必然漂移，且默认值需在不同环境下保持确定性。
  // 展开由 `policy/engine.ts` 的 `expandPolicyPathPattern` 在**模式侧**完成（先展开后归一），
  // 与 config 层的 audit/log/outputDir 走同一份 `expandEnvPath` 实现。
  //
  // ⚠ 展开占位符在 env 缺席时保持**字面原样**（`expandEnvPath` 不吞空串）⇒ 该条目永不匹配
  //   ⇒ 所有绝对路径落 `pathAllowlist:miss` 硬 DENY。方向是 fail-closed：收紧默认值在
  //   非 Windows/离线环境下只会更严，不会误放。运维需要跨账户访问时**显式追加**条目
  //  （`mergePolicy` 对数组做并集，只能加不能减 ⇒ 收紧默认值即永久生效）。
  // 注：`C:\WinVMWorkspace\**` 是插件约定的「生产工作目录」（见 winvm-app-operation skill），
  // 必须全域放行，否则 appops 写入后 storage 无法读回，文档工作流被策略打断。
  pathAllowlist: [
    '%USERPROFILE%\\**',
    'C:\\Users\\Public\\**',
    'C:\\Temp\\**',
    'C:\\tmp\\**',
    'D:\\Data\\**',
    'C:\\WinVMWorkspace\\**',
  ],

  // —— 命令黑名单：不可逆/提权/混淆类 ——
  commandDenylist: [
    '\\bformat\\b',
    '\\bdiskpart\\b',
    '\\bbcdedit\\b',
    '\\bdel\\s+/s\\s+/q',
    '\\brm\\s+-rf\\s+/',
    '\\bcipher\\s+/w',
    '\\breg\\s+delete\\s+HKLM\\\\SYSTEM',
    '\\bnet\\s+user\\b.*\\/add',
    '\\bnet\\s+localgroup\\b.*\\/add',
    '\\btakeown\\b',
    '\\bicacls\\b.*\\bgrant\\b.*:\\(F\\)',
    // 混淆执行：编码命令是绕过审计的典型手法
    '\\-enc(odedcommand)?\\b',
    '\\-e\\s+[A-Za-z0-9+/]{100,}={0,2}',
    'FromBase64String',
    'Invoke-Expression',
    '\\biex\\b',
  ],

  // —— 禁止终止/操作的系统进程 ——
  processDenylist: [
    'lsass',
    'csrss',
    'winlogon',
    'services',
    'smss',
    'wininit',
    'ntoskrnl',
    'system',
    'winvm-service',
  ],

  // —— 注册表可写（S-5 · docs/design/s5-registry-write-allowlist-pairing.md §③(b)）——
  // 本表过去是**死配置**：`engine.ts` 4b 的 `isWrite` 要求动词两侧都有点，真实 ID
  // `system.registry.write` 末段无尾点 ⇒ 恒 false ⇒ 写请求一直按**读**表判定。
  // 修 `isWrite`（(a)）必须与补本表（(b)）**成对同 commit**，否则会把一条今天可用、
  // 且 SKILL.md 明文承诺「HKLM:\SOFTWARE 写入需 L2 审批」的合法流程直接封死
  // （白名单 miss 发生在审批闸之前 ⇒ miss = 硬 DENY，不转「需批准」）。
  // `HKLM:\SOFTWARE\**` 进入写表**不产生无审批写**：`system.registry.write` 风险为 L2，
  // 仍先被审批闸拦（实测：未批 → approval-required / requiresApproval=true）。
  // 必须**两形态并列**（短形 + 长全称），与读表形态保持对称 —— 只写一种形态恰是
  // S-1「写法决定成败」缺陷的复发（§③(b) 注：#7 合入后 canonicalRegistryPath 会归一两侧，
  // 别名条目功能上冗余，但默认值即文档，不把写表行为绑定在归一化上）。
  registryWriteAllowlist: [
    'HKCU:\\**',
    'HKEY_CURRENT_USER\\**',
    'HKLM:\\SOFTWARE\\**',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\**',
  ],
  registryReadAllowlist: [
    'HKCU:\\**',
    'HKEY_CURRENT_USER\\**',
    'HKLM:\\SOFTWARE\\**',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\**',
  ],

  defaultMaxRisk: 'L1',
  approvalTimeoutMs: 120_000,
};

/** 合并用户配置与默认配置：数组字段做并集，标量字段用户优先 */
export function mergePolicy(base: PolicyConfig, override?: Partial<PolicyConfig>): PolicyConfig {
  if (!override) return base;
  const union = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    Array.from(new Set([...(a ?? []), ...(b ?? [])]));

  return {
    pathDenylist: union(base.pathDenylist, override.pathDenylist),
    pathAllowlist: union(base.pathAllowlist, override.pathAllowlist),
    commandDenylist: union(base.commandDenylist, override.commandDenylist),
    processDenylist: union(base.processDenylist, override.processDenylist),
    registryWriteAllowlist: union(base.registryWriteAllowlist, override.registryWriteAllowlist),
    registryReadAllowlist: union(base.registryReadAllowlist, override.registryReadAllowlist),
    defaultMaxRisk: override.defaultMaxRisk ?? base.defaultMaxRisk,
    approvalTimeoutMs: override.approvalTimeoutMs ?? base.approvalTimeoutMs,
    ...(override.endpointAllowlist !== undefined
      ? { endpointAllowlist: override.endpointAllowlist }
      : base.endpointAllowlist !== undefined
        ? { endpointAllowlist: base.endpointAllowlist }
        : {}),
  };
}
