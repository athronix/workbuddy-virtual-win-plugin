#!/usr/bin/env node
/**
 * ssh2-conn.mjs — winvm-plugin-deploy 的 node ssh2 后端通道（run16 定谳结构性解法）
 *
 * 背景（勿重新调查）：鸿蒙 WorkBuddy 沙箱里 OpenSSH 二进制（ssh/scp）对 VM 呈
 * 「相位性挂起」——raw TCP+banner 能通，但完整 ssh 认证段随机挂死（rc=124 空 stderr）。
 * 同秒对照实锤：node ssh2 库 READY 654ms + exec whoami rc=0，而 ssh 二进制 rc=124。
 * 隧道 daemon（delivery/tunnel-daemon.mjs）靠 ssh2 全天恒通 ⇒ 给 vm-conn.sh 的
 * vmssh/vmscp 加 ssh2 后端即可全链受益（driver：deploy/preflight/verify/ps-run/step 等）。
 *
 * 子命令：
 *   exec <cmd...>          VM 侧执行；stdout/stderr 原样透传；exit code = 远端码。
 *                          命令串由 bash 侧单引号包好整体传入（跨壳铁律不变——调用方
 *                          自己保证命令是 .ps1/EncodedCommand 形态，本模块只原样 exec）。
 *   put <local> <remote>   sftp 上传（remote 为正斜杠 Windows 路径，如 C:/WinVMWorkspace/x.ps1）
 *   get <remote> <local>   sftp 下载
 *   ping                   ready 即退 0（带超时；vm_channel_probe ssh2 快路径用）
 *
 * 连接参数全部来自环境变量（与 vm-conn.sh 同一契约）：
 *   VM_HOST / VM_USER(默认 User) / VM_SSH_PORT(默认 22)
 *   WINVM_VM_KEY(私钥路径，默认 ~/.ssh/id_ed25519)
 *   WINVM_SSH_PASSWORD(若设则 privateKey+password 一起传——加密私钥口令)
 *   VM_SSH_READY_TIMEOUT_MS(默认 15000)
 *
 * 凭据纪律：绝不 console.log 打印任何密钥/密码内容；错误只打 e.message 前 120 字符。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 错误信息脱敏截断（绝不输出密钥/密码内容）。 */
function briefError(e) {
  return String((e && e.message) || e || 'unknown').replace(/\r/g, '').slice(0, 120);
}

/**
 * 基础设施失败退出码（连接/ready 超时/exec 通道开失败/sftp 打不开——可重试形态）。
 * 与远端真实 exit code 区分：vm-conn.sh ssh2 分支据此决定「重试/兜底二进制」还是「原样透传」。
 */
const RC_INFRA = 111;

/**
 * 纯函数：从环境变量（或注入对象）构造 ssh2 connect options。
 * 不读真实密钥文件内容——私钥以 ssh2 支持的 path 形式传入，仅做 existsSync 存在性检查。
 * @param {Record<string,string|undefined>} [env] 默认 process.env
 * @returns {object} ssh2 Client.connect 的参数
 * @throws {Error} VM_HOST 缺失 / 端口非法 / 私钥文件不存在（错误信息不含凭据内容）
 */
export function buildConnectOptions(env = process.env) {
  const host = (env.VM_HOST || '').trim();
  if (!host) throw new Error('VM_HOST 未设（问用户）');
  const port = Number(env.VM_SSH_PORT || 22);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('VM_SSH_PORT 非法: ' + String(env.VM_SSH_PORT));
  }
  const keyPath = env.WINVM_VM_KEY || join(homedir(), '.ssh', 'id_ed25519');
  if (!existsSync(keyPath)) throw new Error('私钥文件不存在: ' + keyPath);
  /** @type {object} */
  const options = {
    host,
    port,
    username: env.VM_USER || 'User',
    privateKey: keyPath, // 纯函数只登记 path（可测、不读盘）；建连前由 resolvePrivateKeyForConnect 转 Buffer
    readyTimeout: Number(env.VM_SSH_READY_TIMEOUT_MS || 15000),
    keepaliveInterval: 8000,
  };
  // 密码附带：仅当 WINVM_SSH_PASSWORD 在场（私钥口令/兜底认证），绝不记录内容。
  if (env.WINVM_SSH_PASSWORD) options.password = env.WINVM_SSH_PASSWORD;
  return options;
}

/**
 * 连接前把 privateKey 路径解析为 Buffer 内容（对齐 delivery/tunnel-daemon.mjs 实锤用法：
 * ssh2 对字符串 privateKey 按 PEM 字面量解析——传路径必报 "Unsupported key format"，
 * 必须 readFileSync 得 Buffer）。buildConnectOptions 保持返回 path（纯逻辑可测、不读盘），
 * 本函数仅在真实建连时调用；密钥内容绝不打印（凭据纪律）。
 * @param {object} options buildConnectOptions 产物
 * @returns {object} privateKey 换为 Buffer 的 connect 参数
 */
export function resolvePrivateKeyForConnect(options) {
  if (typeof options.privateKey !== 'string') return options; // 已是 Buffer，原样
  if (!existsSync(options.privateKey)) throw new Error('私钥文件不存在: ' + options.privateKey);
  return { ...options, privateKey: readFileSync(options.privateKey) };
}

/**
 * 加载 ssh2 Client 构造器：复用仓库 delivery/ssh2-resolve.mjs 的确定性解析链
 * （裸 import → node_modules 逐级 → vendor → WINVM_SSH2_DIR）。
 * 注意：loadSsh2Client 返回的就是 Client 构造器本身（不是 {Client} 解构）。
 * @param {string} moduleUrl 调用方 import.meta.url
 * @returns {Promise<Function>}
 */
export async function loadClientCtor(moduleUrl) {
  const selfDir = path.dirname(fileURLToPath(moduleUrl));
  // 候选解析链：仓库内 delivery/ssh2-resolve.mjs（scripts/ → ../..=仓库根），
  // 其次安装/运行侧 overall-root/delivery 绝对路径（spike 已验证可达）。
  const candidates = [
    path.join(selfDir, '..', '..', '..', '..', 'delivery', 'ssh2-resolve.mjs'),
    '/storage/Users/currentUser/winvm-deploy/overall-root/delivery/ssh2-resolve.mjs',
  ];
  let lastErr = null;
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const mod = await import(pathToFileURL(p).href);
      if (typeof mod.loadSsh2Client === 'function') {
        return { load: mod.loadSsh2Client, moduleUrl };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  // 最终兜底：裸 import('ssh2')（node_modules 在场时由 ESM 向上查找命中）
  try {
    const mod = await import('ssh2');
    const Ctor = mod.Client || mod.default;
    if (typeof Ctor === 'function') {
      return { load: async () => Ctor, moduleUrl };
    }
  } catch (e) {
    lastErr = e;
  }
  throw new Error('ssh2 解析失败（delivery/ssh2-resolve.mjs 与 import(ssh2) 均不可达）: ' + briefError(lastErr));
}

/** 建立连接，ready 后回调 conn；error/超时统一 rc=RC_INFRA 退出（信息脱敏，可重试形态）。 */
async function withConnection(load, moduleUrl, handler) {
  const Client = await load({ moduleUrl });
  const options = resolvePrivateKeyForConnect(buildConnectOptions(process.env));
  const conn = new Client();
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      console.error('ssh2-conn: ready 超时（' + options.readyTimeout + 'ms）host=' + options.host);
      try { conn.end(); } catch { /* 忽略断开异常 */ }
      process.exit(RC_INFRA);
    }
  }, options.readyTimeout + 2000);
  timer.unref?.();
  conn.on('ready', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    handler(conn);
  });
  conn.on('error', (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.error('ssh2-conn: 连接错误: ' + briefError(e));
    process.exit(RC_INFRA);
  });
  conn.connect(options);
}

/** exec 子命令：VM 侧执行，stdout/stderr 原样透传，exit code = 远端码。 */
async function cmdExec(conn, argv) {
  if (argv.length === 0) { usage(); process.exit(2); }
  const command = argv.join(' ');
  conn.exec(command, (e, stream) => {
    if (e) {
      console.error('ssh2-conn: exec 失败: ' + briefError(e));
      process.exit(RC_INFRA);
    }
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', (code) => process.exit(code == null ? RC_INFRA : code));
    stream.on('error', (err) => {
      console.error('ssh2-conn: exec 流错误: ' + briefError(err));
      process.exit(RC_INFRA);
    });
  });
}

/** sftp 封装：打开 sftp 或回调错误退出。 */
function withSftp(conn, cb) {
  conn.sftp((e, sftp) => {
    if (e) {
      console.error('ssh2-conn: sftp 打开失败: ' + briefError(e));
      process.exit(RC_INFRA);
    }
    cb(sftp);
  });
}

/** 递归建远端目录（Windows OpenSSH sftp 支持 posix mkdir；逐级创建，已存在视为 OK）。 */
function mkdirRemoteP(sftp, remoteDir, done) {
  const norm = String(remoteDir).replace(/\\/g, '/').replace(/\/+$/, '');
  // 空/根/盘符（C:）/无目录成分 → 不建（裸文件名上传=落在 sftp 默认目录，勿把文件名当目录建）
  if (!norm || norm === '/' || /^[A-Za-z]:?\/?$/.test(norm) || !norm.includes('/')) { done(null); return; }
  sftp.mkdir(norm, (e) => {
    if (e) { // 失败可能是「已存在」(code=4/SSH_FX_FAILURE)——stat 成功=目录在
      sftp.stat(norm, (se) => done(se ? e : null));
      return;
    }
    done(null);
  });
}

/** put 子命令：本地文件上传到 remote（正斜杠 Windows 路径）。 */
async function cmdPut(conn, local, remote) {
  if (!local || !remote) { usage(); process.exit(2); }
  if (!existsSync(local)) {
    console.error('ssh2-conn: 本地文件不存在: ' + local);
    process.exit(1);
  }
  withSftp(conn, (sftp) => {
    const norm = String(remote).replace(/\\/g, '/');
    const remoteDir = norm.includes('/') ? norm.replace(/\/[^/]*$/, '') : '';
    mkdirRemoteP(sftp, remoteDir, () => {
      const ws = sftp.createWriteStream(norm);
      ws.on('close', () => { console.error('ssh2-conn: put OK -> ' + norm); process.exit(0); });
      ws.on('error', (e) => {
        console.error('ssh2-conn: put 失败: ' + briefError(e));
        process.exit(RC_INFRA);
      });
      const rs = readFileSync(local);
      ws.end(rs);
    });
  });
}

/** get 子命令：从 remote（VM 侧正斜杠路径）下载到本地文件。 */
async function cmdGet(conn, remote, local) {
  if (!remote || !local) { usage(); process.exit(2); }
  withSftp(conn, (sftp) => {
    const rs = sftp.createReadStream(remote);
    const chunks = [];
    rs.on('data', (d) => chunks.push(d));
    rs.on('error', (e) => {
      console.error('ssh2-conn: get 读取失败: ' + briefError(e));
      process.exit(RC_INFRA);
    });
    rs.on('close', () => {
      try {
        writeFileSync(local, Buffer.concat(chunks));
        console.error('ssh2-conn: get OK -> ' + local);
        process.exit(0);
      } catch (e) {
        console.error('ssh2-conn: 本地写入失败: ' + briefError(e));
        process.exit(1);
      }
    });
    rs.on('end', () => { /* close 收尾 */ });
  });
}

/** ping 子命令：ready 即退 0（带超时，由 withConnection 的 readyTimeout 控制）。 */
async function cmdPing(conn) {
  console.error('ssh2-conn: pong ready');
  try { conn.end(); } catch { /* 忽略 */ }
  process.exit(0);
}

function usage() {
  console.error('用法: ssh2-conn.mjs <exec <cmd...>|put <local> <remote>|get <remote> <local>|ping>');
  console.error('环境变量: VM_HOST VM_USER VM_SSH_PORT WINVM_VM_KEY WINVM_SSH_PASSWORD VM_SSH_READY_TIMEOUT_MS');
}

/** CLI 主入口。 */
async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub) { usage(); process.exit(2); }
  await withConnection(
    (await loadClientCtor(import.meta.url)).load,
    import.meta.url,
    (conn) => {
      if (sub === 'exec') return cmdExec(conn, rest);
      if (sub === 'put') return cmdPut(conn, rest[0], rest[1]);
      if (sub === 'get') return cmdGet(conn, rest[0], rest[1]);
      if (sub === 'ping') return cmdPing(conn);
      usage();
      process.exit(2);
    },
  );
}

// 仅在作为脚本直接执行时进入 CLI；被单测 import 时只导出纯函数（不触网）。
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('ssh2-conn: ' + briefError(e));
    process.exit(1);
  });
}
