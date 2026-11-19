// Edge Function: kết nối Zalo OA + gửi tin ZNS.
// - POST {action:'connect', return_url}  (phiên đăng nhập, quyền settings.manage) → trả link cấp quyền Zalo.
// - GET  ?code=&state=&oa_id=            (Zalo chuyển về sau khi chủ OA đồng ý) → lưu mã truy cập, quay lại app.
// - POST {action:'flush'}                (bất kỳ người dùng của nhà xe) → gửi các tin đang chờ của nhà xe đó.
// Secret (đặt trên Supabase, không trong code): ZALO_APP_ID, ZALO_APP_SECRET; tùy chọn ZALO_REDIRECT_URI.
// Mã truy cập Zalo chỉ đọc / ghi bằng service_role, không bao giờ trả về trình duyệt.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { authorizeUrl, exchangeCode, isTokenError, oaInfo, pkceChallenge, randomToken, refreshTokens, sendZns, ZaloError } from '../_shared/zalo.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP_ID = Deno.env.get('ZALO_APP_ID') ?? '';
const APP_SECRET = Deno.env.get('ZALO_APP_SECRET') ?? '';
const REDIRECT_URI = Deno.env.get('ZALO_REDIRECT_URI') || `${SUPABASE_URL}/functions/v1/zalo`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const fmtTime = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
const fmtMoney = (n: number) => n.toLocaleString('vi-VN');

function safeReturnUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return u.toString();
  } catch { /* sai định dạng */ }
  return null;
}

// ---------------------------------------------------------------- Kết nối
async function connect(userClient: SupabaseClient, userId: string, returnUrl: string) {
  if (!APP_ID || !APP_SECRET) throw new ZaloError(503, 'Nền tảng chưa cấu hình ứng dụng Zalo (ZALO_APP_ID, ZALO_APP_SECRET)');
  const st = await userClient.rpc('zalo_status');
  if (st.error) throw new ZaloError(403, 'Không có quyền cấu hình Zalo');
  const tenant = await userClient.rpc('my_tenant_id');
  if (tenant.error || !tenant.data) throw new ZaloError(403, 'Không xác định được nhà xe');
  const state = randomToken(24);
  const verifier = randomToken(32);
  const db = admin();
  await db.from('zalo_oauth_states').delete().lt('created_at', new Date(Date.now() - 15 * 60e3).toISOString());
  const ins = await db.from('zalo_oauth_states').insert({ state, tenant_id: tenant.data, user_id: userId, verifier, return_url: returnUrl });
  if (ins.error) throw new ZaloError(500, 'Không tạo được phiên kết nối');
  return { url: authorizeUrl(APP_ID, REDIRECT_URI, await pkceChallenge(verifier), state), redirect_uri: REDIRECT_URI };
}

async function callback(url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const db = admin();
  const s = await db.from('zalo_oauth_states').select('*').eq('state', state).maybeSingle();
  if (!s.data) return new Response('Phiên kết nối Zalo không hợp lệ hoặc đã hết hạn. Hãy bấm kết nối lại trong app.', { status: 400 });
  await db.from('zalo_oauth_states').delete().eq('state', state);
  const back = new URL(s.data.return_url as string);
  const go = (result: string) => { back.searchParams.set('zalo', result); return Response.redirect(back.toString(), 302); };
  if (!code || Date.now() - new Date(s.data.created_at as string).getTime() > 15 * 60e3) return go('huy');
  try {
    const t = await exchangeCode(APP_ID, APP_SECRET, code, s.data.verifier as string);
    const info = await oaInfo(t.access_token);
    const up = await db.from('zalo_connections').upsert({
      tenant_id: s.data.tenant_id, oa_id: info?.oa_id || url.searchParams.get('oa_id') || '', oa_name: info?.name ?? null,
      access_token: t.access_token, refresh_token: t.refresh_token, access_expires_at: t.expires_at.toISOString(),
      connected_at: new Date().toISOString(), connected_by: s.data.user_id,
    });
    if (up.error) throw up.error;
    await db.from('audit_logs').insert({ tenant_id: s.data.tenant_id, actor_id: s.data.user_id, action: 'zalo_connect', entity: 'zalo_connections',
      entity_id: String(s.data.tenant_id), detail: { oa_id: info?.oa_id ?? null, oa_name: info?.name ?? null } });
    return go('ok');
  } catch (e) {
    console.error(e);
    return go('loi');
  }
}

// ---------------------------------------------------------------- Gửi tin
interface Conn { tenant_id: string; access_token: string; refresh_token: string; access_expires_at: string }

async function freshToken(db: SupabaseClient, c: Conn, force = false): Promise<string> {
  if (!force && new Date(c.access_expires_at).getTime() - Date.now() > 120e3) return c.access_token;
  try {
    const t = await refreshTokens(APP_ID, APP_SECRET, c.refresh_token);
    await db.from('zalo_connections').update({ access_token: t.access_token, refresh_token: t.refresh_token, access_expires_at: t.expires_at.toISOString() })
      .eq('tenant_id', c.tenant_id);
    Object.assign(c, { access_token: t.access_token, refresh_token: t.refresh_token, access_expires_at: t.expires_at.toISOString() });
    return t.access_token;
  } catch (e) {
    // Có thể lần gửi khác vừa làm mới (mã làm mới chỉ dùng 1 lần) → đọc lại
    const again = await db.from('zalo_connections').select('access_token, refresh_token, access_expires_at').eq('tenant_id', c.tenant_id).maybeSingle();
    if (again.data && again.data.refresh_token !== c.refresh_token) { Object.assign(c, again.data); return again.data.access_token as string; }
    throw e;
  }
}

async function buildData(db: SupabaseClient, tenant: string, kind: string, ref: string): Promise<Record<string, string> | string> {
  if (kind === 've') {
    const b = await db.from('bookings').select('code, customer_name').eq('tenant_id', tenant).eq('id', ref).maybeSingle();
    const seats = await db.from('seat_inventory').select('seat_label, price, trip_id, from_stop_id, pickup_note, passenger_name')
      .eq('tenant_id', tenant).eq('booking_id', ref).in('status', ['dat', 'da_tt']).order('seat_label');
    const list = seats.data ?? [];
    if (!b.data || list.length === 0) return 'Vé không còn hiệu lực';
    const trip = await db.from('trips').select('depart_at, route_id').eq('tenant_id', tenant).eq('id', list[0].trip_id).maybeSingle();
    const route = trip.data ? await db.from('routes').select('name').eq('tenant_id', tenant).eq('id', trip.data.route_id).maybeSingle() : null;
    const stop = await db.from('stops').select('name').eq('tenant_id', tenant).eq('id', list[0].from_stop_id).maybeSingle();
    return {
      ma_ve: String(b.data.code),
      ten_khach: String(b.data.customer_name || list[0].passenger_name || 'Quý khách'),
      tuyen: String(route?.data?.name ?? ''),
      gio_chay: trip.data ? fmtTime(trip.data.depart_at as string) : '',
      ghe: list.map((s) => s.seat_label).join(', '),
      diem_don: String(list[0].pickup_note || stop.data?.name || ''),
      so_tien: fmtMoney(list.reduce((a, s) => a + Number(s.price), 0)),
    };
  }
  const s = await db.from('shipments').select('code, receiver_name, to_stop_id, description, packages, cod_amount, fee, fee_payer, fee_paid_at, status')
    .eq('tenant_id', tenant).eq('id', ref).maybeSingle();
  if (!s.data || s.data.status === 'huy') return 'Đơn hàng không còn hiệu lực';
  const stop = await db.from('stops').select('name').eq('tenant_id', tenant).eq('id', s.data.to_stop_id).maybeSingle();
  const due = Number(s.data.cod_amount) + (s.data.fee_payer === 'nguoi_nhan' && !s.data.fee_paid_at ? Number(s.data.fee) : 0);
  return {
    ma_hang: String(s.data.code),
    ten_nguoi_nhan: String(s.data.receiver_name || 'Quý khách'),
    noi_nhan: String(stop.data?.name ?? ''),
    mo_ta: String(s.data.description),
    so_kien: String(s.data.packages),
    can_thu: fmtMoney(due),
  };
}

async function flush(tenant: string) {
  const db = admin();
  const c = await db.from('zalo_connections').select('tenant_id, access_token, refresh_token, access_expires_at').eq('tenant_id', tenant).maybeSingle();
  if (!c.data) return { sent: 0, failed: 0, connected: false };
  if (!APP_ID || !APP_SECRET) throw new ZaloError(503, 'Nền tảng chưa cấu hình ứng dụng Zalo (ZALO_APP_ID, ZALO_APP_SECRET)');
  const conn = c.data as Conn;
  const tpl = await db.from('zalo_templates').select('kind, template_id, enabled').eq('tenant_id', tenant);
  const tpls = new Map((tpl.data ?? []).filter((t) => t.enabled).map((t) => [t.kind as string, t.template_id as string]));
  const claim = await db.rpc('svc_zalo_claim', { p_tenant: tenant, p_limit: 20 });
  if (claim.error) throw new ZaloError(500, 'Không lấy được tin chờ gửi');
  let sent = 0, failed = 0;
  for (const m of (claim.data ?? []) as { id: string; kind: string; ref_id: string; phone: string; attempts: number }[]) {
    const done = (patch: Record<string, unknown>) => db.from('zalo_messages').update(patch).eq('id', m.id);
    const templateId = tpls.get(m.kind);
    if (!templateId) { failed++; await done({ status: 'loi', error: 'Mẫu ZNS đã tắt' }); continue; }
    try {
      const data = await buildData(db, tenant, m.kind, m.ref_id);
      if (typeof data === 'string') { failed++; await done({ status: 'loi', error: data, attempts: 5 }); continue; }
      let r = await sendZns(await freshToken(db, conn), m.phone, templateId, data, m.id);
      if (!r.ok && isTokenError(r.code)) r = await sendZns(await freshToken(db, conn, true), m.phone, templateId, data, m.id);
      if (r.ok) { sent++; await done({ status: 'da_gui', sent_at: new Date().toISOString(), msg_id: r.msg_id ?? null, error: null }); }
      else { failed++; await done({ status: m.attempts >= 5 ? 'loi' : 'cho', error: `Zalo ${r.code}: ${r.message}`.slice(0, 300) }); }
    } catch (e) {
      failed++;
      await done({ status: m.attempts >= 5 ? 'loi' : 'cho', error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  return { sent, failed, connected: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  if (req.method === 'GET') return callback(url);
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận GET / POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new ZaloError(401, 'Chưa đăng nhập');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u, error } = await userClient.auth.getUser(auth.slice(7));
    if (error || !u.user) throw new ZaloError(401, 'Phiên đăng nhập không hợp lệ');
    const body = await req.json().catch(() => ({})) as { action?: string; return_url?: unknown };
    if (body.action === 'connect') {
      const back = safeReturnUrl(body.return_url);
      if (!back) throw new ZaloError(400, 'Địa chỉ quay lại không hợp lệ');
      return json(200, await connect(userClient, u.user.id, back));
    }
    if (body.action === 'flush') {
      const t = await userClient.rpc('my_tenant_id');
      if (t.error || !t.data) throw new ZaloError(403, 'Không xác định được nhà xe');
      return json(200, await flush(t.data as string));
    }
    throw new ZaloError(400, 'Thao tác không hợp lệ');
  } catch (e) {
    if (e instanceof ZaloError) return json(e.code >= 400 && e.code < 600 ? e.code : 502, { error: e.message });
    console.error(e);
    return json(500, { error: 'Lỗi máy chủ Zalo' });
  }
});
