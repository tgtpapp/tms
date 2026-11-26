// Cấu hình › Chuyển dữ liệu cũ sang Google Drive (chỉ Chủ nhà xe): chọn khoảng ngày (cũ hơn 12 tháng), xem số dòng, sao lưu lên Drive.
import { useCallback, useEffect, useState } from 'react';
import { ARCHIVE_TABLES, archivePreview, archiveToDrive, moveArchive, verifyArchive } from '../lib/dataArchive';
import { Modal } from './Modal';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Row { id: string; from_on: string; to_on: string; file_name: string; size_bytes: number | null; sha256: string; counts: Record<string, number>; row_count: number;
  status: 'da_sao_luu' | 'da_chuyen' | 'da_phuc_hoi'; created_at: string }
const dmy = (d: string) => d.split('-').reverse().join('/');
const n0 = (n: number) => n.toLocaleString('vi-VN');
const mb = (n: number | null) => (n ? `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB` : '');
const STATUS = { da_sao_luu: 'Đã sao lưu lên Drive (dữ liệu vẫn còn trong database)', da_chuyen: 'Đã chuyển khỏi database', da_phuc_hoi: 'Đã phục hồi' } as const;
/** Ngày cuối được chọn: cũ hơn 12 tháng */
const maxTo = () => { const d = new Date(Date.now() + 7 * 3600e3); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); };

export function ArchivePanel() {
  const toast = useToast();
  const [owner, setOwner] = useState(false);
  const [list, setList] = useState<Row[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(maxTo);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState('');
  const [mv, setMv] = useState<Row | null>(null);
  const [typed, setTyped] = useState('');
  const load = useCallback(async () => {
    const r = await supabase.from('data_archives').select('id, from_on, to_on, file_name, size_bytes, sha256, counts, row_count, status, created_at').order('created_at', { ascending: false });
    setList((r.data ?? []) as Row[]);
  }, []);
  useEffect(() => { void rpc('backup_tables', {}).then(() => { setOwner(true); void load(); }).catch(() => setOwner(false)); }, [load]);
  useEffect(() => { setCounts(null); }, [from, to]);
  if (!owner) return null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  async function preview() {
    if (!from || !to) return toast('error', 'Chọn từ ngày và đến ngày');
    try { setBusy('Đang đếm dữ liệu…'); setCounts(await archivePreview(from, to)); } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function save() {
    try {
      const r = await archiveToDrive(from, to, setBusy);
      toast('ok', `Đã sao lưu ${n0(r.rows)} dòng lên Google Drive (${mb(r.size)}) và đối chiếu khớp`);
      setCounts(null);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function move() {
    const x = mv;
    if (!x) return;
    setMv(null); setTyped('');
    try {
      await moveArchive(x.id, x.sha256, setBusy);
      toast('ok', `Đã chuyển ${n0(x.row_count)} dòng (${dmy(x.from_on)} – ${dmy(x.to_on)}) khỏi database. Bản trên Google Drive giữ để phục hồi khi cần`);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function check(x: Row) {
    try { setBusy('Đang tải từ Google Drive để đối chiếu…'); await verifyArchive(x.id, x.sha256); toast('ok', 'File trên Google Drive còn nguyên, khớp với bản đã sao lưu'); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }

  return (
    <section className="card">
      <h2>Chuyển dữ liệu cũ sang Google Drive</h2>
      <div className="grid2">
        <label>Từ ngày<input type="date" value={from} max={to || maxTo()} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Đến ngày<input type="date" value={to} max={maxTo()} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={!!busy || !from || !to} onClick={() => void preview()}>Xem số dòng</button>
        {counts && total > 0 && <button type="button" className="btn primary" disabled={!!busy} onClick={() => void save()}>Sao lưu lên Drive</button>}
      </div>
      {busy && <p className="small" role="status">{busy}</p>}
      {counts && (
        <table className="plist">
          <tbody>
            {ARCHIVE_TABLES.map(([k, l]) => <tr key={k}><td>{l}</td><td style={{ textAlign: 'right' }}><b>{n0(counts[k] ?? 0)}</b></td></tr>)}
            <tr><td><b>Tổng</b></td><td style={{ textAlign: 'right' }}><b>{n0(total)}</b></td></tr>
          </tbody>
        </table>
      )}
      <h3>Các lần đã sao lưu ({list.length})</h3>
      <ul className="list">
        {list.map((x) => (
          <li key={x.id} className="item">
            <div className="item-head">
              <span><b>{dmy(x.from_on)} – {dmy(x.to_on)}</b> <span className="small muted">· {n0(x.row_count)} dòng{x.size_bytes ? ` · ${mb(x.size_bytes)}` : ''}</span></span>
              <span className="actions">
                <button type="button" className="btn small" disabled={!!busy} onClick={() => void check(x)}>Đối chiếu với Drive</button>
                {x.status === 'da_sao_luu' && <button type="button" className="btn small danger" disabled={!!busy} onClick={() => { setTyped(''); setMv(x); }}>Xóa khỏi database</button>}
              </span>
            </div>
            <div className="small muted">{STATUS[x.status]}</div>
          </li>
        ))}
      </ul>
      {mv && (
        <Modal title={`Xóa khỏi database: ${dmy(mv.from_on)} – ${dmy(mv.to_on)}`} onClose={() => setMv(null)}>
          <div className="form">
            <table className="plist">
              <tbody>
                {ARCHIVE_TABLES.map(([k, l]) => <tr key={k}><td>{l}</td><td style={{ textAlign: 'right' }}><b>{n0(mv.counts[k] ?? 0)}</b></td></tr>)}
              </tbody>
            </table>
            <p className="small">App tải lại file từ Google Drive, khớp với bản đã sao lưu và số dòng không đổi thì mới xóa. Muốn xem lại dữ liệu này thì bấm Phục hồi.</p>
            <label>Gõ <b>XOA</b> để xác nhận<input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
            <div className="actions">
              <button type="button" className="btn danger" disabled={typed.trim().toUpperCase() !== 'XOA'} onClick={() => void move()}>Xóa khỏi database</button>
              <button type="button" className="btn" onClick={() => setMv(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
