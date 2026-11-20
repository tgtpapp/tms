// Edge Function: Lưu trữ hồ sơ trên Google Drive của nhà xe qua Apps Script (giống app cũ).
// - Địa chỉ Web app + mã kết nối của nhà xe đọc ở bảng tenant_drive bằng service_role (trình duyệt không thấy mã).
// - Quyền: ping (settings.view / archive.add / archive.edit), get (archive.view), put (archive.add; thay bản mới: archive.edit hoặc .add), del / del_folder (archive.delete).
// - Dữ liệu hồ sơ ghi bằng phiên đăng nhập của người dùng (RLS nhà xe + quyền áp dụng như thường).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_B64 = 14_000_000;   // ~10 MB tệp gốc

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

async function gas(cfg: { url: string; key: string }, body: Record<string, unknown>, ms = 120000): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  let r: Response;
  try {
    r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, key: cfg.key }), signal: ac.signal });
  } catch (e) {
    throw new HttpError(504, (e as Error).name === 'AbortError' ? 'Google Drive phản hồi quá lâu' : 'Không kết nối được Apps Script');
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { throw new HttpError(502, 'Apps Script trả về không đúng. Kiểm tra địa chỉ Web app và quyền truy cập "Bất kỳ ai"'); }
  if (!j.ok) {
    const d = String(j.description ?? 'lỗi không rõ');
    if (/sai mã kết nối/i.test(d)) {
      throw new HttpError(401, 'Sai mã kết nối: mã đã lưu ở TMS khác dòng MA_KET_NOI trong Apps Script. Kiểm tra lại mã (bấm "Hiện" để xem), '
        + 'nếu vừa sửa MA_KET_NOI thì phải Triển khai → Quản lý bản triển khai → bút chì → Phiên bản: Phiên bản mới → Triển khai.');
    }
    throw new HttpError(502, `Apps Script: ${d}`);
  }
  return j;
}

async function perms(user: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await user.rpc('my_permissions');
  if (error) throw new HttpError(401, 'Phiên đăng nhập không hợp lệ');
  return new Set(((data ?? []) as { permission_code: string }[]).map((p) => p.permission_code));
}

interface Folder { id: string; parent_id: string | null; name: string }
const pathOf = (all: Folder[], id: string | null) => {
  const out: string[] = [];
  let cur = all.find((f) => f.id === id);
  for (let g = 0; cur && g < 60; g++) { out.unshift(cur.name); cur = all.find((f) => f.id === cur!.parent_id); }
  return out;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'Chưa đăng nhập');
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const P = await perms(user);
    const t = await user.rpc('my_tenant_id');
    if (t.error || !t.data) throw new HttpError(403, 'Không xác định được nhà xe');
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const c = await admin.from('tenant_drive').select('url, key').eq('tenant_id', t.data).maybeSingle();
    if (!c.data) throw new HttpError(409, 'Nhà xe chưa kết nối Google Drive. Vào Cấu hình → Kho hồ sơ Google Drive');
    const cfg = c.data as { url: string; key: string };
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const need = (p: string[]) => { if (!p.some((x) => P.has(x))) throw new HttpError(403, 'Không có quyền'); };

    if (b.action === 'ping') {
      need(['settings.view', 'archive.add', 'archive.edit']);
      return json(200, await gas(cfg, { action: 'ping' }, 30000));
    }

    if (b.action === 'get') {
      need(['archive.view']);
      const it = await user.from('archive_items').select('drive_id, file_name, name').eq('id', String(b.id ?? '')).maybeSingle();
      if (!it.data?.drive_id) throw new HttpError(404, 'Không tìm thấy hồ sơ');
      const r = await gas(cfg, { action: 'hs_get', id: it.data.drive_id });
      return json(200, { name: r.name ?? it.data.file_name ?? it.data.name, mime: r.mime, data: r.data });
    }

    if (b.action === 'put') {
      need(b.replace_id ? ['archive.edit', 'archive.add'] : ['archive.add']);
      const data = typeof b.data === 'string' ? b.data : '';
      if (!data || data.length > MAX_B64) throw new HttpError(413, 'Tệp trống hoặc lớn hơn 10 MB. Tệp lớn hãy thêm bằng "Liên kết"');
      const folderId = (b.folder_id as string | null) || null;
      const all = await user.from('archive_folders').select('id, parent_id, name');
      if (all.error) throw new HttpError(403, 'Không đọc được thư mục');
      if (folderId && !(all.data ?? []).some((f) => f.id === folderId)) throw new HttpError(404, 'Không tìm thấy thư mục');
      const fileName = String(b.file_name ?? 'tep').slice(0, 200);
      const r = await gas(cfg, { action: 'hs_put', path: pathOf((all.data ?? []) as Folder[], folderId), name: fileName, mime: String(b.mime ?? 'application/octet-stream'), data }, 180000);
      const row = {
        folder_id: folderId, kind: 'file', name: String(b.name ?? fileName).slice(0, 300), drive_id: String(r.id), drive_url: String(r.url ?? ''),
        file_name: fileName, mime: String(b.mime ?? ''), size_bytes: Number(r.size ?? 0) || null,
        expires_on: (b.expires_on as string) || null, note: (b.note as string) || null,
      };
      const ins = await user.from('archive_items').insert(row).select('id').single();
      if (ins.error) { await gas(cfg, { action: 'hs_del', id: r.id }).catch(() => undefined); throw new HttpError(400, ins.error.message); }
      if (b.replace_id) await user.from('archive_items').update({ is_old: true, replaced_by: ins.data.id }).eq('id', String(b.replace_id));
      return json(200, { id: ins.data.id });
    }

    if (b.action === 'del') {
      need(['archive.delete']);
      const it = await user.from('archive_items').select('id, drive_id').eq('id', String(b.id ?? '')).maybeSingle();
      if (!it.data) throw new HttpError(404, 'Không tìm thấy hồ sơ');
      if (it.data.drive_id) await gas(cfg, { action: 'hs_del', id: it.data.drive_id }).catch(() => undefined);   // tệp đã mất trên Drive vẫn xóa được hồ sơ
      const d = await user.from('archive_items').delete().eq('id', it.data.id);
      if (d.error) throw new HttpError(400, d.error.message);
      return json(200, { ok: true });
    }

    if (b.action === 'del_folder') {
      need(['archive.delete']);
      const all = await user.from('archive_folders').select('id, parent_id, name');
      const list = (all.data ?? []) as Folder[];
      const root = String(b.id ?? '');
      if (!list.some((f) => f.id === root)) throw new HttpError(404, 'Không tìm thấy thư mục');
      const ids = new Set([root]);
      for (let ch = true; ch;) { ch = false; for (const f of list) if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); ch = true; } }
      const items = await user.from('archive_items').select('drive_id').in('folder_id', [...ids]).not('drive_id', 'is', null);
      const driveIds = (items.data ?? []).map((x) => String(x.drive_id));
      // Xóa trong app trước (nhanh, người dùng thấy ngay); tệp trên Drive cho vào thùng rác sau, chạy song song,
      // không bắt chờ từng tệp một (thư mục nhiều tệp trước đây chờ quá lâu, hết giờ, như không xóa được).
      const d = await user.from('archive_folders').delete().eq('id', root);
      if (d.error) throw new HttpError(400, d.error.message);
      const trash = async () => {
        for (let i = 0; i < driveIds.length; i += 6) {
          await Promise.all(driveIds.slice(i, i + 6).map((id) => gas(cfg, { action: 'hs_del', id }, 60000).catch(() => undefined)));
        }
      };
      const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(trash()); else await trash();
      return json(200, { ok: true, files: driveIds.length });
    }

    throw new HttpError(400, 'Thao tác không hợp lệ');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Lỗi máy chủ Drive' });
  }
});
