// Gọi Edge Function "drive": lưu / tải / xóa tệp hồ sơ trên Google Drive của nhà xe (qua Apps Script).
import { supabase } from './supabase';

export async function drive<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('drive', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const j = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) as { error?: string } | null : null;
    throw new Error(j?.error ?? error.message);
  }
  return data as T;
}

/** Tệp → base64 (không kèm tiền tố data:) */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Không đọc được tệp'));
    r.readAsDataURL(f);
  });
}

/** Tải xuống / mở tệp từ base64 */
export function openBase64(name: string, mime: string, b64: string, download: boolean) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  if (download || !/^(image\/|application\/pdf|text\/)/.test(mime)) {
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Mã Apps Script nhà xe dán vào script.google.com (giống app cũ) */
export const DRIVE_SCRIPT = String.raw`// KHO HỒ SƠ NHÀ XE (TMS) · dán vào script.google.com (dự án MỚI) → Triển khai → Ứng dụng web
// Thực thi bằng: Tôi · Ai có quyền truy cập: Bất kỳ ai · Sau đó copy địa chỉ Web app (kết thúc bằng /exec) vào TMS → Cấu hình
var MA_KET_NOI = 'DOI-MA-NAY-IT-NHAT-6-KY-TU';   // đặt mã riêng, nhập đúng mã này vào TMS
var THU_MUC_GOC = 'NhaXe - Luu tru ho so';

function doPost(e) {
  var out;
  try {
    var b = JSON.parse(e.postData.contents);
    if (String(b.key) !== String(MA_KET_NOI)) throw new Error('Sai mã kết nối');
    if (b.action === 'ping') out = ping_();
    else if (b.action === 'hs_put') out = put_(b);
    else if (b.action === 'hs_get') out = get_(b);
    else if (b.action === 'hs_del') out = del_(b);
    else throw new Error('Lệnh không hợp lệ: ' + b.action);
  } catch (err) { out = { ok: false, description: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return ContentService.createTextOutput('Kho ho so Nha Xe: dang hoat dong'); }
function ds_(it) { var L = []; while (it.hasNext()) L.push(it.next()); return L; }
function gop_(src, dst) {
  ds_(src.getFiles()).forEach(function (x) { x.moveTo(dst); });
  ds_(src.getFolders()).forEach(function (x) { var it = dst.getFoldersByName(x.getName()); if (it.hasNext()) gop_(x, it.next()); else x.moveTo(dst); });
  src.setTrashed(true);
}
function goc_() { var L = ds_(DriveApp.getFoldersByName(THU_MUC_GOC)); if (!L.length) return DriveApp.createFolder(THU_MUC_GOC); for (var i = 1; i < L.length; i++) gop_(L[i], L[0]); return L[0]; }
function con_(cha, ten) { ten = String(ten).replace(/[\\\/]/g, '-').trim() || '_'; var L = ds_(cha.getFoldersByName(ten)); if (!L.length) return cha.createFolder(ten); for (var i = 1; i < L.length; i++) gop_(L[i], L[0]); return L[0]; }
function ping_() { var g = goc_(); return { ok: true, ver: 2, used: DriveApp.getStorageUsed(), limit: DriveApp.getStorageLimit(), folder: g.getUrl(), name: g.getName() }; }
function put_(b) {
  var k = LockService.getScriptLock(), f; k.waitLock(30000);
  try { f = goc_(); (b.path || []).forEach(function (n) { f = con_(f, n); }); } finally { k.releaseLock(); }
  var blob = Utilities.newBlob(Utilities.base64Decode(b.data), b.mime || 'application/octet-stream', b.name || 'tep');
  var file = f.createFile(blob);
  return { ok: true, id: file.getId(), url: file.getUrl(), size: file.getSize() };
}
function get_(b) { var file = DriveApp.getFileById(b.id), blob = file.getBlob(); return { ok: true, name: file.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) }; }
function del_(b) { DriveApp.getFileById(b.id).setTrashed(true); return { ok: true }; }
`;
