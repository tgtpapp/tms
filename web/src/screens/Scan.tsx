// Scan tài liệu (như app cũ, kiểu CamScanner) + cải tiến: nhận dạng chữ (AI), chia sẻ, in, cắt / xoay từng trang.
// Chụp bằng máy quét trong app (Đơn / Hàng loạt, khung xanh bám mép giấy) hoặc chọn ảnh → tự nhận khung (kéo 4 góc chỉnh)
// → nắn phẳng → làm rõ chữ → tải về PDF / JPG / PNG / WEBP, chia sẻ, in, hoặc lưu vào Lưu trữ hồ sơ.
// Lệnh vận chuyển / Hợp đồng vận chuyển: AI đọc trang đầu, tự đặt tên + thư mục theo quy tắc của app cũ.
// Ảnh xử lý trên máy; các trang đang scan lưu tạm trong máy (tải lại trang không mất), xóa khi bấm "Xóa hết".
import { Fragment, useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../components/Modal';
import { fmtDate, today } from '../components/Documents';
import { readByAI } from '../lib/documents';
import { ensurePath, resetFolders } from '../lib/dispatchPapers';
import { drive } from '../lib/drive';
import { bytesToBase64 } from '../lib/pdfMaker';
import {
  FILTERS, MAX, buildFiles, cv, detect, docName, docPath, fit, fullQuad, loadImage, persist, quadOk, refine, render, restore, rotate, ruleApplies, safeName, thumbOf, toBlob,
  type DocRead, type Filter, type Fmt, type Page, type Pt, type Quad, type RouteRow,
} from '../lib/scan';
import { errMsg, fetchAll, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Folder { id: string; parent_id: string | null; name: string }
const pref = (k: string, d: string) => { try { return localStorage.getItem(`scan.${k}`) ?? d; } catch { return d; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(`scan.${k}`, v); } catch { /* không lưu được: bỏ qua */ } };
const defaultName = () => { const n = new Date(), p = (x: number) => String(x).padStart(2, '0'); return `Scan ${fmtDate(today()).replace(/\//g, '-')} ${p(n.getHours())}h${p(n.getMinutes())}`; };
const b64 = async (c: HTMLCanvasElement, q = 0.85) => bytesToBase64(new Uint8Array(await (await toBlob(c, 'image/jpeg', q)).arrayBuffer()));

export function ScanScreen({ canSave, canAI, canLenh = false, forTrip, onDone }: {
  canSave: boolean; canAI: boolean; canLenh?: boolean; forTrip?: { id: string; label: string }; onDone?: () => void;
}) {
  const toast = useToast();
  const P = useRef<Page[]>([]);
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick((x) => x + 1), []);
  const [cur, setCur] = useState(-1);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [fmt, setFmt] = useState<Fmt>(() => pref('fmt', 'pdf') as Fmt);
  const [quality, setQuality] = useState(() => Number(pref('q', '2200')) || 2200);
  const [folder, setFolder] = useState('');
  const [mode, setMode] = useState(() => pref('mode', 'don'));
  const [aiMode, setAiMode] = useState(() => pref('ai', 'auto'));
  const [review, setReview] = useState(-1);
  const [camOn, setCamOn] = useState(false);
  const [doc, setDoc] = useState<{ v: DocRead | null; err?: string; by?: string } | null>(null);
  const [printing, setPrinting] = useState<string[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [suffix, setSuffix] = useState('');
  const n = P.current.length, pg = P.current[cur];

  const save = useCallback(() => { void persist(P.current); }, []);
  // khôi phục các trang đang scan dở + danh mục thư mục, tuyến, hậu tố số lệnh
  useEffect(() => {
    void restore().then((r) => { if (r.length && !P.current.length) { P.current = r; setCur(0); toast('ok', `Đã khôi phục ${r.length} trang đang scan dở`); } });
    void supabase.from('routes').select('name, registered_code').then((r) => setRoutes((r.data ?? []) as RouteRow[]));
    void supabase.from('tenant_settings').select('value').eq('key', 'lenh.hau_to').maybeSingle().then((r) => setSuffix(typeof r.data?.value === 'string' ? r.data.value : ''));
    if (canSave) void fetchAll<Folder>(() => supabase.from('archive_folders').select('id, parent_id, name').order('id')).then(setFolders, () => undefined);
  }, [canSave, toast]);
  const ptxt = useCallback((id: string) => { const out: string[] = []; let f = folders.find((x) => x.id === id); while (f) { out.unshift(f.name); f = folders.find((x) => x.id === f!.parent_id); } return out.join(' / '); }, [folders]);
  const folderOpts = folders.map((f) => ({ id: f.id, label: ptxt(f.id) })).sort((a, b) => a.label.localeCompare(b.label, 'vi'));

  /* ---------- AI dò khung (chạy nền; người dùng đã kéo góc thì giữ nguyên) ---------- */
  const aiQuad = useCallback(async (p: Page, force: boolean) => {
    if (!canAI) { if (force) toast('error', 'Cần có hồ sơ nhân viên hoặc quyền Lưu trữ hồ sơ để dùng AI'); return false; }
    try {
      const sm = fit(p.src, 1024), W = p.src.width, H = p.src.height;
      const r = await readByAI('scan_khung', [{ blob: new Blob(), mime: 'image/jpeg', base64: await b64(sm), ext: 'jpg' }]);
      const v = r.fields, at = (k: string): Pt | null => (typeof v[`${k}_x`] === 'number' && typeof v[`${k}_y`] === 'number'
        ? [Math.max(0, Math.min(W, (v[`${k}_x`] as number) / 1000 * W)), Math.max(0, Math.min(H, (v[`${k}_y`] as number) / 1000 * H))] : null);
      const Q = ['tl', 'tr', 'br', 'bl'].map(at);
      if (!quadOk(Q, W, H)) { if (force) toast('error', 'AI chưa dò được khung giấy, hãy kéo 4 góc'); return false; }
      if (p.touched && !force) return false;
      p.q = refine(p.src, Q); p.ai = true; p.thumb = null; p.touched = false;
      return true;
    } catch (e) {
      if (force) toast('error', `AI chưa dò được khung: ${errMsg(e)}`);
      return false;
    }
  }, [canAI, toast]);

  /* ---------- thêm trang: nhận khung trên máy (lần lượt), chế độ Tự động thì AI dò lại cho chuẩn ---------- */
  const queue = useRef<Page[]>([]), qBusy = useRef(false);
  const runQ = useCallback(() => {
    if (qBusy.current) return;
    const p = queue.current.shift();
    if (!p) { save(); return; }
    qBusy.current = true;
    setTimeout(() => {
      try { p.q = detect(p.src); } catch { /* giữ toàn ảnh */ }
      p.pending = false; p.thumb = null; qBusy.current = false; redraw();
      if (aiMode === 'auto' && canAI) void aiQuad(p, false).then((ok) => { if (ok) { save(); redraw(); } });
      runQ();
    }, 30);
  }, [aiMode, aiQuad, canAI, redraw, save]);
  const enqueue = useCallback((src: HTMLCanvasElement) => { const p: Page = { src, q: fullQuad(src), f: 'magic', pending: true }; P.current.push(p); queue.current.push(p); runQ(); }, [runQ]);
  const afterAdd = useCallback((n0: number) => { if (P.current.length > n0) { setCur(n0); setReview(aiMode === 'tay' ? n0 : -1); } redraw(); }, [aiMode, redraw]);
  async function addFiles(list: FileList | File[] | null) {
    const files = [...(list ?? [])].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length) return;
    const n0 = P.current.length;
    setBusy('Đang đọc ảnh…');
    for (const f of files) { try { enqueue(await loadImage(f)); } catch { toast('error', `Không đọc được ảnh ${f.name}`); } }
    setBusy(null);
    afterAdd(n0);
  }

  const touch = (p: Page) => { p.thumb = null; save(); redraw(); };
  function delPage(i: number) { P.current.splice(i, 1); setCur((c) => Math.min(c >= i && c > 0 ? c - 1 : c, P.current.length - 1)); save(); redraw(); }
  function move(i: number, d: -1 | 1) { const j = i + d, L = P.current; if (j < 0 || j >= L.length) return; [L[i], L[j]] = [L[j]!, L[i]!]; setCur(j); save(); redraw(); }
  function clearAll() { if (!confirm('Xóa tất cả các trang đang scan?')) return; P.current = []; setCur(-1); setReview(-1); setName(''); setFolder(''); save(); redraw(); }

  /* ---------- AI đọc nội dung (nhận dạng chữ) ---------- */
  async function readDoc(p: Page): Promise<{ v: DocRead; by: string }> {
    const r = await readByAI('scan_doc', [{ blob: new Blob(), mime: 'image/jpeg', base64: await b64(render(p, 1800), 0.9), ext: 'jpg' }]);
    return { v: r.fields as unknown as DocRead, by: r.provider };
  }
  async function applyRule(v: DocRead): Promise<{ name: string; folder: string } | null> {
    if (!ruleApplies(v)) return null;
    const nm = /lệnh/i.test(v.loai ?? '') ? docName(v, suffix) : name;
    if (nm) setName(nm);
    const path = docPath(v, routes, today());
    let fd = folder;
    if (path && canSave) { resetFolders(); fd = await ensurePath(path); setFolder(fd); setFolders((await fetchAll<Folder>(() => supabase.from('archive_folders').select('id, parent_id, name').order('id')))); }
    return { name: nm, folder: fd };
  }
  async function aiRead() {
    if (!pg) return;
    if (!canAI) return toast('error', 'Cần có hồ sơ nhân viên hoặc quyền Lưu trữ hồ sơ để dùng AI');
    setDoc({ v: null });
    try { const r = await readDoc(pg); setDoc({ v: r.v, by: r.by }); } catch (e) { setDoc({ v: null, err: errMsg(e) }); }
  }

  /* ---------- xuất ---------- */
  const files = (nm = name) => buildFiles(P.current, nm || defaultName(), fmt, quality);
  async function download() {
    if (!n || busy) return;
    setBusy('Đang tạo tệp…');
    try {
      for (const f of await files()) {
        const url = URL.createObjectURL(f.blob), a = document.createElement('a');
        a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        await new Promise((r) => setTimeout(r, 350));
      }
      toast('ok', 'Đã tải về máy');
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(null); }
  }
  async function share() {
    if (!n || busy) return;
    setBusy('Đang tạo tệp để chia sẻ…');
    try {
      const fs = (await files()).map((f) => new File([f.blob], f.name, { type: f.mime }));
      if (navigator.canShare?.({ files: fs })) await navigator.share({ files: fs, title: name || defaultName() });
      else toast('error', 'Máy / trình duyệt này chưa chia sẻ tệp trực tiếp được, hãy bấm Tải về máy rồi gửi tệp');
    } catch (e) { if ((e as Error).name !== 'AbortError') toast('error', errMsg(e)); } finally { setBusy(null); }
  }
  async function print() {
    if (!n || busy) return;
    setBusy('Đang chuẩn bị bản in…');
    try { setPrinting(P.current.map((p) => render(p, 1800).toDataURL('image/jpeg', 0.88))); } finally { setBusy(null); }
  }
  async function saveArchive() {
    if (!n || busy) return;
    setBusy('Đang chuẩn bị lưu…');
    try {
      let nm = name || defaultName(), fd = folder;
      // chưa chọn thư mục: AI đọc trang đầu, là Lệnh vận chuyển / Hợp đồng thì tự đặt tên + thư mục theo quy tắc rồi mới lưu
      if (!fd && canAI) {
        setBusy('AI đang đọc trang đầu để xếp thư mục…');
        try { const r = await applyRule((await readDoc(P.current[0]!)).v); if (r) { nm = r.name || nm; fd = r.folder; } } catch { /* AI lỗi: lưu vào thư mục gốc */ }
      }
      setBusy('Đang tạo tệp…');
      const out = await buildFiles(P.current, nm, fmt, quality), safe = safeName(nm);
      let i = 0;
      for (const f of out) {
        setBusy(`Đang lưu ${++i}/${out.length}…`);
        const base = f.name.replace(/\.[^.]+$/, '');
        // tên hồ sơ giữ dấu "/" như số lệnh in (26070706/LVC-TGTP); tên tệp trên Drive thay "/" bằng "-"
        const hsName = nm !== safe && base.startsWith(safe) ? nm + base.slice(safe.length) : base;
        await drive({ action: 'put', folder_id: fd || null, name: hsName, file_name: f.name, mime: f.mime, data: bytesToBase64(new Uint8Array(await f.blob.arrayBuffer())),
          expires_on: null, note: `Scan tài liệu · ${n} trang`, replace_id: null });
      }
      toast('ok', `Đã lưu ${out.length} tệp vào “${fd ? ptxt(fd) : 'Thư mục gốc'}”`);
      P.current = []; setCur(-1); setReview(-1); setName(''); setFolder(''); save(); redraw();   // lưu xong: về mặc định (giữ định dạng, chất lượng)
    } catch (e) { toast('error', `Chưa lưu được: ${errMsg(e)}`); } finally { setBusy(null); }
  }

  /** Lái xe / nhân viên lưu lệnh vận chuyển: máy chủ cho AI đọc trang đầu, đúng là lệnh thì tự đặt tên + thư mục rồi lưu */
  async function saveLenh() {
    if (!n || busy) return;
    setBusy('Đang tạo PDF lệnh…');
    try {
      const pdf = (await buildFiles(P.current, 'lenh', 'pdf', quality))[0]!;
      setBusy('AI đang đọc lệnh và lưu vào hệ thống…');
      const r = await drive<{ name: string; path: string }>({ action: 'put_lenh', data: bytesToBase64(new Uint8Array(await pdf.blob.arrayBuffer())), mime: 'application/pdf',
        page: await b64(render(P.current[0]!, 1800), 0.9), trip_id: forTrip?.id ?? null });
      toast('ok', `Đã lưu lệnh ${r.name} vào ${r.path}`);
      P.current = []; setCur(-1); setReview(-1); setName(''); save(); redraw();
      onDone?.();
    } catch (e) { toast('error', `Chưa lưu được lệnh: ${errMsg(e)}`); } finally { setBusy(null); }
  }

  const pending = P.current.filter((p) => p.pending).length;
  return (
    <div className="scn">
      <section className="card">
        <div className="item-head"><h2>{forTrip ? 'Scan lệnh vận chuyển' : 'Scan tài liệu'}</h2></div>
        {forTrip && <p className="small">Chuyến <b>{forTrip.label}</b></p>}
        <div className="scn-add">
          <button type="button" className="btn primary" onClick={() => setCamOn(true)}>📷 Mở máy quét</button>
          <label className="btn scn-in">Chụp bằng camera máy<input type="file" accept="image/*" capture="environment" multiple onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} /></label>
          <label className="btn scn-in">Chọn ảnh có sẵn<input type="file" accept="image/*" multiple aria-label="Chọn ảnh tài liệu" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} /></label>
        </div>
        <div className="scn-sw">
          <span>Chế độ:</span>
          {([['don', 'Đơn'], ['loat', 'Hàng loạt']] as const).map(([k, l]) => <button key={k} type="button" className={`btn small${mode === k ? ' primary' : ''}`} onClick={() => { setMode(k); setPref('mode', k); }}>{l}</button>)}
          <span>Xử lý:</span>
          {([['auto', '🤖 Tự động'], ['tay', '✋ Thủ công']] as const).map(([k, l]) => <button key={k} type="button" className={`btn small${aiMode === k ? ' primary' : ''}`} onClick={() => { setAiMode(k); setPref('ai', k); }}>{l}</button>)}
        </div>
        {busy ? <p className="upload">{busy}</p> : <p className="small muted">{n ? `${n} trang · bấm ảnh nhỏ để chỉnh từng trang` : 'Chụp hoặc chọn một hay nhiều ảnh. Mỗi ảnh là 1 trang.'}</p>}
        {pending > 0 && <p className="small" style={{ color: '#0f766e' }}>⏳ Đang nhận khung {pending} trang…</p>}
        {n > 0 && (
          <div className="scn-pages">
            {P.current.map((p, i) => (
              <div key={i} className={i === cur ? 'scn-pg on' : 'scn-pg'}>
                <button type="button" className="scn-pg-img" aria-label={`Trang ${i + 1}`} onClick={() => setCur(i)}><img src={thumbOf(p)} alt="" /></button>
                <b>{i + 1}</b>
                <button type="button" className="scn-x" aria-label={`Bỏ trang ${i + 1}`} onClick={() => delPage(i)}>×</button>
                {i > 0 && <button type="button" className="scn-mv l" aria-label={`Đưa trang ${i + 1} lên trước`} onClick={() => move(i, -1)}>‹</button>}
                {i < n - 1 && <button type="button" className="scn-mv r" aria-label={`Đưa trang ${i + 1} ra sau`} onClick={() => move(i, 1)}>›</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      {review >= 0 && review < n && (
        <div className="scn-rv">
          <span>✋ Duyệt thủ công: trang <b>{cur + 1}/{n}</b>. Kéo 4 góc cho khớp, chọn kiểu làm rõ rồi bấm</span>
          <button type="button" className="btn primary small" onClick={() => { if (cur + 1 < n) { setCur(cur + 1); setReview(cur + 1); } else { setReview(-1); toast('ok', 'Đã duyệt xong, chọn định dạng rồi lưu'); } save(); }}>
            {cur + 1 < n ? `Xong trang này → trang ${cur + 2}` : '✓ Xong tất cả'}
          </button>
        </div>
      )}

      {pg && (
        <div className="scn-ed">
          <section className="card scn-col">
            <div className="scn-h">1. Chỉnh khung giấy <small>kéo 4 góc tròn cho khớp mép giấy{pg.ai ? ' · AI đã dò khung' : ''}</small></div>
            <Stage key={`${cur}-${pg.src.width}x${pg.src.height}`} page={pg} onChange={() => touch(pg)} />
            <div className="scn-tools">
              {canAI && <button type="button" className="btn small primary" onClick={() => { setBusy('AI đang dò khung…'); void aiQuad(pg, true).then((ok) => { setBusy(null); if (ok) { toast('ok', 'AI đã dò khung giấy'); touch(pg); } }); }}>🤖 AI dò khung</button>}
              <button type="button" className="btn small" onClick={() => { pg.q = detect(pg.src); pg.ai = false; touch(pg); }}>Tự nhận khung</button>
              <button type="button" className="btn small" onClick={() => { pg.q = fullQuad(pg.src); pg.ai = false; touch(pg); }}>Toàn ảnh</button>
              <button type="button" className="btn small" onClick={() => { rotate(pg, false); touch(pg); }}>⟲ Xoay trái</button>
              <button type="button" className="btn small" onClick={() => { rotate(pg, true); touch(pg); }}>⟳ Xoay phải</button>
              <button type="button" className="btn small link danger-text" onClick={() => delPage(cur)}>Xóa trang</button>
            </div>
          </section>
          <section className="card scn-col">
            <div className="scn-h">2. Kết quả <small>đã nắn phẳng và làm rõ chữ</small></div>
            <Result page={pg} />
            <div className="scn-tools">
              {FILTERS.map(([k, l]) => <button key={k} type="button" className={`btn small${pg.f === k ? ' primary' : ''}`} onClick={() => { pg.f = k as Filter; touch(pg); }}>{l}</button>)}
              {canAI && <button type="button" className="btn small scn-air" onClick={() => void aiRead()}>🤖 Đọc chữ (AI)</button>}
            </div>
          </section>
        </div>
      )}

      {n > 0 && (
        <section className="card form scn-ex">
          <div className="scn-h">3. Lưu tài liệu ({n} trang)</div>
          <div className="grid2">
            <label>Tên tài liệu<input value={name} placeholder={defaultName()} onChange={(e) => setName(e.target.value)} /></label>
            <label>Định dạng<select value={fmt} onChange={(e) => { setFmt(e.target.value as Fmt); setPref('fmt', e.target.value); }}>
              <option value="pdf">PDF A4 (gộp {n} trang)</option><option value="jpg">JPG (mỗi trang 1 ảnh)</option><option value="png">PNG (nét nhất, nặng hơn)</option><option value="webp">WEBP (nhẹ nhất)</option>
            </select></label>
            <label>Chất lượng<select value={quality} onChange={(e) => { setQuality(Number(e.target.value)); setPref('q', e.target.value); }}>
              <option value={1600}>Vừa (nhẹ)</option><option value={2200}>Cao</option><option value={MAX}>Rất cao</option>
            </select></label>
            {canSave && <label>Lưu vào thư mục hồ sơ<select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">{canAI ? 'Tự xếp (Lệnh / Hợp đồng vận chuyển), còn lại: thư mục gốc' : 'Thư mục gốc'}</option>
              {folderOpts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select></label>}
          </div>
          <div className="actions">
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => void download()}>Tải về máy</button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void share()}>Chia sẻ</button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void print()}>In</button>
            {canSave && !forTrip && <button type="button" className="btn" disabled={!!busy} onClick={() => void saveArchive()}>Lưu vào Lưu trữ hồ sơ</button>}
            {canLenh && (forTrip || !canSave) && <button type="button" className="btn primary" disabled={!!busy} onClick={() => void saveLenh()}>Lưu lệnh vận chuyển</button>}
          </div>
          <div className="actions"><button type="button" className="btn small link danger-text" onClick={clearAll}>Xóa hết, scan tài liệu mới</button></div>
        </section>
      )}

      {camOn && <Camera mode={mode} onMode={(m) => { setMode(m); setPref('mode', m); }} aiMode={aiMode}
        onShot={enqueue} onClose={(n0) => { setCamOn(false); afterAdd(n0); save(); }} start={n} />}

      {doc && (
        <Modal title="🤖 AI đọc nội dung tài liệu" onClose={() => setDoc(null)}>
          {!doc.v ? <p className={doc.err ? 'error-text' : 'muted'}>{doc.err ? `AI chưa đọc được: ${doc.err}` : `⏳ AI đang đọc trang ${cur + 1}…`}</p>
            : <DocView v={doc.v} by={doc.by ?? ''} suffix={suffix} path={docPath(doc.v, routes, today())} canSave={canSave}
              onName={(x) => { setName(x); toast('ok', 'Đã đặt tên tài liệu'); }}
              onFolder={() => { void applyRule(doc.v!).then((r) => { if (r) toast('ok', 'Đã chọn thư mục theo quy tắc'); }, (e: unknown) => toast('error', errMsg(e))); }} />}
        </Modal>
      )}

      {printing && createPortal(
        <div className="lenh-overlay">
          <div className="lenh-bar no-print"><b>{name || defaultName()} · {printing.length} trang A4</b>
            <button className="btn small primary" onClick={() => window.print()}>In</button>
            <button className="btn small" onClick={() => setPrinting(null)}>Đóng</button></div>
          <div className="print-stack">{printing.map((src, i) => <div key={i} className="lenh scn-print"><img src={src} alt={`Trang ${i + 1}`} /></div>)}</div>
        </div>, document.body)}
    </div>
  );
}

/** Ảnh gốc + 4 góc kéo được */
function Stage({ page, onChange }: { page: Page; onChange: () => void }) {
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [k, setK] = useState(0);
  const [q, setQ] = useState<Quad>(page.q);
  const drag = useRef(-1);
  useEffect(() => { setQ(page.q); }, [page.q]);
  useEffect(() => {
    const draw = () => {
      const el = wrap.current, c = canvas.current; if (!el || !c) return;
      const W = Math.min(el.clientWidth || 600, 900), kk = W / page.src.width;
      c.width = Math.round(page.src.width * kk); c.height = Math.round(page.src.height * kk);
      c.getContext('2d')!.drawImage(page.src, 0, 0, c.width, c.height);
      setK(kk);
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [page.src]);
  const pos = (e: RPointerEvent<SVGSVGElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(page.src.width, (e.clientX - r.left) / k)), Math.max(0, Math.min(page.src.height, (e.clientY - r.top) / k))];
  };
  const P = q.map(([x, y]) => [x * k, y * k]);
  return (
    <div className="scn-stage" ref={wrap}>
      <canvas ref={canvas} />
      {k > 0 && (
        <svg width={page.src.width * k} height={page.src.height * k}
          onPointerDown={(e) => { const h = (e.target as Element).closest('[data-h]'); if (!h) return; drag.current = Number(h.getAttribute('data-h')); e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
          onPointerMove={(e) => { if (drag.current < 0) return; const nq = [...q] as Quad; nq[drag.current] = pos(e); setQ(nq); }}
          onPointerUp={() => { if (drag.current < 0) return; drag.current = -1; page.q = q; page.touched = true; page.ai = false; onChange(); }}
          onPointerCancel={() => { drag.current = -1; }}>
          <polygon points={P.map((p) => p.join(',')).join(' ')} fill="rgba(37,99,235,.15)" stroke="#2563eb" strokeWidth={2} />
          {P.map((p, i) => <circle key={i} data-h={i} cx={p[0]} cy={p[1]} r={14} fill="#fff" stroke="#2563eb" strokeWidth={3} />)}
        </svg>
      )}
    </div>
  );
}

/** Ảnh kết quả (nắn + làm rõ), dựng lại khi đổi khung / kiểu làm rõ */
function Result({ page }: { page: Page }) {
  const [src, setSrc] = useState('');
  const key = `${page.q.flat().map((x) => Math.round(x)).join(',')}|${page.f}|${page.src.width}`;
  useEffect(() => {
    const t = setTimeout(() => setSrc(render(page, 1100).toDataURL('image/jpeg', 0.85)), 60);
    return () => clearTimeout(t);
  }, [key, page]);
  return <div className="scn-res">{src && <img src={src} alt="Kết quả trang scan" />}</div>;
}

/** Kết quả AI đọc: thông tin chính + toàn bộ chữ (chép được); áp quy tắc đặt tên / thư mục */
function DocView({ v, by, suffix, path, canSave, onName, onFolder }: { v: DocRead; by: string; suffix: string; path: string[] | null; canSave: boolean; onName: (x: string) => void; onFolder: () => void }) {
  const toast = useToast();
  const dt = (x: string | null) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? fmtDate(x) : x ?? '');
  const lenh = /lệnh/i.test(v.loai ?? '');
  const rows: [string, string | null][] = lenh
    ? [['Số lệnh', v.lenh_so], ['Hiệu lực', [dt(v.lenh_tu_ngay), dt(v.lenh_den_ngay)].filter(Boolean).join(' → ')], ['Lái xe 1', v.lai_xe_1], ['Lái xe 2', v.lai_xe_2],
       ['Biển số', v.bien_so], ['Tuyến', [v.tuyen, v.ma_tuyen && `mã ${v.ma_tuyen}`].filter(Boolean).join(' · ')], ['Bến đi', v.ben_di], ['Bến về', v.ben_ve], ['Ngày xuất bến', dt(v.ngay_xuat)]]
    : [['Số', v.so_van_ban], ['Ngày', dt(v.ngay)], ['Biển số', v.bien_so]];
  const nm = docName(v, suffix);
  return (
    <div className="form">
      <p><span className="badge">{v.loai || 'Tài liệu'}</span> <b>{v.tieu_de}</b> <span className="small muted">· đọc bởi {by}</span></p>
      {v.tom_tat && <p className="small">{v.tom_tat}</p>}
      <dl className="info small">{rows.filter(([, x]) => x).map(([l, x]) => <Fragment key={l}><dt>{l}</dt><dd>{x}</dd></Fragment>)}</dl>
      {v.noi_dung && <label>Toàn bộ chữ đọc được<textarea readOnly rows={8} value={v.noi_dung} /></label>}
      <div className="actions">
        <button type="button" className="btn primary small" onClick={() => onName(nm)}>Đặt tên: “{nm}”</button>
        {path && canSave && <button type="button" className="btn small" onClick={onFolder}>Thư mục: {path.join(' / ')}</button>}
        <button type="button" className="btn small" onClick={() => {
          const t = [v.loai, ...rows.filter(([, x]) => x).map(([l, x]) => `${l}: ${x}`), v.noi_dung ?? ''].filter(Boolean).join('\n');
          void navigator.clipboard.writeText(t).then(() => toast('ok', 'Đã chép nội dung'), () => toast('error', 'Không chép được'));
        }}>Chép nội dung</button>
      </div>
    </div>
  );
}

/** Máy quét trong app: camera toàn màn hình, khung xanh bám mép giấy, Đơn (chụp 1 tấm rồi chỉnh) / Hàng loạt (chụp liên tục) */
function Camera({ mode, onMode, aiMode, onShot, onClose, start }: { mode: string; onMode: (m: string) => void; aiMode: string; onShot: (c: HTMLCanvasElement) => void; onClose: (n0: number) => void; start: number }) {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null), ov = useRef<HTMLCanvasElement>(null), flash = useRef<HTMLDivElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState('');
  const [torch, setTorch] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const close = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); document.body.style.overflow = ''; onClose(start); }, [onClose, start]);
  useEffect(() => {
    let alive = true, timer = 0;
    document.body.style.overflow = 'hidden';
    if (!navigator.mediaDevices?.getUserMedia) { toast('error', 'Trình duyệt không mở được camera, dùng nút Chọn ảnh có sẵn'); close(); return; }
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }).then(async (st) => {
      if (!alive) { st.getTracks().forEach((t) => t.stop()); return; }
      stream.current = st;
      const v = video.current!; v.srcObject = st;
      try { await v.play(); } catch { /* tự chạy khi sẵn sàng */ }
      const loop = () => {   // khung xanh bám mép giấy khi đang ngắm
        if (!alive) return;
        const o = ov.current;
        if (v.videoWidth && o) {
          const r = v.getBoundingClientRect(); o.width = r.width; o.height = r.height;
          const g = o.getContext('2d')!; g.clearRect(0, 0, o.width, o.height);
          try {
            const f = cv(v.videoWidth, v.videoHeight); f.getContext('2d')!.drawImage(v, 0, 0);
            const sm = fit(f, 480), q = detect(sm), k0 = sm.width / v.videoWidth, sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
            const ox = (r.width - v.videoWidth * sc) / 2, oy = (r.height - v.videoHeight * sc) / 2;
            const pts = q.map(([x, y]) => [ox + x / k0 * sc, oy + y / k0 * sc]);
            g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x!, y!) : g.moveTo(x!, y!))); g.closePath();
            g.fillStyle = 'rgba(20,184,166,.18)'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#14b8a6'; g.stroke();
          } catch { /* bỏ khung lần này */ }
        }
        timer = window.setTimeout(loop, 450);
      };
      loop();
    }, (e: Error) => { toast('error', `Không mở được camera: ${e.name === 'NotAllowedError' ? 'bạn chưa cho phép dùng camera' : e.message}. Dùng nút Chọn ảnh có sẵn.`); close(); });
    return () => { alive = false; clearTimeout(timer); stream.current?.getTracks().forEach((t) => t.stop()); document.body.style.overflow = ''; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  function shot() {
    const v = video.current; if (!v?.videoWidth) return;
    const f = cv(v.videoWidth, v.videoHeight); f.getContext('2d')!.drawImage(v, 0, 0);
    const fl = flash.current; if (fl) { fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go'); }
    try { navigator.vibrate?.(30); } catch { /* máy không rung */ }
    const c = fit(f, MAX);
    onShot(c); setCount((x) => x + 1); setLast(fit(c, 120).toDataURL('image/jpeg', 0.7));
    if (mode === 'don') close();
  }
  async function toggleTorch() {
    const tr = stream.current?.getVideoTracks()[0]; if (!tr) return;
    try { await tr.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch); } catch { toast('error', 'Máy này không bật được đèn flash từ trình duyệt'); }
  }
  return createPortal(
    <div className="scc">
      <div className="scc-top">
        <button type="button" aria-label="Đóng máy quét" onClick={close}>✕</button><span className="grow" />
        <span className="scc-pill">{aiMode === 'auto' ? '🤖 Tự động' : '✋ Thủ công'}</span>
        <button type="button" aria-label="Đèn flash" className={torch ? 'on' : ''} onClick={() => void toggleTorch()}>⚡</button>
      </div>
      <div className="scc-view"><video ref={video} playsInline muted autoPlay /><canvas ref={ov} className="scc-ov" /><div ref={flash} className="scc-flash" /></div>
      <div className="scc-modes">{([['don', 'Đơn'], ['loat', 'Hàng loạt']] as const).map(([k, l]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => onMode(k)}>{l}</button>)}</div>
      <div className="scc-bot">
        <button type="button" className="scc-side" onClick={() => fileIn.current?.click()}><span aria-hidden="true">🖼</span><small>Nhập ảnh</small></button>
        <input ref={fileIn} type="file" accept="image/*" multiple hidden onChange={async (e) => {
          const fs = [...(e.target.files ?? [])]; e.target.value = '';
          for (const f of fs) { try { const c = await loadImage(f); onShot(c); setCount((x) => x + 1); setLast(fit(c, 120).toDataURL('image/jpeg', 0.7)); } catch { /* bỏ ảnh lỗi */ } }
          if (mode === 'don' && fs.length) close();
        }} />
        <button type="button" className="scc-shut" aria-label="Chụp" onClick={shot} />
        <button type="button" className="scc-side" style={{ visibility: count ? 'visible' : 'hidden' }} onClick={close}>
          <span className="scc-th">{last && <img src={last} alt="" />}<b>{count}</b></span><small>Xong</small>
        </button>
      </div>
    </div>, document.body);
}
