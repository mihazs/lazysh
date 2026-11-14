import {invoke} from '@tauri-apps/api/core';

/** What the shell knows about a session's native surface (Android, developer-only: docs/architecture/android-native-surface-host.md). */
export type SurfaceState = {placed: boolean; ready: boolean; generation: number; width: number; height: number};

/** An element's `getBoundingClientRect()` in CSS pixels and the page's `devicePixelRatio`. */
export type SurfaceAnchor = {x: number; y: number; width: number; height: number; dpr: number};

/** The three app commands; the renderer never reaches the Kotlin plugin directly. */
export const nativeSurface = {
  place: (session: string, anchor: SurfaceAnchor, background: number) => invoke<SurfaceState>('native_terminal_surface_place', {session, anchor, background}),
  remove: (session: string) => invoke<void>('native_terminal_surface_remove', {session}),
  state: (session: string) => invoke<SurfaceState>('native_terminal_surface_state', {session}),
};

/** `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` as the `0xRRGGBB` number the shell takes; `undefined` for anything else (a named colour, a gradient). */
export function rgbOf(css: string): number | undefined {
  const text = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)?.[1];
  if (hex) return Number.parseInt(hex.length === 3 ? [...hex].map(c => c + c).join('') : hex, 16);
  const parts = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+[\d.]+%?)?\s*\)$/.exec(text)?.slice(1).map(Number);
  return parts && parts.every(part => part <= 255) ? (parts[0] << 16) | (parts[1] << 8) | parts[2] : undefined;
}

/** Frames of no change after which the tracker stops looking: long enough for a CSS transition to start, short enough to cost nothing idle. */
export const SETTLE_FRAMES = 12;

export type AnchorTrackerOptions = {
  session: string;
  element: Element;
  /** The pane's background as `0xRRGGBB`; read on every placement, so a theme change reaches the surface with the next one. */
  background(): number;
  /** The shell refused or failed; tracking has stopped and the surface is not shown. */
  onError(error: unknown): void;
  /** Injected by tests. */
  frame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

const same = (a: SurfaceAnchor | undefined, b: SurfaceAnchor) =>
  !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/**
 * Keeps a session's native surface on a DOM element. Layout, scroll, zoom and transitions all change the element's rectangle without
 * the page being told which, so any hint (a resize or scroll event, an observer callback) starts a short frame-by-frame look at the
 * rectangle that ends once it has held still for [SETTLE_FRAMES] frames: nothing runs while the page is idle. At most one command is in
 * flight; whatever moved meanwhile goes out as one command with the latest rectangle, never a queue. An element with no box (hidden,
 * detached) ends the surface, and the next time it has one the surface is placed again.
 */
export function trackSurfaceAnchor({session, element, background, onError, frame = requestAnimationFrame, cancelFrame = cancelAnimationFrame}: AnchorTrackerOptions) {
  let stopped = false;
  let handle: number | undefined;
  let busy = false;
  let sent: SurfaceAnchor | undefined;
  let quiet = 0;

  const read = (): SurfaceAnchor | undefined => {
    const rect = element.isConnected ? element.getBoundingClientRect() : undefined;
    return rect && rect.width > 0 && rect.height > 0 ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: window.devicePixelRatio} : undefined;
  };

  const fail = (error: unknown) => { if (!stopped) { stopped = true; teardown(); onError(error); } };

  const send = (anchor: SurfaceAnchor | undefined) => {
    busy = true;
    sent = anchor;
    const done = anchor ? nativeSurface.place(session, anchor, background()) : nativeSurface.remove(session);
    done.then(() => { busy = false; if (!stopped) { quiet = 0; look(); } }, fail);
  };

  const look = () => {
    if (stopped || handle !== undefined) return;
    handle = frame(() => {
      handle = undefined;
      if (stopped) return;
      const now = read();
      const changed = now ? !same(sent, now) : sent !== undefined;
      if (changed && !busy) { quiet = 0; send(now); return; }
      if (changed || ++quiet < SETTLE_FRAMES) look();
    });
  };

  const hint = () => { quiet = 0; look(); };
  // A rectangle moves for reasons the page cannot name (a sibling grows, a class starts a transition), so any DOM change is a hint too.
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(hint);
  observer?.observe(element);
  const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(hint);
  mutations?.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
  const viewport: EventTarget = window.visualViewport ?? window;
  const events: [EventTarget, string][] = [[window, 'resize'], [window, 'scroll'], [viewport, 'resize'], [viewport, 'scroll'], [document, 'transitionrun'], [document, 'transitionend'], [document, 'animationstart']];
  for (const [target, type] of events) target.addEventListener(type, hint, {capture: true, passive: true});
  const teardown = () => {
    observer?.disconnect();
    mutations?.disconnect();
    for (const [target, type] of events) target.removeEventListener(type, hint, {capture: true});
    if (handle !== undefined) { cancelFrame(handle); handle = undefined; }
  };
  hint();

  return {
    /** Ends the surface and the tracking; resolves when the shell has been told. */
    async stop() {
      if (stopped) return;
      stopped = true;
      teardown();
      await nativeSurface.remove(session).catch(() => undefined);
    },
  };
}
