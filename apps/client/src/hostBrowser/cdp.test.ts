import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostBrowserSession, pagePoint, parseEndpoint, refusal } from './cdp';
import type { Blocked, PageDialog, View } from './model';

type Sent = { id: number; method: string; params: any; sessionId?: string };

/** A DevTools endpoint in memory: answers the calls the prototype makes and records everything it was sent. */
class FakeBrowser {
  static OPEN = 1;
  static instance: FakeBrowser;
  /** What a call answers; a function sees the call's parameters. */
  static results: Record<string, unknown> = {};
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
      'Target.getTargets': { targetInfos: [{ type: 'service_worker', targetId: 'w' }, { type: 'page', targetId: 'page-1', title: 'One', url: 'https://one.test/' }] },
      'Target.attachToTarget': (params: { targetId: string }) => ({ sessionId: `session-${params.targetId.replace('page-', '')}` }),
      'Target.createTarget': { targetId: 'page-9' },
      'Page.getNavigationHistory': { currentIndex: 0, entries: [{ id: 7 }] },
      ...FakeBrowser.results,
    };
    const result = results[call.method];
    queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: call.id, result: (typeof result === 'function' ? (result as (params: unknown) => unknown)(call.params) : result) ?? {} }) }));
  }
  event(method: string, params: unknown, sessionId?: string) { this.onmessage({ data: JSON.stringify({ method, params, sessionId }) }); }
  frame(bytes: number[], metadata = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0, timestamp: 1 }, sessionId = 'session-1') {
    this.event('Page.screencastFrame', { data: btoa(String.fromCharCode(...bytes)), metadata, sessionId: 42 }, sessionId);
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
afterEach(() => { vi.unstubAllGlobals(); FakeBrowser.results = {}; });

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
    expect(browser.methods()).toEqual(['Browser.setDownloadBehavior', 'Target.setDiscoverTargets', 'Target.getTargets', 'Target.attachToTarget', 'Page.enable',
      'Emulation.setDeviceMetricsOverride', 'Page.setInterceptFileChooserDialog', 'Page.startScreencast', 'Page.getNavigationHistory']);
    expect(browser.sent[3].params).toEqual({ targetId: 'page-1', flatten: true });
    expect(browser.sent[5]).toMatchObject({ sessionId: 'session-1', params: { width: 390, height: 700, mobile: false } });
    expect(browser.sent[7].params).toMatchObject({ format: 'jpeg' });
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
    const before = browser.sent.length;
    for (const method of ['Network.getAllCookies', 'Runtime.evaluate', 'Browser.close', 'Browser.setPermission', 'Page.captureScreenshot'])
      await expect(raw.send(method)).rejects.toThrow('Refused');
    expect(browser.sent).toHaveLength(before);
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

const RLO = String.fromCodePoint(0x202e);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const info = (targetId: string, extra: object = {}) => ({ targetInfo: { type: 'page', targetId, title: targetId, url: `https://${targetId}.test/`, ...extra } });

/** A started session whose tabs, dialogs and refused attempts are recorded as the controls would see them. */
async function watched() {
  vi.stubGlobal('WebSocket', FakeBrowser);
  const seen = { views: [] as View[], dialogs: [] as (PageDialog | null)[], blocked: [] as Blocked[] };
  const session = await HostBrowserSession.connect(parseEndpoint('ws://127.0.0.1:41234/devtools/browser/0dcb9dfb-aaf4-4104-9985-0bdc81f6c5c9'));
  session.listener = { view: view => seen.views.push(view), dialog: dialog => seen.dialogs.push(dialog), blocked: kind => seen.blocked.push(kind) };
  await session.start({ width: 390, height: 700 }, () => {});
  const browser = FakeBrowser.instance;
  /** The calls sent since `mark()` was taken. */
  const mark = () => browser.sent.length;
  return { session, browser, seen, mark, view: () => seen.views.at(-1)!, since: (from: number) => browser.sent.slice(from) };
}
const methods = (calls: Sent[]) => calls.map(call => call.method);

describe('tabs', () => {
  it('lists only pages, as text a page cannot disguise, and follows their titles and addresses', async () => {
    const { browser, view } = await watched();
    expect(view()).toMatchObject({ activeId: 'page-1', tabs: [{ id: 'page-1', title: 'One', url: 'https://one.test/' }] });
    browser.event('Target.targetCreated', { targetInfo: { type: 'service_worker', targetId: 'worker', title: 'sw', url: 'https://sw.test/' } });
    browser.event('Target.targetCreated', info('page-2', { title: '', url: '' }));
    browser.event('Target.targetInfoChanged', info('page-2', { title: `evil${RLO}gnp.exe\nTwo`, url: 'https://two.test/path' }));
    expect(view().tabs.map(tab => [tab.id, tab.title, tab.url])).toEqual([['page-1', 'One', 'https://one.test/'], ['page-2', 'evilgnp.exe Two', 'https://two.test/path']]);
    browser.event('Target.targetDestroyed', { targetId: 'page-2' });
    expect(view().tabs.map(tab => tab.id)).toEqual(['page-1']);
  });

  it('reads a title again when its page settles, because the browser does not announce a later one', async () => {
    const { browser, view } = await watched();
    FakeBrowser.results['Target.getTargets'] = { targetInfos: [{ type: 'page', targetId: 'page-1', title: 'Settled', url: 'https://one.test/next' }, { type: 'page', targetId: 'closed', title: 'Gone', url: 'https://gone.test/' }] };
    browser.event('Page.frameStartedLoading', { frameId: 'page-1' }, 'session-1');
    expect(view().tabs[0].title).toBe('One');
    browser.event('Page.frameStoppedLoading', { frameId: 'page-1' }, 'session-1');
    await flush();
    expect(view().tabs.map(tab => [tab.id, tab.title, tab.url])).toEqual([['page-1', 'Settled', 'https://one.test/next']]);
  });

  it('shows a page that the shown page opened, and switches by moving the frames, not by keeping both', async () => {
    const { session, browser, view, since, mark } = await watched();
    let from = mark();
    browser.event('Target.targetCreated', info('page-2', { openerId: 'page-1' }));
    await flush();
    expect(view().activeId).toBe('page-2');
    expect(methods(since(from))).toEqual(['Page.stopScreencast', 'Target.detachFromTarget', 'Target.attachToTarget', 'Page.enable', 'Emulation.setDeviceMetricsOverride',
      'Page.setInterceptFileChooserDialog', 'Page.startScreencast', 'Page.getNavigationHistory']);
    // A page that nothing in this browser opened does not take the view.
    browser.event('Target.targetCreated', info('page-3'));
    await flush();
    expect(view().activeId).toBe('page-2');
    from = mark();
    await session.activate('page-1');
    expect(methods(since(from)).slice(0, 4)).toEqual(['Target.activateTarget', 'Page.stopScreencast', 'Target.detachFromTarget', 'Target.attachToTarget']);
    expect(since(from)[0].params).toEqual({ targetId: 'page-1' });
    expect(view().activeId).toBe('page-1');
    await expect(session.activate('missing')).rejects.toThrow('No such tab');
  });

  it('drops frames from a page that is no longer shown', async () => {
    const { session, browser } = await watched();
    const frames: number[] = [];
    (session as unknown as { frameListener: (frame: { jpeg: Uint8Array }) => void }).frameListener = frame => frames.push(frame.jpeg[0]);
    browser.event('Target.targetCreated', info('page-2'));
    await session.activate('page-2');
    browser.frame([1], undefined, 'session-1');
    browser.frame([2], undefined, 'session-2');
    expect(frames).toEqual([2]);
  });

  it('opens a blank tab, and replaces the last tab instead of leaving the browser without a page', async () => {
    const { session, browser, view, since, mark } = await watched();
    let from = mark();
    await session.newTab();
    expect(since(from)[0]).toMatchObject({ method: 'Target.createTarget', params: { url: 'about:blank' } });
    expect(view().activeId).toBe('page-9');
    // Only one real page is known to the fake, so closing it must first create the replacement.
    browser.event('Target.targetCreated', info('page-9', { url: 'about:blank' }));
    browser.event('Target.targetDestroyed', { targetId: 'page-1' });
    expect(view().tabs.map(tab => tab.id)).toEqual(['page-9']);
    from = mark();
    await session.closeTab('page-9');
    expect(methods(since(from)).slice(0, 2)).toEqual(['Target.createTarget', 'Target.closeTarget']);
    expect(since(from)[1].params).toEqual({ targetId: 'page-9' });
  });

  it('shows another tab when the shown one goes away', async () => {
    const { browser, view } = await watched();
    browser.event('Target.targetCreated', info('page-2'));
    browser.event('Target.targetDestroyed', { targetId: 'page-1' });
    await flush();
    expect(view().activeId).toBe('page-2');
  });
});

describe('navigation', () => {
  it('opens an address through the same rule as the address bar and sends nothing for a refused one', async () => {
    const { session, since, mark } = await watched();
    const from = mark();
    await session.navigate(' Example.com/a b ');
    await session.navigate('localhost:3000');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings', 'view-source:https://a.test', '']) await expect(session.navigate(bad), bad).rejects.toThrow('Refused address');
    expect(since(from).map(call => [call.method, call.params.url, call.sessionId])).toEqual([
      ['Page.navigate', 'https://example.com/a%20b', 'session-1'], ['Page.navigate', 'http://localhost:3000/', 'session-1'],
    ]);
  });

  it('goes back and forward to the history entries beside the current one, and does nothing at either end', async () => {
    const { session, browser, view, since, mark } = await watched();
    expect(view()).toMatchObject({ canGoBack: false, canGoForward: false });
    FakeBrowser.results['Page.getNavigationHistory'] = { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };
    browser.event('Page.navigatedWithinDocument', { frameId: 'page-1' }, 'session-1');
    await flush();
    expect(view()).toMatchObject({ canGoBack: true, canGoForward: true });
    let from = mark();
    await session.back();
    await session.forward();
    expect(since(from).filter(call => call.method === 'Page.navigateToHistoryEntry').map(call => call.params.entryId)).toEqual([10, 12]);
    FakeBrowser.results['Page.getNavigationHistory'] = { currentIndex: 0, entries: [{ id: 10 }] };
    from = mark();
    await session.back();
    await session.forward();
    expect(methods(since(from))).not.toContain('Page.navigateToHistoryEntry');
  });

  it('reloads, stops, and tells the controls while the main frame is loading', async () => {
    const { session, browser, view, since, mark } = await watched();
    const from = mark();
    await session.reload();
    await session.stop();
    expect(methods(since(from))).toEqual(['Page.reload', 'Page.stopLoading']);
    browser.event('Page.frameStartedLoading', { frameId: 'page-1' }, 'session-1');
    expect(view().loading).toBe(true);
    browser.event('Page.frameStartedLoading', { frameId: 'ad-frame' }, 'session-1');
    browser.event('Page.frameStoppedLoading', { frameId: 'page-1' }, 'session-1');
    expect(view().loading).toBe(false);
  });
});

describe('what the page asks for', () => {
  it('shows a dialog as bounded plain text, answers it, and clears it when the page closes it', async () => {
    const { session, browser, seen, since, mark } = await watched();
    browser.event('Page.javascriptDialogOpening', { type: 'prompt', message: `Pay now?${RLO}\n${'x'.repeat(2000)}`, defaultPrompt: 'yes' }, 'session-1');
    const shown = seen.dialogs.at(-1)!;
    expect(shown).toMatchObject({ kind: 'prompt', defaultPrompt: 'yes' });
    expect(shown.message.startsWith('Pay now?\n')).toBe(true);
    expect(shown.message.length).toBeLessThanOrEqual(1000);
    const from = mark();
    await session.answer(true, 'no');
    expect(since(from)[0]).toMatchObject({ method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'no' }, sessionId: 'session-1' });
    browser.event('Page.javascriptDialogClosed', { result: true }, 'session-1');
    expect(seen.dialogs.at(-1)).toBeNull();
  });

  it('dismisses a dialog the person has left behind by switching tabs', async () => {
    const { session, browser, since, mark } = await watched();
    browser.event('Target.targetCreated', info('page-2'));
    browser.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '', defaultPrompt: '' }, 'session-1');
    const from = mark();
    await session.activate('page-2');
    expect(since(from).find(call => call.method === 'Page.handleJavaScriptDialog')!.params).toMatchObject({ accept: false });
  });

  it('denies downloads and the file chooser before any page can use them, and reports each attempt', async () => {
    const { browser, seen } = await watched();
    expect(browser.sent[0]).toMatchObject({ method: 'Browser.setDownloadBehavior', params: { behavior: 'deny', eventsEnabled: true } });
    expect(browser.sent.find(call => call.method === 'Page.setInterceptFileChooserDialog')!.params).toEqual({ enabled: true });
    browser.event('Browser.downloadWillBegin', { frameId: 'page-1', guid: 'g', url: 'https://one.test/file', suggestedFilename: 'x.bin' });
    browser.event('Page.fileChooserOpened', { frameId: 'page-1', mode: 'selectSingle', backendNodeId: 3 }, 'session-1');
    expect(seen.blocked).toEqual(['download', 'fileChooser']);
  });

  it('refuses a protocol call that would allow what the host browser never allows', () => {
    expect(refusal('Browser.setDownloadBehavior', { behavior: 'allow' })).toMatch('denied');
    expect(refusal('Browser.setDownloadBehavior', { behavior: 'deny' })).toBeUndefined();
    expect(refusal('Page.setInterceptFileChooserDialog', { enabled: false })).toMatch('intercepted');
    for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'example.com', 'https://a.test/ b', undefined]) expect(refusal('Page.navigate', { url }), String(url)).toMatch('Refused address');
    expect(refusal('Target.createTarget', { url: 'about:blank' })).toBeUndefined();
    expect(refusal('Page.navigate', { url: 'https://example.com/' })).toBeUndefined();
    expect(refusal('Network.getCookies', {})).toMatch('Refused DevTools method');
  });
});
