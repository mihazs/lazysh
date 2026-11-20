import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const script = join(project, '.github/scripts/herdr-notices.ts');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const registry = 'registry+https://github.com/rust-lang/crates.io-index';

type Crate = { license?: string | null; files?: Record<string, string>; edge?: string | null; source?: string | null; checksum?: string | null; repository?: string };
type Fixture = {
  crates: Record<string, Crate>; files: Record<string, string | null>; reviewed: Record<string, any>;
  zig: Record<string, Record<string, string>>; manifest: string[]; metadataVersion: string;
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A small tree with the shape of the real one; `change` edits it before it is written and the script runs on it. */
async function generate(change: (fixture: Fixture) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-herdr-notices-'));
  roots.push(root);
  const herdr = 'packages/herdr-upstream';
  const upstream = { 'src/a.rs': 'fn a() {}\n', 'src/b.rs': 'fn b() {}\n', 'generated.json': '{}\n', 'vendor/libghostty-vt/pkg/x/x.h': 'embedded\n' };
  const fixture: Fixture = {
    crates: {
      'alpha 1.0.0': { license: 'MIT', files: { LICENSE: 'MIT for the alpha authors' }, checksum: 'aa' },
      'beta 2.0.0': { license: 'MIT OR Apache-2.0', files: { 'LICENSE-MIT': 'MIT for the alpha authors', 'LICENSE-APACHE': 'Apache terms' }, checksum: 'bb' },
      'gamma 0.1.0': { license: 'MIT', files: {}, repository: 'https://example.test/gamma', checksum: 'cc' },
      'tool 1.0.0': { license: 'MIT', files: { COPYING: 'build tool terms' }, edge: 'build', checksum: 'dd' },
      'tests 1.0.0': { license: 'GPL-3.0-only', files: {}, edge: 'dev', checksum: 'ee' },
    },
    files: {
      LICENSE: 'GPL text of lazysh', [`${herdr}/LICENSE`]: 'Apache text of Herdr',
      [`${herdr}/vendor/libghostty-vt/LICENSE`]: 'MIT text of Ghostty',
      [`${herdr}/vendor/libghostty-vt.vendor.json`]: '{"source_commit":"44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51"}',
      [`${herdr}/vendor/libghostty-vt/build.zig.zon.json`]: JSON.stringify({
        'hash-linked': { name: 'linked', url: 'https://example.test/linked.tar.gz', hash: 'sha256-aaa=' },
        'hash-data': { name: 'data', url: 'https://example.test/data.tar.gz', hash: 'sha256-bbb=' },
      }),
      '.github/herdr-notices/gamma.txt': 'MIT for the gamma authors',
      ...Object.fromEntries(Object.entries(upstream).map(([path, text]) => [`${herdr}/${path}`, text])),
      [`${herdr}/src/a.rs`]: '// Modified by lazysh: test.\nfn a() {}\n',
      [`${herdr}/generated.json`]: '{"changed":true}\n',
      'packages/herdr-guard/mod.rs': '// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0\n',
      'packages/common/src/hex_digest.rs': '// Copyright 2026 lazysh contributors. SPDX-License-Identifier: GPL-3.0-or-later\n',
      'packages/common/src/guarded_target.rs': '// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0\n',
    },
    reviewed: {
      upstream: { repository: 'https://example.test/herdr', version: '0.9.5', tag: 'v0.9.5', commit: 'c'.repeat(40) },
      licenses: ['Apache-2.0', 'MIT'], ownedLicenses: ['Apache-2.0', 'GPL-3.0-or-later'], changeNoticeInProvenance: ['generated.json'],
      supplements: { gamma: { file: 'gamma.txt', source: 'https://example.test/gamma/LICENSE', sha256: digest('MIT for the gamma authors') } },
      cargoSupplements: { 'https://example.test/gamma': ['gamma'] },
      zig: { 'hash-linked': { license: 'MIT', linked: true, files: ['LICENSE'] }, 'hash-data': { license: 'MIT', linked: false, files: [] } },
      embedded: [{ name: 'x', version: '1', path: 'vendor/libghostty-vt/pkg/x/x.h', license: 'MIT', supplements: ['gamma'] }],
    },
    zig: { 'hash-linked': { LICENSE: 'Zig package terms' }, 'hash-data': {} },
    manifest: Object.keys(upstream), metadataVersion: '0.9.5',
  };
  change(fixture);
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  for (const [path, text] of Object.entries(fixture.files)) if (text !== null) await put(path, text);
  await put('.github/herdr-notices/reviewed.json', JSON.stringify(fixture.reviewed));
  // The manifest holds the original bytes: a modified file keeps the digest of its upstream form.
  const original = (path: string) => (upstream as Record<string, string>)[path] ?? fixture.files[`${herdr}/${path}`] ?? '';
  await put(`${herdr}/SOURCE-MANIFEST.sha256`, fixture.manifest.map(path => `${digest(original(path))}  ${path}`).join('\n') + '\n');
  const lock = Object.entries(fixture.crates).filter(([, crate]) => crate.checksum !== undefined).map(([id, crate]) => {
    const [name, version] = id.split(' ');
    return `[[package]]\nname = "${name}"\nversion = "${version}"\n${crate.checksum ? `checksum = "${crate.checksum}"\n` : ''}`;
  });
  await put(`${herdr}/Cargo.lock`, lock.join('\n'));
  await mkdir(join(root, 'zig-pkg'));
  for (const [hash, files] of Object.entries(fixture.zig)) {
    await mkdir(join(root, 'zig-pkg', hash));
    for (const [name, text] of Object.entries(files)) await put(`zig-pkg/${hash}/${name}`, text);
  }
  const rootId = 'path+herdr', ids = Object.keys(fixture.crates).map(id => `${registry}#${id}`);
  const packages = [{ id: rootId, name: 'herdr', version: fixture.metadataVersion, source: null, license: 'Apache-2.0', license_file: null, repository: null, manifest_path: join(root, herdr, 'Cargo.toml') }];
  for (const [id, crate] of Object.entries(fixture.crates)) {
    const [name, version] = id.split(' '), dir = join(root, 'registry', id.replace(' ', '-'));
    await put(`registry/${id.replace(' ', '-')}/Cargo.toml`, '');
    for (const [file, text] of Object.entries(crate.files ?? {})) await put(`registry/${id.replace(' ', '-')}/${file}`, text);
    packages.push({ id: `${registry}#${id}`, name, version, source: crate.source === undefined ? registry : crate.source, license: crate.license ?? null, license_file: null, repository: crate.repository ?? null, manifest_path: join(dir, 'Cargo.toml') });
  }
  const nodes = [{ id: rootId, deps: Object.entries(fixture.crates).map(([id, crate]) => ({ pkg: `${registry}#${id}`, dep_kinds: [{ kind: crate.edge ?? null }] })) },
    ...ids.map(id => ({ id, deps: [] }))];
  await put('metadata.json', JSON.stringify({ packages, resolve: { root: rootId, nodes } }));
  const out = join(root, 'out');
  const child = Bun.spawn(['bun', script, '--repo', root, '--checkout', 'a'.repeat(40), '--metadata', join(root, 'metadata.json'),
    '--zig-packages', join(root, 'zig-pkg'), '--out', out], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const written = await stat(out).then(() => true, () => false);
  return { exit, stdout, written, out, read: (name: string) => readFile(join(out, name), 'utf8') };
}

test('the inventory lists what is linked and what only builds, with versions, sources and licenses', async () => {
  const result = await generate();
  expect(result).toMatchObject({ exit: 0, written: true });
  const inventory = JSON.parse(await result.read('notices.json'));
  expect(inventory.build).toEqual({ target: 'x86_64-unknown-linux-gnu', features: ['lazysh-managed'], checkout: 'a'.repeat(40) });
  expect(inventory.cargo.map((item: any) => [item.name, item.version, item.scope, item.license])).toEqual([
    ['alpha', '1.0.0', 'linked', 'MIT'], ['beta', '2.0.0', 'linked', 'MIT OR Apache-2.0'], ['gamma', '0.1.0', 'linked', 'MIT'],
    ['herdr', '0.9.5', 'linked', 'Apache-2.0'], ['tool', '1.0.0', 'build', 'MIT'],
  ]);
  expect(inventory.cargo[0]).toMatchObject({ source: 'https://static.crates.io/crates/alpha/alpha-1.0.0.crate', checksum: 'aa' });
  expect(inventory.zig.map((item: any) => [item.name, item.linked, item.url])).toEqual([
    ['data', false, 'https://example.test/data.tar.gz'], ['linked', true, 'https://example.test/linked.tar.gz'],
  ]);
  expect(inventory.modified).toEqual([
    { path: 'generated.json', sha256: digest('{"changed":true}\n'), originalSha256: digest('{}\n'), notice: 'PROVENANCE.md' },
    { path: 'src/a.rs', sha256: digest('// Modified by lazysh: test.\nfn a() {}\n'), originalSha256: digest('fn a() {}\n'), notice: 'in-file' },
  ]);
  expect(inventory.owned.map((item: any) => [item.path, item.license])).toEqual([
    ['packages/common/src/guarded_target.rs', 'Apache-2.0'], ['packages/common/src/hex_digest.rs', 'GPL-3.0-or-later'], ['packages/herdr-guard/mod.rs', 'Apache-2.0'],
  ]);
  expect(inventory.ghostty).toMatchObject({ commit: '44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51', license: 'MIT' });
  expect(inventory.upstream).toMatchObject({ version: '0.9.5', sourceFiles: 4 });
});

test('the bundle carries every license text once, names who relies on it and says the work is not Apache-only', async () => {
  const bundle = await (await generate()).read('NOTICES.txt');
  for (const text of ['MIT for the alpha authors', 'Apache terms', 'MIT for the gamma authors', 'Zig package terms', 'MIT text of Ghostty', 'GPL text of lazysh', 'Apache text of Herdr'])
    expect(bundle.split(text).length - 1, text).toBe(1);
  expect(bundle).toMatch(/Used by: crate alpha 1\.0\.0; crate beta 2\.0\.0\n/);
  expect(bundle).toContain('not Apache-only');
  expect(bundle).toContain(`https://github.com/mihazs/lazysh/tree/${'a'.repeat(40)}/packages/herdr-guard`);
  expect(bundle).toContain('src/a.rs (notice: in-file)');
  expect(bundle).not.toContain('crate tests');
});

test('the same inputs give the same bytes', async () => {
  const [first, second] = [await generate(), await generate()];
  for (const name of ['notices.json', 'NOTICES.txt']) expect(await first.read(name)).toBe(await second.read(name));
});

test.each([
  ['a crate with no license', (f: Fixture) => { f.crates['alpha 1.0.0'].license = null; }, 'crate alpha 1.0.0: no recorded license'],
  ['a crate under a license nobody reviewed', (f: Fixture) => { f.crates['alpha 1.0.0'].license = 'MIT OR AGPL-3.0-only'; }, 'license AGPL-3.0-only is not in the reviewed set'],
  ['a build-only crate under a license nobody reviewed', (f: Fixture) => { f.crates['tool 1.0.0'].license = 'MPL-2.0'; }, 'crate tool 1.0.0: license MPL-2.0'],
  ['a crate whose package ships no text and has no recorded one', (f: Fixture) => { f.crates['gamma 0.1.0'].repository = 'https://example.test/other'; }, 'crate gamma 0.1.0: no license text ships'],
  ['a recorded text that changed', (f: Fixture) => { f.files['.github/herdr-notices/gamma.txt'] = 'edited'; }, 'supplemental text gamma is missing or changed'],
  ['a registry crate Cargo.lock records no checksum for', (f: Fixture) => { f.crates['alpha 1.0.0'].checksum = null; }, 'crate alpha 1.0.0: Cargo.lock records no checksum'],
  ['a git dependency', (f: Fixture) => { f.crates['alpha 1.0.0'].source = 'git+https://example.test/alpha'; }, 'source git+https://example.test/alpha is not reviewed'],
  ['a Herdr version nobody reviewed', (f: Fixture) => { f.metadataVersion = '0.9.6'; }, 'herdr 0.9.6 differs from the reviewed upstream 0.9.5'],
  ['a fetched Zig package with no record', (f: Fixture) => { f.zig['hash-new'] = { LICENSE: 'new' }; }, 'Zig package hash-new (hash-new): no recorded license'],
  ['a recorded Zig package the build no longer fetches', (f: Fixture) => { delete f.zig['hash-data']; }, 'Zig package hash-data is recorded but was not fetched'],
  ['a linked Zig package without a license file', (f: Fixture) => { f.zig['hash-linked'] = {}; }, 'Zig package linked: license file LICENSE is missing'],
  ['a linked Zig package recorded without any text', (f: Fixture) => { f.reviewed.zig['hash-linked'].files = []; }, 'Zig package linked: linked but no license text is recorded'],
  ['a modified upstream file without a change notice', (f: Fixture) => { f.files['packages/herdr-upstream/src/b.rs'] = 'fn b() { changed() }\n'; }, 'src/b.rs: modified without a change notice'],
  ['an upstream file that disappeared', (f: Fixture) => { f.manifest.push('src/missing.rs'); }, 'src/missing.rs is in SOURCE-MANIFEST.sha256 but missing'],
  ['a lazysh file with no SPDX identifier', (f: Fixture) => { f.files['packages/herdr-guard/mod.rs'] = '// no tag\n'; }, 'packages/herdr-guard/mod.rs: no SPDX-License-Identifier'],
  ['a lazysh file under an unreviewed license', (f: Fixture) => { f.files['packages/herdr-guard/mod.rs'] = '// SPDX-License-Identifier: AGPL-3.0-only\n'; }, 'license AGPL-3.0-only is not in the reviewed set'],
  ['embedded code that is not pinned upstream', (f: Fixture) => { f.reviewed.embedded[0].path = 'vendor/other.h'; }, 'vendor/other.h is not a pinned upstream file'],
])('%s fails the check and writes nothing', async (_, change, message) => {
  const result = await generate(change);
  expect(result.exit).toBe(1);
  expect(result.written).toBe(false);
  expect(result.stdout).toContain(`::error::`);
  expect(result.stdout).toContain(message);
});

test('every problem is reported in one run', async () => {
  const result = await generate(f => { f.crates['alpha 1.0.0'].license = null; f.crates['beta 2.0.0'].license = 'MPL-2.0'; f.zig = {}; });
  expect(result.exit).toBe(1);
  expect(result.stdout.match(/::error::/g)?.length).toBeGreaterThanOrEqual(4);
});
