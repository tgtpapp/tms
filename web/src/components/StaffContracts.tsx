// Mục "Hợp đồng lao động" trong hồ sơ Lái xe & nhân viên (như form nhân viên của app cũ): soạn, sửa, xem trước / in, lưu hồ sơ.
import { useCallback, useEffect, useState } from 'react';
import { fmtDate, today } from './Documents';
import { CONTRACT_COLS, ContractEditor, contractDefaults, formOf, loadPay, useContracts, type CForm, type CStaff, type PayMap } from './ContractEditor';
import type { Me } from './ProfilePapers';
import { KIND_NAME, type Contract } from '../lib/laborContract';
import { supabase } from '../lib/supabase';

export function StaffContracts({ s, contractType, tenantId, me, canArchive, canAdd, canEdit }: {
  s: CStaff & { user_id: string | null }; contractType: string | null | undefined; tenantId: string; me: Me; canArchive: boolean; canAdd: boolean; canEdit: boolean;
}) {
  const year = Number(today().slice(0, 4));
  const [list, setList] = useState<Contract[]>([]);
  const [pay, setPay] = useState<PayMap>({});
  const [f, setF] = useState<CForm | null>(null);
  const C = useContracts(tenantId, me, canArchive);

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([
      supabase.from('labor_contracts').select(CONTRACT_COLS).eq('staff_id', s.id).order('year', { ascending: false }),
      loadPay(year, s.id),
    ]);
    setList((c.data ?? []) as Contract[]);
    setPay(p);
  }, [s.id, year]);
  useEffect(() => { void load(); }, [load]);

  const hasThisYear = list.some((k) => k.year === year && k.status === 'hieu_luc');
  // Hợp đồng của chính mình, hoặc không có quyền sửa: chỉ xem bản PDF
  const mine = s.user_id === me.id;
  const add = canAdd && !mine, edit = canEdit && !mine;
  return (
    <>
      <div className="item-head">
        <h3>Hợp đồng lao động ({list.filter((k) => k.status === 'hieu_luc').length})</h3>
        {add && !hasThisYear && <button className="btn small" onClick={() => setF(contractDefaults(s, year, contractType, pay))}>Soạn HĐ năm {year}</button>}
      </div>
      {list.length === 0 ? <p className="muted small">Chưa có hợp đồng lao động.</p> : (
        <ul className="list">
          {list.map((k) => (
            <li key={k.id} className={k.status === 'da_huy' ? 'muted' : ''}>
              <b>{k.number}</b> · {KIND_NAME[k.kind]} · {fmtDate(k.start_on)}{k.end_on ? ` → ${fmtDate(k.end_on)}` : ''} · {Number(k.salary).toLocaleString('vi-VN')} đ
              {k.status === 'da_huy' && <span className="small error-text"> · Đã hủy: {k.cancel_reason}</span>}
              {k.status === 'hieu_luc' && (
                <span className="actions inline-acts">
                  {edit ? <button className="btn small" aria-label={`Xem HĐ ${k.number}`} disabled={!!C.busy} onClick={() => void C.show(k, s.full_name)}>Xem trước / in</button>
                    : <button className="btn small" aria-label={`Xem HĐ ${k.number}`} disabled={!!C.busy} onClick={() => void C.showPdf(k, s.full_name)}>Xem hợp đồng (PDF)</button>}
                  {edit && <button className="btn small" onClick={() => setF(formOf(k, s))}>Sửa</button>}
                  {edit && canArchive && <button className="btn small" disabled={!!C.busy} onClick={() => void C.archive(k)}>Lưu hồ sơ</button>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {C.busy && !f && <p className="upload">{C.busy}</p>}
      {f && <ContractEditor form={f} setForm={setF} pay={pay} busy={C.busy}
                            onSave={() => void C.save(f).then(async (ok) => { if (ok) { setF(null); await load(); } })} onClose={() => setF(null)} />}
      {C.viewer}
    </>
  );
}
