// Nút xem / in / lưu vào hồ sơ cho Lý lịch hành nghề người lái xe và Lý lịch phương tiện; lưu cả đội / cả đoàn xe một lượt.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { resetFolders } from '../lib/dispatchPapers';
import {
  DRIVER_PATH, VEHICLE_PATH, driverPages, loadDriverPaper, loadVehiclePaper, saveDriverPaper, saveVehiclePaper, sharedBase, vehiclePages, type Page,
} from '../lib/profilePapers';

export type Me = { id: string | null; name: string };
type Kind = 'driver' | 'vehicle';

/** Xem trước các trang A4, bấm In. */
export function PaperView({ title, pages, onClose, onPrint }: { title: string; pages: Page[]; onClose: () => void; onPrint?: () => void }) {
  return createPortal(
    <div className="lenh-overlay paper-top">
      <div className="lenh-bar no-print">
        <b>{title}</b>
        <button className="btn small primary" onClick={() => { onPrint?.(); window.print(); }}>In</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className="print-stack">{pages.map((p, i) => <div key={i} className={`lenh dp${p.land ? ' land' : ''}`} dangerouslySetInnerHTML={{ __html: p.html }} />)}</div>
    </div>, document.body);
}

/** Nút "Xem / in lý lịch" + "Lưu vào hồ sơ" cho 1 lái xe hoặc 1 xe. */
export function PaperActions({ kind, id, label, tenantId, me, canSave }: { kind: Kind; id: string; label: string; tenantId: string; me: Me; canSave: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [view, setView] = useState<Page[] | null>(null);
  const what = kind === 'driver' ? 'lý lịch hành nghề' : 'lý lịch phương tiện';

  async function preview() {
    setBusy('Đang lấy dữ liệu…');
    try { setView(kind === 'driver' ? driverPages(await loadDriverPaper(tenantId, id, me)) : vehiclePages(await loadVehiclePaper(tenantId, id, me))); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function save() {
    setBusy('Đang tạo PDF và lưu…');
    try {
      resetFolders();
      if (kind === 'driver') await saveDriverPaper(await loadDriverPaper(tenantId, id, me));
      else await saveVehiclePaper(await loadVehiclePaper(tenantId, id, me));
      toast('ok', `Đã lưu ${what} ${label} vào hồ sơ`);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  return (
    <>
      <div className="actions paper-acts">
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void preview()}>🖨 Xem / in {what}</button>
        {canSave && <button type="button" className="btn small" disabled={!!busy} onClick={() => void save()}>💾 Lưu {what} vào hồ sơ</button>}
        {busy && <span className="small muted">{busy}</span>}
      </div>
      {view && <PaperView title={`${what.charAt(0).toUpperCase()}${what.slice(1)} · ${label}`} pages={view} onClose={() => setView(null)} />}
    </>
  );
}

/** Lưu lý lịch cho cả danh sách (mỗi người / mỗi xe 1 tệp, đã có thì thay bản mới). */
export function BulkPaperSave({ kind, items, tenantId, me, onClose }: { kind: Kind; items: { id: string; label: string }[]; tenantId: string; me: Me; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState<string[] | null>(null);
  const what = kind === 'driver' ? 'lý lịch hành nghề' : 'lý lịch phương tiện';
  const path = (kind === 'driver' ? DRIVER_PATH() : VEHICLE_PATH()).join(' › ');

  async function run() {
    resetFolders();
    const base = sharedBase();
    const errs: string[] = [];
    let ok = 0, done = 0;
    setLog(null);
    const queue = [...items];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        try {
          if (kind === 'driver') await saveDriverPaper(await loadDriverPaper(tenantId, it.id, me, base));
          else await saveVehiclePaper(await loadVehiclePaper(tenantId, it.id, me, base));
          ok++;
        } catch (e) { errs.push(`${it.label}: ${errMsg(e)}`); }
        setBusy(`Đã lưu ${++done}/${items.length}…`);
      }
    };
    setBusy(`Đã lưu 0/${items.length}…`);
    await Promise.all([worker(), worker()]);
    setBusy('');
    const msg = `Đã lưu ${what} của ${ok}/${items.length} ${kind === 'driver' ? 'lái xe' : 'xe'}`;
    setLog([msg, ...errs]);
    toast(errs.length ? 'error' : 'ok', msg);
  }
  return (
    <Modal title={`Lưu ${what} vào hồ sơ`} onClose={() => { if (!busy) onClose(); }}>
      <div className="form">
        <p className="small">Tự lấy thông tin của từng {kind === 'driver' ? 'lái xe' : 'xe'} ({items.length}) và lưu mỗi {kind === 'driver' ? 'người' : 'xe'} 1 tệp PDF vào <b>{path}</b>.
          Đã có thì thay bằng bản mới (bản cũ ẩn).</p>
        <p className="small muted">Mẫu sổ: cần xác minh.</p>
        {busy && <p className="upload">{busy}</p>}
        <div className="actions">
          <button className="btn primary" disabled={!!busy || !items.length} onClick={() => void run()}>Lưu {items.length} tệp</button>
          <button className="btn" disabled={!!busy} onClick={onClose}>Đóng</button>
        </div>
        {log && <ul className="queue-list small">{log.map((x, i) => <li key={i} className={i ? 'error-text' : ''}>{x}</li>)}</ul>}
      </div>
    </Modal>
  );
}
