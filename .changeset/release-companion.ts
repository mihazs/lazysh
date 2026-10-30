import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { verifyRelease } from './bun-lock';
import { buildIdentity, companionMaximumBytes, companionTargets, digestFile, stagePackages,
  type CompanionTarget } from './release-artifacts';
import { native } from './release-platform';

function requireCompanion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release companion: ${message}`);
}
async function removePrivateDirectory(directory: string, primary?: { error: unknown }) {
  try { await rm(directory, { recursive: true, force: true }); }
  catch (cleanup) {
    if (primary) throw new AggregateError([primary.error, cleanup], 'Companion acceptance and private cleanup failed');
    throw cleanup;
  }
}
export function companionFormat(target: CompanionTarget, header: Uint8Array) {
  const bytes = Buffer.from(header);
  const spec = companionTargets[target];
  requireCompanion(Object.hasOwn(companionTargets, target) && spec && bytes.length >= 64, 'missing executable header');
  if (spec.os === 'linux') {
    requireCompanion(bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1]))
      && [2, 3].includes(bytes.readUInt16LE(16))
      && bytes.readUInt16LE(18) === (spec.arch === 'x64' ? 62 : 183), 'ELF architecture mismatch');
  } else if (spec.os === 'darwin') {
    requireCompanion(bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(12) === 2
      && bytes.readUInt32LE(4) === (spec.arch === 'x64' ? 0x01000007 : 0x0100000c), 'Mach-O architecture mismatch');
  } else {
    const offset = bytes.readUInt32LE(60);
    requireCompanion(bytes.readUInt16LE(0) === 0x5a4d && offset <= bytes.length - 26
      && bytes.readUInt32LE(offset) === 0x00004550 && bytes.readUInt16LE(offset + 4) === 0x8664
      && (bytes.readUInt16LE(offset + 22) & 2) !== 0 && bytes.readUInt16LE(offset + 24) === 0x20b,
    'PE architecture mismatch');
  }
}
export async function companionNotices() {
  const legalFiles = [
    ['ai-usagebar', '../packages/ai-usagebar-vendor/LICENSE'],
    ['account-usage-adapter', '../packages/account-usage/NOTICE'],
    ['herdr-apache', '../packages/account-usage/licenses/HERDR-APACHE-2.0.txt'],
  ];
  const notices = await Promise.all(legalFiles.map(async ([id, path]) => ({
    id, text: await Bun.file(new URL(path, import.meta.url)).text(),
  })));
  return { schemaVersion: 1, notices };
}
function privateEnvironment(directory: string): NodeJS.ProcessEnv {
  const home = join(directory, 'home'), temporary = join(directory, 'tmp');
  const windows = process.platform === 'win32';
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  requireCompanion(!windows || (system && /^[A-Za-z]:[\\/]/.test(system)), 'Windows system directory unavailable');
  return {
    PATH: windows ? join(system!, 'System32') : '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    LAZYSH_STATE_DIR: join(home, 'state'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    ...(windows ? { SystemRoot: system!, WINDIR: system! } : {}),
  };
}
export async function validateCompanion(target: CompanionTarget, binary: string, version: string) {
  const spec = companionTargets[target];
  requireCompanion(spec && process.platform === spec.os && process.arch === spec.arch, 'matching native runner required');
  const initial = await digestFile(binary, companionMaximumBytes);
  const file = await open(binary, 'r');
  try {
    const header = Buffer.alloc(65_536);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    companionFormat(target, header.subarray(0, bytesRead));
  } finally { await file.close(); }
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-companion-'));
  let primary: { error: unknown } | undefined;
  try {
    await chmod(directory, 0o700);
    for (const child of ['home', 'tmp']) await mkdir(join(directory, child), { mode: 0o700 });
    const env = privateEnvironment(directory);
    if (spec.os === 'linux') {
      const program = await native('/usr/bin/readelf', ['-W', '-l', '-d', binary], env, 10_000);
      requireCompanion(!/\b(?:INTERP|NEEDED)\b/.test(program), 'Linux companion must be statically linked');
    } else if (spec.os === 'darwin') {
      await native('/usr/bin/codesign', ['--verify', '--strict', binary], env, 10_000);
      const signature = await native('/bin/sh', ['-c', 'exec /usr/bin/codesign --display --verbose=2 "$1" 2>&1', 'sh', binary], env, 10_000);
      requireCompanion(/^Signature=adhoc$/m.test(signature), 'companion must report its ad hoc signature accurately');
      const load = await native('/usr/bin/otool', ['-l', binary], env, 10_000);
      const commands = load.split(/^Load command \d+\s*$/m).filter(value => /^\s*cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\s*$/m.test(value));
      const minimum = spec.arch === 'x64' ? '10.15' : '11.0';
      requireCompanion(commands.length === 1
        && (!/LC_BUILD_VERSION/.test(commands[0]) || /^\s*platform (?:MACOS|1)\s*$/m.test(commands[0]))
        && new RegExp(`^\\s*(?:minos|version) ${minimum.replace('.', '\\.')}(?:\\.0)?\\s*$`, 'm').test(commands[0]),
        'unexpected macOS deployment target');
      const libraries = (await native('/usr/bin/otool', ['-L', binary], env, 10_000)).split('\n').slice(1).filter(line => line.trim());
      requireCompanion(libraries.length > 0 && libraries.every(line => /^\s*\/(?:usr\/lib|System\/Library)\//.test(line)),
        'non-system macOS dependency');
    }
    requireCompanion(await native(binary, ['--version'], env, 10_000) === `lazysh-agent ${version}`, 'executable version mismatch');
    const settings = JSON.parse(await native(binary, ['settings', 'show'], env, 10_000));
    requireCompanion(settings?.revision === 0, 'unexpected initial companion settings');
    const state = env.LAZYSH_STATE_DIR!;
    requireCompanion(!await lstat(state).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }),
      'settings read created state');
    const licenses = await companionNotices();
    requireCompanion(isDeepStrictEqual(JSON.parse(await native(binary, ['licenses'], env, 10_000)),
      licenses), 'embedded third-party notices differ');
    // Windows known folders ignore HOME/APPDATA overrides: never probe that real profile.
    // An explicit owned disabled profile is isolated on Linux/macOS only.
    if (spec.os !== 'win32') {
      const example = Bun.TOML.parse(await Bun.file(new URL('../packages/ai-usagebar-vendor/config.example.toml', import.meta.url)).text());
      const sections = Object.entries(example).filter(([, value]) => value && typeof value === 'object'
        && 'enabled' in value && typeof value.enabled === 'boolean');
      requireCompanion(sections.length === 32, 'pinned disabled provider fixture is incomplete');
      const disabled = sections.map(([name]) => `[${name}]\nenabled = false\n`).join('\n')
        + '\n[notifications]\nenabled = false\n';
      const configuration = process.platform === 'darwin' ? join(env.HOME!, 'Library', 'Application Support', 'lazysh')
        : join(env.XDG_CONFIG_HOME!, 'lazysh');
      await mkdir(configuration, { recursive: true, mode: 0o700 });
      const profile = join(configuration, 'account-usage.toml');
      await writeFile(profile, disabled, { mode: 0o600 });
      const profileDigest = await digestFile(profile);
      const noTools = join(directory, 'empty-tools');
      await mkdir(noTools, { mode: 0o700 });
      const usage = JSON.parse(await native(binary, ['account-usage'], { ...env, PATH: noTools }, 10_000));
      requireCompanion(usage?.schemaVersion === 1 && usage.state === 'ready' && usage.source === 'builtin'
        && usage.report?.entries?.length === 0, 'packaged built-in account usage failed');
      requireCompanion(isDeepStrictEqual(await digestFile(profile), profileDigest), 'account usage changed owned configuration');
    }
    const update = ['settings', 'update', '--expected-revision', '0', '--transcript-discovery-enabled', 'false',
      '--recorded-usage-enabled', 'false', '--device-tools-enabled', 'false'];
    const first = JSON.parse(await native(binary, update, env, 10_000));
    requireCompanion(first?.revision === 1 && first.transcriptDiscoveryEnabled === false
      && first.recordedUsageEnabled === false && first.deviceToolsEnabled === false, 'settings update failed');
    let conflict = false;
    try { await native(binary, update, env, 10_000); } catch { conflict = true; }
    requireCompanion(conflict && JSON.parse(await native(binary, ['settings', 'show'], env, 10_000)).revision === 1,
      'stale settings revision was not rejected');
    update[3] = '1';
    requireCompanion(JSON.parse(await native(binary, update, env, 10_000)).revision === 2, 'fresh settings revision failed');
    const event = { schemaVersion: 1, sessionId: 'release-owned', agent: 'Release fixture', project: '/owned-release',
      state: 'working', summary: 'Owned companion acceptance', paneId: '%1' };
    await native(binary, ['ingest', '--agent', 'generic'], env, 10_000, JSON.stringify(event));
    const snapshot = JSON.parse(await native(binary, ['snapshot', '--limit', '1'], env, 10_000));
    requireCompanion(snapshot?.schemaVersion === 1 && snapshot.sessions?.length === 1
      && snapshot.sessions[0].sessionId === event.sessionId && snapshot.sessions[0].agent === event.agent
      && snapshot.sessions[0].state === event.state && snapshot.sessions[0].summary === event.summary
      && snapshot.sessions[0].paneId === event.paneId && snapshot.sessions[0].eventCount === 1, 'staged storage roundtrip failed');
    await native(binary, ['ingest', '--agent', 'generic'], env, 10_000, JSON.stringify({ ...event, state: 'done' }));
    const reopened = JSON.parse(await native(binary, ['snapshot', '--limit', '1'], env, 10_000));
    requireCompanion(reopened?.sessions?.length === 1 && reopened.sessions[0].sessionId === event.sessionId
      && reopened.sessions[0].state === 'done' && reopened.sessions[0].eventCount === 2, 'staged database reopen failed');
    const database = await lstat(join(state, 'events.sqlite3'));
    requireCompanion(database.isFile() && !database.isSymbolicLink() && database.nlink === 1
      && (spec.os === 'win32' || (database.uid === process.getuid!() && (database.mode & 0o777) === 0o600)),
    'unsafe companion database');
    const final = await digestFile(binary, companionMaximumBytes);
    requireCompanion(final.sha256 === initial.sha256 && final.bytes === initial.bytes, 'executable changed during acceptance');
    return final;
  } catch (error) { primary = { error }; throw error; }
  finally { await removePrivateDirectory(directory, primary); }
}
export async function candidateCompanion(target: CompanionTarget, source: string, version: string, directory: string) {
  requireCompanion((await readdir(directory)).length === 0, 'candidate directory must be empty');
  const original = await digestFile(source, companionMaximumBytes);
  const binary = join(directory, process.platform === 'win32' ? 'lazysh-agent.exe' : 'lazysh-agent');
  await copyFile(source, binary); await chmod(binary, 0o700);
  await validateCompanion(target, binary, version);
  const copied = await digestFile(binary, companionMaximumBytes), final = await digestFile(source, companionMaximumBytes);
  requireCompanion(copied.sha256 === original.sha256 && final.sha256 === original.sha256
    && copied.bytes === original.bytes && final.bytes === original.bytes, 'candidate bytes changed');
  // Candidates deliberately have no receipt and cannot enter release aggregation.
  return { ...copied, binary };
}
export async function checkCompanionCopy(target: CompanionTarget, source: string, version: string) {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-companion-candidate-'));
  let primary: { error: unknown } | undefined;
  try {
    const { bytes, sha256 } = await candidateCompanion(target, source, version, directory);
    return { bytes, sha256 };
  } catch (error) { primary = { error }; throw error; }
  finally { await removePrivateDirectory(directory, primary); }
}
export async function stageCompanion(target: CompanionTarget, root: string, source: string, directory: string) {
  const identity = await buildIdentity(root);
  const original = await digestFile(source, companionMaximumBytes);
  await mkdir(directory, { mode: 0o700 });
  const receipt = await stagePackages(identity, target, target.startsWith('macos-') ? 'ad-hoc' : 'unsigned', [source], directory);
  const staged = receipt.files[0], binary = join(directory, staged.name);
  await chmod(binary, 0o700);
  const validated = await validateCompanion(target, binary, identity.version);
  const final = await digestFile(source, companionMaximumBytes);
  requireCompanion(staged.sha256 === original.sha256 && staged.bytes === original.bytes
    && validated.sha256 === staged.sha256 && validated.bytes === staged.bytes
    && final.sha256 === original.sha256 && final.bytes === original.bytes, 'release source bytes changed');
  return { ...staged, binary };
}
if (import.meta.main) {
  const [mode, target, directory, hash, size] = process.argv.slice(2);
  requireCompanion(['check', 'candidate', 'stage', 'verify'].includes(mode) && Object.hasOwn(companionTargets, target), 'unknown mode or companion target');
  const selected = target as CompanionTarget, root = resolve('.');
  const spec = companionTargets[selected];
  const binary = join(root, 'target', spec.triple, 'release', spec.os === 'win32' ? 'lazysh-agent.exe' : 'lazysh-agent');
  let validated;
  if (mode === 'verify') {
    requireCompanion(directory && hash?.length === 64 && /^[a-f0-9]+$/.test(hash)
      && String(Number(size)) === size && Number(size) > 0 && Number(size) <= companionMaximumBytes, 'invalid acceptance binding');
    await verifyRelease(root);
    validated = await validateCompanion(selected, resolve(directory), (await Bun.file(join(root, 'package.json')).json()).version);
    requireCompanion(validated.sha256 === hash && validated.bytes === Number(size), 'staged bytes changed across native owner tests');
  } else if (mode === 'stage') {
    requireCompanion(directory, 'release output directory required');
    validated = await stageCompanion(selected, root, binary, resolve(directory));
  } else {
    await verifyRelease(root);
    const version = (await Bun.file(join(root, 'package.json')).json()).version;
    if (mode === 'candidate') {
      requireCompanion(directory, 'private candidate directory required');
      await mkdir(resolve(directory), { mode: 0o700 });
      validated = await candidateCompanion(selected, binary, version, resolve(directory));
    } else {
      requireCompanion(directory === undefined, 'candidate checks do not accept a publication directory');
      validated = await checkCompanionCopy(selected, binary, version);
    }
  }
  if (process.env.GITHUB_OUTPUT && 'binary' in validated) {
    requireCompanion(typeof validated.binary === 'string' && !/[\r\n]/.test(validated.binary), 'invalid owned executable path');
    await appendFile(process.env.GITHUB_OUTPUT, `binary=${validated.binary}\nsha256=${validated.sha256}\nbytes=${validated.bytes}\n`);
  }
  console.info(`Companion ${mode === 'stage' ? 'release' : mode === 'verify' ? 'post-test' : 'candidate'} validation passed: ${target} bytes=${validated.bytes} sha256=${validated.sha256}`);
}
