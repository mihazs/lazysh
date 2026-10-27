import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'packages/herdr-upstream/';
const directory = join(root, prefix);

test('Herdr vendor exclusions cover only unchanged manifest-listed upstream bytes', async () => {
  const { ignore } = await Bun.file(join(root, '.jscpd.json')).json() as { ignore: string[] };
  const scopes = ignore.map(pattern => new Bun.Glob(pattern));
  const excluded = (path: string) => scopes.some(scope => scope.match(prefix + path));
  const original = await Bun.file(join(directory, 'SOURCE-MANIFEST.sha256')).text();
  expect(createHash('sha256').update(original).digest('hex')).toBe('1aedd80ed6f09c8421df38bcdac64ec07a089e8f54350f4b198f221d282231a9');
  const manifest = new Map(original.trimEnd().split('\n').map(line => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) throw new Error('Invalid Herdr source manifest');
    return [match[2], match[1]];
  }));
  expect(scopes.some(scope => scope.match('tests/herdr-source.test.ts'))).toBe(false);
  expect(scopes.some(scope => scope.match('packages/herdr-guard/source.rs'))).toBe(false);
  expect(excluded('PROVENANCE.md')).toBe(false);
  expect(excluded('SOURCE-MANIFEST.sha256')).toBe(false);
  const checked = new Set<string>();
  for await (const path of new Bun.Glob('**/*').scan({ cwd: directory, onlyFiles: true, dot: true })) {
    if (!excluded(path)) continue;
    expect(manifest.has(path), `Excluded non-upstream file: ${path}`).toBe(true);
    const bytes = await Bun.file(join(directory, path)).arrayBuffer();
    expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), `Modified excluded upstream file: ${path}`).toBe(manifest.get(path));
    checked.add(path);
  }
  for (const path of manifest.keys()) if (excluded(path)) expect(checked.has(path), `Missing excluded upstream file: ${path}`).toBe(true);
  expect(checked.size).toBeGreaterThan(1000);
});
