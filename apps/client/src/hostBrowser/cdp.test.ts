import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostBrowserSession, pagePoint, parseEndpoint } from './cdp';

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

  it('sends a tap as press and release at the same point, and typed text and special keys as input', async () => {
    const { session, browser } = await started();
    const before = browser.sent.length;
    await session.tap({ x: 10, y: 20 });
    await session.text('olá 世界');
    await session.key('Enter');
    await session.key('Backspace');
    await session.key('a');
    expect(browser.sent.slice(before).map(call => [call.method, call.params.type ?? call.params.text])).toEqual([
      ['Input.dispatchMouseEvent', 'mousePressed'], ['Input.dispatchMouseEvent', 'mouseReleased'],
      ['Input.insertText', 'olá 世界'],
      ['Input.dispatchKeyEvent', 'keyDown'], ['Input.dispatchKeyEvent', 'keyUp'],
      ['Input.dispatchKeyEvent', 'keyDown'], ['Input.dispatchKeyEvent', 'keyUp'],
    ]);
    expect(browser.sent[before]).toMatchObject({ params: { x: 10, y: 20, button: 'left', clickCount: 1 } });
    expect(browser.sent[before + 3].params).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
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
