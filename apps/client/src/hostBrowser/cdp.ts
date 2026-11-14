import { normalizeAddress } from './address';
import { historyReach, pageTabs, untrusted, type Blocked, type History, type Navigation, type PageDialog, type TargetInfo, type View } from './model';

/**
 * Developer prototype for the host browser (docs/host-browser.md, "Prototype"): a small DevTools Protocol client
 * for one browser, showing one of its pages at a time. It is reachable only from the Vite dev server (see main.tsx).
 *
 * The allow list below is the contract the product relay enforces on the host; here it is a guard in the
 * client, not a security boundary, because the prototype talks to the debug port directly.
 */
export const allowedMethods: ReadonlySet<string> = new Set([
  'Target.getTargets', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.setDiscoverTargets',
  'Target.activateTarget', 'Target.createTarget', 'Target.closeTarget',
  'Page.enable', 'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck',
  'Page.navigate', 'Page.reload', 'Page.stopLoading', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
  'Page.handleJavaScriptDialog', 'Page.setInterceptFileChooserDialog', 'Browser.setDownloadBehavior',
  'Emulation.setDeviceMetricsOverride',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
]);

/**
 * Parameters the relay checks on top of the method name (apps/agent `host_browser::allow`): a page address must be
 * one the address bar accepts, a download is only ever denied and the file chooser is only ever intercepted.
 */
export function refusal(method: string, params: Record<string, unknown>): string | undefined {
  if (!allowedMethods.has(method)) return `Refused DevTools method ${method}`;
  if (method === 'Page.navigate' || method === 'Target.createTarget') {
    const url = String(params.url ?? ''), address = normalizeAddress(url);
    if (!address.ok || address.url !== url) return `Refused address for ${method}`;
  }
  if (method === 'Browser.setDownloadBehavior' && params.behavior !== 'deny') return 'Downloads are only ever denied';
  if (method === 'Page.setInterceptFileChooserDialog' && params.enabled !== true) return 'The file chooser is only ever intercepted';
  return undefined;
}

export type FrameMetadata = { deviceWidth: number; deviceHeight: number; offsetTop: number; timestamp: number };
export type Frame = { jpeg: Uint8Array<ArrayBuffer>; metadata: FrameMetadata };

/** Only a loopback DevTools browser endpoint: the SSH-forwarded port on this device. */
export function parseEndpoint(text: string): URL {
  const url = new URL(text.trim());
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port
    || !/^\/devtools\/browser\/[0-9a-fA-F-]+$/.test(url.pathname) || url.search || url.username || url.password)
    throw new Error('Enter ws://127.0.0.1:<port>/devtools/browser/<id>');
  return url;
}

/** A point on the displayed frame, as a fraction of its width and height, in the page's CSS pixels. */
export function pagePoint(fraction: { x: number; y: number }, frame: FrameMetadata) {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: Math.round(clamp(fraction.x) * frame.deviceWidth),
    y: Math.max(0, Math.round(clamp(fraction.y) * frame.deviceHeight - frame.offsetTop)),
  };
}

const specialKeys: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};
/** Keys that are not text. Printable text and composition go through `text()` so an IME works. */
export function specialKey(key: string) {
  return key in specialKeys ? { key, code: key, windowsVirtualKeyCode: specialKeys[key] } : undefined;
}

type Wire = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };
export type Listener = { view?: (view: View) => void; dialog?: (dialog: PageDialog | null) => void; blocked?: (kind: Blocked) => void };
type PageInfo = TargetInfo & { openerId?: string };

export class HostBrowserSession implements Navigation {
  /** Who hears about tabs, the page's dialogs and what the browser refused to do. Set before `start`. */
  listener: Listener = {};
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private page = '';
  private active = '';
  private targets = new Map<string, PageInfo>();
  private history: History | null = null;
  private loading = false;
  private dialogOpen = false;
  private size = { width: 390, height: 700 };
  private queue: Promise<unknown> = Promise.resolve();
  private frameListener: (frame: Frame, acknowledge: () => void) => void = () => {};
  private constructor(socket: WebSocket) { this.socket = socket; }

  static async connect(endpoint: URL, onClose: () => void = () => {}) {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('The debug port refused the connection (origin or port?)'));
    });
    const session = new HostBrowserSession(socket);
    socket.onmessage = event => session.receive(JSON.parse(String(event.data)));
    socket.onclose = () => { session.pending.forEach(call => call.reject(new Error('closed'))); onClose(); };
    return session;
  }

  private receive(message: Wire) {
    if (message.id !== undefined) {
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
      return;
    }
    const { method = '', params } = message;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') this.seen(params.targetInfo, method === 'Target.targetCreated');
    else if (method === 'Target.targetDestroyed') this.gone(params.targetId);
    else if (method === 'Browser.downloadWillBegin') this.listener.blocked?.('download');
    else if (message.sessionId === this.page) this.pageEvent(method, params);
  }

  private pageEvent(method: string, params: any) {
    switch (method) {
      case 'Page.screencastFrame': {
        const { data, metadata, sessionId } = params;
        const binary = atob(data);
        const jpeg = Uint8Array.from(binary, character => character.charCodeAt(0));
        this.frameListener({ jpeg, metadata }, () => void this.send('Page.screencastFrameAck', { sessionId }, true).catch(() => {}));
        break;
      }
      // The main frame of a page has the id of its target.
      case 'Page.frameStartedLoading': if (params.frameId === this.active) { this.loading = true; this.emit(); } break;
      case 'Page.frameStoppedLoading': if (params.frameId === this.active) { this.loading = false; this.emit(); void this.settled(); } break;
      case 'Page.navigatedWithinDocument': void this.settled(); break;
      case 'Page.javascriptDialogOpening':
        this.dialogOpen = true;
        this.listener.dialog?.({ kind: params.type, message: untrusted(params.message, 1000, true), defaultPrompt: untrusted(params.defaultPrompt, 1000) });
        break;
      case 'Page.javascriptDialogClosed': this.dialogOpen = false; this.listener.dialog?.(null); break;
      case 'Page.fileChooserOpened': this.listener.blocked?.('fileChooser'); break;
    }
  }

  /** A page the browser told us about; a popup that the shown page opened becomes the shown page, like in a browser. */
  private seen(info: PageInfo, created: boolean) {
    if (info.type !== 'page') return;
    const known = this.targets.has(info.targetId), changedUrl = this.targets.get(info.targetId)?.url !== info.url;
    this.targets.set(info.targetId, info);
    if (created && !known && this.active && info.openerId === this.active) this.later(() => this.show(info.targetId));
    else if (info.targetId === this.active && changedUrl) void this.settled();
    this.emit();
  }

  private gone(id: string) {
    if (!this.targets.delete(id)) return;
    this.emit();
    if (id !== this.active) return;
    this.active = '';
    const [next] = [...this.targets.keys()].slice(-1);
    this.later(async () => this.show(next ?? await this.create()));
  }

  private later<T>(job: () => Promise<T>) {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  private send(method: string, params: object = {}, onPage = false): Promise<any> {
    const refused = refusal(method, params as Record<string, unknown>);
    if (refused) return Promise.reject(new Error(refused));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(onPage ? { sessionId: this.page } : {}) }));
    });
  }

  private emit() {
    const reach = historyReach(this.history);
    this.listener.view?.({
      tabs: pageTabs([...this.targets.values()]), activeId: this.active || null,
      canGoBack: reach.back !== undefined, canGoForward: reach.forward !== undefined, loading: this.loading,
    });
  }

  /** A page's address, title and history are read again whenever it settles. */
  private settled() { return Promise.all([this.refreshTargets(), this.refreshHistory()]); }

  /**
   * `Target.getTargets` has the title that a navigation ends with; the change notification for it is not sent after
   * the first page (measured on Chromium 157), so the list is read again. Only pages already known are updated:
   * one that went away meanwhile stays gone.
   */
  private async refreshTargets() {
    const { targetInfos = [] } = await this.send('Target.getTargets').catch(() => ({}));
    for (const info of targetInfos) if (info.type === 'page' && this.targets.has(info.targetId)) this.targets.set(info.targetId, info);
    this.emit();
  }

  private async refreshHistory() {
    const page = this.page;
    const history = await this.send('Page.getNavigationHistory', {}, true).catch(() => null);
    if (history && page === this.page) { this.history = history; this.emit(); }
  }

  private async create() {
    return (await this.send('Target.createTarget', { url: 'about:blank' })).targetId as string;
  }

  /** Show one page: leave the page that was shown, size the new one like a phone, and start its frames. */
  private async show(id: string) {
    if (this.page) {
      // A dialog left open would keep the page it belongs to blocked for as long as nobody looks at it.
      if (this.dialogOpen) await this.send('Page.handleJavaScriptDialog', { accept: false }, true).catch(() => {});
      await this.send('Page.stopScreencast', {}, true).catch(() => {});
      await this.send('Target.detachFromTarget', { sessionId: this.page }).catch(() => {});
    }
    Object.assign(this, { page: '', active: id, history: null, loading: false, dialogOpen: false });
    this.listener.dialog?.(null);
    this.page = (await this.send('Target.attachToTarget', { targetId: id, flatten: true })).sessionId;
    await this.send('Page.enable', {}, true);
    await this.send('Emulation.setDeviceMetricsOverride', { ...this.size, deviceScaleFactor: 1, mobile: false }, true);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }, true);
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 }, true);
    this.emit();
    await this.refreshHistory();
  }

  /** Show the first page, size it like a phone and start frames. Each frame must be acknowledged. */
  async start(size: { width: number; height: number }, onFrame: (frame: Frame, acknowledge: () => void) => void) {
    this.size = size;
    this.frameListener = onFrame;
    // Downloads are denied before any page can start one; the browser still reports each attempt.
    await this.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    await this.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.send('Target.getTargets');
    for (const info of targetInfos) if (info.type === 'page') this.targets.set(info.targetId, info);
    const [first] = this.targets.keys();
    if (!first) throw new Error('The browser has no page');
    await this.later(() => this.show(first));
  }

  async navigate(address: string) {
    const result = normalizeAddress(address);
    if (!result.ok) throw new Error(`Refused address: ${result.refusal.reason}`);
    await this.send('Page.navigate', { url: result.url }, true);
  }
  async back() { await this.travel('back'); }
  async forward() { await this.travel('forward'); }
  private async travel(direction: 'back' | 'forward') {
    await this.refreshHistory();
    const entryId = historyReach(this.history)[direction];
    if (entryId !== undefined) await this.send('Page.navigateToHistoryEntry', { entryId }, true);
  }
  async reload() { await this.send('Page.reload', {}, true); }
  async stop() { await this.send('Page.stopLoading', {}, true); }

  async activate(id: string) {
    if (!this.targets.has(id)) throw new Error('No such tab');
    await this.later(async () => {
      // Without this a background page produces no frames.
      await this.send('Target.activateTarget', { targetId: id });
      if (id !== this.active) await this.show(id);
    });
  }
  async newTab() { await this.later(async () => this.show(await this.create())); }
  async closeTab(id: string) {
    if (!this.targets.has(id)) throw new Error('No such tab');
    // A browser keeps a page: the last tab is replaced by a blank one, never left without any.
    await this.later(async () => {
      if (this.targets.size === 1) await this.create();
      await this.send('Target.closeTarget', { targetId: id });
    });
  }
  async answer(accept: boolean, text = '') { await this.send('Page.handleJavaScriptDialog', { accept, promptText: text }, true); }

  /** A tap is a click: press and release are sent together, so it costs one round trip. */
  tap(point: { x: number; y: number }) {
    const base = { ...point, button: 'left', clickCount: 1 };
    return Promise.all([
      this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, true),
      this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, true),
    ]);
  }
  text(text: string) { return this.send('Input.insertText', { text }, true); }
  async key(name: string) {
    const key = specialKey(name);
    if (!key) return;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, ...(name === 'Enter' ? { text: '\r' } : {}) }, true);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, true);
  }

  async close() {
    if (this.socket.readyState === WebSocket.OPEN) await this.send('Page.stopScreencast', {}, true).catch(() => {});
    this.socket.close();
  }
}
