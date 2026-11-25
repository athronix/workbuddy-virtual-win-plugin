#!/usr/bin/env node
/**
 * WinVM Bridge —— 「连接通道」单一职责模块（阶段 5 · Step 5.1）
 *
 * ## 这个文件负责什么
 *
 * 只负责一件事：**把宿主与 VM 之间的 SSH 传输通道备齐并取证**。具体四块：
 *   1. 私钥探测（`~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`）——三处历史副本的**唯一**收敛点；
 *   2. `vm-conn.json` 的读 / 合并写 / 删（宿主侧连接信息的持久化载体）；
 *   3. ssh2 运行时依赖的离线分发（鸿蒙宿主无系统 ssh，进程内 `import('ssh2')` 必须命中）；
 *   4. 拉起常驻隧道 daemon 并做三段取证（pidfile / state / 裸 TCP banner）。
 *
 * ## 这个文件**不负责**什么（层间隔离三禁令，硬约束）
 *
 * - **不建连接**：本模块不出现 `new Client(`、`.connect(`。真正建连属 `tunnel-daemon.mjs`；
 *   本模块只 spawn 它、读它的产物。违者 = 通道层侵入执行层。
 * - **不知道能力**：不出现 capability / policy / approval 概念。通道层不知道上层有哪些工具、
 *   哪些要审批。一旦它开始判断"这个能力能不能跑"，层就不清了。
 * - **不装插件**：不写 installed_plugins.json、不碰 mcp.json、不投放 skills。
 *   那些属 `install-host.mjs`（部署层）。本模块可被部署层调用，反之不成立。
 *
 * ## 为什么不许它自己建连（历史依据）
 *
 * 连接信息与连接行为必须分开，否则「无 tunnel 环境下做部署」这件事做不到：
 * 部署机可能只想写配置 + 摆文件（`--no-tunnel`），也可能只想证明通道可用（本模块 `apply`）。
 * 若探测/落盘/建连揉在一处，`install-host.mjs --no-tunnel` 就必须连带阉割落盘逻辑，
 * 而落盘逻辑是 `vm-conn.json` 的**唯一写入者**（见下方 §vm-conn 单写者约束）。
 *
 * ## §vm-conn 单写者约束（关键，改动前必读）
 *
 * `install-host.mjs` 在 `--no-tunnel` 路径下**仍然**要写 vm-conn.json（冷装通路：先落配置，
 * 隧道稍后由启动钩子 ensure）。所以：
 *   - 本模块导出 `writeVmConnConfig`，**`install-host.mjs` 继续调用它**（不是"改成只读"）；
 *   - 计划书原话"从 install-host 删除 writeVmConnConfig 调用、改为读 vm-conn.json 拿端口"
 *     与冷装通路冲突，已在本步据实修正为"**迁出实现、保留调用**"——判据改锚"实现只有一份"，
 *     而不是"调用点归零"（调用点归零会让 `--no-tunnel` 冷装拿不到连接信息）。
 *
 * 用法：
 *   node delivery/connect-channel.mjs --vm-host <ip> --vm-user <name> [--vm-ssh-port 22] [--vm-port 18443]
 *                                     [--vm-key <path>] [--home <dir>] [--dry-run]
 *
 * 子命令形态（供运维单独取证通道）：
 *   node delivery/connect-channel.mjs probe   [同上]   # 只读：私钥 + vm-conn + ssh2 依赖三方体检
 *   node delivery/connect-channel.mjs persist [同上]   # 写 vm-conn.json（合并写）
 *   node delivery/connect-channel.mjs vendored [... ]    # 只做 ssh2 运行时依赖落地
 *   node delivery/connect-channel.mjs ensure  [同上]   # 拉起 daemon 并三段取证（幂等）
 *   node delivery/connect-channel.mjs forget  [--home] # 删 vm-conn.json
 *
 * 退出码：0 = 成功后（含 dry-run）；1 = 参数/前提错误；3 = 通道未就绪；4 = 通道存活但不健康。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ============================ 1. 私钥探测（三副本唯一收敛点） ============================
 * 历史病灶：同一套 "id_ed25519 → id_ecdsa → id_rsa" 探测链在三个文件里各写一遍，且**返回值语义已分叉**：
 *   - `install-host.mjs:278`   → 不存在时返回 `undefined`
 *   - `winvm-plugin.mjs:177`   → 不存在时返回 `''`
 *   - `setup.mjs:1095`         → 返回 `{ identityFile, source }` 对象（含 env 优先级）
 * 三份实现的分叉是真实缺陷面：`''` 与 `undefined` 在 `if (probed)` 下恰好等价，故至今未爆，
 * 但任何一处改成 `if (probed !== undefined)` 就会静默改变行为。本模块统一为**单一真相**：
 * 返回 `{ identityFile, source }`，其中 `source ∈ 'env'|'default'|'none'`，
 * 并保留一个 `probeDefaultSshKey()` 兼容返回「路径字符串或 undefined」的旧调用点。
 */

/**
 * 解析隧道私钥（含 env 优先级）。**这是本仓唯一实现**，其余位置一律 import 本函数。
 *
 * 优先级：`WINVM_VM_KEY` env > `~/.ssh/id_ed25519` > `id_ecdsa` > `id_rsa` > 无。
 * env 优先是必要的：ssh2 无法复用系统 ssh agent（OS 级 ssh 能用 agent，进程内 ssh2 不能），
 * 而多机部署时不同 VM 用不同私钥，必须在调用侧可覆盖。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境（默认 process.env；测试可注入）
 * @param {string} [home] 用户主目录（默认 homedir()；测试可注入临时目录）
 * @returns {{identityFile: string|undefined, source: 'env'|'default'|'none'}}
 */
export function resolveTunnelIdentityFile(env = process.env, home = homedir()) {
  const envKey = env?.['WINVM_VM_KEY'];
  if (envKey) return { identityFile: envKey, source: 'env' };
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = join(home, '.ssh', name);
    if (existsSync(p)) return { identityFile: p, source: 'default' };
  }
  return { identityFile: undefined, source: 'none' };
}

/**
 * 兼容旧签名：只返回路径（不存在 → `undefined`）。
 * `install-host.mjs` 与 `winvm-plugin.mjs` 的历史调用点按 `if (probed)` 判定，
 * 统一返回 `undefined` 而非 `''` 是**修掉分叉**而非改变行为（两者在布尔语境等价）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string|undefined}
 */
export function probeDefaultSshKey(env = process.env, home = homedir()) {
  return resolveTunnelIdentityFile(env, home).identityFile;
}

/* ============================ 2. vm-conn.json 读写（唯一写者） ============================ */

/** vm-conn.json 的规范路径。所有读写方必须走本函数，禁止各自拼路径。 */
export function vmConnPath(home = homedir()) {
  return join(home, '.workbuddy', 'winvm', 'vm-conn.json');
}

/** 读取 JSON 文件（不存在/损坏 → null）。 */
function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 持久化 VM 连接配置到 `~/.workbuddy/winvm/vm-conn.json`。
 *
 * **合并写入**（读旧 payload → 覆盖本次提供的字段 → 其余保留）。这是 D5 修正的语义：
 * 旧实现整包覆盖，会把 `identityFile` / `tunnelMode` / `sshBackend` 等既有键清掉。
 * 合并写使「先部署（写 host/user）→ 后配隧道模式（写 tunnelMode）」这类多步配置可叠加。
 *
 * 端口字段**始终写入**（有默认值），因为它们是连接四元组的组成部分，
 * 留旧值会让「换了端口但没生效」表现为难以定位的连不上。
 *
 * @param {{host?:string,user?:string,sshPort?:number,servicePort?:number,identityFile?:string}} cfg
 * @param {string} [home] 目标用户主目录（默认当前用户）；测试可注入临时目录
 * @returns {string} 写入的文件路径
 */
export function writeVmConnConfig({ host, user, sshPort = 22, servicePort = 18443, identityFile }, home = homedir()) {
  const connPath = vmConnPath(home);
  mkdirSync(dirname(connPath), { recursive: true });
  const prev = readJsonSafe(connPath) || {};
  const payload = { ...prev };
  if (host !== undefined) payload.host = host;
  if (user !== undefined) payload.user = user;
  payload.sshPort = sshPort; // 端口带默认值，始终写入
  payload.servicePort = servicePort;
  if (identityFile !== undefined) payload.identityFile = identityFile;
  writeFileSync(connPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return connPath;
}

/** 移除持久化的 VM 连接配置；不存在则视为已清理（返回 false）。 */
export function removeVmConnConfig(home = homedir()) {
  const connPath = vmConnPath(home);
  if (existsSync(connPath)) { rmSync(connPath, { force: true }); return true; }
  return false;
}

/**
 * 解析 VM 连接信息。优先级（高 → 低）：
 *   1) 显式 flags：`--vm-host/--vm-user/--vm-ssh-port/--vm-port`（`--host/--user` 为等价别名）
 *   2) 已存在的持久化配置 `vm-conn.json`
 *   3) 环境变量 `WINVM_HOST` / `WINVM_USER` / `WINVM_VM_SSH_PORT` / `WINVM_SERVICE_PORT`
 *
 * host / user 全缺时返回 `missing: true`，由调用方**报错退出**——
 * 绝不静默回落默认 IP/用户（旧值 `192.168.1.50`/`vmuser` 会把错误目标静默写进 vm-conn.json，
 * 表现为「安装成功但连不上」，比直接失败更难排查）。
 *
 * ## 私钥优先级的一个非显然修正（e2e2R5，勿回退）
 *
 * `vm-conn.json.identityFile` **优先于**盲探测链。理由：固定探测序
 * （`id_ed25519 → id_ecdsa → id_rsa`）会在「VM 专用钥 + 另一把默认钥共存」的环境里
 * 把已固化的正确钥回写成中毒值，造成两层钥语义分裂（部署层认为用 A，运行期实际用 B）。
 * 既有持久化事实是「运行期被验证过的值」，比盲探测更可信。
 *
 * 但持久化的路径**必须仍然存在**才采信（`existsSync`）——否则删了钥文件后
 * 会一直指向不存在的路径，表现为「连不上且不知道为什么」。
 *
 * @returns {{host:string,user:string,sshPort:number,servicePort:number,
 *            identityFile:string|undefined,identitySource:'flag'|'persisted'|'probe'|'none',
 *            missing:boolean}}
 */
export function resolveVmConnection(args, home = homedir(), env = process.env) {
  const persisted = readJsonSafe(vmConnPath(home)) || {};
  const numOr = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const host = args.vmHost ?? args.host ?? persisted.host ?? env?.['WINVM_HOST'] ?? '';
  const user = args.vmUser ?? args.user ?? persisted.user ?? env?.['WINVM_USER'] ?? '';
  const sshPort = numOr(args.vmSshPort ?? persisted.sshPort ?? env?.['WINVM_VM_SSH_PORT'], 22);
  const servicePort = numOr(
    args.vmPort ?? persisted.servicePort ?? env?.['WINVM_SERVICE_PORT'] ?? env?.['WINVM_VM_PORT'],
    args.remotePort ?? 18443,
  );
  // 私钥：显式 --vm-key > 既有 vm-conn.json.identityFile（须仍存在）> 探测链
  let identityFile;
  let identitySource;
  if (args.vmKey) {
    identityFile = args.vmKey;
    identitySource = 'flag';
  } else if (persisted.identityFile && existsSync(persisted.identityFile)) {
    identityFile = persisted.identityFile;
    identitySource = 'persisted';
  } else {
    const probed = resolveTunnelIdentityFile(env, home);
    identityFile = probed.identityFile;
    identitySource = probed.source === 'none' ? 'none' : probed.source;
  }
  return {
    host: host ? String(host) : '',
    user: user ? String(user) : '',
    sshPort,
    servicePort,
    identityFile,
    identitySource,
    missing: !host || !user,
  };
}

/* ============================ 3. ssh2 运行时依赖离线分发 ============================
 * @winvm/core 依赖 ssh2（及其纯 JS 传递依赖 asn1 / bcrypt-pbkdf / tweetnacl），
 * 但插件依赖收集只处理 @winvm/* 作用域，故 ssh2 必须单独落地到插件缓存 node_modules，
 * 否则鸿蒙宿主（无系统 ssh）上进程内 ssh2 隧道 `import('ssh2')` 必失败。
 *
 *  - 源优先级：`<repoRoot>/vendor/ssh2`（离线预置，若为包目录） → `<repoRoot>/node_modules/ssh2`。
 *  - 仅复制 dependencies 传递链（纯 JS）；optional 原生依赖（cpu-features / nan）缺失即跳过
 *    （ssh2 会回落纯 JS 实现，功能不受影响）。
 *  - 扁平落地到 `<pluginRoot>/node_modules/<name>`，幂等（同版本覆盖无害）。
 *  - 对所有平台 best-effort：仅新增数据文件，win32/darwin 的隧道走系统 ssh 不用 ssh2，惰性无害。
 */

/** 解析 ssh2 主包目录：vendor/ssh2 优先（离线预置），否则 node_modules/ssh2。 */
function resolveSsh2Source(repoRoot) {
  const vendor = join(repoRoot, 'vendor', 'ssh2');
  if (existsSync(join(vendor, 'package.json'))) return vendor;
  const nm = join(repoRoot, 'node_modules', 'ssh2');
  return existsSync(nm) ? nm : null;
}

/** 递归收集 ssh2 的纯 JS 传递依赖名（不含 ssh2 自身，不含 optional 原生依赖）。 */
function ssh2TransitiveDeps(repoRoot, pkgDir, seen = new Set()) {
  const pjPath = join(pkgDir, 'package.json');
  if (!existsSync(pjPath)) return seen;
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(pjPath, 'utf8')).dependencies ?? {};
  } catch {
    return seen;
  }
  for (const name of Object.keys(deps)) {
    if (name === 'ssh2' || seen.has(name)) continue;
    seen.add(name);
    const dir = join(repoRoot, 'node_modules', name);
    if (existsSync(join(dir, 'package.json'))) ssh2TransitiveDeps(repoRoot, dir, seen);
  }
  return seen;
}

/**
 * 把 ssh2 + 传递依赖扁平落地到 `depsDest`（顶层 node_modules）。dryRun 仅预览。
 * @returns {{ok:boolean, names:string[], dest:string, reason?:string}}
 */
export function copySsh2Runtime(depsDest, repoRoot, dryRun = false, log = console.log) {
  const src = resolveSsh2Source(repoRoot);
  if (!src) {
    log('  ⚠ 未找到 ssh2 源（vendor/ssh2 与 node_modules/ssh2 均不存在）；隧道将不可用（运行时报三要素引导）。');
    return { ok: false, names: [], dest: depsDest, reason: 'source-missing' };
  }
  const names = ['ssh2', ...ssh2TransitiveDeps(repoRoot, src)];
  if (dryRun) {
    for (const n of names) log(`ssh2 依赖   : ${n}  [dry-run 未复制]`);
    return { ok: true, names, dest: depsDest };
  }
  mkdirSync(depsDest, { recursive: true });
  const copied = [];
  for (const n of names) {
    const s = existsSync(join(repoRoot, 'vendor', n)) ? join(repoRoot, 'vendor', n) : join(repoRoot, 'node_modules', n);
    const d = join(depsDest, n);
    if (!existsSync(join(s, 'package.json'))) {
      log(`  ⚠ 跳过 ${n}（源不存在；可能为 optional 原生依赖，缺失不影响功能）`);
      continue;
    }
    cpSync(s, d, { recursive: true });
    copied.push(n);
  }
  log(`ssh2 依赖   : 已落地 ${names.length} 个包到 ${depsDest}（含纯 JS 传递依赖；optional 原生依赖跳过）`);
  return { ok: true, names: copied, dest: depsDest };
}

/* ============================ 4. 拉起 daemon + 三段取证 ============================
 * 「三段取证」是本仓反复踩坑后的判据（见项目记忆红线 6）：**单看 health=200 不是通道判据**，
 * 因为 HTTP 长连接与「TCP 层能不能连」是两件事。三段依次为：
 *   ① pidfile：进程在且 pid 存活（证明 daemon 起来过，且没退）；
 *   ② state：state.json 属主与 pidfile 一致且 state=RUNNING（证明不是陈旧 state 假绿）；
 *   ③ 裸 TCP banner：能 connect 到 `127.0.0.1:<localPort>`（证明监听真实存在，不走 HTTP）。
 * 任一不过即判通道未就绪，绝不因 ②通过就放行（state 可能是上一次的生命周期残留）。
 */

/** 裸 TCP 可连性探测（不走 HTTP，只看三次握手）。 */
export function probeTcpOpen(port, host = '127.0.0.1', timeoutMs = 3000) {
  return new Promise((res) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      try { sock.destroy(); } catch { /* noop */ }
      res(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 读 daemon 产物（pidfile / state），缺则返回空对象（不抛）。 */
function readDaemonArtifacts(home) {
  const base = join(home, '.workbuddy', 'winvm');
  return {
    pidfile: readJsonSafe(join(base, 'tunnel.pid')) || {},
    state: readJsonSafe(join(base, 'tunnel.state.json')) || {},
    pidfilePath: join(base, 'tunnel.pid'),
    statePath: join(base, 'tunnel.state.json'),
    logPath: join(base, 'tunnel.log'),
  };
}

/** pid 是否存活（sig 0）。跨平台可用（POSIX + Windows 均支持 signal 0）。 */
export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 通道三段取证（**只读**，不拉起任何进程）。
 *
 * @param {{home?:string, localPort?:number}} opts
 * @returns {Promise<{ok:boolean, pidfile:object, state:object, tcp:boolean, verdict:string, detail:string[]}>}
 */
export async function verifyChannel({ home = homedir(), localPort = 18443 } = {}) {
  const art = readDaemonArtifacts(home);
  const pid = art.pidfile?.pid;
  const pidAlive = isPidAlive(pid);
  const stateRunning = String(art.state?.state ?? '').toUpperCase() === 'RUNNING';
  const stateOwner = art.state?.pid;
  const ownerMatch = pid != null && stateOwner != null && Number(stateOwner) === Number(pid);
  const tcp = await probeTcpOpen(localPort);

  const detail = [];
  detail.push(`① pidfile : ${pid ? `pid ${pid} ${pidAlive ? '存活' : '已死'}` : '不存在'}`);
  detail.push(`② state   : ${stateRunning ? 'RUNNING' : (art.state?.state ?? '缺失')}${ownerMatch ? `（属主 pid ${stateOwner} 与 pidfile 一致）` : (stateOwner != null ? `（⚠ 属主 pid ${stateOwner} ≠ pidfile pid ${pid}，陈旧 state 不采信）` : '')}`);
  detail.push(`③ 裸 TCP  : 127.0.0.1:${localPort} ${tcp ? '可连' : '不可连'}`);

  // 判据必须三段同时成立。单独 ①②③ 任一通过都不够：
  //   - 只有 ①：进程活着但没监听（daemon 卡在重连退避里）
  //   - 只有 ②：state 可能是上一次生命周期的残留（属主校验就是为这个）
  //   - 只有 ③：端口可能被别的进程占用（故 ①② 必须一起看）
  let verdict;
  if (pidAlive && stateRunning && ownerMatch && tcp) verdict = 'RUNNING';
  else if (pidAlive && !tcp) verdict = 'DEGRADED';
  else if (!pidAlive) verdict = 'STOPPED';
  else verdict = 'INCONSISTENT'; // pid 活 + 有监听迹象，但 state 属主对不上 = 需人工看台账
  return { ok: verdict === 'RUNNING', pidfile: art.pidfile, state: art.state, tcp, verdict, detail, paths: { pidfile: art.pidfilePath, state: art.statePath, log: art.logPath } };
}

/**
 * 拉起常驻隧道 daemon 并三段取证（幂等：已在 RUNNING 直接返回，不产生第二实例）。
 *
 * **本模块不建连**：spawn 的是 `winvm-plugin.mjs tunnel ensure`，由它去 spawn `tunnel-daemon.mjs`。
 * 这样「谁建连」保持单一（daemon），本模块只负责「确保它起来了 + 证明给我看」。
 *
 * @param {{vm:{host:string,user:string,sshPort?:number,servicePort?:number,identityFile?:string},
 *          home?:string, localPort?:number, dryRun?:boolean, log?:Function}} opts
 * @returns {Promise<{ok:boolean, spawned:boolean, verdict:string, detail:string[]}>}
 */
export async function ensureChannel({ vm, home = homedir(), localPort, dryRun = false, log = console.log } = {}) {
  const port = Number(localPort ?? vm?.servicePort ?? 18443);
  const before = await verifyChannel({ home, localPort: port });
  if (before.ok) {
    log(`通道       : 已在线健康（pid ${before.pidfile?.pid}），无需拉起`);
    return { ok: true, spawned: false, verdict: before.verdict, detail: before.detail };
  }
  if (dryRun) {
    log('[dry-run] 通道 : 将执行 `winvm-plugin tunnel ensure`（当前 ' + before.verdict + '），随后三段取证；本次不 spawn。');
    for (const l of before.detail) log(`  ${l}`);
    return { ok: false, spawned: false, verdict: before.verdict, detail: before.detail };
  }
  if (!vm?.host || !vm?.user) {
    log('通道       : ⚠ 连接信息不全（host/user），无法拉起 daemon');
    return { ok: false, spawned: false, verdict: 'NO-TARGET', detail: before.detail };
  }

  // 经由 winvm-plugin 的 ensure（它内部幂等且负责 spawn daemon + 20s 端口轮询）。
  const wvPlugin = join(__dirname, 'winvm-plugin.mjs');
  if (!existsSync(wvPlugin)) {
    log(`通道       : ⚠ 未找到 ${wvPlugin}，无法拉起 daemon（可用 --no-tunnel 跳过）`);
    return { ok: false, spawned: false, verdict: 'NO-PLUGIN', detail: before.detail };
  }
  const r = spawnSync(process.execPath, [wvPlugin, 'tunnel', 'ensure', '--local-port', String(port)], {
    stdio: 'inherit', env: process.env,
  });
  const spawned = r.status === 0;
  const after = await verifyChannel({ home, localPort: port });
  for (const l of after.detail) log(`  ${l}`);
  if (!after.ok) log(`通道       : ⚠ 拉起后仍未就绪（verdict=${after.verdict}；台账 ${after.paths.pidfile}，日志 ${after.paths.log}）`);
  return { ok: after.ok, spawned, verdict: after.verdict, detail: after.detail };
}

/* ============================ CLI ============================ */

function parseArgs(argv) {
  const out = { _cmd: undefined, dryRun: false, home: homedir(), localPort: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': out.dryRun = true; break;
      case '--home': out.home = argv[++i]; break;
      case '--host': out.host = argv[++i]; break;
      case '--user': out.user = argv[++i]; break;
      case '--vm-host': out.vmHost = argv[++i]; break;
      case '--vm-user': out.vmUser = argv[++i]; break;
      case '--vm-ssh-port': out.vmSshPort = Number(argv[++i]); break;
      case '--vm-port': out.vmPort = Number(argv[++i]); break;
      case '--vm-key': out.vmKey = argv[++i]; break;
      case '--local-port': out.localPort = Number(argv[++i]); break;
      case '--remote-port': out.remotePort = Number(argv[++i]); break;
      // 帮助必须在「未知参数」兜底之前处理：`--help` / `-h` 以 `-` 开头，
      // 若只靠 default 分支的 `startsWith('-')` 判定会先被判未知并 exit 1。
      case '--help': case '-h': out._cmd = 'help'; break;
      default:
        if (a.startsWith('-')) { console.error(`未知参数：${a}\n`); console.log(USAGE); process.exit(1); }
        else if (!out._cmd) out._cmd = a;
        break;
    }
  }
  return out;
}

const USAGE = `用法：
  node delivery/connect-channel.mjs [probe|persist|vendored|ensure|forget] [选项]

选项：
  --vm-host <ip>      VM 地址（别名 --host）
  --vm-user <name>    VM 用户（别名 --user）
  --vm-ssh-port <n>   SSH 端口（默认 22）
  --vm-port <n>       服务端口 / 本地转发端口（默认 18443）
  --vm-key <path>     私钥路径（缺则探测 ~/.ssh 默认链）
  --home <dir>        目标主目录（默认当前用户；测试用）
  --dry-run           只打印计划，不做任何写入 / 不 spawn

子命令（缺省 = probe）：
  probe      只读体检：私钥 + vm-conn + ssh2 依赖 + 通道三段取证
  persist    写 vm-conn.json（合并写）
  vendored   落地 ssh2 运行时依赖到 <home> 下插件缓存（需 --repo-root 自动推定）
  ensure     拉起 daemon 并三段取证（幂等）
  forget     删除 vm-conn.json

退出码：0 成功 / 1 参数或前提错误 / 3 通道未就绪 / 4 通道存活但不健康`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._cmd === 'help' || args._cmd === '--help' || args._cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  const cmd = args._cmd ?? 'probe';
  if (!['probe', 'persist', 'vendored', 'ensure', 'forget'].includes(cmd)) {
    console.error(`未知子命令：${cmd}\n`);
    console.log(USAGE);
    return 1;
  }

  if (cmd === 'forget') {
    const p = vmConnPath(args.home);
    if (args.dryRun) { console.log(`[dry-run] 将删除 ${p}`); return 0; }
    const removed = removeVmConnConfig(args.home);
    console.log(removed ? `已删除 ${p}` : `不存在，跳过：${p}`);
    return 0;
  }

  if (cmd === 'vendored') {
    const repoRoot = resolve(__dirname, '..');
    const dest = join(args.home, '.workbuddy', 'plugins', 'cache', 'winvm', 'winvm-bridge', 'node_modules');
    const r = copySsh2Runtime(dest, repoRoot, args.dryRun);
    return r.ok ? 0 : 1;
  }

  const conn = resolveVmConnection(args, args.home, process.env);
  if (conn.missing) {
    console.error('错误：未解析到 VM 连接信息（host / user）。');
    console.error('  请显式传入：node delivery/connect-channel.mjs ' + cmd + ' --vm-host <ip> --vm-user <name>');
    console.error('  或先运行 node delivery/setup.mjs（会写入 ~/.workbuddy/winvm/vm-conn.json）。');
    return 1;
  }
  const key = conn.identityFile ? `${conn.identityFile}` : '(未探测到默认私钥)';
  console.log(`目标 VM   : ${conn.user}@${conn.host}:${conn.sshPort}`);
  console.log(`服务端口   : ${conn.servicePort}（本地转发同名）`);
  console.log(`私钥       : ${key}`);

  if (cmd === 'persist') {
    const p = vmConnPath(args.home);
    if (args.dryRun) {
      console.log(`[dry-run] 将合并写入 ${p}：host=${conn.host} user=${conn.user} sshPort=${conn.sshPort} servicePort=${conn.servicePort}${conn.identityFile ? ` identityFile=${conn.identityFile}` : ''}`);
      return 0;
    }
    const written = writeVmConnConfig({
      host: conn.host, user: conn.user, sshPort: conn.sshPort, servicePort: conn.servicePort, identityFile: conn.identityFile,
    }, args.home);
    console.log(`VM 连接配置 : 已写入 ${written}（host=${conn.host} user=${conn.user} port=${conn.servicePort}）`);
    return 0;
  }

  if (cmd === 'probe') {
    const repoRoot = resolve(__dirname, '..');
    const src = resolveSsh2Source(repoRoot);
    console.log(`ssh2 源    : ${src ?? '⚠ 缺失（vendor/ssh2 与 node_modules/ssh2 都不存在 → 隧道不可用）'}`);
    const ch = await verifyChannel({ home: args.home, localPort: conn.servicePort });
    console.log('通道取证   :');
    for (const l of ch.detail) console.log(`  ${l}`);
    console.log(`结论       : ${ch.verdict}`);
    if (ch.verdict === 'STOPPED') return 3;
    if (ch.verdict === 'DEGRADED' || ch.verdict === 'INCONSISTENT') return 4;
    return 0;
  }

  // ensure
  const r = await ensureChannel({ vm: conn, home: args.home, localPort: args.localPort ?? conn.servicePort, dryRun: args.dryRun });
  if (r.ok) return 0;
  return r.verdict === 'DEGRADED' || r.verdict === 'INCONSISTENT' ? 4 : 3;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`connect-channel 失败：${e.message}`);
    process.exit(1);
  });
}