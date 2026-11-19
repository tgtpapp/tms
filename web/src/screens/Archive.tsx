// Lưu trữ hồ sơ (như app cũ): năm → cây thư mục nhiều cấp → hồ sơ (tệp trên Google Drive của nhà xe, hoặc liên kết).
// Có hạn, ghi chú, người / giờ tải lên, thay bản mới (bản cũ ẩn / hiện), tìm kiếm, chuyển, đổi tên, xóa.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { fmtDate, today } from '../components/Documents';
import type { Permissions } from '../lib/permissions';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { drive, fileToBase64, openBase64 } from '../lib/drive';

interface Folder { id: string; parent_id: string | null; name: string; note: string | null; created_at: string }
interface Item {
  id: string; folder_id: string | null; kind: 'file' | 'link'; name: string; drive_id: string | null; drive_url: string | null; file_name: string | null;
  mime: string | null; size_bytes: number | null; url: string | null; expires_on: string | null; note: string | null; is_old: boolean;
  created_by: string | null; created_at: string;
}
const OTHERS = '__o';
const isYear = (f: Folder) => !f.parent_id && /^\d{4}$/.test(f.name.trim());
const cmp = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'vi', { numeric: true, sensitivity: 'base' });
const size = (n: number | null) => (!n ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
function icon(it: Item) {
  if (it.kind === 'link') return '🔗';
  const m = it.mime ?? '', x = (it.file_name ?? '').toLowerCase().split('.').pop() ?? '';
  if (m.startsWith('image/')) return '🖼️';
  if (x === 'pdf') return '📕';
  if (/^(doc|docx|odt|rtf|txt|html)$/.test(x)) return '📝';
  if (/^(xls|xlsx|csv|ods)$/.test(x)) return '📊';
  if (/^(zip|rar|7z)$/.test(x)) return '🗜️';
  return '📎';
}
const SEED: [string, string[]][] = [
  ['01. Pháp lý công ty', ['Giấy đăng ký kinh doanh', 'Giấy phép kinh doanh vận tải', 'Con dấu, chữ ký số', 'Điều lệ, quyết định']],
  ['02. Nhân sự', ['Hợp đồng lao động', 'Hồ sơ lái xe, phụ xe', 'Bằng lái, giấy khám sức khỏe', 'Bảo hiểm xã hội']],
  ['03. Phương tiện', ['Đăng ký, đăng kiểm', 'Bảo hiểm xe', 'Phù hiệu, giấy phép lưu hành']],
  ['04. Tài chính - Kế toán', ['Hóa đơn đầu vào', 'Hóa đơn đầu ra', 'Thuế', 'Ngân hàng']],
  ['05. Hợp đồng vận chuyển', ['Hợp đồng đang hiệu lực', 'Hợp đồng đã thanh lý']],
  ['06. Sửa chữa - Nhiên liệu', ['Phiếu sửa chữa', 'Chứng từ nhiên liệu']],
  ['07. Khác', []],
  ['08. Điều hành xe', ['Bảng phân công lịch tài & xe']],
];

type Dlg =
  | { k: 'folder'; id: string | null; parent: string | null; name: string; note: string }
  | { k: 'year'; name: string }
  | { k: 'moveF'; id: string; to: string }
  | { k: 'link'; id: string | null; name: string; url: string; expires: string; note: string }
  | { k: 'editI'; id: string; name: string; expires: string; note: string }
  | { k: 'moveI'; id: string; to: string }
  | { k: 'upload'; files: File[]; replace: Item | null; expires: string; note: string }
  | { k: 'delF'; id: string }
  | { k: 'delI'; id: string };

export function ArchiveScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const canEdit = perms.has('archive.manage');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [plates, setPlates] = useState<string[]>([]);
  const [driveOk, setDriveOk] = useState<boolean | null>(null);
  const [yr, setYr] = useState<string | null>(null);
  const [sel, setSel] = useState<string>('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<Item | null>(null);

  const load = useCallback(async () => {
    const [f, i, st] = await Promise.all([
      supabase.from('archive_folders').select('id, parent_id, name, note, created_at'),
      supabase.from('archive_items').select('id, folder_id, kind, name, drive_id, drive_url, file_name, mime, size_bytes, url, expires_on, note, is_old, created_by, created_at'),
      supabase.rpc('drive_status'),
    ]);
    if (f.error) return toast('error', f.error.message);
    setFolders((f.data ?? []) as Folder[]);
    setItems((i.data ?? []) as Item[]);
    setDriveOk(!!(st.data as { configured?: boolean } | null)?.configured);
    const u = await supabase.from('app_users').select('id, full_name');
    if (!u.error) setPeople(Object.fromEntries(((u.data ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name])));
    const v = await supabase.from('vehicles').select('plate').eq('is_active', true).order('plate');
    if (!v.error) setPlates(((v.data ?? []) as { plate: string }[]).map((x) => x.plate));
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const by = useCallback((id: string | null) => folders.find((f) => f.id === id), [folders]);
  const path = useCallback((id: string | null) => {
    const out: Folder[] = [];
    let f = by(id);
    for (let g = 0; f && g < 60; g++) { out.unshift(f); f = by(f.parent_id); }
    return out;
  }, [by]);
  const ptxt = (id: string | null) => path(id).map((f) => f.name).join(' / ') || 'Gốc';
  const kids = (id: string | null) => folders.filter((f) => (f.parent_id ?? '') === (id ?? '')).sort(cmp);
  const years = useMemo(() => folders.filter(isYear).sort((a, b) => b.name.localeCompare(a.name)), [folders]);
  const others = useMemo(() => folders.filter((f) => !f.parent_id && !isYear(f)).sort(cmp), [folders]);
  const desc = useCallback((id: string) => {
    const s = new Set([id]);
    for (let ch = true; ch;) { ch = false; for (const f of folders) if (f.parent_id && s.has(f.parent_id) && !s.has(f.id)) { s.add(f.id); ch = true; } }
    return s;
  }, [folders]);
  const count = (id: string) => { const d = desc(id); return items.filter((h) => h.folder_id && d.has(h.folder_id) && !h.is_old).length; };

  // Mặc định: năm hiện tại (hoặc năm mới nhất)
  useEffect(() => {
    if (yr !== null || folders.length === 0) return;
    const cur = years.find((y) => y.name === String(new Date().getFullYear())) ?? years[0];
    if (cur) { setYr(cur.id); setSel(cur.id); } else if (others.length) setYr(OTHERS);
  }, [folders, years, others, yr]);

  const cur = sel ? by(sel) : undefined;
  const subs = sel ? kids(sel) : yr === OTHERS ? others : [];
  const list = items.filter((h) => (h.folder_id ?? '') === sel && (showOld || !h.is_old))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const oldCount = items.filter((h) => (h.folder_id ?? '') === sel && h.is_old).length;
  const ql = q.trim().toLowerCase();
  const found = ql ? items.filter((h) => (showOld || !h.is_old) && [h.name, h.file_name, h.note, h.url, ptxt(h.folder_id)].join(' ').toLowerCase().includes(ql)) : [];
  const foundF = ql ? folders.filter((f) => [f.name, f.note].join(' ').toLowerCase().includes(ql)).sort(cmp) : [];

  async function run(label: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(label);
    try {
      await fn();
      if (ok) toast('ok', ok);
      setDlg(null);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  const pick = (id: string) => { setSel(id); setQ(''); setOpen((o) => new Set(o).add(id)); const p = path(id)[0]; if (p) setYr(isYear(p) ? p.id : OTHERS); };
  const chk = <T,>(r: { error: { message: string; code?: string } | null; data?: T }) => {
    if (r.error) throw new Error(r.error.code === '23505' ? 'Tên thư mục đã có trong cùng cấp' : r.error.message);
    return r.data;
  };

  async function seed() {
    const root = yr && yr !== OTHERS ? yr : null;
    let parent = root;
    if (!parent) {
      const y = String(new Date().getFullYear());
      parent = (chk(await supabase.from('archive_folders').insert({ name: y }).select('id').single()) as { id: string }).id;
    }
    for (const [n, ks] of SEED) {
      const f = chk(await supabase.from('archive_folders').insert({ parent_id: parent, name: n }).select('id').single()) as { id: string };
      if (ks.length) chk(await supabase.from('archive_folders').insert(ks.map((k) => ({ parent_id: f.id, name: k }))));
    }
    setYr(parent);
    setSel(parent);
  }
  async function vehFolders() {
    const have = new Set(kids(sel).map((f) => f.name.toLowerCase()));
    const add = plates.filter((p) => !have.has(p.toLowerCase()));
    if (!add.length) { toast('ok', 'Mỗi xe đã có thư mục'); return; }
    chk(await supabase.from('archive_folders').insert(add.map((p) => ({ parent_id: sel, name: p }))));
    toast('ok', `Đã tạo ${add.length} thư mục theo biển số xe`);
  }
  async function upload(files: File[], replace: Item | null, expires: string, note: string) {
    let n = 0;
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { toast('error', `${f.name}: lớn hơn 10 MB, hãy thêm bằng "Liên kết"`); continue; }
      setBusy(`Đang tải lên ${f.name}…`);
      await drive({ action: 'put', folder_id: replace ? replace.folder_id : (sel || null), name: replace ? replace.name : f.name.replace(/\.[^.]+$/, ''),
        file_name: f.name, mime: f.type || 'application/octet-stream', data: await fileToBase64(f), expires_on: expires || null, note: note || null,
        replace_id: replace?.id ?? null });
      n++;
    }
    if (n) toast('ok', replace ? 'Đã thay bản mới, bản cũ được ẩn' : `Đã lưu ${n} hồ sơ vào ${ptxt(sel || null)}`);
  }
  async function view(it: Item, download: boolean) {
    if (it.kind === 'link') { window.open(it.url ?? '#', '_blank', 'noopener'); return; }
    setBusy(`Đang tải ${it.file_name ?? it.name}…`);
    try {
      const r = await drive<{ name: string; mime: string; data: string }>({ action: 'get', id: it.id });
      openBase64(r.name || it.file_name || it.name, r.mime || it.mime || '', r.data, download);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const folderOpts = (skip?: string) => {
    const ban = skip ? desc(skip) : new Set<string>();
    return [{ v: '', l: '(Gốc)' }, ...folders.filter((f) => !ban.has(f.id)).map((f) => ({ v: f.id, l: ptxt(f.id) })).sort((a, b) => a.l.localeCompare(b.l, 'vi', { numeric: true }))];
  };
  const hanBadge = (it: Item) => {
    if (!it.expires_on) return null;
    const d = Math.round((new Date(it.expires_on).getTime() - new Date(today()).getTime()) / 864e5);
    return d < 0 ? <span className="badge locked">Hết hạn {fmtDate(it.expires_on)}</span>
      : d <= 30 ? <span className="badge warn-badge">Còn {d} ngày · {fmtDate(it.expires_on)}</span>
      : <span className="muted small">Hạn {fmtDate(it.expires_on)}</span>;
  };

  function Tree({ id, lv }: { id: string; lv: number }) {
    return (
      <>
        {kids(id).map((f) => {
          const k = kids(f.id);
          const op = open.has(f.id) || path(sel).some((x) => x.id === f.id);
          return (
            <div key={f.id}>
              <div className={sel === f.id ? 'hs-n on' : 'hs-n'} style={{ paddingLeft: 8 + lv * 16 }}>
                <button type="button" className="hs-t" aria-label={op ? 'Thu gọn' : 'Mở rộng'}
                        onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}>{k.length ? (op ? '▾' : '▸') : '·'}</button>
                <button type="button" className="hs-name" onClick={() => pick(f.id)}>📁 {f.name}</button>
                <em>{count(f.id) || ''}</em>
              </div>
              {op && k.length > 0 && <Tree id={f.id} lv={lv + 1} />}
            </div>
          );
        })}
      </>
    );
  }

  const row = (it: Item, showPath: boolean) => (
    <tr key={it.id} className={it.is_old ? 'hs-old' : ''}>
      <td className="hs-ic">{icon(it)}</td>
      <td>
        <button type="button" className="btn link hs-nm" onClick={() => void view(it, false)}><b>{it.name}</b></button>
        {it.is_old && <span className="badge">Bản cũ</span>}
        {showPath && <div className="muted small">{ptxt(it.folder_id)}</div>}
        {it.kind === 'file' && it.file_name && <div className="muted small">{it.file_name}</div>}
      </td>
      <td className="small">{size(it.size_bytes)}</td>
      <td>{hanBadge(it)}</td>
      <td className="small">{it.note}</td>
      <td className="small muted">{it.created_by ? people[it.created_by] ?? '' : ''}<br />{when(it.created_at)}</td>
      <td className="hs-act">
        <button type="button" className="btn small" onClick={() => void view(it, it.kind === 'file')}>{it.kind === 'link' ? 'Mở' : 'Tải xuống'}</button>
        {it.drive_url && <a className="btn small link" href={it.drive_url} target="_blank" rel="noopener noreferrer">Drive</a>}
        {canEdit && (
          <>
            {it.kind === 'file' && !it.is_old && <button type="button" className="btn small" onClick={() => { replaceRef.current = it; fileRef.current?.click(); }}>Thay bản mới</button>}
            <button type="button" className="btn small" onClick={() => setDlg(it.kind === 'link'
              ? { k: 'link', id: it.id, name: it.name, url: it.url ?? '', expires: it.expires_on ?? '', note: it.note ?? '' }
              : { k: 'editI', id: it.id, name: it.name, expires: it.expires_on ?? '', note: it.note ?? '' })}>Sửa</button>
            <button type="button" className="btn small" onClick={() => setDlg({ k: 'moveI', id: it.id, to: it.folder_id ?? '' })}>Chuyển</button>
            {it.is_old && <button type="button" className="btn small" onClick={() => void run('a', async () => chk(await supabase.from('archive_items').update({ is_old: false }).eq('id', it.id)), 'Đã hiện lại')}>Dùng lại</button>}
            <button type="button" className="btn small link danger-text" onClick={() => setDlg({ k: 'delI', id: it.id })}>Xóa</button>
          </>
        )}
      </td>
    </tr>
  );

  const table = (rows: Item[], showPath: boolean) => (
    <div className="table-wrap">
      <table className="plist hs-tbl">
        <thead><tr><th /><th>Tên hồ sơ</th><th>Dung lượng</th><th>Hạn</th><th>Ghi chú</th><th>Tải lên</th><th /></tr></thead>
        <tbody>{rows.map((h) => row(h, showPath))}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <input ref={fileRef} type="file" multiple hidden aria-label="Chọn tệp hồ sơ" onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length) setDlg({ k: 'upload', files: replaceRef.current ? files.slice(0, 1) : files, replace: replaceRef.current, expires: replaceRef.current?.expires_on ?? '', note: '' });
        replaceRef.current = null;
      }} />
      {driveOk === false && (
        <section className="card warn small">Chưa kết nối Google Drive nên chưa tải tệp lên được (vẫn thêm thư mục và liên kết được).
          Vào <b>Cấu hình → Kho hồ sơ Google Drive</b> để kết nối.</section>
      )}
      <section className="card">
        <div className="hs-yb">
          <b>Năm</b>
          {years.map((y) => (
            <button key={y.id} type="button" className={yr === y.id ? 'hs-y on' : 'hs-y'} onClick={() => { setYr(y.id); setSel(y.id); setQ(''); }}>
              {y.name}<em>{count(y.id) || ''}</em>
            </button>
          ))}
          {others.length > 0 && <button type="button" className={yr === OTHERS ? 'hs-y on' : 'hs-y'} onClick={() => { setYr(OTHERS); setSel(''); setQ(''); }}>Chưa phân năm</button>}
          {canEdit && <button type="button" className="btn small" onClick={() => setDlg({ k: 'year', name: String(years.length ? Math.max(...years.map((y) => Number(y.name))) + 1 : new Date().getFullYear()) })}>+ Năm</button>}
        </div>
        <div className="hs-tools">
          <input className="hs-q" placeholder="Tìm thư mục, hồ sơ…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm hồ sơ" />
          {canEdit && (
            <>
              <button type="button" className="btn small primary" disabled={!driveOk || !!busy} onClick={() => { replaceRef.current = null; fileRef.current?.click(); }}>⬆ Tải hồ sơ lên</button>
              <button type="button" className="btn small" onClick={() => setDlg({ k: 'link', id: null, name: '', url: '', expires: '', note: '' })}>🔗 Thêm liên kết</button>
              <button type="button" className="btn small" onClick={() => setDlg({ k: 'folder', id: null, parent: sel || (yr && yr !== OTHERS ? yr : null), name: '', note: '' })}>+ Thư mục{sel ? ' con' : ''}</button>
              {cur && (
                <>
                  <button type="button" className="btn small" onClick={() => setDlg({ k: 'folder', id: cur.id, parent: cur.parent_id, name: cur.name, note: cur.note ?? '' })}>Đổi tên</button>
                  <button type="button" className="btn small" onClick={() => setDlg({ k: 'moveF', id: cur.id, to: cur.parent_id ?? '' })}>Chuyển</button>
                  <button type="button" className="btn small link danger-text" onClick={() => setDlg({ k: 'delF', id: cur.id })}>Xóa thư mục</button>
                </>
              )}
              {cur && /phương tiện|phuong tien|\bxe\b/i.test(cur.name) && <button type="button" className="btn small" onClick={() => void run('v', vehFolders)}>Thư mục theo từng xe</button>}
            </>
          )}
        </div>
        {busy && <p className="small state-sap_het">{busy}</p>}
      </section>

      <div className="hs">
        <section className="card hs-side">
          <h3>📁 Cây thư mục</h3>
          {yr && yr !== OTHERS && by(yr) && (
            <div className={sel === yr ? 'hs-n on' : 'hs-n'}>
              <span className="hs-t">·</span>
              <button type="button" className="hs-name" onClick={() => pick(yr)}>📅 {by(yr)?.name}</button><em>{count(yr) || ''}</em>
            </div>
          )}
          {yr === OTHERS ? others.map((f) => <div key={f.id}><div className={sel === f.id ? 'hs-n on' : 'hs-n'}><span className="hs-t">·</span>
            <button type="button" className="hs-name" onClick={() => pick(f.id)}>📁 {f.name}</button><em>{count(f.id) || ''}</em></div>
            {(open.has(f.id) || path(sel).some((x) => x.id === f.id)) && <Tree id={f.id} lv={1} />}</div>)
            : yr ? <Tree id={yr} lv={1} /> : null}
          {(!yr || (yr !== OTHERS && kids(yr).length === 0)) && (
            <div className="muted small hs-empty">Chưa có thư mục trong năm này.
              {canEdit && <><br /><button type="button" className="btn small primary" onClick={() => void run('s', seed, 'Đã tạo cây thư mục mẫu, đổi tên, thêm, bớt tùy ý')}>Tạo cây thư mục mẫu cho nhà xe</button></>}
            </div>
          )}
        </section>

        <section className="card hs-main">
          {ql ? (
            <>
              <h3>Kết quả tìm “{q}” · {foundF.length} thư mục · {found.length} hồ sơ</h3>
              {foundF.length > 0 && <div className="hs-fg">{foundF.map((f) => (
                <button key={f.id} type="button" className="hs-fc" onClick={() => pick(f.id)}>📁 <span><b>{f.name}</b><small>{ptxt(f.parent_id)}</small></span></button>
              ))}</div>}
              {found.length ? table(found, true) : foundF.length ? null : <p className="muted">Không tìm thấy.</p>}
            </>
          ) : (
            <>
              <div className="hs-bc">
                <button type="button" className="btn link small" onClick={() => setSel(yr && yr !== OTHERS ? yr : '')}>Tất cả hồ sơ</button>
                {path(sel).map((f) => <span key={f.id}> › <button type="button" className="btn link small" onClick={() => pick(f.id)}>{f.name}</button></span>)}
                <span className="muted small"> · {subs.length} thư mục · {list.length} hồ sơ</span>
                {oldCount > 0 && <button type="button" className="btn small" onClick={() => setShowOld(!showOld)}>{showOld ? 'Ẩn' : 'Xem'} bản cũ ({oldCount})</button>}
              </div>
              {cur?.note && <p className="hs-nt">{cur.note}</p>}
              {subs.length > 0 && <div className="hs-fg">{subs.map((f) => (
                <button key={f.id} type="button" className="hs-fc" onClick={() => pick(f.id)}>📁 <span><b>{f.name}</b>
                  <small>{kids(f.id).length ? `${kids(f.id).length} thư mục · ` : ''}{count(f.id)} hồ sơ</small></span></button>
              ))}</div>}
              {list.length > 0 ? table(list, false) : subs.length ? null : <p className="muted hs-empty">📂 Thư mục trống.{canEdit && driveOk ? ' Bấm "Tải hồ sơ lên" để thêm.' : ''}</p>}
            </>
          )}
        </section>
      </div>

      {dlg && <ArchiveDialog dlg={dlg} setDlg={setDlg} busy={!!busy} folderOpts={folderOpts} title={(id) => by(id)?.name ?? ''}
        countIn={(id) => ({ folders: desc(id).size - 1, items: items.filter((h) => h.folder_id && desc(id).has(h.folder_id)).length })}
        itemName={(id) => items.find((h) => h.id === id)?.name ?? ''}
        onSubmit={(d) => {
          if (d.k === 'year') {
            if (!/^\d{4}$/.test(d.name.trim())) return toast('error', 'Năm gồm 4 chữ số');
            return void run('y', async () => { const r = chk(await supabase.from('archive_folders').insert({ name: d.name.trim() }).select('id').single()) as { id: string }; setYr(r.id); setSel(r.id); }, `Đã thêm năm ${d.name}`);
          }
          if (d.k === 'folder') {
            return void run('f', async () => chk(d.id
              ? await supabase.from('archive_folders').update({ name: d.name.trim(), note: d.note || null }).eq('id', d.id)
              : await supabase.from('archive_folders').insert({ parent_id: d.parent, name: d.name.trim(), note: d.note || null })), d.id ? 'Đã sửa thư mục' : 'Đã thêm thư mục');
          }
          if (d.k === 'moveF') return void run('m', async () => chk(await supabase.from('archive_folders').update({ parent_id: d.to || null }).eq('id', d.id)), 'Đã chuyển thư mục');
          if (d.k === 'moveI') return void run('m', async () => chk(await supabase.from('archive_items').update({ folder_id: d.to || null }).eq('id', d.id)), 'Đã chuyển hồ sơ');
          if (d.k === 'editI') return void run('e', async () => chk(await supabase.from('archive_items').update({ name: d.name.trim(), expires_on: d.expires || null, note: d.note || null }).eq('id', d.id)), 'Đã sửa hồ sơ');
          if (d.k === 'link') {
            let u = d.url.trim();
            if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
            if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(u)) return toast('error', 'Địa chỉ liên kết không hợp lệ');
            const v = { name: d.name.trim(), url: u, expires_on: d.expires || null, note: d.note || null };
            return void run('l', async () => chk(d.id ? await supabase.from('archive_items').update(v).eq('id', d.id)
              : await supabase.from('archive_items').insert({ ...v, kind: 'link', folder_id: sel || null })), d.id ? 'Đã sửa liên kết' : 'Đã thêm liên kết');
          }
          if (d.k === 'upload') return void run('u', () => upload(d.files, d.replace, d.expires, d.note));
          if (d.k === 'delI') return void run('d', () => drive({ action: 'del', id: d.id }), 'Đã xóa hồ sơ (tệp trên Drive vào thùng rác, khôi phục được 30 ngày)');
          if (d.k === 'delF') return void run('d', async () => { await drive({ action: 'del_folder', id: d.id }); setSel(by(d.id)?.parent_id ?? ''); }, 'Đã xóa thư mục');
        }} />}
    </>
  );
}

function ArchiveDialog(props: {
  dlg: Dlg; setDlg: (d: Dlg | null) => void; busy: boolean; folderOpts: (skip?: string) => { v: string; l: string }[]; title: (id: string) => string;
  countIn: (id: string) => { folders: number; items: number }; itemName: (id: string) => string; onSubmit: (d: Dlg) => void;
}) {
  const { dlg: d, setDlg, busy, onSubmit } = props;
  const close = () => setDlg(null);
  const set = (p: Partial<Dlg>) => setDlg({ ...d, ...p } as Dlg);
  const actions = (label: string, danger = false) => (
    <div className="actions">
      <button type="submit" className={danger ? 'btn danger' : 'btn primary'} disabled={busy}>{label}</button>
      <button type="button" className="btn link" onClick={close}>Hủy</button>
    </div>
  );
  const titles: Record<Dlg['k'], string> = {
    folder: d.k === 'folder' && d.id ? 'Sửa thư mục' : 'Thư mục mới', year: 'Thêm năm lưu trữ', moveF: 'Chuyển thư mục', link: d.k === 'link' && d.id ? 'Sửa liên kết' : 'Thêm liên kết hồ sơ',
    editI: 'Sửa hồ sơ', moveI: 'Chuyển hồ sơ', upload: d.k === 'upload' && d.replace ? 'Thay bản mới' : 'Tải hồ sơ lên', delF: 'Xóa thư mục', delI: 'Xóa hồ sơ',
  };
  return (
    <Modal title={titles[d.k]} onClose={close}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSubmit(d); }}>
        {d.k === 'year' && <><label>Năm (4 chữ số)<input value={d.name} onChange={(e) => set({ name: e.target.value })} required /></label>{actions('Thêm năm')}</>}
        {d.k === 'folder' && (
          <>
            {!d.id && <p className="small muted">Trong: {d.parent ? props.title(d.parent) : '(Gốc)'}</p>}
            <label>Tên thư mục<input value={d.name} onChange={(e) => set({ name: e.target.value })} required autoFocus /></label>
            <label>Ghi chú<textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} /></label>
            {actions(d.id ? 'Lưu' : 'Thêm thư mục')}
          </>
        )}
        {(d.k === 'moveF' || d.k === 'moveI') && (
          <>
            <p className="small">{d.k === 'moveF' ? `Thư mục “${props.title(d.id)}”` : `Hồ sơ “${props.itemName(d.id)}”`}</p>
            <label>Chuyển vào
              <select value={d.to} onChange={(e) => set({ to: e.target.value })}>
                {props.folderOpts(d.k === 'moveF' ? d.id : undefined).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
            </label>
            {actions('Chuyển')}
          </>
        )}
        {d.k === 'link' && (
          <>
            <label>Tên hồ sơ<input value={d.name} onChange={(e) => set({ name: e.target.value })} required /></label>
            <label>Địa chỉ liên kết (Google Drive, website…)<input value={d.url} onChange={(e) => set({ url: e.target.value })} required /></label>
            <label>Ngày hết hạn (nếu có)<input type="date" value={d.expires} onChange={(e) => set({ expires: e.target.value })} /></label>
            <label>Ghi chú<textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} /></label>
            {actions('Lưu')}
          </>
        )}
        {d.k === 'editI' && (
          <>
            <label>Tên hồ sơ<input value={d.name} onChange={(e) => set({ name: e.target.value })} required /></label>
            <label>Ngày hết hạn (nếu có)<input type="date" value={d.expires} onChange={(e) => set({ expires: e.target.value })} /></label>
            <label>Ghi chú<textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} /></label>
            {actions('Lưu')}
          </>
        )}
        {d.k === 'upload' && (
          <>
            <ul className="small">{d.files.map((f) => <li key={f.name}>{f.name} · {(f.size / 1048576).toFixed(2)} MB</li>)}</ul>
            {d.replace && <p className="small muted">Thay cho “{d.replace.name}”: bản cũ được ẩn (xem lại bằng nút “Xem bản cũ”).</p>}
            <label>Ngày hết hạn (nếu có)<input type="date" value={d.expires} onChange={(e) => set({ expires: e.target.value })} /></label>
            <label>Ghi chú<textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} /></label>
            {actions(busy ? 'Đang tải lên…' : 'Lưu lên Google Drive')}
          </>
        )}
        {d.k === 'delF' && (() => {
          const c = props.countIn(d.id);
          return (
            <>
              <p>Xóa thư mục <b>{props.title(d.id)}</b>{c.folders ? <> cùng <b>{c.folders}</b> thư mục con</> : null}{c.items ? <> và <b>{c.items}</b> hồ sơ bên trong</> : null}?</p>
              <p className="small muted">Tệp trên Google Drive vào thùng rác, khôi phục được trong 30 ngày.</p>
              {actions('Xóa', true)}
            </>
          );
        })()}
        {d.k === 'delI' && (
          <>
            <p>Xóa hồ sơ <b>{props.itemName(d.id)}</b>?</p>
            <p className="small muted">Tệp trên Google Drive vào thùng rác, khôi phục được trong 30 ngày.</p>
            {actions('Xóa', true)}
          </>
        )}
      </form>
    </Modal>
  );
}
