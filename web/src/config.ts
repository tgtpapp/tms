// Nơi DUY NHẤT đọc cấu hình môi trường của giao diện.
// Mọi phần khác của app lấy cấu hình qua `config`, không đọc import.meta.env trực tiếp.

export type AppEnv = 'production' | 'staging' | 'local';

export interface AppConfig {
  appName: string;
  /** Dòng ghi công cuối thanh menu (để trống = không hiện) */
  credit: string;
  appEnv: AppEnv;
  supabaseUrl: string;
  supabasePublishableKey: string;
  /** Mã nhà xe mặc định của trang (vd: thinh-phat). Trống = người dùng tự nhập mã nhà xe khi đăng nhập */
  tenantCode: string;
  /** Tên miền email nội bộ để đăng nhập bằng số điện thoại (không gửi thư) */
  loginEmailDomain: string;
  /** Giới hạn dung lượng của gói Supabase đang dùng (MB), để cảnh báo khi gần đầy */
  dbLimitMb: number;
  fileLimitMb: number;
}

export interface ConfigResult {
  config: AppConfig;
  missing: string[];
}

const ENVS: readonly AppEnv[] = ['production', 'staging', 'local'];

// Đọc tĩnh từng biến để Vite thay giá trị chắc chắn lúc build.
const RAW = {
  VITE_APP_NAME: import.meta.env.VITE_APP_NAME as string | undefined,
  VITE_APP_ENV: import.meta.env.VITE_APP_ENV as string | undefined,
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined,
  VITE_TENANT_CODE: import.meta.env.VITE_TENANT_CODE as string | undefined,
  VITE_LOGIN_EMAIL_DOMAIN: import.meta.env.VITE_LOGIN_EMAIL_DOMAIN as string | undefined,
  VITE_DB_LIMIT_MB: import.meta.env.VITE_DB_LIMIT_MB as string | undefined,
  VITE_FILE_LIMIT_MB: import.meta.env.VITE_FILE_LIMIT_MB as string | undefined,
  VITE_CREDIT: import.meta.env.VITE_CREDIT as string | undefined,
};

type RawKey = keyof typeof RAW;

function read(key: RawKey, missing: string[] | null): string {
  const value = RAW[key]?.trim() ?? '';
  if (!value && missing) missing.push(key);
  return value;
}

export function loadConfig(): ConfigResult {
  const missing: string[] = [];
  const rawEnv = read('VITE_APP_ENV', missing);
  const appEnv: AppEnv = ENVS.includes(rawEnv as AppEnv) ? (rawEnv as AppEnv) : 'local';

  const config: AppConfig = {
    appName: read('VITE_APP_NAME', missing) || 'TMS',
    credit: read('VITE_CREDIT', null),
    appEnv,
    supabaseUrl: read('VITE_SUPABASE_URL', missing),
    supabasePublishableKey: read('VITE_SUPABASE_PUBLISHABLE_KEY', missing),
    tenantCode: read('VITE_TENANT_CODE', null).toLowerCase(),
    loginEmailDomain: read('VITE_LOGIN_EMAIL_DOMAIN', null) || 'login.tms.invalid',
    dbLimitMb: Number(read('VITE_DB_LIMIT_MB', null)) || 500,      // Supabase Free: 500 MB database
    fileLimitMb: Number(read('VITE_FILE_LIMIT_MB', null)) || 1024,  // Supabase Free: 1 GB file
  };

  return { config, missing };
}

export const { config, missing: missingConfig } = loadConfig();
