// Lưu tạm trong phiên các bảng ít đổi (giấy tờ, lý lịch, danh mục): mỗi lần mở chỉ hỏi "dấu thay đổi"
// (số dòng + lần sửa mới nhất theo cột updated_at, bảng có trigger tự ghi). Dấu không đổi thì dùng lại dữ liệu đã có.
// Chỉ dùng cho bảng có cột updated_at được trigger cập nhật khi sửa.
import { supabase } from './supabase';
import { meter } from './egress';

type Res = { data: unknown[] | null; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
const mem = new Map<string, { sig: string; data: unknown[] }>();

/**
 * key: phải gồm nhà xe + người dùng (quyền xem khác nhau theo người).
 * where: chỉ điều kiện lọc (eq/in…), không order/limit. finish: order/limit cho lần tải đầy đủ.
 */
export async function cachedRows(key: string, table: string, cols: string, where: (q: Q) => Q = (q) => q, finish: (q: Q) => Q = (q) => q): Promise<Res> {
  const s = await where(supabase.from(table).select('updated_at', { count: 'exact' })).order('updated_at', { ascending: false }).limit(1);
  meter(`Lưu tạm ${table}: kiểm tra có đổi`, s.data);
  const sig = s.error ? null : `${s.count ?? 0}|${((s.data ?? []) as { updated_at: string }[])[0]?.updated_at ?? ''}`;
  const c = mem.get(key);
  if (sig && c && c.sig === sig) return { data: c.data, error: null };
  const r = (await finish(where(supabase.from(table).select(cols)))) as Res;
  meter(`Lưu tạm ${table}: tải đầy đủ`, r.data);
  if (!r.error && sig) mem.set(key, { sig, data: r.data ?? [] });
  else mem.delete(key);
  return r;
}
