// W0 of the Android native engine comparison. The device opens a placed SSH terminal,
// signals when it is idle, then blocks until the host finishes sampling the guest.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { SshFixture } from '../../../tests/support/sshFixture';
import { guestEnvironment } from './androidEngineBench';
import { ACCEPTED_RISK, fromBaseline, type BaselineResult, type EvidenceRecord } from './androidEvidence';
import { adbFor, androidProbe, type Window } from './androidProbe';

const packageName = 'app.lazysh.client';
const variants = ['blink-on', 'blink-off'];
const samplesPerVariant = 3;
const expected = variants.flatMap(variant => Array.from({ length: samplesPerVariant }, (_, sample) => `${variant} ${sample}`));

async function runIdle(serial: string, softwareGpu: boolean) {
  const adb = adbFor(serial);
  const probe = androidProbe(adb, packageName);
  const samples: Window[] = [];
  let failure: unknown;
  let active = false;
  let gpu: unknown;
  const server = createServer(socket => {
    socket.setEncoding('ascii');
    socket.setTimeout(40_000, () => socket.destroy());
    socket.on('error', error => { failure ??= error; });
    let request = '';
    const receive = async (chunk: string) => {
      request += chunk;
      if (!request.includes('\n') && request.length <= 64) return;
      socket.off('data', receive);
      if (active || request !== `${nonce} ${expected[samples.length]}\n`) {
        socket.destroy();
        return;
      }
      active = true;
      try {
        const { android } = await probe.measure(async () => {
          await Bun.sleep(30_000);
          return {};
        });
        if (android.processSetChanged) throw new Error('The measured Android process set changed during an idle window');
        console.log(`Native W0 ${expected[samples.length]} measured`);
        samples.push(android);
        socket.end('done\n');
      } catch (error) {
        failure ??= error;
        socket.destroy();
      } finally {
        active = false;
      }
    };
    socket.on('data', receive);
  });

  const fixture = await SshFixture.start(undefined, { shellSeconds: 360 });
  const { nonce, port, username, privateKey, fingerprint, prompt, challenge, expected: reply } = fixture;
  const remote = `/data/local/tmp/lazysh-ui-ssh-${nonce}`;
  const forwarded: number[] = [];
  let directoryCreated = false;
  let filePushed = false;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Idle benchmark listener has no TCP port');
    for (const forward of [port, address.port]) {
      adb('reverse', '--no-rebind', `tcp:${forward}`, `tcp:${forward}`);
      forwarded.push(forward);
    }
    const file = join(fixture.directory, 'native-benchmark.json');
    await writeFile(file, JSON.stringify({ nonce, port, username, privateKey, fingerprint, prompt, challenge, expected: reply }), { mode: 0o600 });
    adb('shell', 'mkdir', '-m', '700', remote);
    directoryCreated = true;
    adb('push', file, `${remote}/fixture.json`);
    filePushed = true;
    adb('shell', 'chmod', '600', `${remote}/fixture.json`);
    const tester = Bun.spawn(['adb', '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
      '-e', 'class', 'app.lazysh.client.NativeTerminalSessionTest',
      '-e', 'lazyshSshFixture', `${remote}/fixture.json`,
      '-e', 'lazyshIdleBenchPort', String(address.port),
      '-e', 'lazyshSoftwareGpu', String(softwareGpu),
      `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`],
    { stdout: 'pipe', stderr: 'inherit' });
    const deadline = setTimeout(() => tester.kill(), 360_000);
    try {
      const output = await new Response(tester.stdout).text();
      const code = await tester.exited;
      if (failure) throw failure;
      if (code !== 0 || !/^OK \(1 test\)$/m.test(output) || samples.length !== expected.length) {
        throw new Error(`The native idle instrumentation measured ${samples.length}/${expected.length} windows and did not finish successfully:\n${output}`);
      }
      const adapter = /^INSTRUMENTATION_STATUS: lazyshNativeBenchmarkGpu=(.*)$/m.exec(output);
      if (!adapter) throw new Error('The native idle instrumentation did not identify the GPU adapter');
      gpu = JSON.parse(adapter[1]);
    } finally {
      clearTimeout(deadline);
    }
    const workloads = variants.map((variant, index): BaselineResult => ({
      workload: 'W0', title: 'Idle, session open, no output', variant, correct: true,
      runs: samples.slice(index * samplesPerVariant, (index + 1) * samplesPerVariant).map(android => ({ android })),
    }));
    return { gpu, workloads };
  } finally {
    server.close();
    try {
      if (filePushed) adb('shell', 'unlink', `${remote}/fixture.json`);
      if (directoryCreated) adb('shell', 'rmdir', remote);
    } finally {
      try {
        for (const forward of forwarded) adb('reverse', '--remove', `tcp:${forward}`);
      } finally {
        await fixture.stop();
      }
    }
  }
}

if (import.meta.main) {
  const serial = process.env.LAZYSH_BENCH_ANDROID;
  const out = process.argv[2];
  const runId = process.env.LAZYSH_LANE_RUN_ID;
  const softwareGpu = process.argv[3] === '--software-gpu';
  if (!serial || !out || !runId || (process.argv[3] && !softwareGpu)) {
    throw new Error('Usage: LAZYSH_BENCH_ANDROID=<serial> LAZYSH_LANE_RUN_ID=<id> bun bench/androidNativeBench.ts <out> [--software-gpu]');
  }
  const startedAt = new Date().toISOString();
  const environment = guestEnvironment(adbFor(serial), serial, packageName);
  const { gpu, workloads } = await runIdle(serial, softwareGpu);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
  const measurements = fromBaseline(workloads, 'native-wgpu');
  const record: EvidenceRecord = {
    schema: 1, kind: 'android-engine-comparison', runId, label: 'native-idle', startedAt, finishedAt: new Date().toISOString(),
    source: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' }, environment, acceptedRisk: ACCEPTED_RISK,
    limits: 'W0 only. A software-rendered emulator run qualifies the harness and does not establish Waydroid targets.',
    arms: [{ adapter: 'native-wgpu', engine: 'Native terminal', host: packageName, gpu, page: null,
      notes: 'The placed native terminal was connected to an owned SSH shell. Host counters were sampled during six 30-second windows.' }],
    measurements,
  };
  await writeFile(out, JSON.stringify(record, null, 2) + '\n');
}
