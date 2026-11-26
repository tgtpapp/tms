// Giấy tờ xe tôi chạy (tab trong Thông tin của tôi): xe có trong chuyến được xếp cho mình 30 ngày qua, xe gần nhất lên đầu.
// Trình bày như tab Giấy tờ của Lái xe & nhân viên (chỉ xem, bấm để xem ảnh). Lái xe không xem hợp đồng thuê xe (máy chủ đã chặn).
import { useEffect, useState } from 'react';
import { DOC_COLS, DocRow, today, type Doc } from './Documents';
import { DOC_TYPES } from '../lib/docTypes';
import { rpc, supabase } from '../lib/supabase';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function MyCarPapers({ tenantId, warnDays }: { tenantId: string; warnDays: number }) {
  const [cars, setCars] = useState<{ id: string; plate: string }[] | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  useEffect(() => {
    void (async () => {
      const t = await rpc<{ plate: string | null; depart_at: string }[]>('my_trips', { p_from: addDays(today(), -30), p_to: today() }).catch(() => []);
      const plates = [...new Set([...t].sort((a, b) => b.depart_at.localeCompare(a.depart_at)).map((x) => x.plate).filter((x): x is string => !!x))];
      if (!plates.length) { setCars([]); return; }
      const v = ((await supabase.from('vehicles').select('id, plate').in('plate', plates)).data ?? []) as { id: string; plate: string }[];
      v.sort((a, b) => plates.indexOf(a.plate) - plates.indexOf(b.plate));
      setCars(v);
      if (v.length) setDocs(((await supabase.from('documents').select(DOC_COLS).in('vehicle_id', v.map((x) => x.id)).eq('is_current', true)).data ?? []) as Doc[]);
    })();
  }, []);
  if (!cars) return <p className="muted small">Đang tải…</p>;
  if (!cars.length) return <p className="muted">30 ngày qua chưa có chuyến nào được xếp xe cho bạn.</p>;
  const types = DOC_TYPES.filter((d) => d.owner === 'xe');
  return (
    <>
      {cars.map((v, i) => (
        <div key={v.id} className="sub">
          <h3>Xe {v.plate}{i === 0 ? <span className="badge">Gần nhất</span> : null}</h3>
          <ul className="list">
            {types.filter((t) => t.required || docs.some((d) => d.vehicle_id === v.id && d.doc_type === t.code)).map((def) => (
              <DocRow key={def.code} def={def} doc={docs.find((d) => d.vehicle_id === v.id && d.doc_type === def.code)} tenantId={tenantId}
                      owner={{ kind: 'xe', id: v.id, label: v.plate }} warnDays={warnDays} canEdit={false} required={def.required} reload={async () => undefined} />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
