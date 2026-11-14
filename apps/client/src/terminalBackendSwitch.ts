import type {TerminalAdapter, TerminalModes} from './terminalAdapter';

/**
 * Switching backends mid-session (#1342). xterm.js and the native core cannot hand each other their state, so the new
 * terminal is built from what the old one shows: the visible rows as text, the cursor and the mode flags. The transport
 * is untouched, so the session, its output and its input carry on. What a snapshot cannot carry is listed in `SWITCH_LOSES`.
 */
export type ScreenSnapshot = {
  columns: number; rows: number;
  /** The live screen's rows as text, trimmed on the right, top first. */
  lines: string[];
  cursor: {x: number; y: number};
  modes: TerminalModes;
};

export const SWITCH_LOSES = ['scrollback', 'text colours and styles', 'the selection', 'the primary screen behind an alternate screen', 'cursor shape, keyboard-protocol flags, tab stops, character sets and the title'] as const;

/** What the old terminal shows right now. Rows are read synchronously, so nothing may be applied between this and the install. */
export function snapshotScreen(adapter: TerminalAdapter): ScreenSnapshot {
  const {columns, rows} = adapter.size(), {length} = adapter.viewport();
  return {columns, rows, lines: adapter.readRows!(Math.max(0, length - rows), rows), cursor: adapter.cursor(), modes: adapter.modes()};
}

const mouseModes: Record<TerminalModes['mouseTracking'], string> = {none: '', x10: '\x1b[?9h', vt200: '\x1b[?1000h', drag: '\x1b[?1002h', any: '\x1b[?1003h'};

/** The bytes that draw a snapshot on a fresh terminal of the snapshot's size. Rows are placed by absolute position, and anything that is not text is blanked, so a row can never act as a command. */
export function restoreBytes({lines, cursor, modes}: ScreenSnapshot): Uint8Array {
  const rows = lines.map((line, row) => `\x1b[${row + 1};1H${line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')}`).join('');
  return new TextEncoder().encode(
    `${modes.alternateScreen ? '\x1b[?1049h' : ''}\x1b[2J${rows}\x1b[${cursor.y + 1};${cursor.x + 1}H`
    + `${modes.bracketedPaste ? '\x1b[?2004h' : ''}${modes.applicationCursorKeys ? '\x1b[?1h' : ''}${mouseModes[modes.mouseTracking]}`);
}

/** Replaces `from` by a terminal made by `create`, keeping the session: the new one is installed in the same turn as the snapshot, so every later chunk reaches it. */
export async function switchTerminal({from, create, install}: {
  from: TerminalAdapter;
  create: () => Promise<TerminalAdapter>;
  /** Called synchronously once the new terminal holds the restore bytes: point the session's output and view at it. */
  install: (to: TerminalAdapter) => void;
}): Promise<void> {
  if (!from.write) throw new Error('Only a terminal that is fed through the WebView can be left mid-session.');
  const to = await create();
  try {
    if (!to.write) throw new Error('The new terminal cannot be fed through the WebView.');
    // Writes apply in order: once this one is applied, everything the transport sent so far is on the old screen.
    await from.write(new Uint8Array(0));
    // No await until install(): a chunk arriving now goes to the old terminal only before the snapshot, and to the new one after it.
    const snapshot = snapshotScreen(from);
    to.requestSize({columns: snapshot.columns, rows: snapshot.rows});
    const restored = to.write(restoreBytes(snapshot));
    install(to);
    await restored;
  } catch (error) {
    await to.dispose();
    throw error;
  }
  await from.dispose();
}
