import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

let sourceRevision = '';
let sourceDirty = true;
try {
  const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {encoding:'utf8'}).trim();
  if (/^[0-9a-f]{40}$/.test(revision)) sourceRevision = revision;
  sourceDirty = execFileSync('git', ['status', '--porcelain'], {encoding:'utf8'}).trim().length > 0;
} catch { /* Source archives may not include Git metadata. */ }

export default defineConfig({
  plugins: [react()],
  define: { __LAZYSH_SOURCE_REVISION__: JSON.stringify(sourceRevision), __LAZYSH_SOURCE_DIRTY__: JSON.stringify(sourceDirty) },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: ['es2022', 'chrome105', 'safari15'] },
});
