// Lái xe & nhân viên: Tổng quan · Sơ đồ tổ chức · In thẻ nhân viên · Báo cáo nhân sự theo tháng.
// Chỉ đọc dữ liệu đang có (hồ sơ, giấy tờ); không thêm bảng. Tuổi, sinh nhật chỉ có với người được xem hồ sơ riêng.
import { letterhead, loadBrand, useBrand } from '../lib/brand';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, initials } from './StaffAvatar';
import { PaperView } from './ProfilePapers';
import { fmtDate, today, type Doc } from './Documents';
import { company, type Page } from '../lib/profilePapers';
import { toDataUrl } from '../lib/pdfMaker';
import { downloadXlsx } from '../lib/xlsxWrite';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Position = 'lai_xe' | 'phu_xe' | 'nhan_vien';
export interface OvStaff {
  id: string; user_id: string | null; full_name: string; position: Position; phone: string | null; joined_on: string; left_on: string | null;
  is_active: boolean; job_title: string | null; department: string | null; branch_id?: string | null;
}
export interface OvPriv { staff_id: string; birth_date: string | null; gender: 'nam' | 'nu' | null }
interface Common { staff: OvStaff[]; priv: OvPriv[]; avas: Record<string, string>; onOpen?: (id: string) => void }

const POS: Record<Position, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#ea580c', '#475569'];
const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
/** Bỏ trùng không phân biệt hoa / thường, giữ cách viết gặp trước */
const uniqF = (a: string[]) => { const m = new Map<string, string>(); for (const x of a) if (!m.has(fold(x))) m.set(fold(x), x); return [...m.values()]; };
const job = (s: OvStaff) => s.job_title?.trim() || POS[s.position];
/** Bộ phận; trống hoặc trùng tên nhóm ("Lái Xe" / "Lái xe") thì lấy tên nhóm để không tách 2 nhóm giống nhau */
const dept = (s: OvStaff) => { const d = s.department?.trim(); return !d || fold(d) === fold(POS[s.position]) ? POS[s.position] : d; };
/** Nối các phần chữ, bỏ ô trống và phần trùng (vd chức vụ "Lái Xe" với nhóm "Lái xe" chỉ hiện 1 lần) */
const joinU = (parts: (string | null | undefined)[], sep = ' · ') => {
  const seen = new Set<string>();
  return parts.map((x) => (x ?? '').trim()).filter((x) => { const k = fold(x); if (!x || seen.has(k)) return false; seen.add(k); return true; }).join(sep);
};
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
/** Vòng tròn % (khối đầu trang) */
function Ring({ pct, big, small }: { pct: number; big: string; small: string }) {
  const C = 2 * Math.PI * 50, p = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 120 120" className="nsx-ring" role="img" aria-label={`${big} ${small}`}>
      <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="11" />
      <circle cx="60" cy="60" r="50" fill="none" stroke="#fff" strokeWidth="11" strokeLinecap="round" strokeDasharray={`${(C * p) / 100} 400`} transform="rotate(-90 60 60)" />
      <text x="60" y="60" textAnchor="middle" className="nsx-ring-b">{big}</text>
      <text x="60" y="78" textAnchor="middle" className="nsx-ring-s">{small}</text>
    </svg>
  );
}
/** Đường số người theo tháng trên nền màu (khối đầu trang) */
function HeroLine({ labels, data }: { labels: string[]; data: number[] }) {
  const W = 440, H = 150, pl = 8, pr = 8, pt = 12, pb = 22, n = data.length;
  const mx = Math.max(1, ...data), mn = Math.min(...data), span = mx - mn || mx || 1;
  const x = (i: number) => pl + (i * (W - pl - pr)) / Math.max(1, n - 1);
  const y = (v: number) => pt + (H - pt - pb) * (1 - (((v - mn) / span) * 0.85 + 0.08));
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="nsx-chart" role="img" aria-label="Số người cuối mỗi tháng">
      <path d={`${line}L${x(n - 1)},${H - pb}L${x(0)},${H - pb}Z`} fill="rgba(255,255,255,.16)" />
      <path d={line} fill="none" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
      {data.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 ? 5 : 3} fill="#fff"><title>{`${labels[i]}: ${v} người`}</title></circle>)}
      {labels.map((l, i) => ((n - 1 - i) % 2 === 0 ? <text key={l + i} x={x(i)} y={H - 4} textAnchor="middle" className="nsx-hero-ax">{l}</text> : null))}
    </svg>
  );
}
function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const W = 240, H = 44, mx = Math.max(1, ...data);
  const pts = data.map((v, i) => `${((i * W) / (data.length - 1)).toFixed(1)},${(H - 4 - (v / mx) * (H - 10)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="nsx-spark" aria-hidden="true">
      <path d={`M${pts.join('L')}L${W},${H}L0,${H}Z`} fill={color} opacity=".14" />
      <path d={`M${pts.join('L')}`} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}
function Donut({ items, center }: { items: { label: string; value: number; color: string }[]; center: string }) {
  const tot = items.reduce((a, x) => a + x.value, 0);
  if (!tot) return <p className="muted">Chưa có số liệu</p>;
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="nsx-donut">
      <svg viewBox="0 0 200 200" role="img" aria-label={center}>
        {items.map((it) => { const len = (it.value / tot) * C; const el = (
          <circle key={it.label} cx="100" cy="100" r={R} fill="none" stroke={it.color} strokeWidth="26" strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 100 100)">
            <title>{`${it.label}: ${it.value} (${Math.round((it.value / tot) * 100)}%)`}</title></circle>); off += len; return el; })}
        <text x="100" y="94" textAnchor="middle" className="nsx-ax" style={{ fontSize: 12 }}>{center}</text>
        <text x="100" y="118" textAnchor="middle" className="nsx-donut-v">{tot}</text>
      </svg>
      <div className="nsx-dl">{items.map((it) => <div key={it.label}><i style={{ background: it.color }} />{it.label}<span>{it.value}</span><em>{Math.round((it.value / tot) * 100)}%</em></div>)}</div>
    </div>
  );
}

interface Ctr { staff_id: string; salary: number | null; start_on: string; end_on: string | null; kind: string }

export function StaffDashboard({ staff, priv, avas, onOpen, papers, warnDays, onAdd, branches = [] }: Common & { papers: Doc[]; warnDays: number; onAdd?: () => void; branches?: { id: string; label: string }[] }) {
  const td = today();
  // Thứ tự chức vụ lớn đến nhỏ như tab Hồ sơ (theo sơ đồ tổ chức đã chọn)
  const [orgCfg] = useOrgCfg();
  const rank = useMemo(() => rankOf(staff, orgCfg, branches), [staff, orgCfg, branches]);
  const byRank = (a: OvStaff, b: OvStaff) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6) || a.full_name.localeCompare(b.full_name, 'vi');
  const [ctrs, setCtrs] = useState<Ctr[]>([]);
  // Hợp đồng lao động đang hiệu lực (không có quyền xem thì database không trả → phần lương / hợp đồng tự ẩn)
  useEffect(() => {
    let live = true;
    void supabase.from('labor_contracts').select('staff_id, salary, start_on, end_on, kind').eq('status', 'hieu_luc').lte('start_on', td).order('start_on')
      .then(({ data }) => { if (live) setCtrs(((data ?? []) as Ctr[]).map((c) => ({ ...c, salary: c.salary == null ? null : Number(c.salary) }))); });
    return () => { live = false; };
  }, [td]);
  const act = staff.filter((s) => s.is_active);
  const ms = monthsBack(12);
  const hc = ms.map((k) => staff.filter((s) => workingAt(s, monthEnd(k))).length);
  const hire = ms.map((k) => staff.filter((s) => s.joined_on?.startsWith(k)).length);
  const left = ms.map((k) => staff.filter((s) => s.left_on?.startsWith(k)).length);
  const prevHc = hc[hc.length - 2] ?? 0;
  const delta = prevHc ? ((act.length - prevHc) / prevHc) * 100 : 0;
  const inDept = (s: OvStaff, d: string) => fold(dept(s)) === fold(d);
  const deptNames = uniqF(act.map(dept)).sort((a, b) => act.filter((s) => inDept(s, b)).length - act.filter((s) => inDept(s, a)).length);
  const dColor = (d: string) => COLORS[Math.max(0, deptNames.findIndex((x) => fold(x) === fold(d))) % COLORS.length]!;
  const byDept = deptNames.map((d) => ({ label: d, value: act.filter((s) => inDept(s, d)).length, color: dColor(d) }));
  const pv = new Map(priv.map((p) => [p.staff_id, p]));
  const ages = act.map((s) => pv.get(s.id)?.birth_date).filter((b): b is string => !!b).map((b) => years(b, td));
  const nam = act.filter((s) => pv.get(s.id)?.gender === 'nam').length, nu = act.filter((s) => pv.get(s.id)?.gender === 'nu').length;
  const ageB: [string, number, number][] = [['Dưới 30', 0, 29], ['30–39', 30, 39], ['40–49', 40, 49], ['50–54', 50, 54], ['Từ 55', 55, 200]];
  const tenure = act.length ? act.reduce((a, s) => a + Math.max(0, (Date.parse(td) - Date.parse(s.joined_on)) / (365.25 * 864e5)), 0) / act.length : 0;
  const month = td.slice(5, 7);
  const bd = act.filter((s) => pv.get(s.id)?.birth_date?.slice(5, 7) === month)
    .sort((a, b) => pv.get(a.id)!.birth_date!.slice(8).localeCompare(pv.get(b.id)!.birth_date!.slice(8)));
  const NEED: Record<Position, string[]> = { lai_xe: ['gplx', 'kham_suc_khoe', 'tap_huan', 'cccd'], phu_xe: ['cccd'], nhan_vien: ['cccd'] };
  const NAME: Record<string, string> = { gplx: 'GPLX', kham_suc_khoe: 'Khám sức khỏe', tap_huan: 'Tập huấn', cccd: 'CCCD' };
  const lim = new Date(Date.parse(td) + warnDays * 864e5).toISOString().slice(0, 10);
  const docOf = (s: OvStaff, t: string) => papers.find((x) => x.staff_id === s.id && x.doc_type === t && x.is_current);
  const exp = act.flatMap((s) => NEED[s.position].map((t) => ({ s, t, d: docOf(s, t) })))
    .filter((x) => x.d?.expires_on && x.d.expires_on <= lim).sort((a, b) => a.d!.expires_on!.localeCompare(b.d!.expires_on!));
  const full = act.filter((s) => NEED[s.position].every((t) => { const d = docOf(s, t); return d && (!d.expires_on || d.expires_on >= td); })).length;
  const latest = new Map<string, Ctr>();
  for (const c of ctrs) latest.set(c.staff_id, c);
  const fund = act.reduce((a, s) => a + (latest.get(s.id)?.salary ?? 0), 0);
  const ctLim = new Date(Date.parse(td) + 30 * 864e5).toISOString().slice(0, 10);
  const ctWarn = [...latest.values()].filter((c) => c.end_on && c.end_on <= ctLim && act.some((s) => s.id === c.staff_id)).sort((a, b) => a.end_on!.localeCompare(b.end_on!));
  const recent = [...act].sort((a, b) => b.joined_on.localeCompare(a.joined_on)).slice(0, 5);
  const byId = new Map(staff.map((s) => [s.id, s]));
  const short = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} tỷ` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} tr` : n.toLocaleString('vi-VN'));
  const h12 = hire.reduce((a, x) => a + x, 0), l12 = left.reduce((a, x) => a + x, 0), avgHc = hc.reduce((a, x) => a + x, 0) / hc.length || 1;
  if (!staff.length) return <section className="card"><p className="muted">Chưa có lái xe / nhân viên nào.</p></section>;
  return (
    <div className="nsx-dash">
      <div className="nsx-hero">
        <div>
          <div className="nsx-hero-k">NHÂN SỰ ĐANG LÀM VIỆC</div>
          <div className="nsx-hero-v">{act.length} <small>người</small></div>
          <div className="nsx-hero-sub"><span className={`nsx-pill ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1).replace('.', ',')}%</span>so với cuối tháng trước</div>
          <div className="nsx-hero-stats">
            {(nam + nu) > 0 && <div><b>{nam} / {nu}</b><span>Nam / Nữ</span></div>}
            {ages.length > 0 && <div><b>{(ages.reduce((a, x) => a + x, 0) / ages.length).toFixed(1).replace('.', ',')}</b><span>Tuổi bình quân</span></div>}
            <div><b>{tenure.toFixed(1).replace('.', ',')} năm</b><span>Thâm niên bình quân</span></div>
          </div>
          {onAdd && <div className="nsx-hero-act"><button type="button" className="nsx-hbtn" onClick={onAdd}>Thêm nhân viên</button></div>}
        </div>
        <div className="nsx-hero-chart"><div className="nsx-hero-ct"><span>Số người cuối mỗi tháng</span><span>12 tháng gần nhất</span></div><HeroLine labels={ms.map(mLabel)} data={hc} /></div>
        <div className="nsx-hero-ring"><Ring pct={act.length ? (full / act.length) * 100 : 0} big={`${act.length ? Math.round((full / act.length) * 100) : 0}%`} small="đủ giấy tờ" />
          <b>{full} người đủ giấy tờ</b><span>{act.length - full} người thiếu / hết hạn</span></div>
      </div>

      <section className="card nsx-team">
        <div className="nsx-card-h"><h3>Đội ngũ nhân sự</h3>
          <div className="nsx-legend">{deptNames.map((d) => <span key={d}><i style={{ background: dColor(d) }} />{d}</span>)}</div></div>
        <div className="nsx-wall">{[...act].sort(byRank).map((s) => (
          <button key={s.id} type="button" className="nsx-tw" style={{ ['--dc' as string]: dColor(dept(s)) }} title={`${s.full_name} · ${job(s)}`} onClick={() => onOpen?.(s.id)}>
            <Avatar name={s.full_name} url={avas[s.id]} size={84} /><small>{s.full_name.trim().split(/\s+/).slice(-2).join(' ')}</small></button>
        ))}</div>
      </section>

      <div className="nsx-kgrid">
        {fund > 0 && <div className="card nsx-kc" style={{ ['--c' as string]: 'var(--primary)' }}><div className="nsx-kc-h"><span>Quỹ lương tháng</span></div><b>{short(fund)} <small>đ</small></b><small className="muted">Theo hợp đồng lao động đang hiệu lực</small></div>}
        <div className="card nsx-kc" style={{ ['--c' as string]: '#16a34a' }}><div className="nsx-kc-h"><span>Tuyển mới</span><em className="nsx-pill up">+{hire[11]} tháng này</em></div><b>{h12} <small>người</small></b><small className="muted">12 tháng gần nhất</small><Spark data={hire} color="#16a34a" /></div>
        <div className="card nsx-kc" style={{ ['--c' as string]: '#dc2626' }}><div className="nsx-kc-h"><span>Nghỉ việc</span><em className={`nsx-pill ${(l12 / avgHc) * 100 > 10 ? 'down' : 'na'}`}>{((l12 / avgHc) * 100).toFixed(1).replace('.', ',')}%</em></div><b>{l12} <small>người</small></b><small className="muted">12 tháng · tỷ lệ trên số người bình quân</small><Spark data={left} color="#dc2626" /></div>
        <div className="card nsx-kc" style={{ ['--c' as string]: '#f59e0b' }}><div className="nsx-kc-h"><span>Giấy tờ cần xử lý</span><em className={`nsx-pill ${exp.length ? 'down' : 'up'}`}>{exp.length ? `${warnDays} ngày` : 'Ổn'}</em></div><b>{exp.length} <small>giấy</small></b><small className="muted">{exp.length ? 'Đã hết hạn hoặc sắp hết hạn' : 'Không có giấy sắp hết hạn'}</small></div>
      </div>

      <div className="nsx-g2">
        <section className="card"><div className="nsx-card-h"><h3>Biến động nhân sự 12 tháng</h3>
          <div className="nsx-legend"><span><i style={{ background: '#16a34a' }} />Tuyển mới</span><span><i style={{ background: '#dc2626' }} />Nghỉ việc</span></div></div>
          <Bars labels={ms.map(mLabel)} series={[{ name: 'Tuyển mới', color: '#16a34a', data: hire }, { name: 'Nghỉ việc', color: '#dc2626', data: left }]} height={190} />
          <div className="nsx-msum">{ms.slice(-4).map((k, i) => <div key={k}><small>{mName(k)}</small><b>{hc[8 + i]}</b> <span className="muted small">người</span></div>)}</div></section>
        <section className="card"><div className="nsx-card-h"><h3>Cơ cấu theo bộ phận</h3></div><Donut items={byDept} center="Nhân sự" /></section>
      </div>

      <div className="nsx-g3">
        {priv.length > 0 && <section className="card"><div className="nsx-card-h"><h3>🎂 Sinh nhật tháng {Number(month)}</h3>{bd.length > 0 && <span className="nsx-cnt">{bd.length}</span>}</div>
          {bd.length === 0 ? <p className="muted">Tháng này không có ai sinh nhật</p> : (
            <div className="nsx-list">{bd.map((s) => { const b = pv.get(s.id)!.birth_date!; const dd = b.slice(8);
              return <div key={s.id} className="nsx-li"><Who s={s} avas={avas} onOpen={onOpen} size={40} sub={`${joinU([s.department, job(s)])} · tròn ${years(b, `${td.slice(0, 4)}-12-31`)} tuổi`} />
                <span className={`badge${dd === td.slice(8) ? '' : ' warn-badge'}`}>{dd === td.slice(8) ? 'Hôm nay' : `${dd}/${month}`}</span></div>; })}</div>
          )}</section>}
        <section className="card"><div className="nsx-card-h"><h3>Hợp đồng sắp hết hạn</h3></div>
          {ctWarn.length === 0 ? <p className="muted">Không có hợp đồng nào sắp hết hạn</p> : (
            <div className="nsx-list">{ctWarn.slice(0, 6).map((c) => { const s = byId.get(c.staff_id)!;
              return <div key={c.staff_id} className="nsx-li"><Who s={s} avas={avas} onOpen={onOpen} size={40} sub={`Hết hạn ${fmtDate(c.end_on)}`} />
                <span className={`badge ${c.end_on! < td ? 'locked' : 'warn-badge'}`}>{c.end_on! < td ? 'Đã hết hạn' : 'Sắp hết hạn'}</span></div>; })}</div>
          )}</section>
        <section className="card"><div className="nsx-card-h"><h3>Mới vào làm gần đây</h3></div>
          <div className="nsx-list">{recent.map((s) => <div key={s.id} className="nsx-li"><Who s={s} avas={avas} onOpen={onOpen} size={40} sub={joinU([job(s), s.department])} /><span className="muted small nsx-nw">{fmtDate(s.joined_on)}</span></div>)}</div></section>
      </div>

      <div className="nsx-g3">
        {ages.length > 0 && <section className="card"><div className="nsx-card-h"><h3>Độ tuổi</h3></div>
          <Bars labels={ageB.map((b) => b[0])} series={[{ name: 'Số người', color: 'var(--primary)', data: ageB.map(([, a, b]) => ages.filter((x) => x >= a && x <= b).length) }]} height={190} /></section>}
        {(nam + nu) > 0 && <section className="card"><div className="nsx-card-h"><h3>Giới tính</h3></div><Donut items={[{ label: 'Nam', value: nam, color: 'var(--primary)' }, { label: 'Nữ', value: nu, color: '#db2777' }]} center="Nhân sự" /></section>}
        <section className="card"><div className="nsx-card-h"><h3>Giấy tờ đã / sắp hết hạn</h3>{exp.length > 0 && <span className="nsx-cnt">{exp.length}</span>}</div>
          {exp.length === 0 ? <p className="muted">Không có giấy nào hết hạn trong {warnDays} ngày tới.</p> : (
            <div className="nsx-list">{exp.slice(0, 8).map((x) => (
              <div key={x.s.id + x.t} className="nsx-li"><Who s={x.s} avas={avas} onOpen={onOpen} size={36} sub={`${NAME[x.t]} · ${fmtDate(x.d!.expires_on)}`} />
                <span className={`badge ${x.d!.expires_on! < td ? 'locked' : 'warn-badge'}`}>{x.d!.expires_on! < td ? 'Đã hết hạn' : 'Sắp hết hạn'}</span></div>
            ))}{exp.length > 8 && <p className="muted small">… và {exp.length - 8} giấy khác</p>}</div>
          )}</section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Sơ đồ tổ chức */

/** Cấu hình sơ đồ tổ chức của nhà xe (Cấu hình 'nhan_su.so_do'). Thiếu ô nào thì tự động theo chức vụ. */
export type OrgGroup = 'bophan' | 'chucvu' | 'nhom' | 'chinhanh';
export interface OrgCfg { group?: OrgGroup; top?: string[] | null; order?: string[]; heads?: Record<string, string[]>; colors?: Record<string, string> }
const GROUP_NAME: Record<OrgGroup, string> = { bophan: 'Bộ phận', chucvu: 'Chức vụ', nhom: 'Nhóm (lái xe / phụ xe / nhân viên)', chinhanh: 'Chi nhánh' };
const SWATCH = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#ea580c', '#475569', '#0f766e', '#b91c1c'];

function orgOf(staff: OvStaff[], cfg: OrgCfg, branches: { id: string; label: string }[]) {
  const act = staff.filter((s) => s.is_active);
  const g = cfg.group ?? 'bophan';
  const raw = (s: OvStaff) => g === 'chucvu' ? job(s) : g === 'nhom' ? POS[s.position]
    : g === 'chinhanh' ? (branches.find((b) => b.id === s.branch_id)?.label ?? 'Chưa có chi nhánh') : dept(s);
  // gộp cách viết khác hoa / thường ("Lái Xe" / "Lái xe") thành 1 nhóm, lấy cách viết gặp trước
  const canon = new Map<string, string>();
  for (const s of act) { const v = raw(s).trim().replace(/\s+/g, ' '); if (!canon.has(fold(v))) canon.set(fold(v), v); }
  const keyOf = (s: OvStaff) => canon.get(fold(raw(s).trim().replace(/\s+/g, ' '))) ?? raw(s);
  const byId = new Map(act.map((s) => [s.id, s]));
  const bosses = cfg.top
    ? cfg.top.map((id) => byId.get(id)).filter((x): x is OvStaff => !!x)
    : act.filter(isBoss).sort((a, b) => Number(fold(job(a)).includes('pho')) - Number(fold(job(b)).includes('pho')) || a.full_name.localeCompare(b.full_name, 'vi'));
  const top = new Set(bosses.map((s) => s.id));
  const m = new Map<string, OvStaff[]>();
  for (const s of act.filter((x) => !top.has(x.id))) m.set(keyOf(s), [...(m.get(keyOf(s)) ?? []), s]);
  const order = cfg.order ?? [];
  const names = [...m.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return m.get(b)!.length - m.get(a)!.length || a.localeCompare(b, 'vi');
  });
  const depts = names.map((name, i) => {
    const list = m.get(name)!;
    const chosen = cfg.heads?.[name];
    const heads = chosen ? chosen.map((id) => list.find((s) => s.id === id)).filter((x): x is OvStaff => !!x) : list.filter(isHead);
    const hs = new Set(heads.map((h) => h.id));
    return { name, color: cfg.colors?.[name] ?? COLORS[i % COLORS.length]!, heads, rest: list.filter((s) => !hs.has(s.id)).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')), n: list.length, all: list };
  });
  return { bosses, depts, total: act.length };
}

/** Cấu hình sơ đồ tổ chức đã áp dụng (dùng chung: Sơ đồ tổ chức + thứ tự danh sách Hồ sơ) */
export function useOrgCfg(): [OrgCfg, (c: OrgCfg) => void] {
  const [cfg, setCfg] = useState<OrgCfg>({});
  useEffect(() => {
    let live = true;
    const load = () => void supabase.from('tenant_settings').select('value').eq('key', 'nhan_su.so_do').maybeSingle()
      .then(({ data }) => { const v = data?.value; if (live) setCfg(v && typeof v === 'object' && !Array.isArray(v) ? (v as OrgCfg) : {}); });
    load();
    window.addEventListener('tms-so-do', load);
    return () => { live = false; window.removeEventListener('tms-so-do', load); };
  }, []);
  return [cfg, setCfg];
}
/** Thứ tự chức vụ từ lớn đến nhỏ theo sơ đồ tổ chức: hàng lãnh đạo → trưởng từng nhóm → thành viên (nhóm theo thứ tự trên sơ đồ).
 *  Người đã nghỉ xếp sau cùng. Đổi thứ tự bằng "Chọn kiểu sơ đồ" ở tab Sơ đồ tổ chức. */
export function rankOf(staff: OvStaff[], cfg: OrgCfg, branches: { id: string; label: string }[]): Map<string, number> {
  const o = orgOf(staff, cfg, branches);
  const r = new Map<string, number>();
  let i = 0;
  for (const s of o.bosses) r.set(s.id, i++);
  for (const d of o.depts) for (const s of d.heads) r.set(s.id, i++);
  for (const d of o.depts) for (const s of d.rest) r.set(s.id, i++);
  return r;
}

/** Chọn kiểu sơ đồ: chia nhóm theo gì, ai ở hàng trên cùng, thứ tự / màu / trưởng từng nhóm → Áp dụng (lưu cho cả nhà xe) */
function OrgConfig({ staff, cfg, setCfg, branches, onApply, onReset, onCancel, busy }: {
  staff: OvStaff[]; cfg: OrgCfg; setCfg: (c: OrgCfg) => void; branches: { id: string; label: string }[];
  onApply: () => void; onReset: () => void; onCancel: () => void; busy: boolean;
}) {
  const o = orgOf(staff, cfg, branches);
  const act = staff.filter((s) => s.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi'));
  const top = new Set(o.bosses.map((s) => s.id));
  const names = o.depts.map((d) => d.name);
  const move = (i: number, d: -1 | 1) => { const n = [...names]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setCfg({ ...cfg, order: n }); };
  return (
    <div className="nsx-ocfg">
      <div className="nsx-ocfg-row"><b>Chia nhóm theo</b>
        <div className="nsx-seg" role="group" aria-label="Chia nhóm theo">
          {(Object.keys(GROUP_NAME) as OrgGroup[]).map((k) => (
            <button key={k} type="button" className={(cfg.group ?? 'bophan') === k ? 'on' : ''} aria-pressed={(cfg.group ?? 'bophan') === k}
                    onClick={() => setCfg({ ...cfg, group: k, order: [], heads: {}, colors: {} })}>{GROUP_NAME[k]}</button>
          ))}
        </div>
      </div>
      <div className="nsx-ocfg-row"><b>Hàng trên cùng (Ban lãnh đạo)</b>
        <div className="nsx-pick">{act.map((s) => (
          <label key={s.id} className={`nsx-tp${top.has(s.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={top.has(s.id)} onChange={(e) => {
              const cur = o.bosses.map((x) => x.id);
              setCfg({ ...cfg, top: e.target.checked ? [...cur, s.id] : cur.filter((id) => id !== s.id) });
            }} />
            <span>{s.full_name}</span><small className="muted">{job(s)}</small>
          </label>
        ))}</div>
      </div>
      <div className="nsx-ocfg-row"><b>Các nhóm</b>
        <div className="nsx-ocfg-groups">
          {o.depts.map((d, i) => (
            <div key={d.name} className="nsx-ocfg-g" style={{ borderLeftColor: d.color }}>
              <div className="nsx-ocfg-gh">
                <b>{d.name}</b><small className="muted">{d.n} người</small>
                <span className="nsx-ocfg-mv">
                  <button type="button" className="btn small" aria-label={`Đưa ${d.name} sang trái`} disabled={i === 0} onClick={() => move(i, -1)}>←</button>
                  <button type="button" className="btn small" aria-label={`Đưa ${d.name} sang phải`} disabled={i === o.depts.length - 1} onClick={() => move(i, 1)}>→</button>
                </span>
              </div>
              <div className="nsx-swatch" role="group" aria-label={`Màu ${d.name}`}>
                {SWATCH.map((c) => <button key={c} type="button" className={d.color === c ? 'on' : ''} style={{ background: c }} aria-label={`Màu ${c}`}
                                           onClick={() => setCfg({ ...cfg, order: names, colors: { ...(cfg.colors ?? {}), [d.name]: c } })} />)}
              </div>
              <label>Trưởng nhóm
                <select value={d.heads[0]?.id ?? ''} aria-label={`Trưởng nhóm ${d.name}`}
                        onChange={(e) => setCfg({ ...cfg, order: names, heads: { ...(cfg.heads ?? {}), [d.name]: e.target.value ? [e.target.value] : [] } })}>
                  <option value="">— Không có —</option>
                  {d.all.map((s) => <option key={s.id} value={s.id}>{s.full_name} · {job(s)}</option>)}
                </select>
              </label>
            </div>
          ))}
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy} onClick={onApply}>{busy ? 'Đang lưu…' : 'Áp dụng'}</button>
        <button type="button" className="btn" disabled={busy} onClick={onReset}>Về tự động</button>
        <button type="button" className="btn link" onClick={onCancel}>Hủy</button>
      </div>
    </div>
  );
}

export function StaffOrg({ staff, avas, onOpen, branches = [], canConfig }: Common & { branches?: { id: string; label: string }[]; canConfig?: boolean }) {
  const toast = useToast();
  const [saved, setSaved] = useOrgCfg();
  const [draft, setDraft] = useState<OrgCfg | null>(null);   // đang chọn kiểu (chưa áp dụng): sơ đồ bên dưới xem trước ngay
  const [busy, setBusy] = useState(false);
  const cfg = draft ?? saved;
  const o = useMemo(() => orgOf(staff, cfg, branches), [staff, cfg, branches]);
  async function apply(next: OrgCfg) {
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([{ key: 'nhan_su.so_do', value: next }], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    setSaved(next); setDraft(null);
    window.dispatchEvent(new Event('tms-so-do'));
    toast('ok', 'Đã áp dụng sơ đồ tổ chức');
  }
  const [view, setView] = useState<Page[] | null>(null);
  async function print() {
    try {
      // Bản in như mẫu: hàng lãnh đạo (thẻ đầu nền xanh đậm), các cột bộ phận có viền màu, trưởng bộ phận ở đầu cột, nhân viên bên dưới
      const b = await loadBrand();
      const ava = (s: OvStaff, px: number, ring = '#fff') => avas[s.id]
        ? `<img src="${avas[s.id]}" alt="" style="width:${px}px;height:${px}px;border-radius:50%;object-fit:cover;object-position:50% 22%;border:2px solid ${ring};display:block;margin:0 auto">`
        : `<div style="width:${px}px;height:${px}px;border-radius:50%;border:2px solid ${ring};background:#e2e8f0;color:#334155;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(px / 2.8)}px;margin:0 auto">${esc(initials(s.full_name))}</div>`;
      const boss = (s: OvStaff, i: number) => i === 0
        ? `<div style="display:inline-block;vertical-align:top;margin:0 8px;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#1e3a8a,#3b5bdb);color:#fff;text-align:center;min-width:150px">${ava(s, 64)}<div style="font-weight:700;font-size:13px;margin-top:6px">${esc(s.full_name)}</div><div style="font-size:11px;opacity:.85">${esc(job(s))}</div></div>`
        : `<div style="display:inline-block;vertical-align:top;margin:0 8px;padding:12px 28px;border-radius:12px;background:#fff;border:1px solid #e5e7eb;box-shadow:0 2px 8px rgba(15,23,42,.08);text-align:center;min-width:130px">${ava(s, 52, '#e5e7eb')}<div style="font-weight:700;font-size:12.5px;margin-top:6px;color:#0f172a">${esc(s.full_name)}</div><div style="font-size:11px;color:#475569">${esc(job(s))}</div></div>`;
      const n = o.depts.length, land = n > 5, per = Math.min(n, land ? 7 : 5) || 1;
      const col = (d: (typeof o.depts)[number]) => {
        const h = d.heads[0];
        const tint = /^#[0-9a-f]{6}$/i.test(d.color) ? `${d.color}14` : '#f8fafc';
        const row = (s: OvStaff) => `<div style="display:flex;gap:6px;align-items:center;padding:6px 6px;border-top:1px solid #eef0f3">
          <div style="flex:none">${ava(s, 26, '#e5e7eb')}</div><div style="min-width:0;line-height:1.2"><div style="font-weight:700;font-size:10.5px;color:#0f172a">${esc(s.full_name)}</div><div style="font-size:9px;color:#64748b">${esc(job(s))}</div></div></div>`;
        return `<div style="display:inline-block;vertical-align:top;width:calc(${100 / per}% - 8px);margin:0 4px 8px;border:1px solid #e5e7eb;border-top:3px solid ${d.color};border-radius:8px;background:#fff;overflow:hidden;break-inside:avoid;page-break-inside:avoid">
          <div style="background:${tint};text-align:center;padding:6px 4px 8px">
            <div style="font-weight:700;font-size:11.5px;color:${d.color}">${esc(d.name)}</div><div style="font-size:9.5px;color:#64748b;margin-bottom:5px">${d.n} người</div>
            ${h ? `${ava(h, 46, d.color)}<div style="font-weight:700;font-size:11px;margin-top:4px;color:#0f172a">${esc(h.full_name)}</div><div style="font-size:9.5px;color:#64748b">${esc(job(h))}</div>` : ''}
          </div>${[...d.heads.slice(1), ...d.rest].map(row).join('')}</div>`;
      };
      const html = `<div style="-webkit-print-color-adjust:exact;print-color-adjust:exact">${letterhead(b)}
        <h2 style="text-align:center;margin:10px 0 14px;font-size:18px;color:#1e293b">SƠ ĐỒ TỔ CHỨC ${esc(b.name.toUpperCase())}</h2>
        <div style="text-align:center;margin-bottom:16px">${o.bosses.map(boss).join('')}</div>
        <div style="text-align:center;font-size:0">${o.depts.map((d) => `<span style="font-size:12px;text-align:left">${col(d)}</span>`).join('')}</div></div>`;
      setView([{ html, land }]);
    } catch (e) { toast('error', errMsg(e)); }
  }
  return (
    <div className="nsx-org">
      <div className="nsx-org-bar"><span className="muted">{o.total} người · {o.depts.length} nhóm</span>
        {canConfig && !draft && <button type="button" className="btn small" onClick={() => setDraft({ ...saved })}>⚙ Chọn kiểu sơ đồ</button>}
        <button type="button" className="btn small" onClick={() => void print()}>🖨 In sơ đồ</button></div>
      {draft && <OrgConfig staff={staff} cfg={draft} setCfg={setDraft} branches={branches} busy={busy}
                           onApply={() => void apply(draft)} onReset={() => void apply({})} onCancel={() => setDraft(null)} />}
      <div className="nsx-org-scroll">
        <div className="nsx-tree" style={{ ['--n' as string]: Math.max(1, o.depts.length) }}>
          <div className="nsx-tree-top">
            {o.bosses.length ? o.bosses.map((s, i) => (
              <button key={s.id} type="button" className={`nsx-node${i === 0 ? ' ceo' : ''}`} onClick={() => onOpen?.(s.id)}>
                <Avatar name={s.full_name} url={avas[s.id]} size={i === 0 ? 80 : 62} /><b>{s.full_name}</b><small>{job(s)}</small>
              </button>
            )) : <span className="muted">Chưa có hàng lãnh đạo</span>}
          </div>
          {o.depts.length > 0 && <div className="nsx-vline" />}
          <div className="nsx-tree-depts">
            {o.depts.map((d) => (
              <div key={d.name} className="nsx-dwrap">
                <div className="nsx-dcol2" style={{ ['--dc' as string]: d.color }}>
                  <div className="nsx-dhd">
                    <div className="nsx-dn">{d.name}</div><small className="muted">{d.n} người</small>
                    {d.heads.map((h) => (
                      <button key={h.id} type="button" className="nsx-dhead2" onClick={() => onOpen?.(h.id)}>
                        <Avatar name={h.full_name} url={avas[h.id]} size={56} /><b>{h.full_name}</b><small>{job(h)}</small>
                      </button>
                    ))}
                  </div>
                  {d.rest.map((m) => (
                    <button key={m.id} type="button" className="nsx-mem2" onClick={() => onOpen?.(m.id)}>
                      <Avatar name={m.full_name} url={avas[m.id]} size={30} /><span><b>{m.full_name}</b><small>{job(m)}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {view && <PaperView title="Sơ đồ tổ chức" pages={view} onClose={() => setView(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ In thẻ nhân viên (85,6 x 54 mm) */

interface CardColorCfg { mode: 'mac_dinh' | 'chuc_vu' | 'moi_nguoi'; jobs: Record<string, string>; seed: number }
const CARD_KEY = 'tms.the_nv_mau';
const CARD_DEF: CardColorCfg = { mode: 'mac_dinh', jobs: {}, seed: 0 };
/** Màu đủ đậm cho chữ trắng trên dải màu */
const CARD_PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#b45309', '#0d9488', '#be123c', '#4f46e5', '#15803d', '#475569'];

export function StaffCards({ staff, avas, branches = [] }: Common & { branches?: { id: string; label: string }[] }) {
  const toast = useToast();
  const [orgCfg] = useOrgCfg();
  const rank = useMemo(() => rankOf(staff, orgCfg, branches), [staff, orgCfg, branches]);
  // xếp theo chức vụ lớn đến nhỏ như tab Hồ sơ
  const act = useMemo(() => staff.filter((s) => s.is_active)
    .sort((a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6) || a.full_name.localeCompare(b.full_name, 'vi')), [staff, rank]);
  const depts = uniqF(act.map(dept)).sort((a, b) => a.localeCompare(b, 'vi'));
  const [d, setD] = useState('');
  const list = act.filter((s) => !d || fold(dept(s)) === fold(d));
  // mở tab là chọn sẵn tất cả (như file mẫu), bên dưới hiện ngay các thẻ
  const [picked, setSel] = useState<Set<string> | null>(null);
  const sel = picked ?? new Set(act.map((s) => s.id));
  const [co, setCo] = useState('');
  const logo = useBrand()?.logo ?? null;   // logo công ty (Thông tin công ty) thay biểu tượng xe trên dải màu
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<Page[] | null>(null);
  useEffect(() => { void company().then((c) => setCo(c.name)).catch(() => undefined); }, []);
  const chosen = list.filter((s) => sel.has(s.id));
  // Màu thẻ: mặc định (theo loại: lái xe xanh lá, phụ xe cam, còn lại xanh dương) · theo chức vụ (tự chọn màu từng chức vụ) · mỗi người 1 màu.
  // Lưu trên máy này để lần sau mở lại vẫn giữ.
  const [mau, setMau] = useState<CardColorCfg>(() => { try { return { ...CARD_DEF, ...JSON.parse(localStorage.getItem(CARD_KEY) ?? '{}') } as CardColorCfg; } catch { return CARD_DEF; } });
  const saveMau = (v: CardColorCfg) => { setMau(v); try { localStorage.setItem(CARD_KEY, JSON.stringify(v)); } catch { /* bỏ qua */ } };
  const jobs = uniqF(act.map(job)).sort((a, b) => a.localeCompare(b, 'vi'));
  const defColor = (s: OvStaff) => (s.position === 'lai_xe' ? '#16a34a' : s.position === 'phu_xe' ? '#f59e0b' : '#2563eb');
  const jobColor = (j: string, i: number) => mau.jobs[fold(j)] ?? CARD_PALETTE[i % CARD_PALETTE.length]!;
  const color = (s: OvStaff) => {
    if (mau.mode === 'chuc_vu') return jobColor(job(s), Math.max(0, jobs.findIndex((j) => fold(j) === fold(job(s)))));
    if (mau.mode === 'moi_nguoi') return CARD_PALETTE[(act.findIndex((x) => x.id === s.id) + mau.seed) % CARD_PALETTE.length]!;
    return defColor(s);
  };
  /** Màu đậm hơn (dải trái của thẻ) */
  const shade = (hex: string, k: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;
  /** Tên công ty 2 dòng: loại hình (CÔNG TY TNHH MỘT THÀNH VIÊN…) rồi xuống dòng tên riêng */
  const coLines = (() => {
    const u = co.toUpperCase().replace(/\s+/g, ' ').trim();
    const m = /^(CÔNG TY (?:TNHH|TRÁCH NHIỆM HỮU HẠN|CỔ PHẦN|CP|HỢP DANH)(?: (?:MỘT|1) THÀNH VIÊN| HAI THÀNH VIÊN(?: TRỞ LÊN)?)?|HỢP TÁC XÃ|DOANH NGHIỆP TƯ NHÂN|HỘ KINH DOANH)\s+(.+)$/.exec(u);
    return m ? [m[1]!, m[2]!] : [u];
  })();
  /** Họ tên luôn 1 dòng: tên dài thì chữ nhỏ lại */
  const nameSize = (n: string) => Math.max(8, Math.min(12.5, (12.5 * 17) / Math.max(1, n.trim().length)));
  const card = (s: OvStaff, photo: string | null) => {
    const c = color(s);
    return `<div style="width:85.6mm;height:54mm;border-radius:3.2mm;overflow:hidden;display:flex;background:#fff;border:1px solid #d9dfeb;box-shadow:0 6px 20px rgba(16,24,40,.12);font-family:'Segoe UI',Tahoma,Roboto,'Helvetica Neue',Arial,sans-serif;color:#1b2333;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact">
    <div style="flex:0 0 31mm;width:31mm;background:radial-gradient(circle at 20% 0,rgba(255,255,255,.25),transparent 55%),linear-gradient(165deg,${shade(c, 0.45)},${c});display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.8mm;color:#fff;padding:2.5mm 2mm">
      ${photo ? `<img src="${photo}" alt="" style="width:20mm;height:25mm;border-radius:2.5mm;object-fit:cover;object-position:50% 0;border:0.8mm solid #fff;background:#fff">`
        : `<div style="width:20mm;height:25mm;border-radius:2.5mm;border:0.8mm solid #fff;display:flex;align-items:center;justify-content:center;font-size:9mm;font-weight:bold">${esc(s.full_name.trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase())}</div>`}
      ${s.position === 'nhan_vien' || fold(job(s)) === fold(POS[s.position]) ? '' : `<div style="font-weight:bold;font-size:7.5pt;letter-spacing:.5px;background:rgba(255,255,255,.2);border-radius:10px;padding:.3mm 3mm">${esc(POS[s.position])}</div>`}</div>
    <div style="position:relative;flex:1 1 auto;min-width:0;padding:3.4mm 4mm 3mm;display:flex;flex-direction:column;overflow:hidden;background:radial-gradient(circle at 100% 0,${c}22,#fff 55%)">
      ${logo ? `<img src="${logo}" alt="" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34mm;max-height:40mm;object-fit:contain;opacity:.09;pointer-events:none">` : ''}
      <div style="font-size:5.6pt;font-weight:700;color:#6b7488;letter-spacing:.2px;line-height:1.3">${coLines.map((l) => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l)}</div>`).join('')}</div>
      <div style="font-size:7pt;font-weight:700;color:${c};letter-spacing:1.2px;margin-top:1.6mm">THẺ NHÂN VIÊN</div>
      <div style="font-size:${nameSize(s.full_name).toFixed(1)}pt;font-weight:700;line-height:1.15;margin-top:2mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.full_name.trim())}</div>
      ${s.department?.trim() && fold(s.department) !== fold(job(s)) ? `<div style="font-size:7.5pt;color:${c};font-weight:bold;margin-top:1.2mm">${esc(s.department.trim())}</div>` : ''}
      <div style="font-size:7.5pt;font-weight:600;margin-top:.6mm;line-height:1.25">${esc(job(s))}</div>
      <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;gap:2mm">
        <div style="font-size:7.5pt;font-weight:bold"><div style="font-size:5.5pt;color:#6b7488;font-weight:500">Ngày vào làm</div>${fmtDate(s.joined_on)}</div>
        <div style="width:21mm;height:7mm;background:repeating-linear-gradient(90deg,#1b2333 0 .35mm,transparent .35mm .7mm,#1b2333 .7mm 1.3mm,transparent 1.3mm 1.6mm,#1b2333 1.6mm 1.85mm,transparent 1.85mm 2.5mm)"></div>
      </div></div></div>`;
  };
  async function print() {
    setBusy(true);
    try {
      const photos = await Promise.all(chosen.map((s) => toDataUrl(avas[s.id] ?? null)));
      const cards = chosen.map((s, i) => card(s, photos[i] ?? null));
      const pages: Page[] = [];
      for (let i = 0; i < cards.length; i += 8) pages.push({ land: false, html: `<div class="nsx-cardsheet" style="display:grid;grid-template-columns:repeat(2,85.6mm);gap:6mm 8mm;justify-content:center">${cards.slice(i, i + 8).join('')}</div>` });
      setView(pages);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="nsx-cards">
      <div className="nsx-org-bar">
        <select className="nsx-search" value={d} onChange={(e) => setD(e.target.value)} aria-label="Lọc bộ phận"><option value="">Tất cả bộ phận</option>{depts.map((x) => <option key={x}>{x}</option>)}</select>
        <button type="button" className="btn small" onClick={() => setSel(new Set([...sel, ...list.map((s) => s.id)]))}>Chọn tất cả</button>
        <button type="button" className="btn small" onClick={() => setSel(new Set())}>Bỏ chọn</button>
        <select className="nsx-search" aria-label="Màu thẻ" value={mau.mode} onChange={(e) => saveMau({ ...mau, mode: e.target.value as CardColorCfg['mode'] })}>
          <option value="mac_dinh">Màu mặc định</option><option value="chuc_vu">Màu theo chức vụ</option><option value="moi_nguoi">Mỗi người 1 màu</option>
        </select>
        {mau.mode === 'moi_nguoi' && <button type="button" className="btn small" onClick={() => saveMau({ ...mau, seed: (mau.seed + 1 + Math.floor(Math.random() * (CARD_PALETTE.length - 1))) % CARD_PALETTE.length })}>Đổi màu</button>}
        {mau.mode !== 'mac_dinh' && <button type="button" className="btn small" onClick={() => saveMau(CARD_DEF)}>Về mặc định</button>}
        <button type="button" className="btn small primary" disabled={!chosen.length || busy} onClick={() => void print()}>{busy ? 'Đang chuẩn bị…' : `🖨 In ${chosen.length} thẻ`}</button>
      </div>
      {mau.mode === 'chuc_vu' && <div className="nsx-pick">{jobs.map((j, i) => (
        <label key={j} className="nsx-tp on"><input type="color" aria-label={`Màu ${j}`} value={jobColor(j, i)}
          onChange={(e) => saveMau({ ...mau, jobs: { ...mau.jobs, [fold(j)]: e.target.value } })} /><span>{j}</span></label>
      ))}</div>}
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
  const depts = uniqF(staff.filter((s) => workingAt(s, last) || workingAt(s, before) || s.joined_on?.startsWith(k) || s.left_on?.startsWith(k)).map(dept)).sort((a, b) => a.localeCompare(b, 'vi'));
  const rows = depts.map((d) => {
    const inD = staff.filter((s) => fold(dept(s)) === fold(d));
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
      const TH = 'border:1px solid #333;padding:5px;font-size:12.5px;background:#e2e8f0';
      const TD = 'border:1px solid #333;padding:5px;font-size:12.5px';
      const tbl = (h: string[], rs: (string | number)[][]) => `<table style="width:100%;border-collapse:collapse;margin:4px 0 10px"><tr>${h.map((x) => `<th style="${TH}">${x}</th>`).join('')}</tr>${rs.map((r) => `<tr>${r.map((c, i) => `<td style="${TD};text-align:${i ? 'center' : 'left'}">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
      const html = `${letterhead(await loadBrand())}<h2 style="text-align:center;margin:14px 0 2px">BÁO CÁO TÌNH HÌNH NHÂN SỰ ${mName(k).toUpperCase()}</h2>
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
