// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const inApp = vi.hoisted(() => ({value: true}));
vi.mock('@tauri-apps/api/core', () => ({invoke, isTauri: () => inApp.value}));
const stored = vi.hoisted(() => new Map<string, {role: 'primary' | 'cjk'; bytes: ArrayBuffer}>());
vi.mock('./fonts', async importOriginal => ({...await importOriginal<typeof import('./fonts')>(), importedFontOf: async (name: string) => stored.get(name)}));
import {shareImportedFonts} from './nativeFonts';

const id = (n: number) => `0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f${n}`;
const primary = `lazysh-font-${id(1)}-primary`, cjk = `lazysh-font-${id(2)}-cjk`, other = `lazysh-font-${id(3)}-primary`;
const bytesOf = (...values: number[]) => Uint8Array.from(values).buffer;
const sent = () => invoke.mock.calls.filter(([command]) => command === 'native_terminal_font_import');

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  inApp.value = true;
  stored.clear();
  stored.set(primary, {role: 'primary', bytes: bytesOf(1, 2, 3)});
  stored.set(cjk, {role: 'cjk', bytes: bytesOf(4, 5)});
  stored.set(other, {role: 'primary', bytes: bytesOf(6)});
  // Whatever an earlier case handed over is let go.
  await shareImportedFonts('monospace');
  invoke.mockClear();
});

describe('sharing the imported fonts with the native renderer', () => {
  it('hands the bytes of each imported font a family list names, once, with its family and role, and ignores every other family', async () => {
    const list = `"${primary}", '${cjk}', Menlo, monospace`;
    await shareImportedFonts(list);
    await shareImportedFonts(list);
    expect(sent().map(([, bytes, options]) => [Array.from(bytes as Uint8Array), options.headers['x-lazysh-font-family'], options.headers['x-lazysh-font-role']])).toEqual([
      [[1, 2, 3], primary, 'primary'],
      [[4, 5], cjk, 'cjk'],
    ]);
    expect(sent()[0][2].headers).toHaveProperty('X-Lazysh-Access');
    expect(invoke.mock.calls).toHaveLength(2);
  });

  it('lets go of a font once the list stops naming it, and hands it again when it returns', async () => {
    await shareImportedFonts(`"${primary}", "${cjk}"`);
    invoke.mockClear();
    await shareImportedFonts(`"${primary}"`);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('native_terminal_font_forget', {family: cjk}, expect.anything()));
    await shareImportedFonts(`"${cjk}", "${primary}"`);
    expect(sent().map(([, bytes]) => Array.from(bytes as Uint8Array))).toEqual([[4, 5]]);
  });

  it('asks again after the app refused a font, and never rejects', async () => {
    invoke.mockRejectedValueOnce('This build has no native terminal renderer.');
    await expect(shareImportedFonts(`"${primary}"`)).resolves.toBeUndefined();
    await shareImportedFonts(`"${primary}"`);
    expect(sent()).toHaveLength(2);
    await shareImportedFonts(`"${primary}"`);
    expect(sent()).toHaveLength(2);
  });

  it('hands nothing for a font that is gone from storage, and does nothing outside the app', async () => {
    stored.delete(primary);
    await shareImportedFonts(`"${primary}"`);
    expect(sent()).toEqual([]);
    inApp.value = false;
    await shareImportedFonts(`"${cjk}"`);
    expect(invoke).not.toHaveBeenCalled();
  });
});
