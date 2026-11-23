export type LiveSession = {
  id: string;
  hostId: string;
  name: string;
  destination: string;
  /** The session's terminal state; the pane and every other consumer reach the terminal only through it. */
  adapter: import('./terminalAdapter').TerminalAdapter;
  /** Which engine this session got and why (preference, developer override, fallback and its reasons), fixed when the session was created. */
  selection: import('./terminalBackendRegistry').BackendSelection;
  /**
   * On a session running on the native engine: moves it to xterm.js with its screen, once. `failure` is what broke when it did, recorded so
   * that Auto stays on xterm.js on this device; without it the user chose to leave. Resolves to whether the screen was carried over.
   */
  leaveNative?: (failure?: unknown) => Promise<boolean>;
  connected: boolean;
  disposed?: true;
  local?: true;
  /** The local target a local session runs in; absent or `default` is the login shell. */
  target?: string;
  moshResize?: import('./terminalAdapter').CanonicalResize;
  mosh?: {serverPath: string; portMin: number; portMax: number};
  et?: {serverPath: string; port: number};
  auto?: import('./bridge').AutoOptions;
  transportNotice?: string;
  message?: string;
  /** The transport dropped without the remote ending the session; reconnecting may resume it. */
  lost?: true;
  attached?: import('./workspace').SessionAttachment;
};

export function modifiedTerminalText(data: string, ctrl: boolean, alt: boolean): string {
  // Haven-compatible IME semantics: Ctrl maps a single ASCII character only.
  const value = ctrl && /^[\x40-\x7f]$/.test(data) ? String.fromCharCode(data.charCodeAt(0) & 31) : data;
  return alt ? `\x1b${value}` : value;
}
