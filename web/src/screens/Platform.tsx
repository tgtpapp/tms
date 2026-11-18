import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { config } from '../config';
import { MIN_PASSWORD, PHONE_RE } from '../lib/login';
import { adminUsers, errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface TenantRow {
  id: string;
  code: string;
  name: string;
  status: string;
}

/** Trang Super Admin: danh sách nhà xe, tạo nhà xe + Chủ nhà xe. */
export function PlatformScreen() {
  const toast = useToast();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [form, setForm] = useState({ code: config.tenantCode, name: '', ownerName: '', ownerPhone: '', ownerPassword: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('tenants').select('id, code, name, status').order('created_at');
    if (error) toast('error', error.message);
    else setTenants((data ?? []) as TenantRow[]);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!PHONE_RE.test(form.ownerPhone)) return toast('error', 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
    if (form.ownerPassword.length < MIN_PASSWORD) return toast('error', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
    setBusy(true);
    try {
      const tenantId = await rpc<string>('create_tenant', { p_code: form.code, p_name: form.name });
      await adminUsers({ action: 'create_tenant_owner', tenant_id: tenantId, phone: form.ownerPhone,
                         full_name: form.ownerName, password: form.ownerPassword });
      toast('ok', `Đã tạo nhà xe ${form.name} và Chủ nhà xe`);
      setForm({ code: '', name: '', ownerName: '', ownerPhone: '', ownerPassword: '' });
      await load();
    } catch (e2) {
      toast('error', errMsg(e2));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <b>{config.appName}</b> <span className="muted">· Super Admin</span>
        </div>
        <button className="btn link" onClick={() => void supabase.auth.signOut()}>Đăng xuất</button>
      </header>
      <main className="content">
        <section className="card">
          <h2>Nhà xe ({tenants.length})</h2>
          {tenants.length === 0 && <p className="muted">Chưa có nhà xe nào.</p>}
          <ul className="list">
            {tenants.map((t) => (
              <li key={t.id}>
                <b>{t.name}</b> <span className="muted">· {t.code}</span>
                <span className={`badge ${t.status}`}>{t.status === 'active' ? 'Hoạt động' : t.status}</span>
              </li>
            ))}
          </ul>
        </section>
        <form className="card form" onSubmit={submit}>
          <h2>Tạo nhà xe mới</h2>
          <label>Mã nhà xe (chữ thường, số, gạch ngang)
            <input value={form.code} onChange={set('code')} pattern="[a-z0-9-]{2,40}" required />
          </label>
          <label>Tên nhà xe
            <input value={form.name} onChange={set('name')} required />
          </label>
          <h3>Chủ nhà xe</h3>
          <label>Họ tên chủ nhà xe
            <input value={form.ownerName} onChange={set('ownerName')} required />
          </label>
          <label>Số điện thoại chủ nhà xe
            <input value={form.ownerPhone} onChange={set('ownerPhone')} inputMode="tel" required />
          </label>
          <label>Mật khẩu ban đầu
            <input type="password" value={form.ownerPassword} onChange={set('ownerPassword')} autoComplete="new-password" required />
          </label>
          <button className="btn primary" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo nhà xe'}</button>
        </form>
      </main>
    </div>
  );
}
