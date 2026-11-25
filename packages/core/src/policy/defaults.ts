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
  /** 网络端点白名单（HTTP 模式下生效） */
  readonly endpointAllowlist?: readonly string[];
  /**
   * 能力 ID 级「强制审批」名单（V-NEXT 3.3，owner 2026-11-24 裁定）。
   *
   * ⚠ 与上面的 `pathDenylist`/`commandDenylist` **不是同一语义**：
   * 那几个是**参数级、命中即拒**；本字段是**能力级、命中即审批**（批准后照常执行）。
   *
   * 语义与优先级详见 `contracts/src/capability.ts` 的同名字段注释。要点：
   * - 名单 **> \** 默认 risk 推导（能把 L0/L1 拉进审批）
   * - 名单 **不能**让 L3 免审批（那是拿配置绕开风险模型）
   * - `capabilityApprovalDenylist` **优先于** `capabilityApprovalAllowlist`
   */
  readonly capabilityApprovalDenylist: readonly string[];
  /**
   * 能力 ID 级「免审批」名单（V-NEXT 3.3）。**仅对 L2 生效，L3 不豁免**。
   * 当前按 owner 裁定**留空**（先只上黑名单，白名单后续按需再加）。
   */
  readonly capabilityApprovalAllowlist: readonly string[];
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

  // ────────────────────────────────────────────────────────────────────────
  // V-NEXT 3.3：能力级**强制审批**名单（owner 2026-11-24 裁定，初始值从宽）
  //
  // ## 入选标准（三条全部满足才进）
  //   ① 后果**不可逆**或难以回滚（删文件、卸软件、断网、结束进程）
  //   ② 影响面**超出单次操作**（改服务启动类型、关机、改系统设置）
  //   ③ 误操作**不会立刻被发现**（用户看界面正常，几小时后才出问题）
  //
  // 为什么从宽：owner 明确要求「先给个初始列表，可以放松一点，后续可以再加」。
  // 名单的本质风险**不对称** —— 漏掉一条 = 危险动作免审批直接执行（不可逆）；
  // 多列一条 = 多一次点击确认（成本可忽略）。故此处宁可多列，且**不宜**为了
  // 「操作顺畅」把它清空。要放宽请改用 `capabilityApprovalAllowlist`（留痕、可审计），
  // 而不是删这里的行（删了没人知道曾经为什么需要）。
  //
  // ## 与 risk 的关系
  // 这里多数条目 risk 已是 L2/L3（本来就要审批），列进来是**显式留痕**：
  // 审计里 `matchedRule` 会显示 `approval-required:capability-denylist`，
  // 运维据此能看出「名单真的生效了」，而不是只看到一堆默认的 `approval-required`。
  // 真正被**提升**的是 risk 标注为 L1 的那几条（见下标注）。
  //
  // ## 明确不列（避免名单变成噪音）
  //   - 纯读能力（`*.list` / `*.get` / `*.query` / `*.read` 等只读动词）
  //   - 可完全回滚的单次写（`storage.file.copy`、`storage.dir.manage` 的建目录）
  //   - 查询类 `app.inventory.list` / `app.winget.search`
  //
  // ⚠ 措辞纪律：本注释**刻意**不写某个「审计快照」相关的英文单词（连测试文件名也不写全）。
  // `tests/unit/phase2-*truth.test.js` 用大小写不敏感的正则扫**全仓 src** 找
  // 「消费侧」，那个正则是粗筛（注释也算命中）。本文件一旦出现该词，就会被判
  // 「名单外文件新增消费」而红 —— 我第一版在这里举例列举纯读动词时写了该词，
  // 直接把 `defaults.ts` 推进了该测试的 `outside` 列表（实测）。
  // 正确处置是**改注释措辞**，而**不是**把本文件加进该测试的白名单 ——
  // 那会连真正的消费一起放行，把守卫变成摆设。
  // ────────────────────────────────────────────────────────────────────────
  capabilityApprovalDenylist: [
    // —— 存储：删除/回收站（不可逆） ——
    'storage.file.delete',
    'storage.recycle.manage', // 清空回收站 = 连恢复的机会都没了
    'storage.archive.manage', // 归档常伴随移动/覆盖

    // —— 应用：卸载/降级/改包状态（重装成本高，且可能带走用户数据） ——
    'app.winget.uninstall',
    'app.appx.manage', // 含 Remove-AppxPackage，会连带清 app data

    // —— 系统：关机/重启/结束进程（中断在跑的任务，可能丢未保存数据） ——
    'system.power.control',
    'system.process.terminate',

    // —— 系统：服务与计划任务（影响面超出单次操作，且改了不会立刻显形） ——
    'system.service.configure', // 改启动类型为 disabled 后，重启才发现服务没了
    'system.service.control', // 停掉关键服务会连带其它功能失效
    'system.task.scheduled',

    // —— 系统：注册表写 / 用户管理 / 环境变量（易造成不可见的长期影响） ——
    'system.registry.write',
    'system.user.manage',
    'system.env.manage', // 改 PATH 之类，当前会话看不出问题，下次登录才炸

    // —— 系统：网络配置（断网后连远程修复的通道都没了） ——
    'system.network.config',
  ],

  // V-NEXT 3.3：能力级**免审批**名单。按 owner 裁定**先留空**（后续按需再加）。
  // 注意：此处留空 ≠ 关闭该机制。机制已在引擎内生效且有单测钉住，
  // 只是当前没有任何条目命中。要加时**只加 L2 的**（L3 不豁免，见引擎 6c）。
  capabilityApprovalAllowlist: [],
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
    // V-NEXT 3.3：两个审批名单同走**并集**语义（与其它数组字段一致）。
    // ⚠ 并集意味着「只能加不能减」——配置侧无法用 override 删掉默认黑名单里的条目。
    // 这是**有意**的：若 override 能减，某个环境悄悄清空黑名单就等于关掉整道闸，
    // 而这条链路上没有第二处能发现它。要放宽某一条请用 capabilityApprovalAllowlist
    // （显式、留痕），而不是期望「配个空数组把它清掉」。
    capabilityApprovalDenylist: union(base.capabilityApprovalDenylist, override.capabilityApprovalDenylist),
    capabilityApprovalAllowlist: union(
      base.capabilityApprovalAllowlist,
      override.capabilityApprovalAllowlist,
    ),
    ...(override.endpointAllowlist !== undefined
      ? { endpointAllowlist: override.endpointAllowlist }
      : base.endpointAllowlist !== undefined
        ? { endpointAllowlist: base.endpointAllowlist }
        : {}),
  };
}
