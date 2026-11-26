import { Avatar, useAvatars } from '../components/StaffAvatar';
import { loadBrand } from '../lib/brand';
import { NotifyBell } from '../components/NotifyBell';
import { useCallback, useEffect, useState } from 'react';
import { Centered } from '../components/Centered';
import { config } from '../config';
import { companyFileUrl } from '../lib/documents';
import { loadPermissions, type Permissions } from '../lib/permissions';
import { moveOldFiles } from '../lib/fileStore';
import { setBusName } from '../lib/theme';
import { errMsg, supabase, type AccountContext } from '../lib/supabase';
import { autoArchiveProfiles } from '../lib/profileAutoArchive';
import { AccountScreen } from './Account';
import { AuditScreen } from './Audit';
import { BranchesScreen } from './Branches';
import { DriverScreen } from './Driver';
import { ParcelsScreen } from './Parcels';
import { ChartersScreen } from './Charters';
import { ScanScreen } from './Scan';
import { ArchiveScreen } from './Archive';
import { DocsScreen } from './Docs';
import { LaborScreen } from './Labor';
import { TimesheetScreen } from './Timesheet';
import { SafetyScreen } from './Safety';
import { FuelPriceAlert } from '../components/FuelPriceAlert';
import { FuelReportAlert } from '../components/FuelReportAlert';
import { hasShare, takeSharedFiles } from '../lib/shareIn';
import { brandApp } from '../lib/pwa';
import { autoArchiveSafety } from '../lib/safety';
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
import { SupportScreen } from './Support';
import { ScreenGuard } from '../components/ScreenGuard';

type Tab = 'scan' | 'driver' | 'parcels' | 'charters' | 'archive' | 'docs' | 'labor' | 'timesheet' | 'safety' | 'repairs' | 'fuel' | 'km' | 'reports' | 'users' | 'sell' | 'trips' | 'routes' | 'vehicles' | 'staff' | 'branches' | 'roles' | 'settings' | 'audit' | 'account' | 'support';

/** Khung trang của nhân viên nhà xe: thanh trên + các mục theo quyền. */
/** Màu ô biểu tượng menu (như app cũ): mỗi mục 1 màu cố định theo mã mục */
const NAV_PAL = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#84cc16'];
const navColor = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return NAV_PAL[h % NAV_PAL.length]; };
/** Gợn sóng màu khi bấm mục menu */
function ripple(e: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
  const a = e.currentTarget, b = a.getBoundingClientRect(), r = document.createElement('span');
  r.className = 'nav-rip';
  r.style.left = `${e.clientX - b.left}px`;
  r.style.top = `${e.clientY - b.top}px`;
  a.appendChild(r);
  setTimeout(() => r.remove(), 650);
}

export function TenantShell({ ctx }: { ctx: AccountContext }) {
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [error, setError] = useState('');
  // Menu trái máy tính: ghim (luôn mở) hoặc tự thu gọn thành cột biểu tượng, rê chuột vào thì mở
  const [pinned, setPinnedState] = useState(() => { try { return localStorage.getItem('menu.ghim') !== '0'; } catch { return true; } });
  const setPinned = (v: boolean) => { setPinnedState(v); try { localStorage.setItem('menu.ghim', v ? '1' : '0'); } catch { /* bỏ qua */ } };
  // Giao diện của tôi đổi kiểu menu trái → cập nhật ngay
  useEffect(() => { const on = () => { try { setPinnedState(localStorage.getItem('menu.ghim') !== '0'); } catch { /* bỏ qua */ } }; window.addEventListener('tms-ui', on); return () => window.removeEventListener('tms-ui', on); }, []);
  const [tab, setTab] = useState<Tab | null>(null);
  const [isCrew, setIsCrew] = useState(false);   // tài khoản gắn với hồ sơ lái xe / phụ xe / nhân viên
  const [myStaff, setMyStaff] = useState<string | null>(null);
  const avas = useAvatars(ctx.tenant_id);
  // Ảnh chia sẻ từ Zalo vào app: văn phòng (quyền thêm phiếu nhiên liệu) → tạo phiếu từ ảnh; lái xe → báo đổ dầu
  const [share, setShare] = useState<{ to: 'fuel' | 'driver'; files: File[] } | null>(null);
  const [shareMsg, setShareMsg] = useState('');
  // Báo sự cố: màn hình đang mở trước khi vào Báo sự cố + nội dung soạn sẵn khi một màn hình bị lỗi
  const [lastScreen, setLastScreen] = useState('');
  const [report, setReport] = useState('');
  const clearReport = useCallback(() => setReport(''), []);
  // App cài vào máy: tên nhà xe dưới biểu tượng, biểu tượng là ảnh đại diện của người đăng nhập (chưa có ảnh: logo nhà xe)
  setBusName(ctx.tenant_name ?? '');
  const myAva = myStaff ? avas[myStaff] : undefined;
  useEffect(() => {
    if (!ctx.tenant_id) return;
    brandApp(ctx.tenant_name ?? config.appName, ctx.tenant_id, myStaff, myAva ? decodeURIComponent(/#v=([^#]*)$/.exec(myAva)?.[1] ?? '') : '');
  }, [ctx.tenant_id, ctx.tenant_name, myStaff, myAva]);
  // tải sẵn đầu trang in (logo, tên, địa chỉ, liên hệ) để bản in đầu tiên đã đủ thông tin
  useEffect(() => { if (ctx.tenant_id) void loadBrand().catch(() => undefined); }, [ctx.tenant_id]);
  useEffect(() => { if (!shareMsg) return; const t = window.setTimeout(() => setShareMsg(''), 12_000); return () => window.clearTimeout(t); }, [shareMsg]);

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
      // Chủ nhà xe: tệp còn ở kho cũ tự chuyển dần lên Google Drive (chạy nền)
      if (p.has('settings.edit')) void moveOldFiles();
      // Mở app vào thẳng Bán vé (ai có quyền bán vé); không có thì như cũ
      setTab((cur) => cur ?? (p.has('sell.view') ? 'sell' : p.hasAnywhere('user.view') ? 'users' : crew ? 'driver' : 'account'));
      if (hasShare()) {
        const files = (await takeSharedFiles()).filter((f) => f.type.startsWith('image/'));
        if (!files.length) setShareMsg('Không nhận được ảnh chia sẻ, thử chia sẻ lại.');
        else if (p.has('fuel.add')) { setShare({ to: 'fuel', files }); setTab('fuel'); }
        else if (crew) { setShare({ to: 'driver', files }); setTab('driver'); }
        else setShareMsg('Tài khoản này chưa được tạo phiếu nhiên liệu hay báo đổ dầu.');
      }
    } catch (e) {
      setError(errMsg(e));
    }
  }, [ctx.user_id]);

  useEffect(() => {
    void load();
  }, [load]);
  // Quyền theo nhóm áp dụng ngay khi chủ / quản lý sửa nhóm hoặc gán nhóm khác (không phải đăng xuất, tải lại trang):
  // quay lại app và cứ 5 phút hỏi lại danh sách quyền (nhỏ), có đổi mới cập nhật giao diện
  useEffect(() => {
    if (!perms) return;
    const cur = perms.key();
    const check = () => {
      if (document.hidden || !navigator.onLine) return;
      void loadPermissions().then((p) => { if (p.key() !== cur) setPerms(p); }).catch(() => undefined);
    };
    const t = window.setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('tms-quyen', check);   // vừa lưu nhóm / gán nhóm trên máy này: áp dụng ngay
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', check); window.removeEventListener('tms-quyen', check); };
  }, [perms]);
  // Giám sát ATGT: tự lập checklist trước chuyến, sổ ngày, biên bản, báo cáo tuần / tháng / năm vào Lưu trữ hồ sơ (sau khi mở app, rồi mỗi giờ)
  const autoAtgt = !!perms && perms.has('safety.view') && perms.has('archive.view') && perms.has('archive.add');
  useEffect(() => {
    if (!autoAtgt) return;
    const run = () => { void autoArchiveSafety().catch((e) => console.warn('Tự lưu hồ sơ ATGT', e)); };
    const t = window.setTimeout(run, 120_000), iv = window.setInterval(run, 3600_000);
    return () => { window.clearTimeout(t); window.clearInterval(iv); };
  }, [autoAtgt]);
  // Lưu trữ hồ sơ tự cập nhật: lý lịch hành nghề, lý lịch phương tiện, hợp đồng lao động năm nay (kể cả hợp đồng năm mới máy chủ tự lập)
  // – dựng lại khi dữ liệu đổi và lưu đè đúng chỗ cũ: sau khi mở app, ngay sau khi sửa hồ sơ / giấy tờ / xe (chờ 20 giây gom nhiều lần sửa), và mỗi 3 giờ
  const arch = !!perms && perms.has('archive.view') && perms.has('archive.add');
  const canDrv = arch && perms.has('staff.view_all'), canVeh = arch && perms.has('vehicle.view'), canCt = arch && perms.has('labor.view_all');
  const canDoc = arch && perms.has('doc.view'), canPay = arch && perms.has('salary.view'), canRep = arch && perms.has('repair.view'), canLv = arch && perms.has('leave.view_all');
  useEffect(() => {
    const tid = ctx.tenant_id;
    if (!tid || !(canDrv || canVeh || canCt || canDoc || canPay || canRep || canLv)) return;
    const me = { id: ctx.user_id, name: ctx.full_name ?? '' };
    const run = () => { if (!document.hidden && navigator.onLine) void autoArchiveProfiles(tid, me, { drivers: canDrv, vehicles: canVeh, contracts: canCt, cv: canDrv, docs: canDoc, leases: canVeh, pay: canPay, repairs: canRep, leaves: canLv }).catch((e) => console.warn('Tự cập nhật hồ sơ', e)); };
    let deb: number | undefined;
    const changed = () => { window.clearTimeout(deb); deb = window.setTimeout(run, 20_000); };
    const t = window.setTimeout(run, 90_000), iv = window.setInterval(run, 3 * 3600_000);
    window.addEventListener('tms-hs-doi', changed);
    return () => { window.clearTimeout(t); window.clearTimeout(deb); window.clearInterval(iv); window.removeEventListener('tms-hs-doi', changed); };
  }, [canDrv, canVeh, canCt, canDoc, canPay, canRep, canLv, ctx.tenant_id, ctx.user_id, ctx.full_name]);

  if (error) return <Centered><p className="error-text">{error}</p></Centered>;
  if (!perms || !tab) return <Centered><p className="muted">Đang tải…</p></Centered>;

  const tabs: { key: Tab; label: string; icon: string; group: string; show: boolean }[] = [
    { key: 'driver', label: 'Việc của tôi', icon: 'marker', group: 'Bán vé & điều hành', show: isCrew },
    { key: 'sell', label: 'Bán vé', icon: 'ticket', group: 'Bán vé & điều hành', show: perms.has('sell.view') },
    { key: 'parcels', label: 'Gửi hàng', icon: 'box', group: 'Bán vé & điều hành', show: perms.has('parcel.view') },
    { key: 'charters', label: 'Hợp đồng', icon: 'document', group: 'Bán vé & điều hành', show: perms.has('charter.view') },
    { key: 'trips', label: 'Điều hành', icon: 'calendar', group: 'Bán vé & điều hành', show: perms.has('trip.view') },
    { key: 'safety', label: 'Giám sát ATGT', icon: 'shield-exclamation', group: 'Bán vé & điều hành', show: perms.has('safety.view') },
    { key: 'routes', label: 'Tuyến', icon: 'route', group: 'Danh mục', show: perms.has('route.view') },
    { key: 'repairs', label: 'Sửa chữa', icon: 'tools', group: 'Danh mục', show: perms.has('repair.view') },
    { key: 'fuel', label: 'Nhiên liệu', icon: 'gas-pump', group: 'Danh mục', show: perms.has('fuel.view') },
    { key: 'reports', label: 'Báo cáo', icon: 'chart-histogram', group: 'Danh mục', show: perms.has('report.view') },
    { key: 'km', label: 'Km xe', icon: 'road', group: 'Danh mục', show: perms.has('km.view') },
    { key: 'vehicles', label: 'Xe', icon: 'bus', group: 'Danh mục', show: perms.has('vehicle.view') },
    { key: 'staff', label: perms.has('staff.view_all') ? 'Lái xe & nhân viên' : 'Thông tin của tôi', icon: 'id-badge', group: 'Danh mục', show: perms.has('staff.view') || isCrew },
    { key: 'labor', label: 'Hợp đồng lao động', icon: 'document', group: 'Danh mục', show: perms.has('labor.view') },
    { key: 'timesheet', label: 'Bảng chấm công', icon: 'calendar-check', group: 'Danh mục', show: perms.has('timesheet.view') },
    { key: 'branches', label: 'Chi nhánh & phòng vé', icon: 'building', group: 'Danh mục', show: perms.hasAnywhere('branch.view') || perms.hasAnywhere('office.view') },
    { key: 'docs', label: 'Văn bản', icon: 'document-signed', group: 'Quản trị', show: perms.has('doc.view') },
    { key: 'archive', label: 'Lưu trữ hồ sơ', icon: 'folder', group: 'Quản trị', show: perms.has('archive.view') },
    { key: 'scan', label: 'Scan tài liệu', icon: 'camera', group: 'Quản trị', show: perms.has('archive.view') || perms.has('archive.add') || isCrew },
    { key: 'users', label: 'Người dùng', icon: 'users', group: 'Quản trị', show: perms.hasAnywhere('user.view') },
    { key: 'roles', label: 'Vai trò', icon: 'shield-check', group: 'Quản trị', show: perms.has('role.view') },
    { key: 'settings', label: 'Cấu hình', icon: 'settings', group: 'Quản trị', show: perms.has('settings.view') },
    { key: 'audit', label: 'Nhật ký', icon: 'time-past', group: 'Quản trị', show: perms.has('audit.view') },
    { key: 'account', label: 'Tài khoản của tôi', icon: 'user', group: 'Cá nhân', show: true },
    { key: 'support', label: 'Báo sự cố', icon: 'headset', group: 'Cá nhân', show: true },
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
          <NotifyBell />
          <button type="button" className={pinned ? 'side-pin on' : 'side-pin'} aria-pressed={pinned}
                  aria-label={pinned ? 'Bỏ ghim menu (tự ẩn)' : 'Ghim menu'} title={pinned ? 'Bỏ ghim: menu tự thu gọn' : 'Ghim menu luôn mở'}
                  onClick={() => setPinned(!pinned)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 4h6l-1 6 4 4H6l4-4z" /><path d="M12 14v7" />
            </svg>
          </button>
        </div>
        <nav className="side-nav" aria-label="Mục chính">
          {/* Điện thoại: quét mã QR trên máy tính để máy tính đăng nhập (như Zalo) */}
          <button type="button" className="side-link side-qr-m" style={{ ['--ic' as string]: '#0f766e' }}
                  onClick={() => window.dispatchEvent(new Event('tms-qr-scan'))}>
            <i className="fi fi-rr-qrcode" aria-hidden="true" /><span>Quét QR</span>
          </button>
          {groups.map((g) => (
            <div key={g} className="side-group">
              <div className="side-group-title">{g}</div>
              {shown.filter((t) => t.group === g).map((t) => (
                <button key={t.key} className={tab === t.key ? 'side-link on' : 'side-link'} aria-current={tab === t.key ? 'page' : undefined}
                        style={{ ['--ic' as string]: navColor(t.key) }}
                        onClick={(e) => { ripple(e); if (t.key === 'support' && tab !== 'support') setLastScreen(tab ?? ''); setTab(t.key); window.scrollTo({ top: 0 }); }}>
                  <i className={`fi fi-rr-${t.icon}`} aria-hidden="true" />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        {config.credit && <div className="side-foot">{config.credit}</div>}
      </aside>
      <div className="main">
        <main className="content">
          <ScreenGuard key={tab} name={tabs.find((x) => x.key === tab)?.label ?? ''}
                       onReport={(text) => { setLastScreen(tab ?? ''); setReport(text); setTab('support'); }}>
          {shareMsg && <p className="card error-text" role="alert">{shareMsg} <button type="button" className="btn small link" onClick={() => setShareMsg('')}>Đóng</button></p>}
          {tab === 'driver' && <DriverScreen tenantId={ctx.tenant_id} staffId={myStaff} shareFiles={share?.to === 'driver' ? share.files : null} onShareDone={() => setShare(null)} />}
          {tab === 'parcels' && <ParcelsScreen ctx={ctx} />}
          {tab === 'charters' && <ChartersScreen tenantId={ctx.tenant_id ?? ''} />}
          {tab === 'archive' && <ArchiveScreen perms={perms} />}
          {tab === 'scan' && <ScanScreen canSave={perms.has('archive.add')} canAI={perms.has('archive.view') || perms.has('archive.add') || isCrew} canLenh={isCrew} />}
          {tab === 'docs' && <DocsScreen ctx={ctx} perms={perms} />}
          {tab === 'labor' && <LaborScreen ctx={ctx} perms={perms} />}
          {tab === 'timesheet' && <TimesheetScreen ctx={ctx} perms={perms} />}
          {tab === 'safety' && <SafetyScreen ctx={ctx} perms={perms} />}
          {perms.has('fuel.view') && ctx.tenant_id && <FuelPriceAlert tenantId={ctx.tenant_id} onOpen={() => setTab('fuel')} />}
          {perms.has('fuel.add') && ctx.tenant_id && <FuelReportAlert tenantId={ctx.tenant_id} onOpen={() => setTab('fuel')} />}
          {tab === 'repairs' && <RepairsScreen ctx={ctx} perms={perms} />}
          {tab === 'fuel' && <FuelScreen ctx={ctx} perms={perms} shareFiles={share?.to === 'fuel' ? share.files : null} onShareDone={() => setShare(null)} />}
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
          {tab === 'account' && <AccountScreen ctx={ctx} canManage={perms.has('staff.edit')} />}
          {tab === 'support' && <SupportScreen me={ctx.user_id} canHandle={perms.has('user.edit')} lastKey={lastScreen || undefined}
                                               prefill={report || undefined} onPrefillUsed={clearReport} />}
          </ScreenGuard>
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
