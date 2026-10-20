import { zlib, BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { Logger } from '../util/Logger';

// zip 解压（zlib 契约：inFile 须 .zip 结尾且为沙箱路径；outDir 必须已存在）
export class ZipExtractor {

  async extract(zipPath: string, outDir: string): Promise<void> {
    if (!fileIo.accessSync(outDir)) {
      fileIo.mkdirSync(outDir, true);
    }
    Logger.info(`extract: ${zipPath} -> ${outDir}`);
    await new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
      const options: zlib.Options = { level: zlib.CompressLevel.COMPRESS_LEVEL_DEFAULT_COMPRESSION };
      zlib.decompressFile(zipPath, outDir, options, (errData: BusinessError) => {
        if (errData !== null) {
          reject(new Error(`E3001 解压失败: code=${errData.code} message=${errData.message}`));
          return;
        }
        resolve();
      });
    });
    Logger.info(`extract done: ${outDir}`);
  }
}
