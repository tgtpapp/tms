// Zalo OA: gọi Edge Function `zalo` (mã truy cập Zalo chỉ nằm ở máy chủ).
import { config } from '../config';
import { supabase } from './supabase';

let timer: ReturnType<typeof setTimeout> | undefined;

/** Báo máy chủ gửi các tin Zalo đang chờ của nhà xe (chạy nền, gom nhiều lần bấm thành 1 lần gọi). */
export function zaloKick(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    void supabase.functions.invoke('zalo', { body: { action: 'flush' } }).catch(() => undefined);
  }, 1500);
}

export async function zaloFlushNow(): Promise<{ sent: number; failed: number; connected: boolean }> {
  const { data, error } = await supabase.functions.invoke('zalo', { body: { action: 'flush' } });
  if (error) throw new Error(await fnError(error));
  return data as { sent: number; failed: number; connected: boolean };
}

export async function zaloConnectUrl(): Promise<string> {
  const back = `${window.location.origin}${window.location.pathname}`;
  const { data, error } = await supabase.functions.invoke('zalo', { body: { action: 'connect', return_url: back } });
  if (error) throw new Error(await fnError(error));
  return (data as { url: string }).url;
}

/** Địa chỉ Zalo gọi về: khai báo trong ứng dụng Zalo của nền tảng (Callback URL) */
export const zaloRedirectUri = `${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/zalo`;

async function fnError(e: unknown): Promise<string> {
  const ctx = (e as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    const j = await ctx.json().catch(() => null) as { error?: string } | null;
    if (j?.error) return j.error;
  }
  return e instanceof Error ? e.message : String(e);
}
