import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostBrowserSession, inputCommands, pagePoint, parseEndpoint } from './cdp';
import type { InputMessage } from './input';

type Sent = { id: number; method: string; params: any; sessionId?: string };

/** A DevTools endpoint in memory: answers the calls the prototype makes and records everything it was sent. */
class FakeBrowser {
  static OPEN = 1;
  static instance: FakeBrowser;
  readyState = 1;
  sent: Sent[] = [];
  onopen: () => void = () => {};
  onerror: () => void = () => {};
  onclose: () => void = () => {};
  onmessage: (event: { data: string }) => void = () => {};
  constructor(public url: URL) { FakeBrowser.instance = this; queueMicrotask(() => this.onopen()); }
  send(text: string) {
    const call = JSON.parse(text) as Sent;
    this.sent.push(call);
    const results: Record<string, unknown> = {
      'Target.getTargets': { targetInfos: [{ type: 'service_worker', targetId: 'w' }, { type: 'page', targetId: 'page-1' }] },
      'Target.attachToTarget': { sessionId: 'session-1' },
    };
    queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: call.id, result: results[call.method] ?? {} }) }));
  }
  frame(bytes: number[], metadata = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0, timestamp: 1 }) {
    this.onmessage({ data: JSON.stringify({ method: 'Page.screencastFrame', sessionId: 'session-1', params: { data: btoa(String.fromCharCode(...bytes)), metadata, sessionId: 42 } }) });
  }
  close() { this.readyState = 3; this.onclose(); }
  methods() { return this.sent.map(call => call.method); }
}

async function started() {
  vi.stubGlobal('WebSocket', FakeBrowser);
  const frames: { jpeg: Uint8Array; acknowledge: () => void }[] = [];
  const session = await HostBrowserSession.connect(parseEndpoint('ws://127.0.0.1:41234/devtools/browser/0dcb9dfb-aaf4-4104-9985-0bdc81f6c5c9'));
  await session.start({ width: 390, height: 700 }, (frame, acknowledge) => frames.push({ jpeg: frame.jpeg, acknowledge }));
  return { session, frames, browser: FakeBrowser.instance };
}
afterEach(() => vi.unstubAllGlobals());

describe('endpoint', () => {
  it('accepts only the loopback browser endpoint that the SSH forward exposes', () => {
    expect(parseEndpoint(' ws://127.0.0.1:41234/devtools/browser/0dcb9dfb-aaf4 ').port).toBe('41234');
    for (const bad of ['wss://127.0.0.1:1/devtools/browser/a', 'ws://example.com:1/devtools/browser/a', 'ws://127.0.0.1/devtools/browser/a',
      'ws://127.0.0.1:1/devtools/page/a', 'ws://127.0.0.1:1/devtools/browser/a?x=1', 'ws://user:pw@127.0.0.1:1/devtools/browser/a', 'http://127.0.0.1:1/'])
      expect(() => parseEndpoint(bad), bad).toThrow();
  });
});

describe('pointer mapping', () => {
  it('maps a point on the displayed frame to page pixels and keeps it inside the page', () => {
    const frame = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0, timestamp: 0 };
    expect(pagePoint({ x: 0.5, y: 0.25 }, frame)).toEqual({ x: 195, y: 175 });
    expect(pagePoint({ x: 2, y: -1 }, frame)).toEqual({ x: 390, y: 0 });
    expect(pagePoint({ x: 0.5, y: 0.5 }, { ...frame, offsetTop: 56 })).toEqual({ x: 195, y: 294 });
  });
});

describe('input commands', () => {
  const commands = (message: InputMessage) => inputCommands(message).map(({ method, params }) => [method, params]);
  const key = (name: string, modifiers = 0) => commands({ type: 'key', key: name, modifiers });

  it('maps pointer messages to mouse events, with the buttons that are held', () => {
    const at = { x: 12, y: 34 };
    expect(commands({ type: 'pointer', kind: 'move', ...at, button: 'none', clickCount: 0 })).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0, clickCount: 0 }]]);
    expect(commands({ type: 'pointer', kind: 'move', ...at, button: 'left', clickCount: 0 })[0][1]).toMatchObject({ type: 'mouseMoved', button: 'left', buttons: 1 });
    expect(commands({ type: 'pointer', kind: 'press', ...at, button: 'right', clickCount: 1 })[0][1]).toMatchObject({ type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1 });
    expect(commands({ type: 'pointer', kind: 'release', ...at, button: 'left', clickCount: 2 })[0][1]).toMatchObject({ type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 2 });
  });

  it('maps a wheel to a wheel event at its point, a pinch to the page scale and text to insertText', () => {
    expect(commands({ type: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: 120 })).toEqual([['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 120 }]]);
    expect(commands({ type: 'pinch', scale: 2.5 })).toEqual([['Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 }]]);
    expect(commands({ type: 'text', text: 'héllo 😀' })).toEqual([['Input.insertText', { text: 'héllo 😀' }]]);
  });

  it('maps keys to a down and an up, with the modifiers, and only Enter types a character', () => {
    expect(key('Enter')).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 }]]);
    expect(key('Backspace')[0][1]).toMatchObject({ type: 'rawKeyDown', windowsVirtualKeyCode: 8 });
    expect(key('Backspace')[0][1]).not.toHaveProperty('text');
    expect(key('a', 2)[0][1]).toEqual({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    expect(key('7', 4)[0][1]).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: 4 });
    expect(key('Enter', 2)[0][1]).toMatchObject({ type: 'rawKeyDown' });
  });
});

describe('session', () => {
  it('attaches to the page, sizes it like a phone and starts a JPEG screencast', async () => {
    const { browser } = await started();
    expect(browser.methods()).toEqual(['Target.getTargets', 'Target.attachToTarget', 'Page.enable', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast']);
    expect(browser.sent[1].params).toEqual({ targetId: 'page-1', flatten: true });
    expect(browser.sent[3]).toMatchObject({ sessionId: 'session-1', params: { width: 390, height: 700, mobile: false } });
    expect(browser.sent[4].params).toMatchObject({ format: 'jpeg' });
  });

  it('delivers decoded frames and acknowledges each one only when the viewer says so', async () => {
    const { frames, browser } = await started();
    browser.frame([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    expect(frames).toHaveLength(1);
    expect([...frames[0].jpeg]).toEqual([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    expect(browser.methods()).not.toContain('Page.screencastFrameAck');
    frames[0].acknowledge();
    await Promise.resolve();
    expect(browser.sent.at(-1)).toMatchObject({ method: 'Page.screencastFrameAck', params: { sessionId: 42 }, sessionId: 'session-1' });
  });

  it('sends an input message as its browser commands, in order, on the page', async () => {
    const { session, browser } = await started();
    const before = browser.sent.length;
    await session.input({ type: 'pointer', kind: 'press', x: 10, y: 20, button: 'left', clickCount: 2 });
    await session.input({ type: 'key', key: 'Enter', modifiers: 0 });
    expect(browser.sent.slice(before).map(call => [call.method, call.sessionId, call.params.type])).toEqual([
      ['Input.dispatchMouseEvent', 'session-1', 'mousePressed'],
      ['Input.dispatchKeyEvent', 'session-1', 'keyDown'], ['Input.dispatchKeyEvent', 'session-1', 'keyUp'],
    ]);
  });

  it('refuses a DevTools method outside the allow list without sending it, and stops the stream on close', async () => {
    const { session, browser } = await started();
    const raw = session as unknown as { send(method: string): Promise<unknown> };
    for (const method of ['Network.getAllCookies', 'Runtime.evaluate', 'Browser.close', 'Page.navigate'])
      await expect(raw.send(method)).rejects.toThrow('Refused');
    expect(browser.methods().filter(method => /^(Network|Runtime|Browser|Page\.navigate)/.test(method))).toEqual([]);
    await session.close();
    expect(browser.methods().at(-1)).toBe('Page.stopScreencast');
  });

  it('reports a closed connection to the viewer and fails pending calls', async () => {
    vi.stubGlobal('WebSocket', FakeBrowser);
    const closed = vi.fn();
    await HostBrowserSession.connect(parseEndpoint('ws://127.0.0.1:41234/devtools/browser/abc'), closed);
    FakeBrowser.instance.close();
    expect(closed).toHaveBeenCalledOnce();
  });
});
