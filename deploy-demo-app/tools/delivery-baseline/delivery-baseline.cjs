// 交付基线适配 · 构建期接口库（spec 5.8 / design 2.4.2）
// E 组：取证契约（DeviceProbe / SdkInventory / HostApiFloor）
// F 组：决策契约（BaselineResolver / SdkSelector / VersionDeclarer）—— 纯判定，无副作用
// H 组：核验契约（ArtifactApiInspector / InstallVerifier）
// 本文件仅存在于构建/核验域，不进入 App 运行期（spec 5.8.7）。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ---------------------------------------------------------------------------
// 0) 数据模型与常量（design 2.4.3）
// ---------------------------------------------------------------------------
const RELEASE_TYPES = ['Release', 'Beta'];
const MATCH_TIERS = ['完全匹配', '最接近匹配'];
const ERROR_CODES = { E7001: 'E7001', E7002: 'E7002', E7003: 'E7003', E7004: 'E7004', E7005: 'E7005' };

// API 字段编码：platform(a.b.c) + api -> a*1e7 + b*1e5 + c*1e3 + api
// 实证：6.0.0(20) -> 60000020；6.1.1(24) -> 60101024；26.0.0(26) -> 260000026
function encodeApiValue(platformVersion, apiVersion) {
  const [a, b, c] = String(platformVersion).split('.').map((n) => parseInt(n, 10) || 0);
  return a * 1e7 + b * 1e5 + c * 1e3 + Number(apiVersion);
}

// 功能层系统 API 最低可用版本表（证据 TEST-REPORT-sdk-version-fix-20261023.md §4）
const KIT_MIN_API = {
  NetworkKit: 9,
  BasicServicesKit: 9,
  CryptoArchitectureKit: 9,
  CoreFileKit: 12,
  AbilityKit: 9,
  ArkUI: 12,
  PerformanceAnalysisKit: 9,
};

const POLICY_MIN_API = 20; // 交付兼容下限（design 2.4.1.3-(2) 唯一权威表）

class BaselineError extends Error {
  constructor(code, diagnostic) {
    super(diagnostic && diagnostic.message ? diagnostic.message : code);
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function diag(code, { sdkPlatformVersion = '', deviceApiVersion = null, artifactThreshold = null, message = '' } = {}) {
  return { code, sdkPlatformVersion, deviceApiVersion, artifactThreshold, message };
}

// ---------------------------------------------------------------------------
// 组 E1 · DeviceProbe（设备基线取证，spec 5.8.1 / 6.7-1/2）
// ---------------------------------------------------------------------------
function probeWithHdc(hdcBin) {
  const q = (key) => cp.execSync(`'${hdcBin}' shell param get ${key}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  return {
    apiVersion: parseInt(q('const.ohos.apiversion'), 10),
    systemFullName: q('const.ohos.fullname'),
    releaseType: q('const.ohos.releasetype'),
    deviceType: q('const.product.devicetype'),
  };
}

const DeviceProbe = {
  // 具备设备通道时实证；不可达时可用缓存实证记录（design E1 前置条件）。禁止以需求文档旧值替代。
  probe: async function (opts = {}) {
    const hdcBin = opts.hdcBin || 'hdc';
    const cachedEvidence = opts.cachedEvidence || null;
    try {
      const list = cp.execSync(`'${hdcBin}' list targets`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!list || /\[Empty\]/.test(list)) throw new Error('no device');
      const d = probeWithHdc(hdcBin);
      if (!d.apiVersion || !d.systemFullName) throw new Error('probe attributes missing');
      return { value: d, source: 'hdc-live' };
    } catch (e) {
      if (cachedEvidence) return { value: cachedEvidence, source: 'cached-evidence', probeError: String(e.message || e) };
      throw new BaselineError(ERROR_CODES.E7002, diag(ERROR_CODES.E7002, { message: `设备不可达且无缓存实证记录：${e.message || e}` }));
    }
  },
};

// ---------------------------------------------------------------------------
// 组 E2 · SdkInventory（候选 SDK 枚举，spec 5.8.2 / 6.7-3/4）
// ---------------------------------------------------------------------------
const SdkInventory = {
  scan: async function (sdkRoot) {
    if (!sdkRoot || !fs.existsSync(sdkRoot)) {
      throw new BaselineError(ERROR_CODES.E7002, diag(ERROR_CODES.E7002, { message: `SDK 根路径不可用：${sdkRoot}` }));
    }
    const found = [];
    const searchDirs = [];
    const defaultDir = path.join(sdkRoot, 'default');
    if (fs.existsSync(defaultDir)) {
      for (const vendor of fs.readdirSync(defaultDir)) {
        if (!fs.statSync(path.join(defaultDir, vendor)).isDirectory()) continue;
        for (const mod of ['ets', 'js', 'native', 'toolchains', 'previewer']) searchDirs.push(path.join(defaultDir, vendor, mod));
      }
    }
    for (const mod of ['ets', 'js', 'native', 'toolchains', 'previewer']) searchDirs.push(path.join(sdkRoot, mod));

    const seen = new Set();
    for (const dir of searchDirs) {
      const metaPath = path.join(dir, 'oh-uni-package.json');
      if (!fs.existsSync(metaPath)) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { continue; }
      const key = `${j.platformVersion}|${j.apiVersion}|${j.releaseType}|${j.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        platformVersion: String(j.platformVersion),
        apiVersion: parseInt(j.apiVersion, 10),
        releaseType: j.releaseType,
        version: j.version,
        location: dir,
      });
    }
    if (found.length === 0) {
      throw new BaselineError(ERROR_CODES.E7002, diag(ERROR_CODES.E7002, { message: `SDK 元数据缺失，查找路径：${sdkRoot}` }));
    }
    return found;
  },
};

// ---------------------------------------------------------------------------
// 组 E3 · HostApiFloor（功能层最低 API 下限，spec 4.5.4 / 6.7-5）
// ---------------------------------------------------------------------------
const HostApiFloor = {
  resolve: function (featureSrcDirs = []) {
    const used = new Set();
    for (const dir of featureSrcDirs) {
      if (!fs.existsSync(dir)) continue;
      const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (/\.(ets|ts)$/.test(ent.name)) {
            const src = fs.readFileSync(p, 'utf8');
            for (const m of src.matchAll(/from\s+'@kit\.([A-Za-z]+)'/g)) used.add(m[1]);
          }
        }
      };
      walk(dir);
    }
    let floor = 0;
    const detail = [];
    for (const kit of used) {
      const min = KIT_MIN_API[kit];
      if (min === undefined) continue;
      detail.push({ kit, minApi: min });
      floor = Math.max(floor, min);
    }
    return { floor, detail, kits: [...used] };
  },
};

// ---------------------------------------------------------------------------
// 组 F1 · BaselineResolver（交付基线合成，spec 5.8.1 / 6.7）
// ---------------------------------------------------------------------------
const BaselineResolver = {
  compose: function (device, floor) {
    const releaseChannel = device.releaseType === 'Beta' ? 'Beta' : 'Release';
    const m = /(\d+\.\d+\.\d+)/.exec(device.systemFullName || '');
    const devicePlatformVersion = m ? m[1] : '';
    const baseline = { deviceApi: device.apiVersion, releaseChannel, floorApi: floor, upperBound: device.apiVersion, devicePlatformVersion };
    if (floor > baseline.upperBound) {
      throw new BaselineError(ERROR_CODES.E7003, diag(ERROR_CODES.E7003, {
        deviceApiVersion: device.apiVersion,
        artifactThreshold: floor,
        message: `功能层下限 ${floor} 高于设备 API ${device.apiVersion}，无收敛空间`,
      }));
    }
    return baseline;
  },
};

// ---------------------------------------------------------------------------
// 组 F2 · SdkSelector（三级判据匹配，spec 5.8.2 / 4.5.2）
// ---------------------------------------------------------------------------
const SdkSelector = {
  select: function (baseline, candidates) {
    if (!candidates || candidates.length === 0) {
      return { selected: null, matchTier: null, rejectedReason: 'E7002 候选 SDK 集合为空' };
    }
    // 三级判据有序短路：① 平台版本一致 ② API ≤ 设备 ③ 通道一致
    const tier1 = candidates.filter((c) => c.platformVersion === baseline.devicePlatformVersion);
    const tier2 = candidates.filter((c) => c.apiVersion <= baseline.deviceApi).sort((a, b) => b.apiVersion - a.apiVersion);
    const tier3 = tier2.filter((c) => c.releaseType === baseline.releaseChannel);
    if (tier1.length && tier3.length) return { selected: tier3[0], matchTier: MATCH_TIERS[0] };
    if (tier1.length) return { selected: tier1[0], matchTier: MATCH_TIERS[0] };
    if (tier3.length) return { selected: tier3[0], matchTier: MATCH_TIERS[1] };
    if (tier2.length) return { selected: tier2[0], matchTier: MATCH_TIERS[1] };
    const over = candidates[0];
    return {
      selected: null,
      matchTier: null,
      rejectedReason: `${ERROR_CODES.E7001} SDK ${over.platformVersion}(${over.releaseType}) 高于设备 ${baseline.deviceApi}(${baseline.releaseChannel})`,
    };
  },
};

// ---------------------------------------------------------------------------
// 组 F3 · VersionDeclarer（版本声明收敛，spec 5.8.3/5.8.4 / 6.7-5/6）
// ---------------------------------------------------------------------------
const VersionDeclarer = {
  declare: function (baseline, selection) {
    const compatibleApi = Math.max(baseline.floorApi, POLICY_MIN_API);
    if (compatibleApi > baseline.deviceApi) {
      throw new BaselineError(ERROR_CODES.E7003, diag(ERROR_CODES.E7003, {
        deviceApiVersion: baseline.deviceApi,
        artifactThreshold: compatibleApi,
        message: `兼容版本 ${compatibleApi} 超出设备门限 ${baseline.deviceApi}`,
      }));
    }
    const targetPlatform = baseline.devicePlatformVersion || '6.1.1';
    const compatiblePlatform = '6.0.0';
    const decl = {
      compatibleSdkVersion: `${compatiblePlatform}(${compatibleApi})`,
      targetSdkVersion: `${targetPlatform}(${baseline.deviceApi})`,
      compileSdkVersion: undefined, // 省略：官方建议，编译取配套 SDK
    };
    // 双侧边界：compatibleApi ≤ deviceApi，floor ≤ compatibleApi
    if (compatibleApi < baseline.floorApi || baseline.deviceApi < baseline.floorApi) {
      throw new BaselineError(ERROR_CODES.E7003, diag(ERROR_CODES.E7003, { message: '双侧边界校验失败' }));
    }
    return decl;
  },
};

// ---------------------------------------------------------------------------
// 组 H1 · ArtifactApiInspector（产物 API 字段核验，spec 5.8.5 / 6.7-7/8/9）
// ---------------------------------------------------------------------------
const ArtifactApiInspector = {
  inspect: function (hapPath, ctx = {}) {
    const zipBuf = fs.readFileSync(hapPath);
    const moduleJson = readZipEntry(zipBuf, 'module.json');
    if (!moduleJson) {
      throw new BaselineError(ERROR_CODES.E7005, diag(ERROR_CODES.E7005, { message: '产物缺少 module.json 或未签名' }));
    }
    const a = JSON.parse(moduleJson).app;
    const triple = {
      minAPIVersion: a.minAPIVersion,
      targetAPIVersion: a.targetAPIVersion,
      compileSdkVersion: a.compileSdkVersion,
      apiReleaseType: a.apiReleaseType,
    };
    const deviceApi = ctx.deviceApi;
    if (typeof deviceApi === 'number') {
      if (decodeApiValue(triple.minAPIVersion).api > deviceApi) {
        throw new BaselineError(ERROR_CODES.E7003, diag(ERROR_CODES.E7003, {
          sdkPlatformVersion: triple.compileSdkVersion, deviceApiVersion: deviceApi, artifactThreshold: triple.minAPIVersion,
          message: `产物安装门限 ${triple.minAPIVersion} > 设备镜像 API ${deviceApi}`,
        }));
      }
      if (decodeApiValue(triple.targetAPIVersion).api > deviceApi) {
        throw new BaselineError(ERROR_CODES.E7003, diag(ERROR_CODES.E7003, {
          sdkPlatformVersion: triple.compileSdkVersion, deviceApiVersion: deviceApi, artifactThreshold: triple.targetAPIVersion,
          message: `产物目标版本 ${triple.targetAPIVersion} > 设备镜像 API ${deviceApi}`,
        }));
      }
    }
    return triple;
  },
};

function decodeApiValue(v) {
  const n = Number(v);
  const api = n % 1000;
  const patch = Math.floor(n / 1000) % 100;
  const minor = Math.floor(n / 1e5) % 100;
  const major = Math.floor(n / 1e7);
  return { platformVersion: `${major}.${minor}.${patch}`, api, raw: n };
}

// 极简 zip 条目读取（只解 module.json，避免外部依赖）
function readZipEntry(buf, name) {
  const sig = 0x04034b50;
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== sig) { off += 1; continue; }
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const fname = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    if (fname === name && method === 0) return buf.slice(dataStart, dataStart + compSize).toString('utf8');
    off += 30 + nameLen + extraLen + compSize;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 组 H2 · InstallVerifier（安装 + 启动验收，spec 4.2.7/5.8.6/6.7-10）
// ---------------------------------------------------------------------------
const InstallVerifier = {
  verify: async function (hapPath, device, opts = {}) {
    const hdcBin = opts.hdcBin || 'hdc';
    const triple = ArtifactApiInspector.inspect(hapPath, { deviceApi: device.apiVersion }); // 前置：门限 ≤ 设备
    let installOk = false;
    let launchOk = false;
    let raw = '';
    try {
      raw = cp.execSync(`'${hdcBin}' install -r '${hapPath}'`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      installOk = /success/i.test(raw);
    } catch (e) {
      raw = String((e.stderr || '') + (e.stdout || '') || e.message);
      const rejected = /sdk|version|api|较低|install failed|failed/i.test(raw);
      return {
        installOk: false, launchOk: false, verdict: '不可交付', artifact: triple,
        error: rejected
          ? new BaselineError(ERROR_CODES.E7004, diag(ERROR_CODES.E7004, {
              sdkPlatformVersion: triple.compileSdkVersion, deviceApiVersion: device.apiVersion, artifactThreshold: triple.minAPIVersion,
              message: `安装被拒（门限 ${triple.minAPIVersion} vs 设备 API ${device.apiVersion}）：${raw.trim()}`,
            }))
          : undefined,
        raw: raw.trim(),
      };
    }
    if (installOk) {
      try {
        const out = cp.execSync(`'${hdcBin}' shell aa start -a EntryAbility -b com.example.winvmonetapdemo`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        launchOk = !/error|failed/i.test(out);
      } catch (e) { launchOk = false; }
    }
    return { installOk, launchOk, verdict: installOk && launchOk ? '可交付' : '不可交付', artifact: triple, raw: raw.trim() };
  },
};

module.exports = {
  RELEASE_TYPES, MATCH_TIERS, ERROR_CODES, KIT_MIN_API, POLICY_MIN_API,
  encodeApiValue, decodeApiValue, BaselineError, diag,
  DeviceProbe, SdkInventory, HostApiFloor, BaselineResolver, SdkSelector, VersionDeclarer,
  ArtifactApiInspector, InstallVerifier, readZipEntry,
};