import { Terminal } from "@xterm/xterm";
import { observeTerminalIme, type UnappliedTerminalEdit } from "./terminalIme";
import { getPreferences, terminalOptions } from "./preferences";
import { fontFamilyFor } from "./fonts";
export { applyTerminalTheme } from "./terminalBold";

export function createTerminal() {
  return new Terminal({
    ...terminalOptions(getPreferences(), fontFamilyFor(getPreferences())),
    lineHeight: 1.3,
    allowProposedApi: false,
  });
}

export type LiveSession = {
  id: string;
  hostId: string;
  name: string;
  destination: string;
  terminal: Terminal;
  connected: boolean;
  disposed?: true;
  local?: true;
  moshResize?: import('./moshResize').MoshResizeController;
  mosh?: {serverPath: string; portMin: number; portMax: number};
  et?: {serverPath: string; port: number};
  auto?: import('./bridge').AutoOptions;
  transportNotice?: string;
  message?: string;
  /** The transport dropped without the remote ending the session; reconnecting may resume it. */
  lost?: true;
  attached?: import('./workspace').SessionAttachment;
};

/** xterm 5.5 viewport seam. A container resize can clamp the DOM viewport
 * before xterm records the new geometry, queuing a scroll event that would move
 * a reader to wherever the clamp landed (and stop a following reader from
 * following). Re-deriving the scroll area now makes that event a no-op.
 */
export function syncTerminalViewport(terminal: Terminal) {
  const viewport = (terminal as unknown as {_core?: {viewport?: {_refresh?: (immediate: boolean) => void}}})._core?.viewport;
  if (typeof viewport?._refresh === 'function') viewport._refresh(true);
}

/** xterm 5.5 viewport seam. To follow output, xterm moves the DOM viewport
 * itself and ignores the next scroll event. A wheel or touch scroll that lands
 * before that event is dispatched merges into it and is dropped: the viewport
 * reports history while the rendered rows stay live. Once xterm has handled the
 * scroll event, a user scroll still out of step moves the buffer to the row the
 * viewport shows, with xterm's own row height and rounding.
 */
export function keepViewportScrolls(terminal: Terminal, element: HTMLElement) {
  const viewport = terminal.element?.querySelector<HTMLElement>('.xterm-viewport');
  if (!viewport) return () => {};
  const core = (terminal as unknown as {_core?: {viewport?: {_currentRowHeight?: unknown}}})._core;
  let before: number | undefined, moved = false;
  const gesture = () => {before = viewport.scrollTop;};
  // xterm's wheel and touch handlers move the viewport synchronously; their scroll
  // event follows in the next frame, before that frame's animation callbacks.
  const settled = () => {
    if (before !== undefined && viewport.scrollTop !== before && !moved) {moved = true; requestAnimationFrame(() => {moved = false;});}
    before = undefined;
  };
  const scrolled = () => {
    if (!moved) return;
    moved = false;
    const height = core?.viewport?._currentRowHeight;
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || !viewport.offsetParent) return;
    const line = Math.round(viewport.scrollTop / height);
    if (line !== terminal.buffer.active.viewportY) terminal.scrollToLine(line);
  };
  const gestures = ['wheel', 'touchmove'];
  gestures.forEach(name => {element.addEventListener(name, gesture, true); element.addEventListener(name, settled);});
  // Registered after xterm's own listener, so it sees the scroll xterm settled.
  viewport.addEventListener('scroll', scrolled);
  return () => {
    gestures.forEach(name => {element.removeEventListener(name, gesture, true); element.removeEventListener(name, settled);});
    viewport.removeEventListener('scroll', scrolled);
  };
}

/** xterm 5.5 fires this private event synchronously before user-originated onData.
 * This marker is read-only; the IME adapter below is separately version-pinned.
 */
export function observeTerminalInput(terminal: Terminal, listener: (data: string, userInput: boolean) => void, acceptsInput: () => boolean = () => true, onUnappliedEdit: (edit: UnappliedTerminalEdit | null) => void = () => {}) {
  const completionArea = terminal.textarea && /Android/i.test(navigator.userAgent) ? terminal.textarea : undefined;
  const previousAutocomplete = completionArea?.getAttribute('autocomplete');
  completionArea?.setAttribute('autocomplete', 'off');
  const core = (terminal as unknown as {_core?: {coreService?: {onUserInput?: (listener: () => void) => {dispose(): void}}}})._core?.coreService;
  let userInput = false;
  let marker: {dispose(): void} | undefined;
  try {if (typeof core?.onUserInput === "function") marker = core.onUserInput(() => {userInput = true;});}
  catch { /* Unknown internals disable only virtual modifiers. */ }
  const available = !!marker && typeof marker.dispose === "function";
  const ime = available ? observeTerminalIme(terminal, () => userInput, acceptsInput, onUnappliedEdit) : undefined;
  const output = terminal.onData(data => {const user = userInput; userInput = false; listener(data, available && user);});
  return {available, get idle() {return ime?.idle === true;}, reset: () => ime?.reset(), clear: () => ime?.clear(), resume: () => ime?.resume(), flush: () => ime?.flush(), settle: () => ime?.settle(), dismiss: () => ime?.dismiss(), composing: () => ime?.composing(), dispose() {
    ime?.dispose(); output.dispose(); if (available) marker!.dispose();
    if (completionArea) {
      if (previousAutocomplete == null) completionArea.removeAttribute('autocomplete');
      else completionArea.setAttribute('autocomplete', previousAutocomplete);
    }
  }};
}

export function modifiedTerminalText(data: string, ctrl: boolean, alt: boolean): string {
  // Haven-compatible IME semantics: Ctrl maps a single ASCII character only.
  const value = ctrl && /^[\x40-\x7f]$/.test(data) ? String.fromCharCode(data.charCodeAt(0) & 31) : data;
  return alt ? `\x1b${value}` : value;
}
