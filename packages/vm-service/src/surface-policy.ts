/**
 * 面策略（Surface Policy）—— 「一条策略套所有面」在语义上是错的，本文件把差异**显式登记**。
 *
 * ## 为什么需要这个文件（Step 3.2 实测推翻计划书后新增）
 *
 * 计划书 Step 3.2 原文让上游分支直接调 `gateAndExecute(entry, args, ctx)`。
 * 实测（2026-11-24）三处不成立，其中两处是**方向性**错误：
 *
 * | # | 冲突 | 实测证据 |
 * |---|---|---|
 * | ① | `CapabilityEntry` 刻意**不含**执行体字段（`input`/`name`/`supportsDryRun`） | `contracts/src/unified.ts` 文件头明写「不服务于执行体实现」 |
 * | ② | 上游 id（`browser.nav.open`）不在 `CAPABILITY_DOMAINS` | `registry.register()` 抛 `InvalidCapabilityIdError`（域名只有 system/app/storage/gui/appops/meta） |
 * | ③ | **最致命**：引擎第 1 步是 `registry.has()`，registry 只装 vm 面 54 项 | `browser.nav.open` → `allowed=false, rule=registry:unknown-capability` |
 *
 * ③ 的后果是**把「裸奔」变成「全量不可用」** —— 58 个工具从「不过闸但能用」变成
 * 「过闸但 100% 被拒」，比不改更糟。所以本步不能照抄计划书。
 *
 * ## 第二个实测发现：vm 面的参数级策略会**误伤**上游面（比 ③ 更隐蔽）
 *
 * 即使绕开 registry 问题，把上游参数交给 vm 面策略仍是错的：
 *
 * | 调用 | vm 面裁决 | 错在哪 |
 * |---|---|---|
 * | `browser.nav.open {url:'https://example.com/a/b'}` | `pathAllowlist:miss` **拒绝** | url 被当成文件路径，且不在 `C:\Temp\**` 等白名单里 ⇒ 浏览器工具**整体不可用** |
 * | `desktop.input.type {text:'C:\Windows\System32\x'}` | `pathDenylist` **拒绝** | 用户要**输入这段文字**，不是要写这个文件 ⇒ 桌面自动化的常见合法用途被封死 |
 *
 * ⇒ 结论：**参数级策略必须按面隔离**。落地处是 `CorePolicyEngine` 的
 * `surface` 选项（见 `policy/engine.ts` 的同名文档）；本文件负责
 * 「哪个面有哪几组参数策略」的**声明与查询**，是那份隔离的唯一登记处。
 *
 * ## 与引擎侧的分工（避免两处各说一套）
 *
 * - **本文件**：声明 + 查询（`SURFACE_SCOPE` / `scopeOf` / `listSurfaces`）——纯数据，无行为。
 * - **引擎**：执行隔离（构造期决定是否编译参数级正则）。
 *
 * 为什么不把两者并到一处：引擎在 `@winvm/core`（L1a），本文件在 `vm-service`（装配层）。
 * 契约方向是 core 不依赖 vm-service；若把登记表放进 core，则「新增一个面」要么改 core
 * （与它无关的包）、要么绕开类型检查。放装配层则加面只需动装配层一行。
 */

import { SURFACES, type Surface } from '@winvm/contracts';

/**
 * 一个能力面的**参数策略适用性**声明。
 *
 * 「参数策略」指引擎里那几组按**参数值**判定的规则（路径、命令、注册表、受保护进程）。
 * 它们的共同语义是「**这个参数值指向哪个系统资源**」，因此只对真正操作本机资源的面成立。
 *
 * ⚠ 本接口描述的是**参数级**策略。**能力级**判定（risk 审批、能力审批黑/白名单、
 * dry-run 双条件）**不在此列、不受面影响** —— 对任何面都恒生效。
 * 这个区分是本设计的核心边界，改动前请读 `upstream-gate.ts` 文件头。
 */
export interface ParameterPolicyScope {
  /** 是否启用**文件系统路径**策略（pathDenylist / pathAllowlist）。 */
  readonly filesystem: boolean;
  /** 是否启用**命令字符串**策略（commandDenylist）。 */
  readonly command: boolean;
  /** 是否启用**注册表范围**策略（registryRead/WriteAllowlist）。 */
  readonly registry: boolean;
  /** 是否启用**受保护进程**策略（processDenylist）。 */
  readonly process: boolean;
}

/**
 * 面 → 参数策略适用性的**唯一登记表**。
 *
 * 类型是 `Record<Surface, …>`：`Surface` 枚举若新增成员而此处未登记，
 * **编译期即报错**（比运行期发现可靠）。
 */
export const SURFACE_SCOPE: Readonly<Record<Surface, ParameterPolicyScope>> = Object.freeze({
  /**
   * vm 面：真正的本机资源操作，四组全开。
   * ⚠ 这一行必须与改动前**逐字等价** —— 引擎的 `surface` 缺省值也是 `'vm'`，
   * 两者一致才保证「不传 surface 的既有调用点行为不变」。
   */
  vm: Object.freeze({ filesystem: true, command: true, registry: true, process: true }),

  /**
   * browser 面：参数是**指令内容**，不是资源地址。
   * - `url` 是网络地址（不是文件路径）⇒ 不可套 pathAllowlist；
   * - `selector` / `expression` 是 DOM 选择器与**页内 JS**（不是宿主命令）⇒ 不可套 commandDenylist。
   *
   * ⚠ `browser.meta.eval` 的风险**不靠这里管辖**：它是 risk=`L2`，由**能力级审批闸**拦住。
   * 这正是正确的管辖层（「执行任意 JS」该让人看一眼再跑，而不是靠字符串黑名单去猜）。
   * 若有人把 eval 降成 L1，审批闸会静默放行 —— 那道防线在 `upstream-tools.ts` 的
   * risk 标注上，不在本表。
   */
  browser: Object.freeze({ filesystem: false, command: false, registry: false, process: false }),

  /**
   * desktop 面：同上。
   * - `ref` 是快照里的元素引用、`text` 是待输入文字 ⇒ 不是路径；
   * - `app` 是**要启动**的应用名（不是"要操作的受保护进程"）⇒ 不套 processDenylist。
   *
   * ⚠ 刻意**与 browser 各写一份**而不是共用一个常量：两面将来会分化
   * （如给 browser 加「只允许 https」的 url 策略，那是 browser 独有的）。
   * 共用会让「加一条 browser 专属策略」时不小心放宽 desktop。
   * 代价是 4 行重复，收益是**改动不会串面**。
   */
  desktop: Object.freeze({ filesystem: false, command: false, registry: false, process: false }),
});

/** 该面的参数策略适用性。未登记 ⇒ **抛错**（fail-closed，绝不默认放行）。 */
export function scopeOf(surface: Surface): ParameterPolicyScope {
  const s = SURFACE_SCOPE[surface];
  if (!s) {
    // `Record<Surface,…>` 本应在编译期拦住，这里是运行期双保险：
    // 若有人用 `as Surface` 强转绕过了类型检查，此处不能静默返回"全开"或"全关"——
    // 前者会误伤上游面，后者会漏防护 vm 面，两种静默都不可接受。
    throw new Error(
      `[surface-policy] 面 "${String(surface)}" 未登记参数策略适用性：请在 SURFACE_SCOPE 补一行`,
    );
  }
  return s;
}

/**
 * 该面是否**完全**不受参数级策略管辖（即四组全关）。
 *
 * 供装配层与单测做**断言式查询**（例：断言"上游两面都返回 true"）——
 * 比逐字段读 `scopeOf(...).filesystem && ...` 更难写错。
 */
export function hasNoParameterPolicies(surface: Surface): boolean {
  const s = scopeOf(surface);
  return !s.filesystem && !s.command && !s.registry && !s.process;
}

/** 全部已登记的面（顺序与 `SURFACES` 一致，便于稳定输出与断言）。 */
export function listSurfaces(): readonly Surface[] {
  return SURFACES;
}