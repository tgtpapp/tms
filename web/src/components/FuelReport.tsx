// Lái xe báo đổ dầu từ app (như app cũ): chụp trụ bơm, hóa đơn, biển số, đồng hồ km → AI đọc → số liệu khớp thì gửi duyệt luôn
// (điều hành, kế toán nhận thông báo), không khớp thì mở khung kiểm tra → gửi xong bấm 1 nút gửi ảnh + tóm tắt vào nhóm Zalo.
// Ảnh chia sẻ từ Zalo vào app (tài khoản lái xe) cũng mở thẳng khung này.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { FilesViewButton } from './FilePreview';
import { fmtDate, today } from './Documents';
import { prepareFile, type PreparedFile } from '../lib/documents';
import { plateKey, readFuelPhotos, uploadReportPhotos } from '../lib/fuelPhoto';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Sent { id: string; plate: string; entry_date: string; entry_time: string | null; liters: number; unit_price: number; amount: number | null;
  status: 'cho' | 'duyet' | 'bo'; reject_reason: string | null; files: string[]; created_at: string }
interface Form { key: string; plate: string; entry_date: string; entry_time: string; liters: string; unit_price: string; amount: string; odo_km: string;
  supplier: string; invoice_no: string; note: string }

const num = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d });
const nowTime = () => new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
const MAX = 6;
/** Mã băm ảnh gốc (SHA-256): cùng ảnh gửi lại thì nhận ra */
async function sha(f: File): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** Dòng tóm tắt gửi nhóm Zalo (dòng nào không có số liệu thì bỏ). */
function summary(f: Form, driver: string): string {
  const lit = Number(f.liters) || 0, gia = Number(f.unit_price) || 0, tien = Number(f.amount) || Math.round(lit * gia), km = Number(f.odo_km) || 0;
  const ten = driver.trim().split(/\s+/).pop() ?? '';
  return [
    '⛽ BÁO ĐỔ DẦU',
    `Xe: ${f.plate}${ten ? ` · LX: ${ten}` : ''}`,
    `Ngày: ${fmtDate(f.entry_date)}${f.entry_time ? ` ${f.entry_time.slice(0, 5)}` : ''}`,
    `Số lít: ${num(lit, 3)} lít${gia ? ` × ${num(gia)} đ` : ''}`,
    `Thành tiền: ${num(tien)} đ`,
    km ? `Km đồng hồ: ${num(km)} km` : '',
    [f.supplier.trim() && `Cây xăng: ${f.supplier.trim()}`, f.invoice_no.trim() && `HĐ số: ${f.invoice_no.trim()}`].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');
}

export function FuelReportCard({ tenantId, staffId, plates, shareFiles, onShareDone }: {
  tenantId: string; staffId: string; plates: string[]; shareFiles?: File[] | null; onShareDone?: () => void;
}) {
  const toast = useToast();
  const [pick, setPick] = useState<File[] | null>(null);           // bước 1: chụp / chọn ảnh
  const [f, setF] = useState<Form | null>(null);                     // bước 2: kiểm tra số liệu
  const form = f;
  const [prep, setPrep] = useState<PreparedFile[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [sent, setSent] = useState<Sent[]>([]);
  const [orig, setOrig] = useState<File[]>([]);                      // ảnh gốc để chia sẻ vào nhóm Zalo
  const [done, setDone] = useState<{ text: string; files: File[] } | null>(null);
  const [driver, setDriver] = useState('');
  const upRef = useRef<Promise<string[]> | null>(null);              // ảnh tải lên song song lúc AI đang đọc
  const hashRef = useRef<string[]>([]);                              // mã băm ảnh gốc: chống gửi trùng
  useEffect(() => { void supabase.from('staff_members').select('full_name').eq('id', staffId).maybeSingle().then(({ data }) => setDriver((data as { full_name?: string } | null)?.full_name ?? '')); }, [staffId]);

  const load = useCallback(async () => {
    const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const r = await supabase.from('fuel_reports').select('id, plate, entry_date, entry_time, liters, unit_price, amount, status, reject_reason, files, created_at')
      .eq('staff_id', staffId).gte('entry_date', from).order('created_at', { ascending: false }).limit(30);
    setSent(((r.data ?? []) as Sent[]).map((x) => ({ ...x, liters: Number(x.liters) })));
  }, [staffId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const u = (pick ?? []).map((x) => URL.createObjectURL(x)); setUrls(u); return () => u.forEach((x) => URL.revokeObjectURL(x)); }, [pick]);

  const add = (fs: File[]) => {
    const img = fs.filter((x) => x.type.startsWith('image/'));
    if (!img.length) return;
    setPick((cur) => { const all = [...(cur ?? []), ...img]; if (all.length > MAX) toast('error', `Tối đa ${MAX} ảnh mỗi lần đổ dầu`); return all.slice(0, MAX); });
  };

  /** Chọn ảnh có sẵn (bấm Xong) → đọc + gửi luôn, không cần bấm thêm */
  const pickAndRead = (fs: File[]) => {
    const all = [...(pick ?? []), ...fs.filter((x) => x.type.startsWith('image/'))].slice(0, MAX);
    if (!all.length) return;
    setPick(all);
    void read(all);
  };
  async function read(files: File[]) {
    // Chống trùng: ảnh này đã gửi ở phiếu khác thì báo ngay, không đọc / gửi nữa
    setPick(null);
    setBusy('Đang kiểm tra ảnh…');
    const hashes = await Promise.all(files.map(sha)).catch(() => [] as string[]);
    hashRef.current = hashes;
    const dup = hashes.length ? await rpc<string | null>('fuel_photos_sent', { p_hashes: hashes }).catch(() => null) : null;
    if (dup) { setBusy(''); toast('error', dup); return; }
    setBusy('AI đang đọc ảnh, đọc xong tự gửi…');
    const base: Form = { key: crypto.randomUUID(), plate: plates[0] ?? '', entry_date: today(), entry_time: nowTime(), liters: '', unit_price: '', amount: '', odo_km: '',
      supplier: '', invoice_no: '', note: '' };
    let p: PreparedFile[] = [];
    setOrig(files);
    try {
      p = await Promise.all(files.map(prepareFile));
      setPrep(p);
      // Tải ảnh lên ngay, song song với AI đọc (không phải chờ đọc xong mới tải)
      const up = uploadReportPhotos(tenantId, staffId, plates[0] ?? '', p);
      up.catch(() => undefined);
      upRef.current = up;
      const v = await readFuelPhotos(p);
      const k = plateKey(v.plate), mine = k.length >= 4 ? plates.find((x) => plateKey(x) === k || plateKey(x).endsWith(k.slice(-5))) : undefined;
      const nf: Form = { ...base, plate: mine ?? (v.plate || base.plate), entry_date: v.date || base.entry_date, entry_time: v.time || base.entry_time, liters: v.liters ? String(v.liters) : '',
        unit_price: v.price ? String(v.price) : '', amount: v.amount ? String(v.amount) : '', odo_km: v.km, supplier: v.supplier, invoice_no: v.invoice };
      // Số liệu chắc chắn (đúng xe của mình, có lít + giá / tiền, lít × giá khớp thành tiền) → gửi duyệt luôn, không cần kiểm tra tay
      const l = Number(nf.liters), g = Number(nf.unit_price), t = Number(nf.amount);
      const sure = !!mine && l > 0 && (g > 0 || t > 0) && !(g > 0 && t > 0 && Math.abs(Math.round(l * g) - t) > 1000);
      setPick(null);
      if (sure) { setBusy(''); await send(nf, p, files); return; }
      setF(nf);
      toast('ok', 'AI đã đọc xong, kiểm tra lại số lít, số tiền, biển số rồi gửi');
    } catch (e) {
      if (!p.length) { toast('error', errMsg(e)); setBusy(''); return; }
      setF(base);
      toast('error', `AI chưa đọc được (${errMsg(e)}). Nhập tay giúp, ảnh vẫn gửi kèm.`);
    }
    setPick(null);
    setBusy('');
  }
  // Ảnh chia sẻ từ Zalo: đọc luôn
  useEffect(() => {
    if (!shareFiles?.length) return;
    onShareDone?.();
    void read(shareFiles.filter((x) => x.type.startsWith('image/')).slice(0, MAX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareFiles]);

  async function send(f: Form | null = form, p: PreparedFile[] = prep, files: File[] = orig) {
    if (!f) return;
    const lit = Number(f.liters), gia = Number(f.unit_price), tien = Number(f.amount);
    if (!f.plate.trim()) return toast('error', 'Nhập biển số xe');
    if (!(lit > 0)) return toast('error', 'Nhập số lít');
    if (!(gia > 0) && !(tien > 0)) return toast('error', 'Nhập đơn giá hoặc thành tiền');
    setBusy('Đang gửi ảnh…');
    try {
      // Gửi phiếu ngay (chưa chờ ảnh); ảnh lưu lên Drive chạy ngầm, xong thì tự gắn vào phiếu
      await rpc('report_fuel', { p: { key: f.key, plate: f.plate, entry_date: f.entry_date, entry_time: f.entry_time, liters: lit, unit_price: gia || null,
        amount: tien || null, odo_km: f.odo_km, supplier: f.supplier, invoice_no: f.invoice_no, note: f.note, files: [], hashes: hashRef.current } });
      const early = upRef.current;
      upRef.current = null;
      void attachLater(f.key, f.plate, p, early);
      setDone({ text: summary(f, driver), files });
      setF(null); setPrep([]); setOrig([]);
      await load();
    } catch (e) {
      const m = errMsg(e);
      if (/đã gửi rồi/.test(m)) { setF(null); toast('error', m); return; }   // gửi trùng: không mở lại khung
      if (!form) setF(f);   // gửi tự động bị lỗi: mở khung để bấm Gửi lại
      toast('error', `Chưa gửi được: ${m}. Bấm Gửi lại.`);
    } finally { setBusy(''); }
  }

  /** Ảnh tải ngầm: dùng lượt tải đã chạy lúc AI đọc (lỗi thì tải lại 1 lần) rồi gắn vào phiếu */
  async function attachLater(key: string, plate: string, p: PreparedFile[], early: Promise<string[]> | null) {
    if (!p.length) return;
    try {
      const up = early ? await early.catch(() => uploadReportPhotos(tenantId, staffId, plate, p)) : await uploadReportPhotos(tenantId, staffId, plate, p);
      await rpc('attach_fuel_photos', { p_key: key, p_files: up });
      void load();
    } catch (e) {
      toast('error', `Phiếu đã gửi nhưng ảnh chưa lưu được: ${errMsg(e)}`);
    }
  }
  /** Chia sẻ ảnh + tóm tắt sang Zalo (khung chia sẻ của điện thoại); chép sẵn nội dung phòng khi Zalo bỏ phần chữ. */
  async function shareZalo(d: { text: string; files: File[] }) {
    try { await navigator.clipboard?.writeText(d.text); } catch { /* không chép được: vẫn chia sẻ */ }
    try {
      if (d.files.length && navigator.canShare?.({ files: d.files })) await navigator.share({ files: d.files, text: d.text });
      else if ('share' in navigator) await navigator.share({ text: d.text });
      else { toast('ok', 'Đã chép nội dung, mở Zalo và dán vào nhóm'); return; }
      setDone(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast('error', `Không mở được Zalo: ${errMsg(e)}. Nội dung đã được chép, mở Zalo dán vào nhóm.`);
    }
  }
  const lit = Number(f?.liters) || 0, gia = Number(f?.unit_price) || 0, tien = Number(f?.amount) || 0, calc = Math.round(lit * gia);
  const wait = useMemo(() => sent.filter((x) => x.status === 'cho').length, [sent]);

  return (
    <section className="card">
      <button type="button" className="btn primary fr-big" onClick={() => setPick([])} disabled={!!busy}>⛽ Báo đổ dầu</button>
      {busy && <p className="small muted">{busy}</p>}
      {sent.length > 0 && (
        <details className="fr-list" open={wait > 0}>
          <summary className="small">Phiếu đổ dầu đã gửi 30 ngày qua ({sent.length}){wait ? ` · ${wait} chờ duyệt` : ''}</summary>
          {sent.map((x) => (
            <div key={x.id}>
              <span className="grow">{fmtDate(x.entry_date)} {x.entry_time?.slice(0, 5) ?? ''} · <b>{x.plate}</b> · {num(x.liters, 3)} lít · {num(x.amount ?? x.liters * x.unit_price)} đ</span>
              <span className={`badge${x.status === 'bo' ? ' locked' : x.status === 'cho' ? ' warn-badge' : ''}`}>{x.status === 'cho' ? 'Chờ duyệt' : x.status === 'duyet' ? 'Đã duyệt' : 'Bị bỏ'}</span>
              {x.status === 'bo' && x.reject_reason && <span className="small muted">Lý do: {x.reject_reason}</span>}
              <FilesViewButton files={x.files} label="Xem ảnh" />
            </div>
          ))}
        </details>
      )}

      {pick && (
        <Modal title="⛽ Báo đổ dầu" onClose={() => setPick(null)}>
          <div className="form">
            <p className="small">Chụp <b>trụ bơm</b> (tiền, lít, giá), <b>hóa đơn</b>, <b>biển số xe</b> và <b>đồng hồ km</b> (nếu được), giống ảnh gửi nhóm Zalo. Chụp lần lượt từng ảnh, đủ rồi bấm <b>Đọc ảnh & gửi</b>.</p>
            <div className="fr-thumbs">
              {urls.map((u, i) => (
                <div key={u}><img src={u} alt={`Ảnh ${i + 1}`} />
                  <button type="button" aria-label={`Bỏ ảnh ${i + 1}`} onClick={() => setPick(pick.filter((_, k) => k !== i))}>×</button></div>
              ))}
            </div>
            {busy && <p className="small"><b>{busy}</b></p>}
            <label className="btn fr-big">📷 {pick.length ? 'Chụp thêm ảnh' : 'Chụp ảnh'}
              <input type="file" accept="image/*" capture="environment" hidden aria-label="Chụp ảnh đổ dầu" onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} /></label>
            <label className="btn fr-big">🖼 Chọn ảnh có sẵn
              <input type="file" accept="image/*" multiple hidden aria-label="Chọn ảnh đổ dầu" onChange={(e) => { pickAndRead(Array.from(e.target.files ?? [])); e.target.value = ''; }} /></label>
            <div className="actions">
              <button type="button" className="btn primary" disabled={!pick.length || !!busy} onClick={() => void read(pick)}>Đọc ảnh & gửi{pick.length ? ` (${pick.length} ảnh)` : ''}</button>
              <button type="button" className="btn link" onClick={() => setPick(null)}>Đóng</button>
            </div>
          </div>
        </Modal>
      )}

      {f && (
        <Modal title="⛽ Báo đổ dầu" onClose={() => { if (!busy) setF(null); }}>
          <div className="form">
            <div className="grid2">
              <label>Biển số xe<input list="fr-plates" value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} /></label>
              <datalist id="fr-plates">{plates.map((p) => <option key={p} value={p} />)}</datalist>
              <label>Ngày<input type="date" value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></label>
              <label>Giờ<input type="time" value={f.entry_time} onChange={(e) => setF({ ...f, entry_time: e.target.value })} /></label>
              <label>Số lít<input type="number" min={0} step="0.001" inputMode="decimal" value={f.liters} onChange={(e) => setF({ ...f, liters: e.target.value })} /></label>
              <label>Đơn giá (đ/lít)<input type="number" min={0} inputMode="numeric" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></label>
              <label>Thành tiền (đ)<input type="number" min={0} inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
                {lit > 0 && gia > 0 && <span className={`small ${tien && Math.abs(calc - tien) > 1000 ? 'danger-text' : 'muted'}`}>Lít × giá = {num(calc)} đ{tien && Math.abs(calc - tien) > 1000 ? ', lệch với thành tiền' : ''}</span>}</label>
              <label>Km đồng hồ (Odo)<input type="number" min={0} inputMode="numeric" value={f.odo_km} onChange={(e) => setF({ ...f, odo_km: e.target.value })} placeholder="Để tính hao dầu" /></label>
              <label>Cây xăng<input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></label>
              <label>Số hóa đơn<input value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></label>
              <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            </div>
            <p className="small muted">{prep.length} ảnh gửi kèm làm chứng từ.</p>
            <div className="actions">
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void send(f)}>{busy ? 'Đang gửi…' : 'Gửi điều hành duyệt'}</button>
              <button type="button" className="btn link" disabled={!!busy} onClick={() => setF(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
      {done && (
        <Modal title="✅ Đã gửi điều hành, kế toán duyệt" onClose={() => setDone(null)}>
          <div className="form">
            <pre className="fr-sum">{done.text}</pre>
            <div className="actions">
              <button type="button" className="btn primary fr-big" onClick={() => void shareZalo(done)}>📤 Gửi vào nhóm Zalo</button>
              <button type="button" className="btn link" onClick={() => setDone(null)}>Đóng</button>
            </div>
            <p className="small muted">Chọn nhóm Zalo rồi bấm Gửi. Nếu Zalo chỉ nhận ảnh, nội dung đã được chép sẵn: giữ ô tin nhắn → Dán.</p>
          </div>
        </Modal>
      )}
    </section>
  );

}
