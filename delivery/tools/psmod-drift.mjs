#!/usr/bin/env node
/**
 * psmod-drift.mjs —— R-4 版本指纹·宿主侧漂移对账（Phase 3 批2）
 *
 * 病灶（A2-4 / arch3 D-3）：改 psmode/*.ps1 不重启即静默不生效（ps-bridge 不可热更），
 * 且旧 /health 的 psBridge 只有 uptime，无法证明"VM 里跑的到底是哪一版模块"。
 *
 * 本工具做**三方对账**，把"实跑了吗/生效了吗"变成一条命令可机械回答：
 *   ① 源仓哈希    —— <repo>/packages/vm-capabilities/psmod/*.ps1 现场 SHA256；
 *   ② 进程指纹    —— /health.psBridge.fingerprint（ps-bridge.ps1 **启动期**算的哈希，
 *                     进程存活期间恒定 —— 这正是"生效与否"的判据）；
 *   ③ VM 磁盘哈希 —— （可选 --vm-disk）经 ssh 只读 sha256sum 读 VM 上分发后的 psmod 文件。
 *
 * 判读矩阵：
 *   ①=②            ⇒ 生效：VM 进程跑的就是源仓当前版（PASS）
 *   ①=③ 且 ②≠①    ⇒ **漂移未生效**：deploy 已把新文件推到 VM 磁盘，但进程没重启，
 *                     还在跑旧版 ⇒ 需 kill-restart.ps1（FAIL-DRIFT，本工具核心产出）
 *   ③≠①            ⇒ 分发本身落后：deploy-vm 未跑或推了旧包（FAIL-STALE）
 *   fingerprint 缺席 ⇒ 旧版 ps-bridge（不带指纹）：报告"无法证明版本"（FAIL-NOFP）
 *
 * 纪律：纯 Node stdlib；对 VM 只读（curl /health、sha256sum 读取），零写入、零重启动作；
 * 默认走宿主回环隧道（127.0.0.1:18443/health），可 --url 覆盖。退出码 0=PASS，1=任何 FAIL。
 *
 * 用法：
 *   node delivery/tools/psmod-drift.mjs                 # ①vs② 经隧道
 *   node delivery/tools/psmod-drift.mjs --vm-disk \
 *        --vm-user User --vm-host 172.16.100.2          # 三方对账（ssh 只读）
 *   node delivery/tools/psmod-drift.mjs --url http://127.0.0.1:18443/health
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const PSMOD_DIR = join(REPO_ROOT, 'packages', 'vm-capabilities', 'psmod');

/* ----------------------------- 参数 ----------------------------- */

function parseArgs(argv) {
  const o = {
    url: 'http://127.0.0.1:18443/health',
    vmDisk: false,
    vmHost: process.env['VM_HOST'] || '',
    vmUser: process.env['VM_USER'] || '',
    vmSshPort: Number(process.env['VM_SSH_PORT'] || 22),
    vmPsmodDir: 'C:/WinVMBridge/packages/vm-capabilities/psmod',
    timeoutMs: 8000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': o.url = argv[++i]; break;
      case '--vm-disk': o.vmDisk = true; break;
      case '--vm-host': o.vmHost = argv[++i]; break;
      case '--vm-user': o.vmUser = argv[++i]; break;
      case '--vm-ssh-port': o.vmSshPort = Number(argv[++i]); break;
      case '--vm-psmod-dir': o.vmPsmodDir = argv[++i]; break;
      case '--timeout': o.timeoutMs = Number(argv[++i]) || o.timeoutMs; break;
      default: break;
    }
  }
  return o;
}

/* ----------------------------- ① 源仓哈希 ----------------------------- */

/**
 * 计算源仓 psmod 全部 .ps1 的 SHA256（小写 hex）。
 * @param {string} dir psmod 目录
 * @returns {Record<string,string>} 文件名 → sha256
 */
export function hashPsmodDir(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ps1')).sort()) {
    out[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  }
  return out;
}

/* ----------------------------- ② /health 进程指纹 ----------------------------- */

/**
 * 拉取 /health（回环隧道或 --url），返回 JSON。
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
export function fetchHealth(url, timeoutMs = 8000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      rejectPromise(new Error(`--url 非法：${url}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) {
          rejectPromise(new Error(`HTTP ${res.statusCode} @ ${url}`));
          return;
        }
        try { resolvePromise(JSON.parse(body)); }
        catch { rejectPromise(new Error(`/health 响应非 JSON（${body.slice(0, 120)}）`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时（${timeoutMs}ms）：${url}（隧道在线？）`)); });
    req.on('error', rejectPromise);
  });
}

/**
 * 从 /health 载荷提取 psBridge.fingerprint（形状容错：缺席返回 null）。
 * @param {object} health
 * @returns {{files: Record<string,string>, capturedAt: string, pid?: number, psVersion?: string, failedLoads?: string[]} | null}
 */
export function extractFingerprint(health) {
  const fp = health?.psBridge?.fingerprint;
  if (!fp || typeof fp !== 'object' || typeof fp.files !== 'object' || fp.files === null) return null;
  return fp;
}

/* ----------------------------- 对账（纯函数，可单测） ----------------------------- */

/**
 * 三方对账核心（纯函数）。
 * @param {{repo: Record<string,string>, proc: Record<string,string>|null, disk?: Record<string,string>|null}} h
 * @returns {{verdict:'PASS'|'DRIFT'|'STALE'|'NO_FINGERPRINT'|'MIXED', lines:string[], fail:boolean, driftFiles:string[]}}
 */
export function reconcile(h) {
  const lines = [];
  const repo = h.repo;
  const proc = h.proc;
  const disk = h.disk ?? null;

  if (!Object.keys(repo).length) {
    return { verdict: 'MIXED', lines: ['源仓 psmod 目录为空/不存在（仓库损坏？）'], fail: true, driftFiles: [] };
  }

  // ② 进程指纹缺席：旧版 ps-bridge（不带 R-4） ⇒ 无法证明版本（loud fail，不静默放行）
  if (!proc) {
    lines.push('VM 进程指纹缺席：/health.psBridge.fingerprint 不存在 ⇒ 跑的是不带 R-4 指纹的旧 ps-bridge，');
    lines.push('  版本无从证明。配方：deploy-vm --apply 后跑 tools/kill-restart.ps1（真机面，本工具不执行）。');
    // 若有磁盘面，仍可先答"分发是否落后"
    if (disk) {
      const bad = diffMaps(repo, disk);
      lines.push(`  旁证（VM 磁盘 vs 源仓）：${bad.length ? `${bad.length} 个文件不一致 ⇒ 分发落后：${bad.join(',')}` : '磁盘=源仓（分发已到位，仅版本不可证）'}`);
      return { verdict: 'NO_FINGERPRINT', lines, fail: true, driftFiles: bad };
    }
    return { verdict: 'NO_FINGERPRINT', lines, fail: true, driftFiles: [] };
  }

  const procDiff = diffMaps(repo, proc);
  if (procDiff.length === 0) {
    lines.push(`PASS：VM ps-bridge 进程启动期指纹 = 源仓当前哈希（${Object.keys(repo).length} 文件全同）。生效版可信。`);
  }

  let verdict = 'PASS';
  let fail = false;
  if (procDiff.length > 0) {
    if (disk) {
      const diskDiff = diffMaps(repo, disk);
      if (diskDiff.length === 0) {
        verdict = 'DRIFT';
        fail = true;
        lines.push(`FAIL-DRIFT（漂移未生效）：VM 磁盘 psmod = 源仓（deploy 已到位），但**进程仍在跑旧版**：${procDiff.join(', ')}`);
        lines.push('  处置：kill-restart.ps1（重启后 capturedAt 应刷新、指纹转 PASS。本工具零重启动作）。');
      } else {
        verdict = 'STALE';
        fail = true;
        lines.push(`FAIL-STALE（分发落后）：VM 磁盘 psmod 与源仓不一致：${diskDiff.join(', ')}；进程旧版差异另见下。`);
        lines.push('  处置：node delivery/deploy-vm.mjs --apply（重部署），随后 kill-restart.ps1。');
      }
    } else {
      verdict = 'DRIFT';
      fail = true;
      lines.push(`FAIL：进程启动期指纹 ≠ 源仓（${procDiff.length} 文件：${procDiff.join(', ')}）。`);
      lines.push('  含义：要么 deploy 推了新版未重启（漂移未生效），要么 VM 跑旧版。加 --vm-disk 做三方对账可分辨。');
    }
  }

  return { verdict, lines, fail, driftFiles: procDiff };
}

/** a 与 b 的键集/值差异：返回不一致文件名列表（含单边缺失）。 */
function diffMaps(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const bad = [];
  for (const k of [...keys].sort()) {
    if (a[k] !== b[k]) bad.push(k);
  }
  return bad;
}

/* ----------------------------- ③ VM 磁盘哈希（可选，ssh 只读） ----------------------------- */

/**
 * 经 ssh 只读取 VM 磁盘 psmod SHA256（sha256sum 可用则用；MSYS 通道，输出解析 `hash *name`/`hash  name`）。
 * @returns {Record<string,string>|null} 失败返回 null（调用方降级两方对账）
 */
function vmDiskHashes(o) {
  if (!o.vmHost || !o.vmUser) return null;
  const cmd = `cd '${o.vmPsmodDir}' && sha256sum *.ps1`;
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', String(o.vmSshPort), `${o.vmUser}@${o.vmHost}`, cmd], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) return null;
  const out = {};
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?([A-Za-z0-9_.\-]+\.ps1)\s*$/i);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return Object.keys(out).length ? out : null;
}

/* ----------------------------- main ----------------------------- */

async function main() {
  const o = parseArgs(process.argv.slice(2));

  const repo = hashPsmodDir(PSMOD_DIR);
  console.log(`源仓 psmod（${PSMOD_DIR}）：${Object.keys(repo).length} 个 .ps1`);

  let health = null;
  let healthErr = '';
  try {
    health = await fetchHealth(o.url, o.timeoutMs);
  } catch (e) {
    healthErr = e.message;
  }

  let procFp = null;
  let failedLoads = [];
  if (health) {
    procFp = extractFingerprint(health);
    if (procFp) {
      console.log(`VM 进程指纹（capturedAt=${procFp.capturedAt}, pid=${procFp.pid ?? '?'}）：${Object.keys(procFp.files ?? {}).length} 文件`);
      if (Array.isArray(procFp.failedLoads) && procFp.failedLoads.length) {
        failedLoads = procFp.failedLoads;
        console.log(`⚠ 启动期加载失败模块（点名）：${failedLoads.join(', ')}`);
      }
    } else {
      console.log('VM 进程指纹：缺席（旧版 ps-bridge）');
    }
  } else {
    console.log(`/health 拉取失败：${healthErr}`);
  }

  const disk = o.vmDisk ? vmDiskHashes(o) : null;
  if (o.vmDisk) console.log(`VM 磁盘哈希：${disk ? `${Object.keys(disk).length} 文件` : '不可得（ssh/sha256sum 失败）——降级两方对账'}`);

  const res = health
    ? reconcile({ repo, proc: procFp ? procFp.files : null, disk })
    : { verdict: 'MIXED', fail: true, driftFiles: [], lines: [`FAIL：无法触达 /health（${healthErr}）。隧道在线？（tunnel-runbook §①判活三值）`] };

  console.log('');
  for (const l of res.lines) console.log(`  ${l}`);
  console.log('');
  console.log(`结论：${res.verdict}`);
  if (res.verdict === 'PASS') {
    console.log('  （生效版 = 源仓版；psmod 再改动需 deploy-vm + kill-restart 后重跑本对账）');
  }
  process.exitCode = res.fail ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`psmod-drift.mjs 异常：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, main, vmDiskHashes };
