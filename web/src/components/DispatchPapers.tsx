// Điều hành → Bảng phân công lịch tài & xe + Nghiệm thu an toàn (1 bản / lái xe / ngày): xem, in, lưu PDF vào Lưu trữ hồ sơ.
import { useState } from 'react';
import { Modal } from './Modal';
import { fmtDate } from './Documents';
import { assignPages, driversOf, loadDay, missing, monthPath, newCache, resetFolders, safetyPage, savePdf, transient, type DayData } from '../lib/dispatchPapers';
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
  const [retry, setRetry] = useState<{ label: string; run: () => Promise<void>; kind: 'pc' | 'nt' }[]>([]);
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
        if (pc) jobs.push({ kind: 'pc', label: `bảng phân công ${fmtDate(d)}`, run: () => savePdf(monthPath(d, 'Bảng phân công lịch tài & xe'),
          `Bảng phân công lịch tài & xe ngày ${fmtDate(d)}`, `Bang phan cong ${d}.pdf`, assignPages(data).map((html) => ({ html, land: true })),
          `Lưu từ Điều hành (${data.rows.length} chuyến)`, `pc:${d}`) });
        if (nt) for (const x of driversOf(data)) jobs.push({ kind: 'nt', label: `nghiệm thu ${x.p.name} ${fmtDate(d)}`, run: () => savePdf(monthPath(d, 'Nghiệm thu an toàn'),
          `Nghiệm thu an toàn ${fmtDate(d)} · ${x.p.name}`, `${x.no.replace(/\//g, '_')}.pdf`, [{ html: safetyPage(data, x), land: false }],
          `${x.rows.length} chuyến · Kết luận: ĐẠT`, `ntat:${d}:${x.p.id}`) });
      }
      setBusy(`Đang đọc lịch chạy ${Math.min(i + 4, days.length)}/${days.length} ngày…`);
    }
    await runJobs(jobs, log, miss);
  }
  type Job = { label: string; run: () => Promise<void>; kind: 'pc' | 'nt' };
  /** Tạo PDF và lưu lên Google Drive, 4 tệp cùng lúc (mỗi tệp tự thử lại khi mạng / máy chủ bận). Mục lỗi giữ lại để bấm "Lưu lại". */
  async function runJobs(jobs: Job[], log: string[] = [], miss: string[] = []) {
    let done = 0, okPc = 0, okNt = 0, stop = false, next = 0;
    const failed: Job[] = [];
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++]!;
        if (stop) { failed.push(j); continue; }
        try {
          await j.run();
          if (j.kind === 'pc') okPc++; else okNt++;
        } catch (e) {
          log.push(`${j.label}: ${errMsg(e)}`);
          failed.push(j);
          if (!transient(e)) stop = true;   // lỗi cấu hình / quyền: dừng, không thử tiếp vô ích
        }
        done++;
        setBusy(`Đang lưu ${done}/${jobs.length} tệp lên Google Drive…`);
      }
    };
    if (jobs.length) { setBusy(`Đang lưu 0/${jobs.length} tệp lên Google Drive…`); await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker)); }
    setBusy(null);
    setRetry(failed);
    const msg = `Đã lưu ${okPc} bảng phân công, ${okNt} bản nghiệm thu an toàn${failed.length ? ` · ${failed.length} tệp chưa lưu được` : ''}`;
    setOut([msg, ...(miss.length ? [`${miss.length} ngày còn chuyến thiếu xe / lái xe (chưa lưu):`, ...miss] : []), ...log.slice(-30)]);
    toast(failed.length ? 'error' : 'ok', msg);
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
        <p className="small muted">Lưu PDF vào Lưu trữ hồ sơ: <b>Năm › 08. Điều hành xe › Bảng phân công lịch tài &amp; xe / Nghiệm thu an toàn › Tháng MM-YYYY</b>.
          Ngày đã lưu thì thay bằng bản mới (bản cũ ẩn). Giờ chưa xếp xe và lái xe không đưa vào bảng.</p>
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
