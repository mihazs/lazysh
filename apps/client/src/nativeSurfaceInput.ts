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

export class SurfaceInput implements Disposable {
  readonly element = undefined;
  private readonly mounted: ReturnType<typeof mountPreedit>;
  private readonly preedit: HTMLElement;
  private stopped = false;
  private wantsFocus = false;

  constructor(
    private readonly adapter: NativeTerminalAdapter, private readonly session: string, private readonly anchor: HTMLElement,
    private readonly preferences: () => TerminalPreferences | undefined, private readonly api = nativeSurface,
  ) {
    this.mounted = mountPreedit(anchor); this.preedit = this.mounted.preedit;
    document.addEventListener('focusin', this.pageField);
    void this.pump();
  }

  /**
   * A field of the page took the keyboard (the composer, a dialog, the search box): the editor lets go of Android's view focus, or the keyboard
   * would keep typing into the terminal while the page's own field shows the cursor. The keyboard stays open for the field.
   */
  private readonly pageField = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || this.anchor.contains(target) || !target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    this.wantsFocus = false;
    this.api.focus(this.session, false, false).catch(noop);
  };

  focus() { this.wantsFocus = true; this.api.focus(this.session, true).catch(noop); }
  blur() { this.wantsFocus = false; this.api.focus(this.session, false).catch(noop); }

  dispose() {
    this.stopped = true;
    document.removeEventListener('focusin', this.pageField);
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
        if (!this.stopped) for (const event of events) this.apply(event);
      } catch {
        placed = false;
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private apply(event: Awaited<ReturnType<typeof nativeSurface.takeInput>>['events'][number]) {
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
