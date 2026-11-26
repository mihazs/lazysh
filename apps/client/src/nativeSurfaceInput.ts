/**
 * Typed input of a native session on Android (#1328, #1791): the keyboard's editor is a native view with the `InputConnection`
 * (docs/architecture/android-native-input.md), so there is no DOM editor. The shell hands over what it delivered, in order and once;
 * this forwards it to the core through the adapter, which keeps the order, and draws the composing text at the cursor, as the
 * desktop editor does for xterm.js' composition. The core is the lease's: a locked app or a replaced renderer is refused there.
 */
import {mountPreedit} from './nativeInputCapture';
import type {NativeTerminalAdapter} from './nativeTerminalAdapter';
import type {Disposable, TerminalPreferences} from './terminalAdapter';
import {nativeSurface} from './terminalSurfaceAnchor';

/** Pause before asking again after the shell refused (no surface placed yet, app locked). */
export const RETRY_MS = 500;
const noop = () => {};
let nextTicket = 0;

type FocusCall = {focused: (element: HTMLElement) => void; blurred: (element: HTMLElement) => void};
const watchers = new Set<FocusCall>();
let originals: {focus: HTMLElement['focus']; blur: HTMLElement['blur']} | undefined;

/**
 * The page's own `focus()` and `blur()` calls, as they are made. A document that is not the focused one (Android's view focus is on the
 * keyboard editor) fires no focus events for them, so the composer, which the page focuses from script, would take no keyboard from the
 * terminal if only the events were listened to. The calls are passed on unchanged.
 */
function watchFocusCalls(watcher: FocusCall) {
  if (!originals) {
    const {focus, blur} = originals = {focus: HTMLElement.prototype.focus, blur: HTMLElement.prototype.blur};
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement['focus']>) { focus.apply(this, args); watchers.forEach(w => w.focused(this)); };
    HTMLElement.prototype.blur = function (this: HTMLElement) { blur.apply(this); watchers.forEach(w => w.blurred(this)); };
  }
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (!watchers.size && originals) { HTMLElement.prototype.focus = originals.focus; HTMLElement.prototype.blur = originals.blur; originals = undefined; }
  };
}

export class SurfaceInput implements Disposable {
  readonly element = undefined;
  private readonly mounted: ReturnType<typeof mountPreedit>;
  private readonly preedit: HTMLElement;
  private stopped = false;
  private wantsFocus = false;
  private focusRequest = 0;
  private marking = Promise.resolve();
  private readonly pending = new Map<number, () => Promise<void>>();

  constructor(
    private readonly adapter: NativeTerminalAdapter, private readonly session: string, private readonly anchor: HTMLElement,
    private readonly preferences: () => TerminalPreferences | undefined, private readonly api = nativeSurface,
  ) {
    this.mounted = mountPreedit(anchor); this.preedit = this.mounted.preedit;
    document.addEventListener('focusin', this.pageField);
    document.addEventListener('focusout', this.pageLeft);
    this.unwatch = watchFocusCalls({focused: element => this.takePage(element), blurred: element => this.leavePage(element)});
    void this.pump();
  }

  /**
   * A field of the page took the keyboard (the composer, a dialog, the search box): the editor lets go of Android's view focus, or the keyboard
   * would keep typing into the terminal while the page's own field shows the cursor. The keyboard stays open for the field.
   */
  private unwatch: (() => void) | undefined;
  private pageTarget: EventTarget | null = null;
  /** The page's field let go of the keyboard: it is the terminal's again (the editor takes view focus back when the terminal asks). */
  /** The field the editor was just released for: while the page settles after the WebView took focus, its losing focus is the page restoring an older one, not the field being left. */
  private settling: EventTarget | null = null;
  private leavePage(target: EventTarget | null) { if (target === this.pageTarget && target !== this.settling) this.pageTarget = null; }
  private readonly pageLeft = (event: FocusEvent) => this.leavePage(event.target);

  private takePage(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || this.anchor.contains(target) || !target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (this.pageTarget === target) return;
    this.wantsFocus = false;
    this.pageTarget = target;
    // The WebView takes Android's focus and the page then restores the element it last focused (a toolbar button), over the field the script focused while the page was not: put the field back.
    this.settling = target;
    this.api.focus(this.session, false, false).catch(noop).then(() => {
      for (const delay of [0, 60, 200, 500]) setTimeout(() => { if (!this.stopped && this.settling === target && target.isConnected && document.activeElement !== target) target.focus(); }, delay);
      setTimeout(() => { if (this.settling === target) this.settling = null; }, 600);
    });
  }
  private readonly pageField = (event: FocusEvent) => this.takePage(event.target);

  focus() { this.focusRequest++; this.wantsFocus = true; this.api.focus(this.session, true).catch(noop); }
  blur() { this.wantsFocus = false; this.api.focus(this.session, false).catch(noop); }

  dismissKeyboardIfIdle() {
    const request = this.focusRequest;
    void this.api.focus(this.session, false, true, true).then(() => {
      if (request === this.focusRequest) this.wantsFocus = false;
    }, noop);
  }

  afterInput(action: () => Promise<void>) {
    if (this.pending.size >= 64) throw new Error('Terminal input queue is full');
    const ticket = nextTicket = nextTicket % 0x7fffffff + 1;
    this.pending.set(ticket, action);
    this.marking = this.marking.then(async () => {
      if (this.pending.has(ticket)) await this.api.markInput(this.session, ticket);
    }).catch(() => { this.pending.delete(ticket); });
  }

  dispose() {
    this.stopped = true;
    this.pending.clear();
    document.removeEventListener('focusin', this.pageField);
    document.removeEventListener('focusout', this.pageLeft);
    this.unwatch?.();
    this.mounted.restore();
  }

  private async pump() {
    let placed = false;
    while (!this.stopped) {
      try {
        const {events} = await this.api.takeInput(this.session);
        // A surface that appeared after the page asked for the keyboard gets it now.
        if (!placed && this.wantsFocus) this.api.focus(this.session, true).catch(noop);
        placed = true;
        for (const event of events) {
          if (this.stopped) break;
          if (event.type === 'barrier') {
            const action = this.pending.get(event.ticket);
            this.pending.delete(event.ticket);
            if (action) await action().catch(noop);
          } else this.apply(event);
        }
      } catch {
        this.pending.clear();
        placed = false;
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private apply(event: Exclude<Awaited<ReturnType<typeof nativeSurface.takeInput>>['events'][number], {type: 'barrier'}>) {
    if (event.type === 'text') this.adapter.sendInput(event.text, 'ime');
    else if (event.type === 'paste') this.adapter.paste(event.text);
    else if (event.type === 'key') this.adapter.sendKey(event);
    else this.show(event.text);
  }

  /** On the cursor's cell in the container's coordinates, in the terminal's own font and colours. */
  private show(text: string | null) {
    const {preedit} = this;
    preedit.textContent = text ?? '';
    preedit.hidden = !text;
    if (!text) return;
    const {x, y} = this.adapter.cursor(), {cellWidth, cellHeight} = this.adapter.metrics(), preferences = this.preferences();
    Object.assign(preedit.style, {
      left: `${x * cellWidth}px`, top: `${y * cellHeight}px`, height: `${Math.max(1, cellHeight)}px`, lineHeight: `${Math.max(1, cellHeight)}px`,
      fontFamily: preferences?.fontFamily ?? '', fontSize: preferences ? `${preferences.fontSize}px` : '',
      color: preferences?.theme.foreground ?? '', background: preferences?.theme.background ?? '',
    });
  }
}
