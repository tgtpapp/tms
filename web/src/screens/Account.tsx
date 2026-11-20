import { InstallApp } from '../components/InstallApp';
import { Avatar, StaffAvatar } from '../components/StaffAvatar';
import { useEffect, useState, type FormEvent } from 'react';
import { MIN_PASSWORD } from '../lib/login';
import { removeFile, signatureUrl, uploadSignature } from '../lib/documents';
import { SignNameToggle } from '../components/SignNameToggle';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { Cropper } from '../components/Cropper';
import { THEMES, useTheme, type Mode } from '../lib/theme';

/** Tài khoản của tôi: xem thông tin, đổi mật khẩu. */
export function AccountScreen({ ctx }: { ctx: AccountContext }) {
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

  const [sign, setSign] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  useEffect(() => {
    if (ctx.tenant_id && ctx.user_id) void signatureUrl(ctx.tenant_id, ctx.user_id).then(setSign);
  }, [ctx.tenant_id, ctx.user_id]);

  async function pickSign(file: File | undefined) {
    if (!file || !ctx.tenant_id || !ctx.user_id) return;
    try {
      await uploadSignature(ctx.tenant_id, ctx.user_id, file);
      setSign(await signatureUrl(ctx.tenant_id, ctx.user_id));
      toast('ok', 'Đã lưu chữ ký của tôi');
    } catch (err) {
      toast('error', errMsg(err));
    }
  }

  /** Bỏ chữ ký hiện tại (không ưng thì bỏ, tải chữ ký khác) */
  async function dropSign() {
    if (!ctx.tenant_id || !ctx.user_id) return;
    try {
      await removeFile(`${ctx.tenant_id}/chu_ky/${ctx.user_id}.png`);
      const still = await signatureUrl(ctx.tenant_id, ctx.user_id);
      setSign(still);
      toast(still ? 'error' : 'ok', still ? 'Chưa bỏ được chữ ký, thử lại' : 'Đã bỏ chữ ký, có thể tải chữ ký khác');
    } catch (err) {
      toast('error', errMsg(err));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return toast('error', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
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
        {ctx.tenant_id && staffId && <StaffAvatar tenantId={ctx.tenant_id} staffId={staffId} name={ctx.full_name ?? ''} canEdit />}
        {staffId === null && <div className="ava-field"><Avatar name={ctx.full_name ?? '?'} size={88} />
          <span className="small muted">Tài khoản chưa gắn với hồ sơ lái xe / nhân viên nên chưa có ảnh đại diện. Nhờ người quản lý nhân sự chọn tài khoản này trong hồ sơ của bạn (hoặc để số điện thoại hồ sơ trùng số đăng nhập).</span></div>}
        <dl className="info">
          <dt>Họ tên</dt><dd>{ctx.full_name}</dd>
          <dt>Số điện thoại</dt><dd>{phone}</dd>
          <dt>Nhà xe</dt><dd>{ctx.tenant_name}</dd>
        </dl>
      </section>
      {ctx.tenant_id && (
        <section className="card form">
          <h2>Chữ ký của tôi</h2>
          <p className="muted small">Dùng ở mọi bản in có phần ký của bạn: lệnh vận chuyển, bảng phân công, nghiệm thu an toàn, lý lịch xe….. Chụp chữ ký trên giấy trắng, app tự xóa nền. Nền ô caro bên dưới là phần đã trong suốt.</p>
          <label className="upload">
            <span>{sign ? 'Đổi ảnh chữ ký' : 'Tải ảnh chữ ký'}</span>
            <input type="file" accept="image/*" aria-label="Ảnh chữ ký của tôi" onChange={(e) => { setCropping(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          </label>
          {sign && (
            <div className="img-x">
              <img src={sign} alt="Chữ ký của tôi" className="sign-preview clear-bg" />
              <button type="button" className="img-x-btn" aria-label="Bỏ chữ ký này" title="Bỏ chữ ký này" onClick={() => void dropSign()}>×</button>
            </div>
          )}
          {sign && ctx.user_id && <SignNameToggle who={ctx.user_id} />}
          {cropping && <Cropper file={cropping} title="Cắt ảnh chữ ký" onCancel={() => setCropping(null)}
                                onDone={(f) => { setCropping(null); void pickSign(f); }} />}
        </section>
      )}
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
      <p className="muted small">Lưu trên máy này. Bản in (vé, lệnh vận chuyển) luôn nền trắng.</p>
    </section>
  );
}
