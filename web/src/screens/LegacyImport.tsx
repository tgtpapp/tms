// Nhập dữ liệu từ app cũ: chọn file sao lưu .json → xem trước → nhập nhân viên, xe và giấy tờ.
// Nhập lại không trùng (id cố định theo mã cũ, khớp CCCD / SĐT / tên / biển số). Dữ liệu đã có trong TMS được giữ nguyên.
import { useState } from 'react';
import { today } from '../components/Documents';
import { uploadFiles } from '../lib/documents';
import {
  mapEmployee, mapVehicle, normName, parseBackup, PLATE_OK, plateKey, stableId, type LegacyDoc, type StaffRow, type VehicleRow,
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

  async function choose(file: File | undefined) {
    if (!file) return;
    setResult(null);
    setBusy('Đang đọc file…');
    try {
      const backup = parseBackup(await file.text());
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
        guess[v.group] = hit.length === 1 ? hit[0].id : '';
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
    let staffNew = 0, vehNew = 0, docs = 0;
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
        for (const v of plan.vehicles) {
          setBusy(`Đang nhập ${++i}/${total}: xe ${v.plate}`);
          if (v.bad) {
            log.push(`Xe ${v.plate}: ${v.bad}, bỏ qua`);
            continue;
          }
          try {
            if (!v.match) {
              const { error } = await supabase.from('vehicles').insert({ id: v.id, ...v.vehicle, vehicle_type_id: typeOf[v.group] });
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
    const msg = `Đã nhập ${staffNew} nhân viên, ${vehNew} xe, ${docs} giấy tờ`;
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
              {plan.ex.types.length === 0 && <p className="error-text small">Chưa có loại xe trong TMS: vào mục Xe tạo loại xe trước.</p>}
              {groups.map(([g, label]) => (
                <label key={g}>Loại xe TMS cho xe cũ "{label}"
                  <select aria-label={`Loại xe cho ${label}`} value={typeOf[g] ?? ''} onChange={(e) => setTypeOf({ ...typeOf, [g]: e.target.value })}>
                    <option value="">Chọn loại xe</option>
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
      {result && (
        <ul className="queue-list small">
          {result.map((r, i) => <li key={i} className={i ? 'error-text' : ''}>{r}</li>)}
        </ul>
      )}
    </section>
  );
}
