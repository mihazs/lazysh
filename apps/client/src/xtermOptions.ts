import type {ITerminalOptions} from '@xterm/xterm';
import type {TerminalPreferences} from './terminalAdapter';

/** The xterm.js options for backend-neutral preferences. `boldColor` is applied separately (terminalBold.ts). */
export function xtermOptions(p: TerminalPreferences): ITerminalOptions {
  return {fontSize: p.fontSize, fontFamily: p.fontFamily, cursorStyle: p.cursorStyle, cursorBlink: p.cursorBlink, scrollback: p.scrollbackLines, macOptionIsMeta: p.optionAsMeta, screenReaderMode: p.screenReader, drawBoldTextInBrightColors: p.brightBold, theme: p.theme};
}
