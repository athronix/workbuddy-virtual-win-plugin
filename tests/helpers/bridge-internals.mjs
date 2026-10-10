/**
 * 桥内部导出的统一取用入口（**P2-T10 · O-3 测试范式纪律的机器可读表达**）。
 *
 * ## 为什么存在
 *
 * `packages/adapter-agent-workbuddy-llm/src/bridge.ts` 里有一批**包内**机器
 * （`launchCliProcess`、`isFatalRuntimeStderr`、`renderCliArgs`、`reconcileApprovalWait` …）：
 * 它们在 `bridge.ts` 上 `export`（供包内其它模块与单测取用），但**不**出现在
 * `src/index.ts` 的公共 re-export 里 —— 因为「透出公共面」是**契约动作**
 * （透出即承诺长期兼容，未来删除即破坏性变更），不该为了测试方便而做。
 *
 * Phase 1 T5 曾踩坑：测试直接 `import { launchCliProcess } from '@winvm/adapter-agent-workbuddy-llm'`
 * ⇒ 该名字不在公共面 ⇒ 整文件 `SyntaxError`（CL-022 缺陷记录第 5 条）。当时的处置是
 * 「测试直连 `dist/bridge.js`」并登记为观察项 O-3：**债不是访问不到，而是范式没写下来**，
 * 于是每个新工程师都会先撞一次。本 helper 就是把它写下来的那一步。
 *
 * ## 使用约定（五条，缺一即范式失效）
 *
 * 1. **前置构建**：本 helper import 的是 `dist/` 构建产物，跑任何读 dist 的用例前
 *    必须先 `./node_modules/.bin/tsc -b tsconfig.build.json`（项目验证顺序「先 build 后 test」，
 *    与 `cl020-f2-*` / `phase1-t5-*` 同纪律）。dist 未生成时本 helper 抛**可执行的**
 *    错误文案（不是裸 `ERR_MODULE_NOT_FOUND`），告诉调用方该跑哪条命令。
 * 2. **只读内部面**：测试用它取函数做**直接单测**，不得借它去断言「公共面应当包含 X」
 *    —— 那是扩面诉求，须走契约评审（设计 §7 Q5）。
 * 3. **不得绕过包内边界做副作用**：只用纯函数（判定/渲染类）；带进程或文件系统副作用的
 *    内部函数（`launchCliProcess`）必须由调用用例自己注入假时钟/假 spawn 后才可用。
 * 4. **禁止再手写路径**：新用例一律 `import { loadBridgeInternals } from '../helpers/bridge-internals.mjs'`，
 *    不要各文件重复 `import('.../dist/bridge.js')`（重复即漂移：路径改动要改 N 处）。
 * 5. **「加 `export` 标记」≠「扩公共面」**：判据是**进不进 `src/index.ts` 的 re-export**。
 *    本 helper 取用的名字（含 P2-T10 为单测加了 `export` 的 `reconcileApprovalWait`）都**不**进
 *    公共 re-export ⇒ 对外契约面零变化，仍是包内机器（同 `launchCliProcess` 先例）。
 *    该类函数若另有「函数体与文案一字不改」约束（SK-9），其对象是**判定逻辑与回包文案**，
 *    不禁止声明行加标记。
 *
 * ## 导出形态
 *
 * 用**动态 import** 而非静态 re-export，有两个实际收益：
 *   · dist 缺失时能给出可读错误 + 修复命令（静态 import 只给裸 SyntaxError）；
 *   · 单个测试文件里可以 `await loadBridgeInternals()` 后再取用，与
 *     `node:test` 的 async 用例天然契合。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** 仓库根（本文件位于 `<root>/tests/helpers/`，上溯两级） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 桥的构建产物绝对路径（dist 由 `tsc -b tsconfig.build.json` 生成） */
export const BRIDGE_DIST_PATH = join(REPO_ROOT, 'packages', 'adapter-agent-workbuddy-llm', 'dist', 'bridge.js');

/**
 * 载入 `bridge.js` 的包内导出。
 *
 * @returns `dist/bridge.js` 的模块命名空间对象（含 `reconcileApprovalWait`、
 *          `launchCliProcess`、`isFatalRuntimeStderr`、`renderCliArgs` 等）
 * @throws 若构建产物不存在 —— 错误文案直接给出应当执行的构建命令
 */
export async function loadBridgeInternals() {
  if (!existsSync(BRIDGE_DIST_PATH)) {
    throw new Error(
      '测试范式：桥内部导出取自构建产物 dist/bridge.js，而该文件不存在。' +
        `请先执行：cd ${REPO_ROOT} && ./node_modules/.bin/tsc -b tsconfig.build.json` +
        `（期望产物 ${BRIDGE_DIST_PATH}）`,
    );
  }
  return import(pathToFileURL(BRIDGE_DIST_PATH).href);
}

/**
 * 载入确定性 provider 的构建产物（`adapter-agent-workbuddy/dist/index.js`）。
 *
 * 该包的**公共面本身**够用（`createProvider` 是导出 API），这里只是把「直连 dist」
 * 这一范式收进同一个 helper，避免新用例去 import 包名后又依赖 workspace 链接生效。
 *
 * @returns provider 模块命名空间（含 `createProvider`、`PROVIDER_ID`）
 */
export async function loadDeterministicProvider() {
  const p = join(REPO_ROOT, 'packages', 'adapter-agent-workbuddy', 'dist', 'index.js');
  if (!existsSync(p)) {
    throw new Error(
      `确定性 provider 构建产物不存在：${p}。` +
        `请先执行：cd ${REPO_ROOT} && ./node_modules/.bin/tsc -b tsconfig.build.json`,
    );
  }
  return import(pathToFileURL(p).href);
}

/** 供用例做源码文本守卫时定位包根（避免各文件手写相对路径拼法） */
export const repoRoot = REPO_ROOT;

/** 便捷：把仓库相对路径拼成绝对路径 */
export function repoPath(...segments) {
  return join(REPO_ROOT, ...segments);
}
