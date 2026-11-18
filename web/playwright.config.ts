import { defineConfig, devices } from '@playwright/test';

// Kiểm thử giao diện trên trình duyệt thật (chạy trong CI với Supabase local).
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'dien-thoai', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
