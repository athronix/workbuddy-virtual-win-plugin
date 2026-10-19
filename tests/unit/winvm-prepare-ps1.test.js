/**
 * REL-11 B · tools/winvm-prepare.ps1 资产守卫（单一真相源）
 *
 * ## 为什么存在
 * winvm-prepare.ps1 是铠大师「VM 环境准备」按钮推送执行的**静态磁盘资产**（非运行时生成的
 * PS 载荷），而本仓所有远端 PowerShell 载荷都踩过同一个坑：**PS 5.1 无 BOM UTF-8 按 ANSI
 * 码页解码 ⇒ 非 ASCII 字符乱码、整脚本报废**。该文件由人手维护，没有生成器兜底，
 * 必须有机检钉。同时钉住输出契约锚点（KV 行）与幂等判据骨架——文档 §4.2 承诺铠大师
 * 解析这些 KV，脚本悄悄改名 = 双端静默分叉。
 *
 * ## 判据（脱 VM、零 spawn powershell、纯磁盘读）
 *   ① 字节全 ASCII（>127 零命中）+ 无 BOM（无 BOM 才有码页乱码风险，双保险）
 *   ② CRLF：不含孤立 LF（LF 前必为 \r）
 *   ③ param 头 + 关键锚点（Add-WindowsCapability / New-NetFirewallRule /
 *      administrators_authorized_keys / icacls / PREPARE_DONE=True / 全部 KV 键名）
 *   ④ 不含任何中文字符（CJK 统一表意文字面显式钉死，防"ASCII 已通过、注释仍回潮"路径）
 *   ⑤ KV 契约完备性：八键输出行锚点齐 + G1 双文件注入 + 幂等 [SKIP] 形态
 *
 * 运行（只跑本文件）：node --test tests/unit/winvm-prepare-ps1.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PS1 = join(import.meta.dirname, '..', '..', 'tools', 'winvm-prepare.ps1');
const BUF = readFileSync(PS1);
const SRC = BUF.toString('latin1'); // latin1 保字节面，ASCII/BOM 判据按字节说话

/* ============================ ① 编码面 ============================ */

test('winvm-prepare.ps1：字节全 ASCII（>127 零命中）', () => {
  const offenders = [];
  for (let i = 0; i < BUF.length; i += 1) {
    if (BUF[i] > 0x7f) offenders.push(i);
    if (offenders.length > 4) break;
  }
  assert.deepEqual(offenders, [], `发现非 ASCII 字节（PS 5.1 ANSI 码页必乱码）：offsets=${offenders.join(',')}`);
});

test('winvm-prepare.ps1：无 BOM（EF BB BF 头三字节不得出现）', () => {
  const bom = BUF.length >= 3 && BUF[0] === 0xef && BUF[1] === 0xbb && BUF[2] === 0xbf;
  assert.ok(!bom, '带 BOM 的 UTF-8 在 PS 5.1 同样有解析异常史，且说明生成链失控；本资产铁律=ASCII 无 BOM');
});

/* ============================ ② CRLF 面 ============================ */

test('winvm-prepare.ps1：CRLF 行尾（孤立 LF = 0）', () => {
  assert.ok(SRC.includes('\r\n'), '必须含 CRLF');
  let loneLF = 0;
  for (let i = 0; i < SRC.length; i += 1) {
    if (SRC[i] === '\n' && SRC[i - 1] !== '\r') loneLF += 1;
  }
  assert.equal(loneLF, 0, `发现 ${loneLF} 个孤立 LF（必须全 CRLF）`);
});

/* ============================ ③ param 头 + 锚点 ============================ */

test('winvm-prepare.ps1：param 头形态（[string]$PubKey + [int]$SshPort）', () => {
  assert.match(SRC, /\[\s*string\s*\]\s*\$PubKey\s*=/, 'param 头须含 [string]$PubKey=');
  assert.match(SRC, /\[\s*int\s*\]\s*\$SshPort\s*=/, 'param 头须含 [int]$SshPort=');
});

test('winvm-prepare.ps1：关键动作锚点齐备（sshd/防火墙/公钥 ACL/完成哨兵）', () => {
  for (const anchor of [
    'Add-WindowsCapability',
    'OpenSSH.Server~~~~0.0.1.0',
    'New-NetFirewallRule',
    'administrators_authorized_keys',
    'icacls',
    '/inheritance:r',
    'PREPARE_DONE=True',
  ]) {
    assert.ok(SRC.includes(anchor), `缺锚点：${anchor}`);
  }
});

test('winvm-prepare.ps1：KV 输出契约八键齐（§4.2 铠大师解析面，改名=双端静默分叉）', () => {
  for (const kv of [
    'SSHD_STATE=',
    'SSHD_STARTMODE=',
    'FW_SSH=',
    'NODE=',
    'PUBKEY_USER_AK=',
    'PUBKEY_ADMIN_AK=',
    'PREPARE_DONE=',
    'ADMIN=',
  ]) {
    assert.ok(SRC.includes(kv), `KV 契约缺键：${kv}`);
  }
  // FW_SSH 两态出口（True=成规 / False=非管理员 fail-loud），铠大师才能出 ❌+修复建议
  assert.ok(SRC.includes("FW_SSH=True") && SRC.includes('FW_SSH=False'), 'FW_SSH 须有 True/False 两态出口');
});

test('winvm-prepare.ps1：Q-3 契约=无 PubKey 时 PUBKEY 两键显式输出 SKIPPED（键恒在，解析器不猜缺省）', () => {
  // 字面行（单引号 Write-Output）必须存在——不是"不输出"
  assert.ok(SRC.includes("Write-Output 'PUBKEY_USER_AK=SKIPPED'"), 'Q-3：PUBKEY_USER_AK=SKIPPED 显式行缺失');
  assert.ok(SRC.includes("Write-Output 'PUBKEY_ADMIN_AK=SKIPPED'"), 'Q-3：PUBKEY_ADMIN_AK=SKIPPED 显式行缺失');
  // SKIPPED 分支必须在 else 臂（$PubKey -eq '' 路径），而非仅注入失败臂
  const elseBlock = SRC.match(/else \{\s*(?:#[^\r\n]*\s*)*Write-Output 'PUBKEY_USER_AK=SKIPPED'/);
  assert.ok(elseBlock, 'Q-3：SKIPPED 输出须位于 -PubKey 为空的 else 臂');
});

test('winvm-prepare.ps1：G1 双文件注入 + 幂等 [SKIP] 形态 + node 安装走 winget --id（与 prepare-vm.mjs DB-3 同口径）', () => {
  // G1：per-user authorized_keys 对 Administrators 组被忽略 ⇒ 必须双写
  assert.ok(SRC.includes('authorized_keys'), 'per-user authorized_keys 注入缺失');
  assert.ok(SRC.includes('administrators_authorized_keys'), 'G1：administrators_authorized_keys 注入缺失');
  assert.ok(/icacls[\s\S]*\$akAdmin[\s\S]*\/inheritance:r[\s\S]*\/grant/.test(SRC), 'icacls 收紧 ACL（/inheritance:r + /grant）缺失');
  // 幂等：每项先探测再动作，[SKIP] 出口在位
  assert.ok(SRC.includes('[SKIP]'), '幂等 [SKIP] 出口缺失');
  assert.ok(SRC.includes('Get-Service sshd'), 'sshd 探测先行');
  assert.ok(SRC.includes('Get-NetFirewallRule -DisplayName'), '防火墙先判存在');
  assert.ok(SRC.includes('Get-Command node'), 'node 探测先行');
  // node 静默装：命令面 winget install --id（提示文本可含 winget 字样，故钉命令面）
  assert.ok(SRC.includes('winget install --id OpenJS.NodeJS.LTS'), 'node 缺失时 winget 静默装命令面');
});

/* ============================ ④ 中文显式钉 ============================ */

test('winvm-prepare.ps1：不含任何中文字符（CJK 统一表意文字面）', () => {
  // ①在字节面已隐含通过，本条把「中文回潮」单独判红点名，报错可读性=回归定位效率
  const cjk = SRC.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff5e]/g);
  assert.equal(cjk, null, `发现中文/全角字符（${cjk ? cjk.slice(0, 8).join('') : ''}）——本资产 ASCII-only 铁律`);
});
