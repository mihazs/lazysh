import { join, sep } from 'node:path';

// Bun 1.3.14 leaves version-only workspace lock entries stale on install.
// New/renamed packages require a reviewed release change, not inferred ownership.
export const ownedWorkspaces = {
  'apps/agent': '@lazysh/agent',
  'apps/client': '@lazysh/client',
  'apps/notification-service': '@lazysh/notification-service',
  'apps/share-service': '@lazysh/share-service',
  'apps/transcription-service': '@lazysh/transcription-service',
  'packages/apple-speech': '@lazysh/apple-speech',
  'packages/apple-status': '@lazysh/apple-status',
  'packages/common': '@lazysh/common',
  'packages/credential-vault': '@lazysh/credential-vault',
  'packages/display-idle': '@lazysh/display-idle',
  'packages/et-transport': '@lazysh/et-transport',
  'packages/mosh-transport': '@lazysh/mosh-transport',
  'packages/notification-client': '@lazysh/notification-client',
  'packages/parakeet-runtime': '@lazysh/parakeet-runtime',
  'packages/push-registration': '@lazysh/push-registration',
} as const;

function requireRelease(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release consistency: ${message}`);
}

const stable = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && Bun.semver.satisfies(value, '*');

export function androidVersionCode(version: unknown): number {
  requireRelease(stable(version), 'invalid stable Android version');
  const [major, minor, patch] = version.split('.').map(BigInt);
  const code = major * 1_000_000n + minor * 1_000n + patch;
  requireRelease(minor <= 999n && patch <= 999n && code >= 1n && code <= 2_100_000_000n,
    'Android version must have minor/patch <= 999 and versionCode between 1 and 2100000000');
  return Number(code);
}

const androidMetadataPath = 'apps/client/android-version.properties';
const androidMetadata = (version: string) => `versionName=${version}\nversionCode=${androidVersionCode(version)}\n`;

function verifyAndroidConfig(config: any) {
  const android = config.bundle?.android;
  if (android === undefined) return;
  requireRelease(android !== null && typeof android === 'object' && !Array.isArray(android)
    && ['versionCode', 'version-code'].every(key => !Object.hasOwn(android, key))
    && ['autoIncrementVersionCode', 'auto-increment-version-code'].every(key => !Object.hasOwn(android, key) || android[key] === false),
  'Android version-code overrides and auto-increment are not allowed');
}

async function inspect(root: string, allowPreviousVersion: boolean) {
  const json = (path: string) => Bun.file(join(root, path)).json();
  const toml = async (path: string) => Bun.TOML.parse(await Bun.file(join(root, path)).text()) as any;
  const cargo = await toml('Cargo.toml');
  const version = cargo.workspace?.package?.version;
  const tooling = await json('package.json');
  requireRelease(stable(version) && tooling.name === 'lazysh' && tooling.version === version && tooling.private === true, 'invalid or mismatched product version');
  const config = await json('.changeset/config.json');
  requireRelease(JSON.stringify(config.fixed) === '[["@lazysh/*"]]' && config.baseBranch === 'main'
    && config.privatePackages?.version === true && config.privatePackages?.tag === false
    && Array.isArray(config.ignore) && config.ignore.length === 0, 'unexpected release group');
  const paths = Object.keys(ownedWorkspaces);
  const scan = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: root })]
    .map(path => path.split(sep).join('/'));
  const present = scan('{apps,packages}/*/package.json').map(path => path.slice(0, -13));
  requireRelease(present.length === paths.length && present.every(path => paths.includes(path)), 'unexpected workspace paths');
  const lockText = await Bun.file(join(root, 'bun.lock')).text();
  const lock = Bun.JSONC.parse(lockText);
  requireRelease(lock.lockfileVersion === 1 && (lock.configVersion === 0 || lock.configVersion === 1) && lock.workspaces
    && lock.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages), 'unsupported Bun lock schema');
  const keys = Object.keys(lock.workspaces);
  requireRelease(keys.length === paths.length + 1 && keys.every(path => path === '' || paths.includes(path)), 'unexpected lock workspace paths');
  requireRelease(lock.workspaces['']?.name === tooling.name && !('version' in lock.workspaces['']), 'unexpected tooling lock metadata');
  const nativeLock = await toml('Cargo.lock');
  const nativeMembers = new Set(cargo.workspace.members);
  requireRelease(cargo.workspace.members.length === paths.length && nativeMembers.size === paths.length, 'unexpected native membership');
  const oldVersions = new Set<string>();
  for (const [path, name] of Object.entries(ownedWorkspaces)) {
    const pkg = await json(`${path}/package.json`);
    requireRelease(pkg.name === name && pkg.private === true && pkg.version === version, 'mismatched owned manifest');
    const previous = lock.workspaces[path];
    requireRelease(previous?.name === name && stable(previous.version), 'invalid lock workspace metadata');
    requireRelease(allowPreviousVersion ? Bun.semver.order(previous.version, version) <= 0 : previous.version === version, 'mismatched lock version');
    oldVersions.add(previous.version);
    const member = path === 'apps/client' ? `${path}/src-tauri` : path;
    requireRelease(nativeMembers.delete(member), 'missing native workspace member');
    const native = (await toml(`${member}/Cargo.toml`)).package;
    requireRelease(native.version?.workspace === true && Object.keys(native.version).length === 1, 'native version must inherit');
    const locked = nativeLock.package.filter((entry: any) => entry.name === native.name);
    requireRelease(locked.length === 1 && locked[0].version === version, 'mismatched Cargo lock version');
  }
  requireRelease(nativeMembers.size === 0 && oldVersions.size === 1, 'inconsistent release membership or previous versions');
  const tauriBase = 'apps/client/src-tauri/tauri.conf.json';
  const baseConfig = await json(tauriBase);
  requireRelease(baseConfig.version === '../package.json', 'Tauri version must use the client manifest path');
  verifyAndroidConfig(baseConfig);
  for (const path of scan('apps/client/src-tauri/tauri*.conf.json')) {
    if (path !== tauriBase) {
      const config = await json(path);
      requireRelease(!('version' in config), 'platform Tauri version overrides are not allowed');
      verifyAndroidConfig(config);
    }
  }
  const expectedAndroid = androidMetadata(version);
  const previousAndroid = await Bun.file(join(root, androidMetadataPath)).text();
  const permitted = allowPreviousVersion ? [version, ...oldVersions] : [version];
  requireRelease(permitted.some(value => previousAndroid === androidMetadata(value)), 'invalid or mismatched Android version metadata');
  return { lock, lockText, version, expectedAndroid, previousAndroid };
}

export async function verifyRelease(root = process.cwd()) {
  await inspect(root, false);
}

async function synchronizeNativeWorkspaceVersion(root: string) {
  const tooling = await Bun.file(join(root, 'package.json')).json();
  const client = await Bun.file(join(root, 'apps/client/package.json')).json();
  requireRelease(stable(tooling.version) && tooling.version === client.version, 'invalid or mismatched product version');
  const version = tooling.version;
  const cargoPath = join(root, 'Cargo.toml');
  const cargoText = await Bun.file(cargoPath).text();
  const rootVersions = [...cargoText.matchAll(/^(version = ")([^"]+)(")\r?$/gm)];
  requireRelease(rootVersions.length === 1 && stable(rootVersions[0][2]), 'unsupported root Cargo version text');
  const nextCargo = cargoText.replace(rootVersions[0][0], `${rootVersions[0][1]}${version}${rootVersions[0][3]}`);

  const lockPath = join(root, 'Cargo.lock');
  const lockText = await Bun.file(lockPath).text();
  const lock = Bun.TOML.parse(lockText) as any;
  requireRelease(Array.isArray(lock.package), 'unsupported Cargo lock schema');
  let nextLock = lockText;
  for (const path of Object.keys(ownedWorkspaces)) {
    const manifest = path === 'apps/client' ? `${path}/src-tauri` : path;
    const native = Bun.TOML.parse(await Bun.file(join(root, manifest, 'Cargo.toml')).text()) as any;
    const matches = lock.package.filter((entry: any) => entry.name === native.package?.name);
    requireRelease(matches.length === 1 && stable(matches[0].version), 'invalid native lock membership');
    const section = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${native.package.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"\\r?\\nversion = ")${matches[0].version.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}("\\r?$)`, 'm');
    requireRelease(section.test(nextLock), 'unsupported native lock text');
    nextLock = nextLock.replace(section, `$1${version}$2`);
  }
  requireRelease(JSON.stringify(Bun.TOML.parse(nextLock)) !== JSON.stringify(lock) || nextLock === lockText,
    'unexpected native lock mutation');
  // Validate both bounded edits before mutating either native release record.
  if (nextCargo !== cargoText) await Bun.write(cargoPath, nextCargo);
  if (nextLock !== lockText) await Bun.write(lockPath, nextLock);
}

export async function synchronizeWorkspaceVersions(root = process.cwd()) {
  await synchronizeNativeWorkspaceVersion(root);
  const { lock, lockText, version, expectedAndroid, previousAndroid } = await inspect(root, true);
  // JSONC validates the file; these strict matches locate existing metadata only.
  // Reject unfamiliar layouts rather than reprinting resolved dependency data.
  const section = /^  "workspaces": \{\r?\n([\s\S]*?)^  \},?\r?$/m.exec(lockText);
  requireRelease(section, 'unsupported workspace text layout');
  const entries = [...section[1].matchAll(/^    ("(?:[^"\\]|\\.)*"): \{\r?\n[\s\S]*?^    \},?\r?$/gm)];
  requireRelease(entries.length === Object.keys(lock.workspaces).length, 'unsupported workspace entries');
  const seen = new Set<string>();
  let body = section[1];
  for (const entry of entries.reverse()) {
    const path = JSON.parse(entry[1]);
    requireRelease(!seen.has(path) && Object.hasOwn(lock.workspaces, path), 'duplicate or unknown workspace entry');
    seen.add(path);
    const parsed = Bun.JSONC.parse(`{${entry[0]}}`)[path];
    requireRelease(JSON.stringify(parsed) === JSON.stringify(lock.workspaces[path]), 'workspace text disagrees with parsed lock');
    if (path === '') continue;
    const versions = [...entry[0].matchAll(/^      "version": "([^"]+)"(,?)\r?$/gm)];
    requireRelease(versions.length === 1 && versions[0][1] === parsed.version, 'unsupported workspace version text');
    const changed = entry[0].replace(versions[0][0], versions[0][0].replace(`"${parsed.version}"`, `"${version}"`));
    body = body.slice(0, entry.index) + changed + body.slice(entry.index! + entry[0].length);
    lock.workspaces[path].version = version;
  }
  const offset = section.index! + section[0].indexOf('\n') + 1;
  const next = lockText.slice(0, offset) + body + lockText.slice(offset + section[1].length);
  requireRelease(JSON.stringify(Bun.JSONC.parse(next)) === JSON.stringify(lock), 'unexpected lock mutation');
  if (next !== lockText) await Bun.write(join(root, 'bun.lock'), next);
  if (expectedAndroid !== previousAndroid) await Bun.write(join(root, androidMetadataPath), expectedAndroid);
}

if (import.meta.main) await synchronizeWorkspaceVersions();
