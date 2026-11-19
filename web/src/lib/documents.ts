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

/**
 * Ảnh PNG cạnh dài tối đa 800px. ink: tách nền giấy (chữ ký / con dấu chụp trên giấy).
 * Cách làm (như app cũ): ước lượng màu giấy TỪNG VÙNG (chịu được bóng đổ, giấy ngả xám/vàng khi chụp điện thoại),
 * tính độ đậm của mực so với nền giấy tại chỗ → trong suốt phần giấy, giữ nét mực, cắt sát.
 * Con dấu: thêm bước làm màu mực tươi, đậm (đỏ dấu) cho rõ nét khi in.
 */
async function preparePng(file: File, ink: false | 'chu_ky' | 'con_dau'): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Chỉ nhận ảnh');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, (ink ? 1200 : 800) / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * scale));
  const H = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Trình duyệt không xử lý được ảnh');
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  let out: HTMLCanvasElement = canvas;
  if (ink) out = removePaper(canvas, ctx, ink === 'con_dau') ?? canvas;
  if (ink && Math.max(out.width, out.height) > 800) {
    const k = 800 / Math.max(out.width, out.height);
    const c2 = document.createElement('canvas');
    c2.width = Math.round(out.width * k);
    c2.height = Math.round(out.height * k);
    const g2 = c2.getContext('2d');
    if (g2) {
      g2.imageSmoothingQuality = 'high';
      g2.drawImage(out, 0, 0, c2.width, c2.height);
      out = c2;
    }
  }
  return new Promise<Blob>((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('Không xử lý được ảnh'))), 'image/png'));
}

/** Tách nền giấy, trả canvas đã cắt sát nét mực (null nếu không thấy mực). seal: làm màu dấu tươi, đậm. */
function removePaper(c: HTMLCanvasElement, g: CanvasRenderingContext2D, seal: boolean): HTMLCanvasElement | null {
  const W = c.width, H = c.height, N = W * H;
  const id = g.getImageData(0, 0, W, H);
  const p = id.data;
  let transparent = 0;
  for (let i = 3; i < p.length; i += 4) if (p[i] < 128) transparent++;
  if (transparent > N * 0.15) return null;   // ảnh đã có nền trong suốt
  const L = (i: number) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
  // Ngưỡng "giấy": 30% điểm sáng nhất
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < p.length; i += 4) hist[L(i) | 0]++;
  let acc = 0, gL = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= N * 0.3) { gL = v; break; } }
  let gr = 0, gg = 0, gb = 0, gn = 0;
  for (let i = 0; i < p.length; i += 4) if (L(i) >= gL) { gr += p[i]; gg += p[i + 1]; gb += p[i + 2]; gn++; }
  const G = [gr / Math.max(1, gn), gg / Math.max(1, gn), gb / Math.max(1, gn)];
  // Màu giấy từng ô rồi phóng to mượt
  const B = Math.max(12, Math.round(Math.max(W, H) / 10)), bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  const sm = document.createElement('canvas');
  sm.width = bw;
  sm.height = bh;
  const sg = sm.getContext('2d');
  if (!sg) return null;
  const sd = sg.createImageData(bw, bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const x1 = Math.min(W, bx * B + B), y1 = Math.min(H, by * B + B);
    let mx = 0;
    for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) mx = Math.max(mx, L((y * W + x) * 4));
    let r = 0, gg2 = 0, b = 0, n = 0;
    for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (L(i) >= mx - 18) { r += p[i]; gg2 += p[i + 1]; b += p[i + 2]; n++; }
    }
    const o = (by * bw + bx) * 4, ok = n > 0 && mx >= gL * 0.5;
    sd.data[o] = ok ? r / n : G[0];
    sd.data[o + 1] = ok ? gg2 / n : G[1];
    sd.data[o + 2] = ok ? b / n : G[2];
    sd.data[o + 3] = 255;
  }
  sg.putImageData(sd, 0, 0);
  const bc = document.createElement('canvas');
  bc.width = W;
  bc.height = H;
  const bg = bc.getContext('2d', { willReadFrequently: true });
  if (!bg) return null;
  bg.imageSmoothingEnabled = true;
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(sm, 0, 0, W, H);
  const q = bg.getImageData(0, 0, W, H).data;
  // Độ đậm mực so với giấy tại chỗ → độ trong suốt; khôi phục màu mực thật
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  let sr = 0, sgr = 0, sb = 0, sw = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = Math.max(q[i] - p[i], q[i + 1] - p[i + 1], q[i + 2] - p[i + 2], Math.abs(q[i] - p[i]) * 0.6, 0)
      / Math.max(60, Math.max(q[i], q[i + 1], q[i + 2]));
    let a = (d - (seal ? 0.1 : 0.12)) / (seal ? 0.25 : 0.33);
    a = a <= 0 ? 0 : a >= 1 ? 1 : a;
    if (a > 0) for (let k = 0; k < 3; k++) { const v = (p[i + k] - (1 - a) * q[i + k]) / a; p[i + k] = v < 0 ? 0 : v > 255 ? 255 : v; }
    p[i + 3] = Math.round(a * 255);
    if (a > 0.25) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (a > 0.6) { sr += p[i] * a; sgr += p[i + 1] * a; sb += p[i + 2] * a; sw += a; }
    }
  }
  if (x1 < 0) return null;   // không thấy nét mực
  if (seal && sw > 0) {
    // Con dấu: một màu mực tươi, đậm theo màu dấu chủ đạo (thường đỏ); nét mờ đậm lên cho rõ
    const [h, s0] = rgbToHs(sr / sw, sgr / sw, sb / sw);
    const [cr, cg, cb] = hslToRgb(h, Math.max(0.85, s0), 0.45);
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] === 0) continue;
      p[i] = cr; p[i + 1] = cg; p[i + 2] = cb;
      p[i + 3] = Math.min(255, Math.round(255 * Math.pow(p[i + 3] / 255, 0.6)));
    }
  }
  g.putImageData(id, 0, 0);
  const pad = Math.round(Math.max(W, H) * 0.02) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1;
  o.height = y1 - y0 + 1;
  o.getContext('2d')?.drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

function rgbToHs(r: number, g: number, b: number): [number, number] {
  const R = r / 255, G = g / 255, B2 = b / 255, mx = Math.max(R, G, B2), mn = Math.min(R, G, B2), d = mx - mn;
  if (d === 0) return [0, 0];
  const l = (mx + mn) / 2, s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === R ? ((G - B2) / d) % 6 : mx === G ? (B2 - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, Math.min(1, s)];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** who: 'giam_doc' (chữ ký giám đốc), 'con_dau' (con dấu công ty) hoặc user_id (chữ ký của chính mình). Tự tách nền trắng. */
export async function uploadSignature(tenantId: string, who: string, file: File): Promise<void> {
  const blob = await preparePng(file, who === 'con_dau' ? 'con_dau' : 'chu_ky');
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
