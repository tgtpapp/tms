// Cấu hình › Sao lưu & khôi phục (chỉ Chủ nhà xe): tải bản sao lưu, khôi phục từ file hoặc từ bản tự sao lưu mỗi đêm trên Google Drive.
import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { exportTenant, fetchDriveBackup, gzip, readBackup, restoreTenant, type BackupFile } from '../lib/backup';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Saved { id: string; kind: 'dem' | 'tay'; file_name: string; size_bytes: number | null; row_count: number | null; created_at: string }
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
const mb = (n: number | null) => (n ? `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB` : '');

export function BackupPanel() {
  const toast = useToast();
  const [owner, setOwner] = useState(false);
  const [list, setList] = useState<Saved[]>([]);
  const [busy, setBusy] = useState('');
  const [ask, setAsk] = useState<{ file: BackupFile; from: string } | null>(null);

  const load = useCallback(async () => {
    const r = await supabase.from('tenant_backups').select('id, kind, file_name, size_bytes, row_count, created_at').order('created_at', { ascending: false }).limit(60);
    setList((r.data ?? []) as Saved[]);
  }, []);
  useEffect(() => {
    void rpc('backup_tables', {}).then(() => { setOwner(true); void load(); }).catch(() => setOwner(false));
  }, [load]);
  if (!owner) return null;

  async function download() {
    try {
      const t = (await supabase.from('tenants').select('name').maybeSingle()).data as { name?: string } | null;
      const { file, rows } = await exportTenant(t?.name ?? '', setBusy);
      setBusy('Đang nén file…');
      const bytes = await gzip(JSON.stringify(file));
      const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/gzip' }));
      a.download = `sao-luu_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json.gz`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('ok', `Đã tải bản sao lưu: ${rows.toLocaleString('vi-VN')} dòng dữ liệu`);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function openFile(f: File | undefined) {
    if (!f) return;
    try {
      setBusy('Đang đọc file sao lưu…');
      setAsk({ file: await readBackup(new Uint8Array(await f.arrayBuffer())), from: f.name });
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function openSaved(s: Saved) {
    try {
      setBusy('Đang tải bản sao lưu từ Google Drive…');
      setAsk({ file: await readBackup(await fetchDriveBackup(s.id)), from: `bản ${when(s.created_at)}` });
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function restore() {
    if (!ask) return;
    const f = ask.file;
    setAsk(null);
    try {
      const r = await restoreTenant(f, setBusy);
      toast('ok', r.added ? `Đã khôi phục ${r.added.toLocaleString('vi-VN')} dòng bị thiếu${r.failed ? ` · ${r.failed} dòng không khôi phục được` : ''}` : 'Dữ liệu đang đủ, không có dòng nào cần khôi phục');
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }

  return (
    <section className="card">
      <h2>Sao lưu &amp; khôi phục dữ liệu</h2>
      <p className="small muted">
        Mỗi đêm app tự sao lưu toàn bộ dữ liệu nhà xe vào Kho hồ sơ Google Drive (thư mục "Sao lưu dữ liệu", giữ 30 bản gần nhất).
        Ảnh, tệp giấy tờ không nằm trong file sao lưu (vẫn ở kho tệp của app và Google Drive). Chỉ Chủ nhà xe dùng được mục này.
      </p>
      <div className="actions">
        <button type="button" className="btn primary" disabled={!!busy} onClick={() => void download()}>Tải bản sao lưu về máy</button>
        <label className={busy ? 'btn disabled' : 'btn'}>Khôi phục từ file…
          <input type="file" accept=".gz,.json,application/gzip,application/json" hidden aria-label="Chọn file sao lưu" disabled={!!busy}
                 onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void openFile(f); }} />
        </label>
      </div>
      {busy && <p className="small" role="status">{busy}</p>}
      <h3>Bản tự sao lưu trên Google Drive ({list.length})</h3>
      {list.length === 0 && <p className="small muted">Chưa có. Bản đầu tiên tạo vào đêm nay (cần kết nối Kho hồ sơ Google Drive).</p>}
      <ul className="list">
        {list.map((s) => (
          <li key={s.id} className="item">
            <div className="item-head">
              <span><b>{when(s.created_at)}</b> <span className="small muted">· {s.kind === 'dem' ? 'tự động' : 'bấm tay'}{s.row_count ? ` · ${s.row_count.toLocaleString('vi-VN')} dòng` : ''}{s.size_bytes ? ` · ${mb(s.size_bytes)}` : ''}</span></span>
              <button type="button" className="btn small" disabled={!!busy} onClick={() => void openSaved(s)}>Khôi phục từ bản này</button>
            </div>
          </li>
        ))}
      </ul>
      {ask && (
        <Modal title="Khôi phục dữ liệu" onClose={() => setAsk(null)}>
          <div className="form">
            <p>Từ {ask.from} (sao lưu lúc {when(ask.file.created_at)}, {ask.file.pages.length} phần dữ liệu).</p>
            <ul className="small">
              <li>Chỉ <b>thêm lại các dòng đang bị thiếu</b>. Dữ liệu đang có giữ nguyên, không ghi đè, không xóa.</li>
              <li>Dữ liệu đã cố ý xóa sau ngày sao lưu sẽ hiện lại.</li>
              <li>Không khôi phục tài khoản, nhóm quyền, phân quyền (tránh cấp lại quyền đã thu hồi).</li>
              <li>File chỉ khôi phục được cho đúng nhà xe đã sao lưu; file bị sửa sẽ bị từ chối.</li>
            </ul>
            <div className="actions">
              <button type="button" className="btn primary" onClick={() => void restore()}>Khôi phục</button>
              <button type="button" className="btn" onClick={() => setAsk(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
