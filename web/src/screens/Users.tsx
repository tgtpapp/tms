import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { MIN_PASSWORD, PHONE_RE, weakPassword } from '../lib/login';
import type { Permissions } from '../lib/permissions';
import { adminUsers, errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { PermMatrix } from '../components/PermMatrix';
import { isPersonal } from './Roles';

interface UserRow { id: string; phone: string; full_name: string; status: 'active' | 'locked' }
interface RoleRow { id: string; code: string; name: string }
interface UserRoleRow { id: string; user_id: string; role_id: string; scope_type: string; scope_id: string | null }
interface BranchRow { id: string; name: string }
interface OfficeRow { id: string; name: string; branch_id: string }

interface Data {
  users: UserRow[];
  roles: RoleRow[];
  userRoles: UserRoleRow[];
  branches: BranchRow[];
  offices: OfficeRow[];
  rolePerms: { role_id: string; permission_code: string }[];
  catalog: Set<string>;
}

const EMPTY: Data = { users: [], roles: [], userRoles: [], branches: [], offices: [], rolePerms: [], catalog: new Set() };

async function select<T>(table: string, columns: string, order: string): Promise<T[]> {
  const { data, error } = await supabase.from(table).select(columns).order(order);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

/** Giá trị ô "Phạm vi": tenant | branch:<id> | ticket_office:<id> */
function parseScope(v: string): { scope_type: string; scope_id: string | null } {
  if (v === 'tenant') return { scope_type: 'tenant', scope_id: null };
  const [type, id] = v.split(':');
  return { scope_type: type, scope_id: id };
}

export function UsersScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const [data, setData] = useState<Data>(EMPTY);
  const canManage = perms.has('user.edit');
  const canAdd = perms.has('user.add');
  const canPerm = perms.has('user.edit');

  const load = useCallback(async () => {
    try {
      const [users, roles, userRoles, branches, offices, rp, cat] = await Promise.all([
        select<UserRow>('app_users', 'id, phone, full_name, status', 'full_name'),
        select<RoleRow>('roles', 'id, code, name', 'created_at'),
        select<UserRoleRow>('user_roles', 'id, user_id, role_id, scope_type, scope_id', 'created_at'),
        select<BranchRow>('branches', 'id, name', 'name'),
        select<OfficeRow>('ticket_offices', 'id, name, branch_id', 'name'),
        select<{ role_id: string; permission_code: string }>('role_permissions', 'role_id, permission_code', 'role_id'),
        select<{ code: string }>('permissions', 'code', 'code'),
      ]);
      setData({ users, roles, userRoles, branches, offices, rolePerms: rp, catalog: new Set(cat.map((x) => x.code)) });
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeLabel = useCallback((type: string, id: string | null) => {
    if (type === 'branch') return `CN ${data.branches.find((b) => b.id === id)?.name ?? '?'}`;
    if (type === 'ticket_office') return `PV ${data.offices.find((o) => o.id === id)?.name ?? '?'}`;
    return 'Toàn nhà xe';
  }, [data.branches, data.offices]);

  return (
    <>
      {canAdd && <CreateUserForm data={data} onCreated={load} />}
      <section className="card">
        <h2>Người dùng ({data.users.length})</h2>
        <ul className="list">
          {data.users.map((u) => (
            <UserItem key={u.id} user={u} data={data} isSelf={u.id === ctx.user_id} canManage={canManage} canPerm={canPerm}
                      allowed={(c) => perms.has(c)} scopeLabel={scopeLabel} onChanged={load} />
          ))}
        </ul>
      </section>
    </>
  );
}

function ScopeSelect({ data, value, onChange }: { data: Data; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Phạm vi">
      <option value="tenant">Toàn nhà xe</option>
      {data.branches.map((b) => <option key={b.id} value={`branch:${b.id}`}>Chi nhánh {b.name}</option>)}
      {data.offices.map((o) => <option key={o.id} value={`ticket_office:${o.id}`}>Phòng vé {o.name}</option>)}
    </select>
  );
}

function CreateUserForm({ data, onCreated }: { data: Data; onCreated: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', phone: '', password: '', roleId: '', scope: 'tenant' });
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!PHONE_RE.test(f.phone)) return toast('error', 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
    if (f.password.length < MIN_PASSWORD) return toast('error', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
    { const w = weakPassword(f.password); if (w) return toast('error', w); }
    setBusy(true);
    try {
      const res = await adminUsers<{ user_id: string }>({
        action: 'create_user', phone: f.phone, full_name: f.fullName, password: f.password,
      });
      if (f.roleId) {
        const s = parseScope(f.scope);
        await rpc('assign_role', { p_user_id: res.user_id, p_role_id: f.roleId, p_scope_type: s.scope_type, p_scope_id: s.scope_id });
      }
      toast('ok', `Đã tạo tài khoản ${f.fullName}`);
      setF({ fullName: '', phone: '', password: '', roleId: '', scope: 'tenant' });
      await onCreated();
    } catch (e2) {
      toast('error', errMsg(e2));
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Thêm người dùng</h2>
      <div className="grid2">
        <label>Họ tên
          <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required />
        </label>
        <label>Số điện thoại
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.trim() })} inputMode="tel" required />
        </label>
        <label>Mật khẩu ban đầu
          <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })}
                 autoComplete="new-password" required />
        </label>
        <label>Nhóm quyền
          <select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
            <option value="">(Chưa gán)</option>
            {data.roles.filter((r) => !isPersonal(r)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        {f.roleId && (
          <label>Phạm vi
            <ScopeSelect data={data} value={f.scope} onChange={(v) => setF({ ...f, scope: v })} />
          </label>
        )}
      </div>
      <button className="btn primary" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo tài khoản'}</button>
    </form>
  );
}

function UserItem(props: {
  user: UserRow; data: Data; isSelf: boolean; canManage: boolean; canPerm: boolean; allowed: (c: string) => boolean;
  scopeLabel: (type: string, id: string | null) => string; onChanged: () => Promise<void>;
}) {
  const { user, data, isSelf, canManage, scopeLabel, onChanged } = props;
  const toast = useToast();
  const [panel, setPanel] = useState<'none' | 'password' | 'role' | 'perm'>('none');
  const [newPassword, setNewPassword] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('tenant');
  const [busy, setBusy] = useState(false);

  const myRoles = useMemo(() => data.userRoles.filter((r) => r.user_id === user.id), [data.userRoles, user.id]);
  const canEdit = canManage && !isSelf;

  async function run(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    try {
      await fn();
      toast('ok', okText);
      setPanel('none');
      await onChanged();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="item">
      <div className="item-head">
        <div>
          <b>{user.full_name}</b> {isSelf && <span className="muted">(bạn)</span>}
          <div className="muted small">{user.phone}</div>
        </div>
        <span className={`badge ${user.status}`}>{user.status === 'active' ? 'Hoạt động' : 'Đã khóa'}</span>
      </div>
      <div className="chips">
        {myRoles.length === 0 && <span className="muted small">Chưa có nhóm quyền</span>}
        {myRoles.map((ur) => {
          const r = data.roles.find((x) => x.id === ur.role_id);
          return (
          <span key={ur.id} className={`chip${r && isPersonal(r) ? ' chip-own' : ''}`}>
            {r ? (isPersonal(r) ? 'Quyền riêng' : r.name) : '?'} · {scopeLabel(ur.scope_type, ur.scope_id)}
            {canEdit && (
              <button className="chip-x" title="Gỡ khỏi nhóm" aria-label={`Gỡ ${r?.name ?? ''}`} disabled={busy}
                      onClick={() => void run(() => rpc('revoke_role', { p_user_role_id: ur.id }), 'Đã gỡ khỏi nhóm')}>×</button>
            )}
          </span>
          );
        })}
      </div>
      {canEdit && (
        <div className="actions">
          <button className="btn small" disabled={busy} onClick={() => setPanel(panel === 'role' ? 'none' : 'role')}>Thêm vào nhóm</button>
          {!myRoles.some((ur) => data.roles.find((r) => r.id === ur.role_id)?.code === 'owner') && (
            <button className="btn small" disabled={busy} onClick={() => setPanel(panel === 'perm' ? 'none' : 'perm')}>Phân quyền {user.full_name}</button>
          )}
          <button className="btn small" disabled={busy} onClick={() => setPanel(panel === 'password' ? 'none' : 'password')}>Đặt lại mật khẩu</button>
          <button className="btn small" disabled={busy}
                  onClick={() => void run(() => rpc('set_user_status', { p_user_id: user.id, p_status: user.status === 'active' ? 'locked' : 'active' }),
                                          user.status === 'active' ? 'Đã khóa tài khoản' : 'Đã mở khóa')}>
            {user.status === 'active' ? 'Khóa' : 'Mở khóa'}
          </button>
        </div>
      )}
      {panel === 'password' && (
        <form className="inline-form" onSubmit={(e) => {
          e.preventDefault();
          if (newPassword.length < MIN_PASSWORD) return toast('error', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
          { const w = weakPassword(newPassword); if (w) return toast('error', w); }
          void run(() => adminUsers({ action: 'reset_password', user_id: user.id, password: newPassword }), 'Đã đặt lại mật khẩu')
            .then(() => setNewPassword(''));
        }}>
          <input type="password" placeholder="Mật khẩu mới" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                 aria-label="Mật khẩu mới" autoComplete="new-password" required />
          <button className="btn small primary" disabled={busy}>Lưu</button>
        </form>
      )}
      {panel === 'role' && (
        <form className="inline-form" onSubmit={(e) => {
          e.preventDefault();
          const s = parseScope(scope);
          void run(() => rpc('assign_role', { p_user_id: user.id, p_role_id: roleId, p_scope_type: s.scope_type, p_scope_id: s.scope_id }),
                   'Đã thêm vào nhóm');
        }}>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="Nhóm quyền" required>
            <option value="">Chọn nhóm</option>
            {data.roles.filter((r) => !isPersonal(r)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <ScopeSelect data={data} value={scope} onChange={setScope} />
          <button className="btn small primary" disabled={busy}>Gán</button>
        </form>
      )}
      {panel === 'perm' && <UserPerms {...props} myRoles={myRoles} onDone={() => { setPanel('none'); void onChanged(); }} />}
    </li>
  );
}

/** Bảng quyền của 1 người: hiện đủ quyền đang có (từ các nhóm + riêng), sửa được mọi ô.
 *  Tích thêm ngoài nhóm = quyền riêng; bỏ tích ô của nhóm = chặn riêng người này (người khác trong nhóm không ảnh hưởng). */
function UserPerms(props: {
  user: UserRow; data: Data; canPerm: boolean; allowed: (c: string) => boolean; myRoles: UserRoleRow[]; onDone: () => void;
}) {
  const { user, data, canPerm, allowed, myRoles, onDone } = props;
  const toast = useToast();
  const own = data.roles.find((r) => r.code === `rieng_${user.id.replace(/-/g, '').slice(0, 24)}`);
  const groupKey = myRoles.map((r) => r.role_id).filter((id) => id !== own?.id).sort().join(',');
  const inherited = useMemo(() => {
    const ids = new Set(groupKey.split(','));
    return new Set(data.rolePerms.filter((x) => ids.has(x.role_id)).map((x) => x.permission_code));
  }, [data.rolePerms, groupKey]);
  const [value, setValue] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void supabase.from('user_permission_denies').select('permission_code').eq('user_id', user.id).then(({ data: d }) => {
      const deny = new Set(((d ?? []) as { permission_code: string }[]).map((x) => x.permission_code));
      const mine = data.rolePerms.filter((x) => x.role_id === own?.id).map((x) => x.permission_code);
      setValue(new Set([...inherited, ...mine].filter((c) => !deny.has(c))));
    });
  }, [user.id, own?.id, data.rolePerms, inherited]);

  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      await rpc('set_user_permissions', { p_user_id: user.id, p_grants: [...value].filter((c) => !inherited.has(c)), p_denies: [...inherited].filter((c) => !value.has(c)) });
      toast('ok', `Đã lưu quyền của ${user.full_name}`);
      onDone();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  const groups = myRoles.filter((r) => r.role_id !== own?.id).map((r) => data.roles.find((x) => x.id === r.role_id)?.name).filter(Boolean).join(', ');
  return (
    <div className="sub">
      <p className="small muted">Quyền đang có của {user.full_name} (từ nhóm: {groups || 'chưa vào nhóm nào'}). Sửa được mọi ô:
        tích thêm là quyền riêng; bỏ tích ô của nhóm thì chỉ người này mất ô đó, người khác trong nhóm không ảnh hưởng.
        <span className="perm-key"><i className="k-inh" /> có từ nhóm <i className="k-own" /> quyền riêng <i className="k-deny" /> đã bỏ riêng</span></p>
      {value ? <PermMatrix catalog={data.catalog} value={value} onChange={setValue} allowed={allowed} inherited={inherited} readOnly={!canPerm} />
        : <p className="muted">Đang tải…</p>}
      {canPerm && <div className="actions"><button className="btn primary" disabled={busy || !value} onClick={() => void save()}>Lưu quyền {user.full_name}</button></div>}
    </div>
  );
}
