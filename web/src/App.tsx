import { useCallback, useEffect, useRef, useState } from 'react';
import { Centered } from './components/Centered';
import { config, missingConfig } from './config';
import { loadAccountContext, rpc, supabase, type AccountContext } from './lib/supabase';
import { clearCache } from './lib/offline';
import { ToastProvider } from './lib/toast';
import { BootstrapScreen } from './screens/Bootstrap';
import { LoginReport, LoginScreen } from './screens/Login';
import { PlatformScreen } from './screens/Platform';
import { TenantShell } from './screens/TenantShell';
import { DeviceApprovals, deviceHello, PendingDevice } from './components/DeviceGate';

type View =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'bootstrap'; signedIn: boolean }
  | { kind: 'login' }
  | { kind: 'platform' }
  | { kind: 'tenant'; ctx: AccountContext }
  | { kind: 'no_access' }
  | { kind: 'pending_device' };

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const [view, setViewRaw] = useState<View>({ kind: 'loading' });
  const seq = useRef(0);

  // Chỉ lượt xác định màn hình mới nhất được áp dụng (tránh hai lượt chạy song song ghi đè nhau).
  const resolve = useCallback(async () => {
    const mine = ++seq.current;
    const setView = (v: View) => {
      if (mine === seq.current) setViewRaw(v);
    };
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        const initialized = await rpc<boolean>('platform_initialized');
        setView(initialized ? { kind: 'login' } : { kind: 'bootstrap', signedIn: false });
        return;
      }
      // Thiết bị lạ của nhân viên văn phòng / quản lý: chờ cho phép từ thiết bị đang dùng
      if (await deviceHello() === 'cho_duyet') { setView({ kind: 'pending_device' }); return; }
      const ctx = await loadAccountContext();
      if (ctx.tenant_id) setView({ kind: 'tenant', ctx });
      else if (ctx.is_platform_admin) setView({ kind: 'platform' });
      else {
        const initialized = await rpc<boolean>('platform_initialized');
        setView(initialized ? { kind: 'no_access' } : { kind: 'bootstrap', signedIn: true });
      }
    } catch (e) {
      setView({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    if (missingConfig.length > 0) return;
    void resolve();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clearCache();   // xóa bản sao dữ liệu trên máy, giữ vé chờ gửi
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') window.setTimeout(() => void resolve(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [resolve]);

  // Bị đăng xuất từ thiết bị khác (Quản lý thiết bị đăng nhập): tự thoát trên máy này
  const signedIn = view.kind === 'tenant' || view.kind === 'platform' || view.kind === 'no_access';
  useEffect(() => {
    if (!signedIn) return;
    const check = () => {
      if (document.hidden || !navigator.onLine) return;
      void rpc<boolean>('session_alive').then((ok) => { if (ok === false) void supabase.auth.signOut({ scope: 'local' }); }).catch(() => undefined);
    };
    check();
    const t = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, [signedIn]);

  if (missingConfig.length > 0) {
    return (
      <Centered>
        <p className="error-text">Thiếu cấu hình: {missingConfig.join(', ')}</p>
      </Centered>
    );
  }

  switch (view.kind) {
    case 'loading':
      return <Centered><p className="muted">Đang tải…</p></Centered>;
    case 'error':
      return (
        <Centered>
          <p className="error-text">Không kết nối được máy chủ: {view.message}</p>
          <button className="btn" onClick={() => void resolve()}>Thử lại</button>
        </Centered>
      );
    case 'bootstrap':
      return <BootstrapScreen signedIn={view.signedIn} onDone={() => void resolve()} />;
    case 'login':
      return <LoginScreen />;
    case 'pending_device':
      return <PendingDevice onOk={() => void resolve()} />;
    case 'platform':
      return <><PlatformScreen /><DeviceApprovals /></>;
    case 'tenant':
      return <><TenantShell ctx={view.ctx} /><DeviceApprovals /></>;
    case 'no_access':
      return <NoAccess />;
  }
}

/** Đăng nhập được nhưng tài khoản bị khóa / chưa thuộc nhà xe / nhà xe tạm ngưng: vẫn báo sự cố được */
function NoAccess() {
  const [report, setReport] = useState<{ code: string; phone: string } | null>(null);
  async function open() {
    const { data } = await supabase.auth.getUser();
    const m = (data.user?.user_metadata ?? {}) as { tenant_code?: string; phone?: string };
    setReport({ code: m.tenant_code ?? config.tenantCode, phone: m.phone ?? '' });
  }
  return (
    <Centered>
      <p>Tài khoản chưa thuộc nhà xe nào hoặc đã bị khóa.</p>
      <button className="btn" onClick={() => void open()}>Báo sự cố</button>
      <button className="btn" onClick={() => void supabase.auth.signOut()}>Đăng xuất</button>
      {report && <LoginReport code={report.code} askCode={!report.code} phone={report.phone} onClose={() => setReport(null)} />}
    </Centered>
  );
}
