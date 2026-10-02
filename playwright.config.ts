import { defineConfig, devices } from '@playwright/test';

// E2E 跑在示範模式（瀏覽器內的 PGlite＋虛構示範資料），每個測試都是全新的瀏覽器環境與資料庫。
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // 每個分頁都在瀏覽器裡跑一個 Postgres，同時開太多會吃光記憶體
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: 'http://localhost:5188',
    viewport: { width: 390, height: 844 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5188',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // 一定要是示範模式，不能連到正式資料庫
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
});
