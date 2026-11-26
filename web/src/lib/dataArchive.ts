// Chuyển dữ liệu cũ (cũ hơn 12 tháng) sang Google Drive của nhà xe – chỉ Chủ nhà xe.
// Bước 1: xem trước số dòng, xuất các trang dữ liệu có chữ ký của máy chủ, nén, đẩy lên Drive, tải lại từ Drive để đối chiếu.
import { drive } from './drive';
import { gzip } from './backup';
import { rpc } from './supabase';

export interface ArchivePage { t: string; rows: string; sig: string }
export interface ArchiveFile { format: 'tms-du-lieu-cu'; v: 1; from: string; to: string; created_at: string; pages: ArchivePage[] }
export const ARCHIVE_TABLES: [string, string][] = [
  ['seat_inventory', 'Vé, giữ ghế'], ['transfer_items', 'Lượt trung chuyển của vé'], ['notifications', 'Thông báo'],
  ['notification_delivery_logs', 'Nhật ký gửi thông báo'], ['zalo_messages', 'Tin Zalo'], ['audit_logs', 'Nhật ký thao tác'],
];
const PAGE = 2000;
interface PageOut { rows: string; sig: string; last: string | null; n: number }

export const archivePreview = (from: string, to: string) => rpc<Record<string, number>>('archive_preview', { p_from: from, p_to: to });

async function exportRange(from: string, to: string, step: (s: string) => void): Promise<{ file: ArchiveFile; rows: number }> {
  const pages: ArchivePage[] = [];
  let rows = 0;
  for (const [i, [t, label]] of ARCHIVE_TABLES.entries()) {
    let after: string | null = null;
    for (;;) {
      const p: PageOut = await rpc<PageOut>('archive_page', { p_table: t, p_from: from, p_to: to, p_after: after, p_limit: PAGE });
      if (!p.n) break;
      pages.push({ t, rows: p.rows, sig: p.sig });
      rows += p.n;
      step(`Đang đọc ${label.toLowerCase()} (${i + 1}/${ARCHIVE_TABLES.length}) · ${rows.toLocaleString('vi-VN')} dòng`);
      if (p.n < PAGE || !p.last) break;
      after = p.last;
    }
  }
  return { file: { format: 'tms-du-lieu-cu', v: 1, from, to, created_at: new Date().toISOString(), pages }, rows };
}

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (u: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Sao lưu khoảng ngày lên Drive rồi tải lại từ Drive để đối chiếu từng byte. Chưa xóa gì trong database. */
export async function archiveToDrive(from: string, to: string, step: (s: string) => void): Promise<{ id: string; rows: number; size: number }> {
  const { file, rows } = await exportRange(from, to, step);
  if (!rows) throw new Error('Khoảng ngày này không có dữ liệu để chuyển');
  step('Đang nén dữ liệu…');
  const gz = await gzip(JSON.stringify(file));
  const mine = await sha256(gz);
  step('Đang đẩy lên Google Drive…');
  const up = await drive<{ id: string; sha256: string }>({ action: 'archive_put', from, to, data: b64(gz) });
  if (up.sha256 !== mine) throw new Error('Drive nhận file không khớp, chưa được chuyển. Hãy thử lại');
  step('Đang tải lại từ Google Drive để đối chiếu…');
  await verifyArchive(up.id, mine);
  return { id: up.id, rows, size: gz.length };
}

/** Tải bản đã chuyển từ Drive, so mã kiểm tra (SHA-256) với lúc đẩy lên */
export async function verifyArchive(id: string, sha: string): Promise<Uint8Array> {
  const r = await drive<{ data: string }>({ action: 'archive_get', id });
  const u = unb64(r.data);
  if ((await sha256(u)) !== sha) throw new Error('File trên Google Drive không khớp với bản đã sao lưu');
  return u;
}
