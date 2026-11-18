import { useState, type FormEvent } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { loginEmail } from '../lib/login';
import { supabase } from '../lib/supabase';

/** Đăng nhập bằng số điện thoại + mật khẩu. Super Admin nhập email. */
export function LoginScreen() {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const id = account.trim();
    const email = id.includes('@') ? id : loginEmail(id.replace(/\s+/g, ''), config.tenantCode, config.loginEmailDomain);
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) setError('Sai số điện thoại hoặc mật khẩu');
  }

  return (
    <Centered>
      <form className="card form narrow" onSubmit={submit}>
        <h2>Đăng nhập</h2>
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
        <p className="muted small">Quên mật khẩu: liên hệ quản trị nhà xe để đặt lại.</p>
      </form>
    </Centered>
  );
}
