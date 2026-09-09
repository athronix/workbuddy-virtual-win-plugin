#!/usr/bin/env node
/**
 * 用户级 PATH 管理工具（Q2）
 *
 * 背景：宿主安装器把 `winvm-plugin` 启动器落盘到插件缓存根
 *   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/
 * 该目录默认不在 PATH 里，用户只能进目录跑或手动加 PATH。
 * 这里在安装时把该目录加入【用户 PATH】、卸载时精确移除，使 `winvm-plugin` 全局可用。
 *
 * 设计要点：
 *  - 用 [Environment]::Get/SetEnvironmentVariable('Path','User') 直接读写用户 PATH，
 *    不截断系统 PATH（setx 会整体覆盖，风险高，故不用）。
 *  - 路径规范化（去尾随斜杠、去空白）后做精确相等匹配：
 *      · add 幂等：已存在则原样返回；
 *      · remove 按「规范化后相等」剔除，不靠子串匹配，避免误删含该目录名的其它路径。
 *  - 纯逻辑 applyPathOp 与系统无关，便于单测；PowerShell 交互只在 addTo/removeFrom 里发生。
 */

import { spawnSync } from 'node:child_process';

/** 规范化路径条目：去尾随斜杠、去首尾空白（Windows 不区分大小写，但保持原样比较以避免改写用户既有条目）。 */
export function normalizePathEntry(s) {
  return String(s).replace(/[\\/]+$/g, '').trim();
}

/**
 * 纯函数：对当前 PATH 字符串（分号分隔）应用 add/remove 某目录，返回新字符串。
 * @param {string} currentRaw 当前 PATH（可能为空）
 * @param {string} dir 目标目录
 * @param {'add'|'remove'} op
 * @returns {string} 新的 PATH 字符串（add 且无变化时原样返回）
 */
export function applyPathOp(currentRaw, dir, op) {
  const target = normalizePathEntry(dir);
  const parts = String(currentRaw ?? '').split(';').map((p) => p.trim()).filter(Boolean);
  if (op === 'add') {
    if (parts.some((p) => normalizePathEntry(p) === target)) return currentRaw; // 已存在，幂等
    return [...parts, dir].join(';');
  }
  // remove：精确剔除规范化后相等的条目
  const next = parts.filter((p) => normalizePathEntry(p) !== target);
  return next.join(';');
}

/** 读取当前用户 PATH（原始字符串）。 */
export function getUserPathRaw() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', '[Environment]::GetEnvironmentVariable("Path","User")'],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

/** 将字符串包成 PowerShell 单引号字面量（反斜杠为字面量；单引号用 '' 转义）。 */
function quotePowerShell(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 广播 WM_SETTINGCHANGE（lParam="Environment"），让正在运行的 explorer（桌面 shell）
 * 重新加载环境变量。部署写完后调用：已登录的 RDP/控制台会话里**新开**的终端（PowerShell/cmd）
 * 无需注销即可直接拿到更新后的 PATH；已打开的旧窗口仍需重开才生效。
 *
 * 设计要点：
 *  - 仅 Windows 生效；非 win32 直接跳过（单测/跨平台安全）。
 *  - best-effort：经 HWND_BROADCAST + SMTO_ABORTIFHUNG(0x2) + 5s 超时，即便无桌面
 *    （如 SSH 非交互会话）也只是返回，绝不影响「PATH 已写入」这一主干结果。
 *  - 用单引号 here-string（@'...'@）包 C# 类型定义，避免 $ 展开；关闭定界符 '@ 必须处于行首。
 */
function broadcastEnvChange() {
  if (process.platform !== 'win32') return;
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class Win32EnvBroadcast {",
    '  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]',
    "  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);",
    "}",
    "'@",
    "$r = [UIntPtr]::Zero",
    "[Win32EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 0x2, 5000, [ref]$r) | Out-Null",
  ].join('\r\n');
  // 忽略结果：即便无桌面/超时也不应影响主干
  spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
}

/** 写入用户 PATH（原始字符串）。写成功后广播 WM_SETTINGCHANGE 让新终端免注销生效。 */
export function setUserPathRaw(raw) {
  // 注意：不能用 JSON.stringify —— PowerShell 双引号字符串里反斜杠不是转义符，
  // "C:\\foo" 会被当成字面双反斜杠，导致写进注册表的路径带双反斜杠、回读匹配失败。
  // 改用单引号字符串（反斜杠为字面量）。
  const script = `[Environment]::SetEnvironmentVariable("Path", ${quotePowerShell(raw)}, "User")`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`设置用户 PATH 失败 (status ${r.status ?? '?'})`);
  // 让已运行桌面会话里新开的终端无需注销即可看到新 PATH（旧窗口仍须重开）
  broadcastEnvChange();
}

/**
 * 安装：把 dir 加入用户 PATH（幂等）。
 * @returns {boolean} 是否发生了变更（dryRun 时返回「将会变更」但不写盘）
 */
export function addToUserPath(dir, { dryRun = false } = {}) {
  const raw = getUserPathRaw();
  const next = applyPathOp(raw, dir, 'add');
  if (next === raw) return false;
  if (!dryRun) setUserPathRaw(next);
  return true;
}

/**
 * 卸载：从用户 PATH 精确移除 dir。
 * @returns {boolean} 是否发生了变更（dryRun 时返回「将会变更」但不写盘）
 */
export function removeFromUserPath(dir, { dryRun = false } = {}) {
  const raw = getUserPathRaw();
  const next = applyPathOp(raw, dir, 'remove');
  if (next === raw) return false;
  if (!dryRun) setUserPathRaw(next);
  return true;
}
