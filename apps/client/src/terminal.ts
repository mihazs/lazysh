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
