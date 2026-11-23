// Quản lý thiết bị đăng nhập (như Zalo): thiết bị này, thiết bị khác đang đăng nhập; đăng xuất từng thiết bị hoặc tất cả.
import { useCallback, useEffect, useState } from 'react';
import { errMsg, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Sess { id: string; created_at: string; last_active: string; user_agent: string | null; ip: string | null; is_current: boolean }

/** "Chrome · Windows", "Samsung Internet · Android"… từ chuỗi trình duyệt */
export function deviceName(ua: string | null): { name: string; mobile: boolean } {
  const u = ua ?? '';
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows'
    : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
  const br = /Zalo/i.test(u) ? 'Zalo' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera'
    : /CocCoc|coc_coc/i.test(u) ? 'Cốc Cốc' : /Firefox|FxiOS/.test(u) ? 'Firefox' : /Chrome|CriOS/.test(u) ? 'Chrome' : /Safari/.test(u) ? 'Safari' : '';
  const name = [br, os].filter(Boolean).join(' · ') || 'Thiết bị không rõ';
  return { name, mobile: /iPhone|Android|iPad|Mobile/.test(u) };
}
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
        {!s.is_current && <button type="button" className="btn small" disabled={busy} aria-label={`Đăng xuất ${d.name}`} onClick={() => void out(s.id)}>Đăng xuất</button>}
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
