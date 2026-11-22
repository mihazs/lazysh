// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';

const calls: string[] = [];
const gate = vi.hoisted(() => ({open: Promise.resolve()}));
vi.mock('./nativeFonts', () => ({shareImportedFonts: vi.fn(async (list: string) => { calls.push(`share ${list}`); await gate.open; })}));
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {defaults, terminalPreferences} from './preferences';

it('hands the app the imported fonts a look names before it sends the look, and waits for them', async () => {
  const look = vi.fn(async (session: string) => { calls.push(`look ${session}`); });
  const adapter = await openNativeTerminalAdapter(createHeadlessCore(), {look});
  const element = document.createElement('div');
  element.id = 'fonts-anchor';
  document.body.append(element);
  await adapter.attach({kind: 'native', anchorId: element.id, surface: 's1'});
  let release!: () => void;
  gate.open = new Promise<void>(resolve => { release = resolve; });
  const fontFamily = '"lazysh-font-0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9-primary", monospace';
  adapter.applyPreferences({...terminalPreferences(defaults), fontFamily});
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(calls).toEqual([`share ${fontFamily}`]);
  release();
  await vi.waitFor(() => expect(calls).toEqual([`share ${fontFamily}`, 'look s1']));
});
