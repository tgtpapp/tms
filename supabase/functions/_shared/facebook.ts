// Gọi Graph API của Facebook để đăng bài lên trang (fanpage) của nhà xe.
// Mã truy cập trang (Page Access Token, loại sống lâu) do nền tảng đặt trong secret của
// Supabase (FACEBOOK_PAGE_ACCESS_TOKEN), không nằm trong kho code hay trình duyệt.
// Phiên bản API mặc định dưới đây; đổi bằng secret FACEBOOK_API_VERSION khi Facebook ngưng hỗ trợ (cần xác minh tại developers.facebook.com).

export const DEFAULT_FACEBOOK_API_VERSION = 'v22.0';

export class FacebookError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

/** Chuẩn hóa phiên bản Graph API: chấp nhận "v22.0" / "22.0" / trống → mặc định. */
export function apiVersion(v: string | undefined): string {
  const m = (v ?? '').trim().match(/^v?(\d+\.\d+)$/);
  return m ? `v${m[1]}` : DEFAULT_FACEBOOK_API_VERSION;
}

export function graphUrl(version: string, path: string): string {
  return `https://graph.facebook.com/${version}/${path.replace(/^\/+/, '')}`;
}

/** Nội dung bài đăng: cắt khoảng trắng thừa, tối đa 5000 ký tự; rỗng → null. */
export function sanitizeMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (!m || m.length > 5000) return null;
  return m;
}

/** Link kèm bài: chỉ nhận địa chỉ https. Trống / sai định dạng → null. */
export function sanitizeLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch { /* sai định dạng */ }
  return null;
}

async function graphFetch(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({})) as { error?: { message?: string; code?: number } } & Record<string, unknown>;
  if (!r.ok) {
    const e = j.error ?? {};
    throw new FacebookError(Number(e.code) || r.status, `Facebook từ chối: ${String(e.message ?? r.statusText)}`);
  }
  return j;
}

/** Đăng bài văn bản (kèm link tùy chọn) lên trang; trả id bài dạng "PAGEID_POSTID". */
export async function publishPost(version: string, pageId: string, pageToken: string, message: string, link: string | null): Promise<string> {
  const form = new URLSearchParams({ message, access_token: pageToken });
  if (link) form.set('link', link);
  const j = await graphFetch(graphUrl(version, `${pageId}/feed`), { method: 'POST', body: form });
  if (typeof j.id !== 'string') throw new FacebookError(0, 'Facebook không trả mã bài đăng');
  return j.id;
}

/** Tên trang (hiện ở Cấu hình để biết đang nối đúng trang); lỗi → null. */
export async function pageName(version: string, pageId: string, pageToken: string): Promise<string | null> {
  try {
    const q = new URLSearchParams({ fields: 'name', access_token: pageToken });
    const j = await graphFetch(`${graphUrl(version, pageId)}?${q}`, { method: 'GET' });
    return typeof j.name === 'string' && j.name ? j.name : null;
  } catch { /* mã sai / hết hạn: phần Cấu hình sẽ báo */ }
  return null;
}

/** Link mở bài đăng trên Facebook (tách mã bài từ dạng "PAGEID_POSTID"). */
export function postUrl(pageId: string, postId: string): string {
  const tail = postId.includes('_') ? postId.split('_').pop() : postId;
  return `https://www.facebook.com/${pageId}/posts/${tail}`;
}