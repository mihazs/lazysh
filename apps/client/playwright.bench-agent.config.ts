import { defineConfig } from '@playwright/test';
import { benchProjects } from './playwright.bench-projects';

// `bun run bench:agent-view`: the Agent view load benchmark against a production build of bench/agent-view-bench.html.
process.env.LAZYSH_BENCH = 'agent-view';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'agent-view-bench.spec.ts',
  timeout: 10 * 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1422' },
  webServer: { command: 'bunx vite build -c vite.bench-agent.config.ts && bunx vite preview -c vite.bench-agent.config.ts', url: 'http://127.0.0.1:1422/bench/agent-view-bench.html', reuseExistingServer: false, timeout: 180_000 },
  projects: benchProjects,
});
