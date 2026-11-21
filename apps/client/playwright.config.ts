import { defineConfig } from '@playwright/test';

const origin = 'http://127.0.0.1:1420';
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: origin, trace: 'retain-on-failure' },
  webServer: { command: 'bun run dev', url: origin, reuseExistingServer: !process.env.CI },
  projects: [
    // Specs resize this project to a phone viewport, where the first-run gesture tour would cover the session, so it has been seen.
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 850 },
      storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'lazysh.gestureTour.v1', value: '999' }] }] } } },
    // Phones drop the top bar for the side menu by default. This project keeps the top bar ("Show top bar" on) so the
    // specs that exercise its controls still run; side-menu.spec.ts starts from a fresh device to cover the default.
    // The first-run gesture tour opens over the first connected phone session, so every device here has already seen it.
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'lazysh.show-top-bar.v1', value: 'true' }, { name: 'lazysh.gestureTour.v1', value: '999' }] }] } } },
  ],
});
