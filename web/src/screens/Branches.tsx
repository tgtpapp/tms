import { DeleteButton } from '../components/DeleteButton';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Permissions } from '../lib/permissions';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Place {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
}
type Branch = Place;
interface Office extends Place { branch_id: string }

const COLS = 'id, code, name, address, phone, is_active';
const EMPTY_FORM = { code: '', name: '', address: '', phone: '' };
type PlaceForm = typeof EMPTY_FORM;

function clean(f: PlaceForm) {
  return { code: f.code.trim(), name: f.name.trim(), address: f.address.trim() || null, phone: f.phone.trim() || null };
}

/** Chi nhánh & phòng vé: thêm, sửa, ngừng / mở hoạt động (không xóa). */
export function BranchesScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    const [b, o] = await Promise.all([
      supabase.from('branches').select(COLS).order('code'),
      supabase.from('ticket_offices').select(`${COLS}, branch_id`).order('code'),
    ]);
    if (b.error || o.error) return toast('error', (b.error ?? o.error)!.message);
    setBranches((b.data ?? []) as Branch[]);
    setOffices((o.data ?? []) as Office[]);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(table: 'branches' | 'ticket_offices', id: string | null, values: Record<string, unknown>, okText: string) {
    const q = id ? supabase.from(table).update(values).eq('id', id).select('id') : supabase.from(table).insert(values).select('id');
    const { data, error } = await q;
    if (error) {
      toast('error', error.code === '23505' ? 'Mã đã tồn tại' : error.code === '42501' ? 'Không có quyền' : error.message);
      return false;
    }
    if (!data || data.length === 0) {
      toast('error', 'Không có quyền hoặc không tìm thấy');
      return false;
    }
    toast('ok', okText);
    await load();
    return true;
  }

  const visible = (p: Place) => showInactive || p.is_active;
  const inactiveCount = branches.filter((b) => !b.is_active).length + offices.filter((o) => !o.is_active).length;

  return (
    <>
      {perms.has('branch.manage') && (
        <PlaceFormCard title="Thêm chi nhánh" submitLabel="Thêm chi nhánh"
                       onSubmit={(f) => save('branches', null, clean(f), `Đã thêm chi nhánh ${f.name}`)} />
      )}
      <section className="card">
        <div className="item-head">
          <h2>Chi nhánh ({branches.filter((b) => b.is_active).length})</h2>
          {inactiveCount > 0 && (
            <button className="btn small" onClick={() => setShowInactive(!showInactive)}>
              {showInactive ? 'Ẩn mục ngừng hoạt động' : `Hiện mục ngừng hoạt động (${inactiveCount})`}
            </button>
          )}
        </div>
        {branches.length === 0 && <p className="muted">Chưa có chi nhánh.</p>}
        <ul className="list">
          {branches.filter(visible).map((b) => (
            <li key={b.id} className="item">
              <PlaceRow place={b} canEdit={perms.has('branch.manage', b.id)}
                        onSave={(f) => save('branches', b.id, clean(f), 'Đã lưu chi nhánh')}
                        onToggle={() => save('branches', b.id, { is_active: !b.is_active },
                                             b.is_active ? 'Đã ngừng hoạt động chi nhánh' : 'Đã mở lại chi nhánh')}
                        kind="branch" onDeleted={load} />
              <div className="sub">
                <div className="muted small">Phòng vé</div>
                <ul className="list">
                  {offices.filter((o) => o.branch_id === b.id && visible(o)).map((o) => (
                    <li key={o.id} className="item sub-item">
                      <PlaceRow place={o} canEdit={perms.has('office.manage', b.id, o.id)}
                                onSave={(f) => save('ticket_offices', o.id, clean(f), 'Đã lưu phòng vé')}
                                onToggle={() => save('ticket_offices', o.id, { is_active: !o.is_active },
                                                     o.is_active ? 'Đã ngừng hoạt động phòng vé' : 'Đã mở lại phòng vé')}
                                kind="office" onDeleted={load} />
                    </li>
                  ))}
                </ul>
                {perms.has('office.manage', b.id) && b.is_active && (
                  <PlaceFormCard title={`Thêm phòng vé cho ${b.name}`} submitLabel="Thêm phòng vé" compact
                                 onSubmit={(f) => save('ticket_offices', null, { ...clean(f), branch_id: b.id },
                                                       `Đã thêm phòng vé ${f.name}`)} />
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function PlaceFields({ f, setF }: { f: PlaceForm; setF: (f: PlaceForm) => void }) {
  return (
    <div className="grid2">
      <label>Mã<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></label>
      <label>Tên<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
      <label>Địa chỉ<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      <label>Điện thoại<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" /></label>
    </div>
  );
}

function PlaceFormCard(props: { title: string; submitLabel: string; compact?: boolean; onSubmit: (f: PlaceForm) => Promise<boolean> }) {
  const [f, setF] = useState<PlaceForm>(EMPTY_FORM);
  const [open, setOpen] = useState(!props.compact);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await props.onSubmit(f).catch((err) => { console.error(errMsg(err)); return false; });
    setBusy(false);
    if (ok) setF(EMPTY_FORM);
  }

  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>+ {props.submitLabel}</button>;
  return (
    <form className={props.compact ? 'form inline-block' : 'card form'} onSubmit={submit}>
      <h3>{props.title}</h3>
      <PlaceFields f={f} setF={setF} />
      <div className="actions">
        <button className="btn primary" disabled={busy}>{props.submitLabel}</button>
        {props.compact && <button type="button" className="btn link" onClick={() => setOpen(false)}>Đóng</button>}
      </div>
    </form>
  );
}

function PlaceRow(props: { place: Place; canEdit: boolean; onSave: (f: PlaceForm) => Promise<boolean>; onToggle: () => Promise<boolean>;
  kind: 'branch' | 'office'; onDeleted: () => Promise<void> }) {
  const { place, canEdit } = props;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<PlaceForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  if (editing) {
    return (
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await props.onSave(f)) setEditing(false);
        setBusy(false);
      }}>
        <PlaceFields f={f} setF={setF} />
        <div className="actions">
          <button className="btn small primary" disabled={busy}>Lưu</button>
          <button type="button" className="btn small link" onClick={() => setEditing(false)}>Hủy</button>
        </div>
      </form>
    );
  }

  return (
    <div className="item-head">
      <div>
        <b>{place.name}</b> <span className="muted small">· {place.code}</span>
        {!place.is_active && <span className="badge locked">Ngừng hoạt động</span>}
        <div className="muted small">{[place.address, place.phone].filter(Boolean).join(' · ')}</div>
      </div>
      {canEdit && (
        <div className="actions">
          <button className="btn small" onClick={() => {
            setF({ code: place.code, name: place.name, address: place.address ?? '', phone: place.phone ?? '' });
            setEditing(true);
          }}>Sửa</button>
          <button className="btn small" disabled={busy} onClick={async () => {
            setBusy(true);
            await props.onToggle();
            setBusy(false);
          }}>{place.is_active ? 'Ngừng hoạt động' : 'Mở lại'}</button>
          <DeleteButton kind={props.kind} id={place.id} name={place.name} onDone={props.onDeleted} />
        </div>
      )}
    </div>
  );
}
