// Duyệt thiết bị lạ + đăng nhập máy tính bằng mã QR (như Zalo).
import { useCallback, useEffect, useState } from 'react';
import { Centered } from './Centered';
import { Modal } from './Modal';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { deviceId, deviceName, qrJustUsed, setQrJustUsed } from '../lib/device';
import { useToast } from '../lib/toast';

/** Báo thiết bị khi mở app. Trả 'ok' / 'cho_duyet'; lỗi mạng coi như 'ok' (dữ liệu vẫn do database chặn). */
export async function deviceHello(): Promise<'ok' | 'cho_duyet'> {
  const qr = qrJustUsed();
  try {
    const r = await rpc<string>('device_hello', { p_device_id: deviceId(), p_name: deviceName().name, p_qr: qr?.id ?? null, p_qr_secret: qr?.secret ?? null });
    if (qr) setQrJustUsed(null);
    return r === 'cho_duyet' ? 'cho_duyet' : 'ok';
  } catch {
    return 'ok';
  }
}

/** Màn chờ: thiết bị lạ đăng nhập bằng mật khẩu, chờ cho phép từ thiết bị đang dùng */
export function PendingDevice({ onOk }: { onOk: () => void }) {
  useEffect(() => {
    const t = setInterval(() => { void deviceHello().then((r) => { if (r === 'ok') onOk(); }); }, 3000);
    return () => clearInterval(t);
  }, [onOk]);
  return (
    <Centered>
      <section className="card form narrow">
        <h2>Chờ cho phép thiết bị</h2>
        <p>Đây là thiết bị mới đăng nhập tài khoản của bạn ({deviceName().name}).</p>
        <p>Mở app trên điện thoại (hoặc máy) bạn vẫn đang dùng, bấm <b>Cho phép</b> ở thông báo "Có thiết bị mới đăng nhập". Hoặc nhờ người quản lý tài khoản trong nhà xe cho phép.</p>
        <p className="muted small">Màn hình tự vào app ngay khi được cho phép.</p>
        <button type="button" className="btn" onClick={() => void supabase.auth.signOut({ scope: 'local' })}>Thoát</button>
      </section>
    </Centered>
  );
}

interface Pending { session_id: string; user_id: string; full_name: string; name: string | null; ip: string | null; created_at: string; mine: boolean }

/** Đang dùng app: báo thiết bị mới chờ cho phép (của mình, và của nhân viên nếu là quản lý) + điện thoại quét mã QR của máy tính */
export function DeviceApprovals() {
  const toast = useToast();
  const [list, setList] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ id: string; name: string | null; status: string } | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (document.hidden || !navigator.onLine) return;
    try { setList(await rpc<Pending[]>('pending_devices')); } catch { /* bỏ qua */ }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    document.addEventListener('visibilitychange', load);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', load); };
  }, [load]);

  // Quét mã QR trên máy tính bằng camera điện thoại: mở app với #qr=<mã>
  useEffect(() => {
    const check = () => {
      const m = /[#&]qr=([0-9a-f-]{36})/i.exec(location.hash);
      if (!m) return;
      history.replaceState(null, '', location.pathname + location.search);
      void rpc<{ name: string | null; status: string } | null>('qr_info', { p_id: m[1] })
        .then((r) => setQr(r ? { id: m[1]!, ...r } : { id: m[1]!, name: null, status: 'het_han' }))
        .catch((e) => toast('error', errMsg(e)));
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [toast]);

  async function decide(id: string, ok: boolean) {
    setBusy(true);
    try {
      await rpc('approve_device', { p_session_id: id, p_ok: ok });
      toast('ok', ok ? 'Đã cho phép thiết bị' : 'Đã từ chối, thiết bị đó bị đăng xuất');
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  async function qrDecide(ok: boolean) {
    if (!qr) return;
    setBusy(true);
    try {
      await rpc('qr_approve', { p_id: qr.id, p_ok: ok });
      toast('ok', ok ? 'Đã cho máy tính đăng nhập' : 'Đã từ chối');
      setQr(null);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }

  const shown = list.filter((x) => !hidden.includes(x.session_id));
  return (
    <>
      {qr && (
        <Modal title="Đăng nhập trên máy tính" onClose={() => setQr(null)}>
          {qr.status === 'cho' ? (
            <div className="form">
              <p>Cho phép <b>{qr.name ?? 'máy tính'}</b> đăng nhập tài khoản của bạn?</p>
              <p className="muted small">Chỉ đồng ý khi chính bạn vừa mở mã QR trên máy tính đó.</p>
              <div className="actions">
                <button type="button" className="btn primary" disabled={busy} onClick={() => void qrDecide(true)}>Đồng ý</button>
                <button type="button" className="btn" disabled={busy} onClick={() => void qrDecide(false)}>Từ chối</button>
              </div>
            </div>
          ) : <p>Mã QR đã hết hạn hoặc đã dùng. Bấm <b>Làm mới mã</b> trên máy tính rồi quét lại.</p>}
        </Modal>
      )}
      {!qr && shown.length > 0 && (
        <Modal title="Có thiết bị mới đăng nhập" onClose={() => setHidden([...hidden, ...shown.map((x) => x.session_id)])}>
          <ul className="list">
            {shown.map((x) => (
              <li key={x.session_id} className="item">
                <b>{x.name ?? 'Thiết bị không rõ'}</b>{!x.mine && <> · tài khoản <b>{x.full_name}</b></>}
                <div className="small muted">Lúc {new Date(x.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })}{x.ip ? ` · IP ${x.ip}` : ''}</div>
                <p className="small">{x.mine ? 'Nếu không phải bạn vừa đăng nhập, bấm Từ chối và đổi mật khẩu.' : 'Chỉ cho phép khi đúng nhân viên đó đang đăng nhập.'}</p>
                <div className="actions">
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void decide(x.session_id, true)}>Cho phép</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void decide(x.session_id, false)}>Từ chối</button>
                </div>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
