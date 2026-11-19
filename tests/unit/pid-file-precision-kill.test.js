/**
 * pid 文件方案（B）· 精确查杀 —— 三端契约门禁
 *
 * 用户裁定（2026-11-19）：「启动或是拉起进程时，目录里维护 servicexx.pid，删除时可以
 * 直接删除相关进程，再清理部署目录了」⇒ 只实现 pid 方案 B，其余附带发现不改。
 *
 * 病灶（真机实证）：卸载/重启靠**全表扫进程 + 命令行签名匹配**猜要杀谁。
 *   ① 必须枚举全部进程（每次都要 Get-CimInstance 全表）；
 *   ② 会误杀（签名 `ps-bridge` 命中任何同命令行脚本；P16 就是签名命中了脚本自己）；
 *   ③ 抓不到僵尸（命令行已被抹掉，只剩 WorkingSetSize 启发式）；
 *   ④ 更糟的是**删除静默失败**：进程把 C:\WinVMBridge 当 cwd 时 `Remove-Item -Recurse
 *      -Force` 什么都不报、留一个空骨架，而 `$ErrorActionPreference='Continue'` 把错误吞掉
 *      —— 日志显示该步「跑过了」，目录还在，下一次部署继承这堆残骸。
 *
 * 方案：启动时把**真相 PID**（来自 spawn 句柄，不是猜）落进部署目录的 `run/*.pid`，
 * 卸载/重启按 pid 直杀；签名清扫保留为兜底（覆盖从未落盘的进程）。
 *
 * 本文件锁四件事（全部是「可证伪」的具体形态，不是"看起来对"）：
 *   1) 写入端：ps1 生成的落 pid 段锚定在 Start-Process 之后（之前拿不到 PID），且写失败
 *      被 try/catch 包住（pid 是旁路取证，绝不能反过来打挂服务启动）；
 *   2) 路径契约：`run` 目录由 cfg 推导 —— VM 生产为 `C:\WinVMBridge\repo\run`，
 *      与卸载端 `$BridgeDir\repo\run` **同址**，两侧不会各写各的；
 *   3) 消费端：卸载与 VM-START 都必须有 pid 优先、签名兜底的**双路**，且顺序是 pid 在前；
 *   4) pid 复用防护：名字 + StartTime 双重校验，任一不符即**不动手**（这是最容易漏、
 *      也最危险的一条：Windows 会回收 pid，无校验的按 pid 杀可能杀掉无关新进程）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const { buildTaskXml } = await import('file:///' + join(ROOT, 'delivery/install-vm.mjs').replace(/\\/g, '/'));
const { buildVmPs1 } = await import('file:///' + join(ROOT, 'delivery/uninstall.mjs').replace(/\\/g, '/'));
const { buildVmStartPs1 } = await import('file:///' + join(ROOT, 'delivery/setup.mjs').replace(/\\/g, '/'));

/** 与生产完全一致的输入（VM 上的真实形态），单测里也只认这一份契约 */
const VM_CFG = 'C:\\WinVMBridge\\repo\\delivery\\.generated\\vm-service.runtime.json';
const VM_CLI = 'C:\\WinVMBridge\\repo\\packages\\vm-service\\dist\\cli.js';

function generatePs1(cfg = VM_CFG) {
  const dir = mkdtempSync(join(tmpdir(), 'pidfile-'));
  buildTaskXml('WinVMBridge.Service', 'C:\\nvm4w\\nodejs\\node.exe', VM_CLI, 18443, cfg, dir);
  return readFileSync(join(dir, 'start-hidden.ps1'), 'utf8');
}

/** 取 ps1 里首次出现某锚点的行号（-1 = 不存在） */
const lineOf = (text, needle) => text.split('\r\n').findIndex((l) => l.includes(needle));

describe('pid 方案 B · 1) 写入端（start-hidden.ps1）', () => {
  const ps1 = generatePs1();
  const lines = ps1.split('\r\n');

  test('落 pid 段锚定在 Start-Process -PassThru 之后（之前拿不到 PID）', () => {
    const iSpawn = lineOf(ps1, '$nodeProc = Start-Process');
    const iWrite = lineOf(ps1, 'service.pid');
    assert.ok(iSpawn > 0, '缺少 Start-Process 拉起行');
    assert.ok(iWrite > iSpawn, '按 PID 落盘必须发生在拿到进程句柄之后');
  });

  test('写入内容含 StartTime（pid 复用的唯一可靠判据，没有它下游无法安全校验）', () => {
    const stLine = lines.find((l) => l.includes('StartTime'));
    assert.ok(stLine, '缺少 StartTime 采集行 ⇒ 下游只能用 pid 单条件，无法防 pid 复用');
    assert.match(stLine, /ToUniversalTime/, 'StartTime 须转 UTC（本地时区会让跨时区/夏令时比对失真）');
    assert.match(stLine, /ToString\("o"\)/, '须用 ISO-8601 往返格式（下游 RoundtripKind 解析依赖它）');
  });

  test('写入被 try/catch 包住：写失败不得阻断服务启动（pid 是旁路，不是可用性一部分）', () => {
    const iTry = lines.findIndex((l, i) => l === 'try {' && lines[i + 1]?.includes('$runDir'));
    assert.ok(iTry > 0, '缺少包裹写 pid 的 try {');
    const tail = lines.slice(iTry, iTry + 8);
    assert.ok(
      tail.some((l) => /^\} catch \{ \}$/.test(l)),
      'try 之后必须有吞掉异常的 catch —— 否则目录只读/ACL 问题会让服务起不来',
    );
  });

  test('落盘目录带 -Force 建目录（首次部署 run 目录不存在）', () => {
    const mk = lines.find((l) => l.includes('New-Item') && l.includes('Directory'));
    assert.ok(mk, '缺少建目录动作');
    assert.match(mk, /-Force/, '建目录须 -Force（幂等重跑）');
  });
});

describe('pid 方案 B · 2) 路径契约：两侧必须同址', () => {
  test('VM 生产 cfg ⇒ run 目录 = C:\\WinVMBridge\\repo\\run', () => {
    const ps1 = generatePs1();
    assert.ok(
      ps1.includes("$runDir = 'C:\\WinVMBridge\\repo\\run'"),
      `run 目录推导与预期不符，实际：${ps1.split('\r\n').find((l) => l.startsWith('$runDir'))}`,
    );
  });

  test('与卸载端 $BridgeDir\\repo\\run 同址（否则写了没人读 = 功能等于没做）', () => {
    const un = buildVmPs1({ purgeWorkspace: false });
    assert.ok(un.includes('Join-Path $BridgeDir "repo\\run"'), '卸载端必须查 $BridgeDir\\repo\\run');
    assert.ok(generatePs1().includes("'C:\\WinVMBridge\\repo\\run'"), '写入端必须落 C:\\WinVMBridge\\repo\\run');
  });

  test('宿主 env 传递：ps1 显式赋 WINVM_RUN_DIR（计划任务无 env 通道，这是唯一来源）', () => {
    const ps1 = generatePs1();
    assert.match(
      ps1,
      /\$env:WINVM_RUN_DIR = 'C:\\WinVMBridge\\repo\\run'/,
      'ps-bridge 子进程靠继承该 env 才知道往哪写 pid 文件',
    );
  });

  test('路径推导不依赖 posix dirname（反斜杠路径在非 Windows 宿主上会被当成单段文件名）', () => {
    const src = readFileSync(join(ROOT, 'delivery/install-vm.mjs'), 'utf8');
    const seg = src.slice(src.indexOf('const runDir ='), src.indexOf('const ps1 = ['));
    assert.ok(seg.length > 0, '未找到 runDir 推导段');
    assert.ok(
      !/dirname\(\s*dirname/.test(seg),
      '不得用 dirname 逐级上溯 —— posix dirname 不识别反斜杠，会把 C:\\a\\b\\x.json 算成相对路径',
    );
    assert.ok(seg.includes('sepOf'), '须按 cfg 实际分隔符自适应拼接');
  });
});

describe('pid 方案 B · 3) 消费端：pid 优先 + 签名兜底（两路都要）', () => {
  test('卸载端：service.pid 与 ps-bridge.pid 都被按 pid 精确查杀', () => {
    const un = buildVmPs1({ purgeWorkspace: false });
    assert.match(un, /Kill-PidFile 'service node \(pid file\)' 'service\.pid' 'node\.exe'/, '缺 service.pid 消费');
    assert.match(un, /Kill-PidFile 'ps-bridge \(pid file\)' 'ps-bridge\.pid' 'powershell\.exe'/, '缺 ps-bridge.pid 消费');
  });

  test('卸载端：段 0b 与段 2 兜底都重试 pid（被 RestartOnFailure 拉起的残留也要收）', () => {
    const un = buildVmPs1({ purgeWorkspace: false });
    const calls = un.split('\r\n').filter((l) => l.startsWith('Kill-PidFile '));
    assert.equal(calls.length, 4, `pid 查杀应 2 文件 × 2 段 = 4 次，实际 ${calls.length}`);
  });

  test('卸载端：pid 查杀先于签名清扫（快路在前，慢路兜底）', () => {
    const un = buildVmPs1({ purgeWorkspace: false });
    const un2 = un.split('\r\n');
    const iPid = un2.findIndex((l) => l.startsWith("Kill-PidFile 'service node"));
    const iSig = un2.findIndex((l) => l.startsWith("Kill-Sig 'vm-service node'"));
    assert.ok(iPid > 0 && iSig > 0, '两路都必须存在');
    assert.ok(iPid < iSig, 'pid 精确查杀须在签名全表扫描之前');
  });

  test('反向断言：签名清扫不得因引入 pid 而删除（未落盘的进程只能靠它兜底）', () => {
    const un = buildVmPs1({ purgeWorkspace: false });
    for (const sig of ['vm-service node', 'start-hidden wrapper', 'ps-bridge']) {
      assert.ok(un.includes(`Kill-Sig '${sig}'`), `签名兜底 ${sig} 被删 ⇒ 漏杀未记录 pid 的进程`);
    }
  });

  test('VM-START（重启路径）同样 pid 优先（不只卸载路径有）', () => {
    const vs = buildVmStartPs1({ servicePort: 18443 });
    assert.match(vs, /Kill-PidFile 'service node' 'service\.pid' 'node\.exe'/);
    assert.match(vs, /Kill-PidFile 'ps-bridge' 'ps-bridge\.pid' 'powershell\.exe'/);
    const vsLines = vs.split('\r\n');
    const iPid = vsLines.findIndex((l) => l.startsWith("Kill-PidFile 'service node'"));
    const iSweep = vsLines.findIndex((l) => l.includes('VM_START_SWEEP PID='));
    assert.ok(iPid < iSweep, 'VM-START 的 pid 查杀须在签名清扫之前');
  });

  test('VM-START 保留 P16 的自伤防护（新增 pid 段不得破坏 chain 排除）', () => {
    const vs = buildVmStartPs1({ servicePort: 18443 });
    assert.match(vs, /\$chain -notcontains \$_\u002eProcessId/, 'P16 祖先链排除被破坏 ⇒ 清扫会杀掉自己');
    assert.match(vs, /Invoke-CimMethod -InputObject \$_ -MethodName Terminate/, 'CMSL 无 .Terminate()');
  });
});

describe('pid 方案 B · 4) pid 复用防护（最危险的一条：无校验的按 pid 杀会误杀无关进程）', () => {
  for (const [name, gen] of [
    ['uninstall', () => buildVmPs1({ purgeWorkspace: false })],
    ['VM-START', () => buildVmStartPs1({ servicePort: 18443 })],
  ]) {
    test(`${name}：进程名不符 ⇒ 不动手（pid 已被别的程序复用）`, () => {
      const t = gen();
      assert.ok(
        t.includes('($p.ProcessName + ".exe") -ne $exeName'),
        `${name} 缺进程名校验 ⇒ pid 复用时会把无关进程杀掉`,
      );
    });

    test(`${name}：StartTime 偏差 > 2s ⇒ 不动手（同名程序但确属另一个实例）`, () => {
      const t = gen();
      assert.match(t, /-gt 2/, `${name} 缺 StartTime 容差判定`);
      assert.ok(t.includes('TotalSeconds'), `${name} 须按秒比对（毫秒级差异是往返精度噪音）`);
    });

    test(`${name}：pid 已不存在 ⇒ 视为陈旧文件正常跳过（不得报错中断卸载）`, () => {
      const t = gen();
      assert.ok(
        /Get-Process -Id \$procId -ErrorAction SilentlyContinue/.test(t),
        `${name} 须容错读取（进程已退出是常态，不是异常）`,
      );
    });
  }
});

describe('pid 方案 B · 5) 删除失败不再静默（原 25s 步骤的真问题）', () => {
  const un = buildVmPs1({ purgeWorkspace: false });

  test('Remove-Item 带 -ErrorAction Stop 进 try/catch（旧代码裸调用，错误被 Continue 吞掉）', () => {
    assert.match(un, /Remove-Item \$BridgeDir -Recurse -Force -ErrorAction Stop/, '须显性化删除错误');
    assert.match(un, /catch \{ Write-Output \("\[WARN\] Remove-Item raised: "/, '须把异常写进日志');
  });

  test('删除后**复验目录是否真消失**，残留则 [FAIL] + 列出持有进程（可证伪，不靠假定）', () => {
    const lines = un.split('\r\n');
    const iRm = lines.findIndex((l) => l.includes('Remove-Item $BridgeDir -Recurse -Force'));
    const tail = lines.slice(iRm, iRm + 12).join('\n');
    assert.match(tail, /if \(Test-Path \$BridgeDir\)/, '删除后必须复验（否则「跑过了但目录还在」无从发现）');
    assert.match(tail, /\[FAIL\]/, '残留须打 FAIL 哨兵（静默成功是本缺陷的原始形态）');
    assert.match(tail, /BRIDGE_HOLDER PID=/, '残留须列出 cwd/句柄持有者，供排错定位');
    assert.match(tail, /BRIDGE_RESIDUE_ITEMS=/, '须报残留条目数（区分空骨架 vs 基本没删）');
  });

  test('正常删除也要有 [OK] 正向证据（只有 FAIL 分支的话无法区分"没跑"和"跑成了"）', () => {
    assert.ok(
      un.includes('[OK]  C:\\WinVMBridge removed'),
      '缺删除成功的正向哨兵（注意实现里是 [OK] 后两个空格，别按常规单空格去匹配）',
    );
  });

  test('VM 侧载荷仍 ASCII-only（PS 5.1 无 BOM UTF-8 会乱码——本项目既有坑，新增段不得引入中文）', () => {
    assert.ok(!/[^\x00-\x7F]/.test(un), 'buildVmPs1 生成物含非 ASCII 字符');
    assert.ok(!/[^\x00-\x7F]/.test(buildVmStartPs1({ servicePort: 18443 })), 'buildVmStartPs1 生成物含非 ASCII 字符');
  });
});

describe('pid 方案 B · 6) PsBridge 侧写入/清理（vm-capabilities）', () => {
  const src = readFileSync(join(ROOT, 'packages/vm-capabilities/src/ps-bridge.ts'), 'utf8');

  test('pid 来自 spawn 句柄（真相），不是扫描猜出来的', () => {
    assert.match(src, /const pid = this\.child\?\.pid/, '须直接取子进程句柄的 pid');
  });

  test('缺省不写文件（没 env 也没显式参数时零副作用：单测/非 Windows 宿主不受影响）', () => {
    assert.match(src, /if \(!target\) return;/, 'pidFile 缺失时必须直接返回，不得落到默认路径');
    assert.match(src, /WINVM_RUN_DIR/, '须从 env 读取部署目录');
  });

  test('写失败静默放过（旁路取证不得打挂桥）', () => {
    const seg = src.slice(src.indexOf('private writePidFile'), src.indexOf('private removePidFile'));
    assert.ok(/catch \{/.test(seg), 'writePidFile 必须有 catch');
    assert.ok(!/throw /.test(seg), 'writePidFile 不得抛错');
  });

  test('删除带归属校验（自愈后旧进程 exit 晚到，不得删掉新进程刚写的记录）', () => {
    const seg = src.slice(src.indexOf('private removePidFile'), src.indexOf('export function resolvePidFileFromEnv'));
    assert.match(seg, /cur === String\(ownerPid\)/, '须比对文件内 pid === 退出进程 pid 才删');
  });

  test('写入用临时文件 + rename（原子替换，避免下游读到半截 pid 文件）', () => {
    const seg = src.slice(src.indexOf('private writePidFile'), src.indexOf('private removePidFile'));
    assert.match(seg, /renameSync\(tmp, target\)/, '须原子替换');
  });
});