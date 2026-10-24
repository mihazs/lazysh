import { Terminal } from "@xterm/xterm";

export function createTerminal() {
  return new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 5000,
    fontSize: 14,
    lineHeight: 1.3,
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    allowProposedApi: false,
    theme: {
      background: "#101311",
      foreground: "#d9e0d6",
      cursor: "#c4eb89",
      selectionBackground: "#40543a",
      black: "#1d231f",
      red: "#f48781",
      green: "#b9df83",
      yellow: "#e4ce8b",
      blue: "#8caee4",
      magenta: "#c4a1dd",
      cyan: "#8ccfc1",
      white: "#d9e0d6",
      brightBlack: "#788478",
      brightRed: "#ffb0a6",
      brightGreen: "#d0f0a6",
      brightYellow: "#f3e0ac",
      brightBlue: "#b1caf0",
      brightMagenta: "#dfc3ef",
      brightCyan: "#b0e8de",
      brightWhite: "#f3f5ee",
    },
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
};
