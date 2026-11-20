// Chuyển thêm từ app cũ: giờ chạy cố định, bảng giá vé, lý lịch hành nghề lái xe, hợp đồng vận chuyển.
// Mọi thao tác qua hàm có kiểm tra quyền; nhập lại không trùng (giờ đã có, lý lịch cùng mã, hợp đồng cùng số được bỏ qua).
import { useState } from 'react';
import { today } from '../components/Documents';
import { day, plateKey, stableId, str, type LegacyBackup } from '../lib/legacyImport';
import { dirName, type Dir } from '../lib/routes';
import { norm, routeKey, titleCase } from '../lib/scheduleImport';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Raw = Record<string, unknown>;
interface Route { id: string; code: string; name: string; name_ve: string | null; is_active: boolean }

/** Tìm tuyến TMS theo tên tuyến app cũ ("A ⇄ B"), cả chiều về; chưa có thì tạo tuyến mới. */
export function routeFinder(routes: Route[], log: string[]) {
  const opts = routes.flatMap((x) => (['di', 've'] as Dir[]).map((d) => ({ id: x.id, d, k: routeKey(dirName(x, d)) })));
  const used = new Set(routes.map((x) => x.code.toUpperCase()));
  return async (tuyen: string): Promise<{ id: string; d: Dir } | null> => {
    const k = routeKey(tuyen);
    const hit = opts.find((o) => o.k === k);
    if (hit) return { id: hit.id, d: hit.d };
    const name = titleCase(tuyen.replace(/\s*[⇄→–—]\s*|\s+-\s+|\s*<>\s*/g, ' - '));
    const parts = name.split(' - ');
    if (parts.length < 2) return null;
    let code = parts.map((p) => p.split(/\s+/).map((w) => norm(w)[0]?.toUpperCase() ?? '').join('')).join('-');
    for (let i = 2; used.has(code); i++) code = `${code.replace(/\d+$/, '')}${i}`;
    used.add(code);
    const ins = await supabase.from('routes').insert({ code, name }).select('id, code, name, name_ve, is_active').single();
    if (ins.error) { log.push(`Không tạo được tuyến ${name}: ${ins.error.message}`); return null; }
    const nr = ins.data as Route;
    opts.push({ id: nr.id, d: 'di', k: routeKey(dirName(nr, 'di')) }, { id: nr.id, d: 've', k: routeKey(dirName(nr, 've')) });
    log.push(`Đã tạo tuyến mới ${name} (cần khai điểm dừng, thời gian chạy ở mục Tuyến)`);
    return { id: nr.id, d: 'di' };
  };
}

const stopKey = (s: string) => norm(s).replace(/^(ben xe|bx|van phong|vp|tram)\s+/, '').trim();
const objs = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === 'object') : []);
const hhmm = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s.trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const DAYS: Record<string, { day_rule: string; days?: number[] }> = {
  '': { day_rule: 'thu', days: [1, 2, 3, 4, 5, 6, 7] }, chan: { day_rule: 'chan' }, le: { day_rule: 'le' },
  t26: { day_rule: 'thu', days: [1, 2, 3, 4, 5] }, t7cn: { day_rule: 'thu', days: [6, 7] },
};

export function LegacyMore({ legacy, tenantId }: { legacy: LegacyBackup; tenantId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<string[] | null>(null);
  const [pick, setPick] = useState({ gio: legacy.schedules.length > 0, gia: legacy.fares.length > 0, ll: legacy.records.length > 0, hd: legacy.charters.length > 0, cc: false });

  async function run() {
    setBusy('Đang chuẩn bị…');
    setOut(null);
    const log: string[] = [], sum: string[] = [];
    try {
      const [r, v, s, st] = await Promise.all([
        supabase.from('routes').select('id, code, name, name_ve, is_active'),
        supabase.from('vehicles').select('id, plate'),
        supabase.from('staff_members').select('id, full_name'),
        supabase.from('tenant_settings').select('value').eq('key', 'lenh.hau_to').maybeSingle(),
      ]);
      const findRoute = routeFinder((r.data ?? []) as Route[], log);
      const vehByKey = new Map(((v.data ?? []) as { id: string; plate: string }[]).map((x) => [plateKey(x.plate), x.id]));
      const oldVeh = new Map(legacy.vehicles.map((x) => [str(x, 'id'), str(x, 'bks')]));
      const staff = (s.data ?? []) as { id: string; full_name: string }[];
      const oldEmp = new Map(legacy.employees.map((x) => [str(x, 'id'), str(x, 'ten')]));
      const staffOf = (oldId: string) => {
        const ten = oldEmp.get(oldId) ?? oldId;
        const c = ten ? staff.filter((x) => norm(x.full_name) === norm(ten)) : [];
        return c.length === 1 ? c[0].id : null;
      };
      const vehOf = (oldId: string) => { const b = oldVeh.get(oldId) ?? ''; return b ? vehByKey.get(plateKey(b)) ?? null : null; };
      const now = today();

      // ---------------------------------------------------------------- Giờ chạy cố định
      if (pick.gio) {
        setBusy('Đang chuyển giờ chạy…');
        const lich = (legacy.settings?.gcLich && typeof legacy.settings.gcLich === 'object' ? legacy.settings.gcLich : {}) as Record<string, Raw>;
        const groups = new Map<string, { route: string; d: Dir; tuyen: string; items: Raw[] }>();
        for (const g of legacy.schedules) {
          const tuyen = str(g, 'tuyen'), gio = hhmm(str(g, 'gio'));
          if (!tuyen || !gio) continue;
          if (str(lich[tuyen] ?? {}, 'tt') === 'ngung') continue;
          const rt = await findRoute(tuyen);
          if (!rt) { log.push(`Giờ ${gio} tuyến "${tuyen}": không xác định được tuyến`); continue; }
          const k = `${rt.id}|${rt.d}`;
          if (!groups.has(k)) groups.set(k, { route: rt.id, d: rt.d, tuyen, items: [] });
          groups.get(k)!.items.push({ depart_time: gio, ...(DAYS[str(g, 'ngayChay')] ?? DAYS['']) });
        }
        const ex = await supabase.from('schedules').select('route_id, direction, depart_time').eq('is_active', true);
        const have = new Set(((ex.data ?? []) as { route_id: string; direction: string; depart_time: string }[]).map((x) => `${x.route_id}|${x.direction}|${x.depart_time.slice(0, 5)}`));
        let saved = 0, same = 0;
        for (const g of groups.values()) {
          const seen = new Set<string>();
          const items = g.items.filter((i) => {
            const k = `${g.route}|${g.d}|${i.depart_time}`;
            if (have.has(k) || seen.has(String(i.depart_time))) { same++; return false; }
            seen.add(String(i.depart_time));
            return true;
          });
          if (!items.length) continue;
          const L = lich[g.tuyen] ?? {};
          const from = [now, day(str(L, 'tu')) ?? ''].sort().pop()!;
          const to = day(str(L, 'den'));
          if (to && to < from) continue;
          try {
            const res = await rpc<{ saved: number }>('save_timetable', { p_route_id: g.route, p_direction: g.d, p_valid_from: from, p_valid_to: to, p_note: 'Nhập từ app cũ', p_items: items, p_stop_ids: [] });
            saved += res.saved;
          } catch (e) { log.push(`Giờ chạy ${g.tuyen}: ${errMsg(e)}`); }
        }
        sum.push(`${saved} giờ chạy${same ? ` (${same} giờ đã có)` : ''}`);
      }

      // ---------------------------------------------------------------- Bảng giá vé (bảng đang áp dụng của từng tuyến)
      if (pick.gia) {
        setBusy('Đang chuyển bảng giá vé…');
        const cur = new Map<string, Raw>();
        for (const b of legacy.fares) {
          const t = str(b, 'tuyen'), tu = day(str(b, 'tuNgay')) ?? '', den = day(str(b, 'denNgay'));
          if (!t || tu > now || (den && den < now)) continue;
          const o = cur.get(t);
          if (!o || tu > (day(str(o, 'tuNgay')) ?? '')) cur.set(t, b);
        }
        let n = 0;
        const done = new Set<string>();
        for (const [tuyen, b] of cur) {
          const rt = await findRoute(tuyen);
          if (!rt) { log.push(`Giá tuyến "${tuyen}": không xác định được tuyến`); continue; }
          const rs = await supabase.from('route_stops').select('seq, stop_id, stops(name)').eq('route_id', rt.id).order('seq');
          const stops = ((rs.data ?? []) as unknown as { seq: number; stop_id: string; stops: { name: string } | null }[]).map((x) => ({ id: x.stop_id, k: stopKey(x.stops?.name ?? '') }));
          const find = (name: string) => { const k = stopKey(name); return k ? stops.find((x) => x.k === k || x.k.includes(k) || k.includes(x.k)) ?? null : null; };
          const chang = objs(b.chang);
          for (const c of chang) {
            const gia = Math.round(Number(String(c.gia ?? '').replace(/[^\d]/g, '')));
            if (!gia) continue;
            const a = find(str(c, 'don')), z = find(str(c, 'tra'));
            const ends = stops.length >= 2 && a && z && new Set([a.id, z.id]).size === 2 && [a.id, z.id].includes(stops[0].id) && [a.id, z.id].includes(stops[stops.length - 1].id);
            const whole = ends || chang.length === 1;
            const key = whole ? `${rt.id}|all` : a && z ? `${rt.id}|${[a.id, z.id].sort().join('|')}` : '';
            if (!key || done.has(key) || (!whole && a?.id === z?.id)) {
              if (!key) log.push(`Giá ${str(c, 'don')} – ${str(c, 'tra')} (${tuyen}): chưa có điểm này trên tuyến`);
              continue;
            }
            try {
              await rpc('set_fare', { p_route_id: rt.id, p_from_stop: whole ? null : a!.id, p_to_stop: whole ? null : z!.id, p_price: gia, p_effective_from: now });
              done.add(key);
              n++;
            } catch (e) { log.push(`Giá ${str(c, 'don')} – ${str(c, 'tra')} (${tuyen}): ${errMsg(e)}`); }
          }
        }
        sum.push(`${n} giá vé`);
      }

      // ---------------------------------------------------------------- Lý lịch hành nghề lái xe
      if (pick.ll) {
        setBusy('Đang chuyển lý lịch hành nghề…');
        let n = 0, miss = 0;
        for (const x of legacy.records) {
          const staffId = staffOf(str(x, 'lai')), d = day(str(x, 'ngay'));
          if (!staffId || !d || d > now) { miss++; continue; }
          const loai = str(x, 'loai');
          const m = loai === 'sk' ? { kind: 'suc_khoe', title: str(x, 'tt') || 'Khám sức khỏe', data: { co_so: str(x, 'noi') || null, het_han: day(str(x, 'hetHan')) } }
            : loai === 'vp' ? { kind: 'vi_pham', title: str(x, 'loi') || 'Vi phạm', data: { hinh_thuc: str(x, 'xuLy') || null, ghi_chu: str(x, 'ghiChu') || null } }
            : loai === 'kt' ? { kind: /kỷ luật/i.test(str(x, 'hinhThuc')) ? 'ky_luat' : 'khen_thuong', title: str(x, 'noiDung') || str(x, 'hinhThuc') || 'Khen thưởng', doc: str(x, 'soQD'), data: {} }
            : loai === 'tn' ? { kind: 'tai_nan', title: str(x, 'nguyenNhan') || 'Tai nạn giao thông', plate: str(x, 'xe'), data: { dia_diem: str(x, 'diaDiem') || null, thiet_hai: str(x, 'thietHai') || null } }
            : loai === 'th' ? { kind: 'dao_tao', title: str(x, 'noiDung') || 'Tập huấn nghiệp vụ', data: { co_so: str(x, 'donVi') || null, het_han: day(str(x, 'hetHan')) } }
            : null;
          if (!m) { miss++; continue; }
          try {
            await rpc('save_staff_record', { p_id: null, p_staff_id: staffId, p_kind: m.kind, p_occurred_on: d, p_doc_no: ('doc' in m ? m.doc : '') || null,
              p_title: m.title, p_plate: ('plate' in m ? m.plate : '') || null, p_data: m.data, p_files: [], p_request_id: await stableId(tenantId, 'lylich', str(x, 'id') || `${staffId}|${loai}|${d}`) });
            n++;
          } catch (e) { log.push(`Lý lịch ${oldEmp.get(str(x, 'lai')) ?? ''} ${d}: ${errMsg(e)}`); }
        }
        sum.push(`${n} dòng lý lịch${miss ? ` (${miss} dòng không khớp lái xe / thiếu ngày)` : ''}`);
      }

      // ---------------------------------------------------------------- Hợp đồng vận chuyển
      if (pick.hd) {
        setBusy('Đang chuyển hợp đồng vận chuyển…');
        const suffix = typeof st.data?.value === 'string' && st.data.value ? `-${st.data.value}` : '';
        const at = (d: string | null, t: string) => (d ? new Date(`${d}T${hhmm(t) ?? '00:00'}:00+07:00`).toISOString() : null);
        const rows = legacy.charters.flatMap((c) => {
          const so = str(c, 'so'), name = str(c, 'bBTen'), d0 = day(str(c, 'ngayDon')) ?? day(str(c, 'ngayKy'));
          if (!so || !name || !d0) { log.push(`Hợp đồng ${so || '?'}: thiếu số, bên thuê hoặc ngày đón`); return []; }
          const start = at(d0, str(c, 'gioDon'))!;
          let end = at(day(str(c, 'ngayTra')), str(c, 'gioTra') || '23:59');
          if (!end || end <= start) end = new Date(new Date(start).getTime() + 12 * 3600e3).toISOString();
          const [a, b] = str(c, 'hanhTrinh').split(/\s+(?:đi|→|-|–)\s+/i);
          const pax = str(c, 'dsKhach').split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').split(/\s*[|\t]\s*/)).filter((p) => p[0]?.trim())
            .map((p) => { const y = p.find((v) => /^(19|20)\d{2}$/.test(v.trim()) && Number(v) <= 2100); const ph = p.find((v) => /^0\d{9}$/.test(v.replace(/\D/g, ''))); return { full_name: p[0].trim(), birth_year: y ? Number(y) : null, phone: ph ? ph.replace(/\D/g, '') : null }; });
          const phone = str(c, 'bBSdt').replace(/\D/g, '').replace(/^84/, '0');
          return [{
            contract_no: so.includes('/') ? so : `${so}/HĐVC${suffix}`, signed_on: day(str(c, 'ngayKy')), customer_name: name,
            customer_phone: /^0\d{9}$/.test(phone) ? phone : null, customer_tax_code: str(c, 'bBMst'), customer_address: str(c, 'bBDiaChi'), customer_email: str(c, 'bBEmail'),
            pickup_place: str(c, 'diemDon') || a || str(c, 'hanhTrinh') || '—', destination: str(c, 'diemTra') || b || str(c, 'hanhTrinh') || '—', itinerary: str(c, 'hanhTrinh'),
            start_at: start, end_at: end, pax_count: Math.min(100, Math.max(1, Number(str(c, 'soKhach')) || pax.length || 1)), vehicle_id: vehOf(str(c, 'xeId')),
            driver1_id: staffOf(str(c, 'laiXe1')), driver2_id: staffOf(str(c, 'laiXe2')), price: Math.round(Number(String(c.giaTri ?? '').replace(/[^\d]/g, '')) || 0),
            distance_km: Math.round(Number(str(c, 'cuLy'))) || null, payment_terms: str(c, 'hinhThucTT'), toll_by: /^[AB]$/.test(str(c, 'cpCauDuong')) ? str(c, 'cpCauDuong') : null,
            meals_by: /^[AB]$/.test(str(c, 'cpAnNghi')) ? str(c, 'cpAnNghi') : null, attendant: str(c, 'nvPhucVu'), round_trip: c.khuHoi !== false, note: 'Nhập từ app cũ',
            passengers: pax.slice(0, 100),
          }];
        });
        let c = 0, same = 0;
        for (let i = 0; i < rows.length; i += 200) {
          const res = await rpc<{ created: number; same: number; errors: { code: string; error: string }[] }>('import_legacy_charters', { p_rows: rows.slice(i, i + 200) });
          c += res.created; same += res.same;
          for (const e of res.errors) log.push(`Hợp đồng ${e.code}: ${e.error}`);
        }
        sum.push(`${c} hợp đồng${same ? ` (${same} đã có)` : ''}`);
      }

      // ---------------------------------------------------------------- Dữ liệu chấm công (như app cũ)
      if (pick.cc) {
        setBusy('Đang chuyển dữ liệu chấm công…');
        let nx = 0, nv = 0, np = 0;
        const num = (v: unknown) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
        // Tiền tài của xe: chỉ điền xe đang để 0
        for (const x of legacy.vehicles) {
          const tt = num(x.tienTai), id = vehOf(str(x, 'id'));
          if (!tt || !id) continue;
          const up = await supabase.from('vehicles').update({ driver_pay: Math.round(tt) }, { count: 'exact' }).eq('id', id).eq('driver_pay', 0);
          if (up.error) log.push(`Tiền tài xe ${str(x, 'bks')}: ${up.error.message}`); else if (up.count) nx++;
        }
        // Phòng ban: chỉ điền người đang trống
        for (const x of legacy.employees) {
          const pb = str(x, 'phongBan'), id = staffOf(str(x, 'id'));
          if (!pb || !id) continue;
          try { await rpc('set_staff_department', { p_id: id, p_department: pb }); nv++; } catch (e) { log.push(`Phòng ban ${str(x, 'ten')}: ${errMsg(e)}`); }
        }
        // BHXH & lương CK theo tháng (+ lương cố định); tháng đã có dòng của người đó trong TMS thì giữ nguyên
        const bt = (legacy.settings?.bhxhThang && typeof legacy.settings.bhxhThang === 'object' ? legacy.settings.bhxhThang : {}) as Record<string, Record<string, Raw>>;
        const cur = now.slice(0, 7);
        for (const ym of [...new Set([...Object.keys(bt), cur])].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort()) {
          const ex = await supabase.from('staff_pay_months').select('staff_id').eq('month', `${ym}-01`);
          if (ex.error) { log.push(`BHXH & lương tháng ${ym}: ${ex.error.message}`); break; }
          const have = new Set(((ex.data ?? []) as { staff_id: string }[]).map((r) => r.staff_id));
          const rows: { staff_id: string; has_bhxh: boolean; transfer_pay: number; bhxh_pay: number; fixed_pay: number }[] = [];
          for (const x of legacy.employees) {
            const id = staffOf(str(x, 'id'));
            if (!id || have.has(id) || rows.some((r) => r.staff_id === id)) continue;
            const rc = bt[ym]?.[str(x, 'id')], cb = num(x.luongCB), lb = num(x.luongBH), fixed = num(x.luongCoDinh);
            if (!rc && (ym !== cur || (!cb && !lb && !fixed))) continue;
            const has = rc ? (rc.bh != null ? !!rc.bh : lb > 0) : lb > 0;
            rows.push({ staff_id: id, has_bhxh: has, transfer_pay: rc && rc.ck != null ? num(rc.ck) : cb,
              bhxh_pay: has ? (rc && rc.ml != null ? num(rc.ml) : lb || cb) : 0, fixed_pay: fixed });
          }
          if (!rows.length) continue;
          try { np += await rpc<number>('save_pay_month', { p_month: `${ym}-01`, p_rows: rows }); } catch (e) { log.push(`BHXH & lương tháng ${ym}: ${errMsg(e)}`); break; }
        }
        // Cài đặt: công/chuyến theo tuyến, % chi phí khác lái xe, công chuẩn, tạm dừng BHXH 14 ngày
        const S = legacy.settings ?? {}, p: Record<string, unknown> = {};
        const co = (S.company && typeof S.company === 'object' ? S.company : {}) as Raw;
        if (str(co, 'cpKhacLX') !== '') p.cp_khac_lx = Math.min(100, Math.max(0, num(co.cpKhacLX)));
        if (num(S.congChuan) >= 1 && num(S.congChuan) <= 31) p.cong_chuan = Math.round(num(S.congChuan));
        const nr = (S.noRule && typeof S.noRule === 'object' ? S.noRule : {}) as Raw;
        if (typeof nr.bh14 === 'boolean') p.bh14 = nr.bh14;
        const ct = (S.congTuyen && typeof S.congTuyen === 'object' ? S.congTuyen : {}) as Record<string, unknown>;
        if (Object.keys(ct).length) {
          const rts = (r.data ?? []) as Route[];
          const opts = rts.flatMap((x) => (['di', 've'] as Dir[]).map((dd) => ({ id: x.id, d: dd, k: routeKey(dirName(x, dd)) })));
          const st0 = await supabase.from('tenant_settings').select('value').eq('key', 'cham_cong.cong_tuyen').maybeSingle();
          const map: Record<string, number> = { ...((st0.data?.value && typeof st0.data.value === 'object' ? st0.data.value : {}) as Record<string, number>) };
          for (const [k, v] of Object.entries(ct)) {
            if (v === '' || v == null || num(v) < 0 || num(v) > 10) continue;
            const hit = opts.find((o) => o.k === routeKey(k));
            if (!hit) { log.push(`Công/chuyến tuyến "${k}": chưa có tuyến này trong TMS`); continue; }
            map[k.includes('⇄') ? hit.id : `${hit.id}|${hit.d}`] = num(v);
          }
          p.cong_tuyen = map;
        }
        if (Object.keys(p).length) { try { await rpc('save_timesheet_settings', { p }); } catch (e) { log.push(`Cài đặt chấm công: ${errMsg(e)}`); } }
        sum.push(`chấm công: tiền tài ${nx} xe, phòng ban ${nv} người, ${np} dòng BHXH & lương theo tháng${Object.keys(p).length ? ', cài đặt chấm công' : ''}`);
      }

      const msg = `Đã chuyển: ${sum.join(', ')}`;
      toast(log.some((l) => !l.startsWith('Đã tạo')) ? 'error' : 'ok', msg);
      setOut([msg, ...log.slice(0, 60)]);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const items: [keyof typeof pick, string, number][] = [
    ['gio', 'Giờ chạy cố định', legacy.schedules.length], ['gia', 'Bảng giá vé', legacy.fares.length],
    ['ll', 'Lý lịch hành nghề lái xe', legacy.records.length], ['hd', 'Hợp đồng vận chuyển', legacy.charters.length],
    ['cc', 'Dữ liệu chấm công (tiền tài xe, phòng ban, lương cố định, BHXH & lương CK theo tháng, công/chuyến theo tuyến)', legacy.employees.length + legacy.vehicles.length],
  ];
  return (
    <div className="sub form">
      <h3 className="section-title">Giờ chạy, giá vé, lý lịch, hợp đồng, chấm công</h3>
      <p className="muted small">Nên chuyển nhân viên và xe ở trên trước. Giờ chạy áp dụng từ hôm nay (giờ đã có bỏ qua). Giá vé lấy bảng giá đang áp dụng, áp dụng từ hôm nay; chặng nào chưa có điểm dừng trên tuyến sẽ báo để khai thêm.
        Hợp đồng đã qua ghi là Xong, hợp đồng sắp tới ở trạng thái Nháp để kiểm tra rồi ký; không ghi tiền vào sổ.</p>
      {items.map(([k, l, n]) => (
        <label key={k} className="check"><input type="checkbox" checked={pick[k]} disabled={!n} onChange={(e) => setPick({ ...pick, [k]: e.target.checked })} /> {l}: {n}</label>
      ))}
      {busy && <p className="upload">{busy}</p>}
      <div className="actions"><button type="button" className="btn primary" disabled={!!busy || !Object.values(pick).some(Boolean)} onClick={() => void run()}>Chuyển mục đã chọn</button></div>
      {out && <ul className="queue-list small">{out.map((x, i) => <li key={i} className={i && !x.startsWith('Đã tạo') ? 'error-text' : ''}>{x}</li>)}</ul>}
    </div>
  );
}
