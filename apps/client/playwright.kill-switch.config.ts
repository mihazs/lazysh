import { defineConfig } from '@playwright/test';

// `bun run test:e2e:kill-switch`: the production bundle built with the native terminal engine switched off
// (LAZYSH_NATIVE_TERMINAL=off, read by build/build.ts), served as built. The dev server of playwright.config.ts cannot stand in:
// the switch is a build-time define.
const origin = 'http://127.0.0.1:1422';
export default defineConfig({
  testDir: './e2e-kill-switch',
  use: { baseURL: origin, trace: 'retain-on-failure' },
  webServer: {
    command: `LAZYSH_NATIVE_TERMINAL=off LAZYSH_BUILD_OUT_DIR=dist-kill-switch bun build/build.ts && bunx vite preview --outDir dist-kill-switch --host 127.0.0.1 --port 1422 --strictPort`,
    url: origin, reuseExistingServer: false, timeout: 180_000,
  },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 850 } } }],
});
