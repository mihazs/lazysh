import {invoke} from '@tauri-apps/api/core';
import {captureAccess, protectedInvoke} from './access';
import type {TerminalPreferences} from './terminalAdapter';

/** What the shell knows about a session's native surface (Android, developer-only: docs/architecture/android-native-surface-host.md). */
export type SurfaceState = {placed: boolean; ready: boolean; generation: number; width: number; height: number; /** Whether the renderer drew on the surface that exists, and why not; absent where the shell cannot tell. */ drawing?: boolean; reason?: string};

/** One cell of the renderer's grid in device pixels. */
export type CellSize = {width: number; height: number};

/** An element's `getBoundingClientRect()` in CSS pixels and the page's `devicePixelRatio`. */
export type SurfaceAnchor = {x: number; y: number; width: number; height: number; dpr: number};

/** What decides how the renderer draws a session (its colours, glyphs and cursor): the terminal preferences it is told, not the ones that are the page's own (history, keys). */
export type SurfaceLook = Pick<TerminalPreferences, 'theme' | 'fontFamily' | 'fontSize' | 'cursorStyle' | 'cursorBlink' | 'brightBold' | 'boldColor'>;

/** What the surface's keyboard editor delivered (Android, #1328): committed text, keys as the core takes them, and the composing text. */
export type SurfaceInputEvent =
  | {type: 'text'; text: string}
  | {type: 'paste'; text: string}
  | {type: 'key'; code: string; key: string; mods: {shift: boolean; ctrl: boolean; alt: boolean; meta: boolean}; repeat: boolean; release: boolean; composing: boolean}
  | {type: 'preedit'; text: string | null};

/** The app commands; the renderer never reaches the Kotlin plugin directly. */
export const nativeSurface = {
  // Keep the native completion so removal cannot overtake an admitted placement.
  place: (session: string, anchor: SurfaceAnchor, background: number) => invoke<SurfaceState>('native_terminal_surface_place', {session, anchor, background}, {headers: captureAccess().headers}),
  /** How the session is drawn, from its next surface on and at once on one that is drawing; the shell keeps it, so it may come before the surface. */
  look: (session: string, look: SurfaceLook) => protectedInvoke<void>('native_terminal_surface_look', {session, look}),
  /** The cell the renderer draws for a font size in CSS pixels on a display of `dpr` device pixels per CSS pixel: the grid a pane holds is made of these. */
  cell: (fontSize: number, dpr: number) => protectedInvoke<CellSize>('native_terminal_surface_cell', {fontSize, dpr}),
  remove: (session: string) => invoke<void>('native_terminal_surface_remove', {session}),
  /** Waits for what the keyboard typed since the last call; each event comes once. */
  takeInput: (session: string) => protectedInvoke<{events: SurfaceInputEvent[]}>('native_terminal_surface_input', {session}),
  /** `keyboard: false` on a release leaves the keyboard open: a field of the page took it. */
  focus: (session: string, focused: boolean, keyboard = true, ifIdle?: boolean) => protectedInvoke<void>('native_terminal_surface_focus', {session, focused, keyboard, ifIdle}),
  state: (session: string) => protectedInvoke<SurfaceState>('native_terminal_surface_state', {session}),
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
  wait?: (milliseconds: number) => Promise<void>;
};

/** The surface exists a moment after the place command returns: how long, and how often, the tracker asks the shell whether the renderer drew on it. */
export const DRAW_CHECK_MS = 150;
export const DRAW_CHECK_TRIES = 40;

const same = (a: SurfaceAnchor | undefined, b: SurfaceAnchor) =>
  !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/**
 * Keeps a session's native surface on a DOM element. Layout, scroll, zoom and transitions all change the element's rectangle without
 * the page being told which, so any hint (a resize or scroll event, an observer callback) starts a short frame-by-frame look at the
 * rectangle that ends once it has held still for [SETTLE_FRAMES] frames: nothing runs while the page is idle. At most one command is in
 * flight; whatever moved meanwhile goes out as one command with the latest rectangle, never a queue. An element with no box (hidden,
 * detached) ends the surface, and the next time it has one the surface is placed again.
 */
export function trackSurfaceAnchor({session, element, background, onError, frame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, wait = ms => new Promise(resolve => setTimeout(resolve, ms))}: AnchorTrackerOptions) {
  let stopped = false;
  let handle: number | undefined;
  let busy = false;
  let sent: SurfaceAnchor | undefined;
  let quiet = 0;
  /** The command in flight, so `stop` can wait for it: the shell does not order commands, and a `remove` that overtook a `place` would leave a surface behind. */
  let inflight: Promise<unknown> = Promise.resolve();

  const read = (): SurfaceAnchor | undefined => {
    const rect = element.isConnected ? element.getBoundingClientRect() : undefined;
    return rect && rect.width > 0 && rect.height > 0 ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: window.devicePixelRatio} : undefined;
  };

  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    teardown();
    // A surface placed before the failure must not stay on screen with nothing tracking it.
    void inflight.catch(() => undefined).then(() => nativeSurface.remove(session)).catch(() => undefined);
    onError(error);
  };

  /**
   * A surface the renderer cannot draw on shows the pane's background and nothing else, which on a device looks like a native terminal that displays
   * nothing. The shell says whether the renderer drew once the surface exists, so a placed pane is asked until it does, and a refusal is a failure
   * with the shell's reason: the caller shows it and moves the session to xterm.js.
   */
  const verify = async (state: SurfaceState | undefined, tries = 0): Promise<void> => {
    if (stopped || state?.placed !== true || state.drawing === true) return;
    if (state.ready) {
      if (state.drawing === false) fail(new Error(`The native terminal cannot draw on this device: ${state.reason ?? 'the renderer refused the surface'}`));
      return;
    }
    if (tries >= DRAW_CHECK_TRIES) return;
    await wait(DRAW_CHECK_MS);
    if (stopped) return;
    // A shell that fails here fails the next place or the stop as well; this look is only a look.
    const next = await nativeSurface.state(session).catch(() => undefined);
    return verify(next, tries + 1);
  };

  const send = (anchor: SurfaceAnchor | undefined) => {
    busy = true;
    sent = anchor;
    const done = anchor ? nativeSurface.place(session, anchor, background()) : nativeSurface.remove(session);
    inflight = done;
    done.then(placed => { busy = false; if (!stopped) { quiet = 0; look(); if (anchor) void verify(placed as SurfaceState | undefined); } }, fail);
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
      await inflight.catch(() => undefined);
      await nativeSurface.remove(session).catch(() => undefined);
    },
  };
}
