import { join } from 'node:path';

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
  const present = [...new Bun.Glob('{apps,packages}/*/package.json').scanSync({ cwd: root })].map(path => path.slice(0, -13));
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
  requireRelease((await json(tauriBase)).version === '../package.json', 'Tauri version must use the client manifest path');
  for (const path of new Bun.Glob('apps/client/src-tauri/tauri*.conf.json').scanSync({ cwd: root })) {
    if (path !== tauriBase) requireRelease(!('version' in await json(path)), 'platform Tauri version overrides are not allowed');
  }
  return { lock, lockText, version };
}

export async function verifyRelease(root = process.cwd()) {
  await inspect(root, false);
}

export async function synchronizeWorkspaceVersions(root = process.cwd()) {
  const { lock, lockText, version } = await inspect(root, true);
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
}

if (import.meta.main) await synchronizeWorkspaceVersions();
