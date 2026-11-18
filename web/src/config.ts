// Nơi DUY NHẤT đọc cấu hình môi trường của giao diện.
// Mọi phần khác của app lấy cấu hình qua `config`, không đọc import.meta.env trực tiếp.

export type AppEnv = 'production' | 'staging' | 'local';

export interface AppConfig {
  appName: string;
  appEnv: AppEnv;
  supabaseUrl: string;
  supabasePublishableKey: string;
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
};

type RawKey = keyof typeof RAW;

function read(key: RawKey, missing: string[]): string {
  const value = RAW[key]?.trim() ?? '';
  if (!value) missing.push(key);
  return value;
}

export function loadConfig(): ConfigResult {
  const missing: string[] = [];
  const rawEnv = read('VITE_APP_ENV', missing);
  const appEnv: AppEnv = ENVS.includes(rawEnv as AppEnv) ? (rawEnv as AppEnv) : 'local';

  const config: AppConfig = {
    appName: read('VITE_APP_NAME', missing) || 'TMS',
    appEnv,
    supabaseUrl: read('VITE_SUPABASE_URL', missing),
    supabasePublishableKey: read('VITE_SUPABASE_PUBLISHABLE_KEY', missing),
  };

  return { config, missing };
}

export const { config, missing: missingConfig } = loadConfig();
