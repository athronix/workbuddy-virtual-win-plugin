import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { Logger } from '../util/Logger';
import { ResolvedRelease } from '../domain/DeployModels';

// GitHub releases/latest 响应的宽松原始类型
interface LatestReleaseRaw {
  tag_name?: string;
}

const LATEST_API_URL = 'https://api.github.com/repos/athronix/workbuddy-virtual-win-plugin/releases/latest';
const USER_AGENT = 'winvm-onetap-demo/1.0.0';

// GitHub Release 匿名取包：latest tag 解析 + 流式下载（.part 临时文件 + 完成 rename）
export class GitHubReleaseClient {

  // latest tag 解析；空 tag 必须抛错，绝不拼 URL 继续（父文档 §5.2 Q-5）
  async resolveLatest(): Promise<string> {
    const httpRequest = http.createHttp();
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      readTimeout: 30000,
      connectTimeout: 30000,
      header: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': USER_AGENT
      }
    };
    try {
      const response = await httpRequest.request(LATEST_API_URL, options);
      if (response.responseCode !== 200) {
        throw new Error(`E1001 latest 解析失败: HTTP ${response.responseCode}`);
      }
      const text = response.result as string;
      const raw = JSON.parse(text) as LatestReleaseRaw;
      const tag = raw.tag_name ?? '';
      if (tag.length === 0) {
        throw new Error('E1001 latest 解析失败: tag_name 为空');
      }
      return tag;
    } finally {
      httpRequest.destroy();
    }
  }

  // 版本 -> 资产直链（父文档 §4.4 分发链）
  buildRelease(tag: string, resolveMode: string): ResolvedRelease {
    const zipName = `winvm-overall-${tag}.zip`;
    const baseUrl = `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/${tag}`;
    return {
      tag: tag,
      zipUrl: `${baseUrl}/${zipName}`,
      shaUrl: `${baseUrl}/${zipName}.sha256`,
      zipName: zipName,
      resolveMode: resolveMode
    };
  }

  // 流式下载到 destPath：先写 destPath.part，成功后 rename；失败清理 .part
  async download(url: string, destPath: string, onProgress?: (received: number, total: number) => void): Promise<void> {
    const partPath = `${destPath}.part`;
    this.removeIfExists(partPath);
    const destFile = fileIo.openSync(partPath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    let received = 0;
    let total = 0;
    let streamError = '';
    let writeError = '';

    const onDataReceive = (data: ArrayBuffer): void => {
      if (streamError.length > 0 || writeError.length > 0) {
        return;
      }
      try {
        fileIo.writeSync(destFile.fd, data);
        received += data.byteLength;
        if (onProgress !== undefined) {
          onProgress(received, total);
        }
      } catch (err) {
        const e = err as BusinessError;
        writeError = `code=${e.code} ${e.message}`;
      }
    };

    const onProgressEvent = (data: Object): void => {
      const info = data as Record<string, number>;
      const recv = info['receiveSize'];
      const tot = info['totalSize'];
      if (recv !== undefined) {
        received = recv;
      }
      if (tot !== undefined) {
        total = tot;
      }
      if (onProgress !== undefined) {
        onProgress(received, total);
      }
    };

    const httpRequest = http.createHttp();
    httpRequest.on('dataReceive', onDataReceive);
    httpRequest.on('dataReceiveProgress', onProgressEvent);
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      readTimeout: 60000,
      connectTimeout: 60000,
      header: {
        'User-Agent': USER_AGENT
      }
    };
    try {
      const code = await httpRequest.requestInStream(url, options);
      if (code !== 200) {
        streamError = `HTTP ${code}`;
      }
    } catch (err) {
      const e = err as BusinessError;
      streamError = `code=${e.code} ${e.message}`;
    } finally {
      httpRequest.off('dataReceive', onDataReceive);
      httpRequest.off('dataReceiveProgress', onProgressEvent);
      httpRequest.destroy();
    }
    fileIo.closeSync(destFile);

    const failure = streamError.length > 0 ? streamError : writeError;
    if (failure.length > 0) {
      this.removeIfExists(partPath);
      throw new Error(`E1002 下载失败: ${failure} (${url})`);
    }
    if (received === 0) {
      this.removeIfExists(partPath);
      throw new Error(`E1002 下载失败: 空响应 (${url})`);
    }
    this.removeIfExists(destPath);
    fileIo.renameSync(partPath, destPath);
    Logger.info(`download ok: ${url} -> ${destPath} (${received} bytes)`);
  }

  private removeIfExists(path: string): void {
    try {
      if (fileIo.accessSync(path)) {
        fileIo.unlinkSync(path);
      }
    } catch (err) {
      const e = err as BusinessError;
      Logger.warn(`removeIfExists(${path}) ignored: code=${e.code} ${e.message}`);
    }
  }
}
