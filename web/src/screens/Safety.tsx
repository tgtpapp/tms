// Giám sát an toàn giao thông: sổ giám sát (cảnh báo / vi phạm / sự cố), xem / in các phụ lục,
// hồ sơ tự lưu vào Lưu trữ hồ sơ › Năm › An toàn giao thông (checklist trước chuyến, sổ ngày, biên bản, sự cố, báo cáo tuần / tháng / năm).
import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { PaperView } from '../components/ProfilePapers';
import type { Permissions } from '../lib/permissions';
import {
  autoArchiveSafety, baoCao, bienBan, checklistDay, CONCL, dmy, EV_COLS, KIND, LEVEL, loadBase, monthOf, soNgay, SOURCES, suCo, todayVN, vnDay, vnTime,
  weekLabel, weekOf, yearOf, type SEvent,
} from '../lib/safety';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Trip { id: string; depart_at: string; route_id: string; direction: string; vehicle_id: string | null; driver: string | null }
type Form = { id: string | null; occurred_at: string; place: string; vehicle_id: string; staff_id: string; trip_id: string; kind: string; level: string;
  source: string; content: string; notified: string; action: string; due_on: string; verify: string; result: string; req: string };
const localNow = () => { const d = new Date(Date.now() + 7 * 3600_000); return d.toISOString().slice(0, 16); };
const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16);

export function SafetyScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  void ctx;
  const toast = useToast();
  const canAdd = perms.has('safety.add'), canEdit = perms.has('safety.edit'), canDel = perms.has('safety.delete');
  const canArchive = perms.has('archive.add') && perms.has('archive.view');
  const [month, setMonth] = useState(todayVN().slice(0, 7));
  const [st, setSt] = useState<'' | 'mo' | 'dong'>('');
  const [list, setList] = useState<SEvent[]>([]);
  const [veh, setVeh] = useState<{ id: string; plate: string }[]>([]);
  const [staff, setStaff] = useState<{ id: string; full_name: string; position: string; is_active: boolean }[]>([]);
  const [routes, setRoutes] = useState<Map<string, { name: string; name_ve: string | null }>>(new Map());
  const [trips, setTrips] = useState<Trip[]>([]);
  const [f, setF] = useState<Form | null>(null);
  const [close, setClose] = useState<{ e: SEvent; c: string; r: string } | null>(null);
  const [view, setView] = useState<{ title: string; pages: string[]; land: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [day, setDay] = useState(todayVN());

  const load = useCallback(async () => {
    const [y, m] = month.split('-').map(Number);
    const to = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
    const [ev, vh, sm, rt] = await Promise.all([
      supabase.from('safety_events').select(EV_COLS).gte('occurred_at', `${month}-01T00:00:00+07:00`).lt('occurred_at', `${to}T00:00:00+07:00`).order('occurred_at', { ascending: false }),
      supabase.from('vehicles').select('id, plate').order('plate'),
      supabase.from('staff_members').select('id, full_name, position, is_active').order('full_name'),
      supabase.from('routes').select('id, name, name_ve'),
    ]);
    if (ev.error) return toast('error', ev.error.message);
    setList((ev.data ?? []) as SEvent[]);
    setVeh((vh.data ?? []) as { id: string; plate: string }[]);
    setStaff((sm.data ?? []) as { id: string; full_name: string; position: string; is_active: boolean }[]);
    setRoutes(new Map(((rt.data ?? []) as { id: string; name: string; name_ve: string | null }[]).map((r) => [r.id, r])));
  }, [month, toast]);
  useEffect(() => { void load(); }, [load]);

  // chuyến của ngày đang ghi (chọn chuyến thì tự điền xe, lái xe)
  const fDay = f?.occurred_at.slice(0, 10) ?? '';
  useEffect(() => {
    if (!fDay) return;
    void (async () => {
      const { data } = await supabase.from('trips').select('id, depart_at, route_id, direction, vehicle_id').eq('service_date', fDay).eq('status', 'mo').order('depart_at');
      const T = (data ?? []) as Omit<Trip, 'driver'>[];
      const c = T.length ? ((await supabase.from('trip_crew').select('trip_id, staff_id').in('trip_id', T.map((t) => t.id)).eq('role', 'lai_xe_1').eq('active', true)).data ?? []) as { trip_id: string; staff_id: string }[] : [];
      setTrips(T.map((t) => ({ ...t, driver: c.find((x) => x.trip_id === t.id)?.staff_id ?? null })));
    })();
  }, [fDay]);

  const plate = (id: string | null) => veh.find((v) => v.id === id)?.plate ?? '';
  const name = (id: string | null) => staff.find((s) => s.id === id)?.full_name ?? '';
  const rname = (t: { route_id: string; direction: string }) => { const r = routes.get(t.route_id); return !r ? '' : t.direction === 've' ? r.name_ve?.trim() || r.name.split(/\s+[-–—]\s+/).reverse().join(' - ') : r.name; };
  const shown = list.filter((e) => !st || e.status === st);

  const blank = (): Form => ({ id: null, occurred_at: localNow(), place: '', vehicle_id: '', staff_id: '', trip_id: '', kind: 'toc_do', level: '1', source: SOURCES[0]!,
    content: '', notified: '', action: '', due_on: '', verify: '', result: '', req: crypto.randomUUID() });
  const edit = (e: SEvent): Form => ({ id: e.id, occurred_at: toLocal(e.occurred_at), place: e.place ?? '', vehicle_id: e.vehicle_id ?? '', staff_id: e.staff_id ?? '', trip_id: e.trip_id ?? '',
    kind: e.kind, level: String(e.level), source: e.source ?? '', content: e.content, notified: e.notified ?? '', action: e.action ?? '', due_on: e.due_on ?? '',
    verify: e.verify ?? '', result: e.result ?? '', req: '' });
  async function save() {
    if (!f) return;
    if (!f.content.trim()) return toast('error', 'Nhập nội dung sự việc');
    setBusy('Đang lưu…');
    try {
      const { id, req, occurred_at, ...rest } = f;
      await rpc('save_safety_event', { p_id: id, p: { ...rest, occurred_at: `${occurred_at}:00+07:00` }, p_request_id: id ? null : req });
      toast('ok', id ? 'Đã sửa sự việc' : 'Đã ghi vào sổ giám sát');
      setF(null);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function doClose() {
    if (!close) return;
    try {
      await rpc('close_safety_event', { p_id: close.e.id, p_conclusion: close.c, p_result: close.r });
      toast('ok', close.c === 'vi_pham' ? 'Đã đóng · đã ghi Lý lịch hành nghề lái xe' : 'Đã đóng sự việc');
      setClose(null);
      await load();
    } catch (e) { toast('error', errMsg(e)); }
  }
  async function del(e: SEvent) {
    if (!window.confirm('Xóa sự việc ghi nhầm này?')) return;
    try { await rpc('delete_safety_event', { p_id: e.id }); toast('ok', 'Đã xóa'); await load(); } catch (x) { toast('error', errMsg(x)); }
  }
  async function show(kind: 'ck' | 'so' | 'w' | 'm' | 'y' | 'bb' | 'sc', e?: SEvent) {
    setBusy('Đang dựng giấy…');
    try {
      const b = await loadBase();
      if (kind === 'ck') { const r = await checklistDay(b, day); if (!r) toast('error', `Ngày ${dmy(day)} chưa có chuyến đã xếp xe / lái xe`); else setView({ title: `Checklist trước chuyến ngày ${dmy(day)}`, pages: r.pages, land: true }); }
      else if (kind === 'so') { const p = await soNgay(b, day); if (!p) toast('ok', `Ngày ${dmy(day)} không có sự việc nào`); else setView({ title: `Sổ giám sát ngày ${dmy(day)}`, pages: p, land: true }); }
      else if (kind === 'bb' && e) setView({ title: 'Biên bản xác minh', pages: bienBan(b, e), land: false });
      else if (kind === 'sc' && e) setView({ title: 'Báo cáo sự cố khẩn cấp', pages: suCo(b, e), land: false });
      else {
        const p = kind === 'w' ? weekOf(day) : kind === 'm' ? monthOf(day) : yearOf(day);
        const lb = kind === 'w' ? weekLabel(p.from) : kind === 'm' ? `tháng ${p.from.slice(5, 7)}/${p.from.slice(0, 4)}` : `năm ${p.from.slice(0, 4)}`;
        const r = await baoCao(b, lb, p.from, p.to);
        setView({ title: `Báo cáo giám sát an toàn ${lb}`, pages: r.pages, land: false });
      }
    } catch (x) { toast('error', errMsg(x)); } finally { setBusy(''); }
  }
  async function archiveNow() {
    setBusy('Đang lập hồ sơ…');
    try { const n = await autoArchiveSafety((s) => setBusy(s)); toast('ok', n ? `Đã lưu ${n} hồ sơ vào Lưu trữ hồ sơ › An toàn giao thông` : 'Hồ sơ an toàn giao thông đã đủ, không có gì mới'); }
    catch (x) { toast('error', `Chưa lưu được hồ sơ: ${errMsg(x)}`); } finally { setBusy(''); }
  }

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => (x ? { ...x, [k]: e.target.value } : x));
  return (
    <section className="card">
      <div className="item-head">
        <h2>Giám sát an toàn giao thông</h2>
        <span className="actions">
          {canAdd && <button type="button" className="btn small primary" onClick={() => setF(blank())}>+ Ghi sự việc</button>}
          {canArchive && <button type="button" className="btn small" disabled={!!busy} onClick={() => void archiveNow()}>Lưu hồ sơ ngay</button>}
        </span>
      </div>
      <p className="small muted">Tự động: xếp xe vẫn lưu dù có cảnh báo (giờ lái, giấy tờ hết hạn, sai hạng…) thì tự ghi sổ; cảnh báo của chuyến đã chạy xong tự đóng.
        Đóng sự việc là vi phạm / sự cố thì tự ghi Lý lịch hành nghề lái xe, lý lịch phương tiện. Hồ sơ tự lưu vào <b>Lưu trữ hồ sơ › Năm › An toàn giao thông</b>:
        checklist trước chuyến mỗi ngày, sổ giám sát (chỉ ngày có sự việc), biên bản xác minh, báo cáo sự cố, báo cáo tuần / tháng / năm. Căn cứ pháp lý của mẫu: cần xác minh.</p>
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        <label className="inline">Ngày <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void show('ck')}>Checklist trước chuyến</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void show('so')}>Sổ giám sát ngày</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void show('w')}>Báo cáo tuần</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void show('m')}>Báo cáo tháng</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void show('y')}>Báo cáo năm</button>
        {busy && <span className="small muted">{busy}</span>}
      </div>
      <div className="grid3 form">
        <label>Tháng<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <label>Trạng thái<select value={st} onChange={(e) => setSt(e.target.value as '' | 'mo' | 'dong')}><option value="">Tất cả</option><option value="mo">Đang theo dõi</option><option value="dong">Đã đóng</option></select></label>
      </div>
      {shown.length === 0 ? <p className="muted">Tháng {month.slice(5)}/{month.slice(0, 4)} chưa có sự việc nào.</p> : (
        <div className="table-wrap">
          <table className="plist">
            <thead><tr><th>Ngày giờ</th><th>Xe / lái xe</th><th>Loại · mức</th><th>Nội dung</th><th>Biện pháp</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>{shown.map((e) => (
              <tr key={e.id}>
                <td>{dmy(vnDay(e.occurred_at))} {vnTime(e.occurred_at)}</td>
                <td>{[plate(e.vehicle_id), name(e.staff_id)].filter(Boolean).join(' / ') || '—'}</td>
                <td>{KIND[e.kind]}<div className="small muted">{LEVEL[e.level]}{e.auto ? ' · tự ghi' : ''}</div></td>
                <td>{e.content}{e.source && <div className="small muted">Nguồn: {e.source}</div>}</td>
                <td>{e.action}{e.due_on && <div className="small muted">Hạn: {dmy(e.due_on)}</div>}</td>
                <td>{e.status === 'mo' ? <b>Đang theo dõi</b> : <>{CONCL[e.conclusion ?? '']}{e.result && <div className="small muted">{e.result}</div>}</>}</td>
                <td className="actions">
                  {e.status === 'mo' && canEdit && <button className="btn small" onClick={() => setF(edit(e))}>Sửa</button>}
                  {e.status === 'mo' && canEdit && <button className="btn small primary" aria-label={`Đóng sự việc ${e.content}`} onClick={() => setClose({ e, c: 'khac_phuc', r: '' })}>Đóng</button>}
                  <button className="btn small" onClick={() => void show('bb', e)}>Biên bản</button>
                  {(e.kind === 'su_co' || e.level === 3) && <button className="btn small" onClick={() => void show('sc', e)}>Báo cáo sự cố</button>}
                  {e.status === 'mo' && canDel && <button className="btn small link danger-text" onClick={() => void del(e)}>Xóa</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {f && (
        <Modal wide title={f.id ? 'Sửa sự việc' : 'Ghi sự việc vào sổ giám sát'} onClose={() => { if (!busy) setF(null); }}>
          <div className="form">
            <div className="grid2">
              <label>Thời điểm<input type="datetime-local" value={f.occurred_at} onChange={set('occurred_at')} /></label>
              <label>Chuyến (chọn thì tự điền xe, lái xe)
                <select value={f.trip_id} onChange={(e) => { const t = trips.find((x) => x.id === e.target.value); setF({ ...f, trip_id: e.target.value, vehicle_id: t?.vehicle_id ?? f.vehicle_id, staff_id: t?.driver ?? f.staff_id }); }}>
                  <option value="">— Không gắn chuyến —</option>
                  {trips.map((t) => <option key={t.id} value={t.id}>{vnTime(t.depart_at)} {rname(t)} · {plate(t.vehicle_id) || 'chưa xe'} · {name(t.driver) || 'chưa lái xe'}</option>)}
                </select></label>
              <label>Xe<select value={f.vehicle_id} onChange={set('vehicle_id')}><option value="">—</option>{veh.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
              <label>Lái xe<select value={f.staff_id} onChange={set('staff_id')}><option value="">—</option>{staff.filter((s) => s.is_active || s.id === f.staff_id).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></label>
              <label>Loại<select value={f.kind} onChange={set('kind')}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Mức độ<select value={f.level} onChange={set('level')}>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{k} · {v}</option>)}</select></label>
              <label>Nguồn dữ liệu<input value={f.source} onChange={set('source')} list="atgt-nguon" /><datalist id="atgt-nguon">{SOURCES.map((s) => <option key={s} value={s} />)}</datalist></label>
              <label>Địa điểm<input value={f.place} onChange={set('place')} placeholder="vd: Km 30 cao tốc Biên Hòa - Vũng Tàu" /></label>
            </div>
            <label>Nội dung sự việc<textarea rows={3} value={f.content} onChange={set('content')} placeholder="vd: Vượt tốc độ 92/80 km/h lúc 08:15 đoạn QL51" /></label>
            <div className="grid2">
              <label>Người được thông báo<input value={f.notified} onChange={set('notified')} /></label>
              <label>Hạn khắc phục<input type="date" value={f.due_on} onChange={set('due_on')} /></label>
            </div>
            <label>Thông báo / biện pháp<textarea rows={2} value={f.action} onChange={set('action')} /></label>
            <label>Diễn biến xác minh / ý kiến các bên<textarea rows={2} value={f.verify} onChange={set('verify')} /></label>
            <div className="actions"><button className="btn primary" disabled={!!busy} onClick={() => void save()}>{f.id ? 'Lưu' : 'Ghi vào sổ'}</button></div>
          </div>
        </Modal>
      )}
      {close && (
        <Modal title="Đóng sự việc" onClose={() => setClose(null)}>
          <div className="form">
            <p className="small">{close.e.content}</p>
            <label>Kết luận<select value={close.c} onChange={(e) => setClose({ ...close, c: e.target.value })}>{Object.entries(CONCL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label>Kết quả<textarea rows={2} value={close.r} onChange={(e) => setClose({ ...close, r: e.target.value })} placeholder="vd: Đã nhắc nhở, lái xe cam kết không tái phạm" /></label>
            {close.c === 'vi_pham' && close.e.staff_id && <p className="small muted">Sẽ tự ghi vào Lý lịch hành nghề của {name(close.e.staff_id)}.</p>}
            <div className="actions"><button className="btn primary" onClick={() => void doClose()}>Đóng sự việc</button></div>
          </div>
        </Modal>
      )}
      {view && <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: view.land }))} onClose={() => setView(null)} />}
    </section>
  );
}
