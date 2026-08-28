/**
 * SSH 隧道传输（默认，SECURITY-GOVERNANCE.md §2 第 0/1 层）
 *
 * 为什么默认它：
 *   1. VM 侧服务仅监听 127.0.0.1 —— VM 对外零端口暴露；
 *   2. 鉴权与加密由 SSH 承担 —— 无需自签证书或 token 轮换；
 *   3. 一条隧道同时承载 MCP(/mcp) 与 A2A(/a2a) —— 纯 stdio 方案做不到。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

import type { SshTunnelTransport } from '@winvm/contracts';

import { TransportError } from './types.js';

export interface TunnelHandle {
  readonly localPort: number;
  readonly baseUrl: string;
  readonly pid: number | undefined;
  /** 关闭隧道 */
  close(): Promise<void>;
  /** 隧道进程是否已退出 */
  exited(): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 探测本地端口是否可连 */
function probePort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export interface EstablishTunnelOptions {
  readonly cfg: SshTunnelTransport;
  /** 等待隧道就绪的超时（毫秒） */
  readonly readyTimeoutMs?: number;
  /** 额外的 ssh 选项 */
  readonly extraOptions?: readonly string[];
  readonly onStderr?: (chunk: string) => void;
}

/**
 * 建立 SSH 本地端口转发隧道并等待其就绪。
 * 采用 `-N`（不执行远程命令）+ `-L` 转发，VM 侧只需监听回环。
 */
export async function establishSshTunnel(
  opts: EstablishTunnelOptions,
): Promise<TunnelHandle> {
  const { cfg } = opts;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;

  const target = `${cfg.user}@${cfg.host}`;
  const forwardSpec = `${cfg.localPort}:127.0.0.1:${cfg.remotePort}`;

  const args: string[] = [
    '-N',
    '-L',
    forwardSpec,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `ServerAliveInterval=${cfg.serverAliveInterval ?? 30}`,
    '-o',
    `ServerAliveCountMax=${cfg.serverAliveCountMax ?? 3}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...(cfg.port ? ['-p', String(cfg.port)] : []),
    ...(cfg.identityFile ? ['-i', cfg.identityFile] : []),
    ...(opts.extraOptions ?? []),
    target,
  ];

  const child: ChildProcess = spawn('ssh', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  let stderrBuf = '';
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stderrBuf += s;
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
    opts.onStderr?.(s);
  });

  const exited = { value: false };
  child.once('exit', () => {
    exited.value = true;
  });

  // 等待本地端口就绪
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exited.value) {
      throw new TransportError(
        `SSH 隧道进程提前退出（目标 ${target}）。stderr: ${stderrBuf.trim() || '(空)'}`,
      );
    }
    if (await probePort('127.0.0.1', cfg.localPort)) break;
    if (Date.now() >= deadline) {
      child.kill();
      throw new TransportError(
        `SSH 隧道在 ${readyTimeoutMs}ms 内未就绪（127.0.0.1:${cfg.localPort}）。` +
          `stderr: ${stderrBuf.trim() || '(空)'}`,
      );
    }
    await sleep(300);
  }

  return {
    localPort: cfg.localPort,
    baseUrl: `http://127.0.0.1:${cfg.localPort}`,
    pid: child.pid,
    exited: () => exited.value,
    async close() {
      if (!exited.value) child.kill();
      await Promise.race([
        new Promise<void>((r) => child.once('exit', () => r())),
        sleep(3000),
      ]);
      if (!exited.value) child.kill('SIGKILL');
    },
  };
}

/** 生成可复制的 ssh 隧道命令（供 Skill 文档与人工排障使用） */
export function renderSshCommand(cfg: SshTunnelTransport): string {
  const parts = [
    'ssh',
    '-f',
    '-N',
    '-L',
    `${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `ServerAliveInterval=${cfg.serverAliveInterval ?? 30}`,
    '-o',
    `ServerAliveCountMax=${cfg.serverAliveCountMax ?? 3}`,
    ...(cfg.port ? ['-p', String(cfg.port)] : []),
    ...(cfg.identityFile ? ['-i', cfg.identityFile] : []),
    `${cfg.user}@${cfg.host}`,
  ];
  return parts.join(' ');
}
