import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeTerminalDefines } from './sourceRevision';

const out = await mkdtemp(join(tmpdir(), 'lazysh-bun-build-'));
afterAll(() => rm(out, { recursive: true, force: true }));
const read = (name: string) => readFile(join(out, name), 'utf8');
const bundles = async () => (await readdir(out)).filter(name => name.endsWith('.js'));

beforeAll(async () => {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'build.ts')], { env: { ...process.env, LAZYSH_BUILD_OUT_DIR: out }, stdout: 'pipe', stderr: 'pipe' });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`build exited ${status}: ${stderr}`);
}, 120_000);

test('the page loads a script and a stylesheet that the build emitted', async () => {
  const page = await read('index.html');
  const urls = [...page.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1]);
  expect(urls.some(url => url.endsWith('.js'))).toBe(true);
  expect(urls.some(url => url.endsWith('.css'))).toBe(true);
  for (const url of urls) expect([url, existsSync(join(out, url))]).toEqual([url, true]);
});

test('every chunk, lazy panel and asset a bundle imports exists, so no lazy screen 404s at runtime', async () => {
  const files = await bundles();
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    const text = await read(file);
    for (const match of text.matchAll(/(?:from|import\()\s*"(\/[^"]+)"/g)) expect([file, match[1], existsSync(join(out, match[1]))]).toEqual([file, match[1], true]);
    for (const match of text.matchAll(/"(\/?[\w.-]+-[a-z0-9]{8}\.svg)"/g)) expect([file, match[1], existsSync(join(out, match[1]))]).toEqual([file, match[1], true]);
  }
});

test('build-time constants and the production flags are substituted and ?raw licence text is embedded', async () => {
  const text = (await Promise.all((await bundles()).map(read))).join('\n');
  expect(text).not.toContain('__LAZYSH_SOURCE_REVISION__');
  expect(text).not.toContain('__LAZYSH_SOURCE_DIRTY__');
  expect(text).not.toContain('import.meta.env');
  expect(text).not.toContain('process.env.NODE_ENV');
  expect(text).not.toContain('Download the React DevTools');
  expect(text).toContain('SIL OPEN FONT LICENSE');
  // A lookbehind regex literal fails to parse in WebKit before 16.4 (the iOS 16.0 floor) and blanks the whole app; they must be built at run time.
  expect(text).not.toContain('/(?<');
  expect(text).toContain('new RegExp("(?<![\\\\da-z])');
});

test('files from public/ are copied to the output root', () => {
  expect(existsSync(join(out, 'favicon.svg'))).toBe(true);
});

test('the native terminal kill switch is off only when asked, and any other value fails the build', () => {
  expect(nativeTerminalDefines('on')).toEqual({ __LAZYSH_NATIVE_TERMINAL_OFF__: 'false' });
  expect(nativeTerminalDefines('off')).toEqual({ __LAZYSH_NATIVE_TERMINAL_OFF__: 'true' });
  expect(() => nativeTerminalDefines('maybe')).toThrow('LAZYSH_NATIVE_TERMINAL must be "on" or "off", not "maybe".');
});
