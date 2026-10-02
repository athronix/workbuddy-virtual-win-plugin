# R19-B 缺陷修复契约：S-1 注册表路径形态归一化 + K-N2 dry-run 预览语义（R-B2 定稿）

- **文档性质**：**权威设计契约（定稿）**。本文是 S-1 / K-N2 两项修复的**唯一判定依据**；此前该契约只存在于会话上下文（评审与裁决记录），未落盘 —— 本文即任务板 #17 的落盘产物。落盘后任何与本文件不一致的口头/会话表述一律以本文为准；本文自身的缺陷按 §6 流程**开新单修订**，不允许实现侧「边写边改契约」。
- **缺陷来源**：`docs/test/reports/real-test-2026-09-30-r19.md`（真机轮 R19-B，HEAD 基线 `9139239`）
  - S-1：§5「策略/环境类」表 S-1 行、§7 遗留项 **L6**、§6 复现脚本 **R-7**、§3 E2「子步 BLOCKED」段；
  - K-N2：§5「K-N2」小节（Severity **Medium**）、§7 遗留项 **L3**、§6 复现脚本 **R-6**、§2 观测 **OBS-B**、§6「未复现清单」第 4 项（R-0 预捕获产物级工件）。
- **定稿链**：software-architect（Bob，任务板 #5 交接）提出 R-B2 → 主理人独立核验批准 → software-engineer-3（任务板 #7）背书并落盘。
- **作者/落盘人**：software-engineer-3 · 任务板 #17。
- **硬约束遵守**：最小变更、不重构；所有结论先读码后设计，引用一律 `file:line`。
- **范围排除（明确不动）**：委派/审计层 —— `packages/vm-service/src/server.ts` 的审计写入分支、`packages/adapter-agent-workbuddy-llm/src/bridge.ts` 的 `reconcileExecutionTruth`（属 K-N1，见 `docs/design/kn1-delegation-audit-contract.md`，任务板 #5/#26）。**S-4（`POLICY_DENIED` 不落审计）不在本契约范围**：K-N1 契约 §2.2 末已明确排除、报告 §5 S-4 行亦「仅登记不推动」；本文只在 §5-A5 留一条交叉核对提示。
  > **数据来源说明（避免误引）**：本文**只**引用 `real-test-2026-09-30-r19.md`（真机五例复跑 + 181 条审计链离线复核）与 `qa/r19/*.resp.json` 原始回执。`docs/test/reports/real-test-2026-10-02-e3e4retest.md`（E3/E4 复测）**不是**本文依据；`real-test-2026-09-28-uninstall-wecom.md` 等早期轮次仅作「同一缺陷跨轮次重现」的背景旁证，不作为判定证据。仓库内**不存在** 2026-07-25 的任何数据文件，故本文不引用该日期数据（曾有误引，见 §6）。

---

## TL;DR

**S-1** 的根因不在白名单表，而在**采集层盘符正则**与**候选过滤器**的不对称：`extractPathTokens()` 的 `[A-Za-z]:\\` 把 `HKLM:\SOFTWARE\…` 的尾字母 `M` 当盘符，切出伪盘符 `M:\SOFTWARE\…`；该串既不像注册表路径、又不在文件系统白名单内 → `POLICY_DENIED(matchedRule=pathAllowlist:miss)`，而 `HKLM\…`（无冒号）反而放行 —— 同一能力两种写法一成一败。修法三条，全在**策略层**：

1. **B1**：盘符正则加左断言 `(?<![A-Za-z0-9_])`，让 `HKLM:` 整体只由注册表模式捕获；`pathCandidates` 剔除判据同步覆盖「归一后像注册表」的串。
2. **B2**：策略层建立**唯一归一权威** `canonicalRegistryPath`（权威形态 `HKLM:\software\…`：根键别名表**恰 4 条**、键名段小写化、分隔符统一、去尾分隔符）；白名单比对改为**大小写敏感**的 `matchRegistryAllowlist`（文件系统匹配保持不敏感，零改动）。
3. **B3**：`POLICY_DENIED.details.path` 回显**权威归一形态**，错误体附 `details.forms` 可用形态提示；**`psmod/system.ps1` 保持原状**（归一职责单一化，杜绝双实现漂移）。

**K-N2** 的根因是 `app.ps1` 给 `winget uninstall` 追加了该版本（`v1.29.380`）不存在的 `--dry-run`，命令在参数解析阶段即失败（`exitCode=-1978335230`＝`0x8A150002`），**dry-run 的「预览影响」语义从未实现**。定稿选型 = **宿主侧纯查询预览**：零 winget 调用、零子进程、零系统变更，复用 R-0 预捕获的注册表卸载键快照构造结构化 `plan`，回执 `success=true / exitCode=0 / verified=null / fallbackUsed=false`。配套把预捕获抽成 `Get-UninstallPrecapture`（真卸载与预览**共用**，差异仅 `-UseWingetName` 开关），并按本文 §4.3 的字段契约同步能力 `output` schema 与文档。

---

## 1. S-1 · B1：根因两点（采集层正则 + 过滤器不对称）

### 1.1 事实链（真机）

| # | 观测 | 证据 |
|---|---|---|
| 1 | `path="HKLM\SOFTWARE\…\Uninstall\{94DF76B2-…}"`（**无冒号**）→ `ok:true`，返回完整卸载键（`DisplayName="GitHub CLI"`、`DisplayVersion=2.101.0`、`UninstallString="MsiExec.exe /X{94DF…}"`） | 报告 §3 E2 `e2-reg-probe1`（traceId `tr_munzn0ad_79`，dur=2060） |
| 2 | 同一能力换 `path="HKLM:\SOFTWARE\…"`（**PowerShell 驱动器形态**，恰是 `psmod/system.ps1` 回执里回显的形态）→ `POLICY_DENIED`，错误体路径为 **`M:\SOFTWARE\…`** | 报告 §3 E2「子步 BLOCKED」、§5 S-1 行、§6 R-7；原文 `qa/r19/e2-msi-verify.resp.json`（traceId `tr_muq4cdrb_166`）：`"路径不在白名单内，已拒绝：M:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{94DF76B2-…}"`，`matchedRule` 域为 **文件系统白名单**（不是注册表域） |
| 3 | 同一陷阱在 E1 收尾核验上再次触发（`e1-post-reg`）→ 该子步链上不可重建（S-4 交叉影响） | 报告 §5 S-1 行、§5 S-4 行（`tr_munyl4yf_33` 零命中） |

**为何「两种写法一成一败」不是白名单表的问题**：`DEFAULT_POLICY.registryReadAllowlist` 同时含 `HKLM:\SOFTWARE\**` 与 `HKEY_LOCAL_MACHINE\SOFTWARE\**`（`packages/core/src/policy/defaults.ts:101-106`），无冒号写法之所以能过，是因为 `looksLikeRegistryPath` 的 `REG_RE`（`engine.ts:91`）接受 `HK\…\` 形态 → 交回注册表策略域；带冒号写法则在进入任一策略域之前就被采集层切坏了。

### 1.2 根因 A：盘符正则把根键尾字母当盘符

`packages/core/src/policy/engine.ts` `extractPathTokens()`（现 `:121-135`）旧写法：

```ts
/[A-Za-z]:\\/          // ← 无左断言：HKLM:\SOFTWARE\… 里 "M:\" 被认成盘符
```

触发路径（三个条件同时成立才暴露，这正是它逃过离线单测的原因）：

1. 参数键名或值「像命令」：`system.registry.read` 的 `params.path` 值含 `Uninstall` 等特征，`looksLikeCommandValue()` 判为 commandish；
2. 于是走 `extractPathTokens(value)` 提取 token 而不是整串比对；
3. 切出的 `M:\SOFTWARE\…` 命中 `DRIVE_RE`（`:81`）语义 ⇒ 进入文件系统路径候选。

**定稿修法（逐字锁死，不接受等价改写）**：

```ts
// 盘符路径：`X:` 前不得是字母/数字/下划线（否则会把 HKLM: / HKCU: 的尾字母当盘符）
/(?<![A-Za-z0-9_])[A-Za-z]:\\[^\s"'`;,|)]+/g
```

效果：`HKLM:\SOFTWARE\…` 整体只由第 4 条注册表模式（`/(?:HK[A-Z_]+|HKEY_[A-Z_]+):?\\[^\s"']+/gi`）捕获，`M:\` 伪盘符不再产生；真实盘符（`C:\Windows`、`D:\x`）不受影响（前一字符是空格/引号/`=` 等非 `[A-Za-z0-9_]`）。

### 1.3 根因 B：候选过滤器的不对称

`pathCandidates()`（现 `engine.ts:242-250`）旧写法只按**原样**剔除注册表串：

```ts
return raw.filter((p) => !looksLikeRegistryPath(p));   // M:\… 不像注册表 ⇒ 漏网去撞文件系统白名单
```

**缺陷含义**：即使 B1 修好正则，任何「归一后才是注册表路径」的形态（例：`hklm\software`、`HKEY_LOCAL_MACHINE/SOFTWARE`）仍可能以原样形态被判定为非注册表而进入文件系统域。过滤器必须**两侧都判**：

```ts
return raw.filter(
  (p) => !looksLikeRegistryPath(p) && !looksLikeRegistryPath(canonicalRegistryPath(p)),
);
```

**硬验收断言（B1 的判据，测试必须逐条覆盖）**：

| 断言 | 期望 |
|---|---|
| `extractPathTokens('HKLM:\\SOFTWARE\\Microsoft')` | 返回 `['HKLM:\\SOFTWARE\\Microsoft']`（**长度 1，不含任何 `M:\` 形态**） |
| `pathCandidates('path','HKLM:\\SOFTWARE\\…')` | 返回 `[]`（交回注册表域，不参与文件系统匹配） |
| `system.registry.read` + `HKLM:\…` | 结论**不得**是 `matchedRule='pathAllowlist:miss'`（真机症状复发即判失败） |
| `system.registry.read` + `HKLM\…` 与 + `HKLM:\…` | 判定**等价**（同 ALLOW 或同 DENY，且 `details.path` 逐字一致） |

---

## 2. S-1 · B2：策略层唯一归一权威

### 2.1 B2-1：根键别名表**恰 4 条**（HKLM/HKCU 的长全称 + 短形；HKU/HKCR/HKCC 一律不进）

归一的目的是「同一物理根键的多种写法在比对前收敛为同一形态」。这张表**同时是根键准入清单** ——
条目即「允许被铸造出合法形态的根键」封闭集合，共 **4** 条：

```ts
const REG_CANON: readonly [string, string][] = [
  ['HKEY_LOCAL_MACHINE', 'HKLM:'],
  ['HKEY_CURRENT_USER', 'HKCU:'],
  ['HKLM', 'HKLM:'],
  ['HKCU', 'HKCU:'],
];
```

**为何恰 4 条、且必须大小写敏感（这是安全裁决，不是风格偏好）**：

1. **只有读/写白名单可能覆盖到的两个 hive（HKLM / HKCU）进表**：长全称 2 条 + PowerShell 短驱动器名 2 条 =
   恰 4 条。表既是映射也是准入 ⇒ 新增第 5 条必然在 review/grep 里显形，不可能被静默收录。
2. **不收录 `HKU` / `HKEY_USERS`**：`HKEY_USERS` 是**所有已加载用户配置单元**的根，含 `\.DEFAULT`（SYSTEM 配置单元）。
   给一条本不在读白名单里的根键「归一出一个合法形态」，等于先替它铺好进入判定的路 ——
   归一应当是**形态收敛**，不是**权限扩张**。
3. **不收录 `HKCR`（`HKEY_CLASSES_ROOT`）/ `HKCC`（`HKEY_CURRENT_CONFIG`）**：`HKCR` 是
   `HKLM\SOFTWARE\Classes` 与 `HKCU\SOFTWARE\Classes` 的**合并视图**，一旦参与归一，
   `HKCR:\…\Shell\Open\Command` 之类就能以「另一个根键」的名义绕向 `Run` 键自启动面
   （`HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` 已在 `registryWriteAllowlist`，`defaults.ts:100`）。
4. **大小写敏感查表**（表键全大写 + 抽取到的根键 token 先 `toUpperCase()` 再等值比对）：命中集合可穷举、可 grep；
   若映射表自身带 `/i`，`hklm`、`HkLm`、`HKLM` 各自走哪条分支不可静态审计。
   （根键 **token 抽取**正则允许 `i`，因为它只负责「识别同一根键的不同写法」；准入判定仍是「大写 → 定值」的封闭比对。）

**非准入根键的落点（必须理解，不能想当然）**：`HKCR:\…` / `HKCC:\…` / `HKU:\…` 不被铸造形态，
但**仍被 `REG_RE` 识别为注册表路径** ⇒ 判定落在注册表域并以 `registry{Read,Write}Allowlist:miss` 被拒，
**不会**退回文件系统域撞 `pathAllowlist:miss` —— 后者正是真机 S-1 的**错误归属**（用户看到「路径不在白名单内」
误以为键不存在）。⇒ **归一 ≠ 放行**；非准入根键则是「**不铸造 + 注册表域拒绝**」，两者都不得变成放行。

### 2.2 B2-2：权威形态 = 根键大写短名 + **键名段小写** + 反斜杠 + 无尾分隔符

```
HKLM:\software\microsoft\windows\currentversion\uninstall\{94df76b2-…}
└─┬─┘ └──────────────── 键名段全部小写 ─────────────────────────────┘
 大写根键 + ':' + '\'
```

**为什么小写键名段**：注册表键名**不区分大小写**（Win32/PS provider 皆然），把键名段折叠为小写使归一成为**幂等的全函数** —— `canonicalRegistryPath(canonicalRegistryPath(x)) === canonicalRegistryPath(x)`，且 `HKLM:\SOFTWARE\X` / `HKLM:\Software\x` / `hklm\software\X` **收敛到同一字符串**。若保留原大小写，白名单就必须继续对大小写不敏感（见下），敏感化比对无从谈起。裸根键（`HKLM:`、`hklm`、`HKLM\`）统一产出 `HKLM:`（**不得**产出 `HKLM::` —— 曾出现的实现缺陷，A4 有断言）。

**由此推出：白名单比对必须大小写敏感。** 若比对仍带 `i`，那「键名段小写」只是回显层面的美化，白名单会退化为「大小写随便写」的第二套宽松判定，与 D9「双端同样宽松」的初衷（写法不影响成败）冲突且不可审计。定稿：

```ts
/** 注册表白名单匹配：两侧先归一到权威形态，再大小写敏感比对（键名段已折叠为小写） */
export function matchRegistryAllowlist(path: string, patterns: readonly string[]): boolean {
  const canon = canonicalRegistryPath(path);
  return patterns.some((p) => globToRegex(canonicalRegistryPath(p), true).test(canon));
}
```

- `globToRegex(pattern, caseSensitive = false)`（`engine.ts:31`）追加第二参；**传 `true` 时 flags 为空串**，默认 `false` 保持 `'i'`。
- **文件系统路径匹配保持大小写不敏感，本契约不动它**（`pathAllowRe` / `pathDenyRe` / `capPath*` 全部仍用默认参）：NTFS 大小写不敏感但**保留**，且文件系统白名单条目里存在 `C:\Program Files (x86)\**` 这类混合大小写串，敏感化会引入一整轮无关回归风险。**敏感化只开在注册表这一个域**。
- `evaluate()` 的 4b 分支（现 `engine.ts:393-429`）改为调用 `matchRegistryAllowlist`，不再手工构造 regex 数组。
- **`system.ps1` 的 `ConvertTo-RegistryPath` 保持原状（`HEAD` 版）**：只做「无冒号 → 补冒号 + 正斜杠换反斜杠」。归一职责**唯一落在策略层** —— psmod 侧再实现一份别名表/大小写规则，会产生「执行侧一个形态、判定侧另一个形态」的双权威漂移，正是 S-1 的病灶类型。代价是 psmod 回执里 `hive` 字段的大小写不保证（属显示层差异，不影响判定），本文记录该代价、不作修复要求。

### 2.3 B2 的三条硬约束小结

| # | 约束 | 违反的表征 |
|---|---|---|
| B2-1 | 别名表恰 4 条、大小写敏感查表、不含 `HKU`/`HKCR` 之外的臆测前缀 | 出现 `HKU:` 或 `HKCR:` 被 `ALLOW`；或表内出现 `/i` 正则 |
| B2-2 | 权威形态键名段小写 + 比对敏感；文件系统域不动 | `HKLM:\SOFTWARE\**` 模式匹配不到小写输入；或 `pathAllowRe` flags 变敏感 |
| B2-2 | `system.ps1` 零改动 | `git diff` 里出现 `system.ps1`；或 ps1 里出现别名 hashtable |

---

## 3. S-1 · B3：错误回显形态

- `POLICY_DENIED` 的 `details.path` **必须是权威归一形态**（小写键名段）：真机症状里「成功回执写 `HKLM:\…`、错误体里是 `M:\…`」是用户误判「键不存在」的直接原因。修复后：错误体、日志、成功回执回显三处**同一形态**。
- `details.inputPath` 保留**用户原样入参**（诊断用，不参与匹配）；`details.mode`（`read`/`write`）、`details.allowed`（白名单条目原样）保留。
- **新增 `details.forms`**：由 `describeRegistryForms(path)` 生成的**可用形态提示**文本，使调用方无需换写法试探即可自纠（报告建议「统一归一化**或**在错误里给出可用形态」，本契约定稿为**两者都做**）。
- 错误文案口径：`注册表路径不在允许范围内：<权威形态>（原样入参：<inputPath>）`。**不得**出现「请改用无冒号反斜杠形态」这类**把用户往回退到旧写法**的建议 —— 归一后各形态等价，回退建议本身就是错的信息。（该文案残留由 **A2** 交叉核对清除。）
- `message` 与 `details.path` 的回显形态一致（同串），避免「消息里一个形态、details 里另一个形态」。

---

## 4. K-N2：`app.winget.uninstall` dry-run = 宿主侧纯查询预览

### 4.1 根因与选型

`app.ps1`（报告定位 `:672`）旧代码：

```powershell
$wingetArgs = @('uninstall','--exact','--id',$Id,'--accept-source-agreements','--disable-interactivity')
if ($DryRun) { $wingetArgs += '--dry-run' }   # ← v1.29.380 的 uninstall 子命令无此参数
```

- 真机 `Windows Package Manager v1.29.380` 的 `uninstall` 帮助全文（见 `qa/r19/e3-dryrun.resp.json` 的 `output`）里**既无 `--dry-run` 也无 `--what-if`** —— 合法参数只有 `--install-mode` 等；`--dry-run` 仅 `install`/`upgrade` 侧存在。
- 命令在**参数解析阶段**即失败 ⇒ `exitCode=-1978335230`（`0x8A150002` `Argument name was not recognized`）、`success=false`、预览语义**从未实现**；跨天两次逐字段一致（`seq157 dur=1307`、`seq165 dur=495`），已由「疑似」升级为「坐实」（报告 §1 E3 行）。
- 正面保留：外层未伪装内层成功（`success:false` + winget 原文全量透传 + `[k6]` 标注），**不构成假成功**（报告 K-N2 段末）。

**选型定稿：宿主侧纯查询预览**（报告 §5 K-N2 路由给的第二个选项）。

**为什么不是 `--what-if`（报告 R-7 曾预测 `exit 0`）**：

1. **该预测未经真机证实** —— 报告 §6 未复现清单/§5 均未记录任何 `--what-if` 实跑样本；把它当修复方案等于用一条**未证实的预测**替换一条**已坐实的缺陷**。
2. 即便可用，预览仍要**起 winget 子进程**、仍受该 CLI 抖动支配（见 §4.2 的 OBS-B 风险），且 `winget uninstall --what-if` 语义上是「假想执行」而非「本机已安装状态快照」，对 NSIS/MSI 的回退预期、安装根派生这些**我们真正要预览的东西**并不覆盖（这些全部来自注册表，属 R-0 预捕获）。
3. 纯查询实现**复用既有 R-0 预捕获**，是**最小变更**：零新增外部依赖、零 winget 语法风险、零挂起风险。
   ⇒ `--what-if` 记为 **open question OQ-1**（见 §7），留给后续轮真机验证后再议，本契约不采用。

### 4.2 KN2 定稿的两条「勿动」约束

**① 预览路径零子进程**（连 `winget list` 这类只读调用也不得发起）：

- dry-run 通过 `engine.ts:475-478` 的 `allow:dry-run-bypass` 免审批通道放行 —— 该路径上的任何进程执行都**没有人类审批**兜底。
- 真机依据（报告 §2 **OBS-B**）：同族命令 `app.winget.install id=Tencent.WeCom` 两次 `EXECUTION_FAILED`，`seq4 dur=38307`、`seq34 dur=42467`（后者已打到 ps-bridge **45000ms** 心跳阈值并触发重启，`/health.psBridge.restarts=3`）；另有 `seq148 system.process.list dur=30018` 的能力级 30s 超时样本。免审批预览若挂同一 CLI，就是「无人批准的慢/挂路径」+ 假成功风险源。
- 实现约束：`Get-UninstallDryRunPlan` 只调 `Get-UninstallPrecapture -Id $Id`（**不传** `-UseWingetName`），后者内部不得出现 `winget` 字面调用；静态守卫断言 `Get-UninstallDryRunPlan` 函数体内零 `winget ` 命令调用（`& winget` / `Start-Process` 等），全文 `& winget @wingetArgs` **恰好 1 处**（真卸载路径）。

**② `success=true` 的语义**：仅表示**「预览构造成功」，不等于「包已安装」**。包存在性由 `plan.installed`（注册表卸载键是否命中）单独表达；`installed=false` 时 `expectedAction='winget-uninstall-expected-nonzero-exit'`（如实说明真实执行将以非零码退出），**不得**因预览成功而给出「可成功卸载」的暗示。`verified` 恒为 `$null`、`fallbackUsed` 恒为 `$false`（R-7 免审批语义保持，报告 §3 E2(b) 口径不变）。

**③ 移除 `wingetInvoked`**：旧草稿曾加 `plan.wingetInvoked` 作「零 winget 调用」回归哨兵。定稿**不设该字段** —— 零调用由「`exitCode` 恒 0 + 不出现 winget 参数错误码 + 源码静态守卫」三层保证，回执字段是运行期自宣（自宣者正是被约束对象），且该字段会污染 `output` schema 与审批卡渲染。

### 4.3 `plan` 字段契约（三方一致：app.ps1 / definitions.ts / CAPABILITY-MODEL.md）

| 字段 | 类型 | 语义 | 取不到时 |
|---|---|---|---|
| `packageId` | string | 请求卸载的包 Id（入参原样） | — |
| `displayName` | string | 注册表 `DisplayName`（**预览不查 winget 目录**） | `''` |
| `version` | string | 注册表 `DisplayVersion` | `''` |
| `installerType` | string enum `nsis\|msi\|other\|unknown` | R-1 判定，与 `verified.installerType` 同源 | `unknown` |
| `installed` | boolean | **唯一存在性事实**：注册表卸载键是否命中 | `false` |
| `registryKey` | string | 命中的卸载键名 | `''` |
| `hive` | string | 命中的 hive（`HKLM:\SOFTWARE\…` 形态） | `''` |
| `installRoot` | string | R-2 派生安装根 | `''`（执行时 `verified.dirGone=null`） |
| `expectedAction` | string enum | `uninstall-via-winget` \| `winget-uninstall-expected-nonzero-exit` | — |
| `actions` | string[] | 预计动作的人类可读清单（含回退预期、核验退化说明） | `[]` |
| `systemImpact` | string | 「本预览自身零变更」+「真实执行影响面」，审批卡可直接转呈 | — |

- `required` = `['packageId','displayName','installerType','expectedAction']`；`plan` 自身**不入** output `required`（仅 dryRun 分支出现）。
- 旧草稿字段 `id` / `name` / `key` / `uninstallCommand` / `quietUninstallCommand` / `wingetInvoked` **全部废弃**：前三个按上表改名（`packageId`/`displayName`/`registryKey`）与 `verified`/回执既有命名域对齐；后三个不再暴露 —— `UninstallString`/`QuietUninstallString` 原文是可执行命令串，放进预览载荷等于把「可自行提权的命令」写进一条**免审批**回执并持久化到审计/日志，属不必要的信息暴露面；预览要表达的是「将发生什么」，不是「拿什么命令去发生」。
- 抽函数（架构师裁量 1）：`Get-UninstallPrecapture` 为真卸载与预览**共用**实现，差异仅 `-UseWingetName` 开关；S-2 的卸载回执 precapture 段取同源结果，**不得**另行推导（防「预览一套、卸载另一套」）。

### 4.4 K-N2 硬验收断言

| # | 断言 | 依据 |
|---|---|---|
| K-N2-a | dry-run 回执**不得**带 winget 参数错误码：`exitCode !== -1978335230`、整条回执文本不含 `-1978335230` / `0x8A150002` / `Argument name was not recognized` | 报告 §5 K-N2 路由「补断言：dry-run 回执不得带非零 winget 参数错误码」（L3 同） |
| K-N2-b | dry-run 回执 `success=true` ∧ `exitCode=0` ∧ `verified=null` ∧ `fallbackUsed=false` ∧ `plan` 齐备（§4.3 十字段全存在、类型正确） | 本文 §4.2②/§4.3 |
| K-N2-c | `app.ps1` 全文：`$wingetArgs +=` 无任何追加 `--dry-run`/`--what-if` 形态；`--dry-run` 与 `--what-if` 两个串在 uninstall 函数域内**零出现** | 根因直接封堵 |
| K-N2-d | `Get-UninstallDryRunPlan` / `Get-UninstallPrecapture` 函数体内零子进程调用；`& winget @wingetArgs` 全文恰好 1 处 | §4.2① |
| K-N2-e | `installed=false` 时 `expectedAction='winget-uninstall-expected-nonzero-exit'`；`installerType` 三形态（nsis/msi/无键）分别产出正确动作项 | §4.2②/§4.3 |
| K-N2-f | 能力 `output` schema 声明 `plan` 且字段与 §4.3 逐字一致、无废弃字段；描述含「宿主侧纯查询预览 / 严禁 uninstall 追加 `--dry-run`、`--what-if`」 | definitions.ts + 文档三方一致 |

### 4.5 运维事实（交付纪律：单向流，本轮只落 git）

`app.ps1` 属 psmod，由 **ps-bridge 常驻进程按启动时快照加载，不热更新** ⇒ 本次改动**真机生效需重启 VM 服务**（ps-bridge 重启即覆盖）。本轮**不执行**真机验证：若 QA 在重启前实测，观察到的仍是旧行为 —— **「dry-run 仍带参数错误码」= 旧 dist/旧 psmod 未刷新，不等于修复失效**（此判断口径同时适用于 TS 侧的 `dist` 重建）。该事实必须写进源码注释与 commit message（交叉核对 **A2**）。

---

## 5. 交叉核对清单（A1–A5，实现完成前逐条勾）

| # | 核对项 | 通过判据 |
|---|---|---|
| **A1** | **别名表恰 4 条**（`REG_CANON` 大小写敏感、无 `HKU`/短形/臆测前缀）与**回显形态**（`details.path` 为权威小写键名形态）在代码、本文、`CAPABILITY-MODEL.md`、单测四处一致 | 四处字段名/形态逐字相同；单测矩阵含 `hklm\software\x` → `HKLM:\software\x` |
| **A2** | **无「旧文案」残留**：`请改用无冒号反斜杠形态`、`双端同样宽松` 之类**把归一职责说成 psmod 侧**的表述，全仓 `git grep` 零命中；运维事实（重启 VM 服务/旧 dist 判断口径）在 `app.ps1` 注释 + 本文 §4.5 + **commit message** 三处齐备 | `git grep -n "无冒号反斜杠形态"` 命中数为 0（本文与历史报告除外）。⚠ `双端同样宽松` 与「system.ps1 零改动」互斥，**已登记 OQ-3**，定稿前按较小解释只清回退建议文案 |
| **A3** | **归一 ≠ 放行**：`HKCR:\`、`HKCC:\`、`HKU:\`（含 `HKEY_USERS\.DEFAULT`）三族形态必须 `POLICY_DENIED`，且 `matchedRule` 落在**注册表域**（`registryReadAllowlist:miss`），不是 `pathAllowlist:miss`；`HKLM:\SOFTWARE\**` 与 `HKCU:\**` 的等价写法（长短名 / 有无冒号 / 任意大小写 / 正斜杠）全 ALLOW | ≥7 形态矩阵单测（`tests/unit/r19b-s1-registry-forms.test.js`）逐条断言 |
| **A4** | **幂等 + 无 `::`**：`canonicalRegistryPath` 对 `HKLM:`、`HKLM:\`、`HKLM\`、`hklm` 四个裸根键产出均为 `HKLM:`；二次归一结果不变（幂等） | 单测断言；曾出现 `HKLM::` 的实现缺陷不得复发 |
| **A5** | **范围纪律**：`git diff --name-only` 不含 `packages/vm-service/src/server.ts`、`packages/adapter-agent-workbuddy-llm/src/bridge.ts`、`packages/vm-capabilities/psmod/system.ps1`（**system.ps1 必须回到原状**）、`docs/design/kn1-delegation-audit-contract.md`、`docs/test/reports/*` | 逐条 `git diff --stat` 复核；两个 commit 的 `git add` 按文件名点名（禁 `-A`） |

> **A5 附带提示（不属本契约范围，仅登记）**：S-4 导致 S-1/S-2 的 `POLICY_DENIED` 请求在审计链上零命中，故 QA 复验本修复**不能**以「审计里没有那条拒绝」为证据 —— 需以 `*.resp.json` 回执 + 新增离线脚本为准（报告 §5 S-4 行、§8 L10）。

---

## 6. 契约变更流程（先开新单，不许边写边改）

- 实现侧发现**本契约有缺陷**（判据自相矛盾、字段名冲突、验收项不可测）时：**不得**就地改本文或按个人判断改实现 —— 立即在任务板**开新单**描述缺陷并附证据，由 architect 出定稿后再动代码。
- 允许实现侧自行决定的只有「本契约未约束的内部细节」（私有函数名、局部错误信息措辞、非契约字段），且须在回报中列出以便后续纳入核对。
- 本文一经修订须同步升版本号与修订记录（在 §8）。
- **落盘过程的一次自身失误记录（透明性要求）**：本文起草前，实现侧曾引用过**不存在**的 `docs/test/reports/r19b-consolidated-2026-10-02.md`，并向评审方误称裁决文本被截断。该文件不存在、`kn1-delegation-audit-contract.md` 亦无 R-B2 内容 —— 已撤回更正。**本文的落盘本身即是该风险的根治措施**：契约此后有唯一可 `git grep` 的载体，不再依赖会话记忆。

---

## 7. Open Questions（本契约**不**采用，留给后续轮）

| ID | 问题 | 现状 | 处置 |
|---|---|---|---|
| **OQ-1** | `winget uninstall --what-if`（或该版本其它预览开关）在 `v1.29.380` 上**是否存在且 `exit 0`** | **未证实**。报告 §6 R-7 是**预测**（`exit 0`），全仓无实跑样本；`e3-dryrun.resp.json` 的 uninstall 帮助全文显示**无** `--dry-run` / `--what-if` 两参数 | 需真机跑一次 `winget uninstall --what-if` 取原文后再评估。本契约选型（宿主侧纯查询）**不依赖**该问题结论，故不阻塞 |
| **OQ-2** | psmod 回执 `hive` 字段大小写与策略层权威形态不完全一致（B2-2 定稿后 psmod 不做小写化） | 有意代价：归一职责单一化优先于显示层一致 | 若后续要求显示层严格一致，须**先修订本文**再动 `system.ps1` |
| **OQ-3** | **本文自相矛盾（落盘时即发现）**：§5 A2 要求全仓 `双端同样宽松` 零命中，而 §2.2/B2-2 定稿「`system.ps1` 恢复原状、零改动」—— 该短语恰在 HEAD 版 `system.ps1:214` 的 D9 注释里，两者不可同时成立 | 实现侧按**较小解释**执行：只清除真正误导的**回退建议文案**（「请改用无冒号反斜杠形态」），HEAD 注释原样保留（其陈述在修复后依然成立：psmod 补冒号、策略层归一，两端都宽松）；单测注释里显式登记本冲突 | 请 architect 定稿：要么把 A2 的 grep 集缩窄为「回退建议文案」一句（推荐，改动最小），要么明确允许改 `system.ps1` 的一处注释措辞（则 §2.2「零改动」须改写为「零逻辑改动、注释可订正」）。**定稿前不得扩大改动面** |
| **OQ-4** | **实现侧偏差（待追认）**：§2.2 给出的 `matchRegistryAllowlist` 代码样例只做「两侧归一 + 敏感比对」，未处理「白名单条目含自身」—— 常规 glob 下 `HKLM:\SOFTWARE\**` → `^HKLM:\\software\\.*$` **不匹配** `HKLM:\SOFTWARE` 这个键本身（同族问题在文件系统域已由 `pathMatchesAny` 的「带尾分隔符重试」确立惯例）。后果：`system.registry.read path="HKLM:\SOFTWARE"` 被拒，而 `HKLM:\SOFTWARE\Anything` 放行 | 实现已补 `re.test(canon) || re.test(canon + '\\')`，放宽范围严格限定为**条目自身所表示的那个键**，不放宽任何其它层级（单测断言 `HKLM:\SOFTWAREX\Foo` 仍 DENY） | 请追认该偏差并把这一句补进 §2.2 样例；若否决，则回退为纯样例语义并接受「子树根不可读」的落差 |

---

## 8. 版本与实现映射

- **v1.0（2026-10-02 定稿落盘）**：首次落盘 R-B2/S-1/KN2 定稿。
- 实现载体（任务板 #7）：
  - `packages/core/src/policy/engine.ts` —— B1（`extractPathTokens` 断言 + `pathCandidates` 双侧判据）、B2（`REG_CANON` 4 条 / `canonicalRegistryPath` 小写化幂等 / `matchRegistryAllowlist` 敏感比对 / `globToRegex` 第二参）、B3（4b 接线 + `details.path`/`details.forms`）。
  - `packages/vm-capabilities/psmod/app.ps1` —— `Get-UninstallPrecapture`、`Get-UninstallDryRunPlan`、dryRun 分支重写、真卸载路径改共用（含运维事实注释）。
  - `packages/vm-capabilities/src/registry/definitions.ts` —— uninstall 描述 + `exitCode`/`success` 语义 + `plan` schema（§4.3）。
  - `docs/02-design/CAPABILITY-MODEL.md` —— §3.2.1 回执结构与 `plan` 字段行、dryRun 语义重写。
  - `tests/unit/r3-uninstall-verify.test.js`（KN2 全量断言）、`tests/unit/r19b-s1-registry-forms.test.js`（S-1 形态矩阵，新增）、`tests/unit/cl017.test.js`（D9 权威形态 4 断言更新）。

---

## 附：与报告条目映射

| 报告条目 | 本契约对应 |
|---|---|
| S-1（§5 策略表 / §7 L6 / §6 R-7 / §3 E2 子步 BLOCKED） | §1（B1 根因与修法）、§2（B2 归一权威）、§3（B3 回显） |
| K-N2（§5 K-N2 / §7 L3 / §6 R-6 / §1 E3） | §4（选型、两条勿动约束、plan 契约、验收断言） |
| OBS-B（§2 心跳抖动 38307/42467ms） | §4.2① 零子进程的真机依据 |
| R-7 `--what-if` 预测 | §7 **OQ-1**（未证实，不采用） |
| R-0 预捕获（§6 未复现清单 3） | §4.3 抽 `Get-UninstallPrecapture` 共用，预览即产物级 plan |
| S-2（`Program Files (x86)` 黑名单） | 明确排除（属既定策略，architect 另处理）；本文只锁 precapture 同源（§4.3 末） |
| S-4（`POLICY_DENIED` 零审计，§8 L10） | 明确排除；仅 §5 A5 附带提示复验取证口径 |
| K-N1 / S-3 / L1（§5、§7） | 不在本契约范围 → `docs/design/kn1-delegation-audit-contract.md`（任务板 #5/#26） |
