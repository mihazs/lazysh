// Compare only the packaged application's single-character SSH IME workload.
import { readFileSync } from 'node:fs';
import { percentile } from './workloads';

type Environment = {
  device: { serial: string; fingerprint: string; wmSize: string; wmDensity: string };
  hostApp: { package: string; lastUpdateTime: string };
};
type Apk = { name: string; sha256: string };
type LaneRecord = { kind: string; runId: string; environment: Environment; apks: Apk[] };
type Sample = { androidDispatchToDisplayCaptureMs: number[] };
type XtermRecord = LaneRecord & {
  samples: (Sample & { ptyColumns: number; renderedRows: number; ptyRowsAfterInput: number; inputSha256: string })[];
};
type NativeRecord = LaneRecord & {
  mode: string;
  prepared: { columns: number; rows: number; sha256: { commit: string } };
  submissions: (Sample & { workload: string })[];
};

export function compareImePair(xterm: XtermRecord, native: NativeRecord) {
  if (xterm.kind !== 'android-packaged-xterm-ssh-echo'
    || native.kind !== 'android-native-stream-correctness' || native.mode !== 'commit') {
    throw new Error('Expected the packaged xterm and native SSH IME records');
  }
  if (!xterm.runId || xterm.runId !== native.runId) throw new Error('The records must share a lane run');
  const { device, hostApp } = xterm.environment;
  const { device: nativeDevice, hostApp: nativeHostApp } = native.environment;
  if (!device.serial || !device.fingerprint || !device.wmSize || !device.wmDensity
    || device.serial !== nativeDevice.serial || device.fingerprint !== nativeDevice.fingerprint
    || device.wmSize !== nativeDevice.wmSize || device.wmDensity !== nativeDevice.wmDensity
    || hostApp.package !== 'app.lazysh.client' || hostApp.package !== nativeHostApp.package
    || !hostApp.lastUpdateTime || hostApp.lastUpdateTime !== nativeHostApp.lastUpdateTime) {
    throw new Error('The records must share a guest, display configuration and installed app');
  }
  if (!xterm.apks?.some(apk => apk.name === 'base.apk')
    || xterm.apks.some(apk => !/^[a-f0-9]{64}$/.test(apk.sha256))
    || JSON.stringify(xterm.apks) !== JSON.stringify(native.apks)) {
    throw new Error('The records must share the installed APK digests');
  }
  const { columns, rows, sha256 } = native.prepared;
  if (!Number.isSafeInteger(columns) || columns <= 0 || !Number.isSafeInteger(rows) || rows <= 0
    || !/^[a-f0-9]{64}$/.test(sha256.commit) || xterm.samples.length !== 5 || native.submissions.length !== 5
    || xterm.samples.some(run => run.ptyColumns !== columns || run.renderedRows !== rows
      || run.ptyRowsAfterInput !== rows || run.inputSha256 !== sha256.commit)
    || native.submissions.some(run => run.workload !== 'commit')) {
    throw new Error('The pair must contain five runs with matching PTY grids and input fixture hashes');
  }
  const summarize = (samples: Sample[]) => {
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const runs = samples.map(({ androidDispatchToDisplayCaptureMs: values }) => {
      if (!Array.isArray(values) || values.length !== 200 || values.some(ms => !Number.isFinite(ms) || ms < 0)) {
        throw new Error('Each run must contain 200 valid echo capture timings');
      }
      const ordered = sorted(values);
      return { p50: percentile(ordered, 0.5), p95: percentile(ordered, 0.95) };
    });
    return { runs, p50: percentile(sorted(runs.map(run => run.p50)), 0.5), p95: percentile(sorted(runs.map(run => run.p95)), 0.5) };
  };
  return {
    kind: 'android-paired-ime-display-diagnostic', runId: xterm.runId, grid: { columns, rows }, inputSha256: sha256.commit,
    xterm: summarize(xterm.samples), native: summarize(native.submissions),
    timing: 'Android dispatch to first echo display capture, including capture overhead',
  };
}

if (import.meta.main) {
  const [xterm, native] = process.argv.slice(2);
  if (!xterm || !native) throw new Error('Usage: bun bench/androidImePair.ts <packaged-xterm.json> <native-commit.json>');
  console.log(JSON.stringify(compareImePair(JSON.parse(readFileSync(xterm, 'utf8')), JSON.parse(readFileSync(native, 'utf8'))), null, 2));
}
