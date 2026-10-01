import { readdirSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 這一版網站需要的資料庫版本＝最新 migration 的編號；前端登入後會和 public.schema_version() 比對
const schemaVersion = readdirSync(new URL('./supabase/migrations', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .at(-1)!
  .slice(0, 14);

export default defineConfig({
  // 部署在子路徑（例如 GitHub Pages、Cloudflare Pages 預覽）也能運作
  base: './',
  define: {
    __SCHEMA_VERSION__: JSON.stringify(schemaVersion),
  },
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  server: {
    port: 5188,
    strictPort: true,
  },
  test: {
    include: ['src/**/*.test.ts', 'db-tests/**/*.test.ts'],
    testTimeout: 60_000,
    // 每個資料庫測試檔都會開一個 PGlite（WASM，記憶體用量大）；同時跑太多個，電腦記憶體吃緊時會整個當掉
    maxWorkers: 2,
    hookTimeout: 120_000,
  },
});
