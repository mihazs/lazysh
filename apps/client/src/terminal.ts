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
  mosh?: {serverPath: string; portMin: number; portMax: number};
  et?: {serverPath: string; port: number};
  auto?: import('./bridge').AutoOptions;
  transportNotice?: string;
  message?: string;
  attached?: import('./workspace').SessionAttachment;
};

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
  const output = terminal.onData(data => {const user = userInput; userInput = false; if (!(available && user && ime?.blocked)) listener(data, available && user);});
  return {available, get idle() {return ime?.idle === true;}, reset: () => ime?.reset(), clear: () => ime?.clear(), resume: () => ime?.resume(), flush: () => ime?.flush() ?? true, dismiss: () => ime?.dismiss(), dispose() {
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
