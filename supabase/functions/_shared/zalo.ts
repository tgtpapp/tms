// Gọi API Zalo (OAuth v4 cho OA + ZNS). Địa chỉ API theo tài liệu Zalo for Developers (cần xác minh lại khi Zalo đổi phiên bản).
export const ZALO_OAUTH = 'https://oauth.zaloapp.com/v4/oa';
export const ZNS_URL = 'https://business.openapi.zalo.me/message/template';
export const OA_INFO_URL = 'https://openapi.zalo.me/v2.0/oa/getoa';

export class ZaloError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function authorizeUrl(appId: string, redirectUri: string, challenge: string, state: string): string {
  const u = new URL(`${ZALO_OAUTH}/permission`);
  u.searchParams.set('app_id', appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('state', state);
  return u.toString();
}

export interface Tokens { access_token: string; refresh_token: string; expires_at: Date }

async function tokenCall(appId: string, secret: string, form: Record<string, string>): Promise<Tokens> {
  const r = await fetch(`${ZALO_OAUTH}/access_token`, {
    method: 'POST',
    headers: { secret_key: secret, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ app_id: appId, ...form }),
  });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok || typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string') {
    throw new ZaloError(Number(j.error ?? r.status) || r.status, `Zalo từ chối cấp mã truy cập: ${String(j.error_description ?? j.error_name ?? j.message ?? r.status)}`);
  }
  const sec = Number(j.expires_in ?? 3600) || 3600;
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: new Date(Date.now() + sec * 1000) };
}

export const exchangeCode = (appId: string, secret: string, code: string, verifier: string) =>
  tokenCall(appId, secret, { code, code_verifier: verifier, grant_type: 'authorization_code' });

export const refreshTokens = (appId: string, secret: string, refresh: string) =>
  tokenCall(appId, secret, { refresh_token: refresh, grant_type: 'refresh_token' });

export async function oaInfo(accessToken: string): Promise<{ oa_id: string; name: string } | null> {
  const r = await fetch(OA_INFO_URL, { headers: { access_token: accessToken } });
  const j = await r.json().catch(() => ({})) as { error?: number; data?: { oa_id?: string | number; name?: string } };
  if (j.error !== 0 || !j.data) return null;
  return { oa_id: String(j.data.oa_id ?? ''), name: String(j.data.name ?? '') };
}

/** 0912345678 → 84912345678 (định dạng ZNS yêu cầu) */
export function znsPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.startsWith('0') ? `84${d.slice(1)}` : d;
}

export interface ZnsResult { ok: boolean; code: number; message: string; msg_id?: string }

export async function sendZns(accessToken: string, phone: string, templateId: string, data: Record<string, string>, trackingId: string): Promise<ZnsResult> {
  const r = await fetch(ZNS_URL, {
    method: 'POST',
    headers: { access_token: accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: znsPhone(phone), template_id: templateId, template_data: data, tracking_id: trackingId }),
  });
  const j = await r.json().catch(() => ({})) as { error?: number; message?: string; data?: { msg_id?: string } };
  const code = typeof j.error === 'number' ? j.error : r.status;
  return { ok: code === 0, code, message: String(j.message ?? r.statusText), msg_id: j.data?.msg_id };
}

/** Mã lỗi Zalo cho biết mã truy cập hết hạn / sai → làm mới rồi gửi lại (cần xác minh danh sách mã) */
export const isTokenError = (code: number) => code === -124 || code === -216 || code === 401;
