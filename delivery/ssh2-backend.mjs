/**
 * ssh2-backend.mjs —— VM SSH 后端三级开关解析（迭代21 / D-2，发布面语义，默认零冲击）。
 *
 * 判定顺序（高→低）：
 *   1) 显式 env `WINVM_SSH_BACKEND=key|ssh2|auto`（临时覆盖/排障入口）；
 *   2) 配置字段（调用方注入）：setup 侧 = .env 同名字段（resolveConfig 已并入 cfg.vmSshBackend）；
 *      宿主 CLI/卸载器侧 = ~/.workbuddy/winvm/vm-conn.json 的 sshBackend 字段（可选，
 *      由安装器之外的手改/后续迭代写入；缺失即跳过本级）；
 *   3) 默认 **auto**（ssh2 优先；连接级失败回落二进制一发；远端非零码不回落）。
 *
 * key=原二进制行为不变；非法值一律视为「未设」逐级下坠（最终安全缺省 auto）。
 * 本模块零运行时依赖（只吃 env map + fs 读 JSON），winvm-plugin.mjs **静态**导入本文件，
 * ssh2-client.mjs 则按需动态导入（本文件必须独立于 ssh2 在场性）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 合法后端值全集（顺序即语义优先级文档序）。 */
export const SSH_BACKENDS = ['key', 'ssh2', 'auto'];

/** 环境变量键（发布面契约，写入 env.example）。 */
export const SSH_BACKEND_ENV_KEY = 'WINVM_SSH_BACKEND';

/**
 * 归一化任意输入为合法后端值；非法/空 → ''（表示「本级未设」）。
 * @param {unknown} raw
 * @returns {''|'key'|'ssh2'|'auto'}
 */
export function normalizeSshBackend(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return SSH_BACKENDS.includes(v) ? v : '';
}

/**
 * 三级判定（env > config 字段 > 默认 auto）。
 * @param {Record<string,string|undefined>} [env] 默认 process.env
 * @param {string} [configValue] 配置层取值（.env / vm-conn.json 的 sshBackend，调用方择一传入）
 * @returns {'key'|'ssh2'|'auto'}
 */
export function resolveSshBackend(env = process.env, configValue = '') {
  const fromEnv = normalizeSshBackend(env[SSH_BACKEND_ENV_KEY]);
  if (fromEnv) return fromEnv;
  const fromCfg = normalizeSshBackend(configValue);
  if (fromCfg) return fromCfg;
  return 'auto';
}

/**
 * 读宿主持久化连接配置 ~/.workbuddy/winvm/vm-conn.json 的 sshBackend 字段（容错：读失败=''）。
 * @param {string} [home] 宿主 home（默认 homedir()）
 * @returns {string} 归一化后的值或 ''
 */
export function readVmConnBackend(home = homedir()) {
  try {
    const p = join(home, '.workbuddy', 'winvm', 'vm-conn.json');
    if (!existsSync(p)) return '';
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return normalizeSshBackend(j && j.sshBackend);
  } catch {
    return '';
  }
}

/**
 * 就地为连接对象补 vmSshBackend 字段（winvm-plugin / uninstall 等无 .env 通道的宿主侧复用）。
 * 判定：env > vm-conn.json.sshBackend > obj 既有值（如 .env 来源） > auto。
 * @param {Record<string, unknown>} obj 连接配置对象（vm/cfg）
 * @param {string} [home] 宿主 home
 * @returns {Record<string, unknown>} 同一对象（便于内联调用）
 */
export function syncVmBackend(obj, home = homedir()) {
  if (!obj || typeof obj !== 'object') return obj;
  const fromConn = readVmConnBackend(home);
  const existing = normalizeSshBackend(obj.vmSshBackend);
  obj.vmSshBackend = resolveSshBackend(process.env, fromConn || existing);
  return obj;
}

/**
 * 默认私钥探测链（与 setup.mjs resolveTunnelIdentityFile / winvm-plugin probeDefaultSshKey 同语义，
 * 收敛为共享实现供无 setup 依赖的调用方使用）：env WINVM_VM_KEY > ~/.ssh/id_ed25519 > id_ecdsa > id_rsa。
 * 只返回**路径**，绝读密钥内容（凭据纪律由 ssh2-client 建连时执行）。
 * @param {Record<string,string|undefined>} [env] 默认 process.env
 * @param {string} [home] 宿主 home
 * @returns {string} 私钥路径；全缺 → ''
 */
export function resolveVmKeyPath(env = process.env, home = homedir()) {
  const envKey = String(env['WINVM_VM_KEY'] || '').trim();
  if (envKey) return envKey;
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = join(home, '.ssh', name);
    if (existsSync(p)) return p;
  }
  return '';
}
