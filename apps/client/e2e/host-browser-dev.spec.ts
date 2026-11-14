import { chromium, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  // The browser's home is private to the test, so that a file it would save can only be found there.
  const home = mkdtempSync(join(tmpdir(), 'lazysh-host-browser-home-'));
  const child: ChildProcess = spawn(binary!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--remote-allow-origins=${origin}`,
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu', pageUrl,
  ], { stdio: 'ignore', detached: true, env: { ...process.env, HOME: home } });
  const file = join(profile, 'DevToolsActivePort');
  for (let waited = 0; !existsSync(file) && waited < 20000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const [port, path] = readFileSync(file, 'utf8').split('\n');
  return {
    endpoint: `ws://127.0.0.1:${port}${path}`,
    /** Every file under the browser's home and profile whose name contains `name`. */
    filesNamed(name: string) {
      const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => (entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.includes(name) ? [join(directory, entry.name)] : []));
      return [...walk(home), ...walk(profile)];
    },
    stop() {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(profile, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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

/** Opens the prototype viewer on a host browser's debug endpoint and waits until it shows a page. */
async function connectViewer(page: import('@playwright/test').Page, endpoint: string) {
  await page.goto('/?hostBrowserDev=1');
  await page.getByLabel('DevTools WebSocket URL').fill(endpoint);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#hb-state')).toHaveText('live', { timeout: 20_000 });
}

test('shows the host page, follows a tap and types text into it', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  let server: Server | undefined;
  let host: Awaited<ReturnType<typeof startHostBrowser>> | undefined;
  try {
    server = createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(fixture));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    host = await startHostBrowser(new URL(baseURL!).origin, fixtureUrl);

    await connectViewer(page, host.endpoint);
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

type Rgb = [number, number, number];
const palette = { red: [221, 0, 0], blue: [0, 0, 221], green: [0, 170, 0], orange: [255, 136, 0], purple: [136, 0, 255], gray: [136, 136, 136] } satisfies Record<string, Rgb>;
async function shows(page: import('@playwright/test').Page, name: keyof typeof palette) {
  const [r, g, b] = palette[name];
  await expect.poll(async () => {
    const c = await colorAt(page, pixel(0.5, 0.25));
    return Math.abs(c.r - r) < 70 && Math.abs(c.g - g) < 70 && Math.abs(c.b - b) < 70;
  }, { timeout: 15_000, message: `the page is ${name}` }).toBe(true);
}

/** A site for the host browser to visit. Each page is one flat colour, so the canvas shows which page is up. */
async function startSite() {
  let loads = 0, fileRequests = 0;
  const page = (title: string, background: string, body = '', script = '') => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html{background:${background}}body{margin:0}a,input{display:block;position:fixed;left:0;right:0;top:0;height:100%;opacity:0}</style>${body}<script>${script}</script>`;
  const pages: Record<string, () => string> = {
    '/a': () => page('Page A', '#d00', '<a href="/popup" target="_blank" style="height:50%"></a><a href="/b" style="top:50%;height:50%"></a>'),
    '/b': () => page('Page B', '#00d'),
    '/popup': () => page('Popup', '#0a0'),
    '/reload': () => page('Counter', ++loads % 2 ? '#f80' : '#80f'),
    '/dialogs': () => page('Dialogs', '#888', '', "document.addEventListener('click', () => { document.documentElement.style.background = confirm('Delete the repository?') ? '#0a0' : '#00d'; });"),
    '/download': () => page('Download', '#888', '<a href="/file" download></a>'),
    '/chooser': () => page('Chooser', '#888', '<input type=file>'),
  };
  const server = createServer((request, response) => {
    if (request.url === '/file') {
      fileRequests++;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=x.bin' }).end('not for the host or the device');
    } else if (pages[request.url!]) response.writeHead(200, { 'content-type': 'text/html' }).end(pages[request.url!]());
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, url: `http://127.0.0.1:${port}`, fileRequests: () => fileRequests, stop: () => new Promise(resolve => server.close(resolve)) };
}

/** Starts the host browser on `path` of a new site and opens the viewer on it. */
async function openViewer(page: import('@playwright/test').Page, baseURL: string, path: string) {
  const site = await startSite();
  const host = await startHostBrowser(new URL(baseURL).origin, `${site.url}${path}`);
  await connectViewer(page, host.endpoint);
  return { site, host, stop: async () => { host.stop(); await site.stop(); } };
}
/** A toolbar button, by its exact name: a tab's own button is named after its page, which can contain the same word. */
const control = (page: import('@playwright/test').Page, name: string) => page.getByRole('button', { name, exact: true });
const addressBar = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Address' });
const tabList = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Tabs' });
/** The button that shows a tab; its name starts with the page's title, which tells it from the tab's close button. */
const tab = (page: import('@playwright/test').Page, title: string) => tabList(page).getByRole('button', { name: new RegExp(`^${title}`) });
async function goTo(page: import('@playwright/test').Page, typed: string) {
  await addressBar(page).fill(typed);
  await addressBar(page).press('Enter');
}

test('navigates by link and by typed address, opens a second tab through a link, switches, goes back and reloads', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const { site, stop } = await openViewer(page, baseURL!, '/a');
  try {
    await shows(page, 'red');
    await expect(addressBar(page)).toHaveValue(`${site.url}/a`);
    await expect(tabList(page).getByRole('listitem')).toHaveCount(2); // the page, and the button that opens another
    await expect(tab(page, 'Page A')).toBeVisible();
    await expect(control(page, 'Back')).toBeDisabled();

    // A link in the page, then back and forward through the history.
    await tapAt(page, pixel(0.4, 0.85));
    await shows(page, 'blue');
    await expect(addressBar(page)).toHaveValue(`${site.url}/b`);
    await expect(tab(page, 'Page B')).toBeVisible();
    await control(page, 'Back').click();
    await shows(page, 'red');
    await expect(addressBar(page)).toHaveValue(`${site.url}/a`);
    await expect(control(page, 'Forward')).toBeEnabled();
    await control(page, 'Forward').click();
    await shows(page, 'blue');
    await control(page, 'Back').click();
    await shows(page, 'red');

    // A typed address with no scheme: a loopback host gets http.
    await goTo(page, `127.0.0.1:${site.port}/b`);
    await shows(page, 'blue');
    await expect(addressBar(page)).toHaveValue(`${site.url}/b`);
    await control(page, 'Back').click();
    await shows(page, 'red');

    // A link that opens a new tab: the tab list gains it, the view follows it, and the first tab is still there to switch back to.
    await tapAt(page, pixel(0.4, 0.15));
    await shows(page, 'green');
    await expect(addressBar(page)).toHaveValue(`${site.url}/popup`);
    await expect(tabList(page).getByRole('listitem')).toHaveCount(3);
    await tab(page, 'Page A').click();
    await shows(page, 'red');
    await expect(addressBar(page)).toHaveValue(`${site.url}/a`);
    await expect(tab(page, 'Page A')).toHaveAttribute('aria-current', 'page');

    // Reload asks the server again.
    await goTo(page, `${site.url}/reload`);
    await shows(page, 'orange');
    await control(page, 'Reload').click();
    await shows(page, 'purple');
    await expect(addressBar(page)).toHaveValue(`${site.url}/reload`);

    // Closing the other tab leaves this one.
    await page.getByRole('button', { name: 'Close tab Popup' }).click();
    await expect(tabList(page).getByRole('listitem')).toHaveCount(2);
    await expect(tab(page, 'Counter')).toBeVisible();

    // An address that is not a web page is refused with a reason, and the page stays.
    for (const [typed, scheme] of [['javascript:alert(1)', 'javascript'], ['file:///etc/passwd', 'file'], ['chrome://settings', 'chrome'], ['data:text/html,x', 'data']]) {
      await goTo(page, typed);
      await expect(page.getByRole('alert')).toContainText(`${scheme}: addresses are refused`);
    }
    await shows(page, 'purple');
    await control(page, 'New tab').click();
    await expect(addressBar(page)).toHaveValue('about:blank');
    await expect(tabList(page).getByRole('listitem')).toHaveCount(3);
  } finally {
    await stop();
  }
});

test('answers the page\'s dialogs and denies a download and a file chooser, reporting each once', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const { site, host, stop } = await openViewer(page, baseURL!, '/dialogs');
  try {
    await shows(page, 'gray');
    await tapAt(page, pixel(0.5, 0.5));
    const question = page.getByRole('alertdialog', { name: 'Page question' });
    await expect(question).toContainText('Delete the repository?');
    await expect(question).toContainText('Text from the page, not from lazysh');
    await question.getByRole('button', { name: 'Cancel' }).click();
    await shows(page, 'blue');
    await tapAt(page, pixel(0.5, 0.5));
    await page.getByRole('alertdialog', { name: 'Page question' }).getByRole('button', { name: 'OK' }).click();
    await shows(page, 'green');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await goTo(page, `${site.url}/download`);
    await shows(page, 'gray');
    await expect(tab(page, 'Download')).toBeVisible();
    await tapAt(page, pixel(0.5, 0.5));
    await expect(page.getByText('A download was blocked')).toHaveCount(1);
    await tapAt(page, pixel(0.5, 0.5));
    await expect.poll(() => site.fileRequests(), { message: 'the page tried twice' }).toBe(2);
    await page.waitForTimeout(500);
    await expect(page.getByText('A download was blocked')).toHaveCount(1);
    expect(host.filesNamed('x.bin'), 'nothing was written on the host').toEqual([]);

    await goTo(page, `${site.url}/chooser`);
    await expect(tab(page, 'Chooser')).toBeVisible();
    await tapAt(page, pixel(0.5, 0.5));
    await expect(page.getByText('A file chooser was blocked')).toHaveCount(1);
    await page.getByRole('status').getByRole('button', { name: 'Dismiss' }).last().click();
    await expect(page.getByText('A file chooser was blocked')).toHaveCount(0);
    await expect(page.getByText('A download was blocked')).toHaveCount(1);
  } finally {
    await stop();
  }
});

test('the viewer is not part of the normal app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Host browser prototype')).toHaveCount(0);
  await page.goto('/?hostBrowserDev=0');
  await expect(page.getByText('Host browser prototype')).toHaveCount(0);
});
