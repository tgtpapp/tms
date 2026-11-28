// Edge Function: đăng bài lên trang (fanpage) Facebook của nhà xe.
// - POST {action:'status'}                                          (quyền settings.manage) → trang đã nối chưa + các bài gần đây.
// - POST {action:'publish', message, link?, idempotency_key?}      (quyền settings.manage) → đăng bài, ghi nhật ký thao tác.
// - POST {action:'publish_draft', draft_id}                       (quyền settings.manage) → duyệt đăng bài nháp chờ duyệt:
//   đánh dấu đã duyệt, đăng bài (kèm ảnh), lưu mã + link bài Facebook vào bài nháp, ghi nhật ký.
// Secret (đặt trên Supabase, không trong code): FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN; tùy chọn FACEBOOK_API_VERSION.
// Mã truy cập trang chỉ nằm ở biến môi trường của máy chủ, không bao giờ trả về trình duyệt.
// Lịch sử bài đăng ghi lại audit_logs (chỉ thêm, mỗi bài 1 dòng action='facebook_publish') → không cần bảng mới.
// Ghi chú(Idempotency-Key): client gửi kèm idempotency_key để bấm lại / thử lại không đăng trùng bài.
// Bài đã đăng (trạng thái đã đăng) không đăng lại: trả kết quả cũ.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { apiVersion, FacebookError, pageName, postUrl, publishPost, sanitizeLink, sanitizeMessage, uploadPhoto } from '../_shared/facebook.ts';
import { driveCfg, FileError, readFile, unb64 } from '../_shared/file_store.ts';

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

interface DraftRow {
  id: string; content: string; photos: string[]; link: string | null;
  status: 'cho_duyet' | 'da_duyet' | 'da_bo' | 'da_dang'; fb_post_id: string | null; fb_post_url: string | null;
}

/** Duyệt đăng bài nháp: bài của đúng nhà xe này (lấy từ phiên, không từ tham số client), đang chờ duyệt / đã duyệt.
 *  Đánh dấu đã duyệt trước khi gọi Facebook (kết quả duyệt không mất khi Facebook lỗi), rồi đăng bài
 *  (kèm ảnh trong kho tệp của nhà xe), lưu mã + link bài vào bài nháp, ghi nhật ký. Bài đã đăng thì trả kết quả cũ. */
async function publishDraft(db: SupabaseClient, tenant: string, userId: string, body: Record<string, unknown>) {
  if (!PAGE_ID || !PAGE_TOKEN) throw new FacebookError(503, 'Nền tảng chưa cấu hình trang Facebook (FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN)');
  const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftId)) throw new FacebookError(400, 'Thiếu mã bài nháp');

  const q = await db.from('facebook_drafts').select('id, content, photos, link, status, fb_post_id, fb_post_url')
    .eq('tenant_id', tenant).eq('id', draftId).maybeSingle();
  const draft = (q.data ?? null) as DraftRow | null;
  if (!draft) throw new FacebookError(404, 'Không tìm thấy bài nháp');
  if (draft.status === 'da_dang' && draft.fb_post_id) {
    return { post_id: draft.fb_post_id, url: draft.fb_post_url ?? postUrl(PAGE_ID, draft.fb_post_id), draft_id: draftId, duplicate: true };
  }
  if (draft.status === 'da_bo') throw new FacebookError(400, 'Bài này đã bỏ, không đăng được');

  const message = sanitizeMessage(draft.content);
  if (!message) throw new FacebookError(400, 'Bài nháp còn trống nội dung');
  const link = sanitizeLink(draft.link);
  const photos = (draft.photos ?? []).filter((p): p is string => typeof p === 'string' && p.startsWith(`${tenant}/facebook/`) && !p.includes('..'));

  // Đánh dấu đã duyệt, chỉ đánh được khi còn chờ duyệt / đã duyệt (2 lần bấm cùng lúc không cùng đăng 2 bài)
  const mark = await db.from('facebook_drafts')
    .update({ status: 'da_duyet', decided_by: userId, decided_at: new Date().toISOString() })
    .eq('tenant_id', tenant).eq('id', draftId).in('status', ['cho_duyet', 'da_duyet']).select('id');
  if (!mark.data?.length) {
    const again = await db.from('facebook_drafts').select('status, fb_post_id, fb_post_url').eq('tenant_id', tenant).eq('id', draftId).maybeSingle();
    const r = (again.data ?? null) as Pick<DraftRow, 'status' | 'fb_post_id' | 'fb_post_url'> | null;
    if (r?.status === 'da_dang' && r.fb_post_id) {
      return { post_id: r.fb_post_id, url: r.fb_post_url ?? postUrl(PAGE_ID, r.fb_post_id), draft_id: draftId, duplicate: true };
    }
    throw new FacebookError(409, 'Bài này đang được duyệt ở chỗ khác, thử tải lại danh sách');
  }

  // Ảnh bài nháp: đọc từ kho tệp của nhà xe rồi tải lên trang (chưa công khai), gộp vào 1 bài đa ảnh
  const mediaIds: string[] = [];
  const cfg = await driveCfg(db, tenant);
  for (const name of photos) {
    const row = await db.from('file_store').select('name, drive_id, mime, size_bytes').eq('tenant_id', tenant).eq('name', name).maybeSingle();
    const r = (row.data ?? null) as { name: string; drive_id: string | null; mime: string | null } | null;
    if (!r) throw new FacebookError(404, `Không tìm thấy ảnh ${name}`);
    try {
      const { mime, data } = await readFile(db, cfg, r);
      mediaIds.push(await uploadPhoto(API_VERSION, PAGE_ID, PAGE_TOKEN, mime, unb64(data)));
    } catch (e) {
      throw new FacebookError(e instanceof FileError ? e.status : 500, `Đọc ảnh ${name} không được: ${e instanceof Error ? e.message : 'lỗi không rõ'}`);
    }
  }

  const postId = await publishPost(API_VERSION, PAGE_ID, PAGE_TOKEN, message, link, mediaIds);
  const url = postUrl(PAGE_ID, postId);
  await db.from('facebook_drafts').update({
    status: 'da_dang', fb_post_id: postId, fb_post_url: url, posted_at: new Date().toISOString(),
  }).eq('tenant_id', tenant).eq('id', draftId);
  await db.from('audit_logs').insert({
    tenant_id: tenant, actor_id: userId, action: 'facebook_publish', entity: 'facebook_draft', entity_id: postId,
    detail: { message, link, url, draft_id: draftId },
  });
  return { post_id: postId, url, draft_id: draftId, duplicate: false };
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
    if (body.action === 'publish_draft') return json(200, await publishDraft(db, tenant, u.user.id, body));
    return json(400, { error: 'Không hiểu yêu cầu' });
  } catch (e) {
    console.error(e);
    const status = e instanceof FacebookError && e.code >= 400 && e.code < 600 ? e.code : 500;
    return json(status, { error: e instanceof Error ? e.message : 'Lỗi không rõ' });
  }
});