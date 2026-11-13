import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production build of the Agent view benchmark page (docs/reference/agent-view-performance.md). Timings use plain React production;
// LAZYSH_BENCH_PROFILING=1 swaps in React's profiling build so <Profiler> reports commits (it adds measurable overhead of its own).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: { alias: process.env.LAZYSH_BENCH_PROFILING ? [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] : [] },
  build: { minify: process.env.LAZYSH_BENCH_UNMINIFIED ? false : 'esbuild', outDir: 'dist-bench-agent', emptyOutDir: true, target: ['es2022', 'chrome105', 'safari15'], rollupOptions: { input: 'bench/agent-view-bench.html' } },
  preview: { port: 1422, strictPort: true, host: '127.0.0.1' },
});
