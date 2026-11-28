// Facebook fanpage: gọi Edge Function `facebook` (mã truy cập trang chỉ nằm ở máy chủ).
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface FacebookPost { created_at: string; post_id: string | null; message: string | null; link: string | null; url: string | null }
export interface FacebookStatus { configured: boolean; page_name: string | null; posts: FacebookPost[] }
export interface FacebookPublishResult { post_id: string; url: string | null; duplicate: boolean }

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