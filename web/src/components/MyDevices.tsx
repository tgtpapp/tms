// Quản lý thiết bị đăng nhập (như Zalo): thiết bị này, thiết bị khác đang đăng nhập; đăng xuất từng thiết bị hoặc tất cả.
import { useCallback, useEffect, useState } from 'react';
import { errMsg, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { deviceName } from '../lib/device';

interface Sess { id: string; created_at: string; last_active: string; user_agent: string | null; ip: string | null; is_current: boolean; approved: boolean }

const when = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 2) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  if (m < 24 * 60) return `${Math.round(m / 60)} giờ trước`;
  return new Date(iso).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
};

export function MyDevices() {
  const toast = useToast();
  const [list, setList] = useState<Sess[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setList(await rpc<Sess[]>('my_sessions')); } catch (e) { toast('error', errMsg(e)); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function out(id: string | null) {
    setBusy(true);
    try {
      if (id) { await rpc('sign_out_session', { p_id: id }); toast('ok', 'Đã đăng xuất thiết bị'); }
      else { const n = await rpc<number>('sign_out_other_sessions'); toast('ok', `Đã đăng xuất ${n} thiết bị`); }
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }

  async function decide(id: string, ok: boolean) {
    setBusy(true);
    try { await rpc('approve_device', { p_session_id: id, p_ok: ok }); toast('ok', ok ? 'Đã cho phép thiết bị' : 'Đã từ chối thiết bị'); await load(); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }

  if (!list) return null;
  const cur = list.filter((x) => x.is_current);
  const others = list.filter((x) => !x.is_current);
  const row = (s: Sess) => {
    const d = deviceName(s.user_agent);
    return (
      <li key={s.id} className="item dev-row">
        <i className={`fi ${d.mobile ? 'fi-rr-mobile-notch' : 'fi-rr-computer'}`} aria-hidden="true" />
        <div className="grow">
          <b>{d.name}</b>{s.is_current && <span className="badge">Thiết bị này</span>}
          <div className="small muted">Đăng nhập {new Date(s.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false })}
            {' · '}dùng gần nhất {when(s.last_active)}{s.ip ? ` · IP ${s.ip}` : ''}</div>
        </div>
        {!s.is_current && !s.approved && <>
          <span className="badge warn-badge">Chờ duyệt</span>
          <button type="button" className="btn small primary" disabled={busy} aria-label={`Cho phép ${d.name}`} onClick={() => void decide(s.id, true)}>Cho phép</button>
        </>}
        {!s.is_current && <button type="button" className="btn small" disabled={busy} aria-label={`Đăng xuất ${d.name}`} onClick={() => void out(s.id)}>{s.approved ? 'Đăng xuất' : 'Từ chối'}</button>}
      </li>
    );
  };
  return (
    <section className="card">
      <h2>Quản lý thiết bị đăng nhập</h2>
      <h3 className="section-title">Thiết bị này</h3>
      <ul className="list">{cur.map(row)}</ul>
      <h3 className="section-title">Thiết bị khác đang đăng nhập ({others.length})</h3>
      {others.length === 0 ? <p className="muted small">Không có thiết bị nào khác.</p> : <ul className="list">{others.map(row)}</ul>}
      {others.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void out(null)}><i className="fi fi-rr-sign-out-alt" aria-hidden="true" /> Đăng xuất tất cả thiết bị khác</button>}
    </section>
  );
}
