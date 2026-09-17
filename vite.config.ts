import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 部署在子路徑（例如 GitHub Pages、Cloudflare Pages 預覽）也能運作
  base: './',
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
    hookTimeout: 120_000,
  },
});
