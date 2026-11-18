import { FunctionsHttpError } from '@supabase/supabase-js';
import { docTypeOf, plateKey } from './docTypes';
import { supabase } from './supabase';

export const BUCKET = 'giay-to';
const MAX_SIDE = 1600;        // cạnh dài tối đa sau khi nén
const JPEG_QUALITY = 0.8;
const MAX_PDF = 8 * 1024 * 1024;

export interface PreparedFile { blob: Blob; mime: string; base64: string; ext: string }
export type FieldValue = string | number | null;
export interface AiResult { fields: Record<string, FieldValue>; provider: string; warnings: string[] }

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Không đọc được tệp'));
    r.readAsDataURL(blob);
  });
}

/** Ảnh: thu nhỏ còn cạnh dài 1600px, JPEG ~80% (thường 150–400KB). PDF: giữ nguyên. */
export async function prepareFile(file: File): Promise<PreparedFile> {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_PDF) throw new Error('Tệp PDF quá lớn (tối đa 8MB)');
    return { blob: file, mime: file.type, base64: await toBase64(file), ext: 'pdf' };
  }
  if (!file.type.startsWith('image/')) throw new Error('Chỉ nhận ảnh hoặc tệp PDF');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Trình duyệt không xử lý được ảnh');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Không nén được ảnh'))), 'image/jpeg', JPEG_QUALITY));
  return { blob, mime: 'image/jpeg', base64: await toBase64(blob), ext: 'jpg' };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Tải tệp lên Storage. Tên tệp chuẩn: BIENSO_loaigiay_ngaygio_stt.ext */
export async function uploadFiles(tenantId: string, ownerKind: 'xe', ownerId: string, plate: string, docType: string,
                                  files: PreparedFile[]): Promise<string[]> {
  const base = `${plateKey(plate) || 'XE-MOI'}_${docType}_${stamp()}`;
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = `${tenantId}/${ownerKind}/${ownerId}/${base}_${i + 1}.${files[i].ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, files[i].blob, { contentType: files[i].mime, upsert: false });
    if (error) throw new Error(`Tải ảnh lên không được: ${error.message}`);
    paths.push(path);
  }
  return paths;
}

/** Gọi AI đọc giấy tờ. Lỗi (chưa cấu hình AI, quá giờ…) trả về câu báo để người dùng nhập tay. */
export async function readByAI(docType: string, files: PreparedFile[]): Promise<AiResult> {
  if (!docTypeOf(docType)) throw new Error('Loại giấy tờ không hợp lệ');
  const { data, error } = await supabase.functions.invoke('doc-reader', {
    body: { doc_type: docType, files: files.map((f) => ({ mime: f.mime, data: f.base64 })) },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await error.context.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? 'AI chưa đọc được, vui lòng nhập tay');
    }
    throw new Error('AI chưa đọc được, vui lòng nhập tay');
  }
  return data as AiResult;
}

/** Link xem tệp trong 10 phút (bucket riêng tư). */
export async function signedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error || !data) throw new Error(error?.message ?? 'Không mở được tệp');
  return data.signedUrl;
}
