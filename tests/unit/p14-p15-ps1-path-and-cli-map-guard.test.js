/**
 * P14 / P15 静态守卫 —— 「从零部署」真机暴露的两个判据面缺陷（2026-11-19）
 *
 * 两件都是**只有当测试机真的没有 node/CLI、且链路真的抖过才会现形**的类型，
 * 因此必需机检面钉住，否则一旦回退，症状会伪装成完全无关的东西。
 *
 * ── P14：`-File` 的裸文件名依赖「scp 落盘目录 == ssh 登录 cwd」这条假前提
 *   现象（12:04 轮）：日志已打印「(.ps1 已推送 winvm-setup-1795061108104.ps1 → VM)」，
 *   紧接着 `powershell -File <裸名>` 抛
 *   「-File 方式参数实际参数 winvm-setup-….ps1 不存在」（rc=4294770688）；
 *   而 11:53 轮**同样代码、同样文件名**成功。
 *   根因：runRemotePs1 把 put 与 exec 拆成两次独立的 withVmChannel 调用，各自独立
 *   决议后端（ssh2 sftp / 二进制 scp），裸相对名在两边解析到不同 cwd ⇒ 时好时坏。
 *   本文件的判据不是「去猜哪个后端对」，而是**路径不许依赖 cwd**：
 *   推送/执行/清理三处必须用同一个绝对路径。
 *
 * ── P15：bootstrap 的 state 组装漏映射 cliDesktop / cliBrowser
 *   现象（12:04 轮，三 CLI 早已装好）：日志 `codebuddy:OK desktop:MISSING browser:MISSING`，
 *   而同一时刻 4c 读到 `browser=33 desktop=25`。
 *   根因：探测脚本采集的是 `$o.browserCli` / `$o.desktopCli`（browserCli 在前），
 *   但 state 从未把这两个键映射进去 ⇒ 日志与 planPrepareVm 的 DB-7 判据恒读到 undefined。
 *   受害面 = **判据面**（日志假红 + 计划表恒给出 `npm i -g`，永远到不了 `[SKIP] all present`）；
 *   执行面本来是对的（DB-7 的 .ps1 内部自己 Get-Command 幂等重探）。
 *   注意键名的**交叉错配**陷阱：探测端叫 browserCli/desktopCli，消费端叫
 *   cliBrowser/cliDesktop —— 映射必须交叉对位，写反了同样是假红，只是方向相反。
 *
 * 纪律：纯 node stdlib；只读源文件；不写盘；不起 VM。
 * 运行：node --test tests/unit/p14-p15-ps1-path-and-cli-map-guard.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planPrepareVm } from '../../delivery/prepare-vm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 掐出 runRemotePs1 的函数体（静态判据只该看这一段，避免误伤别处的同名标识符） */
function runRemotePs1Body() {
  const s = src('delivery/setup.mjs');
  const start = s.indexOf('export async function runRemotePs1');
  assert.ok(start > 0, 'setup.mjs 里找不到 runRemotePs1 定义');
  const end = s.indexOf('/**\n * VM-START 相位', start);
  assert.ok(end > start, '无法界定 runRemotePs1 的结束位置（文档块结构变了？请同步本守卫）');
  return s.slice(start, end);
}

describe('P14 · .ps1 推送/执行必须走同一个绝对路径（不依赖 cwd）', () => {
  const body = runRemotePs1Body();

  test('推送（二进制 scp 分支）用绝对路径', () => {
    assert.match(body, /`\$\{sshTarget\}:\$\{remoteNameAbs\}`/, '二进制 scp 仍用裸文件名 ⇒ 落盘目录不可控');
  });

  test('推送（ssh2 sftp put 分支）用绝对路径', () => {
    assert.match(body, /runner\.put\(localWritten, remoteNameAbs\)/, 'ssh2 put 仍用裸文件名 ⇒ 与 exec 的 cwd 可能不一致');
  });

  test('执行 `-File` 用绝对路径且加引号', () => {
    assert.match(body, /-File "\$\{remoteNameAbs\}"/, '-File 仍用裸文件名 ⇒ 复现 P14「实际参数不存在」');
  });

  test('清理用的也是同一个绝对路径（否则临时文件永久残留）', () => {
    assert.match(body, /Remove-Item -LiteralPath '\$\{remoteNameAbs\}'/, '清理路径与推送路径不一致 ⇒ 残留');
  });

  test('日志打印绝对路径（P14 排错时正是缺这个信息）', () => {
    assert.match(body, /已推送 \$\{remoteNameAbs\}/, '日志只打裸名，出事后无法判断落在哪');
  });

  test('反向断言：裸文件名不得再出现在 -File / put / scp 三处', () => {
    assert.doesNotMatch(body, /-File \$\{remoteName\}/, '-File 的裸名形态回潮');
    assert.doesNotMatch(body, /runner\.put\(localWritten, remoteName\)/, 'put 的裸名形态回潮');
    assert.doesNotMatch(body, /:\$\{remoteName\}`/, 'scp 的裸名形态回潮');
  });

  test('绝对路径的基准目录有兜底默认值（VM_DEPLOY_DIR 缺失也不许退化成 cwd）', () => {
    assert.match(body, /cfg\.vmDeployDir \|\| 'C:\/WinVMBridge'/, '没有默认值 ⇒ 未配 .env 时又回到相对路径');
  });
});

describe('P15 · state 必须映射 cliDesktop / cliBrowser（且交叉对位没错）', () => {
  const bs = src('delivery/bootstrap.mjs');

  test('探测端确实采集了 browserCli / desktopCli（判据来源存在）', () => {
    assert.match(bs, /'?\$o\.browserCli=\[bool\]\(Get-Command agent-browser/, '探测脚本不再采集 agent-browser');
    assert.match(bs, /'?\$o\.desktopCli=\[bool\]\(Get-Command agent-desktop/, '探测脚本不再采集 agent-desktop');
  });

  test('state 里有 cliDesktop / cliBrowser 两个键', () => {
    assert.match(bs, /cliDesktop:\s*usedCombined \? !!J\.desktopCli/, 'cliDesktop 未映射 ⇒ 日志恒 MISSING（P15 原样）');
    assert.match(bs, /cliBrowser:\s*usedCombined \? !!J\.browserCli/, 'cliBrowser 未映射 ⇒ 日志恒 MISSING（P15 原样）');
  });

  test('交叉对位没写反（desktopCli→cliDesktop / browserCli→cliBrowser）', () => {
    // 写反了同样假红，只是「该绿的变红、该红的变绿」，比漏映射更难发现
    assert.doesNotMatch(bs, /cliDesktop:\s*usedCombined \? !!J\.browserCli/, 'cliDesktop 接了 browser 的值（错位）');
    assert.doesNotMatch(bs, /cliBrowser:\s*usedCombined \? !!J\.desktopCli/, 'cliBrowser 接了 desktop 的值（错位）');
  });

  test('降级路径保持「宁可报缺失」而不是报 OK（假绿会让真缺时无人补）', () => {
    assert.match(bs, /cliDesktop:\s*usedCombined \? !!J\.desktopCli : \(J2 \? !!J2\.desktopCli : false\)/);
    assert.match(bs, /cliBrowser:\s*usedCombined \? !!J\.browserCli : \(J2 \? !!J2\.browserCli : false\)/);
  });
});

describe('P15 · 行为级：DB-7 的幂等判据必须收敛到 [SKIP] all present', () => {
  const cfg = { servicePort: 18443, sshPort: 22, ensureNode: true, ensureDeps: true };
  const base = {
    admin: true,
    sshd: { installed: true, state: 'Running', startMode: 'Auto' },
    firewall: { ssh: true, service: true, sshPresent: true, servicePresent: true },
    node: { present: true, version: '24.21.0' },
    agentCli: true,
    cliDesktop: true,
    cliBrowser: true,
    agentConfigDir: true,
  };
  const db7 = (probe) => planPrepareVm(cfg, probe).find((p) => p.db === 'DB-7').action;

  test('三 CLI 全在 ⇒ [SKIP] all present（这是 4a 能收敛的唯一形态）', () => {
    assert.equal(db7(base), '[SKIP] all present');
  });

  test('键缺失（P15 的 bug 形态）⇒ 误报 npm i -g（证明本判据可证伪）', () => {
    const buggy = { ...base };
    delete buggy.cliDesktop;
    delete buggy.cliBrowser;
    assert.ok(db7(buggy).startsWith('npm i -g'), '键缺失却仍报 [SKIP] ⇒ 本测试失去证伪能力，需重写');
  });

  test('单只缺失只装那一只（不连带重装 codebuddy）', () => {
    assert.equal(db7({ ...base, cliBrowser: false }), 'npm i -g agent-browser');
    assert.equal(db7({ ...base, cliDesktop: false }), 'npm i -g agent-desktop');
  });

  test('三只全缺按依赖序 codebuddy → agent-desktop → agent-browser', () => {
    assert.equal(
      db7({ ...base, agentCli: false, cliDesktop: false, cliBrowser: false }),
      'npm i -g codebuddy + agent-desktop + agent-browser',
    );
  });

  test('--ensure-deps 未开时一律 [SKIP] not requested（与探测态无关）', () => {
    const off = { ...base };
    delete off.cliDesktop;
    delete off.cliBrowser;
    assert.equal(
      planPrepareVm({ ...cfg, ensureDeps: false }, off).find((p) => p.db === 'DB-7').action,
      '[SKIP] not requested (--ensure-deps)',
    );
  });
});