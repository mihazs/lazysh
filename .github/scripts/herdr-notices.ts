// Builds the third-party notice inventory and text bundle of the managed Herdr executable, and fails
// when anything it would ship has no recorded license. Contract: packages/herdr-upstream/PROVENANCE.md.
//
// bun herdr-notices.ts --repo DIR --checkout SHA --metadata cargo-metadata.json --zig-packages zig-pkg
//   --out DIR [--target TRIPLE] [--features LIST]
//
// --metadata is `cargo metadata --locked --format-version 1 --filter-platform TRIPLE --features LIST`
// of the copied build, --zig-packages the zig-pkg directory that build populated. Nothing is written
// unless every check passes. The output has no timestamps: the same inputs give the same bytes.
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

type Supplement = { file: string; source: string; sha256: string };
type Reviewed = {
  upstream: { repository: string; version: string; tag: string; commit: string };
  licenses: string[];
  ownedLicenses: string[];
  changeNoticeInProvenance: string[];
  supplements: Record<string, Supplement>;
  cargoSupplements: Record<string, string[]>;
  zig: Record<string, { license: string; linked: boolean; files: string[]; supplements?: string[] }>;
  embedded: { name: string; version: string; path: string; license: string; supplements: string[] }[];
};
type Package = {
  id: string; name: string; version: string; source: string | null; license: string | null;
  license_file: string | null; repository: string | null; manifest_path: string;
};
type Node = { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] };
type Text = { file: string; sha256: string };

const { values: arg } = parseArgs({ options: {
  repo: { type: 'string' }, checkout: { type: 'string' }, metadata: { type: 'string' }, 'zig-packages': { type: 'string' },
  out: { type: 'string' }, target: { type: 'string', default: 'x86_64-unknown-linux-gnu' }, features: { type: 'string', default: 'lazysh-managed' },
} });
for (const name of ['repo', 'checkout', 'metadata', 'zig-packages', 'out'] as const) if (!arg[name]) throw new Error(`--${name} is required`);
const repo = arg.repo!, herdr = join(repo, 'packages/herdr-upstream'), guard = join(repo, 'packages/herdr-guard'), notices = join(repo, '.github/herdr-notices');

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const byKey = <T>(key: (item: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const problems: string[] = [];
const need = (ok: unknown, message: string) => { if (!ok) problems.push(message); return !!ok; };
const read = async (path: string) => (await Bun.file(path).exists() ? Bun.file(path).text() : undefined);
const reviewed = JSON.parse((await read(join(notices, 'reviewed.json')))!) as Reviewed;
const allowed = new Set(reviewed.licenses);

// Every text that ships with the executable once, with who relies on it.
const bundle = new Map<string, { text: string; users: Set<string> }>();
const keep = (text: string, user: string) => {
  const digest = sha256(text);
  (bundle.get(digest) ?? bundle.set(digest, { text, users: new Set() }).get(digest)!).users.add(user);
  return digest;
};
const identifiers = (expression: string) => expression.split(/[\s()/]+/).filter(id => id && !/^(AND|OR|WITH)$/i.test(id));
const license = (who: string, expression: string | null | undefined, permitted = allowed) => {
  if (!need(expression?.trim(), `${who}: no recorded license`)) return;
  for (const id of identifiers(expression!)) need(permitted.has(id), `${who}: license ${id} is not in the reviewed set`);
};
const shippedTexts = async (dir: string, user: string, names: string[]): Promise<Text[]> => {
  const texts: Text[] = [];
  for (const file of names.sort()) {
    const text = await read(join(dir, file));
    if (need(text !== undefined, `${user}: license file ${file} is missing`)) texts.push({ file, sha256: keep(text!, user) });
  }
  return texts;
};
const supplemental = async (keys: string[], user: string): Promise<Text[]> => {
  const texts: Text[] = [];
  for (const key of keys) {
    const entry = reviewed.supplements[key], text = entry ? await read(join(notices, entry.file)) : undefined;
    if (!need(text !== undefined && sha256(text) === entry.sha256, `${user}: supplemental text ${key} is missing or changed`)) continue;
    texts.push({ file: `${entry.file} (${entry.source})`, sha256: keep(text!, user) });
  }
  return texts;
};

// Cargo: exactly the packages of the metadata, split into what is linked and what only builds it.
const metadata = JSON.parse((await read(arg.metadata!))!) as { packages: Package[]; resolve: { root: string; nodes: Node[] } };
const packages = new Map(metadata.packages.map(item => [item.id, item]));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const closure = (starts: string[], kinds: (string | null)[]) => {
  const seen = new Set(starts), pending = [...starts];
  for (let id = pending.pop(); id; id = pending.pop()) for (const dep of nodes.get(id)?.deps ?? []) {
    if (!seen.has(dep.pkg) && dep.dep_kinds.some(({ kind }) => kinds.includes(kind))) { seen.add(dep.pkg); pending.push(dep.pkg); }
  }
  return seen;
};
const linked = closure([metadata.resolve.root], [null]);
const buildOnly = [...closure([...linked], [null, 'build'])].filter(id => !linked.has(id));
const rootDir = dirname(packages.get(metadata.resolve.root)!.manifest_path);
const lock = Bun.TOML.parse((await read(join(herdr, 'Cargo.lock')))!) as { package: { name: string; version: string; checksum?: string }[] };
const checksums = new Map(lock.package.map(item => [`${item.name} ${item.version}`, item.checksum]));
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
const licenseFile = /^(licen[cs]e|copying|notice|unlicense)/i;

const cargo = [];
for (const [scope, ids] of [['linked', [...linked]], ['build', buildOnly]] as const) for (const id of ids) {
  const item = packages.get(id)!, who = `crate ${item.name} ${item.version}`, dir = dirname(item.manifest_path);
  license(who, item.license);
  const location = item.source === null ? join('packages/herdr-upstream', relative(rootDir, dir)) : item.source === registry
    ? `https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate` : undefined;
  need(location, `${who}: source ${item.source} is not reviewed`);
  const checksum = item.source === registry ? checksums.get(`${item.name} ${item.version}`) : undefined;
  if (item.source === registry) need(checksum, `${who}: Cargo.lock records no checksum`);
  const names = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && licenseFile.test(entry.name)).map(entry => entry.name);
  let texts = await shippedTexts(dir, who, names);
  if (!texts.length && item.source === null && dir.startsWith(rootDir)) texts = await shippedTexts(rootDir, who, ['LICENSE']);
  if (!texts.length) texts = await supplemental(reviewed.cargoSupplements[item.repository ?? ''] ?? [], who);
  need(texts.length, `${who}: no license text ships with the package and none is recorded`);
  cargo.push({ name: item.name, version: item.version, scope, source: location, checksum, license: item.license, repository: item.repository, texts });
}
cargo.sort(byKey(item => `${item.name} ${item.version}`));
need(packages.get(metadata.resolve.root)!.version === reviewed.upstream.version, `herdr ${packages.get(metadata.resolve.root)!.version} differs from the reviewed upstream ${reviewed.upstream.version}`);

// Zig: every package the build fetched, and nothing stale in the record.
const catalog = JSON.parse((await read(join(herdr, 'vendor/libghostty-vt/build.zig.zon.json')))!) as Record<string, { name: string; url: string; hash: string }>;
const fetched = (await readdir(arg['zig-packages']!)).sort();
for (const hash of Object.keys(reviewed.zig)) need(fetched.includes(hash), `Zig package ${hash} is recorded but was not fetched`);
const zig = [];
for (const hash of fetched) {
  const entry = reviewed.zig[hash], who = `Zig package ${catalog[hash]?.name ?? hash}`;
  if (!need(entry, `${who} (${hash}): no recorded license`)) continue;
  need(catalog[hash], `${who}: absent from build.zig.zon.json`);
  license(who, entry.license);
  const texts = [...await shippedTexts(join(arg['zig-packages']!, hash), who, entry.files), ...await supplemental(entry.supplements ?? [], who)];
  if (entry.linked) need(texts.length, `${who}: linked but no license text is recorded`);
  zig.push({ name: catalog[hash]?.name, hash, url: catalog[hash]?.url, archiveHash: catalog[hash]?.hash, linked: entry.linked, license: entry.license, texts });
}

// Vendored Ghostty, the third-party code embedded in it, and the source the executable was compiled from.
const vendor = JSON.parse((await read(join(herdr, 'vendor/libghostty-vt.vendor.json')))!) as { source_commit: string };
const ghosttyLicense = (await read(join(herdr, 'vendor/libghostty-vt/LICENSE')))!;
const ghostty = { commit: vendor.source_commit, url: `https://github.com/ghostty-org/ghostty/tree/${vendor.source_commit}`, license: 'MIT', texts: [{ file: 'vendor/libghostty-vt/LICENSE', sha256: keep(ghosttyLicense, 'Ghostty (libghostty-vt)') }] };
const manifestText = (await read(join(herdr, 'SOURCE-MANIFEST.sha256')))!;
const manifest = new Map(manifestText.trimEnd().split('\n').map(line => [line.slice(66), line.slice(0, 64)] as const));
const embedded = [];
for (const item of reviewed.embedded) {
  const who = `embedded ${item.name} ${item.version}`;
  need(manifest.has(item.path), `${who}: ${item.path} is not a pinned upstream file`);
  license(who, item.license);
  embedded.push({ ...item, texts: await supplemental(item.supplements, who) });
}

const modified = [];
for (const [path, original] of [...manifest].sort(byKey(([path]) => path))) {
  const bytes = Bun.file(join(herdr, path));
  if (!need(await bytes.exists(), `${path} is in SOURCE-MANIFEST.sha256 but missing`)) continue;
  const current = sha256(new Uint8Array(await bytes.arrayBuffer()));
  if (current === original) continue;
  const inFile = (await bytes.text()).includes('Modified by lazysh');
  need(inFile || reviewed.changeNoticeInProvenance.includes(path), `${path}: modified without a change notice`);
  modified.push({ path, sha256: current, originalSha256: original, notice: inFile ? 'in-file' : 'PROVENANCE.md' });
}

// lazysh's own files compiled into the executable.
const owned = [];
const ownedPaths = [...(await Array.fromAsync(new Bun.Glob('**/*.rs').scan({ cwd: guard }))).map(path => join('packages/herdr-guard', path)),
  'packages/common/src/hex_digest.rs', 'packages/common/src/guarded_target.rs'].sort();
for (const path of ownedPaths) {
  const bytes = Bun.file(join(repo, path)), id = /SPDX-License-Identifier:\s*([\w.+-]+)/.exec(await bytes.text())?.[1];
  if (!need(id, `${path}: no SPDX-License-Identifier`)) continue;
  license(path, id, new Set(reviewed.ownedLicenses));
  owned.push({ path, sha256: sha256(new Uint8Array(await bytes.arrayBuffer())), license: id });
}
const repoLicense = (await read(join(repo, 'LICENSE')))!;
const ownedGpl = owned.some(item => item.license.startsWith('GPL'));
if (ownedGpl) keep(repoLicense, 'lazysh (GPL-3.0-or-later modules)');

if (problems.length) {
  for (const message of problems) console.log(`::error::${message}`);
  console.error(`${problems.length} notice problem(s); nothing written.`);
  process.exit(1);
}

const upstream = reviewed.upstream;
const inventory = {
  schemaVersion: 1,
  build: { target: arg.target, features: arg.features!.split(',').filter(Boolean), checkout: arg.checkout },
  upstream: { ...upstream, sourceManifestSha256: sha256(manifestText), sourceFiles: manifest.size, cargoLockSha256: sha256(new Uint8Array(await Bun.file(join(herdr, 'Cargo.lock')).arrayBuffer())) },
  cargo, zig, ghostty, embedded, modified, owned,
  counts: { linkedCrates: linked.size, buildOnlyCrates: buildOnly.length, zigPackages: zig.length, modifiedUpstreamFiles: modified.length, ownedFiles: owned.length, distinctTexts: bundle.size },
};
const sourceUrl = (path: string) => `https://github.com/mihazs/lazysh/tree/${arg.checkout}/${path}`;
const header = [
  'Notices for the lazysh managed Herdr executable (lazysh-herdr)', '',
  `This executable is a modified build of Herdr ${upstream.version} (${upstream.repository}, tag ${upstream.tag}, commit ${upstream.commit}).`,
  'It is not an official Herdr release and upstream has not endorsed it. Herdr is Apache-2.0; the lazysh files listed below carry',
  `${[...new Set(owned.map(item => item.license))].join(' and ')} notices.${ownedGpl ? ' The combined work is therefore not Apache-only.' : ''}`, '',
  'Corresponding source of the lazysh parts and of the modified Herdr tree:',
  ...['packages/herdr-upstream', 'packages/herdr-guard', 'packages/common/src'].map(path => `  ${sourceUrl(path)}`), '',
  `Original Herdr manifest: SOURCE-MANIFEST.sha256 (${manifest.size} files, SHA-256 ${inventory.upstream.sourceManifestSha256}).`,
  `Modified upstream files (${modified.length}); each keeps the upstream license and carries a change notice:`,
  ...modified.map(item => `  ${item.path} (notice: ${item.notice})`), '',
  'lazysh files:', ...owned.map(item => `  ${item.path} (${item.license})`), '',
  `Components with their versions, licenses and sources are listed in notices.json (${cargo.length} crates, ${zig.length} Zig packages, Ghostty ${ghostty.commit}).`,
  'The license texts follow, each once, with the components that rely on it.', '',
];
const texts = [...bundle].map(([digest, { text, users }]) => [`${'='.repeat(78)}\nText ${digest}\nUsed by: ${[...users].sort().join('; ')}\n${'='.repeat(78)}`, text.trimEnd(), ''])
  .sort(byKey(([title]) => title.split('\n')[2] + title)).flat();
await mkdir(arg.out!, { recursive: true });
await Bun.write(join(arg.out!, 'notices.json'), JSON.stringify(inventory, null, 2) + '\n');
await Bun.write(join(arg.out!, 'NOTICES.txt'), [...header, ...texts].join('\n') + '\n');
console.log(`notices: ${cargo.length} crates, ${zig.length} Zig packages, ${modified.length} modified upstream files, ${owned.length} lazysh files, ${bundle.size} distinct license texts`);
