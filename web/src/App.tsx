import { config, missingConfig } from './config';

const ENV_LABEL: Record<typeof config.appEnv, string> = {
  production: 'Bản chạy thật',
  staging: 'Bản thử',
  local: 'Máy phát triển',
};

export function App() {
  const ready = missingConfig.length === 0;

  return (
    <main className="shell">
      <h1>{config.appName}</h1>
      <p className="sub">Hệ thống quản lý vận tải</p>
      <p className={`badge ${config.appEnv}`}>{ENV_LABEL[config.appEnv]}</p>
      {ready ? (
        <p className="note">Khung hệ thống đã sẵn sàng. Các chức năng sẽ được bổ sung theo từng giai đoạn.</p>
      ) : (
        <p className="note warn">Thiếu cấu hình: {missingConfig.join(', ')}</p>
      )}
    </main>
  );
}
