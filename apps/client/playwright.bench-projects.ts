// The desktop and phone viewports every benchmark config runs (terminal and Agent view).
export const benchProjects = [
  { name: 'desktop', use: { browserName: 'chromium' as const, viewport: { width: 1280, height: 850 } } },
  { name: 'phone', use: { browserName: 'chromium' as const, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
];
