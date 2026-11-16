import {expect, it} from 'vitest';
import {LocalUiError} from '../i18n/localError';
import {decodeRelayMessage} from './relayMessage';
import {frameBytes, jsonBytes} from '../test/hostBrowserRelay';

it('reads what the bridge hands over: nothing, the four JSON messages and a frame with its header', () => {
  expect(decodeRelayMessage(new Uint8Array([0]))).toEqual({kind: 'idle'});
  expect(decodeRelayMessage(jsonBytes({type: 'state', state: 'paused', browser: 'Chrome/150'}))).toEqual({kind: 'state', run: 'paused'});
  expect(decodeRelayMessage(jsonBytes({type: 'page', title: 'Sign in', url: 'https://example.test/'}))).toEqual({kind: 'page', title: 'Sign in', url: 'https://example.test/'});
  expect(decodeRelayMessage(jsonBytes({type: 'refused', reason: 'ControlOff', count: 4}))).toEqual({kind: 'refused', reason: 'ControlOff', count: 4});
  expect(decodeRelayMessage(jsonBytes({type: 'closed', reason: 'BrowserVersionUnsupported', detail: 'Chrome/99'}))).toEqual({kind: 'closed', reason: 'BrowserVersionUnsupported', detail: 'Chrome/99'});
  const frame = decodeRelayMessage(frameBytes({sequence: 4_000_000_000, width: 390, height: 700, scrollY: 12.5, timestampMs: 1_700_000_000_123}));
  expect(frame).toMatchObject({kind: 'frame', sequence: 4_000_000_000, width: 390, height: 700, scrollY: 12.5, timestampMs: 1_700_000_000_123});
  expect(frame.kind === 'frame' && [...frame.jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
});

it('reads the same bytes whether the bridge gives an ArrayBuffer, a typed array or numbers', () => {
  const bytes = jsonBytes({type: 'state', state: 'running'});
  const expected = {kind: 'state', run: 'running'};
  expect(decodeRelayMessage(bytes.buffer as ArrayBuffer)).toEqual(expected);
  expect(decodeRelayMessage([...bytes])).toEqual(expected);
  expect(decodeRelayMessage(new Uint8Array([9, ...bytes]).subarray(1))).toEqual(expected);
});

it('skips a message type it does not know and refuses anything that breaks the format', () => {
  expect(decodeRelayMessage(jsonBytes({type: 'tabs', tabs: []}))).toEqual({kind: 'idle'});
  const bad: (Uint8Array | number[])[] = [
    new Uint8Array([]), new Uint8Array([0, 0]), new Uint8Array([3, 1, 2]), new Uint8Array([1, 0xff, 0xfe]), new Uint8Array([1, ...new TextEncoder().encode('[]')]),
    jsonBytes({type: 'state', state: 'exploding'}), jsonBytes({type: 'page', title: 7, url: 'x'}), jsonBytes({type: 'page', title: 'x'.repeat(513), url: 'x'}),
    jsonBytes({type: 'page', title: 'x', url: 'x'.repeat(2049)}), jsonBytes({type: 'refused', reason: 'ControlOff', count: 0}),
    jsonBytes({type: 'closed', reason: 'has space'}), jsonBytes({type: 'closed', reason: 'x'.repeat(65)}), jsonBytes({type: 'closed', reason: 'Fine', detail: 'x'.repeat(257)}),
    frameBytes({width: 0}), frameBytes({height: 0}), new Uint8Array([2, ...new Uint8Array(20)]),
  ];
  for (const message of bad) expect(() => decodeRelayMessage(message), String(message.slice(0, 12))).toThrow(LocalUiError);
});
