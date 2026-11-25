// Đóng BHXH & lương chuyển khoản theo tháng (như Cài đặt của app cũ): chọn tháng, tick người đóng BHXH, nhập lương chuyển khoản
// và mức lương đóng BHXH; sửa xong tự lưu. Lưu bảng thành PDF vào Năm › Tài chính - Kế toán › BHXH & lương chuyển khoản.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MonthPicker } from './MonthPicker';
import { today } from './Documents';
import { PaperView, type Me } from './ProfilePapers';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { boss, bossCol, company, head, signCol, signImg } from '../lib/profilePapers';
import { resetFolders, savePdf } from '../lib/dispatchPapers';
import { profileChanged } from '../lib/profileAutoArchive';

interface Staff { id: string; full_name: string; is_active: boolean; left_on: string | null; joined_on: string }
interface Row { has_bhxh: boolean; transfer_pay: number; bhxh_pay: number; fixed_pay: number }
const num = (n: number) => n.toLocaleString('vi-VN');
const parse = (s: string) => Number(s.replace(/[^0-9]/g, '')) || 0;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function PayMonths({ tenantId, me, canArchive }: { tenantId: string; me: Me; canArchive: boolean }) {
  const toast = useToast();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [state, setState] = useState('');
  const [busy, setBusy] = useState('');
  const [view, setView] = useState<string | null>(null);
  const dirty = useRef<Set<string>>(new Set());
  const timer = useRef(0);

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      supabase.from('staff_members').select('id, full_name, is_active, left_on, joined_on'),
      supabase.from('staff_pay_months').select('staff_id, has_bhxh, transfer_pay, bhxh_pay, fixed_pay').eq('month', `${month}-01`),
    ]);
    if (p.error) return toast('error', p.error.message);
    setStaff(((s.data ?? []) as Staff[]).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')));
    setRows(Object.fromEntries(((p.data ?? []) as (Row & { staff_id: string })[]).map((r) => [r.staff_id, { has_bhxh: r.has_bhxh, transfer_pay: Number(r.transfer_pay), bhxh_pay: Number(r.bhxh_pay), fixed_pay: Number(r.fixed_pay) }])));
    dirty.current.clear();
  }, [month, toast]);
  useEffect(() => { void load(); }, [load]);

  // Người còn làm trong tháng: vào trước cuối tháng, chưa nghỉ trước đầu tháng
  const end = `${month}-31`;
  const list = staff.filter((s) => s.joined_on <= end && (s.is_active || (s.left_on && s.left_on >= `${month}-01`)));
  const val = (id: string): Row => rows[id] ?? { has_bhxh: false, transfer_pay: 0, bhxh_pay: 0, fixed_pay: 0 };

  const flush = useCallback(async (data: Record<string, Row>) => {
    const ids = [...dirty.current];
    if (!ids.length) return;
    dirty.current.clear();
    setState('Đang lưu…');
    try {
      await rpc('save_pay_month', { p_month: `${month}-01`, p_rows: ids.map((id) => ({ staff_id: id, ...(data[id] ?? { has_bhxh: false, transfer_pay: 0, bhxh_pay: 0, fixed_pay: 0 }) })) });
      setState('Đã lưu');
      profileChanged();   // Lưu trữ hồ sơ tự cập nhật bảng tháng này
    } catch (e) { ids.forEach((id) => dirty.current.add(id)); setState(''); toast('error', errMsg(e)); }
  }, [month, toast]);
  function change(ids: string[], f: (r: Row) => Row) {
    setRows((cur) => {
      const next = { ...cur };
      for (const id of ids) { next[id] = f(cur[id] ?? { has_bhxh: false, transfer_pay: 0, bhxh_pay: 0, fixed_pay: 0 }); dirty.current.add(id); }
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(next), 700);
      return next;
    });
  }

  async function fromPrev() {
    const [y, m] = month.split('-').map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const { data, error } = await supabase.from('staff_pay_months').select('staff_id, has_bhxh, transfer_pay, bhxh_pay, fixed_pay').eq('month', `${prev}-01`);
    if (error) return toast('error', error.message);
    const p = new Map(((data ?? []) as (Row & { staff_id: string })[]).map((r) => [r.staff_id, r]));
    const ids = list.map((s) => s.id).filter((id) => p.has(id));
    if (!ids.length) return toast('error', `Tháng ${prev.slice(5)}/${prev.slice(0, 4)} chưa có dữ liệu`);
    for (const id of ids) { const x = p.get(id)!; change([id], () => ({ has_bhxh: x.has_bhxh, transfer_pay: Number(x.transfer_pay), bhxh_pay: Number(x.bhxh_pay), fixed_pay: Number(x.fixed_pay) })); }
    toast('ok', `Đã lấy ${ids.length} người theo tháng ${prev.slice(5)}/${prev.slice(0, 4)}`);
  }

  const tot = list.reduce((a, s) => { const v = val(s.id); return { n: a.n + (v.has_bhxh ? 1 : 0), ck: a.ck + v.transfer_pay, ml: a.ml + (v.has_bhxh ? v.bhxh_pay : 0) }; }, { n: 0, ck: 0, ml: 0 });
  const [y, mo] = month.split('-');

  async function html(): Promise<string> {
    const [c, b] = await Promise.all([company(), boss(tenantId, me)]);
    const td = (v: string, al = '') => `<td style="border:1px solid #000;padding:3px 6px;${al ? `text-align:${al}` : ''}">${v}</td>`;
    const th = (v: string) => `<th style="border:1px solid #000;padding:4px 6px;background:#e2e8f0">${v}</th>`;
    return `<div style="font-size:13px">${head(c)}<h2 style="text-align:center;margin:12px 0 2px;font-size:18px">BẢNG ĐÓNG BHXH VÀ LƯƠNG CHUYỂN KHOẢN</h2>
      <div style="text-align:center;margin-bottom:8px">Tháng <b>${mo}/${y}</b> · ${esc(c.name)}</div>
      <table style="width:100%;border-collapse:collapse"><tr>${th('STT')}${th('Tháng')}${th('Tên nhân viên')}${th('Đóng BHXH')}${th('Lương chuyển khoản')}${th('Bảo hiểm xã hội')}</tr>
      ${list.map((s, i) => { const v = val(s.id); return `<tr>${td(String(i + 1), 'center')}${td(`${mo}/${y}`, 'center')}${td(esc(s.full_name))}${td(v.has_bhxh ? '☒ Có' : '☐ Không', 'center')}${td(num(v.transfer_pay), 'right')}${td(num(v.bhxh_pay), 'right')}</tr>`; }).join('')}
      <tr style="font-weight:bold">${td('')}${td('Tổng cộng')}${td('')}${td(`${tot.n} người`, 'center')}${td(num(tot.ck), 'right')}${td(num(tot.ml), 'right')}</tr></table>
      <p style="text-align:right;margin:12px 0 4px;font-style:italic">Ngày ${today().slice(8)} tháng ${today().slice(5, 7)} năm ${today().slice(0, 4)}</p>
      <table style="width:100%;border-collapse:collapse"><tr>${signCol('NGƯỜI LẬP BẢNG', '(Ký tên)', signImg(b.b.me), b.b.meName, b.b.me, 33)}${signCol('KẾ TOÁN TRƯỞNG', '(Ký tên)', '', '', null, 33)}${bossCol(b.b, 'GIÁM ĐỐC', 34)}</tr></table></div>`;
  }
  async function preview() {
    setBusy('Đang dựng bảng…');
    try { setView(await html()); } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function archive() {
    await flush(rows);
    setBusy('Đang lưu PDF vào hồ sơ…');
    try {
      resetFolders();
      await savePdf([y, 'Tài chính - Kế toán', 'BHXH & lương chuyển khoản'], `BHXH và lương chuyển khoản tháng ${mo}/${y}`, `BHXH-LuongCK-${month}.pdf`,
        [{ html: await html(), land: false }], `Bảng tháng ${mo}/${y}`, `bhxh:${month}`);
      toast('ok', `Đã lưu bảng tháng ${mo}/${y} vào hồ sơ`);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }

  return (
    <section className="card">
      <h2>Đóng BHXH &amp; lương chuyển khoản theo tháng</h2>
      <div className="actions pay-bar">
        <MonthPicker value={month} onChange={setMonth} />
        <button type="button" className="btn small" onClick={() => void fromPrev()}>Lấy theo tháng trước</button>
        <button type="button" className="btn small" onClick={() => change(list.map((s) => s.id), (r) => ({ ...r, has_bhxh: true }))}>Tick đóng BHXH tất cả</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void preview()}>Xem / in</button>
        {canArchive && <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void archive()}>Lưu hồ sơ</button>}
        {(busy || state) && <span className="small muted">{busy || state}</span>}
      </div>
      <div className="table-wrap">
        <table className="plist pay-table">
          <thead><tr><th>Tháng</th><th>Tên nhân viên</th><th>Đóng BHXH</th><th>Lương chuyển khoản</th><th>Bảo hiểm xã hội</th><th title="Tiền công tháng của nhân viên văn phòng trên Bảng chấm công">Lương cố định</th></tr></thead>
          <tbody>
            {list.map((s) => {
              const v = val(s.id);
              return (
                <tr key={s.id}>
                  <td>{mo}/{y}</td>
                  <td><b>{s.full_name}</b></td>
                  <td className="c"><input type="checkbox" aria-label={`Đóng BHXH ${s.full_name}`} checked={v.has_bhxh} onChange={(e) => change([s.id], (r) => ({ ...r, has_bhxh: e.target.checked }))} /></td>
                  <td><input className="money" inputMode="numeric" aria-label={`Lương chuyển khoản ${s.full_name}`} value={v.transfer_pay ? num(v.transfer_pay) : ''} placeholder="0"
                             onChange={(e) => change([s.id], (r) => ({ ...r, transfer_pay: parse(e.target.value) }))} /></td>
                  <td><input className="money" inputMode="numeric" aria-label={`Bảo hiểm xã hội ${s.full_name}`} value={v.bhxh_pay ? num(v.bhxh_pay) : ''} placeholder="0"
                             onChange={(e) => change([s.id], (r) => ({ ...r, bhxh_pay: parse(e.target.value) }))} /></td>
                  <td><input className="money" inputMode="numeric" aria-label={`Lương cố định ${s.full_name}`} value={v.fixed_pay ? num(v.fixed_pay) : ''} placeholder="0"
                             onChange={(e) => change([s.id], (r) => ({ ...r, fixed_pay: parse(e.target.value) }))} /></td>
                </tr>
              );
            })}
            <tr className="pay-total"><td /><td>Tổng cộng</td><td className="c">{tot.n} người</td><td className="r">{num(tot.ck)}</td><td className="r">{num(tot.ml)}</td><td /></tr>
          </tbody>
        </table>
      </div>
      {view && <PaperView title={`BHXH & lương chuyển khoản tháng ${mo}/${y}`} pages={[{ html: view, land: false }]} onClose={() => setView(null)} />}
    </section>
  );
}
