/**
 * A2-11（Phase 3 批6）：常驻 CLI 会话的**工作集探针**——终结 wsProbe 死配置。
 *
 * 病灶（audit §3.2 A2-11 / arch3 维④）：`PersistentCliSessionOptions.wsProbe`（persistent-session.ts:93）
 * 定义与 `tick()` 消费（超限⇒计划内软释放重建）都在，但**全仓生产注入点零命中**
 * ⇒ 工作集护栏（maxWsBytes，缺省 512MB）永不生效 = 「配了护栏但护栏不存在」，
 * 与 wsProbe 注释自述的「生产默认不注入」互证为死配置族（K3/CL-K3R 同族病灶）。
 *
 * 本模块把探针做实。安全红线（全部显式实现，缺一即回归死配置语义）：
 *  1. **绝不抛**：任何 spawn/读取/解析失败 ⇒ 返回 `undefined`。tick 判据
 *     `typeof ws === 'number'` 自动跳过 ⇒ 未知=不回收（fail-safe：探测失败绝不
 *     触发误杀；「探测未知 ≠ 确超上限」与 GUI 会话 probeError 归因同口径）。
 *  2. **自带节流**：tick 间隔 1–30s 且高频，探针内部最小采样窗（缺省 5s）——
 *     窗口内复用上一样本，零额外 spawn；tasklist 是轻量进程枚举，5s 一采样
 *     的代价与 `Get-NetTCPConnection` 级运维探测同量。
 *  3. **pid 变更即作废缓存**：会话重建（回收/故障重启）后新进程重新计时采样，
 *     绝不把旧 pid 的样本记到新进程头上。
 *  4. **失败也进节流窗**：失败样本同样按采样窗节流（重试窗口=同窗），防
 *     tasklist 不可用环境（裁剪版 Windows/域策略禁用）变成每 tick 重试风暴；
 *     此时护栏静默失效=回到今天的既有状态，无劣化（显式登记于局限）。
 *
 * 接线策略（bridge.ts）：`WINVM_LLM_WS_PROBE=0|false|off` 显式关；**缺省启用**
 * （"默认即安全"哲学，同批5 retention）；仅 win32 平台注入——本 provider 的
 * 部署事实就是跑在 VM（win32）里，宿主/CI 平台不注入探针（逐字旧行为）。
 */

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 采样执行面（测试注入位；缺省走 node 原生同步通路）。 */
export interface WorkingSetProbeIo {
  /** win32：tasklist 同步执行，返回 stdout（CSV 文本）或 null（失败——调用方不抛）。 */
  readonly runTasklist?: (pid: number) => string | null;
  /** posix：读 /proc/<pid>/status 文本；失败返回 null。 */
  readonly readProcStatus?: (pid: number) => string | null;
}

export interface WorkingSetProbeOptions extends WorkingSetProbeIo {
  /** 当前子进程 pid 的取值器（会话可能未启动/已回收 ⇒ undefined=本轮未知）。 */
  readonly pidOf: () => number | undefined;
  /** 平台（缺省 process.platform；单测注入 'win32'/'linux' 走双分支）。 */
  readonly platform?: NodeJS.Platform;
  /** 时间源（测试可控节流窗）。 */
  readonly now?: () => number;
  /** 最小采样间隔（毫秒），缺省 5000。非法值（≤0/NaN）回退缺省。 */
  readonly minIntervalMs?: number;
}

/**
 * 创建一个工作集探针（字节）。返回值语义与 `PersistentCliSessionOptions.wsProbe`
 * 逐字对齐：`number`=当前样本（可能是节流窗内的上一样本）；`undefined`=未知/失败。
 */
export function createWorkingSetProbe(opts: WorkingSetProbeOptions): () => number | undefined {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => Date.now());
  const rawInterval = opts.minIntervalMs;
  const minIntervalMs = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : 5_000;

  const io: Required<Pick<WorkingSetProbeIo, 'runTasklist' | 'readProcStatus'>> = {
    runTasklist: opts.runTasklist ?? defaultRunTasklist,
    readProcStatus: opts.readProcStatus ?? ((pid) => {
      try {
        return readFileSync(`/proc/${pid}/status`, 'utf8');
      } catch {
        return null;
      }
    }),
  };

  /** 上一成功样本；null=尚无/上次失败（失败同样占采样窗，见红线 4）。 */
  let last: { pid: number; bytes: number | null; atMs: number } | undefined;

  return () => {
    const pid = opts.pidOf();
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      // 会话未启动/已回收：清缓存（重建后是新进程），本轮未知。
      last = undefined;
      return undefined;
    }
    const t = now();
    if (last && last.pid === pid && t - last.atMs < minIntervalMs) {
      return last.bytes ?? undefined; // 节流窗：复用上一样本
    }
    const bytes = platform === 'win32'
      ? parseTasklistMemUsage(io.runTasklist(pid))
      : parseProcStatusRss(io.readProcStatus(pid));
    last = { pid, bytes: bytes ?? null, atMs: t };
    return bytes;
  };
}

/* ------------------------------ 解析（纯函数，可独测） ------------------------------ */

/**
 * tasklist CSV：`"chrome.exe","1234","Console","1","1,234 K"`。
 * Mem Usage 列恒为 K（千字节），千分位逗号需剔除。任何一环不成立 ⇒ undefined（不抛）。
 */
export function parseTasklistMemUsage(stdout: string | null | undefined): number | undefined {
  if (!stdout) return undefined;
  const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return undefined;
  const cols = line.split('","').map((c) => c.replace(/^"|"$/g, '').trim());
  const lastCol = cols[cols.length - 1];
  if (!lastCol) return undefined;
  const m = lastCol.match(/^([\d,.]+)\s*K$/i);
  if (!m) return undefined;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1024);
}

/**
 * /proc/<pid>/status 的 `VmRSS:   123456 kB` 行。缺行/单位异常 ⇒ undefined（不抛）。
 */
export function parseProcStatusRss(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/^VmRSS:\s+([\d,]+)\s*kB$/m);
  if (!m) return undefined;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1024);
}

/* ------------------------------ 默认 IO ------------------------------ */

function defaultRunTasklist(pid: number): string | null {
  try {
    const r = nodeSpawnSync(
      'tasklist',
      // 引号内双空格是 /FI 过滤器的官方示例形态；/FO CSV /NH 免表头免标题。
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    if (r.status !== 0) return null;
    const out = typeof r.stdout === 'string' ? r.stdout : null;
    if (!out) return null;
    // tasklist 对不存在的 pid 回显 INFO 行（中文系统为本地化文案），按无样本处理：
    if (/no tasks are running|没有找到任务|信息:/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}
