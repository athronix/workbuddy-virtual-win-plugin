import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { fileIo } from '@kit.CoreFileKit';
import { Logger } from '../util/Logger';

const CHUNK_SIZE = 1024 * 1024;

// sha256 分片校验（父文档 A1/Q-2：旁挂 .sha256 整包校验）
export class Sha256Verifier {

  // 文件分片 sha256 -> 小写 hex
  async fileSha256(filePath: string): Promise<string> {
    const md = cryptoFramework.createMd('SHA256');
    const srcFile = fileIo.openSync(filePath, fileIo.OpenMode.READ_ONLY);
    try {
      const buffer = new ArrayBuffer(CHUNK_SIZE);
      let n = fileIo.readSync(srcFile.fd, buffer);
      while (n > 0) {
        const view = new Uint8Array(buffer, 0, n);
        await md.update({ data: view });
        n = fileIo.readSync(srcFile.fd, buffer);
      }
    } finally {
      fileIo.closeSync(srcFile);
    }
    const result = await md.digest();
    return Sha256Verifier.toHex(result.data);
  }

  // 旁挂 .sha256 解析：父项目契约 = `<64hex>  <zipName>\n`（两空格分隔，sha256sum -c 兼容，
  // 见 delivery/pack-release.mjs sha256SidecarContent）——取首 token（空白分隔）。
  // 切勿按「拼接整行所有 hex 字符」解析：zipName（winvm-overall-V1.4.0.zip）本身
  // 含 hex 字母 e/a/1/4/0，会把字符数污染到 69 导致误报 E2001。
  parseSidecar(text: string): string {
    let line = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === '\n' || ch === '\r') {
        break;
      }
      line += ch;
    }
    line = line.trim();
    let token = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line.charAt(i);
      if (ch === ' ' || ch === '\t') {
        break;
      }
      token += ch;
    }
    if (token.length !== 64) {
      throw new Error(`E2001 旁挂 sha256 文件解析失败: ${line}`);
    }
    const lower = token.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      const ch = lower.charAt(i);
      const isHex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
      if (!isHex) {
        throw new Error(`E2001 旁挂 sha256 文件解析失败: ${line}`);
      }
    }
    return lower;
  }

  // 校验：不匹配抛错（含 actual/expected 双值，便于排查）
  async verify(zipPath: string, sidecarText: string): Promise<void> {
    const expected = this.parseSidecar(sidecarText);
    const actual = await this.fileSha256(zipPath);
    if (actual !== expected) {
      throw new Error(`E2001 sha256 不匹配: actual=${actual} expected=${expected}`);
    }
    Logger.info(`sha256 ok: ${zipPath} = ${actual}`);
  }

  private static toHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      let h = bytes[i].toString(16);
      if (h.length === 1) {
        h = `0${h}`;
      }
      hex += h;
    }
    return hex;
  }
}
