import { describe, expect, test } from 'vitest';
import { compareImePair } from './androidImePair';

function pair(): Parameters<typeof compareImePair> {
  const runId = 'lane-20261125T120000Z';
  const environment = {
    device: { serial: 'guest', fingerprint: 'android', wmSize: '1080x1920', wmDensity: '420' },
    hostApp: { package: 'app.lazysh.client', lastUpdateTime: '2026-11-25' },
  };
  const hash = 'a'.repeat(64);
  const apks = [{ name: 'base.apk', sha256: 'c'.repeat(64) }];
  const runs = (ms: number) => Array.from({ length: 5 }, () => ({
    androidDispatchToDisplayCaptureMs: Array<number>(200).fill(ms),
  }));
  return [{
    kind: 'android-packaged-xterm-ssh-echo', runId, environment: structuredClone(environment), apks: structuredClone(apks),
    samples: runs(25).map(run => ({ ...run, ptyColumns: 49, renderedRows: 12, ptyRowsAfterInput: 12, inputSha256: hash })),
  }, {
    kind: 'android-native-stream-correctness', mode: 'commit', runId, environment, apks,
    prepared: { columns: 49, rows: 12, sha256: { commit: hash } },
    submissions: runs(20).map(run => ({ ...run, workload: 'commit' })),
  }];
}

describe('paired Android IME display diagnostics', () => {
  test('summarizes five matched runs for each engine', () => {
    expect(compareImePair(...pair())).toMatchObject({
      grid: { columns: 49, rows: 12 }, xterm: { p50: 25, p95: 25 }, native: { p50: 20, p95: 20 },
    });
  });

  test('rejects mismatched run, guest, app, grid, input and incomplete samples', () => {
    const [xterm, native] = pair();
    expect(() => compareImePair(xterm, { ...native, runId: 'other' })).toThrow(/lane run/);
    native.environment.device.serial = 'other';
    expect(() => compareImePair(xterm, native)).toThrow(/same|share/);
    native.environment.device.serial = 'guest';
    native.environment.hostApp.lastUpdateTime = 'different APK';
    expect(() => compareImePair(xterm, native)).toThrow(/installed app/);
    native.environment.hostApp.lastUpdateTime = '2026-11-25';
    native.apks[0].sha256 = 'd'.repeat(64);
    expect(() => compareImePair(xterm, native)).toThrow(/APK digests/);
    native.apks[0].sha256 = 'c'.repeat(64);
    xterm.samples[0].ptyRowsAfterInput = 13;
    expect(() => compareImePair(xterm, native)).toThrow(/grid/);
    xterm.samples[0].ptyRowsAfterInput = 12;
    xterm.samples[0].inputSha256 = 'b'.repeat(64);
    expect(() => compareImePair(xterm, native)).toThrow(/hash/);
    xterm.samples[0].inputSha256 = 'a'.repeat(64);
    native.submissions[0].androidDispatchToDisplayCaptureMs.pop();
    expect(() => compareImePair(xterm, native)).toThrow(/200 valid/);
  });
});
