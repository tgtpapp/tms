// Điều hành → Bảng phân công lịch tài & xe + Nghiệm thu an toàn (1 bản / lái xe / ngày): xem, in, lưu PDF vào Lưu trữ hồ sơ.
import { useState } from 'react';
import { Modal } from './Modal';
import { fmtDate } from './Documents';
import { assignPages, driversOf, loadDay, missing, monthPath, newCache, resetFolders, safetyPage, savePdfMany, type DayData, type PdfSpec } from '../lib/dispatchPapers';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';

const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function DispatchPapers({ day, tenantId, me, canSave, onClose }: { day: string; tenantId: string; me: { id: string | null; name: string }; canSave: boolean; onClose: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState(day);
  const [to, setTo] = useState(day);
  const [pc, setPc] = useState(true);
  const [nt, setNt] = useState(true);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<string[] | null>(null);
  const [retry, setRetry] = useState<{ label: string; spec: () => PdfSpec; kind: 'pc' | 'nt' }[]>([]);
  const [view, setView] = useState<{ d: DayData; html: { h: string; land: boolean }[] } | null>(null);

  async function preview() {
    setBusy('Đang chuẩn bị…');
    try {
      const d = await loadDay(from, tenantId, me);
      if (!d.rows.length) { toast('error', `Ngày ${fmtDate(from)} chưa có chuyến nào được xếp xe / lái xe`); return; }
      const html = [...(pc ? assignPages(d).map((h) => ({ h, land: true })) : []), ...(nt ? driversOf(d).map((x) => ({ h: safetyPage(d, x), land: false })) : [])];
      setView({ d, html });
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (from > to) return toast('error', 'Khoảng ngày không hợp lệ');
    const days: string[] = [];
    for (let d = from; d <= to; d = addDay(d, 1)) days.push(d);
    if (days.length > 120) return toast('error', 'Tối đa 120 ngày mỗi lần');
    const log: string[] = [], miss: string[] = [];
    const cache = newCache();
    resetFolders();
    // 1) Đọc dữ liệu các ngày (song song 4 ngày một lượt, dữ liệu chung chỉ tải 1 lần)
    setBusy(`Đang đọc lịch chạy ${days.length} ngày…`);
    const jobs: Job[] = [];
    for (let i = 0; i < days.length; i += 4) {
      const part = await Promise.all(days.slice(i, i + 4).map((d) => loadDay(d, tenantId, me, cache).then((x) => x, (e: unknown) => { log.push(`${fmtDate(d)}: ${errMsg(e)}`); return null; })));
      for (const data of part) {
        if (!data || !data.rows.length) continue;
        const d = data.day, m = missing(data);
        if (m.length && !force) { miss.push(`${fmtDate(d)}: ${m.join('; ')}`); continue; }
        if (pc) jobs.push({ kind: 'pc', label: `bảng phân công ${fmtDate(d)}`, spec: () => ({ path: monthPath(d, 'Bảng phân công lịch tài & xe'),
          name: `Bảng phân công lịch tài & xe ngày ${fmtDate(d)}`, fileName: `Bang phan cong ${d}.pdf`, pages: assignPages(data).map((html) => ({ html, land: true })),
          note: `Lưu từ Điều hành (${data.rows.length} chuyến)`, key: `pc:${d}` }) });
        if (nt) for (const x of driversOf(data)) jobs.push({ kind: 'nt', label: `nghiệm thu ${x.p.name} ${fmtDate(d)}`, spec: () => ({ path: monthPath(d, 'Nghiệm thu an toàn'),
          name: `Nghiệm thu an toàn ${fmtDate(d)} · ${x.p.name}`, fileName: `${x.no.replace(/\//g, '_')}.pdf`, pages: [{ html: safetyPage(data, x), land: false }],
          note: `${x.rows.length} chuyến · Kết luận: ĐẠT`, key: `ntat:${d}:${x.p.id}` }) });
      }
      setBusy(`Đang đọc lịch chạy ${Math.min(i + 4, days.length)}/${days.length} ngày…`);
    }
    await runJobs(jobs, log, miss);
  }
  type Job = { label: string; spec: () => PdfSpec; kind: 'pc' | 'nt' };
  /** Dựng PDF song song và gửi theo lô lên Google Drive (mỗi lô tự thử lại khi mạng / máy chủ bận). Mục lỗi giữ lại để bấm "Lưu lại". */
  async function runJobs(jobs: Job[], log: string[] = [], miss: string[] = []) {
    const t0 = Date.now();
    setBusy(`Đang tạo PDF 0/${jobs.length}…`);
    const r = jobs.length ? await savePdfMany(jobs, (_d, _t, phase) => setBusy(`${phase}…`)) : { ok: [], failed: [], oldScript: false };
    setBusy(null);
    const okPc = r.ok.filter((j) => j.kind === 'pc').length, okNt = r.ok.length - okPc;
    for (const f of r.failed) log.push(`${f.job.label}: ${f.error}`);
    setRetry(r.failed.map((f) => f.job));
    const msg = `Đã lưu ${okPc} bảng phân công, ${okNt} bản nghiệm thu an toàn trong ${Math.round((Date.now() - t0) / 1000)} giây${r.failed.length ? ` · ${r.failed.length} tệp chưa lưu được` : ''}`;
    setOut([msg, ...(r.oldScript ? ['Mã Apps Script trên Google Drive đang là bản cũ nên lưu chậm: vào Cấu hình → Kho hồ sơ Google Drive, chép lại mã mới và triển khai phiên bản mới.'] : []),
      ...(miss.length ? [`${miss.length} ngày còn chuyến thiếu xe / lái xe (chưa lưu):`, ...miss] : []), ...log.slice(-30)]);
    toast(r.failed.length ? 'error' : 'ok', msg);
  }


  if (view) {
    return (
      <div className="lenh-overlay">
        <div className="lenh-bar no-print">
          <b>{fmtDate(view.d.day)} · {view.d.rows.length} chuyến</b>
          <button className="btn small primary" onClick={() => window.print()}>In</button>
          <button className="btn small" onClick={() => setView(null)}>Đóng</button>
        </div>
        <div className="print-stack">{view.html.map((p, i) => <div key={i} className={`lenh dp${p.land ? ' land' : ''}`} dangerouslySetInnerHTML={{ __html: p.h }} />)}</div>
      </div>
    );
  }

  return (
    <Modal title="Bảng phân công & nghiệm thu an toàn" onClose={onClose}>
      <div className="form">
        <div className="grid2">
          <label>Từ ngày<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Đến ngày<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={pc} onChange={(e) => setPc(e.target.checked)} /> Bảng phân công lịch tài &amp; xe (1 bản / ngày)</label>
        <label className="check"><input type="checkbox" checked={nt} onChange={(e) => setNt(e.target.checked)} /> Nghiệm thu an toàn (1 bản chung cho các giờ trong ngày của từng lái xe)</label>
        <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Vẫn lưu ngày còn chuyến thiếu xe / lái xe</label>
        {busy && <p className="upload">{busy}</p>}
        <div className="actions">
          <button className="btn" disabled={!!busy || (!pc && !nt)} onClick={() => void preview()}>Xem / in ngày {fmtDate(from)}</button>
          {canSave && <button className="btn primary" disabled={!!busy || (!pc && !nt)} onClick={() => void save()}>Lưu vào hồ sơ</button>}
        </div>
        {!canSave && <p className="small muted">Lưu vào hồ sơ cần quyền "Lưu trữ hồ sơ: thêm, sửa".</p>}
        {retry.length > 0 && !busy && <button type="button" className="btn primary" onClick={() => { resetFolders(); void runJobs(retry); }}>Lưu lại {retry.length} tệp chưa lưu được</button>}
        {out && <ul className="queue-list small">{out.map((x, i) => <li key={i} className={i ? 'error-text' : ''}>{x}</li>)}</ul>}
      </div>
    </Modal>
  );
}
