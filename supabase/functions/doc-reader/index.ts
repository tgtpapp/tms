// Edge Function: AI đọc giấy tờ và trả về các ô để điền sẵn (người dùng kiểm tra rồi mới lưu).
// - Chỉ người đăng nhập có quyền quản lý loại giấy tờ đó mới gọi được.
// - Danh sách AI + khóa: secret AI_PROVIDERS (JSON). Thời gian chờ mỗi AI: AI_TIMEOUT_MS (mặc định 10000).
// - Không lưu ảnh ở đây; ảnh được lưu vào Storage từ trình duyệt.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { docTypeOf } from '../_shared/doc_types.ts';
import { parseProviders, readDocument, ReaderError, type InputFile } from '../_shared/doc_reader.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_FILES = 4;
const MAX_B64 = 8 * 1024 * 1024;   // tổng ~6 MB tệp gốc
const PERM_BY_OWNER: Record<string, string> = { xe: 'vehicle.manage', nhan_su: 'staff.manage', cong_ty: 'settings.manage' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new ReaderError(401, 'Chưa đăng nhập');

    const body = await req.json().catch(() => null) as { doc_type?: unknown; files?: unknown } | null;
    const def = typeof body?.doc_type === 'string' ? docTypeOf(body.doc_type) : undefined;
    if (!def) throw new ReaderError(400, 'Loại giấy tờ không hợp lệ');
    const files = Array.isArray(body?.files) ? body!.files as InputFile[] : [];
    if (files.length === 0 || files.length > MAX_FILES) throw new ReaderError(400, `Gửi từ 1 đến ${MAX_FILES} ảnh`);
    let total = 0;
    for (const x of files) {
      if (!x || typeof x.mime !== 'string' || !MIMES.has(x.mime) || typeof x.data !== 'string') {
        throw new ReaderError(400, 'Chỉ nhận ảnh JPG, PNG, WEBP hoặc PDF');
      }
      total += x.data.length;
    }
    if (total > MAX_B64) throw new ReaderError(413, 'Ảnh quá lớn, hãy chụp lại hoặc giảm số trang');

    // Quyền: người gọi phải có quyền quản lý loại giấy tờ này trong nhà xe của mình
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: perms, error } = await userClient.rpc('my_permissions');
    if (error) throw new ReaderError(401, 'Phiên đăng nhập không hợp lệ');
    const need = PERM_BY_OWNER[def.owner];
    if (!((perms ?? []) as { permission_code: string }[]).some((p) => p.permission_code === need)) {
      throw new ReaderError(403, 'Không có quyền quản lý loại giấy tờ này');
    }

    const result = await readDocument({
      docType: def.code,
      files,
      providers: parseProviders(Deno.env.get('AI_PROVIDERS')),
      timeoutMs: Number(Deno.env.get('AI_TIMEOUT_MS') ?? 10000) || 10000,
    });
    return json(200, result);
  } catch (e) {
    if (e instanceof ReaderError) return json(e.status, { error: e.message, attempts: e.attempts });
    console.error(e);
    return json(500, { error: 'Lỗi máy chủ khi đọc giấy tờ' });
  }
});
