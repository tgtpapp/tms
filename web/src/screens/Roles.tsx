// Phân quyền theo nhóm (như app cũ): chọn nhóm rồi tích quyền theo bảng Xem / Thêm / Sửa / Xóa từng màn hình.
// Một người vào được nhiều nhóm (kiêm nhiệm, quyền cộng dồn) và có thể có quyền riêng – gán ở mục Người dùng.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { PermMatrix, quick } from '../components/PermMatrix';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Role { id: string; code: string; name: string; is_system: boolean }
interface RolePerm { role_id: string; permission_code: string }
/** Nhóm "quyền riêng" của 1 người (tạo ở mục Người dùng) – không hiện trong danh sách nhóm. */
export const isPersonal = (r: { code: string }) => r.code.startsWith('rieng_');

/** Mã nhóm từ tên tiếng Việt: "Thu ngân" → "thu_ngan" */
function toCode(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

export function RolesScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolePerms, setRolePerms] = useState<RolePerm[]>([]);
  const [catalog, setCatalog] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<Record<string, number>>({});
  const [sel, setSel] = useState('');
  const [value, setValue] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const canAdd = perms.has('role.add'), canEdit = perms.has('role.edit');
  const allowed = useCallback((c: string) => perms.has(c), [perms]);

  const load = useCallback(async () => {
    const [r, rp, p, ur] = await Promise.all([
      supabase.from('roles').select('id, code, name, is_system').order('created_at'),
      supabase.from('role_permissions').select('role_id, permission_code'),
      supabase.from('permissions').select('code'),
      supabase.from('user_roles').select('role_id, user_id'),
    ]);
    const err = r.error ?? rp.error ?? p.error;
    if (err) return toast('error', err.message);
    setRoles(((r.data ?? []) as Role[]).filter((x) => !isPersonal(x)));
    setRolePerms((rp.data ?? []) as RolePerm[]);
    setCatalog(new Set(((p.data ?? []) as { code: string }[]).map((x) => x.code)));
    const m: Record<string, Set<string>> = {};
    for (const x of (ur.data ?? []) as { role_id: string; user_id: string }[]) (m[x.role_id] ??= new Set()).add(x.user_id);
    setMembers(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.size])));
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const role = roles.find((r) => r.id === sel) ?? roles[0];
  const current = useMemo(() => new Set(rolePerms.filter((x) => x.role_id === role?.id).map((x) => x.permission_code)), [rolePerms, role?.id]);
  useEffect(() => { setValue(current); setDirty(false); }, [current]);
  const locked = !role || role.code === 'owner' || !canEdit;
  const change = (v: Set<string>) => { setValue(v); setDirty(true); };

  async function save() {
    if (!role) return;
    setBusy(true);
    try {
      await rpc('set_role_permissions', { p_role_id: role.id, p_permissions: [...value] });
      toast('ok', `Đã lưu quyền nhóm ${role.name}`);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    const code = toCode(newName);
    if (code.length < 2 || isPersonal({ code })) return toast('error', 'Tên nhóm không hợp lệ');
    setBusy(true);
    try {
      await rpc('create_role', { p_code: code, p_name: newName.trim(), p_permissions: [] });
      toast('ok', `Đã tạo nhóm ${newName.trim()}`);
      setNewName('');
      await load();
      const { data } = await supabase.from('roles').select('id').eq('code', code).maybeSingle();
      if (data) setSel((data as { id: string }).id);
    } catch (err) {
      const msg = errMsg(err);
      toast('error', /duplicate|unique/i.test(msg) ? 'Đã có nhóm cùng tên' : msg);
    } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="item-head">
        <h2>Phân quyền theo nhóm</h2>
        <span className="small muted">Chọn nhóm rồi tích quyền · 1 người vào được nhiều nhóm (quyền cộng dồn) và có quyền riêng: gán ở mục Người dùng</span>
      </div>
      <div className="vx-tabs role-tabs" role="tablist" aria-label="Nhóm quyền">
        {roles.map((r) => (
          <button key={r.id} type="button" role="tab" aria-selected={r.id === role?.id} className={r.id === role?.id ? 'on' : ''}
                  onClick={() => { if (dirty && !window.confirm('Nhóm đang sửa chưa lưu. Bỏ thay đổi?')) return; setSel(r.id); }}>
            {r.name} <small>{members[r.id] ?? 0}</small>
          </button>
        ))}
      </div>
      {canAdd && (
        <form className="inline-form" onSubmit={create}>
          <label>Nhóm mới<input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="vd: Phòng vé Biên Hòa" /></label>
          <button className="btn small" disabled={busy || !newName.trim()}>+ Tạo nhóm</button>
        </form>
      )}
      {role && <>
        {role.code === 'owner' && <p className="small muted">Chủ nhà xe luôn có toàn quyền, không sửa được.</p>}
        <PermMatrix catalog={catalog} value={value} onChange={change} allowed={allowed} readOnly={locked} />
        {!locked && (
          <div className="actions perm-bar">
            <button type="button" className="btn small" onClick={() => change(quick('all', catalog, allowed))}>✓ Tích tất cả</button>
            <button type="button" className="btn small" onClick={() => change(quick('view', catalog, allowed))}>Chỉ xem</button>
            <button type="button" className="btn small" onClick={() => change(quick('none', catalog, allowed))}>Bỏ hết</button>
            <label className="inline">Sao chép quyền từ
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">Chọn nhóm…</option>
                {roles.filter((r) => r.id !== role.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
            <button type="button" className="btn small" disabled={!copyFrom}
                    onClick={() => change(new Set(rolePerms.filter((x) => x.role_id === copyFrom).map((x) => x.permission_code).filter(allowed)))}>Sao chép</button>
            <button type="button" className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>Lưu quyền nhóm {role.name}</button>
          </div>
        )}
      </>}
    </section>
  );
}
