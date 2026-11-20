import { useCallback, useEffect, useState } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { companyFileUrl } from '../lib/documents';
import { loadPermissions, type Permissions } from '../lib/permissions';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { AccountScreen } from './Account';
import { AuditScreen } from './Audit';
import { BranchesScreen } from './Branches';
import { DriverScreen } from './Driver';
import { ParcelsScreen } from './Parcels';
import { ChartersScreen } from './Charters';
import { ArchiveScreen } from './Archive';
import { DocsScreen } from './Docs';
import { RepairsScreen } from './Repairs';
import { FuelScreen } from './Fuel';
import { VehicleKmScreen } from './VehicleKm';
import { ReportsScreen } from './Reports';
import { RolesScreen } from './Roles';
import { RoutesScreen } from './Routes';
import { SettingsScreen } from './Settings';
import { SellScreen } from './Sell';
import { StaffScreen } from './Staff';
import { TripsScreen } from './Trips';
import { UsersScreen } from './Users';
import { VehiclesScreen } from './Vehicles';

type Tab = 'driver' | 'parcels' | 'charters' | 'archive' | 'docs' | 'repairs' | 'fuel' | 'km' | 'reports' | 'users' | 'sell' | 'trips' | 'routes' | 'vehicles' | 'staff' | 'branches' | 'roles' | 'settings' | 'audit' | 'account';

/** Khung trang của nhân viên nhà xe: thanh trên + các mục theo quyền. */
export function TenantShell({ ctx }: { ctx: AccountContext }) {
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [error, setError] = useState('');
  // Menu trái máy tính: ghim (luôn mở) hoặc tự thu gọn thành cột biểu tượng, rê chuột vào thì mở
  const [pinned, setPinnedState] = useState(() => { try { return localStorage.getItem('menu.ghim') !== '0'; } catch { return true; } });
  const setPinned = (v: boolean) => { setPinnedState(v); try { localStorage.setItem('menu.ghim', v ? '1' : '0'); } catch { /* bỏ qua */ } };
  const [tab, setTab] = useState<Tab | null>(null);
  const [isCrew, setIsCrew] = useState(false);   // tài khoản gắn với hồ sơ lái xe / phụ xe / nhân viên

  const load = useCallback(async () => {
    try {
      const [p, me] = await Promise.all([
        loadPermissions(),
        ctx.user_id ? supabase.from('staff_members').select('id, position').eq('user_id', ctx.user_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const crew = !!me.data;   // lái xe, phụ xe, người chạy trung chuyển (có hồ sơ nhân viên)
      setIsCrew(crew);
      setPerms(p);
      // Mở app vào thẳng Bán vé (ai có quyền bán vé); không có thì như cũ
      setTab((cur) => cur ?? (p.has('ticket.sell') ? 'sell' : p.hasAnywhere('user.read') || p.hasAnywhere('user.manage') ? 'users' : crew ? 'driver' : 'branches'));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [ctx.user_id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Centered><p className="error-text">{error}</p></Centered>;
  if (!perms || !tab) return <Centered><p className="muted">Đang tải…</p></Centered>;

  const tabs: { key: Tab; label: string; icon: string; group: string; show: boolean }[] = [
    { key: 'driver', label: 'Việc của tôi', icon: 'marker', group: 'Bán vé & điều hành', show: isCrew },
    { key: 'sell', label: 'Bán vé', icon: 'ticket', group: 'Bán vé & điều hành', show: perms.has('ticket.sell') },
    { key: 'parcels', label: 'Gửi hàng', icon: 'box', group: 'Bán vé & điều hành', show: perms.has('parcel.manage') },
    { key: 'charters', label: 'Hợp đồng', icon: 'document', group: 'Bán vé & điều hành', show: perms.has('trip.manage') },
    { key: 'trips', label: 'Điều hành', icon: 'calendar', group: 'Bán vé & điều hành', show: true },
    { key: 'routes', label: 'Tuyến', icon: 'route', group: 'Danh mục', show: true },
    { key: 'repairs', label: 'Sửa chữa', icon: 'tools', group: 'Danh mục', show: perms.has('vehicle.manage') || perms.has('trip.manage') },
    { key: 'fuel', label: 'Nhiên liệu', icon: 'gas-pump', group: 'Danh mục', show: perms.has('vehicle.manage') || perms.has('trip.manage') },
    { key: 'reports', label: 'Báo cáo', icon: 'chart-histogram', group: 'Danh mục', show: perms.has('report.view') },
    { key: 'km', label: 'Km xe', icon: 'road', group: 'Danh mục', show: perms.has('vehicle.manage') || perms.has('trip.manage') },
    { key: 'vehicles', label: 'Xe', icon: 'bus', group: 'Danh mục', show: true },
    { key: 'staff', label: 'Lái xe & nhân viên', icon: 'id-badge', group: 'Danh mục', show: true },
    { key: 'branches', label: 'Chi nhánh & phòng vé', icon: 'building', group: 'Danh mục', show: true },
    { key: 'docs', label: 'Văn bản', icon: 'document-signed', group: 'Quản trị', show: perms.has('doc.manage') },
    { key: 'archive', label: 'Lưu trữ hồ sơ', icon: 'folder', group: 'Quản trị', show: perms.has('archive.view') || perms.has('archive.manage') },
    { key: 'users', label: 'Người dùng', icon: 'users', group: 'Quản trị', show: perms.hasAnywhere('user.read') || perms.hasAnywhere('user.manage') },
    { key: 'roles', label: 'Vai trò', icon: 'shield-check', group: 'Quản trị', show: perms.has('role.manage') },
    { key: 'settings', label: 'Cấu hình', icon: 'settings', group: 'Quản trị', show: perms.has('settings.manage') },
    { key: 'audit', label: 'Nhật ký', icon: 'time-past', group: 'Quản trị', show: perms.has('audit.read') },
    { key: 'account', label: 'Tài khoản của tôi', icon: 'user', group: 'Cá nhân', show: true },
  ];
  const shown = tabs.filter((t) => t.show);
  const groups = [...new Set(shown.map((t) => t.group))];

  return (
    <div className={pinned ? 'shell' : 'shell unpinned'}>
      {/* Máy tính: menu dọc bên trái. Điện thoại: thanh mục cuộn ngang dưới thanh trên. */}
      <aside className="sidebar">
        <div className="side-brand">
          <Logo tenantId={ctx.tenant_id} />
          <div>
            <b>{ctx.tenant_name ?? config.appName}</b>
            <small>{ctx.full_name}</small>
          </div>
          <button type="button" className={pinned ? 'side-pin on' : 'side-pin'} aria-pressed={pinned}
                  aria-label={pinned ? 'Bỏ ghim menu (tự ẩn)' : 'Ghim menu'} title={pinned ? 'Bỏ ghim: menu tự thu gọn' : 'Ghim menu luôn mở'}
                  onClick={() => setPinned(!pinned)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 4h6l-1 6 4 4H6l4-4z" /><path d="M12 14v7" />
            </svg>
          </button>
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
        <main className="content">
          {tab === 'driver' && <DriverScreen />}
          {tab === 'parcels' && <ParcelsScreen />}
          {tab === 'charters' && <ChartersScreen tenantId={ctx.tenant_id ?? ''} />}
          {tab === 'archive' && <ArchiveScreen perms={perms} />}
          {tab === 'docs' && <DocsScreen ctx={ctx} perms={perms} />}
          {tab === 'repairs' && <RepairsScreen ctx={ctx} perms={perms} />}
          {tab === 'fuel' && <FuelScreen ctx={ctx} perms={perms} />}
          {tab === 'km' && <VehicleKmScreen perms={perms} />}
          {tab === 'reports' && <ReportsScreen />}
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
