// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {SurfaceInput} from './nativeSurfaceInput';
import type {SurfaceInputEvent} from './terminalSurfaceAnchor';

const key = (code: string, k: string, release = false): SurfaceInputEvent =>
  ({type: 'key', code, key: k, mods: {shift: false, ctrl: false, alt: false, meta: false}, repeat: false, release, composing: false});

/** A shell whose batches the test hands out one wait at a time, as the Kotlin relay does. */
function shell() {
  const batches: (SurfaceInputEvent[] | Error)[] = [];
  const focus: boolean[] = [];
  const releases: boolean[] = [];
  let wake: (() => void) | undefined;
  const api = {
    takeInput: vi.fn(async () => {
      while (!batches.length) await new Promise<void>(resolve => { wake = resolve; });
      const next = batches.shift()!;
      if (next instanceof Error) throw next;
      return {events: next};
    }),
    focus: vi.fn(async (_session: string, focused: boolean, keyboard = true) => { focus.push(focused); if (!focused) releases.push(keyboard); }),
  };
  return {api, focus, releases, push: (batch: SurfaceInputEvent[] | Error) => { batches.push(batch); wake?.(); }};
}

async function setup() {
  const core = createHeadlessCore();
  const adapter = await openNativeTerminalAdapter(core);
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const fake = shell();
  const input = new SurfaceInput(adapter, 's1', anchor, () => undefined, fake.api as never);
  return {core, adapter, anchor, input, ...fake};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('Android surface input', () => {
  it('sends committed text and keys to the core once, in the order the keyboard produced them', async () => {
    const {core, push, input} = await setup();
    push([{type: 'text', text: 'ls'}, key('Enter', 'Enter'), key('Enter', 'Enter', true), {type: 'text', text: '\x7f'}]);
    await settle();
    expect(core.inputs).toEqual([{data: 'ls', origin: 'ime'}, {data: '\x7f', origin: 'ime'}]);
    expect(core.keys.map(k => [k.key, k.release])).toEqual([['Enter', false], ['Enter', true]]);
    input.dispose();
  });

  it('draws the composing text at the cursor and removes it when the keyboard commits, without sending it', async () => {
    const {core, push, anchor, input} = await setup();
    push([{type: 'preedit', text: 'にほ'}]);
    await settle();
    const preedit = anchor.querySelector<HTMLElement>('[data-terminal-preedit]')!;
    expect(preedit.textContent).toBe('にほ');
    expect(preedit.hidden).toBe(false);
    expect(core.inputs).toEqual([]);
    push([{type: 'preedit', text: null}, {type: 'text', text: '日本'}]);
    await settle();
    expect(preedit.hidden).toBe(true);
    expect(core.inputs).toEqual([{data: '日本', origin: 'ime'}]);
    input.dispose();
  });

  it('asks again after a refusal and applies what arrives next, with no duplicate', async () => {
    vi.useFakeTimers();
    const {core, push, input} = await setup();
    push(new Error('native_surface_session'));
    await vi.advanceTimersByTimeAsync(0);
    expect(core.inputs).toEqual([]);
    push([{type: 'text', text: 'a'}]);
    await vi.advanceTimersByTimeAsync(600);
    expect(core.inputs).toEqual([{data: 'a', origin: 'ime'}]);
    input.dispose();
  });

  it('gives the keyboard to a surface placed after the page asked for it', async () => {
    const {push, focus, input} = await setup();
    input.focus();
    await settle();
    focus.length = 0;
    push([]);
    await settle();
    expect(focus).toEqual([true]);
    input.blur();
    await settle();
    expect(focus.at(-1)).toBe(false);
    input.dispose();
  });

  it('stops forwarding once disposed', async () => {
    const {core, push, input} = await setup();
    input.dispose();
    push([{type: 'text', text: 'late'}]);
    await settle();
    expect(core.inputs).toEqual([]);
  });

  it('sends a paste through the adapter, bracketed only when the program asked, and after the text typed before it', async () => {
    const {core, adapter, push, input} = await setup();
    push([{type: 'text', text: 'echo '}, {type: 'paste', text: 'a\nb'}]);
    await settle();
    await adapter.write!(new TextEncoder().encode('\x1b[?2004h'));
    push([{type: 'paste', text: 'c'}]);
    await settle();
    expect(core.inputs).toEqual([{data: 'echo ', origin: 'ime'}, {data: 'a\rb', origin: 'paste'}, {data: '\x1b[200~c\x1b[201~', origin: 'paste'}]);
    input.dispose();
  });

  it('lets go of the keyboard editor, keeping the keyboard open, when a field of the page takes focus, and not for the terminal or a non-field', async () => {
    const {anchor, releases, push, input} = await setup();
    input.focus();
    const field = document.body.appendChild(document.createElement('input'));
    const button = document.body.appendChild(document.createElement('button'));
    const inside = anchor.appendChild(document.createElement('input'));
    button.focus(); inside.focus();
    await settle();
    expect(releases).toEqual([]);
    field.focus();
    await settle();
    expect(releases).toEqual([false]);
    // The page's field no longer wants the editor back when the surface appears later.
    push([]);
    await settle();
    input.dispose();
    field.focus(); button.focus();
    expect(releases).toEqual([false]);
  });

  it('is the terminal\'s keyboard unless a page field holds it, and again once that field lets go', async () => {
    const {adapter, input} = await setup();
    const field = document.body.appendChild(document.createElement('input'));
    expect(input.focused()).toBe(true);
    field.focus();
    expect(input.focused()).toBe(false);
    field.blur();
    expect(input.focused()).toBe(true);
    field.focus();
    input.focus();
    expect(input.focused()).toBe(true);
    void adapter;
    input.dispose();
  });
});
