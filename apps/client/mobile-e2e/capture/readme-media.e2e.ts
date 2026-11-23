import {$, browser} from '@wdio/globals';
import {execFileSync, spawn} from 'node:child_process';
import {cpSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {connectOwnedHost, fillAndConnect} from '../pageobjects/connect-owned-host';
import SideMenu from '../pageobjects/components/side-menu.component';
import Terminal from '../pageobjects/terminal.page';
import Toolbar from '../pageobjects/components/toolbar.component';
import {resetApp} from '../support/app';
import {readEndpoint, type HostKind} from '../support/hosts';
import {screenBox} from '../support/gestures';
import {inWebView} from '../support/contexts';
import type {Keyframe} from '../../bench/readmeZoom';

/**
 * The README screenshots and clips: the real app on the Waydroid guest, driven through its real UI against the owned tmux host that
 * readme-capture-run.sh starts (account "demo", a scratch home with harmless files). Run it only through that script, which also sets the
 * variables below; the runbook is docs/how-to/capture-readme-media.md. Each clip is a raw `screenrecord` that readmeZoom.ts then crops,
 * eases and zooms with ffmpeg, and readme-capture.sh turns into a GIF; nothing is edited by hand.
 */
const env = (name: string) => process.env[name] ?? (() => { throw new Error(`${name} is not set: run this spec through bench/readme-capture-run.sh`); })();
const serial = env('ANDROID_SERIAL'), rawDir = env('README_RAW_DIR'), out = env('README_MEDIA_OUT'), script = env('README_CAPTURE_SCRIPT');
const cropTop = Number(env('README_CROP_TOP')), cropBottom = Number(env('README_CROP_BOTTOM'));
const zoomScript = env('README_ZOOM_SCRIPT');
const HOST = 'dev-box';
const settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const adb = (...args: string[]) => execFileSync('adb', ['-s', serial, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
const shot = (name: string) => execFileSync('sh', [script, 'shot', name], {stdio: 'inherit'});

/** Where an element is on the guest's screen, as fractions of the recorded area (the screen without its status and navigation bars). */
async function focus(select: () => ReturnType<typeof $>) {
  const box = await screenBox(select);
  return {x: Math.min(1, Math.max(0, (box.x + box.width / 2) / 1080)), y: Math.min(1, Math.max(0, (box.y + box.height / 2 - cropTop) / (2400 - cropTop - cropBottom)))};
}
const frame = (t: number, zoom: number, at: {x: number; y: number}): Keyframe => ({t: Number(t.toFixed(3)), zoom, x: at.x, y: at.y});

type Marks = Record<string, number>;
/** Records the screen while `body` runs, then renders <name>.mp4 and <name>.gif from the keyframes `plan` derives from the marks `body` set. */
async function clip(name: string, body: (mark: (label: string) => void) => Promise<void>, plan: (marks: Marks) => Keyframe[]) {
  const raw = join(rawDir, `${name}.mp4`), recorder = spawn('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', '60', '--bit-rate', '8000000', '/sdcard/readme-raw.mp4'], {stdio: 'ignore'});
  await settle(900); // screenrecord needs a moment before its first frame; marks count from here
  const started = Date.now(), marks: Marks = {};
  const mark = (label: string) => { marks[label] = (Date.now() - started) / 1000; };
  try { await body(mark); } catch (error) { adb('shell', 'pkill -2 screenrecord'); shot(`${name}-failed`); throw error; }
  mark('end'); await settle(700);
  adb('shell', 'pkill -2 screenrecord');
  await new Promise<void>(resolve => recorder.once('exit', () => resolve()));
  await settle(500);
  adb('pull', '/sdcard/readme-raw.mp4', raw); adb('shell', 'rm -f /sdcard/readme-raw.mp4');
  const keyframes = join(rawDir, `${name}.keyframes.json`), mp4 = join(out, `${name}.mp4`);
  // A plan may ask for a keyframe before the recording began or too close to the one before: such a keyframe is dropped, not bent.
  const planned = plan(marks).filter((keyframe, i, all) => keyframe.t >= 0 && (i === 0 || keyframe.t > all[i - 1].t));
  writeFileSync(keyframes, JSON.stringify(planned, null, 1));
  execFileSync('bun', [zoomScript, '--in', raw, '--keyframes', keyframes, '--out', mp4, '--crop-top', String(cropTop), '--crop-bottom', String(cropBottom), '--width', '540'], {stdio: 'inherit'});
  execFileSync('sh', [script, 'gif-from', name, mp4], {stdio: 'inherit', env: {...process.env, README_CROP_TOP: '0', README_CROP_BOTTOM: '0'}});
}

const clickExact = (text: string) => inWebView(async () => { const element = $(`//*[self::button or self::a][normalize-space(.) = "${text}"]`); await element.waitForClickable({timeout: 15_000}); await element.click(); });
const clickText = (text: string) => inWebView(async () => { const element = $(`//*[self::button or self::a or self::summary][contains(normalize-space(.), "${text}")]`); await element.waitForClickable({timeout: 15_000}); await element.click(); });
/** Waits until the terminal's own text holds `text` (the typed command line cannot: callers choose a word only the output has). */
const showsText = (text: string) => inWebView(() => browser.waitUntil(() => browser.execute(word => (document.querySelector('.xterm-rows') as HTMLElement | null)?.innerText.includes(word) ?? false, text), {timeout: 30_000, timeoutMsg: `"${text}" never appeared in the terminal`}));
const positions = new Map<string, {x: number; y: number}>();
const typeLine = async (text: string) => { await Terminal.type(HOST, text); await Toolbar.press('enter'); };
const showsPageText = (text: string) => inWebView(() => browser.waitUntil(() => browser.execute(word => document.body.innerText.includes(word), text), {timeout: 30_000, timeoutMsg: `"${text}" never appeared on the page`}));
/** Adds and connects another owned host from the Connections page, the way a person adds a second server. */
const addHost = async (kind: HostKind, name: string) => {
  const endpoint = await readEndpoint(kind);
  await openMenu(); await clickText('Connections');
  await inWebView(async () => { const add = $('aria/Add host'); await add.waitForClickable(); await add.click(); });
  await fillAndConnect(name, endpoint);
};
/** Opens the side menu unless a page of it (with its bottom navigation) is already in front. */
const openMenu = async () => { if (!await inWebView(() => browser.execute(() => { const nav = document.querySelector('[aria-label="Workspace navigation"]')?.getBoundingClientRect(); return !!nav && nav.width > 0 && nav.left >= 0 && nav.left < window.innerWidth && nav.top >= 0 && nav.top < window.innerHeight; }))) await SideMenu.openByEdgeSwipe(); };

describe('README media', () => {
  before(async () => {
    mkdirSync(rawDir, {recursive: true}); mkdirSync(out, {recursive: true});
    // The tmux host opens in its own scratch directory (its home, as far as the guest can tell): put the demo files there.
    cpSync(env('README_DEMO_HOME'), (await readEndpoint('tmux')).directory, {recursive: true});
    await connectOwnedHost({kind: 'tmux', name: HOST});
    await typeLine("PS1='$ '; clear");
    await settle(2000);
  });
  afterEach(function () { if (this.currentTest?.state === 'failed') shot(`failed-${(this.currentTest.title.match(/\w+/g) ?? []).slice(1, 4).join('-').toLowerCase()}`); });
  after(resetApp);

  it('the live terminal runs a command and streams its output', async () => {
    await clip('terminal-live', async mark => {
      await settle(1500); mark('type'); await Terminal.type(HOST, './build.sh'); mark('typed'); await Toolbar.press('enter'); mark('run');
      await showsText('Finished'); await settle(1800);
    }, marks => {
      const prompt = {x: 0.3, y: 0.1}, log = {x: 0.3, y: 0.16};
      return [frame(0, 1, {x: 0.5, y: 0.5}), frame(marks.type - 0.2, 1, {x: 0.5, y: 0.5}), frame(marks.type + 0.7, 1.8, prompt), frame(marks.run + 0.2, 1.8, prompt),
        frame(marks.run + 1.4, 1.6, log), frame(marks.end - 1.2, 1.6, log), frame(marks.end - 0.1, 1, {x: 0.5, y: 0.5})];
    });
    shot('terminal');
  });

  it('the agent transcript opens as a chat', async () => {
    const path = () => $('input[placeholder="Absolute host path to session.jsonl"]');
    await clip('agent-chat', async mark => {
      await settle(1200); mark('menu'); await openMenu(); await clickText('Workspaces'); await clickExact('Transcript');
      await inWebView(async () => { await path().waitForDisplayed({timeout: 20_000}); });
      positions.set('path', await focus(path));
      mark('path'); await inWebView(async () => { await path().click(); await path().addValue('/home/demo/session.jsonl'); });
      mark('typed'); await inWebView(() => browser.execute(() => (document.activeElement as HTMLElement | null)?.blur()));
      await clickExact('Open transcript'); await showsPageText('db_timeout_ms');
      mark('opened'); await settle(1000);
      await inWebView(async () => { await browser.execute(() => document.querySelector('.chat-messages')?.scrollIntoView({block: 'start', behavior: 'smooth'})); });
      await settle(1200); mark('scrolled'); shot('agent-chat'); await settle(2200);
    }, marks => {
      const input = {x: 0.3, y: positions.get('path')?.y ?? 0.45}, chat = {x: 0.35, y: 0.3}, whole = {x: 0.5, y: 0.5};
      // While the menu pages go by, the view stays on the lower half, where the tool list is: the upper half has host discovery notes the clip is not about.
      const tools = {x: 0.34, y: 0.9};
      return [frame(0, 1, whole), frame(marks.menu - 0.1, 1, whole), frame(marks.menu + 0.6, 1.9, tools), frame(marks.path - 0.1, 1.9, tools), frame(marks.path + 0.8, 1.6, input), frame(marks.typed + 0.8, 1.6, input), frame(marks.opened + 0.5, 1, whole), frame(marks.scrolled, 1, whole),
        frame(marks.scrolled + 0.9, 1.45, chat), frame(marks.end - 0.2, 1.45, chat), frame(marks.end + 0.4, 1, whole)];
    });
  });

  it('an agent asks for approval and the request is allowed from the phone', async () => {
    const directory = (await readEndpoint('tmux')).directory;
    const request = (name: string, pane: string, command: string) => {
      writeFileSync(join(directory, `approval-${name}.json`), JSON.stringify({hook_event_name: 'PermissionRequest', session_id: `approval-${name}`, cwd: '/home/demo/projects/api-server', tool_name: 'Bash', tool_input: {command}}));
      return `TMUX_PANE='${pane}' lazysh-agent approval-request --agent claude --timeout-seconds 240 < "$d/approval-${name}.json" > "$d/decision-${name}.json" &`;
    };
    // The newest request is listed first, so the one to approve is written last.
    writeFileSync(join(directory, 'approvals'), ['d=$(dirname "$0")', request('clean', '%8', 'rm -rf backups/old'), request('push', '%7', 'git push origin fix/health-timeout'), ''].join('\n'));
    await clickExact('Back'); await SideMenu.close();
    await typeLine('sh approvals'); await settle(2000);
    await openMenu(); await clickText('Agents'); await clickText('Activity');
    const allow = () => $('(//button[normalize-space(.)="Allow this request"])[1]');
    await inWebView(async () => { await allow().waitForDisplayed({timeout: 30_000}); });
    await settle(1000);
    shot('agent-approval');
    positions.set('allow', await focus(allow));
    await clip('agent-approval', async mark => {
      await settle(1200); mark('card'); await settle(1800);
      mark('tap'); await inWebView(async () => { await allow().click(); });
      await settle(2000);
    }, marks => {
      const at = positions.get('allow') ?? {x: 0.5, y: 0.5}, card = {x: 0.5, y: Math.max(0.25, at.y - 0.12)}, whole = {x: 0.5, y: 0.5};
      return [frame(0, 1, whole), frame(marks.card - 0.2, 1, whole), frame(marks.card + 0.9, 1.2, card), frame(marks.tap - 0.3, 1.2, card), frame(marks.tap + 0.3, 1.2, card), frame(marks.end - 0.1, 1.2, card), frame(marks.end + 0.4, 1, whole)];
    });
  });

  it('the Connections page lists the host and its application options', async () => {
    await openMenu(); await clickText('Connections'); await settle(1200);
    shot('hosts');
  });

  it('the session manager lists the tmux sessions of the host', async () => {
    await clickText('Workspaces'); await clickText('Open session manager'); await showsPageText('tmux server'); await settle(800);
    shot('sessions');
    await clickExact('Back');
  });

  it('the Files view browses the demo home of a second host', async () => {
    await addHost('sftp', 'files-box');
    await openMenu(); await clickText('Workspaces'); await clickText('Files');
    const path = () => $('//section[@aria-label="Remote files"]//input[not(@type="file")]');
    const entry = (name: string) => $(`//*[@aria-label="Directory entries"]//button[starts-with(normalize-space(.), "${name}")]`);
    await inWebView(async () => { await path().waitForDisplayed({timeout: 20_000}); });
    // The host opens in its scratch directory, which holds the fixture's own files: start the clip inside the demo directory.
    await inWebView(async () => { await path().click(); await browser.keys(['Control', 'a']); await path().addValue(env('README_DEMO_HOME')); });
    await clickExact('Open'); await inWebView(async () => { await entry('projects').waitForDisplayed({timeout: 20_000}); await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur()); });
    await clip('files-browse', async mark => {
      await settle(1500);
      mark('folder'); await inWebView(async () => { await entry('projects').click(); }); await showsPageText('api-server');
      mark('inside'); await settle(1500);
      await inWebView(async () => { await $('aria/Parent directory').click(); await entry('notes.md').waitForDisplayed({timeout: 20_000}); });
      mark('back'); await settle(700);
      await inWebView(async () => { await entry('notes.md').click(); });
      await showsPageText('rotate the staging');
      mark('preview'); await settle(2000);
    }, marks => {
      const list = {x: 0.4, y: 0.22}, preview = {x: 0.36, y: 0.6}, whole = {x: 0.5, y: 0.5};
      return [frame(0, 1, whole), frame(marks.folder - 0.2, 1, whole), frame(marks.folder + 0.6, 1.4, list), frame(marks.back - 0.3, 1.4, list), frame(marks.preview - 0.4, 1.4, list),
        frame(marks.preview + 0.7, 1.5, preview), frame(marks.end - 0.1, 1.5, preview), frame(marks.end + 0.5, 1, whole)];
    });
    shot('files');
  });

  it('Preferences shows the terminal engine choice', async () => {
    await openMenu(); await clickText('Connections'); await clickText('Preferences'); await clickText('Terminal and accessibility');
    const engines = () => $('//*[normalize-space(text())="Engine for new sessions"]/..');
    await clip('terminal-engine', async mark => {
      await settle(1200); mark('scroll');
      await inWebView(async () => { await browser.execute(() => [...document.querySelectorAll('h3')].find(h => h.textContent?.includes('Terminal engine'))?.scrollIntoView({block: 'start', behavior: 'smooth'})); });
      await settle(1200); mark('there'); shot('terminal-engine');
      await positions.set('engines', await focus(engines));
      await inWebView(async () => { await $('//label[normalize-space(.)="xterm.js"] | //button[normalize-space(.)="xterm.js"]').click(); });
      mark('chosen'); await settle(1800);
      await inWebView(async () => { await $('//label[normalize-space(.)="Auto"] | //button[normalize-space(.)="Auto"]').click(); });
    }, marks => {
      const at = positions.get('engines') ?? {x: 0.5, y: 0.5}, whole = {x: 0.5, y: 0.5};
      return [frame(0, 1, whole), frame(marks.there, 1, whole), frame(marks.there + 0.9, 1.3, at), frame(marks.end - 0.1, 1.3, at), frame(marks.end + 0.6, 1, whole)];
    });
  });
});
