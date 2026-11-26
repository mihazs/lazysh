// What the Android guest's own kernel and SurfaceFlinger say about the app under test, read over adb: the same instruments for
// every engine, so a same-run comparison (docs/architecture/terminal-benchmarks.md, "Same-run comparison on the Waydroid lane")
// never trusts an engine's own counters. Parsers are pure and tested on output recorded from the guest; `androidProbe` wires them to adb.
import { execFileSync } from 'node:child_process';

/** `adb -s <serial> <args>`: stdout as text. */
export type Adb = (...args: string[]) => string;
export const adbFor = (serial: string): Adb => (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

/** Read the APK digests from the installed app, including split APKs when present. */
export function installedApkDigests(adb: Adb, packageName: string) {
  if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Invalid Android package name');
  const paths = adb('shell', 'pm', 'path', packageName).trim().split(/\r?\n/).map(line => {
    const match = /^package:(\/[A-Za-z0-9_./=+~-]+\.apk)$/.exec(line);
    if (!match) throw new Error('Android did not report a safe installed APK path');
    return match[1];
  });
  const digests = paths.map(file => {
    const match = /^([a-f0-9]{64})\s/.exec(adb('shell', 'sha256sum', file));
    if (!match) throw new Error('Android did not report an installed APK digest');
    return { name: file.split('/').at(-1)!, sha256: match[1] };
  });
  if (!digests.some(apk => apk.name === 'base.apk') || new Set(digests.map(apk => apk.name)).size !== digests.length) {
    throw new Error('The installed APK set must have one base and unique splits');
  }
  return digests.sort((a, b) => a.name.localeCompare(b.name));
}

/** The throwaway app that hosts the benchmark page in the guest's WebView (bench/android-webview). */
export const WEBVIEW_HOST = 'app.lazysh.webviewbench';

/** Linux CLK_TCK on Android: /proc counts CPU time in 10 ms ticks. */
const TICK_MS = 10;

/** TOTAL PSS (KiB) of `dumpsys meminfo <pid>`. */
export function parsePssKiB(dump: string): number | null {
  const found = /TOTAL PSS:\s+(\d+)/.exec(dump) ?? /^\s+TOTAL\s+(\d+)/m.exec(dump);
  return found ? Number(found[1]) : null;
}

/** CPU ticks (utime + stime) and start time (ticks since boot) from one /proc/<pid>/stat line; the name in parentheses may hold spaces. */
export function parseStat(line: string): { cpuTicks: number; startTicks: number } | null {
  const fields = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/);
  const [utime, stime, start] = [Number(fields[11]), Number(fields[12]), Number(fields[19])];
  return [utime, stime, start].every(Number.isFinite) ? { cpuTicks: utime + stime, startTicks: start } : null;
}

function parseCount(value: string | undefined): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

/** One layer of `dumpsys SurfaceFlinger --timestats -dump`: the frames it presented, how many of its timeline frames missed their deadline (janky) and the present-to-present histogram (ms bucket to count). */
export type Layer = { uid: number; name: string; frames: number; timelineFrames: number | null; jankyFrames: number | null; present2present: Array<[ms: number, count: number]> };
export function parseTimeStats(dump: string): Layer[] {
  const layers: Layer[] = [];
  // Every layer's block starts at its "displayRefreshRate" line; the global block before them has no uid and is skipped.
  for (const block of dump.split(/^displayRefreshRate = /m)) {
    const uid = /^uid = (\d+)$/m.exec(block), name = /^layerName = (.*)$/m.exec(block), frames = /^totalFrames = (\d+)$/m.exec(block);
    if (!uid || !name || !frames || name[1] === 'none') continue;
    const histogram = /present2present histogram is as below:\n(.*)/.exec(block)?.[1] ?? '';
    const count = (key: string) => parseCount(new RegExp(`^${key} = (\\d+)$`, 'm').exec(block)?.[1]);
    layers.push({ uid: Number(uid[1]), name: name[1], frames: Number(frames[1]), timelineFrames: count('totalTimelineFrames'), jankyFrames: count('jankyFrames'), present2present: [...histogram.matchAll(/(\d+)ms=(\d+)/g)].map(([, ms, count]) => [Number(ms), Number(count)]) });
  }
  return layers;
}

function jankyFramePercent(layers: Layer[]): number | null {
  let total = 0, janky = 0;
  for (const { frames, timelineFrames, jankyFrames } of layers) {
    if (frames === 0 && !timelineFrames) continue;
    if (!timelineFrames || jankyFrames === null || jankyFrames > timelineFrames) return null;
    total += timelineFrames;
    janky += jankyFrames;
  }
  return total > 0 ? 100 * janky / total : null;
}

/** Percentile (nearest bucket, 1 ms resolution below 34 ms) of the histograms of several layers added together; null when no interval was recorded. */
export function histogramPercentile(layers: Layer[], p: number): number | null {
  const merged = new Map<number, number>();
  for (const layer of layers) for (const [ms, count] of layer.present2present) merged.set(ms, (merged.get(ms) ?? 0) + count);
  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const [ms, count] of [...merged].sort((a, b) => a[0] - b[0])) if ((seen += count) >= Math.ceil(total * p)) return ms;
  return null;
}

/** Sum of the per-thread voluntary context switches in the concatenated status files of the threads under /proc/<pid>/task: how often threads blocked, so how often they were woken. */
export const sumVoluntarySwitches = (text: string) => [...text.matchAll(/^voluntary_ctxt_switches:\s+(\d+)/gm)].reduce((sum, m) => sum + Number(m[1]), 0);

/** Software rasterizers named by the guest's GLES string or EGL are the software path, anything else the host's GL (the lane's rule, waydroid-lane.sh). */
export function gpuPath(gles: string, egl: string): 'software' | 'host-gl' | 'unknown' {
  const text = `${gles} ${egl}`.toLowerCase().trim();
  return text === '' ? 'unknown' : /swiftshader|llvmpipe|softpipe|software/.test(text) ? 'software' : 'host-gl';
}

/** The counters over one measured window, for the app process and the WebView renderer processes it started. */
export type Window = {
  windowMs: number; cpuMs: number;
  /** Voluntary context switches of every thread: a proxy for wakeups. */
  wakeups: number;
  /** Frames SurfaceFlinger presented for the app's layers (its window and any SurfaceView) in the window. */
  frames: number;
  frameIntervalMs: { p50: number; p95: number } | null;
  /** Share of the app's timeline frames SurfaceFlinger counted as janky (missed their deadline), in percent; null when it saw none. */
  jankyFramePercent: number | null;
  layers: Array<{ name: string; frames: number }>;
  /** True when a process the window started with had gone by its end (its CPU is lost, so the figures are a lower bound). */
  processSetChanged: boolean;
};
type Reading = { cpuTicks: number; switches: number; pids: number[] };

/** Splits the output of a loop that prints `pid <n>` before each process's text into [pid, text] pairs. */
function sections(dump: string): Array<[pid: number, text: string]> {
  const parts = dump.split(/^pid (\d+)\n/m);
  return Array.from({ length: (parts.length - 1) / 2 }, (_, i) => [Number(parts[1 + 2 * i]), parts[2 + 2 * i]]);
}
const firstLine = (text: string) => text.split('\n')[0] ?? '';

export function androidProbe(adb: Adb, packageName: string, clock: () => number = () => performance.now()) {
  const shell = (script: string) => adb('shell', script);
  /** The app's pid and uid, and the WebView renderer processes it started: they are named after the WebView package, not the app, and are children of webview_zygote, so they are told apart by having started after the app process (a renderer of another app that is still running started earlier). */
  function processes() {
    const rows = shell('ps -A -o PID,UID,NAME').split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m): m is RegExpExecArray => m !== null).map(([, pid, uid, name]) => ({ pid: Number(pid), uid: Number(uid), name }));
    const app = rows.find(row => row.name === packageName);
    if (!app) throw new Error(`${packageName} is not running in the guest`);
    const renderers = rows.filter(row => /sandboxed_process|privileged_process/.test(row.name));
    const started = new Map(sections(shell(`for p in ${[app, ...renderers].map(row => row.pid).join(' ')}; do echo "pid $p"; cat /proc/$p/stat 2>/dev/null; done`)).map(([pid, text]) => [pid, parseStat(firstLine(text))?.startTicks ?? NaN]));
    return { uid: app.uid, pids: [app.pid, ...renderers.filter(row => (started.get(row.pid) ?? NaN) >= (started.get(app.pid) ?? 0)).map(row => row.pid)] };
  }
  function read(pids: number[]): Reading {
    const dump = shell(pids.map(pid => `echo "pid ${pid}"; cat /proc/${pid}/stat 2>/dev/null; grep -h '^voluntary_ctxt_switches' /proc/${pid}/task/*/status 2>/dev/null`).join('; '));
    const reading: Reading = { cpuTicks: 0, switches: 0, pids: [] };
    for (const [pid, text] of sections(dump)) {
      const stat = parseStat(firstLine(text));
      if (!stat) continue;
      reading.pids.push(pid); reading.cpuTicks += stat.cpuTicks; reading.switches += sumVoluntarySwitches(text);
    }
    return reading;
  }

  return {
    processes,
    /** Total PSS of the app and its renderer processes, in KiB. */
    pssKiB() {
      return processes().pids.reduce((sum, pid) => sum + (parsePssKiB(shell(`dumpsys meminfo ${pid}`)) ?? NaN), 0);
    },
    /** Runs `body` and returns its result with the counters of the window it took. */
    async measure<T extends object>(body: () => Promise<T>): Promise<T & { android: Window }> {
      const { uid, pids } = processes();
      shell('dumpsys SurfaceFlinger --timestats -clear -enable >/dev/null');
      const before = read(pids), started = clock();
      try {
        const result = await body();
        const after = read(pids), windowMs = clock() - started, layers = parseTimeStats(shell('dumpsys SurfaceFlinger --timestats -dump')).filter(layer => layer.uid === uid);
        const android: Window = {
          windowMs, cpuMs: (after.cpuTicks - before.cpuTicks) * TICK_MS, wakeups: after.switches - before.switches,
          frames: layers.reduce((sum, layer) => sum + layer.frames, 0),
          frameIntervalMs: layers.some(layer => layer.present2present.some(([, count]) => count > 0)) ? { p50: histogramPercentile(layers, 0.5)!, p95: histogramPercentile(layers, 0.95)! } : null,
          jankyFramePercent: jankyFramePercent(layers),
          layers: layers.map(({ name, frames }) => ({ name, frames })),
          processSetChanged: pids.some(pid => !after.pids.includes(pid)),
        };
        return { ...result, android };
      } finally {
        shell('dumpsys SurfaceFlinger --timestats -disable >/dev/null');
      }
    },
  };
}
