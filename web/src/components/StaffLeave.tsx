// Nghỉ phép (theo file mẫu "Quản lý nhân sự"): thẻ chỉ số, phép năm còn lại từng người, bảng đơn nghỉ có Duyệt / Từ chối ngay trong bảng.
// Tự xin nghỉ cho mình ở hồ sơ của mình; quản lý (leave.add) ghi đơn cho người khác; leave.edit duyệt; leave.view_all xem tất cả.
// Phép năm: số ngày chuẩn (Cấu hình 'nghi_phep.ngay_phep_nam', mặc định 12) + 1 ngày mỗi 5 năm làm việc – BLLĐ 2019 Điều 113, 114 (cần xác minh từng trường hợp).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './StaffAvatar';
import { Modal } from './Modal';
import { fmtDate, today } from './Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { PaperView, type Me } from './ProfilePapers';
import { leaveHtml, loadLeaveCtx, type LeaveRow } from '../lib/leavePaper';
import { profileChanged } from '../lib/profileAutoArchive';
import { useToast } from '../lib/toast';

export type LeaveKind = 'phep_nam' | 'om' | 'viec_rieng' | 'khong_luong' | 'thai_san' | 'nghi_bu';
type LeaveStatus = 'cho_duyet' | 'da_duyet' | 'tu_choi' | 'da_huy';
export interface Leave {
  id: string; staff_id: string; kind: LeaveKind; from_on: string; to_on: string; days: number; reason: string | null;
  status: LeaveStatus; decide_note: string | null; created_by: string | null;
  decided_by: string | null; handover_staff_id: string | null; created_at: string;
}
export interface LvStaff { id: string; user_id: string | null; full_name: string; joined_on: string; is_active: boolean; job_title: string | null; position: string }
export interface LvPerms { add: boolean; edit: boolean; viewAll: boolean }

export const KIND: Record<LeaveKind, string> = {
  phep_nam: 'Phép năm', om: 'Nghỉ ốm', viec_rieng: 'Việc riêng có lương', khong_luong: 'Nghỉ không lương', thai_san: 'Nghỉ thai sản', nghi_bu: 'Nghỉ bù',
};
const STATUS: Record<LeaveStatus, [string, string]> = {
  cho_duyet: ['Chờ duyệt', 'warn-badge'], da_duyet: ['Đã duyệt', ''], tu_choi: ['Từ chối', 'locked'], da_huy: ['Đã hủy', 'locked'],
};
const COLS = 'id, staff_id, kind, from_on, to_on, days, reason, status, decide_note, created_by, decided_by, handover_staff_id, created_at';
const num = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
/** Số ngày nghỉ: bỏ Chủ nhật */
export function workDays(a: string, b: string): number {
  if (!a || !b || b < a) return 0;
  let n = 0;
  for (let t = Date.parse(`${a}T00:00:00Z`), e = Date.parse(`${b}T00:00:00Z`); t <= e; t += 864e5) if (new Date(t).getUTCDay() !== 0) n++;
  return n;
}
const yearsWorked = (joined: string) => { const [y, m, d] = joined.split('-').map(Number); const [Y, M, D] = today().split('-').map(Number); return Math.max(0, Y! - y! - (M! < m! || (M === m && D! < d!) ? 1 : 0)); };

/** Đơn nghỉ + số ngày phép chuẩn của nhà xe */
export function useLeaves(staffId?: string) {
  const toast = useToast();
  const [list, setList] = useState<Leave[]>([]);
  const [base, setBase] = useState(12);
  const load = useCallback(async () => {
    let q = supabase.from('staff_leaves').select(COLS).order('from_on', { ascending: false }).limit(1000);
    if (staffId) q = q.eq('staff_id', staffId);
    const [r, s] = await Promise.all([q, supabase.from('tenant_settings').select('value').eq('key', 'nghi_phep.ngay_phep_nam').maybeSingle()]);
    if (r.error) return toast('error', r.error.message);
    setList(((r.data ?? []) as Leave[]).map((x) => ({ ...x, days: Number(x.days) })));
    setBase(Number(s.data?.value ?? 12) || 12);
  }, [staffId, toast]);
  useEffect(() => { void load(); }, [load]);
  return { list, base, load };
}
export const quotaOf = (s: LvStaff, base: number) => base + Math.floor(yearsWorked(s.joined_on) / 5);
export const usedOf = (list: Leave[], staffId: string, year = today().slice(0, 4)) =>
  list.filter((l) => l.staff_id === staffId && l.kind === 'phep_nam' && l.status === 'da_duyet' && l.from_on.startsWith(year)).reduce((a, l) => a + l.days, 0);

/* ------------------------------------------------------------------ Form đơn nghỉ */

function LeaveForm({ staff, all, fixed, edit, onClose, onSaved }: { staff: LvStaff[]; all: LvStaff[]; fixed?: string; edit?: Leave; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const td = today();
  const [f, setF] = useState(() => ({ staff_id: edit?.staff_id ?? fixed ?? '', kind: edit?.kind ?? 'phep_nam' as LeaveKind, from_on: edit?.from_on ?? td,
    to_on: edit?.to_on ?? td, days: String(edit?.days ?? workDays(td, td)), reason: edit?.reason ?? '', handover: edit?.handover_staff_id ?? '' }));
  const [id] = useState(() => edit?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const dates = (from: string, to: string) => { const t = to < from ? from : to; setF({ ...f, from_on: from, to_on: t, days: String(workDays(from, t)) }); };
  async function save() {
    if (!f.staff_id) return toast('error', 'Chọn nhân viên');
    const days = Number(f.days.replace(',', '.'));
    if (!(days > 0)) return toast('error', 'Số ngày nghỉ phải lớn hơn 0');
    setBusy(true);
    try {
      await rpc('save_leave', { p_id: id, p_staff_id: f.staff_id, p_kind: f.kind, p_from: f.from_on, p_to: f.to_on, p_days: days, p_reason: f.reason, p_handover: f.handover || null });
      toast('ok', edit ? 'Đã sửa đơn nghỉ' : 'Đã gửi đơn nghỉ');
      await onSaved();
      onClose();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={edit ? 'Sửa đơn nghỉ' : 'Thêm đơn nghỉ'} onClose={onClose}>
      <div className="form">
        <div className="grid2">
          {!fixed && (
            <label>Nhân viên
              <select aria-label="Nhân viên nghỉ" value={f.staff_id} onChange={(e) => setF({ ...f, staff_id: e.target.value })}>
                <option value="">-- Chọn nhân viên --</option>
                {staff.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </label>
          )}
          <label>Loại nghỉ
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as LeaveKind })}>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Từ ngày<input type="date" value={f.from_on} onChange={(e) => dates(e.target.value, f.to_on)} /></label>
          <label>Đến ngày<input type="date" value={f.to_on} min={f.from_on} onChange={(e) => dates(f.from_on, e.target.value)} /></label>
          <label>Số ngày nghỉ<input inputMode="decimal" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label>
          <label>Lý do<input aria-label="Lý do nghỉ" value={f.reason} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          <label>Người nhận bàn giao
            <select aria-label="Người nhận bàn giao" value={f.handover} onChange={(e) => setF({ ...f, handover: e.target.value })}>
              <option value="">-- Chọn người nhận bàn giao --</option>
              {all.filter((s) => s.is_active && s.id !== f.staff_id).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </label>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : edit ? 'Lưu' : 'Gửi đơn nghỉ'}</button>
          <button type="button" className="btn link" onClick={onClose}>Hủy</button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Đơn xin nghỉ phép (xem / in) */

function LeavePaperView({ l, tenantId, me, onClose }: { l: Leave; tenantId: string; me: Me; onClose: () => void }) {
  const toast = useToast();
  const [html, setHtml] = useState('');
  const ref = useRef({ me, onClose, toast });
  ref.current = { me, onClose, toast };
  useEffect(() => {
    let live = true;
    void loadLeaveCtx(tenantId, ref.current.me, l as LeaveRow).then((x) => { if (live) setHtml(leaveHtml(l as LeaveRow, x)); })
      .catch((e) => { ref.current.toast('error', errMsg(e)); ref.current.onClose(); });
    return () => { live = false; };
  }, [l, tenantId]);
  return html ? <PaperView title="Đơn xin nghỉ phép" pages={[{ html, land: false }]} onClose={onClose} /> : null;
}

/* ------------------------------------------------------------------ Một dòng đơn (bảng) */

function useActs(reload: () => Promise<void>) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try { await fn(); toast('ok', ok); await reload(); profileChanged(); } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  };
  return { busy, decide: (l: Leave, st: 'da_duyet' | 'tu_choi') => act(l.id, () => rpc('decide_leave', { p_id: l.id, p_status: st, p_note: null }), st === 'da_duyet' ? 'Đã duyệt đơn nghỉ' : 'Đã từ chối đơn nghỉ'),
    cancel: (l: Leave) => act(l.id, () => rpc('cancel_leave', { p_id: l.id }), 'Đã hủy đơn nghỉ') };
}
function StatusCell({ l, canDecide, busy, decide }: { l: Leave; canDecide: boolean; busy: boolean; decide: (l: Leave, st: 'da_duyet' | 'tu_choi') => void }) {
  const [t, c] = STATUS[l.status];
  return (
    <div className="lvx-st">
      <span className={`badge ${c}`}>{t}</span>
      {l.status === 'cho_duyet' && canDecide && (
        <span className="lvx-apv">
          <button type="button" className="btn small primary" disabled={busy} onClick={() => decide(l, 'da_duyet')}>Duyệt</button>
          <button type="button" className="btn small danger" disabled={busy} onClick={() => decide(l, 'tu_choi')}>Từ chối</button>
        </span>
      )}
      {l.decide_note && <small className="muted">{l.decide_note}</small>}
    </div>
  );
}

/* ------------------------------------------------------------------ Tab Nghỉ phép của module */

export function LeavePage({ staff, perms, myUserId, avas, onOpen, tenantId, me }: { staff: LvStaff[]; perms: LvPerms; myUserId: string | null; avas: Record<string, string>; onOpen?: (id: string) => void; tenantId: string; me: Me }) {
  const { list, base, load } = useLeaves();
  const { busy, decide, cancel } = useActs(load);
  const [form, setForm] = useState<{ edit?: Leave } | null>(null);
  const [paper, setPaper] = useState<Leave | null>(null);
  const [q, setQ] = useState(''), [st, setSt] = useState(''), [kd, setKd] = useState('');
  const td = today(), Y = td.slice(0, 4);
  const byId = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const act = staff.filter((s) => s.is_active);
  const pend = list.filter((l) => l.status === 'cho_duyet');
  const off = list.filter((l) => l.status === 'da_duyet' && l.from_on <= td && l.to_on >= td);
  const quota = act.reduce((a, s) => a + quotaOf(s, base), 0);
  const used = act.reduce((a, s) => a + usedOf(list, s.id), 0);
  const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const rows = list.filter((l) => (!st || l.status === st) && (!kd || l.kind === kd) && (!q || fold(`${byId.get(l.staff_id)?.full_name ?? ''} ${l.reason ?? ''}`).includes(fold(q.trim()))))
    .sort((a, b) => Number(b.status === 'cho_duyet') - Number(a.status === 'cho_duyet') || b.from_on.localeCompare(a.from_on));
  const grid = act.map((s) => ({ s, q: quotaOf(s, base), u: usedOf(list, s.id) })).sort((a, b) => (a.q - a.u) - (b.q - b.u));
  return (
    <div className="lvx">
      <div className="nsx-kpis">
        <div className="nsx-kpi lvx-k warn"><small>Đơn chờ duyệt</small><b>{pend.length} <em>đơn</em></b><span>{pend.length ? (perms.edit ? 'Bấm Duyệt hoặc Từ chối ngay trong bảng' : 'Đang chờ người có quyền duyệt') : 'Không có đơn nào chờ'}</span></div>
        <div className="nsx-kpi lvx-k"><small>Đang nghỉ hôm nay</small><b>{off.length} <em>người</em></b><span>{off.map((l) => byId.get(l.staff_id)?.full_name).filter(Boolean).join(', ') || 'Không ai nghỉ'}</span></div>
        <div className="nsx-kpi lvx-k ok"><small>Phép năm {Y} đã nghỉ</small><b>{num(used)} <em>ngày</em></b><span>Trên tổng quỹ {num(quota)} ngày của {act.length} người</span></div>
        <div className="nsx-kpi lvx-k vio"><small>Phép năm còn lại</small><b>{num(quota - used)} <em>ngày</em></b><span>Bình quân {num(act.length ? (quota - used) / act.length : 0)} ngày mỗi người</span></div>
      </div>
      <section className="card lvx-card">
        <div className="lvx-h"><h3>Số ngày phép năm {Y} còn lại</h3></div>
        <div className="lvx-grid">
          {grid.map(({ s, q: qq, u }) => { const p = qq ? (u / qq) * 100 : 0;
            return (
              <button key={s.id} type="button" className="lvx-pp" onClick={() => onOpen?.(s.id)}>
                <Avatar name={s.full_name} url={avas[s.id]} size={34} />
                <span className="lvx-m"><b>{s.full_name}</b><span className="lvx-bar"><i style={{ width: `${Math.min(100, p)}%`, background: p >= 80 ? '#dc2626' : p >= 50 ? '#f59e0b' : '#16a34a' }} /></span></span>
                <span className="lvx-n"><b>{num(qq - u)}</b>/{qq}</span>
              </button>
            ); })}
        </div>
      </section>
      <div className="nsx-tools lvx-tools">
        <input className="nsx-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo tên nhân viên, lý do…" aria-label="Tìm đơn nghỉ" />
        <select className="nsx-search" value={st} onChange={(e) => setSt(e.target.value)} aria-label="Lọc trạng thái"><option value="">Tất cả trạng thái</option>{Object.entries(STATUS).map(([k, [t]]) => <option key={k} value={k}>{t}</option>)}</select>
        <select className="nsx-search" value={kd} onChange={(e) => setKd(e.target.value)} aria-label="Lọc loại nghỉ"><option value="">Tất cả loại nghỉ</option>{Object.entries(KIND).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        {perms.add && <button type="button" className="btn primary lvx-add" onClick={() => setForm({})}>+ Thêm đơn nghỉ</button>}
      </div>
      <section className="card lvx-card">
        {rows.length === 0 ? <p className="muted">Chưa có đơn nghỉ nào phù hợp.</p> : (
          <div className="nsx-tblw">
            <table className="nsx-tbl lvx-tbl">
              <thead><tr><th>Nhân viên</th><th>Loại nghỉ</th><th>Từ ngày</th><th>Đến ngày</th><th>Số ngày</th><th>Lý do</th><th>Trạng thái</th><th /></tr></thead>
              <tbody>
                {rows.map((l) => { const s = byId.get(l.staff_id);
                  const mine = l.created_by === myUserId;
                  return (
                    <tr key={l.id}>
                      <td><div className="nsx-who">{s && <Avatar name={s.full_name} url={avas[s.id]} size={32} />}<div><b>{s?.full_name ?? '(đã xóa)'}</b><span className="sc-job">{s?.job_title || ''}</span></div></div></td>
                      <td>{KIND[l.kind]}</td><td className="nsx-nw">{fmtDate(l.from_on)}</td><td className="nsx-nw">{fmtDate(l.to_on)}</td><td>{num(l.days)}</td><td>{l.reason ?? ''}</td>
                      <td><StatusCell l={l} canDecide={perms.edit} busy={busy === l.id} decide={(x, v) => void decide(x, v)} /></td>
                      <td className="nsx-nw">
                        {l.status !== 'da_huy' && <button type="button" className="btn small" onClick={() => setPaper(l)}>Đơn</button>}
                        {l.status === 'cho_duyet' && (mine || perms.edit) && <button type="button" className="btn small" onClick={() => setForm({ edit: l })}>Sửa</button>}
                        {l.status !== 'da_huy' && l.status !== 'tu_choi' && (perms.edit || (mine && l.status === 'cho_duyet')) &&
                          <button type="button" className="btn small link" disabled={busy === l.id} onClick={() => void cancel(l)}>Hủy đơn</button>}
                      </td>
                    </tr>
                  ); })}
              </tbody>
              <tfoot><tr><td colSpan={4}>Tổng {rows.length} đơn</td><td><b>{num(rows.filter((l) => l.status !== 'da_huy' && l.status !== 'tu_choi').reduce((a, l) => a + l.days, 0))}</b></td><td colSpan={3} /></tr></tfoot>
            </table>
          </div>
        )}
      </section>
      {form && <LeaveForm staff={staff} all={staff} edit={form.edit} onClose={() => setForm(null)} onSaved={load} />}
      {paper && <LeavePaperView l={paper} tenantId={tenantId} me={me} onClose={() => setPaper(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ Tab Nghỉ phép trong hồ sơ 1 người */

export function LeaveOfStaff({ s, all, perms, myUserId, tenantId, me }: { s: LvStaff; all: LvStaff[]; perms: LvPerms; myUserId: string | null; tenantId: string; me: Me }) {
  const { list, base, load } = useLeaves(s.id);
  const { busy, decide, cancel } = useActs(load);
  const [form, setForm] = useState<{ edit?: Leave } | null>(null);
  const [paper, setPaper] = useState<Leave | null>(null);
  const mineProfile = s.user_id === myUserId;
  const q = quotaOf(s, base), u = usedOf(list, s.id);
  return (
    <div className="lvx">
      <div className="lvx-sum">
        <div><small>Phép năm {today().slice(0, 4)}</small><b>{q} ngày</b></div>
        <div><small>Đã nghỉ</small><b>{num(u)} ngày</b></div>
        <div><small>Còn lại</small><b className="ok">{num(q - u)} ngày</b></div>
        {(mineProfile || perms.add) && <button type="button" className="btn primary lvx-add" onClick={() => setForm({})}>{mineProfile ? '+ Xin nghỉ' : '+ Thêm đơn nghỉ'}</button>}
      </div>
      {list.length === 0 ? <p className="muted">Chưa có đơn nghỉ.</p> : (
        <ul className="list lvx-list">
          {list.map((l) => (
            <li key={l.id} className="item">
              <div className="item-head">
                <div><b>{KIND[l.kind]}</b> · {fmtDate(l.from_on)}{l.to_on !== l.from_on ? ` → ${fmtDate(l.to_on)}` : ''} · {num(l.days)} ngày
                  {l.reason && <div className="muted small">{l.reason}</div>}</div>
                <StatusCell l={l} canDecide={perms.edit && !mineProfile} busy={busy === l.id} decide={(x, v) => void decide(x, v)} />
              </div>
              {l.status !== 'da_huy' && (
                <div className="actions">
                  <button type="button" className="btn small" onClick={() => setPaper(l)}>Đơn</button>
                  {l.status === 'cho_duyet' && (l.created_by === myUserId || perms.edit) && <>
                    <button type="button" className="btn small" onClick={() => setForm({ edit: l })}>Sửa</button>
                    <button type="button" className="btn small link" disabled={busy === l.id} onClick={() => void cancel(l)}>Hủy đơn</button>
                  </>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {form && <LeaveForm staff={[s]} all={all} fixed={s.id} edit={form.edit} onClose={() => setForm(null)} onSaved={load} />}
      {paper && <LeavePaperView l={paper} tenantId={tenantId} me={me} onClose={() => setPaper(null)} />}
    </div>
  );
}
