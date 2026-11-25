// The xterm.js arm of the same-run engine comparison on the Waydroid lane (docs/architecture/terminal-benchmarks.md, "Same-run
// comparison on the Waydroid lane"): runs the baseline spec (W0 to W4, W9, W12) in the guest's Android System WebView for each renderer
// asked for, and writes one evidence record (schema in androidEvidence.ts) with the guest, the GPU path and the measurements.
// The native engine's driver writes the same record into the same lane run; `androidCompare.ts` then sets them side by side.
// Run it as a lane step so the lock, the guest checks and the run id come with it:
//   waydroid-lane.sh --out <lane.json> --label engine-xterm --bench engine 'cd apps/client && bun bench/androidEngineBench.ts --out "$LAZYSH_LANE_OUT/engine.json"'
// Usage: bun bench/androidEngineBench.ts --out <record.json> [--renderers dom,webgl | --packaged-ssh-echo] [--label <text>] [--run-id <id>] [--serial <adb serial>]
// Needs: the host app (bench/android-webview) installed in the guest and adb; LAZYSH_BENCH_ANDROID or --serial names the guest.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCEPTED_RISK, fromBaseline, type Arm, type BaselineResult, type EvidenceRecord } from './androidEvidence';
import { adbFor, gpuPath, installedApkDigests, WEBVIEW_HOST, type Adb } from './androidProbe';

const client = path.resolve(import.meta.dirname, '..');
const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: client, encoding: 'utf8' }).trim(); } catch { return null; } };

/** The guest and its GPU path, from the guest itself (the same fields the lane records). */
export function guestEnvironment(adb: Adb, serial: string, packageName = WEBVIEW_HOST) {
  const text = (...args: string[]) => adb(...args).trim();
  const prop = (key: string) => text('shell', 'getprop', key) || null;
  const gles = text('shell', 'dumpsys SurfaceFlinger | grep -m1 GLES').replace(/^GLES:\s*/, ''), egl = prop('ro.hardware.egl') ?? '';
  const webview = /Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/.exec(adb('shell', 'dumpsys webviewupdate'));
  const host = adb('shell', `dumpsys package ${packageName}`), vsync = /VSYNC period:\s+(\d+) ns/.exec(adb('shell', 'dumpsys SurfaceFlinger | grep -m1 "VSYNC period"'));
  return {
    device: { serial, model: prop('ro.product.model'), abi: prop('ro.product.cpu.abi'), wmSize: text('shell', 'wm', 'size'), wmDensity: text('shell', 'wm', 'density'), fingerprint: prop('ro.build.fingerprint') },
    androidVersion: { release: prop('ro.build.version.release'), sdk: prop('ro.build.version.sdk') },
    display: { refreshHz: vsync ? Math.round(1e9 / Number(vsync[1])) : null },
    gpuPath: { path: gpuPath(gles, egl), egl: egl || null, gralloc: prop('ro.hardware.gralloc'), glesRenderer: gles || null },
    webview: { package: webview?.[1] ?? null, version: webview?.[2] ?? null },
    hostApp: { package: packageName, lastUpdateTime: /lastUpdateTime=(.*)/.exec(host)?.[1]?.trim() ?? null },
  };
}

function arg(name: string, fallback?: string) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

export function packagedSshEcho(adb: Adb, fixture: string, packageName: string) {
  if (!/^\/data\/local\/tmp\/lazysh-ui-ssh-[a-f0-9]{32}\/fixture\.json$/.test(fixture)) {
    throw new Error('Packaged xterm requires the owned lane SSH fixture');
  }
  const output = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'waitForActivitiesToComplete', 'false',
    '-e', 'class', 'app.lazysh.client.NativeTerminalSessionTest', '-e', 'lazyshSshFixture', fixture,
    '-e', 'lazyshXtermSshEcho', 'true', `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`);
  const receipts = [...output.matchAll(/^INSTRUMENTATION_STATUS: lazyshXtermSshEcho=(.+)$/gm)];
  if (!/^OK \(1 test\)$/m.test(output) || !/^INSTRUMENTATION_CODE: -1$/m.test(output)
    || receipts.length !== 1 || /shortMsg=/.test(output)) {
    throw new Error('Packaged xterm instrumentation did not finish with one echo receipt');
  }
  const sample = JSON.parse(receipts[0][1]);
  if (sample?.engine !== 'xterm' || sample.transport !== 'ssh' || !/^[a-f0-9]{64}$/.test(sample.inputSha256)
    || !Number.isSafeInteger(sample.ptyColumns) || sample.ptyColumns <= 0
    || !Number.isSafeInteger(sample.renderedRows) || sample.renderedRows <= 0 || sample.ptyRowsAfterInput !== sample.renderedRows
    || [sample.androidDispatchToFrameCommitMs, sample.androidDispatchToDisplayCaptureMs].some(timings =>
      !Array.isArray(timings) || timings.length !== 200
      || timings.some(ms => typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0))) {
    throw new Error('Packaged xterm instrumentation returned an invalid frame sample');
  }
  return sample;
}

if (import.meta.main) {
  const out = arg('out'), serial = arg('serial', process.env.LAZYSH_BENCH_ANDROID), renderers = (arg('renderers', 'dom') ?? '').split(',');
  if (!out || !serial || renderers.some(r => !['dom', 'webgl', 'canvas'].includes(r))) {
    console.error('usage: bun bench/androidEngineBench.ts --out <record.json> [--renderers dom,webgl | --packaged-ssh-echo] [--label <text>] [--run-id <id>] [--serial <adb serial>]  (the guest: --serial or LAZYSH_BENCH_ANDROID)');
    process.exit(2);
  }
  if (process.argv.includes('--packaged-ssh-echo')) {
    const packageName = process.env.LAZYSH_LANE_PACKAGE ?? 'app.lazysh.client';
    const runId = process.env.LAZYSH_LANE_RUN_ID;
    if (!runId || !/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Packaged xterm requires a lane identity');
    const adb = adbFor(serial);
    const apks = installedApkDigests(adb, packageName);
    const samples = Array.from({ length: 5 }, () => packagedSshEcho(adb, process.env.LAZYSH_LANE_SSH_FIXTURE ?? '', packageName));
    if (samples.some(sample => sample.ptyColumns !== samples[0].ptyColumns || sample.renderedRows !== samples[0].renderedRows)) {
      throw new Error('Packaged xterm repetitions used different terminal grids');
    }
    if (JSON.stringify(apks) !== JSON.stringify(installedApkDigests(adb, packageName))) {
      throw new Error('Installed APKs changed during the xterm SSH measurements');
    }
    const environment = guestEnvironment(adb, serial, packageName);
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify({ kind: 'android-packaged-xterm-ssh-echo', runId, environment, apks, samples }, null, 2) + '\n');
    process.exit(0);
  }
  const startedAt = new Date().toISOString(), adb = adbFor(serial), environment = guestEnvironment(adb, serial), work = mkdtempSync(path.join(os.tmpdir(), 'engine-bench-'));
  const arms: Arm[] = [], measurements: EvidenceRecord['measurements'] = [];
  try {
    for (const renderer of renderers) {
      const file = path.join(work, `xterm-${renderer}.json`);
      // The release build of the page, the spec's own full scale, in the guest's WebView; one renderer per invocation.
      const run = spawnSync('bun', ['run', 'bench:terminal', '--', 'e2e/terminal-bench.spec.ts', '--project=desktop'], {
        cwd: client, stdio: 'inherit', env: { ...process.env, LAZYSH_BENCH_ANDROID: serial, LAZYSH_BENCH_RENDERER: renderer, LAZYSH_BENCH_WRITE: 'adapter', LAZYSH_BENCH_OUT: file },
      });
      if (run.status !== 0) { console.error(`androidEngineBench: the baseline spec failed for the ${renderer} renderer (exit ${run.status}); no record written`); process.exit(1); }
      const baseline = JSON.parse(readFileSync(file, 'utf8'));
      if (baseline.writePath !== 'adapter' || !Number.isSafeInteger(baseline.adapterWrites) || baseline.adapterWrites <= 0) {
        throw new Error('Android baseline did not verify the adapter write path');
      }
      const adapter = `xterm-${renderer}`;
      arms.push({
        adapter, engine: `xterm.js ${baseline.toolchain.xterm}, ${renderer} renderer`, host: `${WEBVIEW_HOST}: the benchmark page in the Android System WebView ${environment.webview.version}`, gpu: baseline.page.gl ?? null, page: { ...baseline.page, writePath: baseline.writePath, adapterWrites: baseline.adapterWrites },
        notes: 'The app\'s createTerminal() and XtermTerminalAdapter in the benchmark page; the remote echoes at once (zero round trip); latency is the page timestamp of the key or burst to the xterm render callback, not to pixels; CPU, wakeups, frames and PSS are read from the guest (/proc, SurfaceFlinger timestats, dumpsys meminfo), not from the page.',
      });
      measurements.push(...fromBaseline(baseline.results as BaselineResult[], adapter));
    }
    const record: EvidenceRecord = {
      schema: 1, kind: 'android-engine-comparison', runId: arg('run-id', process.env.LAZYSH_LANE_RUN_ID ?? `standalone-${startedAt.replace(/\W/g, '')}`)!, label: arg('label') ?? null, startedAt, finishedAt: new Date().toISOString(),
      source: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') === null ? null : (git('status', '--porcelain') ?? '').length > 0 },
      environment: { ...environment, host: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, os: `${os.type()} ${os.release()}`, loadAverageAtEnd: os.loadavg() } },
      limits: 'Waydroid is the Android acceptance environment for the native-engine release (ADR 0001, Amendment 6): an x86_64 guest on the host GPU, so these figures are not a device result and every acceptedRisk is not measured. The host also runs other work: see loadAverageAtEnd.',
      acceptedRisk: ACCEPTED_RISK, arms, measurements,
    };
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    console.log(`androidEngineBench: ${measurements.length} measurements for ${arms.map(a => a.adapter).join(', ')}, run ${record.runId}, written to ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
