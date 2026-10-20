# DESIGN — 模块层详细设计（winvm-onetap HAR）

> DDD Phase 2.2 Step 2.2.4 产物 · 版本 v1.0.0 · 2026-10-20

---

## 1. domain/DeployModels.ts

```ts
// 表单配置（入口参数）
export interface WinvmConfig {
  vmHost: string;        // IPv4，如 172.16.100.10
  vmUser: string;        // VM 用户名
  sshPort: number;       // 固定 22（界面不暴露输入）
  provider: string;      // 'workbuddy' | 'workbuddy-deterministic'
  version: string;       // 'latest' 或具体 tag（如 V1.4.0）
}

// latest 解析结果
export interface ResolvedRelease {
  tag: string;                 // 真实 tag，如 V1.4.0
  zipUrl: string;              // 资产直链
  shaUrl: string;              // 旁挂校验直链
  zipName: string;             // winvm-overall-<V>.zip
  resolveMode: 'latest' | 'manual';
}

// 取包流水线阶段（驱动进度条与状态文案）
export enum FetchStage {
  IDLE = 'IDLE',
  PERMISSION = 'PERMISSION',
  RESOLVING = 'RESOLVING',
  DOWNLOADING = 'DOWNLOADING',
  VERIFYING = 'VERIFYING',
  EXTRACTING = 'EXTRACTING',
  EXPORTING = 'EXPORTING',
  DONE = 'DONE',
  FAILED = 'FAILED'
}

// 引擎回调事件（UI 单向刷新用）
export interface DeployReport {          // 父文档 §5.3 契约
  version: string;
  ok: boolean;
  finishedAt: string;
  phases: Record<string, string>;
  checks: ReportCheck[];
  failures: string[];
}
export interface ReportCheck {
  id: string; pass: boolean; evidence: string;
}
```

设计要点：`ok`/`pass` 等字段名与 JSON 契约**逐字一致**（反序列化免映射）；
检查项 id 用父文档六/七项口径（health/capabilities/systeminfo/a2a/gui/audit/bothends）。

## 2. data/GitHubReleaseClient.ts

```ts
class GitHubReleaseClient {
  static readonly OWNER = 'athronix';
  static readonly REPO = 'workbuddy-virtual-win-plugin';

  // latest tag 解析（空 tag → 抛错，绝不拼 URL 继续）
  async resolveLatest(): Promise<string>                     // GET releases/latest → JSON.parse → tag_name

  // 资产 URL 组装
  assetUrls(version: string): { zipUrl: string; shaUrl: string; zipName: string }

  // 流式下载到 destPath（内部先写 destPath + '.part'，成功后 rename）
  // 事件：onProgress(received: number, total: number)
  async download(url: string, destPath: string, onProgress?: (r: number, t: number) => void): Promise<void>
}
```

实现约束：
- 每个请求 `http.createHttp()` + 用完 `destroy()`；`readTimeout: 60000`；
  `requestInStream` 返回码必须为 200（否则抛错带码）。
- 分片 `fs.writeSync(fd, buf)` **不传 offset**（文件指针自然前进，防写花）。
- `dataReceiveProgress.totalSize` 为 0 时进度条置不确定态（接口不总返回 Content-Length）。
- latest JSON 解析：`JSON.parse(text.result)`，取 `.tag_name`；空/非串 → `throw new Error('latest 解析失败')`。

## 3. data/Sha256Verifier.ts

```ts
class Sha256Verifier {
  // 分片 sha256（1MB/片）→ 小写 hex
  async fileSha256(filePath: string): Promise<string>

  // 旁挂 .sha256 解析：取首行行首 64 位 hex（忽略 '文件名' 与空白）
  parseSidecar(text: string): string

  // 校验：不匹配抛 Error('E2001 sha256 mismatch: actual=<x> expected=<y>')
  async verify(zipPath: string, sidecarText: string): Promise<void>
}
```

- 摘要实现：`cryptoFramework.createMd('SHA256')` → 循环 `update({data})` → `await digest()` → `.data`
  → hex 化（`b.toString(16).padStart(2,'0')`）。
- digest 的 `.data` 为 Uint8Array；hex 循环用小写。

## 4. data/ZipExtractor.ts

```ts
class ZipExtractor {
  // outDir 必须已存在（zlib 契约）；调用方先 mkdirSync(outDir, true)
  async extract(zipPath: string, outDir: string): Promise<void>
}
```
- `zlib.decompressFile(zipPath, outDir, { level: zlib.CompressLevel.COMPRESS_LEVEL_DEFAULT_COMPRESSION }, cb)`
  → 包一层 Promise；错误码透传日志。

## 5. data/SharedDirStore.ts

```ts
class SharedDirStore {
  // 运行期权限申请（UIAbilityContext 注入；hostContext 传入）
  async ensureDownloadPermission(): Promise<boolean>

  // L3 目标根：<getUserDownloadDir()>/winvm-release
  targetRoot(): string

  // staging 目录：<cacheDir>/winvm-stage（先清空再建）
  async prepareStaging(): Promise<{ stageDir: string; outDir: string }>

  // 真实目录递归复制（分片 1MB；同名覆盖；无符号链接）
  async exportTree(srcDir: string, destDir: string): Promise<number>   // 返回文件数

  // report 副本读回：targetRoot()/deploy-report.json
  readReportMirror(): DeployReport | null
}
```

- 权限：`context.requestPermissionsFromUser(['ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY'])`
  → 全 granted 才算过；拒绝返回 false（UI 引导）。
- 复制用 `listFileSync + statSync`（isDirectory()）递归；文件用 `openSync` 双端句柄分片搬运。
- 读回时先 `statSync` 取 size，>0 才读；`readTextSync` + `JSON.parse` + `finishedAt` 存在校验。

## 6. prompt/InstallPromptBuilder.ts

- 输入 `WinvmConfig` + `ResolvedRelease` → 输出**逐字**遵循父文档 §5.2 的 prompt 文本：
  标题段（含 VERSION）、包来源段（G7 相对路径改成 `~/Downloads/winvm-release` 忠实父模板不动）、
  VM 参数段、步骤 1–8 原文、**追加步骤 9（旁写副本）**与一句「演示版追加」注释行。
- 参数代入点：`{VERSION}`（resolvedTag）、`{VM_HOST}`、`{VM_USER}`、`{WINVM_VM_PROVIDER}`。
- 生成后自检：文本中不得残留 `{` 占位符（发现即抛错，防呆）。

## 7. data/DeployEngine.ts（编排）

```ts
interface DeployEngineCallbacks {
  onLog(level: 'info'|'warn'|'error', msg: string): void;
  onStage(stage: FetchStage, text: string): void;
  onProgress(received: number, total: number): void;
  onPromptReady(prompt: string): void;          // 供 UI 决定复制/展示
  onReport(report: DeployReport | null): void;  // 轮询每次结果
}
class DeployEngine {
  constructor(ctx: common.UIAbilityContext, cb: DeployEngineCallbacks)
  async fetchPackage(cfg: WinvmConfig): Promise<ResolvedRelease>   // FR-2 全链
  async copyPrompt(cfg: WinvmConfig, rel: ResolvedRelease): Promise<void>  // FR-3
  startReportPolling(): void      // 10s 间隔，30min 超时，采信即停
  stopReportPolling(): void
}
```

- 引擎**不 import 任何 ArkUI**（保证无 UI 依赖可移植）；UI 反馈纯回调。
- 轮询用 `setInterval`（页面 onAboutToDisappear 或 stop 时清理，防泄漏）。

## 8. ui/DeployPage.ets

布局（Column 滚动）自上而下：
1. 提示条（Text，WB 提示，FR-7）。
2. 表单卡：version（TextInput + 「解析 latest」按钮）、vmHost、vmUser、
   provider（Select）。
3. 按钮组：① 获取发布包 / ② VM 环境准备（禁用）/ ③ 复制安装指令 / ④ 一键部署（主色）。
4. 进度卡：Text（stage 文案）+ Progress（value 0-100，未知态用 LoadingProgress）。
5. 日志卡：List（最近 50 条倒序 + key）。
6. 报告卡：ok/版本/finishedAt + checks 列表（✅/❌）+ failures。
7. 「刷新状态」按钮 + 轮询状态文案。

交互不变量：
- `isBusy` 为 true 时①③④全部禁用；表单可编辑（仅 vmHost/vmUser/provider/version）。
- 一键流程：fetchPackage → copyPrompt（自动）→ toast「已复制，请打开 WorkBuddy 粘贴」
  → startReportPolling。
- provider 的 `workbuddy-deterministic` 项带说明文案（零登录依赖）。
