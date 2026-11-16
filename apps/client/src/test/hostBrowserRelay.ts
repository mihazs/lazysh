import {vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';

/** What `host_browser_next` hands the renderer: the relay's tag, then its JSON object. */
export function jsonBytes(value: object) {
  return new Uint8Array([1, ...new TextEncoder().encode(JSON.stringify(value))]);
}
/** A frame message: the relay's tag, the 20 byte header and a JPEG signature with a few bytes after it. */
export function frameBytes({sequence = 1, width = 390, height = 700, scrollY = 0, timestampMs = 1}: Partial<{sequence: number; width: number; height: number; scrollY: number; timestampMs: number}> = {}) {
  const bytes = new Uint8Array(1 + 20 + 6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  view.setUint32(1, sequence); view.setUint16(5, width); view.setUint16(7, height); view.setFloat32(9, scrollY); view.setBigUint64(13, BigInt(timestampMs));
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 0], 21);
  return bytes;
}

/**
 * The native bridge's six host browser commands, answered by hand: `push` delivers the next pull's answer (a pull
 * that has not been made yet gets it when it is), `calls` lists what the viewer asked, in order.
 */
export function relayBridge(token = 'browser-1') {
  const waiting: ((answer: unknown) => void)[] = [];
  const queued: unknown[] = [];
  const bridge = {
    push(answer: Uint8Array | Error) { const next = waiting.shift(); if (next) next(answer); else queued.push(answer); },
    calls: (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command).map(([, args]) => args as Record<string, unknown>),
    pulls: () => bridge.calls('host_browser_next').length,
  };
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'host_browser_start') return token;
    if (command !== 'host_browser_next') return undefined;
    const answer = queued.length ? queued.shift() : await new Promise(resolve => waiting.push(resolve));
    if (answer instanceof Error) throw answer;
    return (answer as Uint8Array).buffer;
  });
  return bridge;
}
