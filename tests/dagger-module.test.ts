import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pinned, RUST, UBUNTU } from '../dagger/src/images';
import { parsePrototools, requireVersion } from '../dagger/src/prototools';
import { project } from './support/gitFixture';

const prototools = parsePrototools(await Bun.file(join(project, '.prototools')).text());

test('parses pinned tool versions and ignores comments, sections and blank lines', () => {
  const text = '# pins\n\nbun = "1.3.14" # runtime\n[plugins]\nnode="24"\nmoon = "2.6.5"\n';
  expect(parsePrototools(text)).toEqual({ bun: '1.3.14', node: '24', moon: '2.6.5' });
});

test('names the tool when .prototools does not pin it', () => {
  expect(() => requireVersion({ bun: '1.3.14' }, 'node')).toThrow('.prototools pins no node');
});

// Bumping bun or node in .prototools must be paired with a vetted digest in dagger/src/images.ts, or the Dagger toolchain stops building.
test('every base image the toolchain asks for from .prototools has a pinned digest', () => {
  for (const tag of [`node:${requireVersion(prototools, 'node')}-bookworm`, `oven/bun:${requireVersion(prototools, 'bun')}`, RUST, UBUNTU]) {
    expect(pinned(tag)).toMatch(new RegExp(`^${tag}@sha256:[0-9a-f]{64}$`));
  }
});

test('refuses an image whose digest was never recorded', () => {
  expect(() => pinned('node:99-bookworm', {})).toThrow('no pinned digest for node:99-bookworm');
});
