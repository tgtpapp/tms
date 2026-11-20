// Sao lưu / khôi phục dữ liệu nhà xe (Chủ nhà xe). File .json.gz gồm các trang dữ liệu có chữ ký của máy chủ:
// không sửa tay được, không khôi phục sang nhà xe khác. Khôi phục chỉ thêm dòng đang thiếu, không ghi đè, không xóa.
import { drive } from './drive';
import { rpc } from './supabase';

export interface BackupPage { t: string; rows: string; sig: string }
export interface BackupFile { format: 'tms-sao-luu'; v: 1; tenant: string; created_at: string; pages: BackupPage[] }
type Step = (msg: string) => void;
interface Tbl { tbl: string; ord: number; restore: boolean }

const PAGE = 2000;

/** Đọc toàn bộ dữ liệu nhà xe theo trang */
export async function exportTenant(tenant: string, step: Step): Promise<{ file: BackupFile; rows: number }> {
  const tables = await rpc<Tbl[]>('backup_tables', {});
  const pages: BackupPage[] = [];
  let rows = 0;
  for (const [i, t] of tables.entries()) {
    let after: string | null = null;
    for (;;) {
      const p = await rpc<{ rows: string; sig: string; last: string | null; n: number }>('backup_page', { p_table: t.tbl, p_after: after, p_limit: PAGE });
      if (!p.n) break;
      pages.push({ t: t.tbl, rows: p.rows, sig: p.sig });
      rows += p.n;
      step(`Đang đọc dữ liệu ${i + 1}/${tables.length} bảng · ${rows.toLocaleString('vi-VN')} dòng`);
      if (p.n < PAGE || !p.last) break;
      after = p.last;
    }
  }
  return { file: { format: 'tms-sao-luu', v: 1, tenant, created_at: new Date().toISOString(), pages }, rows };
}

async function pipe(data: BlobPart, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const gzip = (text: string) => pipe(new TextEncoder().encode(text) as BlobPart, new CompressionStream('gzip'));

/** Đọc file sao lưu (.json.gz hoặc .json) */
export async function readBackup(bytes: Uint8Array): Promise<BackupFile> {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await pipe(bytes as BlobPart, new DecompressionStream('gzip')) : bytes;
  let f: BackupFile;
  try { f = JSON.parse(new TextDecoder().decode(raw)) as BackupFile; } catch { throw new Error('File không đọc được (không phải file sao lưu của app)'); }
  if (f?.format !== 'tms-sao-luu' || !Array.isArray(f.pages)) throw new Error('Không phải file sao lưu của app này');
  return f;
}

/** Tải bản sao lưu đêm từ Google Drive của nhà xe */
export async function fetchDriveBackup(id: string): Promise<Uint8Array> {
  const r = await drive<{ data: string }>({ action: 'backup_get', id });
  const bin = atob(r.data), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Khôi phục: chỉ thêm dòng thiếu, bảng cha trước; dòng lỗi (thiếu dòng cha) thử lại thêm 1 lượt cuối */
export async function restoreTenant(f: BackupFile, step: Step): Promise<{ added: number; failed: number; pages: number }> {
  const tables = await rpc<Tbl[]>('backup_tables', {});
  const ord = new Map(tables.map((t) => [t.tbl, t]));
  const list = f.pages.filter((p) => ord.get(p.t)?.restore).sort((a, b) => ord.get(a.t)!.ord - ord.get(b.t)!.ord);
  let added = 0, failed = 0;
  const again: BackupPage[] = [];
  for (const [i, p] of list.entries()) {
    const r = await rpc<{ added: number; failed: number }>('restore_page', { p_table: p.t, p_rows: p.rows, p_sig: p.sig });
    added += r.added;
    if (r.failed) again.push(p);
    step(`Đang khôi phục ${i + 1}/${list.length} phần · đã thêm ${added.toLocaleString('vi-VN')} dòng`);
  }
  for (const p of again) {
    const r = await rpc<{ added: number; failed: number }>('restore_page', { p_table: p.t, p_rows: p.rows, p_sig: p.sig });
    added += r.added; failed += r.failed;
  }
  return { added, failed, pages: list.length };
}
