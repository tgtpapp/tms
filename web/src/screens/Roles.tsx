import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Role { id: string; code: string; name: string; is_system: boolean }
interface RolePerm { role_id: string; permission_code: string }
interface Perm { code: string; module: string; name: string }

/** Mã vai trò từ tên tiếng Việt: "Thu ngân" → "thu_ngan" */
function toCode(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Vai trò: xem quyền từng vai trò, tạo vai trò mới, sửa quyền (trừ Chủ nhà xe). */
export function RolesScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolePerms, setRolePerms] = useState<RolePerm[]>([]);
  const [catalog, setCatalog] = useState<Perm[]>([]);

  const load = useCallback(async () => {
    const [r, rp, p] = await Promise.all([
      supabase.from('roles').select('id, code, name, is_system').order('created_at'),
      supabase.from('role_permissions').select('role_id, permission_code'),
      supabase.from('permissions').select('code, module, name').order('code'),
    ]);
    const err = r.error ?? rp.error ?? p.error;
    if (err) return toast('error', err.message);
    setRoles((r.data ?? []) as Role[]);
    setRolePerms((rp.data ?? []) as RolePerm[]);
    setCatalog((p.data ?? []) as Perm[]);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const permName = (code: string) => catalog.find((p) => p.code === code)?.name ?? code;

  return (
    <>
      <CreateRoleForm catalog={catalog} perms={perms} onCreated={load} />
      <section className="card">
        <h2>Vai trò ({roles.length})</h2>
        <ul className="list">
          {roles.map((role) => (
            <RoleItem key={role.id} role={role} catalog={catalog} perms={perms} permName={permName}
                      current={rolePerms.filter((x) => x.role_id === role.id).map((x) => x.permission_code)}
                      onSaved={load} />
          ))}
        </ul>
      </section>
    </>
  );
}

function PermissionChecklist(props: { catalog: Perm[]; perms: Permissions; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="checklist">
      {props.catalog.map((p) => {
        const allowed = props.perms.has(p.code);
        return (
          <label key={p.code} className={allowed ? 'check' : 'check disabled'} title={allowed ? '' : 'Bạn không có quyền này nên không cấp được'}>
            <input type="checkbox" disabled={!allowed} checked={props.value.includes(p.code)}
                   onChange={(e) => props.onChange(e.target.checked ? [...props.value, p.code] : props.value.filter((c) => c !== p.code))} />
            {p.name}
          </label>
        );
      })}
    </div>
  );
}

function CreateRoleForm({ catalog, perms, onCreated }: { catalog: Perm[]; perms: Permissions; onCreated: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const code = toCode(name);
    if (code.length < 2) return toast('error', 'Tên vai trò quá ngắn');
    setBusy(true);
    try {
      await rpc('create_role', { p_code: code, p_name: name.trim(), p_permissions: selected });
      toast('ok', `Đã tạo vai trò ${name.trim()}`);
      setName('');
      setSelected([]);
      await onCreated();
    } catch (err) {
      const msg = errMsg(err);
      toast('error', /duplicate|unique/i.test(msg) ? 'Đã có vai trò cùng tên' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Tạo vai trò mới</h2>
      <label>Tên vai trò<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <div className="muted small">Quyền của vai trò</div>
      <PermissionChecklist catalog={catalog} perms={perms} value={selected} onChange={setSelected} />
      <button className="btn primary" disabled={busy}>Tạo vai trò</button>
    </form>
  );
}

function RoleItem(props: {
  role: Role; catalog: Perm[]; perms: Permissions; current: string[];
  permName: (c: string) => string; onSaved: () => Promise<void>;
}) {
  const { role } = props;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const locked = role.code === 'owner';

  async function save() {
    setBusy(true);
    try {
      await rpc('set_role_permissions', { p_role_id: role.id, p_permissions: value });
      toast('ok', `Đã lưu quyền vai trò ${role.name}`);
      setEditing(false);
      await props.onSaved();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="item">
      <div className="item-head">
        <div>
          <b>{role.name}</b> <span className="muted small">· {role.is_system ? 'vai trò mẫu' : 'tự tạo'}</span>
        </div>
        {!locked && !editing && (
          <button className="btn small" onClick={() => { setValue(props.current); setEditing(true); }}>Sửa quyền</button>
        )}
      </div>
      {editing ? (
        <>
          <PermissionChecklist catalog={props.catalog} perms={props.perms} value={value} onChange={setValue} />
          <div className="actions">
            <button className="btn small primary" disabled={busy} onClick={() => void save()}>Lưu</button>
            <button className="btn small link" onClick={() => setEditing(false)}>Hủy</button>
          </div>
        </>
      ) : (
        <div className="chips">
          {props.current.length === 0 && <span className="muted small">Chưa có quyền</span>}
          {props.current.map((c) => <span key={c} className="chip">{props.permName(c)}</span>)}
          {locked && <span className="muted small">(Chủ nhà xe luôn có toàn quyền)</span>}
        </div>
      )}
    </li>
  );
}
