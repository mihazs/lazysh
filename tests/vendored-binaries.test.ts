import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';
import { project } from './support/gitFixture';

// The F-Droid source scanner (the release gate of .changeset/release-tag.ts) rejects binary files in the source tree.
const binary = /\.(wasm|jar|aar|apk|dex|so|dll|dylib|exe|a|class)$/i;

test('the vendored wry carries no binary file the F-Droid source scan would reject', async () => {
  const found: string[] = [];
  for await (const file of new Glob('**/*').scan({ cwd: join(project, 'packages', 'wry-vendor'), onlyFiles: true })) if (binary.test(file)) found.push(file);
  expect(found).toEqual([]);
});
