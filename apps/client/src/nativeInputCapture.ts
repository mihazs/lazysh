/**
 * The typed-input editor of a native session on desktop and iOS (#1334): a hidden textarea inside the terminal's container that
 * holds focus and takes what the user types, because a native surface has no DOM of its own to type into. Keys go to the core as
 * DOM-shaped key inputs, after the platform rules of `terminalPlatformKeys.ts`; the core encodes them, as it is held to what
 * xterm.js sends. Text an input method committed goes as text, once. A paste goes through the adapter, which brackets it.
 * Android has a native input connection of its own instead (docs/architecture/android-native-input.md).
 */
import type {NativeTerminalAdapter} from './nativeTerminalAdapter';
import type {Disposable, TerminalPreferences} from './terminalAdapter';
import {coreKeyInput, keyboardPlatform, type CoreKeyInput} from './terminalPlatformKeys';

/** Keys that name no character and no action: a modifier pressed alone, and the keys of a composition (the commit arrives as text). */
const silentKeys = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'Super', 'Hyper', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Dead', 'Process', 'Unidentified']);
const typesCharacter = (key: string) => [...key].length === 1;

export type NativeInputOptions = {
  /** The pane's key interceptor: false keeps the event from the terminal. */
  intercepts(event: KeyboardEvent): boolean;
  preferences(): TerminalPreferences | undefined;
};

/** The overlay for the text an input method is composing, inside the container; `restore` removes it and the positioning it needed. */
export function mountPreedit(anchor: HTMLElement) {
  const preedit = document.createElement('div');
  preedit.setAttribute('data-terminal-preedit', '');
  preedit.setAttribute('aria-hidden', 'true');
  preedit.hidden = true;
  Object.assign(preedit.style, {position: 'absolute', whiteSpace: 'pre', pointerEvents: 'none', textDecoration: 'underline', zIndex: '1'});
  const positioned = getComputedStyle(anchor).position === 'static';
  if (positioned) anchor.style.position = 'relative';
  anchor.append(preedit);
  return {preedit, restore() { preedit.remove(); if (positioned) anchor.style.position = ''; }};
}

export class NativeInputCapture implements Disposable {
  readonly element = document.createElement('textarea');
  private readonly mounted: ReturnType<typeof mountPreedit>;
  private readonly preedit: HTMLElement;
  private readonly pressed = new Map<string, CoreKeyInput>();
  private readonly cursor: Disposable;
  private composing = false;
  private settling: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly adapter: NativeTerminalAdapter, private readonly anchor: HTMLElement, private readonly options: NativeInputOptions) {
    this.mounted = mountPreedit(anchor); this.preedit = this.mounted.preedit;
    const {element} = this;
    element.setAttribute('data-terminal-editor', '');
    element.setAttribute('aria-label', 'Terminal input');
    for (const [name, value] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['rows', '1']]) element.setAttribute(name, value);
    // Invisible but laid out at the cursor, where an input method puts its candidate window; 16px stops iOS from zooming on focus.
    Object.assign(element.style, {position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', margin: '0', padding: '0', border: '0', opacity: '0', resize: 'none', overflow: 'hidden', pointerEvents: 'none', zIndex: '-1', fontSize: '16px'});
    anchor.append(element);
    for (const [name, listener] of this.listeners) element.addEventListener(name, listener as EventListener);
    anchor.addEventListener('pointerup', this.pointerup);
    anchor.addEventListener('mousedown', this.mouseDown);
    this.cursor = adapter.subscribe(() => { if (this.composing) this.place(); }, ['output', 'viewport', 'geometry']);
  }

  focus() { this.element.focus({preventScroll: true}); }
  blur() { this.element.blur(); }

  dispose() {
    clearTimeout(this.settling);
    this.cursor.dispose();
    this.anchor.removeEventListener('pointerup', this.pointerup);
    this.anchor.removeEventListener('mousedown', this.mouseDown);
    this.element.remove(); this.mounted.restore();
  }

  private key(event: KeyboardEvent) { return coreKeyInput(event, keyboardPlatform(), !!this.options.preferences()?.optionAsMeta); }

  private readonly keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || this.options.intercepts(event)) return;
    // A composition owns its keys; its commit arrives as text, once.
    if (event.isComposing || event.keyCode === 229 || silentKeys.has(event.key)) return;
    if (event.shiftKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
      // xterm.js scrolls its history on these and sends nothing; the core would encode them (divergence shift-pageup-handled-by-host).
      event.preventDefault();
      this.adapter.scroll({kind: 'pages', delta: event.key === 'PageUp' ? -1 : 1});
      return;
    }
    // Left to the browser, as xterm.js leaves them: Shift+Insert pastes, Ctrl+Insert copies, and a letter with Cmd is the app's (copy, paste, search).
    if ((event.key === 'Insert' && (event.shiftKey || event.ctrlKey)) || (event.metaKey && typesCharacter(event.key))) return;
    event.preventDefault();
    const input = this.key(event);
    this.pressed.set(event.code, input);
    this.adapter.sendKey(input);
  };

  /** A release goes only to a key whose press went, so the key that ends a composition does not send a release alone. */
  private readonly keyup = (event: KeyboardEvent) => {
    const intercepted = this.options.intercepts(event), pressed = this.pressed.delete(event.code);
    if (pressed && !intercepted) this.adapter.sendKey(this.key(event));
  };

  private readonly compositionstart = () => { this.flush(); this.composing = true; this.place(); };
  private readonly compositionupdate = (event: CompositionEvent) => { this.preedit.textContent = event.data; this.preedit.hidden = !event.data; this.place(); };
  /**
   * WebKit fires the last `input` after `compositionend` and Chromium before it, so the text is read once the events settled:
   * the editor holds only what has not gone yet, and it is emptied as it is sent, so no order can send it twice.
   */
  private readonly compositionend = () => {
    if (!this.composing) {
      // A canceled editor can receive the old completion after focus has already returned.
      if (this.settling === undefined) this.element.value = '';
      return;
    }
    this.composing = false; this.preedit.hidden = true; this.preedit.textContent = '';
    this.settling = setTimeout(this.flush);
  };
  private readonly input = (event: InputEvent) => {
    if (this.composing) return;
    if (this.settling === undefined && (event.isComposing || event.inputType === 'insertCompositionText' || event.inputType === 'insertFromComposition')) {
      this.element.value = '';
      return;
    }
    if (!event.isComposing) this.flush();
  };

  private readonly flush = () => {
    clearTimeout(this.settling);
    this.settling = undefined;
    if (this.composing) return;
    // Text that settles after focus left is dropped, as the xterm.js editor drops it.
    const text = document.activeElement === this.element ? this.element.value.replace(/\r?\n/g, '\r') : '';
    this.element.value = '';
    if (text) this.adapter.sendInput(text, 'ime');
  };

  private readonly paste = (event: ClipboardEvent) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text && !this.composing) this.adapter.paste(text);
  };

  /** A composition that loses focus is dropped, and the keys still held are released, so no program waits for one that cannot come. */
  private readonly lostFocus = () => {
    clearTimeout(this.settling);
    this.settling = undefined;
    this.composing = false; this.preedit.hidden = true; this.preedit.textContent = ''; this.element.value = '';
    for (const input of this.pressed.values()) this.adapter.sendKey({...input, release: true, repeat: false});
    this.pressed.clear();
  };

  /** A mouse click gives the terminal focus; a finger's tap is the pane's gesture (it may open the soft keyboard). */
  // The compatibility mouse event after a touch would blur the editor that the tap just focused.
  private readonly mouseDown = (event: MouseEvent) => {
    if (document.activeElement === this.element) event.preventDefault();
  };

  private readonly pointerup = (event: PointerEvent) => { if (event.pointerType === 'mouse' && event.button === 0) this.focus(); };

  private readonly listeners = [
    ['keydown', this.keydown], ['keyup', this.keyup], ['compositionstart', this.compositionstart], ['compositionupdate', this.compositionupdate],
    ['compositionend', this.compositionend], ['input', this.input], ['paste', this.paste], ['blur', this.lostFocus], ['focus', () => this.place()],
  ] as const;

  /** The editor and the preedit sit on the cursor's cell, in the container's coordinates. */
  private place() {
    const {x, y} = this.adapter.cursor(), {cellWidth, cellHeight} = this.adapter.metrics(), preferences = this.options.preferences();
    const left = `${x * cellWidth}px`, top = `${y * cellHeight}px`, height = `${Math.max(1, cellHeight)}px`;
    Object.assign(this.element.style, {left, top, height});
    Object.assign(this.preedit.style, {
      left, top, height, lineHeight: height, fontFamily: preferences?.fontFamily ?? '', fontSize: preferences ? `${preferences.fontSize}px` : '',
      color: preferences?.theme.foreground ?? '', background: preferences?.theme.background ?? '',
    });
  }
}
