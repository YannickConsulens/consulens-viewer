import { defineConfig } from 'vite';
export default defineConfig({
  base: '/',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@ifc-lite/wasm'] },
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
