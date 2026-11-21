// Edge Function: thông báo đẩy (Web Push).
// - POST {action:'key'}             → khóa công khai VAPID (tự sinh lần đầu; khóa bí mật chỉ nằm trong DB, chỉ service_role đọc).
// - POST {action:'flush'}           (người dùng đã đăng nhập) → gửi ngay các tin đang chờ của nhà xe đó.
// - POST {action:'cron', secret}    (lịch chạy mỗi phút trong DB) → gửi tin chờ / thử lại tin lỗi của mọi nhà xe.
// Mỗi lần gửi tới từng máy đều ghi nhật ký; lỗi tạm thì DB hẹn thử lại (1, 5, 15 phút); máy đã gỡ (404/410) thì xóa đăng ký.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

interface Cfg { public_key: string; private_key: string; cron_secret: string | null }
async function config(db: SupabaseClient): Promise<Cfg> {
  const c = await db.from('push_config').select('public_key, private_key, cron_secret').eq('id', 1).maybeSingle();
  const row = c.data as Partial<Cfg> | null;
  if (row?.public_key && row.private_key) return row as Cfg;
  const k = webpush.generateVAPIDKeys();
  if (row) await db.from('push_config').update({ public_key: k.publicKey, private_key: k.privateKey }).eq('id', 1).is('public_key', null);
  else await db.from('push_config').upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: 'id', ignoreDuplicates: true });
  return (await db.from('push_config').select('public_key, private_key, cron_secret').eq('id', 1).single()).data as Cfg;
}

interface Job { id: string; tenant_id: string; user_id: string; title: string; body: string; priority: string; attempt: number }
async function send(db: SupabaseClient, cfg: Cfg, tenant: string | null): Promise<{ ok: number; fail: number }> {
  const claim = await db.rpc('svc_push_claim', { p_tenant: tenant, p_limit: 200 });
  if (claim.error) throw new Error(claim.error.message);
  const jobs = (claim.data ?? []) as Job[];
  if (!jobs.length) return { ok: 0, fail: 0 };
  const subs = await db.from('push_subscriptions').select('id, tenant_id, user_id, endpoint, p256dh, auth').in('user_id', [...new Set(jobs.map((j) => j.user_id))]);
  const S = (subs.data ?? []) as { id: string; tenant_id: string; user_id: string; endpoint: string; p256dh: string; auth: string }[];
  webpush.setVapidDetails(SUPABASE_URL.startsWith('https://') ? SUPABASE_URL : 'mailto:thong-bao@example.invalid', cfg.public_key, cfg.private_key);
  const logs: Record<string, unknown>[] = [], gone = new Set<string>();
  let ok = 0, fail = 0;
  await Promise.all(jobs.map(async (j) => {
    const mine = S.filter((s) => s.user_id === j.user_id && s.tenant_id === j.tenant_id);
    if (!mine.length) {
      logs.push({ tenant_id: j.tenant_id, notification_id: j.id, attempt: j.attempt, result: 'khong_may' });
      await db.rpc('svc_push_result', { p_id: j.id, p_result: 'khong_may', p_error: null });
      return;
    }
    let sent = 0, err = '';
    await Promise.all(mine.map(async (s) => {
      try {
        const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: j.title, body: j.body, tag: j.id, url: '/', priority: j.priority }),
          { TTL: 6 * 3600, urgency: j.priority === 'thuong' ? 'normal' : 'high', timeout: 15000 });
        sent++;
        logs.push({ tenant_id: j.tenant_id, notification_id: j.id, subscription_id: s.id, attempt: j.attempt, result: 'ok', http_code: r.statusCode });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode ?? null;
        const expired = code === 404 || code === 410;
        if (expired) gone.add(s.id); else err = `${code ?? ''} ${(e as Error).message ?? e}`.trim().slice(0, 300);
        logs.push({ tenant_id: j.tenant_id, notification_id: j.id, subscription_id: s.id, attempt: j.attempt, result: expired ? 'het_han' : 'loi', http_code: code,
          error: expired ? 'Máy đã gỡ / tắt nhận' : err });
      }
    }));
    if (sent) ok++; else fail++;
    // tất cả máy đều đã gỡ → coi như chưa có máy nhận; còn lại lỗi tạm → thử lại
    const res = sent ? 'ok' : !err ? 'khong_may' : 'loi';
    await db.rpc('svc_push_result', { p_id: j.id, p_result: res, p_error: err || null });
  }));
  if (gone.size) await db.from('push_subscriptions').delete().in('id', [...gone]);
  if (logs.length) await db.from('notification_delivery_logs').insert(logs);
  return { ok, fail };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const b = await req.json().catch(() => ({})) as { action?: string; secret?: string };
    const db = admin();
    const cfg = await config(db);
    if (b.action === 'key') return json(200, { key: cfg.public_key });
    if (b.action === 'cron') {
      if (!cfg.cron_secret || b.secret !== cfg.cron_secret) return json(403, { error: 'Không có quyền' });
      return json(200, await send(db, cfg, null));
    }
    if (b.action !== 'flush') return json(400, { error: 'Lệnh không hợp lệ' });
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json(401, { error: 'Chưa đăng nhập' });
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const t = await user.rpc('my_tenant_id');
    if (t.error || !t.data) return json(403, { error: 'Không xác định được nhà xe' });
    return json(200, await send(db, cfg, t.data as string));
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
