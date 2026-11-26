// Cấu hình › Bảo mật đăng nhập: máy tính chỉ đăng nhập bằng quét mã QR (điện thoại vẫn dùng mật khẩu); chọn nhóm quyền áp dụng.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { isPersonal } from '../screens/Roles';

interface Policy { on: boolean; roles: string[] }
interface Role { id: string; code: string; name: string }

export function DesktopQrPolicy() {
  const toast = useToast();
  const [p, setP] = useState<Policy | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      supabase.from('tenant_settings').select('value').eq('key', 'bao_mat.may_tinh_qr').maybeSingle(),
      supabase.from('roles').select('id, code, name').order('created_at'),
    ]);
    const rs = ((r.data ?? []) as Role[]).filter((x) => !isPersonal(x));
    setRoles(rs);
    const v = (s.data as { value?: Partial<Policy> } | null)?.value;
    // mặc định: mọi nhóm trừ Lái xe
    setP({ on: !!v?.on, roles: Array.isArray(v?.roles) ? v!.roles! : rs.filter((x) => x.code !== 'driver').map((x) => x.code) });
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!p) return null;
  async function save(next: Policy, msg: string) {
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([{ key: 'bao_mat.may_tinh_qr', value: next }], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    setP(next);
    toast('ok', msg);
  }
  return (
    <>
      <label className="check"><input type="checkbox" checked={p.on} disabled={busy}
        onChange={(e) => void save({ ...p, on: e.target.checked }, e.target.checked ? 'Đã bật: máy tính chỉ đăng nhập bằng quét mã QR' : 'Đã tắt: máy tính đăng nhập bằng mật khẩu được')} /> Máy tính chỉ đăng nhập bằng quét mã QR từ app trên điện thoại</label>
      {p.on && (
        <div className="chips" role="group" aria-label="Nhóm quyền áp dụng">
          {roles.map((r) => (
            <label key={r.id} className="check"><input type="checkbox" checked={p.roles.includes(r.code)} disabled={busy}
              onChange={(e) => void save({ ...p, roles: e.target.checked ? [...p.roles, r.code] : p.roles.filter((c) => c !== r.code) }, 'Đã lưu nhóm áp dụng')} /> {r.name}</label>
          ))}
        </div>
      )}
    </>
  );
}
