// Duyệt thiết bị lạ + đăng nhập máy tính bằng mã QR (như Zalo).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Centered } from './Centered';
import { Modal } from './Modal';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { deviceId, deviceName, qrJustUsed, setQrJustUsed } from '../lib/device';
import { useToast } from '../lib/toast';
import { bioAvailable, bioConfirm } from '../lib/bioLock';

/** Báo thiết bị khi mở app. Trả 'ok' / 'cho_duyet'; lỗi mạng coi như 'ok' (dữ liệu vẫn do database chặn). */
export async function deviceHello(): Promise<'ok' | 'cho_duyet' | 'chi_qr' | 'cho_quan_ly'> {
  const qr = qrJustUsed();
  try {
    const d = deviceName();
    const r = await rpc<string>('device_hello', { p_device_id: deviceId(), p_name: d.name, p_qr: qr?.id ?? null, p_qr_secret: qr?.secret ?? null, p_desktop: !d.mobile });
    if (qr) setQrJustUsed(null);
    return r === 'cho_duyet' || r === 'chi_qr' || r === 'cho_quan_ly' ? r : 'ok';
  } catch {
    return 'ok';
  }
}

/** Màn chờ: thiết bị lạ đăng nhập bằng mật khẩu, chờ cho phép từ thiết bị đang dùng */
export function PendingDevice({ onOk, manager }: { onOk: () => void; manager?: boolean }) {
  useEffect(() => {
    const t = setInterval(() => { void deviceHello().then((r) => { if (r === 'ok') onOk(); }); }, 3000);
    return () => clearInterval(t);
  }, [onOk]);
  return (
    <Centered>
      <section className="card form narrow">
        <h2>{manager ? 'Chờ quản lý cho phép' : 'Chờ cho phép thiết bị'}</h2>
        {manager
          ? <p>Đã gửi thông báo cho người quản lý tài khoản trong nhà xe. Khi quản lý bấm <b>Cho phép</b>, máy tính này vào app bằng mật khẩu được.</p>
          : <><p>Đây là thiết bị mới đăng nhập tài khoản của bạn ({deviceName().name}).</p>
             <p>Mở app trên điện thoại (hoặc máy) bạn vẫn đang dùng, bấm <b>Cho phép</b> ở thông báo "Có thiết bị mới đăng nhập". Hoặc nhờ người quản lý tài khoản trong nhà xe cho phép.</p></>}
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
  const [bio, setBio] = useState(false);
  useEffect(() => { void bioAvailable().then(setBio); }, []);
  const [hidden, setHidden] = useState<string[]>([]);
  const [scan, setScan] = useState(false);
  // Bấm thông báo "Xin đăng nhập bằng mật khẩu trên máy tính" ở chuông: mở ngay danh sách chờ duyệt
  useEffect(() => {
    const on = () => { setHidden([]); void rpc<Pending[]>('pending_devices').then(setList).catch(() => undefined); };
    window.addEventListener('tms-thiet-bi', on);
    return () => window.removeEventListener('tms-thiet-bi', on);
  }, []);
  useEffect(() => {
    const open = () => setScan(true);
    window.addEventListener('tms-qr-scan', open);
    return () => window.removeEventListener('tms-qr-scan', open);
  }, []);
  const found = useCallback((id: string) => {
    setScan(false);
    void rpc<{ name: string | null; status: string } | null>('qr_info', { p_id: id })
      .then((r) => setQr(r ? { id, ...r } : { id, name: null, status: 'het_han' }))
      .catch((e) => toast('error', errMsg(e)));
  }, [toast]);

  const load = useCallback(async () => {
    if (document.hidden || !navigator.onLine) return;
    try { setList(await rpc<Pending[]>('pending_devices')); } catch { /* bỏ qua */ }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);   // quay lại app thì kiểm tra ngay
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
  /** Đồng ý sau khi chủ máy xác nhận vân tay / Face ID / mã khóa máy */
  async function qrConfirm() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id ?? '';
    if (!uid || !(await bioConfirm(uid, data.user?.email ?? 'TMS'))) { toast('error', 'Chưa xác nhận được vân tay / Face ID / mã khóa máy'); return; }
    await qrDecide(true);
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
      {scan && <QrScanner onFound={found} onClose={() => setScan(false)} />}
      {qr && (
        <div className="qr-ok" role="dialog" aria-modal="true" aria-label="Đăng nhập trên máy tính">
          <div className="qr-ok-top"><b>Đăng nhập trên máy tính</b>
            <button type="button" className="qr-ok-x" aria-label="Đóng" onClick={() => setQr(null)}>✕</button></div>
          {qr.status === 'cho' ? <>
            <div className="qr-ok-mid">
              <div className="qr-ok-ic" aria-hidden="true">💻</div>
              <p className="qr-ok-q">Cho phép đăng nhập tài khoản của bạn trên</p>
              <p className="qr-ok-dev">{qr.name ?? 'máy tính'}</p>
              <p className="qr-ok-note">Chỉ đồng ý khi chính bạn vừa mở mã QR trên máy tính đó.</p>
            </div>
            <div className="qr-ok-acts">
              {bio ? <button type="button" className="btn primary" disabled={busy} onClick={() => void qrConfirm()}>🔒 Đồng ý · xác nhận vân tay / Face ID / mã khóa máy</button>
                : <button type="button" className="btn primary" disabled={busy} onClick={() => void qrDecide(true)}>Đồng ý</button>}
              <button type="button" className="btn" disabled={busy} onClick={() => void qrDecide(false)}>Từ chối</button>
            </div>
          </> : <div className="qr-ok-mid"><div className="qr-ok-ic" aria-hidden="true">⌛</div>
            <p className="qr-ok-q">Mã QR đã hết hạn hoặc đã dùng.</p><p className="qr-ok-note">Bấm <b>Làm mới mã</b> trên máy tính rồi quét lại.</p></div>}
        </div>
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

type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

/** Quét mã QR đăng nhập máy tính ngay trong app (như Zalo): mở camera sau, thấy mã thì hỏi Đồng ý */
function QrScanner({ onFound, onClose }: { onFound: (id: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stop = false;
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!BD) { setErr('Điện thoại này chưa quét được trong app. Mở camera của điện thoại, quét mã trên máy tính rồi bấm vào đường dẫn hiện ra.'); return; }
    const det = new BD({ formats: ['qr_code'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stop || !video.current) return;
          try {
            const r = await det.detect(video.current);
            const m = r.map((x) => /(?:[#&]qr=)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(x.rawValue)).find(Boolean);
            if (m) { stop = true; onFound(m[1]!); return; }
          } catch { /* khung hình lỗi: bỏ qua */ }
          timer = window.setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch {
        setErr('Không mở được camera. Cho phép app dùng camera rồi thử lại.');
      }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onFound]);
  return (
    <Modal title="Quét mã QR đăng nhập máy tính" onClose={onClose}>
      {err ? <p>{err}</p> : (
        <div className="qr-scan">
          <video ref={video} playsInline muted />
          <p className="muted small">Hướng camera vào mã QR trên màn hình máy tính.</p>
        </div>
      )}
    </Modal>
  );
}
