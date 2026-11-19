import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface AuditRow {
  id: number;
  actor_id: string | null;
  action: 'insert' | 'update' | 'delete';
  entity: string;
  entity_id: string | null;
  detail: { old?: Record<string, unknown>; new?: Record<string, unknown> } | null;
  created_at: string;
}

const ENTITY: Record<string, string> = {
  tenants: 'Nhà xe',
  app_users: 'Người dùng',
  branches: 'Chi nhánh',
  ticket_offices: 'Phòng vé',
  roles: 'Vai trò',
  role_permissions: 'Quyền của vai trò',
  user_roles: 'Gán vai trò',
  tenant_settings: 'Cấu hình',
  stops: 'Điểm dừng',
  routes: 'Tuyến',
  route_stops: 'Điểm dừng của tuyến',
  route_fares: 'Giá vé',
  vehicle_types: 'Loại xe',
  vehicle_type_seats: 'Sơ đồ ghế',
  vehicles: 'Xe',
  documents: 'Giấy tờ',
  staff_members: 'Lái xe / nhân viên',
  staff_private: 'Thông tin cá nhân',
  staff_records: 'Lý lịch hành nghề',
  schedules: 'Nốt (lịch chạy)',
  trips: 'Chuyến',
  trip_crew: 'Lái xe / phụ xe của chuyến',
  transport_orders: 'Lệnh vận chuyển',
};

const ACTION: Record<AuditRow['action'], string> = { insert: 'Thêm', update: 'Sửa', delete: 'Xóa' };
const IGNORE = new Set(['updated_at', 'updated_by', 'created_at', 'created_by']);
const PAGE = 50;

function label(row: AuditRow): string {
  const r = row.detail?.new ?? row.detail?.old ?? {};
  const pick = r.name ?? r.full_name ?? r.plate ?? r.order_no ?? r.code ?? r.key ?? r.permission_code ?? r.doc_type ?? '';
  return String(pick);
}

function changes(row: AuditRow): string {
  if (row.action !== 'update' || !row.detail?.old || !row.detail.new) return '';
  const { old, new: nu } = row.detail;
  return Object.keys(nu)
    .filter((k) => !IGNORE.has(k) && JSON.stringify(old[k]) !== JSON.stringify(nu[k]))
    .map((k) => `${k}: ${JSON.stringify(old[k])} → ${JSON.stringify(nu[k])}`)
    .join('; ');
}

/** Nhật ký thao tác: ai làm gì, lúc nào (chỉ đọc). */
export function AuditScreen() {
  const toast = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [entity, setEntity] = useState('');
  const [more, setMore] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async (offset: number) => {
    const mine = ++seq.current;   // đổi bộ lọc nhanh: chỉ lấy kết quả của lần tải mới nhất
    let q = supabase.from('audit_logs').select('id, actor_id, action, entity, entity_id, detail, created_at')
      .order('id', { ascending: false }).range(offset, offset + PAGE - 1);
    if (entity) q = q.eq('entity', entity);
    const { data, error } = await q;
    if (mine !== seq.current) return;
    if (error) return toast('error', error.message);
    const list = (data ?? []) as AuditRow[];
    setRows((cur) => (offset === 0 ? list : [...cur, ...list]));
    setMore(list.length === PAGE);
  }, [entity, toast]);

  useEffect(() => {
    void load(0);
  }, [load]);

  useEffect(() => {
    void supabase.from('app_users').select('id, full_name').then(({ data }) => {
      const map: Record<string, string> = {};
      for (const u of (data ?? []) as { id: string; full_name: string }[]) map[u.id] = u.full_name;
      setNames(map);
    });
  }, []);

  return (
    <section className="card">
      <div className="item-head">
        <h2>Nhật ký thao tác</h2>
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Lọc theo loại">
          <option value="">Tất cả</option>
          {Object.entries(ENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {rows.length === 0 && <p className="muted">Chưa có thao tác nào.</p>}
      <ul className="list">
        {rows.map((r) => (
          <li key={r.id} className="item">
            <div className="item-head">
              <div>
                <b>{ACTION[r.action]} {ENTITY[r.entity] ?? r.entity}</b> {label(r) && <span>· {label(r)}</span>}
                <div className="muted small">
                  {r.actor_id ? names[r.actor_id] ?? 'Người dùng khác' : 'Hệ thống'} · {new Date(r.created_at).toLocaleString('vi-VN')}
                </div>
              </div>
            </div>
            {changes(r) && <div className="muted small mono">{changes(r)}</div>}
          </li>
        ))}
      </ul>
      {more && <button className="btn small" onClick={() => void load(rows.length)}>Xem thêm</button>}
    </section>
  );
}
