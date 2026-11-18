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
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
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

export async function loadAccountContext(): Promise<AccountContext> {
  const { data, error } = await supabase.rpc('my_account_context').single();
  if (error) throw new Error(error.message);
  return data as AccountContext;
}
