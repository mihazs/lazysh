// Native W0 measurements and W2–W4 screen checks through a placed SSH terminal.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { SshFixture } from '../../../tests/support/sshFixture';
import { guestEnvironment } from './androidEngineBench';
import { ACCEPTED_RISK, fromBaseline, fromMemoryCheckpoints, memorySessionCounts, type BaselineResult, type EvidenceRecord, type MemoryCheckpoint } from './androidEvidence';
import { adbFor, androidProbe, installedApkDigests, type Window } from './androidProbe';
import { screenOf, shellSession, streamWorkload } from './workloads';

const packageName = process.env.LAZYSH_LANE_PACKAGE ?? 'app.lazysh.client';
const variants = ['blink-on', 'blink-off'];
const samplesPerVariant = 3;
const expected = variants.flatMap(variant => Array.from({ length: samplesPerVariant }, (_, sample) => `${variant} ${sample}`));

export function nativeBenchmarkInstrumentationCommand(serial: string, fixture: string, port: number, softwareGpu: boolean, portArgument = 'lazyshIdleBenchPort', extra: string[] = []) {
  return ['adb', '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'waitForActivitiesToComplete', 'false',
    '-e', 'class', 'app.lazysh.client.NativeTerminalSessionTest',
    '-e', 'lazyshSshFixture', fixture,
    ...extra,
    '-e', portArgument, String(port),
    '-e', 'lazyshSoftwareGpu', String(softwareGpu),
    `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`];
}

const streams = [['plain', 4 << 20], ['ansi', 2 << 20], ['redraw', 1500]] as const;
const streamRuns = 5;
const shellBursts = 300;
const inputKeys = 200;
const inputPayloads = {
  input: Array.from({ length: inputKeys }, (_, index) => 'abcdefghij'[index % 10]),
  repeat: Array.from({ length: 150 }, (_, index) => 'abcdefghij'[index % 10]),
  ime: Array.from({ length: inputKeys / 4 }, (_, index) => `word${index}`),
};

const streamDisplayColor = [231, 0, 243];
const rgbValue = (color: number[]) => color.reduce((rgb, channel) => (rgb << 8) | channel, 0);
const displayMarker = (cols: number, color: number[], row = 1) =>
  `\x1b7\x1b[${row};${cols}H\x1b[48;2;${color.join(';')}m \x1b[0m\x1b8`;


type Submission = { streamDisplayMs?: number; streamDisplayBurstsMs?: number[]; workload: string; submittedMs: number; presentedBytes: number; processedBytes: number; burstMs?: number[]; backgroundChunks?: number[]; androidDispatchToDisplayCaptureMs?: number[] };
export function streamSubmissions(output: string): Submission[] {
  const matches = output.matchAll(/^INSTRUMENTATION_STATUS: lazyshNativeBenchmarkSubmission=(.*)$/gm);
  return Array.from(matches, ([, line]) => {
    const sample = JSON.parse(line) as Partial<Submission> | null;
    if (!sample || typeof sample.workload !== 'string' || typeof sample.submittedMs !== 'number'
      || !Number.isFinite(sample.submittedMs) || sample.submittedMs < 0
      || typeof sample.presentedBytes !== 'number' || typeof sample.processedBytes !== 'number'
      || !Number.isSafeInteger(sample.presentedBytes) || !Number.isSafeInteger(sample.processedBytes)
      || sample.processedBytes <= 0 || sample.presentedBytes < sample.processedBytes) {
      throw new Error('Invalid native stream submission sample');
    }
    return sample as Submission;
  });
}

async function readFloodReceipt(path: string): Promise<string> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      return (await readFile(path, 'ascii')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || performance.now() >= deadline) throw error;
      await Bun.sleep(2);
    }
  }
}

async function captureStream(socket: Socket, probe: ReturnType<typeof androidProbe>, gate: string, bursts: number, inputRun: boolean, flood: boolean, background: boolean, progress: number[][], backgroundSessions: number) {
  const input = createInterface({ input: socket });
  const backgroundGate = `${gate}-background`;
  let backgroundRunning = false;
  const workerCounts = () => Promise.all(Array.from({ length: backgroundSessions }, (_, slot) =>
    readFloodReceipt(`${backgroundGate}-${slot + 1}`).then(Number)));
  let backgroundStart: number[] = [];
  try {
    const lines = input[Symbol.asyncIterator]();
    const { android } = await probe.measure(async () => {
      socket.write('go\n');
      for (let burst = 0; burst < Math.max(bursts, 1); burst++) {
        if ((await lines.next()).value !== 'start') throw new Error('Native stream did not request its release');
        if (bursts > 0 && burst === 0) await writeFile(gate, '', { mode: 0o600, flag: 'wx' });
        await writeFile(bursts > 0 ? `${gate}-${burst}` : gate, '', { mode: 0o600, flag: 'wx' });
        if (background && !backgroundRunning) {
          await writeFile(backgroundGate, '', { mode: 0o600, flag: 'wx' });
          backgroundRunning = true;
          if (flood) backgroundStart = await workerCounts();
        }
        if (flood) await readFloodReceipt(gate.replace(/\.go$/, `.armed-${burst}`));
        if (inputRun) socket.write('ready\n');
        if (flood) {
          const offset = await readFloodReceipt(gate.replace(/\.go$/, `.echo-${burst}`));
          if (!/^[1-9][0-9]*$/.test(offset)) throw new Error('Invalid PTY echo watermark');
          socket.write(offset + '\n');
        }
        if ((await lines.next()).value !== 'done') throw new Error('Native stream ended without a completion signal');
      }
      return {};
    });
    if (backgroundRunning) {
      await unlink(backgroundGate);
      backgroundRunning = false;
      if (flood) {
        const counts = (await workerCounts()).map((count, slot) => count - backgroundStart[slot]);
        if (counts.some(count => !Number.isSafeInteger(count) || count <= 0)) throw new Error('Background output did not advance on every SSH session');
        progress.push(counts);
      }
    }
    socket.write('done\n');
    if ((await lines.next()).value !== 'verified') throw new Error('Native stream screen verification did not finish');
    await unlink(gate);
    return android;
  } finally {
    input.close();
    if (backgroundRunning) await unlink(backgroundGate);
  }
}

async function runNative(serial: string, softwareGpu: boolean, mode: 'idle' | 'streams' | 'shell' | 'input' | 'commit' | 'flood' | 'memory', backgroundSessions = 0, xterm = false, display = false) {
  const checkStreams = mode !== 'idle' && mode !== 'memory';
  let xtermObservations: Array<{workload: string; domObservationMs: number; fixtureBytes: number; streamDisplayMs?: number; streamDisplayBurstsMs?: number[]; burstMs?: number[]}> = [];
  const memory: MemoryCheckpoint[] = [];
  const streamOrder = (mode === 'streams' ? streams.map(([kind]) => kind) : mode === 'input' ? (backgroundSessions ? ['input'] : Object.keys(inputPayloads)) : [mode])
    .flatMap(kind => Array<string>(streamRuns).fill(kind));
  const adb = adbFor(serial);
  const probe = androidProbe(adb, packageName);
  const samples: Window[] = [];
  const backgroundProgress: number[][] = [];
  let backgroundHash: string | undefined;
  let prepared: { columns: number; rows: number; bytes: number[]; sha256: Record<string, string> } | undefined;
  let submissions: Submission[] = [];
  let failure: unknown;
  let active = false;
  let gpu: unknown;
  const server = createServer(socket => {
    socket.setEncoding('ascii');
    socket.setTimeout(40_000, () => socket.destroy());
    let admitted = false;
    socket.on('error', error => { if (admitted) failure ??= error; });
    let request = '';
    const receive = async (chunk: string) => {
      request += chunk;
      if (!request.includes('\n') && request.length <= 64) return;
      socket.off('data', receive);
      const geometry = checkStreams ? /^([0-9a-f]{32}) ([0-9]{1,3}) ([0-9]{1,3})\n$/.exec(request) : null;
      const stream = checkStreams && prepared && streamOrder[samples.length];
      const streamRequest = Boolean(stream && request === `${nonce} measure ${stream} ${samples.length}\n`);
      const cycle = Math.max(0, memory.length - 2);
      const memoryRequest = mode === 'memory' && memory.length < memorySessionCounts.length
        && request === `${nonce} memory ${memorySessionCounts[memory.length]} ${cycle}\n`;
      const validRequest = mode === 'memory' ? memoryRequest : checkStreams ? (geometry?.[1] === nonce && !prepared) || streamRequest : request === `${nonce} ${expected[samples.length]}\n`;
      if (active || !validRequest) {
        socket.destroy();
        return;
      }
      admitted = true;
      active = true;
      try {
        if (memoryRequest) {
          const pids = probe.processes().pids.join(',');
          const pssKiB = probe.pssKiB();
          if (!Number.isFinite(pssKiB) || pssKiB <= 0 || probe.processes().pids.join(',') !== pids)
            throw new Error('The Android PSS process set changed or a counter was unavailable');
          memory.push({ sessions: memorySessionCounts[memory.length], cycle, pssKiB });
          if (xterm && memory.length === 1) await writeFile(join(fixture.directory, 'bench-memory.go'), '', { mode: 0o600, flag: 'wx' });
          console.log(`${xterm ? 'Xterm' : 'Native'} PSS measured with ${memory.at(-1)!.sessions} sessions (cycle ${cycle})`);
          socket.end('done\n');
          return;
        }
        if (geometry) {
          const cols = Number(geometry[2]), rows = Number(geometry[3]);
          if (cols < 20 || cols > 200 || rows < 5 || rows > 100) throw new Error('Native stream fixture grid is out of range');
          const screens: Record<string, { rows: string[]; bytes: number; bursts?: number[]; keys?: string[]; checkpoints?: string[][]; displayColors?: number[] }> = {};
          const bytes: number[] = [];
          const sha256: Record<string, string> = {};
          if (mode === 'input' || mode === 'commit') {
            for (const kind of new Set(streamOrder)) {
              const keys = inputPayloads[kind === 'commit' ? 'input' : kind as keyof typeof inputPayloads];
              const data = Buffer.from(keys.join(''));
              const visible = ['lazysh-input-ready', ...data.toString().match(new RegExp(`.{1,${cols}}`, 'g'))!];
              screens[kind] = { rows: [...visible.slice(-rows), ...Array<string>(Math.max(0, rows - visible.length)).fill('')], bytes: data.length, keys };
              bytes.push(data.length);
              sha256[kind] = createHash('sha256').update(data).digest('hex');
            }
          }
          if (mode === 'flood') {
            const keys = inputPayloads.input;
            const visible = keys.join('').match(new RegExp(`.{1,${cols}}`, 'g'))!;
            const { data } = streamWorkload('plain', 4 << 20, { cols, rows });
            await copyFile(join(import.meta.dirname, 'nativePtyFlood.py'), join(fixture.directory, 'bench-flood.py'));
            await writeFile(join(fixture.directory, 'bench-flood.bin'), backgroundSessions ? Buffer.alloc(0) : data, { mode: 0o600 });
            screens.flood = { rows: [...visible.slice(-rows), ...Array<string>(Math.max(0, rows - visible.length)).fill('')], bytes: keys.length, keys };
            bytes.push(backgroundSessions ? 0 : data.length);
            sha256.flood = createHash('sha256').update(backgroundSessions ? new Uint8Array() : data).digest('hex');
            if (display) {
              if (cols * (rows - 1) < keys.length) throw new Error('The flood echo must leave the marker row free');
              const colors = keys.map((_, index) => [231, index, 243]);
              const markers = JSON.stringify(colors.map(color => displayMarker(cols, color, rows)));
              await writeFile(join(fixture.directory, 'bench-flood-markers.json'), markers, { mode: 0o600 });
              screens.flood.displayColors = colors.map(rgbValue);
              sha256.floodMarkers = createHash('sha256').update(markers).digest('hex');
              sha256.floodKeys = createHash('sha256').update(keys.join('')).digest('hex');
            }
          }
          if (mode === 'shell') {
            const { bursts, screen } = shellSession(shellBursts, { cols, rows }, 10);
            const colors = display ? bursts.map((_, index) => [231, index % 256, 243 - Math.floor(index / 256)]) : undefined;
            const parts = bursts.map((burst, index) => Buffer.from(burst + (colors ? displayMarker(cols, colors[index]) : '')));
            await Promise.all(parts.map((part, index) => writeFile(join(fixture.directory, `bench-shell-${index}.bin`), part, { mode: 0o600 })));
            const data = Buffer.concat([Buffer.from('$ '), ...parts]);
            bytes.push(data.length);
            sha256.shell = createHash('sha256').update(data).digest('hex');
            screens.shell = { rows: screen, bytes: data.length, bursts: parts.map(part => part.length) };
            if (colors) screens.shell.displayColors = colors.map(rgbValue);
            if (xterm) {
              let transcript = '$ ';
              screens.shell.checkpoints = bursts.map(burst => screenOf(transcript += burst, rows));
            }
          }
          for (const [kind, size] of mode === 'streams' ? streams : []) {
            const workload = streamWorkload(kind, size, { cols, rows });
            const { screen } = workload;
            const data = display
              ? Buffer.concat([workload.data, Buffer.from(displayMarker(cols, streamDisplayColor))])
              : workload.data;
            await writeFile(join(fixture.directory, `bench-${kind}.bin`), data, { mode: 0o600 });
            bytes.push(data.byteLength);
            sha256[kind] = createHash('sha256').update(data).digest('hex');
            screens[kind] = { rows: screen, bytes: data.byteLength };
          }
          if (backgroundHash) sha256.background = backgroundHash;
          prepared = { columns: cols, rows, bytes, sha256 };
          if (xterm) await writeFile(join(fixture.directory, 'bench-xterm.grid'), '', { mode: 0o600, flag: 'wx' });
          socket.end(JSON.stringify({ runs: streamRuns, order: streamOrder, screens }) + '\n');
          return;
        }
        const android = stream
          ? await captureStream(socket, probe, join(fixture.directory, `bench-${samples.length}.go`), mode === 'shell' ? shellBursts : mode === 'flood' ? inputKeys : 0, mode === 'input' || mode === 'commit' || mode === 'flood', mode === 'flood', backgroundSessions > 0, backgroundProgress, backgroundSessions)
          : (await probe.measure(async () => {
            await Bun.sleep(30_000);
            return {};
          })).android;
        if (android.processSetChanged) throw new Error('The measured Android process set changed during a window');
        console.log(`${xterm ? 'Xterm' : 'Native'} ${stream || expected[samples.length]} measured`);
        samples.push(android);
        socket.end(stream ? 'verified\n' : 'done\n');
      } catch (error) {
        failure ??= error;
        socket.destroy();
      } finally {
        active = false;
      }
    };
    socket.on('data', receive);
  });

  const fixture = await SshFixture.start(undefined, { shellSeconds: backgroundSessions && display ? 600 : 360 });
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
    if (mode === 'memory' || backgroundSessions) {
      const history = Array.from({ length: 5000 }, (_, index) =>
        `background session line ${String(index).padStart(6, '0')} ${'y'.repeat(30)}\r\n`).join('');
      if (backgroundSessions) backgroundHash = createHash('sha256').update(history).digest('hex');
      await writeFile(join(fixture.directory, 'bench-memory.bin'), history, { mode: 0o600 });
    }
    if (backgroundSessions && display) {
      await writeFile(join(fixture.directory, 'bench-background.sh'), [
        'printf "lazysh-background-ready\\r\\n"',
        `for index in $(seq 0 ${streamRuns - 1}); do`,
        '  gate=bench-$index.go-background',
        '  while [ ! -f "$gate" ]; do sleep .01; done',
        '  chunk=0',
        '  while [ -f "$gate" ]; do',
        '    dd if=bench-memory.bin bs=16384 count=1 status=none || exit',
        '    chunk=$((chunk+1))',
        '    printf "\\r\\nw9-%s-%s\\r\\n" "$index" "$chunk"',
        '    printf "%s\\n" "$chunk" > "$gate-$1.tmp"',
        '    mv "$gate-$1.tmp" "$gate-$1"',
        '    sleep .01',
        '  done',
        'done',
      ].join('\n') + '\n', { mode: 0o600 });
    }
    if (xterm && mode === 'memory') {
      await writeFile(join(fixture.directory, 'no-profile'), [
        'if [ -t 0 ]; then',
        '  stty -opost',
        '  if [ ! -f bench-memory.go ]; then',
        '    printf "%s" "$PS1"',
        '    while [ ! -f bench-memory.go ]; do sleep .02; done',
        '    printf "\\r\\n"',
        '  fi',
        '  cat bench-memory.bin',
        '  printf "lazysh-memory-filled\\r\\n"',
        'fi',
      ].join('\n') + '\n', { mode: 0o600 });
    }
    if (xterm && checkStreams) {
      const commands = streamOrder.flatMap((kind, index) => {
        const gate = `bench-${index}.go`;
        return [
          ...(kind === 'flood' ? ['stty -icanon -echo'] : []),
          `printf 'lazysh-stream-${index}-ready\\r\\n'`,
          `while [ ! -f ${gate} ]; do sleep .01; done`,
          "printf '\\033[2 q\\033[2J\\033[H'",
          ...(kind === 'shell' ? [
            "printf '%s' '$ '",
            `for burst in $(seq 0 ${shellBursts - 1}); do`,
            `  while [ ! -f ${gate}-$burst ]; do sleep .002; done`,
            '  cat bench-shell-$burst.bin',
            'done',
          ] : kind === 'flood' ? [
            `python3 bench-flood.py ${gate} bench-flood.bin ${inputKeys} bench-flood-markers.json`,
            'stty icanon echo',
          ] : [`dd if=bench-${kind}.bin bs=16384 status=none`]),
          `while [ -f ${gate} ]; do sleep .01; done`,
          "printf '\\r\\n'",
        ];
      });
      await writeFile(join(fixture.directory, 'no-profile'), [
        ...(backgroundSessions ? [
          'if [ -t 0 ]; then',
          '  stty -opost',
          '  cat bench-memory.bin',
          '  printf "lazysh-memory-filled\\r\\n"',
          `  for slot in $(seq 1 ${backgroundSessions}); do`,
          '    if mkdir "bench-background-$slot.owner" 2>/dev/null; then exec sh bench-background.sh "$slot"; fi',
          '  done',
          'fi',
        ] : []),
        'if [ -t 0 ] && mkdir bench-xterm.owner 2>/dev/null; then',
        '  stty -opost',
        '  while [ ! -f bench-xterm.grid ]; do',
        '    printf "\\033[2J\\033[Hlazysh-grid %s\\r\\n" "$(stty size)"',
        '    sleep .1',
        '  done',
        ...commands.map(command => `  ${command}`),
        'fi',
      ].join('\n') + '\n', { mode: 0o600 });
    }
    const file = join(fixture.directory, 'native-benchmark.json');
    await writeFile(file, JSON.stringify({ nonce, port, username, privateKey, fingerprint, prompt, challenge, expected: reply }), { mode: 0o600 });
    adb('shell', 'mkdir', '-m', '700', remote);
    directoryCreated = true;
    adb('push', file, `${remote}/fixture.json`);
    filePushed = true;
    adb('shell', 'chmod', '600', `${remote}/fixture.json`);
    const portArgument = mode === 'memory' ? 'lazyshMemoryBenchPort' : checkStreams ? 'lazyshStreamBenchPort' : 'lazyshIdleBenchPort';
    const tester = Bun.spawn(nativeBenchmarkInstrumentationCommand(serial, `${remote}/fixture.json`, address.port, softwareGpu, portArgument, [
      ...(xterm ? ['-e', 'lazyshPackagedXterm', 'true'] : []),
      ...(display ? ['-e', 'lazyshStreamDisplayColor', String(rgbValue(streamDisplayColor))] : []),
      ...(mode === 'commit' || (mode === 'flood' && display) ? ['-e', 'lazyshShowBenchmarkKeyboard', 'true'] : []),
      '-e', 'lazyshBenchmarkRows', process.env.LAZYSH_BENCH_ROWS ?? '0',
      ...(backgroundSessions ? ['-e', 'lazyshBackgroundSessions', String(backgroundSessions)] : []),
    ]), { stdout: 'pipe', stderr: 'inherit' });
    const deadline = setTimeout(() => tester.kill(), mode === 'memory' || backgroundSessions || ((mode === 'shell' || mode === 'flood') && display) ? 600_000 : 360_000);
    try {
      const output = await new Response(tester.stdout).text();
      const code = await tester.exited;
      if (failure) throw failure;
      submissions = streamSubmissions(output);
      if (xterm && checkStreams) {
        xtermObservations = Array.from(output.matchAll(/^INSTRUMENTATION_STATUS: lazyshXtermStreamObservation=(.+)$/gm),
          ([, line]) => JSON.parse(line));
      }
      const observedOrder = xterm ? xtermObservations : submissions;
      const complete = mode === 'memory' ? memory.length === memorySessionCounts.length : checkStreams
        ? prepared && samples.length === streamOrder.length && observedOrder.map(sample => sample.workload).join(',') === streamOrder.join(',')
          && (mode === 'streams' || observedOrder.every(sample => sample.burstMs?.length === (mode === 'shell' ? shellBursts : (mode === 'flood' || mode === 'commit') ? inputKeys : inputPayloads[sample.workload as keyof typeof inputPayloads]?.length)
            && sample.burstMs.every(ms => Number.isFinite(ms) && ms >= 0)))
        : samples.length === expected.length;
      const backgroundComplete = !backgroundSessions || (mode === 'flood' ? backgroundProgress.length === streamRuns : submissions.every(sample =>
        sample.backgroundChunks?.length === backgroundSessions
        && sample.backgroundChunks.every(chunks => Number.isSafeInteger(chunks) && chunks > 0)));
      const displayComplete = mode !== 'commit' || submissions.every(sample =>
        sample.androidDispatchToDisplayCaptureMs?.length === inputKeys
        && sample.androidDispatchToDisplayCaptureMs.every(ms => Number.isFinite(ms) && ms >= 0));
      const streamDisplayComplete = !display || observedOrder.every(sample =>
        (mode === 'shell' || mode === 'flood')
          ? sample.streamDisplayBurstsMs?.length === (mode === 'shell' ? shellBursts : inputKeys) && sample.streamDisplayBurstsMs.every(ms => Number.isFinite(ms) && ms >= 0)
          : typeof sample.streamDisplayMs === 'number' && Number.isFinite(sample.streamDisplayMs) && sample.streamDisplayMs >= 0);
      const xtermComplete = xtermObservations.every(sample => Number.isFinite(sample.domObservationMs) && sample.domObservationMs >= 0
        && sample.fixtureBytes === (mode === 'flood' ? inputKeys : prepared?.bytes[[...new Set(streamOrder)].indexOf(sample.workload)]));
      if (code !== 0 || !/^OK \(1 test\)$/m.test(output) || !complete || !backgroundComplete || !displayComplete || !xtermComplete || !streamDisplayComplete) {
        throw new Error(`The native instrumentation did not finish every requested workload:\n${output}`);
      }
      if (xterm) {
        if (!/^INSTRUMENTATION_STATUS: lazyshPackagedXterm=true$/m.test(output)) throw new Error('The instrumentation did not identify packaged xterm');
      } else {
        const adapter = /^INSTRUMENTATION_STATUS: lazyshNativeBenchmarkGpu=(.*)$/m.exec(output);
        if (!adapter) throw new Error('The native instrumentation did not identify the GPU adapter');
        gpu = JSON.parse(adapter[1]);
      }
    } finally {
      clearTimeout(deadline);
    }
    const workloads = variants.map((variant, index): BaselineResult => ({
      workload: 'W0', title: 'Idle, session open, no output', variant, correct: true,
      runs: samples.slice(index * samplesPerVariant, (index + 1) * samplesPerVariant).map(android => ({ android })),
    }));
    return { gpu, workloads, prepared, submissions, samples, memory, xtermObservations, backgroundProgress };
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
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error('Invalid Android benchmark package ID');
  const serial = process.env.LAZYSH_BENCH_ANDROID;
  const out = process.argv[2];
  const runId = process.env.LAZYSH_LANE_RUN_ID;
  const flags = process.argv.slice(3);
  const softwareGpu = flags.includes('--software-gpu');
  const display = flags.includes('--stream-display');
  const xtermBackground = flags.find(flag => /^--xterm-background-(5|10)$/.test(flag));
  const xtermFlags = flags.filter(flag => flag === xtermBackground || ['--xterm-idle', '--xterm-streams', '--xterm-shell', '--xterm-memory', '--xterm-flood'].includes(flag));
  const xterm = xtermFlags.length > 0;
  const backgroundFlag = flags.find(flag => /^--check-background-(5|10)$/.test(flag));
  const backgroundMode = xtermBackground ?? backgroundFlag;
  const backgroundSessions = backgroundMode ? Number(backgroundMode.split('-').at(-1)) - 1 : 0;
  const checks = flags.filter(flag => flag === backgroundFlag || ['--check-streams', '--check-shell', '--check-input', '--check-commit', '--check-flood', '--check-memory'].includes(flag));
  const mode = (backgroundSessions && display) || flags.includes('--xterm-flood') ? 'flood' : flags.includes('--xterm-memory') ? 'memory' : flags.includes('--xterm-shell') ? 'shell' : flags.includes('--xterm-streams') ? 'streams' : backgroundSessions ? 'input' : checks.length === 1 ? checks[0].slice(8) as 'streams' | 'shell' | 'input' | 'commit' | 'flood' | 'memory' : 'idle';
  if (!serial || !out || !runId || checks.length > 1 || (display && mode !== 'streams' && mode !== 'shell' && mode !== 'flood') || ((xtermBackground || (xterm && mode === 'flood')) && !display) || (xterm && (checks.length > 0 || softwareGpu || xtermFlags.length > 1)) || flags.some(flag => !['--software-gpu', '--stream-display'].includes(flag) && !xtermFlags.includes(flag) && !checks.includes(flag))) {
    throw new Error('Usage: LAZYSH_BENCH_ANDROID=<serial> LAZYSH_LANE_RUN_ID=<id> bun bench/androidNativeBench.ts <out> [--software-gpu | --xterm-idle | --xterm-streams | --xterm-shell | --xterm-memory | --xterm-flood | --xterm-background-5 | --xterm-background-10] [--stream-display] [--check-streams | --check-shell | --check-input | --check-commit | --check-flood | --check-memory | --check-background-5 | --check-background-10]');
  }
  if (process.env.LAZYSH_BENCH_ROWS !== undefined
    && ((mode !== 'commit' && !(mode === 'flood' && display) && !(xterm && (mode === 'streams' || mode === 'shell'))) || !/^[1-9][0-9]{0,2}$/.test(process.env.LAZYSH_BENCH_ROWS))) {
    throw new Error('LAZYSH_BENCH_ROWS requires --check-commit, --xterm-streams, --xterm-shell or a flood display run and a positive row count');
  }
  const startedAt = new Date().toISOString();
  const environment = guestEnvironment(adbFor(serial), serial, packageName);
  const apks = mode === 'commit' || mode === 'idle' || mode === 'streams' || mode === 'shell' || mode === 'memory' || mode === 'flood' ? installedApkDigests(adbFor(serial), packageName) : undefined;
  const { gpu, workloads, prepared, submissions, samples, memory, xtermObservations, backgroundProgress } = await runNative(serial, softwareGpu, mode, backgroundSessions, xterm, display);
  if (apks && JSON.stringify(apks) !== JSON.stringify(installedApkDigests(adbFor(serial), packageName))) {
    throw new Error('Installed APKs changed during the native SSH measurements');
  }
  if (xterm && mode !== 'idle' && mode !== 'memory') {
    await writeFile(out, JSON.stringify({ kind: 'android-packaged-xterm-stream-diagnostic', mode, runId, environment, apks, prepared, displayCapture: display, ...(backgroundSessions ? { sessions: backgroundSessions + 1, backgroundProgress } : {}),
      observations: xtermObservations.map((sample, index) => ({ ...sample, ...(!display && { android: samples[index] }) })) }, null, 2) + '\n');
    process.exit(0);
  }
  if (mode !== 'idle' && mode !== 'memory') {
    await writeFile(out, JSON.stringify({ kind: 'android-native-stream-correctness', mode, runId, environment, gpu, prepared, apks, displayCapture: display, ...(backgroundSessions ? { sessions: backgroundSessions + 1, ...(display && { backgroundProgress }) } : {}), runsPerWorkload: streamRuns,
      submissions: submissions.map((sample, index) => ({ ...sample, ...(!display && { android: samples[index] }) })) }, null, 2) + '\n');
    process.exit(0);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
  const adapter = xterm ? 'xterm-dom' : 'native-wgpu';
  const measurements = mode === 'memory' ? fromMemoryCheckpoints(memory, adapter) : fromBaseline(workloads, adapter);
  const record: EvidenceRecord = {
    schema: 1, kind: 'android-engine-comparison', runId, label: `${xterm ? 'packaged-xterm' : 'native'}-${mode}`, startedAt, finishedAt: new Date().toISOString(),
    source: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' }, environment: { ...environment, installedApks: apks }, acceptedRisk: ACCEPTED_RISK,
    limits: `${mode === 'memory' ? 'W9 memory only, one set of checkpoints per arm.' : 'W0 only.'} A software-rendered emulator run qualifies the harness and does not establish Waydroid targets.`,
    arms: [{ adapter, engine: xterm ? 'Packaged xterm.js' : 'Native terminal', host: packageName, gpu, page: null,
      notes: mode === 'memory'
        ? 'Guest PSS at one fresh SSH session, five and ten filled SSH sessions, and after five open-fill-close cycles.'
        : 'The packaged terminal was connected to an owned SSH shell. Host counters were sampled during six 30-second windows.' }],
    measurements,
  };
  await writeFile(out, JSON.stringify(mode === 'memory' ? { ...record, memory } : record, null, 2) + '\n');
}
