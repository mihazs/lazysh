import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sourceDefines } from './build/sourceRevision';

export default defineConfig({
  plugins: [react()],
  define: sourceDefines(),
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // Only e2e fixtures import the headless terminal (the native adapter's stand-in core); found late, the dev server reloads the page once to bundle it, in the middle of a spec.
  optimizeDeps: { include: ['@xterm/headless'] },
  build: { target: ['es2022', 'chrome105', 'safari15'] },
});
