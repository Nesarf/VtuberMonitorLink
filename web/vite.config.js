import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 前端开发时把 /api 代理到本机后端 / proxy /api to the local backend in dev
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 43111,
    proxy: {
      '/api': { target: 'http://127.0.0.1:43110', changeOrigin: true },
    },
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
