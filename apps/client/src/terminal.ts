import { Terminal } from "@xterm/xterm";
import { getPreferences, terminalOptions } from "./preferences";

export function createTerminal() {
  return new Terminal({
    ...terminalOptions(getPreferences()),
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
  message?: string;
  attached?: {kind: 'tmux' | 'herdr' | 'zellij'; name: string};
};
