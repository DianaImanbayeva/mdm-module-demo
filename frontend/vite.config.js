import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Модуль должен грузиться внутри iframe ERP (см. корневой
// MODULE_DEVELOPER_GUIDE.md, п.3/5) — снимаем ограничения на фрейминг и для dev-сервера.
// В проде весь модуль отдаётся с одного порта backend'ом (см. server.js, отдаёт
// frontend/dist). Для локальной разработки с hot-reload держим два процесса —
// vite dev здесь и backend отдельно — и проксируем API/health/dev на backend,
// чтобы фронтенд всегда мог ходить по относительным путям ('/api/...').
const BACKEND = process.env.MDM_BACKEND_URL || 'http://localhost:9009';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    cors: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
      'Access-Control-Allow-Origin': '*',
    },
    proxy: {
      '/api': BACKEND,
      '/health': BACKEND,
      '/dev': BACKEND,
    },
  },
  preview: {
    port: 5183,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
      'Access-Control-Allow-Origin': '*',
    },
  },
});
