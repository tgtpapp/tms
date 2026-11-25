// In phiếu sửa chữa phương tiện khổ A4 (như app cũ): đầu trang công ty, số xe, lái xe, bảng hạng mục có ĐVT,
// tổng tiền + bằng chữ, chữ ký Người lập phiếu (ảnh chữ ký nếu có) · Lái xe · Giám đốc.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { companyFileUrl } from '../lib/documents';
import { loadSigns, showName, type Sign } from '../lib/signatures';
import { supabase } from '../lib/supabase';
import { moneyWords } from '../lib/vnWords';
import { toDataUrl } from '../lib/pdfMaker';

export interface RepairPrintOrder {
  id: string; code: string; vehicle_id: string; plate: string; repaired_on: string; odo_km: number | null; workshop: string | null; note: string | null; created_by: string | null;
  items: { content: string; unit: string | null; qty: number; unit_price: number }[];
}
interface Info { co: { name: string; address: string; phone: string; tax: string }; logo: string | null; driver: string; driverSign: Sign | null; maker: string; sign: Sign | null }

const money = (n: number) => n.toLocaleString('vi-VN');
const dmy = (d: string) => d.split('-').reverse().join('/');
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function loadInfo(o: RepairPrintOrder, tenantId: string, me: { id: string | null; name: string }, asData = false): Promise<Info> {
  const [tn, logo, tr, mk] = await Promise.all([
    supabase.from('tenants').select('name, legal_name, address, phone, tax_code').maybeSingle(),
    companyFileUrl(tenantId, 'logo.png').catch(() => null),
    // lái xe: lái xe 1 của chuyến gần nhất của xe trong 7 ngày tính đến ngày sửa
    supabase.from('trips').select('id').eq('vehicle_id', o.vehicle_id).neq('status', 'huy').lte('service_date', o.repaired_on).gte('service_date', addDays(o.repaired_on, -7))
      .order('service_date', { ascending: false }).order('depart_at', { ascending: false }).limit(1),
    o.created_by ? supabase.from('staff_members').select('id, full_name').eq('user_id', o.created_by).limit(1) : Promise.resolve({ data: [] }),
  ]);
  const t = (tn.data ?? {}) as { name?: string; legal_name?: string | null; address?: string | null; phone?: string | null; tax_code?: string | null };
  let driver = '', driverSign: Sign | null = null;
  const tid = ((tr.data ?? []) as { id: string }[])[0]?.id;
  if (tid) {
    const c = await supabase.from('trip_crew').select('staff_id').eq('trip_id', tid).eq('role', 'lai_xe_1').eq('active', true).limit(1);
    const sid = ((c.data ?? []) as { staff_id: string }[])[0]?.staff_id;
    if (sid) {
      const dr = (((await supabase.from('staff_members').select('full_name, user_id').eq('id', sid).limit(1)).data ?? []) as { full_name: string; user_id: string | null }[])[0];
      driver = dr?.full_name ?? '';
      // chữ ký lái xe: chữ ký lưu theo hồ sơ nhân viên, chưa có thì theo tài khoản đăng nhập
      const keys = [`nv_${sid}`, dr?.user_id ?? null];
      const m = await loadSigns(tenantId, keys, asData).catch(() => new Map<string, Sign>());
      driverSign = keys.map((k) => (k ? m.get(k) : undefined)).find((x) => x?.img) ?? null;
    }
  }
  const st = ((mk.data ?? []) as { id: string; full_name: string }[])[0];
  const maker = st?.full_name ?? (o.created_by && o.created_by === me.id ? me.name : '');
  let sign: Sign | null = null;
  if (st || o.created_by) {
    const keys = [st ? `nv_${st.id}` : null, o.created_by];
    const m = await loadSigns(tenantId, keys, asData).catch(() => new Map<string, Sign>());
    sign = keys.map((k) => (k ? m.get(k) : undefined)).find((x) => x?.img) ?? null;
  }
  return { co: { name: t.legal_name || t.name || '', address: t.address ?? '', phone: t.phone ?? '', tax: t.tax_code ?? '' }, logo, driver, driverSign, maker, sign };
}

const esc = (t: unknown) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Phiếu sửa chữa dạng HTML (ảnh logo, chữ ký nhúng sẵn) để lưu PDF vào Lưu trữ hồ sơ – cùng nội dung bản in */
export async function repairPaperHtml(o: RepairPrintOrder, tenantId: string, me: { id: string | null; name: string }): Promise<string> {
  const info = await loadInfo(o, tenantId, me, true);
  const logo = await toDataUrl(info.logo).catch(() => null);
  const total = o.items.reduce((a, i) => a + Number(i.qty) * Number(i.unit_price), 0);
  const now = new Date();
  const td = 'border:1px solid #333;padding:6px';
  return `<div style="display:flex;gap:12px;align-items:center">${logo ? `<img src="${logo}" alt="" style="max-height:60px;max-width:120px">` : ''}
    <div><b>${esc(info.co.name.toUpperCase())}</b>${info.co.address ? `<div>${esc(info.co.address)}</div>` : ''}<div>${esc([info.co.phone && `ĐT: ${info.co.phone}`, info.co.tax && `MST: ${info.co.tax}`].filter(Boolean).join(' · '))}</div></div></div>
    <h2 style="text-align:center;margin:14px 0 2px;font-size:20px">PHIẾU SỬA CHỮA PHƯƠNG TIỆN</h2>
    <div style="text-align:center">Số phiếu: <b>${esc(o.code)}</b> · Ngày: <b>${dmy(o.repaired_on)}</b></div>
    <div style="margin:10px 0;font-size:14px">Số xe: <b>${esc(o.plate)}</b> &nbsp;·&nbsp; Lái xe: <b>${esc(info.driver) || '..............................'}</b>${o.odo_km ? ` &nbsp;·&nbsp; Số km: <b>${money(o.odo_km)}</b>` : ''}${o.workshop ? ` &nbsp;·&nbsp; Gara: <b>${esc(o.workshop)}</b>` : ''}</div>
    <table style="width:100%;border-collapse:collapse;font-size:13.5px"><tr>${['STT', 'Nội dung sửa chữa', 'ĐVT', 'SL', 'Đơn giá', 'Thành tiền'].map((h, i) => `<th style="${td};text-align:${i > 2 ? 'right' : 'left'}">${h}</th>`).join('')}</tr>
    ${o.items.map((i, k) => `<tr><td style="${td};width:36px">${k + 1}</td><td style="${td}">${esc(i.content)}</td><td style="${td}">${esc(i.unit ?? '')}</td><td style="${td};text-align:right">${Number(i.qty).toLocaleString('vi-VN')}</td><td style="${td};text-align:right">${money(Number(i.unit_price))}</td><td style="${td};text-align:right">${money(Number(i.qty) * Number(i.unit_price))}</td></tr>`).join('')}
    <tr><td colspan="5" style="${td};text-align:right"><b>Tổng cộng</b></td><td style="${td};text-align:right"><b>${money(total)}</b></td></tr></table>
    <div style="margin-top:8px">Bằng chữ: <b>${total > 0 ? esc(moneyWords(total)) : 'Không đồng'}</b>.${o.note ? ` Ghi chú: ${esc(o.note)}` : ''}</div>
    <div style="text-align:right;margin-top:16px;font-style:italic">Ngày ${now.getDate()} tháng ${now.getMonth() + 1} năm ${now.getFullYear()}</div>
    <table style="width:100%;margin-top:6px;border-collapse:collapse"><tr>${([['Người lập phiếu', info.maker, info.sign], ['Lái xe', info.driver, info.driverSign], ['Giám đốc', '', null]] as [string, string, Sign | null][]).map(([t, n, sg]) =>
      `<td style="width:33%;text-align:center;vertical-align:top"><b>${t}</b><br><i style="font-size:12px">(Ký, ghi rõ họ tên)</i><div style="height:68px;display:flex;align-items:center;justify-content:center">${sg?.img ? `<img src="${sg.img}" alt="" style="max-height:64px;max-width:170px">` : ''}</div><b>${showName(sg) ? esc(n) : ''}</b></td>`).join('')}</tr></table>`;
}

export function RepairPrint({ order, tenantId, me, onClose }: { order: RepairPrintOrder; tenantId: string; me: { id: string | null; name: string }; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => { let on = true; void loadInfo(order, tenantId, me).then((x) => { if (on) setInfo(x); }); return () => { on = false; }; }, [order, tenantId, me.id, me.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = order.items.reduce((a, i) => a + Number(i.qty) * Number(i.unit_price), 0);
  const now = new Date();
  const td = { border: '1px solid #333', padding: '6px' } as const;
  return createPortal(
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>Phiếu sửa chữa {order.code}</b>
        <button className="btn small primary" disabled={!info} onClick={() => window.print()}>In</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      {!info ? <p className="muted">Đang chuẩn bị phiếu…</p> : (
        <div className="lenh rp-print">
          <div className="rp-head">
            {info.logo && <img src={info.logo} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
            <div className="rp-co">
              <b>{info.co.name.toUpperCase()}</b>
              {info.co.address && <div>{info.co.address}</div>}
              <div>{[info.co.phone && `ĐT: ${info.co.phone}`, info.co.tax && `MST: ${info.co.tax}`].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
          <h2 className="c" style={{ margin: '14px 0 2px', fontSize: 20 }}>PHIẾU SỬA CHỮA PHƯƠNG TIỆN</h2>
          <div className="c">Số phiếu: <b>{order.code}</b> · Ngày: <b>{dmy(order.repaired_on)}</b></div>
          <div style={{ margin: '10px 0', fontSize: 14 }}>
            Số xe: <b>{order.plate}</b> &nbsp;·&nbsp; Lái xe: <b>{info.driver || '..............................'}</b>
            {order.odo_km ? <> &nbsp;·&nbsp; Số km: <b>{money(order.odo_km)}</b></> : null}
            {order.workshop ? <> &nbsp;·&nbsp; Gara: <b>{order.workshop}</b></> : null}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead><tr>{['STT', 'Nội dung sửa chữa', 'ĐVT', 'SL', 'Đơn giá', 'Thành tiền'].map((h, i) => <th key={h} style={{ ...td, textAlign: i > 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
            <tbody>
              {order.items.map((i, k) => (
                <tr key={k}>
                  <td style={{ ...td, width: 36 }}>{k + 1}</td><td style={td}>{i.content}</td><td style={td}>{i.unit ?? ''}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{Number(i.qty).toLocaleString('vi-VN')}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(Number(i.unit_price))}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(Number(i.qty) * Number(i.unit_price))}</td>
                </tr>
              ))}
              <tr><td colSpan={5} style={{ ...td, textAlign: 'right' }}><b>Tổng cộng</b></td><td style={{ ...td, textAlign: 'right' }}><b>{money(total)}</b></td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>Bằng chữ: <b>{total > 0 ? moneyWords(total) : 'Không đồng'}</b>.{order.note ? ` Ghi chú: ${order.note}` : ''}</div>
          <div style={{ textAlign: 'right', marginTop: 16, fontStyle: 'italic' }}>Ngày {now.getDate()} tháng {now.getMonth() + 1} năm {now.getFullYear()}</div>
          <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }}><tbody><tr>
            {([['Người lập phiếu', info.maker, info.sign], ['Lái xe', info.driver, info.driverSign], ['Giám đốc', '', null]] as [string, string, Sign | null][]).map(([t, n, sg]) => (
              <td key={t} style={{ width: '33%', textAlign: 'center', verticalAlign: 'top' }}>
                <b>{t}</b><br /><i style={{ fontSize: 12 }}>(Ký, ghi rõ họ tên)</i>
                <div style={{ height: 68, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{sg?.img && <img src={sg.img} alt="" style={{ maxHeight: 64, maxWidth: 170 }} />}</div>
                <b>{showName(sg) ? n : ''}</b>
              </td>
            ))}
          </tr></tbody></table>
        </div>
      )}
    </div>,
    document.body,
  );
}
