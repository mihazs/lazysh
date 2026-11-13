import {createTerminal} from '../../src/xterm/terminal';
import {XtermTerminalAdapter} from '../../src/xtermTerminalAdapter';

/** An xterm terminal and the adapter a LiveSession carries for it, as the app builds them. */
export function createXtermFixture() {
  const terminal=createTerminal();
  return {terminal,adapter:new XtermTerminalAdapter(terminal)};
}
