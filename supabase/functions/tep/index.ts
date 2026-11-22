// Edge Function: tệp của nhà xe (ảnh giấy tờ, chữ ký, con dấu, logo, ảnh đại diện, ảnh báo dầu, PDF…) lưu trên Google Drive như app cũ.
// Database chỉ giữ tên tệp → mã Drive (bảng file_store). Quyền: đúng quy tắc của bảng file_store (RLS, theo phiên đăng nhập).
//   get      {name}              → {mime, data}            xem 1 tệp
//   get_many {names[]}           → {files: [{name, mime, data} | {name, error}]}
//   put      {name, mime, data}  → {ok}                    tải lên / thay tệp cùng tên
//   del      {name}              → {ok}                    bỏ tệp
//   chuyen   {}                  → {moved, left}           Chủ nhà xe: chuyển tệp còn ở kho cũ lên Drive (đủ dung lượng mới xóa bản cũ)
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { BUCKET, driveCfg, driveDir, fileBase, FileError, gas, readFile, unb64, b64, type DriveCfg } from '../_shared/file_store.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_B64 = 14_000_000;   // ~10 MB
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z_]+\/[^\\]{1,400}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const checkName = (n: unknown): string => {
  const s = typeof n === 'string' ? n : '';
  if (!NAME.test(s) || s.includes('..')) throw new FileError(400, 'Tên tệp không hợp lệ');
  return s;
};
interface Row { name: string; drive_id: string | null; mime: string | null; size_bytes: number | null }

/** Chuyển 1 tệp từ kho cũ lên Drive: lên Drive đủ dung lượng mới ghi mã Drive rồi xóa bản cũ. */
async function moveOne(admin: SupabaseClient, cfg: DriveCfg, tid: string, row: Row): Promise<boolean> {
  const { data, error } = await admin.storage.from(BUCKET).download(row.name);
  if (error || !data) return false;
  const bytes = new Uint8Array(await data.arrayBuffer());
  const mime = data.type || row.mime || 'application/octet-stream';
  const r = await gas(cfg, { action: 'hs_put', path: driveDir(row.name), name: fileBase(row.name), mime, data: b64(bytes) }, 180000);
  const id = String(r.id ?? ''), size = Number(r.size ?? -1);
  if (!id || size !== bytes.length) {
    if (id) await gas(cfg, { action: 'hs_del', id }).catch(() => undefined);
    return false;
  }
  const up = await admin.from('file_store').update({ drive_id: id, mime, size_bytes: bytes.length })
    .eq('tenant_id', tid).eq('name', row.name).is('drive_id', null).select('name');
  if (up.error || !up.data?.length) { await gas(cfg, { action: 'hs_del', id }).catch(() => undefined); return false; }
  await admin.storage.from(BUCKET).remove([row.name]);
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new FileError(401, 'Chưa đăng nhập');
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const t = await user.rpc('my_tenant_id');
    if (t.error || !t.data) throw new FileError(403, 'Không xác định được nhà xe');
    const tid = String(t.data);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    let cfg: DriveCfg | null | undefined;
    const getCfg = async () => (cfg === undefined ? (cfg = await driveCfg(admin, tid)) : cfg);
    // Dòng tệp người dùng được xem (RLS)
    const see = async (names: string[]) => {
      const r = await user.from('file_store').select('name, drive_id, mime, size_bytes').in('name', names);
      if (r.error) throw new FileError(403, 'Không đọc được tệp');
      return (r.data ?? []) as Row[];
    };

    if (b.action === 'get') {
      const name = checkName(b.name);
      const row = (await see([name]))[0];
      if (!row) throw new FileError(404, 'Không tìm thấy tệp');
      return json(200, await readFile(admin, row.drive_id ? await getCfg() : null, row));
    }

    if (b.action === 'get_many') {
      const names = (Array.isArray(b.names) ? b.names : []).map(checkName);
      if (!names.length || names.length > 20) throw new FileError(400, 'Mỗi lần 1–20 tệp');
      const rows = await see(names);
      if (rows.some((r) => r.drive_id)) await getCfg();
      const files = [];
      for (let i = 0; i < names.length; i += 5) {
        files.push(...await Promise.all(names.slice(i, i + 5).map(async (n) => {
          const row = rows.find((r) => r.name === n);
          if (!row) return { name: n, error: 'Không tìm thấy tệp' };
          try { return { name: n, ...await readFile(admin, cfg ?? null, row) }; } catch (e) { return { name: n, error: (e as Error).message }; }
        })));
      }
      return json(200, { files });
    }

    if (b.action === 'put') {
      const name = checkName(b.name);
      if (!name.startsWith(`${tid}/`)) throw new FileError(403, 'Không có quyền');
      const data = typeof b.data === 'string' ? b.data : '';
      if (!data || data.length > MAX_B64) throw new FileError(413, 'Tệp trống hoặc lớn hơn 10 MB');
      const mime = String(b.mime ?? 'application/octet-stream').slice(0, 100);
      const bytes = unb64(data);
      const old = (await admin.from('file_store').select('name, drive_id, mime, size_bytes').eq('tenant_id', tid).eq('name', name).maybeSingle()).data as Row | null;
      const c = await getCfg();
      if (c) {
        const r = await gas(c, { action: 'hs_put', path: driveDir(name), name: fileBase(name), mime, data }, 180000);
        const id = String(r.id ?? '');
        if (!id) throw new FileError(502, 'Google Drive chưa nhận tệp');
        // Ghi bằng phiên người dùng: không có quyền thì bỏ tệp vừa lên Drive
        const w = await user.from('file_store').upsert({ tenant_id: tid, name, drive_id: id, mime, size_bytes: bytes.length, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id,name' });
        if (w.error) { await gas(c, { action: 'hs_del', id }).catch(() => undefined); throw new FileError(403, 'Không có quyền lưu tệp này'); }
        if (old?.drive_id && old.drive_id !== id) await gas(c, { action: 'hs_del', id: old.drive_id }).catch(() => undefined);
        if (old && !old.drive_id) await admin.storage.from(BUCKET).remove([name]);
      } else {
        // Chưa kết nối Drive: tạm để ở kho cũ (kết nối Drive xong tự chuyển)
        const w = await user.from('file_store').upsert({ tenant_id: tid, name, drive_id: null, mime, size_bytes: bytes.length, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id,name' });
        if (w.error) throw new FileError(403, 'Không có quyền lưu tệp này');
        const up = await admin.storage.from(BUCKET).upload(name, new Blob([bytes as BlobPart], { type: mime }), { contentType: mime, upsert: true });
        if (up.error) {
          if (!old) await admin.from('file_store').delete().eq('tenant_id', tid).eq('name', name);
          throw new FileError(502, `Không lưu được tệp: ${up.error.message}`);
        }
      }
      return json(200, { ok: true });
    }

    if (b.action === 'del') {
      const name = checkName(b.name);
      const d = await user.from('file_store').delete().eq('name', name).select('name, drive_id');
      if (d.error) throw new FileError(403, 'Không có quyền bỏ tệp này');
      const row = (d.data ?? [])[0] as Row | undefined;
      if (!row) throw new FileError(404, 'Không tìm thấy tệp');
      if (row.drive_id) { const c = await getCfg(); if (c) await gas(c, { action: 'hs_del', id: row.drive_id }).catch(() => undefined); }
      else await admin.storage.from(BUCKET).remove([name]);
      return json(200, { ok: true });
    }

    if (b.action === 'chuyen') {
      const P = await user.rpc('my_permissions');
      if (!((P.data ?? []) as { permission_code: string }[]).some((p) => p.permission_code === 'settings.edit')) throw new FileError(403, 'Không có quyền');
      const c = await getCfg();
      if (!c) return json(200, { moved: 0, left: -1 });
      await admin.rpc('svc_file_backfill', { p_tenant: tid });   // tệp do app bản cũ tải thẳng lên kho cũ
      const rows = ((await admin.from('file_store').select('name, drive_id, mime, size_bytes, move_fail').eq('tenant_id', tid).is('drive_id', null)
        .order('move_fail').order('size_bytes', { ascending: true, nullsFirst: true }).limit(8)).data ?? []) as (Row & { move_fail?: number })[];
      let moved = 0;
      const t0 = Date.now();
      for (const r of rows) {
        if (Date.now() - t0 > 90_000) break;
        if (await moveOne(admin, c, tid, r).catch(() => false)) moved++;
        else await admin.from('file_store').update({ move_fail: (r.move_fail ?? 0) + 1 }).eq('tenant_id', tid).eq('name', r.name);
      }
      const left = (await admin.from('file_store').select('name', { count: 'exact', head: true }).eq('tenant_id', tid).is('drive_id', null)).count ?? 0;
      return json(200, { moved, left, tried: rows.length });
    }

    throw new FileError(400, 'Lệnh không hợp lệ');
  } catch (e) {
    return json(e instanceof FileError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) });
  }
});
