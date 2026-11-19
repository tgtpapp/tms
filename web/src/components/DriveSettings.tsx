// Cấu hình Kho hồ sơ Google Drive (Apps Script) của nhà xe.
import { useCallback, useEffect, useState } from 'react';
import { errMsg, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { DRIVE_SCRIPT, drive } from '../lib/drive';

interface St { configured: boolean; url: string | null; updated_at: string | null }
interface Ping { used: number; limit: number; folder: string; name: string }
const mb = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${Math.round(n / 1048576)} MB`);

export function DriveSettings() {
  const toast = useToast();
  const [st, setSt] = useState<St | null>(null);
  const [f, setF] = useState({ url: '', key: '' });
  const [ping, setPing] = useState<Ping | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const load = useCallback(async () => {
    try { setSt(await rpc<St>('drive_status')); } catch (e) { toast('error', errMsg(e)); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function save(url: string, key: string, ok: string) {
    setBusy(true);
    try {
      await rpc('save_drive_config', { p_url: url, p_key: key });
      toast('ok', ok);
      setF({ url: '', key: '' });
      setPing(null);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      setPing(await drive<Ping>({ action: 'ping' }));
      toast('ok', 'Kết nối Google Drive tốt');
    } catch (e) {
      setPing(null);
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form">
      <h2>Kho hồ sơ Google Drive (Apps Script)</h2>
      <p className="small muted">Tệp ở mục Lưu trữ hồ sơ được lưu trên Google Drive của nhà xe, qua Apps Script (như app cũ).
        Mã kết nối chỉ lưu trên máy chủ, không hiện lại trên trình duyệt.</p>
      {st && (st.configured
        ? <p className="small">Đang kết nối: <code>{st.url}</code>{st.updated_at ? ` · cập nhật ${new Date(st.updated_at).toLocaleString('vi-VN')}` : ''}</p>
        : <p className="small state-sap_het">Chưa kết nối Google Drive.</p>)}
      {ping && (
        <p className="small state-con_han">Drive đã dùng {mb(ping.used)}{ping.limit ? ` / ${mb(ping.limit)}` : ''} · thư mục gốc{' '}
          <a href={ping.folder} target="_blank" rel="noopener noreferrer">{ping.name}</a></p>
      )}
      <div className="grid2">
        <label>Địa chỉ Web app<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://script.google.com/macros/s/…/exec" /></label>
        <label>Mã kết nối{st?.configured ? ' (để trống = giữ mã cũ)' : ''}<input type="password" autoComplete="off" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></label>
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || !f.url.trim()} onClick={() => void save(f.url, f.key, 'Đã lưu kết nối Google Drive')}>Lưu kết nối</button>
        {st?.configured && <button type="button" className="btn" disabled={busy} onClick={() => void test()}>Kiểm tra kết nối</button>}
        {st?.configured && <button type="button" className="btn link" disabled={busy} onClick={() => void save('', '', 'Đã bỏ kết nối Google Drive')}>Bỏ kết nối</button>}
        <button type="button" className="btn link" onClick={() => setShowCode(!showCode)}>{showCode ? 'Ẩn mã Apps Script' : 'Xem mã Apps Script'}</button>
      </div>
      {showCode && (
        <>
          <ol className="small">
            <li>Mở script.google.com bằng tài khoản Google của nhà xe → Dự án mới → dán toàn bộ mã dưới đây.</li>
            <li>Đổi dòng <code>MA_KET_NOI</code> thành mã riêng (ít nhất 6 ký tự).</li>
            <li>Triển khai → Tùy chọn triển khai mới → Ứng dụng web · Thực thi bằng: Tôi · Ai có quyền truy cập: Bất kỳ ai → cấp quyền Drive.</li>
            <li>Copy địa chỉ Web app (đuôi /exec) và mã kết nối vào 2 ô trên → Lưu kết nối → Kiểm tra kết nối.</li>
          </ol>
          <div className="actions">
            <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(DRIVE_SCRIPT).then(() => toast('ok', 'Đã chép mã Apps Script'))}>Chép mã</button>
          </div>
          <pre className="code-box">{DRIVE_SCRIPT}</pre>
        </>
      )}
    </section>
  );
}
