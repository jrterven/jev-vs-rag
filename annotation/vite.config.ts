import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ANNOTATION_');
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1', port: Number(env.ANNOTATION_WEB_PORT || 5175), strictPort: true,
      proxy: { '/api/annotation': `http://127.0.0.1:${env.ANNOTATION_PORT || 3002}` },
    },
    build: { outDir: 'dist/web', emptyOutDir: true },
  };
});
