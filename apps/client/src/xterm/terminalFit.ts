import {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';

/** xterm.js assumes a 15 px scrollbar whenever its viewport's scrollbar takes no
 * width (Android and iOS overlay scrollbars) and its fit also ignores the
 * container's padding. Both are measured here instead, so the terminal spans
 * the whole pane. */
export class TerminalFitAddon extends FitAddon {
  private host: Terminal | undefined;

  override activate(terminal: Terminal) {
    this.host = terminal;
    super.activate(terminal);
  }

  override proposeDimensions() {
    const proposed = super.proposeDimensions();
    const terminal = this.host, element = terminal?.element, parent = element?.parentElement;
    const viewport = element?.querySelector<HTMLElement>('.xterm-viewport');
    const cell = (terminal as unknown as {_core?: {_renderService?: {dimensions?: {css?: {cell?: {width?: number}}}}}} | undefined)
      ?._core?._renderService?.dimensions?.css?.cell?.width;
    if (!proposed || !terminal || !parent || !viewport || !cell || cell <= 0) return proposed;
    const style = getComputedStyle(parent);
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    // Zero for an overlay scrollbar; a classic one narrows the viewport.
    const scrollbar = terminal.options.scrollback === 0 ? 0 : viewport.offsetWidth - viewport.clientWidth;
    const width = parent.clientWidth - padding - scrollbar;
    return Number.isFinite(width) ? {...proposed, cols: Math.max(2, Math.floor(width / cell))} : proposed;
  }
}
