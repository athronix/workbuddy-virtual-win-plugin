// WinVM one-tap deploy feature - domain models (contract types only, no platform imports)

// 表单配置（入口参数）
export interface WinvmConfig {
  vmHost: string;      // VM IP，如 172.16.100.10
  vmUser: string;      // VM 用户名
  sshPort: number;     // SSH 端口（高级设置可配，默认 22）
  provider: string;    // workbuddy | workbuddy-deterministic
  version: string;     // 'latest' 或具体 tag（如 V1.4.0）
  // —— 高级设置（弹窗可配；默认值权威源 = 父 delivery/env.example）——
  tunnelLocalPort: number;  // 宿主侧本地监听端口 WINVM_TUNNEL_LOCAL_PORT
  vmDeployDir: string;      // VM 内部部署根目录 VM_DEPLOY_DIR
  tunnelBackend: string;    // ssh2 | ssh（WINVM_TUNNEL_BACKEND；鸿蒙宿主自动 ssh2）
  dryRun: boolean;          // WINVM_DRY_RUN：true=干跑假成功（父文档 G12 坑）
  hostDeploy: boolean;      // HOST_DEPLOY：是否部署宿主机侧插件
  vmDeploy: boolean;        // VM_DEPLOY：是否部署 VM 侧
}

// 高级设置默认值（父 delivery/env.example 逐项对齐）
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_TUNNEL_LOCAL_PORT = 18443;
export const DEFAULT_VM_DEPLOY_DIR = 'C:/WinVMBridge';
// 隧道后端（父 env.example：鸿蒙宿主 process.platform=ohos/openharmony 自动 ssh2；ssh=系统子进程）
export const TUNNEL_BACKEND_SSH2 = 'ssh2';
export const TUNNEL_BACKEND_SSH = 'ssh';
export const TUNNEL_BACKEND_OPTIONS: string[] = [TUNNEL_BACKEND_SSH2, TUNNEL_BACKEND_SSH];
// WINVM_SERVICE_PORT / WINVM_TUNNEL_REMOTE_PORT 固定 18443：
// 与 delivery/vm-service.config.json 安全基线（仅回环 + 端口一致）绑定，不在 UI 暴露，防双端不一致
export const FIXED_SERVICE_PORT = 18443;

// latest 解析结果 / 资产地址
export interface ResolvedRelease {
  tag: string;                 // 真实 tag，如 V1.4.0
  zipUrl: string;              // 资产直链
  shaUrl: string;              // 旁挂校验直链
  zipName: string;             // winvm-overall-<V>.zip
  resolveMode: string;         // 'latest' | 'manual'
}

// deploy-report.json 契约（父项目 docs/deploy §5.3，只读不写）
export interface ReportCheck {
  id: string;
  pass: boolean;
  evidence: string;
}

export interface DeployReport {
  version: string;
  ok: boolean;
  finishedAt: string;
  phases: Record<string, string>;
  checks: ReportCheck[];
  failures: string[];
}

// 取包流水线阶段
export enum FetchStage {
  IDLE = 'IDLE',
  PERMISSION = 'PERMISSION',
  RESOLVING = 'RESOLVING',
  DOWNLOADING = 'DOWNLOADING',
  VERIFYING = 'VERIFYING',
  EXTRACTING = 'EXTRACTING',
  EXPORTING = 'EXPORTING',
  PROMPT = 'PROMPT',
  POLLING = 'POLLING',
  DONE = 'DONE',
  FAILED = 'FAILED'
}

// 日志条目（UI 日志列表项；seq 作 ForEach key）
export interface WinvmLogEntry {
  seq: number;
  level: string;     // info | warn | error
  text: string;
}

// provider 取值集合（父文档 G4：首机建议 deterministic 零登录依赖）
export const PROVIDER_WORKBUDDY = 'workbuddy';
export const PROVIDER_DETERMINISTIC = 'workbuddy-deterministic';
export const PROVIDER_OPTIONS: string[] = [PROVIDER_WORKBUDDY, PROVIDER_DETERMINISTIC];

// report JSON 反序列化的宽松原始类型（逐字段收窄用，见 00-arkts-syntax JSON.parse 模式）
export interface ReportCheckRaw {
  id?: string;
  pass?: boolean;
  evidence?: string;
}

export interface ReportRaw {
  version?: string;
  ok?: boolean;
  finishedAt?: string;
  phases?: Record<string, string>;
  checks?: ReportCheckRaw[];
  failures?: string[];
}

export const EMPTY_PHASES: Record<string, string> = {};
