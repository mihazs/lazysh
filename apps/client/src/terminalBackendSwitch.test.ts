// @vitest-environment jsdom
import {beforeAll, describe, expect, it} from 'vitest';
import {stubMatchMedia} from './xterm/jsdomXterm';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {restoreBytes, snapshotScreen, switchTerminal, SWITCH_LOSES} from './terminalBackendSwitch';
import {createXtermTerminalAdapter} from './xtermTerminalAdapter';
import type {TerminalAdapter} from './terminalAdapter';

beforeAll(stubMatchMedia);

const text = (value: string) => new TextEncoder().encode(value);
const screenOf = (adapter: TerminalAdapter) => { const {length, } = adapter.viewport(), {rows} = adapter.size(); return adapter.readRows!(length - rows, rows); };

async function nativeSession(columns = 24, rows = 6) {
  const adapter = await openNativeTerminalAdapter(createHeadlessCore({columns, rows}));
  return adapter;
}

/** Runs a switch the way a session would: its output goes to whichever terminal is installed. */
async function leave(from: TerminalAdapter, delay = 0) {
  let installed = from;
  const send = (data: string) => installed.write!(text(data));
  const done = switchTerminal({
    from, install: to => { installed = to; },
    create: async () => { await new Promise(resolve => setTimeout(resolve, delay)); return createXtermTerminalAdapter(); },
  });
  return {send, done, current: () => installed};
}

describe('switching from the native terminal to xterm.js mid-session', () => {
  it('restores the visible screen, the cursor, the size and the modes, and carries on with the output that follows', async () => {
    const from = await nativeSession();
    await from.write!(text('prompt$ ls\r\n世界 wide  end\r\n\x1b[31mred\x1b[0m line\r\n\x1b[?2004h\x1b[?1000h\x1b[?1h\x1b[5;7Hhere'));
    const before = {rows: screenOf(from), cursor: from.cursor(), modes: from.modes(), size: from.size()};
    expect(before.rows).toEqual(['prompt$ ls', '世界 wide  end', 'red line', '', '      here', '']);
    const {done, current, send} = await leave(from);
    await done;
    const to = current();
    expect(to.backend).toBe('xterm');
    expect(screenOf(to)).toEqual(before.rows);
    expect(to.cursor()).toEqual(before.cursor);
    expect(to.size()).toEqual(before.size);
    expect(to.modes()).toEqual(before.modes);
    await send('!');
    expect(screenOf(to)[4]).toBe('      here!');
    await to.dispose();
  });

  it('keeps every byte the transport sent while the new terminal was being built, in order', async () => {
    const from = await nativeSession();
    await from.write!(text('one\r\n'));
    const {send, done, current} = await leave(from, 30);
    // Sent before the new terminal exists (applied to the old one, then restored) and after it is installed.
    const early = send('two\r\n');
    await new Promise(resolve => setTimeout(resolve, 60));
    const late = send('three\r\n');
    await Promise.all([early, late, done]);
    expect(screenOf(current()).slice(0, 3)).toEqual(['one', 'two', 'three']);
    await current().dispose();
  });

  it('restores the alternate screen and says what a snapshot cannot carry', async () => {
    const from = await nativeSession();
    await from.write!(text('shell\r\n\x1b[?1049h\x1b[2J\x1b[1;1Hvim\x1b[3;1Hstatus'));
    const {done, current} = await leave(from);
    await done;
    const to = current();
    expect(to.modes().alternateScreen).toBe(true);
    expect(screenOf(to).slice(0, 3)).toEqual(['vim', '', 'status']);
    // The shell's screen behind the alternate one was not carried.
    await to.write!(text('\x1b[?1049l'));
    expect(screenOf(to).every(row => row === '')).toBe(true);
    expect(SWITCH_LOSES).toContain('the primary screen behind an alternate screen');
    await to.dispose();
  });

  it('does not carry scrollback or text styles', async () => {
    const from = await nativeSession();
    await from.write!(text(Array.from({length: 30}, (_, i) => `\x1b[1;3${i % 8}mrow ${i}\x1b[0m`).join('\r\n')));
    expect(from.viewport().length).toBeGreaterThan(from.size().rows);
    const {done, current} = await leave(from);
    await done;
    expect(current().viewport().length).toBe(from.size().rows);
    expect(screenOf(current())).toEqual(screenOf(from));
    await current().dispose();
  });

  it('closes the old terminal, and keeps it when the new one cannot be made', async () => {
    const from = await nativeSession();
    const failing = switchTerminal({from, install: () => {}, create: async () => { throw new Error('no surface'); }});
    await expect(failing).rejects.toThrow('no surface');
    await from.write!(text('still here'));
    expect(screenOf(from)[0]).toBe('still here');
    const {done} = await leave(from);
    await done;
    await expect(from.write!(text('x'))).rejects.toThrow('disposed');
  });

  it('refuses a terminal whose output does not pass through the WebView', async () => {
    const owned = await openNativeTerminalAdapter(createHeadlessCore({feed: false}));
    await expect(switchTerminal({from: owned, install: () => {}, create: async () => createXtermTerminalAdapter()})).rejects.toThrow('fed through the WebView');
    await owned.dispose();
  });
});

describe('restore bytes', () => {
  it('draw rows by position and never let a row act as a command', () => {
    const snapshot = {columns: 10, rows: 2, lines: ['a\x1b[2Jb', 'c\u009bd'], cursor: {x: 1, y: 1}, modes: {bracketedPaste: false, mouseTracking: 'none' as const, alternateScreen: false, applicationCursorKeys: false}};
    expect(new TextDecoder().decode(restoreBytes(snapshot))).toBe('\x1b[2J\x1b[1;1Ha [2Jb\x1b[2;1Hc d\x1b[2;2H');
  });

  it('snapshots the live screen, not the part a reader scrolled to', async () => {
    const from = await nativeSession();
    await from.write!(text(Array.from({length: 20}, (_, i) => `row ${i}`).join('\r\n')));
    from.scroll({kind: 'toTop'});
    await from.write!(text(''));
    expect(snapshotScreen(from).lines.at(-1)).toBe('row 19');
    await from.dispose();
  });
});
