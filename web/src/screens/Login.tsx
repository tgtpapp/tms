import { useState, type FormEvent } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { loginEmail } from '../lib/login';
import { supabase } from '../lib/supabase';

const REMEMBER_KEY = 'tms.maNhaXe';

function rememberedCode(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberCode(code: string | null) {
  try {
    if (code) localStorage.setItem(REMEMBER_KEY, code);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* trình duyệt chặn lưu – bỏ qua */
  }
}

/**
 * Đăng nhập bằng số điện thoại + mật khẩu. Super Admin nhập email.
 * Trang có mã nhà xe mặc định thì nhân viên không phải nhập mã;
 * nhà xe khác bấm "Đăng nhập nhà xe khác" để nhập mã (máy sẽ nhớ).
 */
export function LoginScreen() {
  const saved = rememberedCode();
  const [otherTenant, setOtherTenant] = useState(!config.tenantCode || (!!saved && saved !== config.tenantCode));
  const [tenantCode, setTenantCode] = useState(saved && saved !== config.tenantCode ? saved : '');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const id = account.trim();
    const isEmail = id.includes('@');
    const code = otherTenant ? tenantCode.trim().toLowerCase() : config.tenantCode;
    if (!isEmail && !code) return setError('Nhập mã nhà xe');
    const email = isEmail ? id : loginEmail(id.replace(/\s+/g, ''), code, config.loginEmailDomain);
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) return setError(isEmail ? 'Sai email hoặc mật khẩu' : 'Sai mã nhà xe, số điện thoại hoặc mật khẩu');
    if (!isEmail) rememberCode(otherTenant ? code : null);
  }

  return (
    <Centered>
      <form className="card form narrow" onSubmit={submit}>
        <h2>Đăng nhập</h2>
        {otherTenant && (
          <label>
            Mã nhà xe
            <input value={tenantCode} onChange={(e) => setTenantCode(e.target.value)} autoCapitalize="none"
                   autoComplete="organization" placeholder="vd: thinh-phat" />
          </label>
        )}
        <label>
          Số điện thoại
          <input value={account} onChange={(e) => setAccount(e.target.value)} inputMode="tel"
                 autoComplete="username" required autoFocus />
        </label>
        <label>
          Mật khẩu
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 autoComplete="current-password" required />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
        {config.tenantCode && (
          <button type="button" className="btn link" onClick={() => { setOtherTenant(!otherTenant); setError(''); }}>
            {otherTenant ? 'Quay lại đăng nhập mặc định' : 'Đăng nhập nhà xe khác'}
          </button>
        )}
        <p className="muted small">Quên mật khẩu: liên hệ quản trị nhà xe để đặt lại.</p>
      </form>
    </Centered>
  );
}
