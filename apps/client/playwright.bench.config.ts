import { defineConfig } from '@playwright/test';

// `bun run bench:terminal`: the full terminal baseline against a release build of the benchmark page.
process.env.LAZYSH_BENCH = 'full';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'terminal-bench.spec.ts',
  timeout: 30 * 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1421' },
  webServer: { command: 'bunx vite build -c vite.bench.config.ts && bunx vite preview -c vite.bench.config.ts', url: 'http://127.0.0.1:1421/bench/terminal-bench.html', reuseExistingServer: false, timeout: 180_000 },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 850 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  ],
});
