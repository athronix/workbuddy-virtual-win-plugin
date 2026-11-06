/**
 * ssh2-client.mjs —— delivery 发布层 node ssh2 共享执行体（迭代21 / D-2 落地）。
 *
 * 背景（已定谳，勿重查）：鸿蒙 WB 沙箱的 OpenSSH 二进制（ssh/scp）对 VM 呈**相位性挂起**
 * ——TCP+banner 能过、认证/kex 段随机挂死（rc=124 空 stderr）；同秒对照实锤：node ssh2 库
 * 恒 READY<1s + exec rc=0，二进制同秒 124。skill 层解法（deploy/skills/winvm-plugin-deploy/
 * scripts/ssh2-conn.mjs + vm-conn.sh VM_SSH_BACKEND）已过 QA 四轮验收；本模块是其**库函数形态**
 * （非 CLI），供 delivery/setup|uninstall|bootstrap|prepare-vm|winvm-plugin 的全部 ssh/scp
 * 调用点复用，消灭发布层对二进制的硬依赖。
 *
 * 接口（纯库函数，零 CLI、零 process.exit）：
 *   createSshRunner({ host, port, user, privateKeyPath?, password?, readyTimeoutMs=15000 })
 *     → Promise<runner>，runner = { exec(cmdStr,{timeoutMs}), put(local,remote), get(remote,local),
 *                                    close() }；sftp 复用单连接（懒建）；**惰性建连**（首个
 *     op 才 connect），每调用点独立建连。
 *   runWithBackend({ backend, binary, op, onFallback }) —— 回落策略的**通用装配器**：
 *     key → 直接 binary（原行为）；ssh2 → 只用 op，连接级失败**显式抛错**；
 *     auto → op 优先，**仅连接级失败**（握手超时/网络错/ECONNREFUSED/ssh2 依赖缺失）回落
 *     binary 一发；远端非零码=业务真值，**绝不回落**（回落只会重复执行副作用）。
 *     策略语义由各调用点经 backend 参数自装配，本模块不内置调用点策略。
 *
 * ⚠ 调用点契约（迭代21 QA 登记项 §6，新增调用点前必读——双闸门防回落误触发）：
 *   【红线一：非零码禁重抛 Error】auto 回落的安全性完全依赖「op 绝不把远端非零码重抛为
 *     Error」——远端码必须经 runner.exec 的 resolve 以 {ok:false, code:N} **结果对象**返回
 *     （runVmOp/mapRunnerResult 链路保证）。若调用点在 op 内自行把非零码包成 Error 上抛
 *     （如 `if (!r.ok) throw new Error(...)`），该 Error 可能命中 INFRA_PATTERNS 被分型为
 *     连接级失败 → auto 触发回落 → **二进制二次执行同一命令=重复副作用**。包装文案含
 *     「超时/失败/connection/refused」等字样时尤其危险。判据想抛错的场景请改在
 *     runVmOp 返回**之后**按 res.ok/res.code 判定（参照 winvm-plugin.sshExec 的正规写法）。
 *   【红线二：半途断连=二次执行，写类命令必须幂等】exec 通道中途断流（stream close
 *     code=null）判 infra → auto 回落二进制**再执行一遍**；此时首次执行的远端命令可能
 *     已部分落地。故**新增写类（含副作用）调用点的远端命令必须幂等**（现全量调用点均为
 *     只读探测或幂等 .ps1——每项先探测再动作，二次执行无害；New-Item -Force/
 *     Remove-Item -ErrorAction SilentlyContinue/schtasks 语义均幂等）。非幂等写命令
 *     （如无条件 Add-Content/追加式安装）不得走 auto，应显式 ssh2 后端或改造成幂等形。
 *
 * 凭据纪律（同 ssh2-conn）：
 *   - 私钥 readFileSync 转 Buffer 后传 ssh2 —— ssh2 对**字符串** privateKey 按 PEM 字面量
 *     解析，传路径必报 "Unsupported key format"（run17 实锤坑）；
 *   - password 与 privateKey 可并存（加密私钥口令 / 兜底认证）；
 *   - 零凭据打印：任何错误/日志只含路径与 briefError(≤120 字符) 的 message 摘要，
 *     绝不输出密钥/密码内容；
 *   - ssh2 解析走既有 loadSsh2Client（delivery/ssh2-resolve.mjs，pack 白名单在册，
 *     复用 CL-015 T11 vendor 分发链=无新增分发需求）。
 *
 * 隧道类调用点（setup L1048 spawn('ssh','-N -L') / winvm-plugin L417）**不在本模块范围**：
 * 它们是 oh/ssh2 后端之外的系统 ssh 兜底分支（鸿蒙走 oh-tunnel 路径已被证明恒强）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSsh2Client } from './ssh2-resolve.mjs';

/* ----------------------------- 常量与错误型 ----------------------------- */

/** 基础设施失败码（连接/ready 超时/通道开失败——可回落形态）；与远端真实退出码区分。 */
export const RC_INFRA = 111;

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * 连接级（infra）错误：runWithBackend 据此决定 auto 回落；远端非零码绝不用此型。
 * noSsh2=true 特指 ssh2 运行时依赖解析失败（三要素引导文案在 message 内）。
 */
export class Ssh2InfraError extends Error {
  /**
   * @param {string} message 摘要信息（调用方保证已脱敏）
   * @param {{ noSsh2?: boolean, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'Ssh2InfraError';
    this.infra = true;
    if (options.noSsh2) this.noSsh2 = true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 错误信息脱敏截断（绝不输出密钥/密码内容——凭据纪律）。 */
export function briefError(e) {
  return String((e && e.message) || e || 'unknown').replace(/\r/g, '').slice(0, 120);
}

/**
 * 连接级错误特征表（握手/网络/认证通道层 ⇒ 可回落）。
 * 远端命令非零码不会命中这里（那是 exec resolve 的业务真值，不走 throw）。
 */
const INFRA_PATTERNS = [
  /ready\s*超时|ready\s*timeout/i,
  /handshake|键格式|unsupported key|cannot parse/i,
  /econnrefused|econnreset|epipe|etimedout|ehostunreach|enetunreach|econnaborted|enotfound/i,
  /timed\s*out|超时/i,
  /socket closed|socket hang up|对端关闭|connection closed/i,
  /keepalive|no response from server/i,
  /authentication (?:failed|error)|no authentication methods|all configured authentication/i,
  /缺少必需运行时依赖：ssh2|ssh2 (?:解析失败|不可用)/,
  // 私钥路径缺失=ssh2 通道不可用形态（二进制或有 agent 可救）→ 归 infra 供 auto 回落。
  /私钥文件不存在/,
];

/**
 * 判定任意错误/结果是否属连接级（可触发 auto 回落）。
 * @param {unknown} e Error / 字符串 / runner 结果对象（{infra:true}）
 * @returns {boolean}
 */
export function isInfraFailure(e) {
  if (!e) return false;
  if (e instanceof Ssh2InfraError) return true;
  if (typeof e === 'object' && e.infra === true) return true;
  const text = e instanceof Error ? e.message : String(e);
  if (!text) return false;
  return INFRA_PATTERNS.some((re) => re.test(text));
}

/* ----------------------------- 连接参数（纯函数，可单测） ----------------------------- */

/**
 * 由显式参数构造 ssh2 connect options（校验 + 默认值；不读盘）。
 * privateKeyPath 在此保持**路径字符串**（纯逻辑可测）；真实建连前由
 * resolvePrivateKeyForConnect 转 Buffer。password 与 privateKeyPath 可并存。
 * privateKey（PEM 字符串/Buffer，如 vm-conn.json 持久化形态）与 privateKeyPath 二选一，
 * 前者优先走路径转换；两者全缺且无 password 视为凭据缺失。
 * @param {{host?:string, port?:number|string, user?:string,
 *          privateKeyPath?:string, privateKey?:string|Buffer, password?:string,
 *          readyTimeoutMs?:number}} params
 * @returns {object}
 * @throws {Error} host/user 缺失、port 非法、凭据全缺（错误信息不含凭据内容）
 */
export function buildConnectOptions(params = {}) {
  const host = String(params.host || '').trim();
  if (!host) throw new Error('ssh2-client: host 未设（VM_HOST 缺失）');
  const port = Number(params.port || 22);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('ssh2-client: port 非法: ' + String(params.port));
  }
  const username = String(params.user || '').trim();
  if (!username) throw new Error('ssh2-client: user 未设（VM_USER 缺失）');
  const privateKeyPath = params.privateKeyPath ? String(params.privateKeyPath) : '';
  const hasPem = params.privateKey != null && params.privateKey !== '';
  const password = params.password != null ? String(params.password) : '';
  if (!privateKeyPath && !hasPem && !password) {
    throw new Error('ssh2-client: 凭据缺失（privateKeyPath / privateKey / password 至少其一）');
  }
  /** @type {Record<string, unknown>} */
  const options = {
    host,
    port,
    username,
    readyTimeout: Number(params.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS),
    keepaliveInterval: 8000,
  };
  if (privateKeyPath) options.privateKeyPath = privateKeyPath;
  else if (hasPem) options.privateKey = params.privateKey; // PEM 字符串/Buffer 原样（字符串=PEM 字面量语义，正确）
  if (password) options.password = password;
  return options;
}

/**
 * 真实建连前把 privateKeyPath 解析为 Buffer（ssh2 对字符串 privateKey 按 PEM 字面量
 * 解析——传路径必挂，run17 实锤）。密钥内容绝不打印（凭据纪律）。
 * @param {object} options buildConnectOptions 产物
 * @returns {object} 供 conn.connect() 的参数（privateKeyPath 已被 privateKey:Buffer 取代）
 */
export function resolvePrivateKeyForConnect(options) {
  const { privateKeyPath, ...rest } = options;
  if (!privateKeyPath) return rest;
  if (!existsSync(privateKeyPath)) throw new Error('私钥文件不存在: ' + privateKeyPath);
  return { ...rest, privateKey: readFileSync(privateKeyPath) };
}

/* ----------------------------- 回落策略装配器 ----------------------------- */

/**
 * 双后端策略装配器（调用点自装配语义）：
 *  - backend='key'  → 直接 binary()（原行为不变）；
 *  - backend='ssh2' → 只执行 op()；op 抛连接级错**原样上抛**（显式失败，不碰二进制）；
 *  - backend='auto'（默认）→ op() 优先；仅连接级失败（isInfraFailure 命中或 e.noSsh2）
 *    → onFallback(e) 后 binary() 一发；op 正常返回（含远端非零码的 {ok:false}）不落回落。
 *  ⚠ op 的双闸门契约（非零码禁重抛 Error / 写类命令须幂等）见文件头「调用点契约」段——
 *    违反其一会让 auto 把业务真值误判为连接级失败并二次执行副作用。
 * @template T
 * @param {{backend?:string, binary:(()=>T|Promise<T>), op:(()=>Promise<T>),
 *          onFallback?:(e:unknown)=>void}} opts
 * @returns {Promise<T>}
 */
export async function runWithBackend({ backend = 'auto', binary, op, onFallback = () => {} }) {
  if (backend === 'key' || typeof op !== 'function') return binary();
  try {
    return await op();
  } catch (e) {
    if (backend !== 'auto') throw e;
    if (!(e && (e.noSsh2 || isInfraFailure(e)))) throw e;
    onFallback(e);
    return binary();
  }
}

/* ----------------------------- 调用点通用装配器 ----------------------------- */

/** runner 结果 {ok,code,stdout,stderr} → delivery 旧 run()/spawnSync 形态 {ok,code,out}（消费方零改动；stdout/stderr 一并透出供需要分流的调用方使用）。 */
export function mapRunnerResult(r) {
  return {
    ok: r.ok === true,
    code: r.ok === true ? 0 : (Number.isFinite(r.code) ? r.code : 1),
    out: `${r.stdout || ''}${r.stderr || ''}`,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

/** 有界性护栏：op 总超时（含惰性建连）→ reject 消息含「超时」=infra 型（auto 可回落）。 */
async function withDeadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(new Ssh2InfraError(`ssh2 ${label} 超时（${timeoutMs}ms，含建连）`)),
          Math.max(1, Number(timeoutMs) || 120_000),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单调用点双后端装配器（exec/put/get 通用）：建连→op→finally close。
 * auto 语义与错误分型见 runWithBackend；远端非零码经 mapRunnerResult 原样呈现（业务真值）。
 * @param {{backend?:string, host:string, port?:number, user:string,
 *          privateKeyPath?:string, privateKey?:string|Buffer, password?:string, readyTimeoutMs?:number,
 *          timeoutMs?:number,
 *          op:(runner:Ssh2Runner)=>Promise<{ok:boolean,code:number,stdout:string,stderr:string}>,
 *          binary:()=>Promise<{ok:boolean, code:number, out:string}>,
 *          onFallback?:(e:unknown)=>void,
 *          createRunner?:(p:object)=>Promise<Ssh2Runner>}} params
 * @returns {Promise<{ok:boolean, code:number, out:string}>}
 */
export async function runVmOp(params) {
  const {
    backend = 'auto',
    host, port = 22, user,
    privateKeyPath, privateKey, password,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    timeoutMs = 120_000,
    op, binary,
    onFallback = (e) => process.stderr.write(`[ssh2-client] ssh2 连接级失败，auto 回落二进制：${briefError(e)}\n`),
    createRunner = createSshRunner,
  } = params;
  if (backend === 'key' || typeof op !== 'function') return binary();
  let runner = null;
  try {
    return await runWithBackend({
      backend,
      binary,
      onFallback,
      op: async () => {
        runner = await createRunner({
          host, port, user,
          privateKeyPath: privateKeyPath || undefined,
          privateKey: privateKey || undefined,
          password: password || undefined,
          readyTimeoutMs,
        });
        return mapRunnerResult(await withDeadline(op(runner), timeoutMs + 5_000, 'op'));
      },
    });
  } finally {
    if (runner) {
      try { await runner.close(); } catch { /* 关闭异常不影响结果 */ }
    }
  }
}

/* ----------------------------- 执行体 ----------------------------- */

/** sftp 协议级文件错（SSH_FX_*，1..8）= 业务真值形态；其余（通道断）= infra。 */
function isSftpFileError(e) {
  return typeof e?.code === 'number' && e.code >= 1 && e.code <= 8;
}

/** 远端路径归一（Windows OpenSSH sftp 认正斜杠盘符路径 C:/dir/file）。 */
function normRemote(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * node ssh2 执行体。惰性建连；exec/put/get 复用同一连接（sftp 懒建）；
 * 调用方**必须 finally close()**。每调用点独立实例（简单可靠）。
 */
export class Ssh2Runner {
  /**
   * @param {Function} ClientCtor ssh2 Client 构造器（loadSsh2Client 产物或注入）
   * @param {object} connectOptions resolvePrivateKeyForConnect 产物（privateKey 已是 Buffer）
   */
  constructor(ClientCtor, connectOptions) {
    this._Ctor = ClientCtor;
    this._options = connectOptions;
    this._conn = null;
    this._ready = false;
    this._sftpP = null;
    this._closed = false;
  }

  /** 建立（或复用）连接；ready/error/超时 → Ssh2InfraError。 */
  async _connect() {
    if (this._closed) throw new Ssh2InfraError('ssh2-client: runner 已 close，禁止再复用');
    if (this._conn && this._ready) return;
    const conn = new this._Ctor();
    const opts = this._options;
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { conn.end(); } catch { /* 忽略断开异常 */ }
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Ssh2InfraError(`ssh2 ready 超时（${opts.readyTimeout}ms）host=${opts.host}:${opts.port}`)),
        opts.readyTimeout,
      );
      timer.unref?.();
      conn.once('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      conn.once('error', (e) => fail(new Ssh2InfraError('ssh2 连接错误: ' + briefError(e), { cause: e })));
      conn.once('close', () => fail(new Ssh2InfraError('ssh2 连接被对端关闭（未 ready）')));
      try {
        conn.connect(opts);
      } catch (e) {
        fail(new Ssh2InfraError('ssh2 connect 异常: ' + briefError(e), { cause: e }));
      }
    });
    this._conn = conn;
    this._ready = true;
    // ready 之后的连接级错误不打断（由 stream 级处理器呈现/由下次 op 的重连兜底），
    // 但必须挂监听，避免 EventEmitter 无 'error' 监听直接 throw（oh-tunnel 同款崩溃面）。
    conn.on('error', () => { /* 归下条流的 stream error / 重连处理，绝不裸崩进程 */ });
    conn.on('close', () => { this._ready = false; });
  }

  /** 懒建 sftp 通道（单连接复用）；打不开=infra。 */
  async _sftp() {
    await this._connect();
    if (!this._sftpP) {
      this._sftpP = new Promise((resolve, reject) => {
        this._conn.sftp((e, sftp) =>
          e ? reject(new Ssh2InfraError('ssh2 sftp 打开失败: ' + briefError(e), { cause: e })) : resolve(sftp),
        );
      }).catch((e) => {
        this._sftpP = null; // 失败复位，允许复用连接时重试一次
        throw e;
      });
    }
    return this._sftpP;
  }

  /**
   * VM 侧执行命令。**返回形态**=远端真值（code 可为非 0，不 throw）；
   * 连接级失败（建连/开道/超时/流断）一律 throw Ssh2InfraError 供 runWithBackend 判定。
   * @param {string} command 完整远端命令串（调用方保证跨壳形态：.ps1/EncodedCommand/裸单 token）
   * @param {{timeoutMs?: number}} [opts] 总超时（含惰性建连）
   * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string}>}
   */
  async exec(command, { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS } = {}) {
    await this._connect();
    const conn = this._conn;
    const cmd = String(command);
    return new Promise((resolveP, rejectP) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (v && v.__infra) {
          this._ready = false;
          try { conn.end(); } catch { /* 忽略 */ }
          rejectP(v.err);
          return;
        }
        resolveP(v);
      };
      const timer = setTimeout(
        () => finish({ __infra: true, err: new Ssh2InfraError(`ssh2 exec 超时（${timeoutMs}ms）host=${this._options.host}`) }),
        Math.max(1, Number(timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS),
      );
      timer.unref?.();
      conn.exec(cmd, (e, stream) => {
        if (e) return finish({ __infra: true, err: new Ssh2InfraError('ssh2 exec 打开通道失败: ' + briefError(e), { cause: e }) });
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code) => {
          if (code == null) {
            return finish({ __infra: true, err: new Ssh2InfraError(`ssh2 exec 通道异常中断（code=null，无远端真值）host=${this._options.host}`) });
          }
          finish({ ok: code === 0, code, stdout, stderr });
        });
        stream.on('error', (err) => finish({ __infra: true, err: new Ssh2InfraError('ssh2 exec 流错误: ' + briefError(err), { cause: err }) }));
      });
    });
  }

  /**
   * sftp 上传（scp local→remote 等价）。remote 归一为正斜杠 Windows 路径；
   * 目标父目录逐级 mkdir（已存在视为 OK，Windows OpenSSH sftp 支持 posix mkdir）。
   * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string}>} 业务形态（本地文件缺失/权限=非零返回，不 throw）
   * @throws {Ssh2InfraError} 连接级失败
   */
  async put(localPath, remotePath) {
    const norm = normRemote(remotePath);
    if (!existsSync(localPath)) {
      return { ok: false, code: 1, stdout: '', stderr: `本地文件不存在: ${localPath}` };
    }
    const sftp = await this._sftp();
    const parent = norm.includes('/') ? norm.replace(/\/[^/]*$/, '') : '';
    if (parent) await sftpMkdirp(sftp, parent);
    return new Promise((resolveP, rejectP) => {
      sftp.fastPut(localPath, norm, (e) => {
        if (e) {
          if (isSftpFileError(e)) {
            return resolveP({ ok: false, code: 1, stdout: '', stderr: `sftp put 失败(${briefError(e)}) → ${norm}` });
          }
          return rejectP(new Ssh2InfraError('ssh2 put 通道错误: ' + briefError(e), { cause: e }));
        }
        resolveP({ ok: true, code: 0, stdout: `put OK -> ${norm}`, stderr: '' });
      });
    });
  }

  /**
   * sftp 下载（scp remote→local 等价）。
   * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string}>}
   * @throws {Ssh2InfraError} 连接级失败
   */
  async get(remotePath, localPath) {
    const norm = normRemote(remotePath);
    const sftp = await this._sftp();
    return new Promise((resolveP, rejectP) => {
      const rs = sftp.createReadStream(norm);
      const chunks = [];
      rs.on('data', (d) => chunks.push(d));
      rs.on('error', (e) => {
        if (isSftpFileError(e)) {
          return resolveP({ ok: false, code: 1, stdout: '', stderr: `sftp get 失败(${briefError(e)}): ${norm}` });
        }
        rejectP(new Ssh2InfraError('ssh2 get 通道错误: ' + briefError(e), { cause: e }));
      });
      rs.on('close', () => {
        try {
          mkdirSync(dirname(localPath), { recursive: true });
          writeFileSync(localPath, Buffer.concat(chunks));
          resolveP({ ok: true, code: 0, stdout: `get OK -> ${localPath}`, stderr: '' });
        } catch (e) {
          resolveP({ ok: false, code: 1, stdout: '', stderr: '本地写入失败: ' + briefError(e) });
        }
      });
    });
  }

  /** 关闭连接（幂等；1.5s 兜底不挂调用方）。 */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._ready = false;
    this._sftpP = null;
    const conn = this._conn;
    this._conn = null;
    if (!conn) return;
    await new Promise((res) => {
      const t = setTimeout(res, 1500);
      t.unref?.();
      conn.once('close', () => { clearTimeout(t); res(); });
      try { conn.end(); } catch { clearTimeout(t); res(); }
    });
  }
}

/**
 * 逐级创建远端目录（posix 语义；已存在=OK；盘符根/裸文件名不建）。
 * 失败且 stat 证实不存在 → Ssh2InfraError（通道不健康形态，触发 auto 回落）。
 * @param {object} sftp ssh2 sftp 通道
 * @param {string} remoteDir 正斜杠远端目录
 */
async function sftpMkdirp(sftp, remoteDir) {
  const norm = String(remoteDir).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm || norm === '/' || /^[A-Za-z]:?\/?$/.test(norm) || !norm.includes('/')) return;
  const parent = norm.replace(/\/[^/]*$/, '');
  if (parent && parent !== norm && parent !== '/' && !/^[A-Za-z]:?$/i.test(parent)) {
    await sftpMkdirp(sftp, parent);
  }
  await new Promise((resolveP, rejectP) => {
    sftp.mkdir(norm, (e) => {
      if (!e) return resolveP();
      // 失败可能是「已存在」（Windows OpenSSH 报 code=4 FAILURE）——stat 成功=目录在。
      sftp.stat(norm, (se) =>
        se ? rejectP(new Ssh2InfraError(`远端目录创建失败: ${norm}（${briefError(e)}）`)) : resolveP(),
      );
    });
  });
}

/**
 * 创建执行体（惰性建连）。
 * @param {{host:string, port?:number, user:string, privateKeyPath?:string, password?:string,
 *          readyTimeoutMs?:number,
 *          ssh2Client?:Function,                 // 注入 Client 构造器（单测/上层复用，最高优先）
 *          loadClient?:(o:object)=>Promise<Function>, // 注入解析器（单测模拟 ssh2 缺失）
 *          moduleUrl?:string}} params
 * @returns {Promise<Ssh2Runner>}
 * @throws {Ssh2InfraError} ssh2 运行时依赖不可用（noSsh2=true，含三要素引导文案）
 * @throws {Error} 参数校验失败（host/user/port/凭据全缺）
 */
export async function createSshRunner(params = {}) {
  let options;
  try {
    options = resolvePrivateKeyForConnect(buildConnectOptions(params));
  } catch (e) {
    // 参数/私钥文件级失败：对 ssh2 通道而言=建连不可用（二进制或有 agent/其它默认键可救）
    // ⇒ 归 infra 型，auto 可回落；显式 ssh2 后端则原样显形。
    throw new Ssh2InfraError(briefError(e), { cause: e });
  }
  let Ctor = null;
  try {
    if (typeof params.loadClient === 'function') {
      Ctor = await params.loadClient({ ssh2Client: params.ssh2Client, moduleUrl: params.moduleUrl ?? import.meta.url });
    } else {
      Ctor = await loadSsh2Client({
        ssh2Client: params.ssh2Client,
        moduleUrl: params.moduleUrl ?? import.meta.url,
      });
    }
  } catch (e) {
    // ssh2 解析失败=连接级不可用（auto 可回落二进制；ssh2 显式后端则显式报错）。
    // 引导文案（迭代21 D-2 单测钉住）：ssh2 不可用 → 修复依赖或临时 WINVM_SSH_BACKEND=key。
    throw new Ssh2InfraError(
      'ssh2 不可用（运行时依赖解析失败）→ 请安装/分发 ssh2，或临时设 WINVM_SSH_BACKEND=key 用回二进制通道。原始错误: ' + briefError(e),
      { noSsh2: true, cause: e },
    );
  }
  if (typeof Ctor !== 'function') {
    throw new Ssh2InfraError('ssh2 不可用：Client 构造器解析为空 → 请临时设 WINVM_SSH_BACKEND=key', { noSsh2: true });
  }
  return new Ssh2Runner(Ctor, options);
}
