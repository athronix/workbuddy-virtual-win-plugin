// 交付基线适配 · 执行层接口库（spec 5.8.4 / design 2.4.2 G 组）
// G1 ProfileWriter：声明落盘（build-profile.json5 的 app.products[0]，唯一落点）
// G2 BuildPipeline：匹配供给构建（CompileArkTS → pack → sign）；受限环境走等效供给 + SDK 原生二进制替代通道
// 红线（design 2.4.1.3-(3)）：本层不写入产物 module.json 的 minAPIVersion/targetAPIVersion；这两字段只由
// 编译链按版本声明推导，核验阶段仅读取。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { BaselineError, ERROR_CODES, diag } = require('./delivery-baseline.cjs');

function sh(cmd, opts = {}) {
  return cp.execSync(cmd, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }, opts)).toString();
}

// ---------------------------------------------------------------------------
// 组 G1 · ProfileWriter（声明落盘）
// ---------------------------------------------------------------------------
const ProfileWriter = {
  // 文本级落盘：保留工程内注释，仅收敛 app.products[0] 的版本三字段（唯一落点）
  apply: function (profilePath, decl) {
    let raw = fs.readFileSync(profilePath, 'utf8');
    const upsert = (text, key, value) => {
      const re = new RegExp(`("${key}"\\s*:\\s*)(?:"[^"]*"|[\\d]+)`);
      if (re.test(text)) return text.replace(re, `$1${JSON.stringify(value)}`);
      return text.replace(/("name"\s*:\s*"default"\s*,)/, `$1\n        "${key}": ${JSON.stringify(value)},`);
    };
    raw = upsert(raw, 'compatibleSdkVersion', decl.compatibleSdkVersion);
    raw = upsert(raw, 'targetSdkVersion', decl.targetSdkVersion);
    if (decl.compileSdkVersion === undefined || decl.compileSdkVersion === null) {
      raw = raw.replace(/^\s*"compileSdkVersion"\s*:\s*"[^"]*",?\s*$/m, '');
    } else {
      raw = upsert(raw, 'compileSdkVersion', decl.compileSdkVersion);
    }
    fs.writeFileSync(profilePath, raw);
    return this.read(profilePath);
  },
  read: function (profilePath) {
    const raw = fs.readFileSync(profilePath, 'utf8');
    const grab = (k) => { const m = new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(raw); return m ? m[1] : undefined; };
    return { compatibleSdkVersion: grab('compatibleSdkVersion'), targetSdkVersion: grab('targetSdkVersion'), compileSdkVersion: grab('compileSdkVersion') };
  },
};

// ---------------------------------------------------------------------------
// 组 G2 · BuildPipeline（匹配供给构建）
// ---------------------------------------------------------------------------
// 等效供给构造（受限环境降级路径，design 2.4.1.3-(3) 供给来源优先级②）
const SdkSupplyBuilder = {
  build: function (srcMirror, dest, meta) {
    fs.rmSync(dest, { recursive: true, force: true });
    sh(`cp -a '${srcMirror}' '${dest}'`);
    sh(`chmod -R u+w '${dest}'`);
    const writeMeta = (p) => {
      if (!fs.existsSync(p)) return false;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const k of ['apiVersion', 'platformVersion', 'releaseType', 'version']) if (k in j) j[k] = String(meta[k]);
      try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch (e) {}
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
      return true;
    };
    const sp = path.join(dest, 'default', 'sdk-pkg.json');
    if (fs.existsSync(sp)) {
      const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
      j.data = Object.assign(j.data, { apiVersion: String(meta.apiVersion), platformVersion: String(meta.platformVersion), releaseType: meta.releaseType, version: meta.version });
      fs.writeFileSync(sp, JSON.stringify(j, null, 2));
    }
    let n = 0;
    for (const v of ['openharmony', 'hms']) {
      for (const m of ['ets', 'js', 'native', 'toolchains', 'previewer']) {
        for (const f of ['oh-uni-package.json', 'uni-package.json']) if (writeMeta(path.join(dest, 'default', v, m, f))) n++;
      }
    }
    return { root: dest, meta, metaFiles: n };
  },
};

const BuildPipeline = {
  // opts: { projectRoot, workRoot, supplySrc, supplyMeta, sdkLibDir, hvigorBin, patchPlatform, nodeBin, ts, outDir }
  build: async function (decl, opts) {
    const { projectRoot, workRoot, sdkLibDir, hvigorBin, patchPlatform, nodeBin, ts, outDir } = opts;
    const log = [];
    const projDir = path.join(workRoot, `proj-${ts}`);

    fs.rmSync(projDir, { recursive: true, force: true });
    fs.mkdirSync(projDir, { recursive: true });
    for (const item of ['AppScope', 'feature', 'product', 'hvigor', 'oh-package.json5', 'build-profile.json5', 'hvigorfile.ts', 'code-linter.json5']) {
      sh(`cp -a '${path.join(projectRoot, item)}' '${projDir}/'`);
    }
    fs.rmSync(path.join(projDir, 'product', 'phone', 'build'), { recursive: true, force: true });
    fs.rmSync(path.join(projDir, 'feature', 'winvm-onetap', 'build'), { recursive: true, force: true });
    fs.mkdirSync(path.join(projDir, 'oh_modules'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'product', 'phone', 'oh_modules'), { recursive: true });
    for (const p of [path.join(projDir, 'oh_modules', 'winvm_onetap'), path.join(projDir, 'product', 'phone', 'oh_modules', 'winvm_onetap')]) {
      try { fs.symlinkSync(path.join(projDir, 'feature', 'winvm-onetap'), p); } catch (e) {}
    }
    // 声明落盘（G1）
    ProfileWriter.apply(path.join(projDir, 'build-profile.json5'), decl);
    // 等效供给（受限环境）
    const supplyRoot = path.join(workRoot, 'supply');
    SdkSupplyBuilder.build(opts.supplySrc, supplyRoot, opts.supplyMeta);

    const env = Object.assign({}, process.env, {
      DEVECO_SDK_HOME: supplyRoot,
      NODE_PATH: opts.hvigorNodeModules,
    });
    const hv = `${nodeBin} --jitless -r '${patchPlatform}' '${hvigorBin}' --no-daemon --mode module -p product=default -p buildMode=debug assembleHap`;
    let hvLog = '';
    let hvRc = 0;
    try { hvLog = sh(hv, { cwd: projDir, env }); } catch (e) { hvRc = e.status || 1; hvLog = String(e.stdout || '') + String(e.stderr || ''); }
    fs.writeFileSync(path.join(workRoot, `hvigor-assembleHap-${ts}.log`), String(hvLog).replace(/\u001b\[[0-9;]*m/g, ''));
    const clean = hvLog.replace(/\u001b\[[0-9;]*m/g, '');
    const compileOk = /Finished\s+:phone:default@CompileArkTS/.test(clean);
    const pkgHapFail = /Failed\s+:phone:default@PackageHap/.test(clean);
    const notFound = /00303312|00303313/.test(clean);
    log.push({ step: 'hvigor-assembleHap', rc: hvRc, compileOk, packageHapFailed: pkgHapFail, sdkMismatch: notFound });
    if (notFound) {
      throw new BaselineError(ERROR_CODES.E7002, diag(ERROR_CODES.E7002, { sdkPlatformVersion: opts.supplyMeta.platformVersion, message: '00303312/00303313 声明与供给不同源' }));
    }
    if (!compileOk) {
      throw new Error('CompileArkTS 未通过（属工程缺陷，不映射 E7xxx）');
    }
    // pack（SDK 原生二进制，替代 hvigor 的 java 打包）
    const BUILD = path.join(projDir, 'product', 'phone', 'build', 'default');
    const unsigned = path.join(workRoot, `functional-unsigned-${ts}.hap`);
    sh(`'${sdkLibDir}/ohos_packing_tool' pack --mode hap ` +
      `--json-path '${BUILD}/intermediates/package/default/module.json' ` +
      `--ets-path '${BUILD}/intermediates/loader_out/default/ets' ` +
      `--index-path '${BUILD}/intermediates/res/default/resources.index' ` +
      `--resources-path '${BUILD}/intermediates/res/default/resources' ` +
      `--pack-info-path '${BUILD}/outputs/default/pack.info' ` +
      `--out-path '${unsigned}' --force true`);
    // sign-profile + sign-app + verify-app
    const profileJson = path.join(workRoot, 'profile.json');
    const tmpl = JSON.parse(fs.readFileSync(path.join(sdkLibDir, 'UnsgnedDebugProfileTemplate.json'), 'utf8'));
    tmpl['bundle-info']['bundle-name'] = 'com.example.winvmonetapdemo';
    tmpl.validity['not-after'] = 2000000000;
    fs.writeFileSync(profileJson, JSON.stringify(tmpl, null, 2));
    const p7b = path.join(workRoot, 'profile.p7b');
    sh(`'${sdkLibDir}/hap-sign-tool' sign-profile -mode localSign -keyAlias "OpenHarmony Application Profile Debug" ` +
      `-keyPwd 123456 -profileCertFile '${sdkLibDir}/OpenHarmonyProfileDebug.pem' -inFile '${profileJson}' ` +
      `-signAlg SHA256withECDSA -keystoreFile '${sdkLibDir}/OpenHarmony.p12' -keystorePwd 123456 -outFile '${p7b}'`);
    fs.mkdirSync(outDir, { recursive: true });
    const signed = path.join(outDir, `winvmonetap-demo-baseline-${ts}.hap`);
    sh(`'${sdkLibDir}/hap-sign-tool' sign-app -mode localSign -keyAlias "OpenHarmony Application Release" ` +
      `-keyPwd 123456 -appCertFile '${sdkLibDir}/OpenHarmonyApplication.pem' -profileFile '${p7b}' -profileSigned 1 ` +
      `-inFile '${unsigned}' -signAlg SHA256withECDSA -keystoreFile '${sdkLibDir}/OpenHarmony.p12' -keystorePwd 123456 ` +
      `-outFile '${signed}' -signCode 1 -compatibleVersion ${decl.compatibleSdkVersion.replace(/.*\((\d+)\)/, '$1')}`);
    let verifyOut = '';
    try { verifyOut = sh(`'${sdkLibDir}/hap-sign-tool' verify-app -inFile '${signed}' -outCertChain '${path.join(workRoot, 'verify-cert.cer')}' -outProfile '${path.join(workRoot, 'verify-profile.p7b')}' 2>&1`); } catch (e) { verifyOut = String(e.stdout || '') + String(e.stderr || ''); }
    const verified = /hap verify successed/.test(verifyOut);
    log.push({ step: 'pack+sign+verify', unsigned, signed, verified });
    return { hapPath: signed, verified, unsigned, log, compileOk, hvigorRc: hvRc, hvigorLogTail: clean.split('\n').slice(-25).join('\n') };
  },
};

module.exports = { ProfileWriter, SdkSupplyBuilder, BuildPipeline };