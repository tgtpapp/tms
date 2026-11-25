// Lái xe & nhân viên: Tổng quan · Sơ đồ tổ chức · In thẻ nhân viên · Báo cáo nhân sự theo tháng.
// Chỉ đọc dữ liệu đang có (hồ sơ, giấy tờ); không thêm bảng. Tuổi, sinh nhật chỉ có với người được xem hồ sơ riêng.
import { useEffect, useMemo, useState } from 'react';
import { Avatar } from './StaffAvatar';
import { PaperView } from './ProfilePapers';
import { fmtDate, today, type Doc } from './Documents';
import { company, head, type Page } from '../lib/profilePapers';
import { toDataUrl } from '../lib/pdfMaker';
import { downloadXlsx } from '../lib/xlsxWrite';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Position = 'lai_xe' | 'phu_xe' | 'nhan_vien';
export interface OvStaff {
  id: string; user_id: string | null; full_name: string; position: Position; phone: string | null; joined_on: string; left_on: string | null;
  is_active: boolean; job_title: string | null; department: string | null;
}
export interface OvPriv { staff_id: string; birth_date: string | null; gender: 'nam' | 'nu' | null }
interface Common { staff: OvStaff[]; priv: OvPriv[]; avas: Record<string, string>; onOpen?: (id: string) => void }

const POS: Record<Position, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#ea580c', '#475569'];
const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const job = (s: OvStaff) => s.job_title?.trim() || POS[s.position];
const dept = (s: OvStaff) => s.department?.trim() || POS[s.position];
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const years = (from: string, to: string) => { const [a, b, c] = from.split('-').map(Number); const [x, y, z] = to.split('-').map(Number); return x! - a! - (y! < b! || (y === b && z! < c!) ? 1 : 0); };
/** Còn làm tại ngày d */
const workingAt = (s: OvStaff, d: string) => !!s.joined_on && s.joined_on <= d && !(s.left_on && s.left_on <= d);
function monthsBack(n: number): string[] {
  const t = today(); let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y--; } }
  return out;
}
const monthEnd = (k: string) => { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10); return d > today() ? today() : d; };
const mLabel = (k: string) => `T${Number(k.slice(5, 7))}`;
const mName = (k: string) => `Tháng ${Number(k.slice(5, 7))}/${k.slice(0, 4)}`;
/** Ban giám đốc: chức vụ có "giám đốc" (giám đốc trước, phó sau) */
const isBoss = (s: OvStaff) => fold(job(s)).includes('giam doc');
const isHead = (s: OvStaff) => /truong|quan ly/.test(fold(job(s))) && !isBoss(s);

function Who({ s, avas, onOpen, size = 40, sub }: { s: OvStaff; avas: Record<string, string>; onOpen?: (id: string) => void; size?: number; sub?: string }) {
  const body = <><Avatar name={s.full_name} url={avas[s.id]} size={size} /><span className="nsx-who-t"><b>{s.full_name}</b><small>{sub ?? job(s)}</small></span></>;
  return onOpen ? <button type="button" className="nsx-whob" onClick={() => onOpen(s.id)}>{body}</button> : <div className="nsx-whob">{body}</div>;
}

/* ------------------------------------------------------------------ Tổng quan */

function Bars({ labels, series, height = 150 }: { labels: string[]; series: { name: string; color: string; data: number[] }[]; height?: number }) {
  const W = 360, pl = 26, pb = 18, pt = 8, ih = height - pb - pt, n = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  const cw = (W - pl) / n, bw = Math.max(3, Math.min(14, (cw - 4) / series.length - 1));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="nsx-chart" role="img" aria-label={series.map((s) => s.name).join(', ')}>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={pl} x2={W} y1={pt + ih * (1 - f)} y2={pt + ih * (1 - f)} className="nsx-grid" />
        <text x={pl - 4} y={pt + ih * (1 - f) + 3} textAnchor="end" className="nsx-ax">{Math.round(max * f)}</text></g>)}
      {labels.map((l, i) => {
        const cx = pl + cw * i + cw / 2, tw = series.length * (bw + 1);
        return (
          <g key={l + i}>
            {series.map((s, j) => { const v = s.data[i] ?? 0, h = (ih * v) / max;
              return <rect key={s.name} x={cx - tw / 2 + j * (bw + 1)} y={pt + ih - h} width={bw} height={Math.max(v ? 2 : 0, h)} rx={2} fill={s.color}><title>{`${s.name} ${l}: ${v}`}</title></rect>; })}
            <text x={cx} y={height - 4} textAnchor="middle" className="nsx-ax">{l}</text>
          </g>
        );
      })}
    </svg>
  );
}
function HBars({ items }: { items: { label: string; value: number; color: string }[] }) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <div className="nsx-hbars">
      {items.map((x) => (
        <div key={x.label} className="nsx-hb"><div className="nsx-hb-h"><span>{x.label}</span><b>{x.value}</b></div>
          <div className="nsx-hb-bar"><i style={{ width: `${Math.max(3, (x.value / max) * 100)}%`, background: x.color }} /></div></div>
      ))}
    </div>
  );
}

export function StaffDashboard({ staff, priv, avas, onOpen, papers, warnDays }: Common & { papers: Doc[]; warnDays: number }) {
  const td = today();
  const act = staff.filter((s) => s.is_active);
  const ms = monthsBack(12);
  const hc = ms.map((k) => staff.filter((s) => workingAt(s, monthEnd(k))).length);
  const hire = ms.map((k) => staff.filter((s) => s.joined_on?.startsWith(k)).length);
  const left = ms.map((k) => staff.filter((s) => s.left_on?.startsWith(k)).length);
  const byDept = Object.entries(act.reduce<Record<string, number>>((m, s) => { m[dept(s)] = (m[dept(s)] ?? 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: COLORS[i % COLORS.length]! }));
  const pv = new Map(priv.map((p) => [p.staff_id, p]));
  const ages = act.map((s) => pv.get(s.id)?.birth_date).filter((b): b is string => !!b).map((b) => years(b, td));
  const ageB: [string, number, number][] = [['Dưới 30', 0, 29], ['30–39', 30, 39], ['40–49', 40, 49], ['50–54', 50, 54], ['Từ 55', 55, 200]];
  const tenure = act.length ? act.reduce((a, s) => a + Math.max(0, (Date.parse(td) - Date.parse(s.joined_on)) / (365.25 * 864e5)), 0) / act.length : 0;
  const month = td.slice(5, 7);
  const bd = act.filter((s) => pv.get(s.id)?.birth_date?.slice(5, 7) === month)
    .sort((a, b) => pv.get(a.id)!.birth_date!.slice(8).localeCompare(pv.get(b.id)!.birth_date!.slice(8)));
  const NEED: Record<Position, string[]> = { lai_xe: ['gplx', 'kham_suc_khoe', 'tap_huan', 'cccd'], phu_xe: ['cccd'], nhan_vien: ['cccd'] };
  const NAME: Record<string, string> = { gplx: 'GPLX', kham_suc_khoe: 'Khám sức khỏe', tap_huan: 'Tập huấn', cccd: 'CCCD' };
  const lim = new Date(Date.parse(td) + warnDays * 864e5).toISOString().slice(0, 10);
  const exp = act.flatMap((s) => NEED[s.position].map((t) => ({ s, t, d: papers.find((x) => x.staff_id === s.id && x.doc_type === t && x.is_current) })))
    .filter((x) => x.d?.expires_on && x.d.expires_on <= lim).sort((a, b) => a.d!.expires_on!.localeCompare(b.d!.expires_on!));
  const kpi: [string, number | string, string][] = [
    ['Đang làm', act.length, `${act.filter((s) => s.position === 'lai_xe').length} lái xe · ${act.filter((s) => s.position === 'phu_xe').length} phụ xe`],
    ['Vào làm 12 tháng', hire.reduce((a, x) => a + x, 0), `${hire[11]} người tháng này`],
    ['Nghỉ việc 12 tháng', left.reduce((a, x) => a + x, 0), `${left[11]} người tháng này`],
    ['Thâm niên bình quân', `${tenure.toFixed(1).replace('.', ',')} năm`, ages.length ? `Tuổi bình quân ${(ages.reduce((a, x) => a + x, 0) / ages.length).toFixed(1).replace('.', ',')}` : ''],
  ];
  return (
    <div className="nsx-ov">
      <div className="nsx-kpis">{kpi.map(([l, v, sub]) => <div key={l} className="nsx-kpi"><small>{l}</small><b>{v}</b>{sub && <span>{sub}</span>}</div>)}</div>
      <section className="card"><h3>Số người cuối mỗi tháng</h3><Bars labels={ms.map(mLabel)} series={[{ name: 'Số người', color: 'var(--primary)', data: hc }]} /></section>
      <section className="card"><h3>Vào làm / nghỉ việc 12 tháng</h3>
        <Bars labels={ms.map(mLabel)} series={[{ name: 'Vào làm', color: '#16a34a', data: hire }, { name: 'Nghỉ việc', color: '#dc2626', data: left }]} />
        <p className="nsx-legend"><span><i style={{ background: '#16a34a' }} />Vào làm</span><span><i style={{ background: '#dc2626' }} />Nghỉ việc</span></p></section>
      <section className="card"><h3>Theo bộ phận</h3>{byDept.length ? <HBars items={byDept} /> : <p className="muted">Chưa có</p>}</section>
      {ages.length > 0 && <section className="card"><h3>Độ tuổi</h3><HBars items={ageB.map(([l, a, b], i) => ({ label: l, value: ages.filter((x) => x >= a && x <= b).length, color: COLORS[i]! }))} /></section>}
      <section className="card"><h3>Giấy tờ đã / sắp hết hạn ({exp.length})</h3>
        {exp.length === 0 ? <p className="muted">Không có giấy nào hết hạn trong {warnDays} ngày tới.</p> : (
          <div className="nsx-list">{exp.slice(0, 12).map((x) => (
            <div key={x.s.id + x.t} className="nsx-li"><Who s={x.s} avas={avas} onOpen={onOpen} size={36} sub={`${NAME[x.t]} · ${fmtDate(x.d!.expires_on)}`} />
              <span className={`badge ${x.d!.expires_on! < td ? 'locked' : 'warn-badge'}`}>{x.d!.expires_on! < td ? 'Đã hết hạn' : 'Sắp hết hạn'}</span></div>
          ))}{exp.length > 12 && <p className="muted small">… và {exp.length - 12} giấy khác (xem chuông cảnh báo ở tab Hồ sơ)</p>}</div>
        )}</section>
      {priv.length > 0 && <section className="card"><h3>Sinh nhật tháng {Number(month)} ({bd.length})</h3>
        {bd.length === 0 ? <p className="muted">Tháng này không có ai sinh nhật.</p> : (
          <div className="nsx-list">{bd.map((s) => { const b = pv.get(s.id)!.birth_date!; const dd = b.slice(8);
            return <div key={s.id} className="nsx-li"><Who s={s} avas={avas} onOpen={onOpen} size={36} sub={`${dept(s)} · tròn ${years(b, `${td.slice(0, 4)}-12-31`)} tuổi`} />
              <span className={`badge${dd === td.slice(8) ? '' : ' muted-badge'}`}>{dd === td.slice(8) ? 'Hôm nay' : `${dd}/${month}`}</span></div>; })}</div>
        )}</section>}
    </div>
  );
}

/* ------------------------------------------------------------------ Sơ đồ tổ chức */

function orgOf(staff: OvStaff[]) {
  const act = staff.filter((s) => s.is_active);
  const bosses = act.filter(isBoss).sort((a, b) => Number(fold(job(a)).includes('pho')) - Number(fold(job(b)).includes('pho')) || a.full_name.localeCompare(b.full_name, 'vi'));
  const m = new Map<string, OvStaff[]>();
  for (const s of act.filter((x) => !isBoss(x))) m.set(dept(s), [...(m.get(dept(s)) ?? []), s]);
  const depts = [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'vi')).map(([name, list], i) => ({
    name, color: COLORS[i % COLORS.length]!, heads: list.filter(isHead), rest: list.filter((s) => !isHead(s)).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')), n: list.length,
  }));
  return { bosses, depts, total: act.length };
}

export function StaffOrg({ staff, avas, onOpen }: Common) {
  const toast = useToast();
  const o = useMemo(() => orgOf(staff), [staff]);
  const [view, setView] = useState<Page[] | null>(null);
  async function print() {
    try {
      const co = await company();
      const img = (s: OvStaff, px: number) => avas[s.id] ? `<img src="${avas[s.id]}" alt="" style="width:${px}px;height:${px}px;border-radius:50%;object-fit:cover">` : '';
      const html = `${head(co)}<h2 style="text-align:center;margin:12px 0">SƠ ĐỒ TỔ CHỨC</h2>
        <div style="text-align:center;margin-bottom:10px">${o.bosses.map((s) => `<div style="display:inline-block;margin:0 10px;text-align:center">${img(s, 56)}<br><b>${esc(s.full_name)}</b><br><i style="font-size:12px">${esc(job(s))}</i></div>`).join('')}</div>
        <table style="width:100%;border-collapse:collapse"><tr>${o.depts.map((d) => `<td style="vertical-align:top;border:1px solid #333;border-top:4px solid ${d.color};padding:6px;font-size:12px">
          <div style="text-align:center;font-weight:bold;font-size:13px">${esc(d.name)} (${d.n})</div>
          ${[...d.heads, ...d.rest].map((s) => `<div style="padding:3px 0;border-top:1px dashed #ccc">${d.heads.includes(s) ? '<b>' : ''}${esc(s.full_name)}${d.heads.includes(s) ? '</b>' : ''}<br><i>${esc(job(s))}</i></div>`).join('')}</td>`).join('')}</tr></table>`;
      setView([{ html, land: true }]);
    } catch (e) { toast('error', errMsg(e)); }
  }
  return (
    <div className="nsx-org">
      <div className="nsx-org-bar"><span className="muted">{o.total} người · {o.depts.length} bộ phận</span><button type="button" className="btn small" onClick={() => void print()}>🖨 In sơ đồ</button></div>
      {o.bosses.length > 0 && <div className="nsx-org-top">{o.bosses.map((s, i) => <div key={s.id} className={`nsx-onode${i === 0 ? ' ceo' : ''}`}><Who s={s} avas={avas} onOpen={onOpen} size={i === 0 ? 64 : 52} /></div>)}</div>}
      <div className="nsx-depts">
        {o.depts.map((d) => (
          <div key={d.name} className="nsx-dcol" style={{ borderTopColor: d.color }}>
            <div className="nsx-dh" style={{ color: d.color }}>{d.name} <small className="muted">({d.n})</small></div>
            {d.heads.map((s) => <div key={s.id} className="nsx-dhead"><Who s={s} avas={avas} onOpen={onOpen} size={44} /></div>)}
            {d.rest.map((s) => <div key={s.id} className="nsx-mem"><Who s={s} avas={avas} onOpen={onOpen} size={32} /></div>)}
          </div>
        ))}
      </div>
      {view && <PaperView title="Sơ đồ tổ chức" pages={view} onClose={() => setView(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ In thẻ nhân viên (85,6 x 54 mm) */

export function StaffCards({ staff, avas }: Common) {
  const toast = useToast();
  const act = useMemo(() => staff.filter((s) => s.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')), [staff]);
  const depts = [...new Set(act.map(dept))].sort((a, b) => a.localeCompare(b, 'vi'));
  const [d, setD] = useState('');
  const list = act.filter((s) => !d || dept(s) === d);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [co, setCo] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<Page[] | null>(null);
  useEffect(() => { void company().then((c) => setCo(c.name)).catch(() => undefined); }, []);
  const chosen = list.filter((s) => sel.has(s.id));
  const color = (s: OvStaff) => (s.position === 'lai_xe' ? '#16a34a' : s.position === 'phu_xe' ? '#f59e0b' : '#2563eb');
  const card = (s: OvStaff, photo: string | null) => `<div style="width:85.6mm;height:54mm;border:1px dashed #9aa3b5;border-radius:3mm;overflow:hidden;display:flex;font-family:Arial,sans-serif;color:#111;break-inside:avoid">
    <div style="width:30mm;background:${color(s)};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2mm;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact">
      ${photo ? `<img src="${photo}" alt="" style="width:23mm;height:23mm;border-radius:2mm;object-fit:cover;border:0.8mm solid #fff">` : `<div style="width:23mm;height:23mm;border-radius:2mm;border:0.8mm solid #fff;display:flex;align-items:center;justify-content:center;font-size:9mm;font-weight:bold">${esc(s.full_name.trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase())}</div>`}
      <div style="font-size:7pt;font-weight:bold;letter-spacing:.5px">${esc(POS[s.position].toUpperCase())}</div></div>
    <div style="flex:1;padding:3mm 3.5mm;display:flex;flex-direction:column">
      <div style="font-size:6pt;font-weight:bold;color:#555">${esc(co.toUpperCase())}</div>
      <div style="font-size:7pt;font-weight:bold;color:${color(s)};letter-spacing:1.5px;margin-top:1.5mm">THẺ NHÂN VIÊN</div>
      <div style="font-size:12pt;font-weight:bold;line-height:1.15;margin-top:2mm">${esc(s.full_name)}</div>
      <div style="font-size:8pt;margin-top:1mm">${esc(job(s))}</div>
      <div style="font-size:7pt;color:${color(s)};font-weight:bold">${esc(dept(s))}</div>
      <div style="margin-top:auto;font-size:7pt"><span style="color:#666">Ngày vào làm</span> <b>${fmtDate(s.joined_on)}</b>${s.phone ? `<br><span style="color:#666">ĐT</span> <b>${esc(s.phone)}</b>` : ''}</div></div></div>`;
  async function print() {
    setBusy(true);
    try {
      const photos = await Promise.all(chosen.map((s) => toDataUrl(avas[s.id] ?? null)));
      const cards = chosen.map((s, i) => card(s, photos[i] ?? null));
      const pages: Page[] = [];
      for (let i = 0; i < cards.length; i += 8) pages.push({ land: false, html: `<div style="display:grid;grid-template-columns:repeat(2,85.6mm);gap:6mm 8mm;justify-content:center">${cards.slice(i, i + 8).join('')}</div>` });
      setView(pages);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="nsx-cards">
      <div className="nsx-org-bar">
        <select className="nsx-search" value={d} onChange={(e) => setD(e.target.value)} aria-label="Lọc bộ phận"><option value="">Tất cả bộ phận</option>{depts.map((x) => <option key={x}>{x}</option>)}</select>
        <button type="button" className="btn small" onClick={() => setSel(new Set([...sel, ...list.map((s) => s.id)]))}>Chọn tất cả</button>
        <button type="button" className="btn small" onClick={() => setSel(new Set())}>Bỏ chọn</button>
        <button type="button" className="btn small primary" disabled={!chosen.length || busy} onClick={() => void print()}>{busy ? 'Đang chuẩn bị…' : `🖨 In ${chosen.length} thẻ`}</button>
      </div>
      <p className="muted small">Khổ thẻ ATM 85,6 x 54 mm, 8 thẻ một trang A4, cắt theo đường viền.</p>
      <div className="nsx-pick">{list.map((s) => (
        <label key={s.id} className={`nsx-tp${sel.has(s.id) ? ' on' : ''}`}>
          <input type="checkbox" checked={sel.has(s.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(s.id); else n.delete(s.id); setSel(n); }} />
          <Avatar name={s.full_name} url={avas[s.id]} size={28} /><span>{s.full_name}</span></label>
      ))}</div>
      <div className="nsx-cardgrid">{chosen.map((s) => <div key={s.id} className="nsx-cardpv" dangerouslySetInnerHTML={{ __html: card(s, avas[s.id] ?? null) }} />)}</div>
      {view && <PaperView title={`In ${chosen.length} thẻ nhân viên`} pages={view} onClose={() => setView(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ Báo cáo nhân sự theo tháng */

export function StaffReport({ staff, avas }: Common) {
  const toast = useToast();
  const ms = monthsBack(12).reverse();
  const [k, setK] = useState(ms[0]!);
  const [view, setView] = useState<Page[] | null>(null);
  const first = `${k}-01`, last = monthEnd(k);
  const before = new Date(Date.parse(first) - 864e5).toISOString().slice(0, 10);
  const depts = [...new Set(staff.filter((s) => workingAt(s, last) || workingAt(s, before) || s.joined_on?.startsWith(k) || s.left_on?.startsWith(k)).map(dept))].sort((a, b) => a.localeCompare(b, 'vi'));
  const rows = depts.map((d) => {
    const inD = staff.filter((s) => dept(s) === d);
    const end = inD.filter((s) => workingAt(s, last));
    return { d, beg: inD.filter((s) => workingAt(s, before)).length, hire: inD.filter((s) => s.joined_on?.startsWith(k)).length, left: inD.filter((s) => s.left_on?.startsWith(k)).length,
      end: end.length, lx: end.filter((s) => s.position === 'lai_xe').length, px: end.filter((s) => s.position === 'phu_xe').length, nv: end.filter((s) => s.position === 'nhan_vien').length };
  });
  const sum = (f: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + Number(r[f]), 0);
  const hires = staff.filter((s) => s.joined_on?.startsWith(k)).sort((a, b) => a.joined_on.localeCompare(b.joined_on));
  const lefts = staff.filter((s) => s.left_on?.startsWith(k)).sort((a, b) => a.left_on!.localeCompare(b.left_on!));
  const avg = (sum('beg') + sum('end')) / 2;
  const rate = avg ? (sum('left') / avg) * 100 : 0;
  const H = ['Bộ phận', 'Đầu kỳ', 'Vào làm', 'Nghỉ việc', 'Cuối kỳ', 'Lái xe', 'Phụ xe', 'Nhân viên'];
  const cells = (r: (typeof rows)[number]) => [r.d, r.beg, r.hire, r.left, r.end, r.lx, r.px, r.nv];
  async function print() {
    try {
      const co = await company();
      const TH = 'border:1px solid #333;padding:5px;font-size:12.5px;background:#e2e8f0';
      const TD = 'border:1px solid #333;padding:5px;font-size:12.5px';
      const tbl = (h: string[], rs: (string | number)[][]) => `<table style="width:100%;border-collapse:collapse;margin:4px 0 10px"><tr>${h.map((x) => `<th style="${TH}">${x}</th>`).join('')}</tr>${rs.map((r) => `<tr>${r.map((c, i) => `<td style="${TD};text-align:${i ? 'center' : 'left'}">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
      const html = `${head(co)}<h2 style="text-align:center;margin:14px 0 2px">BÁO CÁO TÌNH HÌNH NHÂN SỰ ${mName(k).toUpperCase()}</h2>
        <p style="text-align:center;margin:0 0 10px;font-size:13px">Đầu kỳ ${sum('beg')} người · vào làm ${sum('hire')} · nghỉ việc ${sum('left')} · cuối kỳ ${sum('end')} · tỷ lệ nghỉ việc ${rate.toFixed(1).replace('.', ',')}%</p>
        <b>1. Nhân sự theo bộ phận</b>${tbl(H, [...rows.map(cells), ['TỔNG CỘNG', sum('beg'), sum('hire'), sum('left'), sum('end'), sum('lx'), sum('px'), sum('nv')]])}
        <b>2. Người vào làm trong tháng</b>${hires.length ? tbl(['Họ tên', 'Chức vụ', 'Bộ phận', 'Ngày vào'], hires.map((s) => [s.full_name, job(s), dept(s), fmtDate(s.joined_on)])) : '<p><i>Không có</i></p>'}
        <b>3. Người nghỉ việc trong tháng</b>${lefts.length ? tbl(['Họ tên', 'Chức vụ', 'Bộ phận', 'Ngày nghỉ'], lefts.map((s) => [s.full_name, job(s), dept(s), fmtDate(s.left_on)])) : '<p><i>Không có</i></p>'}
        <table style="width:100%;margin-top:18px;text-align:center"><tr><td><b>NGƯỜI LẬP</b><br><i style="font-size:12px">(Ký, ghi rõ họ tên)</i></td><td><b>GIÁM ĐỐC</b><br><i style="font-size:12px">(Ký, đóng dấu)</i></td></tr></table>`;
      setView([{ html, land: false }]);
    } catch (e) { toast('error', errMsg(e)); }
  }
  const xlsx = () => downloadXlsx(`Bao cao nhan su ${k}`, `Nhân sự ${k}`, H, [...rows.map(cells), ['TỔNG CỘNG', sum('beg'), sum('hire'), sum('left'), sum('end'), sum('lx'), sum('px'), sum('nv')]], [24, 9, 9, 9, 9, 9, 9, 10]);
  return (
    <div className="nsx-rep">
      <div className="nsx-org-bar">
        <select className="nsx-search" value={k} onChange={(e) => setK(e.target.value)} aria-label="Tháng báo cáo">{ms.map((m) => <option key={m} value={m}>{mName(m)}</option>)}</select>
        <button type="button" className="btn small" onClick={() => void print()}>🖨 In báo cáo A4</button>
        <button type="button" className="btn small" onClick={xlsx}>⬇ Xuất Excel</button>
      </div>
      <div className="nsx-kpis">
        {([['Đầu kỳ', sum('beg')], ['Vào làm', sum('hire')], ['Nghỉ việc', sum('left')], ['Cuối kỳ', sum('end')], ['Tỷ lệ nghỉ việc', `${rate.toFixed(1).replace('.', ',')}%`]] as [string, number | string][])
          .map(([l, v]) => <div key={l} className="nsx-kpi"><small>{l}</small><b>{v}</b></div>)}
      </div>
      <div className="nsx-tblw">
        <table className="nsx-tbl">
          <thead><tr>{H.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.d}>{cells(r).map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
          <tfoot><tr><td><b>Tổng cộng</b></td>{(['beg', 'hire', 'left', 'end', 'lx', 'px', 'nv'] as const).map((f) => <td key={f}><b>{sum(f)}</b></td>)}</tr></tfoot>
        </table>
      </div>
      <div className="nsx-twocol">
        <section><h3>Vào làm trong tháng ({hires.length})</h3>{hires.length ? <div className="nsx-list">{hires.map((s) => <div key={s.id} className="nsx-li"><Who s={s} avas={avas} size={32} sub={`${dept(s)} · ${fmtDate(s.joined_on)}`} /></div>)}</div> : <p className="muted">Không có</p>}</section>
        <section><h3>Nghỉ việc trong tháng ({lefts.length})</h3>{lefts.length ? <div className="nsx-list">{lefts.map((s) => <div key={s.id} className="nsx-li"><Who s={s} avas={avas} size={32} sub={`${dept(s)} · ${fmtDate(s.left_on)}`} /></div>)}</div> : <p className="muted">Không có</p>}</section>
      </div>
      {view && <PaperView title={`Báo cáo nhân sự ${mName(k)}`} pages={view} onClose={() => setView(null)} />}
    </div>
  );
}
