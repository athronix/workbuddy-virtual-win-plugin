import { common } from '@kit.AbilityKit';
import { DeployEngine } from '../data/DeployEngine';
import { Logger } from '../util/Logger';
import {
  DeployReport,
  FetchStage,
  PROVIDER_DETERMINISTIC,
  PROVIDER_OPTIONS,
  PROVIDER_WORKBUDDY,
  ReportCheck,
  ResolvedRelease,
  WinvmConfig,
  WinvmLogEntry
} from '../domain/DeployModels';

const COLOR_PAGE_BG = '#F1F3F5';
const COLOR_CARD_BG = '#FFFFFF';
const COLOR_PRIMARY = '#0A59F7';
const COLOR_TEXT_MAIN = '#182431';
const COLOR_TEXT_SUB = '#66818F';
const COLOR_OK = '#0F8B3D';
const COLOR_ERR = '#D9480F';
const COLOR_WARN = '#B8860B';
const COLOR_DISABLED = '#AEB9C2';
const LOG_KEEP_MAX = 50;

// WinVM Bridge 一键部署助手页面（功能层 UI；整页可随 HAR 移植）
@Component
export struct DeployPage {
  @State versionInput: string = 'latest';
  @State vmHostInput: string = '172.16.100.10';
  @State vmUserInput: string = 'User';
  @State providerChoice: number = 0;
  @State stageKind: FetchStage = FetchStage.IDLE;
  @State stageText: string = '等待开始';
  @State stageLevel: string = 'idle';
  @State busyFlag: boolean = false;
  @State progressVisible: boolean = false;
  @State progressReceived: number = 0;
  @State progressTotal: number = 0;
  @State logEntries: WinvmLogEntry[] = [];
  @State reportExists: boolean = false;
  @State reportVersion: string = '';
  @State reportOk: boolean = false;
  @State reportFinishedAt: string = '';
  @State reportChecks: ReportCheck[] = [];
  @State reportFailures: string[] = [];

  private engine: DeployEngine | undefined = undefined;
  private lastRelease: ResolvedRelease | undefined = undefined;
  private localSeq: number = 0;

  aboutToAppear(): void {
    this.appendLogEntry('info', '部署助手就绪：填写 VM 信息后，可一键部署或分步操作');
  }

  aboutToDisappear(): void {
    this.stopEnginePolling();
  }

  build() {
    Scroll() {
      Column() {
        this.noticeSection()
        this.formSection()
        this.buttonSection()
        this.vmPrepareHint()
        this.progressSection()
        this.logSection()
        this.reportSection()
      }
      .width('100%')
      .padding(16)
      .space(12)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(COLOR_PAGE_BG)
  }

  @Builder
  noticeSection() {
    Column() {
      Text('WinVM Bridge 部署助手（演示版）')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .fontColor(COLOR_TEXT_MAIN)
      Text('安装与验证由 WorkBuddy 执行：请先在鸿蒙机上安装并登录 WorkBuddy。本助手负责发布包下载校验、生成安装指令（复制后粘贴到 WorkBuddy）并读回部署验证报告。')
        .fontSize(12)
        .fontColor(COLOR_TEXT_SUB)
        .margin({ top: 4 })
        .lineHeight(18)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  formSection() {
    Column() {
      Text('发布包与目标 VM')
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(COLOR_TEXT_MAIN)

      Row() {
        Text('版本')
          .fontSize(14)
          .fontColor(COLOR_TEXT_MAIN)
          .width(64)
        TextInput({ placeholder: 'latest 或 V1.4.0', text: this.versionInput })
          .layoutWeight(1)
          .fontSize(14)
          .type(InputType.Normal)
          .onChange((value: string) => {
            this.versionInput = value;
          })
        Button('获取 latest')
          .fontSize(12)
          .height(32)
          .margin({ left: 8 })
          .enabled(!this.busyFlag)
          .onClick(() => {
            this.onResolveLatest();
          })
      }
      .width('100%')
      .margin({ top: 8 })

      Row() {
        Text('VM 地址')
          .fontSize(14)
          .fontColor(COLOR_TEXT_MAIN)
          .width(64)
        TextInput({ placeholder: '如 172.16.100.10', text: this.vmHostInput })
          .layoutWeight(1)
          .fontSize(14)
          .type(InputType.Normal)
          .onChange((value: string) => {
            this.vmHostInput = value;
          })
      }
      .width('100%')
      .margin({ top: 8 })

      Row() {
        Text('VM 用户')
          .fontSize(14)
          .fontColor(COLOR_TEXT_MAIN)
          .width(64)
        TextInput({ placeholder: 'VM 登录用户名', text: this.vmUserInput })
          .layoutWeight(1)
          .fontSize(14)
          .type(InputType.Normal)
          .onChange((value: string) => {
            this.vmUserInput = value;
          })
      }
      .width('100%')
      .margin({ top: 8 })

      Row() {
        Text('Provider')
          .fontSize(14)
          .fontColor(COLOR_TEXT_MAIN)
          .width(64)
        Select([
          { value: PROVIDER_WORKBUDDY },
          { value: PROVIDER_DETERMINISTIC }
        ])
          .selected(this.providerChoice)
          .value(PROVIDER_OPTIONS[this.providerChoice])
          .fontSize(14)
          .layoutWeight(1)
          .onSelect((index: number, value: string | undefined) => {
            this.providerChoice = index;
          })
      }
      .width('100%')
      .margin({ top: 8 })

      Text('Provider 说明：workbuddy 需 VM 内 codebuddy CLI 登录态；首机可先用 workbuddy-deterministic 零登录跑通全链（父文档 G4）。SSH 端口固定 22。')
        .fontSize(11)
        .fontColor(COLOR_TEXT_SUB)
        .margin({ top: 8 })
        .lineHeight(16)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(COLOR_CARD_BG)
    .borderRadius(12)
    .padding(16)
  }

  @Builder
  buttonSection() {
    Grid() {
      GridItem() {
        Button('① 获取发布包')
          .type(ButtonType.Capsule)
          .fontSize(15)
          .width('100%')
          .height(44)
          .backgroundColor(COLOR_PRIMARY)
          .fontColor('#FFFFFF')
          .enabled(!this.busyFlag)
          .onClick(() => {
            this.onFetchPackage();
          })
      }
      GridItem() {
        Button('② VM 环境准备')
          .type(ButtonType.Capsule)
          .fontSize(15)
          .width('100%')
          .height(44)
          .backgroundColor(COLOR_DISABLED)
          .fontColor('#FFFFFF')
          .enabled(false)
          .onClick(() => {
            this.showToast('演示版不实现：需铠大师 VM 软件安装通道');
          })
      }
      GridItem() {
        Button('③ 复制安装指令')
          .type(ButtonType.Capsule)
          .fontSize(15)
          .width('100%')
          .height(44)
          .backgroundColor(COLOR_PRIMARY)
          .fontColor('#FFFFFF')
          .enabled(!this.busyFlag && this.formValid())
          .onClick(() => {
            this.onCopyPrompt();
          })
      }
      GridItem() {
        Button('④ 一键部署')
          .type(ButtonType.Capsule)
          .fontSize(15)
          .width('100%')
          .height(44)
          .backgroundColor('#0B3D91')
          .fontColor('#FFFFFF')
          .enabled(!this.busyFlag && this.formValid())
          .onClick(() => {
            this.onOneTap();
          })
      }
    }
    .columnsTemplate('1fr 1fr')
    .rowsTemplate('1fr 1fr')
    .columnsGap(10)
    .rowsGap(10)
    .width('100%')
    .height(148)
  }

  @Builder
  vmPrepareHint() {
    Text('② VM 环境准备需铠大师既有 VM 软件安装通道（普通应用无此能力，演示版不实现）；VM 前置脚本单真相源 = 父仓库 tools/winvm-prepare.ps1（八核心键 KV 契约，勿 fork）。')
      .fontSize(11)
      .fontColor(COLOR_TEXT_SUB)
      .lineHeight(16)
  }

  @Builder
  progressSection() {
    if (this.progressVisible || this.stageKind === FetchStage.POLLING) {
      Column() {
        Row() {
          Text(stageDot(this.stageLevel))
            .fontSize(14)
            .fontColor(stageColor(this.stageLevel))
          Text(this.stageText)
            .fontSize(14)
            .fontColor(COLOR_TEXT_MAIN)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow(TextOverflow.Ellipsis)
        }
        .width('100%')

        if (this.progressVisible) {
          if (this.progressTotal > 0) {
            Progress({ value: this.progressReceived, total: this.progressTotal, type: ProgressType.Linear })
              .width('100%')
              .color(COLOR_PRIMARY)
              .margin({ top: 8 })
            Text(`${formatKb(this.progressReceived)} / ${formatKb(this.progressTotal)}`)
              .fontSize(11)
              .fontColor(COLOR_TEXT_SUB)
              .margin({ top: 4 })
          } else {
            Row() {
              LoadingProgress()
                .width(20)
                .height(20)
                .color(COLOR_PRIMARY)
              Text('下载中…')
                .fontSize(12)
                .fontColor(COLOR_TEXT_SUB)
                .margin({ left: 8 })
            }
            .margin({ top: 8 })
          }
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .backgroundColor(COLOR_CARD_BG)
      .borderRadius(12)
      .padding(16)
    }
  }

  @Builder
  logSection() {
    Column() {
      Text('执行日志')
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(COLOR_TEXT_MAIN)
      Scroll() {
        Column() {
          ForEach(this.logEntries, (item: WinvmLogEntry) => {
            Text(`[${item.seq}] ${item.level}: ${item.text}`)
              .fontSize(11)
              .fontColor(logColor(item.level))
              .maxLines(2)
              .textOverflow(TextOverflow.Ellipsis)
              .padding({ top: 2, bottom: 2 })
          }, (item: WinvmLogEntry) => item.seq.toString())
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .height(200)
      .margin({ top: 8 })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(COLOR_CARD_BG)
    .borderRadius(12)
    .padding(16)
  }

  @Builder
  reportSection() {
    Column() {
      Row() {
        Text('部署状态')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor(COLOR_TEXT_MAIN)
          .layoutWeight(1)
        Button('刷新状态')
          .fontSize(12)
          .height(30)
          .enabled(!this.busyFlag)
          .onClick(() => {
            this.onRefreshStatus();
          })
      }
      .width('100%')

      if (this.reportExists) {
        Text(this.reportOk ? '部署验证成功' : '部署验证失败（详见下列检查项）')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.reportOk ? COLOR_OK : COLOR_ERR)
          .margin({ top: 8 })
        Text(`版本 ${this.reportVersion} · 完成时间 ${this.reportFinishedAt}`)
          .fontSize(11)
          .fontColor(COLOR_TEXT_SUB)
          .margin({ top: 2 })
        Column() {
          ForEach(this.reportChecks, (item: ReportCheck) => {
            Row() {
              Text(item.pass ? '通过' : '失败')
                .fontSize(11)
                .fontColor(item.pass ? COLOR_OK : COLOR_ERR)
                .width(36)
              Text(`${item.id}: ${item.evidence}`)
                .fontSize(11)
                .fontColor(COLOR_TEXT_MAIN)
                .layoutWeight(1)
                .maxLines(2)
                .textOverflow(TextOverflow.Ellipsis)
            }
            .width('100%')
            .padding({ top: 3, bottom: 3 })
          }, (item: ReportCheck) => item.id)
        }
        .width('100%')
        .margin({ top: 8 })
        if (this.reportFailures.length > 0) {
          Text(`failures: ${this.reportFailures.join(', ')}`)
            .fontSize(11)
            .fontColor(COLOR_ERR)
            .margin({ top: 6 })
        }
      } else {
        Text(this.stageKind === FetchStage.POLLING
          ? '轮询中：等待 WorkBuddy 写回部署报告（每 10 秒一次，超时 30 分钟）'
          : '暂无部署报告：一键部署后自动轮询读回')
          .fontSize(12)
          .fontColor(COLOR_TEXT_SUB)
          .margin({ top: 8 })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(COLOR_CARD_BG)
    .borderRadius(12)
    .padding(16)
  }

  // ---------- 交互处理 ----------

  private onResolveLatest(): void {
    this.ensureEngine();
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    this.busyFlag = true;
    engine.resolveLatestTag()
      .then((tag: string) => {
        this.versionInput = tag;
        this.busyFlag = false;
        this.appendLogEntry('info', `latest 版本已填入: ${tag}`);
      })
      .catch((err: Error) => {
        this.busyFlag = false;
        this.appendLogEntry('error', `latest 解析失败: ${err.message}`);
        this.showToast('latest 解析失败，请检查网络');
      });
  }

  private onFetchPackage(): void {
    this.ensureEngine();
    const engine = this.engine;
    if (engine === undefined || !this.validateForm()) {
      return;
    }
    this.progressVisible = false;
    this.progressReceived = 0;
    this.progressTotal = 0;
    engine.fetchPackage(this.buildConfig())
      .then((release: ResolvedRelease) => {
        this.lastRelease = release;
        this.busyFlag = false;
        this.showToast(`发布包已就绪: ${release.tag}`);
      })
      .catch((err: Error) => {
        this.busyFlag = false;
        this.setStage(FetchStage.FAILED, '获取发布包失败');
        this.appendLogEntry('error', `取包失败: ${err.message}`);
        this.showToast('获取发布包失败，详见日志');
      });
  }

  private onCopyPrompt(): void {
    this.ensureEngine();
    const engine = this.engine;
    if (engine === undefined || !this.validateForm()) {
      return;
    }
    const config = this.buildConfig();
    const known = this.lastRelease;
    const reuse = known !== undefined &&
      (config.version === 'latest' ? known.resolveMode === 'latest' : known.tag === config.version);
    if (reuse) {
      this.doCopyPrompt(engine, config, known as ResolvedRelease);
      return;
    }
    this.busyFlag = true;
    engine.resolveRelease(config)
      .then((release: ResolvedRelease) => {
        this.lastRelease = release;
        this.busyFlag = false;
        this.doCopyPrompt(engine, config, release);
      })
      .catch((err: Error) => {
        this.busyFlag = false;
        this.appendLogEntry('error', `版本解析失败: ${err.message}`);
        this.showToast('版本解析失败，详见日志');
      });
  }

  private doCopyPrompt(engine: DeployEngine, config: WinvmConfig, release: ResolvedRelease): void {
    engine.copyPrompt(config, release)
      .then(() => {
        this.showToast('安装指令已复制，请打开 WorkBuddy 粘贴');
      })
      .catch((err: Error) => {
        this.appendLogEntry('error', `复制失败: ${err.message}`);
        this.showToast('复制失败，请重试');
      });
  }

  private onOneTap(): void {
    this.ensureEngine();
    const engine = this.engine;
    if (engine === undefined || !this.validateForm()) {
      return;
    }
    this.reportExists = false;
    this.progressVisible = false;
    this.progressReceived = 0;
    this.progressTotal = 0;
    const config = this.buildConfig();
    engine.fetchPackage(config)
      .then((release: ResolvedRelease) => {
        this.lastRelease = release;
        return engine.copyPrompt(config, release);
      })
      .then(() => {
        this.showToast('已复制安装指令，请打开 WorkBuddy 新建任务粘贴');
        this.startEnginePolling();
      })
      .catch((err: Error) => {
        this.setStage(FetchStage.FAILED, '一键部署失败');
        this.appendLogEntry('error', `一键部署中断: ${err.message}`);
        this.showToast('一键部署失败，详见日志');
      });
  }

  private onRefreshStatus(): void {
    this.ensureEngine();
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    const report = engine.readReportNow();
    this.setReport(report);
    if (report === undefined) {
      this.showToast('尚未读到部署报告');
    }
  }

  // ---------- 引擎回调 -> 状态 ----------

  private ensureEngine(): void {
    if (this.engine !== undefined) {
      return;
    }
    const hostContext = this.getUIContext().getHostContext();
    if (hostContext === undefined) {
      this.appendLogEntry('error', '无法获取宿主 Context，请稍后重试');
      return;
    }
    const ctx = hostContext as common.UIAbilityContext;
    this.engine = new DeployEngine(ctx, {
      onLog: (entry: WinvmLogEntry): void => {
        this.appendLog(entry);
      },
      onStage: (stage: FetchStage, text: string): void => {
        this.setStage(stage, text);
      },
      onProgress: (received: number, total: number): void => {
        this.setProgress(received, total);
      },
      onReport: (report: DeployReport | undefined): void => {
        this.setReport(report);
      }
    });
  }

  private startEnginePolling(): void {
    this.ensureEngine();
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    engine.startReportPolling();
  }

  private stopEnginePolling(): void {
    const engine = this.engine;
    if (engine !== undefined) {
      engine.stopReportPolling();
    }
  }

  private appendLog(entry: WinvmLogEntry): void {
    const next: WinvmLogEntry[] = [entry];
    for (const old of this.logEntries) {
      if (next.length >= LOG_KEEP_MAX) {
        break;
      }
      next.push(old);
    }
    this.logEntries = next;
  }

  private appendLogEntry(level: string, text: string): void {
    this.localSeq += 1;
    this.appendLog({
      seq: this.localSeq,
      level: level,
      text: text
    });
  }

  private setStage(stage: FetchStage, text: string): void {
    this.stageKind = stage;
    this.stageText = text;
    if (stage === FetchStage.DONE) {
      this.stageLevel = 'ok';
      this.busyFlag = false;
      this.progressVisible = false;
    } else if (stage === FetchStage.FAILED) {
      this.stageLevel = 'fail';
      this.busyFlag = false;
      this.progressVisible = false;
    } else if (stage === FetchStage.IDLE) {
      this.stageLevel = 'idle';
      this.busyFlag = false;
    } else {
      this.stageLevel = 'run';
      if (stage === FetchStage.DOWNLOADING) {
        this.progressVisible = true;
        this.busyFlag = true;
      } else if (stage !== FetchStage.POLLING) {
        this.busyFlag = true;
      }
    }
  }

  private setProgress(received: number, total: number): void {
    this.progressReceived = received;
    this.progressTotal = total;
    this.progressVisible = true;
  }

  private setReport(report: DeployReport | undefined): void {
    if (report === undefined) {
      this.reportExists = false;
      return;
    }
    this.reportExists = true;
    this.reportVersion = report.version;
    this.reportOk = report.ok;
    this.reportFinishedAt = report.finishedAt;
    this.reportChecks = report.checks;
    this.reportFailures = report.failures;
    this.busyFlag = false;
    this.appendLogEntry('info', `report 读回: ok=${report.ok} checks=${report.checks.length}`);
  }

  private showToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message, duration: 2000 });
    } catch (err) {
      const e = err as Error;
      Logger.error(`toast failed: ${e.message}`);
    }
  }

  private formValid(): boolean {
    return this.vmHostInput.trim().length > 0 && this.vmUserInput.trim().length > 0;
  }

  private validateForm(): boolean {
    if (!this.formValid()) {
      this.showToast('请先填写 VM 地址与用户名');
      return false;
    }
    return true;
  }

  private buildConfig(): WinvmConfig {
    return {
      vmHost: this.vmHostInput.trim(),
      vmUser: this.vmUserInput.trim(),
      sshPort: 22,
      provider: PROVIDER_OPTIONS[this.providerChoice],
      version: this.versionInput.trim()
    };
  }
}

// 模块级纯函数（避免 struct 内嵌套函数）
function stageDot(level: string): string {
  if (level === 'ok') {
    return '[成功]';
  }
  if (level === 'fail') {
    return '[失败]';
  }
  if (level === 'run') {
    return '[进行中]';
  }
  return '[等待]';
}

function stageColor(level: string): string {
  if (level === 'ok') {
    return COLOR_OK;
  }
  if (level === 'fail') {
    return COLOR_ERR;
  }
  if (level === 'run') {
    return COLOR_PRIMARY;
  }
  return COLOR_TEXT_SUB;
}

function logColor(level: string): string {
  if (level === 'error') {
    return COLOR_ERR;
  }
  if (level === 'warn') {
    return COLOR_WARN;
  }
  return COLOR_TEXT_MAIN;
}

function formatKb(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}
