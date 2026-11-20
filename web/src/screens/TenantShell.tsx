import { Avatar, useAvatars } from '../components/StaffAvatar';
import { useCallback, useEffect, useState } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { companyFileUrl } from '../lib/documents';
import { loadPermissions, type Permissions } from '../lib/permissions';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { archiveMissingContracts } from '../lib/laborAutoArchive';
import { AccountScreen } from './Account';
import { AuditScreen } from './Audit';
import { BranchesScreen } from './Branches';
import { DriverScreen } from './Driver';
import { ParcelsScreen } from './Parcels';
import { ChartersScreen } from './Charters';
import { ArchiveScreen } from './Archive';
import { DocsScreen } from './Docs';
import { LaborScreen } from './Labor';
import { TimesheetScreen } from './Timesheet';
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

type Tab = 'driver' | 'parcels' | 'charters' | 'archive' | 'docs' | 'labor' | 'timesheet' | 'repairs' | 'fuel' | 'km' | 'reports' | 'users' | 'sell' | 'trips' | 'routes' | 'vehicles' | 'staff' | 'branches' | 'roles' | 'settings' | 'audit' | 'account';

/** Khung trang của nhân viên nhà xe: thanh trên + các mục theo quyền. */
export function TenantShell({ ctx }: { ctx: AccountContext }) {
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [error, setError] = useState('');
  // Menu trái máy tính: ghim (luôn mở) hoặc tự thu gọn thành cột biểu tượng, rê chuột vào thì mở
  const [pinned, setPinnedState] = useState(() => { try { return localStorage.getItem('menu.ghim') !== '0'; } catch { return true; } });
  const setPinned = (v: boolean) => { setPinnedState(v); try { localStorage.setItem('menu.ghim', v ? '1' : '0'); } catch { /* bỏ qua */ } };
  const [tab, setTab] = useState<Tab | null>(null);
  const [isCrew, setIsCrew] = useState(false);   // tài khoản gắn với hồ sơ lái xe / phụ xe / nhân viên
  const [myStaff, setMyStaff] = useState<string | null>(null);
  const avas = useAvatars(ctx.tenant_id);

  const load = useCallback(async () => {
    try {
      const [p, me] = await Promise.all([
        loadPermissions(),
        ctx.user_id ? supabase.from('staff_members').select('id, position').eq('user_id', ctx.user_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const crew = !!me.data;   // lái xe, phụ xe, người chạy trung chuyển (có hồ sơ nhân viên)
      setIsCrew(crew);
      setMyStaff((me.data as { id: string } | null)?.id ?? null);
      setPerms(p);
      // Mở app vào thẳng Bán vé (ai có quyền bán vé); không có thì như cũ
      setTab((cur) => cur ?? (p.has('sell.view') ? 'sell' : p.hasAnywhere('user.view') ? 'users' : crew ? 'driver' : 'account'));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [ctx.user_id]);

  useEffect(() => {
    void load();
  }, [load]);
  // Hợp đồng lao động năm mới (máy chủ tự lập ngày 01/01): tự lưu PDF còn thiếu vào Lưu trữ hồ sơ, chạy ngầm sau khi mở app
  const autoHd = !!perms && perms.has('labor.view_all') && perms.has('archive.view') && perms.has('archive.add');
  useEffect(() => {
    const tid = ctx.tenant_id;
    if (!autoHd || !tid) return;
    const t = window.setTimeout(() => { void archiveMissingContracts(tid, { id: ctx.user_id, name: ctx.full_name ?? '' }).catch(() => undefined); }, 60_000);
    return () => window.clearTimeout(t);
  }, [autoHd, ctx.tenant_id, ctx.user_id, ctx.full_name]);

  if (error) return <Centered><p className="error-text">{error}</p></Centered>;
  if (!perms || !tab) return <Centered><p className="muted">Đang tải…</p></Centered>;

  const tabs: { key: Tab; label: string; icon: string; group: string; show: boolean }[] = [
    { key: 'driver', label: 'Việc của tôi', icon: 'marker', group: 'Bán vé & điều hành', show: isCrew },
    { key: 'sell', label: 'Bán vé', icon: 'ticket', group: 'Bán vé & điều hành', show: perms.has('sell.view') },
    { key: 'parcels', label: 'Gửi hàng', icon: 'box', group: 'Bán vé & điều hành', show: perms.has('parcel.view') },
    { key: 'charters', label: 'Hợp đồng', icon: 'document', group: 'Bán vé & điều hành', show: perms.has('charter.view') },
    { key: 'trips', label: 'Điều hành', icon: 'calendar', group: 'Bán vé & điều hành', show: perms.has('trip.view') },
    { key: 'routes', label: 'Tuyến', icon: 'route', group: 'Danh mục', show: perms.has('route.view') },
    { key: 'repairs', label: 'Sửa chữa', icon: 'tools', group: 'Danh mục', show: perms.has('repair.view') },
    { key: 'fuel', label: 'Nhiên liệu', icon: 'gas-pump', group: 'Danh mục', show: perms.has('fuel.view') },
    { key: 'reports', label: 'Báo cáo', icon: 'chart-histogram', group: 'Danh mục', show: perms.has('report.view') },
    { key: 'km', label: 'Km xe', icon: 'road', group: 'Danh mục', show: perms.has('km.view') },
    { key: 'vehicles', label: 'Xe', icon: 'bus', group: 'Danh mục', show: perms.has('vehicle.view') },
    { key: 'staff', label: 'Lái xe & nhân viên', icon: 'id-badge', group: 'Danh mục', show: perms.has('staff.view') || isCrew },
    { key: 'labor', label: 'Hợp đồng lao động', icon: 'document', group: 'Danh mục', show: perms.has('labor.view') },
    { key: 'timesheet', label: 'Bảng chấm công', icon: 'calendar-check', group: 'Danh mục', show: perms.has('timesheet.view') },
    { key: 'branches', label: 'Chi nhánh & phòng vé', icon: 'building', group: 'Danh mục', show: perms.hasAnywhere('branch.view') || perms.hasAnywhere('office.view') },
    { key: 'docs', label: 'Văn bản', icon: 'document-signed', group: 'Quản trị', show: perms.has('doc.view') },
    { key: 'archive', label: 'Lưu trữ hồ sơ', icon: 'folder', group: 'Quản trị', show: perms.has('archive.view') },
    { key: 'users', label: 'Người dùng', icon: 'users', group: 'Quản trị', show: perms.hasAnywhere('user.view') },
    { key: 'roles', label: 'Vai trò', icon: 'shield-check', group: 'Quản trị', show: perms.has('role.view') },
    { key: 'settings', label: 'Cấu hình', icon: 'settings', group: 'Quản trị', show: perms.has('settings.view') },
    { key: 'audit', label: 'Nhật ký', icon: 'time-past', group: 'Quản trị', show: perms.has('audit.view') },
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
            <span className="me-line"><Avatar name={ctx.full_name ?? '?'} url={myStaff ? avas[myStaff] : undefined} size={26} /><small>{ctx.full_name}</small></span>
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
          {tab === 'labor' && <LaborScreen ctx={ctx} perms={perms} />}
          {tab === 'timesheet' && <TimesheetScreen ctx={ctx} perms={perms} />}
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
          {tab === 'settings' && <SettingsScreen tenantId={ctx.tenant_id ?? ''} me={{ id: ctx.user_id, name: ctx.full_name ?? '' }} canSalary={perms.has('salary.view')} canArchive={perms.has('archive.add')} />}
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
