import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { port: Number(loadEnv(mode, process.cwd(), 'WEB_PORT').WEB_PORT || 5174), strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${loadEnv(mode, process.cwd(), 'PORT').PORT || 3001}` } },
  build: { outDir: 'dist' },
}));
