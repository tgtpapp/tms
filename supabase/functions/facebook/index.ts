// Edge Function: đăng bài lên trang (fanpage) Facebook của nhà xe.
// - POST {action:'status'}                                          (quyền settings.manage) → trang đã nối chưa + các bài gần đây.
// - POST {action:'publish', message, link?, idempotency_key?}      (quyền settings.manage) → đăng bài, ghi nhật ký thao tác.
// Secret (đặt trên Supabase, không trong code): FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN; tùy chọn FACEBOOK_API_VERSION.
// Mã truy cập trang chỉ nằm ở biến môi trường của máy chủ, không bao giờ trả về trình duyệt.
// Lịch sử bài đăng ghi lại audit_logs (chỉ thêm, mỗi bài 1 dòng action='facebook_publish') → không cần bảng mới.
// Ghi chú(Idempotency-Key): client gửi kèm idempotency_key để bấm lại / thử lại không đăng trùng bài.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { apiVersion, FacebookError, pageName, postUrl, publishPost, sanitizeLink, sanitizeMessage } from '../_shared/facebook.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PAGE_ID = Deno.env.get('FACEBOOK_PAGE_ID') ?? '';
const PAGE_TOKEN = Deno.env.get('FACEBOOK_PAGE_ACCESS_TOKEN') ?? '';
const API_VERSION = apiVersion(Deno.env.get('FACEBOOK_API_VERSION'));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Nhà xe lấy từ phiên đăng nhập (my_tenant_id), không từ tham số client; quyền settings.manage
// kiểm lại bằng bảng vai trò (hàm app.has_permission không mở qua PostgREST).
async function hasSettingsManage(db: SupabaseClient, tenant: string, user: string): Promise<boolean> {
  const rp = await db.from('role_permissions').select('role_id').eq('tenant_id', tenant).eq('permission_code', 'settings.manage');
  const roleIds = ((rp.data ?? []) as { role_id: string }[]).map((r) => r.role_id);
  if (roleIds.length === 0) return false;
  const ur = await db.from('user_roles').select('id').eq('tenant_id', tenant).eq('user_id', user).eq('scope_type', 'tenant').in('role_id', roleIds).limit(1);
  return (ur.data ?? []).length > 0;
}

interface PostEntry { created_at: string; post_id: string | null; message: string | null; link: string | null; url: string | null }

async function history(db: SupabaseClient, tenant: string): Promise<PostEntry[]> {
  const h = await db.from('audit_logs').select('created_at, entity_id, detail')
    .eq('tenant_id', tenant).eq('action', 'facebook_publish').order('created_at', { ascending: false }).limit(10);
  return ((h.data ?? []) as { created_at: string; entity_id: string | null; detail: { message?: string; link?: string | null; url?: string | null } | null }[])
    .map((r) => ({ created_at: r.created_at, post_id: r.entity_id, message: r.detail?.message ?? null, link: r.detail?.link ?? null, url: r.detail?.url ?? null }));
}

async function status(db: SupabaseClient, tenant: string) {
  if (!PAGE_ID || !PAGE_TOKEN) return { configured: false, page_name: null, posts: [] };
  return { configured: true, page_name: await pageName(API_VERSION, PAGE_ID, PAGE_TOKEN), posts: await history(db, tenant) };
}

async function publish(db: SupabaseClient, tenant: string, userId: string, body: Record<string, unknown>) {
  if (!PAGE_ID || !PAGE_TOKEN) throw new FacebookError(503, 'Nền tảng chưa cấu hình trang Facebook (FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN)');
  const message = sanitizeMessage(body.message);
  if (!message) throw new FacebookError(400, 'Nội dung bài đăng: 1–5000 ký tự, không được chỉ khoảng trắng');
  const link = sanitizeLink(body.link);
  if (typeof body.link === 'string' && body.link.trim() !== '' && !link) throw new FacebookError(400, 'Link kèm bài phải là địa chỉ https://…');
  const idem = typeof body.idempotency_key === 'string' && /^[\w-]{8,80}$/.test(body.idempotency_key) ? body.idempotency_key : null;

  // Đã từng đăng bằng đúng khóa này → trả kết quả cũ, không đăng thêm bài trùng
  if (idem) {
    const dup = await db.from('audit_logs').select('detail')
      .eq('tenant_id', tenant).eq('action', 'facebook_publish').contains('detail', { idem }).maybeSingle();
    const d = (dup.data ?? null) as { detail?: { post_id?: string; url?: string } } | null;
    if (d?.detail?.post_id) return { post_id: d.detail.post_id, url: d.detail.url ?? null, duplicate: true };
  }

  const postId = await publishPost(API_VERSION, PAGE_ID, PAGE_TOKEN, message, link);
  const url = postUrl(PAGE_ID, postId);
  await db.from('audit_logs').insert({
    tenant_id: tenant, actor_id: userId, action: 'facebook_publish', entity: 'facebook_post', entity_id: postId,
    detail: { message, link, url, idem },
  });
  return { post_id: postId, url, duplicate: false };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new FacebookError(401, 'Chưa đăng nhập');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u, error } = await userClient.auth.getUser(auth.slice(7));
    if (error || !u.user) throw new FacebookError(401, 'Phiên đăng nhập không hợp lệ');

    const t = await userClient.rpc('my_tenant_id');
    const tenant = t.data as string | null;
    if (!tenant) throw new FacebookError(403, 'Không xác định được nhà xe');
    const db = admin();
    if (!await hasSettingsManage(db, tenant, u.user.id)) throw new FacebookError(403, 'Chỉ người có quyền cấu hình nhà xe được đăng bài lên Facebook');

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action === 'status') return json(200, await status(db, tenant));
    if (body.action === 'publish') return json(200, await publish(db, tenant, u.user.id, body));
    return json(400, { error: 'Không hiểu yêu cầu' });
  } catch (e) {
    console.error(e);
    const status = e instanceof FacebookError && e.code >= 400 && e.code < 600 ? e.code : 500;
    return json(status, { error: e instanceof Error ? e.message : 'Lỗi không rõ' });
  }
});