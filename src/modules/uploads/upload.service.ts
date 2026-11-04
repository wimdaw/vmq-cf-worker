/**
 * 图片上传。
 *
 * EdgeOne 版把图片二进制直接写进 Blob（`up/<hash>`），不再 base64 塞数据库，
 * 所以没有「单值 2MB」的限制，只保留前端提示用的 1.4MB 上限（lib/const.ts）。
 */
import type { Env } from '../../lib/db';
import type { ApiResult } from '../../http/respond';
import { fail, okData } from '../../http/respond';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, UPLOAD_MIME_LABEL } from '../../lib/const';
import { putUpload } from '../../lib/blob-db';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function saveUpload(env: Env, file: File): Promise<ApiResult> {
  if (file.size > MAX_UPLOAD_BYTES) return fail(`图片不能超过 ${MAX_UPLOAD_LABEL}`);

  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) return fail(`只支持 ${UPLOAD_MIME_LABEL}`);

  const buf = await file.arrayBuffer();
  const hash = (await sha256Hex(buf)).slice(0, 24);

  // EdgeOne 版直接把二进制丢进 Blob（up/<hash>），不用 base64 塞数据库，
  // 所以原来那条「编码后不能超过单条上限」的闸口自然消失了。
  await putUpload(hash, new Uint8Array(buf), { mime, size: file.size });

  return okData({ url: `/upload/${hash}` }, '上传成功');
}
