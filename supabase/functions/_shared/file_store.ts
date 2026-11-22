// Tệp của nhà xe (bảng file_store): đọc từ Google Drive của nhà xe (qua Apps Script, như app cũ) hoặc kho cũ khi chưa chuyển lên Drive.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const BUCKET = 'giay-to';
export class FileError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export interface DriveCfg { url: string; key: string }

export async function gas(cfg: DriveCfg, body: Record<string, unknown>, ms = 120000): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  let r: Response;
  try {
    r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, key: cfg.key }), signal: ac.signal });
  } catch (e) {
    throw new FileError(504, (e as Error).name === 'AbortError' ? 'Google Drive phản hồi quá lâu' : 'Không kết nối được Google Drive');
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { throw new FileError(502, 'Google Drive (Apps Script) trả về không đúng'); }
  if (!j.ok) throw new FileError(502, `Google Drive: ${String(j.description ?? 'lỗi không rõ')}`);
  return j;
}

export async function driveCfg(admin: SupabaseClient, tenantId: string): Promise<DriveCfg | null> {
  const c = await admin.from('tenant_drive').select('url, key').eq('tenant_id', tenantId).maybeSingle();
  return (c.data as DriveCfg | null) ?? null;
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Nội dung 1 tệp (base64). row: dòng file_store đã được kiểm quyền. */
export async function readFile(admin: SupabaseClient, cfg: DriveCfg | null, row: { name: string; drive_id: string | null; mime: string | null }): Promise<{ mime: string; data: string }> {
  if (row.drive_id) {
    if (!cfg) throw new FileError(409, 'Nhà xe chưa kết nối Google Drive');
    const r = await gas(cfg, { action: 'hs_get', id: row.drive_id }, 120000);
    return { mime: String(r.mime ?? row.mime ?? 'application/octet-stream'), data: String(r.data ?? '') };
  }
  const { data, error } = await admin.storage.from(BUCKET).download(row.name);
  if (error || !data) throw new FileError(404, 'Không tìm thấy tệp');
  return { mime: data.type || row.mime || 'application/octet-stream', data: b64(new Uint8Array(await data.arrayBuffer())) };
}

/** Thư mục trên Drive: _Anh he thong / <loại> (như app cũ). */
export const driveDir = (name: string) => ['_Anh he thong', name.split('/')[1] || 'khac'];
export const fileBase = (name: string) => name.split('/').pop() || 'tep';
