import { useCallback, useEffect, useState } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { companyFileUrl } from '../lib/documents';
import { loadPermissions, type Permissions } from '../lib/permissions';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { AccountScreen } from './Account';
import { AuditScreen } from './Audit';
import { BranchesScreen } from './Branches';
import { RolesScreen } from './Roles';
import { RoutesScreen } from './Routes';
import { SettingsScreen } from './Settings';
import { SellScreen } from './Sell';
import { StaffScreen } from './Staff';
import { TripsScreen } from './Trips';
import { UsersScreen } from './Users';
import { VehiclesScreen } from './Vehicles';

type Tab = 'users' | 'sell' | 'trips' | 'routes' | 'vehicles' | 'staff' | 'branches' | 'roles' | 'settings' | 'audit' | 'account';

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

  const tabs: { key: Tab; label: string; icon: string; group: string; show: boolean }[] = [
    { key: 'sell', label: 'Bán vé', icon: 'ticket', group: 'Bán vé & điều hành', show: perms.has('ticket.sell') },
    { key: 'trips', label: 'Điều hành', icon: 'calendar', group: 'Bán vé & điều hành', show: true },
    { key: 'routes', label: 'Tuyến', icon: 'route', group: 'Danh mục', show: true },
    { key: 'vehicles', label: 'Xe', icon: 'bus', group: 'Danh mục', show: true },
    { key: 'staff', label: 'Lái xe & nhân viên', icon: 'id-badge', group: 'Danh mục', show: true },
    { key: 'branches', label: 'Chi nhánh & phòng vé', icon: 'building', group: 'Danh mục', show: true },
    { key: 'users', label: 'Người dùng', icon: 'users', group: 'Quản trị', show: perms.hasAnywhere('user.read') || perms.hasAnywhere('user.manage') },
    { key: 'roles', label: 'Vai trò', icon: 'shield-check', group: 'Quản trị', show: perms.has('role.manage') },
    { key: 'settings', label: 'Cấu hình', icon: 'settings', group: 'Quản trị', show: perms.has('settings.manage') },
    { key: 'audit', label: 'Nhật ký', icon: 'time-past', group: 'Quản trị', show: perms.has('audit.read') },
    { key: 'account', label: 'Tài khoản của tôi', icon: 'user', group: 'Cá nhân', show: true },
  ];
  const shown = tabs.filter((t) => t.show);
  const groups = [...new Set(shown.map((t) => t.group))];
  const current = shown.find((t) => t.key === tab);

  return (
    <div className="shell">
      {/* Máy tính: menu dọc bên trái. Điện thoại: thanh mục cuộn ngang dưới thanh trên. */}
      <aside className="sidebar">
        <div className="side-brand">
          <Logo tenantId={ctx.tenant_id} />
          <div>
            <b>{ctx.tenant_name ?? config.appName}</b>
            <small>{ctx.full_name}</small>
          </div>
        </div>
        <nav className="side-nav" aria-label="Mục chính">
          {groups.map((g) => (
            <div key={g} className="side-group">
              <div className="side-group-title">{g}</div>
              {shown.filter((t) => t.group === g).map((t) => (
                <button key={t.key} className={tab === t.key ? 'side-link on' : 'side-link'} aria-current={tab === t.key ? 'page' : undefined}
                        onClick={() => { setTab(t.key); window.scrollTo({ top: 0 }); }}>
                  <i className={`fi fi-rr-${t.icon}`} aria-hidden="true" />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <a href="https://www.flaticon.com/uicons" target="_blank" rel="noopener noreferrer">Biểu tượng: Uicons by Flaticon</a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-mobile-brand"><Logo tenantId={ctx.tenant_id} /></span>
            <div>
              <h1>{current?.label}</h1>
              <p className="muted small">{ctx.tenant_name ?? config.appName} · {ctx.full_name}</p>
            </div>
          </div>
          <button className="btn small" onClick={() => void supabase.auth.signOut()}>
            <i className="fi fi-rr-sign-out-alt" aria-hidden="true" /> Đăng xuất
          </button>
        </header>
        <main className="content">
          {tab === 'users' && <UsersScreen ctx={ctx} perms={perms} />}
          {tab === 'routes' && <RoutesScreen perms={perms} />}
          {tab === 'sell' && <SellScreen ctx={ctx} perms={perms} />}
          {tab === 'trips' && <TripsScreen ctx={ctx} perms={perms} />}
          {tab === 'staff' && <StaffScreen ctx={ctx} perms={perms} />}
          {tab === 'vehicles' && <VehiclesScreen ctx={ctx} perms={perms} />}
          {tab === 'branches' && <BranchesScreen perms={perms} />}
          {tab === 'roles' && <RolesScreen perms={perms} />}
          {tab === 'settings' && <SettingsScreen tenantId={ctx.tenant_id ?? ''} />}
          {tab === 'audit' && <AuditScreen />}
          {tab === 'account' && <AccountScreen ctx={ctx} />}
        </main>
      </div>
    </div>
  );
}

/** Logo công ty trên thanh trên cùng + biểu tượng tab trình duyệt (đổi logo: tải lại trang để cập nhật) */
function Logo({ tenantId }: { tenantId: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!tenantId) return;
    void companyFileUrl(tenantId, 'logo.png').then((u) => {
      setUrl(u);
      if (!u) return;
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = u;
    });
  }, [tenantId]);
  return url ? <img src={url} alt="" className="topbar-logo" /> : null;
}
