import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production (minified, React production) build of the benchmark page only; see docs/architecture/terminal-benchmarks.md.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: { outDir: 'dist-bench', emptyOutDir: true, target: ['es2022', 'chrome105', 'safari15'], rollupOptions: { input: 'bench/terminal-bench.html' } },
  preview: { port: 1421, strictPort: true, host: '127.0.0.1' },
});
