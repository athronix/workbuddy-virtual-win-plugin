import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { Environment, fileIo } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Logger } from '../util/Logger';
import { DeployReport, EMPTY_PHASES, ReportCheck, ReportCheckRaw, ReportRaw } from '../domain/DeployModels';

const DOWNLOAD_PERMISSION = 'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY';
const CHUNK_SIZE = 1024 * 1024;
const SUB_DIR = 'winvm-release';
const REPORT_NAME = 'deploy-report.json';

// 共享下载目录（L3）交互：权限申请、staging 管理、递归导出、report 副本读回
export class SharedDirStore {
  private context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  // 运行期权限申请（user_grant；拒绝返回 false，UI 引导去系统设置）
  async ensureDownloadPermission(): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const result = await atManager.requestPermissionsFromUser(this.context, [DOWNLOAD_PERMISSION]);
      const granted = result.authResults[0] === 0;
      Logger.info(`permission granted=${granted}`);
      return granted;
    } catch (err) {
      const e = err as BusinessError;
      Logger.error(`E4001 权限申请异常: code=${e.code} ${e.message}`);
      return false;
    }
  }

  // L3 目标根目录：<getUserDownloadDir()>/winvm-release（权威路径，不硬编码）
  downloadRoot(): string {
    const base = Environment.getUserDownloadDir();
    return `${base}/${SUB_DIR}`;
  }

  // 清空（存在时）并准备目录
  clearAndPrepareDir(dir: string): void {
    if (fileIo.accessSync(dir)) {
      const entries = fileIo.listFileSync(dir);
      for (const name of entries) {
        this.removePath(`${dir}/${name}`);
      }
    } else {
      fileIo.mkdirSync(dir, true);
    }
  }

  // 真实目录递归复制（G7：hmdfs 禁符号链接；同名覆盖；1MB 分片）
  async exportTree(srcDir: string, destDir: string): Promise<number> {
    if (!fileIo.accessSync(destDir)) {
      fileIo.mkdirSync(destDir, true);
    }
    let count = 0;
    const entries = fileIo.listFileSync(srcDir);
    for (const name of entries) {
      const srcPath = `${srcDir}/${name}`;
      const destPath = `${destDir}/${name}`;
      const stat = fileIo.statSync(srcPath);
      if (stat.isDirectory()) {
        count += await this.exportTree(srcPath, destPath);
      } else {
        this.copyFile(srcPath, destPath);
        count += 1;
      }
    }
    return count;
  }

  // report 副本读回：字节数>0 + JSON 可解析 + finishedAt 非空 才采信（G10 防写入窗口假空）
  readReportMirror(): DeployReport | undefined {
    const path = `${this.downloadRoot()}/${REPORT_NAME}`;
    try {
      if (!fileIo.accessSync(path)) {
        return undefined;
      }
      const stat = fileIo.statSync(path);
      if (!stat.isFile() || stat.size === 0) {
        return undefined;
      }
      const text = fileIo.readTextSync(path);
      const raw = JSON.parse(text) as ReportRaw;
      const finishedAt = raw.finishedAt ?? '';
      if (finishedAt.length === 0) {
        return undefined;
      }
      const report: DeployReport = {
        version: raw.version ?? '',
        ok: raw.ok === true,
        finishedAt: finishedAt,
        phases: raw.phases ?? EMPTY_PHASES,
        checks: SharedDirStore.toChecks(raw.checks),
        failures: SharedDirStore.toStrings(raw.failures)
      };
      return report;
    } catch (err) {
      const e = err as BusinessError;
      Logger.error(`E6001 report 读取失败(继续轮询): code=${e.code} ${e.message}`);
      return undefined;
    }
  }

  private copyFile(srcPath: string, destPath: string): void {
    const srcFile = fileIo.openSync(srcPath, fileIo.OpenMode.READ_ONLY);
    try {
      const destFile = fileIo.openSync(destPath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        const buffer = new ArrayBuffer(CHUNK_SIZE);
        let n = fileIo.readSync(srcFile.fd, buffer);
        while (n > 0) {
          const slice = buffer.slice(0, n);
          fileIo.writeSync(destFile.fd, slice);
          n = fileIo.readSync(srcFile.fd, buffer);
        }
      } finally {
        fileIo.closeSync(destFile);
      }
    } finally {
      fileIo.closeSync(srcFile);
    }
  }

  private removePath(path: string): void {
    const stat = fileIo.statSync(path);
    if (stat.isDirectory()) {
      const entries = fileIo.listFileSync(path);
      for (const name of entries) {
        this.removePath(`${path}/${name}`);
      }
      fileIo.rmdirSync(path);
    } else {
      fileIo.unlinkSync(path);
    }
  }

  private static toChecks(raw: ReportCheckRaw[] | undefined): ReportCheck[] {
    const out: ReportCheck[] = [];
    if (raw === undefined) {
      return out;
    }
    for (const item of raw) {
      const check: ReportCheck = {
        id: item.id ?? '',
        pass: item.pass === true,
        evidence: item.evidence ?? ''
      };
      out.push(check);
    }
    return out;
  }

  private static toStrings(raw: string[] | undefined): string[] {
    const out: string[] = [];
    if (raw === undefined) {
      return out;
    }
    for (const item of raw) {
      if (typeof item === 'string') {
        out.push(item);
      }
    }
    return out;
  }
}
