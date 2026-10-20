// 驱动 SDK 内置 ArkTS Linter（codelinter 核心引擎），按模块配置 Stage 模型
// 用法: node --jitless do_lint.cjs <ROOT> <module.json5|-> <outTag> <files...>
// 必须在 require ets-loader 之前设置 compileMode，避免模块级常量/缓存以默认值固化
if (process.argv[3] && process.argv[3] !== '-') process.env.compileMode = 'moduleJson';
const path = require('path');
const fs = require('fs');
const ELS = '/data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18/ohos/ets/build-tools/ets-loader';
const ts = require(ELS + '/node_modules/typescript');
const m = require(ELS + '/main.js');
const ec = require(ELS + '/lib/ets_checker.js');

const ROOT = process.argv[2];
const moduleJson = process.argv[3];
const outTag = process.argv[4];
const files = process.argv.slice(5);

m.partialUpdateConfig.executeArkTSLinter = true;
m.partialUpdateConfig.standardArkTSLinter = true;

const buildDir = path.resolve(ROOT, '.codeart-out/_lint-try/build');
const cacheDir = path.resolve(ROOT, '.codeart-out/_lint-try/cache');
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

const fileMap = {};
files.forEach((f, i) => { fileMap['file' + i] = path.resolve(ROOT, f); });

const diagLog = [];
const logger = {
  printError: (o) => { diagLog.push(o); },
  error: (x) => { diagLog.push({ level: 'error', m: String(x) }); },
  warn: (x) => { diagLog.push({ level: 'warn', m: String(x) }); },
  info: () => {}, debug: () => {},
};

const useModuleJson = moduleJson && moduleJson !== '-';
if (useModuleJson) process.env.compileMode = 'moduleJson';

const options = {
  projectPath: ROOT,
  buildPath: buildDir,
  cachePath: cacheDir,
  packageManagerType: 'npm',
  packageDir: 'node_modules',
  packageJson: 'package.json',
  compileMode: 'moduleJson',
  runtimeOS: 'HarmonyOS',
  bundleType: 'standard',
  compilerTypes: [],
  projectArkOption: { tscConfig: { targetESVersion: 'ES2021' } },
  tscConfig: { targetESVersion: 'ES2021' },
  allowEtsAnnotations: true,
  compatibleSdkVersion: 20,
  compatibleSdkVersionStage: 20,
  moduleRootPath: useModuleJson ? path.resolve(path.dirname(moduleJson), '../../..') : ROOT,
  aceModuleJsonPath: useModuleJson ? path.resolve(moduleJson) : undefined,
  etsLoaderPath: ELS,
  strictCheckerOnly: false,
  xtsMode: false,
};

console.log('DEBUG env.compileMode(before call)=', JSON.stringify(process.env.compileMode),
            '| aceModuleJsonPath=', options.aceModuleJsonPath,
            '| exists=', !!(options.aceModuleJsonPath && fs.existsSync(options.aceModuleJsonPath)));
try {
  ec.etsStandaloneChecker.call({}, fileMap, logger, options);
  console.log('DEBUG env.compileMode(after call)=', JSON.stringify(process.env.compileMode));
} catch (e) {
  console.log('== CAUGHT:');
  console.log(e && e.stack ? e.stack.split('\n').slice(0, 8).join('\n') : String(e));
}
console.log('== TAG:', outTag, '| files:', files.length, '| diag:', diagLog.length,
            '| isStandardMode(after):', ec.isStandardMode(), '| linterMode(after):', ec.getArkTSLinterMode());
const outFile = path.resolve(ROOT, '.codeart-out/_lint-try/diaglog-' + outTag + '.json');
fs.writeFileSync(outFile, JSON.stringify(diagLog, null, 2));
console.log('== wrote', outFile);