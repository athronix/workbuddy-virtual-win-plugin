/**
 * 迭代19 · deploy-reports 实跑复盘三修复的防回归锁（X-5/X-6/X-7）
 *   X-5 prepare-vm buildPrepareVmApplyPs1 DB-3 三元数组必须扁平化（嵌套数组 join ⇒ 逗号串接 ⇒ .ps1 语法错）
 *   X-6 injectCredentialEnv：.env 凭据回注 process.env（白名单 + env 显式值优先）
 *   X-7 decideBuildFallback：缺 tsc+预构建 dist ⇒ skip-degraded（发布包形态 BUILD 不再假败整链）
 * 运行：node --test tests/unit/p7-x567-deploy-reports-fixes.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const { buildPrepareVmApplyPs1 } = await import(join(ROOT, 'delivery', 'prepare-vm.mjs'));
const { injectCredentialEnv, decideBuildFallback, CREDENTIAL_ENV_KEYS } = await import(join(ROOT, 'delivery', 'setup.mjs'));

/* ---------------- X-5 ---------------- */

test('X-5 锁：apply 载荷两态（ensureNode true/false）零嵌套数组串接痕迹', () => {
  for (const ensureNode of [true, false]) {
    const ps = buildPrepareVmApplyPs1({ servicePort: 18443, vmDeployDir: 'C:/WinVMBridge', sshPort: 22, ensureNode });
    const lines = ps.split('\r\n');
    // ① 绝无 [object 序列化痕迹；② 绝无「行尾裸逗号+下一行被并入」的 ,,{2,} 或 `... ,  $` 串接形态
    assert.ok(!ps.includes('[object'), `ensureNode=${ensureNode} 出现 [object（嵌套数组未展开）`);
    for (const l of lines) {
      assert.ok(!/,,/.test(l), `ensureNode=${ensureNode} 双逗号串接行: ${l.slice(0, 80)}`);
      // 三元数组若未展开，join('\r\n') 前 toString 会以逗号连接全部行 ⇒ 整段挤在一行且含「,  」
      assert.ok(!/PREPARE_VM_DONE/.test(l) || l.trim() === 'Write-Output "PREPARE_VM_DONE"', '收尾哨兵须独立成行');
    }
    // 两态结构差：true 含 DB-3 装配主体、false 只含 not requested 提示
    assert.equal(ps.includes('winget install --id OpenJS.NodeJS.LTS'), ensureNode);
    assert.ok(ps.includes('PREPARE_VM_DONE'));
    assert.ok(!/[^\x00-\x7F]/.test(ps), 'ASCII-only 铁律');
  }
});

test('X-5 加钉（run18 P-2）：DB-3 段行级独立 + run18 实锤错形态签名零出现 + 源文件展开式在场', async () => {
  const { readFileSync } = await import('node:fs');
  const ps = buildPrepareVmApplyPs1({ servicePort: 18443, vmDeployDir: 'C:/WinVMBridge', sshPort: 22, ensureNode: true });
  // ① run18 报错签名：`SilentlyContinue) {,`（数组未展开→join 逗号把下一条语句并入块首）
  assert.ok(!/\)\s*\{\s*,/.test(ps), 'run18 签名 `) {,` 再现=三元数组又忘展开');
  // ② DB-3 每条语句必须独立成行（行首允许两空格缩进；串接形态=一行内出现多条 Write-Output）
  const db3Lines = ps.split('\r\n').filter((l) => l.includes('[DB-3]'));
  assert.ok(db3Lines.length >= 6, `DB-3 应生成多条独立行，实际 ${db3Lines.length}`);
  for (const l of db3Lines) {
    const n = (l.match(/Write-Output/g) || []).length;
    assert.ok(n <= 1, `DB-3 单行 Write-Output 应 ≤1（串接嫌疑）: ${l.slice(0, 80)}`);
  }
  // ③ 源级钉：delivery/prepare-vm.mjs 中 ensureNode 三元必须以 ...(...) 展开式在场
  //    （run18 根因=包内 V1.4.19 陈旧副本无此修复；本钉防 HEAD 侧回潮）
  const src = readFileSync(join(ROOT, 'delivery', 'prepare-vm.mjs'), 'utf8');
  assert.match(src, /\.\.\.\(\s*ensureNode/, 'ensureNode 三元必须 ... 展开（裸置=join 逗号串接，X-5 根坑）');
});

/* ---------------- X-6 ---------------- */

test('X-6 锁：仅白名单凭据键回注，process.env 显式值优先不被覆盖', () => {
  const t1 = {};
  const w1 = injectCredentialEnv({ WINVM_VM_PASSWORD: 'secret', NODE: 'do-not-pollute', PATH: '/x' }, t1);
  assert.deepEqual(w1, ['WINVM_VM_PASSWORD']);
  assert.equal(t1.WINVM_VM_PASSWORD, 'secret');
  assert.ok(!('NODE' in t1) && !('PATH' in t1), '白名单外键零污染');

  const t2 = { WINVM_VM_PASSWORD: 'env-wins' };
  const w2 = injectCredentialEnv({ WINVM_VM_PASSWORD: 'from-file' }, t2);
  assert.deepEqual(w2, [], '显式 env 值在场时不写、不报');
  assert.equal(t2.WINVM_VM_PASSWORD, 'env-wins');

  const t3 = {};
  assert.deepEqual(injectCredentialEnv({ WINVM_VM_PASSWORD: '' }, t3), [], '空值视同缺席');
  assert.ok(CREDENTIAL_ENV_KEYS.includes('WINVM_VM_PASSWORD') && CREDENTIAL_ENV_KEYS.includes('WINVM_VM_KEY'));
});

/* ---------------- X-7 ---------------- */

test('X-7 锁：BUILD 降级判定三态（缺 tsc+有 dist=skip；其余=build）', () => {
  assert.equal(decideBuildFallback({ tscAvailable: true, distPrebuilt: true }), 'build');
  assert.equal(decideBuildFallback({ tscAvailable: true, distPrebuilt: false }), 'build');
  assert.equal(decideBuildFallback({ tscAvailable: false, distPrebuilt: true }), 'skip-degraded');
  // 缺 tsc 且 dist 不在 ⇒ 仍走 build 让真失败显形（不许静默跳过无产物的部署）
  assert.equal(decideBuildFallback({ tscAvailable: false, distPrebuilt: false }), 'build');
});
