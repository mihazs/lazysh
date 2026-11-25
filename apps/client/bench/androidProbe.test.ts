import { describe, expect, it } from 'vitest';
import { androidProbe, gpuPath, histogramPercentile, installedApkDigests, parsePssKiB, parseStat, parseTimeStats, sumVoluntarySwitches, type Adb } from './androidProbe';

// The texts below are what the Waydroid guest (Android 13, x86_64) printed for these commands, trimmed to the lines that matter.
const meminfo = (total: number) => `** MEMINFO in pid 7198 [app.lazysh.webviewbench] **
 App Summary
                       Pss(KB)                        Rss(KB)
           TOTAL PSS:   ${total}            TOTAL RSS:   216908       TOTAL SWAP PSS:      750
`;
const layer = (uid: number, name: string, frames: number, histogram: string, janky = 0) => `displayRefreshRate = 240 fps
renderRate = 240 fps
uid = ${uid}
layerName = ${name}
packageName =
totalFrames = ${frames}
droppedFrames = 0
Jank payload for this layer:
totalTimelineFrames = ${frames}
jankyFrames = ${janky}
averageFPS = 4.874
present2present histogram is as below:
${histogram}
latch2present histogram is as below:
0ms=1 1ms=0
`;
const global = `SurfaceFlinger TimeStats:
totalFrames = 25
displayRefreshRate = 240 fps
renderRate = 240 fps
totalTimelineFrames = 25
jankyFrames = 9
`;
const stat = (pid: number, name: string, utime: number, stime: number, start: number) => `${pid} (${name}) S 1 1 0 0 -1 4194624 0 0 0 0 ${utime} ${stime} 0 0 10 -10 1 0 ${start} 1 1 18446744073709551615`;

describe('guest parsers', () => {
  it('reads the total PSS of dumpsys meminfo', () => {
    expect(parsePssKiB(meminfo(146087))).toBe(146087);
    expect(parsePssKiB('Applications Memory Usage\nnothing here')).toBeNull();
  });

  it('adds user and system ticks and reads the start time, whatever the process is called', () => {
    expect(parseStat(stat(7198, 'sh.webviewbench', 24, 18, 23228716))).toEqual({ cpuTicks: 42, startTicks: 23228716 });
    expect(parseStat(stat(7048, 'ocessService0:0 (x)', 5, 1, 99))).toEqual({ cpuTicks: 6, startTicks: 99 });
    expect(parseStat('cat: /proc/7/stat: No such file or directory')).toBeNull();
  });

  it('counts the voluntary context switches of every thread', () => {
    expect(sumVoluntarySwitches('voluntary_ctxt_switches:\t2680\nvoluntary_ctxt_switches:\t1\nvoluntary_ctxt_switches:\t30\n')).toBe(2711);
    expect(sumVoluntarySwitches('')).toBe(0);
  });

  it('keeps the layers of the dump with their uid, frames and present intervals, and drops the global block and the unnamed layer', () => {
    const dump = global + layer(10151, 'TID:2099#app.lazysh.webviewbench/app.lazysh.webviewbench.WebActivity#643', 24, '0ms=0 4ms=11 5ms=12 6ms=1') + layer(10151, 'none', 0, '') + layer(10200, 'SurfaceView[other]#9(BLAST)', 7, '16ms=7');
    const layers = parseTimeStats(dump);
    expect(layers.map(l => [l.uid, l.frames])).toEqual([[10151, 24], [10200, 7]]);
    expect(layers[0]).toMatchObject({ timelineFrames: 24, jankyFrames: 0 });
    expect(layers[0].present2present).toEqual([[0, 0], [4, 11], [5, 12], [6, 1]]);
  });

  it('takes a percentile of the histograms of several layers added together, and none when no interval was recorded', () => {
    const layers = parseTimeStats(layer(1, 'a', 10, '4ms=6 5ms=4') + layer(1, 'b', 10, '4ms=2 30ms=8'));
    expect(histogramPercentile(layers, 0.5)).toBe(5);
    expect(histogramPercentile(layers, 0.95)).toBe(30);
    expect(histogramPercentile(parseTimeStats(layer(1, 'c', 0, '0ms=0 1ms=0')), 0.5)).toBeNull();
  });

  it('classifies the GPU path as the lane does', () => {
    expect(gpuPath('AMD, AMD Radeon Graphics (radeonsi, navi14, ACO), OpenGL ES 3.2 Mesa 26.0.8', 'mesa')).toBe('host-gl');
    expect(gpuPath('Google, Android Emulator OpenGL ES Translator (SwiftShader)', 'angle')).toBe('software');
    expect(gpuPath('', '')).toBe('unknown');
  });
});

/** A guest with an app (pid 100, started at tick 1000), its WebView renderer (200, started after it), a spare of ANOTHER app that was already running (300, started before), and CPU that moves between the two reads. */
function guest(overrides: { ticks?: [first: number, second: number]; renderersAfter?: number[] } = {}) {
  const ticks = overrides.ticks ?? [100, 160];
  const calls: string[] = [];
  let reads = 0;
  const adb: Adb = (...args) => {
    const script = args.join(' ');
    calls.push(script);
    if (script.includes('ps -A')) return ' 100 10151 app.lazysh.webviewbench\n 200 99023 com.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0\n 300 99021 com.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0\n';
    if (script.includes('for p in')) return `pid 100\n${stat(100, 'sh.webviewbench', 1, 1, 1000)}\npid 200\n${stat(200, 'ocessService0:0', 1, 1, 1010)}\npid 300\n${stat(300, 'ocessService0:0', 1, 1, 500)}\n`;
    if (script.includes('voluntary_ctxt_switches')) {
      const [app, renderer] = [ticks[reads === 0 ? 0 : 1], reads === 0 ? 10 : 25], wake = reads === 0 ? 1000 : 1500;
      reads++;
      const present = reads === 1 || (overrides.renderersAfter ?? [200]).includes(200);
      return `pid 100\n${stat(100, 'sh.webviewbench', app, 0, 1000)}\nvoluntary_ctxt_switches:\t${wake}\nvoluntary_ctxt_switches:\t5\n` + (present ? `pid 200\n${stat(200, 'ocessService0:0', renderer, 0, 1010)}\nvoluntary_ctxt_switches:\t${wake / 10}\n` : '');
    }
    if (script.includes('--timestats -dump')) return global + layer(10151, 'TID:1#app.lazysh.webviewbench/app.lazysh.webviewbench.WebActivity#1', 12, '4ms=10 5ms=2', 3) + layer(10999, 'SurfaceView[other]#2', 99, '16ms=99');
    if (script.startsWith('shell dumpsys meminfo 100')) return meminfo(100000);
    if (script.startsWith('shell dumpsys meminfo 200')) return meminfo(80000);
    return '';
  };
  return { adb, calls };
}

describe('the probe of one measured window', () => {
  it('reports the CPU, wakeups and frames of the app and the renderer it started, and ignores a renderer that was already running', async () => {
    const { adb, calls } = guest();
    const result = await androidProbe(adb, 'app.lazysh.webviewbench', () => 0).measure(async () => ({ correct: true }));
    expect(result.correct).toBe(true);
    // CPU: app 100 to 160 ticks plus renderer 10 to 25, ten milliseconds a tick. Wakeups: (1500 + 5 + 150) minus (1000 + 5 + 100).
    expect(result.android).toMatchObject({ cpuMs: (60 + 15) * 10, wakeups: 550, frames: 12, frameIntervalMs: { p50: 4, p95: 5 }, jankyFramePercent: 25, processSetChanged: false });
    expect(result.android.layers).toEqual([{ name: expect.stringContaining('WebActivity'), frames: 12 }]);
    expect(calls.join('\n')).not.toMatch(/proc\/300\//);
    // SurfaceFlinger's counters are switched on for the window and off again after it, as the guest was found.
    expect(calls.filter(call => call.includes('--timestats')).map(call => call.replace(/^shell dumpsys SurfaceFlinger /, '').replace(' >/dev/null', ''))).toEqual(['--timestats -clear -enable', '--timestats -dump', '--timestats -disable']);
  });

  it('says so when a process it started with is gone at the end, because its CPU is lost', async () => {
    const result = await androidProbe(guest({ renderersAfter: [] }).adb, 'app.lazysh.webviewbench', () => 0).measure(async () => ({}));
    expect(result.android.processSetChanged).toBe(true);
  });

  it('switches the counters off again and passes the error on when the workload throws', async () => {
    const { adb, calls } = guest();
    await expect(androidProbe(adb, 'app.lazysh.webviewbench').measure(async () => { throw new Error('workload failed'); })).rejects.toThrow('workload failed');
    expect(calls.at(-1)).toContain('--timestats -disable');
  });

  it('sums the PSS of the app and the renderer it started only', () => {
    expect(androidProbe(guest().adb, 'app.lazysh.webviewbench').pssKiB()).toBe(180000);
  });

  it('refuses to measure an app that is not running', () => {
    const adb: Adb = () => ' 1 0 init\n';
    expect(() => androidProbe(adb, 'app.lazysh.webviewbench').pssKiB()).toThrow(/is not running in the guest/);
  });
});


describe('installed Android APK provenance', () => {
  it('hashes the base and every split in canonical order', () => {
    const base = '/data/app/~~abc==/app.lazysh.client-xyz==/base.apk';
    const split = base.replace('base.apk', 'split_config.arm64_v8a.apk');
    const adb: Adb = (...args) => {
      if (args[1] === 'pm') return `package:${split}\r\npackage:${base}\r\n`;
      return `${(args[2] === base ? 'a' : 'b').repeat(64)}  ${args[2]}\n`;
    };
    expect(installedApkDigests(adb, 'app.lazysh.client')).toEqual([
      { name: 'base.apk', sha256: 'a'.repeat(64) },
      { name: 'split_config.arm64_v8a.apk', sha256: 'b'.repeat(64) },
    ]);
  });

  it('rejects paths containing shell syntax and incomplete digests', () => {
    expect(() => installedApkDigests(() => 'package:/data/app/app;other/base.apk', 'app.lazysh.client')).toThrow(/safe installed APK path/);
    expect(() => installedApkDigests((...args) => args[1] === 'pm' ? 'package:/data/app/base.apk' : 'no digest', 'app.lazysh.client')).toThrow(/digest/);
  });
});
