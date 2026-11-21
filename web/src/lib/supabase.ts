import { createClient, FunctionsHttpError } from '@supabase/supabase-js';
import { config } from '../config';

export const supabase = createClient(
  config.supabaseUrl || 'http://cau-hinh-thieu.invalid',
  config.supabasePublishableKey || 'cau-hinh-thieu',
  { auth: { persistSession: true, autoRefreshToken: true } },
);

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Gọi hàm RPC trong database; lỗi trả về câu tiếng Việt từ database. */
let afterWrite: ((fn: string) => void) | null = null;
/** Việc chạy sau mỗi lệnh RPC thành công (gửi thông báo đẩy đang chờ) */
export const setAfterWrite = (f: (fn: string) => void) => { afterWrite = f; };
/** Ghi lại lỗi RPC gần nhất (gửi kèm khi báo sự cố) */
let onRpcError: ((fn: string, msg: string) => void) | null = null;
export const setOnRpcError = (f: (fn: string, msg: string) => void) => { onRpcError = f; };
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) { onRpcError?.(fn, error.message); throw new Error(error.message); }
  afterWrite?.(fn);
  return data as T;
}

/** Gọi Edge Function quản lý tài khoản. */
export async function adminUsers<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await error.context.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? 'Lỗi máy chủ');
    }
    throw new Error(error.message);
  }
  return data as T;
}

export interface AccountContext {
  user_id: string | null;
  tenant_id: string | null;
  tenant_code: string | null;
  tenant_name: string | null;
  full_name: string | null;
  can_manage_users: boolean;
  is_platform_admin: boolean;
}

/** Lưu / đọc bản sao trên máy (để mở app khi mất mạng), gắn với tài khoản đang đăng nhập. */
export async function withOfflineCopy<T>(key: string, load: () => Promise<T>): Promise<T> {
  const uid = (await supabase.auth.getSession()).data.session?.user.id ?? '';
  const k = `tms:${key}:${uid}`;
  try {
    const v = await load();
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ }
    return v;
  } catch (e) {
    const cached = navigator.onLine ? null : localStorage.getItem(k);
    if (uid && cached) return JSON.parse(cached) as T;
    throw e;
  }
}

export async function loadAccountContext(): Promise<AccountContext> {
  return withOfflineCopy('ctx', async () => {
    const { data, error } = await supabase.rpc('my_account_context').single();
    if (error) throw new Error(error.message);
    return data as AccountContext;
  });
}

/** Đọc hết mọi dòng (API trả tối đa 1000 dòng / lần): gọi lại theo trang. `make` phải tạo truy vấn mới có sắp xếp ổn định. */
export async function fetchAll<T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> }, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await make().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}
