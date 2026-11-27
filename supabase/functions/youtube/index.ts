// Edge Function: tìm video YouTube cho mục Giải trí (chỉ người đã đăng nhập vào nhà xe).
// Khóa YouTube Data API đặt trong secret YOUTUBE_API_KEY của Supabase (không bao giờ ở trình duyệt). Chưa có khóa: báo để dán link.
// (Khóa đặt ở GitHub secret YOUTUBE_API_KEY, CI tự chép sang Supabase khi đưa Edge Function lên.)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const KEY = Deno.env.get('YOUTUBE_API_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

interface Item { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } } }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json(401, { error: 'Chưa đăng nhập' });
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const t = await user.rpc('my_tenant_id');
    if (t.error || !t.data) return json(403, { error: 'Không xác định được nhà xe' });
    if (!KEY) return json(503, { error: 'Chưa cài khóa tìm kiếm YouTube. Dán link video để xem.', no_key: true });
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const q = typeof b.q === 'string' ? b.q.trim().slice(0, 120) : '';
    if (!q) return json(400, { error: 'Nhập nội dung cần tìm' });
    const page = typeof b.page === 'string' ? b.page.slice(0, 100) : '';
    const u = new URL('https://www.googleapis.com/youtube/v3/search');
    for (const [k, v] of Object.entries({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '24', regionCode: 'VN', relevanceLanguage: 'vi', safeSearch: 'moderate', q, key: KEY }))
      u.searchParams.set(k, v);
    if (page) u.searchParams.set('pageToken', page);
    const r = await fetch(u);
    const j = await r.json().catch(() => ({})) as { items?: Item[]; nextPageToken?: string; error?: { message?: string } };
    if (!r.ok) return json(502, { error: `YouTube báo lỗi: ${j.error?.message ?? r.status}` });
    const items = (j.items ?? []).filter((x) => x.id?.videoId).map((x) => ({
      id: x.id!.videoId!, title: x.snippet?.title ?? '', channel: x.snippet?.channelTitle ?? '', thumb: x.snippet?.thumbnails?.medium?.url ?? '',
    }));
    return json(200, { items, next: j.nextPageToken ?? null });
  } catch (e) {
    console.error('youtube', e);
    return json(500, { error: 'Máy chủ đang lỗi, thử lại sau' });
  }
});
