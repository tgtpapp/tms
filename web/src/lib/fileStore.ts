// Tệp của nhà xe (ảnh giấy tờ, chữ ký, con dấu, logo, ảnh đại diện, PDF…) lưu trên Google Drive của nhà xe như app cũ.
// Database chỉ ghi tên tệp (bảng file_store). Xem tệp: gọi Edge Function "tep" một lần rồi nhớ trên máy (IndexedDB);
// lần sau mở lại lấy ngay trên máy, chỉ tải lại khi tệp đã được thay (đổi updated_at).
import { supabase } from './supabase';

async function tep<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('tep', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const j = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) as { error?: string } | null : null;
    throw new Error(j?.error ?? error.message);
  }
  return data as T;
}

// ------------------------------------------------------------------ bộ nhớ đệm trên máy
interface Cached { v: string; type: string; blob: Blob }
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbp) dbp = new Promise((ok) => {
    try {
      const r = indexedDB.open('tms-tep', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('f');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    } catch { ok(null); }
  });
  return dbp;
}
async function cacheGet(name: string): Promise<Cached | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((ok) => {
    try {
      const q = d.transaction('f').objectStore('f').get(name);
      q.onsuccess = () => ok((q.result as Cached | undefined) ?? null);
      q.onerror = () => ok(null);
    } catch { ok(null); }
  });
}
async function cacheSet(name: string, c: Cached | null): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    const s = d.transaction('f', 'readwrite').objectStore('f');
    if (c) s.put(c, name); else s.delete(name);
  } catch { /* bộ nhớ máy đầy / chế độ ẩn danh: bỏ qua, lần sau tải lại */ }
}

const b64ToBlob = (data: string, type: string) => {
  const bin = atob(data);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
};
function toB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Không đọc được tệp'));
    r.readAsDataURL(blob);
  });
}

// ------------------------------------------------------------------ đọc
interface Meta { name: string; updated_at: string }
/** Tệp đang có (trong quyền xem của mình) theo tên. */
async function metas(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < names.length; i += 100) {
    const { data } = await supabase.from('file_store').select('name, updated_at').in('name', names.slice(i, i + 100));
    for (const m of (data ?? []) as Meta[]) out.set(m.name, m.updated_at);
  }
  return out;
}
/** Danh sách tệp trong 1 thư mục (vd ảnh đại diện của cả nhà xe). */
export async function listFiles(prefix: string): Promise<Meta[]> {
  const out: Meta[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('file_store').select('name, updated_at').like('name', `${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`).order('name').range(from, from + 999);
    if (error) return out;
    out.push(...((data ?? []) as Meta[]));
    if ((data ?? []).length < 1000) return out;
  }
}

const pending = new Map<string, Promise<Blob | null>>();
// Trong phiên: mỗi tệp 1 bản (cùng phiên bản thì dùng lại cả địa chỉ xem, không tạo mới / không hủy địa chỉ đang dùng)
const mem = new Map<string, { v: string; blob: Blob; url?: string }>();
function remember(name: string, v: string, blob: Blob): Blob {
  const m = mem.get(name);
  if (m && m.v === v) return m.blob;
  if (m?.url) URL.revokeObjectURL(m.url);
  mem.set(name, { v, blob });
  return blob;
}
/** Nội dung nhiều tệp: trên máy có đúng bản thì lấy ngay, còn lại tải 1 lần (theo lô) rồi nhớ. Không có / không có quyền: null. */
export async function getBlobs(names: string[], known?: Map<string, string>): Promise<Map<string, Blob | null>> {
  const want = [...new Set(names.filter(Boolean))];
  const out = new Map<string, Blob | null>();
  if (!want.length) return out;
  const ver = known ?? await metas(want);
  const miss: string[] = [];
  await Promise.all(want.map(async (n) => {
    const v = ver.get(n);
    if (!v) { out.set(n, null); return; }
    const m = mem.get(n);
    if (m && m.v === v) { out.set(n, m.blob); return; }
    const c = await cacheGet(n);
    if (c && c.v === v) out.set(n, remember(n, v, c.blob)); else miss.push(n);
  }));
  for (let i = 0; i < miss.length; i += 10) {
    const part = miss.slice(i, i + 10);
    const r = await tep<{ files: { name: string; mime?: string; data?: string; error?: string }[] }>({ action: 'get_many', names: part }).catch(() => ({ files: [] }));
    for (const n of part) {
      const f = r.files.find((x) => x.name === n);
      if (!f?.data) { out.set(n, null); continue; }
      const blob = remember(n, ver.get(n)!, b64ToBlob(f.data, f.mime || 'application/octet-stream'));
      out.set(n, blob);
      void cacheSet(n, { v: ver.get(n)!, type: blob.type, blob });
    }
  }
  return out;
}
export function getBlob(name: string): Promise<Blob | null> {
  let p = pending.get(name);
  if (!p) {
    p = getBlobs([name]).then((m) => m.get(name) ?? null).finally(() => pending.delete(name));
    pending.set(name, p);
  }
  return p;
}

/** Địa chỉ xem tệp trên máy (blob:). */
export function blobUrl(name: string, blob: Blob): string {
  const m = mem.get(name);
  if (m && m.blob === blob) return (m.url ??= URL.createObjectURL(blob));
  return URL.createObjectURL(blob);
}
export async function fileUrl(name: string): Promise<string | null> {
  const b = await getBlob(name);
  return b ? blobUrl(name, b) : null;
}

// ------------------------------------------------------------------ ghi
export async function putFile(name: string, blob: Blob, mime: string): Promise<void> {
  await tep({ action: 'put', name, mime, data: await toB64(blob) });
  await cacheSet(name, null);
  mem.delete(name);
}
export async function delFile(name: string): Promise<void> {
  await tep({ action: 'del', name });
  await cacheSet(name, null);
  mem.delete(name);
}

/** Chủ nhà xe: chuyển dần tệp còn ở kho cũ lên Google Drive (chạy nền, lỗi thì lần mở app sau làm tiếp). */
let moving = false;
export async function moveOldFiles(): Promise<void> {
  if (moving) return;
  moving = true;
  let errs = 0, zero = 0;
  try {
    for (let i = 0; i < 300 && errs < 5; i++) {
      try {
        const r = await tep<{ moved: number; left: number; tried?: number }>({ action: 'chuyen' });
        errs = 0;
        if (r.left <= 0 || !r.tried) return;   // hết tệp (hoặc nhà xe chưa kết nối Drive)
        zero = r.moved ? 0 : zero + 1;
        if (zero >= 3) return;                 // còn lại toàn tệp chưa chuyển được: để lần mở app sau
      } catch {
        errs++;   // mạng chập chờn / Drive bận: nghỉ rồi thử tiếp; lỗi liền 5 lần thì để lần mở app sau
        await new Promise((r) => setTimeout(r, 5000 * errs));
      }
    }
  } finally { moving = false; }
}
