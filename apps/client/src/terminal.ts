export type LiveSession = {
  id: string;
  hostId: string;
  name: string;
  destination: string;
  /** The session's terminal state; the pane and every other consumer reach the terminal only through it. */
  adapter: import('./terminalAdapter').TerminalAdapter;
  connected: boolean;
  disposed?: true;
  local?: true;
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
