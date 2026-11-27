import {expect, test} from 'bun:test';
import {receivedBytes} from './receiver';

test('the bytes are what follows the last ready line, joined across the screen\'s wrapped rows', () => {
  const screen = ['UI_PROMPT> stty', ' -icanon; printf \'RX_%s\\n\' READY; cat -v', 'RX_READY', 'ten ^?^?^?^?tan ^[^?', 'web  ', ''].join('\n');
  expect(receivedBytes(screen)).toBe('ten ^?^?^?^?tan ^[^?web');
});

test('nothing is received before the receiver is running, and the command echo is not taken for it', () => {
  expect(receivedBytes("UI_PROMPT> printf 'RX_%s\\n' READY; cat -v")).toBe('');
  expect(receivedBytes('RX_READY')).toBe('');
});
