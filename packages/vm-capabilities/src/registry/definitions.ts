/**
 * Windows 能力注册表定义（CAPABILITY-MODEL.md）
 *
 * 新增能力只需在此追加一条定义 + 在 psmod/*.ps1 实现对应函数，
 * MCP 工具与 A2A Skill 会**自动出现**，无需改动任何框架代码（FR-206）。
 */

import type { CapabilityDefinition, CapabilityPolicy, RiskLevel, SnapshotPolicy } from '@winvm/contracts';

interface CapSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly module: string;
  readonly fn: string;
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  /**
   * 该能力的返回值是「列表」（D10）。
   * 声明后：① output schema 带 `array:true` 标记；② provider 会在返回边界强制保形为数组
   * （空 → []，单元素 → [{...}]），避免 PowerShell `return @(...)` 把单元素展开成对象、空结果变成 $null。
   */
  readonly outputArray?: boolean;
  readonly idempotent?: boolean;
  readonly requiresSession?: boolean;
  readonly destructive?: boolean;
  readonly timeoutMs?: number;
  readonly snapshot?: SnapshotPolicy;
  readonly destructivePath?: boolean;
  readonly policy?: CapabilityPolicy;
}

function obj(
  props: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties: props, ...(required.length > 0 ? { required } : {}) };
}

function cap(spec: CapSpec): CapabilityDefinition {
  const domain = spec.id.split('.')[0] as CapabilityDefinition['domain'];
  // 合并：破坏性路径自带"禁用 del/rm -rf"兜底，叠加调用方声明的 path/command 白名单
  const policy: CapabilityPolicy | undefined = spec.destructivePath
    ? { commandDenylist: ['\\bdel\\s+/s\\s+/q', '\\brm\\s+-rf'], ...(spec.policy ?? {}) }
    : spec.policy;
  return {
    id: spec.id,
    domain,
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    idempotent: spec.idempotent ?? false,
    requiresSession: spec.requiresSession ?? false,
    destructive: spec.destructive ?? false,
    timeoutMs: spec.timeoutMs ?? 30_000,
    input: spec.input,
    output: spec.outputArray
      ? { type: 'array', array: true, ...(spec.output ?? {}) }
      : spec.output ?? obj({}),
    audit: { snapshot: spec.snapshot ?? 'none' },
    implementation: { kind: 'powershell', module: spec.module, function: spec.fn },
    ...(policy ? { policy } : {}),
  };
}

/* ================================ meta ================================ */

const META: CapabilityDefinition[] = [
  cap({
    id: 'meta.health.check',
    name: '服务健康检查',
    description: '返回服务、ps-bridge、会话、能力数量与审计链状态（与 GET /health 同构）',
    risk: 'L0',
    // D5：由 Node 侧内置返回健康快照（provider 拦截 __meta.healthCheck），
    //     不再绑定 system.Get-SystemInfo（那返回的是系统信息，语义不符）。
    module: '__meta',
    fn: 'healthCheck',
    input: obj({}),
    idempotent: true,
    timeoutMs: 10_000,
  }),
  cap({
    id: 'meta.capability.list',
    name: '列出可用能力',
    description: '列出当前已注册并暴露的能力清单',
    risk: 'L0',
    module: '__meta',
    fn: 'listModules',
    input: obj({}),
    idempotent: true,
    timeoutMs: 10_000,
  }),
  cap({
    id: 'meta.session.status',
    name: '会话健康状态',
    description: '返回 Windows 交互式会话健康度（SessionId/窗口站/桌面/锁屏/黑屏）',
    risk: 'L0',
    module: 'gui',
    fn: 'Get-SessionHealth',
    input: obj({}),
    idempotent: true,
    timeoutMs: 15_000,
  }),
];

/* ================================ system ================================ */

const SYSTEM: CapabilityDefinition[] = [
  cap({ id: 'system.info.get', name: '获取系统信息', description: 'OS 版本/内存/CPU/域/启动时间/是否管理员', risk: 'L0', module: 'system', fn: 'Get-SystemInfo', input: obj({}), idempotent: true }),
  cap({ id: 'system.service.list', name: '列出服务', description: '按名称或状态过滤 Windows 服务', risk: 'L0', module: 'system', fn: 'Get-ServiceList', input: obj({ name: { type: 'string' }, status: { type: 'string' } }), idempotent: true, outputArray: true }),
  cap({ id: 'system.service.control', name: '控制服务', description: '启动/停止/重启服务', risk: 'L1', module: 'system', fn: 'Invoke-ServiceControl', input: obj({ name: { type: 'string' }, action: { type: 'string', enum: ['start', 'stop', 'restart'] } }, ['name', 'action']), timeoutMs: 60_000, snapshot: 'after' }),
  cap({ id: 'system.service.configure', name: '配置服务', description: '修改服务启动类型', risk: 'L2', module: 'system', fn: 'Set-ServiceConfig', input: obj({ name: { type: 'string' }, startType: { type: 'string', enum: ['Automatic', 'Manual', 'Disabled', 'AutomaticDelayedStart'] } }, ['name']), snapshot: 'before-after' }),
  cap({ id: 'system.process.list', name: '列出进程', description: '进程清单（PID/名称/会话/内存/命令行）', risk: 'L0', module: 'system', fn: 'Get-ProcessList', input: obj({ name: { type: 'string' }, top: { type: 'integer' } }), idempotent: true, outputArray: true }),
  cap({ id: 'system.process.terminate', name: '终止进程', description: '结束进程（含进程树）。受保护系统进程会被拒绝', risk: 'L2', module: 'system', fn: 'Stop-ProcessTree', input: obj({ processId: { type: 'integer' }, force: { type: 'boolean' } }, ['processId']), destructive: true, snapshot: 'after' }),
  cap({ id: 'system.task.scheduled', name: '查询计划任务', description: '列出计划任务与最近/下次运行时间', risk: 'L0', module: 'system', fn: 'Get-ScheduledTaskInfo', input: obj({ name: { type: 'string' } }), idempotent: true, outputArray: true }),
  cap({ id: 'system.registry.read', name: '读注册表', description: '读取注册表项（限定可读取根键）。路径**写法等价**（S-1）：有无冒号（`HKLM:\\` ≡ `HKLM\\`）、长短根键（`HKEY_LOCAL_MACHINE\\` ≡ `HKLM:\\`）、大小写、正/反斜杠均不影响判定；策略层统一归一为权威形态 `HKLM:\\software\\…` 后再比对并回显。根键准入仅 HKLM/HKCU（`HKU`/`HKCR`/`HKCC` 一律拒绝 —— 归一 ≠ 放行）', risk: 'L0', module: 'system', fn: 'Read-RegistryValue', input: obj({ path: { type: 'string' }, name: { type: 'string' } }, ['path']), idempotent: true }),
  cap({ id: 'system.registry.write', name: '写注册表', description: '写入注册表（限定可写根键；关键根键被策略禁止）。路径形态规则同 `system.registry.read`（S-1 写法等价，归一权威在策略层）', risk: 'L2', module: 'system', fn: 'Write-RegistryValue', input: obj({ path: { type: 'string' }, name: { type: 'string' }, value: {}, type: { type: 'string' } }, ['path', 'name', 'value']), snapshot: 'before-after' }),
  cap({ id: 'system.network.config', name: '查询网络配置', description: '网卡/IP/DNS/路由（进程内 TTL 缓存 45s，可 refresh 强制刷新）', risk: 'L0', module: 'system', fn: 'Get-NetworkConfig', input: obj({ includeRoutes: { type: 'boolean' }, refresh: { type: 'boolean', description: 'CL-018 C5：true 时绕过进程内缓存强制重新采集' } }), idempotent: true, output: obj({ adapters: { type: 'array', description: '网卡投影；每项含 gateway[]，其内层为 { nextHop, routeMetric }' }, routes: { type: 'array', description: 'CL-018 C5（includeRoutes 时的附加载荷）；CL-019 项②统一字段名：内层为 { destination, nextHop, routeMetric }（与 adapters[].gateway[] 的 routeMetric 同源同名）' }, cached: { type: 'boolean', description: 'CL-018 C5：是否命中进程内缓存' }, cacheAgeMs: { type: 'integer', description: 'CL-018 C5：缓存年龄（毫秒；冷采集为 0）' }, collectedAt: { type: 'string', description: 'CL-018 C5：本次数据采集时间（ISO8601）' } }) }),
  cap({ id: 'system.user.manage', name: '查询本地用户', description: '列出本地用户与启用状态', risk: 'L0', module: 'system', fn: 'Get-LocalUserInfo', input: obj({ name: { type: 'string' } }), idempotent: true, outputArray: true }),
  cap({ id: 'system.env.manage', name: '管理环境变量', description: '读取或设置用户/系统环境变量', risk: 'L1', module: 'system', fn: 'Get-EnvironmentVariableInfo', input: obj({ name: { type: 'string' }, target: { type: 'string', enum: ['User', 'Machine'] } }), snapshot: 'after' }),
  cap({ id: 'system.eventlog.query', name: '查询事件日志', description: '按日志名/级别查询 Windows 事件', risk: 'L0', module: 'system', fn: 'Get-EventLogEntries', input: obj({ logName: { type: 'string' }, maxEvents: { type: 'integer' }, level: { type: 'string' } }), idempotent: true, outputArray: true }),
  cap({ id: 'system.power.control', name: '电源控制', description: '关机/重启/休眠/睡眠。必须先 dry-run', risk: 'L3', module: 'system', fn: 'Invoke-PowerControl', input: obj({ action: { type: 'string', enum: ['shutdown', 'restart', 'hibernate', 'sleep'] }, delaySeconds: { type: 'integer' }, dryRun: { type: 'boolean' } }, ['action']), destructive: true, snapshot: 'before-after' }),
];

/* ================================ app ================================ */

const APP: CapabilityDefinition[] = [
  cap({
    id: 'app.inventory.list',
    name: '列出已装应用',
    description: '注册表卸载键 + 可选 UWP 包清单（按 (name,version) 合并重复登记）',
    risk: 'L0',
    module: 'app',
    fn: 'Get-InstalledApps',
    input: obj({ name: { type: 'string' }, includeUwp: { type: 'boolean' } }),
    idempotent: true,
    outputArray: true,
    // CL-018 C6：每条附加 `registryKeyCount`（该 (name,version) 的原始注册键条数）
    // 与可选 `architectures`（仅 hive 可推断时填充：HKLM64→x64、HKLM32→x86；HKCU→省略）。
    output: {
      items: obj({
        name: { type: 'string' },
        version: { type: 'string' },
        publisher: { type: 'string' },
        installDate: { type: 'string' },
        installPath: { type: 'string' },
        uninstallCmd: { type: 'string' },
        source: { type: 'string' },
        registryKeyCount: { type: 'integer', description: 'CL-018 C6：该 (name,version) 的原始注册键条数' },
        architectures: { type: 'array', items: { type: 'string' }, description: 'CL-018 C6：由 hive 推断的架构（推不出则省略）' },
      }),
    },
  }),
  cap({ id: 'app.winget.search', name: '搜索可安装包', description: '用 winget 搜索包', risk: 'L0', module: 'app', fn: 'Search-WingetPackage', input: obj({ query: { type: 'string' }, limit: { type: 'integer' } }, ['query']), idempotent: true, timeoutMs: 60_000, outputArray: true }),
  cap({ id: 'app.winget.install', name: '安装应用', description: '用 winget 安装包（无人值守）', risk: 'L1', module: 'app', fn: 'Install-WingetPackage', input: obj({ id: { type: 'string' }, version: { type: 'string' }, dryRun: { type: 'boolean' } }, ['id']), timeoutMs: 600_000, snapshot: 'after' }),
  cap({
    id: 'app.winget.uninstall',
    name: '卸载应用',
    description:
      '用 winget 卸载包，并在 winget 退出后做磁盘 + 注册表**事后核验**（R17/R3，K6 状态机）。' +
      '`success` 以**最终核验结果为准**：exitCode=0 但核验未过（NSIS 包假成功）一律 `success=false`；' +
      '核验未过且卸载注册表键判定为 NSIS 型（`UninstallString` 指向 Uninstall.exe 且无 `QuietUninstallString`）时，' +
      '自动以 `Uninstall.exe /S` 静默回退并再核验，是否回退见 `fallbackUsed`；MSI 及其它类型**永不回退**。' +
      '核验失败时 `success=false` 并附 `residualEvidence` 残留证据，宿主必须如实转呈，不得改写为成功。' +
      '时间预算：能力级 600s 总预算（严禁突破），内部软分配 winget ≤300s / NSIS 回退 ≤240s / 核验 ≤30s。' +
      'dryRun（K-N2 起）：**宿主侧纯查询预览** —— 零 winget 调用、零子进程（连 `winget list` 都不发起）、' +
      '零系统变更，只读注册表卸载键后输出结构化 `plan`（packageId/displayName/version/installerType/' +
      'installed/registryKey/hive/installRoot/expectedAction/actions/systemImpact），供「先预览再审批」。' +
      '回执 `success=true`、`exitCode=0`、`verified=null`、`fallbackUsed=false`（免审批语义保持）；' +
      '`success=true` 仅表示**预览构造成功 ≠ 包已安装**，存在性由 `plan.installed` 单独表达。' +
      '⚠ 严禁给 `winget uninstall` 追加 `--dry-run`/`--what-if`：v1.29.380 的 uninstall 子命令无此参数，' +
      '会在参数解析阶段即失败（`-1978335230`＝`0x8A150002` Argument name was not recognized）。',
    risk: 'L2',
    module: 'app',
    fn: 'Uninstall-WingetPackage',
    input: obj({ id: { type: 'string' }, dryRun: { type: 'boolean' } }, ['id']),
    // R17-T01（K6 契约层）：回执新增 verified / fallbackUsed / residualEvidence，success 语义改为「以最终核验为准」。
    //   实现侧（psmod/app.ps1，T02）必须逐字对齐 docs/design/r17-design.md §A1.3/§A5 与
    //   tests/unit/r3-uninstall-verify.test.js 中的判定规则（NSIS 判定 / InstallLocation 反推 / 核验三态 / dryRun 语义）。
    output: obj(
      {
        id: { type: 'string' },
        dryRun: { type: 'boolean' },
        exitCode: {
          type: 'integer',
          description: 'winget uninstall 退出码（单独为 0 不再代表卸载成功）；dryRun 预览不发起 winget，恒为 0',
        },
        success: {
          type: 'boolean',
          description: '以最终核验为准：非 dryRun 时 = exitCode=0 且（首次核验通过 或 NSIS 回退后核验通过）；dryRun 预览成功完成即 true',
        },
        verified: {
          type: ['object', 'null'],
          description: '事后核验证据（核验方式与结果）；dryRun 时为 null',
          properties: {
            exeGone: { type: 'boolean', description: '目标可执行文件已从磁盘消失' },
            dirGone: {
              type: ['boolean', 'null'],
              description: '安装目录已从磁盘消失；派生不出安装根时可为 null（此时只做注册表核验）',
            },
            registryGone: { type: 'boolean', description: 'HKLM/HKCU 卸载键已消失' },
            installLocation: {
              type: 'string',
              description: '核验目标安装根：注册表 InstallLocation；缺失时按 UninstallString 去引号/参数取所在目录反推；派生不出则省略',
            },
            installerType: {
              type: 'string',
              enum: ['nsis', 'msi', 'other', 'unknown'],
              description: '安装器类型判定；仅 nsis 允许 /S 静默回退，取不到卸载键时为 unknown',
            },
          },
          required: ['exeGone', 'dirGone', 'registryGone', 'installerType'],
        },
        fallbackUsed: {
          type: 'boolean',
          description: '是否触发了 NSIS 静默回退（Uninstall.exe /S）；dryRun、非 NSIS、winget 非零退出时恒为 false',
        },
        residualEvidence: {
          type: 'string',
          description: '可选：success=false 时的残留证据（残留 exe / 目录 / 注册表键清单，人类可读文本）',
        },
        // K-N2 · 契约 §4.3（docs/design/r19b-s1-kn2-contract.md）：dryRun 预览载荷。
        // 仅 dryRun 分支出现 ⇒ 非 dryRun 回执不带该字段，故 plan 自身不入 output required。
        // 字段名与 app.ps1 `Get-UninstallDryRunPlan` / CAPABILITY-MODEL.md §3.2.1 三方逐字一致（交叉核对 A1）。
        // 契约明确废弃的字段不得回归：`id`/`name`/`key`（已改名）、`uninstallCommand`/`quietUninstallCommand`
        // （可执行命令串不得出现在**免审批**回执里并持久化到审计/日志）、`wingetInvoked`
        // （零调用由 exitCode 恒 0 + 参数错误码缺席 + 源码静态守卫三层保证，不靠运行期自宣）。
        plan: {
          type: 'object',
          description: '仅 dryRun：宿主侧纯查询预览计划（零 winget 调用、零子进程、零系统变更），供「先预览再审批」',
          properties: {
            packageId: { type: 'string', description: '请求卸载的包 Id（入参原样）' },
            displayName: { type: 'string', description: '注册表 DisplayName（预览不查 winget 目录；取不到为空串）' },
            version: { type: 'string', description: '注册表 DisplayVersion（取不到为空串）' },
            installerType: {
              type: 'string',
              enum: ['nsis', 'msi', 'other', 'unknown'],
              description: '安装器类型判定（与 verified.installerType 同源；无卸载键时为 unknown）',
            },
            installed: {
              type: 'boolean',
              description: '包在 VM 内是否存在的**唯一事实**：注册表卸载键是否命中（`success=true` 不代表已安装）',
            },
            registryKey: { type: 'string', description: '命中的卸载注册表键名（未命中为空串）' },
            hive: { type: 'string', description: '命中的注册表 hive 路径（HKLM:\\SOFTWARE\\… 形态；未命中为空串）' },
            installRoot: { type: 'string', description: '安装根（派生不出为空串，执行时 verified.dirGone 将为 null）' },
            expectedAction: {
              type: 'string',
              enum: ['uninstall-via-winget', 'winget-uninstall-expected-nonzero-exit'],
              description: '真实执行的预期动作：命中卸载键走 winget uninstall；未命中则以非零码退出（不谎称可成功）',
            },
            actions: {
              type: 'array',
              items: { type: 'string' },
              description: '预计执行动作的人类可读清单（含回退预期与核验退化说明）',
            },
            systemImpact: {
              type: 'string',
              description: '「本预览自身零变更」+「真实执行影响面」，审批卡可直接转呈',
            },
          },
          required: ['packageId', 'displayName', 'installerType', 'expectedAction'],
        },
        output: { type: 'array', items: { type: 'string' }, description: 'winget 原始输出行（触发回退时含回退阶段输出；dryRun 时仅预览说明行）' },
      },
      ['id', 'dryRun', 'exitCode', 'success', 'verified', 'fallbackUsed'],
    ),
    destructive: true,
    timeoutMs: 600_000,
    snapshot: 'before-after',
  }),
  cap({ id: 'app.winget.upgrade', name: '升级应用', description: '升级指定包或全部可升级包', risk: 'L1', module: 'app', fn: 'Update-WingetPackage', input: obj({ id: { type: 'string' }, all: { type: 'boolean' }, dryRun: { type: 'boolean' } }), timeoutMs: 600_000, snapshot: 'after' }),
  cap({ id: 'app.process.launch', name: '启动应用', description: '启动可执行文件/打开文件/打开 URL', risk: 'L1', module: 'app', fn: 'Start-AppProcess', input: obj({ target: { type: 'string' }, arguments: { type: 'string' }, workingDirectory: { type: 'string' }, wait: { type: 'boolean' } }, ['target']), timeoutMs: 120_000 }),
  cap({ id: 'app.shortcut.manage', name: '管理快捷方式', description: '读取或创建 .lnk 快捷方式', risk: 'L1', module: 'app', fn: 'Get-ShortcutInfo', input: obj({ path: { type: 'string' }, targetPath: { type: 'string' }, arguments: { type: 'string' }, workingDirectory: { type: 'string' } }, ['path']), snapshot: 'after' }),
  cap({ id: 'app.appx.manage', name: '查询 UWP 包', description: '列出 Appx 包', risk: 'L0', module: 'app', fn: 'Get-AppxPackageInfo', input: obj({ name: { type: 'string' } }), idempotent: true, outputArray: true }),
];

/* ================================ storage ================================ */

const STORAGE: CapabilityDefinition[] = [
  cap({ id: 'storage.disk.list', name: '列出磁盘', description: '物理磁盘/分区/卷使用情况', risk: 'L0', module: 'storage', fn: 'Get-DiskInfo', input: obj({ includeVolumes: { type: 'boolean' } }), idempotent: true }),
  cap({ id: 'storage.space.analyze', name: '分析目录体积', description: '递归统计子目录体积 Top-N', risk: 'L0', module: 'storage', fn: 'Get-DirectorySize', input: obj({ path: { type: 'string' }, depth: { type: 'integer' }, top: { type: 'integer' } }, ['path']), idempotent: true, timeoutMs: 120_000 }),
  cap({ id: 'storage.file.read', name: '读文件', description: '以 UTF-8 或 base64 读取文件内容', risk: 'L0', module: 'storage', fn: 'Read-TextFileContent', input: obj({ path: { type: 'string' }, maxBytes: { type: 'integer' }, asBase64: { type: 'boolean' } }, ['path']), idempotent: true }),
  cap({ id: 'storage.file.write', name: '写文件', description: '写入或追加文件内容', risk: 'L1', module: 'storage', fn: 'Write-TextFileContent', input: obj({ path: { type: 'string' }, content: {}, append: { type: 'boolean' }, createDirectory: { type: 'boolean' } }, ['path', 'content']), idempotent: true, snapshot: 'after' }),
  cap({ id: 'storage.file.delete', name: '删除文件/目录', description: '默认进回收站；-Permanent 需 L2 审批', risk: 'L2', module: 'storage', fn: 'Remove-FileSystemItem', input: obj({ path: { type: 'string' }, permanent: { type: 'boolean' }, dryRun: { type: 'boolean' } }, ['path']), destructive: true, destructivePath: true, snapshot: 'before-after' }),
  cap({ id: 'storage.file.move', name: '移动/重命名', description: '移动文件或目录', risk: 'L1', module: 'storage', fn: 'Move-FileSystemItem', input: obj({ path: { type: 'string' }, destination: { type: 'string' }, force: { type: 'boolean' } }, ['path', 'destination']), snapshot: 'after' }),
  cap({ id: 'storage.file.copy', name: '复制', description: '复制文件或目录', risk: 'L1', module: 'storage', fn: 'Copy-FileSystemItem', input: obj({ path: { type: 'string' }, destination: { type: 'string' }, recurse: { type: 'boolean' }, force: { type: 'boolean' } }, ['path', 'destination']), snapshot: 'after' }),
  cap({ id: 'storage.dir.manage', name: '创建目录', description: '创建目录（已存在则幂等返回）', risk: 'L1', module: 'storage', fn: 'New-DirectoryItem', input: obj({ path: { type: 'string' } }, ['path']), idempotent: true, snapshot: 'after' }),
  cap({ id: 'storage.search.query', name: '搜索文件', description: '按文件名或内容搜索', risk: 'L0', module: 'storage', fn: 'Search-FileSystem', input: obj({ path: { type: 'string' }, pattern: { type: 'string' }, contentPattern: { type: 'string' }, maxResults: { type: 'integer' }, recurse: { type: 'boolean' } }, ['path']), idempotent: true, timeoutMs: 120_000, outputArray: true }),
  cap({ id: 'storage.archive.manage', name: '压缩/解压', description: '创建或展开 zip 归档', risk: 'L1', module: 'storage', fn: 'New-ZipArchiveItem', input: obj({ path: { type: 'string' }, destination: { type: 'string' } }, ['path', 'destination']), timeoutMs: 300_000, snapshot: 'after' }),
  cap({ id: 'storage.link.manage', name: '创建链接', description: '符号链接/硬链接/目录联接', risk: 'L2', module: 'storage', fn: 'New-LinkItem', input: obj({ path: { type: 'string' }, target: { type: 'string' }, type: { type: 'string', enum: ['SymbolicLink', 'HardLink', 'Junction'] } }, ['path', 'target']), snapshot: 'after' }),
  cap({ id: 'storage.recycle.manage', name: '查看回收站', description: '列出回收站条目', risk: 'L0', module: 'storage', fn: 'Get-RecycleBinInfo', input: obj({}), idempotent: true }),
  cap({ id: 'storage.cleanup.analyze', name: '清理建议', description: '仅分析不执行：临时文件/回收站/大文件', risk: 'L0', module: 'storage', fn: 'Get-CleanupSuggestions', input: obj({ topLargeFiles: { type: 'integer' } }), idempotent: true, timeoutMs: 120_000 }),
];

/* ================================ gui ================================ */

const GUI: CapabilityDefinition[] = [
  cap({ id: 'gui.session.status', name: '会话健康检查', description: 'SessionId/窗口站/桌面/锁屏/黑屏检测', risk: 'L0', module: 'gui', fn: 'Get-SessionHealth', input: obj({}), idempotent: true, requiresSession: true, timeoutMs: 20_000 }),
  cap({ id: 'gui.screen.capture', name: '截图', description: '全屏/窗口/区域截图，base64 PNG 回传', risk: 'L0', module: 'gui', fn: 'Get-ScreenCapture', input: obj({ x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, windowTitle: { type: 'string' }, asBase64: { type: 'boolean' } }), idempotent: true, requiresSession: true, timeoutMs: 30_000 }),
  cap({ id: 'gui.screen.analyze', name: '黑屏检测', description: '采样计算灰度方差判定是否黑屏/纯色', risk: 'L0', module: 'gui', fn: 'Test-ScreenBlack', input: obj({ threshold: { type: 'number' } }), idempotent: true, requiresSession: true, timeoutMs: 20_000 }),
  cap({ id: 'gui.window.list', name: '列出窗口', description: '枚举有主窗口的进程', risk: 'L0', module: 'gui', fn: 'Get-WindowList', input: obj({ title: { type: 'string' }, visibleOnly: { type: 'boolean' } }), idempotent: true, requiresSession: true, outputArray: true }),
  cap({ id: 'gui.window.control', name: '控制窗口', description: '最小化/最大化/还原/关闭/激活', risk: 'L1', module: 'gui', fn: 'Set-WindowState', input: obj({ title: { type: 'string' }, state: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'close', 'activate'] } }, ['title']), requiresSession: true, snapshot: 'after' }),
  cap({ id: 'gui.input.keyboard', name: '键盘输入', description: '发送文本（Unicode）或组合键', risk: 'L1', module: 'gui', fn: 'Send-KeyboardInput', input: obj({ text: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, delayMs: { type: 'integer' } }), requiresSession: true, snapshot: 'after' }),
  cap({ id: 'gui.input.mouse', name: '鼠标输入', description: '移动/点击/双击/右键/滚轮/拖拽', risk: 'L1', module: 'gui', fn: 'Send-MouseInput', input: obj({ action: { type: 'string', enum: ['move', 'click', 'doubleClick', 'rightClick', 'wheel', 'drag'] }, x: { type: 'integer' }, y: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' }, wheelDelta: { type: 'integer' }, delayMs: { type: 'integer' } }), requiresSession: true, snapshot: 'after' }),
  cap({ id: 'gui.uia.tree', name: 'UIA 元素树', description: '按窗口获取 UI Automation 元素树', risk: 'L0', module: 'gui', fn: 'Get-UiaTree', input: obj({ windowTitle: { type: 'string' }, maxDepth: { type: 'integer' } }), idempotent: true, requiresSession: true, timeoutMs: 60_000 }),
  cap({ id: 'gui.uia.invoke', name: 'UIA 元素操作', description: '按 AutomationId/Name/ControlType 定位并点击/设值/切换', risk: 'L1', module: 'gui', fn: 'Invoke-UiaElement', input: obj({ windowTitle: { type: 'string' }, automationId: { type: 'string' }, name: { type: 'string' }, controlType: { type: 'string' }, action: { type: 'string', enum: ['invoke', 'setValue', 'toggle', 'focus'] }, value: { type: 'string' } }, ['windowTitle']), requiresSession: true, snapshot: 'after' }),
  cap({ id: 'gui.clipboard.manage', name: '剪贴板读写', description: '读取或写入剪贴板文本', risk: 'L1', module: 'gui', fn: 'Get-ClipboardText', input: obj({ text: { type: 'string' } }), requiresSession: true, snapshot: 'after' }),
  cap({ id: 'gui.wait.condition', name: '等待条件', description: '等待窗口出现/消失/进程退出/屏幕稳定', risk: 'L0', module: 'gui', fn: 'Wait-GuiCondition', input: obj({ condition: { type: 'string', enum: ['windowExists', 'windowGone', 'processExited', 'screenStable'] }, windowTitle: { type: 'string' }, processId: { type: 'integer' }, timeoutMs: { type: 'integer' }, pollIntervalMs: { type: 'integer' } }), idempotent: true, requiresSession: true, timeoutMs: 120_000 }),
];

/* ================================ appops ================================ */
/* 应用生产操作域：操作 Windows 软件应用**进行生产活动**（与 app 域的"应用管理/安装卸载"区分）。
   本域回答"在 VM 里用某个桌面软件把活干出来"：
   - 调应用的命令行/脚本接口（ffmpeg / imagemagick / soffice / pandoc ...）
   - 运行已登记的"生产型工作流"（Photoshop action、Office 宏、批处理脚本 ...）
   - COM 自动化驱动（Office / 支持 COM 的桌面应用）
   - 基于 GUI 自动化的多步生产（打开→导入→操作→导出），应用专属知识由 Skill 承载
   开放/未知的生产意图需 LLM Agent provider（见 SPEC-AGENT-SERVICE-BRIDGE §开放任务）。 */

const APPOPS: CapabilityDefinition[] = [
  cap({
    id: 'appops.state.query',
    name: '查询应用生产状态',
    description: '列出正在运行的生产型应用、其打开的文档/项目、当前活动窗口上下文，供决策下一步（自动过滤非生产型窗口）',
    risk: 'L0',
    module: 'appops',
    fn: 'Get-AppOpState',
    input: obj({ appName: { type: 'string' }, includeDocuments: { type: 'boolean' } }),
    idempotent: true,
    timeoutMs: 20_000,
    // CL-018 C4：附 `filteredCount`/`filtered`（被过滤的非生产型窗口及原因）与生效 `policy`，
    // 供审计核对「无真实应用被误杀」（AC4.2 优先）。
    output: obj({
      count: { type: 'integer' },
      apps: { type: 'array' },
      scannedAt: { type: 'string' },
      filteredCount: { type: 'integer', description: 'CL-018 C4：被过滤的非生产型窗口数' },
      filtered: { type: 'array', description: 'CL-018 C4：被过滤项及原因（透明可审计）' },
      policy: { type: 'object', description: 'CL-018 C4：生效的过滤名单与框架宿主灰名单' },
    }),
  }),
  cap({
    id: 'appops.cli.invoke',
    name: '调用应用命令行接口',
    description: '运行应用自带的 CLI/脚本接口（如 ffmpeg、ImageMagick、LibreOffice/soffice、pandoc、magick）执行生产任务',
    risk: 'L1',
    module: 'appops',
    fn: 'Invoke-AppCli',
    input: obj(
      {
        app: { type: 'string', enum: ['ffmpeg', 'magick', 'soffice', 'pandoc', 'node', 'python', 'custom'] },
        command: { type: 'string' },
        arguments: { type: 'string' },
        workingDirectory: { type: 'string' },
        outputDirectory: { type: 'string' },
      },
      ['app', 'command'],
    ),
    timeoutMs: 600_000,
    snapshot: 'after',
    policy: {
      pathAllowlist: ['%USERPROFILE%\\WinVMWorkspace\\out', 'C:\\WinVMWorkspace\\out'],
    },
  }),
  cap({
    id: 'appops.workflow.run',
    name: '运行生产型工作流',
    description:
      '运行 VM 内已登记的生产型工作流（按名称+参数）。工作流脚本由用户/LLM 预置，封装具体应用的 CLI/API/宏（如 Photoshop 批处理、Excel 报表生成、视频转码流水线）',
    risk: 'L1',
    module: 'appops',
    fn: 'Start-AppOpWorkflow',
    input: obj(
      {
        workflow: { type: 'string' },
        params: { type: 'object' },
        inputPath: { type: 'string' },
        outputDirectory: { type: 'string' },
      },
      ['workflow'],
    ),
    timeoutMs: 600_000,
    snapshot: 'after',
    policy: {
      commandAllowlist: ['^node\\b', '^python\\b', '^pwsh\\b', '^powershell\\b', '^cmd\\b', '^ffmpeg\\b', '^magick\\b', '^soffice\\b', '^pandoc\\b'],
      pathAllowlist: ['%USERPROFILE%\\WinVMWorkspace', 'C:\\WinVMWorkspace'],
    },
  }),
  cap({
    id: 'appops.com.automate',
    name: 'COM 自动化驱动应用',
    description: '通过 COM 自动化驱动支持 COM 的桌面应用（如 Word/Excel 打开文档、替换内容、导出 PDF）执行生产动作',
    risk: 'L1',
    module: 'appops',
    fn: 'Invoke-AppComAutomation',
    input: obj(
      {
        progId: { type: 'string' },
        script: { type: 'string' },
        documentPath: { type: 'string' },
        outputPath: { type: 'string' },
      },
      ['progId', 'script'],
    ),
    requiresSession: true,
    timeoutMs: 300_000,
    snapshot: 'after',
  }),
  cap({
    id: 'appops.gui.produce',
    name: 'GUI 多步生产操作',
    description:
      '基于 GUI 自动化的"生产型"多步操作（打开软件→导入素材→执行菜单/面板动作→导出成果）。应用专属点击序列由 Skill 提供，本能力负责按给定步骤序列驱动',
    risk: 'L2',
    module: 'appops',
    fn: 'Invoke-AppGuiProduction',
    input: obj(
      {
        app: { type: 'string' },
        openTarget: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['click', 'type', 'menu', 'waitWindow', 'waitStable', 'hotkey', 'screenshot'] },
              target: { type: 'string' },
              value: { type: 'string' },
              timeoutMs: { type: 'integer' },
            },
          },
        },
        outputPath: { type: 'string' },
      },
      ['app', 'steps'],
    ),
    requiresSession: true,
    destructive: true,
    timeoutMs: 600_000,
    snapshot: 'before-after',
  }),
];

/** 全部 Windows 能力定义 */
export const WINDOWS_CAPABILITIES: readonly CapabilityDefinition[] = [
  ...META,
  ...SYSTEM,
  ...APP,
  ...STORAGE,
  ...GUI,
  ...APPOPS,
];

export const CAPABILITIES_BY_DOMAIN = {
  meta: META,
  system: SYSTEM,
  app: APP,
  storage: STORAGE,
  gui: GUI,
  appops: APPOPS,
} as const;
