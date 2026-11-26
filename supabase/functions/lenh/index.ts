// Edge Function: lưu lệnh vận chuyển đã đóng dấu bằng mã QR in trên lệnh (lái xe mở Zalo quét mã, không cần đăng nhập).
// - info: thông tin lệnh (số lệnh, xe, tuyến, giờ các lượt, số dấu bến xe cần có) — không có thông tin cá nhân.
// - upload: AI đọc ảnh lệnh → đúng số lệnh + có dấu mộc bến xe ở cả lượt đi và lượt về (tối thiểu 2 dấu) mới lưu vào hồ sơ Google Drive;
//   chưa đủ dấu thì báo kiểm tra lại, không lưu. Mỗi lệnh tối đa 15 lần thử / ngày, chỉ trong 30 ngày sau hạn lệnh.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { parseProviders, readDocument, ReaderError } from '../_shared/doc_reader.ts';
import { LENH_DAU } from '../_shared/scan_defs.ts';
import { docName, docPath, safeName, type DocRead, type RouteRow } from '../_shared/scan_rules.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_B64 = 14_000_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
/** so số lệnh: bỏ dấu cách, chữ hoa, đổi O→0 hay nhầm */
const norm = (s: string) => s.toUpperCase().replace(/\s+/g, '').replace(/O/g, '0');

interface Info {
  order_id: string; tenant_id: string; trip_id: string; order_no: string; valid_from: string; valid_to: string; expired: boolean;
  plate: string | null; route: string | null; legs: { seq: number; time: string | null; date: string | null }[]; required: number;
  driver_user: string | null; saved: boolean;
}

async function gas(cfg: { url: string; key: string }, body: Record<string, unknown>, ms = 180000): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, key: cfg.key }), signal: ac.signal });
    const j = JSON.parse(await r.text()) as Record<string, unknown>;
    if (!j.ok) throw new HttpError(502, `Google Drive: ${String(j.description ?? 'lỗi không rõ')}`);
    return j;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'Chưa lưu được vào Google Drive của nhà xe, thử lại sau');
  } finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const token = typeof b.token === 'string' ? b.token : '';
    if (!/^[0-9a-f]{32}$/.test(token)) throw new HttpError(404, 'Mã lệnh không đúng');
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const r0 = await admin.rpc('svc_lenh_by_token', { p_token: token });
    const o = r0.data as Info | null;
    if (r0.error || !o) throw new HttpError(404, 'Không tìm thấy lệnh');
    const pub = { order_no: o.order_no, valid_from: o.valid_from, valid_to: o.valid_to, plate: o.plate, route: o.route, legs: o.legs, required: o.required, saved: o.saved, expired: o.expired };
    if (b.action === 'info') return json(200, pub);
    if (b.action !== 'upload') throw new HttpError(400, 'Không rõ yêu cầu');
    if (o.expired) throw new HttpError(410, 'Lệnh đã quá hạn lưu (30 ngày sau ngày hết hiệu lực)');

    const data = typeof b.data === 'string' ? b.data : '', page = typeof b.page === 'string' ? b.page : '';
    if (!data || data.length > MAX_B64) throw new HttpError(413, 'Ảnh trống hoặc lớn hơn 10 MB');
    if (!page || page.length > 4_000_000) throw new HttpError(400, 'Thiếu ảnh lệnh');
    const tr = await admin.rpc('svc_lenh_try', { p_token: token });
    if (!tr.data) throw new HttpError(429, 'Lệnh này đã thử lưu quá 15 lần hôm nay, mai thử lại');

    type LenhRead = DocRead & { so_dau_ben?: number | string | null; dau_luot_di?: number | string | null; dau_luot_ve?: number | string | null };
    let v: LenhRead;
    try {
      v = (await readDocument({ docType: 'lenh_dau', def: LENH_DAU, files: [{ mime: 'image/jpeg', data: page }], providers: parseProviders(Deno.env.get('AI_PROVIDERS')),
        timeoutMs: Number(Deno.env.get('AI_TIMEOUT_MS') ?? 25000) || 25000 })).fields as unknown as LenhRead;
    } catch (e) { throw new HttpError(e instanceof ReaderError ? e.status : 502, `Máy chưa đọc được ảnh lệnh: ${e instanceof Error ? e.message : e}. Chụp lại rõ hơn`); }
    if (!/lệnh/i.test(v.loai ?? '') || !v.lenh_so) throw new HttpError(422, 'Ảnh không phải lệnh vận chuyển hoặc không đọc được số lệnh. Chụp thẳng, đủ cả tờ lệnh');
    const core = norm(o.order_no.split('/')[0] ?? o.order_no);
    if (!norm(v.lenh_so).includes(core)) throw new HttpError(422, `Ảnh là lệnh khác (đọc được số ${v.lenh_so}), không phải lệnh ${o.order_no}`);
    // Đủ lượt đi + lượt về: mỗi lượt có ít nhất 1 dấu mộc bến xe (tổng tối thiểu 2 dấu)
    const di = Number(v.dau_luot_di ?? 0) || 0, ve = Number(v.dau_luot_ve ?? 0) || 0;
    const stamps = Math.max(Number(v.so_dau_ben ?? 0) || 0, di + ve);
    if (di < 1 || ve < 1 || stamps < o.required) {
      const thieu = [di < 1 && 'lượt đi', ve < 1 && 'lượt về'].filter(Boolean).join(' và ');
      return json(422, { error: `Chưa đủ dấu bến xe${thieu ? `: chưa thấy dấu ở ${thieu}` : ''}. Kiểm tra lại cột Bến xe trên lệnh (lượt đi và lượt về đều phải có dấu) rồi chụp lại`, stamps, required: o.required });
    }

    const [c, st, rt] = await Promise.all([
      admin.from('tenant_drive').select('url, key').eq('tenant_id', o.tenant_id).maybeSingle(),
      admin.from('tenant_settings').select('value').eq('tenant_id', o.tenant_id).eq('key', 'lenh.hau_to').maybeSingle(),
      admin.from('routes').select('name, registered_code').eq('tenant_id', o.tenant_id),
    ]);
    if (!c.data) throw new HttpError(409, 'Nhà xe chưa kết nối Google Drive, báo văn phòng');
    const suffix = typeof st.data?.value === 'string' ? st.data.value : '';
    const read: DocRead = { ...v, lenh_so: o.order_no, ngay_xuat: v.ngay_xuat || o.valid_from };
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const name = docName(read, suffix), path = docPath(read, (rt.data ?? []) as RouteRow[], today)!;
    const mime = String(b.mime ?? '') === 'application/pdf' ? 'application/pdf' : 'image/jpeg';
    const fileName = `${safeName(name)}.${mime === 'application/pdf' ? 'pdf' : 'jpg'}`;
    const r = await gas(c.data as { url: string; key: string }, { action: 'hs_put', path, name: fileName, mime, data });
    const sv = await admin.rpc('svc_save_order_scan', { p_tenant: o.tenant_id, p_user: o.driver_user, p_path: path, p_name: name, p_file_name: fileName, p_mime: mime,
      p_drive_id: String(r.id), p_drive_url: String(r.url ?? ''), p_size: Number(r.size ?? 0) || null, p_trip: o.trip_id, p_order_no: o.order_no, p_route: path[3] ?? null });
    if (sv.error) { await gas(c.data as { url: string; key: string }, { action: 'hs_del', id: r.id }).catch(() => undefined); throw new HttpError(400, sv.error.message); }
    return json(200, { ok: true, stamps, required: o.required, path: path.join(' / ') });
  } catch (e) {
    const st = e instanceof HttpError ? e.status : 500;
    if (st === 500) console.error('lenh', e);
    return json(st, { error: e instanceof Error && st !== 500 ? e.message : 'Máy chủ đang lỗi, thử lại sau' });
  }
});
