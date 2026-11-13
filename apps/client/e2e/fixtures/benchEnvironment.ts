import { test as base, type CDPSession, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { installNativeBridge } from './nativeBridge';

// What the benchmark specs record in the environment block of their result files.
export const root = path.resolve(import.meta.dirname, '../../../..');
export const require = createRequire(import.meta.url);
export const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
export const read = (file: string) => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };

// Chromium counters around a measured window: main-thread time, CPU of every browser process (none without a browser session: an Android WebView has no process list), JS heap and the renderer's resident set.
export type Snapshot = { metrics: Record<string, number>; cpu: Record<string, number>; rssKiB: number | null };
export async function snapshot(cdp: CDPSession, browser: CDPSession | null): Promise<Snapshot> {
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const cpu: Record<string, number> = {};
  let rssKiB: number | null = null;
  for (const proc of browser ? (await browser.send('SystemInfo.getProcessInfo')).processInfo : []) {
    cpu[proc.type] = (cpu[proc.type] ?? 0) + proc.cpuTime;
    // A spare renderer may exist beside the page's; the page's is the largest.
    if (proc.type === 'renderer') rssKiB = Math.max(rssKiB ?? 0, Number(/VmRSS:\s+(\d+)/.exec(read(`/proc/${proc.id}/status`) ?? '')?.[1]) || 0) || null;
  }
  return { metrics, cpu, rssKiB };
}
const ms = (after: number, before: number) => (after - before) * 1000;
export function cost(before: Snapshot, after: Snapshot) {
  const d = (name: string) => ms(after.metrics[name], before.metrics[name]);
  return {
    mainThreadMs: { task: d('TaskDuration'), script: d('ScriptDuration'), layout: d('LayoutDuration'), styleRecalc: d('RecalcStyleDuration') },
    layouts: after.metrics.LayoutCount - before.metrics.LayoutCount,
    styleRecalcs: after.metrics.RecalcStyleCount - before.metrics.RecalcStyleCount,
    processCpuMs: Object.fromEntries(Object.keys(after.cpu).map(type => [type, ms(after.cpu[type], before.cpu[type] ?? 0)])),
    heapUsedMiB: after.metrics.JSHeapUsedSize / 1048576, heapDeltaMiB: (after.metrics.JSHeapUsedSize - before.metrics.JSHeapUsedSize) / 1048576,
    domNodes: after.metrics.Nodes, rendererRssMiB: after.rssKiB === null ? null : after.rssKiB / 1024,
  };
}

/** The synthetic native bridge every benchmark page runs against: no host, no events. */
export async function installBenchBridge(page: Page) {
  await installNativeBridge(page, { reason: 'Synthetic benchmark fixture.', generation: '1' });
  await page.addInitScript(() => { window.nativeFixtureInvoke = async command => (command.startsWith('plugin:event|') ? 1 : undefined); });
}

/** `bun run bench:terminal` against a device: LAZYSH_BENCH_ANDROID is the adb serial (for example the Waydroid guest). The page is then the benchmark page in that device's Android System WebView. */
export const androidSerial = process.env.LAZYSH_BENCH_ANDROID ?? null;
const WEBVIEW_APP = 'app.lazysh.webviewbench';
const adb = (...args: string[]) => execFileSync('adb', ['-s', androidSerial!, ...args], { encoding: 'utf8' }).trim();
const retry = async <T>(attempt: () => Promise<T>, times: number): Promise<T> => {
  for (let left = times; ; left--) {
    try { return await attempt(); } catch (error) { if (left <= 1) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
};
/** The benchmark page's address; a WebView page has no base URL of its own. */
export const benchUrl = (baseURL: string | undefined, query: string) => new URL(`/bench/terminal-bench.html?${query}`, baseURL).href;

/**
 * `test` whose `page` is the desktop Chromium page, or with LAZYSH_BENCH_ANDROID the page of a fresh process of the throwaway WebView host app
 * (bench/android-webview, installed with adb) whose remote-debugging socket is forwarded to Playwright; the benchmark server is
 * reached through `adb reverse`, so the device needs no network access to the host.
 */
export const test = base.extend({
  page: async ({ page, playwright, baseURL }, use) => {
    if (androidSerial === null) return use(page);
    adb('reverse', `tcp:${new URL(baseURL!).port}`, `tcp:${new URL(baseURL!).port}`);
    adb('shell', 'am', 'start', '-S', '-W', '-n', `${WEBVIEW_APP}/.WebActivity`, '--es', 'url', 'about:blank');
    const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${adb('shell', 'pidof', WEBVIEW_APP).split(/\s+/)[0]}`);
    // The debugging socket answers a moment after the process starts.
    const browser = await retry(() => playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`), 20);
    try { await use(browser.contexts()[0].pages()[0]); } finally { await browser.close(); adb('forward', '--remove', `tcp:${port}`); }
  },
});
