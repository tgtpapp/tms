// Edge Function: AI đọc giấy tờ và trả về các ô để điền sẵn (người dùng kiểm tra rồi mới lưu).
// - Chỉ người đăng nhập có quyền quản lý loại giấy tờ đó mới gọi được.
// - Danh sách AI + khóa: secret AI_PROVIDERS (JSON). Thời gian chờ mỗi AI: AI_TIMEOUT_MS (mặc định 25000).
// - Không lưu ảnh ở đây; ảnh được lưu vào Storage từ trình duyệt.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { docTypeOf } from '../_shared/doc_types.ts';
import { parseProviders, readDocument, ReaderError, type InputFile, type ReadDef } from '../_shared/doc_reader.ts';

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
const PERM_BY_OWNER: Record<string, string[]> = { xe: ['vehicle.add', 'vehicle.edit'], nhan_su: ['staff.add', 'staff.edit'], cong_ty: ['settings.edit'] };

// Phiếu đổ dầu từ ảnh (như app cũ): trụ bơm, hóa đơn bán lẻ, biển số, đồng hồ km → điền sẵn phiếu đổ ngoài
const FUEL_DEF: ReadDef = {
  code: 'phieu_do_dau', owner: 'xe', name: 'ảnh đổ dầu cho xe khách ở cây xăng (màn hình trụ bơm, hóa đơn bán lẻ, biển số xe, đồng hồ km)', hasExpiry: false, required: false,
  fields: [
    { key: 'xe.bien_so', label: 'Biển số xe, vd 60F-004.39', kind: 'text' }, { key: 'lit', label: 'Số lít (giữ phần thập phân, vd 44.737)', kind: 'text' },
    { key: 'don_gia', label: 'Đơn giá (đồng/lít)', kind: 'money' }, { key: 'thanh_tien', label: 'Thành tiền (đồng)', kind: 'money' },
    { key: 'cay_xang', label: 'Tên cửa hàng / trạm xăng trên hóa đơn hoặc biển hiệu', kind: 'text' }, { key: 'so_hd', label: 'Số hóa đơn', kind: 'text' },
    { key: 'ngay', label: 'Ngày trên hóa đơn', kind: 'date' }, { key: 'gio', label: 'Giờ dạng HH:MM', kind: 'text' },
    { key: 'km', label: 'Số km trên đồng hồ công-tơ-mét (không có ảnh đồng hồ thì null)', kind: 'int' }, { key: 'loai_nl', label: 'Loại nhiên liệu (vd Dầu DO 0,05S)', kind: 'text' },
  ],
  hint: 'Màn hình trụ bơm thường có 3 dòng: thành tiền (đồng), số lít, đơn giá (đồng/lít). Số lít có phần thập phân (vd 44.737 nghĩa là 44,737 lít).',
};

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
    const fuel = body?.doc_type === 'phieu_do_dau';
    const def = fuel ? FUEL_DEF : typeof body?.doc_type === 'string' ? docTypeOf(body.doc_type) : undefined;
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
    // CCCD: thêm người Sửa xe (quét CCCD chủ xe khi lập hợp đồng thuê xe)
    const need = fuel ? ['fuel.add'] : def.code === 'cccd' ? [...PERM_BY_OWNER.nhan_su!, 'vehicle.edit'] : PERM_BY_OWNER[def.owner];
    // Ảnh đổ dầu: thêm lái xe / nhân viên có hồ sơ (báo đổ dầu từ app lái xe, như app cũ)
    const crew = fuel && !!(await userClient.rpc('my_staff_id')).data;
    if (!crew && !((perms ?? []) as { permission_code: string }[]).some((p) => need?.includes(p.permission_code))) {
      throw new ReaderError(403, 'Không có quyền quản lý loại giấy tờ này');
    }

    const result = await readDocument({
      docType: def.code,
      def,
      files,
      providers: parseProviders(Deno.env.get('AI_PROVIDERS')),
      timeoutMs: Number(Deno.env.get('AI_TIMEOUT_MS') ?? 25000) || 25000,
    });
    return json(200, result);
  } catch (e) {
    if (e instanceof ReaderError) return json(e.status, { error: e.message, attempts: e.attempts });
    console.error(e);
    return json(500, { error: 'Lỗi máy chủ khi đọc giấy tờ' });
  }
});
