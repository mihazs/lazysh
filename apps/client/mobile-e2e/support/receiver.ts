/** What the receiver prints once it is running; the typed command spells it with a format so the line cannot match its own echo. */
export const READY = 'RX_READY';

/**
 * The bytes the receiver (`cat -v` in raw mode) has printed, read off the screen text: everything after the last ready line,
 * with the screen's own wrapping removed. Escape shows as `^[`, Delete as `^?`, Tab as `^I`.
 */
export function receivedBytes(screenText: string) {
  const rows = screenText.split('\n').map(row => row.trim());
  const start = rows.lastIndexOf(READY);
  return start < 0 ? '' : rows.slice(start + 1).join('');
}
