// WinVM one-tap deploy feature - domain models (contract types only, no platform imports)

// 表单配置（入口参数）
export interface WinvmConfig {
  vmHost: string;      // VM IP，如 172.16.100.10
  vmUser: string;      // VM 用户名
  sshPort: number;     // 固定 22
  provider: string;    // workbuddy | workbuddy-deterministic
  version: string;     // 'latest' 或具体 tag（如 V1.4.0）
}

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
