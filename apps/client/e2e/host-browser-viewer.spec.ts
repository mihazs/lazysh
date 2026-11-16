import {chromium, expect, test, type Page} from '@playwright/test';
import {type ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import type {mountHostBrowser} from './fixtures/HostBrowserHarness';

/**
 * The Host browser tool (docs/host-browser.md, "Viewer"): the real tool and canvas, a real headless Chromium that shows
 * a fixture page, and the real relay between them, `lazysh-agent host-browser serve`. The spec stands in for the app's
 * Tauri bridge (apps/client/src-tauri/src/host_browser.rs): it frames the commands onto the relay's standard input
 * and hands the relay's messages back, one pull at a time.
 * Not covered: the Rust bridge and a real SSH channel (their tests are in src-tauri) and a real device.
 */
declare global {interface Window {hostBrowser: ReturnType<typeof mountHostBrowser>}}

const agent = process.env.LAZYSH_TEST_AGENT_BIN ?? resolve(__dirname, '../../../target/debug/lazysh-agent');
const chrome = [process.env.LAZYSH_TEST_CHROME, chromium.executablePath()].find(path => path && existsSync(path));
const available = existsSync(agent) && !!chrome;
// With CI set a missing relay or browser fails the spec instead of skipping it.
test.skip(!available && !process.env.CI, `needs the companion binary (LAZYSH_TEST_AGENT_BIN, here ${agent}) and a Chromium`);

const fixture = `<!doctype html><meta charset=utf-8><title>Fixture &lt;b&gt;page&lt;/b&gt;</title>
<style>html,body{margin:0;height:100%}#top{height:50%;background:#d00}#bottom{height:50%;background:#00d}</style>
<div id=top></div><div id=bottom></div>
<script>
// Every 120 ms the top half changes, so frames keep coming while the page is shown.
let on = false;
setInterval(() => { on = !on; top_.style.background = on ? '#0a0' : '#d00'; }, 120);
const top_ = document.getElementById('top');
</script>`;

const message = (value: object) => {
  const body = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = 1;
  body.copy(out, 5);
  return out;
};

/** What the Rust bridge does for the tool, on top of a real relay process. */
function relayBridge(state: string, url: string) {
  let relay: ChildProcessWithoutNullStreams | undefined;
  let pending = Buffer.alloc(0);
  const queue: Buffer[] = [];
  const wake: (() => void)[] = [];
  const tally = {frames: 0, exitCode: undefined as number | null | undefined};
  const push = (answer: Buffer) => { queue.push(answer); wake.splice(0).forEach(resume => resume()); };
  return {
    tally,
    get running() { return relay !== undefined && tally.exitCode === undefined; },
    async handle(command: string, args: {viewport?: {width: number; height: number; scale?: number}}) {
      if (command === 'host_browser_start') {
        relay = spawn(agent, ['host-browser', 'serve', '--no-sandbox', ...chrome ? ['--binary', chrome] : []], {env: {...process.env, LAZYSH_STATE_DIR: state}});
        relay.stdout.on('data', (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk]);
          for (;;) {
            const length = pending.length >= 4 ? pending.readUInt32BE(0) : 0;
            if (!length || pending.length < 4 + length) return;
            const answer = pending.subarray(4, 4 + length);
            pending = pending.subarray(4 + length);
            if (answer[0] === 2) tally.frames++;
            push(Buffer.from(answer));
          }
        });
        relay.on('exit', code => { tally.exitCode = code; wake.splice(0).forEach(resume => resume()); });
        relay.stdin.write(message({type: 'open', browser: 'chrome', viewport: args.viewport, url}));
        return 'browser-1';
      }
      if (command === 'host_browser_next') {
        if (!queue.length && tally.exitCode === undefined) await Promise.race([new Promise<void>(resume => wake.push(resume)), new Promise(resume => setTimeout(resume, 15_000))]);
        const answer = queue.shift();
        if (answer) return {base64: answer.toString('base64')};
        if (tally.exitCode !== undefined) throw new Error('The host browser ended');
        return {base64: Buffer.from([0]).toString('base64')};
      }
      if (command === 'host_browser_ack') relay!.stdin.write(message({type: 'ack', sequence: (args as {sequence: number}).sequence, decodeMs: (args as {decodeMs?: number}).decodeMs}));
      // A frame queued before a pause is dropped, as the bridge does.
      if (command === 'host_browser_pause') { relay!.stdin.write(message({type: 'pause'})); queue.splice(0, queue.length, ...queue.filter(answer => answer[0] !== 2)); }
      if (command === 'host_browser_resume') relay!.stdin.write(message({type: 'resume'}));
      if (command === 'host_browser_stop') {
        relay?.stdin.end();
        for (let waited = 0; tally.exitCode === undefined && waited < 8000; waited += 50) await new Promise(resume => setTimeout(resume, 50));
      }
      return undefined;
    },
    kill() { relay?.kill('SIGKILL'); },
  };
}

type Run = {page: Page; state: string; bridge: ReturnType<typeof relayBridge>; fixtureUrl: string};
async function withHostBrowser(page: Page, body: (run: Run) => Promise<void>) {
  const state = mkdtempSync(join(tmpdir(), 'lazysh-host-browser-viewer-'));
  let server: Server | undefined;
  let bridge: ReturnType<typeof relayBridge> | undefined;
  try {
    server = createServer((_, response) => response.writeHead(200, {'content-type': 'text/html'}).end(fixture));
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const fixtureUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}/`;
    execFileSync(agent, ['settings', 'host-browser', 'update', '--expected-revision', '0', '--host-browser-enabled', 'true'], {env: {...process.env, LAZYSH_STATE_DIR: state}});
    bridge = relayBridge(state, fixtureUrl);
    await page.exposeFunction('hostBrowserRelay', (command: string, args: never) => bridge!.handle(command, args));
    await page.goto('/');
    await page.evaluate(async () => {
      const {mountHostBrowser: mount} = await import('/e2e/fixtures/HostBrowserHarness.tsx');
      window.hostBrowser = mount();
    });
    await body({page, state, bridge, fixtureUrl});
  } finally {
    bridge?.kill();
    await new Promise(done => (server ? server.close(done) : done(undefined)));
    rmSync(state, {recursive: true, force: true});
  }
}

const viewState = (page: Page) => page.locator('.host-browser-fixture').getByRole('status');
const profiles = (state: string) => readdirSync(join(state, 'host-browser'), {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => join(state, 'host-browser', entry.name));
const browserRunning = (profile: string) => spawnSync('pgrep', ['-f', profile]).status === 0;
type Rgb = {r: number; g: number; b: number};
const colorAt = (page: Page, x: number, y: number) => page.evaluate(({x, y}) => {
  const canvas = document.querySelector('canvas')!;
  const [r, g, b] = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data;
  return {r, g, b};
}, {x, y});
const isBlue = ({r, g, b}: Rgb) => b > 150 && r < 90 && g < 90;
const isTopHalf = ({r, g, b}: Rgb) => (r > 150 && g < 90 && b < 90) || (g > 100 && r < 90 && b < 90);

test('shows the fixture page through the real relay and leaves no browser or profile behind when it is stopped', async ({page}) => {
  test.setTimeout(120_000);
  await withHostBrowser(page, async ({page, state, bridge, fixtureUrl}) => {
    await expect(viewState(page)).toHaveText('Live', {timeout: 30_000});
    // A blank canvas is transparent black: the fixture's red or green top and blue bottom are what it must show.
    await expect.poll(async () => isTopHalf(await colorAt(page, 0.5, 0.2)) && isBlue(await colorAt(page, 0.5, 0.8)), {timeout: 15_000, message: 'the fixture page is drawn'}).toBe(true);
    // The page's title and address are the relay's, drawn as text and never as markup.
    await expect(page.getByText('Fixture <b>page</b>')).toBeVisible();
    await expect(page.getByText(fixtureUrl)).toBeVisible();
    expect(await page.locator('.host-browser-page b').count()).toBe(0);
    // The picture fits the tool whatever the layout: no sideways scroll, and the canvas inside the viewport.
    const canvas = (await page.locator('canvas').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(canvas.x).toBeGreaterThanOrEqual(0);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(viewport.width);
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const [profile] = profiles(state);
    expect(profile).toBeTruthy();
    expect(browserRunning(profile)).toBe(true);

    await page.getByRole('button', {name: 'Stop browser'}).click();
    await expect(viewState(page)).toHaveText('Closed');
    await expect(page.getByText('The browser was stopped.')).toBeVisible();
    await expect.poll(() => bridge.tally.exitCode, {timeout: 15_000}).toBe(0);
    await expect.poll(() => browserRunning(profile), {timeout: 10_000}).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(profiles(state)).toEqual([]);
  });
});

test('leaving the tool closes the channel, which ends the real browser and removes its profile', async ({page}) => {
  test.setTimeout(120_000);
  await withHostBrowser(page, async ({page, state, bridge}) => {
    await expect(viewState(page)).toHaveText('Live', {timeout: 30_000});
    const [profile] = profiles(state);
    await page.evaluate(() => window.hostBrowser.dispose());
    await expect.poll(() => bridge.tally.exitCode, {timeout: 15_000}).toBe(0);
    await expect.poll(() => browserRunning(profile), {timeout: 10_000}).toBe(false);
    expect(profiles(state)).toEqual([]);
  });
});

test('stops the real relay\'s frames within a second of the page being hidden and draws again when it is shown', async ({page}) => {
  test.setTimeout(120_000);
  await withHostBrowser(page, async ({page, bridge}) => {
    await expect(viewState(page)).toHaveText('Live', {timeout: 30_000});
    const setVisibility = (state: 'visible' | 'hidden') => page.evaluate(state => {
      Object.defineProperty(document, 'visibilityState', {configurable: true, value: state});
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await expect.poll(() => bridge.tally.frames, {message: 'the animated fixture keeps sending frames'}).toBeGreaterThan(3);

    await setVisibility('hidden');
    await expect(viewState(page)).toHaveText('Paused', {timeout: 1000});
    const stopped = bridge.tally.frames;
    await page.waitForTimeout(1500);
    // At most the frames the relay had already sent when it heard the pause arrive after it.
    expect(bridge.tally.frames - stopped).toBeLessThanOrEqual(2);
    const quiet = bridge.tally.frames;
    await page.waitForTimeout(500);
    expect(bridge.tally.frames).toBe(quiet);

    await setVisibility('visible');
    await expect(viewState(page)).toHaveText('Live', {timeout: 10_000});
    await expect.poll(() => bridge.tally.frames, {timeout: 10_000}).toBeGreaterThan(quiet + 2);
    await expect.poll(async () => isTopHalf(await colorAt(page, 0.5, 0.2)), {timeout: 10_000}).toBe(true);
  });
});
