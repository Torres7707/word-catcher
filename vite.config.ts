import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Popup is built by Vite; background + content scripts are bundled by esbuild
// (scripts/build-scripts.mjs) as single-file IIFE/ESM, which MV3 content scripts require.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { popup: resolve(__dirname, 'popup.html') } },
  },
  test: { environment: 'node', globals: true },
});
