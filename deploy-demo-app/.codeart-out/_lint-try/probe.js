// 探测 SDK 内置 ArkTS Linter / TypeScript 的可编程入口
const ELS = '/data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18/ohos/ets/build-tools/ets-loader';

try {
  const ts = require(ELS + '/node_modules/typescript');
  console.log('=== typescript version ===', ts.version);
  console.log('=== ts ArkTS/Linter 相关导出 ===');
  console.log(Object.keys(ts).filter(k => /ArkTS|Linter|linter/i.test(k)));
} catch (e) {
  console.log('require typescript FAILED:', e.message);
}

try {
  const ec = require(ELS + '/lib/ets_checker.js');
  console.log('=== ets_checker lint/standalone 相关导出 ===');
  console.log(Object.keys(ec).filter(k => /lint|standalone|Linter|service|Checker/i.test(k)));
  for (const k of ['etsStandaloneChecker', 'runArkTSLinter', 'getArkTSLinterMode', 'createLanguageService',
                    'createWatchCompilerHost', 'compilerOptions', 'props', 'checkerResult', 'isStandardMode']) {
    const v = ec[k];
    console.log(' ', k, '=>', typeof v, (typeof v === 'function' ? ('arity=' + v.length) : ''));
  }
} catch (e) {
  console.log('require ets_checker FAILED:', e.message);
}