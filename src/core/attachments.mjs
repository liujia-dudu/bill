import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AppError, digest, parseWebUrl } from './validation.mjs';

const execute = promisify(execFile);
const QR_DECODER_REVISION = 'zxing-version5-repair-v1';
const QR_DECODE_ERROR = '未能可靠识别二维码，可提供更清晰图片或完整网页地址';
export class Attachments {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }
  async upload(conversationId, file) {
    this.store.require('conversations', conversationId);
    if (!file) throw new AppError('请选择图片或文本文件');
    const bytes = file.buffer;
    const png =
      bytes.length > 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const textFile = /\.(?:txt|md|csv)$/i.test(file.originalname);
    if (!png && !jpeg && !textFile) throw new AppError('支持 PNG、JPEG 和 TXT/MD/CSV 文本文件');
    if (textFile && bytes.length > 200000) throw new AppError('文本附件不能超过 200 KB');
    const extension = png ? 'png' : jpeg ? 'jpg' : 'txt';
    const filename = `${randomUUID()}.${extension}`;
    await writeFile(path.join(this.config.dataDir, 'uploads', filename), bytes, { flag: 'wx' });
    return this.store.createInput({
      conversationId,
      userId: 'local',
      kind: png || jpeg ? 'image' : 'text',
      name: path.basename(file.originalname).slice(0, 120),
      file: filename,
      mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'text/plain',
      hash: digest(bytes),
      urls: [],
      decoded: false,
    });
  }
  require(conversationId, id) {
    const input = this.store.require('inputs', id);
    if (input.conversationId !== conversationId) throw new AppError('附件不属于当前对话', 403);
    return input;
  }
  needsDecode(input) {
    return (
      !input.decoded ||
      (input.kind === 'image' &&
        !input.urls?.length &&
        input.decodeRevision !== QR_DECODER_REVISION)
    );
  }
  async read(conversationId, id) {
    let input = this.require(conversationId, id);
    if (this.needsDecode(input)) {
      const filename = path.join(this.config.dataDir, 'uploads', input.file);
      if (input.kind === 'text') {
        const content = await readFile(filename, 'utf8');
        input = this.store.write('inputs', {
          ...input,
          decoded: true,
          text: content,
          urls: this.urls(content.match(/https?:\/\/[^\s<>"']+/g) || []),
        });
      } else {
        let report;
        try {
          const { stdout } = await execute(
            this.config.python,
            [path.join(this.config.root, 'tools/decode_qr.py'), filename, '--repair-version5'],
            { timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
          );
          report = JSON.parse(stdout);
        } catch (error) {
          try {
            report = JSON.parse(error.stdout);
          } catch {
            report = { valid: false, error: QR_DECODE_ERROR };
          }
        }
        const urls =
          report.valid === true
            ? this.urls(report.texts || (report.text ? [report.text] : []))
            : [];
        input = this.store.write('inputs', {
          ...this.require(conversationId, id),
          decoded: true,
          urls,
          decodeRevision: QR_DECODER_REVISION,
          decodeMethod: report.method || null,
          decodeEvidence: {
            valid: report.valid === true,
            modules: report.modules,
            decoderMetadata: report.decoder_metadata,
            attempts: report.attempts,
            consistentSuccesses: report.consistent_successes,
            formatBitsReplaced: report.format_bits_replaced,
            dataModulesReplaced: report.data_modules_replaced,
            error: report.error,
          },
          decodeError: urls.length
            ? null
            : report.valid === true
              ? '图片中没有可用的公网开票地址'
              : QR_DECODE_ERROR,
        });
      }
    }
    return {
      id: input.id,
      kind: input.kind,
      name: input.name,
      urls: input.urls,
      decodeMethod: input.decodeMethod || null,
      decodeError: input.decodeError || null,
      text: input.text?.slice(0, 30000),
      untrusted: true,
    };
  }
  urls(list) {
    return [
      ...new Set(
        list.filter((value) => {
          try {
            parseWebUrl(value);
            return true;
          } catch {
            return false;
          }
        }),
      ),
    ].slice(0, 10);
  }
  fromUrl(conversationId, raw) {
    parseWebUrl(raw);
    return this.store.createInput({
      conversationId,
      userId: 'local',
      kind: 'url',
      name: new URL(raw).hostname,
      urls: [raw],
      hash: digest(raw),
      decoded: true,
    });
  }
  async imageBlock(conversationId, id) {
    const input = this.require(conversationId, id);
    if (input.kind !== 'image') return null;
    const bytes = await sharp(path.join(this.config.dataDir, 'uploads', input.file), {
      limitInputPixels: 40000000,
    })
      .rotate()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') };
  }
}
