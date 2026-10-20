import { pasteboard, BusinessError } from '@kit.BasicServicesKit';
import { Logger } from '../util/Logger';

// 剪贴板写入（写剪贴板无需 READ_PASTEBOARD 权限；读才需）
export class ClipboardService {

  async copyText(text: string): Promise<boolean> {
    try {
      const pasteData: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      const systemPasteboard: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      await systemPasteboard.setData(pasteData);
      Logger.info(`clipboard set ok (${text.length} chars)`);
      return true;
    } catch (err) {
      const e = err as BusinessError;
      Logger.error(`剪贴板写入失败: code=${e.code} ${e.message}`);
      return false;
    }
  }
}
