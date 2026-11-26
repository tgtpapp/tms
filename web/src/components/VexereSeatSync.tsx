// Chép sơ đồ ghế Vexere sang loại xe TMS (để ghế 2 bên giống hệt: cùng ký hiệu, cùng vị trí).
import { useEffect, useState } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { VxLayout } from '../lib/vexereTickets';

interface VType { id: string; name: string; reg_seats: number; decks: number; is_active: boolean }

export function VexereSeatSync({ data }: { data: VxLayout[] }) {
  const toast = useToast();
  const [types, setTypes] = useState<VType[]>([]);
  const [map, setMap] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Record<number, string>>({});

  useEffect(() => {
    setMap({}); setRes({});
    void supabase.from('vehicle_types').select('id, name, reg_seats, decks, is_active').eq('is_active', true).order('name')
      .then((r) => setTypes((r.data ?? []) as VType[]));
  }, [data]);

  async function apply() {
    setBusy(true);
    let ok = 0;
    for (const [i, l] of data.entries()) {
      const id = map[i];
      if (!id) continue;
      try {
        await rpc('set_seat_layout', { p_type_id: id, p_rows: l.rows, p_cols: l.cols,
          p_seats: l.cells.map((c) => ({ label: c.label, deck: c.deck, row: c.row, col: c.col, kind: c.kind })) });
        setRes((s) => ({ ...s, [i]: 'Đã chép sơ đồ' })); ok++;
      } catch (e) { setRes((s) => ({ ...s, [i]: errMsg(e) })); }
    }
    setBusy(false);
    toast('ok', `Đã chép ${ok} sơ đồ ghế`);
  }

  const chosen = Object.values(map).filter(Boolean);
  return (
    <>
      <div><b>Sơ đồ ghế Vexere</b> · {data.length} sơ đồ</div>
      <div className="table-wrap import-tbl">
        <table className="plist">
          <thead><tr><th>Sơ đồ Vexere</th><th>Ghế</th><th>Chép vào loại xe TMS</th><th>Kết quả</th></tr></thead>
          <tbody>
            {data.map((l, i) => (
              <tr key={i}>
                <td>{l.ten}</td>
                <td>{l.ghe}</td>
                <td>
                  <select value={map[i] ?? ''} aria-label={`Loại xe cho ${l.ten}`} onChange={(e) => setMap({ ...map, [i]: e.target.value })}>
                    <option value="">Không chép</option>
                    {types.map((t) => <option key={t.id} value={t.id} disabled={chosen.includes(t.id) && map[i] !== t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td>{res[i] && <span className={`imp-st ${res[i] === 'Đã chép sơ đồ' ? 'ok' : 'bad'}`}>{res[i]}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || !chosen.length} onClick={() => void apply()}>✔ Chép sơ đồ ({chosen.length})</button>
      </div>
    </>
  );
}
