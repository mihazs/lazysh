import { chromium, expect, test, type Page } from '@playwright/test';
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
async function tapAt(page: Page, fraction: { x: number; y: number }) {
  const box = (await page.locator('canvas').boundingBox())!;
  await page.locator('canvas').click({ position: { x: box.width * fraction.x, y: box.height * fraction.y } });
}
async function colorAt(page: Page, at: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas')!;
    const [r, g, b] = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data;
    return { r, g, b };
  }, at);
}
const isRed = (c: { r: number; g: number; b: number }) => c.r > 150 && c.g < 90 && c.b < 90;
const isBlue = (c: { r: number; g: number; b: number }) => c.b > 150 && c.r < 90 && c.g < 90;
const isGreen = (c: { r: number; g: number; b: number }) => c.g > 100 && c.r < 90 && c.b < 90;

/** Runs `body` with the viewer connected to a real headless browser that shows `html`, and always stops that browser. */
async function viewHost(page: Page, baseURL: string | undefined, html: string, body: () => Promise<void>) {
  let server: Server | undefined;
  let host: Awaited<ReturnType<typeof startHostBrowser>> | undefined;
  try {
    server = createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    host = await startHostBrowser(new URL(baseURL!).origin, `http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await page.goto('/?hostBrowserDev=1');
    await page.getByLabel('DevTools WebSocket URL').fill(host.endpoint);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('#hb-state')).toHaveText('live', { timeout: 20_000 });
    await body();
  } finally {
    host?.stop();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
  }
}
const controlSwitch = (page: Page) => page.getByRole('switch', { name: 'Control' });

test('shows the host page, follows a tap and types text into it', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await viewHost(page, baseURL, fixture, async () => {
    await expect.poll(async () => isRed(await colorAt(page, pixel(0.5, 0.25))), { timeout: 15_000, message: 'the fixture page is drawn' }).toBe(true);

    // Tap the top half: the fixture turns blue and the viewer measures how long the new pixels took.
    await controlSwitch(page).click();
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
  });
});

/**
 * A long page with five marks fixed at the top, each turning green on one effect (a click, a double click, a context
 * menu, the exact text typed, a Control+A key press), a button, an input, and a background that is red for the first
 * 500 px of the page and blue after that, so scrolling is visible in the frames.
 */
const gestureFixture = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>gestures</title>
<style>
html,body{margin:0}body{height:3000px;background:linear-gradient(#d00 0,#d00 500px,#00d 500px)}
#marks{position:fixed;top:0;left:0;right:0;height:60px;display:flex}#marks i{flex:1;background:#888}
#tap{position:fixed;top:60px;left:0;right:0;height:100px;font-size:40px;background:#fa0;border:0}
#t{position:fixed;left:0;right:0;bottom:0;height:120px;width:100%;box-sizing:border-box;font-size:40px}
</style>
<div id=marks><i id=m0></i><i id=m1></i><i id=m2></i><i id=m3></i><i id=m4></i></div>
<button id=tap>tap</button><input id=t autocomplete=off>
<script>
const mark = (n, on = true) => { document.getElementById('m' + n).style.background = on ? '#0a0' : '#888'; };
tap.addEventListener('click', () => mark(0));
document.addEventListener('dblclick', event => { if (event.target.id === 'tap') mark(1); });
document.addEventListener('contextmenu', event => { event.preventDefault(); mark(2); });
t.addEventListener('input', () => mark(3, t.value === 'héllo 😀'));
t.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'a') mark(4); });
</script>`;
const isGrey = (c: { r: number; g: number; b: number }) => c.r > 100 && c.r < 170 && Math.abs(c.r - c.g) < 20 && Math.abs(c.r - c.b) < 20;
/** The centre of mark `n` of the five that the gesture fixture shows across the top. */
const markAt = (n: number) => pixel(0.1 + 0.2 * n, 0.043);

test('control off sends nothing; control on taps, double taps, long presses, scrolls, types and pinches', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 520, height: 1250 });
  await viewHost(page, baseURL, gestureFixture, async () => {
    const canvas = page.locator('canvas');
    const spot = async (at: { x: number; y: number }) => {
      const box = (await canvas.boundingBox())!;
      return { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
    };
    const touch = async (at: { x: number; y: number }, hold = 0) => {
      const { x, y } = await spot(at);
      await page.mouse.move(x, y);
      await page.mouse.down();
      if (hold) await page.waitForTimeout(hold);
      await page.mouse.up();
    };
    const marked = (n: number) => expect.poll(async () => isGreen(await colorAt(page, markAt(n))), { timeout: 15_000, message: `mark ${n} turned green` }).toBe(true);
    const stats = async () => JSON.parse(await page.locator('#hb-stats').innerText());
    const button = pixel(0.5, 0.15);
    await expect.poll(async () => isRed(await colorAt(page, pixel(0.5, 0.5))), { timeout: 15_000, message: 'the fixture page is drawn' }).toBe(true);

    // Control is off at the start: the same tap that works below leaves the page as it was.
    expect(await controlSwitch(page).getAttribute('aria-checked')).toBe('false');
    await touch(button);
    await page.waitForTimeout(600);
    expect(isGrey(await colorAt(page, markAt(0)))).toBe(true);

    await controlSwitch(page).click();
    await touch(button);
    await marked(0);

    // Two quick taps are a double click; holding for more than 500 ms is a right click.
    await touch(button);
    await touch(button);
    await marked(1);
    await touch(pixel(0.5, 0.4), 700);
    await marked(2);

    // One-finger drag scrolls the page; where it is comes from the browser's frames.
    const from = await spot(pixel(0.5, 0.7));
    const to = await spot(pixel(0.5, 0.3));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, from.y + (to.y - from.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => isBlue(await colorAt(page, pixel(0.5, 0.5))), { timeout: 15_000, message: 'the page scrolled' }).toBe(true);
    expect((await stats()).scrollY).toBeGreaterThan(150);

    // Accents and an emoji reach the focused input as typed; Backspace and a Control chord arrive as keys.
    await touch(pixel(0.5, 0.92));
    await page.getByRole('button', { name: 'Keyboard' }).click();
    await page.keyboard.insertText('héllo 😀x');
    await page.keyboard.press('Backspace');
    await marked(3);
    // A composed character (an IME) arrives once, when the composition ends: one Backspace takes it away again.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '你' });
    await expect.poll(async () => isGrey(await colorAt(page, markAt(3))), { timeout: 15_000, message: 'the composed character reached the input' }).toBe(true);
    await page.keyboard.press('Backspace');
    await marked(3);
    // Control+A is a key chord, not text.
    await page.keyboard.press('Control+a');
    await marked(4);

    // A pinch zooms the frame at once; Zoom page makes it the page's scale, which the browser reports back.
    expect((await stats()).pageScale).toBe(1);
    const fingers = async (a: number, b: number) => [{ ...(await spot(pixel(a, 0.5))), id: 1 }, { ...(await spot(pixel(b, 0.5))), id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: await fingers(0.4, 0.6) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: await fingers(0.2, 0.8) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('.host-browser-zoom').evaluate(element => (element as HTMLElement).style.transform)).toContain('scale(3)');
    await page.getByRole('button', { name: 'Zoom page' }).click();
    await expect.poll(async () => (await stats()).pageScale, { timeout: 15_000, message: 'the page scale changed' }).toBeCloseTo(3, 1);
  });
});

test('the viewer is not part of the normal app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Host browser prototype')).toHaveCount(0);
  await page.goto('/?hostBrowserDev=0');
  await expect(page.getByText('Host browser prototype')).toHaveCount(0);
});
