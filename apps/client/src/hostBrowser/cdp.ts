import type { InputMessage } from './input';

/**
 * Developer prototype for the host browser (docs/host-browser.md, "Prototype"): a small DevTools Protocol client
 * for one page of a Chrome-family browser. It is reachable only from the Vite dev server (see main.tsx).
 *
 * The allow list below is the contract the product relay enforces on the host; here it is a guard in the
 * client, not a security boundary, because the prototype talks to the debug port directly.
 */
export const allowedMethods: ReadonlySet<string> = new Set([
  'Target.getTargets', 'Target.attachToTarget',
  'Page.enable', 'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck',
  'Emulation.setDeviceMetricsOverride', 'Emulation.setPageScaleFactor',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
]);

/** What the browser says about a frame. The page's scroll offset and scale come from here, never from what was sent. */
export type FrameMetadata = {
  deviceWidth: number; deviceHeight: number; offsetTop: number; timestamp: number; scrollOffsetY?: number; pageScaleFactor?: number;
};
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
  return Object.hasOwn(specialKeys, key) ? { key, code: key, windowsVirtualKeyCode: specialKeys[key] } : undefined;
}

const buttons = { none: 0, left: 1, right: 2 };
/** The DevTools commands for one input message (the relay maps the same messages onto the same methods). */
export function inputCommands(message: InputMessage): { method: string; params: object }[] {
  switch (message.type) {
    case 'pointer': {
      const { kind, x, y, button, clickCount } = message;
      const type = { move: 'mouseMoved', press: 'mousePressed', release: 'mouseReleased' }[kind];
      return [{ method: 'Input.dispatchMouseEvent', params: { type, x, y, button, buttons: kind === 'release' ? 0 : buttons[button], clickCount } }];
    }
    case 'wheel': {
      const { x, y, deltaX, deltaY } = message;
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX, deltaY } }];
    }
    case 'pinch': return [{ method: 'Emulation.setPageScaleFactor', params: { pageScaleFactor: message.scale } }];
    case 'text': return [{ method: 'Input.insertText', params: { text: message.text } }];
    case 'key': {
      const key = specialKey(message.key) ?? { key: message.key, code: /^\d$/.test(message.key) ? `Digit${message.key}` : `Key${message.key.toUpperCase()}`, windowsVirtualKeyCode: message.key.toUpperCase().charCodeAt(0) };
      const base = { ...key, modifiers: message.modifiers };
      // Enter types a line break; a chord and the other keys are not text, so they are raw key events.
      const text = message.key === 'Enter' && !(message.modifiers & 7) ? '\r' : undefined;
      return [
        { method: 'Input.dispatchKeyEvent', params: { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) } },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } },
      ];
    }
  }
}

type Wire = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

export class HostBrowserSession {
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private page = '';
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
    } else if (message.method === 'Page.screencastFrame' && message.sessionId === this.page) {
      const { data, metadata, sessionId } = message.params;
      const binary = atob(data);
      const jpeg = Uint8Array.from(binary, character => character.charCodeAt(0));
      this.frameListener({ jpeg, metadata }, () => void this.send('Page.screencastFrameAck', { sessionId }, true).catch(() => {}));
    }
  }

  private send(method: string, params: object = {}, onPage = false): Promise<any> {
    if (!allowedMethods.has(method)) return Promise.reject(new Error(`Refused DevTools method ${method}`));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(onPage ? { sessionId: this.page } : {}) }));
    });
  }

  /** Attach to the first page, size it like a phone and start frames. Each frame must be acknowledged. */
  async start(size: { width: number; height: number }, onFrame: (frame: Frame, acknowledge: () => void) => void) {
    const { targetInfos } = await this.send('Target.getTargets');
    const target = targetInfos.find((info: { type: string }) => info.type === 'page');
    if (!target) throw new Error('The browser has no page');
    this.page = (await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    this.frameListener = onFrame;
    await this.send('Page.enable', {}, true);
    await this.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false }, true);
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 }, true);
  }

  /** One input message, as the browser's input commands, sent in order so a press never overtakes its move. */
  async input(message: InputMessage) {
    await Promise.all(inputCommands(message).map(({ method, params }) => this.send(method, params, true)));
  }

  async close() {
    if (this.socket.readyState === WebSocket.OPEN) await this.send('Page.stopScreencast', {}, true).catch(() => {});
    this.socket.close();
  }
}
