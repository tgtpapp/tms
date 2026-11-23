// Edge Function: đăng nhập máy tính bằng mã QR (như Zalo PC).
// Máy tính (chưa đăng nhập) hỏi kết quả theo mã QR + mã bí mật; điện thoại đã Đồng ý thì cấp mã đăng nhập dùng 1 lần
// (máy tính đổi mã này lấy phiên đăng nhập, không phải gõ mật khẩu). Không trả email ra ngoài.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
const UUID = /^[0-9a-f-]{36}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 2000) return json(413, { error: 'Nội dung quá dài' });
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'Dữ liệu không hợp lệ' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const secret = typeof body.secret === 'string' ? body.secret.slice(0, 200) : '';
  if (body.action !== 'poll' || !UUID.test(id) || !secret) return json(400, { error: 'Không rõ yêu cầu' });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('svc_qr_take', { p_id: id, p_secret: secret });
  if (error) {
    console.error('svc_qr_take', error.message);
    return json(500, { error: 'Máy chủ đang lỗi, thử lại sau ít phút' });
  }
  const r = data as { status: string; email?: string };
  if (r.status !== 'ok' || !r.email) return json(200, { status: r.status });
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: r.email });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) {
    console.error('generateLink', link.error?.message);
    return json(500, { error: 'Không cấp được đăng nhập, quét lại mã' });
  }
  return json(200, { status: 'ok', token_hash: hashed });
});
