import { InstallApp } from '../components/InstallApp';
import { NotifySettings } from '../components/NotifySettings';
import { Avatar, StaffAvatar } from '../components/StaffAvatar';
import { useEffect, useState, type FormEvent } from 'react';
import { MIN_PASSWORD, weakPassword } from '../lib/login';
import { supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { THEMES, useTheme, type Mode } from '../lib/theme';

/** Tài khoản của tôi: xem thông tin, đổi mật khẩu. */
/** canManage: có quyền Sửa hồ sơ Lái xe & nhân viên. Nhân viên thường không tự đổi ảnh đại diện, chữ ký (nhờ quản lý nhân sự). */
export function AccountScreen({ ctx, canManage = false }: { ctx: AccountContext; canManage?: boolean }) {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [staffId, setStaffId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!ctx.user_id) return;
    void supabase.from('app_users').select('phone').eq('id', ctx.user_id).maybeSingle()
      .then(({ data }) => setPhone((data as { phone: string } | null)?.phone ?? ''));
    void supabase.from('staff_members').select('id').eq('user_id', ctx.user_id).maybeSingle()
      .then(({ data }) => setStaffId((data as { id: string } | null)?.id ?? null));
  }, [ctx.user_id]);


  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return toast('error', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
    { const w = weakPassword(password); if (w) return toast('error', w); }
    if (password !== confirm) return toast('error', 'Mật khẩu nhập lại không khớp');
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return toast('error', `Không đổi được mật khẩu: ${error.message}`);
    setPassword('');
    setConfirm('');
    toast('ok', 'Đã đổi mật khẩu');
  }

  return (
    <>
      <NotifySettings />
      <ThemePicker />
      <section className="card">
        <div className="item-head">
          <div>
            <h2>Thông tin</h2>
            <p className="muted small">{ctx.tenant_name} · {ctx.full_name}</p>
            <InstallApp name={ctx.tenant_name ?? ''} className="btn small" />
          </div>
          <button className="btn" onClick={() => void supabase.auth.signOut()}>
            <i className="fi fi-rr-sign-out-alt" aria-hidden="true" /> Đăng xuất
          </button>
        </div>
        {ctx.tenant_id && staffId && <StaffAvatar tenantId={ctx.tenant_id} staffId={staffId} name={ctx.full_name ?? ''} canEdit={canManage} />}
        {staffId === null && <div className="ava-field"><Avatar name={ctx.full_name ?? '?'} size={88} />
          <span className="small muted">Tài khoản chưa gắn với hồ sơ lái xe / nhân viên nên chưa có ảnh đại diện. Nhờ người quản lý nhân sự chọn tài khoản này trong hồ sơ của bạn (hoặc để số điện thoại hồ sơ trùng số đăng nhập).</span></div>}
        <dl className="info">
          <dt>Họ tên</dt><dd>{ctx.full_name}</dd>
          <dt>Số điện thoại</dt><dd>{phone}</dd>
          <dt>Nhà xe</dt><dd>{ctx.tenant_name}</dd>
        </dl>
      </section>
      <form className="card form" onSubmit={submit}>
        <h2>Đổi mật khẩu</h2>
        <label>Mật khẩu mới
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>
        <label>Nhập lại mật khẩu mới
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        <button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Đổi mật khẩu'}</button>
      </form>
    </>
  );
}

/** Giao diện: mẫu + sáng / tối / tự động. Lưu trên máy này. */
function ThemePicker() {
  const [cfg, setCfg] = useTheme();
  const modes: [Mode, string][] = [['light', 'Sáng'], ['dark', 'Tối'], ['auto', 'Theo máy']];
  return (
    <section className="card form">
      <h2>Giao diện</h2>
      <div className="seg" role="radiogroup" aria-label="Chế độ sáng tối">
        {modes.map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={cfg.mode === m} className={cfg.mode === m ? 'on' : ''}
                  onClick={() => setCfg({ ...cfg, mode: m })}>{label}</button>
        ))}
      </div>
      <div className="theme-grid" role="radiogroup" aria-label="Mẫu giao diện">
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={cfg.theme === t.id} className={cfg.theme === t.id ? 'theme-opt on' : 'theme-opt'}
                  onClick={() => setCfg({ ...cfg, theme: t.id })}>
            <span className="theme-dot" style={{ background: t.swatch }} />
            <b>{t.name}</b>
            <span className="muted small">{t.note}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
