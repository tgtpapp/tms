// Facebook fanpage: gọi Edge Function `facebook` (mã truy cập trang chỉ nằm ở máy chủ).
// Bài nháp (chờ duyệt) lưu trong bảng facebook_drafts: đọc trực tiếp, ghi qua 2 hàm RPC (tự kiểm quyền).
import { FunctionsHttpError } from '@supabase/supabase-js';
import { rpc, supabase } from './supabase';

export interface FacebookPost { created_at: string; post_id: string | null; message: string | null; link: string | null; url: string | null }
export interface FacebookStatus { configured: boolean; page_name: string | null; posts: FacebookPost[] }
export interface FacebookPublishResult { post_id: string; url: string | null; duplicate: boolean }

export type FacebookDraftStatus = 'cho_duyet' | 'da_duyet' | 'da_bo' | 'da_dang';
export interface FacebookDraft {
  id: string; content: string; photos: string[]; link: string | null; scheduled_at: string | null;
  status: FacebookDraftStatus; fb_post_id: string | null; fb_post_url: string | null; posted_at: string | null;
  created_at: string; updated_at: string;
}
export const DRAFT_STATUS: Record<FacebookDraftStatus, string> =
  { cho_duyet: 'Chờ duyệt', da_duyet: 'Đã duyệt', da_bo: 'Đã bỏ', da_dang: 'Đã đăng' };

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('facebook', { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = await error.context.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? 'Lỗi máy chủ');
    }
    throw new Error(error.message);
  }
  return data as T;
}

/** Trạng thái trang Facebook của nhà xe + các bài đã đăng gần đây. */
export const facebookStatus = () => call<FacebookStatus>({ action: 'status' });

/** Đăng bài lên trang Facebook của nhà xe. Mã bài dùng để chống đăng trùng khi thử lại. */
export const facebookPublish = (message: string, link?: string, idempotencyKey?: string) =>
  call<FacebookPublishResult>({ action: 'publish', message, link, idempotency_key: idempotencyKey });

/** Duyệt đăng bài nháp: đăng lên trang Facebook (kèm ảnh), lưu mã + link bài vào bài nháp. */
export const facebookDraftPublish = (draftId: string) =>
  call<FacebookPublishResult & { draft_id: string }>({ action: 'publish_draft', draft_id: draftId });

/** Danh sách bài nháp của nhà xe (mỗi nhà xe chỉ thấy bài của mình). */
export async function facebookDrafts(): Promise<FacebookDraft[]> {
  const { data, error } = await supabase.from('facebook_drafts').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as FacebookDraft[];
}

/** Soạn bài mới / sửa bài đang chờ duyệt. Ảnh là tên tệp đã tải sẵn trong thư mục ảnh của bài. */
export const saveFacebookDraft = (draft: { id: string; content: string; photos: string[]; link?: string | null; scheduled_at?: string | null }) =>
  rpc('save_facebook_draft', { p: draft });

/** Bỏ bài đang chờ duyệt / đã duyệt (giữ lịch sử). */
export const discardFacebookDraft = (id: string) => rpc('discard_facebook_draft', { p_id: id });
