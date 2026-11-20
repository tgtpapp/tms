// Edge Function: tệp cài app (manifest) + biểu tượng app theo ảnh đại diện của người cài (như app cũ: biểu tượng là ảnh của mình).
// Chrome trên Android dựng app (WebAPK) trên máy chủ Google nên tệp cài app và biểu tượng phải là địa chỉ mở được từ ngoài,
// không dùng được tệp tạo tạm trên máy. Vì vậy hàm này mở công khai (không cần đăng nhập):
//   GET ?m=1&o=<địa chỉ app>&n=<tên>&t=<nhà xe>&s=<hồ sơ nhân viên>&v=<phiên bản ảnh>  → manifest JSON
//   GET ?t=<nhà xe>&s=<hồ sơ>&z=192|512[&mask=1]                                          → ảnh PNG vuông
// Ảnh chỉ đọc được khi biết đúng mã nhà xe + mã hồ sơ (chuỗi ngẫu nhiên dài); không có ảnh thì lấy logo nhà xe, không có nữa thì biểu tượng chung của app.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
import { manifestOf, safeOrigin } from '../_shared/app_install.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return new Response('Chỉ nhận GET', { status: 405, headers: CORS });
  const q = new URL(req.url).searchParams;
  const t = q.get('t') ?? '', s = q.get('s') ?? '';
  const self = `${SUPABASE_URL}/functions/v1/app-install`;
  if (q.get('m') === '1') {
    const origin = safeOrigin(q.get('o'));
    if (!origin || !UUID.test(t) || (s && !UUID.test(s))) return new Response('Tham số không hợp lệ', { status: 400, headers: CORS });
    const name = (q.get('n') ?? 'TMS').slice(0, 60);
    return new Response(JSON.stringify(manifestOf(origin, name, self, t, s, q.get('v') ?? '')),
      { headers: { ...CORS, 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  }
  const z = q.get('z') === '512' ? 512 : 192, mask = q.get('mask') === '1';
  if (!UUID.test(t) || (s && !UUID.test(s))) return new Response('Tham số không hợp lệ', { status: 400, headers: CORS });
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let bytes: Uint8Array | null = null;
  for (const path of [s ? `${t}/anh_dai_dien/${s}.jpg` : '', `${t}/cong_ty/logo.png`].filter(Boolean)) {
    const { data } = await db.storage.from('giay-to').download(path);
    if (data) { bytes = new Uint8Array(await data.arrayBuffer()); break; }
  }
  if (!bytes) return new Response('Chưa có ảnh', { status: 404, headers: CORS });
  try {
    const src = await Image.decode(bytes);
    const side = Math.min(src.width, src.height);
    const sq = src.crop(Math.floor((src.width - side) / 2), Math.floor((src.height - side) / 2), side, side);
    // Ảnh phủ kín cả ô (kể cả bản maskable): máy Android tự bo tròn / cắt góc, không để viền trắng xung quanh
    const inner = z;
    void mask;
    const out = new Image(z, z).fill(0xffffffff).composite(sq.resize(inner, inner), Math.floor((z - inner) / 2), Math.floor((z - inner) / 2));
    const png = await out.encode();
    return new Response(new Blob([png as BlobPart], { type: 'image/png' }), { headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  } catch {
    return new Response('Không đọc được ảnh', { status: 422, headers: CORS });
  }
});
