import { hilog } from '@kit.PerformanceAnalysisKit';

const LOG_DOMAIN = 0xF822;
const LOG_TAG = 'WinVMOnetap';

// hilog 封装：界面日志 + 系统日志双通道（复用同一文案）
export class Logger {
  static info(msg: string): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, '%{public}s', msg);
  }

  static warn(msg: string): void {
    hilog.warn(LOG_DOMAIN, LOG_TAG, '%{public}s', msg);
  }

  static error(msg: string): void {
    hilog.error(LOG_DOMAIN, LOG_TAG, '%{public}s', msg);
  }
}
