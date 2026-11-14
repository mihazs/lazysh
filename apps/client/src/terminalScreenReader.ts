/**
 * Screen-reader access for a terminal whose content has no DOM text of its own (a native
 * surface). The adapter keeps drawing; this mirrors the rows it can read (`readRows`, never
 * cells) into a visually hidden list a screen reader can walk, and speaks what changed through
 * a polite log, bounded so a busy program cannot flood the listener.
 * See docs/architecture/terminal-adapter.md.
 */

import type {Disposable, TerminalAdapter} from './terminalAdapter';
import {t} from './i18n/core';

export type ScreenReaderTuning = {
  /** Output events inside this window cost one read of the viewport, however many arrive. */
  settleMs: number;
  /** The least time between two announcements. */
  minIntervalMs: number;
  /** More new lines than this in one announcement are replaced by a count. */
  maxLines: number;
  /** A selection longer than this is cut when spoken. */
  maxSelectionChars: number;
  /** Announcements kept in the log; older ones are removed. */
  logSize: number;
};

export const defaultScreenReaderTuning: ScreenReaderTuning = {settleMs: 150, minIntervalMs: 1000, maxLines: 8, maxSelectionChars: 200, logSize: 20};

/** The mirror is for adapters a screen reader cannot read by itself and that can read their rows. */
export function needsScreenReaderMirror(adapter: Pick<TerminalAdapter, 'capabilities'>) {
  return !adapter.capabilities.accessibility && adapter.capabilities.screenInspection;
}

/** The non-blank lines of `after` that are new compared with `before`, in order. Scrolled output yields its new lines only. */
export function newScreenLines(before: readonly string[], after: readonly string[]): string[] {
  if (!before.length) return [];
  const changed = after.flatMap((row, index) => row !== before[index] ? [index] : []);
  // One row edited in place (typing, a spinner): speak what was appended when it only grew, else the row.
  if (before.length === after.length && changed.length === 1) {
    const row = after[changed[0]!]!, old = before[changed[0]!]!;
    const text = (old && row.startsWith(old) ? row.slice(old.length) : row).trim();
    return text ? [text] : [];
  }
  // Otherwise a longest-common-subsequence of rows: what is not in it was written since.
  // shortcut: a new row identical to one still on screen (a repeated prompt or `ok`) counts as unchanged, since the text cannot tell them apart; fine until a program needs per-row change flags from the core.
  const rows = before.length, cols = after.length;
  const common = Array.from({length: rows + 1}, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) for (let j = cols - 1; j >= 0; j--) {
    common[i]![j] = before[i] === after[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const added: string[] = [];
  for (let i = 0, j = 0; j < cols;) {
    if (i < rows && before[i] === after[j]) { i++; j++; }
    else if (i < rows && common[i + 1]![j]! >= common[i]![j + 1]!) i++;
    else { if (after[j]!.trim()) added.push(after[j]!.trim()); j++; }
  }
  return added;
}

const truncate = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * Mirrors `adapter`'s viewport into `host` and announces changes. The adapter must have the
 * `screenInspection` capability. Reads happen at most once per `settleMs`, only for the visible rows.
 */
export function mountScreenReaderMirror(adapter: TerminalAdapter, host: HTMLElement, tuning: Partial<ScreenReaderTuning> = {}): Disposable {
  const limits = {...defaultScreenReaderTuning, ...tuning};
  const doc = host.ownerDocument;
  const list = doc.createElement('div'), log = doc.createElement('div');
  list.setAttribute('role', 'list'); list.setAttribute('aria-label', t('terminalA11yScreen'));
  log.setAttribute('role', 'log');
  host.append(list, log);

  let before: string[] = [], cursorRow = -1, selection: string | undefined;
  let pending: string[] = [], lastAnnounced = Number.NEGATIVE_INFINITY;
  let settleTimer: ReturnType<typeof setTimeout> | undefined, announceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const announce = () => {
    announceTimer = undefined;
    const messages = [...pending, ...(selection ? [t('terminalA11ySelected', {text: selection})] : [])];
    pending = []; selection = undefined;
    if (!messages.length) return;
    lastAnnounced = Date.now();
    for (const message of messages) {
      const entry = doc.createElement('div');
      entry.textContent = message;
      log.append(entry);
    }
    while (log.childElementCount > limits.logSize) log.firstElementChild!.remove();
  };
  const scheduleAnnouncement = () => {
    if (announceTimer || (!pending.length && !selection)) return;
    const wait = lastAnnounced + limits.minIntervalMs - Date.now();
    if (wait > 0) announceTimer = setTimeout(announce, wait); else announce();
  };

  const settle = () => {
    settleTimer = undefined;
    if (disposed) return;
    const view = adapter.viewport();
    const rows = adapter.readRows!(view.top, view.rows);
    const cursor = view.following ? adapter.cursor().y : -1;
    // The tree always shows the visible rows; only rows that differ touch the DOM.
    while (list.childElementCount > rows.length) list.lastElementChild!.remove();
    rows.forEach((text, index) => {
      let item = list.children[index] as HTMLElement | undefined;
      if (!item) { item = doc.createElement('div'); item.setAttribute('role', 'listitem'); list.append(item); }
      if (item.textContent !== text) item.textContent = text;
      if ((index === cursor) !== item.hasAttribute('aria-current')) index === cursor ? item.setAttribute('aria-current', 'location') : item.removeAttribute('aria-current');
    });
    // Reading history is the reader's own navigation: nothing is announced unless the view is live.
    if (view.following) {
      const added = newScreenLines(before, rows);
      if (added.length > limits.maxLines) pending = [t('terminalA11yChanged', {count: added.length})];
      else if (added.length) pending = [...pending, ...added].slice(-limits.maxLines);
      // A menu that moves the cursor without changing text: say the row the cursor is on now.
      else if (cursor !== cursorRow && cursor >= 0 && rows[cursor]?.trim() && before.length) pending = [rows[cursor]!.trim()];
    }
    cursorRow = cursor;
    before = rows;
    scheduleAnnouncement();
  };
  const wake = () => { if (!settleTimer && !disposed) settleTimer = setTimeout(settle, limits.settleMs); };

  const subscription = adapter.subscribe(event => {
    if (event.type === 'selection') {
      selection = event.range ? truncate(adapter.selectedText(), limits.maxSelectionChars) || undefined : undefined;
    }
    wake();
  }, ['output', 'viewport', 'geometry', 'selection']);
  settle();

  return {
    dispose() {
      disposed = true;
      subscription.dispose();
      clearTimeout(settleTimer); clearTimeout(announceTimer);
      list.remove(); log.remove();
    },
  };
}
