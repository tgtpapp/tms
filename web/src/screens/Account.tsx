import { useEffect, useState, type FormEvent } from 'react';
import { MIN_PASSWORD } from '../lib/login';
import { supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

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
      <section className="card">
        <h2>Thông tin</h2>
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
