// Edge Function: báo sự cố từ màn hình đăng nhập (chưa có phiên đăng nhập).
// - Không trả lời khác nhau theo mã nhà xe / số điện thoại (không để dò xem nhà xe, tài khoản nào có thật).
// - Chống gửi dồn theo địa chỉ máy: chỉ lưu mã băm HMAC của địa chỉ, không lưu địa chỉ.
// - Trong app (đã đăng nhập) gọi thẳng RPC support_open, không qua đây.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_BODY = 16_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

async function ipHash(req: Request): Promise<string | null> {
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  if (!ip || !SERVICE_KEY) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('support-ip:' + ip)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'Nội dung quá dài' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'Dữ liệu không hợp lệ' });
  }
  if (body.action !== 'login_report') return json(400, { error: 'Không rõ yêu cầu' });
  const text = str(body.text, 2000).trim();
  if (text.length < 3) return json(400, { error: 'Mô tả sự cố quá ngắn' });
  const ctx = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? body.context : {};
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { error } = await admin.rpc('svc_support_login', {
    p_code: str(body.code, 40), p_phone: str(body.phone, 20), p_text: text, p_context: ctx, p_ip_hash: await ipHash(req),
  });
  if (error) {
    console.error('svc_support_login', error.message);
    return json(500, { error: 'Máy chủ đang lỗi, thử lại sau ít phút' });
  }
  return json(200, { ok: true });
});
