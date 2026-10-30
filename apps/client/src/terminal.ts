import { Terminal } from "@xterm/xterm";
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
 * Subscribe read-only; unknown versions retain ordinary input without virtual modifiers.
 */
export function observeTerminalInput(terminal: Terminal, listener: (data: string, userInput: boolean) => void) {
  const core = (terminal as unknown as {_core?: {coreService?: {onUserInput?: (listener: () => void) => {dispose(): void}}}})._core?.coreService;
  let userInput = false;
  let marker: {dispose(): void} | undefined;
  try {if (typeof core?.onUserInput === "function") marker = core.onUserInput(() => {userInput = true;});}
  catch { /* Unknown internals disable only virtual modifiers. */ }
  const available = !!marker && typeof marker.dispose === "function";
  const output = terminal.onData(data => {const user = userInput; userInput = false; listener(data, available && user);});
  return {available, dispose() {output.dispose(); if (available) marker!.dispose();}};
}

export function modifiedTerminalText(data: string, ctrl: boolean, alt: boolean): string {
  // Haven-compatible IME semantics: Ctrl maps a single ASCII character only.
  const value = ctrl && /^[\x40-\x7f]$/.test(data) ? String.fromCharCode(data.charCodeAt(0) & 31) : data;
  return alt ? `\x1b${value}` : value;
}
