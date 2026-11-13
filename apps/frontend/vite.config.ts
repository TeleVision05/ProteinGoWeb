import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const proxy = {
  '/api': {
    target: 'http://127.0.0.1:3001',
    changeOrigin: false,
  },
};

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  define: { __BUILD__: JSON.stringify(new Date().toTimeString().slice(0, 8)) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy,
  },
  preview: {
    port: 4173,
    // Test server: never let the phone keep an old copy of the app.
    headers: { 'Cache-Control': 'no-store' },
    allowedHosts: ['.trycloudflare.com'],
    proxy,
  },
});
