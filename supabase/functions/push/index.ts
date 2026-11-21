// Edge Function: thông báo đẩy (Web Push).
// - POST {action:'key'}   → khóa công khai VAPID (tự sinh lần đầu, khóa bí mật chỉ nằm trong DB, chỉ service_role đọc).
// - POST {action:'flush'} (người dùng đã đăng nhập) → gửi các thông báo đang chờ của nhà xe đó tới các máy đã bật nhận.
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

async function vapid(db: SupabaseClient): Promise<{ public_key: string; private_key: string }> {
  const c = await db.from('push_config').select('public_key, private_key').eq('id', 1).maybeSingle();
  if (c.data) return c.data as { public_key: string; private_key: string };
  const k = webpush.generateVAPIDKeys();
  await db.from('push_config').upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: 'id', ignoreDuplicates: true });
  const again = await db.from('push_config').select('public_key, private_key').eq('id', 1).single();
  return again.data as { public_key: string; private_key: string };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const b = await req.json().catch(() => ({})) as { action?: string };
    const db = admin();
    const keys = await vapid(db);
    if (b.action === 'key') return json(200, { key: keys.public_key });
    if (b.action !== 'flush') return json(400, { error: 'Lệnh không hợp lệ' });

    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json(401, { error: 'Chưa đăng nhập' });
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const t = await user.rpc('my_tenant_id');
    if (t.error || !t.data) return json(403, { error: 'Không xác định được nhà xe' });
    const tid = t.data as string;

    const pend = await db.from('notifications').select('id').eq('tenant_id', tid).eq('push_state', 'cho').order('created_at').limit(200);
    const ids = ((pend.data ?? []) as { id: string }[]).map((x) => x.id);
    if (!ids.length) return json(200, { sent: 0 });
    // nhận việc gửi (2 máy cùng gọi không gửi trùng)
    const mine = await db.from('notifications').update({ push_state: 'da_gui' }).in('id', ids).eq('push_state', 'cho').select('id, user_id, title, body, trip_id');
    const list = (mine.data ?? []) as { id: string; user_id: string; title: string; body: string; trip_id: string | null }[];
    if (!list.length) return json(200, { sent: 0 });
    const subs = await db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').eq('tenant_id', tid).in('user_id', [...new Set(list.map((x) => x.user_id))]);
    const S = (subs.data ?? []) as { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }[];
    webpush.setVapidDetails(SUPABASE_URL.startsWith('https://') ? SUPABASE_URL : 'mailto:thong-bao@example.invalid', keys.public_key, keys.private_key);
    let sent = 0;
    const gone = new Set<string>();
    await Promise.all(list.flatMap((n) => S.filter((s) => s.user_id === n.user_id).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: n.title, body: n.body, tag: n.id, url: '/' }), { TTL: 6 * 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.add(s.id);   // máy đã gỡ / tắt nhận
      }
    })));
    if (gone.size) await db.from('push_subscriptions').delete().in('id', [...gone]);
    return json(200, { sent });
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
