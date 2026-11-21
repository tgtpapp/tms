// Cấu hình Zalo OA của nhà xe: kết nối, mẫu ZNS, nhật ký tin.
import { useCallback, useEffect, useState } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { zaloConnectUrl, zaloFlushNow, zaloRedirectUri } from '../lib/zalo';

type Kind = 've' | 'hang';
interface Status { connected: boolean; oa_name: string | null; oa_id: string | null; connected_at: string | null; waiting: number; failed: number }
interface Msg { id: string; kind: Kind; phone: string; status: string; error: string | null; created_at: string; sent_at: string | null }

const KINDS: { kind: Kind; label: string; params: string }[] = [
  { kind: 've', label: 'Xác nhận vé (gửi khi đặt / bán vé)', params: 'ma_ve, ten_khach, tuyen, gio_chay, ghe, diem_don, so_tien' },
  { kind: 'hang', label: 'Báo hàng đã đến (gửi người nhận)', params: 'ma_hang, ten_nguoi_nhan, noi_nhan, mo_ta, so_kien, can_thu' },
];
const MSG_STATUS: Record<string, string> = { cho: 'Chờ gửi', dang_gui: 'Đang gửi', da_gui: 'Đã gửi', loi: 'Lỗi' };
const t = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });

export function ZaloSettings() {
  const toast = useToast();
  const [st, setSt] = useState<Status | null>(null);
  const [tpl, setTpl] = useState<Record<Kind, { id: string; on: boolean }>>({ ve: { id: '', on: true }, hang: { id: '', on: true } });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, tp, m] = await Promise.all([
        rpc<Status>('zalo_status'),
        supabase.from('zalo_templates').select('kind, template_id, enabled'),
        supabase.from('zalo_messages').select('id, kind, phone, status, error, created_at, sent_at').order('created_at', { ascending: false }).limit(30),
      ]);
      setSt(s);
      const next: Record<Kind, { id: string; on: boolean }> = { ve: { id: '', on: true }, hang: { id: '', on: true } };
      for (const r of (tp.data ?? []) as { kind: Kind; template_id: string; enabled: boolean }[]) next[r.kind] = { id: r.template_id, on: r.enabled };
      setTpl(next);
      setMsgs((m.data ?? []) as Msg[]);
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [toast]);

  useEffect(() => {
    // Zalo chuyển về app sau khi chủ OA đồng ý / từ chối
    const u = new URL(window.location.href);
    const r = u.searchParams.get('zalo');
    if (r) {
      toast(r === 'ok' ? 'ok' : 'error', r === 'ok' ? 'Đã kết nối Zalo OA' : r === 'huy' ? 'Chưa cấp quyền Zalo OA' : 'Kết nối Zalo OA không thành công, hãy thử lại');
      u.searchParams.delete('zalo');
      window.history.replaceState(null, '', u.toString());
    }
    void load();
  }, [load, toast]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast('ok', ok);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      window.location.href = await zaloConnectUrl();
    } catch (e) {
      toast('error', errMsg(e));
      setBusy(false);
    }
  }

  return (
    <section className="card form">
      <h2>Zalo OA</h2>
      {!st && <p className="muted">Đang tải…</p>}
      {st && (st.connected ? (
        <div className="item-head">
          <p>Đã kết nối <b>{st.oa_name || `OA ${st.oa_id}`}</b>{st.connected_at ? ` từ ${t(st.connected_at)}` : ''}</p>
          <button className="btn small link" disabled={busy} onClick={() => void run(() => rpc('zalo_disconnect'), 'Đã ngắt kết nối Zalo OA')}>Ngắt kết nối</button>
        </div>
      ) : (
        <>
          <div className="actions"><button className="btn primary" disabled={busy} onClick={() => void connect()}>Kết nối Zalo OA</button></div>
          <p className="small muted">Địa chỉ gọi về khai báo trong ứng dụng Zalo của nền tảng: <code>{zaloRedirectUri}</code></p>
        </>
      ))}

      <h3>Mẫu tin ZNS</h3>
      <p className="small muted">Nhập mã mẫu ZNS đã được Zalo duyệt.</p>
      {KINDS.map((k) => (
        <div key={k.kind} className="grid2">
          <label>{k.label}
            <input value={tpl[k.kind].id} inputMode="numeric" placeholder="Mã mẫu ZNS" onChange={(e) => setTpl({ ...tpl, [k.kind]: { ...tpl[k.kind], id: e.target.value } })} />
            <span className="small muted">Tên tham số trong mẫu: {k.params}</span>
          </label>
          <label className="check"><input type="checkbox" checked={tpl[k.kind].on} onChange={(e) => setTpl({ ...tpl, [k.kind]: { ...tpl[k.kind], on: e.target.checked } })} /> Bật gửi</label>
        </div>
      ))}
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => {
          for (const k of KINDS) await rpc('save_zalo_template', { p_kind: k.kind, p_template_id: tpl[k.kind].id, p_enabled: tpl[k.kind].on });
        }, 'Đã lưu mẫu tin Zalo')}>Lưu mẫu tin</button>
      </div>

      {st?.connected && (
        <>
          <div className="item-head">
            <h3>Tin đã gửi ({st.waiting} chờ, {st.failed} lỗi)</h3>
            <div className="actions">
              <button className="btn small" disabled={busy} onClick={() => void run(async () => {
                const r = await zaloFlushNow();
                toast(r.failed ? 'error' : 'ok', `Đã gửi ${r.sent} tin${r.failed ? `, ${r.failed} tin chưa gửi được` : ''}`);
              })}>Gửi ngay</button>
              {st.failed > 0 && <button className="btn small" disabled={busy} onClick={() => void run(() => rpc('zalo_retry_failed').then(zaloFlushNow), 'Đã gửi lại tin lỗi')}>Gửi lại tin lỗi</button>}
            </div>
          </div>
          {msgs.length === 0 && <p className="muted">Chưa có tin.</p>}
          <ul className="list">
            {msgs.map((m) => (
              <li key={m.id} className="item small">
                {t(m.created_at)} · {m.kind === 've' ? 'Vé' : 'Hàng'} · {m.phone} · <span className={`badge ${m.status === 'loi' ? 'locked' : m.status === 'da_gui' ? '' : 'warn-badge'}`}>{MSG_STATUS[m.status] ?? m.status}</span>
                {m.error ? <span className="muted"> · {m.error}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
