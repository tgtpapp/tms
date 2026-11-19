import { useEffect, useState, type FormEvent } from 'react';
import { MIN_PASSWORD } from '../lib/login';
import { signatureUrl, uploadSignature } from '../lib/documents';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { THEMES, useTheme, type Mode } from '../lib/theme';

/** Tài khoản của tôi: xem thông tin, đổi mật khẩu. */
export function AccountScreen({ ctx }: { ctx: AccountContext }) {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ctx.user_id) return;
    void supabase.from('app_users').select('phone').eq('id', ctx.user_id).maybeSingle()
      .then(({ data }) => setPhone((data as { phone: string } | null)?.phone ?? ''));
  }, [ctx.user_id]);

  const [sign, setSign] = useState<string | null>(null);
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
        <h2>Thông tin</h2>
        <dl className="info">
          <dt>Họ tên</dt><dd>{ctx.full_name}</dd>
          <dt>Số điện thoại</dt><dd>{phone}</dd>
          <dt>Nhà xe</dt><dd>{ctx.tenant_name}</dd>
        </dl>
      </section>
      {ctx.tenant_id && (
        <section className="card form">
          <h2>Chữ ký của tôi</h2>
          <p className="muted small">Dùng khi in lệnh vận chuyển (ô Cán bộ điều hành). Nên chụp chữ ký trên giấy trắng hoặc dùng ảnh PNG nền trong suốt.</p>
          <label className="upload">
            <span>{sign ? 'Đổi ảnh chữ ký' : 'Tải ảnh chữ ký'}</span>
            <input type="file" accept="image/*" aria-label="Ảnh chữ ký của tôi" onChange={(e) => { void pickSign(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {sign && <img src={sign} alt="Chữ ký của tôi" className="sign-preview" />}
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
