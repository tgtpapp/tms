import { InstallApp } from '../components/InstallApp';
import { isIOS, knowsUser } from '../lib/pwa';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { deviceName, setQrJustUsed } from '../lib/device';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { loginEmail } from '../lib/login';
import { supabase } from '../lib/supabase';
import { Modal } from '../components/Modal';
import { reportFromLogin } from '../lib/support';

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
  const [report, setReport] = useState(false);
  const [qr, setQr] = useState(false);
  const [note] = useState(() => { try { const m = sessionStorage.getItem('tms.dang_nhap_bao') ?? ''; sessionStorage.removeItem('tms.dang_nhap_bao'); return m; } catch { return ''; } });
  // Máy tính + nhà xe bật "máy tính chỉ đăng nhập bằng QR": vào thẳng mã QR, không hiện ô mật khẩu (trình duyệt không lưu được mật khẩu)
  const [qrOnly, setQrOnly] = useState(false);
  const code0 = otherTenant ? tenantCode.trim().toLowerCase() : config.tenantCode;
  useEffect(() => {
    if (deviceName().mobile || !code0) return;
    let live = true;
    const t = setTimeout(() => {
      void supabase.rpc('login_policy', { p_code: code0 }).then(({ data }) => {
        const on = !!(data as { may_tinh_qr?: boolean } | null)?.may_tinh_qr;
        if (live) { setQrOnly(on); if (on) setQr(true); }
      });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [code0]);

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

  if (qr) return <Centered><QrLogin note={note} qrOnly={qrOnly} onBack={() => setQr(false)} /></Centered>;

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
        <button type="button" className="btn" onClick={() => setQr(true)}>Đăng nhập bằng mã QR</button>
        <p className="muted small">Quên mật khẩu: liên hệ quản trị nhà xe để đặt lại.</p>
        <button type="button" className="btn link" onClick={() => setReport(true)}>Báo sự cố</button>
        {/* iPhone chỉ lấy biểu tượng lúc cài: chưa đăng nhập lần nào trên máy thì cài ở Tài khoản sau khi đăng nhập (biểu tượng = ảnh của mình) */}
        {!(isIOS() && !knowsUser()) && <InstallApp name={config.appName} />}
      </form>
      {report && <LoginReport code={otherTenant ? tenantCode.trim().toLowerCase() : config.tenantCode} askCode={otherTenant}
                              phone={account.replace(/\s+/g, '')} onClose={() => setReport(false)} />}
    </Centered>
  );
}

/** Báo sự cố khi chưa đăng nhập được: gửi tới người quản lý tài khoản của nhà xe (chưa xác minh người gửi) */
export function LoginReport({ code, askCode, phone, onClose }: { code: string; askCode: boolean; phone: string; onClose: () => void }) {
  const [c, setC] = useState(code);
  const [p, setP] = useState(phone);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!c.trim()) return setErr('Nhập mã nhà xe');
    setBusy(true); setErr('');
    try { await reportFromLogin(c.trim().toLowerCase(), p.trim(), text.trim()); setDone(true); }
    catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Báo sự cố" onClose={onClose}>
      {done ? (
        <div className="form">
          <p>Đã gửi tới người quản lý tài khoản của nhà xe.</p>
          <button type="button" className="btn primary" onClick={onClose}>Đóng</button>
        </div>
      ) : (
        <form className="form" onSubmit={send}>
          {askCode && (
            <label>
              Mã nhà xe
              <input value={c} onChange={(e) => setC(e.target.value)} autoCapitalize="none" required />
            </label>
          )}
          <label>
            Số điện thoại của tôi
            <input value={p} onChange={(e) => setP(e.target.value)} inputMode="tel" />
          </label>
          <label>
            Gặp sự cố gì?
            <textarea rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} required
                      placeholder="vd: Đăng nhập báo sai mật khẩu dù nhập đúng" />
          </label>
          {err && <p className="error-text">{err}</p>}
          <button className="btn primary" disabled={busy || text.trim().length < 3}>{busy ? 'Đang gửi…' : 'Gửi'}</button>
        </form>
      )}
    </Modal>
  );
}

/** Đăng nhập máy tính bằng mã QR (như Zalo PC): quét bằng camera điện thoại đang đăng nhập app, bấm Đồng ý */
function QrLogin({ onBack, note, qrOnly }: { onBack: () => void; note?: string; qrOnly?: boolean }) {
  const [code, setCode] = useState<{ id: string; secret: string } | null>(null);
  const [img, setImg] = useState('');
  const [state, setState] = useState<'cho' | 'het_han' | 'tu_choi' | 'dang_vao' | 'loi'>('cho');
  const [err, setErr] = useState('');
  const start = useCallback(async () => {
    setErr(''); setState('cho'); setImg('');
    const { data, error } = await supabase.rpc('qr_start', { p_name: deviceName().name });
    if (error) { setState('loi'); setErr(error.message); return; }
    const c = data as { id: string; secret: string };
    setCode(c);
    setImg(await QRCode.toDataURL(`${location.origin}${location.pathname}#qr=${c.id}`, { margin: 1, width: 280 }));
  }, []);
  useEffect(() => { void start(); }, [start]);
  useEffect(() => {
    if (!code || state !== 'cho') return;
    const t = setInterval(() => void (async () => {
      const { data, error } = await supabase.functions.invoke('qr-login', { body: { action: 'poll', id: code.id, secret: code.secret } });
      if (error) return;
      const r = data as { status: string; token_hash?: string };
      if (r.status === 'ok' && r.token_hash) {
        setState('dang_vao');
        setQrJustUsed(code);
        const v = await supabase.auth.verifyOtp({ token_hash: r.token_hash, type: 'magiclink' });
        if (v.error) { setQrJustUsed(null); setState('loi'); setErr(v.error.message); }
      } else if (r.status === 'het_han' || r.status === 'khong_thay') setState('het_han');
      else if (r.status === 'tu_choi') setState('tu_choi');
    })(), 2000);
    return () => clearInterval(t);
  }, [code, state]);
  return (
    <section className="card form narrow qr-login">
      <h2>Đăng nhập bằng mã QR</h2>
      {note && <p className="error-text">{note}</p>}
      {state === 'cho' && (img ? <img src={img} alt="Mã QR đăng nhập" width={280} height={280} /> : <p className="muted">Đang tạo mã…</p>)}
      {state === 'cho' && <ol className="small">
        <li>Mở app trên điện thoại, bấm <b>Quét QR</b> (đầu thanh menu) hoặc <b>Tài khoản của tôi → Quét mã QR đăng nhập máy tính</b>.</li>
        <li>Hướng camera vào mã này, bấm <b>Đồng ý</b>.</li>
      </ol>}
      {state === 'dang_vao' && <p>Đang đăng nhập…</p>}
      {state === 'het_han' && <p>Mã đã hết hạn.</p>}
      {state === 'tu_choi' && <p className="error-text">Điện thoại đã từ chối.</p>}
      {state === 'loi' && <p className="error-text">{err || 'Không tạo được mã'}</p>}
      {(state === 'het_han' || state === 'tu_choi' || state === 'loi') && <button type="button" className="btn primary" onClick={() => void start()}>Làm mới mã</button>}
      <button type="button" className="btn link" onClick={onBack}>{qrOnly ? 'Được quản lý tạm cho phép? Đăng nhập bằng mật khẩu' : 'Đăng nhập bằng mật khẩu'}</button>
    </section>
  );
}
