import { chromium, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Host browser prototype (docs/host-browser.md, "Prototype"): a real headless Chrome-family browser plays the host
 * and shows a fixture page; the prototype viewer draws its screencast and sends a tap and typed text.
 * Not covered: a real SSH hop and a real device (the viewer connects to the debug port directly).
 */
const fixture = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>fixture</title>
<style>html{background:#d00}body{margin:0;height:100%}input{position:fixed;left:0;right:0;bottom:0;height:40%;width:100%;box-sizing:border-box;font-size:40px}</style>
<input id=t autocomplete=off>
<script>
let blue = false;
document.addEventListener('click', event => { if (event.target.id !== 't') { blue = !blue; document.documentElement.style.background = blue ? '#00d' : '#d00'; } });
t.addEventListener('input', () => { if (t.value === 'héllo 世界') document.documentElement.style.background = '#0a0'; });
</script>`;

function browserBinary() {
  const candidates = [process.env.LAZYSH_TEST_CHROME, chromium.executablePath()];
  return candidates.find(path => path && existsSync(path));
}

async function startHostBrowser(origin: string, pageUrl: string) {
  const binary = browserBinary();
  expect(binary, 'no Chrome or Chromium to play the host (set LAZYSH_TEST_CHROME)').toBeTruthy();
  const profile = mkdtempSync(join(tmpdir(), 'lazysh-host-browser-e2e-'));
  const child: ChildProcess = spawn(binary!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--remote-allow-origins=${origin}`,
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu', pageUrl,
  ], { stdio: 'ignore', detached: true });
  const file = join(profile, 'DevToolsActivePort');
  for (let waited = 0; !existsSync(file) && waited < 20000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const [port, path] = readFileSync(file, 'utf8').split('\n');
  return {
    endpoint: `ws://127.0.0.1:${port}${path}`,
    stop() {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const pixel = (x: number, y: number) => ({ x, y });
/** A tap at a fraction of the displayed frame, whatever size the layout gives it. */
async function tapAt(page: import('@playwright/test').Page, fraction: { x: number; y: number }) {
  const box = (await page.locator('canvas').boundingBox())!;
  await page.locator('canvas').click({ position: { x: box.width * fraction.x, y: box.height * fraction.y } });
}
async function colorAt(page: import('@playwright/test').Page, at: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas')!;
    const [r, g, b] = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data;
    return { r, g, b };
  }, at);
}
const isRed = (c: { r: number; g: number; b: number }) => c.r > 150 && c.g < 90 && c.b < 90;
const isBlue = (c: { r: number; g: number; b: number }) => c.b > 150 && c.r < 90 && c.g < 90;
const isGreen = (c: { r: number; g: number; b: number }) => c.g > 100 && c.r < 90 && c.b < 90;

test('shows the host page, follows a tap and types text into it', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  let server: Server | undefined;
  let host: Awaited<ReturnType<typeof startHostBrowser>> | undefined;
  try {
    server = createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(fixture));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    host = await startHostBrowser(new URL(baseURL!).origin, fixtureUrl);

    await page.goto('/?hostBrowserDev=1');
    await page.getByLabel('DevTools WebSocket URL').fill(host.endpoint);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('#hb-state')).toHaveText('live', { timeout: 20_000 });
    await expect.poll(async () => isRed(await colorAt(page, pixel(0.5, 0.25))), { timeout: 15_000, message: 'the fixture page is drawn' }).toBe(true);

    // Tap the top half: the fixture turns blue and the viewer measures how long the new pixels took.
    await tapAt(page, pixel(0.4, 0.15));
    await expect.poll(async () => isBlue(await colorAt(page, pixel(0.5, 0.25))), { timeout: 15_000, message: 'the tap reached the page' }).toBe(true);
    const stats = JSON.parse(await page.locator('#hb-stats').innerText());
    expect(stats.tapToChangeMs).toBeGreaterThan(0);
    expect(stats.frames).toBeGreaterThan(1);
    test.info().annotations.push({ type: 'tap-to-frame-ms', description: String(Math.round(stats.tapToChangeMs)) });
    console.log(`host browser prototype: tap to changed frame ${Math.round(stats.tapToChangeMs)} ms (direct loopback, headless)`);

    // Focus the page's input with a tap, then type accents and CJK through the viewer's keyboard sink.
    await tapAt(page, pixel(0.4, 0.85));
    await page.getByRole('button', { name: 'Keyboard' }).click();
    await page.keyboard.insertText('héllo 世界');
    await expect.poll(async () => isGreen(await colorAt(page, pixel(0.5, 0.25))), { timeout: 15_000, message: 'the text reached the page input' }).toBe(true);
  } finally {
    host?.stop();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
  }
});

test('the viewer is not part of the normal app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Host browser prototype')).toHaveCount(0);
  await page.goto('/?hostBrowserDev=0');
  await expect(page.getByText('Host browser prototype')).toHaveCount(0);
});
