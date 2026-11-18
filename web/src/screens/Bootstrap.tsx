import { useState, type FormEvent } from 'react';
import { Centered } from '../components/Centered';
import { MIN_PASSWORD } from '../lib/login';
import { errMsg, rpc, supabase } from '../lib/supabase';

/**
 * Khởi tạo lần đầu: tạo tài khoản Super Admin của nền tảng.
 * Chỉ hiện khi hệ thống chưa có Super Admin; database chặn chạy lần 2.
 */
export function BootstrapScreen({ signedIn, onDone }: { signedIn: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [waitingEmail, setWaitingEmail] = useState(false);

  async function bootstrap() {
    await rpc<void>('bootstrap_platform_admin');
    onDone();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD) return setError(`Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
    if (password !== confirm) return setError('Mật khẩu nhập lại không khớp');
    setBusy(true);
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (err) throw new Error(err.message);
      if (!data.session) setWaitingEmail(true);
      else await bootstrap();
    } catch (e2) {
      setError(errMsg(e2));
    } finally {
      setBusy(false);
    }
  }

  if (waitingEmail) {
    return (
      <Centered>
        <div className="card narrow">
          <h2>Xác nhận email</h2>
          <p>Đã gửi thư xác nhận tới <b>{email}</b>. Mở thư, bấm xác nhận rồi quay lại trang này để hoàn tất.</p>
        </div>
      </Centered>
    );
  }

  if (signedIn) {
    return (
      <Centered>
        <div className="card narrow">
          <h2>Khởi tạo hệ thống</h2>
          <p>Tài khoản này sẽ trở thành Super Admin của nền tảng. Chỉ làm được một lần.</p>
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await bootstrap(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
          }}>Khởi tạo hệ thống</button>
          <button className="btn link" onClick={() => void supabase.auth.signOut()}>Đăng xuất</button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <form className="card form narrow" onSubmit={submit}>
        <h2>Khởi tạo hệ thống</h2>
        <p className="muted small">Tạo tài khoản Super Admin (chủ nền tảng). Màn hình này chỉ xuất hiện một lần.</p>
        <label>
          Email Super Admin
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Mật khẩu
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 autoComplete="new-password" required />
        </label>
        <label>
          Nhập lại mật khẩu
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                 autoComplete="new-password" required />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo Super Admin'}</button>
      </form>
    </Centered>
  );
}
