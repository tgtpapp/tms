import { FunctionsHttpError } from '@supabase/supabase-js';
import { docTypeOf, type OwnerKind } from './docTypes';
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

/** Tên viết liền không dấu: "51B-123.45" → 51B12345, "Nguyễn Văn Đạt" → NGUYENVANDAT */
export function safeName(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'D').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 30);
}

/** Tải tệp lên Storage. Tên tệp chuẩn: BIENSO-hoặc-TEN_loaigiay_ngaygio_xxxx_stt.ext */
export async function uploadFiles(tenantId: string, ownerKind: OwnerKind, ownerId: string, label: string, docType: string,
                                  files: PreparedFile[]): Promise<string[]> {
  // thêm 4 ký tự ngẫu nhiên để 2 lần tải trong cùng 1 giây không trùng tên
  const base = `${safeName(label) || 'MOI'}_${docType}_${stamp()}_${crypto.randomUUID().slice(0, 4)}`;
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
      const payload = (await error.context.json().catch(() => null)) as { error?: string; attempts?: { provider: string; error?: string }[] } | null;
      // Kèm lý do từng AI (vd "quá 10 giây", "HTTP 400: API key not valid") để biết cách sửa
      const why = (payload?.attempts ?? []).filter((a) => a.error).map((a) => `${a.provider}: ${a.error}`).join(' · ');
      throw new Error(`${payload?.error ?? 'AI chưa đọc được, vui lòng nhập tay'}${why ? ` (${why})` : ''}`);
    }
    throw new Error('AI chưa đọc được, vui lòng nhập tay');
  }
  return data as AiResult;
}

/** Tải lại tệp giấy tờ đã lưu (ảnh / PDF) để AI đọc lại. */
export async function loadStoredFiles(paths: string[]): Promise<PreparedFile[]> {
  const out: PreparedFile[] = [];
  for (const p of paths) {
    const { data, error } = await supabase.storage.from(BUCKET).download(p);
    if (error || !data) throw new Error(`Không tải được tệp đã lưu: ${error?.message ?? p}`);
    const ext = (p.split('.').pop() ?? 'jpg').toLowerCase();
    const mime = data.type.startsWith('image/') || data.type === 'application/pdf' ? data.type
      : ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg';
    out.push({ blob: data, mime, base64: await toBase64(data), ext });
  }
  return out;
}

/** Link xem tệp trong 10 phút (bucket riêng tư). */
export async function signedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error || !data) throw new Error(error?.message ?? 'Không mở được tệp');
  return data.signedUrl;
}

/* ------------------------------------------------------------------ Chữ ký (in lệnh vận chuyển) */

/** Ảnh PNG cạnh dài tối đa 800px. removeWhite: tách nền trắng (chữ ký, con dấu chụp trên giấy trắng). */
async function preparePng(file: File, removeWhite: boolean): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Chỉ nhận ảnh');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Trình duyệt không xử lý được ảnh');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  if (removeWhite) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = img.data;
    for (let i = 0; i < p.length; i += 4) {
      const lum = (p[i] + p[i + 1] + p[i + 2]) / 3;
      const sat = Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]);
      // Nền giấy: sáng và gần như không màu → trong suốt; viền chuyển dần cho mịn
      if (lum > 215 && sat < 40) p[i + 3] = 0;
      else if (lum > 170 && sat < 40) p[i + 3] = Math.round(p[i + 3] * (215 - lum) / 45);
    }
    ctx.putImageData(img, 0, 0);
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Không xử lý được ảnh'))), 'image/png'));
}

/** who: 'giam_doc' (chữ ký giám đốc), 'con_dau' (con dấu công ty) hoặc user_id (chữ ký của chính mình). Tự tách nền trắng. */
export async function uploadSignature(tenantId: string, who: string, file: File): Promise<void> {
  const blob = await preparePng(file, true);
  const { error } = await supabase.storage.from(BUCKET).upload(`${tenantId}/chu_ky/${who}.png`, blob, { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`Không tải được ảnh: ${error.message}`);
}

/** Link ảnh chữ ký / con dấu (10 phút), null nếu chưa có hoặc không có quyền xem. */
export async function signatureUrl(tenantId: string, who: string): Promise<string | null> {
  return fileUrl(`${tenantId}/chu_ky/${who}.png`);
}

/* ------------------------------------------------------------------ Tệp công ty (logo, hồ sơ pháp lý) */

/** path trong thư mục công ty, vd 'logo.png', 'ho_so/giay_phep.jpg' */
export async function uploadCompanyFile(tenantId: string, path: string, blob: Blob, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).upload(`${tenantId}/cong_ty/${path}`, blob, { contentType, upsert: true });
  if (error) throw new Error(`Không tải được ảnh: ${error.message}`);
}
export async function uploadLogo(tenantId: string, file: File): Promise<void> {
  await uploadCompanyFile(tenantId, 'logo.png', await preparePng(file, false), 'image/png');
}
export const companyFileUrl = (tenantId: string, path: string) => fileUrl(`${tenantId}/cong_ty/${path}`);

/** Xóa ảnh ("Bỏ ảnh"). full: đường dẫn đầy đủ trong bucket. */
export async function removeFile(full: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([full]);
  if (error) throw new Error(`Không bỏ được ảnh: ${error.message}`);
}

async function fileUrl(full: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(full, 600);
  return error || !data ? null : `${data.signedUrl}&t=${Date.now()}`;
}
