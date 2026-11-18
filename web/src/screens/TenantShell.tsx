import { useCallback, useEffect, useState } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { loadPermissions, type Permissions } from '../lib/permissions';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { AccountScreen } from './Account';
import { AuditScreen } from './Audit';
import { BranchesScreen } from './Branches';
import { RolesScreen } from './Roles';
import { RoutesScreen } from './Routes';
import { SettingsScreen } from './Settings';
import { UsersScreen } from './Users';
import { VehiclesScreen } from './Vehicles';

type Tab = 'users' | 'routes' | 'vehicles' | 'branches' | 'roles' | 'settings' | 'audit' | 'account';

/** Khung trang của nhân viên nhà xe: thanh trên + các mục theo quyền. */
export function TenantShell({ ctx }: { ctx: AccountContext }) {
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await loadPermissions();
      setPerms(p);
      setTab((cur) => cur ?? (p.hasAnywhere('user.read') || p.hasAnywhere('user.manage') ? 'users' : 'branches'));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Centered><p className="error-text">{error}</p></Centered>;
  if (!perms || !tab) return <Centered><p className="muted">Đang tải…</p></Centered>;

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'users', label: 'Người dùng', show: perms.hasAnywhere('user.read') || perms.hasAnywhere('user.manage') },
    { key: 'routes', label: 'Tuyến', show: true },
    { key: 'vehicles', label: 'Xe', show: true },
    { key: 'branches', label: 'Chi nhánh & phòng vé', show: true },
    { key: 'roles', label: 'Vai trò', show: perms.has('role.manage') },
    { key: 'settings', label: 'Cấu hình', show: perms.has('settings.manage') },
    { key: 'audit', label: 'Nhật ký', show: perms.has('audit.read') },
    { key: 'account', label: 'Tài khoản của tôi', show: true },
  ];

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <b>{ctx.tenant_name ?? config.appName}</b>
          <span className="muted"> · {ctx.full_name}</span>
        </div>
        <button className="btn link" onClick={() => void supabase.auth.signOut()}>Đăng xuất</button>
      </header>
      <nav className="tabs" aria-label="Mục chính">
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'users' && <UsersScreen ctx={ctx} perms={perms} />}
        {tab === 'routes' && <RoutesScreen perms={perms} />}
        {tab === 'vehicles' && <VehiclesScreen ctx={ctx} perms={perms} />}
        {tab === 'branches' && <BranchesScreen perms={perms} />}
        {tab === 'roles' && <RolesScreen perms={perms} />}
        {tab === 'settings' && <SettingsScreen />}
        {tab === 'audit' && <AuditScreen />}
        {tab === 'account' && <AccountScreen ctx={ctx} />}
      </main>
    </div>
  );
}
