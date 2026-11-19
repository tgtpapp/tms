// Nhập dữ liệu từ app cũ: chọn file sao lưu .json → xem trước → nhập nhân viên, xe và giấy tờ.
// Nhập lại không trùng (id cố định theo mã cũ, khớp CCCD / SĐT / tên / biển số). Dữ liệu đã có trong TMS được giữ nguyên.
import { dirName, type Dir } from '../lib/routes';
import { norm, routeKey, titleCase } from '../lib/scheduleImport';
import { useState } from 'react';
import { LegacyMore } from './LegacyMore';
import { today } from '../components/Documents';
import { uploadFiles } from '../lib/documents';
import {
  day, mapEmployee, mapVehicle, normName, parseBackup, str, type LegacyBackup, PLATE_OK, plateKey, stableId, type LegacyDoc, type StaffRow, type VehicleRow,
} from '../lib/legacyImport';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface VType { id: string; name: string; code: string; reg_seats: number; reg_berths: number; is_active: boolean }
interface Existing {
  staffIds: Set<string>; byCccd: Map<string, string>; byPhone: Map<string, string>; byName: Map<string, string>;
  vehicleByKey: Map<string, string>; requestIds: Set<string>; current: Set<string>; types: VType[];
}
interface Plan {
  staff: (StaffRow & { id: string; match: string | null })[];
  vehicles: (VehicleRow & { id: string; match: string | null; bad: string | null })[];
  ex: Existing;
}

const NEW = '__tao_moi__';

async function loadExisting(): Promise<Existing> {
  const [s, d, v, t] = await Promise.all([
    supabase.from('staff_members').select('id, full_name, phone'),
    supabase.from('documents').select('vehicle_id, staff_id, doc_type, doc_no, is_current, request_id'),
    supabase.from('vehicles').select('id, plate'),
    supabase.from('vehicle_types').select('id, name, code, reg_seats, reg_berths, is_active'),
  ]);
  const err = s.error ?? d.error ?? v.error ?? t.error;
  if (err) throw new Error(err.message);
  const staff = (s.data ?? []) as { id: string; full_name: string; phone: string | null }[];
  const docs = (d.data ?? []) as { vehicle_id: string | null; staff_id: string | null; doc_type: string; doc_no: string | null; is_current: boolean; request_id: string | null }[];
  return {
    staffIds: new Set(staff.map((x) => x.id)),
    byCccd: new Map(docs.filter((x) => x.doc_type === 'cccd' && x.doc_no && x.staff_id).map((x) => [x.doc_no!.replace(/\D/g, ''), x.staff_id!])),
    byPhone: new Map(staff.filter((x) => x.phone).map((x) => [x.phone!, x.id])),
    byName: new Map(staff.map((x) => [normName(x.full_name), x.id])),
    vehicleByKey: new Map(((v.data ?? []) as { id: string; plate: string }[]).map((x) => [plateKey(x.plate), x.id])),
    requestIds: new Set(docs.map((x) => x.request_id).filter((x): x is string => !!x)),
    current: new Set(docs.filter((x) => x.is_current).map((x) => `${x.vehicle_id ?? x.staff_id}|${x.doc_type}`)),
    types: (t.data ?? []) as VType[],
  };
}

export function LegacyImport({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typeOf, setTypeOf] = useState<Record<string, string>>({});
  const [pick, setPick] = useState({ staff: true, vehicles: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string[] | null>(null);
  const [legacy, setLegacy] = useState<LegacyBackup | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setResult(null);
    setBusy('Đang đọc file…');
    try {
      const backup = parseBackup(await file.text());
      setLegacy(backup);
      const ex = await loadExisting();
      const d = today();
      const staff: Plan['staff'] = [];
      for (const r of backup.employees) {
        const m = mapEmployee(r, d);
        if (!m) continue;
        const id = await stableId(tenantId, 'nv', m.oldId);
        const match = ex.staffIds.has(id) ? id
          : (m.cccd && ex.byCccd.get(m.cccd)) || (m.phone && ex.byPhone.get(m.phone)) || ex.byName.get(normName(m.name)) || null;
        staff.push({ ...m, id: match ?? id, match });
      }
      const vehicles: Plan['vehicles'] = [];
      for (const r of backup.vehicles) {
        const m = mapVehicle(r);
        if (!m) continue;
        const match = ex.vehicleByKey.get(m.key) ?? null;
        vehicles.push({ ...m, id: match ?? await stableId(tenantId, 'xe', m.oldId), match,
                        bad: match || PLATE_OK.test(m.key) ? null : 'Biển số sai dạng' });
      }
      // Gợi ý loại xe theo số chỗ (ghế + giường)
      const guess: Record<string, string> = {};
      for (const v of vehicles) {
        if (guess[v.group] !== undefined) continue;
        const hit = ex.types.filter((t) => t.is_active && v.seats !== null && t.reg_seats + t.reg_berths === v.seats);
        guess[v.group] = hit.length === 1 ? hit[0].id : NEW;   // không khớp: tự tạo loại xe mới
      }
      setTypeOf(guess);
      setPlan({ staff, vehicles, ex });
    } catch (e) {
      toast('error', errMsg(e));
      setPlan(null);
    } finally {
      setBusy(null);
    }
  }

  async function importDocs(kind: 'xe' | 'nhan_su', ownerId: string, label: string, docs: LegacyDoc[], ex: Existing, log: string[]) {
    let n = 0;
    for (const d of docs) {
      const req = await stableId(tenantId, `gt:${kind}:${ownerId}`, d.type);
      if (ex.requestIds.has(req) || ex.current.has(`${ownerId}|${d.type}`)) continue;   // đã có: không tải ảnh thừa
      try {
        const files = d.files.length ? await uploadFiles(tenantId, kind, ownerId, label, d.type, d.files) : [];
        const note = ['Nhập từ app cũ', d.external ? `${d.external} ảnh còn trên Google Drive (app cũ), chưa chuyển` : ''].filter(Boolean).join(' · ');
        const id = await rpc<string | null>('import_document', {
          p_owner_kind: kind, p_owner_id: ownerId, p_doc_type: d.type, p_doc_no: d.doc_no, p_issuer: d.issuer, p_issued_on: d.issued_on,
          p_valid_from: null, p_expires_on: d.expires_on, p_data: d.data, p_files: files, p_note: note, p_request_id: req,
        });
        if (id) n++;
      } catch (e) {
        log.push(`${label} – giấy ${d.type}: ${errMsg(e)}`);
      }
    }
    return n;
  }

  async function run() {
    if (!plan) return;
    const missing = pick.vehicles && plan.vehicles.some((v) => !v.match && !v.bad && !typeOf[v.group]);
    if (missing) return toast('error', 'Chọn loại xe TMS cho từng nhóm xe cũ');
    const log: string[] = [];
    let staffNew = 0, vehNew = 0, docs = 0, typesNew = 0;
    const total = (pick.staff ? plan.staff.length : 0) + (pick.vehicles ? plan.vehicles.length : 0);
    let i = 0;
    try {
      if (pick.staff) {
        for (const s of plan.staff) {
          setBusy(`Đang nhập ${++i}/${total}: ${s.name}`);
          try {
            if (!s.match) {
              await rpc('save_staff', { p_id: s.id, p: s.staff });
              staffNew++;
            }
            docs += await importDocs('nhan_su', s.id, s.name, s.docs, plan.ex, log);
          } catch (e) {
            log.push(`${s.name}: ${errMsg(e)}`);
          }
        }
      }
      if (pick.vehicles) {
        // Tự tạo loại xe cho nhóm chưa có (kèm sơ đồ ghế của app cũ nếu có)
        const typeId: Record<string, string> = { ...typeOf };
        for (const [g, sel] of Object.entries(typeOf)) {
          if (sel !== NEW) continue;
          const vs = plan.vehicles.filter((v) => v.group === g && !v.match && !v.bad);   // chỉ nhóm còn xe mới cần nhập
          const v0 = vs[0];
          if (!v0) continue;
          setBusy(`Đang tạo loại xe ${v0.label}`);
          const id = await stableId(tenantId, 'lx', g);
          const layout = vs.find((v) => v.layout)?.layout ?? null;
          const code = `CU-${(v0.brand || 'XE').normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10)}${v0.seats ?? ''}`;
          if (!plan.ex.types.some((t) => t.id === id)) {
            const { error } = await supabase.from('vehicle_types').insert({
              id, code, name: v0.label, brand: v0.brand || null,
              reg_seats: Math.max(v0.seats ?? 0, layout?.seats.length ?? 0, 1),
            });
            if (error) { log.push(`Loại xe ${v0.label}: ${error.code === '23505' ? 'mã loại xe đã có, chọn loại xe có sẵn' : error.message}`); continue; }
            if (layout) {
              try {
                await rpc('set_seat_layout', { p_type_id: id, p_rows: layout.rows, p_cols: layout.cols, p_seats: layout.seats });
              } catch (e) {
                log.push(`Sơ đồ ghế ${v0.label}: ${errMsg(e)} – vẽ lại ở mục Xe`);
              }
            } else log.push(`Loại xe ${v0.label}: app cũ chưa có sơ đồ ghế, vẽ ở mục Xe → Loại xe`);
            typesNew++;
          }
          typeId[g] = id;
        }
        for (const v of plan.vehicles) {
          setBusy(`Đang nhập ${++i}/${total}: xe ${v.plate}`);
          if (v.bad) {
            log.push(`Xe ${v.plate}: ${v.bad}, bỏ qua`);
            continue;
          }
          try {
            if (!v.match) {
              if (!typeId[v.group] || typeId[v.group] === NEW) { log.push(`Xe ${v.plate}: chưa có loại xe, bỏ qua`); continue; }
              const { error } = await supabase.from('vehicles').insert({ id: v.id, ...v.vehicle, vehicle_type_id: typeId[v.group] });
              if (error && error.code !== '23505') throw new Error(error.message);
              if (error) {
                log.push(`Xe ${v.plate}: biển số hoặc số khung đã có, bỏ qua`);
                continue;
              }
              vehNew++;
            }
            docs += await importDocs('xe', v.id, v.plate, v.docs, plan.ex, log);
          } catch (e) {
            log.push(`Xe ${v.plate}: ${errMsg(e)}`);
          }
        }
      }
    } finally {
      setBusy(null);
    }
    const msg = `Đã nhập ${staffNew} nhân viên, ${vehNew} xe${typesNew ? ` (tạo ${typesNew} loại xe)` : ''}, ${docs} giấy tờ`;
    toast(log.length ? 'error' : 'ok', log.length ? `${msg} · ${log.length} mục lỗi` : msg);
    setResult([msg, ...log]);
    setPlan(null);
  }

  const groups = plan ? [...new Map(plan.vehicles.filter((v) => !v.match && !v.bad).map((v) => [v.group, v.label])).entries()] : [];
  const docCount = (rows: { docs: LegacyDoc[] }[]) => rows.reduce((a, r) => a + r.docs.length, 0);

  return (
    <section className="card form">
      <h2>Nhập dữ liệu từ app cũ</h2>
      <p className="muted small">
        Trong app cũ: Sao lưu &amp; khôi phục → "Tải bản sao lưu" (.json), rồi chọn file đó ở đây. File được đọc ngay trên máy này,
        chỉ lấy nhân viên, xe và giấy tờ; cấu hình và khóa trong file bị bỏ qua. Nhập lại nhiều lần không bị trùng, dữ liệu đã có trong TMS được giữ nguyên.
      </p>
      <label className="upload">
        <span>Chọn file sao lưu app cũ (.json)</span>
        <input type="file" accept=".json,application/json" aria-label="File sao lưu app cũ" disabled={!!busy}
               onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {busy && <p className="upload">{busy}</p>}
      {plan && !busy && (
        <>
          <h3 className="section-title">Xem trước</h3>
          <label className="check">
            <input type="checkbox" checked={pick.staff} onChange={(e) => setPick({ ...pick, staff: e.target.checked })} />
            Nhân viên: {plan.staff.filter((s) => !s.match).length} mới, {plan.staff.filter((s) => s.match).length} đã có · {docCount(plan.staff)} giấy tờ
          </label>
          <ul className="queue-list small">
            {plan.staff.map((s) => (
              <li key={s.oldId}>{s.name}{s.ma ? ` (${s.ma})` : ''} · {s.position === 'lai_xe' ? 'Lái xe' : s.position === 'phu_xe' ? 'Phụ xe' : 'Nhân viên'}
                {' · '}{s.match ? <b>Đã có</b> : 'Mới'}{s.docs.length ? ` · giấy: ${s.docs.map((d) => d.type.toUpperCase()).join(', ')}` : ''}</li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={pick.vehicles} onChange={(e) => setPick({ ...pick, vehicles: e.target.checked })} />
            Xe: {plan.vehicles.filter((v) => !v.match && !v.bad).length} mới, {plan.vehicles.filter((v) => v.match).length} đã có
            {plan.vehicles.some((v) => v.bad) ? `, ${plan.vehicles.filter((v) => v.bad).length} lỗi` : ''} · {docCount(plan.vehicles)} giấy tờ
          </label>
          <ul className="queue-list small">
            {plan.vehicles.map((v) => (
              <li key={v.oldId}>{v.plate} · {v.label} · {v.bad ? <b className="error-text">{v.bad}</b> : v.match ? <b>Đã có</b> : 'Mới'}</li>
            ))}
          </ul>
          {pick.vehicles && groups.length > 0 && (
            <>
              <p className="muted small">Loại xe tự khớp theo số chỗ. Không khớp thì app tự tạo loại xe mới kèm sơ đồ ghế của app cũ; muốn dùng loại có sẵn thì chọn lại.</p>
              {groups.map(([g, label]) => (
                <label key={g}>Loại xe TMS cho xe cũ "{label}"
                  <select aria-label={`Loại xe cho ${label}`} value={typeOf[g] ?? ''} onChange={(e) => setTypeOf({ ...typeOf, [g]: e.target.value })}>
                    <option value={NEW}>Tự tạo loại xe mới "{label}" (lấy sơ đồ ghế từ app cũ)</option>
                    {plan.ex.types.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}
                  </select>
                </label>
              ))}
            </>
          )}
          <div className="actions">
            <button type="button" className="btn primary" disabled={!pick.staff && !pick.vehicles} onClick={() => void run()}>Nhập dữ liệu</button>
            <button type="button" className="btn link" onClick={() => setPlan(null)}>Thôi</button>
          </div>
        </>
      )}
      {legacy && legacy.trips.length > 0 && !busy && <LegacyTrips legacy={legacy} />}
      {legacy && (legacy.repairs.length > 0 || legacy.fuel.length > 0 || legacy.km.length > 0) && !busy && <LegacyOps legacy={legacy} />}
      {legacy && (legacy.schedules.length + legacy.fares.length + legacy.records.length + legacy.charters.length > 0) && !busy && <LegacyMore legacy={legacy} tenantId={tenantId} />}
      {result && (
        <ul className="queue-list small">
          {result.map((r, i) => <li key={i} className={i ? 'error-text' : ''}>{r}</li>)}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Chuyển lịch chạy (chuyến đã điều) từ app cũ */

function LegacyTrips({ legacy }: { legacy: LegacyBackup }) {
  const toast = useToast();
  const dates = legacy.trips.map((t) => str(t, 'ngay')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const [from, setFrom] = useState(dates[0] ?? '');
  const [to, setTo] = useState(dates[dates.length - 1] ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<string[] | null>(null);
  const list = legacy.trips.filter((t) => { const d = str(t, 'ngay'); return d >= from && d <= to && str(t, 'tuyen') && /^\d{1,2}:\d{2}/.test(str(t, 'gio')); });

  async function run() {
    setBusy('Đang chuẩn bị…');
    setOut(null);
    const log: string[] = [];
    try {
      const [r, v, s] = await Promise.all([
        supabase.from('routes').select('id, code, name, name_ve, is_active'),
        supabase.from('vehicles').select('id, plate'),
        supabase.from('staff_members').select('id, full_name, is_active'),
      ]);
      const routes = (r.data ?? []) as { id: string; code: string; name: string; name_ve: string | null; is_active: boolean }[];
      const opts = routes.flatMap((x) => (['di', 've'] as Dir[]).map((d) => ({ id: x.id, d, k: routeKey(dirName(x, d)) })));
      const vehByKey = new Map(((v.data ?? []) as { id: string; plate: string }[]).map((x) => [plateKey(x.plate), x.id]));
      const staffList = (s.data ?? []) as { id: string; full_name: string; is_active: boolean }[];
      const oldVeh = new Map(legacy.vehicles.map((x) => [str(x, 'id'), str(x, 'bks')]));
      const oldEmp = new Map(legacy.employees.map((x) => [str(x, 'id'), str(x, 'ten')]));
      const used = new Set(routes.map((x) => x.code.toUpperCase()));
      const findRoute = async (tuyen: string): Promise<{ id: string; d: Dir } | null> => {
        const k = routeKey(tuyen);
        const hit = opts.find((o) => o.k === k);
        if (hit) return { id: hit.id, d: hit.d };
        const name = titleCase(tuyen.replace(/\s*[⇄→–—]\s*|\s+-\s+/g, ' - '));
        const parts = name.split(' - ');
        if (parts.length < 2) return null;
        let code = parts.map((p) => p.split(/\s+/).map((w) => norm(w)[0]?.toUpperCase() ?? '').join('')).join('-');
        for (let i = 2; used.has(code); i++) code = `${code.replace(/\d+$/, '')}${i}`;
        used.add(code);
        const ins = await supabase.from('routes').insert({ code, name }).select('id, code, name, name_ve, is_active').single();
        if (ins.error) { log.push(`Không tạo được tuyến ${name}: ${ins.error.message}`); return null; }
        const nr = ins.data as typeof routes[number];
        routes.push(nr);
        opts.push({ id: nr.id, d: 'di', k: routeKey(dirName(nr, 'di')) }, { id: nr.id, d: 've', k: routeKey(dirName(nr, 've')) });
        log.push(`Đã tạo tuyến mới ${name}`);
        return { id: nr.id, d: 'di' };
      };
      const rows: Record<string, unknown>[] = [];
      let noRoute = 0, noVeh = 0, noDrv = 0;
      for (const t of list) {
        const rt = await findRoute(str(t, 'tuyen'));
        if (!rt) { noRoute++; continue; }
        const bks = oldVeh.get(str(t, 'xeId')) ?? '';
        const vehicle_id = bks ? vehByKey.get(plateKey(bks)) ?? null : null;
        if (bks && !vehicle_id) noVeh++;
        const ten = oldEmp.get(str(t, 'laiXe')) ?? '';
        const c = ten ? staffList.filter((x) => norm(x.full_name) === norm(ten)) : [];
        const driver_id = c.length === 1 ? c[0].id : null;
        if (ten && !driver_id) noDrv++;
        const [h, m] = str(t, 'gio').split(':');
        rows.push({ route_id: rt.id, direction: rt.d, date: str(t, 'ngay'), time: `${h.padStart(2, '0')}:${m.slice(0, 2)}`, vehicle_id, driver_id });
      }
      let created = 0, updated = 0, same = 0, skipped = 0;
      for (let i = 0; i < rows.length; i += 400) {
        setBusy(`Đang chuyển chuyến ${Math.min(i + 400, rows.length)}/${rows.length}…`);
        const res = await rpc<{ created: number; updated: number; same: number; skipped: number; errors: { date: string; time: string; error: string }[] }>(
          'import_legacy_trips', { p_rows: rows.slice(i, i + 400) });
        created += res.created; updated += res.updated; same += res.same; skipped += res.skipped;
        for (const e of res.errors) log.push(`${e.date} ${e.time}: ${e.error}`);
      }
      const msg = `Đã chuyển lịch chạy: tạo ${created} chuyến, cập nhật ${updated}, đã khớp ${same}${skipped ? `, bỏ qua ${skipped} chuyến đã xuất bến` : ''}`
        + (noRoute ? `, ${noRoute} chuyến không xác định được tuyến` : '') + (noVeh ? `, ${noVeh} chuyến không khớp xe` : '') + (noDrv ? `, ${noDrv} chuyến không khớp lái xe` : '');
      toast(log.some((l) => !l.startsWith('Đã tạo')) ? 'error' : 'ok', msg);
      setOut([msg, ...log.slice(0, 50)]);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sub form">
      <h3 className="section-title">Lịch chạy (chuyến đã điều) trong file: {legacy.trips.length} chuyến{dates.length ? `, từ ${dates[0]} đến ${dates[dates.length - 1]}` : ''}</h3>
      <p className="muted small">Chuyển xe + lái xe của từng chuyến sang Điều hành TMS (kể cả ngày đã qua). Nên bấm "Nhập dữ liệu" nhân viên và xe ở trên trước để khớp đủ xe, lái xe.
        Tuyến chưa có trong TMS sẽ được tạo. Nhập lại không trùng; chuyến đã xuất bến không bị sửa.</p>
      <div className="inline-form">
        <label>Từ ngày<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Đến ngày<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {busy && <p className="upload">{busy}</p>}
      <div className="actions"><button type="button" className="btn primary" disabled={!!busy || !list.length} onClick={() => void run()}>Chuyển {list.length} chuyến</button></div>
      {out && <ul className="queue-list small">{out.map((x, i) => <li key={i} className={i && !x.startsWith('Đã tạo') ? 'error-text' : ''}>{x}</li>)}</ul>}
    </div>
  );
}

/* ------------------------------------------------------------------ Chuyển phiếu sửa chữa + nhiên liệu từ app cũ */

function LegacyOps({ legacy }: { legacy: LegacyBackup }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<string[] | null>(null);
  const numOf = (r: Record<string, unknown>, k: string) => { const n = Number(String(r[k] ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

  async function run() {
    setBusy('Đang chuẩn bị…');
    setOut(null);
    const log: string[] = [];
    try {
      const [v, s] = await Promise.all([supabase.from('vehicles').select('id, plate, fuel_norm'), supabase.from('staff_members').select('id, full_name')]);
      const vehs = (v.data ?? []) as { id: string; plate: string; fuel_norm: number | null }[];
      const vehByKey = new Map(vehs.map((x) => [plateKey(x.plate), x.id]));
      const staff = (s.data ?? []) as { id: string; full_name: string }[];
      const drv = (name: string) => { const c = name ? staff.filter((x) => norm(x.full_name) === norm(name)) : []; return c.length === 1 ? c[0].id : null; };
      let noVeh = 0;
      const repairs = legacy.repairs.flatMap((r) => {
        const vehicle_id = vehByKey.get(plateKey(str(r, 'xe'))) ?? null;
        const d = day(str(r, 'ngay'));
        if (!vehicle_id || !d) { noVeh++; return []; }
        const items = (Array.isArray(r.items) ? r.items : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          .map((x) => ({ content: str(x, 'nd') || str(x, 'noiDung'), qty: numOf(x, 'sl') ?? 1, unit_price: Math.round(numOf(x, 'gia') ?? 0) }));
        return [{ code: str(r, 'so') || null, vehicle_id, repaired_on: d, odo_km: numOf(r, 'km'), workshop: str(r, 'donVi'), note: str(r, 'ghiChu'), items }];
      });
      const fuel = legacy.fuel.flatMap((r) => {
        const kind = str(r, 'loai') === 'nhap' ? 'nhap' : str(r, 'nguon') === 'ngoai' ? 'ngoai' : 'bon';
        const vehicle_id = kind === 'nhap' ? null : vehByKey.get(plateKey(str(r, 'xe'))) ?? null;
        const d = day(str(r, 'ngay'));
        if ((kind !== 'nhap' && !vehicle_id) || !d || !numOf(r, 'lit')) { noVeh++; return []; }
        const gia = numOf(r, 'gia');
        return [{ code: str(r, 'so') || null, kind, entry_date: d, entry_time: /^\d{1,2}:\d{2}/.test(str(r, 'gio')) ? str(r, 'gio').slice(0, 5) : null,
          vehicle_id, driver_id: drv(str(r, 'lai')), odo_km: numOf(r, 'km'), liters: numOf(r, 'lit'),
          unit_price: kind === 'bon' && r.giaAuto !== false ? null : gia == null ? (kind === 'nhap' ? 0 : null) : Math.round(gia),
          supplier: str(r, 'cayXang') || str(r, 'ncc') || str(r, 'nhaCC') || str(r, 'nhaCungCap'), invoice_no: str(r, 'soHD'), note: str(r, 'ghiChu') }];
      });
      let rep = 0, fu = 0, same = 0;
      for (let i = 0; i < Math.max(repairs.length, fuel.length); i += 400) {
        setBusy(`Đang chuyển phiếu ${Math.min(i + 400, Math.max(repairs.length, fuel.length))}…`);
        const res = await rpc<{ repairs: number; fuel: number; same: number; errors: { code: string; error: string }[] }>('import_legacy_ops',
          { p_repairs: repairs.slice(i, i + 400), p_fuel: fuel.slice(i, i + 400) });
        rep += res.repairs; fu += res.fuel; same += res.same;
        for (const e of res.errors) log.push(`${e.code}: ${e.error}`);
      }
      // Km xe theo ngày (DB.kmxe)
      const kmRows = new Map<string, { vehicle_id: string; run_date: string; km: number }>();
      for (const r of legacy.km) {
        const id = vehByKey.get(plateKey(str(r, 'bks'))), d = day(str(r, 'ngay')), km = Number(r.km);
        if (!id || !d || !Number.isFinite(km) || km < 0 || km >= 5000) continue;
        const k = `${id}|${d}`;
        kmRows.set(k, { vehicle_id: id, run_date: d, km: (kmRows.get(k)?.km ?? 0) + km });
      }
      let kmNew = 0;
      const kl = [...kmRows.values()];
      for (let i = 0; i < kl.length; i += 2000) {
        setBusy(`Đang chuyển km xe ${Math.min(i + 2000, kl.length)}/${kl.length}…`);
        const res = await rpc<{ created: number; updated: number }>('import_vehicle_km', { p_rows: kl.slice(i, i + 2000), p_source: 'app_cu' });
        kmNew += res.created + res.updated;
      }
      if (legacy.km.length && kl.length < legacy.km.length) log.push(`Km xe: ${legacy.km.length - kl.length} dòng không khớp xe / ngày (bỏ qua hoặc gộp cùng ngày)`);
      // Thiết lập bồn + định mức theo xe
      const st = legacy.fuelSet;
      if (st) {
        const cur = await supabase.from('fuel_settings').select('tenant_id').maybeSingle();
        if (!cur.data) {
          const u = await supabase.from('fuel_settings').insert({ tank_name: str(st, 'tenBon') || 'Bồn dầu công ty', fuel_type: str(st, 'loaiNL') || 'Dầu DO 0,05S',
            capacity_l: numOf(st, 'sucChua') ?? 5000, opening_l: Number(st.tonDau) || 0, opening_price: Math.round(Number(st.giaDau) || 0),
            opening_on: day(str(st, 'ngayTonDau')), alert_l: numOf(st, 'nguong') ?? 500 });
          if (u.error) log.push(`Thiết lập bồn: ${u.error.message}`);
        }
        const dm = st.dm && typeof st.dm === 'object' ? (st.dm as Record<string, unknown>) : {};
        for (const [bks, val] of Object.entries(dm)) {
          const id = vehByKey.get(plateKey(bks)), n = Number(val);
          if (id && n > 0 && n < 100 && !vehs.find((x) => x.id === id)?.fuel_norm) await supabase.from('vehicles').update({ fuel_norm: n }).eq('id', id);
        }
      }
      const msg = `Đã chuyển ${rep} phiếu sửa chữa, ${fu} phiếu nhiên liệu, ${kmNew} dòng km xe${same ? `, ${same} phiếu đã có (bỏ qua)` : ''}${noVeh ? `, ${noVeh} phiếu không khớp xe / thiếu ngày` : ''}`;
      toast(log.length ? 'error' : 'ok', msg);
      setOut([msg, ...log.slice(0, 50)]);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sub form">
      <h3 className="section-title">Sửa chữa, nhiên liệu, km xe trong file: {legacy.repairs.length} phiếu sửa chữa, {legacy.fuel.length} phiếu nhiên liệu, {legacy.km.length} dòng km</h3>
      <p className="muted small">Giữ nguyên số phiếu của app cũ, nhập lại không trùng. Kèm thiết lập bồn dầu và định mức tiêu hao từng xe (nếu TMS chưa có). Nên nhập xe ở trên trước.</p>
      {busy && <p className="upload">{busy}</p>}
      <div className="actions"><button type="button" className="btn primary" disabled={!!busy} onClick={() => void run()}>Chuyển sửa chữa, nhiên liệu, km xe</button></div>
      {out && <ul className="queue-list small">{out.map((x, i) => <li key={i} className={i ? 'error-text' : ''}>{x}</li>)}</ul>}
    </div>
  );
}
