import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { Logger } from '../util/Logger';
import { FetchStage, ResolvedRelease, WinvmConfig, DeployReport, WinvmLogEntry } from '../domain/DeployModels';
import { GitHubReleaseClient } from './GitHubReleaseClient';
import { Sha256Verifier } from './Sha256Verifier';
import { ZipExtractor } from './ZipExtractor';
import { SharedDirStore } from './SharedDirStore';
import { ClipboardService } from './ClipboardService';
import { InstallPromptBuilder } from '../prompt/InstallPromptBuilder';

const POLL_INTERVAL_MS = 10000;
const POLL_MAX_ROUNDS = 180; // 30 分钟

// 引擎回调（UI 单向刷新；引擎不依赖任何 ArkUI import，保证可移植）
export interface DeployEngineCallbacks {
  onLog: (entry: WinvmLogEntry) => void;
  onStage: (stage: FetchStage, text: string) => void;
  onProgress: (received: number, total: number) => void;
  onReport: (report: DeployReport | undefined) => void;
}

// 编排引擎：FR-2 取包链 + FR-3 prompt 复制 + FR-4 report 轮询
export class DeployEngine {
  private context: common.UIAbilityContext;
  private callbacks: DeployEngineCallbacks;
  private releaseClient: GitHubReleaseClient;
  private verifier: Sha256Verifier;
  private extractor: ZipExtractor;
  private store: SharedDirStore;
  private clipboard: ClipboardService;
  private stageRoot: string;
  private pollTimer: number = -1;
  private pollRounds: number = 0;
  private seqCounter: number = 0;

  constructor(context: common.UIAbilityContext, callbacks: DeployEngineCallbacks) {
    this.context = context;
    this.callbacks = callbacks;
    this.releaseClient = new GitHubReleaseClient();
    this.verifier = new Sha256Verifier();
    this.extractor = new ZipExtractor();
    this.store = new SharedDirStore(context);
    this.clipboard = new ClipboardService();
    this.stageRoot = `${this.context.cacheDir}/winvm-stage`;
  }

  // 权限 + 版本解析（latest 走匿名 API；手填版本直接用）
  async resolveRelease(config: WinvmConfig): Promise<ResolvedRelease> {
    this.emitStage(FetchStage.PERMISSION, '申请共享下载目录权限');
    const granted = await this.store.ensureDownloadPermission();
    if (!granted) {
      throw new Error('E4001 未获得共享下载目录权限：请在系统设置 > 应用 > 本应用 > 权限中允许下载目录访问后重试');
    }
    this.log('info', '共享下载目录权限已授予');
    let release: ResolvedRelease;
    if (config.version === 'latest' || config.version.length === 0) {
      this.emitStage(FetchStage.RESOLVING, '解析 GitHub latest 版本');
      const tag = await this.releaseClient.resolveLatest();
      release = this.releaseClient.buildRelease(tag, 'latest');
      this.log('info', `latest 解析结果: ${tag}`);
    } else {
      release = this.releaseClient.buildRelease(config.version, 'manual');
      this.log('info', `使用指定版本: ${config.version}`);
    }
    return release;
  }

  // 仅解析 latest tag（版本输入框旁的「获取 latest」按钮用）
  async resolveLatestTag(): Promise<string> {
    const tag = await this.releaseClient.resolveLatest();
    this.log('info', `latest 解析结果: ${tag}`);
    return tag;
  }

  // FR-2 全链：权限 -> 解析 -> 下载 -> 校验 -> 解压 -> 落 L3
  async fetchPackage(config: WinvmConfig): Promise<ResolvedRelease> {
    const release = await this.resolveRelease(config);

    // staging 清空重建（沙箱路径，zlib 契约）
    this.store.clearAndPrepareDir(this.stageRoot);
    const outDir = `${this.stageRoot}/out`;
    fileIo.mkdirSync(outDir, true);

    // 下载 zip + 旁挂 sha256（流式落盘）
    this.emitStage(FetchStage.DOWNLOADING, `下载 ${release.zipName}`);
    const zipPath = `${this.stageRoot}/${release.zipName}`;
    await this.releaseClient.download(release.zipUrl, zipPath, (received: number, total: number) => {
      this.callbacks.onProgress(received, total);
    });
    const zipStat = fileIo.statSync(zipPath);
    this.log('info', `zip 下载完成: ${zipStat.size} bytes`);
    const shaPath = `${this.stageRoot}/${release.zipName}.sha256`;
    await this.releaseClient.download(release.shaUrl, shaPath);
    const shaText = fileIo.readTextSync(shaPath);

    // sha256 整包校验
    this.emitStage(FetchStage.VERIFYING, 'sha256 整包校验');
    await this.verifier.verify(zipPath, shaText);
    this.log('info', 'sha256 校验通过');

    // 解压（沙箱 -> 沙箱）
    this.emitStage(FetchStage.EXTRACTING, '解压发布包');
    await this.extractor.extract(zipPath, outDir);
    const extractedRoot = `${outDir}/overall`;
    if (!fileIo.accessSync(extractedRoot)) {
      throw new Error('E3001 解压结果缺少 overall/ 目录');
    }
    this.log('info', '解压完成: overall/ 就绪');

    // 真实目录复制到 L3（G7：禁符号链接）
    this.emitStage(FetchStage.EXPORTING, '复制到共享下载目录');
    const destRoot = this.store.downloadRoot();
    const fileCount = await this.store.exportTree(extractedRoot, destRoot);
    this.log('info', `已落包 ${fileCount} 个文件 -> ${destRoot}`);

    this.emitStage(FetchStage.DONE, `发布包就绪 (${release.tag})`);
    return release;
  }

  // FR-3 生成 prompt 并复制到剪贴板
  async copyPrompt(config: WinvmConfig, release: ResolvedRelease): Promise<void> {
    const prompt = InstallPromptBuilder.build(config, release);
    const ok = await this.clipboard.copyText(prompt);
    if (!ok) {
      throw new Error('E1003 复制到剪贴板失败');
    }
    this.log('info', `install prompt 已复制（${prompt.length} 字符，版本 ${release.tag}）`);
  }

  // FR-4 report 轮询：10s 间隔；采信即停；30min 超时提示
  startReportPolling(): void {
    this.stopReportPolling();
    this.pollRounds = 0;
    this.emitStage(FetchStage.POLLING, '等待部署报告（每 10 秒轮询）');
    this.pollTimer = setInterval(() => {
      this.pollRounds += 1;
      const report = this.store.readReportMirror();
      this.callbacks.onReport(report);
      if (report !== undefined) {
        this.log('info', `report 已读回: ok=${report.ok} version=${report.version}`);
        this.stopReportPolling();
        this.emitStage(FetchStage.DONE, report.ok ? '部署验证成功' : '部署验证失败（详见报告）');
        return;
      }
      if (this.pollRounds >= POLL_MAX_ROUNDS) {
        this.stopReportPolling();
        this.log('warn', '超过 30 分钟未读到部署报告：请确认已在 WorkBuddy 粘贴安装指令');
        this.emitStage(FetchStage.FAILED, '等待部署报告超时');
      }
    }, POLL_INTERVAL_MS);
  }

  stopReportPolling(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
  }

  // 手动刷新：立刻读一次 report
  readReportNow(): DeployReport | undefined {
    return this.store.readReportMirror();
  }

  private emitStage(stage: FetchStage, text: string): void {
    this.callbacks.onStage(stage, text);
    Logger.info(`stage=${stage} ${text}`);
  }

  private log(level: string, text: string): void {
    this.seqCounter += 1;
    this.callbacks.onLog({
      seq: this.seqCounter,
      level: level,
      text: text
    });
    Logger.info(`${level}: ${text}`);
  }
}
