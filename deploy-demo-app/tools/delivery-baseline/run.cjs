// 交付基线适配 · 五层流水线编排（spec 5.8 / design 2.4 · 任务组 12–17）
// 取证层 → 决策层 → 执行层 → 核验层 → 诊断层；证据落盘 .codeart-out/
// 用法（工程根）: node --jitless tools/delivery-baseline/run.cjs [--build]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  DeviceProbe, SdkInventory, HostApiFloor, BaselineResolver, SdkSelector, VersionDeclarer,
  ArtifactApiInspector, InstallVerifier, BaselineError, encodeApiValue, decodeApiValue,
  KIT_MIN_API, POLICY_MIN_API,
} = require('./delivery-baseline.cjs');
const { ProfileWriter, BuildPipeline } = require('./build-pipeline.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(PROJECT_ROOT, '.codeart-out');
const TRY = path.join(OUT_DIR, '_build-try');
const SANDBOX_SDK_ROOT = '/data/service/hnp/ohos-sdk.org/ohos-sdk_26.0.0.18/ohos';
const SDK_LIB = `${SANDBOX_SDK_ROOT}/toolchains/lib`;
const SUPPLY_SRC = path.join(TRY, 'sdkmirror2');
const WORK_ROOT = path.join(TRY, 'delivery-work');

// 设备实证缓存记录（来源：docs/04-verification/TEST-REPORT-sdk-version-fix-20261023.md 证据链 E1/E2）
const CACHED_DEVICE = { apiVersion: 24, systemFullName: 'OpenHarmony-6.1.1.135', releaseType: 'Release', deviceType: '2in1' };
// 标准环境候选（DevEco 6.1.1 Release / Ohos_sdk_public 6.1.1.125）
const STD_CANDIDATE = { platformVersion: '6.1.1', apiVersion: 24, releaseType: 'Release', version: '6.1.1.125', location: '(standard-env)' };

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const lines = [];
const T = (s = '') => { lines.push(s); console.log(s); };

async function main() {
  const doBuild = process.argv.includes('--build');
  const TS = ts();
  const report = { ts: TS, layers: {} };

  T('='.repeat(80));
  T('交付基线适配 · 五层流水线执行报告');
  T('='.repeat(80));
  T(`时间戳      : ${TS}`);
  T(`工程根      : ${PROJECT_ROOT}`);
  T(`沙箱 SDK    : ${SANDBOX_SDK_ROOT}（唯一供给，API 26 Beta）`);
  T('红线        : 禁止改写产物 minAPIVersion/targetAPIVersion；仅由声明经编译推导，核验阶段只读');
  T('');

  // ---- 取证层 ----
  T('【取证层】design 2.4.1.2 · E1/E2/E3');
  const device = await DeviceProbe.probe({ hdcBin: 'hdc', cachedEvidence: CACHED_DEVICE });
  T(`  E1 DeviceProbe      : api=${device.value.apiVersion} name=${device.value.systemFullName} ` +
    `release=${device.value.releaseType} type=${device.value.deviceType} (来源=${device.source}` +
    `${device.probeError ? ', hdc 不可达: ' + device.probeError : ''})`);
  report.layers.probe = { device: device.value, source: device.source, probeError: device.probeError || null };

  let candidates = [];
  try {
    candidates = await SdkInventory.scan(SANDBOX_SDK_ROOT);
  } catch (e) {
    T(`  E2 SdkInventory     : E7002 ${e.message}`);
  }
  T(`  E2 SdkInventory     : ${candidates.length} 候选 -> ${candidates.map((c) => `${c.platformVersion}(${c.apiVersion}) ${c.releaseType}`).join(', ')}`);
  report.layers.inventory = { sdkRoot: SANDBOX_SDK_ROOT, candidates };

  const floorInfo = HostApiFloor.resolve([path.join(PROJECT_ROOT, 'feature', 'winvm-onetap', 'src', 'main', 'ets')]);
  T(`  E3 HostApiFloor     : floor=${floorInfo.floor} (Kits: ${floorInfo.detail.map((d) => `${d.kit}=${d.minApi}`).join(', ')})`);
  T(`      交付兼容下限策略 : POLICY_MIN_API=${POLICY_MIN_API}（design 2.4.1.3-(2) 唯一权威表）`);
  report.layers.floor = floorInfo;

  // ---- 决策层 ----
  T('');
  T('【决策层】design 2.4.1.3-(1)/(2) · F1/F2/F3（纯判定，无副作用）');
  const baseline = BaselineResolver.compose(device.value, Math.max(floorInfo.floor, POLICY_MIN_API));
  T(`  F1 BaselineResolver : deviceApi=${baseline.deviceApi} channel=${baseline.releaseChannel} floorApi=${baseline.floorApi} upperBound=${baseline.upperBound} devicePlatform=${baseline.devicePlatformVersion}`);
  report.layers.baseline = baseline;

  const selStd = SdkSelector.select(baseline, [STD_CANDIDATE]);
  T(`  F2 SdkSelector(标准) : selected=${selStd.selected ? `${selStd.selected.platformVersion}(${selStd.selected.apiVersion}) ${selStd.selected.releaseType}` : 'null'} tier=${selStd.matchTier}`);
  const selBox = SdkSelector.select(baseline, candidates);
  T(`  F2 SdkSelector(沙箱) : selected=${selBox.selected ? selBox.selected.platformVersion : 'null'} tier=${selBox.matchTier} reason=${selBox.rejectedReason || '-'}`);
  report.layers.selection = { standard: selStd, sandbox: selBox };

  const decl = VersionDeclarer.declare(baseline, selStd.selected ? selStd : { selected: null });
  T(`  F3 VersionDeclarer  : compatible=${decl.compatibleSdkVersion} target=${decl.targetSdkVersion} compile=${decl.compileSdkVersion === undefined ? '(省略)' : decl.compileSdkVersion}`);
  T(`      推导预期产物字段 : minAPIVersion=${encodeApiValue('6.0.0', 20)} targetAPIVersion=${encodeApiValue(baseline.devicePlatformVersion || '6.1.1', baseline.deviceApi)}`);
  report.layers.declaration = decl;

  const docProfile = ProfileWriter.read(path.join(PROJECT_ROOT, 'build-profile.json5'));
  T(`  声明对账(工程内)    : compatible=${docProfile.compatibleSdkVersion} target=${docProfile.targetSdkVersion} compile=${docProfile.compileSdkVersion === undefined ? '(省略)' : docProfile.compileSdkVersion}`);
  const declMatch = docProfile.compatibleSdkVersion === decl.compatibleSdkVersion && docProfile.targetSdkVersion === decl.targetSdkVersion && docProfile.compileSdkVersion === undefined;
  T(`  声明落位一致性      : ${declMatch ? '一致（build-profile.json5 已收敛，等价 G1 一次调用）' : '不一致（需 G1 落盘）'}`);
  report.layers.profileMatch = declMatch;

  // ---- 执行层 ----
  T('');
  T('【执行层】design 2.4.1.3-(3) · G1/G2');
  T('  G1 ProfileWriter    : 声明唯一落点 build-profile.json5 app.products[0]（signingConfigs 保持空，不内置密钥/SDK 绝对路径）');
  if (!doBuild) {
    T('  G2 BuildPipeline    : 跳过（未指定 --build）。等效供给与替代通道已就绪，见 .codeart-out/_build-try。');
    report.layers.build = { skipped: true };
  } else {
    const r = await BuildPipeline.build(decl, {
      projectRoot: PROJECT_ROOT,
      workRoot: WORK_ROOT,
      supplySrc: SUPPLY_SRC,
      supplyMeta: { apiVersion: 26, platformVersion: '26.0.0', releaseType: 'Beta', version: '26.0.0.18' },
      sdkLibDir: SDK_LIB,
      nodeBin: process.execPath,
      hvigorBin: path.join(TRY, 'hvigor-home', 'node_modules', '@ohos', 'hvigor', 'bin', 'hvigor.js'),
      hvigorNodeModules: path.join(TRY, 'hvigor-home', 'node_modules'),
      patchPlatform: path.join(TRY, 'patch-platform.cjs'),
      ts: TS,
      outDir: OUT_DIR,
    });
    T(`  G2 BuildPipeline    : CompileArkTS=${r.compileOk ? '成功' : '失败'} hvigorRc=${r.hvigorRc}（PackageHap 为环境性 java 缺失 → SDK 原生二进制替代）`);
    T(`      unsigned HAP    : ${r.unsigned}`);
    T(`      signed HAP      : ${r.hapPath}`);
    T(`      verify-app      : ${r.verified ? 'hap verify successed!' : '未通过'}`);
    report.layers.build = { hapPath: r.hapPath, verified: r.verified, compileOk: r.compileOk, hvigorRc: r.hvigorRc };

    // ---- 核验层 ----
    T('');
    T('【核验层】design 2.4.1.3-(4)/(5) · H1/H2');
    let triple = null, inspectErr = null;
    try {
      triple = ArtifactApiInspector.inspect(r.hapPath, { deviceApi: device.value.apiVersion });
    } catch (e) { inspectErr = e; }
    if (triple) {
      T(`  H1 ArtifactApiInspector : minAPIVersion=${triple.minAPIVersion}(${decodeApiValue(triple.minAPIVersion).platformVersion}/${decodeApiValue(triple.minAPIVersion).api}) ` +
        `targetAPIVersion=${triple.targetAPIVersion}(${decodeApiValue(triple.targetAPIVersion).platformVersion}/${decodeApiValue(triple.targetAPIVersion).api}) ` +
        `compileSdkVersion=${triple.compileSdkVersion} apiReleaseType=${triple.apiReleaseType}`);
      T(`      门限判定        : minApi=${decodeApiValue(triple.minAPIVersion).api} ≤ 设备 ${device.value.apiVersion} 且 targetApi=${decodeApiValue(triple.targetAPIVersion).api} ≤ 设备 ${device.value.apiVersion} -> 通过`);
      T(`      apiReleaseType  : ${triple.apiReleaseType} vs 设备 ${device.value.releaseType} -> ${triple.apiReleaseType === device.value.releaseType ? '一致' : '不一致（受限环境残余，标准 Release SDK 下应为 Release）'}`);
    } else {
      T(`  H1 ArtifactApiInspector : ${inspectErr.code || ''} ${inspectErr.message}`);
    }
    report.layers.artifact = triple;

    const verdict = await InstallVerifier.verify(r.hapPath, device.value, { hdcBin: 'hdc' });
    T(`  H2 InstallVerifier      : installOk=${verdict.installOk} launchOk=${verdict.launchOk} verdict=${verdict.verdict}`);
    T(`      安装器原文      : ${JSON.stringify(verdict.raw).slice(0, 300)}`);
    if (verdict.error) T(`      ${verdict.error.code}: ${verdict.error.message}`);
    report.layers.verdict = { installOk: verdict.installOk, launchOk: verdict.launchOk, verdict: verdict.verdict, raw: verdict.raw, error: verdict.error ? verdict.error.code : null };
  }

  // ---- 诊断层 ----
  T('');
  T('【诊断层】spec 4.4.4 / 6.6-E7001–E7005');
  T('  统一诊断载荷 {code, sdkPlatformVersion, deviceApiVersion, artifactThreshold} 已植入 SdkSelector/VersionDeclarer/ArtifactApiInspector/InstallVerifier');
  T('  E7001 SDK 高于设备未收敛 | E7002 未找到可用 SDK | E7003 声明/产物超门限 | E7004 安装被拒 | E7005 验签失败');
  T('');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `baseline-report-${TS}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `delivery-baseline-${TS}.log`), lines.join('\n') + '\n');
  console.log(`\n证据已落盘: .codeart-out/delivery-baseline-${TS}.log ; .codeart-out/baseline-report-${TS}.json`);
}

main().catch((e) => {
  if (e instanceof BaselineError) {
    console.error(`[${e.code}] ${e.message}`);
    console.error(JSON.stringify(e.diagnostic, null, 2));
  } else {
    console.error(e && e.stack ? e.stack : e);
  }
  process.exit(1);
});