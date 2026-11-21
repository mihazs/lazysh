import type {TerminalSearchHit} from './terminalAdapter';

/** The first row after `from` (in `direction`, wrapping around `length` rows) whose text holds `query`, ignoring case. */
export function searchRows(length: number, rowText: (row: number) => string, query: string, direction: 1 | -1, from?: number): TerminalSearchHit | undefined {
  if (!query) return;
  const needle = query.toLocaleLowerCase();
  const start = from === undefined || from < 0 ? (direction > 0 ? -1 : length) : from;
  for (let offset = 1; offset <= length; offset++) {
    const row = (start + offset * direction + length * 2) % length;
    const text = rowText(row);
    const column = text.toLocaleLowerCase().indexOf(needle);
    if (column >= 0) return {row, column, length: text.length};
  }
}

/** The directory an OSC 7 report (`file://host/path`) names, decoded; undefined for anything else, which keeps the last directory. */
export function cwdFromOsc7(data: string): string | undefined {
  try {
    const url = new URL(data);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : undefined;
  } catch { return undefined; }
}
